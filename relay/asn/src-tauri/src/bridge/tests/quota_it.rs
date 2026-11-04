//! 收發室 worker 的 Claude 額度用完（todo-next-173）：扣住不 ack、通知、每小時試送最舊的一封，恢復後依序重送。
//! 時間都從 TQ 起算（避開別的測試對 login_watch 逾時記錄的寫入），不用真的等待。
use super::*;
use super::rooms_launch::{room, rmsg, set_rooms};
use std::sync::atomic::{AtomicU64, Ordering};
use crate::bridge::mail::{quota_late_line, taipei_hm};

const TQ: u64 = T0 + 400 * 86_400_000;
const HOUR: u64 = 3_600_000;
/// 額度三小時後重置
const RESETS_S: u64 = TQ / 1000 + 3 * 3600;
/// 實際重送時間（重置時間加緩衝一分鐘）
const UNTIL: u64 = RESETS_S * 1000 + 60_000;

fn quota_line(resets: u64) -> WorkerLine {
    WorkerLine::Line(json!({"type":"assistant","message":{"model":"<synthetic>","content":[{"type":"text","text":"You've hit your weekly limit"}]},"apiError":"usage_limit_reached","apiErrorParams":{"rate_limit_info":{"status":"rejected","resetsAt":resets,"rateLimitType":"seven_day"}}}).to_string())
}

fn bodies(h: &H) -> Vec<String> {
    h.fr.sent().iter().map(|s| s["body"].as_str().unwrap_or("").to_string()).collect()
}
fn notices_to(h: &H, node: &str, agent: &str) -> usize {
    h.fr.sent().iter().filter(|s| s["to_node"] == node && s["to_agent"] == agent && s["body"].as_str().unwrap_or("").contains("額度用完")).count()
}
fn owner_notices(h: &H) -> usize {
    let w = h.core.relay.window_name();
    notices_to(h, "T", &w)
}
fn held_ids(h: &H) -> Vec<String> {
    h.core.pending.iter().filter(|p| p.state == State::Held).map(|p| p.id.clone()).collect()
}

#[tokio::test]
async fn 額度用完_轉交中的信扣住_不寄逾時_不_ack_不記轉交逾時() {
    let mut h = harness(&[("T-乙", "idle")]).await;
    h.fr.put(mail(1, json!({})));
    h.core.pull("test", TQ).await;
    assert_eq!(h.said().len(), 1);
    h.core.on_worker_line(quota_line(RESETS_S), TQ + 1000).await;
    assert_eq!(held_ids(&h), vec![uid(1)]);
    // 過了轉交逾時很久也一樣：沒有逾時通知、沒有 ack、沒有記成轉交逾時
    h.core.tick(TQ + 500_000).await;
    h.core.tick(TQ + HOUR).await;
    assert!(bodies(&h).iter().all(|b| !b.contains("逾時")), "{:?}", bodies(&h));
    assert!(h.fr.acked().is_empty());
    assert_eq!(held_ids(&h), vec![uid(1)]);
    assert_eq!(crate::login_watch::forward_timeouts_since(TQ as i64 - 1), 0);
    assert_eq!(h.said().len(), 1, "重置前不再送 worker");
}

#[tokio::test]
async fn 通知_同寄件人一次_主人一次_收發室寄的與系統通知不回() {
    let mut h = harness(&[("T-乙", "idle")]).await;
    h.fr.put(mail(1, json!({})));
    h.core.pull("test", TQ).await;
    h.core.on_worker_line(quota_line(RESETS_S), TQ + 1000).await;
    // 額度期間再來：同一寄件人兩封、另一個寄件人一封、收發室寄的、[收發室] 開頭的系統通知
    h.fr.put(mail(2, json!({})));
    h.fr.put(mail(3, json!({})));
    h.fr.put(mail(4, json!({"from_agent": "W-別人"})));
    h.fr.put(mail(5, json!({"from_agent": "W-收發室"})));
    h.fr.put(mail(6, json!({"from_agent": "W-乙乙", "body": "[收發室] 轉交給 X 逾時"})));
    h.core.pull("test", TQ + 2000).await;
    assert_eq!(h.said().len(), 1, "額度期間新進的信不送 worker");
    assert_eq!(held_ids(&h).len(), 6);
    assert!(h.fr.acked().is_empty());
    assert_eq!(notices_to(&h, "W", "W-政策"), 1, "同寄件人同一次只通知一次");
    assert_eq!(notices_to(&h, "W", "W-別人"), 1);
    assert_eq!(notices_to(&h, "W", "W-收發室"), 0, "收發室寄來的不回通知");
    assert_eq!(notices_to(&h, "W", "W-乙乙"), 0, "收發室寫的系統通知不回通知");
    assert_eq!(owner_notices(&h), 0, "主人通知改由後台寄（名單回報帶暫停時間），不寄到本機視窗");
    // 通知內容：設備名、台北時間、reply=no
    let n = h.fr.sent().into_iter().find(|s| s["to_agent"] == "W-政策").unwrap();
    assert_eq!(n["body"].as_str().unwrap(), format!("[收發室] 這台的收發室 Claude 額度用完，約 {}（台北）重置；信已收到，重置後自動轉交。", taipei_hm(UNTIL)));
    assert_eq!(n["expects_reply"], json!(false));
    // 再來一次 quota 事件（同一次額度用完）：不重複通知
    h.core.on_worker_line(quota_line(RESETS_S), TQ + 3000).await;
    assert_eq!(notices_to(&h, "W", "W-政策"), 1);
    assert_eq!(owner_notices(&h), 0);
}

#[tokio::test]
async fn 恢復後依原收到順序重送_試送成功就解除_重置時間還沒到也一樣_帶延遲抬頭_逾時重新計時() {
    // 這個測試會真的讓轉交逾時並被記一筆；用較早的時間區段，免得別的測試「沒有被記到逾時」的檢查被它污染
    const TQ: u64 = T0 + 200 * 86_400_000;
    const RESETS_S: u64 = TQ / 1000 + 3 * 3600;
    let probe = TQ + 1000 + HOUR; // 扣住後每小時試送一次，第一次在一小時後（重置時間是三小時後）
    let mut h = harness(&[("T-乙", "idle")]).await;
    h.fr.put(mail(1, json!({})));
    h.core.pull("test", TQ).await;
    h.core.on_worker_line(quota_line(RESETS_S), TQ + 1000).await;
    h.fr.put(mail(2, json!({})));
    h.core.pull("test", TQ + 600_000).await;
    h.fr.put(mail(3, json!({"body": "這封因額度用完延遲，原本 03:33 收到\n真內文"})));
    h.core.pull("test", TQ + 900_000).await;
    h.core.tick(probe - 1).await;
    assert_eq!(h.said().len(), 1, "還沒到試送時間");
    // 試送：只送最舊的一封，其餘繼續扣住
    h.core.tick(probe).await;
    assert_eq!(h.said().len(), 2, "只試送一封");
    assert_eq!(held_ids(&h).len(), 2);
    h.core.tick(probe + 5000).await;
    assert_eq!(h.said().len(), 2, "試送結果出來前不再送");
    // 試送成功（worker 回報 SENT）＝額度其實恢復了：重置時間還沒到也立刻解除，下一個 tick 依原收到順序重送其餘的
    worker_ok(&mut h.core, &uid(1), probe + 6000).await;
    assert_eq!(h.core.inbox_hold_until(), None);
    h.core.tick(probe + 10_000).await;
    let said = h.said();
    assert_eq!(said.len(), 4, "原本那封＋試送那封＋後兩封重送");
    let f: Vec<(String, String)> = said[1..].iter().map(|t| (t.split("id=").nth(1).unwrap().split(' ').next().unwrap().to_string(), t.clone())).collect();
    assert_eq!(f.iter().map(|x| x.0.clone()).collect::<Vec<_>>(), vec![uid(1), uid(2), uid(3)], "依原收到順序");
    for (i, (_, t)) in f.iter().enumerate() {
        let recv = [TQ, TQ + 600_000, TQ + 900_000][i];
        let lines: Vec<&str> = t.lines().collect();
        assert!(lines[2].starts_with("[RELAY 來信]"), "{}", lines[2]);
        assert!(lines[3].starts_with("寄件人："), "{}", lines[3]);
        assert_eq!(lines[4], quota_late_line(recv), "延遲抬頭在「寄件人：」那行之後");
        assert!(lines[4].contains(&taipei_hm(recv)));
    }
    // 信件內文裡手打的同樣字樣會被加「（內文）」
    assert!(f[2].1.contains("\n（內文）這封因額度用完延遲，原本 03:33 收到\n真內文"), "{}", f[2].1);
    // 轉交逾時從重送重新計時：重送後 119 秒內不逾時，之後才逾時
    h.core.tick(probe + 10_000 + 119_000).await;
    assert!(bodies(&h).iter().all(|b| !b.contains("逾時")));
    h.core.tick(probe + 10_000 + 121_000).await;
    assert!(bodies(&h).iter().filter(|b| b.contains("逾時")).count() >= 1);
}

#[tokio::test]
async fn 語音通話的信_延遲抬頭放在語音說明之後() {
    let mut h = harness(&[("T-乙", "idle")]).await;
    h.fr.put(mail(1, json!({"voice": true})));
    h.core.pull("test", TQ).await;
    h.core.on_worker_line(quota_line(RESETS_S), TQ + 1000).await;
    h.core.tick(TQ + 1000 + HOUR).await;
    let t = h.said()[1].clone();
    let lines: Vec<&str> = t.lines().collect();
    assert!(lines[3].starts_with("寄件人：") && lines[3].contains("語音通話"), "{}", lines[3]);
    assert_eq!(lines[4], quota_late_line(TQ));
}

#[tokio::test]
async fn worker_回報_fail_也代表在工作_解除扣住() {
    let mut h = harness(&[("T-乙", "idle")]).await;
    h.fr.put(mail(1, json!({})));
    h.fr.put(mail(2, json!({})));
    h.core.pull("test", TQ).await;
    h.core.on_worker_line(quota_line(RESETS_S), TQ + 1000).await;
    assert_eq!(held_ids(&h).len(), 2);
    h.core.tick(TQ + 1000 + HOUR).await;
    h.core.on_worker_line(res(&format!("FAIL {} 找不到視窗", uid(1))), TQ + 2000 + HOUR).await;
    assert_eq!(h.core.inbox_hold_until(), None);
    h.core.tick(TQ + 3000 + HOUR).await;
    assert_eq!(h.said().len(), 4, "原本兩封＋試送一封＋重送一封");
}
#[tokio::test]
async fn 試送成功後_ack_並照常等回覆() {
    let mut h = harness(&[("T-乙", "idle")]).await;
    h.fr.put(mail(1, json!({})));
    h.core.pull("test", TQ).await;
    h.core.on_worker_line(quota_line(RESETS_S), TQ + 1000).await;
    h.core.tick(UNTIL).await;
    assert_eq!(h.said().len(), 2);
    assert!(h.fr.acked().is_empty());
    worker_ok(&mut h.core, &uid(1), UNTIL + 500).await;
    assert_eq!(h.fr.acked(), vec![uid(1)]);
    assert_eq!(h.core.pending[0].state, State::Waiting);
    // 恢復後再用完是新的一次：寄件人會再通知一次
    h.core.on_worker_line(quota_line((UNTIL / 1000) + 3 * 3600), UNTIL + 600).await;
    h.fr.put(mail(2, json!({})));
    h.core.pull("test", UNTIL + 700).await;
    assert_eq!(notices_to(&h, "W", "W-政策"), 2);
}
#[tokio::test]
async fn 試送又撞額度_繼續扣住_暫停時間只延長_不重複通知_延遲抬頭仍是原本收到的時間() {
    let mut h = harness(&[("T-乙", "idle")]).await;
    h.fr.put(mail(1, json!({})));
    h.core.pull("test", TQ).await;
    h.core.on_worker_line(quota_line(RESETS_S), TQ + 1000).await;
    let p1 = TQ + 1000 + HOUR;
    h.core.tick(p1).await;
    assert_eq!(h.said().len(), 2, "第一次試送");
    // 試送時 worker 又回額度用完（這次又給了新的時間）
    let next_s = p1 / 1000 + 2 * 3600;
    h.core.on_worker_line(quota_line(next_s), p1 + 2000).await;
    assert_eq!(held_ids(&h), vec![uid(1)]);
    assert!(h.fr.acked().is_empty());
    assert_eq!(notices_to(&h, "W", "W-政策"), 1, "不重複通知寄件人");
    assert_eq!(h.core.inbox_hold_until(), Some(next_s * 1000 + 60_000), "暫停時間延長");
    h.core.tick(p1 + 2000 + HOUR - 1).await;
    assert_eq!(h.said().len(), 2, "下一次試送前不送");
    h.core.tick(p1 + 2000 + HOUR).await;
    let said = h.said();
    assert_eq!(said.len(), 3);
    assert!(said[2].contains(&quota_late_line(TQ)), "仍寫最初收到的時間：{}", said[2]);
    assert_eq!(crate::login_watch::forward_timeouts_since(TQ as i64 - 1), 0);
}

#[tokio::test]
async fn 試送沒回應不是額度用完的證據_連續兩次沒回應就解除_走一般逾時並記轉交逾時() {
    // 這個測試會真的讓轉交逾時並被記一筆；用較早的時間區段，免得別的測試「沒有被記到逾時」的檢查被它污染
    const TQ: u64 = T0 + 150 * 86_400_000;
    const RESETS_S: u64 = TQ / 1000 + 3 * 3600;
    let mut h = harness(&[("T-乙", "idle")]).await;
    h.fr.put(mail(1, json!({})));
    h.core.pull("test", TQ).await;
    h.core.on_worker_line(quota_line(RESETS_S), TQ + 1000).await;
    let until = h.core.inbox_hold_until();
    // 第一次試送（還沒到暫停時間）：沒回應 → 這封回到扣住，不寄逾時、不 ack、不記轉交逾時，暫停時間不延長
    let p1 = TQ + 1000 + HOUR;
    h.core.tick(p1).await;
    assert_eq!(h.said().len(), 2);
    h.core.tick(p1 + 121_000).await;
    assert!(bodies(&h).iter().all(|b| !b.contains("逾時")), "{:?}", bodies(&h));
    assert!(h.fr.acked().is_empty());
    assert_eq!(held_ids(&h), vec![uid(1)], "第一次沒回應：回到扣住");
    assert_eq!(h.core.inbox_hold_until(), until, "沒回應不延長暫停");
    assert_eq!(crate::login_watch::forward_timeouts_between(TQ as i64 - 1, TQ as i64 + 10 * HOUR as i64), 0);
    // 第二次試送（一小時後，仍沒到暫停時間）：連續第二次沒回應 → 解除，信走一般流程（轉交逾時通知、ack、記轉交逾時）
    let p2 = p1 + HOUR;
    h.core.tick(p2).await;
    assert_eq!(h.said().len(), 3, "一小時後再試一次");
    h.core.tick(p2 + 121_000).await;
    assert_eq!(h.core.inbox_hold_until(), None, "連續兩次沒回應：解除扣住（名單會報空值）");
    assert!(bodies(&h).iter().any(|b| b.contains("逾時")), "走一般逾時通知");
    assert_eq!(h.fr.acked(), vec![uid(1)]);
    assert!(crate::login_watch::forward_timeouts_between(TQ as i64 - 1, TQ as i64 + 10 * HOUR as i64) >= 1, "照舊記轉交逾時");
    assert!(held_ids(&h).is_empty());
    h.core.tick(p2 + 130_000).await;
    h.core.tick(p2 + 140_000).await;
    assert_eq!(*hold_posts(&h).last().unwrap(), Value::Null, "最後報空值");
}

#[tokio::test]
async fn 過了暫停時間才試送_第一次沒回應就解除() {
    const TQ: u64 = T0 + 151 * 86_400_000; // 逾時計數是全域的，各測試要用自己的時間區段
    let mut h = harness(&[("T-乙", "idle")]).await;
    h.fr.put(mail(1, json!({})));
    h.core.pull("test", TQ).await;
    // 時間不明：暫停一小時，第一次試送就在暫停時間到的時候
    h.core.on_worker_line(quota_line(TQ / 1000 - 10), TQ + 1000).await;
    let p1 = TQ + 1000 + HOUR;
    h.core.tick(p1).await;
    assert_eq!(h.said().len(), 2);
    h.core.tick(p1 + 121_000).await;
    assert_eq!(h.core.inbox_hold_until(), None, "已過暫停時間才試送：第一次沒回應就解除");
    assert!(bodies(&h).iter().any(|b| b.contains("逾時")));
    assert_eq!(h.fr.acked(), vec![uid(1)]);
}

#[tokio::test]
async fn 中間收到真的額度事件_沒回應的計數歸零() {
    const TQ: u64 = T0 + 152 * 86_400_000;
    const RESETS_S: u64 = TQ / 1000 + 6 * 3600;
    let mut h = harness(&[("T-乙", "idle")]).await;
    h.fr.put(mail(1, json!({})));
    h.core.pull("test", TQ).await;
    h.core.on_worker_line(quota_line(RESETS_S), TQ + 1000).await;
    let p1 = TQ + 1000 + HOUR;
    h.core.tick(p1).await;
    h.core.tick(p1 + 121_000).await; // 第一次沒回應
    let p2 = p1 + HOUR;
    h.core.tick(p2).await;
    h.core.on_worker_line(quota_line(RESETS_S), p2 + 2000).await; // 這次 worker 明確回報額度用完：計數歸零
    h.core.tick(p2 + 125_000).await;
    assert!(h.core.inbox_hold_until().is_some() && held_ids(&h) == vec![uid(1)]);
    let p3 = p2 + 2000 + HOUR;
    h.core.tick(p3).await;
    h.core.tick(p3 + 121_000).await; // 歸零後的第一次沒回應：仍扣住
    assert!(h.core.inbox_hold_until().is_some(), "計數已歸零，只算第一次沒回應");
    assert_eq!(held_ids(&h), vec![uid(1)]);
    assert!(h.fr.acked().is_empty());
}

#[tokio::test]
async fn 額度扣住期間_其他引擎視窗的群組排隊訊息到時間照常轉交_經過_worker_的不放() {
    let mut h = harness(&[("T-視窗甲", "idle")]).await;
    // 另一種引擎的視窗（不經收發室 worker）；沒載入引擎，轉交會失敗，但能證明這則有被放行處理
    let mut g = h.core.roster[0].clone();
    g.name = "T-G".into();
    g.engine = "gemini".into();
    h.core.roster.push(g);
    h.core.on_worker_line(quota_line(RESETS_S), TQ).await;
    let rank2 = |seq: u64, who: &str| rmsg(seq, json!({"forMe": {who: true}, "wake": {"rank": 2, "total": 2, "before": ["別人"]}}));
    set_rooms(&h, vec![room(vec![rank2(2, "T-G"), rank2(3, "T-視窗甲")], json!([{"member": "T~T-G", "read_seq": 1}, {"member": "T~T-視窗甲", "read_seq": 1}]))]);
    h.core.pull_rooms(TQ + 2000).await;
    assert!(h.said().is_empty());
    // 順位延遲 60 秒後到時間：Gemini 視窗那則照常轉交（這裡因為沒載入引擎而失敗，但有被處理）；經過 worker 的那則仍扣住
    h.core.tick(TQ + 2000 + 61_000).await;
    assert!(h.core.log.has("cannot hand room=R1 #2"), "非 worker 引擎的排隊訊息到時間照常轉交");
    assert!(!h.core.log.has("cannot hand room=R1 #3"));
    assert!(h.said().is_empty(), "經過 worker 的群組訊息不放");
}

#[tokio::test]
async fn 時間不明連撞三輪_暫停只會延長_不會中途報空值_最後恢復才報一次() {
    let mut h = harness(&[("T-乙", "idle")]).await;
    h.fr.put(mail(1, json!({})));
    h.core.pull("test", TQ).await;
    let unknown = |t: u64| quota_line(t / 1000 - 10); // 重置時間是過去＝不可信，當作不明
    let mut a = TQ + 1000;
    h.core.on_worker_line(unknown(a), a).await;
    h.core.tick(a + 2000).await;
    for _ in 0..3 {
        let p = a + HOUR; // 每小時試送一次
        h.core.tick(p).await;
        a = p + 2000;
        h.core.on_worker_line(unknown(a), a).await; // 試送又撞額度
        h.core.tick(a + 2000).await;
    }
    let posts = hold_posts(&h);
    assert_eq!(posts[0], Value::Null, "啟動的空值");
    let vals: Vec<u64> = posts[1..].iter().map(|v| v.as_u64().expect("扣住期間不能報空值")).collect();
    assert!(vals.len() >= 3 && vals.windows(2).all(|w| w[0] < w[1]), "只延長：{vals:?}");
    // 最後真的恢復（worker 回報 SENT）才報空值
    worker_ok(&mut h.core, &uid(1), a + 5000).await;
    h.core.tick(a + 10_000).await;
    let posts = hold_posts(&h);
    assert_eq!(posts.iter().filter(|v| v.is_null()).count(), 2, "只有啟動與最後恢復兩次空值：{posts:?}");
    assert_eq!(posts.last().unwrap(), &Value::Null);
    assert_eq!(notices_to(&h, "W", "W-政策"), 1, "整段只通知寄件人一次");
}
#[tokio::test]
async fn 假額度_時間不明或不可信_一小時後再試_信不丟不_ack() {
    let mut h = harness(&[("T-乙", "idle")]).await;
    h.fr.put(mail(1, json!({})));
    h.core.pull("test", TQ).await;
    // resetsAt 是過去的時間＝不可信，當作不明
    h.core.on_worker_line(quota_line(TQ / 1000 - 10), TQ + 1000).await;
    assert_eq!(held_ids(&h), vec![uid(1)]);
    h.core.tick(TQ + 1000 + HOUR - 1).await;
    assert_eq!(h.said().len(), 1);
    assert!(h.fr.acked().is_empty());
    h.core.tick(TQ + 1000 + HOUR).await;
    assert_eq!(h.said().len(), 2, "一小時後重送");
    assert!(h.said()[1].contains("id=00000000-0000-0000-0000-000000000001"));
    assert!(h.fr.acked().is_empty(), "重送也要等 SENT 才 ack");
    assert!(bodies(&h).iter().all(|b| !b.contains("逾時")));
    // 結果文字型的額度用完（時間不明）也一樣
    let mut g = harness(&[("T-乙", "idle")]).await;
    g.fr.put(mail(1, json!({})));
    g.core.pull("test", TQ).await;
    let err = WorkerLine::Line(json!({"type":"result","is_error":true,"result":"You've hit your session limit","duration_ms":1,"total_cost_usd":0}).to_string());
    g.core.on_worker_line(err, TQ + 1000).await;
    assert_eq!(held_ids(&g), vec![uid(1)]);
    g.core.tick(TQ + 130_000).await;
    assert!(g.fr.acked().is_empty());
    assert!(bodies(&g).iter().all(|b| !b.contains("逾時")));
    // 信件內文裡的同樣字樣（is_error=false 的回覆）不會觸發扣住
    let mut k = harness(&[("T-乙", "idle")]).await;
    k.fr.put(mail(1, json!({})));
    k.core.pull("test", TQ).await;
    k.core.on_worker_line(res("對方寫 You've hit your weekly limit"), TQ + 1000).await;
    assert!(held_ids(&k).is_empty());
}

#[tokio::test]
async fn 扣住有上限_超過的不收_不_ack_留在伺服器_旗標報給後台一次() {
    let mut h = harness(&[("T-乙", "idle")]).await;
    h.fr.put(mail(1, json!({})));
    h.core.pull("test", TQ).await;
    h.core.on_worker_line(quota_line(RESETS_S), TQ + 1000).await;
    for n in 2..=45 {
        h.fr.put(mail(n, json!({})));
    }
    h.core.pull("test", TQ + 2000).await;
    assert_eq!(held_ids(&h).len(), 40, "個人信上限 40（信箱一頁 50 封，留 10 封空位）");
    assert!(h.core.pending.iter().all(|p| p.id != uid(45)));
    assert!(h.fr.acked().is_empty());
    assert!(h.core.log.has("quota hold full"));
    assert_eq!(h.core.log.count("quota hold full"), 5, "每封只記一次 log（5 封超過）");
    // 超過上限的旗標由名單回報帶給後台（後台寄給主人），每次額度用完只帶一次；順便帶扣住筆數
    h.core.tick(TQ + 4000).await;
    let posts = hold_bodies(&h);
    assert_eq!(posts.len(), 2, "啟動的空值一次、暫停開始（含超過上限）一次：{posts:?}");
    assert_eq!((posts[1]["inbox_hold_count"].clone(), posts[1]["inbox_hold_capped"].clone()), (json!(40), json!(true)));
    // 再拉一次：超過的仍留在伺服器，不重複報
    h.core.pull("test", TQ + 3000).await;
    h.core.tick(TQ + 9000).await;
    assert_eq!(hold_bodies(&h).len(), 2);
    // 試送成功解除後處理掉扣住的，超過的下一次拉才收
    h.core.tick(TQ + 1000 + HOUR).await;
    worker_ok(&mut h.core, &uid(1), TQ + 2000 + HOUR).await;
    h.core.tick(TQ + 3000 + HOUR).await;
    assert_eq!(h.said().len(), 41, "原本 1 封＋試送 1 封＋重送 39 封");
    h.core.pull("test", TQ + 4000 + HOUR).await;
    assert!(h.core.pending.iter().any(|p| p.id == uid(45)));
}

#[tokio::test]
async fn 扣住的信占滿信箱一頁時_超過上限的視窗名被排除_其他引擎視窗的信照常處理() {
    let mut h = harness(&[("T-乙", "idle"), ("T-丙", "idle")]).await;
    {
        let mut s = h.fr.st.lock().unwrap();
        s.inbox_page = 50;
        s.honor_exclude = true;
    }
    // 另一種引擎的視窗（不經收發室 worker，額度用完不受影響）；沒載入引擎，轉交會失敗，但能證明這封沒被額度閘門扣住
    let mut g = h.core.roster[0].clone();
    g.name = "T-G".into();
    g.engine = "gemini".into();
    h.core.roster.push(g);
    h.fr.put(mail(1, json!({})));
    h.core.pull("test", TQ).await;
    h.core.on_worker_line(quota_line(RESETS_S), TQ + 1000).await;
    // T-乙 的信先排滿扣住上限（40 封）；T-丙 的信 55 封全部超過上限、不收，也不 ack，會一直留在信箱裡；最後一封是其他引擎視窗的
    for n in 2..=40 {
        h.fr.put(mail(n, json!({})));
    }
    for n in 41..=95 {
        h.fr.put(mail(n, json!({"to_agent": "T-丙"})));
    }
    h.fr.put(mail(96, json!({"to_agent": "T-G"})));
    h.core.pull("test", TQ + 2000).await;
    assert_eq!(held_ids(&h).len(), 40);
    // 第一頁（50 封）是 40 封扣住的加 10 封 T-丙 的；T-丙 要和 T-乙 一起被排除，下一輪才拉得到後面其他視窗的信
    assert!(h.core.log.has(&format!("cannot hand id={}", uid(96))), "第 96 封（其他引擎視窗）有被拉到、沒被額度閘門扣住");
    assert!(!held_ids(&h).contains(&uid(96)));
}
#[tokio::test]
async fn 扣住的信存檔_重啟後與重新拉到的同一封依_id_去重_內文不進檔案() {
    let mut h = harness(&[("T-乙", "idle")]).await;
    h.fr.put(mail(1, json!({"body": "機密內文不該進檔案"})));
    h.core.pull("test", TQ).await;
    h.core.on_worker_line(quota_line(RESETS_S), TQ + 1000).await;
    let text = std::fs::read_to_string(h.work.path().join("pending.json")).unwrap();
    assert!(text.contains(&uid(1)) && text.contains("\"held\"") && !text.contains("機密內文"), "{text}");
    // 重啟：新的核心載入扣住的信
    let sink2 = Arc::new(FakeSink::default());
    let mut c2 = new_core(&h.fr, h.work.path(), h.sessions.path(), sink2.clone(), TQ + 5000);
    assert_eq!(c2.pending.len(), 1);
    assert_eq!(c2.pending[0].state, State::Held);
    assert_eq!(c2.pending[0].t0, TQ, "收到時間保留");
    c2.refresh_roster(TQ + 5000).await;
    // 信沒 ack，所以伺服器又給一次：依 id 去重，不重複收、不重複送
    c2.pull("test", TQ + 6000).await;
    c2.pull("test", TQ + 7000).await;
    assert_eq!(c2.pending.len(), 1);
    assert!(sink2.said.lock().unwrap().is_empty(), "試送時間前不送");
    assert!(c2.inbox_hold_until().is_some(), "重啟後重置時間還在，繼續扣住");
    c2.tick(TQ + 5000 + HOUR).await; // 重啟後第一次試送
    // 補回內文後試送：抬頭寫原本收到的時間（從存檔的 t0）
    let said = sink2.said.lock().unwrap().clone();
    assert_eq!(said.len(), 1, "只送一次");
    assert_eq!(said[0].lines().nth(4).unwrap(), quota_late_line(TQ));
    assert!(said[0].contains("機密內文不該進檔案"));
    assert_eq!(c2.pending.len(), 1);
    assert!(h.fr.acked().is_empty());
}
#[tokio::test]
async fn 群組_額度期間扣住_只有群組訊息時也能試送_恢復後帶延遲抬頭轉交_轉交中的群組訊息撞額度也改扣住() {
    let mut h = harness(&[("T-視窗甲", "idle")]).await;
    let mine = json!([{"member": "T~T-視窗甲", "read_seq": 1}]);
    set_rooms(&h, vec![room(vec![rmsg(2, json!({"forMe": {"T-視窗甲": true}}))], mine.clone())]);
    h.core.pull_rooms(TQ).await;
    assert_eq!(h.said().len(), 1);
    // 已交給 worker、還沒確認時撞額度：排進扣住清單（存檔）
    h.core.on_worker_line(quota_line(RESETS_S), TQ + 1000).await;
    assert!(h.core.pending.is_empty());
    assert!(h.work.path().join("rooms-held.json").exists());
    // 額度期間新訊息：不即時通知、扣住
    set_rooms(&h, vec![room(vec![rmsg(2, json!({"forMe": {"T-視窗甲": true}})), rmsg(3, json!({"forMe": {"T-視窗甲": true}}))], mine)]);
    h.core.pull_rooms(TQ + 2000).await;
    assert_eq!(h.said().len(), 1);
    assert!(h.fr.st.lock().unwrap().room_posts.is_empty());
    assert_eq!(bodies(&h).iter().filter(|b| b.contains("額度用完")).count(), 0, "群組不發即時通知（主人通知由後台寄）");
    // 沒有個人信，只有群組訊息被扣住：每小時也要能試送最舊的一則
    h.core.tick(TQ + 1000 + HOUR).await;
    let said = h.said();
    assert_eq!(said.len(), 2, "試送最舊的 #2：{said:?}");
    assert!(said[1].contains("#2") && said[1].contains(&quota_late_line(TQ)));
    // 試送成功（worker 回報 SENT）＝恢復：其餘的依序轉交，帶延遲抬頭
    let id = crate::bridge::rooms::room_uuid("R1", 2, "T~T-視窗甲");
    worker_ok(&mut h.core, &id, TQ + 2000 + HOUR).await;
    assert_eq!(h.core.inbox_hold_until(), None);
    h.core.tick(TQ + 3000 + HOUR).await;
    let said = h.said();
    assert_eq!(said.len(), 3, "{said:?}");
    assert!(said[2].contains("#3") && said[2].contains(&quota_late_line(TQ + 2000)));
}
#[tokio::test]
async fn 群組_扣住超過保留期_不轉交_恢復時改發一則摘要() {
    let mut h = harness(&[("T-視窗甲", "idle")]).await;
    h.core.on_worker_line(quota_line(RESETS_S), TQ).await;
    let mine = json!([{"member": "T~T-視窗甲", "read_seq": 1}]);
    set_rooms(&h, vec![room(vec![rmsg(2, json!({"forMe": {"T-視窗甲": true}})), rmsg(3, json!({"forMe": {"T-視窗甲": true}})), rmsg(4, json!({"forMe": {"T-視窗甲": true}}))], mine)]);
    h.core.pull_rooms(TQ + 1000).await;
    assert!(h.said().is_empty());
    // 過了 24 小時保留期才恢復（全部都超過保留期、沒有可試送的：到了重置時間就解除）
    let late = TQ + 25 * HOUR;
    h.core.tick(late).await;
    assert_eq!(h.core.inbox_hold_until(), None);
    h.core.tick(late + 1000).await;
    let said = h.said();
    assert_eq!(said.len(), 1, "{said:?}");
    assert!(said[0].contains("額度用完期間群組 專案群 有 3 則沒有轉交，範圍 #2～#4，要看請讀群組"), "{}", said[0]);
    assert!(!said[0].contains("群組內文"));
    assert!(h.core.log.has("quota room summary"));
    // 清乾淨了，不會再轉交
    h.core.tick(late + 60_000).await;
    assert_eq!(h.said().len(), 1);
}
#[tokio::test]
async fn 內文行首手打延遲抬頭字樣_轉交時加內文前綴() {
    let mut h = harness(&[("T-乙", "idle")]).await;
    h.fr.put(mail(1, json!({"body": "  這封因額度用完延遲，原本 01:00 收到\n其他"})));
    h.core.pull("test", TQ).await;
    let said = h.said();
    assert!(said[0].contains("\n（內文）  這封因額度用完延遲，原本 01:00 收到\n其他"), "{}", said[0]);
    assert!(!said[0].lines().any(|l| l.starts_with("這封因額度用完延遲")));
}

/// 名單回報裡 inbox_hold_until 的值（有帶這個鍵的那幾次，依序）
fn hold_posts(h: &H) -> Vec<Value> {
    h.fr.rosters().iter().filter_map(|r| r.get("inbox_hold_until").cloned()).collect()
}
fn hold_bodies(h: &H) -> Vec<Value> {
    h.fr.rosters().into_iter().filter(|r| r.get("inbox_hold_until").is_some()).collect()
}

#[tokio::test]
async fn 收信暫停時間回報給後台_扣住時送一次值_恢復時送一次空值_不重複() {
    let mut h = harness(&[("T-乙", "idle")]).await;
    // 啟動後第一次名單報一次空值（清掉上次沒收乾淨的舊值）
    assert_eq!(hold_posts(&h), vec![Value::Null]);
    assert_eq!(h.core.inbox_hold_until(), None);
    h.fr.put(mail(1, json!({})));
    h.core.pull("test", TQ).await;
    h.core.on_worker_line(quota_line(RESETS_S), TQ + 1000).await;
    assert_eq!(h.core.inbox_hold_until(), Some(UNTIL));
    h.core.tick(TQ + 5000).await;
    h.core.tick(TQ + 10_000).await;
    h.core.tick(TQ + HOUR).await;
    assert_eq!(hold_posts(&h), vec![Value::Null, json!(UNTIL)], "扣住時只送一次值，不重複");
    let b = &hold_bodies(&h)[1];
    assert_eq!((b["inbox_hold_count"].clone(), b.get("inbox_hold_computer").cloned()), (json!(1), None), "只帶扣住筆數，設備名由後台讀");
    assert!(b.get("inbox_hold_capped").is_none());
    // 一小時後試送；試送成功才恢復：送一次空值
    h.core.tick(TQ + 1000 + HOUR).await;
    worker_ok(&mut h.core, &uid(1), TQ + 2000 + HOUR).await;
    h.core.tick(TQ + 5000 + HOUR).await;
    h.core.tick(TQ + 10_000 + HOUR).await;
    assert_eq!(h.core.inbox_hold_until(), None);
    assert_eq!(hold_posts(&h), vec![Value::Null, json!(UNTIL), Value::Null]);
}
#[tokio::test]
async fn 額度重置時間存檔_重啟後還沒到就繼續扣住_只試送一封_範圍不對當作沒有() {
    let mut h = harness(&[("T-乙", "idle")]).await;
    h.fr.put(mail(1, json!({})));
    h.core.pull("test", TQ).await;
    h.core.on_worker_line(quota_line(RESETS_S), TQ + 1000).await;
    let text = std::fs::read_to_string(h.work.path().join("pending.json")).unwrap();
    assert!(text.contains(&format!("\"quotaUntil\":{UNTIL}")), "{text}");
    // 重啟：重置時間之前繼續扣住，信重新拉到也不重送
    let sink2 = Arc::new(FakeSink::default());
    let mut c2 = new_core(&h.fr, h.work.path(), h.sessions.path(), sink2.clone(), TQ + 5000);
    assert_eq!(c2.inbox_hold_until(), Some(UNTIL));
    c2.refresh_roster(TQ + 5000).await;
    c2.pull("test", TQ + 6000).await;
    c2.tick(TQ + 7000).await;
    assert!(sink2.said.lock().unwrap().is_empty(), "試送時間前不送");
    h.fr.put(mail(2, json!({})));
    c2.pull("test", TQ + 8000).await;
    assert!(sink2.said.lock().unwrap().is_empty(), "重啟後新進的信也扣住");
    assert!(c2.pending.iter().all(|p| p.state == State::Held));
    assert_eq!(notices_to(&h, "W", "W-政策"), 2, "已通知過的寄件人記錄不存檔：重啟後新進的信會再通知一次，之後同一次不再重複");
    // 重啟後的第一次試送：只送最舊的一封（不是全部）
    c2.tick(TQ + 5000 + HOUR).await;
    assert_eq!(sink2.said.lock().unwrap().len(), 1);
    worker_ok(&mut c2, &uid(1), TQ + 6000 + HOUR).await;
    assert_eq!(c2.inbox_hold_until(), None);
    c2.tick(TQ + 10_000 + HOUR).await;
    assert_eq!(sink2.said.lock().unwrap().len(), 2, "恢復後重送其餘的");
    assert!(!std::fs::read_to_string(h.work.path().join("pending.json")).unwrap().contains("quotaUntil"));
    // 範圍不對（已過去、超過 8 天）：當作沒有
    for bad in [TQ, TQ + 9 * 86_400_000] {
        let mut v: Value = serde_json::from_str(&std::fs::read_to_string(h.work.path().join("pending.json")).unwrap()).unwrap();
        v["quotaUntil"] = json!(bad);
        std::fs::write(h.work.path().join("pending.json"), v.to_string()).unwrap();
        let c3 = new_core(&h.fr, h.work.path(), h.sessions.path(), Arc::new(FakeSink::default()), TQ + 5000);
        assert_eq!(c3.inbox_hold_until(), None, "{bad}");
    }
}

#[tokio::test]
async fn 試送交不出去也算沒回應_連續兩次解除_信重新拉回後延遲抬頭仍是第一次收到的時間() {
    let mut h = harness(&[("T-乙", "idle")]).await;
    h.fr.put(mail(1, json!({})));
    h.core.pull("test", TQ).await;
    h.core.on_worker_line(quota_line(RESETS_S), TQ + 1000).await;
    h.sink.down.store(true, Ordering::SeqCst); // worker 一直壞著：交不出去
    let p1 = TQ + 1000 + HOUR;
    h.core.tick(p1).await;
    assert_eq!(h.core.inbox_hold_until(), Some(UNTIL), "第一次交不出去：還沒到暫停時間，暫停不延長也還沒解除");
    assert!(h.fr.acked().is_empty());
    h.core.pull("test", p1 + 1000).await; // 信沒 ack，留在信箱，重新拉回、再扣住
    assert_eq!(held_ids(&h), vec![uid(1)]);
    // 第二次試送仍交不出去：解除，名單報空值，不是無限期扣著
    let p2 = p1 + HOUR;
    h.core.tick(p2).await;
    assert_eq!(h.core.inbox_hold_until(), None, "連續兩次交不出去就解除");
    h.core.tick(p2 + 10_000).await;
    h.core.tick(p2 + 20_000).await;
    assert_eq!(*hold_posts(&h).last().unwrap(), Value::Null);
    assert!(h.fr.acked().is_empty(), "從頭到尾沒有 ack");
    // 解除後 worker 好了：信走一般流程轉交，延遲抬頭寫第一次收到的時間（不是最後一次拉到的時間）
    h.sink.down.store(false, Ordering::SeqCst);
    h.core.pull("test", p2 + 30_000).await;
    let said = h.said();
    assert!(said.last().unwrap().contains(&quota_late_line(TQ)), "{}", said.last().unwrap());
}

#[tokio::test]
async fn 過了暫停時間才試送_交不出去_第一次就解除() {
    let mut h = harness(&[("T-乙", "idle")]).await;
    h.fr.put(mail(1, json!({})));
    h.core.pull("test", TQ).await;
    h.core.on_worker_line(quota_line(TQ / 1000 - 10), TQ + 1000).await; // 時間不明：暫停一小時
    h.sink.down.store(true, Ordering::SeqCst);
    h.core.tick(TQ + 1000 + HOUR).await;
    assert_eq!(h.core.inbox_hold_until(), None);
    assert!(h.fr.acked().is_empty());
}

#[tokio::test]
async fn 群組試送交不出去也算沒回應_最後解除() {
    let mut h = harness(&[("T-視窗甲", "idle")]).await;
    h.core.on_worker_line(quota_line(RESETS_S), TQ).await;
    let mine = json!([{"member": "T~T-視窗甲", "read_seq": 1}]);
    set_rooms(&h, vec![room(vec![rmsg(2, json!({"forMe": {"T-視窗甲": true}}))], mine)]);
    h.core.pull_rooms(TQ + 1000).await;
    set_rooms(&h, vec![]); // 群組讀不到了：試送時 room_read 失敗
    let p1 = TQ + HOUR;
    h.core.tick(p1).await;
    assert!(h.core.inbox_hold_until().is_some());
    h.core.tick(p1 + HOUR).await;
    assert_eq!(h.core.inbox_hold_until(), None, "連續兩次試送都失敗：解除");
}

/// 一則額度扣住的群組訊息（#2）；Sent 事件讓扣住解除。回傳解除的時間
async fn room_held_then_released(h: &mut H) -> u64 {
    h.fr.put(mail(1, json!({"to_agent": "T-乙"})));
    h.core.pull("test", TQ).await;
    h.core.on_worker_line(quota_line(RESETS_S), TQ + 1000).await;
    let mine = json!([{"member": "T~T-視窗甲", "read_seq": 1}]);
    set_rooms(h, vec![room(vec![rmsg(2, json!({"forMe": {"T-視窗甲": true}}))], mine)]);
    h.core.pull_rooms(TQ + 2000).await;
    assert!(h.core.log.has("room=R1 #2 member=T~T-視窗甲 held for quota"));
    worker_ok(&mut h.core, &uid(1), TQ + 3000).await; // worker 回報 SENT＝恢復
    assert_eq!(h.core.inbox_hold_until(), None);
    TQ + 3000
}

#[tokio::test]
async fn 恢復後群組訊息轉交失敗_照三十秒退避重試_不是每個_tick_都試() {
    let mut h = harness(&[("T-乙", "idle"), ("T-視窗甲", "idle")]).await;
    let t = room_held_then_released(&mut h).await;
    h.sink.down.store(true, Ordering::SeqCst);
    let n = |h: &H| h.core.log.count("cannot hand room=R1 #2");
    h.core.tick(t + 1000).await;
    assert_eq!(n(&h), 1);
    h.core.tick(t + 2000).await;
    h.core.tick(t + 10_000).await;
    h.core.tick(t + 20_000).await;
    assert_eq!(n(&h), 1, "三十秒內不重試");
    h.core.tick(t + 32_000).await;
    assert_eq!(n(&h), 2, "三十秒後才試第二次");
    // 好了就轉交成功，訊息還在
    h.sink.down.store(false, Ordering::SeqCst);
    let before = h.said().len();
    h.core.tick(t + 70_000).await;
    let said = h.said();
    assert_eq!(said.len(), before + 1);
    assert!(said.last().unwrap().contains("#2"));
}

#[tokio::test]
async fn 恢復後群組訊息一直轉交失敗_真的放棄時改發摘要_不無聲丟掉() {
    let mut h = harness(&[("T-乙", "idle"), ("T-視窗甲", "idle")]).await;
    let t = room_held_then_released(&mut h).await;
    set_rooms(&h, vec![]); // 群組讀不到：每次都失敗
    for k in 1..=130u64 {
        h.core.tick(t + k * 31_000).await;
    }
    assert!(h.core.log.has("gave up after repeated failures"));
    let said = h.said();
    assert!(said.iter().any(|t| t.contains("額度用完期間群組 專案群 有 1 則沒有轉交，範圍 #2～#2，要看請讀群組")), "{said:?}");
}

#[tokio::test]
async fn sent_比額度事件晚到_不再重送_直接當作已轉交_進入等回覆() {
    let mut h = harness(&[("T-乙", "idle")]).await;
    h.fr.put(mail(1, json!({})));
    h.core.pull("test", TQ).await;
    h.core.on_worker_line(quota_line(RESETS_S), TQ + 1000).await;
    assert_eq!(held_ids(&h), vec![uid(1)]);
    worker_ok(&mut h.core, &uid(1), TQ + 1500).await; // Sent 晚到
    assert!(held_ids(&h).is_empty());
    assert_eq!(h.core.pending[0].state, State::Waiting, "進入等回覆");
    assert_eq!(h.fr.acked(), vec![uid(1)]);
    h.core.tick(TQ + 10_000).await;
    h.core.tick(TQ + HOUR).await;
    assert_eq!(h.said().len(), 1, "只轉交一次");
}

#[tokio::test]
async fn sent_比額度事件晚到_群組訊息也不再轉交一次() {
    let mut h = harness(&[("T-視窗甲", "idle")]).await;
    let mine = json!([{"member": "T~T-視窗甲", "read_seq": 1}]);
    set_rooms(&h, vec![room(vec![rmsg(2, json!({"forMe": {"T-視窗甲": true}}))], mine)]);
    h.core.pull_rooms(TQ).await;
    h.core.on_worker_line(quota_line(RESETS_S), TQ + 1000).await;
    assert!(h.core.pending.is_empty());
    let id = crate::bridge::rooms::room_uuid("R1", 2, "T~T-視窗甲");
    worker_ok(&mut h.core, &id, TQ + 1500).await;
    assert_eq!(h.core.pending.len(), 1);
    assert_eq!(h.core.pending[0].state, State::Waiting);
    h.core.tick(TQ + 10_000).await;
    h.core.tick(TQ + HOUR).await;
    assert_eq!(h.said().len(), 1, "只轉交一次");
}

#[tokio::test]
async fn 自動回信模式不參與扣住_額度事件略過_照原流程() {
    let fr = FakeRelay::start();
    let work = tempfile::tempdir().unwrap();
    let sessions = tempfile::tempdir().unwrap();
    let sink = Arc::new(FakeSink::default());
    let mut core = new_core(&fr, work.path(), sessions.path(), sink.clone(), TQ);
    core.cfg.respond = Some("T-linux".into());
    core.cfg.default_agent = String::new();
    core.refresh_roster(TQ).await;
    fr.put(mail(1, json!({"to_agent": "T-linux"})));
    core.pull("test", TQ).await;
    assert_eq!(sink.said.lock().unwrap().len(), 1);
    core.on_worker_line(quota_line(RESETS_S), TQ + 1000).await;
    assert_eq!(core.inbox_hold_until(), None, "不參與扣住");
    assert!(core.log.has("respond mode does not hold mail"));
    // 額度事件之後到的信：照原流程交給 worker，不扣
    fr.put(mail(2, json!({"to_agent": "T-linux"})));
    core.pull("test", TQ + 2000).await;
    assert_eq!(sink.said.lock().unwrap().len(), 2);
    assert!(core.pending.iter().all(|p| p.state != State::Held));
    core.tick(TQ + HOUR).await;
    assert_eq!(core.inbox_hold_until(), None);
}

// ================================================================================================
// 收發室 worker 的 Claude 登入失效（todo-next-197）：照額度用完的做法扣住，不退信
// ================================================================================================

fn auth_line() -> WorkerLine {
    WorkerLine::Line(json!({"type":"result","is_error":true,"result":"Failed to authenticate: OAuth session expired and could not be refreshed","duration_ms":101,"total_cost_usd":0}).to_string())
}
fn auth_notices_to(h: &H, node: &str, agent: &str) -> usize {
    h.fr.sent().iter().filter(|s| s["to_node"] == node && s["to_agent"] == agent && s["body"].as_str().unwrap_or("").contains("登入失效了，信已收到、先留著，重新登入後會送出")).count()
}

#[tokio::test]
async fn 登入失效_信留著不退_不連續失敗_寄件人同一段只通知一次_不寄逾時() {
    const TQ: u64 = T0 + 210 * 86_400_000;
    let mut h = harness(&[("T-乙", "idle")]).await;
    h.core.cfg.one_per_turn = true;
    h.fr.put(mail(1, json!({})));
    h.core.pull("test", TQ).await;
    assert_eq!(h.said().len(), 1);
    // worker 第一輪就回登入失效：這封扣住（Held），不 ack、不寄「失敗」「逾時」
    h.core.on_worker_line(auth_line(), TQ + 1000).await;
    assert_eq!(held_ids(&h), vec![uid(1)]);
    assert!(h.fr.acked().is_empty(), "不 ack，信還在後台");
    assert_eq!(auth_notices_to(&h, "W", "W-政策"), 1, "通知一次：登入失效、信留著、重新登入後送出");
    assert!(h.core.inbox_hold_until().is_some(), "和額度一樣，名單回報帶暫停時間");
    // 只有這一次 AuthFailed、後面信全扣住（下一次試送在一小時後）：本人的通知靠這一筆（登入失效偵測一筆就算）
    assert!(crate::login_watch::worker_errors_since(TQ as i64) >= 1, "worker 回報的登入失效已記給本人通知用");
    // 這一輪結束後 #726 會馬上再拉：後面來的信直接扣住，不再一封一封試
    h.fr.put(mail(2, json!({})));
    h.fr.put(mail(3, json!({"from_agent": "W-別人"})));
    h.fr.put(mail(4, json!({})));
    h.core.pull("test", TQ + 2000).await;
    assert_eq!(h.said().len(), 1, "不再送 worker（不連續失敗）");
    assert_eq!(held_ids(&h).len(), 4);
    assert!(h.fr.acked().is_empty());
    assert_eq!(auth_notices_to(&h, "W", "W-政策"), 1, "同寄件人同一段失效期間不重複");
    assert_eq!(auth_notices_to(&h, "W", "W-別人"), 1, "另一位寄件人各通知一次");
    assert!(bodies(&h).iter().all(|b| !b.contains("逾時") && !b.contains("失敗")), "{:?}", bodies(&h));
    h.core.tick(TQ + 130_000).await;
    assert!(bodies(&h).iter().all(|b| !b.contains("逾時") && !b.contains("失敗")), "扣住期間不寄轉交逾時");
    assert_eq!(h.said().len(), 1);
}

#[tokio::test]
async fn 登入失效_每小時試送_又失效就繼續留著_好了就依原順序一封一封重送_延遲抬頭寫登入失效() {
    const TQ: u64 = T0 + 211 * 86_400_000;
    let mut h = harness(&[("T-乙", "idle")]).await;
    h.core.cfg.one_per_turn = true;
    h.fr.put(mail(1, json!({})));
    h.core.pull("test", TQ).await;
    h.core.on_worker_line(auth_line(), TQ + 1000).await;
    h.fr.put(mail(2, json!({})));
    h.fr.put(mail(3, json!({})));
    h.core.pull("test", TQ + 2000).await;
    let probe = TQ + 1000 + 300_000; // 登入失效：第一次試送約 5 分鐘後（之後才每小時）
    h.core.tick(probe - 1).await;
    assert_eq!(h.said().len(), 1, "還沒到試送時間");
    // 試送：只送最舊的一封；又登入失效 → 繼續留著，不重複通知，不丟
    h.core.tick(probe).await;
    assert_eq!(h.said().len(), 2, "只試送一封");
    h.core.on_worker_line(auth_line(), probe + 1000).await;
    assert_eq!(held_ids(&h).len(), 3, "試送又失敗：三封都還留著");
    assert!(h.fr.acked().is_empty());
    assert_eq!(auth_notices_to(&h, "W", "W-政策"), 1, "不重複通知");
    // 本人的通知：失敗 → 扣住 → 約 5 分鐘後試送又失敗，兩筆落在十分鐘內（走真實順序，不是手動塞兩筆）
    assert!(crate::login_watch::worker_errors_since(TQ as i64) >= 2, "worker 回報的登入失效記了兩筆，間隔 5 分鐘");
    // 之後每小時試送一次；這次成功（worker 回報 SENT）＝登入好了：依原收到順序重送其餘，照 one_per_turn 一封一封來
    let probe2 = probe + 1000 + HOUR; // 第一次試送失敗後改成每小時
    h.core.tick(probe2).await;
    assert_eq!(h.said().len(), 3);
    worker_ok(&mut h.core, &uid(1), probe2 + 1000).await;
    assert_eq!(h.core.inbox_hold_until(), None, "恢復");
    assert!(crate::login_watch::worker_recoveries_since(TQ as i64) >= 1, "試送成功：告訴登入失效偵測 worker 好了（失效狀態才會解除）");
    h.core.tick(probe2 + 5000).await;
    let ids = |h: &H| -> Vec<String> { h.said().iter().filter_map(|t| t.split("id=").nth(1).map(|x| x.split(' ').next().unwrap_or("").to_string())).collect() };
    assert_eq!(ids(&h).last().cloned(), Some(uid(2)), "第二封先送");
    let said = h.said();
    let late = said.last().unwrap().lines().find(|l| l.starts_with("這封因收發室登入失效延遲，原本")).map(String::from);
    assert!(late.is_some(), "延遲抬頭寫登入失效（不是額度用完）：{}", said.last().unwrap());
    assert!(!said.last().unwrap().contains("這封因額度用完延遲"));
    // 第二封做完（一輪結束）才輪到第三封，不重複送第一、二封
    worker_ok(&mut h.core, &uid(2), probe2 + 6000).await;
    h.core.pull("test", probe2 + 7000).await;
    assert_eq!(ids(&h).last().cloned(), Some(uid(3)), "第三封最後送");
    worker_ok(&mut h.core, &uid(3), probe2 + 8000).await;
    let sent: Vec<String> = ids(&h);
    assert_eq!(sent, vec![uid(1), uid(1), uid(1), uid(2), uid(3)], "第一封＝原本一次＋兩次試送；第二、三封各一次，不重複：{sent:?}");
}

#[tokio::test]
async fn 登入失效_偵測到重新登入就提早試送_不等整點() {
    const TQ: u64 = T0 + 212 * 86_400_000;
    let mut h = harness(&[("T-乙", "idle")]).await;
    // 登入檔的修改時間（0＝還沒重新登入）；偵測是「登入檔比扣住開始新」，和真的一樣
    let cred_mtime = Arc::new(AtomicU64::new(0));
    let m2 = cred_mtime.clone();
    h.core.relogin_since = Some(Arc::new(move |since| m2.load(Ordering::SeqCst) > since));
    h.fr.put(mail(1, json!({})));
    h.core.pull("test", TQ).await;
    h.core.on_worker_line(auth_line(), TQ + 1000).await;
    h.core.tick(TQ + 60_000).await;
    assert_eq!(h.said().len(), 1, "還沒重新登入、也沒到第一次試送（約 5 分鐘）：不試送");
    cred_mtime.store(TQ + 100_000, Ordering::SeqCst);
    h.core.tick(TQ + 120_000).await;
    assert_eq!(h.said().len(), 2, "登入檔更新了：馬上試送最舊的一封");
    // 試送又失敗：下一個 tick 不會因為同一次重新登入又試送（試送後重新起算）
    h.core.on_worker_line(auth_line(), TQ + 121_000).await;
    h.core.tick(TQ + 130_000).await;
    h.core.tick(TQ + 140_000).await;
    assert_eq!(h.said().len(), 2, "不每個 tick 都試");
}

#[tokio::test]
async fn 登入失效_重開後扣住原因還在_新寄件人收到登入失效的通知_不是假的額度重置時間() {
    const TQ: u64 = T0 + 213 * 86_400_000;
    let mut h = harness(&[("T-乙", "idle")]).await;
    h.fr.put(mail(1, json!({})));
    h.core.pull("test", TQ).await;
    h.core.on_worker_line(auth_line(), TQ + 1000).await;
    assert_eq!(held_ids(&h), vec![uid(1)]);
    // 重開 ASN（同一個工作資料夾）
    h.core = new_core(&h.fr, h.work.path(), h.sessions.path(), h.sink.clone(), TQ + 60_000);
    h.core.refresh_roster(TQ + 60_000).await;
    assert!(h.core.inbox_hold_until().is_some(), "重開後仍在扣住");
    h.fr.put(mail(2, json!({"from_agent": "W-新寄件人"})));
    h.core.pull("test", TQ + 61_000).await;
    assert_eq!(auth_notices_to(&h, "W", "W-新寄件人"), 1, "新寄件人收到的是登入失效的通知");
    assert_eq!(notices_to(&h, "W", "W-新寄件人"), 0, "不是額度用完的通知（沒有假的重置時間）");
    // 重開後第一次試送也在約 5 分鐘後（不是一小時後）
    h.core.tick(TQ + 60_000 + 301_000).await;
    assert!(h.said().len() >= 2, "重開後約 5 分鐘就試送");
    // 重送的抬頭仍寫登入失效
    worker_ok(&mut h.core, &uid(1), TQ + 400_000).await;
    h.core.tick(TQ + 405_000).await;
    let last = h.said().last().cloned().unwrap();
    assert!(last.contains("這封因收發室登入失效延遲，原本") || last.contains(&uid(1)), "{last}");
}

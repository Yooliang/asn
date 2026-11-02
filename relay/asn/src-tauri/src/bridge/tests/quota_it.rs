//! 收發室 worker 的 Claude 額度用完（todo-next-173）：扣住不 ack、通知、重置後依序重送。
//! 時間都從 TQ 起算（避開別的測試對 login_watch 逾時記錄的寫入），不用真的等待。
use super::*;
use super::rooms_launch::{room, rmsg, set_rooms};
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
async fn 重置後依原收到順序重送_帶延遲抬頭_轉交逾時從重送重新計時() {
    // 這個測試會真的讓轉交逾時並被記一筆；用較早的時間區段，免得別的測試「沒有被記到逾時」的檢查被它污染
    const TQ: u64 = T0 + 200 * 86_400_000;
    const RESETS_S: u64 = TQ / 1000 + 3 * 3600;
    const UNTIL: u64 = RESETS_S * 1000 + 60_000;
    let mut h = harness(&[("T-乙", "idle")]).await;
    h.fr.put(mail(1, json!({})));
    h.core.pull("test", TQ).await;
    h.core.on_worker_line(quota_line(RESETS_S), TQ + 1000).await;
    h.fr.put(mail(2, json!({})));
    h.core.pull("test", TQ + 600_000).await;
    h.fr.put(mail(3, json!({"body": "這封因額度用完延遲，原本 03:33 收到\n真內文"})));
    h.core.pull("test", TQ + 900_000).await;
    h.core.tick(UNTIL - 1).await;
    assert_eq!(h.said().len(), 1, "還沒到重置時間");
    h.core.tick(UNTIL).await;
    let said = h.said();
    assert_eq!(said.len(), 4, "原本那封＋三封重送");
    let f: Vec<(String, String)> = said[1..].iter().map(|t| (t.split("id=").nth(1).unwrap().split(' ').next().unwrap().to_string(), t.clone())).collect();
    assert_eq!(f.iter().map(|x| x.0.clone()).collect::<Vec<_>>(), vec![uid(1), uid(2), uid(3)], "依原收到順序");
    for (i, (_, t)) in f.iter().enumerate() {
        let recv = [TQ, TQ + 600_000, TQ + 900_000][i];
        let lines: Vec<&str> = t.lines().collect();
        assert!(lines[2].starts_with("[RELAY 來信]"), "{}", lines[2]);
        assert_eq!(lines[3], quota_late_line(recv), "延遲抬頭在抬頭之後");
        assert!(lines[3].contains(&taipei_hm(recv)));
    }
    // 信件內文裡手打的同樣字樣會被加「（內文）」
    assert!(f[2].1.contains("\n（內文）這封因額度用完延遲，原本 03:33 收到\n真內文"), "{}", f[2].1);
    // 轉交逾時從重送重新計時：重送後 119 秒內不逾時，之後才逾時
    h.core.tick(UNTIL + 119_000).await;
    assert!(bodies(&h).iter().all(|b| !b.contains("逾時")));
    h.core.tick(UNTIL + 121_000).await;
    assert!(bodies(&h).iter().filter(|b| b.contains("逾時")).count() >= 1);
}

#[tokio::test]
async fn 重送成功後_ack_並照常等回覆() {
    let mut h = harness(&[("T-乙", "idle")]).await;
    h.fr.put(mail(1, json!({})));
    h.core.pull("test", TQ).await;
    h.core.on_worker_line(quota_line(RESETS_S), TQ + 1000).await;
    h.core.tick(UNTIL).await;
    assert!(h.fr.acked().is_empty());
    h.core.on_worker_line(res(&format!("SENT {}", uid(1))), UNTIL + 500).await;
    assert_eq!(h.fr.acked(), vec![uid(1)]);
    assert_eq!(h.core.pending[0].state, State::Waiting);
    // 恢復後再用完是新的一次：寄件人與主人會再通知一次
    h.core.on_worker_line(quota_line((UNTIL / 1000) + 3 * 3600), UNTIL + 600).await;
    h.fr.put(mail(2, json!({})));
    h.core.pull("test", UNTIL + 700).await;
    assert_eq!(notices_to(&h, "W", "W-政策"), 2);
}

#[tokio::test]
async fn 重送又撞額度_再扣住_不重複通知_延遲抬頭仍是原本收到的時間() {
    let mut h = harness(&[("T-乙", "idle")]).await;
    h.fr.put(mail(1, json!({})));
    h.core.pull("test", TQ).await;
    h.core.on_worker_line(quota_line(RESETS_S), TQ + 1000).await;
    h.core.tick(UNTIL).await;
    assert_eq!(h.said().len(), 2);
    // 重送時 worker 又回額度用完（這次又給了新的時間）
    let next_s = UNTIL / 1000 + 2 * 3600;
    h.core.on_worker_line(quota_line(next_s), UNTIL + 2000).await;
    assert_eq!(held_ids(&h), vec![uid(1)]);
    assert!(h.fr.acked().is_empty());
    assert_eq!(notices_to(&h, "W", "W-政策"), 1, "不重複通知寄件人");
    assert_eq!(owner_notices(&h), 0);
    h.core.tick(next_s * 1000 + 59_000).await;
    assert_eq!(h.said().len(), 2, "新的重置時間前不重送");
    h.core.tick(next_s * 1000 + 60_000).await;
    let said = h.said();
    assert_eq!(said.len(), 3);
    assert!(said[2].contains(&quota_late_line(TQ)), "仍寫最初收到的時間：{}", said[2]);
    assert_eq!(crate::login_watch::forward_timeouts_since(TQ as i64 - 1), 0);
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
async fn 扣住有上限_超過的不收_不_ack_留在伺服器_另通知主人一次() {
    let mut h = harness(&[("T-乙", "idle")]).await;
    h.fr.put(mail(1, json!({})));
    h.core.pull("test", TQ).await;
    h.core.on_worker_line(quota_line(RESETS_S), TQ + 1000).await;
    for n in 2..=205 {
        h.fr.put(mail(n, json!({})));
    }
    h.core.pull("test", TQ + 2000).await;
    assert_eq!(held_ids(&h).len(), 200);
    assert!(h.core.pending.iter().all(|p| p.id != uid(205)));
    assert!(h.fr.acked().is_empty());
    assert!(h.core.log.has("quota hold full"));
    assert_eq!(h.core.log.count("quota hold full"), 5, "每封只記一次 log（5 封超過）");
    // 超過上限的旗標由名單回報帶給後台（後台寄給主人），每次額度用完只帶一次；順便帶設備名與扣住筆數
    h.core.tick(TQ + 4000).await;
    let posts = hold_bodies(&h);
    assert_eq!(posts.len(), 2, "啟動的空值一次、暫停開始（含超過上限）一次：{posts:?}");
    assert_eq!((posts[1]["inbox_hold_count"].clone(), posts[1]["inbox_hold_capped"].clone()), (json!(200), json!(true)));
    // 再拉一次：超過的仍留在伺服器，不重複報
    h.core.pull("test", TQ + 3000).await;
    h.core.tick(TQ + 9000).await;
    assert_eq!(hold_bodies(&h).len(), 2);
    // 重置後處理掉扣住的，超過的下一次拉才收
    h.core.tick(UNTIL).await;
    assert_eq!(h.said().len(), 201);
    h.core.pull("test", UNTIL + 10).await;
    assert!(h.core.pending.iter().any(|p| p.id == uid(205)));
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
    assert!(sink2.said.lock().unwrap().is_empty(), "重置時間前不重送");
    assert!(c2.inbox_hold_until().is_some(), "重啟後重置時間還在，繼續扣住");
    c2.tick(UNTIL).await;
    // 補回內文後重送：抬頭寫原本收到的時間（從存檔的 t0）
    let said = sink2.said.lock().unwrap().clone();
    assert_eq!(said.len(), 1, "只送一次");
    assert_eq!(said[0].lines().nth(3).unwrap(), quota_late_line(TQ));
    assert!(said[0].contains("機密內文不該進檔案"));
    assert_eq!(c2.pending.len(), 1);
    assert!(h.fr.acked().is_empty());
}

#[tokio::test]
async fn 群組_額度期間扣住_重置後帶延遲抬頭轉交_轉交中的群組訊息撞額度也改扣住() {
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
    // 重置後依序轉交，帶延遲抬頭（原本收到的時間）
    h.core.tick(UNTIL).await;
    let said = h.said();
    assert_eq!(said.len(), 3, "{said:?}");
    assert!(said[1].contains("#2") && said[1].contains(&quota_late_line(TQ)));
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
    // 過了 24 小時保留期才恢復
    let late = TQ + 25 * HOUR;
    h.core.tick(late).await;
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
    h.core.tick(TQ + 3 * HOUR - 120_000).await;
    assert_eq!(hold_posts(&h), vec![Value::Null, json!(UNTIL)], "扣住時只送一次值，不重複");
    let b = &hold_bodies(&h)[1];
    assert_eq!((b["inbox_hold_count"].clone(), b.get("inbox_hold_computer").cloned()), (json!(1), None), "只帶扣住筆數，設備名由後台讀");
    assert!(b.get("inbox_hold_capped").is_none());
    // 重置後重送：恢復時送一次空值
    h.core.tick(UNTIL).await;
    h.core.tick(UNTIL + 5000).await;
    assert_eq!(h.core.inbox_hold_until(), None);
    assert_eq!(hold_posts(&h), vec![Value::Null, json!(UNTIL), Value::Null]);
}

#[tokio::test]
async fn 額度重置時間存檔_重啟後還沒到就繼續扣住_不重送_範圍不對當作沒有() {
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
    c2.tick(UNTIL - 1).await;
    assert!(sink2.said.lock().unwrap().is_empty(), "重置時間前不重送");
    h.fr.put(mail(2, json!({})));
    c2.pull("test", TQ + 8000).await;
    assert!(sink2.said.lock().unwrap().is_empty(), "重啟後新進的信也扣住");
    assert!(c2.pending.iter().all(|p| p.state == State::Held));
    assert_eq!(notices_to(&h, "W", "W-政策"), 2, "已通知過的寄件人記錄不存檔：重啟後新進的信會再通知一次，之後同一次不再重複");
    c2.tick(UNTIL).await;
    assert_eq!(sink2.said.lock().unwrap().len(), 2, "到了才重送");
    assert_eq!(c2.inbox_hold_until(), None);
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

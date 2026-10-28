//! 第二段（群組、附件、孤兒、舊橋退出後接手）與第三段（遠端開視窗）的整合測試。
//! 對應 relay/machine/test 的 rooms.test.mjs、launcher.test.mjs、attach.test.mjs（橋端）、bridges.test.mjs（附件提示）。
//! 同樣只連 127.0.0.1 的假後端、假 worker、假視窗程式；工作資料夾都是暫存資料夾，不碰真的 bridge.pid。
use super::*;
use crate::nowin::NoWindow;
use crate::bridge::launcher::{self, LaunchEnv, Launched, Launcher};
use crate::bridge::rooms::{room_uuid, ROOM_HINT};
use crate::launch::config::{build_spawn_spec, canonical_launch_cwd, LaunchConfig, LaunchReq};
use crate::launch::profiles::{LaunchMode, Profile};
use std::path::{Path, PathBuf};
use tokio::sync::mpsc::UnboundedReceiver;

// ---- 小工具 ----------------------------------------------------------------------------------------

/// 轉交給 worker 的指令拆開：（信件編號，收件視窗，外部資料區塊裡的文字）
fn fwd(said: &[String]) -> Vec<(String, String, String)> {
    said.iter()
        .map(|t| {
            let head = t.lines().next().unwrap();
            let id = head.split("id=").nth(1).unwrap().split(' ').next().unwrap().to_string();
            let to = head.split("to=").nth(1).unwrap().trim_end_matches(']').to_string();
            let body = t.split("<<<MAIL\n").nth(1).unwrap().rsplit_once("\nMAIL>>>").unwrap().0.to_string();
            (id, to, body)
        })
        .collect()
}

fn rmsg(seq: u64, extra: Value) -> Value {
    let mut m = json!({"seq": seq, "from": "W~W-政策", "from_name": "政策", "trust": "member", "body": format!("群組內文-{seq}"), "mentions": [], "at": "t", "forMe": {}});
    for (k, v) in extra.as_object().unwrap() {
        m[k] = v.clone();
    }
    m
}
fn room(messages: Vec<Value>, mine: Value) -> Value {
    json!({"id": "R1", "name": "專案群", "last_seq": messages.last().unwrap()["seq"], "mine": mine, "messages": messages})
}
fn set_rooms(h: &H, rooms: Vec<Value>) {
    h.fr.st.lock().unwrap().rooms = rooms;
}
fn reads(h: &H) -> Vec<Value> {
    h.fr.st.lock().unwrap().room_reads.clone()
}
fn posts(h: &H) -> Vec<Value> {
    h.fr.st.lock().unwrap().room_posts.clone()
}
fn cursor_file(h: &H) -> Value {
    serde_json::from_str(&std::fs::read_to_string(h.work.path().join("rooms-cursor.json")).unwrap_or_else(|_| "{}".into())).unwrap()
}
/// 重新建一個核心（模擬橋重啟），同一個工作資料夾
async fn restart(h: &mut H, now: u64) {
    h.core = new_core(&h.fr, h.work.path(), h.sessions.path(), h.sink.clone(), now);
    h.core.refresh_roster(now).await;
}

// ================================================================================================
// 附件
// ================================================================================================

#[tokio::test]
async fn 信帶附件_轉給視窗的文字多一行提示_替代文字行不重複_縮圖不轉交_沒附件的信原樣() {
    let mut h = harness(&[("T-乙", "idle")]).await;
    let att = json!({"id": uid(0x50), "kind": "image", "name": "cat.webp", "mime": "image/webp", "bytes": 183422, "width": 1536, "height": 2048, "thumb": "data:image/webp;base64,SECRETTHUMB", "expires_at": "x", "expired": false});
    h.fr.put(mail(1, json!({"body": "〔照片〕cat.webp\n看這隻", "attachments": [att], "expects_reply": false})));
    h.fr.put(mail(2, json!({"expects_reply": false})));
    h.core.pull("test", T0).await;
    let f = fwd(&h.said());
    assert_eq!(f.len(), 2);
    let lines: Vec<&str> = f[0].2.lines().collect();
    assert!(lines[0].starts_with("[RELAY 來信]"));
    assert_eq!(lines[1], "寄件人：W-政策（成員身分）");
    assert_eq!(lines[2], "看這隻");
    assert_eq!(lines[3], format!("〔照片〕cat.webp（image/webp，179 KB，1536×2048）下載：/x/asn-cli attach --id {}", uid(0x50)));
    assert_eq!(lines[4], crate::bridge::corrlog::path_line(&h.core.cfg.handoff_dir, "T-乙"), "最後多一行往來記錄的路徑");
    assert_eq!(lines.len(), 5);
    assert!(!h.said().join("\n").contains("SECRETTHUMB"));
    assert_eq!(f[1].2.lines().count(), 4, "沒附件的信：抬頭＋寄件人說明＋內文＋往來記錄路徑，沒有多餘的行");
}

// ================================================================================================
// 群組
// ================================================================================================

#[tokio::test]
async fn 群組_只轉_for_me_點名轉給對的視窗_標頭提示與上下文_回覆以視窗身分貼回_游標不重播() {
    let mut h = harness(&[("T-視窗甲", "idle"), ("T-甲", "idle")]).await;
    set_rooms(
        &h,
        vec![room(
            vec![
                rmsg(2, json!({})),                                                                                                  // 沒人 for_me
                rmsg(3, json!({"forMe": {"T-視窗甲": true}})),                                                                       // 點名視窗甲
                rmsg(4, json!({"from": "~owner", "from_name": "小良哥", "trust": "owner", "forMe": {"": true, "T-視窗甲": true}})),   // owner 發問
            ],
            json!([{"member": "T~T-視窗甲", "read_seq": 1}, {"member": "T", "read_seq": 1}]),
        )],
    );
    h.core.pull("test", T0).await;
    let f = fwd(&h.said());
    // 恰好 3 次轉交（#2 不轉）
    let key = |x: &(String, String, String)| format!("{}#{}", x.1, x.2.split(" #").nth(1).unwrap().split('\n').next().unwrap());
    let mut keys: Vec<String> = f.iter().map(key).collect();
    keys.sort();
    assert_eq!(keys, vec!["T-甲#4", "T-視窗甲#3", "T-視窗甲#4"]);
    // id 是確定性 UUID：節點本身用成員 key「T」，視窗用「T~視窗名」
    let d4 = f.iter().find(|x| key(x) == "T-甲#4").unwrap();
    assert_eq!(d4.0, room_uuid("R1", 4, "T"));
    assert_eq!(f.iter().find(|x| key(x) == "T-視窗甲#4").unwrap().0, room_uuid("R1", 4, "T~T-視窗甲"));
    // 標頭、提示、內文、上下文（前面最近的幾則，舊→新）、往回翻的指令
    let j3 = &f.iter().find(|x| key(x) == "T-視窗甲#3").unwrap().2;
    assert_eq!(j3, &format!("[群組 專案群] trust=member from=W/W-政策 #3\n{ROOM_HINT}\n群組內文-3\n---- 前面 1 則（舊→新）----\n#2 政策：群組內文-2\n（要看更多：/x/asn-cli room --room-read R1 --last 20）
{}", crate::bridge::corrlog::path_line(&h.core.cfg.handoff_dir, "T-視窗甲")));
    assert!(d4.2.contains("---- 前面 2 則（舊→新）----\n#2 政策：群組內文-2\n#3 政策：群組內文-3\n（要看更多"));
    assert!(d4.2.starts_with("[群組 專案群] trust=owner from=主人 #4\n"));
    // 所有 room_read 都帶 since、不帶 mark（不動後端已讀）；視窗帶 as_agent、節點本身不帶；起算點是 read_seq
    let rs = reads(&h);
    assert!(!rs.is_empty() && rs.iter().all(|r| !r["since"].is_null() && r["mark"].is_null()));
    assert!(rs.iter().any(|r| r["as_agent"] == "T-視窗甲" && r["since"] == 1));
    assert!(rs.iter().any(|r| r["as_agent"].is_null() && r["since"] == 1));
    // 轉交完成（worker 回 SENT）：群組訊息不 ack
    let ids: Vec<String> = f.iter().map(|x| x.0.clone()).collect();
    h.core.on_worker_line(res(&ids.iter().map(|i| format!("SENT {i}")).collect::<Vec<_>>().join("\n")), T0 + 10).await;
    assert!(h.fr.acked().is_empty(), "群組沒有信箱可 ack");
    // 回覆經收發室貼回群組：視窗成員帶視窗名、節點本身（成員 key＝T）不帶 from_agent
    h.core.on_worker_line(res(&reply_block("T-視窗甲", "我來回覆")), T0 + 20).await;
    h.core.on_worker_line(res(&reply_block("T-視窗甲", "我來回覆")), T0 + 21).await;
    h.core.on_worker_line(res(&reply_block("T-甲", "我來回覆")), T0 + 22).await;
    let p = posts(&h);
    assert_eq!(p.len(), 3);
    assert!(p.iter().all(|x| x["room"] == "R1" && x["body"] == "我來回覆"));
    let mut who: Vec<Option<String>> = p.iter().map(|x| x["from_agent"].as_str().map(String::from)).collect();
    who.sort();
    assert_eq!(who, vec![None, Some("T-視窗甲".into()), Some("T-視窗甲".into())]);
    assert!(h.fr.sent().is_empty(), "群組回覆不走一般寄信");
    // 游標推進到 last_seq，之後不再讀、不重播
    let c = cursor_file(&h);
    assert_eq!((c["R1|T~T-視窗甲"].as_u64(), c["R1|T"].as_u64()), (Some(4), Some(4)));
    let n = reads(&h).len();
    h.core.pull("test", T0 + 30).await;
    assert_eq!((fwd(&h.said()).len(), reads(&h).len()), (3, n));
}

#[tokio::test]
async fn 群組_沒有游標且_read_seq_為_0_從最新起算不補播_既有游標檔不重播_視窗不可轉交就略過並推進游標() {
    let mut h = harness(&[("T-視窗甲", "idle"), ("T-甲", "idle")]).await;
    std::fs::write(h.work.path().join("rooms-cursor.json"), json!({"R1|T~T-視窗甲": 2}).to_string()).unwrap();
    restart(&mut h, T0).await;
    set_rooms(
        &h,
        vec![room(
            vec![rmsg(2, json!({"forMe": {"T-視窗甲": true, "": true}})), rmsg(3, json!({"forMe": {"T-視窗甲": true, "": true, "T-不在": true}}))],
            json!([{"member": "T~T-視窗甲", "read_seq": 0}, {"member": "T", "read_seq": 0}, {"member": "T~T-不在", "read_seq": 1}]),
        )],
    );
    h.core.pull("test", T0).await;
    // 視窗甲：既有游標 2 → 只轉 #3；節點本身：無游標＋read_seq=0 → 從 last_seq=3 起算 → 不轉；T-不在：略過
    let f = fwd(&h.said());
    assert_eq!(f.iter().map(|x| x.1.as_str()).collect::<Vec<_>>(), vec!["T-視窗甲"]);
    assert!(f[0].2.starts_with("[群組 專案群] trust=member from=W/W-政策 #3\n"));
    let c = cursor_file(&h);
    assert_eq!((c["R1|T"].as_u64(), c["R1|T~T-不在"].as_u64()), (Some(3), Some(3)));
    assert!(h.core.log.has("window T-不在 not forwardable: skipped"));
}

#[tokio::test]
async fn 群組_回覆含不需回覆不貼回_貼回遇到_429_只記_log_不重試() {
    let mut h = harness(&[("T-視窗甲", "idle")]).await;
    set_rooms(&h, vec![room(vec![rmsg(2, json!({"forMe": {"T-視窗甲": true}}))], json!([{"member": "T~T-視窗甲", "read_seq": 1}]))]);
    h.core.pull("test", T0).await;
    let id = fwd(&h.said())[0].0.clone();
    h.core.on_worker_line(res(&format!("SENT {id}")), T0 + 1).await;
    h.core.on_worker_line(res(&reply_block("T-視窗甲", "好的（不需回覆）")), T0 + 2).await;
    assert!(posts(&h).is_empty());
    assert!(h.core.log.has("marked no-reply: not posted"));
    // 429：試一次，不重試
    let mut g = harness(&[("T-視窗甲", "idle")]).await;
    g.fr.st.lock().unwrap().room_post_status = 429;
    set_rooms(&g, vec![room(vec![rmsg(2, json!({"forMe": {"T-視窗甲": true}}))], json!([{"member": "T~T-視窗甲", "read_seq": 1}]))]);
    g.core.pull("test", T0).await;
    let id = fwd(&g.said())[0].0.clone();
    g.core.on_worker_line(res(&format!("SENT {id}")), T0 + 1).await;
    g.core.on_worker_line(res(&reply_block("T-視窗甲", "回覆內容")), T0 + 2).await;
    assert_eq!(posts(&g).len(), 1);
    assert!(g.core.log.has("rate-limited"));
    g.core.tick(T0 + 700_000).await;
    assert_eq!(posts(&g).len(), 1, "不會重試");
}

#[tokio::test]
async fn 群組_轉交失敗不回群組不留對應_worker_掛了游標不前進_逾時不寄通知() {
    let mut h = harness(&[("T-視窗甲", "idle")]).await;
    set_rooms(&h, vec![room(vec![rmsg(2, json!({"forMe": {"T-視窗甲": true}}))], json!([{"member": "T~T-視窗甲", "read_seq": 1}]))]);
    // worker 掛了：轉不出去，游標停在那則前面
    h.sink.down.store(true, Ordering::SeqCst);
    h.core.pull("test", T0).await;
    assert!(h.said().is_empty() && h.core.pending.is_empty());
    assert_eq!(cursor_file(&h)["R1|T~T-視窗甲"].as_u64(), Some(1), "游標不前進");
    assert!(h.core.log.has("cannot hand room=R1 #2"));
    // 好了：下一次拉會補轉
    h.sink.down.store(false, Ordering::SeqCst);
    h.core.pull("test", T0 + 1000).await;
    let id = fwd(&h.said())[0].0.clone();
    assert_eq!(cursor_file(&h)["R1|T~T-視窗甲"].as_u64(), Some(2));
    // FAIL：只記 log，不回群組、不寄信、不留對應
    h.core.on_worker_line(res(&format!("FAIL {id} 找不到視窗")), T0 + 2000).await;
    assert!(h.core.pending.is_empty() && posts(&h).is_empty() && h.fr.sent().is_empty() && h.fr.acked().is_empty());
    // 另一則：SENT 後一直沒人回 → 逾時直接清掉，不通知任何人
    set_rooms(&h, vec![room(vec![rmsg(2, json!({"forMe": {"T-視窗甲": true}})), rmsg(3, json!({"forMe": {"T-視窗甲": true}}))], json!([{"member": "T~T-視窗甲", "read_seq": 1}]))]);
    h.core.pull("test", T0 + 3000).await;
    let id3 = fwd(&h.said()).last().unwrap().0.clone();
    h.core.on_worker_line(res(&format!("SENT {id3}")), T0 + 3001).await;
    h.core.tick(T0 + 3001 + 601_000).await;
    assert!(h.core.pending.is_empty() && h.fr.sent().is_empty() && posts(&h).is_empty());
}

#[tokio::test]
async fn 群組_橋重啟後還在等的群組訊息回覆仍貼得回_群組項目寫進_pending_json() {
    let mut h = harness(&[("T-視窗甲", "idle")]).await;
    set_rooms(&h, vec![room(vec![rmsg(2, json!({"forMe": {"T-視窗甲": true}}))], json!([{"member": "T~T-視窗甲", "read_seq": 1}]))]);
    h.core.pull("test", T0).await;
    let id = fwd(&h.said())[0].0.clone();
    h.core.on_worker_line(res(&format!("SENT {id}")), T0 + 1).await;
    let saved: Value = serde_json::from_str(&std::fs::read_to_string(h.work.path().join("pending.json")).unwrap()).unwrap();
    assert_eq!(saved["pending"][0]["room"], json!({"id": "R1", "seq": 2, "window": "T-視窗甲"}), "與 Node 橋同格式");
    restart(&mut h, T0 + 5000).await;
    assert_eq!(h.core.pending.len(), 1);
    h.core.on_worker_line(res(&reply_block("T-視窗甲", "重啟後才回")), T0 + 6000).await;
    let p = posts(&h);
    assert_eq!((p.len(), p[0]["body"].as_str(), p[0]["from_agent"].as_str()), (1, Some("重啟後才回"), Some("T-視窗甲")));
}

#[tokio::test]
async fn 群組_節點本身的訊息_只交給設定的視窗_不在線就留著不前進_不丟給隨便一個視窗() {
    let mut h = harness(&[("T-乙", "idle")]).await; // 預設 T-甲 不在線
    set_rooms(&h, vec![room(vec![rmsg(2, json!({"forMe": {"": true}}))], json!([{"member": "T", "read_seq": 1}]))]);
    h.core.pull("test", T0).await;
    assert!(h.said().is_empty(), "T-乙 不是被指定的視窗，不能代收");
    assert_eq!(cursor_file(&h)["R1|T"].as_u64(), Some(1), "游標不前進");
    // 預設視窗在線：照舊交給它，附說明
    let mut g = harness(&[("T-甲", "idle"), ("T-乙", "idle")]).await;
    set_rooms(&g, vec![room(vec![rmsg(2, json!({"forMe": {"": true}}))], json!([{"member": "T", "read_seq": 1}]))]);
    g.core.pull("test", T0).await;
    let f = fwd(&g.said());
    assert_eq!(f[0].1, "T-甲");
    assert!(f[0].2.contains("[收發室] 這封信沒有指定收件視窗，依設定交給你（T-甲）處理。"), "有說明：{}", f[0].2);
}

// ================================================================================================
// 群組順位延遲（#230）：同時被叫醒的 AI 依順位延遲，延遲後重看群組再轉交
// ================================================================================================

fn wake(rank: u64, total: u64, before: &[&str]) -> Value {
    json!({"rank": rank, "total": total, "before": before})
}
fn held_file(h: &H) -> Value {
    serde_json::from_str(&std::fs::read_to_string(h.work.path().join("rooms-held.json")).unwrap_or_else(|_| "[]".into())).unwrap()
}
fn room_with(h: &H, msgs: Vec<Value>) {
    set_rooms(h, vec![room(msgs, json!([{"member": "T~T-視窗甲", "read_seq": 1}]))]);
}

#[tokio::test]
async fn 群組順位_第二順位先不轉交_到期才轉_期間不擋其他信_附上延遲期間新到的訊息() {
    let mut h = harness(&[("T-視窗甲", "idle")]).await;
    room_with(
        &h,
        vec![
            rmsg(2, json!({"forMe": {"T-視窗甲": true}, "wake": wake(2, 3, &["正見（阿明）"])})),
            rmsg(3, json!({"forMe": {"T-視窗甲": true}})), // 沒有順位資訊（舊後台／單獨叫醒）＝立即
        ],
    );
    h.core.pull("test", T0).await;
    let f = fwd(&h.said());
    assert_eq!(f.len(), 1, "只有 #3 立即轉交；#2 排隊等 60 秒，沒有擋住 #3");
    assert!(f[0].2.starts_with("[群組 專案群] trust=member from=W/W-政策 #3
"));
    assert_eq!(cursor_file(&h)["R1|T~T-視窗甲"].as_u64(), Some(3), "排隊的信先記起來，游標照常前進（不因延遲而重複轉交）");
    assert_eq!(held_file(&h).as_array().unwrap().len(), 1, "排隊的信寫進 rooms-held.json");
    h.core.tick(T0 + 59_000).await;
    assert_eq!(fwd(&h.said()).len(), 1, "59 秒還不能轉");
    // 延遲期間另一位夥伴已回答同一件事
    let answered = rmsg(4, json!({"from": "W~W-正見", "from_name": "正見", "from_label": "正見（阿明）", "body": "我已經回答了", "forMe": {}}));
    room_with(&h, vec![rmsg(2, json!({"forMe": {"T-視窗甲": true}, "wake": wake(2, 3, &["正見（阿明）"])})), rmsg(3, json!({})), answered]);
    h.core.tick(T0 + 60_000).await;
    let f = fwd(&h.said());
    assert_eq!(f.len(), 2);
    let late = &f[1].2;
    assert!(late.starts_with("[群組 專案群] trust=member from=W/W-政策 #2
"));
    assert!(late.contains("順位：你是第 2 順位（共 3 位被叫醒，前面順位：正見（阿明））"), "{late}");
    assert!(late.contains("---- 延遲期間新到的 2 則（舊→新）----
#3 政策：群組內文-3
#4 正見（阿明）：我已經回答了"), "{late}");
    // 重讀是從那則信之後起算、不帶 mark
    assert!(reads(&h).iter().any(|r| r["since"] == 1 && r["mark"].is_null() && r["as_agent"] == "T-視窗甲"));
    assert_eq!(held_file(&h).as_array().unwrap().len(), 0);
    let before = fwd(&h.said()).len();
    h.core.tick(T0 + 200_000).await;
    h.core.pull("test", T0 + 200_000).await;
    assert_eq!(fwd(&h.said()).len(), before, "不會重複轉交");
}

#[tokio::test]
async fn 群組順位_延遲是順位減一乘間隔_第一順位與沒有順位資訊不延遲_間隔設_0_關閉() {
    let mut h = harness(&[("T-視窗甲", "idle")]).await;
    room_with(&h, vec![rmsg(2, json!({"forMe": {"T-視窗甲": true}, "wake": wake(3, 3, &["甲", "乙"])})), rmsg(3, json!({"forMe": {"T-視窗甲": true}, "wake": wake(1, 3, &[])}))]);
    h.core.pull("test", T0).await;
    assert_eq!(fwd(&h.said()).len(), 1, "第一順位（#3）立即");
    h.core.tick(T0 + 119_000).await;
    assert_eq!(fwd(&h.said()).len(), 1, "第三順位 119 秒還不能轉");
    h.core.tick(T0 + 120_000).await;
    let f = fwd(&h.said());
    assert_eq!(f.len(), 2);
    assert!(f[1].2.contains("順位：你是第 3 順位（共 3 位被叫醒，前面順位：甲、乙）"));
    assert!(f[0].2.contains("順位：你是第 1 順位（共 3 位被叫醒）"));
    // 關閉（間隔 0）：第三順位也立即
    let mut g = harness(&[("T-視窗甲", "idle")]).await;
    g.core.cfg.room_stagger_ms = 0;
    room_with(&g, vec![rmsg(2, json!({"forMe": {"T-視窗甲": true}, "wake": wake(3, 3, &["甲", "乙"])}))]);
    g.core.pull("test", T0).await;
    assert_eq!(fwd(&g.said()).len(), 1);
    assert!(!g.work.path().join("rooms-held.json").exists());
    // 調整間隔（10 秒）：第二順位 10 秒到期
    let mut k = harness(&[("T-視窗甲", "idle")]).await;
    k.core.cfg.room_stagger_ms = 10_000;
    room_with(&k, vec![rmsg(2, json!({"forMe": {"T-視窗甲": true}, "wake": wake(2, 2, &["甲"])}))]);
    k.core.pull("test", T0).await;
    k.core.tick(T0 + 9_999).await;
    assert!(k.said().is_empty());
    k.core.tick(T0 + 10_000).await;
    assert_eq!(fwd(&k.said()).len(), 1);
}

#[tokio::test]
async fn 群組順位_橋重啟後排隊的信不遺失_到期只轉一次_已轉交的重啟後不再重複() {
    let mut h = harness(&[("T-視窗甲", "idle")]).await;
    room_with(&h, vec![rmsg(2, json!({"forMe": {"T-視窗甲": true}, "wake": wake(2, 2, &["甲"])}))]);
    h.core.pull("test", T0).await;
    assert!(h.said().is_empty());
    restart(&mut h, T0 + 10_000).await;
    h.core.tick(T0 + 30_000).await;
    assert!(h.said().is_empty(), "重啟後還沒到期");
    h.core.pull("test", T0 + 31_000).await; // 游標已前進，不會再排一次
    assert_eq!(held_file(&h).as_array().unwrap().len(), 1);
    h.core.tick(T0 + 60_000).await;
    let f = fwd(&h.said());
    assert_eq!(f.len(), 1);
    assert_eq!(f[0].0, room_uuid("R1", 2, "T~T-視窗甲"));
    h.core.on_worker_line(res(&format!("SENT {}", f[0].0)), T0 + 60_001).await;
    restart(&mut h, T0 + 70_000).await;
    h.core.tick(T0 + 200_000).await;
    h.core.pull("test", T0 + 200_000).await;
    assert_eq!(fwd(&h.said()).len(), 1, "重啟後不重複");
    // 到期前橋當機、到期時才起來：補轉一次
    let mut g = harness(&[("T-視窗甲", "idle")]).await;
    room_with(&g, vec![rmsg(2, json!({"forMe": {"T-視窗甲": true}, "wake": wake(2, 2, &["甲"])}))]);
    g.core.pull("test", T0).await;
    restart(&mut g, T0 + 500_000).await;
    g.core.tick(T0 + 500_000).await;
    assert_eq!(fwd(&g.said()).len(), 1);
}

#[tokio::test]
async fn 群組順位_到期時轉交失敗就留著稍後再試_不遺失() {
    let mut h = harness(&[("T-視窗甲", "idle")]).await;
    room_with(&h, vec![rmsg(2, json!({"forMe": {"T-視窗甲": true}, "wake": wake(2, 2, &["甲"])}))]);
    h.core.pull("test", T0).await;
    h.sink.down.store(true, Ordering::SeqCst);
    h.core.tick(T0 + 60_000).await;
    assert!(h.said().is_empty() && h.core.pending.is_empty());
    assert_eq!(held_file(&h).as_array().unwrap().len(), 1, "還留著");
    h.sink.down.store(false, Ordering::SeqCst);
    h.core.tick(T0 + 61_000).await;
    assert!(h.said().is_empty(), "失敗後退避一小段時間才再試");
    h.core.tick(T0 + 100_000).await;
    assert_eq!(fwd(&h.said()).len(), 1);
    assert_eq!(held_file(&h).as_array().unwrap().len(), 0);
}

// ================================================================================================
// 孤兒清理（真的程序）
// ================================================================================================

/// 讓測試執行檔扮成「上一個橋」：啟動一個孫子程序（模擬被硬砍後留下的 worker）、印出它的 pid、自己馬上結束。
#[test]
fn fake_orphan_parent() {
    if std::env::var("ASN_FAKE_ORPHAN").ok().as_deref() != Some("1") {
        return;
    }
    let mut c = if cfg!(windows) {
        let mut c = std::process::Command::new("cmd");
        c.no_window().args(["/c", "ping -n 60 127.0.0.1 >nul"]);
        c
    } else {
        let mut c = std::process::Command::new("sleep");
        c.no_window().arg("60");
        c
    };
    // 跟父程序的主控台脫鉤（CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP），父程序結束時它才不會跟著走。
    // 不用 DETACHED_PROCESS：cmd 沒有主控台時，它開的 ping 會自己要一個新主控台，
    // 預設終端機是 Windows Terminal 時就冒出分頁，孤兒被收掉後還停在錯誤 0x800700e8 等人按 Enter。
    #[cfg(windows)]
    std::os::windows::process::CommandExt::creation_flags(&mut c, 0x0800_0000 | 0x0000_0200);
    let child = c.stdin(std::process::Stdio::null()).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null()).spawn().unwrap();
    // 第一行孫子（孤兒）的 pid、第二行自己（上一個橋）的 pid：Linux 上孤兒會改掛 init，從程序表讀不到原本的父 pid
    std::fs::write(std::env::var("ASN_ORPHAN_OUT").unwrap(), format!("{}
{}", child.id(), std::process::id())).unwrap();
    // 不等孫子：自己結束，孫子就成了孤兒
}

#[test]
fn 孤兒清理_上一個橋被硬砍後留下的_worker_被收掉_別的程序不碰() {
    let work = tempfile::tempdir().unwrap();
    let out_file = work.path().join("orphan-pid.txt");
    let st = std::process::Command::new(std::env::current_exe().unwrap())
        .no_window()
        .args(["--exact", "bridge::tests::rooms_launch::fake_orphan_parent", "--nocapture"])
        .env("ASN_FAKE_ORPHAN", "1")
        .env("ASN_ORPHAN_OUT", &out_file)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .expect("啟動假的上一個橋");
    assert!(st.success());
    let written = std::fs::read_to_string(&out_file).expect("假的上一個橋寫出孤兒 pid");
    let mut it = written.lines().map(|l| l.trim().parse::<u32>().unwrap());
    let (orphan, dead_parent) = (it.next().unwrap(), it.next().unwrap());
    let table = super::super::orphans::process_table();
    assert!(table.contains_key(&orphan), "孤兒還活著");
    assert!(!table.contains_key(&dead_parent), "它的父程序（上一個橋）已經結束");
    std::fs::write(super::super::orphans::last_file(work.path()), dead_parent.to_string()).unwrap();
    std::fs::write(super::super::lock::mailbox_pid_file(work.path()), orphan.to_string()).unwrap();
    // 另一個無關的程序（同樣記不到 mailbox.pid）不能被碰：用自己開的一個子程序當對照，記下它的 pid
    let mut bystander = if cfg!(windows) {
        let mut c = std::process::Command::new("cmd");
        c.no_window().args(["/c", "ping -n 30 127.0.0.1 >nul"]);
        c
    } else {
        let mut c = std::process::Command::new("sleep");
        c.no_window().arg("30");
        c
    }
    .stdout(std::process::Stdio::null())
    .stderr(std::process::Stdio::null())
    .spawn()
    .unwrap();
    let logs = super::super::orphans::cleanup_and_mark(work.path(), std::process::id(), super::super::orphans::process_table, super::super::orphans::kill_tree);
    let mut gone = false;
    for _ in 0..50 {
        if !crate::heartbeat::pid_alive(orphan) {
            gone = true;
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
    let bystander_alive = bystander.try_wait().unwrap().is_none();
    // 收尾：只結束自己記下的程序
    let _ = bystander.kill();
    let _ = bystander.wait();
    if !gone {
        super::super::orphans::kill_tree(orphan);
    }
    assert!(gone, "孤兒 worker 被收掉。log={logs:?}");
    assert!(logs.iter().any(|l| l.contains(&format!("killed orphan pid={orphan}"))), "{logs:?}");
    assert!(bystander_alive, "沒有記在 mailbox.pid 的程序不碰");
    assert_eq!(std::fs::read_to_string(super::super::orphans::last_file(work.path())).unwrap(), std::process::id().to_string(), "記下自己的 pid");
}

// ================================================================================================
// 遠端開視窗
// ================================================================================================

/// 假的本機設定與假視窗程式：start 之後過 appear_after 毫秒，在 sessions 資料夾寫出新視窗的 session 檔
struct FakeEnv {
    sessions: PathBuf,
    allow: Vec<PathBuf>,
    max_per_hour: u32,
    appear: bool,
    appear_after_ms: u64,
    fail_start: bool,
    config_err: Mutex<Option<String>>,
    /// 設定裡多放 grok（背景）與 pi（視窗）
    extra_profiles: bool,
    /// 背景夥伴排進佇列後引擎的處理結果（Some(Ok)＝記進名冊、Some(Err)＝記失敗、None＝沒人處理）
    bg_outcome: Option<Result<(), String>>,
    /// 排佇列時就失敗（缺執行檔、未授權資料夾…）
    enq_err: Option<String>,
    enqueued: Mutex<Vec<(String, String, String)>>,
    started: Mutex<Vec<(String, String, String)>>,
    /// start 時實際會執行的命令（取自本機設定，展開 {name} 後）
    commands: Mutex<Vec<(String, Vec<String>)>>,
    /// 這台 pi 列得出來的（提供者, 模型）（D2 #422）
    pi_list: Vec<(String, String)>,
    /// start 收到的 pi 參數
    pi_args: Mutex<Vec<Vec<String>>>,
}
impl FakeEnv {
    fn new(sessions: &Path, allow: &Path) -> Arc<FakeEnv> {
        Arc::new(FakeEnv {
            sessions: sessions.to_path_buf(),
            allow: vec![canonical_launch_cwd(&allow.to_string_lossy()).unwrap()],
            max_per_hour: 6,
            appear: true,
            appear_after_ms: 0,
            fail_start: false,
            config_err: Mutex::new(None),
            extra_profiles: false,
            bg_outcome: None,
            enq_err: None,
            enqueued: Mutex::new(vec![]),
            started: Mutex::new(vec![]),
            commands: Mutex::new(vec![]),
            pi_list: vec![],
            pi_args: Mutex::new(vec![]),
        })
    }
    fn with(sessions: &Path, allow: &Path, f: impl FnOnce(&mut FakeEnv)) -> Arc<FakeEnv> {
        let mut e = Arc::try_unwrap(FakeEnv::new(sessions, allow)).ok().unwrap();
        f(&mut e);
        Arc::new(e)
    }
}
impl LaunchEnv for FakeEnv {
    fn config(&self, _fresh: bool) -> Result<LaunchConfig, String> {
        if let Some(e) = self.config_err.lock().unwrap().clone() {
            return Err(e);
        }
        let mut profiles = std::collections::HashMap::new();
        profiles.insert(
            "claude".to_string(),
            Profile { label: "Claude（互動視窗）".into(), command: "C:\\fake\\claude.exe".into(), args: vec!["-n".into(), "{name}".into(), "--remote-control".into(), "{name}".into()], engine: "claude".into(), mode: LaunchMode::Window, disabled: false, disabled_reason: String::new() },
        );
        if self.extra_profiles {
            profiles.insert("grok".to_string(), Profile { label: "Grok（背景運行、內建通道）".into(), command: "C:\\fake\\grok.exe".into(), args: vec!["agent".into(), "stdio".into()], engine: "acp".into(), mode: LaunchMode::Background, disabled: false, disabled_reason: String::new() });
            profiles.insert("pi".to_string(), Profile { label: "pi（互動視窗）".into(), command: "C:\\fake\\pi.cmd".into(), args: vec![], engine: "pi".into(), mode: LaunchMode::Window, disabled: false, disabled_reason: String::new() });
        }
        Ok(LaunchConfig { profiles, cwd_allow: self.allow.clone(), max_per_hour: self.max_per_hour })
    }
    fn enqueue_background(&self, _config: &LaunchConfig, profile: &str, name: &str, cwd: &str, work_dir: &Path) -> Result<(), String> {
        if let Some(e) = &self.enq_err {
            return Err(e.clone());
        }
        self.enqueued.lock().unwrap().push((profile.into(), name.into(), cwd.into()));
        if let Some(o) = self.bg_outcome.clone() {
            let (wd, name, profile, cwd) = (work_dir.to_path_buf(), name.to_string(), profile.to_string(), cwd.to_string());
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_millis(80));
                match o {
                    Ok(()) => crate::bridge::engines::partner_queue::remember(&wd.join(crate::bridge::engines::partner_queue::PARTNERS_FILE), &name, &profile, &cwd),
                    Err(e) => crate::bridge::engines::partner_queue::record_failure(&wd, &name, &profile, &e),
                }
            });
        }
        Ok(())
    }
    fn pi_listed(&self, provider: &str, model: &str) -> bool {
        self.pi_list.iter().any(|(p, m)| p == provider && m == model)
    }
    fn start(&self, config: &LaunchConfig, profile: &str, name: &str, cwd: &str, pi_args: &[String]) -> Result<u32, String> {
        self.pi_args.lock().unwrap().push(pi_args.to_vec());
        let (cmd, args, _) = build_spawn_spec(config, &LaunchReq { profile, name, cwd: cwd.to_string() })?;
        self.commands.lock().unwrap().push((cmd, args));
        self.started.lock().unwrap().push((profile.into(), name.into(), cwd.into()));
        if self.fail_start {
            return Err("找不到執行檔".into());
        }
        if self.appear {
            let (dir, name, ms) = (self.sessions.clone(), name.to_string(), self.appear_after_ms);
            let n = self.started.lock().unwrap().len() as u32;
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_millis(ms));
                put_session(&dir, 6000 + n, &name, "idle", 500);
            });
        }
        Ok(4242)
    }
}

struct LH {
    h: H,
    env: Arc<FakeEnv>,
    rx: UnboundedReceiver<Launched>,
    proj: tempfile::TempDir,
}

async fn lharness(make: impl FnOnce(&Path, &Path) -> Arc<FakeEnv>, timing: (u64, u64, u64)) -> LH {
    let mut h = harness(&[("T-甲", "idle")]).await;
    let proj = tempfile::tempdir().unwrap();
    let env = make(h.sessions.path(), proj.path());
    let relay = Arc::new(Relay::new(h.fr.url.clone(), "fake-test-key".into(), "T".into(), "T-ASN".into()));
    let sessions = h.sessions.path().to_path_buf();
    let names: Arc<dyn Fn() -> Option<Vec<String>> + Send + Sync> = Arc::new(move || Some(super::super::roster::read_sessions(&sessions, |p| p < 90_000, 0, "T-收發室")?.into_iter().map(|w| w.name).collect()));
    let (l, rx) = Launcher::new_with(relay, h.core.log.clone(), h.work.path().to_path_buf(), env.clone(), names, timing);
    h.core.set_launcher(l);
    LH { h, env, rx, proj }
}
fn lreq(n: u32, name: &str, cwd: &Path, extra: Value) -> Value {
    let mut v = json!({"id": uid(n), "requested_by": "PC1", "profile": "claude", "name": name, "cwd": cwd.display().to_string(), "first_message": null});
    for (k, x) in extra.as_object().unwrap() {
        v[k] = x.clone();
    }
    v
}
fn results(h: &H) -> Vec<Value> {
    h.fr.st.lock().unwrap().launch_results.clone()
}
async fn wait_until(f: impl Fn() -> bool) {
    let t = std::time::Instant::now();
    while !f() && t.elapsed() < std::time::Duration::from_secs(10) {
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
    assert!(f(), "條件在 10 秒內沒達成");
}

#[tokio::test]
async fn 遠端開視窗_取走_開視窗_出現在名單_回報_ok_名單附摘要_第一句話經收發室送進新視窗() {
    let mut l = lharness(|s, p| FakeEnv::new(s, p), (30_000, 60_000, 20)).await;
    // 遠端請求夾帶 command／args／env 欄位：一律不採用，開出來的命令只來自本機設定
    let cwd = l.proj.path().to_path_buf();
    l.h.fr.st.lock().unwrap().launches.push(lreq(7, "T-英雄-2", &cwd, json!({"first_message": "先讀交接檔", "command": "calc.exe", "args": ["/c", "evil"], "env": {"X": "1"}})));
    l.h.core.pull("bell", T0).await;
    wait_until(|| !results(&l.h).is_empty()).await;
    assert_eq!(results(&l.h), vec![json!({"id": uid(7), "status": "ok", "detail": "T-英雄-2 已開啟"})]);
    let started = l.env.started.lock().unwrap().clone();
    assert_eq!(started.len(), 1);
    assert_eq!((started[0].0.as_str(), started[0].1.as_str()), ("claude", "T-英雄-2"));
    assert_eq!(l.env.commands.lock().unwrap()[0], ("C:\\fake\\claude.exe".to_string(), ["-n", "T-英雄-2", "--remote-control", "T-英雄-2"].map(String::from).to_vec()), "命令只來自本機設定");
    // 視窗出現後：事件交回核心 → 刷新名單 → 第一句話當成 owner 來信送進新視窗
    let ev = tokio::time::timeout(std::time::Duration::from_secs(5), l.rx.recv()).await.unwrap().unwrap();
    assert_eq!((ev.id.as_str(), ev.name.as_str(), ev.requested_by.as_str(), ev.first_message.as_deref()), (uid(7).as_str(), "T-英雄-2", "PC1", Some("先讀交接檔")));
    l.h.core.on_launched(ev, T0 + 100).await;
    let f = fwd(&l.h.said());
    assert_eq!(f.len(), 1);
    assert_eq!((f[0].0.as_str(), f[0].1.as_str()), (uid(7).as_str(), "T-英雄-2"));
    assert!(f[0].2.starts_with("[RELAY 來信] trust=owner from=PC1/ to=T-英雄-2 id="), "{}", f[0].2);
    assert!(f[0].2.contains("先讀交接檔"));
    // 名單：新視窗在上面；launcher 摘要有 profile／cwd／上限，沒有指令
    let rosters = l.h.fr.rosters();
    let last = rosters.last().unwrap();
    assert!(last["agents"].as_array().unwrap().iter().any(|a| a["name"] == "T-英雄-2"), "新視窗要出現在名單上");
    let cwd_norm = crate::launch::cwds::norm_path(&canonical_launch_cwd(&cwd.to_string_lossy()).unwrap().to_string_lossy()).unwrap();
    assert_eq!(last["launcher"], json!({"profiles": [{"id": "claude", "label": "Claude（互動視窗）", "engine": "claude", "mode": "window"}], "cwd_allow": [cwd_norm], "max_per_hour": 6}));
    assert!(!rosters.iter().any(|r| r.to_string().contains("fake\\\\claude") || r.to_string().contains("remote-control")), "名單不含指令");
    // 紀錄
    let log = std::fs::read_to_string(l.h.work.path().join("launch.log")).unwrap();
    let st: Vec<String> = log.lines().map(|x| serde_json::from_str::<Value>(x).unwrap()["status"].as_str().unwrap().to_string()).collect();
    assert_eq!(st, vec!["spawned", "ok"]);
}

#[tokio::test]
async fn 遠端開視窗_驗不過就不開_cwd不在白名單_重名_沒有這個設定_名字格式_同一筆只處理一次() {
    let mut l = lharness(|s, p| FakeEnv::new(s, p), (30_000, 60_000, 20)).await;
    let cwd = l.proj.path().to_path_buf();
    let outside = tempfile::tempdir().unwrap();
    {
        let mut st = l.h.fr.st.lock().unwrap();
        st.launches.push(lreq(1, "T-新1", outside.path(), json!({})));
        st.launches.push(lreq(2, "t-甲", &cwd, json!({})));                    // 與現有視窗 T-甲 重名（不分大小寫）
        st.launches.push(lreq(3, "T-新3", &cwd, json!({"profile": "evil"})));
        st.launches.push(lreq(3, "T-新3", &cwd, json!({"profile": "evil"})));  // 同一筆 id 再來一次
        st.launches.push(lreq(4, "a&calc", &cwd, json!({})));
        st.launches.push(lreq(5, "-rf", &cwd, json!({})));
        st.launches.push(lreq(6, "T-新6", &cwd.join(".."), json!({})));        // 想用 .. 跳出白名單
    }
    l.h.core.pull("bell", T0).await;
    let r = results(&l.h);
    assert_eq!(r.len(), 7 - 1, "每筆 id 只回報一次：{r:?}");
    assert!(r.iter().all(|x| x["status"] == "failed"));
    let detail = |n: u32| r.iter().find(|x| x["id"] == uid(n).as_str()).unwrap()["detail"].as_str().unwrap().to_string();
    assert!(detail(1).contains("不在允許清單"));
    assert!(detail(2).contains("已經有叫「t-甲」的視窗"));
    assert!(detail(3).contains("沒有這個啟動設定"));
    assert!(detail(4).contains("視窗名格式不對") && detail(5).contains("視窗名格式不對"));
    assert!(detail(6).contains("不在允許清單"));
    assert!(l.env.started.lock().unwrap().is_empty(), "一個都不能開");
    assert!(!l.h.work.path().join("launch-history.json").exists(), "沒開就不計入每小時次數");
}

#[tokio::test]
async fn 遠端開視窗_開不起來回報_failed_本機沒有啟動設定回報原因_名單的_launcher_是_null() {
    let mut l = lharness(|s, p| FakeEnv::with(s, p, |e| e.fail_start = true), (30_000, 60_000, 20)).await;
    let cwd = l.proj.path().to_path_buf();
    l.h.fr.st.lock().unwrap().launches.push(lreq(1, "T-新1", &cwd, json!({})));
    l.h.core.pull("bell", T0).await;
    assert_eq!(results(&l.h), vec![json!({"id": uid(1), "status": "failed", "detail": "開不起來：找不到執行檔"})]);
    // 沒有可用設定（沒同意、沒有 launcher.json）
    *l.env.config_err.lock().unwrap() = Some(launcher::NO_CONFIG.into());
    l.h.fr.st.lock().unwrap().launches.push(lreq(2, "T-新2", &cwd, json!({})));
    l.h.core.pull("bell", T0 + 1).await;
    assert_eq!(results(&l.h)[1], json!({"id": uid(2), "status": "failed", "detail": launcher::NO_CONFIG}));
    l.h.core.refresh_roster(T0 + 2).await;
    assert_eq!(l.h.fr.rosters().last().unwrap()["launcher"], Value::Null, "沒有設定就送 null，仲介會清掉，別台不顯示開新夥伴");
}

#[tokio::test]
async fn 遠端開視窗_太久沒出現先回_unconfirmed_之後出現再補_ok() {
    let mut l = lharness(|s, p| FakeEnv::with(s, p, |e| e.appear_after_ms = 400), (150, 5_000, 20)).await;
    let cwd = l.proj.path().to_path_buf();
    l.h.fr.st.lock().unwrap().launches.push(lreq(1, "T-新1", &cwd, json!({"first_message": "嗨"})));
    l.h.core.pull("bell", T0).await;
    wait_until(|| results(&l.h).len() >= 2).await;
    let r = results(&l.h);
    assert_eq!((r[0]["status"].as_str(), r[0]["detail"].as_str()), (Some("unconfirmed"), Some(launcher::TRUST_HINT)));
    assert_eq!(r[1]["status"], "ok");
    assert_eq!(l.rx.recv().await.unwrap().name, "T-新1");
    // 一直沒出現：放棄，不回 ok
    let mut g = lharness(|s, p| FakeEnv::with(s, p, |e| e.appear = false), (50, 300, 20)).await;
    let cwd = g.proj.path().to_path_buf();
    g.h.fr.st.lock().unwrap().launches.push(lreq(1, "T-新1", &cwd, json!({})));
    g.h.core.pull("bell", T0).await;
    tokio::time::sleep(std::time::Duration::from_millis(600)).await;
    assert_eq!(results(&g.h).iter().map(|x| x["status"].as_str().unwrap()).collect::<Vec<_>>(), vec!["unconfirmed"]);
    assert!(g.h.core.log.has("gave-up") || std::fs::read_to_string(g.h.work.path().join("launch.log")).unwrap().contains("gave-up"));
}

#[tokio::test]
async fn 遠端開視窗_每小時上限_存在_launch_history_json_重啟也算() {
    let mut l = lharness(|s, p| FakeEnv::with(s, p, |e| e.max_per_hour = 2), (30_000, 60_000, 20)).await;
    let cwd = l.proj.path().to_path_buf();
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as u64;
    std::fs::write(l.h.work.path().join("launch-history.json"), json!([now - 1000, now - 4_000_000]).to_string()).unwrap();
    {
        let mut st = l.h.fr.st.lock().unwrap();
        st.launches.push(lreq(1, "T-新1", &cwd, json!({})));
        st.launches.push(lreq(2, "T-新2", &cwd, json!({})));
    }
    l.h.core.pull("bell", T0).await;
    wait_until(|| results(&l.h).len() >= 2).await;
    let r = results(&l.h);
    let mut st: Vec<&str> = r.iter().map(|x| x["status"].as_str().unwrap()).collect();
    st.sort();
    assert_eq!(st, vec!["failed", "ok"], "一小時前的不算，剩一個名額");
    assert!(r.iter().find(|x| x["status"] == "failed").unwrap()["detail"].as_str().unwrap().contains("超過上限"));
    assert_eq!(l.env.started.lock().unwrap().len(), 1);
    let h2: Vec<u64> = serde_json::from_str(&std::fs::read_to_string(l.h.work.path().join("launch-history.json")).unwrap()).unwrap();
    assert_eq!(h2.len(), 2, "一小時前的被清掉，新開的記上去");
}

#[tokio::test]
async fn 遠端開視窗_兩個同名請求同時在等時第二個算重名() {
    let mut l = lharness(|s, p| FakeEnv::with(s, p, |e| e.appear = false), (30_000, 60_000, 20)).await;
    let cwd = l.proj.path().to_path_buf();
    {
        let mut st = l.h.fr.st.lock().unwrap();
        st.launches.push(lreq(1, "T-同名", &cwd, json!({})));
        st.launches.push(lreq(2, "t-同名", &cwd, json!({})));
    }
    l.h.core.pull("bell", T0).await;
    let r = results(&l.h);
    assert_eq!(r.len(), 1);
    assert!(r[0]["detail"].as_str().unwrap().contains("已經有叫"));
    assert_eq!(l.env.started.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn 遠端開背景夥伴_grok_排佇列_等引擎記進名冊才回_ok_不走開視窗_第一句話照送() {
    let mut l = lharness(|s, p| FakeEnv::with(s, p, |e| { e.extra_profiles = true; e.bg_outcome = Some(Ok(())); }), (30_000, 60_000, 20)).await;
    let cwd = l.proj.path().to_path_buf();
    l.h.fr.st.lock().unwrap().launches.push(lreq(1, "小格", &cwd, json!({"profile": "grok", "first_message": "你好", "command": "calc.exe"})));
    l.h.core.pull("bell", T0).await;
    assert!(results(&l.h).is_empty(), "排進佇列只是開始，引擎還沒處理完不能回報成功");
    wait_until(|| !results(&l.h).is_empty()).await;
    assert_eq!(results(&l.h), vec![json!({"id": uid(1), "status": "ok", "detail": "小格 已開啟"})]);
    assert_eq!(l.env.enqueued.lock().unwrap().len(), 1);
    let q = l.env.enqueued.lock().unwrap().clone();
    assert_eq!((q[0].0.as_str(), q[0].1.as_str()), ("grok", "小格"));
    assert!(l.env.started.lock().unwrap().is_empty(), "背景夥伴不開視窗");
    let ev = tokio::time::timeout(std::time::Duration::from_secs(5), l.rx.recv()).await.unwrap().unwrap();
    assert_eq!((ev.name.as_str(), ev.first_message.as_deref()), ("小格", Some("你好")));
}

#[tokio::test]
async fn 遠端開背景夥伴_失敗回中文原因_排佇列就失敗_引擎消化失敗_都不算成功() {
    // 排佇列前就驗不過（缺執行檔）
    let mut l = lharness(|s, p| FakeEnv::with(s, p, |e| { e.extra_profiles = true; e.enq_err = Some("這台電腦找不到「grok」的執行檔（grok.exe），請先安裝後再試".into()); }), (30_000, 60_000, 20)).await;
    let cwd = l.proj.path().to_path_buf();
    l.h.fr.st.lock().unwrap().launches.push(lreq(1, "小格", &cwd, json!({"profile": "grok"})));
    l.h.core.pull("bell", T0).await;
    assert_eq!(results(&l.h), vec![json!({"id": uid(1), "status": "failed", "detail": "開不起來：這台電腦找不到「grok」的執行檔（grok.exe），請先安裝後再試"})]);
    assert!(l.rx.try_recv().is_err());
    // 引擎消化時失敗（名字重複）
    let mut g = lharness(|s, p| FakeEnv::with(s, p, |e| { e.extra_profiles = true; e.bg_outcome = Some(Err("已經有叫「小格」的工作者".into())); }), (30_000, 60_000, 20)).await;
    let cwd = g.proj.path().to_path_buf();
    g.h.fr.st.lock().unwrap().launches.push(lreq(1, "小格", &cwd, json!({"profile": "grok"})));
    g.h.core.pull("bell", T0).await;
    wait_until(|| !results(&g.h).is_empty()).await;
    assert_eq!(results(&g.h), vec![json!({"id": uid(1), "status": "failed", "detail": "開不起來：已經有叫「小格」的工作者"})]);
    assert!(g.rx.try_recv().is_err(), "失敗不通知核心送第一句話");
}

#[tokio::test]
async fn 遠端開背景夥伴_引擎一直沒處理先回_unconfirmed_並講原因() {
    let mut l = lharness(|s, p| FakeEnv::with(s, p, |e| e.extra_profiles = true), (100, 400, 20)).await;
    let cwd = l.proj.path().to_path_buf();
    l.h.fr.st.lock().unwrap().launches.push(lreq(1, "小格", &cwd, json!({"profile": "grok"})));
    l.h.core.pull("bell", T0).await;
    tokio::time::sleep(std::time::Duration::from_millis(700)).await;
    let r = results(&l.h);
    assert_eq!(r.iter().map(|x| x["status"].as_str().unwrap()).collect::<Vec<_>>(), vec!["unconfirmed"]);
    assert_eq!(r[0]["detail"], launcher::BG_HINT);
}

#[tokio::test]
async fn 遠端開_pi_走視窗啟動_不排佇列_沒出現時提示講_pi_的狀況() {
    let mut l = lharness(|s, p| FakeEnv::with(s, p, |e| e.extra_profiles = true), (30_000, 60_000, 20)).await;
    let cwd = l.proj.path().to_path_buf();
    l.h.fr.st.lock().unwrap().launches.push(lreq(1, "小皮", &cwd, json!({"profile": "pi"})));
    l.h.core.pull("bell", T0).await;
    wait_until(|| !results(&l.h).is_empty()).await;
    assert_eq!(results(&l.h)[0]["status"], "ok");
    assert_eq!(l.env.started.lock().unwrap()[0].0, "pi");
    assert!(l.env.enqueued.lock().unwrap().is_empty());
    let _ = l.rx.recv().await;
    let mut g = lharness(|s, p| FakeEnv::with(s, p, |e| { e.extra_profiles = true; e.appear = false; }), (50, 300, 20)).await;
    let cwd = g.proj.path().to_path_buf();
    g.h.fr.st.lock().unwrap().launches.push(lreq(1, "小皮", &cwd, json!({"profile": "pi"})));
    g.h.core.pull("bell", T0).await;
    tokio::time::sleep(std::time::Duration::from_millis(250)).await;
    assert_eq!(results(&g.h)[0]["detail"], launcher::PI_HINT);
}

#[tokio::test]
async fn 遠端開_pi_帶提供者與模型_只收這台列得出來的_舊版沒帶照舊() {
    let listed = |e: &mut FakeEnv| {
        e.extra_profiles = true;
        e.pi_list = vec![("minimax".into(), "MiniMax-M3.1-Flash".into())];
    };
    let mut l = lharness(|s, p| FakeEnv::with(s, p, listed), (30_000, 60_000, 20)).await;
    let cwd = l.proj.path().to_path_buf();
    l.h.fr.st.lock().unwrap().launches.push(lreq(1, "小皮", &cwd, json!({"profile": "pi", "pi_provider": "minimax", "pi_model": "MiniMax-M3.1-Flash"})));
    l.h.core.pull("bell", T0).await;
    wait_until(|| !results(&l.h).is_empty()).await;
    assert_eq!(results(&l.h)[0]["status"], "ok");
    assert_eq!(l.env.pi_args.lock().unwrap()[0], vec!["--provider", "minimax", "--model", "MiniMax-M3.1-Flash"]);
    let _ = l.rx.recv().await;

    // 舊版手機沒帶（或帶 null）：不加參數，用 pi 自己的預設
    let mut o = lharness(|s, p| FakeEnv::with(s, p, listed), (30_000, 60_000, 20)).await;
    let cwd = o.proj.path().to_path_buf();
    o.h.fr.st.lock().unwrap().launches.push(lreq(1, "小皮", &cwd, json!({"profile": "pi", "pi_provider": null, "pi_model": null})));
    o.h.core.pull("bell", T0).await;
    wait_until(|| !results(&o.h).is_empty()).await;
    assert_eq!(results(&o.h)[0]["status"], "ok");
    assert!(o.env.pi_args.lock().unwrap()[0].is_empty());
    let _ = o.rx.recv().await;

    // 清單外的、不是 pi 的啟動設定、只給一個：拒絕並說明，不退回預設模型、不開視窗
    for (extra, want) in [
        (json!({"profile": "pi", "pi_provider": "minimax", "pi_model": "Other-Model"}), "這台電腦的 pi 沒有"),
        (json!({"profile": "pi", "pi_provider": "openai", "pi_model": "MiniMax-M3.1-Flash"}), "這台電腦的 pi 沒有"),
        (json!({"profile": "claude", "pi_provider": "minimax", "pi_model": "MiniMax-M3.1-Flash"}), "只有經 pi 開的夥伴"),
        (json!({"profile": "pi", "pi_provider": "minimax"}), "要一起給"),
    ] {
        let mut b = lharness(|s, p| FakeEnv::with(s, p, listed), (30_000, 60_000, 20)).await;
        let cwd = b.proj.path().to_path_buf();
        b.h.fr.st.lock().unwrap().launches.push(lreq(1, "小皮", &cwd, extra.clone()));
        b.h.core.pull("bell", T0).await;
        wait_until(|| !results(&b.h).is_empty()).await;
        let r = &results(&b.h)[0];
        assert_eq!(r["status"], "failed", "{extra}");
        assert!(r["detail"].as_str().unwrap().contains(want), "{extra} → {}", r["detail"]);
        assert!(b.env.started.lock().unwrap().is_empty(), "{extra}");
    }
}

#[test]
fn 遠端_pi_參數_純函式() {
    let yes = |_: &str, _: &str| true;
    let no = |_: &str, _: &str| false;
    assert_eq!(launcher::remote_pi_args(&json!({}), true, &no), Ok(vec![]), "沒帶＝空，不查清單");
    assert_eq!(launcher::remote_pi_args(&json!({"pi_provider": " ", "pi_model": ""}), false, &no), Ok(vec![]));
    assert_eq!(launcher::remote_pi_args(&json!({"pi_provider": "a", "pi_model": "b"}), true, &yes).unwrap(), vec!["--provider", "a", "--model", "b"]);
    assert!(launcher::remote_pi_args(&json!({"pi_provider": "-x", "pi_model": "b"}), true, &yes).is_err(), "旗標開頭的不收");
    assert!(launcher::remote_pi_args(&json!({"pi_provider": "a", "pi_model": "b"}), true, &no).is_err());
}

#[tokio::test]
async fn 遠端開_codex_與沒列在清單的設定_一律驗不過() {
    let mut l = lharness(|s, p| FakeEnv::with(s, p, |e| e.extra_profiles = true), (30_000, 60_000, 20)).await;
    let cwd = l.proj.path().to_path_buf();
    l.h.fr.st.lock().unwrap().launches.push(lreq(1, "小碼", &cwd, json!({"profile": "codex"})));
    l.h.core.pull("bell", T0).await;
    assert!(results(&l.h)[0]["detail"].as_str().unwrap().contains("沒有這個啟動設定"));
    assert!(l.env.started.lock().unwrap().is_empty() && l.env.enqueued.lock().unwrap().is_empty());
}

/// 守門：遠端 start 的 pi 要走擴充載入（launch/pi.rs），不能當一般視窗直接開（會開出不收信的 pi）
#[test]
fn 守門_遠端啟動的_pi_走_plan() {
    let src = include_str!("../../launch/local.rs");
    let f = src.split("pub fn start_remote_window").nth(1).unwrap().split("fn maybe_trust_claude_cwd").next().unwrap();
    assert!(f.contains("prof.engine == \"pi\"") && f.contains("super::pi::plan("), "start_remote_window 要有 pi 分支");
    let l = include_str!("../launcher.rs").split("#[cfg(test)]").next().unwrap().to_string();
    assert!(l.contains("queue_background") && l.contains("pq::build_cfg(env, &req, work_dir)"), "背景夥伴要先用消化端同一套規則驗");
}

/// 守門：遠端請求裡只有 profile／name／cwd（與 first_message 當內容、id 當編號）會被讀；指令、參數、環境一律不從請求拿
#[test]
fn 守門_啟動請求的處理程式不讀任何指令類欄位() {
    let src = include_str!("../launcher.rs");
    let body = src.split("#[cfg(test)]").next().unwrap();
    for field in ["\"command\"", "\"args\"", "\"env\"", "\"cmd\"", "\"script\"", "\"shell\""] {
        for line in body.lines().filter(|l| l.contains(".get(") && !l.trim_start().starts_with("//")) {
            assert!(!line.contains(field), "launcher.rs 不應該從請求讀 {field}：{line}");
        }
    }
    // 開視窗只收這四個值，加上經 pi 的 --provider／--model（只由 remote_pi_args 組：格式驗過、而且這台 pi 列得出來）
    assert!(body.contains("env.start(&cfg2, &p2, &n2, &c2, &pi_args)"));
    assert!(body.contains("me0.remote_pi_args(&l0, is_pi)") && body.contains("crate::launch::pi_models::model_args(&p, &m)?"));
}

// ---- 真的開一個（隱藏的）視窗：假視窗程式是測試執行檔自己 ----------------------------------------------------

/// 假視窗程式：被 `--exact bridge::tests::rooms_launch::fake_window --nocapture asn-fake-window-marker <名字> <sessions 資料夾> <記錄檔>` 啟動時，
/// 把自己登記成一個互動式 session、記下收到的參數與工作資料夾，停幾秒後結束。命令列沒有那個標記（平常跑測試）什麼都不做。
#[test]
fn fake_window() {
    let args: Vec<String> = std::env::args().collect();
    let Some(m) = args.iter().position(|a| a == "asn-fake-window-marker") else { return };
    let (name, sessions, record) = (args[m + 1].clone(), args[m + 2].clone(), args[m + 3].clone());
    let cwd = std::env::current_dir().unwrap().display().to_string();
    std::fs::write(&record, json!({"name": name, "cwd": cwd, "leaked_claude_env": std::env::vars().filter(|(k, _)| k.to_uppercase().starts_with("CLAUDE")).count()}).to_string()).unwrap();
    put_session(Path::new(&sessions), std::process::id(), &name, "idle", 700);
    std::thread::sleep(std::time::Duration::from_secs(4));
}

/// 真的走 Start-Process／隱藏視窗那條路（Windows）：確認參數、工作資料夾都對，視窗出現在名單後回報 ok。結束時只關自己記下的那一棵程序。
#[cfg(windows)]
#[tokio::test]
async fn 遠端開視窗_真的開一個隱藏視窗_假視窗程式登記成_session_後回報_ok() {
    struct RealEnv {
        cfg: LaunchConfig,
        pids: Mutex<Vec<u32>>,
    }
    impl LaunchEnv for RealEnv {
        fn config(&self, _f: bool) -> Result<LaunchConfig, String> {
            Ok(self.cfg.clone())
        }
        fn start(&self, config: &LaunchConfig, profile: &str, name: &str, cwd: &str, pi_args: &[String]) -> Result<u32, String> {
            let pid = crate::launch::local::start_remote_window(config, profile, name, cwd, true, pi_args)?;
            self.pids.lock().unwrap().push(pid);
            Ok(pid)
        }
    }
    let mut h = harness(&[]).await;
    let proj = tempfile::tempdir().unwrap();
    let record = h.work.path().join("window-record.json");
    let exe = std::env::current_exe().unwrap().display().to_string();
    let mut profiles = std::collections::HashMap::new();
    profiles.insert(
        "claude".to_string(),
        Profile {
            label: "假".into(),
            command: exe,
            // engine 不是 claude：不會去改真的 ~/.claude.json
            engine: "fake".into(),
            args: ["--exact", "bridge::tests::rooms_launch::fake_window", "--nocapture", "asn-fake-window-marker", "{name}"].iter().map(|s| s.to_string()).chain([h.sessions.path().display().to_string(), record.display().to_string()]).collect(),
            mode: LaunchMode::Window,
            disabled: false,
            disabled_reason: String::new(),
        },
    );
    let env = Arc::new(RealEnv { cfg: LaunchConfig { profiles, cwd_allow: vec![canonical_launch_cwd(&proj.path().to_string_lossy()).unwrap()], max_per_hour: 3 }, pids: Mutex::new(vec![]) });
    let relay = Arc::new(Relay::new(h.fr.url.clone(), "fake-test-key".into(), "T".into(), "T-ASN".into()));
    let sessions = h.sessions.path().to_path_buf();
    let names: Arc<dyn Fn() -> Option<Vec<String>> + Send + Sync> = Arc::new(move || Some(super::super::roster::read_sessions(&sessions, crate::heartbeat::pid_alive, 0, "T-收發室")?.into_iter().map(|w| w.name).collect()));
    let (l, mut rx) = Launcher::new_with(relay, h.core.log.clone(), h.work.path().to_path_buf(), env.clone(), names, (60_000, 90_000, 100));
    h.core.set_launcher(l);
    h.fr.st.lock().unwrap().launches.push(lreq(1, "T-真窗", proj.path(), json!({"first_message": "你好"})));
    h.core.pull("bell", T0).await;
    let ev = tokio::time::timeout(std::time::Duration::from_secs(60), rx.recv()).await;
    // 先把自己開的視窗收掉（只關記下的 PID），再檢查結果
    let pids = env.pids.lock().unwrap().clone();
    let rec = std::fs::read_to_string(&record).unwrap_or_default();
    for p in &pids {
        super::super::orphans::kill_tree(*p);
    }
    let ev = ev.expect("60 秒內視窗出現在名單上").unwrap();
    assert_eq!((ev.name.as_str(), ev.first_message.as_deref()), ("T-真窗", Some("你好")));
    assert_eq!(results(&h), vec![json!({"id": uid(1), "status": "ok", "detail": "T-真窗 已開啟"})]);
    let rec: Value = serde_json::from_str(&rec).unwrap();
    assert_eq!(rec["name"], "T-真窗");
    let want = crate::launch::cwds::norm_path(&canonical_launch_cwd(&proj.path().to_string_lossy()).unwrap().to_string_lossy()).unwrap();
    assert_eq!(rec["cwd"].as_str().unwrap().to_lowercase(), want.to_lowercase(), "視窗在指定的工作資料夾開");
}

// ================================================================================================
// 設定與舊橋退出後接手
// ================================================================================================

#[test]
fn 設定_允許遠端開視窗預設關_來回一致() {
    let d = tempfile::tempdir().unwrap();
    assert!(!super::super::read_settings(d.path()).allow_remote_launch);
    super::super::write_settings(d.path(), super::super::BridgeSettings { enabled: true, allow_remote_launch: true, ..Default::default() }).unwrap();
    let s = super::super::read_settings(d.path());
    assert!(s.enabled && s.allow_remote_launch && !s.allow_takeover);
    // 舊版寫的檔（沒有這個欄位）當作關
    std::fs::write(super::super::settings_path(d.path()), r#"{"enabled":true,"allow_takeover":false}"#).unwrap();
    assert!(!super::super::read_settings(d.path()).allow_remote_launch);
}

#[test]
fn 管理器_舊橋退出後自動接手_設定關著或舊橋還在就不動() {
    let fr = FakeRelay::start();
    let data = tempfile::tempdir().unwrap();
    let work = tempfile::tempdir().unwrap();
    let sessions = tempfile::tempdir().unwrap();
    let record = work.path().join("record.jsonl");
    let relay = Arc::new(Relay::new(fr.url.clone(), "fake-test-key".into(), "T".into(), "T-ASN".into()));
    let (sess, rec) = (sessions.path().to_path_buf(), record.clone());
    let m = super::super::Manager::new(Some(relay), None, "T".into(), work.path().to_path_buf(), data.path().to_path_buf()).with_test_hooks(
        Some(FakeEnv::new(sessions.path(), data.path())),
        Box::new(move |c| {
            // 假 claude（測試執行檔自己），不碰真的 claude
            c.claude_bin = std::env::current_exe().unwrap().display().to_string();
            c.claude_pre = ["--exact", "bridge::tests::fake_claude_child", "--nocapture", "--"].iter().map(|s| s.to_string()).collect();
            c.extra_env = vec![("ASN_FAKE_CLAUDE".into(), "1".into()), ("FAKE_RECORD".into(), rec.display().to_string())];
            c.sessions_dir = sess.clone();
            c.poll_ms = 100;
            c.roster_ms = 100;
            c.tick_ms = 100;
        }),
    );
    // 假的舊橋：自己開的一個長壽命子程序，pid 寫進 bridge.pid
    let old = if cfg!(windows) {
        let mut c = std::process::Command::new("cmd");
        c.no_window().args(["/c", "ping -n 60 127.0.0.1 >nul"]);
        c
    } else {
        let mut c = std::process::Command::new("sleep");
        c.no_window().arg("60");
        c
    }
    .stdout(std::process::Stdio::null())
    .stderr(std::process::Stdio::null())
    .spawn()
    .unwrap();
    std::fs::write(super::super::lock::pid_file(work.path()), old.id().to_string()).unwrap();
    let old = Mutex::new(Some(old));
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        crate::rt::block_on(async {
            // 設定關著：什麼都不做，連輪詢接手也不動
            m.start_if_enabled();
            m.poll_handoff();
            assert!(!m.status().running);
            super::super::write_settings(data.path(), super::super::BridgeSettings { enabled: true, ..Default::default() }).unwrap();
            m.start_if_enabled();
            let st = m.status();
            assert!(st.enabled && !st.running && st.legacy, "舊橋在跑：讓步 {st:?}");
            m.poll_handoff();
            assert!(!m.status().running, "舊橋還在：不搶");
            // 舊橋退出（只結束自己開的這個）
            if let Some(mut c) = old.lock().unwrap().take() {
                let _ = c.kill();
                let _ = c.wait();
            } // 放掉子程序的 handle：Windows 上 handle 還在，已結束的程序 pid 還會被當成活著
            for _ in 0..50 {
                m.poll_handoff();
                if m.status().running {
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(100)).await;
            }
            let st = m.status();
            assert!(st.running && !st.legacy, "舊橋退出後自動接手 {st:?}");
            assert_eq!(super::super::lock::read_pid(&super::super::lock::pid_file(work.path())), Some(std::process::id()));
            m.stop();
            assert!(!super::super::lock::pid_file(work.path()).exists());
            // 關掉設定後不會再自己啟動
            super::super::write_settings(data.path(), super::super::BridgeSettings::default()).unwrap();
            m.poll_handoff();
            assert!(!m.status().running);
        })
    }));
    if let Some(mut c) = old.lock().unwrap().take() {
        let _ = c.kill();
        let _ = c.wait();
    }
    m.stop();
    if let Err(e) = result {
        std::panic::resume_unwind(e);
    }
}

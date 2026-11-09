//! 回信寄件匣（#1135）：寄不出去先保管、之後用同一個 client_id 重寄；放棄時通知原寄件人。假後端、假 worker。
use super::*;

const SECRET: &str = "好的，已處理-機密內文";

fn outbox_file(h: &H) -> std::path::PathBuf {
    h.work.path().join("reply-outbox.json")
}
fn set_fail(h: &H, n: usize, code: u16) {
    let mut s = h.fr.st.lock().unwrap();
    s.send_fail_n = n;
    s.send_fail_code = code;
}
fn attempts(h: &H) -> Vec<Value> {
    h.fr.st.lock().unwrap().send_attempts.clone()
}
fn file_items(h: &H) -> usize {
    std::fs::read_to_string(outbox_file(h)).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok()).and_then(|v| v["items"].as_array().map(|a| a.len())).unwrap_or(0)
}
async fn reply(h: &mut H, text: &str, now: u64) {
    h.core.on_worker_line(res(&reply_block("T-乙", text)), now).await;
}
async fn rig() -> H {
    let mut h = harness(&[("T-乙", "idle")]).await;
    h.forward(mail(1, json!({})), T0).await;
    h
}

#[tokio::test]
async fn 內層重試_第一次_503_第二次成功_只有一封_兩次_client_id_相同() {
    let mut h = rig().await;
    h.core.relay = Arc::new(Relay::new(h.fr.url.clone(), "fake-test-key".into(), "T".into(), "T-ASN".into()).with_connect_retry(&[1, 1, 1]));
    set_fail(&h, 1, 503);
    reply(&mut h, SECRET, T0 + 3_000).await;
    let a = attempts(&h);
    assert_eq!(a.len(), 2, "{a:?}");
    assert_eq!(a[0]["client_id"], a[1]["client_id"]);
    assert_eq!(h.fr.sent().len(), 1);
    assert!(h.core.outbox_ids().is_empty() && !outbox_file(&h).exists());
}

#[tokio::test]
async fn 內層全失敗_進寄件匣_通知視窗會自動重寄_log_不含內文() {
    let mut h = rig().await;
    set_fail(&h, 5, 503);
    let before = h.said().len();
    reply(&mut h, SECRET, T0 + 3_000).await;
    assert!(h.fr.sent().is_empty());
    assert_eq!(h.core.outbox_ids().len(), 1);
    assert_eq!(file_items(&h), 1, "存檔在");
    let said = h.said();
    assert!(said[before..].iter().any(|s| s.contains("收發室會自動重寄")), "{said:?}");
    assert!(!said[before..].iter().any(|s| s.contains("你剛才的回信沒有寄出去")), "不叫視窗自己重寄");
    // 寄件匣相關的 log 行只有編號與筆數（worker 回合的既有 log 不在這次範圍）
    let lg: Vec<String> = h.core.log.recent().into_iter().filter(|l| l.contains("outbox") || l.contains("send back") || l.starts_with("reply ")).collect();
    assert!(!lg.is_empty() && !lg.join("\n").contains("機密內文"), "log 不記內文：{lg:?}");
}

#[tokio::test]
async fn 重開後讀回寄件匣_到時間重寄成功_同一個_client_id_檔案清掉() {
    let mut h = rig().await;
    set_fail(&h, 1, 503);
    reply(&mut h, SECRET, T0 + 3_000).await;
    let cid = attempts(&h)[0]["client_id"].clone();
    let mut c2 = new_core(&h.fr, h.work.path(), h.sessions.path(), Arc::new(FakeSink::default()), T0 + 4_000);
    assert_eq!(c2.outbox_ids().len(), 1, "讀回");
    c2.tick(T0 + 3_000 + 10_000).await;
    assert!(h.fr.sent().is_empty(), "還沒到時間");
    c2.tick(T0 + 3_000 + 15_000).await;
    let s = h.fr.sent();
    assert_eq!(s.len(), 1);
    assert_eq!(s[0]["client_id"], cid);
    assert_eq!(s[0]["body"], SECRET);
    assert!(c2.outbox_ids().is_empty());
    assert_eq!(file_items(&h), 0);
}

#[tokio::test]
async fn 重寄時後台回_duplicate_視為成功_只有一封() {
    let mut h = rig().await;
    {
        let mut s = h.fr.st.lock().unwrap();
        s.send_dedupe = true;
        s.send_fail_store = true;
    }
    set_fail(&h, 1, 503);
    reply(&mut h, SECRET, T0 + 3_000).await;
    assert_eq!(h.fr.sent().len(), 1, "第一次其實已送達");
    assert_eq!(h.core.outbox_ids().len(), 1);
    h.core.tick(T0 + 3_000 + 15_000).await;
    assert_eq!(h.fr.sent().len(), 1);
    assert_eq!(attempts(&h).len(), 2);
    assert!(h.core.outbox_ids().is_empty());
}

#[tokio::test]
async fn 超過_24_小時放棄_走_bridge_notice_不以視窗名義() {
    let mut h = rig().await;
    h.fr.st.lock().unwrap().bridge_notice_on = true;
    set_fail(&h, 100, 503);
    reply(&mut h, SECRET, T0 + 3_000).await;
    let before = h.said().len();
    h.core.tick(T0 + 3_000 + 86_400_000 + 1_000).await;
    assert!(h.core.outbox_ids().is_empty() && file_items(&h) == 0);
    let n = h.fr.st.lock().unwrap().bridge_notices.clone();
    assert_eq!(n.len(), 1, "{n:?}");
    let body = n[0]["body"].as_str().unwrap();
    assert_eq!(n[0]["reply_to"], uid(1));
    assert!(body.contains("T-乙") && body.contains("沒能送出") && body.contains(&uid(1)) && !body.contains("機密內文"), "{body}");
    assert!(h.fr.sent().is_empty(), "沒有以視窗名義寄任何信");
    assert!(h.said()[before..].iter().any(|s| s.contains("已放棄")));
}

#[tokio::test]
async fn 超過筆數上限_最舊的丟掉並通知() {
    let mut h = rig().await;
    h.fr.st.lock().unwrap().bridge_notice_on = true;
    for n in 0..200 {
        h.core.outbox_test_push(&uid(5000 + n), vec![], T0, T0 + 1_000_000);
    }
    set_fail(&h, 5, 503);
    reply(&mut h, SECRET, T0 + 3_000).await;
    let ids = h.core.outbox_reply_tos();
    assert_eq!(ids.len(), 200);
    assert!(!ids.contains(&uid(5000)) && ids.contains(&uid(1)));
    let n = h.fr.st.lock().unwrap().bridge_notices.clone();
    assert_eq!(n.len(), 1);
    assert_eq!(n[0]["reply_to"], uid(5000));
}

#[tokio::test]
async fn 附件過期_改寄不帶附件_信尾註明() {
    let mut h = rig().await;
    h.fr.st.lock().unwrap().send_attach_bad = true;
    h.core.outbox_test_push(&uid(1), vec![uid(77)], T0, T0);
    h.core.tick(T0 + 10).await;
    let s = h.fr.sent();
    assert_eq!(s.len(), 1);
    assert!(s[0].get("attachment_ids").is_none());
    assert!(s[0]["body"].as_str().unwrap().ends_with("（附件已過期，沒有附上）"));
    assert!(h.core.outbox_ids().is_empty());
}

#[tokio::test]
async fn 後台回_attachments_missing_記_log_不再重寄() {
    let mut h = rig().await;
    h.fr.st.lock().unwrap().send_missing = true;
    h.core.outbox_test_push(&uid(1), vec![uid(77)], T0, T0);
    h.core.tick(T0 + 10).await;
    h.core.tick(T0 + 1_000_000).await;
    assert_eq!(h.fr.sent().len(), 1);
    assert!(h.core.log.has("1 attachment(s) missing"));
    assert!(h.core.outbox_ids().is_empty());
}

#[tokio::test]
async fn 四碼不進寄件匣_照舊通知視窗() {
    let mut h = rig().await;
    set_fail(&h, 1, 422);
    let before = h.said().len();
    reply(&mut h, SECRET, T0 + 3_000).await;
    assert!(h.core.outbox_ids().is_empty() && !outbox_file(&h).exists());
    assert!(h.said()[before..].iter().any(|s| s.contains("你剛才的回信沒有寄出去")));
}

#[tokio::test]
async fn 處理中的那筆不會被重寄兩次() {
    let mut h = rig().await;
    set_fail(&h, 1, 503);
    reply(&mut h, SECRET, T0 + 3_000).await;
    let cid = h.core.outbox_ids()[0].clone();
    h.core.outbox_mark_busy(&cid);
    h.core.tick(T0 + 3_000 + 20_000).await;
    assert_eq!(attempts(&h).len(), 1, "處理中：不重寄");
    assert!(h.fr.sent().is_empty());
}

#[tokio::test]
async fn 同一封信的後續片段排在後面_依序寄出() {
    let mut h = rig().await;
    set_fail(&h, 1, 503);
    reply(&mut h, "第一段", T0 + 3_000).await;
    reply(&mut h, "第二段", T0 + 3_100).await;
    assert_eq!(attempts(&h).len(), 1, "第二段直接排隊，不搶先寄");
    assert_eq!(h.core.outbox_ids().len(), 2);
    h.core.tick(T0 + 3_000 + 20_000).await;
    let bodies: Vec<String> = h.fr.sent().iter().map(|s| s["body"].as_str().unwrap().to_string()).collect();
    assert_eq!(bodies, ["第一段", "第二段"]);
}

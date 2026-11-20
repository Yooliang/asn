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

#[tokio::test]
async fn 超過上限時最舊那封信的片段一起丟_只通知一次() {
    let mut h = rig().await;
    h.fr.st.lock().unwrap().bridge_notice_on = true;
    // 最舊的那封信有兩段；之後塞到剛好 200 筆
    h.core.outbox_test_push(&uid(5000), vec![], T0, T0 + 1_000_000);
    h.core.outbox_test_push(&uid(5000), vec![], T0, T0 + 1_000_000);
    for n in 1..199 {
        h.core.outbox_test_push(&uid(5000 + n), vec![], T0, T0 + 1_000_000);
    }
    set_fail(&h, 5, 503);
    reply(&mut h, SECRET, T0 + 3_000).await;
    let ids = h.core.outbox_reply_tos();
    assert!(!ids.contains(&uid(5000)), "最舊那封信的兩段都丟掉，不會留下後段單獨送出");
    assert_eq!(ids.len(), 199);
    let n = h.fr.st.lock().unwrap().bridge_notices.clone();
    assert_eq!(n.len(), 1, "同一封信只通知一次");
    assert_eq!(n[0]["reply_to"], uid(5000));
}

fn bad_files(h: &H) -> Vec<std::path::PathBuf> {
    let mut v: Vec<_> = std::fs::read_dir(h.work.path())
        .unwrap()
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| p.file_name().and_then(|n| n.to_str()).map_or(false, |n| n.starts_with("reply-outbox.json.bad-")))
        .collect();
    v.sort();
    v
}

#[tokio::test]
async fn 壞檔第二次壞掉_不蓋掉先前的_bad() {
    let h = rig().await;
    std::fs::write(outbox_file(&h), "{ 壞一").unwrap();
    let _c1 = new_core(&h.fr, h.work.path(), h.sessions.path(), Arc::new(FakeSink::default()), T0 + 4_000);
    let first = bad_files(&h);
    assert_eq!(first.len(), 1);
    std::fs::write(outbox_file(&h), "{ 壞二").unwrap();
    let _c2 = new_core(&h.fr, h.work.path(), h.sessions.path(), Arc::new(FakeSink::default()), T0 + 5_000);
    let all = bad_files(&h);
    assert_eq!(all.len(), 2, "第二個壞檔另存，不蓋掉第一個");
    assert_eq!(std::fs::read_to_string(&first[0]).unwrap(), "{ 壞一", "舊 .bad 內容原封不動");
}

fn bad_notices(h: &H) -> Vec<Value> {
    h.fr.st.lock().unwrap().outbox_bad_notices.clone()
}

#[tokio::test]
async fn 壞檔_第一次_tick_通知本人一次_之後不再送() {
    let h = rig().await;
    std::fs::write(outbox_file(&h), format!("{{ 壞掉 {SECRET}")).unwrap();
    let mut c2 = new_core(&h.fr, h.work.path(), h.sessions.path(), Arc::new(FakeSink::default()), T0 + 4_000);
    assert!(bad_notices(&h).is_empty(), "Core::new 不送（同步），等 tick");
    c2.tick(T0 + 5_000).await;
    let n = bad_notices(&h);
    assert_eq!(n.len(), 1, "{n:?}");
    assert!(!n[0].to_string().contains("機密內文") && !n[0].to_string().contains("壞掉"), "請求不帶任何內文：{n:?}");
    c2.tick(T0 + 6_000).await;
    c2.tick(T0 + 20_000).await;
    assert_eq!(bad_notices(&h).len(), 1, "只送一次");
    let lg = c2.log.recent().join("\n");
    assert!(lg.contains("owner notice requested") && !lg.contains("機密內文"), "{lg}");
}

#[tokio::test]
async fn 壞檔通知失敗_只記_log_不重試() {
    let h = rig().await;
    h.fr.st.lock().unwrap().outbox_bad_status = 404; // 舊後台沒有這個動作
    std::fs::write(outbox_file(&h), "{ 壞").unwrap();
    let mut c2 = new_core(&h.fr, h.work.path(), h.sessions.path(), Arc::new(FakeSink::default()), T0 + 4_000);
    c2.tick(T0 + 5_000).await;
    c2.tick(T0 + 700_000).await;
    assert_eq!(bad_notices(&h).len(), 1, "失敗也只試一次");
    assert!(c2.log.recent().iter().any(|l| l.contains("只留本機紀錄")));
}

#[tokio::test]
async fn 壞檔通知_第一次_503_六十秒後成功_共送兩次() {
    let h = rig().await;
    h.fr.st.lock().unwrap().outbox_bad_fail_n = 1;
    std::fs::write(outbox_file(&h), "{ 壞").unwrap();
    let mut c2 = new_core(&h.fr, h.work.path(), h.sessions.path(), Arc::new(FakeSink::default()), T0 + 4_000);
    c2.tick(T0 + 5_000).await;
    assert_eq!(bad_notices(&h).len(), 1);
    c2.tick(T0 + 30_000).await;
    assert_eq!(bad_notices(&h).len(), 1, "還沒到六十秒");
    c2.tick(T0 + 65_000).await;
    assert_eq!(bad_notices(&h).len(), 2, "六十秒後再試一次");
    c2.tick(T0 + 200_000).await;
    assert_eq!(bad_notices(&h).len(), 2, "成功後不再送");
}

#[tokio::test]
async fn 壞檔通知_一直_503_超過一小時放棄() {
    let h = rig().await;
    h.fr.st.lock().unwrap().outbox_bad_fail_n = 1000;
    std::fs::write(outbox_file(&h), "{ 壞").unwrap();
    let mut c2 = new_core(&h.fr, h.work.path(), h.sessions.path(), Arc::new(FakeSink::default()), T0 + 4_000);
    c2.tick(T0 + 5_000).await;
    c2.tick(T0 + 65_000).await;
    assert_eq!(bad_notices(&h).len(), 2);
    c2.tick(T0 + 4_000 + 3_600_001).await;
    assert_eq!(bad_notices(&h).len(), 2, "超過一小時不再送");
    assert!(c2.log.recent().iter().any(|l| l.contains("不再通知")));
    c2.tick(T0 + 4_000 + 3_700_000).await;
    assert_eq!(bad_notices(&h).len(), 2, "放棄後不再試");
}

#[tokio::test]
async fn 寄件匣檔不是_utf8_也當壞檔_改名並通知() {
    let h = rig().await;
    std::fs::write(outbox_file(&h), [0xff_u8, 0xfe, 0x00, 0x80]).unwrap();
    let mut c2 = new_core(&h.fr, h.work.path(), h.sessions.path(), Arc::new(FakeSink::default()), T0 + 4_000);
    assert_eq!(bad_files(&h).len(), 1, "改名留著，不被下一次存檔蓋掉");
    assert!(!outbox_file(&h).exists());
    c2.tick(T0 + 5_000).await;
    assert_eq!(bad_notices(&h).len(), 1);
}

#[tokio::test]
async fn 正常的寄件匣檔_不送壞檔通知() {
    let mut h = rig().await;
    set_fail(&h, 1, 503);
    reply(&mut h, SECRET, T0 + 3_000).await;
    let mut c2 = new_core(&h.fr, h.work.path(), h.sessions.path(), Arc::new(FakeSink::default()), T0 + 4_000);
    c2.tick(T0 + 5_000).await;
    assert!(bad_notices(&h).is_empty());
}

#[tokio::test]
async fn 壞檔改名成_bad_之後仍可正常運作() {
    let h = rig().await;
    std::fs::write(outbox_file(&h), "{ 這不是 json").unwrap();
    let mut c2 = new_core(&h.fr, h.work.path(), h.sessions.path(), Arc::new(FakeSink::default()), T0 + 4_000);
    assert!(c2.outbox_ids().is_empty(), "壞檔不當成有信");
    assert_eq!(bad_files(&h).len(), 1, "壞檔留著（檔名帶時間戳）");
    // 之後照常存、照常重寄
    c2.outbox_test_push(&uid(1), vec![], T0, T0);
    assert_eq!(file_items(&h), 1);
    c2.tick(T0 + 10).await;
    assert_eq!(h.fr.sent().len(), 1);
    assert!(c2.outbox_ids().is_empty() && file_items(&h) == 0);
}

#[tokio::test]
async fn 壞檔超過五個_只留最新五個_刪除有_log() {
    let h = rig().await;
    // 先放 6 個舊壞檔（含舊格式 .bad），時間戳都比現在小
    std::fs::write(h.work.path().join("reply-outbox.json.bad"), "x").unwrap();
    for n in 1..=5 {
        std::fs::write(h.work.path().join(format!("reply-outbox.json.bad-{n}")), "x").unwrap();
    }
    std::fs::write(outbox_file(&h), "{ 壞").unwrap();
    let mut c2 = new_core(&h.fr, h.work.path(), h.sessions.path(), Arc::new(FakeSink::default()), T0 + 4_000);
    let left = bad_files(&h);
    assert_eq!(left.len(), 5, "{left:?}");
    assert!(!h.work.path().join("reply-outbox.json.bad").exists(), "舊格式視為最舊，先刪");
    assert!(!h.work.path().join("reply-outbox.json.bad-1").exists() && h.work.path().join("reply-outbox.json.bad-2").exists(), "最舊的兩個被刪、bad-2 以後留著");
    let lg = c2.log.recent().join("
");
    assert!(lg.contains("已刪除最舊的 reply-outbox.json.bad"), "{lg}");
    c2.tick(T0 + 5_000).await;
    assert_eq!(bad_notices(&h).len(), 1);
}

#[tokio::test]
async fn 寫檔失敗_回_Failed_走原流程通知視窗() {
    let mut h = rig().await;
    // 存檔路徑被同名資料夾占住：先寫暫存檔再改名會失敗
    std::fs::create_dir(outbox_file(&h)).unwrap();
    set_fail(&h, 5, 503);
    let before = h.said().len();
    reply(&mut h, SECRET, T0 + 3_000).await;
    assert!(h.core.outbox_ids().is_empty(), "沒存進去");
    assert!(h.said()[before..].iter().any(|s| s.contains("你剛才的回信沒有寄出去")), "照原流程叫視窗自己處理");
}

#[tokio::test]
async fn 分段_前段存進去_後段寫不進去_整封信放棄並通知_不當成失敗() {
    let mut h = rig().await;
    h.fr.st.lock().unwrap().bridge_notice_on = true;
    set_fail(&h, 1, 503);
    reply(&mut h, "第一段", T0 + 3_000).await;
    assert_eq!(h.core.outbox_ids().len(), 1);
    // 之後存檔寫不進去
    std::fs::remove_file(outbox_file(&h)).unwrap();
    std::fs::create_dir(outbox_file(&h)).unwrap();
    let before = h.said().len();
    reply(&mut h, "第二段", T0 + 3_100).await;
    assert!(h.core.log.has("later part cannot be stored"));
    let n = h.fr.st.lock().unwrap().bridge_notices.clone();
    assert_eq!(n.len(), 1, "整封信只通知一次：{n:?}");
    assert_eq!(n[0]["reply_to"], uid(1));
    assert!(h.core.outbox_ids().is_empty(), "通知送達後移除");
    assert!(!h.said()[before..].iter().any(|s| s.contains("你剛才的回信沒有寄出去")), "回 Stored：不走寄送失敗流程，原信照常 ack，也不會叫視窗重答");
    assert!(h.said()[before..].iter().any(|s| s.contains("已放棄")));
}

#[tokio::test]
async fn 斷網積壓_一輪只嘗試一筆就停() {
    let mut h = rig().await;
    for n in 0..30 {
        h.core.outbox_test_push(&uid(5000 + n), vec![], T0, T0);
    }
    set_fail(&h, 1000, 503);
    h.core.tick(T0 + 10).await;
    assert_eq!(attempts(&h).len(), 1, "暫時性失敗就結束這一輪");
    assert_eq!(h.core.outbox_ids().len(), 30);
}

#[tokio::test]
async fn 全部成功時一輪最多_10_筆() {
    let mut h = rig().await;
    for n in 0..30 {
        h.core.outbox_test_push(&uid(5000 + n), vec![], T0, T0);
    }
    h.core.tick(T0 + 10).await;
    assert_eq!(h.fr.sent().len(), 10);
    assert_eq!(h.core.outbox_ids().len(), 20);
    h.core.tick(T0 + 20).await;
    assert_eq!(h.fr.sent().len(), 20);
}

#[tokio::test]
async fn 放棄通知寄不出去_保留待通知_下一輪送達才移除() {
    let mut h = rig().await;
    {
        let mut s = h.fr.st.lock().unwrap();
        s.bridge_notice_on = true;
        s.notice_fail_n = 1;
    }
    set_fail(&h, 100, 503);
    reply(&mut h, SECRET, T0 + 3_000).await;
    let before = h.said().len();
    let t1 = T0 + 3_000 + 86_400_000 + 1_000;
    h.core.tick(t1).await;
    assert_eq!(h.core.outbox_pending_notices(), 1, "通知沒送達：保留待通知");
    assert_eq!(file_items(&h), 1, "存檔也留著");
    assert!(h.fr.st.lock().unwrap().bridge_notices.is_empty());
    assert!(!h.said()[before..].iter().any(|s| s.contains("已放棄")), "通知沒送達前不告訴視窗");
    h.core.tick(t1 + 20_000).await;
    assert!(h.core.outbox_ids().is_empty() && file_items(&h) == 0);
    let n = h.fr.st.lock().unwrap().bridge_notices.clone();
    assert_eq!(n.len(), 1);
    assert!(!n[0]["body"].as_str().unwrap().contains("機密內文"));
    assert_eq!(h.said()[before..].iter().filter(|s| s.contains("已放棄")).count(), 1, "視窗只收到一次");
}

#[tokio::test]
async fn 超過上限被淘汰的信_通知寄不出去時待通知項保留_不占待送上限() {
    let mut h = rig().await;
    {
        let mut s = h.fr.st.lock().unwrap();
        s.bridge_notice_on = true;
        s.notice_fail_n = 1;
    }
    for n in 0..200 {
        h.core.outbox_test_push(&uid(5000 + n), vec![], T0, T0 + 1_000_000);
    }
    set_fail(&h, 5, 503);
    reply(&mut h, SECRET, T0 + 3_000).await;
    assert_eq!(h.core.outbox_pending_notices(), 1);
    assert_eq!(h.core.outbox_ids().len(), 201, "200 筆待送＋1 筆待通知");
    assert!(h.core.outbox_reply_tos().contains(&uid(5000)), "最舊那封以待通知項留著");
    assert_eq!(file_items(&h), 201);
}

#[tokio::test]
async fn 暫時性的_408_429_500_進寄件匣() {
    for code in [408u16, 429, 500] {
        let mut h = rig().await;
        set_fail(&h, 1, code);
        reply(&mut h, SECRET, T0 + 3_000).await;
        assert_eq!(h.core.outbox_ids().len(), 1, "HTTP {code} 要進寄件匣");
        assert_eq!(file_items(&h), 1);
    }
}

#[tokio::test]
async fn 寄信時讀回應中斷_重試用盡_進寄件匣_不當成已寄出() {
    let mut h = rig().await;
    h.core.relay = Arc::new(Relay::new(h.fr.url.clone(), "fake-test-key".into(), "T".into(), "T-ASN".into()).with_connect_retry(&[1, 1, 1]));
    h.fr.st.lock().unwrap().send_truncate = true;
    reply(&mut h, SECRET, T0 + 3_000).await;
    assert_eq!(h.core.outbox_ids().len(), 1, "回信進了寄件匣");
    h.fr.st.lock().unwrap().send_truncate = false;
    h.core.tick(T0 + 3_000 + 15_000).await;
    assert!(h.core.outbox_ids().is_empty(), "恢復後用同一個 client_id 重寄成功");
}

// ---- #1249（#1231 二審建議的後續）----------------------------------------------------------

/// 讓下一次存檔失敗又不動到原檔：把暫存檔那個名字占成資料夾（暫存檔寫不進去，原檔留在原處）
fn block_next_save(h: &H) -> std::path::PathBuf {
    let tmp = std::path::PathBuf::from(format!("{}.{}.tmp", outbox_file(h).display(), std::process::id()));
    std::fs::create_dir(&tmp).unwrap();
    tmp
}

#[tokio::test]
async fn t1249_重寄被_4xx_拒絕後放棄_通知原寄件人_不含內文() {
    let mut h = rig().await;
    h.fr.st.lock().unwrap().bridge_notice_on = true;
    set_fail(&h, 1, 503);
    reply(&mut h, SECRET, T0 + 3_000).await;
    assert_eq!(h.core.outbox_ids().len(), 1);
    {
        let mut s = h.fr.st.lock().unwrap();
        s.send_fail_n = 1;
        s.send_fail_code = 422;
        s.send_fail_err = "not_receivable".into();
    }
    h.core.tick(T0 + 3_000 + 15_000).await;
    assert!(h.core.outbox_ids().is_empty() && file_items(&h) == 0, "放棄且通知送達後清空");
    let n = h.fr.st.lock().unwrap().bridge_notices.clone();
    assert_eq!(n.len(), 1, "{n:?}");
    let body = n[0]["body"].as_str().unwrap();
    assert!(body.contains("對方收不到") && body.contains("已放棄") && !body.contains("機密內文"), "{body}");
    assert_eq!(attempts(&h).len(), 2, "只寄過兩次（首次＋重寄），之後不再寄");
}

#[tokio::test]
async fn t1249_放棄後同一封信的後段才來_不會直接寄出() {
    let mut h = rig().await;
    {
        let mut s = h.fr.st.lock().unwrap();
        s.bridge_notice_on = true;
        s.notice_fail_n = 1;
    }
    set_fail(&h, 1, 503);
    reply(&mut h, "第一段", T0 + 3_000).await;
    {
        // 重寄時被後台明確拒絕（4xx）＝放棄；通知又寄不出去，待通知項留著
        let mut s = h.fr.st.lock().unwrap();
        s.send_fail_n = 1;
        s.send_fail_code = 422;
        s.send_fail_err = "not_receivable".into();
    }
    h.core.tick(T0 + 3_000 + 15_000).await;
    assert_eq!(h.core.outbox_pending_notices(), 1, "通知沒送達：待通知項還在");
    let sent_before = attempts(&h).len();
    reply(&mut h, "第二段（放棄之後才來）", T0 + 3_000 + 16_000).await;
    assert_eq!(attempts(&h).len(), sent_before, "後段沒有寄出去");
    assert!(h.fr.sent().is_empty());
    assert_eq!(h.core.outbox_ids().len(), 1, "後段也沒有排進寄件匣，只剩那筆待通知項");
    assert!(h.core.log.has("later part dropped"));
}

#[tokio::test]
async fn t1249_重開後讀回待通知項_再把通知送出() {
    let mut h = rig().await;
    {
        let mut s = h.fr.st.lock().unwrap();
        s.bridge_notice_on = true;
        s.notice_fail_n = 1;
    }
    set_fail(&h, 1, 503);
    reply(&mut h, SECRET, T0 + 3_000).await;
    let t1 = T0 + 3_000 + 86_400_000 + 1_000;
    h.core.tick(t1).await;
    assert_eq!(h.core.outbox_pending_notices(), 1);
    let mut c2 = new_core(&h.fr, h.work.path(), h.sessions.path(), Arc::new(FakeSink::default()), t1 + 1_000);
    assert_eq!(c2.outbox_pending_notices(), 1, "待通知項重開後讀回來");
    assert!(h.fr.st.lock().unwrap().bridge_notices.is_empty());
    c2.tick(t1 + 60_000).await;
    let n = h.fr.st.lock().unwrap().bridge_notices.clone();
    assert_eq!(n.len(), 1, "讀回後送出通知：{n:?}");
    assert!(c2.outbox_ids().is_empty() && file_items(&h) == 0);
}

#[tokio::test]
async fn t1249_待通知項超過_24_小時寄不出去_丟掉只記_log() {
    let mut h = rig().await;
    {
        let mut s = h.fr.st.lock().unwrap();
        s.bridge_notice_on = true;
        s.notice_fail_n = 100;
    }
    h.core.outbox_test_push_pending(&uid(7000), T0, T0);
    h.core.tick(T0 + 86_400_000 - 1_000).await;
    assert_eq!(h.core.outbox_pending_notices(), 1, "還沒滿 24 小時：照舊試著寄（寄不出去就保留）");
    h.core.tick(T0 + 86_400_000 + 1_000).await;
    assert!(h.core.outbox_ids().is_empty() && file_items(&h) == 0, "超過 24 小時就丟");
    assert!(h.core.log.has("undeliverable for 24h"));
    assert!(h.fr.st.lock().unwrap().bridge_notices.is_empty());
}

#[tokio::test]
async fn t1249_待通知項超過_100_筆_丟最舊的() {
    let mut h = rig().await;
    for n in 0..101 {
        h.core.outbox_test_push_pending(&uid(7000 + n), T0, T0 + 1_000_000);
    }
    assert_eq!(h.core.outbox_pending_notices(), 101);
    set_fail(&h, 5, 503);
    reply(&mut h, SECRET, T0 + 3_000).await;
    assert_eq!(h.core.outbox_pending_notices(), 100, "超過 100 筆就丟最舊的");
    let tos = h.core.outbox_reply_tos();
    assert!(!tos.contains(&uid(7000)) && tos.contains(&uid(7001)) && tos.contains(&uid(7100)) && tos.contains(&uid(1)));
    assert!(h.core.log.has("too many pending give-up notices"));
}

/// 重寄時後台明確拒絕（4xx）：下一次重寄寄出去就會被拒，走放棄流程
fn reject_next_resend(h: &H) {
    let mut s = h.fr.st.lock().unwrap();
    s.send_fail_n = 1;
    s.send_fail_code = 422;
    s.send_fail_err = "not_receivable".into();
}

#[tokio::test]
async fn t1249_放棄時存檔失敗_重開後不會把已放棄的舊片段又寄出去() {
    let mut h = rig().await;
    {
        let mut s = h.fr.st.lock().unwrap();
        s.bridge_notice_on = true;
        s.notice_fail_n = 1;
    }
    set_fail(&h, 1, 503);
    reply(&mut h, SECRET, T0 + 3_000).await;
    assert_eq!(file_items(&h), 1, "存檔裡有待送的回信");
    reject_next_resend(&h);
    let tmp = block_next_save(&h);
    h.core.tick(T0 + 18_000).await;
    assert!(h.core.log.has("give-up notice not persisted"), "放棄時存檔失敗");
    assert_eq!(file_items(&h), 1, "存檔裡還是舊片段");
    assert!(h.fr.st.lock().unwrap().bridge_notices.is_empty(), "放棄通知沒送達");
    std::fs::remove_dir(&tmp).unwrap();
    let sent_before = attempts(&h).len();
    let mut c2 = new_core(&h.fr, h.work.path(), h.sessions.path(), Arc::new(FakeSink::default()), T0 + 19_000);
    assert_eq!(c2.outbox_pending_notices(), 1, "舊片段換成待通知項");
    c2.tick(T0 + 60_000).await;
    c2.tick(T0 + 120_000).await;
    assert_eq!(attempts(&h).len(), sent_before, "舊片段沒有再寄出去");
    assert!(h.fr.sent().is_empty());
    assert_eq!(h.fr.st.lock().unwrap().bridge_notices.len(), 1, "原本沒送達的放棄通知補寄一次");
    assert!(c2.outbox_ids().is_empty() && file_items(&h) == 0, "通知送達後清空");
    assert!(!std::path::Path::new(&format!("{}.gave-up", outbox_file(&h).display())).exists(), "小檔跟著清掉");
}

#[tokio::test]
async fn t1249_放棄時存檔失敗_但通知已送達_重開後不重複通知也不重寄() {
    let mut h = rig().await;
    h.fr.st.lock().unwrap().bridge_notice_on = true;
    set_fail(&h, 1, 503);
    reply(&mut h, SECRET, T0 + 3_000).await;
    reject_next_resend(&h);
    let tmp = block_next_save(&h);
    h.core.tick(T0 + 18_000).await;
    assert_eq!(h.fr.st.lock().unwrap().bridge_notices.len(), 1, "通知已送達");
    std::fs::remove_dir(&tmp).unwrap();
    let sent_before = attempts(&h).len();
    let mut c2 = new_core(&h.fr, h.work.path(), h.sessions.path(), Arc::new(FakeSink::default()), T0 + 19_000);
    c2.tick(T0 + 60_000).await;
    assert_eq!(attempts(&h).len(), sent_before, "舊片段沒有再寄出去");
    assert_eq!(h.fr.st.lock().unwrap().bridge_notices.len(), 1, "不重複通知");
    assert!(c2.outbox_ids().is_empty());
}

#[tokio::test]
async fn t1249_寄回信的內層逾時縮短_半通的網路不會卡住好幾十秒() {
    let mut h = rig().await;
    // 後台收到請求後 3 秒才回；寄回信用的是短逾時（測試 0.3 秒，正式 8 秒），不會乾等到預設的 20 秒
    h.fr.st.lock().unwrap().send_delay_ms = 3_000;
    let t = std::time::Instant::now();
    reply(&mut h, SECRET, T0 + 3_000).await;
    assert!(t.elapsed() < std::time::Duration::from_millis(2_500), "不該等後台的慢回應：{:?}", t.elapsed());
    assert_eq!(h.core.outbox_ids().len(), 1, "逾時算暫時性失敗：進寄件匣，之後用同一個 client_id 重寄");
}

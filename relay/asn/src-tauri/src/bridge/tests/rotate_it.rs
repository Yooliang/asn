//! 同一種被擋原因連續幾次就換一輪新對話並通知擁有者（#2146 ③）的整合測試。假後端、假 worker，全是假資料。
use super::*;
use std::collections::HashMap;
use crate::bridge::core::rotate::{ROTATE_AFTER, ROTATE_MAX_CHAIN, ROTATE_NOTICE_GAP_MS};
use crate::bridge::forward_gate::{self, DenyKind, InflightItem, Verdict};

const SECRET: &str = "機密內文-不可進記錄";

/// 閘門退回的理由（取自 forward_gate 真的產生的字）
fn why_frame() -> String {
    forward_gate::no_id_reason("<<<MAIL\n<<<MAIL\n[RELAY 來信] x\nMAIL>>>")
}
fn why_frame_only() -> String {
    forward_gate::no_id_reason("<<<MAIL\nMAIL>>>")
}
fn why_no_id() -> String {
    forward_gate::no_id_reason("[RELAY 來信] 沒有編號")
}
fn why_wrong_to() -> String {
    "收件人應為 T-甲，你填的是 T-丙：請把 to 改成 T-甲 再送".into()
}

/// 假 worker 呼叫 SendMessage，被閘門退回（工具結果 is_error，內容是退回理由）
async fn denied(core: &mut Core, tid: &str, why: &str, now: u64) {
    let call = json!({"type": "assistant", "message": {"model": "claude-haiku", "content": [{"type": "tool_use", "id": tid, "name": "SendMessage",
        "input": {"to": "T-乙", "message": "x", "summary": "轉交 relay 來信"}}]}});
    let result = json!({"type": "user", "message": {"role": "user", "content": [{"type": "tool_result", "tool_use_id": tid, "is_error": true,
        "content": format!("PreToolUse:SendMessage hook blocking error: {why}")}]}});
    core.on_worker_line(WorkerLine::Line(call.to_string()), now).await;
    core.on_worker_line(WorkerLine::Line(result.to_string()), now).await;
}

async fn deny_n(h: &mut H, n: u32, why: &str, now: u64) {
    for i in 0..n {
        denied(&mut h.core, &format!("toolu_d{now}_{i}"), why, now).await;
    }
}

fn rotations(h: &H) -> usize {
    h.core.log.count("WARN forward-gate-rotate reason=")
}

fn stuck_notices(h: &H, kind: &str) -> Vec<Value> {
    h.fr.wait_notices().into_iter().filter(|b| b["kind"] == kind).collect()
}

async fn rig() -> H {
    let mut h = harness(&[("T-乙", "idle")]).await;
    h.fr.put(mail(1, json!({"body": SECRET})));
    h.core.pull("test", T0).await;
    assert_eq!(h.core.pending.len(), 1, "有一封排隊中的信");
    h
}

fn forwards_of_1(h: &H) -> usize {
    h.said().iter().filter(|t| t.starts_with("[BRIDGE-FORWARD") && t.lines().next().unwrap().contains(&format!("id={} ", uid(1)))).count()
}

#[tokio::test]
async fn 同一原因連續三次_換一輪_排隊中的信在新的一輪重新轉交_log_不含內文() {
    assert_eq!(ROTATE_AFTER, 3);
    let mut h = rig().await;
    assert_eq!(forwards_of_1(&h), 1);
    deny_n(&mut h, 2, &why_frame(), T0 + 1).await;
    assert!(!h.sink.killed.load(Ordering::SeqCst), "兩次還不換");
    deny_n(&mut h, 1, &why_frame_only(), T0 + 2).await; // 外框的兩種說法算同一類
    assert!(h.sink.killed.load(Ordering::SeqCst), "第三次換輪");
    assert_eq!(rotations(&h), 1);
    assert!(h.core.log.has("WARN forward-gate-rotate reason=frame count=3 rotation=1/3"));
    // 信還在排隊；新的 worker 起來後照原文重送
    assert_eq!(h.core.pending.len(), 1);
    h.core.on_worker_line(WorkerLine::Exited(None), T0 + 3).await;
    h.core.on_worker_line(WorkerLine::Started(2), T0 + 4).await;
    assert_eq!(h.core.pending.len(), 1, "換輪沒有掉信");
    assert_eq!(forwards_of_1(&h), 2, "新的一輪重新轉交了一次");
    assert!(h.core.log.has("resent 1 forwards"));
    // 新的一輪轉交成功，信正常走完
    worker_ok(&mut h.core, &uid(1), T0 + 5).await;
    assert_eq!(h.core.pending[0].state, State::Waiting);
    // 通知：視窗名、原因代號、次數；沒有內文
    let n = stuck_notices(&h, "forward_stuck");
    assert_eq!(n.len(), 1, "{n:?}");
    assert_eq!((n[0]["window"].as_str(), n[0]["detail"].as_str(), n[0]["tool"].as_str()), (Some("T-收發室"), Some("frame"), Some("3")));
    // log 與通知都沒有信件內文
    assert!(!h.core.log.has(SECRET) && !h.core.log.has("內文-"), "log 不寫內文");
    assert!(!h.fr.wait_notices().iter().any(|b| b.to_string().contains(SECRET)));
}

#[tokio::test]
async fn 中間成功一次_計數歸零() {
    let mut h = rig().await;
    h.fr.put(mail(2, json!({})));
    h.core.pull("test", T0 + 1).await;
    deny_n(&mut h, 2, &why_no_id(), T0 + 2).await;
    worker_ok(&mut h.core, &uid(1), T0 + 3).await; // 第 2 次之後成功
    deny_n(&mut h, 2, &why_no_id(), T0 + 4).await;
    assert!(!h.sink.killed.load(Ordering::SeqCst), "成功過一次，要重新數：兩次不換");
    deny_n(&mut h, 1, &why_no_id(), T0 + 5).await;
    assert!(h.sink.killed.load(Ordering::SeqCst), "重數後第三次才換");
    assert_eq!(rotations(&h), 1);
}

#[tokio::test]
async fn 兩種原因交錯_不換輪() {
    let mut h = rig().await;
    for i in 0..4u64 {
        deny_n(&mut h, 1, &why_frame(), T0 + 1 + i * 2).await;
        deny_n(&mut h, 1, &why_wrong_to(), T0 + 2 + i * 2).await;
    }
    assert!(!h.sink.killed.load(Ordering::SeqCst));
    assert_eq!(rotations(&h), 0);
    assert!(h.fr.wait_notices().is_empty());
    // 換了原因就重數：一次收件人錯之後，兩次外框還不到三次
    deny_n(&mut h, 2, &why_frame(), T0 + 20).await;
    assert!(!h.sink.killed.load(Ordering::SeqCst));
}

#[tokio::test]
async fn 通知十分鐘內只一次() {
    assert_eq!(ROTATE_NOTICE_GAP_MS, 600_000);
    let mut h = rig().await;
    deny_n(&mut h, 3, &why_frame(), T0 + 1_000).await;
    assert_eq!(stuck_notices(&h, "forward_stuck").len(), 1);
    // 九分鐘後又換一輪：照樣換，但不再通知
    deny_n(&mut h, 3, &why_frame(), T0 + 1_000 + 540_000).await;
    assert_eq!(rotations(&h), 2);
    assert_eq!(stuck_notices(&h, "forward_stuck").len(), 1, "10 分鐘內第二次不通知");
    assert!(h.core.log.has("notice skipped"));
    // 離第一次通知超過十分鐘：再通知
    deny_n(&mut h, 3, &why_wrong_to(), T0 + 1_000 + 601_000).await;
    assert_eq!(stuck_notices(&h, "forward_stuck").len(), 2);
}

#[tokio::test]
async fn 連換三輪還是被擋_停止換輪_改通知需要人工處理_寫_error() {
    assert_eq!(ROTATE_MAX_CHAIN, 3);
    let mut h = rig().await;
    for i in 0..3u64 {
        deny_n(&mut h, 3, &why_frame(), T0 + 1_000 + i).await;
    }
    assert_eq!(rotations(&h), 3);
    assert!(!h.core.log.has("ERROR"));
    h.sink.killed.store(false, Ordering::SeqCst);
    // 第四次又連續被擋：不再換
    deny_n(&mut h, 3, &why_frame(), T0 + 2_000).await;
    assert!(!h.sink.killed.load(Ordering::SeqCst), "超過三輪就不再換");
    assert_eq!(rotations(&h), 3);
    assert!(h.core.log.has("ERROR forward-gate-rotate-stop reason=frame"));
    let m = stuck_notices(&h, "forward_stuck_manual");
    assert_eq!(m.len(), 1, "改發需要人工處理：{:?}", h.fr.wait_notices());
    assert_eq!((m[0]["window"].as_str(), m[0]["detail"].as_str(), m[0]["tool"].as_str()), (Some("T-收發室"), Some("frame"), Some("3")));
    // 停止之後再被擋，人工處理的通知同樣十分鐘內只一次
    deny_n(&mut h, 3, &why_frame(), T0 + 3_000).await;
    assert_eq!(stuck_notices(&h, "forward_stuck_manual").len(), 1);
    // 轉交成功一次就解除：又可以換輪
    worker_ok(&mut h.core, &uid(1), T0 + 4_000).await;
    deny_n(&mut h, 3, &why_frame(), T0 + 5_000).await;
    assert!(h.sink.killed.load(Ordering::SeqCst));
    assert_eq!(rotations(&h), 4);
}

#[test]
fn 閘門的每一種退回理由都分得到類() {
    let a = "00000000-0000-0000-0000-00000000000a";
    let ok_msg = format!("[RELAY 來信] 抬頭 id={a}");
    let call = |to: &str, msg: &str| json!({"tool_name": "SendMessage", "tool_input": {"to": to, "message": msg, "summary": "s", "type": "message"}});
    let why = |input: Value, flight: Option<&HashMap<String, InflightItem>>| match forward_gate::check(&input, flight).0 {
        Verdict::Deny(r) => r,
        v => panic!("應該被擋：{v:?}"),
    };
    let f: HashMap<String, InflightItem> = [(a.to_string(), InflightItem { to: "T-甲".into(), head: Some(forward_gate::head_hash("[RELAY 來信] 別的抬頭")), body: None })].into_iter().collect();
    let empty: HashMap<String, InflightItem> = HashMap::new();
    let cases: Vec<(String, DenyKind)> = vec![
        (why(json!({"tool_name": "SendMessage", "tool_input": {"summary": "x"}}), Some(&f)), DenyKind::MissingFields),
        (why(json!({"tool_name": "SendMessage", "tool_input": {"to": "T-甲", "recipient": "T-乙", "message": ok_msg, "summary": "s"}}), Some(&f)), DenyKind::RecipientConflict),
        (why(call("T-甲", "<<<MAIL\n[RELAY 來信] x\nMAIL>>>"), Some(&f)), DenyKind::NoId),
        (why(call("T-甲", "[BRIDGE-FORWARD nonce=x id=y to=T-甲]"), Some(&f)), DenyKind::Frame),
        (why(call("T-甲", "<<<MAIL\nMAIL>>>"), Some(&f)), DenyKind::Frame),
        (why(call("T-甲", "沒有編號的一行"), Some(&f)), DenyKind::NoId),
        (why(call("T-丙", &ok_msg), Some(&f)), DenyKind::WrongTo),
        (why(call("T-甲", &ok_msg), Some(&f)), DenyKind::HeadMismatch),
        (why(call("T-甲", &ok_msg), Some(&empty)), DenyKind::NotInFlight),
        (why(call("T-甲", &ok_msg), None), DenyKind::RecordUnreadable),
    ];
    for (reason, want) in cases {
        assert_eq!(forward_gate::classify_deny(&reason), Some(want), "{reason}");
    }
    assert_eq!(forward_gate::classify_deny("Permission denied: some other tool error"), None, "不是閘門的退回不算");
}

fn why_unreadable() -> String {
    "轉交紀錄檔暫時讀不到（橋正在更新紀錄），請等幾秒後再送一次同一封".into()
}

#[tokio::test]
async fn 人工處理通知送不出去_排程重試補發_送成功後不再重發() {
    let mut h = rig().await;
    for i in 0..3u64 {
        deny_n(&mut h, 3, &why_frame(), T0 + 1_000 + i).await;
    }
    h.fr.st.lock().unwrap().wait_notice_status = 503; // 後台壞了：通知送不出去
    let t = T0 + 2_000;
    deny_n(&mut h, 3, &why_frame(), t).await;
    assert!(stuck_notices(&h, "forward_stuck_manual").is_empty());
    assert!(h.core.log.has("manual-handling notice not delivered, retry in 60s"));
    // 還沒到重試時間：不送
    h.fr.st.lock().unwrap().wait_notice_status = 0;
    h.core.rotate_tick(t + 59_000).await;
    assert!(stuck_notices(&h, "forward_stuck_manual").is_empty(), "不到一分鐘不重試");
    // 到了：補發成功，沒有新的被擋事件也一樣
    h.core.rotate_tick(t + 60_000).await;
    assert_eq!(stuck_notices(&h, "forward_stuck_manual").len(), 1, "補發成功");
    // 送成功後不再重發
    for k in 1..=5u64 {
        h.core.rotate_tick(t + 60_000 + k * 900_000).await;
    }
    assert_eq!(stuck_notices(&h, "forward_stuck_manual").len(), 1, "只發一次");
    // 退避：連續失敗是 1、5、15、15 分鐘
    let mut h = rig().await;
    for i in 0..3u64 {
        deny_n(&mut h, 3, &why_frame(), T0 + 1_000 + i).await;
    }
    h.fr.st.lock().unwrap().wait_notice_status = 503;
    let t = T0 + 2_000;
    deny_n(&mut h, 3, &why_frame(), t).await;
    h.core.rotate_tick(t + 60_000).await;
    assert!(h.core.log.has("retry in 300s"));
    h.core.rotate_tick(t + 60_000 + 300_000).await;
    assert!(h.core.log.has("retry in 900s"));
    h.core.rotate_tick(t + 60_000 + 300_000 + 900_000).await;
    assert_eq!(h.core.log.count("retry in 900s"), 2, "之後固定 15 分鐘");
}

#[tokio::test]
async fn 新的一輪開始_被擋次數歸零() {
    let mut h = rig().await;
    deny_n(&mut h, 2, &why_frame(), T0 + 1).await;
    h.core.on_worker_line(WorkerLine::Started(9), T0 + 2).await;
    deny_n(&mut h, 1, &why_frame(), T0 + 3).await;
    assert!(!h.sink.killed.load(Ordering::SeqCst), "Started 之後重數，一次不換");
}

#[tokio::test]
async fn 紀錄檔暫時讀不到_不算連續被擋_不換輪() {
    let mut h = rig().await;
    deny_n(&mut h, 6, &why_unreadable(), T0 + 1).await;
    assert!(!h.sink.killed.load(Ordering::SeqCst));
    assert_eq!(rotations(&h), 0);
    // 夾在中間也不打斷計數
    deny_n(&mut h, 2, &why_frame(), T0 + 2).await;
    deny_n(&mut h, 1, &why_unreadable(), T0 + 3).await;
    assert!(!h.sink.killed.load(Ordering::SeqCst));
    deny_n(&mut h, 1, &why_frame(), T0 + 4).await;
    assert!(h.sink.killed.load(Ordering::SeqCst));
}

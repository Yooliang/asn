//! 視窗開著、卡在第一次確認畫面、還沒進到對話的夥伴（#1635）：名單列成「僅顯示」條目，寄信直接回說明、不暫存。
//! 「在等確認」的清單用假的（launch::awaiting::AwaitingSource），不碰真的程序表與終端對照表。
use super::*;
use crate::launch::awaiting::{Awaiting, AwaitingSource, DETAIL};
use crate::launch::stuck_resume::PartnerRef;

fn stuck(name: &str, pid: u32) -> Awaiting {
    let partner = PartnerRef { id: "7".into(), name: name.into(), session_id: String::new(), mux: true, gui_pid: 500, started_ms: Some(1_000), cwd: "G:/w".into() };
    Awaiting { partner, pids: vec![pid], root_pid: pid, started_ms: 1 }
}

fn source(list: Vec<Awaiting>) -> AwaitingSource {
    Arc::new(move |_| list.clone())
}

/// 視窗 T-乙（5000，正常在線）；卡住的夥伴 T-卡住（程序 7001）
async fn awaiting_harness(list: Vec<Awaiting>) -> H {
    let fr = FakeRelay::start();
    let work = tempfile::tempdir().unwrap();
    let sessions = tempfile::tempdir().unwrap();
    put_session(sessions.path(), 5000, "T-乙", "idle", 100);
    let sink = Arc::new(FakeSink::default());
    let mut core = new_core(&fr, work.path(), sessions.path(), sink.clone(), T0);
    core.set_awaiting_source(source(list));
    core.refresh_roster(T0).await;
    H { core, fr, sink, work, sessions }
}

#[tokio::test]
async fn 名單_列成僅顯示條目_不進本機可轉交名單() {
    let h = awaiting_harness(vec![stuck("T-卡住", 7001)]).await;
    assert!(h.core.roster.iter().all(|w| w.name != "T-卡住"), "不進本機視窗清單（不可轉交）");
    let posts = h.fr.rosters();
    let agents = posts.last().unwrap()["agents"].as_array().unwrap().clone();
    let e = agents.iter().find(|a| a["name"] == json!("claude · T-卡住 #7001")).cloned().expect("要有這一筆");
    assert_eq!((e["kind"].as_str(), e["receivable"].as_bool(), e["status"].as_str(), e["detail"].as_str()), (Some("process"), Some(false), Some("running"), Some(DETAIL)));
    assert!(agents.iter().any(|a| a["name"] == json!("T-乙") && a.get("kind").is_none()), "正常視窗照舊");
}

#[tokio::test]
async fn 名單_沒有卡住的夥伴就沒有這一筆() {
    let h = awaiting_harness(vec![]).await;
    let posts = h.fr.rosters();
    let agents = posts.last().unwrap()["agents"].as_array().unwrap().clone();
    assert!(agents.iter().all(|a| a["kind"].as_str() != Some("process")));
}

#[tokio::test]
async fn 寄信給卡住的夥伴_直接回說明並_ack_不暫存() {
    let mut h = awaiting_harness(vec![stuck("T-卡住", 7001)]).await;
    h.fr.put(mail(1, json!({"to_agent": "T-卡住"})));
    h.core.pull("test", T0 + 10).await;
    assert!(h.said().is_empty(), "不能交給 worker：{:?}", h.said());
    let sent = h.fr.sent();
    assert_eq!(sent.len(), 1, "{sent:?}");
    // 寄回時 send_back 會拿掉開頭的「[收發室] 」（和「找不到」那句一樣，見 dev_prefix::without_old_head）
    assert_eq!(sent[0]["body"], "轉交給 T-卡住 沒有成功：視窗開著，但還沒進到對話（可能在等你按確認）。信沒有送達，請到那台電腦的視窗看清楚後自己選，再寄一次。");
    assert_eq!(h.fr.acked(), vec![uid(1)], "處理完了要 ack，不留在信箱");
    assert!(h.core.pending.is_empty());
}

#[tokio::test]
async fn 寄給別的不存在的名字_照舊說找不到() {
    let mut h = awaiting_harness(vec![stuck("T-卡住", 7001)]).await;
    h.fr.put(mail(2, json!({"to_agent": "T-不存在"})));
    h.core.pull("test", T0 + 10).await;
    let s = h.fr.sent();
    assert_eq!(s.len(), 1);
    assert!(s[0]["body"].as_str().unwrap().starts_with("找不到名叫「T-不存在」"), "{s:?}");
}

#[tokio::test]
async fn 有同名的活視窗_照舊轉交給它() {
    // 清單誤報了一個和活視窗同名的卡住夥伴：活視窗優先，信照舊交給 worker
    let mut h = awaiting_harness(vec![stuck("T-乙", 7002)]).await;
    h.fr.put(mail(3, json!({"to_agent": "T-乙"})));
    h.core.pull("test", T0 + 10).await;
    assert_eq!(h.said().len(), 1, "{:?}", h.said());
    assert!(h.fr.sent().is_empty(), "{:?}", h.fr.sent());
}

#[tokio::test]
async fn 同名兩個卡住的程序_不認_照舊說找不到() {
    let mut h = awaiting_harness(vec![stuck("T-卡住", 7001), stuck("T-卡住", 7003)]).await;
    h.fr.put(mail(4, json!({"to_agent": "T-卡住"})));
    h.core.pull("test", T0 + 10).await;
    let s = h.fr.sent();
    assert_eq!(s.len(), 1);
    assert!(s[0]["body"].as_str().unwrap().starts_with("找不到名叫「T-卡住」"), "{s:?}");
}

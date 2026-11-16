//! 視窗是用系統管理員身分開的（層級比 ASN 高）：收發室 worker 轉不進去，名單標出來、寄信直接回原因，不交給 worker。
//! 層級用假的（launch::integrity::checker 接假的查層級函式），不碰真的作業系統。
use super::rooms_launch::{rmsg, room, set_rooms};
use super::*;
use crate::launch::integrity::checker;

const MEDIUM: u32 = 0x2000;
const HIGH: u32 = 0x3000;
const LOW: u32 = 0x1000;

/// 視窗：T-高(5001，系統管理員)、T-普(5002)、T-讀不到(5003，層級讀不到)、T-低(5004，比 ASN 低)
async fn elevated_harness(own: Option<u32>) -> H {
    let fr = FakeRelay::start();
    let work = tempfile::tempdir().unwrap();
    let sessions = tempfile::tempdir().unwrap();
    for (pid, name) in [(5001u32, "T-高"), (5002, "T-普"), (5003, "T-讀不到"), (5004, "T-低")] {
        put_session(sessions.path(), pid, name, "idle", 100 + pid as u64);
    }
    let sink = Arc::new(FakeSink::default());
    let mut core = new_core(&fr, work.path(), sessions.path(), sink.clone(), T0);
    core.set_elevated_check(checker(
        |pid| match pid {
            5001 => Some(HIGH),
            5002 => Some(MEDIUM),
            5004 => Some(LOW),
            _ => None,
        },
        own,
    ));
    core.refresh_roster(T0).await;
    H { core, fr, sink, work, sessions }
}

#[tokio::test]
async fn 名單_視窗比_asn_高權限才標_同層級_比較低_讀不到都不標() {
    let h = elevated_harness(Some(MEDIUM)).await;
    let flag = |n: &str| h.core.roster.iter().find(|w| w.name == n).map(|w| w.elevated);
    assert_eq!(flag("T-高"), Some(true));
    assert_eq!(flag("T-普"), Some(false));
    assert_eq!(flag("T-讀不到"), Some(false));
    assert_eq!(flag("T-低"), Some(false));
    // 回報給後台的名單：只有被標的帶 elevated:true，其他沒有這個欄位
    let posts = h.fr.rosters();
    let agents = posts.last().unwrap()["agents"].as_array().unwrap().clone();
    let of = |n: &str| agents.iter().find(|a| a["name"] == json!(n)).cloned().unwrap();
    assert_eq!(of("T-高")["elevated"], json!(true));
    for n in ["T-普", "T-讀不到", "T-低"] {
        assert!(of(n).get("elevated").is_none(), "{n}");
    }
}

#[tokio::test]
async fn 名單_asn_自己也是系統管理員_或自己的層級讀不到_都不標() {
    for own in [Some(HIGH), None] {
        let h = elevated_harness(own).await;
        assert!(h.core.roster.iter().all(|w| !w.elevated), "own={own:?}");
    }
}

#[tokio::test]
async fn 寄信給系統管理員視窗_不交給_worker_直接回寄件人原因並_ack() {
    let mut h = elevated_harness(Some(MEDIUM)).await;
    h.fr.put(mail(1, json!({"to_agent": "T-高"})));
    h.core.pull("test", T0 + 10).await;
    assert!(h.said().is_empty(), "不能交給 worker：{:?}", h.said());
    let sent = h.fr.sent();
    assert_eq!(sent.len(), 1, "{sent:?}");
    let body = sent[0]["body"].as_str().unwrap();
    assert!(body.starts_with("[收發室] 轉交給 T-高 沒有成功：這個視窗是用系統管理員身分開的，收發室沒辦法把信轉進去。請用一般方式（不要用系統管理員）重開這個視窗。"), "{body}");
    assert!(h.fr.acked().contains(&uid(1)), "這封信處理完了要 ack");
    assert!(h.core.pending.is_empty());
    assert!(h.core.log.has("forward-fail kind=mail"));
}

#[tokio::test]
async fn 寄信給一般視窗_層級讀不到_比較低_照舊交給_worker() {
    let mut h = elevated_harness(Some(MEDIUM)).await;
    for (i, to) in ["T-普", "T-讀不到", "T-低"].iter().enumerate() {
        h.fr.put(mail(10 + i as u32, json!({"to_agent": to})));
    }
    h.core.pull("test", T0 + 10).await;
    assert_eq!(h.said().len(), 3, "三封都照舊交給 worker：{:?}", h.said());
    assert!(h.fr.sent().is_empty(), "沒有失敗通知：{:?}", h.fr.sent());
}

#[tokio::test]
async fn 群組點名系統管理員視窗_不交給_worker_群組貼一則說明_不叫人重新點名() {
    let mut h = elevated_harness(Some(MEDIUM)).await;
    set_rooms(&h, vec![room(vec![rmsg(2, json!({"forMe": {"T-高": true}}))], json!([{"member": "T~T-高", "read_seq": 1}]))]);
    h.core.pull("test", T0 + 10).await;
    assert!(h.said().is_empty(), "不能交給 worker：{:?}", h.said());
    let posts = h.fr.st.lock().unwrap().room_posts.clone();
    assert_eq!(posts.len(), 1, "{posts:?}");
    let body = posts[0]["body"].as_str().unwrap();
    assert!(body.contains("#2") && body.contains("轉交給 T-高 沒有成功：這個視窗是用系統管理員身分開的") && !body.contains("重新點名") && !body.contains('@'), "{body}");
}

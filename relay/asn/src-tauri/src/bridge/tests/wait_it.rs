//! 夥伴卡在框上超過兩分鐘通知本人的整合測試。session 檔的欄位取自 Claude 2.1.318 實測。
use super::*;
use crate::bridge::roster;

const W: u64 = crate::bridge::wait_alert::WAIT_AFTER_MS;

/// 真的 session 檔長這樣（隔離環境實測）：hook 確認框與權限框是 permission prompt，選擇框是 input needed
fn put_waiting(dir: &std::path::Path, pid: u32, name: &str, sid: &str, waiting_for: &str, since: u64) {
    let v = json!({"pid": pid, "sessionId": sid, "cwd": "D:\\x", "startedAt": since, "version": "2.1.318", "peerProtocol": 1, "kind": "interactive", "entrypoint": "cli",
        "name": name, "nameSource": "cli", "updatedAt": since, "status": "waiting", "waitingFor": waiting_for, "statusUpdatedAt": since});
    std::fs::write(dir.join(format!("{pid}.json")), v.to_string()).unwrap();
}

async fn rig(wait_alert: bool) -> H {
    let mut h = harness(&[("T-乙", "idle")]).await;
    h.core.cfg.wait_alert = wait_alert;
    h
}

async fn tick_at(h: &mut H, now: u64) {
    h.core.refresh_roster(now).await;
    h.core.wait_notice_tick(now).await;
}

#[tokio::test]
async fn hook_確認框等滿兩分鐘_只帶視窗名和種類_不帶內容_只通知一次() {
    let mut h = rig(true).await;
    put_waiting(h.sessions.path(), 5100, "T-丙", "sid-c", "permission prompt", T0);
    tick_at(&mut h, T0 + W - 1).await;
    assert!(h.fr.wait_notices().is_empty(), "還沒滿兩分鐘");
    tick_at(&mut h, T0 + W).await;
    tick_at(&mut h, T0 + W + 60_000).await;
    let n = h.fr.wait_notices();
    assert_eq!(n.len(), 1, "同一次等待只通知一次：{n:?}");
    assert_eq!((n[0]["window"].as_str(), n[0]["kind"].as_str()), (Some("T-丙"), Some("permission")));
    assert!(n[0]["detail"].is_null(), "權限框不帶內容：{}", n[0]);
    assert!(h.core.log.has("wait-alert window=T-丙 kind=permission"));
}

#[tokio::test]
async fn 權限框有外掛回報就帶工具名_不合格的不帶() {
    let mut h = rig(true).await;
    let dir = h.core.cfg.status_dir.clone();
    std::fs::create_dir_all(&dir).unwrap();
    let doc = |sid: &str, tool: &str| json!({"sessionId": sid, "state": "busy", "detail": "", "at": T0, "waitingTool": tool}).to_string();
    std::fs::write(dir.join("sid-c.json"), doc("sid-c", "Bash")).unwrap();
    std::fs::write(dir.join("sid-d.json"), doc("sid-d", "rm -rf /")).unwrap();
    put_waiting(h.sessions.path(), 5100, "T-丙", "sid-c", "permission prompt", T0);
    put_waiting(h.sessions.path(), 5101, "T-丁", "sid-d", "permission prompt", T0);
    tick_at(&mut h, T0 + W).await;
    let n = h.fr.wait_notices();
    let of = |name: &str| n.iter().find(|x| x["window"] == name).cloned().unwrap();
    assert_eq!(of("T-丙")["tool"], "Bash");
    assert!(of("T-丁")["tool"].is_null());
}

#[tokio::test]
async fn 開關沒開就不通知() {
    let mut h = rig(false).await;
    put_waiting(h.sessions.path(), 5100, "T-丙", "sid-c", "permission prompt", T0);
    tick_at(&mut h, T0 + W * 10).await;
    assert!(h.fr.wait_notices().is_empty());
}

#[tokio::test]
async fn 選擇框帶問題和選項_其他框不讀外掛的內容() {
    let mut h = rig(true).await;
    let dir = h.core.cfg.status_dir.clone();
    std::fs::create_dir_all(&dir).unwrap();
    let doc = |sid: &str| json!({"sessionId": sid, "state": "waiting_user", "detail": "x", "at": T0, "prompt": {"question": "要選哪一個？", "options": ["甲", "乙"]}}).to_string();
    std::fs::write(dir.join("sid-c.json"), doc("sid-c")).unwrap();
    std::fs::write(dir.join("sid-d.json"), doc("sid-d")).unwrap();
    put_waiting(h.sessions.path(), 5100, "T-丙", "sid-c", "input needed", T0);
    put_waiting(h.sessions.path(), 5101, "T-丁", "sid-d", "dialog open", T0);
    tick_at(&mut h, T0 + W).await;
    let n = h.fr.wait_notices();
    let of = |name: &str| n.iter().find(|x| x["window"] == name).cloned().unwrap();
    assert_eq!(of("T-丙")["kind"], "input");
    assert_eq!(of("T-丙")["detail"], "問題：要選哪一個？；選項：甲、乙");
    assert_eq!(of("T-丁")["kind"], "other");
    assert!(of("T-丁")["detail"].is_null());
}

#[tokio::test]
async fn 後台失敗不算通知過_隔一分鐘再試() {
    let mut h = rig(true).await;
    h.fr.st.lock().unwrap().wait_notice_status = 500;
    put_waiting(h.sessions.path(), 5100, "T-丙", "sid-c", "permission prompt", T0);
    tick_at(&mut h, T0 + W).await;
    assert!(h.core.log.has("wait-alert failed window=T-丙"));
    h.fr.st.lock().unwrap().wait_notice_status = 0;
    tick_at(&mut h, T0 + W + 1_000).await;
    assert!(h.fr.wait_notices().is_empty(), "還沒到重試時間");
    tick_at(&mut h, T0 + W + 60_000).await;
    assert_eq!(h.fr.wait_notices().len(), 1);
}

#[tokio::test]
async fn 後台回沒寄到不算通知過_隔一分鐘再試_查不到擁有者才結束() {
    for notify in ["failed", "rate_limited", "看不懂"] {
        let mut h = rig(true).await;
        h.fr.st.lock().unwrap().wait_notice_notify = notify.into();
        put_waiting(h.sessions.path(), 5100, "T-丙", "sid-c", "permission prompt", T0);
        tick_at(&mut h, T0 + W).await;
        assert_eq!(h.fr.wait_notices().len(), 1, "{notify}");
        assert!(h.core.log.has(&format!("notify={notify}")), "{notify}：log 要看得出來");
        tick_at(&mut h, T0 + W + 1_000).await;
        assert_eq!(h.fr.wait_notices().len(), 1, "{notify}：還沒到重試時間");
        h.fr.st.lock().unwrap().wait_notice_notify = String::new();
        tick_at(&mut h, T0 + W + 60_000).await;
        assert_eq!(h.fr.wait_notices().len(), 2, "{notify}：再試一次");
        tick_at(&mut h, T0 + W + 120_000).await;
        assert_eq!(h.fr.wait_notices().len(), 2, "{notify}：寄到了就不再通知");
    }
    let mut h = rig(true).await;
    h.fr.st.lock().unwrap().wait_notice_notify = "skipped".into();
    put_waiting(h.sessions.path(), 5100, "T-丙", "sid-c", "permission prompt", T0);
    tick_at(&mut h, T0 + W).await;
    tick_at(&mut h, T0 + W + 600_000).await;
    assert_eq!(h.fr.wait_notices().len(), 1, "查不到擁有者：再試也沒用");
    assert!(h.core.log.has("notify=skipped"));
}

#[tokio::test]
async fn session_檔沒有狀態欄位_名單標狀態不明_留紀錄_不當成沒有卡() {
    let mut h = rig(true).await;
    let v = json!({"pid": 5100, "sessionId": "sid-c", "cwd": "D:\\x", "kind": "interactive", "entrypoint": "cli", "name": "T-丙", "updatedAt": T0});
    std::fs::write(h.sessions.path().join("5100.json"), v.to_string()).unwrap();
    tick_at(&mut h, T0 + W).await;
    let w = h.core.roster.iter().find(|w| w.name == "T-丙").unwrap();
    assert_eq!(w.detail.as_deref(), Some(roster::UNKNOWN_STATUS_DETAIL));
    assert!(h.core.log.has("session file has no status"));
    assert!(h.fr.wait_notices().is_empty());
}

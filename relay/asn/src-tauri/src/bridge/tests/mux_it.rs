//! 共用的終端服務中斷：通知本人（mux_down_notice）的整合測試。電腦端排通知檔、橋接核心下一輪呼叫後台。
use super::*;
use crate::launch::mux_watch;

fn now() -> u64 {
    crate::heartbeat::now_ms()
}

#[tokio::test]
async fn 有排通知就呼叫一次_只帶人數和有沒有接回_寄出後檔案刪掉() {
    let mut h = harness(&[("T-乙", "idle")]).await;
    let dir = h.core.cfg.work_dir.clone();
    h.core.mux_notice_tick(T0).await;
    assert!(h.fr.mux_notices().is_empty(), "沒排就不呼叫");
    mux_watch::queue_notice(&dir, 2, true, now());
    h.core.mux_notice_tick(T0).await;
    h.core.mux_notice_tick(T0 + 1_000).await;
    let n = h.fr.mux_notices();
    assert_eq!(n.len(), 1, "一次事故只呼叫一次：{n:?}");
    assert_eq!((n[0]["count"].as_u64(), n[0]["resumed"].as_bool()), (Some(2), Some(true)));
    assert!(n[0].get("name").is_none() && n[0].get("partners").is_none(), "不帶夥伴名字：{}", n[0]);
    assert!(mux_watch::read_notice(&dir).is_none());
    assert!(h.core.log.has("mux-notice count=2 resumed=true notify=sent"));
}

#[tokio::test]
async fn 寄送失敗隔一分鐘再試_成功後停() {
    let mut h = harness(&[("T-乙", "idle")]).await;
    let dir = h.core.cfg.work_dir.clone();
    h.fr.st.lock().unwrap().mux_notice_notify = "failed".into();
    mux_watch::queue_notice(&dir, 1, false, now());
    h.core.mux_notice_tick(T0).await;
    h.core.mux_notice_tick(T0 + 30_000).await;
    assert_eq!(h.fr.mux_notices().len(), 1, "一分鐘內不重試");
    assert!(mux_watch::read_notice(&dir).is_some(), "沒寄到，檔要留著");
    h.fr.st.lock().unwrap().mux_notice_notify = "sent".into();
    h.core.mux_notice_tick(T0 + 61_000).await;
    assert_eq!(h.fr.mux_notices().len(), 2);
    assert!(mux_watch::read_notice(&dir).is_none());
}

#[tokio::test]
async fn 舊後台_參數不合_節點停用_只留本機提示_不重試() {
    for status in [404u16, 400, 403] {
        let mut h = harness(&[("T-乙", "idle")]).await;
        let dir = h.core.cfg.work_dir.clone();
        h.fr.st.lock().unwrap().mux_notice_status = status;
        mux_watch::queue_notice(&dir, 1, true, now());
        h.core.mux_notice_tick(T0).await;
        h.core.mux_notice_tick(T0 + 120_000).await;
        assert_eq!(h.fr.mux_notices().len(), 1, "{status} 不重試");
        assert!(mux_watch::read_notice(&dir).is_none());
        assert!(h.core.log.has(&format!("後台回 {status}")));
    }
}

#[tokio::test]
async fn 事故過了十分鐘還沒通知成功就放棄() {
    let mut h = harness(&[("T-乙", "idle")]).await;
    let dir = h.core.cfg.work_dir.clone();
    mux_watch::queue_notice(&dir, 1, true, now().saturating_sub(601_000));
    h.core.mux_notice_tick(T0).await;
    assert!(h.fr.mux_notices().is_empty());
    assert!(mux_watch::read_notice(&dir).is_none());
}

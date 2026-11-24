//! 重新啟動前收橋（#2204）：停止收新信、等進行中的送出／ack 做完才放手，逾時照舊 abort。
//! 這裡用「手工組出的 Running ＋假的主迴圈」測 drain 的接線（通知離開、等迴圈結束、逾時）；
//! 主迴圈「一次處理一個動作、處理完才看離開訊號」是 tokio::select 的語意，見 run_loop。
use super::super::*;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

/// 假主迴圈：像 run_loop 一樣，一個動作做到完（`work_ms`）才回頭看離開訊號
fn fake_running(work_ms: u64) -> (Running, Arc<AtomicBool>, tempfile::TempDir) {
    let dir = tempfile::tempdir().unwrap();
    let shutdown = Arc::new(Notify::new());
    let loop_done = Arc::new(AtomicBool::new(false));
    let finished_send = Arc::new(AtomicBool::new(false));
    let (sd, fin, guard) = (shutdown.clone(), finished_send.clone(), LoopDone(loop_done.clone()));
    let t = crate::rt::spawn(async move {
        let _done = guard;
        // 進行中的送出：先做，做完才輪到離開訊號
        tokio::time::sleep(Duration::from_millis(work_ms)).await;
        fin.store(true, Ordering::SeqCst);
        sd.notified().await;
    });
    let lock = lock::BridgeLock::acquire(dir.path(), std::process::id(), |_| false).unwrap();
    let r = Running { shutdown, worker: None, lock, tasks: vec![t], engines: None, log: Arc::new(BridgeLog::new(None)), loop_done };
    (r, finished_send, dir)
}

#[tokio::test]
async fn _2204_drain_進行中的送出做完才回來() {
    let (r, finished, _d) = fake_running(300);
    assert!(!finished.load(Ordering::SeqCst));
    assert!(r.drain(Duration::from_secs(5)).await, "時限內做完要回 true");
    assert!(finished.load(Ordering::SeqCst), "drain 回來時，進行中的送出一定已經做完");
}

#[tokio::test]
async fn _2204_drain_超過時限就放棄_回_false_之後_stop_照舊_abort() {
    let (r, finished, _d) = fake_running(5_000);
    let t0 = std::time::Instant::now();
    assert!(!r.drain(Duration::from_millis(150)).await, "逾時要回 false");
    assert!(t0.elapsed() < Duration::from_secs(2), "不能等到動作自己做完");
    assert!(!finished.load(Ordering::SeqCst));
    r.stop();
    assert!(wait_flag(&r.loop_done, Duration::from_secs(2), Duration::from_millis(20)).await, "stop 照舊 abort，迴圈任務結束後旗標也要設起來");
    assert!(!finished.load(Ordering::SeqCst), "被 abort 的動作不會做完");
}

#[tokio::test]
async fn _2204_wait_flag_旗標設起來才回_true_逾時回_false() {
    let flag = Arc::new(AtomicBool::new(false));
    let f2 = flag.clone();
    crate::rt::spawn(async move {
        tokio::time::sleep(Duration::from_millis(150)).await;
        f2.store(true, Ordering::SeqCst);
    });
    assert!(!wait_flag(&flag, Duration::from_millis(30), Duration::from_millis(10)).await);
    assert!(wait_flag(&flag, Duration::from_secs(3), Duration::from_millis(10)).await);
}

#[tokio::test]
async fn _2204_一般_stop_不等進行中的動作_語意不變() {
    let (r, finished, _d) = fake_running(5_000);
    r.stop();
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert!(!finished.load(Ordering::SeqCst), "一般 stop 直接 abort，不 drain");
}

#[tokio::test]
async fn _2204_manager_橋沒在跑_收橋回_false_恢復也不會硬開() {
    let d = tempfile::tempdir().unwrap();
    let m = Manager::new(None, None, "T".into(), d.path().to_path_buf(), d.path().to_path_buf());
    assert!(!m.drain_for_relaunch(Duration::from_millis(50)).await);
    m.resume_after_failed_relaunch(false);
    assert!(!m.status().running);
}

#[tokio::test]
async fn _2204_manager_收橋拿走_running_並放掉收信鎖() {
    let d = tempfile::tempdir().unwrap();
    let m = Manager::new(None, None, "T".into(), d.path().to_path_buf(), d.path().to_path_buf());
    let (r, _fin, _rd) = fake_running(10);
    m.inner.lock().unwrap().running = Some(r);
    assert!(m.status().running);
    assert!(m.drain_for_relaunch(Duration::from_secs(3)).await, "收橋前橋在跑要回 true");
    assert!(!m.status().running, "收橋後 Manager 不再持有橋");
}

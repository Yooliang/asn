//! 重新啟動前收橋（#2204）：停止收新信、等進行中的送出／ack 做完才放手，逾時照舊 abort。
//! 這裡用「手工組出的 Running ＋假的主迴圈」測 drain 的接線（通知離開、等迴圈結束、逾時）；
//! 主迴圈「一次處理一個動作、處理完才看離開訊號」是 tokio::select 的語意，見 run_loop。
use super::super::*;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

/// 假主迴圈：像 run_loop 一樣，一個動作做到完（`work_ms`）才回頭看離開訊號
fn fake_running(work_ms: u64) -> (Running, Arc<AtomicBool>, tempfile::TempDir) {
    fake_with(async move { tokio::time::sleep(Duration::from_millis(work_ms)).await })
}

/// 假主迴圈，進行中的動作由 `gate` 放行才做完（事件驅動，不靠牆鐘）：
/// 機器忙到測試執行緒被卡住時，動作也不會自己先做完（#2297）
fn fake_gated() -> (Running, Arc<AtomicBool>, Arc<Notify>, tempfile::TempDir) {
    let gate = Arc::new(Notify::new());
    let g = gate.clone();
    let (r, fin, d) = fake_with(async move { g.notified().await });
    (r, fin, gate, d)
}

fn fake_with(work: impl std::future::Future<Output = ()> + Send + 'static) -> (Running, Arc<AtomicBool>, tempfile::TempDir) {
    let dir = tempfile::tempdir().unwrap();
    let shutdown = Arc::new(Notify::new());
    let loop_done = Arc::new(AtomicBool::new(false));
    let finished_send = Arc::new(AtomicBool::new(false));
    let (sd, fin, guard) = (shutdown.clone(), finished_send.clone(), LoopDone(loop_done.clone()));
    let t = crate::rt::spawn(async move {
        let _done = guard;
        // 進行中的送出：先做，做完才輪到離開訊號
        work.await;
        fin.store(true, Ordering::SeqCst);
        sd.notified().await;
    });
    let lock = lock::BridgeLock::acquire(dir.path(), std::process::id(), |_| false).unwrap();
    let r = Running { shutdown, worker: None, lock, tasks: vec![t], engines: None, log: Arc::new(BridgeLog::new(None)), loop_done };
    (r, finished_send, dir)
}

#[tokio::test]
async fn _2204_drain_進行中的送出做完才回來() {
    // 動作要等 gate 放行才做完：開始 drain 時動作一定還在進行，之後放行 drain 才能回來。
    // 放行前的等待只是讓 drain 真的先卡住一下；就算機器忙到它提早放行，結論（drain 回來時一定做完）也不變。
    // 「drain 回來的那一刻動作做完了沒」要在 drain 回來當下量，不能等 join 完才看（那時放行早已發生，drain 提早回來也看不出來）
    let (r, finished, gate, _d) = fake_gated();
    assert!(!finished.load(Ordering::SeqCst), "放行前動作不會做完");
    let drained = async {
        let ok = r.drain(Duration::from_secs(30)).await;
        (ok, finished.load(Ordering::SeqCst))
    };
    let release = async {
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert!(!finished.load(Ordering::SeqCst), "drain 還在等：動作沒放行就不會做完");
        gate.notify_one();
    };
    let ((ok, finished_at_return), _) = tokio::join!(drained, release);
    assert!(ok, "放行後要回 true（30 秒只是防掛死的上限）");
    assert!(finished_at_return, "drain 回來的那一刻，進行中的送出一定已經做完");
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
    let (r, _fin, rd) = fake_running(10);
    let pid_file = lock::pid_file(rd.path());
    assert!(pid_file.exists(), "收橋前持有收信鎖");
    m.inner.lock().unwrap().running = Some(r);
    assert!(m.status().running);
    assert!(m.drain_for_relaunch(Duration::from_secs(3)).await, "收橋前橋在跑要回 true");
    assert!(!m.status().running, "收橋後 Manager 不再持有橋");
    assert!(!pid_file.exists(), "收信鎖要真的放掉，新程序才拿得到");
}

#[tokio::test]
async fn _2204_復原失敗要寫_bridge_log_橋沒在跑則不啟動也不寫() {
    let d = tempfile::tempdir().unwrap();
    // 沒有節點金鑰 → try_start 一定失敗
    let m = Manager::new(None, None, "T".into(), d.path().to_path_buf(), d.path().to_path_buf());
    let log = d.path().join("bridge.log");
    m.resume_after_failed_relaunch(false);
    assert!(!m.status().running && !log.exists(), "原本沒在跑：不啟動、不寫 log");
    m.resume_after_failed_relaunch(true);
    assert!(!m.status().running);
    assert!(m.status().error.is_some(), "失敗原因要存起來");
    let text = std::fs::read_to_string(&log).expect("復原失敗要寫 bridge.log");
    assert!(text.contains("failed to resume bridge"), "log 內容：{text}");
}

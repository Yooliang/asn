//! #2462：已停止（stop）、已被遠端管理關閉（admin_stop）的工作者，列名單時的「試著喚回」不能再把它暖機起來；
//! 另補「啟動中被停止、又馬上啟動」：第一支要被停掉、不留下，第二支正常完成並成為目前的驅動
use super::{Driver, Health, TurnResult, Worker, WorkerHandle, WorkerInit};
use crate::bridge::engines::acp_approvals::Approvals;
use crate::bridge::engines::acp_config::normalize_worker;
use crate::bridge::engines::acp_policy::WorkerError;
use crate::bridge::engines::{BoxFut, EngineEvent, PidBook};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

/// 假驅動：start 可以先卡住（release 沒開就不返回）、可以回「起不來」；stop 記下來
struct Fake {
    id: String,
    alive: AtomicBool,
    stopped: AtomicBool,
    release: AtomicBool,
    fail_spawn: bool,
}

impl Driver for Fake {
    fn session_id(&self) -> String {
        self.id.clone()
    }
    fn resume_lost(&self) -> bool {
        false
    }
    fn alive(&self) -> bool {
        self.alive.load(Ordering::SeqCst)
    }
    fn touch(&self) {}
    fn start(&self) -> BoxFut<'_, Result<(), WorkerError>> {
        Box::pin(async move {
            while !self.release.load(Ordering::SeqCst) {
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
            if self.fail_spawn {
                let mut e = WorkerError::new("crash", "測試：起不來");
                e.spawn_failed = true;
                return Err(e);
            }
            Ok(())
        })
    }
    fn turn(&self, _text: String, _t: u64, _m: u64) -> BoxFut<'_, Result<TurnResult, WorkerError>> {
        Box::pin(async { Err(WorkerError::new("stopped", "測試")) })
    }
    fn stop(&self) {
        self.stopped.store(true, Ordering::SeqCst);
        self.alive.store(false, Ordering::SeqCst);
    }
}

struct Rig {
    w: WorkerHandle,
    made: Arc<Mutex<Vec<Arc<Fake>>>>,
    hold: Arc<AtomicBool>,
    notices: Arc<AtomicUsize>,
    rx: tokio::sync::mpsc::UnboundedReceiver<EngineEvent>,
    _dir: tempfile::TempDir,
}

impl Rig {
    fn count(&self) -> usize {
        self.made.lock().unwrap().len()
    }
    /// 把「上次試的時間」撥回很久以前＝已超過重試間隔
    fn age(&self) {
        self.w.st.lock().unwrap().last_try_at = 0;
    }
    fn settled(&self) -> bool {
        !self.w.st.lock().unwrap().starting
    }
    fn failed_events(&mut self) -> usize {
        let mut n = 0;
        while let Ok(e) = self.rx.try_recv() {
            if matches!(e, EngineEvent::Fail(..) | EngineEvent::UpstreamFail { .. }) {
                n += 1;
            }
        }
        n
    }
}

fn rig(fail_spawn: bool, hold: bool) -> Rig {
    let dir = tempfile::tempdir().unwrap();
    let cfg = normalize_worker(&serde_json::json!({"name": "A", "engine": "acp", "command": "x", "protocol": "acp"}), std::path::Path::new("/wd"), 0).unwrap().0;
    let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
    let made: Arc<Mutex<Vec<Arc<Fake>>>> = Arc::new(Mutex::new(vec![]));
    let hold = Arc::new(AtomicBool::new(hold));
    let notices = Arc::new(AtomicUsize::new(0));
    let (m2, h2) = (made.clone(), hold.clone());
    let make_driver: super::MakeDriver = Arc::new(move |_a| {
        let mut g = m2.lock().unwrap();
        let f = Arc::new(Fake { id: format!("d{}", g.len() + 1), alive: AtomicBool::new(true), stopped: AtomicBool::new(false), release: AtomicBool::new(!h2.load(Ordering::SeqCst)), fail_spawn });
        g.push(f.clone());
        f
    });
    let n2 = notices.clone();
    let w = Worker::new(WorkerInit {
        cfg: Arc::new(cfg),
        env: Arc::new(crate::bridge::engines::acp_sensitive::env_without_homes()),
        log: Arc::new(|_| {}),
        approvals: Approvals::new(),
        notify: Arc::new(move |_| {
            n2.fetch_add(1, Ordering::SeqCst);
        }),
        store: super::Store::open(dir.path().join("acp-workers.json"), Arc::new(|_| {})),
        make_driver,
        events: tx,
        pids: PidBook::new(dir.path()),
        handoff_dir: None,
        work_dir: dir.path().to_path_buf(),
        real_home: dir.path().to_path_buf(),
        record_model_on_start: None,
    });
    Rig { w, made, hold, notices, rx, _dir: dir }
}

async fn wait(f: impl Fn() -> bool) -> bool {
    for _ in 0..100 {
        if f() {
            return true;
        }
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
    false
}

/// 讓工作者進入「起不來（不可用）」並確認「超過重試間隔且沒停止」時喚回照常會再試（對照組），回到安靜的狀態
async fn unavailable_and_revivable(r: &Rig) {
    r.w.start();
    assert!(wait(|| r.w.st.lock().unwrap().health == Health::Unavailable && r.settled()).await, "起不來之後要變成不可用");
    assert_eq!(r.count(), 1);
    r.age();
    r.w.maybe_revive();
    assert!(wait(|| r.count() == 2).await, "對照：沒停止時超過重試間隔，喚回要再試一次");
    assert!(wait(|| r.settled()).await);
}

#[tokio::test]
async fn admin_stop_之後列名單不會再把它喚回() {
    let r = rig(true, false);
    unavailable_and_revivable(&r).await;
    r.w.admin_stop().unwrap();
    r.age();
    r.w.maybe_revive();
    tokio::time::sleep(std::time::Duration::from_millis(300)).await;
    assert_eq!(r.count(), 2, "已被遠端管理關閉：不能再建新的驅動");
    assert!(r.w.admin_stopped());
}

#[tokio::test]
async fn stop_之後列名單不會再把它喚回() {
    let r = rig(true, false);
    unavailable_and_revivable(&r).await;
    r.w.stop();
    r.age();
    r.w.maybe_revive();
    tokio::time::sleep(std::time::Duration::from_millis(300)).await;
    assert_eq!(r.count(), 2, "已停止：不能再建新的驅動");
}

#[tokio::test]
async fn 啟動中被停止又馬上啟動_第一支被停掉不留下_第二支正常成為目前的驅動() {
    let mut r = rig(false, true);
    r.w.start();
    assert!(wait(|| r.count() == 1).await, "第一支驅動開始啟動（卡住）");
    r.w.stop();
    r.hold.store(false, Ordering::SeqCst); // 之後建的驅動不卡
    r.w.start(); // 新的暖機要等前一次啟動
    r.made.lock().unwrap()[0].release.store(true, Ordering::SeqCst);
    assert!(wait(|| r.count() == 2).await, "第二支驅動要建出來（第一支啟動完成時回「被停止」，新的暖機照常啟動）");
    assert!(wait(|| r.settled() && r.w.st.lock().unwrap().driver.is_some()).await);
    let (d1, d2) = (r.made.lock().unwrap()[0].clone(), r.made.lock().unwrap()[1].clone());
    assert!(d1.stopped.load(Ordering::SeqCst), "第一支要被停掉");
    assert!(!d2.stopped.load(Ordering::SeqCst), "第二支沒被停");
    let cur = r.w.st.lock().unwrap().driver.clone().map(|d| d.session_id());
    assert_eq!(cur.as_deref(), Some("d2"), "目前的驅動是第二支");
    let s = r.w.st.lock().unwrap();
    assert_eq!(s.health, Health::Ok, "健康狀態不變");
    assert!(s.start_error.is_empty(), "不留啟動失敗的原因");
    drop(s);
    assert_eq!(r.failed_events(), 0, "沒有失敗通知");
    assert_eq!(r.notices.load(Ordering::SeqCst), 0, "沒有寄出任何通知");
}

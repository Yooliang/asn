//! ASN 內建收發室橋（全 Rust，只做 Claude 引擎）。設計見 docs/design/BRIDGE-RUST.md。
//! 預設關閉：設定「讓 ASN 負責這台的收發室」打開才啟動；關閉時 ASN 的行為與以前完全一樣。
//! 舊 Node 橋在跑（bridge.pid 的 pid 活著）時內建橋不啟動，設定頁顯示由舊版負責。
pub mod core;
pub mod handoff;
pub mod lock;
pub mod mail;
pub mod pending;
pub mod roster;
pub mod worker;

#[cfg(test)]
mod tests;

use crate::relay::Relay;
use core::{BridgeLog, Config, Core};
use serde::Serialize;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use tokio::sync::{mpsc, Notify};
use worker::{ProcWorker, WorkerLine, WorkerSink, WorkerSpec};

// ---- 設定檔（data_dir/bridge.json，與 settings.json 分開，改名流程不會蓋掉它）-------------------------

#[derive(Clone, Copy, Debug, PartialEq, Default)]
pub struct BridgeSettings {
    /// 讓 ASN 負責這台的收發室（預設關）
    pub enabled: bool,
    /// 允許「改由 ASN 負責」按鈕停掉舊版收發室橋（預設關，這一版先不開放）
    pub allow_takeover: bool,
}

pub fn settings_path(data_dir: &Path) -> PathBuf {
    data_dir.join("bridge.json")
}
pub fn read_settings(data_dir: &Path) -> BridgeSettings {
    let Ok(text) = std::fs::read_to_string(settings_path(data_dir)) else { return BridgeSettings::default() };
    let Ok(v) = serde_json::from_str::<Value>(&text) else { return BridgeSettings::default() };
    BridgeSettings { enabled: v.get("enabled").and_then(Value::as_bool).unwrap_or(false), allow_takeover: v.get("allow_takeover").and_then(Value::as_bool).unwrap_or(false) }
}
pub fn write_settings(data_dir: &Path, s: BridgeSettings) -> Result<(), String> {
    crate::write_atomic(&settings_path(data_dir), &json!({ "enabled": s.enabled, "allow_takeover": s.allow_takeover }).to_string()).map_err(|e| e.to_string())
}

// ---- 執行 --------------------------------------------------------------------------------------

pub struct Running {
    shutdown: Arc<Notify>,
    worker: ProcWorker,
    lock: lock::BridgeLock,
    tasks: Vec<tauri::async_runtime::JoinHandle<()>>,
    #[cfg_attr(not(test), allow(dead_code))]
    pub log: Arc<BridgeLog>,
}

impl Running {
    /// 結束：停掉迴圈與門鈴，關掉自己啟動的 worker（只關記下的 PID），刪 mailbox.pid，釋放鎖（只刪自己的 bridge.pid）
    pub fn stop(&self) {
        self.shutdown.notify_one();
        for t in &self.tasks {
            t.abort();
        }
        self.worker.stop();
        self.lock.release();
    }
}

#[derive(Debug)]
pub enum StartError {
    /// 另一個收信者（舊橋）的 pid
    #[allow(dead_code)]
    HeldBy(u32),
    Other(String),
}

/// 啟動內建橋（要在 tokio 執行環境裡呼叫）。anon_url＝門鈴的 WebSocket 網址（沒有就只剩輪詢）
pub fn start(cfg: Config, relay: Arc<Relay>, anon_url: Option<String>) -> Result<Running, StartError> {
    let lock = lock::BridgeLock::acquire(&cfg.work_dir, std::process::id(), crate::heartbeat::pid_alive).map_err(|e| match e {
        lock::LockError::HeldBy(p) => StartError::HeldBy(p),
        lock::LockError::Io(m) => StartError::Other(format!("拿不到收信鎖：{m}")),
    })?;
    let log = Arc::new(BridgeLog::new(Some(cfg.work_dir.join("bridge.log"))));
    let nonce = worker::new_nonce();
    let spec = WorkerSpec {
        bin: cfg.claude_bin.clone(),
        pre_args: cfg.claude_pre.clone(),
        mailbox_name: cfg.mailbox_name.clone(),
        model: cfg.model.clone(),
        work_dir: cfg.work_dir.clone(),
        nonce: nonce.clone(),
        extra_env: cfg.extra_env.clone(),
    };
    let wlog = log.clone();
    let (w, lines) = ProcWorker::spawn(spec, move |l| wlog.line(&l));
    let sink: Arc<dyn WorkerSink> = Arc::new(w.clone());
    log.line(&format!("bridge starting node={} mailbox={} (ASN built-in)", cfg.node, cfg.mailbox_name));
    let alive: Arc<dyn Fn(u32) -> bool + Send + Sync> = Arc::new(crate::heartbeat::pid_alive);
    let wake = Arc::new(Notify::new());
    let shutdown = Arc::new(Notify::new());
    let core = Core::new(cfg.clone(), relay.clone(), sink, &nonce, log.clone(), alive, crate::heartbeat::now_ms());
    let mut tasks = vec![];
    tasks.push(tauri::async_runtime::spawn(run_loop(core, lines, wake.clone(), shutdown.clone())));
    match anon_url {
        Some(url) => {
            let (w2, l2) = (wake, log.clone());
            tasks.push(tauri::async_runtime::spawn(async move {
                let topic = loop {
                    match relay.api("whoami", None).await {
                        Ok(v) => match v.get("bell_topic").and_then(Value::as_str) {
                            Some(t) => break t.to_string(),
                            None => tokio::time::sleep(std::time::Duration::from_secs(10)).await,
                        },
                        Err(e) => {
                            l2.line(&format!("whoami failed: {e}"));
                            tokio::time::sleep(std::time::Duration::from_secs(5)).await
                        }
                    }
                };
                crate::bell::run(url, topic, move |_| w2.notify_one()).await;
            }));
        }
        None => log.line("no anon key: doorbell off, polling only"),
    }
    Ok(Running { shutdown, worker: w, lock, tasks, log })
}

fn now() -> u64 {
    crate::heartbeat::now_ms()
}

/// 主迴圈：worker 輸出、門鈴、2 分鐘輪詢、名單、逾時檢查，全部在同一個任務裡依序處理
pub async fn run_loop(mut core: Core, mut lines: mpsc::UnboundedReceiver<WorkerLine>, wake: Arc<Notify>, shutdown: Arc<Notify>) {
    let every = |ms: u64| {
        let mut i = tokio::time::interval(std::time::Duration::from_millis(ms.max(10)));
        i.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        i
    };
    let (mut poll, mut roster, mut tick) = (every(core.cfg.poll_ms), every(core.cfg.roster_ms), every(core.cfg.tick_ms));
    poll.tick().await;
    roster.tick().await;
    tick.tick().await;
    core.refresh_roster(now()).await;
    core.pull("startup", now()).await;
    loop {
        tokio::select! {
            Some(l) = lines.recv() => core.on_worker_line(l, now()).await,
            _ = wake.notified() => core.pull("bell", now()).await,
            _ = poll.tick() => core.pull("poll", now()).await,
            _ = roster.tick() => core.refresh_roster(now()).await,
            _ = tick.tick() => {
                core.tick(now()).await;
                if core.retry_due(now()) { core.pull("retry", now()).await }
            }
            _ = shutdown.notified() => break,
        }
    }
    core.flush();
}

// ---- 管理（給設定頁用）---------------------------------------------------------------------------

#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct Status {
    /// 設定：讓 ASN 負責這台的收發室
    pub enabled: bool,
    /// 內建橋正在跑
    pub running: bool,
    /// 這台的收發室目前由舊版收發室橋負責
    pub legacy: bool,
    /// 「改由 ASN 負責」按鈕是否開放
    pub takeover_allowed: bool,
    pub error: Option<String>,
}

pub struct Manager {
    relay: Option<Arc<Relay>>,
    anon_url: Option<String>,
    node: String,
    work_dir: PathBuf,
    data_dir: PathBuf,
    inner: Mutex<Inner>,
}
#[derive(Default)]
struct Inner {
    running: Option<Running>,
    error: Option<String>,
}

impl Manager {
    pub fn new(relay: Option<Arc<Relay>>, anon_url: Option<String>, node: String, work_dir: PathBuf, data_dir: PathBuf) -> Manager {
        Manager { relay, anon_url, node, work_dir, data_dir, inner: Mutex::new(Inner::default()) }
    }

    fn legacy(&self) -> bool {
        !self.node.is_empty() && matches!(handoff::legacy_status(&self.work_dir, std::process::id(), crate::heartbeat::pid_alive), handoff::Legacy::Running { .. })
    }

    pub fn status(&self) -> Status {
        let s = read_settings(&self.data_dir);
        let g = self.inner.lock().unwrap();
        Status { enabled: s.enabled, running: g.running.is_some(), legacy: g.running.is_none() && self.legacy(), takeover_allowed: s.allow_takeover, error: g.error.clone() }
    }

    fn try_start(&self) {
        let mut g = self.inner.lock().unwrap();
        if g.running.is_some() {
            return;
        }
        g.error = None;
        let Some(relay) = self.relay.clone() else {
            g.error = Some("這台電腦還沒有節點金鑰，請先登入".into());
            return;
        };
        match start(Config::from_env(&self.node, self.work_dir.clone()), relay, self.anon_url.clone()) {
            Ok(r) => g.running = Some(r),
            Err(StartError::HeldBy(_)) => {} // 舊橋在跑：不啟動，狀態會顯示由舊版負責
            Err(StartError::Other(m)) => g.error = Some(m),
        }
    }

    /// ASN 啟動時：設定打開才啟動
    pub fn start_if_enabled(&self) {
        if read_settings(&self.data_dir).enabled {
            self.try_start();
        }
    }

    pub fn set_enabled(&self, on: bool) -> Result<Status, String> {
        let mut s = read_settings(&self.data_dir);
        s.enabled = on;
        write_settings(&self.data_dir, s)?;
        if on {
            self.try_start();
        } else {
            self.stop();
        }
        Ok(self.status())
    }

    /// 改由 ASN 負責：停掉舊橋（要使用者確認、要設定開關放行），再啟動內建橋
    pub async fn takeover(&self, confirmed: bool) -> Result<Status, String> {
        let s = read_settings(&self.data_dir);
        let pid = std::process::id();
        handoff::takeover(&self.work_dir, &self.node, pid, crate::heartbeat::pid_alive, &handoff::SystemExec, s.allow_takeover, confirmed).map_err(|e| e.text())?;
        // 等舊橋的 pid 消失（最多 10 秒）才拿鎖
        for _ in 0..40 {
            if lock::foreign_holder(&self.work_dir, pid, crate::heartbeat::pid_alive).is_none() {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(250)).await;
        }
        let mut s2 = s;
        s2.enabled = true;
        write_settings(&self.data_dir, s2)?;
        self.try_start();
        Ok(self.status())
    }

    pub fn stop(&self) {
        let r = self.inner.lock().unwrap().running.take();
        if let Some(r) = r {
            r.stop();
        }
    }

    /// ASN 結束時：只關自己啟動的 worker
    pub fn shutdown(&self) {
        self.stop();
    }
}

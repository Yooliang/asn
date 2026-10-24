//! ASN 內建收發室橋（全 Rust）。Claude 引擎見 worker.rs；ACP 背景工作者與 Codex 見 engines/。設計見 docs/design/BRIDGE-RUST.md、BRIDGE-ENGINES.md。
//! 預設關閉：設定「讓 ASN 負責這台的收發室」打開才啟動；關閉時 ASN 的行為與以前完全一樣。
//! 舊 Node 橋在跑（bridge.pid 的 pid 活著）時內建橋不啟動，設定頁顯示由舊版負責。
pub mod attach;
pub mod core;
pub mod corrlog;
pub mod engines;
pub mod handoff;
pub mod launcher;
pub mod lock;
pub mod mail;
pub mod orphans;
pub mod partner_ops;
pub mod pending;
pub mod procscan;
pub mod roster;
pub mod slash;
pub mod rooms;
pub mod worker;

#[cfg(test)]
mod tests;

use crate::relay::Relay;
use core::{BridgeLog, Config, Core};
use engines::{EngineCtx, EngineEvent, EngineSet, Notice};
use launcher::{LaunchEnv, Launched, Launcher};
use partner_ops::PartnerOps;
use serde::Serialize;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use tokio::sync::{mpsc, Notify};
use worker::{ProcWorker, WorkerLine, WorkerSink, WorkerSpec};

// ---- 設定檔（data_dir/bridge.json，與 settings.json 分開，改名流程不會蓋掉它）-------------------------

#[derive(Clone, Debug, PartialEq, Default)]
pub struct BridgeSettings {
    /// 讓 ASN 負責這台的收發室（預設關）
    pub enabled: bool,
    /// 允許「改由 ASN 負責」按鈕停掉舊版收發室橋（預設關，這一版先不開放）
    pub allow_takeover: bool,
    /// 允許我的其他設備替這台開新的 Claude 視窗（預設關）。本機有 launcher.json 時它自己就是同意，不看這個開關
    pub allow_remote_launch: bool,
    /// 沒指定收件視窗的信交給哪個視窗；空＝交給本人（ASN 視窗）。那個視窗不在線時退回交給本人
    pub unaddressed_to: String,
}

pub fn settings_path(data_dir: &Path) -> PathBuf {
    data_dir.join("bridge.json")
}
pub fn read_settings(data_dir: &Path) -> BridgeSettings {
    // 內建收發室固定開啟（小良哥 10-24：預設且不可關閉）；檔案缺少、損壞、寫 false 都一樣
    BridgeSettings { enabled: true, ..read_settings_raw(data_dir) }
}
fn read_settings_raw(data_dir: &Path) -> BridgeSettings {
    let Ok(text) = std::fs::read_to_string(settings_path(data_dir)) else { return BridgeSettings::default() };
    let Ok(v) = serde_json::from_str::<Value>(&text) else { return BridgeSettings::default() };
    let flag = |k: &str| v.get(k).and_then(Value::as_bool).unwrap_or(false);
    BridgeSettings { enabled: true /* 固定開啟：內建收發室不可關閉（舊設定檔裡的 false 一律忽略） */, allow_takeover: flag("allow_takeover"), allow_remote_launch: flag("allow_remote_launch"), unaddressed_to: v.get("unaddressed_to").and_then(Value::as_str).unwrap_or("").trim().to_string() }
}
pub fn write_settings(data_dir: &Path, s: BridgeSettings) -> Result<(), String> {
    crate::write_atomic(&settings_path(data_dir), &json!({ "enabled": s.enabled, "allow_takeover": s.allow_takeover, "allow_remote_launch": s.allow_remote_launch, "unaddressed_to": s.unaddressed_to }).to_string()).map_err(|e| e.to_string())
}

// ---- 執行 --------------------------------------------------------------------------------------

/// 「只有引擎」模式用的空殼：沒有收發室 worker，要交給它的信一律回失敗（核心會照轉交失敗處理）
struct NoWorker;
impl WorkerSink for NoWorker {
    fn say(&self, _text: String) -> Result<(), String> {
        Err("沒有啟用收發室 worker（只有引擎模式）".into())
    }
    fn kill(&self) {}
}

pub struct Running {
    shutdown: Arc<Notify>,
    worker: Option<ProcWorker>,
    lock: lock::BridgeLock,
    tasks: Vec<crate::rt::JoinHandle<()>>,
    engines: Option<Arc<EngineSet>>,
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
        if let Some(e) = &self.engines {
            e.stop(); // 只關自己啟動並記下 PID 的引擎子程序
        }
        if let Some(w) = &self.worker {
            w.stop();
        }
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

/// 啟動內建橋（要在 tokio 執行環境裡呼叫）。anon_url＝門鈴的 WebSocket 網址（沒有就只剩輪詢）。不接遠端開視窗
#[cfg_attr(not(test), allow(dead_code))]
pub fn start(cfg: Config, relay: Arc<Relay>, anon_url: Option<String>) -> Result<Running, StartError> {
    start_with(cfg, relay, anon_url, None)
}

/// 同 [`start`]，launch_env 有值就接上遠端開視窗（第三段）
pub fn start_with(cfg: Config, relay: Arc<Relay>, anon_url: Option<String>, launch_env: Option<Arc<dyn LaunchEnv>>) -> Result<Running, StartError> {
    let lock = lock::BridgeLock::acquire(&cfg.work_dir, std::process::id(), crate::heartbeat::pid_alive).map_err(|e| match e {
        lock::LockError::HeldBy(p) => StartError::HeldBy(p),
        lock::LockError::Io(m) => StartError::Other(format!("拿不到收信鎖：{m}")),
    })?;
    let log = Arc::new(BridgeLog::new(Some(cfg.work_dir.join("bridge.log"))));
    // 上一個橋（被硬砍的 ASN）留下的收發室 worker 與引擎子程序先收掉，免得兩組同時收信；然後把自己的 pid 記進 bridge.last
    for l in engines::cleanup_orphans(&cfg.work_dir, std::process::id(), &orphans::process_table(), orphans::kill_tree) {
        log.line(&l);
    }
    for l in orphans::cleanup_and_mark(&cfg.work_dir, std::process::id(), orphans::process_table, orphans::kill_tree) {
        log.line(&l);
    }
    let nonce = worker::new_nonce();
    let spec = WorkerSpec {
        bin: cfg.claude_bin.clone(),
        pre_args: cfg.claude_pre.clone(),
        mailbox_name: cfg.mailbox_name.clone(),
        model: cfg.model.clone(),
        work_dir: cfg.work_dir.clone(),
        nonce: nonce.clone(),
        extra_env: cfg.extra_env.clone(),
        respond: cfg.respond.as_ref().map(|name| worker::RespondSpec {
            name: name.clone(),
            node: cfg.node.clone(),
            tools: crate::envc::get("ASN_RESPOND_TOOLS").map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).unwrap_or_else(|| worker::RESPOND_TOOLS_DEFAULT.to_string()),
        }),
    };
    let wlog = log.clone();
    // 只有引擎（無視窗橋）：不啟動 claude -p 收發室 worker；核心拿到不會做事的空殼，通道的送端不留，等於永遠沒有 worker 輸出
    let (w, sink, lines): (Option<ProcWorker>, Arc<dyn WorkerSink>, mpsc::UnboundedReceiver<WorkerLine>) = if cfg.engine_only {
        log.line("engine-only mode: no claude mailbox worker");
        (None, Arc::new(NoWorker), mpsc::unbounded_channel().1)
    } else {
        let (w, lines) = ProcWorker::spawn(spec, move |l| wlog.line(&l));
        let sink: Arc<dyn WorkerSink> = Arc::new(w.clone());
        (Some(w), sink, lines)
    };
    log.line(&format!("bridge starting node={} mailbox={} (ASN built-in)", cfg.node, cfg.mailbox_name));
    if let Some(n) = &cfg.respond {
        log.line(&format!("auto-reply mode: the mailbox worker answers as window {n}"));
    }
    let alive: Arc<dyn Fn(u32) -> bool + Send + Sync> = Arc::new(crate::heartbeat::pid_alive);
    let wake = Arc::new(Notify::new());
    let shutdown = Arc::new(Notify::new());
    let mut core = Core::new(cfg.clone(), relay.clone(), sink, &nonce, log.clone(), alive.clone(), crate::heartbeat::now_ms());
    // 遠端開視窗：視窗名單（本機 session ＋ ASN 自己的視窗名）給「不重名」與「等它出現」用
    let launched_rx = launch_env.map(|env| {
        let (sessions, mailbox, r2, sink2, alive2) = (cfg.sessions_dir.clone(), cfg.mailbox_name.clone(), relay.clone(), core.sink(), alive.clone());
        let names: Arc<dyn Fn() -> Option<Vec<String>> + Send + Sync> = Arc::new(move || {
            let ws = roster::read_sessions_with(&sessions, |p, st| alive2(p) && roster::same_process(st, crate::heartbeat::process_started_ms(p)), sink2.pid(), &mailbox)?;
            Some(ws.into_iter().map(|w| w.name).chain(r2.active_names()).collect())
        });
        let (l, rx) = Launcher::new(relay.clone(), log.clone(), cfg.work_dir.clone(), env, names);
        core.set_launcher(l);
        if let Some(dd) = cfg.data_dir.clone() {
            let sink3 = core.sink();
            core.set_partner_ops(PartnerOps::system(relay.clone(), log.clone(), dd, cfg.handoff_dir.clone(), cfg.sessions_dir.clone(), cfg.status_dir.clone(), cfg.mailbox_name.clone(), Arc::new(move || sink3.pid())));
        }
        rx
    });
    // 其他引擎（ACP 背景工作者、Codex）：沒有設定檔也沒有 ~/.codex 就是 None，行為和以前完全一樣
    let (ev_tx, ev_rx) = mpsc::unbounded_channel::<EngineEvent>();
    let notify: engines::Notifier = {
        let (r, l) = (relay.clone(), log.clone());
        Arc::new(move |n: Notice| {
            let (r, l) = (r.clone(), l.clone());
            crate::rt::spawn(async move {
                let mut b = json!({ "to_node": n.to_node, "body": n.body, "from_agent": n.from_agent });
                if let Some(a) = &n.to_agent {
                    b["to_agent"] = json!(a);
                }
                if let Err(e) = r.api("send", Some(b)).await {
                    l.line(&format!("engine notice to {} failed: {e}", n.to_node));
                }
            });
        })
    };
    let ectx = EngineCtx {
        log: {
            let l = log.clone();
            Arc::new(move |m: String| l.line(&m))
        },
        work_dir: cfg.work_dir.clone(),
        home: cfg.home.clone(),
        agents_file: cfg.agents_file.clone(),
        env: Arc::new(cfg.engine_env.clone()),
        events: ev_tx,
        notify,
        pids: engines::PidBook::new(&cfg.work_dir),
    };
    let engine_set = engines::build(&ectx, cfg.engines.as_deref());
    if let Some(e) = &engine_set {
        core.set_engines(e.clone());
    }
    let mut tasks = vec![];
    tasks.push(crate::rt::spawn(run_loop(core, lines, launched_rx, ev_rx, wake.clone(), shutdown.clone())));
    if let Some(e) = &engine_set {
        tasks.push(e.spawn_refresher(cfg.engine_refresh_ms));
    }
    match anon_url {
        Some(url) => {
            let (w2, l2) = (wake, log.clone());
            tasks.push(crate::rt::spawn(async move {
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
    Ok(Running { shutdown, worker: w, lock, tasks, engines: engine_set, log })
}

fn now() -> u64 {
    crate::heartbeat::now_ms()
}

/// 主迴圈：worker 輸出、門鈴、2 分鐘輪詢、名單、逾時檢查，全部在同一個任務裡依序處理
pub async fn run_loop(mut core: Core, mut lines: mpsc::UnboundedReceiver<WorkerLine>, launched: Option<mpsc::UnboundedReceiver<Launched>>, mut engine_events: mpsc::UnboundedReceiver<EngineEvent>, wake: Arc<Notify>, shutdown: Arc<Notify>) {
    // 沒接遠端開視窗就給一個永遠不會有東西的接收端（送端留在這裡，不會關）
    let (_keep, idle) = mpsc::unbounded_channel::<Launched>();
    let mut launched = launched.unwrap_or(idle);
    let every = |ms: u64| {
        let mut i = tokio::time::interval(std::time::Duration::from_millis(ms.max(10)));
        i.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        i
    };
    let (mut poll, mut roster, mut tick) = (every(core.cfg.poll_ms), every(core.cfg.roster_ms), every(core.cfg.tick_ms));
    // 本機視窗狀態監看（0＝關）：狀態一變就立刻回報名單
    let watch_on = core.cfg.watch_ms > 0;
    let mut watch = every(core.cfg.watch_ms);
    poll.tick().await;
    roster.tick().await;
    tick.tick().await;
    watch.tick().await;
    // 其他引擎先啟動並列一次名單（最多等 8 秒，慢的引擎之後由背景重列補上），第一次回報的名單才不缺 Gemini／Codex
    if let Some(e) = core.engines.clone() {
        e.start();
        let _ = tokio::time::timeout(std::time::Duration::from_secs(8), e.refresh_all()).await;
    }
    core.refresh_roster(now()).await;
    core.pull("startup", now()).await;
    loop {
        tokio::select! {
            Some(l) = lines.recv() => core.on_worker_line(l, now()).await,
            Some(ev) = launched.recv() => core.on_launched(ev, now()).await,
            Some(ev) = engine_events.recv() => core.on_engine_event(ev, now()).await,
            _ = wake.notified() => core.pull("bell", now()).await,
            _ = poll.tick() => core.pull("poll", now()).await,
            _ = roster.tick() => core.refresh_roster(now()).await,
            _ = watch.tick(), if watch_on => { core.watch_local(now()).await; }
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
    /// 設定：允許我的其他設備替這台開新視窗
    pub remote_launch: bool,
    /// 設定：沒指定收件人的信交給哪個視窗（空＝交給本人）
    pub unaddressed_to: String,
    pub error: Option<String>,
}

pub struct Manager {
    relay: Option<Arc<Relay>>,
    anon_url: Option<String>,
    node: String,
    work_dir: PathBuf,
    data_dir: PathBuf,
    inner: Mutex<Inner>,
    /// 測試用：換掉遠端開視窗的環境（假設定、假視窗程式）與調整橋設定（假 claude）
    launch_env: Option<Arc<dyn LaunchEnv>>,
    tweak: Mutex<Option<Box<dyn Fn(&mut Config) + Send>>>,
}
#[derive(Default)]
struct Inner {
    running: Option<Running>,
    error: Option<String>,
    /// 啟動時舊橋在跑而讓步了：舊橋一退出就自動接手（設定仍開著的話）
    waiting_legacy: bool,
}

impl Manager {
    pub fn new(relay: Option<Arc<Relay>>, anon_url: Option<String>, node: String, work_dir: PathBuf, data_dir: PathBuf) -> Manager {
        Manager { relay, anon_url, node, work_dir, data_dir, inner: Mutex::new(Inner::default()), launch_env: None, tweak: Mutex::new(None) }
    }

    fn legacy(&self) -> bool {
        !self.node.is_empty() && matches!(handoff::legacy_status(&self.work_dir, std::process::id(), crate::heartbeat::pid_alive), handoff::Legacy::Running { .. })
    }

    #[cfg(test)]
    pub(crate) fn with_test_hooks(mut self, env: Option<Arc<dyn LaunchEnv>>, tweak: Box<dyn Fn(&mut Config) + Send>) -> Manager {
        self.launch_env = env;
        *self.tweak.lock().unwrap() = Some(tweak);
        self
    }

    pub fn status(&self) -> Status {
        let s = read_settings(&self.data_dir);
        let g = self.inner.lock().unwrap();
        Status { enabled: s.enabled, running: g.running.is_some(), legacy: g.running.is_none() && self.legacy(), takeover_allowed: s.allow_takeover, remote_launch: s.allow_remote_launch, unaddressed_to: s.unaddressed_to, error: g.error.clone() }
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
        let mut cfg = Config::from_env(&self.node, self.work_dir.clone());
        cfg.data_dir = Some(self.data_dir.clone());
        if let Some(f) = self.tweak.lock().unwrap().as_ref() {
            f(&mut cfg);
        }
        let env: Arc<dyn LaunchEnv> = self.launch_env.clone().unwrap_or_else(|| Arc::new(launcher::SystemEnv::new(self.data_dir.clone())));
        match start_with(cfg, relay, self.anon_url.clone(), Some(env)) {
            Ok(r) => {
                g.running = Some(r);
                if let Some(rl) = &self.relay {
                    rl.set_bridge_running(true);
                }
                g.waiting_legacy = false;
            }
            Err(StartError::HeldBy(_)) => g.waiting_legacy = true, // 舊橋在跑：不啟動，狀態顯示由舊版負責；舊橋退出後自動接手
            Err(StartError::Other(m)) => g.error = Some(m),
        }
    }

    /// 定時呼叫（ASN 每幾秒一次）：設定開著、啟動時因舊橋在跑而讓步，舊橋退出後自動接手
    pub fn poll_handoff(&self) {
        {
            let g = self.inner.lock().unwrap();
            if !g.waiting_legacy || g.running.is_some() {
                return;
            }
        }
        if !read_settings(&self.data_dir).enabled || self.legacy() {
            return;
        }
        self.try_start();
    }

    /// 打開／關閉「允許我的其他設備替這台開新視窗」。不用重啟橋：每次處理請求和回報名單都重讀設定
    pub fn set_remote_launch(&self, on: bool) -> Result<Status, String> {
        let mut s = read_settings(&self.data_dir);
        s.allow_remote_launch = on;
        write_settings(&self.data_dir, s)?;
        Ok(self.status())
    }

    /// 設定「沒指定收件人的信交給哪個視窗」（空＝交給本人）。不用重啟橋：每封信都重讀設定
    pub fn set_unaddressed_to(&self, name: &str) -> Result<Status, String> {
        let mut s = read_settings(&self.data_dir);
        s.unaddressed_to = name.trim().chars().take(100).collect();
        write_settings(&self.data_dir, s)?;
        Ok(self.status())
    }

    /// ASN 啟動時：設定打開才啟動
    pub fn start_if_enabled(&self) {
        if read_settings(&self.data_dir).enabled {
            self.try_start();
        }
    }

    pub fn set_enabled(&self, on: bool) -> Result<Status, String> {
        let mut s = read_settings(&self.data_dir);
        let on = on || true;   // 不可關閉：關閉的要求一律當成開啟
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
        if let Some(rl) = &self.relay {
            rl.set_bridge_running(false);
        }
        if let Some(r) = r {
            r.stop();
        }
    }

    /// ASN 結束時：只關自己啟動的 worker
    pub fn shutdown(&self) {
        self.stop();
    }
}

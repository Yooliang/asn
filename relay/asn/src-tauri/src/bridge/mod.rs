//! ASN 內建收發室橋（全 Rust）。Claude 引擎見 worker.rs；ACP 背景工作者與 Codex 見 engines/。設計見 docs/design/BRIDGE-RUST.md、BRIDGE-ENGINES.md。
//! 預設關閉：設定「讓 ASN 負責這台的收發室」打開才啟動；關閉時 ASN 的行為與以前完全一樣。
//! 舊 Node 橋在跑（bridge.pid 的 pid 活著）時內建橋不啟動，設定頁顯示由舊版負責。
pub mod attach;
pub mod channel_turns;
pub mod core;
pub mod corrlog;
pub mod dup_session;
pub mod engines;
pub mod forward_gate;
pub mod forward_selftest;
pub mod handoff;
pub mod known;
pub mod launcher;
pub mod compact;
pub mod lock;
pub mod login_alert;
pub mod wait_alert;
pub mod mail;
pub mod notice_route;
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

#[derive(Clone, Debug, PartialEq)]
pub struct BridgeSettings {
    /// 讓 ASN 負責這台的收發室（預設關）
    pub enabled: bool,
    /// 允許「改由 ASN 負責」按鈕停掉舊版收發室橋（預設關，這一版先不開放）
    pub allow_takeover: bool,
    /// 允許我的其他設備替這台開新的 Claude 視窗（預設關）。本機有 launcher.json 時它自己就是同意，不看這個開關
    pub allow_remote_launch: bool,
    /// 沒指定收件視窗的信交給哪個視窗；空＝交給本人（ASN 視窗）。那個視窗不在線時退回交給本人
    pub unaddressed_to: String,
    /// 使用者關掉了「電腦重開後自動接回夥伴」（#767）。預設是開的，所以記「關」
    pub auto_resume_off: bool,
    /// 使用者關掉了「夥伴共用同一個終端服務」（#868）。預設是開的，所以記「關」。啟動時讀一次，改了要重開 ASN 才生效
    pub term_server_off: bool,
    /// Linux 等其他平台：本人打開了「夥伴共用同一個終端服務」。那邊預設關，所以記「開」（0.2.9）
    pub term_server_on: bool,
    /// 使用者關掉了「夥伴卡住時跳提示」（todo-next-162）。預設是開的，所以記「關」
    pub screen_watch_off: bool,
    /// 使用者關掉了「權限框傳到手機」（#853）。預設是開的，所以記「關」
    pub perm_phone_off: bool,
    /// 使用者關掉了「允許移動設備查看終端」。預設是開的，所以記「關」。關掉後，手機看這台的請求一律拒絕，進行中的也會結束
    pub mobile_view_off: bool,
    /// 使用者關掉了「允許遠端在這台打字」（#1745）。預設是開的，所以記「關」。關掉後，別台要在這台打字一律馬上拒絕，進行中的打字也會結束；看畫面不受影響
    pub remote_input_off: bool,
    /// 使用者關掉了「壓縮 N 次自動交接」（#1852）。預設是開的，所以記「關」；關掉後到次數只提醒，不自動交接
    pub compact_handoff_off: bool,
    /// 壓縮幾次自動交接（2～10）。檔案缺這欄＝3；讀進來一律夾在 2～10
    pub compact_handoff_n: u32,
    /// 讓背景模式的 Gemini 夥伴能寫檔和執行指令（#2348）。預設關，所以記「開」。只影響之後新開或重啟的 Gemini；其他模型不受影響
    pub gemini_full_access: bool,
}

impl Default for BridgeSettings {
    fn default() -> Self {
        BridgeSettings { enabled: false, allow_takeover: false, allow_remote_launch: false, unaddressed_to: String::new(), auto_resume_off: false, term_server_off: false, term_server_on: false, screen_watch_off: false, perm_phone_off: false, mobile_view_off: false, remote_input_off: false, compact_handoff_off: false, compact_handoff_n: compact::N_DEFAULT, gemini_full_access: false }
    }
}

impl BridgeSettings {
    /// 別台現在還能不能看（或打字）這台：本機「允許其他設備替這台開新視窗」要開著；看的那台是移動設備時，還要「允許移動設備查看終端」開著
    pub fn view_allowed(&self, mobile_viewer: bool) -> bool {
        self.allow_remote_launch && !(mobile_viewer && self.mobile_view_off)
    }

    /// 別台現在能不能在這台打字（#1745）：本機「允許遠端在這台打字」要開著（預設開）；看畫面不看這個
    pub fn input_allowed(&self) -> bool {
        !self.remote_input_off
    }
}

pub fn settings_path(data_dir: &Path) -> PathBuf {
    data_dir.join("bridge.json")
}
/// 這台有沒有「夥伴共用終端服務」可用：Windows 用安裝檔附帶的 WezTerm；其他平台看 PATH 上找不找得到 wezterm（不跳提示、只查檔案）
pub fn term_server_supported() -> bool {
    // Linux：PATH 上或之前取得過的找得到，或這台的發行版 ASN 能自動取得（取得流程見 launch/wezterm_fetch）
    cfg!(windows) || crate::launch::wezterm::locate(&crate::launch::wezterm::RealFs).is_ok() || crate::launch::wezterm_fetch::can_fetch()
}

/// 設定頁要顯示的「終端程式取得」狀態（Windows 隨安裝檔附帶，永遠是沒事）
fn term_fetch_status() -> crate::launch::wezterm_fetch::FetchStatus {
    let none = crate::launch::wezterm_fetch::FetchStatus { state: "", kind: "", detail: String::new() };
    if cfg!(windows) {
        return none;
    }
    crate::launch::mux::default_base().map_or(none, |b| crate::launch::wezterm_fetch::status(&b))
}

/// 讀收發室設定。**唯讀**：不搬檔、不寫檔（收發室每輪都讀、橋也在讀，搬檔只准在畫面那一側寫入時發生，見 [`update_settings`]）。
/// 壞檔、缺檔、型別不對都回預設（壞檔記一行 `[ASN]` log，同一個檔 60 秒最多一行）。有記憶體快取：檔案修改時間與大小沒變就不重讀。
/// 檔案位置是 `<data_dir>/bridge.json`，`data_dir` 由呼叫端給（無視窗橋給的是節點工作資料夾），所以不走固定的 Scope。
pub fn read_settings(data_dir: &Path) -> BridgeSettings {
    // 內建收發室固定開啟（擁有者 10-24：預設且不可關閉）；檔案缺少、損壞、寫 false 都一樣
    doc_to_settings(&crate::settings::peek_in::<crate::settings::BridgeDoc>(data_dir).value)
}
fn doc_to_settings(d: &crate::settings::BridgeDoc) -> BridgeSettings {
    BridgeSettings { enabled: true /* 固定開啟：內建收發室不可關閉（舊設定檔裡的 false 一律忽略） */, allow_takeover: d.allow_takeover, allow_remote_launch: d.allow_remote_launch, unaddressed_to: d.unaddressed_to.clone(), auto_resume_off: d.auto_resume_off, term_server_off: d.term_server_off, term_server_on: d.term_server_on, screen_watch_off: d.screen_watch_off, perm_phone_off: d.perm_phone_off, mobile_view_off: d.mobile_view_off, remote_input_off: d.remote_input_off, compact_handoff_off: d.compact_handoff_off, compact_handoff_n: compact::clamp_n(Some(i64::from(d.compact_handoff_n))), gemini_full_access: d.gemini_full_access }
}
/// 只動這 14 個欄位，檔裡不認得的欄位（較新版本寫的）原樣留著
fn apply_settings(d: &mut crate::settings::BridgeDoc, s: &BridgeSettings) {
    d.enabled = s.enabled;
    d.allow_takeover = s.allow_takeover;
    d.allow_remote_launch = s.allow_remote_launch;
    d.unaddressed_to = s.unaddressed_to.clone();
    d.auto_resume_off = s.auto_resume_off;
    d.term_server_off = s.term_server_off;
    d.term_server_on = s.term_server_on;
    d.screen_watch_off = s.screen_watch_off;
    d.perm_phone_off = s.perm_phone_off;
    d.mobile_view_off = s.mobile_view_off;
    d.remote_input_off = s.remote_input_off;
    d.compact_handoff_off = s.compact_handoff_off;
    d.compact_handoff_n = compact::clamp_n(Some(i64::from(s.compact_handoff_n)));
    d.gemini_full_access = s.gemini_full_access;
}
/// 持鎖「讀、改、寫」（一律重讀原檔）：兩處同時改不同欄位不會互相蓋掉。**這是唯一會動 bridge.json 的路徑**；
/// 檔案是壞的就先搬成 `.bad-` 再寫。寫不進去回固定的白話句（系統原文只進 log）
pub fn update_settings(data_dir: &Path, f: impl FnOnce(&mut BridgeSettings)) -> Result<(), String> {
    crate::settings::update_in::<crate::settings::BridgeDoc, _>(data_dir, |d| {
        let mut s = doc_to_settings(d);
        f(&mut s);
        apply_settings(d, &s);
    })
    .map_err(|e| e.to_string())
}
/// 整份寫入（轉接用，保留舊簽章）：只換這 14 個欄位，不認得的欄位照留。新程式請用 [`update_settings`]，免得拿舊值蓋掉別處剛改的欄位
pub fn write_settings(data_dir: &Path, s: BridgeSettings) -> Result<(), String> {
    update_settings(data_dir, |cur| *cur = s)
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
    /// 主迴圈（收信、送回信、ack 都在裡面依序處理）結束了：正常跑完、被 abort、panic 都會設（由 [`LoopDone`] 的 drop 設）
    loop_done: Arc<std::sync::atomic::AtomicBool>,
}

/// 主迴圈任務結束時（不管怎麼結束）把旗標設起來，給 [`Running::drain`] 等
struct LoopDone(Arc<std::sync::atomic::AtomicBool>);
impl Drop for LoopDone {
    fn drop(&mut self) {
        self.0.store(true, std::sync::atomic::Ordering::SeqCst);
    }
}

/// 等旗標變 true，最多 `timeout`（每 `step` 看一次）。回傳旗標是否在時限內變 true。
/// 重新啟動前等「進行中的送出／ack 做完」用：主迴圈一次只處理一個動作，旗標變 true＝手上的動作做完、迴圈已離開
#[cfg_attr(not(feature = "gui"), allow(dead_code))]
pub(crate) async fn wait_flag(flag: &std::sync::atomic::AtomicBool, timeout: std::time::Duration, step: std::time::Duration) -> bool {
    let end = tokio::time::Instant::now() + timeout;
    loop {
        if flag.load(std::sync::atomic::Ordering::SeqCst) {
            return true;
        }
        if tokio::time::Instant::now() >= end {
            return false;
        }
        tokio::time::sleep(step).await;
    }
}

impl Running {
    /// 停止收新信並等進行中的動作做完（重新啟動用）：通知主迴圈離開，迴圈會先把手上的送出／ack 處理完才檢查離開訊號，
    /// 所以等到迴圈結束＝進行中的送出都有結果了。回傳是否在 `timeout` 內做完；逾時的由之後的 [`Running::stop`] 照舊 abort。
    /// 不改 `stop` 的語意：一般結束仍然直接 abort
    #[cfg_attr(not(feature = "gui"), allow(dead_code))]
    pub async fn drain(&self, timeout: std::time::Duration) -> bool {
        self.shutdown.notify_one();
        wait_flag(&self.loop_done, timeout, std::time::Duration::from_millis(50)).await
    }

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
    let lock = lock::BridgeLock::acquire(&cfg.work_dir, std::process::id(), lock::holder_alive(&cfg.work_dir)).map_err(|e| match e {
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
    // 只有引擎（無視窗橋）：不啟動 claude -p 的自動回信 worker；核心拿到不會做事的空殼，通道的送端不留，等於永遠沒有 worker 輸出
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
        let (sessions, mailbox, r2, sink2, alive2, claude2) = (cfg.sessions_dir.clone(), cfg.mailbox_name.clone(), relay.clone(), core.sink(), alive.clone(), core.claude_check());
        let names: Arc<dyn Fn() -> Option<Vec<String>> + Send + Sync> = Arc::new(move || {
            let ws = roster::read_sessions_with(&sessions, |p, _| alive2(p) && claude2(p), sink2.pid(), &mailbox)?;
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
        data_dir: cfg.data_dir.clone(),
        handoff_dir: Some(cfg.handoff_dir.clone()),
    };
    if cfg.engines_pi_added {
        log.line("engines: 舊名 IRORI_ENGINES 的清單沒列 pi（那時還沒有 pi），自動載入 pi；要關掉 pi 請改設 ASN_ENGINES");
    } else if !engines::want_pi(cfg.engines.as_deref()) {
        // 名單上只說「這台的設定把 pi 關掉了」，是哪個設定記在這裡
        log.line("engines: ASN_ENGINES 沒列 pi，不載入 pi 視窗（名單上的前景 pi 會標「這台的設定把 pi 關掉了」）");
    }
    let engine_set = engines::build(&ectx, cfg.engines.as_deref());
    if let Some(e) = &engine_set {
        core.set_engines(e.clone());
    }
    let mut tasks = vec![];
    let loop_done = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let done_guard = LoopDone(loop_done.clone());
    let (loop_wake, loop_shutdown) = (wake.clone(), shutdown.clone());
    tasks.push(crate::rt::spawn(async move {
        let _done = done_guard;
        run_loop(core, lines, launched_rx, ev_rx, loop_wake, loop_shutdown).await
    }));
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
                crate::bell::run(url, topic, move |ring| if crate::bell::wakes_mail(ring) { w2.notify_one() }).await;
            }));
        }
        None => log.line("no anon key: doorbell off, polling only"),
    }
    Ok(Running { shutdown, worker: w, lock, tasks, engines: engine_set, log, loop_done })
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
    /// 這台的收發信功能目前由舊版收發信小程式負責
    pub legacy: bool,
    /// 「改由 ASN 負責」按鈕是否開放
    pub takeover_allowed: bool,
    /// 設定：允許我的其他設備替這台開新視窗
    pub remote_launch: bool,
    /// 設定：電腦重開後自動接回夥伴
    pub auto_resume: bool,
    /// 設定：壓縮 N 次自動交接（開關與次數）
    pub compact_handoff: bool,
    pub compact_handoff_n: u32,
    /// 設定：夥伴共用同一個終端服務（設定頁的開關現在的值）
    pub term_server: bool,
    /// 這個平台有沒有「夥伴共用終端服務」：Windows 用附帶的；Linux 要 PATH 上找得到 wezterm。沒有就不顯示開關
    pub term_server_supported: bool,
    /// Linux 上找不到 wezterm：設定頁說一句怎麼裝（Windows 一律 false）
    pub term_server_missing: bool,
    /// Linux 按需取得終端程式的狀態：""（沒事）／"fetching"（取得中）／"failed"（失敗，原因在 `term_fetch_kind`）
    pub term_fetch: String,
    /// 失敗的原因分類：network／disk／mismatch／unsupported／unrunnable／other；沒失敗是空字串。網址、雜湊等細節只進 log，不進這裡
    pub term_fetch_kind: String,
    /// 失敗時的短細節：目前只有「缺少的系統函式庫名」（已過濾，只有英數與 . _ + -，最長 40 字元）；沒有就空字串
    pub term_fetch_detail: String,
    /// 登入資料和設備金鑰怎麼保護：windows／keyring（系統金鑰庫）／file_only（只靠檔案權限）
    pub key_protection: String,
    /// 這次啟動有沒有在用共用的終端服務。和 `term_server` 不同＝改了還沒生效，要重開 ASN
    pub term_server_active: bool,
    /// 想用終端服務、但這次 ASN 的啟動方式會讓夥伴跟著 ASN 一起關閉，所以夥伴改開在一般視窗：給人看的原因；沒有是空字串
    pub term_server_why: String,
    /// 被系統設定固定關著（環境變數），設定頁不能改
    pub term_server_locked: bool,
    /// 共用終端服務還在跑、裡面還有夥伴，但這次 ASN 沒在管它們（設定關掉後重開）：人數；0＝沒有；-1＝服務在跑但數不出人數
    pub term_server_background: i64,
    /// 設定：夥伴卡住時跳提示（設定頁的開關現在的值）
    pub screen_watch: bool,
    pub perm_phone: bool,
    /// 設定：允許移動設備查看終端（設定頁的開關現在的值，預設開）
    pub mobile_view: bool,
    /// 設定：允許遠端在這台打字（設定頁的開關現在的值，預設開；#1745）
    pub remote_input: bool,
    /// 設定：Gemini 背景工作者可以寫檔和執行指令（設定頁的開關現在的值，預設關；#2348）
    pub gemini_full_access: bool,
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
        !self.node.is_empty() && matches!(handoff::legacy_status(&self.work_dir, std::process::id(), lock::holder_alive(&self.work_dir)), handoff::Legacy::Running { .. })
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
        let fetch = term_fetch_status();
        Status { enabled: s.enabled, running: g.running.is_some(), legacy: g.running.is_none() && self.legacy(), takeover_allowed: s.allow_takeover, remote_launch: s.allow_remote_launch, auto_resume: !s.auto_resume_off, compact_handoff: !s.compact_handoff_off, compact_handoff_n: s.compact_handoff_n, screen_watch: !s.screen_watch_off, perm_phone: !s.perm_phone_off, mobile_view: !s.mobile_view_off, remote_input: !s.remote_input_off, gemini_full_access: s.gemini_full_access, term_server: if cfg!(windows) { !s.term_server_off } else { s.term_server_on }, term_server_supported: term_server_supported(), term_server_missing: !term_server_supported(), term_fetch: fetch.state.to_string(), term_fetch_kind: fetch.kind.to_string(), term_fetch_detail: fetch.detail.clone(), key_protection: crate::keystore::protection_label_cached(&self.data_dir).to_string(), term_server_active: crate::launch::win_term::term_server_active(), term_server_why: crate::launch::term::mux_off_reason(), term_server_locked: crate::launch::win_term::term_server_locked(), term_server_background: crate::launch::term::background_partners_cached(), unaddressed_to: s.unaddressed_to, error: g.error.clone() }
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
        update_settings(&self.data_dir, |s| {
            s.allow_remote_launch = on;
        })?;
        Ok(self.status())
    }

    /// 打開／關閉「電腦重開後自動接回夥伴」（#767）。下次開機才用到
    pub fn set_auto_resume(&self, on: bool) -> Result<Status, String> {
        update_settings(&self.data_dir, |s| {
            s.auto_resume_off = !on;
        })?;
        Ok(self.status())
    }

    /// 打開／關閉「壓縮 N 次自動交接」並設定次數（#1852）。次數夾在 2～10；下一輪巡檢就生效
    pub fn set_compact_handoff(&self, on: bool, n: u32) -> Result<Status, String> {
        update_settings(&self.data_dir, |s| {
            s.compact_handoff_off = !on;
            s.compact_handoff_n = compact::clamp_n(Some(i64::from(n)));
        })?;
        Ok(self.status())
    }

    /// （畫面用）
    /// 打開／關閉「夥伴共用同一個終端服務」（#868）。只存檔：開關啟動時讀一次，改了要重開 ASN 才生效，
    /// 已開著的夥伴不會被搬動、也不會被關掉（執行中的終端服務照舊管它們）
    pub fn set_term_server(&self, on: bool) -> Result<Status, String> {
        if crate::launch::win_term::term_server_locked() {
            return Err("這個設定已由系統設定固定".into());
        }
        update_settings(&self.data_dir, |s| {
            s.term_server_off = !on;
            s.term_server_on = on;
        })?;
        // Linux 剛打開、而且找不到終端程式：馬上在背景去取（一天內失敗過就照退避不連網），畫面才有狀態可以顯示
        if on && !cfg!(windows) {
            let (env_wez, env_mux) = (crate::flags::switch_raw(crate::launch::win_term::ENV_WEZTERM), crate::flags::switch_raw(crate::launch::win_term::ENV_MUX));
            let found = crate::launch::wezterm::locate(&crate::launch::wezterm::RealFs).is_ok();
            if crate::launch::wezterm_fetch::should_fetch(true, env_wez.as_deref(), env_mux.as_deref(), found) {
                crate::launch::wezterm_fetch::spawn_background(false);
            }
        }
        Ok(self.status())
    }

    /// 設定頁「重試」：忽略退避，馬上重新取得終端程式（Linux 才有；結果之後從 `status()` 看）
    pub fn retry_term_fetch(&self) -> Result<Status, String> {
        if cfg!(windows) {
            return Err("這個平台不需要另外取得終端程式".into());
        }
        crate::launch::wezterm_fetch::spawn_background(true);
        Ok(self.status())
    }

    /// 打開／關閉「夥伴卡住時跳提示」（todo-next-162）。這裡只存檔，馬上生效由呼叫端通知背景工作
    /// 打開／關閉「權限框傳到手機」（#853）。這裡只存檔，馬上生效由呼叫端通知背景工作
    pub fn set_perm_phone(&self, on: bool) -> Result<Status, String> {
        update_settings(&self.data_dir, |s| {
            s.perm_phone_off = !on;
        })?;
        Ok(self.status())
    }

    /// 打開／關閉「允許移動設備查看終端」。只存檔：被看的這台每次領請求、每次查控制面都重讀設定，不用通知背景工作
    pub fn set_mobile_view(&self, on: bool) -> Result<Status, String> {
        update_settings(&self.data_dir, |s| {
            s.mobile_view_off = !on;
        })?;
        Ok(self.status())
    }

    /// 打開／關閉「允許遠端在這台打字」（#1745）。只存檔：被打字的這台每次領請求、每次交字前都重讀設定，不用通知背景工作
    pub fn set_remote_input(&self, on: bool) -> Result<Status, String> {
        update_settings(&self.data_dir, |s| {
            s.remote_input_off = !on;
        })?;
        Ok(self.status())
    }

    /// 打開／關閉「Gemini 背景工作者可以寫檔和執行指令」（#2348）。存檔後，「開新夥伴」開出、正在跑的 Gemini 馬上依新開關重開
    /// （正在處理的那一輪會中止；agents.json 手寫的、Grok 不動）。橋沒在跑就只存檔，之後開、重啟時才讀
    pub fn set_gemini_full_access(&self, on: bool) -> Result<Status, String> {
        update_settings(&self.data_dir, |s| {
            s.gemini_full_access = on;
        })?;
        let running = self.inner.lock().unwrap().running.as_ref().map(|r| (r.engines.clone(), r.log.clone()));
        if let Some((Some(engines), log)) = running {
            if let Some(admin) = engines.acp_admin() {
                let (done, failed) = admin.apply_gemini_toggle();
                if !done.is_empty() {
                    log.line(&format!("gemini_full_access={on}：已依新設定重開 {}", done.join("、")));
                }
                for (name, why) in failed {
                    log.line(&format!("gemini_full_access={on}：{name} 沒能重開（{why}），請手動重開"));
                }
            }
        }
        Ok(self.status())
    }

    pub fn set_screen_watch(&self, on: bool) -> Result<Status, String> {
        update_settings(&self.data_dir, |s| {
            s.screen_watch_off = !on;
        })?;
        Ok(self.status())
    }

    /// 設定「沒指定收件人的信交給哪個視窗」（空＝交給本人）。不用重啟橋：每封信都重讀設定
    pub fn set_unaddressed_to(&self, name: &str) -> Result<Status, String> {
        update_settings(&self.data_dir, |s| {
            s.unaddressed_to = name.trim().chars().take(100).collect();
        })?;
        Ok(self.status())
    }

    /// ASN 啟動時：設定打開才啟動
    pub fn start_if_enabled(&self) {
        if read_settings(&self.data_dir).enabled {
            self.try_start();
        }
    }

    pub fn set_enabled(&self, on: bool) -> Result<Status, String> {
        let on = on || true;   // 不可關閉：關閉的要求一律當成開啟
        update_settings(&self.data_dir, |s| {
            s.enabled = on;
        })?;
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
        handoff::takeover(&self.work_dir, &self.node, pid, lock::holder_alive(&self.work_dir), &handoff::SystemExec, s.allow_takeover, confirmed).map_err(|e| e.text())?;
        // 等舊橋的 pid 消失（最多 10 秒）才拿鎖
        for _ in 0..40 {
            if lock::foreign_holder(&self.work_dir, pid, lock::holder_alive(&self.work_dir)).is_none() {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(250)).await;
        }
        update_settings(&self.data_dir, |s| {
            s.enabled = true;
        })?;
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

    /// 重新啟動前先收橋：停止收新信、等進行中的送出／ack 最多 `timeout`，逾時照舊 abort（寫進 bridge.log），再釋放收信鎖。
    /// 回傳「收橋前橋是不是在跑」，spawn 新程序失敗時用它決定要不要 [`Manager::resume_after_failed_relaunch`]。
    /// 不碰設定檔（`enabled` 照舊），所以新程序開起來還是會啟動橋
    #[cfg_attr(not(feature = "gui"), allow(dead_code))]
    pub async fn drain_for_relaunch(&self, timeout: std::time::Duration) -> bool {
        let r = self.inner.lock().unwrap().running.take();
        if let Some(rl) = &self.relay {
            rl.set_bridge_running(false);
        }
        let Some(r) = r else { return false };
        if !r.drain(timeout).await {
            r.log.line(&format!("relaunch: in-flight send/ack not finished within {}s, aborting", timeout.as_secs()));
        }
        r.stop();
        true
    }

    /// 重新啟動失敗（新程序開不起來）後恢復收發：收橋前橋在跑才重新啟動橋（設定檔沒動過，照 `try_start` 的一般流程）
    #[cfg_attr(not(feature = "gui"), allow(dead_code))]
    pub fn resume_after_failed_relaunch(&self, was_running: bool) {
        if !was_running {
            return;
        }
        self.try_start();
        // 重新啟動失敗、收發又沒恢復＝要留下訊號：寫進 bridge.log（畫面上的 error 只在設定頁看得到）
        let err = self.inner.lock().unwrap().error.clone();
        if let Some(e) = err {
            BridgeLog::new(Some(self.work_dir.join("bridge.log"))).line(&format!("relaunch: failed to resume bridge after failed relaunch: {e}"));
        }
    }
}

//! 通用 ACP 引擎：由內建橋依 `~/.asn/agents.json` 長駐啟動一批「工作者」（背景 AI，例如 Gemini），
//! 名單上以工作者名出現（roster 的 engine 欄位＝設定的 roster_engine，例如 gemini）；收到信就送一輪、把回覆寄回。
//! 對應 engines/acp.mjs 與 acp-driver-acp.mjs。兩種驅動：`acp`（標準 ACP，Gemini CLI 的 --experimental-acp 等）在這個檔案，
//! `agy-stream`（Antigravity CLI 原生 stream-json）在 acp_agy.rs。
use super::acp_approvals::{parse_mail_text, Approvals};
use super::acp_client::{AcpClient, AcpOpts};
use super::acp_config::{load_workers_config, WorkerCfg};
use super::acp_policy::{describe_acp_request, WorkerError};
use super::acp_worker::{Denied, Driver, DriverArgs, Job, MakeDriver, Store, TurnResult, Worker, WorkerHandle, WorkerInit};
use super::rpc::RpcError;
use super::{acp_clean_env, BoxFut, Engine, EngineCtx, EngineEvent};
use crate::bridge::mail::{head_reply, wants_reply};
use crate::bridge::roster::Window;
use serde_json::Value;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicU8, Ordering};
use std::sync::{Arc, Mutex};

fn now_ms() -> u64 {
    crate::heartbeat::now_ms()
}

fn clip(s: &str, n: usize) -> String {
    s.chars().take(n).collect()
}

// ---- 標準 ACP 驅動 -------------------------------------------------------------------------------

struct Shared {
    sid: Mutex<String>,
    resume_lost: AtomicBool,
    client: Mutex<Option<Arc<AcpClient>>>,
    /// Some＝一輪進行中，裡面收這一輪被拒絕的動作
    denied: Mutex<Option<Vec<Denied>>>,
    last_activity: AtomicU64,
    stopped: AtomicBool,
    /// agent 宣告的 loadSession：0＝還不知道、1＝支援、2＝不支援
    can_load: AtomicU8,
    /// agent 列出的可選模型與目前的模型（session/new、session/load 回的 models）
    models: Mutex<(Vec<String>, Option<String>)>,
}

/// 從 session/new、session/load 的回應讀出 (可選的模型, 目前的模型)；沒有 models 回 None
pub fn session_models(r: &Value) -> Option<(Vec<String>, Option<String>)> {
    let m = r.get("models")?;
    let list = m.get("availableModels").and_then(Value::as_array).into_iter().flatten().filter_map(|x| x.get("modelId").and_then(Value::as_str)).filter(|x| super::acp_models::valid_model(x)).map(String::from).collect();
    Some((list, m.get("currentModelId").and_then(Value::as_str).map(String::from)))
}

pub struct AcpDriver {
    a: DriverArgs,
    sh: Arc<Shared>,
}

/// 後台夥伴表的 session 欄只收 ^[A-Za-z0-9_-]{8,80}$，不符的不送（送了會被丟掉，還可能讓整份名單被拒）
pub(crate) fn roster_session_ok(s: &str) -> bool {
    (8..=80).contains(&s.len()) && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

impl AcpDriver {
    pub fn new(a: DriverArgs) -> AcpDriver {
        let sid = a.session_id.clone();
        AcpDriver { a, sh: Arc::new(Shared { sid: Mutex::new(sid), resume_lost: AtomicBool::new(false), client: Mutex::new(None), denied: Mutex::new(None), last_activity: AtomicU64::new(0), stopped: AtomicBool::new(false), can_load: AtomicU8::new(0), models: Mutex::new((vec![], None)) }) }
    }

    /// 設定裡有模型（含切換模型記下的）：在 session/new 或 session/load 之後補一次 session/set_model。
    /// 不在對方列出的可選模型裡、或切換失敗，就記 log 照預設跑，不讓工作者起不來
    async fn apply_recorded_model(&self, client: &AcpClient, sid: &str) {
        let want = self.a.cfg.model.trim();
        if want.is_empty() {
            return;
        }
        let (list, cur) = self.sh.models.lock().unwrap().clone();
        if cur.as_deref() == Some(want) {
            return;
        }
        if !list.iter().any(|m| m == want) {
            (self.a.log)(format!("記下的模型 {want} 不在這個 agent 列出的可選模型裡，照預設跑"));
            return;
        }
        match client.set_model(sid, want).await {
            Ok(()) => {
                self.sh.models.lock().unwrap().1 = Some(want.to_string());
                (self.a.log)(format!("已套用記下的模型 {want}"));
            }
            Err(e) => (self.a.log)(format!("套用記下的模型 {want} 失敗，照預設跑：{}", e.message)),
        }
    }

    fn classify(&self, e: &RpcError, ctx: &str) -> WorkerError {
        let client = self.sh.client.lock().unwrap().clone();
        let tail = client.as_ref().map(|c| c.stderr_tail().join(" | ")).unwrap_or_default();
        let alive = client.as_ref().map(|c| c.alive()).unwrap_or(false);
        let text = format!("{} {} {tail}", e.message, if e.code == Some(-32000) { "authentication required" } else { "" });
        let msg = clip(&format!("{ctx}{}{}", e.message, if tail.is_empty() { String::new() } else { format!(" | {tail}") }), 400);
        WorkerError::classify(&text, if alive { "agent" } else { "crash" }, msg)
    }
}

impl Driver for AcpDriver {
    fn session_id(&self) -> String {
        self.sh.sid.lock().unwrap().clone()
    }
    fn resume_lost(&self) -> bool {
        self.sh.resume_lost.load(Ordering::SeqCst)
    }
    fn alive(&self) -> bool {
        self.sh.client.lock().unwrap().as_ref().map(|c| c.alive()).unwrap_or(false)
    }
    fn pid(&self) -> u32 {
        self.sh.client.lock().unwrap().as_ref().filter(|c| c.alive()).map(|c| c.pid()).unwrap_or(0)
    }
    fn load_session(&self) -> Option<bool> {
        match self.sh.can_load.load(Ordering::SeqCst) {
            1 => Some(true),
            2 => Some(false),
            _ => None,
        }
    }
    fn models(&self) -> Vec<String> {
        self.sh.models.lock().unwrap().0.clone()
    }
    fn current_model(&self) -> Option<String> {
        self.sh.models.lock().unwrap().1.clone()
    }
    fn set_model(&self, model: String) -> BoxFut<'_, Result<(), String>> {
        Box::pin(async move {
            let Some(client) = self.sh.client.lock().unwrap().clone().filter(|c| c.alive()) else { return Err("工作者沒有在跑".to_string()) };
            let sid = self.session_id();
            if sid.is_empty() {
                return Err("工作者還沒有對話，稍後再試".into());
            }
            client.set_model(&sid, &model).await.map_err(|e| format!("工作者拒絕切換模型：{}", clip(&e.message, 200)))?;
            self.sh.models.lock().unwrap().1 = Some(model);
            Ok(())
        })
    }
    fn touch(&self) {
        self.sh.last_activity.store(now_ms(), Ordering::SeqCst);
    }

    fn start(&self) -> BoxFut<'_, Result<(), WorkerError>> {
        Box::pin(async move {
            let cfg = self.a.cfg.clone();
            let env = acp_clean_env(&self.a.env, &cfg.env_pass);
            let (sh_perm, guard) = (self.sh.clone(), self.a.guard.clone());
            let (sh_act, sh_exit, on_exit) = (self.sh.clone(), self.sh.clone(), self.a.on_exit.clone());
            let (pids, pid_cell) = (self.a.pids.clone(), Arc::new(AtomicU64::new(0)));
            let pid_cell2 = pid_cell.clone();
            let opts = AcpOpts {
                command: cfg.command.clone(),
                args: cfg.args.clone(),
                cwd: cfg.cwd.clone(),
                env,
                log: self.a.log.clone(),
                on_permission: Arc::new(move |params: Value| {
                    let info = describe_acp_request(&params);
                    let (g, sh) = (guard.clone(), sh_perm.clone());
                    Box::pin(async move {
                        let ok = g.ask_permission(info.clone()).await;
                        if !ok {
                            if let Some(d) = sh.denied.lock().unwrap().as_mut() {
                                d.push(Denied { category: info.category.clone(), summary: info.summary.clone() });
                            }
                        }
                        ok
                    })
                }),
                on_activity: Arc::new(move || sh_act.last_activity.store(now_ms(), Ordering::SeqCst)),
                on_exit: Arc::new(move |_why| {
                    if !sh_exit.stopped.load(Ordering::SeqCst) {
                        let tail = sh_exit.client.lock().unwrap().as_ref().map(|c| c.stderr_tail().join(" | ")).unwrap_or_default();
                        on_exit(tail);
                    }
                }),
                on_end: Some(Arc::new(move || pids.remove(pid_cell2.load(Ordering::SeqCst) as u32))),
            };
            let client = match AcpClient::spawn(opts) {
                Ok(c) => Arc::new(c),
                Err(e) => {
                    let mut err = WorkerError::new("crash", format!("起不來：{e}"));
                    err.spawn_failed = true;
                    return Err(err);
                }
            };
            pid_cell.store(client.pid() as u64, Ordering::SeqCst);
            self.a.pids.add(client.pid());
            *self.sh.client.lock().unwrap() = Some(client.clone());
            let r: Result<(), RpcError> = async {
                let init = client.initialize().await?;
                if !cfg.auth_method.is_empty() {
                    client.authenticate(&cfg.auth_method).await?;
                }
                let can_load = init.pointer("/agentCapabilities/loadSession").and_then(Value::as_bool) == Some(true);
                self.sh.can_load.store(if can_load { 1 } else { 2 }, Ordering::SeqCst);
                let cwd = cfg.cwd.to_string_lossy().to_string();
                let mut sid = self.sh.sid.lock().unwrap().clone();
                let mut resp: Option<Value> = None;
                if cfg.adopted {
                    // 接手別人的對話：一定要載入指定的那一段，載不進來就失敗，不偷偷開新對話
                    if sid.is_empty() || !can_load {
                        return Err(RpcError { message: "這個 agent 沒有宣告能載入既有的對話，沒辦法接手".into(), code: None });
                    }
                    match client.load_session(&sid, &cwd).await {
                        Ok(r) => resp = Some(r),
                        Err(e) => return Err(RpcError { message: format!("載入那段對話失敗：{}", e.message), code: e.code }),
                    }
                } else if !sid.is_empty() && can_load {
                    match client.load_session(&sid, &cwd).await {
                        Ok(r) => resp = Some(r),
                        Err(e) => {
                            (self.a.log)(format!("session/load 失敗，改開新的：{}", e.message));
                            self.sh.resume_lost.store(true, Ordering::SeqCst);
                            sid.clear();
                        }
                    }
                } else if !sid.is_empty() {
                    self.sh.resume_lost.store(true, Ordering::SeqCst);
                    sid.clear();
                }
                if sid.is_empty() {
                    let (s, r) = client.new_session_full(&cwd).await?;
                    sid = s;
                    resp = Some(r);
                }
                *self.sh.sid.lock().unwrap() = sid.clone();
                if let Some(m) = resp.as_ref().and_then(session_models) {
                    *self.sh.models.lock().unwrap() = m;
                }
                self.apply_recorded_model(&client, &sid).await;
                Ok(())
            }
            .await;
            if let Err(e) = r {
                let err = self.classify(&e, "啟動時：");
                client.stop();
                return Err(err);
            }
            Ok(())
        })
    }

    fn turn(&self, text: String, timeout_ms: u64, max_ms: u64) -> BoxFut<'_, Result<TurnResult, WorkerError>> {
        Box::pin(async move {
            let Some(client) = self.sh.client.lock().unwrap().clone().filter(|c| c.alive()) else { return Err(WorkerError::new("crash", "ACP agent 沒有在跑")) };
            {
                let mut d = self.sh.denied.lock().unwrap();
                if d.is_some() {
                    return Err(WorkerError::new("agent", "上一輪還沒結束"));
                }
                *d = Some(vec![]);
            }
            let sid = self.session_id();
            let started = now_ms();
            self.touch();
            let prompt = client.prompt(&sid, &text, max_ms + 5000);
            tokio::pin!(prompt);
            let result = loop {
                let last = self.sh.last_activity.load(Ordering::SeqCst);
                let wake = (last + timeout_ms).min(started + max_ms);
                let wait = wake.saturating_sub(now_ms()).max(1);
                tokio::select! {
                    r = &mut prompt => break Some(r),
                    _ = tokio::time::sleep(std::time::Duration::from_millis(wait)) => {
                        let (n, last) = (now_ms(), self.sh.last_activity.load(Ordering::SeqCst));
                        if n >= started + max_ms || n >= last + timeout_ms { break None }
                    }
                }
            };
            let denied = self.sh.denied.lock().unwrap().take().unwrap_or_default();
            match result {
                None => {
                    client.cancel(&sid);
                    client.stop();
                    Err(WorkerError::new("timeout", "逾時"))
                }
                Some(Err(e)) => {
                    if self.sh.stopped.load(Ordering::SeqCst) {
                        return Err(WorkerError::new("stopped", "工作者被停止"));
                    }
                    Err(self.classify(&e, ""))
                }
                Some(Ok((_, Some(r)))) if r == "cancelled" => Err(WorkerError::new("agent", "agent 取消了這一輪")),
                Some(Ok((text, _))) => Ok(TurnResult { text, denied }),
            }
        })
    }

    fn stop(&self) {
        self.sh.stopped.store(true, Ordering::SeqCst);
        if let Some(c) = self.sh.client.lock().unwrap().as_ref() {
            c.stop();
        }
    }
}

pub fn default_make_driver() -> MakeDriver {
    Arc::new(|a: DriverArgs| -> Arc<dyn Driver> {
        if a.cfg.protocol == "agy-stream" { Arc::new(super::acp_agy::AgyDriver::new(a)) } else { Arc::new(AcpDriver::new(a)) }
    })
}

// ---- 引擎 ---------------------------------------------------------------------------------------

pub struct AcpEngine {
    ctx: EngineCtx,
    approvals: Arc<Approvals>,
    make_driver: MakeDriver,
    workers: Arc<Mutex<Vec<(String, WorkerHandle)>>>,
    /// 帳本（start 時才開）；接手要用同一份存對話編號
    store: Mutex<Option<Arc<Store>>>,
    /// 消化「開新夥伴」請求用的本機環境（啟動設定、指令是否存在）；測試換成假的
    queue_env: Mutex<Arc<dyn super::partner_queue::QueueEnv>>,
    /// 同一時間只有一輪在消化請求
    queue_busy: Mutex<()>,
}

impl AcpEngine {
    pub fn new(ctx: EngineCtx, make_driver: Option<MakeDriver>) -> AcpEngine {
        let env: Arc<dyn super::partner_queue::QueueEnv> = Arc::new(super::partner_queue::SystemQueueEnv { data_dir: ctx.data_dir.clone() });
        AcpEngine { ctx, approvals: Approvals::new(), make_driver: make_driver.unwrap_or_else(default_make_driver), workers: Arc::new(Mutex::new(vec![])), store: Mutex::new(None), queue_env: Mutex::new(env), queue_busy: Mutex::new(()) }
    }

    /// 測試用：換掉消化請求時的本機環境
    #[cfg(test)]
    pub fn set_queue_env(&self, env: Arc<dyn super::partner_queue::QueueEnv>) {
        *self.queue_env.lock().unwrap() = env;
    }

    /// 動態加一個背景工作者（開新夥伴）。同名且還在名單上（沒被關閉）＝失敗；同名但已被關閉／起不來＝換成新的
    fn add_partner(&self, cfg: WorkerCfg) -> Result<(), String> {
        let store = self.store.lock().unwrap().clone().ok_or("工作者管理還沒啟動")?;
        {
            let mut ws = self.workers.lock().unwrap();
            if let Some(i) = ws.iter().position(|(n, _)| n.eq_ignore_ascii_case(&cfg.name)) {
                if ws[i].1.listed() && !ws[i].1.admin_stopped() {
                    return Err(format!("已經有叫「{}」的工作者", cfg.name));
                }
                let (_, old) = ws.remove(i);
                old.stop();
            }
        }
        std::fs::create_dir_all(&cfg.cwd).map_err(|e| format!("工作資料夾建不起來（{}）：{e}", cfg.cwd.display()))?;
        let name = cfg.name.clone();
        let (protocol, cwd) = (cfg.protocol.clone(), cfg.cwd.display().to_string());
        let w = self.make_worker(Arc::new(cfg), store);
        self.workers.lock().unwrap().push((name.clone(), w.clone()));
        w.start();
        self.ctx.log(format!("acp: 動態啟動工作者 {name}（protocol={protocol} cwd={cwd}）"));
        Ok(())
    }

    /// 消化佇列檔裡的「開新夥伴」請求（橋的定時檢查呼叫）。每一行的結果都記 log，失敗寫明中文原因
    fn consume_queue(&self) {
        use super::partner_queue as pq;
        let Ok(_busy) = self.queue_busy.try_lock() else { return };
        if self.store.lock().unwrap().is_none() {
            return;
        }
        let lines = match pq::claim(&self.ctx.work_dir) {
            Ok(l) => l,
            Err(e) => {
                self.ctx.log(format!("partner-queue: {e}"));
                return;
            }
        };
        if lines.is_empty() {
            return;
        }
        let env = self.queue_env.lock().unwrap().clone();
        let mut changed = false;
        for line in lines {
            let req = match pq::parse_line(&line) {
                Ok(r) => r,
                Err(e) => {
                    self.ctx.log(format!("partner-queue: 沒能開出工作者：{e}"));
                    continue;
                }
            };
            let r = pq::build_cfg(&*env, &req, &self.ctx.work_dir).and_then(|cfg| {
                let cwd = cfg.cwd.display().to_string();
                self.add_partner(cfg).map(|_| cwd)
            });
            match r {
                Ok(cwd) => {
                    pq::remember(&self.ctx.work_dir.join(pq::PARTNERS_FILE), &req.name, &req.profile, &cwd);
                    changed = true;
                }
                Err(e) => {
                    self.ctx.log(format!("partner-queue: 沒能開出工作者「{}」（模型 {}）：{e}", req.name, req.profile));
                    pq::record_failure(&self.ctx.work_dir, &req.name, &req.profile, &e);
                }
            }
        }
        if changed {
            let _ = self.ctx.events.send(EngineEvent::RosterChanged);
        }
    }

    fn window_of(w: &Worker) -> Window {
        let cfg = w.cfg();
        Window {
            name: cfg.name.clone(),
            status: Some(w.status().to_string()),
            cwd: cfg.cwd.to_string_lossy().to_string(),
            pid: 0,
            updated_at: 0,
            session_id: Some(w.session_id()).filter(|s| roster_session_ok(s)),   // 名單帶對話編號：後台靠它認得「同一位改名／重啟」；格式不符就不帶（維持原狀）
            engine: "acp".into(),
            engine_label: Some(cfg.roster_engine.clone()),
            no_fallback: true,
            cwd_label_override: Some(cfg.label.clone()),
            detail: None,
            context_pct: None,
            mod_loaded: false,
            model: Some(w.effective_model()).filter(|m| !m.is_empty()),
            hidden: None,
        }
    }

    fn make_worker(&self, cfg: Arc<WorkerCfg>, store: Arc<Store>) -> WorkerHandle {
        make_worker_with(&self.ctx, &self.approvals, &self.make_driver, cfg, store)
    }
}

/// 接手名冊檔（工作資料夾底下）：記著接手過的專屬工作者，重啟後建回來
pub const ADOPTED_FILE: &str = "acp-adopted.json";

/// 工作者的設定套上切換模型時記下的模型（acp-models.json；壞了就當沒有、記 log）
fn with_recorded_model(ctx: &EngineCtx, cfg: Arc<WorkerCfg>) -> Arc<WorkerCfg> {
    let log = ctx.log.clone();
    let models = super::acp_models::load(&ctx.work_dir.join(super::acp_models::MODELS_FILE), &move |m| log(m));
    match models.get(&cfg.name) {
        Some(m) if *m != cfg.model => Arc::new(WorkerCfg { model: m.clone(), ..(*cfg).clone() }),
        _ => cfg,
    }
}

fn make_worker_with(ctx: &EngineCtx, approvals: &Arc<Approvals>, make_driver: &MakeDriver, cfg: Arc<WorkerCfg>, store: Arc<Store>) -> WorkerHandle {
    let cfg = with_recorded_model(ctx, cfg);
    Worker::new(WorkerInit {
        cfg,
        env: ctx.env.clone(),
        log: ctx.log.clone(),
        approvals: approvals.clone(),
        notify: ctx.notify.clone(),
        store,
        make_driver: make_driver.clone(),
        events: ctx.events.clone(),
        pids: ctx.pids.clone(),
        handoff_dir: ctx.handoff_dir.clone(),
    })
}

impl Engine for AcpEngine {
    fn id(&self) -> &'static str {
        "acp"
    }

    fn start(&self) {
        let store = Store::open(self.ctx.work_dir.join("acp-workers.json"), self.ctx.log.clone());
        *self.store.lock().unwrap() = Some(store.clone());
        let conf = load_workers_config(&self.ctx.agents_file, &self.ctx.work_dir);
        for e in &conf.errors {
            self.ctx.log(format!("acp: 設定有問題，已跳過：{e}"));
        }
        for w in &conf.warnings {
            self.ctx.log(format!("acp: 設定提醒：{w}"));
        }
        if conf.workers.is_empty() {
            self.ctx.log(format!("acp: 沒有任何工作者（{}）。範本：relay/machine/agents.example.json", self.ctx.agents_file.display()));
        }
        let mut base_grok = conf.workers.iter().find(|c| c.roster_engine == "grok" && c.protocol == "acp").cloned();
        for cfg in conf.workers {
            if let Err(e) = std::fs::create_dir_all(&cfg.cwd) {
                self.ctx.log(format!("acp: {} 的工作資料夾建不起來（{}）：{e}", cfg.name, cfg.cwd.display()));
                continue;
            }
            let p = &cfg.permissions;
            let line = format!(
                "acp: 工作者 {} 啟動（protocol={} cwd={} 權限 read={} write={} execute={} network={}）",
                cfg.name,
                cfg.protocol,
                cfg.cwd.display(),
                p.rule("read").name(),
                p.rule("write").name(),
                p.rule("execute").name(),
                p.rule("network").name()
            );
            let name = cfg.name.clone();
            let w = self.make_worker(Arc::new(cfg), store.clone());
            self.workers.lock().unwrap().push((name, w.clone()));
            w.start();
            self.ctx.log(line);
        }
        // 開新夥伴開出過的背景工作者：重啟後依 profile 重建（重驗授權與指令；現在不成立的留在名冊裡、記 log、不啟動）
        for (name, profile, cwd) in super::partner_queue::read_partners(&self.ctx.work_dir.join(super::partner_queue::PARTNERS_FILE)) {
            let req = super::partner_queue::Req { profile, name: name.clone(), cwd };
            let env = self.queue_env.lock().unwrap().clone();
            match super::partner_queue::build_cfg(&*env, &req, &self.ctx.work_dir).and_then(|cfg| self.add_partner(cfg)) {
                Ok(()) => {}
                Err(e) => self.ctx.log(format!("acp: 重啟後沒能建回背景工作者「{name}」：{e}")),
            }
        }
        // 沒有 agents.json 的 Grok 設定時，開新夥伴開出的 grok 工作者就是接手的底
        if base_grok.is_none() {
            base_grok = self.workers.lock().unwrap().iter().map(|(_, w)| w.cfg().clone()).find(|c| c.roster_engine == "grok" && c.protocol == "acp" && !c.adopted);
        }
        // 接手過的專屬工作者（使用者在終端機開的 grok 的對話）：重啟後建回來，對話編號已在帳本裡
        {
            for (name, sid, cwd) in super::acp_admin::read_adopted(&self.ctx.work_dir.join(ADOPTED_FILE)) {
                if self.workers.lock().unwrap().iter().any(|(n, _)| *n == name) {
                    continue;
                }
                // 沒有現成的 Grok 工作者就用「開新夥伴」的 grok 啟動設定做底（和接手時同一條路）；建不起來就記 log 跳過，名冊留著
                let base = match &base_grok {
                    Some(b) => b.clone(),
                    None => {
                        let req = super::partner_queue::Req { profile: "grok".into(), name: name.clone(), cwd: cwd.clone() };
                        let env = self.queue_env.lock().unwrap().clone();
                        match super::partner_queue::build_cfg(&*env, &req, &self.ctx.work_dir) {
                            Ok(c) => c,
                            Err(e) => {
                                self.ctx.log(format!("acp: 重啟後沒能建回接手的專屬工作者「{name}」：{e}"));
                                continue;
                            }
                        }
                    }
                };
                let cfg = Arc::new(super::grok_adopt::adopted_cfg(&base, &name, &cwd));
                store.set(&cfg, &sid);
                let w = self.make_worker(cfg, store.clone());
                self.workers.lock().unwrap().push((name.clone(), w.clone()));
                w.start();
                self.ctx.log(format!("acp: 接手的專屬工作者 {name} 啟動（載入原本的對話）"));
            }
        }
    }

    fn poll(&self) {
        self.consume_queue();
    }

    fn acp_admin(&self) -> Option<Arc<dyn super::acp_admin::AcpAdmin>> {
        let store = self.store.lock().unwrap().clone();
        let adopt = store.map(|store| {
            let (ctx, approvals, make_driver) = (self.ctx.clone(), self.approvals.clone(), self.make_driver.clone());
            super::acp_admin::AdoptEnv {
                make: Arc::new({
                    let store = store.clone();
                    move |cfg| make_worker_with(&ctx, &approvals, &make_driver, cfg, store.clone())
                }),
                store,
                file: self.ctx.work_dir.join(ADOPTED_FILE),
                events: self.ctx.events.clone(),
                wait_ms: super::acp_admin::ADOPT_WAIT_MS,
                base: {
                    let (env, work_dir) = (self.queue_env.lock().unwrap().clone(), self.ctx.work_dir.clone());
                    Arc::new(move |cwd: &str| {
                        let req = super::partner_queue::Req { profile: "grok".into(), name: super::grok_adopt::worker_name(cwd, ""), cwd: cwd.to_string() };
                        super::partner_queue::build_cfg(&*env, &req, &work_dir).map_err(|e| format!("這台電腦沒有現成的 Grok 內建通道工作者，改用「開新夥伴」的 grok 設定也開不起來：{e}"))
                    })
                },
            }
        });
        let wd = &self.ctx.work_dir;
        Some(Arc::new(super::acp_admin::AcpAdminImpl {
            workers: self.workers.clone(),
            adopt,
            models_file: wd.join(super::acp_models::MODELS_FILE),
            partners_file: wd.join(super::partner_queue::PARTNERS_FILE),
            adopted_file: wd.join(ADOPTED_FILE),
            renames_file: wd.join(super::acp_renames::RENAMES_FILE),
            events: self.ctx.events.clone(),
        }))
    }

    fn stop(&self) {
        for (_, w) in self.workers.lock().unwrap().iter() {
            w.stop();
        }
    }

    /// 寄給改名前舊名的信：7 天內換成現在的名字（連續改名串起來）。舊名現在還是某個工作者的名字、或串到的名字已經不在，就不換
    fn canonical_name(&self, name: &str) -> Option<String> {
        let ws = self.workers.lock().unwrap();
        if ws.iter().any(|(n, _)| n == name) {
            return None;
        }
        let list = super::acp_renames::read(&self.ctx.work_dir.join(super::acp_renames::RENAMES_FILE), now_ms());
        let to = super::acp_renames::resolve(&list, name)?;
        ws.iter().any(|(n, _)| *n == to).then_some(to)
    }

    fn list(&self) -> BoxFut<'_, Option<Vec<Window>>> {
        Box::pin(async move {
            let ws: Vec<WorkerHandle> = self.workers.lock().unwrap().iter().map(|(_, w)| w.clone()).collect();
            for w in &ws {
                w.maybe_revive();
            }
            Some(ws.iter().filter(|w| w.listed()).map(|w| Self::window_of(w)).collect())
        })
    }

    /// 轉交一封信給工作者。授權回覆（寫給這個工作者、來自被問的人）在這裡攔下，不送進模型
    fn deliver(&self, id: &str, to: &str, text: &str) -> Result<(), String> {
        let Some(w) = self.workers.lock().unwrap().iter().find(|(n, _)| n == to).map(|(_, w)| w.clone()) else { return Err(format!("沒有名叫 {to} 的 acp 工作者")) };
        let (node, agent, body) = parse_mail_text(text);
        let r = self.approvals.handle_reply(to, &node, &agent, &body);
        if r.handled {
            let _ = self.ctx.events.send(EngineEvent::Sent(id.to_string()));
            if let Some(note) = r.note {
                let _ = self.ctx.events.send(EngineEvent::Reply { from: to.to_string(), text: note, mail_id: Some(id.to_string()) });
            }
            return Ok(());
        }
        // 要不要把回覆寄回：和橋同一條規則——抬頭的 reply=yes|no 是寄件人明說的，有就只看它；
        // reply=?（舊信沒有欄位）才退回看內文標記。寄件人是收發室的系統信照舊不寄回
        let no_reply = !wants_reply(head_reply(text), &body) || agent.ends_with("收發室");
        w.enqueue(Job { id: id.to_string(), text: text.to_string(), sender_node: node, sender_agent: agent, no_reply });
        Ok(())
    }
}

#[cfg(test)]
mod roster_session_tests {
    use super::roster_session_ok;

    #[test]
    fn 名單的對話編號_只帶後台收得下的格式() {
        for ok in ["15deff0c-d2a6-4a8f-b6b9-6cb4fb9007df", "01a16c71-c809-7650-898d-fde24188667f", "sess_0001", "abcdefgh", &"a".repeat(80)] {
            assert!(roster_session_ok(ok), "{ok}");
        }
        for bad in ["", "short", "有中文的編號12345", "has space 123", "a/b/c/d/e/f/g", "../../etc/pwd1", &"a".repeat(81)] {
            assert!(!roster_session_ok(bad), "{bad}");
        }
    }
}

//! 通用 ACP 引擎：由內建橋依 `~/.irori-relay/agents.json` 長駐啟動一批「工作者」（背景 AI，例如 Gemini），
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
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
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
}

pub struct AcpDriver {
    a: DriverArgs,
    sh: Arc<Shared>,
}

impl AcpDriver {
    pub fn new(a: DriverArgs) -> AcpDriver {
        let sid = a.session_id.clone();
        AcpDriver { a, sh: Arc::new(Shared { sid: Mutex::new(sid), resume_lost: AtomicBool::new(false), client: Mutex::new(None), denied: Mutex::new(None), last_activity: AtomicU64::new(0), stopped: AtomicBool::new(false) }) }
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
                let cwd = cfg.cwd.to_string_lossy().to_string();
                let mut sid = self.sh.sid.lock().unwrap().clone();
                if !sid.is_empty() && can_load {
                    if let Err(e) = client.load_session(&sid, &cwd).await {
                        (self.a.log)(format!("session/load 失敗，改開新的：{}", e.message));
                        self.sh.resume_lost.store(true, Ordering::SeqCst);
                        sid.clear();
                    }
                } else if !sid.is_empty() {
                    self.sh.resume_lost.store(true, Ordering::SeqCst);
                    sid.clear();
                }
                if sid.is_empty() {
                    sid = client.new_session(&cwd).await?;
                }
                *self.sh.sid.lock().unwrap() = sid;
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
    workers: Mutex<Vec<(String, WorkerHandle)>>,
}

impl AcpEngine {
    pub fn new(ctx: EngineCtx, make_driver: Option<MakeDriver>) -> AcpEngine {
        AcpEngine { ctx, approvals: Approvals::new(), make_driver: make_driver.unwrap_or_else(default_make_driver), workers: Mutex::new(vec![]) }
    }

    fn window_of(w: &Worker) -> Window {
        let cfg = w.cfg();
        Window {
            name: cfg.name.clone(),
            status: Some(w.status().to_string()),
            cwd: cfg.cwd.to_string_lossy().to_string(),
            pid: 0,
            updated_at: 0,
            session_id: None,
            engine: "acp".into(),
            engine_label: Some(cfg.roster_engine.clone()),
            no_fallback: true,
            cwd_label_override: Some(cfg.label.clone()),
        }
    }

    fn make_worker(&self, cfg: Arc<WorkerCfg>, store: Arc<Store>) -> WorkerHandle {
        let notify = self.ctx.notify.clone();
        Worker::new(WorkerInit {
            cfg,
            env: self.ctx.env.clone(),
            log: self.ctx.log.clone(),
            approvals: self.approvals.clone(),
            notify,
            store,
            make_driver: self.make_driver.clone(),
            events: self.ctx.events.clone(),
            pids: self.ctx.pids.clone(),
        })
    }
}

impl Engine for AcpEngine {
    fn id(&self) -> &'static str {
        "acp"
    }

    fn start(&self) {
        let store = Store::open(self.ctx.work_dir.join("acp-workers.json"), self.ctx.log.clone());
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
    }

    fn stop(&self) {
        for (_, w) in self.workers.lock().unwrap().iter() {
            w.stop();
        }
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

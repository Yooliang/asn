//! agy（Antigravity CLI）原生 stream-json 驅動：長駐一個 `agy --input-format stream-json --output-format stream-json`，
//! 一行一則 NDJSON；每輪送 {"event":"user","message":{"content":"…"}}，讀到 {"event":"result"} 結束。同一個行程＝同一個 conversation。
//! 對應 engines/acp-driver-agy.mjs。權限的現實（實測）：agy 無頭模式不能問人，指令會被它自己拒絕，但寫檔不問就直接寫，
//! 所以看每個工具步驟的事件，違反政策就立刻殺掉行程（絆線：能擋住後續動作並明確回報，但那一次寫入可能已經發生）。
use super::acp_config::WorkerCfg;
use super::acp_policy::{agy_scratch, agy_user_home, describe_agy_tool, sensitive_write, WorkerError};
use super::acp_worker::{Denied, Driver, DriverArgs, TurnResult};
use super::rpc::{Rpc, SpawnOpts};
use super::{acp_clean_env, BoxFut};
use serde_json::{json, Value};
use std::collections::HashSet;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use tokio::sync::oneshot;

fn now_ms() -> u64 {
    crate::heartbeat::now_ms()
}

/// cfg.args 放最前面（可放額外旗標；測試時放假 agy 的腳本路徑），後面才是這個驅動需要的旗標
pub fn agy_args(cfg: &WorkerCfg, session_id: &str, full_access: bool) -> Vec<String> {
    let mut a = cfg.args.clone();
    a.extend(["--input-format", "stream-json", "--output-format", "stream-json"].map(String::from));
    if !cfg.model.is_empty() {
        a.extend(["--model".to_string(), cfg.model.clone()]);
    }
    if !session_id.is_empty() {
        a.extend(["--conversation".to_string(), session_id.to_string()]);
    }
    if full_access {
        a.push("--dangerously-skip-permissions".into());
    }
    a
}

struct Cur {
    tx: Option<oneshot::Sender<Result<TurnResult, WorkerError>>>,
    denied: Vec<Denied>,
    seen: HashSet<String>,
    /// （原因, 摘要, 可以請它換位置再寫的路徑）
    violation: Option<(String, String, Option<String>)>,
    /// 這一輪出現過任何工具步驟（含失敗的）：之後失敗時要告訴上層「已經動手了」
    tools: bool,
}

struct Shared {
    sid: Mutex<String>,
    resume_lost: AtomicBool,
    rpc: Mutex<Option<Rpc>>,
    cur: Mutex<Option<Cur>>,
    last_activity: AtomicU64,
}

impl Shared {
    fn finish(&self, r: Result<TurnResult, WorkerError>) {
        let c = self.cur.lock().unwrap().take();
        if let Some(mut c) = c {
            let mut r = r;
            if let Err(e) = &mut r {
                e.had_steps |= c.tools;
            }
            if let Some(tx) = c.tx.take() {
                let _ = tx.send(r);
            }
        }
    }
}

pub struct AgyDriver {
    a: DriverArgs,
    sh: Arc<Shared>,
}

impl AgyDriver {
    pub fn new(a: DriverArgs) -> AgyDriver {
        let sid = a.session_id.clone();
        AgyDriver { a, sh: Arc::new(Shared { sid: Mutex::new(sid), resume_lost: AtomicBool::new(false), rpc: Mutex::new(None), cur: Mutex::new(None), last_activity: AtomicU64::new(0) }) }
    }

    /// 殺掉行程並依原因結案這一輪（violation 帶政策說明）
    fn kill(&self, why: &'static str) {
        kill_with(&self.sh, why);
    }
}

fn kill_with(sh: &Arc<Shared>, why: &'static str) {
    let violation = sh.cur.lock().unwrap().as_ref().and_then(|c| c.violation.clone());
    let err = match (why, violation) {
        ("violation", Some((reason, summary, redirect))) => {
            let mut e = WorkerError::new("violation", reason);
            e.summary = Some(summary);
            e.redirect = redirect;
            e
        }
        ("stop", _) => WorkerError::new("stopped", "工作者被停止"),
        _ => WorkerError::new("timeout", "逾時"),
    };
    sh.finish(Err(err));
    if let Some(r) = sh.rpc.lock().unwrap().as_ref() {
        r.kill_now();
    }
}

fn on_event(sh: &Arc<Shared>, a: &DriverArgs, ev: Value) {
    if sh.cur.lock().unwrap().is_some() {
        sh.last_activity.store(now_ms(), Ordering::SeqCst);
    }
    let kind = ev.get("event").and_then(Value::as_str).unwrap_or("");
    match kind {
        "init" => {
            let conv = ev.get("conversation_id").and_then(Value::as_str).unwrap_or("");
            if !a.session_id.is_empty() && !conv.is_empty() && conv != a.session_id {
                sh.resume_lost.store(true, Ordering::SeqCst);
                (a.log)(format!("agy 找不到先前的 conversation {}，已開新的 {conv}", a.session_id));
            }
            if !conv.is_empty() {
                *sh.sid.lock().unwrap() = conv.to_string();
            }
        }
        "step_update" => {
            if sh.cur.lock().unwrap().is_some() {
                on_step(sh, a, ev.get("step_update").cloned().unwrap_or(Value::Null));
            }
        }
        "result" => {
            if sh.cur.lock().unwrap().is_some() {
                on_result(sh, ev.get("result").cloned().unwrap_or(Value::Null));
            }
        }
        _ => {}
    }
}

fn on_step(sh: &Arc<Shared>, a: &DriverArgs, s: Value) {
    if let Some(conv) = s.get("conversation_id").and_then(Value::as_str).filter(|c| !c.is_empty()) {
        let mut g = sh.sid.lock().unwrap();
        if g.is_empty() {
            *g = conv.to_string();
        }
    }
    if s.get("step_type").and_then(Value::as_str) != Some("tool") {
        return;
    }
    if let Some(c) = sh.cur.lock().unwrap().as_mut() {
        c.tools = true;
    }
    let info = describe_agy_tool(s.get("tool_name").and_then(Value::as_str).unwrap_or(""), s.pointer("/tool_info/parameters"));
    let key = s.get("step_index").map(|v| v.to_string()).unwrap_or_default();
    let state = s.get("state").and_then(Value::as_str).unwrap_or("");
    if state == "ERROR" {
        let msg = s.pointer("/tool_info/error/message").and_then(Value::as_str).unwrap_or("").to_lowercase();
        if msg.contains("permission check failed") || msg.contains("user denied permission") {
            if let Some(c) = sh.cur.lock().unwrap().as_mut() {
                c.denied.push(Denied { category: info.category.clone(), summary: info.summary.clone() });
            }
        }
        return;
    }
    if let Some(c) = sh.cur.lock().unwrap().as_mut() {
        c.seen.insert(key);
    }
    let home = agy_user_home(&a.env);
    let sid = sh.sid.lock().unwrap().clone();
    if let Err(reason) = a.guard.check_tool(&info, state, a.full_access, agy_scratch(&home, &sid).as_deref()) {
        // 寫到不能寫、但不是放登入資料或金鑰的地方：上層接回同一段對話請它改寫到工作資料夾（#608）；寫到敏感位置或其他種類的違規照舊整輪中止
        let redirect = (info.category == "write" && !info.paths.is_empty() && !sensitive_write(&info.paths, &home, &a.cfg.cwd)).then(|| info.paths.join("、"));
        if let Some(c) = sh.cur.lock().unwrap().as_mut() {
            c.violation = Some((reason.clone(), info.summary.clone(), redirect));
        }
        (a.log)(format!("policy violation: {} ({reason}) → kill agy", info.summary));
        kill_with(sh, "violation");
    }
}

fn on_result(sh: &Arc<Shared>, r: Value) {
    if let Some(conv) = r.get("conversation_id").and_then(Value::as_str).filter(|c| !c.is_empty()) {
        *sh.sid.lock().unwrap() = conv.to_string();
    }
    let (violation, mut denied) = {
        let g = sh.cur.lock().unwrap();
        let Some(c) = g.as_ref() else { return };
        (c.violation.clone(), c.denied.clone())
    };
    if let Some((reason, summary, redirect)) = violation {
        let mut e = WorkerError::new("violation", reason);
        e.summary = Some(summary);
        e.redirect = redirect;
        return sh.finish(Err(e));
    }
    for d in r.get("denied_actions").and_then(Value::as_array).into_iter().flatten() {
        if denied.is_empty() {
            let action = d.get("action").and_then(Value::as_str).unwrap_or("");
            denied.push(Denied { category: if action == "command" { "execute".into() } else { "other".into() }, summary: d.get("display_name").and_then(Value::as_str).unwrap_or(action).to_string() });
        }
    }
    if r.get("status").and_then(Value::as_str).unwrap_or("").to_uppercase() == "SUCCESS" {
        return sh.finish(Ok(TurnResult { text: r.get("response").and_then(Value::as_str).unwrap_or("").to_string(), denied }));
    }
    let err = r.get("error").and_then(Value::as_str).or_else(|| r.get("status").and_then(Value::as_str)).unwrap_or("原因不明").to_string();
    sh.finish(Err(WorkerError::classify(&err, "agent", err.chars().take(400).collect::<String>())))
}

impl Driver for AgyDriver {
    fn full_access(&self) -> bool {
        self.a.full_access
    }
    fn supports_retry_with_grant(&self) -> bool {
        true
    }
    fn session_id(&self) -> String {
        self.sh.sid.lock().unwrap().clone()
    }
    fn resume_lost(&self) -> bool {
        self.sh.resume_lost.load(Ordering::SeqCst)
    }
    fn alive(&self) -> bool {
        self.sh.rpc.lock().unwrap().as_ref().map(|r| r.alive()).unwrap_or(false)
    }
    fn pid(&self) -> u32 {
        self.sh.rpc.lock().unwrap().as_ref().filter(|r| r.alive()).map(|r| r.pid()).unwrap_or(0)
    }
    fn load_session(&self) -> Option<bool> {
        // agy 靠 conversation 編號接續
        Some(true)
    }
    fn touch(&self) {
        self.sh.last_activity.store(now_ms(), Ordering::SeqCst);
    }

    fn start(&self) -> BoxFut<'_, Result<(), WorkerError>> {
        Box::pin(async move {
            let cfg = self.a.cfg.clone();
            let env = acp_clean_env(&self.a.env, &cfg.env_pass);
            let (sh_ev, a_ev) = (self.sh.clone(), self.a.clone());
            let (sh_exit, on_exit, rpc_cell) = (self.sh.clone(), self.a.on_exit.clone(), Arc::new(AtomicU64::new(0)));
            let (pids, rpc_cell2) = (self.a.pids.clone(), rpc_cell.clone());
            let rpc = Rpc::spawn(SpawnOpts {
                command: cfg.command.clone(),
                args: agy_args(&cfg, &self.a.session_id, self.a.full_access),
                cwd: cfg.cwd.clone(),
                env,
                jsonrpc: false,
                log: self.a.log.clone(),
                on_incoming: Arc::new(|_, _| {}),
                on_json_line: Some(Arc::new(move |ev| on_event(&sh_ev, &a_ev, ev))),
                on_exit: Arc::new(move |why| {
                    let rpc = sh_exit.rpc.lock().unwrap().clone();
                    let tail = rpc.map(|r| r.stderr_tail().join(" | ")).unwrap_or_default();
                    sh_exit.finish(Err(WorkerError::classify(&tail, "crash", format!("行程結束了（{why}）{}", if tail.is_empty() { String::new() } else { format!("：{tail}") }))));
                    on_exit(tail);
                }),
                on_end: Some(Arc::new(move || pids.remove(rpc_cell2.load(Ordering::SeqCst) as u32))),
            });
            match rpc {
                Ok(r) => {
                    rpc_cell.store(r.pid() as u64, Ordering::SeqCst);
                    self.a.pids.add(r.pid());
                    *self.sh.rpc.lock().unwrap() = Some(r);
                    Ok(())
                }
                Err(e) => {
                    let mut err = WorkerError::new("crash", format!("起不來：{e}"));
                    err.spawn_failed = true;
                    Err(err)
                }
            }
        })
    }

    fn turn(&self, text: String, timeout_ms: u64, max_ms: u64) -> BoxFut<'_, Result<TurnResult, WorkerError>> {
        Box::pin(async move {
            let Some(rpc) = self.sh.rpc.lock().unwrap().clone().filter(|r| r.alive()) else { return Err(WorkerError::new("crash", "agy 行程沒有在跑")) };
            let (tx, mut rx) = oneshot::channel();
            {
                let mut g = self.sh.cur.lock().unwrap();
                if g.is_some() {
                    return Err(WorkerError::new("agent", "上一輪還沒結束"));
                }
                *g = Some(Cur { tx: Some(tx), denied: vec![], seen: HashSet::new(), violation: None, tools: false });
            }
            let started = now_ms();
            self.touch();
            if let Err(e) = rpc.send(json!({ "event": "user", "message": { "content": text } })) {
                self.sh.finish(Err(WorkerError::new("crash", e)));
            }
            loop {
                let last = self.sh.last_activity.load(Ordering::SeqCst);
                let wait = (last + timeout_ms).min(started + max_ms).saturating_sub(now_ms()).max(1);
                tokio::select! {
                    r = &mut rx => return r.unwrap_or_else(|_| Err(WorkerError::new("crash", "agy 通道關閉"))),
                    _ = tokio::time::sleep(std::time::Duration::from_millis(wait)) => {
                        let (n, last) = (now_ms(), self.sh.last_activity.load(Ordering::SeqCst));
                        if n >= started + max_ms || n >= last + timeout_ms { self.kill("timeout") }
                    }
                }
            }
        })
    }

    fn stop(&self) {
        if self.sh.rpc.lock().unwrap().is_some() {
            self.kill("stop");
        }
    }
}

//! Codex CLI 引擎（對應 engines/codex.mjs；調查與取捨見 docs/archive/CODEX-ENGINE.md）。用使用者自己電腦上的 Codex CLI、
//! 使用者自己的 ChatGPT 登入額度，不碰 API 金鑰。對使用者**開著的互動視窗**（TUI／桌面版）做「名單＋轉交＋回覆」：
//!   名單 ＝ session_index.jsonl（有名字的 thread）∩ thread-writer-locks（正被某個行程開著）；忙碌 ＝ 最後一個 turn 還沒結束
//!   轉交 ＝ `codex queue --thread <id> --message=<信>`：寫進 Codex 的佇列，持有該 thread 的行程閒下來就當成使用者訊息處理
//!   回覆 ＝ 用唯讀的 `codex app-server` 輪詢 thread/turns/list，找到含本信編號的 turn、等它結束，取最終回覆文字
//!   額度 ＝ account/read、account/rateLimits/read（沒登入、額度用完 → 名單狀態標示，轉交時明確回報，不無聲失敗）
//! 讀取的行程絕不 thread/resume：載入 thread 的行程會成為持有者，會搶走使用者視窗的佇列。
//! 與舊橋的差異：不支援「遠端開 Codex 視窗」（openWindow）；視窗內主動寄信的身分判定（CODEX_THREAD_ID）不在橋裡。
use super::codex_state::{is_full_access, locked_thread_ids, read_name_index, read_policy};
use super::rpc::{Rpc, SpawnOpts};
use super::{codex_child_env, env_get, BoxFut, Engine, EngineCtx, EngineEvent};
use crate::bridge::roster::Window;
use crate::nowin::NoWindow;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

pub const TESTED_VERSION: &str = "0.154.0";
const MIN_MINOR: u64 = 154;

pub fn codex_home(env: &[(String, String)], home: &std::path::Path) -> PathBuf {
    env_get(env, "CODEX_HOME").filter(|s| !s.is_empty()).map(PathBuf::from).unwrap_or_else(|| home.join(".codex"))
}

fn now_ms() -> u64 {
    crate::heartbeat::now_ms()
}

fn num(env: &[(String, String)], k: &str, d: u64) -> u64 {
    env_get(env, k).and_then(|v| v.trim().parse::<u64>().ok()).filter(|n| *n > 0).unwrap_or(d)
}

fn cwd_label(p: &str) -> String {
    p.split(['\\', '/']).filter(|s| !s.is_empty()).last().unwrap_or("").to_string()
}

pub fn mark_of(id: &str) -> String {
    format!("irori-mail:{id}")
}

/// "codex-cli 0.154.0" → (major, minor, patch, 文字)
pub fn parse_version(text: &str) -> Option<(u64, u64, u64, String)> {
    let b = text.as_bytes();
    let mut i = 0;
    while i < b.len() {
        if b[i].is_ascii_digit() {
            let mut j = i;
            while j < b.len() && (b[j].is_ascii_digit() || b[j] == b'.') {
                j += 1;
            }
            let parts: Vec<&str> = text[i..j].trim_end_matches('.').split('.').collect();
            if parts.len() >= 3 {
                if let (Ok(a), Ok(m), Ok(p)) = (parts[0].parse(), parts[1].parse(), parts[2].parse()) {
                    return Some((a, m, p, format!("{a}.{m}.{p}")));
                }
            }
            i = j;
        } else {
            i += 1;
        }
    }
    None
}

#[derive(Clone, Debug, PartialEq)]
pub struct CodexBin {
    pub command: String,
    pub pre: Vec<String>,
}

/// 找到 codex 執行檔。測試用：ASN_CODEX_SCRIPT（舊名 IRORI_CODEX_SCRIPT）指向一支 node 腳本時，用 node 跑它來取代 codex。
/// Windows 的 npm 安裝只有 codex.cmd 外殼（不能直接 spawn），所以改成「node + 套件裡的 bin/codex.js」
pub fn resolve_codex(env: &[(String, String)]) -> CodexBin {
    if let Some(s) = env_get(env, "ASN_CODEX_SCRIPT").filter(|s| !s.is_empty()) {
        return CodexBin { command: "node".into(), pre: vec![s] };
    }
    if let Some(b) = env_get(env, "ASN_CODEX_BIN").filter(|s| !s.is_empty()) {
        return CodexBin { command: b, pre: vec![] };
    }
    if cfg!(windows) {
        let path = env_get(env, "PATH").unwrap_or_default();
        for dir in std::env::split_paths(&path) {
            if !dir.join("codex.cmd").exists() {
                continue;
            }
            let js = dir.join("node_modules").join("@openai").join("codex").join("bin").join("codex.js");
            if js.exists() {
                return CodexBin { command: "node".into(), pre: vec![js.to_string_lossy().to_string()] };
            }
        }
    }
    CodexBin { command: "codex".into(), pre: vec![] }
}

/// 執行一個 codex 子命令（codex queue、--version 之類的短命令）。stdin 一律關掉
async fn run_codex(bin: &CodexBin, args: &[String], env: &[(String, String)], cwd: &std::path::Path, timeout_ms: u64) -> Result<String, String> {
    let mut cmd = tokio::process::Command::new(&bin.command);
    cmd.no_window()
        .args(&bin.pre)
        .args(args)
        .current_dir(cwd)
        .env_clear()
        .envs(env.iter().map(|(k, v)| (k.as_str(), v.as_str())))
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    let out = match tokio::time::timeout(std::time::Duration::from_millis(timeout_ms), cmd.output()).await {
        Ok(Ok(o)) => o,
        Ok(Err(e)) => return Err(e.to_string()),
        Err(_) => return Err("逾時".into()),
    };
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr).to_string();
        let line = stderr.lines().map(str::trim).find(|l| !l.is_empty()).unwrap_or("").trim_start_matches("Error:").trim().to_string();
        return Err(if line.is_empty() { format!("結束碼 {}", out.status.code().map(|c| c.to_string()).unwrap_or_else(|| "?".into())) } else { line });
    }
    Ok(String::from_utf8_lossy(&out.stdout).to_string())
}

// ---- turn 資料 ----

fn turn_open(t: &Value) -> bool {
    !t.is_null() && t.get("completedAt").map(Value::is_null).unwrap_or(true) && !matches!(t.get("status").and_then(Value::as_str), Some("completed") | Some("failed"))
}
fn user_text_of(t: &Value) -> String {
    t.get("items")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|i| i.get("type").and_then(Value::as_str) == Some("userMessage"))
        .flat_map(|i| i.get("content").and_then(Value::as_array).cloned().unwrap_or_default())
        .map(|c| c.get("text").and_then(Value::as_str).unwrap_or("").to_string())
        .collect::<Vec<_>>()
        .join("\n")
}
fn reply_text_of(t: &Value) -> String {
    let msgs: Vec<&Value> = t
        .get("items")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|i| i.get("type").and_then(Value::as_str) == Some("agentMessage") && i.get("text").and_then(Value::as_str).map(|s| !s.trim().is_empty()).unwrap_or(false))
        .collect();
    let fin: Vec<&Value> = msgs.iter().copied().filter(|i| i.get("phase").and_then(Value::as_str) == Some("final_answer")).collect();
    let pick: Vec<&Value> = if fin.is_empty() { msgs.last().copied().into_iter().collect() } else { fin };
    pick.iter().map(|i| i.get("text").and_then(Value::as_str).unwrap_or("").trim().to_string()).collect::<Vec<_>>().join("\n\n")
}
fn turn_failure(t: &Value) -> String {
    let info = t.pointer("/error/codexErrorInfo");
    let key = match info {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Object(o)) => o.keys().next().cloned().unwrap_or_default(),
        _ => String::new(),
    };
    if key == "usageLimitExceeded" {
        return "Codex 額度用完了".into();
    }
    if key == "unauthorized" {
        return "Codex 的 ChatGPT 登入失效了，請在這台電腦重新登入".into();
    }
    if t.get("status").and_then(Value::as_str) == Some("interrupted") {
        return "Codex 這一輪被中斷了".into();
    }
    let why = t.pointer("/error/message").and_then(Value::as_str).or_else(|| t.get("status").and_then(Value::as_str)).unwrap_or("原因不明");
    format!("Codex 這一輪沒有完成：{}", why.chars().take(200).collect::<String>())
}
/// 額度重置的提示。用「約幾小時幾分後」，不依賴時區；時間已過或沒給就不提示
fn reset_text(resets_at_secs: Option<u64>, now_secs: u64) -> String {
    match resets_at_secs.filter(|s| *s > now_secs) {
        None => String::new(),
        Some(s) => {
            let m = (s - now_secs).div_ceil(60);
            if m >= 60 { format!("，約 {} 小時 {} 分後重置", m / 60, m % 60) } else { format!("，約 {m} 分後重置") }
        }
    }
}

// ---- 引擎 ----

#[derive(Clone, Debug, Default)]
struct Health {
    t: u64,
    ok: bool,
    status: String,
    reason: String,
}

#[derive(Clone)]
struct CW {
    thread_id: String,
    path: Option<String>,
}

struct Out {
    thread_id: String,
    name: String,
    t0: u64,
    warned: bool,
}

struct Inner {
    ctx: EngineCtx,
    bin: CodexBin,
    cenv: Vec<(String, String)>,
    home: PathBuf,
    poll_ms: u64,
    health_ttl_ms: u64,
    outstanding_max_ms: u64,
    drain_warn_ms: u64,
    max_mail_chars: usize,
    exists_only: bool,
    allow_full_access: bool,
    reply_note: bool,
    skip_version: bool,
    probed: tokio::sync::OnceCell<()>,
    usable: AtomicBool,
    health: Mutex<Health>,
    by_name: Mutex<HashMap<String, CW>>,
    outstanding: Mutex<HashMap<String, Out>>,
    polling: AtomicBool,
    reader: tokio::sync::Mutex<Option<Rpc>>,
    /// 排進 Codex 佇列一次一封、依收到的順序（對方視窗會照順序處理）：deliver 只把信放進這個通道，由 start 啟動的單一任務處理
    queue_tx: Mutex<Option<tokio::sync::mpsc::UnboundedSender<(String, String, String)>>>,
    warned: Mutex<HashSet<String>>,
    stopped: AtomicBool,
}

pub struct CodexEngine {
    i: Arc<Inner>,
}

impl CodexEngine {
    pub fn new(ctx: EngineCtx) -> CodexEngine {
        let env = ctx.env.clone();
        let flag = |k: &str| env_get(&env, k);
        let i = Arc::new(Inner {
            bin: resolve_codex(&env),
            cenv: codex_child_env(&env),
            home: codex_home(&env, &ctx.home),
            poll_ms: num(&env, "ASN_CODEX_POLL_MS", 2000),
            health_ttl_ms: num(&env, "ASN_CODEX_HEALTH_TTL_MS", 30_000),
            outstanding_max_ms: num(&env, "ASN_CODEX_OUTSTANDING_MAX_MS", 3_600_000),
            drain_warn_ms: num(&env, "ASN_CODEX_DRAIN_WARN_MS", 180_000),
            max_mail_chars: num(&env, "ASN_CODEX_MAX_MAIL_CHARS", 12_000) as usize, // codex queue 只能走命令列參數，Windows 命令列上限約 32k 個字元
            exists_only: flag("ASN_CODEX_LOCK_MODE").as_deref() == Some("exists") || !cfg!(windows),
            allow_full_access: flag("ASN_CODEX_ALLOW_FULL_ACCESS").as_deref() == Some("1"),
            reply_note: flag("ASN_CODEX_REPLY_NOTE").as_deref() != Some("0"),
            skip_version: flag("ASN_CODEX_SKIP_VERSION_CHECK").as_deref() == Some("1"),
            probed: tokio::sync::OnceCell::new(),
            usable: AtomicBool::new(false),
            health: Mutex::new(Health { ok: true, ..Default::default() }),
            by_name: Mutex::new(HashMap::new()),
            outstanding: Mutex::new(HashMap::new()),
            polling: AtomicBool::new(false),
            reader: tokio::sync::Mutex::new(None),
            queue_tx: Mutex::new(None),
            warned: Mutex::new(HashSet::new()),
            stopped: AtomicBool::new(false),
            ctx,
        });
        CodexEngine { i }
    }

    #[cfg(test)]
    pub fn usable(&self) -> bool {
        self.i.usable.load(Ordering::SeqCst)
    }
    #[cfg(test)]
    pub async fn probe(&self) {
        self.i.ensure_probed().await;
    }
}

impl Inner {
    fn once(&self, key: &str, msg: String) {
        if self.warned.lock().unwrap().insert(key.to_string()) {
            self.ctx.log(msg);
        }
    }

    // ---- 版本與可用性 ----
    async fn ensure_probed(&self) {
        self.probed
            .get_or_init(|| async {
                match run_codex(&self.bin, &["--version".to_string()], &self.cenv, &self.ctx.work_dir, 15_000).await {
                    Err(e) => self.ctx.log(format!("找不到可用的 codex（{e}）；Codex 引擎停用")),
                    Ok(out) => match parse_version(&out) {
                        None => self.ctx.log(format!("codex --version 看不懂：{}", out.trim().chars().take(80).collect::<String>())),
                        Some((major, minor, _, text)) => {
                            if major == 0 && minor < MIN_MINOR && !self.skip_version {
                                self.ctx.log(format!("codex {text} 比已驗證的最低版本 0.{MIN_MINOR} 舊，Codex 引擎停用（codex update 或設 ASN_CODEX_SKIP_VERSION_CHECK=1 自負風險）"));
                                return;
                            }
                            if text != TESTED_VERSION {
                                self.ctx.log(format!("codex {text}（已驗證版本 {TESTED_VERSION}）；名單或轉交若異常，先看 docs/archive/CODEX-ENGINE.md「版本穩定性」"));
                            }
                            self.usable.store(true, Ordering::SeqCst);
                        }
                    },
                }
            })
            .await;
    }

    // ---- app-server（唯讀）----
    async fn request(&self, method: &str, params: Value) -> Result<Value, String> {
        let rpc = {
            let mut g = self.reader.lock().await;
            if g.as_ref().map(|r| !r.alive()).unwrap_or(true) {
                *g = None;
                let mut args = self.bin.pre.clone();
                args.push("app-server".into());
                let pids = self.ctx.pids.clone();
                let pid_cell = Arc::new(std::sync::atomic::AtomicU32::new(0));
                let pc2 = pid_cell.clone();
                let r = Rpc::spawn(SpawnOpts {
                    command: self.bin.command.clone(),
                    args,
                    cwd: self.ctx.work_dir.clone(),
                    env: self.cenv.clone(),
                    jsonrpc: false,
                    log: {
                        let log = self.ctx.log.clone();
                        Arc::new(move |m| log(format!("codex app-server {m}")))
                    },
                    on_incoming: Arc::new(|_, _| {}), // 通知與伺服器主動請求：唯讀的讀取者一律忽略
                    on_json_line: None,
                    on_exit: Arc::new(|_| {}),
                    on_end: Some(Arc::new(move || pids.remove(pc2.load(Ordering::SeqCst)))),
                })
                .map_err(|e| format!("codex app-server 起不來：{e}"))?;
                pid_cell.store(r.pid(), Ordering::SeqCst);
                self.ctx.pids.add(r.pid());
                let init = r.request("initialize", json!({ "clientInfo": { "name": "irori-relay", "title": "irori-relay", "version": "0.1.0" } }), 20_000).await;
                if let Err(e) = init {
                    r.stop();
                    return Err(e.message);
                }
                r.notify("initialized", Value::Null);
                *g = Some(r);
            }
            g.as_ref().unwrap().clone()
        };
        rpc.request(method, params, 20_000).await.map_err(|e| e.message)
    }

    // ---- 登入與額度 ----
    async fn refresh_health(&self, force: bool) -> Health {
        let cur = self.health.lock().unwrap().clone();
        if !force && now_ms().saturating_sub(cur.t) < self.health_ttl_ms {
            return cur;
        }
        let mut next = Health { t: now_ms(), ok: true, ..Default::default() };
        match self.request("account/read", json!({ "refreshToken": false })).await {
            Err(e) => {
                let mut h = self.health.lock().unwrap();
                h.t = now_ms();
                drop(h);
                self.once("health-read", format!("account/read 失敗（略過登入檢查）：{e}"));
                return self.health.lock().unwrap().clone();
            }
            Ok(acc) => {
                if acc.get("account").map(Value::is_null).unwrap_or(true) {
                    next.ok = false;
                    next.status = "login-required".into();
                    next.reason = "Codex 還沒登入 ChatGPT（請在這台電腦執行 codex login）".into();
                } else {
                    let ty = acc.pointer("/account/type").and_then(Value::as_str).unwrap_or("").to_string();
                    match self.request("account/rateLimits/read", Value::Null).await {
                        Ok(rl) => {
                            let r = rl.get("rateLimits").cloned().unwrap_or(Value::Null);
                            if rl.get("ordinaryUsageAllowed").and_then(Value::as_bool) == Some(false) || r.get("rateLimitReachedType").map(|v| !v.is_null()).unwrap_or(false) {
                                let w = if r.get("rateLimitReachedType").and_then(Value::as_str) == Some("secondary") { r.get("secondary") } else { r.get("primary") };
                                next.ok = false;
                                next.status = "limit".into();
                                next.reason = format!("Codex 額度用完了{}", reset_text(w.and_then(|x| x.get("resetsAt")).and_then(Value::as_u64), now_ms() / 1000));
                            }
                        }
                        Err(e) => self.once("ratelimit", format!("account/rateLimits/read 失敗（略過額度檢查）：{e}")),
                    }
                    if !ty.is_empty() && ty != "chatgpt" {
                        self.once("auth", format!("注意：Codex 目前不是 ChatGPT 登入（{ty}），用量不會算在 ChatGPT 額度"));
                    }
                }
            }
        }
        *self.health.lock().unwrap() = next.clone();
        next
    }

    // ---- 名單 ----
    async fn open_windows(&self) -> Vec<(Window, CW)> {
        let (by_id, _) = read_name_index(&self.home);
        let held = locked_thread_ids(&self.home, self.exists_only);
        let mut wins: Vec<(Window, CW)> = vec![];
        let mut ids: Vec<&String> = held.iter().collect();
        ids.sort();
        for id in ids {
            let Some(name) = by_id.get(id) else {
                self.once(&format!("unnamed-{id}"), format!("有一個開著的 Codex 視窗沒有名字，不列入名單（在那個視窗輸入 /rename 取名）：{}…", id.chars().take(8).collect::<String>()));
                continue;
            };
            let th = match self.request("thread/read", json!({ "threadId": id, "includeTurns": false })).await {
                Ok(v) => v.get("thread").cloned().unwrap_or(Value::Null),
                Err(e) => {
                    self.once(&format!("read-{id}"), format!("讀不到 Codex thread {}…：{e}", id.chars().take(8).collect::<String>()));
                    continue;
                }
            };
            if th.is_null() || th.get("ephemeral").and_then(Value::as_bool) == Some(true) || th.get("parentThreadId").map(|v| !v.is_null()).unwrap_or(false) || th.get("agentRole").map(|v| !v.is_null()).unwrap_or(false) {
                continue;
            }
            let busy = match self.request("thread/turns/list", json!({ "threadId": id, "limit": 1, "sortDirection": "desc" })).await {
                Ok(r) => turn_open(r.pointer("/data/0").unwrap_or(&Value::Null)),
                Err(_) => false,
            };
            let cwd = th.get("cwd").and_then(Value::as_str).unwrap_or("").to_string();
            let updated = th.get("updatedAt").and_then(|v| v.as_f64()).unwrap_or(0.0).max(0.0) as u64 * 1000;
            wins.push((
                Window {
                    name: name.clone(),
                    status: Some(if busy { "busy" } else { "idle" }.into()),
                    cwd: cwd.clone(),
                    pid: 0,
                    updated_at: updated,
                    session_id: Some(id.clone()),
                    engine: "codex".into(),
                    engine_label: None,
                    no_fallback: false,
                    cwd_label_override: Some(cwd_label(&cwd)),
                    detail: None,
                },
                CW { thread_id: id.clone(), path: th.get("path").and_then(Value::as_str).map(String::from) },
            ));
        }
        // 同名只留最近有動靜的那個（先到先得的規則在橋那一層）
        let mut best: Vec<(Window, CW)> = vec![];
        for w in wins {
            match best.iter().position(|b| b.0.name == w.0.name) {
                Some(i) => {
                    if w.0.updated_at > best[i].0.updated_at {
                        best[i] = w;
                    }
                }
                None => best.push(w),
            }
        }
        best
    }

    async fn list(&self) -> Option<Vec<Window>> {
        self.ensure_probed().await;
        if !self.usable.load(Ordering::SeqCst) {
            return None;
        }
        let h = self.refresh_health(false).await;
        let wins = self.open_windows().await;
        let mut map = HashMap::new();
        let mut out = vec![];
        for (mut w, cw) in wins {
            if !h.ok && !h.status.is_empty() {
                w.status = Some(h.status.clone()); // 沒登入／額度用完：名單上標示，橋照常列出
            }
            map.insert(w.name.clone(), cw);
            out.push(w);
        }
        *self.by_name.lock().unwrap() = map;
        Some(out)
    }

    // ---- 轉交與回覆 ----
    fn wrap(&self, id: &str, text: &str) -> String {
        format!("{text}\n\n（{}{}）", mark_of(id), if self.reply_note { "｜這是收發室轉來的信；你這一輪的最終回覆會由收發室自動寄回給寄件人，不必另外寄信。" } else { "" })
    }

    fn fail(&self, id: &str, reason: String) {
        let _ = self.ctx.events.send(EngineEvent::Fail(id.to_string(), reason));
    }

    async fn deliver_async(self: &Arc<Self>, id: String, to: String, text: String) {
        let Some(w) = self.by_name.lock().unwrap().get(&to).cloned() else { return self.fail(&id, format!("找不到開著的 Codex 視窗「{to}」")) };
        let h = self.refresh_health(true).await;
        if !h.ok && !h.status.is_empty() {
            return self.fail(&id, h.reason);
        }
        if !locked_thread_ids(&self.home, self.exists_only).contains(&w.thread_id) {
            return self.fail(&id, format!("Codex 視窗「{to}」已關閉"));
        }
        let n = text.chars().count();
        if n > self.max_mail_chars {
            return self.fail(&id, format!("信太長（{n} 字，上限 {}），Codex 轉交走命令列放不下", self.max_mail_chars));
        }
        let policy = w.path.as_deref().and_then(|p| read_policy(std::path::Path::new(p), 1 << 20, 64 << 20));
        // 讀不到權限設定＝不知道是不是完全存取：寧可不轉（fail-closed）
        let Some(policy) = policy.or_else(|| self.allow_full_access.then(|| super::codex_state::Policy { approval: String::new(), sandbox: String::new() })) else {
            return self.fail(&id, format!("讀不到 Codex 視窗「{to}」的權限設定，收發室不把外部來信轉進去（要放行請設 ASN_CODEX_ALLOW_FULL_ACCESS=1）"));
        };
        if is_full_access(&policy) && !self.allow_full_access {
            return self.fail(&id, format!("Codex 視窗「{to}」是「完全存取（沒有沙盒）」模式，收發室不把外部來信轉進去（要放行請設 ASN_CODEX_ALLOW_FULL_ACCESS=1）"));
        }
        // --message=<內文>（連在一起）：內文若以 -- 開頭，分開寫會被 codex 的參數解析器當成旗標而失敗
        let args = vec!["queue".to_string(), "--thread".to_string(), w.thread_id.clone(), format!("--message={}", self.wrap(&id, &text))];
        if let Err(e) = run_codex(&self.bin, &args, &self.cenv, &self.ctx.work_dir, 30_000).await {
            return self.fail(&id, format!("排進 Codex 佇列失敗：{}", e.chars().take(200).collect::<String>()));
        }
        // 先回 SENT（橋才會把狀態改成等待回覆），再開始看回覆
        let _ = self.ctx.events.send(EngineEvent::Sent(id.clone()));
        self.outstanding.lock().unwrap().insert(id, Out { thread_id: w.thread_id, name: to, t0: now_ms(), warned: false });
        self.start_polling();
    }

    async fn poll_tick(&self) {
        let now = now_ms();
        let mut by_thread: Vec<(String, Vec<String>)> = vec![];
        {
            let mut g = self.outstanding.lock().unwrap();
            let expired: Vec<String> = g.iter().filter(|(_, o)| now.saturating_sub(o.t0) > self.outstanding_max_ms).map(|(k, _)| k.clone()).collect();
            for id in expired {
                if let Some(o) = g.remove(&id) {
                    self.ctx.log(format!("codex 回覆等太久，不再追蹤 id={id} -> {}", o.name));
                }
            }
            let mut ids: Vec<(&String, &Out)> = g.iter().collect();
            ids.sort_by_key(|(_, o)| o.t0);
            for (id, o) in ids {
                match by_thread.iter_mut().find(|(t, _)| *t == o.thread_id) {
                    Some((_, v)) => v.push(id.clone()),
                    None => by_thread.push((o.thread_id.clone(), vec![id.clone()])),
                }
            }
        }
        for (thread_id, ids) in by_thread {
            let turns = match self.request("thread/turns/list", json!({ "threadId": thread_id, "limit": 10, "sortDirection": "desc" })).await {
                Ok(v) => v.get("data").and_then(Value::as_array).cloned().unwrap_or_default(),
                Err(e) => {
                    self.once(&format!("turns-{thread_id}"), format!("讀 Codex 回覆失敗（會再試）：{e}"));
                    continue;
                }
            };
            for id in ids {
                let name = match self.outstanding.lock().unwrap().get(&id) {
                    Some(o) => o.name.clone(),
                    None => continue,
                };
                let mark = mark_of(&id);
                let Some(t) = turns.iter().find(|x| user_text_of(x).contains(&mark)) else {
                    let mut g = self.outstanding.lock().unwrap();
                    if let Some(o) = g.get_mut(&id) {
                        if !o.warned && now.saturating_sub(o.t0) > self.drain_warn_ms {
                            o.warned = true;
                            self.ctx.log(format!("codex 佇列的信還沒被處理 id={id} -> {}（{}s；視窗忙碌中或卡在核准提示？）", o.name, now.saturating_sub(o.t0) / 1000));
                        }
                    }
                    continue;
                };
                if turn_open(t) {
                    continue;
                }
                self.outstanding.lock().unwrap().remove(&id);
                if matches!(t.get("status").and_then(Value::as_str), Some("failed") | Some("interrupted")) {
                    self.fail(&id, turn_failure(t));
                    continue;
                }
                let text = reply_text_of(t);
                let text = if text.is_empty() { "（Codex 這一輪沒有文字回覆）".to_string() } else { text };
                let _ = self.ctx.events.send(EngineEvent::Reply { from: name, text, mail_id: Some(id) });
            }
        }
        if self.outstanding.lock().unwrap().is_empty() {
            self.polling.store(false, Ordering::SeqCst);
        }
    }

    fn start_polling(self: &Arc<Self>) {
        if self.polling.swap(true, Ordering::SeqCst) {
            return;
        }
        let me = self.clone();
        tauri::async_runtime::spawn(async move {
            loop {
                tokio::time::sleep(std::time::Duration::from_millis(me.poll_ms)).await;
                if me.stopped.load(Ordering::SeqCst) {
                    break;
                }
                me.poll_tick().await;
                if !me.polling.load(Ordering::SeqCst) {
                    break;
                }
            }
        });
    }
}

impl Engine for CodexEngine {
    fn id(&self) -> &'static str {
        "codex"
    }
    fn start(&self) {
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<(String, String, String)>();
        *self.i.queue_tx.lock().unwrap() = Some(tx);
        let i = self.i.clone();
        tauri::async_runtime::spawn(async move {
            i.ensure_probed().await;
            while let Some((id, to, text)) = rx.recv().await {
                if i.stopped.load(Ordering::SeqCst) {
                    break;
                }
                i.deliver_async(id, to, text).await;
            }
        });
    }
    fn stop(&self) {
        self.i.stopped.store(true, Ordering::SeqCst);
        self.i.polling.store(false, Ordering::SeqCst);
        self.i.queue_tx.lock().unwrap().take();
        let i = self.i.clone();
        tauri::async_runtime::spawn(async move {
            if let Some(r) = i.reader.lock().await.take() {
                r.stop();
            }
        });
    }
    fn list(&self) -> BoxFut<'_, Option<Vec<Window>>> {
        Box::pin(async move { self.i.list().await }) // 讀失敗（或 codex 不可用）回 None：EngineSet 沿用上次的名單
    }
    /// 同步失敗＝引擎沒起來（橋把信留在 inbox 不 ack）；其餘結果都經事件非同步回來
    fn deliver(&self, id: &str, to: &str, text: &str) -> Result<(), String> {
        if !self.i.usable.load(Ordering::SeqCst) {
            return Err("codex 不可用（沒安裝、版本太舊或還在偵測）".into());
        }
        match self.i.queue_tx.lock().unwrap().as_ref() {
            Some(tx) => tx.send((id.to_string(), to.to_string(), text.to_string())).map_err(|_| "codex 引擎已停止".to_string()),
            None => Err("codex 引擎還沒啟動".into()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 版本解析() {
        assert_eq!(parse_version("codex-cli 0.154.0\n").map(|v| v.3), Some("0.154.0".into()));
        assert_eq!(parse_version("codex-cli 1.2.30-beta").map(|v| (v.0, v.1, v.2)), Some((1, 2, 30)));
        assert!(parse_version("沒有版本").is_none());
    }

    #[test]
    fn turn_文字與失敗原因() {
        let t = json!({"status":"completed","completedAt":5,"items":[
            {"type":"userMessage","content":[{"text":"a"},{"text":"irori-mail:X"}]},
            {"type":"agentMessage","text":"中間","phase":"commentary"},
            {"type":"agentMessage","text":" 最終 ","phase":"final_answer"}]});
        assert!(user_text_of(&t).contains("irori-mail:X"));
        assert_eq!(reply_text_of(&t), "最終");
        assert!(!turn_open(&t));
        assert!(turn_open(&json!({"status":"inProgress","completedAt":null})));
        assert!(turn_open(&json!({"status":"interrupted"})), "被外部讀到的進行中 turn：completedAt 沒有就算進行中");
        assert!(turn_failure(&json!({"status":"failed","error":{"codexErrorInfo":"usageLimitExceeded"}})).contains("額度"));
        assert!(turn_failure(&json!({"status":"failed","error":{"codexErrorInfo":{"unauthorized":{}}}})).contains("登入失效"));
        assert!(turn_failure(&json!({"status":"interrupted"})).contains("中斷"));
        assert!(turn_failure(&json!({"status":"failed","error":{"message":"boom"}})).contains("boom"));
    }

    #[test]
    fn 額度重置提示_相對時間_已過或沒給就不提示() {
        assert_eq!(reset_text(Some(1_000 + 90 * 60), 1_000), "，約 1 小時 30 分後重置");
        assert_eq!(reset_text(Some(1_000 + 61), 1_000), "，約 2 分後重置");
        assert_eq!(reset_text(Some(900), 1_000), "");
        assert_eq!(reset_text(None, 1_000), "");
    }

    #[test]
    fn 找_codex_測試用腳本與指定執行檔() {
        let env = |v: &[(&str, &str)]| v.iter().map(|(a, b)| (a.to_string(), b.to_string())).collect::<Vec<_>>();
        assert_eq!(resolve_codex(&env(&[("IRORI_CODEX_SCRIPT", "x.mjs")])), CodexBin { command: "node".into(), pre: vec!["x.mjs".into()] });
        assert_eq!(resolve_codex(&env(&[("IRORI_CODEX_BIN", "/opt/codex")])), CodexBin { command: "/opt/codex".into(), pre: vec![] });
        assert_eq!(resolve_codex(&env(&[("PATH", "")])).command, "codex");
    }
}

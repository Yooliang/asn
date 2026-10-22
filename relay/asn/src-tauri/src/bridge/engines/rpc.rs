//! 子程序的「一行一則 JSON」雙向通道（ACP 與 Codex app-server 共用）。
//! 對應 relay/machine/engines/acp-client.mjs 與 codex-rpc.mjs 的行程管理部分：spawn（無視窗、乾淨環境）、
//! 一行一則 JSON 的請求／回應配對與逾時、伺服器主動送來的通知／請求交給 `on_incoming`、行程結束時讓等待中的請求失敗。
//! 不依賴任何 AI 的細節，也不知道橋；測試用 node 寫的假程式驅動它。
use crate::nowin::NoWindow;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::sync::{mpsc, oneshot, Notify};

pub type Log = Arc<dyn Fn(String) + Send + Sync>;

#[derive(Debug, Clone, PartialEq)]
pub struct RpcError {
    pub message: String,
    pub code: Option<i64>,
}

pub struct SpawnOpts {
    pub command: String,
    pub args: Vec<String>,
    pub cwd: PathBuf,
    /// 子程序的完整環境（呼叫端已過濾；這裡一律先 env_clear 再套用）
    pub env: Vec<(String, String)>,
    /// 送出的訊息是否帶 "jsonrpc":"2.0"（ACP 帶，Codex app-server 不帶）
    pub jsonrpc: bool,
    pub log: Log,
    /// 伺服器主動送來的通知或請求（有 method 欄位的訊息）
    pub on_incoming: Arc<dyn Fn(Rpc, Value) + Send + Sync>,
    /// 行程自己結束了（被 stop() 停掉的不呼叫）。參數是原因文字
    pub on_exit: Arc<dyn Fn(String) + Send + Sync>,
    /// 有值＝每一行（已解析成 JSON）都直接交給它，不做請求／回應配對（agy 原生 stream-json 用）
    pub on_json_line: Option<Arc<dyn Fn(Value) + Send + Sync>>,
    /// 行程確實結束後一定呼叫（含被 stop 停掉的）：記錄 PID 的帳本在這裡劃掉
    pub on_end: Option<Arc<dyn Fn() + Send + Sync>>,
}

struct Inner {
    tx: Mutex<Option<mpsc::UnboundedSender<String>>>,
    pending: Mutex<HashMap<u64, (String, oneshot::Sender<Result<Value, RpcError>>)>>,
    next: AtomicU64,
    alive: AtomicBool,
    stopped: AtomicBool,
    pid: u32,
    stderr_tail: Mutex<Vec<String>>,
    jsonrpc: bool,
    kill: Notify,
    /// 強制結束時連子孫一起收（停止流程用；絆線要的是「立刻」，不走這條）
    kill_tree: AtomicBool,
}

#[derive(Clone)]
pub struct Rpc(Arc<Inner>);

impl Rpc {
    /// 啟動子程序（要在 tokio 執行環境裡呼叫）
    pub fn spawn(o: SpawnOpts) -> Result<Rpc, String> {
        let mut cmd = tokio::process::Command::new(&o.command);
        cmd.no_window()
            .args(&o.args)
            .current_dir(&o.cwd)
            .env_clear()
            .envs(o.env.iter().map(|(k, v)| (k.as_str(), v.as_str())))
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .kill_on_drop(true);
        let mut child = cmd.spawn().map_err(|e| e.to_string())?;
        let pid = child.id().unwrap_or(0);
        let (tx, mut rx) = mpsc::unbounded_channel::<String>();
        let inner = Arc::new(Inner {
            tx: Mutex::new(Some(tx)),
            pending: Mutex::new(HashMap::new()),
            next: AtomicU64::new(1),
            alive: AtomicBool::new(true),
            stopped: AtomicBool::new(false),
            pid,
            stderr_tail: Mutex::new(vec![]),
            jsonrpc: o.jsonrpc,
            kill: Notify::new(),
            kill_tree: AtomicBool::new(false),
        });
        let rpc = Rpc(inner.clone());
        let mut stdin = child.stdin.take();
        let stdout = child.stdout.take();
        let stderr = child.stderr.take();
        // 寫入：寫不進去（對方已結束）就靜默放棄，結束由 wait 任務處理
        tauri::async_runtime::spawn(async move {
            while let Some(line) = rx.recv().await {
                let Some(s) = stdin.as_mut() else { break };
                if s.write_all(line.as_bytes()).await.is_err() || s.flush().await.is_err() {
                    break;
                }
            }
            drop(stdin); // 通道關了＝乾淨結束：關 stdin 讓對方自己收尾
        });
        if let Some(out) = stdout {
            let (r, inc, raw) = (rpc.clone(), o.on_incoming.clone(), o.on_json_line.clone());
            tauri::async_runtime::spawn(async move {
                let mut lines = BufReader::new(out).lines();
                while let Ok(Some(l)) = lines.next_line().await {
                    let l = l.trim();
                    if l.is_empty() {
                        continue;
                    }
                    match &raw {
                        Some(f) => {
                            if let Ok(v) = serde_json::from_str::<Value>(l) {
                                f(v);
                            }
                        }
                        None => r.on_line(l, &inc),
                    }
                }
            });
        }
        if let Some(err) = stderr {
            let (r, log) = (rpc.clone(), o.log.clone());
            tauri::async_runtime::spawn(async move {
                let mut lines = BufReader::new(err).lines();
                let mut n = 0;
                while let Ok(Some(l)) = lines.next_line().await {
                    let t: String = l.trim().chars().take(300).collect();
                    if t.is_empty() {
                        continue;
                    }
                    {
                        let mut g = r.0.stderr_tail.lock().unwrap();
                        g.push(t.clone());
                        let extra = g.len().saturating_sub(5);
                        g.drain(..extra);
                    }
                    if n < 8 {
                        log(format!("stderr: {t}"));
                    }
                    n += 1;
                }
            });
        }
        let (r, on_exit, on_end) = (rpc.clone(), o.on_exit.clone(), o.on_end.clone());
        tauri::async_runtime::spawn(async move {
            let why = tokio::select! {
                st = child.wait() => match st { Ok(s) => format!("行程結束了（code={}）", s.code().map(|c| c.to_string()).unwrap_or_else(|| "?".into())), Err(e) => format!("行程結束了：{e}") },
                _ = r.0.kill.notified() => {
                    // 停止流程：只結束自己啟動並記下的這個 PID 與它的子孫（Windows 上 codex 是 node 包著原生程式）
                    if r.0.kill_tree.load(Ordering::SeqCst) {
                        let pid = r.0.pid;
                        let _ = tokio::task::spawn_blocking(move || crate::bridge::orphans::kill_tree(pid)).await;
                    }
                    let _ = child.start_kill();
                    let _ = tokio::time::timeout(std::time::Duration::from_secs(5), child.wait()).await;
                    "被停止了".to_string()
                }
            };
            r.0.alive.store(false, Ordering::SeqCst);
            r.0.tx.lock().unwrap().take();
            let stopped = r.0.stopped.load(Ordering::SeqCst);
            r.fail_all(RpcError { message: if stopped { "被停止了".into() } else { why.clone() }, code: None });
            if let Some(f) = on_end {
                f();
            }
            if !stopped {
                on_exit(why);
            }
        });
        Ok(rpc)
    }

    pub fn pid(&self) -> u32 {
        self.0.pid
    }
    pub fn alive(&self) -> bool {
        self.0.alive.load(Ordering::SeqCst)
    }
    /// 最近幾行 stderr（判斷是不是沒登入用）
    pub fn stderr_tail(&self) -> Vec<String> {
        self.0.stderr_tail.lock().unwrap().clone()
    }

    fn fail_all(&self, e: RpcError) {
        let all: Vec<_> = self.0.pending.lock().unwrap().drain().collect();
        for (_, (_, tx)) in all {
            let _ = tx.send(Err(e.clone()));
        }
    }

    fn on_line(&self, line: &str, inc: &Arc<dyn Fn(Rpc, Value) + Send + Sync>) {
        let Ok(m) = serde_json::from_str::<Value>(line) else { return };
        if m.get("method").is_some() {
            inc(self.clone(), m);
            return;
        }
        let Some(id) = m.get("id").and_then(Value::as_u64) else { return };
        let Some((method, tx)) = self.0.pending.lock().unwrap().remove(&id) else { return };
        let r = match m.get("error") {
            Some(e) if !e.is_null() => {
                let msg = e.get("message").and_then(Value::as_str).map(String::from).unwrap_or_else(|| e.to_string());
                Err(RpcError { message: format!("{method}: {msg}"), code: e.get("code").and_then(Value::as_i64) })
            }
            _ => Ok(m.get("result").cloned().unwrap_or(Value::Null)),
        };
        let _ = tx.send(r);
    }

    fn write(&self, mut v: Value) -> Result<(), String> {
        if self.0.jsonrpc {
            v["jsonrpc"] = json!("2.0");
        }
        let g = self.0.tx.lock().unwrap();
        match g.as_ref() {
            Some(tx) => tx.send(v.to_string() + "\n").map_err(|_| "沒有在跑".to_string()),
            None => Err("沒有在跑".into()),
        }
    }

    /// 直接寫一則 JSON（不補 jsonrpc 欄位以外的任何東西）
    pub fn send(&self, v: Value) -> Result<(), String> {
        self.write(v)
    }
    pub fn notify(&self, method: &str, params: Value) {
        let _ = self.write(json!({ "method": method, "params": params }));
    }
    pub fn respond(&self, id: Value, result: Value) {
        let _ = self.write(json!({ "id": id, "result": result }));
    }
    pub fn respond_err(&self, id: Value, code: i64, message: &str) {
        let _ = self.write(json!({ "id": id, "error": { "code": code, "message": message } }));
    }

    pub async fn request(&self, method: &str, params: Value, timeout_ms: u64) -> Result<Value, RpcError> {
        if !self.alive() {
            return Err(RpcError { message: format!("{method}: 沒有在跑"), code: None });
        }
        let id = self.0.next.fetch_add(1, Ordering::SeqCst);
        let (tx, rx) = oneshot::channel();
        self.0.pending.lock().unwrap().insert(id, (method.to_string(), tx));
        let mut msg = json!({ "id": id, "method": method });
        if !params.is_null() {
            msg["params"] = params;
        }
        if let Err(e) = self.write(msg) {
            self.0.pending.lock().unwrap().remove(&id);
            return Err(RpcError { message: format!("{method}: {e}"), code: None });
        }
        match tokio::time::timeout(std::time::Duration::from_millis(timeout_ms), rx).await {
            Ok(Ok(r)) => r,
            Ok(Err(_)) => Err(RpcError { message: format!("{method}: 通道關閉"), code: None }),
            Err(_) => {
                self.0.pending.lock().unwrap().remove(&id);
                Err(RpcError { message: format!("{method}: 逾時"), code: None })
            }
        }
    }

    /// 停止：不再呼叫 on_exit；關 stdin 讓對方收尾，1.5 秒後仍沒結束就強制結束
    pub fn stop(&self) {
        if self.0.stopped.swap(true, Ordering::SeqCst) {
            return;
        }
        self.fail_all(RpcError { message: "被停止了".into(), code: None });
        self.0.tx.lock().unwrap().take();
        let me = self.clone();
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_millis(1500)).await;
            me.0.kill_tree.store(true, Ordering::SeqCst);
            me.0.kill.notify_one();
        });
    }

    /// 立刻強制結束（不等 1.5 秒）
    pub fn kill_now(&self) {
        self.0.stopped.store(true, Ordering::SeqCst);
        self.0.kill.notify_one();
    }
}

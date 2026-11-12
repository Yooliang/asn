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

/// 行程結束之後，等 stdout／stderr 讀完的上限（#752）。行程結束的處理不能比「最後一行輸出」和 stderr 尾巴更早：
/// agy 登入失效時是「先寫 status=ERROR 的結果、再結束」，兩個讀取任務與等行程的任務各自排程，負載高時行程結束先被處理，
/// 結果被忽略、stderr 尾巴也還沒讀進來，登入失效就被判成 crash（不通知本人、不引導登入、不自動重開）。
/// 子程序自己結束了、卻把管線留給還活著的孫行程時，管線不會 EOF：只等到上限，逾時照舊往下走，不卡住
const DRAIN_MAX: std::time::Duration = std::time::Duration::from_millis(1500);

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
        crate::rt::spawn(async move {
            while let Some(line) = rx.recv().await {
                let Some(s) = stdin.as_mut() else { break };
                if s.write_all(line.as_bytes()).await.is_err() || s.flush().await.is_err() {
                    break;
                }
            }
            drop(stdin); // 通道關了＝乾淨結束：關 stdin 讓對方自己收尾
        });
        // 讀取任務讀到檔尾（或讀不下去）就通知一聲，等行程的任務靠它知道「輸出讀完了」（#752）
        let mut drains: Vec<oneshot::Receiver<()>> = Vec::new();
        if let Some(out) = stdout {
            let (r, inc, raw) = (rpc.clone(), o.on_incoming.clone(), o.on_json_line.clone());
            let (done_tx, done_rx) = oneshot::channel::<()>();
            drains.push(done_rx);
            crate::rt::spawn(async move {
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
                let _ = done_tx.send(());
            });
        }
        if let Some(err) = stderr {
            let (r, log) = (rpc.clone(), o.log.clone());
            let (done_tx, done_rx) = oneshot::channel::<()>();
            drains.push(done_rx);
            crate::rt::spawn(async move {
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
                let _ = done_tx.send(());
            });
        }
        let (r, on_exit, on_end) = (rpc.clone(), o.on_exit.clone(), o.on_end.clone());
        crate::rt::spawn(async move {
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
            // 行程已經結束：「還活著嗎」和 PID 帳本都跟輸出無關，馬上處理，不等讀取
            // （別人要判斷「這個驅動還能不能用」、帳本要劃掉，不該因為我們在等輸出而晚知道）
            r.0.alive.store(false, Ordering::SeqCst);
            if let Some(f) = on_end {
                f();
            }
            // 再等 stdout／stderr 讀完（有上限）：最後一行輸出與 stderr 尾巴要在下面的 fail_all／on_exit 之前處理完（#752）
            for d in drains {
                let _ = tokio::time::timeout(DRAIN_MAX, d).await;   // 逾時或對方已丟掉都照舊往下走
            }
            r.0.tx.lock().unwrap().take();
            let stopped = r.0.stopped.load(Ordering::SeqCst);
            r.fail_all(RpcError { message: if stopped { "被停止了".into() } else { why.clone() }, code: None });
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
        crate::rt::spawn(async move {
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicUsize;
    use std::time::{Duration, Instant};

    /// 一支 node 假程式：把 `script` 當成程式跑。測試環境沒有 node 就略過（CI 與開發機都有）。
    /// 只在 PATH 裡找檔案、不開子行程：engines 底下每個子程序都要先 env_clear（守門測試掃字串），測試探測也不為此開例外
    fn node() -> Option<String> {
        let exts: &[&str] = if cfg!(windows) { &["exe", "cmd", "bat"] } else { &[""] };
        let found = std::env::var_os("PATH").is_some_and(|p| {
            std::env::split_paths(&p).any(|d| exts.iter().any(|e| d.join(if e.is_empty() { "node".to_string() } else { format!("node.{e}") }).is_file()))
        });
        found.then(|| "node".to_string())
    }

    fn opts(script: &str, on_json: Arc<dyn Fn(Value) + Send + Sync>, on_exit: Arc<dyn Fn(String) + Send + Sync>) -> SpawnOpts {
        SpawnOpts {
            command: "node".into(),
            args: vec!["-e".into(), script.into()],
            cwd: std::env::temp_dir(),
            env: std::env::vars().collect(),
            jsonrpc: false,
            log: Arc::new(|_| {}),
            on_incoming: Arc::new(|_, _| {}),
            on_exit,
            on_json_line: Some(on_json),
            on_end: None,
        }
    }

    /// #752：行程結束的處理不能比「最後一行輸出」更早。agy 登入失效時是「先寫 status=ERROR 的結果、再結束」，
    /// 任務排程反過來（負載高）就會先判成 crash，登入失效被吞掉。這裡人為讓 stdout 的處理變慢，on_exit 被呼叫時最後一行與 stderr 尾巴都要已經處理完
    #[tokio::test]
    async fn 行程結束時_最後一行輸出與_stderr_尾巴都已處理完_就算讀取很慢() {
        if node().is_none() {
            return;
        }
        let handled = Arc::new(AtomicUsize::new(0));
        let at_exit = Arc::new(Mutex::new(None::<(usize, String)>));
        let (h_line, h_exit, ex2) = (handled.clone(), handled.clone(), at_exit.clone());
        let (done_tx, done_rx) = oneshot::channel::<()>();
        let done_tx = Mutex::new(Some(done_tx));
        let rpc_cell: Arc<Mutex<Option<Rpc>>> = Arc::new(Mutex::new(None));
        let rc = rpc_cell.clone();
        let o = opts(
            // 先往 stderr 寫登入失效的字、再往 stdout 寫結果，馬上結束（結束碼 1）
            "process.stderr.write('authentication required\\n'); console.log(JSON.stringify({event:'result',result:{status:'ERROR'}})); process.exit(1)",
            Arc::new(move |_| {
                // 人為讓 stdout 的處理變慢：行程的結束任務通常會先到
                std::thread::sleep(Duration::from_millis(400));
                h_line.fetch_add(1, Ordering::SeqCst);
            }),
            Arc::new(move |_why| {
                let tail = rc.lock().unwrap().as_ref().map(|r| r.stderr_tail().join(" | ")).unwrap_or_default();
                *ex2.lock().unwrap() = Some((h_exit.load(Ordering::SeqCst), tail));
                if let Some(t) = done_tx.lock().unwrap().take() {
                    let _ = t.send(());
                }
            }),
        );
        let rpc = Rpc::spawn(o).unwrap();
        *rpc_cell.lock().unwrap() = Some(rpc);
        tokio::time::timeout(Duration::from_secs(10), done_rx).await.expect("on_exit 要被呼叫").unwrap();
        let (lines, tail) = at_exit.lock().unwrap().clone().unwrap();
        assert_eq!(lines, 1, "on_exit 之前最後一行輸出要已經處理完（否則結果被忽略、判成 crash）");
        assert!(tail.contains("authentication required"), "on_exit 之前 stderr 尾巴要已經讀進來（分類要靠它）：{tail:?}");
    }

    /// 子行程自己結束了，卻把管線留給一個還活著的孫行程：stdout 不會 EOF。on_exit 不能因此卡住，等了上限就照舊往下走
    #[tokio::test]
    async fn 孫行程佔著管線_管線不會結束_on_exit_仍在上限內被呼叫() {
        if node().is_none() {
            return;
        }
        let (done_tx, done_rx) = oneshot::channel::<()>();
        let done_tx = Mutex::new(Some(done_tx));
        let o = opts(
            // 起一個孫行程（繼承 stdout／stderr）睡 30 秒，自己馬上結束
            "const {spawn}=require('child_process'); const c=spawn(process.execPath,['-e','setTimeout(()=>{},30000)'],{stdio:['ignore','inherit','inherit'],detached:true}); c.unref(); console.log('{\"event\":\"x\"}'); process.exit(0)",
            Arc::new(|_| {}),
            Arc::new(move |_| {
                if let Some(t) = done_tx.lock().unwrap().take() {
                    let _ = t.send(());
                }
            }),
        );
        let started = Instant::now();
        let _rpc = Rpc::spawn(o).unwrap();
        // 上限照「孫行程睡 30 秒」來定，不照機器快慢：CI 忙時光是開 node 和等管線就可能超過 6 秒（#1397 實測 6.3 秒）。
        // 只要明顯早於 30 秒，就證明沒有等到孫行程結束；等待本身改成等 on_exit 被呼叫，上限給足
        tokio::time::timeout(Duration::from_secs(25), done_rx).await.expect("管線被佔住也不能卡死 on_exit").unwrap();
        let took = started.elapsed();
        assert!(took >= Duration::from_millis(500), "要真的有等（等管線讀完的上限）：{took:?}");
        assert!(took < Duration::from_secs(20), "但不能等到孫行程結束（30 秒）：{took:?}");
    }

    /// 等讀取只延後「結案這一輪」（fail_all／on_exit）；行程一結束，「還活著嗎」和 PID 帳本（on_end）要馬上處理，
    /// 不能因為管線被佔住就跟著晚到（驅動能不能再用、帳本有沒有劃掉都靠它，#752 修的過程中曾經因此讓 PID 帳本測試失敗）
    #[tokio::test]
    async fn 管線被佔住時_alive_與_on_end_仍在行程結束時馬上處理() {
        if node().is_none() {
            return;
        }
        let ended_at = Arc::new(Mutex::new(None::<Instant>));
        let exit_at = Arc::new(Mutex::new(None::<Instant>));
        let (e2, x2) = (ended_at.clone(), exit_at.clone());
        let (done_tx, done_rx) = oneshot::channel::<()>();
        let done_tx = Mutex::new(Some(done_tx));
        let mut o = opts(
            "const {spawn}=require('child_process'); const c=spawn(process.execPath,['-e','setTimeout(()=>{},30000)'],{stdio:['ignore','inherit','inherit'],detached:true}); c.unref(); process.exit(0)",
            Arc::new(|_| {}),
            Arc::new(move |_| {
                *x2.lock().unwrap() = Some(Instant::now());
                if let Some(t) = done_tx.lock().unwrap().take() {
                    let _ = t.send(());
                }
            }),
        );
        o.on_end = Some(Arc::new(move || {
            *e2.lock().unwrap() = Some(Instant::now());
        }));
        let rpc = Rpc::spawn(o).unwrap();
        // 等待上限照「孫行程睡 30 秒」來定，不照機器快慢（CI 忙時開 node＋等管線可能超過 8 秒）
        tokio::time::timeout(Duration::from_secs(25), done_rx).await.expect("on_exit 要被呼叫").unwrap();
        assert!(!rpc.alive(), "行程結束了：alive 要是 false");
        let (end, exit) = (ended_at.lock().unwrap().unwrap(), exit_at.lock().unwrap().unwrap());
        assert!(exit.duration_since(end) >= Duration::from_millis(500), "on_exit 要等管線（有上限），on_end 不等：on_end 比 on_exit 早 {:?}", exit.duration_since(end));
    }

    /// 正常結束（沒有被佔住的管線）不多等
    #[tokio::test]
    async fn 正常結束不多等() {
        if node().is_none() {
            return;
        }
        let ended_at = Arc::new(Mutex::new(None::<Instant>));
        let exit_at = Arc::new(Mutex::new(None::<Instant>));
        let (e2, x2) = (ended_at.clone(), exit_at.clone());
        let (done_tx, done_rx) = oneshot::channel::<()>();
        let done_tx = Mutex::new(Some(done_tx));
        let mut o = opts(
            "console.log('{\"event\":\"x\"}'); process.exit(0)",
            Arc::new(|_| {}),
            Arc::new(move |_| {
                *x2.lock().unwrap() = Some(Instant::now());
                if let Some(t) = done_tx.lock().unwrap().take() {
                    let _ = t.send(());
                }
            }),
        );
        // on_end 在行程真正結束時馬上被呼叫：從這裡量到 on_exit，開 node 的時間不算進去，機器忙也不受影響
        o.on_end = Some(Arc::new(move || {
            *e2.lock().unwrap() = Some(Instant::now());
        }));
        let _rpc = Rpc::spawn(o).unwrap();
        tokio::time::timeout(Duration::from_secs(25), done_rx).await.expect("on_exit 要被呼叫").unwrap();
        let (end, exit) = (ended_at.lock().unwrap().expect("on_end 要被呼叫"), exit_at.lock().unwrap().unwrap());
        let gap = exit.saturating_duration_since(end);
        // 正常結束管線很快 EOF：從行程結束到 on_exit 不該等滿任何一個管線的上限（DRAIN_MAX）
        assert!(gap < DRAIN_MAX, "正常結束管線很快 EOF，不該等滿上限：行程結束到 on_exit 花了 {gap:?}");
    }
}

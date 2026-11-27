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
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader}; // stderr 仍用 lines()
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

/// 一行解析不了的輸出：只描述它，不帶內容（可能含檔案內容或路徑）
#[derive(Debug, Clone, PartialEq)]
pub struct UnparsedLine {
    /// 第幾行（從 1 起，含空行）
    pub line_no: usize,
    /// 去掉頭尾空白後的字元數
    pub len: usize,
    /// 錯誤類別（白話）
    pub kind: &'static str,
}

/// serde_json 錯誤的類別（只回固定字串，不帶原文）。巢狀超過 128 層會報 recursion limit
fn parse_error_kind(e: &serde_json::Error) -> &'static str {
    if e.to_string().contains("recursion limit") {
        return "巢狀超過深度上限";
    }
    match e.classify() {
        serde_json::error::Category::Eof => "內容被截斷",
        serde_json::error::Category::Syntax => "語法錯誤",
        serde_json::error::Category::Data => "資料型別不符",
        serde_json::error::Category::Io => "讀取錯誤",
    }
}

fn log_unparsed(log: &Log, u: &UnparsedLine) {
    log(format!("輸出第 {} 行解析不了（長度 {}，{}），已略過", u.line_no, u.len, u.kind));
}

/// 解析不了的一行：一律記 log；`notify`（有 on_json_line）且呼叫端給了 on_unparsed_line 才通知。標準模式不通知，行為不變（只記 log）
fn report_unparsed(log: &Log, bad: &Option<Arc<dyn Fn(UnparsedLine) + Send + Sync>>, notify: bool, u: UnparsedLine) {
    log_unparsed(log, &u);
    if notify {
        if let Some(b) = bad {
            b(u);
        }
    }
}

/// 逐位元組讀行：某一行不是有效的文字編碼時，照樣當成「解析不了的一行」處理並繼續讀後面的行。
/// 讀到檔尾回 None；讀取本身出錯回 Some((出錯的行號, 錯誤))
async fn read_output_lines<R, T, B>(out: R, mut on_text: T, mut on_bad: B) -> Option<(usize, std::io::Error)>
where
    R: tokio::io::AsyncRead + Unpin,
    T: FnMut(usize, &str),
    B: FnMut(UnparsedLine),
{
    let mut reader = BufReader::new(out);
    let mut buf: Vec<u8> = Vec::new();
    let mut line_no = 0usize;
    loop {
        buf.clear();
        match reader.read_until(b'\n', &mut buf).await {
            Ok(0) => return None,
            Ok(_) => {
                line_no += 1;
                match std::str::from_utf8(&buf) {
                    Ok(s) => on_text(line_no, s),
                    // 只看原始位元組是不是合法 UTF-8；合法的（含字面上的替換字元 U+FFFD）照常處理。這一類的長度以位元組計
                    Err(_) => on_bad(UnparsedLine { line_no, len: buf.trim_ascii().len(), kind: "不是有效的文字編碼" }),
                }
            }
            Err(e) => return Some((line_no + 1, e)),
        }
    }
}

/// 處理 stdout：逐行讀、逐行處理；讀取本身出錯就走 `on_read_failed`（記 log、通知、結束行程）
async fn drain_stdout<R: tokio::io::AsyncRead + Unpin>(
    out: R,
    r: Rpc,
    inc: Arc<dyn Fn(Rpc, Value) + Send + Sync>,
    raw: Option<Arc<dyn Fn(Value) + Send + Sync>>,
    bad: Option<Arc<dyn Fn(UnparsedLine) + Send + Sync>>,
    log: Log,
) {
    let failed = read_output_lines(
        out,
        |line_no, l| {
            let l = l.trim();
            if l.is_empty() {
                return;
            }
            match &raw {
                Some(f) => match serde_json::from_str::<Value>(l) {
                    Ok(v) => f(v),
                    Err(e) => report_unparsed(&log, &bad, true, UnparsedLine { line_no, len: l.chars().count(), kind: parse_error_kind(&e) }),
                },
                None => r.on_line(l, &inc, &log, line_no),
            }
        },
        |u| report_unparsed(&log, &bad, raw.is_some(), u),
    )
    .await;
    if let Some((line_no, e)) = failed {
        r.on_read_failed(&log, &bad, line_no, &e);
    }
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
    /// 有 `on_json_line` 時，解析不了的那一行交給它（只有行號、長度、錯誤類別，不含行內容）。
    /// 解析不了的行沒經過任何檢查，呼叫端要自己決定怎麼處理；不給就只記 log
    pub on_unparsed_line: Option<Arc<dyn Fn(UnparsedLine) + Send + Sync>>,
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
            let (bad, log) = (o.on_unparsed_line.clone(), o.log.clone());
            let (done_tx, done_rx) = oneshot::channel::<()>();
            drains.push(done_rx);
            crate::rt::spawn(async move {
                drain_stdout(out, r, inc, raw, bad, log).await;
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

    /// 讀輸出時出了讀取錯誤（不是編碼問題）：後面的輸出再也收不到，沒有檢查就不能讓行程繼續跑。
    /// 記 log、通知呼叫端（類別「讀取失敗」），並結束行程與它的子孫（行程結束後照常走 on_exit）
    fn on_read_failed(&self, log: &Log, bad: &Option<Arc<dyn Fn(UnparsedLine) + Send + Sync>>, line_no: usize, e: &std::io::Error) {
        log(format!("輸出第 {line_no} 行讀取失敗（{e}），結束行程"));
        if let Some(b) = bad {
            b(UnparsedLine { line_no, len: 0, kind: "讀取失敗" });
        }
        self.0.kill_tree.store(true, Ordering::SeqCst);
        self.0.kill.notify_one();
    }

    fn fail_all(&self, e: RpcError) {
        let all: Vec<_> = self.0.pending.lock().unwrap().drain().collect();
        for (_, (_, tx)) in all {
            let _ = tx.send(Err(e.clone()));
        }
    }

    /// 標準 JSON-RPC 模式：解析不了的行只記 log、照舊略過（權限請求要回覆才會執行，沒解析到＝沒回覆＝不會執行，不放行任何動作）
    fn on_line(&self, line: &str, inc: &Arc<dyn Fn(Rpc, Value) + Send + Sync>, log: &Log, line_no: usize) {
        let m = match serde_json::from_str::<Value>(line) {
            Ok(m) => m,
            Err(e) => {
                log_unparsed(log, &UnparsedLine { line_no, len: line.chars().count(), kind: parse_error_kind(&e) });
                return;
            }
        };
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

    /// 立刻強制結束（不等 1.5 秒），連子孫一起收（#2350）。
    /// 順序由等行程的任務保證：先列出並結束子孫（`orphans::kill_tree`）、再結束根；先殺根的話子孫會被改掛，之後就找不到了
    pub fn kill_now(&self) {
        self.0.stopped.store(true, Ordering::SeqCst);
        self.0.kill_tree.store(true, Ordering::SeqCst);
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
            on_unparsed_line: None,
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

    /// 解析不了的行：回呼被呼叫（行號、長度、類別）、log 有記且不含行內容；能解析的行照常交給 on_json_line
    #[tokio::test]
    async fn 解析不了的行_通知呼叫端並記_log_不含內容() {
        if node().is_none() {
            return;
        }
        let got = Arc::new(Mutex::new(Vec::<UnparsedLine>::new()));
        let good = Arc::new(AtomicUsize::new(0));
        let logs = Arc::new(Mutex::new(Vec::<String>::new()));
        let (g2, ok2, l2) = (got.clone(), good.clone(), logs.clone());
        let (done_tx, done_rx) = oneshot::channel::<()>();
        let done_tx = Mutex::new(Some(done_tx));
        let mut o = opts(
            // 第 1 行正常、第 2 行截斷、第 3 行巢狀 300 層（超過上限）
            "console.log('{\"event\":\"x\"}'); console.log('{\"secret\":\"SECRETVALUE'); console.log('['.repeat(300)+']'.repeat(300)); process.exit(0)",
            Arc::new(move |_| {
                ok2.fetch_add(1, Ordering::SeqCst);
            }),
            Arc::new(move |_| {
                if let Some(t) = done_tx.lock().unwrap().take() {
                    let _ = t.send(());
                }
            }),
        );
        o.log = Arc::new(move |m| l2.lock().unwrap().push(m));
        o.on_unparsed_line = Some(Arc::new(move |u| g2.lock().unwrap().push(u)));
        let _rpc = Rpc::spawn(o).unwrap();
        tokio::time::timeout(Duration::from_secs(25), done_rx).await.expect("on_exit 要被呼叫").unwrap();
        assert_eq!(good.load(Ordering::SeqCst), 1);
        let got = got.lock().unwrap().clone();
        assert_eq!(got.len(), 2, "{got:?}");
        assert_eq!((got[0].line_no, got[0].kind), (2, "內容被截斷"));
        assert_eq!((got[1].line_no, got[1].len, got[1].kind), (3, 600, "巢狀超過深度上限"));
        let l = logs.lock().unwrap().join("\n");
        assert!(l.contains("第 2 行解析不了") && l.contains("第 3 行解析不了"), "{l}");
        assert!(!l.contains("SECRETVALUE") && !l.contains("[[["), "log 不記行內容：{l}");
    }

    /// 輸出含無效文字編碼的行時照樣檢查後面的行：壞行有回呼與 log（不含內容），後面的正常行照常收到
    #[tokio::test]
    async fn 輸出含無效編碼的行時_照樣處理並繼續讀後面的行() {
        if node().is_none() {
            return;
        }
        let got = Arc::new(Mutex::new(Vec::<UnparsedLine>::new()));
        let good = Arc::new(AtomicUsize::new(0));
        let logs = Arc::new(Mutex::new(Vec::<String>::new()));
        let (g2, ok2, l2) = (got.clone(), good.clone(), logs.clone());
        let (done_tx, done_rx) = oneshot::channel::<()>();
        let done_tx = Mutex::new(Some(done_tx));
        let mut o = opts(
            // 第 1 行正常、第 2 行夾著不是文字編碼的位元組、第 3 行正常
            "const w=process.stdout; w.write('{\"event\":\"x\"}\\n'); w.write(Buffer.from([0x7b,0x22,0x61,0x22,0x3a,0x22,0xff,0xfe,0x22,0x7d,0x0a])); w.write('{\"event\":\"y\"}\\n', ()=>process.exit(0))",
            Arc::new(move |_| {
                ok2.fetch_add(1, Ordering::SeqCst);
            }),
            Arc::new(move |_| {
                if let Some(t) = done_tx.lock().unwrap().take() {
                    let _ = t.send(());
                }
            }),
        );
        o.log = Arc::new(move |m| l2.lock().unwrap().push(m));
        o.on_unparsed_line = Some(Arc::new(move |u| g2.lock().unwrap().push(u)));
        let _rpc = Rpc::spawn(o).unwrap();
        tokio::time::timeout(Duration::from_secs(25), done_rx).await.expect("on_exit 要被呼叫").unwrap();
        assert_eq!(good.load(Ordering::SeqCst), 2, "壞行前後的正常行都要收到");
        let got = got.lock().unwrap().clone();
        assert_eq!(got.len(), 1, "{got:?}");
        assert_eq!((got[0].line_no, got[0].kind), (2, "不是有效的文字編碼"));
        let l = logs.lock().unwrap().join("\n");
        assert!(l.contains("第 2 行解析不了") && l.contains("不是有效的文字編碼"), "{l}");
    }

    /// 合法的 UTF-8（內容剛好是替換字元 U+FFFD，位元組 EF BF BD）不算無效編碼：照常交給 on_json_line、不通知、不記解析不了
    #[tokio::test]
    async fn 合法的替換字元_照常處理_不算無效編碼() {
        if node().is_none() {
            return;
        }
        let got = Arc::new(AtomicUsize::new(0));
        let good = Arc::new(Mutex::new(Vec::<Value>::new()));
        let logs = Arc::new(Mutex::new(Vec::<String>::new()));
        let (g2, ok2, l2) = (got.clone(), good.clone(), logs.clone());
        let (done_tx, done_rx) = oneshot::channel::<()>();
        let done_tx = Mutex::new(Some(done_tx));
        let mut o = opts(
            "const w=process.stdout; w.write(Buffer.from([0x7b,0x22,0x61,0x22,0x3a,0x22,0xef,0xbf,0xbd,0x22,0x7d,0x0a]), ()=>process.exit(0))",
            Arc::new(move |v| ok2.lock().unwrap().push(v)),
            Arc::new(move |_| {
                if let Some(t) = done_tx.lock().unwrap().take() {
                    let _ = t.send(());
                }
            }),
        );
        o.log = Arc::new(move |m| l2.lock().unwrap().push(m));
        o.on_unparsed_line = Some(Arc::new(move |_| {
            g2.fetch_add(1, Ordering::SeqCst);
        }));
        let _rpc = Rpc::spawn(o).unwrap();
        tokio::time::timeout(Duration::from_secs(25), done_rx).await.expect("on_exit 要被呼叫").unwrap();
        assert_eq!(got.load(Ordering::SeqCst), 0, "合法 UTF-8 不通知");
        let good = good.lock().unwrap().clone();
        assert_eq!(good.len(), 1, "{good:?}");
        assert_eq!(good[0]["a"].as_str(), Some("\u{FFFD}"));
        assert!(!logs.lock().unwrap().join("\n").contains("解析不了"));
    }

    /// 標準模式：解析不了的行（含無效編碼的行）只記 log、不呼叫 on_unparsed_line，後面的行照常處理
    #[tokio::test]
    async fn 標準模式解析不了的行只記_log_不呼叫通知_後面的行照常() {
        if node().is_none() {
            return;
        }
        let bad_calls = Arc::new(AtomicUsize::new(0));
        let incoming = Arc::new(AtomicUsize::new(0));
        let logs = Arc::new(Mutex::new(Vec::<String>::new()));
        let (b2, i2, l2) = (bad_calls.clone(), incoming.clone(), logs.clone());
        let (done_tx, done_rx) = oneshot::channel::<()>();
        let done_tx = Mutex::new(Some(done_tx));
        let mut o = opts(
            "const w=process.stdout; w.write('{\"secret\":\"SECRETVALUE\\n'); w.write(Buffer.from([0x7b,0xff,0x7d,0x0a])); w.write('{\"method\":\"m\"}\\n', ()=>process.exit(0))",
            Arc::new(|_| {}),
            Arc::new(move |_| {
                if let Some(t) = done_tx.lock().unwrap().take() {
                    let _ = t.send(());
                }
            }),
        );
        o.on_json_line = None;
        o.log = Arc::new(move |m| l2.lock().unwrap().push(m));
        o.on_unparsed_line = Some(Arc::new(move |_| {
            b2.fetch_add(1, Ordering::SeqCst);
        }));
        o.on_incoming = Arc::new(move |_, _| {
            i2.fetch_add(1, Ordering::SeqCst);
        });
        let _rpc = Rpc::spawn(o).unwrap();
        tokio::time::timeout(Duration::from_secs(25), done_rx).await.expect("on_exit 要被呼叫").unwrap();
        assert_eq!(bad_calls.load(Ordering::SeqCst), 0, "標準模式不通知呼叫端");
        assert_eq!(incoming.load(Ordering::SeqCst), 1, "後面的正常行照常處理");
        let l = logs.lock().unwrap().join("\n");
        assert!(l.contains("第 1 行解析不了") && l.contains("第 2 行解析不了"), "標準模式解析不了的行要記 log：{l}");
        assert!(!l.contains("SECRETVALUE"), "log 不記行內容：{l}");
    }

    /// 一個先給一行、再讀取失敗的來源
    struct FailAfterOneLine(bool);
    impl tokio::io::AsyncRead for FailAfterOneLine {
        fn poll_read(mut self: std::pin::Pin<&mut Self>, _: &mut std::task::Context<'_>, buf: &mut tokio::io::ReadBuf<'_>) -> std::task::Poll<std::io::Result<()>> {
            if self.0 {
                return std::task::Poll::Ready(Err(std::io::Error::other("模擬讀取失敗")));
            }
            self.0 = true;
            buf.put_slice(b"ok\n");
            std::task::Poll::Ready(Ok(()))
        }
    }

    /// 讀取本身出錯（不是編碼問題）：回報出錯的行號，之前的行照常處理
    #[tokio::test]
    async fn 讀取出錯時回報行號_之前的行照常處理() {
        let mut seen: Vec<String> = vec![];
        let r = read_output_lines(FailAfterOneLine(false), |_, l| seen.push(l.trim().to_string()), |_| {}).await;
        assert_eq!(seen, vec!["ok".to_string()]);
        let (line_no, e) = r.expect("讀取出錯要回報，不能當成檔尾");
        assert_eq!(line_no, 2);
        assert!(e.to_string().contains("模擬讀取失敗"));
    }

    /// 讀取出錯後：呼叫端收到「讀取失敗」通知、log 有記、行程被結束（on_exit 被呼叫），不會默默繼續活著
    #[tokio::test]
    async fn 讀取出錯後通知呼叫端並結束行程() {
        if node().is_none() {
            return;
        }
        let got = Arc::new(Mutex::new(Vec::<UnparsedLine>::new()));
        let logs = Arc::new(Mutex::new(Vec::<String>::new()));
        let (g2, l2) = (got.clone(), logs.clone());
        let (done_tx, done_rx) = oneshot::channel::<()>();
        let done_tx = Mutex::new(Some(done_tx));
        let mut o = opts(
            "setInterval(()=>{},1000)",
            Arc::new(|_| {}),
            Arc::new(move |_| {
                if let Some(t) = done_tx.lock().unwrap().take() {
                    let _ = t.send(());
                }
            }),
        );
        o.log = Arc::new(move |m| l2.lock().unwrap().push(m));
        o.on_unparsed_line = Some(Arc::new(move |u| g2.lock().unwrap().push(u)));
        let bad = o.on_unparsed_line.clone();
        let log = o.log.clone();
        let rpc = Rpc::spawn(o).unwrap();
        assert!(rpc.alive());
        rpc.on_read_failed(&log, &bad, 7, &std::io::Error::other("模擬讀取失敗"));
        let mut done_rx = done_rx;
        let waited = tokio::time::timeout(Duration::from_secs(10), &mut done_rx).await;
        if waited.is_err() {
            // 失敗時也收掉自己起的假程式：強制結束並等到它真的結束再判定
            rpc.kill_now();
            let t = Instant::now();
            while rpc.alive() && t.elapsed() < Duration::from_secs(10) {
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
        }
        assert!(waited.is_ok(), "行程要被結束（on_exit 被呼叫）");
        assert!(!rpc.alive());
        let got = got.lock().unwrap().clone();
        assert_eq!(got.len(), 1, "{got:?}");
        assert_eq!((got[0].line_no, got[0].kind), (7, "讀取失敗"));
        assert!(logs.lock().unwrap().join("\n").contains("第 7 行讀取失敗"));
    }

    /// stdout 處理的接線：讀到一行後讀取失敗，要走到「通知呼叫端＋結束行程」，之前那一行照常處理
    #[tokio::test]
    async fn stdout_讀取失敗的接線_通知呼叫端並結束行程_之前的行照常處理() {
        if node().is_none() {
            return;
        }
        let got = Arc::new(Mutex::new(Vec::<UnparsedLine>::new()));
        let (g2, g3) = (got.clone(), got.clone());
        let (done_tx, done_rx) = oneshot::channel::<()>();
        let done_tx = Mutex::new(Some(done_tx));
        let mut o = opts(
            "setInterval(()=>{},1000)",
            Arc::new(|_| {}),
            Arc::new(move |_| {
                if let Some(t) = done_tx.lock().unwrap().take() {
                    let _ = t.send(());
                }
            }),
        );
        o.on_unparsed_line = Some(Arc::new(move |u| g2.lock().unwrap().push(u)));
        let bad = o.on_unparsed_line.clone();
        let raw: Option<Arc<dyn Fn(Value) + Send + Sync>> = Some(Arc::new(|_| {}));
        let log = o.log.clone();
        let rpc = Rpc::spawn(o).unwrap();
        assert!(rpc.alive());
        drain_stdout(FailAfterOneLine(false), rpc.clone(), Arc::new(|_, _| {}), raw, bad, log).await;
        let mut done_rx = done_rx;
        let waited = tokio::time::timeout(Duration::from_secs(10), &mut done_rx).await;
        if waited.is_err() {
            // 失敗時也收掉自己起的假程式：強制結束並等到它真的結束再判定
            rpc.kill_now();
            let t = Instant::now();
            while rpc.alive() && t.elapsed() < Duration::from_secs(10) {
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
        }
        assert!(waited.is_ok(), "行程要被結束（on_exit 被呼叫）");
        assert!(!rpc.alive());
        let got = g3.lock().unwrap().clone();
        let got: Vec<(usize, &str)> = got.iter().map(|u| (u.line_no, u.kind)).collect();
        assert_eq!(got.len(), 2, "{got:?}");
        assert_eq!(got[0].0, 1, "之前那一行照常處理（解析不了的行有通知）");
        assert_eq!(got[1], (2, "讀取失敗"));
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

    /// 造一棵三層的假程序樹：假引擎（node）→ 子程序 → 孫程序，三個都睡著不退出。
    /// 子與孫的 pid 各寫進暫存檔，回傳 (rpc, 子 pid, 孫 pid)。測試結束要呼叫 `reap` 收尾（只結束自己開的 pid）
    /// 一定要 detached：node 在 Windows 對非 detached 的子程序會掛 KILL_ON_JOB_CLOSE 的 Job，父死子就跟著死，測不出任何東西
    async fn spawn_tree(dir: &std::path::Path) -> (Rpc, u32, u32) {
        let base = dir.join("tree").to_string_lossy().replace('\\', "/");
        let grand = "setInterval(()=>{},1000)";
        let child = format!(
            "const {{spawn}}=require('child_process'),fs=require('fs');const g=spawn(process.execPath,['-e',{}],{{stdio:'ignore',detached:true}});fs.writeFileSync({},String(g.pid));setInterval(()=>{{}},1000)",
            serde_json::to_string(grand).unwrap(),
            serde_json::to_string(&format!("{base}.g")).unwrap()
        );
        let root = format!(
            "const {{spawn}}=require('child_process'),fs=require('fs');const c=spawn(process.execPath,['-e',{}],{{stdio:'ignore',detached:true}});fs.writeFileSync({},String(c.pid));setInterval(()=>{{}},1000)",
            serde_json::to_string(&child).unwrap(),
            serde_json::to_string(&format!("{base}.c")).unwrap()
        );
        let rpc = Rpc::spawn(opts(&root, Arc::new(|_| {}), Arc::new(|_| {}))).unwrap();
        let read = |ext: &str| std::fs::read_to_string(format!("{base}.{ext}")).ok().and_then(|t| t.trim().parse::<u32>().ok());
        let deadline = Instant::now() + Duration::from_secs(30);
        loop {
            if let (Some(c), Some(g)) = (read("c"), read("g")) {
                return (rpc, c, g);
            }
            assert!(Instant::now() < deadline, "假程序樹沒有在 30 秒內建好");
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    }

    /// 等這些 pid 都不在了（上限給足，不照機器快慢）
    async fn wait_gone(pids: &[u32]) -> bool {
        let deadline = Instant::now() + Duration::from_secs(20);
        while Instant::now() < deadline {
            if pids.iter().all(|p| !crate::heartbeat::pid_alive(*p)) {
                return true;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        false
    }

    /// 收尾：失敗時也不留孤兒（只結束這棵樹自己開的 pid）
    fn reap(pids: &[u32]) {
        for p in pids {
            let _ = crate::bridge::orphans::kill_tree(*p);
        }
    }

    /// 驗三層都結束。Windows 的 `taskkill /T` 收整棵；Linux／macOS 的 `pkill -P` 只收到直接子程序（已知限制，見 orphans.rs），
    /// 所以那裡只斷言根與子，孫只做收尾
    async fn assert_tree_gone(rpc: &Rpc, child: u32, grand: u32) {
        let mut must_die = vec![rpc.pid(), child];
        if cfg!(windows) {
            must_die.push(grand);
        }
        let ok = wait_gone(&must_die).await;
        let alive: Vec<u32> = [rpc.pid(), child, grand].into_iter().filter(|p| crate::heartbeat::pid_alive(*p)).collect();
        reap(&[grand, child]);
        assert!(ok, "整棵程序樹都要結束，還活著的：{alive:?}");
    }

    /// #2350：agy 走的 `kill_now` 也要連子孫一起收（假引擎→子→孫）
    #[tokio::test]
    async fn kill_now_結束整棵程序樹_含孫程序() {
        if node().is_none() {
            return;
        }
        let d = tempfile::tempdir().unwrap();
        let (rpc, child, grand) = spawn_tree(d.path()).await;
        assert!(crate::heartbeat::pid_alive(child) && crate::heartbeat::pid_alive(grand), "樹要先真的活著");
        rpc.kill_now();
        assert_tree_gone(&rpc, child, grand).await;
    }

    /// D-9：Codex、ACP 走的 `stop()`（關 stdin、1.5 秒後收整棵）也要把孫程序收掉，守住不被日後改掉
    #[tokio::test]
    async fn stop_結束整棵程序樹_含孫程序() {
        if node().is_none() {
            return;
        }
        let d = tempfile::tempdir().unwrap();
        let (rpc, child, grand) = spawn_tree(d.path()).await;
        assert!(crate::heartbeat::pid_alive(child) && crate::heartbeat::pid_alive(grand), "樹要先真的活著");
        rpc.stop();
        assert_tree_gone(&rpc, child, grand).await;
    }
}

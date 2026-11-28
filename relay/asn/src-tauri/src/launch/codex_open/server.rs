//! 開 Codex 夥伴前要用的 app-server：自己開、自己關（#2485）。
//! 只做四件事：看某段對話在不在、有沒有內容、建新對話、取名並放種子訊息。注入種子不會讓模型回話，也不用額度。
//! 關閉＝關掉輸入讓它自己結束（結束後 Codex 才會放掉對話的寫入鎖，之後 `codex resume <代號>` 才接得上）；
//! 逾時才強制結束，而且只結束自己開的這一個（用持有的子程序把手，不靠名稱）。
use crate::bridge::engines::rpc::{Log, Rpc, RpcError, SpawnOpts};
use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

/// 每一個請求最久等多久
const REQUEST_MS: u64 = 15_000;
/// 關輸入之後等它自己結束多久；逾時才強制結束
const EXIT_WAIT: Duration = Duration::from_secs(4);
/// 該段對話不存在時 app-server 回的錯誤碼與字句（0.153.4 實機）。字句不一樣的同碼錯誤（例如 invalid thread id）是真錯誤
const NOT_FOUND_CODE: i64 = -32600;
const NOT_FOUND_TEXT: &str = "thread not loaded";

/// 開窗前對 Codex 對話做的事。真的實作是 [`AppServer`]；測試換成假的
pub(super) trait Server {
    /// 這段對話存在嗎（不存在是 Ok(false)；其他錯誤＝沒辦法確定，回 Err）
    fn thread_exists(&mut self, id: &str) -> Result<bool, String>;
    /// 這段對話有沒有任何一輪內容
    fn has_turns(&mut self, id: &str) -> Result<bool, String>;
    /// 建一段新對話，回代號。model 空＝用預設
    fn start_thread(&mut self, cwd: &str, model: Option<&str>) -> Result<String, String>;
    fn set_name(&mut self, id: &str, name: &str) -> Result<(), String>;
    /// 放一則使用者訊息進對話（不觸發回覆）
    fn inject_seed(&mut self, id: &str, text: &str) -> Result<(), String>;
    /// 關掉（可重複呼叫）
    fn close(&mut self);
}

/// 該段對話不存在（而不是別的錯誤）
pub(super) fn is_not_found(e: &RpcError) -> bool {
    e.code == Some(NOT_FOUND_CODE) && e.message.contains(NOT_FOUND_TEXT)
}

pub(super) struct Launch {
    pub command: String,
    pub args: Vec<String>,
    pub cwd: PathBuf,
    pub env: Vec<(String, String)>,
    pub log: Log,
}

pub(super) struct AppServer {
    rpc: Rpc,
    log: Log,
    closed: bool,
}

fn call(rpc: &Rpc, method: &str, params: Value) -> Result<Value, RpcError> {
    crate::rt::block_on(rpc.request(method, params, REQUEST_MS))
}

impl AppServer {
    /// 啟動並完成 initialize。失敗時已經把自己開的程序關掉
    pub(super) fn open(l: Launch) -> Result<AppServer, String> {
        let log = l.log.clone();
        let rpc = crate::rt::block_on(async move {
            Rpc::spawn(SpawnOpts {
                command: l.command,
                args: l.args,
                cwd: l.cwd,
                env: l.env,
                jsonrpc: false,
                log: l.log,
                on_incoming: Arc::new(|_, _| {}), // 這裡只問答，伺服器主動送來的通知與請求一律不理
                on_exit: Arc::new(|_| {}),
                on_json_line: None,
                on_unparsed_line: None,
                on_end: None,
            })
        })?;
        log(format!("[Codex 開窗] app-server 已啟動（PID {}）", rpc.pid()));
        let mut me = AppServer { rpc, log, closed: false };
        let init = call(&me.rpc, "initialize", json!({ "clientInfo": { "name": "asn", "title": "asn", "version": "0.1.0" } }));
        if let Err(e) = init {
            me.close();
            return Err(e.message);
        }
        me.rpc.notify("initialized", Value::Null);
        Ok(me)
    }

    #[cfg(test)]
    pub(super) fn is_alive(&self) -> bool {
        self.rpc.alive()
    }

    fn req(&self, method: &str, params: Value) -> Result<Value, RpcError> {
        call(&self.rpc, method, params)
    }
}

impl Server for AppServer {
    fn thread_exists(&mut self, id: &str) -> Result<bool, String> {
        match self.req("thread/read", json!({ "threadId": id, "includeTurns": false })) {
            Ok(_) => Ok(true),
            Err(e) if is_not_found(&e) => Ok(false),
            Err(e) => Err(e.message),
        }
    }

    fn has_turns(&mut self, id: &str) -> Result<bool, String> {
        let r = self.req("thread/turns/list", json!({ "threadId": id, "limit": 1, "sortDirection": "desc" })).map_err(|e| e.message)?;
        Ok(r.get("data").and_then(Value::as_array).is_some_and(|a| !a.is_empty()))
    }

    fn start_thread(&mut self, cwd: &str, model: Option<&str>) -> Result<String, String> {
        let mut p = json!({ "cwd": cwd, "sandbox": "workspace-write", "approvalPolicy": "on-request", "serviceName": "asn" });
        if let Some(m) = model {
            p["model"] = json!(m);
        }
        let r = self.req("thread/start", p).map_err(|e| e.message)?;
        r.pointer("/thread/id").and_then(Value::as_str).map(str::to_string).ok_or_else(|| "thread/start 沒有回對話代號".to_string())
    }

    fn set_name(&mut self, id: &str, name: &str) -> Result<(), String> {
        self.req("thread/name/set", json!({ "threadId": id, "name": name })).map(|_| ()).map_err(|e| e.message)
    }

    fn inject_seed(&mut self, id: &str, text: &str) -> Result<(), String> {
        let items = json!([{ "type": "message", "role": "user", "content": [{ "type": "input_text", "text": text }] }]);
        self.req("thread/inject_items", json!({ "threadId": id, "items": items })).map(|_| ()).map_err(|e| e.message)
    }

    fn close(&mut self) {
        if self.closed {
            return;
        }
        self.closed = true;
        let pid = self.rpc.pid();
        self.rpc.stop(); // 關輸入：app-server 自己結束（結束碼 0），寫入鎖才會放掉
        if wait_gone(&self.rpc, EXIT_WAIT) {
            (self.log)(format!("[Codex 開窗] app-server 已結束（PID {pid}）"));
            return;
        }
        (self.log)(format!("[Codex 開窗] app-server（PID {pid}）{}秒內沒有自己結束，強制結束", EXIT_WAIT.as_secs()));
        self.rpc.kill_now();
        let gone = wait_gone(&self.rpc, EXIT_WAIT);
        (self.log)(format!("[Codex 開窗] app-server（PID {pid}）強制結束{}", if gone { "完成" } else { "後仍沒有結束，請到工作管理員確認" }));
    }
}

/// 失敗、提早離開、發生 panic 時也關掉自己開的 app-server
impl Drop for AppServer {
    fn drop(&mut self) {
        self.close();
    }
}

fn wait_gone(rpc: &Rpc, max: Duration) -> bool {
    let t = Instant::now();
    while rpc.alive() {
        if t.elapsed() >= max {
            return false;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    true
}

//! 最小 ACP（Agent Client Protocol）用戶端：spawn 一個 ACP agent 子行程，stdio 一行一則 JSON-RPC 2.0。
//! 對應 engines/acp-client.mjs。只實作「送一句、拿回覆」需要的：initialize → session/new（或 session/load）→ session/prompt，
//! 並收集 session/update 通知裡的 agent_message_chunk 文字；agent 要求權限（session/request_permission）交給呼叫端的政策判斷。
//! 沒宣告的用戶端能力（fs/*、terminal/*）一律回 method not found，所以 agent 只能用自己的工具。
use super::rpc::{Log, Rpc, RpcError, SpawnOpts};
use super::BoxFut;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

pub struct AcpOpts {
    pub command: String,
    pub args: Vec<String>,
    pub cwd: PathBuf,
    pub env: Vec<(String, String)>,
    pub log: Log,
    /// agent 送來權限請求時問它：true＝放行（選 allow_once），false＝拒絕（選 reject_once）
    pub on_permission: Arc<dyn Fn(Value) -> BoxFut<'static, bool> + Send + Sync>,
    /// 收到 agent 的任何通知／請求時呼叫（看門狗用）
    pub on_activity: Arc<dyn Fn() + Send + Sync>,
    pub on_exit: Arc<dyn Fn(String) + Send + Sync>,
    pub on_end: Option<Arc<dyn Fn() + Send + Sync>>,
}

pub struct AcpClient {
    rpc: Rpc,
    chunks: Arc<Mutex<HashMap<String, String>>>,
}

const REQUEST_TIMEOUT_MS: u64 = 60_000;

impl AcpClient {
    pub fn spawn(o: AcpOpts) -> Result<AcpClient, String> {
        let chunks: Arc<Mutex<HashMap<String, String>>> = Arc::new(Mutex::new(HashMap::new()));
        let c2 = chunks.clone();
        let (perm, act) = (o.on_permission.clone(), o.on_activity.clone());
        let rpc = Rpc::spawn(SpawnOpts {
            command: o.command,
            args: o.args,
            cwd: o.cwd,
            env: o.env,
            jsonrpc: true,
            log: o.log,
            on_incoming: Arc::new(move |rpc, m| {
                act();
                let method = m.get("method").and_then(Value::as_str).unwrap_or("");
                if method == "session/update" {
                    let u = m.pointer("/params/update").cloned().unwrap_or(Value::Null);
                    if u.get("sessionUpdate").and_then(Value::as_str) == Some("agent_message_chunk") && u.pointer("/content/type").and_then(Value::as_str) == Some("text") {
                        let sid = m.pointer("/params/sessionId").and_then(Value::as_str).unwrap_or("").to_string();
                        let text = u.pointer("/content/text").and_then(Value::as_str).unwrap_or("");
                        c2.lock().unwrap().entry(sid).or_default().push_str(text);
                    }
                    return;
                }
                let Some(id) = m.get("id").cloned().filter(|i| !i.is_null()) else { return }; // 其他通知：忽略
                if method == "session/request_permission" {
                    let params = m.get("params").cloned().unwrap_or(Value::Null);
                    let fut = perm(params.clone());
                    crate::rt::spawn(async move {
                        let allow = fut.await;
                        let opts = params.get("options").and_then(Value::as_array).cloned().unwrap_or_default();
                        let kind = |o: &Value| o.get("kind").and_then(Value::as_str).unwrap_or("").to_string();
                        let pick = if allow {
                            opts.iter().find(|o| kind(o) == "allow_once").or_else(|| opts.iter().find(|o| kind(o).to_lowercase().starts_with("allow")))
                        } else {
                            opts.iter().find(|o| kind(o) == "reject_once").or_else(|| opts.iter().find(|o| kind(o).to_lowercase().contains("reject")))
                        };
                        let outcome = match pick.and_then(|o| o.get("optionId")) {
                            Some(oid) => json!({ "outcome": "selected", "optionId": oid }),
                            None => json!({ "outcome": "cancelled" }),
                        };
                        rpc.respond(id, json!({ "outcome": outcome }));
                    });
                    return;
                }
                rpc.respond_err(id, -32601, &format!("Method not found: {method}"));
            }),
            on_exit: o.on_exit,
            on_json_line: None,
            on_end: o.on_end,
        })?;
        Ok(AcpClient { rpc, chunks })
    }

    pub fn pid(&self) -> u32 {
        self.rpc.pid()
    }
    pub fn alive(&self) -> bool {
        self.rpc.alive()
    }
    pub fn stderr_tail(&self) -> Vec<String> {
        self.rpc.stderr_tail()
    }

    pub async fn initialize(&self) -> Result<Value, RpcError> {
        self.rpc
            .request(
                "initialize",
                json!({
                    "protocolVersion": 1,
                    // 不提供 fs／terminal：agent 只能用自己的工具（且權限由政策決定）
                    "clientCapabilities": {},
                    "clientInfo": { "name": "asn", "title": "ASN", "version": "0.1.0" },
                }),
                REQUEST_TIMEOUT_MS,
            )
            .await
    }
    /// 有些 agent 在 session/new 之前要先 authenticate
    pub async fn authenticate(&self, method_id: &str) -> Result<Value, RpcError> {
        self.rpc.request("authenticate", json!({ "methodId": method_id }), 30_000).await
    }
    pub async fn new_session(&self, cwd: &str) -> Result<String, RpcError> {
        Ok(self.new_session_full(cwd).await?.0)
    }
    /// 開新對話，連同回應一起回（回應裡可能有 models：可選的模型與目前的模型）
    pub async fn new_session_full(&self, cwd: &str) -> Result<(String, Value), RpcError> {
        let r = self.rpc.request("session/new", json!({ "cwd": cwd, "mcpServers": [] }), REQUEST_TIMEOUT_MS).await?;
        let sid = r.get("sessionId").and_then(Value::as_str).map(String::from).ok_or(RpcError { message: "session/new: 沒有回 sessionId".into(), code: None })?;
        Ok((sid, r))
    }
    /// 切換這段對話的模型（ACP 的 session/set_model；對方不支援會回錯誤）
    pub async fn set_model(&self, sid: &str, model_id: &str) -> Result<(), RpcError> {
        self.rpc.request("session/set_model", json!({ "sessionId": sid, "modelId": model_id }), REQUEST_TIMEOUT_MS).await.map(|_| ())
    }
    /// 把先前存的 session 載回來（agent 宣告 loadSession 才能用）；載入時 agent 可能重播歷史，所以載完把累積文字清掉
    pub async fn load_session(&self, sid: &str, cwd: &str) -> Result<Value, RpcError> {
        let r = self.rpc.request("session/load", json!({ "sessionId": sid, "cwd": cwd, "mcpServers": [] }), REQUEST_TIMEOUT_MS).await?;
        self.chunks.lock().unwrap().insert(sid.to_string(), String::new());
        Ok(r)
    }
    pub fn cancel(&self, sid: &str) {
        self.rpc.notify("session/cancel", json!({ "sessionId": sid }));
    }
    /// 送一句，等這一輪結束，回（文字, stopReason）
    pub async fn prompt(&self, sid: &str, text: &str, timeout_ms: u64) -> Result<(String, Option<String>), RpcError> {
        self.chunks.lock().unwrap().insert(sid.to_string(), String::new());
        let r = self.rpc.request("session/prompt", json!({ "sessionId": sid, "prompt": [{ "type": "text", "text": text }] }), timeout_ms).await?;
        let out = self.chunks.lock().unwrap().get(sid).cloned().unwrap_or_default();
        Ok((out, r.get("stopReason").and_then(Value::as_str).map(String::from)))
    }
    pub fn stop(&self) {
        self.rpc.stop();
    }
}

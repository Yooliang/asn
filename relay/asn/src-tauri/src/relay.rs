//! 收發室 HTTP 客戶端。節點金鑰只存在這個結構裡（x-relay-key 標頭），不進 log、不傳前端。
//! 協定照 relay/machine/relay-core.mjs 的 api()，寄信欄位照 send.mjs／irori-relay/index.ts 的 send。
use serde_json::{json, Map, Value};
use std::sync::Mutex;
use std::time::Duration;

pub struct Relay {
    client: reqwest::Client,
    base: String,
    key: String,
    pub node: String,
    pub window: Mutex<String>,
}

/// 與 JS encodeURIComponent 相同：只留 A-Za-z0-9 -_.!~*'()
pub fn encode_component(s: &str) -> String {
    let mut out = String::new();
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&b) {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

pub const MAX_BODY: usize = 20000;

/// 前端交來的寄信內容 → 要送給後端的 body。from_agent 一律換成本程式的視窗名（前端不能自填），
/// 只放行 to_node／to_agent／body／reply_to／from_agent／expects_reply 六個欄位；expects_reply 一定要明說（布林）。
pub fn build_send_body(payload: &Value, window: &str) -> Result<Value, String> {
    let o = payload.as_object().ok_or("寄信內容格式不對")?;
    let to_node = o.get("to_node").and_then(Value::as_str).unwrap_or("");
    if !crate::identity::valid_id(to_node) {
        return Err(format!("收件節點格式不對：{to_node}"));
    }
    let body = o.get("body").and_then(Value::as_str).unwrap_or("").trim_end();
    if body.is_empty() {
        return Err("內文是空的".into());
    }
    if body.chars().count() > MAX_BODY {
        return Err(format!("內文超過 {MAX_BODY} 字"));
    }
    let expects = o.get("expects_reply").and_then(Value::as_bool).ok_or("expects_reply 一定要明說（true 或 false）")?;
    let mut m = Map::new();
    m.insert("to_node".into(), json!(to_node));
    if let Some(a) = o.get("to_agent").and_then(Value::as_str).filter(|s| !s.is_empty()) {
        m.insert("to_agent".into(), json!(a));
    }
    m.insert("body".into(), json!(body));
    if let Some(r) = o.get("reply_to").and_then(Value::as_str).filter(|s| !s.is_empty()) {
        m.insert("reply_to".into(), json!(r));
    }
    m.insert("from_agent".into(), json!(window));
    m.insert("expects_reply".into(), json!(expects));
    Ok(Value::Object(m))
}

pub fn build_ack_body(ids: &[String]) -> Result<Value, String> {
    let uuid = |s: &str| {
        let p: Vec<&str> = s.split('-').collect();
        p.len() == 5 && [8, 4, 4, 4, 12].iter().zip(&p).all(|(n, x)| x.len() == *n && x.chars().all(|c| c.is_ascii_hexdigit()))
    };
    if ids.len() > 100 || !ids.iter().all(|i| uuid(i)) {
        return Err("信件 id 格式不對".into());
    }
    Ok(json!({ "ids": ids }))
}

impl Relay {
    pub fn new(base: String, key: String, node: String, window: String) -> Relay {
        Relay { client: reqwest::Client::new(), base, key, node, window: Mutex::new(window) }
    }
    pub fn window_name(&self) -> String {
        self.window.lock().unwrap().clone()
    }
    pub fn base(&self) -> &str {
        &self.base
    }

    /// `action` 可以帶 `&agent=…`（已編碼）。錯誤訊息只含動作名與 HTTP 狀態，不含金鑰。
    pub async fn api(&self, action: &str, body: Option<Value>) -> Result<Value, String> {
        let url = format!("{}?action={}", self.base, action);
        let name = action.split('&').next().unwrap_or(action);
        let req = if let Some(b) = body { self.client.post(&url).json(&b) } else { self.client.get(&url) };
        let res = req.header("x-relay-key", &self.key).timeout(Duration::from_secs(20)).send().await.map_err(|e| format!("{name} 連線失敗：{}", e.without_url()))?;
        let status = res.status();
        let text = res.text().await.unwrap_or_default();
        let data: Option<Value> = serde_json::from_str(&text).ok();
        if !status.is_success() {
            let err = data.as_ref().and_then(|d| d.get("error")).and_then(Value::as_str).unwrap_or("");
            return Err(format!("{name} HTTP {} {err}", status.as_u16()).trim().to_string());
        }
        Ok(data.unwrap_or(Value::Null))
    }

    pub async fn list(&self) -> Result<Value, String> {
        self.api("list", None).await
    }
    pub async fn inbox(&self) -> Result<Value, String> {
        let w = self.window_name();
        let mut v = self.api(&format!("inbox&agent={}", encode_component(&w)), None).await?;
        // 後端已過濾；這裡再擋一次：不是寄給本視窗的信絕不交給前端、也不會被 ack
        if let Some(arr) = v.get_mut("messages").and_then(Value::as_array_mut) {
            arr.retain(|m| m.get("to_agent").and_then(Value::as_str) == Some(w.as_str()));
        }
        Ok(v)
    }
    pub async fn ack(&self, ids: &[String]) -> Result<Value, String> {
        let b = build_ack_body(ids)?;
        self.api(&format!("ack&agent={}", encode_component(&self.window_name())), Some(b)).await
    }
    pub async fn send(&self, payload: &Value) -> Result<Value, String> {
        let b = build_send_body(payload, &self.window_name())?;
        // 後端不擋同節點寄信；與本機視窗聊天是這個程式的主要用途，所以放行（send.mjs 擋同節點是因為視窗之間有 SendMessage）
        self.api("send", Some(b)).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 編碼和_encodeuricomponent_一致() {
        assert_eq!(encode_component("H-ASN"), "H-ASN");
        assert_eq!(encode_component("家 用/x"), "%E5%AE%B6%20%E7%94%A8%2Fx");
        assert_eq!(encode_component("a(b)*'!~._-"), "a(b)*'!~._-");
    }

    #[test]
    fn 寄信欄位_from_agent_由程式決定_前端不能自填() {
        let p = json!({"to_node":"W","to_agent":"W-政策","body":"  嗨  \n","reply_to":"","from_agent":"偽造","expects_reply":true,"extra":1});
        let b = build_send_body(&p, "H-ASN").unwrap();
        assert_eq!(b, json!({"to_node":"W","to_agent":"W-政策","body":"  嗨","from_agent":"H-ASN","expects_reply":true}));
    }

    #[test]
    fn 寄信_震動與回信() {
        let b = build_send_body(&json!({"to_node":"W","body":"[震動]","expects_reply":false}), "H-ASN").unwrap();
        assert_eq!(b["expects_reply"], false);
        assert!(b.get("to_agent").is_none() && b.get("reply_to").is_none());
        let r = build_send_body(&json!({"to_node":"W","body":"x","expects_reply":true,"reply_to":"00000000-0000-0000-0000-000000000001"}), "H-ASN").unwrap();
        assert_eq!(r["reply_to"], "00000000-0000-0000-0000-000000000001");
    }

    #[test]
    fn 寄信_缺_expects_reply_空內文_超長_壞節點都拒絕() {
        let w = "H-ASN";
        assert!(build_send_body(&json!({"to_node":"W","body":"x"}), w).is_err());
        assert!(build_send_body(&json!({"to_node":"W","body":"  ","expects_reply":true}), w).is_err());
        assert!(build_send_body(&json!({"to_node":"W/../x","body":"x","expects_reply":true}), w).is_err());
        assert!(build_send_body(&json!({"to_node":"W","body":"字".repeat(MAX_BODY + 1),"expects_reply":true}), w).is_err());
        assert!(build_send_body(&json!({"to_node":"W","body":"字".repeat(MAX_BODY),"expects_reply":true}), w).is_ok());
        assert!(build_send_body(&json!("x"), w).is_err());
    }

    #[test]
    fn ack_只收_uuid() {
        let ok = "00000000-0000-0000-0000-000000000001".to_string();
        assert!(build_ack_body(&[ok.clone()]).is_ok());
        assert!(build_ack_body(&["nope".to_string()]).is_err());
        assert!(build_ack_body(&vec![ok; 101]).is_err());
    }
}

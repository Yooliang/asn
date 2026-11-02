//! 與後台往來的格式：請求內容整理（格式擋在送出之前）、回應解析，以及 [`Backend`]——請求端與確認端對後台的四個動作。
//! 正式版是 `Relay`（節點金鑰；確認端另帶本人簽章），測試換成記憶體假後端。
//! 錯誤字串只含動作名、狀態碼與後台的錯誤代碼（見 `Relay::api`），不含任何請求或回應內容。
// 顯示文字清理沿用密碼小幫手的同一份（askpass 是電腦版模組；手機建置用 #[path] 編同一個檔，不另寫一份）
#[cfg(desktop)]
use crate::askpass::proto::clean_display;
#[cfg(not(desktop))]
#[allow(dead_code)]
#[path = "../askpass/proto.rs"]
mod askpass_proto;
#[cfg(not(desktop))]
use askpass_proto::clean_display;
#[cfg(desktop)]
use crate::askpass::server::BoxFut;
#[cfg(not(desktop))]
pub type BoxFut<'a, T> = std::pin::Pin<Box<dyn std::future::Future<Output = T> + Send + 'a>>;
use crate::relay::Relay;
use serde_json::{json, Value};

pub const TTL_MIN: u64 = 30;
pub const TTL_MAX: u64 = 600;
pub const TTL_DEFAULT: u64 = 180;
pub const PROGRAM_MAX: usize = 80;
pub const PURPOSE_MAX: usize = 200;
const NOT_SIGNED: &str = "尚未登入，無法確認密碼請求";

pub trait Backend: Send + Sync {
    /// 請求端：建立請求（節點金鑰）。回 { id, seconds_left }
    fn request(&self, body: Value) -> BoxFut<'_, Result<Value, String>>;
    /// 請求端：建立**帶登入網址**的請求。一定要本人簽章（後台拒絕沒簽章的，AI 拿得到節點金鑰、拿不到登入憑證）。預設不支援
    fn request_signed<'a>(&'a self, _body: Value, _token: &'a str) -> BoxFut<'a, Result<Value, String>> {
        Box::pin(async move { Err("這個後端不支援帶登入網址的請求".to_string()) })
    }
    /// 請求端：取回答（節點金鑰）。回 { status, cipher? }
    fn fetch(&self, body: Value) -> BoxFut<'_, Result<Value, String>>;
    /// 本人設備：待確認的請求（要本人簽章；沒憑證不送）
    fn pending<'a>(&'a self, token: Option<&'a str>) -> BoxFut<'a, Result<Value, String>>;
    /// 本人設備：回覆密文或拒絕（要本人簽章；沒憑證不送）
    fn reply<'a>(&'a self, body: Value, token: Option<&'a str>) -> BoxFut<'a, Result<Value, String>>;
}

impl Backend for Relay {
    fn request(&self, body: Value) -> BoxFut<'_, Result<Value, String>> {
        Box::pin(async move { self.api("secret_request", Some(body)).await })
    }
    fn request_signed<'a>(&'a self, body: Value, token: &'a str) -> BoxFut<'a, Result<Value, String>> {
        Box::pin(async move {
            if token.is_empty() {
                return Err(NOT_SIGNED.to_string());
            }
            self.api_signed("secret_request", Some(body), Some(token)).await
        })
    }
    fn fetch(&self, body: Value) -> BoxFut<'_, Result<Value, String>> {
        Box::pin(async move { self.api("secret_fetch", Some(body)).await })
    }
    fn pending<'a>(&'a self, token: Option<&'a str>) -> BoxFut<'a, Result<Value, String>> {
        Box::pin(async move {
            let t = token.filter(|t| !t.is_empty()).ok_or(NOT_SIGNED)?;
            self.api_signed("secret_pending", Some(json!({})), Some(t)).await
        })
    }
    fn reply<'a>(&'a self, body: Value, token: Option<&'a str>) -> BoxFut<'a, Result<Value, String>> {
        Box::pin(async move {
            let t = token.filter(|t| !t.is_empty()).ok_or(NOT_SIGNED)?;
            self.api_signed("secret_reply", Some(body), Some(t)).await
        })
    }
}

fn has_control(s: &str) -> bool {
    s.chars().any(|c| c.is_control() || matches!(c, '\u{202A}'..='\u{202E}' | '\u{2066}'..='\u{2069}'))
}

fn valid_pub(p: &str) -> bool {
    p.len() == 43 && p.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

/// 建立請求的內容：格式不對就在送出之前回錯。只有這四個欄位，節點由後台依金鑰決定
pub fn build_request_body(pub_b64: &str, program: &str, purpose: &str, ttl: u64) -> Result<Value, String> {
    if !valid_pub(pub_b64) {
        return Err("公鑰格式不對".into());
    }
    let (program, purpose) = (program.trim(), purpose.trim());
    if program.is_empty() || program.chars().count() > PROGRAM_MAX || has_control(program) {
        return Err(format!("程式名稱要 1～{PROGRAM_MAX} 字，不能有控制字元"));
    }
    if purpose.is_empty() || purpose.chars().count() > PURPOSE_MAX || has_control(purpose) {
        return Err(format!("用途說明要 1～{PURPOSE_MAX} 字，不能有控制字元"));
    }
    if !(TTL_MIN..=TTL_MAX).contains(&ttl) {
        return Err(format!("有效期限要在 {TTL_MIN}～{TTL_MAX} 秒之間"));
    }
    Ok(json!({ "pub": pub_b64, "program": program, "purpose": purpose, "ttl": ttl }))
}

/// 帶登入網址的請求內容：網址一定要是官方登入網域的 https（送出前先驗，與後台同一條規則）
pub fn build_request_body_link(pub_b64: &str, program: &str, purpose: &str, ttl: u64, link: &str) -> Result<Value, String> {
    if !super::link::valid_login_link(link) {
        return Err("登入網址不是官方登入網域的 https".into());
    }
    let mut body = build_request_body(pub_b64, program, purpose, ttl)?;
    body["link"] = Value::String(link.to_string());
    Ok(body)
}

pub fn build_fetch_body(id: &str) -> Result<Value, String> {
    if !crate::attach::is_uuid(id) {
        return Err("請求編號格式不對".into());
    }
    Ok(json!({ "id": id }))
}

/// 回覆的內容：`cipher` 為 None＝拒絕。密文格式在送出前先檢查（與後台同一條規則）
pub fn build_reply_body(id: &str, cipher: Option<&str>) -> Result<Value, String> {
    if !crate::attach::is_uuid(id) {
        return Err("請求編號格式不對".into());
    }
    match cipher {
        None => Ok(json!({ "id": id, "deny": true })),
        Some(c) => {
            if c.len() < 100 || c.len() > 2048 || !c.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_') {
                return Err("密文格式不對".into());
            }
            Ok(json!({ "id": id, "cipher": c }))
        }
    }
}

/// 後台回的「請求已建立」
#[derive(Debug, Clone, PartialEq)]
pub struct Started {
    pub id: String,
    pub seconds_left: u64,
}
pub fn parse_started(v: &Value) -> Result<Started, String> {
    let id = v.get("id").and_then(Value::as_str).filter(|i| crate::attach::is_uuid(i)).ok_or("後台回覆的請求編號不對")?;
    let left = v.get("seconds_left").and_then(Value::as_u64).unwrap_or(TTL_DEFAULT).clamp(1, TTL_MAX);
    Ok(Started { id: id.to_ascii_lowercase(), seconds_left: left })
}

/// 取回答的結果
#[derive(Debug, PartialEq)]
pub enum Fetched {
    Pending,
    /// 密文（只會出現這一次）
    Answered(String),
    Denied,
    Expired,
    /// 已經被取走過（重複取）
    Delivered,
}
pub fn parse_fetched(v: &Value) -> Result<Fetched, String> {
    match v.get("status").and_then(Value::as_str) {
        Some("pending") => Ok(Fetched::Pending),
        Some("denied") => Ok(Fetched::Denied),
        Some("expired") => Ok(Fetched::Expired),
        Some("delivered") => Ok(Fetched::Delivered),
        Some("answered") => match v.get("cipher").and_then(Value::as_str) {
            Some(c) => Ok(Fetched::Answered(c.to_string())),
            None => Err("後台說已回覆卻沒有密文".into()),
        },
        _ => Err("後台的回覆無法辨識".into()),
    }
}

/// 本人設備看到的一筆待確認請求（顯示用文字都清理過）
#[derive(Debug, Clone, PartialEq)]
pub struct PendingReq {
    pub id: String,
    pub node: String,
    /// 後台依請求節點查出的設備名稱（不是請求端自報）
    pub node_name: String,
    /// 請求端自報
    pub program: String,
    /// 請求端自報
    pub purpose: String,
    pub pub_b64: String,
    /// 登入網址（請求端附的）。只留通過官方網域檢查的；沒附就是 None
    pub link: Option<String>,
    pub seconds_left: u64,
}

pub fn parse_pending(v: &Value) -> Vec<PendingReq> {
    let Some(list) = v.get("requests").and_then(Value::as_array) else { return vec![] };
    list.iter()
        .filter_map(|r| {
            let s = |k: &str| r.get(k).and_then(Value::as_str);
            let id = s("id").filter(|i| crate::attach::is_uuid(i))?;
            let pub_b64 = s("pub").filter(|p| valid_pub(p))?;
            let node = s("node").filter(|n| crate::identity::valid_id(n))?;
            let left = r.get("seconds_left").and_then(Value::as_u64)?;
            if left == 0 {
                return None;
            }
            // 有附網址但不是官方登入網域：整筆請求不顯示（不信後台或請求端回來的內容，寧可不顯示也不讓本人點到不明網址）
            let link = match r.get("link") {
                None | Some(Value::Null) => None,
                Some(Value::String(u)) if super::link::valid_login_link(u) => Some(u.clone()),
                Some(_) => return None,
            };
            Some(PendingReq {
                id: id.to_ascii_lowercase(),
                node: node.to_string(),
                node_name: clean_display(s("node_name").filter(|n| !n.is_empty()).unwrap_or(node), 60),
                program: clean_display(s("program")?, PROGRAM_MAX),
                purpose: clean_display(s("purpose")?, PURPOSE_MAX),
                pub_b64: pub_b64.to_string(),
                link,
                seconds_left: left.min(TTL_MAX),
            })
        })
        .collect()
}

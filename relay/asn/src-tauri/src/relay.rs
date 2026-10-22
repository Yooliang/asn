//! 收發室 HTTP 客戶端。節點金鑰只存在這個結構裡（x-relay-key 標頭），不進 log、不傳前端。
//! 協定照 relay/machine/relay-core.mjs 的 api()，寄信欄位照 send.mjs／irori-relay/index.ts 的 send。
use serde_json::{json, Map, Value};
use crate::names::{prune, OldName};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;

pub struct Relay {
    client: reqwest::Client,
    base: String,
    key: String,
    pub node: String,
    pub window: Mutex<String>,
    old: Mutex<Vec<OldName>>,
    /// 最近一次收信時「信件 id → 是從哪個名字的信箱拿到的」，ack 要對同一個名字送
    ack_agent: Mutex<HashMap<String, String>>,
    /// 在線狀態回報：目前的狀態與個人訊息（前端改了就更新並叫醒回報迴圈）
    presence: Mutex<(String, String)>,
    /// 後台還沒部署 asn_presence（404／400）：靜默停止回報，直到下次啟動
    presence_off: AtomicBool,
    /// 已經送過離線回報（關閉流程可能走兩次，只送一次，之後迴圈也不再回報）
    presence_closed: AtomicBool,
    /// 後台在回報回應裡說「本人要這台更新」：記下來等迴圈取走（只取一次，後台也只回一次）
    update_requested: AtomicBool,
    pub presence_wake: tokio::sync::Notify,
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

/// 本人簽章標頭（與 supabase/functions/_shared/owner_sign.ts 的 SIGN_HEADER 同一個）
pub const SIGN_HEADER: &str = "x-asn-user";
pub const MAX_BODY: usize = 20000;
/// 震動信第二行：請收到的 AI 回一個震動（與 ui/lib/text.mjs 的 NUDGE_HINT 同一句，test/logic.test.mjs 會比對）
pub const NUDGE_HINT: &str = "想回應的話，就回一個震動：寄一封內文只有「（你的名字 傳送了一個震動）」的信，不用另外回信。";

/// 前端交來的寄信內容 → 要送給後端的 body。from_agent 一律換成本程式的視窗名（前端不能自填），
/// 只放行 to_node／to_agent／body／reply_to／from_agent／expects_reply 六個欄位；expects_reply 一定要明說（布林）。
pub fn build_send_body(payload: &Value, window: &str) -> Result<Value, String> {
    let o = payload.as_object().ok_or("寄信內容格式不對")?;
    let to_node = o.get("to_node").and_then(Value::as_str).unwrap_or("");
    if !crate::identity::valid_id(to_node) {
        return Err(format!("收件節點格式不對：{to_node}"));
    }
    // 震動：前端只說 nudge:true，內文由這裡用視窗名組成「（某某 傳送了一個震動）」（視窗名以本程式為準，前端不能自填）
    let nudge = o.get("nudge").and_then(Value::as_bool).unwrap_or(false);
    // 第二行請收到的 AI 回一個震動（與 ui/lib/text.mjs 的 NUDGE_HINT 同一句）
    let nudge_body = format!("（{window} 傳送了一個震動）\n{NUDGE_HINT}");
    let body = if nudge { nudge_body.as_str() } else { o.get("body").and_then(Value::as_str).unwrap_or("").trim_end() };
    if body.is_empty() {
        return Err("內文是空的".into());
    }
    if body.chars().count() > MAX_BODY {
        return Err(format!("內文超過 {MAX_BODY} 字"));
    }
    let expects = o.get("expects_reply").and_then(Value::as_bool).ok_or("expects_reply 一定要明說（true 或 false）")?;
    let mut m = Map::new();
    if nudge && expects {
        return Err("震動不等回信（expects_reply 要是 false）".into());
    }
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
    // 以「人」寄出（#108）：前端說 person:true 才送 as_person。真正生效要有登入憑證（見 without_person）
    if o.get("person").and_then(Value::as_bool) == Some(true) {
        m.insert("as_person".into(), json!(true));
    }
    Ok(Value::Object(m))
}

/// 沒有登入憑證就不送 as_person（後台沒有簽章本來就不認，這裡先拿掉，AI 用的寄信路徑一個字都不會帶）
pub fn without_person(mut body: Value) -> Value {
    if let Some(o) = body.as_object_mut() {
        o.remove("as_person");
    }
    body
}

/// 取「我和某夥伴」往來記錄的請求內容：夥伴節點必須合格，視窗名可空（找總機），不送使用者或帳號（後台由簽章決定）
pub fn build_history_body(node: &str, agent: &str, limit: Option<u64>) -> Result<Value, String> {
    if !crate::identity::valid_id(node) {
        return Err(format!("夥伴節點格式不對：{node}"));
    }
    if agent.chars().count() > 100 || agent.chars().any(|c| c.is_control()) {
        return Err("夥伴視窗名格式不對".into());
    }
    let mut m = Map::new();
    m.insert("node".into(), json!(node));
    if !agent.is_empty() {
        m.insert("agent".into(), json!(agent));
    }
    if let Some(l) = limit {
        m.insert("limit".into(), json!(l.clamp(1, 200)));
    }
    Ok(Value::Object(m))
}

pub fn build_sent_status_body(ids: &[String]) -> Result<Value, String> {
    let uuid = |s: &str| {
        let p: Vec<&str> = s.split('-').collect();
        p.len() == 5 && [8, 4, 4, 4, 12].iter().zip(&p).all(|(n, x)| x.len() == *n && x.chars().all(|c| c.is_ascii_hexdigit()))
    };
    if ids.len() > 50 || !ids.iter().all(|i| uuid(i)) {
        return Err("信件 id 格式不對".into());
    }
    Ok(json!({ "ids": ids }))
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

/// set_name 的請求內容（驗證在後端與 names::validate_name 同規則；這裡只送視窗名）
pub fn build_set_name_body(name: &str) -> Value {
    json!({ "name": name })
}

/// 後台還沒部署 set_name（404）或不認得（400）：靜默略過，不當錯誤
pub fn set_name_unsupported(err: &str) -> bool {
    err.contains("HTTP 404") || err.contains("HTTP 400")
}

pub const PRESENCE_PSM_MAX: usize = 80;
/// 回報的狀態只有這四個（offline＝關閉或使用者選「顯示為離線」，後端刪掉那一列）；不認得的當線上
pub fn normalize_presence_status(s: &str) -> &'static str {
    match s {
        "busy" => "busy",
        "away" => "away",
        "offline" => "offline",
        _ => "online",
    }
}
/// 個人訊息：去控制字元與頭尾空白，最多 80 字（同後端）
pub fn clean_presence_psm(s: &str) -> String {
    s.chars().filter(|c| !c.is_control()).collect::<String>().trim().chars().take(PRESENCE_PSM_MAX).collect()
}
/// asn_presence 的請求內容：視窗名、版本、狀態、個人訊息（沒有就不送）。節點由後端依金鑰決定，這裡不送。
pub fn build_presence_body(window: &str, version: &str, status: &str, psm: &str) -> Value {
    let mut m = Map::new();
    m.insert("window_name".into(), json!(window));
    m.insert("version".into(), json!(version));
    m.insert("status".into(), json!(normalize_presence_status(status)));
    let p = clean_presence_psm(psm);
    if !p.is_empty() {
        m.insert("psm".into(), json!(p));
    }
    Value::Object(m)
}

impl Relay {
    pub fn new(base: String, key: String, node: String, window: String) -> Relay {
        Relay {
            client: reqwest::Client::new(), base, key, node, window: Mutex::new(window), old: Mutex::new(vec![]), ack_agent: Mutex::new(HashMap::new()),
            presence: Mutex::new(("online".into(), String::new())), presence_off: AtomicBool::new(false), presence_closed: AtomicBool::new(false), update_requested: AtomicBool::new(false),
            presence_wake: tokio::sync::Notify::new(),
        }
    }
    /// 前端改了狀態或個人訊息：記下來並叫醒回報迴圈立刻回報
    pub fn set_presence(&self, status: &str, psm: &str) {
        *self.presence.lock().unwrap() = (normalize_presence_status(status).to_string(), clean_presence_psm(psm));
        self.presence_wake.notify_one();
    }
    /// 回報一次在線狀態；回傳 false＝不用再回報了（後台不支援或已送過離線）。其他失敗只記 log，下一輪再試。
    pub async fn report_presence(&self, version: &str, timeout: Duration) -> bool {
        if self.presence_off.load(Ordering::Relaxed) || self.presence_closed.load(Ordering::Relaxed) {
            return false;
        }
        let (status, psm) = self.presence.lock().unwrap().clone();
        let body = build_presence_body(&self.window_name(), version, &status, &psm);
        match self.api_with("asn_presence", Some(body), timeout).await {
            Ok(v) => {
                if v.get("update_requested").and_then(Value::as_bool) == Some(true) {
                    self.update_requested.store(true, Ordering::SeqCst);
                }
                true
            }
            Err(e) if set_name_unsupported(&e) => {
                self.presence_off.store(true, Ordering::Relaxed);
                false
            }
            Err(e) => {
                eprintln!("asn_presence failed: {e}");
                true
            }
        }
    }
    /// 取走「要求更新」的旗標（有就回 true，並清掉，不會重複觸發）
    pub fn take_update_request(&self) -> bool {
        self.update_requested.swap(false, Ordering::SeqCst)
    }
    /// 遠端更新的結果：ok＝不用更新（已是最新版）；失敗帶原因（後台只留前 200 字）。失敗只記 log
    pub async fn report_update_result(&self, ok: bool, detail: &str) {
        let body = json!({ "ok": ok, "detail": detail.chars().filter(|c| !c.is_control()).take(200).collect::<String>() });
        if let Err(e) = self.api_with("asn_update_result", Some(body), Duration::from_secs(10)).await {
            eprintln!("asn_update_result failed: {e}");
        }
    }
    /// 關閉時盡力回報一次離線（失敗、逾時都不擋關閉）；只送一次。在獨立執行緒裡跑，不論從哪個執行緒呼叫都安全。
    pub fn report_offline_blocking(self: &std::sync::Arc<Self>, version: &str) {
        if self.presence_off.load(Ordering::Relaxed) || self.presence_closed.swap(true, Ordering::Relaxed) {
            return;
        }
        let me = self.clone();
        let body = build_presence_body(&self.window_name(), version, "offline", "");
        let h = std::thread::spawn(move || {
            tauri::async_runtime::block_on(async move {
                let _ = me.api_with("asn_presence", Some(body), Duration::from_secs(3)).await;
            });
        });
        let _ = h.join();
    }
    pub fn window_name(&self) -> String {
        self.window.lock().unwrap().clone()
    }
    pub fn old_names(&self) -> Vec<OldName> {
        self.old.lock().unwrap().clone()
    }
    pub fn set_old_names(&self, v: Vec<OldName>) {
        *self.old.lock().unwrap() = v;
    }
    /// 現在要收信（也要寫心跳）的名字：現用名在前，後面是還沒過期的舊名
    pub fn active_names_at(&self, now: u64) -> Vec<String> {
        let cur = self.window_name();
        let mut v = vec![cur.clone()];
        v.extend(prune(&self.old_names(), &cur, now).into_iter().map(|o| o.name));
        v
    }
    pub fn active_names(&self) -> Vec<String> {
        self.active_names_at(crate::heartbeat::now_ms())
    }
    pub fn base(&self) -> &str {
        &self.base
    }

    /// `action` 可以帶 `&agent=…`（已編碼）。錯誤訊息只含動作名與 HTTP 狀態，不含金鑰。
    pub async fn api(&self, action: &str, body: Option<Value>) -> Result<Value, String> {
        self.api_with(action, body, Duration::from_secs(20)).await
    }
    pub async fn api_with(&self, action: &str, body: Option<Value>, timeout: Duration) -> Result<Value, String> {
        self.api_inner(action, body, timeout, None).await
    }
    /// 本人簽章版：另外帶登入憑證（標頭 x-asn-user，值是 Bearer 憑證）。**只有 ASN 視窗的寄信指令會用**；
    /// 橋、asn-cli 一律走 api／api_with（不帶憑證）。憑證不進 log、不進錯誤訊息。
    pub async fn api_signed(&self, action: &str, body: Option<Value>, token: Option<&str>) -> Result<Value, String> {
        self.api_inner(action, body, Duration::from_secs(20), token).await
    }
    async fn api_inner(&self, action: &str, body: Option<Value>, timeout: Duration, user_token: Option<&str>) -> Result<Value, String> {
        let url = format!("{}?action={}", self.base, action);
        let name = action.split('&').next().unwrap_or(action);
        let mut req = if let Some(b) = body { self.client.post(&url).json(&b) } else { self.client.get(&url) };
        if let Some(t) = user_token.filter(|t| !t.is_empty()) {
            req = req.header(SIGN_HEADER, format!("Bearer {t}"));
        }
        let res = req.header("x-relay-key", &self.key).timeout(timeout).send().await.map_err(|e| format!("{name} 連線失敗：{}", e.without_url()))?;
        let status = res.status();
        let text = res.text().await.unwrap_or_default();
        let data: Option<Value> = serde_json::from_str(&text).ok();
        if !status.is_success() {
            let err = data.as_ref().and_then(|d| d.get("error")).and_then(Value::as_str).unwrap_or("");
            return Err(format!("{name} HTTP {} {err}", status.as_u16()).trim().to_string());
        }
        Ok(data.unwrap_or(Value::Null))
    }

    /// 回傳二進位內容的動作（念出訊息的音檔）：成功回（位元組，content-type）。超過 `max` 位元組算失敗。
    /// 錯誤訊息只含動作名、狀態碼與後端的錯誤代碼，不含金鑰與內文。
    pub async fn api_bytes(&self, action: &str, body: Value, max: usize, timeout: Duration) -> Result<(Vec<u8>, String), String> {
        let url = format!("{}?action={}", self.base, action);
        let name = action.split('&').next().unwrap_or(action);
        let res = self.client.post(&url).json(&body).header("x-relay-key", &self.key).timeout(timeout).send().await.map_err(|e| format!("{name} 連線失敗：{}", e.without_url()))?;
        let status = res.status();
        let mime = res.headers().get("content-type").and_then(|v| v.to_str().ok()).unwrap_or("").to_string();
        let bytes = res.bytes().await.map_err(|e| format!("{name} 讀取失敗：{}", e.without_url()))?;
        if !status.is_success() {
            let err = serde_json::from_slice::<Value>(&bytes).ok().and_then(|d| d.get("error").and_then(Value::as_str).map(String::from)).unwrap_or_default();
            return Err(format!("{name} HTTP {} {err}", status.as_u16()).trim().to_string());
        }
        if bytes.len() > max {
            return Err(format!("{name} 回應太大"));
        }
        Ok((bytes.to_vec(), mime))
    }

    pub async fn list(&self) -> Result<Value, String> {
        self.api("list", None).await
    }
    pub async fn inbox(&self) -> Result<Value, String> {
        let names = self.active_names();
        let mut all: Vec<Value> = vec![];
        let mut map = HashMap::new();
        for (i, w) in names.iter().enumerate() {
            let mut v = match self.api(&format!("inbox&agent={}", encode_component(w)), None).await {
                Ok(v) => v,
                Err(e) if i == 0 => return Err(e),
                Err(_) => continue,   // 舊名那邊失敗不影響現用名
            };
            // 後端已過濾；這裡再擋一次：不是寄給這個名字的信絕不交給前端、也不會被 ack
            if let Some(arr) = v.get_mut("messages").and_then(Value::as_array_mut) {
                for m in arr.drain(..) {
                    if m.get("to_agent").and_then(Value::as_str) == Some(w.as_str()) {
                        if let Some(id) = m.get("id").and_then(Value::as_str) {
                            map.insert(id.to_string(), w.clone());
                        }
                        all.push(m);
                    }
                }
            }
        }
        *self.ack_agent.lock().unwrap() = map;
        Ok(json!({ "messages": all }))
    }
    pub async fn ack(&self, ids: &[String]) -> Result<Value, String> {
        build_ack_body(ids)?;
        let cur = self.window_name();
        let mut by: Vec<(String, Vec<String>)> = vec![];
        {
            let map = self.ack_agent.lock().unwrap();
            for id in ids {
                let a = map.get(id).cloned().unwrap_or_else(|| cur.clone());
                match by.iter_mut().find(|(n, _)| *n == a) {
                    Some((_, v)) => v.push(id.clone()),
                    None => by.push((a, vec![id.clone()])),
                }
            }
        }
        let mut acked = 0u64;
        for (agent, group) in by {
            let r = self.api(&format!("ack&agent={}", encode_component(&agent)), Some(build_ack_body(&group)?)).await?;
            acked += r.get("acked").and_then(Value::as_u64).unwrap_or(0);
        }
        Ok(json!({ "acked": acked }))
    }
    /// 把這台設備的顯示名（nodes.name）設成目前的視窗名，名單才會讓別台設備的前台顯示這台的 ASN 視窗名。
    /// 只改自己這個節點的 name。後台還沒部署（404／400）當作不支援、靜默略過；其他失敗只記 log 並稍後再試，不打擾使用者。
    pub async fn sync_device_name(&self) {
        for wait in [0u64, 30, 120] {
            if wait > 0 {
                tokio::time::sleep(Duration::from_secs(wait)).await;
            }
            match self.api("set_name", Some(build_set_name_body(&self.window_name()))).await {
                Ok(_) => return,
                Err(e) if set_name_unsupported(&e) => return,
                Err(e) => eprintln!("set_name failed: {e}"),
            }
        }
    }

    pub async fn send(&self, payload: &Value) -> Result<Value, String> {
        let b = build_send_body(payload, &self.window_name())?;
        // 後端不擋同節點寄信；與本機視窗聊天是這個程式的主要用途，所以放行（send.mjs 也放行同節點，只擋寄給自己這個視窗）
        self.api("send", Some(without_person(b))).await
    }
    /// ASN 視窗裡人打的字：帶登入憑證（有的話）讓後台標成本人（trust=owner）。沒有憑證＝和 send 完全一樣
    pub async fn send_signed(&self, payload: &Value, token: Option<&str>) -> Result<Value, String> {
        let b = build_send_body(payload, &self.window_name())?;
        let b = if token.map_or(false, |t| !t.is_empty()) { b } else { without_person(b) };
        self.api_signed("send", Some(b), token).await
    }
    /// 往來記錄（#108）：一定要登入憑證（後台用簽章認人；節點金鑰 AI 也拿得到，不夠）。沒憑證直接回錯，不打後台
    pub async fn chat_history(&self, node: &str, agent: &str, token: Option<&str>) -> Result<Value, String> {
        let body = build_history_body(node, agent, None)?;
        let t = token.filter(|t| !t.is_empty()).ok_or("尚未登入，無法取得雲端的往來記錄")?;
        self.api_signed("chat_history", Some(body), Some(t)).await
    }
    pub async fn sent_status(&self, ids: &[String]) -> Result<Value, String> {
        let b = build_sent_status_body(ids)?;
        let v = self.api("sent_status", Some(b)).await?;
        Ok(v.get("status").cloned().unwrap_or(json!([])))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 設備名同步_內容只有視窗名_後台未部署靜默() {
        assert_eq!(build_set_name_body("小希"), json!({ "name": "小希" }));
        assert!(set_name_unsupported("set_name HTTP 404 not_found"));
        assert!(set_name_unsupported("set_name HTTP 400 bad_request"));
        assert!(!set_name_unsupported("set_name HTTP 500 internal"));
        assert!(!set_name_unsupported("set_name 連線失敗：timeout"));
    }

    #[test]
    fn 在線回報_內容欄位_狀態白名單_個人訊息清理() {
        assert_eq!(build_presence_body("H-ASN", "0.1.13", "busy", ""), json!({ "window_name": "H-ASN", "version": "0.1.13", "status": "busy" }));
        assert_eq!(
            build_presence_body("H-ASN", "0.1.13", "away", "  聽歌\u{7}中  "),
            json!({ "window_name": "H-ASN", "version": "0.1.13", "status": "away", "psm": "聽歌中" })
        );
        // 不認得的狀態當線上；offline 照送（後端刪列）
        assert_eq!(normalize_presence_status("hacked"), "online");
        assert_eq!(normalize_presence_status("offline"), "offline");
        // 個人訊息最多 80 字
        assert_eq!(clean_presence_psm(&"字".repeat(100)).chars().count(), PRESENCE_PSM_MAX);
        // 請求內容裡沒有節點欄位（節點由後端依金鑰決定）
        assert!(build_presence_body("w", "1.2.3", "online", "x").get("node").is_none());
    }

    /// 本機假後端：每個連線回一個固定狀態碼，並記下請求（只連 127.0.0.1）
    fn fake_server(code: u16) -> (String, std::sync::Arc<Mutex<Vec<String>>>) {
        fake_server_with(code, r#"{"ok":true}"#)
    }
    fn fake_server_with(code: u16, ok_body: &'static str) -> (String, std::sync::Arc<Mutex<Vec<String>>>) {
        use std::io::{Read, Write};
        let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://127.0.0.1:{}/relay", l.local_addr().unwrap().port());
        let seen = std::sync::Arc::new(Mutex::new(vec![]));
        let s2 = seen.clone();
        std::thread::spawn(move || {
            for c in l.incoming() {
                let Ok(mut c) = c else { break };
                let mut buf = vec![0u8; 8192];
                let n = c.read(&mut buf).unwrap_or(0);
                s2.lock().unwrap().push(String::from_utf8_lossy(&buf[..n]).to_string());
                let body = if code == 200 { ok_body } else { r#"{"error":"not_found"}"# };
                let _ = write!(c, "HTTP/1.1 {code} X\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}", body.len());
            }
        });
        (url, seen)
    }

    #[tokio::test]
    async fn 在線回報_後台未部署_404_就停止_不再送() {
        let (url, seen) = fake_server(404);
        let r = Relay::new(url, "k".into(), "H".into(), "H-ASN".into());
        assert!(!r.report_presence("0.1.13", Duration::from_secs(5)).await, "404＝後台還沒部署，停止回報");
        assert!(!r.report_presence("0.1.13", Duration::from_secs(5)).await);
        assert_eq!(seen.lock().unwrap().len(), 1, "停止後不再送出請求");
    }

    #[tokio::test]
    async fn 在線回報_成功會繼續_請求帶金鑰標頭與內容_關閉只送一次離線() {
        let (url, seen) = fake_server(200);
        let r = std::sync::Arc::new(Relay::new(url, "secret-key".into(), "H".into(), "H-ASN".into()));
        r.set_presence("busy", "寫程式");
        assert!(r.report_presence("0.1.13", Duration::from_secs(5)).await);
        {
            let s = seen.lock().unwrap();
            assert!(s[0].starts_with("POST /relay?action=asn_presence"));
            assert!(s[0].to_lowercase().contains("x-relay-key: secret-key"));
            assert!(s[0].contains(r#""status":"busy""#) && s[0].contains(r#""version":"0.1.13""#) && s[0].contains(r#""psm":"寫程式""#));
        }
        let r2 = r.clone();
        tokio::task::spawn_blocking(move || {
            r2.report_offline_blocking("0.1.13");
            r2.report_offline_blocking("0.1.13");
        })
        .await
        .unwrap();
        let s = seen.lock().unwrap();
        assert_eq!(s.len(), 2, "離線只送一次");
        assert!(s[1].contains(r#""status":"offline""#));
        drop(s);
        assert!(!r.report_presence("0.1.13", Duration::from_secs(5)).await, "送過離線後迴圈不再回報");
    }

    #[tokio::test]
    async fn 遠端更新_回應帶旗標才記下_只取一次_結果帶金鑰標頭() {
        let (url, _seen) = fake_server(200);
        let r = Relay::new(url, "k".into(), "H".into(), "H-ASN".into());
        assert!(r.report_presence("0.1.13", Duration::from_secs(5)).await);
        assert!(!r.take_update_request(), "回應沒旗標就不更新");
        let (url, _seen) = fake_server_with(200, r#"{"ok":true,"update_requested":true}"#);
        let r = Relay::new(url, "secret-key".into(), "H".into(), "H-ASN".into());
        assert!(r.report_presence("0.1.13", Duration::from_secs(5)).await);
        assert!(r.take_update_request());
        assert!(!r.take_update_request(), "旗標只取一次，不會重複啟動更新");
        let (url, seen) = fake_server(200);
        let r = Relay::new(url, "secret-key".into(), "H".into(), "H-ASN".into());
        r.report_update_result(false, "下載失敗\n請重試").await;
        let s = seen.lock().unwrap();
        assert!(s[0].starts_with("POST /relay?action=asn_update_result"));
        assert!(s[0].to_lowercase().contains("x-relay-key: secret-key"));
        assert!(s[0].contains(r#""ok":false"#) && s[0].contains("下載失敗") && !s[0].contains("\\n"));
    }

    fn send_payload() -> Value {
        json!({ "to_node": "W", "to_agent": "小職", "body": "安裝吧", "expects_reply": true })
    }

    #[tokio::test]
    async fn 本人簽章_視窗寄信帶憑證標頭_沒憑證和原本完全一樣() {
        let (url, seen) = fake_server(200);
        let r = Relay::new(url, "secret-key".into(), "H".into(), "H-ASN".into());
        r.send_signed(&send_payload(), Some("USERTOKEN-123")).await.unwrap();
        r.send_signed(&send_payload(), None).await.unwrap();
        r.send_signed(&send_payload(), Some("")).await.unwrap();
        let s = seen.lock().unwrap();
        let low = s[0].to_lowercase();
        assert!(low.contains("x-asn-user: bearer usertoken-123") && low.contains("x-relay-key: secret-key"), "{low}");
        assert!(!s[1].to_lowercase().contains("x-asn-user"), "沒憑證不帶標頭（登入過期也要能寄）");
        assert!(!s[2].to_lowercase().contains("x-asn-user"), "空憑證等於沒有");
        assert!(!s[0].contains("USERTOKEN") || s[0].contains("x-asn-user"), "憑證只出現在簽章標頭");
    }

    #[tokio::test]
    async fn 本人簽章_一般寄信路徑send與api不帶憑證() {
        let (url, seen) = fake_server(200);
        let r = Relay::new(url, "k".into(), "H".into(), "H-ASN".into());
        r.send(&send_payload()).await.unwrap();
        r.api("send", Some(json!({ "to_node": "W", "body": "x", "expects_reply": false }))).await.unwrap();
        let s = seen.lock().unwrap();
        assert_eq!(s.len(), 2);
        assert!(s.iter().all(|q| !q.to_lowercase().contains("x-asn-user")));
    }

    fn person_payload() -> Value {
        json!({ "to_node": "W", "to_agent": "小職", "body": "安裝吧", "expects_reply": true, "person": true })
    }

    #[test]
    fn 以人寄出_只有明說person才送as_person_欄位只此一個() {
        let b = build_send_body(&person_payload(), "H-ASN").unwrap();
        assert_eq!(b["as_person"], true);
        assert!(b.get("person").is_none(), "前端的 person 欄位不原樣送出");
        let none = build_send_body(&send_payload(), "H-ASN").unwrap();
        assert!(none.get("as_person").is_none(), "沒說就不送（舊行為）");
        let mut p = person_payload();
        p["person"] = json!("yes");
        assert!(build_send_body(&p, "H-ASN").unwrap().get("as_person").is_none(), "只認布林 true");
        // 震動也可以以人寄出
        let nudge = build_send_body(&json!({"to_node":"W","nudge":true,"expects_reply":false,"person":true}), "H-ASN").unwrap();
        assert_eq!(nudge["as_person"], true);
    }

    #[tokio::test]
    async fn 以人寄出_沒有登入憑證就拿掉as_person_有憑證才送() {
        let (url, seen) = fake_server(200);
        let r = Relay::new(url, "secret-key".into(), "H".into(), "H-ASN".into());
        r.send_signed(&person_payload(), Some("USERTOKEN-123")).await.unwrap();
        r.send_signed(&person_payload(), None).await.unwrap();
        r.send_signed(&person_payload(), Some("")).await.unwrap();
        r.send(&person_payload()).await.unwrap();
        let s = seen.lock().unwrap();
        assert!(s[0].contains(r#""as_person":true"#), "有憑證：送");
        for (i, q) in s.iter().enumerate().skip(1) {
            assert!(!q.contains("as_person"), "第 {i} 個請求不該帶 as_person：{q}");
        }
    }

    #[test]
    fn 往來記錄請求_只送夥伴與筆數_不送使用者() {
        assert_eq!(build_history_body("M", "小文", None).unwrap(), json!({ "node": "M", "agent": "小文" }));
        assert_eq!(build_history_body("M", "", Some(9999)).unwrap(), json!({ "node": "M", "limit": 200 }));
        assert_eq!(build_history_body("M", "", Some(0)).unwrap()["limit"], 1);
        assert!(build_history_body("a/b", "x", None).is_err());
        assert!(build_history_body("M", "a\nb", None).is_err());
        assert!(build_history_body("M", &"字".repeat(101), None).is_err());
    }

    #[tokio::test]
    async fn 往來記錄_一定要憑證_沒憑證不打後台_有憑證帶簽章標頭() {
        let (url, seen) = fake_server_with(200, r#"{"messages":[]}"#);
        let r = Relay::new(url, "secret-key".into(), "H".into(), "H-ASN".into());
        assert!(r.chat_history("M", "小文", None).await.is_err());
        assert!(r.chat_history("M", "小文", Some("")).await.is_err());
        assert_eq!(seen.lock().unwrap().len(), 0, "沒憑證不送出任何請求");
        let v = r.chat_history("M", "小文", Some("USERTOKEN-123")).await.unwrap();
        assert_eq!(v, json!({ "messages": [] }));
        let s = seen.lock().unwrap();
        let low = s[0].to_lowercase();
        assert!(s[0].starts_with("POST /relay?action=chat_history"));
        assert!(low.contains("x-asn-user: bearer usertoken-123") && low.contains("x-relay-key: secret-key"), "{low}");
        assert!(s[0].contains(r#""node":"M""#) && s[0].contains("小文"));
    }

    /// 守門：登入憑證只在 ASN 視窗的寄信指令（lib.rs）用；asn-cli、內建橋、機器橋相關程式碼一個字都不准碰。
    /// 拿掉這個測試守的東西（例如讓 cli 呼叫 api_signed）會讓它變紅。
    #[test]
    fn 守門_cli與橋的原始碼不碰登入憑證() {
        fn walk(dir: &std::path::Path, out: &mut Vec<std::path::PathBuf>) {
            for e in std::fs::read_dir(dir).unwrap().flatten() {
                let p = e.path();
                if p.is_dir() {
                    walk(&p, out);
                } else if p.extension().map_or(false, |x| x == "rs") {
                    out.push(p);
                }
            }
        }
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
        let mut files = vec![];
        for d in ["cli", "bin", "bridge"] {
            walk(&root.join(d), &mut files);
        }
        assert!(files.len() >= 10, "掃到的檔案太少，路徑可能變了：{}", files.len());
        // 標記字串用拆開的寫法，免得這個測試檔自己（不在掃描範圍，但以防日後搬動）命中
        let banned = [["api", "_signed"].concat(), ["send", "_signed"].concat(), ["signing", "_token"].concat(), ["SIGN", "_HEADER"].concat(), ["x-asn", "-user"].concat(), ["Auth", "State"].concat(), ["access", "_token"].concat(), ["as", "_person"].concat(), ["chat", "_history"].concat()];
        for f in &files {
            let t = std::fs::read_to_string(f).unwrap();
            for b in &banned {
                assert!(!t.contains(b.as_str()), "{} 不該出現 {b}（登入憑證不能交給 AI 能呼叫的路徑）", f.display());
            }
        }
    }

    #[test]
    fn 關閉時後台連不上不擋關閉() {
        // 連線埠沒人聽：很快失敗，report_offline_blocking 照常返回
        let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://127.0.0.1:{}/relay", l.local_addr().unwrap().port());
        drop(l);
        let r = std::sync::Arc::new(Relay::new(url, "k".into(), "H".into(), "H-ASN".into()));
        let t = std::time::Instant::now();
        r.report_offline_blocking("0.1.13");
        assert!(t.elapsed() < Duration::from_secs(5));
    }

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
        // 震動：前端只帶 nudge:true（帶了 body 也不理），內文由 Rust 用視窗名組成
        let b = build_send_body(&json!({"to_node":"W","nudge":true,"body":"偽造","expects_reply":false}), "H-ASN").unwrap();
        assert_eq!(b["expects_reply"], false);
        assert_eq!(b["body"], format!("（H-ASN 傳送了一個震動）\n{NUDGE_HINT}"));
        assert_eq!(b["from_agent"], "H-ASN");
        assert!(b.get("nudge").is_none(), "nudge 欄位不送給後端");
        assert!(build_send_body(&json!({"to_node":"W","nudge":true,"expects_reply":true}), "H-ASN").is_err());
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

    #[test]
    fn sent_status_只收_uuid_最多五十個() {
        let ok = "00000000-0000-0000-0000-000000000001".to_string();
        assert!(build_sent_status_body(&[ok.clone()]).is_ok());
        assert!(build_sent_status_body(&["nope".to_string()]).is_err());
        assert!(build_sent_status_body(&vec![ok; 51]).is_err());
    }
}

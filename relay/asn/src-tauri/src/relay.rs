//! 收發室 HTTP 客戶端。節點金鑰只存在這個結構裡（x-relay-key 標頭），不進 log、不傳前端。
//! 協定照 relay/machine/relay-core.mjs 的 api()，寄信欄位照 send.mjs／irori-relay/index.ts 的 send。
use serde_json::{json, Map, Value};
use crate::names::{prune, OldName};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Duration;
use std::path::PathBuf;

pub struct Relay {
    client: reqwest::Client,
    base: String,
    key: String,
    pub node: String,
    pub window: Mutex<String>,
    old: Mutex<Vec<OldName>>,
    /// 最近一次收信時「信件 id → 是從哪個名字的信箱拿到的」，ack 要對同一個名字送
    ack_agent: Mutex<HashMap<String, String>>,
    /// 沒指定收件視窗、橋決定「交給本人」的信（原始內容）。ASN 視窗收信時一併交給畫面，由本人決定轉給誰或自己回；畫面確認收下（ack）才移除
    unaddressed: Mutex<Vec<Value>>,
    /// 剛 ack 掉的未指定收件人信件 id（橋晚一步才處理到同一封舊回應時，不能再把它收回來）
    unaddressed_acked: Mutex<Vec<String>>,
    /// 這個程式的內建橋正在跑（橋自己負責把沒指定收件人的信交給本人，這裡不再另外去節點信箱撈）
    bridge_on: AtomicBool,
    /// 存「誰負責撈節點信箱裡沒指定收件人的信」記號檔的資料夾（橋的工作資料夾）；None＝不做互斥（測試）
    owner_dir: Mutex<Option<PathBuf>>,
    /// 在線狀態回報：目前的狀態與個人訊息（前端改了就更新並叫醒回報迴圈）
    presence: Mutex<(String, String)>,
    /// 後台還沒部署 asn_presence（404／400）：靜默停止回報，直到下次啟動
    presence_off: AtomicBool,
    /// 已經送過離線回報（關閉流程可能走兩次，只送一次，之後迴圈也不再回報）
    presence_closed: AtomicBool,
    /// 後台在回報回應裡說「本人要這台更新」：記下來等迴圈取走（只取一次，後台也只回一次）
    update_requested: AtomicBool,
    pub presence_wake: tokio::sync::Notify,
    /// 正在聽的歌（預設關；開了才有值，回報時蓋過個人訊息）
    pub now_playing: std::sync::Arc<crate::nowplaying::NowPlaying>,
    /// 畫面端最近一次呼叫收信（relay_inbox）的時間（毫秒）；0＝這次啟動以來畫面從沒收過
    ui_inbox_ms: AtomicU64,
    /// 這個 Relay 建立的時間（毫秒），畫面從沒收過信時拿來算「已經多久沒人收」
    started_ms: u64,
    /// 畫面沒在收信時由 Rust 代收的信（已向後台 ack）。畫面下次收信時原樣交給畫面，畫面確認收下才移除；存檔 window-spool.json，重開程式不遺失
    spool: Mutex<Vec<Value>>,
}

/// 畫面端超過這麼久沒收信，Rust 就代收寄給 ASN 視窗的信（畫面自己每 120 秒收一次，留足餘裕）
pub const UI_STALE_MS: u64 = 300_000;
/// 代收存放最多留幾封（超過丟最舊的）
const SPOOL_MAX: usize = 500;
const SPOOL_FILE: &str = "window-spool.json";

/// 要不要代收：畫面最後一次收信（或從沒收過就從程式啟動算起）已經超過門檻
pub fn fallback_due(now: u64, last_ui_ms: u64, started_ms: u64, stale_ms: u64) -> bool {
    now.saturating_sub(last_ui_ms.max(started_ms)) >= stale_ms
}
/// 診斷文字：畫面端多久前收過信（給橋的 log 用）
pub fn ui_seen_text(now: u64, last_ui_ms: u64) -> String {
    if last_ui_ms == 0 { "畫面端本次啟動以來從未收過信".into() } else { format!("畫面端 {} 秒前收過信", now.saturating_sub(last_ui_ms) / 1000) }
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
pub const NUDGE_HINT: &str = "對方在呼叫你：先回一個震動（寄一封內文只有「（你的名字 傳送了一個震動）」的信）。再想一下有沒有需要向對方報告的事——目前進度、卡住的地方、等對方決定的事；有的話另外寄一封簡短的信，沒有就只回震動。";

/// 前端交來的寄信內容 → 要送給後端的 body。from_agent 一律換成本程式的視窗名（前端不能自填），
/// 只放行 to_node／to_agent／body／reply_to／from_agent／expects_reply（外加選填 as_person、voice）；expects_reply 一定要明說（布林）。
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
    // 語音通話標記（選填布林，只有 true 才送；震動不帶）：收信端的收發室據此在抬頭說明行加固定提醒。舊後台不認得這個欄位會忽略
    if !nudge && o.get("voice").and_then(Value::as_bool) == Some(true) {
        m.insert("voice".into(), json!(true));
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

/// 夥伴 ID 的格式（與後台同）：p_ 加 20 個小寫十六進位字元
pub fn valid_partner_id(s: &str) -> bool {
    s.len() == 22 && s.starts_with("p_") && s[2..].bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// 往來記錄請求加上夥伴 ID（#153，選填）：格式不對就不送，後台改用名字比對
pub fn with_partner_id(mut body: Value, partner_id: Option<&str>) -> Value {
    if let (Some(o), Some(id)) = (body.as_object_mut(), partner_id.filter(|i| valid_partner_id(i))) {
        o.insert("partner_id".into(), json!(id));
    }
    body
}

/// 「早於」時間（往上捲載入更舊的信）：後台吃 ISO 8601（例如 2026-10-23T01:02:03.456Z）。格式明顯不對就不送（後台也會再驗一次）
pub fn valid_before(s: &str) -> bool {
    let b = s.as_bytes();
    s.len() >= 17 && s.len() <= 40 && b[0].is_ascii_digit() && s.contains('T') && b.iter().all(|c| c.is_ascii_digit() || matches!(c, b'T' | b':' | b'.' | b'-' | b'+' | b'Z'))
}

/// 往來記錄請求加上「早於」時間（選填）：沒帶或格式不對就不送，後台回最近的那批（行為與從前相同）
pub fn with_before(mut body: Value, before: Option<&str>) -> Value {
    if let (Some(o), Some(t)) = (body.as_object_mut(), before.filter(|t| valid_before(t))) {
        o.insert("before".into(), json!(t));
    }
    body
}

/// 「這是某某的接班」請求內容（#153）：前任夥伴 ID、新視窗的節點與名字；格式不對就不送
pub fn build_succeed_body(predecessor: &str, node: &str, name: &str) -> Result<Value, String> {
    if !valid_partner_id(predecessor) {
        return Err("前任夥伴格式不對".into());
    }
    if !crate::identity::valid_id(node) {
        return Err(format!("節點格式不對：{node}"));
    }
    if name.chars().count() < 1 || name.chars().count() > 60 || name.chars().any(|c| c.is_control()) {
        return Err("視窗名格式不對".into());
    }
    Ok(json!({ "predecessor": predecessor, "node": node, "name": name }))
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
    if ids.len() > 100 {
        return Err("一次最多確認 100 封信".into());
    }
    if !ids.iter().all(|i| uuid(i)) {
        return Err("信件 id 格式不對".into());
    }
    Ok(json!({ "ids": ids }))
}

/// set_name 的請求內容（驗證在後端與 names::validate_name 同規則；這裡只送視窗名）
pub fn build_set_name_body(name: &str) -> Value {
    json!({ "name": name })
}

/// window_rename 的請求內容（#229）：舊名→新名。後台把同節點在群組裡的成員記錄一併改名
pub fn build_window_rename_body(from: &str, to: &str) -> Value {
    json!({ "from": from, "to": to })
}

/// 該送出的改名：目前的名字之前用過、還沒過期的舊名，每個都「舊名→現用名」（冪等：後台舊鍵不在了就什麼都不改）。
/// A→B→C 連改時 A、B 都會對 C 各送一次，不會漏
pub fn pending_window_renames(active: &[String]) -> Vec<Value> {
    match active.split_first() {
        Some((cur, olds)) => olds.iter().filter(|o| *o != cur).map(|o| build_window_rename_body(o, cur)).collect(),
        None => vec![],
    }
}

/// 節點信箱的讀取動作。帶 exclude＝請後台別回寄給這些視窗名的信（逗號分隔、各自編碼；含逗號的名字略過，最多 20 個）。
/// 舊版後台不認得這個參數、照舊回最舊的一頁，所以舊後台也不會壞。
pub fn inbox_action(exclude: &[String]) -> String {
    let names: Vec<String> = exclude.iter().filter(|n| !n.is_empty() && !n.contains(',')).take(20).map(|n| encode_component(n)).collect();
    if names.is_empty() {
        "inbox".into()
    } else {
        format!("inbox&exclude={}", names.join(","))
    }
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
            client: reqwest::Client::new(), base, key, node, window: Mutex::new(window), old: Mutex::new(vec![]), ack_agent: Mutex::new(HashMap::new()), unaddressed: Mutex::new(vec![]), unaddressed_acked: Mutex::new(vec![]), bridge_on: AtomicBool::new(false), owner_dir: Mutex::new(None),
            presence: Mutex::new(("online".into(), String::new())), presence_off: AtomicBool::new(false), presence_closed: AtomicBool::new(false), update_requested: AtomicBool::new(false),
            presence_wake: tokio::sync::Notify::new(), now_playing: Default::default(),
            ui_inbox_ms: AtomicU64::new(0), started_ms: crate::heartbeat::now_ms(), spool: Mutex::new(vec![]),
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
        let psm = crate::nowplaying::compose_psm(&psm, &self.now_playing.current());
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
            crate::rt::block_on(async move {
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
    /// 橋把一封沒指定收件視窗的信交給本人：留在信箱（不 ack），等 ASN 畫面收下。回傳 true＝新收到（同一封重複交來回 false）
    pub fn hold_unaddressed(&self, raw: Value) -> bool {
        let Some(id) = raw.get("id").and_then(Value::as_str).map(String::from) else { return false };
        if self.unaddressed_acked.lock().unwrap().contains(&id) {
            return false;
        }
        let mut held = self.unaddressed.lock().unwrap();
        if held.iter().any(|m| m.get("id").and_then(Value::as_str) == Some(id.as_str())) {
            return false;
        }
        held.push(raw);
        true
    }
    pub fn set_bridge_running(&self, on: bool) {
        self.bridge_on.store(on, Ordering::Relaxed);
    }
    pub fn set_owner_dir(&self, dir: PathBuf) {
        // 讀回上次代收還沒交給畫面的信（壞檔當沒有）
        if let Some(v) = std::fs::read_to_string(dir.join(SPOOL_FILE)).ok().and_then(|t| serde_json::from_str::<Vec<Value>>(&t).ok()) {
            *self.spool.lock().unwrap() = v;
        }
        *self.owner_dir.lock().unwrap() = Some(dir);
    }
    /// 畫面端最近一次收信的時間（0＝從沒收過）
    pub fn ui_inbox_at(&self) -> u64 {
        self.ui_inbox_ms.load(Ordering::Relaxed)
    }
    /// 目前代收、還沒交給畫面的信件數
    pub fn spool_len(&self) -> usize {
        self.spool.lock().unwrap().len()
    }
    fn save_spool(&self) {
        let Some(dir) = self.owner_dir.lock().unwrap().clone() else { return };
        let t = serde_json::to_string(&*self.spool.lock().unwrap()).unwrap_or_else(|_| "[]".into());
        if let Err(e) = std::fs::write(dir.join(SPOOL_FILE), t) {
            eprintln!("spool save failed: {e}");
        }
    }
    /// 畫面沒在收信時代收寄給本機 ASN 視窗的信：存進代收區、存檔、再向後台 ack（delivered_at 才會有值）。
    /// 畫面一開始收信（inbox）就把代收區交給它，所以兩邊不會各處理一次。回傳這次新代收的封數
    pub async fn fallback_tick(&self, now: u64, stale_ms: u64) -> Result<usize, String> {
        if !fallback_due(now, self.ui_inbox_at(), self.started_ms, stale_ms) {
            return Ok(0);
        }
        let mut added = 0usize;
        for w in self.active_names() {
            let v = self.api(&format!("inbox&agent={}", encode_component(&w)), None).await?;
            let mine: Vec<Value> = v.get("messages").and_then(Value::as_array).cloned().unwrap_or_default().into_iter().filter(|m| m.get("to_agent").and_then(Value::as_str) == Some(w.as_str())).collect();
            let ids: Vec<String> = mine.iter().filter_map(|m| m.get("id").and_then(Value::as_str).map(String::from)).collect();
            if ids.is_empty() {
                continue;
            }
            {
                let mut sp = self.spool.lock().unwrap();
                for m in mine {
                    let id = m.get("id").and_then(Value::as_str).unwrap_or("");
                    if !sp.iter().any(|x| x.get("id").and_then(Value::as_str) == Some(id)) {
                        sp.push(m);
                        added += 1;
                    }
                }
                let n = sp.len();
                if n > SPOOL_MAX {
                    sp.drain(..n - SPOOL_MAX);
                }
            }
            self.save_spool();
            // 先存好再 ack：ack 失敗下一輪重抓，代收區以信件 id 去重
            self.api(&format!("ack&agent={}", encode_component(&w)), Some(build_ack_body(&ids)?)).await?;
        }
        Ok(added)
    }
    /// 同一個節點上只讓一個 ASN 程式去撈沒指定收件人的信（免得兩個視窗各顯示一次）：記號檔 owner-inbox.pid 放負責的 pid。
    /// 內建橋在跑的程式一律拿走記號；沒跑橋的程式只在記號檔沒人（或那個 pid 已死）時才拿
    fn owns_unaddressed(&self) -> bool {
        let Some(dir) = self.owner_dir.lock().unwrap().clone() else { return true };
        let (f, me) = (dir.join("owner-inbox.pid"), std::process::id());
        if !self.bridge_on.load(Ordering::Relaxed) {
            let other = std::fs::read_to_string(&f).ok().and_then(|s| s.trim().parse::<u32>().ok());
            if other.map(|p| p != me && crate::heartbeat::pid_alive(p)).unwrap_or(false) {
                return false;
            }
        }
        let _ = std::fs::write(&f, me.to_string());
        true
    }
    /// 沒有內建橋的 ASN（舊版收發室橋在跑，或沒有橋）自己去節點信箱撈沒指定收件人的信，一樣交給本人。
    /// 讀法是既有的節點信箱讀取（不新增後台動作、舊後端照用），只取 to_agent 為空的；舊橋不會 ack 這類信
    async fn pull_unaddressed(&self) {
        if self.bridge_on.load(Ordering::Relaxed) || !self.owns_unaddressed() {
            return;
        }
        // ASN 自己視窗的信由畫面另外收，不要讓它們占滿這一頁
        let Ok(v) = self.api(&inbox_action(&self.active_names()), None).await else { return };
        for m in v.get("messages").and_then(Value::as_array).cloned().unwrap_or_default() {
            let none = m.get("to_agent").and_then(Value::as_str).map(str::is_empty).unwrap_or(true);
            let from = m.get("from_agent").and_then(Value::as_str).unwrap_or("");
            if none && !from.ends_with("收發室") {
                self.hold_unaddressed(m);
            }
        }
    }
    /// 目前等著交給本人的信件 id
    pub fn unaddressed_ids(&self) -> Vec<String> {
        self.unaddressed.lock().unwrap().iter().filter_map(|m| m.get("id").and_then(Value::as_str).map(String::from)).collect()
    }
    pub async fn inbox(&self) -> Result<Value, String> {
        self.ui_inbox_ms.store(crate::heartbeat::now_ms(), Ordering::Relaxed);
        let names = self.active_names();
        self.pull_unaddressed().await;
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
        // 沒指定收件視窗的信：以本視窗名義交給畫面（標記 unaddressed）；ack 走節點信箱（對應名字留空）
        for raw in self.unaddressed.lock().unwrap().iter() {
            let Some(id) = raw.get("id").and_then(Value::as_str) else { continue };
            let mut m = raw.clone();
            m["to_agent"] = json!(names[0]);
            m["unaddressed"] = json!(true);
            map.insert(id.to_string(), String::new());
            all.push(m);
        }
        // Rust 代收的信（已 ack 過後台）：交給畫面；畫面確認收下才從代收區移除
        for m in self.spool.lock().unwrap().iter() {
            if !m.get("id").and_then(Value::as_str).map(|i| all.iter().any(|a| a.get("id").and_then(Value::as_str) == Some(i))).unwrap_or(true) {
                all.push(m.clone());
            }
        }
        *self.ack_agent.lock().unwrap() = map;
        Ok(json!({ "messages": all }))
    }
    pub async fn ack(&self, ids: &[String]) -> Result<Value, String> {
        build_ack_body(ids)?;
        // 代收區的信後台早已 ack：只從代收區移除，不再送後台
        let spooled: Vec<String> = {
            let mut sp = self.spool.lock().unwrap();
            let had: Vec<String> = ids.iter().filter(|i| sp.iter().any(|m| m.get("id").and_then(Value::as_str) == Some(i.as_str()))).cloned().collect();
            sp.retain(|m| !m.get("id").and_then(Value::as_str).map(|i| had.iter().any(|h| h == i)).unwrap_or(false));
            had
        };
        if !spooled.is_empty() {
            self.save_spool();
        }
        let ids: Vec<String> = ids.iter().filter(|i| !spooled.contains(i)).cloned().collect();
        let ids = &ids[..];
        if ids.is_empty() {
            return Ok(json!({ "acked": spooled.len() }));
        }
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
            let action = if agent.is_empty() { "ack".to_string() } else { format!("ack&agent={}", encode_component(&agent)) };
            let r = self.api(&action, Some(build_ack_body(&group)?)).await?;
            acked += r.get("acked").and_then(Value::as_u64).unwrap_or(0);
            if agent.is_empty() {
                self.unaddressed.lock().unwrap().retain(|m| !m.get("id").and_then(Value::as_str).map(|i| group.iter().any(|g| g == i)).unwrap_or(false));
                let mut done = self.unaddressed_acked.lock().unwrap();
                done.extend(group.iter().cloned());
                let n = done.len();
                if n > 200 {
                    done.drain(..n - 200);
                }
            }
        }
        Ok(json!({ "acked": acked + spooled.len() as u64 }))
    }
    /// 把這台設備的顯示名（nodes.name）設成目前的視窗名，名單才會讓別台設備的前台顯示這台的 ASN 視窗名。
    /// 只改自己這個節點的 name。後台還沒部署（404／400）當作不支援、靜默略過；其他失敗只記 log 並稍後再試，不打擾使用者。
    pub async fn sync_device_name(&self) {
        for wait in [0u64, 30, 120] {
            if wait > 0 {
                tokio::time::sleep(Duration::from_secs(wait)).await;
            }
            match self.api("set_name", Some(build_set_name_body(&self.window_name()))).await {
                Ok(_) => break,
                Err(e) if set_name_unsupported(&e) => break,
                Err(e) => eprintln!("set_name failed: {e}"),
            }
        }
        self.sync_window_renames().await;
    }
    /// 視窗改名後，請後台把群組成員記錄一併改名（#229）。啟動與改名時各送一次；後台沒有這個動作（404／400）就靜默略過，失敗只記 log
    pub async fn sync_window_renames(&self) {
        for body in pending_window_renames(&self.active_names()) {
            match self.api("window_rename", Some(body)).await {
                Ok(_) => {}
                Err(e) if set_name_unsupported(&e) => return,
                Err(e) => eprintln!("window_rename failed: {e}"),
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
    /// before＝只要早於這個時間的（往上捲載入更舊的信）、limit＝筆數（後台上限 200）；都沒給就和從前一樣取最近的一批
    pub async fn chat_history(&self, node: &str, agent: &str, partner_id: Option<&str>, before: Option<&str>, limit: Option<u64>, token: Option<&str>) -> Result<Value, String> {
        let body = with_before(with_partner_id(build_history_body(node, agent, limit)?, partner_id), before);
        let t = token.filter(|t| !t.is_empty()).ok_or("尚未登入，無法取得雲端的往來記錄")?;
        self.api_signed("chat_history", Some(body), Some(t)).await
    }
    /// 指定接班（#153）：一定要登入憑證（後台用簽章認人）。沒憑證直接回錯，不打後台
    pub async fn partner_succeed(&self, predecessor: &str, node: &str, name: &str, token: Option<&str>) -> Result<Value, String> {
        let body = build_succeed_body(predecessor, node, name)?;
        let t = token.filter(|t| !t.is_empty()).ok_or("尚未登入，無法指定接班")?;
        self.api_signed("partner_succeed", Some(body), Some(t)).await
    }
    /// 可被接班的夥伴清單（#153）：同樣要登入憑證
    pub async fn partner_list(&self, token: Option<&str>) -> Result<Value, String> {
        let t = token.filter(|t| !t.is_empty()).ok_or("尚未登入，無法取得夥伴清單")?;
        self.api_signed("partner_list", Some(json!({})), Some(t)).await
    }
    /// 遠端開新夥伴（手機用，#158）：一定要本人簽章（後台用簽章證明這個節點是本人的才准下令）。沒憑證直接回錯，不打後台
    pub async fn launch_signed(&self, body: &Value, token: Option<&str>) -> Result<Value, String> {
        let b = build_launch_body(body)?;
        let t = token.filter(|t| !t.is_empty()).ok_or("尚未登入，無法替電腦開新夥伴")?;
        self.api_signed("launch", Some(b), Some(t)).await
    }
    /// 各電腦的啟動設定（模型、資料夾、在線）與最近開視窗的進度（手機用）：同樣要本人簽章
    pub async fn launchers_signed(&self, ids: Option<&[String]>, token: Option<&str>) -> Result<Value, String> {
        let b = build_launchers_body(ids)?;
        let t = token.filter(|t| !t.is_empty()).ok_or("尚未登入，無法查詢電腦的啟動設定")?;
        self.api_signed("launchers", Some(b), Some(t)).await
    }
    /// 遠端管理夥伴視窗（手機用，設計見 docs/design/PARTNER-OPS.md）：下令。一定要本人簽章；沒憑證在打後台之前就回錯。回 { id }
    pub async fn partner_op_signed(&self, body: &Value, token: Option<&str>) -> Result<Value, String> {
        let b = build_partner_op_body(body)?;
        let t = token.filter(|t| !t.is_empty()).ok_or("尚未登入，無法管理夥伴視窗")?;
        self.api_signed("partner_op", Some(b), Some(t)).await
    }
    /// 封存／取消封存夥伴（電腦與手機共用，記在帳號層）：要本人簽章；沒憑證在打後台之前就回錯。回 { ok, archived }
    pub async fn partner_archive_signed(&self, body: &Value, token: Option<&str>) -> Result<Value, String> {
        let b = build_partner_archive_body(body)?;
        let t = token.filter(|t| !t.is_empty()).ok_or("尚未登入，無法封存夥伴")?;
        self.api_signed("partner_archive", Some(b), Some(t)).await
    }
    /// 已讀多端同步（電腦與手機共用）：要本人簽章；沒憑證在打後台之前就回錯。送出 marks（可空，只取回），回 { ok, marks }
    pub async fn read_sync_signed(&self, body: &Value, token: Option<&str>) -> Result<Value, String> {
        let b = build_read_sync_body(body)?;
        let t = token.filter(|t| !t.is_empty()).ok_or("尚未登入，無法同步已讀")?;
        self.api_signed("read_sync", Some(b), Some(t)).await
    }
    /// 遠端切換 Claude 帳號（手機用，#227；設計見 acct_remote.rs，後台同一組動作）：看某台電腦回報的帳號清單。要本人簽章；沒憑證在打後台之前就回錯
    pub async fn acct_list_signed(&self, node: &str, token: Option<&str>) -> Result<Value, String> {
        let b = build_acct_list_body(node)?;
        let t = token.filter(|t| !t.is_empty()).ok_or("尚未登入，無法查看電腦的帳號")?;
        self.api_signed("acct_list", Some(b), Some(t)).await
    }
    /// 送出「切換帳號」指令（只帶目標 email）。要本人簽章；回 { id }
    pub async fn acct_switch_signed(&self, node: &str, email: &str, token: Option<&str>) -> Result<Value, String> {
        let b = build_acct_switch_body(node, email)?;
        let t = token.filter(|t| !t.is_empty()).ok_or("尚未登入，無法切換電腦的帳號")?;
        self.api_signed("acct_switch", Some(b), Some(t)).await
    }
    /// 查切換指令的結果。後台只看得到「自己送出的」指令，所以用節點金鑰即可（不需要簽章）。回 { switches: [...] }
    pub async fn acct_switch_status(&self, ids: &[String]) -> Result<Value, String> {
        self.api("acct_switch_status", Some(build_acct_status_body(ids)?)).await
    }
    /// 查管理操作的進度（手機用）：同樣要本人簽章。回 { ops: [...] }
    pub async fn partner_ops_signed(&self, ids: &[String], token: Option<&str>) -> Result<Value, String> {
        let b = build_partner_ops_body(ids)?;
        let t = token.filter(|t| !t.is_empty()).ok_or("尚未登入，無法查詢管理操作的進度")?;
        self.api_signed("partner_ops", Some(b), Some(t)).await
    }
    /// 讀群組訊息（手機用）：和電腦版同一條路（節點金鑰，限成員）。回 { messages, last_seq }
    pub async fn room_read(&self, room: &str, agent: Option<&str>, since: u64, limit: Option<u64>, mark: bool) -> Result<Value, String> {
        self.api(&build_room_read_action(room, agent, since, limit, mark)?, None).await
    }
    /// 讀群組訊息（電腦與手機）：有登入憑證就帶上（本人在跨租戶群組用 ~u:<帳號> 的身分才讀得到）；沒憑證＝照舊用節點金鑰
    pub async fn room_read_as(&self, room: &str, agent: Option<&str>, since: u64, limit: Option<u64>, mark: bool, token: Option<&str>) -> Result<Value, String> {
        let a = build_room_read_action(room, agent, since, limit, mark)?;
        match token.filter(|t| !t.is_empty()) {
            Some(t) => self.api_signed(&a, None, Some(t)).await,
            None => self.api(&a, None).await,
        }
    }
    /// 群組列表（電腦與手機）：有登入憑證就帶上，後台才會把「本人是成員」的跨租戶群組一起列出（含 external、is_host）
    pub async fn rooms_as(&self, token: Option<&str>) -> Result<Value, String> {
        match token.filter(|t| !t.is_empty()) {
            Some(t) => self.api_signed("room_list", None, Some(t)).await,
            None => self.api("room_list", None).await,
        }
    }
    /// 真人的群組動作（建群組、邀請、接受邀請、退出、帶自己的 AI、主持人確認…）：一定要本人簽章；沒憑證在打後台之前就回錯。動作與內容先整理、格式擋在前面
    pub async fn group_signed(&self, action: &str, raw: &Value, token: Option<&str>) -> Result<Value, String> {
        let b = build_group_body(action, raw)?;
        let t = token.filter(|t| !t.is_empty()).ok_or("尚未登入，無法使用群組")?;
        self.api_signed(action, Some(b), Some(t)).await
    }    /// 群組發言（手機用）：一定要本人簽章（後台才會標成本人發言）。沒憑證在打後台之前就回錯
    pub async fn room_post_signed(&self, body: &Value, token: Option<&str>) -> Result<Value, String> {
        let b = build_room_post_body(body)?;
        let t = token.filter(|t| !t.is_empty()).ok_or("尚未登入，無法在群組發言")?;
        self.api_signed("room_post", Some(b), Some(t)).await
    }
    pub async fn sent_status(&self, ids: &[String]) -> Result<Value, String> {
        let b = build_sent_status_body(ids)?;
        let v = self.api("sent_status", Some(b)).await?;
        Ok(v.get("status").cloned().unwrap_or(json!([])))
    }
}

/// 視窗名：英數、連字號、中文，1～40 字，不能以連字號開頭（與後台、機器橋同一條規則）
pub fn valid_launch_name(s: &str) -> bool {
    let ok = |c: char, first: bool| c.is_ascii_alphanumeric() || ('\u{4e00}'..='\u{9fff}').contains(&c) || (!first && c == '-');
    let n = s.chars().count();
    (1..=40).contains(&n) && s.chars().enumerate().all(|(i, c)| ok(c, i == 0))
}

/// 前端交來的開視窗請求 → 送給後台的 body。只放行 node／profile／name／cwd／first_message 五個欄位（指令內容一律不帶），格式先在這裡擋
pub fn build_launch_body(raw: &Value) -> Result<Value, String> {
    let o = raw.as_object().ok_or("開視窗的內容格式不對")?;
    let s = |k: &str| o.get(k).and_then(Value::as_str).unwrap_or("");
    let node = s("node");
    if !crate::identity::valid_id(node) {
        return Err(format!("電腦代號格式不對：{node}"));
    }
    let (profile, name, cwd) = (s("profile"), s("name"), s("cwd"));
    if profile.is_empty() || profile.chars().count() > 40 || profile.chars().any(|c| c.is_control()) {
        return Err("模型選項不對".into());
    }
    if !valid_launch_name(name) {
        return Err("名字只能用英數、連字號、中文，1～40 字，不能以連字號開頭".into());
    }
    if cwd.is_empty() || cwd.chars().count() > 260 || cwd.chars().any(|c| c.is_control()) {
        return Err("工作資料夾不對".into());
    }
    let first = match o.get("first_message") {
        None | Some(Value::Null) => None,
        Some(Value::String(t)) => Some(t.trim().to_string()).filter(|t| !t.is_empty()),
        Some(_) => return Err("第一句話格式不對".into()),
    };
    if first.as_ref().is_some_and(|t| t.chars().count() > 4000) {
        return Err("第一句話最多 4000 字".into());
    }
    Ok(json!({ "node": node, "profile": profile, "name": name, "cwd": cwd, "first_message": first }))
}

fn is_uuid_str(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 36 && b.iter().enumerate().all(|(i, c)| if [8, 13, 18, 23].contains(&i) { *c == b'-' } else { c.is_ascii_hexdigit() })
}
pub fn build_launchers_body(ids: Option<&[String]>) -> Result<Value, String> {
    match ids {
        None => Ok(json!({})),
        Some(l) if l.len() <= 20 && l.iter().all(|i| is_uuid_str(i)) => Ok(json!({ "ids": l })),
        Some(_) => Err("查詢的編號格式不對".into()),
    }
}

/// 夥伴視窗管理的動作：詳情、改名、切換模型、關閉、轉交下一任（與後台同一份清單）
pub const PARTNER_OPS: [&str; 6] = ["info", "rename", "model", "close", "handover", "resume"];
/// 模型字串：1～60 字，只允許英數與 . _ [ ] -（與後台同一條規則）
pub fn valid_model_str(s: &str) -> bool {
    let n = s.chars().count();
    (1..=60).contains(&n) && s.chars().all(|c| c.is_ascii_alphanumeric() || "._[]-".contains(c))
}
/// 下令的內容：只留 node／name／op 與該動作用得到的欄位（new_name／model／note），其餘一律丟掉；格式不對在打後台之前就回錯
pub fn build_partner_op_body(raw: &Value) -> Result<Value, String> {
    let o = raw.as_object().ok_or("管理視窗的內容格式不對")?;
    let s = |k: &str| o.get(k).and_then(Value::as_str);
    let node = s("node").unwrap_or("");
    if !crate::identity::valid_id(node) {
        return Err(format!("電腦代號格式不對：{node}"));
    }
    let name = s("name").unwrap_or("");
    if name.is_empty() || name.chars().count() > 80 || name.chars().any(|c| c.is_control()) {
        return Err("視窗名字不對".into());
    }
    let op = s("op").unwrap_or("");
    if !PARTNER_OPS.contains(&op) {
        return Err("不認得這個操作".into());
    }
    let mut b = json!({ "node": node, "name": name, "op": op });
    match op {
        "rename" => {
            let n = s("new_name").unwrap_or("");
            if !valid_launch_name(n) {
                return Err("名字只能用英數、連字號、中文，1～40 字，不能以連字號開頭".into());
            }
            b["new_name"] = json!(n);
        }
        "model" => {
            let m = s("model").unwrap_or("");
            if !valid_model_str(m) {
                return Err("模型名稱不對".into());
            }
            b["model"] = json!(m);
        }
        "handover" => match o.get("note") {
            None | Some(Value::Null) => {}
            Some(Value::String(t)) => {
                let t = t.trim();
                if t.chars().count() > 1000 {
                    return Err("補充的話最多 1000 字".into());
                }
                if !t.is_empty() {
                    b["note"] = json!(t);
                }
            }
            Some(_) => return Err("補充的話格式不對".into()),
        },
        _ => {}
    }
    Ok(b)
}
/// 已讀同步的內容：只留 marks（最多 100 筆，每筆 key 3～140 字且無控制字元、at 為正整數毫秒）；格式不對在打後台之前就回錯
pub fn build_read_sync_body(raw: &Value) -> Result<Value, String> {
    let list = match raw.get("marks") {
        None | Some(Value::Null) => Vec::new(),
        Some(Value::Array(a)) => a.clone(),
        Some(_) => return Err("已讀記錄的格式不對".into()),
    };
    if list.len() > 100 {
        return Err("一次最多同步 100 筆已讀".into());
    }
    let mut out = Vec::new();
    for m in &list {
        let key = m.get("key").and_then(Value::as_str).unwrap_or("");
        let n = key.chars().count();
        if !(3..=140).contains(&n) || key.chars().any(|c| c.is_control()) {
            return Err("已讀記錄的鍵不對".into());
        }
        let at = m.get("at").and_then(Value::as_u64).filter(|a| *a > 0 && *a <= 4_102_444_800_000).ok_or("已讀位置不對")?;
        out.push(json!({ "key": key, "at": at }));
    }
    Ok(json!({ "marks": out }))
}
/// 封存的內容：node、archived（布林）、夥伴 ID（有就帶，格式要對）、名字（沒有夥伴 ID 時必填）；其餘一律丟掉。格式不對在打後台之前就回錯
pub fn build_partner_archive_body(raw: &Value) -> Result<Value, String> {
    let o = raw.as_object().ok_or("封存的內容格式不對")?;
    let node = o.get("node").and_then(Value::as_str).unwrap_or("");
    if !crate::identity::valid_id(node) {
        return Err(format!("電腦代號格式不對：{node}"));
    }
    let archived = o.get("archived").and_then(Value::as_bool).ok_or("要說明是封存還是取消封存")?;
    let pid = match o.get("partner_id") {
        None | Some(Value::Null) => None,
        Some(Value::String(s)) if s.is_empty() => None,
        Some(Value::String(s)) if valid_partner_id(s) => Some(s.clone()),
        Some(_) => return Err("夥伴編號格式不對".into()),
    };
    let name = o.get("name").and_then(Value::as_str).filter(|n| !n.is_empty() && n.chars().count() <= 80 && !n.chars().any(|c| c.is_control()));
    if pid.is_none() && name.is_none() {
        return Err("視窗名字不對".into());
    }
    let mut b = json!({ "node": node, "archived": archived });
    if let Some(p) = pid {
        b["partner_id"] = json!(p);
    }
    if let Some(n) = name {
        b["name"] = json!(n);
    }
    Ok(b)
}
/// 切換帳號用的設備代號與 email 檢查（與 acct_remote.rs、後台同一條規則；acct_remote 只有電腦版編進去，手機這邊自己留一份）
fn acct_node_ok(s: &str) -> bool {
    (1..=32).contains(&s.len()) && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}
fn acct_email(s: &str) -> Option<String> {
    let t = s.trim().to_lowercase();
    let (user, host) = t.split_once('@')?;
    let ok = (3..=120).contains(&t.chars().count())
        && !user.is_empty()
        && !host.is_empty()
        && !host.contains('@')
        && !t.chars().any(|c| c.is_control() || c.is_whitespace() || "/\\:*?\"<>|".contains(c));
    ok.then_some(t)
}
pub fn build_acct_list_body(node: &str) -> Result<Value, String> {
    if acct_node_ok(node) { Ok(json!({ "node": node })) } else { Err("設備代號不對".into()) }
}
pub fn build_acct_switch_body(node: &str, email: &str) -> Result<Value, String> {
    if !acct_node_ok(node) {
        return Err("設備代號不對".into());
    }
    let email = acct_email(email).ok_or("email 格式不對")?;
    Ok(json!({ "node": node, "vendor": "claude", "email": email }))
}
pub fn build_acct_status_body(ids: &[String]) -> Result<Value, String> {
    if (1..=20).contains(&ids.len()) && ids.iter().all(|i| is_uuid_str(i)) {
        Ok(json!({ "ids": ids }))
    } else {
        Err("指令編號不對".into())
    }
}
/// 手機決定終端請求（term_req_decide）的請求體：編號是 UUID、決定只有 approve／deny、雜湊是 64 位小寫十六進位（原樣帶回，後台比對）、選項 0..=99（拒絕時不帶）
pub fn build_term_decide_body(id: &str, decision: &str, choice_n: Option<i64>, hash: &str) -> Result<Value, String> {
    if !is_uuid_str(id) {
        return Err("請求編號不對".into());
    }
    if decision != "approve" && decision != "deny" {
        return Err("決定只能是確認或拒絕".into());
    }
    if hash.len() != 64 || !hash.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) {
        return Err("內容雜湊格式不對".into());
    }
    if let Some(n) = choice_n {
        if !(0..=99).contains(&n) {
            return Err("選項編號不對".into());
        }
    }
    let mut v = json!({ "id": id, "decision": decision, "hash": hash });
    if let Some(n) = choice_n.filter(|_| decision == "approve") {
        v["choice_n"] = json!(n);
    }
    Ok(v)
}
pub fn build_partner_ops_body(ids: &[String]) -> Result<Value, String> {
    if (1..=20).contains(&ids.len()) && ids.iter().all(|i| is_uuid_str(i)) {
        Ok(json!({ "ids": ids }))
    } else {
        Err("查詢的編號格式不對".into())
    }
}

/// 群組代號：英數、底線、連字號，1～32 字（與後台同一條規則）
pub fn valid_room_id(s: &str) -> bool {
    (1..=32).contains(&s.len()) && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}
/// 視窗代發的視窗名：不含「~」、不含控制字元、最多 60 字
fn valid_room_agent(s: &str) -> bool {
    s.chars().count() <= 60 && !s.contains('~') && !s.chars().any(|c| c.is_control())
}
/// 讀群組訊息的動作字串（手機用）：一定帶 since（沒帶後台會把已讀推進），mark＝讀完要不要標已讀
pub fn build_room_read_action(room: &str, agent: Option<&str>, since: u64, limit: Option<u64>, mark: bool) -> Result<String, String> {
    if !valid_room_id(room) {
        return Err("群組代號格式不對".into());
    }
    let mut a = format!("room_read&room={}&since={}&limit={}", encode_component(room), since.min(999_999_999), limit.unwrap_or(50).clamp(1, 200));
    if let Some(g) = agent.filter(|g| !g.is_empty()) {
        if !valid_room_agent(g) {
            return Err("視窗名格式不對".into());
        }
        a.push_str(&format!("&as_agent={}", encode_component(g)));
    }
    if mark {
        a.push_str("&mark=1");
    }
    Ok(a)
}
/// 群組發言的內容（手機用）：只放行 room／body／from_agent／reply_to 四個欄位
pub fn build_room_post_body(raw: &Value) -> Result<Value, String> {
    let o = raw.as_object().ok_or("發言的內容格式不對")?;
    let room = o.get("room").and_then(Value::as_str).unwrap_or("");
    if !valid_room_id(room) {
        return Err("群組代號格式不對".into());
    }
    let body = o.get("body").and_then(Value::as_str).unwrap_or("");
    if body.trim().is_empty() || body.chars().count() > 20_000 {
        return Err("訊息要 1 到 20000 字".into());
    }
    let mut b = json!({ "room": room, "body": body });
    match o.get("from_agent") {
        None | Some(Value::Null) => {}
        Some(Value::String(g)) if g.is_empty() => {}
        Some(Value::String(g)) if valid_room_agent(g) => b["from_agent"] = json!(g),
        Some(_) => return Err("視窗名格式不對".into()),
    }
    // 回覆某則訊息（群組內序號，正整數）；不合格的當沒有引用，訊息照送
    if let Some(n) = o.get("reply_to").and_then(Value::as_u64).filter(|n| (1..1_000_000_000_000_000).contains(n)) {
        b["reply_to"] = json!(n);
    }
    Ok(b)
}

/// 真人群組動作的名稱（與後台 _shared/groups.ts 的 GROUP_ACTIONS 同一組）
pub const GROUP_ACTIONS: [&str; 12] = [
    "group_create", "group_invite_create", "group_invite_revoke", "group_invite_preview", "group_invite_accept",
    "group_upgrade", "group_leave", "group_ai_add", "group_ai_remove", "group_allow_others", "group_confirm_decide", "group_confirm_list",
];
/// 邀請碼：英數、底線、連字號，16～64 字
pub fn valid_invite_code(s: &str) -> bool {
    (16..=64).contains(&s.len()) && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}
/// 視窗成員鍵「節點~視窗名」：恰好一個 ~、不以 ~ 開頭或結尾、不含控制字元、最多 120 字
fn valid_window_key(k: &str) -> bool {
    let n = k.chars().count();
    (3..=120).contains(&n) && k.matches('~').count() == 1 && !k.starts_with('~') && !k.ends_with('~') && !k.chars().any(|c| c.is_control())
}
fn window_keys(v: Option<&Value>, min: usize, max: usize) -> Result<Vec<String>, String> {
    let arr = match v {
        None | Some(Value::Null) if min == 0 => return Ok(vec![]),
        Some(Value::Array(a)) => a,
        _ => return Err("夥伴清單格式不對".into()),
    };
    let mut out: Vec<String> = vec![];
    for x in arr {
        let k = x.as_str().filter(|k| valid_window_key(k)).ok_or("夥伴清單格式不對")?;
        if !out.iter().any(|o| o == k) {
            out.push(k.to_string());
        }
    }
    if out.len() < min || out.len() > max {
        return Err("夥伴清單的數量不對".into());
    }
    Ok(out)
}
fn group_room(o: &serde_json::Map<String, Value>) -> Result<&str, String> {
    o.get("room").and_then(Value::as_str).filter(|r| valid_room_id(r)).ok_or_else(|| "群組代號格式不對".to_string())
}
fn group_node_agent(o: &serde_json::Map<String, Value>, b: &mut Value) -> Result<(), String> {
    if let Some(n) = o.get("node").filter(|n| !n.is_null()) {
        let n = n.as_str().filter(|n| valid_room_id(n)).ok_or("節點格式不對")?;
        b["node"] = json!(n);
    }
    if let Some(a) = o.get("agent").filter(|a| !a.is_null()) {
        let a = a.as_str().ok_or("視窗名格式不對")?;
        if !a.is_empty() {
            if !valid_room_agent(a) {
                return Err("視窗名格式不對".into());
            }
            b["agent"] = json!(a);
        }
    }
    Ok(())
}
fn group_seed(o: &serde_json::Map<String, Value>, b: &mut Value) -> Result<(), String> {
    if let Some(s) = o.get("seed").filter(|s| !s.is_null()) {
        let n = s.as_u64().filter(|n| *n <= 50).ok_or("複製的訊息數要在 0 到 50 之間")?;
        b["seed"] = json!(n);
    }
    Ok(())
}
/// 前端交來的群組動作內容 → 送給後台的 body。只放行每個動作需要的欄位，格式先在這裡擋（金鑰與憑證都不在這裡）
pub fn build_group_body(action: &str, raw: &Value) -> Result<Value, String> {
    if !GROUP_ACTIONS.contains(&action) {
        return Err("不認得的群組動作".into());
    }
    let o = raw.as_object().ok_or("群組動作的內容格式不對")?;
    let uuid = |k: &str| o.get(k).and_then(Value::as_str).filter(|v| is_uuid_str(v)).map(String::from).ok_or_else(|| "編號格式不對".to_string());
    let mut b = json!({});
    match action {
        "group_create" => {
            let name = o.get("name").and_then(Value::as_str).map(str::trim).unwrap_or("");
            if name.is_empty() || name.chars().count() > 60 {
                return Err("群組名稱要 1 到 60 字".into());
            }
            b["name"] = json!(name);
            b["ai"] = json!(window_keys(o.get("ai"), 0, 20)?);
        }
        "group_invite_create" => {
            match o.get("kind").and_then(Value::as_str) {
                Some("room") => {
                    b["kind"] = json!("room");
                    b["room"] = json!(group_room(o)?);
                }
                Some("conversation") => {
                    b["kind"] = json!("conversation");
                    group_node_agent(o, &mut b)?;
                }
                _ => return Err("邀請的種類不對".into()),
            }
            group_seed(o, &mut b)?;
        }
        "group_invite_revoke" => b["id"] = json!(uuid("id")?),
        "group_invite_preview" | "group_invite_accept" => {
            let c = o.get("code").and_then(Value::as_str).filter(|c| valid_invite_code(c)).ok_or("邀請碼格式不對")?;
            b["code"] = json!(c);
        }
        "group_upgrade" => {
            group_node_agent(o, &mut b)?;
            group_seed(o, &mut b)?;
            b["extra"] = json!(window_keys(o.get("extra"), 1, 10)?);
            if let Some(n) = o.get("name").filter(|n| !n.is_null()) {
                let n = n.as_str().map(str::trim).filter(|n| !n.is_empty() && n.chars().count() <= 60).ok_or("群組名稱要 1 到 60 字")?;
                b["name"] = json!(n);
            }
        }
        "group_leave" | "group_confirm_list" => b["room"] = json!(group_room(o)?),
        "group_ai_add" => {
            b["room"] = json!(group_room(o)?);
            b["keys"] = json!(window_keys(o.get("keys"), 1, 10)?);
        }
        "group_ai_remove" | "group_allow_others" => {
            b["room"] = json!(group_room(o)?);
            let k = o.get("key").and_then(Value::as_str).filter(|k| valid_window_key(k)).ok_or("夥伴格式不對")?;
            b["key"] = json!(k);
            if action == "group_allow_others" {
                b["allow"] = json!(o.get("allow").and_then(Value::as_bool).ok_or("缺少開關的值")?);
            }
        }
        "group_confirm_decide" => {
            b["room"] = json!(group_room(o)?);
            b["id"] = json!(uuid("id")?);
            b["approve"] = json!(o.get("approve").and_then(Value::as_bool).ok_or("缺少同意或拒絕")?);
        }
        _ => return Err("不認得的群組動作".into()),
    }
    Ok(b)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 遠端開視窗_請求只留五個欄位_格式擋在前面() {
        let ok = json!({ "node": "H", "profile": "claude", "name": "小幫手-2", "cwd": "D:\\Github\\asn", "first_message": "  開始吧 ", "command": "calc.exe", "args": ["x"] });
        let b = build_launch_body(&ok).unwrap();
        assert_eq!(b, json!({ "node": "H", "profile": "claude", "name": "小幫手-2", "cwd": "D:\\Github\\asn", "first_message": "開始吧" }));
        assert_eq!(build_launch_body(&json!({ "node": "H", "profile": "p", "name": "a", "cwd": "c" })).unwrap()["first_message"], Value::Null);
        for bad in [json!({ "node": "H;x", "profile": "p", "name": "a", "cwd": "c" }), json!({ "node": "H", "profile": "", "name": "a", "cwd": "c" }), json!({ "node": "H", "profile": "p", "name": "-rf", "cwd": "c" }), json!({ "node": "H", "profile": "p", "name": "a b", "cwd": "c" }), json!({ "node": "H", "profile": "p", "name": "a", "cwd": "" }), json!({ "node": "H", "profile": "p", "name": "a", "cwd": "c", "first_message": 5 }), json!({ "node": "H", "profile": "p", "name": "a", "cwd": "c", "first_message": "字".repeat(4001) }), json!([1])] {
            assert!(build_launch_body(&bad).is_err(), "{bad}");
        }
        assert!(valid_launch_name("英雄-2") && valid_launch_name(&"X".repeat(40)) && !valid_launch_name(&"X".repeat(41)) && !valid_launch_name("") && !valid_launch_name("a/b"));
    }

    #[test]
    fn 查詢進度的編號要是_uuid_最多_20_個() {
        let id = "11111111-1111-1111-1111-111111111111".to_string();
        assert_eq!(build_launchers_body(None).unwrap(), json!({}));
        assert_eq!(build_launchers_body(Some(&[id.clone()])).unwrap(), json!({ "ids": [id.clone()] }));
        assert!(build_launchers_body(Some(&["x".to_string()])).is_err());
        assert!(build_launchers_body(Some(&vec![id; 21])).is_err());
    }

    #[test]
    fn 管理視窗_請求只留該動作的欄位_格式擋在前面() {
        let base = |op: &str| json!({ "node": "H", "name": "小文", "op": op, "new_name": "新名-2", "model": "opus[1m]", "note": " 接著做 ", "command": "calc.exe" });
        assert_eq!(build_partner_op_body(&base("close")).unwrap(), json!({ "node": "H", "name": "小文", "op": "close" }));
        assert_eq!(build_partner_op_body(&base("info")).unwrap(), json!({ "node": "H", "name": "小文", "op": "info" }));
        assert_eq!(build_partner_op_body(&base("rename")).unwrap(), json!({ "node": "H", "name": "小文", "op": "rename", "new_name": "新名-2" }));
        assert_eq!(build_partner_op_body(&base("model")).unwrap(), json!({ "node": "H", "name": "小文", "op": "model", "model": "opus[1m]" }));
        assert_eq!(build_partner_op_body(&base("handover")).unwrap(), json!({ "node": "H", "name": "小文", "op": "handover", "note": "接著做" }));
        assert_eq!(build_partner_op_body(&json!({ "node": "H", "name": "小文", "op": "resume", "session_id": "../x", "note": "n", "new_name": "x" })).unwrap(), json!({ "node": "H", "name": "小文", "op": "resume" }), "喚醒：session 由後台查，不收畫面傳的");
        assert_eq!(build_partner_op_body(&json!({ "node": "H", "name": "小文", "op": "handover", "note": "  " })).unwrap(), json!({ "node": "H", "name": "小文", "op": "handover" }));
        let bad = [
            json!({ "node": "H;x", "name": "a", "op": "close" }), json!({ "node": "H", "name": "", "op": "close" }), json!({ "node": "H", "name": "a
b", "op": "close" }),
            json!({ "node": "H", "name": "a", "op": "kill" }), json!({ "node": "H", "name": "a", "op": "rename", "new_name": "-rf" }), json!({ "node": "H", "name": "a", "op": "rename" }),
            json!({ "node": "H", "name": "a", "op": "model", "model": "a b" }), json!({ "node": "H", "name": "a", "op": "model", "model": "x;y" }), json!({ "node": "H", "name": "a", "op": "model" }),
            json!({ "node": "H", "name": "a", "op": "model", "model": "m".repeat(61) }), json!({ "node": "H", "name": "a", "op": "handover", "note": "字".repeat(1001) }),
            json!({ "node": "H", "name": "a", "op": "handover", "note": 5 }), json!([1]),
        ];
        for b in bad {
            assert!(build_partner_op_body(&b).is_err(), "{b}");
        }
        assert!(valid_model_str("claude-opus-4-1[1m]") && valid_model_str(&"m".repeat(60)) && !valid_model_str("") && !valid_model_str("a b"));
        let id = "11111111-1111-1111-1111-111111111111".to_string();
        assert_eq!(build_partner_ops_body(&[id.clone()]).unwrap(), json!({ "ids": [id.clone()] }));
        assert!(build_partner_ops_body(&[]).is_err() && build_partner_ops_body(&["x".to_string()]).is_err() && build_partner_ops_body(&vec![id; 21]).is_err());
    }

    #[test]
    fn 切換帳號_請求內容只有設備_廠商_email() {
        assert_eq!(build_acct_list_body("W-2_a").unwrap(), json!({ "node": "W-2_a" }));
        assert!(build_acct_list_body("").is_err() && build_acct_list_body("a b").is_err() && build_acct_list_body(&"x".repeat(33)).is_err());
        assert_eq!(build_acct_switch_body("W", " B@X.test ").unwrap(), json!({ "node": "W", "vendor": "claude", "email": "b@x.test" }));
        for bad in ["", "a", "a@", "@b", "a@b@c", "a b@c", "a/b@c", "../x@y", "a
@b"] {
            assert!(build_acct_switch_body("W", bad).is_err(), "{bad}");
        }
        assert!(build_acct_switch_body("W W", "a@b.c").is_err());
        let id = "11111111-1111-1111-1111-111111111111".to_string();
        assert_eq!(build_acct_status_body(&[id.clone()]).unwrap(), json!({ "ids": [id.clone()] }));
        assert!(build_acct_status_body(&[]).is_err() && build_acct_status_body(&["x".to_string()]).is_err() && build_acct_status_body(&vec![id; 21]).is_err());
    }

    #[test]
    fn 終端請求決定_欄位檢查_拒絕不帶選項_雜湊要六十四位小寫十六進位() {
        let id = "11111111-2222-3333-4444-555555555555";
        let h = "a".repeat(64);
        assert_eq!(build_term_decide_body(id, "approve", Some(2), &h).unwrap(), json!({ "id": id, "decision": "approve", "hash": h, "choice_n": 2 }));
        assert_eq!(build_term_decide_body(id, "approve", None, &h).unwrap(), json!({ "id": id, "decision": "approve", "hash": h }));
        assert_eq!(build_term_decide_body(id, "deny", Some(2), &h).unwrap(), json!({ "id": id, "decision": "deny", "hash": h }), "拒絕不帶選項");
        assert!(build_term_decide_body("x", "approve", None, &h).is_err());
        assert!(build_term_decide_body(id, "yes", None, &h).is_err());
        assert!(build_term_decide_body(id, "approve", None, &"A".repeat(64)).is_err(), "大寫不收");
        assert!(build_term_decide_body(id, "approve", None, &"a".repeat(63)).is_err());
        assert!(build_term_decide_body(id, "approve", Some(100), &h).is_err() && build_term_decide_body(id, "approve", Some(-1), &h).is_err());
    }

    #[tokio::test]
    async fn 切換帳號_沒有本人簽章不送出_有簽章帶標頭() {
        let (url, seen) = fake_server(200);
        let r = Relay::new(url, "secret-key".into(), "P".into(), "P-ASN".into());
        assert!(r.acct_list_signed("W", None).await.unwrap_err().contains("尚未登入"));
        assert!(r.acct_switch_signed("W", "b@x.test", Some("")).await.is_err(), "空憑證等於沒有");
        assert!(seen.lock().unwrap().is_empty(), "沒簽章時完全沒有打後台");
        r.acct_list_signed("W", Some("usertoken-9")).await.unwrap();
        r.acct_switch_signed("W", "b@x.test", Some("usertoken-9")).await.unwrap();
        let s = seen.lock().unwrap();
        assert_eq!(s.len(), 2);
        assert!(s.iter().all(|x| x.to_lowercase().contains("x-asn-user: bearer usertoken-9")), "{s:?}");
        assert!(s[0].contains("action=acct_list") && s[1].contains("action=acct_switch"));
    }

    #[tokio::test]
    async fn 遠端開視窗_沒有本人簽章不送出_有簽章帶標頭() {
        let (url, seen) = fake_server(200);
        let r = Relay::new(url, "secret-key".into(), "P".into(), "P-ASN".into());
        let req = json!({ "node": "H", "profile": "claude", "name": "夥伴-1", "cwd": "c" });
        assert!(r.launch_signed(&req, None).await.unwrap_err().contains("尚未登入"));
        assert!(r.launch_signed(&req, Some("")).await.is_err(), "空憑證等於沒有");
        assert!(r.launchers_signed(None, None).await.is_err());
        assert!(seen.lock().unwrap().is_empty(), "沒簽章時完全沒有打後台");
        r.launch_signed(&req, Some("usertoken-9")).await.unwrap();
        r.launchers_signed(None, Some("usertoken-9")).await.unwrap();
        let s = seen.lock().unwrap();
        assert_eq!(s.len(), 2);
        assert!(s.iter().all(|q| q.to_lowercase().contains("x-asn-user: bearer usertoken-9") && q.to_lowercase().contains("x-relay-key: secret-key")));
        assert!(s[0].contains("action=launch ") || s[0].contains("action=launch\r") || s[0].contains("action=launch"), "{}", s[0]);
    }

    #[tokio::test]
    async fn 管理視窗_沒有本人簽章不送出_有簽章帶標頭() {
        let (url, seen) = fake_server(200);
        let r = Relay::new(url, "secret-key".into(), "P".into(), "P-ASN".into());
        let req = json!({ "node": "H", "name": "小文", "op": "close" });
        let id = vec!["11111111-1111-1111-1111-111111111111".to_string()];
        assert!(r.partner_op_signed(&req, None).await.unwrap_err().contains("尚未登入"));
        assert!(r.partner_op_signed(&req, Some("")).await.is_err(), "空憑證等於沒有");
        assert!(r.partner_ops_signed(&id, None).await.is_err());
        assert!(seen.lock().unwrap().is_empty(), "沒簽章時完全沒有打後台");
        r.partner_op_signed(&req, Some("usertoken-9")).await.unwrap();
        r.partner_ops_signed(&id, Some("usertoken-9")).await.unwrap();
        let s = seen.lock().unwrap();
        assert_eq!(s.len(), 2);
        assert!(s.iter().all(|q| q.to_lowercase().contains("x-asn-user: bearer usertoken-9") && q.to_lowercase().contains("x-relay-key: secret-key")));
        assert!(s[0].contains("action=partner_op ") && s[1].contains("action=partner_ops "), "{} / {}", s[0], s[1]);
    }

    #[test]
    fn 封存夥伴_請求內容只留該有的欄位_格式擋在前面() {
        let pid = "p_0123456789abcdef0123";
        assert_eq!(build_partner_archive_body(&json!({ "node": "H", "partner_id": pid, "name": "小文", "archived": true, "op": "kill" })).unwrap(), json!({ "node": "H", "archived": true, "partner_id": pid, "name": "小文" }));
        assert_eq!(build_partner_archive_body(&json!({ "node": "H", "name": "小文", "archived": false })).unwrap(), json!({ "node": "H", "archived": false, "name": "小文" }));
        assert_eq!(build_partner_archive_body(&json!({ "node": "H", "partner_id": "", "name": "小文", "archived": true })).unwrap(), json!({ "node": "H", "archived": true, "name": "小文" }));
        let bad = [
            json!({ "node": "H;x", "name": "a", "archived": true }), json!({ "node": "H", "archived": true }), json!({ "node": "H", "name": "", "archived": true }),
            json!({ "node": "H", "name": "a" }), json!({ "node": "H", "name": "a", "archived": "true" }), json!({ "node": "H", "partner_id": "p_xyz", "archived": true }),
            json!({ "node": "H", "name": "a\nb", "archived": true }), json!({ "node": "H", "name": "字".repeat(81), "archived": true }), json!([1]),
        ];
        for b in bad {
            assert!(build_partner_archive_body(&b).is_err(), "{b}");
        }
    }

    #[test]
    fn 已讀同步_內容整理_壞格式在打後台前擋下() {
        assert_eq!(build_read_sync_body(&json!({})).unwrap(), json!({ "marks": [] }));
        assert_eq!(build_read_sync_body(&json!({ "marks": [{ "key": "p_0123456789abcdef0123", "at": 1700000000000u64, "x": 1 }] })).unwrap(), json!({ "marks": [{ "key": "p_0123456789abcdef0123", "at": 1700000000000u64 }] }));
        for bad in [json!({ "marks": "x" }), json!({ "marks": [{ "key": "ab", "at": 5 }] }), json!({ "marks": [{ "key": "abc", "at": 0 }] }), json!({ "marks": [{ "key": "abc", "at": -1 }] }), json!({ "marks": [{ "key": "abc", "at": 1.5 }] }), json!({ "marks": [{ "key": "a
b", "at": 5 }] }), json!({ "marks": [{ "at": 5 }] })] {
            assert!(build_read_sync_body(&bad).is_err(), "{bad}");
        }
        let many: Vec<Value> = (0..101).map(|i| json!({ "key": format!("n:H/{i}"), "at": 5 })).collect();
        assert!(build_read_sync_body(&json!({ "marks": many })).is_err());
    }

    #[tokio::test]
    async fn 已讀同步_沒有本人簽章不送出_有簽章帶標頭() {
        let (url, seen) = fake_server(200);
        let r = Relay::new(url, "secret-key".into(), "P".into(), "P-ASN".into());
        let req = json!({ "marks": [] });
        assert!(r.read_sync_signed(&req, None).await.unwrap_err().contains("尚未登入"));
        assert!(r.read_sync_signed(&req, Some("")).await.is_err(), "空憑證等於沒有");
        assert!(seen.lock().unwrap().is_empty(), "沒簽章時完全沒有打後台");
        r.read_sync_signed(&req, Some("usertoken-9")).await.unwrap();
        let s = seen.lock().unwrap();
        assert_eq!(s.len(), 1);
        assert!(s[0].to_lowercase().contains("x-asn-user: bearer usertoken-9") && s[0].contains("action=read_sync"), "{}", s[0]);
    }

    #[test]
    fn 群組讀寫_動作與內容只留必要欄位_格式擋在前面() {
        assert_eq!(build_room_read_action("r-1", None, 0, None, false).unwrap(), "room_read&room=r-1&since=0&limit=50");
        assert_eq!(build_room_read_action("r_1", Some("手機"), 7, Some(999), true).unwrap(), "room_read&room=r_1&since=7&limit=200&as_agent=%E6%89%8B%E6%A9%9F&mark=1");
        assert!(build_room_read_action("a&action=x", None, 0, None, false).is_err() && build_room_read_action("", None, 0, None, false).is_err());
        assert!(build_room_read_action("r", Some("a~b"), 0, None, false).is_err());
        let b = build_room_post_body(&json!({ "room": "r1", "body": "嗨", "from_agent": "手機", "as_owner": true, "command": "x" })).unwrap();
        assert_eq!(b, json!({ "room": "r1", "body": "嗨", "from_agent": "手機" }));
        assert_eq!(build_room_post_body(&json!({ "room": "r1", "body": "嗨", "from_agent": "" })).unwrap(), json!({ "room": "r1", "body": "嗨" }));
        // 回覆：正整數才放行，其餘（0、負數、小數、字串）當沒有引用
        assert_eq!(build_room_post_body(&json!({ "room": "r1", "body": "嗨", "reply_to": 12 })).unwrap(), json!({ "room": "r1", "body": "嗨", "reply_to": 12 }));
        for bad in [json!(0), json!(-3), json!(1.5), json!("7"), json!(null)] {
            assert_eq!(build_room_post_body(&json!({ "room": "r1", "body": "嗨", "reply_to": bad })).unwrap(), json!({ "room": "r1", "body": "嗨" }), "{bad}");
        }
        for bad in [json!({ "room": "r 1", "body": "嗨" }), json!({ "room": "r1", "body": "  " }), json!({ "room": "r1", "body": "字".repeat(20_001) }), json!({ "room": "r1", "body": "a", "from_agent": "x~y" }), json!({ "room": "r1", "body": "a", "from_agent": 5 }), json!([1])] {
            assert!(build_room_post_body(&bad).is_err(), "{bad}");
        }
    }

    #[tokio::test]
    async fn 群組發言_沒有本人簽章不送出_有簽章帶標頭_讀取不帶簽章() {
        let (url, seen) = fake_server(200);
        let r = Relay::new(url, "secret-key".into(), "P".into(), "P-ASN".into());
        let req = json!({ "room": "r1", "body": "嗨" });
        assert!(r.room_post_signed(&req, None).await.unwrap_err().contains("尚未登入"));
        assert!(r.room_post_signed(&req, Some("")).await.is_err(), "空憑證等於沒有");
        assert!(seen.lock().unwrap().is_empty(), "沒簽章時完全沒有打後台");
        r.room_post_signed(&req, Some("usertoken-9")).await.unwrap();
        r.room_read("r1", None, 3, Some(20), true).await.unwrap();
        let s = seen.lock().unwrap();
        assert_eq!(s.len(), 2);
        assert!(s[0].to_lowercase().contains("x-asn-user: bearer usertoken-9") && s[0].contains("action=room_post"), "{}", s[0]);
        assert!(s[1].contains("action=room_read") && s[1].contains("since=3") && !s[1].to_lowercase().contains("x-asn-user"), "{}", s[1]);
    }

    #[test]
    fn 群組動作_內容只留必要欄位_格式擋在前面() {
        let u = "0b9c8f3a-1111-4222-8333-444455556666";
        assert_eq!(build_group_body("group_create", &json!({ "name": " 財務群 ", "ai": ["T~財務", "T~財務", "T~報表"], "x": 1 })).unwrap(), json!({ "name": "財務群", "ai": ["T~財務", "T~報表"] }));
        assert_eq!(build_group_body("group_create", &json!({ "name": "空群" })).unwrap(), json!({ "name": "空群", "ai": [] }));
        assert_eq!(build_group_body("group_invite_create", &json!({ "kind": "conversation", "node": "T", "agent": "財務", "seed": 40, "z": 1 })).unwrap(), json!({ "kind": "conversation", "node": "T", "agent": "財務", "seed": 40 }));
        assert_eq!(build_group_body("group_invite_create", &json!({ "kind": "room", "room": "g-1", "seed": 0, "node": "T" })).unwrap(), json!({ "kind": "room", "room": "g-1", "seed": 0 }));
        assert_eq!(build_group_body("group_invite_preview", &json!({ "code": "abcdefgh12345678" })).unwrap(), json!({ "code": "abcdefgh12345678" }));
        assert_eq!(build_group_body("group_confirm_decide", &json!({ "room": "g1", "id": u, "approve": false })).unwrap(), json!({ "room": "g1", "id": u, "approve": false }));
        assert_eq!(build_group_body("group_allow_others", &json!({ "room": "g1", "key": "T~財務", "allow": true })).unwrap(), json!({ "room": "g1", "key": "T~財務", "allow": true }));
        assert_eq!(build_group_body("group_leave", &json!({ "room": "g1", "p_user": "偷塞" })).unwrap(), json!({ "room": "g1" }));
        for (a, bad) in [
            ("group_create", json!({ "name": "  " })), ("group_create", json!({ "name": "字".repeat(61) })), ("group_create", json!({ "name": "a", "ai": ["沒有波浪"] })), ("group_create", json!({ "name": "a", "ai": ["~開頭"] })), ("group_create", json!({ "name": "a", "ai": "x" })),
            ("group_invite_create", json!({ "kind": "friend" })), ("group_invite_create", json!({ "kind": "room" })), ("group_invite_create", json!({ "kind": "conversation", "seed": 51 })), ("group_invite_create", json!({ "kind": "conversation", "seed": -1 })), ("group_invite_create", json!({ "kind": "conversation", "agent": "a~b" })),
            ("group_invite_revoke", json!({ "id": "不是編號" })), ("group_invite_accept", json!({ "code": "短" })), ("group_invite_accept", json!({ "code": "abcdefgh1234567/" })),
            ("group_upgrade", json!({ "extra": [] })), ("group_ai_add", json!({ "room": "g1", "keys": [] })), ("group_ai_remove", json!({ "room": "g1" })), ("group_allow_others", json!({ "room": "g1", "key": "T~a" })),
            ("group_confirm_decide", json!({ "room": "g1", "id": u })), ("group_confirm_decide", json!({ "room": "a&b", "id": u, "approve": true })), ("group_leave", json!({})), ("group_不存在", json!({})), ("group_leave", json!([1])),
        ] {
            assert!(build_group_body(a, &bad).is_err(), "{a} {bad}");
        }
    }

    #[tokio::test]
    async fn 群組動作_沒有本人簽章不送出_有簽章帶標頭_列表與讀取有憑證才帶() {
        let (url, seen) = fake_server(200);
        let r = Relay::new(url, "secret-key".into(), "P".into(), "P-ASN".into());
        let req = json!({ "name": "財務群" });
        assert!(r.group_signed("group_create", &req, None).await.unwrap_err().contains("尚未登入"));
        assert!(r.group_signed("group_create", &req, Some("")).await.is_err(), "空憑證等於沒有");
        assert!(r.group_signed("group_create", &json!({ "name": "" }), Some("t")).await.is_err(), "格式錯在打後台前擋下");
        assert!(seen.lock().unwrap().is_empty(), "沒簽章或格式錯時完全沒有打後台");
        r.group_signed("group_create", &req, Some("usertoken-9")).await.unwrap();
        r.rooms_as(Some("usertoken-9")).await.unwrap();
        r.rooms_as(None).await.unwrap();
        r.room_read_as("r1", None, 3, Some(20), true, Some("usertoken-9")).await.unwrap();
        r.room_read_as("r1", None, 3, Some(20), true, None).await.unwrap();
        let s = seen.lock().unwrap();
        assert_eq!(s.len(), 5);
        let signed = |i: usize| s[i].to_lowercase().contains("x-asn-user: bearer usertoken-9");
        assert!(signed(0) && s[0].contains("action=group_create"), "{}", s[0]);
        assert!(signed(1) && s[1].contains("action=room_list"), "{}", s[1]);
        assert!(!signed(2), "沒憑證就不帶");
        assert!(signed(3) && s[3].contains("action=room_read"), "{}", s[3]);
        assert!(!signed(4));
    }

    #[tokio::test]
    async fn 封存夥伴_沒有本人簽章不送出_有簽章帶標頭() {
        let (url, seen) = fake_server(200);
        let r = Relay::new(url, "secret-key".into(), "P".into(), "P-ASN".into());
        let req = json!({ "node": "H", "name": "小文", "archived": true });
        assert!(r.partner_archive_signed(&req, None).await.unwrap_err().contains("尚未登入"));
        assert!(r.partner_archive_signed(&req, Some("")).await.is_err(), "空憑證等於沒有");
        assert!(seen.lock().unwrap().is_empty(), "沒簽章時完全沒有打後台");
        r.partner_archive_signed(&req, Some("usertoken-9")).await.unwrap();
        let s = seen.lock().unwrap();
        assert_eq!(s.len(), 1);
        assert!(s[0].to_lowercase().contains("x-asn-user: bearer usertoken-9") && s[0].contains("action=partner_archive"), "{}", s[0]);
    }

    #[test]
    fn 視窗改名_舊名對現用名各送一次_沒有舊名就不送() {
        let v = |x: &[&str]| x.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert!(pending_window_renames(&v(&["n33ae0d87"])).is_empty());
        assert!(pending_window_renames(&[]).is_empty());
        assert_eq!(pending_window_renames(&v(&["asn-test-1", "n33ae0d87"])), vec![json!({ "from": "n33ae0d87", "to": "asn-test-1" })]);
        // A→B→C：A、B 都對 C
        assert_eq!(
            pending_window_renames(&v(&["C", "B", "A"])),
            vec![json!({ "from": "B", "to": "C" }), json!({ "from": "A", "to": "C" })]
        );
    }

    #[tokio::test]
    async fn 視窗改名_送到window_rename動作_後台未部署靜默() {
        let (url, seen) = fake_server(200);
        let r = Relay::new(url, "k".into(), "H".into(), "n33ae0d87".into());
        r.sync_window_renames().await;
        assert!(seen.lock().unwrap().is_empty(), "沒改過名＝完全不打後台（舊行為）");
        r.set_old_names(vec![crate::names::OldName { name: "n33ae0d87".into(), t: crate::heartbeat::now_ms() }]);
        *r.window.lock().unwrap() = "asn-test-1".into();
        r.sync_window_renames().await;
        {
            let s = seen.lock().unwrap();
            assert_eq!(s.len(), 1);
            assert!(s[0].starts_with("POST /relay?action=window_rename"), "{}", s[0]);
            assert!(s[0].contains(r#""from":"n33ae0d87""#) && s[0].contains(r#""to":"asn-test-1""#), "{}", s[0]);
        }
        let (url404, seen404) = fake_server(404);
        let r2 = Relay::new(url404, "k".into(), "H".into(), "新".into());
        let now = crate::heartbeat::now_ms();
        r2.set_old_names(vec![crate::names::OldName { name: "舊1".into(), t: now }, crate::names::OldName { name: "舊2".into(), t: now - 1 }]);
        r2.sync_window_renames().await;
        assert_eq!(seen404.lock().unwrap().len(), 1, "後台不認得就停，不再試下一個");
    }

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
    async fn 在線回報_正在聽的歌_關著送自己的個人訊息_開了只送歌名加歌手() {
        use crate::nowplaying::{MediaSource, Track};
        struct Fake;
        impl MediaSource for Fake {
            fn playing(&self) -> Option<Track> {
                Some(Track { title: "夜曲".into(), artist: "周杰倫".into() })
            }
        }
        let (url, seen) = fake_server(200);
        let r = Relay::new(url, "k".into(), "H".into(), "H-ASN".into());
        r.set_presence("online", "寫程式");
        r.now_playing.tick(&Fake); // 開關預設關：不讀、沒值
        assert!(r.report_presence("0.1.13", Duration::from_secs(5)).await);
        r.now_playing.set_enabled(true);
        r.now_playing.tick(&Fake);
        assert!(r.report_presence("0.1.13", Duration::from_secs(5)).await);
        r.now_playing.set_enabled(false);
        assert!(r.report_presence("0.1.13", Duration::from_secs(5)).await);
        let s = seen.lock().unwrap();
        assert!(s[0].contains(r#""psm":"寫程式""#) && !s[0].contains("正在聽") && !s[0].contains("夜曲"), "關著不送歌");
        assert!(s[1].contains(r#""psm":"♪ 正在聽：夜曲 - 周杰倫""#), "{}", s[1]);
        assert!(s[2].contains(r#""psm":"寫程式""#) && !s[2].contains("夜曲"), "關掉立刻恢復");
        drop(s);
        let v = build_presence_body("H-ASN", "0.1.13", "online", &crate::nowplaying::compose_psm("", "夜曲 - 周杰倫"));
        let mut keys: Vec<_> = v.as_object().unwrap().keys().cloned().collect();
        keys.sort();
        assert_eq!(keys, ["psm", "status", "version", "window_name"], "沒有多餘欄位（無專輯圖、應用程式、進度）");
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
        assert!(r.chat_history("M", "小文", None, None, None, None).await.is_err());
        assert!(r.chat_history("M", "小文", None, None, None, Some("")).await.is_err());
        assert_eq!(seen.lock().unwrap().len(), 0, "沒憑證不送出任何請求");
        let v = r.chat_history("M", "小文", Some("p_0123456789abcdef0123"), None, None, Some("USERTOKEN-123")).await.unwrap();
        assert_eq!(v, json!({ "messages": [] }));
        let s = seen.lock().unwrap();
        let low = s[0].to_lowercase();
        assert!(s[0].starts_with("POST /relay?action=chat_history"));
        assert!(low.contains("x-asn-user: bearer usertoken-123") && low.contains("x-relay-key: secret-key"), "{low}");
        assert!(s[0].contains(r#""node":"M""#) && s[0].contains("小文"));
        assert!(s[0].contains(r#""partner_id":"p_0123456789abcdef0123""#), "夥伴 ID 一併送出：{}", s[0]);
    }

    #[test]
    fn 往來記錄請求_夥伴_id_格式不對就不送() {
        let b = build_history_body("M", "小文", None).unwrap();
        assert_eq!(with_partner_id(b.clone(), Some("p_0123456789abcdef0123"))["partner_id"], "p_0123456789abcdef0123");
        assert_eq!(with_partner_id(b.clone(), Some("p_XYZ")), b);
        assert_eq!(with_partner_id(b.clone(), None), b);
    }

    #[test]
    fn 往來記錄請求_早於時間與筆數_格式對才送_沒帶就和從前一樣() {
        let b = build_history_body("M", "小文", None).unwrap();
        let t = "2026-10-23T01:02:03.456Z";
        assert_eq!(with_before(b.clone(), Some(t))["before"], t);
        assert_eq!(with_before(b.clone(), Some("2026-10-23T09:02:03+08:00"))["before"], "2026-10-23T09:02:03+08:00");
        for bad in ["", "昨天", "yesterday", "2026-10-23", "2026-10-23T01:02:03Z; drop table", &"2".repeat(41)] {
            assert_eq!(with_before(b.clone(), Some(bad)), b, "{bad}");
        }
        assert_eq!(with_before(b.clone(), None), b, "沒帶就一個鍵都不多");
        assert_eq!(build_history_body("M", "小文", Some(50)).unwrap()["limit"], 50);
    }

    #[tokio::test]
    async fn 往來記錄_早於時間與筆數有轉送到請求本文() {
        let (url, seen) = fake_server_with(200, r#"{"messages":[]}"#);
        let r = Relay::new(url, "secret-key".into(), "H".into(), "H-ASN".into());
        r.chat_history("M", "小文", None, Some("2026-10-23T01:02:03.456Z"), Some(50), Some("USERTOKEN-123")).await.unwrap();
        r.chat_history("M", "小文", None, None, None, Some("USERTOKEN-123")).await.unwrap();
        let s = seen.lock().unwrap();
        assert!(s[0].contains(r#""before":"2026-10-23T01:02:03.456Z""#) && s[0].contains(r#""limit":50"#), "{}", s[0]);
        assert!(!s[1].contains("before") && !s[1].contains("limit"), "沒帶就不送：{}", s[1]);
    }

    #[test]
    fn 接班請求內容_格式檢查() {
        let id = "p_0123456789abcdef0123";
        assert_eq!(build_succeed_body(id, "M", "小文").unwrap(), json!({ "predecessor": id, "node": "M", "name": "小文" }));
        assert!(build_succeed_body("p_x", "M", "小文").is_err());
        assert!(build_succeed_body(id, "a/b", "小文").is_err());
        assert!(build_succeed_body(id, "M", "").is_err());
        assert!(build_succeed_body(id, "M", "a\nb").is_err());
    }

    #[tokio::test]
    async fn 指定接班與夥伴清單_一定要憑證_沒憑證不打後台_有憑證帶簽章標頭() {
        let (url, seen) = fake_server_with(200, r#"{"ok":true}"#);
        let r = Relay::new(url, "secret-key".into(), "H".into(), "H-ASN".into());
        let id = "p_0123456789abcdef0123";
        assert!(r.partner_succeed(id, "M", "小文", None).await.is_err());
        assert!(r.partner_succeed(id, "M", "小文", Some("")).await.is_err());
        assert!(r.partner_list(None).await.is_err());
        assert_eq!(seen.lock().unwrap().len(), 0, "沒憑證不送出任何請求");
        r.partner_succeed(id, "M", "小文", Some("USERTOKEN-123")).await.unwrap();
        r.partner_list(Some("USERTOKEN-123")).await.unwrap();
        let s = seen.lock().unwrap();
        assert!(s[0].starts_with("POST /relay?action=partner_succeed") && s[1].starts_with("POST /relay?action=partner_list"));
        for q in s.iter() {
            assert!(q.to_lowercase().contains("x-asn-user: bearer usertoken-123"), "{q}");
        }
        assert!(s[0].contains(id) && s[0].contains(r#""name":"小文""#));
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
        let banned = [["api", "_signed"].concat(), ["send", "_signed"].concat(), ["signing", "_token"].concat(), ["SIGN", "_HEADER"].concat(), ["x-asn", "-user"].concat(), ["Auth", "State"].concat(), ["access", "_token"].concat(), ["as", "_person"].concat(), ["chat", "_history"].concat(), ["partner", "_succeed"].concat(), ["partner", "_list"].concat()];
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
    fn 寄信_語音旗標只認布林true_震動不帶() {
        let base = json!({"to_node":"W","body":"嗨","expects_reply":true});
        let with = |v: Value| { let mut p = base.clone(); p["voice"] = v; build_send_body(&p, "H-ASN").unwrap() };
        assert_eq!(with(json!(true))["voice"], true);
        for bad in [json!(false), json!("true"), json!(1), json!(null)] {
            assert!(with(bad.clone()).get("voice").is_none(), "{bad}");
        }
        assert!(build_send_body(&base, "H-ASN").unwrap().get("voice").is_none(), "沒說就不帶");
        let n = build_send_body(&json!({"to_node":"W","nudge":true,"expects_reply":false,"voice":true}), "H-ASN").unwrap();
        assert!(n.get("voice").is_none(), "震動不帶語音旗標");
        // 沒有登入憑證時 voice 照送（它只是提醒收信端的標記，不是身分）；as_person 才會被拿掉
        let mut p = base.clone(); p["voice"] = json!(true); p["person"] = json!(true);
        let b = without_person(build_send_body(&p, "H-ASN").unwrap());
        assert_eq!(b["voice"], true);
        assert!(b.get("as_person").is_none());
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

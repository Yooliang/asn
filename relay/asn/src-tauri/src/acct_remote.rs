//! 遠端切換 Claude 帳號（經收發室的「切換帳號」指令）。
//!
//! 流程（權杖只在各自那台電腦搬，絕不進收發室）：
//! 1. 每台 ASN 定期回報自己帳號庫的清單：email、方案、是否使用中，加上選填的剩餘額度（`acct_report`；額度來源見 claude_quota.rs）。
//! 2. 發起端（擁有者設備）列出對方清單（`acct_list`）、選一個 email 送出（`acct_switch`）；
//!    後端只收擁有者節點、同租戶、且 email 在對方最近一次回報的清單裡。
//! 3. 對方 ASN 取走自己的待辦（`acct_switch_pending`）→ 預設跳出確認、使用者按了才在本機搬檔
//!    （設定可改成「信任我自己的設備，不用確認」）→ 把結果（成功／失敗原因）回報（`acct_switch_result`）。
//! 4. 發起端用 `acct_switch_status` 查結果。
//!
//! 指令只帶目標帳號的 email；本機只接受「自己剛從收發室取走、尚未處理」的指令編號，
//! 所以介面端無法憑空要求切換，每個編號只能處理一次。
use crate::claude_accounts::{self, AccountInfo};
use crate::claude_quota::Quota;
use crate::codex_accounts::CodexLogin;
use crate::relay::Relay;
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::Path;
use std::sync::Mutex;
use std::time::{Duration, Instant};

const ENTRY_TTL: Duration = Duration::from_secs(15 * 60);

/// 待處理的遠端指令：編號 → (email, 取走時間)。只有 `acct_remote_pending` 會放進來。
static TAKEN: Mutex<Option<HashMap<String, (String, Instant)>>> = Mutex::new(None);

/// TAKEN 每筆指令的附註：編號 → (發起端, 後端是否標了本人簽章)。只有 `pending` 依後端回的 signed=true 標成簽章；
/// 編號處理掉（切換、拒絕）就一起拿掉，過期的在 `with_taken` 清（只留還在 TAKEN 裡的）。
static META: Mutex<Option<HashMap<String, (String, bool)>>> = Mutex::new(None);
/// TAKEN 每筆指令是哪個廠商的：編號 → "claude" 或 "grok"（沒記就是 claude）。跟 META 一起在處理掉、過期時清掉。
static VENDORS: Mutex<Option<HashMap<String, String>>> = Mutex::new(None);
/// 這次執行是否已經把上次沒處理完的指令（存在 acct-taken.json）讀回來
static RESTORED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

fn is_uuid(s: &str) -> bool {
    let p: Vec<&str> = s.split('-').collect();
    p.len() == 5 && p.iter().zip([8, 4, 4, 4, 12]).all(|(x, n)| x.len() == n && x.chars().all(|c| c.is_ascii_hexdigit()))
}
pub fn valid_node(s: &str) -> bool {
    (1..=32).contains(&s.len()) && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

/// 回報的內容：只有廠商、email、方案、是否使用中。
/// Codex 只放「目前登入」那一個（用 ChatGPT 帳號登入且有 email 才放；API 金鑰模式沒有帳號可顯示就不放）；
/// 權杖、金鑰、帳號編號一律不碰：`CodexLogin` 本身就只有 email／方案／登入方式三個欄位。
pub fn build_report(list: &[AccountInfo], codex: Option<&CodexLogin>) -> Value {
    build_report_with_quota(list, codex, &HashMap::new())
}

/// 同上，另外對「有額度紀錄」的 Claude 帳號帶上額度四欄（five_hour_pct、weekly_pct、reset_at、at，沒有的不帶；全部選填）。
/// 額度只來自 `claude_quota` 記下的數字；沒有紀錄的帳號不帶任何額度欄位，由介面顯示「額度未知」。Codex 不帶額度。
pub fn build_report_with_quota(list: &[AccountInfo], codex: Option<&CodexLogin>, quotas: &HashMap<String, Quota>) -> Value {
    build_report_full(list, codex, quotas, &[])
}

/// 同上，再加 Grok 帳號庫（只有 email、是否使用中；沒有方案與額度）。總共最多 20 筆：Claude 14、Grok 5、Codex 1。
pub fn build_report_full(list: &[AccountInfo], codex: Option<&CodexLogin>, quotas: &HashMap<String, Quota>, grok: &[crate::grok_accounts::GrokAccount]) -> Value {
    build_report_windows(list, codex, quotas, grok, &[])
}

/// 同上，再帶額度窗 `windows`（#374，格式同後台 parseWindows：`{ name, left_pct, resets_at, read_at }`）：
/// - Claude：有額度紀錄的帳號同時帶舊四欄與 `windows`（舊後台丟掉 windows，不壞）。
/// - Codex：`codex_windows` 是呼叫端已確認「跟目前登入的帳號對得上」的額度窗（見 codex_quota.rs）；空的就不帶。
/// - Grok：不帶額度。筆數上限跟以前一樣。
pub fn build_report_windows(list: &[AccountInfo], codex: Option<&CodexLogin>, quotas: &HashMap<String, Quota>, grok: &[crate::grok_accounts::GrokAccount], codex_windows: &[Value]) -> Value {
    build_report_all(list, codex, quotas, grok, codex_windows, &[])
}

/// 同上，再加 Gemini（#374 第二張）：`gemini` 是 gemini_quota::report_rows 組好的列（最多 5 個，最近讀到的是使用中）。
/// Gemini 佔的名額從 Claude 那邊扣，總數仍不超過 20。
pub fn build_report_all(list: &[AccountInfo], codex: Option<&CodexLogin>, quotas: &HashMap<String, Quota>, grok: &[crate::grok_accounts::GrokAccount], codex_windows: &[Value], gemini: &[Value]) -> Value {
    let gemini = &gemini[..gemini.len().min(crate::gemini_quota::MAX_REPORT)];
    let claude_max = if grok.is_empty() { 19 } else { 14 } - gemini.len();
    let mut rows: Vec<Value> = list
        .iter()
        .take(claude_max)
        .map(|a| {
            let mut row = json!({ "vendor": "claude", "email": a.email, "plan": a.plan, "current": a.current });
            // 存的登入不完整（沒有 refreshToken）只帶這個布林；正常的帳號不多帶欄位
            if a.login_incomplete {
                row["login_incomplete"] = json!(true);
            }
            if let (Some(q), Some(o)) = (quotas.get(&a.email), row.as_object_mut()) {
                if let Some(v) = q.five_hour_pct {
                    o.insert("five_hour_pct".into(), json!(v));
                }
                if let Some(v) = q.weekly_pct {
                    o.insert("weekly_pct".into(), json!(v));
                }
                if let Some(v) = &q.reset_at {
                    o.insert("reset_at".into(), json!(v));
                }
                o.insert("at".into(), json!(q.at));
                // 兩條各自的重置時間（#374，給舊表 relay.asn_accounts 用）：只送檔案裡記著的，舊檔沒有就不送，不從 reset_at 猜
                for (k, v, pct) in [("five_reset_at", &q.five_reset_at, q.five_hour_pct), ("week_reset_at", &q.week_reset_at, q.weekly_pct)] {
                    if let (Some(v), Some(_)) = (v, pct) {
                        o.insert(k.into(), json!(v));
                    }
                }
                let w = q.windows();
                if !w.is_empty() {
                    o.insert("windows".into(), json!(w));
                }
            }
            row
        })
        .collect();
    if let Some(c) = codex.filter(|c| c.mode == "chatgpt") {
        if let Some(email) = claude_accounts::normalize_email(&c.email) {
            let plan: String = c.plan.chars().filter(|ch| !ch.is_control()).take(30).collect();
            let mut row = json!({ "vendor": "codex", "email": email, "plan": plan, "current": true });
            if !codex_windows.is_empty() {
                row["windows"] = json!(codex_windows.iter().take(4).collect::<Vec<_>>());
            }
            rows.push(row);
        }
    }
    for g in grok.iter().take(5) {
        rows.push(json!({ "vendor": "grok", "email": g.email, "plan": "", "current": g.current }));
    }
    rows.extend(gemini.iter().cloned());
    json!({ "accounts": rows })
}

/// 回報要依序試的內容（#1529）：先送完整的；被後台以 HTTP 400 退回時（其他錯誤不退步，見 [`send_attempts`]）
/// 1. 有 gemini：拿掉 gemini 再送（還沒部署 #542 的 relay 看到 gemini 會整份退回，不能因此連 Claude／Codex／Grok 都送不上）；
/// 2. 有 codex 或 grok：只送 Claude（更舊的後台只認 claude）。
pub fn report_attempts(list: &[AccountInfo], codex: Option<&CodexLogin>, quotas: &HashMap<String, Quota>, grok: &[crate::grok_accounts::GrokAccount], codex_windows: &[Value], gemini: &[Value]) -> Vec<Value> {
    let full = build_report_all(list, codex, quotas, grok, codex_windows, gemini);
    let has = |v: &Value, vendors: &[&str]| v["accounts"].as_array().is_some_and(|a| a.iter().any(|r| vendors.iter().any(|x| r["vendor"] == *x)));
    let mut out = vec![];
    if has(&full, &["gemini"]) {
        out.push(full.clone());
    }
    let no_gemini = build_report_windows(list, codex, quotas, grok, codex_windows);
    let older = has(&no_gemini, &["codex", "grok"]);
    out.push(no_gemini);
    if older {
        out.push(build_report_with_quota(list, None, quotas));
    }
    out
}

/// 錯誤字串形如「acct_report HTTP 400 bad_request」：只有 400（後台看不懂這份內容）才值得拿掉廠牌再送
fn is_bad_request(err: &str) -> bool {
    err.split_whitespace().collect::<Vec<_>>().windows(2).any(|w| w == ["HTTP", "400"])
}

fn report_vendors(v: &Value) -> Vec<String> {
    let mut out: Vec<String> = vec![];
    for r in v["accounts"].as_array().into_iter().flatten() {
        if let Some(x) = r["vendor"].as_str().filter(|x| !out.iter().any(|o| o == x)) {
            out.push(x.to_string());
        }
    }
    out
}

/// 依序送 attempts，第一個成功的就停。**只有後台回 400 才退一步**送下一份；
/// 網路錯、5xx、401 等直接回那個錯誤（換內容也沒用，不連送）。每退一步呼叫 log 一次：拿掉哪些廠牌、原因。
pub async fn send_attempts<F, Fut>(attempts: Vec<Value>, mut send: F, mut log: impl FnMut(String)) -> Result<Value, String>
where
    F: FnMut(Value) -> Fut,
    Fut: std::future::Future<Output = Result<Value, String>>,
{
    let mut last = Err("沒有可回報的內容".to_string());
    let mut it = attempts.into_iter().peekable();
    while let Some(a) = it.next() {
        let before = report_vendors(&a);
        last = send(a).await;
        let Err(e) = &last else { break };
        if !is_bad_request(e) {
            break;
        }
        let Some(next) = it.peek() else { break };
        let after = report_vendors(next);
        let dropped: Vec<&str> = before.iter().filter(|v| !after.contains(v)).map(String::as_str).collect();
        log(format!("帳號回報被後台退回（HTTP 400：{e}），拿掉 {} 再送", dropped.join("、")));
    }
    last
}

/// 設定：remote_trust_own＝信任自己的設備，不用本機確認（預設 false）
pub fn prefs_path(data_dir: &Path) -> std::path::PathBuf {
    data_dir.join("acct-prefs.json")
}
fn pref_bool(data_dir: &Path, key: &str, default: bool) -> bool {
    std::fs::read_to_string(prefs_path(data_dir)).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok()).and_then(|v| v.get(key).and_then(Value::as_bool)).unwrap_or(default)
}
/// 寫一個設定：保留檔裡其他設定（檔壞掉就從空的開始）
fn set_pref(data_dir: &Path, key: &str, on: bool) -> Result<(), String> {
    let mut v = std::fs::read_to_string(prefs_path(data_dir)).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok()).filter(Value::is_object).unwrap_or_else(|| json!({}));
    v[key] = json!(on);
    crate::write_atomic(&prefs_path(data_dir), &v.to_string()).map_err(|e| e.to_string())
}
pub fn trust_own(data_dir: &Path) -> bool {
    pref_bool(data_dir, "remote_trust_own", false)
}
pub fn set_trust_own(data_dir: &Path, on: bool) -> Result<(), String> {
    set_pref(data_dir, "remote_trust_own", on)
}
/// 設定：remote_trust_signed＝後端標了「本人簽章」的指令（手機上用本人帳號發出）不用在本機確認（預設 true，可關）。
/// 沒簽章、簽章不成立的指令不受這項影響，一律照舊要本機確認。
pub fn trust_signed(data_dir: &Path) -> bool {
    pref_bool(data_dir, "remote_trust_signed", true)
}
pub fn set_trust_signed(data_dir: &Path, on: bool) -> Result<(), String> {
    set_pref(data_dir, "remote_trust_signed", on)
}

/// 設定：remote_allow_switch＝「允許切換帳號」（#371，取代上面兩個勾）。不允許＝別台送來的切換一律拒絕；
/// 允許＝本人簽章的直接套用（每小時上限照舊），沒簽章的照舊要在這台按確認（自己的設備要不要互信是 #300，還沒定）。
/// 還沒存過新設定時從舊的兩個換算：只要有一個是開的就算允許（remote_trust_signed 預設開，所以預設允許）。
/// 舊的 remote_trust_own 不再顯示，原本勾了的人照舊連沒簽章的也免確認，不改變他已經選好的信任範圍。
pub fn allow_switch(data_dir: &Path) -> bool {
    let stored = std::fs::read_to_string(prefs_path(data_dir)).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok()).and_then(|v| v.get("remote_allow_switch").and_then(Value::as_bool));
    stored.unwrap_or_else(|| trust_own(data_dir) || trust_signed(data_dir))
}
pub fn set_allow_switch(data_dir: &Path, on: bool) -> Result<(), String> {
    set_pref(data_dir, "remote_allow_switch", on)
}
/// 不允許切換帳號時回給發起端的原因
pub const NOT_ALLOWED: &str = "這台沒有允許切換帳號";

/// 這個指令要不要在本機按確認：信任自己的設備，或（信任簽章且這筆指令後端標了簽章）就不用
pub fn needs_confirm(trust_own: bool, trust_signed: bool, signed: bool) -> bool {
    !(trust_own || (trust_signed && signed))
}

/// 對方送來的待辦一列：編號、email、發起端節點。格式不對回錯誤原因。
#[derive(Serialize, Debug, PartialEq, Clone)]
pub struct Pending {
    pub id: String,
    pub email: String,
    pub requested_by: String,
    pub needs_confirm: bool,
    /// 要切換哪個廠商的帳號："claude" 或 "grok"
    pub vendor: String,
}
pub fn parse_pending(row: &Value) -> Result<(String, String, String), String> {
    let id = row.get("id").and_then(Value::as_str).filter(|s| is_uuid(s)).ok_or("指令編號不對")?;
    let by = row.get("requested_by").and_then(Value::as_str).filter(|s| valid_node(s)).ok_or("發起端不對")?;
    if !matches!(row.get("vendor").and_then(Value::as_str), Some("claude" | "grok")) {
        return Err("目前只支援切換 Claude、Grok 帳號".into());
    }
    let email = row.get("email").and_then(Value::as_str).and_then(claude_accounts::normalize_email).ok_or("email 格式不對")?;
    Ok((id.to_string(), email, by.to_string()))
}

fn with_taken<T>(f: impl FnOnce(&mut HashMap<String, (String, Instant)>) -> T) -> T {
    let mut g = TAKEN.lock().unwrap_or_else(|e| e.into_inner());
    let m = g.get_or_insert_with(HashMap::new);
    m.retain(|_, (_, t)| t.elapsed() < ENTRY_TTL);
    let r = f(m);
    let mut mg = META.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(meta) = mg.as_mut() {
        meta.retain(|id, _| m.contains_key(id));
    }
    if let Some(v) = VENDORS.lock().unwrap_or_else(|e| e.into_inner()).as_mut() {
        v.retain(|id, _| m.contains_key(id));
    }
    r
}

fn set_vendor(id: &str, vendor: &str) {
    VENDORS.lock().unwrap_or_else(|e| e.into_inner()).get_or_insert_with(HashMap::new).insert(id.to_string(), vendor.to_string());
}
fn vendor_of(id: &str) -> String {
    VENDORS.lock().unwrap_or_else(|e| e.into_inner()).as_ref().and_then(|m| m.get(id)).cloned().unwrap_or_else(|| "claude".into())
}
/// 後端回的 vendor 只認 claude 或 grok，其餘（包含缺欄位）一律當 claude 之前就被 parse_pending 擋掉了
fn row_vendor(row: &Value) -> &'static str {
    if row.get("vendor").and_then(Value::as_str) == Some("grok") { "grok" } else { "claude" }
}

fn set_meta(id: &str, by: &str, signed: bool) {
    META.lock().unwrap_or_else(|e| e.into_inner()).get_or_insert_with(HashMap::new).insert(id.to_string(), (by.to_string(), signed));
}
fn is_signed(id: &str) -> bool {
    META.lock().unwrap_or_else(|e| e.into_inner()).as_ref().and_then(|m| m.get(id)).is_some_and(|(_, signed)| *signed)
}

// ---------- 本機日誌、自動切換頻率上限、待辦存檔 ----------
/// 同一小時內，靠「本人簽章」免確認的切換最多這麼多次；超過的照舊要在本機按確認（設定「信任自己的設備」不受這個限制）
const AUTO_MAX_PER_HOUR: usize = 3;
const AUTO_WINDOW_MS: u64 = 60 * 60 * 1000;
const LOG_MAX_BYTES: u64 = 200 * 1024;

fn log_path(data_dir: &Path) -> std::path::PathBuf {
    data_dir.join("acct-remote.log")
}
/// 本機日誌：一行一件事（時間毫秒、事件、編號、發起端、email…）。只放編號與 email，沒有任何權杖。
/// 超過 200 KB 就只留後半，寫不進去也不影響切換。
fn log_event(data_dir: &Path, event: &str, id: &str, detail: &str) {
    use std::io::Write;
    let line = format!("{}\t{}\t{}\t{}\n", crate::heartbeat::now_ms(), event, id, detail.replace(['\n', '\r', '\t'], " "));
    let p = log_path(data_dir);
    if std::fs::metadata(&p).map(|m| m.len() > LOG_MAX_BYTES).unwrap_or(false) {
        if let Ok(t) = std::fs::read_to_string(&p) {
            // 從中間往後找第一個換行再切：用位元組找（換行一定在字元邊界上；以前切在中文字中間會把整個日誌清空）
            let mid = t.len() / 2;
            let keep = t.as_bytes()[mid..].iter().position(|&b| b == b'\n').map(|i| &t[mid + i + 1..]).unwrap_or("");
            let _ = std::fs::write(&p, keep);
        }
    }
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&p) {
        let _ = f.write_all(line.as_bytes());
    }
}

fn auto_path(data_dir: &Path) -> std::path::PathBuf {
    data_dir.join("acct-auto.json")
}
fn auto_times(data_dir: &Path, now_ms: u64) -> Vec<u64> {
    std::fs::read_to_string(auto_path(data_dir)).ok().and_then(|t| serde_json::from_str::<Vec<u64>>(&t).ok()).unwrap_or_default().into_iter().filter(|t| now_ms.saturating_sub(*t) < AUTO_WINDOW_MS).collect()
}
/// 現在還能不能再靠簽章免確認切換
pub fn auto_allowed(data_dir: &Path, now_ms: u64) -> bool {
    auto_times(data_dir, now_ms).len() < AUTO_MAX_PER_HOUR
}
fn auto_record(data_dir: &Path, now_ms: u64) {
    let mut t = auto_times(data_dir, now_ms);
    t.push(now_ms);
    let _ = crate::write_atomic(&auto_path(data_dir), &serde_json::to_string(&t).unwrap_or_default());
}

fn taken_path(data_dir: &Path) -> std::path::PathBuf {
    data_dir.join("acct-taken.json")
}
/// 把還沒處理的指令存檔：[{ id, email, by, signed, at（取走的時間，毫秒）}]。重啟後讀回來，才不會在「取走」與「按確定」之間重啟就找不到。
fn taken_persist(data_dir: &Path) {
    let now = crate::heartbeat::now_ms();
    let rows: Vec<Value> = with_taken(|m| {
        let meta = META.lock().unwrap_or_else(|e| e.into_inner());
        m.iter()
            .map(|(id, (email, t))| {
                let (by, signed) = meta.as_ref().and_then(|x| x.get(id)).cloned().unwrap_or_default();
                json!({ "id": id, "email": email, "by": by, "signed": signed, "vendor": vendor_of(id), "at": now.saturating_sub(t.elapsed().as_millis() as u64) })
            })
            .collect()
    });
    if rows.is_empty() {
        let _ = std::fs::remove_file(taken_path(data_dir));
    } else {
        let _ = crate::write_atomic(&taken_path(data_dir), &Value::Array(rows).to_string());
    }
}
/// 把存檔讀回記憶體（只收格式對、沒過期的），回傳讀回來的（編號, email, 發起端, 是否簽章）。已經在記憶體裡的編號不動。
fn taken_restore(data_dir: &Path) -> Vec<(String, String, String, bool)> {
    let now = crate::heartbeat::now_ms();
    let rows = std::fs::read_to_string(taken_path(data_dir)).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok()).and_then(|v| v.as_array().cloned()).unwrap_or_default();
    let mut out = vec![];
    for r in rows {
        let (Some(id), Some(email), Some(by), at) = (r.get("id").and_then(Value::as_str), r.get("email").and_then(Value::as_str), r.get("by").and_then(Value::as_str), r.get("at").and_then(Value::as_u64)) else { continue };
        let age = Duration::from_millis(now.saturating_sub(at.unwrap_or(0)));
        let Some(email) = claude_accounts::normalize_email(email) else { continue };
        if !is_uuid(id) || !valid_node(by) || age >= ENTRY_TTL {
            continue;
        }
        let signed = r.get("signed").and_then(Value::as_bool) == Some(true);
        let fresh = with_taken(|m| {
            if m.contains_key(id) {
                return false;
            }
            m.insert(id.to_string(), (email.clone(), Instant::now().checked_sub(age).unwrap_or_else(Instant::now)));
            true
        });
        if fresh {
            set_meta(id, by, signed);
            set_vendor(id, if r.get("vendor").and_then(Value::as_str) == Some("grok") { "grok" } else { "claude" });
            out.push((id.to_string(), email, by.to_string(), signed));
        }
    }
    out
}

/// 決定一筆指令：取出（每個編號只處理一次）→ 沒確認就拒絕 → 在本機切換。回傳（結果狀態, 說明）；沒有這個編號回 None。
/// `switch` 由呼叫端注入（正式是 `claude_accounts::local_switch`），測試用假的。
pub fn decide(taken: &mut HashMap<String, (String, Instant)>, id: &str, allowed: bool, switch: impl FnOnce(&str) -> Result<String, String>) -> Option<(&'static str, String)> {
    let (email, _) = taken.remove(id)?;
    if !allowed {
        return Some(("denied", "對方電腦上的使用者沒有同意".into()));
    }
    Some(match switch(&email) {
        Ok(notice) => ("ok", notice),
        Err(e) => ("failed", e),
    })
}

// ---------- 送給收發室的動作 ----------
/// 被退回（HTTP 400）時的退路見 [`report_attempts`]：拿掉 gemini 再送，再不行只送 Claude；其他錯誤不退步
pub async fn report(relay: &Relay, list: &[AccountInfo], codex: Option<&CodexLogin>, quotas: &HashMap<String, Quota>, grok: &[crate::grok_accounts::GrokAccount], codex_windows: &[Value], gemini: &[Value]) -> Result<Value, String> {
    let attempts = report_attempts(list, codex, quotas, grok, codex_windows, gemini);
    send_attempts(attempts, |body| relay.api("acct_report", Some(body)), |line| eprintln!("{line}")).await
}
/// 有登入就帶本人簽章（#380：成員角色的電腦不帶會被後台擋 403）；沒登入照舊不帶
pub async fn remote_list(relay: &Relay, node: &str, token: Option<&str>) -> Result<Value, String> {
    if !valid_node(node) {
        return Err("設備代號不對".into());
    }
    relay.api_signed("acct_list", Some(json!({ "node": node })), token).await
}
pub async fn remote_request(relay: &Relay, node: &str, email: &str, vendor: &str) -> Result<Value, String> {
    if !valid_node(node) {
        return Err("設備代號不對".into());
    }
    if vendor != "claude" && vendor != "grok" {
        return Err("目前只支援切換 Claude、Grok 帳號".into());
    }
    let email = claude_accounts::normalize_email(email).ok_or("email 格式不對")?;
    relay.api("acct_switch", Some(json!({ "node": node, "vendor": vendor, "email": email }))).await
}
pub async fn remote_status(relay: &Relay, ids: Vec<String>) -> Result<Value, String> {
    if ids.is_empty() || ids.len() > 20 || !ids.iter().all(|i| is_uuid(i)) {
        return Err("指令編號不對".into());
    }
    relay.api("acct_switch_status", Some(json!({ "ids": ids }))).await
}

// ---------- 回報結果：失敗要重試，重試仍失敗就存檔、之後補報 ----------
// 以前回報失敗只 eprintln：本機明明已經切好了，後端狀態卻停在 taken，手機一直顯示「等使用者按確認」（#300）。
const RESULT_RETRY_DELAYS_MS: [u64; 2] = [1000, 3000];
const OUTBOX_MAX: usize = 20;
/// 待補報的結果超過這麼久就丟掉：後端把 taken 超過 10 分鐘的指令標成失敗，之後再補報也只會被拒
const OUTBOX_MAX_AGE_MS: u64 = 60 * 60 * 1000;

/// 一次回報的結果：送達／被後端明確拒絕（不會因為再試而改變，不重試也不存檔）／暫時失敗（網路、5xx，值得再試）
#[derive(Debug, PartialEq, Clone, Copy)]
enum ResultSend {
    Sent,
    Rejected,
    Temporary,
}
/// 錯誤字串形如「acct_switch_result HTTP 404 not_found」：400／404／409 是後端明確拒絕（指令過期、已結案、格式不對），其餘（沒有狀態碼的網路錯誤、5xx…）當暫時失敗
fn classify_send_error(err: &str) -> ResultSend {
    if ["HTTP 400", "HTTP 404", "HTTP 409"].iter().any(|c| err.contains(c)) {
        ResultSend::Rejected
    } else {
        ResultSend::Temporary
    }
}

fn outbox_path(data_dir: &Path) -> std::path::PathBuf {
    data_dir.join("acct-switch-outbox.json")
}
/// 還沒送達的結果：[{ id, status, detail, at（存進來的時間，毫秒）}]
fn outbox_read(data_dir: &Path) -> Vec<Value> {
    std::fs::read_to_string(outbox_path(data_dir)).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok()).and_then(|v| v.as_array().cloned()).unwrap_or_default()
}
fn outbox_write(data_dir: &Path, rows: &[Value]) {
    if rows.is_empty() {
        let _ = std::fs::remove_file(outbox_path(data_dir));
    } else {
        let _ = crate::write_atomic(&outbox_path(data_dir), &Value::Array(rows.to_vec()).to_string());
    }
}
/// 放進待補報：同編號只留最新一筆，最多 OUTBOX_MAX 筆（超過丟最舊的）
fn outbox_push(data_dir: &Path, id: &str, status: &str, detail: &str, at_ms: u64) {
    let mut rows = outbox_read(data_dir);
    rows.retain(|r| r.get("id").and_then(Value::as_str) != Some(id));
    rows.push(json!({ "id": id, "status": status, "detail": detail, "at": at_ms }));
    while rows.len() > OUTBOX_MAX {
        rows.remove(0);
    }
    outbox_write(data_dir, &rows);
}

/// 試著送出：送達或被後端明確拒絕就停；暫時失敗就依序等 delays 再試，全失敗回 Temporary。`sleep` 與送出都由呼叫端注入（測試用）。
async fn send_with_retry<F, Fut, S, SFut>(mut try_send: F, delays: &[Duration], mut sleep: S) -> ResultSend
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = ResultSend>,
    S: FnMut(Duration) -> SFut,
    SFut: std::future::Future<Output = ()>,
{
    let mut last = try_send().await;
    for d in delays {
        if last != ResultSend::Temporary {
            return last;
        }
        sleep(*d).await;
        last = try_send().await;
    }
    last
}

async fn post_result(relay: &Relay, id: &str, status: &str, detail: &str) -> ResultSend {
    match relay.api("acct_switch_result", Some(json!({ "id": id, "status": status, "detail": detail }))).await {
        Ok(_) => ResultSend::Sent,
        Err(e) => {
            eprintln!("acct_switch_result failed: {e}");
            classify_send_error(&e)
        }
    }
}

async fn send_result(relay: &Relay, data_dir: &Path, id: &str, status: &str, detail: &str) {
    let d: String = detail.chars().filter(|c| !c.is_control()).take(300).collect();
    let delays: Vec<Duration> = RESULT_RETRY_DELAYS_MS.iter().map(|ms| Duration::from_millis(*ms)).collect();
    let r = send_with_retry(|| post_result(relay, id, status, &d), &delays, |d| tokio::time::sleep(d)).await;
    if r == ResultSend::Temporary {
        outbox_push(data_dir, id, status, &d, crate::heartbeat::now_ms());
    }
}

/// 補報：逐筆送出。送達或被後端明確拒絕（指令已過期／已結案）的拿掉；暫時失敗的留著；存太久（超過 OUTBOX_MAX_AGE_MS）的直接丟。
/// 回傳留下來的列。`post` 由呼叫端注入（測試用）。
async fn flush_rows<F, Fut>(rows: Vec<Value>, now_ms: u64, mut post: F) -> Vec<Value>
where
    F: FnMut(String, String, String) -> Fut,
    Fut: std::future::Future<Output = ResultSend>,
{
    let mut left = vec![];
    for r in rows {
        let (Some(id), Some(status)) = (r.get("id").and_then(Value::as_str), r.get("status").and_then(Value::as_str)) else { continue };
        let at = r.get("at").and_then(Value::as_u64).unwrap_or(0);
        if now_ms.saturating_sub(at) > OUTBOX_MAX_AGE_MS {
            continue;
        }
        let detail = r.get("detail").and_then(Value::as_str).unwrap_or("");
        if post(id.to_string(), status.to_string(), detail.to_string()).await == ResultSend::Temporary {
            left.push(r.clone());
        }
    }
    left
}

/// 把之前沒送達的結果再送一次（每次取走指令前呼叫）
pub async fn flush_outbox(relay: &Relay, data_dir: &Path) {
    let rows = outbox_read(data_dir);
    if rows.is_empty() {
        return;
    }
    let left = flush_rows(rows, crate::heartbeat::now_ms(), |id, status, detail| async move { post_result(relay, &id, &status, &detail).await }).await;
    outbox_write(data_dir, &left);
}

/// 取走自己的待辦。格式不對的當場回報失敗；合格的記進 TAKEN（之後只能憑編號處理）。
pub async fn pending(relay: &Relay, data_dir: &Path) -> Result<Vec<Pending>, String> {
    flush_outbox(relay, data_dir).await;   // 之前沒送達的結果先補報
    let v = relay.api("acct_switch_pending", Some(json!({}))).await?;
    // 沒允許切換帳號（#371）：別台送來的一律拒絕、不交給畫面
    let allow = allow_switch(data_dir);
    // 簽章免確認要再看頻率：同一小時內已經自動切太多次，後面的改成要確認
    let (own, signed_ok) = (allow && trust_own(data_dir), allow && auto_allowed(data_dir, crate::heartbeat::now_ms()));
    let mut out = vec![];
    // 上次重啟前取走、還沒處理的指令：第一次輪詢時讀回來，重新交給畫面（後端那邊已是 taken，不會再發第二次）
    if !RESTORED.swap(true, std::sync::atomic::Ordering::SeqCst) {
        for (id, email, by, signed) in taken_restore(data_dir) {
            log_event(data_dir, "restored", &id, &format!("{by} {email}"));
            if !allow {
                refuse(relay, data_dir, &id).await;
                continue;
            }
            let vendor = vendor_of(&id);
            out.push(Pending { id, email, requested_by: by, needs_confirm: needs_confirm(own, signed_ok, signed), vendor });
        }
    }
    for row in v.get("requests").and_then(Value::as_array).cloned().unwrap_or_default() {
        match parse_pending(&row) {
            Ok((id, email, by)) => {
                // 只認後端明確回 signed=true（布林）；沒有欄位、別的型別一律當沒簽章
                let signed = row.get("signed").and_then(Value::as_bool) == Some(true);
                with_taken(|m| m.insert(id.clone(), (email.clone(), Instant::now())));
                set_meta(&id, &by, signed);
                let vendor = row_vendor(&row).to_string();
                set_vendor(&id, &vendor);
                log_event(data_dir, "taken", &id, &format!("{by} {vendor} {email} signed={signed}"));
                if !allow {
                    refuse(relay, data_dir, &id).await;
                    continue;
                }
                out.push(Pending { id, email, requested_by: by, needs_confirm: needs_confirm(own, signed_ok, signed), vendor });
            }
            Err(why) => {
                if let Some(id) = row.get("id").and_then(Value::as_str).filter(|s| is_uuid(s)) {
                    log_event(data_dir, "invalid", id, &why);
                    send_result(relay, data_dir, id, "failed", &why).await;
                }
            }
        }
    }
    taken_persist(data_dir);
    Ok(out)
}

/// 使用者按了確認（或設定為信任自己的設備）：在本機切換並回報結果
pub async fn apply(relay: &Relay, data_dir: &Path, id: String, confirmed: bool) -> Result<Value, String> {
    // 依這筆指令的廠商換不同的帳號庫（Claude 與 Grok 各一套，都只在這台電腦上整檔搬）
    if vendor_of(&id) == "grok" {
        apply_with(relay, data_dir, id, confirmed, |e| crate::grok_accounts::local_switch(e).map(|o| o.notice)).await
    } else {
        apply_with(relay, data_dir, id, confirmed, |e| claude_accounts::local_switch(e).map(|o| o.notice)).await
    }
}

/// `switch` 由呼叫端注入：正式是本機切換，測試指到暫存家目錄
pub async fn apply_with(relay: &Relay, data_dir: &Path, id: String, confirmed: bool, switch: impl FnOnce(&str) -> Result<String, String> + Send + 'static) -> Result<Value, String> {
    let now = crate::heartbeat::now_ms();
    // 沒允許切換帳號（#371）：連本機按確認也不套用（畫面本來就收不到這種指令，這裡是最後一道關）
    let allow = allow_switch(data_dir);
    if !allow {
        if !with_taken(|m| m.contains_key(&id)) {
            return Err("找不到這個指令（已處理過或已過期）".into());
        }
        refuse(relay, data_dir, &id).await;
        return Err(NOT_ALLOWED.into());
    }
    let own = trust_own(data_dir);
    // 只靠簽章放行的（沒按確認、也不是舊設定的「信任自己的設備」）才算進頻率上限
    let by_signed = !confirmed && !own && is_signed(&id) && auto_allowed(data_dir, now);
    let allowed = confirmed || own || by_signed;
    if by_signed && with_taken(|m| m.contains_key(&id)) {
        auto_record(data_dir, now);
    }
    let res = {
        let id2 = id.clone();
        tokio::task::spawn_blocking(move || with_taken(|m| decide(m, &id2, allowed, switch))).await.map_err(|e| format!("背景工作失敗：{e}"))?
    };
    let Some((status, detail)) = res else { return Err("找不到這個指令（已處理過或已過期）".into()) };
    let how = if confirmed { "confirmed" } else if by_signed { "signed" } else if allowed { "trust_own" } else { "none" };
    log_event(data_dir, status, &id, &format!("{how} {detail}"));
    taken_persist(data_dir);
    send_result(relay, data_dir, &id, status, &detail).await;
    if status == "ok" {
        Ok(json!({ "status": status, "detail": detail }))
    } else {
        Err(detail)
    }
}

/// 這台沒有允許切換帳號（#371）：取走的指令直接拒絕，告訴發起端原因
async fn refuse(relay: &Relay, data_dir: &Path, id: &str) {
    with_taken(|m| m.remove(id));
    log_event(data_dir, "refused", id, NOT_ALLOWED);
    taken_persist(data_dir);
    send_result(relay, data_dir, id, "denied", NOT_ALLOWED).await;
}

/// 使用者按了拒絕
pub async fn decline(relay: &Relay, data_dir: &Path, id: String) -> Result<(), String> {
    let removed = with_taken(|m| m.remove(&id).is_some());
    if removed {
        log_event(data_dir, "declined", &id, "");
        taken_persist(data_dir);
        send_result(relay, data_dir, &id, "denied", "對方電腦上的使用者沒有同意").await;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const U: &str = "11111111-2222-3333-4444-555555555555";

    fn acct(email: &str, current: bool) -> AccountInfo {
        AccountInfo { email: email.into(), plan: "max".into(), org: "ORG-SECRET".into(), current, saved: true, login_incomplete: false }
    }

    #[test]
    fn 回報只有廠商_email_方案_使用中() {
        let v = build_report(&[acct("a@x.test", true), acct("b@x.test", false)], None);
        assert_eq!(v, json!({ "accounts": [
            { "vendor": "claude", "email": "a@x.test", "plan": "max", "current": true },
            { "vendor": "claude", "email": "b@x.test", "plan": "max", "current": false },
        ] }));
        assert!(!v.to_string().contains("ORG-SECRET"), "組織名稱不外送");
    }

    #[test]
    fn 回報帶_grok_帳號庫_只有_email_與是否使用中_且總數不超過二十筆() {
        use crate::grok_accounts::GrokAccount;
        let g = |e: &str, cur: bool| GrokAccount { email: e.into(), current: cur, saved: true };
        let v = build_report_full(&[acct("a@x.test", true)], None, &HashMap::new(), &[g("g1@x.test", true), g("g2@x.test", false)]);
        assert_eq!(v["accounts"][1], json!({ "vendor": "grok", "email": "g1@x.test", "plan": "", "current": true }));
        assert_eq!(v["accounts"][2]["vendor"], "grok");
        assert_eq!(build_report_with_quota(&[acct("a@x.test", true)], None, &HashMap::new()), build_report_full(&[acct("a@x.test", true)], None, &HashMap::new(), &[]), "沒有 Grok 就和以前一樣");
        let many: Vec<_> = (0..30).map(|i| acct(&format!("c{i}@x.test"), false)).collect();
        let gs: Vec<_> = (0..30).map(|i| g(&format!("g{i}@x.test"), false)).collect();
        let n = build_report_full(&many, Some(&codex("c@x.test", "plus", "chatgpt")), &HashMap::new(), &gs)["accounts"].as_array().unwrap().len();
        assert!(n <= 20, "後端上限 20 筆，實際 {n}");
        assert!(!v.to_string().contains("token") && !v.to_string().contains("key"));
    }

    fn quota(five: u8, week: u8) -> Quota {
        Quota {
            five_hour_pct: Some(five),
            weekly_pct: Some(week),
            reset_at: Some("2026-10-24T14:00:00Z".into()),
            at: "2026-10-24T12:00:00Z".into(),
            five_reset_at: Some("2026-10-24T14:00:00Z".into()),
            week_reset_at: Some("2026-10-30T00:00:00Z".into()),
            five_at: Some("2026-10-24T12:00:00Z".into()),
            week_at: Some("2026-10-24T11:00:00Z".into()),
        }
    }

    #[test]
    fn 回報_claude_同時帶舊四欄與額度窗_codex_帶對得上的額度窗_grok_不帶_總數不超過二十筆() {
        use crate::grok_accounts::GrokAccount;
        let qs: HashMap<String, Quota> = (0..30).map(|i| (format!("u{i}@x.test"), quota(40, 70))).collect();
        let many: Vec<_> = (0..30).map(|i| acct(&format!("u{i}@x.test"), i == 0)).collect();
        let gs: Vec<_> = (0..30).map(|i| GrokAccount { email: format!("g{i}@x.test"), current: false, saved: true }).collect();
        let cw = vec![json!({ "name": "five_hour", "left_pct": 95, "resets_at": "2026-10-24T14:00:00Z", "read_at": "2026-10-24T12:00:00Z" })];
        let v = build_report_windows(&many, Some(&codex("c@x.test", "plus", "chatgpt")), &qs, &gs, &cw);
        let rows = v["accounts"].as_array().unwrap();
        assert!(rows.len() <= 20, "後端上限 20 筆，實際 {}", rows.len());
        let first = &rows[0];
        for k in ["five_hour_pct", "weekly_pct", "reset_at", "at"] {
            assert!(first.get(k).is_some(), "舊四欄要照送：{k}");
        }
        assert_eq!((first["five_reset_at"].as_str(), first["week_reset_at"].as_str()), (Some("2026-10-24T14:00:00Z"), Some("2026-10-30T00:00:00Z")), "兩條各自的重置時間也送（舊表用，#374）");
        let mut old = quota(40, 70);
        old.five_reset_at = None;
        old.week_reset_at = None;
        let one = build_report_windows(&many[..1], None, &HashMap::from([("u0@x.test".to_string(), old)]), &[], &[]);
        assert!(one["accounts"][0].get("five_reset_at").is_none() && one["accounts"][0].get("week_reset_at").is_none(), "舊檔沒有就不送，不從舊的 reset_at 猜");
        assert_eq!(first["windows"], json!([
            { "name": "five_hour", "left_pct": 40, "resets_at": "2026-10-24T14:00:00Z", "read_at": "2026-10-24T12:00:00Z" },
            { "name": "weekly", "left_pct": 70, "resets_at": "2026-10-30T00:00:00Z", "read_at": "2026-10-24T11:00:00Z" },
        ]));
        let cx = rows.iter().find(|r| r["vendor"] == "codex").expect("要有 codex");
        assert_eq!(cx["windows"], json!(cw));
        assert!(cx.get("five_hour_pct").is_none(), "codex 不帶舊四欄");
        assert!(rows.iter().filter(|r| r["vendor"] == "grok").all(|r| r.get("windows").is_none()), "grok 不送額度");
        assert!(rows.iter().all(|r| r.get("windows").and_then(Value::as_array).map(|w| w.len()).unwrap_or(0) <= 4), "每筆最多 4 窗");
        // 沒有額度窗就跟以前一樣
        assert_eq!(build_report_windows(&many, Some(&codex("c@x.test", "plus", "chatgpt")), &HashMap::new(), &gs, &[]), build_report_full(&many, Some(&codex("c@x.test", "plus", "chatgpt")), &HashMap::new(), &gs));
    }

    fn gem(email: &str, current: bool) -> Value {
        json!({ "vendor": "gemini", "email": email, "plan": "Google AI Pro", "current": current,
                "windows": [{ "name": "weekly", "left_pct": 30, "resets_at": "2026-10-30T00:00:00Z", "read_at": "2026-10-24T12:00:00Z" }] })
    }

    #[test]
    fn 回報帶_gemini_佔的名額從_claude_扣_總數不超過二十筆() {
        use crate::grok_accounts::GrokAccount;
        let many: Vec<_> = (0..30).map(|i| acct(&format!("u{i}@x.test"), i == 0)).collect();
        let gs: Vec<_> = (0..30).map(|i| GrokAccount { email: format!("g{i}@x.test"), current: false, saved: true }).collect();
        let gems: Vec<_> = (0..9).map(|i| gem(&format!("m{i}@x.test"), i == 0)).collect();
        let none: Vec<GrokAccount> = vec![];
        for grok in [gs.as_slice(), none.as_slice()] {
            let v = build_report_all(&many, Some(&codex("c@x.test", "plus", "chatgpt")), &HashMap::new(), grok, &[], &gems);
            let rows = v["accounts"].as_array().unwrap();
            assert_eq!(rows.len(), 20, "剛好塞滿 20 筆");
            let g: Vec<_> = rows.iter().filter(|r| r["vendor"] == "gemini").collect();
            assert_eq!(g.len(), crate::gemini_quota::MAX_REPORT);
            assert_eq!(*g[0], gems[0], "gemini 的列原樣送出（含額度窗）");
            assert!(rows.iter().any(|r| r["vendor"] == "codex"));
        }
        assert_eq!(build_report_all(&many, None, &HashMap::new(), &gs, &[], &[]), build_report_full(&many, None, &HashMap::new(), &gs), "沒有 gemini 就跟以前一樣");
    }

    #[test]
    fn 回報退路_先拿掉_gemini_再送_還不行才只送_claude() {
        let list = [acct("a@x.test", true)];
        let cx = codex("c@x.test", "plus", "chatgpt");
        let at = report_attempts(&list, Some(&cx), &HashMap::new(), &[], &[], &[gem("m@x.test", true)]);
        let vendors = |v: &Value| v["accounts"].as_array().unwrap().iter().map(|r| r["vendor"].as_str().unwrap().to_string()).collect::<Vec<_>>();
        assert_eq!(at.iter().map(vendors).collect::<Vec<_>>(), vec![vec!["claude", "codex", "gemini"], vec!["claude", "codex"], vec!["claude"]]);
        // 沒有 gemini：跟以前一樣（有 codex 才多一個只送 Claude 的退路）
        assert_eq!(report_attempts(&list, Some(&cx), &HashMap::new(), &[], &[], &[]).iter().map(vendors).collect::<Vec<_>>(), vec![vec!["claude", "codex"], vec!["claude"]]);
        assert_eq!(report_attempts(&list, None, &HashMap::new(), &[], &[], &[]).len(), 1);
    }

    #[tokio::test]
    async fn 還沒部署的_relay_退回_gemini_時_claude_與_codex_照樣送上去() {
        let list = [acct("a@x.test", true)];
        let cx = codex("c@x.test", "plus", "chatgpt");
        let attempts = report_attempts(&list, Some(&cx), &HashMap::new(), &[], &[], &[gem("m@x.test", true)]);
        let sent = std::sync::Arc::new(Mutex::new(Vec::<Value>::new()));
        let s2 = sent.clone();
        let mut logs = vec![];
        // 模擬舊 relay：有 gemini 整份以 400 退回，其他照收
        let r = send_attempts(
            attempts,
            move |body| {
                let s2 = s2.clone();
                async move {
                    s2.lock().unwrap().push(body.clone());
                    if body.to_string().contains("\"gemini\"") {
                        Err("acct_report HTTP 400 bad_request".to_string())
                    } else {
                        Ok(json!({ "ok": true }))
                    }
                }
            },
            |l| logs.push(l),
        )
        .await;
        assert!(r.is_ok());
        let sent = sent.lock().unwrap();
        assert_eq!(sent.len(), 2, "只多送一次");
        let ok = &sent[1];
        assert!(ok["accounts"].as_array().unwrap().iter().any(|r| r["vendor"] == "codex"), "拿掉的只有 gemini，codex 不能跟著掉");
        assert!(ok["accounts"].as_array().unwrap().iter().any(|r| r["vendor"] == "claude"));
        assert_eq!(logs.len(), 1, "退一步記一行");
        assert!(logs[0].contains("400") && logs[0].contains("拿掉 gemini 再送"), "{logs:?}");
    }

    fn three_attempts() -> Vec<Value> {
        let list = [acct("a@x.test", true)];
        let cx = codex("c@x.test", "plus", "chatgpt");
        report_attempts(&list, Some(&cx), &HashMap::new(), &[], &[], &[gem("m@x.test", true)])
    }

    /// 每次都回同一個錯誤，回（送了幾次, log 行）
    async fn count_sends(err: &str) -> (usize, Vec<String>, Result<Value, String>) {
        let n = std::sync::Arc::new(Mutex::new(0usize));
        let n2 = n.clone();
        let err = err.to_string();
        let mut logs = vec![];
        let r = send_attempts(
            three_attempts(),
            move |_| {
                let (n2, err) = (n2.clone(), err.clone());
                async move {
                    *n2.lock().unwrap() += 1;
                    Err::<Value, String>(err)
                }
            },
            |l| logs.push(l),
        )
        .await;
        let sent = *n.lock().unwrap();
        (sent, logs, r)
    }

    #[tokio::test]
    async fn 一直回_400_才一路退到只送_claude_每步記拿掉的廠牌() {
        assert_eq!(three_attempts().len(), 3);
        let (sent, logs, r) = count_sends("acct_report HTTP 400 bad_request").await;
        assert_eq!(sent, 3);
        assert_eq!(r, Err("acct_report HTTP 400 bad_request".to_string()), "全部失敗回最後一個錯誤");
        assert_eq!(logs.len(), 2, "{logs:?}");
        assert!(logs[0].contains("拿掉 gemini 再送"), "{logs:?}");
        assert!(logs[1].contains("拿掉 codex 再送"), "{logs:?}");
        assert!(logs.iter().all(|l| l.contains("HTTP 400")));
    }

    #[tokio::test]
    async fn 網路錯_5xx_401_404_只送一次不退步() {
        for err in ["acct_report 連線失敗：timed out", "acct_report HTTP 500", "acct_report HTTP 503 unavailable", "acct_report HTTP 401 unauthorized", "acct_report HTTP 404 not_found", "acct_report HTTP 4001"] {
            let (sent, logs, r) = count_sends(err).await;
            assert_eq!(sent, 1, "{err}：不能換內容連送");
            assert!(logs.is_empty(), "{err}");
            assert_eq!(r, Err(err.to_string()));
        }
    }

    #[test]
    fn 回報_codex_額度窗只在帳號跟目前登入對得上才帶() {
        let d = tempfile::tempdir().unwrap();
        let now = 1_792_843_200_000_i64; // 2026-10-24T12:00:00Z
        let rl = json!({ "rateLimits": { "primary": { "usedPercent": 5, "windowDurationMins": 300, "resetsAt": 1_792_850_400 }, "secondary": { "usedPercent": 1, "windowDurationMins": 10080, "resetsAt": 1_793_000_000 } } });
        crate::codex_quota::save(d.path(), "me@x.test", &crate::codex_quota::windows_from_rate_limits(&rl, now), now).unwrap();
        let mine = crate::codex_quota::windows_for(d.path(), "me@x.test", now);
        let v = build_report_windows(&[], Some(&codex("me@x.test", "plus", "chatgpt")), &HashMap::new(), &[], &mine);
        assert_eq!(v["accounts"][0]["windows"][0]["left_pct"], 95, "用掉 5% 剩 95%");
        assert_eq!(v["accounts"][0]["windows"][1]["name"], "weekly");
        let other = crate::codex_quota::windows_for(d.path(), "other@x.test", now);
        let v = build_report_windows(&[], Some(&codex("other@x.test", "plus", "chatgpt")), &HashMap::new(), &[], &other);
        assert!(v["accounts"][0].get("windows").is_none(), "換了帳號：舊帳號的額度不帶");
    }

    #[test]
    fn 指令的廠商只認_claude_與_grok_其他一律拒絕() {
        let row = |v: &str| json!({ "id": U, "requested_by": "H", "vendor": v, "email": "b@x.test" });
        assert!(parse_pending(&row("claude")).is_ok() && parse_pending(&row("grok")).is_ok());
        for bad in ["codex", "gemini", "", "GROK", "claude "] {
            assert!(parse_pending(&row(bad)).is_err(), "{bad}");
        }
        assert_eq!(row_vendor(&row("grok")), "grok");
        assert_eq!(row_vendor(&row("claude")), "claude");
    }

    fn codex(email: &str, plan: &str, mode: &str) -> CodexLogin {
        CodexLogin { email: email.into(), plan: plan.into(), mode: mode.into() }
    }

    #[test]
    fn 回報帶_codex_目前登入_且不含任何憑證類欄位() {
        let v = build_report(&[acct("a@x.test", true)], Some(&codex(" C@X.test ", "plus", "chatgpt")));
        assert_eq!(v["accounts"][1], json!({ "vendor": "codex", "email": "c@x.test", "plan": "plus", "current": true }));
        // 守門：每一列的鍵只准是這四個；整份內容不出現 token／key／secret 類字樣
        for r in v["accounts"].as_array().unwrap() {
            let mut keys: Vec<&String> = r.as_object().unwrap().keys().collect();
            keys.sort();
            assert_eq!(keys, ["current", "email", "plan", "vendor"]);
        }
        let low = v.to_string().to_lowercase();
        for bad in ["token", "secret", "api_key", "apikey", "password", "refresh", "account_id", "mode"] {
            assert!(!low.contains(bad), "回報不該含 {bad}");
        }
    }

    #[test]
    fn codex_沒登入_或_api_金鑰模式_或_email_壞掉_就不放() {
        let base = build_report(&[acct("a@x.test", true)], None);
        assert_eq!(base["accounts"].as_array().unwrap().len(), 1);
        for c in [codex("", "", "api_key"), codex("c@x.test", "plus", "api_key"), codex("", "", "chatgpt"), codex("壞", "", "chatgpt")] {
            assert_eq!(build_report(&[acct("a@x.test", true)], Some(&c)), base);
        }
    }

    #[test]
    fn 合計不超過_20_筆_且_codex_方案字串被清乾淨() {
        let many: Vec<AccountInfo> = (0..25).map(|i| acct(&format!("u{i}@x.test"), i == 0)).collect();
        let v = build_report(&many, Some(&codex("c@x.test", &format!("p\nl{}", "x".repeat(40)), "chatgpt")));
        let rows = v["accounts"].as_array().unwrap();
        assert_eq!(rows.len(), 20);
        assert_eq!(rows[19]["vendor"], "codex");
        let plan = rows[19]["plan"].as_str().unwrap();
        assert!(plan.chars().count() <= 30 && !plan.contains('\n'));
    }

    #[test]
    fn 待辦格式檢查() {
        let ok = json!({ "id": U, "requested_by": "H", "vendor": "claude", "email": " B@X.test " });
        assert_eq!(parse_pending(&ok), Ok((U.into(), "b@x.test".into(), "H".into())));
        for bad in [
            json!({ "id": "x", "requested_by": "H", "vendor": "claude", "email": "b@x.test" }),
            json!({ "id": U, "requested_by": "H H", "vendor": "claude", "email": "b@x.test" }),
            json!({ "id": U, "requested_by": "H", "vendor": "codex", "email": "b@x.test" }),
            json!({ "id": U, "requested_by": "H", "vendor": "claude", "email": "../x" }),
            json!({ "id": U, "requested_by": "H", "vendor": "claude" }),
        ] {
            assert!(parse_pending(&bad).is_err(), "{bad}");
        }
    }

    fn taken_with(id: &str, email: &str) -> HashMap<String, (String, Instant)> {
        let mut m = HashMap::new();
        m.insert(id.to_string(), (email.to_string(), Instant::now()));
        m
    }

    #[test]
    fn 沒確認不切換_確認了才切_每個編號只處理一次() {
        let mut m = taken_with(U, "b@x.test");
        let mut called = vec![];
        let r = decide(&mut m, U, false, |e| {
            called.push(e.to_string());
            Ok("x".into())
        });
        assert_eq!(r, Some(("denied", "對方電腦上的使用者沒有同意".into())));
        assert!(called.is_empty(), "沒同意就不碰檔案");
        assert!(decide(&mut m, U, true, |_| Ok("x".into())).is_none(), "編號已用掉");

        let mut m = taken_with(U, "b@x.test");
        let r = decide(&mut m, U, true, |e| {
            called.push(e.to_string());
            Ok("切換好了".into())
        });
        assert_eq!(r, Some(("ok", "切換好了".into())));
        assert_eq!(called, vec!["b@x.test"]);
        assert!(decide(&mut m, U, true, |_| Ok("again".into())).is_none(), "不能重播");
    }

    #[test]
    fn 切換失敗回報原因() {
        let mut m = taken_with(U, "b@x.test");
        assert_eq!(decide(&mut m, U, true, |_| Err("找不到這個帳號".into())), Some(("failed", "找不到這個帳號".into())));
    }

    #[test]
    fn 遠端切到登入不完整的帳號_回報失敗原因_本機登入沒動() {
        let d = tempfile::tempdir().unwrap();
        let h = d.path().to_path_buf();
        let login = |uuid: &str, email: &str, cred: &str| {
            std::fs::create_dir_all(h.join(".claude")).unwrap();
            std::fs::write(h.join(".claude").join(".credentials.json"), cred).unwrap();
            std::fs::write(h.join(".claude.json"), format!(r#"{{"oauthAccount":{{"accountUuid":"{uuid}","emailAddress":"{email}"}}}}"#)).unwrap();
            claude_accounts::save_current(&h).unwrap();
        };
        login("u-b", "b@x.test", r#"{"claudeAiOauth":{"accessToken":"FAKE-ACCESS-B"}}"#);
        login("u-a", "a@x.test", r#"{"claudeAiOauth":{"accessToken":"FAKE-ACCESS-A","refreshToken":"FAKE-REFRESH-A"}}"#);
        let before = std::fs::read(h.join(".claude").join(".credentials.json")).unwrap();
        let mut m = taken_with(U, "b@x.test");
        // 跟正式的 claude_accounts::local_switch 一樣走 switch_to → switch_impl
        let r = decide(&mut m, U, true, |e| claude_accounts::switch_to(&h, e).map(|o| o.notice).map_err(|e| e.to_string()));
        assert_eq!(r, Some(("failed", claude_accounts::INCOMPLETE_LOGIN_MSG.to_string())));
        assert_eq!(std::fs::read(h.join(".claude").join(".credentials.json")).unwrap(), before);
    }

    #[test]
    fn 回報只對登入不完整的帳號多帶布林() {
        let mut bad = acct("b@x.test", false);
        bad.login_incomplete = true;
        let v = build_report(&[acct("a@x.test", true), bad], None);
        assert!(v["accounts"][0].get("login_incomplete").is_none(), "正常帳號不多帶欄位");
        assert_eq!(v["accounts"][1]["login_incomplete"], json!(true));
    }

    #[test]
    fn 沒取走過的編號不能憑空切換() {
        let mut m = HashMap::new();
        assert!(decide(&mut m, U, true, |_| panic!("不該被呼叫")).is_none());
    }

    #[test]
    fn 設定_預設需要確認_可改成信任自己() {
        let d = tempfile::tempdir().unwrap();
        assert!(!trust_own(d.path()));
        set_trust_own(d.path(), true).unwrap();
        assert!(trust_own(d.path()));
        set_trust_own(d.path(), false).unwrap();
        assert!(!trust_own(d.path()));
        std::fs::write(prefs_path(d.path()), "{壞掉").unwrap();
        assert!(!trust_own(d.path()), "壞掉就用預設（要確認）");
    }

    /// 本機假後端：依動作名回罐頭內容（pending 依序取），記下每個請求（只連 127.0.0.1）
    fn fake_server(pending: Vec<Value>) -> (String, std::sync::Arc<Mutex<Vec<String>>>) {
        use std::io::{Read, Write};
        let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://127.0.0.1:{}/relay", l.local_addr().unwrap().port());
        let seen = std::sync::Arc::new(Mutex::new(vec![]));
        let s2 = seen.clone();
        let q = std::sync::Arc::new(Mutex::new(std::collections::VecDeque::from(pending)));
        std::thread::spawn(move || {
            for c in l.incoming() {
                let Ok(mut c) = c else { break };
                let mut buf = vec![0u8; 16384];
                let n = c.read(&mut buf).unwrap_or(0);
                let req = String::from_utf8_lossy(&buf[..n]).to_string();
                let body = if req.starts_with("POST /relay?action=acct_switch_pending") {
                    json!({ "requests": q.lock().unwrap().pop_front().map(|r| vec![r]).unwrap_or_default() }).to_string()
                } else {
                    r#"{"ok":true}"#.to_string()
                };
                s2.lock().unwrap().push(req);
                let _ = write!(c, "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}", body.len());
            }
        });
        (url, seen)
    }
    fn login(home: &Path, uuid: &str, email: &str, tag: &str) {
        std::fs::create_dir_all(home.join(".claude")).unwrap();
        std::fs::write(home.join(".claude").join(".credentials.json"), format!(r#"{{"claudeAiOauth":{{"accessToken":"FAKE-{tag}","refreshToken":"FAKE-REFRESH-{tag}","subscriptionType":"max"}}}}"#)).unwrap();
        std::fs::write(home.join(".claude.json"), format!("{{\n  \"oauthAccount\": {{\n    \"accountUuid\": \"{uuid}\",\n    \"emailAddress\": \"{email}\"\n  }}\n}}\n")).unwrap();
    }

    #[tokio::test]
    async fn 端到端_取走待辦_沒同意不切_同意才切_回報結果_不能重播() {
        let home = tempfile::tempdir().unwrap();
        let data = tempfile::tempdir().unwrap();
        let h = home.path().to_path_buf();
        login(&h, "u-a", "a@x.test", "A");
        claude_accounts::save_current(&h).unwrap();
        login(&h, "u-b", "b@x.test", "B");
        claude_accounts::save_current(&h).unwrap();
        login(&h, "u-a", "a@x.test", "A2");
        let cred = |h: &Path| std::fs::read_to_string(h.join(".claude").join(".credentials.json")).unwrap();
        let before = cred(&h);

        let u2 = "22222222-2222-3333-4444-555555555555";
        let u3 = "33333333-2222-3333-4444-555555555555";
        let row = |id: &str, vendor: &str| json!({ "id": id, "requested_by": "H", "vendor": vendor, "email": "b@x.test" });
        let (url, seen) = fake_server(vec![row(U, "claude"), row(u2, "codex"), row(u3, "claude")]);
        let relay = Relay::new(url, "secret-key".into(), "W".into(), "W-ASN".into());
        let sw = |h: std::path::PathBuf| move |e: &str| claude_accounts::switch_to(&h, e).map(|o| o.notice).map_err(|e| e.to_string());

        // 1. 取走：合格的進待辦、要確認
        let p = pending(&relay, data.path()).await.unwrap();
        assert_eq!(p, vec![Pending { id: U.into(), email: "b@x.test".into(), requested_by: "H".into(), needs_confirm: true, vendor: "claude".into() }]);
        // 2. 沒同意：不碰檔案，回報 denied
        assert!(apply_with(&relay, data.path(), U.into(), false, sw(h.clone())).await.is_err());
        assert_eq!(cred(&h), before, "沒同意就不切");
        // 3. 格式不對（廠商不是 claude）的指令，當場回報失敗
        assert!(pending(&relay, data.path()).await.unwrap().is_empty());
        // 4. 同意：切換成功
        let p = pending(&relay, data.path()).await.unwrap();
        assert_eq!(p[0].id, u3);
        let ok = apply_with(&relay, data.path(), u3.into(), true, sw(h.clone())).await.unwrap();
        assert_eq!(ok["status"], "ok");
        assert!(cred(&h).contains("FAKE-B"), "已切到 b");
        // 5. 不能重播；沒取走過的編號也不行
        assert!(apply_with(&relay, data.path(), u3.into(), true, sw(h.clone())).await.is_err());
        assert!(apply_with(&relay, data.path(), U.into(), true, sw(h.clone())).await.is_err());

        let reqs = seen.lock().unwrap().clone();
        let results: Vec<&String> = reqs.iter().filter(|r| r.starts_with("POST /relay?action=acct_switch_result")).collect();
        assert_eq!(results.len(), 3, "denied、failed(格式不對)、ok 各回報一次");
        assert!(results[0].contains(r#""status":"denied""#) && results[0].contains(U));
        assert!(results[1].contains(r#""status":"failed""#) && results[1].contains(u2));
        assert!(results[2].contains(r#""status":"ok""#) && results[2].contains(u3));
        assert!(reqs.iter().all(|r| !r.contains("FAKE-")), "送出去的請求裡沒有任何權杖");
        assert!(reqs.iter().all(|r| r.to_lowercase().contains("x-relay-key: secret-key")));
    }

    #[tokio::test]
    async fn 信任自己的設備_不用確認也會切() {
        // 待辦表 TAKEN 是全域的，跟上一個測試平行跑時不能共用同一個編號（會被對方取走）
        const U4: &str = "44444444-2222-3333-4444-555555555555";
        let home = tempfile::tempdir().unwrap();
        let data = tempfile::tempdir().unwrap();
        let h = home.path().to_path_buf();
        login(&h, "u-a", "a@x.test", "A");
        claude_accounts::save_current(&h).unwrap();
        login(&h, "u-b", "b@x.test", "B");
        claude_accounts::save_current(&h).unwrap();
        login(&h, "u-a", "a@x.test", "A");
        set_trust_own(data.path(), true).unwrap();
        let (url, _seen) = fake_server(vec![json!({ "id": U4, "requested_by": "H", "vendor": "claude", "email": "b@x.test" })]);
        let relay = Relay::new(url, "k".into(), "W".into(), "W-ASN".into());
        let p = pending(&relay, data.path()).await.unwrap();
        assert!(!p[0].needs_confirm);
        let h2 = h.clone();
        apply_with(&relay, data.path(), U4.into(), false, move |e| claude_accounts::switch_to(&h2, e).map(|o| o.notice).map_err(|e| e.to_string())).await.unwrap();
        assert!(std::fs::read_to_string(h.join(".claude").join(".credentials.json")).unwrap().contains("FAKE-B"));
    }

    // ---- 同帳號簽章的指令不用在本機按確認（#300 第 1、2 項）----
    #[test]
    fn 要不要確認_只有信任自己或_信任簽章且指令有簽章_才免() {
        assert!(needs_confirm(false, false, false));
        assert!(needs_confirm(false, false, true), "信任簽章關掉：有簽章也要確認");
        assert!(needs_confirm(false, true, false), "沒簽章：照舊要確認");
        assert!(!needs_confirm(false, true, true));
        assert!(!needs_confirm(true, false, false), "信任自己的設備照舊");
    }

    #[test]
    fn 設定_信任簽章預設開_寫一項不會洗掉另一項_壞檔用預設() {
        let d = tempfile::tempdir().unwrap();
        assert!(trust_signed(d.path()) && !trust_own(d.path()));
        set_trust_own(d.path(), true).unwrap();
        assert!(trust_own(d.path()) && trust_signed(d.path()));
        set_trust_signed(d.path(), false).unwrap();
        assert!(trust_own(d.path()) && !trust_signed(d.path()), "兩項各自保留");
        set_trust_own(d.path(), false).unwrap();
        assert!(!trust_own(d.path()) && !trust_signed(d.path()));
        std::fs::write(prefs_path(d.path()), "{壞掉").unwrap();
        assert!(!trust_own(d.path()) && trust_signed(d.path()), "壞檔用預設：自己的設備要確認、簽章的免");
        set_trust_signed(d.path(), false).unwrap();
        assert!(!trust_signed(d.path()), "壞檔也能重新寫入");
    }

    fn switch_to_home(h: &std::path::Path) -> impl FnOnce(&str) -> Result<String, String> + Send + 'static {
        let h = h.to_path_buf();
        move |e: &str| claude_accounts::switch_to(&h, e).map(|o| o.notice).map_err(|e| e.to_string())
    }
    fn two_accounts() -> tempfile::TempDir {
        let home = tempfile::tempdir().unwrap();
        let h = home.path();
        login(h, "u-a", "a@x.test", "A");
        claude_accounts::save_current(h).unwrap();
        login(h, "u-b", "b@x.test", "B");
        claude_accounts::save_current(h).unwrap();
        login(h, "u-a", "a@x.test", "A");
        home
    }
    fn creds(h: &Path) -> String {
        std::fs::read_to_string(h.join(".claude").join(".credentials.json")).unwrap()
    }

    #[tokio::test]
    async fn 後端標了簽章的指令_預設不用確認就切_重播和沒取走過的編號被拒() {
        const S1: &str = "55555555-2222-3333-4444-555555555555";
        let home = two_accounts();
        let data = tempfile::tempdir().unwrap();
        let (url, seen) = fake_server(vec![json!({ "id": S1, "requested_by": "P", "vendor": "claude", "email": "b@x.test", "signed": true })]);
        let relay = Relay::new(url, "k".into(), "W".into(), "W-ASN".into());
        let p = pending(&relay, data.path()).await.unwrap();
        assert!(!p[0].needs_confirm, "簽章指令預設免確認");
        // 偽造：另一個沒取走過的編號，即使呼叫端說已確認也不能切
        let forged = "66666666-2222-3333-4444-555555555555";
        assert!(apply_with(&relay, data.path(), forged.into(), true, switch_to_home(home.path())).await.is_err());
        assert!(creds(home.path()).contains("FAKE-A"), "偽造編號沒動到檔案");
        // 本人簽章：沒按確認（confirmed=false）也切
        apply_with(&relay, data.path(), S1.into(), false, switch_to_home(home.path())).await.unwrap();
        assert!(creds(home.path()).contains("FAKE-B"));
        // 重放：同一個編號第二次被拒，檔案不再被碰
        login(home.path(), "u-a", "a@x.test", "A");
        assert!(apply_with(&relay, data.path(), S1.into(), false, switch_to_home(home.path())).await.is_err());
        assert!(creds(home.path()).contains("FAKE-A"), "重放不會再切");
        assert!(!is_signed(S1), "處理過的編號從簽章表拿掉");
        let reqs = seen.lock().unwrap().clone();
        assert_eq!(reqs.iter().filter(|r| r.starts_with("POST /relay?action=acct_switch_result")).count(), 1, "只回報一次");
    }

    #[tokio::test]
    async fn 沒簽章_簽章為假_簽章不是布林_一律照舊要確認() {
        let ids = ["77777777-2222-3333-4444-555555555555", "88888888-2222-3333-4444-555555555555", "99999999-2222-3333-4444-555555555555", "aaaaaaaa-2222-3333-4444-555555555555"];
        let home = two_accounts();
        let data = tempfile::tempdir().unwrap();
        let base = |id: &str| json!({ "id": id, "requested_by": "P", "vendor": "claude", "email": "b@x.test" });
        let mut rows = vec![base(ids[0])];
        let mut f = base(ids[1]);
        f["signed"] = json!(false);
        rows.push(f);
        let mut t = base(ids[2]);
        t["signed"] = json!("true");
        rows.push(t);
        let mut n = base(ids[3]);
        n["signed"] = json!(1);
        rows.push(n);
        let (url, _seen) = fake_server(rows);
        let relay = Relay::new(url, "k".into(), "W".into(), "W-ASN".into());
        let mut p = vec![];
        for _ in 0..4 { p.extend(pending(&relay, data.path()).await.unwrap()); }   // 假後端一次回一筆
        assert_eq!(p.len(), 4);
        assert!(p.iter().all(|x| x.needs_confirm), "沒簽章、簽章為 false、字串或數字都要確認");
        for id in ids {
            assert!(apply_with(&relay, data.path(), id.into(), false, switch_to_home(home.path())).await.is_err(), "{id}");
        }
        assert!(creds(home.path()).contains("FAKE-A"), "沒有任何一筆切換");
    }

    #[tokio::test]
    async fn 沒允許切換帳號_別台送來的一律拒絕_回報原因_不交給畫面() {
        // 舊設定兩個都關＝不允許（#371）；簽章的也一樣擋
        const S2: &str = "bbbbbbbb-2222-3333-4444-555555555555";
        let home = two_accounts();
        let data = tempfile::tempdir().unwrap();
        set_trust_signed(data.path(), false).unwrap();
        assert!(!allow_switch(data.path()));
        let (url, seen) = fake_server(vec![json!({ "id": S2, "requested_by": "P", "vendor": "claude", "email": "b@x.test", "signed": true })]);
        let relay = Relay::new(url, "k".into(), "W".into(), "W-ASN".into());
        let p = pending(&relay, data.path()).await.unwrap();
        assert!(p.is_empty(), "不交給畫面確認");
        let reqs = seen.lock().unwrap().clone();
        assert!(reqs.iter().any(|r| r.contains("acct_switch_result") && r.contains(S2) && r.contains("denied") && r.contains(NOT_ALLOWED)), "{reqs:?}");
        assert!(apply_with(&relay, data.path(), S2.into(), true, switch_to_home(home.path())).await.is_err(), "已經拒絕過，按確認也不切");
        assert!(creds(home.path()).contains("FAKE-A"));
    }

    #[test]
    fn 允許切換帳號_預設開_舊的兩個有一個開就算允許_新設定優先() {
        let d = tempfile::tempdir().unwrap();
        assert!(allow_switch(d.path()), "沒存過＝舊的簽章免確認預設開＝允許");
        set_trust_signed(d.path(), false).unwrap();
        assert!(!allow_switch(d.path()), "舊的兩個都關＝不允許");
        set_trust_own(d.path(), true).unwrap();
        assert!(allow_switch(d.path()), "舊的信任自己的設備開＝允許");
        set_allow_switch(d.path(), false).unwrap();
        assert!(!allow_switch(d.path()), "存過新設定就照新設定");
        set_allow_switch(d.path(), true).unwrap();
        set_trust_own(d.path(), false).unwrap();
        assert!(allow_switch(d.path()));
        std::fs::write(prefs_path(d.path()), "{壞掉").unwrap();
        assert!(allow_switch(d.path()), "壞檔用預設（允許）");
    }

    #[tokio::test]
    async fn 允許切換帳號_沒簽章的照舊要確認_簽章的直接切() {
        // 方案 A（#371）：允許只放行本人簽章的；沒簽章的要不要免確認是 #300，還沒定
        const U2: &str = "fa371000-2222-3333-4444-555555555555";   // 自己一個編號：META 是全域的，跟別的測試共用編號會讀到人家的簽章（並行時偶發失敗）
        let home = two_accounts();
        let data = tempfile::tempdir().unwrap();
        set_allow_switch(data.path(), true).unwrap();
        let (url, _seen) = fake_server(vec![json!({ "id": U2, "requested_by": "P", "vendor": "claude", "email": "b@x.test" })]);
        let relay = Relay::new(url, "k".into(), "W".into(), "W-ASN".into());
        let p = pending(&relay, data.path()).await.unwrap();
        assert!(p[0].needs_confirm, "沒簽章：要在這台按確認");
        assert!(apply_with(&relay, data.path(), U2.into(), false, switch_to_home(home.path())).await.is_err());
        assert!(creds(home.path()).contains("FAKE-A"));
    }

    #[tokio::test]
    async fn 簽章只認那個編號_同一批的沒簽章指令仍要確認() {
        const S3: &str = "cccccccc-2222-3333-4444-555555555555";
        const N3: &str = "dddddddd-2222-3333-4444-555555555555";
        let home = two_accounts();
        let data = tempfile::tempdir().unwrap();
        let (url, _seen) = fake_server(vec![
            json!({ "id": S3, "requested_by": "P", "vendor": "claude", "email": "b@x.test", "signed": true }),
            json!({ "id": N3, "requested_by": "Q", "vendor": "claude", "email": "b@x.test" }),
        ]);
        let relay = Relay::new(url, "k".into(), "W".into(), "W-ASN".into());
        let mut p = pending(&relay, data.path()).await.unwrap();
        p.extend(pending(&relay, data.path()).await.unwrap());
        assert!(!p.iter().find(|x| x.id == S3).unwrap().needs_confirm);
        assert!(p.iter().find(|x| x.id == N3).unwrap().needs_confirm);
        assert!(apply_with(&relay, data.path(), N3.into(), false, switch_to_home(home.path())).await.is_err());
        assert!(creds(home.path()).contains("FAKE-A"));
    }

    // ---- 頻率上限、本機日誌、待辦存檔（#302 補齊）----
    #[test]
    fn 簽章自動切換_同一小時最多三次_過了一小時才恢復() {
        let d = tempfile::tempdir().unwrap();
        let t0 = 1_000_000_000_000u64;
        assert!(auto_allowed(d.path(), t0));
        for i in 0..AUTO_MAX_PER_HOUR as u64 {
            assert!(auto_allowed(d.path(), t0 + i), "第 {i} 次還可以");
            auto_record(d.path(), t0 + i);
        }
        assert!(!auto_allowed(d.path(), t0 + 10), "滿了");
        assert!(!auto_allowed(d.path(), t0 + AUTO_WINDOW_MS - 1));
        assert!(auto_allowed(d.path(), t0 + AUTO_WINDOW_MS + 3), "一小時後前面的算過期");
        std::fs::write(auto_path(d.path()), "{壞掉").unwrap();
        assert!(auto_allowed(d.path(), t0), "壞檔當沒有紀錄");
    }

    #[tokio::test]
    async fn 自動切換滿三次後_簽章的指令改成要確認_且不切() {
        let home = two_accounts();
        let data = tempfile::tempdir().unwrap();
        let now = crate::heartbeat::now_ms();
        for _ in 0..AUTO_MAX_PER_HOUR {
            auto_record(data.path(), now);
        }
        const R1: &str = "eeeeeeee-2222-3333-4444-555555555555";
        let (url, _seen) = fake_server(vec![json!({ "id": R1, "requested_by": "P", "vendor": "claude", "email": "b@x.test", "signed": true })]);
        let relay = Relay::new(url, "k".into(), "W".into(), "W-ASN".into());
        let p = pending(&relay, data.path()).await.unwrap();
        assert!(p[0].needs_confirm, "超過頻率上限要確認");
        assert!(apply_with(&relay, data.path(), R1.into(), false, switch_to_home(home.path())).await.is_err());
        assert!(creds(home.path()).contains("FAKE-A"), "沒切");
    }

    #[tokio::test]
    async fn 本機日誌_記取走_切換_拒絕_且沒有權杖() {
        const L1: &str = "f1111111-2222-3333-4444-555555555555";
        const L2: &str = "f2222222-2222-3333-4444-555555555555";
        let home = two_accounts();
        let data = tempfile::tempdir().unwrap();
        let (url, _seen) = fake_server(vec![
            json!({ "id": L1, "requested_by": "P", "vendor": "claude", "email": "b@x.test", "signed": true }),
            json!({ "id": L2, "requested_by": "Q", "vendor": "claude", "email": "b@x.test" }),
        ]);
        let relay = Relay::new(url, "k".into(), "W".into(), "W-ASN".into());
        pending(&relay, data.path()).await.unwrap();
        pending(&relay, data.path()).await.unwrap();
        apply_with(&relay, data.path(), L1.into(), false, switch_to_home(home.path())).await.unwrap();
        decline(&relay, data.path(), L2.into()).await.unwrap();
        let log = std::fs::read_to_string(log_path(data.path())).unwrap();
        for want in [format!("taken\t{L1}"), format!("ok\t{L1}\tsigned"), format!("taken\t{L2}"), format!("declined\t{L2}")] {
            assert!(log.contains(&want), "日誌少了 {want}：\n{log}");
        }
        assert!(!log.contains("FAKE-"), "日誌裡沒有權杖");
    }

    #[test]
    fn 日誌太大只留後半() {
        let d = tempfile::tempdir().unwrap();
        std::fs::write(log_path(d.path()), "x".repeat(LOG_MAX_BYTES as usize + 10)).unwrap();
        log_event(d.path(), "taken", U, "H");
        let n = std::fs::metadata(log_path(d.path())).unwrap().len();
        assert!(n < LOG_MAX_BYTES, "縮小了：{n}");
        assert!(std::fs::read_to_string(log_path(d.path())).unwrap().contains("taken"));
    }

    #[tokio::test]
    async fn 取走後重啟_待辦從存檔讀回來_簽章也保留_處理後存檔清掉() {
        const K1: &str = "f3333333-2222-3333-4444-555555555555";
        let home = two_accounts();
        let data = tempfile::tempdir().unwrap();
        let (url, _seen) = fake_server(vec![json!({ "id": K1, "requested_by": "P", "vendor": "claude", "email": "b@x.test", "signed": true })]);
        let relay = Relay::new(url, "k".into(), "W".into(), "W-ASN".into());
        pending(&relay, data.path()).await.unwrap();
        let saved = std::fs::read_to_string(taken_path(data.path())).unwrap();
        assert!(saved.contains(K1) && saved.contains(r#""signed":true"#) && !saved.contains("FAKE-"), "{saved}");
        // 模擬重啟：記憶體裡的待辦與附註清空，只剩存檔
        with_taken(|m| m.remove(K1));   // 待辦表是全域的，只動自己這一筆，不影響平行的測試
        META.lock().unwrap().as_mut().map(|m| m.remove(K1));
        assert!(apply_with(&relay, data.path(), K1.into(), true, switch_to_home(home.path())).await.is_err(), "重啟後沒讀回來就找不到");
        // 另一份存檔：讀回來之後才能處理
        std::fs::write(taken_path(data.path()), json!([{ "id": K1, "email": "b@x.test", "by": "P", "signed": true, "at": crate::heartbeat::now_ms() }]).to_string()).unwrap();
        let back = taken_restore(data.path());
        assert_eq!(back, vec![(K1.to_string(), "b@x.test".to_string(), "P".to_string(), true)]);
        assert!(is_signed(K1));
        assert!(taken_restore(data.path()).is_empty(), "已在記憶體裡的不重複讀回來");
        apply_with(&relay, data.path(), K1.into(), false, switch_to_home(home.path())).await.unwrap();
        assert!(creds(home.path()).contains("FAKE-B"));
        // 待辦表是全域的，平行的測試可能還有別的編號；只看這一筆有沒有清掉
        assert!(!std::fs::read_to_string(taken_path(data.path())).unwrap_or_default().contains(K1), "處理完存檔清掉");
    }

    #[test]
    fn 存檔讀回來_過期_格式不對的丟掉() {
        let d = tempfile::tempdir().unwrap();
        let now = crate::heartbeat::now_ms();
        let old = now - ENTRY_TTL.as_millis() as u64 - 1000;
        const G1: &str = "f4444444-2222-3333-4444-555555555555";
        std::fs::write(
            taken_path(d.path()),
            json!([
                { "id": G1, "email": "b@x.test", "by": "P", "signed": true, "at": old },
                { "id": "不是編號", "email": "b@x.test", "by": "P", "signed": true, "at": now },
                { "id": "f5555555-2222-3333-4444-555555555555", "email": "../x", "by": "P", "signed": true, "at": now },
                { "id": "f6666666-2222-3333-4444-555555555555", "email": "b@x.test", "by": "P P", "signed": true, "at": now },
            ])
            .to_string(),
        )
        .unwrap();
        assert!(taken_restore(d.path()).is_empty());
        std::fs::write(taken_path(d.path()), "{壞掉").unwrap();
        assert!(taken_restore(d.path()).is_empty());
    }

    #[test]
    fn 設備代號與編號格式() {
        assert!(valid_node("H") && valid_node("machine-2_a") && !valid_node("") && !valid_node("a b") && !valid_node(&"x".repeat(33)));
        assert!(is_uuid(U) && !is_uuid("11111111-2222-3333-4444-55555555555") && !is_uuid("zzzzzzzz-2222-3333-4444-555555555555"));
    }

    // ---- 回報結果：重試與補報（#300）----
    #[test]
    fn 錯誤分類_四百四百零四四百零九是明確拒絕_其餘是暫時失敗() {
        for e in ["acct_switch_result HTTP 404 not_found", "acct_switch_result HTTP 409 conflict", "acct_switch_result HTTP 400 bad_request"] {
            assert_eq!(classify_send_error(e), ResultSend::Rejected, "{e}");
        }
        for e in ["acct_switch_result HTTP 500 internal", "acct_switch_result HTTP 503", "error sending request: timed out", "connection refused", ""] {
            assert_eq!(classify_send_error(e), ResultSend::Temporary, "{e}");
        }
    }

    #[tokio::test]
    async fn 回報暫時失敗會依序重試_送達或被拒絕就停_全暫時失敗回_temporary() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        let delays = [Duration::from_millis(1), Duration::from_millis(1)];
        let n = AtomicUsize::new(0);
        let r = send_with_retry(|| { let k = n.fetch_add(1, Ordering::SeqCst); async move { if k >= 1 { ResultSend::Sent } else { ResultSend::Temporary } } }, &delays, |_| async {}).await;
        assert!(r == ResultSend::Sent && n.load(Ordering::SeqCst) == 2, "第二次成功就停");
        let n2 = AtomicUsize::new(0);
        let r2 = send_with_retry(|| { n2.fetch_add(1, Ordering::SeqCst); async { ResultSend::Rejected } }, &delays, |_| async {}).await;
        assert!(r2 == ResultSend::Rejected && n2.load(Ordering::SeqCst) == 1, "被後端明確拒絕就不再重試");
        let n3 = AtomicUsize::new(0);
        let r3 = send_with_retry(|| { n3.fetch_add(1, Ordering::SeqCst); async { ResultSend::Temporary } }, &delays, |_| async {}).await;
        assert!(r3 == ResultSend::Temporary && n3.load(Ordering::SeqCst) == 3, "一次加兩次重試後放棄");
    }

    #[test]
    fn 待補報檔_同編號留最新_最多二十筆_讀不到當空_清空會刪檔() {
        let d = tempfile::tempdir().unwrap();
        assert!(outbox_read(d.path()).is_empty());
        outbox_push(d.path(), U, "failed", "舊的", 1);
        outbox_push(d.path(), U, "ok", "新的", 2);
        let rows = outbox_read(d.path());
        assert_eq!(rows.len(), 1);
        assert_eq!((rows[0]["status"].as_str(), rows[0]["detail"].as_str(), rows[0]["at"].as_u64()), (Some("ok"), Some("新的"), Some(2)));
        for i in 0..30 {
            outbox_push(d.path(), &format!("id-{i}"), "ok", "x", 3);
        }
        let rows = outbox_read(d.path());
        assert_eq!(rows.len(), OUTBOX_MAX);
        assert_eq!(rows.last().unwrap()["id"], "id-29");
        assert!(rows.iter().all(|r| r["id"] != U), "最舊的被丟掉");
        std::fs::write(outbox_path(d.path()), "不是 JSON").unwrap();
        assert!(outbox_read(d.path()).is_empty(), "壞檔當空");
        outbox_write(d.path(), &[]);
        assert!(!outbox_path(d.path()).exists());
    }

    #[tokio::test]
    async fn 補報_被拒絕的拿掉_暫時失敗的留著_送達的拿掉_存太久的丟掉() {
        const NOW: u64 = 10 * OUTBOX_MAX_AGE_MS;
        let row = |id: &str, at: u64| json!({ "id": id, "status": "ok", "detail": "d", "at": at });
        let rows = vec![
            row("sent", NOW - 1000),
            row("rejected-404", NOW - 1000),
            row("network", NOW - 1000),
            row("too-old", NOW - OUTBOX_MAX_AGE_MS - 1),
            row("just-in-time", NOW - OUTBOX_MAX_AGE_MS),
            json!({ "id": "no-time", "status": "ok" }),
            json!({ "status": "ok", "at": NOW }),
        ];
        let called = std::sync::Mutex::new(vec![]);
        let left = flush_rows(rows, NOW, |id, _s, _d| {
            called.lock().unwrap().push(id.clone());
            async move {
                match id.as_str() {
                    "rejected-404" => ResultSend::Rejected,
                    "network" | "just-in-time" => ResultSend::Temporary,
                    _ => ResultSend::Sent,
                }
            }
        })
        .await;
        assert_eq!(left.iter().map(|r| r["id"].as_str().unwrap()).collect::<Vec<_>>(), vec!["network", "just-in-time"], "只有暫時失敗的留著");
        let called = called.lock().unwrap();
        assert!(!called.contains(&"too-old".to_string()) && !called.contains(&"no-time".to_string()), "太舊與沒有時間的連試都不試：{called:?}");
    }
}

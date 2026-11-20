//! Claude 額度（#1883）：ASN 直接讀這台目前登入的憑證，向 Claude 查「目前登入帳號」的 5 小時與每週額度。
//!
//! 三步：
//! 1. **查**：每 10 分鐘一次、切換帳號後立刻一次；失敗退避（`quota_readers::Gate`），不加速。
//!    只查目前登入的那一個（以 `.claude.json` 的 oauthAccount email 為準）；帳號庫裡沒在用的帳號不查。
//! 2. **送**：只把（email、剩餘 %、重置時間、讀取時間）隨帳號回報送上後台（見 acct_remote.rs），同帳號多台的取舍在後台。
//! 3. **刪**：狀態列掛鉤、對話紀錄猜帳號、本機額度檔都已移除；舊的 `claude-quota.json`、`claude-owner-cache.json` 升級後不再讀（保留一版，下一版清）。
//!
//! 查詢介面（非公開文件，可能隨時變動；變了就照實顯示「暫時查不到」並記 log）：
//! - `GET https://api.anthropic.com/api/oauth/profile`：查這份憑證屬於哪個帳號（`account.email`），跟 `.claude.json` 對不上＝切換進行到一半，這一輪不查。
//! - `GET https://api.anthropic.com/api/oauth/usage`：回 `five_hour`／`seven_day` 各一塊 `{ utilization, resets_at }`。
//!   `utilization` 是「已用」百分比，剩餘＝100 − 已用（`claude_extra::parse_usage` 換算）；`resets_at` 是帶時區的 ISO 時間。
//! - 兩個都走 `claude_accounts::fetch_json`：Bearer＝現成的 access token、`anthropic-beta: oauth-2025-04-20`、不跟隨轉址、逾時 5 秒。
//!
//! 安全：
//! - 憑證只在這台電腦的記憶體裡用：不離開本機、不寫 log、不顯示、不進錯誤訊息；回報只有 email 與數字。
//! - **只用現成的 access token，不做 refresh**：ASN 自己換新可能讓 Claude 視窗的登入失效。過期就標「登入過期」，
//!   等使用者用那個帳號開 Claude、Claude 自己換新之後（憑證檔變了）自然恢復。程式裡沒有任何換新的呼叫（有靜態測試鎖住）。
//! - 紅線：函式一律吃家目錄路徑參數；只有 Tauri 指令與背景迴圈會決定真實家目錄，測試不得呼叫它們。
use crate::claude_accounts::{self, HttpFail};
use crate::quota_core::iso_secs;
use crate::quota_readers::{Failure, Gate};
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

/// 額度端點（寫死、只走 HTTPS、只連 Anthropic 自己的網域）。Claude 額外帳號（claude_extra.rs）也走同一份查詢
pub(crate) const USAGE_URL: &str = "https://api.anthropic.com/api/oauth/usage";
/// 單次查詢的逾時（兩次查詢合計最多約 10 秒）
const HTTP_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);
/// 讀到的數字放太久就不隨回報送（後台自己還留著最後一次讀數）
const KEEP_MS: i64 = 60 * 60_000;
/// 讀取時間比現在晚這麼久以上就不送（電腦時鐘被往前撥過）
const FUTURE_MS: i64 = 5 * 60_000;

/// 這台目前登入帳號的額度讀取狀態（給畫面與回報用）
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Status {
    /// 剛讀到，`windows` 有數字
    Ok,
    /// 本地看 `expiresAt` 已過期，或 Claude 回 401
    LoginExpired,
    /// Claude 回 429：退避
    RateLimited,
    /// 5xx、逾時、連不上、回應看不懂（介面變了）
    Unavailable,
    /// 還沒讀過，或這台沒有登入
    None,
}

/// 一輪讀取的結果。`windows` 只有 `Ok` 時有內容
#[derive(Clone, Debug, PartialEq)]
pub struct State {
    pub email: Option<String>,
    pub status: Status,
    pub read_at: Option<String>,
    pub windows: Vec<Value>,
}

impl State {
    fn none(email: Option<String>) -> State {
        State { email, status: Status::None, read_at: None, windows: vec![] }
    }
    fn failed(email: &str, status: Status) -> State {
        State { email: Some(email.to_string()), status, read_at: None, windows: vec![] }
    }
    pub fn view(&self) -> Value {
        json!({ "email": self.email, "status": self.status, "read_at": self.read_at, "windows": self.windows })
    }
}

/// 這一輪沒有查（不是失敗，不退避，也不動畫面上的狀態）
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Skip {
    /// 帳號正在切換（或登入檔正被別的動作改）
    Switching,
    /// 憑證查出來的帳號跟 `.claude.json` 寫的對不上（切到一半）
    Mismatch,
    /// 查的過程中登入變了：這輪的數字不能記到任何帳號
    Changed,
}

/// 查詢介面：正式用 `HttpNet::real()`，測試用本機假伺服器或假的實作
pub trait Net {
    fn profile(&self, cred: &[u8]) -> Result<Value, HttpFail>;
    fn usage(&self, cred: &[u8]) -> Result<Value, HttpFail>;
}

pub struct HttpNet {
    profile: String,
    usage: String,
}

impl HttpNet {
    /// 正式的網址：寫死、只走 HTTPS、只連 Anthropic 自己的網域，不能從設定或環境變數改
    pub fn real() -> HttpNet {
        HttpNet { profile: claude_accounts::PROFILE_URL.to_string(), usage: USAGE_URL.to_string() }
    }
    #[cfg(test)]
    pub fn at(profile: &str, usage: &str) -> HttpNet {
        HttpNet { profile: profile.to_string(), usage: usage.to_string() }
    }
}

impl Net for HttpNet {
    fn profile(&self, cred: &[u8]) -> Result<Value, HttpFail> {
        claude_accounts::fetch_json(&self.profile, cred, HTTP_TIMEOUT)
    }
    fn usage(&self, cred: &[u8]) -> Result<Value, HttpFail> {
        claude_accounts::fetch_json(&self.usage, cred, HTTP_TIMEOUT)
    }
}

fn status_of(f: HttpFail) -> Status {
    match f {
        HttpFail::Unauthorized => Status::LoginExpired,
        HttpFail::RateLimited => Status::RateLimited,
        HttpFail::Server(_) | HttpFail::Status(_) | HttpFail::Timeout | HttpFail::Other => Status::Unavailable,
    }
}

/// 憑證檔的到期時間（毫秒）；讀不出來回 None（不當成過期，交給對方判斷）
fn expires_at_ms(cred: &[u8]) -> Option<i64> {
    serde_json::from_slice::<Value>(cred).ok()?.pointer("/claudeAiOauth/expiresAt")?.as_i64()
}

/// 憑證檔的 access token（只在這個模組裡比對與傳給查詢，不複製出去、不印）
fn token_of(cred: &[u8]) -> Option<String> {
    serde_json::from_slice::<Value>(cred).ok()?.pointer("/claudeAiOauth/accessToken")?.as_str().filter(|t| !t.trim().is_empty()).map(str::to_string)
}

/// 查詢失敗的種類
#[derive(Debug, PartialEq)]
pub enum QueryFail {
    Http(HttpFail),
    /// 帳號資料回應裡沒有 email
    NoAccount,
    /// 憑證查出來的帳號跟預期的不同
    Mismatch,
}

/// 查一次：先查這份憑證屬於哪個帳號，再查用量，回 (email, 額度窗)。額度窗可能是空的（回應不齊或介面變了）。
/// `expect`＝預期的帳號（`.claude.json` 寫的）；給了而且不同，就不查用量、回 `Mismatch`。
/// 正式的 Claude 額度、Claude 額外帳號、除錯命令（`--shape`）都走這一支，沒有第二份查詢程式。
pub fn query(net: &dyn Net, cred: &[u8], now_ms: i64, expect: Option<&str>) -> Result<(String, Vec<Value>), QueryFail> {
    let v = net.profile(cred).map_err(QueryFail::Http)?;
    let (email, _) = claude_accounts::account_of_profile(&v).ok_or(QueryFail::NoAccount)?;
    if expect.is_some_and(|e| e != email) {
        return Err(QueryFail::Mismatch);
    }
    let usage = net.usage(cred).map_err(QueryFail::Http)?;
    Ok((email, crate::claude_extra::parse_usage(&usage, now_ms)))
}

/// 讀一輪：回 (新狀態, 失敗類別（成功與沒有登入是 None，給記 log 與退避用）)，或這一輪不查的原因。
/// `busy`＝帳號正在切換（正式是 `claude_accounts::switch_busy`）。這個函式只打兩次查詢，不做任何寫入。
pub fn read_round(home: &Path, now_ms: i64, net: &dyn Net, busy: &dyn Fn() -> bool) -> Result<(State, Option<HttpFail>), Skip> {
    // 目前登入的帳號：只認 `.claude.json` 的 oauthAccount email
    let Some(email) = claude_accounts::current_email(home) else { return Ok((State::none(None), None)) };
    if busy() {
        return Err(Skip::Switching);
    }
    // 憑證：沒有、讀不出來、沒有 access token、本地看已過期，都是「登入過期」，不連網
    let cred = std::fs::read(claude_accounts::cred_path(home)).unwrap_or_default();
    let token = token_of(&cred);
    if token.is_none() || expires_at_ms(&cred).is_some_and(|e| e <= now_ms) {
        return Ok((State::failed(&email, Status::LoginExpired), Some(HttpFail::Unauthorized)));
    }
    // 查帳號與用量（跟 .claude.json 對不上就這一輪不查，下一輪再查，不記到錯的帳號）
    let (_, windows) = match query(net, &cred, now_ms, Some(&email)) {
        Ok(r) => r,
        Err(QueryFail::Mismatch) => return Err(Skip::Mismatch),
        Err(QueryFail::Http(f)) => return Ok((State::failed(&email, status_of(f)), Some(f))),
        Err(QueryFail::NoAccount) => return Ok((State::failed(&email, Status::Unavailable), Some(HttpFail::Other))),
    };
    // 查的當中登入變了（切換，或 Claude 自己換新權杖也算變）：這輪不記，下一輪再查
    let now_cred = std::fs::read(claude_accounts::cred_path(home)).unwrap_or_default();
    if busy() || claude_accounts::current_email(home).as_deref() != Some(email.as_str()) || token_of(&now_cred) != token {
        return Err(Skip::Changed);
    }
    if windows.is_empty() {
        // 介面變了或回應不齊：照實顯示讀不到，不補 0
        return Ok((State::failed(&email, Status::Unavailable), Some(HttpFail::Other)));
    }
    Ok((State { email: Some(email), status: Status::Ok, read_at: Some(iso_secs(now_ms)), windows }, None))
}

// ---------- 除錯用：只印回應的欄位結構 ----------
/// 回應 → 欄位結構：每個鍵照印，值一律換成型別名（string／number／boolean／null），物件與陣列照結構展開（陣列最多展開 5 項）。
/// 任何值（含長得像 token、email、uuid 的字串、數字）都不會出現在結果裡。
pub fn shape_of(v: &Value) -> Value {
    match v {
        Value::Object(m) => Value::Object(m.iter().map(|(k, x)| (k.clone(), shape_of(x))).collect()),
        Value::Array(a) => Value::Array(a.iter().take(5).map(shape_of).collect()),
        Value::String(_) => json!("string"),
        Value::Number(_) => json!("number"),
        Value::Bool(_) => json!("boolean"),
        Value::Null => json!("null"),
    }
}

/// 失敗時只印狀態碼或固定的類別名，不印回應內容
fn fail_code_text(f: HttpFail) -> String {
    match f {
        HttpFail::Unauthorized => "HTTP 401".into(),
        HttpFail::RateLimited => "HTTP 429".into(),
        HttpFail::Server(c) | HttpFail::Status(c) => format!("HTTP {c}"),
        HttpFail::Timeout => "逾時".into(),
        HttpFail::Other => "連線失敗".into(),
    }
}

/// `asn-cli claude-usage --shape`：讀這台目前登入的憑證，向額度端點查一次（跟正式查額度同一個 `HttpNet::usage`），只回欄位結構。
/// 不印值、不印標頭；失敗只印狀態碼。本機判斷登入過期時不連網。
pub fn shape_report(home: &Path, now_ms: i64, net: &dyn Net) -> String {
    let cred = std::fs::read(claude_accounts::cred_path(home)).unwrap_or_default();
    if token_of(&cred).is_none() {
        return "沒有可用的登入（找不到 access token），沒有查詢".into();
    }
    if expires_at_ms(&cred).is_some_and(|e| e <= now_ms) {
        return "登入已過期（憑證上的到期時間已過），沒有查詢".into();
    }
    match net.usage(&cred) {
        Ok(v) => serde_json::to_string_pretty(&shape_of(&v)).unwrap_or_default(),
        Err(f) => format!("查詢失敗：{}", fail_code_text(f)),
    }
}

// ---------- 最近一次的狀態（只在記憶體，重開就沒了，下一輪再讀） ----------
static STATE: Mutex<Option<State>> = Mutex::new(None);
static KICKS: AtomicU64 = AtomicU64::new(0);

fn set_state(s: State) {
    *STATE.lock().unwrap_or_else(|e| e.into_inner()) = Some(s);
}

/// 切換帳號之後叫一聲：背景迴圈立刻查一次（不等退避、不等 10 分鐘）
pub fn kick() {
    KICKS.fetch_add(1, Ordering::SeqCst);
}

/// 畫面看的狀態：記著的那一筆要是屬於現在登入的帳號才算數，否則（剛換帳號、還沒查）回「還沒讀」
pub fn state_view(home: &Path) -> Value {
    let email = claude_accounts::current_email(home);
    let st = STATE.lock().unwrap_or_else(|e| e.into_inner()).clone();
    match st {
        Some(s) if email.is_some() && s.email == email => s.view(),
        _ => State::none(email).view(),
    }
}

/// 隨帳號回報送出的額度窗（email → 窗）：只有剛讀到（Ok）、還在 `KEEP_MS` 內、而且屬於現在登入帳號的才送
pub fn report_windows(home: &Path, now_ms: i64) -> HashMap<String, Vec<Value>> {
    let email = claude_accounts::current_email(home);
    let st = STATE.lock().unwrap_or_else(|e| e.into_inner()).clone();
    let mut out = HashMap::new();
    if let (Some(s), Some(e)) = (st, email) {
        let fresh = s.read_at.as_deref().and_then(crate::quota_core::parse_iso_secs).is_some_and(|t| now_ms - t < KEEP_MS && t <= now_ms + FUTURE_MS);
        if s.status == Status::Ok && s.email.as_deref() == Some(e.as_str()) && fresh {
            out.insert(e, s.windows);
        }
    }
    out
}

/// 前端讀這台目前登入帳號的額度讀取狀態。連網都在背景迴圈，這裡只讀記憶體與 `.claude.json`
#[cfg_attr(feature = "gui", tauri::command(async))]
pub fn claude_quota_state() -> Value {
    state_view(&claude_accounts::claude_home())
}

// ---------- 定時讀取 ----------
/// 失敗的種類 → log 用的固定文字（不含對方回應）
fn fail_text(f: HttpFail) -> &'static str {
    match f {
        HttpFail::Unauthorized => "登入過期（401 或憑證已到期）",
        HttpFail::RateLimited => "查詢太頻繁（429），已退避",
        HttpFail::Server(_) => "對方暫時有問題（5xx）",
        HttpFail::Status(_) => "對方回了意外的狀態",
        HttpFail::Timeout => "逾時",
        HttpFail::Other => "連不上或回應看不懂",
    }
}

#[derive(Default)]
pub struct Loop {
    gate: Gate,
    seen_kicks: u64,
    logged: Option<&'static str>,
}

impl Loop {
    /// 憑證檔的修改時間當記號：登入過期後，憑證檔變了（Claude 自己換新了）才再試
    fn mark(home: &Path) -> Option<i64> {
        let t = std::fs::metadata(claude_accounts::cred_path(home)).ok()?.modified().ok()?;
        t.duration_since(std::time::UNIX_EPOCH).ok().map(|d| d.as_millis() as i64)
    }

    /// 每分鐘看一次：切換叫過、或到時間了才查。回這一輪有沒有真的查過（給測試看）
    pub fn tick(&mut self, home: &Path, now_ms: i64, net: &dyn Net, busy: &dyn Fn() -> bool, log: &(impl Fn(String) + Sync)) -> bool {
        self.tick_at(KICKS.load(Ordering::SeqCst), home, now_ms, net, busy, log)
    }

    /// `kicks`＝切換叫過幾次（測試自己給，不受別的測試的切換影響）
    fn tick_at(&mut self, kicks: u64, home: &Path, now_ms: i64, net: &dyn Net, busy: &dyn Fn() -> bool, log: &(impl Fn(String) + Sync)) -> bool {
        if kicks != self.seen_kicks {
            self.seen_kicks = kicks;
            self.gate = Gate::default();
            self.logged = None;
        }
        let mark = Self::mark(home);
        if !self.gate.due(now_ms, mark) {
            return false;
        }
        match read_round(home, now_ms, net, busy) {
            // 沒查：不算失敗、不退避，下一分鐘再看
            Err(skip) => {
                match skip {
                    Skip::Switching => {}
                    Skip::Mismatch => log("額度讀取 Claude：這一輪沒查（憑證和目前登入的帳號對不上，可能正在切換）".into()),
                    Skip::Changed => log("額度讀取 Claude：這一輪沒查（查的過程中登入變了）".into()),
                }
                false
            }
            Ok((state, None)) => {
                self.gate.success(now_ms);
                self.logged = None;
                set_state(state);
                true
            }
            Ok((state, Some(f))) => {
                let failure = if f == HttpFail::Unauthorized { Failure::Auth } else { Failure::Other(fail_text(f).into()) };
                // 登入過期用憑證檔的記號：檔案變了才再試；其他失敗指數退避（上限 6 小時）
                self.gate.failure(&failure, now_ms, mark);
                let text = fail_text(f);
                if self.logged != Some(text) {
                    self.logged = Some(text);
                    log(format!("額度讀取 Claude：{text}"));
                }
                set_state(state);
                true
            }
        }
    }
}

/// 背景迴圈：每分鐘看一次（查詢本身每 10 分鐘一次）。查詢在背景執行緒跑，不佔畫面。
pub async fn run_loop(home: std::path::PathBuf, log: impl Fn(String) + Sync + Send + 'static) {
    let mut lp = Loop::default();
    let log = std::sync::Arc::new(log);
    loop {
        let (h, l) = (home.clone(), log.clone());
        let handed = tokio::task::spawn_blocking(move || {
            let mut moved = lp;
            moved.tick(&h, crate::heartbeat::now_ms() as i64, &HttpNet::real(), &claude_accounts::switch_busy, &|s| l(s));
            moved
        })
        .await;
        lp = handed.unwrap_or_default();
        tokio::time::sleep(std::time::Duration::from_secs(60)).await;
    }
}

#[cfg(test)]
mod tests;

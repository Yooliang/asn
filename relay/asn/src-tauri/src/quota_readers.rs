//! 額度讀取器（todo-next-193）：主動讀 Grok、MiniMax、agy 的額度，隨帳號回報送出。每一項都預設關閉。
//!
//! - 設定 `~/.asn/quota-readers.json`：沒有這個檔或欄位不對，一律當成全關。
//! - Grok：讀 `~/.grok/auth.json` 的 key 查用量。只讀不換新；被拒就標「要重新登入」，auth.json 沒變之前不再打。
//! - MiniMax：key 由使用者在設定頁輸入，放 Windows 憑證管理員；不寫檔案、不放環境變數，存好後讀不回畫面。HTTP 永遠 200，要看 `base_resp`。
//! - agy：跑內建的 `/quota`，不消耗模型額度、不讀憑證。不是內建指令的回應就不算讀到，避免把模型回話當數字。
//!   `/quota` 不回帳號，所以要 ASN 開過 agy 視窗、記過帳號才會讀；讀到的數字走狀態列同一套新舊判斷。
//! - 每 10 分鐘最多讀一次，失敗退避；缺值就不送那個窗，不補 0。
//!
//! 紅線：不碰 `~/.claude`；金鑰、權杖與對方回應內容不進 log，也不進回報，回報只有 email 與數字。
use crate::claude_accounts::normalize_email;
use crate::claude_quota::iso_secs;
use crate::nowin::NoWindow;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

const FILE: &str = "quota-readers.json";
const READ_EVERY_MS: i64 = 10 * 60_000;
const BACKOFF_MAX_MS: i64 = 6 * 60 * 60_000;
/// 讀到的數字放太久就不送，不把過時的當成現在的
const KEEP_MS: i64 = 60 * 60_000;
const HTTP_TIMEOUT_SECS: u64 = 20;
const AGY_TIMEOUT_SECS: u64 = 90;
/// 空記憶體低於這個就不開 agy（跟其他會開程序的背景工作同一條線，見 launch/screen_watch.rs 的 PAUSE_BELOW_BYTES）
const AGY_PAUSE_BELOW_BYTES: u64 = 3 * 1024 * 1024 * 1024;
/// MiniMax 帳號最多幾個（回報總筆數有上限）
pub const MAX_MINIMAX: usize = 2;
const GROK_URL: &str = "https://cli-chat-proxy.grok.com/v1/billing?format=credits";
const MINIMAX_URL: &str = "https://api.minimax.io/v1/token_plan/remains";
const AGY_GROUP: &str = "Gemini Models";

#[derive(Debug, Clone, Default, PartialEq, Deserialize, Serialize)]
#[serde(default)]
pub struct Settings {
    pub grok: bool,
    pub agy: bool,
    /// 要讀的 MiniMax 帳號 email；key 在憑證管理員
    pub minimax: Vec<String>,
    /// 讀專用資料夾裡的 Claude 額外帳號
    pub extra_claude: bool,
    /// 額外帳號快到期時自動換新（要先開上面那個；同一個帳號只能有一支程式在換）
    pub extra_claude_refresh: bool,
}

pub fn settings_path(home: &Path) -> PathBuf {
    home.join(".asn").join(FILE)
}

pub fn load_settings(home: &Path) -> Settings {
    let Ok(text) = std::fs::read_to_string(settings_path(home)) else { return Settings::default() };
    let mut s: Settings = serde_json::from_str(text.trim_start_matches('\u{feff}')).unwrap_or_default();
    s.minimax = s.minimax.iter().filter_map(|e| normalize_email(e)).take(MAX_MINIMAX).collect();
    s.extra_claude_refresh = s.extra_claude_refresh && s.extra_claude;
    s
}

/// 原子寫入：先寫暫存檔再改名，寫到一半不會留下壞檔（壞檔等於全關）
pub fn save_settings(home: &Path, s: &Settings) -> Result<(), String> {
    let path = settings_path(home);
    if let Some(p) = path.parent() {
        std::fs::create_dir_all(p).map_err(|_| "無法寫入設定")?;
    }
    let tmp = PathBuf::from(format!("{}.{}.tmp", path.display(), std::process::id()));
    let text = serde_json::to_string_pretty(s).map_err(|_| "無法寫入設定")?;
    std::fs::write(&tmp, text).map_err(|_| "無法寫入設定")?;
    std::fs::rename(&tmp, &path).map_err(|_| {
        let _ = std::fs::remove_file(&tmp);
        "無法寫入設定".to_string()
    })
}

/// 設定變了就加一：背景迴圈看到會把退避狀態清掉，換了 key 或重新打開不用等
static CHANGES: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
fn changed() {
    CHANGES.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
}

pub fn set_source(home: &Path, source: &str, on: bool) -> Result<(), String> {
    let mut s = load_settings(home);
    match source {
        "grok" => s.grok = on,
        "agy" => s.agy = on,
        "extra_claude" => {
            s.extra_claude = on;
            s.extra_claude_refresh = s.extra_claude_refresh && on;
        }
        "extra_claude_refresh" => {
            if on && !s.extra_claude {
                return Err("要先打開讀取".into());
            }
            s.extra_claude_refresh = on;
            // 使用者自己重新打開：之前換新失敗的記號清掉，下一輪才會再試
            crate::claude_extra::clear_stops(home);
        }
        _ => return Err("不認得的來源".into()),
    }
    save_settings(home, &s)?;
    changed();
    Ok(())
}

fn clean_key(key: &str) -> Option<&str> {
    let k = key.trim();
    (!k.is_empty() && k.len() <= 512 && !k.chars().any(char::is_control)).then_some(k)
}

/// 先存 key 再寫設定：中途失敗頂多多一筆用不到的憑證，不會有設定指著不存在的 key。key 不進檔案、不回傳。
pub fn add_minimax(home: &Path, email: &str, key: &str) -> Result<(), String> {
    let email = normalize_email(email).ok_or("email 格式不對")?;
    let key = clean_key(key).ok_or("key 格式不對")?;
    let mut s = load_settings(home);
    if !s.minimax.contains(&email) && s.minimax.len() >= MAX_MINIMAX {
        return Err("帳號已滿".into());
    }
    store_minimax_key(&email, key)?;
    if !s.minimax.contains(&email) {
        s.minimax.push(email);
    }
    save_settings(home, &s)?;
    changed();
    Ok(())
}

pub fn remove_minimax(home: &Path, email: &str) -> Result<(), String> {
    let email = normalize_email(email).ok_or("email 格式不對")?;
    let mut s = load_settings(home);
    s.minimax.retain(|e| *e != email);
    save_settings(home, &s)?;
    delete_minimax_key(&email);
    changed();
    Ok(())
}

/// 設定頁要的資料：開關、帳號、有沒有存 key、最近的失敗原因。沒有 key 本身。
pub fn view(home: &Path) -> Value {
    view_with(home, cfg!(windows), |e| minimax_key(e).is_some())
}

fn view_with(home: &Path, supported: bool, has_key: impl Fn(&str) -> bool) -> Value {
    let s = load_settings(home);
    let failures = FAILURES.lock().unwrap_or_else(|e| e.into_inner()).clone();
    let minimax: Vec<Value> = s.minimax.iter().map(|e| json!({ "email": e, "has_key": has_key(e) })).collect();
    let extra: Vec<Value> = crate::claude_extra::dirs(home).into_iter().map(|(name, _)| json!({ "name": name, "status": failures.get(&format!("claude:{name}")) })).collect();
    json!({
        "grok": s.grok, "agy": s.agy, "agy_account": agy_email(home), "minimax": minimax, "minimax_supported": supported,
        "extra_claude": s.extra_claude, "extra_claude_refresh": s.extra_claude_refresh, "extra_claude_dirs": extra,
        "status": {
            "grok": failures.get("grok"), "agy": failures.get("agy"),
            "minimax": s.minimax.iter().filter_map(|e| failures.get(&format!("minimax:{e}")).map(|f| (e.clone(), json!(f)))).collect::<serde_json::Map<_, _>>(),
        },
    })
}

// ---------- 解析：全部是純函式，缺值一律不產生窗 ----------
pub(crate) fn window(name: &str, left: f64, resets_at: Option<String>, now_ms: i64) -> Option<Value> {
    if !left.is_finite() || !(0.0..=100.0).contains(&left) {
        return None;
    }
    Some(json!({ "name": name, "left_pct": left.round() as u8, "resets_at": resets_at, "read_at": iso_secs(now_ms) }))
}

pub(crate) fn iso_or_none(s: Option<&str>) -> Option<String> {
    s.and_then(parse_iso_flex).map(iso_secs)
}

/// 通用的 ISO 8601 時間（#1195）→ UTC 毫秒（小數秒捨去）。
/// 接受：日期與時間之間用 `T` 或空白；秒可省略；小數秒任意位數；結尾 `Z`、`±HH:MM`、`±HHMM` 或 `±HH`。
/// 沒有時區的不採用（不知道是哪一區，寧可沒有重置時間也不猜）。
pub(crate) fn parse_iso_flex(s: &str) -> Option<i64> {
    let s = s.trim();
    let b = s.as_bytes();
    if b.len() < 16 || !matches!(b[10], b'T' | b't' | b' ') {
        return None;
    }
    let (date, rest) = (s.get(0..10)?, s.get(11..)?);
    // 時區：結尾 Z，或最後一個 + / -（時間部分本身沒有負號）
    let (clock, off_min) = if let Some(c) = rest.strip_suffix('Z').or_else(|| rest.strip_suffix('z')) {
        (c, 0i64)
    } else {
        let i = rest.rfind(['+', '-'])?;
        let (c, tz) = rest.split_at(i);
        let sign = if tz.starts_with('-') { -1 } else { 1 };
        let digits: String = tz[1..].chars().filter(|c| *c != ':').collect();
        if !digits.bytes().all(|c| c.is_ascii_digit()) || !matches!(digits.len(), 2 | 4) || (tz[1..].contains(':') && tz.len() != 6) {
            return None;
        }
        let hh: i64 = digits.get(0..2)?.parse().ok()?;
        let mm: i64 = if digits.len() == 4 { digits.get(2..4)?.parse().ok()? } else { 0 };
        if hh > 23 || mm > 59 {
            return None;
        }
        (c, sign * (hh * 60 + mm))
    };
    // 時間：HH:MM、HH:MM:SS、HH:MM:SS.小數
    let (hms, frac) = match clock.split_once('.') {
        Some((h, f)) => (h, Some(f)),
        None => (clock, None),
    };
    if frac.is_some_and(|f| f.is_empty() || !f.bytes().all(|c| c.is_ascii_digit())) {
        return None;
    }
    let hms = match hms.len() {
        5 if frac.is_none() => format!("{hms}:00"),
        8 => hms.to_string(),
        _ => return None,
    };
    let utc = crate::claude_quota::parse_iso_secs(&format!("{date}T{hms}Z"))?;
    Some(utc - off_min * 60_000)
}

/// 認不得的時間字串的「形狀」（給 log 用，不記原值）：數字→d、字母→a（T、Z 保留），標點與空白照留，其他→x；最多 40 字
pub(crate) fn iso_shape(s: &str) -> String {
    s.chars()
        .take(40)
        .map(|c| match c {
            '0'..='9' => 'd',
            'T' | 'Z' => c,
            c if c.is_ascii_alphabetic() => 'a',
            c if c.is_ascii_punctuation() || c == ' ' => c,
            _ => 'x',
        })
        .collect()
}

/// Grok 回應裡的重置時間有值、但格式認不得時，回它的形狀（給 log；#1195）
pub(crate) fn grok_reset_shape(v: &Value) -> Option<String> {
    let end = v["config"]["currentPeriod"]["end"].as_str()?;
    parse_iso_flex(end).is_none().then(|| iso_shape(end))
}

/// auth.json → (email, key)。有好幾筆取 create_time 最新的；欄位不齊回 None。回傳值不得寫進 log。
pub fn grok_login(bytes: &[u8]) -> Option<(String, String)> {
    let v: Value = serde_json::from_slice(bytes).ok()?;
    let email = crate::grok_accounts::email_of_auth(bytes)?;
    let key = v.as_object()?.values().find(|e| e.get("email").and_then(Value::as_str).and_then(normalize_email).as_deref() == Some(email.as_str()))?.get("key")?.as_str()?;
    (!key.is_empty()).then(|| (email, key.to_string()))
}

/// Grok 用量回應 → 每週窗。用量是已用 %，這裡轉成剩餘；欄位是 null 就沒有窗。
pub fn parse_grok(v: &Value, now_ms: i64) -> Vec<Value> {
    let cfg = &v["config"];
    let Some(used) = cfg["creditUsagePercent"].as_f64() else { return vec![] };
    let reset = iso_or_none(cfg["currentPeriod"]["end"].as_str());
    window("weekly", 100.0 - used, reset, now_ms).into_iter().collect()
}

/// MiniMax 用量回應 → 窗。`base_resp.status_code` 不是 0 回 Err（HTTP 永遠 200）；週額度只採用 status 1、2。
pub fn parse_minimax(v: &Value, now_ms: i64) -> Result<Vec<Value>, Failure> {
    if v["base_resp"]["status_code"].as_i64() != Some(0) {
        return Err(Failure::Other("回傳失敗狀態".into()));
    }
    let list = v["model_remains"].as_array().ok_or(Failure::Other("缺少額度欄位".into()))?;
    let row = list.iter().find(|m| m["model_name"] == "general").ok_or(Failure::Other("缺少額度欄位".into()))?;
    let ms_iso = |k: &str| row[k].as_i64().filter(|ms| *ms > 0).map(iso_secs);
    let mut out = vec![];
    if let Some(left) = row["current_interval_remaining_percent"].as_f64() {
        out.extend(window("five_hour", left, ms_iso("end_time"), now_ms));
    }
    if matches!(row["current_weekly_status"].as_i64(), Some(1 | 2)) {
        if let Some(left) = row["current_weekly_remaining_percent"].as_f64() {
            out.extend(window("weekly", left, ms_iso("weekly_end_time"), now_ms));
        }
    }
    Ok(out)
}

/// `agy -p /quota --output-format json` 的輸出 → 狀態列格式，交給 gemini_quota 同一套解析與新舊判斷。
/// 不是內建指令的回應（`/quota` 被當成提示詞）回 None。
pub fn agy_statusline(stdout: &str, email: &str) -> Option<String> {
    let v: Value = serde_json::from_str(stdout.trim_start_matches('\u{feff}').trim()).ok()?;
    if v["status"] != "SUCCESS" {
        return None;
    }
    let data = v.get("command")?.get("data")?;
    let group = data["groups"].as_array()?.iter().find(|g| g["name"] == AGY_GROUP)?;
    let mut quota = serde_json::Map::new();
    for b in group["buckets"].as_array()? {
        let key = match b["window"].as_str() {
            Some("5h") => "gemini-5h",
            Some("weekly") => "gemini-weekly",
            _ => continue,
        };
        quota.insert(key.into(), b.clone());
    }
    Some(json!({ "email": email, "quota": quota }).to_string())
}

/// ASN 開的 agy 視窗最近記下的帳號
pub fn agy_email(home: &Path) -> Option<String> {
    let all = crate::gemini_quota::load_all(home);
    all.into_iter().max_by(|a, b| a.1.quota.at.cmp(&b.1.quota.at).then_with(|| b.0.cmp(&a.0))).map(|(email, _)| email)
}

// ---------- 退避 ----------
/// 失敗的種類。內容只有固定文字或狀態碼，不含對方回應。
#[derive(Debug, Clone, PartialEq)]
pub enum Failure {
    /// 被拒（401、403）：等憑證變了才再試，不重打
    Auth,
    Other(String),
}

/// 失敗的是哪個來源：決定畫面上寫給使用者看的那句話（#1184）
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Source<'a> {
    Grok,
    Gemini,
    MiniMax,
    /// Claude 額外帳號，帶資料夾名
    ClaudeExtra(&'a str),
}

impl Failure {
    /// 給 log 看的文字（內容只有固定文字或狀態碼，不含對方回應）
    pub fn text(&self) -> String {
        match self {
            Failure::Auth => "登入失效，要重新登入".into(),
            Failure::Other(s) => s.clone(),
        }
    }

    /// 給畫面看的文字：登入失效時各家一句使用者看得懂、知道要做什麼的話；其他原因（網路、格式）照舊。
    /// 畫面上不出現 token、路徑、HTTP 狀態碼以外的細節；細節只進 log（用 `text`）。
    pub fn user_text(&self, who: Source) -> String {
        match (self, who) {
            (Failure::Auth, Source::Grok) => "Grok 登入已過期，請在這台開一次 Grok 或重新登入".into(),
            (Failure::Auth, Source::Gemini) => "Gemini 登入已過期，請在這台開一次 agy 或重新登入".into(),
            (Failure::Auth, Source::MiniMax) => "MiniMax 登入已過期，請重新輸入 key".into(),
            (Failure::Auth, Source::ClaudeExtra(name)) => format!("Claude（{name}）登入已過期，請重新登入這個帳號"),
            (Failure::Other(s), Source::ClaudeExtra(name)) => format!("Claude（{name}）：{}", plain_other(s)),
            (Failure::Other(s), _) => plain_other(s),
        }
    }
}

/// 其他原因的畫面文字：「連線失敗」這類使用者看得懂的照舊；狀態碼、結束碼、內部欄位這類細節換成通用句（細節只進 log）
fn plain_other(s: &str) -> String {
    if s.starts_with("HTTP ") || s.starts_with("結束碼") || s.contains("欄位") || s.contains("狀態") {
        "暫時讀不到額度，稍後會自動重試".into()
    } else {
        s.to_string()
    }
}

/// 一個來源的下次讀取時間。`mark` 是憑證的記號（Grok 用 auth.json 的修改時間）：被拒後記號變了才再試。
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Gate {
    next_at: i64,
    fails: u32,
    rejected: Option<Option<i64>>,
}

impl Gate {
    pub fn due(&self, now_ms: i64, mark: Option<i64>) -> bool {
        match self.rejected {
            Some(m) => m != mark,
            None => now_ms >= self.next_at,
        }
    }
    pub fn success(&mut self, now_ms: i64) {
        *self = Gate { next_at: now_ms + READ_EVERY_MS, fails: 0, rejected: None };
    }
    /// 回傳這次要不要記 log：只有第一次失敗或種類變成被拒才記，避免每輪洗版
    pub fn failure(&mut self, f: &Failure, now_ms: i64, mark: Option<i64>) -> bool {
        let first = self.fails == 0 || (*f == Failure::Auth && self.rejected.is_none());
        self.fails = self.fails.saturating_add(1);
        let wait = READ_EVERY_MS.saturating_mul(1i64 << (self.fails - 1).min(16)).min(BACKOFF_MAX_MS);
        self.next_at = now_ms + wait;
        self.rejected = (*f == Failure::Auth).then_some(mark);
        first
    }
}

// ---------- 讀到的數字（只在記憶體，重開就沒了，下一輪再讀） ----------
#[derive(Debug, Clone, Default)]
pub struct Store {
    grok: HashMap<String, (Vec<Value>, i64)>,
    minimax: HashMap<String, (Vec<Value>, i64)>,
    extra_claude: HashMap<String, (Vec<Value>, i64)>,
}

static STORE: Mutex<Option<Store>> = Mutex::new(None);
/// 各來源最近一次的失敗原因（成功就清掉），給設定頁看。內容只有固定文字或狀態碼。
static FAILURES: std::sync::LazyLock<Mutex<HashMap<String, String>>> = std::sync::LazyLock::new(|| Mutex::new(HashMap::new()));
fn set_failure(who: &str, text: Option<String>) {
    let mut f = FAILURES.lock().unwrap_or_else(|e| e.into_inner());
    match text {
        Some(t) => f.insert(who.to_string(), t),
        None => f.remove(who),
    };
}

fn store<R>(f: impl FnOnce(&mut Store) -> R) -> R {
    let mut g = STORE.lock().unwrap_or_else(|e| e.into_inner());
    f(g.get_or_insert_with(Store::default))
}

impl Store {
    pub fn grok_windows(&self, now_ms: i64) -> HashMap<String, Vec<Value>> {
        self.grok.iter().filter(|(_, (w, at))| !w.is_empty() && now_ms - at < KEEP_MS).map(|(e, (w, _))| (e.clone(), w.clone())).collect()
    }
    pub fn minimax_rows(&self, now_ms: i64) -> Vec<Value> {
        let mut emails: Vec<&String> = self.minimax.keys().collect();
        emails.sort();
        emails
            .into_iter()
            .take(MAX_MINIMAX)
            .filter_map(|e| {
                let (w, at) = &self.minimax[e];
                (!w.is_empty() && now_ms - at < KEEP_MS).then(|| json!({ "vendor": "minimax", "email": e, "plan": "", "current": true, "windows": w }))
            })
            .collect()
    }
    /// Claude 額外帳號：email → 窗
    pub fn extra_claude_windows(&self, now_ms: i64) -> HashMap<String, Vec<Value>> {
        self.extra_claude.iter().filter(|(_, (w, at))| !w.is_empty() && now_ms - at < KEEP_MS).map(|(e, (w, _))| (e.clone(), w.clone())).collect()
    }
    /// 設定關掉的來源，數字立刻不送
    pub fn retain(&mut self, s: &Settings) {
        if !s.grok {
            self.grok.clear();
        }
        self.minimax.retain(|e, _| s.minimax.contains(e));
        if !s.extra_claude {
            self.extra_claude.clear();
        }
    }
}

/// 給回報用：現在可以送的 Grok 窗（email → 窗）與 MiniMax 列
pub fn report_extras(now_ms: i64) -> ReaderExtras {
    store(|s| ReaderExtras { grok: s.grok_windows(now_ms), minimax: s.minimax_rows(now_ms), extra_claude: s.extra_claude_windows(now_ms) })
}

/// 這一輪回報要帶的東西
#[derive(Debug, Default, Clone)]
pub struct ReaderExtras {
    pub grok: HashMap<String, Vec<Value>>,
    pub minimax: Vec<Value>,
    pub extra_claude: HashMap<String, Vec<Value>>,
}

// ---------- 連網 ----------
pub(crate) fn client() -> Result<reqwest::Client, Failure> {
    reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(HTTP_TIMEOUT_SECS))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| Failure::Other("連線失敗".into()))
}

pub(crate) async fn get_json(req: reqwest::RequestBuilder) -> Result<Value, Failure> {
    let resp = req.send().await.map_err(|_| Failure::Other("連線失敗".into()))?;
    let status = resp.status();
    if status == 401 || status == 403 {
        return Err(Failure::Auth);
    }
    if !status.is_success() {
        return Err(Failure::Other(format!("HTTP {}", status.as_u16())));
    }
    resp.json().await.map_err(|_| Failure::Other("回應格式不對".into()))
}

/// 回（窗, 重置時間格式認不得時的形狀）
async fn read_grok(key: &str, now_ms: i64) -> Result<(Vec<Value>, Option<String>), Failure> {
    let req = client()?.get(GROK_URL).bearer_auth(key).header("x-xai-token-auth", "xai-grok-cli").header("user-agent", "asn-quota-reader");
    let v = get_json(req).await?;
    Ok((parse_grok(&v, now_ms), grok_reset_shape(&v)))
}

async fn read_minimax(key: &str, now_ms: i64) -> Result<Vec<Value>, Failure> {
    let req = client()?.get(MINIMAX_URL).bearer_auth(key).header("user-agent", "asn-quota-reader");
    parse_minimax(&get_json(req).await?, now_ms)
}

async fn read_agy(home: &Path, email: &str, now_ms: i64) -> Result<(), Failure> {
    let bin = crate::agent_tools::resolve_binary("agy").ok_or(Failure::Other("找不到 agy".into()))?;
    let null = if cfg!(windows) { "NUL" } else { "/dev/null" };
    let args = ["-p", "/quota", "--output-format", "json", "--log-file", null];
    let out = run_with_timeout(bin.as_os_str(), &args, &[("AGY_CLI_DISABLE_AUTO_UPDATE", "true")], std::time::Duration::from_secs(AGY_TIMEOUT_SECS)).await?;
    if !out.status.success() {
        return Err(Failure::Other("結束碼不是 0".into()));
    }
    let line = agy_statusline(&String::from_utf8_lossy(&out.stdout), email).ok_or(Failure::Other("沒有回傳額度資料".into()))?;
    let reading = crate::gemini_quota::parse_statusline(&line, now_ms).ok_or(Failure::Other("沒有回傳額度資料".into()))?;
    crate::gemini_quota::record(home, &reading, now_ms).map(|_| ()).map_err(|_| Failure::Other("寫入失敗".into()))
}

/// 跑外部程式，逾時就收掉自己開的這一棵。`kill_on_drop` 只收得到直接的程序，
/// `resolve_binary` 可能回包裝腳本（npm 的 `.cmd`），底下還有子程序，所以要趁它還在時用 taskkill /T。
async fn run_with_timeout(program: &std::ffi::OsStr, args: &[&str], envs: &[(&str, &str)], limit: std::time::Duration) -> Result<std::process::Output, Failure> {
    let child = tokio::process::Command::new(program)
        .args(args)
        .envs(envs.iter().copied())
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true)
        .no_window()
        .spawn()
        .map_err(|_| Failure::Other("無法執行".into()))?;
    let pid = child.id();
    let wait = child.wait_with_output();
    tokio::pin!(wait);
    match tokio::time::timeout(limit, &mut wait).await {
        Ok(r) => r.map_err(|_| Failure::Other("無法執行".into())),
        Err(_) => {
            kill_tree(pid).await;
            Err(Failure::Other("逾時".into()))
        }
    }
}

#[cfg(windows)]
async fn kill_tree(pid: Option<u32>) {
    let Some(pid) = pid else { return };
    let pid = pid.to_string();
    let _ = tokio::process::Command::new("taskkill").no_window().args(["/PID", &pid, "/T", "/F"]).output().await;
}
#[cfg(not(windows))]
async fn kill_tree(_pid: Option<u32>) {}

/// 這一輪要不要因為空記憶體不夠跳過 agy。讀不到就照跑，跟其他背景工作一樣。
fn agy_paused(free_bytes: Option<u64>) -> bool {
    free_bytes.is_some_and(|b| b < AGY_PAUSE_BELOW_BYTES)
}

fn modified_ms(path: &Path) -> Option<i64> {
    let t = std::fs::metadata(path).ok()?.modified().ok()?;
    t.duration_since(std::time::UNIX_EPOCH).ok().map(|d| d.as_millis() as i64)
}

// ---------- MiniMax key：Windows 憑證管理員 ----------
fn cred_target(email: &str) -> String {
    format!("ASN/quota-minimax/{email}")
}

#[cfg(windows)]
pub mod cred {
    use windows_sys::Win32::Foundation::FILETIME;
    use windows_sys::Win32::Security::Credentials::{CredDeleteW, CredFree, CredReadW, CredWriteW, CREDENTIALW, CRED_PERSIST_LOCAL_MACHINE, CRED_TYPE_GENERIC};

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }

    pub fn read(target: &str) -> Option<String> {
        let name = wide(target);
        let mut p: *mut CREDENTIALW = std::ptr::null_mut();
        // SAFETY: name 以 0 結尾且活到呼叫結束；p 成功時由系統配置，下面讀完就 CredFree。
        unsafe {
            if CredReadW(name.as_ptr(), CRED_TYPE_GENERIC, 0, &mut p) == 0 || p.is_null() {
                return None;
            }
            let c = &*p;
            // 空的憑證 CredentialBlob 可能是 null，不能拿去建 slice
            let bytes = if c.CredentialBlob.is_null() || c.CredentialBlobSize == 0 { vec![] } else { std::slice::from_raw_parts(c.CredentialBlob, c.CredentialBlobSize as usize).to_vec() };
            CredFree(p as *const _);
            String::from_utf8(bytes).ok().filter(|s| !s.is_empty())
        }
    }

    pub fn write(target: &str, secret: &str) -> Result<(), String> {
        let mut name = wide(target);
        let mut blob = secret.as_bytes().to_vec();
        let c = CREDENTIALW {
            Flags: 0,
            Type: CRED_TYPE_GENERIC,
            TargetName: name.as_mut_ptr(),
            Comment: std::ptr::null_mut(),
            LastWritten: FILETIME { dwLowDateTime: 0, dwHighDateTime: 0 },
            CredentialBlobSize: blob.len() as u32,
            CredentialBlob: blob.as_mut_ptr(),
            Persist: CRED_PERSIST_LOCAL_MACHINE,
            AttributeCount: 0,
            Attributes: std::ptr::null_mut(),
            TargetAlias: std::ptr::null_mut(),
            UserName: std::ptr::null_mut(),
        };
        // SAFETY: c 指向的緩衝區都活到呼叫結束，系統會自己複製一份。
        if unsafe { CredWriteW(&c, 0) } == 0 {
            return Err("無法存入憑證管理員".into());
        }
        Ok(())
    }

    pub fn delete(target: &str) {
        let name = wide(target);
        // SAFETY: name 以 0 結尾且活到呼叫結束；沒有這筆時只是回傳失敗。
        unsafe { CredDeleteW(name.as_ptr(), CRED_TYPE_GENERIC, 0) };
    }
}

#[cfg(windows)]
fn minimax_key(email: &str) -> Option<String> {
    cred::read(&cred_target(email))
}
#[cfg(not(windows))]
fn minimax_key(_email: &str) -> Option<String> {
    None
}

#[cfg(windows)]
fn store_minimax_key(email: &str, key: &str) -> Result<(), String> {
    cred::write(&cred_target(email), key)
}
#[cfg(not(windows))]
fn store_minimax_key(_email: &str, _key: &str) -> Result<(), String> {
    Err("這台電腦不支援".into())
}
#[cfg(windows)]
fn delete_minimax_key(email: &str) {
    cred::delete(&cred_target(email));
}
#[cfg(not(windows))]
fn delete_minimax_key(_email: &str) {}

// ---------- 定時讀取 ----------
#[derive(Default)]
struct Gates {
    grok: Gate,
    agy: Gate,
    minimax: HashMap<String, Gate>,
    extra_claude: HashMap<String, Gate>,
}

fn note(log: &(impl Fn(String) + Sync), gate: &mut Gate, who: &str, f: &Failure, now_ms: i64, mark: Option<i64>) {
    let (key, src) = if who == "Grok" { ("grok", Source::Grok) } else { ("agy", Source::Gemini) };
    set_failure(key, Some(f.user_text(src)));
    if gate.failure(f, now_ms, mark) {
        log(format!("額度讀取 {who}：{}", f.text()));
    }
}

fn note_minimax(log: &(impl Fn(String) + Sync), gate: &mut Gate, email: &str, f: &Failure, now_ms: i64) {
    set_failure(&format!("minimax:{email}"), Some(f.user_text(Source::MiniMax)));
    if gate.failure(f, now_ms, None) {
        log(format!("額度讀取 MiniMax：{}", f.text()));
    }
}

async fn tick(home: &Path, grok_home: &Path, gates: &mut Gates, now_ms: i64, free_bytes: Option<u64>, log: &(impl Fn(String) + Sync)) {
    let s = load_settings(home);
    store(|st| st.retain(&s));
    if s.grok {
        let path = grok_home.join(".grok").join("auth.json");
        let mark = modified_ms(&path);
        if gates.grok.due(now_ms, mark) {
            match std::fs::read(&path).ok().as_deref().and_then(grok_login) {
                None => note(log, &mut gates.grok, "Grok", &Failure::Other("沒有登入資料".into()), now_ms, mark),
                Some((email, key)) => match read_grok(&key, now_ms).await {
                    Ok((w, shape)) => {
                        if let Some(shape) = shape {
                            log(format!("額度讀取 Grok：重置時間的格式不認得（形狀 {shape}）"));
                        }
                        gates.grok.success(now_ms);
                        set_failure("grok", None);
                        store(|st| st.grok.insert(email, (w, now_ms)));
                    }
                    Err(f) => note(log, &mut gates.grok, "Grok", &f, now_ms, mark),
                },
            }
        }
    }
    for email in &s.minimax {
        let gate = gates.minimax.entry(email.clone()).or_default();
        // key 在憑證管理員看不到修改時間：被拒後要重開 ASN 或換 key（設定畫面會清掉這個狀態）才再試
        if !gate.due(now_ms, None) {
            continue;
        }
        match minimax_key(email) {
            None => note_minimax(log, gate, email, &Failure::Other("找不到 key".into()), now_ms),
            Some(key) => match read_minimax(&key, now_ms).await {
                Ok(w) => {
                    gate.success(now_ms);
                    set_failure(&format!("minimax:{email}"), None);
                    store(|st| st.minimax.insert(email.clone(), (w, now_ms)));
                }
                Err(f) => note_minimax(log, gate, email, &f, now_ms),
            },
        }
    }
    // 空記憶體不夠：跳過這一輪，不算失敗，下一分鐘再看
    if s.extra_claude {
        for (name, dir) in crate::claude_extra::dirs(home) {
            let gate = gates.extra_claude.entry(name.clone()).or_default();
            let mark = crate::claude_extra::modified_ms(&dir);
            if !gate.due(now_ms, mark) {
                continue;
            }
            match crate::claude_extra::read_dir(home, &name, &dir, s.extra_claude_refresh, now_ms).await {
                Ok((email, w)) => {
                    gate.success(now_ms);
                    set_failure(&format!("claude:{name}"), None);
                    store(|st| st.extra_claude.insert(email, (w, now_ms)));
                }
                Err(f) => {
                    set_failure(&format!("claude:{name}"), Some(f.user_text(Source::ClaudeExtra(&name))));
                    // 換新可能剛改過憑證檔，記號要用失敗後的：沒變就不再試
                    if gate.failure(&f, now_ms, crate::claude_extra::modified_ms(&dir)) {
                        log(format!("額度讀取 Claude 額外帳號 {name}：{}", f.text()));
                    }
                }
            }
        }
    }
    if s.agy && !agy_paused(free_bytes) && gates.agy.due(now_ms, None) {
        match agy_email(home) {
            // 還沒開過 agy 視窗，不知道是哪個帳號：不算失敗，下一輪再看
            None => gates.agy.success(now_ms),
            Some(email) => match read_agy(home, &email, now_ms).await {
                Ok(()) => {
                    gates.agy.success(now_ms);
                    set_failure("agy", None);
                }
                Err(f) => note(log, &mut gates.agy, "agy", &f, now_ms, None),
            },
        }
    }
}

/// 背景迴圈：每分鐘看一次設定與時間，全關時不連網、不執行任何程式。
pub async fn run_loop(home: PathBuf, grok_home: PathBuf, free_bytes: impl Fn() -> Option<u64>, log: impl Fn(String) + Sync) {
    let mut gates = Gates::default();
    let mut seen = CHANGES.load(std::sync::atomic::Ordering::SeqCst);
    loop {
        // 設定頁動過：換了 key、重新打開都不用等退避。失敗原因也清掉，下一次讀取再算。
        let now_changes = CHANGES.load(std::sync::atomic::Ordering::SeqCst);
        if now_changes != seen {
            seen = now_changes;
            gates = Gates::default();
            FAILURES.lock().unwrap_or_else(|e| e.into_inner()).clear();
        }
        tick(&home, &grok_home, &mut gates, crate::heartbeat::now_ms() as i64, free_bytes(), &log).await;
        tokio::time::sleep(std::time::Duration::from_secs(60)).await;
    }
}

#[cfg(test)]
mod tests;

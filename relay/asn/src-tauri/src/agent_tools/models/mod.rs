//! 各家 AI CLI「現在能選哪些型號」的探測（#2353 第①階段）。統一結構、統一逾時、統一快取：
//!
//! | 家 | 指令 | 逾時 |
//! |---|---|---|
//! | pi（`"pi"`） | `pi --list-models`（表格；只列已設好憑證的提供者） | 10 秒 |
//! | agy（`"gemini"`） | `agy models`（stdout 每行「代號<Tab>顯示名」） | 10 秒（切換驗證另用 20 秒） |
//! | Codex（`"codex"`） | `codex debug models`（JSON，不用登入、不開 session）；只列 `visibility == "list"` | 10 秒 |
//! | Claude（`"claude"`） | **沒有列型號的指令**：固定回「讀不到」，絕不寫死清單 | — |
//!
//! 快取：成功 10 分鐘、失敗只記 1 分鐘（不要每次回報都重打壞掉的指令）；`snapshot` 只讀快取、不等，
//! 過期或還沒有時在背景重查一次（同時只跑一個），所以第一次回報不會卡住。
//! 結果裡的 `reason` 是給 log 看的，**序列化時一定不輸出**（`#[serde(skip)]`）：上傳的只有固定代碼 `code`，畫面上的白話字由前端依 status／code 決定。
//! 隱私：只收代號與顯示名，不碰路徑、憑證、帳號、原因原文。
//!
//! 摘要裡的形狀（`models` 陣列，每家一筆；與後台 `sanitizeModels` 收的完全一致）：
//! `{vendor, status, code?, stale?, age_s?, models:[{id,name}]}`。status：ok／unavailable／error／pending；
//! pending＝第一次還沒有結果（讀取中）；stale＝重查失敗、沿用上次的清單（status 仍是 ok，code 是這次失敗的原因，age_s＝這份清單距今幾秒）。
mod parse;
pub mod query;
mod redact;
mod run;

pub use redact::mask_reason;
pub use crate::model_id::{valid_model_id, MODEL_ID_PATTERN};
pub use parse::{parse_agy, parse_codex, parse_pi, MAX_MODELS, REPORT_FLOOR_BYTES, REPORT_MAX_BYTES, REPORT_MAX_MODELS};
pub use run::{run, run_blocking, RunFail, Spawn};

use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::ffi::OsString;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

/// 單次探測最多等多久
pub const PROBE_TIMEOUT: Duration = Duration::from_secs(10);
/// 成功的結果記多久
pub const OK_TTL: Duration = Duration::from_secs(600);
/// 失敗（讀不到、出錯）的結果記多久
pub const FAIL_TTL: Duration = Duration::from_secs(60);
/// 「沒安裝」記多久：不用每分鐘白查一次，但使用者裝好後也不能等太久
pub const NOT_INSTALLED_TTL: Duration = Duration::from_secs(600);
/// 回報時 pi 的每家上限（與後台一致；其他家用 `REPORT_MAX_MODELS`）。pi 要與 `pi_models`（200 筆）並行一版，不能比它少
pub const PI_REPORT_MAX_MODELS: usize = 200;
/// `age_s` 的上限（與後台一致：一年）
const AGE_S_MAX: u64 = 31_536_000;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ModelEntry {
    pub id: String,
    pub name: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Status {
    /// 讀到了（至少一筆）
    Ok,
    /// 這家沒有列型號的方式、沒安裝、或 CLI 沒列出任何型號
    Unavailable,
    /// 該讀卻失敗了（逾時、非 0 結束、輸出壞掉…）
    Error,
    /// 第一次還沒有任何結果（讀取中；清單一定是空的）
    Pending,
}

/// 固定代碼：只有這幾個值會上雲（原因原文留在本機 log）。與後台 `MODEL_CODE` 逐字相同
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Code {
    Ok,
    NotInstalled,
    NotLoggedIn,
    Timeout,
    TooLarge,
    ParseFailed,
    SpawnFailed,
    Unsupported,
}

impl Code {
    pub const ALL: [Code; 8] = [Code::Ok, Code::NotInstalled, Code::NotLoggedIn, Code::Timeout, Code::TooLarge, Code::ParseFailed, Code::SpawnFailed, Code::Unsupported];
    /// 與序列化出去的字串相同（寫 log 用）
    pub fn as_str(self) -> &'static str {
        match self {
            Code::Ok => "ok",
            Code::NotInstalled => "not_installed",
            Code::NotLoggedIn => "not_logged_in",
            Code::Timeout => "timeout",
            Code::TooLarge => "too_large",
            Code::ParseFailed => "parse_failed",
            Code::SpawnFailed => "spawn_failed",
            Code::Unsupported => "unsupported",
        }
    }
}

/// 讀取失敗 → 固定代碼。結束碼不是 0、讀到一半出 IO 錯誤，都是「CLI 起來了但沒給出結果」，歸 spawn_failed（解析不出來才是 parse_failed）
pub fn code_of(e: &RunFail) -> Code {
    match e {
        RunFail::Timeout => Code::Timeout,
        RunFail::TooLarge => Code::TooLarge,
        RunFail::Spawn(_) | RunFail::Exit(_) | RunFail::Io(_) => Code::SpawnFailed,
    }
}

#[derive(Clone, PartialEq, Eq, Serialize)]
pub struct VendorModels {
    pub vendor: String,
    pub status: Status,
    /// 固定代碼；pending 沒有
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<Code>,
    /// 重查失敗、沿用上次成功的清單（status 維持 ok，code 是這次失敗的原因）
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub stale: bool,
    /// stale 時：這份清單距上次成功讀到幾秒
    #[serde(skip_serializing_if = "Option::is_none")]
    pub age_s: Option<u64>,
    pub models: Vec<ModelEntry>,
    /// 給 log 看的原因（Ok 時為空）。**絕不序列化**：原文可能帶路徑、帳號、環境值
    #[serde(skip)]
    pub reason: String,
}

/// 手寫：`{:?}` 不印原因原文（可能帶路徑、帳號、金鑰），只說有幾個字；要看原因請走 `failure_log_line`（遮罩過）
impl std::fmt::Debug for VendorModels {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("VendorModels")
            .field("vendor", &self.vendor)
            .field("status", &self.status)
            .field("code", &self.code)
            .field("stale", &self.stale)
            .field("age_s", &self.age_s)
            .field("models", &self.models)
            .field("reason", &format_args!("<已遮蔽 {} 字>", self.reason.chars().count()))
            .finish()
    }
}

/// 探測沒讀到型號時寫進本機 ui.log 的那一行：廠牌、狀態、固定代碼、遮罩後的原因。
/// 讀到了（code＝ok）與讀取中（pending）不寫；沿用舊清單（status 仍是 ok、code 是失敗原因）要寫
pub fn failure_log_line(v: &VendorModels) -> Option<String> {
    let code = v.code?;
    if code == Code::Ok || v.status == Status::Pending {
        return None;
    }
    let status = match v.status {
        Status::Ok => "ok",
        Status::Unavailable => "unavailable",
        Status::Error => "error",
        Status::Pending => "pending",
    };
    let stale = if v.stale { " stale=true" } else { "" };
    Some(format!("[型號探測] vendor={} status={status} code={}{stale} reason={}", v.vendor, code.as_str(), mask_reason(&v.reason)))
}

impl VendorModels {
    fn new(v: Vendor, status: Status, code: Option<Code>, models: Vec<ModelEntry>, reason: impl Into<String>) -> Self {
        VendorModels { vendor: v.id().into(), status, code, stale: false, age_s: None, models, reason: reason.into() }
    }
    pub fn unavailable(v: Vendor, code: Code, reason: impl Into<String>) -> Self {
        Self::new(v, Status::Unavailable, Some(code), vec![], reason)
    }
    pub fn error(v: Vendor, code: Code, reason: impl Into<String>) -> Self {
        Self::new(v, Status::Error, Some(code), vec![], reason)
    }
    /// 第一次還沒有結果（讀取中）
    pub fn pending(v: Vendor) -> Self {
        Self::new(v, Status::Pending, None, vec![], "尚未讀取")
    }
    /// 一家的原始輸出 → 結果。**有輸出卻一筆都解析不出來＝解析失敗**（error／parse_failed），不能叫人去登入；
    /// 只有真的沒輸出（去掉空白與 BOM 後是空的）才算「沒列出任何型號」。Codex 不需要登入，空清單一律是解析失敗
    pub fn from_text(v: Vendor, text: &str) -> Self {
        let blank = text.trim_matches(|c: char| c.is_whitespace() || c == '\u{feff}').is_empty();
        let list = match v {
            Vendor::Pi => parse_pi(text),
            Vendor::Gemini => parse_agy(text),
            _ => match parse_codex(text) {
                Ok(l) => l,
                Err(e) => return Self::error(v, Code::ParseFailed, e),
            },
        };
        if !list.is_empty() {
            return Self::from_list(v, list);
        }
        if v == Vendor::Codex {
            return Self::error(v, Code::ParseFailed, "輸出是合法的 JSON，但沒有可列出的型號");
        }
        if blank {
            return Self::from_list(v, list);
        }
        Self::error(v, Code::ParseFailed, format!("{} 有輸出（{} 字）但一筆型號都解析不出來", v.binary(), text.chars().count()))
    }
    /// 解析完的結果：空的算 Unavailable（多半是還沒登入）。**只給「真的沒輸出」用**，有輸出的走 `from_text`
    fn from_list(v: Vendor, list: Vec<ModelEntry>) -> Self {
        if list.is_empty() {
            Self::unavailable(v, Code::NotLoggedIn, "CLI 沒有列出任何型號（可能還沒登入）")
        } else {
            Self::new(v, Status::Ok, Some(Code::Ok), list, "")
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Vendor {
    Claude,
    Codex,
    /// agy（目錄上的廠牌 id 是 gemini）
    Gemini,
    Pi,
}

impl Vendor {
    pub const ALL: [Vendor; 4] = [Vendor::Claude, Vendor::Codex, Vendor::Gemini, Vendor::Pi];
    pub fn id(self) -> &'static str {
        match self {
            Vendor::Claude => "claude",
            Vendor::Codex => "codex",
            Vendor::Gemini => "gemini",
            Vendor::Pi => "pi",
        }
    }
    fn binary(self) -> &'static str {
        match self {
            Vendor::Claude => "claude",
            Vendor::Codex => "codex",
            Vendor::Gemini => "agy",
            Vendor::Pi => "pi",
        }
    }
}

// ---------------------------------------------------------------------------------------------------------------------
// 快取（單一飛行：同一家同時只重查一次）
// ---------------------------------------------------------------------------------------------------------------------

#[derive(Default)]
pub struct ProbeCache {
    slots: Mutex<HashMap<Vendor, Slot>>,
    busy: Mutex<HashSet<Vendor>>,
}

/// 搶到「這家正在重查」的旗標；放掉（包括重查中途 panic）旗標就自動收回
pub struct Claim {
    cache: &'static ProbeCache,
    vendor: Vendor,
}

impl Claim {
    pub fn finish(self, value: VendorModels) {
        self.cache.put(self.vendor, value, Instant::now());
    }
}

impl Drop for Claim {
    fn drop(&mut self) {
        self.cache.busy.lock().unwrap_or_else(|e| e.into_inner()).remove(&self.vendor);
    }
}

/// 快取的一格。`at`＝這格寫入的時間（TTL 從這算）；`ok_at`＝清單上次成功讀到的時間（stale 時比 `at` 早，算 `age_s` 用）。
/// 沿用舊清單（`value.stale`）也只記 1 分鐘，很快再試
struct Slot {
    at: Instant,
    ok_at: Instant,
    value: VendorModels,
}

fn ttl_for(slot: &Slot) -> Duration {
    match (slot.value.status, slot.value.code) {
        (Status::Ok, _) if !slot.value.stale => OK_TTL,
        (Status::Unavailable, Some(Code::NotInstalled)) => NOT_INSTALLED_TTL,
        _ => FAIL_TTL,
    }
}

impl ProbeCache {
    /// 寫入一次探測結果。**失敗（Error）不蓋掉上次成功的清單**：格子裡已經有讀到型號的結果時，保留那份舊清單，
    /// 狀態仍是 Ok，標 `stale`、`code` 換成這次失敗的原因，`reason` 註明「重查失敗，沿用上次的清單」；下一次重查在 1 分鐘後
    pub fn put(&self, vendor: Vendor, value: VendorModels, now: Instant) {
        // ui.log（elog 在有視窗的建置會同步寫檔）；原因先遮罩才出去
        self.put_logged(vendor, value, now, &mut |line| elog!("{line}"));
    }

    /// `put`，記錄的出口由呼叫端給（測試用它收集要寫的那一行）。每次得到「沒讀到型號」的結果（含沿用舊清單）都寫一行
    fn put_logged(&self, vendor: Vendor, value: VendorModels, now: Instant, log: &mut dyn FnMut(&str)) {
        let mut g = self.slots.lock().unwrap_or_else(|e| e.into_inner());
        let slot = match g.get(&vendor) {
            Some(old) if value.status == Status::Error && old.value.status == Status::Ok && !old.value.models.is_empty() => {
                let mut kept = old.value.clone();
                kept.reason = format!("重查失敗，沿用上次的清單（{}）", value.reason);
                kept.stale = true;
                kept.code = value.code;
                Slot { at: now, ok_at: old.ok_at, value: kept }
            }
            _ => Slot { at: now, ok_at: now, value },
        };
        if let Some(line) = failure_log_line(&slot.value) {
            log(&line);
        }
        g.insert(vendor, slot);
    }

    fn lookup(&self, vendor: Vendor, now: Instant) -> Option<(VendorModels, bool)> {
        let g = self.slots.lock().unwrap_or_else(|e| e.into_inner());
        g.get(&vendor).map(|s| {
            let mut v = s.value.clone();
            if v.stale {
                v.age_s = Some(now.saturating_duration_since(s.ok_at).as_secs().min(AGE_S_MAX));
            }
            (v, now.saturating_duration_since(s.at) < ttl_for(s))
        })
    }

    /// 目前的結果（不管過期；還沒有就是 pending）
    pub fn current(&self, vendor: Vendor, now: Instant) -> VendorModels {
        self.lookup(vendor, now).map(|(v, _)| v).unwrap_or_else(|| VendorModels::pending(vendor))
    }

    /// 還新鮮的結果（過期或沒有＝None）
    pub fn fresh(&self, vendor: Vendor, now: Instant) -> Option<VendorModels> {
        self.lookup(vendor, now).and_then(|(v, ok)| ok.then_some(v))
    }

    /// 搶「這家正在重查」的旗標；已經有人在查就回 None
    pub fn claim(&'static self, vendor: Vendor) -> Option<Claim> {
        let claimed = self.busy.lock().unwrap_or_else(|e| e.into_inner()).insert(vendor);
        // 注意用 then（惰性）：沒搶到時不能先建出 Claim 又立刻放掉，那會把別人的旗標清掉
        claimed.then(|| Claim { cache: self, vendor })
    }

    fn is_busy(&self, vendor: Vendor) -> bool {
        self.busy.lock().unwrap_or_else(|e| e.into_inner()).contains(&vendor)
    }

    /// 等別人把這家查完（最多 `max`）
    async fn wait_idle(&self, vendor: Vendor, max: Duration, step: Duration) {
        let start = Instant::now();
        while self.is_busy(vendor) && start.elapsed() < max {
            tokio::time::sleep(step).await;
        }
    }

    /// 只讀、不等：回目前的結果（過期的也先用；第一次還沒有就回 pending）；
    /// 需要重查且沒有別人正在查時，另外回一個 `Claim`，呼叫端要在背景查完後 `finish`。
    /// Claude 沒有列型號的方式：永遠回「不支援」、永不排重查（不然每輪回報都白排一個什麼都不做的背景工作）
    pub fn begin(&'static self, vendor: Vendor, now: Instant) -> (VendorModels, Option<Claim>) {
        if vendor == Vendor::Claude {
            return (claude_unsupported(), None);
        }
        let (value, fresh) = match self.lookup(vendor, now) {
            Some((v, fresh)) => (v, fresh),
            None => (VendorModels::pending(vendor), false),
        };
        if fresh {
            return (value, None);
        }
        (value, self.claim(vendor))
    }
}

fn claude_unsupported() -> VendorModels {
    VendorModels::unavailable(Vendor::Claude, Code::Unsupported, "Claude 沒有列出型號的方式（claude --help 只有 --model）")
}

fn global() -> &'static ProbeCache {
    static C: OnceLock<ProbeCache> = OnceLock::new();
    C.get_or_init(ProbeCache::default)
}

// ---------------------------------------------------------------------------------------------------------------------
// 探測
// ---------------------------------------------------------------------------------------------------------------------

/// 目前這個程序的環境。用 `vars_os`：有非 UTF-8 的變數時不會 panic
fn os_vars() -> Vec<(OsString, OsString)> {
    std::env::vars_os().collect()
}

/// 名字與值都是合法 UTF-8 的才留；轉不了的那一個變數略過（不整份丟掉）
pub fn utf8_vars(vars: &[(OsString, OsString)]) -> Vec<(String, String)> {
    vars.iter().filter_map(|(k, v)| Some((k.to_str()?.to_string(), v.to_str()?.to_string()))).collect()
}

/// pi 的子程序環境：**繼承整份環境**（AWS／GOOGLE／代理／nvm 等 pi 要用的都在），只用黑名單拿掉 ASN 自己的金鑰
/// （ASN_RELAY_KEY、ASN_RELAY_ANON_KEY、IRORI_RELAY_KEY、IRORI_RELAY_ANON_KEY，不分大小寫）、繼承來的 CLAUDE*（除 CLAUDE_CONFIG_DIR）、
/// NO_COLOR、WEZTERM_*。與開 pi 視窗用的是同一份規則（`launch::config::child_env_from`）
pub fn pi_env_from(vars: &[(OsString, OsString)]) -> Vec<(String, String)> {
    crate::launch::config::child_env_from(utf8_vars(vars).into_iter()).into_iter().collect()
}

/// agy 的子程序環境：與工作者原生通道列型號時相同的白名單（`acp_clean_env`，不帶任何金鑰類變數）
pub fn agy_env_from(vars: &[(OsString, OsString)]) -> Vec<(String, String)> {
    crate::bridge::engines::acp_clean_env(&utf8_vars(vars), &[])
}

/// Codex 的子程序環境：與其他 Codex 子程序相同（`codex_child_env`：繼承整份，黑名單擋金鑰與視窗識別，保留 CODEX_HOME）
pub fn codex_env_from(vars: &[(OsString, OsString)]) -> Vec<(String, String)> {
    crate::bridge::engines::codex_child_env(&utf8_vars(vars))
}

fn pi_env() -> Vec<(String, String)> {
    pi_env_from(&os_vars())
}

fn spawn_for(v: Vendor, args: &[&str], env: Vec<(String, String)>, merge_stderr: bool) -> Option<Spawn> {
    let program = super::resolve_binary(v.binary())?;
    Some(Spawn { program, args: args.iter().map(|s| s.to_string()).collect(), cwd: None, env, merge_stderr })
}

/// `pi --list-models` 的原始文字（stderr 接在後面，與以前 pi 的行為相同）。pi_models.rs 解析它並留自己的 60 秒快取
pub async fn pi_list_text() -> Result<String, RunFail> {
    let spec = spawn_for(Vendor::Pi, &["--list-models"], pi_env(), true).ok_or_else(|| RunFail::Spawn("沒有 pi".into()))?;
    run(spec, PROBE_TIMEOUT).await
}

/// 同步呼叫端（回報摘要、開窗核對）用
pub fn pi_list_text_blocking() -> Result<String, RunFail> {
    let spec = spawn_for(Vendor::Pi, &["--list-models"], pi_env(), true).ok_or_else(|| RunFail::Spawn("沒有 pi".into()))?;
    run_blocking(spec, PROBE_TIMEOUT)
}

/// 不看快取直接探測一家
pub async fn probe_uncached(v: Vendor) -> VendorModels {
    if v == Vendor::Claude {
        return claude_unsupported();
    }
    let (args, env, merge): (&[&str], _, _) = match v {
        Vendor::Pi => (&["--list-models"], pi_env(), true),
        Vendor::Gemini => (&["models"], agy_env_from(&os_vars()), false),
        _ => (&["debug", "models"], codex_env_from(&os_vars()), false),
    };
    let Some(spec) = spawn_for(v, args, env, merge) else {
        return VendorModels::unavailable(v, Code::NotInstalled, format!("這台電腦找不到 {}", v.binary()));
    };
    let text = match run(spec, PROBE_TIMEOUT).await {
        Ok(t) => t,
        Err(e) => return VendorModels::error(v, code_of(&e), e.reason(v.binary())),
    };
    VendorModels::from_text(v, &text)
}

/// 探測一家；`force`＝略過快取（使用者按了「重新讀取」）。
/// 與 `snapshot` 的背景重查共用「同一家同時只跑一個」的旗標：已經有人在查就等那一個，不再多開一個同家 CLI。
/// `force` 撞上別人正在查時：等對方做完後**再搶一次旗標、自己真的重讀一次**（最多一次），
/// 這樣 force 回的一定是「按下重新讀取之後才讀到的」，不會是按之前就開始的那次查詢的結果；非 force 照舊只等不重讀
pub async fn probe(v: Vendor, force: bool) -> VendorModels {
    probe_in(global(), v, force, || probe_uncached(v)).await
}

async fn probe_in<F, Fut>(c: &'static ProbeCache, v: Vendor, force: bool, fetch: F) -> VendorModels
where
    F: FnOnce() -> Fut,
    Fut: std::future::Future<Output = VendorModels>,
{
    if !force {
        if let Some(f) = c.fresh(v, Instant::now()) {
            return f;
        }
    }
    let (max, step) = (PROBE_TIMEOUT + Duration::from_secs(3), Duration::from_millis(100));
    match c.claim(v) {
        Some(claim) => claim.finish(fetch().await),
        None => {
            c.wait_idle(v, max, step).await;
            if force {
                // 對方是在我按下之前開始的，它的結果不算：旗標放開後再搶一次自己讀（fetch 只在這裡或上面用到一次）。
                // 又被別人搶先就再等一次、不再補查，所以一次 force 最多多讀一次，且旗標仍保證同一家同時只跑一個
                match c.claim(v) {
                    Some(claim) => claim.finish(fetch().await),
                    None => c.wait_idle(v, max, step).await,
                }
            }
        }
    }
    // 回快取裡的那份：重查失敗時是「沿用上次的清單」，不是空的失敗結果
    c.current(v, Instant::now())
}

/// 只讀快取、不等：第一次回報不會卡住。過期或還沒有時在背景重查一次（同時只跑一個）
pub fn snapshot(v: Vendor) -> VendorModels {
    let (value, claim) = global().begin(v, Instant::now());
    if let Some(claim) = claim {
        crate::rt::spawn(async move {
            let r = probe_uncached(v).await;
            claim.finish(r);
        });
    }
    value
}

/// 四家一起的快取摘要（不等）
pub fn snapshot_all() -> Vec<VendorModels> {
    Vendor::ALL.iter().map(|v| snapshot(*v)).collect()
}

/// 序列化成 JSON 後的位元組數（回報上限照這個算，不是只算代號加顯示名）
fn json_len<T: Serialize>(t: &T) -> usize {
    serde_json::to_vec(t).map(|b| b.len()).unwrap_or(usize::MAX / 8)
}

/// 回報前的精簡（R9）：每家最多 `REPORT_MAX_MODELS` 筆、全部合計序列化後的 JSON 最多 `REPORT_MAX_BYTES` 位元組。
/// 超過就從後面截掉並在 reason 說明；一筆都放不下的那家改成 Error。每家有保底額度（`REPORT_FLOOR_BYTES`），
/// 排在前面的不會把後面的吃光。這跟讀取上限（`STDOUT_CAP`）是兩件事
pub fn limit_for_report(list: Vec<VendorModels>) -> Vec<VendorModels> {
    limit_with(list, REPORT_MAX_MODELS, REPORT_MAX_BYTES, REPORT_FLOOR_BYTES)
}

/// 一筆都放不下時狀態會改成 error 並補上 code，先留這麼多位元組的餘裕（reason 不上雲，不算）
const FIELD_SLACK: usize = 40;

/// 這家回報時最多幾筆：pi 放寬到 `PI_REPORT_MAX_MODELS`（與 `pi_models` 並行一版，不能退化），其餘用 `max_models`
fn cap_for(vendor: &str, max_models: usize) -> usize {
    if vendor == Vendor::Pi.id() {
        max_models.max(PI_REPORT_MAX_MODELS)
    } else {
        max_models
    }
}

fn limit_with(list: Vec<VendorModels>, max_models: usize, max_bytes: usize, floor: usize) -> Vec<VendorModels> {
    // 每家的固定部分（欄位、陣列逗號）與每筆型號序列化後的大小（含逗號）
    let sizes: Vec<Vec<usize>> = list.iter().map(|v| v.models.iter().take(cap_for(&v.vendor, max_models)).map(|m| json_len(m) + 1).collect()).collect();
    let base = |v: &VendorModels| json_len(&VendorModels { models: vec![], ..v.clone() }) + FIELD_SLACK + 1;
    let mut used = 2 + list.iter().map(base).sum::<usize>();
    let reserve_after: Vec<usize> = (0..list.len()).map(|i| sizes[i + 1..].iter().map(|s| s.iter().sum::<usize>().min(floor)).sum()).collect();
    list.into_iter()
        .enumerate()
        .map(|(i, mut v)| {
            let total = v.models.len();
            let budget = max_bytes.saturating_sub(used + reserve_after[i]);
            let (mut spent, mut kept) = (0usize, Vec::new());
            for (m, size) in std::mem::take(&mut v.models).into_iter().zip(sizes[i].iter()) {
                if spent + size > budget {
                    break;
                }
                spent += size;
                kept.push(m);
            }
            used += spent;
            if kept.len() < total {
                if kept.is_empty() {
                    v.status = Status::Error;
                    v.code = Some(Code::TooLarge);
                    v.stale = false;
                    v.age_s = None;
                    v.reason = format!("超過回報上限，{total} 筆都放不下");
                } else {
                    v.reason = format!("回報時截斷：只留前 {} 筆（共 {total} 筆）", kept.len());
                }
            }
            v.models = kept;
            v
        })
        .collect()
}

/// 要放進回報的四家快取摘要（不等、已套回報上限）
pub fn report_snapshot() -> Vec<VendorModels> {
    limit_for_report(snapshot_all())
}

/// 放進 launch 摘要 `models` 欄位的 JSON 陣列（不等探測、已套回報上限；不含 `reason`）
pub fn report_value() -> serde_json::Value {
    to_report_value(&report_snapshot())
}

fn to_report_value(list: &[VendorModels]) -> serde_json::Value {
    serde_json::to_value(list).unwrap_or(serde_json::Value::Null)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn many(v: Vendor, n: usize, width: usize) -> VendorModels {
        let models = (0..n).map(|i| ModelEntry { id: format!("{i:0>w$}", w = width), name: "n".repeat(width) }).collect();
        VendorModels::from_list(v, models)
    }

    #[test]
    fn 回報上限_每家五十筆_超過截斷並說明_跟讀取上限是兩回事() {
        let r = limit_for_report(vec![many(Vendor::Codex, 60, 5), many(Vendor::Gemini, 10, 5)]);
        assert_eq!((r[0].models.len(), r[0].status), (REPORT_MAX_MODELS, Status::Ok));
        assert!(r[0].reason.contains("截斷") && r[0].reason.contains("60"), "{}", r[0].reason);
        assert!(r[1].models.len() == 10 && r[1].reason.is_empty(), "沒超過的不動");
        assert_ne!(REPORT_MAX_BYTES, run::STDOUT_CAP, "回報上限與讀取上限各自獨立");
    }

    #[test]
    fn 回報上限_照序列化後的_json_大小算_每家有保底_排最後的_pi_不會被吃光() {
        // 每筆 id 90＋name 90 位元組、序列化後約 205；每家 50 筆約 10 KB，四家合計遠超 24000
        let all: Vec<VendorModels> = Vendor::ALL.iter().map(|v| many(*v, 50, 90)).collect();
        let r = limit_for_report(all);
        let json = serde_json::to_vec(&r).unwrap().len();
        assert!(json <= REPORT_MAX_BYTES, "序列化後 {json} 位元組超過上限");
        assert!(r[1].models.len() < 50 && r[1].reason.contains("截斷"), "中間的被截（總額不夠）：{}", r[1].models.len());
        let last = &r[3];
        assert_eq!(last.status, Status::Ok, "pi 有保底額度，不會變 Error");
        let floor_fit = REPORT_FLOOR_BYTES / 210;
        assert!(last.models.len() >= floor_fit - 1, "pi 至少拿到保底的 {floor_fit} 筆上下，實得 {}", last.models.len());
        assert!(last.reason.contains("截斷"), "{}", last.reason);
    }

    #[test]
    fn 回報上限_只算代號與顯示名會低估_跳脫字元與欄位也要算進去() {
        // 顯示名全是要跳脫的雙引號：位元組數是 name.len() 的兩倍
        let q = VendorModels::from_list(Vendor::Codex, (0..40).map(|i| ModelEntry { id: format!("m{i}"), name: "\"".repeat(80) }).collect());
        let raw: usize = q.models.iter().map(|m| m.id.len() + m.name.len()).sum();
        let r = limit_with(vec![q], 50, 3_000, 0);
        let json = serde_json::to_vec(&r).unwrap().len();
        assert!(json <= 3_000, "序列化後 {json}（舊算法只算 {raw} 會放進太多）");
        assert!(r[0].models.len() < 40);
    }

    #[test]
    fn 回報上限_一筆都放不下的改成_error() {
        let big = VendorModels::from_list(Vendor::Pi, vec![ModelEntry { id: "m".into(), name: "n".repeat(80) }]);
        let r = limit_with(vec![big], 50, 100, 0);
        assert_eq!((r[0].status, r[0].code, r[0].models.len()), (Status::Error, Some(Code::TooLarge), 0));
        assert!(r[0].reason.contains("超過回報上限"));
    }

    #[test]
    fn 回報上限_pi_最多兩百筆_其他家五十筆() {
        let r = limit_for_report(vec![many(Vendor::Codex, 120, 3), many(Vendor::Pi, 250, 3)]);
        assert_eq!(r[0].models.len(), REPORT_MAX_MODELS);
        assert_eq!(r[1].models.len(), PI_REPORT_MAX_MODELS, "pi 比 pi_models 的 200 筆少會退化");
        assert!(serde_json::to_vec(&r).unwrap().len() <= REPORT_MAX_BYTES);
    }

    fn leak() -> &'static ProbeCache {
        Box::leak(Box::default())
    }
    fn ok(v: Vendor) -> VendorModels {
        VendorModels::from_list(v, vec![ModelEntry { id: "m".into(), name: "M".into() }])
    }

    #[test]
    fn claude_固定讀不到_不寫死任何清單() {
        let r = crate::rt::block_on(probe_uncached(Vendor::Claude));
        assert_eq!((r.status, r.code, r.models.len(), r.vendor.as_str()), (Status::Unavailable, Some(Code::Unsupported), 0, "claude"));
        assert!(r.reason.contains("--model"));
    }

    #[test]
    fn 結構序列化_給後台與前端的欄位名_reason_絕不輸出() {
        let j = serde_json::to_value(ok(Vendor::Codex)).unwrap();
        assert_eq!(j, serde_json::json!({ "vendor": "codex", "status": "ok", "code": "ok", "models": [{ "id": "m", "name": "M" }] }));
        let e = serde_json::to_value(VendorModels::error(Vendor::Pi, Code::Timeout, "x")).unwrap();
        assert_eq!((&e["status"], &e["code"]), (&serde_json::json!("error"), &serde_json::json!("timeout")));
        assert_eq!(serde_json::to_value(VendorModels::unavailable(Vendor::Gemini, Code::NotInstalled, "x")).unwrap()["status"], "unavailable");
        // pending：沒有 code、stale、age_s 這些鍵
        assert_eq!(serde_json::to_value(VendorModels::pending(Vendor::Pi)).unwrap(), serde_json::json!({ "vendor": "pi", "status": "pending", "models": [] }));
    }

    #[test]
    fn 上傳的摘要裡沒有_reason_也沒有原因原文() {
        // 原因原文帶路徑、帳號、環境值：每一種失敗與沿用舊清單，序列化後都不能出現
        let secret = r"C:\Users\someone\.pi\token=SECRET123";
        let all = vec![
            VendorModels::error(Vendor::Codex, Code::SpawnFailed, secret),
            VendorModels::unavailable(Vendor::Gemini, Code::NotInstalled, secret),
            VendorModels { stale: true, age_s: Some(9), reason: secret.into(), ..ok(Vendor::Pi) },
            ok(Vendor::Claude),
        ];
        let text = serde_json::to_string(&to_report_value(&limit_for_report(all))).unwrap();
        assert!(!text.contains("reason") && !text.contains("SECRET123") && !text.contains("someone"), "{text}");
    }

    const WIRE: &str = include_str!("../../../../../shared/test-vectors/launcher-models-wire.json");

    fn wire_models() -> serde_json::Value {
        serde_json::from_str::<serde_json::Value>(WIRE).unwrap()["models"].clone()
    }

    fn entry(id: &str, name: &str) -> ModelEntry {
        ModelEntry { id: id.into(), name: name.into() }
    }

    /// 跟 wire 樣本逐字相同的四家（codex ok、gemini stale、pi pending、claude 不支援）
    fn wire_sample() -> Vec<VendorModels> {
        let t0 = Instant::now();
        let c = leak();
        c.put(Vendor::Gemini, VendorModels::from_list(Vendor::Gemini, vec![entry("gemini-4-argon-medium", "Gemini 4 Argon (Medium)")]), t0);
        c.put(Vendor::Gemini, VendorModels::error(Vendor::Gemini, Code::Timeout, "逾時"), t0 + Duration::from_secs(700));
        // age_s＝距上次成功 1260 秒
        let gemini = c.lookup(Vendor::Gemini, t0 + Duration::from_secs(1260)).unwrap().0;
        vec![
            VendorModels::from_list(Vendor::Codex, vec![entry("gpt-6-luna", "GPT-6 Luna"), entry("gpt-5.6-terra", "GPT-5.6 Terra")]),
            gemini,
            VendorModels::pending(Vendor::Pi),
            claude_unsupported(),
        ]
    }

    #[test]
    fn wire_樣本_真的序列化結果與共用樣本逐字相同() {
        assert_eq!(to_report_value(&limit_for_report(wire_sample())), wire_models(), "形狀改了：後台 sanitizeModels 與這份樣本要一起改");
    }

    /// 後台 `sanitizeModels`（PR-B #2384）規則的鏡像：樣本與真的輸出都要整份被收下、原樣不變。
    /// 這只是 Rust 端的就近檢查；真的對照在 supabase/functions/_shared/launch_models_wire_test.ts（Edge）
    /// 與 tests/launcher_models_sql.test.mjs（SQL）：它們讀同一份 wire 樣本，丟進真的整理函式。
    fn backend_accepts(v: &serde_json::Value) -> Result<(), String> {
        let arr = v.as_array().ok_or("models 不是陣列")?;
        if arr.len() > 8 {
            return Err("超過 8 家".into());
        }
        let vendor_ok = |s: &str| s.len() <= 20 && s.chars().next().is_some_and(|c| c.is_ascii_lowercase()) && s.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-');
        for e in arr {
            let o = e.as_object().ok_or("不是物件")?;
            for k in o.keys() {
                if !["vendor", "status", "code", "stale", "age_s", "models"].contains(&k.as_str()) {
                    return Err(format!("後台不收的欄位：{k}"));
                }
            }
            if !vendor_ok(o["vendor"].as_str().ok_or("vendor")?) {
                return Err("vendor 不合格".into());
            }
            if !["ok", "unavailable", "error", "pending"].contains(&o["status"].as_str().ok_or("status")?) {
                return Err("status 不合格".into());
            }
            if let Some(c) = o.get("code") {
                if !Code::ALL.iter().any(|k| serde_json::to_value(k).unwrap() == *c) {
                    return Err("code 不合格".into());
                }
            }
            if o.get("stale").is_some_and(|s| !s.is_boolean()) {
                return Err("stale 要布林".into());
            }
            if o.get("age_s").is_some_and(|a| !a.as_u64().is_some_and(|n| n <= 31_536_000)) {
                return Err("age_s 不合格".into());
            }
            let list = o["models"].as_array().ok_or("models")?;
            if list.len() > 200 {
                return Err("每家超過 200 筆".into());
            }
            for m in list {
                let (id, name) = (m["id"].as_str().ok_or("id")?, m["name"].as_str().ok_or("name")?);
                let n = name.chars().count();
                if !valid_model_id(id) || n < 1 || n > 80 || name.chars().any(|c| c.is_control() || parse::is_format_char(c)) {
                    return Err(format!("型號不合格：{id}"));
                }
            }
        }
        if serde_json::to_vec(v).unwrap().len() > 24_000 {
            return Err("超過 24000 位元組".into());
        }
        Ok(())
    }

    #[test]
    fn wire_後台會收下_樣本與最大量的真輸出都過後台的規則() {
        assert_eq!(backend_accepts(&wire_models()), Ok(()));
        // 最大量：pi 兩百筆、其他各五十筆、名字很長
        let big: Vec<VendorModels> = Vendor::ALL.iter().map(|v| many(*v, 300, 40)).collect();
        let out = to_report_value(&limit_for_report(big));
        assert_eq!(backend_accepts(&out), Ok(()), "{}", serde_json::to_string(&out).unwrap().len());
        // 鏡像本身要會擋：夾帶 reason 就不收
        let mut bad = wire_models();
        bad[0]["reason"] = "x".into();
        assert!(backend_accepts(&bad).is_err());
    }

    #[test]
    fn 固定代碼_八個值與後台逐字相同_每種失敗都有對應() {
        let names: Vec<String> = Code::ALL.iter().map(|c| serde_json::to_value(c).unwrap().as_str().unwrap().to_string()).collect();
        assert_eq!(names, ["ok", "not_installed", "not_logged_in", "timeout", "too_large", "parse_failed", "spawn_failed", "unsupported"]);
        assert_eq!(code_of(&RunFail::Timeout), Code::Timeout);
        assert_eq!(code_of(&RunFail::TooLarge), Code::TooLarge);
        assert_eq!(code_of(&RunFail::Spawn("x".into())), Code::SpawnFailed);
        assert_eq!(code_of(&RunFail::Exit(Some(1))), Code::SpawnFailed);
        assert_eq!(code_of(&RunFail::Io("x".into())), Code::SpawnFailed);
        assert_eq!(VendorModels::from_list(Vendor::Pi, vec![]).code, Some(Code::NotLoggedIn), "沒列出任何型號＝多半沒登入");
        assert_eq!(ok(Vendor::Pi).code, Some(Code::Ok));
    }

    #[test]
    fn 快取_成功十分鐘_失敗只一分鐘() {
        let c = leak();
        let t0 = Instant::now();
        c.put(Vendor::Codex, ok(Vendor::Codex), t0);
        c.put(Vendor::Pi, VendorModels::error(Vendor::Pi, Code::SpawnFailed, "壞了"), t0);
        assert!(c.fresh(Vendor::Codex, t0 + OK_TTL - Duration::from_secs(1)).is_some());
        assert!(c.fresh(Vendor::Codex, t0 + OK_TTL + Duration::from_secs(1)).is_none());
        assert!(c.fresh(Vendor::Pi, t0 + FAIL_TTL - Duration::from_secs(1)).is_some());
        assert!(c.fresh(Vendor::Pi, t0 + FAIL_TTL + Duration::from_secs(1)).is_none(), "失敗只記 1 分鐘，不能拖到 10 分鐘");
        assert!(c.fresh(Vendor::Gemini, t0).is_none());
    }

    #[test]
    fn 第一次回報不等_先回尚未讀取_同時只排一個重查_做完後讀快取() {
        let c = leak();
        let t0 = Instant::now();
        let (v, claim) = c.begin(Vendor::Codex, t0);
        assert_eq!((v.status, v.code, v.reason.as_str()), (Status::Pending, None, "尚未讀取"), "還在讀＝pending，不是「讀不到」");
        let claim = claim.expect("第一次要排一個重查");
        assert!(c.begin(Vendor::Codex, t0).1.is_none(), "同時只跑一個");
        assert!(c.begin(Vendor::Pi, t0).1.is_some(), "別家不受影響");
        claim.finish(ok(Vendor::Codex));
        let (v, claim) = c.begin(Vendor::Codex, Instant::now());
        assert!(v.status == Status::Ok && claim.is_none(), "新鮮的直接讀快取，不再排");
    }

    #[test]
    fn 過期先用舊的_背景再查一次_重查中途_panic_旗標照樣放開() {
        let c = leak();
        let t0 = Instant::now();
        c.put(Vendor::Codex, ok(Vendor::Codex), t0);
        let later = t0 + OK_TTL + Duration::from_secs(1);
        let (v, claim) = c.begin(Vendor::Codex, later);
        assert_eq!(v.status, Status::Ok, "過期時先用舊的");
        let claim = claim.unwrap();
        let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(move || {
            let _held = claim;
            panic!("探測壞了");
        }));
        assert!(r.is_err());
        assert!(c.begin(Vendor::Codex, later).1.is_some(), "panic 後旗標放開，下一輪還會重查");
    }

    fn os(pairs: &[(&str, &str)]) -> Vec<(OsString, OsString)> {
        pairs.iter().map(|(k, v)| (OsString::from(k), OsString::from(v))).collect()
    }
    fn names(v: &[(String, String)]) -> Vec<String> {
        let mut n: Vec<String> = v.iter().map(|(k, _)| k.to_uppercase()).collect();
        n.sort();
        n
    }
    /// 不是合法 UTF-8 的字串（Windows 是孤立的代理碼元，其他系統是 0xFF）
    fn bad_os() -> OsString {
        #[cfg(windows)]
        {
            use std::os::windows::ffi::OsStringExt;
            OsString::from_wide(&[0x61, 0xD800, 0x62])
        }
        #[cfg(unix)]
        {
            use std::os::unix::ffi::OsStringExt;
            OsString::from_vec(vec![b'a', 0xFF, b'b'])
        }
    }

    const USER_ENV: [(&str, &str); 9] = [
        ("PATH", "/bin"),
        ("AWS_PROFILE", "p"),
        ("GOOGLE_APPLICATION_CREDENTIALS", "g"),
        ("HTTP_PROXY", "http://x"),
        ("NO_PROXY", "localhost"),
        ("NVM_DIR", "/n"),
        ("NODE_EXTRA_CA_CERTS", "c"),
        ("ANTHROPIC_API_KEY", "pi-provider-key"),
        ("PI_CODING_AGENT_DIR", "d"),
    ];

    #[test]
    fn pi_環境_繼承整份_只擋_asn_自己的金鑰() {
        let mut vars = os(&USER_ENV);
        vars.extend(os(&[("ASN_RELAY_KEY", "k"), ("asn_relay_anon_key", "a"), ("IRORI_RELAY_KEY", "k2"), ("Irori_Relay_Anon_Key", "a2")]));
        let got = pi_env_from(&vars);
        let n = names(&got);
        for k in ["ASN_RELAY_KEY", "ASN_RELAY_ANON_KEY", "IRORI_RELAY_KEY", "IRORI_RELAY_ANON_KEY"] {
            assert!(!n.contains(&k.to_string()), "{k} 不能傳給子程序：{n:?}");
        }
        for (k, v) in USER_ENV {
            assert!(got.iter().any(|(gk, gv)| gk == k && gv == v), "{k} 應該照樣傳下去（AWS／代理／nvm／提供者金鑰是 pi 自己要讀的）：{n:?}");
        }
    }

    #[test]
    fn agy_與_codex_環境_各走既有規則() {
        let mut vars = os(&USER_ENV);
        vars.extend(os(&[("ASN_RELAY_KEY", "k"), ("OPENAI_API_KEY", "o"), ("CODEX_HOME", "/c"), ("CODEX_THREAD_ID", "t"), ("USERPROFILE", "C:/u")]));
        let agy = names(&agy_env_from(&vars));
        assert_eq!(agy, ["PATH", "USERPROFILE"], "agy＝acp_clean_env 白名單，與工作者原生通道相同");
        let codex = codex_env_from(&vars);
        let n = names(&codex);
        assert!(n.contains(&"CODEX_HOME".into()) && n.contains(&"AWS_PROFILE".into()) && n.contains(&"HTTP_PROXY".into()), "{n:?}");
        for k in ["ASN_RELAY_KEY", "OPENAI_API_KEY", "CODEX_THREAD_ID"] {
            assert!(!n.contains(&k.to_string()), "{k} 不能傳給 Codex：{n:?}");
        }
    }

    #[test]
    fn 環境裡有非_utf8_的變數_不_panic_也不整份丟掉_只略過那一個() {
        let mut vars = os(&[("PATH", "/bin"), ("AWS_PROFILE", "p"), ("HOME", "/h")]);
        vars.push((OsString::from("BAD_VALUE"), bad_os()));
        vars.push((bad_os(), OsString::from("v")));
        vars.push((OsString::from("HTTP_PROXY"), OsString::from("http://x")));
        assert!(bad_os().to_str().is_none(), "測試資料本身要不是 UTF-8");
        let all = utf8_vars(&vars);
        assert_eq!(all.len(), 4, "壞的兩個略過、其餘都在：{all:?}");
        let pi = names(&pi_env_from(&vars));
        assert!(pi.contains(&"AWS_PROFILE".into()) && pi.contains(&"HTTP_PROXY".into()) && !pi.contains(&"BAD_VALUE".into()), "{pi:?}");
        assert!(names(&agy_env_from(&vars)).contains(&"PATH".into()));
        assert!(names(&codex_env_from(&vars)).contains(&"HOME".into()));
        // 真的環境也走 vars_os：不會 panic
        let _ = (pi_env(), os_vars());
    }

    fn fail(v: Vendor, why: &str) -> VendorModels {
        VendorModels::error(v, Code::Timeout, why)
    }

    #[test]
    fn 重查失敗不蓋掉上次成功的清單_沿用舊的並註明_一分鐘後再試() {
        let c = leak();
        let t0 = Instant::now();
        c.put(Vendor::Pi, ok(Vendor::Pi), t0);
        let t1 = t0 + OK_TTL + Duration::from_secs(1);
        c.put(Vendor::Pi, fail(Vendor::Pi, "pi 逾時沒有回應"), t1);
        let (v, fresh) = c.lookup(Vendor::Pi, t1).unwrap();
        assert_eq!((v.status, v.models.len()), (Status::Ok, 1), "舊清單還在");
        assert!(v.reason.contains("重查失敗，沿用上次的清單") && v.reason.contains("逾時"), "{}", v.reason);
        assert!(fresh);
        assert!(c.fresh(Vendor::Pi, t1 + FAIL_TTL - Duration::from_secs(1)).is_some());
        assert!(c.fresh(Vendor::Pi, t1 + FAIL_TTL + Duration::from_secs(1)).is_none(), "沿用舊清單也只記 1 分鐘，不能拖 10 分鐘");
        // 連續失敗：仍沿用最初那份
        c.put(Vendor::Pi, fail(Vendor::Pi, "第二次也壞了"), t1 + Duration::from_secs(120));
        let (v, _) = c.lookup(Vendor::Pi, t1 + Duration::from_secs(120)).unwrap();
        assert_eq!(v.models.len(), 1);
        assert!(v.reason.contains("第二次") && !v.reason.contains("逾時"), "{}", v.reason);
        // 之後成功就換成新的、不再標沿用
        c.put(Vendor::Pi, ok(Vendor::Pi), t1 + Duration::from_secs(200));
        assert_eq!(c.lookup(Vendor::Pi, t1 + Duration::from_secs(200)).unwrap().0.reason, "");
        // 本來就沒有成功過的：照舊記失敗
        c.put(Vendor::Codex, fail(Vendor::Codex, "壞了"), t0);
        assert_eq!(c.lookup(Vendor::Codex, t0).unwrap().0.status, Status::Error);
        // 沒裝（Unavailable）是真的結果，不當成失敗保留舊清單
        c.put(Vendor::Pi, VendorModels::unavailable(Vendor::Pi, Code::NotInstalled, "這台電腦找不到 pi"), t1 + Duration::from_secs(300));
        assert_eq!(c.lookup(Vendor::Pi, t1 + Duration::from_secs(300)).unwrap().0.status, Status::Unavailable);
    }

    #[test]
    fn 沿用舊清單_標_stale_code_是這次失敗的原因_age_s_從上次成功起算_成功後清掉() {
        let c = leak();
        let t0 = Instant::now();
        c.put(Vendor::Pi, ok(Vendor::Pi), t0);
        let t1 = t0 + OK_TTL + Duration::from_secs(1);
        c.put(Vendor::Pi, VendorModels::error(Vendor::Pi, Code::Timeout, "逾時"), t1);
        let (v, _) = c.lookup(Vendor::Pi, t1 + Duration::from_secs(20)).unwrap();
        assert_eq!((v.status, v.stale, v.code), (Status::Ok, true, Some(Code::Timeout)));
        assert_eq!(v.age_s, Some(OK_TTL.as_secs() + 21), "距上次成功，不是距這次失敗");
        // 連續失敗：age_s 仍從最初那次成功算，code 換成最新的原因
        c.put(Vendor::Pi, VendorModels::error(Vendor::Pi, Code::SpawnFailed, "壞了"), t1 + Duration::from_secs(100));
        let (v, _) = c.lookup(Vendor::Pi, t1 + Duration::from_secs(100)).unwrap();
        assert_eq!((v.code, v.age_s), (Some(Code::SpawnFailed), Some(OK_TTL.as_secs() + 101)));
        // 序列化：stale／age_s／code 都在，reason 不在
        let j = serde_json::to_value(&v).unwrap();
        assert_eq!((j["stale"].clone(), j["age_s"].clone(), j["code"].clone(), j.get("reason")), (true.into(), (OK_TTL.as_secs() + 101).into(), "spawn_failed".into(), None));
        // 成功後 stale／age_s 清掉
        c.put(Vendor::Pi, ok(Vendor::Pi), t1 + Duration::from_secs(200));
        let (v, _) = c.lookup(Vendor::Pi, t1 + Duration::from_secs(250)).unwrap();
        assert_eq!((v.stale, v.age_s, v.code), (false, None, Some(Code::Ok)));
        let j = serde_json::to_value(&v).unwrap();
        assert!(j.get("stale").is_none() && j.get("age_s").is_none(), "沒有 stale 時不輸出這兩個鍵：{j}");
    }

    #[test]
    fn 沒安裝記十分鐘_沒登入與失敗只記一分鐘() {
        let c = leak();
        let t0 = Instant::now();
        c.put(Vendor::Pi, VendorModels::unavailable(Vendor::Pi, Code::NotInstalled, "找不到"), t0);
        c.put(Vendor::Codex, VendorModels::unavailable(Vendor::Codex, Code::NotLoggedIn, "沒登入"), t0);
        assert!(c.fresh(Vendor::Pi, t0 + NOT_INSTALLED_TTL - Duration::from_secs(1)).is_some());
        assert!(c.fresh(Vendor::Pi, t0 + NOT_INSTALLED_TTL + Duration::from_secs(1)).is_none());
        assert!(c.fresh(Vendor::Codex, t0 + FAIL_TTL + Duration::from_secs(1)).is_none());
    }

    #[test]
    fn claude_每輪回報都不排背景工作_永遠回不支援() {
        let c = leak();
        let t0 = Instant::now();
        for i in 0..3 {
            let (v, claim) = c.begin(Vendor::Claude, t0 + Duration::from_secs(i * 3600));
            assert_eq!((v.status, v.code), (Status::Unavailable, Some(Code::Unsupported)));
            assert!(claim.is_none(), "Claude 不該排重查（第 {i} 輪）");
        }
        assert!(c.begin(Vendor::Codex, t0).1.is_some(), "其他家照舊");
    }

    #[test]
    fn 同一家同時只跑一個_手動重讀與背景重查共用旗標() {
        let c = leak();
        let a = c.claim(Vendor::Codex).expect("第一個搶到");
        assert!(c.claim(Vendor::Codex).is_none(), "已經有人在查");
        assert!(c.begin(Vendor::Codex, Instant::now()).1.is_none(), "背景重查也排不進去");
        // probe_in(force)：旗標被佔著時不能同時再開一個（fetch 要等對方放掉旗標之後才跑），
        // 對方做完後自己補查一次，回的是補查的結果（不是對方按下之前開始的那份）
        let a_done = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let (a_done2, a_done3) = (a_done.clone(), a_done.clone());
        let ran = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let ran2 = ran.clone();
        let h = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(150));
            a_done2.store(true, std::sync::atomic::Ordering::SeqCst);
            a.finish(VendorModels::from_list(Vendor::Codex, vec![entry("old", "Old")]));
        });
        let got = crate::rt::block_on(probe_in(c, Vendor::Codex, true, move || async move {
            assert!(a_done3.load(std::sync::atomic::Ordering::SeqCst), "別人還在查時，force 不能再開一個同家 CLI");
            ran2.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            VendorModels::from_list(Vendor::Codex, vec![entry("new", "New")])
        }));
        h.join().unwrap();
        assert_eq!(ran.load(std::sync::atomic::Ordering::SeqCst), 1, "force 等完後補查剛好一次");
        assert_eq!((got.status, got.models[0].id.as_str()), (Status::Ok, "new"), "回的是按下之後才讀到的");
        // 非 force 撞上別人在查：照舊只等、不補查
        assert!(c.claim(Vendor::Codex).is_some(), "旗標放開");
        let c = leak();
        let a = c.claim(Vendor::Codex).unwrap();
        let h = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(150));
            a.finish(ok(Vendor::Codex));
        });
        let got = crate::rt::block_on(probe_in(c, Vendor::Codex, false, || async { fail(Vendor::Codex, "非 force 不該補查") }));
        h.join().unwrap();
        assert_eq!((got.status, got.models[0].id.as_str()), (Status::Ok, "m"), "非 force：等別人查完、讀它的結果，不自己補查");
        let c = leak();
        // 沒人在查時 force 會自己查，且查完放掉旗標
        let got = crate::rt::block_on(probe_in(c, Vendor::Codex, true, || async { ok(Vendor::Codex) }));
        assert_eq!(got.status, Status::Ok);
        assert!(c.claim(Vendor::Codex).is_some(), "查完旗標放開");
    }

    // ---- 一審補件 ① reason 在本機要記（遮罩）、Debug 不印原文 ----

    const SECRET_REASON: &str = r"pi 起不來：C:\Users\someone\.pi\bin\pi.exe token=SECRET123 /home/alice/x ey0123456789abcdef0123456789abcdef0123456789";

    fn assert_no_raw(text: &str) {
        for raw in ["someone", "SECRET123", "alice", "ey0123456789abcdef0123456789abcdef0123456789"] {
            assert!(!text.contains(raw), "不該出現原文 {raw}：{text}");
        }
    }

    #[test]
    fn 失敗時寫一行記錄_有廠牌_代碼_遮罩後的原因() {
        let line = failure_log_line(&VendorModels::error(Vendor::Pi, Code::SpawnFailed, SECRET_REASON)).unwrap();
        assert!(line.starts_with("[型號探測] vendor=pi status=error code=spawn_failed reason="), "{line}");
        assert_no_raw(&line);
        assert!(line.contains('~') && line.contains("<隱藏>"), "{line}");
        // 沒讀到型號的每一種都記；讀到了與讀取中不記
        assert!(failure_log_line(&VendorModels::unavailable(Vendor::Gemini, Code::NotInstalled, "找不到 agy")).unwrap().contains("code=not_installed"));
        assert!(failure_log_line(&ok(Vendor::Codex)).is_none());
        assert!(failure_log_line(&VendorModels::pending(Vendor::Pi)).is_none());
    }

    #[test]
    fn 寫入快取時每次非_ok_都記一行_含沿用舊清單_原文不外漏() {
        let c = leak();
        let t0 = Instant::now();
        let mut lines: Vec<String> = Vec::new();
        c.put_logged(Vendor::Pi, ok(Vendor::Pi), t0, &mut |l| lines.push(l.to_string()));
        assert!(lines.is_empty(), "成功不記");
        let t1 = t0 + OK_TTL + Duration::from_secs(1);
        c.put_logged(Vendor::Pi, VendorModels::error(Vendor::Pi, Code::Timeout, SECRET_REASON), t1, &mut |l| lines.push(l.to_string()));
        assert_eq!(lines.len(), 1, "沿用舊清單（stale）也要記：{lines:?}");
        assert!(lines[0].contains("stale=true") && lines[0].contains("code=timeout") && lines[0].contains("沿用上次的清單"), "{}", lines[0]);
        c.put_logged(Vendor::Codex, VendorModels::unavailable(Vendor::Codex, Code::NotInstalled, SECRET_REASON), t0, &mut |l| lines.push(l.to_string()));
        c.put_logged(Vendor::Gemini, VendorModels::error(Vendor::Gemini, Code::ParseFailed, SECRET_REASON), t0, &mut |l| lines.push(l.to_string()));
        assert_eq!(lines.len(), 3);
        lines.iter().for_each(|l| assert_no_raw(l));
        // put 本身走 elog!（寫 ui.log）：守門，免得有人把記錄那行拿掉
        let src = include_str!("mod.rs").split("#[cfg(test)]").next().unwrap();
        assert!(src.contains(r#"self.put_logged(vendor, value, now, &mut |line| elog!("{line}"))"#));
    }

    #[test]
    fn debug_輸出不印原因原文() {
        let v = VendorModels::error(Vendor::Pi, Code::SpawnFailed, SECRET_REASON);
        let d = format!("{v:?} {:?}", vec![v.clone()]);
        assert_no_raw(&d);
        assert!(d.contains("已遮蔽") && d.contains("vendor"), "{d}");
        let e = format!("{:?} {:?}", RunFail::Spawn(SECRET_REASON.into()), RunFail::Io(SECRET_REASON.into()));
        assert_no_raw(&e);
        assert_eq!(format!("{:?}", RunFail::Exit(Some(3))), "Exit(Some(3))");
        assert_eq!(Code::ALL.map(|c| c.as_str().to_string()).to_vec(), Code::ALL.map(|c| serde_json::to_value(c).unwrap().as_str().unwrap().to_string()).to_vec());
    }

    // ---- 一審補件 ② 有輸出卻解析出 0 筆＝parse_failed ----

    fn kind(v: &VendorModels) -> (Status, Option<Code>) {
        (v.status, v.code)
    }

    #[test]
    fn 有輸出但解析出零筆_每一家都是_parse_failed_不叫人去登入() {
        let pf = (Status::Error, Some(Code::ParseFailed));
        // pi：有文字但不是表格
        assert_eq!(kind(&VendorModels::from_text(Vendor::Pi, "Something unexpected happened\n")), pf);
        assert_eq!(kind(&VendorModels::from_text(Vendor::Pi, "No models available.")), pf);
        // agy：有輸出但沒有任何「代號<Tab>顯示名」
        assert_eq!(kind(&VendorModels::from_text(Vendor::Gemini, "Error: something odd\nsee docs\n")), pf);
        assert_eq!(kind(&VendorModels::from_text(Vendor::Gemini, "bad id\tX\n")), pf, "有行但代號全不合法");
        // Codex：合法 JSON 但沒有 list 型號（空陣列、全 hide）；不是合法 JSON；缺 models
        assert_eq!(kind(&VendorModels::from_text(Vendor::Codex, r#"{"models":[]}"#)), pf);
        assert_eq!(kind(&VendorModels::from_text(Vendor::Codex, r#"{"models":[{"slug":"a","visibility":"hide"}]}"#)), pf);
        assert_eq!(kind(&VendorModels::from_text(Vendor::Codex, "not json")), pf);
        assert_eq!(kind(&VendorModels::from_text(Vendor::Codex, "{}")), pf);
        for t in [r#"{"models":[]}"#, "x"] {
            assert_ne!(VendorModels::from_text(Vendor::Codex, t).code, Some(Code::NotLoggedIn), "Codex 不需要登入");
        }
    }

    #[test]
    fn 真正空輸出照舊_pi_與_agy_是沒登入_有型號仍是_ok() {
        for blank in ["", "  \n\t ", "\u{feff}\n"] {
            assert_eq!(kind(&VendorModels::from_text(Vendor::Pi, blank)), (Status::Unavailable, Some(Code::NotLoggedIn)), "{blank:?}");
            assert_eq!(kind(&VendorModels::from_text(Vendor::Gemini, blank)), (Status::Unavailable, Some(Code::NotLoggedIn)), "{blank:?}");
        }
        assert_eq!(kind(&VendorModels::from_text(Vendor::Codex, "")), (Status::Error, Some(Code::ParseFailed)), "Codex 空輸出本來就是解析失敗");
        assert_eq!(kind(&VendorModels::from_text(Vendor::Gemini, "a-1\tA\n")), (Status::Ok, Some(Code::Ok)));
        assert_eq!(kind(&VendorModels::from_text(Vendor::Pi, "anthropic     claude-sonnet-5-5   1M  128K  yes  yes\n")), (Status::Ok, Some(Code::Ok)));
        assert_eq!(VendorModels::from_text(Vendor::Codex, r#"{"models":[{"slug":"a","visibility":"list"}]}"#).status, Status::Ok);
    }

    // ---- 一審補件 ③ 最大量 wire 向量（Rust 產生，Edge 與 SQL 驗證） ----

    const WIRE_MAX: &str = include_str!("../../../../../shared/test-vectors/launcher-models-wire-max.json");

    /// 八家（後台的家數上限）：每家 300 筆候選、id 100 字（合法最長）、顯示名 80 字（合法最長），pi 排最後
    fn max_list() -> Vec<VendorModels> {
        let pad = |mut s: String, fill: char, to: usize| {
            while s.chars().count() < to {
                s.push(fill);
            }
            s
        };
        ["claude", "codex", "gemini", "grok", "kimi", "qwen", "droid", "pi"]
            .iter()
            .map(|v| VendorModels {
                vendor: v.to_string(),
                status: Status::Ok,
                code: Some(Code::Ok),
                stale: false,
                age_s: None,
                models: (0..300).map(|i| ModelEntry { id: pad(format!("{v}-{i:03}-"), 'x', 100), name: pad(format!("{v} {i:03} "), 'N', 80) }).collect(),
                reason: String::new(),
            })
            .collect()
    }

    #[test]
    fn wire_最大量_真輸出與共用向量逐字相同_且後台規則收得下() {
        let out = to_report_value(&limit_for_report(max_list()));
        let want = serde_json::from_str::<serde_json::Value>(WIRE_MAX).unwrap()["models"].clone();
        if out != want {
            panic!("最大量輸出變了。把下面這一行貼進 launcher-models-wire-max.json 的 models：\n{}", serde_json::to_string(&out).unwrap());
        }
        assert_eq!(backend_accepts(&out), Ok(()));
        let bytes = serde_json::to_vec(&out).unwrap().len();
        assert!(bytes <= 24_000 && bytes > 23_000, "要逼近上限但不超過：{bytes}");
        let arr = out.as_array().unwrap();
        assert_eq!(arr.len(), 8);
        let counts: Vec<usize> = arr.iter().map(|e| e["models"].as_array().unwrap().len()).collect();
        assert!(counts.iter().all(|n| *n > 0), "每家都有保底：{counts:?}");
        assert!(WIRE_MAX.chars().all(|c| !c.is_control() || c == '\n' || c == '\r'), "向量檔不放不可見字元");
        assert!(!WIRE_MAX.chars().any(is_invisible), "向量檔不放格式字元");
    }

    fn is_invisible(c: char) -> bool {
        parse::is_format_char(c)
    }

    #[test]
    fn 子程序守門_環境清空_退出時殺掉_不閃視窗() {
        let src = include_str!("run.rs");
        let body = src.split("#[cfg(test)]").next().unwrap();
        assert!(body.contains(".env_clear()") && body.contains(".kill_on_drop(true)") && body.contains(".no_window()"));
        assert!(body.contains("tokio::time::timeout"), "一定要有逾時");
    }
}

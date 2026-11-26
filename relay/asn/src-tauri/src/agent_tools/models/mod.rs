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
//! 結果裡的 `reason` 是給 log 看的；畫面上的白話字由前端負責（第②階段以後）。
//! 隱私：只收代號與顯示名，不碰路徑、憑證、帳號。
mod parse;
mod run;

pub use parse::{parse_agy, parse_codex, parse_pi, valid_model_id, MAX_MODELS, MODEL_ID_PATTERN};
pub use run::{run, run_blocking, RunFail, Spawn};

use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

/// 單次探測最多等多久
pub const PROBE_TIMEOUT: Duration = Duration::from_secs(10);
/// 成功的結果記多久
pub const OK_TTL: Duration = Duration::from_secs(600);
/// 失敗（讀不到、出錯）的結果記多久
pub const FAIL_TTL: Duration = Duration::from_secs(60);

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
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct VendorModels {
    pub vendor: String,
    pub models: Vec<ModelEntry>,
    pub status: Status,
    /// 給 log 看的原因（Ok 時為空）
    pub reason: String,
}

impl VendorModels {
    fn new(v: Vendor, status: Status, models: Vec<ModelEntry>, reason: impl Into<String>) -> Self {
        VendorModels { vendor: v.id().into(), models, status, reason: reason.into() }
    }
    pub fn unavailable(v: Vendor, reason: impl Into<String>) -> Self {
        Self::new(v, Status::Unavailable, vec![], reason)
    }
    pub fn error(v: Vendor, reason: impl Into<String>) -> Self {
        Self::new(v, Status::Error, vec![], reason)
    }
    /// 解析完的結果：空的算 Unavailable
    fn from_list(v: Vendor, list: Vec<ModelEntry>) -> Self {
        if list.is_empty() {
            Self::unavailable(v, "CLI 沒有列出任何型號（可能還沒登入）")
        } else {
            Self::new(v, Status::Ok, list, "")
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
    slots: Mutex<HashMap<Vendor, (Instant, VendorModels)>>,
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

fn ttl_for(v: &VendorModels) -> Duration {
    if v.status == Status::Ok {
        OK_TTL
    } else {
        FAIL_TTL
    }
}

impl ProbeCache {
    pub fn put(&self, vendor: Vendor, value: VendorModels, now: Instant) {
        self.slots.lock().unwrap_or_else(|e| e.into_inner()).insert(vendor, (now, value));
    }

    fn lookup(&self, vendor: Vendor, now: Instant) -> Option<(VendorModels, bool)> {
        let g = self.slots.lock().unwrap_or_else(|e| e.into_inner());
        g.get(&vendor).map(|(at, v)| (v.clone(), now.saturating_duration_since(*at) < ttl_for(v)))
    }

    /// 還新鮮的結果（過期或沒有＝None）
    pub fn fresh(&self, vendor: Vendor, now: Instant) -> Option<VendorModels> {
        self.lookup(vendor, now).and_then(|(v, ok)| ok.then_some(v))
    }

    /// 只讀、不等：回目前的結果（過期的也先用；還沒有就回「尚未讀取」）；
    /// 需要重查且沒有別人正在查時，另外回一個 `Claim`，呼叫端要在背景查完後 `finish`
    pub fn begin(&'static self, vendor: Vendor, now: Instant) -> (VendorModels, Option<Claim>) {
        let (value, fresh) = match self.lookup(vendor, now) {
            Some((v, fresh)) => (v, fresh),
            None => (VendorModels::unavailable(vendor, "尚未讀取"), false),
        };
        if fresh {
            return (value, None);
        }
        let claimed = self.busy.lock().unwrap_or_else(|e| e.into_inner()).insert(vendor);
        (value, claimed.then_some(Claim { cache: self, vendor }))
    }
}

fn global() -> &'static ProbeCache {
    static C: OnceLock<ProbeCache> = OnceLock::new();
    C.get_or_init(ProbeCache::default)
}

// ---------------------------------------------------------------------------------------------------------------------
// 探測
// ---------------------------------------------------------------------------------------------------------------------

/// 子程序環境：共用白名單，再加這一家自己要的變數（名字完全相符，或以某字串開頭／結尾）
fn child_env(exact: &[&str], prefixes: &[&str], suffixes: &[&str]) -> Vec<(String, String)> {
    let vars: Vec<(String, String)> = std::env::vars().collect();
    let extra: Vec<String> = vars
        .iter()
        .map(|(k, _)| k.clone())
        .filter(|k| {
            let u = k.to_uppercase();
            exact.contains(&u.as_str()) || prefixes.iter().any(|p| u.starts_with(p)) || suffixes.iter().any(|s| u.ends_with(s))
        })
        .collect();
    crate::bridge::engines::acp_clean_env(&vars, &extra)
}

/// pi 要自己的設定位置（`PI_*`）與提供者的 API 金鑰環境變數，才列得出「已設好憑證」的型號；這是 pi 以前就吃的環境，沒有多帶
fn pi_env() -> Vec<(String, String)> {
    child_env(&[], &["PI_"], &["_API_KEY"])
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
        return VendorModels::unavailable(v, "Claude 沒有列出型號的方式（claude --help 只有 --model）");
    }
    let (args, env, merge): (&[&str], _, _) = match v {
        Vendor::Pi => (&["--list-models"], pi_env(), true),
        Vendor::Gemini => (&["models"], child_env(&[], &[], &[]), false),
        _ => (&["debug", "models"], child_env(&["CODEX_HOME"], &[], &[]), false),
    };
    let Some(spec) = spawn_for(v, args, env, merge) else {
        return VendorModels::unavailable(v, format!("這台電腦找不到 {}", v.binary()));
    };
    let text = match run(spec, PROBE_TIMEOUT).await {
        Ok(t) => t,
        Err(e) => return VendorModels::error(v, e.reason(v.binary())),
    };
    match v {
        Vendor::Pi => VendorModels::from_list(v, parse_pi(&text)),
        Vendor::Gemini => VendorModels::from_list(v, parse_agy(&text)),
        _ => match parse_codex(&text) {
            Ok(l) => VendorModels::from_list(v, l),
            Err(e) => VendorModels::error(v, e),
        },
    }
}

/// 探測一家；`force`＝略過快取（使用者按了「重新讀取」）
pub async fn probe(v: Vendor, force: bool) -> VendorModels {
    let c = global();
    if !force {
        if let Some(f) = c.fresh(v, Instant::now()) {
            return f;
        }
    }
    let r = probe_uncached(v).await;
    c.put(v, r.clone(), Instant::now());
    r
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

#[cfg(test)]
mod tests {
    use super::*;

    fn leak() -> &'static ProbeCache {
        Box::leak(Box::default())
    }
    fn ok(v: Vendor) -> VendorModels {
        VendorModels::from_list(v, vec![ModelEntry { id: "m".into(), name: "M".into() }])
    }

    #[test]
    fn claude_固定讀不到_不寫死任何清單() {
        let r = crate::rt::block_on(probe_uncached(Vendor::Claude));
        assert_eq!((r.status, r.models.len(), r.vendor.as_str()), (Status::Unavailable, 0, "claude"));
        assert!(r.reason.contains("--model"));
    }

    #[test]
    fn 結構序列化_給後台與前端的欄位名() {
        let j = serde_json::to_value(ok(Vendor::Codex)).unwrap();
        assert_eq!(j, serde_json::json!({ "vendor": "codex", "models": [{ "id": "m", "name": "M" }], "status": "ok", "reason": "" }));
        assert_eq!(serde_json::to_value(VendorModels::error(Vendor::Pi, "x")).unwrap()["status"], "error");
        assert_eq!(serde_json::to_value(VendorModels::unavailable(Vendor::Gemini, "x")).unwrap()["status"], "unavailable");
    }

    #[test]
    fn 快取_成功十分鐘_失敗只一分鐘() {
        let c = leak();
        let t0 = Instant::now();
        c.put(Vendor::Codex, ok(Vendor::Codex), t0);
        c.put(Vendor::Pi, VendorModels::error(Vendor::Pi, "壞了"), t0);
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
        assert_eq!((v.status, v.reason.as_str()), (Status::Unavailable, "尚未讀取"));
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

    #[test]
    fn 子程序守門_環境清空_退出時殺掉_不閃視窗() {
        let src = include_str!("run.rs");
        let body = src.split("#[cfg(test)]").next().unwrap();
        assert!(body.contains(".env_clear()") && body.contains(".kill_on_drop(true)") && body.contains(".no_window()"));
        assert!(body.contains("tokio::time::timeout"), "一定要有逾時");
    }
}

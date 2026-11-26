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

pub use parse::{parse_agy, parse_codex, parse_pi, valid_model_id, MAX_MODELS, MODEL_ID_PATTERN, REPORT_FLOOR_BYTES, REPORT_MAX_BYTES, REPORT_MAX_MODELS};
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

/// 快取的一格。`stale`＝這份清單是上次成功時讀到的，剛剛重查失敗、沿用舊的（所以要比照失敗只記 1 分鐘，很快再試）
struct Slot {
    at: Instant,
    value: VendorModels,
    stale: bool,
}

fn ttl_for(slot: &Slot) -> Duration {
    if slot.value.status == Status::Ok && !slot.stale {
        OK_TTL
    } else {
        FAIL_TTL
    }
}

impl ProbeCache {
    /// 寫入一次探測結果。**失敗（Error）不蓋掉上次成功的清單**：格子裡已經有讀到型號的結果時，保留那份舊清單，
    /// 狀態仍是 Ok，`reason` 註明「重查失敗，沿用上次的清單」與這次失敗的原因；下一次重查在 1 分鐘後
    pub fn put(&self, vendor: Vendor, value: VendorModels, now: Instant) {
        let mut g = self.slots.lock().unwrap_or_else(|e| e.into_inner());
        let slot = match g.get(&vendor) {
            Some(old) if value.status == Status::Error && old.value.status == Status::Ok && !old.value.models.is_empty() => {
                let mut kept = old.value.clone();
                kept.reason = format!("重查失敗，沿用上次的清單（{}）", value.reason);
                Slot { at: now, value: kept, stale: true }
            }
            _ => Slot { at: now, value, stale: false },
        };
        g.insert(vendor, slot);
    }

    fn lookup(&self, vendor: Vendor, now: Instant) -> Option<(VendorModels, bool)> {
        let g = self.slots.lock().unwrap_or_else(|e| e.into_inner());
        g.get(&vendor).map(|s| (s.value.clone(), now.saturating_duration_since(s.at) < ttl_for(s)))
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
        return VendorModels::unavailable(v, "Claude 沒有列出型號的方式（claude --help 只有 --model）");
    }
    let (args, env, merge): (&[&str], _, _) = match v {
        Vendor::Pi => (&["--list-models"], pi_env(), true),
        Vendor::Gemini => (&["models"], agy_env_from(&os_vars()), false),
        _ => (&["debug", "models"], codex_env_from(&os_vars()), false),
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
    let now = Instant::now();
    c.put(v, r.clone(), now);
    // 回快取裡的那份：重查失敗時是「沿用上次的清單」，不是空的失敗結果
    c.lookup(v, now).map(|(kept, _)| kept).unwrap_or(r)
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

/// 截斷時 reason 會被換成較長的說明，先留這麼多位元組的餘裕
const REASON_SLACK: usize = 160;

fn limit_with(list: Vec<VendorModels>, max_models: usize, max_bytes: usize, floor: usize) -> Vec<VendorModels> {
    // 每家的固定部分（欄位、reason、陣列逗號）與每筆型號序列化後的大小（含逗號）
    let sizes: Vec<Vec<usize>> = list.iter().map(|v| v.models.iter().take(max_models).map(|m| json_len(m) + 1).collect()).collect();
    let base = |v: &VendorModels| json_len(&VendorModels { models: vec![], ..v.clone() }) + REASON_SLACK + 1;
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
        assert_eq!((r[0].status, r[0].models.len()), (Status::Error, 0));
        assert!(r[0].reason.contains("超過回報上限"));
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
        VendorModels::error(v, why)
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
        c.put(Vendor::Pi, VendorModels::unavailable(Vendor::Pi, "這台電腦找不到 pi"), t1 + Duration::from_secs(300));
        assert_eq!(c.lookup(Vendor::Pi, t1 + Duration::from_secs(300)).unwrap().0.status, Status::Unavailable);
    }

    #[test]
    fn 子程序守門_環境清空_退出時殺掉_不閃視窗() {
        let src = include_str!("run.rs");
        let body = src.split("#[cfg(test)]").next().unwrap();
        assert!(body.contains(".env_clear()") && body.contains(".kill_on_drop(true)") && body.contains(".no_window()"));
        assert!(body.contains("tokio::time::timeout"), "一定要有逾時");
    }
}

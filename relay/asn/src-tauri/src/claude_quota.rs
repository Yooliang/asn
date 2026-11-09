//! 各 Claude 帳號上次看到的剩餘額度（#228）。
//!
//! 來源只有一個：Claude Code 在執行時，會把「目前這個帳號」最近一次回應帶回來的 5 小時與每週額度
//! （已用百分比與重置時間）放進狀態列指令的標準輸入。使用者把 `asn claude-quota` 接進自己的狀態列指令，
//! 這裡就只取那幾個數字，記在「當時登入的帳號」底下。所以：
//! - 只有用過、且當時有送出額度的帳號才有紀錄；其他帳號沒有，介面寫「額度未知」，不編數字。
//! - 每筆紀錄附上記錄時間，介面才能標「N 分鐘前」與「資料較舊」。
//! - 不讀任何登入憑證、不連網、不執行外部程式：目前帳號只看 `.claude.json` 裡的 email 欄位。
//!   輸入裡除了額度數字以外的內容（工作階段、路徑、模型…）一律不留。
//! 紅線：函式一律吃家目錄路徑參數；只有 Tauri 指令與命令列入口會決定真實家目錄，測試不得呼叫它們。
use crate::claude_accounts;
use serde::Serialize;
use serde_json::Value;
use std::collections::HashMap;
use std::path::{Path, PathBuf};

pub(crate) mod merge;
pub(crate) mod owner;
pub(crate) mod owner_store;
pub(crate) mod state;

pub const MAX_ACCOUNTS: usize = 20;
const MAX_INPUT: usize = 1_000_000;

/// 一個帳號的額度紀錄。百分比是「剩餘」；`at` 是記錄時間（UTC，秒）。
/// `reset_at` 是舊欄位（兩條共用一個，屬於哪條見 `pick_reset`），舊版 ASN 只認它，照舊寫。
/// 新欄位（#374，舊版讀檔會略過）：`five_reset_at`／`week_reset_at` 是兩條各自的重置時間，
/// `five_at`／`week_at` 是兩條各自最後收進新值的時間（讀取時間）。全部選填。
#[derive(Serialize, Debug, PartialEq, Clone, Default)]
pub struct Quota {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub five_hour_pct: Option<u8>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub weekly_pct: Option<u8>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reset_at: Option<String>,
    pub at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub five_reset_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub week_reset_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub five_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub week_at: Option<String>,
    /// 這筆是視窗帶了帳號身分才記下的（#1185）：沒有標記的舊基準可能混進別的帳號的數字，第一次有身分的回報來時會清掉
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub owner: bool,
}

/// 從狀態列資料解析出來的額度（還沒有記錄時間）。`five_reset_ms`／`week_reset_ms` 是兩條各自的重置時間，
/// 用來判斷新舊（見 merge.rs），也寫進檔案的 `five_reset_at`／`week_reset_at`。
#[derive(Debug, PartialEq, Clone)]
pub struct Parsed {
    pub five_hour_pct: Option<u8>,
    pub weekly_pct: Option<u8>,
    pub reset_at: Option<String>,
    pub five_reset_ms: Option<i64>,
    pub week_reset_ms: Option<i64>,
}

pub fn quota_path(home: &Path) -> PathBuf {
    home.join(".asn").join("claude-quota.json")
}

// ---------- 時間 ----------
fn civil_from_days(z: i64) -> (i64, i64, i64) {
    let z = z + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (if m <= 2 { y + 1 } else { y }, m, d)
}
/// 毫秒 → `2026-10-24T12:00:00Z`
pub fn iso_secs(ms: i64) -> String {
    let s = ms.div_euclid(1000);
    let (y, m, d) = civil_from_days(s.div_euclid(86400));
    let r = s.rem_euclid(86400);
    format!("{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}Z", r / 3600, r % 3600 / 60, r % 60)
}

/// `iso_secs` 寫出的格式（`2026-10-24T12:00:00Z`）→ 毫秒；其他格式回 None
pub fn parse_iso_secs(s: &str) -> Option<i64> {
    let b = s.as_bytes();
    if b.len() != 20 || b[4] != b'-' || b[7] != b'-' || b[10] != b'T' || b[13] != b':' || b[16] != b':' || b[19] != b'Z' {
        return None;
    }
    let num = |r: std::ops::Range<usize>| s.get(r).filter(|t| t.bytes().all(|c| c.is_ascii_digit())).and_then(|t| t.parse::<i64>().ok());
    let (y, m, d, hh, mm, ss) = (num(0..4)?, num(5..7)?, num(8..10)?, num(11..13)?, num(14..16)?, num(17..19)?);
    if !(1..=12).contains(&m) || !(1..=31).contains(&d) || hh > 23 || mm > 59 || ss > 59 {
        return None;
    }
    let y2 = if m <= 2 { y - 1 } else { y };
    let era = if y2 >= 0 { y2 } else { y2 - 399 } / 400;
    let yoe = y2 - era * 400;
    let mp = if m > 2 { m - 3 } else { m + 9 };
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146097 + doe - 719468;
    Some((days * 86400 + hh * 3600 + mm * 60 + ss) * 1000)
}

// ---------- 解析 ----------
fn used_to_left(v: &Value) -> Option<u8> {
    let used = v.as_f64().filter(|u| u.is_finite() && *u >= 0.0)?;
    Some((100.0 - used).clamp(0.0, 100.0).round() as u8)
}
/// 重置時間：秒（或毫秒）為單位的數字；其他格式不採用
fn reset_ms(v: &Value) -> Option<i64> {
    let n = v.as_f64().filter(|n| n.is_finite() && *n > 0.0)?;
    Some(if n > 1e11 { n as i64 } else { (n * 1000.0) as i64 })
}
/// 一個視窗：(剩餘百分比, 重置毫秒)。重置時間已過代表那個百分比是重置前的舊值，整個視窗不採用。
fn window(rl: &Value, key: &str, now_ms: i64) -> Option<(u8, Option<i64>)> {
    let w = rl.get(key)?;
    let left = used_to_left(w.get("used_percentage")?)?;
    let reset = w.get("resets_at").and_then(reset_ms);
    if reset.is_some_and(|r| r <= now_ms) {
        return None;
    }
    Some((left, reset))
}

/// 要存的那一個重置時間屬於哪一條，規則跟介面的 `resetOwner`（account-quota.mjs）一致：
/// 用完（剩 0%）的那條；兩條都用完給較晚的；都沒用完就是 5 小時那條（沒有 5 小時那條才是每週的）。
/// 那條自己沒有重置時間就是 None——不拿另一條的來頂，免得畫面標「5 小時額度」卻是每週的時間。
pub fn pick_reset(five: Option<(u8, Option<i64>)>, week: Option<(u8, Option<i64>)>) -> Option<i64> {
    match (five, week) {
        (Some((0, a)), Some((0, b))) => a.max(b),
        (Some((0, a)), _) => a,
        (_, Some((0, b))) => b,
        (Some((_, a)), _) => a,
        (None, Some((_, b))) => b,
        (None, None) => None,
    }
}

/// 狀態列資料 → 額度。只讀 `rate_limits.five_hour／seven_day` 的已用百分比與重置時間；
/// 存的重置時間見 `pick_reset`。沒有任何視窗就是 None。
pub fn parse_statusline(text: &str, now_ms: i64) -> Option<Parsed> {
    let v: Value = serde_json::from_str(text).ok()?;
    let rl = v.get("rate_limits")?;
    let five = window(rl, "five_hour", now_ms);
    let week = window(rl, "seven_day", now_ms);
    if five.is_none() && week.is_none() {
        return None;
    }
    let reset = pick_reset(five, week);
    Some(Parsed {
        five_hour_pct: five.map(|f| f.0),
        weekly_pct: week.map(|w| w.0),
        reset_at: reset.map(iso_secs),
        five_reset_ms: five.and_then(|f| f.1),
        week_reset_ms: week.and_then(|w| w.1),
    })
}

// ---------- 讀寫 ----------
fn iso_like(s: &str) -> bool {
    !s.is_empty() && s.len() <= 40 && s.chars().all(|c| c.is_ascii_digit() || matches!(c, '-' | ':' | 'T' | 'Z' | '+' | '.'))
}
fn pct_of(v: Option<&Value>) -> Option<u8> {
    v.and_then(Value::as_u64).filter(|n| *n <= 100).map(|n| n as u8)
}

/// 額度檔裡的一筆 → Quota：每個欄位逐一驗證（超出範圍／格式不對的丟掉）；沒有任何百分比或沒有記錄時間就是 None。
/// Gemini 的本機檔（gemini_quota.rs）也用這份。
pub(crate) fn quota_from_value(v: &Value) -> Option<Quota> {
    let (five, week) = (pct_of(v.get("five_hour_pct")), pct_of(v.get("weekly_pct")));
    let at = v.get("at").and_then(Value::as_str).filter(|s| iso_like(s));
    let (true, Some(at)) = (five.is_some() || week.is_some(), at) else { return None };
    let s = |key: &str| v.get(key).and_then(Value::as_str).filter(|s| iso_like(s)).map(String::from);
    // 某條沒有百分比，它的重置時間與讀取時間也不留
    let only = |has: bool, x: Option<String>| x.filter(|_| has);
    Some(Quota {
        five_hour_pct: five,
        weekly_pct: week,
        reset_at: s("reset_at"),
        at: at.to_string(),
        five_reset_at: only(five.is_some(), s("five_reset_at")),
        week_reset_at: only(week.is_some(), s("week_reset_at")),
        five_at: only(five.is_some(), s("five_at")),
        week_at: only(week.is_some(), s("week_at")),
        owner: v.get("owner").and_then(Value::as_bool) == Some(true),
    })
}

/// 讀額度檔：檔案不存在或壞掉是空的；每個欄位逐一驗證（超出範圍／格式不對的丟掉），鍵必須是已正規化的 email，
/// 沒有任何百分比或沒有記錄時間的整筆不收。
pub fn load_all(home: &Path) -> HashMap<String, Quota> {
    let Some(Value::Object(m)) = std::fs::read_to_string(quota_path(home)).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok()) else { return HashMap::new() };
    let mut out = HashMap::new();
    for (k, v) in m.into_iter().take(MAX_ACCOUNTS * 2) {
        if claude_accounts::normalize_email(&k).as_deref() != Some(k.as_str()) {
            continue;
        }
        let Some(q) = quota_from_value(&v) else { continue };
        out.insert(k, q);
        if out.len() >= MAX_ACCOUNTS {
            break;
        }
    }
    out
}

/// 這次沒收的原因寫進 log：同一條同一個原因代碼連續發生只記一次，收進新值或原因換了才再記（#1184）
fn log_changes(home: &Path, st: &mut state::State, m: &merge::Merged, now_ms: i64) {
    let mut fresh = vec![];
    for s in &m.skipped {
        let slot = match s.kind {
            merge::Kind::Five => &mut st.logged_five,
            merge::Kind::Week => &mut st.logged_week,
        };
        if slot.as_deref() != Some(s.code) {
            *slot = Some(s.code.to_string());
            fresh.push(s.clone());
        }
    }
    if m.took_five {
        st.logged_five = None;
    }
    if m.took_week {
        st.logged_week = None;
    }
    merge::log_skipped(home, &fresh, now_ms);
}

/// 身分剛換過、這個帳號沒有基準時：兩條各自要「同一組新重置時間連續 3 次、隔 10 分鐘」才放行，沒確認的那條這次不收。
/// 同一台可能還開著舊帳號的視窗交錯送別組數字，所以第一筆不能直接收（#1184）
fn rebase_gate(st: &mut state::State, mut p: Parsed, now_ms: i64) -> Parsed {
    match p.week_reset_ms {
        Some(r) => {
            let (ok, next) = merge::confirm_week(st.pending_week(), r, now_ms);
            st.set_pending_week(next);
            if !ok {
                p.weekly_pct = None;
                p.week_reset_ms = None;
            }
        }
        None => p.weekly_pct = None,
    }
    match p.five_reset_ms {
        Some(r) => {
            let (ok, next) = merge::confirm_week(st.pending_five(), r, now_ms);
            st.set_pending_five(next);
            if !ok {
                p.five_hour_pct = None;
                p.five_reset_ms = None;
            }
        }
        None => p.five_hour_pct = None,
    }
    p
}

/// 記一筆：跟這個帳號現有的紀錄兩條各自判斷、逐欄合併（規則見 merge.rs）。不收的寫進 log（同一原因只記一次）。
/// `reset_base`＝登入身分剛換過：先丟掉這個 email 舊的紀錄，這次照新帳號的數字收。
/// 有收進任何一條回 Ok(true)；兩條都不收就不動檔案，回 Ok(false)。
fn record(home: &Path, email: &str, p: Parsed, st: &mut state::State, reset_base: bool, owned: bool, now_ms: i64) -> Result<bool, String> {
    let mut all = load_all(home);
    if reset_base && owned && all.contains_key(email) {
        owner_store::backup_quota_file(home);
    }
    let dropped = reset_base && all.remove(email).is_some();
    if dropped && owned {
        merge::append_log(&merge::log_path(home), &format!("{} 額度檔：清掉 1 筆沒有身分的舊基準（已備份）
", iso_secs(now_ms)));
    }
    let prev_owner = all.get(email).is_some_and(|q| q.owner);
    let p = if st.rebase && !all.contains_key(email) { rebase_gate(st, p, now_ms) } else { p };
    let m = merge::merge_full(merge::Vendor::Claude, all.get(email), &p, st.pending_week(), now_ms);
    st.set_pending_week(m.pending_week);
    log_changes(home, st, &m, now_ms);
    let took = m.quota.is_some();
    if took {
        st.rebase = false;
    }
    if let Some(mut q) = m.quota {
        q.owner = owned || prev_owner;
        all.insert(email.to_string(), q);
    } else if !dropped {
        return Ok(false);
    }
    if all.len() > MAX_ACCOUNTS {
        let mut by_age: Vec<(String, String)> = all.iter().map(|(k, q)| (q.at.clone(), k.clone())).collect();
        by_age.sort();
        let drop_n = all.len() - MAX_ACCOUNTS;
        for (_, k) in by_age.into_iter().take(drop_n) {
            all.remove(&k);
        }
    }
    let text = serde_json::to_string(&all).map_err(|e| e.to_string())?;
    crate::claude_json::write_atomic(&quota_path(home), text.as_bytes()).map_err(|e| e.to_string())?;
    Ok(took)
}

/// 狀態列掛鉤：把輸入裡的額度記在目前登入的帳號底下。有記下回 true；
/// 沒登入、沒額度、輸入太大、兩條都判斷成不收（舊數字或別的帳號）或寫檔失敗回 false。
/// 登入身分（email 與 accountUuid）跟上次看到的不一樣就重設該帳號的基準（#1184）；
/// 讀不到身分＝沒登入，照舊什麼都不記。
pub fn hook(home: &Path, input: &str, now_ms: i64) -> bool {
    let cfg = owner::config_dir(home, std::env::var_os("CLAUDE_CONFIG_DIR"));
    hook_in(home, &cfg, input, now_ms)
}

/// 同 [`hook`]，指定 Claude 設定資料夾（測試不碰真實環境變數）。
/// 狀態列輸入帶 transcript_path、而且那個對話紀錄裡找得到這個視窗的帳號身分時（#1185），額度記到那個帳號底下，
/// 不看現在 `.claude.json` 登入的是誰；查不到身分才走舊辦法（記在目前登入的帳號，換身分要連續確認）。
pub(crate) fn hook_in(home: &Path, cfg: &Path, input: &str, now_ms: i64) -> bool {
    if input.len() > MAX_INPUT {
        return false;
    }
    let Some(parsed) = parse_statusline(input, now_ms) else { return false };
    match owner::resolve(home, cfg, input) {
        Some(o) => hook_owned(home, &o, parsed, now_ms),
        None => hook_legacy(home, parsed, now_ms),
    }
}

/// 視窗帶了身分：uuid 對得到 email 就記在那個帳號；對不到是未知帳號，只留本機一小區，不進額度檔、不上傳
fn hook_owned(home: &Path, o: &owner::Owner, parsed: Parsed, now_ms: i64) -> bool {
    let Some(email) = claude_accounts::email_of_account_uuid(home, &o.account_uuid) else {
        owner_store::unknown_put(home, &o.account_uuid, &parsed, now_ms);
        return false;
    };
    let before = state::load(home);
    let mut all_st = before.clone();
    let mut st = all_st.take_owned(&email);
    // 這個帳號在額度檔裡有一筆、但沒有「有身分」的標記：舊基準可能混進別的帳號的數字，清掉（備份一份、log 只記筆數）
    let reset_base = load_all(home).get(&email).is_some_and(|q| !q.owner);
    let r = record(home, &email, parsed, &mut st, reset_base, true, now_ms).unwrap_or(false);
    all_st.put_owned(&email, st);
    if all_st != before {
        state::save(home, &all_st);
    }
    r
}

fn hook_legacy(home: &Path, parsed: Parsed, now_ms: i64) -> bool {
    let Some((email, uuid)) = claude_accounts::current_identity(home) else { return false };
    let before = state::load(home);
    let ident = format!("{email}|{uuid}");
    let mut st = before.clone();
    let mut reset_base = false;
    if st.identity.as_deref() != Some(ident.as_str()) {
        // 第一次看到（沒有狀態檔）只記下身分，不丟東西；真的從別的身分換過來才重設基準
        reset_base = st.identity.is_some();
        st = state::State { identity: Some(ident), rebase: reset_base, owned: st.owned.clone(), ..state::State::default() };
    }
    let r = record(home, &email, parsed, &mut st, reset_base, false, now_ms).unwrap_or(false);
    if st != before {
        state::save(home, &st);
    }
    r
}

impl Quota {
    /// 回報用的額度窗（#374，格式同後台 parseWindows）：`{ name, left_pct, resets_at, read_at }`，
    /// name 是 five_hour／weekly。重置時間用各條自己的；舊檔沒有才從舊的 `reset_at` 推（推不出來就是 null）；
    /// 讀取時間用各條自己的，沒有就用整筆的 `at`。
    pub fn windows(&self) -> Vec<Value> {
        let (r5, rw) = merge::stored_resets(self);
        let mut out = vec![];
        for (name, pct, reset, read) in [("five_hour", self.five_hour_pct, r5, &self.five_at), ("weekly", self.weekly_pct, rw, &self.week_at)] {
            let Some(left) = pct else { continue };
            let read_at = read.as_deref().unwrap_or(&self.at);
            out.push(serde_json::json!({ "name": name, "left_pct": left, "resets_at": reset.map(iso_secs), "read_at": read_at }));
        }
        out
    }
}

/// 前端讀本機各帳號的額度紀錄（email → 額度）
#[cfg_attr(feature = "gui", tauri::command)]
pub fn claude_quota_all() -> HashMap<String, Quota> {
    load_all(&claude_accounts::claude_home())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::acct_remote::build_report_with_quota;
    use crate::claude_accounts::AccountInfo;
    use serde_json::json;

    // 2026-10-24T12:00:00Z
    const NOW: i64 = 1_792_843_200_000;

    fn status(five_used: f64, five_reset: i64, week_used: f64, week_reset: i64) -> String {
        json!({
            "session_id": "S-1", "cwd": "D:/x", "model": { "id": "m" },
            "oauth_token": "SECRET-TOKEN",
            "rate_limits": {
                "five_hour": { "used_percentage": five_used, "resets_at": five_reset },
                "seven_day": { "used_percentage": week_used, "resets_at": week_reset }
            }
        })
        .to_string()
    }

    #[test]
    fn 狀態列資料換算成剩餘百分比與重置時間() {
        let p = parse_statusline(&status(38.4, 1_792_850_400, 20.0, 1_793_000_000), NOW).unwrap();
        assert_eq!(p.five_hour_pct, Some(62));
        assert_eq!(p.weekly_pct, Some(80));
        assert_eq!(p.reset_at.as_deref(), Some("2026-10-24T14:00:00Z"), "沒用完時給 5 小時視窗的重置時間");
    }

    #[test]
    fn 某個視窗用完時重置時間給用完的那個_兩個都用完給較晚的() {
        let p = parse_statusline(&status(100.0, 1_792_850_400, 40.0, 1_793_000_000), NOW).unwrap();
        assert_eq!((p.five_hour_pct, p.weekly_pct), (Some(0), Some(60)));
        assert_eq!(p.reset_at.as_deref(), Some("2026-10-24T14:00:00Z"));
        let p = parse_statusline(&status(120.0, 1_792_850_400, 100.0, 1_793_000_000), NOW).unwrap();
        assert_eq!((p.five_hour_pct, p.weekly_pct), (Some(0), Some(0)), "超過 100 也只算 0");
        assert_eq!(p.reset_at.as_deref(), Some("2026-10-26T07:33:20Z"));
    }

    #[test]
    fn 沒有額度欄位_或格式不對_就是沒有紀錄() {
        for t in ["", "不是 json", "{}", r#"{"rate_limits":{}}"#, r#"{"rate_limits":{"five_hour":{"used_percentage":"多"}}}"#, r#"{"rate_limits":{"five_hour":{"used_percentage":-3}}}"#, r#"{"rate_limits":null}"#] {
            assert!(parse_statusline(t, NOW).is_none(), "{t}");
        }
    }

    #[test]
    fn 只有一個視窗也收_另一個留空不編() {
        let p = parse_statusline(r#"{"rate_limits":{"five_hour":{"used_percentage":10,"resets_at":1792850400}}}"#, NOW).unwrap();
        assert_eq!((p.five_hour_pct, p.weekly_pct), (Some(90), None));
    }

    fn tmp_home() -> tempfile::TempDir {
        tempfile::tempdir().unwrap()
    }
    fn write_cj(home: &std::path::Path, email: &str) {
        std::fs::write(home.join(".claude.json"), json!({ "oauthAccount": { "emailAddress": email, "accountUuid": "11111111-2222-3333-4444-555555555555" } }).to_string()).unwrap();
    }

    #[test]
    fn 掛鉤把額度記在目前登入的帳號底下_不留任何其他內容() {
        let h = tmp_home();
        write_cj(h.path(), "A@X.test");
        assert!(hook(h.path(), &status(38.0, 1_792_850_400, 20.0, 1_793_000_000), NOW));
        let all = load_all(h.path());
        let q = all.get("a@x.test").expect("以正規化 email 為鍵");
        assert_eq!((q.five_hour_pct, q.weekly_pct), (Some(62), Some(80)));
        assert_eq!(q.at, "2026-10-24T12:00:00Z");
        // 守門：檔案只有額度四欄，沒有輸入裡的 token／工作階段／路徑
        let raw = std::fs::read_to_string(quota_path(h.path())).unwrap();
        for bad in ["SECRET", "oauth_token", "session_id", "cwd", "D:/x"] {
            assert!(!raw.contains(bad), "額度檔不該含 {bad}");
        }
        let v: serde_json::Value = serde_json::from_str(&raw).unwrap();
        let mut keys: Vec<&String> = v["a@x.test"].as_object().unwrap().keys().collect();
        keys.sort();
        assert_eq!(keys, ["at", "five_at", "five_hour_pct", "five_reset_at", "reset_at", "week_at", "week_reset_at", "weekly_pct"]);
        assert_eq!((v["a@x.test"]["five_reset_at"].as_str(), v["a@x.test"]["week_reset_at"].as_str()), (Some("2026-10-24T14:00:00Z"), Some("2026-10-26T07:33:20Z")), "兩條各存自己的重置時間");
    }

    #[test]
    fn 掛鉤沒登入或沒額度就什麼都不寫() {
        let h = tmp_home();
        assert!(!hook(h.path(), &status(1.0, 1_792_850_400, 1.0, 1_793_000_000), NOW), "沒登入");
        assert!(!quota_path(h.path()).exists());
        write_cj(h.path(), "a@x.test");
        assert!(!hook(h.path(), "{}", NOW), "沒額度欄位");
        assert!(!quota_path(h.path()).exists());
    }

    #[test]
    fn 同一帳號覆寫_不同帳號並存_最多留_20_個() {
        let h = tmp_home();
        write_cj(h.path(), "a@x.test");
        hook(h.path(), &status(10.0, 1_792_850_400, 10.0, 1_793_000_000), NOW);
        hook(h.path(), &status(50.0, 1_792_850_400, 10.0, 1_793_000_000), NOW + 60_000);
        // 換身分後新帳號要同一組重置時間連續 3 次、隔 10 分鐘才收（#1184）：每個帳號照這個節奏送
        let confirm = |email: &str, used: f64, t: i64| {
            write_cj(h.path(), email);
            for k in 0..3 {
                hook(h.path(), &status(used, 1_793_000_000, used, 1_793_000_000), t + k * 5 * 60_000);
            }
        };
        confirm("b@x.test", 70.0, NOW + 120_000);
        let all = load_all(h.path());
        assert_eq!(all["a@x.test"].five_hour_pct, Some(50));
        assert_eq!(all["b@x.test"].five_hour_pct, Some(30));
        for i in 0..25 {
            confirm(&format!("u{i}@x.test"), 5.0, NOW + 3_000_000 + i * 20 * 60_000);
        }
        let all = load_all(h.path());
        assert_eq!(all.len(), 20);
        assert!(all.contains_key("u24@x.test") && !all.contains_key("a@x.test"), "留最新的");
    }

    #[test]
    fn 額度檔壞掉或被竄改時讀出來是空的_不當機() {
        let h = tmp_home();
        std::fs::create_dir_all(h.path().join(".asn")).unwrap();
        std::fs::write(quota_path(h.path()), "壞掉{").unwrap();
        assert!(load_all(h.path()).is_empty());
        std::fs::write(quota_path(h.path()), r#"{"a@x.test":{"five_hour_pct":999,"weekly_pct":"x","at":"T"},"c@x.test":{"five_hour_pct":999,"weekly_pct":40,"at":"2026-10-24T12:00:00Z"},"壞":{"five_hour_pct":1,"at":"T"}}"#).unwrap();
        let all = load_all(h.path());
        assert!(!all.contains_key("a@x.test"), "兩個百分比都壞掉的整筆不收");
        assert!(!all.contains_key("壞"), "不是 email 的鍵不收");
        assert_eq!((all["c@x.test"].five_hour_pct, all["c@x.test"].weekly_pct), (None, Some(40)), "超出範圍的欄位單獨丟掉");
    }

    fn acct(email: &str, current: bool) -> AccountInfo {
        AccountInfo { email: email.into(), plan: "max".into(), org: "ORG".into(), current, saved: true, login_incomplete: false }
    }

    #[test]
    fn 回報只對有紀錄的_claude_帳號帶額度四欄_其餘維持原樣() {
        let h = tmp_home();
        write_cj(h.path(), "a@x.test");
        hook(h.path(), &status(38.0, 1_792_850_400, 20.0, 1_793_000_000), NOW);
        let v = build_report_with_quota(&[acct("a@x.test", true), acct("b@x.test", false)], None, &load_all(h.path()));
        assert_eq!(v["accounts"][0], json!({ "vendor": "claude", "email": "a@x.test", "plan": "max", "current": true, "five_hour_pct": 62, "weekly_pct": 80, "reset_at": "2026-10-24T14:00:00Z", "at": "2026-10-24T12:00:00Z",
            "five_reset_at": "2026-10-24T14:00:00Z", "week_reset_at": "2026-10-26T07:33:20Z",
            "windows": [
                { "name": "five_hour", "left_pct": 62, "resets_at": "2026-10-24T14:00:00Z", "read_at": "2026-10-24T12:00:00Z" },
                { "name": "weekly", "left_pct": 80, "resets_at": "2026-10-26T07:33:20Z", "read_at": "2026-10-24T12:00:00Z" }
            ] }), "同時帶舊四欄與額度窗，兩條各有自己的重置時間");
        assert_eq!(v["accounts"][1], json!({ "vendor": "claude", "email": "b@x.test", "plan": "max", "current": false }), "沒有紀錄的帳號不帶任何額度欄位");
        let low = v.to_string().to_lowercase();
        for bad in ["token", "secret", "org", "uuid"] {
            assert!(!low.contains(bad), "回報不該含 {bad}");
        }
    }

    #[test]
    fn 守門_額度模組不碰憑證檔也不連網() {
        // 把會觸發的字串拆開寫，避免這個檢查自己命中自己
        let src = include_str!("claude_quota.rs");
        let body = src.split("#[cfg(test)]").next().unwrap_or("");
        let banned = [
            [".cred", "entials"].concat(),
            ["claude", "AiOauth"].concat(),
            ["read_", "cred"].concat(),
            ["access", "Token"].concat(),
            ["refresh", "Token"].concat(),
            ["http", "://"].concat(),
            ["https", "://"].concat(),
            ["reqw", "est"].concat(),
            ["Comm", "and::new"].concat(),
            ["current_", "login"].concat(),
        ];
        for b in banned {
            assert!(!body.contains(&b), "額度模組不該出現 {b}");
        }
        // 只靠 .claude.json 的 email 欄位判斷目前帳號
        assert!(body.contains("current_identity"));
    }

    #[test]
    fn 指令列掛鉤已登記_且吃不下垃圾也不會失敗() {
        let cmd = include_str!("cli/mod.rs");
        assert!(cmd.contains("\"claude-quota\""), "子命令要登記");
        let h = tmp_home();
        write_cj(h.path(), "a@x.test");
        assert!(!hook(h.path(), &"x".repeat(5_000_000), NOW), "太大的輸入直接略過");
        assert!(!hook(h.path(), "\u{0}\u{1}垃圾", NOW));
    }
}

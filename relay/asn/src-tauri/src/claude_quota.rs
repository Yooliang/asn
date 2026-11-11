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

/// 帶毫秒也認的 ISO（`2026-11-09T12:00:00.123Z`）→ 毫秒；Claude 對話紀錄的時間戳是這個格式。其他格式回 None
pub(crate) fn parse_iso_ms(s: &str) -> Option<i64> {
    if let Some(ms) = parse_iso_secs(s) {
        return Some(ms);
    }
    let (head, frac) = s.strip_suffix('Z')?.split_once('.')?;
    if head.len() != 19 || frac.is_empty() || !frac.bytes().all(|c| c.is_ascii_digit()) {
        return None;
    }
    let ms: i64 = frac.chars().chain("000".chars()).take(3).collect::<String>().parse().ok()?;
    Some(parse_iso_secs(&format!("{head}Z"))? + ms)
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

/// 記一筆：跟這個帳號現有的紀錄兩條各自判斷、逐欄合併（規則見 merge.rs）。不收的寫進 log（同一原因只記一次）。
/// `read_ms`＝這筆數字的資料時間（對話紀錄裡最後一筆 assistant 回應的時間）。
/// `clear_unowned`＝這個帳號在額度檔裡那筆沒有「有身分」的標記：舊辦法記的，可能混進別的帳號的數字，先備份、清掉，這次照新數字收；
/// 備份失敗就不清（留著比丟掉安全），這筆也不蓋有身分的標記，下次再試。
/// 有收進任何一條回 Ok(true)；兩條都不收就不動檔案，回 Ok(false)。
fn record(home: &Path, email: &str, p: Parsed, read_ms: i64, st: &mut state::State, clear_unowned: bool, now_ms: i64) -> Result<bool, String> {
    let mut all = load_all(home);
    let mut clear = clear_unowned && all.contains_key(email);
    let mut backup_failed = false;
    if clear && !owner_store::backup_quota_file(home) {
        merge::append_log(&merge::log_path(home), &format!("{} 額度檔：備份失敗，沒有清舊基準\n", iso_secs(now_ms)));
        clear = false;
        backup_failed = true;
    }
    let dropped = clear && all.remove(email).is_some();
    if dropped {
        merge::append_log(&merge::log_path(home), &format!("{} 額度檔：清掉 1 筆沒有身分的舊基準（已備份）\n", iso_secs(now_ms)));
    }
    // 每週重置時間當帳號指紋，跟本機其他帳號比：串號的讀數不收，存著的是串號就換掉
    let mut cur = all.get(email).cloned();
    let mut replaced = false;
    match week_cross(home, st, email, merge::week_fingerprint(&all, email, &p, now_ms), now_ms) {
        Some(true) => return Ok(false),
        Some(false) => {
            cur = cur.as_ref().map(merge::without_week);
            replaced = true;
        }
        None => {}
    }
    // 這次讀數完全沒有某一窗、存著的那一窗也已過重置時間：把那一窗拿掉，再合併新讀數（#1321）
    let trimmed = cur.as_ref().and_then(|q| merge::without_missing_expired(q, &p, now_ms));
    let m = merge::merge_full(trimmed.as_ref().or(cur.as_ref()), &p, read_ms, now_ms);
    log_changes(home, st, &m, now_ms);
    let took = m.quota.is_some() || trimmed.is_some() || replaced;
    // 兩條都沒收、只有拿掉過期窗或換掉串號的那條：照樣要寫
    let out = m.quota.or(trimmed).or(replaced.then(|| cur.clone()).flatten()).map(|mut q| {
        q.owner = !backup_failed;
        q
    });
    if let Some(q) = out {
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

/// 每週重置時間指紋的結果處理：回 Some(true)＝這筆不收（串號或對不上）、Some(false)＝存著的是串號要換掉、None＝沒事。
/// 有事都寫一行 log：只有帳號雜湊的前 6 碼與兩個重置時間（不含 email）；同一個原因連續發生只記一次。
fn week_cross(home: &Path, st: &mut state::State, email: &str, c: merge::Cross, now_ms: i64) -> Option<bool> {
    use merge::Cross::*;
    let h = owner::short_hash(email);
    let t = |ms: i64| iso_secs(ms);
    let (line, reject) = match c {
        Pass => {
            st.logged_cross = None;
            return None;
        }
        IncomingFromOther { new_reset, stored_reset } => (format!("帳號 {h} 每週重置時間 {} 是本機另一個帳號還沒過期的那一期（這帳號存著的是 {}），這筆是別的帳號的數字，不收", t(new_reset), t(stored_reset)), true),
        StoredFromOther { new_reset, stored_reset } => (format!("帳號 {h} 存著的每週重置時間 {} 是本機另一個帳號的那一期，換成這次的 {}", t(stored_reset), t(new_reset)), false),
        Unmatched { new_reset, stored_reset } => (format!("帳號 {h} 每週重置時間 {} 跟存著還沒過期的 {} 不同、也對不上本機其他帳號，不收，等存著的那一期過期再收", t(new_reset), t(stored_reset)), true),
    };
    if st.logged_cross.as_deref() != Some(line.as_str()) {
        merge::append_log(&merge::log_path(home), &format!("{} {line}\n", iso_secs(now_ms)));
        st.logged_cross = Some(line);
    }
    Some(reject)
}

/// 狀態列掛鉤：把輸入裡的額度記在「這個視窗自己的帳號」底下。有記下回 true；
/// 沒額度、輸入太大、沒身分、取不到資料時間、兩條都判斷成不收或寫檔失敗回 false。
pub fn hook(home: &Path, input: &str, now_ms: i64) -> bool {
    let cfg = owner::config_dir(home, std::env::var_os("CLAUDE_CONFIG_DIR"));
    hook_in(home, &cfg, input, now_ms)
}

/// 同 [`hook`]，指定 Claude 設定資料夾（測試不碰真實環境變數）。
/// 帳號與資料時間都從這個視窗的對話紀錄（transcript_path）來（#1185、#1266）：
/// - 沒帶 `transcript_path`（舊版 Claude Code）：不收，只記下「看過舊版視窗」，畫面據此寫一句固定的人話（`legacy_email`）。
/// - 帶了但解不出身分（還沒寫出 session-owner、被擠出檔尾、格式壞、路徑不安全）或取不到最後一筆 assistant 回應的時間戳：這次不記。
/// - 都有：額度記到該帳號底下，資料時間用那個時間戳；比記著的舊就不收（閒置的視窗會一直重送舊數字）。
pub(crate) fn hook_in(home: &Path, cfg: &Path, input: &str, now_ms: i64) -> bool {
    if input.len() > MAX_INPUT {
        return false;
    }
    let Some(parsed) = parse_statusline(input, now_ms) else { return false };
    if !owner::transcript_given(input) {
        note_legacy(home, now_ms);
        return false;
    }
    let Some((o, last_ms)) = owner::resolve_timed(home, cfg, input) else { return false };
    let Some(read_ms) = last_ms else { return false };
    // 對話紀錄記的是「這個視窗開的時候的帳號」；ASN 切換帳號後，同一個視窗之後送來的額度可能已經是新帳號的（對話紀錄的身分不會變）。
    // 所以再看這個視窗自己的登入設定（.claude.json 的 oauthAccount）：兩邊一致才收，不一致或讀不到都不記
    if !window_matches(home, cfg, input, &o, now_ms) {
        return false;
    }
    hook_owned(home, cfg, &o, parsed, read_ms, now_ms)
}

/// 視窗現在登入的帳號跟對話紀錄的身分一致才回 true。不一致、讀不到都不記，寫一行 log（只有兩邊 uuid 與視窗路徑雜湊的前 6 碼；同一個原因連續發生只記一次）
fn window_matches(home: &Path, cfg: &Path, input: &str, o: &owner::Owner, now_ms: i64) -> bool {
    let cur = owner::window_account_uuid(home, cfg);
    let ok = cur.as_deref().is_some_and(|c| c.eq_ignore_ascii_case(&o.account_uuid));
    let mut st = state::load(home);
    if ok {
        if st.logged_window.take().is_some() {
            state::save(home, &st);
        }
        return true;
    }
    let win = owner::transcript_of(input).map(|p| owner::short_hash(&p.to_string_lossy())).unwrap_or_default();
    let line = match cur {
        Some(c) => format!("視窗帳號對不上：視窗 {win}，對話紀錄 {}、視窗目前登入 {}，這筆不記", owner::short_hash(&o.account_uuid), owner::short_hash(&c)),
        None => format!("視窗帳號讀不到：視窗 {win}，對話紀錄 {}，這筆不記", owner::short_hash(&o.account_uuid)),
    };
    if st.logged_window.as_deref() != Some(line.as_str()) {
        merge::append_log(&merge::log_path(home), &format!("{} {line}\n", iso_secs(now_ms)));
        st.logged_window = Some(line);
        state::save(home, &st);
    }
    false
}

/// 視窗帶了身分：uuid 對得到 email 就記在那個帳號；對不到是未知帳號，只留本機一小區，不進額度檔、不上傳
fn hook_owned(home: &Path, cfg: &Path, o: &owner::Owner, parsed: Parsed, read_ms: i64, now_ms: i64) -> bool {
    let Some(email) = claude_accounts::email_of_account_uuid(home, cfg, &o.account_uuid) else {
        owner_store::unknown_put(home, &o.account_uuid, &parsed, now_ms);
        return false;
    };
    let before = state::load(home);
    let mut all_st = before.clone();
    let mut st = all_st.take_owned(&email);
    // 這個帳號在額度檔裡有一筆、但沒有「有身分」的標記：舊基準可能混進別的帳號的數字，清掉（備份一份、log 只記筆數）
    let clear_unowned = load_all(home).get(&email).is_some_and(|q| !q.owner);
    let r = record(home, &email, parsed, read_ms, &mut st, clear_unowned, now_ms).unwrap_or(false);
    all_st.put_owned(&email, st);
    if all_st != before {
        state::save(home, &all_st);
    }
    r
}

/// 舊版視窗（沒帶 transcript_path）最近一次被看到的時間：每 10 分鐘最多寫一次，狀態列叫得很勤，不能每次都寫檔
const LEGACY_REWRITE_MS: i64 = 10 * 60_000;
/// 畫面上提示「升級 Claude Code」要看多久內有舊版視窗
const LEGACY_SHOW_MS: i64 = 30 * 60_000;

fn note_legacy(home: &Path, now_ms: i64) {
    let mut st = state::load(home);
    if st.legacy_at.as_deref().and_then(parse_iso_secs).is_some_and(|t| now_ms - t < LEGACY_REWRITE_MS) {
        return;
    }
    st.legacy_at = Some(iso_secs(now_ms));
    state::save(home, &st);
}

/// 目前登入的帳號，如果最近有舊版視窗在跑、而且額度檔還沒有它的紀錄：回它的 email；畫面據此寫「升級 Claude Code 後才會顯示額度」
pub fn legacy_email(home: &Path, now_ms: i64) -> Option<String> {
    let st = state::load(home);
    st.legacy_at.as_deref().and_then(parse_iso_secs).filter(|t| now_ms - t < LEGACY_SHOW_MS)?;
    let (email, _) = claude_accounts::current_identity(home)?;
    (!load_all(home).contains_key(&email)).then_some(email)
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

impl Quota {
    /// 送出前把「重置時間已經過了」的窗拿掉（#1212）：那個百分比是重置前的舊值，不代表現在，送出去只會蓋掉後台較新的數字。
    /// 只拿掉過期的那一條（該條的百分比、重置時間、讀取時間），另一條原封不動；舊的單一 `reset_at` 依剩下的窗重算；
    /// 兩條都過期（或本來就沒有）回 None。沒有重置時間的窗無從判斷過沒過期，留著。`owner` 等其他欄位照舊帶著（回報本來就不送它）。
    pub fn without_expired(&self, now_ms: i64) -> Option<Quota> {
        let (r5, rw) = merge::stored_resets(self);
        let gone = |pct: Option<u8>, r: Option<i64>| pct.is_some() && r.is_some_and(|r| r <= now_ms);
        let (drop5, dropw) = (gone(self.five_hour_pct, r5), gone(self.weekly_pct, rw));
        let five = self.five_hour_pct.filter(|_| !drop5);
        let week = self.weekly_pct.filter(|_| !dropw);
        if five.is_none() && week.is_none() {
            return None;
        }
        let reset_at = pick_reset(five.map(|p| (p, r5)), week.map(|p| (p, rw))).map(iso_secs);
        Some(Quota {
            five_hour_pct: five,
            weekly_pct: week,
            reset_at: if drop5 || dropw { reset_at } else { self.reset_at.clone() },
            at: self.at.clone(),
            five_reset_at: self.five_reset_at.clone().filter(|_| !drop5),
            week_reset_at: self.week_reset_at.clone().filter(|_| !dropw),
            five_at: self.five_at.clone().filter(|_| !drop5),
            week_at: self.week_at.clone().filter(|_| !dropw),
            owner: self.owner,
        })
    }
}

/// 回報前整理各帳號的額度（#1212）：每個帳號拿掉過期的窗，兩條都過期的帳號就不帶額度（帳號本身仍在帳號清單裡）。
/// 不能改成「只送有在更新的帳號」：後台的 acct_report 每次都用這次送來的清單整份覆寫這台電腦的帳號清單，沒送的帳號會從名單上消失。
pub fn without_expired(all: &HashMap<String, Quota>, now_ms: i64) -> HashMap<String, Quota> {
    all.iter().filter_map(|(k, q)| q.without_expired(now_ms).map(|q| (k.clone(), q))).collect()
}

/// 前端讀本機各帳號的額度紀錄（email → 額度）。讀檔：在背景執行緒跑，不佔畫面那條執行緒（todo-next-191）
#[cfg_attr(feature = "gui", tauri::command(async))]
pub fn claude_quota_all() -> HashMap<String, Value> {
    quota_all_view(&claude_accounts::claude_home(), crate::heartbeat::now_ms() as i64)
}

/// 各帳號的額度紀錄；最近有舊版視窗在跑、而且沒有紀錄的那個帳號回 `{ "legacy": true }`（畫面寫固定的一句人話）
pub(crate) fn quota_all_view(home: &Path, now_ms: i64) -> HashMap<String, Value> {
    let mut out: HashMap<String, Value> = load_all(home).into_iter().filter_map(|(k, q)| serde_json::to_value(q).ok().map(|v| (k, v))).collect();
    if let Some(e) = legacy_email(home, now_ms) {
        out.entry(e).or_insert_with(|| serde_json::json!({ "legacy": true }));
    }
    out
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

    const UA: &str = "aaaaaaaa-1111-2222-3333-444444444444";

    fn add_account(home: &std::path::Path, email: &str, uuid: &str) {
        // 帳號庫的資料夾名是正規化（小寫）後的 email
        let email = crate::claude_accounts::normalize_email(email).unwrap();
        let d = home.join(".asn").join("claude-accounts").join(crate::claude_accounts::email_dir_name(&email));
        std::fs::create_dir_all(&d).unwrap();
        std::fs::write(d.join("account.json"), json!({ "accountUuid": uuid, "emailAddress": email }).to_string()).unwrap();
    }
    /// 一個視窗回報一次：寫對話紀錄（session-owner＋最後一筆 assistant 回應，時間 ts）、狀態列輸入帶 transcript_path、呼叫掛鉤
    fn feed(h: &tempfile::TempDir, email: &str, uuid: &str, name: &str, ts: i64, pad: usize, status_json: String, now: i64) -> bool {
        add_account(h.path(), email, uuid);
        let d = h.path().join(".claude").join("projects").join("p");
        std::fs::create_dir_all(&d).unwrap();
        let f = d.join(format!("{name}.jsonl"));
        let owner = json!({ "type": "session-owner", "accountUuid": uuid, "organizationUuid": "cccccccc-1111-2222-3333-444444444444" });
        let asst = json!({ "type": "assistant", "timestamp": iso_secs(ts).replace('Z', ".250Z") });
        std::fs::write(&f, format!("{}\n{owner}\n{asst}\n", json!({ "type": "user", "pad": "x".repeat(pad) }))).unwrap();
        let mut v: serde_json::Value = serde_json::from_str(&status_json).unwrap();
        v["transcript_path"] = json!(f.to_string_lossy());
        owner::test_set_window_account(h.path(), uuid);
        hook_in(h.path(), &h.path().join(".claude"), &v.to_string(), now)
    }

    #[test]
    fn 掛鉤把額度記在視窗自己的帳號底下_不留任何其他內容() {
        let h = tmp_home();
        assert!(feed(&h, "A@X.test", UA, "w1", NOW, 1, status(38.0, 1_792_850_400, 20.0, 1_793_000_000), NOW));
        let all = load_all(h.path());
        let q = all.get("a@x.test").expect("以正規化 email 為鍵");
        assert_eq!((q.five_hour_pct, q.weekly_pct), (Some(62), Some(80)));
        assert_eq!(q.at, "2026-10-24T12:00:00Z");
        // 守門：檔案只有額度欄位，沒有輸入裡的 token／工作階段／路徑
        let raw = std::fs::read_to_string(quota_path(h.path())).unwrap();
        for bad in ["SECRET", "oauth_token", "session_id", "cwd", "D:/x", "transcript"] {
            assert!(!raw.contains(bad), "額度檔不該含 {bad}");
        }
        let v: serde_json::Value = serde_json::from_str(&raw).unwrap();
        let mut keys: Vec<&String> = v["a@x.test"].as_object().unwrap().keys().collect();
        keys.sort();
        assert_eq!(keys, ["at", "five_at", "five_hour_pct", "five_reset_at", "owner", "reset_at", "week_at", "week_reset_at", "weekly_pct"]);
        assert_eq!((v["a@x.test"]["five_reset_at"].as_str(), v["a@x.test"]["week_reset_at"].as_str()), (Some("2026-10-24T14:00:00Z"), Some("2026-10-26T07:33:20Z")), "兩條各存自己的重置時間");
    }

    #[test]
    fn 掛鉤沒帶身分或沒額度就什麼都不寫() {
        let h = tmp_home();
        write_cj(h.path(), "a@x.test");
        assert!(!hook(h.path(), &status(1.0, 1_792_850_400, 1.0, 1_793_000_000), NOW), "沒帶 transcript_path（舊版）不收");
        assert!(!quota_path(h.path()).exists());
        assert!(!hook(h.path(), "{}", NOW), "沒額度欄位");
        assert!(!quota_path(h.path()).exists());
    }

    #[test]
    fn 同一帳號覆寫_不同帳號並存_最多留_20_個() {
        let h = tmp_home();
        assert!(feed(&h, "a@x.test", UA, "wa", NOW, 1, status(10.0, 1_792_850_400, 10.0, 1_793_000_000), NOW));
        assert!(feed(&h, "a@x.test", UA, "wa", NOW + 60_000, 2, status(50.0, 1_792_850_400, 10.0, 1_793_000_000), NOW + 60_000));
        assert!(feed(&h, "b@x.test", "bbbbbbbb-1111-2222-3333-444444444444", "wb", NOW + 120_000, 3, status(70.0, 1_792_850_400, 10.0, 1_793_000_000), NOW + 120_000));
        let all = load_all(h.path());
        assert_eq!(all["a@x.test"].five_hour_pct, Some(50));
        assert_eq!(all["b@x.test"].five_hour_pct, Some(30));
        for i in 0..25usize {
            let t = NOW + 200_000 + i as i64 * 1000;
            assert!(feed(&h, &format!("u{i}@x.test"), &format!("{:08x}-0000-0000-0000-000000000000", i + 1), &format!("w{i}"), t, i, status(5.0, 1_792_850_400, 5.0, 1_793_000_000), t));
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

    fn quota_two(r5: Option<&str>, rw: Option<&str>) -> Quota {
        Quota {
            five_hour_pct: Some(40),
            weekly_pct: Some(70),
            reset_at: r5.map(String::from),
            at: "2026-11-09T12:00:00Z".into(),
            five_reset_at: r5.map(String::from),
            week_reset_at: rw.map(String::from),
            five_at: Some("2026-11-09T12:00:00Z".into()),
            week_at: Some("2026-11-09T11:00:00Z".into()),
            owner: true,
        }
    }
    fn names(q: &Quota) -> Vec<String> {
        q.windows().iter().map(|w| w["name"].as_str().unwrap().to_string()).collect()
    }
    // 2026-11-09T13:00:00Z
    const T0: i64 = 1_794_229_200_000;

    #[test]
    fn 只有一條窗而且過期_整筆額度回_none_帳號仍在回報清單上() {
        // 只有 5 小時那條，重置時間已過
        let only_five = Quota {
            five_hour_pct: Some(50),
            reset_at: Some("2026-11-09T12:00:00Z".into()),
            five_reset_at: Some("2026-11-09T12:00:00Z".into()),
            at: "2026-11-09T11:00:00Z".into(),
            five_at: Some("2026-11-09T11:00:00Z".into()),
            ..Default::default()
        };
        assert_eq!(only_five.without_expired(T0), None);
        // 只有每週那條，重置時間已過
        let only_week = Quota {
            weekly_pct: Some(60),
            reset_at: Some("2026-11-09T12:00:00Z".into()),
            week_reset_at: Some("2026-11-09T12:00:00Z".into()),
            at: "2026-11-09T11:00:00Z".into(),
            week_at: Some("2026-11-09T11:00:00Z".into()),
            ..Default::default()
        };
        assert_eq!(only_week.without_expired(T0), None);
        // 整批整理：該帳號不再帶額度，但帳號仍在回報的清單裡（只是沒有額度欄位）
        let all: HashMap<String, Quota> = [("a@x.test".to_string(), only_five), ("b@x.test".to_string(), only_week)].into_iter().collect();
        let kept = without_expired(&all, T0);
        assert!(kept.is_empty());
        let v = build_report_with_quota(&[acct("a@x.test", true), acct("b@x.test", false)], None, &kept);
        let rows = v["accounts"].as_array().unwrap();
        assert_eq!(rows.len(), 2, "帳號都還在清單上");
        assert_eq!(rows[0], json!({ "vendor": "claude", "email": "a@x.test", "plan": "max", "current": true }));
        assert_eq!(rows[1], json!({ "vendor": "claude", "email": "b@x.test", "plan": "max", "current": false }));
        // 同樣的單窗紀錄，還沒過期就照送
        let fresh = Quota { five_hour_pct: Some(50), five_reset_at: Some("2026-11-09T15:00:00Z".into()), reset_at: Some("2026-11-09T15:00:00Z".into()), at: "2026-11-09T11:00:00Z".into(), ..Default::default() };
        assert_eq!(fresh.without_expired(T0), Some(fresh.clone()));
    }

    #[test]
    fn 舊格式只有單一_reset_at_過期就拿掉_屬於哪一條照舊規則推() {
        let legacy = |five: Option<u8>, week: Option<u8>, reset: &str| Quota { five_hour_pct: five, weekly_pct: week, reset_at: Some(reset.into()), at: "2026-11-09T11:00:00Z".into(), ..Default::default() };
        // 兩條都沒用完：單一 reset_at 屬於 5 小時那條。過期 → 5 小時拿掉，每週留著（沒存重置時間，無從判斷）
        let got = legacy(Some(40), Some(70), "2026-11-09T12:00:00Z").without_expired(T0).expect("每週還在");
        assert_eq!(names(&got), ["weekly"]);
        assert_eq!((got.five_hour_pct, got.weekly_pct), (None, Some(70)));
        assert_eq!(got.reset_at, None, "剩下的每週沒有重置時間，舊的單一重置時間不能再沿用");
        assert!(got.windows()[0]["resets_at"].is_null());
        assert_eq!(got.at, "2026-11-09T11:00:00Z");
        // 每週用完（剩 0%）：單一 reset_at 屬於每週那條。過期 → 每週拿掉，5 小時留著
        let got = legacy(Some(40), Some(0), "2026-11-09T12:00:00Z").without_expired(T0).expect("5 小時還在");
        assert_eq!(names(&got), ["five_hour"]);
        assert_eq!((got.five_hour_pct, got.weekly_pct, got.reset_at.clone()), (Some(40), None, None));
        // 只有 5 小時一條、過期 → 整筆沒了
        assert_eq!(legacy(Some(50), None, "2026-11-09T12:00:00Z").without_expired(T0), None);
        // 沒過期：整筆不變
        let ok = legacy(Some(40), Some(70), "2026-11-09T15:00:00Z");
        assert_eq!(ok.without_expired(T0), Some(ok.clone()));
        // 兩條都用完：推不出單一 reset_at 屬於哪一條，兩條都留著（不亂丟）
        let both0 = legacy(Some(0), Some(0), "2026-11-09T12:00:00Z");
        assert_eq!(names(&both0.without_expired(T0).unwrap()), ["five_hour", "weekly"]);
    }

    #[test]
    fn 過期的窗不送_沒過期的照送_另一條原封不動() {
        // 5 小時那條的重置時間在 12:00（已過），每週那條 11-12（還沒到）
        let q = quota_two(Some("2026-11-09T12:00:00Z"), Some("2026-11-12T00:00:00Z"));
        let got = q.without_expired(T0).expect("每週還在");
        assert_eq!(names(&got), ["weekly"]);
        assert_eq!((got.five_hour_pct, got.five_reset_at.clone(), got.five_at.clone()), (None, None, None), "過期那條整條拿掉");
        assert_eq!((got.weekly_pct, got.week_reset_at.clone(), got.week_at.clone()), (q.weekly_pct, q.week_reset_at.clone(), q.week_at.clone()), "另一條不受影響");
        assert_eq!(got.reset_at.as_deref(), Some("2026-11-12T00:00:00Z"), "舊的單一重置時間依剩下的窗重算");
        assert_eq!(got.at, q.at);
        // 兩條都沒過期：整筆不變
        let all_ok = quota_two(Some("2026-11-09T15:00:00Z"), Some("2026-11-12T00:00:00Z"));
        assert_eq!(all_ok.without_expired(T0), Some(all_ok.clone()));
        // 每週那條過期、5 小時還沒：反過來
        let w_gone = quota_two(Some("2026-11-09T15:00:00Z"), Some("2026-11-09T00:00:00Z"));
        let got = w_gone.without_expired(T0).unwrap();
        assert_eq!(names(&got), ["five_hour"]);
        assert_eq!((got.five_hour_pct, got.five_reset_at.clone()), (Some(40), Some("2026-11-09T15:00:00Z".into())));
    }

    #[test]
    fn 重置時間剛好等於現在也算過期_沒有重置時間的窗無從判斷就留著() {
        let q = quota_two(Some("2026-11-09T13:00:00Z"), None);
        let got = q.without_expired(T0).unwrap();
        assert_eq!(names(&got), ["weekly"], "剛好到期＝過期");
        assert!(got.windows()[0]["resets_at"].is_null(), "沒存重置時間就是 null，不編");
        // 本來就沒有任何重置時間：兩條都留著
        let none = quota_two(None, None);
        assert_eq!(names(&none.without_expired(T0).unwrap()), ["five_hour", "weekly"]);
    }

    #[test]
    fn 兩條都過期的帳號不帶額度_其他帳號照常() {
        let old = quota_two(Some("2026-11-09T10:00:00Z"), Some("2026-11-09T11:00:00Z"));
        let fresh = quota_two(Some("2026-11-09T15:00:00Z"), Some("2026-11-12T00:00:00Z"));
        let all: HashMap<String, Quota> = [("old@x.test".to_string(), old), ("fresh@x.test".to_string(), fresh.clone())].into_iter().collect();
        let got = without_expired(&all, T0);
        assert!(!got.contains_key("old@x.test"));
        assert_eq!(got.get("fresh@x.test"), Some(&fresh));
        // 帳號本身仍在回報的清單裡，只是沒有額度欄位
        let v = build_report_with_quota(&[acct("old@x.test", false), acct("fresh@x.test", true)], None, &got);
        assert_eq!(v["accounts"][0], json!({ "vendor": "claude", "email": "old@x.test", "plan": "max", "current": false }));
        assert!(v["accounts"][1]["windows"].as_array().is_some_and(|w| w.len() == 2));
    }

    #[test]
    fn 送出的窗只要本機有存重置時間就一定帶上() {
        // 新格式：兩條各存
        let q = quota_two(Some("2026-11-09T15:00:00Z"), Some("2026-11-12T00:00:00Z"));
        let ws = q.windows();
        assert_eq!(ws[0]["resets_at"], "2026-11-09T15:00:00Z");
        assert_eq!(ws[1]["resets_at"], "2026-11-12T00:00:00Z");
        // 舊格式：只有單一 reset_at，兩條都沒用完時它屬於 5 小時那條
        let legacy = Quota { five_hour_pct: Some(40), weekly_pct: Some(70), reset_at: Some("2026-11-09T15:00:00Z".into()), at: "2026-11-09T12:00:00Z".into(), ..Default::default() };
        let ws = legacy.windows();
        assert_eq!(ws[0]["resets_at"], "2026-11-09T15:00:00Z", "舊檔推得出來的就要帶");
        assert!(ws[1]["resets_at"].is_null(), "推不出來才是 null");
        // 沒有任何重置時間：null，不編
        assert!(quota_two(None, None).windows().iter().all(|w| w["resets_at"].is_null()));
        // 經過 without_expired 之後仍然一樣
        let kept = q.without_expired(T0).unwrap().windows();
        assert!(kept.iter().all(|w| !w["resets_at"].is_null()));
    }

    #[test]
    fn 過期整理後的回報照樣不含_owner() {
        let q = quota_two(Some("2026-11-09T12:00:00Z"), Some("2026-11-12T00:00:00Z"));
        assert!(q.owner, "額度檔內部有標記");
        let all: HashMap<String, Quota> = [("a@x.test".to_string(), q)].into_iter().collect();
        let v = build_report_with_quota(&[acct("a@x.test", true)], None, &without_expired(&all, T0));
        assert!(!v.to_string().contains("owner"), "{v}");
        assert_eq!(v["accounts"][0]["windows"].as_array().map(Vec::len), Some(1));
    }

    #[test]
    fn 回報不含_owner_標記_額度檔的內部欄位不會上傳() {
        let h = tmp_home();
        write_cj(h.path(), "a@x.test");
        let mut q = Quota { five_hour_pct: Some(50), weekly_pct: Some(60), at: "2026-10-24T12:00:00Z".into(), owner: true, ..Default::default() };
        q.reset_at = Some("2026-10-24T14:00:00Z".into());
        let qs: HashMap<String, Quota> = [("a@x.test".to_string(), q)].into_iter().collect();
        let v = build_report_with_quota(&[acct("a@x.test", true)], None, &qs);
        assert!(!v.to_string().contains("owner"), "{v}");
    }

    #[test]
    fn 回報只對有紀錄的_claude_帳號帶額度四欄_其餘維持原樣() {
        let h = tmp_home();
        assert!(feed(&h, "a@x.test", UA, "w1", NOW, 1, status(38.0, 1_792_850_400, 20.0, 1_793_000_000), NOW));
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
        // 畫面提示用目前登入的帳號（只看 .claude.json 的 email 欄位）
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

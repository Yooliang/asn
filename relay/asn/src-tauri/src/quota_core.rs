//! 額度共用：時間格式、額度紀錄的型別與驗證、新舊合併（見 `merge`）。
//! Gemini、Codex 的本機額度與各處 log 的時間字串都用這裡的東西；Claude 的額度另走 `claude_quota`（直接向 Claude 查）。
use serde::Serialize;
use serde_json::Value;

pub(crate) mod merge;

/// 一個帳號的額度紀錄。百分比是「剩餘」；`at` 是記錄時間（UTC，秒）。
/// `reset_at` 是舊欄位（兩條共用一個，屬於哪條見 `pick_reset`）。
/// `five_reset_at`／`week_reset_at` 是兩條各自的重置時間，`five_at`／`week_at` 是兩條各自最後收進新值的時間（讀取時間）。全部選填。
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
}

/// 一次讀到的額度（還沒有記錄時間）。`five_reset_ms`／`week_reset_ms` 是兩條各自的重置時間，
/// 用來判斷新舊（見 merge.rs），也寫進檔案的 `five_reset_at`／`week_reset_at`。
#[derive(Debug, PartialEq, Clone)]
pub struct Parsed {
    pub five_hour_pct: Option<u8>,
    pub weekly_pct: Option<u8>,
    pub reset_at: Option<String>,
    pub five_reset_ms: Option<i64>,
    pub week_reset_ms: Option<i64>,
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
    })
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
        })
    }
}


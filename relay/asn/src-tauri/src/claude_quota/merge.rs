//! 額度紀錄的合併（#1338／#1342，#1266 簡化）：狀態列送來的新額度，5 小時與每週兩條各自判斷要不要收，逐欄合併，不整筆覆寫。
//!
//! 前提：每筆新數字都帶「資料時間」`read_ms`（Claude 是對話紀錄裡最後一筆 assistant 回應的時間戳，Gemini 是讀取當下），
//! 而且記到哪個帳號底下是靠視窗自己的帳號身分決定的（見 owner.rs），不再需要靠數字猜是不是別的帳號。所以只剩三條規則：
//! - `future_read`：資料時間比現在晚超過 5 分鐘（電腦時鐘走快）＝不收。
//! - `older_read`：資料時間比記著的那條更早＝舊視窗重送的舊數字，不收（同一個帳號開多個視窗時，閒置的視窗會一直重送舊數字）。
//! - `reset_out_of_range`：新的重置時間不在「現在 −1 天」到「現在 +8 天」之間＝不收（不然一個 2099 年的重置時間存進來會鎖死）。
//! 其餘一律照收：同一期剩餘回升（滾動窗、四捨五入）、重置時間往前或往後、不是 7 天的倍數，都是合法的新數字。
//! 兩條各自的重置時間（#374）：新版檔案每條存自己的 `five_reset_at`／`week_reset_at`，舊版寫的檔只有一個 `reset_at`，才照 `pick_reset` 的規則推回它屬於哪一條。
//! 各條另記自己的資料時間 `five_at`／`week_at`（那條這次有收才更新成這次的資料時間；沒收就留原本的，舊檔沒有就用整筆的 `at`）；
//! 記錄時間 `at`：只有真的收進新值時才更新成現在；兩條都不收就整筆不動。
//! 判斷規則與後台共用一份案例（tests/fixtures/quota-merge-cases.json），不收的原因用同一組代碼（`Reject::code`）。
use super::{iso_secs, parse_iso_secs, pick_reset, Parsed, Quota};
use std::path::Path;

/// 新來的重置時間最早可以是現在往前這麼久
const RESET_PAST_MS: i64 = 86_400_000;
/// 重置時間最晚可以是現在往後這麼久（每週那條最多 7 天後，多留 1 天）
const RESET_FUTURE_MS: i64 = 8 * 86_400_000;
/// 資料時間最晚可以比現在晚這麼久（容忍小幅時鐘誤差）
const FUTURE_READ_MS: i64 = 5 * 60_000;
const LOG_FILE: &str = "claude-quota.log";
const LOG_MAX_BYTES: u64 = 64 * 1024;

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Kind {
    Five,
    Week,
}

impl Kind {
    fn label(self) -> &'static str {
        match self {
            Kind::Five => "5 小時額度",
            Kind::Week => "每週額度",
        }
    }
}

/// 一條沒收的原因（給 log 看，不含 email）
#[derive(Debug, PartialEq, Clone)]
pub struct Skipped {
    pub kind: Kind,
    /// 不收的原因代碼（`Reject::code`）：log 同一個代碼連續發生只記一次（#1184）
    pub code: &'static str,
    pub reason: String,
}

/// 不收的原因：`code` 跟後台與共用案例的代碼一致（older_read／future_read／reset_out_of_range），
/// `detail` 是給 log 看的中文說明（不含 email）
#[derive(Debug, PartialEq, Clone)]
pub struct Reject {
    pub code: &'static str,
    pub detail: String,
}
fn reject(code: &'static str, detail: String) -> Result<(), Reject> {
    Err(Reject { code, detail })
}

/// 現有紀錄裡兩條各自的重置時間：(5 小時的, 每週的)。新版檔案那條有存就直接用；
/// 那條沒存（舊版寫的檔）才從舊的單一 `reset_at` 推回來。
pub(super) fn stored_resets(q: &Quota) -> (Option<i64>, Option<i64>) {
    let (f, w) = legacy_resets(q);
    let own = |s: &Option<String>, legacy: Option<i64>| match s {
        Some(t) => parse_iso_secs(t),
        None => legacy,
    };
    (own(&q.five_reset_at, f), own(&q.week_reset_at, w))
}

/// 舊版檔案的那一個重置時間屬於哪一條：(5 小時的, 每週的)
fn legacy_resets(q: &Quota) -> (Option<i64>, Option<i64>) {
    let r = q.reset_at.as_deref().and_then(parse_iso_secs);
    match (q.five_hour_pct, q.weekly_pct) {
        (Some(0), Some(0)) => (None, None),
        (_, Some(0)) => (None, r),
        (Some(_), _) => (r, None),
        (None, Some(_)) => (None, r),
        (None, None) => (None, None),
    }
}

/// 一條要不要收：收回 Ok(())，不收回原因。`old_read_ms`＝記著的那條的資料時間（沒有記過就是 None），`new_read_ms`＝這次的資料時間。
/// 順序：future_read → older_read → reset_out_of_range（跟後台 asn_relay_acct_window_decide 一樣）。
/// 資料時間以秒為單位比較（記著的存成整秒），同一秒算一樣，照收。
pub fn judge(old_read_ms: Option<i64>, new_read_ms: i64, new_reset: Option<i64>, now_ms: i64) -> Result<(), Reject> {
    if new_read_ms > now_ms + FUTURE_READ_MS {
        return reject("future_read", format!("資料時間 {} 比現在晚超過 5 分鐘，不收", iso_secs(new_read_ms)));
    }
    if let Some(old) = old_read_ms {
        if new_read_ms.div_euclid(1000) < old.div_euclid(1000) {
            return reject("older_read", format!("資料時間 {} 比記著的 {} 早，是舊視窗的舊數字", iso_secs(new_read_ms), iso_secs(old)));
        }
    }
    if let Some(r) = new_reset {
        if r < now_ms - RESET_PAST_MS || r > now_ms + RESET_FUTURE_MS {
            return reject("reset_out_of_range", format!("重置時間 {} 不在現在前 1 天到後 8 天之間，不收", iso_secs(r)));
        }
    }
    Ok(())
}

/// 合併一條：新來的沒有這條就留舊的；有就判斷。回 (合併後的這條, 有沒有收進新值, 沒收的原因)
fn merge_one(kind: Kind, old: Option<(u8, Option<i64>)>, old_read_ms: Option<i64>, new: Option<(u8, Option<i64>)>, new_read_ms: i64, now_ms: i64) -> (Option<(u8, Option<i64>)>, bool, Option<Skipped>) {
    let Some((pct, reset)) = new else { return (old, false, None) };
    match judge(old.and(old_read_ms), new_read_ms, reset, now_ms) {
        Ok(()) => (Some((pct, reset)), true, None),
        Err(r) => (old, false, Some(Skipped { kind, code: r.code, reason: r.detail })),
    }
}

/// 一條的資料時間：這次收了是這次的資料時間；沒收就留原本的（舊檔沒有各條的就用整筆的 at）；這條沒數字就沒有
fn read_at(took: bool, has: bool, own: Option<&String>, old_at: Option<&String>, read: &str) -> Option<String> {
    if took {
        Some(read.to_string())
    } else if has {
        own.or(old_at).cloned()
    } else {
        None
    }
}

/// 現有紀錄（可能沒有）＋新來的額度 → (要寫入的紀錄, 沒收的原因)。資料時間用現在（沒有更精確的時間時，例如 Gemini）。
#[cfg_attr(not(test), allow(dead_code))]
pub fn merge(old: Option<&Quota>, p: &Parsed, now_ms: i64) -> (Option<Quota>, Vec<Skipped>) {
    let m = merge_full(old, p, now_ms, now_ms);
    (m.quota, m.skipped)
}

/// 一次合併的完整結果：除了紀錄與沒收的原因，還有各條有沒有收
pub struct Merged {
    pub quota: Option<Quota>,
    pub skipped: Vec<Skipped>,
    pub took_five: bool,
    pub took_week: bool,
}

/// 同 [`merge`]，另帶這次的資料時間 `read_ms`（Claude：對話紀錄裡最後一筆 assistant 回應的時間；兩條都用它）
pub fn merge_full(old: Option<&Quota>, p: &Parsed, read_ms: i64, now_ms: i64) -> Merged {
    let (old_five_r, old_week_r) = old.map(stored_resets).unwrap_or((None, None));
    let old_five = old.and_then(|q| q.five_hour_pct).map(|v| (v, old_five_r));
    let old_week = old.and_then(|q| q.weekly_pct).map(|v| (v, old_week_r));
    let read_of = |own: Option<&String>| own.or(old.map(|q| &q.at)).and_then(|t| parse_iso_secs(t));
    let (old_five_read, old_week_read) = (read_of(old.and_then(|q| q.five_at.as_ref())), read_of(old.and_then(|q| q.week_at.as_ref())));
    let (five, took_five, s1) = merge_one(Kind::Five, old_five, old_five_read, p.five_hour_pct.map(|v| (v, p.five_reset_ms)), read_ms, now_ms);
    let (week, took_week, s2) = merge_one(Kind::Week, old_week, old_week_read, p.weekly_pct.map(|v| (v, p.week_reset_ms)), read_ms, now_ms);
    let skipped: Vec<Skipped> = [s1, s2].into_iter().flatten().collect();
    if !took_five && !took_week {
        return Merged { quota: None, skipped, took_five, took_week };
    }
    let (now, read) = (iso_secs(now_ms), iso_secs(read_ms));
    let old_at = old.map(|q| &q.at);
    let q = Quota {
        five_hour_pct: five.map(|f| f.0),
        weekly_pct: week.map(|w| w.0),
        reset_at: pick_reset(five, week).map(iso_secs),
        five_reset_at: five.and_then(|f| f.1).map(iso_secs),
        week_reset_at: week.and_then(|w| w.1).map(iso_secs),
        five_at: read_at(took_five, five.is_some(), old.and_then(|q| q.five_at.as_ref()), old_at, &read),
        week_at: read_at(took_week, week.is_some(), old.and_then(|q| q.week_at.as_ref()), old_at, &read),
        at: now,
        owner: false,
    };
    Merged { quota: Some(q), skipped, took_five, took_week }
}

pub fn log_path(home: &Path) -> std::path::PathBuf {
    home.join(".asn").join(LOG_FILE)
}

/// 沒收的寫進 `~/.asn/claude-quota.log`（不含 email；超過 64 KB 只留後半）。寫不進去不影響記額度。
/// 不印到標準錯誤：這支掛在狀態列上，不能弄髒狀態列。
pub fn log_skipped(home: &Path, skipped: &[Skipped], now_ms: i64) {
    if skipped.is_empty() {
        return;
    }
    append_log(&log_path(home), &skipped_lines(skipped, now_ms));
}

/// 沒收的原因 → log 文字（一條一行，不含 email）
pub fn skipped_lines(skipped: &[Skipped], now_ms: i64) -> String {
    let at = iso_secs(now_ms);
    skipped.iter().map(|s| format!("{at} {}沒收：{}\n", s.kind.label(), s.reason)).collect()
}

/// 附加到 log 檔（超過 64 KB 只留後半）。寫不進去就算了：呼叫端掛在狀態列上，不能因此失敗，也不印到標準錯誤。
pub fn append_log(p: &Path, text: &str) {
    use std::io::Write;
    if text.is_empty() {
        return;
    }
    if let Some(dir) = p.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    if std::fs::metadata(p).map(|m| m.len() > LOG_MAX_BYTES).unwrap_or(false) {
        if let Ok(t) = std::fs::read_to_string(p) {
            let mid = t.len() / 2;
            let keep = t.as_bytes()[mid..].iter().position(|&b| b == b'\n').map(|i| &t[mid + i + 1..]).unwrap_or("");
            let _ = std::fs::write(p, keep);
        }
    }
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(p) {
        let _ = f.write_all(text.as_bytes());
    }
}

#[cfg(test)]
mod tests;

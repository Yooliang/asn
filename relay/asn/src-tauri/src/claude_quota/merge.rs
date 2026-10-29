//! 額度紀錄的合併（#1338／#1342）：狀態列送來的新額度，5 小時與每週兩條各自判斷要不要收，逐欄合併，不整筆覆寫。
//!
//! 為什麼要判斷：同一台電腦可能開著好幾個 Claude 視窗，有的還停在舊視窗（甚至是換帳號前的另一個帳號）的數字，
//! 而掛鉤只能用當下 `.claude.json` 的帳號歸帳號（狀態列資料沒有帳號欄位）。所以每一條用重置時間判斷：
//! - 重置時間一樣（相差 10 分鐘內）＝同一期：剩餘只能下降，回升的不收。
//! - 比記著的早＝舊視窗的舊數字，不收。
//! - 比記著的晚：記著的那個重置時間已經過了，才當新的一期收下；還沒過就來了更晚的，一定是別的帳號，不收。
//!   每週那條再加一道：新舊重置時間要差接近 7 天的倍數（誤差 10 分鐘內），不是就當別的帳號。
//!   5 小時那條不能用倍數判斷：5 小時的期從那期第一則訊息起算，不是固定格子。
//! - 記著的重置時間已經過了超過 7 天：新來的照收，不做上面的判斷（避免廠商改了重置時間後永遠收不進新數字）。兩條都適用。
//! - 任一邊沒有重置時間、或記著的那條本來就沒有數字：分不出新舊，照舊收下（跟以前一樣）。
//!
//! 兩條各自的重置時間（#374）：新版檔案每條存自己的 `five_reset_at`／`week_reset_at`，判斷時用它；
//! 舊版寫的檔只有一個 `reset_at`，才照 `pick_reset` 的規則推回它屬於哪一條；推不出來（兩條都用完時存的是較晚的那個，
//! 分不出是哪條的）就當那條沒有重置時間。舊的 `reset_at` 照舊寫（舊版 ASN 讀檔只認它）。
//! 記錄時間 `at`：只有真的收進新值時才更新成現在；兩條都不收就整筆不動。各條另記自己的讀取時間 `five_at`／`week_at`
//! （那條這次有收才更新成現在；沒收就留原本的，舊檔沒有就用整筆的 `at`）。
//! 判斷規則與後台共用一份案例（tests/fixtures/quota-merge-cases.json），不收的原因用同一組代碼（`Reject::code`）。
use super::{iso_secs, parse_iso_secs, pick_reset, Parsed, Quota};
use std::path::Path;

/// 重置時間相差這麼多以內算同一個時間
const SAME_MS: i64 = 10 * 60_000;
const WEEK_MS: i64 = 7 * 86_400_000;
const LOG_FILE: &str = "claude-quota.log";
const LOG_MAX_BYTES: u64 = 64 * 1024;

/// 哪個廠牌的額度：Claude 的每週那條要看 7 天倍數，Codex 不看（#1372）
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Vendor {
    Claude,
    #[cfg_attr(not(test), allow(dead_code))]
    Codex,
}

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
    pub reason: String,
}

/// 不收的原因：`code` 跟後台與共用案例的代碼一致（same_period_rise／earlier／later_not_expired／not_week_multiple），
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

fn near_week_multiple(diff_ms: i64) -> bool {
    let k = (diff_ms + WEEK_MS / 2).div_euclid(WEEK_MS);
    k >= 1 && (diff_ms - k * WEEK_MS).abs() <= SAME_MS
}

/// 一條要不要收（Claude 的規則）：收回 Ok(())，不收回原因
pub fn judge(kind: Kind, old: Option<(u8, Option<i64>)>, new_pct: u8, new_reset: Option<i64>, now_ms: i64) -> Result<(), Reject> {
    judge_for(Vendor::Claude, kind, old, new_pct, new_reset, now_ms)
}

/// 一條要不要收：收回 Ok(())，不收回原因。規則見檔頭；只有 Claude 的每週那條看 7 天倍數。
pub fn judge_for(vendor: Vendor, kind: Kind, old: Option<(u8, Option<i64>)>, new_pct: u8, new_reset: Option<i64>, now_ms: i64) -> Result<(), Reject> {
    let Some((old_pct, Some(old_reset))) = old else { return Ok(()) };
    let Some(new_reset) = new_reset else { return Ok(()) };
    if now_ms > old_reset + WEEK_MS {
        return Ok(()); // 記著的重置時間已過了超過 7 天：照收，免得廠商改了重置時間後永遠收不進新數字
    }
    let diff = new_reset - old_reset;
    if diff.abs() <= SAME_MS {
        return if new_pct <= old_pct { Ok(()) } else { reject("same_period_rise", format!("同一期剩餘回升（{old_pct}% → {new_pct}%），留著較低的")) };
    }
    if diff < 0 {
        return reject("earlier", format!("重置時間 {} 比記著的 {} 早，是舊視窗的數字", iso_secs(new_reset), iso_secs(old_reset)));
    }
    if old_reset > now_ms {
        return reject("later_not_expired", format!("記著的這期 {} 還沒重置，卻來了更晚的 {}，當成別的帳號", iso_secs(old_reset), iso_secs(new_reset)));
    }
    if vendor == Vendor::Claude && kind == Kind::Week && !near_week_multiple(diff) {
        return reject("not_week_multiple", format!("新舊重置時間 {} 與 {} 相差不是 7 天的倍數，當成別的帳號", iso_secs(old_reset), iso_secs(new_reset)));
    }
    Ok(())
}

/// 合併一條：新來的沒有這條就留舊的；有就判斷。回 (合併後的這條, 有沒有收進新值, 沒收的原因)
fn merge_one(kind: Kind, old: Option<(u8, Option<i64>)>, new: Option<(u8, Option<i64>)>, now_ms: i64) -> (Option<(u8, Option<i64>)>, bool, Option<Skipped>) {
    let Some((pct, reset)) = new else { return (old, false, None) };
    match judge(kind, old, pct, reset, now_ms) {
        Ok(()) => (Some((pct, reset)), true, None),
        Err(r) => (old, false, Some(Skipped { kind, reason: r.detail })),
    }
}

/// 一條的讀取時間：這次收了是現在；沒收就留原本的（舊檔沒有各條的就用整筆的 at）；這條沒數字就沒有
fn read_at(took: bool, has: bool, own: Option<&String>, old_at: Option<&String>, now: &str) -> Option<String> {
    if took {
        Some(now.to_string())
    } else if has {
        own.or(old_at).cloned()
    } else {
        None
    }
}

/// 現有紀錄（可能沒有）＋新來的額度 → (要寫入的紀錄, 沒收的原因)。兩條都沒收時紀錄是 None（不動檔案）。
pub fn merge(old: Option<&Quota>, p: &Parsed, now_ms: i64) -> (Option<Quota>, Vec<Skipped>) {
    let (old_five_r, old_week_r) = old.map(stored_resets).unwrap_or((None, None));
    let old_five = old.and_then(|q| q.five_hour_pct).map(|v| (v, old_five_r));
    let old_week = old.and_then(|q| q.weekly_pct).map(|v| (v, old_week_r));
    let (five, took_five, s1) = merge_one(Kind::Five, old_five, p.five_hour_pct.map(|v| (v, p.five_reset_ms)), now_ms);
    let (week, took_week, s2) = merge_one(Kind::Week, old_week, p.weekly_pct.map(|v| (v, p.week_reset_ms)), now_ms);
    let skipped: Vec<Skipped> = [s1, s2].into_iter().flatten().collect();
    if !took_five && !took_week {
        return (None, skipped);
    }
    let now = iso_secs(now_ms);
    let old_at = old.map(|q| &q.at);
    let q = Quota {
        five_hour_pct: five.map(|f| f.0),
        weekly_pct: week.map(|w| w.0),
        reset_at: pick_reset(five, week).map(iso_secs),
        five_reset_at: five.and_then(|f| f.1).map(iso_secs),
        week_reset_at: week.and_then(|w| w.1).map(iso_secs),
        five_at: read_at(took_five, five.is_some(), old.and_then(|q| q.five_at.as_ref()), old_at, &now),
        week_at: read_at(took_week, week.is_some(), old.and_then(|q| q.week_at.as_ref()), old_at, &now),
        at: now,
    };
    (Some(q), skipped)
}

pub fn log_path(home: &Path) -> std::path::PathBuf {
    home.join(".asn").join(LOG_FILE)
}

/// 沒收的寫進 `~/.asn/claude-quota.log`（不含 email；超過 64 KB 只留後半）。寫不進去不影響記額度。
/// 不印到標準錯誤：這支掛在狀態列上，不能弄髒狀態列。
pub fn log_skipped(home: &Path, skipped: &[Skipped], now_ms: i64) {
    use std::io::Write;
    if skipped.is_empty() {
        return;
    }
    let p = log_path(home);
    if let Some(dir) = p.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    if std::fs::metadata(&p).map(|m| m.len() > LOG_MAX_BYTES).unwrap_or(false) {
        if let Ok(t) = std::fs::read_to_string(&p) {
            let mid = t.len() / 2;
            let keep = t.as_bytes()[mid..].iter().position(|&b| b == b'\n').map(|i| &t[mid + i + 1..]).unwrap_or("");
            let _ = std::fs::write(&p, keep);
        }
    }
    let at = iso_secs(now_ms);
    let text: String = skipped.iter().map(|s| format!("{at} {}沒收：{}\n", s.kind.label(), s.reason)).collect();
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&p) {
        let _ = f.write_all(text.as_bytes());
    }
}

#[cfg(test)]
mod tests;

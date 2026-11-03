//! 每視窗每小時寄信上限的計數（~/.asn/send-rate.json）。
//! 寄信（asn send）與收信端（橋轉交、視窗自己 recv）都會寫這個檔，所以讀改寫一律先拿鎖檔、寫入用暫存檔＋rename，避免寫壞。
//! 本人（小良哥）簽章的私信寄到某視窗時，退回那個視窗一封額度（`refund`）：一來一回不累積，沒人在場時夥伴失控連發照樣被擋。
use serde_json::{json, Map, Value};
use std::path::{Path, PathBuf};

const HOUR: u64 = 3_600_000;
const FILE: &str = "send-rate.json";
/// 已經退過額度的信（一封信只退一次；橋重送、重啟後重看到同一封都不會再退）
const REFUNDED: &str = "send-refunded.json";
const LOCK: &str = "send-rate.lock";
const KEEP_IDS: usize = 200;
/// 鎖檔超過這麼久還在，當作前一個程序掛掉遺留
const LOCK_STALE_MS: u128 = 10_000;
/// 剩這麼多封（含）以下，寄信後提醒
pub const WARN_LEFT: usize = 5;

struct Lock(PathBuf);
impl Drop for Lock {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

/// 拿鎖（最多等約 2 秒）；拿不到回 None，由呼叫端決定要不要照樣做
fn lock(home: &Path) -> Option<Lock> {
    let _ = std::fs::create_dir_all(home);
    let p = home.join(LOCK);
    for _ in 0..50 {
        match std::fs::OpenOptions::new().write(true).create_new(true).open(&p) {
            Ok(_) => return Some(Lock(p)),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                let stale = std::fs::metadata(&p).and_then(|m| m.modified()).ok().and_then(|t| t.elapsed().ok()).map(|d| d.as_millis() > LOCK_STALE_MS).unwrap_or(false);
                if stale {
                    let _ = std::fs::remove_file(&p);
                } else {
                    std::thread::sleep(std::time::Duration::from_millis(40));
                }
            }
            Err(_) => return None,
        }
    }
    None
}

fn write_atomic(file: &Path, text: &str) {
    let tmp = PathBuf::from(format!("{}.{}.tmp", file.display(), std::process::id()));
    if std::fs::write(&tmp, text).is_ok() {
        let _ = std::fs::rename(&tmp, file);
    }
}

/// 讀計數檔，只留一小時內的時間點
fn load(home: &Path, now: u64) -> Map<String, Value> {
    let all: Map<String, Value> = std::fs::read_to_string(home.join(FILE)).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default();
    let mut cleaned = Map::new();
    for (k, v) in all.iter() {
        let kept: Vec<Value> = v.as_array().map(|a| a.iter().filter(|t| t.as_u64().map(|t| now.saturating_sub(t) < HOUR).unwrap_or(false)).cloned().collect()).unwrap_or_default();
        if !kept.is_empty() {
            cleaned.insert(k.clone(), Value::Array(kept));
        }
    }
    cleaned
}

fn recent_of(all: &Map<String, Value>, window: &str) -> Vec<u64> {
    all.get(window).and_then(Value::as_array).map(|a| a.iter().filter_map(Value::as_u64).collect()).unwrap_or_default()
}

/// 寄一封前先計次。成功回「寄完還剩幾封」；已滿回 Err(幾分鐘後可再寄)
pub fn take(home: &Path, window: &str, limit: usize, now: u64) -> Result<usize, u64> {
    let _lock = lock(home); // 拿不到就照樣算：寧可多算一次，也不因為鎖卡住寄不出信
    let mut all = load(home, now);
    let recent = recent_of(&all, window);
    if recent.len() >= limit {
        return Err((recent[0] + HOUR - now).div_ceil(60_000));
    }
    let mut next = recent;
    next.push(now);
    let left = limit.saturating_sub(next.len());
    all.insert(window.to_string(), json!(next));
    let _ = std::fs::create_dir_all(home);
    write_atomic(&home.join(FILE), &serde_json::to_string(&all).unwrap_or_default());
    Ok(left)
}

/// 本人簽章的私信寄到 `window`：退回一封額度（刪掉最舊的一筆）。
/// 一封信只退一次（`mail_id`）；窗口這一小時沒有任何紀錄就沒有東西可退——額度只會回到上限，不會存成「欠額」。
/// 拿不到鎖就不退（少退一封比寫壞計數檔好）。回傳這次有沒有真的退。
pub fn refund(home: &Path, window: &str, mail_id: &str, now: u64) -> bool {
    let Some(_lock) = lock(home) else { return false };
    let ids_file = home.join(REFUNDED);
    let mut ids: Vec<String> = std::fs::read_to_string(&ids_file).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default();
    if ids.iter().any(|i| i == mail_id) {
        return false;
    }
    ids.push(mail_id.to_string());
    if ids.len() > KEEP_IDS {
        ids.drain(..ids.len() - KEEP_IDS);
    }
    write_atomic(&ids_file, &serde_json::to_string(&ids).unwrap_or_default());
    let mut all = load(home, now);
    let mut recent = recent_of(&all, window);
    if recent.is_empty() {
        return false;
    }
    recent.remove(0);
    if recent.is_empty() {
        all.remove(window);
    } else {
        all.insert(window.to_string(), json!(recent));
    }
    write_atomic(&home.join(FILE), &serde_json::to_string(&all).unwrap_or_default());
    true
}

/// 寄完後的提醒（剩很少才有字）
pub fn warn_text(window: &str, left: usize, limit: usize) -> Option<String> {
    (left <= WARN_LEFT.min(limit)).then(|| format!("提醒：視窗「{window}」這一小時還能寄 {left} 封（上限 {limit} 封），用完要等一下才能再寄；小良哥直接傳訊息給它會退回額度"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn home() -> tempfile::TempDir {
        tempfile::tempdir().unwrap()
    }
    fn count(h: &Path, w: &str, now: u64) -> usize {
        recent_of(&load(h, now), w).len()
    }

    #[test]
    fn 計次到上限才擋_剩餘數照實回報() {
        let d = home();
        assert_eq!(take(d.path(), "甲", 3, 1000), Ok(2));
        assert_eq!(take(d.path(), "甲", 3, 2000), Ok(1));
        assert_eq!(take(d.path(), "甲", 3, 3000), Ok(0));
        assert!(take(d.path(), "甲", 3, 4000).is_err());
        assert_eq!(take(d.path(), "乙", 3, 4000), Ok(2), "別的視窗各算各的");
    }

    #[test]
    fn 退回一封_刪掉最舊的一筆_一封信只退一次() {
        let d = home();
        for t in [1000, 2000, 3000] {
            take(d.path(), "甲", 3, t).unwrap();
        }
        assert!(take(d.path(), "甲", 3, 4000).is_err());
        assert!(refund(d.path(), "甲", "mail-1", 5000));
        assert_eq!(count(d.path(), "甲", 5000), 2);
        assert!(!refund(d.path(), "甲", "mail-1", 5000), "同一封信不會再退");
        assert_eq!(count(d.path(), "甲", 5000), 2);
        assert_eq!(take(d.path(), "甲", 3, 6000), Ok(0), "退回的那一封又能寄");
    }

    #[test]
    fn 沒有紀錄就沒有東西可退_額度不超過上限也不存欠額() {
        let d = home();
        assert!(!refund(d.path(), "甲", "m1", 1000));
        assert!(!refund(d.path(), "甲", "m2", 1000));
        assert_eq!(take(d.path(), "甲", 3, 2000), Ok(2), "之前退過兩次也不會多出額度");
        assert_eq!(take(d.path(), "甲", 3, 3000), Ok(1));
        assert_eq!(take(d.path(), "甲", 3, 4000), Ok(0));
        assert!(take(d.path(), "甲", 3, 5000).is_err());
    }

    #[test]
    fn 只退自己那個視窗_一小時前的紀錄不算() {
        let d = home();
        take(d.path(), "甲", 3, 1000).unwrap();
        take(d.path(), "乙", 3, 1000).unwrap();
        assert!(refund(d.path(), "甲", "m1", 2000));
        assert_eq!(count(d.path(), "甲", 2000), 0);
        assert_eq!(count(d.path(), "乙", 2000), 1);
        take(d.path(), "丙", 3, 1000).unwrap();
        assert!(!refund(d.path(), "丙", "m2", 1000 + HOUR + 1), "過了一小時已經不在計數裡");
    }

    #[test]
    fn 兩邊同時寫不會寫壞_鎖留下的舊檔會被清掉() {
        let d = home();
        let h = d.path().to_path_buf();
        let hs: Vec<_> = (0..8)
            .map(|i| {
                let h = h.clone();
                std::thread::spawn(move || {
                    for j in 0..5u64 {
                        take(&h, "甲", 1000, 1000 + i * 10 + j).unwrap();
                    }
                })
            })
            .collect();
        for t in hs {
            t.join().unwrap();
        }
        assert_eq!(count(&h, "甲", 2000), 40, "每次都讀到上一次的結果，沒有互相蓋掉");
        std::fs::write(h.join(LOCK), "").unwrap();
        let old = std::time::SystemTime::now() - std::time::Duration::from_secs(60);
        std::fs::File::options().write(true).open(h.join(LOCK)).unwrap().set_modified(old).unwrap();
        assert_eq!(take(&h, "乙", 3, 3000), Ok(2), "超過 10 秒的鎖檔當作遺留，不卡住");
    }

    #[test]
    fn 提醒只在快用完時才出現() {
        assert!(warn_text("甲", 6, 30).is_none());
        assert!(warn_text("甲", 5, 30).unwrap().contains("還能寄 5 封"));
        assert!(warn_text("甲", 0, 30).is_some());
        assert!(warn_text("甲", 2, 2).is_some(), "上限本來就很小時一開始就提醒");
    }
}

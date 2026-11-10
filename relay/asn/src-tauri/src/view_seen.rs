//! 被看的那台（T）記住用過的觀看編號（#597 別台看畫面）。同一筆請求只能接受一次。
//!
//! - 驗章前先查：看過就拒。驗章通過、回覆接受之前先記下並存檔，**存不進去就拒絕**。
//! - 記到這次觀看到期（再留一點時鐘誤差）就清掉。存在資料夾裡，重開 ASN 也擋得住。
//! - 最多記 [`MAX_SEEN`] 筆未到期的：滿了就拒絕新的，**不淘汰還沒到期的舊紀錄**（失敗就關）。
//! - 檔案壞了回錯誤，不當成空的：當成空的就等於全部忘掉。
#![cfg_attr(not(test), allow(dead_code))]
use serde::{Deserialize, Serialize};
use std::path::Path;

const SEEN_FILE: &str = "view_seen.json";
pub const MAX_SEEN: usize = 64;
/// 到期後再留多久（秒），和握手允許的時鐘誤差相同
pub const KEEP_AFTER_EXPIRY_S: i64 = 60;
pub const ALREADY_SEEN: &str = "這筆觀看請求已經用過了";
pub const TOO_MANY: &str = "同時要求觀看的次數太多了";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Seen {
    pub id: String,
    /// 這次觀看的到期時間（秒）
    pub expires_s: i64,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct SeenIds {
    #[serde(default)]
    pub seen: Vec<Seen>,
}

impl SeenIds {
    pub fn load(dir: &Path) -> Result<Self, String> {
        Self::load_file(dir, SEEN_FILE)
    }

    /// 指定檔名（#933 手機替這台登入用另一個檔，和看畫面的分開）
    pub fn load_file(dir: &Path, file: &str) -> Result<Self, String> {
        match std::fs::read_to_string(dir.join(file)) {
            Ok(t) => serde_json::from_str(&t).map_err(|_| "觀看紀錄壞了".to_string()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(SeenIds::default()),
            Err(e) => Err(format!("讀觀看紀錄失敗：{e}")),
        }
    }

    pub fn save(&self, dir: &Path) -> Result<(), String> {
        self.save_file(dir, SEEN_FILE)
    }

    pub fn save_file(&self, dir: &Path, file: &str) -> Result<(), String> {
        let text = serde_json::to_string(self).map_err(|e| e.to_string())?;
        crate::write_atomic(&dir.join(file), &text).map_err(|e| format!("存觀看紀錄失敗：{e}"))
    }

    /// 去掉已經到期（加上誤差）的，回新的一份
    pub fn pruned(&self, now_s: i64) -> SeenIds {
        SeenIds { seen: self.seen.iter().filter(|s| s.expires_s + KEEP_AFTER_EXPIRY_S > now_s).cloned().collect() }
    }

    pub fn contains(&self, id: &str) -> bool {
        self.seen.iter().any(|s| s.id == id)
    }

    /// 記下一筆，回新的一份。看過或滿了就是錯誤
    pub fn with(&self, id: &str, expires_s: i64, now_s: i64) -> Result<SeenIds, String> {
        let next = self.pruned(now_s);
        if next.contains(id) {
            return Err(ALREADY_SEEN.to_string());
        }
        if next.seen.len() >= MAX_SEEN {
            return Err(TOO_MANY.to_string());
        }
        let mut seen = next.seen;
        seen.push(Seen { id: id.to_string(), expires_s });
        Ok(SeenIds { seen })
    }
}

/// 驗章前：這筆看過沒有。讀不到紀錄也當看過（不能確定就不接受）
pub fn check_unseen(dir: &Path, id: &str, now_s: i64) -> Result<(), String> {
    check_unseen_in(dir, SEEN_FILE, id, now_s)
}

/// 同上，指定檔名
pub fn check_unseen_in(dir: &Path, file: &str, id: &str, now_s: i64) -> Result<(), String> {
    if SeenIds::load_file(dir, file)?.pruned(now_s).contains(id) {
        return Err(ALREADY_SEEN.to_string());
    }
    Ok(())
}

/// 驗章通過、回覆接受之前：記下並存檔。任何一步失敗都回錯誤，呼叫端要拒絕這筆
pub fn record(dir: &Path, id: &str, expires_s: i64, now_s: i64) -> Result<(), String> {
    record_in(dir, SEEN_FILE, id, expires_s, now_s)
}

/// 同上，指定檔名
pub fn record_in(dir: &Path, file: &str, id: &str, expires_s: i64, now_s: i64) -> Result<(), String> {
    // 讀、改、存在同一把鎖裡：兩筆同時進來不會互蓋、丟掉一筆
    static LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
    let _g = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    SeenIds::load_file(dir, file)?.with(id, expires_s, now_s)?.save_file(dir, file)
}

#[cfg(test)]
mod tests {
    use super::*;
    const NOW: i64 = 1_800_000_000;

    #[test]
    fn 同一筆只能接受一次_重開_asn_也擋得住() {
        let d = tempfile::tempdir().unwrap();
        check_unseen(d.path(), "s1", NOW).unwrap();
        record(d.path(), "s1", NOW + 600, NOW).unwrap();
        // 重開 ASN：重新從檔案讀
        assert_eq!(check_unseen(d.path(), "s1", NOW + 5).unwrap_err(), ALREADY_SEEN);
        assert_eq!(record(d.path(), "s1", NOW + 600, NOW + 5).unwrap_err(), ALREADY_SEEN);
        check_unseen(d.path(), "s2", NOW + 5).unwrap();
    }

    #[test]
    fn 到期加誤差之後才清掉() {
        let d = tempfile::tempdir().unwrap();
        record(d.path(), "s1", NOW + 600, NOW).unwrap();
        assert!(check_unseen(d.path(), "s1", NOW + 600 + KEEP_AFTER_EXPIRY_S - 1).is_err(), "誤差內還記得");
        check_unseen(d.path(), "s1", NOW + 600 + KEEP_AFTER_EXPIRY_S).unwrap();
        record(d.path(), "s2", NOW + 2000, NOW + 1000).unwrap();
        assert_eq!(SeenIds::load(d.path()).unwrap().seen.iter().map(|s| s.id.as_str()).collect::<Vec<_>>(), ["s2"], "存檔時順便清掉到期的");
    }

    #[test]
    fn 滿了拒絕新的_不淘汰還沒到期的舊紀錄() {
        let mut s = SeenIds::default();
        for i in 0..MAX_SEEN {
            s = s.with(&format!("s{i}"), NOW + 600, NOW).unwrap();
        }
        assert_eq!(s.with("新", NOW + 600, NOW).unwrap_err(), TOO_MANY);
        assert!(s.contains("s0"), "舊的還在");
        assert_eq!(s.seen.len(), MAX_SEEN);
        // 舊的到期後才有空位
        let later = NOW + 600 + KEEP_AFTER_EXPIRY_S;
        assert!(s.with("新", later + 600, later).is_ok());
    }

    #[test]
    fn 紀錄壞了_讀不到就不接受_也不洗掉() {
        let d = tempfile::tempdir().unwrap();
        std::fs::write(d.path().join(SEEN_FILE), "{壞").unwrap();
        assert!(check_unseen(d.path(), "s1", NOW).is_err());
        assert!(record(d.path(), "s1", NOW + 600, NOW).is_err());
        assert_eq!(std::fs::read_to_string(d.path().join(SEEN_FILE)).unwrap(), "{壞", "沒有被蓋掉");
    }

    #[test]
    fn 存不進去就是錯誤() {
        let d = tempfile::tempdir().unwrap();
        let file_not_dir = d.path().join("x");
        std::fs::write(&file_not_dir, "").unwrap();
        let s = SeenIds::default().with("s1", NOW + 600, NOW).unwrap();
        assert!(s.save(&file_not_dir).is_err(), "資料夾其實是檔案：寫不進去");
        assert!(record(&file_not_dir, "s1", NOW + 600, NOW).is_err());
    }

    #[test]
    fn 守門_t_接受前一定先查_先記_順序不能換() {
        let lib = include_str!("lib.rs");
        let f = lib.split("fn start_view_poller(").nth(1).expect("有 start_view_poller").split("\n}").next().unwrap();
        let check = f.find("view_seen::check_unseen(").expect("驗章前要查");
        let verify = f.find("view_stream::accept_request(").expect("有驗章");
        let record = f.find("view_seen::record(").expect("接受前要記");
        let accept = f.find("\"term_view_accept\"").expect("有回覆接受");
        assert!(check < verify && verify < record && record < accept, "順序：查 → 驗章 → 記 → 回覆接受");
    }
}

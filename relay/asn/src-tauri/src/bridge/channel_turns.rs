//! 內建通道的信處理到哪：工作資料夾裡每封信一個小檔（#828）。
//! - `<id>.started`：這封開始處理了。工作者真的開始前同步寫下，程序被直接結束也留得下。
//! - `<id>.resent`：重開後已經重送過一次，再沒做完就不再重送。
//! 一封一檔，不用鎖；寫不進去只會少一句提示或多重送一次，不影響收信。
use std::path::{Path, PathBuf};

const DIR: &str = "channel-turns";
/// 超過這麼久的記號當作殘留（信早就過了該處理的時間）
const KEEP_SECS: u64 = 7 * 86_400;

/// 信件編號只留安全字元，避免組出資料夾外的路徑
fn safe(id: &str) -> String {
    id.chars().map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '_' }).collect()
}

fn file(work_dir: &Path, id: &str, kind: &str) -> PathBuf {
    work_dir.join(DIR).join(format!("{}.{kind}", safe(id)))
}

fn mark(work_dir: &Path, id: &str, kind: &str) -> Result<(), String> {
    let p = file(work_dir, id, kind);
    if let Some(d) = p.parent() {
        std::fs::create_dir_all(d).map_err(|e| e.to_string())?;
    }
    std::fs::write(&p, b"1").map_err(|e| e.to_string())
}

pub fn mark_started(work_dir: &Path, id: &str) -> Result<(), String> {
    mark(work_dir, id, "started")
}

pub fn started(work_dir: &Path, id: &str) -> bool {
    file(work_dir, id, "started").exists()
}

pub fn clear_started(work_dir: &Path, id: &str) {
    let _ = std::fs::remove_file(file(work_dir, id, "started"));
}

pub fn mark_resent(work_dir: &Path, id: &str) -> Result<(), String> {
    mark(work_dir, id, "resent")
}

pub fn resent(work_dir: &Path, id: &str) -> bool {
    file(work_dir, id, "resent").exists()
}

/// 這封結束了：兩個記號都清掉
pub fn clear(work_dir: &Path, id: &str) {
    clear_started(work_dir, id);
    let _ = std::fs::remove_file(file(work_dir, id, "resent"));
}

/// 清掉太舊的記號（群組訊息、已經不在信箱的信留下的）
pub fn prune(work_dir: &Path) {
    let Ok(rd) = std::fs::read_dir(work_dir.join(DIR)) else { return };
    for e in rd.flatten() {
        let old = e.metadata().and_then(|m| m.modified()).ok().and_then(|t| t.elapsed().ok()).is_some_and(|d| d.as_secs() > KEEP_SECS);
        if old {
            let _ = std::fs::remove_file(e.path());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 記號寫入_查得到_清掉就沒有() {
        let d = tempfile::tempdir().unwrap();
        assert!(!started(d.path(), "a-1") && !resent(d.path(), "a-1"));
        mark_started(d.path(), "a-1").unwrap();
        mark_resent(d.path(), "a-1").unwrap();
        assert!(started(d.path(), "a-1") && resent(d.path(), "a-1"));
        assert!(!started(d.path(), "a-2"), "別封不受影響");
        clear_started(d.path(), "a-1");
        assert!(!started(d.path(), "a-1") && resent(d.path(), "a-1"), "只清開始的記號");
        clear(d.path(), "a-1");
        assert!(!resent(d.path(), "a-1"));
    }

    #[test]
    fn 編號裡的路徑字元不會跑出資料夾() {
        let d = tempfile::tempdir().unwrap();
        mark_started(d.path(), "../../evil").unwrap();
        assert!(started(d.path(), "../../evil"));
        assert!(!d.path().parent().unwrap().join("evil.started").exists());
        assert_eq!(std::fs::read_dir(d.path().join(DIR)).unwrap().count(), 1);
    }

    #[test]
    fn 新的記號不會被清掉() {
        let d = tempfile::tempdir().unwrap();
        mark_started(d.path(), "n").unwrap();
        prune(d.path());
        assert!(started(d.path(), "n"));
        prune(&d.path().join("不存在"));
    }
}

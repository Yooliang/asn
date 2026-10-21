//! 單一收信者鎖：與舊 Node 橋共用 `<工作資料夾>/bridge.pid` 的協定。
//! 檔案內容只有一個十進位 pid。pid 活著且不是自己＝另一個橋在跑，內建橋不啟動；
//! 檔案是舊的（pid 已死）就接手並寫上自己的 pid；結束時只在檔案裡還是自己的 pid 時才刪。
//! Node 橋啟動時讀到活著的 ASN pid 也會退出（exit 3），所以兩邊互斥。
use std::path::{Path, PathBuf};

pub fn pid_file(work_dir: &Path) -> PathBuf {
    work_dir.join("bridge.pid")
}
pub fn mailbox_pid_file(work_dir: &Path) -> PathBuf {
    work_dir.join("mailbox.pid")
}

pub fn read_pid(file: &Path) -> Option<u32> {
    std::fs::read_to_string(file).ok()?.trim().parse::<u32>().ok().filter(|p| *p != 0)
}

/// 另一個收信者的 pid（活著、而且不是 my_pid）；沒有回 None
pub fn foreign_holder(work_dir: &Path, my_pid: u32, alive: impl Fn(u32) -> bool) -> Option<u32> {
    read_pid(&pid_file(work_dir)).filter(|p| *p != my_pid && alive(*p))
}

#[derive(Debug, PartialEq)]
pub enum LockError {
    /// 另一個橋（舊 Node 橋或別的 ASN）活著
    HeldBy(u32),
    Io(String),
}

#[derive(Debug)]
pub struct BridgeLock {
    file: PathBuf,
    pid: u32,
}

impl BridgeLock {
    pub fn acquire(work_dir: &Path, my_pid: u32, alive: impl Fn(u32) -> bool) -> Result<BridgeLock, LockError> {
        std::fs::create_dir_all(work_dir).map_err(|e| LockError::Io(e.to_string()))?;
        if let Some(p) = foreign_holder(work_dir, my_pid, alive) {
            return Err(LockError::HeldBy(p));
        }
        let file = pid_file(work_dir);
        std::fs::write(&file, my_pid.to_string()).map_err(|e| LockError::Io(e.to_string()))?;
        Ok(BridgeLock { file, pid: my_pid })
    }
    pub fn release(&self) {
        if read_pid(&self.file) == Some(self.pid) {
            let _ = std::fs::remove_file(&self.file);
        }
    }
}

impl Drop for BridgeLock {
    fn drop(&mut self) {
        self.release();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 舊橋活著_不啟動_且不動它的_pid_檔() {
        let d = tempfile::tempdir().unwrap();
        std::fs::write(pid_file(d.path()), "4242\n").unwrap();
        assert_eq!(BridgeLock::acquire(d.path(), 7, |p| p == 4242).unwrap_err(), LockError::HeldBy(4242));
        assert_eq!(std::fs::read_to_string(pid_file(d.path())).unwrap(), "4242\n");
        assert_eq!(foreign_holder(d.path(), 7, |p| p == 4242), Some(4242));
    }

    #[test]
    fn pid_檔是舊的或沒有_就接手_結束只刪自己的() {
        let d = tempfile::tempdir().unwrap();
        // 沒有檔案
        let l = BridgeLock::acquire(d.path(), 7, |_| false).unwrap();
        assert_eq!(read_pid(&pid_file(d.path())), Some(7));
        // 內容被換成別人的（例如舊橋之後又起來）：我們結束時不能刪
        std::fs::write(pid_file(d.path()), "99").unwrap();
        drop(l);
        assert_eq!(read_pid(&pid_file(d.path())), Some(99));
        // pid 死了＝舊的，接手
        let l2 = BridgeLock::acquire(d.path(), 8, |_| false).unwrap();
        assert_eq!(read_pid(&pid_file(d.path())), Some(8));
        drop(l2);
        assert!(!pid_file(d.path()).exists());
    }

    #[test]
    fn 檔案裡是自己的_pid_不算別人_壞內容不算() {
        let d = tempfile::tempdir().unwrap();
        std::fs::write(pid_file(d.path()), "7").unwrap();
        assert_eq!(foreign_holder(d.path(), 7, |_| true), None);
        std::fs::write(pid_file(d.path()), "abc").unwrap();
        assert_eq!(foreign_holder(d.path(), 7, |_| true), None);
        std::fs::write(pid_file(d.path()), "0").unwrap();
        assert_eq!(foreign_holder(d.path(), 7, |_| true), None);
    }
}

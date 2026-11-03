//! 單一收信者鎖：與舊 Node 橋共用 `<工作資料夾>/bridge.pid` 的協定。
//! 檔案內容只有一個十進位 pid。pid 活著且不是自己＝另一個橋在跑，內建橋不啟動；
//! 檔案是舊的（pid 已死，或這個編號已經被別的程序用走）就接手並寫上自己的 pid；結束時只在檔案裡還是自己的 pid 時才刪。
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

/// 程序的建立時間與記錄檔的時間比對用的寬容值（兩者來自同一個時鐘，只防檔案系統的時間精度）
const WRITTEN_SLACK_MS: u64 = 5_000;
/// bridge.pid 可能的主人：舊 Node 橋、獨立的橋、別的 ASN
#[cfg(not(test))]
const BRIDGE_IMAGES: [&str; 3] = ["node", "asn-bridge", "asn"];
/// 測試的假舊橋是自己開的 cmd／sleep（名單以外的情況另有測試：測試程序本身、NVIDIA 的路徑都不算）
#[cfg(test)]
const BRIDGE_IMAGES: [&str; 5] = ["node", "asn-bridge", "asn", "cmd", "sleep"];
/// mailbox.pid 可能的主人：收發室 worker
const MAILBOX_IMAGES: [&str; 2] = ["claude", "node"];

/// 查得到的程序資訊。`images`＝這個記錄檔的主人該是哪些程式
#[derive(Debug, Clone)]
pub struct Holder<'a> {
    pub alive: bool,
    pub started_ms: Option<u64>,
    pub written_ms: Option<u64>,
    pub image: Option<String>,
    pub images: &'a [&'a str],
}

impl Holder<'_> {
    /// 比記錄檔晚啟動：程序一定先啟動才寫檔，所以是編號被回收了（重開機後檔案留著，編號被無關的程序用走）
    fn started_late(&self) -> bool {
        matches!((self.started_ms, self.written_ms), (Some(s), Some(w)) if s > w.saturating_add(WRITTEN_SLACK_MS))
    }
    fn image_matches(&self) -> Option<bool> {
        let img = self.image.as_deref()?;
        let file = img.rsplit(['\\', '/']).next().unwrap_or(img).to_ascii_lowercase();
        let stem = file.strip_suffix(".exe").unwrap_or(&file);
        Some(self.images.contains(&stem))
    }
    /// 算不算有人在收信：有反證才不算。查不到就維持「算」，寧可不接手也不搶別人的
    pub fn counts(&self) -> bool {
        self.alive && !self.started_late() && self.image_matches() != Some(false)
    }
    /// 可不可以結束它：全部查得到而且都相符才可以。查不到就絕不動手
    pub fn may_kill(&self) -> bool {
        self.alive && self.started_ms.is_some() && self.written_ms.is_some() && !self.started_late() && self.image_matches() == Some(true)
    }
}

fn holder_of(work_dir: &Path, pid: u32) -> Holder<'static> {
    let (file, images): (PathBuf, &'static [&'static str]) = if read_pid(&mailbox_pid_file(work_dir)) == Some(pid) && read_pid(&pid_file(work_dir)) != Some(pid) {
        (mailbox_pid_file(work_dir), &MAILBOX_IMAGES)
    } else {
        (pid_file(work_dir), &BRIDGE_IMAGES)
    };
    Holder { alive: crate::heartbeat::pid_alive(pid), started_ms: crate::heartbeat::process_started_ms(pid), written_ms: modified_ms(&file), image: crate::heartbeat::process_image(pid), images }
}

/// 正式用的存活判斷（拿鎖、顯示狀態）：見 [`Holder::counts`]
pub fn holder_alive(work_dir: &Path) -> impl Fn(u32) -> bool + '_ {
    move |pid| holder_of(work_dir, pid).counts()
}

/// 要結束這個程序之前的核對：見 [`Holder::may_kill`]
pub fn may_kill_holder(work_dir: &Path, pid: u32) -> bool {
    holder_of(work_dir, pid).may_kill()
}

fn modified_ms(file: &Path) -> Option<u64> {
    let t = std::fs::metadata(file).ok()?.modified().ok()?;
    Some(t.duration_since(std::time::UNIX_EPOCH).ok()?.as_millis() as u64)
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

    fn h(alive: bool, started: Option<u64>, written: Option<u64>, image: Option<&str>) -> Holder<'static> {
        Holder { alive, started_ms: started, written_ms: written, image: image.map(String::from), images: &BRIDGE_IMAGES }
    }
    const W: u64 = 1_000_000;

    #[test]
    fn 重開機後編號被無關程序占用_不算有人在收信_也絕不能結束() {
        let nv = h(true, Some(W + 3 * 3600_000), Some(W), Some(r"C:\WINDOWS\System32\NVDisplay.Container.exe"));
        assert!(!nv.counts() && !nv.may_kill());
        // 時間異常（程序看起來比較早）但名稱不對：只靠名稱也擋得住
        let odd = h(true, Some(W - 1), Some(W), Some(r"C:\WINDOWS\System32\NVDisplay.Container.exe"));
        assert!(!odd.counts() && !odd.may_kill());
        // 名稱對但比檔案晚啟動：別的 node 用走這個編號
        let other_node = h(true, Some(W + 60_000), Some(W), Some(r"C:\nodejs\node.exe"));
        assert!(!other_node.counts() && !other_node.may_kill());
    }

    #[test]
    fn 真的舊橋還活著_算有人在收信_不搶_可以結束() {
        for img in [r"C:\nodejs\node.exe", r"C:\A\ASN.EXE", r"C:\A\asn-bridge.exe", "node"] {
            let old = h(true, Some(W - 60_000), Some(W), Some(img));
            assert!(old.counts() && old.may_kill(), "{img}");
        }
        assert!(h(true, Some(W + 1_000), Some(W), Some("node.exe")).counts(), "時間精度內不算晚");
    }

    #[test]
    fn 查不到時_判斷維持算_但絕不結束() {
        for x in [h(true, None, Some(W), Some("node.exe")), h(true, Some(W - 1), None, Some("node.exe")), h(true, Some(W - 1), Some(W), None)] {
            assert!(x.counts(), "{x:?}");
            assert!(!x.may_kill(), "{x:?}");
        }
        let gone = h(false, Some(W - 1), Some(W), Some("node.exe"));
        assert!(!gone.counts() && !gone.may_kill(), "程序不在");
    }

    #[test]
    fn 收發室_worker_的名稱另外一份() {
        let m = Holder { images: &MAILBOX_IMAGES, ..h(true, Some(W - 1), Some(W), Some(r"C:\b\claude.exe")) };
        assert!(m.counts() && m.may_kill());
        assert!(!h(true, Some(W - 1), Some(W), Some(r"C:\b\claude.exe")).counts(), "claude 不是橋");
    }

    /// 真的查程序（只有 Windows 查得到建立時間）：測試程序不是收發室，名稱就對不上，所以編號被占用的情況可以接手、不能結束
    #[cfg(windows)]
    #[test]
    fn 真機_記錄檔指到無關程序_內建橋可以接手_不能結束它() {
        let d = tempfile::tempdir().unwrap();
        let me = std::process::id();
        let f = pid_file(d.path());
        std::fs::write(&f, me.to_string()).unwrap();
        assert!(crate::heartbeat::process_image(me).is_some(), "查得到自己的執行檔");
        assert!(!holder_alive(d.path())(me), "名稱對不上：不算");
        assert!(!may_kill_holder(d.path(), me), "不能結束");
        assert_eq!(foreign_holder(d.path(), 7, holder_alive(d.path())), None);
        let l = BridgeLock::acquire(d.path(), 7, holder_alive(d.path())).expect("可以接手");
        assert_eq!(read_pid(&f), Some(7));
        drop(l);
        // 一樣的程序，檔案時間改到它啟動之前：時間也對不上
        std::fs::write(&f, me.to_string()).unwrap();
        let old = std::time::SystemTime::now() - std::time::Duration::from_secs(365 * 24 * 3600);
        std::fs::OpenOptions::new().write(true).open(&f).unwrap().set_modified(old).unwrap();
        assert!(holder_of(d.path(), me).started_late());
    }

    #[test]
    fn 守門_拿鎖與結束舊橋都走_holder_alive() {
        let src = include_str!("mod.rs").replace("\r\n", "\n");
        for call in ["BridgeLock::acquire(", "handoff::legacy_status(", "handoff::takeover(", "lock::foreign_holder("] {
            let hits: Vec<&str> = src.lines().filter(|l| l.contains(call)).collect();
            assert!(!hits.is_empty(), "找不到 {call}");
            for l in hits {
                assert!(l.contains("holder_alive") && !l.contains("heartbeat::pid_alive"), "{l}");
            }
        }
    }

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

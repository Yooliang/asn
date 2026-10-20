//! 「視窗自己收信」心跳，格式與 relay/machine/self-recv.mjs 完全相同：
//! `<工作目錄>/self-recv/<視窗名（\/:*?"<>| 與控制字元換成 _）>.json`，內容 `{"pid":…,"name":…,"t":…}`，
//! 先寫 `<檔>.<pid>.tmp` 再 rename（原子寫入）。機器橋看到 90 秒內、pid 還活著的心跳，就不再轉交這個視窗的信。
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

/// 與 self-recv.mjs 的 HEARTBEAT_MS／STALE_MS 同值（可用同樣的環境變數覆寫）
pub fn heartbeat_ms() -> u64 {
    std::env::var("IRORI_RECV_HEARTBEAT_MS").ok().and_then(|v| v.parse().ok()).unwrap_or(30_000)
}
pub fn stale_ms() -> u64 {
    std::env::var("IRORI_RECV_STALE_MS").ok().and_then(|v| v.parse().ok()).unwrap_or(90_000)
}

#[derive(Serialize, Deserialize, Debug, PartialEq, Clone)]
pub struct Heartbeat {
    pub pid: u32,
    pub name: String,
    pub t: u64,
}

pub fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

pub fn self_recv_dir(work_dir: &Path) -> PathBuf {
    work_dir.join("self-recv")
}

/// 檔名：`[\\/:*?"<>|\x00-\x1f]` 換成 `_`
pub fn heartbeat_file(work_dir: &Path, name: &str) -> PathBuf {
    let safe: String = name
        .chars()
        .map(|c| if matches!(c, '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|') || (c as u32) < 0x20 { '_' } else { c })
        .collect();
    self_recv_dir(work_dir).join(format!("{safe}.json"))
}

pub fn read_heartbeat(work_dir: &Path, name: &str) -> Option<Heartbeat> {
    serde_json::from_str(&fs::read_to_string(heartbeat_file(work_dir, name)).ok()?).ok()
}

pub fn write_heartbeat(work_dir: &Path, name: &str, pid: u32, now: u64) -> std::io::Result<()> {
    fs::create_dir_all(self_recv_dir(work_dir))?;
    let file = heartbeat_file(work_dir, name);
    let tmp = PathBuf::from(format!("{}.{}.tmp", file.display(), std::process::id()));
    let body = serde_json::to_string(&Heartbeat { pid, name: name.to_string(), t: now })?;
    fs::write(&tmp, body)?;
    fs::rename(&tmp, &file)
}

/// 只有心跳的 pid 是自己才刪（別人的心跳不碰）
pub fn clear_heartbeat(work_dir: &Path, name: &str, pid: u32) {
    if read_heartbeat(work_dir, name).map(|h| h.pid) == Some(pid) {
        let _ = fs::remove_file(heartbeat_file(work_dir, name));
    }
}

#[cfg(windows)]
pub fn pid_alive(pid: u32) -> bool {
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::Threading::{OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION};
    if pid == 0 {
        return false;
    }
    unsafe {
        let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if h.is_null() {
            // 沒權限（ERROR_ACCESS_DENIED）也算活著，與 self-recv.mjs 的 EPERM 同
            return std::io::Error::last_os_error().raw_os_error() == Some(5);
        }
        CloseHandle(h);
        true
    }
}
#[cfg(not(windows))]
pub fn pid_alive(pid: u32) -> bool {
    Path::new(&format!("/proc/{pid}")).exists()
}

/// 心跳是否新鮮且 pid 還活著（同 selfRecvAlive）
pub fn alive_fresh(h: &Heartbeat, now: u64, stale: u64, alive: impl Fn(u32) -> bool) -> bool {
    now.saturating_sub(h.t) <= stale && h.t.saturating_sub(now) < stale && alive(h.pid)
}

/// 已經有另一個 ASN（別的 pid）用同一個視窗名在收信嗎？
pub fn other_instance(work_dir: &Path, name: &str, my_pid: u32) -> Option<Heartbeat> {
    let h = read_heartbeat(work_dir, name)?;
    (h.pid != my_pid && alive_fresh(&h, now_ms(), stale_ms(), pid_alive)).then_some(h)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 檔名與格式和_self_recv_mjs_相同() {
        let d = tempfile::tempdir().unwrap();
        write_heartbeat(d.path(), "H-ASN", 4242, 1_700_000_000_000).unwrap();
        let f = d.path().join("self-recv").join("H-ASN.json");
        assert_eq!(fs::read_to_string(&f).unwrap(), r#"{"pid":4242,"name":"H-ASN","t":1700000000000}"#);
        assert_eq!(read_heartbeat(d.path(), "H-ASN"), Some(Heartbeat { pid: 4242, name: "H-ASN".into(), t: 1_700_000_000_000 }));
        // 原子寫入不留暫存檔
        assert!(fs::read_dir(d.path().join("self-recv")).unwrap().all(|e| !e.unwrap().file_name().to_string_lossy().ends_with(".tmp")));
    }

    #[test]
    fn 視窗名裡的非法檔名字元換成底線() {
        let p = heartbeat_file(Path::new("w"), "a/b\\c:d*e?f\"g<h>i|j\u{1}k");
        assert_eq!(p.file_name().unwrap().to_string_lossy(), "a_b_c_d_e_f_g_h_i_j_k.json");
        assert_eq!(heartbeat_file(Path::new("w"), "家用-ASN").file_name().unwrap().to_string_lossy(), "家用-ASN.json");
    }

    #[test]
    fn 覆寫同一檔_clear_只刪自己的() {
        let d = tempfile::tempdir().unwrap();
        write_heartbeat(d.path(), "X", 1, 10).unwrap();
        write_heartbeat(d.path(), "X", 2, 20).unwrap();
        assert_eq!(read_heartbeat(d.path(), "X").unwrap().pid, 2);
        clear_heartbeat(d.path(), "X", 1);
        assert!(read_heartbeat(d.path(), "X").is_some(), "別人的心跳不能刪");
        clear_heartbeat(d.path(), "X", 2);
        assert!(read_heartbeat(d.path(), "X").is_none());
    }

    #[test]
    fn 新鮮度判斷與_selfrecvalive_相同() {
        let h = Heartbeat { pid: 7, name: "n".into(), t: 1_000_000 };
        assert!(alive_fresh(&h, 1_000_000 + 90_000, 90_000, |_| true));
        assert!(!alive_fresh(&h, 1_000_000 + 90_001, 90_000, |_| true), "過期");
        assert!(!alive_fresh(&h, 1_000_000, 90_000, |_| false), "pid 死了");
        assert!(!alive_fresh(&h, 1_000_000 - 90_000, 90_000, |_| true), "時間在未來太多");
    }

    #[test]
    fn 自己的_pid_是活的_不存在的不是() {
        assert!(pid_alive(std::process::id()));
        assert!(!pid_alive(0));
    }

    #[test]
    fn 別的活實例會被認出來_自己不算() {
        let d = tempfile::tempdir().unwrap();
        write_heartbeat(d.path(), "S", std::process::id(), now_ms()).unwrap();
        assert!(other_instance(d.path(), "S", std::process::id()).is_none());
        assert!(other_instance(d.path(), "S", 1).is_some(), "另一個 pid 看到本行程的新鮮心跳＝已有人在收");
    }
}

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
        // 已經結束、但還有人握著它的 handle（安裝程式、WebView 子程序等）時 OpenProcess 照樣成功：要看結束碼
        const STILL_ACTIVE: u32 = 259;
        let mut code: u32 = 0;
        let ok = windows_sys::Win32::System::Threading::GetExitCodeProcess(h, &mut code) != 0;
        CloseHandle(h);
        !ok || code == STILL_ACTIVE
    }
}
#[cfg(not(windows))]
pub fn pid_alive(pid: u32) -> bool {
    Path::new(&format!("/proc/{pid}")).exists()
}

/// 這個 pid 的執行檔是不是 asn（查不到回 None，呼叫端當作「可能是」）
#[cfg(windows)]
pub fn is_asn_process(pid: u32) -> Option<bool> {
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::Threading::{OpenProcess, QueryFullProcessImageNameW, PROCESS_QUERY_LIMITED_INFORMATION};
    unsafe {
        let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if h.is_null() {
            return None;
        }
        let mut buf = [0u16; 1024];
        let mut len = buf.len() as u32;
        let ok = QueryFullProcessImageNameW(h, 0, buf.as_mut_ptr(), &mut len) != 0;
        CloseHandle(h);
        ok.then(|| image_is_asn(&String::from_utf16_lossy(&buf[..len as usize])))
    }
}
#[cfg(not(windows))]
pub fn is_asn_process(pid: u32) -> Option<bool> {
    let comm = fs::read_to_string(format!("/proc/{pid}/comm")).ok()?;
    Some(image_is_asn(comm.trim()))
}

/// 執行檔名（不分大小寫、不看路徑）是 asn 或 asn.exe
pub fn image_is_asn(path: &str) -> bool {
    let file = path.rsplit(['\\', '/']).next().unwrap_or(path).to_ascii_lowercase();
    file == "asn" || file == "asn.exe"
}

/// 心跳是否新鮮且 pid 還活著（同 selfRecvAlive）
pub fn alive_fresh(h: &Heartbeat, now: u64, stale: u64, alive: impl Fn(u32) -> bool) -> bool {
    now.saturating_sub(h.t) <= stale && h.t.saturating_sub(now) < stale && alive(h.pid)
}

/// 已經有另一個 ASN（別的 pid）用同一個視窗名在收信嗎？
pub fn other_instance(work_dir: &Path, name: &str, my_pid: u32) -> Option<Heartbeat> {
    other_instance_with(work_dir, name, my_pid, is_asn_process)
}

/// 同上，執行檔判斷可替換（測試用）；pid 被別的程式重用也不算：執行檔得是 asn
pub fn other_instance_with(work_dir: &Path, name: &str, my_pid: u32, is_asn: impl Fn(u32) -> Option<bool>) -> Option<Heartbeat> {
    let h = read_heartbeat(work_dir, name)?;
    (h.pid != my_pid && alive_fresh(&h, now_ms(), stale_ms(), pid_alive) && is_asn(h.pid) != Some(false)).then_some(h)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[allow(unused_imports)]
    use crate::nowin::NoWindow;

    #[test]
    fn 執行檔名判斷() {
        assert!(image_is_asn(r"C:\Users\x\AppData\Local\ASN\asn.exe"));
        assert!(image_is_asn("ASN.EXE"));
        assert!(image_is_asn("/opt/asn/asn"));
        assert!(!image_is_asn(r"C:\Windows\System32\PING.EXE"));
        assert!(!image_is_asn("asn-cli.exe"));
    }

    /// 工作機實際踩到的：舊 ASN 已結束，但它的 handle 還被握著 → 不能算活著
    #[test]
    fn 已結束的程序即使handle還被握著也不算活著() {
        #[cfg(windows)]
        let mut c = {
            let mut c = std::process::Command::new("cmd");
            c.no_window().args(["/c", "exit 0"]);
            c
        };
        #[cfg(not(windows))]
        let mut c = std::process::Command::new("true");
        c.no_window();
        let mut child = c.spawn().unwrap();
        let pid = child.id();
        child.wait().unwrap();
        // child 還沒 drop：handle 還在，正是舊版會誤判成活著的情況
        assert!(!pid_alive(pid), "結束的程序不算活著");
        drop(child);
    }

    #[test]
    fn 心跳的pid是別的程式就不算另一個ASN() {
        let d = tempfile::tempdir().unwrap();
        #[cfg(windows)]
        let mut c = {
            let mut c = std::process::Command::new("ping.exe");
            c.no_window().args(["-n", "20", "127.0.0.1"]);
            c
        };
        #[cfg(not(windows))]
        let mut c = {
            let mut c = std::process::Command::new("sleep");
            c.no_window();
            c.arg("20");
            c
        };
        let mut child = c.stdout(std::process::Stdio::null()).spawn().unwrap();
        let pid = child.id();
        write_heartbeat(d.path(), "工作機", pid, now_ms()).unwrap();
        assert!(pid_alive(pid));
        assert_eq!(is_asn_process(pid), Some(false));
        assert!(other_instance(d.path(), "工作機", std::process::id()).is_none(), "pid 是別的程式，不是 ASN");
        let _ = child.kill();
        let _ = child.wait();
    }

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
        assert!(other_instance_with(d.path(), "S", 1, |_| Some(true)).is_some(), "另一個 pid 看到本行程的新鮮心跳＝已有人在收");
    }
}

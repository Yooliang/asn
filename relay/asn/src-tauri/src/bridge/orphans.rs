//! 孤兒清理：對應 relay/machine/self-update.mjs 的 `orphansOf`／`killTree` 與 bridge.mjs 開頭的 `bridge.last` 流程。
//! 橋被硬砍（工作管理員、當機、斷電）時，它開的收發室 worker（`claude -p`）不會跟著結束，
//! 新的橋起來後兩組會同時收信。橋把自己的 pid 記在 `bridge.last`（正常結束也不刪），下次啟動時：
//! 上一個橋已經不在了，父程序還是它的程序就是孤兒，連同子孫一起結束。
//!
//! 只依 `bridge.last` 記的父 PID 判斷，不依名稱砍程序。內建橋比 Node 橋多一道限制：
//! ASN 是桌面程式，上一個 ASN 還有別的子程序（例如在 Linux 上開的終端機視窗），不能一起收掉，
//! 所以孤兒還必須是上次記在 `mailbox.pid` 的收發室 worker。
use super::lock::{mailbox_pid_file, read_pid};
use std::collections::HashMap;
use std::path::{Path, PathBuf};

pub fn last_file(work_dir: &Path) -> PathBuf {
    work_dir.join("bridge.last")
}

/// table：pid → 父 pid。回傳上一個橋（last_pid）留下、還活著的直接子程序；
/// 上一個橋還活著（它的 pid 還在表裡，可能是同編號被別的程序拿去用）或就是自己：什麼都不碰
pub fn orphans_of(table: &HashMap<u32, u32>, last_pid: u32, self_pid: u32) -> Vec<u32> {
    if last_pid == 0 || last_pid == self_pid || table.contains_key(&last_pid) {
        return vec![];
    }
    let mut v: Vec<u32> = table.iter().filter(|(pid, ppid)| **ppid == last_pid && **pid != self_pid).map(|(pid, _)| *pid).collect();
    v.sort_unstable();
    v
}

/// 所有程序的 pid → 父 pid（Windows 用 Toolhelp 快照，其他系統讀 /proc/<pid>/stat）
pub fn process_table() -> HashMap<u32, u32> {
    imp::process_table()
}

/// 結束一個程序和它的子孫（只用在已確認是孤兒的 pid）
pub fn kill_tree(pid: u32) -> bool {
    imp::kill_tree(pid)
}

/// 啟動時清一次，然後把自己的 pid 記進 bridge.last。回傳 log 行。table／kill 可注入，好測試
pub fn cleanup_and_mark(work_dir: &Path, self_pid: u32, table: impl Fn() -> HashMap<u32, u32>, kill: impl Fn(u32) -> bool) -> Vec<String> {
    let mut logs = vec![];
    let last = std::fs::read_to_string(last_file(work_dir)).ok().and_then(|t| t.trim().parse::<u32>().ok()).unwrap_or(0);
    if last != 0 {
        let worker = read_pid(&mailbox_pid_file(work_dir));
        for pid in orphans_of(&table(), last, self_pid) {
            if Some(pid) != worker {
                continue; // 上一個 ASN 的其他子程序不是我們開的收發室 worker，不碰
            }
            logs.push(format!("killed orphan pid={pid} left by previous bridge pid={last}: {}", if kill(pid) { "ok" } else { "failed" }));
        }
    }
    if let Err(e) = std::fs::write(last_file(work_dir), self_pid.to_string()) {
        logs.push(format!("bridge.last write failed: {e}"));
    }
    logs
}

#[cfg(windows)]
mod imp {
    use super::HashMap;
    use crate::nowin::NoWindow;
    use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS};

    pub fn process_table() -> HashMap<u32, u32> {
        let mut out = HashMap::new();
        unsafe {
            let snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
            if snap == INVALID_HANDLE_VALUE {
                return out;
            }
            let mut e: PROCESSENTRY32W = std::mem::zeroed();
            e.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
            let mut ok = Process32FirstW(snap, &mut e);
            while ok != 0 {
                out.insert(e.th32ProcessID, e.th32ParentProcessID);
                ok = Process32NextW(snap, &mut e);
            }
            CloseHandle(snap);
        }
        out
    }

    pub fn kill_tree(pid: u32) -> bool {
        if pid == 0 {
            return false;
        }
        std::process::Command::new("taskkill").no_window().args(["/PID", &pid.to_string(), "/T", "/F"]).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null()).status().map(|s| s.success()).unwrap_or(false)
    }
}

#[cfg(not(windows))]
mod imp {
    use super::HashMap;
    use crate::nowin::NoWindow;

    pub fn process_table() -> HashMap<u32, u32> {
        let mut out = HashMap::new();
        let Ok(rd) = std::fs::read_dir("/proc") else { return out };
        for e in rd.flatten() {
            let Some(pid) = e.file_name().to_str().and_then(|s| s.parse::<u32>().ok()) else { continue };
            let Ok(stat) = std::fs::read_to_string(e.path().join("stat")) else { continue };
            // 格式：pid (comm) state ppid …；comm 可能含空白與括號，從最後一個「)」往後切
            if let Some(rest) = stat.rsplit_once(')').map(|x| x.1) {
                if let Some(ppid) = rest.split_whitespace().nth(1).and_then(|s| s.parse::<u32>().ok()) {
                    out.insert(pid, ppid);
                }
            }
        }
        out
    }

    pub fn kill_tree(pid: u32) -> bool {
        if pid == 0 {
            return false;
        }
        // 先收子孫再收自己（pkill -P 只認直接子程序，這裡夠用：worker 的子程序很淺）
        let _ = std::process::Command::new("pkill").no_window().args(["-TERM", "-P", &pid.to_string()]).status();
        std::process::Command::new("kill").no_window().args(["-TERM", &pid.to_string()]).status().map(|s| s.success()).unwrap_or(false)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::nowin::NoWindow;

    fn table(rows: &[(u32, u32)]) -> HashMap<u32, u32> {
        rows.iter().copied().collect()
    }

    #[test]
    fn 上一個橋不在了_它的直接子程序是孤兒() {
        let t = table(&[(10, 1), (20, 5), (21, 5), (22, 20), (30, 99)]);
        assert_eq!(orphans_of(&t, 5, 99), vec![20, 21], "只看直接子程序（孫子隨 taskkill /T 一起走）");
    }

    #[test]
    fn 上一個橋還活著_或就是自己_或沒記錄_什麼都不碰() {
        let t = table(&[(5, 1), (20, 5), (30, 99)]);
        assert!(orphans_of(&t, 5, 99).is_empty(), "上一個橋的 pid 還在表裡（活著或被別人拿去用）");
        assert!(orphans_of(&t, 99, 99).is_empty(), "就是自己");
        assert!(orphans_of(&t, 0, 99).is_empty());
        let gone = table(&[(30, 99), (31, 99)]);
        assert!(orphans_of(&gone, 7, 99).is_empty(), "沒有子程序");
        assert!(!orphans_of(&table(&[(20, 7), (99, 7)]), 7, 99).contains(&99), "不包含自己");
    }

    #[test]
    fn 啟動清理_只結束記在_mailbox_pid_的孤兒_並記下自己的_pid() {
        let d = tempfile::tempdir().unwrap();
        std::fs::write(last_file(d.path()), "5").unwrap();
        std::fs::write(mailbox_pid_file(d.path()), "20").unwrap();
        let t = table(&[(20, 5), (21, 5), (30, 99)]);
        let killed = std::cell::RefCell::new(vec![]);
        let logs = cleanup_and_mark(d.path(), 99, || t.clone(), |p| {
            killed.borrow_mut().push(p);
            true
        });
        assert_eq!(*killed.borrow(), vec![20], "21 是上一個 ASN 的別的子程序，不是收發室 worker：不碰");
        assert_eq!(logs.len(), 1);
        assert!(logs[0].contains("killed orphan pid=20") && logs[0].contains("previous bridge pid=5") && logs[0].ends_with("ok"));
        assert_eq!(std::fs::read_to_string(last_file(d.path())).unwrap(), "99");
        // 殺失敗要照實記
        std::fs::write(last_file(d.path()), "5").unwrap();
        let logs = cleanup_and_mark(d.path(), 99, || t.clone(), |_| false);
        assert!(logs[0].ends_with("failed"));
    }

    #[test]
    fn 啟動清理_沒有_bridge_last_或上一個橋還活著_不殺任何程序() {
        let d = tempfile::tempdir().unwrap();
        let t = table(&[(5, 1), (20, 5)]);
        let kill = |_p: u32| -> bool { panic!("不該殺任何程序") };
        assert!(cleanup_and_mark(d.path(), 99, || t.clone(), kill).is_empty());
        assert_eq!(std::fs::read_to_string(last_file(d.path())).unwrap(), "99");
        std::fs::write(last_file(d.path()), "5").unwrap();
        std::fs::write(mailbox_pid_file(d.path()), "20").unwrap();
        assert!(cleanup_and_mark(d.path(), 99, || t.clone(), kill).is_empty(), "上一個橋（pid 5）還在表裡");
    }

    #[test]
    fn 真的程序表_自己的父子關係對得上() {
        let t = process_table();
        let me = std::process::id();
        assert!(t.contains_key(&me), "表裡有自己");
        let mut c = if cfg!(windows) {
            let mut c = std::process::Command::new("cmd");
            c.no_window().args(["/c", "ping -n 20 127.0.0.1 >nul"]);
            c
        } else {
            let mut c = std::process::Command::new("sleep");
            c.no_window().arg("20");
            c
        };
        let mut child = c.stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null()).spawn().expect("開測試用子程序");
        let cpid = child.id();
        let t2 = process_table();
        let found = t2.get(&cpid).copied();
        // 只結束自己開的這一個（記下的 PID）
        let _ = child.kill();
        let _ = child.wait();
        assert_eq!(found, Some(me), "子程序的父 pid 是自己");
        assert!(orphans_of(&t2, me, me + 1).contains(&cpid) == false, "自己還活著（在表裡）就不算孤兒");
    }
}

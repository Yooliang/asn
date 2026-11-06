//! Linux：結束 ASN 開的終端（WezTerm）和它底下的行程樹（0.2.9）。Windows 照舊用 taskkill。
//!
//! 會殺行程，所以規則很嚴（asn真 親審）：
//! 1. 根行程先核對：執行檔是 WezTerm 的那幾支、開始時間讀得到；之後每次送信號前都再核對一次開始時間（被重用就不動）。
//!    「是不是當初開的那一個」由呼叫端先用記下的建立時間核對過（`started_ms(pid) == 記下的`）才會叫到這裡。
//! 2. 整棵樹只收和根行程同一個使用者（uid）、而且就是這個 ASN 使用者的行程；送 KILL 前每支再核對開始時間。
//! 3. 絕不對 pid 0、1、ASN 自己、ASN 本體（執行檔是 asn）送信號。
//!
//! 先送 TERM（子孫先、根最後），等 [`GRACE`] 還在的再送 KILL。
#![cfg_attr(not(target_os = "linux"), allow(dead_code))]
use std::collections::HashMap;
use std::time::Duration;

/// TERM 之後等多久才補 KILL
pub const GRACE: Duration = Duration::from_secs(2);
/// 可以當根行程的執行檔（只有 ASN 開的 WezTerm）
pub const ROOT_EXES: [&str; 3] = ["wezterm-gui", "wezterm", "wezterm-mux-server"];

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Row {
    pub pid: u32,
    pub ppid: u32,
    pub uid: u32,
    /// 開始時間（秒）
    pub start: u64,
    /// 執行檔名（不含路徑）
    pub exe: String,
}

/// /proc/<pid>/status 的 Uid 行：第一個數字是真實 uid
pub fn parse_uid(status: &str) -> Option<u32> {
    status.lines().find_map(|l| l.strip_prefix("Uid:"))?.split_whitespace().next()?.parse().ok()
}

/// 不能碰的：0、1、自己、ASN 本體
fn protected(r: &Row, me: u32) -> bool {
    r.pid <= 1 || r.pid == me || crate::heartbeat::image_is_asn(&r.exe)
}

/// 決定要收哪些：（pid, 開始時間），子孫在前、根在最後。根不合規則就是錯誤，什麼都不收
pub fn plan(rows: &[Row], root: u32, my_uid: u32, me: u32) -> Result<Vec<(u32, u64)>, String> {
    let by_pid: HashMap<u32, &Row> = rows.iter().map(|r| (r.pid, r)).collect();
    let r = by_pid.get(&root).ok_or("這個行程已經不在了")?;
    if protected(r, me) {
        return Err("這個行程不能結束".into());
    }
    if !ROOT_EXES.contains(&r.exe.as_str()) {
        return Err("不是 ASN 開的終端，不結束".into());
    }
    if r.uid != my_uid {
        return Err("不是這個使用者的行程，不結束".into());
    }
    // 往下找子孫：同一個 uid、不是受保護的；子孫的開始時間不能早於根（早於＝編號被重用的別人）
    let mut out: Vec<(u32, u64)> = vec![];
    let mut frontier = vec![root];
    let mut seen = vec![root];
    while let Some(p) = frontier.pop() {
        for c in rows.iter().filter(|c| c.ppid == p && !seen.contains(&c.pid)) {
            seen.push(c.pid);
            if c.uid != my_uid || protected(c, me) || c.start < r.start {
                continue;
            }
            out.push((c.pid, c.start));
            frontier.push(c.pid);
        }
    }
    out.reverse();
    out.push((root, r.start));
    Ok(out)
}

#[cfg(target_os = "linux")]
pub mod live {
    use super::*;
    use crate::nowin::NoWindow;
    use std::process::{Command, Stdio};

    /// 讀整個行程表（讀不到的行程跳過）
    pub fn table() -> Vec<Row> {
        let Ok(rd) = std::fs::read_dir("/proc") else { return vec![] };
        let btime = std::fs::read_to_string("/proc/stat").unwrap_or_default();
        rd.flatten()
            .filter_map(|e| {
                let pid: u32 = e.file_name().to_str()?.parse().ok()?;
                let stat = std::fs::read_to_string(e.path().join("stat")).ok()?;
                let ppid = stat.rsplit_once(')')?.1.split_whitespace().nth(1)?.parse().ok()?;
                let start = crate::heartbeat::parse_start_secs(&stat, &btime)?;
                let uid = parse_uid(&std::fs::read_to_string(e.path().join("status")).ok()?)?;
                let exe = std::fs::read_link(e.path().join("exe")).ok().and_then(|p| p.file_name().map(|n| n.to_string_lossy().into_owned())).unwrap_or_default();
                Some(Row { pid, ppid, uid, start, exe })
            })
            .collect()
    }

    fn my_uid() -> Option<u32> {
        parse_uid(&std::fs::read_to_string("/proc/self/status").ok()?)
    }

    /// 送信號前再核對一次：還在（不是已經結束、只等收屍的殭屍）、開始時間沒變
    fn still_same(pid: u32, start: u64) -> bool {
        let Ok(stat) = std::fs::read_to_string(format!("/proc/{pid}/stat")) else { return false };
        let state = stat.rsplit_once(')').and_then(|x| x.1.split_whitespace().next()).unwrap_or("");
        !matches!(state, "Z" | "X") && crate::heartbeat::process_start_secs(pid) == Some(start)
    }

    fn signal(sig: &str, pids: &[u32]) {
        if pids.is_empty() {
            return;
        }
        let mut c = Command::new("kill");
        c.no_window().arg(sig);
        for p in pids {
            c.arg(p.to_string());
        }
        let _ = c.stdout(Stdio::null()).stderr(Stdio::null()).status();
    }

    /// 結束 root 和它底下的行程樹。回有沒有收掉根行程
    pub fn kill_tree(root: u32) -> bool {
        let Some(uid) = my_uid() else { return false };
        let me = std::process::id();
        let targets = match plan(&table(), root, uid, me) {
            Ok(t) => t,
            Err(e) => {
                elog!("[ASN] 不結束行程 {root}：{e}");
                return false;
            }
        };
        let term: Vec<u32> = targets.iter().filter(|(p, s)| still_same(*p, *s)).map(|(p, _)| *p).collect();
        signal("-TERM", &term);
        let deadline = std::time::Instant::now() + GRACE;
        while std::time::Instant::now() < deadline && targets.iter().any(|(p, s)| still_same(*p, *s)) {
            std::thread::sleep(Duration::from_millis(100));
        }
        let kill: Vec<u32> = targets.iter().filter(|(p, s)| still_same(*p, *s)).map(|(p, _)| *p).collect();
        signal("-KILL", &kill);
        !still_same(root, targets.last().map(|t| t.1).unwrap_or(0))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(pid: u32, ppid: u32, uid: u32, start: u64, exe: &str) -> Row {
        Row { pid, ppid, uid, start, exe: exe.into() }
    }

    #[test]
    fn uid_讀_status_的第一個數字() {
        assert_eq!(parse_uid("Name:\tx\nUid:\t1000\t1000\t1000\t1000\nGid:\t1\n"), Some(1000));
        assert_eq!(parse_uid("Name:\tx\n"), None);
    }

    #[test]
    fn 只收同一個使用者_子孫在前根最後_早於根的不收() {
        let rows = [
            row(100, 1, 1000, 50, "wezterm-gui"),
            row(101, 100, 1000, 51, "bash"),
            row(102, 101, 1000, 52, "claude"),
            row(103, 100, 0, 51, "sudo"),        // 別的使用者
            row(104, 100, 1000, 10, "reused"),   // 開始時間早於根：編號被重用的別人
            row(200, 1, 1000, 40, "other"),      // 不在這棵樹
        ];
        let p = plan(&rows, 100, 1000, 999).unwrap();
        assert_eq!(p.last(), Some(&(100, 50)), "根最後");
        let pids: Vec<u32> = p.iter().map(|x| x.0).collect();
        assert!(pids.contains(&101) && pids.contains(&102));
        assert!(pids.iter().position(|&x| x == 102) < pids.iter().position(|&x| x == 101), "孫在子前面");
        for bad in [103, 104, 200] {
            assert!(!pids.contains(&bad), "{bad} 不能收");
        }
    }

    #[test]
    fn 絕不碰_0_1_自己_asn_本體() {
        let me = 555;
        let rows = [
            row(100, 1, 1000, 50, "wezterm-gui"),
            row(1, 0, 1000, 0, "init"),
            row(555, 100, 1000, 60, "x"),
            row(556, 100, 1000, 60, "asn"),
            row(557, 100, 1000, 60, "ok"),
        ];
        let pids: Vec<u32> = plan(&rows, 100, 1000, me).unwrap().iter().map(|x| x.0).collect();
        assert_eq!(pids, vec![557, 100]);
        for root in [0, 1, 555, 556] {
            assert!(plan(&rows, root, 1000, me).is_err(), "{root} 不能當根");
        }
    }

    #[test]
    fn 根要是_asn_開的終端_同一個使用者_還在() {
        let rows = [row(100, 1, 1000, 50, "wezterm-gui"), row(300, 1, 1000, 50, "firefox"), row(400, 1, 0, 50, "wezterm")];
        assert!(plan(&rows, 300, 1000, 9).is_err(), "不是 WezTerm");
        assert!(plan(&rows, 400, 1000, 9).is_err(), "別的使用者");
        assert!(plan(&rows, 777, 1000, 9).is_err(), "不在了");
        assert!(plan(&rows, 100, 1000, 9).is_ok());
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn linux_真的行程樹_先_term_不理的補_kill_不是終端的不動() {
        let d = tempfile::tempdir().unwrap();
        // 執行檔不是 WezTerm：規則 1 擋下，不動
        let mut other = std::process::Command::new("sh").args(["-c", "sleep 30"]).spawn().unwrap();
        std::thread::sleep(Duration::from_millis(200));
        assert!(!live::kill_tree(other.id()), "執行檔不是 WezTerm 就不結束");
        assert!(crate::heartbeat::pid_alive(other.id()));
        let _ = other.kill();
        let _ = other.wait();
        // 把 sh 複製成叫 wezterm 的執行檔當根：底下開一個不理 TERM 的子行程和一個普通的孫行程
        let fake = d.path().join("wezterm");
        std::fs::copy("/bin/sh", &fake).unwrap();
        let mut root = std::process::Command::new(&fake).args(["-c", "sh -c 'trap \"\" TERM; sleep 30' & sleep 30"]).spawn().unwrap();
        std::thread::sleep(Duration::from_millis(400));
        let pid = root.id();
        let kids: Vec<u32> = live::table().iter().filter(|r| r.ppid == pid).map(|r| r.pid).collect();
        assert!(!kids.is_empty(), "有子行程");
        let t = std::time::Instant::now();
        assert!(live::kill_tree(pid), "根收掉了");
        let _ = root.wait();
        assert!(t.elapsed() < GRACE + Duration::from_secs(2), "{:?}", t.elapsed());
        std::thread::sleep(Duration::from_millis(300));
        // 還在跑的（殭屍＝已經結束、只等收屍，不算）
        let running = |pid: u32| std::fs::read_to_string(format!("/proc/{pid}/stat")).ok().and_then(|s| s.rsplit_once(')').map(|x| x.1.trim_start().starts_with('Z'))).is_some_and(|z| !z);
        let left: Vec<u32> = kids.iter().copied().filter(|p| running(*p)).collect();
        assert!(left.is_empty(), "不理 TERM 的也被 KILL：{left:?}");
    }
}

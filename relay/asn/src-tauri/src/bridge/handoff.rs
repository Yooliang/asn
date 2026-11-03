//! 與舊 Node 橋共存與交接。
//! - 偵測：`bridge.pid` 記的 pid 活著、而且不是 ASN 自己 ＝ 這台的收發室由舊版收發室橋負責（內建橋不啟動）。
//! - 接手（使用者按「改由 ASN 負責」才做，要確認，且受設定開關 allow_takeover 保護、預設關）：
//!   1. 停用工作排程 `AsnBridge-<節點>` 與舊名 `IroriRelayMachine-<節點>`（兩種都處理、只停用不刪除；Windows 才有；不存在的視為完成）。
//!   2. 只結束 `bridge.pid` 與 `mailbox.pid` 兩個檔案記的 PID（不用名稱比對、不整批結束、不連同子程序一起殺）。
//!   3. 等舊橋的 pid 消失，之後才由內建橋拿鎖。
//!   任何一步失敗就停手並回報，不繼續下一步。
use crate::nowin::NoWindow;
use std::path::Path;

/// 工作排程名：新名 `AsnBridge-<節點>`；舊安裝留下的 `IroriRelayMachine-<節點>` 仍要處理（D10 相容）
pub fn task_name(node: &str) -> String {
    format!("AsnBridge-{node}")
}

pub fn legacy_task_name(node: &str) -> String {
    format!("IroriRelayMachine-{node}")
}

#[derive(Debug, PartialEq, Clone)]
pub enum Legacy {
    /// 沒有別的收信者
    None,
    /// 舊橋（或別的行程）活著
    Running { bridge_pid: u32, mailbox_pid: Option<u32> },
}

pub fn legacy_status(work_dir: &Path, my_pid: u32, alive: impl Fn(u32) -> bool) -> Legacy {
    match super::lock::foreign_holder(work_dir, my_pid, &alive) {
        None => Legacy::None,
        Some(b) => Legacy::Running { bridge_pid: b, mailbox_pid: super::lock::read_pid(&super::lock::mailbox_pid_file(work_dir)).filter(|p| alive(*p)) },
    }
}

/// 對外部世界做事的介面（測試換成假的，不會真的殺程序或動排程）
pub trait Exec {
    /// 結束前的核對：這個編號真的是記錄檔的主人（見 lock::Holder::may_kill）
    fn may_kill(&self, work_dir: &Path, pid: u32) -> bool;
    fn kill_pid(&self, pid: u32) -> Result<(), String>;
    fn disable_task(&self, name: &str) -> Result<(), String>;
}

pub struct SystemExec;
impl Exec for SystemExec {
    fn may_kill(&self, work_dir: &Path, pid: u32) -> bool {
        super::lock::may_kill_holder(work_dir, pid)
    }
    fn kill_pid(&self, pid: u32) -> Result<(), String> {
        kill_pid(pid)
    }
    fn disable_task(&self, name: &str) -> Result<(), String> {
        disable_task(name)
    }
}

/// 結束單一 PID（不含子程序）。Windows 用 taskkill /PID，其他系統用 kill
pub fn kill_pid(pid: u32) -> Result<(), String> {
    if pid == 0 {
        return Err("pid 不合法".into());
    }
    #[cfg(windows)]
    let st = std::process::Command::new("taskkill").no_window().args(["/PID", &pid.to_string(), "/F"]).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null()).status();
    #[cfg(not(windows))]
    let st = std::process::Command::new("kill").no_window().args(["-TERM", &pid.to_string()]).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null()).status();
    match st {
        Ok(s) if s.success() => Ok(()),
        Ok(_) => Err(format!("結束不了 pid {pid}")),
        Err(e) => Err(format!("結束不了 pid {pid}：{e}")),
    }
}

/// schtasks 的輸出（原始位元組）是不是在說「找不到這個排程」。
/// 繁中 Windows 輸出 Big5（「系統找不到指定的檔案」），其他語言常是 UTF-8 或英文，所以直接在位元組上找，不先解碼。
pub(crate) fn schtasks_not_found(raw: &[u8]) -> bool {
    const UTF8: &[u8] = "找不到".as_bytes();
    const BIG5: &[u8] = &[0xA7, 0xE4, 0xA4, 0xA3, 0xA8, 0xEC]; // 「找不到」的 Big5（CP950）
    let has = |needle: &[u8]| raw.windows(needle.len()).any(|w| w == needle);
    let en = String::from_utf8_lossy(raw).to_lowercase();
    has(UTF8) || has(BIG5) || en.contains("cannot find") || en.contains("does not exist")
}

/// 停用失敗後，排程算不算「本來就不存在」：/Change 的輸出說找不到，或 /Query 失敗而且它的輸出也說找不到。
/// /Query 結束碼非 0 不夠：權限不足等也會是非 0，那時排程其實在，不能當成不存在。
/// `query`＝/Query 的（是否成功, 原始輸出）；沒跑成（None）只看 /Change 的文字
pub(crate) fn task_gone(change_output: &[u8], query: Option<(bool, &[u8])>) -> bool {
    schtasks_not_found(change_output) || matches!(query, Some((false, out)) if schtasks_not_found(out))
}

/// 停用工作排程（只停用）。非 Windows 沒有這個排程，視為完成
pub fn disable_task(name: &str) -> Result<(), String> {
    #[cfg(windows)]
    {
        let out = std::process::Command::new("schtasks").no_window().args(["/Change", "/TN", name, "/DISABLE"]).output().map_err(|e| format!("停用不了工作排程 {name}：{e}"))?;
        if out.status.success() {
            return Ok(());
        }
        // 排程根本不存在＝沒有東西要停用（不當錯誤）。不能只靠文字：繁中 Windows 的輸出是 Big5，當 UTF-8 解會永遠比不到「找不到」。
        // 文字比對（原始位元組）對不上時，再問一次 /Query：查得到＝排程在，只是停用不了；查不到＝不存在
        let mut raw = out.stderr.clone();
        raw.extend_from_slice(&out.stdout);
        let query = std::process::Command::new("schtasks").no_window().args(["/Query", "/TN", name]).output().ok().map(|o| {
            let mut q = o.stderr.clone();
            q.extend_from_slice(&o.stdout);
            (o.status.success(), q)
        });
        if task_gone(&raw, query.as_ref().map(|(ok, q)| (*ok, q.as_slice()))) {
            return Ok(());
        }
        // 停用失敗、/Query 也沒說找不到（權限不足等）：照原本的失敗回，並留一行 log 方便查
        elog!("停用工作排程 {name} 失敗：/Change 結束碼 {:?}，/Query {}", out.status.code(), match &query {
            Some((ok, _)) => format!("{}", if *ok { "查得到（排程在）" } else { "失敗但輸出不是找不到" }),
            None => "沒跑成".to_string(),
        });
        Err(format!("停用不了工作排程 {name}"))
    }
    #[cfg(not(windows))]
    {
        let _ = name;
        Ok(())
    }
}

#[derive(Debug, PartialEq)]
pub enum TakeoverError {
    NotAllowed,
    NotConfirmed,
    NothingToDo,
    Failed(String),
}
impl TakeoverError {
    pub fn text(&self) -> String {
        match self {
            TakeoverError::NotAllowed => "這個功能目前還沒開放（設定檔 bridge.json 的 allow_takeover 是關的）".into(),
            TakeoverError::NotConfirmed => "需要使用者確認才能停掉舊版收發信小程式".into(),
            TakeoverError::NothingToDo => "目前沒有舊版收發信小程式在跑".into(),
            TakeoverError::Failed(m) => m.clone(),
        }
    }
}

/// 接手舊橋。回傳實際停掉的 PID 清單（給畫面與 log）。
/// 順序：停用排程 → 結束 mailbox.pid 的收發室 worker → 結束 bridge.pid 的橋。
/// （先收發室 worker 再橋：橋被殺時不會留下沒人管的 worker。）
pub fn takeover(work_dir: &Path, node: &str, my_pid: u32, alive: impl Fn(u32) -> bool, exec: &dyn Exec, allowed: bool, confirmed: bool) -> Result<Vec<u32>, TakeoverError> {
    if !allowed {
        return Err(TakeoverError::NotAllowed);
    }
    if !confirmed {
        return Err(TakeoverError::NotConfirmed);
    }
    let Legacy::Running { bridge_pid, mailbox_pid } = legacy_status(work_dir, my_pid, &alive) else { return Err(TakeoverError::NothingToDo) };
    // 什麼都還沒動之前先核對：編號可能已經被無關的程序用走，確認不了就不動手
    if !exec.may_kill(work_dir, bridge_pid) {
        return Err(TakeoverError::Failed(format!("無法確認程序 {bridge_pid} 是舊版收發信小程式，沒有結束任何程序")));
    }
    exec.disable_task(&task_name(node)).map_err(TakeoverError::Failed)?;
    exec.disable_task(&legacy_task_name(node)).map_err(TakeoverError::Failed)?;
    let mut stopped = vec![];
    if let Some(m) = mailbox_pid {
        // worker 確認不了就跳過：它不是擋住接手的那一個，不能為了它結束無關的程序
        if m != my_pid && exec.may_kill(work_dir, m) {
            exec.kill_pid(m).map_err(TakeoverError::Failed)?;
            stopped.push(m);
        }
    }
    exec.kill_pid(bridge_pid).map_err(TakeoverError::Failed)?;
    stopped.push(bridge_pid);
    Ok(stopped)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;
    #[test]
    fn schtasks_找不到_big5_utf8_英文都認_別的錯誤不認() {
        // 繁中 Windows 的 schtasks 輸出：「錯誤: 系統找不到指定的檔案。」（Big5 位元組）
        let big5: &[u8] = &[0xBF, 0xF9, 0xB3, 0x6F, 0x3A, 0x20, 0xA8, 0x74, 0xB2, 0xCE, 0xA7, 0xE4, 0xA4, 0xA3, 0xA8, 0xEC, 0xAB, 0xFC, 0xA9, 0x77, 0xAA, 0xBA, 0xC0, 0xC9, 0xAE, 0xD7, 0xA1, 0x43];
        assert!(!String::from_utf8_lossy(big5).contains("找不到"), "當 UTF-8 解會壞掉（舊寫法就是這樣永遠比不到）");
        assert!(schtasks_not_found(big5));
        assert!(schtasks_not_found("錯誤: 系統找不到指定的檔案。".as_bytes()));
        assert!(schtasks_not_found(b"ERROR: The system cannot find the file specified."));
        assert!(!schtasks_not_found("錯誤: 存取被拒。".as_bytes()));
        assert!(!schtasks_not_found(&[0xBF, 0xF9, 0xB3, 0x6F, 0x3A, 0x20, 0xA6, 0x73, 0xA8, 0xFA]), "別的 Big5 訊息不算");
    }

    #[test]
    fn 停用失敗後_排程是不是本來就不存在() {
        let big5: &[u8] = &[0xA8, 0x74, 0xB2, 0xCE, 0xA7, 0xE4, 0xA4, 0xA3, 0xA8, 0xEC];
        let denied = "錯誤: 存取被拒。".as_bytes();
        assert!(task_gone(big5, None), "文字說找不到，/Query 沒跑成也算");
        assert!(task_gone(b"", Some((false, big5))), "/Query 失敗而且輸出也說找不到（Big5）＝不存在");
        assert!(task_gone(b"", Some((false, "ERROR: The system cannot find the file specified.".as_bytes()))));
        assert!(task_gone(b"", Some((false, "錯誤: 系統找不到指定的檔案。".as_bytes()))));
        assert!(!task_gone(b"", Some((false, denied))), "/Query 失敗但是權限不足：排程可能在，不能當成不存在");
        assert!(!task_gone(b"", Some((false, b""))), "/Query 失敗、沒有輸出：不確定，不當成不存在");
        assert!(!task_gone(b"", Some((true, b""))), "查得到：排程在，只是停用不了");
        assert!(!task_gone(b"", None), "什麼都不確定：不當成不存在");
    }


    #[derive(Default)]
    struct Fake {
        calls: RefCell<Vec<String>>,
        fail_kill: Option<u32>,
        /// 核對不過的編號
        refuse: Vec<u32>,
    }
    impl Exec for Fake {
        fn may_kill(&self, _work_dir: &Path, pid: u32) -> bool {
            !self.refuse.contains(&pid)
        }
        fn kill_pid(&self, pid: u32) -> Result<(), String> {
            self.calls.borrow_mut().push(format!("kill {pid}"));
            if self.fail_kill == Some(pid) { Err("拒絕存取".into()) } else { Ok(()) }
        }
        fn disable_task(&self, name: &str) -> Result<(), String> {
            self.calls.borrow_mut().push(format!("disable {name}"));
            Ok(())
        }
    }

    fn setup(bridge: &str, mailbox: Option<&str>) -> tempfile::TempDir {
        let d = tempfile::tempdir().unwrap();
        std::fs::write(super::super::lock::pid_file(d.path()), bridge).unwrap();
        if let Some(m) = mailbox {
            std::fs::write(super::super::lock::mailbox_pid_file(d.path()), m).unwrap();
        }
        d
    }

    #[test]
    fn 偵測舊橋_只認活著的_不是自己的() {
        let d = setup("100", Some("101"));
        assert_eq!(legacy_status(d.path(), 7, |_| true), Legacy::Running { bridge_pid: 100, mailbox_pid: Some(101) });
        assert_eq!(legacy_status(d.path(), 7, |p| p == 100), Legacy::Running { bridge_pid: 100, mailbox_pid: None });
        assert_eq!(legacy_status(d.path(), 7, |_| false), Legacy::None);
        assert_eq!(legacy_status(d.path(), 100, |_| true), Legacy::None, "是自己的 pid 就不算舊橋");
    }

    #[test]
    fn 接手_開關關著或沒確認_什麼都不做() {
        let d = setup("100", Some("101"));
        let f = Fake::default();
        assert_eq!(takeover(d.path(), "H", 7, |_| true, &f, false, true), Err(TakeoverError::NotAllowed));
        assert_eq!(takeover(d.path(), "H", 7, |_| true, &f, true, false), Err(TakeoverError::NotConfirmed));
        assert!(f.calls.borrow().is_empty(), "沒放行、沒確認時不得動任何程序或排程");
        let g = Fake::default();
        let none = setup("100", None);
        assert_eq!(takeover(none.path(), "H", 7, |_| false, &g, true, true), Err(TakeoverError::NothingToDo));
        assert!(g.calls.borrow().is_empty());
    }

    #[test]
    fn 接手_新舊兩個排程名都停用_只殺兩個記下的_pid_先收發室後橋() {
        let d = setup("100", Some("101"));
        let f = Fake::default();
        let stopped = takeover(d.path(), "H", 7, |_| true, &f, true, true).unwrap();
        assert_eq!(stopped, vec![101, 100]);
        assert_eq!(*f.calls.borrow(), vec!["disable AsnBridge-H", "disable IroriRelayMachine-H", "kill 101", "kill 100"]);
    }

    #[test]
    fn 接手_橋的編號核對不過_什麼都不動() {
        let d = setup("100", Some("101"));
        let f = Fake { refuse: vec![100], ..Default::default() };
        let e = takeover(d.path(), "H", 7, |_| true, &f, true, true).unwrap_err();
        assert!(matches!(e, TakeoverError::Failed(ref m) if m.contains("沒有結束任何程序")), "{e:?}");
        assert!(f.calls.borrow().is_empty(), "排程不動、程序不殺：{:?}", f.calls.borrow());
    }

    #[test]
    fn 接手_worker_的編號核對不過_只跳過它() {
        let d = setup("100", Some("101"));
        let f = Fake { refuse: vec![101], ..Default::default() };
        assert_eq!(takeover(d.path(), "H", 7, |_| true, &f, true, true).unwrap(), vec![100]);
        assert!(!f.calls.borrow().iter().any(|c| c == "kill 101"), "{:?}", f.calls.borrow());
    }

    #[test]
    fn 接手_任何一步失敗就停手() {
        let d = setup("100", Some("101"));
        let f = Fake { fail_kill: Some(101), ..Default::default() };
        let e = takeover(d.path(), "H", 7, |_| true, &f, true, true).unwrap_err();
        assert_eq!(e, TakeoverError::Failed("拒絕存取".into()));
        assert_eq!(*f.calls.borrow(), vec!["disable AsnBridge-H", "disable IroriRelayMachine-H", "kill 101"], "收發室 worker 殺不掉就不去動橋");
    }

    #[test]
    fn 沒有收發室_pid_只殺橋() {
        let d = setup("100", None);
        let f = Fake::default();
        assert_eq!(takeover(d.path(), "w02", 7, |_| true, &f, true, true).unwrap(), vec![100]);
        assert_eq!(*f.calls.borrow(), vec!["disable AsnBridge-w02", "disable IroriRelayMachine-w02", "kill 100"]);
    }

    #[test]
    fn 殺_pid_不接受_0() {
        assert!(kill_pid(0).is_err());
    }
}

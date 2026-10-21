//! 與舊 Node 橋共存與交接。
//! - 偵測：`bridge.pid` 記的 pid 活著、而且不是 ASN 自己 ＝ 這台的收發室由舊版收發室橋負責（內建橋不啟動）。
//! - 接手（使用者按「改由 ASN 負責」才做，要確認，且受設定開關 allow_takeover 保護、預設關）：
//!   1. 停用工作排程 `IroriRelayMachine-<節點>`（只停用，不刪除；Windows 才有）。
//!   2. 只結束 `bridge.pid` 與 `mailbox.pid` 兩個檔案記的 PID（不用名稱比對、不整批結束、不連同子程序一起殺）。
//!   3. 等舊橋的 pid 消失，之後才由內建橋拿鎖。
//!   任何一步失敗就停手並回報，不繼續下一步。
use crate::nowin::NoWindow;
use std::path::Path;

pub fn task_name(node: &str) -> String {
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
    fn kill_pid(&self, pid: u32) -> Result<(), String>;
    fn disable_task(&self, name: &str) -> Result<(), String>;
}

pub struct SystemExec;
impl Exec for SystemExec {
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

/// 停用工作排程（只停用）。非 Windows 沒有這個排程，視為完成
pub fn disable_task(name: &str) -> Result<(), String> {
    #[cfg(windows)]
    {
        let out = std::process::Command::new("schtasks").no_window().args(["/Change", "/TN", name, "/DISABLE"]).output().map_err(|e| format!("停用不了工作排程 {name}：{e}"))?;
        if out.status.success() {
            return Ok(());
        }
        // 排程根本不存在＝沒有東西要停用（不當錯誤）
        let text = String::from_utf8_lossy(&out.stderr).to_string() + &String::from_utf8_lossy(&out.stdout);
        if text.contains("找不到") || text.to_lowercase().contains("cannot find") || text.to_lowercase().contains("does not exist") {
            return Ok(());
        }
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
            TakeoverError::NotConfirmed => "需要使用者確認才能停掉舊版收發室橋".into(),
            TakeoverError::NothingToDo => "目前沒有舊版收發室橋在跑".into(),
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
    exec.disable_task(&task_name(node)).map_err(TakeoverError::Failed)?;
    let mut stopped = vec![];
    if let Some(m) = mailbox_pid {
        if m != my_pid {
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

    #[derive(Default)]
    struct Fake {
        calls: RefCell<Vec<String>>,
        fail_kill: Option<u32>,
    }
    impl Exec for Fake {
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
    fn 接手_只停用排程_只殺兩個記下的_pid_先收發室後橋() {
        let d = setup("100", Some("101"));
        let f = Fake::default();
        let stopped = takeover(d.path(), "H", 7, |_| true, &f, true, true).unwrap();
        assert_eq!(stopped, vec![101, 100]);
        assert_eq!(*f.calls.borrow(), vec!["disable IroriRelayMachine-H", "kill 101", "kill 100"]);
    }

    #[test]
    fn 接手_任何一步失敗就停手() {
        let d = setup("100", Some("101"));
        let f = Fake { fail_kill: Some(101), ..Default::default() };
        let e = takeover(d.path(), "H", 7, |_| true, &f, true, true).unwrap_err();
        assert_eq!(e, TakeoverError::Failed("拒絕存取".into()));
        assert_eq!(*f.calls.borrow(), vec!["disable IroriRelayMachine-H", "kill 101"], "收發室 worker 殺不掉就不去動橋");
    }

    #[test]
    fn 沒有收發室_pid_只殺橋() {
        let d = setup("100", None);
        let f = Fake::default();
        assert_eq!(takeover(d.path(), "w02", 7, |_| true, &f, true, true).unwrap(), vec![100]);
        assert_eq!(*f.calls.borrow(), vec!["disable IroriRelayMachine-w02", "kill 100"]);
    }

    #[test]
    fn 殺_pid_不接受_0() {
        assert!(kill_pid(0).is_err());
    }
}

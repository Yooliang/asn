//! 工作管理員的「重啟終端服務」（#1860 F PR3）。
//!
//! 順序：抓名單（重啟前終端服務裡的夥伴）→ 停服務 → 起新的 → 把名單交給接回（原因寫「重啟」、不計十分鐘冷卻）。
//! 停不掉就不起新的（舊的還活著，再起只會多一個）；起不來就回錯，不接回。
//! 重啟中用一個記號讓清單回報「正在重啟」，完成或失敗（含中途當掉）都會清掉。
#![cfg(desktop)]

use std::sync::atomic::{AtomicBool, Ordering};

/// 給畫面的白話字；原始錯誤只寫 mux.log／ui.log
pub const FAIL_TEXT: &str = "重啟沒有成功，請稍後再試。";
pub const NO_MUX_TEXT: &str = "這台沒有終端服務。";
pub const BUSY_TEXT: &str = "正在重啟中，請稍候。";

static RESTARTING: AtomicBool = AtomicBool::new(false);

/// 現在是不是正在重啟終端服務（清單回報給畫面）
pub fn is_restarting() -> bool {
    RESTARTING.load(Ordering::SeqCst)
}

/// 重啟中的記號：拿到才能重啟（同時只有一條），drop 時一定清掉（不論成功、失敗或 panic）
pub struct Restarting(());

impl Restarting {
    pub fn begin() -> Option<Restarting> {
        RESTARTING.compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst).ok().map(|_| Restarting(()))
    }
}

impl Drop for Restarting {
    fn drop(&mut self) {
        RESTARTING.store(false, Ordering::SeqCst);
    }
}

#[derive(Debug, PartialEq)]
pub enum RestartError {
    /// 這台沒有終端服務（Linux、沒開終端服務模式）
    NoMux,
    /// 失敗：原始原因（只寫 log）
    Failed(String),
}

impl RestartError {
    /// 給畫面的白話字
    pub fn text(&self) -> &'static str {
        match self {
            RestartError::NoMux => NO_MUX_TEXT,
            RestartError::Failed(_) => FAIL_TEXT,
        }
    }
}

/// 重啟的步驟（純流程，動作由呼叫端傳進來，好測）。
/// - `has_mux`：這台有沒有終端服務；沒有就什麼都不做
/// - `snapshot`：重啟前的夥伴名單
/// - `stop`：停服務；失敗就回錯，**不**起新的
/// - `ensure`：起新的；失敗就回錯，不接回
/// - `resume`：把名單交給接回（原因「重啟」、不計冷卻）
/// - `note`：寫 mux.log 的一行
pub fn run_steps(has_mux: bool, snapshot: impl FnOnce() -> Vec<String>, stop: impl FnOnce() -> Result<(), String>, ensure: impl FnOnce() -> Result<(), String>, resume: impl FnOnce(Vec<String>), note: &dyn Fn(&str)) -> Result<(), RestartError> {
    if !has_mux {
        return Err(RestartError::NoMux);
    }
    let names = snapshot();
    note(&format!("工作管理員重啟終端服務：重啟前有 {} 位夥伴", names.len()));
    if let Err(e) = stop() {
        note(&format!("工作管理員重啟終端服務：停不掉，不起新的：{e}"));
        return Err(RestartError::Failed(e));
    }
    if let Err(e) = ensure() {
        note(&format!("工作管理員重啟終端服務：新的起不來：{e}"));
        return Err(RestartError::Failed(e));
    }
    note("工作管理員重啟終端服務：新的已起來，接回夥伴");
    resume(names);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    fn flow(has_mux: bool, stop: Result<(), String>, ensure: Result<(), String>) -> (Result<(), RestartError>, Vec<String>) {
        let calls = RefCell::new(Vec::<String>::new());
        let r = run_steps(
            has_mux,
            || {
                calls.borrow_mut().push("名單".into());
                vec!["甲".into(), "乙".into()]
            },
            || {
                calls.borrow_mut().push("停".into());
                stop
            },
            || {
                calls.borrow_mut().push("起".into());
                ensure
            },
            |n| calls.borrow_mut().push(format!("接回{}", n.join("、"))),
            &|_| {},
        );
        (r, calls.into_inner())
    }

    #[test]
    fn _1860f_順序是抓名單_停_起_接回() {
        let (r, calls) = flow(true, Ok(()), Ok(()));
        assert!(r.is_ok());
        assert_eq!(calls, ["名單", "停", "起", "接回甲、乙"]);
    }

    #[test]
    fn _1860f_停不掉就不起新的也不接回() {
        let (r, calls) = flow(true, Err("沒有結束".into()), Ok(()));
        assert_eq!(r, Err(RestartError::Failed("沒有結束".into())));
        assert_eq!(calls, ["名單", "停"], "停失敗不能再起（舊的還活著）");
    }

    #[test]
    fn _1860f_起不來回錯_不接回() {
        let (r, calls) = flow(true, Ok(()), Err("連不上".into()));
        assert_eq!(r.as_ref().unwrap_err().text(), FAIL_TEXT, "畫面講白話");
        assert!(matches!(r, Err(RestartError::Failed(ref e)) if e == "連不上"), "原文留給 log");
        assert_eq!(calls, ["名單", "停", "起"]);
    }

    #[test]
    fn _1860f_沒有終端服務回白話_什麼都不做() {
        let (r, calls) = flow(false, Ok(()), Ok(()));
        assert_eq!(r, Err(RestartError::NoMux));
        assert_eq!(r.unwrap_err().text(), "這台沒有終端服務。");
        assert!(calls.is_empty());
    }

    #[test]
    fn _1860f_重啟中記號_同時只有一條_放掉就清() {
        let a = Restarting::begin().expect("第一條拿得到");
        assert!(is_restarting());
        assert!(Restarting::begin().is_none(), "重啟中不能再開第二條");
        drop(a);
        assert!(!is_restarting(), "放掉（含失敗）一定清掉");
        drop(Restarting::begin().expect("清掉後可再重啟"));
    }
}

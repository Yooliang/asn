//! 工作管理員的「重啟終端服務」與「重啟 ASN」（#1860 F PR3）。
//!
//! 順序：抓名單（重啟前終端服務裡的夥伴）→ 停服務 → 起新的 → 把名單交給接回（原因寫「重啟」、不計十分鐘冷卻）。
//! 停不掉就不起新的（舊的還活著，再起只會多一個）；起不來就回錯、不接回，但名單存起來，讓使用者重按時還接得回。
//! 名單讀不到（不是「沒有夥伴」）就回錯、不停服務：空名單「成功」會讓代理全被殺又沒人接回。
//! 重啟中用一個共用記號：兩種重啟（ASN、終端服務）互斥、各自防重入；完成或失敗（含中途當掉）都會清掉。
#![cfg(desktop)]

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

/// 給畫面的白話字；原始錯誤只寫 mux.log／ui.log
pub const FAIL_TEXT: &str = "重啟沒有成功，請稍後再試。";
pub const NO_MUX_TEXT: &str = "這台沒有終端服務。";
pub const BUSY_TEXT: &str = "正在重啟中，請稍候。";

/// 停服務時「根本沒有服務在跑」的錯誤字樣（`Mux::stop` 與這裡共用）：重啟視為可以繼續，直接起新的
pub const STOP_NOT_RUNNING: &str = "沒有 ASN 起的終端服務在跑";

/// 重啟 ASN 成功後，記號最多扣到這麼久（正常早就結束了；一直沒結束才放掉，免得之後都按不動）
pub const ASN_EXIT_GRACE: std::time::Duration = std::time::Duration::from_secs(60);

/// 兩種重啟共用的忙碌記號：同時只有一條
static BUSY: AtomicBool = AtomicBool::new(false);
/// 忙碌的是不是「重啟終端服務」（清單回報給畫面；重啟 ASN 時整個程式都要換掉，不用回報）
static MUX_KIND: AtomicBool = AtomicBool::new(false);

/// 現在是不是正在重啟終端服務（清單回報給畫面）
pub fn is_restarting() -> bool {
    BUSY.load(Ordering::SeqCst) && MUX_KIND.load(Ordering::SeqCst)
}

/// 重啟中的記號：拿到才能重啟（同時只有一條），drop 時一定清掉（不論成功、失敗或 panic）
pub struct Restarting(());

impl Restarting {
    fn take(mux: bool) -> Option<Restarting> {
        BUSY.compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst).ok().map(|_| {
            MUX_KIND.store(mux, Ordering::SeqCst);
            Restarting(())
        })
    }

    /// 重啟終端服務
    pub fn begin() -> Option<Restarting> {
        Self::take(true)
    }

    /// 重啟 ASN：和重啟終端服務互斥（在服務停了、新的還沒起之間重啟 ASN，會留下沒服務也沒名單的狀態）
    pub fn begin_asn() -> Option<Restarting> {
        Self::take(false)
    }
}

impl Drop for Restarting {
    fn drop(&mut self) {
        MUX_KIND.store(false, Ordering::SeqCst);
        BUSY.store(false, Ordering::SeqCst);
    }
}

/// 起新服務失敗時存下來的夥伴名單：重按時合併進名單，起得來就接回。只放記憶體（ASN 重開後 known-windows 會接回）
pub struct Stash(Mutex<Vec<String>>);

impl Stash {
    pub const fn new() -> Stash {
        Stash(Mutex::new(Vec::new()))
    }
    pub fn get(&self) -> Vec<String> {
        self.0.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }
    pub fn set(&self, names: Vec<String>) {
        *self.0.lock().unwrap_or_else(|e| e.into_inner()) = names;
    }
}

/// 上一次起新服務失敗時的名單
pub static STASH: Stash = Stash::new();

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

/// 兩份名單合併、同名只留一位（先出現的在前）
fn merge(first: Vec<String>, second: Vec<String>) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for n in first.into_iter().chain(second) {
        if !out.contains(&n) {
            out.push(n);
        }
    }
    out
}

/// 重啟的步驟（純流程，動作由呼叫端傳進來，好測）。
/// - `has_mux`：這台有沒有終端服務；沒有就什麼都不做
/// - `stash`：上次起不來時存下的名單；本次成功起來才清掉
/// - `snapshot`：重啟前的夥伴名單；`None`＝讀不到（不是沒有夥伴），回錯、不停服務
/// - `stop`：停服務；失敗就回錯，**不**起新的（「沒有服務在跑」由呼叫端當成功傳回 Ok）
/// - `ensure`：起新的；失敗就回錯、不接回，名單存進 `stash`
/// - `resume`：把名單交給接回（原因「重啟」、不計冷卻）
/// - `note`：寫 mux.log 的一行
pub fn run_steps(
    has_mux: bool,
    stash: &Stash,
    snapshot: impl FnOnce() -> Option<Vec<String>>,
    stop: impl FnOnce() -> Result<(), String>,
    ensure: impl FnOnce() -> Result<(), String>,
    resume: impl FnOnce(Vec<String>),
    note: &dyn Fn(&str),
) -> Result<(), RestartError> {
    if !has_mux {
        return Err(RestartError::NoMux);
    }
    let Some(now_names) = snapshot() else {
        let e = "讀不到終端服務裡的夥伴名單，不重啟（免得停掉後沒有名單可接回）".to_string();
        note(&format!("工作管理員重啟終端服務：{e}"));
        return Err(RestartError::Failed(e));
    };
    let names = merge(stash.get(), now_names);
    note(&format!("工作管理員重啟終端服務：重啟前有 {} 位夥伴", names.len()));
    if let Err(e) = stop() {
        note(&format!("工作管理員重啟終端服務：停不掉，不起新的：{e}"));
        return Err(RestartError::Failed(e));
    }
    if let Err(e) = ensure() {
        stash.set(names);
        note(&format!("工作管理員重啟終端服務：新的起不來：{e}"));
        return Err(RestartError::Failed(e));
    }
    stash.set(Vec::new());
    note("工作管理員重啟終端服務：新的已起來，接回夥伴");
    resume(names);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    fn flow_with(stash: &Stash, snap: Option<Vec<String>>, stop: Result<(), String>, ensure: Result<(), String>) -> (Result<(), RestartError>, Vec<String>) {
        let calls = RefCell::new(Vec::<String>::new());
        let r = run_steps(
            true,
            stash,
            || {
                calls.borrow_mut().push("名單".into());
                snap
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

    fn two() -> Option<Vec<String>> {
        Some(vec!["甲".into(), "乙".into()])
    }

    fn flow(has_mux: bool, stop: Result<(), String>, ensure: Result<(), String>) -> (Result<(), RestartError>, Vec<String>) {
        if !has_mux {
            let r = run_steps(false, &Stash::new(), || panic!("不該抓名單"), || panic!("不該停"), || panic!("不該起"), |_| panic!("不該接回"), &|_| {});
            return (r, Vec::new());
        }
        flow_with(&Stash::new(), two(), stop, ensure)
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

    /// 審查 #1：起不來之後名單不能丟。第二次按（這時服務已經沒了、名單被監看清空）要能起來並接回原本那兩位
    #[test]
    fn _1860f_起不來後重按_用存下的名單接回() {
        let stash = Stash::new();
        let (r1, _) = flow_with(&stash, two(), Ok(()), Err("連不上".into()));
        assert!(r1.is_err());
        assert_eq!(stash.get(), ["甲", "乙"], "失敗要把名單存起來");
        // 重按：服務已經不在（stop 由呼叫端當成功）、對照表已被清空
        let (r2, calls) = flow_with(&stash, Some(Vec::new()), Ok(()), Ok(()));
        assert!(r2.is_ok());
        assert_eq!(calls, ["名單", "停", "起", "接回甲、乙"], "用存下的名單接回");
        assert!(stash.get().is_empty(), "接回之後清掉，不重複接回");
    }

    #[test]
    fn _1860f_重按時存下的名單與現有名單合併_同名只一位() {
        let stash = Stash::new();
        stash.set(vec!["甲".into(), "丙".into()]);
        let (r, calls) = flow_with(&stash, two(), Ok(()), Ok(()));
        assert!(r.is_ok());
        assert_eq!(calls.last().unwrap(), "接回甲、丙、乙");
    }

    /// 審查 #2：名單讀不到（None）不是「沒有夥伴」：不停、不起、不接回，回錯
    #[test]
    fn _1860f_名單讀不到就回錯_不停服務() {
        let stash = Stash::new();
        let (r, calls) = flow_with(&stash, None, Ok(()), Ok(()));
        assert!(matches!(r, Err(RestartError::Failed(_))));
        assert_eq!(r.unwrap_err().text(), FAIL_TEXT);
        assert_eq!(calls, ["名單"], "讀不到名單就不能動服務");
    }

    /// 審查 #3：兩種重啟共用一個記號，互斥、各自防重入、放掉就清
    #[test]
    fn _1860f_重啟記號_兩種互斥_各自防重入_放掉就清() {
        let _g = TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let a = Restarting::begin().expect("第一條拿得到");
        assert!(is_restarting());
        assert!(Restarting::begin().is_none(), "重啟終端服務中不能再開第二條");
        assert!(Restarting::begin_asn().is_none(), "重啟終端服務中不能重啟 ASN");
        drop(a);
        assert!(!is_restarting(), "放掉（含失敗）一定清掉");
        let b = Restarting::begin_asn().expect("清掉後可重啟 ASN");
        assert!(!is_restarting(), "重啟 ASN 不回報成「重啟終端服務中」");
        assert!(Restarting::begin_asn().is_none(), "重啟 ASN 防重入");
        assert!(Restarting::begin().is_none(), "重啟 ASN 中不能重啟終端服務");
        drop(b);
        drop(Restarting::begin().expect("清掉後可再重啟"));
    }

    /// 指令真的有拿記號（防重入／互斥靠它）：兩個指令都要在動手前拿，重啟 ASN 失敗要讓記號隨函式放掉
    #[test]
    fn _1860f_兩個指令動手前都先拿記號() {
        let lib = include_str!("../lib.rs");
        let asn = lib.split("async fn task_manager_restart_asn").nth(1).unwrap().split("async fn ").next().unwrap();
        let (take, go) = (asn.find("Restarting::begin_asn()").expect("重啟 ASN 要拿記號"), asn.find("relaunch_and_exit(").unwrap());
        assert!(take < go, "要先拿記號才能重啟");
        assert!(asn.contains("BUSY_TEXT"), "拿不到回白話字");
        let mux = lib.split("async fn task_manager_restart_mux").nth(1).unwrap().split("async fn ").next().unwrap();
        assert!(mux.contains("Restarting::begin()") && mux.contains("BUSY_TEXT"));
    }

    // 記號是全域的：測試同一時間只跑一條
    static TEST_LOCK: Mutex<()> = Mutex::new(());
}

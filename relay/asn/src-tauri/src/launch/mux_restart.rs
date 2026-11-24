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

/// 上次重啟終端服務有沒有失敗（起不來、代理斷線）：真才在工作管理員列「沒有在運行」的佔位；下次重啟成功時清掉。只放記憶體
static LAST_FAILED: AtomicBool = AtomicBool::new(false);

pub fn last_failed() -> bool {
    LAST_FAILED.load(Ordering::SeqCst)
}

pub fn set_last_failed(failed: bool) {
    LAST_FAILED.store(failed, Ordering::SeqCst);
}

/// 工作管理員要不要在清單沒有終端服務時列「沒有在運行」的佔位（讓本人有地方再按重啟）：
/// 用終端服務，而且確實有東西等著接回（存下的名單有人）或上次重啟失敗。
/// 只是用終端服務、最後一位夥伴關掉後服務被正常收掉，不算：那是正常狀態，不能永遠掛著佔位和重啟鈕
pub fn placeholder_wanted(use_mux: bool, pending: usize, last_failed: bool) -> bool {
    use_mux && (pending > 0 || last_failed)
}

/// 還有幾位代理沒接回（存下的名單長度）：工作管理員重啟 ASN 前要告訴本人，因為名單只在記憶體，ASN 重啟就沒了
pub fn pending_count() -> usize {
    pending_of(&STASH)
}

fn pending_of(stash: &Stash) -> usize {
    stash.get().len()
}

#[derive(Debug, PartialEq)]
pub enum RestartError {
    /// 這台沒有終端服務（Linux、沒開終端服務模式）
    NoMux,
    /// 失敗：原始原因（只寫 log）
    Failed(String),
    /// 終端服務裡有 ASN 沒有記錄的視窗（數字是多出幾個）：重啟會把它們一起關掉又接不回，所以不重啟
    Unmanaged(usize),
    /// 舊服務已停、新的起不來：代理現在是斷線的（原因只寫 log）；名單已存，再按一次重啟會接回
    Down(String),
}

/// 起新服務失敗時給畫面的白話字
pub const DOWN_TEXT: &str = "重啟終端服務沒有完成，底下的代理目前斷線。請再按一次重啟。";

/// 重啟前核對發現「終端服務裡有 ASN 沒記錄的視窗」時給畫面的白話字（使用者能做的事：先關掉那些視窗）
pub const UNMANAGED_TEXT: &str = "終端服務裡有 ASN 沒有記錄的視窗，重啟會把它們一起關掉又接不回，所以沒有重啟。請先關掉那些視窗再試。";

impl RestartError {
    /// 給畫面的白話字
    pub fn text(&self) -> &'static str {
        match self {
            RestartError::NoMux => NO_MUX_TEXT,
            RestartError::Failed(_) => FAIL_TEXT,
            RestartError::Unmanaged(_) => UNMANAGED_TEXT,
            RestartError::Down(_) => DOWN_TEXT,
        }
    }
}

/// 起新服務失敗、代理斷線時通知本人：走現有的「接回結果」通知（斷了幾位、接回 0 位、哪些沒接回；後台文字固定）。
/// 白話說明（「重啟終端服務沒有完成，N 個代理目前斷線，請到工作管理員再按一次重啟」）寫進 mux.log，並隨回給畫面的錯誤顯示
pub fn notify_down(work_dir: &std::path::Path, names: &[String], now_ms: u64) {
    super::mux_round::queue_resume_notice(work_dir, names.len(), names, now_ms);
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
/// - `verify`：停之前核對終端服務實際的窗格與 ASN 的記錄；對不上就回錯、不停服務
/// - `stop`：停服務；失敗就回錯，**不**起新的（「沒有服務在跑」由呼叫端當成功傳回 Ok）。
///   停止記號：`stop` 寫、失敗時由 `stop` 清；起新的失敗時**留著**（監看看到舊服務消失時不重複當事故，由 `down` 與存下的名單接手），
///   記號綁舊服務的程序編號與時間，之後換成別的服務就不再放過（見 mux_watch 的測試）
/// - `ensure`：起新的；失敗就回錯、不接回，名單存進 `stash`，並呼叫 `down`（通知本人代理斷了）
/// - `resume`：把名單交給接回（原因「重啟」、不計冷卻）
/// - `down`：起新的失敗、有夥伴斷線時呼叫（排通知、寫 log）
/// - `note`：寫 mux.log 的一行
#[allow(clippy::too_many_arguments)]
pub fn run_steps(
    has_mux: bool,
    stash: &Stash,
    snapshot: impl FnOnce() -> Option<Vec<String>>,
    verify: impl FnOnce() -> Result<(), RestartError>,
    stop: impl FnOnce() -> Result<(), String>,
    ensure: impl FnOnce() -> Result<(), String>,
    resume: impl FnOnce(Vec<String>),
    down: impl FnOnce(&[String]),
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
    if let Err(e) = verify() {
        if let RestartError::Unmanaged(n) = &e {
            note(&format!("工作管理員重啟終端服務：終端服務裡有 {n} 個視窗不在 ASN 的記錄上，重啟會一起關掉它們，不重啟"));
        }
        return Err(e);
    }
    let names = merge(stash.get(), now_names);
    note(&format!("工作管理員重啟終端服務：重啟前有 {} 位夥伴", names.len()));
    if let Err(e) = stop() {
        note(&format!("工作管理員重啟終端服務：停不掉，不起新的：{e}"));
        return Err(RestartError::Failed(e));
    }
    if let Err(e) = ensure() {
        stash.set(names.clone());
        note(&format!("工作管理員重啟終端服務：新的起不來：{e}"));
        if !names.is_empty() {
            note(&format!("工作管理員重啟終端服務沒有完成，{} 個代理目前斷線，請到工作管理員再按一次重啟", names.len()));
            down(&names);
        }
        return Err(RestartError::Down(e));
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
        flow_full(stash, snap, Ok(()), stop, ensure)
    }

    fn flow_full(stash: &Stash, snap: Option<Vec<String>>, verify: Result<(), RestartError>, stop: Result<(), String>, ensure: Result<(), String>) -> (Result<(), RestartError>, Vec<String>) {
        let calls = RefCell::new(Vec::<String>::new());
        let r = run_steps(
            true,
            stash,
            || {
                calls.borrow_mut().push("名單".into());
                snap
            },
            || {
                calls.borrow_mut().push("核對".into());
                verify
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
            |n| calls.borrow_mut().push(format!("通知{}位{}", n.len(), n.join("、"))),
            &|_| {},
        );
        (r, calls.into_inner())
    }

    fn two() -> Option<Vec<String>> {
        Some(vec!["甲".into(), "乙".into()])
    }

    fn flow(has_mux: bool, stop: Result<(), String>, ensure: Result<(), String>) -> (Result<(), RestartError>, Vec<String>) {
        if !has_mux {
            let r = run_steps(false, &Stash::new(), || panic!("不該抓名單"), || panic!("不該核對"), || panic!("不該停"), || panic!("不該起"), |_| panic!("不該接回"), |_| panic!("不該通知"), &|_| {});
            return (r, Vec::new());
        }
        flow_with(&Stash::new(), two(), stop, ensure)
    }

    #[test]
    fn _1860f_順序是抓名單_停_起_接回() {
        let (r, calls) = flow(true, Ok(()), Ok(()));
        assert!(r.is_ok());
        assert_eq!(calls, ["名單", "核對", "停", "起", "接回甲、乙"]);
    }

    #[test]
    fn _1860f_停不掉就不起新的也不接回_也不通知斷線() {
        let (r, calls) = flow(true, Err("沒有結束".into()), Ok(()));
        assert_eq!(r, Err(RestartError::Failed("沒有結束".into())));
        assert_eq!(calls, ["名單", "核對", "停"], "停失敗不能再起（舊的還活著）；舊的還在，代理沒斷，不發斷線通知");
    }

    #[test]
    fn _1860f_起不來回錯_不接回() {
        let (r, calls) = flow(true, Ok(()), Err("連不上".into()));
        assert_eq!(r.as_ref().unwrap_err().text(), DOWN_TEXT, "畫面講白話：沒完成、代理斷線、再按一次");
        assert!(matches!(r, Err(RestartError::Down(ref e)) if e == "連不上"), "原文留給 log");
        assert_eq!(calls, ["名單", "核對", "停", "起", "通知2位甲、乙"], "起不來：不接回，但要通知本人代理斷了");
    }

    /// 二審 1：起不來也要把「代理斷了」講給本人（通知）；名單是空的（沒有代理斷）就不吵
    #[test]
    fn _1860f_起不來_有代理斷線才通知() {
        let (_, calls) = flow_with(&Stash::new(), Some(Vec::new()), Ok(()), Err("連不上".into()));
        assert_eq!(calls, ["名單", "核對", "停", "起"], "沒有代理就沒有東西斷線，不發通知");
        let stash = Stash::new();
        stash.set(vec!["丙".into()]);
        let (_, calls) = flow_with(&stash, Some(Vec::new()), Ok(()), Err("連不上".into()));
        assert_eq!(calls.last().unwrap(), "通知1位丙", "重按又失敗：存下的名單照樣通知");
    }

    /// 二審 1：斷線通知走現有的接回結果通知：斷了 N 位、接回 0 位、名字是沒接回的那些
    #[test]
    fn _1860f_斷線通知_走接回結果通知() {
        let d = tempfile::tempdir().unwrap();
        notify_down(d.path(), &["甲".to_string(), "乙".to_string()], 42);
        let n = super::super::mux_round::read_resume_notice(d.path()).expect("通知排出去了");
        assert_eq!((n.0, n.1, n.2), (2, 0, vec!["甲".to_string(), "乙".to_string()]));
    }

    /// 二審 1：指令真的把斷線通知接上（起不來時由 run_steps 呼叫 down）
    #[test]
    fn _1860f_指令接上斷線通知() {
        let lib = include_str!("../lib.rs");
        let cmd = lib.split("async fn task_manager_restart_mux").nth(1).unwrap().split("async fn ").next().unwrap();
        assert!(cmd.contains("notify_down("), "起不來要通知本人");
    }

    /// 二審 2：核對發現終端服務裡有 ASN 沒記錄的視窗：不停、不起、不接回、不通知；畫面是白話字
    #[test]
    fn _1860f_核對不過就不動服務() {
        let (r, calls) = flow_full(&Stash::new(), two(), Err(RestartError::Unmanaged(2)), Ok(()), Ok(()));
        assert_eq!(r, Err(RestartError::Unmanaged(2)));
        assert_eq!(r.unwrap_err().text(), UNMANAGED_TEXT);
        assert_eq!(calls, ["名單", "核對"]);
    }

    /// 二審 5：名單是空的（Some 空）不是讀不到：照常停、起、接回（接回空名單）
    #[test]
    fn _1860f_名單是空的_照常重啟() {
        let (r, calls) = flow_with(&Stash::new(), Some(Vec::new()), Ok(()), Ok(()));
        assert!(r.is_ok());
        assert_eq!(calls, ["名單", "核對", "停", "起", "接回"]);
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
        assert_eq!(calls, ["名單", "核對", "停", "起", "接回甲、乙"], "用存下的名單接回");
        assert!(stash.get().is_empty(), "接回之後清掉，不重複接回");
    }

    /// 西川複看 B1：只是用終端服務、沒有東西等著接回、沒有失敗記號（最後一位夥伴關掉後服務被正常收掉）→ 不列佔位；有名單或失敗記號才列
    #[test]
    fn _1860f_佔位只在有東西等著接回或上次失敗時才列() {
        assert!(!placeholder_wanted(true, 0, false), "正常收掉空服務：不列佔位");
        assert!(placeholder_wanted(true, 2, false), "有名單等著接回");
        assert!(placeholder_wanted(true, 0, true), "上次重啟失敗");
        assert!(!placeholder_wanted(false, 2, true), "沒開終端服務模式一律不列");
    }

    /// 西川複看 B1：失敗記號由重啟結果決定（起不來＝真，下次成功清掉）；指令端要接得上
    #[test]
    fn _1860f_失敗記號_起不來設真_成功清掉() {
        // 記號是全域的，別的測試也會跑重啟；這裡不碰全域值，只驗指令端有把重啟結果寫進去
        let term = include_str!("term.rs");
        let f = term.split("fn restart_mux_with").nth(1).unwrap().split("fn restart_mux_handle").next().unwrap();
        assert!(f.contains("set_last_failed(true)") && f.contains("set_last_failed(false)"), "重啟結果要寫進失敗記號");
    }

    /// 一審複看 1：起不來之後還有幾位沒接回，要能讓畫面知道（重啟 ASN 前的確認框用）；接回後歸零
    #[test]
    fn _1860f_沒接回的人數_起不來有數字_接回後歸零() {
        let stash = Stash::new();
        assert_eq!(pending_of(&stash), 0);
        let (r, _) = flow_with(&stash, two(), Ok(()), Err("連不上".into()));
        assert!(r.is_err());
        assert_eq!(pending_of(&stash), 2, "起不來：兩位等著接回");
        let (r, _) = flow_with(&stash, Some(Vec::new()), Ok(()), Ok(()));
        assert!(r.is_ok());
        assert_eq!(pending_of(&stash), 0, "接回後歸零");
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

    /// 二審 5：重啟終端服務的中途（停了、新的還沒起之間）重啟 ASN 被擋；流程結束（成功或失敗）後才放行
    #[test]
    fn _1860f_重啟終端服務中途_重啟_asn_被擋() {
        let _g = TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        for ensure_ok in [true, false] {
            let mark = Restarting::begin().expect("拿到記號");
            let blocked = RefCell::new(Vec::<bool>::new());
            let r = run_steps(
                true,
                &Stash::new(),
                || Some(vec!["甲".to_string()]),
                || Ok(()),
                || {
                    blocked.borrow_mut().push(Restarting::begin_asn().is_none());
                    Ok(())
                },
                || {
                    blocked.borrow_mut().push(Restarting::begin_asn().is_none());
                    if ensure_ok { Ok(()) } else { Err("連不上".into()) }
                },
                |_| {},
                |_| {},
                &|_| {},
            );
            assert_eq!(r.is_ok(), ensure_ok);
            assert_eq!(*blocked.borrow(), vec![true, true], "停之後、起之間都擋住");
            drop(mark);
            drop(Restarting::begin_asn().expect("流程做完放掉記號後可以重啟 ASN"));
        }
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

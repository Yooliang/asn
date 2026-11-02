//! 「替這台電腦安裝並登入 Claude Code」的對外入口（#628 第 4 段）。桌面按鈕與手機觸發的遠端指令都只能走這裡，
//! 本人簽章（登入憑證）不經過 asn-cli，也不經過夥伴能呼叫的任何指令：由視窗程式建一個「取權杖的函式」傳進來，
//! 要用的時候（登入網址送出前）才取，因為安裝要好幾分鐘，事先取好的權杖可能在安裝途中過期。
//! 整段在獨立的執行緒裡跑：登入要等手機貼回授權碼，過程用 `rt::block_on` 等後台，不能擋住也不能卡在非同步工作執行緒裡（會 panic）。
//!
//! 開始前先看這台電腦的現況，**已經好好的就不動它**：
//!   - 已裝好且正常（簽章有效、跑得出版本）：不下載、不重裝、不比版本（Claude 會自己更新，比了可能把新版降回頻道版本）；壞了才重裝
//!   - 已登入：一律不跑 `claude auth login`，直接回「已登入」（要換帳號走切換帳號）
//!   - 看不出登入狀態：停下來回報，不當成沒登入——寧可多按一次，也不蓋掉別人的登入

use super::claude_install::Existing;
use super::claude_login::LoginState;
use super::login::{Outcome, Phone, Step};
use super::phone::SecretPhone;
use crate::relay::Relay;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

/// 進度（給畫面或回報用；不帶任何網址、授權碼）
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Event {
    Checking,
    Installing,
    /// 裝好了（或本來就好好的），帶版本號
    Installed(String),
    Login(Step),
}

#[derive(Debug, PartialEq, Eq)]
pub enum Finish {
    /// 裝好且登入驗證過
    Ready(String),
    /// 本來就裝好也登入了，什麼都沒動
    AlreadyReady(String),
    /// 這台沒辦法背景登入，請退回開終端機
    NeedTerminal(String),
    Declined,
    TimedOut,
    Failed(String),
}

impl Event {
    /// 給畫面的進度（固定文字，不帶網址與授權碼）
    pub fn to_json(&self) -> serde_json::Value {
        use serde_json::json;
        match self {
            Event::Checking => json!({ "phase": "checking", "text": "正在確認這台電腦的現況" }),
            Event::Installing => json!({ "phase": "installing", "text": "正在下載並驗證 Claude Code" }),
            Event::Installed(v) => json!({ "phase": "installed", "text": format!("Claude Code {v} 已就緒，準備登入"), "version": v }),
            Event::Login(Step::WaitingUrl) => json!({ "phase": "login", "text": "正在取得登入網址" }),
            Event::Login(Step::UrlSent) => json!({ "phase": "login", "text": "登入網址已送到你的手機，請在手機上開啟並貼回授權碼" }),
            Event::Login(Step::CodeSent) => json!({ "phase": "login", "text": "已收到授權碼，正在登入" }),
            Event::Login(Step::Checking) => json!({ "phase": "login", "text": "正在確認登入結果" }),
        }
    }
}

impl Finish {
    pub fn to_json(&self) -> serde_json::Value {
        use serde_json::json;
        match self {
            Finish::Ready(v) => json!({ "phase": "done", "ok": true, "text": format!("Claude Code {v} 已安裝並登入"), "version": v }),
            Finish::AlreadyReady(v) => json!({ "phase": "done", "ok": true, "already": true, "text": format!("這台電腦已經安裝 Claude Code {v} 並登入，沒有重新安裝或登入"), "version": v }),
            Finish::NeedTerminal(t) => json!({ "phase": "done", "ok": false, "terminal": true, "text": t }),
            Finish::Declined => json!({ "phase": "done", "ok": false, "text": "你在手機上拒絕了這次登入" }),
            Finish::TimedOut => json!({ "phase": "done", "ok": false, "text": "等太久了，登入逾時" }),
            Finish::Failed(e) => json!({ "phase": "done", "ok": false, "text": e }),
        }
    }
}

static BUSY: AtomicBool = AtomicBool::new(false);

/// 同一時間只允許一個安裝並登入。取到的鎖交給執行緒，結束（含 panic）時放掉
#[derive(Debug)]
struct Busy(&'static AtomicBool);
impl Busy {
    fn take(flag: &'static AtomicBool) -> Result<Self, String> {
        if flag.swap(true, Ordering::SeqCst) {
            Err("已經有一個安裝或登入在進行，請等它結束".to_string())
        } else {
            Ok(Busy(flag))
        }
    }
}
impl Drop for Busy {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

/// 流程的幾個動作（測試時換成假的）
pub struct Steps<'a> {
    pub inspect: &'a dyn Fn() -> Existing,
    pub install: &'a dyn Fn() -> Result<String, String>,
    pub state: &'a dyn Fn() -> LoginState,
    pub login: &'a dyn Fn(&dyn Phone, &dyn Fn(Step)) -> Outcome,
}

/// 核心流程：先看現況，沒裝好才安裝，沒登入才用手機登入
pub fn run_with(s: &Steps, phone: &dyn Phone, report: &dyn Fn(Event)) -> Finish {
    report(Event::Checking);
    let version = match (s.inspect)() {
        Existing::Healthy(v) => v,
        Existing::Missing | Existing::Broken(_) => {
            report(Event::Installing);
            match (s.install)() {
                Ok(v) => v,
                Err(e) => return Finish::Failed(e),
            }
        }
    };
    report(Event::Installed(version.clone()));
    match (s.state)() {
        LoginState::In => return Finish::AlreadyReady(version),
        LoginState::Unknown(why) => return Finish::Failed(format!("{why}。為了不蓋掉現有的登入，沒有繼續；請先在終端機確認登入狀態")),
        LoginState::Out => {}
    }
    match (s.login)(phone, &|st| report(Event::Login(st))) {
        Outcome::Verified => Finish::Ready(version),
        Outcome::NeedTerminal(t) => Finish::NeedTerminal(t),
        Outcome::Declined => Finish::Declined,
        Outcome::TimedOut => Finish::TimedOut,
        Outcome::Failed(e) => Finish::Failed(e),
    }
}

/// 取本人簽章的函式：由視窗程式建立（來源只有它的記憶體）。取不到（沒登入、換新失敗）回 None
pub type TokenFn = Arc<dyn Fn() -> Option<String> + Send + Sync>;

/// 開始安裝並登入 Claude Code（只有 Windows 有完整流程）。已經有一個在跑就**直接回錯**，不開執行緒也不送事件；
/// 否則在新的執行緒裡跑，立刻回來，結束時呼叫 `done` 一次。
pub fn start_claude(relay: Arc<Relay>, token: TokenFn, report: impl Fn(Event) + Send + 'static, done: impl FnOnce(Finish) + Send + 'static) -> Result<(), String> {
    let busy = Busy::take(&BUSY)?;
    let spawned = std::thread::Builder::new().name("asn-agent-setup".into()).spawn(move || {
        let _busy = busy;
        let get = move || token();
        let phone = SecretPhone { be: relay.as_ref(), token: &get, poll: Duration::from_secs(2) };
        let steps = Steps {
            inspect: &super::claude_install::inspect_here,
            install: &super::claude_install::install_here,
            state: &super::claude_login::login_state_here,
            login: &|p, r| super::claude_login::login_here(p, r),
        };
        done(run_with(&steps, &phone, &report));
    });
    spawned.map(|_| ()).map_err(|e| format!("無法開始：{e}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use super::super::login::Ask;
    use std::cell::{Cell, RefCell};

    struct NoPhone;
    impl Phone for NoPhone {
        fn ask_code(&self, _url: &str, _wait: Duration) -> Ask {
            Ask::TimedOut
        }
    }

    #[derive(Default)]
    struct Calls {
        install: Cell<u32>,
        login: Cell<u32>,
    }

    fn run(existing: Existing, install: Result<&str, &str>, state: LoginState, login: Outcome) -> (Finish, Vec<Event>, Calls) {
        let calls = Calls::default();
        let ev = RefCell::new(vec![]);
        let state = RefCell::new(Some(state));
        let login = RefCell::new(Some(login));
        let existing = RefCell::new(Some(existing));
        let steps = Steps {
            inspect: &|| existing.borrow_mut().take().unwrap(),
            install: &|| {
                calls.install.set(calls.install.get() + 1);
                install.map(|s| s.to_string()).map_err(|e| e.to_string())
            },
            state: &|| state.borrow_mut().take().unwrap(),
            login: &|_, rep| {
                calls.login.set(calls.login.get() + 1);
                rep(Step::UrlSent);
                login.borrow_mut().take().unwrap()
            },
        };
        let r = run_with(&steps, &NoPhone, &|e| ev.borrow_mut().push(e));
        (r, ev.into_inner(), calls)
    }

    #[test]
    fn 新電腦_裝好又登入成功_依序回報() {
        let (r, ev, c) = run(Existing::Missing, Ok("2.1.309"), LoginState::Out, Outcome::Verified);
        assert_eq!(r, Finish::Ready("2.1.309".into()));
        assert_eq!((c.install.get(), c.login.get()), (1, 1));
        assert_eq!(ev, vec![Event::Checking, Event::Installing, Event::Installed("2.1.309".into()), Event::Login(Step::UrlSent)]);
    }

    #[test]
    fn 已裝好又已登入_安裝和登入都不能被呼叫() {
        let (r, ev, c) = run(Existing::Healthy("2.1.316".into()), Err("不該安裝"), LoginState::In, Outcome::Failed("不該登入".into()));
        assert_eq!(r, Finish::AlreadyReady("2.1.316".into()), "版本用現有的，不比頻道版本");
        assert_eq!((c.install.get(), c.login.get()), (0, 0));
        assert!(!ev.contains(&Event::Installing));
    }

    #[test]
    fn 已裝好但沒登入_只登入不重裝() {
        let (r, _, c) = run(Existing::Healthy("2.1.316".into()), Err("不該安裝"), LoginState::Out, Outcome::Verified);
        assert_eq!(r, Finish::Ready("2.1.316".into()));
        assert_eq!((c.install.get(), c.login.get()), (0, 1));
    }

    #[test]
    fn 裝壞了才重裝() {
        let (r, _, c) = run(Existing::Broken("簽章不對".into()), Ok("2.1.309"), LoginState::Out, Outcome::Verified);
        assert_eq!(r, Finish::Ready("2.1.309".into()));
        assert_eq!(c.install.get(), 1);
    }

    #[test]
    fn 看不出登入狀態_停下來回報_不登入() {
        let (r, _, c) = run(Existing::Healthy("2.1.316".into()), Err("x"), LoginState::Unknown("輸出看不懂".into()), Outcome::Verified);
        assert!(matches!(&r, Finish::Failed(e) if e.contains("輸出看不懂") && e.contains("沒有繼續")), "{r:?}");
        assert_eq!((c.install.get(), c.login.get()), (0, 0), "不確定就一個都不動");
    }

    #[test]
    fn 安裝失敗_不看登入_不開始登入() {
        let (r, ev, c) = run(Existing::Missing, Err("雜湊不符"), LoginState::Out, Outcome::Verified);
        assert_eq!(r, Finish::Failed("雜湊不符".into()));
        assert_eq!(c.login.get(), 0);
        assert_eq!(ev, vec![Event::Checking, Event::Installing]);
    }

    #[test]
    fn 登入的各種結果_原樣對應() {
        let go = |o| run(Existing::Healthy("1.0.0".into()), Err("x"), LoginState::Out, o).0;
        assert_eq!(go(Outcome::Declined), Finish::Declined);
        assert_eq!(go(Outcome::TimedOut), Finish::TimedOut);
        assert_eq!(go(Outcome::NeedTerminal("t".into())), Finish::NeedTerminal("t".into()));
        assert_eq!(go(Outcome::Failed("x".into())), Finish::Failed("x".into()));
    }

    #[test]
    fn 回報文字固定_不帶網址與授權碼() {
        for e in [Event::Checking, Event::Installing, Event::Installed("2.1.309".into()), Event::Login(Step::WaitingUrl), Event::Login(Step::UrlSent), Event::Login(Step::CodeSent), Event::Login(Step::Checking)] {
            let t = e.to_json().to_string();
            assert!(!t.contains("http"), "{t}");
        }
        assert_eq!(Finish::Ready("2.1.309".into()).to_json()["ok"], true);
        assert_eq!(Finish::AlreadyReady("2.1.309".into()).to_json()["already"], true);
        assert_eq!(Finish::Declined.to_json()["ok"], false);
    }

    #[test]
    fn 同時只允許一個_第二次直接回錯_放掉後可再取() {
        static FLAG: AtomicBool = AtomicBool::new(false);
        let first = Busy::take(&FLAG).unwrap();
        assert!(Busy::take(&FLAG).unwrap_err().contains("已經有一個"));
        assert!(FLAG.load(Ordering::SeqCst), "第二次失敗不能把別人的鎖放掉");
        drop(first);
        assert!(Busy::take(&FLAG).is_ok());
    }

    /// 登入要等後台（rt::block_on），從非同步工作執行緒直接呼叫會 panic；入口一律開獨立執行緒，而且鎖在開執行緒之前就取
    #[test]
    fn 守門_入口在獨立執行緒裡跑_鎖在開執行緒之前() {
        let src = include_str!("setup.rs");
        let body = &src[..src.find("#[cfg(test)]").unwrap()];
        let at = body.find("pub fn start_claude").unwrap();
        let (take, spawn) = (body[at..].find("Busy::take(&BUSY)?").unwrap(), body[at..].find("std::thread::Builder::new()").unwrap());
        assert!(take < spawn, "要先取鎖、再開執行緒，第二次按才不會送出假的結束事件");
    }
}

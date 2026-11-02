//! 「替這台電腦安裝並登入 Claude Code」的對外入口（#628 第 4 段）。桌面按鈕與手機觸發的遠端指令都只能走這裡，
//! 本人簽章（登入憑證）由呼叫端從視窗程式的記憶體取來交給這裡：不經過 asn-cli，也不經過夥伴能呼叫的任何指令。
//! 整段在獨立的執行緒裡跑：登入要等手機貼回授權碼，過程用 `rt::block_on` 等後台，不能擋住也不能卡在非同步工作執行緒裡（會 panic）。

use super::login::{Outcome, Phone, Step};
use super::phone::SecretPhone;
use crate::relay::Relay;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

/// 進度（給畫面或回報用；不帶任何網址、授權碼）
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Event {
    Installing,
    /// 裝好了，帶版本號
    Installed(String),
    Login(Step),
}

#[derive(Debug, PartialEq, Eq)]
pub enum Finish {
    /// 裝好且登入驗證過
    Ready(String),
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
            Event::Installing => json!({ "phase": "installing", "text": "正在下載並驗證 Claude Code" }),
            Event::Installed(v) => json!({ "phase": "installed", "text": format!("已安裝 Claude Code {v}，準備登入"), "version": v }),
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
            Finish::NeedTerminal(t) => json!({ "phase": "done", "ok": false, "terminal": true, "text": t }),
            Finish::Declined => json!({ "phase": "done", "ok": false, "text": "你在手機上拒絕了這次登入" }),
            Finish::TimedOut => json!({ "phase": "done", "ok": false, "text": "等太久了，登入逾時" }),
            Finish::Failed(e) => json!({ "phase": "done", "ok": false, "text": e }),
        }
    }
}

static BUSY: AtomicBool = AtomicBool::new(false);

struct BusyGuard<'a>(&'a AtomicBool);
impl Drop for BusyGuard<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

/// 核心流程（可注入假的安裝與登入來測）：先安裝，再用手機登入。同一時間只允許一個
pub fn run_with(
    busy: &AtomicBool,
    install: &dyn Fn() -> std::result::Result<String, String>,
    login: &dyn Fn(&dyn Phone, &dyn Fn(Step)) -> Outcome,
    phone: &dyn Phone,
    report: &dyn Fn(Event),
) -> Finish {
    if busy.swap(true, Ordering::SeqCst) {
        return Finish::Failed("已經有一個安裝或登入在進行，請等它結束".to_string());
    }
    let _guard = BusyGuard(busy);
    report(Event::Installing);
    let version = match install() {
        Ok(v) => v,
        Err(e) => return Finish::Failed(e),
    };
    report(Event::Installed(version.clone()));
    match login(phone, &|s| report(Event::Login(s))) {
        Outcome::Verified => Finish::Ready(version),
        Outcome::NeedTerminal(t) => Finish::NeedTerminal(t),
        Outcome::Declined => Finish::Declined,
        Outcome::TimedOut => Finish::TimedOut,
        Outcome::Failed(e) => Finish::Failed(e),
    }
}

/// 開始安裝並登入 Claude Code（只有 Windows 有完整流程）。在新的執行緒裡跑，立刻回來；結束時呼叫 `done` 一次。
/// `sign_token` 是本人簽章，只用來替登入網址那一個請求簽章，不進 log、不進回報。
pub fn start_claude(relay: Arc<Relay>, sign_token: String, report: impl Fn(Event) + Send + 'static, done: impl FnOnce(Finish) + Send + 'static) -> std::io::Result<()> {
    std::thread::Builder::new().name("asn-agent-setup".into()).spawn(move || {
        let phone = SecretPhone { be: relay.as_ref(), sign_token, poll: Duration::from_secs(2) };
        let res = run_with(&BUSY, &super::claude_install::install_here, &|p, r| super::claude_login::login_here(p, r), &phone, &report);
        done(res);
    })?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use super::super::login::Ask;
    use std::cell::RefCell;

    struct NoPhone;
    impl Phone for NoPhone {
        fn ask_code(&self, _url: &str, _wait: Duration) -> Ask {
            Ask::TimedOut
        }
    }

    fn run(install: std::result::Result<&str, &str>, login: Outcome) -> (Finish, Vec<Event>, bool) {
        let busy = AtomicBool::new(false);
        let ev = RefCell::new(vec![]);
        let called = RefCell::new(false);
        let login = RefCell::new(Some(login));
        let r = run_with(
            &busy,
            &|| install.map(|s| s.to_string()).map_err(|e| e.to_string()),
            &|_, rep| {
                *called.borrow_mut() = true;
                rep(Step::UrlSent);
                login.borrow_mut().take().unwrap()
            },
            &NoPhone,
            &|e| ev.borrow_mut().push(e),
        );
        assert!(!busy.load(Ordering::SeqCst), "結束後要放掉忙碌旗標");
        (r, ev.into_inner(), called.into_inner())
    }

    #[test]
    fn 裝好又登入成功_依序回報() {
        let (r, ev, _) = run(Ok("2.1.309"), Outcome::Verified);
        assert_eq!(r, Finish::Ready("2.1.309".into()));
        assert_eq!(ev, vec![Event::Installing, Event::Installed("2.1.309".into()), Event::Login(Step::UrlSent)]);
    }

    #[test]
    fn 安裝失敗_不開始登入() {
        let (r, ev, called) = run(Err("雜湊不符"), Outcome::Verified);
        assert_eq!(r, Finish::Failed("雜湊不符".into()));
        assert!(!called, "沒裝好就不能開始登入");
        assert_eq!(ev, vec![Event::Installing]);
    }

    #[test]
    fn 登入的各種結果_原樣對應() {
        assert_eq!(run(Ok("1.0.0"), Outcome::Declined).0, Finish::Declined);
        assert_eq!(run(Ok("1.0.0"), Outcome::TimedOut).0, Finish::TimedOut);
        assert_eq!(run(Ok("1.0.0"), Outcome::NeedTerminal("t".into())).0, Finish::NeedTerminal("t".into()));
        assert_eq!(run(Ok("1.0.0"), Outcome::Failed("x".into())).0, Finish::Failed("x".into()));
    }

    #[test]
    fn 同時只允許一個() {
        let busy = AtomicBool::new(true);
        let r = run_with(&busy, &|| panic!("不該安裝"), &|_, _| panic!("不該登入"), &NoPhone, &|_| {});
        assert!(matches!(r, Finish::Failed(ref e) if e.contains("已經有一個")), "{r:?}");
        assert!(busy.load(Ordering::SeqCst), "別人的旗標不能被放掉");
    }

    #[test]
    fn 回報文字固定_不帶網址與授權碼() {
        for e in [Event::Installing, Event::Installed("2.1.309".into()), Event::Login(Step::WaitingUrl), Event::Login(Step::UrlSent), Event::Login(Step::CodeSent), Event::Login(Step::Checking)] {
            let t = e.to_json().to_string();
            assert!(!t.contains("http"), "{t}");
        }
        assert_eq!(Finish::Ready("2.1.309".into()).to_json()["ok"], true);
        assert_eq!(Finish::Declined.to_json()["ok"], false);
    }

    /// 登入要等後台（rt::block_on），從非同步工作執行緒直接呼叫會 panic；入口一律開獨立執行緒
    #[test]
    fn 守門_入口在獨立執行緒裡跑() {
        let src = include_str!("setup.rs");
        let body = &src[..src.find("#[cfg(test)]").unwrap()];
        assert!(body.contains("std::thread::Builder::new()"), "入口要開獨立執行緒");
    }
}

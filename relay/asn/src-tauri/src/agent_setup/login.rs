//! 登入流程（與引擎無關，#628 第 2 段）：開登入子程序 → 從它的輸出找出登入網址 → 交給 `Phone` 送到手機並等本人貼回授權碼
//! → 寫進子程序的標準輸入 → 等它結束 → 用引擎自己的方式確認已登入。
//!
//! 授權碼的處理（asn真條件 D）：只存在記憶體（`Secret`），沒有 `Debug`／`Display`／`Clone`，寫進標準輸入後立刻清成零；
//! 不進 log、不進狀態檔、不進任何錯誤訊息（所有對外的文字都是固定字串）；子程序的輸出記 log 前先把網址參數遮掉。
//! 同一時間只允許一個登入；辨認不到網址就回 `NeedTerminal`，由呼叫端退回「開終端機登入」。

use super::proc::{strip_ansi, LoginProc, ReadLine, Spawner};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

#[cfg(test)]
thread_local! {
    static WIPES: std::cell::Cell<u32> = const { std::cell::Cell::new(0) };
}

/// 授權碼：只能被讀一次寫進子程序，沒有 Debug／Display／Clone，丟掉時清成零
pub struct Secret(Vec<u8>);

impl Secret {
    pub fn new(s: String) -> Self {
        Secret(s.into_bytes())
    }
    pub(crate) fn bytes(&self) -> &[u8] {
        &self.0
    }
    fn wipe(&mut self) {
        #[cfg(test)]
        WIPES.with(|c| c.set(c.get() + 1));
        for b in self.0.iter_mut() {
            // SAFETY: 指標來自可變參考，必定有效且對齊；用 volatile 避免被最佳化掉
            unsafe { std::ptr::write_volatile(b, 0) };
        }
    }
}

impl Drop for Secret {
    fn drop(&mut self) {
        self.wipe();
    }
}

/// 向手機要授權碼的結果
pub enum Ask {
    Code(Secret),
    /// 本人在手機上選了不要
    Declined,
    /// 等太久
    TimedOut,
    /// 送不出去、沒有簽章等：固定文字，不含授權碼與網址參數
    Failed(String),
}

/// 把登入網址送到手機、等本人貼回授權碼。真的實作（secret_remote）在後面的段落
pub trait Phone {
    fn ask_code(&self, url: &str, wait: Duration) -> Ask;
}

/// 各家引擎「授權碼送回型」登入的差異（Claude 是第一個）
pub trait LoginEngine {
    fn exe(&self) -> PathBuf;
    fn args(&self) -> Vec<&'static str>;
    /// 這一行輸出裡的登入網址（必須是官方網域的 https）
    fn find_url(&self, line: &str) -> Option<String>;
    /// 這一行是「授權碼無效或過期」
    fn invalid_code_hint(&self, line: &str) -> bool;
    /// 登入後確認：是否真的已登入
    fn check_login(&self) -> Result<bool, String>;
}

#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub enum Step {
    WaitingUrl,
    UrlSent,
    CodeSent,
    Checking,
}

#[derive(Debug, PartialEq, Eq)]
pub enum Outcome {
    Verified,
    /// 這個引擎在這台電腦上沒辦法背景登入（辨認不到網址等），請退回開終端機
    NeedTerminal(String),
    Declined,
    TimedOut,
    Failed(String),
}

pub struct Limits {
    /// 整個登入的時間上限（從開子程序算起）
    pub total: Duration,
    /// 等網址：每次等多久、最多等幾次
    pub poll: Duration,
    pub url_polls: u32,
    /// 寫進授權碼後，等子程序結束
    pub exit_wait: Duration,
    /// 授權碼無效時最多重走幾輪
    pub rounds: u32,
}

impl Default for Limits {
    fn default() -> Self {
        Limits { total: Duration::from_secs(600), poll: Duration::from_millis(500), url_polls: 120, exit_wait: Duration::from_secs(60), rounds: 2 }
    }
}

static BUSY: AtomicBool = AtomicBool::new(false);

struct BusyGuard<'a>(&'a AtomicBool);
impl Drop for BusyGuard<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

const MAX_URL_LINES: u32 = 200;
const MAX_LOGGED_LINES: u32 = 30;
const MAX_DRAIN_LINES: u32 = 50;

/// 記 log 前把網址的參數遮掉（參數含一次性的 state 與 challenge）
pub fn redact_line(line: &str) -> String {
    line.split(' ')
        .map(|tok| {
            if tok.starts_with("http://") || tok.starts_with("https://") {
                match tok.find(['?', '#']) {
                    Some(i) => format!("{}?…", &tok[..i]),
                    None => tok.to_string(),
                }
            } else {
                tok.to_string()
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

pub fn run_login(eng: &dyn LoginEngine, sp: &dyn Spawner, phone: &dyn Phone, lim: &Limits, report: &dyn Fn(Step)) -> Outcome {
    run_login_with(&BUSY, eng, sp, phone, lim, report)
}

pub fn run_login_with(busy: &AtomicBool, eng: &dyn LoginEngine, sp: &dyn Spawner, phone: &dyn Phone, lim: &Limits, report: &dyn Fn(Step)) -> Outcome {
    if busy.swap(true, Ordering::SeqCst) {
        return Outcome::Failed("已經有一個登入在進行，請等它結束".to_string());
    }
    let _guard = BusyGuard(busy);
    let started = Instant::now();
    for _ in 0..lim.rounds.max(1) {
        match one_round(eng, sp, phone, lim, report, started) {
            Round::Done(o) => return o,
            Round::Retry => continue,
        }
    }
    Outcome::Failed("授權碼無效或已過期，重試後仍然失敗".to_string())
}

enum Round {
    Done(Outcome),
    Retry,
}

fn one_round(eng: &dyn LoginEngine, sp: &dyn Spawner, phone: &dyn Phone, lim: &Limits, report: &dyn Fn(Step), started: Instant) -> Round {
    report(Step::WaitingUrl);
    let mut proc: Box<dyn LoginProc> = match sp.spawn(&eng.exe(), &eng.args()) {
        Ok(p) => p,
        Err(e) => return Round::Done(Outcome::Failed(e)),
    };

    // 1. 等網址
    let mut url: Option<String> = None;
    let (mut polls, mut seen, mut logged) = (0u32, 0u32, 0u32);
    loop {
        match proc.read_line(lim.poll) {
            ReadLine::Line(raw) => {
                seen += 1;
                let clean = strip_ansi(&raw);
                if logged < MAX_LOGGED_LINES {
                    logged += 1;
                    elog!("登入程序輸出：{}", redact_line(&clean));
                }
                if let Some(u) = eng.find_url(&clean) {
                    url = Some(u);
                    break;
                }
                if seen >= MAX_URL_LINES {
                    break;
                }
            }
            ReadLine::Timeout => {
                polls += 1;
                if polls >= lim.url_polls {
                    break;
                }
            }
            ReadLine::Eof => break,
        }
    }
    let Some(url) = url else {
        proc.kill_tree();
        return Round::Done(Outcome::NeedTerminal("辨認不到登入網址，請在這台電腦上登入".to_string()));
    };

    // 2. 把網址送到手機，等本人貼回授權碼
    report(Step::UrlSent);
    let remaining = lim.total.saturating_sub(started.elapsed());
    let secret = match phone.ask_code(&url, remaining) {
        Ask::Code(s) => s,
        Ask::Declined => {
            proc.kill_tree();
            return Round::Done(Outcome::Declined);
        }
        Ask::TimedOut => {
            proc.kill_tree();
            return Round::Done(Outcome::TimedOut);
        }
        Ask::Failed(e) => {
            proc.kill_tree();
            return Round::Done(Outcome::Failed(e));
        }
    };

    // 3. 寫進標準輸入（寫完立刻清掉）
    let wrote = proc.write_stdin(secret.bytes()).and_then(|_| proc.write_stdin(b"\n"));
    drop(secret);
    if wrote.is_err() {
        proc.kill_tree();
        return Round::Done(Outcome::Failed("無法把授權碼交給登入程序".to_string()));
    }
    report(Step::CodeSent);

    // 4. 等它結束
    let Some(code) = proc.wait(lim.exit_wait) else {
        proc.kill_tree();
        return Round::Done(Outcome::Failed("登入程序沒有在時限內結束".to_string()));
    };
    let mut invalid = false;
    for _ in 0..MAX_DRAIN_LINES {
        match proc.read_line(Duration::from_millis(100)) {
            ReadLine::Line(raw) => {
                if eng.invalid_code_hint(&strip_ansi(&raw)) {
                    invalid = true;
                }
            }
            _ => break,
        }
    }
    if code == 0 {
        report(Step::Checking);
        return Round::Done(match eng.check_login() {
            Ok(true) => Outcome::Verified,
            Ok(false) => Outcome::Failed("登入程序結束了，但確認不到已登入".to_string()),
            Err(e) => Outcome::Failed(e),
        });
    }
    if invalid {
        return Round::Retry;
    }
    Round::Done(Outcome::Failed(format!("登入沒有完成（結束碼 {code}）")))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent_setup::claude_login::url_in_line;
    use std::cell::RefCell;
    use std::collections::VecDeque;
    use std::rc::Rc;

    #[derive(Default)]
    struct Shared {
        stdin: RefCell<Vec<u8>>,
        killed: RefCell<u32>,
    }

    struct FakeProc {
        lines: VecDeque<ReadLine>,
        /// 寫過授權碼之後才吐出的行
        after: VecDeque<ReadLine>,
        wrote: bool,
        exit: Option<i32>,
        sh: Rc<Shared>,
    }
    impl LoginProc for FakeProc {
        fn read_line(&mut self, _t: Duration) -> ReadLine {
            let q = if self.wrote && !self.after.is_empty() { &mut self.after } else { &mut self.lines };
            q.pop_front().unwrap_or(ReadLine::Eof)
        }
        fn write_stdin(&mut self, data: &[u8]) -> Result<(), String> {
            self.sh.stdin.borrow_mut().extend_from_slice(data);
            self.wrote = true;
            Ok(())
        }
        fn wait(&mut self, _t: Duration) -> Option<i32> {
            self.exit
        }
        fn kill_tree(&mut self) {
            *self.sh.killed.borrow_mut() += 1;
        }
    }

    struct Script {
        lines: Vec<ReadLine>,
        after: Vec<ReadLine>,
        exit: Option<i32>,
    }
    fn line(s: &str) -> ReadLine {
        ReadLine::Line(s.to_string())
    }

    struct FakeSpawner {
        scripts: RefCell<VecDeque<Script>>,
        spawned: RefCell<u32>,
        sh: Rc<Shared>,
    }
    impl Spawner for FakeSpawner {
        fn spawn(&self, _exe: &std::path::Path, _args: &[&str]) -> Result<Box<dyn LoginProc>, String> {
            *self.spawned.borrow_mut() += 1;
            let s = self.scripts.borrow_mut().pop_front().ok_or_else(|| "沒有腳本".to_string())?;
            Ok(Box::new(FakeProc { lines: s.lines.into(), after: s.after.into(), wrote: false, exit: s.exit, sh: self.sh.clone() }))
        }
    }

    struct FakePhone {
        answers: RefCell<VecDeque<Ask>>,
        urls: RefCell<Vec<String>>,
    }
    impl Phone for FakePhone {
        fn ask_code(&self, url: &str, _w: Duration) -> Ask {
            self.urls.borrow_mut().push(url.to_string());
            self.answers.borrow_mut().pop_front().unwrap_or(Ask::TimedOut)
        }
    }

    struct FakeEngine {
        verified: Result<bool, String>,
    }
    impl LoginEngine for FakeEngine {
        fn exe(&self) -> PathBuf {
            PathBuf::from("claude.exe")
        }
        fn args(&self) -> Vec<&'static str> {
            vec!["auth", "login"]
        }
        fn find_url(&self, l: &str) -> Option<String> {
            url_in_line(l)
        }
        fn invalid_code_hint(&self, l: &str) -> bool {
            l.to_lowercase().contains("invalid code")
        }
        fn check_login(&self) -> Result<bool, String> {
            self.verified.clone()
        }
    }

    const URL: &str = "https://claude.ai/oauth/authorize?code=true&state=ST4TE&code_challenge=CH4LL";
    const SECRET: &str = "SECRET-XYZ-123";

    struct Rig {
        sp: FakeSpawner,
        phone: FakePhone,
        eng: FakeEngine,
        sh: Rc<Shared>,
        busy: AtomicBool,
        steps: RefCell<Vec<Step>>,
    }
    fn rig(scripts: Vec<Script>, answers: Vec<Ask>) -> Rig {
        let sh = Rc::new(Shared::default());
        Rig {
            sp: FakeSpawner { scripts: RefCell::new(scripts.into()), spawned: RefCell::new(0), sh: sh.clone() },
            phone: FakePhone { answers: RefCell::new(answers.into()), urls: RefCell::new(vec![]) },
            eng: FakeEngine { verified: Ok(true) },
            sh,
            busy: AtomicBool::new(false),
            steps: RefCell::new(vec![]),
        }
    }
    fn small() -> Limits {
        Limits { total: Duration::from_secs(600), poll: Duration::from_millis(1), url_polls: 3, exit_wait: Duration::from_millis(1), rounds: 2 }
    }
    fn go(r: &Rig) -> Outcome {
        run_login_with(&r.busy, &r.eng, &r.sp, &r.phone, &small(), &|s| r.steps.borrow_mut().push(s))
    }
    fn good_script() -> Script {
        Script { lines: vec![line("Opening browser to sign in…"), line(&format!("\u{1b}[32m{URL}\u{1b}[0m")), line("Paste code here if prompted >")], after: vec![], exit: Some(0) }
    }
    fn code() -> Ask {
        Ask::Code(Secret::new(SECRET.to_string()))
    }
    fn all_text(o: &Outcome) -> String {
        format!("{o:?}")
    }

    #[test]
    fn 正常登入_網址原樣交給手機_授權碼寫進標準輸入_確認後算成功() {
        let r = rig(vec![good_script()], vec![code()]);
        assert_eq!(go(&r), Outcome::Verified);
        assert_eq!(r.phone.urls.borrow().as_slice(), &[URL.to_string()], "網址連參數原樣交給手機（參數不會被遮）");
        assert_eq!(r.sh.stdin.borrow().as_slice(), format!("{SECRET}\n").as_bytes());
        assert_eq!(*r.steps.borrow(), vec![Step::WaitingUrl, Step::UrlSent, Step::CodeSent, Step::Checking]);
        assert!(!r.busy.load(Ordering::SeqCst), "結束後鎖放開");
    }

    #[test]
    fn 辨認不到網址_退回終端機_不問手機() {
        for lines in [vec![line("沒有網址的輸出"), ReadLine::Eof], vec![line("請開 http://claude.ai/x （不是 https）")], vec![line("https://evil.example/oauth?x=1")], vec![ReadLine::Timeout, ReadLine::Timeout, ReadLine::Timeout, ReadLine::Timeout]] {
            let r = rig(vec![Script { lines, after: vec![], exit: Some(0) }], vec![code()]);
            let o = go(&r);
            assert!(matches!(o, Outcome::NeedTerminal(_)), "{o:?}");
            assert!(r.phone.urls.borrow().is_empty(), "辨認不到就不問手機");
            assert_eq!(*r.sh.killed.borrow(), 1, "子程序要結束");
            assert!(r.sh.stdin.borrow().is_empty());
            assert!(!r.busy.load(Ordering::SeqCst));
        }
    }

    #[test]
    fn 手機端不要_逾時_送不出去_都結束子程序且不寫授權碼() {
        for (ans, want) in [(Ask::Declined, Outcome::Declined), (Ask::TimedOut, Outcome::TimedOut), (Ask::Failed("手機送不出去".into()), Outcome::Failed("手機送不出去".into()))] {
            let r = rig(vec![good_script()], vec![ans]);
            assert_eq!(go(&r), want);
            assert_eq!(*r.sh.killed.borrow(), 1);
            assert!(r.sh.stdin.borrow().is_empty());
            assert!(!r.busy.load(Ordering::SeqCst));
        }
    }

    #[test]
    fn 授權碼無效_重走一輪_新網址_第二輪成功() {
        let bad = Script { after: vec![line(&format!("OAuth error: Invalid code {SECRET}"))], exit: Some(1), ..good_script() };
        let r = rig(vec![bad, good_script()], vec![code(), code()]);
        assert_eq!(go(&r), Outcome::Verified);
        assert_eq!(*r.sp.spawned.borrow(), 2);
        assert_eq!(r.phone.urls.borrow().len(), 2, "第二輪重新要一次");
    }

    #[test]
    fn 兩輪都無效就停_不無限重試() {
        let mk = || Script { after: vec![line("OAuth error: Invalid code")], exit: Some(1), ..good_script() };
        let r = rig(vec![mk(), mk(), mk()], vec![code(), code(), code()]);
        let o = go(&r);
        assert!(matches!(o, Outcome::Failed(_)), "{o:?}");
        assert_eq!(*r.sp.spawned.borrow(), 2, "最多兩輪");
    }

    #[test]
    fn 結束碼非零但不是授權碼問題_不重試() {
        let r = rig(vec![Script { exit: Some(2), ..good_script() }], vec![code()]);
        let o = go(&r);
        assert_eq!(o, Outcome::Failed("登入沒有完成（結束碼 2）".to_string()));
        assert_eq!(*r.sp.spawned.borrow(), 1);
    }

    #[test]
    fn 結束碼零但確認不到已登入_或沒在時限內結束_都算失敗() {
        let mut r = rig(vec![good_script()], vec![code()]);
        r.eng.verified = Ok(false);
        assert!(matches!(go(&r), Outcome::Failed(m) if m.contains("確認不到")));
        let r = rig(vec![Script { exit: None, ..good_script() }], vec![code()]);
        let o = go(&r);
        assert!(matches!(&o, Outcome::Failed(m) if m.contains("時限")), "{o:?}");
        assert_eq!(*r.sh.killed.borrow(), 1, "沒結束的要殺掉");
    }

    #[test]
    fn 同一時間只允許一個登入() {
        let r = rig(vec![good_script()], vec![code()]);
        r.busy.store(true, Ordering::SeqCst);
        let o = go(&r);
        assert!(matches!(&o, Outcome::Failed(m) if m.contains("已經有一個登入")), "{o:?}");
        assert_eq!(*r.sp.spawned.borrow(), 0, "不開第二個子程序");
        assert!(r.busy.load(Ordering::SeqCst), "別人的鎖不能被我放開");
    }

    #[test]
    fn 授權碼與網址參數不會出現在任何對外文字() {
        // 子程序把授權碼和網址參數印回來，各種失敗路徑的訊息都不能帶出
        let echo = |exit| Script {
            after: vec![line(&format!("OAuth error: Invalid code {SECRET}")), line(&format!("see {URL}"))],
            exit,
            ..good_script()
        };
        let scenarios: Vec<Rig> = vec![
            rig(vec![echo(Some(1)), echo(Some(1))], vec![code(), code()]),
            rig(vec![Script { exit: Some(2), ..echo(Some(2)) }], vec![code()]),
            rig(vec![echo(None)], vec![code()]),
            rig(vec![echo(Some(0))], vec![code()]),
        ];
        for mut r in scenarios {
            r.eng.verified = Ok(false);
            let o = go(&r);
            let t = all_text(&o);
            for secret in [SECRET, "ST4TE", "CH4LL"] {
                assert!(!t.contains(secret), "結果文字帶出了 {secret}：{t}");
            }
        }
    }

    #[test]
    fn 記_log_前網址參數會遮掉() {
        let s = redact_line(&format!("請開啟 {URL} 登入"));
        assert!(s.contains("https://claude.ai/oauth/authorize?…"), "{s}");
        for p in ["ST4TE", "CH4LL", "code=true"] {
            assert!(!s.contains(p), "{s}");
        }
        assert_eq!(redact_line("沒有網址"), "沒有網址");
        assert_eq!(redact_line("https://claude.ai/x#frag"), "https://claude.ai/x?…");
    }

    #[test]
    fn 授權碼丟掉前會清成零() {
        let mut s = Secret::new("ABC".to_string());
        assert_eq!(s.bytes(), b"ABC");
        s.wipe();
        assert_eq!(s.bytes(), &[0, 0, 0]);
    }

    #[test]
    fn 授權碼用完或丟掉都會清成零() {
        let before = WIPES.with(|c| c.get());
        drop(Secret::new("X".to_string()));
        assert_eq!(WIPES.with(|c| c.get()), before + 1, "丟掉時要清");
        // 整個流程走完（寫進標準輸入後）也要清
        let r = rig(vec![good_script()], vec![code()]);
        let before = WIPES.with(|c| c.get());
        assert_eq!(go(&r), Outcome::Verified);
        assert!(WIPES.with(|c| c.get()) > before, "寫進標準輸入後授權碼立刻清掉");
    }
}

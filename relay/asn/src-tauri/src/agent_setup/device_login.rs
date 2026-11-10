//! 裝置碼型登入（#933 PR-5a）：Codex、Grok 的 `login --device-auth`。子程序印出「登入網址＋一次性代碼」，
//! 本人用任何有瀏覽器的設備打開網址、輸入代碼，子程序自己等到授權完成才結束；ASN 不用收任何東西回來。
//!
//! 這一張只做**本機**：網址與代碼交給這台 ASN 的畫面（`Show`），不經過後台；手機遠端觸發另案（PR-5b，反向加密通道）。
//!
//! 敏感資料的處理（asn真 定案）：
//! - 網址與代碼只存在記憶體（`DeviceCode`，沒有 `Debug`／`Display`／`Clone`，丟掉時盡力清除），只交給 `Show`；
//!   讀進來的每一行用完也清掉。這是**盡力清**：管線讀取的中間緩衝、`Show` 那邊畫面的複本不在這裡的控制內，
//!   不保證記憶體裡完全沒有殘留；
//!   不進 log、不進安裝記錄、不進任何回報或錯誤訊息（對外的文字都是固定字串）。
//! - 子程序的輸出**一行都不寫進 log**，只記讀了幾行。
//! - 登入程序有時限（代碼的有效時間：Codex 印的是 15 分鐘，Grok 沒印、也定 15 分鐘），到時間照 PID 收掉整棵程序樹
//!   本人在這台按取消也一樣收掉。**Grok 例外：只收 grok 本身、不加 /T**——它會自己開瀏覽器，本人當時沒開瀏覽器的話，
//!   新開的瀏覽器是 grok 的子程序，連子孫一起收會把本人的分頁全關掉（`DeviceEngine::kill_whole_tree`，40家用 實測見 `Grok`）。
//!
//! 實測格式（2026-11-09，40家用，暫存設定目錄，只讀不登入）：
//! - Codex 0.167.0：stdout 印一行 `https://auth.openai.com/…`，再印一行 `XXXX-XXXX9` 這種 4＋5 大寫英數的代碼，註明 15 分鐘到期；
//!   不開瀏覽器。確認：`codex login status`，已登出時結束碼 1（stderr 印 Not logged in）。
//! - Grok 1.0.77：stderr 印一行 `https://accounts.x.ai/…`，再印一行 4＋4 大寫英數的代碼，然後等待；**會自己開瀏覽器**。
//!   沒有查得到的「確認已登入」指令（--help 只有 login／logout，usage 要背景服務），所以只回「無法確認」，不猜。
//! - agy：沒有登入子命令，只能在那台電腦前操作畫面登入（`AGY_LOGIN_HINT`）。
//!
//! 這一張只有流程與測試，還沒有任何入口呼叫它（畫面的 `Show` 實作與按鈕在 PR-7 接），所以先關掉「沒用到」的警告。
//! **PR-7 接線時：`Codex`／`Grok` 的 `exe` 一定要來自 `codex_install::usable_here()`／（PR-9 的）grok 對應函式——
//! 那是當下驗過簽署者的那一份；不能直接用 PATH 上找到的 codex／grok。**
#![allow(dead_code)]

use super::proc::{run_capture, strip_ansi, LoginProc, ReadLine, Spawner};
use std::path::PathBuf;
use std::time::{Duration, Instant};

/// 字串用完就盡力清成零（`String` 換成位元組不會重新配置，清的就是原本那塊）
fn wipe(s: String) {
    let mut b = s.into_bytes();
    for x in b.iter_mut() {
        // SAFETY: 指標來自可變參考，必定有效且對齊；用 volatile 避免被最佳化掉
        unsafe { std::ptr::write_volatile(x, 0) };
    }
}

/// 網址＋代碼：只能交給 `Show` 顯示，沒有 Debug／Display／Clone，丟掉時盡力清成零
pub struct DeviceCode {
    url: Vec<u8>,
    code: Vec<u8>,
}

impl DeviceCode {
    fn new(url: String, code: String) -> Self {
        DeviceCode { url: url.into_bytes(), code: code.into_bytes() }
    }
    pub fn url(&self) -> &str {
        std::str::from_utf8(&self.url).unwrap_or("")
    }
    pub fn code(&self) -> &str {
        std::str::from_utf8(&self.code).unwrap_or("")
    }
}

impl Drop for DeviceCode {
    fn drop(&mut self) {
        for b in self.url.iter_mut().chain(self.code.iter_mut()) {
            // SAFETY: 指標來自可變參考，必定有效且對齊；用 volatile 避免被最佳化掉
            unsafe { std::ptr::write_volatile(b, 0) };
        }
    }
}

/// 登入後確認的結果
#[derive(Debug, PartialEq, Eq)]
pub enum Check {
    Yes,
    No,
    /// 確認不了（給人看的固定文字）
    Unknown(String),
}

/// 各家「裝置碼型」登入的差異
pub trait DeviceEngine {
    fn exe(&self) -> PathBuf;
    fn args(&self) -> Vec<&'static str>;
    /// 登入網址只收這些主機（https、完全相等）
    fn url_hosts(&self) -> &'static [&'static str];
    /// 這一行（去掉前後空白後）是不是代碼
    fn is_code(&self, s: &str) -> bool;
    fn check_login(&self) -> Check;
    /// 逾時或取消時要不要連子孫一起收。會自己開瀏覽器的（Grok）回 false：瀏覽器可能是它的子程序，連它一起關會把本人的分頁全關掉
    fn kill_whole_tree(&self) -> bool {
        true
    }
}

/// 收掉登入程序：照這家的規則決定要不要連子孫一起收
fn stop(eng: &dyn DeviceEngine, proc: &mut dyn LoginProc) {
    if eng.kill_whole_tree() {
        proc.kill_tree();
    } else {
        proc.kill_self();
    }
}

/// 把網址與代碼顯示在這台 ASN 的畫面上；`cancelled` 是本人在這台按了取消
pub trait Show {
    fn show(&self, dc: &DeviceCode);
    fn cancelled(&self) -> bool;
}

#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub enum Step {
    WaitingCode,
    Shown,
    Checking,
}

#[derive(Debug, PartialEq, Eq)]
pub enum Outcome {
    Verified,
    /// 登入程序成功結束，但確認不了（例如 Grok）：請本人看那台的畫面
    Unconfirmed(String),
    /// 讀不到網址或代碼：請在這台電腦上用終端機登入
    NeedTerminal(String),
    TimedOut,
    Cancelled,
    Failed(String),
}

pub struct Limits {
    /// 整個登入的上限（從開子程序算起），也是代碼的有效時間
    pub total: Duration,
    /// 等網址與代碼出現的上限
    pub find: Duration,
    pub poll: Duration,
}

impl Default for Limits {
    fn default() -> Self {
        Limits { total: Duration::from_secs(15 * 60), find: Duration::from_secs(60), poll: Duration::from_millis(500) }
    }
}

/// 一行裡第一個 `https://<允許的主機>/…` 網址；主機完全相等、不帶帳密或連接埠，路徑只收可見 ASCII（不含引號、角括號、反斜線等）
pub(crate) fn find_url(line: &str, hosts: &[&str]) -> Option<String> {
    let start = line.find("https://")?;
    let url = line[start..].split(char::is_whitespace).next()?;
    let rest = &url["https://".len()..];
    let (host, path) = match rest.find(['/', '?', '#']) {
        Some(i) => (&rest[..i], &rest[i..]),
        None => (rest, ""),
    };
    if !hosts.contains(&host) {
        return None;
    }
    if !path.bytes().all(|b| (0x21..=0x7e).contains(&b) && !matches!(b, b'"' | b'\'' | b'<' | b'>' | b'\\' | b'^' | b'`' | b'{' | b'|' | b'}')) {
        return None;
    }
    Some(url.to_string())
}

/// 代碼的形狀：大寫英數，用 `-` 分成兩段，各段長度在範圍內（例如 Codex 4＋5、Grok 4＋4）
pub(crate) fn code_shape(s: &str, first: std::ops::RangeInclusive<usize>, second: std::ops::RangeInclusive<usize>) -> bool {
    let mut it = s.split('-');
    let (Some(a), Some(b), None) = (it.next(), it.next(), it.next()) else { return false };
    let ok = |p: &str, r: &std::ops::RangeInclusive<usize>| r.contains(&p.len()) && p.bytes().all(|c| c.is_ascii_uppercase() || c.is_ascii_digit());
    ok(a, &first) && ok(b, &second)
}

/// 跟授權碼送回型共用「同一時間只允許一個登入」
pub fn run_device_login(eng: &dyn DeviceEngine, sp: &dyn Spawner, show: &dyn Show, lim: &Limits, report: &dyn Fn(Step)) -> Outcome {
    run_device_login_with(&|| super::login::try_login_busy().map(|g| Box::new(g) as Box<dyn std::any::Any>), eng, sp, show, lim, report)
}

/// `take` 取「登入中」的鎖（拿不到＝已經有一個登入在進行）；測試用自己的，免得和同時跑的測試搶全域那把
pub fn run_device_login_with(take: &dyn Fn() -> Option<Box<dyn std::any::Any>>, eng: &dyn DeviceEngine, sp: &dyn Spawner, show: &dyn Show, lim: &Limits, report: &dyn Fn(Step)) -> Outcome {
    let Some(_busy) = take() else {
        return Outcome::Failed("已經有一個登入在進行，請等它結束".to_string());
    };
    let started = Instant::now();
    report(Step::WaitingCode);
    let mut proc: Box<dyn LoginProc> = match sp.spawn(&eng.exe(), &eng.args()) {
        Ok(p) => p,
        Err(e) => return Outcome::Failed(e),
    };

    // 1. 讀出網址與代碼（網址在前、代碼在後）。內容一行都不記，只算行數
    let (mut url, mut code): (Option<String>, Option<String>) = (None, None);
    let mut lines = 0u32;
    while url.is_none() || code.is_none() {
        if show.cancelled() {
            stop(eng, proc.as_mut());
            return Outcome::Cancelled;
        }
        if started.elapsed() >= lim.find {
            break;
        }
        match proc.read_line(lim.poll) {
            ReadLine::Line(raw) => {
                lines += 1;
                let clean = strip_ansi(&raw);
                let t = clean.trim();
                if url.is_none() {
                    url = find_url(t, eng.url_hosts());
                } else if code.is_none() && eng.is_code(t) {
                    code = Some(t.to_string());
                }
                // 讀進來的整行（含網址或代碼）用完就清
                wipe(clean);
                wipe(raw);
            }
            ReadLine::Timeout => {}
            ReadLine::Eof => break,
        }
    }
    elog!("裝置碼登入：讀了 {lines} 行輸出（內容不記）");
    let (Some(url), Some(code)) = (url, code) else {
        stop(eng, proc.as_mut());
        return Outcome::NeedTerminal("讀不到登入網址或代碼，請在這台電腦上用終端機登入".to_string());
    };
    let dc = DeviceCode::new(url, code);
    show.show(&dc);
    drop(dc);
    report(Step::Shown);

    // 2. 等子程序自己結束（本人在別的設備授權完）；到代碼的有效時間就收掉整棵程序樹
    let exit = loop {
        if show.cancelled() {
            stop(eng, proc.as_mut());
            return Outcome::Cancelled;
        }
        if started.elapsed() >= lim.total {
            stop(eng, proc.as_mut());
            return Outcome::TimedOut;
        }
        if let Some(c) = proc.wait(lim.poll) {
            break c;
        }
        // 把輸出讀掉（不記），免得子程序寫滿管線卡住
        while let ReadLine::Line(_) = proc.read_line(Duration::from_millis(1)) {}
    };
    if exit != 0 {
        return Outcome::Failed(format!("登入沒有完成（結束碼 {exit}）"));
    }
    report(Step::Checking);
    match eng.check_login() {
        Check::Yes => Outcome::Verified,
        Check::No => Outcome::Failed("登入程序結束了，但確認不到已登入".to_string()),
        Check::Unknown(m) => Outcome::Unconfirmed(m),
    }
}

/// Codex：`codex login --device-auth`；確認用 `codex login status`
pub struct Codex {
    pub exe: PathBuf,
}
pub const CODEX_HOSTS: [&str; 1] = ["auth.openai.com"];
const STATUS_TIMEOUT: Duration = Duration::from_secs(30);

impl DeviceEngine for Codex {
    fn exe(&self) -> PathBuf {
        self.exe.clone()
    }
    fn args(&self) -> Vec<&'static str> {
        vec!["login", "--device-auth"]
    }
    fn url_hosts(&self) -> &'static [&'static str] {
        &CODEX_HOSTS
    }
    /// 實測 0.167.0 是 4＋5，收緊到實測的長度（格式改了寧可讀不到、請本人用終端機，也不放寬去猜）
    fn is_code(&self, s: &str) -> bool {
        code_shape(s, 4..=4, 5..=5)
    }
    fn check_login(&self) -> Check {
        codex_status(run_capture(&self.exe, &["login", "status"], STATUS_TIMEOUT))
    }
}

/// `codex login status` 的結束碼：0＝已登入；1＝沒登入（實測已登出時是 1）；其他或跑不起來＝確認不了
pub(crate) fn codex_status(r: Result<(i32, String), String>) -> Check {
    match r {
        Ok((0, _)) => Check::Yes,
        Ok((1, _)) => Check::No,
        _ => Check::Unknown("無法確認 Codex 已登入，請本人看那台電腦的畫面".to_string()),
    }
}

/// Grok：`grok login --device-auth`；沒有可靠的確認方式，只回「無法確認」
pub struct Grok {
    pub exe: PathBuf,
}
pub const GROK_HOSTS: [&str; 1] = ["accounts.x.ai"];
pub const GROK_UNCONFIRMED: &str = "無法確認 Grok 已登入，請本人看那台電腦的畫面";

impl DeviceEngine for Grok {
    fn exe(&self) -> PathBuf {
        self.exe.clone()
    }
    fn args(&self) -> Vec<&'static str> {
        vec!["login", "--device-auth"]
    }
    fn url_hosts(&self) -> &'static [&'static str] {
        &GROK_HOSTS
    }
    /// 實測 1.0.77 是 4＋4，收緊到實測的長度（格式改了寧可讀不到、請本人用終端機，也不放寬去猜）
    fn is_code(&self, s: &str) -> bool {
        code_shape(s, 4..=4, 4..=4)
    }
    fn check_login(&self) -> Check {
        Check::Unknown(GROK_UNCONFIRMED.to_string())
    }
    /// 40家用 實測（11-09）：grok 的子程序只有 conhost 和它自己開的瀏覽器（瀏覽器主程序是 grok 的直接子程序）。
    /// 只收 grok 本身時 conhost 跟著結束、瀏覽器留著，沒有其他程序殘留；加 /T 則會把瀏覽器整個關掉
    fn kill_whole_tree(&self) -> bool {
        false
    }
}

/// agy 沒有登入子命令，只能在那台電腦前操作畫面登入（不自動送鍵）
pub const AGY_LOGIN_HINT: &str = "Gemini 要在那台電腦前登入：打開 ASN →設定→啟動設定→登入 Gemini。";

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    /// 給別的模組的測試造一份網址＋代碼（只在測試）
    impl DeviceCode {
        pub(crate) fn for_test(url: &str, code: &str) -> Self {
            Self::new(url.to_string(), code.to_string())
        }
    }
    use std::collections::VecDeque;
    use std::path::Path;
    use std::rc::Rc;

    fn free() -> Option<Box<dyn std::any::Any>> {
        Some(Box::new(()))
    }

    #[derive(Default)]
    struct Shared {
        killed: RefCell<u32>,
        /// 只收自己（不加 /T）的次數
        killed_self: RefCell<u32>,
        spawned: RefCell<Vec<Vec<String>>>,
    }
    struct FakeProc {
        lines: VecDeque<ReadLine>,
        /// `wait` 第幾次呼叫時結束、結束碼
        exit_at: Option<(u32, i32)>,
        waits: u32,
        sh: Rc<Shared>,
    }
    impl LoginProc for FakeProc {
        fn read_line(&mut self, _t: Duration) -> ReadLine {
            self.lines.pop_front().unwrap_or(ReadLine::Timeout)
        }
        fn write_stdin(&mut self, _d: &[u8]) -> Result<(), String> {
            panic!("裝置碼型不寫標準輸入")
        }
        fn wait(&mut self, _t: Duration) -> Option<i32> {
            self.waits += 1;
            match self.exit_at {
                Some((n, c)) if self.waits >= n => Some(c),
                _ => None,
            }
        }
        fn kill_tree(&mut self) {
            *self.sh.killed.borrow_mut() += 1;
        }
        fn kill_self(&mut self) {
            *self.sh.killed_self.borrow_mut() += 1;
        }
    }
    struct FakeSpawner(RefCell<Option<FakeProc>>, Rc<Shared>);
    impl Spawner for FakeSpawner {
        fn spawn(&self, _exe: &Path, args: &[&str]) -> Result<Box<dyn LoginProc>, String> {
            self.1.spawned.borrow_mut().push(args.iter().map(|s| s.to_string()).collect());
            Ok(Box::new(self.0.borrow_mut().take().expect("只開一次")))
        }
    }
    fn spawner(lines: &[&str], exit_at: Option<(u32, i32)>) -> (FakeSpawner, Rc<Shared>) {
        let sh = Rc::new(Shared::default());
        let p = FakeProc { lines: lines.iter().map(|l| ReadLine::Line(l.to_string())).collect(), exit_at, waits: 0, sh: sh.clone() };
        (FakeSpawner(RefCell::new(Some(p)), sh.clone()), sh)
    }

    #[derive(Default)]
    struct FakeShow {
        got: RefCell<Vec<(String, String)>>,
        cancel_after_show: bool,
        cancel_now: bool,
    }
    impl Show for FakeShow {
        fn show(&self, dc: &DeviceCode) {
            self.got.borrow_mut().push((dc.url().to_string(), dc.code().to_string()));
        }
        fn cancelled(&self) -> bool {
            self.cancel_now || (self.cancel_after_show && !self.got.borrow().is_empty())
        }
    }

    struct Eng(Check);
    impl DeviceEngine for Eng {
        fn kill_whole_tree(&self) -> bool {
            true
        }
        fn exe(&self) -> PathBuf {
            PathBuf::from("codex.exe")
        }
        fn args(&self) -> Vec<&'static str> {
            vec!["login", "--device-auth"]
        }
        fn url_hosts(&self) -> &'static [&'static str] {
            &CODEX_HOSTS
        }
        fn is_code(&self, s: &str) -> bool {
            code_shape(s, 4..=5, 4..=6)
        }
        fn check_login(&self) -> Check {
            match &self.0 {
                Check::Yes => Check::Yes,
                Check::No => Check::No,
                Check::Unknown(m) => Check::Unknown(m.clone()),
            }
        }
    }

    // 假的代碼與網址（格式照實測，值是編的）
    const CODEX_OUT: [&str; 8] = ["Welcome to Codex [v0.167.0]", "Follow these steps to sign in with ChatGPT using device code authorization:", "1. Open this link in your browser and sign in to your account", "   \x1b[94mhttps://auth.openai.com/codex/device\x1b[0m", "", "2. Enter this one-time code (expires in 15 minutes)", "   \x1b[94mAB12-C3DE4\x1b[0m", ""];
    const LIM: Limits = Limits { total: Duration::from_secs(3600), find: Duration::from_secs(3600), poll: Duration::from_millis(1) };

    #[test]
    fn 讀到網址和代碼_交給畫面_等程序結束_確認已登入() {
        let (sp, sh) = spawner(&CODEX_OUT, Some((3, 0)));
        let show = FakeShow::default();
        let steps = RefCell::new(vec![]);
        let o = run_device_login_with(&free, &Eng(Check::Yes), &sp, &show, &LIM, &|s| steps.borrow_mut().push(s));
        assert_eq!(o, Outcome::Verified);
        assert_eq!(*show.got.borrow(), vec![("https://auth.openai.com/codex/device".to_string(), "AB12-C3DE4".to_string())]);
        assert_eq!(*steps.borrow(), vec![Step::WaitingCode, Step::Shown, Step::Checking]);
        assert_eq!(*sh.killed.borrow(), 0);
        assert_eq!(sh.spawned.borrow()[0], vec!["login", "--device-auth"]);
    }

    #[test]
    fn 程序結束但確認不到或確認不了() {
        let (sp, _) = spawner(&CODEX_OUT, Some((1, 0)));
        assert!(matches!(run_device_login_with(&free, &Eng(Check::No), &sp, &FakeShow::default(), &LIM, &|_| {}), Outcome::Failed(_)));
        let (sp, _) = spawner(&CODEX_OUT, Some((1, 0)));
        assert_eq!(run_device_login_with(&free, &Eng(Check::Unknown(GROK_UNCONFIRMED.into())), &sp, &FakeShow::default(), &LIM, &|_| {}), Outcome::Unconfirmed(GROK_UNCONFIRMED.into()));
        let (sp, _) = spawner(&CODEX_OUT, Some((1, 2)));
        assert_eq!(run_device_login_with(&free, &Eng(Check::Yes), &sp, &FakeShow::default(), &LIM, &|_| {}), Outcome::Failed("登入沒有完成（結束碼 2）".into()));
    }

    #[test]
    fn 到代碼的有效時間就收掉整棵程序樹() {
        let (sp, sh) = spawner(&CODEX_OUT, None);
        let lim = Limits { total: Duration::from_millis(30), find: Duration::from_secs(3600), poll: Duration::from_millis(1) };
        let show = FakeShow::default();
        assert_eq!(run_device_login_with(&free, &Eng(Check::Yes), &sp, &show, &lim, &|_| {}), Outcome::TimedOut);
        assert_eq!(*sh.killed.borrow(), 1);
        assert_eq!(show.got.borrow().len(), 1, "逾時前已經顯示過");
        assert_eq!(Limits::default().total, Duration::from_secs(900), "預設 15 分鐘");
    }

    /// 會自己開瀏覽器的（Grok）：逾時、取消、讀不到代碼都只收它本身，絕不用 /T（瀏覽器可能是它的子程序）
    struct NoTree;
    impl DeviceEngine for NoTree {
        fn exe(&self) -> PathBuf {
            PathBuf::from("grok.exe")
        }
        fn args(&self) -> Vec<&'static str> {
            vec!["login", "--device-auth"]
        }
        fn url_hosts(&self) -> &'static [&'static str] {
            &CODEX_HOSTS
        }
        fn is_code(&self, s: &str) -> bool {
            code_shape(s, 4..=4, 5..=5)
        }
        fn check_login(&self) -> Check {
            Check::Unknown(GROK_UNCONFIRMED.into())
        }
        fn kill_whole_tree(&self) -> bool {
            false
        }
    }

    #[test]
    fn 會開瀏覽器的家_逾時取消讀不到都只收它本身_不收整棵樹() {
        let lim = Limits { total: Duration::from_millis(30), find: Duration::from_secs(3600), poll: Duration::from_millis(1) };
        let (sp, sh) = spawner(&CODEX_OUT, None);
        assert_eq!(run_device_login_with(&free, &NoTree, &sp, &FakeShow::default(), &lim, &|_| {}), Outcome::TimedOut);
        assert_eq!((*sh.killed.borrow(), *sh.killed_self.borrow()), (0, 1), "逾時");
        let (sp, sh) = spawner(&CODEX_OUT, None);
        let show = FakeShow { cancel_after_show: true, ..Default::default() };
        assert_eq!(run_device_login_with(&free, &NoTree, &sp, &show, &LIM, &|_| {}), Outcome::Cancelled);
        assert_eq!((*sh.killed.borrow(), *sh.killed_self.borrow()), (0, 1), "取消");
        let sh = Rc::new(Shared::default());
        let p = FakeProc { lines: [ReadLine::Line("nothing".into()), ReadLine::Eof].into_iter().collect(), exit_at: None, waits: 0, sh: sh.clone() };
        let sp = FakeSpawner(RefCell::new(Some(p)), sh.clone());
        assert!(matches!(run_device_login_with(&free, &NoTree, &sp, &FakeShow::default(), &LIM, &|_| {}), Outcome::NeedTerminal(_)));
        assert_eq!((*sh.killed.borrow(), *sh.killed_self.borrow()), (0, 1), "讀不到");
        assert!(!Grok { exe: PathBuf::new() }.kill_whole_tree(), "Grok 不收整棵樹");
        assert!(Codex { exe: PathBuf::new() }.kill_whole_tree(), "Codex 不開瀏覽器，收整棵樹");
    }

    #[test]
    fn 本人取消就收掉程序樹() {
        let (sp, sh) = spawner(&CODEX_OUT, None);
        let show = FakeShow { cancel_after_show: true, ..Default::default() };
        assert_eq!(run_device_login_with(&free, &Eng(Check::Yes), &sp, &show, &LIM, &|_| {}), Outcome::Cancelled);
        assert_eq!(*sh.killed.borrow(), 1);
        let (sp, sh) = spawner(&CODEX_OUT, None);
        let show = FakeShow { cancel_now: true, ..Default::default() };
        assert_eq!(run_device_login_with(&free, &Eng(Check::Yes), &sp, &show, &LIM, &|_| {}), Outcome::Cancelled);
        assert_eq!(*sh.killed.borrow(), 1);
        assert!(show.got.borrow().is_empty(), "還沒顯示就取消");
    }

    #[test]
    fn 讀不到網址或代碼_收掉並請本人用終端機() {
        for lines in [vec!["Welcome", "   https://evil.example/codex/device", "   AB12-C3DE4"], vec!["   https://auth.openai.com/x"], vec!["   AB12-C3DE4", "   https://auth.openai.com/x"]] {
            let mut l = lines.clone();
            l.push("");
            let sh = Rc::new(Shared::default());
            let p = FakeProc { lines: l.iter().map(|s| ReadLine::Line(s.to_string())).chain([ReadLine::Eof]).collect(), exit_at: None, waits: 0, sh: sh.clone() };
            let sp = FakeSpawner(RefCell::new(Some(p)), sh.clone());
            let show = FakeShow::default();
            assert!(matches!(run_device_login_with(&free, &Eng(Check::Yes), &sp, &show, &LIM, &|_| {}), Outcome::NeedTerminal(_)), "{lines:?}");
            assert_eq!(*sh.killed.borrow(), 1);
            assert!(show.got.borrow().is_empty(), "{lines:?}：不完整就不顯示");
        }
    }

    #[test]
    fn 同一時間只允許一個登入_和授權碼送回型共用() {
        let (sp, sh) = spawner(&CODEX_OUT, Some((1, 0)));
        assert!(matches!(run_device_login_with(&|| None, &Eng(Check::Yes), &sp, &FakeShow::default(), &LIM, &|_| {}), Outcome::Failed(m) if m.contains("已經有一個登入")));
        assert!(sh.spawned.borrow().is_empty(), "不開子程序");
        // 正式入口用的是授權碼送回型那一把
        let src = include_str!("device_login.rs");
        assert!(src.contains("run_device_login_with(&|| super::login::try_login_busy()"));
    }

    #[test]
    fn 網址只收允許的主機_路徑只收安全字元() {
        let h = &CODEX_HOSTS[..];
        assert_eq!(find_url("   https://auth.openai.com/codex/device", h).as_deref(), Some("https://auth.openai.com/codex/device"));
        assert_eq!(find_url("open https://auth.openai.com/codex/device?x=1 now", h).as_deref(), Some("https://auth.openai.com/codex/device?x=1"));
        for bad in ["http://auth.openai.com/x", "https://auth.openai.com.evil.com/x", "https://evil.com/auth.openai.com", "https://x@auth.openai.com/x", "https://auth.openai.com:8443/x", "https://sub.auth.openai.com/x", "https://auth.openai.com/a\"b", "https://auth.openai.com/a<b", "沒有網址"] {
            assert_eq!(find_url(bad, h), None, "{bad}");
        }
        assert_eq!(find_url("https://accounts.x.ai/device", &GROK_HOSTS[..]).as_deref(), Some("https://accounts.x.ai/device"));
        assert_eq!(find_url("https://accounts.x.ai/device", h), None, "Codex 不收 x.ai");
    }

    #[test]
    fn 代碼形狀() {
        let c = Codex { exe: PathBuf::new() };
        let g = Grok { exe: PathBuf::new() };
        assert!(c.is_code("AB12-C3DE4") && g.is_code("A1BC-DEFG"));
        for bad in ["ab12-c3de4", "AB12", "AB12-C3DE4-X", "AB-CD", "AB12 C3DE4", "AB12-C3DE4 ", "1. Open", "", "AB12-C3DE45", "ABC12-C3DE4", "AB12-C3DE"] {
            assert!(!c.is_code(bad), "{bad:?}");
        }
        for bad in ["A1BC-DEFGH", "A1BCD-DEFG", "A1B-DEFG", "a1bc-defg"] {
            assert!(!g.is_code(bad), "{bad:?}");
        }
    }

    #[test]
    fn codex_的確認看結束碼_其他一律確認不了() {
        assert_eq!(codex_status(Ok((0, String::new()))), Check::Yes);
        assert_eq!(codex_status(Ok((1, String::new()))), Check::No);
        assert!(matches!(codex_status(Ok((2, String::new()))), Check::Unknown(_)));
        assert!(matches!(codex_status(Err("跑不起來".into())), Check::Unknown(_)));
        assert_eq!(Grok { exe: PathBuf::new() }.check_login(), Check::Unknown(GROK_UNCONFIRMED.into()));
    }

    /// 守衛：子程序輸出、網址、代碼不能進 log；DeviceCode 不能被印出或複製
    #[test]
    fn 守衛_輸出網址代碼都不進_log() {
        let src = include_str!("device_login.rs");
        let body = &src[..src.find("#[cfg(test)]").unwrap()];
        let logs: Vec<&str> = body.lines().filter(|l| l.contains("elog!(")).collect();
        assert_eq!(logs.len(), 1, "只有一行記行數：{logs:?}");
        assert!(logs[0].contains("{lines}") && !logs[0].contains("raw") && !logs[0].contains("clean") && !logs[0].contains("url") && !logs[0].contains("code"), "{}", logs[0]);
        let decl = &body[body.find("pub struct DeviceCode").unwrap() - 120..body.find("pub struct DeviceCode").unwrap()];
        assert!(!decl.contains("derive"), "DeviceCode 不能 derive（Debug／Clone）");
        assert!(!body.contains("impl std::fmt::Debug for DeviceCode") && !body.contains("impl std::fmt::Display for DeviceCode") && !body.contains("impl Clone for DeviceCode"));
    }
}

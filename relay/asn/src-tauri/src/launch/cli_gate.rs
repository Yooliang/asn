//! 終端服務指令（`wezterm cli`）的統一出口（#2424 D）。
//! 終端服務間歇性變慢時，ASN 每次都另開一個 cli 子程序、逾時就砍，沒有排隊也沒有節流，會越轟炸越慢。
//! 這裡只管三件事，不碰指令本身的內容：
//! 1. 同一個連線檔同時最多 [`MAX_CONCURRENT`] 條指令在跑，其餘排隊等（有上限，等不到就不送）。
//!    背景的例行工作（讀畫面、掃已結束的窗格）最多只佔 [`ROUTINE_MAX`] 條，永遠留位子給使用者動作與接回。
//! 2. 任何一條指令逾時或連不上後，例行工作暫停一小段時間（連續失敗越停越久）；
//!    使用者動作（按允許、看畫面、開窗、接回、關窗格…）不受暫停影響（但仍要排隊）。
//!    「例行」由呼叫端用 [`routine`] 明確標出來，不看子指令名。
//! 3. 每次逾時或失敗在 ui.log 寫一行：子指令名、耗時、結果。不寫畫面內容、不寫完整參數。
//!
//! 呼叫點只有 `RealRunner::run`／`run_clean`（見 wezterm.rs）：所有 cli 都從那兩個函式出去。
//! 正式與測試走同一條程式碼：閘門的各項上限都由建構時注入（[`Limits`]），[`Limits::production`] 只回正式值。
#![cfg(desktop)]

use super::wezterm::{RunOutput, CANNOT_RUN};
use std::cell::Cell;
use std::collections::BTreeMap;
use std::sync::{Condvar, Mutex, OnceLock};
use std::time::{Duration, Instant};

/// 同一個連線檔同時在跑的 cli 上限
pub const MAX_CONCURRENT: usize = 2;
/// 其中例行工作最多佔幾條（其餘位子永遠留給非例行的指令）
pub const ROUTINE_MAX: usize = 1;
/// 排隊最久等多久（比單條 cli 的逾時長一點，前面兩條都逾時之後下一條還輪得到）
pub const QUEUE_WAIT: Duration = Duration::from_secs(20);
/// 例行工作暫停的起始長度，連續失敗每次加倍
pub const COOL_BASE: Duration = Duration::from_secs(30);
/// 暫停的長度上限
pub const COOL_MAX: Duration = Duration::from_secs(300);
/// 排隊等不到位子時錯誤訊息的開頭（呼叫端靠它分辨「這條指令根本沒送出」）
pub const QUEUE_TIMEOUT: &str = "終端服務忙碌";
/// 例行工作被暫停時錯誤訊息的開頭
pub const SKIPPED: &str = "終端服務剛才沒有回應，暫時略過讀畫面";

/// 這個錯誤訊息代表「指令根本沒有送出去」（執行檔起不來、排隊等不到、被暫停略過）：
/// 窗格不可能因此被開出來，開窗那一邊可以放心當作沒開；
/// 它也**不是**「終端服務沒有回應」的證據：連線測試、卡死處置都不能因此當成服務掛了
pub fn not_sent(e: &str) -> bool {
    e.starts_with(CANNOT_RUN) || e.starts_with(QUEUE_TIMEOUT) || e.starts_with(SKIPPED)
}

/// 這個錯誤是例行工作被暫停略過（呼叫端不要把它算成讀取失敗）
pub fn is_skipped(e: &str) -> bool {
    e.starts_with(SKIPPED)
}

/// 實際去跑 cli 那一步的失敗，分型別（不靠比對訊息文字）
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ExecErr {
    /// 執行檔起不來（缺檔、被擋、權限）：這台電腦的問題，不是終端服務沒回應
    CannotRun(String),
    /// 逾時（已結束該子程序）
    Timeout(String),
    /// 其他（例如等待子程序失敗）
    Other(String),
}

impl ExecErr {
    pub fn into_message(self) -> String {
        match self {
            ExecErr::CannotRun(m) | ExecErr::Timeout(m) | ExecErr::Other(m) => m,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Limits {
    /// 同時在跑的上限
    pub max: usize,
    /// 其中例行工作最多幾條（要比 `max` 小，才留得出位子給非例行）
    pub routine_max: usize,
    pub wait: Duration,
    pub cool_base: Duration,
    pub cool_max: Duration,
}

impl Limits {
    /// 正式值。只有這裡決定正式值，測試用自己建的 [`Limits`]，不靠 `cfg!(test)` 改行為
    pub fn production() -> Self {
        Limits { max: MAX_CONCURRENT, routine_max: ROUTINE_MAX, wait: QUEUE_WAIT, cool_base: COOL_BASE, cool_max: COOL_MAX }
    }

    /// 連續第 `streak` 次失敗後要暫停多久（第 1 次＝起始長度，之後加倍，最長 `cool_max`）
    pub fn cooldown(&self, streak: u32) -> Duration {
        if self.cool_base.is_zero() || streak == 0 {
            return Duration::ZERO;
        }
        let shift = (streak - 1).min(16);
        self.cool_base.saturating_mul(1u32 << shift).min(self.cool_max)
    }
}

#[derive(Default)]
struct Busy {
    /// 在跑的總數
    total: usize,
    /// 其中例行的
    routine: usize,
    /// 正在排隊等位子的
    waiting: usize,
}

#[derive(Default)]
struct State {
    busy: BTreeMap<String, Busy>,
    fails: BTreeMap<String, Fail>,
}

struct Fail {
    streak: u32,
    until: Instant,
}

pub struct CliGate {
    limits: Limits,
    state: Mutex<State>,
    cv: Condvar,
    clock: Box<dyn Fn() -> Instant + Send + Sync>,
    log: Box<dyn Fn(&str) + Send + Sync>,
}

/// 拿到位子的憑證：放掉（含 panic）就把位子還回去並叫醒排隊的
struct Slot<'a> {
    gate: &'a CliGate,
    key: String,
    routine: bool,
}

impl Drop for Slot<'_> {
    fn drop(&mut self) {
        let mut st = self.gate.state.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(b) = st.busy.get_mut(&self.key) {
            b.total = b.total.saturating_sub(1);
            if self.routine {
                b.routine = b.routine.saturating_sub(1);
            }
        }
        tidy(&mut st, &self.key);
        drop(st);
        self.gate.cv.notify_all();
    }
}

/// 沒有人在跑也沒有人在等就把這個連線檔的記錄收掉
fn tidy(st: &mut State, key: &str) {
    if st.busy.get(key).is_some_and(|b| b.total == 0 && b.waiting == 0) {
        st.busy.remove(key);
    }
}

thread_local! {
    static ROUTINE: Cell<bool> = const { Cell::new(false) };
}

/// 把 `f` 裡下的 cli 標成「例行」（背景讀畫面、掃已結束窗格這類背景工作）：
/// 終端服務剛逾時時會被暫停略過，而且最多佔 [`ROUTINE_MAX`] 個位子。
/// 其他（使用者按的、開窗、接回…）一律不要包，那些只排隊、不略過
pub fn routine<T>(f: impl FnOnce() -> T) -> T {
    struct Restore(bool);
    impl Drop for Restore {
        fn drop(&mut self) {
            ROUTINE.with(|r| r.set(self.0));
        }
    }
    let _restore = Restore(ROUTINE.with(|r| r.replace(true)));
    f()
}

fn in_routine() -> bool {
    ROUTINE.with(Cell::get)
}

/// 從參數裡取出 cli 的子指令名（`[--config x] cli --no-auto-start <子指令> …`）；不是 cli 呼叫＝None
pub fn sub_of(args: &[String]) -> Option<&str> {
    let i = args.iter().position(|a| a == "cli")?;
    args[i + 1..].iter().map(String::as_str).find(|a| !a.starts_with("--"))
}

/// stderr 看起來是「連不上終端服務」（不是「找不到那個窗格」這類服務有回應的失敗）
fn looks_unreachable(stderr: &str) -> bool {
    let s = stderr.to_lowercase();
    ["failed to connect", "connection", "os error", "timed out", "timeout", "broken pipe"].iter().any(|m| s.contains(m))
}

/// 逾時或失敗那一行 log 的內文：只有子指令名、耗時、結果（不含畫面內容與完整參數）
pub fn fail_line(sub: &str, ms: u128, what: &str, pause: Option<Duration>) -> String {
    let mut line = format!("終端服務指令 {sub} {what}（耗時 {ms} 毫秒）");
    if let Some(p) = pause {
        line.push_str(&format!("，例行讀畫面暫停 {} 秒", p.as_secs()));
    }
    line
}

impl CliGate {
    pub fn new(limits: Limits) -> Self {
        Self::with(limits, Box::new(Instant::now), Box::new(|l| super::term::view_log(l)))
    }

    pub fn with(limits: Limits, clock: Box<dyn Fn() -> Instant + Send + Sync>, log: Box<dyn Fn(&str) + Send + Sync>) -> Self {
        Self { limits, state: Mutex::new(State::default()), cv: Condvar::new(), clock, log }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// 這個連線檔的例行工作還要暫停多久（沒有暫停＝None）
    pub fn cooldown_left(&self, key: &str) -> Option<Duration> {
        let st = self.lock();
        let f = st.fails.get(key)?;
        let now = (self.clock)();
        (f.until > now).then(|| f.until - now)
    }

    /// 所有連線檔裡最長的暫停還剩多久（都沒有暫停＝None）。背景重試用：暫停期間連 list 都先不叫
    pub fn longest_cooldown(&self) -> Option<Duration> {
        let st = self.lock();
        let now = (self.clock)();
        st.fails.values().filter_map(|f| (f.until > now).then(|| f.until - now)).max()
    }

    /// 這個連線檔現在有幾條在排隊等位子
    pub fn waiting(&self, key: &str) -> usize {
        self.lock().busy.get(key).map_or(0, |b| b.waiting)
    }

    /// 排隊、執行、記結果。`routine`＝這條是背景例行工作（見 [`routine`]）。`exec` 才是真的去跑 cli 的那一步
    pub fn run(&self, key: &str, sub: &str, routine: bool, exec: impl FnOnce() -> Result<RunOutput, ExecErr>) -> Result<RunOutput, String> {
        if routine {
            if let Some(left) = self.cooldown_left(key) {
                return Err(format!("{SKIPPED}（約 {} 秒後再試）", left.as_secs() + 1));
            }
        }
        let slot = self.acquire(key, sub, routine)?;
        let t0 = Instant::now();
        let r = exec();
        // 先還位子、再記 log／狀態：寫檔慢不能佔著位子
        drop(slot);
        self.note(key, sub, t0.elapsed().as_millis(), &r);
        r.map_err(ExecErr::into_message)
    }

    fn acquire(&self, key: &str, sub: &str, routine: bool) -> Result<Slot<'_>, String> {
        let deadline = Instant::now() + self.limits.wait;
        let mut st = self.lock();
        let mut waiting = false;
        loop {
            let b = st.busy.entry(key.to_string()).or_default();
            if b.total < self.limits.max && (!routine || b.routine < self.limits.routine_max) {
                b.total += 1;
                b.routine += usize::from(routine);
                b.waiting = b.waiting.saturating_sub(usize::from(waiting));
                return Ok(Slot { gate: self, key: key.to_string(), routine });
            }
            let now = Instant::now();
            if now >= deadline {
                b.waiting = b.waiting.saturating_sub(usize::from(waiting));
                tidy(&mut st, key);
                drop(st);
                (self.log)(&format!("終端服務指令 {sub} 排隊 {} 秒仍輪不到，這次沒有送出", self.limits.wait.as_secs()));
                return Err(format!("{QUEUE_TIMEOUT}，排隊 {} 秒仍輪不到，這次沒有送出", self.limits.wait.as_secs()));
            }
            if !waiting {
                b.waiting += 1;
                waiting = true;
            }
            st = self.cv.wait_timeout(st, deadline - now).unwrap_or_else(|e| e.into_inner()).0;
        }
    }

    /// 記這一條的結果：成功或服務有回應就清掉連續失敗；逾時或連不上就累計並暫停例行工作。失敗一律寫一行 log
    fn note(&self, key: &str, sub: &str, ms: u128, r: &Result<RunOutput, ExecErr>) {
        match r {
            Ok(o) if o.success => self.clear(key),
            Ok(o) => {
                let code = o.code.map_or("無結束碼".to_string(), |c| format!("結束碼 {c}"));
                // 服務有回（例如找不到那個窗格）不算它沒回應；stderr 只拿來判斷、不寫進 log
                let pause = looks_unreachable(&o.stderr).then(|| self.mark(key)).flatten();
                if pause.is_none() {
                    self.clear(key);
                }
                (self.log)(&fail_line(sub, ms, &format!("失敗（{code}）"), pause));
            }
            // 執行檔起不來是這台電腦的問題，不是終端服務沒回應：只記一行，不暫停
            Err(ExecErr::CannotRun(_)) => (self.log)(&fail_line(sub, ms, "起不來", None)),
            Err(e) => {
                let what = if matches!(e, ExecErr::Timeout(_)) { "逾時" } else { "出錯" };
                let pause = self.mark(key);
                (self.log)(&fail_line(sub, ms, what, pause));
            }
        }
    }

    fn clear(&self, key: &str) {
        self.lock().fails.remove(key);
    }

    /// 連續失敗加一，回這次要暫停多久（沒開暫停＝None）
    fn mark(&self, key: &str) -> Option<Duration> {
        let mut st = self.lock();
        let streak = st.fails.get(key).map_or(0, |f| f.streak) + 1;
        let pause = self.limits.cooldown(streak);
        let until = (self.clock)() + pause;
        st.fails.insert(key.to_string(), Fail { streak, until });
        (!pause.is_zero()).then_some(pause)
    }
}

/// 正式用的全域閘門（同一個 ASN 行程裡所有 cli 共用）
pub fn global() -> &'static CliGate {
    static G: OnceLock<CliGate> = OnceLock::new();
    G.get_or_init(|| CliGate::new(Limits::production()))
}

/// `RealRunner` 的出口：是 `cli` 呼叫而且帶了連線檔才排隊；其他（`--version` 之類不碰終端服務的）直接執行
pub fn gated(args: &[String], env: &BTreeMap<String, String>, exec: impl FnOnce() -> Result<RunOutput, ExecErr>) -> Result<RunOutput, String> {
    gated_with(global(), args, env, exec)
}

/// 同 [`gated`]，閘門由呼叫端給（測試用自己建的閘門）
pub fn gated_with(gate: &CliGate, args: &[String], env: &BTreeMap<String, String>, exec: impl FnOnce() -> Result<RunOutput, ExecErr>) -> Result<RunOutput, String> {
    match (sub_of(args), env.get("WEZTERM_UNIX_SOCKET")) {
        (Some(sub), Some(sock)) => gate.run(sock, sub, in_routine(), exec),
        _ => exec().map_err(ExecErr::into_message),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::mpsc::channel;
    use std::sync::{Arc, Barrier, Mutex};

    fn ok() -> Result<RunOutput, ExecErr> {
        Ok(RunOutput { success: true, stdout: "ok".into(), stderr: String::new(), code: Some(0) })
    }
    fn timeout() -> Result<RunOutput, ExecErr> {
        Err(ExecErr::Timeout("WezTerm 指令逾時（15 秒），已結束該子行程".into()))
    }

    struct Fake {
        t0: Instant,
        skew: Arc<Mutex<Duration>>,
        lines: Arc<Mutex<Vec<String>>>,
    }
    impl Fake {
        fn gate(limits: Limits) -> (CliGate, Fake) {
            let f = Fake { t0: Instant::now(), skew: Arc::new(Mutex::new(Duration::ZERO)), lines: Arc::new(Mutex::new(Vec::new())) };
            let (t0, skew, lines) = (f.t0, f.skew.clone(), f.lines.clone());
            let g = CliGate::with(limits, Box::new(move || t0 + *skew.lock().unwrap()), Box::new(move |l| lines.lock().unwrap().push(l.to_string())));
            (g, f)
        }
        fn advance(&self, d: Duration) {
            *self.skew.lock().unwrap() += d;
        }
        fn lines(&self) -> Vec<String> {
            self.lines.lock().unwrap().clone()
        }
    }

    /// 測試用的限制：最多 `max` 條、其中例行 `routine_max` 條、排隊最久 `wait_ms`
    fn lim(max: usize, routine_max: usize, wait_ms: u64) -> Limits {
        Limits { max, routine_max, wait: Duration::from_millis(wait_ms), cool_base: Duration::from_secs(30), cool_max: Duration::from_secs(300) }
    }

    /// 放掉時（含測試中途 panic）送出 `n` 個放行訊號，免得卡在等放行的執行緒讓 `thread::scope` 永遠收不了尾
    struct Release(std::sync::mpsc::Sender<()>, usize);
    impl Drop for Release {
        fn drop(&mut self) {
            for _ in 0..self.1 {
                let _ = self.0.send(());
            }
        }
    }

    /// 等到條件成立（只用 yield，不靠固定睡多久；最多等 10 秒，之後讓測試失敗而不是卡住）
    fn spin_until(what: &str, cond: impl Fn() -> bool) {
        let end = Instant::now() + Duration::from_secs(10);
        while !cond() {
            assert!(Instant::now() < end, "等不到：{what}");
            std::thread::yield_now();
        }
    }

    #[test]
    fn 取子指令名_跳過_config_與_no_auto_start() {
        let a = |v: &[&str]| v.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert_eq!(sub_of(&a(&["cli", "--no-auto-start", "get-text", "--pane-id", "7"])), Some("get-text"));
        assert_eq!(sub_of(&a(&["--config", "initial_cols=120", "cli", "--no-auto-start", "spawn", "--new-window"])), Some("spawn"));
        assert_eq!(sub_of(&a(&["--version"])), None);
    }

    /// 決定項 (a)：正式值只由 `production()` 回，不因為編譯成測試而改變（拿掉會紅：例如又把暫停起始值在測試時設成 0）
    #[test]
    fn 正式值_釘住_暫停永遠不是零() {
        let p = Limits::production();
        assert_eq!(p, Limits { max: 2, routine_max: 1, wait: Duration::from_secs(20), cool_base: Duration::from_secs(30), cool_max: Duration::from_secs(300) });
        assert!(!p.cool_base.is_zero() && p.routine_max < p.max, "要有暫停，而且要留位子給非例行");
        assert_eq!(p.cooldown(1), Duration::from_secs(30));
    }

    #[test]
    fn 排隊_同一個連線檔同時最多兩條_第三條等不到就不送() {
        let (g, f) = Fake::gate(lim(2, 1, 100));
        let both_in = Arc::new(Barrier::new(3)); // 兩條在跑＋主執行緒
        let (release_tx, release_rx) = channel::<()>();
        let release_rx = Mutex::new(release_rx);
        std::thread::scope(|s| {
            let _release = Release(release_tx, 2);
            for _ in 0..2 {
                let (g, b, rx) = (&g, both_in.clone(), &release_rx);
                s.spawn(move || {
                    let r = g.run("k", "list", false, || {
                        b.wait();
                        let _ = rx.lock().unwrap().recv();
                        ok()
                    });
                    assert!(r.is_ok());
                });
            }
            both_in.wait(); // 兩條都真的在跑了（證明同時可以兩條）
            let ran = AtomicUsize::new(0);
            let e = g
                .run("k", "list", false, || {
                    ran.fetch_add(1, Ordering::SeqCst);
                    ok()
                })
                .unwrap_err();
            assert!(e.starts_with(QUEUE_TIMEOUT) && not_sent(&e), "{e}");
            assert_eq!(ran.load(Ordering::SeqCst), 0, "排隊逾時時不能另外開程序去跑");
            assert!(f.lines().iter().any(|l| l.contains("list") && l.contains("排隊")), "{:?}", f.lines());
        });
    }

    #[test]
    fn 排隊_不同連線檔各算各的() {
        let (g, _f) = Fake::gate(lim(1, 1, 100));
        let (started_tx, started_rx) = channel::<()>();
        let (release_tx, release_rx) = channel::<()>();
        std::thread::scope(|s| {
            let _release = Release(release_tx, 1);
            let gr = &g;
            s.spawn(move || {
                gr.run("a", "list", false, || {
                    started_tx.send(()).unwrap();
                    let _ = release_rx.recv();
                    ok()
                })
                .unwrap();
            });
            started_rx.recv().unwrap();
            assert!(g.run("b", "list", false, ok).is_ok(), "a 佔滿了，b 照樣進得去");
            assert!(g.run("a", "list", false, ok).is_err(), "同一個連線檔 a 滿了就是滿了");
        });
    }

    #[test]
    fn 位子會還回去_出錯與逾時的指令也不會卡住後面() {
        let (g, _f) = Fake::gate(lim(1, 1, 200));
        for _ in 0..3 {
            let _ = g.run("k", "list", false, timeout);
        }
        assert!(g.run("k", "spawn", false, ok).is_ok());
    }

    /// M5：RAII——執行的那一步 panic，位子也要還回去
    #[test]
    fn 位子會還回去_執行中_panic_也一樣() {
        let (g, _f) = Fake::gate(lim(1, 1, 200));
        let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| g.run("k", "list", false, || -> Result<RunOutput, ExecErr> { panic!("假的當掉") })));
        assert!(r.is_err(), "panic 照常往上傳");
        assert!(g.run("k", "spawn", false, ok).is_ok(), "位子沒還回去的話，這裡會排隊逾時");
        assert_eq!(g.waiting("k"), 0);
    }

    /// H2：兩個位子被慢的例行讀畫面佔住時，使用者動作仍進得去。拿掉「例行最多一條」會紅（第二條例行也拿到位子，永遠沒有在等的）
    #[test]
    fn 位子分配_慢的例行讀畫面最多佔一個_開窗與接回照樣進得去() {
        let (g, _f) = Fake::gate(lim(2, 1, 10_000));
        let (started_tx, started_rx) = channel::<()>();
        let (release_tx, release_rx) = channel::<()>();
        std::thread::scope(|s| {
            let _release = Release(release_tx, 1);
            let gr = &g;
            // 第一條慢的例行：佔住一個位子
            s.spawn(move || {
                gr.run("k", "get-text", true, || {
                    started_tx.send(()).unwrap();
                    let _ = release_rx.recv();
                    ok()
                })
                .unwrap();
            });
            started_rx.recv().unwrap();
            // 第二條例行：不能再佔位子，只能排隊
            s.spawn(move || {
                gr.run("k", "get-text", true, ok).unwrap();
            });
            spin_until("第二條例行讀畫面在排隊", || g.waiting("k") == 1);
            // 這時開窗、接回要用的 list、關窗格都要立刻進得去
            for sub in ["spawn", "list", "kill-pane", "send-text"] {
                assert!(g.run("k", sub, false, ok).is_ok(), "{sub} 不能被例行讀畫面擋住");
            }
        });
        assert_eq!(g.waiting("k"), 0);
    }

    #[test]
    fn 最近失敗_逾時後例行工作略過_使用者動作照跑() {
        let (g, f) = Fake::gate(lim(2, 1, 500));
        assert!(g.run("k", "get-text", true, timeout).is_err());
        let ran = AtomicUsize::new(0);
        let e = g
            .run("k", "get-text", true, || {
                ran.fetch_add(1, Ordering::SeqCst);
                ok()
            })
            .unwrap_err();
        assert!(e.starts_with(SKIPPED) && not_sent(&e) && is_skipped(&e), "{e}");
        assert_eq!(ran.load(Ordering::SeqCst), 0, "暫停期間例行的不能真的去讀");
        // X2：非例行的就算也是 get-text（按允許、代答、看畫面前都先讀畫面）也要照送
        for sub in ["get-text", "spawn", "list", "kill-pane", "send-text", "set-tab-title"] {
            assert!(g.run("k", sub, false, ok).is_ok(), "{sub} 是使用者動作或接回，不受暫停影響");
        }
        assert!(g.run("other", "get-text", true, ok).is_ok(), "別的連線檔不受影響");
        f.advance(Duration::from_secs(31));
        assert!(g.run("k", "get-text", true, ok).is_ok(), "暫停過了就恢復");
    }

    /// X2：被略過不算失敗——不累計、不延長暫停、不多寫 log
    #[test]
    fn 最近失敗_被略過不算失敗() {
        let (g, f) = Fake::gate(lim(2, 1, 500));
        let _ = g.run("k", "get-text", true, timeout);
        let lines = f.lines().len();
        for _ in 0..5 {
            assert!(g.run("k", "get-text", true, ok).unwrap_err().starts_with(SKIPPED));
        }
        assert_eq!(f.lines().len(), lines, "略過不寫 log");
        assert!(g.cooldown_left("k").unwrap() <= Duration::from_secs(30), "略過不延長暫停");
        f.advance(Duration::from_secs(31));
        let _ = g.run("k", "get-text", true, timeout); // 若略過被算成失敗，這裡會是第七次而不是第二次
        assert_eq!(g.cooldown_left("k").unwrap(), Duration::from_secs(60), "第二次失敗＝停 60 秒");
    }

    #[test]
    fn 最近失敗_連續失敗越停越久_有上限_成功就清掉() {
        let l = lim(2, 1, 500);
        assert_eq!([1, 2, 3, 4, 5, 6, 7, 40].map(|n| l.cooldown(n).as_secs()), [30, 60, 120, 240, 300, 300, 300, 300]);
        let (g, f) = Fake::gate(l);
        let _ = g.run("k", "get-text", true, timeout);
        f.advance(Duration::from_secs(31));
        let _ = g.run("k", "get-text", true, timeout); // 第二次失敗：停 60 秒
        f.advance(Duration::from_secs(31));
        assert!(g.run("k", "get-text", true, ok).unwrap_err().starts_with(SKIPPED), "第二次失敗要停更久");
        f.advance(Duration::from_secs(30));
        assert!(g.run("k", "get-text", true, ok).is_ok());
        let _ = g.run("k", "get-text", true, timeout); // 成功清過，又從 30 秒起算
        f.advance(Duration::from_secs(31));
        assert!(g.run("k", "get-text", true, ok).is_ok());
    }

    #[test]
    fn 最近失敗_動作類指令逾時也會讓例行工作暫停() {
        let (g, _f) = Fake::gate(lim(2, 1, 500));
        let _ = g.run("k", "spawn", false, timeout);
        assert!(g.run("k", "get-text", true, ok).unwrap_err().starts_with(SKIPPED));
    }

    #[test]
    fn 最近失敗_連不上算沒回應_找不到窗格不算() {
        let fail = |stderr: &str| Ok(RunOutput { success: false, stdout: String::new(), stderr: stderr.into(), code: Some(1) });
        let (g, _f) = Fake::gate(lim(2, 1, 500));
        let _ = g.run("k", "kill-pane", false, || fail("Error: pane id 9 not found"));
        assert!(g.run("k", "get-text", true, ok).is_ok(), "服務有回應的失敗不暫停");
        let _ = g.run("k", "list", false, || fail("failed to connect to Socket(x): Connection refused (os error 10061)"));
        assert!(g.run("k", "get-text", true, ok).unwrap_err().starts_with(SKIPPED));
    }

    #[test]
    fn 最近失敗_執行檔起不來不算服務沒回應() {
        let (g, f) = Fake::gate(lim(2, 1, 500));
        let _ = g.run("k", "get-text", true, || Err(ExecErr::CannotRun(format!("{CANNOT_RUN} wezterm.exe：找不到"))));
        assert!(g.run("k", "get-text", true, ok).is_ok());
        assert!(f.lines().iter().any(|l| l.contains("起不來")));
    }

    /// 錯誤分類靠型別：訊息裡剛好有「逾時」兩個字的別種錯，不會被當成逾時
    #[test]
    fn 錯誤分類靠型別_不比對訊息文字() {
        let (g, f) = Fake::gate(lim(2, 1, 500));
        let _ = g.run("k", "list", false, || Err(ExecErr::Other("等待子行程失敗：逾時的假訊息".into())));
        let _ = g.run("k2", "list", false, || Err(ExecErr::Timeout("沒有那兩個字的逾時".into())));
        let lines = f.lines();
        assert!(lines[0].contains("出錯") && !lines[0].contains("逾時了"), "{}", lines[0]);
        assert!(lines[1].contains("逾時"), "{}", lines[1]);
    }

    #[test]
    fn 逾時_log_有子指令名與耗時_不含畫面內容與參數() {
        let (g, f) = Fake::gate(lim(2, 1, 500));
        let _ = g.run("k", "get-text", true, timeout);
        let _ = g.run("k2", "list", false, || Ok(RunOutput { success: false, stdout: "機密畫面內容 ABC".into(), stderr: "wezterm 說：failed to connect 機密".into(), code: Some(1) }));
        let lines = f.lines();
        assert_eq!(lines.len(), 2, "{lines:?}");
        assert!(lines[0].contains("get-text") && lines[0].contains("逾時") && lines[0].contains("毫秒") && lines[0].contains("暫停 30 秒"), "{}", lines[0]);
        assert!(lines[1].contains("list") && lines[1].contains("失敗") && lines[1].contains("結束碼 1") && lines[1].contains("毫秒"), "{}", lines[1]);
        let all = lines.join("\n");
        assert!(!all.contains("機密") && !all.contains("ABC"), "log 不能有畫面內容或 stderr：{all}");
    }

    #[test]
    fn 成功的指令不寫_log() {
        let (g, f) = Fake::gate(lim(2, 1, 500));
        g.run("k", "get-text", true, ok).unwrap();
        assert!(f.lines().is_empty());
    }

    /// 例行標記：只在 `routine` 裡有效、出來就還原、panic 也還原；而且只影響標了的那條執行緒
    #[test]
    fn 例行標記_範圍內才算_出來就還原() {
        assert!(!in_routine());
        routine(|| {
            assert!(in_routine());
            routine(|| assert!(in_routine()));
            assert!(in_routine(), "內層結束不能把外層的標記洗掉");
            std::thread::scope(|s| {
                s.spawn(|| assert!(!in_routine(), "別的執行緒不受影響")).join().unwrap();
            });
        });
        assert!(!in_routine());
        let _ = std::panic::catch_unwind(|| routine(|| panic!("假的當掉")));
        assert!(!in_routine(), "panic 也要還原");
    }

    /// 出口：`gated_with` 依呼叫端的標記決定略過與否（不是看子指令名）；不是 cli 的呼叫直接執行
    #[test]
    fn 出口_依呼叫端標記決定略過_不看子指令名() {
        let (g, _f) = Fake::gate(lim(2, 1, 500));
        let args = |sub: &str| ["cli".to_string(), "--no-auto-start".into(), sub.to_string()];
        let env: BTreeMap<String, String> = [("WEZTERM_UNIX_SOCKET".to_string(), "S".to_string())].into_iter().collect();
        let _ = gated_with(&g, &args("get-text"), &env, timeout);
        // 沒標例行（例如按允許前先讀畫面）：照送
        assert!(gated_with(&g, &args("get-text"), &env, ok).is_ok(), "沒標例行的 get-text 不能被略過");
        let _ = gated_with(&g, &args("get-text"), &env, timeout); // 上一條成功把暫停清掉了，再失敗一次
        // 標了例行：略過
        let e = routine(|| gated_with(&g, &args("get-text"), &env, ok)).unwrap_err();
        assert!(is_skipped(&e), "{e}");
        // 不是 cli 的呼叫（沒有 cli 子指令）：不排隊、不略過
        assert!(routine(|| gated_with(&g, &["--version".to_string()], &env, ok)).is_ok());
    }

    #[test]
    fn 出口只有_realrunner_的兩個函式_逾時有收屍() {
        let src = include_str!("wezterm.rs").replace("\r\n", "\n");
        let run = src.split("impl Runner for RealRunner").nth(1).unwrap();
        for f in ["fn run(&self", "fn run_clean(&self"] {
            let body = run.split(f).nth(1).unwrap().split("\n    }\n").next().unwrap();
            assert!(body.contains("cli_gate::gated("), "{f} 要經過統一出口");
        }
        // 逾時：結束之後一定 wait（收屍，不留殭屍程序）
        let exec = src.split("fn exec_typed").nth(1).unwrap().split("const PIPE_DRAIN").next().unwrap();
        let (k, w) = (exec.find("child.kill()").unwrap(), exec.find("child.wait()").unwrap());
        assert!(k < w, "kill 之後要 wait");
    }
}

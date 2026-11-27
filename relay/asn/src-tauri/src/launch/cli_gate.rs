//! 終端服務指令（`wezterm cli`）的統一出口（#2424 D）。
//! 終端服務間歇性變慢時，ASN 每次都另開一個 cli 子程序、逾時就砍，沒有排隊也沒有節流，會越轟炸越慢。
//! 這裡只管三件事，不碰指令本身的內容：
//! 1. 同一個連線檔同時最多 [`MAX_CONCURRENT`] 條指令在跑，其餘排隊等（有上限，等不到就不送）。
//! 2. 任何一條指令逾時或連不上後，例行讀畫面（`get-text`）暫停一小段時間（連續失敗越停越久）；
//!    開窗、接回、關窗格這類使用者動作不受影響（但仍要排隊）。
//! 3. 每次逾時或失敗在 ui.log 寫一行：子指令名、耗時、結果。不寫畫面內容、不寫完整參數。
//! 呼叫點只有 `RealRunner::run`／`run_clean`（見 wezterm.rs）：所有 cli 都從那兩個函式出去。
#![cfg(desktop)]

use super::wezterm::{RunOutput, CANNOT_RUN};
use std::collections::BTreeMap;
use std::sync::{Condvar, Mutex, OnceLock};
use std::time::{Duration, Instant};

/// 同一個連線檔同時在跑的 cli 上限
pub const MAX_CONCURRENT: usize = 2;
/// 排隊最久等多久（比單條 cli 的逾時長一點，前面兩條都逾時之後下一條還輪得到）
pub const QUEUE_WAIT: Duration = Duration::from_secs(20);
/// 例行讀畫面暫停的起始長度，連續失敗每次加倍
pub const COOL_BASE: Duration = Duration::from_secs(30);
/// 暫停的長度上限
pub const COOL_MAX: Duration = Duration::from_secs(300);
/// 排隊等不到位子時錯誤訊息的開頭（呼叫端靠它分辨「這條指令根本沒送出」）
pub const QUEUE_TIMEOUT: &str = "終端服務忙碌";
/// 例行讀畫面被暫停時錯誤訊息的開頭
pub const SKIPPED: &str = "終端服務剛才沒有回應，暫時略過讀畫面";

/// 這個錯誤訊息代表「指令根本沒有送出去」（執行檔起不來、排隊等不到、被暫停略過）：
/// 窗格不可能因此被開出來，開窗那一邊可以放心當作沒開
pub fn not_sent(e: &str) -> bool {
    e.starts_with(CANNOT_RUN) || e.starts_with(QUEUE_TIMEOUT) || e.starts_with(SKIPPED)
}

#[derive(Debug, Clone, Copy)]
pub struct Limits {
    pub max: usize,
    pub wait: Duration,
    pub cool_base: Duration,
    pub cool_max: Duration,
}

impl Limits {
    pub fn production() -> Self {
        // 單元測試裡不啟用暫停：既有測試用假的執行器回失敗，不該被別的測試的失敗記錄牽連
        let cool_base = if cfg!(test) { Duration::ZERO } else { COOL_BASE };
        Limits { max: MAX_CONCURRENT, wait: QUEUE_WAIT, cool_base, cool_max: COOL_MAX }
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
struct State {
    busy: BTreeMap<String, usize>,
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
}

impl Drop for Slot<'_> {
    fn drop(&mut self) {
        let mut st = self.gate.state.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(n) = st.busy.get_mut(&self.key) {
            *n = n.saturating_sub(1);
            if *n == 0 {
                st.busy.remove(&self.key);
            }
        }
        drop(st);
        self.gate.cv.notify_all();
    }
}

/// 例行（可以暫停的）子指令：只有讀畫面
fn is_routine(sub: &str) -> bool {
    sub == "get-text"
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

    /// 這個連線檔的例行讀畫面還要暫停多久（沒有暫停＝None）
    pub fn cooldown_left(&self, key: &str) -> Option<Duration> {
        let st = self.lock();
        let f = st.fails.get(key)?;
        let now = (self.clock)();
        (f.until > now).then(|| f.until - now)
    }

    /// 排隊、執行、記結果。`exec` 才是真的去跑 cli 的那一步
    pub fn run(&self, key: &str, sub: &str, exec: impl FnOnce() -> Result<RunOutput, String>) -> Result<RunOutput, String> {
        if is_routine(sub) {
            if let Some(left) = self.cooldown_left(key) {
                return Err(format!("{SKIPPED}（約 {} 秒後再試）", left.as_secs() + 1));
            }
        }
        let _slot = self.acquire(key, sub)?;
        let t0 = Instant::now();
        let r = exec();
        self.note(key, sub, t0.elapsed().as_millis(), &r);
        r
    }

    fn acquire(&self, key: &str, sub: &str) -> Result<Slot<'_>, String> {
        let deadline = Instant::now() + self.limits.wait;
        let mut st = self.lock();
        loop {
            let n = st.busy.get(key).copied().unwrap_or(0);
            if n < self.limits.max {
                st.busy.insert(key.to_string(), n + 1);
                return Ok(Slot { gate: self, key: key.to_string() });
            }
            let now = Instant::now();
            if now >= deadline {
                drop(st);
                (self.log)(&format!("終端服務指令 {sub} 排隊 {} 秒仍輪不到，這次沒有送出", self.limits.wait.as_secs()));
                return Err(format!("{QUEUE_TIMEOUT}，排隊 {} 秒仍輪不到，這次沒有送出", self.limits.wait.as_secs()));
            }
            st = self.cv.wait_timeout(st, deadline - now).unwrap_or_else(|e| e.into_inner()).0;
        }
    }

    /// 記這一條的結果：成功或服務有回應就清掉連續失敗；逾時或連不上就累計並暫停例行讀畫面。失敗一律寫一行 log
    fn note(&self, key: &str, sub: &str, ms: u128, r: &Result<RunOutput, String>) {
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
            Err(e) if e.starts_with(CANNOT_RUN) => (self.log)(&fail_line(sub, ms, "起不來", None)),
            Err(e) => {
                let what = if e.contains("逾時") { "逾時" } else { "出錯" };
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
pub fn gated(args: &[String], env: &BTreeMap<String, String>, exec: impl FnOnce() -> Result<RunOutput, String>) -> Result<RunOutput, String> {
    match (sub_of(args), env.get("WEZTERM_UNIX_SOCKET")) {
        (Some(sub), Some(sock)) => global().run(sock, sub, exec),
        _ => exec(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{Arc, Mutex};

    fn ok() -> Result<RunOutput, String> {
        Ok(RunOutput { success: true, stdout: "ok".into(), stderr: String::new(), code: Some(0) })
    }
    fn timeout() -> Result<RunOutput, String> {
        Err("WezTerm 指令逾時（15 秒），已結束該子行程".into())
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

    fn lim(max: usize, wait_ms: u64) -> Limits {
        Limits { max, wait: Duration::from_millis(wait_ms), cool_base: Duration::from_secs(30), cool_max: Duration::from_secs(300) }
    }

    #[test]
    fn 取子指令名_跳過_config_與_no_auto_start() {
        let a = |v: &[&str]| v.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert_eq!(sub_of(&a(&["cli", "--no-auto-start", "get-text", "--pane-id", "7"])), Some("get-text"));
        assert_eq!(sub_of(&a(&["--config", "initial_cols=120", "cli", "--no-auto-start", "spawn", "--new-window"])), Some("spawn"));
        assert_eq!(sub_of(&a(&["--version"])), None);
    }

    #[test]
    fn 排隊_同一個連線檔同時在跑的不超過兩個() {
        let (g, _f) = Fake::gate(lim(2, 10_000));
        let (cur, peak) = (AtomicUsize::new(0), AtomicUsize::new(0));
        std::thread::scope(|s| {
            for _ in 0..8 {
                s.spawn(|| {
                    let r = g.run("sockA", "list", || {
                        let n = cur.fetch_add(1, Ordering::SeqCst) + 1;
                        peak.fetch_max(n, Ordering::SeqCst);
                        std::thread::sleep(Duration::from_millis(40));
                        cur.fetch_sub(1, Ordering::SeqCst);
                        ok()
                    });
                    assert!(r.is_ok());
                });
            }
        });
        assert_eq!(peak.load(Ordering::SeqCst), 2, "同時在跑的最多兩個，而且有真的用到兩個");
    }

    #[test]
    fn 排隊_不同連線檔各算各的() {
        let (g, _f) = Fake::gate(lim(1, 2_000));
        let (cur, peak) = (AtomicUsize::new(0), AtomicUsize::new(0));
        std::thread::scope(|s| {
            for k in ["a", "b"] {
                let (g, cur, peak) = (&g, &cur, &peak);
                s.spawn(move || {
                    g.run(k, "list", || {
                        let n = cur.fetch_add(1, Ordering::SeqCst) + 1;
                        peak.fetch_max(n, Ordering::SeqCst);
                        std::thread::sleep(Duration::from_millis(150));
                        cur.fetch_sub(1, Ordering::SeqCst);
                        ok()
                    })
                    .unwrap();
                });
            }
        });
        assert_eq!(peak.load(Ordering::SeqCst), 2, "兩個連線檔互不排擠");
    }

    #[test]
    fn 排隊_等不到位子就不送_錯誤說沒有送出() {
        let (g, f) = Fake::gate(lim(1, 60));
        let ran = AtomicUsize::new(0);
        std::thread::scope(|s| {
            s.spawn(|| {
                g.run("k", "spawn", || {
                    std::thread::sleep(Duration::from_millis(400));
                    ok()
                })
                .unwrap();
            });
            std::thread::sleep(Duration::from_millis(80));
            let e = g
                .run("k", "list", || {
                    ran.fetch_add(1, Ordering::SeqCst);
                    ok()
                })
                .unwrap_err();
            assert!(e.starts_with(QUEUE_TIMEOUT) && not_sent(&e), "{e}");
        });
        assert_eq!(ran.load(Ordering::SeqCst), 0, "排隊逾時時不能另外開程序去跑");
        assert!(f.lines().iter().any(|l| l.contains("list") && l.contains("排隊")), "{:?}", f.lines());
    }

    #[test]
    fn 位子會還回去_出錯的指令也不會卡住後面() {
        let (g, _f) = Fake::gate(lim(1, 500));
        for _ in 0..3 {
            let _ = g.run("k", "list", timeout);
        }
        assert!(g.run("k", "spawn", ok).is_ok());
    }

    #[test]
    fn 最近失敗_逾時後短時間內讀畫面略過_開窗與接回照跑() {
        let (g, f) = Fake::gate(lim(2, 500));
        assert!(g.run("k", "get-text", timeout).is_err());
        let ran = AtomicUsize::new(0);
        let e = g
            .run("k", "get-text", || {
                ran.fetch_add(1, Ordering::SeqCst);
                ok()
            })
            .unwrap_err();
        assert!(e.starts_with(SKIPPED) && not_sent(&e), "{e}");
        assert_eq!(ran.load(Ordering::SeqCst), 0, "暫停期間不能真的去讀");
        for sub in ["spawn", "list", "kill-pane", "send-text", "set-tab-title"] {
            assert!(g.run("k", sub, ok).is_ok(), "{sub} 是使用者動作或接回，不受暫停影響");
        }
        assert!(g.run("other", "get-text", ok).is_ok(), "別的連線檔不受影響");
        f.advance(Duration::from_secs(31));
        assert!(g.run("k", "get-text", ok).is_ok(), "暫停過了就恢復");
    }

    #[test]
    fn 最近失敗_連續失敗越停越久_有上限_成功就清掉() {
        let l = lim(2, 500);
        assert_eq!([1, 2, 3, 4, 5, 6, 7, 40].map(|n| l.cooldown(n).as_secs()), [30, 60, 120, 240, 300, 300, 300, 300]);
        let (g, f) = Fake::gate(l);
        let _ = g.run("k", "get-text", timeout);
        f.advance(Duration::from_secs(31));
        let _ = g.run("k", "get-text", timeout); // 第二次失敗：停 60 秒
        f.advance(Duration::from_secs(31));
        assert!(g.run("k", "get-text", ok).unwrap_err().starts_with(SKIPPED), "第二次失敗要停更久");
        f.advance(Duration::from_secs(30));
        assert!(g.run("k", "get-text", ok).is_ok());
        let _ = g.run("k", "get-text", timeout); // 成功清過，又從 30 秒起算
        f.advance(Duration::from_secs(31));
        assert!(g.run("k", "get-text", ok).is_ok());
    }

    #[test]
    fn 最近失敗_動作類指令逾時也會讓讀畫面暫停() {
        let (g, _f) = Fake::gate(lim(2, 500));
        let _ = g.run("k", "spawn", timeout);
        assert!(g.run("k", "get-text", ok).unwrap_err().starts_with(SKIPPED));
    }

    #[test]
    fn 最近失敗_連不上算沒回應_找不到窗格不算() {
        let fail = |stderr: &str| Ok(RunOutput { success: false, stdout: String::new(), stderr: stderr.into(), code: Some(1) });
        let (g, _f) = Fake::gate(lim(2, 500));
        let _ = g.run("k", "kill-pane", || fail("Error: pane id 9 not found"));
        assert!(g.run("k", "get-text", ok).is_ok(), "服務有回應的失敗不暫停");
        let _ = g.run("k", "list", || fail("failed to connect to Socket(x): Connection refused (os error 10061)"));
        assert!(g.run("k", "get-text", ok).unwrap_err().starts_with(SKIPPED));
    }

    #[test]
    fn 最近失敗_執行檔起不來不算服務沒回應() {
        let (g, f) = Fake::gate(lim(2, 500));
        let _ = g.run("k", "get-text", || Err(format!("{CANNOT_RUN} wezterm.exe：找不到")));
        assert!(g.run("k", "get-text", ok).is_ok());
        assert!(f.lines().iter().any(|l| l.contains("起不來")));
    }

    #[test]
    fn 逾時_log_有子指令名與耗時_不含畫面內容與參數() {
        let (g, f) = Fake::gate(lim(2, 500));
        let _ = g.run("k", "get-text", timeout);
        let _ = g.run("k2", "list", || Ok(RunOutput { success: false, stdout: "機密畫面內容 ABC".into(), stderr: "wezterm 說：failed to connect 機密".into(), code: Some(1) }));
        let lines = f.lines();
        assert_eq!(lines.len(), 2, "{lines:?}");
        assert!(lines[0].contains("get-text") && lines[0].contains("逾時") && lines[0].contains("毫秒") && lines[0].contains("暫停 30 秒"), "{}", lines[0]);
        assert!(lines[1].contains("list") && lines[1].contains("失敗") && lines[1].contains("結束碼 1") && lines[1].contains("毫秒"), "{}", lines[1]);
        let all = lines.join("\n");
        assert!(!all.contains("機密") && !all.contains("ABC"), "log 不能有畫面內容或 stderr：{all}");
    }

    #[test]
    fn 成功的指令不寫_log() {
        let (g, f) = Fake::gate(lim(2, 500));
        g.run("k", "get-text", ok).unwrap();
        assert!(f.lines().is_empty());
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
        let exec = src.split("fn exec_with_timeout").nth(1).unwrap().split("const PIPE_DRAIN").next().unwrap();
        let (k, w) = (exec.find("child.kill()").unwrap(), exec.find("child.wait()").unwrap());
        assert!(k < w, "kill 之後要 wait");
    }
}

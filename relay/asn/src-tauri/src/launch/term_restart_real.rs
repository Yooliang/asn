//! Windows 真實 mux 整合測試（#1860 F PR3，取代測試機實按）：真的 WezTerm、真的 mux，走產品的 `restart_mux`。
//! 停（kill_tree）與起（ensure）都是真的；接回用注入的函式（真代理的包裝殼不在這裡），但它用同一個開窗格函式（start_window）在新 mux 裡開出對應數量的窗格。
//! mux 檔案、WezTerm 的副本、工作資料夾都放暫存資料夾，不碰正式的 %LOCALAPPDATA%\ASN\m；只殺自己記下的 mux 程序編號。
//!   ASN_WEZTERM_DIR=<WezTerm 資料夾> cargo test --locked --lib launch::term::restart_real -- --ignored --test-threads=1 --nocapture
//! 結束「全域」的 STASH（重啟失敗時存名單的地方）：測試開頭與結束都清空，所以一次只跑一個（CI 用 --test-threads=1）。
use super::*;
use crate::launch::mux_restart::{self, RestartError, STASH};
use std::cell::RefCell;
use std::collections::BTreeMap;
use std::time::{Duration, Instant};

type Live = TermService<wezterm::RealRunner, wezterm::RealFs>;

/// 等待上限與輪詢間隔：一律輪詢，不寫死 sleep
const LIMIT: Duration = Duration::from_secs(15);
const POLL: Duration = Duration::from_millis(100);
const SERVER: &str = "wezterm-mux-server.exe";
const SERVER_HIDDEN: &str = "wezterm-mux-server.exe.renamed-by-test";
/// 被管理的夥伴名單（名單有內容才驗得到「接回」）
const NAMES: [&str; 2] = ["重啟測試甲", "重啟測試乙"];

fn wait(what: &str, mut ok: impl FnMut() -> bool) {
    let t = Instant::now();
    while !ok() {
        assert!(t.elapsed() < LIMIT, "等了 {} 秒仍然不成立：{what}", LIMIT.as_secs());
        std::thread::sleep(POLL);
    }
}

fn sorted(mut v: Vec<String>) -> Vec<String> {
    v.sort();
    v
}

fn names() -> Vec<String> {
    sorted(NAMES.iter().map(|s| s.to_string()).collect())
}

/// 測試用的一整套：暫存資料夾、WezTerm 的副本（改名只動副本）、服務。收尾（含失敗）一定殺掉自己記下的 mux、把改名的檔改回來、清空 STASH
struct Rig {
    tmp: tempfile::TempDir,
    bin: PathBuf,
    svc: Live,
    pids: RefCell<Vec<u32>>,
}

impl Rig {
    fn new() -> Self {
        STASH.set(Vec::new());
        let src = PathBuf::from(std::env::var_os("ASN_WEZTERM_DIR").expect("要設 ASN_WEZTERM_DIR（指到 WezTerm 資料夾）"));
        let tmp = tempfile::tempdir().unwrap();
        let bin = tmp.path().join("wez");
        std::fs::create_dir_all(&bin).unwrap();
        for e in std::fs::read_dir(&src).expect("讀 WezTerm 資料夾").flatten() {
            if e.path().is_file() {
                std::fs::copy(e.path(), bin.join(e.file_name())).expect("複製 WezTerm 檔案到暫存資料夾");
            }
        }
        assert!(bin.join(SERVER).is_file() && bin.join("wezterm.exe").is_file(), "WezTerm 資料夾裡要有 wezterm.exe 與 {SERVER}");
        let dir = WezTermDir { gui: Some(bin.join("wezterm-gui.exe")), cli: bin.join("wezterm.exe") };
        let t = tmp.path();
        let mut svc = TermService::fixed(dir, t.join("wezterm-term.lua"), t.join("wezterm-terms.json"), crate::identity::home_dir(), wezterm::RealRunner, wezterm::RealFs);
        svc.set_hold_config(true);
        svc.set_use_mux(true);
        svc.set_mux_base(t.join("local"));
        svc.ensure_config().expect("隔離設定");
        std::fs::create_dir_all(t.join("work")).unwrap();
        Rig { tmp, bin, svc, pids: RefCell::new(Vec::new()) }
    }

    fn work(&self) -> PathBuf {
        self.tmp.path().join("work")
    }

    /// 現行 mux 的（程序編號, 建立時間）；同時記下程序編號給收尾用
    fn live(&self) -> Option<(u32, u64)> {
        let l = self.svc.restart_mux_handle().ok()?.live_pid();
        if let Some((p, _)) = l {
            if !self.pids.borrow().contains(&p) {
                self.pids.borrow_mut().push(p);
            }
        }
        l
    }

    fn panes(&self) -> usize {
        self.svc.restart_mux_handle().unwrap().pane_count().expect("數 mux 裡的窗格")
    }

    /// 開一個夥伴（跑 ping -t）：和平常開窗同一條路（start_window），會記進對照表
    fn open(&self, name: &str) {
        let env: BTreeMap<String, String> = crate::launch::win_term::term_env(crate::launch::config::child_env(), &[]);
        let args = vec!["-t".to_string(), "127.0.0.1".to_string()];
        let spec = crate::launch::win_term::spec_for(name, "ping.exe", &args, false, env);
        self.svc.start_window(&self.work(), &spec).unwrap_or_else(|e| panic!("開夥伴 {name} 失敗：{e:?}"));
        self.live();
    }

    /// 接回（注入）：名單裡每位在新 mux 開一個窗格
    fn resume<'a>(&'a self, got: &'a RefCell<Vec<String>>) -> impl FnOnce(Vec<String>) + 'a {
        move |n| {
            for name in &n {
                self.open(name);
            }
            got.borrow_mut().extend(n);
        }
    }

    fn partners(&self) -> Vec<String> {
        sorted(self.svc.mux_snapshot().expect("讀 mux 狀態").partners)
    }

    fn hide_server(&self) {
        std::fs::rename(self.bin.join(SERVER), self.bin.join(SERVER_HIDDEN)).expect("把 mux 程式改名");
    }

    fn restore_server(&self) {
        if self.bin.join(SERVER_HIDDEN).exists() {
            let _ = std::fs::rename(self.bin.join(SERVER_HIDDEN), self.bin.join(SERVER));
        }
    }
}

impl Drop for Rig {
    fn drop(&mut self) {
        self.restore_server();
        // 只殺自己記下的 mux（含底下的窗格程序）；最後再讀一次 pid 檔，免得起到一半就失敗而沒記到
        if let Some((p, _)) = self.svc.restart_mux_handle().ok().and_then(|m| m.recorded()) {
            if !self.pids.borrow().contains(&p) {
                self.pids.borrow_mut().push(p);
            }
        }
        for p in self.pids.borrow().iter() {
            crate::bridge::orphans::kill_tree(*p);
        }
        STASH.set(Vec::new());
    }
}

#[test]
#[ignore]
fn windows_real_mux_restart() {
    let rig = Rig::new();
    let n = NAMES.len();
    let want = names();

    // 開 N 位被管理的夥伴
    for name in NAMES {
        rig.open(name);
    }
    let (m1, _) = rig.live().expect("第一個 mux 起來了");
    assert_eq!(rig.panes(), n, "舊 mux 裡有 {n} 個窗格");
    assert_eq!(rig.partners(), want, "名單上有 {n} 位");
    assert_eq!(mux_restart::pending_count(), 0);

    // (a) 正常重啟：舊的沒了、新的起來、名單全接回、STASH 空
    let got = RefCell::new(Vec::new());
    let r = rig.svc.restart_mux(false, rig.resume(&got), |_| panic!("起得來就不該通知斷線"));
    assert_eq!(r, Ok(()), "(a) 正常重啟");
    wait("(a) 舊 mux 程序已不在", || !crate::heartbeat::pid_alive(m1));
    let (m2, _) = rig.live().expect("(a) 新 mux 活著");
    assert_ne!(m1, m2, "(a) 新 mux 不是舊的那一個");
    assert!(crate::heartbeat::pid_alive(m2));
    assert_eq!(sorted(got.borrow().clone()), want, "(a) 交給接回的名單");
    wait("(a) 新 mux 窗格數＝名單", || rig.svc.restart_mux_handle().unwrap().pane_count() == Ok(n));
    assert_eq!(rig.partners(), want, "(a) 名單全接回");
    assert_eq!(mux_restart::pending_count(), 0, "(a) STASH 空");

    // (b) mux 程式不見：停得掉、起不來 → Down、名單存進 STASH、通知排出去、沒有接回
    rig.hide_server();
    let got = RefCell::new(Vec::new());
    let downed = RefCell::new(Vec::<String>::new());
    let r = rig.svc.restart_mux(false, rig.resume(&got), |d| {
        downed.borrow_mut().extend(d.iter().cloned());
        mux_restart::notify_down(&rig.work(), d, crate::heartbeat::now_ms());
    });
    assert!(matches!(r, Err(RestartError::Down(_))), "(b) 起不來要回 Down：{r:?}");
    wait("(b) 舊 mux 程序已不在", || !crate::heartbeat::pid_alive(m2));
    assert!(rig.live().is_none(), "(b) 沒有新的 mux");
    assert!(got.borrow().is_empty(), "(b) 起不來不接回");
    assert_eq!(sorted(STASH.get()), want, "(b) STASH 存著 {n} 位");
    assert_eq!(mux_restart::pending_count(), n);
    assert_eq!(sorted(downed.borrow().clone()), want, "(b) down 通知收到 {n} 位");
    let notice = crate::launch::mux_round::read_resume_notice(&rig.work()).expect("(b) 接回結果通知檔有排");
    assert_eq!((notice.0, notice.1), (n, 0), "(b) 斷了 {n} 位、接回 0 位");

    // (c) 改回檔名再重啟：用 STASH 接回、STASH 清空、窗格都回來
    rig.restore_server();
    let got = RefCell::new(Vec::new());
    let r = rig.svc.restart_mux(false, rig.resume(&got), |_| panic!("起得來就不該通知斷線"));
    assert_eq!(r, Ok(()), "(c) 重按要成功");
    let (m3, _) = rig.live().expect("(c) 新 mux 活著");
    assert!(m3 != m1 && m3 != m2, "(c) 又是一個新的 mux");
    assert_eq!(sorted(got.borrow().clone()), want, "(c) 用 STASH 的名單接回");
    wait("(c) 新 mux 窗格數＝名單", || rig.svc.restart_mux_handle().unwrap().pane_count() == Ok(n));
    assert_eq!(rig.partners(), want, "(c) 名單全接回");
    assert_eq!(mux_restart::pending_count(), 0, "(c) STASH 清空");
}

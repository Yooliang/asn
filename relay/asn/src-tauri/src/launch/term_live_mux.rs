//! 真機驗證（todo-next-15q，預設不跑）：真的 WezTerm＋真的 mux，夥伴用會寫心跳檔的小程式（不花額度）。
//! mux 的檔案放暫存資料夾，不碰正式的 %LOCALAPPDATA%\ASN\m。一次只跑一個（會開視窗、會數整台電腦的 mux）：
//!   ASN_WEZTERM_DIR=<WezTerm 資料夾> cargo test --lib launch::term::live_mux -- --ignored --nocapture --test-threads=1
use super::*;
use std::collections::BTreeMap;
use std::time::{Duration, Instant};

type Live = TermService<wezterm::RealRunner, wezterm::RealFs>;

struct Rig {
    tmp: tempfile::TempDir,
    dir: WezTermDir,
}

impl Rig {
    fn new() -> Self {
        let dir = wezterm::locate(&wezterm::RealFs).expect("請設定 ASN_WEZTERM_DIR");
        Rig { tmp: tempfile::tempdir().unwrap(), dir }
    }
    /// 新的服務（等於 ASN 重開一次）：對照表和 mux 位置沿用同一個暫存資料夾
    fn svc(&self) -> Live {
        let t = self.tmp.path();
        let mut s = TermService::fixed(self.dir.clone(), t.join("wezterm-term.lua"), t.join("wezterm-terms.json"), crate::identity::home_dir(), wezterm::RealRunner, wezterm::RealFs);
        s.set_hold_config(true);
        s.set_use_mux(true);
        s.set_mux_base(t.join("local"));
        s.ensure_config().expect("隔離設定");
        s
    }
    fn hb(&self, n: usize) -> PathBuf {
        self.tmp.path().join(format!("hb-{n}.txt"))
    }
    /// 開一個夥伴：每 200 毫秒往心跳檔加一個字
    fn open(&self, s: &Live, n: usize) -> (String, u32) {
        let cwd = self.tmp.path().to_path_buf();
        let script = format!("while($true){{[IO.File]::AppendAllText('{}','x');Start-Sleep -Milliseconds 200}}", self.hb(n).display());
        let args = vec!["-NoProfile".to_string(), "-Command".to_string(), script];
        let env: BTreeMap<String, String> = crate::launch::win_term::term_env(std::env::vars().collect(), &[]);
        let spec = crate::launch::win_term::spec_for(&format!("測試{n}"), "powershell.exe", &args, false, env);
        s.start_window(&cwd, &spec).unwrap_or_else(|e| panic!("開夥伴 {n} 失敗：{e:?}"))
    }
    fn beating(&self, n: usize) -> bool {
        let size = || std::fs::metadata(self.hb(n)).map(|m| m.len()).unwrap_or(0);
        let a = size();
        std::thread::sleep(Duration::from_millis(1500));
        size() > a
    }
    fn wait_beating(&self, n: usize) {
        let t = Instant::now();
        while !self.hb(n).exists() {
            assert!(t.elapsed() < Duration::from_secs(20), "夥伴 {n} 20 秒內沒有開始跑");
            std::thread::sleep(Duration::from_millis(100));
        }
        assert!(self.beating(n), "夥伴 {n} 心跳沒有增加");
    }
}

fn mux_pids() -> Vec<u32> {
    crate::launch::switch::winapi::process_table().into_iter().filter(|p| p.name == "wezterm-mux-server.exe").map(|p| p.pid).collect()
}

fn rows(s: &Live) -> Vec<String> {
    s.inner.lock().unwrap().sessions.iter().map(|x| x.id.clone()).collect()
}

#[test]
#[ignore]
fn 關單一窗格_其他夥伴照跑_mux_還在() {
    let before = mux_pids();
    let rig = Rig::new();
    let s = rig.svc();
    let opened: Vec<_> = (0..3).map(|n| rig.open(&s, n)).collect();
    println!("開了：{opened:?}");
    (0..3).for_each(|n| rig.wait_beating(n));
    let mux = opened[0].1;
    assert!(opened.iter().all(|o| o.1 == mux), "三個夥伴應該在同一個 mux");
    assert_eq!(mux_pids().iter().filter(|p| !before.contains(p)).count(), 1, "只多一個 mux");

    s.stop_partner(&opened[0].0).expect("關第一個夥伴");
    std::thread::sleep(Duration::from_millis(800));
    let dead = !rig.beating(0);
    let (a, b) = (rig.beating(1), rig.beating(2));
    println!("關第一個之後：被關的停了={dead} 另外兩個還在跑={a},{b} 表上={:?}", rows(&s));
    assert!(dead && a && b);
    assert!(mux_pids().contains(&mux), "mux 不能跟著結束");
    assert_eq!(rows(&s).len(), 2);

    s.stop_partner(&opened[1].0).unwrap();
    s.stop_partner(&opened[2].0).unwrap();
    // 最後一個夥伴關掉：ASN 收掉空的 mux（設計 11.2-7）
    println!("RESULT 關完最後一個後 mux 還在：{}", mux_pids().contains(&mux));
    assert!(!mux_pids().contains(&mux), "沒有夥伴時不留下空 mux");
}

#[test]
#[ignore]
fn 服務重開_認回夥伴_沿用同一個_mux_個數不增加() {
    let before = mux_pids();
    let rig = Rig::new();
    let s = rig.svc();
    let a = rig.open(&s, 10);
    let b = rig.open(&s, 11);
    rig.wait_beating(10);
    rig.wait_beating(11);
    drop(s);

    let s2 = rig.svc();
    s2.reclaim().expect("認領");
    println!("重開後表上：{:?}", rows(&s2));
    assert_eq!(rows(&s2).len(), 2, "兩個夥伴都要認回來");
    assert!(rig.beating(10) && rig.beating(11), "重開不影響夥伴");
    let c = rig.open(&s2, 12);
    rig.wait_beating(12);
    assert_eq!(c.1, a.1, "第三個開在同一個 mux");
    assert_eq!(mux_pids().iter().filter(|p| !before.contains(p)).count(), 1, "重開後 mux 個數不增加");
    for id in [&a.0, &b.0, &c.0] {
        s2.stop_partner(id).unwrap();
    }
    assert!(!mux_pids().contains(&a.1), "最後一個夥伴關掉就收掉 mux");
    println!("RESULT 重開認回 2 個，第 3 個同一個 mux");
}

#[test]
#[ignore]
fn 舊通訊檔與反覆開關_mux_不累積() {
    let before = mux_pids();
    let rig = Rig::new();
    let s = rig.svc();
    let first = rig.open(&s, 20);
    rig.wait_beating(20);
    let paths = crate::launch::mux::paths(&rig.tmp.path().join("local")).unwrap();
    // 製造殘留：同資料夾放幾個舊的通訊檔與舊 GUI 的連線檔
    for i in 0..5 {
        std::fs::write(paths.dir.join(format!("sock-old-{i}")), "").unwrap();
        std::fs::write(paths.dir.join(format!("gui-sock-{}", 90000 + i)), "").unwrap();
    }
    let mut seen = vec![];
    for round in 0..8 {
        let n = 30 + round;
        let (id, pid) = rig.open(&s, n);
        rig.wait_beating(n);
        s.stop_partner(&id).unwrap();
        let count = mux_pids().iter().filter(|p| !before.contains(p)).count();
        seen.push((pid, count));
        assert_eq!(count, 1, "第 {round} 輪 mux 個數");
    }
    println!("RESULT 8 輪（mux 編號, 個數）：{seen:?}");
    assert!(seen.iter().all(|x| x.0 == first.1), "都應該開在同一個 mux");
    s.stop_partner(&first.0).unwrap();
    assert!(!mux_pids().contains(&first.1), "最後一個夥伴關掉就收掉 mux");
}

/// 兩段式：ASN 當掉或被砍。第一段開夥伴、把狀態寫進 ASN_15Q_STATE 後整個程序直接結束（不收尾）；
/// 外面確認 mux 和夥伴去向後跑第二段，認回來並收乾淨。
#[test]
#[ignore]
fn 兩段式_1_開夥伴後程序直接結束() {
    let Some(state) = std::env::var_os("ASN_15Q_STATE") else { return };
    let rig = Rig::new();
    let s = rig.svc();
    let a = rig.open(&s, 40);
    let b = rig.open(&s, 41);
    rig.wait_beating(40);
    rig.wait_beating(41);
    let keep = rig.tmp.path().to_path_buf();
    std::fs::write(&state, format!("{}\n{}\n{}\n{}\n", keep.display(), a.0, b.0, a.1)).unwrap();
    std::mem::forget(rig);
    println!("RESULT 第一段：mux {}，夥伴 {} {}；不收尾直接結束", a.1, a.0, b.0);
    std::process::exit(0);
}

#[test]
#[ignore]
fn 兩段式_2_認回並收乾淨() {
    let Some(state) = std::env::var_os("ASN_15Q_STATE") else { return };
    let text = std::fs::read_to_string(state).expect("先跑第一段");
    let l: Vec<&str> = text.lines().collect();
    let t = PathBuf::from(l[0]);
    let hb = |n: usize| std::fs::metadata(t.join(format!("hb-{n}.txt"))).map(|m| m.len()).unwrap_or(0);
    let (h0, h1) = (hb(40), hb(41));
    std::thread::sleep(Duration::from_millis(1500));
    println!("程序結束後夥伴還在跑：{},{}；mux {} 還在：{}", hb(40) > h0, hb(41) > h1, l[3], mux_pids().contains(&l[3].parse().unwrap()));
    assert!(hb(40) > h0 && hb(41) > h1, "ASN 結束後夥伴要繼續跑");
    let dir = wezterm::locate(&wezterm::RealFs).unwrap();
    let mut s = TermService::fixed(dir, t.join("wezterm-term.lua"), t.join("wezterm-terms.json"), crate::identity::home_dir(), wezterm::RealRunner, wezterm::RealFs);
    s.set_hold_config(true);
    s.set_use_mux(true);
    s.set_mux_base(t.join("local"));
    s.reclaim().expect("認領");
    assert_eq!(rows(&s).len(), 2, "下一次啟動要認回兩個夥伴");
    s.stop_partner(l[1]).unwrap();
    s.stop_partner(l[2]).unwrap();
    let mux: u32 = l[3].parse().unwrap();
    assert!(!mux_pids().contains(&mux), "最後一個夥伴關掉就收掉 mux");
    let _ = std::fs::remove_dir_all(&t);
    println!("RESULT 第二段：認回 2 個並收乾淨");
}

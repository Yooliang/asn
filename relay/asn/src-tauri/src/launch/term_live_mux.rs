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
        let env: BTreeMap<String, String> = crate::launch::win_term::term_env(crate::launch::config::child_env(), &[]);
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
    elog!("開了：{opened:?}");
    (0..3).for_each(|n| rig.wait_beating(n));
    let mux = opened[0].1;
    assert!(opened.iter().all(|o| o.1 == mux), "三個夥伴應該在同一個 mux");
    assert_eq!(mux_pids().iter().filter(|p| !before.contains(p)).count(), 1, "只多一個 mux");

    s.stop_partner(&opened[0].0).expect("關第一個夥伴");
    std::thread::sleep(Duration::from_millis(800));
    let dead = !rig.beating(0);
    let (a, b) = (rig.beating(1), rig.beating(2));
    elog!("關第一個之後：被關的停了={dead} 另外兩個還在跑={a},{b} 表上={:?}", rows(&s));
    assert!(dead && a && b);
    assert!(mux_pids().contains(&mux), "mux 不能跟著結束");
    assert_eq!(rows(&s).len(), 2);

    s.stop_partner(&opened[1].0).unwrap();
    s.stop_partner(&opened[2].0).unwrap();
    // 最後一個夥伴關掉：ASN 收掉空的 mux（設計 11.2-7）
    elog!("RESULT 關完最後一個後 mux 還在：{}", mux_pids().contains(&mux));
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
    elog!("重開後表上：{:?}", rows(&s2));
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
    elog!("RESULT 重開認回 2 個，第 3 個同一個 mux");
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
    elog!("RESULT 8 輪（mux 編號, 個數）：{seen:?}");
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
    elog!("RESULT 第一段：mux {}，夥伴 {} {}；不收尾直接結束", a.1, a.0, b.0);
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
    elog!("程序結束後夥伴還在跑：{},{}；mux {} 還在：{}", hb(40) > h0, hb(41) > h1, l[3], mux_pids().contains(&l[3].parse().unwrap()));
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
    elog!("RESULT 第二段：認回 2 個並收乾淨");
}

/// 畫面操作用（捲動、Ctrl+C、按 X、中文）：開一個真的 claude（haiku，會用到少量額度）留著，等外面操作。
/// ASN_15Q_CLAUDE_MODE=window｜mux 選模式；ASN_15Q_FLAGS 是旗標資料夾：這裡寫 `opened`（內容＝編號、程序、種類、對話編號），
/// 外面寫 `done` 才收尾。mux 模式順便開看畫面的 GUI。
#[test]
#[ignore]
fn 真_claude_留給外面操作() {
    let (Ok(mode), Some(flags)) = (std::env::var("ASN_15Q_CLAUDE_MODE"), std::env::var_os("ASN_15Q_FLAGS")) else { return };
    let flags = PathBuf::from(flags);
    let rig = Rig::new();
    let mut s = rig.svc();
    s.set_use_mux(mode == "mux");
    let cwd = rig.tmp.path().to_path_buf();
    let env: BTreeMap<String, String> = crate::launch::win_term::term_env(crate::launch::config::child_env(), &[]);
    let args = vec!["--model".to_string(), "haiku".to_string(), "--session-id".to_string(), "15e00000-0000-4000-8000-00000000abcd".to_string()];
    let spec = crate::launch::win_term::spec_for("測試claude", "claude", &args, false, env);
    let (id, pid) = s.start_window(&cwd, &spec).unwrap_or_else(|e| panic!("開 claude 失敗：{e:?}"));
    if mode == "mux" {
        s.view(&id).expect("開看畫面的 GUI");
    }
    let row = s.inner.lock().unwrap().sessions.iter().find(|x| x.id == id).map(|x| (x.kind.clone(), x.session_id.clone()));
    std::fs::write(flags.join("opened"), format!("{id} {pid} {row:?}")).unwrap();
    elog!("RESULT 開好：{id} {pid} {row:?}");
    // 記下窗格標題怎麼變（WezTerm 回報的前景）：給 todo-next-162 判斷「前景是不是 Claude」
    let dir = s.dir().unwrap();
    let sock = s.inner.lock().unwrap().sessions.iter().find(|x| x.id == id).map(|x| x.window.sock.clone()).unwrap();
    let mut last = String::new();
    let t = Instant::now();
    while !flags.join("done").exists() && t.elapsed() < Duration::from_secs(600) {
        if let Ok(p) = s.wez(&dir).list(&sock) {
            let now = p.iter().map(|x| format!("{}|{}", x.pane_id, x.title)).collect::<Vec<_>>().join(";");
            if now != last {
                elog!("RESULT 窗格標題 {:?}：{now}", t.elapsed());
                last = now;
            }
        }
        std::thread::sleep(Duration::from_millis(500));
    }
    // 外面可能已經關窗：查狀態、收尾都照實印
    elog!("RESULT 收尾前表上：{:?}；read：{:?}", rows(&s), s.read(&id, 5).map(|x| x.len()));
    if mode == "mux" {
        elog!("RESULT stop_partner：{:?}", s.stop_partner(&id));
    } else {
        elog!("RESULT stop_gui：{:?}", s.stop_gui(pid));
    }
    std::thread::sleep(Duration::from_millis(1500));
    let _ = std::fs::write(flags.join("stopped"), "1");
}

/// 各種指令寫法在兩種模式下開不開得起來（不花額度）：只印結果表，由人判斷。會開幾扇視窗再自己關
#[test]
#[ignore]
fn 指令寫法_裸名_cmd_ps1_exe_不存在() {
    let before = mux_pids();
    let rig = Rig::new();
    // ASN_15Q_DIRNAME 可換資料夾名（例如純英文無空白）比對是不是路徑造成的
    let dir = rig.tmp.path().join(std::env::var("ASN_15Q_DIRNAME").unwrap_or_else(|_| "有 空白 中文".to_string()));
    std::fs::create_dir_all(&dir).unwrap();
    let out = |n: &str| dir.join(format!("out-{n}.txt"));
    std::fs::write(dir.join("zzfake.cmd"), "@chcp 65001 >nul\r\n@echo %*> \"%~dp0out-cmd.txt\"\r\n@ping -n 30 127.0.0.1 >nul\r\n").unwrap();
    std::fs::write(dir.join("zzfake2.ps1"), "$args -join '|' | Set-Content -Encoding utf8 (Join-Path $PSScriptRoot 'out-ps1.txt'); Start-Sleep 30\r\n").unwrap();
    let args = vec!["a b".to_string(), "中文".to_string()];
    let cases: Vec<(&str, String, Vec<String>)> = vec![
        ("裸名cmd", "zzfake".to_string(), args.clone()),
        ("完整cmd", dir.join("zzfake.cmd").display().to_string(), args.clone()),
        ("完整ps1", dir.join("zzfake2.ps1").display().to_string(), args.clone()),
        ("exe", "powershell.exe".to_string(), vec!["-NoProfile".into(), "-Command".into(), format!("'exe' | Set-Content '{}'; Start-Sleep 30", out("exe").display())]),
        ("不存在", "zzmissing-15q".to_string(), args.clone()),
    ];
    for use_mux in [false, true] {
        let mut s = rig.svc();
        s.set_use_mux(use_mux);
        let mut own_mux = None;
        for (name, prog, a) in &cases {
            for f in ["cmd", "ps1", "exe"] {
                let _ = std::fs::remove_file(out(f));
            }
            let mut base = crate::launch::config::child_env();
            let path = format!("{};{}", dir.display(), base.get("PATH").cloned().unwrap_or_default());
            base.insert("PATH".to_string(), path);
            let env: BTreeMap<String, String> = crate::launch::win_term::term_env(base, &[]);
            let spec = crate::launch::win_term::spec_for("指令測試", prog, a, false, env);
            let opened = s.start_window(&dir, &spec);
            std::thread::sleep(Duration::from_secs(5));
            let wrote: Vec<String> = ["cmd", "ps1", "exe"].iter().filter_map(|f| std::fs::read_to_string(out(f)).ok().map(|t| format!("{f}={}", t.trim()))).collect();
            let shown = opened.as_ref().map(|x| x.0.clone()).map_err(|e| format!("{e:?}").chars().take(80).collect::<String>());
            elog!("RESULT {} {name}：開窗={shown:?} 程式寫出={wrote:?}", if use_mux { "mux" } else { "視窗" });
            if let Ok((id, pid)) = opened {
                if use_mux {
                    own_mux = Some(pid);
                    let _ = s.stop_partner(&id);
                } else {
                    let _ = s.stop_gui(pid);
                }
            }
        }
        if use_mux {
            let left: Vec<u32> = mux_pids().into_iter().filter(|p| !before.contains(p)).collect();
            elog!("RESULT mux 收尾後留下：{left:?}（最後一個成功的是 {own_mux:?}）");
            assert!(left.is_empty(), "開窗失敗也不留下空 mux");
        }
    }
}


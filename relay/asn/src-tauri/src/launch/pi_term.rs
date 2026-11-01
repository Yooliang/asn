//! 經 pi 開新夥伴時優先開在 ASN 自帶的終端（WezTerm，#475）：那裡一個 pi 一扇專屬視窗，名單能切前景／背景。
//! 這台沒有自帶的終端、或開不起來時，退回 Windows 原生主控台（#476 的開法），並用白話說明；細節只進 log。
//! 只管「經 pi」：Claude 夥伴走 local::start_window（0.2.0 起同樣先開在自帶終端，見 win_term），不走這裡。
//! 自帶終端的服務由畫面那一層在啟動時交給 [`super::term::set_global`]；這裡只透過 [`PiTermHost`] 介面用它，測試注入假的，不碰全域狀態。
use super::win_term::WinOpenError;
use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};

/// 這台沒有 ASN 自帶的終端（找不到 WezTerm，或這個建置沒有畫面）
pub(crate) const PI_TERM_NONE: &str = "這台沒有 ASN 自帶的終端，改用一般視窗開";
/// 自帶的終端在，但這次開不起來
pub(crate) const PI_TERM_FAILED: &str = "ASN 自帶的終端開不起來，改用一般視窗開";

/// ASN 自帶的終端（正式＝TermService；測試換成假的）
pub(crate) trait PiTermHost: Send + Sync {
    /// 這台找得到自帶的終端
    fn available(&self) -> bool;
    /// 在 cwd 開 argv（argv[0] 是 pi），GUI 只拿到 env；hidden＝開完立刻隱藏（背景開）。回承載 pi 的 GUI 程序編號
    /// 失敗分兩種（見 win_term::WinOpenError）：還沒啟動才可以退回原生主控台
    fn start_pi(&self, cwd: &Path, argv: &[String], env: &BTreeMap<String, String>, hidden: bool) -> Result<u32, WinOpenError>;
}

/// 開好了：pid＝承載 pi 的程序（自帶終端是 GUI、原生主控台是 powershell）；note＝退回原生主控台時給使用者看的說明
#[derive(Debug, PartialEq)]
pub(crate) struct PiOpened {
    pub pid: u32,
    pub note: Option<&'static str>,
}

/// 給自帶終端的環境：base 先照 child_env 濾掉金鑰類變數（ASN_RELAY_KEY 等），再加上 pi::plan 給的幾個（ASN_PI_NAME 等）。
/// plan 的變數名只收大寫英數與底線（跟原生主控台那邊同一個規則）
pub(crate) fn pi_term_env(base: HashMap<String, String>, extra: &[(String, String)]) -> BTreeMap<String, String> {
    let mut out: BTreeMap<String, String> = base.into_iter().collect();
    for (k, v) in extra {
        if !k.is_empty() && k.chars().all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == '_') && !crate::envc::is_secret(k) {
            out.insert(k.clone(), v.clone());
        }
    }
    out
}

/// 經 pi 開一個夥伴：有自帶的終端就開在裡面，否則（或開失敗）用 fallback 開原生主控台。
/// hidden（背景開）：0.2.0 起跟 claude 同一套（設計 1.4），一樣開在自帶終端、開完立刻隱藏
#[allow(clippy::too_many_arguments)]
pub(crate) fn open_pi(
    host: Option<&dyn PiTermHost>,
    base_env: HashMap<String, String>,
    command: &str,
    args: &[String],
    cwd: &Path,
    hidden: bool,
    env: &[(String, String)],
    fallback: &dyn Fn() -> Result<u32, String>,
) -> Result<PiOpened, String> {
    let note = match host.filter(|h| h.available()) {
        None => PI_TERM_NONE,
        Some(h) => {
            let argv: Vec<String> = std::iter::once(command.to_string()).chain(args.iter().cloned()).collect();
            match h.start_pi(cwd, &argv, &pi_term_env(base_env, env), hidden) {
                Ok(pid) => return Ok(PiOpened { pid, note: None }),
                Err(WinOpenError::NotStarted(e)) => {
                    elog!("經 pi 開在 ASN 自帶的終端失敗（還沒啟動），改用原生主控台：{e}");
                    PI_TERM_FAILED
                }
                // 已經啟動之後才失敗：裡面的 pi 可能已經在跑，不再開第二份（asn真 審 #573）
                Err(WinOpenError::Started(e)) => {
                    elog!("經 pi 開：自帶終端已啟動但後續失敗，不改用原生主控台：{e}");
                    return Err(format!("{}：{e}", super::win_term::STARTED_BUT_FAILED));
                }
            }
        }
    };
    fallback().map(|pid| PiOpened { pid, note: Some(note) })
}

/// 開關的分岔點（#611）：關著時背景開（hidden）照 0.1.113 直接走 fallback（原生主控台、不說明、不碰自帶終端）；
/// 前景開本來就先用自帶終端（#475，0.1.113 就是這樣），不受開關影響；開著時背景開也開在自帶終端（0.2.0 第 1 階段）
#[allow(clippy::too_many_arguments)]
pub(crate) fn open_pi_gated(
    wezterm_windows: bool,
    host: Option<&dyn PiTermHost>,
    base_env: HashMap<String, String>,
    command: &str,
    args: &[String],
    cwd: &Path,
    hidden: bool,
    env: &[(String, String)],
    fallback: &dyn Fn() -> Result<u32, String>,
) -> Result<PiOpened, String> {
    if hidden && !wezterm_windows {
        return fallback().map(|pid| PiOpened { pid, note: None });
    }
    open_pi(host, base_env, command, args, cwd, hidden, env, fallback)
}

/// 交給 pi 的工作資料夾拿掉 Windows 長路徑前綴（`\\?\`）：遠端開時資料夾經過 canonicalize 會帶上它，
/// pi 拿 cwd 組 sessions 底下的資料夾名，名字裡出現 `?` 就建不了，pi 一啟動就當掉（#601）。
/// 在 `open_pi_real` 本身做，本機開、遠端開、接手／喚醒三條路都經過這裡；自帶終端的對照表記的也是拿掉後的
pub(crate) fn pi_cwd(cwd: &Path) -> PathBuf {
    PathBuf::from(super::local::strip_verbatim_prefix(&cwd.to_string_lossy()))
}

/// 正式：經 pi 開夥伴（本機開、遠端開、接手、喚醒共用）。自帶的終端從全域取；沒有畫面的建置、測試一律沒有
pub(crate) fn open_pi_real(name: &str, command: &str, args: &[String], cwd: &Path, hidden: bool, env: &[(String, String)]) -> Result<PiOpened, String> {
    let cwd = &pi_cwd(cwd);
    let host = host();
    let r = open_pi_gated(super::win_term::wezterm_windows(), host.as_deref(), super::config::child_env(), command, args, cwd, hidden, env, &|| super::local::start_console_window_env(name, command, args, cwd, hidden, env))?;
    if let Some(n) = r.note {
        elog!("經 pi 開「{name}」：{n}");
    }
    // 畫面上的提示跟 claude 同一套：這次執行只講一次（設計 1.5）
    let note = r.note.filter(|_| super::win_term::first_fallback_note());
    Ok(PiOpened { pid: r.pid, note })
}

fn host() -> Option<std::sync::Arc<dyn PiTermHost>> {
    #[cfg(all(desktop, feature = "gui", not(test)))]
    {
        super::term::pi_host()
    }
    #[cfg(not(all(desktop, feature = "gui", not(test))))]
    {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    struct FakeHost {
        available: bool,
        result: Result<u32, WinOpenError>,
        got: Mutex<Vec<(String, Vec<String>, BTreeMap<String, String>)>>,
        hidden: Mutex<Vec<bool>>,
    }
    impl PiTermHost for FakeHost {
        fn available(&self) -> bool {
            self.available
        }
        fn start_pi(&self, cwd: &Path, argv: &[String], env: &BTreeMap<String, String>, hidden: bool) -> Result<u32, WinOpenError> {
            self.got.lock().unwrap().push((cwd.to_string_lossy().into_owned(), argv.to_vec(), env.clone()));
            self.hidden.lock().unwrap().push(hidden);
            self.result.clone()
        }
    }
    fn host(available: bool, result: Result<u32, WinOpenError>) -> FakeHost {
        FakeHost { available, result, got: Mutex::new(vec![]), hidden: Mutex::new(vec![]) }
    }
    fn base() -> HashMap<String, String> {
        // 照真的路徑：先過 child_env 的過濾
        super::super::config::child_env_from(
            [("PATH", "C:\\bin"), ("ASN_RELAY_KEY", "不能外流"), ("IRORI_RELAY_KEY", "舊名也不行"), ("MINIMAX_API_KEY", "pi 自己要用"), ("USERPROFILE", "C:\\Users\\u")].into_iter().map(|(k, v)| (k.to_string(), v.to_string())),
        )
    }
    const ARGS: [&str; 2] = ["-e", "ext.ts"];
    fn args() -> Vec<String> {
        ARGS.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn 有自帶終端_開在裡面_帶_pi_的參數與名字變數_金鑰類一律不帶() {
        let h = host(true, Ok(4321));
        let fb_called = std::cell::Cell::new(false);
        let r = open_pi(Some(&h), base(), "pi", &args(), Path::new("D:\\proj"), false, &[("ASN_PI_NAME".into(), "小皮".into()), ("bad-name".into(), "x".into())], &|| {
            fb_called.set(true);
            Ok(1)
        })
        .unwrap();
        assert_eq!(r, PiOpened { pid: 4321, note: None });
        assert!(!fb_called.get(), "開成功就不開原生主控台");
        let got = h.got.lock().unwrap();
        let (cwd, argv, env) = &got[0];
        assert_eq!(cwd, "D:\\proj");
        assert_eq!(argv, &vec!["pi".to_string(), "-e".into(), "ext.ts".into()], "指令與參數跟原生主控台同一份");
        assert_eq!(env.get("ASN_PI_NAME").map(String::as_str), Some("小皮"));
        assert_eq!(env.get("PATH").map(String::as_str), Some("C:\\bin"));
        for k in ["ASN_RELAY_KEY", "IRORI_RELAY_KEY", "bad-name"] {
            assert!(!env.contains_key(k), "{k} 不能帶進自帶終端：{env:?}");
        }
        // 提供者的金鑰是 pi 自己要讀的（跟原生主控台一樣照 child_env 的規則，只擋 ASN 自己的金鑰）
        assert_eq!(env.get("MINIMAX_API_KEY").map(String::as_str), Some("pi 自己要用"));
    }

    #[test]
    fn 沒有自帶終端或開不起來_退回原生主控台並用白話說明() {
        for (h, want) in [(None, PI_TERM_NONE), (Some(host(false, Ok(1))), PI_TERM_NONE), (Some(host(true, Err(WinOpenError::NotStarted("wezterm-gui.exe 錯誤碼 5".into())))), PI_TERM_FAILED)] {
            let r = open_pi(h.as_ref().map(|x| x as &dyn PiTermHost), base(), "pi", &args(), Path::new("D:\\p"), false, &[], &|| Ok(77)).unwrap();
            assert_eq!(r, PiOpened { pid: 77, note: Some(want) });
            assert!(!want.contains("wezterm") && !want.contains("錯誤碼"), "說明不帶技術細節");
        }
        assert!(host(false, Ok(1)).got.lock().unwrap().is_empty());
    }

    #[test]
    fn 開關關著_背景開照_0_1_113_直接走原生主控台_前景開照舊先用自帶終端() {
        let h = host(true, Ok(4321));
        let r = open_pi_gated(false, Some(&h), base(), "pi", &args(), Path::new("D:\\p"), true, &[], &|| Ok(9)).unwrap();
        assert_eq!(r, PiOpened { pid: 9, note: None });
        assert!(h.got.lock().unwrap().is_empty(), "背景開、開關關著＝不碰自帶終端");
        let r = open_pi_gated(false, Some(&h), base(), "pi", &args(), Path::new("D:\\p"), false, &[], &|| Ok(9)).unwrap();
        assert_eq!(r.pid, 4321, "前景開 0.1.113 就先用自帶終端（#475）");
        assert_eq!(*h.hidden.lock().unwrap(), vec![false]);
        // 開關開著：背景開也開在自帶終端並要求隱藏
        let r = open_pi_gated(true, Some(&h), base(), "pi", &args(), Path::new("D:\\p"), true, &[], &|| Ok(9)).unwrap();
        assert_eq!(r.pid, 4321);
        assert_eq!(*h.hidden.lock().unwrap(), vec![false, true]);
    }

    #[test]
    fn 背景開_跟_claude_同一套_開在自帶終端並要求隱藏() {
        let h = host(true, Ok(4321));
        let r = open_pi(Some(&h), base(), "pi", &args(), Path::new("D:\\p"), true, &[], &|| Ok(9)).unwrap();
        assert_eq!(r, PiOpened { pid: 4321, note: None }, "背景開也先用自帶終端（設計 1.4）");
        assert_eq!(*h.hidden.lock().unwrap(), vec![true], "要求開完就隱藏");
        // 自帶終端不在：背景開照舊退回原生主控台（Hidden 樣式）
        let r = open_pi(None, base(), "pi", &args(), Path::new("D:\\p"), true, &[], &|| Ok(9)).unwrap();
        assert_eq!(r.pid, 9);
    }

    #[test]
    fn 自帶終端已啟動之後才失敗_不退回原生主控台() {
        let h = host(true, Err(WinOpenError::Started("終端已啟動但對照表寫入失敗".into())));
        let fb = std::cell::Cell::new(false);
        let e = open_pi(Some(&h), base(), "pi", &args(), Path::new("D:\\p"), false, &[], &|| {
            fb.set(true);
            Ok(9)
        })
        .unwrap_err();
        assert!(!fb.get(), "不能再開第二份");
        assert!(e.contains("對照表寫入失敗"), "{e}");
    }

    #[test]
    fn 原生主控台也開不起來_照實回錯() {
        let e = open_pi(None, base(), "pi", &args(), Path::new("D:\\p"), false, &[], &|| Err("開不起來：找不到檔案".into())).unwrap_err();
        assert!(e.contains("開不起來"));
    }

    /// 真機手動驗收（#475）：用本機 pi 的啟動設定與 ASN 的 pi 擴充，經 ASN 自帶的終端開一個「雯測試pi」，
    /// 確認：登記上名單、畫面有顏色、按鍵送得進去、切到背景（隱藏）超過一次心跳（60 秒）後心跳還在、叫得回來；
    /// 使用者自己開著的 WezTerm 不受影響。最後只結束自己開的那個 pi（記下的 PID），WezTerm 會跟著自己關。
    /// 執行：ASN_WEZTERM_DIR=%LOCALAPPDATA%\ASN\wezterm cargo test --lib -- --ignored 真機_經_pi_開在自帶終端 --nocapture
    #[cfg(all(windows, feature = "gui"))]
    #[test]
    #[ignore]
    fn 真機_經_pi_開在自帶終端_能切前後景_心跳不斷() {
        use crate::launch::console::win;
        use crate::launch::console_resolve::{find_for, ConsoleOs, ConsoleWin};
        use crate::launch::switch::Proc;
        use crate::nowin::NoWindow;
        struct Os {
            own: Vec<u32>,
        }
        impl ConsoleOs for Os {
            fn find_console(&self, _pid: u32) -> Option<ConsoleWin> {
                None
            }
            fn find_wt_windows(&self, _wt: u32) -> Vec<ConsoleWin> {
                vec![]
            }
            fn own_wezterm(&self) -> Vec<u32> {
                self.own.clone()
            }
            fn find_wez_windows(&self, gui: u32) -> Vec<ConsoleWin> {
                win::find_wez_windows(gui)
            }
            fn table(&self) -> Vec<Proc> {
                crate::launch::switch::winapi::process_table()
            }
            fn own_pid(&self) -> u32 {
                std::process::id()
            }
        }
        let now = || std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as u64;
        let wez_before: Vec<u32> = crate::launch::switch::winapi::process_table().into_iter().filter(|p| p.name == "wezterm-gui.exe").map(|p| p.pid).collect();
        let data = tempfile::tempdir().unwrap();
        let work = tempfile::tempdir().unwrap();
        let svc = super::super::term::live(data.path());
        let name = "雯測試pi";
        let config = super::super::config::load_launch_config().expect("本機啟動設定");
        let req = super::super::config::LaunchReq { profile: "pi", name, cwd: work.path().to_string_lossy().into_owned() };
        let (command, args, cwd) = super::super::config::build_spawn_spec(&config, &req).unwrap();
        let plan = super::super::pi::plan(name, &args, super::super::pi::resolve_ext_state(), "", work.path(), now()).expect("pi 擴充");
        let argv: Vec<String> = std::iter::once(command.clone()).chain(plan.args.iter().cloned()).collect();
        let env = pi_term_env(super::super::config::child_env(), &plan.env);
        assert!(!env.contains_key("ASN_RELAY_KEY"));
        let gui = <super::super::term::LiveTerms as PiTermHost>::start_pi(&svc, &cwd, &argv, &env, false).expect("開在自帶終端");
        println!("GUI pid={gui}");
        let home = crate::identity::home_dir();
        let dir = crate::bridge::engines::pi::windows_dir(&home);
        let reg = || crate::bridge::engines::pi::read_windows(&dir, now(), win::pid_alive).into_iter().find(|w| w.name == name);
        // pi 對沒信任過的資料夾會先問「要不要信任」，擴充要選完才載入：選「只信任這一次」（往下兩格、Enter），不改 pi 的設定
        let sock0 = crate::launch::wezterm::sock_path(&home, gui);
        let cli0 = std::path::PathBuf::from(std::env::var("ASN_WEZTERM_DIR").unwrap()).join("wezterm.exe");
        let mut found = None;
        let mut answered = false;
        for _ in 0..60 {
            if let Some(w) = reg() {
                found = Some(w);
                break;
            }
            if !answered {
                let t = std::process::Command::new(&cli0).no_window().env("WEZTERM_UNIX_SOCKET", &sock0).args(["cli", "get-text"]).output().map(|o| String::from_utf8_lossy(&o.stdout).into_owned()).unwrap_or_default();
                if t.contains("Trust project folder?") && t.contains("Trust (this session only)") {
                    let _ = std::process::Command::new(&cli0).no_window().env("WEZTERM_UNIX_SOCKET", &sock0).args(["cli", "send-text", "--no-paste", "\u{1b}[B\u{1b}[B\r"]).output();
                    println!("pi 問要不要信任這個暫存資料夾：選了「只信任這一次」");
                    answered = true;
                }
            }
            std::thread::sleep(std::time::Duration::from_millis(500));
        }
        let result = (|| -> Result<(), String> {
            let w = found.clone().ok_or("30 秒內沒登記上名單（pi 擴充沒載入？）")?;
            println!("登記上名單：pi pid={} 模型={:?}", w.pid, w.model);
            let id = svc.list().into_iter().find(|t| t.pid == gui).map(|t| t.id).ok_or("對照表裡沒有")?;
            let sock = crate::launch::wezterm::sock_path(&home, gui);
            let cli = std::path::PathBuf::from(std::env::var("ASN_WEZTERM_DIR").unwrap()).join("wezterm.exe");
            let esc = std::process::Command::new(&cli).no_window().env("WEZTERM_UNIX_SOCKET", &sock).args(["cli", "get-text", "--escapes"]).output().map_err(|e| e.to_string())?;
            let colored = String::from_utf8_lossy(&esc.stdout).contains("\u{1b}[");
            println!("畫面有顏色（ANSI 色碼）：{colored}");
            let before = svc.read(&id, 30)?;
            svc.confirm_send(&id, "/", false)?;
            std::thread::sleep(std::time::Duration::from_millis(1500));
            let after = svc.read(&id, 30)?;
            println!("送「/」之後畫面有變（按鍵送得進去）：{}", before != after);
            let (owner, cw) = find_for(w.pid, &Os { own: svc.own_gui_pids() })?;
            println!("切換目標：GUI {owner}（{}）", if owner == gui { "就是剛開的那個" } else { "不對！" });
            let at0 = reg().map(|x| x.updated_at).unwrap_or(0);
            win::set_visible(cw.hwnd, false)?;
            println!("已隱藏：{}", !win::is_visible(cw.hwnd));
            std::thread::sleep(std::time::Duration::from_secs(70));
            let at1 = reg().map(|x| x.updated_at).unwrap_or(0);
            println!("隱藏 70 秒後心跳：{at0} → {at1}（{}）", if at1 > at0 { "有更新" } else { "沒更新！" });
            win::set_visible(cw.hwnd, true)?;
            println!("叫回來：{}", win::is_visible(cw.hwnd));
            if owner != gui || at1 <= at0 || !colored || before == after {
                return Err("有一項沒過，看上面的輸出".into());
            }
            Ok(())
        })();
        // 不管成功失敗都收掉：先結束 pi（記下的 PID），再收這次開的 GUI 與它底下的程序（只有這一棵）；
        // 暫存的設定檔要等 GUI 關了才刪（不然 GUI 重讀設定時會跳「設定錯誤」視窗）
        if let Some(w) = found {
            let _ = std::process::Command::new("taskkill").no_window().args(["/PID", &w.pid.to_string(), "/T", "/F"]).output();
        }
        std::thread::sleep(std::time::Duration::from_secs(2));
        if win::pid_alive(gui) {
            let _ = std::process::Command::new("taskkill").no_window().args(["/PID", &gui.to_string(), "/T", "/F"]).output();
        }
        std::thread::sleep(std::time::Duration::from_secs(3));
        println!("結束 pi 後 GUI 還在：{}", win::pid_alive(gui));
        let wez_after: Vec<u32> = crate::launch::switch::winapi::process_table().into_iter().filter(|p| p.name == "wezterm-gui.exe").map(|p| p.pid).collect();
        println!("使用者原本的 WezTerm {wez_before:?} 都還在：{}", wez_before.iter().all(|p| wez_after.contains(p)));
        result.unwrap();
    }

    #[test]
    fn 守門_經_pi_的四條路都走這個入口_claude_不走() {
        let local = include_str!("local.rs");
        assert_eq!(local.matches("super::pi_term::open_pi_real(").count(), 3, "本機開、遠端開、接手／喚醒（start_pi_session）都要走自帶終端優先");
        assert!(!local.contains("start_console_window_env(&req.name, &command, &plan.args"), "本機經 pi 不能直接開原生主控台");
        let pt = include_str!("pi_term.rs");
        assert!(pt.contains("super::local::start_console_window_env("), "pi 的退路直接開原生主控台（自帶終端已經試過，不再繞回開窗點重試）");
    }

    #[test]
    fn 交給_pi_的資料夾拿掉長路徑前綴() {
        assert_eq!(pi_cwd(Path::new(r"\\?\G:\GsEnergy")), PathBuf::from(r"G:\GsEnergy"));
        assert_eq!(pi_cwd(Path::new(r"\\?\UNC\srv\share\x")), PathBuf::from(r"\\srv\share\x"));
        assert_eq!(pi_cwd(Path::new(r"C:\Users\u")), PathBuf::from(r"C:\Users\u"), "沒有前綴就不動");
        assert!(!pi_cwd(Path::new(r"\\?\G:\GsEnergy")).to_string_lossy().contains('?'));
    }

    #[test]
    fn 守門_open_pi_real_一進來就拿掉前綴_三條路都經過它() {
        let pt = include_str!("pi_term.rs").replace("\r\n", "\n");
        let body = &pt[pt.find("pub(crate) fn open_pi_real(").unwrap()..];
        let first = body.lines().nth(1).unwrap().trim();
        assert_eq!(first, "let cwd = &pi_cwd(cwd);", "第一行就換掉 cwd，自帶終端與退路都用拿掉前綴的那個");
        let local = include_str!("local.rs");
        assert_eq!(local.matches("super::pi_term::open_pi_real(").count(), 3);
        assert!(!local.contains("pi_cwd("), "修在 open_pi_real 本身，不在呼叫點");
    }
}

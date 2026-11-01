//! 0.2.0 第 1 階段（docs/design/WEZTERM.md 1.1～1.5）：Windows 上 ASN 開的夥伴視窗一律先開在 ASN 自帶的 WezTerm。
//! 上層各條路（開新夥伴本機／遠端、接回對話、換模型重開、改名退路、接班換手）都經 `local::start_window`，
//! 那裡只換最底層、交給這裡；參數照舊由呼叫端組好（build_spawn_spec／apply_resume_real／rewrite_args_opts／resume_argv），這裡一個字都不改。
//! 自帶的終端找不到、或開不起來，就照舊開原生主控台（退路），並只提示使用者一次。
//! 自帶終端的服務由畫面那一層在啟動時交給 [`super::term::set_global`]；這裡只透過 [`WinTermHost`] 介面用它，測試注入假的。
use std::collections::{BTreeMap, HashMap};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};

/// 自帶的終端找不到或開不起來、改用原生主控台時，給使用者看的一句話（只講一次；技術細節只進 log）
pub(crate) const WIN_TERM_FALLBACK: &str = "內建終端開不起來，改用一般視窗";

/// 這次 ASN 執行期間有沒有講過「改用一般視窗」（只提示一次）
static FALLBACK_NOTED: AtomicBool = AtomicBool::new(false);

/// 0.2.0 第 1 階段的總開關（#611）：預設關。關著＝Windows 開窗與 0.1.113 一樣（claude／codex 視窗開在原生主控台，
/// 經 pi 只有前景開在自帶終端、背景開走原生主控台，關閉看承載 PowerShell）；開了才走自帶 WezTerm（本檔其餘部分）。
/// 啟動時由 term::live() 讀一次環境變數後設定（同 ASN_TERM_MUX 的讀法），執行中不再變。
static WEZTERM_WINDOWS: AtomicBool = AtomicBool::new(false);

/// 開關環境變數名：`ASN_TERM_WEZTERM=1` 才讓 ASN 開的夥伴視窗走自帶 WezTerm
pub(crate) const ENV_WEZTERM: &str = "ASN_TERM_WEZTERM";
/// B2b 的開關環境變數名（#607）：`ASN_TERM_MUX=1` 才開在共用 mux。它建立在 WezTerm 之上，見 [`switches_from`]
pub(crate) const ENV_MUX: &str = "ASN_TERM_MUX";

/// 兩個開關的關係（唯一定義處）：回（WezTerm 開窗, mux 模式）。
/// - WezTerm 開窗：ASN_TERM_WEZTERM=1 才開，預設關。
/// - mux 模式：ASN_TERM_MUX=1 **而且** WezTerm 開窗也開才算；WezTerm 關著時 ASN_TERM_MUX=1 無效（mux 只是 WezTerm 窗格的放法，沒有 WezTerm 就沒有東西可放）。
pub(crate) fn switches_from(wezterm: Option<&str>, mux: Option<&str>) -> (bool, bool) {
    let wez = wezterm == Some("1");
    (wez, wez && mux == Some("1"))
}

/// 啟動時設定一次（term::live() 呼叫）
pub(crate) fn set_wezterm_windows(on: bool) {
    WEZTERM_WINDOWS.store(on, Ordering::SeqCst);
}

/// 現在開著嗎（預設 false）
pub(crate) fn wezterm_windows() -> bool {
    WEZTERM_WINDOWS.load(Ordering::SeqCst)
}

/// 對照表裡記的視窗種類：Claude Code 本體記 "claude"；其他經這裡開的程式（例如 Codex）記 "window"
pub(crate) const KIND_CLAUDE: &str = "claude";
pub(crate) const KIND_WINDOW: &str = "window";

/// 要開的一扇視窗。argv[0] 是程式本身；env＝已過 child_env 的環境（GUI 與裡面的程式只拿到這些）
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct WinSpec {
    pub kind: &'static str,
    /// 夥伴名字（放進分頁標題，認領仍靠前面的 ASN:編號）
    pub title: String,
    pub argv: Vec<String>,
    pub env: BTreeMap<String, String>,
    /// 參數裡帶的 --resume／--session-id（新開的對話還沒有，None）
    pub session_id: Option<String>,
    /// 背景開：開完立刻隱藏
    pub hidden: bool,
}

/// 自帶終端開不起來的兩種情況：決定能不能改用原生主控台（asn真 審 #573）
#[derive(Debug, Clone, PartialEq)]
pub(crate) enum WinOpenError {
    /// GUI 還沒啟動就失敗（找不到 WezTerm、資料夾不存在、執行檔起不來）：沒有任何程式在跑，可以改用原生主控台
    NotStarted(String),
    /// GUI 已經啟動之後才失敗（等不到通訊檔、讀不到窗格、設不了標題、對照表寫不進去）：裡面的 claude 可能已經在跑，
    /// 不能再開第二份（同一個 --resume 兩個程序會一起寫同一段對話），直接回錯
    Started(String),
}

/// GUI 已經啟動之後失敗時，給使用者看的開頭（後面接原因）
pub(crate) const STARTED_BUT_FAILED: &str = "內建終端已開，但沒能登記這扇視窗，為了不重複開同一段對話，沒有改用一般視窗";

/// ASN 自帶的終端（正式＝TermService；測試換成假的）
pub(crate) trait WinTermHost: Send + Sync {
    /// 這台找得到自帶的終端
    fn available(&self) -> bool;
    /// 在 cwd 開 spec，寫進對照表；回 GUI 的程序編號
    fn open_window(&self, cwd: &Path, spec: &WinSpec) -> Result<u32, WinOpenError>;
}

/// 開好了：pid＝自帶終端的 GUI，或退路主控台的承載 PowerShell；note＝第一次改用一般視窗時給使用者看的話
#[derive(Debug, PartialEq)]
pub(crate) struct Opened {
    pub pid: u32,
    pub note: Option<&'static str>,
}

/// 參數裡的對話編號：`--resume <id>`、`--resume=<id>`、`--session-id <id>`、`--session-id=<id>`（`--` 之後不算）
pub(crate) fn session_id_of(args: &[String]) -> Option<String> {
    let mut i = 0;
    while i < args.len() {
        let a = args[i].as_str();
        if a == "--" {
            break;
        }
        if a == "--resume" || a == "-r" || a == "--session-id" {
            if let Some(v) = args.get(i + 1).filter(|v| !v.is_empty() && !v.starts_with('-')) {
                return Some(v.clone());
            }
        } else if let Some(v) = a.strip_prefix("--resume=").or_else(|| a.strip_prefix("--session-id=")) {
            if !v.is_empty() {
                return Some(v.to_string());
            }
        }
        i += 1;
    }
    None
}

/// 給自帶終端的環境：base 已照 child_env 濾掉金鑰類變數（ASN_RELAY_KEY 等），再加上 extra（變數名只收大寫英數與底線、金鑰類不收）
pub(crate) fn term_env(base: HashMap<String, String>, extra: &[(String, String)]) -> BTreeMap<String, String> {
    super::pi_term::pi_term_env(base, extra)
}

/// 組一扇視窗：Claude 本體記 kind "claude"，其餘記 "window"
pub(crate) fn spec_for(title: &str, command: &str, args: &[String], hidden: bool, env: BTreeMap<String, String>) -> WinSpec {
    let argv: Vec<String> = std::iter::once(command.to_string()).chain(args.iter().cloned()).collect();
    let kind = if super::switch::looks_like_claude(&argv) || super::switch::wraps_claude(&argv) { KIND_CLAUDE } else { KIND_WINDOW };
    WinSpec { kind, title: title.to_string(), session_id: if kind == KIND_CLAUDE { session_id_of(args) } else { None }, argv, env, hidden }
}

/// 有自帶的終端就開在裡面，否則（或 GUI 還沒啟動就失敗）用 fallback 開原生主控台。改用一般視窗只在第一次回 note（noted 記這件事）。
/// GUI 已經啟動之後才失敗：不走退路，照實回錯（不另外再開一份）
pub(crate) fn open_window(host: Option<&dyn WinTermHost>, cwd: &Path, spec: &WinSpec, noted: &AtomicBool, fallback: &dyn Fn() -> Result<u32, String>) -> Result<Opened, String> {
    match host.filter(|h| h.available()) {
        None => elog!("開「{}」：這台沒有 ASN 自帶的終端，改用原生主控台", spec.title),
        Some(h) => match h.open_window(cwd, spec) {
            Ok(pid) => return Ok(Opened { pid, note: None }),
            Err(WinOpenError::NotStarted(e)) => elog!("開「{}」在 ASN 自帶的終端失敗（還沒啟動），改用原生主控台：{e}", spec.title),
            Err(WinOpenError::Started(e)) => {
                elog!("開「{}」：自帶終端已啟動但後續失敗，不改用原生主控台：{e}", spec.title);
                return Err(format!("{STARTED_BUT_FAILED}：{e}"));
            }
        },
    }
    let pid = fallback()?;
    let first = !noted.swap(true, Ordering::SeqCst);
    Ok(Opened { pid, note: first.then_some(WIN_TERM_FALLBACK) })
}

/// 開關的分岔點：關著＝直接用 fallback（0.1.113 的 start_window_windows：原生主控台、不提示、不碰自帶終端）；開著才走 [`open_window`]
pub(crate) fn open_window_gated(on: bool, host: Option<&dyn WinTermHost>, cwd: &Path, spec: &WinSpec, noted: &AtomicBool, fallback: &dyn Fn() -> Result<u32, String>) -> Result<Opened, String> {
    if !on {
        return fallback().map(|pid| Opened { pid, note: None });
    }
    open_window(host, cwd, spec, noted, fallback)
}

/// 正式：自帶的終端從全域取（沒有畫面的建置、測試一律沒有）；開關見 [`wezterm_windows`]
pub(crate) fn open_window_real(cwd: &Path, spec: &WinSpec, fallback: &dyn Fn() -> Result<u32, String>) -> Result<Opened, String> {
    let host = host();
    open_window_gated(wezterm_windows(), host.as_deref(), cwd, spec, &FALLBACK_NOTED, fallback)
}

/// 「改用一般視窗」這次執行還沒講過就回 true 並記下（pi 的退路也照這一套只提示一次）
pub(crate) fn first_fallback_note() -> bool {
    !FALLBACK_NOTED.swap(true, Ordering::SeqCst)
}

fn host() -> Option<std::sync::Arc<dyn WinTermHost>> {
    #[cfg(all(desktop, feature = "gui", not(test)))]
    {
        super::term::win_host()
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
        got: Mutex<Vec<(String, WinSpec)>>,
    }
    impl WinTermHost for FakeHost {
        fn available(&self) -> bool {
            self.available
        }
        fn open_window(&self, cwd: &Path, spec: &WinSpec) -> Result<u32, WinOpenError> {
            self.got.lock().unwrap().push((cwd.to_string_lossy().into_owned(), spec.clone()));
            self.result.clone()
        }
    }
    fn host(available: bool, result: Result<u32, WinOpenError>) -> FakeHost {
        FakeHost { available, result, got: Mutex::new(vec![]) }
    }
    fn sv(a: &[&str]) -> Vec<String> {
        a.iter().map(|s| s.to_string()).collect()
    }
    /// 照真的路徑：先過 child_env 的過濾
    fn base() -> HashMap<String, String> {
        super::super::config::child_env_from(
            [("PATH", "C:\\bin"), ("ASN_RELAY_KEY", "不能外流"), ("IRORI_RELAY_KEY", "舊名也不行"), ("ASN_RELAY_ANON_KEY", "也不行"), ("CLAUDECODE", "1"), ("USERPROFILE", "C:\\Users\\u")].into_iter().map(|(k, v)| (k.to_string(), v.to_string())),
        )
    }

    #[test]
    fn 對話編號從參數取_沒有就是none() {
        assert_eq!(session_id_of(&sv(&["-n", "甲", "--resume", "abc-1"])), Some("abc-1".into()));
        assert_eq!(session_id_of(&sv(&["--resume=abc-2"])), Some("abc-2".into()));
        assert_eq!(session_id_of(&sv(&["--session-id", "abc-3", "-n", "x"])), Some("abc-3".into()));
        assert_eq!(session_id_of(&sv(&["--resume"])), None, "缺值");
        assert_eq!(session_id_of(&sv(&["--resume", "--model", "x"])), None, "下一個是旗標不算");
        assert_eq!(session_id_of(&sv(&["--", "--resume", "x"])), None, "-- 之後是第一句話，不算");
        assert_eq!(session_id_of(&[]), None);
    }

    #[test]
    fn claude_記成_claude_並帶對話編號_其他程式記成_window() {
        let s = spec_for("小乙", r"C:\bin\claude.exe", &sv(&["-n", "小乙", "--resume", "sid-9"]), true, BTreeMap::new());
        assert_eq!((s.kind, s.session_id.as_deref(), s.hidden), (KIND_CLAUDE, Some("sid-9"), true));
        assert_eq!(s.argv, sv(&[r"C:\bin\claude.exe", "-n", "小乙", "--resume", "sid-9"]), "指令與參數原樣，一個字都不改");
        let c = spec_for("小丙", "cmd.exe", &sv(&["/c", "codex", "resume", "t1"]), false, BTreeMap::new());
        assert_eq!((c.kind, c.session_id), (KIND_WINDOW, None));
        // 外殼包著的 claude 也記成 claude（#622）；包著 cd x; claude 的不算
        let p = spec_for("小丁", "powershell", &sv(&["-NoExit", "-Command", "claude -n 小丁"]), false, BTreeMap::new());
        assert_eq!(p.kind, KIND_CLAUDE);
        assert_eq!(p.argv, sv(&["powershell", "-NoExit", "-Command", "claude -n 小丁"]), "指令與參數原樣");
        let q = spec_for("小戊", "powershell", &sv(&["-Command", "cd x; claude"]), false, BTreeMap::new());
        assert_eq!(q.kind, KIND_WINDOW);
    }

    #[test]
    fn 有自帶終端_開在裡面_環境經過_child_env_金鑰類一律不帶() {
        let h = host(true, Ok(4321));
        let noted = AtomicBool::new(false);
        let env = term_env(base(), &[("ASN_X".into(), "1".into()), ("ASN_RELAY_KEY".into(), "硬塞也不收".into())]);
        let spec = spec_for("小乙", "claude.exe", &sv(&["-n", "小乙"]), false, env);
        let fb = std::cell::Cell::new(false);
        let r = open_window(Some(&h), Path::new("D:\\proj"), &spec, &noted, &|| {
            fb.set(true);
            Ok(1)
        })
        .unwrap();
        assert_eq!(r, Opened { pid: 4321, note: None });
        assert!(!fb.get(), "開成功就不開原生主控台");
        let got = h.got.lock().unwrap();
        let (cwd, s) = &got[0];
        assert_eq!(cwd, "D:\\proj");
        assert_eq!(s.env.get("PATH").map(String::as_str), Some("C:\\bin"));
        assert_eq!(s.env.get("ASN_X").map(String::as_str), Some("1"));
        for k in ["ASN_RELAY_KEY", "IRORI_RELAY_KEY", "ASN_RELAY_ANON_KEY", "CLAUDECODE"] {
            assert!(!s.env.contains_key(k), "{k} 不能帶進 claude 視窗：{:?}", s.env);
        }
        assert!(!noted.load(Ordering::SeqCst), "沒改用一般視窗就不算提示過");
    }

    #[test]
    fn 找不到或開不起來_退回原生主控台_只提示一次() {
        let noted = AtomicBool::new(false);
        let spec = spec_for("小乙", "claude.exe", &[], false, BTreeMap::new());
        let cases: Vec<Option<FakeHost>> = vec![None, Some(host(false, Ok(1))), Some(host(true, Err(WinOpenError::NotStarted("wezterm-gui.exe 錯誤碼 5".into()))))];
        let mut notes = Vec::new();
        for h in &cases {
            let r = open_window(h.as_ref().map(|x| x as &dyn WinTermHost), Path::new("D:\\p"), &spec, &noted, &|| Ok(77)).unwrap();
            assert_eq!(r.pid, 77);
            notes.push(r.note);
        }
        assert_eq!(notes, vec![Some(WIN_TERM_FALLBACK), None, None], "只在第一次提示");
        assert!(!WIN_TERM_FALLBACK.contains("wezterm") && !WIN_TERM_FALLBACK.contains("錯誤碼"), "說明不帶技術細節");
        assert!(cases[1].as_ref().unwrap().got.lock().unwrap().is_empty(), "找不到就不去開");
    }

    #[test]
    fn 自帶終端已啟動之後才失敗_不走退路_不開第二份() {
        let noted = AtomicBool::new(false);
        let spec = spec_for("小乙", "claude.exe", &sv(&["-n", "小乙", "--resume", "sid-1"]), false, BTreeMap::new());
        let h = host(true, Err(WinOpenError::Started("無法設定終端標題：假的失敗".into())));
        let fb = std::cell::Cell::new(0);
        let e = open_window(Some(&h), Path::new("D:\\p"), &spec, &noted, &|| {
            fb.set(fb.get() + 1);
            Ok(77)
        })
        .unwrap_err();
        assert_eq!(fb.get(), 0, "GUI 已經啟動就不能再開原生主控台（同一個 --resume 會有兩份）");
        assert!(e.starts_with(STARTED_BUT_FAILED) && e.contains("無法設定終端標題"), "照實說原因：{e}");
        assert!(!noted.load(Ordering::SeqCst), "沒改用一般視窗");
        assert_eq!(h.got.lock().unwrap().len(), 1, "只開過一次");
    }

    #[test]
    fn 退路也開不起來_照實回錯_不算提示過() {
        let noted = AtomicBool::new(false);
        let spec = spec_for("小乙", "claude.exe", &[], false, BTreeMap::new());
        let e = open_window(None, Path::new("D:\\p"), &spec, &noted, &|| Err("開不起來：找不到檔案".into())).unwrap_err();
        assert!(e.contains("開不起來"));
        assert!(!noted.load(Ordering::SeqCst));
    }

    // ---- #611：開關（ASN_TERM_WEZTERM，預設關）

    #[test]
    fn 開關關著_開窗直接走原生主控台_不碰自帶終端_不提示() {
        let h = host(true, Ok(4321));
        let noted = AtomicBool::new(false);
        let spec = spec_for("小乙", "claude.exe", &sv(&["-n", "小乙"]), false, BTreeMap::new());
        let r = open_window_gated(false, Some(&h), Path::new("D:\\proj"), &spec, &noted, &|| Ok(77)).unwrap();
        assert_eq!(r, Opened { pid: 77, note: None }, "跟 0.1.113 一樣：回承載殼的 pid、沒有說明");
        assert!(h.got.lock().unwrap().is_empty(), "關著不能去開自帶終端");
        assert!(!noted.load(Ordering::SeqCst));
        // 退路自己失敗就照實回錯
        assert!(open_window_gated(false, Some(&h), Path::new("D:\\p"), &spec, &noted, &|| Err("開不起來：x".into())).is_err());
    }

    #[test]
    fn 開關開著_開窗走自帶終端() {
        let h = host(true, Ok(4321));
        let noted = AtomicBool::new(false);
        let spec = spec_for("小乙", "claude.exe", &[], false, BTreeMap::new());
        let r = open_window_gated(true, Some(&h), Path::new("D:\\proj"), &spec, &noted, &|| Ok(77)).unwrap();
        assert_eq!(r.pid, 4321);
        assert_eq!(h.got.lock().unwrap().len(), 1);
    }

    #[test]
    fn 兩個開關的關係_mux_要_wezterm_也開才算() {
        assert_eq!(switches_from(None, None), (false, false), "預設全關");
        assert_eq!(switches_from(None, Some("1")), (false, false), "WezTerm 關著時 ASN_TERM_MUX=1 無效");
        assert_eq!(switches_from(Some("0"), Some("1")), (false, false));
        assert_eq!(switches_from(Some("1"), None), (true, false), "只開 WezTerm 不開 mux");
        assert_eq!(switches_from(Some("1"), Some("1")), (true, true));
        assert_eq!(switches_from(Some("true"), Some("1")), (false, false), "只認 1");
    }

    #[test]
    fn 守門_開關預設關_開窗與關閉的分岔點都看同一個開關() {
        assert!(!wezterm_windows(), "沒人設定時預設關");
        let wt = include_str!("win_term.rs").split("#[cfg(test)]").next().unwrap();
        assert!(wt.contains("open_window_gated(wezterm_windows(),"), "open_window_real 用開關決定");
        let term = include_str!("term.rs");
        let live = term.split("pub fn live(").nth(1).unwrap().split("#[cfg(feature = \"gui\")]").next().unwrap();
        assert!(live.contains("switches_from(") && live.contains("set_wezterm_windows(wez)") && live.contains("set_use_mux(mux)") && live.contains("set_hold_config(wez)"), "live() 讀一次、mux 只吃 switches_from 算出來的值");
        assert!(!live.contains("set_use_mux(std::env"), "mux 不能直接吃環境變數");
        let own = term.split("pub(crate) fn own_gui_windows()").nth(1).unwrap().split("pub(crate) fn stop_own_gui").next().unwrap();
        assert!(own.contains("!super::win_term::wezterm_windows()"), "關著時不認自帶終端裡的夥伴視窗（關閉、opened_by_asn 都靠這個）");
        let stop = term.split("pub(crate) fn stop_own_gui").nth(1).unwrap().split("/// 背景開").next().unwrap();
        assert!(stop.contains("!super::win_term::wezterm_windows()"), "關著時不收 GUI");
        let local = include_str!("local.rs");
        let win = local.split("fn start_window_windows").nth(1).unwrap().split("fn start_console_window_windows").next().unwrap();
        assert!(win.contains("start_console_window_windows(title, command, args, cwd, hidden, &[])"), "退路＝0.1.113 的開法，參數原樣");
        let pi = include_str!("pi_term.rs");
        assert!(pi.contains("open_pi_gated(super::win_term::wezterm_windows(),"), "經 pi 的正式入口用開關");
    }

    /// 守門（1.1）：各條路都經 local::start_window 這一個開窗點，不各自開 WezTerm 或主控台
    #[test]
    fn 守門_各條路都走同一個開窗點() {
        let local = include_str!("local.rs");
        let switch = include_str!("switch.rs");
        let launch_rs = include_str!("../bridge/partner_ops.rs");
        // 開新夥伴（本機、遠端）都進 start_window
        let local_fn = local.split("pub fn partner_launch_local").nth(1).unwrap().split("pub(crate) enum ModelPlan").next().unwrap();
        assert!(local_fn.contains("start_window_noted("), "本機開新夥伴走開窗點");
        let remote_fn = local.split("pub fn start_remote_window").nth(1).unwrap().split("pub fn start_pi_session").next().unwrap();
        assert!(remote_fn.contains("start_window(name, &command, &args, &cwd, hidden)"), "遠端開新夥伴走開窗點");
        // 換模型重開、接回對話、改名退路、接班換手都進 switch::real_launch → local::start_window
        let real = switch.split("pub(crate) fn real_launch").nth(1).unwrap().split("pub(crate) struct RealOs").next().unwrap();
        assert!(real.contains("local::start_window("), "real_launch 走開窗點");
        assert!(launch_rs.contains("switch::real_launch"), "遠端管理夥伴視窗的重開走 real_launch");
        // 開窗點的 Windows 底層：先開自帶終端，退路才是原生主控台
        let win = local.split("fn start_window_windows").nth(1).unwrap().split("fn start_console_window_windows").next().unwrap();
        assert!(win.contains("win_term::open_window_real("), "Windows 開窗走 WezTerm");
        assert!(win.contains("start_console_window_windows("), "退路才用原生主控台");
        // 除了開窗點的退路與 pi 的退路入口，local.rs 沒有別的地方直接開原生主控台（測試不算）
        let body = local.split("#[cfg(test)]").next().unwrap();
        assert_eq!(body.matches("start_console_window_windows(").count(), 3, "定義、開窗點的退路、pi 的退路入口；不能有其他人直接開主控台");
    }
}

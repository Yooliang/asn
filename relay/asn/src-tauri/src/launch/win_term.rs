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

/// 0.2.0 第 1 階段的總開關（#611）：預設開（todo-next-15q）。關著＝Windows 開窗與 0.1.113 一樣（claude／codex 視窗開在原生主控台，
/// 經 pi 只有前景開在自帶終端、背景開走原生主控台，關閉看承載 PowerShell）；開了才走自帶 WezTerm（本檔其餘部分）。
/// 啟動時由 term::live() 讀一次環境變數後設定（同 ASN_TERM_MUX 的讀法），執行中不再變。
static WEZTERM_WINDOWS: AtomicBool = AtomicBool::new(false);

/// 開關環境變數名：預設走自帶 WezTerm，`ASN_TERM_WEZTERM=0` 才退回原生主控台
pub(crate) const ENV_WEZTERM: &str = "ASN_TERM_WEZTERM";
/// B2b 的開關環境變數名（#607）：預設開在共用 mux（伺服器終端，0.2.4），`ASN_TERM_MUX=0` 才關。它建立在 WezTerm 之上，見 [`switches_from`]
pub(crate) const ENV_MUX: &str = "ASN_TERM_MUX";

/// 兩個開關的關係（唯一定義處）：回（WezTerm 開窗, mux 模式）。
/// - WezTerm 開窗：Windows 預設開，ASN_TERM_WEZTERM=0 才關（其他值都算開，打錯字不會悄悄退回舊路）。
/// - mux 模式：Windows 預設開，ASN_TERM_MUX=0 才關；WezTerm 開窗關著時一定關（mux 只是 WezTerm 窗格的放法）。
/// 預設開只限 Windows（自帶終端目前只打包 Windows）；其他平台照舊，要明講 `=1` 才開
pub(crate) fn switches_from(wezterm: Option<&str>, mux: Option<&str>) -> (bool, bool) {
    switches_on(cfg!(windows), wezterm, mux)
}

fn switches_on(windows: bool, wezterm: Option<&str>, mux: Option<&str>) -> (bool, bool) {
    if !windows {
        let wez = wezterm == Some("1");
        return (wez, wez && mux == Some("1"));
    }
    let wez = wezterm != Some("0");
    (wez, wez && mux != Some("0"))
}

/// 伺服器終端（共用 mux）這次啟動的結果，給設定頁顯示（#868）：啟動時由 term::live() 設一次，執行中不再變
static TERM_SERVER_ACTIVE: AtomicBool = AtomicBool::new(false);
static TERM_SERVER_LOCKED: AtomicBool = AtomicBool::new(false);

/// 使用者在設定頁關掉伺服器終端，加上環境變數的結果：回（要不要用, 被環境變數固定關）。
/// - 環境變數 `ASN_TERM_MUX=0` 優先，設定頁打開也不會開（跟 #854 同一套）；畫面上顯示「已由系統設定固定」。
/// - 否則看設定頁：使用者關掉了就不用。
/// 只管「使用者想不想用」；WezTerm 開窗關著時 mux 一定關，由呼叫端（`switches_from` 的結果）決定，不在這裡
pub(crate) fn term_server_wanted(env_mux: Option<&str>, user_off: bool) -> (bool, bool) {
    let locked = env_mux == Some("0");
    (!locked && !user_off, locked)
}

/// 啟動時記下這次實際有沒有用伺服器終端（`active`）與是不是被環境變數固定關（`locked`）
pub(crate) fn set_term_server_state(active: bool, locked: bool) {
    TERM_SERVER_ACTIVE.store(active, Ordering::SeqCst);
    TERM_SERVER_LOCKED.store(locked, Ordering::SeqCst);
}

/// 這次啟動有沒有在用伺服器終端（設定頁用來判斷「改了還沒生效」）
pub(crate) fn term_server_active() -> bool {
    TERM_SERVER_ACTIVE.load(Ordering::SeqCst)
}

/// 被環境變數固定關著（設定頁反灰、寫「已由系統設定固定」）
pub(crate) fn term_server_locked() -> bool {
    TERM_SERVER_LOCKED.load(Ordering::SeqCst)
}

/// 啟動時設定一次（term::live() 呼叫）
pub(crate) fn set_wezterm_windows(on: bool) {
    WEZTERM_WINDOWS.store(on, Ordering::SeqCst);
}

/// 現在開著嗎（程序剛啟動、live() 設定之前是 false）
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

/// 重開／接回的視窗要不要放背景（#906）：回（開在自帶終端時, 退回原生主控台時）。
/// 在用共用終端服務＝背景，畫面從 ASN 裡看；沒有服務就沒辦法在 ASN 裡看，開前台。退回原生主控台一律前台
#[cfg_attr(not(windows), allow(dead_code))]
pub(crate) fn relaunch_hidden(service_active: bool) -> (bool, bool) {
    (service_active, false)
}

/// 遠端開新夥伴（手機、電腦版開到別台）要不要放背景（#931）：照這台的設定，不讓遠端選。
/// pref＝這台「開新夥伴的顯示方式」偏好（launch-prefs.json 的 launchDisplay）。只有 background 算數：
/// 電腦版存啟動設定時會順手寫入預設的 foreground，分不出「選了前台」和「從來沒選過」，所以 foreground、沒存過、看不懂都跟重開同一套（[`relaunch_hidden`]，服務在用就背景）。
/// 共用終端服務沒在用時一律前台：沒有窗格可以藏，開在背景就看不到也找不回來
pub(crate) fn remote_hidden(pref: Option<&str>, service_active: bool) -> bool {
    if !service_active {
        return false;
    }
    pref == Some("background") || relaunch_hidden(service_active).0
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
        let win = |w, m| switches_on(true, w, m);
        assert_eq!(win(None, None), (true, true), "Windows 預設：WezTerm 與 mux 都開");
        assert_eq!(win(None, Some("0")), (true, false), "mux=0 只關 mux，夥伴開在各自的 WezTerm 視窗");
        assert_eq!(win(Some("0"), None), (false, false), "WezTerm=0 退回原生主控台，mux 也跟著關");
        assert_eq!(win(Some("0"), Some("1")), (false, false), "WezTerm 關著時 ASN_TERM_MUX=1 無效");
        assert_eq!(win(Some("1"), None), (true, true));
        assert_eq!(win(Some("1"), Some("1")), (true, true));
        assert_eq!(win(Some("true"), Some("true")), (true, true), "只有 0 算關，打錯字不會悄悄退回舊路");
        let other = |w, m| switches_on(false, w, m);
        assert_eq!(other(None, None), (false, false), "其他平台照舊：預設關");
        assert_eq!(other(None, Some("1")), (false, false));
        assert_eq!(other(Some("1"), None), (true, false));
        assert_eq!(other(Some("1"), Some("1")), (true, true));
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
        assert!(win.contains("start_console_window_windows(title, command, args, cwd, console_hidden, &[])"), "退路＝0.1.113 的開法，參數原樣（顯示方式由呼叫端指定）");
        let noted = local.split("pub(super) fn start_window_noted").nth(1).unwrap().split("fn start_window_windows").next().unwrap();
        assert!(noted.contains("start_window_windows(title, command, args, cwd, hidden, hidden)"), "一般開新夥伴：自帶終端與退路主控台用同一個顯示方式（和 0.1.113 一樣）");
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
        assert!(remote_fn.contains("start_window_split(name, &command, &args, &cwd, show.in_term, show.in_console)"), "遠端開新夥伴走開窗點（自帶終端與退路主控台的顯示方式分開給）");
        let split = local.split("pub(super) fn start_window_split").nth(1).unwrap().split("pub(super) fn start_console_window_env").next().unwrap();
        assert!(split.contains("start_window_windows(title, command, args, cwd, in_term, in_console)"), "遠端開也走同一個 Windows 開窗點");
        // 換模型重開、接回對話、改名退路、接班換手都進 switch::real_launch → local::start_window
        let real = switch.split("pub(crate) fn real_launch").nth(1).unwrap().split("pub(crate) struct RealOs").next().unwrap();
        assert!(real.contains("local::start_window_relaunch("), "real_launch 走重開專用的開窗點");
        assert!(launch_rs.contains("switch::real_launch"), "遠端管理夥伴視窗的重開走 real_launch");
        let relaunch = local.split("pub(super) fn start_window_relaunch").nth(1).unwrap().split("\n}\n").next().unwrap();
        assert!(relaunch.contains("start_window_windows(title, command, args, cwd, in_term, in_console)"), "重開也走同一個 Windows 開窗點，只是顯示方式不同");
        assert!(relaunch.contains("relaunch_hidden(super::win_term::term_server_active())"), "背景與否看這次執行有沒有在用共用終端服務");
        // 開窗點的 Windows 底層：先開自帶終端，退路才是原生主控台
        let win = local.split("fn start_window_windows").nth(1).unwrap().split("fn start_console_window_windows").next().unwrap();
        assert!(win.contains("win_term::open_window_real("), "Windows 開窗走 WezTerm");
        assert!(win.contains("start_console_window_windows("), "退路才用原生主控台");
        // 除了開窗點的退路與 pi 的退路入口，local.rs 沒有別的地方直接開原生主控台（測試不算）
        let body = local.split("#[cfg(test)]").next().unwrap();
        assert_eq!(body.matches("start_console_window_windows(").count(), 3, "定義、開窗點的退路、pi 的退路入口；不能有其他人直接開主控台");
    }

    #[test]
    fn 重開的視窗_在服務裡放背景_沒有服務或退回主控台開前台() {
        assert_eq!(relaunch_hidden(true), (true, false), "在用共用終端服務：開在背景；萬一退回原生主控台仍開前台");
        assert_eq!(relaunch_hidden(false), (false, false), "沒有共用終端服務：看不到 ASN 裡的畫面，開前台");
    }

    /// #931：遠端開新夥伴照這台的設定決定背景與否；終端服務沒在用時不管偏好一律前台
    #[test]
    fn 遠端開新夥伴_照這台設定_沒有終端服務一律前台() {
        for pref in [None, Some("foreground"), Some("background"), Some("怪值")] {
            assert!(!remote_hidden(pref, false), "沒有共用終端服務：{pref:?} 也開前台");
        }
        assert!(remote_hidden(Some("background"), true), "這台設成背景、服務在用：背景");
        assert!(remote_hidden(Some("foreground"), true), "foreground 分不出是選的還是預設寫入的：不算數，服務在用就背景");
        assert!(remote_hidden(None, true), "沒存過：跟重開一樣，服務在用就背景");
        assert!(remote_hidden(Some("怪值"), true), "看不懂的值：當沒存過");
        for pref in [None, Some("foreground"), Some("怪值")] {
            assert_eq!(remote_hidden(pref, true), relaunch_hidden(true).0, "{pref:?}：照重開的規則");
        }
    }

    /// #931：正式的遠端開一律接續對話（背景開也是）；只有測試用的隱藏視窗不查真實的對話檔；退回原生主控台一律前台
    #[test]
    fn 遠端開新夥伴_背景開仍接續對話() {
        use super::super::local::RemoteShow;
        for bg in [true, false] {
            let s = RemoteShow::real(bg);
            assert!(s.real_resume, "正式路徑（背景={bg}）要接續對話");
            assert_eq!((s.in_term, s.in_console), (bg, false), "背景只放在自帶終端；退回原生主控台一律前台");
        }
        let t = RemoteShow::test_hidden();
        assert!(!t.real_resume && t.in_term && t.in_console, "測試用：整個藏起來、不查真實的對話檔");
        // 原始碼守門：接續是看 real_resume，不再跟背景綁在一起；正式呼叫端用 RemoteShow::real 並照這台設定
        let local = include_str!("local.rs");
        let remote_fn = local.split("pub fn start_remote_window").nth(1).unwrap().split("pub fn start_pi_session").next().unwrap();
        let gate = remote_fn.find("if show.real_resume {").expect("接續看 real_resume");
        assert!(remote_fn[gate..].trim_start_matches("if show.real_resume {").trim_start().starts_with("super::resume::apply_resume_real("), "real_resume 為真時查真實的對話檔");
        assert!(!remote_fn.contains("if !hidden") && !remote_fn.contains("if !show.in_term"), "接續不能看背景與否");
        let launcher = include_str!("../bridge/launcher.rs");
        let start = launcher.split("impl LaunchEnv for SystemEnv").nth(1).unwrap().split("fn live_window").next().unwrap();
        assert!(start.contains("RemoteShow::real("), "正式遠端開用 RemoteShow::real（接續對話）");
        assert!(start.contains("remote_hidden(") && start.contains("term_server_active()"), "背景與否照這台設定與終端服務");
        assert!(!start.contains("test_hidden"), "正式路徑不能用測試用的顯示方式");
    }

    /// #906：喚醒、換模型重開、改名的退路、換班接手四條，都經 switch::real_launch 開窗（所以都套用上面的背景規則）
    #[test]
    fn 守門_重開的四條路都經_real_launch() {
        let ops = include_str!("../bridge/partner_ops.rs");
        let switch = include_str!("switch.rs");
        let body = |name: &str| -> String {
            let start = ops.find(&format!("    fn {name}(")).unwrap_or_else(|| panic!("找不到 {name}"));
            let rest = &ops[start..];
            let end = rest[5..].find("\n    fn ").map(|i| i + 5).unwrap_or(rest.len());
            rest[..end].to_string()
        };
        // 正式環境的 launch 就是 real_launch
        let real_env = ops.split("    fn launch(&self, plan: &Plan) -> Result<(), String> {").nth(1).expect("正式環境的 launch").split("\n    }").next().unwrap();
        assert!(real_env.contains("switch::real_launch(plan)"), "正式環境的 launch 交給 real_launch");
        assert!(body("resume").contains("self.env.launch(&plan)"), "喚醒");
        assert!(body("model").contains("env.launch(plan)"), "換模型重開（遠端管理）");
        assert!(body("reopen").contains("self.env.launch(&plan)"), "改名的退路與換班接手共用的重開");
        assert!(body("rename").contains("self.reopen("), "改名的退路走 reopen");
        assert!(body("handover").contains("self.reopen("), "換班接手走 reopen");
        assert!(switch.contains("run_with(&RealOs, &dir, &req, &real_launch,"), "本機換模型重開也用 real_launch");
    }

    // ---- #868：設定頁的「夥伴共用同一個終端服務」開關

    #[test]
    fn 伺服器終端_設定頁與環境變數的判斷表() {
        // （環境變數, 使用者關掉了）→（要不要用, 被環境變數固定關）
        assert_eq!(term_server_wanted(None, false), (true, false), "預設開");
        assert_eq!(term_server_wanted(None, true), (false, false), "使用者在設定頁關掉");
        assert_eq!(term_server_wanted(Some("0"), false), (false, true), "環境變數 0 優先：設定頁打開也不會開，畫面顯示已固定");
        assert_eq!(term_server_wanted(Some("0"), true), (false, true), "兩者都關：仍是固定");
        // 其他值都算開（打錯字不會悄悄關掉，跟 switches_from 同一套）；設定頁關掉照樣生效
        for v in ["1", "", "off", "false", "00"] {
            assert_eq!(term_server_wanted(Some(v), false), (true, false), "{v:?} 不算關");
            assert_eq!(term_server_wanted(Some(v), true), (false, false), "{v:?}＋設定頁關掉");
        }
    }

    #[test]
    fn 伺服器終端_設定頁只能再關不能強制開_wezterm_關著時一定關() {
        // 設定頁「開」不會把環境變數關著的 WezTerm 開窗打開：mux 只是 WezTerm 窗格的放法（switches_from 的規則不變）
        let (wez, mux) = switches_on(true, Some("0"), None);
        assert_eq!((wez, mux), (false, false));
        let (wanted, _) = term_server_wanted(None, false);
        assert!(!(mux && wanted), "WezTerm 關著：就算設定頁開著，這次也不用伺服器終端");
        // 非 Windows：照舊要明講 =1；設定頁關掉仍可再關
        let (wez, mux) = switches_on(false, Some("1"), Some("1"));
        assert_eq!((wez, mux), (true, true));
        assert!(!(mux && term_server_wanted(Some("1"), true).0));
    }

    /// 判斷表只證明純函式對；設定頁的開關要真的影響 live()：使用者設定與環境變數的結果要進 mux，這次啟動的結果要記下來給畫面用。
    /// 拿掉其中一行，開關就悄悄失效（判斷表測試仍綠），所以直接守原始碼
    #[test]
    fn 守門_live_真的把設定頁的開關套進去_並記下這次啟動的結果() {
        let term = include_str!("term.rs");
        let live = term.split("pub fn live(").nth(1).expect("有 live()").split("
}
").next().unwrap();
        assert!(live.contains("term_server_wanted(") && live.contains("read_settings(data_dir).term_server_off"), "要讀設定頁的值並和環境變數一起判斷");
        assert!(live.contains("let mux = mux && wanted;"), "設定頁關掉＝這次不用伺服器終端（要在 mux_after_job 之前，認領 mux 的列要看它）");
        let apply = live.find("let mux = mux && wanted;").unwrap();
        let after_job = live.find("mux_after_job(").expect("mux_after_job");
        assert!(apply < after_job, "設定要在 mux_after_job 之前套用");
        assert!(live.contains("set_term_server_state(mux, locked)"), "記下最後實際有沒有在用（含被工作群組旗標拿掉的情況），畫面據此提示重開");
        let state = live.find("set_term_server_state(mux, locked)").unwrap();
        let set_use = live.find("svc.set_use_mux(mux)").expect("set_use_mux");
        assert!(set_use < state, "要記最後一個 mux（set_use_mux 用的那個），不是中間值");
    }

    #[test]
    fn 伺服器終端_這次啟動的結果記得住_給設定頁判斷改了還沒生效() {
        let keep = (term_server_active(), term_server_locked());
        set_term_server_state(true, false);
        assert_eq!((term_server_active(), term_server_locked()), (true, false));
        set_term_server_state(false, true);
        assert_eq!((term_server_active(), term_server_locked()), (false, true));
        set_term_server_state(keep.0, keep.1);
    }
}

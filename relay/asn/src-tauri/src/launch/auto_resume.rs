//! 電腦重開後自動接回夥伴（#767）。
//! 只在「真的換了一次開機」才接：存檔（known-windows.json，與 #766 共用）記的開機時間和現在不同，而且不是使用者自己結束 ASN 的。
//! 只接 ASN 開的 Claude 視窗，用原本的對話編號與原本的權限旗標；一次一個，等它出現在 session 檔才開下一個。
//! 這裡不代答任何提示：停在信任、略過權限警告、權限框的視窗不會產生 session 檔，算失敗，視窗留著給本人處理；
//! 信的部分照 #766：接不回來的夥伴，信留著等到 12 小時。
//! 未登入就全部停下，等重新登入再接（同樣的權杖開再多視窗也只會失敗）；空記憶體低於 3 GB 暫停。整個流程最多 12 小時。
//! 結果寫進狀態檔給畫面顯示「已自動接回 N 位」與接不回來的名字，不含對話內容。
use crate::bridge::known::{same_boot, KnownEntry};
use serde::Serialize;
use serde_json::Value;
use std::path::Path;

/// 接回結果，畫面讀（在資料資料夾）
pub const STATUS_FILE: &str = "auto-resume.json";
/// 使用者自己結束 ASN 時留的記號（在機器資料夾）：之後才重開機，就不知道視窗還是不是開著，不接回
const QUIT_MARK: &str = "auto-resume-skip";
const LIMIT_MS: u64 = 12 * 3_600_000;
/// 開視窗後最多等多久要看到 session 檔
const APPEAR_WAIT_MS: u64 = 90_000;
const APPEAR_POLL_MS: u64 = 2_000;
const GAP_MS: u64 = 5_000;
const MEMORY_POLL_MS: u64 = 30_000;
const LOGIN_POLL_MS: u64 = 60_000;
/// 開機後先等一下，讓收發室與桌面先起來
const START_DELAY_MS: u64 = 15_000;
/// 一次最多接回幾位；多的算失敗並列出來，不無聲略過
const MAX_ENTRIES: usize = 30;
/// 只認這些權限模式。存檔裡其他的值一律不帶進啟動參數
const PERMISSION_MODES: [&str; 7] = ["acceptEdits", "auto", "bypassPermissions", "default", "dontAsk", "manual", "plan"];
const BYPASS_FLAG: &str = "--dangerously-skip-permissions";
const ALLOW_BYPASS_FLAG: &str = "--allow-dangerously-skip-permissions";
const MODE_FLAG: &str = "--permission-mode";

const PI_MANUAL: &str = "pi 視窗還不會自動接回，請手動喚醒";
const TOO_MANY: &str = "一次要接回的夥伴太多，這位請手動喚醒";
const NOT_SEEN: &str = "視窗開了，但一直沒看到它上線，可能停在確認畫面，請到它的視窗看一下";
/// 原本是隱藏的視窗停在確認畫面：本人看不到、到不了它，所以接回失敗時把它顯示出來（和名單的「前台」同一條）
const NOT_SEEN_SHOWN: &str = "視窗開了，但一直沒看到它上線，可能停在確認畫面。它原本是隱藏的，已經把它的視窗顯示出來，請到它的視窗看一下";
const NOT_SEEN_HIDDEN: &str = "視窗開了，但一直沒看到它上線，可能停在確認畫面，而且它是隱藏的，沒能自動顯示。請在夥伴名單按它的「前台」；名單沒有它的話，請重開 ASN，或關掉它再手動喚醒";
const NO_SESSION: &str = "沒有記到原本的對話編號，請手動喚醒";
const BAD_NAME: &str = "視窗名不能用，請手動喚醒";
const NO_LOGIN: &str = "12 小時內沒有重新登入 Claude，沒有接回";
const NO_MEMORY: &str = "12 小時內空記憶體一直不夠，沒有接回";

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Failed {
    pub name: String,
    pub reason: String,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Status {
    /// running／waiting_login／paused_memory／done
    pub state: &'static str,
    pub total: usize,
    pub resumed: Vec<String>,
    pub failed: Vec<Failed>,
    pub at: u64,
    /// 為什麼要接回：空＝重開機（原本的行為）；終端服務中斷（`mux_watch`）會寫原因，畫面跟著顯示
    #[serde(skip_serializing_if = "str::is_empty")]
    pub cause: &'static str,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Login {
    In,
    Out,
    /// 問不出來：不擋（接回失敗時一樣會列出來）
    Unknown,
}

/// 外面的世界（測試換成假的）
pub trait Deps {
    fn now(&self) -> u64;
    fn sleep(&self, ms: u64);
    fn free_bytes(&self) -> Option<u64>;
    fn login(&self) -> Login;
    /// 同名或同一段對話已經有活著的視窗
    fn live(&self, name: &str, session: &str) -> bool;
    fn launch(&self, entry: &KnownEntry) -> Result<(), String>;
    /// 開出來的視窗上線了（有活著的同名 session 檔）
    fn appeared(&self, name: &str) -> bool;
    /// 這一輪接回的原因（寫進結果給畫面顯示）。預設空＝重開機
    fn cause(&self) -> &'static str {
        ""
    }
    /// 接回失敗、視窗又是隱藏的：把它顯示出來讓本人看得到（回有沒有成功）。只有隱藏的視窗才會被呼叫
    fn reveal(&self, entry: &KnownEntry) -> bool;
    fn report(&self, status: &Status);
}

/// 要不要接、接哪些。`boot`＝現在這次開機的時間（讀不到不接）；`saved_boot`＝存檔記的（舊檔沒有，不接：不知道是不是換了開機）
pub fn pick(entries: Vec<KnownEntry>, saved_boot: Option<u64>, boot: Option<u64>, enabled: bool, user_quit: bool) -> Vec<KnownEntry> {
    let (Some(saved), Some(boot)) = (saved_boot, boot) else { return Vec::new() };
    if !enabled || user_quit || same_boot(saved, boot) {
        return Vec::new();
    }
    entries.into_iter().filter(|e| e.facts.asn_opened && (e.engine == "claude" || e.engine == "pi")).collect()
}

/// 依序接回。一位失敗不擋下一位；未登入與記憶體不足是全體都要等
pub fn run(entries: Vec<KnownEntry>, deps: &dyn Deps) -> Status {
    let started = deps.now();
    let deadline = started + LIMIT_MS;
    let mut st = Status { state: "running", total: entries.len(), resumed: Vec::new(), failed: Vec::new(), at: started, cause: deps.cause() };
    let push = |st: &Status, state: &'static str| {
        let mut s = st.clone();
        s.state = state;
        s.at = deps.now();
        deps.report(&s);
    };
    push(&st, "running");
    for (i, e) in entries.iter().enumerate() {
        let mut fail = |st: &mut Status, why: String| st.failed.push(Failed { name: e.name.clone(), reason: why });
        if e.engine != "claude" {
            fail(&mut st, PI_MANUAL.to_string());
            continue;
        }
        if i >= MAX_ENTRIES {
            fail(&mut st, TOO_MANY.to_string());
            continue;
        }
        if !crate::bridge::roster::valid_sid(&e.facts.session) {
            fail(&mut st, NO_SESSION.to_string());
            continue;
        }
        if !super::config::valid_partner_name(&e.name) {
            fail(&mut st, BAD_NAME.to_string());
            continue;
        }
        // 全體要等的兩件事。等過之後另一件可能又變了，所以一起重查，兩件都過才開
        let mut gave_up = None;
        loop {
            if deps.login() == Login::Out {
                if deps.now() >= deadline {
                    gave_up = Some(NO_LOGIN);
                    break;
                }
                push(&st, "waiting_login");
                deps.sleep(LOGIN_POLL_MS);
                continue;
            }
            if deps.free_bytes().is_some_and(|b| b < super::screen_watch::PAUSE_BELOW_BYTES) {
                if deps.now() >= deadline {
                    gave_up = Some(NO_MEMORY);
                    break;
                }
                push(&st, "paused_memory");
                deps.sleep(MEMORY_POLL_MS);
                continue;
            }
            break;
        }
        if let Some(why) = gave_up {
            fail(&mut st, why.to_string());
            continue;
        }
        push(&st, "running");
        // 已經開著（本人先按了接回、或別的路徑開的）：不重開，也不算自動接回
        if deps.live(&e.name, &e.facts.session) {
            st.total -= 1;
            continue;
        }
        if let Err(why) = deps.launch(e) {
            fail(&mut st, format!("開不起來：{why}"));
            continue;
        }
        let until = deps.now() + APPEAR_WAIT_MS;
        let mut up = deps.appeared(&e.name);
        while !up && deps.now() < until {
            deps.sleep(APPEAR_POLL_MS);
            up = deps.appeared(&e.name);
        }
        if up {
            st.resumed.push(e.name.clone());
        } else if e.facts.hidden {
            // 隱藏視窗停在確認畫面：本人看不到框，只能靠我們把它顯示出來
            let shown = deps.reveal(e);
            fail(&mut st, (if shown { NOT_SEEN_SHOWN } else { NOT_SEEN_HIDDEN }).to_string());
        } else {
            fail(&mut st, NOT_SEEN.to_string());
        }
        push(&st, "running");
        if i + 1 < entries.len() {
            deps.sleep(GAP_MS);
        }
    }
    st.state = "done";
    st.at = deps.now();
    deps.report(&st);
    st
}

/// 同一時間只讓一條接回在跑（重開機的 #788 與終端服務中斷各有一條）：後面的等前面的做完，再看到視窗已經開著就不重開，不會開出重複視窗
#[cfg(feature = "gui")]
static RESUME_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// 終端服務中斷時要接回的名單：存檔（known-windows.json）裡有這位的對話編號與資料夾就照它接；
/// 沒有記到（或不是 Claude 視窗）就放一列沒有對話編號的，讓 `run` 把它列進「沒有接回」並寫原因，不無聲略過。
/// 這條路的對象是 ASN 自己開在共用 mux 裡的夥伴，不看存檔裡「ASN 開的」那一欄
pub fn crash_entries(names: &[String], known: Vec<KnownEntry>) -> Vec<KnownEntry> {
    names
        .iter()
        .map(|n| {
            known.iter().find(|e| &e.name == n && e.engine == "claude").cloned().unwrap_or_else(|| KnownEntry {
                name: n.clone(),
                engine: "claude".into(),
                facts: crate::bridge::known::WindowFacts { session: String::new(), cwd: String::new(), asn_opened: true, perm: Vec::new(), hidden: false },
            })
        })
        .collect()
}

/// 終端服務中斷之後（`mux_watch` 呼叫）：`resume` 為真就照 #788 的做法把這些夥伴接回；
/// 為假（十分鐘內又中斷）只把名字與原因寫進結果給畫面，不接回
#[cfg(feature = "gui")]
pub fn after_mux_crash(work_dir: &Path, data_dir: &Path, names: &[String], resume: bool) {
    let now = crate::heartbeat::now_ms();
    let known = crate::bridge::known::Known::load(&work_dir.join(crate::bridge::known::KNOWN_FILE), now);
    let entries = crash_entries(names, known.entries());
    let deps = RealDeps { data_dir: data_dir.to_path_buf(), sessions: crate::bridge::core::claude_sessions_dir(), opened: Default::default(), cause: super::mux_watch::CAUSE };
    if !resume {
        let failed = entries.iter().map(|e| Failed { name: e.name.clone(), reason: super::mux_watch::COOLDOWN_REASON.to_string() }).collect();
        deps.report(&Status { state: "done", total: entries.len(), resumed: Vec::new(), failed, at: now, cause: super::mux_watch::CAUSE });
        return;
    }
    let st = {
        let _one = RESUME_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        run(entries, &deps)
    };
    let line = format!("{} info [ASN] mux-resume total={} resumed={} failed={}", crate::claude_quota::iso_secs(st.at as i64), st.total, st.resumed.len(), st.failed.len());
    let _ = crate::ui_log::append(work_dir, &[line]);
}

/// 從啟動參數取出權限旗標，只留認得的。接回時照這份，不看現在的 profile
pub fn perm_args_from_argv(argv: &[String]) -> Vec<String> {
    let mut out = Vec::new();
    let mut it = argv.iter();
    while let Some(a) = it.next() {
        match a.as_str() {
            BYPASS_FLAG | ALLOW_BYPASS_FLAG => out.push(a.clone()),
            MODE_FLAG => {
                if let Some(m) = it.next().filter(|m| PERMISSION_MODES.contains(&m.as_str())) {
                    out.extend([MODE_FLAG.to_string(), m.clone()]);
                }
            }
            _ => {
                if let Some(m) = a.strip_prefix("--permission-mode=").filter(|m| PERMISSION_MODES.contains(m)) {
                    out.extend([MODE_FLAG.to_string(), m.to_string()]);
                }
            }
        }
    }
    out
}

/// 程序的命令列（一整串）取權限旗標。這幾個旗標與值都沒有空白，所以切空白、去引號就夠
pub fn perm_args_from_cmdline(line: &str) -> Vec<String> {
    let argv: Vec<String> = line.split_whitespace().map(|a| a.trim_matches(['"', '\'']).to_string()).collect();
    perm_args_from_argv(&argv)
}

/// 接回用的參數：profile 的參數拿掉權限旗標，換上原本的（存檔再驗一次），最前面加 --resume。
/// 自訂的包裝指令、或 profile 自己指定了對話，這裡不猜，回錯
pub fn resumed_args(command: &str, profile_args: &[String], session: &str, perm: &[String]) -> Result<Vec<String>, String> {
    if !super::resume::is_claude_command(command) {
        return Err("啟動設定不是直接開 Claude，不能自動接回".to_string());
    }
    if !crate::bridge::roster::valid_sid(session) {
        return Err(NO_SESSION.to_string());
    }
    let mut out = vec!["--resume".to_string(), session.to_string()];
    let mut it = profile_args.iter();
    while let Some(a) = it.next() {
        match a.as_str() {
            BYPASS_FLAG | ALLOW_BYPASS_FLAG => {}
            MODE_FLAG => {
                it.next();
            }
            "--resume" | "-r" | "--continue" | "-c" | "--session-id" | "--fork-session" => return Err("啟動設定自己指定了對話，不能自動接回".to_string()),
            _ if a.starts_with("--permission-mode=") => {}
            _ if a.starts_with("--resume=") || a.starts_with("--session-id=") => return Err("啟動設定自己指定了對話，不能自動接回".to_string()),
            _ => out.push(a.clone()),
        }
    }
    out.extend(perm_args_from_argv(perm));
    Ok(out)
}

/// 第一個 Claude 視窗型 profile（claude 優先），與喚醒同樣的選法
pub fn claude_profile(cfg: &super::config::LaunchConfig) -> Option<String> {
    let mut ids: Vec<&String> = cfg.profiles.keys().collect();
    ids.sort_by(|a, b| (a.as_str() != "claude").cmp(&(b.as_str() != "claude")).then(a.cmp(b)));
    ids.into_iter().find(|id| {
        let p = &cfg.profiles[*id];
        p.mode == super::profiles::LaunchMode::Window && !p.disabled && (p.engine.is_empty() || p.engine == "claude")
    }).cloned()
}

/// 使用者自己結束 ASN：留記號
pub fn note_user_quit(work_dir: &Path) {
    let _ = crate::write_atomic(&work_dir.join(QUIT_MARK), "1");
}

/// 畫面讀結果。沒有檔案或壞了回 null
pub fn read_status(data_dir: &Path) -> Value {
    std::fs::read_to_string(data_dir.join(STATUS_FILE)).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or(Value::Null)
}

/// 這次開機的時間（毫秒）。讀不到回 None，就不會自動接回
#[cfg(windows)]
pub fn boot_ms(now: u64) -> Option<u64> {
    #[link(name = "kernel32")]
    extern "system" {
        fn GetTickCount64() -> u64;
    }
    now.checked_sub(unsafe { GetTickCount64() })
}
#[cfg(target_os = "linux")]
pub fn boot_ms(_now: u64) -> Option<u64> {
    let text = std::fs::read_to_string("/proc/stat").ok()?;
    let secs: u64 = text.lines().find_map(|l| l.strip_prefix("btime "))?.trim().parse().ok()?;
    Some(secs * 1000)
}
#[cfg(not(any(windows, target_os = "linux")))]
pub fn boot_ms(_now: u64) -> Option<u64> {
    None
}

/// 這個視窗是不是 ASN 開的、原本的權限。只拿權限旗標，其他參數不留
#[cfg(feature = "gui")]
pub fn probe_window(pid: u32) -> (bool, Vec<String>) {
    use super::switch::{opened_by_asn, Os, RealOs};
    let os = RealOs;
    let opened = opened_by_asn(&os, &os.processes(), pid);
    let perm = os.cmdline(pid).map(|l| perm_args_from_cmdline(&l)).unwrap_or_default();
    (opened, perm)
}

#[cfg(feature = "gui")]
struct RealDeps {
    data_dir: std::path::PathBuf,
    sessions: std::path::PathBuf,
    /// 開出來的視窗的程序編號（名字 → pid），隱藏視窗沒上線時要靠它把視窗顯示出來
    opened: std::sync::Mutex<std::collections::HashMap<String, u32>>,
    /// 接回的原因（重開機是空；終端服務中斷見 `mux_watch::CAUSE`）
    cause: &'static str,
}

#[cfg(feature = "gui")]
impl RealDeps {
    fn live_session(&self, name: &str, session: Option<&str>) -> bool {
        let live = crate::bridge::roster::read_sessions_with(&self.sessions, crate::heartbeat::session_alive, 0, "").unwrap_or_default();
        live.iter().any(|w| w.name == name || (session.is_some() && w.session_id.as_deref() == session))
    }
}

#[cfg(feature = "gui")]
impl Deps for RealDeps {
    fn now(&self) -> u64 {
        crate::heartbeat::now_ms()
    }
    fn sleep(&self, ms: u64) {
        std::thread::sleep(std::time::Duration::from_millis(ms));
    }
    fn free_bytes(&self) -> Option<u64> {
        super::term::free_memory_bytes()
    }
    fn login(&self) -> Login {
        use crate::agent_setup::claude_login::{login_state, LoginState, RealCapture};
        let Some(command) = super::config::load_launch_config().ok().and_then(|c| claude_profile(&c).and_then(|p| c.profiles.get(&p).map(|x| x.command.clone()))) else { return Login::Unknown };
        match login_state(Path::new(&super::config::expand_vars(&command, &super::config::child_env())), &RealCapture) {
            LoginState::In => Login::In,
            LoginState::Out => Login::Out,
            LoginState::Unknown(_) => Login::Unknown,
        }
    }
    fn live(&self, name: &str, session: &str) -> bool {
        self.live_session(name, Some(session))
    }
    fn launch(&self, e: &KnownEntry) -> Result<(), String> {
        let mut config = super::config::load_launch_config()?;
        // 一般使用者從畫面選的資料夾記在本機同意清單（launch-prefs.json），不在 launcher.json；併進來才接得回來
        super::cwds::allow_consented(&mut config, &e.facts.cwd, &self.data_dir);
        let pid = super::local::start_resumed_window(&config, &e.name, &e.facts.cwd, &e.facts.session, &e.facts.perm, e.facts.hidden)?;
        if let Ok(mut m) = self.opened.lock() {
            m.insert(e.name.clone(), pid);
        }
        Ok(())
    }
    fn cause(&self) -> &'static str {
        self.cause
    }
    fn reveal(&self, e: &KnownEntry) -> bool {
        let pid = self.opened.lock().ok().and_then(|m| m.get(&e.name).copied());
        super::console::show_partner_window("claude", &e.name, pid)
    }
    fn appeared(&self, name: &str) -> bool {
        self.live_session(name, None)
    }
    fn report(&self, status: &Status) {
        if let Ok(text) = serde_json::to_string(status) {
            let _ = crate::write_atomic(&self.data_dir.join(STATUS_FILE), &text);
        }
    }
}

/// 開機時呼叫：現在就看存檔（內建橋之後會更新開機時間），要接回才開背景工作。ASN 沒有使用者資料夾之類的錯誤一律當不接
#[cfg(feature = "gui")]
pub fn start(work_dir: &Path, data_dir: &Path) {
    let now = crate::heartbeat::now_ms();
    // 上一次開機的結果不留：不然每次開 ASN 都會再跳一次
    let _ = std::fs::remove_file(data_dir.join(STATUS_FILE));
    let known = crate::bridge::known::Known::load(&work_dir.join(crate::bridge::known::KNOWN_FILE), now);
    let mark = work_dir.join(QUIT_MARK);
    let user_quit = mark.exists();
    let _ = std::fs::remove_file(&mark);
    let enabled = !crate::bridge::read_settings(data_dir).auto_resume_off;
    let entries = pick(known.entries(), known.boot_ms(), boot_ms(now), enabled, user_quit);
    if entries.is_empty() {
        return;
    }
    let deps = RealDeps { data_dir: data_dir.to_path_buf(), sessions: crate::bridge::core::claude_sessions_dir(), opened: Default::default(), cause: "" };
    let log_dir = work_dir.to_path_buf();
    let spawned = std::thread::Builder::new().name("asn-auto-resume".into()).spawn(move || {
        deps.sleep(START_DELAY_MS);
        let st = {
            let _one = RESUME_LOCK.lock().unwrap_or_else(|e| e.into_inner());
            run(entries, &deps)
        };
        let line = format!("{} info [ASN] auto-resume total={} resumed={} failed={}", crate::claude_quota::iso_secs(st.at as i64), st.total, st.resumed.len(), st.failed.len());
        let _ = crate::ui_log::append(&log_dir, &[line]);
    });
    if let Err(e) = spawned {
        elog!("自動接回的背景工作開不了（不影響啟動）：{e}");
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn 終端服務中斷_存檔有的照存檔接_沒有記到的列進沒有接回_不無聲略過() {
        let known = vec![entry("甲"), {
            let mut e = entry("乙");
            e.engine = "pi".into();
            e
        }];
        let es = crash_entries(&sv(&["甲", "乙", "丙"]), known);
        assert_eq!(es.iter().map(|e| e.name.as_str()).collect::<Vec<_>>(), ["甲", "乙", "丙"], "順序照名單");
        assert!(crate::bridge::roster::valid_sid(&es[0].facts.session), "存檔有的帶原本的對話編號");
        // pi 視窗與沒記到的：不帶對話編號、引擎改成 claude 讓 run 走「沒有記到原本的對話編號」那條
        assert!(es[1].facts.session.is_empty() && es[2].facts.session.is_empty());
        let f = Fake::new();
        let st = run(es, &f);
        assert_eq!(st.resumed, ["甲"]);
        assert_eq!(st.failed.iter().map(|x| (x.name.as_str(), x.reason.as_str())).collect::<Vec<_>>(), [("乙", NO_SESSION), ("丙", NO_SESSION)]);
    }

    #[test]
    fn 結果帶原因_重開機是空的不寫出來_終端服務中斷才寫() {
        let boot = Status { state: "done", total: 1, resumed: vec!["甲".into()], failed: vec![], at: 1, cause: "" };
        assert!(!serde_json::to_string(&boot).unwrap().contains("cause"), "重開機的結果檔和以前一樣");
        let mux = Status { cause: super::super::mux_watch::CAUSE, ..boot };
        let v: serde_json::Value = serde_json::to_value(&mux).unwrap();
        assert_eq!(v["cause"], "共用的終端服務中斷了");
        let f = Fake::new();
        assert_eq!(run(vec![entry("甲")], &f).cause, "", "預設原因是空的");
    }

    #[test]
    fn 守門_自動接回開窗前併入本機同意過的資料夾() {
        let me = include_str!("auto_resume.rs").split("#[cfg(test)]").next().unwrap();
        assert!(me.contains("super::cwds::allow_consented(&mut config, &e.facts.cwd, &self.data_dir)"));
        let i = me.find("allow_consented").unwrap();
        let j = me.find("start_resumed_window(").unwrap();
        assert!(i < j, "要先併白名單才開窗");
    }

    #[test]
    fn 重開自動接回和橋看同一個_session_資料夾() {
        let me = include_str!("auto_resume.rs").split("#[cfg(test)]").next().unwrap();
        let core = include_str!("../bridge/core.rs").split("#[cfg(test)]").next().unwrap();
        assert!(me.contains("sessions: crate::bridge::core::claude_sessions_dir()"), "自動接回要用橋的來源");
        assert!(!me.contains(r#".join(".claude").join("sessions")"#), "不能自己再拼一份");
        assert!(core.contains("sessions_dir: claude_sessions_dir(),"), "橋也要走同一個來源");
        let d = crate::bridge::core::claude_sessions_dir();
        assert!(d.ends_with(std::path::Path::new(".claude").join("sessions")), "{d:?}");
    }

    use super::*;
    use crate::bridge::known::WindowFacts;
    use std::cell::{Cell, RefCell};

    const GB: u64 = 1024 * 1024 * 1024;

    fn sv(v: &[&str]) -> Vec<String> {
        v.iter().map(|x| x.to_string()).collect()
    }

    fn entry(name: &str) -> KnownEntry {
        KnownEntry { name: name.into(), engine: "claude".into(), facts: WindowFacts { session: format!("s-{}", name.chars().map(|c| c as u32).sum::<u32>()), cwd: "D:/w".into(), asn_opened: true, perm: sv(&["--permission-mode", "auto"]), hidden: false } }
    }

    struct Fake {
        now: Cell<u64>,
        logins: RefCell<Vec<Login>>,
        free: RefCell<Vec<Option<u64>>>,
        live: Vec<String>,
        launched: RefCell<Vec<String>>,
        fail_launch: Vec<String>,
        never_appears: Vec<String>,
        states: RefCell<Vec<&'static str>>,
        running: Cell<usize>,
        peak: Cell<usize>,
        revealed: RefCell<Vec<String>>,
        reveal_ok: bool,
    }

    impl Fake {
        fn new() -> Fake {
            Fake { now: Cell::new(1_000_000), logins: RefCell::new(vec![]), free: RefCell::new(vec![]), live: vec![], launched: RefCell::new(vec![]), fail_launch: vec![], never_appears: vec![], states: RefCell::new(vec![]), running: Cell::new(0), peak: Cell::new(0), revealed: RefCell::new(vec![]), reveal_ok: false }
        }
    }

    /// 依序吐值，吐完一直回最後一個；沒有就回預設
    fn next<T: Copy>(v: &RefCell<Vec<T>>, default: T) -> T {
        let mut g = v.borrow_mut();
        match g.len() {
            0 => default,
            1 => g[0],
            _ => g.remove(0),
        }
    }

    impl Deps for Fake {
        fn now(&self) -> u64 {
            self.now.get()
        }
        fn sleep(&self, ms: u64) {
            self.now.set(self.now.get() + ms);
        }
        fn free_bytes(&self) -> Option<u64> {
            next(&self.free, Some(8 * GB))
        }
        fn login(&self) -> Login {
            next(&self.logins, Login::In)
        }
        fn live(&self, name: &str, _s: &str) -> bool {
            self.live.iter().any(|n| n == name)
        }
        fn launch(&self, e: &KnownEntry) -> Result<(), String> {
            self.launched.borrow_mut().push(e.name.clone());
            if self.fail_launch.contains(&e.name) {
                return Err("壞了".into());
            }
            self.running.set(self.running.get() + 1);
            self.peak.set(self.peak.get().max(self.running.get()));
            Ok(())
        }
        fn appeared(&self, name: &str) -> bool {
            let up = !self.never_appears.iter().any(|n| n == name);
            if up {
                self.running.set(self.running.get().saturating_sub(1));
            }
            up
        }
        fn reveal(&self, e: &KnownEntry) -> bool {
            self.revealed.borrow_mut().push(e.name.clone());
            self.reveal_ok
        }
        fn report(&self, s: &Status) {
            self.states.borrow_mut().push(s.state);
        }
    }

    #[test]
    fn 只有換了開機才接_而且只接_asn_開的() {
        let mut own = entry("自己開的");
        own.facts.asn_opened = false;
        let mut acp = entry("背景");
        acp.engine = "acp".into();
        let all = vec![entry("甲"), own, acp];
        let names = |v: Vec<KnownEntry>| v.into_iter().map(|e| e.name).collect::<Vec<_>>();
        assert_eq!(names(pick(all.clone(), Some(1), Some(100_000_000), true, false)), ["甲"]);
        assert!(pick(all.clone(), Some(100_000_000), Some(100_000_001), true, false).is_empty(), "同一次開機（只是重開 ASN）不接");
        assert!(pick(all.clone(), None, Some(100_000_000), true, false).is_empty(), "舊檔不知道開機時間，不接");
        assert!(pick(all.clone(), Some(1), None, true, false).is_empty(), "讀不到開機時間，不接");
        assert!(pick(all.clone(), Some(1), Some(100_000_000), false, false).is_empty(), "設定關了不接");
        assert!(pick(all, Some(1), Some(100_000_000), true, true).is_empty(), "使用者自己結束 ASN 之後才重開，不接");
    }

    #[test]
    fn 一次一個依序接回_都成功() {
        let f = Fake::new();
        let st = run(vec![entry("甲"), entry("乙"), entry("丙")], &f);
        assert_eq!(st.resumed, ["甲", "乙", "丙"]);
        assert!(st.failed.is_empty());
        assert_eq!((st.total, st.state), (3, "done"));
        assert_eq!(f.peak.get(), 1, "前一位上線才開下一位");
        assert_eq!(f.states.borrow().last(), Some(&"done"));
    }

    #[test]
    fn 卡住或開不起來的算失敗_列出名字_下一位照接() {
        let mut f = Fake::new();
        f.never_appears = vec!["甲".into()];
        f.fail_launch = vec!["乙".into()];
        let st = run(vec![entry("甲"), entry("乙"), entry("丙")], &f);
        assert_eq!(st.resumed, ["丙"]);
        assert_eq!(st.failed.iter().map(|x| x.name.as_str()).collect::<Vec<_>>(), ["甲", "乙"]);
        assert_eq!(st.failed[0].reason, NOT_SEEN);
        assert!(st.failed[1].reason.contains("壞了"));
    }

    #[test]
    fn 隱藏視窗沒上線_把它顯示出來並明講_沒顯示成功也要告訴本人怎麼辦() {
        let hidden = |n: &str| {
            let mut e = entry(n);
            e.facts.hidden = true;
            e
        };
        // 隱藏、沒上線、顯示成功
        let mut f = Fake::new();
        f.never_appears = vec!["甲".into(), "乙".into(), "丙".into()];
        f.reveal_ok = true;
        let st = run(vec![hidden("甲"), entry("乙")], &f);
        assert_eq!(*f.revealed.borrow(), ["甲"], "只有隱藏的才顯示，看得到的視窗不動");
        assert_eq!(st.failed[0].reason, NOT_SEEN_SHOWN);
        assert!(st.failed[0].reason.contains("已經把它的視窗顯示出來"));
        assert_eq!(st.failed[1].reason, NOT_SEEN);
        // 隱藏、沒上線、顯示不成功：訊息寫明怎麼辦（名單的「前台」），不能還叫人去一個到不了的視窗
        let mut f2 = Fake::new();
        f2.never_appears = vec!["丙".into()];
        f2.reveal_ok = false;
        let st2 = run(vec![hidden("丙")], &f2);
        assert_eq!(*f2.revealed.borrow(), ["丙"]);
        assert_eq!(st2.failed[0].reason, NOT_SEEN_HIDDEN);
        assert!(st2.failed[0].reason.contains("前台"));
        // 隱藏但順利上線：不碰它
        let f3 = Fake::new();
        let st3 = run(vec![hidden("丁")], &f3);
        assert_eq!(st3.resumed, ["丁"]);
        assert!(f3.revealed.borrow().is_empty());
        // 開不起來：沒有視窗可顯示
        let mut f4 = Fake::new();
        f4.fail_launch = vec!["戊".into()];
        run(vec![hidden("戊")], &f4);
        assert!(f4.revealed.borrow().is_empty());
    }

    #[test]
    fn 沒登入就全部停下_重新登入後才開始接() {
        let f = Fake::new();
        *f.logins.borrow_mut() = vec![Login::Out, Login::Out, Login::In];
        let before = f.now.get();
        let st = run(vec![entry("甲"), entry("乙")], &f);
        assert_eq!(st.resumed, ["甲", "乙"]);
        assert!(f.states.borrow().contains(&"waiting_login"));
        assert!(f.now.get() >= before + 2 * LOGIN_POLL_MS, "等過才開");
    }

    #[test]
    fn 一直沒登入_一個都不開_十二小時後全部列失敗() {
        let f = Fake::new();
        *f.logins.borrow_mut() = vec![Login::Out];
        let st = run(vec![entry("甲"), entry("乙")], &f);
        assert!(f.launched.borrow().is_empty(), "沒登入不開任何視窗");
        assert_eq!(st.failed.len(), 2);
        assert_eq!(st.failed[0].reason, NO_LOGIN);
    }

    #[test]
    fn 問不出登入狀態不擋() {
        let f = Fake::new();
        *f.logins.borrow_mut() = vec![Login::Unknown];
        assert_eq!(run(vec![entry("甲")], &f).resumed, ["甲"]);
    }

    #[test]
    fn 空記憶體低就暫停_恢復才繼續_讀不到不擋() {
        let f = Fake::new();
        *f.free.borrow_mut() = vec![Some(GB), Some(GB), Some(8 * GB)];
        assert_eq!(run(vec![entry("甲")], &f).resumed, ["甲"]);
        assert!(f.states.borrow().contains(&"paused_memory"));
        let f = Fake::new();
        *f.free.borrow_mut() = vec![None];
        assert_eq!(run(vec![entry("甲")], &f).resumed, ["甲"]);
        let f = Fake::new();
        *f.free.borrow_mut() = vec![Some(GB)];
        let st = run(vec![entry("甲")], &f);
        assert!(f.launched.borrow().is_empty());
        assert_eq!(st.failed[0].reason, NO_MEMORY);
    }

    #[test]
    fn 暫停記憶體時登入失效_兩件都要過才開() {
        let f = Fake::new();
        *f.free.borrow_mut() = vec![Some(GB), Some(8 * GB)];
        *f.logins.borrow_mut() = vec![Login::In, Login::Out, Login::In];
        assert_eq!(run(vec![entry("甲")], &f).resumed, ["甲"]);
        let s = f.states.borrow();
        assert!(s.contains(&"paused_memory") && s.contains(&"waiting_login"), "{s:?}");
    }

    #[test]
    fn 已經開著的不重開_也不算接回() {
        let mut f = Fake::new();
        f.live = vec!["甲".into()];
        let st = run(vec![entry("甲"), entry("乙")], &f);
        assert_eq!(*f.launched.borrow(), ["乙"]);
        assert_eq!(st.resumed, ["乙"]);
        assert_eq!(st.total, 1);
    }

    #[test]
    fn pi_壞編號_壞名字_超過上限都列失敗_不無聲略過() {
        let f = Fake::new();
        let mut pi = entry("派");
        pi.engine = "pi".into();
        let mut no_sid = entry("沒編號");
        no_sid.facts.session = String::new();
        let mut bad = entry("-壞");
        bad.facts.session = "s1".into();
        let st = run(vec![pi, no_sid, bad], &f);
        assert!(f.launched.borrow().is_empty());
        assert_eq!(st.failed.len(), 3);
        let f = Fake::new();
        let many: Vec<KnownEntry> = (0..MAX_ENTRIES + 2).map(|i| entry(&format!("p{i}"))).collect();
        let st = run(many, &f);
        assert_eq!(st.resumed.len(), MAX_ENTRIES);
        assert_eq!(st.failed.len(), 2);
    }

    #[test]
    fn 權限旗標只留認得的() {
        assert_eq!(perm_args_from_cmdline(r#""C:\claude.exe" --dangerously-skip-permissions -n 小良 --resume abc"#), [BYPASS_FLAG]);
        assert_eq!(perm_args_from_cmdline("claude --permission-mode auto -n x"), [MODE_FLAG, "auto"]);
        assert_eq!(perm_args_from_cmdline("claude --permission-mode=plan"), [MODE_FLAG, "plan"]);
        assert!(perm_args_from_cmdline("claude --permission-mode 亂寫 -n x").is_empty());
        assert!(perm_args_from_cmdline("claude -n x --settings a.json").is_empty(), "其他參數不留");
    }

    #[test]
    fn 接回參數_拿掉現在的權限_換上原本的_最前面是對話編號() {
        let profile = sv(&["--dangerously-skip-permissions", "-n", "甲", "--remote-control", "甲"]);
        assert_eq!(resumed_args("claude.exe", &profile, "s1", &sv(&["--permission-mode", "auto"])).unwrap(), sv(&["--resume", "s1", "-n", "甲", "--remote-control", "甲", "--permission-mode", "auto"]));
        assert_eq!(resumed_args("claude", &sv(&["--permission-mode", "plan", "-n", "甲"]), "s1", &sv(&[BYPASS_FLAG])).unwrap(), sv(&["--resume", "s1", "-n", "甲", BYPASS_FLAG]));
        assert_eq!(resumed_args("claude", &sv(&[BYPASS_FLAG, "-n", "甲"]), "s1", &[]).unwrap(), sv(&["--resume", "s1", "-n", "甲"]), "原本是一般權限，不因為 profile 變成略過權限");
    }

    #[test]
    fn 接回參數_存檔裡不認得的權限與壞編號進不了啟動參數() {
        assert_eq!(resumed_args("claude", &[], "s1", &sv(&["--settings", "x.json", "--permission-mode", "亂寫"])).unwrap(), sv(&["--resume", "s1"]));
        assert!(resumed_args("claude", &[], "a b;rm", &[]).is_err());
        assert!(resumed_args("cmd.exe", &[], "s1", &[]).is_err(), "包裝指令不猜");
        assert!(resumed_args("claude", &sv(&["--resume", "x"]), "s1", &[]).is_err());
        assert!(resumed_args("claude", &sv(&["--session-id=x"]), "s1", &[]).is_err());
    }

    #[test]
    fn 使用者結束_asn_留記號_狀態檔壞了回空() {
        let d = tempfile::tempdir().unwrap();
        note_user_quit(d.path());
        assert!(d.path().join(QUIT_MARK).exists());
        assert!(read_status(d.path()).is_null());
        std::fs::write(d.path().join(STATUS_FILE), "壞").unwrap();
        assert!(read_status(d.path()).is_null());
    }
}

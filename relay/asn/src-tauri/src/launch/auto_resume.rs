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

#[cfg_attr(not(feature = "gui"), allow(dead_code))]
/// 同名視窗還活著，或這段對話已經有活著的 Claude 視窗在用（共用判斷見 live_process::session_holders）：都不再開第二個
pub(crate) fn already_live(os: &dyn super::switch::Os, sessions: &[Value], name_live: bool, session: &str) -> bool {
    name_live || !super::live_process::session_holders(os, &os.processes(), sessions, session, None).is_empty()
}

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
    /// 接回了、但這幾位開在系統終端（原生主控台）而不是共用的終端服務裡：畫面要講明（#1867），原因只進 ui.log
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub native: Vec<String>,
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
    /// 剛開出來的這位是不是退回系統終端（原生主控台）開的。預設不是
    fn opened_native(&self, _name: &str) -> bool {
        false
    }
    /// 開了卻一直沒上線：解除「正在開」的登記（見 opening.rs），本人之後手動喚醒才不會被擋。預設什麼都不做
    fn unclaim(&self, _entry: &KnownEntry) {}
    /// 沒看到上線，但命令列接續這段對話的程序還活著（還在啟動）：不解除登記，讓它自然到期。預設沒有
    fn still_starting(&self, _entry: &KnownEntry) -> bool {
        false
    }
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
///
/// `archived`＝存檔記的「已封存」名字：封存的視窗不接回。本人關掉的視窗在關的時候就已經從存檔拿掉，所以不會在 entries 裡。
/// 開機當下還沒連上後台，封存名單只有存檔裡上次記下的；之後才封存的（別台操作、還沒同步到）追不到，這時以存檔為準
pub fn pick(entries: Vec<KnownEntry>, saved_boot: Option<u64>, boot: Option<u64>, enabled: bool, user_quit: bool, archived: &std::collections::BTreeSet<String>) -> Vec<KnownEntry> {
    let (Some(saved), Some(boot)) = (saved_boot, boot) else { return Vec::new() };
    if !enabled || user_quit || same_boot(saved, boot) {
        return Vec::new();
    }
    entries.into_iter().filter(|e| e.facts.asn_opened && (e.engine == "claude" || e.engine == "pi") && !archived.contains(&e.name)).collect()
}

/// 依序接回。一位失敗不擋下一位；未登入與記憶體不足是全體都要等
pub fn run(entries: Vec<KnownEntry>, deps: &dyn Deps) -> Status {
    let started = deps.now();
    let deadline = started + LIMIT_MS;
    let mut st = Status { state: "running", total: entries.len(), resumed: Vec::new(), failed: Vec::new(), at: started, cause: deps.cause(), native: Vec::new() };
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
            // 別條路剛登記要開同一位（開機接回與終端服務中斷接回、本人喚醒撞在一起）：視窗已經在開，不重開也不算失敗
            if why == super::opening::BUSY {
                st.total -= 1;
                continue;
            }
            fail(&mut st, format!("開不起來：{why}"));
            continue;
        }
        let until = deps.now() + APPEAR_WAIT_MS;
        let mut up = deps.appeared(&e.name);
        while !up && deps.now() < until {
            deps.sleep(APPEAR_POLL_MS);
            up = deps.appeared(&e.name);
        }
        // 程序還活著＝只是啟動得慢：保留「正在開」登記，手動喚醒才不會再開第二個；程序也沒了才解除
        if !up && !deps.still_starting(e) {
            deps.unclaim(e);
        }
        if up {
            st.resumed.push(e.name.clone());
            // 開在系統終端（退回原生主控台）而不是共用的終端服務：畫面要講明，不能悄悄退回（#1867）
            if deps.opened_native(&e.name) {
                st.native.push(e.name.clone());
            }
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
/// 本人封存的夥伴（`archived`，存檔記的）不接回，和重開機的 `pick` 一樣
pub fn crash_entries(names: &[String], known: Vec<KnownEntry>, archived: &std::collections::BTreeSet<String>) -> Vec<KnownEntry> {
    names
        .iter()
        .filter(|n| !archived.contains(n.as_str()))
        .map(|n| {
            known.iter().find(|e| &e.name == n && e.engine == "claude").cloned().unwrap_or_else(|| KnownEntry {
                name: n.clone(),
                engine: "claude".into(),
                facts: crate::bridge::known::WindowFacts { session: String::new(), cwd: String::new(), asn_opened: true, perm: Vec::new(), hidden: false },
            })
        })
        .collect()
}

/// 為什麼接回：寫進結果的原因文字，以及接回做完要不要另外排「終端服務中斷」的結果通知
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ResumeWhy {
    pub cause: &'static str,
    pub notice: bool,
}

/// 終端服務自己中斷（`mux_watch` 的事故）：原因「共用的終端服務中斷了」，做完排結果通知
pub const WHY_CRASH: ResumeWhy = ResumeWhy { cause: super::mux_watch::CAUSE, notice: true };
/// 使用者在工作管理員按了「重啟終端服務」：原因寫「重啟」，不排「中斷」的通知（本人知道）；
/// 也不經 `mux_watch` 的事故判斷，所以不計入十分鐘冷卻
pub const WHY_RESTART: ResumeWhy = ResumeWhy { cause: "重啟", notice: false };

/// 終端服務中斷之後（`mux_watch` 呼叫）：`resume` 為真就照 #788 的做法把這些夥伴接回；
/// 為假（十分鐘內又中斷）只把名字與原因寫進結果給畫面，不接回
#[cfg(feature = "gui")]
pub fn after_mux_crash(work_dir: &Path, data_dir: &Path, names: &[String], resume: bool) {
    after_mux(work_dir, data_dir, names, resume, WHY_CRASH)
}

/// 使用者重啟終端服務之後（工作管理員）：把重啟前的夥伴接回，原因寫「重啟」、不計冷卻
#[cfg(feature = "gui")]
pub fn after_mux_restart(work_dir: &Path, data_dir: &Path, names: &[String]) {
    after_mux(work_dir, data_dir, names, true, WHY_RESTART)
}

#[cfg(feature = "gui")]
fn after_mux(work_dir: &Path, data_dir: &Path, names: &[String], resume: bool, why: ResumeWhy) {
    let now = crate::heartbeat::now_ms();
    let known = crate::bridge::known::Known::load(&work_dir.join(crate::bridge::known::KNOWN_FILE), now);
    let entries = crash_entries(names, known.entries(), known.archived_names());
    let deps = RealDeps { data_dir: data_dir.to_path_buf(), sessions: crate::bridge::core::claude_sessions_dir(), opened: Default::default(), cause: why.cause, native: Default::default() };
    resume_entries_why(work_dir, entries, resume, why, &deps, || RESUME_LOCK.lock().unwrap_or_else(|e| e.into_inner()));
}

/// 終端服務中斷的接回（原因與通知照舊）；本體見 [`resume_entries_why`]
#[cfg(feature = "gui")]
pub fn resume_entries<G>(work_dir: &Path, entries: Vec<KnownEntry>, resume: bool, deps: &dyn Deps, lock: impl FnOnce() -> G) -> Status {
    resume_entries_why(work_dir, entries, resume, WHY_CRASH, deps, lock)
}

/// `after_mux_crash` 的本體（對外的動作都經 `deps`，測試用假的）：接回、寫紀錄、排「接回結果」通知（`why.notice` 為真才排）。
/// `lock` 取同一時間只讓一條接回在跑的鎖（回的東西活著期間持鎖）
#[cfg(feature = "gui")]
pub fn resume_entries_why<G>(work_dir: &Path, entries: Vec<KnownEntry>, resume: bool, why: ResumeWhy, deps: &dyn Deps, lock: impl FnOnce() -> G) -> Status {
    let now = deps.now();
    if !resume {
        let failed = entries.iter().map(|e| Failed { name: e.name.clone(), reason: super::mux_watch::COOLDOWN_REASON.to_string() }).collect();
        let st = Status { state: "done", total: entries.len(), resumed: Vec::new(), failed, at: now, cause: why.cause, native: Vec::new() };
        deps.report(&st);
        return st;
    }
    let broke = entries.len();
    let st = {
        let _one = lock();
        run(entries, deps)
    };
    let line = format!("{} info [ASN] mux-resume total={} resumed={} failed={}", crate::quota_core::iso_secs(st.at as i64), st.total, st.resumed.len(), st.failed.len());
    // 沒接回來的原因是技術細節，只進紀錄；通知與畫面只講名字
    let mut lines = vec![line];
    lines.extend(st.failed.iter().map(|f| format!("{} info [ASN] mux-resume 沒接回：{}（{}）", crate::quota_core::iso_secs(st.at as i64), f.name, f.reason)));
    let _ = crate::ui_log::append(work_dir, &lines);
    // 接回做完了：斷了幾位、接回幾位、誰沒接回，排一則通知（只有「真的接回過」的那一次；十分鐘內第二次本來就只通知）
    let failed: Vec<String> = st.failed.iter().map(|f| f.name.clone()).collect();
    if why.notice {
        super::mux_round::queue_resume_notice(work_dir, broke, &failed, st.at);
    }
    st
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
    // 還沒有節點金鑰時工作資料夾是空路徑（lib.rs 的 identity::resolve 失敗）：這時也沒有夥伴要接回，
    // 寫下去只會在目前目錄留一個小檔（#859）
    if work_dir.as_os_str().is_empty() {
        return;
    }
    let _ = crate::settings::atomic::write(&work_dir.join(QUIT_MARK), b"1", crate::settings::atomic::STATE);
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
    /// 退回系統終端（原生主控台）開出來的夥伴名字（開窗後讀 `win_term::take_native_why`，同一個執行緒）
    native: std::sync::Mutex<std::collections::HashSet<String>>,
}

#[cfg(feature = "gui")]
impl RealDeps {
    /// 同名視窗還活著（名字的判斷維持原樣，用心跳的存活規則）
    fn live_name(&self, name: &str) -> bool {
        let live = crate::bridge::roster::read_sessions_with(&self.sessions, crate::heartbeat::session_alive, 0, "").unwrap_or_default();
        live.iter().any(|w| w.name == name)
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
        // 對話編號改用共用判斷（session 記錄＋命令列帶 --resume 的程序，手開、被改過名字的視窗也算）；名字維持原判斷
        already_live(&super::switch::RealOs, &super::console::read_sessions(&self.sessions), self.live_name(name), session)
    }
    fn unclaim(&self, e: &KnownEntry) {
        super::opening::release(&e.facts.session, &e.name);
    }
    fn still_starting(&self, e: &KnownEntry) -> bool {
        super::live_process::real_resumes(&e.facts.session)
    }
    fn launch(&self, e: &KnownEntry) -> Result<(), String> {
        let mut config = super::config::load_launch_config()?;
        // 一般使用者從畫面選的資料夾記在本機同意清單（launch-prefs.json），不在 launcher.json；併進來才接得回來
        super::cwds::allow_consented(&mut config, &e.facts.cwd, &self.data_dir);
        super::win_term::clear_native_why();
        let pid = super::local::start_resumed_window(&config, &e.name, &e.facts.cwd, &e.facts.session, &e.facts.perm, e.facts.hidden)?;
        if let Ok(mut m) = self.opened.lock() {
            m.insert(e.name.clone(), pid);
        }
        if super::win_term::take_native_why().is_some() {
            if let Ok(mut n) = self.native.lock() {
                n.insert(e.name.clone());
            }
        }
        Ok(())
    }
    fn opened_native(&self, name: &str) -> bool {
        self.native.lock().is_ok_and(|mut n| n.remove(name))
    }
    fn cause(&self) -> &'static str {
        self.cause
    }
    fn reveal(&self, e: &KnownEntry) -> bool {
        let pid = self.opened.lock().ok().and_then(|m| m.get(&e.name).copied());
        super::console::show_partner_window("claude", &e.name, pid)
    }
    fn appeared(&self, name: &str) -> bool {
        self.live_name(name)
    }
    fn report(&self, status: &Status) {
        if let Ok(text) = serde_json::to_string(status) {
            let _ = crate::settings::atomic::write(&self.data_dir.join(STATUS_FILE), text.as_bytes(), crate::settings::atomic::STATE);
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
    let entries = pick(known.entries(), known.boot_ms(), boot_ms(now), enabled, user_quit, known.archived_names());
    if entries.is_empty() {
        return;
    }
    let deps = RealDeps { data_dir: data_dir.to_path_buf(), sessions: crate::bridge::core::claude_sessions_dir(), opened: Default::default(), cause: "", native: Default::default() };
    let log_dir = work_dir.to_path_buf();
    let spawned = std::thread::Builder::new().name("asn-auto-resume".into()).spawn(move || {
        deps.sleep(START_DELAY_MS);
        let st = {
            let _one = RESUME_LOCK.lock().unwrap_or_else(|e| e.into_inner());
            run(entries, &deps)
        };
        let line = format!("{} info [ASN] auto-resume total={} resumed={} failed={}", crate::quota_core::iso_secs(st.at as i64), st.total, st.resumed.len(), st.failed.len());
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
        let es = crash_entries(&sv(&["甲", "乙", "丙"]), known, &Default::default());
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
        let boot = Status { state: "done", total: 1, resumed: vec!["甲".into()], failed: vec![], at: 1, cause: "", native: vec![] };
        assert!(!serde_json::to_string(&boot).unwrap().contains("cause"), "重開機的結果檔和以前一樣");
        let mux = Status { cause: super::super::mux_watch::CAUSE, ..boot };
        let v: serde_json::Value = serde_json::to_value(&mux).unwrap();
        assert_eq!(v["cause"], "共用的終端服務中斷了");
        let f = Fake::new();
        assert_eq!(run(vec![entry("甲")], &f).cause, "", "預設原因是空的");
    }

    #[cfg(feature = "gui")]
    #[test]
    fn _1860f_重啟的接回_原因寫重啟_中斷照舊() {
        assert_eq!(WHY_RESTART.cause, "重啟");
        assert_eq!(WHY_CRASH.cause, "共用的終端服務中斷了", "原本 mux_watch 的原因不變");
        // 十分鐘內第二次（不接回）那條路，原因也跟著呼叫端給的走
        let d = tempfile::tempdir().unwrap();
        let st = resume_entries_why(d.path(), vec![entry("甲")], false, WHY_RESTART, &Fake::new(), || ());
        assert_eq!(st.cause, "重啟");
        let st = resume_entries(d.path(), vec![entry("甲")], false, &Fake::new(), || ());
        assert_eq!(st.cause, super::super::mux_watch::CAUSE, "原路徑行為不變");
    }

    #[cfg(feature = "gui")]
    #[test]
    fn _1860f_重啟的接回_不排中斷通知_原路徑照排() {
        let d = tempfile::tempdir().unwrap();
        resume_entries_why(d.path(), vec![entry("甲")], true, WHY_RESTART, &Fake::new(), || ());
        assert!(super::super::mux_round::read_resume_notice(d.path()).is_none(), "本人按的重啟不用發「中斷」通知");
        resume_entries(d.path(), vec![entry("甲")], true, &Fake::new(), || ());
        assert!(super::super::mux_round::read_resume_notice(d.path()).is_some(), "原本 mux_watch 的路徑照排通知");
    }

    /// 一審複看 2：使用者重啟後的接回（真的呼叫 after_mux_restart 與重啟原因的接回）不動監看存的冷卻紀錄
    #[cfg(feature = "gui")]
    #[test]
    fn _1860f_重啟的接回_不改冷卻紀錄() {
        use super::super::mux_watch::{Watch, STATE_FILE};
        let (work, data) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
        let file = work.path().join(STATE_FILE);
        let mut w = Watch::default();
        w.last_resume_at = Some(7);
        w.save(&file);
        let before = std::fs::read_to_string(&file).unwrap();
        // 名單是空的：不會真的開任何視窗，但整條 after_mux_restart 照走
        after_mux_restart(work.path(), data.path(), &[]);
        assert_eq!(Watch::load(&file, None).last_resume_at, Some(7), "after_mux_restart 不動冷卻紀錄");
        // 有人要接回（假的接回動作）：原因寫重啟，同樣不動
        let st = resume_entries_why(work.path(), vec![entry("甲")], true, WHY_RESTART, &Fake::new(), || ());
        assert_eq!(st.total, 1);
        assert_eq!(Watch::load(&file, None).last_resume_at, Some(7), "接回不動冷卻紀錄");
        assert_eq!(std::fs::read_to_string(&file).unwrap(), before, "監看的狀態檔整份沒被改");
        // 對照：紀錄確實讀得到、冷卻確實在算（不是讀不到才「沒變」）
        let w2 = Watch::load(&file, None);
        assert!(w2.resume_quota_ok(7 + super::super::mux_watch::RESUME_GAP_MS));
        assert!(!w2.resume_quota_ok(8));
    }

    #[test]
    fn _1860f_重啟的接回_不經監看_不計十分鐘冷卻() {
        let src = include_str!("auto_resume.rs");
        let f = src.split("pub fn after_mux_restart").nth(1).unwrap().split("pub fn ").next().unwrap();
        assert!(f.contains("after_mux(") && f.contains("WHY_RESTART"), "重啟一律接回、原因寫重啟");
        // 「不計冷卻」的行為證明在 mux_watch 的 t1860f_帶停止記號的換服務 測試（Watch::tick）
        let lib = include_str!("../lib.rs");
        let cmd = lib.split("async fn task_manager_restart_mux").nth(1).unwrap().split("async fn ").next().unwrap();
        assert!(cmd.contains("after_mux_restart") && !cmd.contains("after_mux_crash") && !cmd.contains("last_resume_at"), "重啟指令走重啟的接回");
    }

    #[test]
    fn 使用者結束_留記號在機器資料夾_資料夾是空的_截圖模式_不亂寫() {
        let d = tempfile::tempdir().unwrap();
        note_user_quit(d.path());
        assert!(d.path().join(QUIT_MARK).exists());
        // 空路徑：不能在目前所在的資料夾留下記號
        let here = std::env::current_dir().unwrap().join(QUIT_MARK);
        let existed = here.exists();
        note_user_quit(Path::new(""));
        assert_eq!(here.exists(), existed, "空資料夾不該寫出檔案");
    }

    #[test]
    fn 守門_自動接回開窗前併入本機同意過的資料夾() {
        let me = &crate::settings::src_scan::prod_source(include_str!("auto_resume.rs"));
        assert!(me.contains("super::cwds::allow_consented(&mut config, &e.facts.cwd, &self.data_dir)"));
        let i = me.find("allow_consented").unwrap();
        let j = me.find("start_resumed_window(").unwrap();
        assert!(i < j, "要先併白名單才開窗");
    }

    #[test]
    fn 重開自動接回和橋看同一個_session_資料夾() {
        let me = &crate::settings::src_scan::prod_source(include_str!("auto_resume.rs"));
        let core = &crate::settings::src_scan::prod_source(include_str!("../bridge/core.rs"));
        assert!(me.contains("sessions: crate::bridge::core::claude_sessions_dir()"), "自動接回要用橋的來源");
        assert!(!me.contains(r#".join(".claude").join("sessions")"#), "不能自己再拼一份");
        assert!(core.contains("sessions_dir: claude_sessions_dir(),"), "橋也要走同一個來源");
        let d = crate::bridge::core::claude_sessions_dir();
        assert!(d.ends_with(std::path::Path::new(".claude").join("sessions")), "{d:?}");
    }

    use super::*;
    use crate::launch::live_process::{cmdline_resumes, process_resumes};
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
        released: RefCell<Vec<String>>,
        /// 這些名字的視窗程序還活著（命令列帶 --resume），只是 session 檔還沒寫出來
        starting: Vec<String>,
        /// 這些名字開出來時退回了系統終端（原生主控台）
        native: Vec<String>,
    }

    impl Fake {
        fn new() -> Fake {
            Fake { now: Cell::new(1_000_000), logins: RefCell::new(vec![]), free: RefCell::new(vec![]), live: vec![], launched: RefCell::new(vec![]), fail_launch: vec![], never_appears: vec![], states: RefCell::new(vec![]), running: Cell::new(0), peak: Cell::new(0), revealed: RefCell::new(vec![]), reveal_ok: false, released: RefCell::new(vec![]), starting: vec![], native: vec![] }
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
        fn opened_native(&self, name: &str) -> bool {
            self.native.iter().any(|n| n == name)
        }
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
                return Err(if e.name == "別條路開的" { crate::launch::opening::BUSY.to_string() } else { "壞了".into() });
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
        fn unclaim(&self, e: &KnownEntry) {
            self.released.borrow_mut().push(e.name.clone());
            crate::launch::opening::release(&e.facts.session, &e.name);
        }
        fn still_starting(&self, e: &KnownEntry) -> bool {
            self.starting.contains(&e.name)
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
        let none = std::collections::BTreeSet::new();
        assert_eq!(names(pick(all.clone(), Some(1), Some(100_000_000), true, false, &none)), ["甲"]);
        assert!(pick(all.clone(), Some(100_000_000), Some(100_000_001), true, false, &none).is_empty(), "同一次開機（只是重開 ASN）不接");
        assert!(pick(all.clone(), None, Some(100_000_000), true, false, &none).is_empty(), "舊檔不知道開機時間，不接");
        assert!(pick(all.clone(), Some(1), None, true, false, &none).is_empty(), "讀不到開機時間，不接");
        assert!(pick(all.clone(), Some(1), Some(100_000_000), false, false, &none).is_empty(), "設定關了不接");
        assert!(pick(all, Some(1), Some(100_000_000), true, true, &none).is_empty(), "使用者自己結束 ASN 之後才重開，不接");
    }

    #[test]
    fn 關掉的與封存的視窗重開機後不接_沒關的照常接() {
        let mut k = crate::bridge::known::Known::default();
        for n in ["沒關", "關掉了", "封存了"] {
            k.touch(n, "claude", 1000);
            k.set_facts(n, WindowFacts { session: format!("s-{n}"), cwd: "D:/w".into(), asn_opened: true, perm: vec![], hidden: false });
        }
        let names = |v: Vec<KnownEntry>| v.into_iter().map(|e| e.name).collect::<Vec<_>>();
        let boots = (Some(1), Some(100_000_000));
        assert_eq!(names(pick(k.entries(), boots.0, boots.1, true, false, k.archived_names())).len(), 3, "都沒處理過：三個都接");
        // 本人關掉視窗：從認得的清單拿掉
        k.forget("關掉了");
        // 封存：視窗還開著、每輪名單都看得到，也不能被記回來
        k.set_archived(["封存了".to_string()].into_iter().collect());
        k.touch("封存了", "claude", 2000);
        k.touch("沒關", "claude", 2000);
        assert_eq!(names(pick(k.entries(), boots.0, boots.1, true, false, k.archived_names())), ["沒關"]);
        // 就算清單裡還有封存的名字（開機前存檔沒來得及更新），pick 自己也再擋一次
        let mut stale = vec![entry("沒關"), entry("封存了")];
        stale[1].facts.asn_opened = true;
        let archived: std::collections::BTreeSet<String> = ["封存了".to_string()].into_iter().collect();
        assert_eq!(names(pick(stale, boots.0, boots.1, true, false, &archived)), ["沒關"]);
    }

    #[test]
    fn 別條路剛登記要開同一位_不重開_也不算失敗() {
        let mut f = Fake::new();
        f.fail_launch = vec!["別條路開的".into()];
        let st = run(vec![entry("別條路開的"), entry("乙")], &f);
        assert_eq!(st.resumed, ["乙"]);
        assert!(st.failed.is_empty(), "{:?}", st.failed);
        assert_eq!(st.total, 1, "別條路開的不算在這一輪");
    }

    #[test]
    fn t1867_接回的視窗退回系統終端_結果裡列出名字_畫面才講得出來() {
        let mut f = Fake::new();
        f.native = vec!["乙".into()];
        let st = run(vec![entry("甲"), entry("乙")], &f);
        assert_eq!(st.resumed, ["甲", "乙"]);
        assert_eq!(st.native, ["乙"], "只有退回原生的那位；都在終端服務裡的不列");
        let json = serde_json::to_string(&st).unwrap();
        assert!(json.contains("\"native\":[\"乙\"]"), "{json}");
        let none = run(vec![entry("甲")], &Fake::new());
        assert!(none.native.is_empty() && !serde_json::to_string(&none).unwrap().contains("native"), "沒有退回就不多一個欄位");
    }

    #[test]
    fn 開了卻沒看到上線_解除登記_上線了的不解除() {
        let mut f = Fake::new();
        f.never_appears = vec!["甲".into()];
        let st = run(vec![entry("甲"), entry("乙")], &f);
        assert_eq!(st.resumed, ["乙"]);
        assert_eq!(*f.released.borrow(), ["甲"], "只有沒上線的解除，本人之後手動喚醒才不會被擋");
    }

    #[test]
    fn 等了九十秒沒上線_但程序還活著_不解除登記_同一位再登記仍被擋() {
        let mut f = Fake::new();
        f.never_appears = vec!["慢熱甲".into()];
        f.starting = vec!["慢熱甲".into()];
        let e = entry("慢熱甲");
        assert!(crate::launch::opening::claim(&e.facts.session, &e.name), "開窗時登記");
        let st = run(vec![e.clone()], &f);
        assert!(f.released.borrow().is_empty(), "程序還活著：保留登記，讓它自然到期");
        assert!(!crate::launch::opening::claim(&e.facts.session, "別名"), "同一個對話編號再登記要被擋");
        assert!(!crate::launch::opening::claim("another-sid", &e.name), "同一個名字再登記要被擋");
        assert_eq!(st.failed.len(), 1, "照舊列為沒看到上線");
        crate::launch::opening::release(&e.facts.session, &e.name);
    }

    #[test]
    fn 等了九十秒沒上線_程序也沒了_照舊解除登記() {
        let mut f = Fake::new();
        f.never_appears = vec!["慢熱乙".into()];
        let e = entry("慢熱乙");
        assert!(crate::launch::opening::claim(&e.facts.session, &e.name));
        run(vec![e.clone()], &f);
        assert_eq!(*f.released.borrow(), ["慢熱乙"]);
        assert!(crate::launch::opening::claim(&e.facts.session, &e.name), "解除後再登記得到");
        crate::launch::opening::release(&e.facts.session, &e.name);
    }

    #[test]
    fn 命令列接續這段對話才算已經開著() {
        let sid = "76c44a7f-d488-49f0-9d6c-d089a427b5ed";
        assert!(cmdline_resumes(&format!(r#""C:\x\claude.exe" --dangerously-skip-permissions --resume {sid} -n "甲""#), sid));
        assert!(cmdline_resumes(&format!("claude --resume={sid}"), sid));
        assert!(cmdline_resumes(&format!("claude -r {sid}"), sid));
        assert!(cmdline_resumes(&format!("claude --session-id {sid}"), sid));
        assert!(!cmdline_resumes(&format!("claude --resume {sid}x"), sid), "編號要逐字相同");
        assert!(!cmdline_resumes("claude --resume other-sid", sid));
        assert!(!cmdline_resumes(&format!("claude -n {sid}"), sid), "不是接續參數的值不算");
        assert!(!cmdline_resumes("claude --resume", sid));
        assert!(!cmdline_resumes(&format!("claude --resume {sid}"), ""), "沒有編號不比對");
    }

    #[test]
    fn 程序表有活著的接續程序就算開著_查不到命令列或已結束就不算() {
        use super::super::switch::Proc;
        let sid = "76c44a7f-d488-49f0-9d6c-d089a427b5ed";
        let procs = vec![
            Proc { pid: 1, ppid: 0, name: "explorer.exe".into() },
            Proc { pid: 10, ppid: 1, name: "claude.exe".into() },
            Proc { pid: 20, ppid: 1, name: "node.exe".into() },
            Proc { pid: 30, ppid: 1, name: "powershell.exe".into() },
        ];
        let cmd = |p: u32| match p {
            10 => Some(format!("claude --resume {sid}")),
            20 => None,
            30 => Some(format!("powershell -c claude --resume {sid}")),
            _ => Some(format!("claude --resume {sid}")),
        };
        assert!(process_resumes(&procs, &|_| true, &cmd, sid));
        assert!(!process_resumes(&procs, &|p| p != 10, &cmd, sid), "pid 10 已結束，node 讀不到命令列，殼不算：退回只看 session 檔");
        assert!(!process_resumes(&procs, &|_| true, &|_| None, sid), "命令列都讀不到：不算（退回 session 檔的判斷）");
        assert!(!process_resumes(&procs[..1], &|_| true, &cmd, sid), "探索者之類不是 Claude 的程序不讀命令列");
    }

    #[test]
    fn 終端服務中斷接回_封存的夥伴不接() {
        let known = vec![entry("甲"), entry("乙")];
        let archived: std::collections::BTreeSet<String> = ["乙".to_string()].into_iter().collect();
        let es = crash_entries(&sv(&["甲", "乙"]), known, &archived);
        assert_eq!(es.iter().map(|e| e.name.as_str()).collect::<Vec<_>>(), ["甲"]);
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
        assert_eq!(perm_args_from_cmdline(r#""C:\claude.exe" --dangerously-skip-permissions -n 擁有者 --resume abc"#), [BYPASS_FLAG]);
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
    fn 沒有工作資料夾_結束時不在目前目錄留記號() {
        let stray = std::env::current_dir().unwrap().join(QUIT_MARK);
        let before = stray.exists();
        note_user_quit(Path::new(""));
        assert_eq!(stray.exists(), before, "不能寫到目前目錄");
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

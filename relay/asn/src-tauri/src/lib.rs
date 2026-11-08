//! ASN 即時通（Tauri 2）：金鑰、anon 金鑰、收發室 HTTP／WebSocket、心跳檔、設定與對話存檔都在 Rust 端；
//! 前端（ui/）只拿得到「信件與名單」，拿不到任何金鑰。
//! 電腦版（desktop）與安卓版共用同一份：電腦端才有的模組都掛 `#[cfg(desktop)]`，手機建置不編譯（設計見 docs/design/ANDROID.md）。
// 手機版沒有電腦端的功能，那些共用程式裡只給電腦用的函式在手機建置會變成「沒人叫」：不當成警告
#![cfg_attr(not(desktop), allow(dead_code, unused_variables, unused_imports))]
// 無視窗版（沒有 gui）不編視窗與指令那一半，留下的共用函式與型別在這裡看起來「沒人叫」：不當成警告
#![cfg_attr(not(feature = "gui"), allow(dead_code, unused_variables, unused_imports))]
// 寫不進去就略過的列印巨集 elog!／olog!（標準的 eprintln／println 寫失敗會 panic，release 是 panic=abort 會閃退，見 elog.rs）
// 要放在所有模組之前，後面的模組才看得到這兩個巨集
#[macro_use]
mod elog;
// ---- 手機與電腦都有的模組 ----
#[cfg(feature = "gui")]
mod account;
#[cfg(feature = "gui")]
mod android_update;
mod appdir;
mod attach;
mod auth;
mod avatar;
mod bell;
mod datadir;
mod device_login;
mod envc;
mod heartbeat;
// 本人接進收發室的視窗（只有電腦版有：手機沒有終端程序與本機 session 資料夾）
#[cfg(desktop)]
mod self_windows;
mod home;
mod identity;
mod invite_link;
mod lastlogin;
mod names;
mod nowin;
mod nowplaying;
mod relay;
mod site_releases;
pub mod rt;
// ---- 安卓版專屬 ----
#[cfg(target_os = "android")]
mod android;
// ---- 只有電腦版有的模組（內建收發室橋、開 Claude／Codex 視窗與切換模型、密碼小幫手、Claude 帳號與外掛、用量、聽歌狀態、截圖、語音、系統匣、自動更新、多視窗）。
// 手機建置不編譯它們；守門測試 test/android.test.mjs 會檢查每一個都掛著 cfg(desktop) ----
#[cfg(desktop)]
mod acct_remote;
#[cfg(desktop)]
mod statusline_hook;
#[cfg(desktop)]
mod term_remote;
#[cfg(desktop)]
mod perm_remote;
mod device_id;
mod keystore;
#[cfg(desktop)]
mod view_handshake;
#[cfg(desktop)]
mod view_stream;
#[cfg(desktop)]
mod view_seen;
#[cfg(desktop)]
mod view_remote;
#[cfg(all(desktop, feature = "gui"))]
mod presence;
#[cfg(desktop)]
mod view_input;
#[cfg(all(desktop, feature = "gui"))]
mod input_consent;
#[cfg(feature = "gui")]
#[cfg(desktop)]
mod ads;
#[cfg(desktop)]
mod agent_setup;
#[cfg(desktop)]
mod agent_tools;
#[cfg(desktop)]
pub mod askpass;
pub mod secret_remote;
#[cfg(desktop)]
mod bridge;
#[cfg(desktop)]
pub mod headless;
#[cfg(desktop)]
pub mod inbox_mode;
#[cfg(desktop)]
pub mod cli;
#[cfg(desktop)]
mod claude_accounts;
#[cfg(desktop)]
mod claude_json;
#[cfg(desktop)]
mod claude_mod;
#[cfg(desktop)]
mod claude_quota;
#[cfg(feature = "gui")]
mod cloud_invite;   // 電腦與手機共用：邀請雲端代理（建立、清單、撤銷、核准無畫面主機的短碼）
#[cfg(desktop)]
mod codex_accounts;
#[cfg(desktop)]
mod codex_quota;
#[cfg(desktop)]
mod gemini_quota;
#[cfg(desktop)]
mod gemini_session;
#[cfg(desktop)]
mod grok_accounts;
#[cfg(desktop)]
mod launch;
#[cfg(feature = "gui")]
#[cfg(desktop)]
mod shot;
#[cfg(feature = "gui")]
#[cfg(desktop)]
mod stt;
#[cfg(feature = "gui")]
#[cfg(desktop)]
mod tray;
#[cfg(feature = "gui")]
#[cfg(desktop)]
mod tts;
#[cfg(feature = "gui")]
#[cfg(desktop)]
mod ui_log;
#[cfg(feature = "gui")]
#[cfg(desktop)]
mod updater;
#[cfg(feature = "gui")]
#[cfg(desktop)]
mod login_watch;
#[cfg(feature = "gui")]
#[cfg(desktop)]
mod usage;
#[cfg(desktop)]
mod voicecfg;
#[cfg(feature = "gui")]
#[cfg(desktop)]
mod wins;

use relay::Relay;
use serde::Serialize;
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::sync::Arc;
#[cfg(feature = "gui")]
use tauri::{AppHandle, Emitter, Manager, State};

/// 所有視窗共用的瀏覽器啟動參數（必須一致，否則第二扇視窗建不起來）。WebView2 才支援這些參數（自動播放，以及關掉隱藏／被遮住時的計時器節流與背景降權，讓縮在系統匣的名單畫面照常收信）；Linux WebKitGTK 略過。必須與 tauri.conf.json 名單視窗的 additionalBrowserArgs 一字不差（test/window-throttling.test.mjs 守著）。
#[cfg(windows)]
pub const BROWSER_ARGS: &str = "--autoplay-policy=no-user-gesture-required --disable-background-timer-throttling --disable-renderer-backgrounding --disable-backgrounding-occluded-windows --disable-features=CalculateNativeWinOcclusion";
#[cfg(all(not(windows), desktop))]
pub const BROWSER_ARGS: &str = "";

pub struct App {
    pub relay: Option<Arc<Relay>>,
    pub init_error: Option<String>,
    pub node: String,
    pub work_dir: PathBuf,
    pub data_dir: PathBuf,
    pub shot: Option<PathBuf>,
    /// 叫醒「正在聽的歌」輪詢（開關切換時立刻讀一次）
    pub now_wake: std::sync::mpsc::Sender<()>,
}

#[derive(Serialize)]
struct StartupInfo {
    node: String,
    window_name: String,
    /// 設備名稱是使用者自己取過的（settings.json 有 window_name）；沒取過＝系統偵測的預設名
    window_name_custom: bool,
    old_names: Vec<String>,
    error: Option<String>,
    /// 要先顯示登入畫面：沒有節點金鑰，或有金鑰但還沒登入（除非選了「暫時不登入」）
    needs_login: bool,
    /// 登入畫面可以顯示「暫時不登入」：只有這台已有節點金鑰時
    can_skip_login: bool,
    /// 上次登入的方式與頭像（沒登入過就是空）
    last_login: Option<lastlogin::LastLoginView>,
    shot: bool,
    poll_ms: u64,
    roster_ms: u64,
    version: String,
}

fn env_ms(k: &str, d: u64) -> u64 {
    crate::envc::get(k).and_then(|v| v.parse().ok()).unwrap_or(d)
}

/// 視窗名：預設 `<節點>-ASN`；設定檔 settings.json 的 window_name 可改
pub fn default_window_name(node: &str) -> String {
    format!("{node}-ASN")
}
/// 登入時由後台自動產生的節點代號：`t<序號>-` 或 `n` 開頭，後面剛好 8 碼小寫十六進位（見 asn_node_create）。
/// 使用者不取也不會看到這種代號；舊電腦手動取的代號（H、w02…）不是這個格式，照舊。
pub fn is_auto_node_id(id: &str) -> bool {
    let rest = if let Some(r) = id.strip_prefix('t') {
        let digits = r.chars().take_while(|c| c.is_ascii_digit()).count();
        if digits == 0 {
            return false;
        }
        match r[digits..].strip_prefix('-') {
            Some(x) => x,
            None => return false,
        }
    } else if let Some(r) = id.strip_prefix('n') {
        r
    } else {
        return false;
    };
    rest.len() == 8 && rest.chars().all(|c| c.is_ascii_digit() || ('a'..='f').contains(&c))
}

/// 視窗名預設值：手動取代號的舊電腦＝`<代號>-ASN`；自動產生代號的新電腦改用電腦名稱（`<電腦名>-ASN`），畫面上不會出現節點代號
#[cfg(feature = "gui")]
pub fn default_window_name_for(node: &str, computer: &str) -> String {
    if is_auto_node_id(node) {
        let c: String = computer.chars().filter(|c| !c.is_control()).collect::<String>().trim().chars().take(36).collect();
        let c = if c.is_empty() { account::DEVICE_FALLBACK.to_string() } else { c };
        return format!("{c}-ASN");
    }
    default_window_name(node)
}
pub fn valid_window_name(s: &str) -> bool {
    !s.is_empty() && s.chars().count() <= 60 && s.trim() == s && !s.chars().any(|c| c.is_control())
}
pub fn read_settings_name(data_dir: &Path) -> Option<String> {
    let v: Value = serde_json::from_str(&std::fs::read_to_string(data_dir.join("settings.json")).ok()?).ok()?;
    v.get("window_name")?.as_str().filter(|s| valid_window_name(s)).map(String::from)
}
pub fn write_atomic(path: &Path, text: &str) -> std::io::Result<()> {
    if let Some(p) = path.parent() {
        std::fs::create_dir_all(p)?;
    }
    let tmp = PathBuf::from(format!("{}.{}.tmp", path.display(), std::process::id()));
    std::fs::write(&tmp, text)?;
    std::fs::rename(&tmp, path)
}

#[cfg(feature = "gui")]
#[tauri::command]
fn startup_info(app: State<'_, App>, auth: State<'_, auth::AuthState>) -> StartupInfo {
    StartupInfo {
        node: app.node.clone(),
        window_name: app.relay.as_ref().map(|r| r.window_name()).unwrap_or_default(),
        window_name_custom: read_settings_name(&app.data_dir).is_some(),
        old_names: app.relay.as_ref().map(|r| r.active_names().into_iter().skip(1).collect()).unwrap_or_default(),
        error: app.init_error.clone(),
        needs_login: account::needs_login(app.relay.is_some(), auth.status().signed_in, account::login_skipped(&app.data_dir)),
        can_skip_login: app.relay.is_some(),
        last_login: lastlogin::view(&app.data_dir),
        shot: app.shot.is_some(),
        poll_ms: env_ms("ASN_POLL_MS", 120_000),
        roster_ms: env_ms("ASN_APP_ROSTER_MS", 60_000),
        version: env!("CARGO_PKG_VERSION").into(),
    }
}

pub(crate) fn relay_of(app: &App) -> Result<Arc<Relay>, String> {
    app.relay.clone().ok_or_else(|| app.init_error.clone().unwrap_or_else(|| "尚未連上 ASN".into()))
}

#[cfg(feature = "gui")]
#[tauri::command]
async fn relay_list(app: State<'_, App>) -> Result<Value, String> {
    relay_of(&app)?.list().await
}
#[cfg(feature = "gui")]
#[tauri::command]
async fn relay_inbox(app: State<'_, App>) -> Result<Value, String> {
    relay_of(&app)?.inbox().await
}
#[cfg(feature = "gui")]
#[tauri::command]
async fn relay_ack(app: State<'_, App>, ids: Vec<String>) -> Result<Value, String> {
    relay_of(&app)?.ack(&ids).await
}
/// 群組列表（GET room_list）：有登入就帶本人簽章，後台才會把本人在跨租戶群組的成員身分一起列出
#[cfg(feature = "gui")]
#[tauri::command]
async fn relay_rooms(app: State<'_, App>, auth: State<'_, auth::AuthState>) -> Result<Value, String> {
    let token = account::signing_token(&auth).await;
    relay_of(&app)?.rooms_as(token.as_deref()).await
}
/// 真人的群組動作（建群組、邀請、接受邀請、退出、帶自己的 AI、主持人確認…）：一定要本人簽章，沒登入回錯、不打後台
#[cfg(feature = "gui")]
#[tauri::command]
async fn relay_group(app: State<'_, App>, auth: State<'_, auth::AuthState>, action: String, body: Value) -> Result<Value, String> {
    let token = account::signing_token(&auth).await;
    relay_of(&app)?.group_signed(&action, &body, token.as_deref()).await
}
/// 讀群組訊息（電腦版對話用）：有登入就帶本人簽章；一定帶 since；mark＝讀完標已讀
#[cfg(feature = "gui")]
#[tauri::command]
async fn relay_room_read(app: State<'_, App>, auth: State<'_, auth::AuthState>, room: String, agent: Option<String>, since: u64, limit: Option<u64>, mark: bool) -> Result<Value, String> {
    let token = account::signing_token(&auth).await;
    relay_of(&app)?.room_read_as(&room, agent.as_deref(), since, limit, mark, token.as_deref()).await
}
/// 在群組發言（電腦版對話用）：要本人簽章，沒登入回錯、不打後台
#[cfg(feature = "gui")]
#[tauri::command]
async fn relay_room_post(app: State<'_, App>, auth: State<'_, auth::AuthState>, body: Value) -> Result<Value, String> {
    let token = account::signing_token(&auth).await;
    relay_of(&app)?.room_post_signed(&body, token.as_deref()).await
}

/// 還沒交給畫面的邀請碼（第一次點連結時畫面可能還沒載入）。畫面啟動時取走；之後的連結走 asn:invite 事件
#[cfg(feature = "gui")]
#[derive(Default)]
struct InviteInbox(std::sync::Mutex<Option<String>>);
#[cfg(feature = "gui")]
#[tauri::command]
fn invite_pending(inbox: State<'_, InviteInbox>) -> Option<String> {
    inbox.0.lock().ok().and_then(|mut g| g.take())
}
/// 收到邀請連結：記下來並通知畫面（畫面沒載入也不會漏）。把名單視窗叫到前面
#[cfg(feature = "gui")]
fn deliver_invite(app: &tauri::AppHandle, code: String) {
    use tauri::{Emitter, Manager};
    if let Some(inbox) = app.try_state::<InviteInbox>() {
        if let Ok(mut g) = inbox.0.lock() {
            *g = Some(code.clone());
        }
    }
    let _ = app.emit("asn:invite", code);
    #[cfg(desktop)]
    if let Some(w) = app.get_webview_window("list") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

#[cfg(feature = "gui")]
#[cfg(desktop)]
#[tauri::command]
async fn relay_launch(app: State<'_, App>, body: Value) -> Result<Value, String> {
    launch::relay_launch(relay_of(&app)?.as_ref(), body).await
}

#[cfg(feature = "gui")]
#[cfg(desktop)]
#[tauri::command]
async fn relay_launchers(app: State<'_, App>, auth: State<'_, auth::AuthState>, ids: Option<Vec<String>>) -> Result<Value, String> {
    let r = relay_of(&app)?;
    let token = account::signing_token(&auth).await;
    launch::relay_launchers(r.as_ref(), ids, token.as_deref()).await
}

// ---------- 遠端切換 Claude 帳號（設計見 acct_remote.rs；權杖只在各自那台搬，不進收發室） ----------
/// 把本機帳號庫的清單（只有 email、方案、使用中）回報給收發室，讓擁有者設備看得到
#[cfg(feature = "gui")]
#[cfg(desktop)]
#[tauri::command]
async fn acct_remote_report(app: State<'_, App>) -> Result<Value, String> {
    let relay = relay_of(&app)?;
    report_accounts(relay, app.work_dir.clone()).await
}

/// 回報一次並留紀錄。背景工作和畫面都走這裡；不用本人登入，只要這台有節點金鑰
#[cfg(feature = "gui")]
#[cfg(desktop)]
async fn report_accounts(relay: Arc<Relay>, work_dir: std::path::PathBuf) -> Result<Value, String> {
    static REPORT_LOG: std::sync::Mutex<acct_remote::ReportLog> = std::sync::Mutex::new(acct_remote::ReportLog::new());
    let write = |line: String| {
        let _ = ui_log::append(&work_dir, &[format!("{} info [ASN] {line}", claude_quota::iso_secs(heartbeat::now_ms() as i64))]);
    };
    let r = collect_and_report(relay, work_dir.clone(), &write).await;
    let line = REPORT_LOG.lock().unwrap_or_else(|e| e.into_inner()).line(&r);
    if let Some(line) = line {
        write(line);
    }
    r
}

#[cfg(feature = "gui")]
#[cfg(desktop)]
async fn collect_and_report(relay: Arc<Relay>, work_dir: std::path::PathBuf, write: &(impl Fn(String) + Sync)) -> Result<Value, String> {
    let list = tauri::async_runtime::spawn_blocking(claude_accounts::local_list).await.map_err(|e| e.to_string())?;
    // Codex 目前登入（只有 email／方案）；讀不到或沒登入就不放，不影響 Claude 的回報
    let codex = tauri::async_runtime::spawn_blocking(codex_accounts::codex_account_current).await.ok().and_then(|r| r.ok()).flatten();
    // 各帳號上次記下的額度（沒有紀錄的帳號不帶額度欄位）
    let quotas = tauri::async_runtime::spawn_blocking(|| claude_quota::load_all(&claude_accounts::claude_home())).await.unwrap_or_default();
    // Grok 帳號庫（email 與是否使用中）；沒有就是空的
    let grok = tauri::async_runtime::spawn_blocking(grok_accounts::local_list).await.unwrap_or_default();
    // Codex 的額度窗：橋的 Codex 引擎存在工作資料夾；帳號跟目前登入對得上才帶（沒開 Codex 橋接就沒有）
    let login = codex.as_ref().filter(|c| c.mode == "chatgpt").map(|c| c.email.clone());
    let codex_windows = tauri::async_runtime::spawn_blocking(move || login.map(|e| codex_quota::windows_for(&work_dir, &e, heartbeat::now_ms() as i64)).unwrap_or_default()).await.unwrap_or_default();
    // Gemini：ASN 開的 agy 視窗狀態列記下的帳號與額度（沒開過就是空的）
    let gemini = tauri::async_runtime::spawn_blocking(|| gemini_quota::report_rows(&gemini_quota::load_all(&identity::home_dir()), heartbeat::now_ms() as i64)).await.unwrap_or_default();
    // 登入失效（對話紀錄判定，見 login_watch.rs）：隨帳號回報帶 login_failed；判定為失效時用節點金鑰呼叫後台 acct_login_alert 通知本人
    let ctx = login_watch::NoticeCtx {
        computer: account::computer_name(|k| std::env::var(k).ok()),
        email: list.iter().find(|a| a.current).map(|a| a.email.clone()).unwrap_or_default(),
    };
    let notifier = login_watch::RelayNotifier { relay: relay.clone() };
    let login_failed = tauri::async_runtime::spawn_blocking(move || login_watch::tick_real(heartbeat::now_ms() as i64, &ctx, &notifier)).await.unwrap_or(false);
    acct_remote::report(relay.as_ref(), &list, codex.as_ref(), &quotas, &grok, &codex_windows, &gemini, login_failed, write).await
}
/// 帳號列表（#374）：本人所有設備回報的各廠牌帳號與額度。要本人簽章；沒登入回錯，不打後台
#[cfg(feature = "gui")]
#[cfg(desktop)]
#[tauri::command]
async fn acct_roster(app: State<'_, App>, auth: State<'_, auth::AuthState>) -> Result<Value, String> {
    let r = relay_of(&app)?;
    let token = account::signing_token(&auth).await;
    r.acct_roster_signed(token.as_deref()).await
}
#[cfg(feature = "gui")]
#[cfg(desktop)]
#[tauri::command]
async fn acct_remote_list(app: State<'_, App>, auth: State<'_, auth::AuthState>, node: String) -> Result<Value, String> {
    let r = relay_of(&app)?;
    let token = account::signing_token(&auth).await;
    acct_remote::remote_list(r.as_ref(), &node, token.as_deref()).await
}
#[cfg(feature = "gui")]
#[cfg(desktop)]
#[tauri::command]
async fn acct_remote_request(app: State<'_, App>, auth: State<'_, auth::AuthState>, node: String, email: String, vendor: Option<String>) -> Result<Value, String> {
    let token = account::signing_token(&auth).await;
    acct_remote::remote_request(relay_of(&app)?.as_ref(), &node, &email, vendor.as_deref().unwrap_or("claude"), token.as_deref()).await
}
#[cfg(feature = "gui")]
#[cfg(desktop)]
#[tauri::command]
async fn acct_remote_status(app: State<'_, App>, ids: Vec<String>) -> Result<Value, String> {
    acct_remote::remote_status(relay_of(&app)?.as_ref(), ids).await
}
#[cfg(feature = "gui")]
#[cfg(desktop)]
#[tauri::command]
async fn acct_remote_pending(app: State<'_, App>) -> Result<Vec<acct_remote::Pending>, String> {
    acct_remote::pending(relay_of(&app)?.as_ref(), &app.data_dir).await
}
#[cfg(feature = "gui")]
#[cfg(desktop)]
#[tauri::command]
async fn acct_remote_apply(app: State<'_, App>, id: String, confirmed: bool) -> Result<Value, String> {
    acct_remote::apply(relay_of(&app)?.as_ref(), &app.data_dir, id, confirmed).await
}
#[cfg(feature = "gui")]
#[cfg(desktop)]
#[tauri::command]
async fn acct_remote_decline(app: State<'_, App>, id: String) -> Result<(), String> {
    acct_remote::decline(relay_of(&app)?.as_ref(), &app.data_dir, id).await
}
#[cfg(feature = "gui")]
#[cfg(desktop)]
#[tauri::command]
fn acct_remote_allow_get(app: State<'_, App>) -> bool {
    acct_remote::allow_switch(&app.data_dir)
}
#[cfg(feature = "gui")]
#[cfg(desktop)]
#[tauri::command]
fn acct_remote_allow_set(app: State<'_, App>, on: bool) -> Result<(), String> {
    acct_remote::set_allow_switch(&app.data_dir, on)
}

#[cfg(feature = "gui")]
#[cfg(desktop)]
#[tauri::command]
fn agent_setup_remote_allow_get(app: State<'_, App>) -> bool {
    agent_setup::switch::remote_allowed(&app.data_dir)
}
#[cfg(feature = "gui")]
#[cfg(desktop)]
#[tauri::command]
fn agent_setup_remote_allow_set(app: State<'_, App>, on: bool) -> Result<(), String> {
    agent_setup::switch::set_remote_allowed(&app.data_dir, on)
}
/// 取本人簽章的函式（來源只有視窗程式的記憶體）。在安裝並登入的執行緒裡被呼叫（不是非同步工作執行緒），用 block_on 等權杖是安全的
#[cfg(feature = "gui")]
#[cfg(desktop)]
fn agent_setup_token_fn(handle: &AppHandle) -> agent_setup::setup::TokenFn {
    let h = handle.clone();
    Arc::new(move || rt::block_on(async { account::signing_token(&h.state::<auth::AuthState>()).await }).filter(|t| !t.is_empty()))
}
/// 確認窗要給本人看的文字（固定）：做什麼、不做什麼
#[cfg(feature = "gui")]
#[cfg(desktop)]
#[tauri::command]
fn agent_setup_plan() -> &'static str {
    "將在這台電腦安裝官方的 Claude Code（從 downloads.claude.ai 下載，驗過雜湊與數位簽章，簽署者必須是 Anthropic, PBC），再把登入網址送到你的手機，由你在手機上授權。已經裝好的不會重裝，已經登入的不會重新登入。"
}
/// 人在這台電腦前按了取消：在目前這一步做完之後生效
#[cfg(feature = "gui")]
#[cfg(desktop)]
#[tauri::command]
fn agent_setup_cancel() {
    agent_setup::setup::request_cancel();
}
/// 手機觸發的安裝並登入（presence 回應帶來的請求）：本機三道把關過了才開始，開始時跳出看得見的通知（附取消），結果回報到手機
#[cfg(feature = "gui")]
#[cfg(desktop)]
async fn run_remote_setup(handle: AppHandle, relay: Arc<Relay>, requested_by: String) {
    use agent_setup::remote::{gate, Gate};
    let app = handle.state::<App>();
    let token = account::signing_token(&handle.state::<auth::AuthState>()).await;
    if let Gate::Refuse(why) = gate(agent_setup::switch::remote_allowed(&app.data_dir), token.as_deref(), &requested_by) {
        elog!("手機要求安裝並登入被拒絕：{why}");
        relay.report_setup_result(false, why, None).await;
        return;
    }
    // 已經有一輪在跑：直接回報，不去動那一輪的小窗
    if agent_setup::setup::is_busy() {
        relay.report_setup_result(false, "這台電腦正在安裝並登入，請稍後再試", None).await;
        return;
    }
    // 右下角的常駐進度小窗：人在電腦前看得到、能取消，是不跳本機確認窗的前提。開不起來就不開始，回報手機
    let round = match wins::open_setup_progress(&handle) {
        Ok(r) => r,
        Err(e) => {
            elog!("開進度小窗失敗，不開始安裝：{e}");
            relay.report_setup_result(false, "這台電腦無法顯示進度，沒有開始安裝", None).await;
            return;
        }
    };
    let _ = handle.emit("agent-setup-remote", serde_json::json!({ "phase": "starting", "text": "正在依你手機的要求安裝並登入 Claude Code", "cancellable": true }));
    let (tx, rx) = tokio::sync::oneshot::channel();
    let (h1, h2) = (handle.clone(), handle.clone());
    let started = agent_setup::setup::start_claude(
        relay.clone(),
        agent_setup_token_fn(&handle),
        move |e| wins::progress_emit(&h1, e.to_json()),
        move |d| {
            let _ = tx.send(d);
        },
    );
    if let Err(e) = started {
        relay.report_setup_result(false, &e, None).await;
        wins::close_setup_progress(&handle, round);
        return;
    }
    match rx.await {
        Ok(d) => {
            wins::progress_emit(&h2, d.to_json());
            let (ok, text, replaced) = d.report_fields();
            relay.report_setup_result(ok, &text, replaced.as_deref()).await;
        }
        Err(_) => {
            wins::progress_emit(&h2, serde_json::json!({ "phase": "done", "ok": false, "text": "安裝並登入中途中斷" }));
            relay.report_setup_result(false, "安裝並登入中途中斷", None).await
        }
    }
    // 結果留在畫面上幾秒讓人看到，再自己關
    tokio::time::sleep(std::time::Duration::from_secs(wins::PROG_DONE_SECS)).await;
    wins::close_setup_progress(&handle, round);
}

/// 本人在這台電腦上按「安裝並登入 Claude Code」。本人簽章不在這裡取好帶著走：安裝要好幾分鐘，權杖可能中途過期，
/// 所以建一個「取權杖的函式」交給流程，登入網址送出前才取（來源仍只有視窗程式的記憶體）。
/// 沒登入帳號就不開始（登入網址要靠本人簽章才送得到手機）；已經有一個在跑，直接回錯；
/// 進度與結果用事件 `agent-setup` 送給畫面，立刻回來。
#[cfg(feature = "gui")]
#[cfg(desktop)]
#[tauri::command]
async fn agent_setup_start(app: State<'_, App>, auth: State<'_, auth::AuthState>, handle: AppHandle, confirmed: bool) -> Result<(), String> {
    // 本機確認：畫面要先把 agent_setup_plan 的文字給本人看，本人按了才帶 confirmed = true。沒確認就不開始（不能只有按鈕沒有確認窗）
    if !confirmed {
        return Err("需要你先確認才能開始".to_string());
    }
    let relay = relay_of(&app)?;
    account::signing_token(&auth).await.filter(|t| !t.is_empty()).ok_or("請先登入你的帳號，才能把登入網址送到手機")?;
    let token = agent_setup_token_fn(&handle);
    // 已經有一輪在跑（可能是手機要求的）：直接回錯，不去動那一輪的小窗
    if agent_setup::setup::is_busy() {
        return Err("這台電腦正在安裝並登入，請等它做完".to_string());
    }
    // 人就在電腦前：右下角的進度小窗跟手機要求時是同一個（開不起來也沒關係，設備頁裡也看得到進度）
    let round = wins::open_setup_progress(&handle).map_err(|e| elog!("開進度小窗失敗：{e}")).ok();
    let (h1, h2) = (handle.clone(), handle.clone());
    let started = agent_setup::setup::start_claude(
        relay,
        token,
        move |e| wins::progress_emit(&h1, e.to_json()),
        move |r| {
            wins::progress_emit(&h2, r.to_json());
            // 結果留在畫面上幾秒再關（編號不是這一輪就不關）
            if let Some(round) = round {
                let h = h2.clone();
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_secs(wins::PROG_DONE_SECS));
                    wins::close_setup_progress(&h, round);
                });
            }
        },
    );
    if started.is_err() {
        if let Some(round) = round {
            wins::close_setup_progress(&handle, round);
        }
    }
    started
}

#[cfg(feature = "gui")]
#[cfg(desktop)]
#[tauri::command]
async fn partner_launch_local(app: State<'_, App>, req: launch::LocalLaunchReq) -> Result<Value, String> {
    launch::partner_launch_local(app.node.clone(), app.work_dir.clone(), app.data_dir.clone(), req).await
}

#[cfg(feature = "gui")]
#[cfg(desktop)]
#[tauri::command]
async fn launch_cwd_candidates(app: State<'_, App>) -> Result<Vec<String>, String> {
    launch::launch_cwd_candidates(app.data_dir.clone()).await
}

/// 「瀏覽…」：在 Rust 端開「選擇資料夾」對話框；選好的資料夾寫進本機白名單並回傳，取消回 null。
#[cfg(feature = "gui")]
#[cfg(desktop)]
#[tauri::command]
async fn launch_cwd_browse(app: State<'_, App>, handle: AppHandle) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    let start = identity::home_dir();
    let picked = tokio::task::spawn_blocking(move || {
        let mut b = handle.dialog().file().set_title("選擇工作資料夾");
        if start.is_dir() {
            b = b.set_directory(&start);
        }
        b.blocking_pick_folder().and_then(|f| f.into_path().ok())
    })
    .await
    .map_err(|e| format!("背景工作失敗：{e}"))?;
    match picked {
        Some(p) => Ok(Some(launch::launch_cwd_add(app.data_dir.clone(), p.to_string_lossy().into_owned()).await?)),
        None => Ok(None),
    }
}

/// 本機視窗的即時狀態（不經後台）：讀 ~/.claude/sessions 與外掛狀態檔，給名單上「這台電腦」的夥伴蓋過後台的舊值。
/// 只回名字、狀態、說明、上下文百分比；讀不到就回錯誤（前端照舊用後台的名單，不把讀失敗當成視窗都關了）。
#[cfg(feature = "gui")]
#[cfg(desktop)]
#[tauri::command]
async fn local_windows() -> Result<Value, String> {
    let home = identity::home_dir();
    let list = tokio::task::spawn_blocking(move || {
        bridge::roster::read_local_with(&home.join(".claude").join("sessions"), &home.join(".asn").join("status"), heartbeat::session_alive, 0, "", heartbeat::now_ms())
    })
    .await
    .map_err(|e| e.to_string())?
    // 讀不到要明說（回錯誤）：前端把「本機沒有這個視窗」當成已關閉，不能把讀失敗當成空清單
    .ok_or_else(|| "讀不到本機視窗清單".to_string())?;
    Ok(Value::Array(list.iter().map(|w| serde_json::json!({ "name": w.name, "status": w.status, "detail": w.detail, "context_pct": w.context_pct })).collect()))
}

#[cfg(feature = "gui")]
#[cfg(desktop)]
#[tauri::command]
async fn partner_console_query(req: launch::PartnerConsoleReq) -> Result<Value, String> {
    launch::partner_console_query(req).await
}

#[cfg(feature = "gui")]
#[cfg(desktop)]
#[tauri::command]
async fn partner_console_set(req: launch::PartnerConsoleReq) -> Result<Value, String> {
    launch::partner_console_set(req).await
}

#[cfg(feature = "gui")]
#[cfg(desktop)]
#[tauri::command]
async fn subagents_query(req: launch::SubagentsReq) -> Result<Value, String> {
    launch::subagents_query(req).await
}

#[cfg(feature = "gui")]
#[cfg(desktop)]
#[tauri::command]
async fn tasks_query(req: launch::TasksReq) -> Result<Value, String> {
    launch::tasks_query(req).await
}

#[cfg(feature = "gui")]
#[cfg(desktop)]
#[tauri::command]
async fn model_switch_query(req: launch::SwitchQueryReq) -> Result<Value, String> {
    launch::model_switch_query(req).await
}

#[cfg(feature = "gui")]
#[cfg(desktop)]
#[tauri::command]
async fn model_switch_run(req: launch::SwitchRunReq) -> Result<Value, String> {
    launch::model_switch_run(req).await
}

#[cfg(feature = "gui")]
#[cfg(desktop)]
#[tauri::command]
async fn launch_prefs_get(app: State<'_, App>) -> Result<Value, String> {
    launch::launch_prefs_get(app.data_dir.clone()).await
}

/// 讓使用者自己開的 pi 也能跟 ASN 互通（#240 方案 A）：查狀態、安裝、移除。安裝與移除要使用者在畫面上同意才會被呼叫
#[cfg(feature = "gui")]
#[cfg(desktop)]
#[tauri::command]
async fn pi_setup_status() -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(launch::pi_setup::status_real).await.map_err(|e| e.to_string())
}

/// 開新夥伴「經 pi」：pi 現在能列的模型（只含已設好憑證的提供者），以及各提供者有沒有登入（不讀憑證）
#[cfg(feature = "gui")]
#[cfg(desktop)]
#[tauri::command]
async fn pi_models(force: Option<bool>) -> Result<Vec<launch::pi_models::PiModel>, String> {
    let force = force == Some(true);
    tauri::async_runtime::spawn_blocking(move || launch::pi_models::models_real(force)).await.map_err(|e| e.to_string())
}

#[cfg(feature = "gui")]
#[cfg(desktop)]
#[tauri::command]
async fn pi_providers(force: Option<bool>) -> Result<Value, String> {
    let force = force == Some(true);
    tauri::async_runtime::spawn_blocking(move || launch::pi_models::providers_real(force)).await.map_err(|e| e.to_string())
}

#[cfg(feature = "gui")]
#[cfg(desktop)]
#[tauri::command]
async fn pi_setup_install() -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(launch::pi_setup::install_real).await.map_err(|e| e.to_string())?
}

#[cfg(feature = "gui")]
#[cfg(desktop)]
#[tauri::command]
async fn pi_setup_remove() -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(launch::pi_setup::remove_real).await.map_err(|e| e.to_string())?
}

/// 開一個 WezTerm 終端（只允許 agy 與 grok），回傳這次的編號。
#[cfg(feature = "gui")]
#[cfg(desktop)]
#[tauri::command]
async fn term_start(app: State<'_, App>, terms: State<'_, Arc<launch::term::LiveTerms>>, req: launch::term::TermStartReq) -> Result<launch::term::TermStarted, String> {
    let terms = terms.inner().clone();
    let data_dir = app.data_dir.clone();
    launch::blocking_timeout(move || launch::term::start_live(&terms, &req.profile, &req.cwd, &data_dir)).await
}

/// 使用者在 UI 確認後才把文字送進自己開的終端。這個命令本身證明不了有按確認。
/// UI 的確認必須是唯一入口；後端其他路徑不得呼叫。只收編號、文字、是否換行。
/// 工作資料夾沒有授權記錄就拒絕，不送字。enter 為真時，文字送出後再另外送一次 Enter。
#[cfg(feature = "gui")]
#[cfg(desktop)]
#[tauri::command]
async fn term_send(app: State<'_, App>, terms: State<'_, Arc<launch::term::LiveTerms>>, req: launch::term::TermSendReq) -> Result<(), String> {
    let terms = terms.inner().clone();
    let relay = relay_of(&app)?.clone();
    let data_dir = app.data_dir.clone();
    term_remote::local_confirm_send(relay.as_ref(), &terms, &data_dir, &req).await
}

/// 讀自己開的終端。lines 對應 `--start-line=-lines`：從畫面頂端再往上（捲動紀錄）lines 行起，一直讀到畫面底部；超過上限會被拒絕。
#[cfg(feature = "gui")]
#[cfg(desktop)]
#[tauri::command]
async fn term_read(terms: State<'_, Arc<launch::term::LiveTerms>>, req: launch::term::TermReadReq) -> Result<String, String> {
    let terms = terms.inner().clone();
    launch::blocking_timeout(move || terms.read(&req.id, req.lines)).await
}

/// 本人簽章的權杖（看別台畫面的發起與回報要用）
#[cfg(feature = "gui")]
#[cfg(desktop)]
async fn pair_token(auth: &auth::AuthState) -> Result<String, String> {
    account::signing_token(auth).await.filter(|t| !t.is_empty()).ok_or_else(|| "尚未登入".to_string())
}

/// 設定頁「認得的電腦」：名字、指紋、第一次記住的時間（只讀本機）
#[cfg(feature = "gui")]
#[cfg(desktop)]
#[tauri::command]
fn device_known_list(app: State<'_, App>) -> Result<Value, String> {
    device_id::live::view(&app.data_dir)
}

/// 本人在這台的設定頁按「忘記這台」：下次那台再連就當第一次（會再通知本人）。**只有這個本機命令能忘記**（守門測試）
#[cfg(feature = "gui")]
#[cfg(desktop)]
#[tauri::command]
fn device_known_forget(app: State<'_, App>, node: String) -> Result<bool, String> {
    device_id::live::forget(&app.data_dir, &node)
}

/// 本人在這台的設定頁勾「這台打字不用每次問我」（0.2.10）。**只有這個本機命令能改**（守門測試）；不送後台、不同步
#[cfg(feature = "gui")]
#[cfg(desktop)]
#[tauri::command]
fn device_known_input_no_ask(app: State<'_, App>, node: String, on: bool) -> Result<bool, String> {
    device_id::live::set_input_no_ask(&app.data_dir, &node, on)
}

/// 啟動時上傳這台的設備公鑰，別台才能看這台（別台第一次連就記住它）。失敗就隔 10 分鐘再試，成功就停
#[cfg(all(desktop, feature = "gui"))]
fn start_device_key_publish(relay: std::sync::Arc<Relay>, data_dir: std::path::PathBuf) {
    tauri::async_runtime::spawn(async move {
        loop {
            match device_id::live::publish(relay.as_ref(), &data_dir).await {
                Ok(()) => break,
                Err(e) => elog!("上傳設備公鑰失敗：{e}"),
            }
            tokio::time::sleep(std::time::Duration::from_secs(600)).await;
        }
    });
}

/// 別台正在看這台的觀看（#597）：編號 → （哪台、哪個夥伴、要不要停）
#[cfg(feature = "gui")]
#[cfg(desktop)]
#[derive(Default)]
struct BeingViewed {
    /// 觀看編號 → （誰、哪個視窗、本人按結束、是不是打字）
    open: std::sync::Mutex<std::collections::HashMap<String, (String, String, Arc<std::sync::atomic::AtomicBool>, bool)>>,
}

#[cfg(feature = "gui")]
#[cfg(desktop)]
impl BeingViewed {
    /// 通知畫面，並把視窗叫出來：「正在被看」不能被藏住
    fn publish(&self, app: &AppHandle) {
        let list: Vec<Value> = self.open.lock().unwrap_or_else(|e| e.into_inner()).iter().map(|(id, (who, win, _, input))| serde_json::json!({ "id": id, "who": who, "window": win, "input": input })).collect();
        let _ = app.emit("term-being-viewed", &list);
        if !list.is_empty() {
            if let Some(w) = app.get_webview_window("list") {
                let _ = w.unminimize();
                let _ = w.show();
            }
        }
    }
}

/// T 傳畫面時的外部動作。傳輸還沒接上（要動 bell.rs），送不出去，T 超過時限會自己停
#[cfg(feature = "gui")]
#[cfg(desktop)]
struct LiveTPort {
    app: AppHandle,
    relay: Arc<Relay>,
    terms: Arc<launch::term::LiveTerms>,
    data_dir: std::path::PathBuf,
    id: String,
    who: String,
    window: String,
    stop: Arc<std::sync::atomic::AtomicBool>,
    /// 送畫面的頻道（要回條）。丟掉它頻道就收掉；沒有即時頻道時是 None，一律送不出去
    out: Option<tokio::sync::mpsc::Sender<bell::Outbound>>,
    /// 打字（0.2.10）：頻道收到的字先放這裡排好順序；看畫面時是 None
    input: Option<Arc<std::sync::Mutex<view_input::TInput>>>,
    /// 這次一共交給窗格幾個字（只記數量，內容不記）
    typed: u64,
}

#[cfg(feature = "gui")]
#[cfg(desktop)]
impl view_stream::TPort for LiveTPort {
    fn window_ok(&mut self) -> bool {
        self.terms.partner_term_id(&self.window).and_then(|id| self.terms.view_meta(&id)).is_ok()
    }
    fn notify(&mut self) -> Result<(), String> {
        let v = tauri::async_runtime::block_on(self.relay.api("term_view_notice", Some(serde_json::json!({ "id": self.id }))))?;
        match v.get("notify").and_then(Value::as_str) {
            Some("sent") => Ok(()),
            _ => Err("通知沒有送出".into()),
        }
    }
    fn set_watching(&mut self, on: bool) {
        let views = self.app.state::<Arc<BeingViewed>>();
        {
            let mut open = views.open.lock().unwrap_or_else(|e| e.into_inner());
            if on {
                open.insert(self.id.clone(), (self.who.clone(), self.window.clone(), self.stop.clone(), self.input.is_some()));
            } else {
                open.remove(&self.id);
            }
        }
        views.publish(&self.app);
    }
    fn frame(&mut self) -> Result<view_stream::Frame, String> {
        let id = self.terms.partner_term_id(&self.window)?;
        let text = self.terms.view_text(&id)?;
        let m = self.terms.view_meta(&id)?;
        Ok(view_stream::Frame { text, cursor_x: m.cursor_x, cursor_y: m.cursor_y, cols: m.cols, rows: m.rows, ack: None })
    }
    fn ctl(&mut self) -> Result<view_stream::Ctl, String> {
        let v = tauri::async_runtime::block_on(self.relay.api("term_view_pending", Some(serde_json::json!({}))))?;
        let active = v.get("active").and_then(Value::as_array).ok_or("後台回的資料不對")?;
        Ok(view_stream::ctl_from_active(active, &self.id))
    }
    fn send(&mut self, wire: &str) -> Result<(), String> {
        let Some(tx) = &self.out else { return view_stream::NoTransport.send(wire) };
        tauri::async_runtime::block_on(bell::send_via(tx, "frame", serde_json::json!({ "w": wire })))
    }
    fn stop_requested(&mut self) -> bool {
        self.stop.load(std::sync::atomic::Ordering::SeqCst)
    }
    fn allowed(&mut self) -> bool {
        // 本人在這台關掉「允許其他設備替這台開新視窗」：進行中的觀看也要結束
        bridge::read_settings(&self.data_dir).allow_remote_launch
    }
    fn now_ms(&mut self) -> u64 {
        auth::now_ms()
    }
    fn sleep_ms(&mut self, ms: u64) {
        std::thread::sleep(std::time::Duration::from_millis(ms));
    }
    fn log(&mut self, line: &str) {
        // 寫到機器資料夾的 ui.log（和其他紀錄、設定頁「開啟記錄」同一份），不寫 data_dir（#961）
        let _ = ui_log::append(&self.app.state::<App>().work_dir, &[format!("{} info [ASN] {line}", claude_quota::iso_secs(auth::now_ms() as i64))]);
    }
    fn input(&mut self, now_ms: u64) -> Result<Option<u64>, view_stream::End> {
        let Some(inp) = self.input.clone() else { return Ok(None) };
        let taken = inp.lock().unwrap_or_else(|e| e.into_inner()).take(now_ms);
        let keys = match taken {
            Ok(k) => k,
            Err(e) => {
                let line = format!("view {}: input end {} typed={}", self.id, e.label(), self.typed);
                view_stream::TPort::log(self, &line);
                return Err(e.end());
            }
        };
        if !keys.is_empty() {
            // 本人在這台關掉「允許其他設備替這台開新視窗」：字不再交給窗格，馬上結束（不等下一次查控制面）
            if !bridge::read_settings(&self.data_dir).allow_remote_launch {
                let line = format!("view {}: input end not_allowed typed={}", self.id, self.typed);
                view_stream::TPort::log(self, &line);
                return Err(view_stream::End::NotAllowed);
            }
            // 和本機看畫面打字同一個入口：按鍵規則、貼上清理、接手的窗格不給、資料夾要有授權
            let pane = self.terms.partner_term_id(&self.window).map_err(|_| view_stream::End::Failed)?;
            for k in &keys {
                if self.terms.view_input(&pane, &k.d, k.p).is_err() {
                    let line = format!("view {}: input refused typed={}", self.id, self.typed);
                    view_stream::TPort::log(self, &line);
                    return Err(view_stream::End::InputStopped);
                }
                self.typed += k.d.chars().count() as u64;
            }
        }
        let applied = inp.lock().unwrap_or_else(|e| e.into_inner()).applied();
        Ok(Some(applied))
    }
}

/// 別台要看這台：有人可以看這台才查。全部驗過才接受，否則拒絕。Hello 接上之前一律拒絕
#[cfg(all(desktop, feature = "gui"))]
fn start_view_poller(app: AppHandle, relay: Arc<Relay>, terms: Arc<launch::term::LiveTerms>, data_dir: std::path::PathBuf, me_node: String) {
    // 這台還不能被看（Linux：設備私鑰還沒有系統金鑰庫保護）就不查別台的觀看請求
    if !device_id::can_be_viewed_here(&data_dir) {
        return;
    }
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(std::time::Duration::from_secs(10)).await;
            // 放行條件：本機的「允許其他設備替這台開新視窗」開著（兩台是同一個本人，由後台擋）
            if !bridge::read_settings(&data_dir).allow_remote_launch {
                continue;
            }
            let Ok(known) = device_id::live::known(&data_dir) else { continue };
            let Ok(v) = relay.api("term_view_pending", Some(serde_json::json!({}))).await else { continue };
            let Ok(key) = device_id::live::key_async(&data_dir).await else { continue };
            for row in v.get("requests").and_then(Value::as_array).cloned().unwrap_or_default() {
                let Some(id) = row.get("id").and_then(Value::as_str).map(str::to_string) else { continue };
                let now_s = (auth::now_ms() / 1000) as i64;
                // 同一筆只能接受一次：驗章前先查，驗過、回覆接受前先記下；記不下來就拒絕（見 view_seen）
                // D 的設備公鑰先和本機記住的比（TOFU）：換了就拒絕並通知本人；第一次看到的驗章通過才記住，並通知本人（只有 T 寄）
                let verified = match view_seen::check_unseen(&data_dir, &id, now_s) {
                    Err(e) => Err(e),
                    Ok(()) => match view_stream::accept_request(&row, &me_node, &known, &key, now_s) {
                        Err(view_stream::Refused::KeyChanged { node, sign_pub }) => {
                            device_id::live::alert(&relay, &node, "changed", &sign_pub).await;
                            Err(device_id::KEY_CHANGED.to_string())
                        }
                        Err(view_stream::Refused::Bad(e)) => Err(e),
                        Ok(a) => view_seen::record(&data_dir, &id, a.session.expires_s, now_s).map(|()| a),
                    },
                };
                match verified {
                    Err(_) => {
                        let _ = relay.api("term_view_stop", Some(serde_json::json!({ "id": id, "reason": "rejected" }))).await;
                    }
                    Ok(a) => {
                        if a.tofu == device_id::Tofu::New {
                            if device_id::live::see(&data_dir, &a.session.d_node, &a.from_name, &a.from_pub, auth::now_ms()).is_err() {
                                let _ = relay.api("term_view_stop", Some(serde_json::json!({ "id": id, "reason": "rejected" }))).await;
                                continue;
                            }
                            device_id::live::alert(&relay, &a.session.d_node, "first", &a.from_pub).await;
                        }
                        // 框上和紅條上的「誰」都用本機記住的名字＋指紋前 8 碼（後台給的名字不在簽章裡）；第一次連線才用後台的並標示
                        let asker = input_consent::who_of(&known, &a.session.d_node, &a.from_name, &a.from_pub, a.tofu);
                        let who = input_consent::bar_label(&asker);
                        // 打字（0.2.10）：預設每次都要本人在這台的 ASN 視窗按允許；本人在設定頁對那台設過「不用每次問」才不問
                        if a.session.scope == view_handshake::Scope::Input {
                            let no_ask = device_id::live::known(&data_dir).map(|k| k.input_no_ask(&a.session.d_node)).unwrap_or(false);
                            if !no_ask && !input_consent::ask(&app, &asker, &a.session.window).await {
                                let _ = relay.api("term_view_stop", Some(serde_json::json!({ "id": id, "reason": "rejected" }))).await;
                                continue;
                            }
                        }
                        let view_stream::Accepted { session, t_eph, t_sig, key: session_key, .. } = a;
                        let input = match session.scope {
                            view_handshake::Scope::View => None,
                            view_handshake::Scope::Input => match view_input::input_key(&session_key) {
                                Ok(k) => Some(Arc::new(std::sync::Mutex::new(view_input::TInput::new(k, &id, auth::now_ms())))),
                                Err(_) => {
                                    let _ = relay.api("term_view_stop", Some(serde_json::json!({ "id": id, "reason": "failed" }))).await;
                                    continue;
                                }
                            },
                        };
                        if relay.api("term_view_accept", Some(serde_json::json!({ "id": id, "t_eph_pub": t_eph, "t_sig": t_sig }))).await.is_err() {
                            continue;
                        }
                        let stop = Arc::new(std::sync::atomic::AtomicBool::new(false));
                        // 送畫面的頻道，每幅等伺服器回條；這次觀看結束、port 丟掉時一起收掉。
                        // 看畫面：只送不收（收到的一律丟掉）。打字：另外只收 event=input 的字，排進 TInput（解密、排序、上限都在那裡）
                        let out = match (app.state::<ViewNet>().0.clone(), row.get("topic").and_then(Value::as_str)) {
                            (Some(url), Some(topic)) => {
                                let (tx, rx) = tokio::sync::mpsc::channel(4);
                                let inbox = input.clone();
                                tauri::async_runtime::spawn(bell::run_channel(url, topic.to_string(), true, Some(rx), std::future::pending::<()>(), move |e| {
                                    let (Some(inbox), bell::Event::Broadcast { event, payload }) = (&inbox, e) else { return };
                                    if let Some(w) = view_input::wire_of(event, payload) {
                                        inbox.lock().unwrap_or_else(|e| e.into_inner()).push(&w, auth::now_ms());
                                    }
                                }));
                                Some(tx)
                            }
                            _ => None,
                        };
                        let mut port = LiveTPort { app: app.clone(), relay: relay.clone(), terms: terms.clone(), data_dir: data_dir.clone(), id: id.clone(), who, window: session.window.clone(), stop, out, input, typed: 0 };
                        let relay2 = relay.clone();
                        std::thread::spawn(move || {
                            let end = view_stream::run_t(&session, session_key, &mut port);
                            if let Some(reason) = end.reason() {
                                let _ = tauri::async_runtime::block_on(relay2.api("term_view_stop", Some(serde_json::json!({ "id": id, "reason": reason }))));
                            }
                        });
                    }
                }
            }
        }
    });
}

/// 本人在被看的這台按「結束」
#[cfg(feature = "gui")]
#[cfg(desktop)]
#[tauri::command]
fn term_viewed_stop(views: State<'_, Arc<BeingViewed>>, id: String) {
    if let Some((_, _, stop, _)) = views.open.lock().unwrap_or_else(|e| e.into_inner()).get(&id) {
        stop.store(true, std::sync::atomic::Ordering::SeqCst);
    }
}

/// 別台看畫面用的即時頻道網址（含 anon 金鑰，只在 Rust）。沒有 anon 金鑰就沒有，看畫面也不能用
#[cfg(desktop)]
struct ViewNet(Option<String>);

/// 這台能不能看那台的畫面：已配對而且我可以看對方、有即時頻道。不跳提示
#[cfg(feature = "gui")]
#[cfg(desktop)]
#[tauri::command]
async fn term_view_remote_available(app: State<'_, App>, net: State<'_, ViewNet>, node: String) -> Result<bool, String> {
    // 這台能不能發起：連得上即時頻道、不是這台、這台的設備金鑰有系統保護。兩台是不是同一個本人由後台擋，那台允不允許由那台決定
    Ok(net.0.is_some() && node != app.node && device_id::can_be_viewed_here(&app.data_dir))
}

/// 本人按「終端」：直接用設備金鑰簽、向後台發起。**不跳本人確認**（11-08 小良哥決定拿掉 Windows Hello 與確認框，守門測試在 presence）；
/// 被看的那台照舊：打字要那邊的人允許，有紅條、通知信。
/// 後台回那台的設備公鑰：和本機記住的不同就不開始並通知本人。回（觀看編號, 到期時間秒）
#[cfg(feature = "gui")]
#[cfg(desktop)]
#[tauri::command]
#[allow(clippy::too_many_arguments)]
async fn term_view_remote_start(window: tauri::WebviewWindow, app: State<'_, App>, auth: State<'_, auth::AuthState>, views: State<'_, Arc<view_remote::RemoteViews>>, inputs: State<'_, Arc<RemoteInputs>>, net: State<'_, ViewNet>, to_node: String, partner: String, machine: Option<String>, scope: Option<String>) -> Result<Value, String> {
    let url = net.0.clone().ok_or("這台現在連不上即時頻道，不能看畫面")?;
    if !device_id::can_be_viewed_here(&app.data_dir) {
        return Err(device_id::NOT_VIEWABLE_HERE.into());
    }
    let machine: String = machine.unwrap_or_default().chars().filter(|c| !c.is_control()).take(64).collect();
    // 看畫面或打字（0.2.10）。沒帶是看畫面；其他字一律不收
    let scope = match scope.as_deref() {
        None => view_handshake::Scope::View,
        Some(x) => view_handshake::Scope::parse(x).ok_or("不認得的範圍")?,
    };
    if scope == view_handshake::Scope::Input && inputs.count() >= view_input::MAX_OPEN {
        return Err(view_input::TOO_MANY.into());
    }
    let token = pair_token(&auth).await?;
    let key = device_id::live::key_async(&app.data_dir).await?;
    let id = view_remote::new_session_id()?;
    let now_s = (auth::now_ms() / 1000) as i64;
    let s = view_remote::session(&id, &app.node, &to_node, &partner, scope, now_s);
    views.add(&id)?;
    let (eph, d_sig) = match view_handshake::d_start(&key, &s, now_s) {
        Ok(v) => v,
        Err(e) => {
            views.remove(&id);
            return Err(e);
        }
    };
    let relay = relay_of(&app)?;
    let body = serde_json::json!({ "id": id, "to_node": to_node, "window_name": partner, "d_eph_pub": eph.public_b64(), "d_sig": d_sig, "expires_at": claude_quota::iso_secs(s.expires_s * 1000), "scope": scope.as_str() });
    let started = relay.api_signed("term_view_start", Some(body), Some(&token)).await.ok();
    let field = |k: &str| started.as_ref().and_then(|v| v.get(k).and_then(Value::as_str).map(str::to_string));
    let (Some(topic), Some(to_pub)) = (field("topic"), field("to_pub")) else {
        views.remove(&id);
        return Err("沒有發起成功，請稍後再試".into());
    };
    // 那台的設備公鑰先和本機記住的比（TOFU）：換了就不開始、通知本人（兩邊都寄 changed）
    let tofu = match device_id::live::known(&app.data_dir) {
        Ok(k) => k.check(&to_node, &to_pub),
        Err(e) => {
            views.remove(&id);
            let _ = relay.api_signed("term_view_report", Some(serde_json::json!({ "id": id, "state": "ended" })), Some(&token)).await;
            return Err(e);
        }
    };
    if tofu == device_id::Tofu::Changed {
        views.remove(&id);
        let _ = relay.api_signed("term_view_report", Some(serde_json::json!({ "id": id, "state": "ended" })), Some(&token)).await;
        device_id::live::alert(&relay, &to_node, "changed", &to_pub).await;
        return Err(view_remote::TARGET_KEY_CHANGED.into());
    }
    let target = RemoteTarget { node: to_node, name: machine, sign_pub: to_pub, tofu };
    start_remote_view(window.app_handle().clone(), window.label().to_string(), relay, app.data_dir.clone(), views.inner().clone(), inputs.inner().clone(), url, topic, s.clone(), eph, target);
    Ok(serde_json::json!({ "id": id, "expires_s": s.expires_s, "scope": scope.as_str() }))
}

/// 本人在打字的畫面上打的字（0.2.10）：只有這個入口。字先過按鍵規則，編序號、加密，送到那台；那台確認之前會補送。
/// 視窗要在前景、要是開著的打字工作階段；太快、太多回錯（字沒有收，畫面要告訴本人）
#[cfg(feature = "gui")]
#[cfg(desktop)]
#[tauri::command]
async fn term_view_remote_input(window: tauri::WebviewWindow, inputs: State<'_, Arc<RemoteInputs>>, id: String, data: String, paste: Option<bool>) -> Result<(), String> {
    if !window.is_focused().unwrap_or(false) {
        return Err("視窗不在前景，不送".into());
    }
    launch::term_view::check_input(&data)?;
    let (ob, tx) = inputs.get(&id).ok_or("這個畫面現在不能打字")?;
    let wires = ob.lock().unwrap_or_else(|e| e.into_inner()).push(&data, paste.unwrap_or(false), auth::now_ms())?;
    for w in wires {
        // 送不出去不用回錯：那台沒確認就會補送，太久沒確認會停下來告訴本人
        let _ = bell::send_via(&tx, view_input::EVENT, serde_json::json!({ "w": w })).await;
    }
    Ok(())
}

/// 進行中的打字（看的那台）：觀看編號 → 送出端。只在本機
#[cfg(all(desktop, feature = "gui"))]
#[derive(Default)]
struct RemoteInputs {
    open: std::sync::Mutex<std::collections::HashMap<String, (Arc<std::sync::Mutex<view_input::DOutbox>>, tokio::sync::mpsc::Sender<bell::Outbound>, bool)>>,
}

#[cfg(all(desktop, feature = "gui"))]
impl RemoteInputs {
    fn add(&self, id: &str, ob: Arc<std::sync::Mutex<view_input::DOutbox>>, tx: tokio::sync::mpsc::Sender<bell::Outbound>) {
        self.open.lock().unwrap_or_else(|e| e.into_inner()).insert(id.to_string(), (ob, tx, false));
    }
    fn get(&self, id: &str) -> Option<(Arc<std::sync::Mutex<view_input::DOutbox>>, tokio::sync::mpsc::Sender<bell::Outbound>)> {
        self.open.lock().unwrap_or_else(|e| e.into_inner()).get(id).filter(|v| !v.2).map(|v| (v.0.clone(), v.1.clone()))
    }
    fn count(&self) -> usize {
        self.open.lock().unwrap_or_else(|e| e.into_inner()).len()
    }
    /// 網路不穩：不再收字
    fn stall(&self, id: &str) {
        if let Some(v) = self.open.lock().unwrap_or_else(|e| e.into_inner()).get_mut(id) {
            v.2 = true;
        }
    }
    /// 收掉。回是不是因為網路不穩停的
    fn remove(&self, id: &str) -> bool {
        self.open.lock().unwrap_or_else(|e| e.into_inner()).remove(id).is_some_and(|v| v.2)
    }
}

/// 打字的補送：每 300 毫秒看一次，那台沒確認的再送；最舊的一幅 5 秒還沒確認就停下（不跳過缺的字），結束這次打字
#[cfg(all(desktop, feature = "gui"))]
fn spawn_input_resend(app: AppHandle, label: String, views: Arc<view_remote::RemoteViews>, inputs: Arc<RemoteInputs>, id: String) {
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(std::time::Duration::from_millis(300)).await;
            let Some((ob, tx)) = inputs.get(&id) else { break };
            if views.want(&id) == view_remote::Want::Ended {
                break;
            }
            let now = auth::now_ms();
            let (again, stalled) = {
                let mut g = ob.lock().unwrap_or_else(|e| e.into_inner());
                (g.resend(now), g.stalled(now))
            };
            if stalled {
                inputs.stall(&id);
                views.set(&id, view_remote::Want::Ended);
                let _ = app.emit_to(label.as_str(), "term-view-remote-input-stalled", serde_json::json!({ "id": id }));
                break;
            }
            for w in again {
                let _ = bell::send_via(&tx, view_input::EVENT, serde_json::json!({ "w": w })).await;
            }
        }
    });
}

/// 看的那台要看的那台：節點、名字、設備公鑰，和本機記住的比過的結果
#[cfg(all(desktop, feature = "gui"))]
struct RemoteTarget {
    node: String,
    name: String,
    sign_pub: String,
    tofu: device_id::Tofu,
}

/// 本人把觀看畫面藏起來（暫停）或叫出來（繼續）
#[cfg(feature = "gui")]
#[cfg(desktop)]
#[tauri::command]
fn term_view_remote_set(views: State<'_, Arc<view_remote::RemoteViews>>, id: String, paused: bool) {
    views.set(&id, if paused { view_remote::Want::Paused } else { view_remote::Want::Watching });
}

/// 本人按「結束」
#[cfg(feature = "gui")]
#[cfg(desktop)]
#[tauri::command]
fn term_view_remote_stop(views: State<'_, Arc<view_remote::RemoteViews>>, id: String) {
    views.set(&id, view_remote::Want::Ended);
}

/// 看的那台的背景：每 15 秒回報一次（不簽章、不確認本人）；拿到對方的公鑰就導出金鑰、開接收頻道；結束就收掉、告訴畫面。
/// 接收頻道只收不送，收到的畫面經 view_remote::receive（解密、擋重放、再過濾）才交給畫面
#[cfg(all(desktop, feature = "gui"))]
#[allow(clippy::too_many_arguments)]
fn start_remote_view(app: AppHandle, label: String, relay: Arc<Relay>, data_dir: std::path::PathBuf, views: Arc<view_remote::RemoteViews>, inputs: Arc<RemoteInputs>, url: String, topic: String, s: view_handshake::Session, eph: view_handshake::Eph, target: RemoteTarget) {
    tauri::async_runtime::spawn(async move {
        let id = s.id.clone();
        let mut eph = Some(eph);
        let mut stop_rx: Option<tokio::sync::oneshot::Sender<()>> = None;
        let frames_seen = Arc::new(std::sync::atomic::AtomicU64::new(0));
        let mut failed_since: Option<u64> = None;
        let began_ms = auth::now_ms();
        let reason = loop {
            let want = views.want(&id);
            let token = pair_token(app.state::<auth::AuthState>().inner()).await;
            let rep = match &token {
                Ok(t) => relay.api_signed("term_view_report", Some(serde_json::json!({ "id": id, "state": want.report_state() })), Some(t)).await,
                Err(e) => Err(e.clone()),
            };
            if want == view_remote::Want::Ended {
                break "viewer_ended".to_string();
            }
            let now_ms = auth::now_ms();
            match rep {
                Ok(v) => {
                    failed_since = None;
                    match view_remote::step_of(&v) {
                        view_remote::Step::Ended(r) => break r,
                        view_remote::Step::Accepted { t_eph, t_sig } if eph.is_some() => {
                            let Some(e) = eph.take() else { break "failed".to_string() };
                            // 打字：同一次握手另外導出送字的金鑰（只有打字的工作階段才有送出端）
                            let (mut rx, outbox) = match s.scope {
                                view_handshake::Scope::View => match view_remote::finish(&target.sign_pub, e, &s, &t_eph, &t_sig, (now_ms / 1000) as i64) {
                                    Ok(rx) => (rx, None),
                                    Err(_) => break "rejected".to_string(),
                                },
                                view_handshake::Scope::Input => match view_input::d_finish(&target.sign_pub, e, &s, &t_eph, &t_sig, (now_ms / 1000) as i64) {
                                    Ok((rx, ob)) => (rx, Some(Arc::new(std::sync::Mutex::new(ob)))),
                                    Err(_) => break "rejected".to_string(),
                                },
                            };
                            // 第一次看到這台：T 的簽章驗過才記住（first 通知只有 T 寄）；記不住就不看
                            if target.tofu == device_id::Tofu::New && !matches!(device_id::live::see(&data_dir, &target.node, &target.name, &target.sign_pub, now_ms), Ok(device_id::Tofu::New | device_id::Tofu::Same)) {
                                break "failed".to_string();
                            }
                            let (tx, stop) = tokio::sync::oneshot::channel::<()>();
                            stop_rx = Some(tx);
                            // 打字才有送出端（要回條）；看畫面只收不送
                            let send = outbox.as_ref().map(|ob| {
                                let (otx, orx) = tokio::sync::mpsc::channel::<bell::Outbound>(16);
                                inputs.add(&id, ob.clone(), otx);
                                spawn_input_resend(app.clone(), label.clone(), views.clone(), inputs.clone(), id.clone());
                                orx
                            });
                            let ack_to = outbox.clone();
                            let (app2, label2, views2, id2, seen) = (app.clone(), label.clone(), views.clone(), id.clone(), frames_seen.clone());
                            tauri::async_runtime::spawn(bell::run_channel(url.clone(), topic.clone(), send.is_some(), send, async move { let _ = stop.await; }, move |e| {
                                let bell::Event::Broadcast { event, payload } = e else { return };
                                let Some(w) = view_remote::frame_wire(event, payload) else { return };
                                match view_remote::receive(&mut rx, &w) {
                                    view_remote::Show::Frame(f) => {
                                        seen.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                                        // 打字：那台已經交給窗格到第幾號，之前的不用再補送
                                        if let (Some(ob), Some(a)) = (&ack_to, f.ack) {
                                            ob.lock().unwrap_or_else(|e| e.into_inner()).ack(a);
                                        }
                                        if views2.want(&id2) == view_remote::Want::Watching {
                                            let _ = app2.emit_to(label2.as_str(), "term-view-remote-frame", serde_json::json!({ "id": id2, "text": f.text, "meta": { "cursor_x": f.cursor_x, "cursor_y": f.cursor_y, "cols": f.cols, "rows": f.rows } }));
                                        }
                                    }
                                    view_remote::Show::Skip => {}
                                    view_remote::Show::End => views2.set(&id2, view_remote::Want::Ended),
                                }
                            }));
                        }
                        _ => {}
                    }
                }
                Err(_) => {
                    let since = *failed_since.get_or_insert(now_ms);
                    if now_ms.saturating_sub(since) > view_stream::LOST_AFTER_MS {
                        break "failed".to_string();
                    }
                }
            }
            if (now_ms / 1000) as i64 >= s.expires_s {
                break "expired".to_string();
            }
            // 等下一次回報；本人按結束或藏起來時早一點回報
            let before = views.want(&id);
            // 對方還沒接受時每秒回報一次：越早拿到公鑰、開始收，越不會漏掉對方先送的畫面
            let wait_s = view_remote::report_wait_s(eph.is_none(), auth::now_ms().saturating_sub(began_ms) / 1000);
            for _ in 0..wait_s {
                tokio::time::sleep(std::time::Duration::from_secs(1)).await;
                if views.want(&id) != before {
                    break;
                }
            }
        };
        if reason != "viewer_ended" {
            // 對方先結束、到期或出錯：照樣告訴後台這邊結束了（失敗也沒關係，後台到期會清）
            if let Ok(t) = pair_token(app.state::<auth::AuthState>().inner()).await {
                let _ = relay.api_signed("term_view_report", Some(serde_json::json!({ "id": id, "state": "ended" })), Some(&t)).await;
            }
        }
        drop(stop_rx.take());
        let frames = frames_seen.load(std::sync::atomic::Ordering::Relaxed);
        views.remove(&id);
        // 打字的送出端停掉時是網路不穩：最後幾個字可能沒送到，要說清楚
        let reason = if inputs.remove(&id) { "input_stalled".to_string() } else { reason };
        let _ = app.emit_to(label.as_str(), "term-view-remote-end", serde_json::json!({ "id": id, "text": view_remote::end_text(&reason) }));
        let _ = ui_log::append(&app.state::<App>().work_dir, &[format!("{} info [ASN] remote-view end reason={reason} frames={frames}", claude_quota::iso_secs(auth::now_ms() as i64))]);
    });
}

/// 開著的觀看（#597）：編號 → 狀態。全部只在本機
#[cfg(feature = "gui")]
#[cfg(desktop)]
#[derive(Default)]
struct TermViews {
    next: std::sync::atomic::AtomicU64,
    open: std::sync::Mutex<std::collections::HashMap<u64, (String, String, Arc<launch::term_view::ViewState>)>>,
}

#[cfg(feature = "gui")]
#[cfg(desktop)]
struct WindowViewPort {
    app: AppHandle,
    label: String,
    id: String,
    terms: Arc<launch::term::LiveTerms>,
}

#[cfg(feature = "gui")]
#[cfg(desktop)]
impl launch::term_view::ViewPort for WindowViewPort {
    fn text(&mut self) -> Result<String, String> {
        self.terms.view_text(&self.id)
    }
    fn meta(&mut self) -> Result<launch::term_view::ViewMeta, String> {
        self.terms.view_meta(&self.id)
    }
    fn visible(&mut self) -> Option<bool> {
        let w = self.app.get_webview_window(&self.label)?;
        Some(w.is_visible().unwrap_or(true) && !w.is_minimized().unwrap_or(false))
    }
    fn emit(&mut self, frame: launch::term_view::ViewFrame) -> bool {
        self.app.emit_to(self.label.as_str(), "term-view-frame", frame).is_ok()
    }
    fn now_ms(&mut self) -> u64 {
        auth::now_ms()
    }
    fn sleep(&mut self, d: std::time::Duration) {
        std::thread::sleep(d);
    }
}

/// 開始看一個窗格（#597）：畫面送到開它的視窗，不經過後台。同一個視窗同一個窗格只留一個。回觀看編號
#[cfg(feature = "gui")]
#[cfg(desktop)]
#[tauri::command]
async fn term_view_open(window: tauri::WebviewWindow, views: State<'_, Arc<TermViews>>, terms: State<'_, Arc<launch::term::LiveTerms>>, id: Option<String>, name: Option<String>) -> Result<u64, String> {
    use std::sync::atomic::Ordering;
    let label = window.label().to_string();
    // 給編號（自己開的終端）或夥伴名字（Claude 視窗）。開之前先確認窗格認得，錯誤馬上回給畫面
    let id = {
        let terms = terms.inner().clone();
        launch::blocking_timeout(move || {
            let id = match (id, name) {
                (Some(id), None) => id,
                (None, Some(name)) => terms.partner_term_id(&name)?,
                _ => return Err("要指定一個窗格".to_string()),
            };
            terms.view_meta(&id)?;
            Ok(id)
        })
        .await?
    };
    let state = Arc::new(launch::term_view::ViewState::default());
    let view_id = views.next.fetch_add(1, Ordering::SeqCst) + 1;
    {
        let mut open = views.open.lock().unwrap_or_else(|e| e.into_inner());
        open.retain(|_, (l, i, st)| {
            let same = *l == label && *i == id;
            if same {
                st.stop.store(true, Ordering::SeqCst);
            }
            !same
        });
        open.insert(view_id, (label.clone(), id.clone(), state.clone()));
    }
    let app = window.app_handle().clone();
    let (terms, views) = (terms.inner().clone(), views.inner().clone());
    // 打字（#597 D）：一支專門送字的執行緒，一次一支、積壓合併。送不出去（窗格換了、授權沒了）就停下，並告訴畫面沒送出幾位元組
    {
        let (st, terms, app, label, id) = (state.clone(), terms.clone(), app.clone(), label.clone(), id.clone());
        std::thread::Builder::new()
            .name("asn-term-input".into())
            .spawn(move || {
                while !st.stop.load(Ordering::SeqCst) {
                    let Some((paste, text)) = st.input.next_batch(launch::term_view::INPUT_CHUNK_BYTES, std::time::Duration::from_millis(200)) else { continue };
                    match terms.view_input(&id, &text, paste) {
                        Ok(()) => {
                            st.sent_chars.fetch_add(text.chars().count() as u64, Ordering::SeqCst);
                        }
                        Err(e) => {
                            let lost = st.input.close() + text.len();
                            let _ = app.emit_to(label.as_str(), "term-view-input-error", serde_json::json!({ "view_id": view_id, "message": e, "lost_bytes": lost }));
                            break;
                        }
                    }
                }
                let n = st.sent_chars.load(Ordering::SeqCst);
                if n > 0 {
                    elog!("終端畫面輸入結束：共 {n} 字（內容不記）");
                }
                // 打字紀錄（#956）：結束時把還沒寫的寫出
                let now = auth::now_ms();
                if let Some(line) = st.tally.lock().unwrap_or_else(|e| e.into_inner()).take(now) {
                    let _ = ui_log::append(&app.state::<App>().work_dir, &[format!("{} info [ASN] {line}", claude_quota::iso_secs(now as i64))]);
                }
            })
            .map_err(|e| e.to_string())?;
    }
    std::thread::Builder::new()
        .name("asn-term-view".into())
        .spawn(move || {
            let mut port = WindowViewPort { app: app.clone(), label: label.clone(), id, terms };
            let reason = launch::term_view::run_view(view_id, &state, &mut port);
            state.input.close();
            state.stop.store(true, Ordering::SeqCst);
            views.open.lock().unwrap_or_else(|e| e.into_inner()).remove(&view_id);
            if let Some(r) = reason {
                let _ = app.emit_to(label.as_str(), "term-view-closed", serde_json::json!({ "view_id": view_id, "reason": r }));
            }
        })
        .map_err(|e| e.to_string())?;
    Ok(view_id)
}

/// 這位夥伴的終端畫面是不是開著、而且看得到（視窗沒有隱藏或縮小）。開著時本機的同意框先不跳，
/// 本人直接在畫面按鍵回答，兩邊不搶按鍵。查不到一律回 false，照原本的方式跳框
#[cfg(feature = "gui")]
#[cfg(desktop)]
#[tauri::command]
async fn term_view_active(app: AppHandle, views: State<'_, Arc<TermViews>>, terms: State<'_, Arc<launch::term::LiveTerms>>, name: String) -> Result<bool, String> {
    let terms = terms.inner().clone();
    let Ok(id) = launch::blocking_timeout(move || terms.partner_term_id(&name)).await else { return Ok(false) };
    let labels: Vec<String> = views.open.lock().unwrap_or_else(|e| e.into_inner()).values().filter(|(_, i, _)| *i == id).map(|(l, _, _)| l.clone()).collect();
    Ok(labels.iter().any(|l| app.get_webview_window(l).is_some_and(|w| w.is_visible().unwrap_or(false) && !w.is_minimized().unwrap_or(true))))
}

/// 這位夥伴在不在共用終端服務裡（#900）：在才能在 ASN 裡看它的終端（聊天頁第 2 格放「終端」）；
/// 更新前開的夥伴回 false（畫面改放前台／後台並請本人重新開一次）。只讀對照表，不讀畫面
#[cfg(feature = "gui")]
#[cfg(desktop)]
#[tauri::command]
fn term_view_available(terms: State<'_, Arc<launch::term::LiveTerms>>, name: String) -> bool {
    terms.partner_in_service(&name)
}

/// 停止看
#[cfg(feature = "gui")]
#[cfg(desktop)]
#[tauri::command]
fn term_view_close(views: State<'_, Arc<TermViews>>, view_id: u64) {
    if let Some((_, _, st)) = views.open.lock().unwrap_or_else(|e| e.into_inner()).remove(&view_id) {
        st.stop.store(true, std::sync::atomic::Ordering::SeqCst);
        st.input.close();
    }
}

/// 在畫面裡打字（#597 D）：只有開著的畫面、而且是開它的那個視窗、而且視窗在前景才收；字先過 `check_input`，
/// 排進佇列由送字的執行緒一次一支送出（積壓太多回錯，不丟字）。`paste` 為真＝貼上（讓終端依程式的模式處理）。
/// 只有這個 Tauri 命令一個入口：不接後台、不接 CLI，沒有任何 relay 動作碰得到（守門測試）
#[cfg(feature = "gui")]
#[cfg(desktop)]
#[tauri::command]
fn term_view_input(window: tauri::WebviewWindow, app: State<'_, App>, views: State<'_, Arc<TermViews>>, view_id: u64, data: String, paste: Option<bool>, ime: Option<bool>) -> Result<(), String> {
    let label = window.label().to_string();
    let state = {
        let open = views.open.lock().unwrap_or_else(|e| e.into_inner());
        match open.get(&view_id) {
            Some((l, _, st)) if *l == label => st.clone(),
            _ => return Err("這個畫面沒有開著，不送".into()),
        }
    };
    if !window.is_focused().unwrap_or(false) {
        return Err("視窗不在前景，不送".into());
    }
    launch::term_view::check_input(&data)?;
    state.input.push(&data, paste.unwrap_or(false))?;
    let now = auth::now_ms();
    state.last_input_ms.store(now, std::sync::atomic::Ordering::SeqCst);
    // 打字紀錄（#956）：只記數量，不記內容
    let line = state.tally.lock().unwrap_or_else(|e| e.into_inner()).add(now, data.chars().count(), paste.unwrap_or(false), ime.unwrap_or(false));
    if let Some(line) = line {
        let _ = ui_log::append(&app.work_dir, &[format!("{} info [ASN] {line}", claude_quota::iso_secs(now as i64))]);
    }
    Ok(())
}

/// 讀一次歷史（B3）：人往上捲時，畫面才向後端要一次往上 `lines`（預設 200，夾在 1..=500）行的捲動紀錄，
/// 連同同一時刻的游標與大小。只有開著的畫面、而且是開它的那個視窗才行；文字過 `filter_frame`、超過 1 MiB 只留最後的整行。
/// 一次性呼叫，不碰每幅輪詢的狀態；只讀，不送任何字到窗格
#[cfg(feature = "gui")]
#[cfg(desktop)]
#[tauri::command]
async fn term_view_history(window: tauri::WebviewWindow, views: State<'_, Arc<TermViews>>, terms: State<'_, Arc<launch::term::LiveTerms>>, view_id: u64, lines: Option<u32>) -> Result<launch::term_view::ViewHistory, String> {
    let label = window.label().to_string();
    let id = {
        let open = views.open.lock().unwrap_or_else(|e| e.into_inner());
        launch::term_view::view_pane_for_window(&open, view_id, &label)?
    };
    let lines = launch::term_view::clamp_history_lines(lines);
    let terms = terms.inner().clone();
    launch::blocking_timeout(move || {
        let (raw, meta) = terms.view_history(&id, lines)?;
        Ok(launch::term_view::finish_history(&raw, lines, meta))
    })
    .await
}

/// 重開自動接回的結果（#767）：已接回幾位、接不回來的名字與原因，不含對話內容，只給本機畫面
#[cfg(feature = "gui")]
#[cfg(desktop)]
#[tauri::command]
fn auto_resume_status(app: State<'_, App>) -> serde_json::Value {
    launch::auto_resume::read_status(&app.data_dir)
}

/// 夥伴卡住的本機提醒：只有視窗名與固定代號（todo-next-162），只給本機畫面
#[cfg(feature = "gui")]
#[cfg(desktop)]
#[tauri::command]
fn partner_notices() -> Vec<launch::term::PartnerNotice> {
    launch::term::partner_notices()
}

/// 讀畫面這次實際有沒有在跑（給逾時後決定要不要切前台）；非 Windows 沒設環境變數就是沒跑
#[cfg(feature = "gui")]
#[cfg(desktop)]
#[tauri::command]
fn partner_notices_active() -> bool {
    launch::term::screen_watch_active()
}

/// 權限詢問的文字，給本機畫面確認（只有權限詢問才有）
#[cfg(feature = "gui")]
#[cfg(desktop)]
#[tauri::command]
async fn partner_permission_prompt(terms: State<'_, Arc<launch::term::LiveTerms>>, name: String) -> Result<launch::term::PermissionPrompt, String> {
    let terms = terms.inner().clone();
    launch::blocking_timeout(move || launch::term::partner_permission_prompt(&terms, &name)).await
}

/// 本人在本機畫面按了允許或拒絕；送之前全部重查，文字要和顯示的相同
#[cfg(feature = "gui")]
#[cfg(desktop)]
#[tauri::command]
async fn partner_permission_answer(terms: State<'_, Arc<launch::term::LiveTerms>>, name: String, hash: String, allow: bool) -> Result<(), String> {
    let terms = terms.inner().clone();
    launch::blocking_timeout(move || launch::term::partner_permission_answer(&terms, &name, &hash, allow)).await
}

/// 目前自己開著的終端：編號、profile、程序編號、啟動時記下的建立時間。
#[cfg(feature = "gui")]
#[cfg(desktop)]
#[tauri::command]
fn term_list(terms: State<'_, Arc<launch::term::LiveTerms>>) -> Vec<launch::term::TermListed> {
    terms.list()
}

/// 夥伴清單上的提醒：共用終端服務（mux）開著、而且使用者環境變數裡有看起來像金鑰的變數時回一句話，否則回空。只讀變數名字。
#[cfg(feature = "gui")]
#[cfg(desktop)]
#[tauri::command]
fn term_env_notice() -> Option<String> {
    launch::term::mux_env_notice()
}

/// 結束自己開的終端。只收編號；後端用對照表裡的視窗核對建立時間後才結束。成功後編號失效。
#[cfg(feature = "gui")]
#[cfg(desktop)]
#[tauri::command]
async fn term_stop(terms: State<'_, Arc<launch::term::LiveTerms>>, req: launch::term::TermStopReq) -> Result<(), String> {
    let terms = terms.inner().clone();
    launch::blocking_timeout(move || terms.stop(&req.id)).await
}

/// 自己開的終端現在忙還是閒。只有 grok 有規則；判斷不了回 unknown，不猜。等人回答時是 waiting_user，並附上 prompt，不代答。
#[cfg(feature = "gui")]
#[cfg(desktop)]
#[tauri::command]
async fn term_status(terms: State<'_, Arc<launch::term::LiveTerms>>, req: launch::term::TermStatusReq) -> Result<launch::term::TermStatus, String> {
    let terms = terms.inner().clone();
    launch::blocking_timeout(move || terms.status(&req.id)).await
}

/// 改自己開的終端分頁標題。只收編號與標題，長度與字元由後端檢查。
#[cfg(feature = "gui")]
#[cfg(desktop)]
#[tauri::command]
async fn term_rename(terms: State<'_, Arc<launch::term::LiveTerms>>, req: launch::term::TermRenameReq) -> Result<(), String> {
    let terms = terms.inner().clone();
    launch::blocking_timeout(move || terms.rename(&req.id, &req.title)).await
}

/// 使用者在 UI 提示框按了第 n 個選項後，前端才呼叫。這個命令本身證明不了有按確認。
/// UI 的提示框必須是唯一入口；後端其他路徑不得呼叫。只收編號、提示種類與選項編號。
#[cfg(feature = "gui")]
#[cfg(desktop)]
#[tauri::command]
async fn term_answer(app: State<'_, App>, terms: State<'_, Arc<launch::term::LiveTerms>>, req: launch::term::TermAnswerReq) -> Result<launch::term::TermAnswered, String> {
    let terms = terms.inner().clone();
    let relay = relay_of(&app)?.clone();
    let data_dir = app.data_dir.clone();
    let pt = req.prompt_text.clone();
    let opts = req.options.clone();
    term_remote::local_confirm_answer(relay.as_ref(), &terms, &data_dir, &req, &pt, &opts).await
}

/// #312 接點：使用者在本機按「確認送字」前先呼叫，建立手機遠端確認請求（與本機確認互斥，誰先誰算）。
#[cfg(feature = "gui")]
#[cfg(desktop)]
#[tauri::command]
async fn term_remote_offer_send(app: State<'_, App>, terms: State<'_, Arc<launch::term::LiveTerms>>, req: launch::term::TermSendReq) -> Result<(), String> {
    let terms = terms.inner().clone();
    let relay = relay_of(&app)?.clone();
    let data_dir = app.data_dir.clone();
    term_remote::offer_send(relay.as_ref(), &terms, &data_dir, &req.id, &req.text, req.enter).await.map(|_| ())
}

/// 使用者在本機按「返回」、關掉送字框或換終端時呼叫：撤回該終端等手機確認的請求（#329）。
#[cfg(feature = "gui")]
#[cfg(desktop)]
#[tauri::command]
async fn term_remote_withdraw(app: State<'_, App>, id: String) -> Result<(), String> {
    let relay = relay_of(&app)?.clone();
    let data_dir = app.data_dir.clone();
    term_remote::withdraw(relay.as_ref(), &data_dir, &id).await;
    Ok(())
}

/// 畫面上出現 waiting_user 提示時呼叫一次，建立代答的遠端確認請求。
#[cfg(feature = "gui")]
#[cfg(desktop)]
#[tauri::command]
async fn term_remote_offer_answer(app: State<'_, App>, terms: State<'_, Arc<launch::term::LiveTerms>>, req: launch::term::TermAnswerReq) -> Result<(), String> {
    let terms = terms.inner().clone();
    let relay = relay_of(&app)?.clone();
    let data_dir = app.data_dir.clone();
    term_remote::offer_answer(
        relay.as_ref(),
        &terms,
        &data_dir,
        &req.id,
        &req.prompt_kind,
        &req.prompt_text,
        &req.options,
    )
    .await
    .map(|_| ())
}

/// 本機進行中的遠端確認（給桌面 UI 顯示倒數；不含內容）。
#[cfg(feature = "gui")]
#[cfg(desktop)]
#[tauri::command]
fn term_remote_pending() -> Vec<term_remote::PendingView> {
    term_remote::pending_views()
}

/// 手機回答權限框（#853）的背景工作
#[cfg(all(desktop, feature = "gui"))]
fn start_perm_remote_poller(app: tauri::AppHandle, relay: std::sync::Arc<Relay>, terms: std::sync::Arc<launch::term::LiveTerms>, data_dir: std::path::PathBuf) {
    use tauri::Manager;
    tauri::async_runtime::spawn(async move {
        let mut tracker = perm_remote::Tracker::default();
        loop {
            tokio::time::sleep(std::time::Duration::from_secs(perm_remote::TICK_SECS)).await;
            if app.state::<auth::AuthState>().status().signed_in {
                perm_remote::tick(relay.as_ref(), &terms, &data_dir, &mut tracker).await;
            }
        }
    });
}

#[cfg(all(desktop, feature = "gui"))]
fn start_term_remote_poller(
    app: tauri::AppHandle,
    relay: std::sync::Arc<Relay>,
    terms: std::sync::Arc<launch::term::LiveTerms>,
    data_dir: std::path::PathBuf,
    wake: std::sync::Arc<tokio::sync::Notify>,
) {
    use tauri::{Emitter, Manager};
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_secs(3)).await;
        loop {
            if app.state::<auth::AuthState>().status().signed_in {
                term_remote::poll_once(relay.as_ref(), terms.as_ref(), &data_dir).await;
                let _ = app.emit("term-req-update", term_remote::pending_views());
            }
            tokio::select! {
                _ = tokio::time::sleep(std::time::Duration::from_secs(term_remote::POLL_INTERVAL_SECS)) => {}
                _ = wake.notified() => {}
            }
        }
    });
}

/// 可接手的 WezTerm 窗格（只列前景為已知 CLI 者；不在白名單的標示為未授權）。
#[cfg(feature = "gui")]
#[cfg(desktop)]
#[tauri::command]
async fn term_adopt_candidates(app: State<'_, App>, terms: State<'_, Arc<launch::term::LiveTerms>>) -> Result<Vec<launch::term::TermAdoptCandidate>, String> {
    let terms = terms.inner().clone();
    let data_dir = app.data_dir.clone();
    launch::blocking_timeout(move || launch::term::adopt_candidates_live(&terms, &data_dir)).await
}

/// 使用者在桌面按「接手」後呼叫。接手紀錄只存記憶體，ASN 重啟後清空。
#[cfg(feature = "gui")]
#[cfg(desktop)]
#[tauri::command]
async fn term_adopt(app: State<'_, App>, terms: State<'_, Arc<launch::term::LiveTerms>>, req: launch::term::TermAdoptReq) -> Result<launch::term::TermStarted, String> {
    let terms = terms.inner().clone();
    let data_dir = app.data_dir.clone();
    launch::blocking_timeout(move || launch::term::adopt_live(&terms, req, &data_dir)).await
}

/// 在本機桌面解鎖接手窗格的代答／代送（預設關；遠端指令不能呼叫這條）。
#[cfg(feature = "gui")]
#[cfg(desktop)]
#[tauri::command]
async fn term_adopt_unlock(terms: State<'_, Arc<launch::term::LiveTerms>>, req: launch::term::TermAdoptUnlockReq) -> Result<(), String> {
    let terms = terms.inner().clone();
    launch::blocking_timeout(move || terms.unlock_adopted(&req.id, req.allow_answer, req.allow_send)).await
}

#[cfg(feature = "gui")]
#[cfg(desktop)]
#[tauri::command]
async fn launch_prefs_set(app: State<'_, App>, prefs: Value) -> Result<(), String> {
    launch::launch_prefs_set(app.data_dir.clone(), prefs).await
}

#[cfg(desktop)]
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RelayLogPaths {
    bridge_log: String,
    machine_dir: String,
}

/// 主視窗的 [ASN] 記錄整批附加到機器資料夾的 ui.log（#339）。寫不進去回錯誤，畫面不必理會
#[cfg(feature = "gui")]
#[cfg(desktop)]
#[tauri::command]
fn ui_log(app: State<'_, App>, lines: Vec<String>) -> Result<usize, String> {
    ui_log::append(&app.work_dir, &lines)
}

/// 收發橋與夥伴啟動相關紀錄的路徑（不含金鑰）。
#[cfg(feature = "gui")]
#[cfg(desktop)]
#[tauri::command]
fn relay_log_paths(app: State<'_, App>) -> RelayLogPaths {
    let machine_dir = app.work_dir.clone();
    RelayLogPaths {
        bridge_log: machine_dir.join("bridge.log").display().to_string(),
        machine_dir: machine_dir.display().to_string(),
    }
}

#[cfg(desktop)]
fn open_in_file_manager(path: &Path) -> Result<(), String> {
    if !path.is_dir() {
        return Err("路徑不是資料夾".into());
    }
    open_with_system(path)
}

/// 交給系統開：資料夾開檔案管理員，檔案用預設程式開（Windows 的 explorer、其他的 xdg-open 都是這樣）。
/// 不經 shell，路徑當成單一參數傳；呼叫的地方負責確認路徑是自己決定的
#[cfg(desktop)]
fn open_with_system(path: &Path) -> Result<(), String> {
    // 兩段分開、程式名寫成字面：nowin.rs 的守門白名單比對的是 explorer／xdg-open 這兩行的確切寫法
    #[cfg(windows)]
    {
        std::process::Command::new("explorer")
            .arg(path)
            .spawn()
            .map(|_| ())
            .map_err(|e| e.to_string())
    }
    #[cfg(not(windows))]
    {
        std::process::Command::new("xdg-open")
            .arg(path)
            .spawn()
            .map(|_| ())
            .map_err(|e| e.to_string())
    }
}

/// 唯一允許用檔案管理員開啟的 machine 記錄目錄；路徑只來自 Rust 端 work_dir，不接受前端傳入。
#[cfg(desktop)]
pub fn machine_log_dir_for(work_dir: &Path, relay_home: &Path) -> Result<PathBuf, String> {
    if !work_dir.starts_with(relay_home) {
        return Err("記錄資料夾路徑異常".into());
    }
    let leaf = work_dir
        .file_name()
        .and_then(|s| s.to_str())
        .ok_or_else(|| "記錄資料夾路徑異常".to_string())?;
    let node = leaf
        .strip_prefix("machine-")
        .ok_or_else(|| "記錄資料夾路徑異常".to_string())?;
    if !identity::valid_id(node) {
        return Err("節點格式不對".into());
    }
    Ok(work_dir.to_path_buf())
}

#[cfg(desktop)]
pub fn machine_log_dir(work_dir: &Path) -> Result<PathBuf, String> {
    machine_log_dir_for(work_dir, &identity::relay_home())
}

/// 用檔案管理員開啟本機 machine 資料夾（內含 bridge.log）；不接受任何路徑參數。
#[cfg(feature = "gui")]
#[cfg(desktop)]
#[tauri::command]
fn open_machine_log_dir(app: State<'_, App>) -> Result<(), String> {
    let dir = machine_log_dir(&app.work_dir)?;
    open_in_file_manager(&dir)
}

/// 設定頁「檢視記錄」：用系統預設程式開機器資料夾的 ui.log（#339）。不接受任何路徑參數；
/// 檔案還不存在就回錯誤，畫面退回呼叫 open_machine_log_dir 開資料夾
#[cfg(feature = "gui")]
#[cfg(desktop)]
#[tauri::command]
fn open_ui_log(app: State<'_, App>) -> Result<(), String> {
    let dir = machine_log_dir(&app.work_dir)?;
    let file = ui_log::existing(&dir)?;
    open_with_system(&file)
}

/// `--shot` 模式：前端標記「這一刻可以截」（例如對話框已掛上 DOM）。
#[cfg(feature = "gui")]
#[tauri::command]
fn capture_ui_ready(app: State<'_, App>, tag: String) -> Result<(), String> {
    let dir = app.shot.clone().ok_or("不在 --shot 模式")?;
    let safe: String = tag.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '-').collect();
    if safe.is_empty() {
        return Err("標記名稱不合格".into());
    }
    write_atomic(&dir.join(format!("{safe}.ok")), "1").map_err(|e| e.to_string())
}

/// `--shot` 模式：前端錯誤印到 stderr，方便 shot.mjs 除錯。
#[cfg(feature = "gui")]
#[tauri::command]
fn shot_frontend_log(app: State<'_, App>, level: String, message: String) {
    if app.shot.is_some() {
        elog!("[asn-ui {level}] {message}");
    }
}

/// 底部廣告可以開的網址：只准 https、沒有帳密、主機在網域允許清單內（見 ads.rs 的 ALLOWED_HOSTS）
/// 用系統預設瀏覽器開（網址已比對白名單，不經 shell）
#[cfg(feature = "gui")]
#[cfg(desktop)]
#[tauri::command]
fn open_url(url: String) -> Result<(), String> {
    if !ads::url_allowed(&url) {
        return Err("這個網址不在允許清單內".into());
    }
    spawn_browser(&url)
}

/// 訊息內文裡的連結（Markdown）：只准 http(s)、沒有帳密、沒有空白或控制字元、長度有限；不比對網域（內容是對方寫的，使用者自己點才開）。
/// 電腦版用系統預設瀏覽器，手機版走「開網址」外掛的 Intent；都不在 WebView 裡導覽。
pub(crate) fn link_allowed(url: &str) -> bool {
    if url.is_empty() || url.len() > 2000 || url.chars().any(|c| c.is_control() || c.is_whitespace()) {
        return false;
    }
    let Ok(u) = reqwest::Url::parse(url) else { return false };
    matches!(u.scheme(), "http" | "https") && u.host_str().is_some() && u.username().is_empty() && u.password().is_none()
}

#[cfg(feature = "gui")]
#[tauri::command]
fn open_link(handle: AppHandle, url: String) -> Result<(), String> {
    if !link_allowed(&url) {
        return Err("這個網址不能開".into());
    }
    open_in_browser(&handle, &url)
}

/// 用預設瀏覽器開網址：ShellExecuteW("open", url)。不用 explorer.exe——長網址或帶 & 的網址（例如登入的 OAuth 網址）
/// 會被 explorer 當成路徑，結果開成「檔案總管」。只接受 http(s)，其他一律拒絕。
#[cfg(windows)]
pub(crate) fn spawn_browser(url: &str) -> Result<(), String> {
    use windows_sys::Win32::UI::Shell::ShellExecuteW;
    use windows_sys::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return Err("只能開 http(s) 網址".into());
    }
    let wide = |s: &str| s.encode_utf16().chain(std::iter::once(0)).collect::<Vec<u16>>();
    let (verb, file) = (wide("open"), wide(url));
    // 回傳值大於 32 表示成功（Win32 規定）
    let r = unsafe { ShellExecuteW(std::ptr::null_mut(), verb.as_ptr(), file.as_ptr(), std::ptr::null(), std::ptr::null(), SW_SHOWNORMAL) };
    if r as isize > 32 { Ok(()) } else { Err(format!("無法開啟瀏覽器（代碼 {}）", r as isize)) }
}

#[cfg(all(not(windows), desktop))]
pub(crate) fn spawn_browser(url: &str) -> Result<(), String> {
    std::process::Command::new("xdg-open").arg(url).spawn().map(|_| ()).map_err(|e| e.to_string())
}

/// 登入用：開系統瀏覽器。電腦版直接叫系統開；安卓版經「開網址」外掛（走系統的 Intent，不能呼叫外部程式）
#[cfg(feature = "gui")]
pub(crate) fn open_in_browser(handle: &AppHandle, url: &str) -> Result<(), String> {
    #[cfg(target_os = "android")]
    {
        android::open_url(handle, url)
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = handle;
        spawn_browser(url)
    }
}

/// 某台設備上傳的大頭貼（名單只帶更新時間，圖按需取）。節點代號先驗格式才組網址
#[cfg(feature = "gui")]
#[tauri::command]
async fn relay_avatar(app: State<'_, App>, node: String) -> Result<Value, String> {
    if !identity::valid_id(&node) {
        return Err(format!("節點格式不對：{node}"));
    }
    relay_of(&app)?.api(&format!("avatar&node={}", relay::encode_component(&node)), None).await
}

/// 某位夥伴自己換的頭像（#446；名單的夥伴條目帶 avatar_updated_at 才會來取）。夥伴編號先驗格式（p_ 加 20 個十六進位字元）才組網址
#[cfg(feature = "gui")]
#[tauri::command]
async fn relay_partner_avatar(app: State<'_, App>, partner: String) -> Result<Value, String> {
    let ok = partner.len() == 22 && partner.starts_with("p_") && partner[2..].bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b));
    if !ok {
        return Err(format!("夥伴編號格式不對：{partner}"));
    }
    relay_of(&app)?.api(&format!("partner_avatar&partner={partner}"), None).await
}

/// 上傳（或 null＝移除）自己這台設備的大頭貼：格式與大小在這裡檢查，通過才送出；只能改自己的節點（後端由金鑰決定是誰）
#[cfg(feature = "gui")]
#[tauri::command]
async fn relay_set_avatar(app: State<'_, App>, avatar: Option<String>) -> Result<Value, String> {
    if let Some(a) = &avatar {
        avatar::validate(a)?;
    }
    relay_of(&app)?.api("set_avatar", Some(serde_json::json!({ "avatar": avatar }))).await
}

#[cfg(feature = "gui")]
#[tauri::command]
async fn relay_send(app: State<'_, App>, auth: State<'_, auth::AuthState>, payload: Value) -> Result<Value, String> {
    let r = relay_of(&app)?;
    // 人在視窗裡打的字：盡力帶登入憑證讓後台標成本人（取不到就照舊寄，不擋）
    let token = account::signing_token(&auth).await;
    r.send_signed(&payload, token.as_deref()).await
}
/// 「我和某夥伴」90 天內的往來（以後台為準，本機只當快取）。要登入憑證；沒登入或後台還沒支援就回錯，前端靜默沿用本機快取
#[cfg(feature = "gui")]
#[tauri::command]
async fn relay_chat_history(app: State<'_, App>, auth: State<'_, auth::AuthState>, node: String, agent: Option<String>, partner_id: Option<String>, before: Option<String>, limit: Option<u64>) -> Result<Value, String> {
    let r = relay_of(&app)?;
    let token = account::signing_token(&auth).await;
    r.chat_history(&node, agent.as_deref().unwrap_or(""), partner_id.as_deref(), before.as_deref(), limit, token.as_deref()).await
}
/// 已讀多端同步（設計見 docs/design/READ-SYNC.md）：送出這台的已讀位置、取回整個帳號的。電腦與手機共用；要本人簽章，沒登入回錯（不打後台），舊後台回 404，前端都靜默
#[cfg(feature = "gui")]
#[tauri::command]
async fn relay_read_sync(app: State<'_, App>, auth: State<'_, auth::AuthState>, body: Value) -> Result<Value, String> {
    let r = relay_of(&app)?;
    let token = account::signing_token(&auth).await;
    r.read_sync_signed(&body, token.as_deref()).await
}
/// 可被接班的夥伴清單（#153，要登入）。沒登入或後台還沒支援就回錯，前端不顯示「接班」選項
#[cfg(feature = "gui")]
#[tauri::command]
async fn relay_partner_list(app: State<'_, App>, auth: State<'_, auth::AuthState>) -> Result<Value, String> {
    let r = relay_of(&app)?;
    let token = account::signing_token(&auth).await;
    r.partner_list(token.as_deref()).await
}
/// 指定「新視窗是某某的接班」（#153，要本人簽章）：夥伴 ID 沿用前任
#[cfg(feature = "gui")]
#[tauri::command]
async fn relay_partner_succeed(app: State<'_, App>, auth: State<'_, auth::AuthState>, predecessor: String, node: String, name: String) -> Result<Value, String> {
    let r = relay_of(&app)?;
    let token = account::signing_token(&auth).await;
    r.partner_succeed(&predecessor, &node, &name, token.as_deref()).await
}
/// 電腦版名單右鍵管理夥伴視窗（詳情、改名、關閉、換班接手、喚醒）：和手機同一個後台動作，要本人簽章；沒登入回錯，不打後台。回 { id }
#[cfg(feature = "gui")]
#[cfg(desktop)]
#[tauri::command]
async fn relay_partner_op(app: State<'_, App>, auth: State<'_, auth::AuthState>, body: Value) -> Result<Value, String> {
    let r = relay_of(&app)?;
    let token = account::signing_token(&auth).await;
    r.partner_op_signed(&body, token.as_deref()).await
}
/// 電腦版名單右鍵「封存」「取消封存」：記在帳號層（同租戶所有設備同步），要本人簽章；沒登入回錯，不打後台。回 { ok, archived }
#[cfg(feature = "gui")]
#[cfg(desktop)]
#[tauri::command]
async fn relay_partner_archive(app: State<'_, App>, auth: State<'_, auth::AuthState>, body: Value) -> Result<Value, String> {
    let r = relay_of(&app)?;
    let token = account::signing_token(&auth).await;
    r.partner_archive_signed(&body, token.as_deref()).await
}
/// 查管理操作的進度（最多 20 筆）。要本人簽章；沒登入回錯，不打後台。回 { ops: [...] }
#[cfg(feature = "gui")]
#[cfg(desktop)]
#[tauri::command]
async fn relay_partner_ops(app: State<'_, App>, auth: State<'_, auth::AuthState>, ids: Vec<String>) -> Result<Value, String> {
    let r = relay_of(&app)?;
    let token = account::signing_token(&auth).await;
    r.partner_ops_signed(&ids, token.as_deref()).await
}
#[cfg(feature = "gui")]
#[tauri::command]
async fn relay_sent_status(app: State<'_, App>, ids: Vec<String>) -> Result<Value, String> {
    let rows = relay_of(&app)?.sent_status(&ids).await?;
    Ok(serde_json::json!({ "status": rows }))
}

/// 寄照片：前端已壓縮成 webp；格式與大小在 attach.rs 檢查，通過才依序要上傳網址、上傳、確認、寄信（金鑰只在這裡）
#[cfg(feature = "gui")]
#[tauri::command]
async fn relay_send_attachment(app: State<'_, App>, auth: State<'_, auth::AuthState>, payload: Value) -> Result<Value, String> {
    let r = relay_of(&app)?;
    let token = account::signing_token(&auth).await;
    attach::send_attachment_signed(&r, &reqwest::Client::new(), &payload, token.as_deref()).await
}

/// 放大看：換短效下載網址、下載、檢查，回前端 <img> 能直接用的 data URL（只有寄件人與收件人換得到網址）
#[cfg(feature = "gui")]
#[tauri::command]
async fn relay_attachment_fetch(app: State<'_, App>, id: String) -> Result<Value, String> {
    let r = relay_of(&app)?;
    let d = attach::download(&r, &reqwest::Client::new(), &id).await?;
    if d.mime != "image/webp" {
        return Err("這不是圖片，請改用「另存」".into());
    }
    Ok(serde_json::json!({ "name": d.name, "mime": d.mime, "data_url": attach::data_url(&d.bytes) }))
}

/// 另存新檔的記憶：上次存的資料夾（下次對話框的預設位置）。只在 Rust 端，前端拿不到、也不能設定。
#[cfg(desktop)]
#[derive(Default)]
struct SaveDir(std::sync::Mutex<Option<PathBuf>>);

/// 另存：跳出系統「另存新檔」對話框（預設＝上次存的資料夾，第一次是「下載\ASN」；預設檔名＝附件原檔名），
/// 使用者選好才下載、存到他選的那個路徑；按取消就不下載。回存檔路徑，取消回 null。
/// `name` 只是預設檔名的建議（外部資料，Rust 端清理過）；寫檔位置只來自對話框。
#[cfg(feature = "gui")]
#[cfg(desktop)]
#[tauri::command]
async fn relay_attachment_save(
    app: State<'_, App>,
    dir_state: State<'_, SaveDir>,
    handle: AppHandle,
    id: String,
    name: Option<String>,
) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    let r = relay_of(&app)?;
    let start = dir_state.0.lock().ok().and_then(|g| g.clone()).filter(|d| d.is_dir()).unwrap_or_else(|| {
        let d = identity::home_dir().join("Downloads").join("ASN");
        let _ = std::fs::create_dir_all(&d);
        d
    });
    let pick = |fname: &str, ext: Option<&'static str>| {
        let mut b = handle.dialog().file().set_title("另存新檔").set_directory(&start).set_file_name(fname);
        if let Some(e) = ext {
            b = b.add_filter(e.to_uppercase(), &[e]);
        }
        b = b.add_filter("所有檔案", &["*"]);
        b.blocking_save_file().and_then(|f| f.into_path().ok())
    };
    let saved = attach::save_as(&r, &reqwest::Client::new(), &id, name.as_deref().unwrap_or(""), pick).await?;
    Ok(saved.map(|p| {
        if let (Some(parent), Ok(mut g)) = (p.parent(), dir_state.0.lock()) {
            *g = Some(parent.to_path_buf());
        }
        p.display().to_string()
    }))
}

/// 開啟資料夾：只開「上次存檔的那個資料夾」，路徑由 Rust 記著、前端不能帶參數
#[cfg(feature = "gui")]
#[cfg(desktop)]
#[tauri::command]
fn relay_attachment_reveal(dir_state: State<'_, SaveDir>) -> Result<(), String> {
    let dir = dir_state.0.lock().ok().and_then(|g| g.clone()).ok_or("還沒有存過檔案")?;
    open_in_file_manager(&dir)
}

/// 前端的狀態下拉與個人訊息：記在 Rust 端，由回報迴圈每 60 秒送出；改了就立刻回報一次
/// 「顯示正在聽的歌」開關（預設關）。關著不讀系統媒體、不送；開了才讀。回傳目前的歌（沒在聽＝空字串）
#[cfg(feature = "gui")]
#[cfg(desktop)]
#[tauri::command]
fn set_now_playing(app: State<'_, App>, on: bool) -> Result<String, String> {
    let r = relay_of(&app)?;
    let changed = r.now_playing.set_enabled(on);
    let _ = app.now_wake.send(());
    if changed {
        r.presence_wake.notify_one();
    }
    Ok(r.now_playing.current())
}

#[cfg(feature = "gui")]
#[tauri::command]
fn set_presence(app: State<'_, App>, status: String, psm: String) -> Result<(), String> {
    relay_of(&app)?.set_presence(&status, &psm);
    Ok(())
}

/// 改暱稱＝改對外名字（驗證在 names::validate_name；不合法就回錯誤字串，介面還原並提示）
#[cfg(feature = "gui")]
#[tauri::command]
fn set_window_name(app: State<'_, App>, name: String) -> Result<String, String> {
    let relay = relay_of(&app)?;
    let n = names::rename(relay.as_ref(), &app.data_dir, &app.work_dir, &name, heartbeat::now_ms())?;
    // 改名成功後立刻叫醒在線狀態回報（名單上別台設備馬上看到新名）
    relay.presence_wake.notify_one();
    // 改名成功後把新視窗名同步成這台設備的顯示名；失敗只記 log，不影響改名
    tauri::async_runtime::spawn(async move { relay.sync_device_name().await });
    Ok(n)
}

fn store_path(app: &App, name: &str) -> Result<PathBuf, String> {
    if name.is_empty() || !name.chars().all(|c| c.is_ascii_lowercase()) {
        return Err("存檔名稱不合格".into());
    }
    Ok(app.data_dir.join(format!("asn-{name}.json")))
}
#[cfg(feature = "gui")]
#[tauri::command]
fn store_load(app: State<'_, App>, name: String) -> Result<Option<String>, String> {
    Ok(std::fs::read_to_string(store_path(&app, &name)?).ok())
}
#[cfg(feature = "gui")]
#[tauri::command]
fn store_save(app: State<'_, App>, name: String, text: String) -> Result<(), String> {
    if text.len() > 8_000_000 {
        return Err("存檔太大".into());
    }
    write_atomic(&store_path(&app, &name)?, &text).map_err(|e| e.to_string())
}

/// 語音設定（念出訊息的聲音與自動念、語音輸入的語言與模型）；存在資料夾的 voice.json
#[cfg(feature = "gui")]
#[cfg(desktop)]
#[tauri::command]
fn voice_cfg_get(app: State<'_, App>) -> voicecfg::VoiceCfg {
    voicecfg::load(&app.data_dir)
}
#[cfg(feature = "gui")]
#[cfg(desktop)]
#[tauri::command]
fn voice_cfg_set(app: State<'_, App>, cfg: voicecfg::VoiceCfg) -> Result<(), String> {
    voicecfg::save(&app.data_dir, &cfg)
}

#[cfg(feature = "gui")]
#[tauri::command]
fn quit_app(app: AppHandle) {
    #[cfg(desktop)] // 自動接回只有電腦版有；launch 模組手機版沒編進去
    launch::auto_resume::note_user_quit(&app.state::<App>().work_dir);
    #[cfg(desktop)] // 同上：只有電腦版有 launch
    launch::mux_watch::note_user_quit(&app.state::<App>().work_dir);
    cleanup(&app);
    app.exit(0);
}

/// 命令列（asn-cli）的完整路徑與寄信範例（設定頁「寄信指令」用）
#[cfg(feature = "gui")]
#[cfg(desktop)]
#[tauri::command]
fn cli_info() -> serde_json::Value {
    cli::info()
}
/// 內建收發室橋的狀態（設定頁用）。預設關閉
#[cfg(feature = "gui")]
#[cfg(desktop)]
#[tauri::command]
fn bridge_status(m: State<'_, bridge::Manager>) -> bridge::Status {
    m.status()
}
/// 打開／關閉「讓 ASN 負責這台的收發室」
#[cfg(feature = "gui")]
#[cfg(desktop)]
#[tauri::command]
fn bridge_set_enabled(m: State<'_, bridge::Manager>, on: bool) -> Result<bridge::Status, String> {
    m.set_enabled(on)
}
/// 打開／關閉「允許我的其他設備替這台開新視窗」（預設關）
#[cfg(feature = "gui")]
#[cfg(desktop)]
#[tauri::command]
fn bridge_set_remote_launch(m: State<'_, bridge::Manager>, on: bool) -> Result<bridge::Status, String> {
    m.set_remote_launch(on)
}

#[cfg(feature = "gui")]
#[cfg(desktop)]
#[tauri::command]
fn bridge_set_term_server(m: State<'_, bridge::Manager>, on: bool) -> Result<bridge::Status, String> {
    // 只存檔：啟動時讀一次，改了要重開 ASN 才生效；已開著的夥伴不受影響（#868）
    m.set_term_server(on)
}

#[cfg(feature = "gui")]
#[cfg(desktop)]
#[tauri::command]
fn bridge_set_auto_resume(m: State<'_, bridge::Manager>, on: bool) -> Result<bridge::Status, String> {
    m.set_auto_resume(on)
}

/// 打開／關閉「權限框傳到手機」（#853）
#[cfg(feature = "gui")]
#[cfg(desktop)]
#[tauri::command]
fn bridge_set_perm_phone(m: State<'_, bridge::Manager>, on: bool) -> Result<bridge::Status, String> {
    let s = m.set_perm_phone(on)?;
    perm_remote::set_user_off(!on);
    Ok(s)
}

#[cfg(feature = "gui")]
#[cfg(desktop)]
#[tauri::command]
fn bridge_set_screen_watch(m: State<'_, bridge::Manager>, on: bool) -> Result<bridge::Status, String> {
    let s = m.set_screen_watch(on)?;
    launch::term::screen_watch_set_user_off(!on);
    Ok(s)
}

#[cfg(feature = "gui")]
#[cfg(desktop)]
#[tauri::command]
fn bridge_set_unaddressed_to(m: State<'_, bridge::Manager>, name: String) -> Result<bridge::Status, String> {
    m.set_unaddressed_to(&name)
}
/// 「改由 ASN 負責」：停掉舊版收發室橋（要使用者確認、要設定開關放行）再啟動內建橋
#[cfg(feature = "gui")]
#[cfg(desktop)]
#[tauri::command]
async fn bridge_takeover(m: State<'_, bridge::Manager>, confirmed: bool) -> Result<bridge::Status, String> {
    m.takeover(confirmed).await
}

#[cfg(feature = "gui")]
pub(crate) fn cleanup(app: &AppHandle) {
    // 內建橋：只關自己啟動的收發室 worker、釋放收信鎖（手機版沒有內建橋）
    #[cfg(desktop)]
    app.state::<bridge::Manager>().shutdown();
    let st = app.state::<App>();
    if let Some(r) = &st.relay {
        for n in r.active_names() {
            heartbeat::clear_heartbeat(&st.work_dir, &n, std::process::id());
        }
        // 關閉時盡力回報一次離線（最多等 3 秒，失敗不擋關閉；只送一次）
        r.report_offline_blocking(env!("CARGO_PKG_VERSION"));
    }
}

#[cfg(feature = "gui")]
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[cfg(all(not(windows), desktop))]
    {
        // WebKitGTK 在 Xvfb 下用 scrot 擷圖時，不關合成／DMABUF 常拍到空白。
        std::env::set_var("WEBKIT_DISABLE_COMPOSITING_MODE", "1");
        std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
    }
    let args: Vec<String> = std::env::args().collect();
    #[cfg(desktop)]
    let background = args.iter().any(|a| a == tray::BACKGROUND_FLAG);
    let shot = args.iter().position(|a| a == "--shot").and_then(|i| args.get(i + 1)).map(PathBuf::from);
    #[cfg(desktop)]
    let is_shot = shot.is_some();

    // 使用者資料夾合併式遷移（#14 R2）：只做一次、失敗就照舊用舊位置；截圖模式（假家目錄）不做
    if shot.is_none() {
        home::migrate_at_startup();
    }
    let (relay, node, init_error, work_dir, anon, base) = match identity::resolve() {
        Ok(id) => {
            let wd = identity::work_dir(&id.relay_home, &id.node);
            (Some(id.node.clone()), id.node, None, wd, id.anon, Some((id.base_url, id.key)))
        }
        Err(e) => (None, String::new(), Some(e), PathBuf::new(), None, None),
    };
    let _ = relay;
    // panic 先寫進 ui.log 再結束（#1749：panic = "abort"，以前閃退什麼都沒留下）；截圖模式不寫
    #[cfg(desktop)]
    if !is_shot {
        ui_log::install_panic_hook(work_dir.clone());
    }
    // 自己結束時寫原因用的資料夾（截圖模式不寫）
    #[cfg(desktop)]
    let exit_log_dir = if is_shot { PathBuf::new() } else { work_dir.clone() };

    // --shot 只准連本機假後端（紅線：測試不碰真實 relay）
    if shot.is_some() {
        // 看環境變數指的後台網址（沒有金鑰、模擬新電腦的截圖也要擋住真實後台）
        let u = identity::base_url(crate::envc::get("ASN_RELAY_URL"));
        let ok = u.starts_with("http://127.0.0.1") || u.starts_with("http://localhost");
        if !ok {
            elog!("--shot 只能搭配指向本機假後端的 ASN_RELAY_URL（http://127.0.0.1…）");
            std::process::exit(5);
        }
    }

    // 資料資料夾：Windows 是 %APPDATA%\tw.yooliang.asn（舊識別資料夾的內容首次啟動時複製過來，見 datadir.rs）
    let data_dir = crate::envc::get_os("ASN_DATA").map(PathBuf::from).unwrap_or_else(|| datadir::startup(&work_dir, shot.is_some()));

    let relay_obj = base.map(|(url, key)| {
        let name = read_settings_name(&data_dir).unwrap_or_else(|| default_window_name_for(&node, &account::computer_name(|k| std::env::var(k).ok())));
        let r = Relay::new(url, key, node.clone(), name);
        r.set_old_names(names::prune(&names::read_old_names(&data_dir), &r.window_name(), heartbeat::now_ms()));
        Arc::new(r)
    });

    // 自己重開的新程序（--after-pid <舊 pid>）：先等舊的結束再做同名檢查，不然舊的心跳還新鮮會被判成同名已在跑（#581 審）
    #[cfg(desktop)]
    if let Some(old) = ui_log::after_pid(&args) {
        ui_log::wait_gone(old, ui_log::AFTER_PID_WAIT, heartbeat::pid_alive, heartbeat::is_asn_process);
    }

    // 同一個視窗名只留一個 ASN（另一個還活著就退出，同 recv.mjs 的 exit 3）。
    // 這個新開的是被邀請連結叫起來的（asn://invite/<碼>）：先把碼放進信箱檔，正在跑的那個 ASN 會取走並跳出「加入群組」
    if let Some(r) = &relay_obj {
        if let Some(h) = heartbeat::other_instance(&work_dir, &r.window_name(), std::process::id()) {
            let args: Vec<String> = std::env::args().skip(1).collect();
            if let Some(code) = invite_link::invite_code_from_args(&args) {
                let _ = invite_link::drop_in_inbox(&work_dir, &code);
            }
            elog!("視窗「{}」已經有一個 ASN 在跑（pid {}）", r.window_name(), h.pid);
            #[cfg(desktop)]
            ui_log::log_exit(&exit_log_dir, &format!("同一個視窗名已經有 ASN 在跑（pid {}），這個不開", h.pid));
            std::process::exit(3);
        }
    }

    #[cfg(desktop)]
    let term_data_dir = data_dir.clone();
    // 自帶終端的服務：畫面命令（State）與開新夥伴（經 pi）、名單切前後景（全域）用同一份對照表（#475）
    #[cfg(desktop)]
    let terms = Arc::new(launch::term::live(&term_data_dir));
    #[cfg(desktop)]
    launch::term::set_global(terms.clone());
    #[cfg(desktop)]
    launch::term::start_background_partner_watch(terms.clone());
    #[cfg(desktop)]
    self_windows::prune(&self_windows::dir_in(&identity::relay_home()), &heartbeat::process_started_ms);
    #[cfg(desktop)]
    launch::term::screen_watch_set_user_off(bridge::read_settings(&data_dir).screen_watch_off);
    #[cfg(desktop)]
    perm_remote::set_user_off(bridge::read_settings(&data_dir).perm_phone_off);
    #[cfg(desktop)]
    launch::term::start_screen_watch(terms.clone(), &work_dir);
    #[cfg(desktop)]
    launch::term::set_ui_log_dir(&work_dir);
    // 共用終端服務（mux）掛掉要有人知道：偵測、通知、接回（#596 第 4 項）。沒開 mux 模式時什麼都不做
    #[cfg(desktop)]
    launch::mux_watch::start(terms.clone(), &work_dir, &term_data_dir);
    // 電腦重開後自動接回夥伴（#767）：要在內建橋更新開機時間之前看存檔，所以放在橋啟動之前
    #[cfg(desktop)]
    if !is_shot && relay_obj.is_some() {
        launch::auto_resume::start(&work_dir, &term_data_dir);
    }
    let frame_data_dir = data_dir.clone();
    let bridge_data_dir = data_dir.clone();
    let auto_acct_dir = data_dir.clone();
    #[cfg_attr(not(desktop), allow(unused_mut))]
    let mut auth_state = auth::AuthState::new(auth::default_store(&data_dir));
    #[cfg(desktop)]
    {
        auth_state.on_signout = Some(ui_log::signout_logger(exit_log_dir.clone()));
    }
    // 端到端測試用：--shot 模式下假裝已登入（只連本機假後端；正式執行沒有這條路）
    if shot.is_some() {
        if let Some(email) = crate::envc::get("ASN_SHOT_LOGIN") {
            if !email.trim().is_empty() {
                auth_state.seed_shot_session(email.trim());
            }
        }
    }
    let (now_wake, now_wake_rx) = std::sync::mpsc::channel::<()>();
    #[cfg(desktop)]
    let now_wake_rx = std::sync::Mutex::new(Some(now_wake_rx));
    #[cfg(not(desktop))]
    drop(now_wake_rx);   // 手機版不讀系統媒體，沒有聽歌輪詢
    let state = App { relay: relay_obj.clone(), init_error, node: node.clone(), work_dir: work_dir.clone(), data_dir, shot, now_wake };
    let anon_url = relay_obj.as_ref().zip(anon).and_then(|(r, a)| bell::ws_url(r.base(), &a));
    if let Some(r) = &relay_obj {
        r.set_owner_dir(work_dir.clone());
    }
    #[cfg(desktop)]
    let bridge_mgr = bridge::Manager::new(relay_obj.clone(), anon_url.clone(), node.clone(), work_dir.clone(), bridge_data_dir);
    #[cfg(not(desktop))]
    drop(bridge_data_dir);

    let builder = tauri::Builder::default().manage(state).manage(auth_state).manage(InviteInbox::default()).plugin(tauri_plugin_dialog::init()).plugin(tauri_plugin_deep_link::init());
    // 電腦版專屬的狀態與外掛（多視窗、系統匣、截圖、自動更新、內建橋、密碼小幫手）
    #[cfg(desktop)]
    let builder = builder
        .manage(wins::Slots::default())
        .manage(Arc::new(TermViews::default()))
        .manage(Arc::new(BeingViewed::default()))
        .manage(Arc::new(view_remote::RemoteViews::default()))
        .manage(Arc::new(RemoteInputs::default()))
        .manage(ViewNet(anon_url.clone()))
        .manage(wins::Frame::default())
        .manage(tray::CloseToTray::default())
        .manage(tray::TrayFailed::default())
        .manage(shot::ShotState::default())
        .manage(updater::Pending::default())
        .manage(SaveDir::default())
        .manage(claude_mod::ModState::default())
        .manage(bridge_mgr)
        .manage(terms)
        .manage(Arc::new(askpass::dialog::DialogState::default()))
        .plugin(tauri_plugin_updater::Builder::new().build());
    // 安卓版專屬：開系統瀏覽器（登入、點連結）
    #[cfg(target_os = "android")]
    let builder = builder.plugin(tauri_plugin_opener::init());
    #[cfg(desktop)]
    let builder = builder
        .invoke_handler(tauri::generate_handler![
            term_view_open, term_view_close, term_view_input, term_view_active, term_view_available, term_view_history, device_known_list, device_known_forget, device_known_input_no_ask, term_viewed_stop, term_view_remote_available, term_view_remote_start, term_view_remote_input, term_view_remote_set, term_view_remote_stop, self_windows::self_window_default, self_windows::self_window_register, bridge_set_term_server, startup_info, relay_list, relay_inbox, relay_ack, relay_send, relay_chat_history, relay_read_sync, relay_partner_list, relay_partner_succeed, relay_partner_op, relay_partner_ops, relay_partner_archive, relay_sent_status, relay_send_attachment, relay_attachment_fetch, relay_attachment_save, relay_attachment_reveal, relay_avatar, relay_partner_avatar, relay_set_avatar, relay_rooms, relay_group, relay_room_read, relay_room_post, invite_pending, relay_launch, relay_launchers, partner_launch_local, local_windows, launch_cwd_candidates, launch_cwd_browse, partner_console_query, partner_console_set, model_switch_query, model_switch_run, subagents_query, tasks_query, launch_prefs_get, launch_prefs_set, pi_setup_status, pi_setup_install, pi_setup_remove, pi_models, pi_providers, term_start, term_send, term_read, term_list, auto_resume_status, partner_notices, partner_notices_active, partner_permission_prompt, partner_permission_answer, term_env_notice, term_stop, term_status, term_rename, term_answer, term_remote_offer_send, term_remote_withdraw, term_remote_offer_answer, term_remote_pending, term_adopt_candidates, term_adopt, term_adopt_unlock, relay_log_paths, ui_log, open_machine_log_dir, open_ui_log, shot_frontend_log, open_url, open_link, ads::ads_fetch, set_window_name, set_presence, set_now_playing, bridge_status, bridge_set_enabled, bridge_set_remote_launch, bridge_set_auto_resume, bridge_set_screen_watch, bridge_set_perm_phone, bridge_set_unaddressed_to, bridge_takeover, cli_info, askpass::dialog::askpass_info, askpass::dialog::askpass_answer, askpass::dialog::askpass_helper_info, store_load, store_save, quit_app,
            shot::shot_begin, shot::shot_image, shot::shot_ready, shot::shot_focus, shot::shot_pick, shot::shot_cancel, shot::shot_supported,
            claude_accounts::claude_accounts_list, claude_accounts::claude_account_current, claude_accounts::claude_account_save, claude_accounts::claude_account_switch, claude_accounts::claude_account_delete, claude_accounts::claude_account_undo, claude_mod::claude_mod_status, claude_mod::claude_mod_auto_get, claude_mod::claude_mod_auto_set, claude_quota::claude_quota_all, statusline_hook::claude_quota_hook_status, statusline_hook::claude_quota_hook_connect, statusline_hook::claude_quota_hook_disconnect,
            codex_accounts::codex_account_current, grok_accounts::grok_accounts_list, grok_accounts::grok_account_current, grok_accounts::grok_account_switch, usage::usage_summary,
            acct_remote_report, acct_remote_list, acct_roster, acct_remote_request, acct_remote_status, acct_remote_pending, acct_remote_apply, acct_remote_decline, acct_remote_allow_get, acct_remote_allow_set, agent_setup_remote_allow_get, agent_setup_remote_allow_set, agent_setup_start, agent_setup_plan, agent_setup_cancel,
            voice_cfg_get, voice_cfg_set, tts::tts_voices, tts::tts_speak, stt::stt_status, stt::stt_install, stt::stt_transcribe,
            agent_tools::ai_cli_detect, agent_tools::ai_cli_install, agent_tools::ai_cli_login, stt::stt_cancel,
            wins::open_chat, wins::open_panel, wins::close_panels, wins::chat_visible, wins::close_chats, wins::open_windows, wins::main_visible, wins::show_main, wins::main_layout, wins::shake, wins::show_toast, wins::toast_click, wins::setup_progress_snapshot, wins::win_ctl, wins::frame_native, wins::set_frame, wins::take_shot, capture_ui_ready,
            account::auth_status, account::last_login_set_avatar, account::auth_login, account::auth_cancel, account::auth_logout, account::auth_account_info, account::auth_account_name_set, account::auth_ai_wake_limit_get, account::auth_ai_wake_limit_set, account::auth_device_prefs_get, account::auth_device_prefs_set, account::auth_bind, account::auth_skip_login, account::update_remote_request, account::update_remote_status,
            cloud_invite::cloud_agent_create, cloud_invite::cloud_agent_list, cloud_invite::cloud_agent_revoke, cloud_invite::cloud_agent_rename, cloud_invite::cloud_agent_approve,
            site_releases::site_releases, tray::set_close_to_tray, tray::set_tray_unread, tray::tray_available, tray::autostart_supported, tray::autostart_get, tray::autostart_blocked, tray::autostart_set, updater::update_check, updater::update_install,
        ]);
    // 手機只開放單欄名單與對話需要的指令；電腦端的指令（開視窗、橋、用量……）手機上根本不存在
    #[cfg(not(desktop))]
    let builder = builder.invoke_handler(tauri::generate_handler![
        startup_info, relay_list, relay_inbox, relay_ack, relay_rooms, relay_group, invite_pending, relay_send, relay_chat_history, relay_read_sync, relay_sent_status, relay_send_attachment, relay_attachment_fetch, relay_avatar, relay_partner_avatar, relay_set_avatar,
        set_presence, set_window_name, store_load, store_save, quit_app, capture_ui_ready, shot_frontend_log, open_link,
        account::auth_status, account::last_login_set_avatar, account::auth_login, account::auth_cancel, account::auth_logout, account::auth_account_info, account::auth_account_name_set, account::auth_ai_wake_limit_get, account::auth_ai_wake_limit_set, account::auth_device_prefs_get, account::auth_device_prefs_set, account::auth_bind,
        account::setup_remote_request, account::setup_remote_status,
        cloud_invite::cloud_agent_create, cloud_invite::cloud_agent_list, cloud_invite::cloud_agent_revoke, cloud_invite::cloud_agent_rename, cloud_invite::cloud_agent_approve,
        site_releases::site_releases, android::relay_attachment_save, android::android_update_check, android::android_update_download, android::android_launchers, android::android_launch, android::android_partner_op, android::android_partner_ops, android::android_partner_archive, android::android_acct_list, android::android_acct_roster, android::android_acct_switch, android::android_acct_status, android::android_term_req_list, android::android_term_req_decide, android::android_perm_req_list, android::android_perm_req_decide, android::android_secret_pending, android::android_secret_reply, android::android_room_read, android::android_room_post, relay_partner_list, relay_partner_succeed,
    ]);
    let builder = builder
        .setup(move |app| {
            let handle = app.handle().clone();
            // 邀請連結一鍵開啟：asn://invite/<碼>（電腦）、https://asnmessenger.web.app/i/<碼>（安卓 App Links）。
            // 三個來源：這次啟動的連結（冷啟動）、執行中收到的連結（外掛事件）、第二個 ASN 轉交的信箱檔。碼一律先過格式檢查才交給畫面
            {
                use tauri_plugin_deep_link::DeepLinkExt;
                let dl = handle.deep_link();
                let mut first: Vec<String> = dl.get_current().ok().flatten().map(|v| v.iter().map(|u| u.to_string()).collect()).unwrap_or_default();
                first.extend(std::env::args().skip(1));
                if let Some(code) = invite_link::invite_code_from_args(&first) {
                    deliver_invite(&handle, code);
                }
                let h = handle.clone();
                dl.on_open_url(move |ev| {
                    let urls: Vec<String> = ev.urls().iter().map(|u| u.to_string()).collect();
                    if let Some(code) = invite_link::invite_code_from_args(&urls) {
                        deliver_invite(&h, code);
                    }
                });
                // 沒經過安裝程式（開發、綠色版）也讓 asn:// 指到這個程式；失敗不影響其他功能。
                // 截圖模式（--shot，測試、CI）不登記：它會改真實使用者的登錄檔，把 asn:// 指到測試用的執行檔
                #[cfg(any(windows, target_os = "linux"))]
                if !is_shot {
                    let _ = dl.register("asn");
                }
            }
            #[cfg(desktop)]
            if handle.state::<App>().shot.is_none() {
                let h = handle.clone();
                let dir = handle.state::<App>().work_dir.clone();
                tauri::async_runtime::spawn(async move {
                    loop {
                        tokio::time::sleep(std::time::Duration::from_secs(2)).await;
                        if let Some(code) = invite_link::take_from_inbox(&dir) {
                            deliver_invite(&h, code);
                        }
                    }
                });
            }
            #[cfg(desktop)]
            {
            // 視窗外框設定存在前端的 asn-me.json；沒有或壞掉就是自訂外框
            let native = std::fs::read_to_string(frame_data_dir.join("asn-me.json")).map(|t| wins::native_from_saved(&t)).unwrap_or(false);
            wins::init_frame(&handle, native);
            // 關閉行為同樣讀 asn-me.json 的 closeTo；系統匣圖示永遠建立（左鍵叫回、右鍵開啟／結束）
            let to_tray = std::fs::read_to_string(frame_data_dir.join("asn-me.json")).map(|t| tray::close_to_tray_from_saved(&t)).unwrap_or(true);
            tray::init(&handle, to_tray);
            tray::build(&handle);
            // 畫面端（名單視窗）超過 5 分鐘沒收信（開機自啟縮在系統匣、畫面沒在跑）：Rust 代收寄給本機 ASN 視窗的信並 ack，
            // 存進代收區等畫面下次收信時交給它；匣圖示提示框顯示未讀數，並通知畫面（開著時立刻補收）。--shot 截圖模式不動
            if handle.state::<App>().shot.is_none() {
                let h = handle.clone();
                let every = std::time::Duration::from_millis(env_ms("ASN_WINDOW_FALLBACK_MS", 30_000));
                let stale = env_ms("ASN_WINDOW_STALE_MS", relay::UI_STALE_MS);
                tauri::async_runtime::spawn(async move {
                    loop {
                        tokio::time::sleep(every).await;
                        let Some(r) = h.state::<App>().relay.clone() else { return };
                        match r.fallback_tick(heartbeat::now_ms(), stale).await {
                            Ok(n) if n > 0 => {
                                elog!("window fallback: took {n} mail(s) for ASN window, spool={}", r.spool_len());
                                tray::set_tray_unread(h.clone(), r.spool_len() as u32);
                                let _ = h.emit("window-spool", r.spool_len());
                            }
                            Ok(_) => {}
                            Err(e) => elog!("window fallback failed: {e}"),
                        }
                    }
                });
            }
            // Claude 帳號自動加入／回存：啟動後 15 秒起每 60 秒一次（asn-me.json 的 autoAddClaude 開著才動，預設開）；--shot 截圖模式不動
            if handle.state::<App>().shot.is_none() {
                let h = handle.clone();
                let every = std::time::Duration::from_millis(env_ms("ASN_CLAUDE_AUTO_MS", 60_000));
                tauri::async_runtime::spawn(claude_accounts::auto_loop(auto_acct_dir.clone(), std::time::Duration::from_secs(15), every, move |o| {
                    let _ = h.emit("claude-account-auto", o);
                }));
            }
            // Grok 帳號自動加入／回存：啟動後 20 秒起每 60 秒一次（沒登入 Grok 就什麼都不動）；--shot 截圖模式不動
            if handle.state::<App>().shot.is_none() {
                let h = handle.clone();
                let every = std::time::Duration::from_millis(env_ms("ASN_GROK_AUTO_MS", 60_000));
                tauri::async_runtime::spawn(grok_accounts::auto_loop(std::time::Duration::from_secs(20), every, move |o| {
                    let _ = h.emit("grok-account-auto", o);
                }));
            }
            // pi 與 ASN 互通（#240 方案 A）預設開啟：啟動後 20 秒，第一次偵測到 pi 且還沒裝就自動安裝；使用者在設定關掉後不再裝回；--shot 截圖模式不動
            if handle.state::<App>().shot.is_none() {
                tauri::async_runtime::spawn(async {
                    tokio::time::sleep(std::time::Duration::from_secs(20)).await;
                    match tauri::async_runtime::spawn_blocking(launch::pi_setup::auto_install_real).await {
                        Ok(Some(Ok(_))) => elog!("pi 與 ASN 互通：已自動安裝擴充"),
                        Ok(Some(Err(e))) => elog!("pi 與 ASN 互通：自動安裝沒成功：{e}"),
                        _ => {}
                    }
                });
            }
            // Claude Code 外掛：啟動後 5 秒在背景安裝一次（找不到 claude 就略過；有標記檔就不再碰；--shot 截圖模式不動）
            if handle.state::<App>().shot.is_none() {
                let h = handle.clone();
                let dir = auto_acct_dir.clone();
                *handle.state::<claude_mod::ModState>().0.lock().unwrap() = "Claude 外掛：檢查中…".into();
                if claude_mod::auto_on(&dir) {
                    claude_mod::set_report(Some(serde_json::json!({ "state": "checking" })));   // 內建收發室下一輪名單回報時帶給後台；關閉自動安裝時不回報
                }
                tauri::async_runtime::spawn(async move {
                    tokio::time::sleep(std::time::Duration::from_secs(5)).await;
                    let out = tauri::async_runtime::spawn_blocking(move || claude_mod::run_real(&dir)).await.unwrap_or_else(|_| claude_mod::Outcome::Failed("背景工作中斷".into()));
                    if out.reportable() {
                        claude_mod::set_report(Some(out.report()));
                    }
                    let line = out.line();
                    *h.state::<claude_mod::ModState>().0.lock().unwrap() = line.clone();
                    let _ = h.emit("claude-mod-status", line);
                });
            }
            // 開機自動啟動帶 --background：只常駐系統匣，不跳出名單（系統匣建失敗就照常顯示）
            if background && !handle.state::<tray::TrayFailed>().0.load(std::sync::atomic::Ordering::Relaxed) {
                if let Some(w) = handle.get_webview_window("list") {
                    let _ = w.hide();
                }
            }
            }
            // 已登入且這台有節點金鑰：每次啟動在背景綁一次到帳號（舊租戶還沒被認領時會失敗，不擋使用，下次啟動再試）
            if relay_obj.is_some() && handle.state::<auth::AuthState>().status().signed_in {
                let h = handle.clone();
                tauri::async_runtime::spawn(async move {
                    tokio::time::sleep(std::time::Duration::from_secs(2)).await;
                    let _ = account::bind_this(&h.state::<App>(), &h.state::<auth::AuthState>()).await;
                });
            }
            #[cfg(desktop)]
            {
            // 密碼小幫手的管道（git／ssh 的 askpass 請 ASN 跳窗收密碼）：--shot 截圖模式不啟動
            if handle.state::<App>().shot.is_none() {
                askpass::dialog::start(&handle);
            }
            // 內建收發室橋：設定打開才啟動（預設關）；--shot 截圖模式不啟動
            if handle.state::<App>().shot.is_none() {
                handle.state::<bridge::Manager>().start_if_enabled();
                // 啟動時舊版收發室橋在跑而讓步的話，舊橋一退出就自動接手（設定仍開著）
                let h2 = handle.clone();
                tauri::async_runtime::spawn(async move {
                    loop {
                        tokio::time::sleep(std::time::Duration::from_secs(5)).await;
                        h2.state::<bridge::Manager>().poll_handoff();
                    }
                });
            }
            // 正在聽的歌：輪詢執行緒常駐，但開關預設關（前端交來開才讀）；--shot 截圖模式不啟動
            if let (Some(r), Some(rx)) = (relay_obj.clone(), now_wake_rx.lock().unwrap().take()) {
                if handle.state::<App>().shot.is_none() {
                    let h = handle.clone();
                    let r6 = r.clone();
                    nowplaying::spawn_poller(r.now_playing.clone(), rx, move |v| {
                        r6.presence_wake.notify_one();
                        let _ = h.emit("asn:now-playing", v);
                    });
                }
            }
            }
            if let Some(r) = relay_obj.clone() {
                // 心跳：每 30 秒寫一次（格式同 self-recv.mjs），pid 用本程式
                let wd = work_dir.clone();
                let r2 = r.clone();
                // 啟動時把視窗名同步成這台設備的顯示名（別台設備的前台依設備分組時顯示它）
                let r3 = r.clone();
                tauri::async_runtime::spawn(async move { r3.sync_device_name().await });
                // 帳號回報：啟動後 5 秒起每 5 分鐘一次，停在登入畫面也照跑（用節點金鑰，不用本人登入）；--shot 截圖模式不動
                #[cfg(desktop)]
                if handle.state::<App>().shot.is_none() {
                    let (r6, wd6) = (r.clone(), work_dir.clone());
                    let every = std::time::Duration::from_secs(300);
                    tauri::async_runtime::spawn(acct_remote::report_loop(std::time::Duration::from_secs(5), every, move || report_accounts(r6.clone(), wd6.clone())));
                }
                // 在線狀態與版本：啟動後（等前端把狀態交過來）與每 60 秒回報一次；前端改狀態會叫醒立刻回報。
                // 後台還沒部署（404／400）就停止，直到下次啟動；--shot 模式連的是本機假後端。
                let r4 = r.clone();
                let up_handle = handle.clone();
                tauri::async_runtime::spawn(async move {
                    let every = std::time::Duration::from_millis(env_ms("ASN_PRESENCE_MS", 60_000));
                    tokio::time::sleep(std::time::Duration::from_secs(2)).await;
                    while r4.report_presence(env!("CARGO_PKG_VERSION"), std::time::Duration::from_secs(10)).await {
                        // 本人在別台按了「更新」：用內建更新器自己下載、驗簽、安裝、重開（失敗回報原因）。手機版沒有內建更新器（走應用程式商店）
                        #[cfg(desktop)]
                        if r4.take_update_request() {
                            let (h, r5) = (up_handle.clone(), r4.clone());
                            tauri::async_runtime::spawn(async move {
                                match updater::run_remote(&h).await {
                                    Ok(updater::Remote::Latest) => r5.report_update_result(true, "已是最新版").await,
                                    Ok(_) => {}
                                    Err(e) => r5.report_update_result(false, &e).await,
                                }
                            });
                        }
                        // 本人在手機上要這台安裝並登入 Claude Code：本機三道把關（開關、已登入、同一個人）過了才做
                        #[cfg(desktop)]
                        if let Some(by) = r4.take_setup_request() {
                            tauri::async_runtime::spawn(run_remote_setup(up_handle.clone(), r4.clone(), by));
                        }
                        tokio::select! {
                            _ = tokio::time::sleep(every) => {}
                            _ = r4.presence_wake.notified() => {}
                        }
                    }
                });
                let mut last: Vec<String> = vec![];
                tauri::async_runtime::spawn(async move {
                    loop {
                        // 現用名與還沒過期的舊名各寫一份心跳；掉出清單的清掉
                        let names = r2.active_names();
                        for gone in last.iter().filter(|n| !names.contains(n)) {
                            heartbeat::clear_heartbeat(&wd, gone, std::process::id());
                        }
                        for n in &names {
                            if let Err(e) = heartbeat::write_heartbeat(&wd, n, std::process::id(), heartbeat::now_ms()) {
                                elog!("heartbeat failed: {e}");
                            }
                        }
                        last = names;
                        tokio::time::sleep(std::time::Duration::from_millis(heartbeat::heartbeat_ms())).await;
                    }
                });
                // 遠端密碼請求（#26 第二期）的確認端：門鈴響或每 60 秒保底查一次待確認；沒登入就不打後台。--shot 截圖模式不啟動
                #[cfg(desktop)]
                let secret_wake = if handle.state::<App>().shot.is_none() { Some(secret_remote::desktop::start(&handle, r.clone())) } else { None };
                #[cfg(desktop)]
                let term_wake = if handle.state::<App>().shot.is_none() {
                    let w = Arc::new(tokio::sync::Notify::new());
                    start_perm_remote_poller(handle.clone(), r.clone(), handle.state::<Arc<launch::term::LiveTerms>>().inner().clone(), handle.state::<App>().data_dir.clone());
                    start_device_key_publish(r.clone(), handle.state::<App>().data_dir.clone());
                    start_view_poller(handle.clone(), r.clone(), handle.state::<Arc<launch::term::LiveTerms>>().inner().clone(), handle.state::<App>().data_dir.clone(), handle.state::<App>().node.clone());
                    start_term_remote_poller(
                        handle.clone(),
                        r.clone(),
                        handle.state::<Arc<launch::term::LiveTerms>>().inner().clone(),
                        handle.state::<App>().data_dir.clone(),
                        w.clone(),
                    );
                    Some(w)
                } else {
                    None
                };
                // 門鈴：有 anon 金鑰才開；一響就叫前端去拉信
                if let Some(url) = anon_url {
                    let h = handle.clone();
                    #[cfg(desktop)]
                    let term_wake_bell = term_wake.clone();
                    tauri::async_runtime::spawn(async move {
                        let topic = loop {
                            match r.api("whoami", None).await {
                                Ok(v) => match v.get("bell_topic").and_then(Value::as_str) {
                                    Some(t) => break t.to_string(),
                                    None => tokio::time::sleep(std::time::Duration::from_secs(10)).await,
                                },
                                Err(_) => tokio::time::sleep(std::time::Duration::from_secs(5)).await,
                            }
                        };
                        bell::run(url, topic, move |_| {
                            let _ = h.emit("relay-bell", ());
                            #[cfg(desktop)]
                            if let Some(w) = &secret_wake {
                                w.notify_one();
                            }
                            #[cfg(desktop)]
                            if let Some(w) = &term_wake_bell {
                                w.notify_one();
                            }
                        })
                        .await;
                    });
                }
            }
            Ok(())
        });
    #[cfg(desktop)]
    let builder = builder
        .on_window_event(|w, ev| {
            // 關掉名單視窗：設定「縮到系統匣」（預設）就只藏起來，程序與收信照常；設「結束程式」才真的結束
            if w.label() == "list" {
                if let tauri::WindowEvent::CloseRequested { api, .. } = ev {
                    let h = w.app_handle();
                    if tray::should_hide_on_close(&h.state::<tray::CloseToTray>(), &h.state::<tray::TrayFailed>()) {
                        api.prevent_close();
                        let _ = w.hide();
                    } else {
                        cleanup(h);
                        h.exit(0);
                    }
                }
            }
        });
    let app = builder
        .build(tauri::generate_context!())
        .expect("ASN 啟動失敗");

    app.run(move |h, ev| {
        if let tauri::RunEvent::Exit = ev {
            #[cfg(desktop)]
            ui_log::log_exit(&exit_log_dir, "正常結束");
            cleanup(h);
        }
    });
}

#[cfg(all(test, feature = "gui"))]
mod tests {
    #[test]
    fn 守門_紀錄只寫機器資料夾的_ui_log_不寫_data_dir() {
        let src = include_str!("lib.rs");
        let code = src.split("\nmod tests {").next().unwrap();
        for bad in ["ui_log::append(&self.data_dir", "ui_log::append(&data_dir", "ui_log::append(&app.data_dir"] {
            assert!(!code.contains(bad), "紀錄要寫到 work_dir 的 ui.log：{bad}");
        }
    }

    #[test]
    fn 守門_截圖模式不登記_asn_協定_不改使用者的登錄檔() {
        let src = include_str!("lib.rs").split("mod tests {").next().unwrap();
        let at = src.find("dl.register(\"asn\")").expect("有登記 asn:// 的地方");
        let before = &src[at.saturating_sub(120)..at];
        assert!(before.contains("if !is_shot"), "登記 asn:// 前要擋掉截圖模式：{before}");
    }

    use super::*;

    #[test]
    fn 訊息連結只准一般網址() {
        assert!(link_allowed("https://example.com/a?b=1&c=2#x") && link_allowed("http://example.org:8080/"));
        for bad in ["", "javascript:alert(1)", "data:text/html,<script>1</script>", "file:///C:/Windows/system32/calc.exe", "ftp://x.com/", "mailto:a@b.c",
                    "https://u:p@example.com/", "https://example.com/a b", "https://example.com/\n", "//example.com", "calc.exe", "\\\\server\\share"] {
            assert!(!link_allowed(bad), "{bad:?} 不該放行");
        }
        assert!(!link_allowed(&format!("https://example.com/{}", "a".repeat(2000))));
    }

    #[test]
    fn 視窗名規則與預設值() {
        assert_eq!(default_window_name("H"), "H-ASN");
        assert!(valid_window_name("家用-ASN"));
        assert!(!valid_window_name("") && !valid_window_name(" x") && !valid_window_name("a\nb") && !valid_window_name(&"字".repeat(61)));
    }

    #[test]
    fn 自動產生的節點代號辨識_舊電腦手動代號不受影響() {
        for id in ["t5-ab12cd34", "t12-00000000", "n1a2b3c4d"] {
            assert!(is_auto_node_id(id), "{id}");
        }
        for id in ["H", "w02", "cloud", "t5-ab12cd3", "t5-ab12cd345", "t-ab12cd34", "t5ab12cd34", "n1a2b3c4", "t5-AB12CD34", "n1a2b3c4g", "home-pc", ""] {
            assert!(!is_auto_node_id(id), "{id}");
        }
    }

    #[test]
    fn 視窗名預設值_新電腦用電腦名稱_不含節點代號() {
        assert_eq!(default_window_name_for("H", "PC-1"), "H-ASN", "手動代號照舊");
        assert_eq!(default_window_name_for("w02", "PC-1"), "w02-ASN");
        let n = default_window_name_for("t5-ab12cd34", "  小良的電腦\n");
        assert_eq!(n, "小良的電腦-ASN");
        assert!(!n.contains("ab12cd34") && !n.contains("t5"));
        assert!(valid_window_name(&n));
        // 電腦名稱太長或空白：視窗名仍合格
        let long = default_window_name_for("n1a2b3c4d", &"字".repeat(80));
        assert!(valid_window_name(&long) && long.chars().count() <= 40);
        assert_eq!(default_window_name_for("n1a2b3c4d", "  "), "我的電腦-ASN");
    }

    #[test]
    fn 設定檔讀寫_壞檔或不合格就當沒設() {
        let d = tempfile::tempdir().unwrap();
        assert_eq!(read_settings_name(d.path()), None);
        write_atomic(&d.path().join("settings.json"), r#"{"window_name":"我的ASN"}"#).unwrap();
        assert_eq!(read_settings_name(d.path()).as_deref(), Some("我的ASN"));
        write_atomic(&d.path().join("settings.json"), r#"{"window_name":" bad"}"#).unwrap();
        assert_eq!(read_settings_name(d.path()), None);
        write_atomic(&d.path().join("settings.json"), "{壞掉").unwrap();
        assert_eq!(read_settings_name(d.path()), None);
    }

    #[test]
    fn machine_log_dir_只准_relay_home_底下的_machine_節點() {
        let root = tempfile::tempdir().unwrap();
        let relay = root.path().join("relay-home");
        std::fs::create_dir_all(relay.join("machine-H")).unwrap();
        let ok = relay.join("machine-H");
        assert_eq!(machine_log_dir_for(&ok, &relay).unwrap(), ok);
        assert!(machine_log_dir_for(root.path().join("etc/passwd").as_path(), &relay).is_err());
        assert!(machine_log_dir_for(&relay.join("machine-../etc"), &relay).is_err());
        assert!(machine_log_dir_for(&relay.join("machine-bad!"), &relay).is_err());
        assert!(machine_log_dir_for(&relay.join("other-H"), &relay).is_err());
    }
}

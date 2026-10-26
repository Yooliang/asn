//! ASN 即時通（Tauri 2）：金鑰、anon 金鑰、收發室 HTTP／WebSocket、心跳檔、設定與對話存檔都在 Rust 端；
//! 前端（ui/）只拿得到「信件與名單」，拿不到任何金鑰。
//! 電腦版（desktop）與安卓版共用同一份：電腦端才有的模組都掛 `#[cfg(desktop)]`，手機建置不編譯（設計見 docs/design/ANDROID.md）。
// 手機版沒有電腦端的功能，那些共用程式裡只給電腦用的函式在手機建置會變成「沒人叫」：不當成警告
#![cfg_attr(not(desktop), allow(dead_code, unused_variables, unused_imports))]
// 無視窗版（沒有 gui）不編視窗與指令那一半，留下的共用函式與型別在這裡看起來「沒人叫」：不當成警告
#![cfg_attr(not(feature = "gui"), allow(dead_code, unused_variables, unused_imports))]
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
mod home;
mod identity;
mod invite_link;
mod lastlogin;
mod names;
mod nowin;
mod nowplaying;
mod relay;
pub mod rt;
// ---- 安卓版專屬 ----
#[cfg(target_os = "android")]
mod android;
// ---- 只有電腦版有的模組（內建收發室橋、開 Claude／Codex 視窗與切換模型、密碼小幫手、Claude 帳號與外掛、用量、聽歌狀態、截圖、語音、系統匣、自動更新、多視窗）。
// 手機建置不編譯它們；守門測試 test/android.test.mjs 會檢查每一個都掛著 cfg(desktop) ----
#[cfg(desktop)]
mod acct_remote;
#[cfg(feature = "gui")]
#[cfg(desktop)]
mod ads;
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
#[cfg(desktop)]
mod cloud_invite;
#[cfg(desktop)]
mod codex_accounts;
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
mod updater;
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
async fn relay_launchers(app: State<'_, App>, ids: Option<Vec<String>>) -> Result<Value, String> {
    launch::relay_launchers(relay_of(&app)?.as_ref(), ids).await
}

// ---------- 遠端切換 Claude 帳號（設計見 acct_remote.rs；權杖只在各自那台搬，不進收發室） ----------
/// 把本機帳號庫的清單（只有 email、方案、使用中）回報給收發室，讓擁有者設備看得到
#[cfg(feature = "gui")]
#[cfg(desktop)]
#[tauri::command]
async fn acct_remote_report(app: State<'_, App>) -> Result<Value, String> {
    let relay = relay_of(&app)?;
    let list = tauri::async_runtime::spawn_blocking(claude_accounts::local_list).await.map_err(|e| e.to_string())?;
    // Codex 目前登入（只有 email／方案）；讀不到或沒登入就不放，不影響 Claude 的回報
    let codex = tauri::async_runtime::spawn_blocking(codex_accounts::codex_account_current).await.ok().and_then(|r| r.ok()).flatten();
    // 各帳號上次記下的額度（沒有紀錄的帳號不帶額度欄位）
    let quotas = tauri::async_runtime::spawn_blocking(|| claude_quota::load_all(&claude_accounts::claude_home())).await.unwrap_or_default();
    acct_remote::report(relay.as_ref(), &list, codex.as_ref(), &quotas).await
}
#[cfg(feature = "gui")]
#[cfg(desktop)]
#[tauri::command]
async fn acct_remote_list(app: State<'_, App>, node: String) -> Result<Value, String> {
    acct_remote::remote_list(relay_of(&app)?.as_ref(), &node).await
}
#[cfg(feature = "gui")]
#[cfg(desktop)]
#[tauri::command]
async fn acct_remote_request(app: State<'_, App>, node: String, email: String) -> Result<Value, String> {
    acct_remote::remote_request(relay_of(&app)?.as_ref(), &node, &email).await
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
    acct_remote::decline(relay_of(&app)?.as_ref(), id).await
}
#[cfg(feature = "gui")]
#[cfg(desktop)]
#[tauri::command]
fn acct_remote_trust_get(app: State<'_, App>) -> bool {
    acct_remote::trust_own(&app.data_dir)
}
#[cfg(feature = "gui")]
#[cfg(desktop)]
#[tauri::command]
fn acct_remote_trust_set(app: State<'_, App>, on: bool) -> Result<(), String> {
    acct_remote::set_trust_own(&app.data_dir, on)
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
async fn term_send(terms: State<'_, Arc<launch::term::LiveTerms>>, req: launch::term::TermSendReq) -> Result<(), String> {
    let terms = terms.inner().clone();
    launch::blocking_timeout(move || terms.confirm_send(&req.id, &req.text, req.enter)).await
}

/// 讀自己開的終端。lines 是從畫面底部往回的行數，超過上限會被拒絕。
#[cfg(feature = "gui")]
#[cfg(desktop)]
#[tauri::command]
async fn term_read(terms: State<'_, Arc<launch::term::LiveTerms>>, req: launch::term::TermReadReq) -> Result<String, String> {
    let terms = terms.inner().clone();
    launch::blocking_timeout(move || terms.read(&req.id, req.lines)).await
}

/// 目前自己開著的終端：編號、profile、程序編號、啟動時記下的建立時間。
#[cfg(feature = "gui")]
#[cfg(desktop)]
#[tauri::command]
fn term_list(terms: State<'_, Arc<launch::term::LiveTerms>>) -> Vec<launch::term::TermListed> {
    terms.list()
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
async fn term_answer(terms: State<'_, Arc<launch::term::LiveTerms>>, req: launch::term::TermAnswerReq) -> Result<launch::term::TermAnswered, String> {
    let terms = terms.inner().clone();
    launch::blocking_timeout(move || terms.answer(&req.id, &req.prompt_kind, req.n)).await
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
        eprintln!("[asn-ui {level}] {message}");
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
/// 電腦版名單右鍵管理夥伴視窗（詳情、改名、關閉、接班換手、喚醒）：和手機同一個後台動作，要本人簽章；沒登入回錯，不打後台。回 { id }
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

    // --shot 只准連本機假後端（紅線：測試不碰真實 relay）
    if shot.is_some() {
        // 看環境變數指的後台網址（沒有金鑰、模擬新電腦的截圖也要擋住真實後台）
        let u = identity::base_url(crate::envc::get("ASN_RELAY_URL"));
        let ok = u.starts_with("http://127.0.0.1") || u.starts_with("http://localhost");
        if !ok {
            eprintln!("--shot 只能搭配指向本機假後端的 ASN_RELAY_URL（http://127.0.0.1…）");
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

    // 同一個視窗名只留一個 ASN（另一個還活著就退出，同 recv.mjs 的 exit 3）。
    // 這個新開的是被邀請連結叫起來的（asn://invite/<碼>）：先把碼放進信箱檔，正在跑的那個 ASN 會取走並跳出「加入群組」
    if let Some(r) = &relay_obj {
        if let Some(h) = heartbeat::other_instance(&work_dir, &r.window_name(), std::process::id()) {
            let args: Vec<String> = std::env::args().skip(1).collect();
            if let Some(code) = invite_link::invite_code_from_args(&args) {
                let _ = invite_link::drop_in_inbox(&work_dir, &code);
            }
            eprintln!("視窗「{}」已經有一個 ASN 在跑（pid {}）", r.window_name(), h.pid);
            std::process::exit(3);
        }
    }

    #[cfg(desktop)]
    let term_data_dir = data_dir.clone();
    let frame_data_dir = data_dir.clone();
    let bridge_data_dir = data_dir.clone();
    let auto_acct_dir = data_dir.clone();
    let auth_state = auth::AuthState::new(auth::default_store(&data_dir));
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
        .manage(wins::Frame::default())
        .manage(tray::CloseToTray::default())
        .manage(tray::TrayFailed::default())
        .manage(shot::ShotState::default())
        .manage(updater::Pending::default())
        .manage(SaveDir::default())
        .manage(claude_mod::ModState::default())
        .manage(bridge_mgr)
        .manage(Arc::new(launch::term::live(&term_data_dir)))
        .manage(Arc::new(askpass::dialog::DialogState::default()))
        .plugin(tauri_plugin_updater::Builder::new().build());
    // 安卓版專屬：開系統瀏覽器（登入、點連結）
    #[cfg(target_os = "android")]
    let builder = builder.plugin(tauri_plugin_opener::init());
    #[cfg(desktop)]
    let builder = builder
        .invoke_handler(tauri::generate_handler![
            startup_info, relay_list, relay_inbox, relay_ack, relay_send, relay_chat_history, relay_read_sync, relay_partner_list, relay_partner_succeed, relay_partner_op, relay_partner_ops, relay_partner_archive, relay_sent_status, relay_send_attachment, relay_attachment_fetch, relay_attachment_save, relay_attachment_reveal, relay_avatar, relay_set_avatar, relay_rooms, relay_group, relay_room_read, relay_room_post, invite_pending, relay_launch, relay_launchers, partner_launch_local, local_windows, launch_cwd_candidates, launch_cwd_browse, partner_console_query, partner_console_set, model_switch_query, model_switch_run, subagents_query, launch_prefs_get, launch_prefs_set, pi_setup_status, pi_setup_install, pi_setup_remove, term_start, term_send, term_read, term_list, term_stop, term_status, term_rename, term_answer, relay_log_paths, open_machine_log_dir, shot_frontend_log, open_url, open_link, ads::ads_fetch, set_window_name, set_presence, set_now_playing, bridge_status, bridge_set_enabled, bridge_set_remote_launch, bridge_set_unaddressed_to, bridge_takeover, cli_info, askpass::dialog::askpass_info, askpass::dialog::askpass_answer, askpass::dialog::askpass_helper_info, store_load, store_save, quit_app,
            shot::shot_begin, shot::shot_image, shot::shot_ready, shot::shot_focus, shot::shot_pick, shot::shot_cancel, shot::shot_supported,
            claude_accounts::claude_accounts_list, claude_accounts::claude_account_current, claude_accounts::claude_account_save, claude_accounts::claude_account_switch, claude_accounts::claude_account_delete, claude_mod::claude_mod_status, claude_quota::claude_quota_all,
            codex_accounts::codex_account_current, usage::usage_summary,
            acct_remote_report, acct_remote_list, acct_remote_request, acct_remote_status, acct_remote_pending, acct_remote_apply, acct_remote_decline, acct_remote_trust_get, acct_remote_trust_set,
            voice_cfg_get, voice_cfg_set, tts::tts_voices, tts::tts_speak, stt::stt_status, stt::stt_install, stt::stt_transcribe,
            agent_tools::ai_cli_detect, agent_tools::ai_cli_install, agent_tools::ai_cli_login, stt::stt_cancel,
            wins::open_chat, wins::open_panel, wins::close_panels, wins::chat_visible, wins::close_chats, wins::open_windows, wins::main_visible, wins::show_main, wins::main_layout, wins::shake, wins::show_toast, wins::toast_click, wins::win_ctl, wins::frame_native, wins::set_frame, wins::take_shot, capture_ui_ready,
            account::auth_status, account::last_login_set_avatar, account::auth_login, account::auth_cancel, account::auth_logout, account::auth_account_info, account::auth_account_name_set, account::auth_ai_wake_limit_get, account::auth_ai_wake_limit_set, account::auth_device_prefs_get, account::auth_device_prefs_set, account::auth_bind, account::auth_skip_login, account::update_remote_request, account::update_remote_status,
            cloud_invite::cloud_agent_create, cloud_invite::cloud_agent_list, cloud_invite::cloud_agent_revoke, cloud_invite::cloud_agent_approve,
            tray::set_close_to_tray, tray::set_tray_unread, tray::tray_available, tray::autostart_supported, tray::autostart_get, tray::autostart_blocked, tray::autostart_set, updater::update_check, updater::update_install,
        ]);
    // 手機只開放單欄名單與對話需要的指令；電腦端的指令（開視窗、橋、用量……）手機上根本不存在
    #[cfg(not(desktop))]
    let builder = builder.invoke_handler(tauri::generate_handler![
        startup_info, relay_list, relay_inbox, relay_ack, relay_rooms, relay_group, invite_pending, relay_send, relay_chat_history, relay_read_sync, relay_sent_status, relay_send_attachment, relay_attachment_fetch, relay_avatar, relay_set_avatar,
        set_presence, set_window_name, store_load, store_save, quit_app, capture_ui_ready, shot_frontend_log, open_link,
        account::auth_status, account::last_login_set_avatar, account::auth_login, account::auth_cancel, account::auth_logout, account::auth_account_info, account::auth_account_name_set, account::auth_ai_wake_limit_get, account::auth_ai_wake_limit_set, account::auth_device_prefs_get, account::auth_device_prefs_set, account::auth_bind,
        android::relay_attachment_save, android::android_update_check, android::android_update_download, android::android_launchers, android::android_launch, android::android_partner_op, android::android_partner_ops, android::android_partner_archive, android::android_acct_list, android::android_acct_switch, android::android_acct_status, android::android_secret_pending, android::android_secret_reply, android::android_room_read, android::android_room_post, relay_partner_list, relay_partner_succeed,
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
                // 沒經過安裝程式（開發、綠色版）也讓 asn:// 指到這個程式；失敗不影響其他功能
                #[cfg(any(windows, target_os = "linux"))]
                let _ = dl.register("asn");
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
                                eprintln!("window fallback: took {n} mail(s) for ASN window, spool={}", r.spool_len());
                                tray::set_tray_unread(h.clone(), r.spool_len() as u32);
                                let _ = h.emit("window-spool", r.spool_len());
                            }
                            Ok(_) => {}
                            Err(e) => eprintln!("window fallback failed: {e}"),
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
            // Claude Code 外掛：啟動後 5 秒在背景安裝一次（找不到 claude 就略過；有標記檔就不再碰；--shot 截圖模式不動）
            if handle.state::<App>().shot.is_none() {
                let h = handle.clone();
                let dir = auto_acct_dir.clone();
                *handle.state::<claude_mod::ModState>().0.lock().unwrap() = "Claude 外掛：檢查中…".into();
                claude_mod::set_report(Some(serde_json::json!({ "state": "checking" })));   // 內建收發室下一輪名單回報時帶給後台
                tauri::async_runtime::spawn(async move {
                    tokio::time::sleep(std::time::Duration::from_secs(5)).await;
                    let out = tauri::async_runtime::spawn_blocking(move || claude_mod::run_real(&dir)).await.unwrap_or_else(|_| claude_mod::Outcome::Failed("背景工作中斷".into()));
                    claude_mod::set_report(Some(out.report()));
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
                                eprintln!("heartbeat failed: {e}");
                            }
                        }
                        last = names;
                        tokio::time::sleep(std::time::Duration::from_millis(heartbeat::heartbeat_ms())).await;
                    }
                });
                // 遠端密碼請求（#26 第二期）的確認端：門鈴響或每 60 秒保底查一次待確認；沒登入就不打後台。--shot 截圖模式不啟動
                #[cfg(desktop)]
                let secret_wake = if handle.state::<App>().shot.is_none() { Some(secret_remote::desktop::start(&handle, r.clone())) } else { None };
                // 門鈴：有 anon 金鑰才開；一響就叫前端去拉信
                if let Some(url) = anon_url {
                    let h = handle.clone();
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

    app.run(|h, ev| {
        if let tauri::RunEvent::Exit = ev {
            cleanup(h);
        }
    });
}

#[cfg(all(test, feature = "gui"))]
mod tests {
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

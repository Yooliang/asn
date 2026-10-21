//! ASN 即時通（Tauri 2）：金鑰、anon 金鑰、收發室 HTTP／WebSocket、心跳檔、設定與對話存檔都在 Rust 端；
//! 前端（ui/）只拿得到「信件與名單」，拿不到任何金鑰。
mod agent_tools;
mod attach;
mod avatar;
mod bell;
mod claude_accounts;
mod claude_json;
mod heartbeat;
mod identity;
mod launch;
mod names;
mod nowin;
mod relay;
mod shot;
mod stt;
mod tray;
mod tts;
mod updater;
mod voicecfg;
mod wins;

use relay::Relay;
use serde::Serialize;
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager, State};

/// 所有視窗共用的瀏覽器啟動參數（必須一致，否則第二扇視窗建不起來）。WebView2 才支援自動播放參數；Linux WebKitGTK 略過。
#[cfg(windows)]
pub const BROWSER_ARGS: &str = "--autoplay-policy=no-user-gesture-required";
#[cfg(not(windows))]
pub const BROWSER_ARGS: &str = "";

pub struct App {
    pub relay: Option<Arc<Relay>>,
    pub init_error: Option<String>,
    pub node: String,
    pub work_dir: PathBuf,
    pub data_dir: PathBuf,
    pub shot: Option<PathBuf>,
}

#[derive(Serialize)]
struct StartupInfo {
    node: String,
    window_name: String,
    old_names: Vec<String>,
    error: Option<String>,
    shot: bool,
    poll_ms: u64,
    roster_ms: u64,
    version: String,
}

fn env_ms(k: &str, d: u64) -> u64 {
    std::env::var(k).ok().and_then(|v| v.parse().ok()).unwrap_or(d)
}

/// 視窗名：預設 `<節點>-ASN`；設定檔 settings.json 的 window_name 可改
pub fn default_window_name(node: &str) -> String {
    format!("{node}-ASN")
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

#[tauri::command]
fn startup_info(app: State<'_, App>) -> StartupInfo {
    StartupInfo {
        node: app.node.clone(),
        window_name: app.relay.as_ref().map(|r| r.window_name()).unwrap_or_default(),
        old_names: app.relay.as_ref().map(|r| r.active_names().into_iter().skip(1).collect()).unwrap_or_default(),
        error: app.init_error.clone(),
        shot: app.shot.is_some(),
        poll_ms: env_ms("IRORI_ASN_POLL_MS", 120_000),
        roster_ms: env_ms("IRORI_ASN_ROSTER_MS", 60_000),
        version: env!("CARGO_PKG_VERSION").into(),
    }
}

fn relay_of(app: &App) -> Result<Arc<Relay>, String> {
    app.relay.clone().ok_or_else(|| app.init_error.clone().unwrap_or_else(|| "尚未連上收發室".into()))
}

#[tauri::command]
async fn relay_list(app: State<'_, App>) -> Result<Value, String> {
    relay_of(&app)?.list().await
}
#[tauri::command]
async fn relay_inbox(app: State<'_, App>) -> Result<Value, String> {
    relay_of(&app)?.inbox().await
}
#[tauri::command]
async fn relay_ack(app: State<'_, App>, ids: Vec<String>) -> Result<Value, String> {
    relay_of(&app)?.ack(&ids).await
}
/// 群組列表：只讀（GET room_list），後端只回節點自己所在的群組
#[tauri::command]
async fn relay_rooms(app: State<'_, App>) -> Result<Value, String> {
    relay_of(&app)?.api("room_list", None).await
}

#[tauri::command]
async fn relay_launch(app: State<'_, App>, body: Value) -> Result<Value, String> {
    launch::relay_launch(relay_of(&app)?.as_ref(), body).await
}

#[tauri::command]
async fn relay_launchers(app: State<'_, App>, ids: Option<Vec<String>>) -> Result<Value, String> {
    launch::relay_launchers(relay_of(&app)?.as_ref(), ids).await
}

#[tauri::command]
async fn partner_launch_local(app: State<'_, App>, req: launch::LocalLaunchReq) -> Result<Value, String> {
    launch::partner_launch_local(app.node.clone(), app.work_dir.clone(), app.data_dir.clone(), req).await
}

#[tauri::command]
async fn launch_cwd_candidates(app: State<'_, App>) -> Result<Vec<String>, String> {
    launch::launch_cwd_candidates(app.data_dir.clone()).await
}

/// 「瀏覽…」：在 Rust 端開「選擇資料夾」對話框；選好的資料夾寫進本機白名單並回傳，取消回 null。
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

#[tauri::command]
async fn partner_console_query(req: launch::PartnerConsoleReq) -> Result<Value, String> {
    launch::partner_console_query(req).await
}

#[tauri::command]
async fn partner_console_set(req: launch::PartnerConsoleReq) -> Result<Value, String> {
    launch::partner_console_set(req).await
}

#[tauri::command]
async fn launch_prefs_get(app: State<'_, App>) -> Result<Value, String> {
    launch::launch_prefs_get(app.data_dir.clone()).await
}

#[tauri::command]
async fn launch_prefs_set(app: State<'_, App>, prefs: Value) -> Result<(), String> {
    launch::launch_prefs_set(app.data_dir.clone(), prefs).await
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RelayLogPaths {
    bridge_log: String,
    machine_dir: String,
}

/// 收發橋與夥伴啟動相關紀錄的路徑（不含金鑰）。
#[tauri::command]
fn relay_log_paths(app: State<'_, App>) -> RelayLogPaths {
    let machine_dir = app.work_dir.clone();
    RelayLogPaths {
        bridge_log: machine_dir.join("bridge.log").display().to_string(),
        machine_dir: machine_dir.display().to_string(),
    }
}

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

pub fn machine_log_dir(work_dir: &Path) -> Result<PathBuf, String> {
    machine_log_dir_for(work_dir, &identity::relay_home())
}

/// 用檔案管理員開啟本機 machine 資料夾（內含 bridge.log）；不接受任何路徑參數。
#[tauri::command]
fn open_machine_log_dir(app: State<'_, App>) -> Result<(), String> {
    let dir = machine_log_dir(&app.work_dir)?;
    open_in_file_manager(&dir)
}

/// `--shot` 模式：前端標記「這一刻可以截」（例如對話框已掛上 DOM）。
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
#[tauri::command]
fn shot_frontend_log(app: State<'_, App>, level: String, message: String) {
    if app.shot.is_some() {
        eprintln!("[asn-ui {level}] {message}");
    }
}

/// 底部廣告可以開的網址（全是 repo 文件寫明的公開網址）；只准完全相同的字串，其餘一律拒絕
pub const OPEN_ALLOW: [&str; 4] = [
    "https://irori.web.app/",
    "https://irori.web.app/dev/shots/",
    "https://policy-tw.web.app",
    "https://islandmade.app",
];
pub fn open_allowed(url: &str) -> bool {
    OPEN_ALLOW.contains(&url)
}
/// 用系統預設瀏覽器開（網址已比對白名單，不經 shell）
#[tauri::command]
fn open_url(url: String) -> Result<(), String> {
    if !open_allowed(&url) {
        return Err("這個網址不在允許清單內".into());
    }
    spawn_browser(&url)
}

#[cfg(windows)]
fn spawn_browser(url: &str) -> Result<(), String> {
    std::process::Command::new("explorer.exe").arg(url).spawn().map(|_| ()).map_err(|e| e.to_string())
}

#[cfg(not(windows))]
fn spawn_browser(url: &str) -> Result<(), String> {
    std::process::Command::new("xdg-open").arg(url).spawn().map(|_| ()).map_err(|e| e.to_string())
}

/// 某台設備上傳的大頭貼（名單只帶更新時間，圖按需取）。節點代號先驗格式才組網址
#[tauri::command]
async fn relay_avatar(app: State<'_, App>, node: String) -> Result<Value, String> {
    if !identity::valid_id(&node) {
        return Err(format!("節點格式不對：{node}"));
    }
    relay_of(&app)?.api(&format!("avatar&node={}", relay::encode_component(&node)), None).await
}

/// 上傳（或 null＝移除）自己這台設備的大頭貼：格式與大小在這裡檢查，通過才送出；只能改自己的節點（後端由金鑰決定是誰）
#[tauri::command]
async fn relay_set_avatar(app: State<'_, App>, avatar: Option<String>) -> Result<Value, String> {
    if let Some(a) = &avatar {
        avatar::validate(a)?;
    }
    relay_of(&app)?.api("set_avatar", Some(serde_json::json!({ "avatar": avatar }))).await
}

#[tauri::command]
async fn relay_send(app: State<'_, App>, payload: Value) -> Result<Value, String> {
    relay_of(&app)?.send(&payload).await
}
#[tauri::command]
async fn relay_sent_status(app: State<'_, App>, ids: Vec<String>) -> Result<Value, String> {
    let rows = relay_of(&app)?.sent_status(&ids).await?;
    Ok(serde_json::json!({ "status": rows }))
}

/// 寄照片：前端已壓縮成 webp；格式與大小在 attach.rs 檢查，通過才依序要上傳網址、上傳、確認、寄信（金鑰只在這裡）
#[tauri::command]
async fn relay_send_attachment(app: State<'_, App>, payload: Value) -> Result<Value, String> {
    let r = relay_of(&app)?;
    attach::send_attachment(&r, &reqwest::Client::new(), &payload).await
}

/// 放大看：換短效下載網址、下載、檢查，回前端 <img> 能直接用的 data URL（只有寄件人與收件人換得到網址）
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
#[derive(Default)]
struct SaveDir(std::sync::Mutex<Option<PathBuf>>);

/// 另存：跳出系統「另存新檔」對話框（預設＝上次存的資料夾，第一次是「下載\ASN」；預設檔名＝附件原檔名），
/// 使用者選好才下載、存到他選的那個路徑；按取消就不下載。回存檔路徑，取消回 null。
/// `name` 只是預設檔名的建議（外部資料，Rust 端清理過）；寫檔位置只來自對話框。
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
#[tauri::command]
fn relay_attachment_reveal(dir_state: State<'_, SaveDir>) -> Result<(), String> {
    let dir = dir_state.0.lock().ok().and_then(|g| g.clone()).ok_or("還沒有存過檔案")?;
    open_in_file_manager(&dir)
}

/// 改暱稱＝改對外名字（驗證在 names::validate_name；不合法就回錯誤字串，介面還原並提示）
#[tauri::command]
fn set_window_name(app: State<'_, App>, name: String) -> Result<String, String> {
    let relay = relay_of(&app)?;
    let n = names::rename(relay.as_ref(), &app.data_dir, &app.work_dir, &name, heartbeat::now_ms())?;
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
#[tauri::command]
fn store_load(app: State<'_, App>, name: String) -> Result<Option<String>, String> {
    Ok(std::fs::read_to_string(store_path(&app, &name)?).ok())
}
#[tauri::command]
fn store_save(app: State<'_, App>, name: String, text: String) -> Result<(), String> {
    if text.len() > 8_000_000 {
        return Err("存檔太大".into());
    }
    write_atomic(&store_path(&app, &name)?, &text).map_err(|e| e.to_string())
}

/// 語音設定（念出訊息的聲音與自動念、語音輸入的語言與模型）；存在資料夾的 voice.json
#[tauri::command]
fn voice_cfg_get(app: State<'_, App>) -> voicecfg::VoiceCfg {
    voicecfg::load(&app.data_dir)
}
#[tauri::command]
fn voice_cfg_set(app: State<'_, App>, cfg: voicecfg::VoiceCfg) -> Result<(), String> {
    voicecfg::save(&app.data_dir, &cfg)
}

#[tauri::command]
fn quit_app(app: AppHandle) {
    cleanup(&app);
    app.exit(0);
}

pub(crate) fn cleanup(app: &AppHandle) {
    let st = app.state::<App>();
    if let Some(r) = &st.relay {
        for n in r.active_names() {
            heartbeat::clear_heartbeat(&st.work_dir, &n, std::process::id());
        }
    }
}

pub fn run() {
    #[cfg(not(windows))]
    {
        // WebKitGTK 在 Xvfb 下用 scrot 擷圖時，不關合成／DMABUF 常拍到空白。
        std::env::set_var("WEBKIT_DISABLE_COMPOSITING_MODE", "1");
        std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
    }
    let args: Vec<String> = std::env::args().collect();
    let background = args.iter().any(|a| a == tray::BACKGROUND_FLAG);
    let shot = args.iter().position(|a| a == "--shot").and_then(|i| args.get(i + 1)).map(PathBuf::from);

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
        let ok = base.as_ref().map(|(u, _)| u.starts_with("http://127.0.0.1") || u.starts_with("http://localhost")).unwrap_or(false);
        if !ok {
            eprintln!("--shot 只能搭配指向本機假後端的 IRORI_RELAY_URL（http://127.0.0.1…）");
            std::process::exit(5);
        }
    }

    let data_dir = std::env::var_os("IRORI_ASN_DATA").map(PathBuf::from).unwrap_or_else(|| {
        std::env::var_os("APPDATA").map(|a| PathBuf::from(a).join("tw.irori.asn")).unwrap_or_else(|| identity::home_dir().join(".irori-asn"))
    });

    let relay_obj = base.map(|(url, key)| {
        let name = read_settings_name(&data_dir).unwrap_or_else(|| default_window_name(&node));
        let r = Relay::new(url, key, node.clone(), name);
        r.set_old_names(names::prune(&names::read_old_names(&data_dir), &r.window_name(), heartbeat::now_ms()));
        Arc::new(r)
    });

    // 同一個視窗名只留一個 ASN（另一個還活著就退出，同 recv.mjs 的 exit 3）
    if let Some(r) = &relay_obj {
        if let Some(h) = heartbeat::other_instance(&work_dir, &r.window_name(), std::process::id()) {
            eprintln!("視窗「{}」已經有一個 ASN 在跑（pid {}）", r.window_name(), h.pid);
            std::process::exit(3);
        }
    }

    let frame_data_dir = data_dir.clone();
    let state = App { relay: relay_obj.clone(), init_error, node: node.clone(), work_dir: work_dir.clone(), data_dir, shot };
    let anon_url = relay_obj.as_ref().zip(anon).and_then(|(r, a)| bell::ws_url(r.base(), &a));

    let app = tauri::Builder::default()
        .manage(state)
        .manage(wins::Slots::default())
        .manage(wins::Frame::default())
        .manage(tray::CloseToTray::default())
        .manage(tray::TrayFailed::default())
        .manage(shot::ShotState::default())
        .manage(updater::Pending::default())
        .manage(SaveDir::default())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            startup_info, relay_list, relay_inbox, relay_ack, relay_send, relay_sent_status, relay_send_attachment, relay_attachment_fetch, relay_attachment_save, relay_attachment_reveal, relay_avatar, relay_set_avatar, relay_rooms, relay_launch, relay_launchers, partner_launch_local, launch_cwd_candidates, launch_cwd_browse, partner_console_query, partner_console_set, launch_prefs_get, launch_prefs_set, relay_log_paths, open_machine_log_dir, shot_frontend_log, open_url, set_window_name, store_load, store_save, quit_app,
            shot::shot_begin, shot::shot_image, shot::shot_ready, shot::shot_focus, shot::shot_pick, shot::shot_cancel, shot::shot_supported,
            claude_accounts::claude_accounts_list, claude_accounts::claude_account_save, claude_accounts::claude_account_switch, claude_accounts::claude_account_delete,
            voice_cfg_get, voice_cfg_set, tts::tts_voices, tts::tts_speak, stt::stt_status, stt::stt_install, stt::stt_transcribe,
            agent_tools::ai_cli_detect, agent_tools::ai_cli_install, agent_tools::ai_cli_login, stt::stt_cancel,
            wins::open_chat, wins::open_panel, wins::close_panels, wins::chat_visible, wins::close_chats, wins::main_visible, wins::show_main, wins::main_layout, wins::shake, wins::show_toast, wins::toast_click, wins::win_ctl, wins::frame_native, wins::set_frame, wins::take_shot, capture_ui_ready,
            tray::set_close_to_tray, tray::set_tray_unread, tray::tray_available, tray::autostart_supported, tray::autostart_get, tray::autostart_set, updater::update_check, updater::update_install,
        ])
        .setup(move |app| {
            let handle = app.handle().clone();
            // 視窗外框設定存在前端的 asn-me.json；沒有或壞掉就是自訂外框
            let native = std::fs::read_to_string(frame_data_dir.join("asn-me.json")).map(|t| wins::native_from_saved(&t)).unwrap_or(false);
            wins::init_frame(&handle, native);
            // 關閉行為同樣讀 asn-me.json 的 closeTo；系統匣圖示永遠建立（左鍵叫回、右鍵開啟／結束）
            let to_tray = std::fs::read_to_string(frame_data_dir.join("asn-me.json")).map(|t| tray::close_to_tray_from_saved(&t)).unwrap_or(true);
            tray::init(&handle, to_tray);
            tray::build(&handle);
            // 開機自動啟動帶 --background：只常駐系統匣，不跳出名單（系統匣建失敗就照常顯示）
            if background && !handle.state::<tray::TrayFailed>().0.load(std::sync::atomic::Ordering::Relaxed) {
                if let Some(w) = handle.get_webview_window("list") {
                    let _ = w.hide();
                }
            }
            if let Some(r) = relay_obj.clone() {
                // 心跳：每 30 秒寫一次（格式同 self-recv.mjs），pid 用本程式
                let wd = work_dir.clone();
                let r2 = r.clone();
                // 啟動時把視窗名同步成這台設備的顯示名（別台設備的前台依設備分組時顯示它）
                let r3 = r.clone();
                tauri::async_runtime::spawn(async move { r3.sync_device_name().await });
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
                        })
                        .await;
                    });
                }
            }
            Ok(())
        })
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
        })
        .build(tauri::generate_context!())
        .expect("ASN 啟動失敗");

    app.run(|h, ev| {
        if let tauri::RunEvent::Exit = ev {
            cleanup(h);
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 開網址只准白名單() {
        assert!(open_allowed("https://irori.web.app/"));
        assert!(open_allowed("https://policy-tw.web.app") && open_allowed("https://islandmade.app"));
        for bad in ["https://irori.web.app", "https://irori.web.app/x", "http://irori.web.app/", "https://evil.example/", "calc.exe", "https://irori.web.app/ & calc", "https://policy-tw.web.app/x", "https://islandmade.app.evil.example/", "http://islandmade.app", ""] {
            assert!(!open_allowed(bad), "{bad}");
        }
    }

    #[test]
    fn 視窗名規則與預設值() {
        assert_eq!(default_window_name("H"), "H-ASN");
        assert!(valid_window_name("家用-ASN"));
        assert!(!valid_window_name("") && !valid_window_name(" x") && !valid_window_name("a\nb") && !valid_window_name(&"字".repeat(61)));
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

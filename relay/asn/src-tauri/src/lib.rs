//! ASN 即時通（Tauri 2）：金鑰、anon 金鑰、收發室 HTTP／WebSocket、心跳檔、設定與對話存檔都在 Rust 端；
//! 前端（ui/）只拿得到「信件與名單」，拿不到任何金鑰。
mod agent_tools;
mod attach;
mod avatar;
mod bell;
mod heartbeat;
mod identity;
mod launch;
mod names;
mod relay;
mod shot;
mod stt;
mod tts;
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
    launch::partner_launch_local(app.node.clone(), app.work_dir.clone(), req).await
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

/// 另存：存到「下載\ASN」資料夾（不覆蓋同名檔），回存檔路徑
#[tauri::command]
async fn relay_attachment_save(app: State<'_, App>, id: String) -> Result<String, String> {
    let dir = identity::home_dir().join("Downloads").join("ASN");
    let r = relay_of(&app)?;
    attach::save(&r, &reqwest::Client::new(), &id, &dir).await.map(|p| p.display().to_string())
}

/// 改暱稱＝改對外名字（驗證在 names::validate_name；不合法就回錯誤字串，介面還原並提示）
#[tauri::command]
fn set_window_name(app: State<'_, App>, name: String) -> Result<String, String> {
    names::rename(relay_of(&app)?.as_ref(), &app.data_dir, &app.work_dir, &name, heartbeat::now_ms())
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

fn cleanup(app: &AppHandle) {
    let st = app.state::<App>();
    if let Some(r) = &st.relay {
        for n in r.active_names() {
            heartbeat::clear_heartbeat(&st.work_dir, &n, std::process::id());
        }
    }
}

pub fn run() {
    let args: Vec<String> = std::env::args().collect();
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
        .manage(shot::ShotState::default())
        .invoke_handler(tauri::generate_handler![
            startup_info, relay_list, relay_inbox, relay_ack, relay_send, relay_send_attachment, relay_attachment_fetch, relay_attachment_save, relay_avatar, relay_set_avatar, relay_rooms, relay_launch, relay_launchers, partner_launch_local, partner_console_query, partner_console_set, launch_prefs_get, launch_prefs_set, shot_frontend_log, open_url, set_window_name, store_load, store_save, quit_app,
            shot::shot_begin, shot::shot_image, shot::shot_ready, shot::shot_focus, shot::shot_pick, shot::shot_cancel, shot::shot_supported,
            voice_cfg_get, voice_cfg_set, tts::tts_voices, tts::tts_speak, stt::stt_status, stt::stt_install, stt::stt_transcribe,
            agent_tools::ai_cli_detect, agent_tools::ai_cli_install, agent_tools::ai_cli_login, stt::stt_cancel,
            wins::open_chat, wins::chat_visible, wins::close_chats, wins::main_visible, wins::show_main, wins::main_layout, wins::shake, wins::show_toast, wins::toast_click, wins::win_ctl, wins::frame_native, wins::set_frame, wins::take_shot,
        ])
        .setup(move |app| {
            let handle = app.handle().clone();
            // 視窗外框設定存在前端的 asn-me.json；沒有或壞掉就是自訂外框
            let native = std::fs::read_to_string(frame_data_dir.join("asn-me.json")).map(|t| wins::native_from_saved(&t)).unwrap_or(false);
            wins::init_frame(&handle, native);
            if let Some(r) = relay_obj.clone() {
                // 心跳：每 30 秒寫一次（格式同 self-recv.mjs），pid 用本程式
                let wd = work_dir.clone();
                let r2 = r.clone();
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
            // 關掉名單視窗＝結束程式
            if w.label() == "list" {
                if let tauri::WindowEvent::CloseRequested { .. } = ev {
                    cleanup(w.app_handle());
                    w.app_handle().exit(0);
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
}

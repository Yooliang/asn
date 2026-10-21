//! 多視窗：每個好友一扇對話、右下角提示視窗（置頂、不搶焦點、不進工作列、透明）、震動（真的移動視窗）、
//! 視窗按鈕（最小化／最大化／關閉）與 --shot 的螢幕擷取。
use crate::{App, BROWSER_ARGS};
use serde::Deserialize;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Emitter, LogicalSize, Manager, PhysicalPosition, State, WebviewUrl, WebviewWindowBuilder, Window};

const TOAST_W: f64 = 270.0;
const TOAST_H: f64 = 96.0;
const TOAST_GAP: f64 = 8.0;
const TOAST_MAX: usize = 3;
const TOAST_MS: u64 = 5500;

#[derive(Default)]
pub struct Slots(Mutex<[bool; TOAST_MAX]>);

/// 視窗外框：false＝自訂（ASN 自己畫 Aero 風標題列與邊框，預設）、true＝Windows 原生。
/// 開機時讀資料夾裡 asn-me.json 的 frame 欄位（前端存的設定），之後由設定頁透過 set_frame 即時改。
#[derive(Default)]
pub struct Frame(pub AtomicBool);

/// 存檔文字 → 是不是原生外框：只有 `"frame":"native"` 才是；沒這欄位的舊存檔、壞檔、壞值一律是自訂
pub fn native_from_saved(text: &str) -> bool {
    serde_json::from_str::<serde_json::Value>(text).ok().and_then(|v| v.get("frame")?.as_str().map(|f| f == "native")).unwrap_or(false)
}

/// 開機：照存檔設定主視窗的外框（視窗是由 tauri.conf 建的，預設無邊框）
pub fn init_frame(app: &AppHandle, native: bool) {
    app.state::<Frame>().0.store(native, Ordering::Relaxed);
    if native {
        if let Some(w) = app.get_webview_window("list") {
            let _ = w.set_decorations(true);
        }
    }
}

/// 目前是不是原生外框（每扇視窗載入時問一次，決定要不要藏自畫的標題列）
#[tauri::command]
pub fn frame_native(frame: State<'_, Frame>) -> bool {
    frame.0.load(Ordering::Relaxed)
}

/// 設定頁切換外框：名單、對話視窗立刻改，之後開的視窗也照這個；提示視窗永遠無邊框
#[tauri::command]
pub fn set_frame(app: AppHandle, frame: State<'_, Frame>, native: bool) {
    frame.0.store(native, Ordering::Relaxed);
    for (label, w) in app.webview_windows() {
        if label == "list" || label.starts_with("chat-") {
            let _ = w.set_decorations(native);
        }
    }
    let _ = app.emit("asn:frame", native);
}

/// 對話視窗標籤：好友 id 的 UTF-8 位元組轉十六進位（標籤只允許英數與 -/:_）
pub fn chat_label(id: &str) -> String {
    let hex: String = id.bytes().map(|b| format!("{b:02x}")).collect();
    format!("chat-{hex}")
}

fn q(s: &str) -> String {
    crate::relay::encode_component(s)
}

#[tauri::command]
pub async fn open_chat(app: AppHandle, frame: State<'_, Frame>, id: String, title: String) -> Result<(), String> {
    let label = chat_label(&id);
    if let Some(w) = app.get_webview_window(&label) {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
        return Ok(());
    }
    // 有多扇對話時錯開位置，不要疊在一起
    let n = app.webview_windows().keys().filter(|k| k.starts_with("chat-")).count() as f64;
    let mut b = WebviewWindowBuilder::new(&app, &label, WebviewUrl::App(format!("chat.html?id={}", q(&id)).into()))
        .title(title)
        .inner_size(720.0, 600.0)
        .min_inner_size(520.0, 440.0)
        .decorations(frame.0.load(Ordering::Relaxed))
        .disable_drag_drop_handler()   // 讓 WebView2 的 HTML5 拖放（分頁排序）能觸發
        .additional_browser_args(BROWSER_ARGS);
    b = if n == 0.0 { b.center() } else { b.position(120.0 + 28.0 * n, 80.0 + 28.0 * n) };
    b.build().map_err(|e| e.to_string())?;
    Ok(())
}

/// 該好友的對話視窗是否開著且沒最小化（來信時決定要不要未讀＋提示）
#[tauri::command]
pub fn chat_visible(app: AppHandle, id: String) -> bool {
    app.get_webview_window(&chat_label(&id)).map(|w| w.is_visible().unwrap_or(false) && !w.is_minimized().unwrap_or(true)).unwrap_or(false)
}

/// 對話視窗標籤 → 好友 id（chat_label 的反向；不合格式就 None）
pub fn chat_id_of(label: &str) -> Option<String> {
    let hex = label.strip_prefix("chat-")?;
    if hex.is_empty() || hex.len() % 2 != 0 || !hex.is_ascii() {
        return None;
    }
    let bytes: Option<Vec<u8>> = (0..hex.len()).step_by(2).map(|i| u8::from_str_radix(&hex[i..i + 2], 16).ok()).collect();
    String::from_utf8(bytes?).ok()
}

/// 整合模式用：關掉所有對話視窗，回傳它們原本是哪些好友（前端把它們變成分頁）
#[tauri::command]
pub fn close_chats(app: AppHandle) -> Vec<String> {
    let mut ids = vec![];
    for (label, w) in app.webview_windows() {
        if let Some(id) = chat_id_of(&label) {
            ids.push(id);
            let _ = w.close();
        }
    }
    ids.sort();
    ids
}

/// 主視窗（名單／整合模式的唯一視窗）是否開著且沒最小化
#[tauri::command]
pub fn main_visible(app: AppHandle) -> bool {
    app.get_webview_window("list").map(|w| w.is_visible().unwrap_or(false) && !w.is_minimized().unwrap_or(true)).unwrap_or(false)
}

/// 整合模式點好友／點提示：把主視窗叫出來
#[tauri::command]
pub fn show_main(app: AppHandle) {
    if let Some(w) = app.get_webview_window("list") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

/// 套用視窗模式的大小：整合模式最小 720×480，分開模式最小 280×420；大小是前端記住的（CSS 像素）
#[tauri::command]
pub fn main_layout(app: AppHandle, merged: bool, w: f64, h: f64, recenter: bool) {
    let Some(win) = app.get_webview_window("list") else { return };
    let (mw, mh) = if merged { (720.0, 480.0) } else { (280.0, 420.0) };
    let (w, h) = (w.clamp(mw, 8000.0), h.clamp(mh, 8000.0));
    let _ = win.set_min_size(Some(LogicalSize::new(mw, mh)));
    let _ = win.set_size(LogicalSize::new(w, h));
    if recenter {
        let _ = win.center();
    }
}

/// 震動：把該好友的對話視窗（整合模式＝主視窗）左右上下抖約 0.55 秒，再放回原位
#[tauri::command]
pub fn shake(app: AppHandle, id: String, main: Option<bool>) {
    let label = if main == Some(true) { "list".to_string() } else { chat_label(&id) };
    let Some(w) = app.get_webview_window(&label) else { return };
    let Ok(origin) = w.outer_position() else { return };
    let _ = w.unminimize();
    std::thread::spawn(move || {
        let offs: [(i32, i32); 10] = [(-9, 4), (8, -5), (-7, -3), (7, 5), (-6, 2), (5, -4), (-4, 3), (3, -2), (-2, 1), (0, 0)];
        for (dx, dy) in offs {
            let _ = w.set_position(PhysicalPosition::new(origin.x + dx, origin.y + dy));
            std::thread::sleep(Duration::from_millis(55));
        }
        let _ = w.set_position(origin);
    });
}

#[derive(Deserialize)]
pub struct Toast {
    cid: String,
    title: String,
    line: String,
    status: String,
    hue: f64,
    dp: String,
    /// 提示上的大頭貼：設備上傳的圖（data URL）；沒有就由提示視窗用好友 id 自己畫自動產生的那張
    av: Option<String>,
}

fn clip(s: &str, n: usize) -> String {
    let t: String = s.chars().take(n).collect();
    if s.chars().count() > n { format!("{t}…") } else { t }
}

/// 提示視窗的網址；大頭貼（av）只有通過格式與大小檢查才帶，否則不帶（提示視窗會改用自動產生的）
fn toast_url(toast: &Toast, status: &str) -> String {
    let mut url = format!(
        "toast.html?cid={}&title={}&line={}&status={}&hue={}&dp={}",
        q(&toast.cid), q(&clip(&toast.title, 40)), q(&clip(&toast.line, 60)), status, toast.hue as i64, q(&clip(&toast.dp, 2))
    );
    if let Some(av) = toast.av.as_deref().filter(|a| crate::avatar::validate(a).is_ok()) {
        url.push_str(&format!("&av={}", q(av)));
    }
    url
}

fn release(app: &AppHandle, slot: usize) {
    app.state::<Slots>().0.lock().unwrap()[slot] = false;
}

/// 右下角提示：置頂、不搶焦點、不進工作列、無邊框透明；貼螢幕工作區右下角往上疊，約 5.5 秒後自己關
#[tauri::command]
pub async fn show_toast(app: AppHandle, slots: State<'_, Slots>, toast: Toast) -> Result<(), String> {
    let slot = {
        let mut s = slots.0.lock().unwrap();
        match s.iter().position(|u| !*u) {
            Some(i) => { s[i] = true; i }
            None => return Ok(()),   // 同時最多三則
        }
    };
    static SEQ: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
    let label = format!("toast-{}-{}", slot, SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed));
    let status = if ["online", "busy", "away", "offline"].contains(&toast.status.as_str()) { toast.status.as_str() } else { "online" };
    let url = toast_url(&toast, status);
    let built = WebviewWindowBuilder::new(&app, &label, WebviewUrl::App(url.into()))
        .title("ASN 提示")
        .inner_size(TOAST_W, TOAST_H)
        .decorations(false)
        .transparent(true)
        .shadow(false)
        .resizable(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .focused(false)
        .focusable(false)
        .visible(false)
        .disable_drag_drop_handler()
        .additional_browser_args(BROWSER_ARGS)
        .build();
    let w = match built {
        Ok(w) => w,
        Err(e) => { release(&app, slot); return Err(e.to_string()); }
    };
    // 貼工作區右下角（扣掉工作列），第 slot 則往上疊
    if let Ok(Some(m)) = w.primary_monitor() {
        let sf = m.scale_factor();
        let wa = m.work_area();
        let (tw, th, gap) = ((TOAST_W * sf) as i32, (TOAST_H * sf) as i32, (TOAST_GAP * sf) as i32);
        let x = wa.position.x + wa.size.width as i32 - tw - gap;
        let y = wa.position.y + wa.size.height as i32 - (th + gap) * (slot as i32 + 1);
        let _ = w.set_position(PhysicalPosition::new(x, y));
    }
    let _ = w.show();
    let (a2, l2) = (app.clone(), label.clone());
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_millis(TOAST_MS)).await;
        if let Some(w) = a2.get_webview_window(&l2) { let _ = w.close(); }
        release(&a2, slot);
    });
    Ok(())
}

/// 點提示：叫樞紐開對話，並關掉這則提示
#[tauri::command]
pub fn toast_click(app: AppHandle, window: Window, cid: String) {
    let _ = app.emit("asn:open", serde_json::json!({ "cid": cid }));
    let _ = window.close();
}

/// 自訂標題列的按鈕
#[tauri::command]
pub fn win_ctl(window: Window, op: String) {
    match op.as_str() {
        "min" => { let _ = window.minimize(); }
        "max" => { if window.is_maximized().unwrap_or(false) { let _ = window.unmaximize(); } else { let _ = window.maximize(); } }
        "close" => { let _ = window.close(); }
        _ => {}
    }
}

/// --shot：把名單、對話、提示三類視窗各用螢幕擷取存成 PNG（沒有 capturePage，所以用 PowerShell CopyFromScreen 抓視窗範圍）
#[tauri::command]
pub async fn take_shot(app: AppHandle, state: State<'_, App>, tab: Option<String>) -> Result<(), String> {
    let dir = state.shot.clone().ok_or("不在 --shot 模式")?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let wins = app.webview_windows();
    // 名單放左、對話放右，避免互相遮住
    // 暫時置頂，才不會被使用者桌面上別的視窗蓋住而拍到別人的畫面
    if let Some(l) = wins.get("list") { let _ = l.set_position(PhysicalPosition::new(40, 40)); let _ = l.set_always_on_top(true); }
    if let Some((_, c)) = wins.iter().find(|(k, _)| k.starts_with("chat-")) { let _ = c.set_position(PhysicalPosition::new(420, 40)); let _ = c.set_always_on_top(true); }
    tokio::time::sleep(Duration::from_millis(900)).await;
    take_shot_capture(&app, &dir, tab).await
}

#[cfg(windows)]
async fn take_shot_capture(app: &AppHandle, dir: &Path, tab: Option<String>) -> Result<(), String> {
    let mut specs = vec![];
    for (label, w) in app.webview_windows() {
        // 帶 tab：只拍名單視窗，檔名 tabs-<tab>（逐頁籤截圖用）
        if tab.is_some() && label != "list" { continue }
        let name = if label == "list" { tab.as_ref().map(|t| format!("tabs-{}", t.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '-').collect::<String>())).unwrap_or_else(|| "list".to_string()) } else if label.starts_with("chat-") { "chat".to_string() } else if label.starts_with("toast-") { label.clone() } else { continue };
        if let (Ok(p), Ok(s)) = (w.outer_position(), w.outer_size()) {
            specs.push(format!("{name}|{}|{}|{}|{}", p.x, p.y, s.width, s.height));
        }
    }
    let script = r#"
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition 'using System.Runtime.InteropServices; public class Dpi { [DllImport("user32.dll")] public static extern bool SetProcessDPIAware(); }'
[Dpi]::SetProcessDPIAware() | Out-Null
foreach ($s in ($env:ASN_SPECS -split ';')) {
  if (-not $s) { continue }
  $p = $s -split '\|'
  $bmp = New-Object System.Drawing.Bitmap ([int]$p[3]), ([int]$p[4])
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen([int]$p[1], [int]$p[2], 0, 0, $bmp.Size)
  $bmp.Save((Join-Path $env:ASN_DIR ($p[0] + '.png')), [System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose(); $bmp.Dispose()
}
"#;
    let status = tokio::process::Command::new("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command", script])
        .env("ASN_SPECS", specs.join(";"))
        .env("ASN_DIR", dir)
        .status()
        .await
        .map_err(|e| e.to_string())?;
    if status.success() { Ok(()) } else { Err(format!("擷取失敗：{status}")) }
}

/// Linux：用 scrot 依視窗外框擷取（需 X11／Xvfb）；沒有 scrot 就略過 PNG，流程仍跑完。
#[cfg(not(windows))]
async fn take_shot_capture(app: &AppHandle, dir: &Path, tab: Option<String>) -> Result<(), String> {
    let scrot = which_scrot();
    let Some(scrot) = scrot else { return Ok(()) };
    for (label, w) in app.webview_windows() {
        if tab.is_some() && label != "list" {
            continue;
        }
        let name = if label == "list" {
            tab.as_ref()
                .map(|t| format!("tabs-{}", t.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '-').collect::<String>()))
                .unwrap_or_else(|| "list".to_string())
        } else if label.starts_with("chat-") {
            "chat".to_string()
        } else if label.starts_with("toast-") {
            label.clone()
        } else {
            continue;
        };
        let (Ok(p), Ok(s)) = (w.outer_position(), w.outer_size()) else { continue };
        if s.width == 0 || s.height == 0 {
            continue;
        }
        let out = dir.join(format!("{name}.png"));
        let area = format!("{},{},{},{}", p.x, p.y, s.width, s.height);
        let status = tokio::process::Command::new(&scrot)
            .args(["-o", "-a", &area, out.to_string_lossy().as_ref()])
            .status()
            .await
            .map_err(|e| e.to_string())?;
        if !status.success() {
            return Err(format!("scrot 擷取失敗：{status}"));
        }
    }
    Ok(())
}

#[cfg(not(windows))]
fn which_scrot() -> Option<String> {
    std::env::var_os("PATH").and_then(|path| {
        for dir in path.to_string_lossy().split(':').filter(|d| !d.is_empty()) {
            let p = std::path::PathBuf::from(dir).join("scrot");
            if p.is_file() {
                return Some(p.display().to_string());
            }
        }
        None
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 對話視窗標籤只含合法字元且互不相同() {
        let a = chat_label("W/W-政策");
        let b = chat_label("W/W-政第");
        assert!(a.chars().all(|c| c.is_ascii_alphanumeric() || c == '-'), "{a}");
        assert_ne!(a, b);
        assert_eq!(chat_label("A"), "chat-41");
    }

    #[test]
    fn 視窗標籤可以還原成好友_id() {
        for id in ["W/W-政策", "H/H-島作", "a/b"] {
            assert_eq!(chat_id_of(&chat_label(id)).as_deref(), Some(id));
        }
        for bad in ["list", "chat-", "chat-4", "chat-zz", "toast-0-1", "chat-ff"] {
            assert_eq!(chat_id_of(bad), None, "{bad}");
        }
    }

    #[test]
    fn 提示網址_大頭貼通過檢查才帶() {
        let mk = |av: Option<&str>| Toast { cid: "W/a".into(), title: "t".into(), line: "l".into(), status: "online".into(), hue: 10.0, dp: "W".into(), av: av.map(String::from) };
        let ok = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==";
        assert!(toast_url(&mk(Some(ok)), "online").contains("&av=data%3Aimage%2Fpng"));
        assert!(!toast_url(&mk(None), "online").contains("av="));
        for bad in ["javascript:alert(1)", "data:image/svg+xml;base64,PHN2Zz4=", "data:image/png;base64,!!"] {
            assert!(!toast_url(&mk(Some(bad)), "online").contains("av="), "{bad}");
        }
    }

    #[test]
    fn 外框設定_沒欄位的舊存檔與壞值都是自訂() {
        assert!(native_from_saved(r#"{"frame":"native","sound":true}"#));
        for t in [r#"{"sound":true}"#, r#"{"frame":"custom"}"#, r#"{"frame":"Native"}"#, r#"{"frame":true}"#, r#"{"frame":null}"#, "{壞掉", ""] {
            assert!(!native_from_saved(t), "{t}");
        }
    }

    #[test]
    fn 截斷() {
        assert_eq!(clip("abcdef", 3), "abc…");
        assert_eq!(clip("ab", 3), "ab");
    }
}

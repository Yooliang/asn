//! 多視窗：每個好友一扇對話、右下角提示視窗（置頂、不搶焦點、不進工作列、透明）、震動（真的移動視窗）、
//! 視窗按鈕（最小化／最大化／關閉）與 --shot 的螢幕擷取。
use crate::{App, BROWSER_ARGS};
use serde::Deserialize;
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, State, WebviewUrl, WebviewWindowBuilder, Window};

const TOAST_W: f64 = 270.0;
const TOAST_H: f64 = 96.0;
const TOAST_GAP: f64 = 8.0;
const TOAST_MAX: usize = 3;
const TOAST_MS: u64 = 5500;

#[derive(Default)]
pub struct Slots(Mutex<[bool; TOAST_MAX]>);

/// 對話視窗標籤：好友 id 的 UTF-8 位元組轉十六進位（標籤只允許英數與 -/:_）
pub fn chat_label(id: &str) -> String {
    let hex: String = id.bytes().map(|b| format!("{b:02x}")).collect();
    format!("chat-{hex}")
}

fn q(s: &str) -> String {
    crate::relay::encode_component(s)
}

#[tauri::command]
pub async fn open_chat(app: AppHandle, id: String, title: String) -> Result<(), String> {
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
        .decorations(false)
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

/// 震動：把該好友的對話視窗左右上下抖約 0.55 秒，再放回原位
#[tauri::command]
pub fn shake(app: AppHandle, id: String) {
    let Some(w) = app.get_webview_window(&chat_label(&id)) else { return };
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
}

fn clip(s: &str, n: usize) -> String {
    let t: String = s.chars().take(n).collect();
    if s.chars().count() > n { format!("{t}…") } else { t }
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
    let url = format!(
        "toast.html?cid={}&title={}&line={}&status={}&hue={}&dp={}",
        q(&toast.cid), q(&clip(&toast.title, 40)), q(&clip(&toast.line, 60)), status, toast.hue as i64, q(&clip(&toast.dp, 2))
    );
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
pub async fn take_shot(app: AppHandle, state: State<'_, App>) -> Result<(), String> {
    let dir = state.shot.clone().ok_or("不在 --shot 模式")?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let wins = app.webview_windows();
    // 名單放左、對話放右，避免互相遮住
    // 暫時置頂，才不會被使用者桌面上別的視窗蓋住而拍到別人的畫面
    if let Some(l) = wins.get("list") { let _ = l.set_position(PhysicalPosition::new(40, 40)); let _ = l.set_always_on_top(true); }
    if let Some((_, c)) = wins.iter().find(|(k, _)| k.starts_with("chat-")) { let _ = c.set_position(PhysicalPosition::new(420, 40)); let _ = c.set_always_on_top(true); }
    tokio::time::sleep(Duration::from_millis(900)).await;
    let mut specs = vec![];
    for (label, w) in app.webview_windows() {
        let name = if label == "list" { "list".to_string() } else if label.starts_with("chat-") { "chat".to_string() } else if label.starts_with("toast-") { label.clone() } else { continue };
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
        .env("ASN_DIR", &dir)
        .status()
        .await
        .map_err(|e| e.to_string())?;
    if status.success() { Ok(()) } else { Err(format!("擷取失敗：{status}")) }
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
    fn 截斷() {
        assert_eq!(clip("abcdef", 3), "abc…");
        assert_eq!(clip("ab", 3), "ab");
    }
}

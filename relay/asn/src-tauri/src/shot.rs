//! 對話框內截圖。
//!
//! 流程（Windows）：隱藏 ASN 自己所有可見視窗 → 等桌面重繪 → 用 GDI 把「整個虛擬桌面」（所有螢幕）一次抓成一張圖，凍結在記憶體 →
//! 對每個螢幕開一扇置頂無邊框視窗（shot.html），視窗裡顯示該螢幕那一塊 → 使用者拖曳框選（Esc／右鍵取消）→
//! 前端回報「該螢幕圖片的實體像素矩形」→ 這裡裁出來、編成 PNG 回給呼叫的視窗 → 關掉覆蓋視窗、把原本的視窗叫回來。
//!
//! 為什麼用 GDI 而不用 xcap 之類的套件：只要 `windows-sys` 的兩個功能開關，不新增套件；Linux 版的建置不受影響（那邊不支援，按鈕會隱藏）。
//! DPI：程式是每螢幕 DPI 感知（tao 啟動時設定），GetSystemMetrics 與 Tauri 回報的螢幕位置都是實體像素，所以不會被縮放模糊。
//! 圖片不經 JSON／base64：用 `tauri::ipc::Response` 直接傳位元組。
use crate::BROWSER_ARGS;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::ipc::Response;
use tauri::{AppHandle, Manager, PhysicalPosition, PhysicalSize, State, Window, WebviewUrl, WebviewWindowBuilder};
use tokio::sync::oneshot;

/// 框選逾時：沒人理就自動取消，免得桌面一直被蓋住
const PICK_TIMEOUT: Duration = Duration::from_secs(300);
/// 隱藏視窗後等桌面重繪的時間
const REPAINT_MS: u64 = 260;
/// 裁出來的圖至少要有這麼大（實體像素）
const MIN_EDGE: u32 = 2;

/// 一個螢幕：虛擬桌面座標（實體像素，可為負）與縮放比例
#[derive(Clone, Debug, PartialEq)]
pub struct Mon {
    pub x: i32,
    pub y: i32,
    pub w: u32,
    pub h: u32,
    pub scale: f64,
}

/// 凍結的桌面：BGRA（GDI 的原生排列）、原點是虛擬桌面左上角
pub struct Frame {
    pub w: u32,
    pub h: u32,
    pub ox: i32,
    pub oy: i32,
    pub bgra: Vec<u8>,
    pub mons: Vec<Mon>,
}

#[derive(Default)]
pub struct ShotState {
    busy: AtomicBool,
    frame: Mutex<Option<Arc<Frame>>>,
    tx: Mutex<Option<oneshot::Sender<Option<Vec<u8>>>>>,
}

/// 目前這個系統做不做得到截圖（Linux 版沒有，按鈕會隱藏）
pub const fn supported() -> bool {
    cfg!(windows)
}

// ---------- 純邏輯（有單元測試） ----------

/// 所有螢幕的外框 (x, y, w, h)；Windows 的外框由系統直接給，這個留給驗證與沒有系統外框的平台
#[cfg_attr(not(test), allow(dead_code))]
pub fn virtual_bounds(mons: &[Mon]) -> Option<(i32, i32, u32, u32)> {
    let x0 = mons.iter().map(|m| m.x).min()?;
    let y0 = mons.iter().map(|m| m.y).min()?;
    let x1 = mons.iter().map(|m| m.x + m.w as i32).max()?;
    let y1 = mons.iter().map(|m| m.y + m.h as i32).max()?;
    Some((x0, y0, (x1 - x0) as u32, (y1 - y0) as u32))
}

/// 某螢幕在凍結圖裡的矩形 (x, y, w, h)；螢幕超出凍結圖範圍的部分會被裁掉
pub fn mon_in_frame(f: &Frame, idx: usize) -> Option<(u32, u32, u32, u32)> {
    let m = f.mons.get(idx)?;
    let x = (m.x - f.ox).max(0) as u32;
    let y = (m.y - f.oy).max(0) as u32;
    if x >= f.w || y >= f.h {
        return None;
    }
    Some((x, y, m.w.min(f.w - x), m.h.min(f.h - y)))
}

/// 前端回報的矩形（相對該螢幕圖片左上角的實體像素）→ 凍結圖裡的矩形；夾在該螢幕範圍內，太小就拒絕
pub fn pick_rect(f: &Frame, idx: usize, x: i64, y: i64, w: i64, h: i64) -> Result<(u32, u32, u32, u32), String> {
    let (mx, my, mw, mh) = mon_in_frame(f, idx).ok_or("找不到這個螢幕")?;
    if w <= 0 || h <= 0 {
        return Err("框選範圍是空的".into());
    }
    let x0 = x.clamp(0, mw as i64);
    let y0 = y.clamp(0, mh as i64);
    let x1 = x.saturating_add(w).clamp(0, mw as i64);
    let y1 = y.saturating_add(h).clamp(0, mh as i64);
    if x1 - x0 < MIN_EDGE as i64 || y1 - y0 < MIN_EDGE as i64 {
        return Err("框選範圍太小".into());
    }
    Ok((mx + x0 as u32, my + y0 as u32, (x1 - x0) as u32, (y1 - y0) as u32))
}

/// 從 BGRA 凍結圖裁出矩形，轉成 RGB（丟掉 GDI 不可靠的 alpha 位元組）
pub fn crop_rgb(bgra: &[u8], fw: u32, rect: (u32, u32, u32, u32)) -> Vec<u8> {
    let (x, y, w, h) = rect;
    let mut out = Vec::with_capacity((w * h * 3) as usize);
    for row in y..y + h {
        let start = ((row * fw + x) * 4) as usize;
        for px in bgra[start..start + (w * 4) as usize].chunks_exact(4) {
            out.extend_from_slice(&[px[2], px[1], px[0]]);
        }
    }
    out
}

/// RGB → PNG（快速壓縮：截圖是暫時要給畫布用的，不必壓到最小）
pub fn encode_png(w: u32, h: u32, rgb: &[u8]) -> Result<Vec<u8>, String> {
    let mut buf = Vec::with_capacity(rgb.len() / 3);
    {
        let mut enc = png::Encoder::new(&mut buf, w, h);
        enc.set_color(png::ColorType::Rgb);
        enc.set_depth(png::BitDepth::Eight);
        enc.set_compression(png::Compression::Fast);
        enc.set_filter(png::FilterType::Sub);
        let mut wr = enc.write_header().map_err(|e| e.to_string())?;
        wr.write_image_data(rgb).map_err(|e| e.to_string())?;
    }
    Ok(buf)
}

fn crop_png(f: &Frame, rect: (u32, u32, u32, u32)) -> Result<Vec<u8>, String> {
    encode_png(rect.2, rect.3, &crop_rgb(&f.bgra, f.w, rect))
}

// ---------- 擷取 ----------

/// 抓整個虛擬桌面：回 (x, y, w, h, BGRA)。只有 Windows 做得到
#[cfg(windows)]
pub fn capture_virtual() -> Result<(i32, i32, u32, u32, Vec<u8>), String> {
    use windows_sys::Win32::Graphics::Gdi::{
        BitBlt, CreateCompatibleBitmap, CreateCompatibleDC, DeleteDC, DeleteObject, GetDC, GetDIBits, ReleaseDC, SelectObject, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, CAPTUREBLT, DIB_RGB_COLORS, SRCCOPY,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::{GetSystemMetrics, SM_CXVIRTUALSCREEN, SM_CYVIRTUALSCREEN, SM_XVIRTUALSCREEN, SM_YVIRTUALSCREEN};
    unsafe {
        let (x, y) = (GetSystemMetrics(SM_XVIRTUALSCREEN), GetSystemMetrics(SM_YVIRTUALSCREEN));
        let (w, h) = (GetSystemMetrics(SM_CXVIRTUALSCREEN), GetSystemMetrics(SM_CYVIRTUALSCREEN));
        if w <= 0 || h <= 0 {
            return Err("讀不到螢幕大小".into());
        }
        let screen = GetDC(std::ptr::null_mut());
        if screen.is_null() {
            return Err("無法存取螢幕".into());
        }
        let mem = CreateCompatibleDC(screen);
        let bmp = CreateCompatibleBitmap(screen, w, h);
        let mut result = Err("無法建立擷取用的點陣圖".to_string());
        if !mem.is_null() && !bmp.is_null() {
            let old = SelectObject(mem, bmp as _);
            // CAPTUREBLT：連分層（透明）視窗一起抓
            if BitBlt(mem, 0, 0, w, h, screen, x, y, SRCCOPY | CAPTUREBLT) == 0 {
                result = Err("擷取螢幕失敗".into());
            } else {
                let mut info: BITMAPINFO = std::mem::zeroed();
                info.bmiHeader = BITMAPINFOHEADER {
                    biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                    biWidth: w,
                    biHeight: -h, // 負值＝由上而下
                    biPlanes: 1,
                    biBitCount: 32,
                    biCompression: BI_RGB,
                    biSizeImage: 0,
                    biXPelsPerMeter: 0,
                    biYPelsPerMeter: 0,
                    biClrUsed: 0,
                    biClrImportant: 0,
                };
                let mut buf = vec![0u8; w as usize * h as usize * 4];
                let got = GetDIBits(mem, bmp, 0, h as u32, buf.as_mut_ptr() as _, &mut info, DIB_RGB_COLORS);
                result = if got == h { Ok((x, y, w as u32, h as u32, buf)) } else { Err("讀取擷取結果失敗".into()) };
            }
            SelectObject(mem, old);
        }
        if !bmp.is_null() {
            DeleteObject(bmp as _);
        }
        if !mem.is_null() {
            DeleteDC(mem);
        }
        ReleaseDC(std::ptr::null_mut(), screen);
        result
    }
}

#[cfg(not(windows))]
pub fn capture_virtual() -> Result<(i32, i32, u32, u32, Vec<u8>), String> {
    Err("這個系統還不支援截圖".into())
}

// ---------- 視窗收放 ----------

struct Hidden {
    label: String,
    focused: bool,
}

/// 隱藏 ASN 自己所有可見（且沒最小化）的視窗，記下哪些、誰有焦點，截完要叫回來
fn hide_all(app: &AppHandle) -> Vec<Hidden> {
    let mut out = vec![];
    for (label, w) in app.webview_windows() {
        if w.is_visible().unwrap_or(false) && !w.is_minimized().unwrap_or(false) {
            out.push(Hidden { label, focused: w.is_focused().unwrap_or(false) });
            let _ = w.hide();
        }
    }
    out
}

fn restore_all(app: &AppHandle, hidden: &[Hidden]) {
    for h in hidden {
        if let Some(w) = app.get_webview_window(&h.label) {
            let _ = w.show();
        }
    }
    if let Some(w) = hidden.iter().find(|h| h.focused).and_then(|h| app.get_webview_window(&h.label)) {
        let _ = w.set_focus();
    }
}

fn overlay_label(i: usize) -> String {
    format!("shot-{i}")
}

fn close_overlays(app: &AppHandle) {
    for (label, w) in app.webview_windows() {
        if label.starts_with("shot-") {
            let _ = w.destroy();
        }
    }
}

fn monitors_of(app: &AppHandle, bounds: (i32, i32, u32, u32)) -> Vec<Mon> {
    let mut mons: Vec<Mon> = app
        .available_monitors()
        .unwrap_or_default()
        .iter()
        .map(|m| Mon { x: m.position().x, y: m.position().y, w: m.size().width, h: m.size().height, scale: m.scale_factor() })
        .collect();
    if mons.is_empty() {
        mons.push(Mon { x: bounds.0, y: bounds.1, w: bounds.2, h: bounds.3, scale: 1.0 });
    }
    mons
}

async fn run(app: &AppHandle, st: &ShotState) -> Result<Option<Vec<u8>>, String> {
    tokio::time::sleep(Duration::from_millis(REPAINT_MS)).await;
    let (x, y, w, h, bgra) = tokio::task::spawn_blocking(capture_virtual).await.map_err(|e| e.to_string())??;
    let mons = monitors_of(app, (x, y, w, h));
    let frame = Arc::new(Frame { w, h, ox: x, oy: y, bgra, mons });
    *st.frame.lock().unwrap() = Some(frame.clone());
    let (tx, rx) = oneshot::channel();
    *st.tx.lock().unwrap() = Some(tx);
    for (i, m) in frame.mons.iter().enumerate() {
        if mon_in_frame(&frame, i).is_none() {
            continue;
        }
        let win = WebviewWindowBuilder::new(app, overlay_label(i), WebviewUrl::App(format!("shot.html?m={i}").into()))
            .title("ASN 截圖")
            .decorations(false)
            .resizable(false)
            .shadow(false)
            .always_on_top(true)
            .skip_taskbar(true)
            .visible(false)
            .additional_browser_args(BROWSER_ARGS)
            .build()
            .map_err(|e| e.to_string())?;
        // 先移到該螢幕再設實體大小（跨 DPI 的螢幕要先搬過去，大小才不會被縮放換算弄歪）；再設一次大小以防系統微調
        let _ = win.set_position(PhysicalPosition::new(m.x, m.y));
        let _ = win.set_size(PhysicalSize::new(m.w, m.h));
        let _ = win.set_position(PhysicalPosition::new(m.x, m.y));
        let _ = win.set_size(PhysicalSize::new(m.w, m.h));
    }
    match tokio::time::timeout(PICK_TIMEOUT, rx).await {
        Ok(Ok(v)) => Ok(v),
        _ => Ok(None),
    }
}

/// 開始截圖：回 PNG 位元組；使用者取消（Esc、右鍵、逾時）回空的位元組
#[tauri::command]
pub async fn shot_begin(app: AppHandle, st: State<'_, ShotState>) -> Result<Response, String> {
    if !supported() {
        return Err("這個系統還不支援截圖".into());
    }
    if st.busy.swap(true, Ordering::SeqCst) {
        return Err("正在截圖中".into());
    }
    let hidden = hide_all(&app);
    let result = run(&app, &st).await;
    // 不論成功、取消或出錯：關覆蓋視窗、放掉凍結圖、把原本的視窗叫回來
    close_overlays(&app);
    *st.frame.lock().unwrap() = None;
    *st.tx.lock().unwrap() = None;
    restore_all(&app, &hidden);
    st.busy.store(false, Ordering::SeqCst);
    result.map(|v| Response::new(v.unwrap_or_default()))
}

/// 覆蓋視窗索取自己那個螢幕的凍結畫面（PNG）
#[tauri::command]
pub async fn shot_image(st: State<'_, ShotState>, index: usize) -> Result<Response, String> {
    let f = st.frame.lock().unwrap().clone().ok_or("沒有進行中的截圖")?;
    let png = tokio::task::spawn_blocking(move || {
        let rect = mon_in_frame(&f, index).ok_or_else(|| "找不到這個螢幕".to_string())?;
        crop_png(&f, rect)
    })
    .await
    .map_err(|e| e.to_string())??;
    Ok(Response::new(png))
}

/// 覆蓋視窗畫好了：顯示、置頂；游標在這扇視窗上的才拿鍵盤焦點（Esc 才收得到）
#[tauri::command]
pub fn shot_ready(window: Window) {
    let _ = window.show();
    let _ = window.set_always_on_top(true);
    let inside = match (window.cursor_position(), window.outer_position(), window.outer_size()) {
        (Ok(c), Ok(p), Ok(s)) => c.x >= p.x as f64 && c.y >= p.y as f64 && c.x < (p.x + s.width as i32) as f64 && c.y < (p.y + s.height as i32) as f64,
        _ => true,
    };
    if inside {
        let _ = window.set_focus();
    }
}

/// 游標移到另一個螢幕的覆蓋視窗上時，把鍵盤焦點也帶過去
#[tauri::command]
pub fn shot_focus(window: Window) {
    let _ = window.set_focus();
}

fn finish(st: &ShotState, v: Option<Vec<u8>>) {
    if let Some(tx) = st.tx.lock().unwrap().take() {
        let _ = tx.send(v);
    }
}

/// 使用者框選完成：x／y／w／h 是該螢幕圖片上的實體像素
#[tauri::command]
pub async fn shot_pick(st: State<'_, ShotState>, index: usize, x: i64, y: i64, w: i64, h: i64) -> Result<(), String> {
    let f = st.frame.lock().unwrap().clone().ok_or("沒有進行中的截圖")?;
    let png = tokio::task::spawn_blocking(move || {
        let rect = pick_rect(&f, index, x, y, w, h)?;
        crop_png(&f, rect)
    })
    .await
    .map_err(|e| e.to_string())??;
    finish(&st, Some(png));
    Ok(())
}

#[tauri::command]
pub fn shot_cancel(st: State<'_, ShotState>) {
    finish(&st, None);
}

#[tauri::command]
pub fn shot_supported() -> bool {
    supported()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mon(x: i32, y: i32, w: u32, h: u32) -> Mon {
        Mon { x, y, w, h, scale: 1.0 }
    }

    /// 每個像素的 B,G,R 由座標決定，方便驗證裁切位置與顏色順序
    fn synth(w: u32, h: u32, ox: i32, oy: i32, mons: Vec<Mon>) -> Frame {
        let mut bgra = Vec::new();
        for y in 0..h {
            for x in 0..w {
                bgra.extend_from_slice(&[(x % 251) as u8, (y % 251) as u8, 7, 0]); // alpha 故意是 0：GDI 的 alpha 不可信
            }
        }
        Frame { w, h, ox, oy, bgra, mons }
    }

    #[test]
    fn 外框涵蓋所有螢幕_副螢幕在左邊時座標為負() {
        let mons = vec![mon(0, 0, 2560, 1440), mon(-1920, 200, 1920, 1080), mon(2560, -300, 1920, 1080)];
        assert_eq!(virtual_bounds(&mons), Some((-1920, -300, 6400, 1740)));
        assert_eq!(virtual_bounds(&[]), None);
    }

    #[test]
    fn 螢幕在凍結圖裡的位置() {
        let mons = vec![mon(0, 0, 100, 60), mon(-80, 10, 80, 50)];
        let f = synth(180, 60, -80, 0, mons);
        assert_eq!(mon_in_frame(&f, 0), Some((80, 0, 100, 60)));
        assert_eq!(mon_in_frame(&f, 1), Some((0, 10, 80, 50)));
        assert_eq!(mon_in_frame(&f, 2), None);
    }

    #[test]
    fn 框選矩形夾在螢幕範圍內() {
        let f = synth(180, 60, -80, 0, vec![mon(0, 0, 100, 60), mon(-80, 10, 80, 50)]);
        // 第 0 個螢幕從凍結圖 x=80 開始
        assert_eq!(pick_rect(&f, 0, 10, 5, 20, 20), Ok((90, 5, 20, 20)));
        // 超出右下邊緣：夾住
        assert_eq!(pick_rect(&f, 0, 90, 50, 50, 50), Ok((170, 50, 10, 10)));
        // 負的起點：夾住
        assert_eq!(pick_rect(&f, 1, -5, -5, 20, 20), Ok((0, 10, 15, 15)));
        // 完全在外面、空的、太小、沒有這個螢幕
        assert!(pick_rect(&f, 0, 200, 0, 10, 10).is_err());
        assert!(pick_rect(&f, 0, 0, 0, 0, 10).is_err());
        assert!(pick_rect(&f, 0, 0, 0, 1, 10).is_err());
        assert!(pick_rect(&f, 5, 0, 0, 10, 10).is_err());
        assert!(pick_rect(&f, 0, i64::MAX - 5, 0, 10, 10).is_err());
    }

    #[test]
    fn 裁切位置與顏色順序正確_alpha_不影響() {
        let f = synth(40, 30, 0, 0, vec![mon(0, 0, 40, 30)]);
        let rgb = crop_rgb(&f.bgra, f.w, (5, 3, 4, 2));
        assert_eq!(rgb.len(), 4 * 2 * 3);
        // 第一個像素在 (5,3)：B=5 G=3 R=7 → RGB 輸出 [7,3,5]
        assert_eq!(&rgb[0..3], &[7, 3, 5]);
        // 第二列第一個在 (5,4)
        assert_eq!(&rgb[12..15], &[7, 4, 5]);
    }

    #[test]
    fn png_編碼後能解回同樣的像素() {
        let f = synth(64, 48, 0, 0, vec![mon(0, 0, 64, 48)]);
        let bytes = crop_png(&f, (10, 8, 30, 20)).unwrap();
        assert_eq!(&bytes[..8], &[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a]);
        let dec = png::Decoder::new(std::io::Cursor::new(bytes));
        let mut r = dec.read_info().unwrap();
        let mut buf = vec![0; r.output_buffer_size()];
        let info = r.next_frame(&mut buf).unwrap();
        assert_eq!((info.width, info.height), (30, 20));
        assert_eq!(info.color_type, png::ColorType::Rgb);
        assert_eq!(&buf[0..3], &[7, 8, 10]);
        let last = (30 * 20 - 1) * 3;
        assert_eq!(&buf[last..last + 3], &[7, 27, 39]);
    }

    #[cfg(windows)]
    #[test]
    fn 真的抓得到整個虛擬桌面_大小與像素數一致() {
        let (x, y, w, h, buf) = match capture_virtual() {
            Ok(v) => v,
            Err(e) => panic!("擷取失敗（需要有桌面的登入工作階段）：{e}"),
        };
        let _ = (x, y);
        assert!(w > 0 && h > 0);
        assert_eq!(buf.len(), w as usize * h as usize * 4);
    }

    #[test]
    fn 不支援的系統不會誤報支援() {
        assert_eq!(supported(), cfg!(windows));
    }
}

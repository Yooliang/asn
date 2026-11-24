//! Windows 專屬：放大鈕上方的透明子視窗與它的視窗程序（#1788）。全部只在建視窗的主執行緒上跑。
//!
//! 結構：最上層視窗（tao）→ 網頁容器（wry）→ WebView2 的子視窗；網頁區的滑鼠訊息都被最深的那層吃掉，
//! 最上層視窗的 `WM_NCHITTEST` 收不到。所以在最上層視窗底下多放一個同行程的子視窗（`HWND_TOP`，蓋在網頁上），
//! 大小就是放大鈕；它的 `WM_NCHITTEST` 回 `HTMAXBUTTON`，系統就把這一塊當成放大鈕、滑過時跳出分割版面。
use super::snap_hit::Mode;
use super::snap_top_win;
use super::{clamp_to_client, step, BtnState, Ev, PxRect, EVENT};
use std::ptr::{null, null_mut};
use std::sync::Once;
use tauri::{AppHandle, Emitter};
use windows_sys::Win32::Foundation::{HWND, LPARAM, LRESULT, RECT, WPARAM};
use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
use windows_sys::Win32::UI::Input::KeyboardAndMouse::{TrackMouseEvent, TME_LEAVE, TME_NONCLIENT, TRACKMOUSEEVENT};
use windows_sys::Win32::UI::Shell::{DefSubclassProc, RemoveWindowSubclass, SetWindowSubclass};
use windows_sys::Win32::UI::WindowsAndMessaging::*;

/// 子視窗的類別名（UTF-16，結尾 0）
const CLASS: [u16; 21] = utf16_const(*b"ASN_SNAP_MAX_BUTTON\0\0");
/// 掛在最上層視窗上的 subclass 編號（wry 用 WM_USER 系列的小數字，這個取遠一點避開）
const SUBCLASS_ID: usize = 0x1788_0001;

const fn utf16_const<const N: usize>(s: [u8; N]) -> [u16; N] {
    let mut out = [0u16; N];
    let mut i = 0;
    while i < N {
        out[i] = s[i] as u16;
        i += 1;
    }
    out
}

/// 子視窗隨身的資料（放在 GWLP_USERDATA，WM_NCDESTROY 時釋放）
struct Overlay {
    app: AppHandle,
    label: String,
    state: BtnState,
    /// 做法 B：命中測試回 HTTRANSPARENT，由最上層視窗接手（見 snap_top_win.rs）
    transparent: bool,
}

/// 照前端回報套用：Some＝建立或搬到這個位置；None＝清掉。`mode` 決定 A（子視窗自己回放大鈕）或 B（交給最上層視窗）
pub fn apply(parent: isize, app: AppHandle, label: String, rect: Option<PxRect>, mode: Mode) {
    let parent = parent as HWND;
    unsafe {
        let existing = find(parent);
        let Some(rect) = rect.and_then(|r| client_clamped(parent, r)) else {
            if existing != null_mut() {
                DestroyWindow(existing);
                RemoveWindowSubclass(parent, Some(parent_proc), SUBCLASS_ID);
            }
            if mode == Mode::Top {
                snap_top_win::uninstall(parent);
            }
            return;
        };
        if existing != null_mut() {
            SetWindowPos(existing, HWND_TOP, rect.left, rect.top, rect.width(), rect.height(), SWP_NOACTIVATE);
            if mode == Mode::Top {
                snap_top_win::set_rect(parent, rect);
            }
            return;
        }
        register_class();
        let top_app = (app.clone(), label.clone());
        let data = Box::into_raw(Box::new(Overlay { app, label, state: BtnState::default(), transparent: mode == Mode::Top }));
        let hinst = GetModuleHandleW(null());
        let child = CreateWindowExW(
            0,
            CLASS.as_ptr(),
            null(),
            WS_CHILD | WS_VISIBLE | WS_CLIPSIBLINGS,
            rect.left,
            rect.top,
            rect.width(),
            rect.height(),
            parent,
            null_mut(),
            hinst,
            data as *const _,
        );
        if child.is_null() {
            drop(Box::from_raw(data));
            return;
        }
        SetWindowPos(child, HWND_TOP, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
        SetWindowSubclass(parent, Some(parent_proc), SUBCLASS_ID, 0);
        if mode == Mode::Top {
            snap_top_win::install(parent, top_app.0, top_app.1, rect);
        }
    }
}

unsafe fn find(parent: HWND) -> HWND {
    FindWindowExW(parent, null_mut(), CLASS.as_ptr(), null())
}

unsafe fn client_clamped(parent: HWND, r: PxRect) -> Option<PxRect> {
    let mut c: RECT = std::mem::zeroed();
    if GetClientRect(parent, &mut c) == 0 {
        return None;
    }
    clamp_to_client(r, c.right - c.left, c.bottom - c.top)
}

fn register_class() {
    static ONCE: Once = Once::new();
    ONCE.call_once(|| unsafe {
        let mut wc: WNDCLASSEXW = std::mem::zeroed();
        wc.cbSize = std::mem::size_of::<WNDCLASSEXW>() as u32;
        wc.lpfnWndProc = Some(overlay_proc);
        wc.hInstance = GetModuleHandleW(null());
        wc.lpszClassName = CLASS.as_ptr();
        RegisterClassExW(&wc);
    });
}

/// 最上層視窗改大小（含最大化／還原）時 tao／tauri 會把它們自己的子視窗重新疊到最上面，
/// 這裡跟著再把放大鈕子視窗疊上去，免得上緣那條拖邊縮放的區域蓋住鈕的上面幾個像素
unsafe extern "system" fn parent_proc(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM, _id: usize, _data: usize) -> LRESULT {
    match msg {
        WM_SIZE => {
            let r = DefSubclassProc(hwnd, msg, wparam, lparam);
            let child = find(hwnd);
            if !child.is_null() {
                SetWindowPos(child, HWND_TOP, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_ASYNCWINDOWPOS);
            }
            r
        }
        WM_NCDESTROY => {
            RemoveWindowSubclass(hwnd, Some(parent_proc), SUBCLASS_ID);
            DefSubclassProc(hwnd, msg, wparam, lparam)
        }
        _ => DefSubclassProc(hwnd, msg, wparam, lparam),
    }
}

unsafe extern "system" fn overlay_proc(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if msg == WM_CREATE {
        let cs = lparam as *const CREATESTRUCTW;
        SetWindowLongPtrW(hwnd, GWLP_USERDATA, (*cs).lpCreateParams as isize);
        return 0;
    }
    let data = GetWindowLongPtrW(hwnd, GWLP_USERDATA) as *mut Overlay;
    if data.is_null() {
        return DefWindowProcW(hwnd, msg, wparam, lparam);
    }
    match msg {
        // A：子視窗自己就是放大鈕；B：透明（HTTRANSPARENT＝-1），由最上層視窗回放大鈕
        WM_NCHITTEST => if (*data).transparent { HTTRANSPARENT as LRESULT } else { HTMAXBUTTON as LRESULT },
        WM_NCMOUSEMOVE => {
            // 要主動要求「離開」通知，否則收不到 WM_NCMOUSELEAVE
            let mut t = TRACKMOUSEEVENT { cbSize: std::mem::size_of::<TRACKMOUSEEVENT>() as u32, dwFlags: TME_LEAVE | TME_NONCLIENT, hwndTrack: hwnd, dwHoverTime: 0 };
            TrackMouseEvent(&mut t);
            feed(hwnd, data, Ev::Move);
            DefWindowProcW(hwnd, msg, wparam, lparam)
        }
        WM_NCMOUSELEAVE => {
            feed(hwnd, data, Ev::Leave);
            DefWindowProcW(hwnd, msg, wparam, lparam)
        }
        // 按下與放開自己處理、不交給預設程序（預設會對 HTMAXBUTTON 進入自己的追蹤迴圈）
        WM_NCLBUTTONDOWN if wparam == HTMAXBUTTON as usize => {
            feed(hwnd, data, Ev::Down);
            0
        }
        WM_NCLBUTTONUP if wparam == HTMAXBUTTON as usize => {
            feed(hwnd, data, Ev::Up);
            0
        }
        WM_NCDESTROY => {
            SetWindowLongPtrW(hwnd, GWLP_USERDATA, 0);
            drop(Box::from_raw(data));
            DefWindowProcW(hwnd, msg, wparam, lparam)
        }
        _ => DefWindowProcW(hwnd, msg, wparam, lparam),
    }
}

unsafe fn feed(hwnd: HWND, data: *mut Overlay, ev: Ev) {
    let o = &mut *data;
    let s = step(o.state, ev);
    o.state = s.state;
    if let Some(n) = s.notify {
        let _ = o.app.emit_to(o.label.as_str(), EVENT, n);
    }
    if s.toggle {
        let parent = GetParent(hwnd);
        if !parent.is_null() {
            let cmd = if IsZoomed(parent) != 0 { SC_RESTORE } else { SC_MAXIMIZE };
            PostMessageW(parent, WM_SYSCOMMAND, cmd as usize, 0);
        }
    }
}

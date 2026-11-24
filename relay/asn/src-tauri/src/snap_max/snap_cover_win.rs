//! Windows 專屬：放大鈕上方的透明子視窗（#1788）。全部只在建視窗的主執行緒上跑。
//!
//! 結構：最上層視窗（tao）→ 網頁容器（wry）→ WebView2 的子視窗（另一個行程）；網頁區的滑鼠訊息被最深的那層吃掉。
//! 在最上層視窗底下、網頁上方放一扇和放大鈕同樣大小的同行程子視窗，它對 `WM_NCHITTEST` 回 `HTTRANSPARENT`，
//! 讓命中測試越過另一個行程的 WebView2 子視窗、落回最上層視窗（回 `HTMAXBUTTON` 的是 `snap_win.rs`）。
use super::snap_win;
use super::{clamp_to_client, PxRect};
use std::ptr::{null, null_mut};
use std::sync::Once;
use tauri::AppHandle;
use windows_sys::Win32::Foundation::{HWND, LPARAM, LRESULT, RECT, WPARAM};
use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
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

/// 照前端回報套用：Some＝建立或搬到這個位置；None＝清掉
pub fn apply(parent: isize, app: AppHandle, label: String, rect: Option<PxRect>) {
    let parent = parent as HWND;
    unsafe {
        let existing = find(parent);
        let Some(rect) = rect.and_then(|r| client_clamped(parent, r)) else {
            if !existing.is_null() {
                DestroyWindow(existing);
                RemoveWindowSubclass(parent, Some(parent_proc), SUBCLASS_ID);
            }
            snap_win::uninstall(parent);
            return;
        };
        if !existing.is_null() {
            SetWindowPos(existing, HWND_TOP, rect.left, rect.top, rect.width(), rect.height(), SWP_NOACTIVATE);
            snap_win::set_rect(parent, rect);
            return;
        }
        register_class();
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
            GetModuleHandleW(null()),
            null(),
        );
        if child.is_null() {
            return;
        }
        SetWindowPos(child, HWND_TOP, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
        SetWindowSubclass(parent, Some(parent_proc), SUBCLASS_ID, 0);
        snap_win::install(parent, app, label, rect);
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
        wc.lpfnWndProc = Some(cover_proc);
        wc.hInstance = GetModuleHandleW(null());
        wc.lpszClassName = CLASS.as_ptr();
        RegisterClassExW(&wc);
    });
}

/// 最上層視窗改大小（含最大化／還原）時 tao／tauri 會把它們自己的子視窗重新疊到最上面，
/// 這裡跟著再把透明子視窗疊上去，免得上緣那條拖邊縮放的區域蓋住鈕的上面幾個像素
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

/// 永遠透明（HTTRANSPARENT＝-1）：這扇視窗不回答任何滑鼠命中
unsafe extern "system" fn cover_proc(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if msg == WM_NCHITTEST {
        return HTTRANSPARENT as LRESULT;
    }
    DefWindowProcW(hwnd, msg, wparam, lparam)
}

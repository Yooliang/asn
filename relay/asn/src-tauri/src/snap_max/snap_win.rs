//! Windows 專屬：最上層視窗與網頁容器的 subclass（#1788）。全部只在建視窗的主執行緒上跑。
//!
//! 這是 Microsoft 文件建議的做法：自繪放大鈕時，最上層視窗的 `WM_NCHITTEST` 在鈕的矩形內回 `HTMAXBUTTON`，
//! Windows 11 就會在滑過時顯示分割版面（Snap Layouts）。
//! 難處是網頁區的滑鼠訊息被 WebView2 的子視窗吃掉，最上層視窗收不到命中測試：
//! 所以放大鈕上方蓋一扇透明子視窗（見 `snap_cover_win.rs`，回 HTTRANSPARENT），
//! wry 的網頁容器（類別 WRY_WEBVIEW）在鈕的矩形內也回 HTTRANSPARENT；系統的命中測試就一路落到最上層視窗，
//! 最上層視窗的 subclass 在矩形內回 HTMAXBUTTON，其餘交給 tao 原本的程序（邊框縮放不受影響）。
//! HTTRANSPARENT 只會在「同一執行緒」的視窗之間往下傳：tao 的最上層視窗、wry 的容器（`CreateWindowExW` 在建 webview 的主執行緒）、
//! 透明子視窗（`run_on_main_thread` 建立）都在事件迴圈的主執行緒，符合條件。
//! 滑過、按下、點擊由最上層視窗的 WM_NCMOUSEMOVE／WM_NCMOUSELEAVE／WM_NCLBUTTONDOWN／WM_NCLBUTTONUP 處理。
use super::snap_hit::{hit_answer, lparam_xy, move_event, Hit, Role, HT_MAXBUTTON};
use super::{step, BtnState, Ev, PxRect, EVENT};
use std::cell::RefCell;
use std::collections::HashMap;
use tauri::{AppHandle, Emitter};
use windows_sys::Win32::Foundation::{HWND, LPARAM, LRESULT, POINT, WPARAM};
use windows_sys::Win32::Graphics::Gdi::ScreenToClient;
use windows_sys::Win32::UI::Input::KeyboardAndMouse::{TrackMouseEvent, TME_LEAVE, TME_NONCLIENT, TRACKMOUSEEVENT};
use windows_sys::Win32::UI::Shell::{DefSubclassProc, RemoveWindowSubclass, SetWindowSubclass};
use windows_sys::Win32::UI::WindowsAndMessaging::*;

const TOP_ID: usize = 0x1788_0002;
const CONTAINER_ID: usize = 0x1788_0003;
const CONTAINER_CLASS: &str = "WRY_WEBVIEW";

struct TopState {
    app: AppHandle,
    label: String,
    /// 前端回報的原矩形（已限制在內容區、尚未扣上緣邊框）；最大化／還原時用它重算命中矩形
    raw: PxRect,
    /// 實際的命中矩形（已扣掉上緣調整大小的那一條）
    rect: PxRect,
    btn: BtnState,
}

thread_local! {
    /// 以最上層視窗為鍵；只在主執行緒存取
    static STATES: RefCell<HashMap<isize, TopState>> = RefCell::new(HashMap::new());
}

/// 第一次回報矩形時：掛上最上層視窗與網頁容器的 subclass，記下矩形
pub fn install(top: HWND, app: AppHandle, label: String, raw: PxRect, rect: PxRect) {
    STATES.with(|s| s.borrow_mut().insert(top as isize, TopState { app, label, raw, rect, btn: BtnState::default() }));
    unsafe {
        SetWindowSubclass(top, Some(top_proc), TOP_ID, 0);
        for c in containers(top) {
            SetWindowSubclass(c, Some(container_proc), CONTAINER_ID, top as usize);
        }
    }
}

/// 鈕搬了位置或改了大小
pub fn set_rect(top: HWND, raw: PxRect, rect: PxRect) {
    STATES.with(|s| {
        if let Some(st) = s.borrow_mut().get_mut(&(top as isize)) {
            st.raw = raw;
            st.rect = rect;
        }
    });
}

/// 清掉：拿掉兩層 subclass 與記下的狀態
pub fn uninstall(top: HWND) {
    STATES.with(|s| s.borrow_mut().remove(&(top as isize)));
    unsafe {
        RemoveWindowSubclass(top, Some(top_proc), TOP_ID);
        for c in containers(top) {
            RemoveWindowSubclass(c, Some(container_proc), CONTAINER_ID);
        }
    }
}

unsafe fn containers(top: HWND) -> Vec<HWND> {
    unsafe extern "system" fn each(h: HWND, lp: LPARAM) -> i32 {
        let out = &mut *(lp as *mut Vec<HWND>);
        let mut buf = [0u16; 32];
        let n = GetClassNameW(h, buf.as_mut_ptr(), buf.len() as i32);
        if n > 0 && String::from_utf16_lossy(&buf[..n as usize]) == CONTAINER_CLASS {
            out.push(h);
        }
        1
    }
    let mut v: Vec<HWND> = Vec::new();
    EnumChildWindows(top, Some(each), &mut v as *mut Vec<HWND> as LPARAM);
    v
}

/// 前端回報的原矩形（沒有就是還沒掛上）
pub fn raw_of(top: HWND) -> Option<PxRect> {
    STATES.with(|s| s.borrow().get(&(top as isize)).map(|st| st.raw))
}

fn rect_of(top: HWND) -> Option<PxRect> {
    STATES.with(|s| s.borrow().get(&(top as isize)).map(|st| st.rect))
}

/// lParam 的螢幕座標 → 最上層視窗內容區座標
unsafe fn client_xy(top: HWND, lparam: LPARAM) -> (i32, i32) {
    let (sx, sy) = lparam_xy(lparam);
    let mut p = POINT { x: sx, y: sy };
    ScreenToClient(top, &mut p);
    (p.x, p.y)
}

const HTTRANSPARENT_RESULT: LRESULT = -1;

unsafe extern "system" fn container_proc(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM, _id: usize, top: usize) -> LRESULT {
    match msg {
        WM_NCHITTEST => {
            let top = top as HWND;
            let (x, y) = client_xy(top, lparam);
            if hit_answer(Role::Container, rect_of(top), x, y) == Hit::Transparent {
                return HTTRANSPARENT_RESULT;
            }
            DefSubclassProc(hwnd, msg, wparam, lparam)
        }
        WM_NCDESTROY => {
            RemoveWindowSubclass(hwnd, Some(container_proc), CONTAINER_ID);
            DefSubclassProc(hwnd, msg, wparam, lparam)
        }
        _ => DefSubclassProc(hwnd, msg, wparam, lparam),
    }
}

unsafe extern "system" fn top_proc(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM, _id: usize, _data: usize) -> LRESULT {
    match msg {
        WM_NCHITTEST => {
            let (x, y) = client_xy(hwnd, lparam);
            if hit_answer(Role::Top, rect_of(hwnd), x, y) == Hit::MaxButton {
                return HT_MAXBUTTON as LRESULT;
            }
            DefSubclassProc(hwnd, msg, wparam, lparam)
        }
        WM_NCMOUSEMOVE => {
            let ev = move_event(wparam);
            if ev == Ev::Move {
                // 要主動要求「離開」通知，否則收不到 WM_NCMOUSELEAVE
                let mut t = TRACKMOUSEEVENT { cbSize: std::mem::size_of::<TRACKMOUSEEVENT>() as u32, dwFlags: TME_LEAVE | TME_NONCLIENT, hwndTrack: hwnd, dwHoverTime: 0 };
                TrackMouseEvent(&mut t);
            }
            feed(hwnd, ev);
            DefSubclassProc(hwnd, msg, wparam, lparam)
        }
        WM_NCMOUSELEAVE => {
            feed(hwnd, Ev::Leave);
            DefSubclassProc(hwnd, msg, wparam, lparam)
        }
        // 按下與放開自己處理、不交給預設程序（預設會對 HTMAXBUTTON 進入自己的追蹤迴圈）
        WM_NCLBUTTONDOWN if wparam == HT_MAXBUTTON => {
            feed(hwnd, Ev::Down);
            0
        }
        WM_NCLBUTTONUP if wparam == HT_MAXBUTTON => {
            feed(hwnd, Ev::Up);
            0
        }
        WM_NCDESTROY => {
            STATES.with(|s| s.borrow_mut().remove(&(hwnd as isize)));
            RemoveWindowSubclass(hwnd, Some(top_proc), TOP_ID);
            DefSubclassProc(hwnd, msg, wparam, lparam)
        }
        _ => DefSubclassProc(hwnd, msg, wparam, lparam),
    }
}

/// 狀態機走一步；通知網頁與最大化／還原都在放掉借用之後做
unsafe fn feed(top: HWND, ev: Ev) {
    let out = STATES.with(|s| {
        let mut m = s.borrow_mut();
        let st = m.get_mut(&(top as isize))?;
        let r = step(st.btn, ev);
        st.btn = r.state;
        Some((r, st.app.clone(), st.label.clone()))
    });
    let Some((r, app, label)) = out else { return };
    if let Some(n) = r.notify {
        let _ = app.emit_to(label.as_str(), EVENT, n);
    }
    if r.toggle {
        let cmd = if IsZoomed(top) != 0 { SC_RESTORE } else { SC_MAXIMIZE };
        PostMessageW(top, WM_SYSCOMMAND, cmd as usize, 0);
    }
}

//! Windows 專屬：放大鈕上方的透明子視窗（#1788）。全部只在建視窗的主執行緒上跑。
//!
//! 結構：最上層視窗（tao）→ 網頁容器（wry）→ WebView2 的子視窗（另一個行程）；網頁區的滑鼠訊息被最深的那層吃掉。
//! HTTRANSPARENT 只在同一執行緒的視窗之間往下傳，到不了最上層視窗，所以不穿透：
//! 在網頁上方放一扇和命中矩形同樣大小的同行程子視窗，它自己對 `WM_NCHITTEST` 回 `HTMAXBUTTON`
//! （Tauri 社群的做法），Windows 11 就會在滑過時顯示分割版面。
//! 滑過、離開、按下、放開都在蓋板自己的視窗程序處理（`WM_NCMOUSEMOVE`／`WM_NCMOUSELEAVE`／`WM_NCLBUTTONDOWN`／`WM_NCLBUTTONUP`），
//! 離開通知用 `TrackMouseEvent(TME_LEAVE | TME_NONCLIENT)` 追蹤；點擊（按下又放開）時對最上層視窗送最大化或還原。
//!
//! 命中矩形＝前端回報的鈕矩形，扣掉上緣調整大小的那一條（視窗沒最大化時）：鈕貼著視窗上緣，
//! 不讓出來的話上緣那段拖邊縮放會被鈕吃掉。被扣掉的那條落到 tauri 的拖邊縮放子視窗（上緣回 HTTOP，邊框高度 SM_CYFRAME）。
//! 蓋板的大小就是命中矩形；鈕在畫面上的位置不動。
use super::snap_hit::{hit_answer, needs_leave_tracking, nc_event, exclude_resize_border, Hit, NcMsg, HT_MAXBUTTON};
use super::snap_win;
use super::{clamp_to_client, PxRect};
use std::ptr::{null, null_mut};
use std::sync::Once;
use tauri::AppHandle;
use windows_sys::Win32::Foundation::{GetLastError, HWND, LPARAM, LRESULT, RECT, WPARAM};
use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
use windows_sys::Win32::UI::HiDpi::{GetDpiForWindow, GetSystemMetricsForDpi};
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

/// 照前端回報套用：Some＝建立或搬到這個位置；None＝清掉。
/// 任何一步失敗都寫 log、收掉蓋板、不留狀態，下一次回報矩形時整個重來。
/// `dpr` 是前端回報的倍率，只寫進 debug log。
pub fn apply(parent: isize, app: AppHandle, label: String, rect: Option<PxRect>, dpr: f64) {
    let parent = parent as HWND;
    let existing = find(parent);
    let Some((raw, hit)) = rect.and_then(|r| client_clamped(parent, r)).and_then(|c| hit_rect(parent, c).map(|e| (c, e))) else {
        clear(parent, existing);
        return;
    };
    if !existing.is_null() {
        if snap_win::is_installed(parent) {
            // SAFETY: existing 是剛用 FindWindowExW 找到的自家蓋板，在建它的主執行緒上調整。
            unsafe { SetWindowPos(existing, HWND_TOP, hit.left, hit.top, hit.width(), hit.height(), SWP_NOACTIVATE) };
            snap_win::set_rect(parent, raw, hit);
            return;
        }
        // 有蓋板卻沒有掛成功的狀態（不應該發生）：收掉重建
        elog!("[snap] 蓋板存在但沒有安裝狀態，收掉重建；視窗={:#x}", parent as usize);
        clear(parent, existing);
    }
    if !register_class() {
        return;
    }
    // SAFETY: CLASS 是結尾為 0 的 UTF-16 字串、已註冊；parent 是有效的最上層視窗，建立在它的主執行緒上。
    let child = unsafe {
        CreateWindowExW(
            0,
            CLASS.as_ptr(),
            null(),
            WS_CHILD | WS_VISIBLE | WS_CLIPSIBLINGS,
            hit.left,
            hit.top,
            hit.width(),
            hit.height(),
            parent,
            null_mut(),
            GetModuleHandleW(null()),
            null(),
        )
    };
    if child.is_null() {
        log_fail("建立透明蓋板失敗", parent);
        return;
    }
    // SAFETY: child 是剛建好的子視窗；只調整 Z 順序（疊到最上面，WebView2 的視窗不能蓋過它），不搬不改大小。
    unsafe { SetWindowPos(child, HWND_TOP, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE) };
    // SAFETY: parent 有效；parent_proc 的簽名符合 SUBCLASSPROC，不使用 dwRefData。
    if unsafe { SetWindowSubclass(parent, Some(parent_proc), SUBCLASS_ID, 0) } == 0 {
        log_fail("最上層視窗（跟隨改大小）SetWindowSubclass 失敗", parent);
        // SAFETY: child 是上面剛建的蓋板。
        unsafe { DestroyWindow(child) };
        return;
    }
    // 蓋板與 subclass 都成功才寫進狀態（失敗的路徑上面已經收掉並寫 log，不留狀態、下次重試）
    snap_win::install(parent, app, label, raw, hit);
    snap_win::log_installed(parent, raw, hit, dpr);
}

/// 收掉蓋板與全部 subclass 與狀態
fn clear(parent: HWND, existing: HWND) {
    if !existing.is_null() {
        // SAFETY: existing 是自家蓋板（FindWindowExW 找到），在建它的主執行緒上銷毀。
        unsafe { DestroyWindow(existing) };
    }
    // SAFETY: 沒掛過也只回 FALSE。
    unsafe { RemoveWindowSubclass(parent, Some(parent_proc), SUBCLASS_ID) };
    snap_win::uninstall(parent);
}

fn log_fail(what: &str, hwnd: HWND) {
    // SAFETY: GetLastError 只讀目前執行緒的錯誤碼，沒有前置條件。
    let code = unsafe { GetLastError() };
    elog!("[snap] {what}：視窗={:#x} 錯誤碼={code}", hwnd as usize);
}

fn find(parent: HWND) -> HWND {
    // SAFETY: CLASS 是結尾為 0 的 UTF-16 字串；parent 是最上層視窗。找不到回空指標。
    unsafe { FindWindowExW(parent, null_mut(), CLASS.as_ptr(), null()) }
}

fn client_clamped(parent: HWND, r: PxRect) -> Option<PxRect> {
    // SAFETY: RECT 全零是合法的初始值。
    let mut c: RECT = unsafe { std::mem::zeroed() };
    // SAFETY: c 是區域變數，指標在呼叫期間有效。
    if unsafe { GetClientRect(parent, &mut c) } == 0 {
        log_fail("GetClientRect 失敗", parent);
        return None;
    }
    clamp_to_client(r, c.right - c.left, c.bottom - c.top)
}

/// 上緣調整大小的邊框高度（實體像素）：SM_CYSIZEFRAME + SM_CXPADDEDBORDER，依最上層視窗所在的 DPI
fn resize_border_px(parent: HWND) -> i32 {
    // SAFETY: 只讀視窗的 DPI；視窗無效回 0。
    let dpi = unsafe { GetDpiForWindow(parent) };
    if dpi == 0 {
        return 0;
    }
    // SAFETY: GetSystemMetricsForDpi 只查表，dpi 不為 0。
    unsafe { GetSystemMetricsForDpi(SM_CYSIZEFRAME, dpi).max(0) + GetSystemMetricsForDpi(SM_CXPADDEDBORDER, dpi).max(0) }
}

/// 命中矩形＝原矩形扣掉上緣調整大小的那一條（最大化時不扣）；扣完沒面積回 None
fn hit_rect(parent: HWND, raw: PxRect) -> Option<PxRect> {
    // SAFETY: 只讀視窗狀態。
    let zoomed = unsafe { IsZoomed(parent) } != 0;
    exclude_resize_border(raw, zoomed, resize_border_px(parent))
}

/// 最大化／還原／縮放／改大小之後，用記下的原矩形重算命中矩形並調整蓋板；
/// 算不出來（鈕被擠沒了）就把蓋板縮成空的、命中矩形清空
fn relayout(parent: HWND, child: HWND) {
    let Some(raw) = snap_win::raw_of(parent) else { return };
    let eff = client_clamped(parent, raw).and_then(|c| hit_rect(parent, c).map(|e| (c, e)));
    let flags = SWP_NOACTIVATE | SWP_ASYNCWINDOWPOS;
    match eff {
        Some((c, e)) => {
            // SAFETY: child 是自家蓋板；ASYNCWINDOWPOS 讓調整排進佇列，不在訊息處理中同步重排。
            unsafe { SetWindowPos(child, HWND_TOP, e.left, e.top, e.width(), e.height(), flags) };
            snap_win::set_rect(parent, c, e);
        }
        None => {
            // SAFETY: 同上；縮成 0x0。
            unsafe { SetWindowPos(child, HWND_TOP, 0, 0, 0, 0, flags) };
            snap_win::set_rect(parent, raw, PxRect { left: 0, top: 0, right: 0, bottom: 0 });
        }
    }
}

fn register_class() -> bool {
    static ONCE: Once = Once::new();
    static OK: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
    ONCE.call_once(|| {
        // SAFETY: WNDCLASSEXW 全零是合法初始值，下面填好必要欄位；CLASS 是結尾為 0 的字串且活得比視窗類別久（常數）。
        let atom = unsafe {
            let mut wc: WNDCLASSEXW = std::mem::zeroed();
            wc.cbSize = std::mem::size_of::<WNDCLASSEXW>() as u32;
            wc.lpfnWndProc = Some(cover_proc);
            wc.hInstance = GetModuleHandleW(null());
            wc.lpszClassName = CLASS.as_ptr();
            RegisterClassExW(&wc)
        };
        if atom == 0 {
            log_fail("註冊透明蓋板的視窗類別失敗", null_mut());
        } else {
            OK.store(true, std::sync::atomic::Ordering::Relaxed);
        }
    });
    OK.load(std::sync::atomic::Ordering::Relaxed)
}

/// 最上層視窗改大小（含最大化／還原）或換縮放時：
/// tao／tauri 會把它們自己的子視窗重新疊到最上面，這裡跟著重算命中矩形（上緣邊框高度隨最大化、DPI 改變）並把蓋板疊上去；
/// 前端還沒重新量好矩形之前，滑過與按下的狀態一律清掉；順便確認網頁容器有沒有被重建。
///
/// # Safety
/// 只能由系統以 SUBCLASSPROC 的約定呼叫（`SetWindowSubclass` 掛上）。
unsafe extern "system" fn parent_proc(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM, _id: usize, _data: usize) -> LRESULT {
    match msg {
        WM_SIZE | WM_DPICHANGED => {
            // SAFETY: 轉交 subclass 鏈的下一個程序，參數原封不動。
            let r = unsafe { DefSubclassProc(hwnd, msg, wparam, lparam) };
            snap_win::reset_hover(hwnd);
            let child = find(hwnd);
            if !child.is_null() {
                relayout(hwnd, child);
            }
            r
        }
        WM_NCDESTROY => {
            // SAFETY: 視窗要被毀了，先拿掉自己再交回；都在視窗自己的執行緒。
            unsafe {
                RemoveWindowSubclass(hwnd, Some(parent_proc), SUBCLASS_ID);
                DefSubclassProc(hwnd, msg, wparam, lparam)
            }
        }
        // SAFETY: 轉交 subclass 鏈的下一個程序，參數原封不動。
        _ => unsafe { DefSubclassProc(hwnd, msg, wparam, lparam) },
    }
}

/// 蓋板自己的視窗程序：命中放大鈕區域回 `HTMAXBUTTON`，並處理滑過、離開、按下、放開。
///
/// # Safety
/// 只能由系統以 WNDPROC 的約定呼叫（`RegisterClassExW` 註冊）。
unsafe extern "system" fn cover_proc(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    let nc = match msg {
        WM_NCHITTEST => return on_hit_test(hwnd, lparam),
        WM_NCMOUSEMOVE => Some(NcMsg::Move),
        WM_NCMOUSELEAVE => Some(NcMsg::Leave),
        WM_NCLBUTTONDOWN => Some(NcMsg::Down),
        WM_NCLBUTTONUP => Some(NcMsg::Up),
        _ => None,
    };
    if let Some(m) = nc {
        // SAFETY: hwnd 是正在處理訊息的蓋板；只讀它的父視窗。
        let top = unsafe { GetParent(hwnd) };
        snap_win::log_first_nc(m, wparam);
        if let Some(ev) = nc_event(m, wparam) {
            if needs_leave_tracking(ev) {
                // 要主動要求「離開」通知，否則收不到 WM_NCMOUSELEAVE
                let mut t = TRACKMOUSEEVENT { cbSize: std::mem::size_of::<TRACKMOUSEEVENT>() as u32, dwFlags: TME_LEAVE | TME_NONCLIENT, hwndTrack: hwnd, dwHoverTime: 0 };
                // SAFETY: t 是區域變數且 cbSize 填對；hwndTrack 是目前正在處理訊息的蓋板。
                if unsafe { TrackMouseEvent(&mut t) } == 0 {
                    snap_win::log_win_fail("TrackMouseEvent 失敗，收不到非客戶區離開通知", hwnd);
                }
            }
            if !top.is_null() {
                snap_win::feed(top, ev);
            }
            // 按下與放開自己處理、不交給預設程序（預設會對 HTMAXBUTTON 進入自己的追蹤迴圈）；滑過與離開照常交回
            if matches!(m, NcMsg::Down | NcMsg::Up) {
                return 0;
            }
        }
    }
    // SAFETY: 轉交預設視窗程序，參數原封不動。
    unsafe { DefWindowProcW(hwnd, msg, wparam, lparam) }
}

/// WM_NCHITTEST：螢幕座標換成最上層視窗內容區座標，矩形內回 HTMAXBUTTON，否則交給預設程序
fn on_hit_test(hwnd: HWND, lparam: LPARAM) -> LRESULT {
    // SAFETY: hwnd 是正在處理訊息的蓋板；只讀它的父視窗。
    let top = unsafe { GetParent(hwnd) };
    let client = if top.is_null() { None } else { snap_win::client_xy(top, lparam) };
    let rect = if top.is_null() { None } else { snap_win::rect_of(top) };
    let hit = client.map(|(x, y)| hit_answer(rect, x, y)).unwrap_or(Hit::Pass);
    snap_win::log_hit(lparam, client, if hit == Hit::MaxButton { "HTMAXBUTTON" } else { "預設" });
    if hit == Hit::MaxButton {
        return HT_MAXBUTTON as LRESULT;
    }
    // SAFETY: 轉交預設視窗程序，參數原封不動。
    unsafe { DefWindowProcW(hwnd, WM_NCHITTEST, 0, lparam) }
}

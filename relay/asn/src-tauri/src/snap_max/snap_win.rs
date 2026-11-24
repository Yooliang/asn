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
//!
//! 失敗一律寫 log（`elog!`，會進 ui.log）：掛不上 subclass、找不到網頁容器都不會寫進 `STATES`，
//! 由 `snap_cover_win.rs` 收掉蓋板，下一次前端回報矩形時重試。
use super::snap_hit::{containers_to_attach, hit_answer, install_verdict, lparam_xy, move_event, Hit, InstallError, Role, HT_MAXBUTTON};
use super::{reset_on_layout_change, step, BtnState, Ev, PxRect, Step, EVENT};
use std::cell::RefCell;
use std::collections::HashMap;
use tauri::{AppHandle, Emitter};
use windows_sys::Win32::Foundation::{GetLastError, HWND, LPARAM, LRESULT, POINT, WPARAM};
use windows_sys::Win32::Graphics::Gdi::ScreenToClient;
use windows_sys::Win32::UI::Input::KeyboardAndMouse::{TrackMouseEvent, TME_LEAVE, TME_NONCLIENT, TRACKMOUSEEVENT};
use windows_sys::Win32::UI::Shell::{DefSubclassProc, GetWindowSubclass, RemoveWindowSubclass, SetWindowSubclass};
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
    /// 以最上層視窗為鍵；只在主執行緒存取。只有掛成功的視窗才會有這一筆
    static STATES: RefCell<HashMap<isize, TopState>> = RefCell::new(HashMap::new());
}

/// 第一次回報矩形時：掛上最上層視窗與網頁容器的 subclass，成功才記下矩形。
/// 失敗（最上層掛不上、找不到容器、容器都掛不上）寫 log、拿掉已掛的 subclass、回 Err，不留任何狀態。
pub fn install(top: HWND, app: AppHandle, label: String, raw: PxRect, rect: PxRect) -> Result<(), InstallError> {
    // SAFETY: top 是呼叫端（snap_cover_win::apply）在主執行緒上剛確認有效的最上層視窗；top_proc 的簽名符合 SUBCLASSPROC，
    // 程序內只用 hwnd／參數，不依賴 dwRefData（傳 0）。
    let top_ok = unsafe { SetWindowSubclass(top, Some(top_proc), TOP_ID, 0) } != 0;
    if !top_ok {
        log_win_fail("最上層視窗 SetWindowSubclass 失敗", top);
    }
    let found = find_containers(top);
    let attached = found.iter().filter(|&&c| attach_container(top, c)).count();
    if let Err(e) = install_verdict(top_ok, found.len(), attached) {
        elog!("[snap] 放大鈕分割版面掛不上（{}），稍後回報矩形時重試；視窗={:#x} 容器數={} 掛成功={}", e.text(), top as usize, found.len(), attached);
        detach(top, &found);
        return Err(e);
    }
    STATES.with(|s| s.borrow_mut().insert(top as isize, TopState { app, label, raw, rect, btn: BtnState::default() }));
    Ok(())
}

/// 鈕搬了位置或改了大小。回 false＝這個視窗根本沒掛成功（沒有狀態），呼叫端要當成沒安裝、重建。
/// 順便確認網頁容器：webview 晚建或被重建時，新的容器沒有 subclass，在這裡補掛。
pub fn set_rect(top: HWND, raw: PxRect, rect: PxRect) -> bool {
    let known = STATES.with(|s| match s.borrow_mut().get_mut(&(top as isize)) {
        Some(st) => {
            st.raw = raw;
            st.rect = rect;
            true
        }
        None => false,
    });
    if known {
        sync_containers(top, true);
    }
    known
}

/// 有沒有掛成功的狀態
pub fn is_installed(top: HWND) -> bool {
    STATES.with(|s| s.borrow().contains_key(&(top as isize)))
}

/// 補掛還沒有 subclass 的網頁容器（被重建、或晚一點才建好）。`log_missing`＝找不到任何容器時要不要寫 log
/// （WM_SIZE 之類頻繁呼叫的地方不寫，免得洗版）。
pub fn sync_containers(top: HWND, log_missing: bool) {
    if !is_installed(top) {
        return;
    }
    let found = find_containers(top);
    if found.is_empty() {
        if log_missing {
            elog!("[snap] 找不到網頁容器（WRY_WEBVIEW），放大鈕分割版面暫時不完整；視窗={:#x}", top as usize);
        }
        return;
    }
    let ids: Vec<isize> = found.iter().map(|&c| c as isize).collect();
    let todo = containers_to_attach(&ids, |c| container_attached(c as HWND));
    for c in todo {
        if attach_container(top, c as HWND) {
            elog!("[snap] 網頁容器被重建，已補掛 subclass；視窗={:#x} 容器={:#x}", top as usize, c);
        }
    }
}

/// 視窗改大小、換縮放：清掉滑過／按下並通知網頁離開
pub fn reset_hover(top: HWND) {
    run(top, reset_on_layout_change);
}

/// 清掉：拿掉兩層 subclass 與記下的狀態
pub fn uninstall(top: HWND) {
    STATES.with(|s| s.borrow_mut().remove(&(top as isize)));
    let found = find_containers(top);
    detach(top, &found);
}

/// 前端回報的原矩形（沒有就是還沒掛上）
pub fn raw_of(top: HWND) -> Option<PxRect> {
    STATES.with(|s| s.borrow().get(&(top as isize)).map(|st| st.raw))
}

fn rect_of(top: HWND) -> Option<PxRect> {
    STATES.with(|s| s.borrow().get(&(top as isize)).map(|st| st.rect))
}

fn log_win_fail(what: &str, hwnd: HWND) {
    // SAFETY: GetLastError 只讀目前執行緒的錯誤碼，沒有前置條件。
    let code = unsafe { GetLastError() };
    elog!("[snap] {what}：視窗={:#x} 錯誤碼={code}", hwnd as usize);
}

/// 把最上層與容器的 subclass 全部拿掉（本來就沒掛也沒關係）
fn detach(top: HWND, found: &[HWND]) {
    // SAFETY: RemoveWindowSubclass 對沒掛過的視窗只回 FALSE；呼叫都在建視窗的主執行緒，hwnd 是列舉當下有效的。
    unsafe {
        RemoveWindowSubclass(top, Some(top_proc), TOP_ID);
        for &c in found {
            RemoveWindowSubclass(c, Some(container_proc), CONTAINER_ID);
        }
    }
}

fn attach_container(top: HWND, c: HWND) -> bool {
    // SAFETY: c 是剛列舉到的網頁容器（同一主執行緒建立）；container_proc 簽名符合 SUBCLASSPROC，
    // dwRefData 存的是最上層視窗 hwnd 的數值，程序內只當數字轉回去用，不當指標解參考。
    let ok = unsafe { SetWindowSubclass(c, Some(container_proc), CONTAINER_ID, top as usize) } != 0;
    if !ok {
        log_win_fail("網頁容器 SetWindowSubclass 失敗", c);
    }
    ok
}

fn container_attached(c: HWND) -> bool {
    let mut data: usize = 0;
    // SAFETY: data 是本函式的區域變數，指標在呼叫期間有效；c 是剛列舉到的視窗。
    unsafe { GetWindowSubclass(c, Some(container_proc), CONTAINER_ID, &mut data) != 0 }
}

/// 列舉最上層視窗底下類別為 WRY_WEBVIEW 的子視窗
fn find_containers(top: HWND) -> Vec<HWND> {
    unsafe extern "system" fn each(h: HWND, lp: LPARAM) -> i32 {
        // SAFETY: lp 是下面 EnumChildWindows 傳進來的 `*mut Vec<HWND>`，列舉期間獨佔、同一執行緒同步呼叫，沒有別名。
        let out = unsafe { &mut *(lp as *mut Vec<HWND>) };
        let mut buf = [0u16; 32];
        // SAFETY: buf 長度就是傳進去的 nMaxCount，h 是列舉當下有效的視窗。
        let n = unsafe { GetClassNameW(h, buf.as_mut_ptr(), buf.len() as i32) };
        if n > 0 && String::from_utf16_lossy(&buf[..n as usize]) == CONTAINER_CLASS {
            out.push(h);
        }
        1
    }
    let mut v: Vec<HWND> = Vec::new();
    // SAFETY: each 的簽名符合 WNDENUMPROC；lParam 是 v 的可變指標，EnumChildWindows 同步跑完才返回，v 在這期間不會被移動或釋放。
    unsafe { EnumChildWindows(top, Some(each), &mut v as *mut Vec<HWND> as LPARAM) };
    v
}

/// lParam 的螢幕座標 → 最上層視窗內容區座標。轉換失敗（視窗已不存在）回 None，呼叫端當成「不在鈕上」
fn client_xy(top: HWND, lparam: LPARAM) -> Option<(i32, i32)> {
    let (sx, sy) = lparam_xy(lparam);
    let mut p = POINT { x: sx, y: sy };
    // SAFETY: p 是區域變數，指標在呼叫期間有效；top 是正在處理訊息的視窗。
    let ok = unsafe { ScreenToClient(top, &mut p) } != 0;
    ok.then_some((p.x, p.y))
}

const HTTRANSPARENT_RESULT: LRESULT = -1;

/// 網頁容器的 subclass 程序。
///
/// # Safety
/// 只能由系統以 SUBCLASSPROC 的約定呼叫（`SetWindowSubclass` 掛上）；`top` 是最上層視窗 hwnd 的數值。
unsafe extern "system" fn container_proc(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM, _id: usize, top: usize) -> LRESULT {
    match msg {
        WM_NCHITTEST => {
            let top = top as HWND;
            if let Some((x, y)) = client_xy(top, lparam) {
                if hit_answer(Role::Container, rect_of(top), x, y) == Hit::Transparent {
                    return HTTRANSPARENT_RESULT;
                }
            }
            // SAFETY: 轉交 subclass 鏈的下一個程序，參數原封不動。
            unsafe { DefSubclassProc(hwnd, msg, wparam, lparam) }
        }
        WM_NCDESTROY => {
            // SAFETY: 視窗要被毀了，先拿掉自己再交回；兩個呼叫都在視窗自己的執行緒。
            unsafe {
                RemoveWindowSubclass(hwnd, Some(container_proc), CONTAINER_ID);
                DefSubclassProc(hwnd, msg, wparam, lparam)
            }
        }
        // SAFETY: 轉交 subclass 鏈的下一個程序，參數原封不動。
        _ => unsafe { DefSubclassProc(hwnd, msg, wparam, lparam) },
    }
}

/// 最上層視窗的 subclass 程序。
///
/// # Safety
/// 只能由系統以 SUBCLASSPROC 的約定呼叫（`SetWindowSubclass` 掛上）。
unsafe extern "system" fn top_proc(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM, _id: usize, _data: usize) -> LRESULT {
    match msg {
        WM_NCHITTEST => {
            if let Some((x, y)) = client_xy(hwnd, lparam) {
                if hit_answer(Role::Top, rect_of(hwnd), x, y) == Hit::MaxButton {
                    return HT_MAXBUTTON as LRESULT;
                }
            }
            // SAFETY: 轉交 subclass 鏈的下一個程序，參數原封不動。
            unsafe { DefSubclassProc(hwnd, msg, wparam, lparam) }
        }
        WM_NCMOUSEMOVE => {
            let ev = move_event(wparam);
            if ev == Ev::Move {
                // 要主動要求「離開」通知，否則收不到 WM_NCMOUSELEAVE
                let mut t = TRACKMOUSEEVENT { cbSize: std::mem::size_of::<TRACKMOUSEEVENT>() as u32, dwFlags: TME_LEAVE | TME_NONCLIENT, hwndTrack: hwnd, dwHoverTime: 0 };
                // SAFETY: t 是區域變數且 cbSize 填對；hwndTrack 是目前正在處理訊息的視窗。
                if unsafe { TrackMouseEvent(&mut t) } == 0 {
                    // 要不到離開通知：滑過樣式可能卡住，至少留下紀錄（之後視窗改大小時會清掉）
                    log_win_fail("TrackMouseEvent 失敗，收不到非客戶區離開通知", hwnd);
                }
            }
            feed(hwnd, ev);
            // SAFETY: 轉交 subclass 鏈的下一個程序，參數原封不動。
            unsafe { DefSubclassProc(hwnd, msg, wparam, lparam) }
        }
        WM_NCMOUSELEAVE => {
            feed(hwnd, Ev::Leave);
            // SAFETY: 轉交 subclass 鏈的下一個程序，參數原封不動。
            unsafe { DefSubclassProc(hwnd, msg, wparam, lparam) }
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
            // SAFETY: 視窗要被毀了，先拿掉自己再交回；兩個呼叫都在視窗自己的執行緒。
            unsafe {
                RemoveWindowSubclass(hwnd, Some(top_proc), TOP_ID);
                DefSubclassProc(hwnd, msg, wparam, lparam)
            }
        }
        // SAFETY: 轉交 subclass 鏈的下一個程序，參數原封不動。
        _ => unsafe { DefSubclassProc(hwnd, msg, wparam, lparam) },
    }
}

/// 狀態機走一步（滑鼠事件）
fn feed(top: HWND, ev: Ev) {
    run(top, |b| step(b, ev));
}

/// 套用狀態機的一步；通知網頁與最大化／還原都在放掉借用之後做
fn run(top: HWND, f: impl FnOnce(BtnState) -> Step) {
    let out = STATES.with(|s| {
        let mut m = s.borrow_mut();
        let st = m.get_mut(&(top as isize))?;
        let r = f(st.btn);
        st.btn = r.state;
        Some((r, st.app.clone(), st.label.clone()))
    });
    let Some((r, app, label)) = out else { return };
    if let Some(n) = r.notify {
        if let Err(e) = app.emit_to(label.as_str(), EVENT, n) {
            elog!("[snap] 通知網頁放大鈕狀態失敗（{n}）：{e}");
        }
    }
    if r.toggle {
        // SAFETY: top 是正在處理訊息的最上層視窗；IsZoomed 只讀狀態，PostMessageW 把訊息排進該視窗的佇列（不同步執行）。
        let (zoomed, posted) = unsafe {
            let zoomed = IsZoomed(top) != 0;
            let cmd = if zoomed { SC_RESTORE } else { SC_MAXIMIZE };
            (zoomed, PostMessageW(top, WM_SYSCOMMAND, cmd as usize, 0))
        };
        if posted == 0 {
            log_win_fail(if zoomed { "還原視窗的 PostMessageW 失敗" } else { "最大化視窗的 PostMessageW 失敗" }, top);
        }
    }
}

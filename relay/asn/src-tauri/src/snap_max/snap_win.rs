//! Windows 專屬：放大鈕的狀態與滑鼠事件處理（#1788）。全部只在建視窗的主執行緒上跑。
//!
//! 蓋板（`snap_cover_win.rs`）收到非客戶區滑鼠訊息後，經這裡走狀態機、通知網頁換樣式、點擊時對最上層視窗送最大化／還原。
//! 狀態以最上層視窗為鍵，只有蓋板建好、parent subclass 掛成功之後才會寫進 `STATES`；失敗不留狀態，下次回報矩形時重試。
//!
//! debug log（`elog!`，進 ui.log）一律以 `[snap]` 開頭，只記視窗代號與座標，不記視窗內容與網址；
//! 每種事件只記前幾次（`log_first_n`），不會洗版。
use super::snap_hit::{lparam_xy, log_first_n, toggle_cmd, NcMsg, SysCmd};
use super::{reset_on_layout_change, step, BtnState, Ev, PxRect, Step, EVENT};
use std::cell::RefCell;
use std::collections::HashMap;
use std::sync::atomic::{AtomicU32, Ordering};
use tauri::{AppHandle, Emitter};
use windows_sys::Win32::Foundation::{GetLastError, HWND, LPARAM, POINT, RECT, WPARAM};
use windows_sys::Win32::Graphics::Gdi::ScreenToClient;
use windows_sys::Win32::UI::HiDpi::GetDpiForWindow;
use windows_sys::Win32::UI::WindowsAndMessaging::*;

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
    /// 以最上層視窗為鍵；只在主執行緒存取。只有蓋板與 subclass 都建成功的視窗才會有這一筆
    static STATES: RefCell<HashMap<isize, TopState>> = RefCell::new(HashMap::new());
}

/// 蓋板建好之後記下狀態
pub fn install(top: HWND, app: AppHandle, label: String, raw: PxRect, rect: PxRect) {
    STATES.with(|s| s.borrow_mut().insert(top as isize, TopState { app, label, raw, rect, btn: BtnState::default() }));
}

/// 鈕搬了位置或改了大小。回 false＝這個視窗沒有狀態（沒安裝成功），呼叫端要當成沒安裝、重建。
pub fn set_rect(top: HWND, raw: PxRect, rect: PxRect) -> bool {
    STATES.with(|s| match s.borrow_mut().get_mut(&(top as isize)) {
        Some(st) => {
            st.raw = raw;
            st.rect = rect;
            true
        }
        None => false,
    })
}

/// 有沒有安裝成功的狀態
pub fn is_installed(top: HWND) -> bool {
    STATES.with(|s| s.borrow().contains_key(&(top as isize)))
}

/// 視窗改大小、換縮放：清掉滑過／按下並通知網頁離開
pub fn reset_hover(top: HWND) {
    run(top, reset_on_layout_change);
}

/// 清掉記下的狀態
pub fn uninstall(top: HWND) {
    STATES.with(|s| s.borrow_mut().remove(&(top as isize)));
}

/// 前端回報的原矩形（沒有就是還沒安裝）
pub fn raw_of(top: HWND) -> Option<PxRect> {
    STATES.with(|s| s.borrow().get(&(top as isize)).map(|st| st.raw))
}

/// 目前的命中矩形
pub fn rect_of(top: HWND) -> Option<PxRect> {
    STATES.with(|s| s.borrow().get(&(top as isize)).map(|st| st.rect))
}

pub fn log_win_fail(what: &str, hwnd: HWND) {
    // SAFETY: GetLastError 只讀目前執行緒的錯誤碼，沒有前置條件。
    let code = unsafe { GetLastError() };
    elog!("[snap] {what}：視窗={:#x} 錯誤碼={code}", hwnd as usize);
}

/// lParam 的螢幕座標 → 最上層視窗內容區座標。轉換失敗（視窗已不存在）回 None，呼叫端當成「不在鈕上」
pub fn client_xy(top: HWND, lparam: LPARAM) -> Option<(i32, i32)> {
    let (sx, sy) = lparam_xy(lparam);
    let mut p = POINT { x: sx, y: sy };
    // SAFETY: p 是區域變數，指標在呼叫期間有效；top 是蓋板的父視窗（最上層視窗）。
    let ok = unsafe { ScreenToClient(top, &mut p) } != 0;
    ok.then_some((p.x, p.y))
}

/// 狀態機走一步（滑鼠事件）
pub fn feed(top: HWND, ev: Ev) {
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
        // SAFETY: top 是蓋板的最上層父視窗；IsZoomed 只讀狀態，PostMessageW 把訊息排進該視窗的佇列（不同步執行）。
        let (zoomed, cmd, posted) = unsafe {
            let zoomed = IsZoomed(top) != 0;
            let cmd = toggle_cmd(zoomed);
            let code = if cmd == SysCmd::Restore { SC_RESTORE } else { SC_MAXIMIZE };
            (zoomed, cmd, PostMessageW(top, WM_SYSCOMMAND, code as usize, 0))
        };
        static SENT: AtomicU32 = AtomicU32::new(0);
        if log_first_n(SENT.fetch_add(1, Ordering::Relaxed), 20) {
            elog!("[snap] 點擊完成，送出 {} 給最上層視窗 {:#x}（原本最大化={zoomed}）", if cmd == SysCmd::Restore { "SC_RESTORE" } else { "SC_MAXIMIZE" }, top as usize);
        }
        if posted == 0 {
            log_win_fail(if zoomed { "還原視窗的 PostMessageW 失敗" } else { "最大化視窗的 PostMessageW 失敗" }, top);
        }
    }
}

// ---- debug log ----

/// 安裝成功時記一次：最上層視窗、原矩形、命中矩形、內容區、DPI、前端回報的倍率、是否有最大化框樣式
pub fn log_installed(top: HWND, raw: PxRect, hit: PxRect, dpr: f64) {
    // SAFETY: RECT 全零是合法初始值。
    let mut c: RECT = unsafe { std::mem::zeroed() };
    // SAFETY: c 是區域變數，指標在呼叫期間有效；top 是剛確認有效的最上層視窗。
    let got = unsafe { GetClientRect(top, &mut c) } != 0;
    // SAFETY: 只讀視窗屬性；視窗無效回 0。
    let (dpi, style) = unsafe { (GetDpiForWindow(top), GetWindowLongW(top, GWL_STYLE) as u32) };
    elog!(
        "[snap] 安裝：最上層={:#x} raw=({},{},{},{}) hit=({},{},{},{}) 內容區={}x{}{} dpi={dpi} dpr={dpr} WS_MAXIMIZEBOX={}",
        top as usize,
        raw.left, raw.top, raw.right, raw.bottom,
        hit.left, hit.top, hit.right, hit.bottom,
        c.right - c.left, c.bottom - c.top,
        if got { "" } else { "（GetClientRect 失敗）" },
        style & WS_MAXIMIZEBOX != 0
    );
}

/// 蓋板前 3 次收到 WM_NCHITTEST：螢幕座標、換算後的客戶區座標、回了什麼
pub fn log_hit(lparam: LPARAM, client: Option<(i32, i32)>, answer: &str) {
    static N: AtomicU32 = AtomicU32::new(0);
    if !log_first_n(N.fetch_add(1, Ordering::Relaxed), 3) {
        return;
    }
    let (sx, sy) = lparam_xy(lparam);
    match client {
        Some((cx, cy)) => elog!("[snap] 蓋板 WM_NCHITTEST：螢幕=({sx},{sy}) 客戶區=({cx},{cy}) 回覆={answer}"),
        None => elog!("[snap] 蓋板 WM_NCHITTEST：螢幕=({sx},{sy}) 客戶區換算失敗 回覆={answer}"),
    }
}

/// 蓋板第一次收到各種非客戶區滑鼠訊息時各記一次（附 wParam）
pub fn log_first_nc(m: NcMsg, wparam: WPARAM) {
    static MOVE: AtomicU32 = AtomicU32::new(0);
    static LEAVE: AtomicU32 = AtomicU32::new(0);
    static DOWN: AtomicU32 = AtomicU32::new(0);
    static UP: AtomicU32 = AtomicU32::new(0);
    let (counter, name) = match m {
        NcMsg::Move => (&MOVE, "WM_NCMOUSEMOVE"),
        NcMsg::Leave => (&LEAVE, "WM_NCMOUSELEAVE"),
        NcMsg::Down => (&DOWN, "WM_NCLBUTTONDOWN"),
        NcMsg::Up => (&UP, "WM_NCLBUTTONUP"),
    };
    if log_first_n(counter.fetch_add(1, Ordering::Relaxed), 1) {
        elog!("[snap] 蓋板第一次收到 {name}：wParam={wparam}");
    }
}

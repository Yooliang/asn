//! 自畫的「放大」鈕要能跳出 Windows 11 的分割版面（Snap Layouts，#1788）。
//!
//! 做法是 Microsoft 文件建議的：最上層視窗的 `WM_NCHITTEST` 在放大鈕的矩形內回 `HTMAXBUTTON`，系統就把那一塊當成放大鈕，
//! 滑過時顯示分割版面。網頁畫的鈕在 WebView2 的子視窗（另一個行程）裡，命中測試到不了最上層視窗，
//! 所以放大鈕上方蓋一扇透明子視窗、wry 的網頁容器在矩形內也回 `HTTRANSPARENT`，讓命中測試落回最上層視窗
//! （細節見 `snap_max/snap_win.rs`、`snap_max/snap_cover_win.rs`）。
//! 滑過／按下／放開由最上層視窗的非客戶區滑鼠訊息接手，通知網頁換樣式，放開時由 Rust 端直接最大化／還原。
//!
//! 這個檔案放不依賴系統的部分（座標換算、狀態機），命中判斷在 `snap_max/snap_hit.rs`，Windows 專屬的視窗程序在 `snap_max/snap_win.rs`、`snap_max/snap_cover_win.rs`。
//! 其他平台（Linux、macOS）：指令存在但什麼都不做，網頁的鈕照舊自己處理。

mod snap_hit;
#[cfg(windows)]
mod snap_cover_win;
#[cfg(windows)]
mod snap_win;

/// 前端回報的矩形：視窗內容區左上角起算、CSS 像素（`getBoundingClientRect`）
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct CssRect {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

/// 換成實體像素之後的矩形（半開區間：left、top 含，right、bottom 不含），座標原點同上
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PxRect {
    pub left: i32,
    pub top: i32,
    pub right: i32,
    pub bottom: i32,
}

impl PxRect {
    pub fn width(&self) -> i32 {
        self.right - self.left
    }
    pub fn height(&self) -> i32 {
        self.bottom - self.top
    }
    /// 點（內容區座標、實體像素）在不在矩形內；右、下邊界不算
    pub fn contains(&self, x: i32, y: i32) -> bool {
        x >= self.left && x < self.right && y >= self.top && y < self.bottom
    }
}

/// 縮放倍率的合理範圍：系統縮放 100%~500% 再乘上網頁縮放，超出就當前端回報壞掉
const DPR_MIN: f64 = 0.25;
const DPR_MAX: f64 = 8.0;
/// 座標的合理上限（CSS 像素）；擋掉 NaN、無限大與荒謬的數字
const COORD_MAX: f64 = 100_000.0;

/// CSS 像素 → 實體像素。`dpr` 是前端的 `devicePixelRatio`（已含系統 DPI 與網頁縮放）。
/// 往外取整（左上無條件捨去、右下無條件進位），寧可多蓋半個像素也不要漏掉鈕的邊。
/// 數字壞掉（非有限、寬高不是正的、倍率不合理）回 None，呼叫端當成「清掉」。
pub fn css_to_px(r: CssRect, dpr: f64) -> Option<PxRect> {
    let finite = [r.x, r.y, r.w, r.h, dpr].iter().all(|v| v.is_finite());
    if !finite || !(DPR_MIN..=DPR_MAX).contains(&dpr) || r.w <= 0.0 || r.h <= 0.0 {
        return None;
    }
    if [r.x, r.y, r.x + r.w, r.y + r.h].iter().any(|v| v.abs() > COORD_MAX) {
        return None;
    }
    Some(PxRect {
        left: (r.x * dpr).floor() as i32,
        top: (r.y * dpr).floor() as i32,
        right: ((r.x + r.w) * dpr).ceil() as i32,
        bottom: ((r.y + r.h) * dpr).ceil() as i32,
    })
}

/// 限制在內容區（0,0,寬,高）之內；完全在外面或剩零面積回 None。
/// 視窗縮得比鈕還小、或鈕被捲到外面時，不能留一塊懸在視窗外的子視窗。
pub fn clamp_to_client(r: PxRect, client_w: i32, client_h: i32) -> Option<PxRect> {
    let c = PxRect { left: r.left.max(0), top: r.top.max(0), right: r.right.min(client_w), bottom: r.bottom.min(client_h) };
    (c.width() > 0 && c.height() > 0).then_some(c)
}

/// 放大鈕在畫面上的兩種狀態：滑過、按下
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct BtnState {
    pub hover: bool,
    pub down: bool,
}

/// 子視窗收到的非客戶區滑鼠訊息
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Ev {
    /// WM_NCMOUSEMOVE
    Move,
    /// WM_NCMOUSELEAVE
    Leave,
    /// WM_NCLBUTTONDOWN
    Down,
    /// WM_NCLBUTTONUP
    Up,
}

/// 狀態機走一步的結果
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Step {
    pub state: BtnState,
    /// 要通知網頁的樣式名（"hover"／"down"／"leave"）；沒變就是 None，避免每次滑鼠移動都發事件
    pub notify: Option<&'static str>,
    /// 這一步算「點擊完成」：Rust 端該切換最大化／還原
    pub toggle: bool,
}

/// 滑過與按下的規則：
/// - 只有「在鈕上按下、又在鈕上放開」才算點擊（先在別處按下再拖進來放開不算）
/// - 離開鈕就取消按下（放開時不會誤觸）
/// - 同樣的狀態不重複通知
pub fn step(s: BtnState, ev: Ev) -> Step {
    let unchanged = Step { state: s, notify: None, toggle: false };
    match ev {
        Ev::Move if !s.hover => Step { state: BtnState { hover: true, down: s.down }, notify: Some("hover"), toggle: false },
        Ev::Move => unchanged,
        Ev::Leave if s.hover || s.down => Step { state: BtnState::default(), notify: Some("leave"), toggle: false },
        Ev::Leave => unchanged,
        Ev::Down if !s.down => Step { state: BtnState { hover: true, down: true }, notify: Some("down"), toggle: false },
        Ev::Down => unchanged,
        Ev::Up if s.down => Step { state: BtnState { hover: true, down: false }, notify: Some("hover"), toggle: true },
        Ev::Up => unchanged,
    }
}

/// 視窗改大小、換螢幕／縮放（WM_SIZE、WM_DPICHANGED）：前端還沒重新量好矩形之前，滑過與按下的狀態都不可信，
/// 一律清掉並通知網頁離開（沒有滑過、也沒按下就不通知）。
pub fn reset_on_layout_change(s: BtnState) -> Step {
    step(s, Ev::Leave)
}

/// 前端事件名；內容是上面的 notify 字串
pub const EVENT: &str = "asn:snap-max";

// ---- Tauri 指令（只有電腦版有視窗） ----

/// 前端回報放大鈕的位置：CSS 像素＋當時的 `devicePixelRatio`。位置沒變可以重複呼叫，不會重建子視窗。
/// 數字不合理、或整個在視窗外，等同 `snap_max_clear`
#[cfg(feature = "gui")]
#[tauri::command]
pub fn snap_max_set(window: tauri::Window, x: f64, y: f64, w: f64, h: f64, dpr: f64) -> Result<(), String> {
    let rect = css_to_px(CssRect { x, y, w, h }, dpr);
    apply(window, rect)
}

/// 外觀切換成原生外框、放大鈕不存在（Aero）、視窗要關：清掉子視窗，滑鼠訊息回到網頁
#[cfg(feature = "gui")]
#[tauri::command]
pub fn snap_max_clear(window: tauri::Window) -> Result<(), String> {
    apply(window, None)
}

/// 切到原生外框時由 `wins::set_frame` 同步呼叫：不等前端清，免得那 50ms 把原生標題區誤判成放大鈕
#[cfg(feature = "gui")]
pub fn clear_now(w: &tauri::WebviewWindow) {
    if let Err(e) = apply(w.as_ref().window(), None) {
        elog!("[snap] 切到原生外框時清不掉放大鈕分割版面：{e}");
    }
}

#[cfg(all(feature = "gui", windows))]
fn apply(window: tauri::Window, rect: Option<PxRect>) -> Result<(), String> {
    use tauri::Manager;
    let hwnd = window.hwnd().map_err(|e| e.to_string())?.0 as isize;
    let app = window.app_handle().clone();
    let label = window.label().to_string();
    // 建立與調整子視窗一定要在建這扇視窗的執行緒上做
    window.run_on_main_thread(move || snap_cover_win::apply(hwnd, app, label, rect)).map_err(|e| e.to_string())
}

#[cfg(all(feature = "gui", not(windows)))]
fn apply(_window: tauri::Window, _rect: Option<PxRect>) -> Result<(), String> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn r(x: f64, y: f64, w: f64, h: f64) -> CssRect {
        CssRect { x, y, w, h }
    }

    #[test]
    fn css_to_px_scales_by_dpr() {
        // 100%：原樣
        assert_eq!(css_to_px(r(600.0, 0.0, 46.0, 36.0), 1.0), Some(PxRect { left: 600, top: 0, right: 646, bottom: 36 }));
        // 150%：位置與大小都乘 1.5
        assert_eq!(css_to_px(r(600.0, 0.0, 46.0, 36.0), 1.5), Some(PxRect { left: 900, top: 0, right: 969, bottom: 54 }));
        // 200% 且網頁縮放 125% → dpr 2.5
        assert_eq!(css_to_px(r(100.0, 4.0, 40.0, 32.0), 2.5), Some(PxRect { left: 250, top: 10, right: 350, bottom: 90 }));
    }

    #[test]
    fn css_to_px_rounds_outward() {
        // 1.25 倍：左上 10.4→10、右下 (10.3+20.1)*1.25=37.0 剛好；小數都要往外取
        let p = css_to_px(r(8.3, 0.7, 20.1, 10.0), 1.25).unwrap();
        assert_eq!((p.left, p.top), (10, 0)); // 10.375→10、0.875→0
        assert_eq!((p.right, p.bottom), (36, 14)); // 28.4*1.25=35.5→36、10.7*1.25=13.375→14
    }

    #[test]
    fn css_to_px_rejects_garbage() {
        assert_eq!(css_to_px(r(0.0, 0.0, 0.0, 36.0), 1.0), None, "寬 0");
        assert_eq!(css_to_px(r(0.0, 0.0, 46.0, -1.0), 1.0), None, "高為負");
        assert_eq!(css_to_px(r(f64::NAN, 0.0, 46.0, 36.0), 1.0), None, "NaN");
        assert_eq!(css_to_px(r(0.0, 0.0, f64::INFINITY, 36.0), 1.0), None, "無限大");
        assert_eq!(css_to_px(r(0.0, 0.0, 46.0, 36.0), 0.0), None, "倍率 0");
        assert_eq!(css_to_px(r(0.0, 0.0, 46.0, 36.0), 100.0), None, "倍率太大");
        assert_eq!(css_to_px(r(1e9, 0.0, 46.0, 36.0), 1.0), None, "座標荒謬");
    }

    #[test]
    fn clamp_keeps_rect_inside_client() {
        let b = PxRect { left: 900, top: 0, right: 969, bottom: 54 };
        assert_eq!(clamp_to_client(b, 1000, 600), Some(PxRect { left: 900, top: 0, right: 969, bottom: 54 }), "全在裡面不動");
        assert_eq!(clamp_to_client(b, 940, 600), Some(PxRect { left: 900, top: 0, right: 940, bottom: 54 }), "右邊被切掉");
        assert_eq!(clamp_to_client(b, 900, 600), None, "整個在視窗外");
        assert_eq!(clamp_to_client(PxRect { left: -10, top: -5, right: 20, bottom: 30 }, 100, 100), Some(PxRect { left: 0, top: 0, right: 20, bottom: 30 }), "負座標補到 0");
        assert_eq!(clamp_to_client(b, 1000, 0), None, "視窗高 0");
    }

    #[test]
    fn contains_is_half_open() {
        let b = PxRect { left: 10, top: 0, right: 56, bottom: 36 };
        assert!(b.contains(10, 0));
        assert!(b.contains(55, 35));
        assert!(!b.contains(56, 10), "右邊界不算");
        assert!(!b.contains(20, 36), "下邊界不算");
        assert!(!b.contains(9, 10));
        assert!(!b.contains(20, -1));
    }

    #[test]
    fn move_notifies_hover_once() {
        let a = step(BtnState::default(), Ev::Move);
        assert_eq!(a.notify, Some("hover"));
        assert!(a.state.hover && !a.state.down && !a.toggle);
        let b = step(a.state, Ev::Move);
        assert_eq!(b.notify, None, "已經在滑過，不重複通知");
        assert_eq!(b.state, a.state);
    }

    #[test]
    fn click_is_down_then_up_on_button() {
        let hover = step(BtnState::default(), Ev::Move).state;
        let down = step(hover, Ev::Down);
        assert_eq!(down.notify, Some("down"));
        assert!(!down.toggle, "按下還不算點擊");
        let up = step(down.state, Ev::Up);
        assert!(up.toggle, "按下又放開才切換最大化");
        assert_eq!(up.notify, Some("hover"));
        assert_eq!(up.state, BtnState { hover: true, down: false });
    }

    #[test]
    fn up_without_down_is_not_a_click() {
        // 在別處按下、拖進鈕上才放開：不能算點擊
        let hover = step(BtnState::default(), Ev::Move).state;
        let up = step(hover, Ev::Up);
        assert!(!up.toggle);
        assert_eq!(up.notify, None);
        assert_eq!(up.state, hover);
    }

    #[test]
    fn leave_cancels_press() {
        let down = step(step(BtnState::default(), Ev::Move).state, Ev::Down).state;
        let leave = step(down, Ev::Leave);
        assert_eq!(leave.notify, Some("leave"));
        assert_eq!(leave.state, BtnState::default());
        // 之後在鈕上放開（沒有重新按下）不能點擊
        assert!(!step(leave.state, Ev::Up).toggle);
        // 本來就沒滑過時離開不通知
        assert_eq!(step(BtnState::default(), Ev::Leave).notify, None);
    }

    #[test]
    fn 改大小或縮放時清掉滑過與按下並通知離開() {
        let hover = step(BtnState::default(), Ev::Move).state;
        let r = reset_on_layout_change(hover);
        assert_eq!(r.notify, Some("leave"), "滑過中改大小：網頁要收到離開");
        assert_eq!(r.state, BtnState::default());
        assert!(!r.toggle);
        let down = step(hover, Ev::Down).state;
        let r = reset_on_layout_change(down);
        assert_eq!(r.notify, Some("leave"), "按下中改大小：取消按下");
        assert_eq!(r.state, BtnState::default());
        // 清掉之後在新位置放開不能算點擊
        assert!(!step(r.state, Ev::Up).toggle);
        // 本來就閒置：不通知，避免每次改大小都發事件
        assert_eq!(reset_on_layout_change(BtnState::default()).notify, None);
    }

    #[test]
    fn down_without_prior_move_still_marks_hover() {
        // 滑鼠直接在鈕上按下（沒收到過 NCMOUSEMOVE，例如視窗剛出現在滑鼠底下）
        let d = step(BtnState::default(), Ev::Down);
        assert_eq!(d.state, BtnState { hover: true, down: true });
        assert_eq!(d.notify, Some("down"));
    }
}

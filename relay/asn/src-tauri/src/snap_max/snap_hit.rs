//! 放大鈕分割版面（#1788）的純邏輯：「滑鼠點在不在鈕上、該怎麼回答 WM_NCHITTEST」。
//! 不依賴系統，可直接單元測試；Windows 的視窗程序只負責把訊息翻成這裡的輸入。
use super::{Ev, PxRect};

/// `WM_NCHITTEST` 的 `HTMAXBUTTON`；`WM_NC*` 滑鼠訊息的 wParam 就是命中碼
pub const HT_MAXBUTTON: usize = 9;

/// 蓋板對 WM_NCHITTEST 的回答
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Hit {
    /// HTMAXBUTTON：這裡是放大鈕
    MaxButton,
    /// 不在鈕上（或還沒回報矩形）：交給預設視窗程序
    Pass,
}

/// 命中判斷。`(x, y)` 是最上層視窗內容區座標（實體像素），`rect` 是鈕的命中矩形（尚未設定就是 None）。
/// 蓋板自己回答：矩形內回放大鈕，其餘不處理。
pub fn hit_answer(rect: Option<PxRect>, x: i32, y: i32) -> Hit {
    if rect.is_some_and(|r| r.contains(x, y)) {
        Hit::MaxButton
    } else {
        Hit::Pass
    }
}

/// 蓋板收到的四種非客戶區滑鼠訊息
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NcMsg {
    Move,
    Leave,
    Down,
    Up,
}

/// 訊息 → 狀態機事件。按下與放開只有命中碼是放大鈕才處理（回 None＝交給預設程序）。
pub fn nc_event(m: NcMsg, wparam: usize) -> Option<Ev> {
    match m {
        NcMsg::Move => Some(move_event(wparam)),
        NcMsg::Leave => Some(Ev::Leave),
        NcMsg::Down if wparam == HT_MAXBUTTON => Some(Ev::Down),
        NcMsg::Up if wparam == HT_MAXBUTTON => Some(Ev::Up),
        NcMsg::Down | NcMsg::Up => None,
    }
}

/// 滑鼠在鈕上移動時要（重新）要求「離開」通知，否則收不到 WM_NCMOUSELEAVE
pub fn needs_leave_tracking(ev: Ev) -> bool {
    ev == Ev::Move
}

/// 點擊完成後要送給最上層視窗的系統命令
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SysCmd {
    Maximize,
    Restore,
}

/// 已經最大化就還原，否則最大化
pub fn toggle_cmd(zoomed: bool) -> SysCmd {
    if zoomed {
        SysCmd::Restore
    } else {
        SysCmd::Maximize
    }
}

/// debug log 的節流：同一種事件只記前 `limit` 次。`done` 是已經記過幾次
pub fn log_first_n(done: u32, limit: u32) -> bool {
    done < limit
}

/// 扣掉上緣調整大小的那一條：放大鈕貼著視窗上緣，整條上緣都要能拖邊縮放，所以命中矩形上方要讓出 `border` 像素。
/// - 視窗最大化時沒有調整大小的邊框，不扣
/// - 矩形本來就在邊框以下（top >= border）不動；只拿掉和邊框重疊的那一段（top 抬到 border）
/// - `border` 為 0 或負數當成不用扣；扣完沒有面積（鈕整個落在邊框裡）回 None
pub fn exclude_resize_border(r: PxRect, maximized: bool, border: i32) -> Option<PxRect> {
    let top = if maximized || border <= 0 { r.top } else { r.top.max(border) };
    let out = PxRect { top, ..r };
    (out.width() > 0 && out.height() > 0).then_some(out)
}

/// 從 lParam 取出有號的 x、y（螢幕座標可能是負的，多螢幕在主螢幕左邊時）
pub fn lparam_xy(lparam: isize) -> (i32, i32) {
    let x = (lparam & 0xFFFF) as u16 as i16 as i32;
    let y = ((lparam >> 16) & 0xFFFF) as u16 as i16 as i32;
    (x, y)
}

/// WM_NCMOUSEMOVE 的 wParam 是放大鈕才算在鈕上移動；移到別的非客戶區（邊框）等同離開
pub fn move_event(wparam: usize) -> Ev {
    if wparam == HT_MAXBUTTON {
        Ev::Move
    } else {
        Ev::Leave
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn btn() -> Option<PxRect> {
        Some(PxRect { left: 900, top: 0, right: 969, bottom: 54 })
    }

    #[test]
    fn 蓋板在鈕的矩形內回放大鈕() {
        assert_eq!(hit_answer(btn(), 900, 0), Hit::MaxButton);
        assert_eq!(hit_answer(btn(), 968, 53), Hit::MaxButton);
        assert_eq!(hit_answer(btn(), 969, 10), Hit::Pass, "右邊界外不回放大鈕");
        assert_eq!(hit_answer(btn(), 899, 10), Hit::Pass);
        assert_eq!(hit_answer(btn(), 920, 54), Hit::Pass);
        assert_eq!(hit_answer(None, 920, 10), Hit::Pass, "還沒回報矩形就不處理");
    }

    #[test]
    fn 蓋板的非客戶區訊息對應到狀態機事件() {
        assert_eq!(nc_event(NcMsg::Move, HT_MAXBUTTON), Some(Ev::Move));
        assert_eq!(nc_event(NcMsg::Move, 10), Some(Ev::Leave), "移到別的命中碼算離開");
        assert_eq!(nc_event(NcMsg::Leave, 0), Some(Ev::Leave));
        assert_eq!(nc_event(NcMsg::Down, HT_MAXBUTTON), Some(Ev::Down));
        assert_eq!(nc_event(NcMsg::Up, HT_MAXBUTTON), Some(Ev::Up));
        assert_eq!(nc_event(NcMsg::Down, 2), None, "不是放大鈕的按下不處理");
        assert_eq!(nc_event(NcMsg::Up, 2), None);
        assert!(needs_leave_tracking(Ev::Move));
        assert!(!needs_leave_tracking(Ev::Down) && !needs_leave_tracking(Ev::Leave) && !needs_leave_tracking(Ev::Up));
    }

    #[test]
    fn 按下拖出去再放開不算點擊() {
        use super::super::{step, BtnState};
        // 用蓋板實際收到的訊息順序：移入、按下、（拖出鈕外）離開、在別處放開（蓋板收不到放開；就算收到也不算）
        let mut s = BtnState::default();
        let mut toggled = false;
        for m in [NcMsg::Move, NcMsg::Down, NcMsg::Leave, NcMsg::Up] {
            let r = step(s, nc_event(m, HT_MAXBUTTON).unwrap());
            s = r.state;
            toggled |= r.toggle;
        }
        assert!(!toggled, "拖出去就取消按下，之後放開不能最大化");
        assert_eq!(s, BtnState::default());
        // 對照：不離開就是點擊
        let mut s = BtnState::default();
        let mut clicks = 0;
        for m in [NcMsg::Move, NcMsg::Down, NcMsg::Up] {
            let r = step(s, nc_event(m, HT_MAXBUTTON).unwrap());
            s = r.state;
            clicks += r.toggle as u32;
        }
        assert_eq!(clicks, 1);
    }

    #[test]
    fn 點擊後依最大化狀態切換() {
        assert_eq!(toggle_cmd(false), SysCmd::Maximize);
        assert_eq!(toggle_cmd(true), SysCmd::Restore);
    }

    #[test]
    fn debug_log_只記前_n_次() {
        assert!(log_first_n(0, 3) && log_first_n(2, 3));
        assert!(!log_first_n(3, 3) && !log_first_n(100, 3));
        assert!(!log_first_n(0, 0));
    }

    fn top_btn() -> PxRect {
        PxRect { left: 900, top: 0, right: 969, bottom: 54 }
    }

    #[test]
    fn 沒最大化時上緣讓出調整大小的邊框() {
        // 100% DPI：SM_CYSIZEFRAME 4 + SM_CXPADDEDBORDER 4 = 8
        let e = exclude_resize_border(top_btn(), false, 8).unwrap();
        assert_eq!(e, PxRect { left: 900, top: 8, right: 969, bottom: 54 });
        assert!(!e.contains(920, 7), "上緣那條不在命中範圍內");
        assert!(e.contains(920, 8));
    }

    #[test]
    fn 最大化時不扣() {
        assert_eq!(exclude_resize_border(top_btn(), true, 8), Some(top_btn()));
        assert_eq!(exclude_resize_border(top_btn(), true, 9999), Some(top_btn()), "最大化連極端值也不看");
    }

    #[test]
    fn 邊框高度跟著_dpi_走() {
        // 100%=8、125%=10、150%=12、200%=16、300%=24
        for border in [8, 10, 12, 16, 24] {
            let r = exclude_resize_border(PxRect { left: 0, top: 0, right: 50, bottom: 60 }, false, border).unwrap();
            assert_eq!((r.top, r.bottom, r.left, r.right), (border, 60, 0, 50));
        }
    }

    #[test]
    fn 鈕本來就在邊框以下不動() {
        let r = PxRect { left: 10, top: 20, right: 60, bottom: 50 };
        assert_eq!(exclude_resize_border(r, false, 8), Some(r));
        // 部分重疊：只拿掉重疊的那段
        let r2 = PxRect { left: 10, top: 5, right: 60, bottom: 50 };
        assert_eq!(exclude_resize_border(r2, false, 8), Some(PxRect { top: 8, ..r2 }));
    }

    #[test]
    fn 極端值防呆() {
        assert_eq!(exclude_resize_border(top_btn(), false, 54), None, "邊框剛好吃光整顆鈕");
        assert_eq!(exclude_resize_border(top_btn(), false, 100), None, "邊框比鈕高");
        assert_eq!(exclude_resize_border(top_btn(), false, 53).map(|r| r.height()), Some(1), "只剩 1 像素");
        assert_eq!(exclude_resize_border(top_btn(), false, 0), Some(top_btn()), "邊框 0 不扣");
        assert_eq!(exclude_resize_border(top_btn(), false, -5), Some(top_btn()), "負值當 0");
        assert_eq!(exclude_resize_border(top_btn(), false, i32::MAX), None);
        assert_eq!(exclude_resize_border(PxRect { left: 5, top: 0, right: 5, bottom: 30 }, false, 0), None, "本來就沒面積");
    }

    #[test]
    fn lparam_負座標要保留正負號() {
        assert_eq!(lparam_xy((100i32 as u16 as isize) | ((200i32 as u16 as isize) << 16)), (100, 200));
        let neg = ((-30i32) as u16 as isize) | (((-5i32) as u16 as isize) << 16);
        assert_eq!(lparam_xy(neg), (-30, -5));
    }

    #[test]
    fn 移到鈕以外的非客戶區算離開() {
        assert_eq!(move_event(HT_MAXBUTTON), Ev::Move);
        assert_eq!(move_event(10), Ev::Leave, "HTLEFT 之類");
        assert_eq!(move_event(2), Ev::Leave, "HTCAPTION");
    }
}

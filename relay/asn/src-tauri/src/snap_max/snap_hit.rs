//! 放大鈕分割版面（#1788）的純邏輯：「滑鼠點在不在鈕上、該怎麼回答 WM_NCHITTEST」。
//! 不依賴系統，可直接單元測試；Windows 的視窗程序只負責把訊息翻成這裡的輸入。
use super::{Ev, PxRect};

/// `WM_NCHITTEST` 的 `HTMAXBUTTON`；`WM_NC*` 滑鼠訊息的 wParam 就是命中碼
pub const HT_MAXBUTTON: usize = 9;

/// 收到 WM_NCHITTEST 的是哪一層視窗
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Role {
    /// wry 的網頁容器（WRY_WEBVIEW）
    Container,
    /// 最上層視窗
    Top,
}

/// 對 WM_NCHITTEST 的回答
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Hit {
    /// HTTRANSPARENT：這層當作不存在，交給底下的同執行緒視窗
    Transparent,
    /// HTMAXBUTTON：這裡是放大鈕
    MaxButton,
    /// 不處理，交給原本的視窗程序（維持 tao 的邊框縮放等）
    Pass,
}

/// 命中判斷。`(x, y)` 是最上層視窗內容區座標（實體像素），`rect` 是鈕的矩形（尚未設定就是 None）。
/// - 網頁容器：鈕的矩形內透明，其餘不處理
/// - 最上層視窗：鈕的矩形內回放大鈕，其餘不處理
pub fn hit_answer(role: Role, rect: Option<PxRect>, x: i32, y: i32) -> Hit {
    let inside = rect.is_some_and(|r| r.contains(x, y));
    match role {
        Role::Container if inside => Hit::Transparent,
        Role::Top if inside => Hit::MaxButton,
        _ => Hit::Pass,
    }
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
    fn 最上層視窗只在鈕的矩形內回放大鈕() {
        assert_eq!(hit_answer(Role::Top, btn(), 900, 0), Hit::MaxButton);
        assert_eq!(hit_answer(Role::Top, btn(), 968, 53), Hit::MaxButton);
        assert_eq!(hit_answer(Role::Top, btn(), 969, 10), Hit::Pass, "右邊界外交回原程序（邊框縮放）");
        assert_eq!(hit_answer(Role::Top, btn(), 899, 10), Hit::Pass);
        assert_eq!(hit_answer(Role::Top, btn(), 920, 54), Hit::Pass);
        assert_eq!(hit_answer(Role::Top, None, 920, 10), Hit::Pass, "還沒回報矩形就不處理");
    }

    #[test]
    fn 網頁容器在鈕的矩形內透明_其餘不處理() {
        assert_eq!(hit_answer(Role::Container, btn(), 920, 10), Hit::Transparent);
        assert_eq!(hit_answer(Role::Container, btn(), 500, 300), Hit::Pass, "鈕以外網頁照常收滑鼠");
        assert_eq!(hit_answer(Role::Container, None, 920, 10), Hit::Pass);
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

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

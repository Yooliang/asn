//! 正在聽的歌（像舊 MSN 的「正在聽：歌名 - 歌手」）。
//!
//! 隱私：預設關。開關關著時完全不讀系統媒體；開了才讀，而且只取「歌名」與「歌手」兩個字串，
//! 不取專輯圖、應用程式名稱、播放進度。只有播放中才有值，暫停或沒播放就是 None。
//! 讀取來源用 `MediaSource` 抽象：真正的實作只在 Windows（系統媒體控制），測試用假實作。

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

/// 歌名＋歌手合起來最多這麼多字（回報的個人訊息上限是 80，前綴「♪ 正在聽：」佔 6）
pub const NOW_PLAYING_MAX: usize = 60;
/// 對外顯示的前綴
pub const NOW_PLAYING_PREFIX: &str = "♪ 正在聽：";
/// 輪詢間隔
pub const POLL_SECS: u64 = 15;

/// 來源讀到的一首歌（只有這兩個欄位；沒有別的資訊會離開來源）
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Track {
    pub title: String,
    pub artist: String,
}

/// 媒體來源：回傳「目前播放中」的那首；暫停、停止、沒有播放器都回 None
pub trait MediaSource {
    fn playing(&self) -> Option<Track>;
}

/// 去控制字元與方向控制／零寬字元，空白壓成一格，頭尾去空白
pub fn clean_text(s: &str) -> String {
    let kept: String = s
        .chars()
        .filter(|c| !c.is_control() && !matches!(*c, '\u{200b}'..='\u{200f}' | '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}' | '\u{feff}'))
        .collect();
    kept.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// 「歌名 - 歌手」；歌名空白就整個不顯示，歌手空白只顯示歌名；超過長度截斷加「…」
pub fn format_track(t: &Track) -> Option<String> {
    let title = clean_text(&t.title);
    if title.is_empty() {
        return None;
    }
    let artist = clean_text(&t.artist);
    let full = if artist.is_empty() { title } else { format!("{title} - {artist}") };
    if full.chars().count() <= NOW_PLAYING_MAX {
        Some(full)
    } else {
        Some(full.chars().take(NOW_PLAYING_MAX - 1).collect::<String>() + "…")
    }
}

/// 要送出去的個人訊息：有歌就「♪ 正在聽：歌名 - 歌手」，沒有就用使用者自己打的個人訊息
pub fn compose_psm(own_psm: &str, now: &str) -> String {
    if now.is_empty() {
        own_psm.to_string()
    } else {
        format!("{NOW_PLAYING_PREFIX}{now}")
    }
}

/// 一次輪詢：開關關著就**不碰來源**，直接回 None
pub fn poll_once(enabled: bool, src: &dyn MediaSource) -> Option<String> {
    if !enabled {
        return None;
    }
    src.playing().and_then(|t| format_track(&t))
}

/// 開關與目前的歌（輪詢執行緒與 Relay 共用）
#[derive(Default)]
pub struct NowPlaying {
    enabled: AtomicBool,
    current: Mutex<String>,
}

impl NowPlaying {
    pub fn enabled(&self) -> bool {
        self.enabled.load(Ordering::Relaxed)
    }
    /// 設開關；關掉時立刻清掉目前的歌（回傳 true＝值有變）
    pub fn set_enabled(&self, on: bool) -> bool {
        self.enabled.store(on, Ordering::Relaxed);
        if on { false } else { self.set_current("") }
    }
    pub fn current(&self) -> String {
        self.current.lock().unwrap().clone()
    }
    fn set_current(&self, s: &str) -> bool {
        let mut g = self.current.lock().unwrap();
        if *g == s {
            return false;
        }
        *g = s.to_string();
        true
    }
    /// 輪詢一次並更新；回傳 Some(新值) 代表有變（空字串＝沒在聽）
    pub fn tick(&self, src: &dyn MediaSource) -> Option<String> {
        let now = poll_once(self.enabled(), src).unwrap_or_default();
        self.set_current(&now).then_some(now)
    }
}

#[cfg(windows)]
pub mod sys {
    use super::{MediaSource, Track};
    use windows::Media::Control::{GlobalSystemMediaTransportControlsSessionManager as Mgr, GlobalSystemMediaTransportControlsSessionPlaybackStatus as St};
    use windows::Win32::System::Com::{CoInitializeEx, COINIT_MULTITHREADED};

    /// 系統媒體控制：在所有播放工作階段裡找第一個「播放中」的，只取曲名與歌手
    pub struct SystemMedia;

    impl SystemMedia {
        /// 輪詢執行緒開頭呼叫一次（等待非同步結果需要 COM）
        pub fn init_thread() {
            unsafe {
                let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
            }
        }
        fn read() -> windows::core::Result<Option<Track>> {
            let mgr = Mgr::RequestAsync()?.join()?;
            for s in mgr.GetSessions()? {
                if s.GetPlaybackInfo()?.PlaybackStatus()? != St::Playing {
                    continue;
                }
                let p = s.TryGetMediaPropertiesAsync()?.join()?;
                return Ok(Some(Track { title: p.Title()?.to_string(), artist: p.Artist()?.to_string() }));
            }
            Ok(None)
        }
    }

    impl MediaSource for SystemMedia {
        fn playing(&self) -> Option<Track> {
            Self::read().ok().flatten()
        }
    }
}

/// 啟動輪詢執行緒（Windows）；`wake` 收到訊號就立刻輪詢一次（開關切換時）。
/// `on_change(新值)` 在歌變了時被呼叫（空字串＝沒在聽）。非 Windows 不做任何事。
pub fn spawn_poller(state: std::sync::Arc<NowPlaying>, wake: std::sync::mpsc::Receiver<()>, on_change: impl Fn(String) + Send + 'static) {
    #[cfg(windows)]
    {
        let _ = std::thread::Builder::new().name("now-playing".into()).spawn(move || {
            sys::SystemMedia::init_thread();
            let src = sys::SystemMedia;
            loop {
                if let Some(v) = state.tick(&src) {
                    on_change(v);
                }
                match wake.recv_timeout(std::time::Duration::from_secs(POLL_SECS)) {
                    Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
                    _ => {}
                }
            }
        });
    }
    #[cfg(not(windows))]
    {
        let _ = (state, wake, on_change);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;

    /// 假來源：記錄被讀了幾次
    struct Fake {
        track: Option<Track>,
        reads: Cell<u32>,
    }
    impl Fake {
        fn new(t: Option<(&str, &str)>) -> Fake {
            Fake { track: t.map(|(a, b)| Track { title: a.into(), artist: b.into() }), reads: Cell::new(0) }
        }
    }
    impl MediaSource for Fake {
        fn playing(&self) -> Option<Track> {
            self.reads.set(self.reads.get() + 1);
            self.track.clone()
        }
    }

    #[test]
    fn 開關關著不讀來源也沒有值() {
        let f = Fake::new(Some(("夜曲", "周杰倫")));
        assert_eq!(poll_once(false, &f), None);
        assert_eq!(f.reads.get(), 0, "關著時絕不能去讀系統媒體");
        let np = NowPlaying::default();
        assert!(!np.enabled(), "預設關");
        assert_eq!(np.tick(&f), None);
        assert_eq!(f.reads.get(), 0);
        assert_eq!(np.current(), "");
    }

    #[test]
    fn 開了只組歌名加歌手() {
        let f = Fake::new(Some(("夜曲", "周杰倫")));
        assert_eq!(poll_once(true, &f).as_deref(), Some("夜曲 - 周杰倫"));
        assert_eq!(format_track(&Track { title: "Song".into(), artist: String::new() }).as_deref(), Some("Song"));
        assert_eq!(format_track(&Track { title: "  ".into(), artist: "某人".into() }), None);
        // Track 只有兩個欄位：專輯圖、應用程式、進度根本進不來
        let Track { title: _, artist: _ } = Track { title: String::new(), artist: String::new() };
    }

    #[test]
    fn 暫停或沒播放就是沒有() {
        let f = Fake::new(None);
        assert_eq!(poll_once(true, &f), None);
        assert_eq!(f.reads.get(), 1);
    }

    #[test]
    fn 控制字元與方向字元被濾掉且限長() {
        assert_eq!(clean_text("a\u{0}b\r\nc\u{202e}d\u{200b}  e"), "abcd e");
        let long = format_track(&Track { title: "長".repeat(100), artist: "手".into() }).unwrap();
        assert_eq!(long.chars().count(), NOW_PLAYING_MAX);
        assert!(long.ends_with('…'));
        assert!(compose_psm("", &long).chars().count() <= 80, "加前綴後不超過後端上限 80");
    }

    #[test]
    fn 狀態列組合有歌用歌沒歌用自己的() {
        assert_eq!(compose_psm("寫程式", ""), "寫程式");
        assert_eq!(compose_psm("寫程式", "夜曲 - 周杰倫"), "♪ 正在聽：夜曲 - 周杰倫");
    }

    #[test]
    fn 輪詢追蹤變化且關掉立刻清空() {
        let np = NowPlaying::default();
        np.set_enabled(true);
        let a = Fake::new(Some(("A", "x")));
        assert_eq!(np.tick(&a).as_deref(), Some("A - x"));
        assert_eq!(np.tick(&a), None, "沒變不重複通知");
        let none = Fake::new(None);
        assert_eq!(np.tick(&none).as_deref(), Some(""), "暫停後清空");
        np.tick(&a);
        assert!(np.set_enabled(false), "關掉時有值被清掉");
        assert_eq!(np.current(), "");
        let before = a.reads.get();
        assert_eq!(np.tick(&a), None);
        assert_eq!(a.reads.get(), before, "關掉後不再讀");
    }
}

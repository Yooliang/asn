//! #2300 診斷用：放大鈕分割版面的命中記錄，一律寫進 ui.log（行首 `[snap]`）。
//!
//! 視窗訊息程序每次滑鼠移動都會跑，寫檔又在畫面執行緒上，所以一定要節流：
//! - 只記放大鈕矩形附近的命中（`near_rect`）；
//! - 同一種記錄、結果沒變時，最少隔 `MIN_GAP_MS` 才記一行；結果變了就記；
//! - 整次執行最多 `MAX_LINES` 行，到上限時記一行「之後略過」就停。
//!
//! 節流與上限是不依賴系統的純函式（`Throttle`），可直接單元測試；寫檔那一層只是薄薄一層。
use super::PxRect;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Mutex, OnceLock};

/// 整次執行最多寫幾行（含「之後略過」那一行以外的全部）
pub const MAX_LINES: u32 = 300;
/// 同一種記錄、結果沒變時的最短間隔（毫秒）
pub const MIN_GAP_MS: i64 = 1000;
/// 命中點離鈕矩形多遠以內還算「附近」（實體像素）
pub const NEAR_PX: i32 = 4;

/// 節流的裁決
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Verdict {
    /// 寫這一行
    Write,
    /// 略過
    Skip,
    /// 到上限了：寫「之後略過」這一行（只會回一次）
    WriteCapNotice,
}

#[derive(Debug, Default)]
pub struct Throttle {
    /// 各種記錄上次寫的時間與結果
    last: HashMap<&'static str, (i64, String)>,
    written: u32,
    notified: bool,
}

impl Throttle {
    /// `kind`＝哪一種記錄；`key`＝這次的結果（結果變了才算新資料）；`now_ms`＝現在時間（毫秒）
    pub fn decide(&mut self, kind: &'static str, key: &str, now_ms: i64) -> Verdict {
        if self.written >= MAX_LINES {
            return self.cap();
        }
        if let Some((t, k)) = self.last.get(kind) {
            // 時間倒退（校時）當成已經過了，免得永遠不記
            let gap = now_ms - *t;
            if k == key && (0..MIN_GAP_MS).contains(&gap) {
                return Verdict::Skip;
            }
        }
        self.last.insert(kind, (now_ms, key.to_string()));
        self.written += 1;
        Verdict::Write
    }

    /// 不節流（安裝、失敗這類本來就少的記錄），但仍算進上限
    pub fn decide_always(&mut self) -> Verdict {
        if self.written >= MAX_LINES {
            return self.cap();
        }
        self.written += 1;
        Verdict::Write
    }

    fn cap(&mut self) -> Verdict {
        if self.notified {
            Verdict::Skip
        } else {
            self.notified = true;
            Verdict::WriteCapNotice
        }
    }

    pub fn written(&self) -> u32 {
        self.written
    }
}

/// 命中點（內容區座標）在不在鈕矩形外擴 `margin` 像素的範圍內；沒有矩形一律 false
pub fn near_rect(rect: Option<PxRect>, x: i32, y: i32, margin: i32) -> bool {
    match rect {
        Some(r) => x >= r.left - margin && x < r.right + margin && y >= r.top - margin && y < r.bottom + margin,
        None => false,
    }
}

// ---------- 以下是寫檔那一層（全程序共用一份） ----------

static DIR: OnceLock<PathBuf> = OnceLock::new();
static THROTTLE: Mutex<Option<Throttle>> = Mutex::new(None);

/// 各層收到命中測試／非客戶區滑鼠訊息的累計（只計數、不寫檔，記錄時帶上）
pub static TOP_HITS: AtomicU32 = AtomicU32::new(0);
pub static CONTAINER_HITS: AtomicU32 = AtomicU32::new(0);
pub static COVER_HITS: AtomicU32 = AtomicU32::new(0);
pub static NC_MOVES: AtomicU32 = AtomicU32::new(0);
pub static NC_LEAVES: AtomicU32 = AtomicU32::new(0);

pub fn bump(c: &AtomicU32) {
    c.fetch_add(1, Ordering::Relaxed);
}

/// 一行計數摘要，附在每筆記錄後面
pub fn counts() -> String {
    format!(
        "計數 最上層命中={} 容器命中={} 蓋板命中={} NCMOUSEMOVE={} NCMOUSELEAVE={}",
        TOP_HITS.load(Ordering::Relaxed),
        CONTAINER_HITS.load(Ordering::Relaxed),
        COVER_HITS.load(Ordering::Relaxed),
        NC_MOVES.load(Ordering::Relaxed),
        NC_LEAVES.load(Ordering::Relaxed),
    )
}

/// 記下 ui.log 所在的資料夾（第一次成功就固定）
pub fn bind(app: &tauri::AppHandle) {
    use tauri::Manager;
    if DIR.get().is_some() {
        return;
    }
    if let Some(a) = app.try_state::<crate::App>() {
        let _ = DIR.set(a.work_dir.clone());
    }
}

fn now_ms() -> i64 {
    crate::heartbeat::now_ms() as i64
}

fn write(msg: &str) {
    if let Some(d) = DIR.get() {
        let line = format!("{} info [ASN] [snap] {msg}", crate::quota_core::iso_secs(now_ms()));
        let _ = crate::ui_log::append(d, &[line]);
    }
}

fn emit(v: Verdict, msg: impl FnOnce() -> String) {
    match v {
        Verdict::Write => write(&msg()),
        Verdict::WriteCapNotice => write(&format!("已記滿 {MAX_LINES} 行，之後略過")),
        Verdict::Skip => {}
    }
}

fn with_throttle<R>(f: impl FnOnce(&mut Throttle) -> R) -> R {
    let mut g = THROTTLE.lock().unwrap_or_else(|e| e.into_inner());
    f(g.get_or_insert_with(Throttle::default))
}

/// 不節流的一行（安裝成功、各種失敗）；仍算進上限
pub fn line(msg: &str) {
    let v = with_throttle(|t| t.decide_always());
    emit(v, || msg.to_string());
}

/// 節流的一行：`msg` 只有真的要寫時才會組（組字串前要查系統的值很花時間）
pub fn throttled(kind: &'static str, key: &str, msg: impl FnOnce() -> String) {
    let v = with_throttle(|t| t.decide(kind, key, now_ms()));
    emit(v, msg);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rect() -> PxRect {
        PxRect { left: 100, top: 10, right: 140, bottom: 40 }
    }

    #[test]
    fn 第一筆一定記() {
        let mut t = Throttle::default();
        assert_eq!(t.decide("top", "9", 0), Verdict::Write);
    }

    #[test]
    fn 結果沒變一秒內略過_滿一秒再記() {
        let mut t = Throttle::default();
        assert_eq!(t.decide("top", "9", 0), Verdict::Write);
        assert_eq!(t.decide("top", "9", 500), Verdict::Skip);
        assert_eq!(t.decide("top", "9", 999), Verdict::Skip);
        assert_eq!(t.decide("top", "9", 1000), Verdict::Write);
        assert_eq!(t.decide("top", "9", 1500), Verdict::Skip);
    }

    #[test]
    fn 結果變了馬上記() {
        let mut t = Throttle::default();
        assert_eq!(t.decide("top", "9", 0), Verdict::Write);
        assert_eq!(t.decide("top", "1", 10), Verdict::Write);
        assert_eq!(t.decide("top", "9", 20), Verdict::Write);
    }

    #[test]
    fn 不同種類各算各的() {
        let mut t = Throttle::default();
        assert_eq!(t.decide("top", "9", 0), Verdict::Write);
        assert_eq!(t.decide("container", "9", 1), Verdict::Write);
        assert_eq!(t.decide("top", "9", 2), Verdict::Skip);
        assert_eq!(t.decide("container", "9", 3), Verdict::Skip);
    }

    #[test]
    fn 時間倒退不會卡死() {
        let mut t = Throttle::default();
        assert_eq!(t.decide("top", "9", 5000), Verdict::Write);
        assert_eq!(t.decide("top", "9", 100), Verdict::Write);
    }

    #[test]
    fn 到上限記一行略過就停() {
        let mut t = Throttle::default();
        for i in 0..MAX_LINES {
            // 每筆結果都不同，節流不會擋，只剩上限在擋
            assert_eq!(t.decide("top", &i.to_string(), i as i64), Verdict::Write, "第 {i} 筆");
        }
        assert_eq!(t.written(), MAX_LINES);
        assert_eq!(t.decide("top", "after", 10_000), Verdict::WriteCapNotice);
        assert_eq!(t.decide("top", "after2", 20_000), Verdict::Skip);
        assert_eq!(t.decide("other", "x", 30_000), Verdict::Skip);
        assert_eq!(t.decide_always(), Verdict::Skip);
        assert_eq!(t.written(), MAX_LINES, "略過的不算進行數");
    }

    #[test]
    fn 不節流的行也算進上限() {
        let mut t = Throttle::default();
        for _ in 0..MAX_LINES {
            assert_eq!(t.decide_always(), Verdict::Write);
        }
        assert_eq!(t.decide("top", "9", 0), Verdict::WriteCapNotice);
        assert_eq!(t.decide_always(), Verdict::Skip);
    }

    #[test]
    fn 矩形附近的才算() {
        let r = Some(rect());
        assert!(near_rect(r, 100, 10, 0), "左上角在內");
        assert!(near_rect(r, 139, 39, 0), "右下角內側");
        assert!(!near_rect(r, 140, 39, 0), "右邊界不含");
        assert!(!near_rect(r, 99, 10, 0), "左邊差一格");
        assert!(near_rect(r, 96, 6, NEAR_PX), "外擴 4 像素以內");
        assert!(!near_rect(r, 95, 10, NEAR_PX), "外擴範圍外");
        assert!(near_rect(r, 143, 43, NEAR_PX), "右下外擴");
        assert!(!near_rect(r, 144, 43, NEAR_PX));
        assert!(!near_rect(None, 100, 10, NEAR_PX), "沒有矩形一律不算");
    }
}

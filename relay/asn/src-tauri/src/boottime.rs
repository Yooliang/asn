//! 開機後經過的時間（含睡眠）。Android／Linux 的單調時鐘（Instant）在裝置深度睡眠時不走，
//! 手機鎖屏放一陣子再回來，30 秒的憑證、120 秒的題目會「還沒到期」；這裡改讀 CLOCK_BOOTTIME，睡眠期間也照走。
//! 其他平台沒有這個問題，退回從行程啟動算起的 Instant。
use std::time::Duration;

#[cfg(any(target_os = "android", target_os = "linux"))]
pub fn now_boot() -> Duration {
    let mut ts = libc::timespec { tv_sec: 0, tv_nsec: 0 };
    // SAFETY: ts 是這裡的區域變數，指標有效、大小正確；clock_gettime 只寫入它
    let rc = unsafe { libc::clock_gettime(libc::CLOCK_BOOTTIME, &mut ts) };
    if rc != 0 {
        return fallback();
    }
    Duration::new(ts.tv_sec.max(0) as u64, ts.tv_nsec.clamp(0, 999_999_999) as u32)
}

#[cfg(not(any(target_os = "android", target_os = "linux")))]
pub fn now_boot() -> Duration {
    fallback()
}

fn fallback() -> Duration {
    static START: std::sync::OnceLock<std::time::Instant> = std::sync::OnceLock::new();
    START.get_or_init(std::time::Instant::now).elapsed()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 只增不減() {
        let a = now_boot();
        let b = now_boot();
        assert!(b >= a);
    }
}

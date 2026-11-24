//! 被看的那台（T）查觀看請求的等法（#1762）。
//!
//! 以前只有每 10 秒醒一次，按下去要等 0～10 秒。現在後台建了看畫面／打字的要求會敲這台的門鈴，
//! 門鈴一響就叫醒輪詢馬上查；門鈴斷了或沒響，到了 [`POLL_INTERVAL_SECS`] 秒照常查（備援）。
use std::time::Duration;
use tokio::sync::Notify;

pub const POLL_INTERVAL_SECS: u64 = 10;

#[derive(Debug, PartialEq, Eq)]
pub enum Woke {
    /// 門鈴叫醒的
    Bell,
    /// 等滿了（備援輪詢）
    Timer,
}

/// 等到下一次要查的時候：門鈴先到就回 Bell，時間先到就回 Timer。
/// 門鈴在這之前就響過（正在查的時候響的）會留一次，下一輪立刻查，不會漏
pub async fn wait_next(interval: Duration, wake: &Notify) -> Woke {
    tokio::select! {
        _ = tokio::time::sleep(interval) => Woke::Timer,
        _ = wake.notified() => Woke::Bell,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Instant;

    #[tokio::test]
    async fn 門鈴響了不用等輪詢間隔() {
        let n = std::sync::Arc::new(Notify::new());
        let n2 = n.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(50)).await;
            n2.notify_one();
        });
        let t = Instant::now();
        let w = wait_next(Duration::from_secs(POLL_INTERVAL_SECS), &n).await;
        assert_eq!(w, Woke::Bell);
        assert!(t.elapsed() < Duration::from_secs(2), "門鈴要馬上醒，實際 {:?}", t.elapsed());
    }

    #[tokio::test]
    async fn 門鈴沒響時照間隔輪詢() {
        let n = Notify::new();
        let t = Instant::now();
        assert_eq!(wait_next(Duration::from_millis(80), &n).await, Woke::Timer);
        assert!(t.elapsed() >= Duration::from_millis(70));
    }

    #[tokio::test]
    async fn 查的時候響的門鈴留到下一輪() {
        let n = Notify::new();
        n.notify_one();   // 正在查的時候響了
        let t = Instant::now();
        assert_eq!(wait_next(Duration::from_secs(POLL_INTERVAL_SECS), &n).await, Woke::Bell);
        assert!(t.elapsed() < Duration::from_secs(1));
    }

    #[test]
    fn 守門_輪詢用門鈴醒_備援間隔還在() {
        let lib = include_str!("lib.rs").replace("\r\n", "\n");
        let f = lib.split("fn start_view_poller(").nth(1).expect("有 start_view_poller").split("\n}\n").next().unwrap();
        assert!(f.contains("view_wake::wait_next("), "輪詢要用 wait_next，不能只 sleep");
        assert!(f.contains("view_wake::POLL_INTERVAL_SECS"), "備援輪詢還在");
        assert!(!f.contains("tokio::time::sleep(std::time::Duration::from_secs(10)).await;\n            // 放行條件"), "不能退回純 sleep");
        // 門鈴的回呼要叫醒這個輪詢
        let bell = lib.split("bell::run(url, topic, move |ring| {").nth(1).expect("有門鈴回呼").split(".await;").next().unwrap();
        assert!(bell.contains("view_notify_bell") || bell.contains("view_wake_bell"), "門鈴要叫醒看畫面的輪詢");
        assert!(bell.contains("w.notify_one()"));
    }
}

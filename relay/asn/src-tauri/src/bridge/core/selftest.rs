//! 轉交原文替換的啟動自我測試接進橋（#780 第二段）。探針本身在 forward_selftest.rs。
//! 開了 ASN_FORWARD_EXACT 才會跑：這一版 claude 的版本和通過紀錄一樣就直接算通過，否則在背景跑探針（約 20 秒，不用登入、不花額度）。
//! 通過才讓原文替換生效；沒通過（內容不同）或測不了，轉交一律走舊辦法，log 寫明，一小時後再試；通過後每小時也重看一次版本，CLI 換版了就重測。
use super::super::forward_selftest::{self, Outcome};
use super::*;

const RETRY_MS: u64 = 3_600_000;

/// 自我測試的做法：回（claude 版本, 結果）。會阻塞，在背景執行緒跑；測試時換成假的
pub type SelftestFn = Arc<dyn Fn(&str, &std::path::Path) -> (Option<String>, Outcome) + Send + Sync>;

pub fn real_selftest(claude: &str, dir: &std::path::Path) -> (Option<String>, Outcome) {
    let Some(ver) = forward_selftest::claude_version(claude) else {
        return (None, Outcome::Unrun("讀不到 claude 的版本".into()));
    };
    if forward_selftest::passed_version(dir).as_deref() == Some(ver.as_str()) {
        return (Some(ver), Outcome::Passed("recorded".into()));
    }
    let o = forward_selftest::probe(claude, dir, std::time::Duration::from_secs(60));
    if matches!(o, Outcome::Passed(_)) {
        let _ = forward_selftest::save_passed(dir, &ver, crate::heartbeat::now_ms());
    }
    (Some(ver), o)
}

impl Core {
    pub async fn selftest_tick(&mut self, now: u64) {
        // 沒開、沒有 hook、或開發機強制生效（跳過自我測試）：不測
        if !self.cfg.forward_exact || !self.cfg.forward_hook || self.cfg.forward_exact_unverified {
            return;
        }
        let done = self.selftest_slot.lock().unwrap().take();
        if let Some((ver, o)) = done {
            self.selftest_busy = false;
            self.selftest_next_at = now + RETRY_MS;
            let v = ver.unwrap_or_else(|| "?".into());
            match o {
                Outcome::Passed(how) => {
                    if !self.exact_verified {
                        self.log.line(&format!("forward-exact selftest passed claude={v} {how}"));
                    }
                    self.exact_verified = true;
                }
                Outcome::Failed(why) => {
                    self.log.line(&format!("forward-exact selftest FAILED claude={v}: {why}（轉交走舊辦法，一小時後再試）"));
                    self.exact_verified = false;
                }
                Outcome::Unrun(why) => {
                    self.log.line(&format!("forward-exact selftest 未驗 claude={v}: {why}（轉交走舊辦法，一小時後再試）"));
                    self.exact_verified = false;
                }
            }
            return;
        }
        if self.selftest_busy || now < self.selftest_next_at {
            return;
        }
        self.selftest_busy = true;
        let (slot, src, claude, dir) = (self.selftest_slot.clone(), self.selftest_src.clone(), self.cfg.claude_bin.clone(), self.cfg.work_dir.clone());
        tokio::task::spawn_blocking(move || {
            let r = src(&claude, &dir);
            *slot.lock().unwrap() = Some(r);
        });
    }
}

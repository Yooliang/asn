//! 讀夥伴畫面判斷卡在哪（todo-next-162 第 2 段）的排程。只決定「這一輪讀哪幾扇」，不碰檔案與程序，好測。
//! 開關預設關（ASN_SCREEN_WATCH=1 才開）。讀畫面本身有開銷，所以有三道限制：每分鐘總量上限、讀失敗就退避、空記憶體低就整個暫停。
#![cfg_attr(not(test), allow(dead_code))]
use std::collections::HashMap;

pub const ENV_SCREEN_WATCH: &str = "ASN_SCREEN_WATCH";
/// 一輪的間隔
pub const TICK_MS: u64 = 5_000;
/// 一輪進行中（或不知道狀態）的視窗多久讀一次
const FREQUENT_MS: u64 = 5_000;
/// 閒置的視窗多久讀一次：權限提示只在一輪進行中出現，但登入失效、額度用完是停在閒置畫面
const SLOW_MS: u64 = 60_000;
/// 所有視窗加起來，一分鐘最多讀幾次
const MAX_READS_PER_MIN: u32 = 30;
const MINUTE_MS: u64 = 60_000;
/// 讀失敗的退避上限
const MAX_BACKOFF_MS: u64 = 300_000;
/// 空記憶體低於這個值就暫停
const PAUSE_BELOW_BYTES: u64 = 3 * 1024 * 1024 * 1024;
/// 多久寫一行開銷紀錄
const REPORT_EVERY_MS: u64 = 600_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Pace {
    Frequent,
    Slow,
}

impl Pace {
    fn interval(self) -> u64 {
        match self {
            Pace::Frequent => FREQUENT_MS,
            Pace::Slow => SLOW_MS,
        }
    }
}

/// 外掛回報的狀態 → 讀的頻率。閒置才放慢；沒有外掛、狀態不明都照一般頻率（信任提示與登入出現在外掛載入之前）
pub fn pace_of(mod_state: Option<&str>) -> Pace {
    if mod_state == Some("idle") {
        Pace::Slow
    } else {
        Pace::Frequent
    }
}

/// 夥伴視窗 → 它現在的 session。對照表的編號只有接續對話時才有，所以用視窗名去對 session 檔。
/// `partners`＝（編號, 視窗名），`sessions`＝活著的（視窗名, session）。同名不猜；還沒有 session 檔的（例如停在信任提示）不列
pub fn match_sessions(partners: &[(String, String)], sessions: &[(String, String)]) -> Vec<(String, String)> {
    partners
        .iter()
        .filter_map(|(id, name)| {
            let mut hits = sessions.iter().filter(|(n, _)| n == name);
            let (_, sid) = hits.next()?;
            let same_name_partners = partners.iter().filter(|(_, n)| n == name).count();
            (hits.next().is_none() && same_name_partners == 1).then(|| (id.clone(), sid.clone()))
        })
        .collect()
}

#[derive(Default)]
pub struct Schedule {
    next_at: HashMap<String, u64>,
    fails: HashMap<String, u32>,
    window_start: u64,
    window_reads: u32,
    reads: u64,
    failed: u64,
    capped: u64,
    paused: u64,
    reported_at: u64,
}

impl Schedule {
    /// 這一輪要讀哪幾扇。`windows`＝（編號, 頻率）；`free_bytes` 讀不到（None）就不靠它判斷。
    /// 最久沒讀的排前面，所以總量不夠時大家輪流，不會一直讀前面幾扇
    pub fn due(&mut self, now: u64, windows: &[(String, Pace)], free_bytes: Option<u64>) -> Vec<String> {
        self.next_at.retain(|id, _| windows.iter().any(|(w, _)| w == id));
        self.fails.retain(|id, _| windows.iter().any(|(w, _)| w == id));
        if free_bytes.is_some_and(|b| b < PAUSE_BELOW_BYTES) {
            self.paused += 1;
            return Vec::new();
        }
        if now.saturating_sub(self.window_start) >= MINUTE_MS {
            self.window_start = now;
            self.window_reads = 0;
        }
        let mut ready: Vec<(u64, &String)> = windows.iter().map(|(id, _)| (self.next_at.get(id).copied().unwrap_or(0), id)).filter(|(at, _)| *at <= now).collect();
        ready.sort();
        let room = MAX_READS_PER_MIN.saturating_sub(self.window_reads) as usize;
        if ready.len() > room {
            self.capped += 1;
        }
        let picked: Vec<String> = ready.into_iter().take(room).map(|(_, id)| id.clone()).collect();
        self.window_reads += picked.len() as u32;
        self.reads += picked.len() as u64;
        picked
    }

    /// 讀完回報。成功照頻率排下一次；失敗依連續失敗次數加倍退避，不重試
    pub fn done(&mut self, id: &str, pace: Pace, ok: bool, now: u64) {
        if ok {
            self.fails.remove(id);
            self.next_at.insert(id.to_string(), now + pace.interval());
            return;
        }
        self.failed += 1;
        let n = self.fails.entry(id.to_string()).or_insert(0);
        *n = n.saturating_add(1);
        let wait = pace.interval().saturating_mul(1u64 << (*n).min(16)).min(MAX_BACKOFF_MS);
        self.next_at.insert(id.to_string(), now + wait);
    }

    /// 該寫開銷紀錄時回一行（累計值），之後歸零
    pub fn report(&mut self, now: u64, windows: usize) -> Option<String> {
        if self.reported_at == 0 {
            self.reported_at = now;
            return None;
        }
        if now.saturating_sub(self.reported_at) < REPORT_EVERY_MS {
            return None;
        }
        let secs = now.saturating_sub(self.reported_at) / 1000;
        let line = format!("screen-watch secs={secs} windows={windows} reads={} failed={} capped={} paused={}", self.reads, self.failed, self.capped, self.paused);
        self.reported_at = now;
        (self.reads, self.failed, self.capped, self.paused) = (0, 0, 0, 0);
        Some(line)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const FREE: Option<u64> = Some(8 * 1024 * 1024 * 1024);
    const NOW: u64 = 1_000_000;

    fn w(n: usize, pace: Pace) -> Vec<(String, Pace)> {
        (0..n).map(|i| (format!("w{i}"), pace)).collect()
    }

    fn pair(a: &str, b: &str) -> (String, String) {
        (a.to_string(), b.to_string())
    }

    #[test]
    fn 用視窗名對_session_新開的對話也對得到_同名不猜_沒有檔案不列() {
        let partners = [pair("1", "甲"), pair("2", "乙"), pair("3", "丙")];
        let sessions = [pair("甲", "s-甲"), pair("丙", "s-丙1"), pair("丙", "s-丙2"), pair("別的", "s-別")];
        assert_eq!(match_sessions(&partners, &sessions), vec![pair("1", "s-甲")], "乙還沒有檔案、丙兩份不猜、別的不是夥伴");
        let twins = [pair("1", "甲"), pair("2", "甲")];
        assert!(match_sessions(&twins, &[pair("甲", "s")]).is_empty(), "兩扇同名也不猜");
    }

    #[test]
    fn 閒置才放慢_沒有外掛或狀態不明照一般頻率() {
        assert_eq!(pace_of(Some("idle")), Pace::Slow);
        for s in [None, Some("busy"), Some("waiting_user"), Some("怪東西")] {
            assert_eq!(pace_of(s), Pace::Frequent);
        }
    }

    #[test]
    fn 依頻率排下一次() {
        let mut s = Schedule::default();
        let ws = vec![("忙".to_string(), Pace::Frequent), ("閒".to_string(), Pace::Slow)];
        assert_eq!(s.due(NOW, &ws, FREE).len(), 2);
        s.done("忙", Pace::Frequent, true, NOW);
        s.done("閒", Pace::Slow, true, NOW);
        assert!(s.due(NOW + 4_999, &ws, FREE).is_empty());
        assert_eq!(s.due(NOW + 5_000, &ws, FREE), vec!["忙"]);
        s.done("忙", Pace::Frequent, true, NOW + 5_000);
        assert_eq!(s.due(NOW + 60_000, &ws, FREE).len(), 2, "閒置的一分鐘才讀");
    }

    #[test]
    fn 一分鐘總量有上限_視窗多也不超過_而且大家輪流() {
        let mut s = Schedule::default();
        let ws = w(50, Pace::Frequent);
        let mut seen = std::collections::HashSet::new();
        let mut per_min = vec![];
        for minute in 0..2u64 {
            let mut count = 0;
            for t in 0..12u64 {
                let now = NOW + minute * MINUTE_MS + t * TICK_MS;
                for id in s.due(now, &ws, FREE) {
                    s.done(&id, Pace::Frequent, true, now);
                    seen.insert(id);
                    count += 1;
                }
            }
            per_min.push(count);
        }
        assert!(per_min.iter().all(|c| *c <= MAX_READS_PER_MIN), "{per_min:?}");
        assert_eq!(seen.len(), 50, "兩分鐘內每一扇都輪得到");
    }

    #[test]
    fn 空記憶體低就暫停_讀不到就不靠它判斷() {
        let mut s = Schedule::default();
        let ws = w(2, Pace::Frequent);
        assert!(s.due(NOW, &ws, Some(PAUSE_BELOW_BYTES - 1)).is_empty());
        assert_eq!(s.due(NOW, &ws, Some(PAUSE_BELOW_BYTES)).len(), 2);
        let mut s = Schedule::default();
        assert_eq!(s.due(NOW, &ws, None).len(), 2);
    }

    #[test]
    fn 讀失敗加倍退避_有上限_成功歸零() {
        let mut s = Schedule::default();
        let ws = w(1, Pace::Frequent);
        s.done("w0", Pace::Frequent, false, NOW);
        assert!(s.due(NOW + 9_999, &ws, FREE).is_empty());
        assert_eq!(s.due(NOW + 10_000, &ws, FREE).len(), 1);
        s.done("w0", Pace::Frequent, false, NOW + 10_000);
        assert!(s.due(NOW + 29_999, &ws, FREE).is_empty(), "第二次失敗等 20 秒");
        for _ in 0..40 {
            s.done("w0", Pace::Frequent, false, NOW);
        }
        assert_eq!(s.next_at["w0"], NOW + MAX_BACKOFF_MS);
        s.done("w0", Pace::Frequent, true, NOW);
        assert_eq!(s.next_at["w0"], NOW + FREQUENT_MS);
    }

    #[test]
    fn 視窗關了就不留紀錄() {
        let mut s = Schedule::default();
        s.done("w0", Pace::Frequent, false, NOW);
        s.due(NOW, &[], FREE);
        assert!(s.next_at.is_empty() && s.fails.is_empty());
    }

    #[test]
    fn 開銷紀錄每十分鐘一行_只有數字() {
        let mut s = Schedule::default();
        assert!(s.report(NOW, 1).is_none(), "第一次只起算");
        s.due(NOW, &w(2, Pace::Frequent), FREE);
        assert!(s.report(NOW + 1_000, 2).is_none());
        let line = s.report(NOW + REPORT_EVERY_MS, 2).unwrap();
        assert!(line.contains("reads=2") && line.contains("windows=2"), "{line}");
        s.due(NOW + REPORT_EVERY_MS, &[], Some(0));
        assert!(s.report(NOW + 2 * REPORT_EVERY_MS, 0).unwrap().contains("reads=0 failed=0 capped=0 paused=1"));
    }
}

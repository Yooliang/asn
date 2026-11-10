//! 讀夥伴畫面判斷卡在哪（todo-next-162 第 2 段）的排程。只決定「這一輪讀哪幾扇」，不碰檔案與程序，好測。
//! Windows 預設開（ASN_SCREEN_WATCH=0 或設定頁關掉），其他平台要 =1。讀畫面本身有開銷，所以有三道限制：每分鐘總量上限、讀失敗就退避、空記憶體低就整個暫停。
#![cfg_attr(not(test), allow(dead_code))]
use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};

pub const ENV_SCREEN_WATCH: &str = "ASN_SCREEN_WATCH";
/// 使用者在設定頁關掉了（存在 bridge.json 的 screen_watch_off；啟動時和改設定時更新）
static USER_OFF: AtomicBool = AtomicBool::new(false);

pub fn set_user_off(off: bool) {
    USER_OFF.store(off, Ordering::SeqCst);
}
pub fn user_off() -> bool {
    USER_OFF.load(Ordering::SeqCst)
}

/// 環境變數怎麼算開（和 win_term 的開關同一套）：Windows 預設開，`0` 才關，其他值都算開；
/// 其他平台要明講 `1`（讀畫面要 WezTerm 窗格，自帶終端目前只打包 Windows）
pub fn enabled_on(windows: bool, value: Option<&str>) -> bool {
    if windows {
        value != Some("0")
    } else {
        value == Some("1")
    }
}
pub fn enabled(value: Option<&str>) -> bool {
    enabled_on(cfg!(windows), value)
}

/// 開關關著就不准用權限命令：不能經這條路讀畫面或送字
pub fn check_allowed(env_on: bool, user_off: bool) -> Result<(), String> {
    if env_on && !user_off {
        Ok(())
    } else {
        Err("這個功能沒有開啟".into())
    }
}
pub fn require_enabled(value: Option<&str>) -> Result<(), String> {
    check_allowed(enabled(value), user_off())
}

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
/// 退避等到這麼久（含）以上才寫一行紀錄，免得每次小失敗都洗版
const BACKOFF_LOG_MS: u64 = 60_000;
/// 空記憶體低於這個值就暫停
pub(super) const PAUSE_BELOW_BYTES: u64 = 3 * 1024 * 1024 * 1024;
/// 多久寫一行開銷紀錄
const REPORT_EVERY_MS: u64 = 600_000;
/// 還沒有 session 檔的視窗，第一次看到後多久內還讀畫面：信任提示、略過權限警告、登入都出現在這段時間，之後就不再花這個開銷
const EARLY_MS: u64 = 600_000;

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

/// 連續失敗、下次要等很久時寫進紀錄的一行：只有視窗編號、次數、秒數，不含任何畫面內容
pub fn backoff_line(id: &str, fails: u32, wait_ms: u64) -> String {
    format!("讀畫面 {id} 連續失敗 {fails} 次，下次在 {} 秒後", wait_ms / 1000)
}

/// 還沒有 session 檔的視窗過了前期、不再讀畫面時寫進紀錄的一行（每扇只寫一次）
pub fn early_stop_line(id: &str) -> String {
    format!("讀畫面 {id} 沒有對話紀錄檔，已超過 {} 分鐘，不再讀這扇視窗的畫面", EARLY_MS / 60_000)
}

#[derive(Default)]
pub struct Schedule {
    next_at: HashMap<String, u64>,
    fails: HashMap<String, u32>,
    first_seen: HashMap<String, u64>,
    early_stopped: HashSet<String>,
    window_start: u64,
    window_reads: u32,
    reads: u64,
    failed: u64,
    capped: u64,
    paused: u64,
    reported_at: u64,
}

impl Schedule {
    /// 還沒有 session 檔的視窗要不要讀：第一次看到後的一段時間內才讀。`current`＝現在表上所有的視窗，關掉的就忘記
    pub fn early(&mut self, id: &str, now: u64, current: &[&str]) -> bool {
        self.first_seen.retain(|k, _| current.contains(&k.as_str()));
        let first = *self.first_seen.entry(id.to_string()).or_insert(now);
        now.saturating_sub(first) < EARLY_MS
    }

    /// 沒有 session 檔的視窗已經過了前期、這一輪不讀它：第一次回一行紀錄，之後回 None。`current`＝現在表上所有的視窗，關掉的就忘記
    pub fn early_stopped(&mut self, id: &str, current: &[&str]) -> Option<String> {
        self.early_stopped.retain(|k| current.contains(&k.as_str()));
        self.early_stopped.insert(id.to_string()).then(|| early_stop_line(id))
    }

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
        // 閒置時排在一分鐘後的下一次，開始工作後要提早：權限提示就出現在這時候。讀失敗退避中的不動
        for (id, pace) in windows {
            if !self.fails.contains_key(id) {
                if let Some(at) = self.next_at.get_mut(id) {
                    *at = (*at).min(now + pace.interval());
                }
            }
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

    /// 讀完回報。成功照頻率排下一次；失敗依連續失敗次數加倍退避，不重試。
    /// 失敗後要等 60 秒以上時回一行紀錄（呼叫端寫進 ui.log），否則回 None
    pub fn done(&mut self, id: &str, pace: Pace, ok: bool, now: u64) -> Option<String> {
        if ok {
            self.fails.remove(id);
            self.next_at.insert(id.to_string(), now + pace.interval());
            return None;
        }
        self.failed += 1;
        let n = self.fails.entry(id.to_string()).or_insert(0);
        *n = n.saturating_add(1);
        let fails = *n;
        let wait = pace.interval().saturating_mul(1u64 << fails.min(16)).min(MAX_BACKOFF_MS);
        self.next_at.insert(id.to_string(), now + wait);
        (wait >= BACKOFF_LOG_MS).then(|| backoff_line(id, fails, wait))
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
    fn windows_預設開_只有_0_才關_打錯字不會悄悄關掉() {
        for v in [None, Some(""), Some("1"), Some("true"), Some("11")] {
            assert!(enabled_on(true, v), "{v:?}");
        }
        assert!(!enabled_on(true, Some("0")));
    }

    #[test]
    fn 其他平台_要明講_1_才開() {
        assert!(enabled_on(false, Some("1")));
        for v in [None, Some(""), Some("0"), Some("true"), Some("11")] {
            assert!(!enabled_on(false, v), "{v:?}");
        }
    }

    #[test]
    fn 環境變數關或設定頁關_權限命令都回錯() {
        assert!(check_allowed(true, false).is_ok());
        assert!(check_allowed(false, false).is_err());
        assert!(check_allowed(true, true).is_err());
        assert!(check_allowed(false, true).is_err());
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
    fn 閒置轉成工作中_下一次提早_不用等滿一分鐘() {
        let mut s = Schedule::default();
        let id = "w0".to_string();
        assert_eq!(s.due(NOW, &[(id.clone(), Pace::Slow)], FREE).len(), 1);
        s.done("w0", Pace::Slow, true, NOW);
        let busy = [(id.clone(), Pace::Frequent)];
        let t = NOW + 1_000;
        assert!(s.due(t, &busy, FREE).is_empty(), "剛轉成工作中，這一輪還不用讀");
        assert_eq!(s.due(t + FREQUENT_MS, &busy, FREE), vec!["w0"], "工作中的頻率內就讀到，不等滿一分鐘");
    }

    #[test]
    fn 讀失敗退避中_轉成工作中也不提早() {
        let mut s = Schedule::default();
        let busy = [("w0".to_string(), Pace::Frequent)];
        for _ in 0..5 {
            s.done("w0", Pace::Slow, false, NOW);
        }
        assert_eq!(s.next_at["w0"], NOW + MAX_BACKOFF_MS);
        assert!(s.due(NOW + 10_000, &busy, FREE).is_empty());
        assert_eq!(s.next_at["w0"], NOW + MAX_BACKOFF_MS);
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
    fn 沒有_session_檔的視窗_只在第一次看到後的一段時間內讀() {
        let mut s = Schedule::default();
        assert!(s.early("w0", NOW, &["w0"]));
        assert!(s.early("w0", NOW + EARLY_MS - 1, &["w0"]));
        assert!(!s.early("w0", NOW + EARLY_MS, &["w0"]), "時間到就不讀");
        assert!(s.early("w1", NOW + EARLY_MS, &["w0", "w1"]), "另一扇各算各的");
        assert!(s.early("w0", NOW + EARLY_MS + 1, &["w0"]) == false);
        s.first_seen.clear();
        s.early("w0", NOW, &["w0"]);
        s.early("w1", NOW, &["w1"]);
        assert!(!s.first_seen.contains_key("w0"), "關掉的視窗就忘記");
    }

    #[test]
    fn 退避到一分鐘以上才回一行紀錄_只有編號次數秒數() {
        let mut s = Schedule::default();
        // 5 秒的視窗：失敗 1～3 次等 10、20、40 秒，不寫；第 4 次起 80 秒、160 秒，寫；之後頂在 300 秒
        for n in 1..=3 {
            assert_eq!(s.done("w0", Pace::Frequent, false, NOW), None, "第 {n} 次");
        }
        assert_eq!(s.done("w0", Pace::Frequent, false, NOW).as_deref(), Some("讀畫面 w0 連續失敗 4 次，下次在 80 秒後"));
        assert_eq!(s.done("w0", Pace::Frequent, false, NOW).as_deref(), Some("讀畫面 w0 連續失敗 5 次，下次在 160 秒後"));
        assert_eq!(s.done("w0", Pace::Frequent, false, NOW).as_deref(), Some("讀畫面 w0 連續失敗 6 次，下次在 300 秒後"));
        assert_eq!(s.done("w0", Pace::Frequent, true, NOW), None, "成功不寫");
        assert_eq!(s.done("w0", Pace::Frequent, false, NOW), None, "成功後從頭算");
        // 閒置的視窗（60 秒一次）第一次失敗就等 120 秒
        assert_eq!(s.done("w1", Pace::Slow, false, NOW).as_deref(), Some("讀畫面 w1 連續失敗 1 次，下次在 120 秒後"));
        for line in [backoff_line("w9", 7, 300_000), early_stop_line("w9")] {
            assert!(line.contains("w9") && !line.contains("screen") && !line.contains('\n'), "{line}");
        }
    }

    #[test]
    fn 沒有_session_檔的視窗不再讀時_每扇只寫一次紀錄_關掉的忘記() {
        let mut s = Schedule::default();
        assert_eq!(s.early_stopped("w0", &["w0"]).as_deref(), Some("讀畫面 w0 沒有對話紀錄檔，已超過 10 分鐘，不再讀這扇視窗的畫面"));
        assert_eq!(s.early_stopped("w0", &["w0"]), None, "同一扇只寫一次");
        assert!(s.early_stopped("w1", &["w0", "w1"]).is_some(), "另一扇各算各的");
        assert_eq!(s.early_stopped("w1", &["w1"]), None);
        assert!(s.early_stopped("w0", &["w0", "w1"]).is_some(), "視窗關掉又開了再寫一次");
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

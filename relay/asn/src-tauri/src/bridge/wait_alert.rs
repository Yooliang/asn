//! 夥伴卡在要人處理的框上太久（todo-next-162）：什麼時候該通知本人。只有判斷，不碰檔案、不連後台。
//! 訊號是 Claude session 檔的 status（見 roster::read_session_wait），不靠讀畫面、不分終端機。
use std::collections::HashMap;

/// 等了這麼久才通知
pub const WAIT_AFTER_MS: u64 = 120_000;
/// 同一扇視窗兩次通知至少隔這麼久：一直問問題的視窗不會洗版（沒通知到的那次，隔完還在等就補通知）
pub const SAME_WINDOW_GAP_MS: u64 = 30 * 60_000;

/// 一扇正在等的視窗
#[derive(Debug, Clone, PartialEq)]
pub struct Waiting {
    pub name: String,
    pub session_id: Option<String>,
    pub waiting_for: Option<String>,
    /// session 檔的 statusUpdatedAt；0＝沒有這個欄位
    pub since: u64,
}

/// 後台認得的種類：permission（權限或 hook 確認框）、input（選擇或輸入）、other（其他框）
pub fn kind_of(waiting_for: Option<&str>) -> &'static str {
    match waiting_for {
        Some("permission prompt") => "permission",
        Some("input needed") => "input",
        _ => "other",
    }
}

#[derive(Default)]
pub struct WaitAlerts {
    /// 名字 → （這次等待的 since, 開始算的時間）
    seen: HashMap<String, (u64, u64)>,
    /// 名字 → 已經通知過的那次等待的 since
    told: HashMap<String, u64>,
    /// 名字 → 上次通知的時間
    last_sent: HashMap<String, u64>,
}

impl WaitAlerts {
    /// `waiting`＝這一輪正在等的視窗（不在裡面＝沒在等了）。回傳該通知的
    pub fn due(&mut self, now: u64, waiting: &[Waiting]) -> Vec<Waiting> {
        let here = |n: &String| waiting.iter().any(|w| w.name == *n);
        self.seen.retain(|n, _| here(n));
        self.told.retain(|n, _| here(n));
        self.last_sent.retain(|_, t| now.saturating_sub(*t) < SAME_WINDOW_GAP_MS);
        let mut out = Vec::new();
        for w in waiting {
            let start_of = |since: u64| if since > 0 && since <= now { since } else { now };
            let told = self.told.get(&w.name).copied();
            let (key, started) = match self.seen.get(&w.name).copied() {
                None => (w.since, start_of(w.since)),
                Some((k, s)) if k == w.since => (k, s),
                // 通知過之後 since 變了＝答完又跳下一個框，重新算；還沒通知過就接著算，換框不能把人晾著
                Some(_) if told.is_some() => (w.since, start_of(w.since)),
                Some((_, s)) => (w.since, s),
            };
            self.seen.insert(w.name.clone(), (key, started));
            if told == Some(key) || now.saturating_sub(started) < WAIT_AFTER_MS || self.last_sent.contains_key(&w.name) {
                continue;
            }
            out.push(w.clone());
        }
        out
    }

    /// 後台收到了：這次等待不再通知
    pub fn mark_sent(&mut self, w: &Waiting, now: u64) {
        self.told.insert(w.name.clone(), w.since);
        self.last_sent.insert(w.name.clone(), now);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const T: u64 = 1_800_000_000_000;

    fn w(name: &str, since: u64) -> Waiting {
        Waiting { name: name.into(), session_id: None, waiting_for: Some("permission prompt".into()), since }
    }
    fn due(a: &mut WaitAlerts, now: u64, ws: &[Waiting]) -> Vec<String> {
        let d = a.due(now, ws);
        d.iter().for_each(|x| a.mark_sent(x, now));
        d.into_iter().map(|x| x.name).collect()
    }

    #[test]
    fn 等滿兩分鐘才通知_同一次等待只通知一次() {
        let mut a = WaitAlerts::default();
        let ws = [w("甲", T)];
        assert!(due(&mut a, T + WAIT_AFTER_MS - 1, &ws).is_empty());
        assert_eq!(due(&mut a, T + WAIT_AFTER_MS, &ws), ["甲"]);
        assert!(due(&mut a, T + WAIT_AFTER_MS + 3_600_000, &ws).is_empty(), "同一次等待再久也不重複");
    }

    #[test]
    fn 沒有時間欄位或時間在未來_從第一次看到算() {
        let mut a = WaitAlerts::default();
        assert!(due(&mut a, T, &[w("甲", 0)]).is_empty());
        assert_eq!(due(&mut a, T + WAIT_AFTER_MS, &[w("甲", 0)]), ["甲"]);
        let mut b = WaitAlerts::default();
        let later = T + 10_000_000;
        assert!(due(&mut b, T, &[w("甲", later)]).is_empty());
        assert_eq!(due(&mut b, T + WAIT_AFTER_MS, &[w("甲", later)]), ["甲"]);
    }

    #[test]
    fn 同一扇視窗反覆等待有間隔_隔完還在等才補通知() {
        let mut a = WaitAlerts::default();
        assert_eq!(due(&mut a, T + WAIT_AFTER_MS, &[w("甲", T)]), ["甲"]);
        // 答完了
        assert!(due(&mut a, T + WAIT_AFTER_MS + 1, &[]).is_empty());
        // 馬上又問，等滿兩分鐘，但還在間隔內：不通知
        let s2 = T + WAIT_AFTER_MS + 1000;
        assert!(due(&mut a, s2 + WAIT_AFTER_MS, &[w("甲", s2)]).is_empty());
        // 隔完還在等：補通知
        assert_eq!(due(&mut a, T + WAIT_AFTER_MS + SAME_WINDOW_GAP_MS, &[w("甲", s2)]), ["甲"]);
    }

    #[test]
    fn 還沒通知過就換框_接著算_不會一直歸零() {
        let mut a = WaitAlerts::default();
        assert!(due(&mut a, T + 60_000, &[w("甲", T)]).is_empty());
        assert!(due(&mut a, T + 100_000, &[w("甲", T + 90_000)]).is_empty());
        assert_eq!(due(&mut a, T + WAIT_AFTER_MS, &[w("甲", T + 90_000)]), ["甲"]);
    }

    #[test]
    fn 後台沒收到就不算通知過_下一輪再試() {
        let mut a = WaitAlerts::default();
        assert_eq!(a.due(T + WAIT_AFTER_MS, &[w("甲", T)]).len(), 1);
        assert_eq!(a.due(T + WAIT_AFTER_MS + 1, &[w("甲", T)]).len(), 1);
    }

    #[test]
    fn 認得的種類_其他一律算其他框() {
        assert_eq!(kind_of(Some("permission prompt")), "permission");
        assert_eq!(kind_of(Some("input needed")), "input");
        for v in [Some("dialog open"), Some("sandbox request"), None] {
            assert_eq!(kind_of(v), "other");
        }
    }
}

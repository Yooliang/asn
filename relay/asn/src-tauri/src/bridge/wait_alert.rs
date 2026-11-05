//! 夥伴卡在要人處理的框上太久（todo-next-162）：什麼時候該通知本人。只有判斷，不碰檔案、不連後台。
//! 通知過的紀錄存檔（WAIT_FILE）：ASN 重開後同一次等待不再寄一封。檔案壞了就當沒有，頂多多寄一封。
//! 訊號是 Claude session 檔的 status（見 roster::read_session_wait），不靠讀畫面、不分終端機。
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::Path;

/// 通知紀錄的檔名（在機器資料夾）。只有視窗名和時間
pub const WAIT_FILE: &str = "wait-alerts.json";
/// 重開後這段時間內視窗可能還沒回到名單：紀錄先留著，不當成沒在等了
const RELOAD_KEEP_MS: u64 = 5 * 60_000;

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
    /// 讀檔後到這個時間之前，`told` 不因為視窗不在名單上就拿掉
    keep_until: u64,
}

impl WaitAlerts {
    /// 讀上次存的紀錄。沒有檔案或壞了就是空的
    pub fn load(file: &Path, now: u64) -> WaitAlerts {
        let mut a = WaitAlerts { keep_until: now + RELOAD_KEEP_MS, ..Default::default() };
        let Some(v) = std::fs::read_to_string(file).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok()) else { return a };
        let map = |k: &str| -> HashMap<String, u64> { v.get(k).and_then(Value::as_object).into_iter().flatten().filter_map(|(n, x)| Some((n.clone(), x.as_u64()?))).collect() };
        a.told = map("told");
        a.last_sent = map("last_sent");
        a.last_sent.retain(|_, t| now.saturating_sub(*t) < SAME_WINDOW_GAP_MS);
        a
    }

    pub fn save(&self, file: &Path) -> Result<(), String> {
        crate::write_atomic(file, &json!({ "told": self.told, "last_sent": self.last_sent }).to_string()).map_err(|e| e.to_string())
    }

    /// `waiting`＝這一輪正在等的視窗（不在裡面＝沒在等了）。回傳該通知的
    pub fn due(&mut self, now: u64, waiting: &[Waiting]) -> Vec<Waiting> {
        let here = |n: &String| waiting.iter().any(|w| w.name == *n);
        self.seen.retain(|n, _| here(n));
        if now >= self.keep_until {
            self.told.retain(|n, _| here(n));
        }
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
    fn 重開後同一次等待不再通知_答完又卡才算新的_壞檔當沒有() {
        let d = tempfile::tempdir().unwrap();
        let f = d.path().join(WAIT_FILE);
        let mut a = WaitAlerts::load(&f, T);
        let now = T + WAIT_AFTER_MS;
        assert_eq!(due(&mut a, now, &[w("甲", T)]), ["甲"]);
        a.save(&f).unwrap();
        // 重開：剛好已過同視窗間隔，也不因為同一次等待再寄
        let later = T + SAME_WINDOW_GAP_MS + WAIT_AFTER_MS;
        let mut b = WaitAlerts::load(&f, later);
        assert!(due(&mut b, later, &[w("甲", T)]).is_empty(), "同一次等待");
        // 重開後第一輪視窗還沒回名單：紀錄不能掉
        let mut c = WaitAlerts::load(&f, later);
        assert!(due(&mut c, later, &[]).is_empty());
        assert!(due(&mut c, later + 1000, &[w("甲", T)]).is_empty(), "視窗晚一點才回來");
        // 答完又卡：新的一次，會通知
        let s2 = later + 10_000;
        let mut e = WaitAlerts::load(&f, s2);
        assert_eq!(due(&mut e, s2 + WAIT_AFTER_MS, &[w("甲", s2)]), ["甲"]);
        // 重開後間隔還沒過、又是新的等待：照間隔不通知
        let mut g = WaitAlerts::default();
        assert_eq!(due(&mut g, now, &[w("乙", T)]), ["乙"]);
        g.save(&f).unwrap();
        let s3 = now + 1000;
        let mut h = WaitAlerts::load(&f, s3);
        assert!(due(&mut h, s3 + WAIT_AFTER_MS, &[w("乙", s3)]).is_empty());
        std::fs::write(&f, "壞").unwrap();
        assert_eq!(due(&mut WaitAlerts::load(&f, now), now, &[w("丙", T)]), ["丙"]);
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

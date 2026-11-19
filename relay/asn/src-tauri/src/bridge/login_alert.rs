//! 夥伴視窗停在「登入逾時」畫面時通知本人（#1792）：什麼時候該通知。只有判斷，不碰畫面、不連後台。
//! 訊號是讀畫面判出的 login 代號（launch/term.rs 的 partner_notices）。同一扇視窗每次停住只通知一次，
//! 畫面離開 login 才重新算；同一扇視窗兩次通知至少隔 30 分鐘。通知過的紀錄存檔（LOGIN_FILE），重開不重寄。
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::path::Path;

/// 通知紀錄的檔名（在機器資料夾）。只有視窗名和時間
pub const LOGIN_FILE: &str = "login-alerts.json";
/// 同一扇視窗兩次通知至少隔這麼久
pub const LOGIN_GAP_MS: u64 = 30 * 60_000;
/// 重開後讀畫面還沒讀完前，視窗不在名單上不代表恢復了：這段時間內不清掉「已通知」
const RELOAD_KEEP_MS: u64 = 5 * 60_000;
/// 後台收的視窗名上限（字元數）
const WINDOW_MAX: usize = 60;

/// 送給後台的視窗名：去掉控制字元、頭尾空白，最長 60 字（後台超過會拒收）。內文由後台寫：「<設備名>：「<視窗名>」Claude 登入過期，要重新登入。」
pub fn login_window_text(name: &str) -> String {
    let clean: String = name.chars().filter(|c| !c.is_control()).collect();
    clean.trim().chars().take(WINDOW_MAX).collect()
}

#[derive(Default)]
pub struct LoginAlerts {
    /// 這一次停在登入畫面、已經通知過的視窗
    told: HashSet<String>,
    /// 名字 → 上次通知的時間
    last_sent: HashMap<String, u64>,
    keep_until: u64,
}

impl LoginAlerts {
    /// 讀上次存的紀錄。沒有檔案或壞了就是空的（頂多多寄一封）
    pub fn load(file: &Path, now: u64) -> LoginAlerts {
        let mut a = LoginAlerts { keep_until: now + RELOAD_KEEP_MS, ..Default::default() };
        let Some(v) = std::fs::read_to_string(file).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok()) else { return a };
        a.told = v.get("told").and_then(Value::as_array).into_iter().flatten().filter_map(|x| x.as_str().map(String::from)).collect();
        a.last_sent = v.get("last_sent").and_then(Value::as_object).into_iter().flatten().filter_map(|(n, x)| Some((n.clone(), x.as_u64()?))).collect();
        a.last_sent.retain(|_, t| now.saturating_sub(*t) < LOGIN_GAP_MS);
        a
    }

    pub fn save(&self, file: &Path) -> Result<(), String> {
        let mut told: Vec<&String> = self.told.iter().collect();
        told.sort();
        crate::write_atomic(file, &json!({ "told": told, "last_sent": self.last_sent }).to_string()).map_err(|e| e.to_string())
    }

    /// `current`＝這一輪停在登入畫面的視窗名。回傳該通知的
    pub fn due(&mut self, now: u64, current: &[String]) -> Vec<String> {
        if now >= self.keep_until {
            self.told.retain(|n| current.contains(n));
        }
        self.last_sent.retain(|_, t| now.saturating_sub(*t) < LOGIN_GAP_MS);
        let mut out: Vec<String> = Vec::new();
        for n in current {
            if !self.told.contains(n) && !self.last_sent.contains_key(n) && !out.contains(n) {
                out.push(n.clone());
            }
        }
        out
    }

    /// 後台收到了（或查不到擁有者、再試也寄不到）：這次停住不再通知
    pub fn mark_sent(&mut self, name: &str, now: u64) {
        self.told.insert(name.to_string());
        self.last_sent.insert(name.to_string(), now);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const T: u64 = 1_800_000_000_000;

    fn names(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }
    fn due(a: &mut LoginAlerts, now: u64, cur: &[&str]) -> Vec<String> {
        let d = a.due(now, &names(cur));
        d.iter().for_each(|n| a.mark_sent(n, now));
        d
    }

    #[test]
    fn 同一次停住只通知一次_離開登入畫面後隔滿三十分鐘才重新算() {
        let mut a = LoginAlerts::default();
        assert_eq!(due(&mut a, T, &["甲"]), ["甲"]);
        assert!(due(&mut a, T + 3 * LOGIN_GAP_MS, &["甲"]).is_empty(), "同一次停住再久也不重複");
        // 離開後馬上又停住：間隔沒過不通知
        let mut b = LoginAlerts { keep_until: 0, ..Default::default() };
        assert_eq!(due(&mut b, T, &["甲"]), ["甲"]);
        assert!(due(&mut b, T + 1000, &[]).is_empty());
        assert!(due(&mut b, T + 2000, &["甲"]).is_empty(), "三十分鐘內不再推");
        // 間隔過了又是新的一次：通知
        assert!(due(&mut b, T + LOGIN_GAP_MS - 1, &["甲"]).is_empty());
        assert_eq!(due(&mut b, T + LOGIN_GAP_MS + 5000, &["甲"]), ["甲"]);
    }

    #[test]
    fn 多扇視窗各算各的_重複的名字只通知一次() {
        let mut a = LoginAlerts::default();
        assert_eq!(due(&mut a, T, &["甲", "乙", "甲"]), ["甲", "乙"]);
        assert_eq!(due(&mut a, T + 1, &["甲", "乙", "丙"]), ["丙"]);
    }

    #[test]
    fn 重開不重寄_壞檔當沒有() {
        let d = tempfile::tempdir().unwrap();
        let f = d.path().join(LOGIN_FILE);
        let mut a = LoginAlerts::load(&f, T);
        assert_eq!(due(&mut a, T, &["甲"]), ["甲"]);
        a.save(&f).unwrap();
        // 重開：同一次停住，即使已過間隔也不重寄
        let later = T + LOGIN_GAP_MS + 1000;
        let mut b = LoginAlerts::load(&f, later);
        assert!(due(&mut b, later, &["甲"]).is_empty());
        // 重開後第一輪讀畫面還沒結果：紀錄不能掉
        let mut c = LoginAlerts::load(&f, later);
        assert!(due(&mut c, later, &[]).is_empty());
        assert!(due(&mut c, later + 1000, &["甲"]).is_empty());
        // 重開後間隔還沒過、離開又回來：照間隔不通知
        let soon = T + 1000;
        let mut e = LoginAlerts::load(&f, soon);
        e.keep_until = 0;
        assert!(due(&mut e, soon, &[]).is_empty());
        assert!(due(&mut e, soon + 1, &["甲"]).is_empty());
        std::fs::write(&f, "壞").unwrap();
        assert_eq!(due(&mut LoginAlerts::load(&f, T), T, &["乙"]), ["乙"]);
    }

    #[test]
    fn 送給後台的視窗名_乾淨且不超過後台上限() {
        assert_eq!(login_window_text("asn雯"), "asn雯");
        assert_eq!(login_window_text(&"長".repeat(100)).chars().count(), WINDOW_MAX);
        assert_eq!(login_window_text(" a
b "), "ab");
    }
}

//! Gemini 視窗的「上次看到的數值」（#1316）：用來決定每次讀數的資料時間（`read_at`）。
//!
//! 問題：agy 的狀態列每次重繪都會送一份額度；閒置的視窗送的是快取的舊數字，如果每次都把 `read_at` 設成「現在」，
//! 這份舊數字就會蓋掉別處比較新的值。所以以「agy 視窗＋那一窗額度（five_hour／weekly）」為單位，記住上次的數值（剩餘 %、重置時間）與資料時間：
//! - 數值有變才把資料時間設成現在；沒變就沿用上次的資料時間（閒置視窗一直重送同樣的數字，資料時間不前進，會被 `older_read` 擋掉）。
//! - 第一次看到某個視窗（沒有存過紀錄，例如 ASN 重開後）：只記下來、不送、不寫進 `gemini-quota.json`；等數值變了才送。
//!   這個「第一次」是對那個視窗的那一窗額度說的：之後才出現的另一窗額度也先記下來。
//! - 「視窗」用狀態列資料裡的 session_id（沒有才用 conversation_id）認；原值一律不留，只存 sha256 雜湊。都沒有就沒辦法認，這筆不記。
//! 數值相同＝剩餘 % 完全一樣，而且重置時間差 10 分鐘以內（滿額的窗重置時間會一直往後跑）。
//! 本機檔 `~/.asn/gemini-quota-seen.json`：最多 32 個視窗，7 天沒更新就刪；壞掉或太大當空的。
use super::SAME_RESET_MS;
use crate::claude_quota::Parsed;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

pub const MAX_SESSIONS: usize = 32;
pub const KEEP_MS: i64 = 7 * 86_400_000;
/// 視窗的「最近活動時間」最多這麼久才更新一次（狀態列叫得很勤，不能每次都寫檔）
const TOUCH_MS: i64 = 10 * 60_000;
const FILE: &str = "gemini-quota-seen.json";
const MAX_BYTES: u64 = 64 * 1024;

pub fn path(home: &Path) -> PathBuf {
    home.join(".asn").join(FILE)
}

/// 視窗代號的雜湊（sha256，帶固定前綴，十六進位）；原值不留
pub fn session_key(id: &str) -> String {
    let mut h = Sha256::new();
    h.update(b"asn-gemini-session-v1\0");
    h.update(id.as_bytes());
    h.finalize().iter().map(|b| format!("{b:02x}")).collect()
}

/// 一條窗上次看到的數值與資料時間
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct Win {
    pub pct: u8,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reset_ms: Option<i64>,
    pub read_ms: i64,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Default)]
pub struct Sess {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub five: Option<Win>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub week: Option<Win>,
    #[serde(default)]
    pub last_ms: i64,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Default)]
pub struct Seen(BTreeMap<String, Sess>);

/// 一條窗這次的處理結果
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Verdict {
    /// 這次讀數沒有這條窗
    Absent,
    /// 第一次看到：記下來，不送
    FirstSeen,
    /// 送，資料時間是這個（數值有變是現在，沒變是上次的）
    Read(i64),
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Observed {
    pub five: Verdict,
    pub week: Verdict,
}

fn same(w: &Win, pct: u8, reset: Option<i64>) -> bool {
    w.pct == pct
        && match (w.reset_ms, reset) {
            (None, None) => true,
            (Some(a), Some(b)) => (a - b).abs() <= SAME_RESET_MS,
            _ => false,
        }
}

fn step(slot: &mut Option<Win>, pct: Option<u8>, reset: Option<i64>, now_ms: i64) -> Verdict {
    let Some(pct) = pct else { return Verdict::Absent };
    match slot {
        None => {
            *slot = Some(Win { pct, reset_ms: reset, read_ms: now_ms });
            Verdict::FirstSeen
        }
        Some(w) if same(w, pct, reset) => Verdict::Read(w.read_ms),
        Some(w) => {
            *w = Win { pct, reset_ms: reset, read_ms: now_ms };
            Verdict::Read(now_ms)
        }
    }
}

impl Seen {
    pub fn load(home: &Path) -> Seen {
        let p = path(home);
        if std::fs::metadata(&p).map(|m| m.len() > MAX_BYTES).unwrap_or(false) {
            return Seen::default();
        }
        std::fs::read_to_string(&p).ok().and_then(|t| serde_json::from_str(t.trim_start_matches('\u{feff}')).ok()).unwrap_or_default()
    }

    /// 寫檔（原子寫）。寫不進去就算了：狀態列不能因此失敗
    pub fn save(&self, home: &Path) {
        let Ok(text) = serde_json::to_string(self) else { return };
        let p = path(home);
        if let Some(d) = p.parent() {
            let _ = std::fs::create_dir_all(d);
        }
        let _ = crate::claude_json::write_atomic(&p, text.as_bytes());
    }

    /// 這個視窗這次讀到的數值：更新記住的值，回每條窗該怎麼處理
    pub fn observe(&mut self, key: &str, p: &Parsed, now_ms: i64) -> Observed {
        let sess = self.0.entry(key.to_string()).or_default();
        let five = step(&mut sess.five, p.five_hour_pct, p.five_reset_ms, now_ms);
        let week = step(&mut sess.week, p.weekly_pct, p.week_reset_ms, now_ms);
        if sess.last_ms == 0 || now_ms - sess.last_ms >= TOUCH_MS {
            sess.last_ms = now_ms;
        }
        self.prune(now_ms);
        Observed { five, week }
    }

    /// 7 天沒更新的刪；超過上限丟最久沒動的
    fn prune(&mut self, now_ms: i64) {
        self.0.retain(|_, s| now_ms - s.last_ms <= KEEP_MS);
        while self.0.len() > MAX_SESSIONS {
            let oldest = self.0.iter().min_by(|a, b| a.1.last_ms.cmp(&b.1.last_ms).then_with(|| a.0.cmp(b.0))).map(|(k, _)| k.clone());
            let Some(k) = oldest else { break };
            self.0.remove(&k);
        }
    }

    #[cfg(test)]
    pub fn len(&self) -> usize {
        self.0.len()
    }
    #[cfg(test)]
    pub fn get(&self, key: &str) -> Option<&Sess> {
        self.0.get(key)
    }
}

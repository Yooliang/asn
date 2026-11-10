//! 額度掛鉤的小狀態檔（#1184）：`~/.asn/claude-quota-state.json`。跟額度檔分開，額度檔只放各帳號的額度。
//! 內容只有：上次看到的登入身分（正規化 email 與 accountUuid 合成的字串，不含任何權杖）、每週那條待確認的重置時間
//! （重置時間、次數、第一次的時間）、兩條各自最後記過的不收原因代碼（同一個原因連續發生只記一次）。
//! 每次掛鉤是一個新行程，所以這些要存檔；ASN 重開也不會歸零。壞掉或讀不到就當空的，不影響記額度。
use super::merge::Pending;
use super::{iso_secs, parse_iso_secs};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

const MAX_BYTES: u64 = 32 * 1024;
/// 有身分的視窗（#1185）各帳號自己的待確認與 log 狀態，最多留幾個帳號
const MAX_OWNED: usize = 20;

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub(crate) struct PendingRec {
    reset_at: String,
    count: u32,
    first_at: String,
    /// 同期回升確認用的剩餘 %（#1261）；每週倍數確認沒有
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pct: Option<u8>,
}

/// 待確認 → 存檔的樣子
pub(crate) fn rec_of(p: Pending) -> PendingRec {
    PendingRec { reset_at: iso_secs(p.reset_ms), count: p.count, first_at: iso_secs(p.first_ms), pct: p.pct.filter(|v| *v <= 100) }
}

/// 存檔的樣子 → 待確認；時間壞掉回 None
pub(crate) fn pending_of(r: &PendingRec) -> Option<Pending> {
    Some(Pending { reset_ms: parse_iso_secs(&r.reset_at)?, count: r.count.min(1000), first_ms: parse_iso_secs(&r.first_at)?, pct: r.pct.filter(|v| *v <= 100) })
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Default)]
pub struct State {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub identity: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(super) pending_week: Option<PendingRec>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(super) pending_five: Option<PendingRec>,
    /// 身分剛換過、這個帳號還沒有被確認的基準：數字要同一組重置時間連續確認才收（#1184）
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub rebase: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub logged_five: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub logged_week: Option<String>,
    /// 視窗帶了帳號身分時，各帳號（email）自己的狀態（#1185）；每個只用待確認與 log 那幾欄
    #[serde(default, skip_serializing_if = "std::collections::BTreeMap::is_empty")]
    pub owned: std::collections::BTreeMap<String, State>,
}

pub fn state_path(home: &Path) -> PathBuf {
    home.join(".asn").join("claude-quota-state.json")
}

impl State {
    /// 取出（沒有就是空的）某個帳號自己的狀態
    pub fn take_owned(&mut self, email: &str) -> State {
        self.owned.remove(email).unwrap_or_default()
    }
    /// 放回某個帳號自己的狀態；帳號數超過上限就丟掉字母順序最前面的
    pub fn put_owned(&mut self, email: &str, st: State) {
        self.owned.insert(email.to_string(), st);
        while self.owned.len() > MAX_OWNED {
            let Some(k) = self.owned.keys().next().cloned() else { break };
            self.owned.remove(&k);
        }
    }
    pub fn pending_week(&self) -> Option<Pending> {
        pending_of(self.pending_week.as_ref()?)
    }
    pub fn pending_five(&self) -> Option<Pending> {
        pending_of(self.pending_five.as_ref()?)
    }
    pub fn set_pending_five(&mut self, p: Option<Pending>) {
        self.pending_five = p.map(rec_of);
    }
    pub fn set_pending_week(&mut self, p: Option<Pending>) {
        self.pending_week = p.map(rec_of);
    }
}

/// 讀狀態檔：不存在、太大、壞掉都是空的
pub fn load(home: &Path) -> State {
    let p = state_path(home);
    if std::fs::metadata(&p).map(|m| m.len() > MAX_BYTES).unwrap_or(false) {
        return State::default();
    }
    std::fs::read_to_string(&p).ok().and_then(|t| serde_json::from_str(t.trim_start_matches('\u{feff}')).ok()).unwrap_or_default()
}

/// 寫狀態檔（原子寫）。寫不進去就算了：掛鉤不能因此失敗，也不印到標準錯誤。
pub fn save(home: &Path, st: &State) {
    let Ok(text) = serde_json::to_string(st) else { return };
    let p = state_path(home);
    if let Some(dir) = p.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let _ = crate::claude_json::write_atomic(&p, text.as_bytes());
}

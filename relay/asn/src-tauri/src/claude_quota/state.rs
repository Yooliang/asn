//! 額度掛鉤的小狀態檔（#1184）：`~/.asn/claude-quota-state.json`。跟額度檔分開，額度檔只放各帳號的額度。
//! 內容只有：上次看到的登入身分（正規化 email 與 accountUuid 合成的字串，不含任何權杖）、每週那條待確認的重置時間
//! （重置時間、次數、第一次的時間）、兩條各自最後記過的不收原因代碼（同一個原因連續發生只記一次）。
//! 每次掛鉤是一個新行程，所以這些要存檔；ASN 重開也不會歸零。壞掉或讀不到就當空的，不影響記額度。
use super::merge::Pending;
use super::{iso_secs, parse_iso_secs};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

const MAX_BYTES: u64 = 4096;

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub(super) struct PendingRec {
    reset_at: String,
    count: u32,
    first_at: String,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Default)]
pub struct State {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub identity: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(super) pending_week: Option<PendingRec>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub logged_five: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub logged_week: Option<String>,
}

pub fn state_path(home: &Path) -> PathBuf {
    home.join(".asn").join("claude-quota-state.json")
}

impl State {
    pub fn pending_week(&self) -> Option<Pending> {
        let r = self.pending_week.as_ref()?;
        Some(Pending { reset_ms: parse_iso_secs(&r.reset_at)?, count: r.count.min(1000), first_ms: parse_iso_secs(&r.first_at)? })
    }
    pub fn set_pending_week(&mut self, p: Option<Pending>) {
        self.pending_week = p.map(|p| PendingRec { reset_at: iso_secs(p.reset_ms), count: p.count, first_at: iso_secs(p.first_ms) });
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

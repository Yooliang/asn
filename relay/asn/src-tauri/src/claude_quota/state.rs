//! 額度掛鉤的小狀態檔（#1184、#1266）：`~/.asn/claude-quota-state.json`。跟額度檔分開，額度檔只放各帳號的額度。
//! 內容只有：各帳號兩條各自最後記過的不收原因代碼（同一個原因連續發生只記一次；鍵是 email，與額度檔一致）、
//! 最近一次看到「沒帶 transcript_path 的舊版 Claude Code 視窗」的時間（畫面據此寫一句固定的人話）。
//! 每次掛鉤是一個新行程，所以這些要存檔；ASN 重開也不會歸零。壞掉或讀不到就當空的，不影響記額度。
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

const MAX_BYTES: u64 = 32 * 1024;
/// 各帳號自己的 log 去重狀態，最多留幾個帳號
const MAX_OWNED: usize = 20;

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Default)]
pub struct State {
    /// 最近一次看到舊版視窗（沒帶 transcript_path）的時間（UTC 秒的 ISO）；舊版不收，只記這個時間讓畫面提示升級
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub legacy_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub logged_five: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub logged_week: Option<String>,
    /// 各帳號（email）自己的 log 去重狀態；每個只用 logged 那兩欄
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

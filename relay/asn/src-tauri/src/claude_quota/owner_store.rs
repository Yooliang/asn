//! 帳號身分用到的本機小檔（#1185），都放在 `~/.asn/`，壞掉或讀不到就當空的，不影響記額度：
//! - `claude-owner-cache.json`：對話紀錄的身分快取（路徑 → 大小、修改時間、身分），最多 32 筆。
//! - `claude-window-account-cache.json`：視窗自己的 `.claude.json` 的 oauthAccount（uuid 與 email）的快取，最多 8 筆。
//! 額度歸屬直接取視窗自己 oauthAccount 的 email，不再有「對不到帳號」的未知帳號區（舊版寫的 `claude-quota-unknown.json` 不再讀寫）。
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

const CACHE_MAX: usize = 32;
const FILE_MAX_BYTES: u64 = 64 * 1024;

fn dir(home: &Path) -> PathBuf {
    home.join(".asn")
}
pub fn cache_path(home: &Path) -> PathBuf {
    dir(home).join("claude-owner-cache.json")
}

fn read_small(p: &Path) -> Option<String> {
    if std::fs::metadata(p).map(|m| m.len() > FILE_MAX_BYTES).unwrap_or(false) {
        return None;
    }
    std::fs::read_to_string(p).ok().map(|t| t.trim_start_matches('\u{feff}').to_string())
}

fn write(p: &Path, text: &str) {
    if let Some(d) = p.parent() {
        let _ = std::fs::create_dir_all(d);
    }
    let _ = crate::claude_json::write_atomic(p, text.as_bytes());
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
struct Ent {
    len: u64,
    mtime_ms: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    account_uuid: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    org_uuid: Option<String>,
    /// 對話紀錄裡最後一筆 assistant 回應的時間（毫秒），額度的資料時間（#1266）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    assistant_ms: Option<i64>,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Default)]
pub struct Cache(BTreeMap<String, Ent>);

impl Cache {
    pub fn load(home: &Path) -> Cache {
        read_small(&cache_path(home)).and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default()
    }
    pub fn save(&self, home: &Path) {
        if let Ok(t) = serde_json::to_string(self) {
            write(&cache_path(home), &t);
        }
    }
    /// 命中（同一個檔、大小與修改時間都沒變）回 Some((身分或「這個檔裡沒有身分」, 最後一筆 assistant 的時間))；沒命中回 None
    pub fn get(&self, key: &str, len: u64, mtime_ms: i64) -> Option<(Option<super::owner::Owner>, Option<i64>)> {
        let e = self.0.get(key).filter(|e| e.len == len && e.mtime_ms == mtime_ms)?;
        Some((e.account_uuid.clone().map(|u| super::owner::Owner { account_uuid: u, org_uuid: e.org_uuid.clone() }), e.assistant_ms))
    }
    pub fn put(&mut self, key: &str, len: u64, mtime_ms: i64, o: Option<super::owner::Owner>, assistant_ms: Option<i64>) {
        let (account_uuid, org_uuid) = match o {
            Some(o) => (Some(o.account_uuid), o.org_uuid),
            None => (None, None),
        };
        self.0.insert(key.to_string(), Ent { len, mtime_ms, account_uuid, org_uuid, assistant_ms });
        while self.0.len() > CACHE_MAX {
            let Some(k) = self.0.keys().next().cloned() else { break };
            self.0.remove(&k);
        }
    }
    #[cfg(test)]
    pub fn len(&self) -> usize {
        self.0.len()
    }
}

/// 視窗自己的登入帳號（`.claude.json` 的 oauthAccount.accountUuid 與 emailAddress）的快取：路徑 → 大小、修改時間、兩個欄位（讀不到身分也記，免得每次重讀）。
/// 檔案可能有好幾 MB、狀態列又叫得很勤，大小與修改時間沒變就不重讀。最多 8 筆。
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Default)]
pub struct AcctCache(BTreeMap<String, AcctEnt>);

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
struct AcctEnt {
    len: u64,
    mtime_ms: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    account_uuid: Option<String>,
    /// 同一份 oauthAccount 裡的 email（正規化後）；額度歸屬用它，不查帳號庫
    #[serde(default, skip_serializing_if = "Option::is_none")]
    email: Option<String>,
}

const ACCT_CACHE_MAX: usize = 8;

pub fn acct_cache_path(home: &Path) -> PathBuf {
    dir(home).join("claude-window-account-cache.json")
}

impl AcctCache {
    pub fn load(home: &Path) -> AcctCache {
        read_small(&acct_cache_path(home)).and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default()
    }
    pub fn save(&self, home: &Path) {
        if let Ok(t) = serde_json::to_string(self) {
            write(&acct_cache_path(home), &t);
        }
    }
    /// 命中回 Some((uuid, email) 或「這個檔裡沒有身分」)；沒命中（或存的只有一半）回 None
    pub fn get(&self, key: &str, len: u64, mtime_ms: i64) -> Option<Option<(String, String)>> {
        let e = self.0.get(key).filter(|e| e.len == len && e.mtime_ms == mtime_ms)?;
        match (&e.account_uuid, &e.email) {
            (Some(u), Some(m)) => Some(Some((u.clone(), m.clone()))),
            (None, None) => Some(None),
            _ => None,
        }
    }
    pub fn put(&mut self, key: &str, len: u64, mtime_ms: i64, identity: Option<(String, String)>) {
        let (account_uuid, email) = match identity {
            Some((u, m)) => (Some(u), Some(m)),
            None => (None, None),
        };
        self.0.insert(key.to_string(), AcctEnt { len, mtime_ms, account_uuid, email });
        while self.0.len() > ACCT_CACHE_MAX {
            let Some(k) = self.0.keys().next().cloned() else { break };
            self.0.remove(&k);
        }
    }
}

/// 額度檔的備份位置：同目錄的 `claude-quota.json.bak`
pub fn backup_path(home: &Path) -> PathBuf {
    let mut dst = super::quota_path(home).into_os_string();
    dst.push(".bak");
    PathBuf::from(dst)
}

/// 備份暫存檔：先寫這個、寫完再改名成 `.bak`，不會留下寫一半的備份
pub fn backup_tmp_path(home: &Path) -> PathBuf {
    let mut dst = backup_path(home).into_os_string();
    dst.push(".tmp");
    PathBuf::from(dst)
}

/// 額度檔備份（只留一份，覆寫舊的）：先複製到暫存檔、再改名蓋掉 `.bak`。成功回 true；
/// 失敗（含額度檔本來就不存在）回 false，呼叫端據此決定不清舊基準。失敗時盡量不留暫存檔。
pub fn backup_quota_file(home: &Path) -> bool {
    let tmp = backup_tmp_path(home);
    let ok = std::fs::copy(super::quota_path(home), &tmp).is_ok() && std::fs::rename(&tmp, backup_path(home)).is_ok();
    if !ok {
        let _ = std::fs::remove_file(&tmp);
    }
    ok
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 壞掉或太大的小檔當成空的() {
        let h = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(h.path().join(".asn")).unwrap();
        std::fs::write(cache_path(h.path()), "{壞").unwrap();
        std::fs::write(acct_cache_path(h.path()), "x".repeat(100_000)).unwrap();
        assert_eq!(Cache::load(h.path()).len(), 0);
        assert_eq!(AcctCache::load(h.path()), AcctCache::default());
    }
}

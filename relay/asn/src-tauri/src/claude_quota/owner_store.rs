//! 帳號身分用到的兩個本機小檔（#1185），都放在 `~/.asn/`，壞掉或讀不到就當空的，不影響記額度：
//! - `claude-owner-cache.json`：對話紀錄的身分快取（路徑 → 大小、修改時間、身分），最多 32 筆。
//! - `claude-quota-unknown.json`：身分對不到任何已知帳號的視窗的額度（uuid → 一筆額度）。只留本機、不進額度檔、不上傳；
//!   最多 16 個 uuid，每個只留最新一筆，7 天沒更新就刪。
use super::{merge, parse_iso_secs, quota_from_value, Parsed, Quota};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

const CACHE_MAX: usize = 32;
const FILE_MAX_BYTES: u64 = 64 * 1024;
pub const UNKNOWN_MAX: usize = 16;
pub const UNKNOWN_KEEP_MS: i64 = 7 * 86_400_000;

fn dir(home: &Path) -> PathBuf {
    home.join(".asn")
}
pub fn cache_path(home: &Path) -> PathBuf {
    dir(home).join("claude-owner-cache.json")
}
pub fn unknown_path(home: &Path) -> PathBuf {
    dir(home).join("claude-quota-unknown.json")
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

/// 讀未知帳號區：uuid → 額度。逐筆驗證（格式不對的丟掉）
pub fn unknown_load(home: &Path) -> BTreeMap<String, Quota> {
    let Some(serde_json::Value::Object(m)) = read_small(&unknown_path(home)).and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok()) else { return BTreeMap::new() };
    m.into_iter().take(UNKNOWN_MAX * 2).filter_map(|(k, v)| quota_from_value(&v).map(|q| (k, q))).collect()
}

/// 記一筆未知帳號的額度：每個 uuid 只留最新一筆（直接覆寫，不合併）；7 天沒更新的刪；超過 16 個丟最舊的
pub fn unknown_put(home: &Path, uuid: &str, p: &Parsed, now_ms: i64) {
    let Some(q) = merge::merge(None, p, now_ms).0 else { return };
    let mut all = unknown_load(home);
    all.retain(|_, q| parse_iso_secs(&q.at).is_some_and(|t| now_ms - t <= UNKNOWN_KEEP_MS));
    all.insert(uuid.to_string(), q);
    while all.len() > UNKNOWN_MAX {
        let oldest = all.iter().min_by(|a, b| a.1.at.cmp(&b.1.at).then_with(|| a.0.cmp(b.0))).map(|(k, _)| k.clone());
        let Some(k) = oldest else { break };
        all.remove(&k);
    }
    if let Ok(t) = serde_json::to_string(&all) {
        write(&unknown_path(home), &t);
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

    const NOW: i64 = 1_792_843_200_000;
    /// 5 小時那條，重置時間在「現在」之後 3 小時（要在合理範圍內才收）
    fn parsed(five: u8, now: i64) -> Parsed {
        Parsed { five_hour_pct: Some(five), weekly_pct: None, reset_at: None, five_reset_ms: Some(now + 3 * 3_600_000), week_reset_ms: None }
    }

    #[test]
    fn 未知帳號區_每個_uuid_只留最新一筆() {
        let h = tempfile::tempdir().unwrap();
        unknown_put(h.path(), "u-1", &parsed(40, NOW), NOW);
        unknown_put(h.path(), "u-1", &parsed(90, NOW + 60_000), NOW + 60_000);
        let all = unknown_load(h.path());
        assert_eq!(all.len(), 1);
        assert_eq!(all["u-1"].five_hour_pct, Some(90), "新的直接覆寫，不做合併");
    }

    #[test]
    fn 未知帳號區_最多_16_個且_7_天沒更新就刪() {
        let h = tempfile::tempdir().unwrap();
        for i in 0..20 {
            unknown_put(h.path(), &format!("u-{i:02}"), &parsed(10, NOW + i * 1000), NOW + i * 1000);
        }
        let all = unknown_load(h.path());
        assert_eq!(all.len(), UNKNOWN_MAX);
        assert!(all.contains_key("u-19") && !all.contains_key("u-00"), "留最新的");
        // 8 天後來一筆新的：舊的全過期被刪
        unknown_put(h.path(), "u-new", &parsed(10, NOW + 8 * 86_400_000), NOW + 8 * 86_400_000);
        let all = unknown_load(h.path());
        assert_eq!(all.keys().collect::<Vec<_>>(), ["u-new"]);
    }

    #[test]
    fn 未知帳號區_沒有額度就不寫檔() {
        let h = tempfile::tempdir().unwrap();
        let p = Parsed { five_hour_pct: None, weekly_pct: None, reset_at: None, five_reset_ms: None, week_reset_ms: None };
        unknown_put(h.path(), "u-1", &p, NOW);
        assert!(!unknown_path(h.path()).exists());
    }

    #[test]
    fn 壞掉或太大的小檔當成空的() {
        let h = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(h.path().join(".asn")).unwrap();
        std::fs::write(cache_path(h.path()), "{壞").unwrap();
        std::fs::write(unknown_path(h.path()), "x".repeat(100_000)).unwrap();
        assert_eq!(Cache::load(h.path()).len(), 0);
        assert!(unknown_load(h.path()).is_empty());
    }
}

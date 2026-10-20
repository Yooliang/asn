//! 暱稱＝視窗名＝對外寄信的 from_agent／收信的 agent 名。改名驗證、舊名清單（最多 5 個、保留 7 天）、改名流程。
//! 舊名繼續用 inbox&agent=<舊名> 收信並各自寫心跳，過期就停，所以改名前寄來的回信不會遺失。
use crate::{heartbeat, relay::Relay, write_atomic};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::Path;

pub const NAME_MAX_CHARS: usize = 40;
pub const OLD_MAX: usize = 5;
pub const OLD_KEEP_MS: u64 = 7 * 24 * 3600 * 1000;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct OldName {
    pub name: String,
    pub t: u64,
}

/// 去頭尾空白、1～40 字、不能結尾是「收發室」（那是收發室自己的名字）、不能含控制字元
pub fn validate_name(raw: &str) -> Result<String, String> {
    let n = raw.trim().to_string();
    if n.is_empty() {
        return Err("名字不能是空的".into());
    }
    if n.chars().count() > NAME_MAX_CHARS {
        return Err(format!("名字最多 {NAME_MAX_CHARS} 個字"));
    }
    if n.chars().any(|c| c.is_control()) {
        return Err("名字不能含控制字元".into());
    }
    if n.ends_with("收發室") {
        return Err("名字不能以「收發室」結尾".into());
    }
    Ok(n)
}

/// 去掉過期的、等於現用名的、重複的（留最新），最多留最新的 OLD_MAX 個（新的在前）
pub fn prune(old: &[OldName], current: &str, now: u64) -> Vec<OldName> {
    let mut v: Vec<OldName> = old.iter().filter(|o| o.name != current && now.saturating_sub(o.t) < OLD_KEEP_MS).cloned().collect();
    v.sort_by(|a, b| b.t.cmp(&a.t));
    let mut seen = std::collections::HashSet::new();
    v.retain(|o| seen.insert(o.name.clone()));
    v.truncate(OLD_MAX);
    v
}

/// 改名：把改名前的名字記進舊名清單
pub fn with_renamed(old: &[OldName], prev: &str, current: &str, now: u64) -> Vec<OldName> {
    let mut v = old.to_vec();
    v.push(OldName { name: prev.to_string(), t: now });
    prune(&v, current, now)
}

pub fn read_old_names(data_dir: &Path) -> Vec<OldName> {
    let Ok(text) = std::fs::read_to_string(data_dir.join("settings.json")) else { return vec![] };
    let Ok(v) = serde_json::from_str::<Value>(&text) else { return vec![] };
    v.get("old_names").and_then(|o| serde_json::from_value::<Vec<OldName>>(o.clone()).ok()).unwrap_or_default()
}

fn write_settings(data_dir: &Path, name: &str, old: &[OldName]) -> Result<(), String> {
    write_atomic(&data_dir.join("settings.json"), &json!({ "window_name": name, "old_names": old }).to_string()).map_err(|e| e.to_string())
}

/// 改名流程（指令與測試共用）：驗證 → 存檔 → 換現用名 → 舊名進清單 → 立刻寫新名心跳。
/// 不合法時什麼都不動、回傳錯誤字串。回傳新名字。
pub fn rename(relay: &Relay, data_dir: &Path, work_dir: &Path, raw: &str, now: u64) -> Result<String, String> {
    let name = validate_name(raw)?;
    let prev = relay.window_name();
    if name == prev {
        return Ok(name);
    }
    let old = with_renamed(&relay.old_names(), &prev, &name, now);
    write_settings(data_dir, &name, &old)?;
    *relay.window.lock().unwrap() = name.clone();
    relay.set_old_names(old);
    heartbeat::write_heartbeat(work_dir, &name, std::process::id(), now).map_err(|e| e.to_string())?;
    Ok(name)
}

#[cfg(test)]
mod tests {
    use super::*;

    const DAY: u64 = 24 * 3600 * 1000;
    fn o(n: &str, t: u64) -> OldName {
        OldName { name: n.into(), t }
    }

    #[test]
    fn 改名驗證() {
        assert_eq!(validate_name("  小希  ").unwrap(), "小希");
        assert!(validate_name("").is_err() && validate_name("   ").is_err());
        assert!(validate_name(&"字".repeat(40)).is_ok());
        assert!(validate_name(&"字".repeat(41)).is_err());
        assert!(validate_name("a\nb").is_err() && validate_name("a\u{7}b").is_err());
        assert!(validate_name("家用收發室").is_err());
        assert!(validate_name("收發室很棒").is_ok());
    }

    #[test]
    fn 舊名清單_上限與過期與去重() {
        let now = 100 * DAY;
        let many: Vec<OldName> = (0..8).map(|i| o(&format!("n{i}"), now - i as u64 * 1000)).collect();
        let p = prune(&many, "現用", now);
        assert_eq!(p.len(), OLD_MAX);
        assert_eq!(p[0].name, "n0");
        assert_eq!(p[4].name, "n4");
        // 滿 7 天＝過期，差一毫秒還在
        let edge = prune(&[o("剛好過期", now - OLD_KEEP_MS), o("還在", now - OLD_KEEP_MS + 1)], "x", now);
        assert_eq!(edge.iter().map(|x| x.name.as_str()).collect::<Vec<_>>(), vec!["還在"]);
        // 現用名不留在舊名裡；重複的只留最新
        let d = prune(&[o("A", now - 5), o("B", now - 3), o("A", now - 1)], "B", now);
        assert_eq!(d, vec![o("A", now - 1)]);
    }

    #[test]
    fn 改名流程_寄信用新名_舊名進清單_不合法不動() {
        let d = tempfile::tempdir().unwrap();
        let w = tempfile::tempdir().unwrap();
        let r = Relay::new("http://127.0.0.1:1/relay".into(), "k".into(), "H".into(), "H-ASN".into());
        let now = 50 * DAY;
        assert!(rename(&r, d.path(), w.path(), "家用收發室", now).is_err());
        assert_eq!(r.window_name(), "H-ASN");
        assert!(!d.path().join("settings.json").exists());
        assert_eq!(rename(&r, d.path(), w.path(), " 小希 ", now).unwrap(), "小希");
        assert_eq!(r.window_name(), "小希");
        let body = crate::relay::build_send_body(&json!({ "to_node": "W", "body": "嗨", "expects_reply": true }), &r.window_name()).unwrap();
        assert_eq!(body["from_agent"], "小希");
        assert_eq!(r.active_names_at(now + 1000), vec!["小希".to_string(), "H-ASN".to_string()]);
        assert_eq!(crate::read_settings_name(d.path()).as_deref(), Some("小希"));
        assert_eq!(read_old_names(d.path()), vec![o("H-ASN", now)]);
        // 再改回舊名：舊名不會同時是現用名
        rename(&r, d.path(), w.path(), "H-ASN", now + 10).unwrap();
        assert_eq!(r.active_names_at(now + 20), vec!["H-ASN".to_string(), "小希".to_string()]);
        // 8 天後舊名過期，不再收
        assert_eq!(r.active_names_at(now + 8 * DAY), vec!["H-ASN".to_string()]);
        assert!(heartbeat::heartbeat_file(w.path(), "小希").exists());
    }
}

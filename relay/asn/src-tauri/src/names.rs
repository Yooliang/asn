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

/// 去頭尾空白、1～40 字、不能含控制字元、不能用保留給系統通知的名字（「ASN 通知」、結尾是「收發室」；比對前先正規化，見 notice_name::fold_name）
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
    if crate::notice_name::is_reserved_name(&n) {
        return Err("這個名字是保留給系統通知的（「ASN 通知」或結尾是「收發室」），請換一個".into());
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

/// 本人在設備頁替「這台」改了名字、後台已經記好了（#1803）：本機的視窗名跟著換成同一個，
/// 這樣個人頁、寄信的「從 X」、在線回報、收信的名字都和後台那一份一致，不再有第二份。
/// 走的就是 [`rename`]（舊名進清單、改名前寄來的回信還收得到、寫新名心跳）。
/// 改的不是這台（別台設備）回 Ok(None)，什麼都不動；已經一樣也回 Ok(None)。名字被視窗名規則擋下（例如系統保留字）回 Err，呼叫端只記 log、不影響後台已改好的名字。
/// 成功回 Ok(Some(新視窗名))
pub fn follow_device_rename(relay: &Relay, data_dir: &Path, work_dir: &Path, node: &str, new_name: &str, now: u64) -> Result<Option<String>, String> {
    if node != relay.node || relay.window_name() == new_name.trim() {
        return Ok(None);
    }
    rename(relay, data_dir, work_dir, new_name, now).map(Some)
}

/// 啟動時把本機視窗名和後台的設備名對齊一次（#1803）。以後台為準：
/// - 後台名字能用（backend_ok）、和本機不同、而且本機名字是本人取過的（custom）→ 本機換成後台的（回 Align::UseBackend(名字)）。
///   本機名字只是系統預設的（沒取過）就不動：啟動時 sync_device_name 會照舊把視窗名送給後台，後台有本人改過的名字會自己保留；不能因為歷史上兩邊不同就改掉所有人的視窗名（收信、寄信用的名字）
/// - 後台名字不能用（空、像指紋；backend_ok＝false）而本機名字是本人取過的（custom）→ 要用本機名字送一次 device_rename（回 Align::PushLocal(名字)，要有登入簽章才送，沒有就等下次）
/// - 其餘不動
/// backend＝名單裡這個節點的 name；backend_ok＝後台名字合規（device_name_ok 同一套）；custom＝settings.json 有 window_name
#[derive(Debug, PartialEq)]
pub enum Align {
    Keep,
    UseBackend(String),
    PushLocal(String),
}
pub fn align_with_backend(local: &str, custom: bool, backend: &str, backend_ok: bool) -> Align {
    let b = backend.trim();
    if backend_ok && !b.is_empty() {
        return if b == local || !custom { Align::Keep } else { Align::UseBackend(b.to_string()) };
    }
    if custom && validate_name(local).is_ok() && crate::device_id::display_name_ok(local) {
        return Align::PushLocal(local.trim().to_string());
    }
    Align::Keep
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
        for bad in ["ASN 通知", "asn通知", "ＡＳＮ通知", "ASN\u{200b}通知", "x收发室", "АЅΝ通知", "登入通知収発室"] {
            assert!(validate_name(bad).is_err(), "{bad}");
        }
        assert!(validate_name("ASN 通知單").is_ok());
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

    #[test]
    fn 設備頁改名_本機視窗名跟著換_別台不動() {
        let d = tempfile::tempdir().unwrap();
        let w = tempfile::tempdir().unwrap();
        let r = Relay::new("http://127.0.0.1:1/relay".into(), "k".into(), "H".into(), "H-ASN".into());
        let now = 50 * DAY;
        // 別台設備：不動
        assert_eq!(follow_device_rename(&r, d.path(), w.path(), "W", "工作機", now).unwrap(), None);
        assert_eq!(r.window_name(), "H-ASN");
        // 這台：視窗名換成後台的名字、舊名進清單
        assert_eq!(follow_device_rename(&r, d.path(), w.path(), "H", "測試手機", now).unwrap(), Some("測試手機".to_string()));
        assert_eq!(r.window_name(), "測試手機");
        assert_eq!(read_old_names(d.path()), vec![o("H-ASN", now)]);
        // 已經一樣：不動
        assert_eq!(follow_device_rename(&r, d.path(), w.path(), "H", "測試手機", now + 1).unwrap(), None);
        // 視窗名規則擋下（系統保留字）：回錯、視窗名不變
        assert!(follow_device_rename(&r, d.path(), w.path(), "H", "家用收發室", now + 2).is_err());
        assert_eq!(r.window_name(), "測試手機");
    }

    #[test]
    fn 啟動對齊_以後台為準() {
        // 後台名字能用且不同：本機跟後台
        assert_eq!(align_with_backend("H-ASN", false, "測試手機", true), Align::Keep, "本機名字是系統預設的：不動，免得改掉大家的視窗名");
        assert_eq!(align_with_backend("舊名", true, "測試手機", true), Align::UseBackend("測試手機".into()));
        // 一樣：不動
        assert_eq!(align_with_backend("測試手機", true, "測試手機", true), Align::Keep);
        // 後台名字不能用、本機是本人取過的合格名字：送一次 device_rename
        assert_eq!(align_with_backend("測試手機", true, "n1a2b3c4d-ASN", false), Align::PushLocal("測試手機".into()));
        assert_eq!(align_with_backend("測試手機", true, "", false), Align::PushLocal("測試手機".into()));
        // 本機名字不是本人取的（預設名）、或本機名字也不合格：不動
        assert_eq!(align_with_backend("H-ASN", false, "", false), Align::Keep);
        assert_eq!(align_with_backend("n1a2b3c4d-ASN", true, "", false), Align::Keep);
    }
}

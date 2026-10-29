//! 對話上方「工作項目」大按鈕的列表（#539 之三）：這個本機 Claude 視窗正在跑哪些背景工作。
//! 資料來源：ASN 的 Claude Code 外掛寫的狀態檔 `~/.asn/status/<sessionId>.json` 裡的 `tasks`
//! （外掛從 Stop hook 的 background_tasks 取 id／說明／類型，不存指令全文）。
//! 視窗名字 → sessions/<pid>.json 找 sessionId（同子代理查詢）→ 讀狀態檔。全程只讀檔、不啟動子程序。
//! 狀態檔是別的程式寫的：只取看得懂的字串欄位、再截一次長度；檔太大、壞檔、sessionId 不符、過期一律當沒有。
//! 舊版外掛沒有 tasks：只從 detail「背景工作 N 件」讀件數，列表空著。
use super::console;
use crate::bridge::roster::{valid_sid, MOD_BUSY_MAX_AGE_MS};
use serde::Deserialize;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};

const MAX_BYTES: u64 = 16 * 1024;
const MAX_ITEMS: usize = 20;
const MAX_DESC_CHARS: usize = 60;
const MAX_ID_CHARS: usize = 64;
const MAX_KIND_CHARS: usize = 24;

#[derive(Deserialize)]
pub struct TasksReq {
    pub name: String,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct TaskItem {
    pub id: String,
    pub description: String,
    pub kind: String,
}

fn clip(s: &str, max: usize) -> String {
    let one: String = s.split_whitespace().collect::<Vec<_>>().join(" ");
    let one: String = one.chars().filter(|c| !c.is_control()).collect();
    if one.chars().count() > max {
        let mut t: String = one.chars().take(max).collect();
        t.push('…');
        t
    } else {
        one
    }
}

fn plain(v: Option<&Value>, max: usize, ok: impl Fn(char) -> bool) -> String {
    let s = v.and_then(Value::as_str).unwrap_or("").trim();
    if s.is_empty() || s.chars().count() > max || !s.chars().all(ok) {
        return String::new();
    }
    s.to_string()
}

/// detail「背景工作 N 件」→ N（舊版外掛只有件數）
pub fn count_from_detail(detail: &str) -> Option<usize> {
    let rest = detail.split("背景工作").nth(1)?.trim_start();
    let digits: String = rest.chars().take_while(char::is_ascii_digit).collect();
    if digits.is_empty() || !rest[digits.len()..].trim_start().starts_with('件') {
        return None;
    }
    digits.parse().ok()
}

/// 狀態檔內容 → 背景工作列表。不是陣列、每筆不是物件、欄位不是字串都略過；最多 MAX_ITEMS 筆
pub fn parse_tasks(v: &Value) -> Vec<TaskItem> {
    let Some(arr) = v.get("tasks").and_then(Value::as_array) else { return Vec::new() };
    arr.iter()
        .filter_map(|t| {
            let o = t.as_object()?;
            let id = plain(o.get("id"), MAX_ID_CHARS, |c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.' | ':'));
            let description = clip(o.get("desc").and_then(Value::as_str).unwrap_or(""), MAX_DESC_CHARS);
            let kind = plain(o.get("kind"), MAX_KIND_CHARS, |c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | ' '));
            (!id.is_empty() || !description.is_empty() || !kind.is_empty()).then_some(TaskItem { id, description, kind })
        })
        .take(MAX_ITEMS)
        .collect()
}

fn none(known: bool) -> Value {
    json!({ "ok": true, "known": known, "count": 0, "items": [] })
}

/// 讀 `<status>/<sid>.json`；不採用（不存在、太大、壞檔、sessionId 不符、過期、不是 background）回 None
fn read_status(status: &Path, sid: &str, now_ms: u64) -> Option<Value> {
    if !valid_sid(sid) {
        return None;
    }
    let path = status.join(format!("{sid}.json"));
    if std::fs::metadata(&path).ok()?.len() > MAX_BYTES {
        return None;
    }
    let v: Value = serde_json::from_str(&std::fs::read_to_string(&path).ok()?).ok()?;
    if v.get("sessionId").and_then(Value::as_str) != Some(sid) {
        return None;
    }
    let at = v.get("at").and_then(Value::as_u64)?;
    if now_ms.abs_diff(at) > MOD_BUSY_MAX_AGE_MS {
        return None;
    }
    (v.get("state").and_then(Value::as_str) == Some("background")).then_some(v)
}

/// `sessions`＝Claude 的 sessions 資料夾；`status`＝~/.asn/status
pub(super) fn query_with(sessions: &Path, status: &Path, name: &str, is_alive: impl Fn(u32) -> bool, now_ms: u64) -> Value {
    if name.is_empty() {
        return json!({ "ok": false, "reason": "缺少名字" });
    }
    let list = console::read_sessions(sessions);
    let Some(pid) = console::pick_session_pid(&list, name, is_alive) else { return none(false) };
    let sid = list
        .iter()
        .find(|s| s.get("pid").and_then(Value::as_u64) == Some(pid as u64))
        .and_then(|s| s.get("sessionId").and_then(Value::as_str))
        .unwrap_or("");
    let Some(v) = read_status(status, sid, now_ms) else { return none(true) };
    let items = parse_tasks(&v);
    let said = v.get("detail").and_then(Value::as_str).and_then(count_from_detail).unwrap_or(0);
    json!({ "ok": true, "known": true, "count": said.max(items.len()), "items": items })
}

fn status_dir() -> PathBuf {
    crate::identity::home_dir().join(".asn").join("status")
}

fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

fn alive(pid: u32) -> bool {
    #[cfg(windows)]
    {
        console::win::pid_alive(pid)
    }
    #[cfg(not(windows))]
    {
        let _ = pid;
        true
    }
}

pub fn tasks_query(req: TasksReq) -> Result<Value, String> {
    let Some(dir) = console::sessions_dir() else { return Ok(none(false)) };
    Ok(query_with(&dir, &status_dir(), &req.name, alive, now_ms()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    const NOW: u64 = 1_800_000_000_000;

    fn setup(home: &Path, sid: &str, status: Option<Value>) -> (PathBuf, PathBuf) {
        let sessions = home.join("sessions");
        fs::create_dir_all(&sessions).unwrap();
        fs::write(sessions.join("4242.json"), json!({ "pid": 4242, "name": "小幫手", "sessionId": sid, "kind": "interactive", "startedAt": 1 }).to_string()).unwrap();
        let st = home.join("status");
        fs::create_dir_all(&st).unwrap();
        if let Some(v) = status {
            fs::write(st.join(format!("{sid}.json")), v.to_string()).unwrap();
        }
        (sessions, st)
    }

    fn doc(sid: &str, tasks: Value) -> Value {
        json!({ "sessionId": sid, "state": "background", "detail": "背景工作 2 件", "at": NOW, "turnId": "t", "plugin": "asn@1", "tasks": tasks })
    }

    #[test]
    fn 件數從說明文字讀() {
        assert_eq!(count_from_detail("背景工作 3 件"), Some(3));
        assert_eq!(count_from_detail("資料夾・背景工作 12 件"), Some(12));
        assert_eq!(count_from_detail("背景工作中"), None);
        assert_eq!(count_from_detail("背景工作 x 件"), None);
        assert_eq!(count_from_detail("背景工作 3"), None);
        assert_eq!(count_from_detail(""), None);
    }

    #[test]
    fn 列表只取看得懂的字串欄位_怪格式略過_說明截短() {
        let long = "字".repeat(100);
        let v = json!({ "tasks": [
            { "id": "b1", "desc": "跑  測試\n第二行", "kind": "shell" },
            { "id": 7, "desc": 8, "kind": { "x": 1 } },
            "str", null, [],
            { "id": "../x", "desc": long, "kind": "很長的類型名稱超過二十四個字元的那一種東西" },
            { "id": "b3" },
        ] });
        let r = parse_tasks(&v);
        assert_eq!(r[0], TaskItem { id: "b1".into(), description: "跑 測試 第二行".into(), kind: "shell".into() });
        assert_eq!(r[1].id, "", "路徑符號的代號不收");
        assert_eq!(r[1].kind, "");
        assert_eq!(r[1].description.chars().count(), MAX_DESC_CHARS + 1);
        assert_eq!(r[2], TaskItem { id: "b3".into(), description: "".into(), kind: "".into() });
        assert_eq!(r.len(), 3);
        assert!(parse_tasks(&json!({ "tasks": "壞" })).is_empty());
        assert!(parse_tasks(&json!({})).is_empty());
        let many: Vec<Value> = (0..50).map(|i| json!({ "id": format!("t{i}"), "desc": "x" })).collect();
        assert_eq!(parse_tasks(&json!({ "tasks": many })).len(), MAX_ITEMS);
    }

    #[test]
    fn 依視窗名字讀狀態檔的列表() {
        let d = tempfile::tempdir().unwrap();
        let (s, st) = setup(d.path(), "abc-123", Some(doc("abc-123", json!([{ "id": "b1", "desc": "建置", "kind": "shell" }, { "id": "b2", "desc": "查資料" }]))));
        let r = query_with(&s, &st, "小幫手", |_| true, NOW);
        assert_eq!(r["count"], 2);
        assert_eq!(r["items"][0]["description"], "建置");
        assert_eq!(r["items"][1]["kind"], "");
        // 找不到的名字、視窗已不在：安靜地回 0 件
        assert_eq!(query_with(&s, &st, "別人", |_| true, NOW)["count"], 0);
        assert_eq!(query_with(&s, &st, "小幫手", |_| false, NOW)["count"], 0);
        assert_eq!(query_with(&s, &st, "", |_| true, NOW)["ok"], false);
    }

    #[test]
    fn 舊版外掛沒有列表_只回件數() {
        let d = tempfile::tempdir().unwrap();
        let mut v = doc("abc-123", json!(null));
        v.as_object_mut().unwrap().remove("tasks");
        let (s, st) = setup(d.path(), "abc-123", Some(v));
        let r = query_with(&s, &st, "小幫手", |_| true, NOW);
        assert_eq!(r["count"], 2);
        assert_eq!(r["items"].as_array().unwrap().len(), 0);
    }

    #[test]
    fn 過期_不是背景_代號不符_壞檔_太大_都當沒有() {
        let cases: Vec<(&str, Box<dyn Fn(&Path)>)> = vec![
            ("過期", Box::new(|st: &Path| fs::write(st.join("abc-123.json"), json!({ "sessionId": "abc-123", "state": "background", "at": NOW - MOD_BUSY_MAX_AGE_MS - 1, "tasks": [{ "id": "b" }] }).to_string()).unwrap())),
            ("閒置", Box::new(|st: &Path| fs::write(st.join("abc-123.json"), json!({ "sessionId": "abc-123", "state": "idle", "at": NOW, "tasks": [{ "id": "b" }] }).to_string()).unwrap())),
            ("代號不符", Box::new(|st: &Path| fs::write(st.join("abc-123.json"), json!({ "sessionId": "zzz", "state": "background", "at": NOW, "tasks": [{ "id": "b" }] }).to_string()).unwrap())),
            ("壞檔", Box::new(|st: &Path| fs::write(st.join("abc-123.json"), "{ 半份").unwrap())),
            ("太大", Box::new(|st: &Path| fs::write(st.join("abc-123.json"), json!({ "sessionId": "abc-123", "state": "background", "at": NOW, "pad": "x".repeat(MAX_BYTES as usize) }).to_string()).unwrap())),
            ("沒有檔", Box::new(|_: &Path| {})),
        ];
        for (why, write) in cases {
            let d = tempfile::tempdir().unwrap();
            let (s, st) = setup(d.path(), "abc-123", None);
            write(&st);
            let r = query_with(&s, &st, "小幫手", |_| true, NOW);
            assert_eq!(r["count"], 0, "{why}");
            assert_eq!(r["known"], true, "{why}");
        }
    }

    #[test]
    fn 工作階段代號帶路徑符號不讀檔() {
        let d = tempfile::tempdir().unwrap();
        let (s, st) = setup(d.path(), "../evil", None);
        fs::write(d.path().join("evil.json"), doc("../evil", json!([{ "id": "b" }])).to_string()).unwrap();
        assert_eq!(query_with(&s, &st, "小幫手", |_| true, NOW)["count"], 0);
    }
}

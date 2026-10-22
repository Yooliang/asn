//! 顯示某個 Claude 視窗「正在跑哪些子代理」（#27 最小可用版）。
//! 資料來源：該視窗對話記錄檔（`~/.claude/projects/<資料夾>/<sessionId>.jsonl`，每行一個 JSON）。
//! 助手訊息裡呼叫 `Task`／`Agent` 工具＝派出一個子代理；對應的 `tool_result`（同一個 tool_use_id）出現＝它結束了。
//! 還沒有結果的，就是正在跑的。全程只讀檔、不啟動子程序。
//! 限制：只讀記錄檔最後一段（太大的記錄檔不全讀）；背景執行（run_in_background）的子代理，
//! 一收到「已在背景啟動」的結果就視為結束，不會列出；視窗被強制關掉而沒有結果的，超過兩小時沒更新就不列。
use super::console;
use serde::Deserialize;
use serde_json::{json, Value};
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

/// 最多讀記錄檔尾端這麼多位元組
const TAIL_BYTES: u64 = 4 * 1024 * 1024;
/// 記錄檔超過這麼久沒更新，視為視窗已不在，不列任何子代理
const STALE: Duration = Duration::from_secs(2 * 60 * 60);
/// 畫面上最多列幾個、每個描述最多幾個字
const MAX_ITEMS: usize = 20;
const MAX_DESC_CHARS: usize = 60;

#[derive(Deserialize)]
pub struct SubagentsReq {
    pub name: String,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct Running {
    pub id: String,
    pub description: String,
    pub kind: String,
}

fn short(s: &str) -> String {
    let one: String = s.split_whitespace().collect::<Vec<_>>().join(" ");
    if one.chars().count() > MAX_DESC_CHARS {
        let mut t: String = one.chars().take(MAX_DESC_CHARS).collect();
        t.push('…');
        t
    } else {
        one
    }
}

/// 從記錄檔文字找出還沒有結果的子代理呼叫（依派出順序）。壞行略過；邊界上被切一半的第一行也當壞行略過。
pub fn running_subagents(text: &str) -> Vec<Running> {
    let mut open: Vec<Running> = Vec::new();
    for line in text.lines() {
        let Ok(v) = serde_json::from_str::<Value>(line) else { continue };
        // 子代理自己的內部訊息（isSidechain）不算，只看這個視窗本身派出的
        if v.get("isSidechain").and_then(Value::as_bool) == Some(true) {
            continue;
        }
        let Some(content) = v.pointer("/message/content").and_then(Value::as_array) else { continue };
        match v.get("type").and_then(Value::as_str) {
            Some("assistant") => {
                for item in content {
                    if item.get("type").and_then(Value::as_str) != Some("tool_use") {
                        continue;
                    }
                    let tool = item.get("name").and_then(Value::as_str).unwrap_or("");
                    if tool != "Task" && tool != "Agent" {
                        continue;
                    }
                    let Some(id) = item.get("id").and_then(Value::as_str) else { continue };
                    let input = item.get("input");
                    let field = |k: &str| input.and_then(|i| i.get(k)).and_then(Value::as_str).unwrap_or("").trim();
                    let desc = if !field("description").is_empty() { field("description") } else { field("prompt") };
                    if !open.iter().any(|r| r.id == id) {
                        open.push(Running { id: id.to_string(), description: short(desc), kind: short(field("subagent_type")) });
                    }
                }
            }
            Some("user") => {
                for item in content {
                    if item.get("type").and_then(Value::as_str) == Some("tool_result") {
                        if let Some(id) = item.get("tool_use_id").and_then(Value::as_str) {
                            open.retain(|r| r.id != id);
                        }
                    }
                }
            }
            _ => {}
        }
    }
    open
}

/// 讀檔尾端；不是從檔頭開始時，丟掉第一個不完整的行
fn read_tail(path: &Path) -> Option<String> {
    let mut f = std::fs::File::open(path).ok()?;
    let len = f.metadata().ok()?.len();
    let start = len.saturating_sub(TAIL_BYTES);
    f.seek(SeekFrom::Start(start)).ok()?;
    let mut buf = Vec::new();
    f.take(TAIL_BYTES).read_to_end(&mut buf).ok()?;
    let text = String::from_utf8_lossy(&buf).into_owned();
    if start > 0 {
        return Some(text.split_once('\n').map(|(_, rest)| rest.to_string()).unwrap_or_default());
    }
    Some(text)
}

/// 在 `projects` 底下每個資料夾找 `<sessionId>.jsonl`（不去推算資料夾的編碼方式）
fn find_transcript(projects: &Path, session_id: &str) -> Option<PathBuf> {
    // sessionId 只當檔名用，不接受路徑符號
    if session_id.is_empty() || !session_id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        return None;
    }
    let file = format!("{session_id}.jsonl");
    std::fs::read_dir(projects).ok()?.flatten().map(|e| e.path().join(&file)).find(|p| p.is_file())
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

fn none(known: bool) -> Value {
    json!({ "ok": true, "known": known, "count": 0, "items": [] })
}

/// `sessions` 是 `<設定資料夾>/sessions`；記錄檔在同層的 `projects`
pub(super) fn query_with(sessions: &Path, name: &str, is_alive: impl Fn(u32) -> bool, now: SystemTime) -> Value {
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
    let projects = sessions.parent().map(|p| p.join("projects")).unwrap_or_default();
    let Some(file) = find_transcript(&projects, sid) else { return none(false) };
    let fresh = std::fs::metadata(&file)
        .and_then(|m| m.modified())
        .map(|t| now.duration_since(t).map(|d| d < STALE).unwrap_or(true))
        .unwrap_or(false);
    if !fresh {
        return none(true);
    }
    let Some(text) = read_tail(&file) else { return none(false) };
    let all = running_subagents(&text);
    let count = all.len();
    let items: Vec<Running> = all.into_iter().take(MAX_ITEMS).collect();
    json!({ "ok": true, "known": true, "count": count, "items": items })
}

pub fn subagents_query(req: SubagentsReq) -> Result<Value, String> {
    let Some(dir) = console::sessions_dir() else { return Ok(none(false)) };
    Ok(query_with(&dir, &req.name, alive, SystemTime::now()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn asst(tool: &str, id: &str, input: Value) -> String {
        json!({ "type": "assistant", "message": { "content": [{ "type": "text", "text": "好" }, { "type": "tool_use", "id": id, "name": tool, "input": input }] } }).to_string()
    }
    fn result(id: &str) -> String {
        json!({ "type": "user", "message": { "content": [{ "type": "tool_result", "tool_use_id": id, "content": "完成" }] } }).to_string()
    }

    #[test]
    fn 沒有結果的子代理才算正在跑() {
        let t = [
            asst("Task", "t1", json!({ "description": "查登入流程", "subagent_type": "Explore", "prompt": "很長的提示" })),
            asst("Agent", "t2", json!({ "description": "寫測試" })),
            asst("Bash", "t3", json!({ "command": "ls" })),
            result("t1"),
        ]
        .join("\n");
        let r = running_subagents(&t);
        assert_eq!(r, vec![Running { id: "t2".into(), description: "寫測試".into(), kind: "".into() }]);
    }

    #[test]
    fn 沒有描述用提示_壞行與子代理內部訊息略過_描述會截短() {
        let long = "字".repeat(100);
        let mut side: Value = serde_json::from_str(&asst("Task", "s1", json!({ "description": "內部" }))).unwrap();
        side["isSidechain"] = json!(true);
        let t = ["不是 JSON {{".to_string(), asst("Task", "t1", json!({ "prompt": long })), side.to_string(), "{\"type\":\"user\"}".into()].join("\n");
        let r = running_subagents(&t);
        assert_eq!(r.len(), 1);
        assert_eq!(r[0].id, "t1");
        assert_eq!(r[0].description.chars().count(), MAX_DESC_CHARS + 1);
        assert!(r[0].description.ends_with('…'));
    }

    fn setup(home: &Path, sid: &str, lines: &[String]) -> PathBuf {
        let sessions = home.join("sessions");
        fs::create_dir_all(&sessions).unwrap();
        fs::write(sessions.join("4242.json"), json!({ "pid": 4242, "name": "小幫手", "sessionId": sid, "kind": "interactive", "startedAt": 1 }).to_string()).unwrap();
        let proj = home.join("projects").join("D--fake-proj");
        fs::create_dir_all(&proj).unwrap();
        fs::write(proj.join(format!("{sid}.jsonl")), lines.join("\n")).unwrap();
        sessions
    }

    #[test]
    fn 依視窗名字找到記錄檔並列出子代理() {
        let d = tempfile::tempdir().unwrap();
        let s = setup(d.path(), "abc-123", &[asst("Task", "t1", json!({ "description": "掃描資料夾" }))]);
        let r = query_with(&s, "小幫手", |_| true, SystemTime::now());
        assert_eq!(r["count"], 1);
        assert_eq!(r["items"][0]["description"], "掃描資料夾");
        // 找不到的名字、視窗已不在：安靜地回 0 個
        assert_eq!(query_with(&s, "別人", |_| true, SystemTime::now())["count"], 0);
        assert_eq!(query_with(&s, "小幫手", |_| false, SystemTime::now())["count"], 0);
    }

    #[test]
    fn 記錄檔太久沒更新就不列() {
        let d = tempfile::tempdir().unwrap();
        let s = setup(d.path(), "abc-123", &[asst("Task", "t1", json!({ "description": "x" }))]);
        let later = SystemTime::now() + STALE + Duration::from_secs(60);
        let r = query_with(&s, "小幫手", |_| true, later);
        assert_eq!(r["count"], 0);
        assert_eq!(r["known"], true);
    }

    #[test]
    fn 只讀尾端時丟掉被切一半的第一行() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("big.jsonl");
        let filler = json!({ "type": "user", "message": { "content": [] }, "pad": "x".repeat(1000) }).to_string();
        let mut body = asst("Task", "old", json!({ "description": "太舊" })) + "\n";
        for _ in 0..(TAIL_BYTES as usize / filler.len() + 5) {
            body.push_str(&filler);
            body.push('\n');
        }
        body.push_str(&asst("Task", "new", json!({ "description": "新的" })));
        fs::write(&p, body).unwrap();
        let r = running_subagents(&read_tail(&p).unwrap());
        assert_eq!(r.iter().map(|x| x.id.as_str()).collect::<Vec<_>>(), vec!["new"]);
    }

    #[test]
    fn 工作階段代號帶路徑符號不讀檔() {
        let d = tempfile::tempdir().unwrap();
        assert!(find_transcript(d.path(), "../x").is_none());
        assert!(find_transcript(d.path(), "").is_none());
    }
}

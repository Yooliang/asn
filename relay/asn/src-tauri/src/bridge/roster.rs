//! 本機視窗名單：讀 `~/.claude/sessions/<pid>.json`（Claude Code 自己維護的 session 檔），不用呼叫 `claude agents`。
//! 對應 engines/claude.mjs 的 listWindows：只留互動式（kind=interactive）、entrypoint=cli、pid 還活著的視窗，
//! 排除收發室 worker 自己。回報格式照 bridge.mjs 的 roster：`{agents:[{name,status,cwd_label,engine}], launcher}`。
use serde_json::{json, Value};
use std::path::Path;

#[derive(Clone, Debug, PartialEq)]
pub struct Window {
    pub name: String,
    pub status: Option<String>,
    pub cwd: String,
    pub pid: u32,
    /// 最後活動時間（毫秒），預設收件視窗不在線時挑最近活動的
    pub updated_at: u64,
}

impl Window {
    pub fn cwd_label(&self) -> String {
        self.cwd.split(['\\', '/']).filter(|s| !s.is_empty()).last().unwrap_or("").to_string()
    }
    pub fn is_busy(&self) -> bool {
        is_busy_status(self.status.as_deref())
    }
}

/// 忙碌狀態（Node 橋預設 `^(busy|working|running)$`，不分大小寫）
pub fn is_busy_status(s: Option<&str>) -> bool {
    matches!(s.map(|x| x.to_lowercase()).as_deref(), Some("busy") | Some("working") | Some("running"))
}

fn parse_session(v: &Value) -> Option<Window> {
    let pid = v.get("pid")?.as_u64()? as u32;
    if v.get("entrypoint").and_then(Value::as_str) != Some("cli") {
        return None;
    }
    if let Some(k) = v.get("kind").and_then(Value::as_str) {
        if k != "interactive" {
            return None;
        }
    }
    let name = v.get("name").and_then(Value::as_str)?.trim().to_string();
    if name.is_empty() {
        return None;
    }
    Some(Window {
        name,
        status: v.get("status").and_then(Value::as_str).map(String::from),
        cwd: v.get("cwd").and_then(Value::as_str).unwrap_or("").to_string(),
        pid,
        updated_at: v.get("updatedAt").and_then(Value::as_u64).unwrap_or(0),
    })
}

/// 讀取失敗（資料夾存在卻讀不了）回 None，呼叫端沿用舊名單；資料夾不存在＝沒有任何視窗
pub fn read_sessions(dir: &Path, alive: impl Fn(u32) -> bool, exclude_pid: u32, exclude_name: &str) -> Option<Vec<Window>> {
    let rd = match std::fs::read_dir(dir) {
        Ok(r) => r,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Some(vec![]),
        Err(_) => return None,
    };
    let mut out: Vec<Window> = vec![];
    for e in rd.flatten() {
        let name = e.file_name().to_string_lossy().to_string();
        let Some(stem) = name.strip_suffix(".json") else { continue };
        let Ok(file_pid) = stem.parse::<u32>() else { continue };
        let Ok(text) = std::fs::read_to_string(e.path()) else { continue };
        let Ok(v) = serde_json::from_str::<Value>(&text) else { continue };
        let Some(w) = parse_session(&v) else { continue };
        // 檔名的 pid 要和內容一致（identity.mjs 的 readSession 同），而且程序還活著
        if w.pid != file_pid || !alive(w.pid) || w.pid == exclude_pid || w.name == exclude_name {
            continue;
        }
        out.push(w);
    }
    out.sort_by(|a, b| a.name.cmp(&b.name).then(a.pid.cmp(&b.pid)));
    Some(out)
}

/// roster 動作的請求內容。asn_window＝ASN 自己的視窗名（也列進名單，別台看得到這台的 ASN；engine 標 asn）。
/// launcher＝遠端開視窗的摘要（profile 名與標籤、cwd 白名單、上限；不含指令），沒有可用設定送 null，仲介就清掉。
pub fn roster_body(windows: &[Window], asn_window: Option<&str>, launcher: Value) -> Value {
    let mut agents: Vec<Value> = windows.iter().map(|w| json!({ "name": w.name, "status": w.status, "cwd_label": w.cwd_label(), "engine": "claude" })).collect();
    if let Some(n) = asn_window {
        if !windows.iter().any(|w| w.name == n) {
            agents.push(json!({ "name": n, "status": "idle", "cwd_label": "", "engine": "asn" }));
        }
    }
    json!({ "agents": agents, "launcher": launcher })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn put(d: &Path, pid: u32, v: Value) {
        std::fs::write(d.join(format!("{pid}.json")), v.to_string()).unwrap();
    }

    #[test]
    fn 只留活著的互動式_cli_視窗_排除收發室與壞檔() {
        let d = tempfile::tempdir().unwrap();
        put(d.path(), 101, json!({"pid":101,"name":"T-甲","cwd":"D:\\x\\proj","status":"idle","kind":"interactive","entrypoint":"cli","updatedAt":50}));
        put(d.path(), 102, json!({"pid":102,"name":"T-乙","cwd":"/home/u/work/","status":"busy","entrypoint":"cli"}));
        put(d.path(), 103, json!({"pid":103,"name":"T-死了","entrypoint":"cli"}));
        put(d.path(), 104, json!({"pid":104,"name":"T-背景","kind":"background","entrypoint":"cli"}));
        put(d.path(), 105, json!({"pid":105,"name":"T-sdk","entrypoint":"sdk-cli"}));
        put(d.path(), 106, json!({"pid":106,"name":"","entrypoint":"cli"}));
        put(d.path(), 107, json!({"pid":999,"name":"T-檔名對不上","entrypoint":"cli"}));
        put(d.path(), 108, json!({"pid":108,"name":"T-收發室","entrypoint":"cli"}));
        put(d.path(), 109, json!({"pid":109,"name":"worker","entrypoint":"cli"}));
        std::fs::write(d.path().join("110.json"), "{壞").unwrap();
        std::fs::write(d.path().join("notes.txt"), "x").unwrap();
        let alive = |p: u32| p != 103;
        let ws = read_sessions(d.path(), alive, 109, "T-收發室").unwrap();
        assert_eq!(ws.iter().map(|w| w.name.as_str()).collect::<Vec<_>>(), vec!["T-乙", "T-甲"]);
        assert_eq!(ws[1].cwd_label(), "proj");
        assert_eq!(ws[0].cwd_label(), "work");
        assert!(ws[0].is_busy() && !ws[1].is_busy());
        assert_eq!(ws[1].updated_at, 50);
    }

    #[test]
    fn 資料夾不存在是空名單_讀不了才是_none() {
        let d = tempfile::tempdir().unwrap();
        assert_eq!(read_sessions(&d.path().join("none"), |_| true, 0, "x"), Some(vec![]));
        // 把檔案當資料夾：讀不了
        let f = d.path().join("file");
        std::fs::write(&f, "x").unwrap();
        assert_eq!(read_sessions(&f, |_| true, 0, "x"), None);
    }

    #[test]
    fn 回報內容格式_含_asn_視窗名_launcher_摘要或_null() {
        let w = Window { name: "T-甲".into(), status: Some("idle".into()), cwd: "D:\\a\\b".into(), pid: 1, updated_at: 0 };
        let b = roster_body(&[w.clone()], Some("T-ASN"), Value::Null);
        assert_eq!(b["launcher"], Value::Null);
        assert_eq!(roster_body(&[w.clone()], None, json!({"profiles": []}))["launcher"], json!({"profiles": []}));
        assert_eq!(b["agents"][0], json!({"name":"T-甲","status":"idle","cwd_label":"b","engine":"claude"}));
        assert_eq!(b["agents"][1], json!({"name":"T-ASN","status":"idle","cwd_label":"","engine":"asn"}));
        // 不給 ASN 視窗名就只有 Claude 視窗；與視窗同名不重複列
        assert_eq!(roster_body(&[w], None, Value::Null)["agents"].as_array().unwrap().len(), 1);
        let w2 = Window { name: "T-ASN".into(), status: None, cwd: "".into(), pid: 2, updated_at: 0 };
        assert_eq!(roster_body(&[w2], Some("T-ASN"), Value::Null)["agents"].as_array().unwrap().len(), 1);
        assert!(is_busy_status(Some("Working")) && !is_busy_status(Some("idle")) && !is_busy_status(None));
    }
}

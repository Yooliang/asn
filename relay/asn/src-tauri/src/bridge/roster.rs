//! 本機視窗名單：讀 `~/.claude/sessions/<pid>.json`（Claude Code 自己維護的 session 檔），不用呼叫 `claude agents`。
//! 對應 engines/claude.mjs 的 listWindows：只留互動式（kind=interactive）、entrypoint=cli、pid 還活著的視窗，
//! 排除收發室 worker 自己。回報格式照 bridge.mjs 的 roster：`{agents:[{name,status,cwd_label,engine}], launcher}`。
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::path::Path;

#[derive(Clone, Debug, PartialEq)]
pub struct Window {
    pub name: String,
    pub status: Option<String>,
    pub cwd: String,
    pub pid: u32,
    /// 最後活動時間（毫秒），預設收件視窗不在線時挑最近活動的
    pub updated_at: u64,
    /// Claude 的 session 編號（session 檔的 sessionId）；夥伴 ID 用它判斷「同一位夥伴換名或換 session」（#109）
    pub session_id: Option<String>,
    /// 這個視窗由哪個引擎轉交：claude（預設）／acp／codex
    pub engine: String,
    /// 名單上顯示的引擎名（例如 acp 工作者回報 gemini）；路由仍依 engine
    pub engine_label: Option<String>,
    /// 沒指定收件人又找不到預設視窗時，不拿它當代收者（背景工作者）
    pub no_fallback: bool,
    /// 名單上顯示的資料夾標籤（ACP 工作者用設定的 label，不用資料夾名）
    pub cwd_label_override: Option<String>,
}

impl Window {
    /// 名單與夥伴同步回報的引擎名
    pub fn label(&self) -> &str {
        self.engine_label.as_deref().unwrap_or(&self.engine)
    }
    /// Claude 視窗（由 ~/.claude/sessions 讀出）
    pub fn claude(name: &str, status: Option<String>, cwd: &str, pid: u32, updated_at: u64, session_id: Option<String>) -> Window {
        Window { name: name.into(), status, cwd: cwd.into(), pid, updated_at, session_id, engine: "claude".into(), engine_label: None, no_fallback: false, cwd_label_override: None }
    }
    pub fn cwd_label(&self) -> String {
        if let Some(l) = &self.cwd_label_override {
            return l.clone();
        }
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
    Some(Window::claude(
        &name,
        v.get("status").and_then(Value::as_str).map(String::from),
        v.get("cwd").and_then(Value::as_str).unwrap_or(""),
        pid,
        v.get("updatedAt").and_then(Value::as_u64).unwrap_or(0),
        v.get("sessionId").and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty()).map(String::from),
    ))
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
    let mut agents: Vec<Value> = windows.iter().map(|w| json!({ "name": w.name, "status": w.status, "cwd_label": w.cwd_label(), "engine": w.label() })).collect();
    if let Some(n) = asn_window {
        if !windows.iter().any(|w| w.name == n) {
            agents.push(json!({ "name": n, "status": "idle", "cwd_label": "", "engine": "asn" }));
        }
    }
    json!({ "agents": agents, "launcher": launcher })
}

/// partner_sync 的請求內容（#109）：每個視窗的名字、session 編號（沒有就不送）、引擎。節點由後端依金鑰決定，這裡不送。
/// ASN 自己的視窗也列進去（引擎 asn、沒有 session），和 roster 一樣與同名的 Claude 視窗不重複。
pub fn partner_body(windows: &[Window], asn_window: Option<&str>) -> Value {
    let mut ws: Vec<Value> = windows
        .iter()
        .map(|w| {
            let mut o = json!({ "name": w.name, "engine": w.label() });
            if let Some(s) = &w.session_id {
                o["session_id"] = json!(s);
            }
            o
        })
        .collect();
    if let Some(n) = asn_window {
        if !windows.iter().any(|w| w.name == n) {
            ws.push(json!({ "name": n, "engine": "asn" }));
        }
    }
    json!({ "windows": ws })
}

/// 夥伴 ID 的格式（與後端 partners_id_check 同）：p_ 加 20 個小寫十六進位字元
pub fn valid_partner_id(s: &str) -> bool {
    s.len() == 22 && s.starts_with("p_") && s[2..].bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// partner_sync 的回應 `{ok, partners:[{name, partner_id}]}` → 視窗名對夥伴 ID；格式不對的項目略過
pub fn parse_partners(resp: &Value) -> BTreeMap<String, String> {
    let mut m = BTreeMap::new();
    for p in resp.get("partners").and_then(Value::as_array).into_iter().flatten() {
        if let (Some(n), Some(id)) = (p.get("name").and_then(Value::as_str), p.get("partner_id").and_then(Value::as_str)) {
            if !n.is_empty() && valid_partner_id(id) {
                m.insert(n.to_string(), id.to_string());
            }
        }
    }
    m
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
    fn 讀得到_session_編號_沒有或空白就是_none() {
        let d = tempfile::tempdir().unwrap();
        put(d.path(), 201, json!({"pid":201,"name":"T-有","entrypoint":"cli","sessionId":" 11111111-aaaa "}));
        put(d.path(), 202, json!({"pid":202,"name":"T-無","entrypoint":"cli"}));
        put(d.path(), 203, json!({"pid":203,"name":"T-空","entrypoint":"cli","sessionId":"  "}));
        let ws = read_sessions(d.path(), |_| true, 0, "x").unwrap();
        let by = |n: &str| ws.iter().find(|w| w.name == n).unwrap().session_id.clone();
        assert_eq!(by("T-有").as_deref(), Some("11111111-aaaa"));
        assert_eq!(by("T-無"), None);
        assert_eq!(by("T-空"), None);
    }

    #[test]
    fn 夥伴同步的請求內容_名字_session_引擎_不含節點_asn_視窗不重複() {
        let a = Window::claude("T-甲", None, "", 1, 0, Some("sess-0001-aaaa".into()));
        let b = Window::claude("T-乙", None, "", 2, 0, None);
        let body = partner_body(&[a.clone(), b.clone()], Some("T-ASN"));
        assert_eq!(body, json!({"windows": [
            {"name":"T-甲","engine":"claude","session_id":"sess-0001-aaaa"},
            {"name":"T-乙","engine":"claude"},
            {"name":"T-ASN","engine":"asn"},
        ]}));
        assert!(body.get("node").is_none());
        assert_eq!(partner_body(&[a, b], Some("T-乙"))["windows"].as_array().unwrap().len(), 2);
        assert_eq!(partner_body(&[], None), json!({"windows": []}));
    }

    #[test]
    fn 夥伴同步的回應_只收格式正確的夥伴_id() {
        let ok = format!("p_{}", "0123456789abcdef0123");
        let r = json!({"ok": true, "partners": [
            {"name":"T-甲","partner_id": ok},
            {"name":"T-壞1","partner_id":"p_XYZ"},
            {"name":"T-壞2","partner_id":"q_0123456789abcdef0123"},
            {"name":"","partner_id": ok},
            {"partner_id": ok},
            "x",
        ]});
        let m = parse_partners(&r);
        assert_eq!(m.len(), 1);
        assert_eq!(m.get("T-甲").map(String::as_str), Some(ok.as_str()));
        assert!(parse_partners(&json!({"ok": true})).is_empty());
        assert!(valid_partner_id(&ok) && !valid_partner_id("p_0123456789ABCDEF0123") && !valid_partner_id("p_0123"));
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
        let w = Window::claude("T-甲", Some("idle".into()), "D:\\a\\b", 1, 0, None);
        let b = roster_body(&[w.clone()], Some("T-ASN"), Value::Null);
        assert_eq!(b["launcher"], Value::Null);
        assert_eq!(roster_body(&[w.clone()], None, json!({"profiles": []}))["launcher"], json!({"profiles": []}));
        assert_eq!(b["agents"][0], json!({"name":"T-甲","status":"idle","cwd_label":"b","engine":"claude"}));
        assert_eq!(b["agents"][1], json!({"name":"T-ASN","status":"idle","cwd_label":"","engine":"asn"}));
        // 不給 ASN 視窗名就只有 Claude 視窗；與視窗同名不重複列
        assert_eq!(roster_body(&[w], None, Value::Null)["agents"].as_array().unwrap().len(), 1);
        let w2 = Window::claude("T-ASN", None, "", 2, 0, None);
        assert_eq!(roster_body(&[w2], Some("T-ASN"), Value::Null)["agents"].as_array().unwrap().len(), 1);
        assert!(is_busy_status(Some("Working")) && !is_busy_status(Some("idle")) && !is_busy_status(None));
    }
}

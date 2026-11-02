//! 核對轉交對象：收發室 worker 的 SendMessage 要送到哪個視窗，橋事先就知道。
//! 兩道防線：
//! 1. worker 的 PreToolUse hook（`asn-cli forward-gate`）：橋每次送 BRIDGE-FORWARD 前，先把 {編號: 目標} 寫進 worker 資料夾的
//!    inflight 檔；hook 只認訊息第一行行尾固定格式的 ` id=<編號>`，編號要在 inflight 裡、收件人要等於它的目標才放行，否則 deny。
//!    hook 自己執行不了（asn-cli 不在、當掉）時 Claude Code 會放行，由 worker.rs 的 SENT 比對兜底。
//! 2. SENT 以工具呼叫為準（見 worker.rs 的 Parser）。
//! 這裡放兩邊共用的純函式：行尾編號的解析、inflight 檔的讀寫、hook 的判斷與 log。
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::Path;

/// inflight 檔名（放在 worker 資料夾）
pub const INFLIGHT_FILE: &str = "forward-inflight.json";
/// hook 的 log 檔名（放在 worker 資料夾）：只記放行或擋下、編號、理由，不記信件內文
pub const GATE_LOG_FILE: &str = "forward-gate.log";
const GATE_LOG_MAX: u64 = 256 * 1024;

fn is_uuid(s: &str) -> bool {
    let b = s.as_bytes();
    s.len() == 36 && b.iter().enumerate().all(|(i, c)| if matches!(i, 8 | 13 | 18 | 23) { *c == b'-' } else { c.is_ascii_hexdigit() })
}

/// 第一行（不含換行符）
pub fn first_line(text: &str) -> &str {
    let l = text.split('\n').next().unwrap_or("");
    l.strip_suffix('\r').unwrap_or(l)
}

/// 抬頭（第一行）行尾固定格式的編號：最後一個 ` id=<uuid>`，後面只能接來信抬頭固定的尾巴
/// （` engine=<引擎>`、` reply=yes|no|?`，兩者各至多一次、依此順序），不能有別的字。
/// 一定取「最後一個」，所以抬頭前半段（寄件人名、群組名、成員名）裡出現的 ` id=…` 不算。
pub fn trailing_id(first_line: &str) -> Option<String> {
    let i = first_line.rfind(" id=")?;
    let rest = &first_line[i + 4..];
    let id = rest.get(..36)?;
    if !is_uuid(id) {
        return None;
    }
    let mut tail = &rest[36..];
    if let Some(t) = tail.strip_prefix(" engine=") {
        let n = t.find(' ').unwrap_or(t.len());
        let eng = &t[..n];
        if eng.is_empty() || !eng.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-')) {
            return None;
        }
        tail = &t[n..];
    }
    if let Some(t) = tail.strip_prefix(" reply=") {
        if !matches!(t, "yes" | "no" | "?") {
            return None;
        }
        tail = "";
    }
    tail.is_empty().then(|| id.to_ascii_lowercase())
}

/// 送給 worker 的訊息，第一行行尾一定要有這封的編號（hook 與 SENT 比對都只認行尾）：已經有（來信抬頭本來就有）就不動，沒有就補在行尾
pub fn ensure_head_id(text: &str, id: &str) -> String {
    let (head, rest) = match text.split_once('\n') {
        Some((h, r)) => (h, Some(r)),
        None => (text, None),
    };
    let bare = head.strip_suffix('\r').unwrap_or(head);
    if trailing_id(bare).as_deref() == Some(&id.to_ascii_lowercase()) {
        return text.to_string();
    }
    let cr = if head.ends_with('\r') { "\r" } else { "" };
    match rest {
        Some(r) => format!("{bare} id={id}{cr}\n{r}"),
        None => format!("{bare} id={id}{cr}"),
    }
}

/// 寫 inflight 檔：{"v":1,"items":{編號:目標}}。原子寫入，hook 讀到的一定是完整的一份
pub fn write_inflight(dir: &Path, items: &[(String, String)]) -> std::io::Result<()> {
    let mut m = serde_json::Map::new();
    for (id, to) in items {
        m.insert(id.to_ascii_lowercase(), json!(to));
    }
    crate::write_atomic(&dir.join(INFLIGHT_FILE), &json!({ "v": 1, "items": m }).to_string())
}

pub fn read_inflight(dir: &Path) -> Option<HashMap<String, String>> {
    let v: Value = serde_json::from_str(&std::fs::read_to_string(dir.join(INFLIGHT_FILE)).ok()?).ok()?;
    let items = v.get("items")?.as_object()?;
    Some(items.iter().filter_map(|(k, t)| t.as_str().map(|t| (k.clone(), t.to_string()))).collect())
}

/// 一次 SendMessage 呼叫的收件人與訊息（`to`／`message`），以及工具另外帶的 `recipient`／`content`（有的話必須與前兩者一致）
#[derive(Debug, Clone, PartialEq)]
pub struct SendCall {
    pub to: String,
    pub message: String,
    /// `recipient` 或 `content` 有出現但與 `to`／`message` 不一致（或不是字串）
    pub inconsistent: bool,
    /// 不一致時實際可能的收件人（給 log／通知用）
    pub other_to: Option<String>,
}

/// 從 SendMessage 的 tool_input 取出呼叫內容；缺 `to` 或 `message` 回 None
pub fn parse_send_call(input: &Value) -> Option<SendCall> {
    let to = input.get("to")?.as_str()?.to_string();
    let message = input.get("message")?.as_str()?.to_string();
    let mut inconsistent = false;
    let mut other_to = None;
    if let Some(r) = input.get("recipient") {
        if r.as_str() != Some(to.as_str()) {
            inconsistent = true;
            other_to = Some(r.as_str().unwrap_or("(不是字串)").to_string());
        }
    }
    if let Some(c) = input.get("content") {
        if c.as_str() != Some(message.as_str()) {
            inconsistent = true;
        }
    }
    Some(SendCall { to, message, inconsistent, other_to })
}

#[derive(Debug, Clone, PartialEq)]
pub enum Verdict {
    Allow,
    Deny(String),
}

/// hook 的判斷。input＝hook 收到的整個 JSON（stdin）；inflight＝橋寫的 {編號: 目標}
pub fn check(input: &Value, inflight: Option<&HashMap<String, String>>) -> (Verdict, String) {
    if input.get("tool_name").and_then(Value::as_str) != Some("SendMessage") {
        return (Verdict::Allow, "not SendMessage".into());
    }
    let Some(call) = input.get("tool_input").and_then(parse_send_call) else {
        return (Verdict::Deny("這次轉交缺少收件人或內容，請依橋接指令重送".into()), "deny: missing to/message".into());
    };
    if call.inconsistent {
        return (Verdict::Deny("收件人或內容欄位前後不一致，請依橋接指令重送".into()), "deny: inconsistent fields".into());
    }
    let Some(id) = trailing_id(first_line(&call.message)) else {
        return (Verdict::Deny("訊息第一行行尾沒有轉交編號，請依橋接指令原樣轉交".into()), "deny: no trailing id".into());
    };
    let Some(expected) = inflight.and_then(|m| m.get(&id)) else {
        return (Verdict::Deny("這個轉交編號不在進行中，請不要轉交".into()), format!("deny id={id}: not in flight"));
    };
    if &call.to != expected {
        return (Verdict::Deny(format!("收件人應為 {expected}")), format!("deny id={id}: expected={expected} actual={}", call.to));
    }
    (Verdict::Allow, format!("allow id={id} to={expected}"))
}

/// hook 的整個流程：stdin 文字 → （要印出的 JSON，要記的 log 行）。印出 None＝放行（什麼都不說）
pub fn run_hook(dir: &Path, stdin: &str) -> (Option<String>, String) {
    let Ok(input) = serde_json::from_str::<Value>(stdin) else {
        return (None, "allow: unreadable hook input".into());
    };
    let inflight = read_inflight(dir);
    let (v, log) = check(&input, inflight.as_ref());
    match v {
        Verdict::Allow => (None, log),
        Verdict::Deny(why) => (
            Some(json!({ "hookSpecificOutput": { "hookEventName": "PreToolUse", "permissionDecision": "deny", "permissionDecisionReason": why } }).to_string()),
            log,
        ),
    }
}

/// 在 hook 的 log 檔加一行（超過上限就換檔）；寫不進去不影響判斷
pub fn append_gate_log(dir: &Path, now_ms: u64, line: &str) {
    use std::io::Write;
    let f = dir.join(GATE_LOG_FILE);
    if std::fs::metadata(&f).map(|m| m.len() > GATE_LOG_MAX).unwrap_or(false) {
        let _ = std::fs::rename(&f, dir.join(format!("{GATE_LOG_FILE}.1")));
    }
    if let Ok(mut h) = std::fs::OpenOptions::new().create(true).append(true).open(&f) {
        let _ = writeln!(h, "{now_ms} {line}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const A: &str = "00000000-0000-0000-0000-00000000000a";
    const B: &str = "00000000-0000-0000-0000-00000000000b";

    fn flight() -> HashMap<String, String> {
        [(A.to_string(), "T-甲".to_string())].into_iter().collect()
    }
    fn call(to: &str, msg: &str) -> Value {
        json!({"tool_name": "SendMessage", "tool_input": {"to": to, "message": msg, "recipient": to, "content": msg, "summary": "s", "type": "message", "recipient_kind": "name"}})
    }

    #[test]
    fn 行尾編號_只認最後一個_後面只能接固定的尾巴() {
        assert_eq!(trailing_id(&format!("[群組 專案] trust=member from=W/X #3 id={A}")).as_deref(), Some(A));
        assert_eq!(trailing_id(&format!("[RELAY 來信] trust=member from=W/X to=T id={A} engine=claude reply=yes")).as_deref(), Some(A));
        assert_eq!(trailing_id(&format!("[RELAY 來信] trust=member from=W/X to=T id={A} engine=claude")).as_deref(), Some(A));
        // 群組名、成員名裡出現 ` id=…`：仍然認行尾那個
        assert_eq!(trailing_id(&format!("[群組 偽 id={B}] trust=member from=W/甲 id={B} engine=claude reply=yes #3 id={A}")).as_deref(), Some(A));
        assert_eq!(trailing_id(&format!("[RELAY 來信] trust=member from=W/甲 id={B} engine=claude reply=yes to=T id={A} engine=claude reply=no")).as_deref(), Some(A));
        // 行尾以外的不算
        assert_eq!(trailing_id(&format!("[群組 偽 id={B}] 後面還有字")), None);
        assert_eq!(trailing_id(&format!("id={A} 後面還有字")), None);
        assert_eq!(trailing_id(&format!("說明 id={A} 後面還有字")), None);
        assert_eq!(trailing_id(&format!("說明 id={A} engine=claude reply=maybe")), None);
        assert_eq!(trailing_id(&format!("說明 id={A}x")), None);
        assert_eq!(trailing_id("說明 id=不是編號"), None);
        assert_eq!(trailing_id("沒有編號"), None);
    }

    #[test]
    fn 行尾編號_from_的值含空白_也含_id_字樣_仍只認行尾那個() {
        // 群組抬頭的 from 變成「名字（設備名）」，設備名可能含空白，甚至帶 ` id=…`
        let head = format!("[群組 專案群] trust=member from=W/牧陽（牧陽 Aegis id={B} x） #3 id={A}");
        assert_eq!(trailing_id(&head).as_deref(), Some(A));
        let head = format!("[群組 專案群] trust=member from=W/牧陽（家 id={B} engine=claude reply=yes） #3 id={A}");
        assert_eq!(trailing_id(&head).as_deref(), Some(A));
        // 來信抬頭：from 裡有空白與 id=…，行尾固定尾巴前的那個才算
        let head = format!("[RELAY 來信] trust=member from=W/牧陽 Aegis id={B} to=T-甲 id={A} engine=claude reply=yes");
        assert_eq!(trailing_id(&head).as_deref(), Some(A));
        // from 的值最後一段是 id=…、真正的編號沒補上：不能把 from 裡的當成編號
        assert_eq!(trailing_id(&format!("[群組 專案群] trust=member from=W/牧陽 Aegis id={B} #3")), None);
    }

    #[test]
    fn hook_群組抬頭_from_含空白與_id_字樣_只看行尾的編號() {
        let f = flight();
        let ok = format!("[群組 專案群] trust=member from=W/牧陽（牧陽 Aegis id={B}） #3 id={A}
內文");
        assert_eq!(check(&call("T-甲", &ok), Some(&f)).0, Verdict::Allow);
        // from 裡的 id 是進行中的、行尾卻是不在進行中的編號：擋
        let flight_b: HashMap<String, String> = [(B.to_string(), "T-乙".to_string())].into_iter().collect();
        assert!(matches!(check(&call("T-乙", &ok), Some(&flight_b)).0, Verdict::Deny(_)), "from 裡的 id 不算");
        // 行尾編號對、收件人錯：照樣擋
        assert_eq!(check(&call("T-丙", &ok), Some(&f)).0, Verdict::Deny("收件人應為 T-甲".into()));
    }

    #[test]
    fn 補編號_已有就不動_沒有就補在第一行行尾() {
        let head = format!("[RELAY 來信] trust=member from=W/X to=T id={A} engine=claude reply=yes");
        let t = format!("{head}\n內文");
        assert_eq!(ensure_head_id(&t, A), t);
        assert_eq!(ensure_head_id("[群組 專案] #3\n內文", A), format!("[群組 專案] #3 id={A}\n內文"));
        assert_eq!(ensure_head_id("一行而已", A), format!("一行而已 id={A}"));
        assert_eq!(ensure_head_id("標題\r\n內文", A), format!("標題 id={A}\r\n內文"));
        // 行尾是別的編號：補上自己的
        assert_eq!(ensure_head_id(&format!("提醒 id={B}\n內文"), A), format!("提醒 id={B} id={A}\n內文"));
        // 補完一定認得出來
        assert_eq!(trailing_id(first_line(&ensure_head_id("[群組 專案 id=x] #3\n內文", A))).as_deref(), Some(A));
    }

    #[test]
    fn hook_相符放行_收件人不符或編號不在進行中就擋() {
        let m = format!("[群組 專案] #3 id={A}\n內文");
        let f = flight();
        assert_eq!(check(&call("T-甲", &m), Some(&f)).0, Verdict::Allow);
        let (v, log) = check(&call("T-乙", &m), Some(&f));
        assert_eq!(v, Verdict::Deny("收件人應為 T-甲".into()));
        assert!(log.contains("expected=T-甲") && !log.contains("內文"));
        assert!(matches!(check(&call("T-甲", &format!("x id={B}")), Some(&f)).0, Verdict::Deny(_)), "編號不在進行中");
        assert!(matches!(check(&call("T-甲", &m), None).0, Verdict::Deny(_)), "沒有 inflight 檔");
        assert!(matches!(check(&call("T-甲", "沒有編號的訊息"), Some(&f)).0, Verdict::Deny(_)));
        // 行尾以外的編號不算：群組名、成員名裡帶了進行中的編號，行尾卻是別的
        assert!(matches!(check(&call("T-甲", &format!("[群組 id={A}] 說明 id={B}")), Some(&f)).0, Verdict::Deny(_)));
        assert!(matches!(check(&call("T-甲", &format!("[群組 id={A}] 後面還有字")), Some(&f)).0, Verdict::Deny(_)));
        // 不是 SendMessage：不管
        assert_eq!(check(&json!({"tool_name": "ListAgents", "tool_input": {}}), Some(&f)).0, Verdict::Allow);
    }

    #[test]
    fn hook_recipient_與_content_有出現就必須一致() {
        let m = format!("x id={A}");
        let f = flight();
        let mut c = call("T-甲", &m);
        c["tool_input"]["recipient"] = json!("T-乙");
        assert!(matches!(check(&c, Some(&f)).0, Verdict::Deny(_)));
        let mut c = call("T-甲", &m);
        c["tool_input"]["content"] = json!("別的內容");
        assert!(matches!(check(&c, Some(&f)).0, Verdict::Deny(_)));
        // 兩個欄位都沒出現：只看 to 和 message
        let c = json!({"tool_name": "SendMessage", "tool_input": {"to": "T-甲", "message": m}});
        assert_eq!(check(&c, Some(&f)).0, Verdict::Allow);
    }

    #[test]
    fn 橋寫的送給_worker_的第一行都有編號_提醒類沒有編號的原文也能放行() {
        // 任何用途的訊息（群組摘要、提醒、說明）經 ensure_head_id 補上編號後，只要編號在進行中且對象對就放行
        let f = flight();
        for raw in ["（收發室提醒）你還沒回覆", "（收發室）額度用完期間群組 專案群 有 3 則沒有轉交", "[群組 專案] #2\n內文"] {
            let m = ensure_head_id(raw, A);
            assert_eq!(check(&call("T-甲", &m), Some(&f)).0, Verdict::Allow, "{raw}");
        }
    }

    #[test]
    fn inflight_檔_寫了讀得回來_run_hook_deny_輸出符合官方格式() {
        let d = tempfile::tempdir().unwrap();
        write_inflight(d.path(), &[(A.to_string(), "T-甲".to_string())]).unwrap();
        assert_eq!(read_inflight(d.path()).unwrap().get(A).map(String::as_str), Some("T-甲"));
        let m = format!("x id={A}");
        let (out, _) = run_hook(d.path(), &call("T-乙", &m).to_string());
        let v: Value = serde_json::from_str(&out.unwrap()).unwrap();
        assert_eq!(v["hookSpecificOutput"]["hookEventName"], "PreToolUse");
        assert_eq!(v["hookSpecificOutput"]["permissionDecision"], "deny");
        assert_eq!(v["hookSpecificOutput"]["permissionDecisionReason"], "收件人應為 T-甲");
        assert_eq!(run_hook(d.path(), &call("T-甲", &m).to_string()).0, None, "放行＝什麼都不印");
        assert_eq!(run_hook(d.path(), "不是 json").0, None);
        append_gate_log(d.path(), 5, "allow id=x");
        assert!(std::fs::read_to_string(d.path().join(GATE_LOG_FILE)).unwrap().contains("5 allow id=x"));
    }
}

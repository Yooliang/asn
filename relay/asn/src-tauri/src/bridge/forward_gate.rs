//! 核對轉交對象：收發室 worker 的 SendMessage 要送到哪個視窗，橋事先就知道。
//! 兩道防線：
//! 核對抬頭：inflight 檔除了編號與目標，也存橋送出那一封第一行（去掉行尾空白）的 sha256；hook 與 SENT 比對都要求訊息第一行與橋給的完全一樣。
//! 1. worker 的 PreToolUse hook（`asn-cli forward-gate`）：橋每次送 BRIDGE-FORWARD 前，先把 {編號: 目標} 寫進 worker 資料夾的
//!    inflight 檔；hook 只認訊息第一行行尾固定格式的 ` id=<編號>`，編號要在 inflight 裡、收件人要等於它的目標才放行，否則 deny。
//!    hook 自己執行不了（asn-cli 不在、當掉）時 Claude Code 會放行，由 worker.rs 的 SENT 比對兜底。
//! 2. SENT 以工具呼叫為準（見 worker.rs 的 Parser）。
//! 這裡放兩邊共用的純函式：行尾編號的解析、inflight 檔的讀寫、hook 的判斷與 log。
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::path::Path;

/// inflight 檔名（放在 worker 資料夾）
pub const INFLIGHT_FILE: &str = "forward-inflight.json";
/// hook 的 log 檔名（放在 worker 資料夾）：只記放行或擋下、編號、理由，不記信件內文
pub const GATE_LOG_FILE: &str = "forward-gate.log";
const GATE_LOG_MAX: u64 = 256 * 1024;
/// 內文檔資料夾（放在 worker 資料夾）：橋存的原文，檔名是信件編號
pub const BODY_DIR: &str = "forward-body";
/// 已套用紀錄資料夾：hook 換上原文之後寫下原文雜湊，檔名是信件編號
pub const APPLIED_DIR: &str = "forward-applied";

fn is_uuid(s: &str) -> bool {
    let b = s.as_bytes();
    s.len() == 36 && b.iter().enumerate().all(|(i, c)| if matches!(i, 8 | 13 | 18 | 23) { *c == b'-' } else { c.is_ascii_hexdigit() })
}

/// 第一行（不含換行符，也去掉行尾的 \r 與空白）
pub fn first_line(text: &str) -> &str {
    text.split('\n').next().unwrap_or("").trim_end()
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

/// 橋送出那一封第一行的指紋：去掉行尾的 \r 與空白後取 sha256（十六進位）。第一行就是第一個換行之前的內容
pub fn head_hash(first_line: &str) -> String {
    Sha256::digest(first_line.trim_end().as_bytes()).iter().map(|b| format!("{b:02x}")).collect()
}

/// inflight 檔裡的一筆：橋指定的收件人，以及第一行的指紋（舊檔沒有就不比對）
#[derive(Debug, Clone, PartialEq)]
pub struct InflightItem {
    pub to: String,
    pub head: Option<String>,
    /// 全文雜湊（有＝這封走原文替換：hook 讀內文檔、核對雜湊、換上原文）
    pub body: Option<String>,
}

/// 寫 inflight 檔：{"v":2,"items":{編號:{"to":目標,"head":指紋}}}。原子寫入，hook 讀到的一定是完整的一份
pub fn write_inflight(dir: &Path, items: &[(String, String, Option<String>)]) -> std::io::Result<()> {
    write_inflight_with(dir, items, &HashMap::new())
}

/// 同 write_inflight；bodies＝{編號: 全文雜湊}，有的那幾封多寫一個 body 欄位
pub fn write_inflight_with(dir: &Path, items: &[(String, String, Option<String>)], bodies: &HashMap<String, String>) -> std::io::Result<()> {
    let mut m = serde_json::Map::new();
    for (id, to, head) in items {
        let mut e = json!({ "to": to, "head": head });
        if let Some(b) = bodies.get(id) {
            e["body"] = json!(b);
        }
        m.insert(id.to_ascii_lowercase(), e);
    }
    crate::write_atomic(&dir.join(INFLIGHT_FILE), &json!({ "v": 2, "items": m }).to_string())
}

/// 全文雜湊（sha256，十六進位）：逐位元組，不做任何換行或空白處理
pub fn body_hash(text: &str) -> String {
    Sha256::digest(text.as_bytes()).iter().map(|b| format!("{b:02x}")).collect()
}

/// 走原文替換時交給 worker 的佔位行（第一行行尾有編號，hook 與 SENT 比對都認得）
pub fn placeholder_line(id: &str) -> String {
    format!("[ASN 轉交未帶入內文] 這封信的內文沒有送到，收發室會重送，不用回覆。 id={id}")
}

fn file_of(dir: &Path, sub: &str, id: &str) -> Option<std::path::PathBuf> {
    is_uuid(id).then(|| dir.join(sub).join(id.to_ascii_lowercase()))
}

/// 內文與紀錄的資料夾只給本機使用者讀寫（Unix 0700；Windows 沿用使用者資料夾的權限）
fn private_dir(dir: &Path, sub: &str) {
    let d = dir.join(sub);
    let _ = std::fs::create_dir_all(&d);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&d, std::fs::Permissions::from_mode(0o700));
    }
}

pub fn write_body(dir: &Path, id: &str, text: &str) -> std::io::Result<()> {
    let f = file_of(dir, BODY_DIR, id).ok_or_else(|| std::io::Error::new(std::io::ErrorKind::InvalidInput, "bad id"))?;
    private_dir(dir, BODY_DIR);
    crate::write_atomic(&f, text)
}

pub fn remove_applied(dir: &Path, id: &str) {
    if let Some(f) = file_of(dir, APPLIED_DIR, id) {
        let _ = std::fs::remove_file(f);
    }
}

pub fn read_body(dir: &Path, id: &str) -> Option<String> {
    std::fs::read_to_string(file_of(dir, BODY_DIR, id)?).ok()
}

pub fn write_applied(dir: &Path, id: &str, hash: &str) -> std::io::Result<()> {
    let f = file_of(dir, APPLIED_DIR, id).ok_or_else(|| std::io::Error::new(std::io::ErrorKind::InvalidInput, "bad id"))?;
    private_dir(dir, APPLIED_DIR);
    crate::write_atomic(&f, hash)
}

pub fn read_applied(dir: &Path, id: &str) -> Option<String> {
    std::fs::read_to_string(file_of(dir, APPLIED_DIR, id)?).ok()
}

/// 內文檔與已套用紀錄：編號不在 live 裡的刪掉（live＝None＝全部刪，啟動時清舊檔用）
pub fn prune_files(dir: &Path, live: Option<&std::collections::HashSet<String>>) {
    for sub in [BODY_DIR, APPLIED_DIR] {
        let Ok(rd) = std::fs::read_dir(dir.join(sub)) else { continue };
        for e in rd.flatten() {
            let name = e.file_name().to_string_lossy().to_string();
            if live.is_none_or(|l| !l.contains(&name)) {
                let _ = std::fs::remove_file(e.path());
            }
        }
    }
}

pub fn read_inflight(dir: &Path) -> Option<HashMap<String, InflightItem>> {
    let v: Value = serde_json::from_str(&std::fs::read_to_string(dir.join(INFLIGHT_FILE)).ok()?).ok()?;
    let items = v.get("items")?.as_object()?;
    Some(
        items
            .iter()
            .filter_map(|(k, t)| match t {
                Value::String(to) => Some((k.clone(), InflightItem { to: to.clone(), head: None, body: None })), // v1
                Value::Object(o) => Some((k.clone(), InflightItem { to: o.get("to")?.as_str()?.to_string(), head: o.get("head").and_then(Value::as_str).map(String::from), body: o.get("body").and_then(Value::as_str).map(String::from) })),
                _ => None,
            })
            .collect(),
    )
}

/// 一次 SendMessage 呼叫的收件人與訊息（`to`／`message`），以及工具另外帶的 `recipient`（有的話必須與 `to` 一致）。
/// 工具另外帶的 `content` 只是內文的預覽（前幾十個字加「…」），不是完整內文，完全不看
#[derive(Debug, Clone, PartialEq)]
pub struct SendCall {
    pub to: String,
    pub message: String,
    /// `recipient` 有出現但與 `to` 不一致（或不是字串）
    pub inconsistent: bool,
    /// 不一致時實際可能的收件人（給 log／通知用）
    pub other_to: Option<String>,
}

/// 轉交內容和原信比對的紀錄（只量，不擋）：只有編號與數字，絕不含內文。
/// 比對前只統一換行和結尾空白；sent＝橋交給 worker 的字元數，got＝worker 實際送出的字元數，prefix／suffix＝開頭／結尾相同幾個字元。
/// 原文暫存被擠掉或編號不認得時是 no-original，要另外算，分母才準。
pub fn body_compare_line(id: &str, original: Option<&str>, got: &str) -> String {
    let got_chars = got.chars().count();
    let Some(original) = original else {
        return format!("forward-body id={id} result=no-original got={got_chars}");
    };
    let sent_chars = original.chars().count();
    if original == got {
        return format!("forward-body id={id} result=same sent={sent_chars} got={got_chars}");
    }
    let (a, b) = (normalize_body(original), normalize_body(got));
    if a == b {
        return format!("forward-body id={id} result=whitespace sent={sent_chars} got={got_chars}");
    }
    let (ac, bc): (Vec<char>, Vec<char>) = (a.chars().collect(), b.chars().collect());
    let prefix = ac.iter().zip(&bc).take_while(|(x, y)| x == y).count();
    let room = ac.len().min(bc.len()) - prefix; // 結尾不和開頭重疊
    let suffix = ac.iter().rev().zip(bc.iter().rev()).take(room).take_while(|(x, y)| x == y).count();
    format!("forward-body id={id} result=diff sent={sent_chars} got={got_chars} prefix={prefix} suffix={suffix}")
}

fn normalize_body(s: &str) -> String {
    s.replace("\r\n", "\n").trim_end().to_string()
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
    Some(SendCall { to, message, inconsistent, other_to })
}

#[derive(Debug, Clone, PartialEq)]
pub enum Verdict {
    Allow,
    /// 放行，而且要把訊息換成橋存的原文（編號）
    Replace(String),
    Deny(String),
}

/// hook 的判斷。input＝hook 收到的整個 JSON（stdin）；inflight＝橋寫的 {編號: 目標}
pub fn check(input: &Value, inflight: Option<&HashMap<String, InflightItem>>) -> (Verdict, String) {
    if input.get("tool_name").and_then(Value::as_str) != Some("SendMessage") {
        return (Verdict::Allow, "not SendMessage".into());
    }
    let Some(call) = input.get("tool_input").and_then(parse_send_call) else {
        return (Verdict::Deny("這次轉交缺少收件人或內容，請依橋接指令重送".into()), "deny: missing to/message".into());
    };
    if call.inconsistent {
        return (Verdict::Deny("收件人欄位前後不一致，請依橋接指令重送".into()), "deny: inconsistent recipient".into());
    }
    let Some(id) = trailing_id(first_line(&call.message)) else {
        return (Verdict::Deny("訊息第一行行尾沒有轉交編號，請依橋接指令原樣轉交".into()), "deny: no trailing id".into());
    };
    // 讀不到 inflight 檔（暫時讀不到、檔案壞了）和「編號不在進行中」是兩回事：理由與 log 分開寫
    let Some(flight) = inflight else {
        return (Verdict::Deny("轉交紀錄暫時讀不到，請稍後重送".into()), format!("deny id={id}: inflight file unreadable"));
    };
    let Some(item) = flight.get(&id) else {
        return (Verdict::Deny("這個轉交編號不在進行中，請不要轉交".into()), format!("deny id={id}: not in flight"));
    };
    if call.to != item.to {
        return (Verdict::Deny(format!("收件人應為 {}", item.to)), format!("deny id={id}: expected={} actual={}", item.to, call.to));
    }
    // 核對抬頭：第一行要和橋送出的完全一樣（只容許行尾空白與 \r 的差異）；第二行以後不比
    if let Some(h) = &item.head {
        if &head_hash(first_line(&call.message)) != h {
            return (Verdict::Deny("訊息抬頭與橋送出的不一致，請原樣轉交".into()), format!("deny id={id}: head mismatch"));
        }
    }
    if item.body.is_some() {
        return (Verdict::Replace(id.clone()), format!("allow id={id} to={} exact", item.to));
    }
    (Verdict::Allow, format!("allow id={id} to={}", item.to))
}

/// hook 的整個流程：stdin 文字 → （要印出的 JSON，要記的 log 行）。印出 None＝放行（什麼都不說）
pub fn run_hook(dir: &Path, stdin: &str) -> (Option<String>, String) {
    run_hook_with(dir, stdin, || std::thread::sleep(std::time::Duration::from_millis(100)))
}

/// `pause`：第一次讀不到時，再讀之前要做的事（正式版是等一下，測試用它把檔案放進去，不靠時間）
fn run_hook_with(dir: &Path, stdin: &str, pause: impl FnOnce()) -> (Option<String>, String) {
    let Ok(input) = serde_json::from_str::<Value>(stdin) else {
        return (None, "allow: unreadable hook input".into());
    };
    let mut inflight = read_inflight(dir);
    if inflight.is_none() && input.get("tool_name").and_then(Value::as_str) == Some("SendMessage") {
        // 橋正好在換檔、或暫時讀不到：短暫等一下再讀一次，還是讀不到才擋
        pause();
        inflight = read_inflight(dir);
    }
    let (v, log) = check(&input, inflight.as_ref());
    match v {
        Verdict::Allow => (None, log),
        Verdict::Replace(id) => {
            let want = inflight.as_ref().and_then(|f| f.get(&id)).and_then(|i| i.body.clone()).unwrap_or_default();
            match apply_exact(dir, &input, &id, &want) {
                Ok(out) => (Some(out), log),
                Err(why) => (
                    Some(json!({ "hookSpecificOutput": { "hookEventName": "PreToolUse", "permissionDecision": "deny", "permissionDecisionReason": "轉交內文暫時讀不到，收發室會重送" } }).to_string()),
                    format!("deny id={id}: {why}"),
                ),
            }
        }
        Verdict::Deny(why) => (
            Some(json!({ "hookSpecificOutput": { "hookEventName": "PreToolUse", "permissionDecision": "deny", "permissionDecisionReason": why } }).to_string()),
            log,
        ),
    }
}

/// 原文替換：讀內文檔、核對雜湊、先寫下已套用紀錄，最後才輸出「放行並換上原文」。順序不能換：
/// 紀錄沒寫成就不放行；放行後 stdout 出錯的情況，橋收到 Sent 時會因為有紀錄但內容沒送到而以別的方式發現（機率低，接受）
fn apply_exact(dir: &Path, input: &Value, id: &str, want: &str) -> Result<String, String> {
    let body = read_body(dir, id).ok_or("body file unreadable")?;
    if body_hash(&body) != want {
        return Err("body hash mismatch".into());
    }
    write_applied(dir, id, want).map_err(|e| format!("applied record write failed: {e}"))?;
    let ti = input.get("tool_input").ok_or("no tool_input")?;
    let to = ti.get("to").and_then(Value::as_str).ok_or("no to")?;
    let summary = ti.get("summary").and_then(Value::as_str).unwrap_or("轉交 relay 來信");
    Ok(json!({ "hookSpecificOutput": { "hookEventName": "PreToolUse", "permissionDecision": "allow", "updatedInput": { "to": to, "summary": summary, "message": body } } }).to_string())
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

    #[test]
    fn 內文比對_相同_只差換行空白_不同_沒有原文各記各的_不含內文() {
        let secret = "機密內文-不可進記錄";
        let original = format!("抬頭 id={A}\n{secret}\n結尾");
        assert_eq!(body_compare_line(A, Some(&original), &original), format!("forward-body id={A} result=same sent=20 got=20").replace("sent=20 got=20", &format!("sent={0} got={0}", original.chars().count())));
        let crlf = format!("{}\r\n", original.replace('\n', "\r\n"));
        assert!(body_compare_line(A, Some(&original), &crlf).contains("result=whitespace"));
        // 結尾多一行：開頭全相同、結尾 0
        let extra = format!("{original}\n多打的一行");
        let n = original.chars().count();
        let line = body_compare_line(A, Some(&original), &extra);
        assert!(line.contains("result=diff") && line.contains(&format!("prefix={n} suffix=0")), "{line}");
        // 中間改一個字：開頭、結尾各自相同
        let line = body_compare_line(A, Some("甲乙丙丁戊"), "甲乙X丁戊");
        assert!(line.ends_with("sent=5 got=5 prefix=2 suffix=2"), "{line}");
        // 重複的字：結尾不和開頭重疊
        let line = body_compare_line(A, Some("aaa"), "aaaa");
        assert!(line.ends_with("sent=3 got=4 prefix=3 suffix=0"), "{line}");
        assert_eq!(body_compare_line(A, None, &original), format!("forward-body id={A} result=no-original got={n}"));
        for l in [body_compare_line(A, Some(&original), &extra), body_compare_line(A, None, &original), body_compare_line(A, Some(&original), &crlf)] {
            assert!(!l.contains(secret) && !l.contains("多打"), "記錄不含內文：{l}");
        }
    }

    fn item(to: &str, head: Option<&str>) -> InflightItem {
        InflightItem { to: to.to_string(), head: head.map(|h| head_hash(h)), body: None }
    }
    fn flight() -> HashMap<String, InflightItem> {
        [(A.to_string(), item("T-甲", None))].into_iter().collect()
    }
    /// 真實紀錄的形狀：content 只是內文的預覽（前幾十個字加「…」），message 才是完整內文
    fn preview(msg: &str) -> String {
        format!("{}…", msg.chars().take(40).collect::<String>())
    }
    fn call(to: &str, msg: &str) -> Value {
        json!({"tool_name": "SendMessage", "tool_input": {"to": to, "message": msg, "recipient": to, "content": preview(msg), "summary": "s", "type": "message", "recipient_kind": "name"}})
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
        let flight_b: HashMap<String, InflightItem> = [(B.to_string(), item("T-乙", None))].into_iter().collect();
        assert!(matches!(check(&call("T-乙", &ok), Some(&flight_b)).0, Verdict::Deny(_)), "from 裡的 id 不算");
        // 行尾編號對、收件人錯：照樣擋
        assert_eq!(check(&call("T-丙", &ok), Some(&f)).0, Verdict::Deny("收件人應為 T-甲".into()));
    }

    #[test]
    fn 抬頭指紋_去掉行尾空白與_cr_其餘逐字() {
        assert_eq!(head_hash("標題 id=x"), head_hash("標題 id=x  \r"));
        assert_ne!(head_hash("標題 id=x"), head_hash(" 標題 id=x"));
        assert_ne!(head_hash("標題 id=x"), head_hash("標題 id=y"));
        assert_eq!(head_hash("").len(), 64);
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
    fn hook_recipient_有出現就必須和_to_一致_content_是預覽不看() {
        let long = format!("[群組 專案群] trust=member from=W/政策（小良的家用機） 這是一段很長很長很長很長很長很長很長的抬頭後面還有 #3 id={A}\n{}", "內文".repeat(300));
        let f = flight();
        // 真實形狀：content 是預覽加「…」、message 是完整內文：放行
        let c = call("T-甲", &long);
        assert_ne!(c["tool_input"]["content"], c["tool_input"]["message"]);
        assert_eq!(check(&c, Some(&f)).0, Verdict::Allow);
        // content 寫什麼都不影響
        let mut c2 = call("T-甲", &long);
        c2["tool_input"]["content"] = json!("完全不相干的字");
        assert_eq!(check(&c2, Some(&f)).0, Verdict::Allow);
        // recipient 和 to 不一致：擋
        let mut c3 = call("T-甲", &long);
        c3["tool_input"]["recipient"] = json!("T-乙");
        assert!(matches!(check(&c3, Some(&f)).0, Verdict::Deny(_)));
        // 兩個欄位都沒出現：只看 to 和 message
        let c4 = json!({"tool_name": "SendMessage", "tool_input": {"to": "T-甲", "message": long}});
        assert_eq!(check(&c4, Some(&f)).0, Verdict::Allow);
    }

    #[test]
    fn hook_核對抬頭_第一行要和橋送出的一樣_第二行以後不比_行尾空白與_cr_不算差異() {
        let head = format!("[群組 專案群] trust=member from=W/政策 #3 id={A}");
        let f: HashMap<String, InflightItem> = [(A.to_string(), item("T-甲", Some(&head)))].into_iter().collect();
        assert_eq!(check(&call("T-甲", &format!("{head}\n內文")), Some(&f)).0, Verdict::Allow);
        assert_eq!(check(&call("T-甲", &format!("{head}\n完全不同的內文")), Some(&f)).0, Verdict::Allow, "第二行以後不比");
        assert_eq!(check(&call("T-甲", &format!("{head}\r\n內文")), Some(&f)).0, Verdict::Allow, "行尾 \\r");
        assert_eq!(check(&call("T-甲", &format!("{head}  \n內文")), Some(&f)).0, Verdict::Allow, "行尾空白");
        // 第一行被動過（哪怕編號和收件人都對）：擋
        let (v, log) = check(&call("T-甲", &format!("{}\n內文", head.replace("#3", "#4"))), Some(&f));
        assert!(matches!(v, Verdict::Deny(ref r) if r.contains("抬頭")), "{v:?}");
        assert!(log.contains("head mismatch"));
        assert!(matches!(check(&call("T-甲", &format!(" {head}\n內文")), Some(&f)).0, Verdict::Deny(_)), "行首空白算差異");
        // 舊格式的檔（沒有指紋）：不比對
        assert_eq!(check(&call("T-甲", "x id=00000000-0000-0000-0000-00000000000a"), Some(&flight())).0, Verdict::Allow);
    }

    #[test]
    fn hook_讀不到_inflight_檔_理由與編號不在進行中分開寫() {
        let m = format!("x id={A}");
        let (v, log) = check(&call("T-甲", &m), None);
        assert_eq!(v, Verdict::Deny("轉交紀錄暫時讀不到，請稍後重送".into()));
        assert!(log.contains("inflight file unreadable"));
        let (v, log) = check(&call("T-甲", &format!("x id={B}")), Some(&flight()));
        assert_eq!(v, Verdict::Deny("這個轉交編號不在進行中，請不要轉交".into()));
        assert!(log.contains("not in flight"));
    }

    #[test]
    fn run_hook_第一次讀不到會再讀一次_檔案剛好出現就放行() {
        let d = tempfile::tempdir().unwrap();
        let m = format!("x id={A}");
        let input = call("T-甲", &m).to_string();
        // 一直讀不到：擋，理由是暫時讀不到
        let (out, log) = run_hook(d.path(), &input);
        assert!(out.unwrap().contains("轉交紀錄暫時讀不到") && log.contains("unreadable"));
        // 不是轉交就不用等
        let other = json!({ "tool_name": "Bash", "tool_input": {} }).to_string();
        let (out, _) = run_hook_with(d.path(), &other, || panic!("不是 SendMessage 不用再讀一次"));
        assert_eq!(out, None);
        // 再讀之前檔案出現：放行
        let (out, log) = run_hook_with(d.path(), &input, || write_inflight(d.path(), &[(A.to_string(), "T-甲".to_string(), None)]).unwrap());
        assert_eq!(out, None, "{log}");
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
        write_inflight(d.path(), &[(A.to_string(), "T-甲".to_string(), None)]).unwrap();
        assert_eq!(read_inflight(d.path()).unwrap().get(A), Some(&item("T-甲", None)));
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

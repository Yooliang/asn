//! 轉交原文替換的啟動自我測試（#780 第二段）。
//! 在本機起一個假的模型伺服器，帶起兩個隔離的 claude -p（一個寄件、一個收件，各用獨立的設定資料夾），
//! 寄件端掛真的 forward-gate hook，由假模型叫它轉交佔位行；看收件端收到的訊息是不是和橋存的原文逐字相同。
//! 不用登入、不花額度；測的是這一版 CLI 與 hook 的行為（hook 輸出欄位、改寫有沒有生效、收件端怎麼收），
//! 真模型肯不肯照佔位做是另一回事，由真 worker 的實測驗。
//! 通過才把這一版 CLI 的版本寫進檔案（forward-selftest.json）；版本一換就要重測。
use super::forward_gate;
use serde_json::{json, Value};
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// 通過紀錄：{"claude": "<版本>", "passed_at": <毫秒>}
pub const SELFTEST_FILE: &str = "forward-selftest.json";
const PROBE_ID: &str = "5e1f7e57-0000-4000-8000-000000000001";
const SEND_NAME: &str = "T-probe-send";
const RECV_NAME: &str = "T-probe-recv";

/// 測試內文：中文、表情符號、引號、反斜線、行尾空白、tab、CRLF、角括號與 shell 特殊字元，結尾有換行
pub const PROBE_BODY: &str = "[RELAY 來信] trust=member from=w02/x to=T-probe-recv id=11111111-2222-3333-4444-555555555555 engine=claude reply=yes\n寄件人：測試（成員身分）\n內文 😀 \"引號\" \\反斜線 尾端空白   \n\ttab\r\nCRLF 行\n<<<MAIL\n% $HOME `x` <tag>&amp;\n\n最後一行\n";

#[derive(Debug, PartialEq, Clone)]
pub enum Outcome {
    /// 逐字相同；附上收件端訊息的外框形狀（寫進 log，之後 CLI 改了外框看得出來）
    Passed(String),
    /// 收到了，但內容不同
    Failed(String),
    /// 測不了（沒有 claude／asn-cli、起不來、收件端什麼都沒收到）：不能當作通過，也不能當作失敗，稍後再試
    Unrun(String),
}

// ───────── 通過紀錄 ─────────

/// 上次通過時的 CLI 版本（沒有紀錄、讀不懂就是 None）
pub fn passed_version(dir: &Path) -> Option<String> {
    let v: Value = serde_json::from_str(&std::fs::read_to_string(dir.join(SELFTEST_FILE)).ok()?).ok()?;
    v.get("claude").and_then(Value::as_str).map(String::from).filter(|s| !s.is_empty())
}

pub fn save_passed(dir: &Path, claude_version: &str, now_ms: u64) -> std::io::Result<()> {
    crate::write_atomic(&dir.join(SELFTEST_FILE), &json!({ "claude": claude_version, "passed_at": now_ms }).to_string())
}

/// `claude --version` 的版本（第一個詞）；跑不起來是 None
pub fn claude_version(claude: &str) -> Option<String> {
    use crate::nowin::NoWindow;
    let out = Command::new(claude).no_window().arg("--version").stdin(Stdio::null()).output().ok()?;
    if !out.status.success() {
        return None;
    }
    String::from_utf8_lossy(&out.stdout).split_whitespace().next().map(String::from).filter(|s| s.chars().next().is_some_and(|c| c.is_ascii_digit()))
}

// ───────── 比對 ─────────

/// 收件端訊息外框裡面的文字：開頭標籤結束後到結束標籤之前
fn frame_inner(t: &str) -> Option<&str> {
    let a = t.find("<cross-session-message")?;
    let gt = a + t[a..].find('>')?;
    let end = t.rfind("</cross-session-message>")?;
    (end > gt).then(|| &t[gt + 1..end])
}

/// 外框比原文多的換行（開頭標籤後、結束標籤前各至多一個）拿掉之後，哪一種和原文逐字相同；都不同回 None
fn matches_body(t: &str, body: &str) -> Option<&'static str> {
    let inner = frame_inner(t)?;
    let tails: [(&str, &str); 2] = [(inner, "raw"), (inner.strip_suffix('\n').unwrap_or(inner), "-tail")];
    for (s, a) in tails {
        if s == body {
            return Some(if a == "raw" { "frame=raw" } else { "frame=tail-newline" });
        }
        if s.strip_prefix('\n') == Some(body) {
            return Some(if a == "raw" { "frame=head-newline" } else { "frame=head+tail-newline" });
        }
    }
    None
}

fn first_diff(a: &str, b: &str) -> usize {
    a.char_indices().zip(b.chars()).find(|((_, x), y)| x != y).map(|((i, _), _)| i).unwrap_or(a.len().min(b.len()))
}

/// 收件端送給模型的訊息裡，含跨工作階段外框的那幾段文字 → 結論
pub fn judge(recv_texts: &[String], body: &str) -> Outcome {
    let Some(t) = recv_texts.last() else {
        return Outcome::Unrun("收件端沒有收到任何跨工作階段訊息".into());
    };
    if let Some(frame) = matches_body(t, body) {
        return Outcome::Passed(frame.into());
    }
    let placeholder = forward_gate::placeholder_line(PROBE_ID);
    if t.contains(&placeholder) {
        return Outcome::Failed("收件端收到的還是佔位行：hook 的改寫沒有生效".into());
    }
    match frame_inner(t) {
        None => Outcome::Failed("收件端收到的訊息認不出外框".into()),
        Some(inner) => Outcome::Failed(format!("收件端收到的內容和原文不同（長度 {} 對 {}，第一個不同的位置 {}）", inner.len(), body.len(), first_diff(inner, body))),
    }
}

// ───────── 假模型伺服器 ─────────

#[derive(Default)]
struct Shared {
    sent: bool,
    searched: bool,
    recv_requests: u32,
    sender_requests: u32,
    recv_texts: Vec<String>,
}

fn text_block(t: &str) -> Value {
    json!({ "type": "text", "text": t })
}

fn has_result(msgs: &[Value]) -> bool {
    msgs.last().and_then(|m| m.get("content")).and_then(Value::as_array).is_some_and(|c| c.iter().any(|x| x.get("type").and_then(Value::as_str) == Some("tool_result")))
}

/// 寄件端這一輪要回什麼：看到橋接指令就叫它轉交佔位行給收件端（SendMessage 在延後載入的工具裡就先 ToolSearch）
fn sender_reply(st: &mut Shared, body: &Value) -> (Vec<Value>, &'static str) {
    let msgs: Vec<Value> = body.get("messages").and_then(Value::as_array).cloned().unwrap_or_default();
    let tools: Vec<Value> = body.get("tools").and_then(Value::as_array).cloned().unwrap_or_default();
    if !Value::Array(msgs.clone()).to_string().contains("BRIDGE-FORWARD") {
        return (vec![text_block("ok")], "end_turn");
    }
    if st.sent {
        return (vec![text_block("SENT")], "end_turn");
    }
    let send = json!({ "type": "tool_use", "id": "toolu_send1", "name": "SendMessage", "input": { "to": RECV_NAME, "message": forward_gate::placeholder_line(PROBE_ID), "summary": "forward" } });
    let find = |n: &str| tools.iter().find(|t| t.get("name").and_then(Value::as_str) == Some(n)).cloned();
    if let Some(sm) = find("SendMessage") {
        let loaded = sm.get("input_schema").is_some() && !sm.get("defer_loading").and_then(Value::as_bool).unwrap_or(false);
        if loaded && (!st.searched || has_result(&msgs)) {
            st.sent = true;
            return (vec![send], "tool_use");
        }
    }
    if !st.searched && find("ToolSearch").is_some() {
        st.searched = true;
        let ts = json!({ "type": "tool_use", "id": "toolu_search1", "name": "ToolSearch", "input": { "query": "select:SendMessage", "max_results": 5 } });
        return (vec![ts], "tool_use");
    }
    st.sent = true;
    (vec![send], "tool_use")
}

fn sse(blocks: &[Value], stop: &str) -> Vec<u8> {
    let mut ev: Vec<(&str, Value)> = vec![("message_start", json!({ "type": "message_start", "message": { "id": "msg_t", "type": "message", "role": "assistant", "model": "fake", "content": [], "stop_reason": null, "stop_sequence": null, "usage": { "input_tokens": 1, "output_tokens": 1 } } }))];
    for (i, b) in blocks.iter().enumerate() {
        if b.get("type").and_then(Value::as_str) == Some("text") {
            ev.push(("content_block_start", json!({ "type": "content_block_start", "index": i, "content_block": { "type": "text", "text": "" } })));
            ev.push(("content_block_delta", json!({ "type": "content_block_delta", "index": i, "delta": { "type": "text_delta", "text": b["text"] } })));
        } else {
            ev.push(("content_block_start", json!({ "type": "content_block_start", "index": i, "content_block": { "type": "tool_use", "id": b["id"], "name": b["name"], "input": {} } })));
            ev.push(("content_block_delta", json!({ "type": "content_block_delta", "index": i, "delta": { "type": "input_json_delta", "partial_json": b["input"].to_string() } })));
        }
        ev.push(("content_block_stop", json!({ "type": "content_block_stop", "index": i })));
    }
    ev.push(("message_delta", json!({ "type": "message_delta", "delta": { "stop_reason": stop, "stop_sequence": null }, "usage": { "output_tokens": 1 } })));
    ev.push(("message_stop", json!({ "type": "message_stop" })));
    ev.into_iter().map(|(n, d)| format!("event: {n}\ndata: {d}\n\n")).collect::<String>().into_bytes()
}

fn find_sub(h: &[u8], n: &[u8]) -> Option<usize> {
    h.windows(n.len()).position(|w| w == n)
}

/// 讀一個 HTTP 請求：（方法, 路徑, 內容）。支援 content-length 與 chunked
fn read_request(s: &mut TcpStream) -> Option<(String, String, Vec<u8>)> {
    s.set_read_timeout(Some(Duration::from_secs(15))).ok()?;
    let mut buf = Vec::new();
    let mut tmp = [0u8; 8192];
    let head_end = loop {
        let n = s.read(&mut tmp).ok()?;
        if n == 0 {
            return None;
        }
        buf.extend_from_slice(&tmp[..n]);
        if let Some(p) = find_sub(&buf, b"\r\n\r\n") {
            break p + 4;
        }
    };
    let head = String::from_utf8_lossy(&buf[..head_end]).to_string();
    let mut first = head.lines().next()?.split_whitespace();
    let (method, path) = (first.next()?.to_string(), first.next()?.to_string());
    let lower = head.to_ascii_lowercase();
    let mut body = buf[head_end..].to_vec();
    if lower.contains("transfer-encoding: chunked") {
        loop {
            if let Some(d) = decode_chunked(&body) {
                return Some((method, path, d));
            }
            let n = s.read(&mut tmp).ok()?;
            if n == 0 {
                return None;
            }
            body.extend_from_slice(&tmp[..n]);
        }
    }
    let cl: usize = lower.lines().find_map(|l| l.strip_prefix("content-length:").and_then(|v| v.trim().parse().ok())).unwrap_or(0);
    while body.len() < cl {
        let n = s.read(&mut tmp).ok()?;
        if n == 0 {
            return None;
        }
        body.extend_from_slice(&tmp[..n]);
    }
    Some((method, path, body))
}

/// chunked 內容完整收到才回 Some
fn decode_chunked(b: &[u8]) -> Option<Vec<u8>> {
    let (mut out, mut i) = (Vec::new(), 0usize);
    loop {
        let e = i + find_sub(&b[i..], b"\r\n")?;
        let size = usize::from_str_radix(std::str::from_utf8(&b[i..e]).ok()?.split(';').next()?.trim(), 16).ok()?;
        i = e + 2;
        if size == 0 {
            return Some(out);
        }
        if b.len() < i + size + 2 {
            return None;
        }
        out.extend_from_slice(&b[i..i + size]);
        i += size + 2;
    }
}

fn respond(s: &mut TcpStream, ctype: &str, data: &[u8]) {
    let head = format!("HTTP/1.1 200 OK\r\ncontent-type: {ctype}\r\ncontent-length: {}\r\nconnection: close\r\n\r\n", data.len());
    let _ = s.write_all(head.as_bytes());
    let _ = s.write_all(data);
    let _ = s.flush();
}

/// 收件端送給模型的訊息裡，含跨工作階段外框的文字
fn recv_frames(body: &Value) -> Vec<String> {
    let mut out = Vec::new();
    for m in body.get("messages").and_then(Value::as_array).into_iter().flatten() {
        let parts: Vec<String> = match m.get("content") {
            Some(Value::String(s)) => vec![s.clone()],
            Some(Value::Array(a)) => a.iter().filter_map(|x| x.get("text").and_then(Value::as_str).map(String::from)).collect(),
            _ => vec![],
        };
        out.extend(parts.into_iter().filter(|t| t.contains("<cross-session-message")));
    }
    out
}

fn handle(mut s: TcpStream, st: Arc<Mutex<Shared>>) {
    let Some((method, path, raw)) = read_request(&mut s) else { return };
    if method != "POST" {
        return respond(&mut s, "application/json", b"{}");
    }
    let body: Value = serde_json::from_slice(&raw).unwrap_or(Value::Null);
    let sender = path.starts_with("/sender");
    if !path.contains("/messages") || path.contains("count_tokens") {
        return respond(&mut s, "application/json", b"{\"input_tokens\":1}");
    }
    let (blocks, stop) = {
        let mut g = st.lock().unwrap();
        if sender {
            g.sender_requests += 1;
            sender_reply(&mut g, &body)
        } else {
            g.recv_requests += 1;
            if let Some(last) = recv_frames(&body).pop() {
                g.recv_texts.push(last);
            }
            (vec![text_block("ok")], "end_turn")
        }
    };
    if body.get("stream").and_then(Value::as_bool).unwrap_or(false) {
        respond(&mut s, "text/event-stream", &sse(&blocks, stop));
    } else {
        let d = json!({ "id": "msg_t", "type": "message", "role": "assistant", "model": "fake", "content": blocks, "stop_reason": stop, "stop_sequence": null, "usage": { "input_tokens": 1, "output_tokens": 1 } });
        respond(&mut s, "application/json", d.to_string().as_bytes());
    }
}

fn serve(l: TcpListener, st: Arc<Mutex<Shared>>, stop: Arc<AtomicBool>) {
    let _ = l.set_nonblocking(true);
    while !stop.load(Ordering::Relaxed) {
        match l.accept() {
            Ok((s, _)) => {
                let _ = s.set_nonblocking(false);
                let st2 = st.clone();
                std::thread::spawn(move || handle(s, st2));
            }
            Err(_) => std::thread::sleep(Duration::from_millis(20)),
        }
    }
}

// ───────── 起兩個隔離的 claude ─────────

/// 隔離環境：不帶任何 CLAUDE／ANTHROPIC 開頭與金鑰、權杖類的環境變數；模型指向本機假伺服器，設定資料夾獨立
fn child_env(cfg: &Path, port: u16, role: &str) -> Vec<(String, String)> {
    let mut e: Vec<(String, String)> = std::env::vars()
        .filter(|(k, _)| {
            let u = k.to_ascii_uppercase();
            !(u.starts_with("CLAUDE") || u.starts_with("ANTHROPIC") || ["KEY", "TOKEN", "SECRET", "PASSWORD"].iter().any(|w| u.contains(w)))
        })
        .collect();
    e.extend([
        ("CLAUDE_CONFIG_DIR".to_string(), cfg.display().to_string()),
        ("ANTHROPIC_BASE_URL".to_string(), format!("http://127.0.0.1:{port}/{role}")),
        ("ANTHROPIC_API_KEY".to_string(), "dummy-not-a-real-key".to_string()),
        ("CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC".to_string(), "1".to_string()),
        ("DISABLE_AUTOUPDATER".to_string(), "1".to_string()),
    ]);
    e
}

struct Proc {
    child: Child,
    stdin: Option<std::process::ChildStdin>,
}

fn spawn_claude(claude: &str, name: &str, settings: &Path, cfg: &Path, port: u16, role: &str, cwd: &Path) -> std::io::Result<Proc> {
    use crate::nowin::NoWindow;
    let mut child = Command::new(claude)
        .no_window()
        .args(["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--name", name, "--dangerously-skip-permissions", "--tools", "ListAgents,SendMessage,ToolSearch", "--system-prompt", "test", "--model", "haiku", "--strict-mcp-config", "--disable-slash-commands", "--settings"])
        .arg(settings)
        .env_clear()
        .envs(child_env(cfg, port, role))
        .current_dir(cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()?;
    // 輸出不看，但要讀掉，免得管線塞滿
    if let Some(mut o) = child.stdout.take() {
        std::thread::spawn(move || {
            let mut b = [0u8; 8192];
            while o.read(&mut b).is_ok_and(|n| n > 0) {}
        });
    }
    let stdin = child.stdin.take();
    Ok(Proc { child, stdin })
}

fn say(p: &mut Proc, text: &str) {
    if let Some(i) = p.stdin.as_mut() {
        let _ = i.write_all((json!({ "type": "user", "message": { "role": "user", "content": text } }).to_string() + "\n").as_bytes());
        let _ = i.flush();
    }
}

/// 只關自己開的程序（含它的子程序）
fn kill(p: &mut Proc) {
    drop(p.stdin.take());
    if p.child.try_wait().ok().flatten().is_some() {
        return;
    }
    #[cfg(windows)]
    {
        use crate::nowin::NoWindow;
        let _ = Command::new("taskkill").no_window().args(["/PID", &p.child.id().to_string(), "/T", "/F"]).output();
    }
    let _ = p.child.kill();
    let _ = p.child.wait();
}

fn wait_until(limit: Duration, mut f: impl FnMut() -> bool) -> bool {
    let end = Instant::now() + limit;
    while Instant::now() < end {
        if f() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(200));
    }
    f()
}

/// 跑一次自我測試。root＝橋的資料夾（在底下開暫時資料夾，跑完刪）；claude＝要測的 claude 指令。
/// wait＝寄件到收件端收到的最長等待。會阻塞，要放在背景執行緒。
pub fn probe(claude: &str, root: &Path, wait: Duration) -> Outcome {
    let d = root.join(format!("forward-selftest-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    let gate = d.join("gate");
    let (cfg, cwd_r, cwd_s) = (d.join("cfg"), d.join("cwd-recv"), d.join("cwd-send"));
    let r = probe_in(claude, &d, &gate, &cfg, &cwd_r, &cwd_s, wait);
    let _ = std::fs::remove_dir_all(&d);
    r
}

fn probe_in(claude: &str, d: &Path, gate: &Path, cfg: &Path, cwd_r: &Path, cwd_s: &Path, wait: Duration) -> Outcome {
    for p in [gate, cfg, cwd_r, cwd_s] {
        if let Err(e) = std::fs::create_dir_all(p) {
            return Outcome::Unrun(format!("建不了暫時資料夾：{e}"));
        }
    }
    let Some(gate_cmd) = super::worker::gate_command(gate) else {
        return Outcome::Unrun("找不到 asn-cli，沒有轉交核對的 hook 可測".into());
    };
    let ph = forward_gate::placeholder_line(PROBE_ID);
    let bodies = std::collections::HashMap::from([(PROBE_ID.to_string(), forward_gate::body_hash(PROBE_BODY))]);
    let items = [(PROBE_ID.to_string(), RECV_NAME.to_string(), Some(forward_gate::head_hash(forward_gate::first_line(&ph))))];
    if forward_gate::write_inflight_with(gate, &items, &bodies).is_err() || forward_gate::write_body(gate, PROBE_ID, PROBE_BODY).is_err() {
        return Outcome::Unrun("寫不了測試用的轉交紀錄".into());
    }
    let (send_set, recv_set) = (d.join("sender-settings.json"), d.join("recv-settings.json"));
    if std::fs::write(&send_set, super::worker::worker_settings(Some(&gate_cmd))).is_err() || std::fs::write(&recv_set, super::worker::worker_settings(None)).is_err() {
        return Outcome::Unrun("寫不了測試用的設定檔".into());
    }
    let Ok(listener) = TcpListener::bind("127.0.0.1:0") else {
        return Outcome::Unrun("開不了本機假伺服器".into());
    };
    let port = listener.local_addr().map(|a| a.port()).unwrap_or(0);
    let (st, stop) = (Arc::new(Mutex::new(Shared::default())), Arc::new(AtomicBool::new(false)));
    let srv = {
        let (s2, p2) = (st.clone(), stop.clone());
        std::thread::spawn(move || serve(listener, s2, p2))
    };
    let result = (|| {
        let mut recv = match spawn_claude(claude, RECV_NAME, &recv_set, cfg, port, "recv", cwd_r) {
            Ok(p) => p,
            Err(e) => return Outcome::Unrun(format!("起不了收件端 claude：{e}")),
        };
        say(&mut recv, "hello");
        // 收件端要先收過一則訊息、名字才找得到
        if !wait_until(Duration::from_secs(60), || st.lock().unwrap().recv_requests > 0) {
            kill(&mut recv);
            return Outcome::Unrun("收件端 claude 沒有連上假伺服器".into());
        }
        std::thread::sleep(Duration::from_secs(6));
        let mut send = match spawn_claude(claude, SEND_NAME, &send_set, cfg, port, "sender", cwd_s) {
            Ok(p) => p,
            Err(e) => {
                kill(&mut recv);
                return Outcome::Unrun(format!("起不了寄件端 claude：{e}"));
            }
        };
        std::thread::sleep(Duration::from_secs(5));
        say(&mut send, &super::worker::forward_text_exact("probe", PROBE_ID, RECV_NAME));
        wait_until(wait, || !st.lock().unwrap().recv_texts.is_empty());
        std::thread::sleep(Duration::from_secs(2));
        kill(&mut send);
        kill(&mut recv);
        let g = st.lock().unwrap();
        if g.sender_requests == 0 {
            return Outcome::Unrun("寄件端 claude 沒有連上假伺服器".into());
        }
        judge(&g.recv_texts, PROBE_BODY)
    })();
    stop.store(true, Ordering::Relaxed);
    let _ = srv.join();
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    fn framed(inner: &str) -> String {
        format!("<cross-session-message from=\"x\" ts=\"1\">\n{inner}\n</cross-session-message>")
    }

    #[test]
    fn 外框多的換行拿掉後逐字相同才算通過() {
        assert!(matches!(judge(&[framed(PROBE_BODY)], PROBE_BODY), Outcome::Passed(_)));
        // 少一個字元、多一個空白、換行被正規化，都不算
        assert!(matches!(judge(&[framed(&PROBE_BODY.replace("\r\n", "\n"))], PROBE_BODY), Outcome::Failed(_)));
        assert!(matches!(judge(&[framed(&PROBE_BODY.replace("尾端空白   ", "尾端空白"))], PROBE_BODY), Outcome::Failed(_)));
        assert!(matches!(judge(&[framed(&PROBE_BODY.replace('😀', "?"))], PROBE_BODY), Outcome::Failed(_)));
        assert!(matches!(judge(&[framed(&format!("{PROBE_BODY} "))], PROBE_BODY), Outcome::Failed(_)));
    }

    #[test]
    fn 收到佔位行代表_hook_改寫沒生效() {
        let t = framed(&forward_gate::placeholder_line(PROBE_ID));
        assert_eq!(judge(&[t], PROBE_BODY), Outcome::Failed("收件端收到的還是佔位行：hook 的改寫沒有生效".into()));
    }

    #[test]
    fn 什麼都沒收到是測不了_不是失敗也不是通過() {
        assert!(matches!(judge(&[], PROBE_BODY), Outcome::Unrun(_)));
        assert!(matches!(judge(&["沒有外框".into()], PROBE_BODY), Outcome::Failed(_)));
    }

    #[test]
    fn 取最後一則收到的訊息() {
        let old = framed("舊的");
        assert!(matches!(judge(&[old, framed(PROBE_BODY)], PROBE_BODY), Outcome::Passed(_)));
    }

    #[test]
    fn 通過紀錄存取_版本一換就不算() {
        let d = tempfile::tempdir().unwrap();
        assert_eq!(passed_version(d.path()), None);
        save_passed(d.path(), "2.1.318", 5).unwrap();
        assert_eq!(passed_version(d.path()).as_deref(), Some("2.1.318"));
        std::fs::write(d.path().join(SELFTEST_FILE), "壞掉").unwrap();
        assert_eq!(passed_version(d.path()), None);
    }

    #[test]
    fn 假寄件端_先找工具再轉交佔位行_只轉一次() {
        let mut st = Shared::default();
        let deferred = json!({ "tools": [{ "name": "ToolSearch", "input_schema": {} }, { "name": "SendMessage", "defer_loading": true }], "messages": [{ "role": "user", "content": "[BRIDGE-FORWARD nonce=n id=x to=y]" }] });
        let (b, stop) = sender_reply(&mut st, &deferred);
        assert_eq!((stop, b[0]["name"].as_str()), ("tool_use", Some("ToolSearch")));
        let loaded = json!({ "tools": [{ "name": "SendMessage", "input_schema": {} }], "messages": [{ "role": "user", "content": "[BRIDGE-FORWARD nonce=n id=x to=y]" }, { "role": "user", "content": [{ "type": "tool_result" }] }] });
        let (b, _) = sender_reply(&mut st, &loaded);
        assert_eq!(b[0]["name"], "SendMessage");
        assert_eq!(b[0]["input"]["to"], RECV_NAME);
        assert_eq!(b[0]["input"]["message"], forward_gate::placeholder_line(PROBE_ID));
        let (b, stop) = sender_reply(&mut st, &loaded);
        assert_eq!((stop, b[0]["text"].as_str()), ("end_turn", Some("SENT")));
        // 不是橋接指令的對話（暖機、標題）只回 ok
        let mut st2 = Shared::default();
        let (b, _) = sender_reply(&mut st2, &json!({ "messages": [{ "role": "user", "content": "hi" }] }));
        assert_eq!(b[0]["text"], "ok");
    }

    #[test]
    fn 事件串流格式() {
        let s = String::from_utf8(sse(&[text_block("好")], "end_turn")).unwrap();
        assert!(s.starts_with("event: message_start\n") && s.contains("text_delta") && s.ends_with("data: {\"type\":\"message_stop\"}\n\n"), "{s}");
        let t = String::from_utf8(sse(&[json!({ "type": "tool_use", "id": "a", "name": "N", "input": { "k": "v" } })], "tool_use")).unwrap();
        assert!(t.contains("input_json_delta") && t.contains("{\\\"k\\\":\\\"v\\\"}"), "{t}");
    }

    #[test]
    fn chunked_要完整才解出來() {
        assert_eq!(decode_chunked(b"5\r\nhello\r\n0\r\n\r\n").as_deref(), Some(&b"hello"[..]));
        assert_eq!(decode_chunked(b"5\r\nhel"), None);
    }

    #[test]
    fn 假伺服器收得到請求_收件端的跨工作階段外框被記下() {
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = l.local_addr().unwrap().port();
        let (st, stop) = (Arc::new(Mutex::new(Shared::default())), Arc::new(AtomicBool::new(false)));
        let (s2, p2) = (st.clone(), stop.clone());
        let h = std::thread::spawn(move || serve(l, s2, p2));
        let body = json!({ "stream": true, "messages": [{ "role": "user", "content": [{ "type": "text", "text": framed("內文") }] }] }).to_string();
        let mut c = TcpStream::connect(("127.0.0.1", port)).unwrap();
        c.write_all(format!("POST /recv/v1/messages HTTP/1.1\r\nhost: x\r\ncontent-length: {}\r\n\r\n{body}", body.len()).as_bytes()).unwrap();
        let mut out = String::new();
        c.read_to_string(&mut out).unwrap();
        assert!(out.starts_with("HTTP/1.1 200") && out.contains("text/event-stream"), "{out}");
        stop.store(true, Ordering::Relaxed);
        h.join().unwrap();
        let g = st.lock().unwrap();
        assert_eq!((g.recv_requests, g.recv_texts.len()), (1, 1));
        assert!(g.recv_texts[0].contains("內文"));
    }

    #[test]
    fn 隔離環境不帶金鑰也不帶_claude_變數() {
        let e = child_env(Path::new("C:/cfg"), 1234, "recv");
        assert!(e.iter().any(|(k, v)| k == "ANTHROPIC_BASE_URL" && v == "http://127.0.0.1:1234/recv"));
        assert!(e.iter().filter(|(k, _)| k.to_ascii_uppercase().starts_with("CLAUDE") || k.to_ascii_uppercase().starts_with("ANTHROPIC")).all(|(k, _)| ["CLAUDE_CONFIG_DIR", "ANTHROPIC_BASE_URL", "ANTHROPIC_API_KEY", "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC"].contains(&k.as_str())));
    }

    /// 真的跑一次：要有 claude 在 PATH、target/debug/asn-cli 在測試執行檔旁邊（和 e2e_real 一樣）。不花額度、不用登入
    #[test]
    #[ignore]
    fn 真的跑一次_自我測試通過() {
        let exe = std::env::current_exe().unwrap();
        let cli_src = exe.parent().unwrap().parent().unwrap().join(if cfg!(windows) { "asn-cli.exe" } else { "asn-cli" });
        assert!(cli_src.is_file(), "先執行 cargo build --bin asn-cli");
        let cli_dst = exe.parent().unwrap().join(cli_src.file_name().unwrap());
        std::fs::copy(&cli_src, &cli_dst).unwrap();
        let root = tempfile::tempdir().unwrap();
        let r = probe("claude", root.path(), Duration::from_secs(60));
        let _ = std::fs::remove_file(&cli_dst);
        eprintln!("自我測試結果：{r:?}");
        assert!(matches!(r, Outcome::Passed(_)), "{r:?}");
    }
}

//! 手機遠端確認終端送字／代答（#285）：桌面建立請求、輪詢領取、執行前重驗、回報結果。
//! 與本機確認（`term_send`／`term_answer`）共用唯一執行入口；誰先確認誰執行，另一邊作廢。
use crate::launch::term::TermOption;
use crate::launch::wezterm::{RealFs, RealRunner};
use crate::launch::term::TermService;

type LiveTerms = TermService<RealRunner, RealFs>;
use crate::relay::Relay;
use serde::Serialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

pub const REQ_TTL: Duration = Duration::from_secs(120);
const LOG_MAX_BYTES: u64 = 200 * 1024;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Kind {
    Send,
    Answer,
}

#[derive(Clone, Debug)]
struct Payload {
    term_id: String,
    kind: Kind,
    text: String,
    enter: bool,
    prompt_kind: String,
    prompt_text: String,
    options: Vec<TermOption>,
    hash: String,
}

#[derive(Clone, Debug)]
struct Outgoing {
    payload: Payload,
    created: Instant,
    remote_id: Option<String>,
}

static OUT: Mutex<Option<HashMap<String, Outgoing>>> = Mutex::new(None);
static BY_TERM: Mutex<Option<HashMap<String, String>>> = Mutex::new(None);

fn with_out<T>(f: impl FnOnce(&mut HashMap<String, Outgoing>) -> T) -> T {
    let mut g = OUT.lock().unwrap_or_else(|e| e.into_inner());
    let m = g.get_or_insert_with(HashMap::new);
    m.retain(|_, o| o.created.elapsed() < REQ_TTL);
    let r = f(m);
    let ids: Vec<String> = m.keys().cloned().collect();
    drop(g);
    if let Some(b) = BY_TERM.lock().unwrap_or_else(|e| e.into_inner()).as_mut() {
        b.retain(|_, id| ids.contains(id));
    }
    r
}

fn is_uuid(s: &str) -> bool {
    let p: Vec<&str> = s.split('-').collect();
    p.len() == 5 && p.iter().zip([8_usize, 4, 4, 4, 12]).all(|(x, n)| x.len() == n && x.chars().all(|c| c.is_ascii_hexdigit()))
}

pub fn hash_hex(s: &str) -> String {
    let mut h = Sha256::new();
    h.update(s.as_bytes());
    format!("{:x}", h.finalize())
}

pub fn hash_send(text: &str, enter: bool) -> String {
    hash_hex(&json!({ "kind": "send", "text": text, "enter": enter }).to_string())
}

pub fn hash_answer(prompt_kind: &str, prompt_text: &str, options: &[TermOption]) -> String {
    let opts: Vec<Value> = options.iter().map(|o| json!({ "n": o.n, "label": o.label })).collect();
    hash_hex(
        &json!({ "kind": "answer", "prompt_kind": prompt_kind, "prompt_text": prompt_text, "options": opts }).to_string(),
    )
}

pub fn preview_text(raw: &str) -> String {
    use crate::launch::wezterm::flatten_line;
    let flat = flatten_line(raw);
    let mut out = String::new();
    let mut chars = flat.chars().peekable();
    while out.chars().count() < 200 {
        match chars.next() {
            None => break,
            Some('\u{1b}') => {
                while let Some(&c) = chars.peek() {
                    chars.next();
                    if c.is_ascii_alphabetic() {
                        break;
                    }
                }
            }
            Some(c) if c.is_control() => {}
            Some(c) => out.push(c),
        }
    }
    out
}

pub fn preview_prompt(text: &str) -> String {
    preview_text(text)
}

pub fn folder_label(cwd: &str) -> String {
    let t = cwd.trim().replace('\\', "/");
    let seg = t.rsplit('/').next().unwrap_or("").trim();
    let clean: String = seg.chars().filter(|c| !c.is_control()).take(60).collect();
    if clean.is_empty() {
        "（未知資料夾）".into()
    } else {
        clean
    }
}

fn log_path(data_dir: &Path) -> PathBuf {
    data_dir.join("term-remote.log")
}

pub fn log_event(data_dir: &Path, event: &str, id: &str, hash: &str, len: usize, detail: &str) {
    use std::io::Write;
    let line = format!(
        "{}\t{}\t{}\thash={}\tlen={}\t{}\n",
        crate::heartbeat::now_ms(),
        event,
        id,
        hash,
        len,
        detail.replace(['\n', '\r', '\t'], " ")
    );
    let p = log_path(data_dir);
    if std::fs::metadata(&p).map(|m| m.len() > LOG_MAX_BYTES).unwrap_or(false) {
        if let Ok(t) = std::fs::read_to_string(&p) {
            let keep = t.get(t.len() / 2..).unwrap_or("");
            let keep = keep.find('\n').map(|i| &keep[i + 1..]).unwrap_or("");
            let _ = std::fs::write(&p, keep);
        }
    }
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&p) {
        let _ = f.write_all(line.as_bytes());
    }
}

fn options_json(options: &[TermOption]) -> Value {
    Value::Array(options.iter().map(|o| json!({ "n": o.n, "label": o.label })).collect())
}

pub fn adopt_write_allowed(terms: &LiveTerms, term_id: &str, kind: Kind) -> Result<(), String> {
    let listed = terms.list().into_iter().find(|t| t.id == term_id).ok_or_else(|| "沒有這個終端".to_string())?;
    if !listed.adopted {
        return Ok(());
    }
    match kind {
        Kind::Send if !listed.send_unlocked => Err("這個接手窗格還沒在本機開啟「允許代送文字」，不建立遠端請求".into()),
        Kind::Answer if !listed.answer_unlocked => Err("這個接手窗格還沒在本機開啟「允許代答提問」，不建立遠端請求".into()),
        _ => Ok(()),
    }
}

fn register_local(key: &str, outgoing: Outgoing) -> Result<(), String> {
    with_out(|m| {
        if m.contains_key(key) {
            return Err("這個終端還有一筆確認進行中".into());
        }
        let term_id = outgoing.payload.term_id.clone();
        let mut bt = BY_TERM.lock().unwrap_or_else(|e| e.into_inner());
        let bm = bt.get_or_insert_with(HashMap::new);
        if bm.contains_key(&term_id) {
            return Err("這個終端還有一筆確認進行中".into());
        }
        bm.insert(term_id, key.to_string());
        m.insert(key.to_string(), outgoing);
        Ok(())
    })
}

fn take_local(key: &str) -> Option<Outgoing> {
    let o = with_out(|m| m.remove(key))?;
    if let Some(b) = BY_TERM.lock().unwrap_or_else(|e| e.into_inner()).as_mut() {
        b.retain(|_, id| id != key);
    }
    Some(o)
}

fn local_by_term(term_id: &str) -> Option<String> {
    BY_TERM.lock().unwrap_or_else(|e| e.into_inner()).as_ref()?.get(term_id).cloned()
}

fn cancel_local_for_term(term_id: &str) -> Option<(String, Outgoing)> {
    let id = local_by_term(term_id)?;
    take_local(&id).map(|o| (id, o))
}

fn find_by_remote(remote_id: &str) -> Option<(String, Outgoing)> {
    with_out(|m| {
        m.iter()
            .find(|(_, o)| o.remote_id.as_deref() == Some(remote_id))
            .map(|(k, o)| (k.clone(), o.clone()))
    })
}

pub async fn api_create(relay: &Relay, body: Value) -> Result<Value, String> {
    relay.api("term_req_create", Some(body)).await
}

pub async fn api_take(relay: &Relay) -> Result<Value, String> {
    relay.api("term_req_take", Some(json!({}))).await
}

pub async fn api_result(relay: &Relay, id: &str, status: &str, detail: &str) -> Result<(), String> {
    relay
        .api("term_req_result", Some(json!({ "id": id, "status": status, "detail": detail })))
        .await
        .map(|_| ())
}

/// 本機取消（按「返回」、關掉送字框、換終端）：撤回這個終端還在等手機確認的請求，後台標成已取消，之後手機按確認也不會送。
pub async fn withdraw(relay: &Relay, data_dir: &Path, term_id: &str) {
    // 只撤「送字」那筆；同一終端若是代答在等手機確認，不動它
    let is_send = local_by_term(term_id).and_then(|k| with_out(|m| m.get(&k).map(|o| o.payload.kind == Kind::Send))).unwrap_or(false);
    if !is_send {
        return;
    }
    if let Some((_, o)) = cancel_local_for_term(term_id) {
        if let Some(rid) = o.remote_id.as_deref() {
            let _ = api_result(relay, rid, "cancelled", "本機已取消").await;
            log_event(data_dir, "cancelled", rid, &o.payload.hash, o.payload.text.len(), "local_withdraw");
        }
    }
}

pub async fn offer_send(relay: &Relay, terms: &LiveTerms, data_dir: &Path, term_id: &str, text: &str, enter: bool) -> Result<String, String> {
    adopt_write_allowed(terms, term_id, Kind::Send)?;
    let hash = hash_send(text, enter);
    if let Some(key) = local_by_term(term_id) {
        let (is_send, same) = with_out(|m| m.get(&key).map(|o| (o.payload.kind == Kind::Send, o.payload.hash == hash))).unwrap_or((false, false));
        if !is_send {
            return Err("這個終端還有一筆確認進行中".into());
        }
        if same {
            return Ok(term_id.to_string());
        }
        // 內容變了：手機上那筆是舊字，先撤回再建新的
        withdraw(relay, data_dir, term_id).await;
    }
    let listed = terms.list().into_iter().find(|t| t.id == term_id).ok_or_else(|| "沒有這個終端".to_string())?;
    let preview = preview_text(text);
    if preview.trim().is_empty() {
        return Err("沒有可送出的內容".into());
    }
    let key = term_id.to_string();
    let outgoing = Outgoing {
        payload: Payload {
            term_id: term_id.to_string(),
            kind: Kind::Send,
            text: text.to_string(),
            enter,
            prompt_kind: String::new(),
            prompt_text: String::new(),
            options: vec![],
            hash: hash.clone(),
        },
        created: Instant::now(),
        remote_id: None,
    };
    register_local(&key, outgoing)?;
    let body = json!({
        "kind": "send",
        "term_id": term_id,
        "folder_label": folder_label(&listed.cwd),
        "preview": preview,
        "enter": enter,
        "hash": hash,
    });
    match api_create(relay, body).await {
        Ok(v) => {
            let rid = v.get("id").and_then(Value::as_str).filter(|s| is_uuid(s)).ok_or_else(|| "後端沒回請求編號".to_string())?;
            with_out(|m| {
                if let Some(o) = m.get_mut(&key) {
                    o.remote_id = Some(rid.to_string());
                }
            });
            log_event(data_dir, "create_send", rid, &hash, text.len(), term_id);
            Ok(key)
        }
        Err(e) => {
            let _ = take_local(&key);
            Err(e)
        }
    }
}

pub async fn offer_answer(
    relay: &Relay,
    terms: &LiveTerms,
    data_dir: &Path,
    term_id: &str,
    prompt_kind: &str,
    prompt_text: &str,
    options: &[TermOption],
) -> Result<String, String> {
    adopt_write_allowed(terms, term_id, Kind::Answer)?;
    if options.is_empty() {
        return Err("沒有可選的項目".into());
    }
    let key = format!("{term_id}:{prompt_kind}");
    if local_by_term(term_id).is_some() {
        return Ok(key);
    }
    let listed = terms.list().into_iter().find(|t| t.id == term_id).ok_or_else(|| "沒有這個終端".to_string())?;
    let preview = preview_prompt(prompt_text);
    let hash = hash_answer(prompt_kind, prompt_text, options);
    let outgoing = Outgoing {
        payload: Payload {
            term_id: term_id.to_string(),
            kind: Kind::Answer,
            text: String::new(),
            enter: false,
            prompt_kind: prompt_kind.to_string(),
            prompt_text: prompt_text.to_string(),
            options: options.to_vec(),
            hash: hash.clone(),
        },
        created: Instant::now(),
        remote_id: None,
    };
    register_local(&key, outgoing)?;
    let body = json!({
        "kind": "answer",
        "term_id": term_id,
        "folder_label": folder_label(&listed.cwd),
        "preview": preview,
        "enter": false,
        "options": options_json(options),
        "hash": hash,
    });
    match api_create(relay, body).await {
        Ok(v) => {
            let rid = v.get("id").and_then(Value::as_str).filter(|s| is_uuid(s)).ok_or_else(|| "後端沒回請求編號".to_string())?;
            with_out(|m| {
                if let Some(o) = m.get_mut(&key) {
                    o.remote_id = Some(rid.to_string());
                }
            });
            log_event(data_dir, "create_answer", rid, &hash, prompt_text.len(), term_id);
            Ok(key)
        }
        Err(e) => {
            let _ = take_local(&key);
            Err(e)
        }
    }
}

fn execute_send(terms: &LiveTerms, p: &Payload) -> Result<(), String> {
    terms.confirm_send(&p.term_id, &p.text, p.enter)
}

fn execute_answer(terms: &LiveTerms, p: &Payload, choice_n: u32) -> Result<(), String> {
    let _ = terms.answer(&p.term_id, &p.prompt_kind, choice_n)?;
    Ok(())
}

fn revalidate_hash(p: &Payload, body_hash: &str) -> Result<(), String> {
    if p.hash != body_hash {
        return Err("內容雜湊不符".into());
    }
    Ok(())
}

#[cfg(feature = "gui")]
pub async fn local_confirm_send(relay: &Relay, terms: &LiveTerms, data_dir: &Path, req: &crate::launch::term::TermSendReq) -> Result<(), String> {
    let outgoing = cancel_local_for_term(&req.id);
    if let Some((_, o)) = &outgoing {
        if let Some(rid) = &o.remote_id {
            let _ = api_result(relay, rid, "cancelled", "本機已確認").await;
            log_event(data_dir, "cancelled", rid, &hash_send(&req.text, req.enter), req.text.len(), "local_send");
        }
        revalidate_hash(&o.payload, &hash_send(&req.text, req.enter))?;
    }
    execute_send(
        terms,
        &Payload {
            term_id: req.id.clone(),
            kind: Kind::Send,
            text: req.text.clone(),
            enter: req.enter,
            prompt_kind: String::new(),
            prompt_text: String::new(),
            options: vec![],
            hash: hash_send(&req.text, req.enter),
        },
    )
}

#[cfg(feature = "gui")]
pub async fn local_confirm_answer(
    relay: &Relay,
    terms: &LiveTerms,
    data_dir: &Path,
    req: &crate::launch::term::TermAnswerReq,
    prompt_text: &str,
    options: &[TermOption],
) -> Result<crate::launch::term::TermAnswered, String> {
    let key = format!("{}:{}", req.id, req.prompt_kind);
    let outgoing = take_local(&key).or_else(|| cancel_local_for_term(&req.id).map(|(_, o)| o));
    if let Some(o) = &outgoing {
        if let Some(rid) = &o.remote_id {
            let h = hash_answer(&req.prompt_kind, prompt_text, options);
            let _ = api_result(relay, rid, "cancelled", "本機已確認").await;
            log_event(data_dir, "cancelled", rid, &h, prompt_text.len(), "local_answer");
        }
        revalidate_hash(&o.payload, &hash_answer(&req.prompt_kind, prompt_text, options))?;
    }
    terms.answer(&req.id, &req.prompt_kind, req.n)
}

async fn fail_and_result(relay: &Relay, data_dir: &Path, id: &str, detail: &str) {
    let _ = api_result(relay, id, "failed", detail).await;
    log_event(data_dir, "failed", id, "-", 0, detail);
}

async fn execute_taken(relay: &Relay, terms: &LiveTerms, data_dir: &Path, row: &Value) {
    let Some(id) = row.get("id").and_then(Value::as_str) else { return };
    let Some(term_id) = row.get("term_id").and_then(Value::as_str) else { return };
    let Some(body_hash) = row.get("body_hash").and_then(Value::as_str) else { return };
    let Some(kind) = row.get("kind").and_then(Value::as_str) else { return };
    let choice_n = row.get("choice_n").and_then(Value::as_u64).map(|n| n as u32);

    let Some((local_key, o)) = find_by_remote(id) else {
        fail_and_result(relay, data_dir, id, "找不到本機請求（可能已逾時或本機已確認）").await;
        return;
    };
    if o.payload.term_id != term_id {
        fail_and_result(relay, data_dir, id, "終端編號不符").await;
        return;
    }
    if revalidate_hash(&o.payload, body_hash).is_err() {
        fail_and_result(relay, data_dir, id, "內容雜湊不符").await;
        let _ = take_local(&local_key);
        return;
    }

    let exec = match kind {
        "send" => execute_send(terms, &o.payload),
        "answer" => match choice_n {
            Some(n) => execute_answer(terms, &o.payload, n),
            None => Err("代答缺少選項編號".into()),
        },
        _ => Err("不認得的請求種類".into()),
    };

    let _ = take_local(&local_key);
    match exec {
        Ok(()) => {
            let _ = api_result(relay, id, "done", "").await;
            log_event(
                data_dir,
                "done",
                id,
                body_hash,
                o.payload.text.len().max(o.payload.prompt_text.len()),
                term_id,
            );
        }
        Err(e) => fail_and_result(relay, data_dir, id, &e).await,
    }
}

async fn handle_closed(data_dir: &Path, row: &Value) {
    let Some(id) = row.get("id").and_then(Value::as_str) else { return };
    let status = row.get("status").and_then(Value::as_str).unwrap_or("");
    with_out(|m| {
        m.retain(|_, o| o.remote_id.as_deref() != Some(id));
    });
    log_event(data_dir, "closed", id, "-", 0, status);
}

pub async fn poll_once(relay: &Relay, terms: &LiveTerms, data_dir: &Path) {
    let Ok(v) = api_take(relay).await else { return };
    for row in v.get("closed").and_then(Value::as_array).cloned().unwrap_or_default() {
        handle_closed(data_dir, &row).await;
    }
    for row in v.get("requests").and_then(Value::as_array).cloned().unwrap_or_default() {
        execute_taken(relay, terms, data_dir, &row).await;
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingView {
    pub id: String,
    pub term_id: String,
    pub kind: String,
    pub preview: String,
    pub enter: bool,
    pub expires_in_ms: u64,
}

pub fn pending_views() -> Vec<PendingView> {
    with_out(|m| {
        m.iter()
            .map(|(k, o)| {
                let left = REQ_TTL.saturating_sub(o.created.elapsed()).as_millis() as u64;
                PendingView {
                    id: o.remote_id.clone().unwrap_or_else(|| k.clone()),
                    term_id: o.payload.term_id.clone(),
                    kind: match o.payload.kind {
                        Kind::Send => "send".into(),
                        Kind::Answer => "answer".into(),
                    },
                    preview: if o.payload.kind == Kind::Send {
                        preview_text(&o.payload.text)
                    } else {
                        preview_prompt(&o.payload.prompt_text)
                    },
                    enter: o.payload.enter,
                    expires_in_ms: left,
                }
            })
            .collect()
    })
}

pub const POLL_INTERVAL_SECS: u64 = 2;

#[cfg(test)]
pub fn reset_for_test() {
    *OUT.lock().unwrap() = None;
    *BY_TERM.lock().unwrap() = None;
}

#[cfg(test)]
pub fn register_fake_answer(term_id: &str, remote_id: &str) {
    let _ = register_local(
        term_id,
        Outgoing {
            payload: Payload {
                term_id: term_id.to_string(),
                kind: Kind::Answer,
                text: String::new(),
                enter: false,
                prompt_kind: "trust".into(),
                prompt_text: "信任此資料夾？".into(),
                options: vec![],
                hash: "a".repeat(64),
            },
            created: Instant::now(),
            remote_id: Some(remote_id.to_string()),
        },
    );
}

#[cfg(test)]
pub fn register_fake_outgoing(term_id: &str, remote_id: &str, text: &str, enter: bool) {
    let hash = hash_send(text, enter);
    let _ = register_local(
        term_id,
        Outgoing {
            payload: Payload {
                term_id: term_id.to_string(),
                kind: Kind::Send,
                text: text.to_string(),
                enter,
                prompt_kind: String::new(),
                prompt_text: String::new(),
                options: vec![],
                hash,
            },
            created: Instant::now(),
            remote_id: Some(remote_id.to_string()),
        },
    );
}

#[cfg(test)]
pub fn seed_expired_outgoing() {
    let _ = register_local(
        "expired",
        Outgoing {
            payload: Payload {
                term_id: "9".to_string(),
                kind: Kind::Send,
                text: "x".into(),
                enter: false,
                prompt_kind: String::new(),
                prompt_text: String::new(),
                options: vec![],
                hash: hash_send("x", false),
            },
            created: Instant::now() - REQ_TTL - Duration::from_secs(1),
            remote_id: Some("11111111-1111-1111-1111-111111111111".into()),
        },
    );
}

#[cfg(test)]
#[path = "term_remote/tests.rs"]
mod tests;

//! 遠端切換 Claude 帳號（經收發室的「切換帳號」指令）。
//!
//! 流程（權杖只在各自那台電腦搬，絕不進收發室）：
//! 1. 每台 ASN 定期回報自己帳號庫的清單：只有 email、方案、是否使用中（`acct_report`）。
//! 2. 發起端（擁有者設備）列出對方清單（`acct_list`）、選一個 email 送出（`acct_switch`）；
//!    後端只收擁有者節點、同租戶、且 email 在對方最近一次回報的清單裡。
//! 3. 對方 ASN 取走自己的待辦（`acct_switch_pending`）→ 預設跳出確認、使用者按了才在本機搬檔
//!    （設定可改成「信任我自己的設備，不用確認」）→ 把結果（成功／失敗原因）回報（`acct_switch_result`）。
//! 4. 發起端用 `acct_switch_status` 查結果。
//!
//! 指令只帶目標帳號的 email；本機只接受「自己剛從收發室取走、尚未處理」的指令編號，
//! 所以介面端無法憑空要求切換，每個編號只能處理一次。
use crate::claude_accounts::{self, AccountInfo};
use crate::codex_accounts::CodexLogin;
use crate::relay::Relay;
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::Path;
use std::sync::Mutex;
use std::time::{Duration, Instant};

const ENTRY_TTL: Duration = Duration::from_secs(15 * 60);

/// 待處理的遠端指令：編號 → (email, 取走時間)。只有 `acct_remote_pending` 會放進來。
static TAKEN: Mutex<Option<HashMap<String, (String, Instant)>>> = Mutex::new(None);

fn is_uuid(s: &str) -> bool {
    let p: Vec<&str> = s.split('-').collect();
    p.len() == 5 && p.iter().zip([8, 4, 4, 4, 12]).all(|(x, n)| x.len() == n && x.chars().all(|c| c.is_ascii_hexdigit()))
}
pub fn valid_node(s: &str) -> bool {
    (1..=32).contains(&s.len()) && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

/// 回報的內容：只有廠商、email、方案、是否使用中。
/// Codex 只放「目前登入」那一個（用 ChatGPT 帳號登入且有 email 才放；API 金鑰模式沒有帳號可顯示就不放）；
/// 權杖、金鑰、帳號編號一律不碰：`CodexLogin` 本身就只有 email／方案／登入方式三個欄位。
pub fn build_report(list: &[AccountInfo], codex: Option<&CodexLogin>) -> Value {
    let mut rows: Vec<Value> = list.iter().take(19).map(|a| json!({ "vendor": "claude", "email": a.email, "plan": a.plan, "current": a.current })).collect();
    if let Some(c) = codex.filter(|c| c.mode == "chatgpt") {
        if let Some(email) = claude_accounts::normalize_email(&c.email) {
            let plan: String = c.plan.chars().filter(|ch| !ch.is_control()).take(30).collect();
            rows.push(json!({ "vendor": "codex", "email": email, "plan": plan, "current": true }));
        }
    }
    json!({ "accounts": rows })
}

/// 設定：remote_trust_own＝信任自己的設備，不用本機確認（預設 false）
pub fn prefs_path(data_dir: &Path) -> std::path::PathBuf {
    data_dir.join("acct-prefs.json")
}
pub fn trust_own(data_dir: &Path) -> bool {
    std::fs::read_to_string(prefs_path(data_dir)).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok()).and_then(|v| v.get("remote_trust_own").and_then(Value::as_bool)).unwrap_or(false)
}
pub fn set_trust_own(data_dir: &Path, on: bool) -> Result<(), String> {
    crate::write_atomic(&prefs_path(data_dir), &json!({ "remote_trust_own": on }).to_string()).map_err(|e| e.to_string())
}

/// 對方送來的待辦一列：編號、email、發起端節點。格式不對回錯誤原因。
#[derive(Serialize, Debug, PartialEq, Clone)]
pub struct Pending {
    pub id: String,
    pub email: String,
    pub requested_by: String,
    pub needs_confirm: bool,
}
pub fn parse_pending(row: &Value) -> Result<(String, String, String), String> {
    let id = row.get("id").and_then(Value::as_str).filter(|s| is_uuid(s)).ok_or("指令編號不對")?;
    let by = row.get("requested_by").and_then(Value::as_str).filter(|s| valid_node(s)).ok_or("發起端不對")?;
    if row.get("vendor").and_then(Value::as_str) != Some("claude") {
        return Err("目前只支援切換 Claude 帳號".into());
    }
    let email = row.get("email").and_then(Value::as_str).and_then(claude_accounts::normalize_email).ok_or("email 格式不對")?;
    Ok((id.to_string(), email, by.to_string()))
}

fn with_taken<T>(f: impl FnOnce(&mut HashMap<String, (String, Instant)>) -> T) -> T {
    let mut g = TAKEN.lock().unwrap_or_else(|e| e.into_inner());
    let m = g.get_or_insert_with(HashMap::new);
    m.retain(|_, (_, t)| t.elapsed() < ENTRY_TTL);
    f(m)
}

/// 決定一筆指令：取出（每個編號只處理一次）→ 沒確認就拒絕 → 在本機切換。回傳（結果狀態, 說明）；沒有這個編號回 None。
/// `switch` 由呼叫端注入（正式是 `claude_accounts::local_switch`），測試用假的。
pub fn decide(taken: &mut HashMap<String, (String, Instant)>, id: &str, allowed: bool, switch: impl FnOnce(&str) -> Result<String, String>) -> Option<(&'static str, String)> {
    let (email, _) = taken.remove(id)?;
    if !allowed {
        return Some(("denied", "對方電腦上的使用者沒有同意".into()));
    }
    Some(match switch(&email) {
        Ok(notice) => ("ok", notice),
        Err(e) => ("failed", e),
    })
}

// ---------- 送給收發室的動作 ----------
pub async fn report(relay: &Relay, list: &[AccountInfo], codex: Option<&CodexLogin>) -> Result<Value, String> {
    let full = build_report(list, codex);
    let has_codex = full["accounts"].as_array().is_some_and(|a| a.iter().any(|r| r["vendor"] == "codex"));
    match relay.api("acct_report", Some(full)).await {
        // 舊後台只認 claude，看到 codex 會整份退回：退一步只回報 Claude，不讓原本的回報壞掉
        Err(_) if has_codex => relay.api("acct_report", Some(build_report(list, None))).await,
        r => r,
    }
}
pub async fn remote_list(relay: &Relay, node: &str) -> Result<Value, String> {
    if !valid_node(node) {
        return Err("設備代號不對".into());
    }
    relay.api("acct_list", Some(json!({ "node": node }))).await
}
pub async fn remote_request(relay: &Relay, node: &str, email: &str) -> Result<Value, String> {
    if !valid_node(node) {
        return Err("設備代號不對".into());
    }
    let email = claude_accounts::normalize_email(email).ok_or("email 格式不對")?;
    relay.api("acct_switch", Some(json!({ "node": node, "vendor": "claude", "email": email }))).await
}
pub async fn remote_status(relay: &Relay, ids: Vec<String>) -> Result<Value, String> {
    if ids.is_empty() || ids.len() > 20 || !ids.iter().all(|i| is_uuid(i)) {
        return Err("指令編號不對".into());
    }
    relay.api("acct_switch_status", Some(json!({ "ids": ids }))).await
}

async fn send_result(relay: &Relay, id: &str, status: &str, detail: &str) {
    let d: String = detail.chars().filter(|c| !c.is_control()).take(300).collect();
    if let Err(e) = relay.api("acct_switch_result", Some(json!({ "id": id, "status": status, "detail": d }))).await {
        eprintln!("acct_switch_result failed: {e}");
    }
}

/// 取走自己的待辦。格式不對的當場回報失敗；合格的記進 TAKEN（之後只能憑編號處理）。
pub async fn pending(relay: &Relay, data_dir: &Path) -> Result<Vec<Pending>, String> {
    let v = relay.api("acct_switch_pending", Some(json!({}))).await?;
    let needs_confirm = !trust_own(data_dir);
    let mut out = vec![];
    for row in v.get("requests").and_then(Value::as_array).cloned().unwrap_or_default() {
        match parse_pending(&row) {
            Ok((id, email, by)) => {
                with_taken(|m| m.insert(id.clone(), (email.clone(), Instant::now())));
                out.push(Pending { id, email, requested_by: by, needs_confirm });
            }
            Err(why) => {
                if let Some(id) = row.get("id").and_then(Value::as_str).filter(|s| is_uuid(s)) {
                    send_result(relay, id, "failed", &why).await;
                }
            }
        }
    }
    Ok(out)
}

/// 使用者按了確認（或設定為信任自己的設備）：在本機切換並回報結果
pub async fn apply(relay: &Relay, data_dir: &Path, id: String, confirmed: bool) -> Result<Value, String> {
    apply_with(relay, data_dir, id, confirmed, |e| claude_accounts::local_switch(e).map(|o| o.notice)).await
}

/// `switch` 由呼叫端注入：正式是本機切換，測試指到暫存家目錄
pub async fn apply_with(relay: &Relay, data_dir: &Path, id: String, confirmed: bool, switch: impl FnOnce(&str) -> Result<String, String> + Send + 'static) -> Result<Value, String> {
    let allowed = confirmed || trust_own(data_dir);
    let res = {
        let id2 = id.clone();
        tokio::task::spawn_blocking(move || with_taken(|m| decide(m, &id2, allowed, switch))).await.map_err(|e| format!("背景工作失敗：{e}"))?
    };
    let Some((status, detail)) = res else { return Err("找不到這個指令（已處理過或已過期）".into()) };
    send_result(relay, &id, status, &detail).await;
    if status == "ok" {
        Ok(json!({ "status": status, "detail": detail }))
    } else {
        Err(detail)
    }
}

/// 使用者按了拒絕
pub async fn decline(relay: &Relay, id: String) -> Result<(), String> {
    let removed = with_taken(|m| m.remove(&id).is_some());
    if removed {
        send_result(relay, &id, "denied", "對方電腦上的使用者沒有同意").await;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const U: &str = "11111111-2222-3333-4444-555555555555";

    fn acct(email: &str, current: bool) -> AccountInfo {
        AccountInfo { email: email.into(), plan: "max".into(), org: "ORG-SECRET".into(), current, saved: true }
    }

    #[test]
    fn 回報只有廠商_email_方案_使用中() {
        let v = build_report(&[acct("a@x.test", true), acct("b@x.test", false)], None);
        assert_eq!(v, json!({ "accounts": [
            { "vendor": "claude", "email": "a@x.test", "plan": "max", "current": true },
            { "vendor": "claude", "email": "b@x.test", "plan": "max", "current": false },
        ] }));
        assert!(!v.to_string().contains("ORG-SECRET"), "組織名稱不外送");
    }

    fn codex(email: &str, plan: &str, mode: &str) -> CodexLogin {
        CodexLogin { email: email.into(), plan: plan.into(), mode: mode.into() }
    }

    #[test]
    fn 回報帶_codex_目前登入_且不含任何憑證類欄位() {
        let v = build_report(&[acct("a@x.test", true)], Some(&codex(" C@X.test ", "plus", "chatgpt")));
        assert_eq!(v["accounts"][1], json!({ "vendor": "codex", "email": "c@x.test", "plan": "plus", "current": true }));
        // 守門：每一列的鍵只准是這四個；整份內容不出現 token／key／secret 類字樣
        for r in v["accounts"].as_array().unwrap() {
            let mut keys: Vec<&String> = r.as_object().unwrap().keys().collect();
            keys.sort();
            assert_eq!(keys, ["current", "email", "plan", "vendor"]);
        }
        let low = v.to_string().to_lowercase();
        for bad in ["token", "secret", "api_key", "apikey", "password", "refresh", "account_id", "mode"] {
            assert!(!low.contains(bad), "回報不該含 {bad}");
        }
    }

    #[test]
    fn codex_沒登入_或_api_金鑰模式_或_email_壞掉_就不放() {
        let base = build_report(&[acct("a@x.test", true)], None);
        assert_eq!(base["accounts"].as_array().unwrap().len(), 1);
        for c in [codex("", "", "api_key"), codex("c@x.test", "plus", "api_key"), codex("", "", "chatgpt"), codex("壞", "", "chatgpt")] {
            assert_eq!(build_report(&[acct("a@x.test", true)], Some(&c)), base);
        }
    }

    #[test]
    fn 合計不超過_20_筆_且_codex_方案字串被清乾淨() {
        let many: Vec<AccountInfo> = (0..25).map(|i| acct(&format!("u{i}@x.test"), i == 0)).collect();
        let v = build_report(&many, Some(&codex("c@x.test", &format!("p\nl{}", "x".repeat(40)), "chatgpt")));
        let rows = v["accounts"].as_array().unwrap();
        assert_eq!(rows.len(), 20);
        assert_eq!(rows[19]["vendor"], "codex");
        let plan = rows[19]["plan"].as_str().unwrap();
        assert!(plan.chars().count() <= 30 && !plan.contains('\n'));
    }

    #[test]
    fn 待辦格式檢查() {
        let ok = json!({ "id": U, "requested_by": "H", "vendor": "claude", "email": " B@X.test " });
        assert_eq!(parse_pending(&ok), Ok((U.into(), "b@x.test".into(), "H".into())));
        for bad in [
            json!({ "id": "x", "requested_by": "H", "vendor": "claude", "email": "b@x.test" }),
            json!({ "id": U, "requested_by": "H H", "vendor": "claude", "email": "b@x.test" }),
            json!({ "id": U, "requested_by": "H", "vendor": "codex", "email": "b@x.test" }),
            json!({ "id": U, "requested_by": "H", "vendor": "claude", "email": "../x" }),
            json!({ "id": U, "requested_by": "H", "vendor": "claude" }),
        ] {
            assert!(parse_pending(&bad).is_err(), "{bad}");
        }
    }

    fn taken_with(id: &str, email: &str) -> HashMap<String, (String, Instant)> {
        let mut m = HashMap::new();
        m.insert(id.to_string(), (email.to_string(), Instant::now()));
        m
    }

    #[test]
    fn 沒確認不切換_確認了才切_每個編號只處理一次() {
        let mut m = taken_with(U, "b@x.test");
        let mut called = vec![];
        let r = decide(&mut m, U, false, |e| {
            called.push(e.to_string());
            Ok("x".into())
        });
        assert_eq!(r, Some(("denied", "對方電腦上的使用者沒有同意".into())));
        assert!(called.is_empty(), "沒同意就不碰檔案");
        assert!(decide(&mut m, U, true, |_| Ok("x".into())).is_none(), "編號已用掉");

        let mut m = taken_with(U, "b@x.test");
        let r = decide(&mut m, U, true, |e| {
            called.push(e.to_string());
            Ok("切換好了".into())
        });
        assert_eq!(r, Some(("ok", "切換好了".into())));
        assert_eq!(called, vec!["b@x.test"]);
        assert!(decide(&mut m, U, true, |_| Ok("again".into())).is_none(), "不能重播");
    }

    #[test]
    fn 切換失敗回報原因() {
        let mut m = taken_with(U, "b@x.test");
        assert_eq!(decide(&mut m, U, true, |_| Err("找不到這個帳號".into())), Some(("failed", "找不到這個帳號".into())));
    }

    #[test]
    fn 沒取走過的編號不能憑空切換() {
        let mut m = HashMap::new();
        assert!(decide(&mut m, U, true, |_| panic!("不該被呼叫")).is_none());
    }

    #[test]
    fn 設定_預設需要確認_可改成信任自己() {
        let d = tempfile::tempdir().unwrap();
        assert!(!trust_own(d.path()));
        set_trust_own(d.path(), true).unwrap();
        assert!(trust_own(d.path()));
        set_trust_own(d.path(), false).unwrap();
        assert!(!trust_own(d.path()));
        std::fs::write(prefs_path(d.path()), "{壞掉").unwrap();
        assert!(!trust_own(d.path()), "壞掉就用預設（要確認）");
    }

    /// 本機假後端：依動作名回罐頭內容（pending 依序取），記下每個請求（只連 127.0.0.1）
    fn fake_server(pending: Vec<Value>) -> (String, std::sync::Arc<Mutex<Vec<String>>>) {
        use std::io::{Read, Write};
        let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://127.0.0.1:{}/relay", l.local_addr().unwrap().port());
        let seen = std::sync::Arc::new(Mutex::new(vec![]));
        let s2 = seen.clone();
        let q = std::sync::Arc::new(Mutex::new(std::collections::VecDeque::from(pending)));
        std::thread::spawn(move || {
            for c in l.incoming() {
                let Ok(mut c) = c else { break };
                let mut buf = vec![0u8; 16384];
                let n = c.read(&mut buf).unwrap_or(0);
                let req = String::from_utf8_lossy(&buf[..n]).to_string();
                let body = if req.starts_with("POST /relay?action=acct_switch_pending") {
                    json!({ "requests": q.lock().unwrap().pop_front().map(|r| vec![r]).unwrap_or_default() }).to_string()
                } else {
                    r#"{"ok":true}"#.to_string()
                };
                s2.lock().unwrap().push(req);
                let _ = write!(c, "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}", body.len());
            }
        });
        (url, seen)
    }
    fn login(home: &Path, uuid: &str, email: &str, tag: &str) {
        std::fs::create_dir_all(home.join(".claude")).unwrap();
        std::fs::write(home.join(".claude").join(".credentials.json"), format!(r#"{{"claudeAiOauth":{{"accessToken":"FAKE-{tag}","subscriptionType":"max"}}}}"#)).unwrap();
        std::fs::write(home.join(".claude.json"), format!("{{\n  \"oauthAccount\": {{\n    \"accountUuid\": \"{uuid}\",\n    \"emailAddress\": \"{email}\"\n  }}\n}}\n")).unwrap();
    }

    #[tokio::test]
    async fn 端到端_取走待辦_沒同意不切_同意才切_回報結果_不能重播() {
        let home = tempfile::tempdir().unwrap();
        let data = tempfile::tempdir().unwrap();
        let h = home.path().to_path_buf();
        login(&h, "u-a", "a@x.test", "A");
        claude_accounts::save_current(&h).unwrap();
        login(&h, "u-b", "b@x.test", "B");
        claude_accounts::save_current(&h).unwrap();
        login(&h, "u-a", "a@x.test", "A2");
        let cred = |h: &Path| std::fs::read_to_string(h.join(".claude").join(".credentials.json")).unwrap();
        let before = cred(&h);

        let u2 = "22222222-2222-3333-4444-555555555555";
        let u3 = "33333333-2222-3333-4444-555555555555";
        let row = |id: &str, vendor: &str| json!({ "id": id, "requested_by": "H", "vendor": vendor, "email": "b@x.test" });
        let (url, seen) = fake_server(vec![row(U, "claude"), row(u2, "codex"), row(u3, "claude")]);
        let relay = Relay::new(url, "secret-key".into(), "W".into(), "W-ASN".into());
        let sw = |h: std::path::PathBuf| move |e: &str| claude_accounts::switch_to(&h, e).map(|o| o.notice).map_err(|e| e.to_string());

        // 1. 取走：合格的進待辦、要確認
        let p = pending(&relay, data.path()).await.unwrap();
        assert_eq!(p, vec![Pending { id: U.into(), email: "b@x.test".into(), requested_by: "H".into(), needs_confirm: true }]);
        // 2. 沒同意：不碰檔案，回報 denied
        assert!(apply_with(&relay, data.path(), U.into(), false, sw(h.clone())).await.is_err());
        assert_eq!(cred(&h), before, "沒同意就不切");
        // 3. 格式不對（廠商不是 claude）的指令，當場回報失敗
        assert!(pending(&relay, data.path()).await.unwrap().is_empty());
        // 4. 同意：切換成功
        let p = pending(&relay, data.path()).await.unwrap();
        assert_eq!(p[0].id, u3);
        let ok = apply_with(&relay, data.path(), u3.into(), true, sw(h.clone())).await.unwrap();
        assert_eq!(ok["status"], "ok");
        assert!(cred(&h).contains("FAKE-B"), "已切到 b");
        // 5. 不能重播；沒取走過的編號也不行
        assert!(apply_with(&relay, data.path(), u3.into(), true, sw(h.clone())).await.is_err());
        assert!(apply_with(&relay, data.path(), U.into(), true, sw(h.clone())).await.is_err());

        let reqs = seen.lock().unwrap().clone();
        let results: Vec<&String> = reqs.iter().filter(|r| r.starts_with("POST /relay?action=acct_switch_result")).collect();
        assert_eq!(results.len(), 3, "denied、failed(格式不對)、ok 各回報一次");
        assert!(results[0].contains(r#""status":"denied""#) && results[0].contains(U));
        assert!(results[1].contains(r#""status":"failed""#) && results[1].contains(u2));
        assert!(results[2].contains(r#""status":"ok""#) && results[2].contains(u3));
        assert!(reqs.iter().all(|r| !r.contains("FAKE-")), "送出去的請求裡沒有任何權杖");
        assert!(reqs.iter().all(|r| r.to_lowercase().contains("x-relay-key: secret-key")));
    }

    #[tokio::test]
    async fn 信任自己的設備_不用確認也會切() {
        // 待辦表 TAKEN 是全域的，跟上一個測試平行跑時不能共用同一個編號（會被對方取走）
        const U4: &str = "44444444-2222-3333-4444-555555555555";
        let home = tempfile::tempdir().unwrap();
        let data = tempfile::tempdir().unwrap();
        let h = home.path().to_path_buf();
        login(&h, "u-a", "a@x.test", "A");
        claude_accounts::save_current(&h).unwrap();
        login(&h, "u-b", "b@x.test", "B");
        claude_accounts::save_current(&h).unwrap();
        login(&h, "u-a", "a@x.test", "A");
        set_trust_own(data.path(), true).unwrap();
        let (url, _seen) = fake_server(vec![json!({ "id": U4, "requested_by": "H", "vendor": "claude", "email": "b@x.test" })]);
        let relay = Relay::new(url, "k".into(), "W".into(), "W-ASN".into());
        let p = pending(&relay, data.path()).await.unwrap();
        assert!(!p[0].needs_confirm);
        let h2 = h.clone();
        apply_with(&relay, data.path(), U4.into(), false, move |e| claude_accounts::switch_to(&h2, e).map(|o| o.notice).map_err(|e| e.to_string())).await.unwrap();
        assert!(std::fs::read_to_string(h.join(".claude").join(".credentials.json")).unwrap().contains("FAKE-B"));
    }

    #[test]
    fn 設備代號與編號格式() {
        assert!(valid_node("H") && valid_node("machine-2_a") && !valid_node("") && !valid_node("a b") && !valid_node(&"x".repeat(33)));
        assert!(is_uuid(U) && !is_uuid("11111111-2222-3333-4444-55555555555") && !is_uuid("zzzzzzzz-2222-3333-4444-555555555555"));
    }
}

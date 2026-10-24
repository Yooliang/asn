//! Aegis 引擎：把「寄給 Aegis 主機上某位成員」的信轉成一次 `POST <aegis>/api/v1/agent-chat/ask`，答案寄回給寄件人。
//! 對應 relay/machine/bridge-aegis.mjs（Node 版 Aegis 橋）與 relay/machine/nudge.mjs；讓 `asn-bridge run --engine-only` 在 Aegis 主機上取代 Node 版。
//! 沒有子程序、不開 claude -p：只對 Aegis 的本機 HTTP 介面（預設 http://127.0.0.1:8899）發問。
//!
//! 與其他引擎的差別（核心看 [`Engine::ack_after_reply`]）：
//! - 「寄回成功才 ack」：轉交（Sent）時不 ack，回覆（含震動拆分的兩封）都寄成功、引擎報 [`EngineEvent::Replied`] 才 ack；寄回失敗就留在信箱，下次補拉再問。
//! - 引擎自己管等待時間（一次問答最久約 11 分鐘：逾時 300 秒、等 60 秒、再 300 秒），核心不對它送「還沒回覆」的提醒。
//! - 名單是白名單成員（ASN_AEGIS_ALLOW，不含 ASN_AEGIS_SELF），名字用 Aegis 成員表的中文名（沒有才用 slug）。
use super::{env_get, BoxFut, Engine, EngineCtx, EngineEvent};
use crate::bridge::engines::acp_approvals::parse_mail_text;
use crate::bridge::roster::Window;
use serde_json::{json, Value};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

// ---- 震動拆分（與 relay/machine/nudge.mjs 同一套規則；向量在 relay/shared/test-vectors/aegis-bridge.json，兩邊逐字相同）----

const NUDGE_HINT: &str = "對方在呼叫你：先回一個震動（寄一封內文只有「（你的名字 傳送了一個震動）」的信）。再想一下有沒有需要向對方報告的事——目前進度、卡住的地方、等對方決定的事；有的話另外寄一封簡短的信，沒有就只回震動。";
const LEGACY_NUDGE_HINT: &str = "想回應的話，就回一個震動：寄一封內文只有「（你的名字 傳送了一個震動）」的信，不用另外回信。";
const NUDGE_TAIL: &str = " 傳送了一個震動）";

/// 等於 Node 版的 `/^（[^（）\r\n]{1,80} 傳送了一個震動）$/`
fn is_nudge_line(s: &str) -> bool {
    let Some(mid) = s.strip_prefix('（').and_then(|x| x.strip_suffix(NUDGE_TAIL)) else { return false };
    let n = mid.chars().count();
    (1..=80).contains(&n) && !mid.chars().any(|c| matches!(c, '（' | '）' | '\r' | '\n'))
}

/// 回的震動只有第一行（不帶提示，對方不會再回，不會來回震動）
pub fn nudge_reply_body(name: &str) -> String {
    format!("（{} 傳送了一個震動）", name.trim())
}

/// 成員的回答第一行若是震動句：回 (純震動內文（署名用 name）, 後面的文字（可能為空）)；不是則回 None。後面是提示原文（成員照抄）也算空
pub fn split_nudge_answer(answer: &str, name: &str) -> Option<(String, String)> {
    let t = answer.trim();
    let mut lines = t.split('\n').map(|l| l.strip_suffix('\r').unwrap_or(l));
    let first = lines.next().unwrap_or("");
    if !is_nudge_line(first.trim()) {
        return None;
    }
    let tail = lines.collect::<Vec<_>>().join("\n");
    let tail = tail.trim();
    let rest = if tail == NUDGE_HINT || tail == LEGACY_NUDGE_HINT { "" } else { tail };
    Some((nudge_reply_body(name), rest.to_string()))
}

// ---- 設定 ---------------------------------------------------------------------------------------

/// 設定。名稱沿用 Node 版（IRORI_AEGIS_*），新名 ASN_AEGIS_* 優先（env-compat 規則）
#[derive(Clone, Debug, PartialEq)]
pub struct AegisCfg {
    pub url: String,
    pub from_member: String,
    pub allow: Vec<String>,
    /// 希緒自己：不列進名單、也不能被問
    pub self_member: String,
    /// 沒指定收件人的信交給它（要在白名單內）
    pub default_member: String,
    pub ask_timeout_ms: u64,
    pub retry_ms: u64,
}

impl AegisCfg {
    pub fn from_env(env: &[(String, String)]) -> AegisCfg {
        // Node 版寫 `process.env.X || 預設`：空字串視為沒設
        let s = |k: &str, d: &str| env_get(env, k).filter(|v| !v.is_empty()).unwrap_or_else(|| d.to_string());
        let n = |k: &str, d: u64| env_get(env, k).and_then(|v| v.trim().parse::<u64>().ok()).unwrap_or(d);
        AegisCfg {
            url: s("ASN_AEGIS_URL", "http://127.0.0.1:8899").trim_end_matches('/').to_string(),
            from_member: s("ASN_AEGIS_FROM_MEMBER", "xi-xu"),
            allow: env_get(env, "ASN_AEGIS_ALLOW").unwrap_or_default().split(',').map(|x| x.trim().to_string()).filter(|x| !x.is_empty()).collect(),
            self_member: s("ASN_AEGIS_SELF", "xi-xu").trim().to_string(),
            default_member: s("ASN_AEGIS_DEFAULT", "aegis").trim().to_string(),
            ask_timeout_ms: n("ASN_AEGIS_TIMEOUT_MS", 300_000),
            retry_ms: n("ASN_AEGIS_RETRY_MS", 60_000),
        }
    }
}

// ---- 問 Aegis -----------------------------------------------------------------------------------

/// 網路錯誤／逾時：http＝0
struct Ask {
    http: u16,
    data: Option<Value>,
    error: String,
}
impl Ask {
    fn status(&self) -> Option<&str> {
        self.data.as_ref().and_then(|d| d.get("status")).and_then(Value::as_str)
    }
    fn answer(&self) -> String {
        match self.data.as_ref().and_then(|d| d.get("answer")) {
            Some(Value::String(s)) => s.clone(),
            Some(Value::Null) | None => String::new(),
            Some(v) => v.to_string(),
        }
    }
    fn ok2xx(&self) -> bool {
        (200..300).contains(&self.http)
    }
    /// 連線失敗／逾時、5xx、或 2xx 但 status＝error
    fn failed(&self) -> bool {
        self.http == 0 || self.http >= 500 || (self.ok2xx() && self.status() == Some("error"))
    }
}

/// 轉交給 Aegis 的問題：`這是透過仲介轉來的信：from=<節點>/<視窗> trust=<信任>\n<內文>`（群組訊息直接用核心組好的文字）
fn build_question(text: &str) -> String {
    let (node, agent, body) = parse_mail_text(text);
    let first = text.lines().next().unwrap_or("");
    let trust = first.split_whitespace().find_map(|t| t.strip_prefix("trust=")).unwrap_or("");
    // 第二行「寄件人：…」是後台驗過的身分說明（例如「小良哥（本人，帳號簽章已驗證）」）；帶給成員，免得新格式的信被當成假冒
    // 只對後台確認過身分的人（owner／本人的 AI）帶這行；成員、外部的信照舊（與 Node 版同格式）
    let who = text.lines().nth(1).filter(|l| l.starts_with("寄件人：") && matches!(trust, "owner" | "mine" | "mine_ai")).map(|l| format!("{l}\n")).unwrap_or_default();
    format!("這是透過仲介轉來的信：from={node}/{agent} trust={trust}\n{who}{body}")
}

struct Inner {
    ctx: EngineCtx,
    cfg: AegisCfg,
    client: reqwest::Client,
    /// slug -> 中文名（可能是空字串）
    names: Mutex<Vec<(String, String)>>,
    stopped: AtomicBool,
}

impl Inner {
    fn display_name(&self, slug: &str) -> String {
        let g = self.names.lock().unwrap();
        g.iter().find(|(s, _)| s == slug).map(|(_, n)| n.clone()).filter(|n| !n.is_empty()).unwrap_or_else(|| slug.to_string())
    }

    /// 視窗名或 slug（Node 版 resolveSlug：中文名對得上就換成 slug，對不上原樣回傳）
    fn resolve_slug(&self, t: &str) -> String {
        let g = self.names.lock().unwrap();
        if g.iter().any(|(s, _)| s == t) {
            return t.to_string();
        }
        g.iter().find(|(_, n)| !n.is_empty() && n == t).map(|(s, _)| s.clone()).unwrap_or_else(|| t.to_string())
    }

    async fn refresh_members(&self) {
        let r: Result<Vec<(String, String)>, String> = async {
            let res = self.client.get(format!("{}/api/v1/members?scope=all", self.cfg.url)).timeout(Duration::from_secs(15)).send().await.map_err(|e| e.to_string())?;
            if !res.status().is_success() {
                return Err(String::new()); // Node 版：非 2xx 靜默沿用舊名單
            }
            let d: Value = res.json().await.map_err(|e| e.to_string())?;
            let list = if d.is_array() { Some(&d) } else { ["members", "items", "data"].iter().filter_map(|k| d.get(*k)).find(|v| !v.is_null()) };
            let Some(arr) = list.and_then(Value::as_array) else { return Err("成員表格式不認得".into()) };
            Ok(arr
                .iter()
                .filter_map(|x| {
                    let slug = x.get("slug").and_then(Value::as_str).filter(|s| !s.is_empty())?;
                    let name = ["name", "display_name", "member_name"].iter().filter_map(|k| x.get(*k)).find(|v| !v.is_null()).and_then(Value::as_str).unwrap_or("");
                    Some((slug.to_string(), name.to_string()))
                })
                .collect())
        }
        .await;
        match r {
            Ok(v) => *self.names.lock().unwrap() = v,
            Err(e) if e.is_empty() => {}
            Err(e) => self.ctx.log(format!("aegis: members fetch failed: {e}")),
        }
    }

    async fn ask(&self, target: &str, question: &str) -> Ask {
        let body = json!({ "target": target, "question": question, "from_member": self.cfg.from_member, "stream": false });
        match self.client.post(format!("{}/api/v1/agent-chat/ask", self.cfg.url)).timeout(Duration::from_millis(self.cfg.ask_timeout_ms)).json(&body).send().await {
            Ok(res) => {
                let http = res.status().as_u16();
                let data = res.json::<Value>().await.ok();
                Ask { http, data, error: String::new() }
            }
            Err(e) => Ask { http: 0, data: None, error: e.to_string() },
        }
    }

    fn emit(&self, ev: EngineEvent) {
        if !self.stopped.load(Ordering::SeqCst) {
            let _ = self.ctx.events.send(ev);
        }
    }

    /// 回覆（一到兩封）都交給核心寄；最後報「回覆送完」，核心寄成功才 ack
    fn finish(&self, id: &str, from: &str, parts: Vec<String>) {
        for text in parts {
            self.emit(EngineEvent::Reply { from: from.to_string(), text, mail_id: Some(id.to_string()) });
        }
        self.emit(EngineEvent::Replied(id.to_string()));
    }

    async fn handle(self: Arc<Self>, id: String, to: String, text: String) {
        self.emit(EngineEvent::Sent(id.clone()));
        if text.starts_with("[群組 ") {
            return self.handle_room(id, to, text).await;
        }
        let slug = self.resolve_slug(&to);
        let question = build_question(&text);
        let t0 = std::time::Instant::now();
        let mut r = self.ask(&slug, &question).await;
        if r.http == 404 {
            self.ctx.log(format!("aegis: id={id} to={slug} aegis 404"));
            return self.finish(&id, &to, vec![format!("[Aegis] 查無此成員（{slug}）")]);
        }
        if r.failed() {
            self.ctx.log(format!("aegis: id={id} to={slug} ask failed (http={} status={}); retry in {}ms", r.http, r.status().unwrap_or(&r.error), self.cfg.retry_ms));
            tokio::time::sleep(Duration::from_millis(self.cfg.retry_ms)).await;
            if self.stopped.load(Ordering::SeqCst) {
                return;
            }
            r = self.ask(&slug, &question).await;
            if r.http == 404 {
                return self.finish(&id, &to, vec![format!("[Aegis] 查無此成員（{slug}）")]);
            }
            if r.failed() {
                self.ctx.log(format!("aegis: id={id} to={slug} ask failed again (http={}): busy reply", r.http));
                return self.finish(&id, &to, vec!["[Aegis] 對方忙線中，請稍後再問".into()]);
            }
        }
        let (status, answer) = (r.status().map(String::from), r.answer());
        self.ctx.log(format!("aegis: id={id} to={slug} status={} ({}ms)", status.clone().unwrap_or_default(), t0.elapsed().as_millis()));
        if r.ok2xx() && status.as_deref() == Some("success") {
            // 成員一個問題只能回一個答案：第一行是震動句時拆成兩封——先一個純震動，後面的文字（有才寄）另寄一般信
            if let Some((nudge, rest)) = split_nudge_answer(&answer, &to) {
                let mut parts = vec![nudge];
                if !rest.is_empty() {
                    parts.push(rest);
                }
                return self.finish(&id, &to, parts);
            }
            return self.finish(&id, &to, vec![if answer.is_empty() { "(空回覆)".into() } else { answer }]);
        }
        let st = status.unwrap_or_else(|| format!("HTTP {}", r.http));
        self.finish(&id, &to, vec![format!("[Aegis] 對方回報狀態 {st}{}", if answer.is_empty() { String::new() } else { format!("：{answer}") })]);
    }

    /// 群組訊息：問一次、不重試；失敗、非 success、空答案都不貼回群組（Node 版 handleRoomMsg）
    async fn handle_room(self: Arc<Self>, id: String, to: String, text: String) {
        let slug = self.resolve_slug(&to);
        let r = self.ask(&slug, &text).await;
        let answer = r.answer();
        if r.failed() || !r.ok2xx() || r.status() != Some("success") || answer.is_empty() {
            self.ctx.log(format!("aegis: room msg id={id} to={slug} ask failed (http={} status={}): not posted", r.http, r.status().unwrap_or(&r.error)));
            return;
        }
        self.emit(EngineEvent::Reply { from: to, text: answer, mail_id: Some(id) });
    }
}

pub struct AegisEngine {
    i: Arc<Inner>,
}

impl AegisEngine {
    pub fn new(ctx: EngineCtx) -> AegisEngine {
        let cfg = AegisCfg::from_env(&ctx.env);
        // 本機 HTTP：不走系統代理（Node 版的 fetch 也不走）
        let client = reqwest::Client::builder().no_proxy().build().unwrap_or_default();
        AegisEngine { i: Arc::new(Inner { ctx, cfg, client, names: Mutex::new(vec![]), stopped: AtomicBool::new(false) }) }
    }
    pub fn cfg(&self) -> &AegisCfg {
        &self.i.cfg
    }
}

impl Engine for AegisEngine {
    fn id(&self) -> &'static str {
        "aegis"
    }

    fn start(&self) {
        let c = &self.i.cfg;
        self.i.ctx.log(format!("aegis: engine starting aegis={} allow=[{}]{}", c.url, c.allow.join(","), if c.allow.is_empty() { " (empty: everything blocked)" } else { "" }));
    }

    fn stop(&self) {
        self.i.stopped.store(true, Ordering::SeqCst);
    }

    /// 只列白名單成員（不含希緒自己）。成員表讀不到就沿用上次的名字（沒有就用 slug），名單照樣回報
    fn list(&self) -> BoxFut<'_, Option<Vec<Window>>> {
        Box::pin(async move {
            self.i.refresh_members().await;
            let now = crate::heartbeat::now_ms();
            let ws = self
                .i
                .cfg
                .allow
                .iter()
                .filter(|s| **s != self.i.cfg.self_member)
                .map(|slug| {
                    let mut w = Window::claude(&self.i.display_name(slug), Some("idle".into()), "", 0, now, None);
                    w.engine = "aegis".into();
                    w.no_fallback = true;
                    w.cwd_label_override = Some(String::new()); // 畫面會把它當標題副標露出，slug 是內部代號不給人看
                    w
                })
                .collect();
            Some(ws)
        })
    }

    fn deliver(&self, id: &str, to: &str, text: &str) -> Result<(), String> {
        if self.i.stopped.load(Ordering::SeqCst) {
            return Err("aegis 引擎已停止".into());
        }
        let (i, id, to, text) = (self.i.clone(), id.to_string(), to.to_string(), text.to_string());
        crate::rt::spawn(async move { i.handle(id, to, text).await });
        Ok(())
    }

    fn ack_after_reply(&self) -> bool {
        true
    }

    /// to_agent 寫成員代號（slug）也行：換成名單上的名字
    fn canonical_name(&self, name: &str) -> Option<String> {
        let c = &self.i.cfg;
        (name != c.self_member && c.allow.iter().any(|s| s == name)).then(|| self.i.display_name(name))
    }

    /// 白名單外與希緒自己：和 Node 版同文（只在僅引擎模式由核心採用）
    fn unreachable_reply(&self, name: &str) -> Option<String> {
        let c = &self.i.cfg;
        let slug = self.i.resolve_slug(name);
        if slug == c.self_member {
            Some("[Aegis] 這是希緒自己，不能自己問自己".into())
        } else if !c.allow.contains(&slug) {
            Some(format!("[Aegis] 這位成員沒有開放聯絡（{slug}）"))
        } else {
            None
        }
    }

    /// 沒指定收件人又沒有預設成員：列出開放聯絡的成員請寄件人指定（名單照 Node 版：整份白名單，含代號與中文名）
    fn unaddressed_reply(&self) -> Option<String> {
        let c = &self.i.cfg;
        if c.allow.contains(&c.default_member) {
            return (c.default_member == c.self_member).then(|| "[Aegis] 這是希緒自己，不能自己問自己".into());
        }
        let list = c
            .allow
            .iter()
            .map(|s| match self.i.display_name(s) {
                n if n != *s => format!("{s}（{n}）"),
                _ => s.clone(),
            })
            .collect::<Vec<_>>()
            .join("、");
        let list = if list.is_empty() { "(目前沒有開放任何成員)".to_string() } else { list };
        Some(format!("[Aegis] 請指定要問的成員（to_agent）。目前開放聯絡：{list}"))
    }

    fn default_window(&self) -> Option<String> {
        let c = &self.i.cfg;
        (c.default_member != c.self_member && c.allow.contains(&c.default_member)).then(|| self.i.display_name(&c.default_member))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn kv(v: &[(&str, &str)]) -> Vec<(String, String)> {
        v.iter().map(|(a, b)| (a.to_string(), b.to_string())).collect()
    }

    #[test]
    fn 設定_預設值_新舊名都認_新名優先_空字串視為沒設() {
        let d = AegisCfg::from_env(&[]);
        assert_eq!((d.url.as_str(), d.from_member.as_str(), d.self_member.as_str(), d.default_member.as_str()), ("http://127.0.0.1:8899", "xi-xu", "xi-xu", "aegis"));
        assert_eq!((d.ask_timeout_ms, d.retry_ms, d.allow.len()), (300_000, 60_000, 0));
        let old = AegisCfg::from_env(&kv(&[("IRORI_AEGIS_URL", "http://127.0.0.1:1/"), ("IRORI_AEGIS_ALLOW", " a, b ,,c "), ("IRORI_AEGIS_RETRY_MS", "100"), ("IRORI_AEGIS_TIMEOUT_MS", "2000")]));
        assert_eq!(old.url, "http://127.0.0.1:1", "尾端斜線去掉");
        assert_eq!(old.allow, vec!["a", "b", "c"]);
        assert_eq!((old.retry_ms, old.ask_timeout_ms), (100, 2000));
        let both = AegisCfg::from_env(&kv(&[("IRORI_AEGIS_URL", "http://old"), ("ASN_AEGIS_URL", "http://new"), ("IRORI_AEGIS_SELF", "x"), ("ASN_AEGIS_SELF", " "), ("ASN_AEGIS_FROM_MEMBER", "")]));
        assert_eq!(both.url, "http://new", "兩個都設以新名為準");
        assert_eq!(both.self_member, "x", "新名空白退回舊名");
        assert_eq!(both.from_member, "xi-xu", "空字串視為沒設");
    }

    #[test]
    fn 震動句判斷_與_node_正規式一致() {
        for ok in ["（小良 傳送了一個震動）", "（W-政策 傳送了一個震動）", "（a b 傳送了一個震動）", "（  傳送了一個震動）"] {
            assert!(is_nudge_line(ok), "{ok}");
        }
        for bad in ["（傳送了一個震動）", "（ 傳送了一個震動）", "前面（小良 傳送了一個震動）", "（小（良 傳送了一個震動）", "（小良 傳送了一個震動）後面", "你好", ""] {
            assert!(!is_nudge_line(bad), "{bad}");
        }
        assert!(is_nudge_line(&format!("（{} 傳送了一個震動）", "字".repeat(80))));
        assert!(!is_nudge_line(&format!("（{} 傳送了一個震動）", "字".repeat(81))));
    }

    #[test]
    fn 問題文字_抬頭取_from_與_trust_並保留寄件人身分行() {
        let t = "[RELAY 來信] trust=member from=W/W-政策 to=阿爾法 id=x engine=aegis reply=yes\n寄件人：W-政策（成員身分）\n內文-3";
        assert_eq!(build_question(t), "這是透過仲介轉來的信：from=W/W-政策 trust=member\n內文-3");
        let o = "[RELAY 來信] trust=owner from=u:3cda66252c34 to=愛吉絲 id=y engine=aegis reply=yes\n寄件人：小良哥（本人，帳號簽章已驗證，從「Oppo 手機」寄出）\n你好";
        assert!(build_question(o).contains("\n寄件人：小良哥（本人，帳號簽章已驗證，從「Oppo 手機」寄出）\n你好"), "{}", build_question(o));
    }
}

//! 回報匯流排的送出端（#2161 第 2c 段）：統一出口 `report(kind, data)`。電腦版與 Linux 無視窗橋共用（不依賴視窗與 ui_log，
//! 記錄由呼叫端注入）。各模組不再自己寫定時器與直接呼叫 relay，一律走這裡。
//!
//! 出口做的事：
//! 1. 只收登記表（[`KINDS`]）裡有的 kind；未登記一律拒絕、不送。
//! 2. 送出前整理：只留登記的欄位、刪掉 `redact` 與金鑰類欄位、遮掉疑似 email 與長金鑰片段。
//! 3. 內容雜湊沒變且未達保活間隔就不送。
//! 4. 每個 kind 最小間隔節流；被節流時只保留**最新值**，間隔到了再送一次，不丟。
//! 5. App 在背景（最小化／不可見）或離線時停止送（[`Reporter::set_active`]），回到前景補送一次最新值。
//! 6. 失敗退避重試（1 秒、2、4…上限 5 分鐘）；收到 429 以 `retry_after_seconds` 為準；記錄只寫 kind、次數、錯誤類別，不寫內容。
//!
//! 單一寫入者：同一行程內，同一個 kind 同時只有一個在途請求、一份待送值（`Mutex` 內的 per-kind 狀態）。
//! 跨行程（同一台多開）不做檔案鎖，只靠後台伺服器端的最小間隔與 `rate`／`rate_node` 限流擋住（被擋就依 retry_after 退避）。
//!
//! 時間由注入的時鐘提供、重試與釋放節流由 [`Reporter::tick`] 驅動（正式環境每秒一次，見 [`Reporter::spawn_driver`]），
//! 所以測試不需要真的等。
use crate::relay::Relay;
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, Mutex, OnceLock};

/// 一種回報的用戶端登記（要與後台 `relay.report_kinds` 對得上）
pub struct KindSpec {
    pub kind: &'static str,
    /// 兩次送出的最小間隔（毫秒）
    pub min_interval_ms: u64,
    /// 內容沒變也要再送一次的間隔（毫秒）
    pub keepalive_ms: u64,
    /// 允許的頂層欄位（其餘一律丟掉）
    pub fields: &'static [&'static str],
    /// 一定要刪掉的欄位名（任何層級）；通用的金鑰類欄位名另外一律刪
    pub redact: &'static [&'static str],
}

/// 用戶端登記表。目前只有測試用的 `echo`（後台 echo：欄位只有 text）
pub const KINDS: &[KindSpec] = &[KindSpec { kind: "echo", min_interval_ms: 5_000, keepalive_ms: 60_000, fields: &["text"], redact: &[] }];

/// payload 序列化後的上限（與 Edge 的 REPORT_MAX_BYTES 一致）
pub const MAX_BYTES: usize = 65_536;
pub const GET_MAX_NODES: usize = 50;
const BACKOFF_FIRST_MS: u64 = 1_000;
const BACKOFF_MAX_MS: u64 = 300_000;
const MASK_EMAIL: &str = "[email]";
const MASK_SECRET: &str = "[已遮罩]";

pub fn spec_in<'a>(specs: &'a [KindSpec], kind: &str) -> Option<&'a KindSpec> {
    specs.iter().find(|s| s.kind == kind)
}

// ---- 格式檢查（與 Edge 的 KIND_RE／NODE_RE 一致）----
pub fn kind_ok(k: &str) -> bool {
    let b = k.as_bytes();
    !b.is_empty() && b.len() <= 32 && b[0].is_ascii_lowercase() && b.iter().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == b'_')
}
fn node_ok(n: &str) -> bool {
    !n.is_empty() && n.len() <= 32 && n.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-')
}

/// report_get 的預檢：kind 格式、nodes 每個格式合格、去重（保留第一次出現的順序）後 1～50 個。錯誤文字固定白話
pub fn precheck_get(kind: &str, nodes: &[String]) -> Result<Vec<String>, String> {
    if !kind_ok(kind) {
        return Err("回報種類的格式不正確".into());
    }
    if !nodes.iter().all(|n| node_ok(n)) {
        return Err("設備代號的格式不正確".into());
    }
    let mut seen = std::collections::HashSet::new();
    let uniq: Vec<String> = nodes.iter().filter(|n| seen.insert(n.as_str())).cloned().collect();
    if uniq.is_empty() {
        return Err("請至少指定一台設備".into());
    }
    if uniq.len() > GET_MAX_NODES {
        return Err(format!("一次最多查詢 {GET_MAX_NODES} 台設備"));
    }
    Ok(uniq)
}

// ---- 送出前整理 ----
fn secret_field(name: &str) -> bool {
    let n = name.to_ascii_lowercase();
    ["key", "token", "secret", "password", "passwd", "credential", "authorization", "cookie", "bearer"].iter().any(|w| n.contains(w))
}
fn email_re() -> &'static regex::Regex {
    static R: OnceLock<regex::Regex> = OnceLock::new();
    R.get_or_init(|| regex::Regex::new(r"[A-Za-z0-9._%+\-]+@[A-Za-z0-9\-]+(?:\.[A-Za-z0-9\-]+)+").expect("email 規則"))
}
fn secret_re() -> &'static regex::Regex {
    static R: OnceLock<regex::Regex> = OnceLock::new();
    R.get_or_init(|| regex::Regex::new(r"[A-Za-z0-9+/=_\-]{32,}").expect("金鑰規則"))
}
fn mask_str(s: &str) -> String {
    let a = email_re().replace_all(s, MASK_EMAIL);
    secret_re().replace_all(&a, MASK_SECRET).into_owned()
}
fn scrub(v: &Value, redact: &[&str]) -> Value {
    match v {
        Value::String(s) => Value::String(mask_str(s)),
        Value::Array(a) => Value::Array(a.iter().map(|x| scrub(x, redact)).collect()),
        Value::Object(m) => {
            let mut out = Map::new();
            for (k, x) in m {
                if secret_field(k) || redact.iter().any(|r| r.eq_ignore_ascii_case(k)) {
                    continue;
                }
                out.insert(mask_str(k), scrub(x, redact));
            }
            Value::Object(out)
        }
        other => other.clone(),
    }
}

/// 整理出要送的 payload：必須是物件；只留登記欄位；刪欄位、遮 email 與金鑰片段；大小不超過上限
pub fn sanitize(spec: &KindSpec, data: &Value) -> Result<Value, String> {
    let Value::Object(m) = data else { return Err("回報內容必須是物件".into()) };
    let kept: Map<String, Value> = m.iter().filter(|(k, _)| spec.fields.contains(&k.as_str())).map(|(k, v)| (k.clone(), v.clone())).collect();
    let out = scrub(&Value::Object(kept), spec.redact);
    if out.to_string().len() > MAX_BYTES {
        return Err("回報內容太大".into());
    }
    Ok(out)
}

/// 鍵排序後的 JSON 文字再取 SHA-256：同樣內容不同鍵順序算同一份
fn canonical(v: &Value) -> Value {
    match v {
        Value::Object(m) => {
            let mut keys: Vec<&String> = m.keys().collect();
            keys.sort();
            Value::Object(keys.into_iter().map(|k| (k.clone(), canonical(&m[k]))).collect())
        }
        Value::Array(a) => Value::Array(a.iter().map(canonical).collect()),
        o => o.clone(),
    }
}
pub fn hash_of(v: &Value) -> [u8; 32] {
    Sha256::digest(canonical(v).to_string().as_bytes()).into()
}

// ---- 後端 ----
#[derive(Debug, Clone, PartialEq)]
pub enum SendErr {
    /// 後台限流（429）：多久後可再送（毫秒）；node＝整台設備的限流
    Rate { retry_after_ms: u64, node: bool },
    /// 連不上（含逾時）
    Network,
    /// 後台 5xx
    Server(u16),
    /// 後台明確拒絕這份內容（4xx 非限流）：重送也一樣，丟掉這個值。帶代碼（只留 [a-z0-9_]）
    Rejected(String),
}
impl SendErr {
    /// 錯誤類別（給記錄用，不含內容）
    pub fn class(&self) -> String {
        match self {
            SendErr::Rate { node: false, .. } => "rate".into(),
            SendErr::Rate { node: true, .. } => "rate_node".into(),
            SendErr::Network => "network".into(),
            SendErr::Server(c) => format!("server:{c}"),
            SendErr::Rejected(c) => format!("rejected:{c}"),
        }
    }
}

pub type BoxFut<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// 可注入的後端：測試用假的，正式用 [`RelayBackend`]
pub trait Backend: Send + Sync + 'static {
    /// 送一份回報；成功回後台說的 changed
    fn send<'a>(&'a self, kind: &'a str, payload: &'a Value) -> BoxFut<'a, Result<bool, SendErr>>;
    /// 讀別台的回報（nodes 已預檢）
    fn get<'a>(&'a self, kind: &'a str, nodes: &'a [String]) -> BoxFut<'a, Result<Value, String>>;
}

pub struct RelayBackend(pub Arc<Relay>);

fn clean_code(s: &str) -> String {
    let c: String = s.chars().filter(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == '_').take(32).collect();
    if c.is_empty() { "unknown".into() } else { c }
}

/// 把後台的 HTTP 回應對成結果（純函式，方便測）。拒絕原因取 `rejected_reason`，沒有就取 `error`
pub fn map_send_response(status: u16, body: &Value) -> Result<bool, SendErr> {
    let reason = body.get("rejected_reason").or_else(|| body.get("error")).and_then(Value::as_str).unwrap_or("");
    match status {
        200..=299 => Ok(body.get("changed").and_then(Value::as_bool).unwrap_or(false)),
        429 => {
            let secs = body.get("retry_after_seconds").and_then(Value::as_f64).filter(|n| n.is_finite() && *n >= 1.0).unwrap_or(1.0).min(3600.0);
            Err(SendErr::Rate { retry_after_ms: (secs.ceil() as u64) * 1000, node: reason == "rate_node" })
        }
        500..=599 => Err(SendErr::Server(status)),
        s => Err(SendErr::Rejected(if reason.is_empty() { s.to_string() } else { clean_code(reason) })),
    }
}

impl Backend for RelayBackend {
    fn send<'a>(&'a self, kind: &'a str, payload: &'a Value) -> BoxFut<'a, Result<bool, SendErr>> {
        Box::pin(async move {
            match self.0.api_status("report", json!({ "kind": kind, "payload": payload })).await {
                Ok((status, body)) => map_send_response(status, &body),
                Err(_) => Err(SendErr::Network),
            }
        })
    }
    fn get<'a>(&'a self, kind: &'a str, nodes: &'a [String]) -> BoxFut<'a, Result<Value, String>> {
        Box::pin(async move {
            match self.0.api_status("report_get", json!({ "kind": kind, "nodes": nodes })).await {
                Ok((200..=299, body)) => Ok(body),
                Ok((404, _)) => Err("不認得這種回報".into()),
                Ok((429, _)) => Err("查詢太頻繁，請稍後再試".into()),
                Ok((400 | 413 | 422, _)) => Err("查詢內容不正確".into()),
                Ok(_) => Err("暫時讀不到回報，請稍後再試".into()),
                Err(_) => Err("連不上收發室，請稍後再試".into()),
            }
        })
    }
}

// ---- 出口 ----
#[derive(Default)]
struct KState {
    /// 最新的待送值（含雜湊）；比它舊的值直接被蓋掉
    pending: Option<(Value, [u8; 32])>,
    /// 最後一次成功送出的內容雜湊與時間
    last_hash: Option<[u8; 32]>,
    last_sent_at: Option<u64>,
    last_attempt_at: Option<u64>,
    /// 失敗後最早可再試的時間
    retry_at: u64,
    fails: u32,
    inflight: bool,
}
struct Inner {
    active: bool,
    kinds: HashMap<&'static str, KState>,
}

pub struct Reporter {
    backend: Arc<dyn Backend>,
    specs: &'static [KindSpec],
    clock: Arc<dyn Fn() -> u64 + Send + Sync>,
    log: Arc<dyn Fn(&str) + Send + Sync>,
    st: Mutex<Inner>,
}

pub fn backoff_ms(fails: u32) -> u64 {
    BACKOFF_FIRST_MS.saturating_mul(1u64 << fails.saturating_sub(1).min(20)).min(BACKOFF_MAX_MS)
}

impl Reporter {
    pub fn new(backend: Arc<dyn Backend>, clock: Arc<dyn Fn() -> u64 + Send + Sync>, log: Arc<dyn Fn(&str) + Send + Sync>) -> Reporter {
        Reporter::with_specs(backend, KINDS, clock, log)
    }
    pub fn with_specs(backend: Arc<dyn Backend>, specs: &'static [KindSpec], clock: Arc<dyn Fn() -> u64 + Send + Sync>, log: Arc<dyn Fn(&str) + Send + Sync>) -> Reporter {
        Reporter { backend, specs, clock, log, st: Mutex::new(Inner { active: true, kinds: HashMap::new() }) }
    }
    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.st.lock().unwrap_or_else(|p| p.into_inner())
    }

    /// 統一送出口。回 Err 只有「不認得的 kind」或「內容不合格」（固定白話）；網路與後台的失敗在背景重試、不回錯
    pub async fn report(&self, kind: &str, data: Value) -> Result<(), String> {
        let spec = spec_in(self.specs, kind).ok_or_else(|| "不認得這種回報".to_string())?;
        let payload = sanitize(spec, &data)?;
        let hash = hash_of(&payload);
        let now = (self.clock)();
        {
            let mut g = self.lock();
            let ks = g.kinds.entry(spec.kind).or_default();
            let fresh = ks.last_sent_at.is_some_and(|t| now.saturating_sub(t) < spec.keepalive_ms);
            if ks.last_hash == Some(hash) && fresh {
                // 跟最後送出的一樣、也還沒到保活：不送，連較舊的待送值也作廢（最新值就是已送出的那份）
                ks.pending = None;
                return Ok(());
            }
            ks.pending = Some((payload, hash));
        }
        self.pump(spec).await;
        Ok(())
    }

    /// 前景／在線狀態：false＝停止送（待送值留著、只保留最新）；回到 true 立刻補送一次
    pub async fn set_active(&self, active: bool) {
        let was = std::mem::replace(&mut self.lock().active, active);
        if active && !was {
            self.tick().await;
        }
    }

    /// 把到期的都送一送（重試時間到、節流間隔到、回到前景）。正式環境每秒呼叫一次
    pub async fn tick(&self) {
        for spec in self.specs {
            self.pump(spec).await;
        }
    }

    pub fn spawn_driver(self: &Arc<Self>) {
        let me = self.clone();
        crate::rt::spawn(async move {
            loop {
                tokio::time::sleep(std::time::Duration::from_secs(1)).await;
                me.tick().await;
            }
        });
    }

    /// 這個 kind 的待送值到期就送一次（同 kind 同時只有一個在途請求）
    async fn pump(&self, spec: &KindSpec) {
        let now = (self.clock)();
        let (value, hash, n_before) = {
            let mut g = self.lock();
            if !g.active {
                return;
            }
            let ks = g.kinds.entry(spec.kind).or_default();
            let due = ks.last_attempt_at.map_or(0, |t| t.saturating_add(spec.min_interval_ms));
            if ks.inflight || ks.pending.is_none() || now < ks.retry_at || now < due {
                return;
            }
            let (v, h) = ks.pending.take().expect("剛檢查過");
            ks.inflight = true;
            ks.last_attempt_at = Some(now);
            (v, h, ks.fails)
        };
        let res = self.backend.send(spec.kind, &value).await;
        let now2 = (self.clock)();
        let mut line = None;
        {
            let mut g = self.lock();
            let ks = g.kinds.entry(spec.kind).or_default();
            ks.inflight = false;
            let requeue = |ks: &mut KState| {
                if ks.pending.is_none() {
                    ks.pending = Some((value.clone(), hash));
                }
            };
            match &res {
                Ok(_) => {
                    ks.last_hash = Some(hash);
                    ks.last_sent_at = Some(now2);
                    ks.fails = 0;
                    ks.retry_at = 0;
                    if n_before > 0 {
                        line = Some(format!("回報 kind={} 已恢復（失敗 {n_before} 次後送出）", spec.kind));
                    }
                }
                Err(e) => {
                    ks.fails += 1;
                    match e {
                        SendErr::Rate { retry_after_ms, .. } => {
                            ks.retry_at = now2.saturating_add(*retry_after_ms);
                            requeue(ks);
                        }
                        SendErr::Network | SendErr::Server(_) => {
                            ks.retry_at = now2.saturating_add(backoff_ms(ks.fails));
                            requeue(ks);
                        }
                        // 後台說這份內容不行：重送也一樣，丟掉；之後有新內容照常送
                        SendErr::Rejected(_) => ks.retry_at = 0,
                    }
                    line = Some(format!("回報 kind={} 失敗第 {} 次 類別={}", spec.kind, ks.fails, e.class()));
                }
            }
        }
        if let Some(l) = line {
            (self.log)(&l);
        }
    }

    /// 讀別台的回報（預檢後直接問後台）
    pub async fn get(&self, kind: &str, nodes: &[String]) -> Result<Value, String> {
        let nodes = precheck_get(kind, nodes)?;
        self.backend.get(kind, &nodes).await
    }
}

// ---- 行程內唯一的出口（Tauri 指令用）----
static GLOBAL: OnceLock<Arc<Reporter>> = OnceLock::new();

/// 取得（第一次呼叫時建立並啟動每秒驅動）行程內唯一的 Reporter。log 只在第一次建立時採用
pub fn global(relay: Arc<Relay>, log: Arc<dyn Fn(&str) + Send + Sync>) -> Arc<Reporter> {
    GLOBAL
        .get_or_init(|| {
            let r = Arc::new(Reporter::new(Arc::new(RelayBackend(relay)), Arc::new(crate::heartbeat::now_ms), log));
            r.spawn_driver();
            r
        })
        .clone()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::VecDeque;
    use std::sync::atomic::{AtomicU64, Ordering};

    const SECRET_TEXT: &str = "聯絡 someone@example.com 與 0123456789abcdef0123456789abcdef0123";

    #[derive(Default)]
    struct Fake {
        sent: Mutex<Vec<(String, Value)>>,
        script: Mutex<VecDeque<Result<bool, SendErr>>>,
        gets: Mutex<Vec<(String, Vec<String>)>>,
    }
    impl Backend for Arc<Fake> {
        fn send<'a>(&'a self, kind: &'a str, payload: &'a Value) -> BoxFut<'a, Result<bool, SendErr>> {
            Box::pin(async move {
                self.sent.lock().unwrap().push((kind.to_string(), payload.clone()));
                self.script.lock().unwrap().pop_front().unwrap_or(Ok(true))
            })
        }
        fn get<'a>(&'a self, kind: &'a str, nodes: &'a [String]) -> BoxFut<'a, Result<Value, String>> {
            Box::pin(async move {
                self.gets.lock().unwrap().push((kind.to_string(), nodes.to_vec()));
                Ok(json!({"ok": true, "reports": []}))
            })
        }
    }
    struct Rig {
        r: Reporter,
        fake: Arc<Fake>,
        now: Arc<AtomicU64>,
        logs: Arc<Mutex<Vec<String>>>,
    }
    fn rig() -> Rig {
        let fake = Arc::new(Fake::default());
        let now = Arc::new(AtomicU64::new(1_000_000));
        let logs = Arc::new(Mutex::new(vec![]));
        let (n2, l2) = (now.clone(), logs.clone());
        let r = Reporter::new(Arc::new(fake.clone()), Arc::new(move || n2.load(Ordering::SeqCst)), Arc::new(move |s| l2.lock().unwrap().push(s.to_string())));
        Rig { r, fake, now, logs }
    }
    impl Rig {
        fn advance(&self, ms: u64) {
            self.now.fetch_add(ms, Ordering::SeqCst);
        }
        fn texts(&self) -> Vec<String> {
            self.fake.sent.lock().unwrap().iter().map(|(_, p)| p["text"].as_str().unwrap_or("").to_string()).collect()
        }
        async fn say(&self, t: &str) {
            self.r.report("echo", json!({ "text": t })).await.unwrap();
        }
    }

    #[tokio::test]
    async fn 未登記的_kind_拒絕_不送() {
        let g = rig();
        let e = g.r.report("nope", json!({"text": "x"})).await.unwrap_err();
        assert_eq!(e, "不認得這種回報");
        assert!(g.fake.sent.lock().unwrap().is_empty());
        assert!(g.r.report("echo", json!("不是物件")).await.is_err());
        assert!(g.fake.sent.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn 內容沒變不送_到保活間隔才再送() {
        let g = rig();
        g.say("a").await;
        assert_eq!(g.texts(), ["a"]);
        g.advance(10_000);
        g.say("a").await;
        g.advance(49_000);
        g.say("a").await;
        assert_eq!(g.texts(), ["a"], "沒變、未到 60 秒保活");
        g.advance(2_000);
        g.say("a").await;
        assert_eq!(g.texts(), ["a", "a"], "超過保活間隔再送");
    }

    #[tokio::test]
    async fn 節流_期間只留最新值_間隔到了送一次() {
        let g = rig();
        g.say("v1").await;
        g.advance(1_000);
        g.say("v2").await;
        g.advance(1_000);
        g.say("v3").await;
        assert_eq!(g.texts(), ["v1"], "5 秒內不再送");
        g.advance(2_000);
        g.r.tick().await;
        assert_eq!(g.texts(), ["v1"], "還差 1 秒");
        g.advance(1_000);
        g.r.tick().await;
        assert_eq!(g.texts(), ["v1", "v3"], "只送最新值，v2 被蓋掉、v3 不丟");
        g.advance(10_000);
        g.r.tick().await;
        assert_eq!(g.texts().len(), 2, "沒有待送值就不再送");
    }

    #[tokio::test]
    async fn 節流中改回已送出的值_待送作廢() {
        let g = rig();
        g.say("a").await;
        g.advance(1_000);
        g.say("b").await;
        g.advance(1_000);
        g.say("a").await;
        g.advance(10_000);
        g.r.tick().await;
        assert_eq!(g.texts(), ["a"], "最新值就是已送出的 a，b 不必送");
    }

    #[tokio::test]
    async fn 背景停止送_回到前景補送最新值() {
        let g = rig();
        g.say("a").await;
        g.r.set_active(false).await;
        g.advance(10_000);
        g.say("b").await;
        g.advance(10_000);
        g.say("c").await;
        g.r.tick().await;
        assert_eq!(g.texts(), ["a"], "背景不送");
        g.r.set_active(true).await;
        assert_eq!(g.texts(), ["a", "c"], "回前景只補送最新值");
    }

    #[tokio::test]
    async fn 失敗_退避_1_2_4_秒_上限_5_分鐘_恢復後歸零() {
        assert_eq!([backoff_ms(1), backoff_ms(2), backoff_ms(3), backoff_ms(4)], [1_000, 2_000, 4_000, 8_000]);
        assert_eq!(backoff_ms(30), 300_000);
        let g = rig();
        g.fake.script.lock().unwrap().extend([Err(SendErr::Network), Err(SendErr::Network), Ok(true)]);
        g.say("a").await;
        assert_eq!(g.texts().len(), 1);
        g.advance(4_999);
        g.r.tick().await;
        assert_eq!(g.texts().len(), 1, "最小間隔 5 秒還沒到");
        g.advance(1);
        g.r.tick().await;
        assert_eq!(g.texts().len(), 2, "第一次重試（退避 1 秒 < 最小間隔 5 秒，以 5 秒為準）");
        g.advance(4_999);
        g.r.tick().await;
        assert_eq!(g.texts().len(), 2, "第二次失敗退避 2 秒、最小間隔 5 秒：還差 1 毫秒");
        g.advance(1);
        g.r.tick().await;
        assert_eq!(g.texts().len(), 3);
        g.advance(100_000);
        g.r.tick().await;
        assert_eq!(g.texts().len(), 3, "成功後沒有待送值");
        let logs = g.logs.lock().unwrap().clone();
        assert!(logs.iter().any(|l| l.contains("失敗第 1 次") && l.contains("network")), "{logs:?}");
        assert!(logs.iter().any(|l| l.contains("失敗第 2 次")), "{logs:?}");
        assert!(logs.iter().any(|l| l.contains("已恢復")), "{logs:?}");
    }

    #[tokio::test]
    async fn 退避超過最小間隔時以退避為準() {
        let g = rig();
        g.fake.script.lock().unwrap().extend((0..4).map(|_| Err(SendErr::Server(503))));
        g.say("a").await;
        // 第 1、2、3 次失敗後退避 1、2、4 秒都小於 5 秒最小間隔；第 4 次失敗後退避 8 秒才大於它
        for _ in 0..3 {
            g.advance(5_000);
            g.r.tick().await;
        }
        assert_eq!(g.texts().len(), 4);
        g.advance(5_000);
        g.r.tick().await;
        assert_eq!(g.texts().len(), 4, "退避 8 秒，5 秒不夠");
        g.advance(3_000);
        g.r.tick().await;
        assert_eq!(g.texts().len(), 5);
    }

    #[tokio::test]
    async fn 收到_429_以_retry_after_為準() {
        let g = rig();
        g.fake.script.lock().unwrap().push_back(Err(SendErr::Rate { retry_after_ms: 30_000, node: false }));
        g.say("a").await;
        g.advance(29_000);
        g.r.tick().await;
        assert_eq!(g.texts().len(), 1);
        g.advance(1_000);
        g.r.tick().await;
        assert_eq!(g.texts(), ["a", "a"], "retry_after 到了重送同一份");
        assert!(g.logs.lock().unwrap().iter().any(|l| l.contains("類別=rate")));
    }

    #[tokio::test]
    async fn 後台拒絕內容_丟掉不重試_新內容照常送() {
        let g = rig();
        g.fake.script.lock().unwrap().push_back(Err(SendErr::Rejected("too_long".into())));
        g.say("a").await;
        g.advance(60_000);
        g.r.tick().await;
        assert_eq!(g.texts(), ["a"], "不重試");
        g.say("b").await;
        assert_eq!(g.texts(), ["a", "b"]);
        assert!(g.logs.lock().unwrap().iter().any(|l| l.contains("rejected:too_long")));
    }

    #[tokio::test]
    async fn 遮罩_email_與金鑰類欄位不出現在送出的內容_記錄也不含內容() {
        const S: &[KindSpec] = &[KindSpec { kind: "t", min_interval_ms: 0, keepalive_ms: 60_000, fields: &["text", "api_key", "who", "n"], redact: &["who"] }];
        let fake = Arc::new(Fake::default());
        fake.script.lock().unwrap().push_back(Err(SendErr::Network));
        let logs = Arc::new(Mutex::new(vec![]));
        let l2 = logs.clone();
        let r = Reporter::with_specs(Arc::new(fake.clone()), S, Arc::new(|| 1), Arc::new(move |s| l2.lock().unwrap().push(s.to_string())));
        r.report("t", json!({"text": SECRET_TEXT, "api_key": "sk-abc", "who": "a@b.co", "n": {"token": "t", "mail": "x@y.com", "ok": 3}, "extra": "不在登記"})).await.unwrap();
        let sent = fake.sent.lock().unwrap().clone();
        let body = sent[0].1.to_string();
        for bad in ["someone@example.com", "0123456789abcdef", "sk-abc", "a@b.co", "x@y.com", "extra", "api_key", "\"token\""] {
            assert!(!body.contains(bad), "{bad} 不該出現：{body}");
        }
        assert!(body.contains("[email]") && body.contains("[已遮罩]") && body.contains("\"ok\":3"), "{body}");
        let all = logs.lock().unwrap().join("\n");
        assert!(!all.is_empty() && !all.contains("example.com") && !all.contains("0123456789") && !all.contains("聯絡"), "記錄不含內容：{all}");
    }

    #[test]
    fn 雜湊與鍵順序無關() {
        assert_eq!(hash_of(&json!({"a": 1, "b": {"x": 1, "y": 2}})), hash_of(&json!({"b": {"y": 2, "x": 1}, "a": 1})));
        assert_ne!(hash_of(&json!({"a": 1})), hash_of(&json!({"a": 2})));
    }

    #[tokio::test]
    async fn report_get_預檢() {
        let g = rig();
        let ok = g.r.get("echo", &["N-1".into(), "N-2".into(), "N-1".into()]).await.unwrap();
        assert_eq!(ok["ok"], true);
        assert_eq!(g.fake.gets.lock().unwrap()[0], ("echo".to_string(), vec!["N-1".to_string(), "N-2".to_string()]), "去重並保留順序");
        let many: Vec<String> = (0..51).map(|i| format!("n{i}")).collect();
        for (k, n) in [("Echo", vec!["a".to_string()]), ("echo", vec![]), ("echo", many.clone()), ("echo", vec!["a b".into()]), ("echo", vec!["".into()])] {
            assert!(g.r.get(k, &n).await.is_err(), "{k} {n:?}");
        }
        assert_eq!(precheck_get("echo", &many[..50]).unwrap().len(), 50);
        let dup: Vec<String> = (0..60).map(|i| format!("n{}", i % 3)).collect();
        assert_eq!(precheck_get("echo", &dup).unwrap().len(), 3, "去重後才算數量");
        assert_eq!(g.fake.gets.lock().unwrap().len(), 1, "預檢失敗的不打後台");
    }

    #[test]
    fn 回應對照() {
        assert_eq!(map_send_response(200, &json!({"ok": true, "changed": true})), Ok(true));
        assert_eq!(map_send_response(200, &json!({"ok": true, "changed": false})), Ok(false));
        assert_eq!(map_send_response(429, &json!({"ok": false, "rejected_reason": "rate", "retry_after_seconds": 7})), Err(SendErr::Rate { retry_after_ms: 7_000, node: false }));
        assert_eq!(map_send_response(429, &json!({"error": "rate_node", "retry_after_seconds": 2.2})), Err(SendErr::Rate { retry_after_ms: 3_000, node: true }));
        assert_eq!(map_send_response(429, &json!({})), Err(SendErr::Rate { retry_after_ms: 1_000, node: false }));
        assert_eq!(map_send_response(422, &json!({"rejected_reason": "unknown_kind"})), Err(SendErr::Rejected("unknown_kind".into())));
        assert_eq!(map_send_response(413, &json!({"error": "too_large"})), Err(SendErr::Rejected("too_large".into())));
        assert_eq!(map_send_response(400, &Value::Null), Err(SendErr::Rejected("400".into())));
        assert_eq!(map_send_response(502, &Value::Null), Err(SendErr::Server(502)));
    }

    /// 本機假後端（HTTP）：依序回腳本裡的（狀態碼, 內容），記下每個完整請求
    fn http_server(script: Vec<(u16, &'static str)>) -> (String, Arc<Mutex<Vec<String>>>) {
        use std::io::{Read, Write};
        let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://127.0.0.1:{}/relay", l.local_addr().unwrap().port());
        let seen = Arc::new(Mutex::new(vec![]));
        let s2 = seen.clone();
        std::thread::spawn(move || {
            let mut script = script.into_iter();
            for c in l.incoming() {
                let Ok(mut c) = c else { break };
                let mut buf = Vec::new();
                let mut chunk = [0u8; 4096];
                loop {
                    let n = c.read(&mut chunk).unwrap_or(0);
                    buf.extend_from_slice(&chunk[..n]);
                    let t = String::from_utf8_lossy(&buf).to_string();
                    if n == 0 {
                        break;
                    }
                    if let Some(i) = t.find("\r\n\r\n") {
                        let len = t[..i].to_ascii_lowercase().split("content-length:").nth(1).and_then(|r| r.split("\r\n").next()).and_then(|v| v.trim().parse::<usize>().ok()).unwrap_or(0);
                        if buf.len() >= i + 4 + len {
                            break;
                        }
                    }
                }
                s2.lock().unwrap().push(String::from_utf8_lossy(&buf).to_string());
                let (code, body) = script.next().unwrap_or((200, r#"{"ok":true,"changed":true}"#));
                let _ = write!(c, "HTTP/1.1 {code} X\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}", body.len());
            }
        });
        (url, seen)
    }

    #[tokio::test]
    async fn 端到端_假_http_後台_送出的請求內容與_429_退避() {
        let (url, seen) = http_server(vec![(429, r#"{"error":"rate","message":"x","retry_after_seconds":20}"#), (200, r#"{"ok":true,"changed":true}"#)]);
        let relay = Arc::new(Relay::new(url, "fake-key".into(), "N-1".into(), "N-1-ASN".into()));
        let now = Arc::new(AtomicU64::new(5_000_000));
        let n2 = now.clone();
        let logs = Arc::new(Mutex::new(vec![]));
        let l2 = logs.clone();
        let r = Reporter::new(Arc::new(RelayBackend(relay)), Arc::new(move || n2.load(Ordering::SeqCst)), Arc::new(move |s| l2.lock().unwrap().push(s.to_string())));
        r.report("echo", json!({"text": SECRET_TEXT, "api_key": "sk-zzz"})).await.unwrap();
        now.fetch_add(19_000, Ordering::SeqCst);
        r.tick().await;
        assert_eq!(seen.lock().unwrap().len(), 1, "429 retry_after 20 秒未到");
        now.fetch_add(1_000, Ordering::SeqCst);
        r.tick().await;
        let reqs = seen.lock().unwrap().clone();
        assert_eq!(reqs.len(), 2);
        for q in &reqs {
            assert!(q.starts_with("POST /relay?action=report "), "{q}");
            assert!(q.to_ascii_lowercase().contains("x-relay-key: fake-key"));
            let body = &q[q.find("\r\n\r\n").unwrap() + 4..];
            let v: Value = serde_json::from_str(body).unwrap();
            assert_eq!(v["kind"], "echo");
            assert_eq!(v["payload"].as_object().unwrap().keys().collect::<Vec<_>>(), ["text"], "只有登記欄位");
            for bad in ["someone@example.com", "0123456789abcdef", "sk-zzz"] {
                assert!(!body.contains(bad), "{bad}");
            }
        }
        let all = logs.lock().unwrap().join("\n");
        assert!(all.contains("類別=rate") && !all.contains("example.com"), "{all}");
    }

    #[tokio::test]
    async fn 端到端_report_get_對照後台狀態碼() {
        let (url, seen) = http_server(vec![(200, r#"{"ok":true,"reports":[{"node":"N-2","kind":"echo","payload":{"text":"hi"}}]}"#), (404, r#"{"error":"unknown_kind"}"#)]);
        let relay = Arc::new(Relay::new(url, "fake-key".into(), "N-1".into(), "N-1-ASN".into()));
        let b = RelayBackend(relay);
        let ok = b.get("echo", &["N-2".to_string()]).await.unwrap();
        assert_eq!(ok["reports"][0]["payload"]["text"], "hi");
        assert_eq!(b.get("zzz", &["N-2".to_string()]).await.unwrap_err(), "不認得這種回報");
        let q = seen.lock().unwrap()[0].clone();
        assert!(q.starts_with("POST /relay?action=report_get "));
        assert!(q.contains(r#""nodes":["N-2"]"#));
    }
}

//! 遠端開 Claude 視窗（第三段）：對應 relay/machine/launcher.mjs，設計見 docs/relay/LAUNCHER.md。
//! - 摘要（profile 名與標籤、cwd 白名單、每小時上限；**不含指令**）附在名單回報，別台的「開新夥伴」才有下拉選單；
//! - 門鈴／輪詢時 `launch_pending` 取走待辦 → 執行前再驗一次（profile、名字格式、不重名、cwd 白名單、每小時上限）
//!   → 開視窗（含自動信任資料夾）→ 等它出現在 `~/.claude/sessions`（30 秒沒出現先回 unconfirmed，3 分鐘內出現補 ok）→ `launch_result`；
//! - 有第一句話就當成 owner 的來信經收發室送進去（由 core.rs 的 `on_launched` 處理）。
//!
//! 指令一律來自本機設定（launcher.json、ASN 偵測到的 CLI）；遠端請求只有 profile 名、視窗名、cwd 三個欄位會被採用。
//! 設定來源（`SystemEnv`）：
//! - 本機 `launcher.json`（若有）：它的 profile 與 `cwd_allow` 一律採用，等同使用者明確同意（與 Node 橋相同）；
//! - bridge.json 的 `allow_remote_launch`（設定頁「允許我的其他設備替這台開新視窗」，預設關）打開後，再加上
//!   ASN 偵測到的 Claude CLI（自動 profile）、啟動偏好的 `cwdAllow` 與「工作資料夾候選」（`launch/cwds.rs`：開著的視窗、信任過的資料夾、最近用過）；
//! - 遠端可開的項目（`remote_allowed`）：Claude 視窗、pi 視窗（沿用 launch/pi.rs 的擴充載入）、Grok／Gemini 背景工作者
//!   （排進 `partner-queue.jsonl`，由 engines/partner_queue.rs 重驗後建工作者；等它記進名冊才回報 ok，失敗讀 partner-queue-failed.jsonl 回中文原因）。
//!   Codex 暫不開放：尚未實機驗證。
use super::core::BridgeLog;
use crate::launch::config::{check_launch, load_launch_config_from, Bootstrap, LaunchConfig, LaunchReq};
use crate::launch::profiles::{LaunchMode, Profile};
use super::engines::partner_queue as pq;
use crate::relay::Relay;
use serde_json::{json, Value};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use tokio::sync::mpsc;

const HOUR_MS: u64 = 3_600_000;
const MAX_CWD: usize = 50;
pub const TRUST_HINT: &str = "視窗已開，但 30 秒內沒出現在名單上：可能卡在「是否信任此資料夾」，請到電腦前按一次 Enter";
pub const NO_CONFIG: &str = "這台電腦還沒有可用的啟動設定";
pub const PI_HINT: &str = "pi 視窗已開，但 30 秒內沒出現在名單上：pi 可能在問要不要信任這個資料夾，或要登入、選模型，請到那台電腦選一次；也可能是 pi 的 ASN 擴充沒載入";
pub const BG_HINT: &str = "背景夥伴已排入，但 30 秒內還沒開出來：請確認這台電腦的 ASN 還在執行；稍後會自動補上結果";
pub const NO_REMOTE_PROFILE: &str = "沒有可以從遠端開啟的設定（目前支援 Claude、pi、Grok、Gemini）";

fn now_ms() -> u64 {
    crate::heartbeat::now_ms()
}

/// 視窗出現後交給核心處理的事件（刷新名單、送第一句話）
#[derive(Clone, Debug, PartialEq)]
pub struct Launched {
    pub id: String,
    pub requested_by: String,
    pub name: String,
    pub first_message: Option<String>,
}

/// 設定與「開視窗」這兩件事抽成介面，測試可換成假的（假設定、假視窗程式）
pub trait LaunchEnv: Send + Sync {
    /// fresh＝要最新的（執行前的再驗一次）；false 可用快取（名單回報每分鐘一次）
    fn config(&self, fresh: bool) -> Result<LaunchConfig, String>;
    /// 開視窗：回外層視窗的 PID。config／profile／name／cwd 都已驗過；pi_args＝經 pi 的 --provider／--model（已驗過，沒帶就是空）
    fn start(&self, config: &LaunchConfig, profile: &str, name: &str, cwd: &str, pi_args: &[String]) -> Result<u32, String>;
    /// 這台 pi 列得出這個提供者／模型嗎（遠端開 pi 帶模型，D2 #422）。預設列不出來＝拒絕
    fn pi_listed(&self, _provider: &str, _model: &str) -> bool {
        false
    }
    /// 背景工作者：再驗一次（授權資料夾、名字、執行檔）後排進佇列，由引擎消化。work_dir＝橋的工作資料夾
    fn enqueue_background(&self, _config: &LaunchConfig, _profile: &str, _name: &str, _cwd: &str, _work_dir: &Path) -> Result<(), String> {
        Err("這台電腦不能開背景夥伴".into())
    }
}

/// 遠端可以開哪些項目：Claude 視窗（沒寫引擎的自訂 profile 視為 Claude）、pi 視窗、Grok／Gemini 背景工作者。
/// Codex 尚未實機驗證，不開放；其他背景設定（自訂 id）不開放，因為工作者的協定與名單引擎名是依 id 對應的。
pub fn remote_allowed(id: &str, p: &Profile) -> bool {
    if p.disabled {
        return false;
    }
    match p.mode {
        LaunchMode::Window => p.engine.is_empty() || p.engine == "claude" || p.engine == "pi",
        LaunchMode::Background => (id == "grok" || id == "gemini") && p.engine == "acp",
    }
}

// ---- 設定組合（純函式，可測）---------------------------------------------------------------------------

/// 把 launcher.json、自動 profile、額外白名單合成遠端開視窗的設定。
/// consent＝使用者在設定打開了「允許其他設備替這台開新視窗」：沒有 launcher.json 又沒同意就整個功能關閉。
pub fn build_remote_config(launcher_file: &Path, bootstrap: Option<Bootstrap>, extra_allow: Vec<String>, consent: bool) -> Result<LaunchConfig, String> {
    if !consent && !launcher_file.is_file() {
        return Err(NO_CONFIG.into());
    }
    let mut cfg = load_launch_config_from(launcher_file, if consent { bootstrap } else { None })?;
    cfg.profiles.retain(|id, p| remote_allowed(id, p));
    if cfg.profiles.is_empty() {
        return Err(NO_REMOTE_PROFILE.into());
    }
    let mut all: Vec<PathBuf> = cfg.cwd_allow.clone();
    if consent {
        for s in extra_allow {
            all.push(PathBuf::from(s));
        }
    }
    // 全部正規化成同一種寫法（Windows 的長路徑前綴），去重、只留真的存在的資料夾
    let mut seen = HashSet::new();
    let mut out = vec![];
    for p in all {
        let Ok(c) = crate::launch::config::canonical_launch_cwd(&p.to_string_lossy()) else { continue };
        if !c.is_dir() || !seen.insert(c.clone()) {
            continue;
        }
        out.push(c);
        if out.len() >= MAX_CWD {
            break;
        }
    }
    if out.is_empty() {
        return Err("工作資料夾白名單是空的".into());
    }
    cfg.cwd_allow = out;
    Ok(cfg)
}

/// 見 [`Launcher::remote_pi_args`]；listed＝這台 pi 列不列得出這組
pub fn remote_pi_args(l: &Value, is_pi: bool, listed: &dyn Fn(&str, &str) -> bool) -> Result<Vec<String>, String> {
    let s = |k: &str| l.get(k).and_then(Value::as_str).unwrap_or("").trim().to_string();
    let (p, m) = (s("pi_provider"), s("pi_model"));
    if p.is_empty() && m.is_empty() {
        return Ok(vec![]);
    }
    if !is_pi {
        return Err("只有經 pi 開的夥伴能指定提供者與模型".into());
    }
    let args = crate::launch::pi_models::model_args(&p, &m)?;
    if !listed(&p, &m) {
        return Err(format!("這台電腦的 pi 沒有「{p}/{m}」這個模型（可能沒登入那一家，或清單剛換過），請重新選一次"));
    }
    Ok(args)
}

/// 給仲介的摘要：不含指令內容。profile 排序固定（claude 在最前）
pub fn summary(cfg: &LaunchConfig) -> Value {
    let mut ids: Vec<&String> = cfg.profiles.keys().collect();
    ids.sort_by(|a, b| (a.as_str() != "claude").cmp(&(b.as_str() != "claude")).then(a.cmp(b)));
    // engine／mode 是附加資訊：舊版手機只讀 id 與 label，多出的欄位會被忽略
    let profiles: Vec<Value> = ids
        .into_iter()
        .map(|id| {
            let p = &cfg.profiles[id];
            json!({ "id": id, "label": p.label, "engine": if p.engine.is_empty() { "claude" } else { p.engine.as_str() }, "mode": if p.mode == LaunchMode::Background { "background" } else { "window" } })
        })
        .collect();
    let cwd: Vec<String> = cfg.cwd_allow.iter().map(|p| crate::launch::cwds::norm_path(&p.to_string_lossy()).unwrap_or_default()).filter(|s| !s.is_empty()).collect();
    json!({ "profiles": profiles, "cwd_allow": cwd, "max_per_hour": cfg.max_per_hour })
}

// ---- 真實環境 ------------------------------------------------------------------------------------------

pub struct SystemEnv {
    pub data_dir: PathBuf,
    cache: Mutex<Option<(std::time::Instant, bool, Result<LaunchConfig, String>)>>,
}

impl SystemEnv {
    pub fn new(data_dir: PathBuf) -> SystemEnv {
        SystemEnv { data_dir, cache: Mutex::new(None) }
    }
    fn build(&self, consent: bool) -> Result<LaunchConfig, String> {
        let file = crate::launch::config::launcher_config_path();
        let extra = if consent {
            let base = crate::launch::config::load_launch_config_from(&file, None).map(|c| c.cwd_allow).unwrap_or_default();
            let mut v = crate::launch::cwds::candidates(&crate::identity::home_dir(), &self.data_dir, &base);
            // 啟動偏好裡使用者明確加過的資料夾（「瀏覽…」）也算
            if let Ok(prefs) = crate::launch::prefs::launch_prefs_get_sync(&self.data_dir) {
                if let Some(a) = prefs.get("cwdAllow").and_then(Value::as_array) {
                    v.extend(a.iter().filter_map(|x| x.as_str().map(String::from)));
                }
            }
            v
        } else {
            vec![]
        };
        build_remote_config(&file, if consent { crate::launch::profiles::bootstrap_config() } else { None }, extra, consent)
    }
}

impl LaunchEnv for SystemEnv {
    fn config(&self, fresh: bool) -> Result<LaunchConfig, String> {
        let consent = super::read_settings(&self.data_dir).allow_remote_launch;
        if !fresh {
            if let Some((t, c, r)) = self.cache.lock().unwrap().as_ref() {
                if *c == consent && t.elapsed() < std::time::Duration::from_secs(30) {
                    return r.clone();
                }
            }
        }
        let r = self.build(consent);
        *self.cache.lock().unwrap() = Some((std::time::Instant::now(), consent, r.clone()));
        r
    }
    fn start(&self, config: &LaunchConfig, profile: &str, name: &str, cwd: &str, pi_args: &[String]) -> Result<u32, String> {
        crate::launch::local::start_remote_window(config, profile, name, cwd, false, pi_args)
    }
    fn pi_listed(&self, provider: &str, model: &str) -> bool {
        crate::launch::pi_models::models_real(false).iter().any(|m| m.provider == provider && m.model == model)
    }
    fn enqueue_background(&self, _config: &LaunchConfig, profile: &str, name: &str, cwd: &str, work_dir: &Path) -> Result<(), String> {
        // 遠端同意過的資料夾（開著的視窗、最近用過…）要讓消化端也認得：和本機開新夥伴一樣記進啟動偏好的白名單（消化端會再驗一次）
        let known = crate::launch::config::canonical_launch_cwd(cwd).ok().is_some_and(|c| crate::launch::config::load_launch_config().is_ok_and(|l| l.cwd_allow.contains(&c)));
        if !known {
            let _ = crate::launch::cwds::add_to_prefs_allow(&self.data_dir, cwd);
        }
        queue_background(&pq::SystemQueueEnv { data_dir: Some(self.data_dir.clone()) }, profile, name, cwd, work_dir)
    }
}

/// 排進佇列前用消化端同一套規則先驗一次（授權資料夾、名字、執行檔），不通過就當場回中文原因；通過才附加一行
pub fn queue_background(env: &dyn pq::QueueEnv, profile: &str, name: &str, cwd: &str, work_dir: &Path) -> Result<(), String> {
    let req = pq::Req { profile: profile.into(), name: name.into(), cwd: cwd.into() };
    pq::build_cfg(env, &req, work_dir)?;
    crate::launch::local::enqueue_background(work_dir, profile, name, cwd)
}

// ---- 流程 ------------------------------------------------------------------------------------------------

pub struct Launcher {
    relay: Arc<Relay>,
    log: Arc<BridgeLog>,
    work_dir: PathBuf,
    env: Arc<dyn LaunchEnv>,
    /// 本機目前的視窗名（~/.claude/sessions 的互動式視窗＋ASN 自己的視窗名）；讀不到回 None
    names: Arc<dyn Fn() -> Option<Vec<String>> + Send + Sync>,
    tx: mpsc::UnboundedSender<Launched>,
    seen: Mutex<HashSet<String>>,
    inflight: Mutex<HashSet<String>>,
    warned: Mutex<String>,
    confirm_ms: u64,
    late_ms: u64,
    poll_ms: u64,
}

impl Launcher {
    pub fn new(relay: Arc<Relay>, log: Arc<BridgeLog>, work_dir: PathBuf, env: Arc<dyn LaunchEnv>, names: Arc<dyn Fn() -> Option<Vec<String>> + Send + Sync>) -> (Arc<Launcher>, mpsc::UnboundedReceiver<Launched>) {
        Launcher::new_with(relay, log, work_dir, env, names, (30_000, 180_000, 2_000))
    }

    /// timing＝（多久沒出現先回 unconfirmed，最久等多久，輪詢間隔），單位毫秒；測試用短的
    pub fn new_with(relay: Arc<Relay>, log: Arc<BridgeLog>, work_dir: PathBuf, env: Arc<dyn LaunchEnv>, names: Arc<dyn Fn() -> Option<Vec<String>> + Send + Sync>, timing: (u64, u64, u64)) -> (Arc<Launcher>, mpsc::UnboundedReceiver<Launched>) {
        let (tx, rx) = mpsc::unbounded_channel();
        let l = Launcher {
            relay, log, work_dir, env, names, tx, seen: Mutex::new(HashSet::new()), inflight: Mutex::new(HashSet::new()), warned: Mutex::new(String::new()),
            confirm_ms: timing.0, late_ms: timing.1, poll_ms: timing.2,
        };
        (Arc::new(l), rx)
    }

    /// 名單回報附的摘要；沒有可用設定回 null（仲介會清掉，別台就不顯示「開新夥伴」）
    pub fn summary(&self) -> Value {
        match self.env.config(false) {
            Ok(c) => {
                *self.warned.lock().unwrap() = String::new();
                let mut s = summary(&c);
                // 有 pi 的啟動設定：多帶這台 pi 能用的模型，手機與別台電腦的「切換模型」才有下拉選單（#443／#444；舊後台會丟掉這個欄位）
                if c.profiles.values().any(|p| p.engine == "pi") {
                    let models = crate::launch::pi_models::summary_models();
                    if !models.is_empty() {
                        s["pi_models"] = Value::Array(models);
                    }
                }
                s
            }
            Err(e) => {
                let mut w = self.warned.lock().unwrap();
                if *w != e {
                    self.log.line(&format!("launcher: {e}"));
                    *w = e;
                }
                Value::Null
            }
        }
    }

    fn history_file(&self) -> PathBuf {
        self.work_dir.join("launch-history.json")
    }
    fn read_history(&self) -> Vec<u64> {
        std::fs::read_to_string(self.history_file()).ok().and_then(|t| serde_json::from_str::<Vec<Value>>(&t).ok()).map(|v| v.iter().filter_map(Value::as_u64).collect()).unwrap_or_default()
    }
    fn write_history(&self, h: &[u64]) {
        let now = now_ms();
        let keep: Vec<u64> = h.iter().copied().filter(|t| now.saturating_sub(*t) < HOUR_MS).collect();
        let _ = std::fs::write(self.history_file(), serde_json::to_string(&keep).unwrap_or_default());
    }
    fn record(&self, l: &Value, status: &str, detail: &str) {
        let s = |k: &str| l.get(k).and_then(Value::as_str).unwrap_or("").to_string();
        let line = json!({ "at": now_ms(), "id": s("id"), "by": s("requested_by"), "profile": s("profile"), "name": s("name"), "cwd": s("cwd"), "status": status, "detail": detail });
        if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(self.work_dir.join("launch.log")) {
            use std::io::Write;
            let _ = writeln!(f, "{line}");
        }
        self.log.line(&format!("launch {} name={} profile={} -> {status}{}", s("id"), s("name"), s("profile"), if detail.is_empty() { String::new() } else { format!(" ({detail})") }));
    }
    async fn report(&self, l: &Value, status: &str, detail: &str) {
        self.record(l, status, detail);
        let id = l.get("id").and_then(Value::as_str).unwrap_or("");
        if let Err(e) = self.relay.api("launch_result", Some(json!({ "id": id, "status": status, "detail": detail }))).await {
            self.log.line(&format!("launch_result failed id={id}: {e}"));
        }
    }

    /// 執行前再驗一次；通過回 Ok(正規化後的 cwd)，不通過回原因（中文，會回報給別台）
    fn verify(&self, cfg: &LaunchConfig, l: &Value, names: &[String]) -> Result<String, String> {
        let s = |k: &str| l.get(k).and_then(Value::as_str).unwrap_or("");
        let (profile, name) = (s("profile"), s("name"));
        let mut req = LaunchReq { profile, name, cwd: s("cwd").to_string() };
        let now = now_ms();
        check_launch(cfg, &mut req, &[], now)?;
        let lower = name.to_lowercase();
        if names.iter().any(|n| n.to_lowercase() == lower) || self.inflight.lock().unwrap().contains(&lower) {
            return Err(format!("已經有叫「{name}」的視窗"));
        }
        let recent = self.read_history();
        if recent.iter().filter(|t| now.saturating_sub(**t) < HOUR_MS).count() >= cfg.max_per_hour as usize {
            return Err(format!("這個小時已經開了 {} 個視窗，超過上限", cfg.max_per_hour));
        }
        Ok(req.cwd)
    }

    /// 遠端開 pi 帶的提供者與模型（D2 #422）→ pi 的參數。沒帶（舊版手機）＝空，用 pi 自己的預設。
    /// 帶了就要：是 pi 的啟動設定、格式對、而且在這台 pi 列得出來的模型裡；不合就拒絕並說明，不退回預設模型
    fn remote_pi_args(&self, l: &Value, is_pi: bool) -> Result<Vec<String>, String> {
        remote_pi_args(l, is_pi, &|p, m| self.env.pi_listed(p, m))
    }

    /// 取走待辦並逐筆處理。驗證與開視窗在這裡做完；等視窗出現的部分丟到背景工作，不擋住收信
    pub async fn pull(self: &Arc<Self>) {
        let v = match self.relay.api("launch_pending", None).await {
            Ok(v) => v,
            Err(e) => {
                if !e.contains("HTTP 404") {
                    self.log.line(&format!("launch_pending failed: {e}"));
                }
                return;
            }
        };
        for l in v.get("launches").and_then(Value::as_array).cloned().unwrap_or_default() {
            self.begin(l).await;
        }
    }

    async fn begin(self: &Arc<Self>, l: Value) {
        let id = l.get("id").and_then(Value::as_str).unwrap_or("").to_string();
        if id.is_empty() || !self.seen.lock().unwrap().insert(id.clone()) {
            return;
        }
        let Some(names) = (self.names)() else {
            return self.report(&l, "failed", "讀不到本機的視窗清單").await;
        };
        let env0 = self.env.clone();
        let cfg = match tokio::task::spawn_blocking(move || env0.config(true)).await.map_err(|e| format!("背景工作失敗：{e}")).and_then(|r| r) {
            Ok(c) => c,
            Err(e) => return self.report(&l, "failed", if e.is_empty() { NO_CONFIG } else { &e }).await,
        };
        let cwd = match self.verify(&cfg, &l, &names) {
            Ok(c) => c,
            Err(why) => return self.report(&l, "failed", &why).await,
        };
        let s = |k: &str| l.get(k).and_then(Value::as_str).unwrap_or("").to_string();
        let (profile, name) = (s("profile"), s("name"));
        let (is_bg, is_pi) = cfg.profiles.get(&profile).map(|p| (p.mode == LaunchMode::Background, p.engine == "pi")).unwrap_or((false, false));
        // 查這台 pi 的模型清單會開外部程序（有快取），放背景執行緒
        let me0 = self.clone();
        let l0 = l.clone();
        let pi_args = match tokio::task::spawn_blocking(move || me0.remote_pi_args(&l0, is_pi)).await.map_err(|e| format!("背景工作失敗：{e}")).and_then(|r| r) {
            Ok(a) => a,
            Err(why) => return self.report(&l, "failed", &why).await,
        };
        let mut h = self.read_history();
        h.push(now_ms());
        self.write_history(&h);
        let lower = name.to_lowercase();
        self.inflight.lock().unwrap().insert(lower.clone());
        let env = self.env.clone();
        let (cfg2, p2, n2, c2) = (cfg.clone(), profile.clone(), name.clone(), cwd.clone());
        if is_bg {
            let since = now_ms();
            let wd = self.work_dir.clone();
            let queued = tokio::task::spawn_blocking(move || env.enqueue_background(&cfg2, &p2, &n2, &c2, &wd)).await.map_err(|e| format!("背景工作失敗：{e}")).and_then(|r| r);
            if let Err(e) = queued {
                self.inflight.lock().unwrap().remove(&lower);
                return self.report(&l, "failed", &format!("開不起來：{e}")).await;
            }
            self.record(&l, "queued", "");
            let me = self.clone();
            tokio::spawn(async move {
                me.wait_for_background(l, since).await;
                me.inflight.lock().unwrap().remove(&lower);
            });
            return;
        }
        let started = tokio::task::spawn_blocking(move || env.start(&cfg2, &p2, &n2, &c2, &pi_args)).await.map_err(|e| format!("背景工作失敗：{e}")).and_then(|r| r);
        let pid = match started {
            Ok(p) => p,
            Err(e) => {
                self.inflight.lock().unwrap().remove(&lower);
                return self.report(&l, "failed", &format!("開不起來：{e}")).await;
            }
        };
        self.record(&l, "spawned", &format!("pid={pid}"));
        let me = self.clone();
        tokio::spawn(async move {
            me.wait_for_window(l, if is_pi { PI_HINT } else { TRUST_HINT }).await;
            me.inflight.lock().unwrap().remove(&lower);
        });
    }

    async fn wait_for_window(&self, l: Value, hint: &str) {
        let s = |k: &str| l.get(k).and_then(Value::as_str).unwrap_or("").to_string();
        let name = s("name");
        let t0 = std::time::Instant::now();
        let mut unconfirmed = false;
        while t0.elapsed().as_millis() < self.late_ms as u128 {
            tokio::time::sleep(std::time::Duration::from_millis(self.poll_ms)).await;
            if (self.names)().map(|n| n.iter().any(|x| *x == name)).unwrap_or(false) {
                self.report(&l, "ok", &format!("{name} 已開啟")).await;
                let first = l.get("first_message").and_then(Value::as_str).map(str::trim).filter(|m| !m.is_empty()).map(String::from);
                let _ = self.tx.send(Launched { id: s("id"), requested_by: s("requested_by"), name, first_message: first });
                return;
            }
            if !unconfirmed && t0.elapsed().as_millis() >= self.confirm_ms as u128 {
                unconfirmed = true;
                self.report(&l, "unconfirmed", hint).await;
            }
        }
        self.record(&l, "gave-up", &format!("{} 分鐘內都沒出現在名單上", self.late_ms / 60_000));
    }

    /// 背景夥伴：等引擎消化佇列。記進名冊＝開出來了（回 ok、通知核心刷新名單與送第一句話）；引擎記了失敗＝回中文原因
    async fn wait_for_background(&self, l: Value, since: u64) {
        let s = |k: &str| l.get(k).and_then(Value::as_str).unwrap_or("").to_string();
        let name = s("name");
        let t0 = std::time::Instant::now();
        let mut unconfirmed = false;
        while t0.elapsed().as_millis() < self.late_ms as u128 {
            tokio::time::sleep(std::time::Duration::from_millis(self.poll_ms)).await;
            match pq::find_outcome(&self.work_dir, &name, since) {
                Some(Ok(())) => {
                    self.report(&l, "ok", &format!("{name} 已開啟")).await;
                    let first = l.get("first_message").and_then(Value::as_str).map(str::trim).filter(|m| !m.is_empty()).map(String::from);
                    let _ = self.tx.send(Launched { id: s("id"), requested_by: s("requested_by"), name, first_message: first });
                    return;
                }
                Some(Err(e)) => return self.report(&l, "failed", &format!("開不起來：{e}")).await,
                None => {}
            }
            if !unconfirmed && t0.elapsed().as_millis() >= self.confirm_ms as u128 {
                unconfirmed = true;
                self.report(&l, "unconfirmed", BG_HINT).await;
            }
        }
        self.record(&l, "gave-up", &format!("{} 分鐘內背景夥伴都沒開出來", self.late_ms / 60_000));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::launch::profiles::Profile;
    use std::collections::HashMap;

    fn prof(label: &str, engine: &str, mode: LaunchMode) -> Profile {
        Profile { label: label.into(), command: "C:\\fake\\tool.exe".into(), args: vec!["-n".into(), "{name}".into()], engine: engine.into(), mode, disabled: false, disabled_reason: String::new() }
    }
    fn bootstrap(allow: Vec<PathBuf>) -> Bootstrap {
        let mut m = HashMap::new();
        m.insert("claude".to_string(), prof("Claude（互動視窗）", "claude", LaunchMode::Window));
        m.insert("codex".to_string(), prof("Codex（互動視窗）", "codex", LaunchMode::Window));
        m.insert("gemini".to_string(), prof("Gemini（背景運行、內建通道）", "acp", LaunchMode::Background));
        m.insert("grok".to_string(), prof("Grok（背景運行、內建通道）", "acp", LaunchMode::Background));
        m.insert("pi".to_string(), prof("pi（互動視窗）", "pi", LaunchMode::Window));
        (m, allow, 6)
    }
    fn write_launcher(dir: &Path, allow: &[&Path], max: u32) -> PathBuf {
        let f = dir.join("launcher.json");
        let j = json!({
            "profiles": {
                "default": { "label": "一般（含 Chrome）", "command": "C:\\secret\\claude.exe", "args": ["--dangerously-skip-permissions", "-n", "{name}"] },
                "cx": { "label": "別的引擎", "command": "codex.exe", "args": ["{name}"], "engine": "codex" },
                "bg": { "label": "背景", "command": "x", "mode": "background" }
            },
            "cwd_allow": allow.iter().map(|p| p.display().to_string()).collect::<Vec<_>>(),
            "max_per_hour": max
        });
        std::fs::write(&f, format!("\u{feff}{j}")).unwrap();
        f
    }

    #[test]
    fn 沒有_launcher_json_也沒同意_整個功能關閉() {
        let d = tempfile::tempdir().unwrap();
        let allow = d.path().join("proj");
        std::fs::create_dir_all(&allow).unwrap();
        let r = build_remote_config(&d.path().join("launcher.json"), Some(bootstrap(vec![allow.clone()])), vec![allow.display().to_string()], false);
        assert_eq!(r.err().as_deref(), Some(NO_CONFIG), "就算有偵測到 CLI 也不能自動開放遠端開視窗");
    }

    #[test]
    fn 只有_launcher_json_時只認它_自動偵測的_profile_與額外資料夾都不加() {
        let d = tempfile::tempdir().unwrap();
        let (a, b) = (d.path().join("a"), d.path().join("b"));
        std::fs::create_dir_all(&a).unwrap();
        std::fs::create_dir_all(&b).unwrap();
        let f = write_launcher(d.path(), &[&a, &d.path().join("不存在")], 3);
        let c = build_remote_config(&f, Some(bootstrap(vec![b.clone()])), vec![b.display().to_string()], false).unwrap();
        assert_eq!(c.profiles.keys().collect::<Vec<_>>(), vec!["default"], "其他引擎、背景型的 profile 這一段不開放");
        assert_eq!(c.cwd_allow.len(), 1, "不存在的資料夾不列");
        assert!(c.cwd_allow[0].ends_with("a"));
        assert_eq!(c.max_per_hour, 3);
        let s = summary(&c);
        assert_eq!(s["profiles"], json!([{ "id": "default", "label": "一般（含 Chrome）", "engine": "claude", "mode": "window" }]));
        assert_eq!(s["max_per_hour"], 3);
        let text = s.to_string();
        assert!(!text.contains("secret") && !text.contains("skip-permissions") && !text.contains("claude.exe"), "摘要不含指令：{text}");
    }

    #[test]
    fn 同意後加上偵測到的_claude_與額外資料夾_去重_claude_排第一() {
        let d = tempfile::tempdir().unwrap();
        let (a, b) = (d.path().join("a"), d.path().join("b"));
        std::fs::create_dir_all(&a).unwrap();
        std::fs::create_dir_all(&b).unwrap();
        let f = d.path().join("none.json");
        let extra = vec![b.display().to_string(), a.display().to_string(), b.display().to_string(), d.path().join("沒這個").display().to_string()];
        let c = build_remote_config(&f, Some(bootstrap(vec![a.clone()])), extra, true).unwrap();
        let mut keys: Vec<&String> = c.profiles.keys().collect();
        keys.sort();
        assert_eq!(keys, vec!["claude", "gemini", "grok", "pi"], "Claude、pi 視窗與 Grok、Gemini 背景；Codex 尚未實機驗證不收");
        assert_eq!(c.cwd_allow.len(), 2, "去重＋略過不存在的");
        let s = summary(&c);
        assert_eq!(s["profiles"][0]["id"], "claude");
        // 有 launcher.json 時同意只是「再加上」，檔案裡的 profile 仍在，排在 claude 後面
        let f2 = write_launcher(d.path(), &[&a], 4);
        let c2 = build_remote_config(&f2, Some(bootstrap(vec![b.clone()])), vec![], true).unwrap();
        assert_eq!(summary(&c2)["profiles"].as_array().unwrap().iter().map(|p| p["id"].as_str().unwrap()).collect::<Vec<_>>(), vec!["claude", "default", "gemini", "grok", "pi"]);
        assert_eq!(c2.max_per_hour, 4);
    }

    #[test]
    fn 白名單全空或沒有可用_profile_回原因() {
        let d = tempfile::tempdir().unwrap();
        let gone = d.path().join("gone");
        let f = write_launcher(d.path(), &[&gone], 3);
        assert_eq!(build_remote_config(&f, None, vec![], false).err().as_deref(), Some("工作資料夾白名單是空的"));
        let mut b = bootstrap(vec![d.path().to_path_buf()]);
        b.0.retain(|k, _| k == "codex");
        assert_eq!(build_remote_config(&d.path().join("x.json"), Some(b), vec![], true).err().as_deref(), Some(NO_REMOTE_PROFILE), "只剩 Codex 就是沒有可開的");
    }

    #[test]
    fn 可開項目矩陣_claude_pi_視窗_grok_gemini_背景_codex_與自訂背景_停用_都不開() {
        let p = |engine: &str, mode: LaunchMode, disabled: bool| Profile { disabled, ..prof("x", engine, mode) };
        assert!(remote_allowed("claude", &p("claude", LaunchMode::Window, false)));
        assert!(remote_allowed("default", &p("", LaunchMode::Window, false)), "沒寫引擎視為 Claude");
        assert!(remote_allowed("pi", &p("pi", LaunchMode::Window, false)));
        assert!(remote_allowed("grok", &p("acp", LaunchMode::Background, false)));
        assert!(remote_allowed("gemini", &p("acp", LaunchMode::Background, false)));
        assert!(!remote_allowed("codex", &p("codex", LaunchMode::Window, false)), "Codex 尚未實機驗證");
        assert!(!remote_allowed("bg", &p("acp", LaunchMode::Background, false)), "自訂 id 的背景設定不開放");
        assert!(!remote_allowed("grok", &p("acp", LaunchMode::Background, true)));
        assert!(!remote_allowed("grok", &p("claude", LaunchMode::Background, false)), "引擎不對");
    }

    #[test]
    fn 摘要帶引擎與模式_排序_claude_第一_不含指令() {
        let d = tempfile::tempdir().unwrap();
        let a = d.path().join("a");
        std::fs::create_dir_all(&a).unwrap();
        let c = build_remote_config(&d.path().join("none.json"), Some(bootstrap(vec![a])), vec![], true).unwrap();
        let s = summary(&c);
        let rows: Vec<(String, String, String)> = s["profiles"].as_array().unwrap().iter().map(|p| (p["id"].as_str().unwrap().into(), p["engine"].as_str().unwrap().into(), p["mode"].as_str().unwrap().into())).collect();
        assert_eq!(
            rows,
            vec![("claude".into(), "claude".into(), "window".into()), ("gemini".into(), "acp".into(), "background".into()), ("grok".into(), "acp".into(), "background".into()), ("pi".into(), "pi".into(), "window".into())]
        );
        assert_eq!(s["profiles"][2]["label"], "Grok（背景運行、內建通道）");
        assert!(!s.to_string().contains("tool.exe"), "摘要不含指令");
    }

    struct FakeQ {
        allow: PathBuf,
        bin: bool,
    }
    impl pq::QueueEnv for FakeQ {
        fn config(&self) -> Result<LaunchConfig, String> {
            let mut profiles = HashMap::new();
            profiles.insert("grok".to_string(), prof("Grok（背景運行、內建通道）", "acp", LaunchMode::Background));
            profiles.insert("claude".to_string(), prof("Claude", "claude", LaunchMode::Window));
            Ok(LaunchConfig { profiles, cwd_allow: vec![crate::launch::config::canonical_launch_cwd(&self.allow.to_string_lossy()).unwrap()], max_per_hour: 6 })
        }
        fn binary_ok(&self, _command: &str) -> bool {
            self.bin
        }
    }

    #[test]
    fn 排進佇列前先驗_缺執行檔_未授權資料夾_壞名字_不是背景設定_都回中文原因且不寫佇列() {
        let d = tempfile::tempdir().unwrap();
        let (work, cwd, other) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
        let ok = FakeQ { allow: cwd.path().to_path_buf(), bin: true };
        let cwd_s = cwd.path().to_string_lossy().to_string();
        let queue = work.path().join(pq::QUEUE_FILE);
        let no_bin = FakeQ { allow: cwd.path().to_path_buf(), bin: false };
        let e = queue_background(&no_bin, "grok", "小格", &cwd_s, work.path()).unwrap_err();
        assert!(e.contains("這台電腦找不到「grok」") && e.contains("請先安裝"), "{e}");
        let e = queue_background(&ok, "grok", "小格", &other.path().to_string_lossy(), work.path()).unwrap_err();
        assert!(e.contains("不在允許清單"), "{e}");
        assert!(queue_background(&ok, "grok", "-壞", &cwd_s, work.path()).unwrap_err().contains("視窗名格式不對"));
        assert!(queue_background(&ok, "claude", "小格", &cwd_s, work.path()).unwrap_err().contains("不是內建通道"));
        assert!(queue_background(&ok, "nope", "小格", &cwd_s, work.path()).unwrap_err().contains("沒有這個啟動設定"));
        assert!(!queue.exists(), "驗不過一行都不能寫進佇列");
        queue_background(&ok, "grok", "小格", &cwd_s, work.path()).unwrap();
        let text = std::fs::read_to_string(&queue).unwrap();
        let v: Value = serde_json::from_str(text.trim()).unwrap();
        assert_eq!((v["profile"].as_str(), v["name"].as_str()), (Some("grok"), Some("小格")));
        let _ = d;
    }
}

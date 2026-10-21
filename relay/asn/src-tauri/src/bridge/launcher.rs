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
//! - 只收 Claude 引擎的「視窗」型 profile（背景夥伴與 Codex 等其他引擎留到第五段）。
use super::core::BridgeLog;
use crate::launch::config::{check_launch, load_launch_config_from, Bootstrap, LaunchConfig, LaunchReq};
use crate::launch::profiles::LaunchMode;
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
    /// 開視窗：回外層視窗的 PID。config／profile／name／cwd 都已驗過
    fn start(&self, config: &LaunchConfig, profile: &str, name: &str, cwd: &str) -> Result<u32, String>;
}

// ---- 設定組合（純函式，可測）---------------------------------------------------------------------------

/// 把 launcher.json、自動 profile、額外白名單合成遠端開視窗的設定。
/// consent＝使用者在設定打開了「允許其他設備替這台開新視窗」：沒有 launcher.json 又沒同意就整個功能關閉。
pub fn build_remote_config(launcher_file: &Path, bootstrap: Option<Bootstrap>, extra_allow: Vec<String>, consent: bool) -> Result<LaunchConfig, String> {
    if !consent && !launcher_file.is_file() {
        return Err(NO_CONFIG.into());
    }
    let mut cfg = load_launch_config_from(launcher_file, if consent { bootstrap } else { None })?;
    // 只收 Claude 引擎的視窗型 profile（沒寫 engine 的自訂 profile 視為 Claude，與 Node 橋相同）
    cfg.profiles.retain(|_, p| p.mode == LaunchMode::Window && !p.disabled && (p.engine.is_empty() || p.engine == "claude"));
    if cfg.profiles.is_empty() {
        return Err("沒有可以從遠端開啟的 Claude 視窗設定".into());
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

/// 給仲介的摘要：不含指令內容。profile 排序固定（claude 在最前）
pub fn summary(cfg: &LaunchConfig) -> Value {
    let mut ids: Vec<&String> = cfg.profiles.keys().collect();
    ids.sort_by(|a, b| (a.as_str() != "claude").cmp(&(b.as_str() != "claude")).then(a.cmp(b)));
    let profiles: Vec<Value> = ids.into_iter().map(|id| json!({ "id": id, "label": cfg.profiles[id].label })).collect();
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
    fn start(&self, config: &LaunchConfig, profile: &str, name: &str, cwd: &str) -> Result<u32, String> {
        crate::launch::local::start_remote_window(config, profile, name, cwd, false)
    }
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
                summary(&c)
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
        let mut h = self.read_history();
        h.push(now_ms());
        self.write_history(&h);
        let lower = name.to_lowercase();
        self.inflight.lock().unwrap().insert(lower.clone());
        let env = self.env.clone();
        let (cfg2, p2, n2, c2) = (cfg.clone(), profile.clone(), name.clone(), cwd.clone());
        let started = tokio::task::spawn_blocking(move || env.start(&cfg2, &p2, &n2, &c2)).await.map_err(|e| format!("背景工作失敗：{e}")).and_then(|r| r);
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
            me.wait_for_window(l).await;
            me.inflight.lock().unwrap().remove(&lower);
        });
    }

    async fn wait_for_window(&self, l: Value) {
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
                self.report(&l, "unconfirmed", TRUST_HINT).await;
            }
        }
        self.record(&l, "gave-up", &format!("{} 分鐘內都沒出現在名單上", self.late_ms / 60_000));
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
        m.insert("gemini".to_string(), prof("Gemini", "acp", LaunchMode::Background));
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
        assert_eq!(s["profiles"], json!([{ "id": "default", "label": "一般（含 Chrome）" }]));
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
        assert_eq!(c.profiles.keys().collect::<Vec<_>>(), vec!["claude"], "只收 Claude 引擎的視窗型 profile");
        assert_eq!(c.cwd_allow.len(), 2, "去重＋略過不存在的");
        let s = summary(&c);
        assert_eq!(s["profiles"][0]["id"], "claude");
        // 有 launcher.json 時同意只是「再加上」，檔案裡的 profile 仍在，排在 claude 後面
        let f2 = write_launcher(d.path(), &[&a], 4);
        let c2 = build_remote_config(&f2, Some(bootstrap(vec![b.clone()])), vec![], true).unwrap();
        assert_eq!(summary(&c2)["profiles"].as_array().unwrap().iter().map(|p| p["id"].as_str().unwrap()).collect::<Vec<_>>(), vec!["claude", "default"]);
        assert_eq!(c2.max_per_hour, 4);
    }

    #[test]
    fn 白名單全空或沒有可用_profile_回原因() {
        let d = tempfile::tempdir().unwrap();
        let gone = d.path().join("gone");
        let f = write_launcher(d.path(), &[&gone], 3);
        assert_eq!(build_remote_config(&f, None, vec![], false).err().as_deref(), Some("工作資料夾白名單是空的"));
        let mut b = bootstrap(vec![d.path().to_path_buf()]);
        b.0.retain(|k, _| k == "gemini");
        assert!(build_remote_config(&d.path().join("x.json"), Some(b), vec![], true).err().unwrap().contains("沒有可以從遠端開啟"));
    }
}

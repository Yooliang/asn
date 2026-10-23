//! 內建橋的其他引擎（第五段）：ACP 背景工作者（Gemini 等）與 Codex 視窗。設計見 docs/design/BRIDGE-ENGINES.md。
//! 對應舊 Node 橋的轉接器介面（relay/machine/engines/，README「轉接器介面」）：列名單、轉交一封信、
//! 非同步回報「已轉交／失敗／回覆」。Claude 引擎仍走原本的收發室 worker（worker.rs），不在這裡。
//! 所有引擎的子程序都是無視窗、乾淨環境（ACP 用白名單、Codex 用過濾清單），PID 記進 engine.pids，ASN 結束或下次啟動時只關記下的 PID。
pub mod acp;
pub mod aegis;
pub mod acp_admin;
pub mod acp_agy;
pub mod acp_approvals;
pub mod acp_client;
pub mod acp_config;
pub mod acp_policy;
pub mod acp_worker;
pub mod codex;
pub mod codex_state;
pub mod rpc;

use super::roster::Window;
use std::collections::HashMap;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use tokio::sync::mpsc;

pub type BoxFut<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// 引擎非同步回報給核心的事件
#[derive(Debug, Clone, PartialEq)]
pub enum EngineEvent {
    /// 信已交給對方（核心此時才 ack 並開始計時）
    Sent(String),
    Fail(String, String),
    /// from＝視窗名；mail_id＝引擎確定這是回哪一封時帶上
    Reply { from: String, text: String, mail_id: Option<String> },
    /// 名單有變（核心立刻重新回報）
    RosterChanged,
    /// 這封信的回覆都交給核心了（只有 [`Engine::ack_after_reply`] 的引擎用）：核心確認寄回都成功才 ack
    Replied(String),
}
pub type EventTx = mpsc::UnboundedSender<EngineEvent>;

/// 引擎要主動寄的信（授權詢問、登入通知）
#[derive(Clone, Debug)]
pub struct Notice {
    pub to_node: String,
    pub to_agent: Option<String>,
    pub body: String,
    pub from_agent: String,
}
pub type Notifier = Arc<dyn Fn(Notice) + Send + Sync>;

/// 一個引擎。deliver 同步失敗＝引擎沒起來（核心把信留在 inbox 不 ack）；其餘結果經事件通道非同步回來
pub trait Engine: Send + Sync {
    fn id(&self) -> &'static str;
    /// 目前視窗名單；None＝這次讀不到（沿用上次的）
    fn list(&self) -> BoxFut<'_, Option<Vec<Window>>>;
    fn deliver(&self, id: &str, to: &str, text: &str) -> Result<(), String>;
    /// 在 tokio 執行環境裡呼叫：啟動長駐的工作者／偵測
    fn start(&self);
    fn stop(&self);
    /// 遠端管理這個引擎的工作者（只有 ACP 有）
    fn acp_admin(&self) -> Option<Arc<dyn acp_admin::AcpAdmin>> {
        None
    }
    /// true＝轉交（Sent）時核心不 ack，等引擎報 [`EngineEvent::Replied`] 且回覆都寄成功才 ack；也不對它送「還沒回覆」的提醒（Aegis 引擎）。其他引擎維持原行為
    fn ack_after_reply(&self) -> bool {
        false
    }
    /// 信上的收件名（例如成員代號）換成名單上的名字；不認得回 None
    fn canonical_name(&self, _name: &str) -> Option<String> {
        None
    }
    /// 沒指定收件人的信的預設視窗名（使用者沒另外指定時才用）
    fn default_window(&self) -> Option<String> {
        None
    }
}

// ---- 記下自己開的子程序 PID ----------------------------------------------------------------------

/// engine.pids：引擎開的子程序（一行一個 pid）。ASN 被硬砍後，下次啟動只關這些、而且父程序還是上一個橋的
pub struct PidBook {
    file: PathBuf,
    pids: Mutex<Vec<u32>>,
}
impl PidBook {
    pub fn new(work_dir: &Path) -> Arc<PidBook> {
        Arc::new(PidBook { file: work_dir.join("engine.pids"), pids: Mutex::new(vec![]) })
    }
    fn save(&self, v: &[u32]) {
        let _ = std::fs::write(&self.file, v.iter().map(|p| format!("{p}\n")).collect::<String>());
    }
    pub fn add(&self, pid: u32) {
        if pid == 0 {
            return;
        }
        let mut g = self.pids.lock().unwrap();
        if !g.contains(&pid) {
            g.push(pid);
        }
        self.save(&g);
    }
    pub fn remove(&self, pid: u32) {
        let mut g = self.pids.lock().unwrap();
        g.retain(|p| *p != pid);
        self.save(&g);
    }
    #[cfg(test)]
    pub fn current(&self) -> Vec<u32> {
        self.pids.lock().unwrap().clone()
    }
}

/// 啟動時清上一個橋留下的引擎子程序：只關 engine.pids 記的、仍活著、而且父程序是上一個橋（已不在）的。回傳 log 行
pub fn cleanup_orphans(work_dir: &Path, self_pid: u32, table: &HashMap<u32, u32>, kill: impl Fn(u32) -> bool) -> Vec<String> {
    let file = work_dir.join("engine.pids");
    let listed: Vec<u32> = std::fs::read_to_string(&file).unwrap_or_default().lines().filter_map(|l| l.trim().parse().ok()).collect();
    let last = std::fs::read_to_string(super::orphans::last_file(work_dir)).ok().and_then(|t| t.trim().parse::<u32>().ok()).unwrap_or(0);
    let mut logs = vec![];
    if !listed.is_empty() {
        let victims = super::orphans::orphans_of(table, last, self_pid);
        for pid in listed.iter().filter(|p| victims.contains(p)) {
            logs.push(format!("killed engine orphan pid={pid} left by previous bridge pid={last}: {}", if kill(*pid) { "ok" } else { "failed" }));
        }
    }
    let _ = std::fs::remove_file(&file);
    logs
}

// ---- 子程序環境 ---------------------------------------------------------------------------------

/// ACP agent 的子程序環境：白名單，不繼承任何金鑰（*_API_KEY、*_TOKEN、*SECRET* 一律不帶）。
/// 登入狀態讀的是各 CLI 自己在 HOME 底下的憑證檔，不靠環境變數。extra＝工作者設定 env_pass 列的變數
pub fn acp_clean_env(vars: &[(String, String)], extra: &[String]) -> Vec<(String, String)> {
    const KEEP: [&str; 27] = [
        "PATH", "PATHEXT", "SYSTEMROOT", "SYSTEMDRIVE", "WINDIR", "COMSPEC", "USERPROFILE", "HOME", "HOMEDRIVE", "HOMEPATH", "APPDATA", "LOCALAPPDATA", "PROGRAMDATA", "PROGRAMFILES", "PROGRAMFILES(X86)", "TEMP", "TMP", "USERNAME",
        "COMPUTERNAME", "OS", "PROCESSOR_ARCHITECTURE", "NUMBER_OF_PROCESSORS", "LANG", "LC_ALL", "TERM",
        "XDG_CONFIG_HOME", "XDG_DATA_HOME",
    ];
    vars.iter().filter(|(k, _)| KEEP.contains(&k.to_uppercase().as_str()) || extra.iter().any(|n| n == k)).cloned().collect()
}

/// Codex 子程序（app-server、codex queue、--version）的環境：
/// 清掉 OPENAI_API_KEY／CODEX_API_KEY（帳務要走使用者自己的 ChatGPT 登入額度）、繼承來的視窗識別（CODEX_THREAD_ID 等）、
/// NO_COLOR、CLAUDE*、仲介金鑰；保留 CODEX_HOME 與其他
pub fn codex_child_env(vars: &[(String, String)]) -> Vec<(String, String)> {
    const DROP: [&str; 10] = ["OPENAI_API_KEY", "CODEX_API_KEY", "CODEX_THREAD_ID", "CODEX_SESSION_ID", "CODEX_CI", "NO_COLOR", "ASN_RELAY_KEY", "ASN_RELAY_ANON_KEY", "IRORI_RELAY_KEY", "IRORI_RELAY_ANON_KEY"];
    let kept: Vec<(String, String)> = vars
        .iter()
        .filter(|(k, _)| {
            let u = k.to_uppercase();
            !(DROP.contains(&u.as_str()) || u.starts_with("CLAUDE") || u.starts_with("CODEX_SANDBOX") || u.starts_with("CODEX_MANAGED"))
        })
        .cloned()
        .collect();
    // 登記過的非金鑰變數新舊名都帶（沒更新的舊程式照樣讀得到）
    crate::envc::mirror_vec(kept)
}

/// 讀環境快照。名字登記在 [`crate::envc::PAIRS`] 的，新名（ASN_）優先、沒有才讀舊名（IRORI_）；其他名字照舊精確比對
pub fn env_get(vars: &[(String, String)], k: &str) -> Option<String> {
    if crate::envc::legacy(k).is_some() {
        return crate::envc::pick_from(vars, k);
    }
    vars.iter().find(|(n, _)| n.eq_ignore_ascii_case(k)).map(|(_, v)| v.clone())
}

// ---- 引擎集合 -----------------------------------------------------------------------------------

/// 建引擎需要的東西
#[derive(Clone)]
pub struct EngineCtx {
    pub log: rpc::Log,
    pub work_dir: PathBuf,
    /// 使用者家目錄（~/.codex 等的位置；測試指到暫存資料夾）
    pub home: PathBuf,
    pub agents_file: PathBuf,
    /// 子程序環境的來源（啟動時的環境變數快照；測試換成假的）
    pub env: Arc<Vec<(String, String)>>,
    pub events: EventTx,
    pub notify: Notifier,
    pub pids: Arc<PidBook>,
}

impl EngineCtx {
    pub fn log(&self, m: impl Into<String>) {
        (self.log)(m.into())
    }
}

pub struct EngineSet {
    engines: Vec<Arc<dyn Engine>>,
    cache: Mutex<HashMap<&'static str, Vec<Window>>>,
    events: EventTx,
}

fn signature(ws: &[Window]) -> Vec<(String, String, Option<String>, String)> {
    ws.iter().map(|w| (w.name.clone(), w.label().to_string(), w.status.clone(), w.engine.clone())).collect()
}

impl EngineSet {
    pub fn new(engines: Vec<Arc<dyn Engine>>, events: EventTx) -> Arc<EngineSet> {
        Arc::new(EngineSet { engines, cache: Mutex::new(HashMap::new()), events })
    }
    pub fn start(&self) {
        for e in &self.engines {
            e.start();
        }
    }
    pub fn stop(&self) {
        for e in &self.engines {
            e.stop();
        }
    }
    /// 各引擎重列一次名單存起來（讀不到的引擎沿用上次的）。名單有變回傳 true
    pub async fn refresh_all(&self) -> bool {
        let mut changed = false;
        for e in &self.engines {
            if let Some(ws) = e.list().await {
                let mut g = self.cache.lock().unwrap();
                if g.get(e.id()).map(|old| signature(old)) != Some(signature(&ws)) {
                    changed = true;
                }
                g.insert(e.id(), ws);
            }
        }
        changed
    }
    /// 這個引擎代號的信是不是「寄回成功才 ack」
    pub fn ack_after_reply(&self, engine: &str) -> bool {
        self.engines.iter().any(|e| e.id() == engine && e.ack_after_reply())
    }
    pub fn canonical_name(&self, name: &str) -> String {
        self.engines.iter().find_map(|e| e.canonical_name(name)).unwrap_or_else(|| name.to_string())
    }
    pub fn default_window(&self) -> Option<String> {
        self.engines.iter().find_map(|e| e.default_window())
    }
    /// ACP 工作者的遠端管理入口（沒載入 ACP 引擎回 None）
    pub fn acp_admin(&self) -> Option<Arc<dyn acp_admin::AcpAdmin>> {
        self.engines.iter().find_map(|e| e.acp_admin())
    }
    /// 至少有一個引擎成功列過名單
    pub fn has_result(&self) -> bool {
        !self.cache.lock().unwrap().is_empty()
    }
    /// 所有引擎最近一次的名單（依引擎載入順序）
    pub fn windows(&self) -> Vec<Window> {
        let g = self.cache.lock().unwrap();
        self.engines.iter().flat_map(|e| g.get(e.id()).cloned().unwrap_or_default()).collect()
    }
    pub fn deliver(&self, engine: &str, id: &str, to: &str, text: &str) -> Result<(), String> {
        match self.engines.iter().find(|e| e.id() == engine) {
            Some(e) => e.deliver(id, to, text),
            None => Err(format!("沒有載入「{engine}」引擎")),
        }
    }
    /// 背景定時重列名單；有變就通知核心立刻回報。回傳的任務在 ASN 結束時被中止
    pub fn spawn_refresher(self: &Arc<Self>, every_ms: u64) -> crate::rt::JoinHandle<()> {
        let me = self.clone();
        crate::rt::spawn(async move {
            loop {
                tokio::time::sleep(std::time::Duration::from_millis(every_ms.max(50))).await;
                if me.refresh_all().await {
                    let _ = me.events.send(EngineEvent::RosterChanged);
                }
            }
        })
    }
}

/// 要載入哪些引擎：ASN_ENGINES（舊名 IRORI_ENGINES；逗號分隔，acp／codex；claude 一律載入）有設就照它，沒設就自動：
/// 有 agents.json 載 acp、有 ~/.codex 資料夾載 codex
pub fn selected(spec: Option<&str>, agents_file: &Path, codex_home: &Path) -> (bool, bool) {
    match spec.map(|s| s.split(',').map(|x| x.trim().to_lowercase()).filter(|x| !x.is_empty()).collect::<Vec<_>>()) {
        Some(list) => (list.iter().any(|x| x == "acp"), list.iter().any(|x| x == "codex")),
        None => (agents_file.is_file(), codex_home.is_dir()),
    }
}

/// 依設定建引擎集合；沒有任何非 Claude 引擎回 None
pub fn build(ctx: &EngineCtx, spec: Option<&str>) -> Option<Arc<EngineSet>> {
    let home = codex::codex_home(&ctx.env, &ctx.home);
    let (want_acp, want_codex) = selected(spec, &ctx.agents_file, &home);
    let mut v: Vec<Arc<dyn Engine>> = vec![];
    // aegis 不自動載入：一定要 ASN_ENGINES 明寫
    if spec.is_some_and(|s| s.split(',').any(|x| x.trim().eq_ignore_ascii_case("aegis"))) {
        v.push(Arc::new(aegis::AegisEngine::new(ctx.clone())));
    }
    if want_acp {
        v.push(Arc::new(acp::AcpEngine::new(ctx.clone(), None)));
    }
    if want_codex {
        v.push(Arc::new(codex::CodexEngine::new(ctx.clone())));
    }
    if v.is_empty() {
        return None;
    }
    Some(EngineSet::new(v, ctx.events.clone()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn kv(v: &[(&str, &str)]) -> Vec<(String, String)> {
        v.iter().map(|(a, b)| (a.to_string(), b.to_string())).collect()
    }

    #[test]
    fn acp_子程序環境是白名單_金鑰不外洩_env_pass_才帶() {
        let vars = kv(&[("PATH", "p"), ("Home", "h"), ("GEMINI_API_KEY", "k"), ("OPENAI_API_KEY", "k2"), ("IRORI_RELAY_KEY", "k3"), ("ASN_RELAY_KEY", "k4"), ("FAKE_X", "1"), ("USERPROFILE", "u")]);
        let out = acp_clean_env(&vars, &[]);
        let names: Vec<&str> = out.iter().map(|(k, _)| k.as_str()).collect();
        assert_eq!(names, vec!["PATH", "Home", "USERPROFILE"]);
        let out = acp_clean_env(&vars, &["FAKE_X".to_string()]);
        assert!(out.iter().any(|(k, _)| k == "FAKE_X"));
        assert!(!out.iter().any(|(k, _)| k.contains("KEY")));
    }

    #[test]
    fn codex_子程序環境_清金鑰與視窗識別_留_codex_home() {
        let vars = kv(&[("PATH", "p"), ("OPENAI_API_KEY", "k"), ("codex_api_key", "k"), ("CODEX_THREAD_ID", "t"), ("CODEX_SANDBOX_NETWORK_DISABLED", "1"), ("CLAUDECODE", "1"), ("NO_COLOR", "1"), ("IRORI_RELAY_KEY", "x"), ("CODEX_HOME", "D:/c"), ("OTHER", "o")]);
        let names: Vec<String> = codex_child_env(&vars).into_iter().map(|(k, _)| k).collect();
        assert_eq!(names, vec!["PATH", "CODEX_HOME", "OTHER"]);
    }

    #[test]
    fn codex_子程序環境_金鑰新舊名都擋_非金鑰的改名變數新舊名都帶() {
        let vars = kv(&[("PATH", "p"), ("ASN_RELAY_KEY", "k1"), ("ASN_RELAY_ANON_KEY", "a1"), ("IRORI_RELAY_KEY", "k2"), ("IRORI_RELAY_ANON_KEY", "a2"), ("IRORI_RELAY_ID", "N")]);
        let out = codex_child_env(&vars);
        let get = |k: &str| out.iter().find(|(n, _)| n == k).map(|(_, v)| v.as_str());
        for secret in ["ASN_RELAY_KEY", "ASN_RELAY_ANON_KEY", "IRORI_RELAY_KEY", "IRORI_RELAY_ANON_KEY"] {
            assert_eq!(get(secret), None, "{secret} 不該帶進子程序");
        }
        assert_eq!(get("IRORI_RELAY_ID"), Some("N"));
        assert_eq!(get("ASN_RELAY_ID"), Some("N"));
    }

    #[test]
    fn env_get_只設舊名_只設新名_兩個都設以新名為準() {
        assert_eq!(env_get(&kv(&[("IRORI_CODEX_BIN", "/o")]), "ASN_CODEX_BIN").as_deref(), Some("/o"));
        assert_eq!(env_get(&kv(&[("ASN_CODEX_BIN", "/n")]), "ASN_CODEX_BIN").as_deref(), Some("/n"));
        assert_eq!(env_get(&kv(&[("ASN_CODEX_BIN", "/n"), ("IRORI_CODEX_BIN", "/o")]), "ASN_CODEX_BIN").as_deref(), Some("/n"));
        assert_eq!(env_get(&kv(&[("OTHER", "x")]), "other").as_deref(), Some("x"), "沒登記的名字照舊大小寫不分比對");
    }

    #[test]
    fn 選引擎_有設就照它_沒設就自動() {
        let d = tempfile::tempdir().unwrap();
        let (f, h) = (d.path().join("agents.json"), d.path().join(".codex"));
        assert_eq!(selected(None, &f, &h), (false, false));
        std::fs::write(&f, "{}").unwrap();
        std::fs::create_dir_all(&h).unwrap();
        assert_eq!(selected(None, &f, &h), (true, true));
        assert_eq!(selected(Some("claude"), &f, &h), (false, false), "ASN_ENGINES=claude 關掉其他引擎");
        assert_eq!(selected(Some("claude, ACP"), &f, &h), (true, false));
        assert_eq!(selected(Some("codex"), &f, &h), (false, true));
    }

    /// 守門：引擎開的每個子程序都先清掉環境（再套用過濾後的），不然呼叫端身上的金鑰會一路傳進 Gemini／Codex。
    /// 本檔（有測試字串）不掃自己。
    #[test]
    fn 守門_引擎的每個子程序都先清環境_acp_用白名單_codex_用過濾清單() {
        let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("src").join("bridge").join("engines");
        let needle = ["Command", "::new("].concat();
        let (mut seen, mut bad) = (0, vec![]);
        for e in std::fs::read_dir(&dir).unwrap().flatten() {
            let name = e.file_name().to_string_lossy().to_string();
            if !name.ends_with(".rs") || name == "mod.rs" {
                continue;
            }
            let src = std::fs::read_to_string(e.path()).unwrap();
            let mut from = 0;
            while let Some(i) = src[from..].find(&needle) {
                let at = from + i + needle.len();
                seen += 1;
                let mut end = (at + 700).min(src.len());
                while !src.is_char_boundary(end) {
                    end -= 1;
                }
                let tail = &src[at..end];
                let tail = tail.find(&needle).map(|n| &tail[..n]).unwrap_or(tail);
                if !tail.contains(".env_clear()") {
                    bad.push(format!("{name}（第 {} 行）", src[..at].matches('\n').count() + 1));
                }
                from = at;
            }
        }
        assert!(seen >= 2, "掃描器壞了：只掃到 {seen} 處");
        assert!(bad.is_empty(), "這些子程序沒有先 env_clear，會繼承呼叫端的環境：{bad:?}");
        // 傳進去的環境一定先過濾：ACP 兩種驅動用白名單、Codex 用過濾清單
        for (file, src, f) in [("acp.rs", include_str!("acp.rs"), "acp_clean_env(&"), ("acp_agy.rs", include_str!("acp_agy.rs"), "acp_clean_env(&"), ("codex.rs", include_str!("codex.rs"), "codex_child_env(&")] {
            assert!(src.contains(f), "{file} 的子程序環境沒有經過 {f}");
        }
        assert!(!include_str!("acp_client.rs").contains("std::env::vars"), "ACP 用戶端不能直接用目前的環境");
    }

    #[test]
    fn pid_帳本_只關記下的_而且父程序是上一個橋() {
        let d = tempfile::tempdir().unwrap();
        let book = PidBook::new(d.path());
        book.add(11);
        book.add(12);
        book.add(11);
        book.remove(12);
        assert_eq!(book.current(), vec![11]);
        book.add(13);
        std::fs::write(super::super::orphans::last_file(d.path()), "5").unwrap();
        // 11 是上一個橋(5)的孩子、已不在表裡的 13 不碰、14 沒記在帳本上不碰
        let table: HashMap<u32, u32> = [(11, 5), (14, 5), (20, 1)].into_iter().collect();
        let killed = Mutex::new(vec![]);
        let logs = cleanup_orphans(d.path(), 99, &table, |p| {
            killed.lock().unwrap().push(p);
            true
        });
        assert_eq!(*killed.lock().unwrap(), vec![11]);
        assert_eq!(logs.len(), 1);
        assert!(!d.path().join("engine.pids").exists(), "清完帳本");
        // 上一個橋還活著（在表裡）：什麼都不碰
        book.add(11);
        let alive: HashMap<u32, u32> = [(5, 1), (11, 5)].into_iter().collect();
        assert!(cleanup_orphans(d.path(), 99, &alive, |_| panic!("不該殺")).is_empty());
    }
}

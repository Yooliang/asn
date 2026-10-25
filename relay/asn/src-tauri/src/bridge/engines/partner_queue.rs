//! 消化「開新夥伴」寫下的背景工作者請求（對應 relay/machine/partner-background.mjs 的 partnerQueue 與 bridge.mjs 的 startBackgroundPartner）。
//!
//! 使用者在 ASN 選 Grok／Gemini 這類背景模式的 profile，launch/local.rs 把 {profile,name,cwd} 一行行附加到 `<work_dir>/partner-queue.jsonl`；
//! 內建橋每個定時檢查（約 5 秒）把整個檔案「改名認領」後逐行處理（改名是原子的：同一份請求不會被處理兩次；處理完刪掉認領檔）。
//! 逐行處理：讀得懂 → 依本機啟動設定重驗（profile 存在且是背景模式、名字合法、工作資料夾在授權清單內、指令找得到）→ 建專屬 ACP 工作者。
//! 任何一步不成立都回中文原因（呼叫端記 log），不沉默成功。
//! 名單引擎名由 profile 名稱對應（grok→grok、gemini→gemini），和接手／重開／關閉（acp_admin）找工作者的條件一致。
//! 持久化：成功開出的工作者記在 `<work_dir>/acp-partners.json`（寫法同 acp-adopted.json：原子寫檔、版本 1），ASN 重啟後依 profile 重建；對話編號由 acp-workers.json 帳本接續。
use super::acp_config::{normalize_worker, WorkerCfg};
use crate::launch::config::{build_spawn_spec, check_launch, load_launch_config, LaunchConfig, LaunchReq};
use crate::launch::profiles::LaunchMode;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};

pub const QUEUE_FILE: &str = "partner-queue.jsonl";
pub const PARTNERS_FILE: &str = "acp-partners.json";

#[derive(Debug, Clone, PartialEq)]
pub struct Req {
    pub profile: String,
    pub name: String,
    pub cwd: String,
}

/// 驗證要用的本機環境（測試換成假的）
pub trait QueueEnv: Send + Sync {
    /// 目前的啟動設定（含本機使用者同意過的工作資料夾）
    fn config(&self) -> Result<LaunchConfig, String>;
    /// 指令（已展開變數）找得到嗎
    fn binary_ok(&self, command: &str) -> bool;
}

pub struct SystemQueueEnv {
    pub data_dir: Option<PathBuf>,
}

impl QueueEnv for SystemQueueEnv {
    fn config(&self) -> Result<LaunchConfig, String> {
        let mut c = load_launch_config()?;
        // 開新夥伴時使用者在介面選過／瀏覽過的資料夾記在 launch-prefs.json 的 cwdAllow；送出前本機已驗過，這裡併進來再驗一次
        if let Some(dd) = &self.data_dir {
            if let Ok(prefs) = crate::launch::prefs::launch_prefs_get_sync(dd) {
                for s in prefs.get("cwdAllow").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str) {
                    if let Ok(p) = crate::launch::config::canonical_launch_cwd(s.trim()) {
                        if !c.cwd_allow.contains(&p) {
                            c.cwd_allow.push(p);
                        }
                    }
                }
            }
        }
        Ok(c)
    }

    fn binary_ok(&self, command: &str) -> bool {
        if command.contains('/') || command.contains('\\') {
            Path::new(command).is_file()
        } else {
            crate::agent_tools::resolve_binary(command).is_some()
        }
    }
}

pub fn parse_line(line: &str) -> Result<Req, String> {
    let v: Value = serde_json::from_str(line).map_err(|_| format!("請求讀不懂（不是合法的 JSON）：{}", line.chars().take(80).collect::<String>()))?;
    let s = |k: &str| v.get(k).and_then(Value::as_str).map(str::trim).unwrap_or("").to_string();
    let r = Req { profile: s("profile"), name: s("name"), cwd: s("cwd") };
    if r.profile.is_empty() || r.name.is_empty() || r.cwd.is_empty() {
        return Err("請求缺少模型、名字或工作資料夾".into());
    }
    Ok(r)
}

/// 認領並讀出佇列裡所有的行（空行略過）。沒有檔案＝沒有請求。認領＝把檔案改名成專屬的暫存名，之後附加的請求寫進新檔、下一輪處理
pub fn claim(work_dir: &Path) -> Result<Vec<String>, String> {
    let file = work_dir.join(QUEUE_FILE);
    if !file.exists() {
        return Ok(vec![]);
    }
    static SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let tmp = work_dir.join(format!("partner-queue.{}.{}.work", std::process::id(), SEQ.fetch_add(1, std::sync::atomic::Ordering::SeqCst)));
    if let Err(e) = std::fs::rename(&file, &tmp) {
        return if e.kind() == std::io::ErrorKind::NotFound { Ok(vec![]) } else { Err(format!("認領不了 {QUEUE_FILE}：{e}")) };
    }
    let bytes = std::fs::read(&tmp).map_err(|e| format!("讀不了認領後的請求檔：{e}"))?;
    let _ = std::fs::remove_file(&tmp);
    Ok(String::from_utf8_lossy(&bytes).lines().map(|l| l.trim().trim_start_matches('\u{feff}').to_string()).filter(|l| !l.is_empty()).collect())
}

/// profile 名稱 → (ACP 協定, 名單上的引擎名)。grok 走標準 ACP；其他（gemini 用 agy）走 agy 原生；名單引擎名＝profile 名稱，不認得的用 acp
pub fn protocol_and_roster(profile_id: &str) -> (&'static str, &'static str) {
    match profile_id {
        "grok" => ("acp", "grok"),
        "gemini" => ("agy-stream", "gemini"),
        _ => ("agy-stream", "acp"),
    }
}

/// 驗證請求並組出工作者設定。權限同 Node 版：讀、上網放行，寫檔、執行指令、其他一律拒絕
pub fn build_cfg(env: &dyn QueueEnv, req: &Req, work_dir: &Path) -> Result<WorkerCfg, String> {
    let config = env.config().map_err(|e| format!("啟動設定不可用：{e}"))?;
    let mut lr = LaunchReq { profile: &req.profile, name: &req.name, cwd: req.cwd.clone() };
    check_launch(&config, &mut lr, &[], 0).map_err(|e| format!("{e}（模型 {}、名字 {}）", req.profile, req.name))?;
    let prof = config.profiles.get(&req.profile).ok_or_else(|| format!("沒有這個啟動設定：{}", req.profile))?;
    if prof.mode != LaunchMode::Background {
        return Err(format!("「{}」不是背景工作者的啟動設定，不能用這條路開", req.profile));
    }
    let (command, args, cwd) = build_spawn_spec(&config, &lr)?;
    if !env.binary_ok(&command) {
        return Err(format!("找不到「{}」的執行檔（{command}），請確認已安裝", req.profile));
    }
    let (protocol, roster) = protocol_and_roster(&req.profile);
    let cwd = crate::launch::local::strip_verbatim_prefix(&cwd.to_string_lossy());
    let raw = json!({
        "name": req.name, "engine": "acp", "protocol": protocol, "command": command, "args": args, "cwd": cwd,
        "roster_engine": roster, "label": prof.label,
        "permissions": { "read": "allow", "write": "deny", "execute": "deny", "network": "allow", "other": "deny" },
    });
    let (cfg, _warnings) = normalize_worker(&raw, work_dir, 0).map_err(|e| format!("工作者設定不合法：{e}"))?;
    Ok(cfg)
}

/// 已開出的背景工作者名冊：[(名字, profile, cwd)]
pub fn read_partners(file: &Path) -> Vec<(String, String, String)> {
    let Ok(t) = std::fs::read_to_string(file) else { return vec![] };
    let Ok(v) = serde_json::from_str::<Value>(&t) else { return vec![] };
    v.get("partners")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|e| {
            let g = |k: &str| e.get(k).and_then(Value::as_str).map(String::from).filter(|s| !s.is_empty());
            Some((g("name")?, g("profile")?, g("cwd")?))
        })
        .collect()
}

/// 把一筆記進名冊（同名取代）
pub fn remember(file: &Path, name: &str, profile: &str, cwd: &str) {
    let mut list = read_partners(file);
    list.retain(|(n, _, _)| !n.eq_ignore_ascii_case(name));
    list.push((name.to_string(), profile.to_string(), cwd.to_string()));
    let arr: Vec<Value> = list.iter().map(|(n, p, c)| json!({ "name": n, "profile": p, "cwd": c })).collect();
    let _ = crate::write_atomic(file, &json!({ "version": 1, "partners": arr }).to_string());
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::bridge::engines::acp::AcpEngine;
    use crate::bridge::engines::{Engine, EngineCtx, EngineEvent, PidBook};
    use crate::launch::profiles::Profile;
    use std::collections::HashMap;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{Arc, Mutex};

    struct FakeEnv {
        allow: PathBuf,
        bin_ok: AtomicBool,
    }

    fn fake_worker() -> String {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../../machine/test/fake-acp-worker.mjs").display().to_string()
    }

    impl QueueEnv for FakeEnv {
        fn config(&self) -> Result<LaunchConfig, String> {
            let p = |label: &str, mode: LaunchMode| Profile { label: label.into(), command: "node".into(), args: vec![fake_worker()], engine: "acp".into(), mode, disabled: false, disabled_reason: String::new() };
            let mut profiles = HashMap::new();
            profiles.insert("grok".to_string(), p("Grok（背景工作者）", LaunchMode::Background));
            profiles.insert("gemini".to_string(), p("Gemini（背景工作者）", LaunchMode::Background));
            profiles.insert("claude".to_string(), p("Claude", LaunchMode::Window));
            Ok(LaunchConfig { profiles, cwd_allow: vec![crate::launch::config::canonical_launch_cwd(&self.allow.to_string_lossy()).unwrap()], max_per_hour: 6 })
        }
        fn binary_ok(&self, _command: &str) -> bool {
            self.bin_ok.load(Ordering::SeqCst)
        }
    }

    fn env_for(allow: &Path) -> Arc<FakeEnv> {
        Arc::new(FakeEnv { allow: allow.to_path_buf(), bin_ok: AtomicBool::new(true) })
    }

    fn req(profile: &str, name: &str, cwd: &Path) -> Req {
        Req { profile: profile.into(), name: name.into(), cwd: cwd.to_string_lossy().into() }
    }

    fn queue_line(profile: &str, name: &str, cwd: &Path) -> String {
        json!({ "profile": profile, "name": name, "cwd": cwd.to_string_lossy() }).to_string()
    }

    #[test]
    fn 設定_grok_是標準_acp_名單引擎_grok_gemini_是_agy_名單引擎_gemini_權限唯讀() {
        let d = tempfile::tempdir().unwrap();
        let env = env_for(d.path());
        let g = build_cfg(&*env, &req("grok", "小格", d.path()), d.path()).unwrap();
        assert_eq!((g.protocol.as_str(), g.roster_engine.as_str(), g.label.as_str(), g.adopted), ("acp", "grok", "Grok（背景工作者）", false));
        let m = build_cfg(&*env, &req("gemini", "小雙", d.path()), d.path()).unwrap();
        assert_eq!((m.protocol.as_str(), m.roster_engine.as_str()), ("agy-stream", "gemini"));
        use crate::bridge::engines::acp_policy::Verdict;
        assert_eq!((g.permissions.rule("read"), g.permissions.rule("write"), g.permissions.rule("execute"), g.permissions.rule("other")), (Verdict::Allow, Verdict::Deny, Verdict::Deny, Verdict::Deny));
        assert!(g.cwd.ends_with(d.path().file_name().unwrap()), "{:?}", g.cwd);
    }

    #[test]
    fn 失敗路徑_每一種都有中文原因() {
        let d = tempfile::tempdir().unwrap();
        let other = tempfile::tempdir().unwrap();
        let env = env_for(d.path());
        let e = |r: Req| build_cfg(&*env, &r, d.path()).unwrap_err();
        assert!(e(req("nope", "A", d.path())).contains("沒有這個啟動設定"));
        assert!(e(req("grok", "A", other.path())).contains("不在允許清單"));
        assert!(e(req("grok", "-壞", d.path())).contains("視窗名格式不對"));
        assert!(e(req("grok", "A", &d.path().join("不存在"))).contains("不在允許清單"));
        assert!(e(req("claude", "A", d.path())).contains("不是背景工作者"));
        env.bin_ok.store(false, Ordering::SeqCst);
        assert!(e(req("grok", "A", d.path())).contains("找不到"));
        assert!(parse_line("{壞").unwrap_err().contains("讀不懂"));
        assert!(parse_line(r#"{"profile":"grok","name":"","cwd":"x"}"#).unwrap_err().contains("缺少"));
    }

    #[test]
    fn 認領_逐行讀出_檔案被拿走_認領後附加的進新檔_空行與_bom_略過() {
        let d = tempfile::tempdir().unwrap();
        assert!(claim(d.path()).unwrap().is_empty(), "沒有檔案");
        let f = d.path().join(QUEUE_FILE);
        std::fs::write(&f, "\u{feff}{\"a\":1}\n\n  {\"b\":2}  \r\n").unwrap();
        assert_eq!(claim(d.path()).unwrap(), vec![r#"{"a":1}"#.to_string(), r#"{"b":2}"#.to_string()]);
        assert!(!f.exists(), "認領後原檔不在");
        assert!(claim(d.path()).unwrap().is_empty(), "同一份不會被認領兩次");
        assert!(std::fs::read_dir(d.path()).unwrap().flatten().all(|e| !e.file_name().to_string_lossy().ends_with(".work")), "認領檔已刪");
        std::fs::write(&f, "{\"c\":3}\n").unwrap();
        assert_eq!(claim(d.path()).unwrap(), vec![r#"{"c":3}"#.to_string()]);
    }

    struct H {
        eng: AcpEngine,
        work: tempfile::TempDir,
        cwd: tempfile::TempDir,
        env: Arc<FakeEnv>,
        logs: Arc<Mutex<Vec<String>>>,
        rx: tokio::sync::mpsc::UnboundedReceiver<EngineEvent>,
    }
    impl H {
        fn new() -> H {
            let work = tempfile::tempdir().unwrap();
            let cwd = tempfile::tempdir().unwrap();
            let env = env_for(cwd.path());
            let (eng, logs, rx) = Self::engine(work.path(), &env);
            H { eng, work, cwd, env, logs, rx }
        }
        fn engine(work: &Path, env: &Arc<FakeEnv>) -> (AcpEngine, Arc<Mutex<Vec<String>>>, tokio::sync::mpsc::UnboundedReceiver<EngineEvent>) {
            let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
            let logs: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(vec![]));
            let l2 = logs.clone();
            let ctx = EngineCtx {
                log: Arc::new(move |m| l2.lock().unwrap().push(m)),
                work_dir: work.to_path_buf(),
                home: work.to_path_buf(),
                agents_file: work.join("agents.json"),
                env: Arc::new(std::env::vars().collect()),
                events: tx,
                notify: Arc::new(|_| {}),
                pids: PidBook::new(work),
                data_dir: None,
            };
            let eng = AcpEngine::new(ctx, None);
            eng.set_queue_env(env.clone());
            eng.start();
            (eng, logs, rx)
        }
        fn enqueue(&self, lines: &[String]) {
            use std::io::Write;
            let mut f = std::fs::OpenOptions::new().create(true).append(true).open(self.work.path().join(QUEUE_FILE)).unwrap();
            for l in lines {
                writeln!(f, "{l}").unwrap();
            }
        }
        fn log_text(&self) -> String {
            self.logs.lock().unwrap().join("\n")
        }
        async fn roster(&self) -> Vec<(String, Option<String>)> {
            self.eng.list().await.unwrap().into_iter().map(|w| (w.name, w.engine_label)).collect()
        }
    }

    #[tokio::test]
    async fn 消化_grok_gemini_出現在名單_引擎名正確_admin_找得到_佇列清空_名冊寫檔() {
        let mut h = H::new();
        h.enqueue(&[queue_line("grok", "小格", h.cwd.path()), queue_line("gemini", "小雙", h.cwd.path())]);
        assert!(h.roster().await.is_empty(), "還沒輪詢不會有工作者");
        h.eng.poll();
        let mut r = h.roster().await;
        r.sort();
        assert_eq!(r, vec![("小格".to_string(), Some("grok".to_string())), ("小雙".to_string(), Some("gemini".to_string()))], "{}", h.log_text());
        assert!(!h.work.path().join(QUEUE_FILE).exists(), "佇列處理完清掉");
        assert!(matches!(h.rx.try_recv(), Ok(EngineEvent::RosterChanged)), "名單有變要通知核心");
        let admin = h.eng.acp_admin().unwrap();
        assert!(admin.has_worker("小格") && admin.has_worker("小雙"));
        assert_eq!(admin.info("小格").unwrap()["engine"], "grok", "選單／接手靠這個引擎名找人");
        assert_eq!(admin.info("小雙").unwrap()["engine"], "gemini");
        let saved = read_partners(&h.work.path().join(PARTNERS_FILE));
        assert_eq!(saved.iter().map(|s| (s.0.as_str(), s.1.as_str())).collect::<Vec<_>>(), vec![("小格", "grok"), ("小雙", "gemini")]);
        h.eng.stop();
    }

    #[tokio::test]
    async fn 去重_同名不重複建立_失敗都記_log_有中文原因() {
        let h = H::new();
        h.enqueue(&[queue_line("grok", "小格", h.cwd.path())]);
        h.eng.poll();
        h.enqueue(&[queue_line("grok", "小格", h.cwd.path()), queue_line("gemini", "小格", h.cwd.path())]);
        h.eng.poll();
        assert_eq!(h.roster().await.len(), 1, "同名只會有一個");
        let t = h.log_text();
        assert_eq!(t.matches("已經有叫「小格」的工作者").count(), 2, "{t}");
        assert_eq!(read_partners(&h.work.path().join(PARTNERS_FILE)).len(), 1);
        // 壞請求、profile 不存在、資料夾未授權、指令找不到：都有中文原因，不新增工作者
        let other = tempfile::tempdir().unwrap();
        h.enqueue(&["{壞".into(), queue_line("nope", "甲", h.cwd.path()), queue_line("grok", "乙", other.path())]);
        h.env.bin_ok.store(false, Ordering::SeqCst);
        h.enqueue(&[queue_line("grok", "丙", h.cwd.path())]);
        h.eng.poll();
        let t = h.log_text();
        for want in ["讀不懂", "沒有這個啟動設定：nope", "不在允許清單", "找不到「grok」的執行檔"] {
            assert!(t.contains(want), "缺 {want}：{t}");
        }
        assert_eq!(h.roster().await.len(), 1);
        h.eng.stop();
    }

    #[tokio::test]
    async fn 重啟後依名冊建回_授權不成立的留在名冊不啟動並記_log() {
        let h = H::new();
        h.enqueue(&[queue_line("grok", "小格", h.cwd.path()), queue_line("gemini", "小雙", h.cwd.path())]);
        h.eng.poll();
        assert_eq!(h.roster().await.len(), 2);
        h.eng.stop();
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        let (eng2, logs2, _rx2) = H::engine(h.work.path(), &h.env);
        let mut names: Vec<(String, Option<String>)> = eng2.list().await.unwrap().into_iter().map(|w| (w.name, w.engine_label)).collect();
        names.sort();
        assert_eq!(names, vec![("小格".to_string(), Some("grok".to_string())), ("小雙".to_string(), Some("gemini".to_string()))], "{:?}", logs2.lock().unwrap());
        eng2.stop();
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        let env3 = env_for(h.work.path());
        let (eng3, logs3, _rx3) = H::engine(h.work.path(), &env3);
        assert!(eng3.list().await.unwrap().is_empty(), "資料夾不在授權清單內不啟動");
        assert!(logs3.lock().unwrap().join("\n").contains("重啟後沒能建回背景工作者"));
        assert_eq!(read_partners(&h.work.path().join(PARTNERS_FILE)).len(), 2, "名冊保留");
        eng3.stop();
    }
}

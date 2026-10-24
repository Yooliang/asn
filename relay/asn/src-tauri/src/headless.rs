//! 無視窗橋（asn-bridge）的主體：沒有 Tauri、沒有視窗，只跑內建收發室核心（收信、門鈴、名單回報、各引擎）。
//! 設計見 docs/design/LINUX-HEADLESS.md。執行檔 `src/bin/asn_bridge.rs` 只是呼叫這裡的 [`main_with`]。
//!
//! 資料夾：`ASN_HOME`（舊名 `IRORI_HOME`）→ `~/.asn` → 舊的 `~/.irori-relay`，規則與 `relay/machine/home.mjs` 相同（寫在 `home.rs`）。
//! 金鑰、節點代號、anon 金鑰的讀法與電腦版同一份（`identity.rs`）：環境變數優先，其次資料夾裡的檔案；金鑰絕不進 log。
//! 結束碼：0 正常結束、2 設定錯誤（找不到金鑰等）、3 另一個收信者在跑（單元檔用 `RestartPreventExitStatus=3 2` 不重啟）。

use std::io::Write;
use std::sync::Arc;

/// 解析後的命令
#[derive(Debug, PartialEq, Eq)]
pub enum Cmd {
    Help,
    Version,
    Run(RunOpts),
    /// 裝置授權登入：印短碼、等人在已登入的 ASN 核准、把金鑰存進資料夾
    Login(LoginOpts),
}

#[derive(Debug, PartialEq, Eq, Default, Clone)]
pub struct LoginOpts {
    /// 後端網址（沒給就看 ASN_RELAY_URL，再沒有用預設）
    pub url: Option<String>,
    /// 存金鑰的資料夾（沒給就看 ASN_HOME，再沒有用 ~/.asn）
    pub home: Option<String>,
}

#[derive(Debug, PartialEq, Eq, Default, Clone)]
pub struct RunOpts {
    /// 只有引擎：不啟動 `claude -p` 收發室 worker
    pub engine_only: bool,
    /// 收件匣模式：不啟動 worker、不需 Aegis，收到的信存進 `<ASN_HOME>/inbox/inbox.jsonl`，由代理用 `asn-cli inbox` 讀、自己用 `asn-cli send` 回信
    pub inbox: bool,
    /// 自動回信模式：worker 自己當一個對外可收信的視窗（名字取 ASN_INBOX_NAME，預設節點代號），收到的信與群組訊息由它回答並寄回
    pub respond: bool,
}

const USAGE: &str = "用法：asn-bridge run [--engine-only | --inbox | --respond]\n       asn-bridge login [--url <後端網址>] [--home <資料夾>]\n\
  login          還沒有金鑰時用：印出短碼，請人在已登入的 ASN 輸入核准，金鑰自動存進資料夾的 <代號>.key（權限 600，不會顯示）\n\
  run            讀資料夾（ASN_HOME，預設 ~/.asn，舊的 ~/.irori-relay 也認）裡的節點金鑰，啟動內建收發室核心（收信、門鈴、名單回報）\n\
  --engine-only  只有引擎：不啟動 claude -p 收發室 worker（也可設環境變數 ASN_BRIDGE_ENGINE_ONLY=1）\n\
  --inbox        收件匣模式：不啟動 worker、不需 Aegis；信先存進 <ASN_HOME>/inbox/inbox.jsonl（fsync 後才 ack），代理用 asn-cli inbox 讀、asn-cli send 回信\n\
                 （視窗名取 ASN_INBOX_NAME，預設節點代號；也可設環境變數 ASN_BRIDGE_INBOX=1）\n\
  --respond      自動回信模式：沒有互動視窗的 Linux 主機，讓內建 claude -p 自己當一個可收信的視窗（名單回報、收信、群組叫醒都由它回答並寄回；需已登入 claude）\n\
                 （視窗名取 ASN_INBOX_NAME，預設節點代號；也可設環境變數 ASN_RESPOND=1；與 --inbox、--engine-only 互斥）\n\
  --version      顯示版本\n\
  --help         顯示這段說明";

/// 解析命令列（不含程式名）。`env_engine_only`＝環境變數 ASN_BRIDGE_ENGINE_ONLY 的值
pub fn parse_args(args: &[String], env_engine_only: Option<&str>) -> Result<Cmd, String> {
    parse_args_env(args, env_engine_only, None)
}

/// 同上，另外帶環境變數 ASN_BRIDGE_INBOX 的值
pub fn parse_args_env(args: &[String], env_engine_only: Option<&str>, env_inbox: Option<&str>) -> Result<Cmd, String> {
    parse_args_envs(args, env_engine_only, env_inbox, None)
}

/// 同上，另外帶環境變數 ASN_RESPOND 的值
pub fn parse_args_envs(args: &[String], env_engine_only: Option<&str>, env_inbox: Option<&str>, env_respond: Option<&str>) -> Result<Cmd, String> {
    let mut it = args.iter();
    match it.next().map(String::as_str) {
        None | Some("-h") | Some("--help") | Some("help") => Ok(Cmd::Help),
        Some("-V") | Some("--version") | Some("version") => Ok(Cmd::Version),
        Some("login") => {
            let mut o = LoginOpts::default();
            while let Some(a) = it.next() {
                match a.as_str() {
                    "--url" => o.url = Some(it.next().ok_or("--url 後面要接網址")?.clone()),
                    "--home" => o.home = Some(it.next().ok_or("--home 後面要接資料夾")?.clone()),
                    other => return Err(format!("不認得的參數：{other}")),
                }
            }
            Ok(Cmd::Login(o))
        }
        Some("run") => {
            let mut o = RunOpts { engine_only: truthy(env_engine_only), inbox: truthy(env_inbox), respond: truthy(env_respond) };
            for a in it {
                match a.as_str() {
                    "--engine-only" => o.engine_only = true,
                    "--inbox" => o.inbox = true,
                    "--respond" => o.respond = true,
                    other => return Err(format!("不認得的參數：{other}")),
                }
            }
            if o.inbox && o.engine_only {
                return Err("--inbox 與 --engine-only 不能同時用".into());
            }
            if o.respond && (o.inbox || o.engine_only) {
                return Err("--respond 不能和 --inbox、--engine-only 同時用".into());
            }
            Ok(Cmd::Run(o))
        }
        Some(other) => Err(format!("不認得的子命令：{other}")),
    }
}

fn truthy(v: Option<&str>) -> bool {
    matches!(v.map(|s| s.trim().to_ascii_lowercase()).as_deref(), Some("1") | Some("true") | Some("yes") | Some("on"))
}

/// 資料夾解析（給測試與 `run` 共用）：base＝使用者家目錄，override_＝ASN_HOME 的值
pub fn resolve_home_at(base: &std::path::Path, override_: Option<&str>) -> crate::home::HomeInfo {
    crate::home::resolve_at(base, override_)
}

fn say(msg: &str) {
    // 標準錯誤寫不出去（例如 journal 斷線）時不能 panic 也不能一直重試：寫失敗就算了
    let _ = writeln!(std::io::stderr(), "{msg}");
}

/// 進入點：回傳結束碼
pub fn main_with(args: &[String]) -> i32 {
    let env_only = crate::envc::get("ASN_BRIDGE_ENGINE_ONLY");
    let env_inbox = crate::envc::get("ASN_BRIDGE_INBOX");
    let env_respond = crate::envc::get("ASN_RESPOND");
    match parse_args_envs(args, env_only.as_deref(), env_inbox.as_deref(), env_respond.as_deref()) {
        Ok(Cmd::Help) => {
            say(USAGE);
            0
        }
        Ok(Cmd::Version) => {
            let _ = writeln!(std::io::stdout(), "asn-bridge {}", env!("CARGO_PKG_VERSION"));
            0
        }
        Ok(Cmd::Run(o)) => run(o),
        Ok(Cmd::Login(o)) => login(o),
        Err(e) => {
            say(&format!("{e}\n{USAGE}"));
            2
        }
    }
}

/// `asn-bridge login`：結束碼 0 成功、1 沒成功（過期、連不上、被拒）、2 設定錯
fn login(o: LoginOpts) -> i32 {
    let url = crate::identity::base_url(o.url.or_else(|| crate::envc::get("ASN_RELAY_URL")));
    let dir = match o.home.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        Some(h) => std::path::PathBuf::from(h),
        None => crate::home::resolve().primary,
    };
    let client = match reqwest::Client::builder().user_agent("asn-bridge-login/1").build() {
        Ok(c) => c,
        Err(_) => {
            say("asn-bridge：建不了網路連線");
            return 2;
        }
    };
    crate::rt::block_on(async move {
        match crate::device_login::login(&client, &url, &dir, &say).await {
            Ok(_) => 0,
            Err(e) => {
                say(&format!("asn-bridge login：{e}"));
                1
            }
        }
    })
}

fn run(o: RunOpts) -> i32 {
    let home = crate::home::resolve();
    let id = match crate::identity::resolve_in(&home) {
        Ok(i) => i,
        Err(e) => {
            say(&format!("asn-bridge：讀不到節點設定：{e}"));
            return 2;
        }
    };
    let work_dir = crate::identity::work_dir(&id.relay_home, &id.node);
    if let Err(e) = std::fs::create_dir_all(&work_dir) {
        say(&format!("asn-bridge：建不了工作資料夾：{e}"));
        return 2;
    }
    let window = crate::default_window_name(&id.node);
    let relay = Arc::new(crate::relay::Relay::new(id.base_url.clone(), id.key.clone(), id.node.clone(), window));
    relay.set_owner_dir(work_dir.clone());
    let anon_url = id.anon.as_deref().and_then(|a| crate::bell::ws_url(relay.base(), a));
    if o.inbox {
        return run_inbox(&id.node, &home.primary, work_dir, relay, anon_url);
    }

    let mut cfg = crate::bridge::core::Config::from_env(&id.node, work_dir.clone());
    cfg.data_dir = Some(work_dir.clone());
    cfg.engine_only = o.engine_only;
    // 無視窗：不回報「ASN 視窗」；沒有主控台切換、UI 自動化、遠端開視窗、系統匣
    cfg.report_asn_window = false;
    if o.respond {
        let name = respond_name(&id.node);
        if name == cfg.mailbox_name {
            say(&format!("asn-bridge：自動回信的視窗名「{name}」不能和內部收發室同名，請改設 ASN_INBOX_NAME"));
            return 2;
        }
        // 回答要比單純轉交聰明：沒特別指定模型時用 sonnet（ASN_MAILBOX_MODEL 可改）
        if crate::envc::get("ASN_MAILBOX_MODEL").map(|s| s.trim().is_empty()).unwrap_or(true) {
            cfg.model = "sonnet".into();
        }
        say(&format!("asn-bridge：自動回信模式，視窗名「{name}」，模型 {}", cfg.model));
        cfg.respond = Some(name);
    }

    say(&format!("asn-bridge {} 啟動：節點 {}，資料夾 {}（引擎專用={}）", env!("CARGO_PKG_VERSION"), id.node, home.primary.display(), o.engine_only));
    say("asn-bridge：無視窗模式，主控台切換、UI 自動化、遠端開視窗、系統匣皆關閉");

    crate::rt::block_on(async move {
        let running = match crate::bridge::start_with(cfg, relay.clone(), anon_url, None) {
            Ok(r) => r,
            Err(crate::bridge::StartError::HeldBy(pid)) => {
                say(&format!("asn-bridge：另一個收信者（pid {pid}）已在跑，退出"));
                return 3;
            }
            Err(crate::bridge::StartError::Other(m)) => {
                say(&format!("asn-bridge：啟動失敗：{m}"));
                return 2;
            }
        };
        relay.set_bridge_running(true);
        wait_for_stop().await;
        say("asn-bridge：收到停止訊號，收尾中");
        relay.set_bridge_running(false);
        running.stop();
        0
    })
}

/// 自動回信模式的視窗名：ASN_INBOX_NAME（與收件匣模式同一個變數），沒設用節點代號
pub fn respond_name(node: &str) -> String {
    crate::envc::get("ASN_INBOX_NAME").map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).unwrap_or_else(|| node.to_string())
}

/// 收件匣模式：不啟動 worker 與引擎，只收信存檔、回報名單。結束碼沿用：2 設定錯、3 另一個收信者在跑
fn run_inbox(node: &str, relay_home: &std::path::Path, work_dir: std::path::PathBuf, relay: Arc<crate::relay::Relay>, anon_url: Option<String>) -> i32 {
    use crate::bridge::{core::BridgeLog, lock};
    let base = crate::bridge::core::Config::from_env(node, work_dir.clone());
    let cfg = crate::inbox_mode::InboxCfg::from_env(node, relay_home, &base);
    let store = match crate::inbox_mode::InboxStore::open(&cfg.dir) {
        Ok(s) => s,
        Err(e) => {
            say(&format!("asn-bridge：建不了收件匣資料夾 {}：{e}", cfg.dir.display()));
            return 2;
        }
    };
    let lock = match lock::BridgeLock::acquire(&work_dir, std::process::id(), crate::heartbeat::pid_alive) {
        Ok(l) => l,
        Err(lock::LockError::HeldBy(pid)) => {
            say(&format!("asn-bridge：另一個收信者（pid {pid}）已在跑，退出"));
            return 3;
        }
        Err(lock::LockError::Io(m)) => {
            say(&format!("asn-bridge：拿不到收信鎖：{m}"));
            return 2;
        }
    };
    let log = Arc::new(BridgeLog::new(Some(work_dir.join("bridge.log"))));
    log.line(&format!("inbox mode starting node={node} window={} inbox={} known={}", cfg.name, cfg.dir.display(), store.len()));
    say(&format!("asn-bridge {} 啟動（收件匣模式）：節點 {node}，視窗名 {}，信存在 {}", env!("CARGO_PKG_VERSION"), cfg.name, cfg.dir.display()));
    crate::rt::block_on(async move {
        let (wake, shutdown) = (Arc::new(tokio::sync::Notify::new()), Arc::new(tokio::sync::Notify::new()));
        let bell = match anon_url {
            Some(url) => Some(crate::inbox_mode::spawn_bell(relay.clone(), url, wake.clone(), log.clone())),
            None => {
                log.line("no anon key: doorbell off, polling only");
                None
            }
        };
        let main = crate::rt::spawn(crate::inbox_mode::run_loop(relay.clone(), store, cfg, log.clone(), wake, shutdown.clone()));
        wait_for_stop().await;
        say("asn-bridge：收到停止訊號，收尾中");
        shutdown.notify_one();
        let _ = tokio::time::timeout(std::time::Duration::from_secs(3), main).await;
        if let Some(b) = bell {
            b.abort();
        }
        lock.release();
        0
    })
}

async fn wait_for_stop() {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{signal, SignalKind};
        match signal(SignalKind::terminate()) {
            Ok(mut term) => {
                tokio::select! {
                    _ = tokio::signal::ctrl_c() => {}
                    _ = term.recv() => {}
                }
            }
            Err(_) => {
                let _ = tokio::signal::ctrl_c().await;
            }
        }
    }
    #[cfg(not(unix))]
    {
        let _ = tokio::signal::ctrl_c().await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn a(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn 沒給參數或問說明就顯示說明() {
        assert_eq!(parse_args(&a(&[]), None).unwrap(), Cmd::Help);
        assert_eq!(parse_args(&a(&["--help"]), None).unwrap(), Cmd::Help);
        assert_eq!(parse_args(&a(&["-h"]), None).unwrap(), Cmd::Help);
    }

    #[test]
    fn 版本() {
        assert_eq!(parse_args(&a(&["--version"]), None).unwrap(), Cmd::Version);
    }

    #[test]
    fn run_預設會開收發室_worker() {
        assert_eq!(parse_args(&a(&["run"]), None).unwrap(), Cmd::Run(RunOpts::default()));
    }

    #[test]
    fn 旗標與環境變數都能開只有引擎() {
        assert_eq!(parse_args(&a(&["run", "--engine-only"]), None).unwrap(), Cmd::Run(RunOpts { engine_only: true, ..Default::default() }));
        assert_eq!(parse_args(&a(&["run"]), Some("1")).unwrap(), Cmd::Run(RunOpts { engine_only: true, ..Default::default() }));
        assert_eq!(parse_args(&a(&["run"]), Some("true")).unwrap(), Cmd::Run(RunOpts { engine_only: true, ..Default::default() }));
        assert_eq!(parse_args(&a(&["run"]), Some("0")).unwrap(), Cmd::Run(RunOpts::default()));
        assert_eq!(parse_args(&a(&["run"]), Some("")).unwrap(), Cmd::Run(RunOpts::default()));
    }

    #[test]
    fn 收件匣旗標與環境變數() {
        let inbox = RunOpts { inbox: true, ..Default::default() };
        assert_eq!(parse_args(&a(&["run", "--inbox"]), None).unwrap(), Cmd::Run(inbox.clone()));
        assert_eq!(parse_args_env(&a(&["run"]), None, Some("1")).unwrap(), Cmd::Run(inbox));
        assert_eq!(parse_args_env(&a(&["run"]), None, Some("0")).unwrap(), Cmd::Run(RunOpts::default()));
        assert!(parse_args(&a(&["run", "--inbox", "--engine-only"]), None).is_err());
    }

    #[test]
    fn 自動回信旗標與環境變數_與其他模式互斥() {
        let respond = RunOpts { respond: true, ..Default::default() };
        assert_eq!(parse_args(&a(&["run", "--respond"]), None).unwrap(), Cmd::Run(respond.clone()));
        assert_eq!(parse_args_envs(&a(&["run"]), None, None, Some("1")).unwrap(), Cmd::Run(respond));
        assert_eq!(parse_args_envs(&a(&["run"]), None, None, Some("0")).unwrap(), Cmd::Run(RunOpts::default()));
        assert!(parse_args(&a(&["run", "--respond", "--inbox"]), None).is_err());
        assert!(parse_args(&a(&["run", "--respond", "--engine-only"]), None).is_err());
        assert!(parse_args_envs(&a(&["run", "--inbox"]), None, None, Some("1")).is_err());
        assert!(parse_args_envs(&a(&["run"]), Some("1"), None, Some("1")).is_err());
        assert!(USAGE.contains("--respond"));
    }

    #[test]
    fn login_子命令與參數() {
        assert_eq!(parse_args(&a(&["login"]), None).unwrap(), Cmd::Login(LoginOpts::default()));
        assert_eq!(
            parse_args(&a(&["login", "--url", "http://x/relay", "--home", "/h"]), None).unwrap(),
            Cmd::Login(LoginOpts { url: Some("http://x/relay".into()), home: Some("/h".into()) })
        );
        assert!(parse_args(&a(&["login", "--url"]), None).is_err());
        assert!(parse_args(&a(&["login", "--bogus"]), None).is_err());
        assert!(USAGE.contains("asn-bridge login"));
    }

    #[test]
    fn 不認得的參數會報錯() {
        assert!(parse_args(&a(&["run", "--bogus"]), None).is_err());
        assert!(parse_args(&a(&["fly"]), None).is_err());
    }

    #[test]
    fn 資料夾_環境變數指定優先且不看舊位置() {
        let d = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(d.path().join(crate::home::LEGACY_NAME)).unwrap();
        std::fs::write(d.path().join(crate::home::LEGACY_NAME).join("x"), "1").unwrap();
        let h = resolve_home_at(d.path(), Some("/custom/dir"));
        assert_eq!(h.primary, PathBuf::from("/custom/dir"));
        assert!(h.fallback.is_none());
    }

    #[test]
    fn 資料夾_只有舊位置就用舊的() {
        let d = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(d.path().join(crate::home::LEGACY_NAME)).unwrap();
        let h = resolve_home_at(d.path(), None);
        assert_eq!(h.primary, d.path().join(crate::home::LEGACY_NAME));
    }

    #[test]
    fn 資料夾_都沒有就用新位置() {
        let d = tempfile::tempdir().unwrap();
        let h = resolve_home_at(d.path(), None);
        assert_eq!(h.primary, d.path().join(".asn"));
        let h2 = resolve_home_at(d.path(), Some("   "));
        assert_eq!(h2.primary, d.path().join(".asn"));
    }

    #[test]
    fn 資料夾_新舊都有而舊的有內容_用舊的新的當後備() {
        let d = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(d.path().join(".asn")).unwrap();
        std::fs::create_dir_all(d.path().join(crate::home::LEGACY_NAME)).unwrap();
        std::fs::write(d.path().join(crate::home::LEGACY_NAME).join("aegis.key"), "x").unwrap();
        let h = resolve_home_at(d.path(), None);
        assert_eq!(h.primary, d.path().join(crate::home::LEGACY_NAME));
        assert_eq!(h.fallback, Some(d.path().join(".asn")));
    }

    /// 守門：無視窗橋用到的核心模組不得直接用 tauri（只准經 crate::rt）。掃原始碼；檔案清單不是寫死的名單，
    /// 而是「src 底下除了視窗版專屬檔案以外的全部」，所以新加的核心檔也會被管到。
    #[test]
    fn 核心模組不得直接用_tauri() {
        // 視窗版專屬（lib.rs 用 cfg(feature = "gui") 掛上的模組與檔案）與兩個本來就要提到 tauri 的檔案
        const GUI_ONLY: &[&str] = &[
            "lib.rs", "main.rs", "rt.rs", "headless.rs", "account.rs", "ads.rs", "tray.rs", "updater.rs", "wins.rs", "shot.rs", "tts.rs", "stt.rs", "usage.rs", "cloud_invite.rs", "android.rs", "android_update.rs",
            "claude_mod.rs", "claude_accounts.rs", "codex_accounts.rs", "dialog.rs", "desktop.rs", "tests.rs",
        ];
        fn walk(dir: &std::path::Path, out: &mut Vec<PathBuf>) {
            for e in std::fs::read_dir(dir).unwrap().flatten() {
                let p = e.path();
                if p.is_dir() {
                    walk(&p, out);
                } else if p.extension().map(|x| x == "rs").unwrap_or(false) {
                    out.push(p);
                }
            }
        }
        let mut files = vec![];
        walk(&PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("src"), &mut files);
        assert!(files.len() > 40, "掃到的檔案太少，路徑可能不對");
        let mut bad = vec![];
        for f in &files {
            let name = f.file_name().unwrap().to_string_lossy().to_string();
            // 子資料夾裡的 tests.rs 等測試檔、agent_tools 的指令包裝（cfg_attr）也不算
            let in_tests = f.components().any(|c| c.as_os_str() == "tests");
            if GUI_ONLY.contains(&name.as_str()) || in_tests {
                continue;
            }
            let text = std::fs::read_to_string(f).unwrap();
            for (n, line) in text.lines().enumerate() {
                let t = line.trim_start();
                if t.starts_with("//") {
                    continue;
                }
                let code = t.split("//").next().unwrap_or("");
                let uses = code.contains("tauri::") || code.contains("use tauri") || code.contains("tauri_plugin");
                let gated = code.contains("cfg_attr(feature = \"gui\"");
                if uses && !gated {
                    bad.push(format!("{}:{}", f.display(), n + 1));
                }
            }
        }
        assert!(bad.is_empty(), "核心模組不得直接用 tauri（改用 crate::rt）：{bad:?}");
    }
}

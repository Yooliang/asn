//! 命令列測試（本機假後端 127.0.0.1，不碰真實後端與真實金鑰）。
//! 由 relay/machine/test 的 send／send-attach／recv／room／attach 測試改寫：同樣的情境、同樣的斷言，只是不再需要 Node。
use super::env::{Env, ProcTable};
use super::testsupport::{Fake, Req, Resp};
use super::{run, Io};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;

mod attach_tests;
mod recv_tests;
mod room_tests;
mod send_tests;
mod unit_tests;

pub const SELF_PID: u32 = 9001;
pub const BASH_PID: u32 = 9002;
pub const CLAUDE_PID: u32 = 9003;
pub const KEY: &str = "fake-machine-key";
pub const NEW_ID: &str = "aaaaaaaa-0000-0000-0000-000000000009";

pub fn uid(n: u32) -> String {
    format!("00000000-0000-0000-0000-{n:012}")
}

pub struct Fx {
    pub _d: tempfile::TempDir,
    pub home: PathBuf,
    pub env: Env,
    /// 視窗（claude）是否還活著
    pub window_alive: Arc<AtomicBool>,
}
impl Fx {
    pub fn rh(&self) -> PathBuf {
        self.home.join(".asn")
    }
    pub fn work(&self) -> PathBuf {
        self.rh().join("machine-T")
    }
}

/// 假的執行環境：asn-cli → bash → claude（視窗名 window）；節點 T，金鑰 KEY
pub fn fx(url: &str, window: Option<&str>) -> Fx {
    let d = tempfile::tempdir().unwrap();
    let home = d.path().to_path_buf();
    std::fs::create_dir_all(home.join(".asn")).unwrap();
    std::fs::write(home.join(".asn").join("T.key"), KEY).unwrap();
    let sessions = home.join(".claude").join("sessions");
    std::fs::create_dir_all(&sessions).unwrap();
    let mut s = json!({"pid": CLAUDE_PID, "kind": "interactive", "entrypoint": "cli"});
    if let Some(w) = window {
        s["name"] = json!(w);
    }
    std::fs::write(sessions.join(format!("{CLAUDE_PID}.json")), s.to_string()).unwrap();
    let flag = Arc::new(AtomicBool::new(true));
    let f2 = flag.clone();
    let table: ProcTable = [(SELF_PID, (BASH_PID, "asn-cli.exe".to_string())), (BASH_PID, (CLAUDE_PID, "bash.exe".to_string())), (CLAUDE_PID, (1, "claude.exe".to_string()))].into_iter().collect();
    let env = Env {
        relay_home: home.join(".asn"),
        relay_home_fallback: None,
        sessions_dir: sessions,
        self_pid: SELF_PID,
        relay_id: Some("T".into()),
        relay_key: None,
        relay_url: Some(url.to_string()),
        anon_key: None,
        socket: None,
        send_per_hour: 30,
        procs: Arc::new(move || Ok(table.clone())),
        alive: Arc::new(move |p| if p == CLAUDE_PID { f2.load(Ordering::SeqCst) } else { p != 999_999 }),
        poll_ms: 120_000,
        heartbeat_ms: 30_000,
        stale_ms: 90_000,
        window_check_ms: 10_000,
        backoff_ms: vec![20, 40],
        cmd_prefix: Some("/x/asn-cli".into()),
    };
    Fx { _d: d, home, env, window_alive: flag }
}

/// 跑一個子命令，回（結束碼, stdout, stderr）
pub fn go(env: &Env, args: &[&str], stdin: &str) -> (i32, String, String) {
    let a: Vec<String> = args.iter().map(|s| s.to_string()).collect();
    let (mut out, mut err, mut inp) = (Vec::new(), Vec::new(), std::io::Cursor::new(stdin.as_bytes().to_vec()));
    let code = {
        let mut io = Io { out: &mut out, err: &mut err, stdin: &mut inp };
        run(&a, env, &mut io)
    };
    (code, String::from_utf8_lossy(&out).to_string(), String::from_utf8_lossy(&err).to_string())
}

/// 標準假後端：send／room_post／附件三步／inbox／ack／room_list／room_read／attach_url。status≠200 時所有動作回該狀態
pub fn backend(status: u16) -> Fake {
    let n = Arc::new(AtomicUsize::new(0));
    Fake::start(move |req: &Req, port: u16| {
        if status != 200 {
            return Resp::json(status, json!({"error": "not_found"}));
        }
        if req.method == "PUT" && req.path.starts_with("/upload/") {
            return Resp::bytes(200, vec![]);
        }
        match req.action().as_str() {
            "room_post" => Resp::ok(json!({"seq": 12})),
            "attach_init" => {
                let id = format!("11111111-0000-0000-0000-{:012}", n.fetch_add(1, Ordering::SeqCst) + 1);
                Resp::ok(json!({"id": id, "upload_url": format!("http://127.0.0.1:{port}/upload/{id}?token=SECRET-SIGNED"), "expires_in": 7200}))
            }
            "attach_commit" => Resp::ok(json!({"ok": true})),
            "whoami" => Resp::ok(json!({"node": "T", "bell_topic": "bell-test"})),
            _ => Resp::ok(json!({"id": NEW_ID})),
        }
    })
}

pub fn read_dir_names(p: &Path) -> Vec<String> {
    let mut v: Vec<String> = std::fs::read_dir(p).map(|rd| rd.flatten().map(|e| e.file_name().to_string_lossy().to_string()).collect()).unwrap_or_default();
    v.sort();
    v
}

pub fn body_of(r: &Req) -> Value {
    r.json()
}

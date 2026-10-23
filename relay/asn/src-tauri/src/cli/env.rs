//! 命令列的執行環境：把「讀環境變數、行程表、程序是否活著」集中成一個結構，測試時整個換成假的。
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

/// pid → (父 pid, 程式名)
pub type ProcTable = HashMap<u32, (u32, String)>;

#[derive(Clone)]
pub struct Env {
    /// ~/.asn
    pub relay_home: PathBuf,
    /// 後備資料夾（遷移被打斷、項目分在兩邊時才有；身分解析找不到再回頭找）
    pub relay_home_fallback: Option<PathBuf>,
    /// ~/.claude/sessions
    pub sessions_dir: PathBuf,
    /// 本程式的 pid（找父行程鏈的起點）
    pub self_pid: u32,
    /// ASN_RELAY_ID
    pub relay_id: Option<String>,
    /// ASN_RELAY_KEY
    pub relay_key: Option<String>,
    /// ASN_RELAY_URL
    pub relay_url: Option<String>,
    /// ASN_RELAY_ANON_KEY
    pub anon_key: Option<String>,
    /// CLAUDE_CODE_MESSAGING_SOCKET
    pub socket: Option<String>,
    /// ASN_SEND_PER_HOUR（每視窗每小時最多寄幾封）
    pub send_per_hour: usize,
    /// 讀行程表（失敗回原因）
    pub procs: Arc<dyn Fn() -> Result<ProcTable, String> + Send + Sync>,
    /// pid 是否還活著
    pub alive: Arc<dyn Fn(u32) -> bool + Send + Sync>,
    /// recv --watch 的輪詢間隔（ASN_RECV_POLL_MS）
    pub poll_ms: u64,
    /// asn secret request 等本人確認時的輪詢間隔（正式固定 2 秒，測試縮短）
    pub secret_poll_ms: u64,
    /// recv --watch 的心跳間隔（ASN_RECV_HEARTBEAT_MS）
    pub heartbeat_ms: u64,
    /// 心跳多久沒更新算過期（ASN_RECV_STALE_MS）
    pub stale_ms: u64,
    /// 視窗本體是否還在的檢查間隔（毫秒）
    pub window_check_ms: u64,
    /// 收信失敗的退避（毫秒，ASN_PULL_BACKOFF_MS 以逗號分隔）
    pub backoff_ms: Vec<u64>,
    /// 指令前綴（附件下載、群組翻頁提示用）；None＝用 [`crate::cli::cmd_prefix`]
    pub cmd_prefix: Option<String>,
}

fn var(k: &str) -> Option<String> {
    crate::envc::get(k)
}
fn num(k: &str, d: u64) -> u64 {
    var(k).and_then(|v| v.trim().parse::<u64>().ok()).unwrap_or(d)
}

pub const DEFAULT_BACKOFF_MS: [u64; 5] = [5_000, 10_000, 20_000, 40_000, 60_000];

impl Env {
    pub fn from_process() -> Env {
        let home = crate::identity::home_dir();
        let home_info = crate::home::resolve();
        let backoff: Vec<u64> = var("ASN_PULL_BACKOFF_MS")
            .map(|raw| raw.split(',').filter_map(|s| s.trim().parse::<u64>().ok()).filter(|n| *n > 0).collect())
            .unwrap_or_default();
        Env {
            relay_home: home_info.primary,
            relay_home_fallback: home_info.fallback,
            sessions_dir: home.join(".claude").join("sessions"),
            self_pid: std::process::id(),
            relay_id: var("ASN_RELAY_ID"),
            relay_key: var("ASN_RELAY_KEY"),
            relay_url: var("ASN_RELAY_URL"),
            anon_key: var("ASN_RELAY_ANON_KEY"),
            socket: std::env::var("CLAUDE_CODE_MESSAGING_SOCKET").ok(),
            send_per_hour: num("ASN_SEND_PER_HOUR", 30) as usize,
            procs: Arc::new(super::caller::process_table),
            alive: Arc::new(crate::heartbeat::pid_alive),
            poll_ms: num("ASN_RECV_POLL_MS", 120_000),
            secret_poll_ms: 2_000,
            heartbeat_ms: crate::heartbeat::heartbeat_ms(),
            stale_ms: crate::heartbeat::stale_ms(),
            window_check_ms: 10_000,
            backoff_ms: if backoff.is_empty() { DEFAULT_BACKOFF_MS.to_vec() } else { backoff },
            cmd_prefix: None,
        }
    }

    pub fn prefix(&self, sub: &str) -> Option<String> {
        match &self.cmd_prefix {
            Some(p) => Some(format!("{p} {sub}")),
            None => super::cmd_prefix(sub),
        }
    }
}

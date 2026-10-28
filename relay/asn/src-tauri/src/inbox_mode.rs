//! 收件匣模式（`asn-bridge run --inbox`）：給 Linux 上 `claude -p` 這類「自己會呼叫 asn-cli」的代理收信用。
//! 對應 `relay/cloud-agent/recv.mjs`＋`inbox.mjs`（行為與檔案格式盡量一致）：
//! - 不啟動 claude worker、不需要 Aegis；收信（Realtime 門鈴＋每 2 分鐘補拉）。
//! - 每封信「先 append 到 `<資料夾>/inbox.jsonl` 並 fsync，成功才 ack」；寫失敗就不 ack，信留在收發室信箱，下一輪再試。
//! - 以信件 id 去重；重啟時從 `inbox.jsonl` 重建（所以 ack 失敗、重啟後再收到同一封，不會重複寫入，只會補 ack）。
//! - 回信由代理自己呼叫 `asn-cli send`，橋不自動回。已處理的信記在 `done.jsonl`（`asn-cli inbox --done`）。
//! - 每 60 秒回報名單：收件匣視窗（`ASN_INBOX_NAME`，預設節點代號）加上本機執行中的 Claude 視窗
//!   （讀 `~/.claude/sessions`，Linux 以 `/proc` 驗證 pid 仍活著），欄位與電腦版名單相同（name／status／cwd_label／engine）。
//! 本檔不使用 tauri，無視窗版也編得進去。

use crate::bridge::core::BridgeLog;
use crate::bridge::roster::{self, Window};
use crate::relay::Relay;
use serde_json::{json, Value};
use std::collections::HashSet;
use std::future::Future;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tokio::sync::Notify;

pub const INBOX_FILE: &str = "inbox.jsonl";
pub const DONE_FILE: &str = "done.jsonl";

/// 收件匣資料夾：`<ASN_HOME>/inbox`
pub fn inbox_dir(relay_home: &Path) -> PathBuf {
    relay_home.join("inbox")
}

// ---- 檔案 ---------------------------------------------------------------------------------------

/// 讀 JSONL：壞行（寫到一半被砍斷的最後一行等）直接略過
pub fn read_jsonl(path: &Path) -> Vec<Value> {
    let Ok(text) = std::fs::read_to_string(path) else { return vec![] };
    text.lines().filter_map(|l| serde_json::from_str::<Value>(l.trim()).ok()).collect()
}

/// 附加一行並 fsync（成功回傳才代表資料已落到磁碟）。檔案不是以換行結尾（上次寫到一半）時先補一個換行，免得黏在壞行後面
pub fn append_line_durable(path: &Path, line: &str) -> std::io::Result<()> {
    let mut opts = std::fs::OpenOptions::new();
    opts.create(true).append(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    let needs_nl = std::fs::read(path).map(|b| !b.is_empty() && b.last() != Some(&b'\n')).unwrap_or(false);
    let mut f = opts.open(path)?;
    let mut data = String::new();
    if needs_nl {
        data.push('\n');
    }
    data.push_str(line);
    data.push('\n');
    f.write_all(data.as_bytes())?;
    f.sync_all()
}

pub fn ensure_dir(dir: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dir)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700));
    }
    Ok(())
}

/// 收件匣存放處：記住看過的信件 id（重啟由檔案重建）
pub struct InboxStore {
    dir: PathBuf,
    seen: HashSet<String>,
}

impl InboxStore {
    pub fn open(dir: &Path) -> std::io::Result<InboxStore> {
        ensure_dir(dir)?;
        let seen = read_jsonl(&dir.join(INBOX_FILE)).iter().filter_map(|m| m.get("id").and_then(Value::as_str).map(String::from)).collect();
        Ok(InboxStore { dir: dir.to_path_buf(), seen })
    }
    pub fn inbox_file(&self) -> PathBuf {
        self.dir.join(INBOX_FILE)
    }
    pub fn has(&self, id: &str) -> bool {
        self.seen.contains(id)
    }
    pub fn len(&self) -> usize {
        self.seen.len()
    }
    /// 寫入一封（fsync 後才記進 seen）。失敗回錯誤，呼叫端不可 ack
    pub fn append(&mut self, id: &str, record: &Value) -> std::io::Result<()> {
        append_line_durable(&self.inbox_file(), &record.to_string())?;
        self.seen.insert(id.to_string());
        Ok(())
    }
}

/// 存進 inbox.jsonl 的一筆（欄位與 recv.mjs 的 recordOf 相同；附件只存編號、檔名、型別、大小、尺寸，不存縮圖）
pub fn record_of(m: &Value, received_at: &str) -> Value {
    let get = |k: &str| m.get(k).cloned().unwrap_or(Value::Null);
    let mut r = json!({
        "id": get("id"), "trust": get("trust"), "from_node": get("from_node"), "from_agent": get("from_agent"), "to_agent": get("to_agent"),
        "reply_to": get("reply_to"), "created_at": get("created_at"),
        "expects_reply": m.get("expects_reply").filter(|v| v.is_boolean()).cloned().unwrap_or(Value::Null),
        "body": get("body"), "received_at": received_at,
    });
    for k in ["sender_display", "sender_device", "sender_engine"] {
        if let Some(s) = m.get(k).and_then(Value::as_str).filter(|s| !s.is_empty()) {
            r[k] = json!(s);
        }
    }
    if m.get("voice").and_then(Value::as_bool) == Some(true) {
        r["voice"] = json!(true);
    }
    let atts = crate::bridge::attach::normalize(m.get("attachments"));
    if !atts.is_empty() {
        r["attachments"] = Value::Array(
            atts.iter()
                .map(|a| {
                    let mut o = json!({ "id": a.id, "kind": a.kind, "name": a.name, "mime": a.mime });
                    if let Some(b) = a.bytes {
                        o["bytes"] = json!(b);
                    }
                    if let Some(w) = a.width {
                        o["width"] = json!(w);
                    }
                    if let Some(h) = a.height {
                        o["height"] = json!(h);
                    }
                    if a.expired {
                        o["expired"] = json!(true);
                    }
                    o
                })
                .collect(),
        );
    }
    r
}

// ---- 收信 ---------------------------------------------------------------------------------------

/// 後台 API 的最小介面（正式用 [`Relay`]，測試可換假的）
pub trait MailApi: Send + Sync + 'static {
    fn call(&self, action: &str, body: Option<Value>) -> impl Future<Output = Result<Value, String>> + Send;
}

impl MailApi for Relay {
    fn call(&self, action: &str, body: Option<Value>) -> impl Future<Output = Result<Value, String>> + Send {
        self.api(action, body)
    }
}

/// 拉一次：新信先寫檔（fsync）才算數，之後才 ack（每批最多 100 封）。回傳這次 ack 的封數。
/// 寫失敗的那封不 ack（信留在收發室信箱）；ack 失敗回錯誤（信已在檔案裡，下一輪補 ack，不會重複寫）。
pub async fn pull_once<A: MailApi>(api: &A, store: &mut InboxStore, now_iso: &(dyn Fn() -> String + Sync), log: &(dyn Fn(&str) + Sync)) -> Result<usize, String> {
    let v = api.call("inbox", None).await?;
    let mut ack_ids: Vec<String> = vec![];
    for m in v.get("messages").and_then(Value::as_array).cloned().unwrap_or_default() {
        let Some(id) = m.get("id").and_then(Value::as_str).filter(|s| !s.is_empty()).map(String::from) else { continue };
        if !store.has(&id) {
            if let Err(e) = store.append(&id, &record_of(&m, &now_iso())) {
                log(&format!("inbox write failed id={id}: {e} (not acked; will retry)"));
                continue;
            }
            log(&format!(
                "mail stored id={id} from={}/{} expects_reply={}",
                m.get("from_node").and_then(Value::as_str).unwrap_or(""),
                m.get("from_agent").and_then(Value::as_str).unwrap_or(""),
                m.get("expects_reply").and_then(Value::as_bool).map(|b| b.to_string()).unwrap_or_else(|| "?".into())
            ));
        }
        ack_ids.push(id); // 已在檔案裡（含先前 ack 失敗的）才 ack
    }
    for chunk in ack_ids.chunks(100) {
        api.call("ack", Some(json!({ "ids": chunk }))).await?;
    }
    Ok(ack_ids.len())
}

// ---- 名單 ---------------------------------------------------------------------------------------

/// 回報用視窗名單：收件匣視窗（閒置）＋本機執行中的 Claude 視窗（pid 以 alive 驗證；Linux 是 /proc）。
/// 讀不到 sessions 資料夾（不是不存在）時只報收件匣視窗。
pub fn roster_windows(name: &str, engine: &str, sessions_dir: &Path, status_dir: &Path, alive: impl Fn(u32) -> bool, now_ms: u64) -> Vec<Window> {
    let mut list: Vec<Window> = roster::read_local_with(sessions_dir, status_dir, |p, st| alive(p) && roster::same_process(st, crate::heartbeat::process_started_ms(p)), 0, name, now_ms).unwrap_or_default();
    let mut me = Window::claude(name, Some("idle".into()), "", 0, now_ms, None);
    me.engine = engine.to_string();
    list.insert(0, me);
    list
}

pub fn roster_body_of(windows: &[Window]) -> Value {
    roster::roster_body(windows, None, Value::Null)
}

// ---- 執行 ---------------------------------------------------------------------------------------

pub struct InboxCfg {
    /// 收件匣視窗名（`ASN_INBOX_NAME`，預設節點代號）
    pub name: String,
    /// 名單上的引擎名（`ASN_INBOX_ENGINE`，預設 inbox，不代表有登入 Claude）
    pub engine: String,
    pub dir: PathBuf,
    pub sessions_dir: PathBuf,
    pub status_dir: PathBuf,
    pub poll_ms: u64,
    pub roster_ms: u64,
    /// 補拉失敗後的退避（毫秒），用完最後一個就一直用最後一個
    pub backoff_ms: Vec<u64>,
    /// roster 403（沒有 can_roster）後多久才再試
    pub roster_403_retry_ms: u64,
}

impl InboxCfg {
    pub fn from_env(node: &str, relay_home: &Path, base: &crate::bridge::core::Config) -> InboxCfg {
        let name = crate::envc::get("ASN_INBOX_NAME").map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).unwrap_or_else(|| node.to_string());
        let engine = crate::envc::get("ASN_INBOX_ENGINE").map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).unwrap_or_else(|| "inbox".into());
        InboxCfg {
            name,
            engine,
            dir: inbox_dir(relay_home),
            sessions_dir: base.sessions_dir.clone(),
            status_dir: base.status_dir.clone(),
            poll_ms: base.poll_ms,
            roster_ms: base.roster_ms,
            backoff_ms: base.pull_backoff_ms.clone(),
            roster_403_retry_ms: 3_600_000,
        }
    }
}

fn now_ms() -> u64 {
    crate::heartbeat::now_ms()
}

async fn roster_once<A: MailApi>(api: &A, cfg: &InboxCfg, blocked_until: &mut u64, warned: &mut bool, log: &(dyn Fn(&str) + Sync)) {
    if now_ms() < *blocked_until {
        return;
    }
    let (name, engine, sd, st) = (cfg.name.clone(), cfg.engine.clone(), cfg.sessions_dir.clone(), cfg.status_dir.clone());
    // 讀資料夾與 /proc 放背景執行緒，不卡住收信
    let windows = tokio::task::spawn_blocking(move || roster_windows(&name, &engine, &sd, &st, crate::heartbeat::pid_alive, now_ms())).await.unwrap_or_default();
    // 本機執行中的代理（僅顯示、不可收信；開關見 procscan::enabled）
    let procs = tokio::task::spawn_blocking(crate::bridge::procscan::scan_system).await.unwrap_or_default();
    let body = crate::bridge::roster::roster_body_with_procs(&windows, None, Value::Null, &procs);
    // 靠舊環境變數名才拿到設定的舊名（只送名字；新版一律帶，沒用到是空陣列）
    let body = crate::bridge::roster::with_legacy_env(body, crate::envc::used_legacy());
    match api.call("roster", Some(body)).await {
        Ok(_) => {
            if *warned {
                log("roster ok again");
            }
            *warned = false;
        }
        Err(e) => {
            if e.contains("403") {
                *blocked_until = now_ms() + cfg.roster_403_retry_ms;
                if !*warned {
                    log("roster forbidden (403): 這個節點沒有 can_roster；不再轟炸，每小時才重試一次");
                }
            } else if !*warned {
                log(&format!("roster post failed: {e} (will keep trying quietly)"));
            }
            *warned = true;
        }
    }
}

/// 主迴圈：門鈴（wake）／補拉／名單／失敗退避重試，直到 shutdown
pub async fn run_loop<A: MailApi>(api: Arc<A>, mut store: InboxStore, cfg: InboxCfg, log: Arc<BridgeLog>, wake: Arc<Notify>, shutdown: Arc<Notify>) {
    let lg = |m: &str| log.line(m);
    let iso = || crate::cli::iso(now_ms());
    let every = |ms: u64| {
        let mut i = tokio::time::interval(std::time::Duration::from_millis(ms.max(10)));
        i.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        i
    };
    let (mut poll, mut roster_t, mut tick) = (every(cfg.poll_ms), every(cfg.roster_ms), every(250));
    poll.tick().await;
    roster_t.tick().await;
    tick.tick().await;
    let (mut blocked, mut warned) = (0u64, false);
    let (mut step, mut retry_at): (usize, Option<u64>) = (0, None);
    macro_rules! pull {
        ($why:expr) => {{
            match pull_once(&*api, &mut store, &iso, &lg).await {
                Ok(_) => {
                    step = 0;
                    retry_at = None;
                }
                Err(e) => {
                    let wait = cfg.backoff_ms.get(step).or(cfg.backoff_ms.last()).copied().unwrap_or(5_000);
                    lg(&format!("pull failed ({}): {e}; retry in {}ms", $why, wait));
                    retry_at = Some(now_ms() + wait);
                    step += 1;
                }
            }
        }};
    }
    roster_once(&*api, &cfg, &mut blocked, &mut warned, &lg).await;
    pull!("startup");
    loop {
        tokio::select! {
            _ = wake.notified() => pull!("bell"),
            _ = poll.tick() => pull!("poll"),
            _ = roster_t.tick() => roster_once(&*api, &cfg, &mut blocked, &mut warned, &lg).await,
            _ = tick.tick() => { if retry_at.map(|t| now_ms() >= t).unwrap_or(false) { pull!("retry"); } }
            _ = shutdown.notified() => break,
        }
    }
}

/// 門鈴：取得頻道後連 Realtime，響鈴就喚醒主迴圈（沒有 anon 金鑰時呼叫端不要叫這個，只剩補拉）
pub fn spawn_bell(relay: Arc<Relay>, url: String, wake: Arc<Notify>, log: Arc<BridgeLog>) -> crate::rt::JoinHandle<()> {
    crate::rt::spawn(async move {
        let topic = loop {
            match relay.api("whoami", None).await {
                Ok(v) => match v.get("bell_topic").and_then(Value::as_str) {
                    Some(t) => break t.to_string(),
                    None => tokio::time::sleep(std::time::Duration::from_secs(10)).await,
                },
                Err(e) => {
                    log.line(&format!("whoami failed: {e}"));
                    tokio::time::sleep(std::time::Duration::from_secs(5)).await
                }
            }
        };
        crate::bell::run(url, topic, move |_| wake.notify_one()).await;
    })
}

// ---- 給 asn-cli inbox 用 ---------------------------------------------------------------------------

/// 已處理的信件 id
pub fn done_ids(dir: &Path) -> HashSet<String> {
    read_jsonl(&dir.join(DONE_FILE)).iter().filter_map(|d| d.get("id").and_then(Value::as_str).map(String::from)).collect()
}

/// 全部的信（依 id 去重，保留最先寫入的那筆）
pub fn all_mails(dir: &Path) -> Vec<Value> {
    let mut seen = HashSet::new();
    read_jsonl(&dir.join(INBOX_FILE)).into_iter().filter(|m| m.get("id").and_then(Value::as_str).map(|i| seen.insert(i.to_string())).unwrap_or(false)).collect()
}

/// 標成已處理：回 Ok(id)；前綴（至少 8 碼）要唯一，找不到或不唯一回 Err（給人看的訊息）；早就標過回 Ok(None)
pub fn mark_done(dir: &Path, want: &str, now_iso: &str) -> Result<Option<String>, String> {
    let mails = all_mails(dir);
    let mut ids: Vec<String> = mails.iter().filter_map(|m| m.get("id").and_then(Value::as_str)).filter(|i| *i == want || (want.len() >= 8 && i.starts_with(want))).map(String::from).collect();
    ids.dedup();
    if ids.len() != 1 {
        return Err(format!("{}：{want}", if ids.is_empty() { "找不到這封信" } else { "前綴不唯一" }));
    }
    let id = ids.remove(0);
    if done_ids(dir).contains(&id) {
        return Ok(None);
    }
    ensure_dir(dir).map_err(|e| e.to_string())?;
    append_line_durable(&dir.join(DONE_FILE), &json!({ "id": id, "done_at": now_iso }).to_string()).map_err(|e| e.to_string())?;
    Ok(Some(id))
}

#[cfg(test)]
mod tests;

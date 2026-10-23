//! 收發室橋的核心狀態機：對應 relay/machine/bridge.mjs（只做 Claude 引擎；含信件、群組轉送、遠端開視窗的接口）。
//! 所有時間都由呼叫端傳入（毫秒），測試可以不用真的等待逾時。核心一次只被一個任務使用（見 mod.rs 的 run 迴圈）。
//! 對後端只透過 [`Relay`]（HTTP），對 worker 只透過 [`WorkerSink`]，所以測試可用本機假後端與假 worker。
use super::attach;
use super::corrlog::{self, CorrLog, Dir, Entry};
use super::engines::{EngineEvent, EngineSet};
use super::launcher::{Launched, Launcher};
use super::partner_ops::{CommandJob, PartnerOps};
use super::slash;
use super::mail::{self, unaddressed_receipt, unaddressed_window_note, mail_head, parse_send_head, strip_reply_head, wants_reply, Mail, SendHead};
use super::pending::{self, LastReq, Pending, RoomRef, State};
use super::rooms::{self, Cursors};
use super::roster::{self, Window};
use super::worker::{forward_text, Parser, WorkerEvent, WorkerLine, WorkerSink};
use crate::relay::Relay;
use serde_json::{json, Value};
use sha1::{Digest, Sha1};
use std::collections::{BTreeMap, HashMap, HashSet, VecDeque};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

/// 後台節點信箱一次最多回幾封（與 irori_relay_inbox 的 limit 一致）
const INBOX_PAGE: usize = 50;
/// 一輪收信最多往後多拿幾批
const INBOX_ROUNDS: usize = 5;
/// 排除清單的名字上限（與後台 Edge Function 的上限一致）
const MAX_EXCLUDE: usize = 20;

fn env_u64(k: &str, d: u64) -> u64 {
    crate::envc::get(k).and_then(|v| v.trim().parse().ok()).unwrap_or(d)
}

/// 橋的設定。環境變數沿用 Node 橋的名稱與預設值（README「設定」）
#[derive(Clone, Debug)]
pub struct Config {
    pub node: String,
    pub mailbox_name: String,
    /// 沒指定收件視窗的信，環境變數 ASN_RELAY_DEFAULT_AGENT 指定的收件視窗（舊相容；預設空＝交給本人）。bridge.json 的設定優先
    pub default_agent: String,
    /// 設定檔（bridge.json）所在資料夾；沒有就只看環境變數
    pub data_dir: Option<PathBuf>,
    pub extra_allow: Vec<String>,
    pub work_dir: PathBuf,
    pub sessions_dir: PathBuf,
    /// Claude Code 外掛寫的狀態檔資料夾（~/.asn/status，橋只讀）
    pub status_dir: PathBuf,
    pub poll_ms: u64,
    pub roster_ms: u64,
    /// 本機視窗狀態監看的間隔（毫秒，預設 1000；0＝不監看）：狀態檔的 state 一變就立刻回報名單，不等 roster_ms
    pub watch_ms: u64,
    /// 立即回報的防抖間隔（毫秒，預設 1500）：連續快速變化合併成這段時間最多報一次
    pub watch_gap_ms: u64,
    pub tick_ms: u64,
    pub reply_timeout_ms: u64,
    pub late_keep_ms: u64,
    pub late_max: usize,
    /// 轉交後多久還沒回就提醒收件視窗一次（reply=yes 的信；10 分鐘的寄件人通知照舊）
    pub nudge_ms: u64,
    pub forward_timeout_ms: u64,
    pub pull_backoff_ms: Vec<u64>,
    pub claude_bin: String,
    pub claude_pre: Vec<String>,
    pub model: String,
    pub extra_env: Vec<(String, String)>,
    /// 名單裡也列出 ASN 自己的視窗名
    pub report_asn_window: bool,
    /// 附件下載指令前綴（不含 --id）。ASN 自己的命令列：`<asn-cli 完整路徑> attach`
    pub attach_cmd: Option<String>,
    /// 群組「要看更多」的指令前綴（`<asn-cli 完整路徑> room`）
    pub room_cmd: Option<String>,
    /// 依視窗名的往來記錄資料夾（預設 `~/.asn/handoff`；測試一律指到暫存資料夾）
    pub handoff_dir: PathBuf,
    /// 其他引擎（第五段）：ASN_ENGINES（舊名 IRORI_ENGINES）的值（逗號分隔的 acp／codex）；None＝自動（有 agents.json 載 acp、有 ~/.codex 載 codex）
    pub engines: Option<String>,
    /// 引擎子程序環境的來源（啟動時的環境變數快照）
    pub engine_env: Vec<(String, String)>,
    /// ACP 工作者設定檔（預設 `~/.asn/agents.json`，與舊橋同一份；ASN_AGENTS_FILE 可改，舊名 IRORI_AGENTS_FILE 仍可用）
    pub agents_file: PathBuf,
    /// 使用者家目錄（找 ~/.codex；測試指到暫存資料夾）
    pub home: PathBuf,
    /// 引擎名單重列的間隔
    pub engine_refresh_ms: u64,
}

impl Config {
    pub fn from_env(node: &str, work_dir: PathBuf) -> Config {
        let test_handoff = work_dir.join("handoff");
        let (work_dir_agents, work_dir_home) = (work_dir.join("agents.json"), work_dir.join("home"));
        let home = crate::identity::home_dir();
        let list = |k: &str| crate::envc::get(k).unwrap_or_default().split(',').map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect::<Vec<_>>();
        Config {
            node: node.into(),
            mailbox_name: crate::envc::get("ASN_MAILBOX_NAME").filter(|s| !s.trim().is_empty()).unwrap_or_else(|| format!("{node}-收發室")),
            default_agent: crate::envc::get("ASN_RELAY_DEFAULT_AGENT").filter(|s| !s.trim().is_empty()).unwrap_or_default(),
            data_dir: None,
            extra_allow: list("ASN_RELAY_ALLOW"),
            work_dir,
            sessions_dir: home.join(".claude").join("sessions"),
            status_dir: home.join(".asn").join("status"),
            poll_ms: env_u64("ASN_RELAY_POLL_MS", 120_000),
            roster_ms: env_u64("ASN_ROSTER_MS", 60_000),
            watch_ms: 1_000,
            watch_gap_ms: 1_500,
            tick_ms: env_u64("ASN_BRIDGE_TICK_MS", 5_000),
            reply_timeout_ms: env_u64("ASN_REPLY_TIMEOUT_MS", 600_000),
            late_keep_ms: env_u64("ASN_LATE_KEEP_MS", 86_400_000),
            late_max: env_u64("ASN_LATE_MAX", 200) as usize,
            nudge_ms: env_u64("ASN_NUDGE_MS", 300_000),
            forward_timeout_ms: env_u64("ASN_FORWARD_TIMEOUT_MS", 120_000),
            pull_backoff_ms: vec![5_000, 10_000, 20_000, 40_000, 60_000],
            claude_bin: std::env::var("CLAUDE_BIN").ok().filter(|s| !s.trim().is_empty()).unwrap_or_else(|| "claude".into()),
            claude_pre: vec![],
            model: crate::envc::get("ASN_MAILBOX_MODEL").filter(|s| !s.trim().is_empty()).unwrap_or_else(|| "haiku".into()),
            extra_env: vec![],
            report_asn_window: true,
            attach_cmd: attach::attach_cmd_from_env(),
            room_cmd: attach::room_cmd_from_env(),
            // 測試時絕不碰真實家目錄：往來記錄放進工作資料夾底下
            handoff_dir: if cfg!(test) { test_handoff } else { corrlog::default_dir() },
            // 測試時絕不碰真實的設定與 ~/.codex：只載 Claude，路徑都放進工作資料夾底下
            engines: if cfg!(test) { Some("claude".into()) } else { crate::envc::get("ASN_ENGINES").filter(|s| !s.trim().is_empty()) },
            engine_env: std::env::vars().collect(),
            agents_file: if cfg!(test) { work_dir_agents } else { crate::envc::get_os("ASN_AGENTS_FILE").filter(|s| !s.is_empty()).map(PathBuf::from).unwrap_or_else(|| crate::identity::relay_home().join("agents.json")) },
            home: if cfg!(test) { work_dir_home } else { home },
            engine_refresh_ms: env_u64("ASN_ROSTER_MS", 60_000),
        }
    }
}

/// 橋的 log：寫 bridge.log（超過上限就輪替成 bridge.log.1），同時在記憶體留最近 500 行（測試與設定頁用）
pub struct BridgeLog {
    file: Option<PathBuf>,
    mem: Mutex<VecDeque<String>>,
}
const LOG_MAX_BYTES: u64 = 2 * 1024 * 1024;

impl BridgeLog {
    pub fn new(file: Option<PathBuf>) -> BridgeLog {
        BridgeLog { file, mem: Mutex::new(VecDeque::new()) }
    }
    pub fn line(&self, msg: &str) {
        {
            let mut m = self.mem.lock().unwrap();
            if m.len() >= 500 {
                m.pop_front();
            }
            m.push_back(msg.to_string());
        }
        if let Some(f) = &self.file {
            use std::io::Write;
            if std::fs::metadata(f).map(|m| m.len() > LOG_MAX_BYTES).unwrap_or(false) {
                let _ = std::fs::rename(f, format!("{}.1", f.display()));
            }
            if let Ok(mut h) = std::fs::OpenOptions::new().create(true).append(true).open(f) {
                let _ = writeln!(h, "{} {}", crate::heartbeat::now_ms(), msg);
            }
        }
    }
    #[cfg(test)]
    pub fn recent(&self) -> Vec<String> {
        self.mem.lock().unwrap().iter().cloned().collect()
    }
    #[cfg(test)]
    pub fn has(&self, needle: &str) -> bool {
        self.mem.lock().unwrap().iter().any(|l| l.contains(needle))
    }
    #[cfg(test)]
    pub fn count(&self, needle: &str) -> usize {
        self.mem.lock().unwrap().iter().filter(|l| l.contains(needle)).count()
    }
}

/// 信件來源（回信、通知要寄給誰）
#[derive(Clone, Debug)]
struct Origin {
    id: String,
    from_node: String,
    from_agent: String,
}
impl Origin {
    fn of(p: &Pending) -> Origin {
        Origin { id: p.id.clone(), from_node: p.from_node.clone(), from_agent: p.from_agent.clone() }
    }
}

const NOTICE_TTL_MS: u64 = 600_000;
/// 本人傳的 /指令，但目標視窗沒有 ASN 外掛：照普通信投遞，另外回這句
const NO_MOD_NOTICE: &str = "這個視窗沒有 ASN 外掛，/指令 只能當文字送過去";
const DIRECT_NOTE: &str = "（這個視窗自己用命令列回了信，內文只在對方那邊，收發室看不到）";

pub struct Core {
    pub cfg: Config,
    pub(super) relay: Arc<Relay>,
    sink: Arc<dyn WorkerSink>,
    pub parser: Parser,
    pub log: Arc<BridgeLog>,
    alive: Arc<dyn Fn(u32) -> bool + Send + Sync>,
    now: u64,
    pub roster: Vec<Window>,
    pub roster_ok: bool,
    roster_warned: bool,
    seen: HashSet<String>,
    pub pending: Vec<Pending>,
    pub last_requester: BTreeMap<String, LastReq>,
    notice_ids: HashMap<String, u64>,
    notice_windows: HashMap<String, u64>,
    self_handled: HashSet<String>,
    unrouted: HashSet<String>,
    last_saved: String,
    persist_failed: bool,
    pruned_at: u64,
    fail_step: usize,
    pub retry_at: Option<u64>,
    cursors: Cursors,
    cursor_warned: bool,
    launcher: Option<Arc<Launcher>>,
    partner_ops: Option<Arc<PartnerOps>>,
    /// 其他引擎（ACP 工作者、Codex）；沒有就只有 Claude
    pub engines: Option<Arc<EngineSet>>,
    /// Claude 視窗（~/.claude/sessions）；roster ＝ 這個 ＋ 各引擎最近一次的名單
    claude_roster: Vec<Window>,
    corr: CorrLog,
    /// 視窗名 → 夥伴 ID（#109；每次回報名單時向後端對一次，只放記憶體）
    partners: BTreeMap<String, String>,
    /// 後台還沒支援夥伴 ID（404／400）：靜默停止，直到下次啟動
    partner_off: bool,
    partner_warned: bool,
    /// 這台電腦的外掛狀態從哪裡來（預設讀 claude_mod 的全域狀態；測試可換）
    mod_src: Arc<dyn Fn() -> Option<Value> + Send + Sync>,
    /// 上次成功回報的外掛狀態（內容, 時間）；沒變化就不重報
    mod_sent: Option<(String, u64)>,
    /// 上次回報名單時本機 Claude 視窗的指紋與時間（即時監看用）
    roster_fp: Option<String>,
    roster_at: u64,
}

/// JSON 數字（整數、浮點或數字字串）→ u64；不是數字回 0
fn json_u64(v: Option<&Value>) -> u64 {
    match v {
        Some(Value::Number(n)) => n.as_u64().or_else(|| n.as_f64().filter(|f| *f >= 0.0).map(|f| f as u64)).unwrap_or(0),
        Some(Value::String(s)) => s.trim().parse::<u64>().unwrap_or(0),
        _ => 0,
    }
}

fn new_uuid() -> String {
    let mut b = [0u8; 16];
    getrandom::fill(&mut b).expect("系統亂數不可用");
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    let h: String = b.iter().map(|x| format!("{x:02x}")).collect();
    format!("{}-{}-{}-{}-{}", &h[0..8], &h[8..12], &h[12..16], &h[16..20], &h[20..32])
}

/// send.mjs 寫的「曾寄信給某節點／視窗」記號檔名（sha1 of JSON 陣列），兩邊必須一致
pub fn sent_mark_name(from_window: &str, to_node: &str, to_agent: &str) -> String {
    let j = serde_json::to_string(&[from_window, to_node, to_agent]).unwrap_or_default();
    Sha1::digest(j.as_bytes()).iter().map(|b| format!("{b:02x}")).collect()
}

impl Core {
    pub fn new(cfg: Config, relay: Arc<Relay>, sink: Arc<dyn WorkerSink>, nonce: &str, log: Arc<BridgeLog>, alive: Arc<dyn Fn(u32) -> bool + Send + Sync>, now: u64) -> Core {
        let cursors = Cursors::load(&cfg.work_dir);
        let corr = CorrLog::new(cfg.handoff_dir.clone());
        let mut c = Core {
            cfg, relay, sink, parser: Parser::new(nonce), log, alive, now, roster: vec![], roster_ok: false, roster_warned: false, seen: HashSet::new(), pending: vec![],
            last_requester: BTreeMap::new(), notice_ids: HashMap::new(), notice_windows: HashMap::new(), self_handled: HashSet::new(), unrouted: HashSet::new(),
            last_saved: String::new(), persist_failed: false, pruned_at: 0, fail_step: 0, retry_at: None, cursors, cursor_warned: false, launcher: None, partner_ops: None, mod_src: Arc::new(crate::claude_mod::current_report), mod_sent: None, roster_fp: None, roster_at: 0, engines: None, claude_roster: vec![], corr,
            partners: BTreeMap::new(), partner_off: false, partner_warned: false,
        };
        c.restore();
        c
    }

    pub fn sink(&self) -> Arc<dyn WorkerSink> {
        self.sink.clone()
    }

    /// 接上其他引擎（第五段）。沒接＝只有 Claude 視窗
    pub fn set_engines(&mut self, e: Arc<EngineSet>) {
        if let (Some(p), Some(a)) = (&self.partner_ops, e.acp_admin()) {
            p.set_acp(a);
        }
        self.engines = Some(e);
    }

    /// 引擎回報：已轉交／失敗／回覆／名單有變
    pub async fn on_engine_event(&mut self, ev: EngineEvent, now: u64) {
        self.now = now;
        match ev {
            EngineEvent::Sent(id) => self.on_sent(&id).await,
            EngineEvent::Fail(id, reason) => self.on_fail(&id, &reason).await,
            EngineEvent::Reply { from, text, mail_id } => self.on_reply(&from, &text, mail_id).await,
            EngineEvent::RosterChanged => self.refresh_roster(now).await,
        }
    }

    /// 接上遠端管理夥伴視窗（詳情／改名／切換模型／關閉／轉交）。沒接＝不處理 partner_op_pending
    pub fn set_partner_ops(&mut self, p: Arc<PartnerOps>) {
        if let Some(a) = self.engines.as_ref().and_then(|e| e.acp_admin()) {
            p.set_acp(a);
        }
        self.partner_ops = Some(p);
    }

    /// 接上遠端開視窗（第三段）。沒接＝名單回報 launcher 送 null、不處理 launch_pending
    pub fn set_mod_source(&mut self, f: Arc<dyn Fn() -> Option<Value> + Send + Sync>) {
        self.mod_src = f;
    }

    pub fn set_launcher(&mut self, l: Arc<Launcher>) {
        self.launcher = Some(l);
    }

    fn pending_file(&self) -> PathBuf {
        self.cfg.work_dir.join("pending.json")
    }
    fn restore(&mut self) {
        let st = pending::load_state(&self.pending_file(), self.now, self.cfg.late_keep_ms);
        if let Some(e) = &st.error {
            self.log.line(&format!("pending.json unreadable, ignored: {e}"));
        }
        let n = st.pending.iter().filter(|p| p.state == State::Notified).count();
        if !st.pending.is_empty() || !st.last.is_empty() || st.dropped > 0 {
            self.log.line(&format!("pending restored: {} (waiting {}, notified {}), lastRequester {}, expired/invalid dropped {}", st.pending.len(), st.pending.len() - n, n, st.last.len(), st.dropped));
        }
        self.pending = st.pending;
        self.last_requester = st.last;
    }
    fn persist(&mut self) {
        let snap = pending::snapshot(&self.pending, &self.last_requester);
        let text = snap.to_string();
        if text == self.last_saved {
            return;
        }
        match pending::save_atomic(&self.pending_file(), &snap) {
            Ok(_) => {
                self.last_saved = text;
                self.persist_failed = false;
            }
            Err(e) => {
                if !self.persist_failed {
                    self.persist_failed = true;
                    self.log.line(&format!("pending.json save failed: {e}"));
                }
            }
        }
    }

    // ---- 小工具 ----
    fn idx(&self, id: &str) -> Option<usize> {
        self.pending.iter().position(|p| p.id == id)
    }
    fn remove(&mut self, id: &str) {
        self.pending.retain(|p| p.id != id);
        self.persist();
    }
    fn online_names(&self) -> HashSet<&str> {
        self.roster.iter().map(|w| w.name.as_str()).filter(|n| *n != self.cfg.mailbox_name).collect()
    }
    fn forwardable(&self, name: &str) -> bool {
        self.roster.iter().any(|w| w.name == name) || (self.cfg.extra_allow.iter().any(|n| n == name) && self.online_names().contains(name))
    }
    fn agent_of(&self, name: &str) -> Option<&Window> {
        self.roster.iter().find(|w| w.name == name)
    }
    fn is_mailbox_sender(from_agent: &str) -> bool {
        from_agent.ends_with("收發室")
    }
    fn fresh(&self, t: Option<&u64>) -> bool {
        t.map(|t| self.now.saturating_sub(*t) < NOTICE_TTL_MS).unwrap_or(false)
    }
    fn replied_directly(&self, id: &str) -> bool {
        self.cfg.work_dir.join("replied").join(id).exists()
    }
    fn sent_to_sender(&self, p: &Pending) -> bool {
        for to in [p.from_agent.as_str(), ""] {
            let f = self.cfg.work_dir.join("sent").join(sent_mark_name(&p.target, &p.from_node, to));
            if std::fs::read_to_string(f).ok().and_then(|s| s.trim().parse::<u64>().ok()).map(|t| t >= p.t0).unwrap_or(false) {
                return true;
            }
        }
        false
    }
    fn prune_marks(&mut self) {
        if self.now.saturating_sub(self.pruned_at) < 3_600_000 {
            return;
        }
        self.pruned_at = self.now;
        for d in ["replied", "sent"] {
            if let Ok(rd) = std::fs::read_dir(self.cfg.work_dir.join(d)) {
                for e in rd.flatten() {
                    let old = e.metadata().and_then(|m| m.modified()).ok().and_then(|t| t.elapsed().ok()).map(|a| a.as_millis() as u64 > 86_400_000).unwrap_or(false);
                    if old {
                        let _ = std::fs::remove_file(e.path());
                    }
                }
            }
        }
    }

    // ---- 對後端 ----
    async fn send_back(&self, o: &Origin, body: &str, from_agent: Option<&str>, expects_reply: Option<bool>) -> bool {
        let mut b = json!({ "to_node": o.from_node, "body": body, "reply_to": o.id, "from_agent": from_agent.unwrap_or(&self.cfg.mailbox_name) });
        if !o.from_agent.is_empty() {
            b["to_agent"] = json!(o.from_agent);
        }
        if let Some(e) = expects_reply {
            b["expects_reply"] = json!(e);
        }
        match self.relay.api("send", Some(b)).await {
            Ok(_) => true,
            Err(e) => {
                self.log.line(&format!("send back failed id={}: {e}", o.id));
                false
            }
        }
    }
    async fn ack_ids(&mut self, ids: &[String]) {
        if ids.is_empty() {
            return;
        }
        match self.relay.api("ack", Some(json!({ "ids": ids }))).await {
            Ok(_) => ids.iter().for_each(|i| {
                self.seen.insert(i.clone());
            }),
            Err(e) => self.log.line(&format!("ack failed: {e}")),
        }
    }

    // ---- 名單 ----
    /// 即時監看（每 watch_ms 一次）：只讀本機 sessions 與外掛狀態檔，名字／狀態／說明和上次回報時不同
    /// （心跳只改 at，不算）且距上次回報已過防抖間隔，就立刻整份回報名單（後台再通知別台設備重拉）。回傳有沒有回報。
    pub async fn watch_local(&mut self, now: u64) -> bool {
        let alive = self.alive.clone();
        let Some(l) = roster::read_local(&self.cfg.sessions_dir, &self.cfg.status_dir, |p| alive(p), self.sink.pid(), &self.cfg.mailbox_name, now) else {
            return false;
        };
        let fp = roster::local_fingerprint(&l);
        if !roster::push_due(&fp, self.roster_fp.as_deref(), now, self.roster_at, self.cfg.watch_gap_ms) {
            return false;
        }
        self.refresh_roster(now).await;
        true
    }

    pub async fn refresh_roster(&mut self, now: u64) {
        self.now = now;
        let alive = self.alive.clone();
        let claude = roster::read_sessions(&self.cfg.sessions_dir, |p| alive(p), self.sink.pid(), &self.cfg.mailbox_name);
        let engine_ok = self.engines.as_ref().map(|e| e.has_result()).unwrap_or(false);
        // Claude 讀不到、其他引擎也還沒有任何結果：名單不動（和以前一樣）
        if claude.is_none() && !engine_ok {
            return;
        }
        if let Some(mut l) = claude {
            roster::apply_mod_status(&mut l, &self.cfg.status_dir, now);
            let live: Vec<String> = l.iter().filter_map(|w| w.session_id.clone()).collect();
            roster::cleanup_mod_status(&self.cfg.status_dir, &live, now);
            self.roster_fp = Some(roster::local_fingerprint(&l));
            self.roster_at = now;
            self.claude_roster = l;
        }
        let mut list = self.claude_roster.clone();
        if let Some(e) = &self.engines {
            list.extend(e.windows().into_iter().filter(|w| w.name != self.cfg.mailbox_name));
        }
        self.roster = list;
        self.roster_ok = true;
        let asn = self.cfg.report_asn_window.then(|| self.relay.window_name());
        // 摘要要讀設定檔、偵測 CLI（會開外部程序），放到背景執行緒，不卡住收信的主迴圈
        let launcher = match self.launcher.clone() {
            Some(l) => tokio::task::spawn_blocking(move || l.summary()).await.unwrap_or(Value::Null),
            None => Value::Null,
        };
        let mut body = roster::roster_body(&self.roster, asn.as_deref(), launcher);
        // 這台電腦的 Claude 外掛狀態：啟動檢查完與狀態變化時才附（舊後台會丟掉這個欄位，不壞）
        let due = roster::mod_report_due((self.mod_src)(), self.mod_sent.as_ref(), now);
        if let Some(m) = &due {
            body["mod"] = m.clone();
        }
        match self.relay.api("roster", Some(body)).await {
            Ok(_) => {
                self.roster_warned = false;
                if let Some(m) = due {
                    self.mod_sent = Some((m.to_string(), now));
                }
            }
            Err(e) => {
                if !self.roster_warned {
                    self.log.line(&format!("roster post failed: {e} (will keep trying quietly)"));
                    self.roster_warned = true;
                }
            }
        }
        self.sync_partners(asn.as_deref()).await;
    }

    /// 夥伴 ID（#109）：把名字與 session 交給後台判斷是哪位夥伴，回來的 ID 只存記憶體，並讓往來記錄檔頭帶上。
    /// 後台沒有這個動作（404／400）就靜默停用、一切照舊；其他失敗只記一次 log，下一輪再試。
    async fn sync_partners(&mut self, asn: Option<&str>) {
        if self.partner_off {
            return;
        }
        match self.relay.api("partner_sync", Some(roster::partner_body(&self.roster, asn))).await {
            Ok(v) => {
                self.partner_warned = false;
                self.partners = roster::parse_partners(&v);
                self.corr.set_partners(self.partners.clone());
                if let Some(p) = &self.partner_ops {
                    p.set_partners(self.partners.clone());
                }
            }
            Err(e) if crate::relay::set_name_unsupported(&e) => {
                self.partner_off = true;
                self.log.line("partner_sync not supported by backend (carrying on without partner ids)");
            }
            Err(e) => {
                if !self.partner_warned {
                    self.log.line(&format!("partner_sync failed: {e} (will keep trying quietly)"));
                    self.partner_warned = true;
                }
            }
        }
    }

    /// 目前視窗名對應的夥伴 ID（後台還沒回、或不支援就是 None）
    pub fn partner_id(&self, name: &str) -> Option<&str> {
        self.partners.get(name).map(String::as_str)
    }

    // ---- 收信 ----
    /// 拉一次；失敗就記 log 並排短退避重試（5s→10s→20s→40s→60s，成功後歸零）
    pub async fn pull(&mut self, why: &str, now: u64) {
        self.now = now;
        self.retry_at = None;
        let r = self.pull_once().await;
        // 遠端開視窗與群組跟信件各走各的：失敗只記 log，不影響信件的退避重試
        if let Some(l) = self.launcher.clone() {
            l.pull().await;
        }
        if let Some(p) = self.partner_ops.clone() {
            p.pull().await;
        }
        self.pull_rooms(now).await;
        match r {
            Ok(_) => self.fail_step = 0,
            Err(e) => {
                self.log.line(&format!("pull failed ({why}): {e}"));
                let steps = &self.cfg.pull_backoff_ms;
                let d = steps[self.fail_step.min(steps.len() - 1)];
                self.fail_step = (self.fail_step + 1).min(steps.len() - 1);
                self.retry_at = Some(self.now + d);
            }
        }
    }
    pub fn retry_due(&self, now: u64) -> bool {
        self.retry_at.map(|t| now >= t).unwrap_or(false)
    }
    async fn pull_once(&mut self) -> Result<(), String> {
        // 寄給 ASN 自己視窗（含 7 天內舊名）的信橋不收（留給 ASN 畫面收），一律請後台別放進這份信箱，免得它們塞滿一頁、擋住後面寄給別人的信
        let mut exclude = self.relay.active_names();
        let mut done: HashSet<String> = HashSet::new();
        for round in 0..INBOX_ROUNDS {
            let v = match self.relay.api(&crate::relay::inbox_action(&exclude), None).await {
                Ok(v) => v,
                Err(e) if round == 0 => return Err(e),
                Err(e) => {
                    self.log.line(&format!("inbox refetch failed: {e}"));
                    break;
                }
            };
            let msgs: Vec<Value> = v.get("messages").and_then(Value::as_array).cloned().unwrap_or_default();
            let full = msgs.len() >= INBOX_PAGE;
            let (mut dup, mut held) = (vec![], vec![]);
            for raw in msgs {
                let Some(m) = Mail::from_json(&raw) else { continue };
                if done.contains(&m.id) {
                    continue;
                }
                if self.seen.contains(&m.id) {
                    dup.push(m.id);
                    continue;
                }
                if self.idx(&m.id).is_some() {
                    // 已在處理中、還沒 ack：同樣佔著信箱的位置
                    held.extend(m.to_agent.clone());
                    continue;
                }
                // 還沒拿到第一份名單：收件視窗在空名單裡一定找不到，不能回「找不到」還 ack；先留在 inbox，等名單到了下一輪再處理（和群組一樣）
                if !self.roster_ok {
                    continue;
                }
                done.insert(m.id.clone());
                held.extend(self.handle_mail_raw(m, Some(raw)).await);
            }
            self.ack_ids(&dup).await;
            // 整頁（後台一次最多回 INBOX_PAGE 封）都被留著不處理的信占滿時，把這些視窗名也加進排除清單再拿下一批；沒有新名字（或後台不認排除參數）就停，不空轉
            let mut fresh: Vec<String> = vec![];
            for n in held {
                if !exclude.contains(&n) && !fresh.contains(&n) {
                    fresh.push(n);
                }
            }
            if !full || fresh.is_empty() || exclude.len() + fresh.len() > MAX_EXCLUDE {
                break;
            }
            self.log.line(&format!("inbox page full of mail left in place; fetching more excluding {}", fresh.join(",")));
            exclude.extend(fresh);
        }
        Ok(())
    }

    /// 沒指定收件視窗的信要交給誰：使用者在設定指定的視窗（bridge.json），沒有再看環境變數；兩者都空＝交給本人。
    /// 指定的視窗不在線也不改丟給別的 session，退回交給本人
    fn unaddressed_window(&self) -> Option<String> {
        let set = self.cfg.data_dir.as_ref().map(|d| super::read_settings(d).unaddressed_to).unwrap_or_default();
        let name = if set.trim().is_empty() { self.cfg.default_agent.trim().to_string() } else { set.trim().to_string() };
        (!name.is_empty() && self.online_names().contains(name.as_str()) && !self.relay.active_names().contains(&name)).then_some(name)
    }

    /// 往來記錄：失敗只記 log，不影響轉交
    fn corr_note(&self, name: &str, dir: Dir, from: &str, to: &str, id: &str, body: &str, attachments: &[String]) {
        if let Err(e) = self.corr.append(name, &Entry { ts_ms: self.now, dir, from, to, id, body, attachments }) {
            self.log.line(&format!("corr log failed window={name}: {e}"));
        }
    }
    fn node_agent(node: &str, agent: &str) -> String {
        if agent.is_empty() { node.to_string() } else { format!("{node}/{agent}") }
    }

    /// 視窗背後的引擎代號（名單上沒有的名字，例如 extra_allow，當 Claude）
    fn engine_of(&self, name: &str) -> String {
        self.agent_of(name).map(|w| w.engine.clone()).unwrap_or_else(|| "claude".into())
    }
    /// 名單上顯示的引擎名（信件抬頭 engine= 用）
    fn engine_label_of(&self, name: &str) -> String {
        self.agent_of(name).map(|w| w.label().to_string()).unwrap_or_else(|| "claude".into())
    }

    /// 信件最後多一行「往來記錄在哪」。ACP 背景工作者只能讀自己的工作資料夾，讀不到那個檔，所以不附
    fn with_path_line(&self, text: String, target: &str) -> String {
        if self.engine_of(target) == "acp" {
            return text;
        }
        format!("{text}\n{}", self.corr.path_line(target))
    }

    fn deliver(&mut self, id: &str, to: &str, text: &str) -> Result<(), String> {
        let eng = self.engine_of(to);
        if eng != "claude" {
            return match &self.engines {
                Some(e) => e.deliver(&eng, id, to, text),
                None => Err(format!("沒有載入「{eng}」引擎")),
            };
        }
        self.parser.register(id, to);
        self.sink.say(forward_text(&self.parser.nonce, id, to, text))
    }

    pub async fn handle_mail(&mut self, m: Mail) {
        self.handle_mail_raw(m, None).await;
    }

    /// raw＝後端回的原始信件（交給本人時原樣保留時間、附件等欄位）；沒有就用解析後的欄位重組
    /// 回傳 Some(視窗名)＝這封信留在信箱沒處理（ASN 自己的視窗、視窗自己在收、轉交失敗），收信時拿來排除，免得占滿一頁
    pub async fn handle_mail_raw(&mut self, m: Mail, raw: Option<Value>) -> Option<String> {
        if let Some(to) = m.to_agent.clone() {
            // 寄給 ASN 自己視窗的信：留給 ASN 自己的畫面收（不轉交、不 ack）
            if self.relay.active_names().contains(&to) {
                if self.self_handled.insert(m.id.clone()) {
                    self.log.line(&format!("id={} to={to} is ASN's own window: bridge skips", m.id));
                }
                return Some(to);
            }
            // 這個視窗自己在收信（recv 心跳 90 秒內且 pid 活著）：橋不轉、不 ack；心跳過期就照舊轉交（只有 Claude 視窗會自己收信）
            if self.engine_of(&to) == "claude" && crate::heartbeat::read_heartbeat(&self.cfg.work_dir, &to).map(|h| crate::heartbeat::alive_fresh(&h, self.now, crate::heartbeat::stale_ms(), |p| (self.alive)(p))).unwrap_or(false) {
                if self.self_handled.insert(m.id.clone()) {
                    self.log.line(&format!("id={} to={to} window receives by itself (recv heartbeat): bridge skips", m.id));
                }
                return Some(to);
            }
        }
        let from_agent = m.from_agent.clone().unwrap_or_default();
        let mut note = String::new();
        let target = match m.to_agent.clone() {
            Some(t) => t,
            None => match self.unaddressed_window() {
                // 使用者指定了「沒指定收件人的信交給誰」而且那個視窗在線：照設定給它
                Some(w) => {
                    note = unaddressed_window_note(&w);
                    self.log.line(&format!("id={} has no to_agent: handed to configured window {w}", m.id));
                    w
                }
                // 否則交給本人（ASN 視窗）：信留在信箱不 ack，ASN 畫面收下才 ack。不再丟給隨便一個 session
                None => {
                    self.hand_to_owner(&m, raw, &from_agent).await;
                    return None;
                }
            },
        };
        let no_reply = !wants_reply(m.expects_reply, &m.body) || Self::is_mailbox_sender(&from_agent);
        let mut p = Pending::new(&m.id, &m.from_node, &from_agent, &target, self.now, no_reply);
        p.sender_desc = mail::sender_line(&m).trim_start_matches("寄件人：").to_string();
        if !self.forwardable(&target) {
            let names = if self.roster.is_empty() { "(無)".to_string() } else { self.roster.iter().map(|w| w.name.as_str()).collect::<Vec<_>>().join("、") };
            p.state = State::Done;
            if Self::is_mailbox_sender(&from_agent) {
                self.log.line(&format!("id={} target {target} not found; notice to mailbox sender not sent", m.id));
            } else {
                self.send_back(&Origin::of(&p), &format!("[收發室] 找不到名叫「{target}」的 session（目前可達：{names}）"), None, None).await;
            }
            self.ack_ids(&[m.id.clone()]).await;
            return None;
        }
        // 本人傳來的「/指令」：目標是有 ASN 外掛的 Claude 視窗就交給外掛執行（背景等它做完，不擋其他信）；
        // 其他視窗（沒有外掛、Codex、Gemini 等）照舊當普通信投遞，並另外回一封說明
        let mut no_mod_notice = false;
        if let Some(cmd) = slash::parse(&m) {
            let po = self.partner_ops.clone();
            if let Some(done) = po.as_ref().and_then(|po| po.command_state(&m.id)) {
                // 已經在處理或做完了：不再執行；做完了但 ack 沒成功的，這裡補 ack
                if done {
                    self.ack_ids(&[m.id.clone()]).await;
                    return None;
                }
                return Some(target);
            }
            let sid = if self.engine_of(&target) == "claude" { po.as_ref().and_then(|po| po.command_target(&target)) } else { None };
            match (po, sid) {
                (Some(po), Some(sid)) => {
                    self.log.line(&format!("id={} from={}/{} is a slash command /{} for {target}: handed to the window's plugin", m.id, m.from_node, from_agent, cmd.command));
                    let sender = p.sender_desc.clone();
                    po.start_command(CommandJob { mail_id: m.id.clone(), window: target.clone(), command: cmd.command, args: cmd.args, from_node: m.from_node.clone(), from_agent: from_agent.clone(), sender, reply_from: self.cfg.mailbox_name.clone() }, sid);
                    return Some(target);
                }
                _ => no_mod_notice = true,
            }
        }
        let origin = Origin::of(&p);
        self.pending.push(p);
        if !no_reply {
            self.last_requester.insert(target.clone(), LastReq { from_node: m.from_node.clone(), from_agent: from_agent.clone(), mail_id: m.id.clone(), t: self.now });
        }
        self.persist();
        // 照片／檔案：內文後面多一行「〔照片〕檔名＋下載指令」，和內文一起在外部資料區塊內
        let body = attach::notes_for(&mail::escape_body(&m.body), &m.attachments, self.cfg.attach_cmd.as_deref());
        let text = format!("{}\n{}{}{}", mail_head(&m, &self.engine_label_of(&target)), mail::preamble(&m, &self.engine_of(&target)),if note.is_empty() { String::new() } else { format!("{note}\n") }, body);
        let text = self.with_path_line(text, &target);
        match self.deliver(&m.id, &target, &text) {
            Ok(_) => {
                self.log.line(&format!("handed id={} from={}/{} to={target}", m.id, m.from_node, from_agent));
                let names: Vec<String> = m.attachments.iter().map(|a| a.name.clone()).collect();
                self.corr_note(&target, Dir::Received, &Self::node_agent(&m.from_node, &from_agent), &target, &m.id, &m.body, &names);
                if no_mod_notice {
                    self.send_back(&origin, NO_MOD_NOTICE, None, Some(false)).await;
                }
            }
            Err(e) => {
                self.remove(&m.id);
                self.log.line(&format!("cannot hand id={}: {e} (left in inbox)", m.id));
                return Some(target);
            }
        }
        None
    }

    /// 沒指定收件視窗的信交給本人：留在信箱（不 ack、不轉交），ASN 畫面以「寄件人 → 未指定收件人」顯示並由本人決定；寄件人（要回覆的話）收到一次說明
    async fn hand_to_owner(&mut self, m: &Mail, raw: Option<Value>, from_agent: &str) {
        let raw = raw.unwrap_or_else(|| {
            json!({ "id": m.id, "from_node": m.from_node, "from_agent": m.from_agent, "to_agent": null, "body": m.body, "trust": m.trust, "expects_reply": m.expects_reply,
                "created_at": null })
        });
        if !self.relay.hold_unaddressed(raw) || !self.unrouted.insert(m.id.clone()) {
            return;
        }
        let owner = self.relay.window_name();
        self.log.line(&format!("id={} has no to_agent: kept in inbox for the owner ({owner}), not acked", m.id));
        if wants_reply(m.expects_reply, &m.body) && !Self::is_mailbox_sender(from_agent) {
            let p = Pending::new(&m.id, &m.from_node, from_agent, &owner, self.now, true);
            self.send_back(&Origin::of(&p), &unaddressed_receipt(&owner), None, Some(false)).await;
        }
    }

    // ---- worker 回報 ----
    pub async fn on_worker_line(&mut self, l: WorkerLine, now: u64) {
        self.now = now;
        match l {
            WorkerLine::Started(_) => self.parser.reset_process(),
            WorkerLine::Exited(_) => {}
            WorkerLine::Line(line) => {
                let r = self.parser.feed(&line);
                for l in &r.logs {
                    self.log.line(l);
                }
                for ev in r.events {
                    match ev {
                        WorkerEvent::Sent(id) => self.on_sent(&id).await,
                        WorkerEvent::Fail(id, reason) => self.on_fail(&id, &reason).await,
                        WorkerEvent::Reply { from, text } => self.on_reply(&from, &text, None).await,
                    }
                }
                if r.restart {
                    self.sink.kill();
                }
            }
        }
    }

    pub async fn on_sent(&mut self, id: &str) {
        let Some(i) = self.idx(id) else { return };
        if self.pending[i].state != State::Forwarding {
            return;
        }
        self.pending[i].state = State::Waiting;
        self.persist();
        let (target, t0, no_reply) = (self.pending[i].target.clone(), self.pending[i].t0, self.pending[i].no_reply);
        if let Some(r) = self.pending[i].room.clone() {
            // 群組訊息：只記 log、開始等回覆；不 ack（群組沒有信箱）
            self.log.line(&format!("forwarded room={} #{} -> {target}", r.id, r.seq));
            self.pending[i].t = self.now;
            return;
        }
        if no_reply {
            self.remove(id);
            self.log.line(&format!("forwarded id={id} -> {target} (no-reply mail, no timer)"));
            self.ack_ids(&[id.to_string()]).await;
            return;
        }
        self.log.line(&format!("forwarded id={id} -> {target} ({}ms)", self.now.saturating_sub(t0)));
        self.pending[i].t = self.now;
        self.ack_ids(&[id.to_string()]).await;
    }

    pub async fn on_fail(&mut self, id: &str, reason: &str) {
        let Some(i) = self.idx(id) else { return };
        if self.pending[i].state == State::Done {
            return;
        }
        self.pending[i].state = State::Done;
        let (o, target, from_agent) = (Origin::of(&self.pending[i]), self.pending[i].target.clone(), self.pending[i].from_agent.clone());
        self.log.line(&format!("forward failed id={id}: {reason}"));
        if self.pending[i].room.is_some() {
            self.remove(id); // 群組訊息：只記 log，不回群組
            return;
        }
        if Self::is_mailbox_sender(&from_agent) {
            self.log.line(&format!("forward failure notice to mailbox sender {}/{} not sent id={id}", o.from_node, from_agent));
        } else {
            let why = if reason.is_empty() { "原因不明" } else { reason };
            self.send_back(&o, &format!("[收發室] 轉交給 {target} 失敗：{why}"), None, None).await;
        }
        self.ack_ids(&[id.to_string()]).await;
        self.remove(id);
    }

    /// 對不上任何來信的回覆：該視窗 24 小時內有最近一次交辦它的寄件人，就轉給他；沒有才丟棄
    async fn forward_unmatched(&mut self, from: &str, text: &str, expects: Option<bool>) {
        let lr = self.last_requester.get(from).cloned();
        let keep = self.cfg.late_keep_ms;
        let Some(lr) = lr.filter(|l| self.now.saturating_sub(l.t) <= keep) else {
            self.log.line(&format!("unmatched reply from {from} ({} chars) dropped: no pending mail and no requester within {}h", text.chars().count(), keep / 3_600_000));
            return;
        };
        let o = Origin { id: lr.mail_id.clone(), from_node: lr.from_node.clone(), from_agent: lr.from_agent.clone() };
        let ok = self.send_back(&o, &format!("（收發室：這則回覆對不上特定來信，依最近一次交辦轉給你）\n{text}"), Some(from), expects).await;
        if ok {
            self.corr_note(from, Dir::Replied, from, &Self::node_agent(&o.from_node, &o.from_agent), &o.id, text, &[]);
        }
        self.log.line(&format!("unmatched reply from {from} ({} chars) -> last requester {}/{} reply_to={} sent={ok}", text.chars().count(), lr.from_node, lr.from_agent, lr.mail_id));
    }

    /// 視窗主動寄信（代寄）：寄件人是這個視窗
    async fn send_new(&self, from: &str, h: &SendHead) {
        if h.body.is_empty() {
            self.log.line(&format!("new mail from {from} to {} dropped: empty body", h.to_node));
            return;
        }
        let mut b = json!({ "to_node": h.to_node, "body": h.body, "from_agent": from, "expects_reply": h.reply.as_deref() == Some("yes") });
        if let Some(a) = &h.to_agent {
            b["to_agent"] = json!(a);
        }
        match self.relay.api("send", Some(b)).await {
            Ok(r) => {
                let nid = r.get("id").and_then(Value::as_str).unwrap_or("?");
                self.log.line(&format!("new mail from {from} -> {}/{} id={nid} sent=true reply={}", h.to_node, h.to_agent.clone().unwrap_or_default(), h.reply.clone().unwrap_or_default()));
                self.corr_note(from, Dir::Replied, from, &Self::node_agent(&h.to_node, h.to_agent.as_deref().unwrap_or("")), nid, &h.body, &[]);
            }
            Err(e) => self.log.line(&format!("new mail from {from} -> {} failed: {e}", h.to_node)),
        }
    }

    fn refuse_send(&mut self, from: &str, h: &SendHead) {
        self.log.line(&format!("new mail from {from} to {} refused: no reply=yes|no in [RELAY 寄信] head (not sent)", h.to_node));
        let head: String = h.body.split_whitespace().collect::<Vec<_>>().join(" ").chars().take(40).collect();
        self.tell_window(from, &format!("[收發室] 你傳給收發室的代寄信沒有寄出：第一行 [RELAY 寄信] to=… 少了 reply=yes 或 reply=no。等對方回信就寫 reply=yes、只是告知就寫 reply=no（回信 re=<id> 也一樣要寫），補上後請重傳一次。（這是系統通知，不用回覆。）內文開頭：{head}"));
    }

    /// 通知信的編號／視窗記一下（TTL 10 分鐘）：視窗若回了這則通知，那則回覆不是給任何人的，丟掉
    fn tell_window(&mut self, name: &str, text: &str) {
        let id = new_uuid();
        let now = self.now;
        self.notice_ids.retain(|_, t| now.saturating_sub(*t) < NOTICE_TTL_MS);
        self.notice_windows.retain(|_, t| now.saturating_sub(*t) < NOTICE_TTL_MS);
        self.notice_ids.insert(id.clone(), now);
        self.notice_windows.insert(name.to_string(), now);
        if let Err(e) = self.deliver(&id, name, text) {
            self.log.line(&format!("cannot tell window {name}: {e}"));
        }
    }

    pub async fn on_reply(&mut self, from: &str, text: &str, mail_id: Option<String>) {
        let mut text = text.to_string();
        let mut mail_id = mail_id;
        let mut expects: Option<bool> = None;
        let head = parse_send_head(&text);
        if let Some(h) = &head {
            if h.re.is_none() && mail_id.is_none() {
                if h.reply.is_some() {
                    self.send_new(from, h).await;
                } else {
                    self.refuse_send(from, h);
                }
                return;
            }
            if let Some(re) = &h.re {
                if h.reply.is_none() {
                    self.refuse_send(from, h);
                    return;
                }
                mail_id = Some(re.clone());
                if !h.body.is_empty() {
                    text = h.body.clone();
                }
                expects = Some(h.reply.as_deref() == Some("yes"));
            }
        }
        let (sid, body) = strip_reply_head(&text);
        if let Some(sid) = sid {
            text = body;
            if mail_id.is_none() {
                mail_id = Some(sid);
            }
        }
        // 候選：這個視窗的、已轉交完成的信。還在等的優先；沒有才輪到已通知過「沒回」仍保留的（遲到的回覆，先進先出）
        let cands: Vec<usize> = (0..self.pending.len()).filter(|&i| self.pending[i].target == from && self.pending[i].state != State::Forwarding).collect();
        let active: Vec<usize> = cands.iter().copied().filter(|&i| self.pending[i].state != State::Notified).collect();
        let by_id = mail_id.as_ref().and_then(|m| cands.iter().copied().find(|&i| &self.pending[i].id == m));
        let pick = by_id
            .or_else(|| active.iter().copied().find(|&i| !self.pending[i].replied))
            .or_else(|| active.last().copied())
            .or_else(|| cands.iter().copied().find(|&i| self.pending[i].state == State::Notified));
        let Some(i) = pick else {
            let by_notice = self.fresh(mail_id.as_ref().and_then(|m| self.notice_ids.get(m))) || self.fresh(self.notice_windows.get(from));
            if by_notice {
                if let Some(m) = &mail_id {
                    self.notice_ids.remove(m);
                }
                self.notice_windows.remove(from);
                self.log.line(&format!("reply from {from} dropped: answer to a bridge notice (not forwarded)"));
                return;
            }
            self.forward_unmatched(from, &text, expects).await;
            return;
        };
        let late = self.pending[i].state == State::Notified;
        self.pending[i].replied = true;
        let (o, t0) = (Origin::of(&self.pending[i]), self.pending[i].t0);
        let room = self.pending[i].room.clone();
        if late {
            self.remove(&o.id); // 遲到的回覆寄回後就清掉
        } else {
            self.persist();
        }
        if let Some(r) = room {
            if rooms::is_no_reply(&text) {
                self.log.line(&format!("room reply from {from} room={} #{} marked no-reply: not posted", r.id, r.seq));
                return;
            }
            // 節點本身是成員時以節點發言；視窗是成員時以「節點~視窗」發言
            let ok = self.post_room(&r, &text).await;
            if ok {
                self.corr_note(from, Dir::Replied, from, &format!("群組 {}", r.id), &o.id, &text, &[]);
            }
            self.log.line(&format!("room reply from {from} -> room={} #{} posted={ok}", r.id, r.seq));
            return;
        }
        let body = text.clone();
        let ok = self.send_back(&o, &body, Some(from), expects).await;
        if ok {
            self.corr_note(from, Dir::Replied, from, &Self::node_agent(&o.from_node, &o.from_agent), &o.id, &text, &[]);
        }
        self.log.line(&format!("{}reply from {from} -> {} id={} sent={ok} ({}ms total)", if late { "late " } else { "" }, o.from_node, o.id, self.now.saturating_sub(t0)));
    }

    // ---- 群組 ----
    fn save_cursor(&mut self, key: &str, v: u64) {
        if let Err(e) = self.cursors.set(key, v) {
            if !self.cursor_warned {
                self.cursor_warned = true;
                self.log.line(&format!("rooms cursor save failed: {e}"));
            }
        }
    }

    /// 拉一次群組：room_list → 每個 mine 項目用本地游標 room_read(since) → 只處理後端標 for_me=true 的訊息 → 推進游標。
    /// 游標不用 mark、不動後端已讀位置；轉交失敗（回 false）就停在那則前面，下次再來。
    pub async fn pull_rooms(&mut self, now: u64) {
        self.now = now;
        let list = match self.relay.api("room_list", None).await {
            Ok(v) => v.get("rooms").and_then(Value::as_array).cloned().unwrap_or_default(),
            Err(e) => {
                self.log.line(&format!("room_list failed: {e}"));
                return;
            }
        };
        for room in list {
            let Some(room_id) = room.get("id").and_then(Value::as_str).map(String::from) else { continue };
            let last_seq = json_u64(room.get("last_seq"));
            for mine in room.get("mine").and_then(Value::as_array).cloned().unwrap_or_default() {
                let Some(member) = mine.get("member").and_then(Value::as_str).map(String::from) else { continue };
                let ck = Cursors::key(&room_id, &member);
                let mut cur = match self.cursors.get(&ck) {
                    Some(c) => c,
                    None => {
                        // 第一次看到：從已讀位置起算（沒有就從最新起算，不補播舊訊息）
                        let c = Some(json_u64(mine.get("read_seq"))).filter(|n| *n > 0).or(Some(last_seq).filter(|n| *n > 0)).unwrap_or(0);
                        self.save_cursor(&ck, c);
                        c
                    }
                };
                if last_seq <= cur {
                    continue;
                }
                let window = rooms::member_window(&member);
                let as_agent = if window.is_empty() { String::new() } else { format!("&as_agent={}", crate::relay::encode_component(&window)) };
                let res = match self.relay.api(&format!("room_read&room={}{as_agent}&since={cur}&limit=100", crate::relay::encode_component(&room_id)), None).await {
                    Ok(r) => r,
                    Err(e) => {
                        self.log.line(&format!("room_read failed room={room_id} member={member}: {e}"));
                        continue;
                    }
                };
                let mut msgs: Vec<Value> = res.get("messages").and_then(Value::as_array).cloned().unwrap_or_default();
                msgs.sort_by_key(|m| json_u64(m.get("seq")));
                let mut done = true;
                for msg in msgs {
                    let seq = json_u64(msg.get("seq"));
                    if seq <= cur {
                        continue;
                    }
                    if msg.get("for_me").and_then(Value::as_bool) == Some(true) && !self.handle_room_msg(&room, &member, &msg).await {
                        done = false;
                        break;
                    }
                    cur = seq;
                    self.save_cursor(&ck, cur);
                }
                let tail = json_u64(res.get("last_seq"));
                if done && tail > cur {
                    self.save_cursor(&ck, tail);
                }
            }
        }
    }

    /// 轉交一則群組訊息。true＝處理完（可推進游標）；false＝先留著，下次再來
    async fn handle_room_msg(&mut self, room: &Value, member: &str, msg: &Value) -> bool {
        if !self.roster_ok {
            return false;
        }
        let room_id = room.get("id").and_then(Value::as_str).unwrap_or("").to_string();
        let room_name = room.get("name").and_then(Value::as_str).unwrap_or("").to_string();
        let seq = json_u64(msg.get("seq"));
        let window = rooms::member_window(member);
        let mut note = String::new();
        let target;
        if window.is_empty() {
            // 節點本身的成員沒有對應的視窗：只交給使用者在設定指定的視窗；沒有就留著（游標不前進），不丟給隨便一個 session
            let Some(w) = self.unaddressed_window() else {
                let key = format!("room:{room_id}:{seq}:{member}");
                if self.unrouted.insert(key) {
                    self.log.line(&format!("room={room_id} #{seq} member has no window and no configured window online: kept (cursor not advanced)"));
                }
                return false;
            };
            note = unaddressed_window_note(&w);
            target = w;
        } else {
            if !self.forwardable(&window) {
                self.log.line(&format!("room={room_id} #{seq} window {window} not forwardable: skipped"));
                return true;
            }
            target = window.clone();
        }
        let id = rooms::room_uuid(&room_id, seq, member);
        if self.idx(&id).is_some() {
            return true;
        }
        let mut p = Pending::new(&id, "", "", &target, self.now, false);
        p.room = Some(RoomRef { id: room_id.clone(), seq, window: window.clone() });
        self.pending.push(p);
        self.persist();
        let prev = self.room_context(&room_id, member, seq).await; // 前面最近 5 則當上下文（只讀；失敗就不附）
        let text = format!(
            "{}{}\n{}",
            rooms::room_text(&room_name, msg, self.cfg.attach_cmd.as_deref()),
            if note.is_empty() { String::new() } else { format!("\n{note}") },
            rooms::context_text(&room_id, &prev, self.cfg.room_cmd.as_deref())
        );
        let text = self.with_path_line(text, &target);
        match self.deliver(&id, &target, &text) {
            Ok(_) => {
                self.log.line(&format!("handed room={room_id} #{seq} member={member} to={target}"));
                let names: Vec<String> = attach::normalize(msg.get("attachments")).iter().map(|a| a.name.clone()).collect();
                let from = rooms::display_from(msg.get("from").and_then(Value::as_str).unwrap_or(""));
                self.corr_note(&target, Dir::Received, &format!("群組 {room_name} {from}"), &target, &id, msg.get("body").and_then(Value::as_str).unwrap_or(""), &names);
                true
            }
            Err(e) => {
                self.remove(&id);
                self.log.line(&format!("cannot hand room={room_id} #{seq}: {e} (cursor not advanced)"));
                false
            }
        }
    }

    /// 某則訊息前面最近 n 則（只讀：一定帶 since，不動後端已讀）；失敗回空陣列，不擋轉交
    async fn room_context(&self, room_id: &str, member: &str, seq: u64) -> Vec<Value> {
        let n = rooms::CONTEXT_COUNT as u64;
        let window = rooms::member_window(member);
        let as_agent = if window.is_empty() { String::new() } else { format!("&as_agent={}", crate::relay::encode_component(&window)) };
        let since = seq.saturating_sub(1 + n);
        match self.relay.api(&format!("room_read&room={}{as_agent}&since={since}&limit={n}", crate::relay::encode_component(room_id)), None).await {
            Ok(res) => {
                let mut v: Vec<Value> = res.get("messages").and_then(Value::as_array).cloned().unwrap_or_default().into_iter().filter(|m| json_u64(m.get("seq")) > since && json_u64(m.get("seq")) < seq).collect();
                v.sort_by_key(|m| json_u64(m.get("seq")));
                let skip = v.len().saturating_sub(n as usize);
                v.split_off(skip)
            }
            Err(e) => {
                self.log.line(&format!("room context failed room={room_id} #{seq}: {e}"));
                vec![]
            }
        }
    }

    /// 回覆貼回群組（429 只記 log，不重試）
    async fn post_room(&self, r: &RoomRef, body: &str) -> bool {
        let mut b = json!({ "room": r.id, "body": body });
        if !r.window.is_empty() {
            b["from_agent"] = json!(r.window);
        }
        match self.relay.api("room_post", Some(b)).await {
            Ok(_) => true,
            Err(e) => {
                if e.contains("HTTP 429") {
                    self.log.line(&format!("room_post rate-limited room={} (dropped, no retry)", r.id));
                } else {
                    self.log.line(&format!("room_post failed room={}: {e}", r.id));
                }
                false
            }
        }
    }

    // ---- 遠端開視窗 ----
    /// 新視窗出現後：馬上刷新名單（別台看得到、也才轉交得到），有第一句話就當成 owner 的來信經收發室送進去（id＝launch id）
    pub async fn on_launched(&mut self, ev: Launched, now: u64) {
        self.now = now;
        self.refresh_roster(now).await;
        if let Some(body) = ev.first_message {
            let m = Mail { id: ev.id, from_node: ev.requested_by, from_agent: None, to_agent: Some(ev.name), body, trust: "owner".into(), expects_reply: None, attachments: vec![], ..Default::default() };
            self.handle_mail(m).await;
        }
    }

    // ---- 逾時 ----
    /// 轉交後 nudge_ms 還沒看到回覆、收件視窗已回到閒置：提醒收件視窗一次（同一份 pending 狀態機，旗標 nudged 不重複）。
    /// 視窗忙碌（或狀態不是 idle，例如使用者正在打字）不插話，下一輪再看；回了就不提醒
    async fn nudge_window(&mut self, id: &str) {
        let Some(i) = self.idx(id) else { return };
        let p = self.pending[i].clone();
        if p.replied || self.replied_directly(id) || self.sent_to_sender(&p) {
            self.pending[i].nudged = true;
            return;
        }
        let idle = self.agent_of(&p.target).is_some_and(|a| a.status.as_deref().is_some_and(|s| s.eq_ignore_ascii_case("idle")));
        if !idle {
            return;
        }
        self.pending[i].nudged = true;
        let who = if p.sender_desc.is_empty() { if p.from_agent.is_empty() { "對方".to_string() } else { p.from_agent.clone() } } else { p.sender_desc.clone() };
        let text = format!("（收發室提醒）你還沒回覆 {who} 的信 {id}，若已處理完請用 asn_send 寄回結果");
        self.tell_window(&p.target, &text);
        self.log.line(&format!("nudged window {} for id={id}", p.target));
        self.persist();
    }

    /// 一封「超過等待時間還沒回」的信：不再通知寄件人（寄件人看已讀狀態就知道；小良哥 10/22 裁示）。
    /// 只把信轉成 Notified（保留著等遲到的回覆照常寄回）；已經回過的直接清掉
    async fn settle_timeout(&mut self, id: &str) {
        let Some(i) = self.idx(id) else { return };
        let now = self.now;
        if self.pending[i].replied {
            self.remove(id);
            return;
        }
        let p = self.pending[i].clone();
        if self.replied_directly(id) {
            self.remove(id);
            self.corr_note(&p.target, Dir::Direct, &p.target, &Self::node_agent(&p.from_node, &p.from_agent), id, DIRECT_NOTE, &[]);
            self.log.line(&format!("reply wait over id={id}: {} replied directly (asn send --reply-to)", p.target));
            return;
        }
        if self.sent_to_sender(&p) {
            self.remove(id);
            self.corr_note(&p.target, Dir::Direct, &p.target, &Self::node_agent(&p.from_node, &p.from_agent), id, DIRECT_NOTE, &[]);
            self.log.line(&format!("reply wait over id={id}: {} sent mail to {}/{} after forward", p.target, p.from_node, p.from_agent));
            return;
        }
        self.pending[i].state = State::Notified;
        self.pending[i].notified_at = Some(now);
        self.persist();
        self.evict_notified();
        self.log.line(&format!("reply wait over id={id} -> {}: no notice to sender (read status shows)", p.target));
    }

    fn evict_notified(&mut self) {
        let mut list: Vec<(String, u64)> = self.pending.iter().filter(|p| p.state == State::Notified).map(|p| (p.id.clone(), p.notified_at.unwrap_or(0))).collect();
        list.sort_by_key(|x| x.1);
        let over = list.len().saturating_sub(self.cfg.late_max);
        for (id, _) in list.into_iter().take(over) {
            self.remove(&id);
            self.log.line(&format!("late-reply slot evicted id={id} (over {})", self.cfg.late_max));
        }
    }

    /// 定時檢查（每 tick_ms 一次）：轉交逾時、等回覆逾時、遲到回覆保留期
    pub async fn tick(&mut self, now: u64) {
        self.now = now;
        let ids: Vec<String> = self.pending.iter().map(|p| p.id.clone()).collect();
        for id in ids {
            let Some(i) = self.idx(&id) else { continue };
            let p = self.pending[i].clone();
            if p.state == State::Forwarding && now.saturating_sub(p.t0) > self.cfg.forward_timeout_ms {
                self.pending[i].state = State::Done;
                if p.room.is_some() {
                    self.log.line(&format!("room forward timeout id={id} -> {}", p.target));
                    self.remove(&id);
                    continue;
                }
                // 收發室沒回報，但對方已經回了這封（或已寄信給原寄件人）＝其實有轉到：不寄「轉交逾時」
                if self.replied_directly(&id) || self.sent_to_sender(&p) {
                    self.log.line(&format!("forward unconfirmed but {} already replied id={id}: no timeout notice", p.target));
                    self.ack_ids(&[id.clone()]).await;
                    self.remove(&id);
                    continue;
                }
                if Self::is_mailbox_sender(&p.from_agent) {
                    self.log.line(&format!("forward timeout notice to mailbox sender not sent id={id}"));
                } else {
                    self.send_back(&Origin::of(&p), &format!("[收發室] 轉交給 {} 逾時（收發室沒有完成轉交）", p.target), None, None).await;
                }
                self.ack_ids(&[id.clone()]).await;
                self.remove(&id);
            } else if p.state == State::Waiting && now.saturating_sub(p.t) > self.cfg.reply_timeout_ms {
                if p.room.is_some() {
                    self.remove(&id); // 群組訊息逾時不通知，直接清掉
                } else {
                    self.settle_timeout(&id).await;
                }
            } else if p.state == State::Waiting && !p.nudged && !p.no_reply && p.room.is_none() && now.saturating_sub(p.t) > self.cfg.nudge_ms {
                self.nudge_window(&id).await;
            } else if p.state == State::Notified && now.saturating_sub(p.notified_at.unwrap_or(now)) > self.cfg.late_keep_ms {
                self.remove(&id);
                self.log.line(&format!("late-reply slot expired id={id}"));
            }
        }
        let keep = self.cfg.late_keep_ms;
        self.last_requester.retain(|_, r| now.saturating_sub(r.t) <= keep);
        self.persist();
        self.prune_marks();
    }

    /// 結束前：把對應表存好
    pub fn flush(&mut self) {
        self.persist();
    }
}

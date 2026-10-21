//! 收發室橋的核心狀態機：對應 relay/machine/bridge.mjs（只做 Claude 引擎；含信件、群組轉送、遠端開視窗的接口）。
//! 所有時間都由呼叫端傳入（毫秒），測試可以不用真的等待逾時。核心一次只被一個任務使用（見 mod.rs 的 run 迴圈）。
//! 對後端只透過 [`Relay`]（HTTP），對 worker 只透過 [`WorkerSink`]，所以測試可用本機假後端與假 worker。
use super::attach;
use super::corrlog::{self, CorrLog, Dir, Entry};
use super::launcher::{Launched, Launcher};
use super::mail::{self, fallback_note, mail_head, parse_send_head, strip_reply_head, wants_reply, Mail, SendHead};
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

fn env_u64(k: &str, d: u64) -> u64 {
    std::env::var(k).ok().and_then(|v| v.trim().parse().ok()).unwrap_or(d)
}

/// 橋的設定。環境變數沿用 Node 橋的名稱與預設值（README「設定」）
#[derive(Clone, Debug)]
pub struct Config {
    pub node: String,
    pub mailbox_name: String,
    pub default_agent: String,
    pub extra_allow: Vec<String>,
    pub work_dir: PathBuf,
    pub sessions_dir: PathBuf,
    pub poll_ms: u64,
    pub roster_ms: u64,
    pub tick_ms: u64,
    pub reply_timeout_ms: u64,
    pub notice_window_ms: u64,
    pub late_keep_ms: u64,
    pub late_max: usize,
    pub busy_grace_ms: u64,
    pub busy_max_ms: u64,
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
}

impl Config {
    pub fn from_env(node: &str, work_dir: PathBuf) -> Config {
        let test_handoff = work_dir.join("handoff");
        let home = crate::identity::home_dir();
        let list = |k: &str| std::env::var(k).unwrap_or_default().split(',').map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect::<Vec<_>>();
        Config {
            node: node.into(),
            mailbox_name: std::env::var("IRORI_MAILBOX_NAME").ok().filter(|s| !s.trim().is_empty()).unwrap_or_else(|| format!("{node}-收發室")),
            default_agent: std::env::var("IRORI_RELAY_DEFAULT_AGENT").ok().filter(|s| !s.trim().is_empty()).unwrap_or_else(|| "H-工頭-2".into()),
            extra_allow: list("IRORI_RELAY_ALLOW"),
            work_dir,
            sessions_dir: home.join(".claude").join("sessions"),
            poll_ms: env_u64("IRORI_RELAY_POLL_MS", 120_000),
            roster_ms: env_u64("IRORI_ROSTER_MS", 60_000),
            tick_ms: env_u64("IRORI_BRIDGE_TICK_MS", 5_000),
            reply_timeout_ms: env_u64("IRORI_REPLY_TIMEOUT_MS", 600_000),
            notice_window_ms: env_u64("IRORI_NOREPLY_WINDOW_MS", 1_800_000),
            late_keep_ms: env_u64("IRORI_LATE_KEEP_MS", 86_400_000),
            late_max: env_u64("IRORI_LATE_MAX", 200) as usize,
            busy_grace_ms: env_u64("IRORI_BUSY_GRACE_MS", 120_000),
            busy_max_ms: env_u64("IRORI_BUSY_MAX_MS", 3_600_000),
            forward_timeout_ms: env_u64("IRORI_FORWARD_TIMEOUT_MS", 120_000),
            pull_backoff_ms: vec![5_000, 10_000, 20_000, 40_000, 60_000],
            claude_bin: std::env::var("CLAUDE_BIN").ok().filter(|s| !s.trim().is_empty()).unwrap_or_else(|| "claude".into()),
            claude_pre: vec![],
            model: std::env::var("IRORI_MAILBOX_MODEL").ok().filter(|s| !s.trim().is_empty()).unwrap_or_else(|| "haiku".into()),
            extra_env: vec![],
            report_asn_window: true,
            attach_cmd: attach::attach_cmd_from_env(),
            room_cmd: attach::room_cmd_from_env(),
            // 測試時絕不碰真實家目錄：往來記錄放進工作資料夾底下
            handoff_dir: if cfg!(test) { test_handoff } else { corrlog::default_dir() },
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
const DIRECT_NOTE: &str = "（這個視窗自己用命令列回了信，內文只在對方那邊，收發室看不到）";

pub struct Core {
    pub cfg: Config,
    relay: Arc<Relay>,
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
    noticed: HashMap<String, (u64, u32)>,
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
    corr: CorrLog,
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
            last_requester: BTreeMap::new(), noticed: HashMap::new(), notice_ids: HashMap::new(), notice_windows: HashMap::new(), self_handled: HashSet::new(), unrouted: HashSet::new(),
            last_saved: String::new(), persist_failed: false, pruned_at: 0, fail_step: 0, retry_at: None, cursors, cursor_warned: false, launcher: None, corr,
        };
        c.restore();
        c
    }

    pub fn sink(&self) -> Arc<dyn WorkerSink> {
        self.sink.clone()
    }

    /// 接上遠端開視窗（第三段）。沒接＝名單回報 launcher 送 null、不處理 launch_pending
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
    pub async fn refresh_roster(&mut self, now: u64) {
        self.now = now;
        let alive = self.alive.clone();
        let Some(list) = roster::read_sessions(&self.cfg.sessions_dir, |p| alive(p), self.sink.pid(), &self.cfg.mailbox_name) else { return };
        self.roster = list;
        self.roster_ok = true;
        let asn = self.cfg.report_asn_window.then(|| self.relay.window_name());
        // 摘要要讀設定檔、偵測 CLI（會開外部程序），放到背景執行緒，不卡住收信的主迴圈
        let launcher = match self.launcher.clone() {
            Some(l) => tokio::task::spawn_blocking(move || l.summary()).await.unwrap_or(Value::Null),
            None => Value::Null,
        };
        match self.relay.api("roster", Some(roster::roster_body(&self.roster, asn.as_deref(), launcher))).await {
            Ok(_) => self.roster_warned = false,
            Err(e) => {
                if !self.roster_warned {
                    self.log.line(&format!("roster post failed: {e} (will keep trying quietly)"));
                    self.roster_warned = true;
                }
            }
        }
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
        let v = self.relay.api("inbox", None).await?;
        let msgs: Vec<Value> = v.get("messages").and_then(Value::as_array).cloned().unwrap_or_default();
        let mut dup = vec![];
        for raw in msgs {
            let Some(m) = Mail::from_json(&raw) else { continue };
            if self.seen.contains(&m.id) {
                dup.push(m.id);
                continue;
            }
            if self.idx(&m.id).is_some() {
                continue;
            }
            self.handle_mail(m).await;
        }
        self.ack_ids(&dup).await;
        Ok(())
    }

    /// 預設收件視窗不在線時代收的視窗：最近有活動的互動式 session
    fn fallback_window(&self) -> Option<Window> {
        let mut best: Option<&Window> = None;
        for w in &self.roster {
            if best.map(|b| w.updated_at > b.updated_at).unwrap_or(true) {
                best = Some(w);
            }
        }
        best.cloned()
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

    fn deliver(&mut self, id: &str, to: &str, text: &str) -> Result<(), String> {
        self.parser.register(id, to);
        self.sink.say(forward_text(&self.parser.nonce, id, to, text))
    }

    pub async fn handle_mail(&mut self, m: Mail) {
        if let Some(to) = m.to_agent.clone() {
            // 寄給 ASN 自己視窗的信：留給 ASN 自己的畫面收（不轉交、不 ack）
            if self.relay.active_names().contains(&to) {
                if self.self_handled.insert(m.id.clone()) {
                    self.log.line(&format!("id={} to={to} is ASN's own window: bridge skips", m.id));
                }
                return;
            }
            // 這個視窗自己在收信（recv 心跳 90 秒內且 pid 活著）：橋不轉、不 ack；心跳過期就照舊轉交
            if crate::heartbeat::read_heartbeat(&self.cfg.work_dir, &to).map(|h| crate::heartbeat::alive_fresh(&h, self.now, crate::heartbeat::stale_ms(), |p| (self.alive)(p))).unwrap_or(false) {
                if self.self_handled.insert(m.id.clone()) {
                    self.log.line(&format!("id={} to={to} window receives by itself (recv heartbeat): bridge skips", m.id));
                }
                return;
            }
        }
        let mut target = m.to_agent.clone().unwrap_or_else(|| self.cfg.default_agent.clone());
        let mut note = String::new();
        if m.to_agent.is_none() && !self.online_names().contains(self.cfg.default_agent.as_str()) {
            // 預設收件視窗不在線：改交給最近有活動的互動式 session，都沒有才留在 inbox
            let Some(fb) = self.fallback_window() else {
                if self.unrouted.insert(m.id.clone()) {
                    self.log.line(&format!("id={} has no to_agent and {} is offline and no interactive session online: left in inbox", m.id, self.cfg.default_agent));
                }
                return;
            };
            target = fb.name.clone();
            note = fallback_note(&self.cfg.default_agent, &fb.name);
            self.log.line(&format!("id={} has no to_agent and {} is offline: fallback to most recently active session {}", m.id, self.cfg.default_agent, target));
        }
        let from_agent = m.from_agent.clone().unwrap_or_default();
        let no_reply = !wants_reply(m.expects_reply, &m.body) || Self::is_mailbox_sender(&from_agent);
        let mut p = Pending::new(&m.id, &m.from_node, &from_agent, &target, self.now, no_reply);
        if !self.forwardable(&target) {
            let names = if self.roster.is_empty() { "(無)".to_string() } else { self.roster.iter().map(|w| w.name.as_str()).collect::<Vec<_>>().join("、") };
            p.state = State::Done;
            if Self::is_mailbox_sender(&from_agent) {
                self.log.line(&format!("id={} target {target} not found; notice to mailbox sender not sent", m.id));
            } else {
                self.send_back(&Origin::of(&p), &format!("[收發室] 找不到名叫「{target}」的 session（目前可達：{names}）"), None, None).await;
            }
            self.ack_ids(&[m.id.clone()]).await;
            return;
        }
        self.pending.push(p);
        if !no_reply {
            self.last_requester.insert(target.clone(), LastReq { from_node: m.from_node.clone(), from_agent: from_agent.clone(), mail_id: m.id.clone(), t: self.now });
        }
        self.persist();
        // 照片／檔案：內文後面多一行「〔照片〕檔名＋下載指令」，和內文一起在外部資料區塊內
        let body = attach::notes_for(&m.body, &m.attachments, self.cfg.attach_cmd.as_deref());
        let text = format!("{}\n{}{}", mail_head(&m, "claude"), if note.is_empty() { String::new() } else { format!("{note}\n") }, body);
        let text = format!("{text}\n{}", self.corr.path_line(&target));
        match self.deliver(&m.id, &target, &text) {
            Ok(_) => {
                self.log.line(&format!("handed id={} from={}/{} to={target}", m.id, m.from_node, from_agent));
                let names: Vec<String> = m.attachments.iter().map(|a| a.name.clone()).collect();
                self.corr_note(&target, Dir::Received, &Self::node_agent(&m.from_node, &from_agent), &target, &m.id, &m.body, &names);
            }
            Err(e) => {
                self.remove(&m.id);
                self.log.line(&format!("cannot hand id={}: {e} (left in inbox)", m.id));
            }
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
        let (o, t0, target) = (Origin::of(&self.pending[i]), self.pending[i].t0, self.pending[i].target.clone());
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
        let body = if late { format!("（遲到的回覆：{target} 在收發室寄出「沒有回覆」通知之後才回）\n{text}") } else { text.clone() };
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
            if self.online_names().contains(self.cfg.default_agent.as_str()) {
                target = self.cfg.default_agent.clone();
            } else {
                let Some(fb) = self.fallback_window() else {
                    self.log.line(&format!("room={room_id} #{seq} default agent offline and no session online: kept (cursor not advanced)"));
                    return false;
                };
                note = fallback_note(&self.cfg.default_agent, &fb.name);
                target = fb.name;
            }
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
        let text = format!("{text}\n{}", self.corr.path_line(&target));
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
            let m = Mail { id: ev.id, from_node: ev.requested_by, from_agent: None, to_agent: Some(ev.name), body, trust: "owner".into(), expects_reply: None, attachments: vec![] };
            self.handle_mail(m).await;
        }
    }

    // ---- 逾時 ----
    async fn notice_no_reply(&mut self, o: &Origin, target: &str, p_t: u64, reason: &str) {
        let now = self.now;
        let key = format!("{}/{}|{target}", o.from_node, o.from_agent);
        if let Some(prev) = self.noticed.get_mut(&key) {
            if now.saturating_sub(prev.0) < self.cfg.notice_window_ms {
                prev.1 += 1;
                self.log.line(&format!("no-reply notice suppressed id={} ({key})", o.id));
                return;
            }
        }
        let skipped = self.noticed.get(&key).map(|x| x.1).unwrap_or(0);
        let more = if skipped > 0 { format!("；另有 {skipped} 封也還沒回") } else { String::new() };
        self.noticed.insert(key.clone(), (now, 0));
        let mins = ((now.saturating_sub(p_t)) as f64 / 60000.0).round().max(1.0) as u64;
        let tip = mail::NO_REPLY_TIP;
        let text = match reason {
            "window-closed" => format!("[收發室] 對方視窗「{target}」已關閉，沒有經收發室收到回覆{more}"),
            "timeout" => format!("[收發室] {} 分鐘內沒有經收發室收到 {target} 的回覆（對方若已另外回信可忽略）{more}。{tip}", (self.cfg.reply_timeout_ms as f64 / 60000.0).round() as u64),
            _ => format!("[收發室] {target} 先前一直在忙，等了約 {mins} 分鐘仍沒有經收發室收到回覆（對方若已另外回信可忽略）{more}。{tip}"),
        };
        let ok = self.send_back(o, &text, None, None).await;
        self.log.line(&format!("no-reply notice sent id={} ({key}) reason={reason} sent={ok}", o.id));
    }

    /// 一封「超過等待時間還沒回」的信：決定現在寄通知、延後、還是不用寄
    async fn judge_timeout(&mut self, id: &str) {
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
            self.log.line(&format!("no-reply notice skipped id={id}: {} replied directly (asn send --reply-to)", p.target));
            return;
        }
        if self.sent_to_sender(&p) {
            self.remove(id);
            self.corr_note(&p.target, Dir::Direct, &p.target, &Self::node_agent(&p.from_node, &p.from_agent), id, DIRECT_NOTE, &[]);
            self.log.line(&format!("no-reply notice skipped id={id}: {} sent mail to {}/{} after forward", p.target, p.from_node, p.from_agent));
            return;
        }
        let a = self.agent_of(&p.target).cloned();
        let mut reason = "timeout";
        if a.is_none() && self.roster_ok {
            reason = "window-closed";
        } else if let Some(a) = a.filter(|a| a.is_busy()) {
            if now.saturating_sub(p.t) < self.cfg.busy_max_ms {
                if !p.deferred {
                    self.pending[i].deferred = true;
                    self.log.line(&format!("no-reply notice deferred id={id}: {} is busy (status={})", p.target, a.status.clone().unwrap_or_default()));
                }
                self.pending[i].idle_since = 0;
                return;
            }
            reason = "busy-max";
        } else if p.deferred {
            if p.idle_since == 0 {
                self.pending[i].idle_since = now;
                return;
            }
            if now.saturating_sub(p.idle_since) < self.cfg.busy_grace_ms {
                return;
            }
            reason = "busy-idle-grace";
        }
        // 決定要通知：信留著等遲到的回覆（先改狀態，免得 await 期間下一輪又處理同一封）
        self.pending[i].state = State::Notified;
        self.pending[i].notified_at = Some(now);
        self.persist();
        self.evict_notified();
        self.notice_no_reply(&Origin::of(&p), &p.target, p.t, reason).await;
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
                    self.judge_timeout(&id).await;
                }
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

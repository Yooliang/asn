//! 收發室橋的核心狀態機：對應 relay/machine/bridge.mjs（只做 Claude 引擎；含信件、群組轉送、遠端開視窗的接口）。
//! 所有時間都由呼叫端傳入（毫秒），測試可以不用真的等待逾時。核心一次只被一個任務使用（見 mod.rs 的 run 迴圈）。
//! 對後端只透過 [`Relay`]（HTTP），對 worker 只透過 [`WorkerSink`]，所以測試可用本機假後端與假 worker。
use super::attach;
use super::corrlog::{self, CorrLog, Dir, Entry};
use super::channel_turns;
use super::engines::{EngineEvent, EngineSet};
use super::forward_selftest;
use super::launcher::{Launched, Launcher};
use super::partner_ops::{CommandJob, PartnerOps};
use super::slash;
use super::mail::{self, unaddressed_receipt, unaddressed_window_note, mail_head, parse_send_head, strip_reply_head, wants_reply, Mail, SendHead};
use super::pending::{self, LastReq, Pending, RoomRef, State};
use super::rooms::{self, Cursors, Held, HeldStore};
use super::roster::{self, Window};
use super::worker::{forward_text, forward_text_exact, Parser, WorkerEvent, WorkerLine, WorkerSink};
use crate::relay::Relay;
use serde_json::{json, Value};
use sha1::{Digest, Sha1};
use std::collections::{BTreeMap, HashMap, HashSet, VecDeque};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

mod dup;
mod ack_retry;
mod fail_notice;
mod held_notice;
mod misroute;
mod quota;
mod selftest;
mod wait_notice;

/// 後台節點信箱一次最多回幾封（與 asn_relay_inbox 的 limit 一致）
const INBOX_PAGE: usize = 50;
/// 一輪收信最多往後多拿幾批
const INBOX_ROUNDS: usize = 5;
/// 重開後等夥伴接回來最多等多久（毫秒）：半夜重開、沒人登入時要等到天亮，所以定 12 小時（信送出時會註明原本收到的時間）
const AWAIT_GRACE_MS: u64 = 12 * 3_600_000;
/// 等接回來的夥伴，最多先留這麼多封信（超過的照原本的做法退回，並講明是留滿了）
const AWAIT_MAIL_MAX: usize = 20;
/// 所有等接回的夥伴加起來，最多先留這麼多封
const AWAIT_TOTAL_MAX: usize = 40;
/// 視窗從名單消失後，收發室要繼續跑過這麼久才當成本人關掉、從存檔拿掉。
/// 關機時視窗比收發室早結束，收發室活不到這麼久，名字就留在存檔裡，重開後信才會留著
const FORGET_AFTER_MS: u64 = 5 * 60_000;
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
    /// 收發室 worker 一輪只交一封（todo-next-185）。正式預設開（環境變數 ASN_FORWARD_ONE_PER_TURN=0 可關閉）；測試預設關，只有專門測這件事的測試才開（其他測試一次放好幾封信，不是在測這個）
    pub one_per_turn: bool,
    /// 夥伴卡在框上超過兩分鐘通知本人（ASN_WAIT_ALERT=1，預設關；todo-next-162）
    pub wait_alert: bool,
    /// 轉交內容和原信逐字相同（ASN_FORWARD_EXACT=1，預設關）：開了還要通過啟動自我測試才生效
    pub forward_exact: bool,
    /// 還沒有自我測試時，開發機用這個強制生效（ASN_FORWARD_EXACT_UNVERIFIED=1）
    pub forward_exact_unverified: bool,
    /// worker 有裝轉交核對的 hook（找不到 asn-cli 時沒有）：原文替換靠 hook，沒裝就不能走
    pub forward_hook: bool,
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
    /// 群組順位延遲的間隔（毫秒，預設 60000；ASN_ROOM_STAGGER_MS，0＝關閉）：第 N 順位的信等 (N-1) × 間隔再轉交
    pub room_stagger_ms: u64,
    /// 依視窗名的往來記錄資料夾（預設 `~/.asn/handoff`；測試一律指到暫存資料夾）
    pub handoff_dir: PathBuf,
    /// 其他引擎（第五段）：ASN_ENGINES（舊名 IRORI_ENGINES）的值（逗號分隔的 acp／codex）；None＝自動（有 agents.json 載 acp、有 ~/.codex 載 codex）
    pub engines: Option<String>,
    /// engines 是舊名清單補上 pi 的（#467，啟動時記一行 log）
    pub engines_pi_added: bool,
    /// 引擎子程序環境的來源（啟動時的環境變數快照）
    pub engine_env: Vec<(String, String)>,
    /// ACP 工作者設定檔（預設 `~/.asn/agents.json`，與舊橋同一份；ASN_AGENTS_FILE 可改，舊名 IRORI_AGENTS_FILE 仍可用）
    pub agents_file: PathBuf,
    /// 寄信額度計數檔（send-rate.json）所在資料夾：本人簽章的私信轉交給視窗時退回一封額度
    pub rate_home: PathBuf,
    /// 使用者家目錄（找 ~/.codex；測試指到暫存資料夾）
    pub home: PathBuf,
    /// 引擎名單重列的間隔
    pub engine_refresh_ms: u64,
    /// 「只有引擎」模式（無視窗橋）：不啟動 `claude -p` 收發室 worker；沒指定收件人的信交給預設成員（default_agent／bridge.json 的 unaddressed_to）
    pub engine_only: bool,
    /// 自動回信模式（Linux 無視窗主機）：收發室 worker 自己當一個對外可收信的視窗，值＝這個視窗的名字。
    /// 寄給它的信、沒指定收件人的信、群組裡被叫醒的訊息都交給 worker 回答並寄回；名單上以 claude 引擎、idle／busy 狀態回報
    pub respond: Option<String>,
}

/// Claude 記工作階段的資料夾：橋與重開自動接回（launch::auto_resume）共用這一個來源，兩邊永遠看同一個地方
pub fn claude_sessions_dir() -> PathBuf {
    crate::identity::home_dir().join(".claude").join("sessions")
}

impl Config {
    pub fn from_env(node: &str, work_dir: PathBuf) -> Config {
        let test_handoff = work_dir.join("handoff");
        let forward_hook = super::worker::gate_command(&work_dir).is_some();
        // 測試時絕不碰真實的設定：只載 Claude
        let engines = if cfg!(test) {
            super::engines::EngineSpec { spec: Some("claude".into()), pi_added: false }
        } else {
            let (new, old) = crate::envc::get_pair("ASN_ENGINES");
            super::engines::engine_spec(new.as_deref(), old.as_deref())
        };
        let (work_dir_agents, work_dir_home, work_dir_rate) = (work_dir.join("agents.json"), work_dir.join("home"), work_dir.join("rate"));
        let home = crate::identity::home_dir();
        let list = |k: &str| crate::envc::get(k).unwrap_or_default().split(',').map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect::<Vec<_>>();
        Config {
            node: node.into(),
            mailbox_name: crate::envc::get("ASN_MAILBOX_NAME").filter(|s| !s.trim().is_empty()).unwrap_or_else(|| format!("{node}-收發室")),
            default_agent: crate::envc::get("ASN_RELAY_DEFAULT_AGENT").filter(|s| !s.trim().is_empty()).unwrap_or_default(),
            data_dir: None,
            extra_allow: list("ASN_RELAY_ALLOW"),
            work_dir,
            sessions_dir: claude_sessions_dir(),
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
            one_per_turn: crate::envc::get("ASN_FORWARD_ONE_PER_TURN").map(|v| v.trim() != "0").unwrap_or(true),
            // 新變數沒有舊環境名稱，不走 envc 的新舊名對照
            wait_alert: std::env::var("ASN_WAIT_ALERT").is_ok_and(|v| v.trim() == "1"),
            forward_exact: super::worker::forward_exact_enabled(),
            forward_exact_unverified: std::env::var("ASN_FORWARD_EXACT_UNVERIFIED").is_ok_and(|v| v.trim() == "1"),
            forward_hook,
            pull_backoff_ms: vec![5_000, 10_000, 20_000, 40_000, 60_000],
            claude_bin: std::env::var("CLAUDE_BIN").ok().filter(|s| !s.trim().is_empty()).unwrap_or_else(|| "claude".into()),
            claude_pre: vec![],
            model: crate::envc::get("ASN_MAILBOX_MODEL").filter(|s| !s.trim().is_empty()).unwrap_or_else(|| "haiku".into()),
            extra_env: vec![],
            report_asn_window: true,
            attach_cmd: attach::attach_cmd_from_env(),
            room_cmd: attach::room_cmd_from_env(),
            room_stagger_ms: env_u64("ASN_ROOM_STAGGER_MS", rooms::STAGGER_DEFAULT_MS),
            // 測試時絕不碰真實家目錄：往來記錄放進工作資料夾底下
            handoff_dir: if cfg!(test) { test_handoff } else { corrlog::default_dir() },
            // 測試時絕不碰真實的設定與 ~/.codex：只載 Claude，路徑都放進工作資料夾底下
            engines: engines.spec,
            engines_pi_added: engines.pi_added,
            engine_env: std::env::vars().collect(),
            agents_file: if cfg!(test) { work_dir_agents } else { crate::envc::get_os("ASN_AGENTS_FILE").filter(|s| !s.is_empty()).map(PathBuf::from).unwrap_or_else(|| crate::identity::relay_home().join("agents.json")) },
            rate_home: if cfg!(test) { work_dir_rate } else { crate::identity::relay_home() },
            home: if cfg!(test) { work_dir_home } else { home },
            engine_refresh_ms: env_u64("ASN_ROSTER_MS", 60_000),
            engine_only: false,
            respond: None,
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

/// 額度用完時最多扣住幾封個人信；超過的信不收（不 ack，留在伺服器下次再拉）。
/// 比信箱一頁（INBOX_PAGE）少 10 封：扣住的信不 ack 會一直排在信箱最前面，不留空位整頁會被它們占滿
const QUOTA_MAIL_MAX: usize = INBOX_PAGE - 10;
/// 額度用完時最多扣住幾則群組訊息（群組在伺服器端、靠游標讀，不占信箱）
const QUOTA_ROOM_MAX: usize = 200;
/// 額度重置時間加的緩衝（毫秒）
const QUOTA_MARGIN_MS: u64 = 60_000;
/// 讀不到重置時間（或值不可信）時，多久後再試；扣住期間的試送也是每隔這麼久一次（毫秒）
const QUOTA_RETRY_MS: u64 = 3_600_000;
/// 收發室登入失效時第一次試送提早到這麼久之後（之後才每小時一次）：能很快發現已經好了，也讓登入失效偵測看得到第二筆
const AUTH_FIRST_PROBE_MS: u64 = 300_000;
/// 重開前已開始處理的通道信，重送時附在內文前（「（收發室）」開頭：內文行首的同樣字樣會被跳脫）
const CHANNEL_RESEND_NOTE: &str = "（收發室）這封因收發室重開重送，上一輪可能做到一半，先確認現況再動手。";
/// 重送一次還是沒做完
const CHANNEL_GIVE_UP: &str = "收發室重開時這封信沒有處理完，已重送一次仍沒做完。上一輪可能做到一半，請確認現況後再寄";

/// 額度用完而扣住的個人信（內文只在記憶體；重啟後靠重新拉到的同一封補回）
struct HeldItem {
    mail: Mail,
    raw: Option<Value>,
    /// 原本收到的時間（毫秒）；重送的延遲抬頭用
    received_at: u64,
}

/// 轉交給 worker 還沒確認的群組訊息（額度用完時改排進 HeldStore，重置後重讀）
struct RoomFwd {
    room_id: String,
    room_name: String,
    member: String,
    seq: u64,
    received_at: u64,
}

/// release_held_item 的結果（額度試送用）：交給 worker 了／沒交成（要算一次沒回應）／這則本身不需要（已處理過、讀不到、超過保留期、名單還沒來）
enum RelOutcome {
    Delivered,
    Failed,
    Gone,
}

/// 一次額度用完期間已經通知過哪些寄件人（同一次只通知一次；worker 證明恢復後清掉）
#[derive(Default)]
struct QuotaEpisode {
    /// 扣住的原因是收發室登入失效（不是額度用完）：通知寄件人的字不同
    auth: bool,
    /// 扣住的信超過上限（名單回報帶給後台，由後台通知主人）
    capped: bool,
    senders: HashSet<String>,
}

const NOTICE_TTL_MS: u64 = 600_000;
/// 本人傳的 /指令，但目標視窗沒有 ASN 外掛：照普通信投遞，另外回這句
/// 交給本人的信：寬限期內本人收下（ack）就不寄說明（本人會直接回答）；過了還沒人看才說明
const OWNER_RECEIPT_GRACE_MS: u64 = 180_000;
/// 同一寄件人對同一節點在這段時間內只說明一次
const OWNER_RECEIPT_GAP_MS: u64 = 600_000;
const NO_MOD_NOTICE: &str = "這個視窗沒有 ASN 外掛，/指令 只能當文字送過去";
const DIRECT_NOTE: &str = "（這個視窗自己用命令列回了信，內文只在對方那邊，中間經過的伺服器看不到）";

pub struct Core {
    pub cfg: Config,
    pub(super) relay: Arc<Relay>,
    sink: Arc<dyn WorkerSink>,
    pub parser: Parser,
    pub log: Arc<BridgeLog>,
    alive: Arc<dyn Fn(u32) -> bool + Send + Sync>,
    /// pid → 程序建立時間（毫秒）；拿來分辨 session 檔的 pid 是不是被別的程序重用（測試可換）
    created: Arc<dyn Fn(u32) -> Option<u64> + Send + Sync>,
    now: u64,
    pub roster: Vec<Window>,
    pub roster_ok: bool,
    roster_warned: bool,
    seen: HashSet<String>,
    /// ack 失敗、等著補的信（見 core/ack_retry.rs）；下次補的時間、目前的間隔
    ack_retry: Vec<String>,
    ack_retry_at: u64,
    ack_retry_gap: u64,
    pub pending: Vec<Pending>,
    pub last_requester: BTreeMap<String, LastReq>,
    notice_ids: HashMap<String, u64>,
    notice_windows: HashMap<String, u64>,
    self_handled: HashSet<String>,
    /// 「寄回成功才 ack」的引擎（Aegis）：還在等回覆的信編號
    ack_wait: HashSet<String>,
    /// 內建通道的信（ack_wait 的子集）：寄回失敗也 ack，不然每次拉信都重跑一輪（#828）
    channel_wait: HashSet<String>,
    /// 重開前交給內建通道、還沒結束的信：重新拉到時決定重送或放棄（#828）
    channel_back: HashSet<String>,
    /// 其中已經有一封回覆寄失敗的（不再寄後面的、也不 ack）
    reply_fail: HashSet<String>,
    unrouted: HashSet<String>,
    /// 交給本人、等寬限期過了仍沒被收下才說明的信：(到期時間, 來源)
    owner_receipts: Vec<(u64, Origin)>,
    /// 寄件人 → 上次說明「交給本人」的時間（節流用）
    owner_receipt_at: HashMap<String, u64>,
    last_saved: String,
    persist_failed: bool,
    pruned_at: u64,
    fail_step: usize,
    pub retry_at: Option<u64>,
    cursors: Cursors,
    held: HeldStore,
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
    /// 名單頂層 used_legacy_env 從哪裡來（正式＝envc 的全域記錄；測試預設給空的，
    /// 不讓別的測試讀環境時記下的舊名影響名單內容；要驗內容用 set_legacy_env_source 換）
    legacy_src: Arc<dyn Fn() -> Vec<String> + Send + Sync>,
    /// 上次回報名單時本機 Claude 視窗的指紋與時間（即時監看用）
    roster_fp: Option<String>,
    roster_at: u64,
    /// 自動回信模式：已交給 worker、這一輪還沒看到它回報結果（名單 busy 的依據之一）
    respond_open: bool,
    /// 收發室 worker 一輪只交一封（todo-next-185）：已把一封交給 worker、它這一輪還沒結束（記下交出去的時間）。
    /// 這段時間再來的信與群組訊息先留著不處理（信留在信箱、群組游標不前進），這一輪結束才收下一封；處理中再送進去的信可能轉交失敗
    fwd_turn_open: Option<u64>,
    /// 有信或群組訊息因為上面這個先留著；這一輪結束時要馬上再拉一次
    fwd_gated: bool,
    /// 自動回信模式：上次回報名單時自己視窗的狀態（變了就立刻重報）
    respond_sent: String,
    /// 0.2 E2／E4（#397）：各視窗最後一次收到信或被看到在忙的時間（毫秒），名單回報時帶給後台；只存記憶體
    active: BTreeMap<String, u64>,
    /// 收件名同時有兩個以上視窗而留在信箱的信：信件編號 → 第一次說明的時間（#584；只存記憶體）
    dup_held: HashMap<String, u64>,
    /// 收發室 worker 的 Claude 額度用完，到這個時間（毫秒）前不送信給 worker；0＝沒有
    quota_until: u64,
    /// 扣住的原因是收發室登入失效（最近一次扣住的原因；全部送完才清）：群組訊息重送的延遲說明用
    hold_auth: bool,
    /// 因登入失效而扣住的個人信編號：重送時延遲說明寫登入失效；信處理完（ack）就清
    held_auth: HashSet<String>,
    /// 這一段扣住從什麼時候算起（毫秒）；偵測到重新登入（登入檔比它新）就提早試送，試送後重新起算
    hold_since: u64,
    /// 偵測重新登入：給「扣住開始時間」，回登入檔是否比它新；測試預設沒有（絕不讀真實家目錄）
    pub relogin_since: Option<Arc<dyn Fn(u64) -> bool + Send + Sync>>,
    quota_ep: Option<QuotaEpisode>,
    /// 扣住的個人信（信件編號 → 內文）
    held_items: HashMap<String, HeldItem>,
    /// 已交給 worker、還沒確認的個人信與群組訊息：額度用完時轉成扣住
    fwd_items: HashMap<String, HeldItem>,
    fwd_rooms: HashMap<String, RoomFwd>,
    /// 重送中：這則原本收到的時間（轉交文字要加延遲抬頭）
    late_from: Option<u64>,
    /// 核對轉交對象：送給 worker 還在進行中的訊息（編號 → (目標, 帶編號的全文)），送錯時用同一份重送一次
    fwd_text: HashMap<String, (String, String)>,
    /// 已經因為送錯重送過一次的編號（第二次還是錯就回 Fail）
    misrouted_once: HashSet<String>,
    /// 這封信本身就是收發室通知（編號）：被退時不再發通知
    bounce_notices: HashSet<String>,
    /// 群組訊息轉交失敗的通知冷卻（群組, 收件視窗）→（上次貼的時間, 冷卻中略過幾則）
    room_fail_notices: HashMap<(String, String), (u64, u32)>,
    /// 這個 worker 啟動以來回報失敗幾次
    pub(super) worker_fails: u32,
    /// 已經通知過送錯的編號（每個編號只通知一次）
    misroute_notified: HashSet<String>,
    /// 轉交給 worker 的來信是誰寄的（編號 → 來源）：送錯通知寄件人用；只存記憶體，數量有上限
    fwd_origin: HashMap<String, Origin>,
    /// 最近轉交成功、還沒通知過的信：對方視窗扣住信的通知只有收件人名
    recent_forwards: Vec<held_notice::Forwarded>,
    /// 通知過「可能卡住」、還沒有結果的信：之後按拒絕或放行時對回去
    held_open: Vec<held_notice::Forwarded>,
    /// 上次成功回報給後台的 inbox_hold_until（None＝還沒報過；啟動後第一次名單一定報一次，順便清掉上次沒收乾淨的舊值）
    hold_sent: Option<Option<u64>>,
    /// 上次為了回報收信暫停而重報名單的時間（失敗時不要每個 tick 都重試）
    hold_try_at: u64,
    /// 超過上限的旗標已經報給後台（每次額度用完只報一次）
    cap_sent: bool,
    /// 扣住期間下一次試送的時間（毫秒；只存記憶體）
    next_probe_at: u64,
    /// 試送中的那一封（信件編號或群組訊息編號）；試送時放行額度閘門
    probe_id: Option<String>,
    /// 連續幾次試送沒等到 worker 的任何回報（收到真的 Quota 事件就歸零）
    probe_misses: u32,
    /// 這次試送是在暫停時間已過之後才送的
    probe_after_reset: bool,
    /// 試送前的暫停時間（試送沒回應時要還原，沒回應不是額度用完的證據，不能延長）
    probe_prev_until: u64,
    /// 扣住過的信第一次收到的時間（信件編號 → 毫秒；ack 才清）：信被重新拉回、再扣住或之後才轉交時，延遲抬頭仍寫第一次收到的時間
    held_first: HashMap<String, u64>,
    /// 夥伴卡在框上：什麼時候該通知本人
    wait_alerts: super::wait_alert::WaitAlerts,
    /// 通知失敗後，這個時間之前不再試
    wait_retry_at: u64,
    /// session 檔缺欄位的紀錄已經寫過（每次啟動一次）
    wait_fields_warned: bool,
    /// 認得的夥伴（#766）：存檔的視窗名單；重開後還沒接回來的夥伴，寄給它的信先留著、群組點名游標不前進
    known: super::known::Known,
    /// #767：查一個視窗程序是不是 ASN 開的、原本的權限（測試沒有這個）。查過的編號不重查
    pub window_probe: Option<Arc<dyn Fn(u32) -> (bool, Vec<String>) + Send + Sync>>,
    probed: HashMap<String, (u32, bool, Vec<String>)>,
    /// 這一次收發室跑著的期間看過的視窗名
    seen_run: HashSet<String>,
    /// 從名單消失的視窗：名字 → 第一次發現不見的時間；消失超過 FORGET_AFTER_MS 才從 known 拿掉（見該常數）
    missing: HashMap<String, u64>,
    /// 收發室這次起來的時間（毫秒）：等夥伴接回來的寬限期從這裡算
    started_at: u64,
    /// 正在等接回的夥伴：名字 → 先留著的信編號（每個夥伴最多 AWAIT_MAIL_MAX 封）
    awaiting: HashMap<String, HashSet<String>>,
    /// 已經告訴過寄件人「先留著」的（寄件人／夥伴）：同一次重開每組只說一次
    awaiting_told: HashSet<String>,
    /// 先留著的信：編號 → 第一次被先留著的時間（毫秒），送出時在抬頭註明「原本幾點收到」
    await_first: HashMap<String, u64>,
    /// 走原文替換的編號 → 全文雜湊（收到 Sent 時核對已套用紀錄）
    exact_ids: HashMap<String, String>,
    /// 啟動自我測試通過了（見 core/selftest.rs；沒開旗標、沒通過、測不了都是 false）
    exact_verified: bool,
    /// 自我測試：背景執行緒交回的結果（取走就清空）、有沒有正在跑、下次最早什麼時候再跑、做法（測試時換成假的）
    selftest_slot: Arc<std::sync::Mutex<Option<(Option<String>, forward_selftest::Outcome)>>>,
    selftest_busy: bool,
    selftest_next_at: u64,
    selftest_src: selftest::SelftestFn,
    /// 已經因為「內文沒套用」重送過一次的編號
    not_applied_once: HashSet<String>,
    probing: bool,
}

/// 自動回信模式：交辦後這段時間內，就算 worker 這一輪的結果已回來，仍視為忙碌（它可能正接著處理排隊中的下一則）
const RESPOND_BUSY_GRACE_MS: u64 = 120_000;

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

/// 正式讀 envc 的全域記錄；測試預設空的（全域記錄會被同一個測試程序裡別的測試寫到）
fn default_legacy_src() -> Arc<dyn Fn() -> Vec<String> + Send + Sync> {
    if cfg!(test) {
        Arc::new(Vec::new)
    } else {
        Arc::new(crate::envc::used_legacy)
    }
}

impl Core {
    pub fn new(cfg: Config, relay: Arc<Relay>, sink: Arc<dyn WorkerSink>, nonce: &str, log: Arc<BridgeLog>, alive: Arc<dyn Fn(u32) -> bool + Send + Sync>, now: u64) -> Core {
        let cursors = Cursors::load(&cfg.work_dir);
        let held = HeldStore::load(&cfg.work_dir);
        let corr = CorrLog::new(cfg.handoff_dir.clone());
        let mut c = Core {
            cfg, relay, sink, parser: Parser::new(nonce), log, alive, created: Arc::new(crate::heartbeat::process_started_ms), now, roster: vec![], roster_ok: false, roster_warned: false, seen: HashSet::new(), pending: vec![],
            last_requester: BTreeMap::new(), notice_ids: HashMap::new(), notice_windows: HashMap::new(), self_handled: HashSet::new(), ack_wait: HashSet::new(), channel_wait: HashSet::new(), channel_back: HashSet::new(), reply_fail: HashSet::new(), unrouted: HashSet::new(), owner_receipts: vec![], owner_receipt_at: HashMap::new(),
            last_saved: String::new(), persist_failed: false, pruned_at: 0, fail_step: 0, retry_at: None, cursors, held, cursor_warned: false, launcher: None, partner_ops: None, mod_src: Arc::new(crate::claude_mod::current_report), mod_sent: None, legacy_src: default_legacy_src(), roster_fp: None, roster_at: 0, engines: None, claude_roster: vec![], corr,
            partners: BTreeMap::new(), partner_off: false, partner_warned: false, respond_open: false, fwd_turn_open: None, fwd_gated: false, respond_sent: String::new(), active: BTreeMap::new(), dup_held: HashMap::new(),
            wait_alerts: Default::default(), wait_retry_at: 0, wait_fields_warned: false, quota_until: 0, hold_auth: false, held_auth: HashSet::new(), hold_since: 0, relogin_since: Self::default_relogin_check(), quota_ep: None, held_items: HashMap::new(), fwd_items: HashMap::new(), fwd_rooms: HashMap::new(), bounce_notices: HashSet::new(), room_fail_notices: HashMap::new(), worker_fails: 0, late_from: None, fwd_text: HashMap::new(), misrouted_once: HashSet::new(), misroute_notified: HashSet::new(), ack_retry: Vec::new(), ack_retry_at: 0, ack_retry_gap: 0, recent_forwards: Vec::new(), held_open: Vec::new(), fwd_origin: HashMap::new(), hold_sent: None, hold_try_at: 0, cap_sent: false, next_probe_at: 0, probe_id: None, probe_misses: 0, probe_after_reset: false, probe_prev_until: 0, held_first: HashMap::new(), known: super::known::Known::default(), window_probe: Self::default_window_probe(), probed: HashMap::new(), seen_run: HashSet::new(), missing: HashMap::new(), started_at: 0, awaiting: HashMap::new(), awaiting_told: HashSet::new(), await_first: HashMap::new(), exact_ids: HashMap::new(), exact_verified: false, selftest_slot: Arc::new(std::sync::Mutex::new(None)), selftest_busy: false, selftest_next_at: 0, selftest_src: Arc::new(selftest::real_selftest), not_applied_once: HashSet::new(), probing: false,
        };
        c.restore();
        c.started_at = now;
        c.known = super::known::Known::load(&c.cfg.work_dir.join(super::known::KNOWN_FILE), now);
        super::forward_gate::prune_files(&c.cfg.work_dir, None);   // 上次留下的內文檔與已套用紀錄不再有用
        if c.cfg.forward_exact && c.cfg.forward_exact_unverified {
            c.log.line("forward-exact forced on: 未驗證（沒有通過自我測試，只給開發機用）");
        }
        #[cfg(all(feature = "gui", not(test)))]
        c.known.set_boot(crate::launch::boot_ms(now));
        c
    }

    /// 測試用：待補 ack 的清單
    #[cfg(test)]
    pub fn test_ack_retry(&self) -> &[String] {
        &self.ack_retry
    }

    /// 測試用：模擬待補 ack 的清單不見了
    #[cfg(test)]
    pub fn test_forget_ack_retry(&mut self) {
        self.ack_retry.clear();
        self.ack_retry_at = 0;
    }

    /// 測試用：記下 ack 失敗
    #[cfg(test)]
    pub fn test_note_ack_failed(&mut self, ids: &[String]) {
        self.note_ack_failed(ids);
    }

    /// 測試用：換掉自我測試的做法
    #[cfg(test)]
    pub fn test_set_selftest(&mut self, f: impl Fn(&str, &std::path::Path) -> (Option<String>, forward_selftest::Outcome) + Send + Sync + 'static) {
        self.selftest_src = Arc::new(f);
    }

    /// 測試用：原文替換現在生效嗎
    #[cfg(test)]
    pub fn test_exact_active(&self) -> bool {
        self.exact_active()
    }

    /// 測試用：自我測試的背景工作做完了沒
    #[cfg(test)]
    pub fn test_selftest_busy(&self) -> bool {
        self.selftest_busy
    }

    /// 測試用：原文替換的編號是不是空的
    #[cfg(test)]
    pub fn exact_ids_empty(&self) -> bool {
        self.exact_ids.is_empty()
    }

    #[cfg(test)]
    pub fn test_register_forward(&mut self, id: &str, to: &str, text: &str) -> String {
        self.register_forward(id, to, text)
    }

    /// 測試用：送給 worker、還在進行中的訊息（目標, 帶編號的全文）
    #[cfg(test)]
    pub fn fwd_probe(&self, id: &str) -> Option<(String, String)> {
        self.fwd_text.get(id).cloned()
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
            EngineEvent::Replied(id) => {
                channel_turns::clear(&self.cfg.work_dir, &id);
                let channel = self.channel_wait.remove(&id);
                let failed = self.reply_fail.remove(&id);
                if channel {
                    // 這一輪做完了：寄回失敗就照舊只記 log，不留在信箱（留著每次拉信都會再跑一輪）
                    self.remove(&id);
                    self.ack_wait.remove(&id);
                    self.ack_ids(&[id]).await;
                } else if self.ack_wait.remove(&id) && !failed {
                    self.ack_ids(&[id]).await;
                }
            }
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

    /// 換掉名單頂層 used_legacy_env 的來源（測試用；正式一律是 envc 的全域記錄）
    #[cfg(test)]
    pub fn set_legacy_env_source(&mut self, f: Arc<dyn Fn() -> Vec<String> + Send + Sync>) {
        self.legacy_src = f;
    }

    pub fn set_created(&mut self, f: Arc<dyn Fn(u32) -> Option<u64> + Send + Sync>) {
        self.created = f;
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
        // 重開前交給內建通道、還沒結束的信：工作者的佇列已經沒了。放掉紀錄，信還在信箱，重新拉到時處理（#828）
        let (back, keep): (Vec<Pending>, Vec<Pending>) = st.pending.into_iter().partition(|p| p.channel && p.room.is_none() && p.state != State::Done);
        if !back.is_empty() {
            self.log.line(&format!("channel mail unfinished before restart: {} (will be pulled again)", back.len()));
        }
        self.channel_back = back.into_iter().map(|p| p.id).collect();
        channel_turns::prune(&self.cfg.work_dir);
        self.pending = keep;
        self.last_requester = st.last;
        self.restore_ack_retry(st.ack_retry);
        // 存下來的額度重置時間再驗一次範圍：已過去或超過 8 天就當作沒有
        if st.quota_until > self.now && st.quota_until <= self.now + 8 * 86_400_000 {
            self.quota_until = st.quota_until;
            self.quota_ep = Some(QuotaEpisode { auth: st.quota_auth, ..Default::default() });
            if st.quota_auth {
                self.hold_auth = true;
                self.hold_since = self.now;
                self.held_auth = st.held_auth.iter().cloned().collect();
            }
            let first = if st.quota_auth { AUTH_FIRST_PROBE_MS } else { QUOTA_RETRY_MS };
            self.next_probe_at = (self.now + first).min(st.quota_until);
            self.log.line(&format!("quota hold restored: until {}", super::mail::taipei_hm(st.quota_until)));
        }
    }
    fn persist(&mut self) {
        let mut snap = pending::snapshot(&self.pending, &self.last_requester);
        if self.quota_until > 0 {
            snap["quotaUntil"] = json!(self.quota_until); // 額度重置時間：重啟後還沒到就繼續扣住，不白撞一次額度
            if self.hold_auth {
                snap["quotaAuth"] = json!(true); // 扣住的原因是登入失效：重開後通知與延遲抬頭才不會寫成額度用完
                let ids: Vec<&String> = self.pending.iter().filter(|p| p.state == State::Held && self.held_auth.contains(&p.id)).map(|p| &p.id).collect();
                snap["heldAuth"] = json!(ids);
            }
        }
        if !self.ack_retry.is_empty() {
            snap["ackRetry"] = json!(self.ack_retry);
        }
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
        self.held_items.remove(id);
        self.fwd_items.remove(id);
        self.fwd_rooms.remove(id);
        self.bounce_notices.remove(id);
        if self.exact_ids.remove(id).is_some() {
            self.parser.forget(id);   // 逾時等沒走到 Sent 的結束方式：內文檔與核對紀錄也一起清
            self.write_inflight();
            self.prune_forward_files();
        }
        self.persist();
    }
    fn online_names(&self) -> HashSet<&str> {
        self.roster.iter().map(|w| w.name.as_str()).filter(|n| *n != self.cfg.mailbox_name).collect()
    }
    /// #767：查一個視窗程序是不是 ASN 開的、用了哪些權限旗標（正式版接真的程序表，測試與沒有桌面時為空）
    fn default_window_probe() -> Option<Arc<dyn Fn(u32) -> (bool, Vec<String>) + Send + Sync>> {
        #[cfg(all(feature = "gui", not(test)))]
        return Some(Arc::new(crate::launch::probe_window));
        #[allow(unreachable_code)]
        None
    }

    /// #767：把 Claude 視窗接回要用的資料記進存檔。程序編號沒變就不重查（查程序表有開銷）
    fn note_window_facts(&mut self) {
        let windows: Vec<(String, u32, String, String, bool)> = self
            .roster
            .iter()
            .filter(|w| w.name != self.cfg.mailbox_name && w.engine == "claude")
            .map(|w| (w.name.clone(), w.pid, w.session_id.clone().unwrap_or_default(), w.cwd.clone(), w.hidden == Some(true)))
            .collect();
        self.probed.retain(|n, _| windows.iter().any(|w| w.0 == *n));
        for (name, pid, session, cwd, hidden) in windows {
            let cached = self.probed.get(&name).filter(|p| p.0 == pid).map(|p| (p.1, p.2.clone()));
            let (asn_opened, perm) = match cached {
                Some(c) => c,
                None => {
                    let got = self.window_probe.as_ref().map_or((false, Vec::new()), |f| f(pid));
                    self.probed.insert(name.clone(), (pid, got.0, got.1.clone()));
                    got
                }
            };
            self.known.set_facts(&name, super::known::WindowFacts { session, cwd, asn_opened, perm, hidden });
        }
    }

    /// 名單更新：記下看得到的視窗；這次收發室跑著的期間看過、現在不見的，先記下不見的時間（寄給它的信照原本的做法立刻退回），
    /// 收發室繼續跑過 FORGET_AFTER_MS 它都沒回來，才當成本人關掉、從存檔拿掉。關機時視窗比收發室早結束，收發室活不到那時候，名字會留著
    fn note_known_windows(&mut self, now: u64) {
        let names: Vec<(String, String)> = self.roster.iter().filter(|w| w.name != self.cfg.mailbox_name).map(|w| (w.name.clone(), w.engine.clone())).collect();
        let present: HashSet<&str> = names.iter().map(|(n, _)| n.as_str()).collect();
        let gone: Vec<String> = self.seen_run.iter().filter(|n| !present.contains(n.as_str())).cloned().collect();
        for n in gone {
            let since = *self.missing.entry(n.clone()).or_insert(now);
            if now.saturating_sub(since) >= FORGET_AFTER_MS {
                self.missing.remove(&n);
                self.seen_run.remove(&n);
                self.known.forget(&n);
                self.awaiting.remove(&n);
            }
        }
        for (n, e) in &names {
            self.missing.remove(n);
            self.seen_run.insert(n.clone());
            self.known.touch(n, e, now);
            self.awaiting.remove(n); // 接回來了：先留著的信下一輪拉信就會照順序送
        }
        self.note_window_facts();
        if let Err(e) = self.known.save_if_dirty(&self.cfg.work_dir.join(super::known::KNOWN_FILE), now) {
            self.log.line(&format!("known-windows.json save failed: {e}"));
        }
    }

    /// 這個名字現在名單上沒有，但重開前有在線、而且還在寬限期內：等它接回來（信不退回）
    fn awaiting_return(&self, name: &str) -> bool {
        !self.seen_run.contains(name) && self.known.contains(name) && self.now.saturating_sub(self.started_at) < AWAIT_GRACE_MS
    }

    /// 先留著這封信（留在後台信箱，不 ack）。回 false＝這個夥伴已經留了太多封，這封照原本的做法退回
    fn hold_for_return(&mut self, name: &str, id: &str) -> bool {
        let total: usize = self.awaiting.values().map(HashSet::len).sum();
        let n = self.awaiting.entry(name.to_string()).or_default();
        if !n.contains(id) && (n.len() >= AWAIT_MAIL_MAX || total >= AWAIT_TOTAL_MAX) {
            return false;
        }
        if n.insert(id.to_string()) {
            if self.await_first.len() >= 400 {
                self.await_first.clear();
            }
            self.await_first.entry(id.to_string()).or_insert(self.now);
            self.log.line(&format!("id={id} to={name}: window not back yet after restart, kept in inbox (waiting up to {} h)", AWAIT_GRACE_MS / 3_600_000));
        }
        true
    }

    /// 告訴寄件人「先留著」：同一次重開、同一位寄件人對同一位夥伴只說一次；收發室寄的、通知本身都不回
    async fn tell_sender_waiting(&mut self, m: &Mail, target: &str) {
        let from_agent = m.from_agent.clone().unwrap_or_default();
        if Self::is_mailbox_sender(&from_agent) || m.body.trim_start().starts_with("[收發室]") {
            return;
        }
        if !self.awaiting_told.insert(format!("{}/{}->{target}", m.from_node, from_agent)) {
            return;
        }
        let text = format!("[收發室] 「{target}」在收發室重開前有在線，還沒接回來；信已收到、先留著，接回來後會送出（最多等 {} 小時，不用重寄；送到時會註明原本幾點收到）。", AWAIT_GRACE_MS / 3_600_000);
        let o = Origin { id: m.id.clone(), from_node: m.from_node.clone(), from_agent };
        self.send_back(&o, &text, None, Some(false)).await;
    }

    /// 退回時的說明：重開前有在線、等過寬限期還沒回來的，講明等了多久
    fn unreachable_note(&self, name: &str) -> String {
        if !self.known.contains(name) || self.seen_run.contains(name) {
            return String::new();
        }
        if self.now.saturating_sub(self.started_at) >= AWAIT_GRACE_MS {
            format!("（它在收發室重開前有在線，等了 {} 小時沒有回來）", AWAIT_GRACE_MS / 3_600_000)
        } else if self.awaiting.get(name).is_some_and(|s| s.len() >= AWAIT_MAIL_MAX) || self.awaiting.values().map(HashSet::len).sum::<usize>() >= AWAIT_TOTAL_MAX {
            format!("（它在收發室重開前有在線，還沒接回來；等接回來的信已經留滿了（每位 {AWAIT_MAIL_MAX} 封、全部 {AWAIT_TOTAL_MAX} 封），這封先退回，請等它回來後再寄）")
        } else {
            String::new()
        }
    }

    fn forwardable(&self, name: &str) -> bool {
        self.roster.iter().any(|w| w.name == name) || (self.cfg.extra_allow.iter().any(|n| n == name) && self.online_names().contains(name))
    }
    fn agent_of(&self, name: &str) -> Option<&Window> {
        self.roster.iter().find(|w| w.name == name)
    }
    /// 信上的收件名換成名單上的名字（Aegis 成員代號、內建通道工作者改名前的舊名）。
    /// 名單上現在就有這個名字的視窗或夥伴（Claude 視窗、pi、其他引擎都算）時一律照原名送給它，舊名對照不能蓋過活的同名視窗（#266）
    fn canonical_target(&self, id: &str, name: &str) -> String {
        let Some(e) = self.engines.as_ref() else { return name.to_string() };
        let c = e.canonical_name(name);
        if c != name && self.agent_of(name).is_some() {
            self.log.line(&format!("id={id} to={name}: a live window has this name, rename/alias mapping to {c} skipped"));
            return name.to_string();
        }
        c
    }
    /// 自動回信模式下，這個名字就是 worker 自己扮的視窗
    fn is_respond(&self, name: &str) -> bool {
        self.cfg.respond.as_deref() == Some(name)
    }
    /// 自動回信視窗現在的狀態：worker 這一輪還沒結束，或剛交辦（寬限期內）還沒回的＝busy，否則 idle
    fn respond_status(&self) -> &'static str {
        let Some(me) = self.cfg.respond.as_deref() else { return "idle" };
        let recent = self.pending.iter().any(|p| p.target == me && !p.replied && matches!(p.state, State::Forwarding | State::Waiting) && self.now.saturating_sub(p.t.max(p.t0)) < RESPOND_BUSY_GRACE_MS);
        if recent || self.respond_open { "busy" } else { "idle" }
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
            Ok(_) => self.note_acked(ids),
            Err(e) => {
                self.log.line(&format!("ack failed: {e}"));
                self.note_ack_failed(ids);
            }
        }
    }

    // ---- 名單 ----
    /// 即時監看（每 watch_ms 一次）：只讀本機 sessions 與外掛狀態檔，名字／狀態／說明和上次回報時不同
    /// （心跳只改 at，不算）且距上次回報已過防抖間隔，就立刻整份回報名單（後台再通知別台設備重拉）。回傳有沒有回報。
    pub async fn watch_local(&mut self, now: u64) -> bool {
        let (alive, created) = (self.alive.clone(), self.created.clone());
        let Some(l) = roster::read_local_with(&self.cfg.sessions_dir, &self.cfg.status_dir, |p, st| alive(p) && roster::same_process(st, created(p)), self.sink.pid(), &self.cfg.mailbox_name, now) else {
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
        let (alive, created) = (self.alive.clone(), self.created.clone());
        let claude = roster::read_sessions_with(&self.cfg.sessions_dir, |p, st| alive(p) && roster::same_process(st, created(p)), self.sink.pid(), &self.cfg.mailbox_name);
        let engine_ok = self.engines.as_ref().map(|e| e.has_result()).unwrap_or(false);
        // Claude 讀不到、其他引擎也還沒有任何結果：名單不動（和以前一樣）
        if claude.is_none() && !engine_ok && self.cfg.respond.is_none() {
            return;
        }
        if let Some(mut l) = claude {
            roster::apply_mod_status(&mut l, &self.cfg.status_dir, now);
            let live: Vec<String> = l.iter().filter_map(|w| w.session_id.clone()).collect();
            roster::cleanup_mod_status(&self.cfg.status_dir, &live, now);
            roster::cleanup_mod_status(&self.cfg.status_dir.with_file_name(roster::SCREEN_DIR), &live, now);
            self.roster_fp = Some(roster::local_fingerprint(&l));
            self.roster_at = now;
            self.claude_roster = l;
        }
        let mut list = self.claude_roster.clone();
        if let Some(e) = &self.engines {
            list.extend(e.windows().into_iter().filter(|w| w.name != self.cfg.mailbox_name));
        }
        // 自動回信：worker 自己當一個可收信的視窗（同名的別的視窗讓位，一個名字只能對應一個收件者）
        if let Some(me) = self.cfg.respond.clone() {
            list.retain(|w| w.name != me);
            let st = self.respond_status();
            list.insert(0, Window::claude(&me, Some(st.into()), "", 0, now, None));
            self.respond_sent = st.to_string();
            self.roster_at = now;
        }
        if self.cfg.wait_alert {
            roster::mark_unknown_status(&mut list);
        }
        self.roster = list;
        self.roster_ok = true;
        self.note_known_windows(now);
        let asn = self.cfg.report_asn_window.then(|| self.relay.window_name());
        // 摘要要讀設定檔、偵測 CLI（會開外部程序），放到背景執行緒，不卡住收信的主迴圈
        let launcher = match self.launcher.clone() {
            Some(l) => tokio::task::spawn_blocking(move || l.summary()).await.unwrap_or(Value::Null),
            None => Value::Null,
        };
        // 本機執行中的代理（claude -p／pi／codex／gemini…）：僅顯示、不可收信；讀程序放背景執行緒，開關見 procscan::enabled
        // 已登記成可收信視窗的 pi（擴充登記的 pid）不再重複列成僅顯示條目
        let registered: Vec<u32> = self.roster.iter().filter(|w| w.engine == "pi").map(|w| w.pid).collect();
        // 主控台視窗表一輪只列一次（EnumWindows，不接上別人的主控台），名單裡所有有視窗的條目共用
        let (mut procs, snap) = tokio::task::spawn_blocking(move || (super::procscan::scan_system_excluding(&registered), crate::launch::console::window_snapshot())).await.unwrap_or_default();
        roster::apply_hidden(&mut self.roster, &snap);
        let pi_loaded = self.engines.as_ref().is_some_and(|e| e.has("pi"));
        for p in procs.iter_mut() {
            p.hidden = roster::hidden_of(&snap, p.pid);
            // 前景（互動）pi 沒登記成可收信視窗：說明原因，不要看起來像一般自己開的程式（#467）。-p 等背景單次執行本來就不登記
            if p.engine == "pi" && !p.background {
                p.detail = Some(super::engines::pi_unregistered_detail(pi_loaded).to_string());
            }
        }
        // 在忙也算活躍（E4）：這一輪忙碌的視窗記成現在；名單上沒有的名字不保留
        self.active = roster::active_marks(&self.active, &self.roster, now);
        let body = roster::with_active(roster::roster_body_with_procs(&self.roster, asn.as_deref(), launcher, &procs), &self.active);
        // 靠舊環境變數名才拿到設定的舊名（只送名字；新版一律帶，沒用到是空陣列）
        let mut body = roster::with_legacy_env(body, (self.legacy_src)());
        // 這台電腦的 Claude 外掛狀態：啟動檢查完與狀態變化時才附（舊後台會丟掉這個欄位，不壞）
        let due = roster::mod_report_due((self.mod_src)(), self.mod_sent.as_ref(), now);
        if let Some(m) = &due {
            body["mod"] = m.clone();
        }
        // 收發室 worker 額度用完而暫停收信到什麼時候（毫秒；null＝沒有）：值有變才附，給後台的收信監控抑制通知用
        // 後台在暫停開始時寄通知給擁有者（扣住筆數由這裡帶，設備名由後台讀；超過上限的旗標每次額度用完只帶一次）
        let hold = self.inbox_hold_until();
        let cap_due = self.hold_cap_due();
        let hold_due = self.hold_sent != Some(hold) || cap_due;
        if hold_due {
            body["inbox_hold_until"] = json!(hold);
            if hold.is_some() {
                body["inbox_hold_count"] = json!(self.quota_held_total());
            }
            if cap_due {
                body["inbox_hold_capped"] = json!(true);
            }
        }
        match self.relay.api("roster", Some(body)).await {
            Ok(_) => {
                self.roster_warned = false;
                if hold_due {
                    self.hold_sent = Some(hold);
                    self.cap_sent = if hold.is_none() { false } else { self.cap_sent || cap_due };
                }
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
                // ack 失敗等著補：信處理完了，不再轉交；補 ack 由 ack_retry_tick 做，才有退避
                if self.is_ack_retry(&m.id) {
                    held.extend(m.to_agent.clone());
                    continue;
                }
                if let Some(i) = self.idx(&m.id) {
                    // 重啟後留下的額度扣住信（只有 id 與收到時間）：靠重新拉到的同一封補回內文，不重複收
                    if self.pending[i].state == State::Held && !self.held_items.contains_key(&m.id) {
                        self.log.line(&format!("held mail id={} pulled again: content restored", m.id));
                        self.held_items.insert(m.id.clone(), HeldItem { mail: m.clone(), raw: Some(raw.clone()), received_at: self.pending[i].t0 });
                    }
                    // 已經轉交完、該 ack 了卻還在信箱（待補清單不見了）：補 ack
                    let p = &self.pending[i];
                    if matches!(p.state, State::Waiting | State::Notified) && p.room.is_none() && !self.defers_ack(&p.target) {
                        dup.push(m.id.clone());
                    }
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
        let mut name = if set.trim().is_empty() { self.cfg.default_agent.trim().to_string() } else { set.trim().to_string() };
        if name.is_empty() {
            name = self.cfg.respond.clone().unwrap_or_default(); // 自動回信模式：沒設預設成員就是自己
        }
        if name.is_empty() {
            name = self.engines.as_ref().and_then(|e| e.default_window()).unwrap_or_default(); // 引擎自己的預設成員（Aegis）
        }
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
        if self.is_respond(target) || matches!(self.engine_of(target).as_str(), "acp" | "aegis") {
            return text;
        }
        format!("{text}\n{}", self.corr.path_line(target))
    }

    fn deliver(&mut self, id: &str, to: &str, text: &str) -> Result<(), String> {
        let r = self.deliver_raw(id, to, text);
        if r.is_ok() {
            self.active.insert(to.to_string(), self.now);
        }
        r
    }

    fn deliver_raw(&mut self, id: &str, to: &str, text: &str) -> Result<(), String> {
        let eng = self.engine_of(to);
        if eng != "claude" {
            return match &self.engines {
                Some(e) => e.deliver(&eng, id, to, text),
                None => Err(format!("沒有載入「{eng}」引擎")),
            };
        }
        if self.is_respond(to) {
            // worker 自己回答，不會回 SENT：不登記追蹤，交出去就算已轉交（各呼叫處接著呼叫 on_sent）
            let r = self.sink.say(forward_text(&self.parser.nonce, id, to, text));
            self.respond_open = self.respond_open || r.is_ok();
            return r;
        }
        // 核對轉交對象：第一行行尾一定要有這封的編號（hook 與 SENT 比對都只認行尾），先記下 {編號: 目標} 再送
        let text = super::forward_gate::ensure_head_id(text, id);
        if self.fwd_text.len() >= 400 {
            self.fwd_text.clear(); // 只有送錯要重送時才用得到，爆量時整批丟掉也不影響正常轉交
        }
        self.fwd_text.insert(id.to_string(), (to.to_string(), text.clone()));
        let payload = self.register_forward(id, to, &text);
        self.write_inflight();
        let r = self.sink.say(payload);
        if r.is_err() {
            self.parser.forget(id);
            self.fwd_text.remove(id);
            self.write_inflight();
        } else {
            self.fwd_turn_open = Some(self.now);
        }
        r
    }

    /// 收發室 worker 這一輪還沒結束：新的信與群組訊息先留著（不處理、不 ack、游標不前進）。回 true＝要先留著
    fn fwd_busy(&mut self, what: &str) -> bool {
        let Some(since) = self.fwd_turn_open.filter(|_| self.cfg.one_per_turn) else { return false };
        if !self.fwd_gated {
            self.log.line(&format!("{what}: worker turn still open ({}ms), kept for the next pull", self.now.saturating_sub(since)));
        }
        self.fwd_gated = true;
        true
    }

    /// 這一輪結束（worker 回報結果、重啟、結束，或等太久）：有先留著的就馬上再拉一次
    fn end_fwd_turn(&mut self, why: &str) {
        if self.fwd_turn_open.take().is_none() {
            return;
        }
        if std::mem::take(&mut self.fwd_gated) {
            self.log.line(&format!("worker turn ended ({why}): pulling the mail kept waiting"));
            self.retry_at = Some(self.now);
        }
    }

    /// 內文檔與已套用紀錄：只留還在轉交中、或還等著核對已套用紀錄的編號
    fn prune_forward_files(&self) {
        let mut live: HashSet<String> = self.parser.inflight_pairs().into_iter().map(|(id, _)| id.to_ascii_lowercase()).collect();
        live.extend(self.exact_ids.keys().map(|k| k.to_ascii_lowercase()));
        super::forward_gate::prune_files(&self.cfg.work_dir, Some(&live));
    }

    /// 轉交內容和原信逐字相同現在生效嗎：旗標開著，而且通過了自我測試（或開發機強制）
    fn exact_active(&self) -> bool {
        self.cfg.forward_exact && self.cfg.forward_hook && (self.exact_verified || self.cfg.forward_exact_unverified)
    }

    /// 登記一封要交給 worker 的信（hook 與 SENT 比對用），回傳要送進 worker 的指令。
    /// 原文替換生效時：全文存內文檔、指令只帶一行佔位；內文檔寫不進去就退回舊做法（整封交給 worker）
    fn register_forward(&mut self, id: &str, to: &str, text: &str) -> String {
        if self.exact_active() {
            // 重登記同一封（重送）：上一次的已套用紀錄作廢，不然這次 hook 失效時會讀到舊紀錄而假成功
            super::forward_gate::remove_applied(&self.cfg.work_dir, id);
            match super::forward_gate::write_body(&self.cfg.work_dir, id, text) {
                Ok(()) => {
                    self.parser.register_head(id, to, super::forward_gate::head_hash(&super::forward_gate::placeholder_line(id)));
                    let h = super::forward_gate::body_hash(text);
                    self.parser.register_exact(id, h.clone());
                    self.exact_ids.insert(id.to_string(), h);
                    return forward_text_exact(&self.parser.nonce, id, to);
                }
                Err(e) => self.log.line(&format!("forward-body write failed id={id}: {e} (falling back to full text)")),
            }
        }
        self.exact_ids.remove(id);
        self.parser.register_head(id, to, super::forward_gate::head_hash(super::forward_gate::first_line(text)));
        self.parser.keep_original(id, text);
        forward_text(&self.parser.nonce, id, to, text)
    }

    /// worker 說送出了，但已套用紀錄對不上（hook 沒換成原文、或換的不是這份）：不算轉交成功，不 ack，重送一次；再不行就走轉交失敗
    async fn on_not_applied(&mut self, id: &str) {
        self.log.line(&format!("forward-not-applied id={id}"));
        let Some(i) = self.idx(id) else { return };
        if self.pending[i].state != State::Forwarding {
            return;
        }
        if self.not_applied_once.len() >= 1000 {
            self.not_applied_once.clear();
        }
        let again = self.not_applied_once.insert(id.to_string());
        let Some((to, text)) = self.fwd_text.get(id).cloned().filter(|_| again) else {
            self.on_fail(id, "核對轉交內容失敗").await;
            return;
        };
        let payload = self.register_forward(id, &to, &text);
        self.write_inflight();
        match self.sink.say(payload) {
            Ok(_) => self.log.line(&format!("forward-not-applied id={id}: resent once to {to}")),
            Err(e) => {
                self.log.line(&format!("forward-not-applied id={id}: resend failed: {e}"));
                self.on_fail(id, "核對轉交內容失敗").await;
            }
        }
    }

    /// inflight 有變動就重寫 hook 讀的檔（寫不進去只記 log：hook 讀不到會把轉交擋下，worker 回報失敗，不會送錯）
    fn write_inflight(&mut self) {
        if !self.parser.take_dirty() {
            return;
        }
        self.prune_forward_files();
        if let Err(e) = super::forward_gate::write_inflight_with(&self.cfg.work_dir, &self.parser.inflight_items(), &self.parser.inflight_bodies()) {
            self.parser.mark_dirty(); // 沒寫成：旗標設回去，下一個 tick 再試
            self.log.line(&format!("inflight file write failed: {e}"));
        }
    }

    /// 本人簽章的私信轉交給視窗：退回那個視窗一封寄信額度（群組訊息不走這裡；一封信只退一次）
    fn refund_owner_mail(&self, m: &Mail, target: &str) {
        if m.trust == "owner" && crate::cli::send_rate::refund(&self.cfg.rate_home, target, &m.id, crate::heartbeat::now_ms()) {
            self.log.line(&format!("id={} from the owner: refunded one send for {target}", m.id));
        }
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
                    self.log.line(&format!("id={} to={to} is ASN's own window: bridge skips ({})", m.id, crate::relay::ui_seen_text(crate::heartbeat::now_ms(), self.relay.ui_inbox_at())));
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
            Some(t) => self.canonical_target(&m.id, &t),
            None => match self.unaddressed_window() {
                // 使用者指定了「沒指定收件人的信交給誰」而且那個視窗在線：照設定給它
                Some(w) => {
                    note = unaddressed_window_note(&w);
                    self.log.line(&format!("id={} has no to_agent: handed to configured window {w}", m.id));
                    w
                }
                // 否則交給本人（ASN 視窗）：信留在信箱不 ack，ASN 畫面收下才 ack。不再丟給隨便一個 session
                None => {
                    // 僅引擎模式（Aegis 主機沒有本人視窗）：引擎自己說明怎麼指定收件人，不留在信箱
                    if let Some(text) = self.engine_only_reply(|e| e.unaddressed_reply()) {
                        self.log.line(&format!("id={} has no to_agent: engine asked sender to specify", m.id));
                        if !Self::is_mailbox_sender(&from_agent) {
                            let o = Origin { id: m.id.clone(), from_node: m.from_node.clone(), from_agent: from_agent.clone() };
                            if !self.send_back(&o, &text, None, None).await {
                                return None; // 寄回失敗：留在信箱，下次補拉再來
                            }
                        }
                        self.ack_ids(&[m.id.clone()]).await;
                        return None;
                    }
                    self.hand_to_owner(&m, raw, &from_agent).await;
                    return None;
                }
            },
        };
        // 「寄回成功才 ack」的引擎（Aegis）：寄件人說不需回覆也照問、照回（和 Node 版一樣）；其他引擎維持原行為
        let always = { let eng = self.engine_of(&target); self.engines.as_ref().is_some_and(|e| e.always_replies(&eng)) };
        let no_reply = (!wants_reply(m.expects_reply, &m.body) && !always) || Self::is_mailbox_sender(&from_agent);
        let mut p = Pending::new(&m.id, &m.from_node, &from_agent, &target, self.now, no_reply);
        p.sender_desc = mail::sender_line(&m).trim_start_matches("寄件人：").to_string();
        // 重開後夥伴視窗還沒接回來：信留在後台信箱（不退回、不 ack），等它接回來再照順序送；等太久或留太多才退回
        if !self.forwardable(&target) && self.awaiting_return(&target) && self.hold_for_return(&target, &m.id) {
            self.tell_sender_waiting(&m, &target).await;
            return Some(target);
        }
        if !self.forwardable(&target) {
            let names = if self.roster.is_empty() { "(無)".to_string() } else { self.roster.iter().map(|w| w.name.as_str()).collect::<Vec<_>>().join("、") };
            p.state = State::Done;
            if Self::is_mailbox_sender(&from_agent) {
                self.log.line(&format!("id={} target {target} not found; notice to mailbox sender not sent", m.id));
            } else {
                let text = self.engine_only_reply(|e| e.unreachable_reply(&target)).unwrap_or_else(|| format!("[收發室] 找不到名叫「{target}」的 session（目前可達：{names}）{}", self.unreachable_note(&target)));
                self.send_back(&Origin::of(&p), &text, None, None).await;
            }
            self.ack_ids(&[m.id.clone()]).await;
            return None;
        }
        // 同名的 Claude 視窗有兩個以上（#584）：不交給收發員，跟寄件人講清楚，信留在信箱等剩一個時自動重送
        if let Some(r) = self.dup_gate(&m, &target, &Origin::of(&p)).await {
            return r;
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
        // 收發室 worker 額度還沒重置：先扣住（不送 worker、不 ack），重置後依序重送
        if self.quota_active(self.now) && self.via_worker(&target) && !self.probing && !self.is_respond(&target) {
            // 已達扣住上限的信不收：回傳收件視窗名，下一輪拉信排除它，才拉得到信箱裡其他視窗的信
            return if self.quota_hold_mail(p, &m, raw).await { None } else { Some(target) };
        }
        // 收發室 worker 一輪只交一封：它這一輪還沒結束就先不收這封（留在信箱，這一輪結束馬上再拉；順序不變）
        if self.via_worker(&target) && !self.is_respond(&target) && self.fwd_busy(&format!("id={}", m.id)) {
            return Some(target);
        }
        let late = self.late_from.take().or_else(|| self.held_first.get(&m.id).copied());
        // 註明的時間：後台記的寄出時間優先（半夜寄來、早上才接回，不能寫成早上）；沒有才用收發室先留著的時間
        let await_at = self.await_first.remove(&m.id).map(|t| m.sent_ms.unwrap_or(t));
        let origin = Origin::of(&p);
        self.pending.push(p);
        // 重開前沒做完的通道信：同一封最多重送一次，再沒做完就通知寄件人（#828）
        let mut resend_note = "";
        if self.channel_back.remove(&m.id) {
            if channel_turns::resent(&self.cfg.work_dir, &m.id) {
                self.log.line(&format!("id={} channel mail unfinished after one resend: giving up", m.id));
                self.on_fail(&m.id, CHANNEL_GIVE_UP).await;
                return None;
            }
            if channel_turns::started(&self.cfg.work_dir, &m.id) {
                resend_note = CHANNEL_RESEND_NOTE;
            }
            self.log.line(&format!("id={} channel mail resent after restart (started before: {})", m.id, !resend_note.is_empty()));
            channel_turns::clear_started(&self.cfg.work_dir, &m.id);
            if let Err(e) = channel_turns::mark_resent(&self.cfg.work_dir, &m.id) {
                self.log.line(&format!("id={} cannot record the resend: {e}", m.id));
            }
        }
        self.refund_owner_mail(&m, &target);
        if !no_reply {
            self.last_requester.insert(target.clone(), LastReq { from_node: m.from_node.clone(), from_agent: from_agent.clone(), mail_id: m.id.clone(), t: self.now });
        }
        self.persist();
        // 照片／檔案：內文後面多一行「〔照片〕檔名＋下載指令」，和內文一起在外部資料區塊內
        let body = attach::notes_for(&mail::escape_body(&m.body), &m.attachments, self.cfg.attach_cmd.as_deref());
        // 自動回信的 worker 由橋代寄回答：不附「請用 asn_send 回信」那行
        let pre_engine = if self.is_respond(&target) { "respond".to_string() } else { self.engine_of(&target) };
        let text = format!("{}\n{}{}{}{}", mail_head(&m, &self.engine_label_of(&target)), mail::insert_await_line(mail::preamble_late_kind(&m, &pre_engine, late, self.held_auth.contains(&m.id)), await_at), if resend_note.is_empty() { String::new() } else { format!("{resend_note}\n") }, if note.is_empty() { String::new() } else { format!("{note}\n") }, body);
        let text = self.with_path_line(text, &target);
        match self.deliver(&m.id, &target, &text) {
            Ok(_) => {
                self.log.line(&format!("handed id={} from={}/{} to={target}", m.id, m.from_node, from_agent));
                self.note_if_notice(&m.id, &m.body);
                if self.fwd_origin.len() >= 400 {
                    self.fwd_origin.clear();
                }
                self.fwd_origin.insert(m.id.clone(), origin.clone());
                if !self.is_respond(&target) && self.via_worker(&target) {
                    self.fwd_items.insert(m.id.clone(), HeldItem { mail: m.clone(), raw: raw.clone(), received_at: late.unwrap_or(self.now) });
                }
                let names: Vec<String> = m.attachments.iter().map(|a| a.name.clone()).collect();
                self.corr_note(&target, Dir::Received, &Self::node_agent(&m.from_node, &from_agent), &target, &m.id, &m.body, &names);
                if no_mod_notice && !self.is_respond(&target) {
                    self.send_back(&origin, NO_MOD_NOTICE, None, Some(false)).await;
                }
                if self.is_respond(&target) {
                    self.on_sent(&m.id).await; // 交給自己的 worker＝已轉交：沿用既有的 ack／等回覆／逾時流程
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
            self.owner_receipts.push((self.now + OWNER_RECEIPT_GRACE_MS, Origin::of(&p)));
        }
    }

    /// 到期的「交給本人」說明：信已被本人收下就不寄；同一寄件人十分鐘內只寄一次。信本身不動（不 ack、不移除）
    async fn flush_owner_receipts(&mut self, now: u64) {
        if self.owner_receipts.is_empty() {
            return;
        }
        let (due, rest): (Vec<_>, Vec<_>) = std::mem::take(&mut self.owner_receipts).into_iter().partition(|(t, _)| *t <= now);
        self.owner_receipts = rest;
        let held = self.relay.unaddressed_ids();
        let owner = self.relay.window_name();
        for (_, o) in due {
            if !held.contains(&o.id) {
                continue; // 本人已收下
            }
            let key = format!("{}/{}", o.from_node, o.from_agent);
            if self.owner_receipt_at.get(&key).is_some_and(|t| now.saturating_sub(*t) < OWNER_RECEIPT_GAP_MS) {
                continue;
            }
            self.owner_receipt_at.insert(key, now);
            self.send_back(&o, &unaddressed_receipt(&owner), None, Some(false)).await;
        }
        self.owner_receipt_at.retain(|_, t| now.saturating_sub(*t) < OWNER_RECEIPT_GAP_MS);
    }

    // ---- worker 回報 ----
    pub async fn on_worker_line(&mut self, l: WorkerLine, now: u64) {
        self.now = now;
        match l {
            WorkerLine::Started(_) => {
                self.worker_fails = 0;
                self.parser.reset_process();
                self.respond_open = false; // worker 重啟：舊的一輪不會再有結果了
                self.end_fwd_turn("worker restarted");
            }
            WorkerLine::Exited(_) => {
                self.respond_open = false;
                self.end_fwd_turn("worker exited");
            }
            WorkerLine::Line(line) => {
                let r = self.parser.feed_at(&line, now);
                for l in &r.logs {
                    self.log.line(l);
                }
                self.write_inflight();
                if r.turn_done {
                    self.respond_open = false;
                    self.end_fwd_turn("turn done");
                }
                for ev in r.events {
                    match ev {
                        WorkerEvent::Sent(id) => {
                            self.quota_release("worker reported sent"); // worker 真的在工作＝額度恢復
                            // 原文替換的那封：要有 hook 寫的已套用紀錄、而且雜湊對得上才算送出
                            if let Some(h) = self.exact_ids.remove(&id) {
                                let ok = super::forward_gate::read_applied(&self.cfg.work_dir, &id).as_deref() == Some(h.as_str());
                                self.prune_forward_files();
                                if !ok {
                                    self.on_not_applied(&id).await;
                                    continue;
                                }
                            }
                            self.on_sent(&id).await
                        }
                        WorkerEvent::Fail(id, reason) => {
                            self.quota_release("worker reported fail");
                            self.count_worker_fail();
                            self.on_fail(&id, &reason).await
                        }
                        WorkerEvent::AuthFailed => self.on_worker_auth_failed().await,
                        WorkerEvent::DeliveryProblem { kind, recipient } => self.on_delivery_problem(kind, &recipient).await,
                        WorkerEvent::Misrouted { id, expected, actual } => self.on_misrouted(&id, &expected, &actual).await,
                        WorkerEvent::Quota { resets_at, kind } => {
                            if self.cfg.respond.is_some() {
                                // 自動回信模式不參與扣住：worker 自己回答，沒有「轉交中」可扣，照原本的等回覆逾時流程
                                self.log.line(&format!("worker quota exhausted ({kind}): respond mode does not hold mail, carrying on"));
                            } else {
                                self.on_quota(resets_at, &kind).await
                            }
                        }
                        WorkerEvent::Reply { from, text } => {
                            self.quota_release("worker replied"); // 自動回信模式：worker 真的回答了＝額度恢復，下次用完再通知
                            self.quota_ep = None;
                            // 自動回信：worker 只扮一個視窗，名字以設定為準（不信模型寫的 from）
                            let from = self.cfg.respond.clone().unwrap_or(from);
                            self.on_reply(&from, &text, None).await
                        }
                    }
                }
                if r.restart {
                    self.sink.kill();
                }
            }
        }
    }

    pub async fn on_sent(&mut self, id: &str) {
        let Some(i) = self.idx(id) else {
            self.quota_sent_after_hold_room(id);
            return;
        };
        // Sent 比額度事件晚到：這封其實已經轉交成功了，不能等恢復後再送一次
        if self.pending[i].state == State::Held && self.held_items.remove(id).is_some() {
            self.log.line(&format!("sent id={id} arrived after the quota event: already forwarded, not resending"));
            self.pending[i].state = State::Forwarding;
        }
        if self.pending[i].state != State::Forwarding {
            return;
        }
        self.pending[i].state = State::Waiting;
        let forwarded = self.pending[i].clone();
        self.note_forwarded(&forwarded);
        if self.quota_until == 0 && !self.is_respond(&self.pending[i].target) {
            self.quota_ep = None; // 收發室 worker 真的完成了轉交＝額度恢復，下次用完再通知
        }
        let channel = self.pending[i].room.is_none() && self.engine_of(&self.pending[i].target) == "acp";
        self.pending[i].channel = channel;
        self.persist();
        let (target, t0, no_reply) = (self.pending[i].target.clone(), self.pending[i].t0, self.pending[i].no_reply);
        if let Some(r) = self.pending[i].room.clone() {
            // 群組訊息：只記 log、開始等回覆；不 ack（群組沒有信箱）
            self.log.line(&format!("forwarded room={} #{} -> {target}", r.id, r.seq));
            self.pending[i].t = self.now;
            return;
        }
        if channel {
            // 內建通道：這一輪結束（Replied 或 Fail）才 ack，重開時沒做完的信還在信箱（#828）
            self.log.line(&format!("forwarded id={id} -> {target} ({}ms, ack when the turn ends)", self.now.saturating_sub(t0)));
            self.pending[i].t = self.now;
            self.ack_wait.insert(id.to_string());
            self.channel_wait.insert(id.to_string());
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
        if self.defers_ack(&target) {
            self.ack_wait.insert(id.to_string()); // 寄回成功才 ack（Replied 事件）
            return;
        }
        self.ack_ids(&[id.to_string()]).await;
    }

    /// 僅引擎模式才問引擎的專屬說明文字（有本人視窗或 Claude 視窗時維持核心的文字）
    fn engine_only_reply(&self, f: impl Fn(&EngineSet) -> Option<String>) -> Option<String> {
        if !self.cfg.engine_only {
            return None;
        }
        self.engines.as_ref().and_then(|e| f(e))
    }

    fn defers_ack(&self, target: &str) -> bool {
        let eng = self.engine_of(target);
        self.engines.as_ref().is_some_and(|e| e.ack_after_reply(&eng))
    }

    /// 失敗原因給人看：認得的錯誤（額度用完）換成白話，其他原樣
    fn short_fail_reason(why: &str) -> String {
        if Self::is_payment_error(why) {
            return "額度用完了（API 402）".into();
        }
        why.to_string()
    }

    /// 是不是 HTTP 402。不能只找「402」：路徑、編號、時間裡都可能剛好有這三個數字，真正的原因會被蓋掉
    fn is_payment_error(why: &str) -> bool {
        let w = why.to_lowercase();
        ["payment required", "balance exhausted", "http 402", "http/1.1 402", "http/2 402", "status 402", "status: 402", "status code 402", "api 402", "error 402", "error: 402", "code 402", "(402)", "402 {"].iter().any(|k| w.contains(k))
    }

    /// 失敗原因是不是「對方收到了、但它的回覆被內容過濾擋下」（不是沒轉交）
    pub(super) fn reply_blocked(why: &str) -> bool {
        let l = why.to_lowercase();
        l.contains("blocked by content safety") || l.contains("content safety filter")
    }

    /// 寄給寄件人的轉交失敗通知內文。兩種要分清楚：沒轉交（一般失敗）、對方收到了但回覆被內容過濾擋下
    /// （不是沒轉交，不要讓人以為信沒送到；只能確定收到，不能確定做完）。收發室登入失效不走這裡：信會扣住，見 quota.rs 的 on_worker_auth_failed
    fn fail_notice_text(target: &str, why: &str) -> String {
        if Self::reply_blocked(why) {
            return format!("[收發室] {target} 收到信了，但它的回覆被內容過濾擋下，沒有回到你這裡。可以請它再回一次。");
        }
        format!("[收發室] 轉交給 {target} 失敗：{}", Self::short_fail_reason(why))
    }

    pub async fn on_fail(&mut self, id: &str, reason: &str) {
        self.exact_ids.remove(id);
        channel_turns::clear(&self.cfg.work_dir, id);
        self.channel_wait.remove(id);
        self.ack_wait.remove(id);
        self.reply_fail.remove(id);
        let Some(i) = self.idx(id) else { return };
        if self.pending[i].state == State::Done {
            return;
        }
        self.pending[i].state = State::Done;
        let (o, target, from_agent) = (Origin::of(&self.pending[i]), self.pending[i].target.clone(), self.pending[i].from_agent.clone());
        self.log.line(&format!("forward failed id={id}: {reason}"));
        if self.pending[i].room.is_some() {
            self.room_forward_failed(id, "room", false, reason).await;
            self.remove(id);
            return;
        }
        self.count_forward_fail("mail", id, &target);
        if Self::is_mailbox_sender(&from_agent) {
            self.log.line(&format!("forward failure notice to mailbox sender {}/{} not sent id={id}", o.from_node, from_agent));
        } else if self.bounce_notices.contains(id) {
            self.log.line(&format!("forward failure notice not sent id={id}: the failed mail is itself a notice"));
        } else {
            let why = if reason.is_empty() { "原因不明" } else { reason };
            // 失敗通知用「對方視窗」的名義寄回、掛在原信底下：寄件人在跟那個視窗的對話框裡直接看到，不是另一個「收發室」視窗
            let as_target = if target.trim().is_empty() { None } else { Some(target.as_str()) };
            self.send_back(&o, &Self::fail_notice_text(&target, why), as_target, None).await;
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
        if self.is_respond(name) {
            self.log.line(&format!("notice to {name} not delivered: it is the bridge's own auto-reply window"));
            return;
        }
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
        let deferred = self.ack_wait.contains(&o.id);
        if deferred && self.reply_fail.contains(&o.id) {
            self.log.line(&format!("reply from {from} id={} not sent: an earlier part failed (mail stays in inbox)", o.id));
            return;
        }
        let ok = self.send_back(&o, &body, Some(from), expects).await;
        if deferred && !ok {
            self.reply_fail.insert(o.id.clone());
        }
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
        // Jev 分數低於門檻的人暫不通知（#230）：略過這則，游標照常前進
        if rooms::wake_hold(msg) {
            self.log.line(&format!("room={} #{} member={member}: skipped (Jev score below threshold)", room.get("id").and_then(Value::as_str).unwrap_or(""), json_u64(msg.get("seq"))));
            return true;
        }
        // 收發室 worker 額度還沒重置：群組訊息不即時通知，先扣住（存檔，游標照常前進），重置後再轉交
        if self.quota_active(self.now) {
            let w = self.canonical_target("room", &rooms::member_window(member));
            let target = if w.is_empty() { self.unaddressed_window().unwrap_or_default() } else { w };
            if target.is_empty() || self.via_worker(&target) {
                return self.quota_hold_room(room, member, msg).await;
            }
        }
        // 順位延遲（#230）：同時被叫醒多位時，第 N 順位先排隊 (N-1) × 間隔；排隊（已存檔）就算處理完，游標照常前進
        if let Some(w) = rooms::wake_of(msg) {
            let delay = rooms::stagger_delay_ms(&w, self.cfg.room_stagger_ms);
            if delay > 0 {
                return self.hold_room_msg(room, member, msg, w, delay);
            }
        }
        // 收發室 worker 一輪只交一封：這一輪還沒結束就先留著（游標不前進，下一次拉信再來，順序不變）
        let w = self.canonical_target("room", &rooms::member_window(member));
        let target = if w.is_empty() { self.unaddressed_window().unwrap_or_default() } else { w };
        if !target.is_empty() && self.via_worker(&target) && !self.is_respond(&target) && self.fwd_busy(&format!("room #{}", json_u64(msg.get("seq")))) {
            return false;
        }
        self.deliver_room_msg(room, member, msg, 0, &[]).await
    }

    fn hold_room_msg(&mut self, room: &Value, member: &str, msg: &Value, wake: rooms::Wake, delay_ms: u64) -> bool {
        let room_id = room.get("id").and_then(Value::as_str).unwrap_or("").to_string();
        let seq = json_u64(msg.get("seq"));
        let id = rooms::room_uuid(&room_id, seq, member);
        if self.idx(&id).is_some() || self.held.contains(&room_id, seq, member) {
            return true;
        }
        let h = Held { room_id: room_id.clone(), room_name: room.get("name").and_then(Value::as_str).unwrap_or("").to_string(), member: member.to_string(), seq, due: self.now + delay_ms, delay_ms, wake: wake.clone(), fails: 0, held_at: 0 };
        match self.held.add(h) {
            Ok(_) => {
                self.log.line(&format!("room={room_id} #{seq} member={member} rank {}/{}: held {}s before handing", wake.rank, wake.total, delay_ms / 1000));
                true
            }
            Err(e) => {
                self.log.line(&format!("rooms held save failed: {e} (cursor not advanced)"));
                false
            }
        }
    }

    fn drop_held(&mut self, h: &Held, why: &str) {
        self.log.line(&format!("room={} #{} member={}: held entry dropped ({why})", h.room_id, h.seq, h.member));
        if let Err(e) = self.held.remove(&h.room_id, h.seq, &h.member) {
            self.log.line(&format!("rooms held save failed: {e}"));
        }
    }

    /// 到期的順位訊息：重讀群組（自該則之後），把延遲期間新到的訊息附上再轉交。轉交成功才移除；失敗退避 30 秒再試，連續 120 次放棄
    pub async fn release_held(&mut self, now: u64) {
        self.now = now;
        // 收發室 worker 額度扣住中：經過 worker 的項目先不轉交（額度扣住的由 quota_probe 一次一則試送）；
        // 其他引擎（Gemini、Codex 等）的視窗不經 worker，順位延遲到時間照常轉交
        let hold = self.quota_until > 0;
        // 額度扣住過的群組訊息（held_at > 0）恢復後馬上轉交，不看原本的到期時間；轉交失敗過（fails > 0）的照退避時間（due）再試
        let due: Vec<Held> = self.held.items().iter().filter(|h| (h.due <= now || (h.held_at > 0 && h.fails == 0)) && (!hold || (h.held_at == 0 && !self.room_item_via_worker(h)))).cloned().collect();
        let mut expired: Vec<Held> = vec![];
        for h in due {
            // 收發室 worker 一輪只交一封：這一輪還沒結束，經過 worker 的先不轉交（不算失敗，下一輪結束後的 tick 再來）
            if self.room_item_via_worker(&h) && self.fwd_busy(&format!("held room #{}", h.seq)) {
                continue;
            }
            self.release_held_item(&h, now, &mut expired).await;
        }
        if !expired.is_empty() {
            self.quota_room_summary(&expired);
        }
    }

    /// 轉交一則排隊中的群組訊息（超過額度保留期的放進 expired，由呼叫端發摘要）
    async fn release_held_item(&mut self, h: &Held, now: u64, expired: &mut Vec<Held>) -> RelOutcome {
        if self.idx(&rooms::room_uuid(&h.room_id, h.seq, &h.member)).is_some() {
            self.drop_held(h, "already handed");
            return RelOutcome::Gone;
        }
        // 額度扣住超過保留期：不轉交，恢復時改發一則摘要
        if h.held_at > 0 && now.saturating_sub(h.held_at) > self.cfg.late_keep_ms {
            self.drop_held(h, "quota hold over keep time: summarized");
            expired.push(h.clone());
            return RelOutcome::Gone;
        }
        if !self.roster_ok {
            return RelOutcome::Gone;
        }
        let window = rooms::member_window(&h.member);
        let as_agent = if window.is_empty() { String::new() } else { format!("&as_agent={}", crate::relay::encode_component(&window)) };
        let since = h.seq.saturating_sub(1);
        let res = self.relay.api(&format!("room_read&room={}{as_agent}&since={since}&limit=100", crate::relay::encode_component(&h.room_id)), None).await;
        let mut delivered = false;
        match res {
            Err(e) => self.log.line(&format!("held room_read failed room={} #{}: {e}", h.room_id, h.seq)),
            Ok(r) => {
                let mut msgs: Vec<Value> = r.get("messages").and_then(Value::as_array).cloned().unwrap_or_default();
                msgs.sort_by_key(|m| json_u64(m.get("seq")));
                let Some(orig) = msgs.iter().find(|m| json_u64(m.get("seq")) == h.seq).cloned() else {
                    self.drop_held(h, "message no longer readable");
                    return RelOutcome::Gone;
                };
                let extras: Vec<Value> = msgs.into_iter().filter(|m| json_u64(m.get("seq")) > h.seq && m.get("from").and_then(Value::as_str) != Some(h.member.as_str())).collect();
                let mut orig = orig;
                orig["wake"] = json!({ "rank": h.wake.rank, "total": h.wake.total, "before": h.wake.before });
                let room = json!({ "id": h.room_id, "name": h.room_name });
                self.late_from = (h.held_at > 0).then_some(h.held_at);
                delivered = self.deliver_room_msg(&room, &h.member, &orig, h.delay_ms.max(1), &extras).await;
                self.late_from = None;
            }
        }
        if delivered {
            if let Err(e) = self.held.remove(&h.room_id, h.seq, &h.member) {
                self.log.line(&format!("rooms held save failed: {e}"));
            }
        } else if h.fails + 1 >= 120 && !self.awaiting_return(&self.canonical_target("held", &rooms::member_window(&h.member))) {
            self.drop_held(h, "gave up after repeated failures");
            if h.held_at > 0 {
                expired.push(h.clone()); // 額度扣住的項目被放棄：改發群組摘要，不無聲丟掉
            }
        } else if let Err(e) = self.held.defer(&h.room_id, h.seq, &h.member, now + 30_000) {
            self.log.line(&format!("rooms held save failed: {e}"));
        }
        if delivered { RelOutcome::Delivered } else { RelOutcome::Failed }
    }

    /// 實際轉交一則群組訊息給視窗。waited_ms＞0＝這是依順位延遲後的轉交，附上 extras（延遲期間新到的訊息）。true＝處理完
    async fn deliver_room_msg(&mut self, room: &Value, member: &str, msg: &Value, waited_ms: u64, extras: &[Value]) -> bool {
        let room_id = room.get("id").and_then(Value::as_str).unwrap_or("").to_string();
        let room_name = room.get("name").and_then(Value::as_str).unwrap_or("").to_string();
        let seq = json_u64(msg.get("seq"));
        let late = self.late_from.take();
        // 成員代號（slug）也認：換成名單上的名字（Aegis；其他引擎原樣）
        let window = self.canonical_target(&format!("room:{seq}"), &rooms::member_window(member));
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
                // 重開後夥伴視窗還沒接回來：游標不前進，下一次拉信再來（等太久才略過）
                if self.awaiting_return(&window) {
                    if self.unrouted.insert(format!("room-wait:{room_id}:{seq}:{member}")) {
                        self.log.line(&format!("room={room_id} #{seq} window {window} not back yet after restart: kept (cursor not advanced)"));
                    }
                    return false;
                }
                self.log.line(&format!("room={room_id} #{seq} window {window} not forwardable: skipped{}", self.unreachable_note(&window)));
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
        // 自動回信的 worker 由橋代寄回答：不附「保持能回應」的提醒（與個人信同一個判斷）
        let pre_engine = if self.is_respond(&target) { "respond".to_string() } else { self.engine_of(&target) };
        let text = format!(
            "{}{}\n{}",
            rooms::room_text_waited(&room_name, msg, self.cfg.attach_cmd.as_deref(), waited_ms, &pre_engine),
            if note.is_empty() { String::new() } else { format!("\n{note}") },
            {
                let late = rooms::late_text(extras, waited_ms);
                let ctx = rooms::context_text(&room_id, &prev, self.cfg.room_cmd.as_deref());
                if late.is_empty() { ctx } else { format!("{ctx}\n{late}") }
            }
        );
        let text = match late {
            Some(t) => Self::with_late_line(text, t, self.hold_auth),
            None => text,
        };
        let text = self.with_path_line(text, &target);
        match self.deliver(&id, &target, &text) {
            Ok(_) => {
                self.log.line(&format!("handed room={room_id} #{seq} member={member} to={target}"));
                self.note_if_notice(&id, msg.get("body").and_then(Value::as_str).unwrap_or(""));
                if !self.is_respond(&target) && self.via_worker(&target) {
                    self.fwd_rooms.insert(id.clone(), RoomFwd { room_id: room_id.clone(), room_name: room_name.clone(), member: member.to_string(), seq, received_at: late.unwrap_or(self.now) });
                }
                let names: Vec<String> = attach::normalize(msg.get("attachments")).iter().map(|a| a.name.clone()).collect();
                let from = rooms::from_text(msg);
                self.corr_note(&target, Dir::Received, &format!("群組 {room_name} {from}"), &target, &id, msg.get("body").and_then(Value::as_str).unwrap_or(""), &names);
                if self.is_respond(&target) {
                    self.on_sent(&id).await; // 交給自己的 worker＝已轉交，開始等回覆
                }
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
        if let Some(e) = &self.engines {
            e.poll();
        }
        self.prune_inflight();
        self.release_held(now).await;
        self.quota_tick(now).await;
        self.flush_owner_receipts(now).await;
        self.wait_notice_tick(now).await;
        self.ack_retry_tick(now).await;
        self.selftest_tick(now).await;
        // 收信暫停的時間變了（開始扣住、或恢復）：馬上重報名單把值帶給後台（還沒報過第一次的交給啟動時的名單）
        if self.hold_sent.is_some_and(|h| h != self.inbox_hold_until() || self.hold_cap_due()) && now.saturating_sub(self.hold_try_at) >= self.cfg.watch_gap_ms {
            self.hold_try_at = now;
            self.refresh_roster(now).await;
        }
        // 自動回信：自己視窗的忙碌／閒置變了就立刻重報名單（防抖間隔同本機視窗監看）
        if self.cfg.respond.is_some() && self.respond_status() != self.respond_sent && now.saturating_sub(self.roster_at) >= self.cfg.watch_gap_ms {
            self.refresh_roster(now).await;
        }
        // 這一輪一直沒結束（模型卡住）：等到轉交逾時就當它結束，後面的信才不會永遠等；卡住的那封照原本的逾時流程通知
        if self.fwd_turn_open.is_some_and(|t| now.saturating_sub(t) > self.cfg.forward_timeout_ms) {
            self.end_fwd_turn("timeout");
        }
        let ids: Vec<String> = self.pending.iter().map(|p| p.id.clone()).collect();
        for id in ids {
            let Some(i) = self.idx(&id) else { continue };
            let p = self.pending[i].clone();
            if p.state == State::Forwarding && now.saturating_sub(p.t0) > self.cfg.forward_timeout_ms {
                // 額度扣住期間試送的那一封沒等到 worker 的任何回報：沒回應不是額度用完的證據（worker 可能卡死或壞了），
                // 所以不延長暫停。已經過了暫停時間才試送的，第一次沒回應就解除；還沒到的，連續第二次沒回應才解除。
                // 還沒解除時這封回到扣住（不寄逾時通知、不 ack、不記轉交逾時），一小時後再試；解除時走下面一般的逾時流程
                if self.probe_id.as_deref() == Some(id.as_str()) {
                    if self.quota_probe_miss("probe unanswered") {
                        // 已解除：這封走下面一般的逾時流程
                    } else {
                        self.quota_hold_forwarding();
                        self.persist();
                        continue;
                    }
                }
                self.pending[i].state = State::Done;
                self.parser.forget(&id);
                self.fwd_text.remove(&id);
                self.write_inflight();
                if p.room.is_some() {
                    self.log.line(&format!("room forward timeout id={id} -> {}", p.target));
                    self.room_forward_failed(&id, "room-timeout", true, "").await;
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
                // 登入失效通知附「轉交逾時 N 次」的佐證；無視窗橋沒有登入失效判定（login_watch 只在 gui 建置才有），不用記
                #[cfg(feature = "gui")]
                crate::login_watch::record_forward_timeout(now as i64);
                self.count_forward_fail("mail-timeout", &id, &p.target);
                if Self::is_mailbox_sender(&p.from_agent) {
                    self.log.line(&format!("forward timeout notice to mailbox sender not sent id={id}"));
                } else if self.bounce_notices.contains(&id) {
                    self.log.line(&format!("forward timeout notice not sent id={id}: the failed mail is itself a notice"));
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
            } else if p.state == State::Waiting && !p.nudged && !p.no_reply && p.room.is_none() && now.saturating_sub(p.t) > self.cfg.nudge_ms && !self.defers_ack(&p.target) && !self.is_respond(&p.target) {
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

#[cfg(test)]
mod payment_error_tests {
    use super::*;

    #[test]
    fn 真的_402_才算額度用完() {
        for why in ["HTTP 402", "API Error: 402 {\"error\":\"x\"}", "status 402", "status code 402", "402 Payment Required", "Payment Required", "balance exhausted", "request failed (402)", "402 {\"type\":\"error\"}"] {
            assert_eq!(Core::short_fail_reason(why), "額度用完了（API 402）", "{why}");
        }
    }

    #[test]
    fn 路徑或編號裡剛好有_402_不算() {
        for why in [
            r"想做不被允許的事：C:\Users\a\AppData\Local\Temp\.tmp402xyz\x.txt",
            "想做不被允許的事：/tmp/.tmpA402b/scratch/x.txt",
            "想做不被允許的事：/tmp/402 資料夾/x.txt",
            "想做不被允許的事：/tmp/a402 b/x.txt",
            "程序 14026 結束",
            "pid=402 結束",
            "程序 402 結束",
            "逾時 1402 毫秒",
        ] {
            assert_eq!(Core::short_fail_reason(why), why, "{why}");
        }
    }
}

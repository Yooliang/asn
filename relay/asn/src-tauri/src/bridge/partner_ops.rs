//! 遠端管理夥伴視窗（電腦端執行）：手機對話頁「⋯」選單下令，後台排進 `partner_op_pending`，這裡取走、在本機執行、回報 `partner_op_result`。
//! 設計與安全規則見 docs/design/PARTNER-OPS.md；外掛控制檔格式見該文件「外掛控制檔格式」一節。
//!
//! 動作：info（唯讀）、rename、model、close、handover（換班接手）、resume（喚醒：視窗已關，用同一個 sessionId 在原工作資料夾接回對話）。作業系統動作（讀命令列、列程序、結束、開視窗）全走
//! `launch/switch.rs` 的 `Os` 介面與 `OpsEnv`，測試用假實作，不會真的開視窗或結束程序。
//!
//! 守門（每條都有單元測試與還原驗證）：
//! 1. 只依 `~/.claude/sessions/<pid>.json` 對上名字與 sessionId 才動手，對不上回錯；
//! 2. 絕不用名稱或命令列字串去找程序（命令列只拿來確認「這個已確認的 pid 看起來是 claude」與讀它的啟動參數）；
//! 3. 使用者自己開的視窗（父殼不是 ASN 開的）只結束 claude 與子孫，留下終端機，不送關閉訊息；
//! 4. 除 info 外，本機設定「允許遠端開視窗」必須開著，執行前與動手前各驗一次；
//! 5. 收發室視窗與 ASN 自己的視窗、不是 claude 的程序一律不動；
//! 6. 每個操作都寫內建收發室 log 與該夥伴的往來記錄。
//! 喚醒另有四道守門：sessionId 格式不合就不碰任何檔案；已有活著的同名或同 sessionId 視窗不開；
//! 對話紀錄只比對檔名＝sessionId，工作資料夾必須在本機啟動設定的允許清單內；本機開關關著不開。


use super::core::BridgeLog;
use super::corrlog::{CorrLog, Dir, Entry};
use super::engines::acp_admin::AcpAdmin;
use super::roster;
use crate::launch::config::{canonical_launch_cwd, check_launch, child_env, expand_vars, valid_partner_name, LaunchConfig, LaunchReq};
use crate::launch::profiles::LaunchMode;
use crate::launch::console;
use crate::launch::switch::{self, Os, Plan, Proc, SwitchRunReq, Timing};
use crate::relay::Relay;
use serde_json::{json, Value};
use std::collections::HashSet;
use std::io::BufRead;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

const KNOWN_OPS: [&str; 8] = ["info", "rename", "model", "close", "handover", "resume", "restart", "remove"];
pub(crate) const DETAIL_MAX: usize = 500;
pub(crate) const RESULT_MAX_BYTES: usize = 4096;
pub(crate) const CONSENT_OFF: &str = "這台電腦沒有開啟「允許遠端開視窗與管理視窗」";
pub(crate) const HANDOFF_SUBDIR: &str = "交接";
/// ACP 工作者（收發室自己跑的背景工作者）只支援詳情、重開、換班接手；其他操作與 Claude 以外的夥伴一律回這句
pub(crate) const UNSUPPORTED: &str = "這類夥伴不支援這個操作";
const PROTECTED: &str = "ASN 通知與 ASN 自己的視窗不能操作";
/// pi 視窗的程序可能是哪個執行檔（npm 裝的 pi 由 node 跑；單檔版是 pi，也有人用 bun 跑）。關閉前登記的 pid 必須是其中之一
const PI_PROC_STEMS: [&str; 3] = ["node", "pi", "bun"];
const CHAIN_MAX: usize = 12;
/// 等外掛回報時，狀態檔一直讀到「寫到一半」多久以內不算外掛沒了（#472）
const TORN_READ_GRACE_MS: u64 = 2_000;

/// 請前任寫交接的信
pub(crate) fn ask_handoff_text(path: &Path) -> String {
    format!("要換手了：請把交接寫到 {}，寫完回覆『交接完成』。", path.display())
}

/// 換班接手的第一句話：先讀前任最後一段對話紀錄（從最後往前看）和交接檔；沒寫完交接就明說；使用者補了話換行附上「前任交代：…」
pub(crate) fn handover_prompt(name: &str, note: &str, transcript: Option<&Path>, handoff: &Path, complete: bool) -> String {
    let mut s = match transcript {
        Some(t) => format!("你是『{name}』的下一任，前任的上下文用完了。先讀前任最後一段對話紀錄 {}（從最後往前看）和交接檔 {}，接著把手上的工作做下去。", t.display(), handoff.display()),
        None => format!("你是『{name}』的下一任，前任的上下文用完了（找不到前任的對話紀錄檔）。先讀交接檔 {}，接著把手上的工作做下去。", handoff.display()),
    };
    if !complete {
        s.push_str("\n注意：前任沒有寫完交接，上面的交接檔可能不存在或不完整，請以對話紀錄為主。");
    }
    let note = note.trim();
    if !note.is_empty() {
        s.push_str("\n前任交代：");
        s.push_str(&note.chars().take(1000).collect::<String>());
    }
    s
}

/// 夥伴 ID（沒有就用視窗名）轉成資料夾名：只留英數、中文、- 與 _，其他一律換成 _，最長 60 字
/// 受保護的視窗：收發室、目前的 ASN 視窗名、ASN 自己的工作者程序（遠端管理不得關閉／清除）
pub(crate) fn is_protected(name: &str, pid: u32, mailbox: &str, asn_window: &str, worker_pid: u32) -> bool {
    name == mailbox || name == asn_window || (pid != 0 && pid == worker_pid)
}

fn safe_key(s: &str) -> String {
    let k: String = s.chars().map(|c| if c.is_alphanumeric() || c == '-' || c == '_' { c } else { '_' }).take(60).collect();
    if k.trim_matches('_').is_empty() { "partner".to_string() } else { k }
}

/// 交接檔位置：`<handoff>/交接/<夥伴ID或視窗名>/<yyyyMMdd-HHmmss>.md`。算出來的路徑一定在那個資料夾內，否則回 None
pub(crate) fn handoff_path(base: &Path, key: &str, now_ms: u64) -> Option<PathBuf> {
    let root = base.join(HANDOFF_SUBDIR);
    let p = root.join(safe_key(key)).join(format!("{}.md", super::corrlog::stamp_compact(now_ms)));
    let inside = p.starts_with(&root) && p.components().all(|c| !matches!(c, std::path::Component::ParentDir));
    inside.then_some(p)
}

/// 作業系統與本機設定這一側（測試換成假的）
pub(crate) trait OpsEnv: Send + Sync {
    fn os(&self) -> &dyn Os;
    /// 本機設定「允許遠端開視窗與管理視窗」現在是開的嗎（每次現讀，不快取）
    fn allow_remote(&self) -> bool;
    /// 開視窗（乾淨環境）
    fn launch(&self, plan: &Plan) -> Result<(), String>;
    fn now_ms(&self) -> u64;
    fn timing(&self) -> Timing;
    /// 等外掛回報的最長時間（外掛會排隊到視窗閒置才執行，預設 10 分鐘）
    fn mod_wait_ms(&self) -> u64;
    /// 狀態檔已過期的視窗：控制檔寫出後，外掛若完全沒有動靜（沒回報、狀態檔也沒更新），最多等這麼久就當外掛不在
    fn mod_probe_ms(&self) -> u64;
    /// 本機啟動設定（profile、工作資料夾允許清單）；每次現讀。喚醒用它決定能不能在原資料夾開、怎麼開
    fn launch_config(&self) -> Result<LaunchConfig, String>;
    /// 把一段話當成信送進某個視窗（換班接手時請前任寫交接）。失敗回原因
    fn tell(&self, name: &str, text: &str) -> Result<(), String>;
    /// 中途回報階段（只更新後台那筆的 detail，狀態仍是處理中）。失敗一律忽略（舊後台沒有這個動作）
    fn progress(&self, op_id: &str, detail: &str);
    /// 等前任寫完交接檔的最長時間與輪詢間隔
    fn handoff_wait_ms(&self) -> u64;
    fn handoff_poll_ms(&self) -> u64;
    /// pi 視窗的登記檔與控制檔所在的使用者家目錄（測試換成暫存資料夾）
    fn pi_home(&self) -> PathBuf {
        crate::identity::home_dir()
    }
    /// 等 pi 擴充回報「切換模型」結果的最長時間（pi 忙碌時擴充不處理，不要硬等太久）與等待一次
    fn pi_wait_ms(&self) -> u64 {
        15_000
    }
    fn pi_sleep(&self, ms: u64) {
        std::thread::sleep(std::time::Duration::from_millis(ms));
    }
    /// pi 的設定資料夾（對話檔在它底下的 sessions）：`PI_CODING_AGENT_DIR` 優先，否則 `~/.pi/agent`（測試換成暫存資料夾）
    fn pi_agent_dir(&self) -> PathBuf {
        crate::launch::pi_setup::agent_dir(std::env::var("PI_CODING_AGENT_DIR").ok().as_deref(), &crate::identity::home_dir())
    }
    /// 接手（0.2 A5）：用本機 pi 的啟動設定，在 cwd 用 --session 開一個由 ASN 管理的 pi。回外層視窗 PID（測試換成假的）
    fn launch_pi_session(&self, config: &LaunchConfig, name: &str, cwd: &str, session_file: &str) -> Result<u32, String> {
        crate::launch::local::start_pi_session(config, name, cwd, session_file)
    }
}

pub(crate) struct SystemOpsEnv {
    pub data_dir: PathBuf,
    pub relay: Arc<Relay>,
}

impl OpsEnv for SystemOpsEnv {
    fn os(&self) -> &dyn Os {
        &switch::RealOs
    }
    fn allow_remote(&self) -> bool {
        super::read_settings(&self.data_dir).allow_remote_launch
    }
    fn launch(&self, plan: &Plan) -> Result<(), String> {
        switch::real_launch(plan)
    }
    fn now_ms(&self) -> u64 {
        crate::heartbeat::now_ms()
    }
    fn timing(&self) -> Timing {
        Timing::real()
    }
    fn mod_wait_ms(&self) -> u64 {
        // 視窗忙碌時外掛會排隊等閒置：預設最多等 10 分鐘；環境變數 ASN_MOD_WAIT_MS（毫秒，1 秒到 1 小時）可調
        std::env::var("ASN_MOD_WAIT_MS").ok().and_then(|v| v.trim().parse::<u64>().ok()).filter(|v| (1_000..=3_600_000).contains(v)).unwrap_or(600_000)
    }
    fn mod_probe_ms(&self) -> u64 {
        15_000
    }
    fn launch_config(&self) -> Result<LaunchConfig, String> {
        use super::launcher::LaunchEnv;
        super::launcher::SystemEnv::new(self.data_dir.clone()).config(true)
    }
    fn tell(&self, name: &str, text: &str) -> Result<(), String> {
        // 走收發室既有的投遞：寄一封給自己這台電腦、指定那個視窗的信，橋收到後照一般來信轉進視窗
        let body = json!({ "to_node": self.relay.node, "to_agent": name, "body": text, "from_agent": self.relay.window_name(), "expects_reply": false });
        crate::rt::block_on(self.relay.api("send", Some(body))).map(|_| ())
    }
    fn progress(&self, op_id: &str, detail: &str) {
        let _ = crate::rt::block_on(self.relay.api("partner_op_progress", Some(json!({ "id": op_id, "detail": detail }))));
    }
    fn handoff_wait_ms(&self) -> u64 {
        10 * 60 * 1000
    }
    fn handoff_poll_ms(&self) -> u64 {
        2_000
    }
}

pub(crate) struct OpsDirs {
    /// ~/.claude/sessions
    pub sessions: PathBuf,
    /// ~/.asn/status（外掛寫）
    pub status: PathBuf,
    /// ~/.asn/control（橋寫、外掛讀）
    pub control: PathBuf,
    /// ~/.claude/projects（Claude 的對話紀錄；喚醒只讀、只比對檔名）
    pub projects: PathBuf,
}

/// 後台給的一筆待辦
#[derive(Clone, Debug)]
pub(crate) struct Op {
    pub id: String,
    pub name: String,
    pub op: String,
    pub new_name: String,
    pub model: String,
    pub session_id: String,
    pub note: String,
    pub by: String,
    pub by_label: String,
    pub created_at: String,
}

impl Op {
    fn parse(v: &Value) -> Op {
        let s = |k: &str| v.get(k).and_then(Value::as_str).unwrap_or("").trim().to_string();
        Op { id: s("id"), name: s("name"), op: s("op"), new_name: s("new_name"), model: s("model"), session_id: s("session_id"), note: s("note"), by: s("requested_by"), by_label: s("requested_by_label"), created_at: s("created_at") }
    }
    fn who(&self) -> String {
        let l = clean(&self.by_label, 40);
        if l.is_empty() { "手機".to_string() } else { l }
    }
    fn what(&self) -> String {
        match self.op.as_str() {
            "info" => "查看詳情".into(),
            "rename" => format!("改名為「{}」", clean(&self.new_name, 40)),
            "model" => format!("切換模型為 {}", clean(&self.model, 60)),
            "close" => "關閉視窗".into(),
            "handover" => "換班接手".into(),
            "resume" => "喚醒視窗".into(),
            "restart" => "重開".into(),
            o => format!("不認得的動作 {}", clean(o, 20)),
        }
    }
}

#[derive(Debug, Clone)]
pub(crate) struct OpResult {
    pub status: &'static str,
    pub detail: String,
    pub result: Option<Value>,
}

fn ok(detail: impl Into<String>, result: Option<Value>) -> OpResult {
    OpResult { status: "ok", detail: detail.into(), result }
}
/// 喚醒找不到對話紀錄（#593 拆成三句）
const NO_RECORD: &str = "找不到原本的對話紀錄，只能開新的夥伴";
const PI_NEVER_TALKED: &str = "這段對話還沒講過話，pi 沒有留下紀錄檔（pi 要等第一句話才會存檔），沒有東西可以接回；請開新的夥伴";
const PI_NO_AGENT_DIR: &str = "找不到 pi 的設定資料夾，沒辦法接回這段對話；如果 pi 的設定不在預設位置，請設定 PI_CODING_AGENT_DIR 後重開 ASN";

/// pi 的對話編號是 UUIDv7（第三段以 7 開頭）；Claude 用的是隨機的 v4
fn looks_like_pi_sid(sid: &str) -> bool {
    let p: Vec<&str> = sid.split('-').collect();
    sid.len() == 36 && p.iter().map(|x| x.len()).eq([8, 4, 4, 4, 12]) && p[2].starts_with('7') && sid.chars().all(|c| c == '-' || c.is_ascii_hexdigit())
}

fn failed(detail: impl Into<String>) -> OpResult {
    OpResult { status: "failed", detail: detail.into(), result: None }
}
fn unconfirmed(detail: impl Into<String>) -> OpResult {
    OpResult { status: "unconfirmed", detail: detail.into(), result: None }
}

/// 外掛回報的文字：保留換行（其他控制字元變空白）、去頭尾空白、截短
fn keep_text(s: &str, max: usize) -> String {
    s.replace("\r\n", "\n").chars().map(|c| if c == '\n' { c } else if c == '\r' { '\n' } else if c.is_control() { ' ' } else { c }).collect::<String>().replace("\n\n\n", "\n\n").trim().chars().take(max).collect()
}

/// 後台的模型欄位不收 `/`，所以畫面把「提供者/模型」寫成「提供者[模型]」送來；這裡還原。也接受直接帶斜線與只有模型
fn pi_model_spec(wire: &str) -> String {
    let w = wire.trim();
    if let Some((p, rest)) = w.split_once('[') {
        if let Some(m) = rest.strip_suffix(']') {
            if !p.is_empty() && !m.is_empty() && !m.contains(['[', ']']) {
                return format!("{p}/{m}");
            }
        }
    }
    w.to_string()
}

/// 等待時間的中文寫法（滿一分鐘用分鐘，否則秒）
fn wait_text(ms: u64) -> String {
    if ms >= 60_000 { format!("{} 分鐘", ms / 60_000) } else { format!("{} 秒", ms / 1000) }
}

enum Awaited {
    Got(bool, String),
    Lost,
    Timeout,
}

/// 外掛狀態檔對「控制用途」的判斷（不同於名單顯示的 30 分鐘新鮮度）
struct ModLive {
    status: Value,
    /// 狀態檔 `at` 在 30 分鐘內
    fresh: bool,
}

impl ModLive {
    /// 過期、且最後狀態是閒置：外掛只在狀態改變時才寫檔，閒置的視窗狀態檔本來就會老，
    /// 這種情況外掛多半還活著，但也可能是外掛已經沒了，所以要用短逾時探測；回探測起點的 `at`。
    /// 過期而最後狀態不是閒置（長時間忙碌）：外掛可能正在排隊，不能當它不在，照常等滿。
    fn probe_baseline(&self) -> Option<u64> {
        if self.fresh || self.status.get("state").and_then(Value::as_str) != Some("idle") {
            return None;
        }
        self.status.get("at").and_then(Value::as_u64)
    }
}

enum ModRes {
    Done(OpResult),
    Fallback,
}

/// 外掛回報文字的長度上限（/指令的輸出最多 1500 字）
pub(crate) const COMMAND_DETAIL_MAX: usize = 1500;

/// 去掉控制字元、截短（給 log、往來記錄、回報用）
fn clean(s: &str, max: usize) -> String {
    s.chars().map(|c| if c.is_control() { ' ' } else { c }).collect::<String>().trim().chars().take(max).collect()
}

/// 一封信裡的 /指令
#[derive(Clone, Debug)]
pub(crate) struct CommandJob {
    pub mail_id: String,
    pub window: String,
    pub command: String,
    pub args: String,
    /// 寄件人（回信對象）
    pub from_node: String,
    pub from_agent: String,
    /// 寄件人說明（給往來記錄看）
    pub sender: String,
    /// 回信用的寄件視窗名（收發室）
    pub reply_from: String,
}

pub(crate) struct PartnerOps {
    relay: Arc<Relay>,
    log: Arc<BridgeLog>,
    corr: CorrLog,
    handoff_dir: PathBuf,
    env: Arc<dyn OpsEnv>,
    dirs: OpsDirs,
    /// (視窗名, pid) 是收發室視窗或 ASN 自己的視窗就回 true
    protect: Arc<dyn Fn(&str, u32) -> bool + Send + Sync>,
    off: AtomicBool,
    warned: AtomicBool,
    seen: Mutex<HashSet<String>>,
    inflight: Mutex<HashSet<String>>,
    /// 從信件來的 /指令：信件編號 → 是否已做完（做完才可以重 ack；做到一半的信再看到不能再執行）
    cmds: Mutex<std::collections::HashMap<String, bool>>,
    /// 收發室管理的 ACP 工作者（沒載入 ACP 引擎＝None）
    acp: Mutex<Option<Arc<dyn AcpAdmin>>>,
    /// grok 的資料夾（~/.grok）：接手時只讀裡面的使用中對話登記與 sessions 的資料夾名稱。沒設＝不能接手
    grok_home: Mutex<Option<PathBuf>>,
}

impl PartnerOps {
    pub(crate) fn new(relay: Arc<Relay>, log: Arc<BridgeLog>, handoff_dir: PathBuf, env: Arc<dyn OpsEnv>, dirs: OpsDirs, protect: Arc<dyn Fn(&str, u32) -> bool + Send + Sync>) -> Arc<PartnerOps> {
        Arc::new(PartnerOps {
            relay,
            log,
            corr: CorrLog::new(handoff_dir.clone()),
            handoff_dir,
            env,
            dirs,
            protect,
            off: AtomicBool::new(false),
            warned: AtomicBool::new(false),
            seen: Mutex::new(HashSet::new()),
            inflight: Mutex::new(HashSet::new()),
            cmds: Mutex::new(std::collections::HashMap::new()),
            acp: Mutex::new(None),
            grok_home: Mutex::new(None),
        })
    }

    /// 真實環境版：收發室視窗名與 ASN 自己的 worker pid 受保護
    pub(crate) fn system(relay: Arc<Relay>, log: Arc<BridgeLog>, data_dir: PathBuf, handoff_dir: PathBuf, sessions_dir: PathBuf, status_dir: PathBuf, mailbox_name: String, worker_pid: Arc<dyn Fn() -> u32 + Send + Sync>) -> Arc<PartnerOps> {
        let control = status_dir.parent().map(|p| p.join("control")).unwrap_or_else(|| status_dir.join("control"));
        let projects = sessions_dir.parent().map(|p| p.join("projects")).unwrap_or_else(|| sessions_dir.join("projects"));
        let relay2 = relay.clone();
        let relay3 = relay.clone();
        // ASN 視窗名每次判斷時現讀（改名後立刻跟著換，不能啟動時抓一次就固定）
        let protect: Arc<dyn Fn(&str, u32) -> bool + Send + Sync> = Arc::new(move |name, pid| is_protected(name, pid, &mailbox_name, &relay.window_name(), worker_pid()));
        // sessions_dir＝<家>/.claude/sessions，grok 的資料夾在 <家>/.grok
        let grok_home = sessions_dir.parent().and_then(Path::parent).map(super::engines::grok_adopt::grok_home_of);
        let ops = PartnerOps::new(relay3, log, handoff_dir, Arc::new(SystemOpsEnv { data_dir, relay: relay2 }), OpsDirs { sessions: sessions_dir, status: status_dir, control, projects }, protect);
        if let Some(g) = grok_home {
            ops.set_grok_home(g);
        }
        ops
    }

    pub(crate) fn set_grok_home(&self, p: PathBuf) {
        *self.grok_home.lock().unwrap() = Some(p);
    }

    /// 後台回報的「視窗名 → 夥伴 ID」（往來記錄與交接檔資料夾都用它）
    pub(crate) fn set_partners(&self, m: std::collections::BTreeMap<String, String>) {
        self.corr.set_partners(m);
    }

    /// 接上 ACP 工作者的管理入口（引擎載入後呼叫）
    pub(crate) fn set_acp(&self, a: Arc<dyn AcpAdmin>) {
        *self.acp.lock().unwrap() = Some(a);
    }

    fn acp_admin(&self) -> Option<Arc<dyn AcpAdmin>> {
        self.acp.lock().unwrap().clone()
    }

    /// 名字對得上收發室管理的 ACP 工作者：只支援詳情、重開、換班接手、關閉（停止本次執行）、切換模型、移除、改名，其餘回「這類夥伴不支援」。
    /// 動的是工作者驅動記錄在案的 pid，不找程序、不比對名稱；同名的 Claude 視窗還活著時不猜
    fn execute_acp(&self, op: &Op, acp: &dyn AcpAdmin) -> OpResult {
        if (self.protect)(&op.name, 0) {
            return failed(PROTECTED);
        }
        let os = self.env.os();
        if console::read_sessions(&self.dirs.sessions).iter().any(|s| s.get("name").and_then(Value::as_str) == Some(op.name.as_str()) && s.get("pid").and_then(Value::as_u64).map(|p| p != 0 && os.alive(p as u32)).unwrap_or(false)) {
            return failed("有同名的 Claude 視窗，無法確定是哪一個，請先在電腦上處理");
        }
        match op.op.as_str() {
            "info" => match acp.info(&op.name) {
                Some(r) => ok("", Some(r)),
                None => failed("找不到這個工作者"),
            },
            "restart" | "handover" | "close" | "model" | "remove" | "rename" => {
                if op.op == "rename" {
                    return self.rename_acp(op, acp);
                }
                // 守門 4：動手前再驗一次本機開關
                if !self.env.allow_remote() {
                    return failed(CONSENT_OFF);
                }
                if op.op == "model" {
                    // 模型代號由工作者再比對可選清單（Grok：agent 列出的；agy：agy models），不在清單裡就拒絕
                    return match acp.set_model(&op.name, op.model.trim()) {
                        Ok(r) => {
                            let how = if r["restarted"] == json!(true) { "工作者帶同一段對話重開了，對話保留" } else { "沒有重開，對話保留" };
                            let keep = if r["saved"] == json!(false) { "；但沒能記下來，重開 ASN 後會回到原本的模型" } else { "" };
                            ok(&format!("已切換模型：{how}{keep}"), Some(r))
                        }
                        Err(e) => failed(e),
                    };
                }
                if op.op == "remove" {
                    self.stage(op, "closing");
                    return match acp.remove(&op.name) {
                        Ok(r) => ok("已移除：結束了工作者的程序，從名冊刪掉；工作資料夾的檔案留著", Some(r)),
                        Err(e) => failed(e),
                    };
                }
                if op.op == "close" {
                    self.stage(op, "closing");
                    return match acp.stop(&op.name) {
                        Ok(r) => ok("已結束工作者的程序，本次不再收信；名單上顯示「已停止」，按「重開」或重啟 ASN 後恢復（沒有改任何設定檔）", Some(r)),
                        Err(e) => failed(e),
                    };
                }
                if op.op == "restart" {
                    self.stage(op, "closing");
                    return match acp.restart(&op.name) {
                        Ok(r) => ok("已結束工作者的程序，ASN 會重新啟動它，對話保留", Some(r)),
                        Err(e) => failed(e),
                    };
                }
                self.stage(op, "closing");
                match acp.handover(&op.name, &op.note) {
                    Ok(r) => {
                        self.stage(op, "opening");
                        ok("已清掉前任的對話並重開；這類夥伴沒有請前任寫交接，新對話收到接班說明", Some(r))
                    }
                    Err(e) => failed(e),
                }
            }
            _ => failed(UNSUPPORTED),
        }
    }

    /// 內建通道工作者「改名」（B5，#266）：名字格式與撞名檢查同 pi 改名，但撞名不分大小寫，而且收發室與 ASN 自己的視窗名也算。
    /// 內建通道工作者之間（含名冊裡沒開起來的）的撞名、能不能改（設定檔裡的、沒對話的、已停止的）由工作者管理入口判斷
    fn rename_acp(&self, op: &Op, acp: &dyn AcpAdmin) -> OpResult {
        let new = op.new_name.trim();
        if !valid_partner_name(new) {
            return failed(super::engines::acp_admin::BAD_NAME);
        }
        if new.eq_ignore_ascii_case(&op.name) {
            return failed("新名字和現在的一樣");
        }
        // 守門 4：動手前再驗一次本機開關
        if !self.env.allow_remote() {
            return failed(CONSENT_OFF);
        }
        if self.name_taken_ci(new) {
            return failed("這台電腦已經有同名的視窗，換個名字");
        }
        self.stage(op, "closing");
        match acp.rename(&op.name, new) {
            Ok(r) => {
                self.stage(op, "opening");
                ok("已改名，對話保留", Some(r))
            }
            Err(e) => failed(e),
        }
    }

    /// 不分大小寫：這台電腦上有沒有這個名字的 Claude 視窗（活著的）、pi 視窗，或它是收發室／ASN 自己的視窗名
    fn name_taken_ci(&self, name: &str) -> bool {
        let os = self.env.os();
        let same = |n: Option<&str>| n.is_some_and(|n| n.eq_ignore_ascii_case(name));
        let claude = console::read_sessions(&self.dirs.sessions).iter().any(|s| same(s.get("name").and_then(Value::as_str)) && s.get("pid").and_then(Value::as_u64).map(|p| os.alive(p as u32)).unwrap_or(false));
        let pi_dir = super::engines::pi::windows_dir(&self.env.pi_home());
        let pi = super::engines::pi::read_windows(&pi_dir, self.env.now_ms(), |p| os.alive(p)).iter().any(|w| same(Some(w.name.as_str())));
        claude || pi || (self.protect)(name, 0) || name.ends_with("收發室")
    }

    /// 名單上有這個 pi 視窗（pi 擴充的登記檔，程序還活著），而且同名的 Claude 視窗不存在（同名時不猜，照 Claude 處理）
    fn is_pi_window(&self, name: &str) -> bool {
        let os = self.env.os();
        super::engines::pi_control::window_session_id(&self.env.pi_home(), name, self.env.now_ms(), |p| os.alive(p)).is_some() && self.find_target(name).is_err()
    }

    /// pi 視窗：開放「切換模型」「改名」（走擴充的控制檔管道，見 engines/pi_control.rs；pi 忙碌時排隊）與「關閉」
    fn execute_pi(&self, op: &Op) -> OpResult {
        if op.op == "close" {
            return self.close_pi(op);
        }
        if op.op == "rename" {
            return self.rename_pi(op);
        }
        if op.op != "model" {
            return failed("pi 視窗目前只能切換模型、改名和關閉，其他操作尚未開放");
        }
        let os = self.env.os();
        let env = super::engines::pi_control::SetModelEnv { now: &|| self.env.now_ms(), alive: &|p| os.alive(p), sleep: &|ms| self.env.pi_sleep(ms), wait_ms: self.env.pi_wait_ms(), poll_ms: 500 };
        match super::engines::pi_control::set_model(&self.env.pi_home(), &op.name, &pi_model_spec(&op.model), &env) {
            Ok(v) if v.get("queued").and_then(Value::as_bool) == Some(true) => ok(
                "pi 正在忙，已排隊：做完這一輪就會切換模型",
                Some(json!({ "engine": "pi", "queued": true, "model": v.get("model"), "provider": v.get("provider") })),
            ),
            Ok(v) => ok("已切換模型", Some(json!({ "engine": "pi", "model": v.get("model"), "provider": v.get("provider") }))),
            Err(e) => failed(e),
        }
    }

    /// pi 視窗「改名」（0.2 A4）：名字格式與 Claude 視窗同一套；這台電腦上已經有同名的（Claude 視窗、pi 視窗、內建通道的工作者）就拒絕。
    /// 實際改名由 pi 的 ASN 擴充做（pi.setSessionName＋記一筆「ASN 改過名」，重開後還在）；擴充太舊回「請更新擴充」
    fn rename_pi(&self, op: &Op) -> OpResult {
        let new = op.new_name.trim();
        if !valid_partner_name(new) {
            return failed("新名字只能用英數、連字號、中文，1～40 字，不能以連字號開頭");
        }
        if new == op.name {
            return failed("新名字和現在的一樣");
        }
        if !self.env.allow_remote() {
            return failed(CONSENT_OFF);
        }
        let os = self.env.os();
        let claude_taken = console::read_sessions(&self.dirs.sessions).iter().any(|s| s.get("name").and_then(Value::as_str) == Some(new) && s.get("pid").and_then(Value::as_u64).map(|p| os.alive(p as u32)).unwrap_or(false));
        let pi_taken = super::engines::pi_control::window_session_id(&self.env.pi_home(), new, self.env.now_ms(), |p| os.alive(p)).is_some();
        let acp_taken = self.acp_admin().is_some_and(|a| a.has_worker(new));
        if claude_taken || pi_taken || acp_taken {
            return failed("這台電腦已經有同名的視窗，換個名字");
        }
        let env = super::engines::pi_control::SetModelEnv { now: &|| self.env.now_ms(), alive: &|p| os.alive(p), sleep: &|ms| self.env.pi_sleep(ms), wait_ms: self.env.pi_wait_ms(), poll_ms: 500 };
        match super::engines::pi_control::set_name(&self.env.pi_home(), &op.name, new, &env) {
            Ok(v) if v.get("queued").and_then(Value::as_bool) == Some(true) => ok("pi 正在忙，已排隊：做完這一輪就會改名", Some(json!({ "engine": "pi", "queued": true, "new_name": new }))),
            Ok(_) => ok("已改名", Some(json!({ "engine": "pi", "new_name": new }))),
            Err(e) => failed(e),
        }
    }

    /// pi 視窗「關閉」（0.2 A2）：守門同 Claude 視窗——只結束 pi 擴充登記的那個 pi 程序與它的子孫，
    /// 永遠不碰 ASN 自己與它的祖先、不碰同輩程序；登記的 pid 現在跑的不是 pi（名單過期、pid 被重用）就不動。
    /// ASN 開的（有承載殼）先送關閉訊息、連殼一起收；使用者自己開的不送（會把整個終端機關掉），只結束 pi，留下終端機
    fn close_pi(&self, op: &Op) -> OpResult {
        if !self.env.allow_remote() {
            return failed(CONSENT_OFF);
        }
        let os = self.env.os();
        let dir = super::engines::pi::windows_dir(&self.env.pi_home());
        let Some(w) = super::engines::pi::read_windows(&dir, self.env.now_ms(), |p| os.alive(p)).into_iter().find(|w| w.name == op.name) else {
            return failed("找不到這個 pi 視窗（可能已經關了）");
        };
        if (self.protect)(&w.name, w.pid) {
            return failed(PROTECTED);
        }
        let table = os.processes();
        if !table.iter().any(|p| p.pid == w.pid && PI_PROC_STEMS.contains(&switch::exe_stem(&p.name).as_str())) {
            return failed("這個 pi 已經不在執行了（名單可能過期），所以沒有關閉");
        }
        // 身分核對（asn真 審 #433）：登記檔 5 分鐘內有心跳就算有效，pi 若在這段時間當掉、pid 又被別的 node 拿去用，
        // 只看程序名分不出來。程序的啟動時間一定要早於（或等於）最後一次心跳；查不到啟動時間也拒絕——寧可關不掉，也不要關錯
        if !os.started_ms(w.pid).is_some_and(|st| st <= w.updated_at) {
            return failed("這個 pi 已經不在執行了（程序跟登記的對不上），所以沒有關閉");
        }
        let host = switch::asn_host_of(os, &table, w.pid);
        let allowed = switch::kill_set_with(&table, w.pid, host, os.own_pid(), &|p| os.started_ms(p));
        if !allowed.contains(&w.pid) {
            return failed("守門：這個程序不允許結束");
        }
        self.stage(op, "closing");
        if let Err(e) = switch::close_session(os, &self.env.timing(), w.pid, &allowed, host, host.is_some()) {
            return failed(e);
        }
        let kept = host.is_none();
        ok(if kept { "已結束 pi；原本的終端機分頁會留下" } else { "已關閉視窗" }, Some(json!({ "engine": "pi", "pid": w.pid, "kept_terminal": kept })))
    }

    /// 接手使用者自己開的 pi（0.2 A5）。順序照 asn真 定的：先關舊的、確認真的結束，才帶 --session 開新的（原本的 pi 沒有 ASN 擴充，
    /// 不知道它是不是正在回覆；先開新的會有一段時間兩邊同時寫同一段對話）。
    /// 1. 找出它在用的對話（pi_adopt::resolve；不唯一、剛開還沒講話都拒絕）  2. 名字、資料夾白名單、上限照開新夥伴的檢查
    /// 3. 用 A2「關閉 pi」那套結束舊的（只結束那個 pi 與子孫，終端機留著）  4. 確認舊程序結束  5. 帶 --session 開新的  6. 等新的登記上名單。
    /// 第 5、6 步失敗：對話檔還在，照實回報「原本的 pi 已關閉，新的沒開起來」並附手動接回的指令
    fn execute_pi_adopt(&self, op: &Op, pid: u32) -> OpResult {
        use super::engines::pi_adopt as pa;
        if !self.env.allow_remote() {
            return failed(CONSENT_OFF);
        }
        let os = self.env.os();
        let table = os.processes();
        let Some(me) = table.iter().find(|p| p.pid == pid) else { return failed("這個 pi 已經不在執行了（名單可能過期），所以沒有接手") };
        let args = pa::split_cmdline(&os.cmdline(pid).unwrap_or_default());
        if !super::procscan::is_pi_process(&me.name, &args) {
            return failed("這個程序不是 pi（名單可能過期，或 pid 被別的程式用了），所以沒有接手");
        }
        let cwd = os.cwd(pid);
        // 同一個資料夾裡別的 pi（不含它自己）：有就無法確定是哪一段對話
        let others = table.iter().filter(|p| p.pid != pid && os.cwd(p.pid).is_some_and(|c| Some(&c) == cwd.as_ref()) && super::procscan::is_pi_process(&p.name, &pa::split_cmdline(&os.cmdline(p.pid).unwrap_or_default()))).count();
        let facts = pa::Facts { args: &args, cwd: cwd.as_deref(), started_ms: os.started_ms(pid), others_same_cwd: others };
        let files = pa::list_session_files(&pa::sessions_dir(&self.env.pi_agent_dir()));
        let found = match pa::resolve(&facts, &files, &pa::read_header) {
            Ok(f) => f,
            Err(e) => return failed(e),
        };
        // 名字與資料夾：照開新夥伴的檢查（白名單、名字規則、每小時上限）；同台已有同名的就拒絕
        let name = if op.new_name.trim().is_empty() { pa::default_name(&found.cwd) } else { op.new_name.trim().to_string() };
        if !valid_partner_name(&name) {
            return failed("新名字只能用英數、連字號、中文，1～40 字，不能以連字號開頭");
        }
        let config = match self.env.launch_config() {
            Ok(c) => c,
            Err(e) => return failed(format!("啟動設定不可用：{e}")),
        };
        if !config.profiles.contains_key("pi") {
            return failed("這台電腦的啟動設定裡沒有 pi，無法接手");
        }
        let mut req = LaunchReq { profile: "pi", name: &name, cwd: found.cwd.clone() };
        if let Err(e) = check_launch(&config, &mut req, &[], self.env.now_ms()) {
            return failed(e);
        }
        if self.name_taken_here(&name) {
            return failed("這台電腦已經有同名的視窗，換個名字");
        }
        // 3. 結束舊的（守門同 A2：程序要對得上、查不到啟動時間就不動）
        if (self.protect)(&op.name, pid) || os.started_ms(pid).is_none() {
            return failed("守門：這個程序不允許結束，所以沒有接手");
        }
        let host = switch::asn_host_of(os, &table, pid);
        let allowed = switch::kill_set_with(&table, pid, host, os.own_pid(), &|p| os.started_ms(p));
        if !allowed.contains(&pid) {
            return failed("守門：這個程序不允許結束，所以沒有接手");
        }
        self.stage(op, "closing");
        if let Err(e) = switch::close_session(os, &self.env.timing(), pid, &allowed, host, host.is_some()) {
            return failed(format!("原本的 pi 沒能關掉，沒有接手：{e}"));
        }
        // 4. 確認舊程序真的結束了，才開新的
        if os.alive(pid) {
            return failed("原本的 pi 還沒結束，為了不讓兩邊同時寫同一段對話，沒有開新的");
        }
        let manual = pa::manual_command(&found);
        let kept = host.is_none();
        // 5. 帶 --session 開新的
        self.stage(op, "opening");
        let session = crate::launch::local::strip_verbatim_prefix(&found.path.to_string_lossy());
        let new_pid = match self.env.launch_pi_session(&config, &name, &req.cwd, &session) {
            Ok(p) => p,
            Err(e) => return failed(format!("原本的 pi 已關閉，新的沒開起來（{e}）。對話檔還在，可以手動接回：{manual}")),
        };
        // 6. 等新的 pi 由 ASN 擴充登記上名單
        let home = self.env.pi_home();
        let appeared = switch::wait_until(os, self.env.timing().appear_wait_ms, self.env.timing().poll_ms, || {
            super::engines::pi_control::window_session_id(&home, &name, self.env.now_ms(), |p| os.alive(p)).is_some()
        });
        if !appeared {
            return failed(format!("原本的 pi 已關閉，新的 pi 開了但還沒出現在名單上（可能卡在啟動，或 ASN 的 pi 擴充沒載入）。對話檔還在，可以手動接回：{manual}"));
        }
        ok(
            if kept { "已接手：原本的 pi 已關閉（終端機留著），用同一段對話開了由 ASN 管理的 pi" } else { "已接手：用同一段對話開了由 ASN 管理的 pi" },
            Some(json!({ "kind": "pi_adopt", "name": name, "pid": new_pid, "old_pid": pid, "session_id": found.session_id, "kept_terminal": kept })),
        )
    }

    /// 這台電腦上有沒有這個名字的視窗（Claude 視窗、pi 視窗、內建通道工作者）
    fn name_taken_here(&self, name: &str) -> bool {
        let os = self.env.os();
        let claude = console::read_sessions(&self.dirs.sessions).iter().any(|s| s.get("name").and_then(Value::as_str) == Some(name) && s.get("pid").and_then(Value::as_u64).map(|p| os.alive(p as u32)).unwrap_or(false));
        let pi = super::engines::pi_control::window_session_id(&self.env.pi_home(), name, self.env.now_ms(), |p| os.alive(p)).is_some();
        claude || pi || self.acp_admin().is_some_and(|a| a.has_worker(name))
    }

    /// 接手使用者自己開的 grok：用名單上的 pid 查 grok 自己的使用中對話登記，唯一才採用，再讓專屬的 Grok 工作者載入同一段對話。
    /// 絕不結束、不操作那個 grok 程序（接手後請使用者自己先關掉）；只讀登記檔與 sessions 的資料夾名稱，不讀對話內容。
    fn execute_adopt(&self, op: &Op, pid: u32) -> OpResult {
        use super::engines::grok_adopt as ga;
        if !self.env.allow_remote() {
            return failed(CONSENT_OFF);
        }
        let os = self.env.os();
        // 那個 pid 現在還是一個 grok 程序（名單過期、pid 被別的程式重用都擋掉）
        if !os.processes().iter().any(|p| p.pid == pid && switch::exe_stem(&p.name) == "grok") {
            return failed("這個 grok 已經不在執行了（名單可能過期），所以沒有接手");
        }
        let Some(acp) = self.acp_admin() else { return failed("這台電腦的 ASN 沒有載入內建通道功能，無法接手") };
        let Some(home) = self.grok_home.lock().unwrap().clone() else { return failed("找不到 grok 的資料夾位置，無法接手") };
        let active = match ga::read_active(&home) {
            Ok(t) => t,
            Err(e) => return failed(e),
        };
        let found = match ga::resolve(&active, pid, &|sid| ga::session_dir_exists(&home, sid), os.started_ms(pid)) {
            Ok(f) => f,
            Err(e) => return failed(e),
        };
        self.stage(op, "opening");
        match acp.adopt(&found.session_id, &found.cwd) {
            Ok(r) => {
                let name = r.get("name").and_then(Value::as_str).unwrap_or("").to_string();
                let already = r.get("already").and_then(Value::as_bool) == Some(true);
                let detail = format!("{}專屬工作者「{name}」，之後寄給它的信會接在同一段對話後面。請先關掉終端機那個 grok（ASN 不會替你關），兩邊同時用同一段對話可能互相覆蓋", if already { "已經接手過了：" } else { "已開好" });
                ok(detail, Some(json!({ "kind": "adopt", "name": name, "already": already })))
            }
            Err(e) => failed(e),
        }
    }

    /// sessions/<pid>.json 的這一筆現在還有活著的程序，而且就是它當初記錄的那個（pid 被別的程序重用不算）
    fn session_live(&self, s: &Value) -> bool {
        let os = self.env.os();
        let Some(pid) = s.get("pid").and_then(Value::as_u64).and_then(|p| u32::try_from(p).ok()) else { return false };
        pid != 0 && os.alive(pid) && roster::same_process(s.get("startedAt").and_then(Value::as_u64).unwrap_or(0), os.started_ms(pid))
    }

    /// 剛結束的視窗留下的 sessions/<pid>.json 清掉：強制結束的 claude 來不及自己刪，檔案會一直留著，
    /// 日後 pid 被別的程序重用就會被當成活著的視窗。只刪「檔名 pid＝內容 pid＝剛結束的 pid、sessionId 相同、而且該 pid 已經不在」的那一個檔。
    fn forget_session(&self, t: &switch::Target) {
        if t.pid == 0 || self.env.os().alive(t.pid) {
            return;
        }
        let path = self.dirs.sessions.join(format!("{}.json", t.pid));
        let Ok(text) = std::fs::read_to_string(&path) else { return };
        let Ok(v) = serde_json::from_str::<Value>(&text) else { return };
        let same_sid = v.get("sessionId").and_then(Value::as_str).map(|x| x == t.session_id).unwrap_or(t.session_id.is_empty());
        if v.get("pid").and_then(Value::as_u64) == Some(t.pid as u64) && same_sid {
            let _ = std::fs::remove_file(&path);
        }
    }

    fn stage(&self, op: &Op, stage: &str) {
        self.env.progress(&op.id, &format!("stage:{stage}"));
    }

    // ---- 輪詢 ------------------------------------------------------------------------------------

    /// 取走待辦並逐筆交給背景執行（不擋住收信）。後台沒有這個動作（404／400）就靜默停用到下次啟動。
    pub(crate) async fn pull(self: &Arc<Self>) {
        if self.off.load(Ordering::Relaxed) {
            return;
        }
        let v = match self.relay.api("partner_op_pending", None).await {
            Ok(v) => v,
            Err(e) => {
                if crate::relay::set_name_unsupported(&e) {
                    self.off.store(true, Ordering::Relaxed);
                    self.log.line("partner_op_pending not supported by backend (remote partner ops off until restart)");
                } else if !self.warned.swap(true, Ordering::Relaxed) {
                    self.log.line(&format!("partner_op_pending failed: {e} (will keep trying quietly)"));
                }
                return;
            }
        };
        self.warned.store(false, Ordering::Relaxed);
        for o in v.get("ops").and_then(Value::as_array).cloned().unwrap_or_default() {
            self.begin(Op::parse(&o));
        }
    }

    fn begin(self: &Arc<Self>, op: Op) {
        if op.id.is_empty() || !self.seen.lock().unwrap().insert(op.id.clone()) {
            return;
        }
        let me = self.clone();
        tokio::spawn(async move {
            // 同一個視窗同時只處理一個操作
            let key = op.name.to_lowercase();
            if !me.inflight.lock().unwrap().insert(key.clone()) {
                let r = failed("這個視窗正在處理上一個操作，請稍後再試");
                me.finish(&op, r).await;
                return;
            }
            let (m2, o2) = (me.clone(), op.clone());
            let r = tokio::task::spawn_blocking(move || m2.execute(&o2)).await.unwrap_or_else(|e| failed(format!("背景工作失敗：{e}")));
            me.inflight.lock().unwrap().remove(&key);
            me.finish(&op, r).await;
        });
    }

    /// 寫 log、往來記錄，再回報後台
    async fn finish(&self, op: &Op, r: OpResult) {
        self.record(op, &r);
        let detail: String = r.detail.chars().take(DETAIL_MAX).collect();
        let mut body = json!({ "id": op.id, "status": r.status, "detail": detail });
        if let Some(res) = &r.result {
            body["result"] = res.clone();
        }
        if let Err(e) = self.relay.api("partner_op_result", Some(body)).await {
            self.log.line(&format!("partner_op_result failed id={}: {e}", op.id));
        }
    }

    /// 守門 6：內建收發室 log 與該夥伴的往來記錄（誰下的令、何時、做了什麼、結果）
    fn record(&self, op: &Op, r: &OpResult) {
        let what = op.what();
        let who = op.who();
        self.log.line(&format!("partner_op {} name={} op={} by={} -> {}{}", clean(&op.id, 40), clean(&op.name, 40), clean(&op.op, 20), who, r.status, if r.detail.is_empty() { String::new() } else { format!(" ({})", clean(&r.detail, 120)) }));
        let label = match r.status {
            "ok" => "成功",
            "unconfirmed" => "未確認",
            _ => "失敗",
        };
        let body = format!("下令：{who}（{}）\n動作：{what}\n結果：{label}{}", if op.created_at.is_empty() { "時間不明".to_string() } else { clean(&op.created_at, 40) }, if r.detail.is_empty() { String::new() } else { format!("，{}", clean(&r.detail, 200)) });
        let id = clean(&op.id, 40);
        if let Err(e) = self.corr.append(&op.name, &Entry { ts_ms: self.env.now_ms(), dir: Dir::Op, from: &who, to: &op.name, id: &id, body: &body, attachments: &[] }) {
            self.log.line(&format!("corr log failed window={}: {e}", clean(&op.name, 40)));
        }
    }

    // ---- 執行（會等待，放在背景執行緒）------------------------------------------------------------

    pub(crate) fn execute(&self, op: &Op) -> OpResult {
        if !KNOWN_OPS.contains(&op.op.as_str()) {
            return failed(format!("這個版本的 ASN 不認得「{}」這個動作", clean(&op.op, 20)));
        }
        if op.name.is_empty() {
            return failed("缺少視窗名字");
        }
        if op.op != "info" && !self.env.allow_remote() {
            return failed(CONSENT_OFF);
        }
        // 使用者自己在終端機開的 grok（名單上的「grok #pid（前景）」）：「換班接手」在這裡的意思是「接手」
        if op.op == "handover" {
            if let Some(pid) = super::engines::pi_adopt::proc_pid(&op.name) {
                return self.execute_pi_adopt(op, pid);
            }
            if let Some(pid) = super::engines::grok_adopt::proc_pid(&op.name) {
                return self.execute_adopt(op, pid);
            }
        }
        if let Some(acp) = self.acp_admin().filter(|a| a.has_worker(&op.name)) {
            return self.execute_acp(op, &*acp);
        }
        if self.is_pi_window(&op.name) {
            return self.execute_pi(op);
        }
        if op.op == "restart" || op.op == "remove" {
            return failed(UNSUPPORTED);
        }
        if op.op == "resume" {
            return self.resume(op);
        }
        let target = match self.find_target(&op.name) {
            Ok(t) => t,
            Err(e) => return failed(e),
        };
        match op.op.as_str() {
            "info" => self.info(&target),
            "close" => self.close(&target),
            "rename" => self.rename(op, target),
            "model" => self.model(op, target),
            _ => self.handover(op, target),
        }
    }

    /// 守門 1、2、5：只靠 sessions/<pid>.json 的名字找出唯一一個活著的互動式視窗，再用「名字＋sessionId＋pid」重新確認。
    /// 命令列只在確認過的 pid 上讀（看是不是 claude、取啟動參數），絕不拿來找程序。
    fn find_target(&self, name: &str) -> Result<switch::Target, String> {
        let os = self.env.os();
        let sessions = console::read_sessions(&self.dirs.sessions);
        let hits: Vec<(u32, String)> = sessions
            .iter()
            .filter(|s| s.get("name").and_then(Value::as_str) == Some(name))
            .filter(|s| s.get("kind").and_then(Value::as_str).map(|k| k == "interactive").unwrap_or(true))
            .filter(|s| self.session_live(s))
            .filter_map(|s| Some((u32::try_from(s.get("pid").and_then(Value::as_u64)?).ok()?, s.get("sessionId").and_then(Value::as_str).unwrap_or("").to_string())))
            .filter(|(p, _)| *p != 0 && os.alive(*p))
            .collect();
        if hits.iter().any(|(p, _)| (self.protect)(name, *p)) || (self.protect)(name, 0) {
            return Err(PROTECTED.into());
        }
        match hits.len() {
            0 => Err("找不到這個夥伴的 Claude 視窗（可能已經關了）".into()),
            1 => switch::resolve(os, &self.dirs.sessions, name, Some((hits[0].0, &hits[0].1))),
            _ => Err("有不只一個同名的視窗，無法確定是哪一個，請先在電腦上處理".into()),
        }
    }

    /// 動手前的共同檢查：重新確認目標還是同一個、還允許遠端管理，回（承載殼、可結束清單、是否在 WT 分頁）
    fn guard(&self, t: &switch::Target) -> Result<(Option<u32>, Vec<u32>, bool), String> {
        let os = self.env.os();
        if !self.env.allow_remote() {
            return Err(CONSENT_OFF.into());
        }
        if (self.protect)(&t.name, t.pid) {
            return Err(PROTECTED.into());
        }
        let table = os.processes();
        let host = switch::asn_host_of(os, &table, t.pid);
        let allowed = switch::kill_set_with(&table, t.pid, host, os.own_pid(), &|p| os.started_ms(p));
        if !allowed.contains(&t.pid) {
            return Err("守門：這個程序不允許結束".into());
        }
        Ok((host, allowed, switch::in_windows_terminal(&table, t.pid)))
    }

    /// sessionId 目前對到的程序（名單上的工作階段檔）
    fn session_pid(&self, sid: &str) -> Option<u32> {
        console::read_sessions(&self.dirs.sessions).iter().find(|s| s.get("sessionId").and_then(Value::as_str) == Some(sid)).and_then(|s| s.get("pid").and_then(Value::as_u64)).and_then(|p| u32::try_from(p).ok())
    }

    fn session_rec(&self, pid: u32) -> Option<Value> {
        console::read_sessions(&self.dirs.sessions).into_iter().find(|s| s.get("pid").and_then(Value::as_u64) == Some(pid as u64))
    }

    // ---- 外掛狀態檔與控制檔 -----------------------------------------------------------------------

    /// 外掛寫的狀態檔（有效才回）：存在、完整 JSON、sessionId 相符、沒過期、不是「已結束」
    fn mod_status(&self, sid: &str) -> Option<Value> {
        if !roster::valid_sid(sid) {
            return None;
        }
        let path = self.dirs.status.join(format!("{sid}.json"));
        if std::fs::metadata(&path).ok()?.len() > 16 * 1024 {
            return None;
        }
        let v: Value = serde_json::from_str(&std::fs::read_to_string(&path).ok()?).ok()?;
        if v.get("sessionId").and_then(Value::as_str) != Some(sid) {
            return None;
        }
        let at = v.get("at").and_then(Value::as_u64)?;
        if self.env.now_ms().abs_diff(at) > roster::MOD_STATUS_MAX_AGE_MS {
            return None;
        }
        if v.get("detail").and_then(Value::as_str).map(str::trim) == Some(roster::MOD_ENDED_DETAIL) {
            return None;
        }
        Some(v)
    }

    /// 控制用途的外掛判斷：狀態檔存在、完整、sessionId 相符、沒標結束；新鮮度不設限，
    /// 但過期的必須該視窗的程序還活著（pid 為 0 或已死＝不算）。
    fn mod_live(&self, sid: &str, pid: u32) -> Option<ModLive> {
        if !roster::valid_sid(sid) {
            return None;
        }
        let path = self.dirs.status.join(format!("{sid}.json"));
        if std::fs::metadata(&path).ok()?.len() > 16 * 1024 {
            return None;
        }
        let v: Value = serde_json::from_str(&std::fs::read_to_string(&path).ok()?).ok()?;
        if v.get("sessionId").and_then(Value::as_str) != Some(sid) {
            return None;
        }
        let at = v.get("at").and_then(Value::as_u64)?;
        if v.get("detail").and_then(Value::as_str).map(str::trim) == Some(roster::MOD_ENDED_DETAIL) {
            return None;
        }
        let fresh = self.env.now_ms().abs_diff(at) <= roster::MOD_STATUS_MAX_AGE_MS;
        if !fresh && (pid == 0 || !self.env.os().alive(pid)) {
            return None;
        }
        Some(ModLive { status: v, fresh })
    }

    /// 寫好控制檔後等外掛回報。視窗忙碌時外掛會排隊到閒置才執行，所以最多等 `mod_wait_ms`（預設 10 分鐘）。
    /// 等的期間狀態檔變無效（過期、已結束）＝外掛真的沒了（Lost）；到時間還沒回報＝Timeout。
    /// `on_slow` 在等了一小段時間（約 2 秒）還沒回報時呼叫一次（回報「排隊中」用）。結束後一律刪掉控制檔。
    fn await_control(&self, sid: &str, pid: u32, id: &str, probe_at: Option<u64>, on_slow: &mut dyn FnMut()) -> Awaited {
        let file = self.dirs.control.join(format!("{sid}.json"));
        let mut res: Option<Awaited> = None;
        let mut polls = 0u32;
        // 探測中（狀態檔已過期的閒置視窗）：外掛有任何動靜（狀態檔 at 變了）就解除探測，照常等；一直沒動靜到時間就當外掛不在
        let mut probing = probe_at;
        let t0 = std::time::Instant::now();
        let probe_ms = self.env.mod_probe_ms();
        // 外掛寫狀態檔不一定是原子的：剛好讀到寫到一半（空檔、JSON 不完整）時先當作「正在寫」，下一輪再讀；
        // 一直是半份超過 TORN_READ_GRACE_MS 才算外掛沒了（#472：全套平行跑時這個時間差被放大，誤判成 Lost）
        let mut torn_since: Option<std::time::Instant> = None;
        switch::wait_until(self.env.os(), self.env.mod_wait_ms(), 500, || {
            let Some(live) = self.mod_live(sid, pid) else {
                if self.status_torn(sid) && torn_since.get_or_insert_with(std::time::Instant::now).elapsed() < std::time::Duration::from_millis(TORN_READ_GRACE_MS) {
                    return false;
                }
                res = Some(Awaited::Lost);
                return true;
            };
            torn_since = None;
            let st = live.status;
            if let Some(c) = st.get("control").filter(|c| c.get("id").and_then(Value::as_str) == Some(id)) {
                let detail = keep_text(c.get("detail").and_then(Value::as_str).unwrap_or(""), COMMAND_DETAIL_MAX);
                res = Some(Awaited::Got(c.get("ok").and_then(Value::as_bool).unwrap_or(false), detail));
                return true;
            }
            if let Some(at0) = probing {
                if st.get("at").and_then(Value::as_u64) != Some(at0) {
                    probing = None;
                } else if t0.elapsed() >= std::time::Duration::from_millis(probe_ms) {
                    res = Some(Awaited::Lost);
                    return true;
                }
            }
            polls += 1;
            if polls == 4 {
                on_slow();
            }
            false
        });
        // 不論結果都收掉控制檔：之後新視窗的外掛不能再執行一次舊指令
        let _ = std::fs::remove_file(&file);
        res.unwrap_or(Awaited::Timeout)
    }

    /// 狀態檔看起來是「寫到一半」：檔案在，但內容是空的或不是完整的 JSON（讀檔失敗也算，Windows 上外掛正在寫時可能被鎖住）
    fn status_torn(&self, sid: &str) -> bool {
        if !roster::valid_sid(sid) {
            return false;
        }
        let path = self.dirs.status.join(format!("{sid}.json"));
        match std::fs::read_to_string(&path) {
            Ok(s) => serde_json::from_str::<Value>(&s).is_err(),
            Err(_) => path.exists(),
        }
    }

    fn write_control(&self, sid: &str, body: &Value) -> bool {
        crate::write_atomic(&self.dirs.control.join(format!("{sid}.json")), &body.to_string()).is_ok()
    }

    /// 有外掛的視窗（改名、切換模型）：寫控制檔，等外掛在狀態檔回報 control:{id, ok, detail}，視窗忙碌就排隊等（回報 stage:queued）。
    /// Fallback＝沒外掛或外掛真的沒回應，呼叫端退回重開；其餘都由外掛處理完（成功、明確失敗、等太久還在忙）。
    fn via_mod(&self, op: &Op, t: &switch::Target, arg: &str) -> ModRes {
        let Some(live) = self.mod_live(&t.session_id, t.pid) else {
            return ModRes::Fallback;
        };
        let body = json!({ "id": op.id, "op": op.op, "arg": arg, "at": self.env.now_ms() });
        if !self.write_control(&t.session_id, &body) {
            return ModRes::Fallback;
        }
        match self.await_control(&t.session_id, t.pid, &op.id, live.probe_baseline(), &mut || self.stage(op, "queued")) {
            Awaited::Lost => ModRes::Fallback,
            Awaited::Timeout => ModRes::Done(failed(format!("等了 {} 視窗還在忙，沒有{}", wait_text(self.env.mod_wait_ms()), if op.op == "rename" { "改名" } else { "切換模型" }))),
            Awaited::Got(good, detail) => ModRes::Done(if good {
                ok(if detail.is_empty() { "已由視窗內的外掛完成".to_string() } else { clean(&detail, 200) }, Some(json!({ "pid": t.pid, "via": "mod" })))
            } else {
                failed(if detail.is_empty() { "視窗內的外掛回報失敗".to_string() } else { clean(&detail, 200) })
            }),
        }
    }

    // ---- 信件來的 /指令 ---------------------------------------------------------------------------

    /// 這個視窗現在能不能收 /指令：只有「名單上唯一一個活著的互動式 Claude 視窗，而且有有效的外掛狀態檔」才回它的 sessionId。
    /// 收發室視窗與 ASN 自己的視窗一律不行。
    pub(crate) fn command_target(&self, name: &str) -> Option<String> {
        let os = self.env.os();
        let hits: Vec<(u32, String)> = console::read_sessions(&self.dirs.sessions)
            .iter()
            .filter(|s| s.get("name").and_then(Value::as_str) == Some(name))
            .filter(|s| s.get("kind").and_then(Value::as_str).map(|k| k == "interactive").unwrap_or(true))
            .filter(|s| self.session_live(s))
            .filter_map(|s| Some((u32::try_from(s.get("pid").and_then(Value::as_u64)?).ok()?, s.get("sessionId").and_then(Value::as_str).unwrap_or("").to_string())))
            .filter(|(p, _)| *p != 0 && os.alive(*p))
            .collect();
        if hits.len() != 1 || (self.protect)(name, hits[0].0) || (self.protect)(name, 0) {
            return None;
        }
        let sid = hits[0].1.clone();
        self.mod_live(&sid, hits[0].0).map(|_| sid)
    }

    /// 這封信的 /指令處理到哪：None＝還沒開始；Some(false)＝進行中；Some(true)＝做完了
    pub(crate) fn command_state(&self, mail_id: &str) -> Option<bool> {
        self.cmds.lock().unwrap().get(mail_id).copied()
    }

    /// 把 /指令交給視窗的外掛，放背景執行（不擋收信）：做完回信給寄件人（只告知）、寫往來記錄與 log，最後 ack 原信
    pub(crate) fn start_command(self: &Arc<Self>, job: CommandJob, sid: String) {
        {
            let mut c = self.cmds.lock().unwrap();
            if c.len() > 2000 {
                c.retain(|_, done| !*done);
            }
            c.insert(job.mail_id.clone(), false);
        }
        let me = self.clone();
        tokio::spawn(async move {
            let (m2, j2) = (me.clone(), job.clone());
            let (good, text) = tokio::task::spawn_blocking(move || m2.command_blocking(&j2, &sid)).await.unwrap_or_else(|e| (false, format!("沒執行 /{}：背景工作失敗：{e}", job.command)));
            me.record_command(&job, good, &text);
            let mut b = json!({ "to_node": job.from_node, "body": text, "reply_to": job.mail_id, "from_agent": job.reply_from, "expects_reply": false });
            if !job.from_agent.is_empty() {
                b["to_agent"] = json!(job.from_agent);
            }
            if let Err(e) = me.relay.api("send", Some(b)).await {
                me.log.line(&format!("slash command reply failed id={}: {e}", job.mail_id));
            }
            match me.relay.api("ack", Some(json!({ "ids": [job.mail_id] }))).await {
                Ok(_) => {
                    me.cmds.lock().unwrap().insert(job.mail_id.clone(), true);
                }
                Err(e) => {
                    // 沒 ack 成功：標成做完，下次再看到這封信時由橋重 ack，絕不再執行一次
                    me.log.line(&format!("slash command ack failed id={}: {e}", job.mail_id));
                    me.cmds.lock().unwrap().insert(job.mail_id.clone(), true);
                }
            }
        });
    }

    /// 等同一個視窗前面的操作做完（控制檔一次只放一筆），再寫控制檔、等外掛回報。回要寄給寄件人的內文
    fn command_blocking(&self, job: &CommandJob, sid: &str) -> (bool, String) {
        let cmd = format!("/{}", job.command);
        let key = job.window.to_lowercase();
        let got_turn = switch::wait_until(self.env.os(), self.env.mod_wait_ms(), 500, || self.inflight.lock().unwrap().insert(key.clone()));
        if !got_turn {
            return (false, format!("等了 {} 視窗還在忙，沒執行 {cmd}", wait_text(self.env.mod_wait_ms())));
        }
        let text = self.command_turn(job, sid, &cmd);
        self.inflight.lock().unwrap().remove(&key);
        text
    }

    fn command_turn(&self, job: &CommandJob, sid: &str, cmd: &str) -> (bool, String) {
        // 輪到的時候視窗還得是同一個、外掛還在
        if self.command_target(&job.window).as_deref() != Some(sid) {
            return (false, format!("沒執行 {cmd}：視窗已經關了、換了，或外掛沒有回報"));
        }
        let body = json!({ "id": job.mail_id, "op": "command", "command": job.command, "args": job.args, "at": self.env.now_ms() });
        if !self.write_control(sid, &body) {
            return (false, format!("沒執行 {cmd}：寫不出控制檔"));
        }
        let probe = self.session_pid(sid).and_then(|pid| self.mod_live(sid, pid)).and_then(|l| l.probe_baseline());
        let pid = self.session_pid(sid).unwrap_or(0);
        match self.await_control(sid, pid, &job.mail_id, probe, &mut || {}) {
            Awaited::Got(true, d) => (true, if d.is_empty() { format!("已執行 {cmd}") } else { d }),
            Awaited::Got(false, d) => (false, format!("沒執行 {cmd}：{}", if d.is_empty() { "視窗的外掛回報失敗".to_string() } else { d })),
            Awaited::Lost => (false, format!("沒執行 {cmd}：視窗的外掛已經沒有回應")),
            Awaited::Timeout => (false, format!("等了 {} 視窗還在忙，沒執行 {cmd}", wait_text(self.env.mod_wait_ms()))),
        }
    }

    /// 往來記錄與 log（照 record 的風格）：誰、何時、什麼指令、結果
    fn record_command(&self, job: &CommandJob, ok_: bool, result: &str) {
        self.log.line(&format!("slash_command id={} window={} command={} args_len={} by={} -> {}{}", clean(&job.mail_id, 40), clean(&job.window, 40), clean(&job.command, 64), job.args.chars().count(), clean(&job.sender, 40), if ok_ { "ok" } else { "failed" }, if ok_ { String::new() } else { format!(" ({})", clean(result, 120)) }));
        let body = format!("下令：{}（從信件傳來的 /指令）
動作：/{}{}
結果：{}
{}", clean(&job.sender, 40), clean(&job.command, 64), if job.args.is_empty() { String::new() } else { format!(" {}", clean(&job.args, 200)) }, if ok_ { "成功" } else { "失敗" }, keep_text(result, COMMAND_DETAIL_MAX));
        if let Err(e) = self.corr.append(&job.window, &Entry { ts_ms: self.env.now_ms(), dir: Dir::Op, from: &job.sender, to: &job.window, id: &clean(&job.mail_id, 40), body: &body, attachments: &[] }) {
            self.log.line(&format!("corr log failed window={}: {e}", clean(&job.window, 40)));
        }
    }

    // ---- info ------------------------------------------------------------------------------------

    fn info(&self, t: &switch::Target) -> OpResult {
        let os = self.env.os();
        let table = os.processes();
        let host = switch::asn_host_of(os, &table, t.pid);
        let st = self.mod_status(&t.session_id);
        let model = st.as_ref().and_then(|s| s.get("model")).and_then(Value::as_str).filter(|m| switch::valid_model(m)).map(String::from).or_else(|| switch::current_model(&t.args));
        let mut chain: Vec<String> = switch::ancestors(&table, t.pid).into_iter().rev().filter_map(|p| table.iter().find(|x| x.pid == p)).map(|p| clean(&p.name, 60)).collect();
        chain.push(table.iter().find(|p| p.pid == t.pid).map(|p| clean(&p.name, 60)).unwrap_or_else(|| "claude".into()));
        if chain.len() > CHAIN_MAX {
            chain = chain.split_off(chain.len() - CHAIN_MAX);
        }
        let started = self.session_rec(t.pid).and_then(|s| s.get("startedAt").cloned()).unwrap_or(Value::Null);
        let mut r = json!({
            "pid": t.pid,
            "model": model,
            "engine": "claude",
            "cwd": clean(&t.cwd, 300),
            "started_at": started,
            "status": t.status,
            "opened_by": if host.is_some() { "asn" } else { "user" },
            "shell_chain": chain,
            "mod_installed": st.is_some(),
        });
        if let Some(c) = st.as_ref().and_then(|s| s.get("context")).and_then(Value::as_object) {
            // 只收三個數字欄位：used、limit、percent（沒給 percent 且有 limit 就算出來）
            let num = |k: &str| c.get(k).and_then(Value::as_f64).filter(|n| n.is_finite() && *n >= 0.0);
            let (used, limit) = (num("used"), num("limit"));
            let percent = num("percent").or_else(|| used.zip(limit).filter(|(_, l)| *l > 0.0).map(|(u, l)| (u / l * 100.0).round()));
            let mut ctx = serde_json::Map::new();
            for (k, v) in [("used", used), ("limit", limit), ("percent", percent)] {
                if let Some(v) = v {
                    ctx.insert(k.into(), if v.fract() == 0.0 { json!(v as u64) } else { json!(v) });
                }
            }
            if !ctx.is_empty() {
                r["context"] = Value::Object(ctx);
            }
        }
        if r.to_string().len() > RESULT_MAX_BYTES {
            r["shell_chain"] = json!([]);
            r.as_object_mut().map(|o| o.remove("context"));
        }
        ok("", Some(r))
    }

    // ---- close -----------------------------------------------------------------------------------

    fn close(&self, t: &switch::Target) -> OpResult {
        let (host, allowed, _) = match self.guard(t) {
            Ok(g) => g,
            Err(e) => return failed(e),
        };
        // 守門 3：使用者自己開的視窗（沒有 ASN 承載殼）不送關閉訊息，只結束 claude 與子孫，留下終端機
        if let Err(e) = switch::close_session(self.env.os(), &self.env.timing(), t.pid, &allowed, host, host.is_some()) {
            return failed(e);
        }
        self.forget_session(t);
        let kept = host.is_none();
        ok(if kept { "已結束 Claude；原本的終端機分頁會留下" } else { "已關閉視窗" }, Some(json!({ "pid": t.pid, "kept_terminal": kept })))
    }

    // ---- 重開（改名退路、轉交）-------------------------------------------------------------------

    /// 關掉目標、照 `argv` 開新視窗、等同名的新視窗出現。new_sid_required＝新視窗的 sessionId 必須和舊的不同（轉交）
    fn reopen(&self, op: Option<&Op>, t: &switch::Target, new_name: &str, argv: Vec<String>, new_sid_required: bool) -> OpResult {
        let os = self.env.os();
        let (host, allowed, in_wt) = match self.guard(t) {
            Ok(g) => g,
            Err(e) => return failed(e),
        };
        let plan = match switch::plan_for(t, new_name, argv, in_wt) {
            Ok(p) => p,
            Err(e) => return failed(e),
        };
        let old_pids: HashSet<u32> = console::read_sessions(&self.dirs.sessions)
            .iter()
            .filter(|s| matches!(s.get("name").and_then(Value::as_str), Some(n) if n == t.name || n == new_name))
            .filter_map(|s| s.get("pid").and_then(Value::as_u64).map(|p| p as u32))
            .collect();
        if let Some(o) = op {
            self.stage(o, "closing");
        }
        if let Err(e) = switch::close_session(os, &self.env.timing(), t.pid, &allowed, host, host.is_some()) {
            return failed(e);
        }
        self.forget_session(t);
        if let Some(o) = op {
            self.stage(o, "opening");
        }
        if let Err(e) = self.env.launch(&plan) {
            return failed(format!("原視窗已關閉，但重開失敗：{e}"));
        }
        let mut found: Option<(u32, String)> = None;
        let appeared = switch::wait_until(os, self.env.timing().appear_wait_ms, self.env.timing().poll_ms, || {
            for s in console::read_sessions(&self.dirs.sessions) {
                if s.get("name").and_then(Value::as_str) != Some(new_name) || s.get("kind").and_then(Value::as_str).map(|k| k != "interactive").unwrap_or(false) {
                    continue;
                }
                let Some(p) = s.get("pid").and_then(Value::as_u64).and_then(|p| u32::try_from(p).ok()) else { continue };
                let sid = s.get("sessionId").and_then(Value::as_str).unwrap_or("").to_string();
                if old_pids.contains(&p) || !os.alive(p) || (new_sid_required && (sid.is_empty() || sid == t.session_id)) {
                    continue;
                }
                found = Some((p, sid));
                return true;
            }
            false
        });
        match (appeared, found) {
            (true, Some((pid, sid))) => ok("新視窗已出現", Some(json!({ "pid": pid, "session_id": sid, "old_pid": t.pid }))),
            _ => unconfirmed("原視窗已關閉、新視窗已送出，但一直沒看到同名的新視窗出現"),
        }
    }

    fn rename(&self, op: &Op, t: switch::Target) -> OpResult {
        let new = op.new_name.as_str();
        if !valid_partner_name(new) {
            return failed("新名字不合規則");
        }
        if new == t.name {
            return failed("新名字和目前的一樣");
        }
        let taken = console::read_sessions(&self.dirs.sessions).iter().any(|s| s.get("name").and_then(Value::as_str) == Some(new) && s.get("pid").and_then(Value::as_u64).map(|p| self.env.os().alive(p as u32)).unwrap_or(false));
        if taken {
            return failed(format!("已經有叫「{}」的視窗", clean(new, 40)));
        }
        if !self.env.allow_remote() {
            return failed(CONSENT_OFF);
        }
        if let ModRes::Done(r) = self.via_mod(op, &t, new) {
            return r;
        }
        // 退路：重開。等外掛的這段時間視窗可能已經變了，重新確認一次還是同一個
        let t2 = match self.find_target(&t.name) {
            Ok(x) if x.pid == t.pid && x.session_id == t.session_id => x,
            Ok(_) => return failed("這個視窗在等待期間換了，請重新操作"),
            Err(e) => return failed(e),
        };
        let argv = switch::rewrite_args_opts(&t2.args, Some(&t2.session_id), new, switch::current_model(&t2.args).as_deref(), None);
        self.reopen(None, &t2, new, argv, false)
    }

    fn model(&self, op: &Op, t: switch::Target) -> OpResult {
        if !switch::valid_model(&op.model) {
            return failed("模型名稱不合法");
        }
        if !self.env.allow_remote() {
            return failed(CONSENT_OFF);
        }
        if let ModRes::Done(r) = self.via_mod(op, &t, &op.model) {
            return r;
        }
        let t2 = match self.find_target(&t.name) {
            Ok(x) if x.pid == t.pid && x.session_id == t.session_id => x,
            Ok(_) => return failed("這個視窗在等待期間換了，請重新操作"),
            Err(e) => return failed(e),
        };
        // 沿用既有的切換流程（它會再確認閒置、守門、關、重開、等新視窗）；動手前先過我們自己的守門
        if let Err(e) = self.guard(&t2) {
            return failed(e);
        }
        let req = SwitchRunReq { name: t2.name.clone(), pid: t2.pid, session_id: t2.session_id.clone(), model: op.model.clone() };
        let env = self.env.clone();
        let v = switch::run_with(self.env.os(), &self.dirs.sessions, &req, &move |plan| env.launch(plan), &self.env.timing());
        if v.get("ok").and_then(Value::as_bool) == Some(true) {
            return ok("已切換模型", Some(json!({ "pid": v.get("newPid"), "session_id": v.get("sessionId"), "model": op.model })));
        }
        let reason = v.get("reason").and_then(Value::as_str).unwrap_or("切換失敗").to_string();
        if v.get("stage").and_then(Value::as_str) == Some("verify") {
            unconfirmed(reason)
        } else {
            failed(reason)
        }
    }

    // ---- resume（喚醒）---------------------------------------------------------------------------

    /// 視窗已經關了：用 `claude --resume <sessionId> -n <原名字>` 在原本的工作資料夾重開，同一段對話接回來。
    /// 每一步都是守門：格式、已在線、對話紀錄（只認檔名）、資料夾白名單、本機開關，任何一關不過就什麼都不開。
    fn resume(&self, op: &Op) -> OpResult {
        let (name, sid) = (op.name.as_str(), op.session_id.as_str());
        // 1. sessionId 要過格式才會被當檔名用；不合格就連資料夾都不碰
        if !roster::valid_sid(sid) {
            return failed("這位夥伴沒有可接回的對話編號，只能開新的夥伴");
        }
        if !valid_partner_name(name) {
            return failed("視窗名格式不對，無法喚醒");
        }
        if (self.protect)(name, 0) {
            return failed(PROTECTED);
        }
        // 2. 已經有活著的視窗用同一個 sessionId 或同名：不能再開（兩個視窗寫同一段對話會互相覆蓋）
        let os = self.env.os();
        let live = console::read_sessions(&self.dirs.sessions).iter().any(|s| {
            self.session_live(s) && (s.get("name").and_then(Value::as_str) == Some(name) || s.get("sessionId").and_then(Value::as_str) == Some(sid))
        });
        if live {
            return failed("這位夥伴已經在線上");
        }
        // 3. 找對話紀錄，從裡面取原本的工作資料夾；不是 Claude 的就看是不是 pi 的對話檔（#468）
        let Some(cwd) = find_transcript_cwd(&self.dirs.projects, sid) else {
            if let Some(found) = self.find_pi_session(sid) {
                return self.resume_pi(name, found);
            }
            if let Some(why) = self.pi_no_record_reason(sid) {
                return failed(why);
            }
            return failed(NO_RECORD);
        };
        // 4. 資料夾必須在本機啟動設定允許的清單內
        let cfg = match self.env.launch_config() {
            Ok(c) => c,
            Err(e) => return failed(if e.is_empty() { "這台電腦還沒有可用的啟動設定".to_string() } else { e }),
        };
        let canon = match canonical_launch_cwd(&cwd) {
            Ok(c) => c,
            Err(_) => return failed("原本的工作資料夾不在這台電腦允許的清單內，不能從遠端喚醒"),
        };
        if !cfg.cwd_allow.iter().any(|a| *a == canon) {
            return failed(format!("原本的工作資料夾（{}）不在這台電腦允許的清單內，不能從遠端喚醒；要先在電腦的設定加入，或到電腦前自己開", clean(&cwd, 120)));
        }
        if !canon.is_dir() {
            return failed("原本的工作資料夾已經不存在了");
        }
        // 5. 用啟動設定的第一個 Claude 視窗型 profile（只拿指令與固定參數，名字與對話編號由我們補）
        let Some(argv) = resume_argv(&cfg, name, sid) else {
            return failed("這台電腦沒有可用的 Claude 啟動設定");
        };
        let plan = Plan { name: name.to_string(), cwd: PathBuf::from(crate::launch::local::strip_verbatim_prefix(&canon.to_string_lossy())), argv, in_wt: false };
        // 6. 動手前再驗一次本機開關
        if !self.env.allow_remote() {
            return failed(CONSENT_OFF);
        }
        if let Err(e) = self.env.launch(&plan) {
            return failed(format!("開不起來：{e}"));
        }
        // 7. 等名單出現同名視窗才算成功
        let mut found: Option<(u32, String)> = None;
        let appeared = switch::wait_until(os, self.env.timing().appear_wait_ms, self.env.timing().poll_ms, || {
            for s in console::read_sessions(&self.dirs.sessions) {
                if s.get("name").and_then(Value::as_str) != Some(name) || s.get("kind").and_then(Value::as_str).map(|k| k != "interactive").unwrap_or(false) {
                    continue;
                }
                let Some(p) = s.get("pid").and_then(Value::as_u64).and_then(|p| u32::try_from(p).ok()) else { continue };
                if p == 0 || !os.alive(p) {
                    continue;
                }
                found = Some((p, s.get("sessionId").and_then(Value::as_str).unwrap_or("").to_string()));
                return true;
            }
            false
        });
        match (appeared, found) {
            (true, Some((pid, session))) => ok("視窗已喚醒", Some(json!({ "pid": pid, "session_id": session }))),
            _ => unconfirmed("視窗已送出，但一直沒看到同名的視窗出現（可能卡在「是否信任此資料夾」，請到電腦前看一下）"),
        }
    }

    /// 找不到對話檔時，pi 的兩種情況要分開講（#593）：pi 要等對話裡有第一句話才會存檔，所以「還沒講過話」不是壞掉；
    /// 設定資料夾不在就是另一回事。對話編號不像 pi 的（不是 UUIDv7），或 pi 確實有這個編號的檔但接不回（檔頭不符、不只一個），
    /// 回 None，照舊說「找不到原本的對話紀錄」。只看資料夾與檔名，不讀內容
    fn pi_no_record_reason(&self, sid: &str) -> Option<&'static str> {
        use super::engines::pi_adopt as pa;
        if !looks_like_pi_sid(sid) {
            return None;
        }
        let dir = pa::sessions_dir(&self.env.pi_agent_dir());
        if !dir.is_dir() {
            return Some(PI_NO_AGENT_DIR);
        }
        if pa::list_session_files(&dir).iter().any(|f| f.file_id == sid) {
            return None;
        }
        Some(PI_NEVER_TALKED)
    }

    /// pi 的對話檔：檔名的編號＝sid，而且檔頭的 id 也是 sid（只讀檔頭，不讀對話內容）；找不到或不只一個都回 None
    fn find_pi_session(&self, sid: &str) -> Option<super::engines::pi_adopt::Found> {
        use super::engines::pi_adopt as pa;
        let hits: Vec<(PathBuf, pa::Header)> = pa::list_session_files(&pa::sessions_dir(&self.env.pi_agent_dir()))
            .into_iter()
            .filter(|f| f.file_id == sid)
            .filter_map(|f| pa::read_header(&f.path).filter(|h| h.id == sid).map(|h| (f.path, h)))
            .collect();
        match hits.as_slice() {
            [(path, h)] => Some(pa::Found { path: path.clone(), session_id: h.id.clone(), cwd: h.cwd.clone(), via: pa::Via::Arg }),
            _ => None,
        }
    }

    /// 喚醒 pi（#468）：在對話檔記的資料夾、用同一段對話（--session）和原本的名字開一個由 ASN 管理的 pi；
    /// 檢查照開新夥伴（遠端開關、資料夾白名單、名字規則、同名）。登記上名單才算成功，失敗照實回報並附手動接回的指令
    fn resume_pi(&self, name: &str, found: super::engines::pi_adopt::Found) -> OpResult {
        let manual = super::engines::pi_adopt::manual_command(&found);
        let config = match self.env.launch_config() {
            Ok(c) => c,
            Err(e) => return failed(if e.is_empty() { "這台電腦還沒有可用的啟動設定".to_string() } else { e }),
        };
        if !config.profiles.contains_key("pi") {
            return failed("這台電腦的啟動設定裡沒有 pi，無法喚醒");
        }
        let mut req = LaunchReq { profile: "pi", name, cwd: found.cwd.clone() };
        if let Err(e) = check_launch(&config, &mut req, &[], self.env.now_ms()) {
            return failed(format!("{e}，不能從遠端喚醒"));
        }
        if self.name_taken_here(name) {
            return failed("這位夥伴已經在線上");
        }
        // 動手前再驗一次本機開關
        if !self.env.allow_remote() {
            return failed(CONSENT_OFF);
        }
        let session = crate::launch::local::strip_verbatim_prefix(&found.path.to_string_lossy());
        let pid = match self.env.launch_pi_session(&config, name, &req.cwd, &session) {
            Ok(p) => p,
            Err(e) => return failed(format!("pi 沒開起來（{e}）。對話檔還在，可以手動接回：{manual}")),
        };
        let os = self.env.os();
        let home = self.env.pi_home();
        let appeared = switch::wait_until(os, self.env.timing().appear_wait_ms, self.env.timing().poll_ms, || {
            super::engines::pi_control::window_session_id(&home, name, self.env.now_ms(), |p| os.alive(p)).is_some()
        });
        if !appeared {
            return unconfirmed(format!("pi 開了，但還沒出現在名單上（可能卡在啟動，或 ASN 的 pi 擴充沒載入）。對話檔還在，可以手動接回：{manual}"));
        }
        ok("已喚醒：用同一段對話開了由 ASN 管理的 pi", Some(json!({ "kind": "pi_resume", "pid": pid, "session_id": found.session_id })))
    }

    /// 換班接手：記下前任 → 請前任把交接寫到規範資料夾 → 等檔案出現且大小穩定（上限 10 分鐘，逾時照樣換手並註明）
    /// → 關掉前任（沿用既有安全規則）→ 同名開新 session（不帶 --resume），第一句話指向前任對話紀錄與交接檔
    fn handover(&self, op: &Op, t: switch::Target) -> OpResult {
        let key = self.corr.pid_of(&t.name).unwrap_or_else(|| t.name.clone());
        let Some(path) = handoff_path(&self.handoff_dir, &key, self.env.now_ms()) else {
            return failed("交接檔的位置不安全，已取消");
        };
        if let Some(dir) = path.parent() {
            if let Err(e) = std::fs::create_dir_all(dir) {
                return failed(format!("建不起交接檔的資料夾：{e}"));
            }
        }
        let transcript = find_transcript(&self.dirs.projects, &t.session_id).map(|(p, _)| p);
        // 1. 請前任寫交接，等檔案出現且大小穩定
        self.stage(op, "handoff");
        let mut complete = false;
        match self.env.tell(&t.name, &ask_handoff_text(&path)) {
            Ok(()) => {
                let mut last: Option<u64> = None;
                complete = switch::wait_until(self.env.os(), self.env.handoff_wait_ms(), self.env.handoff_poll_ms(), || match std::fs::metadata(&path) {
                    Ok(m) if m.is_file() && m.len() > 0 => {
                        let same = last == Some(m.len());
                        last = Some(m.len());
                        same
                    }
                    _ => false,
                });
            }
            Err(e) => self.log.line(&format!("partner_op handover: cannot ask {} to write handoff: {}", clean(&t.name, 40), clean(&e, 120))),
        }
        // 2. 等待期間視窗可能已經變了：重新確認還是同一個
        let t2 = match self.find_target(&t.name) {
            Ok(x) if x.pid == t.pid && x.session_id == t.session_id => x,
            Ok(_) => return failed("這個視窗在等待交接期間換了，請重新操作"),
            Err(e) => return failed(e),
        };
        // 3. 關前任、同名開新對話：不帶 --resume／--continue／--session-id，名字與模型不變
        let prompt = handover_prompt(&t2.name, &op.note, transcript.as_deref(), &path, complete);
        // 模型：前任現在實際在用的（在視窗裡用 /model 換過，啟動參數看不出來，所以先看對話紀錄最後一則回覆的模型），
        // 讀不到才用它啟動時的參數；兩邊都沒有就不指定（用啟動設定的預設）。新視窗用的模型寫進結果，讓人看得到（不再默默變笨）
        let (model, model_basis) = pick_handover_model(transcript.as_deref().and_then(last_assistant_model), switch::current_model(&t2.args));
        let argv = switch::rewrite_args_opts(&t2.args, None, &t2.name, model.as_deref(), Some(&prompt));
        let mut r = self.reopen(Some(op), &t2, &t2.name.clone(), argv, true);
        if r.status != "failed" {
            let extra = json!({ "handoff_path": path.to_string_lossy(), "handoff_done": complete, "model": model, "model_basis": model_basis });
            match r.result.as_mut().and_then(Value::as_object_mut) {
                Some(m) => {
                    m.insert("handoff_path".into(), extra["handoff_path"].clone());
                    m.insert("handoff_done".into(), extra["handoff_done"].clone());
                    m.insert("model".into(), extra["model"].clone());
                    m.insert("model_basis".into(), extra["model_basis"].clone());
                }
                None => r.result = Some(extra),
            }
        }
        r
    }
}

/// 對話紀錄最後一則助理回覆用的模型（只讀檔尾 512 KB）：換班接手要讓新視窗和前任用同一個模型。
/// 跳過子代理的回覆（isSidechain）與 `<synthetic>` 這類不是真模型的名字，名字格式不合就不採用；讀不到、沒有回覆都回 None
pub(crate) fn last_assistant_model(transcript: &Path) -> Option<String> {
    use std::io::{Read, Seek, SeekFrom};
    let mut f = std::fs::File::open(transcript).ok()?;
    let len = f.metadata().ok()?.len();
    let start = len.saturating_sub(512 * 1024);
    f.seek(SeekFrom::Start(start)).ok()?;
    let mut buf = Vec::new();
    f.take(512 * 1024).read_to_end(&mut buf).ok()?;
    let text = String::from_utf8_lossy(&buf);
    text.lines().rev().find_map(|l| {
        let v: Value = serde_json::from_str(l.trim()).ok()?;
        // 子代理（isSidechain）的回覆不算：它們常用較小的模型，拿來當前任的模型會讓新視窗被降級
        if v.get("type").and_then(Value::as_str) != Some("assistant") || v.get("isSidechain").and_then(Value::as_bool) == Some(true) {
            return None;
        }
        let m = v.pointer("/message/model").and_then(Value::as_str)?.trim();
        (!m.starts_with('<') && switch::valid_model(m)).then(|| m.to_string())
    })
}

/// 模型屬於哪一系列：名字（小寫，去掉 `[1m]` 之類後綴）裡含的 opus／sonnet／haiku／fable；認不出來是 None
fn model_series(m: &str) -> Option<&'static str> {
    let base = m.split('[').next().unwrap_or(m).to_lowercase();
    ["opus", "sonnet", "haiku", "fable"].into_iter().find(|s| base.contains(s))
}

/// 去掉 `[1m]` 之類的後綴
fn strip_suffix(m: &str) -> &str {
    m.split('[').next().unwrap_or(m)
}

/// 不帶版本的別名（opus、opus[1m]）：去掉後綴後沒有數字
fn is_alias(m: &str) -> bool {
    !strip_suffix(m).bytes().any(|b| b.is_ascii_digit())
}

/// 換班接手給新視窗的模型：回 (模型, 依據)。依據：record＝取對話紀錄裡前任實際用的；launch_same＝啟動參數和紀錄同一系列，
/// 沿用啟動參數原樣（保住 `[1m]` 長脈絡這類紀錄看不出來的後綴）；launch＝紀錄讀不到，退回啟動參數（不保證和前任現在用的一樣）；none＝都沒有
fn pick_handover_model(recorded: Option<String>, launched: Option<String>) -> (Option<String>, &'static str) {
    match (recorded, launched) {
        (Some(r), Some(l)) if model_series(&r).is_some() && model_series(&r) == model_series(&l) && (is_alias(&l) || strip_suffix(&l) == strip_suffix(&r)) => (Some(l), "launch_same"),
        (Some(r), _) => (Some(r), "record"),
        (None, Some(l)) => (Some(l), "launch"),
        (None, None) => (None, "none"),
    }
}

/// 喚醒用的啟動參數（含程式本身）：第一個 Claude 視窗型 profile（claude 優先），固定參數照啟動設定，
/// 名字與 `--resume <sessionId>` 由這裡補（舊的 -n／--resume／--model 之外的旗標原樣保留，模型沿用設定裡的）。
pub(crate) fn resume_argv(cfg: &LaunchConfig, name: &str, sid: &str) -> Option<Vec<String>> {
    let mut ids: Vec<&String> = cfg.profiles.keys().collect();
    ids.sort_by(|a, b| (a.as_str() != "claude").cmp(&(b.as_str() != "claude")).then(a.cmp(b)));
    let p = ids.into_iter().map(|id| &cfg.profiles[id]).find(|p| p.mode == LaunchMode::Window && !p.disabled && (p.engine.is_empty() || p.engine == "claude"))?;
    let mut full = vec![expand_vars(&p.command, &child_env())];
    full.extend(p.args.iter().map(|a| a.replace("{name}", name)));
    let model = switch::current_model(&full);
    Some(switch::rewrite_args_opts(&full, Some(sid), name, model.as_deref(), None))
}

/// 在 `<projects>/*/<sessionId>.jsonl` 找對話紀錄（只比對檔名＝sessionId，sessionId 先過格式），
/// 回前幾行 JSON 裡第一個 cwd 欄位。找不到、讀不了、沒有 cwd 都回 None。
pub(crate) fn find_transcript_cwd(projects: &Path, sid: &str) -> Option<String> {
    find_transcript(projects, sid).map(|(_, c)| c)
}

/// 同上，連對話紀錄的完整路徑一起回（換班接手要告訴新視窗去讀哪個檔）
pub(crate) fn find_transcript(projects: &Path, sid: &str) -> Option<(PathBuf, String)> {
    if !roster::valid_sid(sid) {
        return None;
    }
    let file = format!("{sid}.jsonl");
    for e in std::fs::read_dir(projects).ok()?.flatten() {
        let dir = e.path();
        let path = dir.join(&file);
        if dir.is_dir() && path.is_file() {
            if let Some(c) = first_cwd(&path) {
                return Some((path, c));
            }
        }
    }
    None
}

fn first_cwd(path: &Path) -> Option<String> {
    use std::io::Read;
    let f = std::fs::File::open(path).ok()?;
    let rd = std::io::BufReader::new(f.take(512 * 1024));
    for line in rd.lines().take(40) {
        let Ok(line) = line else { return None };
        let Ok(v) = serde_json::from_str::<Value>(line.trim()) else { continue };
        if let Some(c) = v.get("cwd").and_then(Value::as_str) {
            let c = c.trim();
            if !c.is_empty() && !c.chars().any(|ch| ch.is_control()) {
                return Some(c.to_string());
            }
        }
    }
    None
}

#[cfg(test)]
mod tests;

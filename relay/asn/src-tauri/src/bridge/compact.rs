//! 視窗壓縮 N 次自動交接（#1852）：只放純邏輯（數壓縮次數、額度門檻、每個視窗只觸發一次的狀態機），不碰程序、不連網。
//! 真正動手（交接、寄信）在 partner_ops/compact.rs；這裡的函式都用假資料就能測。
//!
//! 規則（擁有者 2026-11-20 點頭）：
//! - 次數＝這個視窗的對話紀錄裡 `type: system`、`subtype: compact_boundary` 的筆數，只算「這次開視窗之後」（用那一筆的時間戳比開窗時間）。
//!   交接重開的新視窗是新的 session、新的對話紀錄檔，次數自然從 0 算。
//! - 到 N 次：設定勾選、且 5 小時與每週額度都剩 20% 以上才自動交接；額度不夠、讀不到（一律當不確定）、設定沒勾，都只提醒。
//! - 提醒只出現在工作管理員那一欄與通知信；之後額度恢復再自動交接。
//! - 每個 session 最多自動交接一次；交接失敗不重試（改成只提醒）。手動交接不查額度。
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::io::{Read, Seek, SeekFrom};
use std::path::PathBuf;
use std::sync::Mutex;

pub const N_MIN: u32 = 2;
pub const N_MAX: u32 = 10;
pub const N_DEFAULT: u32 = 3;
/// 5 小時與每週額度都要剩這麼多（%）以上才自動交接
pub const QUOTA_MIN_PCT: f64 = 20.0;
/// 額度讀數超過這麼久沒更新就當讀不到（毫秒）
pub const QUOTA_STALE_MS: i64 = 30 * 60_000;
/// 已交接過的 session 記多少個（記憶體內，防止名單閃一下又出現時重複觸發）
const DONE_MAX: usize = 200;

/// 設定值夾進 2～10；不是數字（缺欄位）回預設 3
pub fn clamp_n(n: Option<i64>) -> u32 {
    match n {
        Some(v) => v.clamp(N_MIN as i64, N_MAX as i64) as u32,
        None => N_DEFAULT,
    }
}

// ---------- 數壓縮次數 ----------

/// 一行對話紀錄是不是「開窗之後的壓縮標記」。時間戳讀不出來的不算（沒有證據證明是這次開窗之後）
pub fn is_compact_line(line: &str, since_ms: u64) -> bool {
    if !line.contains("compact_boundary") {
        return false;
    }
    let Ok(v) = serde_json::from_str::<Value>(line.trim()) else { return false };
    if v.get("type").and_then(Value::as_str) != Some("system") || v.get("subtype").and_then(Value::as_str) != Some("compact_boundary") {
        return false;
    }
    let Some(ts) = v.get("timestamp").and_then(Value::as_str).and_then(ts_ms) else { return false };
    ts >= since_ms
}

/// `2026-11-20T09:00:00.123Z` → 毫秒
fn ts_ms(s: &str) -> Option<u64> {
    let (head, frac) = match s.split_once('.') {
        Some((h, f)) => (format!("{h}Z"), f.trim_end_matches('Z')),
        None => (s.to_string(), ""),
    };
    // quota_core::parse_iso_secs 雖然名字叫 secs，回的是毫秒（整秒）
    let base = crate::quota_core::parse_iso_secs(&head)?;
    let digits: String = frac.chars().take(3).collect();
    let ms: u64 = if digits.is_empty() { 0 } else { digits.parse::<u64>().ok()? * 10u64.pow(3 - digits.len() as u32) };
    u64::try_from(base).ok().map(|b| b.saturating_add(ms))
}

/// 一個對話紀錄檔讀到哪裡、數到幾次（每次只讀新增的部分，大檔也不會每輪重讀）
#[derive(Clone, Debug, PartialEq)]
pub struct Progress {
    pub path: PathBuf,
    pub offset: u64,
    pub count: u32,
}

impl Progress {
    pub fn new(path: PathBuf) -> Progress {
        Progress { path, offset: 0, count: 0 }
    }

    /// 讀新增的完整行並累計；檔案比上次短（被換掉了）就從頭數。只吃到最後一個換行，寫到一半的行下次再看
    pub fn advance(&mut self, since_ms: u64) -> std::io::Result<u32> {
        let mut f = std::fs::File::open(&self.path)?;
        let len = f.metadata()?.len();
        if len < self.offset {
            self.offset = 0;
            self.count = 0;
        }
        f.seek(SeekFrom::Start(self.offset))?;
        let mut buf = Vec::new();
        f.take(len - self.offset).read_to_end(&mut buf)?;
        let Some(end) = buf.iter().rposition(|b| *b == b'\n') else { return Ok(self.count) };
        let text = String::from_utf8_lossy(&buf[..=end]);
        self.count += text.lines().filter(|l| is_compact_line(l, since_ms)).count() as u32;
        self.offset += (end + 1) as u64;
        Ok(self.count)
    }
}

// ---------- 額度 ----------

#[derive(Clone, Debug, PartialEq)]
pub enum Quota {
    Known { five: f64, week: f64 },
    /// 讀不到、過期、登入失效、這個視窗用自訂設定資料夾：一律當不確定
    Unknown,
}

/// 這台是不是設了自訂 CLAUDE_CONFIG_DIR：設了的視窗用的是別的帳號，這台「目前登入帳號」的額度不能代表它
pub fn custom_config_dir() -> bool {
    std::env::var_os("CLAUDE_CONFIG_DIR").is_some_and(|d| !d.is_empty())
}

/// 命令列（含外殼）裡有寫 CLAUDE_CONFIG_DIR（例如 `set CLAUDE_CONFIG_DIR=…&& claude`）
pub fn mentions_custom_config(text: &str) -> bool {
    text.contains("CLAUDE_CONFIG_DIR")
}

/// 程序環境（Linux 的 /proc/<pid>/environ，以 NUL 分隔）裡有設非空的 CLAUDE_CONFIG_DIR
pub fn environ_has_custom_config(bytes: &[u8]) -> bool {
    bytes.split(|b| *b == 0).any(|kv| kv.strip_prefix(b"CLAUDE_CONFIG_DIR=").is_some_and(|v| !v.is_empty()))
}

/// 這個視窗是不是可能用自訂設定資料夾。ASN 讀不到別的程序在 Windows 上的環境變數，所以保守：任何一個來源看得到就算——
/// ASN 自己的環境（ASN 開的視窗繼承它）、視窗與它外殼的命令列、Linux 上視窗自己的環境
pub fn window_custom_config(asn_env: bool, cmdlines: &[String], environ: Option<&[u8]>) -> bool {
    asn_env || cmdlines.iter().any(|c| mentions_custom_config(c)) || environ.is_some_and(environ_has_custom_config)
}

/// 設備頁用的那份額度讀數（`claude_quota::state_view`）→ 判斷用的額度。
/// 只有「剛讀到（ok）、兩個窗都有數字、讀取時間在 30 分鐘內」而且視窗沒用自訂設定資料夾，才算 Known
pub fn quota_from_view(v: &Value, custom_config: bool, now_ms: i64) -> Quota {
    if custom_config || v.get("status").and_then(Value::as_str) != Some("ok") {
        return Quota::Unknown;
    }
    let fresh = v.get("read_at").and_then(Value::as_str).and_then(crate::quota_core::parse_iso_secs).is_some_and(|t| now_ms - t <= QUOTA_STALE_MS && t <= now_ms + 5 * 60_000);
    if !fresh {
        return Quota::Unknown;
    }
    let left = |name: &str| v.get("windows").and_then(Value::as_array).and_then(|w| w.iter().find(|x| x.get("name").and_then(Value::as_str) == Some(name))).and_then(|x| x.get("left_pct")).and_then(Value::as_f64).filter(|p| p.is_finite() && (0.0..=100.0).contains(p));
    match (left("five_hour"), left("weekly")) {
        (Some(five), Some(week)) => Quota::Known { five, week },
        _ => Quota::Unknown,
    }
}

// ---------- 狀態機 ----------

/// 沒自動交接的原因（通知信與畫面「請交接」用）
#[derive(Clone, Debug, PartialEq)]
pub enum Why {
    /// 額度不夠：哪一個窗（"5 小時"／"每週"）剩幾 %
    Quota { which: &'static str, pct: u32 },
    Unknown,
    /// 設定沒勾
    Off,
    /// 自動交接做了但沒成功
    Failed,
}

#[derive(Clone, Debug, PartialEq)]
pub enum Phase {
    Counting,
    /// 交接中（自動或手動）
    Handing,
    Remind(Why),
    /// 已交接成功（舊視窗已關）；留著只為了名單閃一下時不重複觸發
    Done,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Win {
    pub sid: String,
    pub name: String,
    pub count: u32,
    /// 這個視窗可能用自訂的 CLAUDE_CONFIG_DIR（別的設定資料夾、可能別的帳號）：這台目前登入帳號的額度不能代表它，一律當讀不到
    pub custom_config: bool,
}

/// 通知信的種類（對應後台 compact_notice 的 kind）
#[derive(Clone, Debug, PartialEq)]
pub enum MailKind {
    Auto { pct5: Option<u32> },
    Remind(Why),
}

#[derive(Clone, Debug, PartialEq)]
pub enum Act {
    /// 開始交接（auto＝自動；false＝手動，不查額度、也不寄信）
    Handover { sid: String, name: String, count: u32, auto: bool, pct5: Option<u32> },
    Mail { sid: String, name: String, count: u32, kind: MailKind },
}

#[derive(Clone, Debug)]
struct S {
    phase: Phase,
    mailed: bool,
    count: u32,
    name: String,
    auto: bool,
    pct5: Option<u32>,
}

#[derive(Default, Debug)]
pub struct Tracker {
    sess: HashMap<String, S>,
    done: Vec<String>,
}

/// 這一輪的判斷輸入
pub struct Input<'a> {
    pub wins: &'a [Win],
    pub enabled: bool,
    pub n: u32,
    pub quota: &'a Quota,
    /// 本人在工作管理員按了「交接」的視窗名
    pub manual: &'a [String],
}

fn pct(v: f64) -> u32 {
    v.floor().clamp(0.0, 100.0) as u32
}

/// 到 N 次時要自動交接還是只提醒（純判斷；額度不是 Known 一律不自動）
pub fn judge(enabled: bool, quota: &Quota) -> Result<Option<u32>, Why> {
    if !enabled {
        return Err(Why::Off);
    }
    match quota {
        Quota::Unknown => Err(Why::Unknown),
        Quota::Known { five, week } => {
            if *five < QUOTA_MIN_PCT {
                Err(Why::Quota { which: "5 小時", pct: pct(*five) })
            } else if *week < QUOTA_MIN_PCT {
                Err(Why::Quota { which: "每週", pct: pct(*week) })
            } else {
                Ok(Some(pct(*five)))
            }
        }
    }
}

impl Tracker {
    fn is_done(&self, sid: &str) -> bool {
        self.done.iter().any(|d| d == sid)
    }

    pub fn step(&mut self, i: &Input) -> Vec<Act> {
        let mut acts = Vec::new();
        // 一輪最多自動交接 1 個視窗：同時開好幾個新視窗太吵，其餘達標的留到下一輪（維持原狀態，不標交接中）
        let mut auto_taken = false;
        let live: HashSet<&str> = i.wins.iter().map(|w| w.sid.as_str()).collect();
        // 視窗不在了就忘掉（交接中的、做完的留著，免得名單閃一下又出現時重複觸發）
        self.sess.retain(|sid, s| live.contains(sid.as_str()) || s.phase == Phase::Handing);
        for w in i.wins {
            if self.is_done(&w.sid) {
                continue;
            }
            let s = self.sess.entry(w.sid.clone()).or_insert(S { phase: Phase::Counting, mailed: false, count: 0, name: w.name.clone(), auto: false, pct5: None });
            s.count = w.count;
            s.name = w.name.clone();
            if s.phase == Phase::Handing {
                continue;
            }
            // 手動交接：不查額度、不管設定、不寄信
            if i.manual.iter().any(|m| *m == w.name) {
                s.phase = Phase::Handing;
                s.auto = false;
                acts.push(Act::Handover { sid: w.sid.clone(), name: w.name.clone(), count: w.count, auto: false, pct5: None });
                continue;
            }
            if w.count < i.n {
                continue;
            }
            // 自動交接失敗過：不再自動重試，等人按「交接」
            if s.phase == Phase::Remind(Why::Failed) {
                continue;
            }
            // 這個視窗可能用自訂設定資料夾：額度不能代表它，當讀不到
            let q = if w.custom_config { &Quota::Unknown } else { i.quota };
            match judge(i.enabled, q) {
                Ok(_) if auto_taken => {}
                Ok(pct5) => {
                    auto_taken = true;
                    s.phase = Phase::Handing;
                    s.auto = true;
                    s.pct5 = pct5;
                    acts.push(Act::Handover { sid: w.sid.clone(), name: w.name.clone(), count: w.count, auto: true, pct5 });
                }
                Err(why) => {
                    s.phase = Phase::Remind(why.clone());
                    if !s.mailed {
                        s.mailed = true;
                        acts.push(Act::Mail { sid: w.sid.clone(), name: w.name.clone(), count: w.count, kind: MailKind::Remind(why) });
                    }
                }
            }
        }
        acts
    }

    /// 交接做完：成功→記成已交接（自動的寄「已自動交接」信）；失敗→改成只提醒（寄一次「請交接」信，手動的不寄）
    pub fn finish(&mut self, sid: &str, ok: bool) -> Option<Act> {
        let s = self.sess.get_mut(sid)?;
        if s.phase != Phase::Handing {
            return None;
        }
        let (name, count, auto, pct5) = (s.name.clone(), s.count, s.auto, s.pct5);
        if ok {
            s.phase = Phase::Done;
            self.sess.remove(sid);
            self.done.push(sid.to_string());
            if self.done.len() > DONE_MAX {
                self.done.remove(0);
            }
            return auto.then(|| Act::Mail { sid: sid.to_string(), name, count, kind: MailKind::Auto { pct5 } });
        }
        s.phase = Phase::Remind(Why::Failed);
        if auto && !s.mailed {
            s.mailed = true;
            return Some(Act::Mail { sid: sid.to_string(), name, count, kind: MailKind::Remind(Why::Failed) });
        }
        None
    }

    /// 畫面用：sid → （次數，狀態）
    pub fn view(&self) -> HashMap<String, RowView> {
        self.sess.iter().map(|(k, s)| (k.clone(), RowView { count: s.count, state: match &s.phase { Phase::Handing => "handing", Phase::Remind(_) => "remind", _ => "count" } })).collect()
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct RowView {
    pub count: u32,
    /// count＝只顯示次數；handing＝交接中；remind＝請交接
    pub state: &'static str,
}

// ---------- 手動交接的請求與畫面讀數（程式內部共用，後台佇列碰不到） ----------

static MANUAL: Mutex<Vec<String>> = Mutex::new(Vec::new());
static VIEW: Mutex<Option<HashMap<String, RowView>>> = Mutex::new(None);

/// 工作管理員按「交接」：只記視窗名，下一輪由內建收發室驗證後執行
pub fn request_manual(name: &str) {
    let name = name.trim();
    if name.is_empty() || name.chars().count() > 80 {
        return;
    }
    let mut q = MANUAL.lock().unwrap_or_else(|e| e.into_inner());
    if !q.iter().any(|n| n == name) && q.len() < 50 {
        q.push(name.to_string());
    }
}

pub fn take_manual() -> Vec<String> {
    std::mem::take(&mut *MANUAL.lock().unwrap_or_else(|e| e.into_inner()))
}

pub fn publish_view(v: HashMap<String, RowView>) {
    *VIEW.lock().unwrap_or_else(|e| e.into_inner()) = Some(v);
}

/// 工作管理員用：給一列 Claude 視窗（sessionId）取它的壓縮次數與狀態；還沒數過回 None（畫面顯示「—」）
pub fn row_json(sid: &str) -> Value {
    let g = VIEW.lock().unwrap_or_else(|e| e.into_inner());
    match g.as_ref().and_then(|m| m.get(sid)) {
        Some(r) => serde_json::json!({ "count": r.count, "state": r.state }),
        None => Value::Null,
    }
}

/// 交給後台 compact_notice 的欄位：(kind, reason, pct)
pub fn mail_fields(k: &MailKind) -> (&'static str, Option<&'static str>, Option<u32>) {
    match k {
        MailKind::Auto { pct5 } => ("auto", None, *pct5),
        MailKind::Remind(Why::Quota { which, pct }) => ("remind_quota", Some(which), Some(*pct)),
        MailKind::Remind(Why::Unknown) => ("remind_unknown", None, None),
        MailKind::Remind(Why::Off) => ("remind_off", None, None),
        MailKind::Remind(Why::Failed) => ("remind_failed", None, None),
    }
}

/// 這一刻的額度：設備頁那份「目前登入帳號」的讀數（讀不到、過期、自訂設定資料夾都是 Unknown）
pub fn quota_now(now_ms: i64) -> Quota {
    let home = crate::claude_accounts::claude_home();
    quota_from_view(&crate::claude_quota::state_view(&home), custom_config_dir(), now_ms)
}

#[cfg(test)]
mod tests;

//! 登入失效偵測與通知（設計：docs/design/LOGIN-EXPIRED-ALERT.md）。
//!
//! Claude 登入壞掉時，對話紀錄（`<家目錄>\.claude\projects\**\*.jsonl`）會多一筆合成的助理回覆，
//! 有結構化欄位 `isApiErrorMessage:true` 與 `error`，不必比對文字。本檔做這幾件事：
//! 1. 增量讀紀錄新增的行，轉成 [`Ev`]（只有「登入類錯誤」與「真的模型回覆」兩種，欄位只有種類與時間）；
//! 2. [`Watch`] 狀態機判定失效／恢復／該不該通知；**每個家目錄各一份**（[`Monitor`]），不同家目錄的錯誤與回覆不混算；
//! 3. [`notice`] 組通知的四個欄位（純函式），經 [`OwnerNotifier`] 交給後台動作 `acct_login_alert`，
//!    收件人與內文由後台決定，這裡不指定收件人。
//!
//! 隱私規定（asn真 審 #579）：讀紀錄只取 `type`／`isApiErrorMessage`／`error`／`model`／`usage` 是否存在／時間戳；
//! 訊息內容與 `text` 不反序列化（結構裡根本沒有那個欄位）、不留、不進通知、不進 log。
//! `Ev` 沒有任何字串欄位，所以不可能把內容帶出去。log 只寫固定句型與錯誤類別，不寫後台回應原文。
//!
//! 紅線：函式一律吃路徑與時間參數；只有 [`tick_real`] 會決定真實家目錄，測試不得呼叫它。
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{Read, Seek, SeekFrom};
use std::path::PathBuf;
use std::sync::Mutex;

/// 兩筆登入錯誤要落在這個視窗內才算
pub const WINDOW_MS: i64 = 10 * 60_000;
/// 只看最近這麼久內新增的行：開機時不翻舊帳
pub const LOOKBACK_MS: i64 = 30 * 60_000;
/// 失效期間最多每隔這麼久再提醒一次
pub const REMIND_MS: i64 = 6 * 3_600_000;
/// 失效標記的壽命：最後一次登入錯誤之後這麼久都沒有新的錯誤，就當作已經不是失效中
/// （登入已修好但一直沒用 Claude 時，不會永遠顯示失效）
pub const FAIL_TTL_MS: i64 = 12 * 3_600_000;
/// 第一次看到一個檔案時最多讀它最後這麼多位元組
const TAIL_BYTES: u64 = 256 * 1024;
/// 算登入失效的錯誤種類；`rate_limit`（額度用完）與 `server_error`（暫時性）不算
pub const LOGIN_ERRORS: [&str; 2] = ["authentication_failed", "oauth_org_not_allowed"];
/// 登入檔名（只看修改時間，不讀內容）
const CRED_FILE: &str = ".credentials.json";

// ---------- 解析：只宣告要的欄位，其餘（含訊息內容）反序列化時直接丟掉 ----------
#[derive(Deserialize)]
struct Line {
    #[serde(rename = "type")]
    kind: Option<String>,
    timestamp: Option<String>,
    #[serde(rename = "isApiErrorMessage")]
    is_api_error: Option<bool>,
    error: Option<String>,
    message: Option<Msg>,
}
#[derive(Deserialize)]
struct Msg {
    model: Option<String>,
    usage: Option<serde::de::IgnoredAny>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    /// 登入類錯誤（`LOGIN_ERRORS` 之一）
    LoginError,
    /// 真的模型回覆（`model` 不是 `<synthetic>`、有 usage）
    Reply,
}
/// 一筆事件：只有種類與時間（毫秒，UTC）。刻意不放任何字串。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Ev {
    pub kind: Kind,
    pub ts: i64,
}

/// 解析一行；與判定無關的行（使用者訊息、工具結果、rate_limit…）回 None，壞行也回 None
pub fn parse_line(line: &str) -> Option<Ev> {
    // 先用字串快速篩掉絕大多數行；只是篩選，不留任何內容
    if !line.contains("isApiErrorMessage") && !line.contains("\"usage\"") {
        return None;
    }
    let l: Line = serde_json::from_str(line).ok()?;
    if l.kind.as_deref() != Some("assistant") {
        return None;
    }
    let ts = crate::usage::parse_ts_ms(l.timestamp.as_deref()?)?;
    if l.is_api_error == Some(true) {
        return l.error.as_deref().filter(|e| LOGIN_ERRORS.contains(e)).map(|_| Ev { kind: Kind::LoginError, ts });
    }
    let m = l.message?;
    let model = m.model?;
    if model.starts_with('<') || m.usage.is_none() {
        return None; // <synthetic> 等非真實呼叫
    }
    Some(Ev { kind: Kind::Reply, ts })
}

// ---------- 增量讀檔 ----------
#[derive(Default)]
pub struct Tailer {
    files: HashMap<PathBuf, (u64, i64, u64)>, // 路徑 → (長度, mtime, 已讀到的位置)
}

impl Tailer {
    /// 讀 roots 底下紀錄檔新增的行。第一次看到的檔案：太久沒動的只記位置不讀；最近動過的只讀最後一段。
    pub fn poll(&mut self, roots: &[PathBuf], now_ms: i64) -> Vec<Ev> {
        let mut out = vec![];
        let mut found = vec![];
        for r in roots {
            crate::usage::walk(&r.join("projects"), 0, &mut found);
        }
        for (path, md) in found {
            let (len, mt) = (md.len(), crate::usage::mtime_ms(&md));
            let prev = self.files.get(&path).copied();
            if let Some((l, m, _)) = prev {
                if l == len && m == mt {
                    continue;
                }
            }
            let mut offset = prev.map(|p| p.2).unwrap_or(0);
            let mut skip_partial = false;
            if prev.is_none() || len < offset {
                if mt < now_ms - LOOKBACK_MS {
                    self.files.insert(path, (len, mt, len)); // 舊檔：不翻舊帳
                    continue;
                }
                offset = len.saturating_sub(TAIL_BYTES);
                skip_partial = offset > 0;
            }
            let Ok(mut f) = std::fs::File::open(&path) else { continue };
            if f.seek(SeekFrom::Start(offset)).is_err() {
                continue;
            }
            let mut buf = Vec::new();
            if f.take(len.saturating_sub(offset)).read_to_end(&mut buf).is_err() {
                continue;
            }
            let end = buf.iter().rposition(|&b| b == b'\n').map(|i| i + 1).unwrap_or(0);
            let mut body = &buf[..end];
            if skip_partial {
                // 從檔案中間開始讀：第一個不完整的行丟掉
                body = body.iter().position(|&b| b == b'\n').map(|i| &body[i + 1..]).unwrap_or(&[]);
            }
            for raw in body.split(|&b| b == b'\n') {
                if let Some(ev) = std::str::from_utf8(raw).ok().and_then(parse_line) {
                    out.push(ev);
                }
            }
            self.files.insert(path, (len, mt, offset + end as u64));
        }
        out
    }
}

// ---------- 判定 ----------
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AlertKind {
    /// 剛判定為失效
    First,
    /// 仍在失效中、距上次通知超過 6 小時
    Reminder,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Alert {
    pub kind: AlertKind,
    /// 最後一次登入錯誤的時間（毫秒，UTC）
    pub last_error_ms: i64,
    /// 這一輪失效的起點（第一筆算數的登入錯誤）；轉交逾時次數從這裡起算
    pub episode_start_ms: i64,
}

#[derive(Default)]
pub struct Watch {
    events: Vec<Ev>,
    failed: bool,
    last_notify_ms: Option<i64>,
    last_error_ms: i64,
    episode_start_ms: i64,
    /// 目前帳號的 email 與它開始使用的時間：這個時間之前的錯誤是舊帳號的，不算
    email: Option<String>,
    since_ms: i64,
}

impl Watch {
    /// 目前是否判定為登入失效（帳號回報的 `login_failed` 用這個）
    pub fn failed(&self) -> bool {
        self.failed
    }

    /// 告知目前使用的帳號。換了帳號（和上次記的不同）就清掉舊帳號的錯誤與失效狀態，
    /// 之後只認這一刻起的錯誤。email 讀不到（空字串）不當作換帳號。
    pub fn on_account(&mut self, email: &str, now_ms: i64) {
        let email = email.trim().to_lowercase();
        if email.is_empty() {
            return;
        }
        match &self.email {
            Some(old) if *old == email => {}
            Some(_) => {
                self.events.clear();
                self.failed = false;
                self.last_notify_ms = None;
                self.since_ms = now_ms;
                self.email = Some(email);
            }
            None => self.email = Some(email),
        }
    }

    /// 同 [`Watch::feed_with`]，不看登入檔
    pub fn feed(&mut self, evs: &[Ev], now_ms: i64) -> Option<Alert> {
        self.feed_with(evs, now_ms, None)
    }

    /// 餵進新事件並判定。只收最近 30 分鐘內、且在目前帳號開始使用之後的事件；
    /// 回傳要不要通知（失效期間只通知一次，每 6 小時最多再提醒一次）。
    /// `login_file_ms`：登入檔的修改時間（讀不到給 None）。失效之後登入檔被更新＝重新登入過，算恢復。
    pub fn feed_with(&mut self, evs: &[Ev], now_ms: i64, login_file_ms: Option<i64>) -> Option<Alert> {
        let floor = (now_ms - LOOKBACK_MS).max(self.since_ms);
        self.events.extend(evs.iter().copied().filter(|e| e.ts >= floor));
        self.events.retain(|e| e.ts >= floor);
        self.events.sort_by_key(|e| e.ts);
        let last_reply = self.events.iter().filter(|e| e.kind == Kind::Reply).map(|e| e.ts).max();
        let errs: Vec<i64> = self.events.iter().filter(|e| e.kind == Kind::LoginError && last_reply.is_none_or(|r| e.ts > r)).map(|e| e.ts).collect();
        if let Some(&t) = errs.last() {
            self.last_error_ms = t;
        }
        if self.failed {
            // 恢復：①失效之後看到真的模型回覆 ②失效之後登入檔被更新 ③很久沒有新的登入錯誤（標記過期）
            let replied = last_reply.is_some_and(|r| r >= self.last_error_ms);
            let relogin = login_file_ms.is_some_and(|m| m > self.last_error_ms);
            let stale = now_ms - self.last_error_ms >= FAIL_TTL_MS;
            if replied || relogin || stale {
                self.failed = false;
                self.last_notify_ms = None;
                if relogin || stale {
                    // 沒有真回覆當分界：把舊的錯誤整批作廢，免得下一輪又被它們湊成「失效」
                    self.events.clear();
                    self.since_ms = if relogin { login_file_ms.unwrap_or(now_ms) } else { now_ms };
                }
            } else if self.last_notify_ms.is_some_and(|t| now_ms - t >= REMIND_MS) {
                self.last_notify_ms = Some(now_ms);
                return Some(Alert { kind: AlertKind::Reminder, last_error_ms: self.last_error_ms, episode_start_ms: self.episode_start_ms });
            }
            return None;
        }
        // 10 分鐘內 2 筆以上（errs 已排除有真回覆之前的）：相鄰兩筆相距不超過視窗即成立
        if errs.windows(2).any(|w| w[1] - w[0] <= WINDOW_MS) {
            self.failed = true;
            self.last_notify_ms = Some(now_ms);
            self.episode_start_ms = errs[0];
            return Some(Alert { kind: AlertKind::First, last_error_ms: self.last_error_ms, episode_start_ms: self.episode_start_ms });
        }
        None
    }
}

// ---------- 轉交逾時次數（只作佐證，不參與判定） ----------
/// 橋每次因「收發室沒有完成轉交」寄出逾時通知時記一筆（同一個程序內的橋；見 bridge/core.rs）。只留最近 24 小時。
#[derive(Default)]
pub struct TimeoutLog(Mutex<Vec<i64>>);
impl TimeoutLog {
    pub fn record(&self, now_ms: i64) {
        let mut v = self.0.lock().unwrap_or_else(|e| e.into_inner());
        v.push(now_ms);
        v.retain(|&t| t >= now_ms - 24 * 3_600_000);
    }
    /// `since_ms` 起（含）記到的次數
    pub fn count_since(&self, since_ms: i64) -> u32 {
        self.0.lock().unwrap_or_else(|e| e.into_inner()).iter().filter(|&&t| t >= since_ms).count() as u32
    }
}
static FORWARD_TIMEOUTS: TimeoutLog = TimeoutLog(Mutex::new(Vec::new()));
/// 橋寄出「轉交逾時」通知時呼叫
pub fn record_forward_timeout(now_ms: i64) {
    FORWARD_TIMEOUTS.record(now_ms);
}

// ---------- 通知（純函式＋出口） ----------
/// 送給後台的四個欄位（後台依節點查擁有者與組內文；時間一律 UTC）
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Notice {
    pub computer: String,
    /// 最後一次登入錯誤的時間，UTC ISO 8601
    pub last_at: String,
    /// 目前帳號 email；讀不到或格式不像 email 就是 None
    pub email: Option<String>,
    /// 失效期間轉交逾時的次數（佐證用；後台上限 999）
    pub timeouts: u32,
}

impl Notice {
    /// 後台動作 `acct_login_alert` 的 body：只有四個欄位，沒有收件人、沒有錯誤原文
    pub fn payload(&self) -> Value {
        json!({ "computer": self.computer, "last_at": self.last_at, "email": self.email, "timeouts": self.timeouts })
    }
}

fn clean(s: &str, max: usize) -> String {
    s.chars().filter(|c| !c.is_control()).collect::<String>().trim().chars().take(max).collect()
}
/// 毫秒（UTC）轉 `YYYY-MM-DDTHH:MM:SS.000Z`
pub fn iso_utc(ms: i64) -> String {
    let (y, m, d) = crate::usage::civil_from_days(ms.div_euclid(86_400_000));
    let r = ms.rem_euclid(86_400_000);
    format!("{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}.000Z", r / 3_600_000, r / 60_000 % 60, r / 1000 % 60)
}
/// 組通知：只放電腦名、最後錯誤時間、帳號 email、轉交逾時次數
pub fn notice(computer: &str, last_error_ms: i64, email: &str, timeouts: u32) -> Notice {
    let computer = clean(computer, 40);
    let email = clean(email, 100).to_lowercase();
    let email_ok = email.contains('@') && !email.contains(char::is_whitespace);
    Notice {
        computer: if computer.is_empty() { "這台電腦".to_string() } else { computer },
        last_at: iso_utc(last_error_ms),
        email: email_ok.then_some(email),
        timeouts: timeouts.min(999),
    }
}

/// 後台錯誤只記類別，不記回應原文
pub fn classify_error(e: &str) -> &'static str {
    for c in ["rate_limited", "not_claimed", "unknown_to_node", "bad_request"] {
        if e.contains(c) {
            return c;
        }
    }
    if e.contains("連線失敗") {
        "network"
    } else {
        "other"
    }
}

/// 寄給這台電腦擁有者本人的出口。失敗只回類別（[`classify_error`]）。
pub trait OwnerNotifier {
    fn notify_owner(&self, n: &Notice) -> Result<(), String>;
}
/// 真送出：呼叫後台動作 `acct_login_alert`（用節點金鑰，和其他帳號回報同一條連線）。
/// 一次只送一次，不重試；每節點每小時最多 3 封由後台限制。
pub struct RelayNotifier {
    pub relay: std::sync::Arc<crate::relay::Relay>,
}
impl OwnerNotifier for RelayNotifier {
    fn notify_owner(&self, n: &Notice) -> Result<(), String> {
        crate::rt::block_on(self.relay.api("acct_login_alert", Some(n.payload()))).map(|_| ()).map_err(|e| classify_error(&e).to_string())
    }
}

pub struct NoticeCtx {
    pub computer: String,
    /// 目前帳號 email（讀不到給空字串）
    pub email: String,
}

/// 各家目錄各自的判定狀態：不同家目錄的錯誤、回覆、登入檔互不影響
#[derive(Default)]
pub struct Monitor {
    homes: HashMap<PathBuf, (Watch, Tailer)>,
}

impl Monitor {
    /// 一次輪詢：每個家目錄讀新行 → 判定 → 該通知就交給 notifier（同一輪最多送一封）。
    /// `timeouts_since`：給失效起點，回這段時間的轉交逾時次數。log 只收固定句型。回傳任何一個家目錄是否失效。
    pub fn tick(&mut self, roots: &[PathBuf], now_ms: i64, ctx: &NoticeCtx, timeouts_since: &dyn Fn(i64) -> u32, notifier: &dyn OwnerNotifier, mut log: impl FnMut(String)) -> bool {
        self.homes.retain(|p, _| roots.contains(p));
        let mut alert: Option<Alert> = None;
        let mut failed = false;
        for r in roots {
            let (w, t) = self.homes.entry(r.clone()).or_default();
            w.on_account(&ctx.email, now_ms);
            let evs = t.poll(std::slice::from_ref(r), now_ms);
            let cred = std::fs::metadata(r.join(CRED_FILE)).ok().map(|m| crate::usage::mtime_ms(&m));
            if let Some(a) = w.feed_with(&evs, now_ms, cred) {
                if alert.is_none_or(|x| x.kind == AlertKind::Reminder && a.kind == AlertKind::First) {
                    alert = Some(a);
                }
            }
            failed |= w.failed();
        }
        if let Some(a) = alert {
            let n = notice(&ctx.computer, a.last_error_ms, &ctx.email, timeouts_since(a.episode_start_ms));
            let which = if a.kind == AlertKind::First { "首次" } else { "提醒" };
            match notifier.notify_owner(&n) {
                Ok(()) => log(format!("登入失效通知已送出（{which}）")),
                Err(cat) => log(format!("登入失效通知未送出（{which}）：{cat}")),
            }
        }
        failed
    }
}

static STATE: Mutex<Option<Monitor>> = Mutex::new(None);
/// 真實家目錄版本（給帳號回報用）：回傳目前是否登入失效
pub fn tick_real(now_ms: i64, ctx: &NoticeCtx, notifier: &dyn OwnerNotifier) -> bool {
    let mut g = STATE.lock().unwrap_or_else(|e| e.into_inner());
    let m = g.get_or_insert_with(Default::default);
    m.tick(&crate::usage::real_roots(), now_ms, ctx, &|since| FORWARD_TIMEOUTS.count_since(since), notifier, |s| elog!("{s}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use std::path::Path;

    const MIN: i64 = 60_000;
    /// 設計文件第一節那筆真實格式（時間戳另帶）
    fn auth_line(ts: &str) -> String {
        format!(r#"{{"type":"assistant","isApiErrorMessage":true,"error":"authentication_failed","timestamp":"{ts}","message":{{"model":"<synthetic>","content":[{{"type":"text","text":"Login expired · Please run /login"}}]}}}}"#)
    }
    fn err_line(err: &str, ts: &str) -> String {
        auth_line(ts).replace("authentication_failed", err)
    }
    fn reply_line(ts: &str) -> String {
        format!(r#"{{"type":"assistant","timestamp":"{ts}","message":{{"id":"m1","model":"claude-opus-4-5","content":[{{"type":"text","text":"hi"}}],"usage":{{"input_tokens":1,"output_tokens":2}}}}}}"#)
    }
    const T0: &str = "2026-10-30T13:00:00.000Z";
    fn t0() -> i64 {
        crate::usage::parse_ts_ms(T0).unwrap()
    }
    fn ev(kind: Kind, min: i64) -> Ev {
        Ev { kind, ts: t0() + min * MIN }
    }
    fn fail(min: i64) -> Ev {
        ev(Kind::LoginError, min)
    }
    fn reply(min: i64) -> Ev {
        ev(Kind::Reply, min)
    }

    #[test]
    fn 設計文件那筆真實紀錄認得出登入錯誤() {
        assert_eq!(parse_line(&auth_line(T0)), Some(Ev { kind: Kind::LoginError, ts: t0() }));
        assert_eq!(parse_line(&err_line("oauth_org_not_allowed", T0)), Some(Ev { kind: Kind::LoginError, ts: t0() }));
    }

    #[test]
    fn rate_limit_與_server_error_不算() {
        assert_eq!(parse_line(&err_line("rate_limit", T0)), None);
        assert_eq!(parse_line(&err_line("server_error", T0)), None);
        assert_eq!(parse_line(&err_line("", T0)), None);
    }

    #[test]
    fn 真的模型回覆算回覆_合成的與沒有_usage_的不算() {
        assert_eq!(parse_line(&reply_line(T0)), Some(Ev { kind: Kind::Reply, ts: t0() }));
        assert_eq!(parse_line(&reply_line(T0).replace("claude-opus-4-5", "<synthetic>")), None);
        assert_eq!(parse_line(&reply_line(T0).replace(r#","usage":{"input_tokens":1,"output_tokens":2}"#, "")), None);
        assert_eq!(parse_line(r#"{"type":"user","timestamp":"2026-10-30T13:00:00Z","message":{"content":"isApiErrorMessage usage"}}"#), None);
        assert_eq!(parse_line("不是 json isApiErrorMessage"), None);
    }

    #[test]
    fn 一筆不算_兩筆算() {
        let mut w = Watch::default();
        let now = t0() + 5 * MIN;
        assert_eq!(w.feed(&[fail(0)], now), None);
        assert!(!w.failed());
        let a = w.feed(&[fail(2)], now).expect("第二筆要通知");
        assert_eq!(a, Alert { kind: AlertKind::First, last_error_ms: t0() + 2 * MIN, episode_start_ms: t0() });
        assert!(w.failed());
    }

    #[test]
    fn 兩筆相距超過十分鐘不算() {
        let mut w = Watch::default();
        assert_eq!(w.feed(&[fail(0), fail(11)], t0() + 12 * MIN), None);
        // 但後面又來一筆，和 11 分那筆相距在十分鐘內就算
        assert!(w.feed(&[fail(15)], t0() + 16 * MIN).is_some());
    }

    #[test]
    fn 這段期間有真的模型回覆就不算() {
        let mut w = Watch::default();
        assert_eq!(w.feed(&[fail(0), reply(1), fail(2)], t0() + 3 * MIN), None);
        assert!(!w.failed());
        // 回覆之後再兩筆才算
        assert!(w.feed(&[fail(4)], t0() + 5 * MIN).is_some());
    }

    #[test]
    fn 事件不分檔案_不同視窗的兩筆交錯餵進來照算() {
        let mut w = Watch::default();
        assert_eq!(w.feed(&[fail(0)], t0() + MIN), None);
        assert!(w.feed(&[fail(3)], t0() + 4 * MIN).is_some());
    }

    #[test]
    fn 失效期間只通知一次_恢復後可再通知() {
        let mut w = Watch::default();
        assert!(w.feed(&[fail(0), fail(1)], t0() + 2 * MIN).is_some());
        assert_eq!(w.feed(&[fail(3)], t0() + 4 * MIN), None, "失效中不重複通知");
        assert!(w.failed());
        assert_eq!(w.feed(&[reply(5)], t0() + 6 * MIN), None);
        assert!(!w.failed(), "看到真回覆就恢復");
        assert_eq!(w.feed(&[fail(7)], t0() + 8 * MIN), None, "恢復後一筆不算");
        assert!(w.feed(&[fail(9)], t0() + 10 * MIN).is_some(), "恢復後再失效可以再通知");
    }

    #[test]
    fn 失效期間每六小時最多再提醒一次() {
        let mut w = Watch::default();
        let n0 = t0() + 2 * MIN;
        assert!(w.feed(&[fail(0), fail(1)], n0).is_some());
        assert_eq!(w.feed(&[], n0 + REMIND_MS - 1), None, "未滿六小時不提醒");
        let a = w.feed(&[], n0 + REMIND_MS).expect("滿六小時提醒");
        assert_eq!(a.kind, AlertKind::Reminder);
        assert_eq!(a.last_error_ms, t0() + MIN);
        assert_eq!(w.feed(&[], n0 + REMIND_MS + 1), None, "提醒後重新計時");
        w.feed(&[], n0 + 2 * REMIND_MS);
        assert!(!w.failed(), "再六小時已超過標記壽命，不再提醒、標記過期");
    }

    #[test]
    fn 開機不翻舊帳_三十分鐘前的事件不收() {
        let mut w = Watch::default();
        let now = t0() + 60 * MIN;
        assert_eq!(w.feed(&[fail(0), fail(1)], now), None);
        assert!(!w.failed());
        // 在三十分鐘內的才收
        assert!(w.feed(&[fail(31), fail(32)], now).is_some());
    }

    #[test]
    fn 舊事件過了三十分鐘就被丟掉_不會拿來湊成兩筆() {
        let mut w = Watch::default();
        assert_eq!(w.feed(&[fail(0)], t0() + MIN), None);
        assert_eq!(w.feed(&[fail(35)], t0() + 36 * MIN), None, "第一筆已超過三十分鐘");
    }

    // ---------- #589 調查員三點 ----------
    #[test]
    fn 剛換帳號_舊帳號的錯誤不算新帳號的() {
        let mut w = Watch::default();
        w.on_account("a@x.test", t0());
        assert!(w.feed(&[fail(0), fail(1)], t0() + 2 * MIN).is_some());
        assert!(w.failed());
        // 5 分鐘時切到 b：失效狀態清掉
        w.on_account("B@x.test", t0() + 5 * MIN);
        assert!(!w.failed(), "換帳號後不再沿用舊帳號的失效");
        // 舊帳號切換前的錯誤晚到（時間戳在切換之前）：不算
        assert_eq!(w.feed(&[fail(2), fail(3)], t0() + 6 * MIN), None);
        assert!(!w.failed());
        // 切換之後 b 真的連續失敗才算
        assert!(w.feed(&[fail(7), fail(8)], t0() + 9 * MIN).is_some());
        // 同一個帳號（大小寫不同）不算換帳號
        w.on_account("b@X.test", t0() + 10 * MIN);
        assert!(w.failed());
    }

    #[test]
    fn 切換前的一筆加切換後的一筆湊不成兩筆() {
        let mut w = Watch::default();
        w.on_account("a@x.test", t0());
        assert_eq!(w.feed(&[fail(0)], t0() + MIN), None);
        w.on_account("b@x.test", t0() + 2 * MIN);
        assert_eq!(w.feed(&[fail(3)], t0() + 4 * MIN), None, "舊帳號那筆不能拿來和新帳號湊數");
        assert!(!w.failed());
    }

    #[test]
    fn email_讀不到不當作換帳號() {
        let mut w = Watch::default();
        w.on_account("a@x.test", t0());
        assert!(w.feed(&[fail(0), fail(1)], t0() + 2 * MIN).is_some());
        w.on_account("", t0() + 3 * MIN);
        assert!(w.failed());
    }

    #[test]
    fn 登入修好但一直沒用_登入檔更新就算恢復() {
        let mut w = Watch::default();
        assert!(w.feed_with(&[fail(0), fail(1)], t0() + 2 * MIN, Some(t0() - MIN)).is_some());
        assert_eq!(w.feed_with(&[], t0() + 3 * MIN, Some(t0() + MIN)), None, "登入檔沒比最後錯誤新：仍在失效");
        assert!(w.failed());
        assert_eq!(w.feed_with(&[], t0() + 4 * MIN, Some(t0() + 3 * MIN)), None);
        assert!(!w.failed(), "登入檔在失效之後被更新（重新登入）");
        // 舊錯誤已作廢：沒有新錯誤就不會又變回失效；之後再連續失敗才通知
        assert_eq!(w.feed_with(&[], t0() + 5 * MIN, Some(t0() + 3 * MIN)), None);
        assert!(!w.failed());
        assert!(w.feed_with(&[fail(10), fail(11)], t0() + 12 * MIN, Some(t0() + 3 * MIN)).is_some());
    }

    #[test]
    fn 失效標記很久沒有新錯誤就過期() {
        let mut w = Watch::default();
        assert!(w.feed(&[fail(0), fail(1)], t0() + 2 * MIN).is_some());
        let last = t0() + MIN;
        w.feed(&[], last + FAIL_TTL_MS - 1);
        assert!(w.failed(), "未到壽命");
        w.feed(&[], last + FAIL_TTL_MS);
        assert!(!w.failed(), "超過壽命沒有新錯誤，不再顯示失效");
    }

    // ---------- 讀檔 ----------
    fn write(root: &Path, rel: &str, lines: &[String]) -> PathBuf {
        let p = root.join("projects").join(rel);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        let mut f = std::fs::File::create(&p).unwrap();
        for l in lines {
            writeln!(f, "{l}").unwrap();
        }
        p
    }
    fn append(p: &Path, lines: &[String]) {
        let mut f = std::fs::OpenOptions::new().append(true).open(p).unwrap();
        for l in lines {
            writeln!(f, "{l}").unwrap();
        }
    }
    fn now_ms() -> i64 {
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as i64
    }
    fn iso(ms: i64) -> String {
        iso_utc(ms)
    }

    #[test]
    fn 增量讀檔_只讀新增的行_舊檔不翻() {
        let dir = tempfile::tempdir().unwrap();
        let roots = vec![dir.path().to_path_buf()];
        let now = now_ms();
        let p = write(dir.path(), "a/s1.jsonl", &[auth_line(&iso(now - 2 * MIN)), reply_line(&iso(now - MIN))]);
        let old = write(dir.path(), "a/old.jsonl", &[auth_line(&iso(now - 5 * MIN))]);
        let hour_ago = std::time::SystemTime::now() - std::time::Duration::from_secs(3600);
        std::fs::File::options().write(true).open(&old).unwrap().set_modified(hour_ago).unwrap();
        let mut t = Tailer::default();
        let first = t.poll(&roots, now);
        assert_eq!(first.len(), 2, "新檔讀得到最近的行、一小時沒動的舊檔不讀：{first:?}");
        assert!(t.poll(&roots, now).is_empty(), "沒變不重讀");
        append(&p, &[auth_line(&iso(now))]);
        let more = t.poll(&roots, now);
        assert_eq!(more.len(), 1, "只讀新增的行");
        assert_eq!(more[0].kind, Kind::LoginError);
        // 舊檔後來有新增行也讀得到（從記下的位置往後）
        append(&old, &[auth_line(&iso(now))]);
        assert_eq!(t.poll(&roots, now).len(), 1);
    }

    #[test]
    fn 資料夾不存在不出錯() {
        let mut t = Tailer::default();
        assert!(t.poll(&[PathBuf::from("Z:/不存在的資料夾")], now_ms()).is_empty());
    }

    // ---------- 多個家目錄 ----------
    struct Capture(Mutex<Vec<Notice>>);
    impl OwnerNotifier for Capture {
        fn notify_owner(&self, n: &Notice) -> Result<(), String> {
            self.0.lock().unwrap().push(n.clone());
            Ok(())
        }
    }
    fn ctx() -> NoticeCtx {
        NoticeCtx { computer: "工作機".into(), email: "a@x.test".into() }
    }

    #[test]
    fn 兩個家目錄各一筆錯誤_不混在一起湊成兩筆() {
        let (d1, d2) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
        let now = now_ms();
        write(d1.path(), "a/s.jsonl", &[auth_line(&iso(now - 3 * MIN))]);
        write(d2.path(), "a/s.jsonl", &[auth_line(&iso(now - 2 * MIN))]);
        let roots = vec![d1.path().to_path_buf(), d2.path().to_path_buf()];
        let cap = Capture(Mutex::new(vec![]));
        let mut m = Monitor::default();
        let failed = m.tick(&roots, now, &ctx(), &|_| 0, &cap, |_| {});
        assert!(!failed, "各家目錄只有一筆，不算失效");
        assert!(cap.0.lock().unwrap().is_empty());
    }

    #[test]
    fn 另一個家目錄的真回覆不會讓這個家目錄恢復() {
        let (d1, d2) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
        let now = now_ms();
        write(d1.path(), "a/s.jsonl", &[auth_line(&iso(now - 4 * MIN)), auth_line(&iso(now - 3 * MIN))]);
        write(d2.path(), "a/s.jsonl", &[reply_line(&iso(now - MIN))]);
        let roots = vec![d2.path().to_path_buf(), d1.path().to_path_buf()];
        let cap = Capture(Mutex::new(vec![]));
        let mut m = Monitor::default();
        assert!(m.tick(&roots, now, &ctx(), &|_| 0, &cap, |_| {}), "有回覆的家目錄排在前面，另一個家目錄仍是失效");
        assert_eq!(cap.0.lock().unwrap().len(), 1);
    }

    #[test]
    fn 登入檔更新後該家目錄恢復() {
        let d = tempfile::tempdir().unwrap();
        let now = now_ms();
        write(d.path(), "a/s.jsonl", &[auth_line(&iso(now - 4 * MIN)), auth_line(&iso(now - 3 * MIN))]);
        let roots = vec![d.path().to_path_buf()];
        let cap = Capture(Mutex::new(vec![]));
        let mut m = Monitor::default();
        assert!(m.tick(&roots, now, &ctx(), &|_| 0, &cap, |_| {}));
        // 重新登入：登入檔（內容不重要，只看修改時間）出現且比最後錯誤新
        std::fs::write(d.path().join(CRED_FILE), "x").unwrap();
        assert!(!m.tick(&roots, now_ms().max(now) + MIN, &ctx(), &|_| 0, &cap, |_| {}), "登入檔比最後錯誤新＝恢復");
    }

    // ---------- 隱私與通知 ----------
    const SECRET: &str = "SECRET-CONTENT-sk-ant-12345-機密內文";

    #[test]
    fn 訊息內容不會出現在事件_通知_或_log() {
        let now = now_ms();
        let leak = |ts: &str| auth_line(ts).replace("Login expired · Please run /login", SECRET);
        // 事件層：含內容的失效行與回覆行
        let dir = tempfile::tempdir().unwrap();
        write(dir.path(), "a/s.jsonl", &[leak(&iso(now - 3 * MIN)), reply_line(&iso(now - 10_000)).replace("hi", SECRET)]);
        let evs = Tailer::default().poll(&[dir.path().to_path_buf()], now);
        assert_eq!(evs.len(), 2);
        assert!(!format!("{evs:?}").contains("SECRET"), "事件不帶內容");
        // 完整流程：兩筆失效 → 通知 → log
        let dir2 = tempfile::tempdir().unwrap();
        write(dir2.path(), "a/s.jsonl", &[leak(&iso(now - 3 * MIN)), leak(&iso(now - 2 * MIN))]);
        let cap = Capture(Mutex::new(vec![]));
        let mut m = Monitor::default();
        let mut logs = vec![];
        let failed = m.tick(&[dir2.path().to_path_buf()], now, &ctx(), &|_| 2, &cap, |s| logs.push(s));
        assert!(failed);
        let sent = cap.0.lock().unwrap();
        assert_eq!(sent.len(), 1);
        assert!(!logs.is_empty());
        let all = format!("{:?} {:?} {:?} {:?}", sent[0], sent[0].payload(), logs, evs);
        for bad in ["SECRET", "sk-ant", "機密", "Login expired"] {
            assert!(!all.contains(bad), "通知、log、狀態不含紀錄內容（{bad}）：{all}");
        }
        assert_eq!(sent[0].computer, "工作機");
        assert_eq!(sent[0].email.as_deref(), Some("a@x.test"));
        assert_eq!(sent[0].timeouts, 2, "逾時次數取自 timeouts_since");
    }

    #[test]
    fn 內容欄位不進解析結構() {
        // 結構層面的守門：解析用的結構宣告裡沒有內容欄位
        let src = include_str!("login_watch.rs");
        let head = &src[src.find("struct Line {").unwrap()..src.find("pub enum Kind").unwrap()];
        assert!(!head.contains("content:") && !head.contains("text:"), "Line／Msg 不得宣告內容欄位");
    }

    #[test]
    fn 通知只有四個欄位_時間是_utc_沒有時差殘留() {
        let n = notice("工作機", crate::usage::parse_ts_ms("2026-10-30T13:35:00Z").unwrap(), "A@X.test", 3);
        assert_eq!(n.payload(), json!({ "computer": "工作機", "last_at": "2026-10-30T13:35:00.000Z", "email": "a@x.test", "timeouts": 3 }));
        assert_eq!(n.payload().as_object().unwrap().len(), 4, "沒有收件人、沒有其他欄位");
        let n0 = notice("W", 0, "", 0);
        assert_eq!(n0.payload(), json!({ "computer": "W", "last_at": "1970-01-01T00:00:00.000Z", "email": null, "timeouts": 0 }));
        let n1 = notice("A\nB\u{0}", 0, "x y@z", 5000);
        assert!(!n1.computer.contains('\n') && !n1.computer.contains('\u{0}'));
        assert_eq!(n1.email, None, "不像 email 就不送");
        assert_eq!(n1.timeouts, 999);
        assert_eq!(notice("  ", 0, "", 0).computer, "這台電腦");
        assert_eq!(notice(&"長".repeat(80), 0, "", 0).computer.chars().count(), 40);
        let src = include_str!("login_watch.rs");
        assert!(!src.contains(&["tz_offset", "_min"].concat()), "不再有本機時差殘留");
    }

    #[test]
    fn 轉交逾時次數_只算失效起點之後() {
        let l = TimeoutLog::default();
        l.record(1000);
        l.record(5000);
        l.record(9000);
        assert_eq!(l.count_since(5000), 2);
        assert_eq!(l.count_since(0), 3);
        assert_eq!(l.count_since(9001), 0);
        l.record(1000 + 25 * 3_600_000);
        assert_eq!(l.count_since(0), 1, "超過 24 小時的舊紀錄會被清掉");
    }

    #[test]
    fn 後台錯誤只留類別() {
        assert_eq!(classify_error("acct_login_alert HTTP 429 rate_limited"), "rate_limited");
        assert_eq!(classify_error("acct_login_alert HTTP 403 not_claimed"), "not_claimed");
        assert_eq!(classify_error("acct_login_alert HTTP 404 unknown_to_node"), "unknown_to_node");
        assert_eq!(classify_error("acct_login_alert HTTP 400 bad_request"), "bad_request");
        assert_eq!(classify_error("acct_login_alert 連線失敗：timed out SECRET-KEY"), "network");
        assert_eq!(classify_error("acct_login_alert HTTP 500 boom-SECRET"), "other");
    }

    /// 本機假後端：回固定狀態與內容，記下請求（只連 127.0.0.1）
    fn fake_server(status: &str, body: &'static str) -> (String, std::sync::Arc<Mutex<Vec<String>>>) {
        use std::io::{Read, Write};
        let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://127.0.0.1:{}/relay", l.local_addr().unwrap().port());
        let seen = std::sync::Arc::new(Mutex::new(vec![]));
        let s2 = seen.clone();
        let status = status.to_string();
        std::thread::spawn(move || {
            for c in l.incoming() {
                let Ok(mut c) = c else { break };
                let mut buf = vec![0u8; 16384];
                let n = c.read(&mut buf).unwrap_or(0);
                s2.lock().unwrap().push(String::from_utf8_lossy(&buf[..n]).to_string());
                let _ = write!(c, "HTTP/1.1 {status}\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}", body.len());
            }
        });
        (url, seen)
    }

    #[test]
    fn 真送出_打_acct_login_alert_只帶四個欄位() {
        let (url, seen) = fake_server("200 OK", r#"{"ok":true}"#);
        let relay = std::sync::Arc::new(crate::relay::Relay::new(url, "TEST-KEY".into(), "node-w".into(), "w".into()));
        let n = RelayNotifier { relay };
        assert_eq!(n.notify_owner(&notice("工作機", 0, "a@x.test", 2)), Ok(()));
        let reqs = seen.lock().unwrap();
        assert_eq!(reqs.len(), 1);
        assert!(reqs[0].starts_with("POST /relay?action=acct_login_alert"), "{}", reqs[0]);
        let body: Value = serde_json::from_str(reqs[0].split("\r\n\r\n").nth(1).unwrap()).unwrap();
        assert_eq!(body, json!({ "computer": "工作機", "last_at": "1970-01-01T00:00:00.000Z", "email": "a@x.test", "timeouts": 2 }));
    }

    #[test]
    fn 後台拒絕只記類別_不重試_不_panic() {
        for (status, body, cat) in [("429 Too Many Requests", r#"{"error":"rate_limited"}"#, "rate_limited"), ("403 Forbidden", r#"{"error":"not_claimed"}"#, "not_claimed"), ("404 Not Found", r#"{"error":"unknown_to_node"}"#, "unknown_to_node")] {
            let (url, seen) = fake_server(status, body);
            let n = RelayNotifier { relay: std::sync::Arc::new(crate::relay::Relay::new(url, "TEST-KEY".into(), "node-w".into(), "w".into())) };
            assert_eq!(n.notify_owner(&notice("W", 0, "", 0)), Err(cat.to_string()));
            assert_eq!(seen.lock().unwrap().len(), 1, "只打一次，不重試");
        }
        // 連不上（沒有人在聽的埠）：網路錯誤，不 panic
        let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://127.0.0.1:{}/relay", l.local_addr().unwrap().port());
        drop(l);
        let n = RelayNotifier { relay: std::sync::Arc::new(crate::relay::Relay::new(url, "TEST-KEY".into(), "node-w".into(), "w".into())) };
        assert_eq!(n.notify_owner(&notice("W", 0, "", 0)), Err("network".to_string()));
    }

    #[test]
    fn 通知失敗時_失效判定照常_log_只有類別() {
        struct Fail;
        impl OwnerNotifier for Fail {
            fn notify_owner(&self, _: &Notice) -> Result<(), String> {
                Err("rate_limited".into())
            }
        }
        let dir = tempfile::tempdir().unwrap();
        let now = now_ms();
        write(dir.path(), "a/s.jsonl", &[auth_line(&iso(now - 3 * MIN)), auth_line(&iso(now - 2 * MIN))]);
        let mut logs = vec![];
        let mut m = Monitor::default();
        assert!(m.tick(&[dir.path().to_path_buf()], now, &ctx(), &|_| 0, &Fail, |s| logs.push(s)), "通知失敗不影響失效判定");
        assert_eq!(logs, vec!["登入失效通知未送出（首次）：rate_limited".to_string()]);
        m.tick(&[dir.path().to_path_buf()], now + MIN, &ctx(), &|_| 0, &Fail, |s| logs.push(s));
        assert_eq!(logs.len(), 1, "不重試轟炸：失效期間不再送");
    }
}

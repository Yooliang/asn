//! 登入失效偵測（設計：docs/design/LOGIN-EXPIRED-ALERT.md）。
//!
//! Claude 登入壞掉時，對話紀錄（`<家目錄>\.claude\projects\**\*.jsonl`）會多一筆合成的助理回覆，
//! 有結構化欄位 `isApiErrorMessage:true` 與 `error`，不必比對文字。本檔只做三件事：
//! 1. 增量讀紀錄新增的行，轉成 [`Ev`]（只有「登入類錯誤」與「真的模型回覆」兩種，欄位只有種類與時間）；
//! 2. [`Watch`] 狀態機判定失效／恢復／該不該通知；
//! 3. [`notice`] 組通知內文（純函式），經 [`OwnerNotifier`] 交出去。
//!
//! 隱私規定（asn真 審 #579）：讀紀錄只取 `type`／`isApiErrorMessage`／`error`／`model`／`usage` 是否存在／時間戳；
//! 訊息內容與 `text` 不反序列化（結構裡根本沒有那個欄位）、不留、不進通知、不進 log。
//! `Ev` 沒有任何字串欄位，所以不可能把內容帶出去。
//!
//! 紅線：函式一律吃路徑與時間參數；只有 [`tick_real`] 會決定真實家目錄，測試不得呼叫它。
use serde::Deserialize;
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
/// 第一次看到一個檔案時最多讀它最後這麼多位元組
const TAIL_BYTES: u64 = 256 * 1024;
/// 算登入失效的錯誤種類；`rate_limit`（額度用完）與 `server_error`（暫時性）不算
pub const LOGIN_ERRORS: [&str; 2] = ["authentication_failed", "oauth_org_not_allowed"];

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
}

#[derive(Default)]
pub struct Watch {
    events: Vec<Ev>,
    failed: bool,
    last_notify_ms: Option<i64>,
    last_error_ms: i64,
}

impl Watch {
    /// 目前是否判定為登入失效（帳號回報的 `login_failed` 用這個）
    pub fn failed(&self) -> bool {
        self.failed
    }

    /// 餵進新事件並判定。只收最近 30 分鐘內的事件；回傳要不要通知（失效期間只通知一次，每 6 小時最多再提醒一次）。
    pub fn feed(&mut self, evs: &[Ev], now_ms: i64) -> Option<Alert> {
        let floor = now_ms - LOOKBACK_MS;
        self.events.extend(evs.iter().copied().filter(|e| e.ts >= floor));
        self.events.retain(|e| e.ts >= floor);
        self.events.sort_by_key(|e| e.ts);
        let last_reply = self.events.iter().filter(|e| e.kind == Kind::Reply).map(|e| e.ts).max();
        let errs: Vec<i64> = self.events.iter().filter(|e| e.kind == Kind::LoginError && last_reply.is_none_or(|r| e.ts > r)).map(|e| e.ts).collect();
        if let Some(&t) = errs.last() {
            self.last_error_ms = t;
        }
        if self.failed {
            // 恢復：失效之後看到真的模型回覆
            if last_reply.is_some_and(|r| r >= self.last_error_ms) {
                self.failed = false;
                self.last_notify_ms = None;
            } else if self.last_notify_ms.is_some_and(|t| now_ms - t >= REMIND_MS) {
                self.last_notify_ms = Some(now_ms);
                return Some(Alert { kind: AlertKind::Reminder, last_error_ms: self.last_error_ms });
            }
            return None;
        }
        // 10 分鐘內 2 筆以上（errs 已排除有真回覆之前的）：相鄰兩筆相距不超過視窗即成立
        if errs.windows(2).any(|w| w[1] - w[0] <= WINDOW_MS) {
            self.failed = true;
            self.last_notify_ms = Some(now_ms);
            return Some(Alert { kind: AlertKind::First, last_error_ms: self.last_error_ms });
        }
        None
    }
}

// ---------- 通知內文（純函式） ----------
pub struct NoticeInput<'a> {
    pub computer: &'a str,
    pub last_error_ms: i64,
    /// 目前帳號 email；讀不到給空字串
    pub email: &'a str,
    /// 這段時間轉交逾時的次數（佐證用；0 就不寫這一句）
    pub timeouts: u32,
    /// 瀏覽器式時差：UTC 減本機，分鐘（同 usage.rs）
    pub tz_offset_min: i32,
    /// 這台電腦的節點代號；按鈕打開「設備與帳號」時停在這台
    pub node: &'a str,
}
/// 按鈕資料：只開頁面（`openAcct({node})`），不帶任何切換權限、不帶 email、不帶簽章
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Button {
    pub label: &'static str,
    pub action: &'static str,
    pub node: String,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Notice {
    pub body: String,
    pub button: Button,
}

fn clean(s: &str, max: usize) -> String {
    s.chars().filter(|c| !c.is_control()).collect::<String>().trim().chars().take(max).collect()
}
/// 本機時間 HH:MM
pub fn time_text(ms: i64, tz_offset_min: i32) -> String {
    let m = (ms / 60_000 - tz_offset_min as i64).rem_euclid(1440);
    format!("{:02}:{:02}", m / 60, m % 60)
}
/// 組通知：只放電腦名、最後錯誤時間、帳號 email、轉交逾時次數；不帶錯誤原文
pub fn notice(i: &NoticeInput) -> Notice {
    let computer = clean(i.computer, 40);
    let email = clean(i.email, 100);
    let who = if email.is_empty() { "帳號不明".to_string() } else { format!("帳號 {email}") };
    let mut body = format!("「{computer}」的 Claude 登入失效（最後一次錯誤 {}，{who}）。", time_text(i.last_error_ms, i.tz_offset_min));
    if i.timeouts > 0 {
        body.push_str(&format!("這段時間轉交逾時 {} 次。", i.timeouts));
    }
    Notice { body, button: Button { label: "開啟設備與帳號", action: "open_acct", node: clean(i.node, 64) } }
}

/// 寄給這台電腦擁有者本人的出口。實作由後台路徑決定（設計文件第二節「要確認的一點」）；
/// 這裡用 trait 隔開，判定與組裝不依賴它。
pub trait OwnerNotifier {
    fn notify_owner(&self, n: &Notice) -> Result<(), String>;
}
/// 後台「寄給擁有者」的路徑還沒定：先不送，回一句固定的說明（不含任何紀錄內容）
pub struct PendingBackend;
pub const PENDING_BACKEND_MSG: &str = "登入失效通知：後台寄給擁有者的路徑尚未提供，這次不送";
impl OwnerNotifier for PendingBackend {
    fn notify_owner(&self, _: &Notice) -> Result<(), String> {
        Err(PENDING_BACKEND_MSG.to_string())
    }
}

pub struct NoticeCtx {
    pub computer: String,
    pub email: String,
    pub timeouts: u32,
    pub tz_offset_min: i32,
    pub node: String,
}

/// 一次輪詢：讀新行 → 判定 → 該通知就組內文交給 notifier。log 只收固定句型（沒有紀錄內容）。回傳目前是否失效。
pub fn tick(w: &mut Watch, t: &mut Tailer, roots: &[PathBuf], now_ms: i64, ctx: &NoticeCtx, notifier: &dyn OwnerNotifier, mut log: impl FnMut(String)) -> bool {
    let evs = t.poll(roots, now_ms);
    if let Some(a) = w.feed(&evs, now_ms) {
        let n = notice(&NoticeInput { computer: &ctx.computer, last_error_ms: a.last_error_ms, email: &ctx.email, timeouts: ctx.timeouts, tz_offset_min: ctx.tz_offset_min, node: &ctx.node });
        match notifier.notify_owner(&n) {
            Ok(()) => log(format!("登入失效通知已送出（{}）", if a.kind == AlertKind::First { "首次" } else { "提醒" })),
            Err(e) => log(e),
        }
    }
    w.failed()
}

static STATE: Mutex<Option<(Watch, Tailer)>> = Mutex::new(None);
/// 真實家目錄版本（給帳號回報用）：回傳目前是否登入失效
pub fn tick_real(now_ms: i64, ctx: &NoticeCtx) -> bool {
    let mut g = STATE.lock().unwrap_or_else(|e| e.into_inner());
    let (w, t) = g.get_or_insert_with(Default::default);
    tick(w, t, &crate::usage::real_roots(), now_ms, ctx, &PendingBackend, |s| elog!("{s}"))
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
        assert_eq!(a, Alert { kind: AlertKind::First, last_error_ms: t0() + 2 * MIN });
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
        assert!(w.feed(&[], n0 + 2 * REMIND_MS).is_some());
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
        let (y, m, d) = crate::usage::civil_from_days(ms.div_euclid(86_400_000));
        let r = ms.rem_euclid(86_400_000);
        format!("{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}.000Z", r / 3_600_000, r / 60_000 % 60, r / 1000 % 60)
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

    // ---------- 隱私 ----------
    const SECRET: &str = "SECRET-CONTENT-sk-ant-12345-機密內文";
    struct Capture(Mutex<Vec<Notice>>);
    impl OwnerNotifier for Capture {
        fn notify_owner(&self, n: &Notice) -> Result<(), String> {
            self.0.lock().unwrap().push(n.clone());
            Ok(())
        }
    }
    fn ctx() -> NoticeCtx {
        NoticeCtx { computer: "工作機".into(), email: "a@x.test".into(), timeouts: 3, tz_offset_min: -480, node: "node-w".into() }
    }

    #[test]
    fn 訊息內容不會出現在事件_通知內文_或_log() {
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
        let (mut w, mut t2) = (Watch::default(), Tailer::default());
        let mut logs = vec![];
        let failed = tick(&mut w, &mut t2, &[dir2.path().to_path_buf()], now, &ctx(), &cap, |s| logs.push(s));
        assert!(failed);
        let sent = cap.0.lock().unwrap();
        assert_eq!(sent.len(), 1);
        assert!(!logs.is_empty());
        let all = format!("{:?} {:?} {:?} {:?}", sent[0], logs, w.events, evs);
        for bad in ["SECRET", "sk-ant", "機密", "Login expired"] {
            assert!(!all.contains(bad), "通知、log、狀態不含紀錄內容（{bad}）：{all}");
        }
        assert!(sent[0].body.contains("a@x.test") && sent[0].body.contains("工作機"));
    }

    #[test]
    fn 內容欄位不進解析結構() {
        // 結構層面的守門：解析用的結構宣告裡沒有內容欄位
        let src = include_str!("login_watch.rs");
        let head = &src[src.find("struct Line {").unwrap()..src.find("pub enum Kind").unwrap()];
        assert!(!head.contains("content:") && !head.contains("text:"), "Line／Msg 不得宣告內容欄位");
    }

    // ---------- 通知內文 ----------
    #[test]
    fn 通知內文只放電腦名_時間_email_逾時次數_按鈕只開頁面() {
        let n = notice(&NoticeInput { computer: "工作機", last_error_ms: crate::usage::parse_ts_ms("2026-10-30T13:35:00Z").unwrap(), email: "a@x.test", timeouts: 3, tz_offset_min: -480, node: "node-w" });
        assert_eq!(n.body, "「工作機」的 Claude 登入失效（最後一次錯誤 21:35，帳號 a@x.test）。這段時間轉交逾時 3 次。");
        assert_eq!(n.button, Button { label: "開啟設備與帳號", action: "open_acct", node: "node-w".into() });
        let n0 = notice(&NoticeInput { computer: "W", last_error_ms: 0, email: "", timeouts: 0, tz_offset_min: 0, node: "n" });
        assert_eq!(n0.body, "「W」的 Claude 登入失效（最後一次錯誤 00:00，帳號不明）。");
        let n1 = notice(&NoticeInput { computer: "A\nB\u{0}", last_error_ms: 0, email: "x@y.test\r\n", timeouts: 0, tz_offset_min: 0, node: "n" });
        assert!(!n1.body.contains('\n') && !n1.body.contains('\r') && !n1.body.contains('\u{0}'));
    }

    #[test]
    fn 後台路徑未定_空殼送出回固定說明() {
        let n = notice(&NoticeInput { computer: "W", last_error_ms: 0, email: "", timeouts: 0, tz_offset_min: 0, node: "n" });
        assert_eq!(PendingBackend.notify_owner(&n), Err(PENDING_BACKEND_MSG.to_string()));
    }
}

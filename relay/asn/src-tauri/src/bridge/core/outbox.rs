//! 回信寄件匣（#1135）：視窗的回信寄不出去（連線失敗、逾時、讀回應斷、閘道 502～504）時，
//! 連同自己產生的 client_id 存進 `<工作資料夾>/reply-outbox.json`，之後在 tick 裡用同一個 client_id 重寄（後台據此去重）。
//! 寫進去＝已保管：原信照常 ack。4xx（後台明確拒絕）不進寄件匣，照舊走「寄送失敗」流程。
//! 單一處理者：橋本身靠 bridge.pid 互斥（見 lock.rs），同一個工作資料夾只會有一個 Core；Core 是 &mut 單執行緒，另外用 busy 記號擋同一筆重入。
//! log 只記編號與筆數，絕不記內文。
use super::*;
use serde::{Deserialize, Serialize};

pub(super) const OUTBOX_FILE: &str = "reply-outbox.json";
/// 寄件匣最多幾筆「待送」項目／序列化後最多幾位元組（含待通知項）；超過就把最舊那封信放棄並通知
const OUTBOX_MAX_ITEMS: usize = 200;
const OUTBOX_MAX_BYTES: usize = 2 * 1024 * 1024;
/// 「待通知」項（已放棄、只欠一則通知）最多幾筆。體積很小，不計入上面的 200 筆；
/// 超過（通知一直寄不出去）才丟最舊的待通知項，只記 log
const OUTBOX_MAX_PENDING: usize = 100;
/// 每個 tick 最多做幾次「實際送出嘗試」（重寄回信或寄放棄通知）；任一次暫時性失敗就結束這一輪
const OUTBOX_TICK_MAX: usize = 10;
/// 從第一次失敗起超過這麼久就放棄
const OUTBOX_GIVE_UP_MS: u64 = 86_400_000;
/// 第 N 次失敗後多久再寄：15 秒、1、2、5、10、30 分鐘，之後每 30 分鐘
const RETRY_GAPS_MS: [u64; 6] = [15_000, 60_000, 120_000, 300_000, 600_000, 1_800_000];
/// 壞檔通知：失敗後隔多久再試／從啟動起超過多久放棄
const OUTBOX_BAD_RETRY_MS: u64 = 60_000;
const OUTBOX_BAD_GIVE_UP_MS: u64 = 3_600_000;
const ATTACH_GONE_TRAILER: &str = "（附件已過期，沒有附上）";

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub(super) struct OutboxItem {
    pub client_id: String,
    pub to_node: String,
    pub to_agent: String,
    pub body: String,
    pub reply_to: String,
    pub from_agent: String,
    pub expects_reply: Option<bool>,
    #[serde(default)]
    pub attachment_ids: Vec<String>,
    pub first_failed_at: u64,
    pub attempts: u32,
    pub next_at: u64,
    /// 不是 None＝這封信已放棄（值是原因），這筆只代表「還欠原寄件人一則放棄通知」：body 已清空、不再重寄回信。
    /// 通知送達才真正移除。舊版存檔沒有這個欄位，讀回來當 None（serde default），新舊檔案互通
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub gave_up: Option<String>,
}

impl OutboxItem {
    /// 轉成「待通知」項：清掉回信內文與附件，計時重來（通知本身也有 24 小時的期限）
    fn into_pending_notice(mut self, reason: &str, now: u64) -> OutboxItem {
        self.gave_up = Some(reason.to_string());
        self.body = String::new();
        self.attachment_ids.clear();
        self.first_failed_at = now;
        self.attempts = 0;
        self.next_at = now;
        self
    }

    fn request_body(&self) -> Value {
        let mut b = json!({ "to_node": self.to_node, "body": self.body, "reply_to": self.reply_to, "from_agent": self.from_agent, "client_id": self.client_id });
        if !self.to_agent.is_empty() {
            b["to_agent"] = json!(self.to_agent);
        }
        if let Some(e) = self.expects_reply {
            b["expects_reply"] = json!(e);
        }
        if !self.attachment_ids.is_empty() {
            b["attachment_ids"] = json!(self.attachment_ids);
        }
        b
    }
}

#[derive(Serialize, Deserialize)]
struct OutboxFile {
    v: u32,
    items: Vec<OutboxItem>,
}

fn file_text(items: &[OutboxItem]) -> String {
    serde_json::to_string(&json!({ "v": 1, "items": items })).unwrap_or_default()
}

fn retry_gap(attempts: u32) -> u64 {
    let i = (attempts.max(1) as usize - 1).min(RETRY_GAPS_MS.len() - 1);
    RETRY_GAPS_MS[i]
}

/// 壞檔最多保留幾個
const BAD_KEEP: usize = 5;
/// 改名失敗時的「已通知」標記檔（內容記壞檔的大小與修改時間）；不算進壞檔保留名額
const BAD_MARK: &str = ".bad-notified";

/// 壞檔的指紋（大小、修改時間毫秒）；讀不到就回 None
fn file_sig(file: &std::path::Path) -> Option<Value> {
    let md = std::fs::metadata(file).ok()?;
    let ms = md.modified().ok()?.duration_since(std::time::UNIX_EPOCH).ok()?.as_millis() as u64;
    Some(json!({ "size": md.len(), "mtime_ms": ms }))
}

/// 壞檔排序用時間戳：`.bad-<毫秒>` 取毫秒；舊格式 `.bad` 與解析不出來的都當 0（最舊）。不是壞檔回 None
fn bad_stamp(name: &str) -> Option<u64> {
    let rest = name.strip_prefix(OUTBOX_FILE)?;
    if rest.starts_with(BAD_MARK) {
        return None; // 標記檔（含它的暫存檔）不是壞檔
    }
    if rest == ".bad" {
        return Some(0);
    }
    rest.strip_prefix(".bad-").map(|t| t.parse::<u64>().unwrap_or(0))
}

/// 只留最新 keep 個壞檔，其餘刪掉；回傳要記的 log 行（只記檔名，不記內容）。刪除失敗只記 log
fn prune_bad_files(work_dir: &std::path::Path, keep: usize, remove: &dyn Fn(&std::path::Path) -> std::io::Result<()>) -> Vec<String> {
    let Ok(rd) = std::fs::read_dir(work_dir) else { return vec![] };
    let mut found: Vec<(u64, String)> = rd
        .filter_map(|e| e.ok())
        .filter_map(|e| e.file_name().to_str().map(str::to_string))
        .filter_map(|n| bad_stamp(&n).map(|t| (t, n)))
        .collect();
    found.sort();
    let drop_n = found.len().saturating_sub(keep);
    let mut logs = vec![];
    for (_, name) in found.into_iter().take(drop_n) {
        match remove(&work_dir.join(&name)) {
            Ok(()) => logs.push(format!("reply outbox: 壞檔超過 {keep} 個，已刪除最舊的 {name}")),
            Err(e) => logs.push(format!("reply outbox: 刪除舊壞檔 {name} 失敗：{e}")),
        }
    }
    logs
}

#[derive(Default)]
pub(super) struct Outbox {
    pub items: Vec<OutboxItem>,
    /// 正在重寄的 client_id（處理中標記）
    pub busy: HashSet<String>,
    file: PathBuf,
}

impl Outbox {
    /// 讀回存檔；壞檔改名成 .bad-<毫秒> 留著（不直接當沒有，免得丟信）。
    /// 回傳（內容, 要寫進 log 的行, 要不要通知本人）。
    pub fn load(work_dir: &std::path::Path) -> (Outbox, Vec<String>, bool) {
        Self::load_with(work_dir, &|from, to| std::fs::rename(from, to))
    }

    /// 同 load，改名動作可注入（測試用來製造改名失敗）
    pub(super) fn load_with(work_dir: &std::path::Path, rename: &dyn Fn(&std::path::Path, &std::path::Path) -> std::io::Result<()>) -> (Outbox, Vec<String>, bool) {
        let file = work_dir.join(OUTBOX_FILE);
        let mut logs: Vec<String> = vec![];
        let mut notify = false;
        // 沒有檔＝空的；讀不了（非 UTF-8、權限、被占用）或解析失敗都當壞檔，免得下一次存檔蓋掉原檔
        let parsed: Result<Vec<OutboxItem>, String> = match std::fs::read_to_string(&file) {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(vec![]),
            Err(e) => Err(e.to_string()),
            Ok(t) => serde_json::from_str::<OutboxFile>(&t).map(|f| f.items).map_err(|e| e.to_string()),
        };
        let items = match parsed {
            Ok(items) => items,
            Err(e) => {
                // 檔名帶毫秒時間戳，不蓋掉先前留下的 .bad；同一毫秒已有同名檔就往後找沒用過的
                let mut stamp = crate::heartbeat::now_ms();
                let mut bad = work_dir.join(format!("{OUTBOX_FILE}.bad-{stamp}"));
                while bad.exists() {
                    stamp += 1;
                    bad = work_dir.join(format!("{OUTBOX_FILE}.bad-{stamp}"));
                }
                match rename(&file, &bad) {
                    Ok(()) => {
                        logs.push(format!("reply outbox file unreadable, moved to {OUTBOX_FILE}.bad-{stamp}: {e}"));
                        // 改名成功才通知：壞檔已離開原位，下次啟動不會再被判成壞檔
                        notify = true;
                        // 殘留的「已通知」標記（先前改名失敗留下的）已無用，刪掉；刪不掉只記 log
                        let mark = work_dir.join(format!("{OUTBOX_FILE}{BAD_MARK}"));
                        if let Err(me) = std::fs::remove_file(&mark) {
                            if me.kind() != std::io::ErrorKind::NotFound {
                                logs.push(format!("reply outbox: 刪除標記檔 {OUTBOX_FILE}{BAD_MARK} 失敗：{me}"));
                            }
                        }
                        logs.extend(prune_bad_files(work_dir, BAD_KEEP, &|p| std::fs::remove_file(p)));
                    }
                    Err(re) => {
                        // 改名失敗＝原壞檔還留在原處，下次啟動會再被判成壞檔。只通知一次：
                        // 標記檔記著上次通知時這份壞檔的大小＋修改時間，相符就不再通知（只記 log），不相符（沒標記或壞檔變了）才通知並更新標記。
                        // 讀不到壞檔指紋時無法標記，寧可通知（訊號不丟）
                        let mark = work_dir.join(format!("{OUTBOX_FILE}{BAD_MARK}"));
                        let sig = file_sig(&file);
                        let marked = sig.is_some() && std::fs::read_to_string(&mark).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok()) == sig;
                        let mut line = format!("reply outbox file unreadable ({e}), and rename to {OUTBOX_FILE}.bad-{stamp} failed: {re}");
                        if marked {
                            line.push_str("; 這份壞檔已通知過，不再通知");
                        } else {
                            notify = true;
                            if let Some(sg) = &sig {
                                if let Err(we) = pending::save_atomic(&mark, sg) {
                                    logs.push(format!("reply outbox: 寫標記檔 {OUTBOX_FILE}{BAD_MARK} 失敗：{we}"));
                                }
                            }
                        }
                        logs.push(line);
                    }
                }
                vec![]
            }
        };
        (Outbox { items, busy: HashSet::new(), file }, logs, notify)
    }

    /// 這封信還有沒有「待送」的片段（已放棄、只剩通知的不算：放棄之後新來的片段另算）
    pub fn has_reply(&self, reply_to: &str) -> bool {
        self.items.iter().any(|i| i.gave_up.is_none() && i.reply_to == reply_to)
    }

    fn save(&self, items: &[OutboxItem]) -> std::io::Result<()> {
        let v: Value = serde_json::from_str(&file_text(items)).unwrap_or(Value::Null);
        pending::save_atomic(&self.file, &v)
    }

    /// 存檔（失敗只回說明，由呼叫端決定怎麼辦）
    fn persist(&self) -> Result<(), String> {
        self.save(&self.items).map_err(|e| e.to_string())
    }
}

/// 回信寄送的結果
pub(super) enum ReplyOutcome {
    Sent,
    /// 暫時寄不出去，已存進寄件匣
    Stored,
    /// 後台明確拒絕，或寄件匣寫不進去（同一封信已有前段存進寄件匣時不會回這個，見 send_reply）
    Failed,
}

enum Resend {
    Done,
    Retry,
    GiveUp(&'static str),
}

fn attach_gone(e: &str) -> bool {
    e.contains("HTTP 400 bad_attachment")
}

impl Core {
    /// 寄一則視窗的回信：先用自己產生的 client_id 寄一次（relay 內層照舊快速重試）。
    /// 暫時性失敗進寄件匣；同一封信前面的片段還在寄件匣時，後面的片段直接排在後面（保序）。
    /// 前段已存進寄件匣、後段卻存不進去（寫檔失敗、單筆超過 2MB）：不能回 Failed——Failed 會讓原信留在信箱重新投遞，
    /// 視窗又用新的 client_id 重答一次，前段就重複寄了。改成整封信標記放棄、通知原寄件人，仍回 Stored 讓原信照常 ack
    pub(super) async fn send_reply(&mut self, from: &str, o: &Origin, body: &str, expects: Option<bool>) -> ReplyOutcome {
        let raw = dev_prefix::without_old_head(body, Some(from));
        let body = dev_prefix::with_notice_prefix(raw, Some(from), None);
        let item = OutboxItem {
            client_id: crate::relay::new_client_id(),
            to_node: o.from_node.clone(),
            to_agent: o.from_agent.clone(),
            body,
            reply_to: o.id.clone(),
            from_agent: from.to_string(),
            expects_reply: expects,
            // 目前橋的回信一律不帶附件，這裡永遠是空的；附件過期改寄那段（outbox_resend）是給之後有附件時用的
            attachment_ids: vec![],
            first_failed_at: self.now,
            attempts: 0,
            next_at: 0,
            gave_up: None,
        };
        if self.outbox.has_reply(&o.id) {
            return match self.outbox_store(item).await {
                ReplyOutcome::Failed => {
                    self.log.line(&format!("reply id={} later part cannot be stored: giving up the whole mail", o.id));
                    self.outbox_give_up(&o.id, "回信存不進寄件匣").await;
                    ReplyOutcome::Stored
                }
                r => r,
            };
        }
        match self.relay.api("send", Some(item.request_body())).await {
            Ok(v) => {
                self.log_attach_missing(&o.id, &v);
                ReplyOutcome::Sent
            }
            Err(e) => {
                self.log.line(&format!("send back failed id={}: {e}", o.id));
                if crate::relay::is_transient_api_err(&e) {
                    self.outbox_store(item).await
                } else {
                    ReplyOutcome::Failed
                }
            }
        }
    }

    fn log_attach_missing(&self, reply_to: &str, resp: &Value) {
        let n = resp.get("attachments_missing").and_then(Value::as_array).map_or(0, |a| a.len());
        if n > 0 {
            self.log.line(&format!("reply id={reply_to} sent but {n} attachment(s) missing (not resent)"));
        }
    }

    async fn outbox_store(&mut self, mut item: OutboxItem) -> ReplyOutcome {
        item.first_failed_at = self.now;
        item.attempts = 1;
        item.next_at = self.now + retry_gap(1);
        let now = self.now;
        let first_of_mail = !self.outbox.has_reply(&item.reply_to);
        let mut next = self.outbox.items.clone();
        next.push(item.clone());
        // 超過上限：把最舊的一封「待送」的信（所有片段）放棄，只留一筆待通知項代表它（不會只丟前段、留下後段單獨送出）。
        // 上限邊界：200 筆只算待送項；位元組上限算全部。位元組還是超過、而且已沒有可放棄的待送項（剩剛來的這封）時，
        // 才丟最舊的待通知項（只記 log）。待通知項另有 100 筆的上限，超過一樣丟最舊的
        let mut evicted: Vec<OutboxItem> = vec![];
        loop {
            let live = next.iter().filter(|i| i.gave_up.is_none()).count();
            if live <= OUTBOX_MAX_ITEMS && file_text(&next).len() <= OUTBOX_MAX_BYTES {
                break;
            }
            let oldest = next.iter().find(|i| i.gave_up.is_none() && i.reply_to != item.reply_to).map(|i| i.reply_to.clone());
            if let Some(rt) = oldest {
                let (gone, keep): (Vec<OutboxItem>, Vec<OutboxItem>) = next.into_iter().partition(|i| i.gave_up.is_none() && i.reply_to == rt);
                next = keep;
                if let Some(first) = gone.into_iter().next() {
                    let pending = first.into_pending_notice("待送的回信太多", now);
                    next.push(pending.clone());
                    evicted.push(pending);
                }
            } else if let Some(pos) = next.iter().position(|i| i.gave_up.is_some()) {
                let d = next.remove(pos);
                self.log.line(&format!("outbox full: dropped a pending give-up notice id={} client_id={} (not delivered)", d.reply_to, d.client_id));
                evicted.retain(|e| e.client_id != d.client_id);
            } else {
                break;
            }
        }
        while next.iter().filter(|i| i.gave_up.is_some()).count() > OUTBOX_MAX_PENDING {
            let Some(pos) = next.iter().position(|i| i.gave_up.is_some()) else { break };
            let d = next.remove(pos);
            self.log.line(&format!("too many pending give-up notices: dropped the oldest id={} client_id={} (not delivered)", d.reply_to, d.client_id));
            evicted.retain(|e| e.client_id != d.client_id);
        }
        if file_text(&next).len() > OUTBOX_MAX_BYTES {
            self.log.line(&format!("reply id={} too big for the outbox: not stored", item.reply_to));
            return ReplyOutcome::Failed;
        }
        if let Err(e) = self.outbox.save(&next) {
            self.log.line(&format!("reply outbox save failed id={}: {e}", item.reply_to));
            return ReplyOutcome::Failed;
        }
        self.outbox.items = next;
        self.log.line(&format!("reply id={} client_id={} queued in outbox ({} in outbox)", item.reply_to, item.client_id, self.outbox.items.len()));
        for ev in evicted {
            self.log.line(&format!("outbox full: gave up oldest reply id={} client_id={}", ev.reply_to, ev.client_id));
            self.outbox_notify_pending(&ev).await;
        }
        if first_of_mail && !self.is_engine_window(&item.from_agent) {
            let w = item.from_agent.clone();
            self.tell_window(&w, "[收發室] 你剛才的回信暫時寄不出去，收發室會自動重寄，不用再寄一次。（這是系統通知，不用回覆。）");
        }
        ReplyOutcome::Stored
    }

    /// 寄一則「待通知」項的放棄通知：寄給原寄件人（bridge_notice，寄件人是系統的「ASN 通知」，不以視窗名義），內文不含回信內文。
    /// 送達才從寄件匣移除、並告訴回信的視窗（只這一次）；沒送達就保留、依退避之後再寄。回傳是否送達
    async fn outbox_notify_pending(&mut self, it: &OutboxItem) -> bool {
        let reason = it.gave_up.clone().unwrap_or_default();
        let o = Origin { id: it.reply_to.clone(), from_node: it.to_node.clone(), from_agent: it.to_agent.clone() };
        let text = format!("收發室：{} 對你這封信的回覆沒能送出（{reason}，已放棄）。請再問一次。（原信編號 {}）", it.from_agent, it.reply_to);
        let ok = self.send_back(&o, &text, None, None).await;
        self.log.line(&format!("outbox gave up id={} client_id={} reason={reason} notified={ok}", it.reply_to, it.client_id));
        if ok {
            self.outbox_remove(&it.client_id);
            if !self.is_engine_window(&it.from_agent) {
                let w = it.from_agent.clone();
                self.tell_window(&w, &format!("[收發室] 你之前對信件 {} 的回信一直沒能送出，已放棄，並已通知對方。（這是系統通知，不用回覆。）", it.reply_to));
            }
        } else {
            let mut n = it.clone();
            n.attempts += 1;
            n.next_at = self.now + retry_gap(n.attempts);
            self.outbox_update(&n);
        }
        ok
    }

    /// 放棄同一封信所有待送的片段：換成一筆待通知項（只留第一筆當代表、其餘刪除），存檔後馬上試著通知一次。回傳通知是否送達。
    /// 通知寄不出去時待通知項留在寄件匣，由 outbox_tick 之後重試
    async fn outbox_give_up(&mut self, reply_to: &str, reason: &str) -> bool {
        let now = self.now;
        let (gone, keep): (Vec<OutboxItem>, Vec<OutboxItem>) = self.outbox.items.iter().cloned().partition(|i| i.gave_up.is_none() && i.reply_to == reply_to);
        let Some(first) = gone.into_iter().next() else { return true };
        let pending = first.into_pending_notice(reason, now);
        let mut next = keep;
        next.push(pending.clone());
        self.outbox.items = next;
        if let Err(e) = self.outbox.persist() {
            // 連待通知都存不進檔：記憶體裡照樣留著、馬上通知；重開機就沒了，至少留 log
            self.log.line(&format!("reply outbox save failed (give-up notice not persisted) id={reply_to}: {e}"));
        }
        self.outbox_notify_pending(&pending).await
    }

    fn outbox_remove(&mut self, client_id: &str) {
        self.outbox.items.retain(|x| x.client_id != client_id);
        if let Err(e) = self.outbox.persist() {
            self.log.line(&format!("reply outbox save failed: {e}"));
        }
    }

    fn outbox_update(&mut self, it: &OutboxItem) {
        if let Some(x) = self.outbox.items.iter_mut().find(|x| x.client_id == it.client_id) {
            *x = it.clone();
        }
        if let Err(e) = self.outbox.persist() {
            self.log.line(&format!("reply outbox save failed: {e}"));
        }
    }

    async fn outbox_resend(&mut self, mut it: OutboxItem) -> Resend {
        let now = self.now;
        let mut res = self.relay.api("send", Some(it.request_body())).await;
        if let Err(e) = &res {
            if !it.attachment_ids.is_empty() && attach_gone(e) {
                self.log.line(&format!("reply id={} attachments expired: resending without them", it.reply_to));
                it.attachment_ids.clear();
                it.body = format!("{}\n{ATTACH_GONE_TRAILER}", it.body);
                self.outbox_update(&it);
                res = self.relay.api("send", Some(it.request_body())).await;
            }
        }
        match res {
            Ok(v) => {
                self.log_attach_missing(&it.reply_to, &v);
                self.outbox.items.retain(|x| x.client_id != it.client_id);
                if let Err(e) = self.outbox.persist() {
                    self.log.line(&format!("reply outbox save failed: {e}"));
                }
                self.corr_note(&it.from_agent, Dir::Replied, &it.from_agent, &Self::node_agent(&it.to_node, &it.to_agent), &it.reply_to, &it.body, &[]);
                self.log.line(&format!("reply id={} resent from outbox client_id={} after {} attempt(s) ({} left)", it.reply_to, it.client_id, it.attempts, self.outbox.items.len()));
                Resend::Done
            }
            Err(e) if crate::relay::is_transient_api_err(&e) => {
                it.attempts += 1;
                it.next_at = now + retry_gap(it.attempts);
                self.outbox_update(&it);
                self.log.line(&format!("reply id={} resend failed (attempt {}): {e}", it.reply_to, it.attempts));
                Resend::Retry
            }
            Err(e) => {
                self.log.line(&format!("reply id={} resend rejected: {e}", it.reply_to));
                Resend::GiveUp("對方收不到")
            }
        }
    }

    /// 啟動時發現寄件匣存檔壞了：請後台寄一則固定內文的通知給本人（節點擁有者）。後台每台每小時最多一則。
    /// 做法同 mux_blind_tick：網路錯、5xx 隔 60 秒再試（開機自啟時網路常常還沒通），從啟動起超過一小時就放棄；
    /// 4xx（含舊後台沒有這個動作的 404）立即放棄、只記 log。成功（200）就清旗標。log 不含任何回信內文
    pub(super) async fn outbox_bad_notice_tick(&mut self, now: u64) {
        let Some(since) = self.outbox_bad_pending else { return };
        if now < self.outbox_bad_retry_at {
            return;
        }
        if now.saturating_sub(since) > OUTBOX_BAD_GIVE_UP_MS {
            self.outbox_bad_pending = None;
            self.log.line("outbox bad file: 過了一小時，不再通知");
            return;
        }
        match self.relay.api_status("outbox_bad_notice", json!({})).await {
            Ok((200, v)) => {
                self.outbox_bad_pending = None;
                let notify = v.get("notify").and_then(Value::as_str).unwrap_or("");
                self.log.line(&format!("outbox bad file: owner notice requested notify={notify}"));
            }
            Ok((status, _)) if (400..500).contains(&status) => {
                self.outbox_bad_pending = None;
                self.log.line(&format!("outbox bad file: 後台回 {status}，只留本機紀錄"));
            }
            Ok((status, _)) => {
                self.outbox_bad_retry_at = now + OUTBOX_BAD_RETRY_MS;
                self.log.line(&format!("outbox bad file: 後台回 {status}，稍後再試"));
            }
            Err(e) => {
                self.outbox_bad_retry_at = now + OUTBOX_BAD_RETRY_MS;
                self.log.line(&format!("outbox bad file: owner notice failed: {e}"));
            }
        }
    }

    /// 處理到期的寄件匣（每個 tick 呼叫）。同一封信的片段依序：前面的還沒送出，後面的等著。
    /// 一輪最多 OUTBOX_TICK_MAX 次實際送出嘗試（重寄、寄放棄通知都算）；任一次暫時性失敗（網路大概整個不通）就結束這一輪。
    /// 「超過 24 小時」的檢查本身不算嘗試，但放棄後馬上寄的那則通知算一次
    pub(super) async fn outbox_tick(&mut self, now: u64) {
        if self.outbox.items.is_empty() {
            return;
        }
        let ids: Vec<String> = self.outbox.items.iter().map(|i| i.client_id.clone()).collect();
        let mut blocked: HashSet<String> = HashSet::new();
        let mut tries = 0usize;
        for cid in ids {
            if tries >= OUTBOX_TICK_MAX {
                break;
            }
            let Some(it) = self.outbox.items.iter().find(|i| i.client_id == cid).cloned() else { continue };
            if it.gave_up.is_some() {
                // 待通知項：到期就重寄通知；通知本身超過 24 小時也寄不出去就丟掉（只記 log）
                if now.saturating_sub(it.first_failed_at) > OUTBOX_GIVE_UP_MS {
                    self.log.line(&format!("outbox give-up notice for id={} undeliverable for 24h: dropped", it.reply_to));
                    self.outbox_remove(&cid);
                    continue;
                }
                if it.next_at > now || !self.outbox.busy.insert(cid.clone()) {
                    continue;
                }
                tries += 1;
                let ok = self.outbox_notify_pending(&it).await;
                self.outbox.busy.remove(&cid);
                if !ok {
                    break;
                }
                continue;
            }
            if blocked.contains(&it.reply_to) {
                continue;
            }
            blocked.insert(it.reply_to.clone());
            if now.saturating_sub(it.first_failed_at) > OUTBOX_GIVE_UP_MS {
                tries += 1;
                if !self.outbox_give_up(&it.reply_to, "網路一直不通").await {
                    break;
                }
                continue;
            }
            if it.next_at > now || !self.outbox.busy.insert(cid.clone()) {
                continue;
            }
            tries += 1;
            let r = self.outbox_resend(it.clone()).await;
            self.outbox.busy.remove(&cid);
            match r {
                Resend::Done => {
                    blocked.remove(&it.reply_to);
                }
                Resend::Retry => break,
                Resend::GiveUp(why) => {
                    tries += 1;
                    if !self.outbox_give_up(&it.reply_to, why).await {
                        break;
                    }
                }
            }
        }
    }

    /// 測試用
    #[cfg(test)]
    pub(crate) fn outbox_ids(&self) -> Vec<String> {
        self.outbox.items.iter().map(|i| i.client_id.clone()).collect()
    }
    #[cfg(test)]
    pub(crate) fn outbox_reply_tos(&self) -> Vec<String> {
        self.outbox.items.iter().map(|i| i.reply_to.clone()).collect()
    }
    #[cfg(test)]
    pub(crate) fn outbox_pending_notices(&self) -> usize {
        self.outbox.items.iter().filter(|i| i.gave_up.is_some()).count()
    }
    #[cfg(test)]
    pub(crate) fn outbox_mark_busy(&mut self, cid: &str) {
        self.outbox.busy.insert(cid.to_string());
    }
    /// 測試用：直接塞一筆（寄給 W/W-政策、視窗 T-乙）
    #[cfg(test)]
    pub(crate) fn outbox_test_push(&mut self, reply_to: &str, attachment_ids: Vec<String>, first_failed_at: u64, next_at: u64) -> String {
        let client_id = crate::relay::new_client_id();
        self.outbox.items.push(OutboxItem { client_id: client_id.clone(), to_node: "W".into(), to_agent: "W-政策".into(), body: "附件信".into(), reply_to: reply_to.into(), from_agent: "T-乙".into(), expects_reply: None, attachment_ids, first_failed_at, attempts: 1, next_at, gave_up: None });
        self.outbox.persist().unwrap();
        client_id
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 哪些錯誤算暫時性() {
        use crate::relay::is_transient_api_err as t;
        assert!(t("send 連線失敗：error sending request（逾時）"));
        assert!(t("send 連線失敗：讀回應中斷"));
        assert!(t("send HTTP 502") && t("send HTTP 503 gateway") && t("send HTTP 504"));
        assert!(t("send HTTP 408") && t("send HTTP 429 rate_limited") && t("send HTTP 500 internal"));
        assert!(!t("send HTTP 400 bad_attachment") && !t("send HTTP 422 not_receivable") && !t("send HTTP 404 not_found") && !t("send HTTP 501"));
    }

    #[test]
    fn 重寄間隔() {
        assert_eq!([1, 2, 3, 4, 5, 6, 7, 50].map(retry_gap), [15_000, 60_000, 120_000, 300_000, 600_000, 1_800_000, 1_800_000, 1_800_000]);
    }

    #[test]
    fn 壞檔改名失敗_同一份只通知一次_壞檔變了再通知_成功後刪標記() {
        let d = tempfile::tempdir().unwrap();
        std::fs::write(d.path().join(OUTBOX_FILE), "{ 壞").unwrap();
        let fail = |_: &std::path::Path, _: &std::path::Path| -> std::io::Result<()> { Err(std::io::Error::new(std::io::ErrorKind::PermissionDenied, "locked")) };
        let (ob, logs, notify) = Outbox::load_with(d.path(), &fail);
        assert!(ob.items.is_empty());
        assert!(notify, "第一次改名失敗要通知（訊號不能丟）");
        assert!(logs.iter().any(|l| l.contains("rename") && l.contains("failed")), "{logs:?}");
        assert!(d.path().join(OUTBOX_FILE).exists(), "原壞檔還在原處");
        let mark = d.path().join(format!("{OUTBOX_FILE}{BAD_MARK}"));
        assert!(mark.exists(), "寫了已通知標記");
        // 同一份壞檔第二次啟動：不再通知
        let (_, logs, notify) = Outbox::load_with(d.path(), &fail);
        assert!(!notify, "{logs:?}");
        assert!(logs.iter().any(|l| l.contains("不再通知")), "{logs:?}");
        // 壞檔內容變了（大小不同）：再通知一次，並更新標記
        std::fs::write(d.path().join(OUTBOX_FILE), "{ 壞得不一樣、更長").unwrap();
        let (_, _, notify) = Outbox::load_with(d.path(), &fail);
        assert!(notify, "壞檔變了要再通知");
        let (_, _, notify) = Outbox::load_with(d.path(), &fail);
        assert!(!notify, "更新標記後又不再通知");
        // 只有修改時間不同（大小相同）也再通知
        let f = std::fs::OpenOptions::new().write(true).open(d.path().join(OUTBOX_FILE)).unwrap();
        f.set_modified(std::time::SystemTime::now() + std::time::Duration::from_secs(10)).unwrap();
        drop(f);
        let (_, _, notify) = Outbox::load_with(d.path(), &fail);
        assert!(notify, "修改時間變了要再通知");
        // 標記檔不算進壞檔保留名額
        assert_eq!(bad_stamp(&format!("{OUTBOX_FILE}{BAD_MARK}")), None);
        assert_eq!(bad_stamp(&format!("{OUTBOX_FILE}{BAD_MARK}.123.tmp")), None);
        // 改名成功則通知，並刪掉標記
        let (_, logs, notify) = Outbox::load(d.path());
        assert!(notify && logs.iter().any(|l| l.contains("moved to")), "{logs:?}");
        assert!(!d.path().join(OUTBOX_FILE).exists());
        assert!(!mark.exists(), "改名成功後標記被刪");
    }

    fn names(d: &std::path::Path) -> Vec<String> {
        let mut v: Vec<String> = std::fs::read_dir(d).unwrap().filter_map(|e| e.ok()?.file_name().to_str().map(str::to_string)).collect();
        v.sort();
        v
    }

    #[test]
    fn 壞檔只留最新五個_舊格式算最舊_依數值不是字串排序() {
        let d = tempfile::tempdir().unwrap();
        for n in [OUTBOX_FILE.to_string() + ".bad", format!("{OUTBOX_FILE}.bad-9"), format!("{OUTBOX_FILE}.bad-100"), format!("{OUTBOX_FILE}.bad-200"), format!("{OUTBOX_FILE}.bad-300"), format!("{OUTBOX_FILE}.bad-400"), format!("{OUTBOX_FILE}.bad-500"), "other.txt".to_string()] {
            std::fs::write(d.path().join(n), "x").unwrap();
        }
        let logs = prune_bad_files(d.path(), BAD_KEEP, &|p| std::fs::remove_file(p));
        // 7 個壞檔留 5 個＝刪 2 個：舊格式 .bad（算最舊）與 .bad-9（數值最小；字串排序的話會誤刪 .bad-100）
        assert_eq!(logs.len(), 2, "{logs:?}");
        assert!(logs.iter().all(|l| l.contains("已刪除")));
        let left = names(d.path());
        assert_eq!(left.len(), 6, "{left:?}");
        assert!(left.contains(&"other.txt".to_string()));
        for gone in [".bad", ".bad-9"] {
            assert!(!left.contains(&format!("{OUTBOX_FILE}{gone}")), "{gone} 應被刪");
        }
        for kept in [".bad-100", ".bad-500"] {
            assert!(left.contains(&format!("{OUTBOX_FILE}{kept}")), "{kept} 應保留");
        }
    }

    #[test]
    fn 壞檔清理_刪除失敗只記_log() {
        let d = tempfile::tempdir().unwrap();
        for i in 1..=3 {
            std::fs::write(d.path().join(format!("{OUTBOX_FILE}.bad-{i}")), "x").unwrap();
        }
        let logs = prune_bad_files(d.path(), 1, &|_| Err(std::io::Error::new(std::io::ErrorKind::PermissionDenied, "locked")));
        assert_eq!(logs.len(), 2);
        assert!(logs.iter().all(|l| l.contains("失敗")), "{logs:?}");
        assert_eq!(names(d.path()).len(), 3);
    }
}

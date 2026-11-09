//! 回信寄件匣（#1135）：視窗的回信寄不出去（連線失敗、逾時、讀回應斷、閘道 502～504）時，
//! 連同自己產生的 client_id 存進 `<工作資料夾>/reply-outbox.json`，之後在 tick 裡用同一個 client_id 重寄（後台據此去重）。
//! 寫進去＝已保管：原信照常 ack。4xx（後台明確拒絕）不進寄件匣，照舊走「寄送失敗」流程。
//! 單一處理者：橋本身靠 bridge.pid 互斥（見 lock.rs），同一個工作資料夾只會有一個 Core；Core 是 &mut 單執行緒，另外用 busy 記號擋同一筆重入。
//! log 只記編號與筆數，絕不記內文。
use super::*;
use serde::{Deserialize, Serialize};

pub(super) const OUTBOX_FILE: &str = "reply-outbox.json";
/// 寄件匣最多幾筆／序列化後最多幾位元組；超過就丟最舊的並通知
const OUTBOX_MAX_ITEMS: usize = 200;
const OUTBOX_MAX_BYTES: usize = 2 * 1024 * 1024;
/// 從第一次失敗起超過這麼久就放棄
const OUTBOX_GIVE_UP_MS: u64 = 86_400_000;
/// 第 N 次失敗後多久再寄：15 秒、1、2、5、10、30 分鐘，之後每 30 分鐘
const RETRY_GAPS_MS: [u64; 6] = [15_000, 60_000, 120_000, 300_000, 600_000, 1_800_000];
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
}

impl OutboxItem {
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

#[derive(Default)]
pub(super) struct Outbox {
    pub items: Vec<OutboxItem>,
    /// 正在重寄的 client_id（處理中標記）
    pub busy: HashSet<String>,
    file: PathBuf,
}

impl Outbox {
    /// 讀回存檔；壞檔改名成 .bad 留著（不直接當沒有，免得丟信），回傳（內容, 壞檔說明）
    pub fn load(work_dir: &std::path::Path) -> (Outbox, Option<String>) {
        let file = work_dir.join(OUTBOX_FILE);
        let mut warn = None;
        let items = match std::fs::read_to_string(&file) {
            Err(_) => vec![],
            Ok(t) => match serde_json::from_str::<OutboxFile>(&t) {
                Ok(f) => f.items,
                Err(e) => {
                    let _ = std::fs::rename(&file, work_dir.join(format!("{OUTBOX_FILE}.bad")));
                    warn = Some(format!("reply outbox file unreadable, moved to .bad: {e}"));
                    vec![]
                }
            },
        };
        (Outbox { items, busy: HashSet::new(), file }, warn)
    }

    pub fn has_reply(&self, reply_to: &str) -> bool {
        self.items.iter().any(|i| i.reply_to == reply_to)
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
    /// 後台明確拒絕，或寄件匣寫不進去
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
    /// 暫時性失敗進寄件匣；同一封信前面的片段還在寄件匣時，後面的片段直接排在後面（保序）
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
            attachment_ids: vec![],
            first_failed_at: self.now,
            attempts: 0,
            next_at: 0,
        };
        if self.outbox.has_reply(&o.id) {
            return self.outbox_store(item).await;
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
        let first_of_mail = !self.outbox.has_reply(&item.reply_to);
        let mut next = self.outbox.items.clone();
        next.push(item.clone());
        // 超過上限：丟最舊的那一封信（同一封信的所有片段一起丟，只通知一次；不會只丟前段、留下後段單獨送出）
        let mut evicted: Vec<OutboxItem> = vec![];
        while next.len() > 1 && next[0].reply_to != item.reply_to && (next.len() > OUTBOX_MAX_ITEMS || file_text(&next).len() > OUTBOX_MAX_BYTES) {
            let rt = next[0].reply_to.clone();
            let (gone, keep): (Vec<OutboxItem>, Vec<OutboxItem>) = next.into_iter().partition(|i| i.reply_to == rt);
            next = keep;
            evicted.extend(gone.into_iter().take(1));
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
            self.log.line(&format!("outbox full: dropped oldest reply id={} client_id={}", ev.reply_to, ev.client_id));
            self.outbox_notify_gave_up(&ev, "待送的回信太多").await;
        }
        if first_of_mail && !self.is_engine_window(&item.from_agent) {
            let w = item.from_agent.clone();
            self.tell_window(&w, "[收發室] 你剛才的回信暫時寄不出去，收發室會自動重寄，不用再寄一次。（這是系統通知，不用回覆。）");
        }
        ReplyOutcome::Stored
    }

    /// 放棄通知：寄給原寄件人（bridge_notice，寄件人是系統的「ASN 通知」，不以視窗名義），並告訴回信的視窗。內文不進通知
    async fn outbox_notify_gave_up(&mut self, it: &OutboxItem, reason: &str) {
        let o = Origin { id: it.reply_to.clone(), from_node: it.to_node.clone(), from_agent: it.to_agent.clone() };
        let text = format!("收發室：{} 對你這封信的回覆沒能送出（{reason}，已放棄）。請再問一次。（原信編號 {}）", it.from_agent, it.reply_to);
        let ok = self.send_back(&o, &text, None, None).await;
        self.log.line(&format!("outbox gave up id={} client_id={} reason={reason} notified={ok}", it.reply_to, it.client_id));
        if !self.is_engine_window(&it.from_agent) {
            let w = it.from_agent.clone();
            self.tell_window(&w, &format!("[收發室] 你之前對信件 {} 的回信一直沒能送出，已放棄，並已通知對方。（這是系統通知，不用回覆。）", it.reply_to));
        }
    }

    /// 放棄同一封信的所有待送片段，只通知一次
    async fn outbox_abandon(&mut self, reply_to: &str, reason: &str) {
        let (gone, keep): (Vec<OutboxItem>, Vec<OutboxItem>) = self.outbox.items.iter().cloned().partition(|i| i.reply_to == reply_to);
        let Some(first) = gone.first().cloned() else { return };
        self.outbox.items = keep;
        if let Err(e) = self.outbox.persist() {
            self.log.line(&format!("reply outbox save failed: {e}"));
        }
        self.outbox_notify_gave_up(&first, reason).await;
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

    /// 處理到期的寄件匣（每個 tick 呼叫）。同一封信的片段依序：前面的還沒送出，後面的等著
    pub(super) async fn outbox_tick(&mut self, now: u64) {
        if self.outbox.items.is_empty() {
            return;
        }
        let ids: Vec<String> = self.outbox.items.iter().map(|i| i.client_id.clone()).collect();
        let mut blocked: HashSet<String> = HashSet::new();
        for cid in ids {
            let Some(it) = self.outbox.items.iter().find(|i| i.client_id == cid).cloned() else { continue };
            if blocked.contains(&it.reply_to) {
                continue;
            }
            blocked.insert(it.reply_to.clone());
            if now.saturating_sub(it.first_failed_at) > OUTBOX_GIVE_UP_MS {
                self.outbox_abandon(&it.reply_to, "網路一直不通").await;
                continue;
            }
            if it.next_at > now || !self.outbox.busy.insert(cid.clone()) {
                continue;
            }
            let r = self.outbox_resend(it.clone()).await;
            self.outbox.busy.remove(&cid);
            match r {
                Resend::Done => {
                    blocked.remove(&it.reply_to);
                }
                Resend::Retry => {}
                Resend::GiveUp(why) => self.outbox_abandon(&it.reply_to, why).await,
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
    pub(crate) fn outbox_mark_busy(&mut self, cid: &str) {
        self.outbox.busy.insert(cid.to_string());
    }
    /// 測試用：直接塞一筆（寄給 W/W-政策、視窗 T-乙）
    #[cfg(test)]
    pub(crate) fn outbox_test_push(&mut self, reply_to: &str, attachment_ids: Vec<String>, first_failed_at: u64, next_at: u64) -> String {
        let client_id = crate::relay::new_client_id();
        self.outbox.items.push(OutboxItem { client_id: client_id.clone(), to_node: "W".into(), to_agent: "W-政策".into(), body: "附件信".into(), reply_to: reply_to.into(), from_agent: "T-乙".into(), expects_reply: None, attachment_ids, first_failed_at, attempts: 1, next_at });
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
        assert!(t("send HTTP 502") && t("send HTTP 503 gateway") && t("send HTTP 504"));
        assert!(!t("send HTTP 400 bad_attachment") && !t("send HTTP 422 not_receivable") && !t("send HTTP 500 internal"));
    }

    #[test]
    fn 重寄間隔() {
        assert_eq!([1, 2, 3, 4, 5, 6, 7, 50].map(retry_gap), [15_000, 60_000, 120_000, 300_000, 600_000, 1_800_000, 1_800_000, 1_800_000]);
    }
}

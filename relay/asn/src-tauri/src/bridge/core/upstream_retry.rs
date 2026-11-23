//! 上游暫時出錯（5xx）的延遲補送與恢復通知（#1670）。
//!
//! 背景：ACP 工作者碰到上游 5xx，會先自己等 10 秒再試一次（acp_worker）。上游事故常常不只幾秒（曾連續約 20 小時），
//! 所以這一輪還是失敗時，核心把這則群組點名「延遲補送」：約 2 分鐘後、約 10 分鐘後各一次。
//!
//! 送出次數（同一則群組點名）：原本 1 次 ＋ 工作者內部 10 秒重試 1 次 ＋ 延遲補送 [`MAX_DELAYED_RETRIES`] 次 ＝ 最多 4 次，不再多。
//! 補送都用退避（間隔越來越長）、都有上限；超過 [`RETRY_TTL_MS`] 的不送。
//!
//! 只在這些條件都成立才排補送：群組點名、收件的是 ACP 工作者、失敗原因是上游 5xx（`upstream_5xx`）、
//! 這一輪沒有工具步驟（動過手的不整封重送）。逾時、內容過濾、401、被停止、寫入政策違反都不排。
//! 排程只在記憶體：收發室重啟就放棄（記 log）。
//!
//! 補送期間不貼失敗說明；補送用完（或過期）才貼原本那則「暫時出錯」說明。
//! 恢復：同一個工作者連續 [`RECOVER_OK_STREAK`] 次正常結束，且之前處於「上游出錯」，就在出錯的群組補一句「又能處理了」，
//! 並重送最近一則沒處理的點名（最多一則，過期的不送）；同一次事故只通知一次。
use super::*;
use crate::bridge::engines::acp_policy::upstream_5xx;

/// 延遲補送的次數上限（不含原本那次與工作者內部的 10 秒重試）
pub(super) const MAX_DELAYED_RETRIES: usize = 2;
/// 第 N 次延遲補送要等多久（從上一次失敗算起，毫秒）：約 2 分鐘、約 10 分鐘
pub(super) const DELAYED_RETRY_MS: [u64; MAX_DELAYED_RETRIES] = [120_000, 600_000];
/// 一則點名從收到起超過這麼久就放棄補送、也不在恢復時重送
pub(super) const RETRY_TTL_MS: u64 = 30 * 60 * 1000;
/// 等待補送的點名記在機器資料夾的這個小檔（只有群組代號、序號、對象名、到期時間，沒有內文）。
/// 收發室重啟時排程會消失，啟動時看到這個檔就在 ui.log 記一行「已放棄」，不悄悄消失
pub(super) const RETRY_FILE: &str = "retry-pending.json";
/// 連續這麼多次正常結束才算恢復
pub(super) const RECOVER_OK_STREAK: u32 = 3;
/// 記著可補送的點名最多幾則（超過丟最舊的）
const MEMO_MAX: usize = 64;
/// 一次事故最多記幾個群組要貼恢復通知
const RECOVER_ROOMS_MAX: usize = 3;

/// 為了補送而記下的一則群組點名
#[derive(Clone, Debug, PartialEq)]
pub(super) struct Memo {
    pub room: RoomRef,
    pub room_name: String,
    pub from: String,
    pub target: String,
    pub text: String,
    /// 這則點名第一次交給工作者的時間
    pub born: u64,
    /// 已經送出幾次延遲補送
    pub tries: usize,
    /// 恢復時重送的那一次：再失敗不再補送、也不再留著等下一次恢復
    pub last_chance: bool,
    /// 這則已經貼過「收發室會自動再試」的過渡說明（同一則只貼一次）
    pub told: bool,
}

#[derive(Debug, PartialEq)]
pub(super) enum Plan {
    /// 排好了，到這個時間補送
    Wait(u64),
    /// 不補送了（原因給 log）：次數用完或過期
    GiveUp(&'static str),
    /// 沒有記下這則（不是會補送的那種）
    NotMine,
}

#[derive(Default)]
struct Health {
    down: bool,
    ok_streak: u32,
    rooms: Vec<RoomRef>,
}

pub(super) struct Recovered {
    pub rooms: Vec<RoomRef>,
    pub resend: Option<(String, Memo)>,
}

struct Waiting {
    id: String,
    due: u64,
    reason: String,
}

#[derive(Default)]
pub(super) struct Book {
    memos: HashMap<String, Memo>,
    waiting: Vec<Waiting>,
    /// 補送用完或過期、沒處理到的最近一則點名（每個工作者最多一則）
    stranded: HashMap<String, (String, Memo)>,
    health: HashMap<String, Health>,
    /// 目前寫在 RETRY_FILE 裡的內容（None＝沒有檔案）；沒變就不重寫
    saved: Option<String>,
}

impl Book {
    pub fn remember(&mut self, id: &str, m: Memo) {
        if self.memos.len() >= MEMO_MAX {
            if let Some(old) = self.memos.iter().filter(|(k, _)| !self.waiting.iter().any(|w| &w.id == *k)).min_by_key(|(_, m)| m.born).map(|(k, _)| k.clone()) {
                self.memos.remove(&old);
            }
        }
        self.memos.insert(id.to_string(), m);
    }

    /// 這則已經處理完（成功或最後失敗）：不再補送
    pub fn forget(&mut self, id: &str) {
        self.memos.remove(id);
        self.waiting.retain(|w| w.id != id);
    }

    /// 要貼過渡說明了：這則第一次回 true，之後回 false
    pub fn first_tell(&mut self, id: &str) -> bool {
        self.memos.get_mut(id).map(|m| !std::mem::replace(&mut m.told, true)).unwrap_or(false)
    }

    /// 等待補送的點名存檔內容（沒有在等的回 None）
    pub fn pending_json(&self) -> Option<String> {
        let mut items: Vec<(u64, serde_json::Value)> = self
            .waiting
            .iter()
            .filter_map(|w| self.memos.get(&w.id).map(|m| (w.due, serde_json::json!({ "room": m.room.id, "seq": m.room.seq, "target": m.target, "due": w.due }))))
            .collect();
        items.sort_by_key(|(due, _)| *due);
        (!items.is_empty()).then(|| serde_json::json!({ "items": items.into_iter().map(|(_, v)| v).collect::<Vec<_>>() }).to_string())
    }

    pub fn has(&self, id: &str) -> bool {
        self.memos.contains_key(id)
    }

    /// 這則剛因為上游 5xx 失敗：能補送就排進去
    pub fn plan(&mut self, id: &str, now: u64, reason: &str, delays: &[u64; MAX_DELAYED_RETRIES]) -> Plan {
        let Some(m) = self.memos.get(id) else { return Plan::NotMine };
        if m.last_chance || m.tries >= MAX_DELAYED_RETRIES {
            return Plan::GiveUp("次數用完");
        }
        let due = now + delays[m.tries];
        if due.saturating_sub(m.born) > RETRY_TTL_MS {
            return Plan::GiveUp("過期");
        }
        self.waiting.retain(|w| w.id != id);
        self.waiting.push(Waiting { id: id.to_string(), due, reason: reason.to_string() });
        Plan::Wait(due)
    }

    /// 到時間的補送：回 (編號, 失敗原因)
    pub fn due(&mut self, now: u64) -> Vec<(String, String)> {
        let (due, rest): (Vec<_>, Vec<_>) = std::mem::take(&mut self.waiting).into_iter().partition(|w| w.due <= now);
        self.waiting = rest;
        due.into_iter().map(|w| (w.id, w.reason)).collect()
    }

    /// 要補送了：還記著、沒過期才給（次數加一）。Err＝不送的原因
    pub fn take_for_resend(&mut self, id: &str, now: u64) -> Result<Memo, &'static str> {
        let Some(m) = self.memos.get_mut(id) else { return Err("已經處理過") };
        if now.saturating_sub(m.born) > RETRY_TTL_MS {
            return Err("過期");
        }
        m.tries += 1;
        Ok(m.clone())
    }

    /// 補送放棄：留著給「恢復」時重送一次（只留最近的一則；已是最後機會的不再留）
    pub fn strand(&mut self, id: &str) {
        if let Some(m) = self.memos.remove(id) {
            self.waiting.retain(|w| w.id != id);
            if m.last_chance {
                return;
            }
            let newer = self.stranded.get(&m.target).map(|(_, o)| o.born <= m.born).unwrap_or(true);
            if newer {
                self.stranded.insert(m.target.clone(), (id.to_string(), m));
            }
        }
    }

    /// 這個工作者剛因為上游 5xx 失敗
    pub fn mark_down(&mut self, worker: &str, room: Option<&RoomRef>) {
        let h = self.health.entry(worker.to_string()).or_default();
        h.down = true;
        h.ok_streak = 0;
        if let Some(r) = room {
            h.rooms.retain(|x| x.id != r.id);
            h.rooms.push(r.clone());
            if h.rooms.len() > RECOVER_ROOMS_MAX {
                h.rooms.remove(0);
            }
        }
    }

    /// 別種失敗：連續成功從頭算
    pub fn note_fail(&mut self, worker: &str) {
        if let Some(h) = self.health.get_mut(worker) {
            h.ok_streak = 0;
        }
    }

    /// 一輪正常結束。連續夠多次且之前處於出錯狀態才回「恢復了」（同一次事故只回一次）
    pub fn note_ok(&mut self, worker: &str, now: u64) -> Option<Recovered> {
        let h = self.health.get_mut(worker).filter(|h| h.down)?;
        h.ok_streak += 1;
        if h.ok_streak < RECOVER_OK_STREAK {
            return None;
        }
        h.down = false;
        h.ok_streak = 0;
        let rooms = std::mem::take(&mut h.rooms);
        let resend = self.stranded.remove(worker).filter(|(_, m)| now.saturating_sub(m.born) <= RETRY_TTL_MS).map(|(id, mut m)| {
            m.last_chance = true;
            (id, m)
        });
        Some(Recovered { rooms, resend })
    }

    /// 清掉過期的記錄（沒有在排補送的才清）
    pub fn prune(&mut self, now: u64) {
        let waiting: Vec<String> = self.waiting.iter().map(|w| w.id.clone()).collect();
        self.memos.retain(|k, m| waiting.contains(k) || now.saturating_sub(m.born) <= RETRY_TTL_MS);
        self.stranded.retain(|_, (_, m)| now.saturating_sub(m.born) <= RETRY_TTL_MS);
    }

    #[cfg(test)]
    pub fn waiting_len(&self) -> usize {
        self.waiting.len()
    }
}

impl Core {
    /// 等待補送的名單有變就更新存檔（空了就刪檔）。寫不進去只記 log
    pub(super) fn up_sync_file(&mut self) {
        if self.cfg.work_dir.as_os_str().is_empty() {
            return;
        }
        let want = self.up_retry.pending_json();
        if want == self.up_retry.saved {
            return;
        }
        let file = self.cfg.work_dir.join(RETRY_FILE);
        let ok = match &want {
            Some(t) => crate::settings::atomic::write(&file, t.as_bytes(), crate::settings::atomic::QUEUE).map_err(|e| self.log.line(&format!("upstream-retry state save failed: {e}"))).is_ok(),
            None => {
                let _ = std::fs::remove_file(&file);
                true
            }
        };
        if ok {
            self.up_retry.saved = want;
        }
    }

    /// 啟動時（Core 建好、第一輪之前）：上次關閉時還在等補送的點名已經放棄了，在 ui.log 與 bridge.log 各記一行，然後清掉檔案。
    /// 只寫序號與對象名，不寫內文。沒有檔案或沒有內容就什麼都不寫
    pub(super) fn up_report_lost(&mut self) {
        let file = self.cfg.work_dir.join(RETRY_FILE);
        let Ok(text) = std::fs::read_to_string(&file) else { return };
        let _ = std::fs::remove_file(&file);
        let items: Vec<(u64, String)> = serde_json::from_str::<serde_json::Value>(&text)
            .ok()
            .and_then(|v| v.get("items").and_then(|a| a.as_array().cloned()))
            .unwrap_or_default()
            .iter()
            .map(|i| (i.get("seq").and_then(|x| x.as_u64()).unwrap_or(0), i.get("target").and_then(|x| x.as_str()).unwrap_or("").to_string()))
            .collect();
        if items.is_empty() {
            return;
        }
        let mut list: Vec<String> = items.iter().take(5).map(|(seq, t)| format!("#{seq} {t}")).collect();
        if items.len() > 5 {
            list.push("…".into());
        }
        let line = format!("上次關閉時有 {} 則群組點名在等補送（{}），已放棄", items.len(), list.join("、"));
        self.log.line(&format!("[ASN] {line}"));
        crate::auth_notice::note_logger(self.cfg.work_dir.clone())(&line);
    }

    /// 群組點名剛交給 ACP 工作者：記下，之後上游 5xx 才補送得了
    pub(super) fn up_remember(&mut self, id: &str, text: &str, room_name: &str, from: &str) {
        let Some(i) = self.idx(id) else { return };
        let (Some(room), target) = (self.pending[i].room.clone(), self.pending[i].target.clone()) else { return };
        if self.engine_of(&target) != "acp" || self.bounce_notices.contains(id) {
            return;
        }
        let memo = Memo { room, room_name: room_name.to_string(), from: from.to_string(), target, text: text.to_string(), born: self.now, tries: 0, last_chance: false, told: false };
        self.up_retry.remember(id, memo);
    }

    /// 工作者回報這一輪被上游 5xx 擋下（retryable＝這一輪沒有工具步驟、整封重送不會做兩次）
    pub(super) async fn on_upstream_fail(&mut self, id: &str, reason: &str, retryable: bool) {
        let now = self.now;
        if let Some(i) = self.idx(id) {
            let (target, room) = (self.pending[i].target.clone(), self.pending[i].room.clone());
            self.up_retry.mark_down(&target, room.as_ref());
            if room.is_some() && self.up_retry.has(id) {
                if !retryable {
                    self.log.line(&format!("upstream-retry skipped id={id}: this turn already ran tool steps"));
                    self.up_retry.forget(id);
                } else {
                    let delays = self.cfg.upstream_retry_ms;
                    match self.up_retry.plan(id, now, reason, &delays) {
                        Plan::Wait(due) => {
                            self.log.line(&format!("upstream-retry scheduled id={id} target={target} in {}s", due.saturating_sub(now) / 1000));
                            // 補送期間群組也要看得到：第一次排補送時貼一則過渡說明（同一則只貼一次）
                            if self.up_retry.first_tell(id) {
                                self.room_retry_wait_notice(id, reason).await;
                            }
                            // 這一輪到此為止：不貼失敗說明、不留對應；補送時重新登記
                            self.exact_ids.remove(id);
                            channel_turns::clear(&self.cfg.work_dir, id);
                            self.channel_wait.remove(id);
                            self.ack_wait.remove(id);
                            self.reply_fail.remove(id);
                            self.remove(id);
                            self.up_sync_file();
                            return;
                        }
                        Plan::GiveUp(why) => {
                            self.log.line(&format!("upstream-retry gave up id={id}: {why}"));
                            self.up_retry.strand(id);
                        }
                        Plan::NotMine => {}
                    }
                }
            }
        }
        self.on_fail(id, reason).await;
    }

    /// 工作者一輪正常結束
    pub(super) async fn on_turn_ok(&mut self, worker: &str, id: &str) {
        self.up_retry.forget(id);
        self.up_sync_file();
        let Some(rec) = self.up_retry.note_ok(worker, self.now) else { return };
        self.log.line(&format!("upstream-retry recovered worker={worker}: {} ok in a row", RECOVER_OK_STREAK));
        let resend = rec.resend;
        for room in &rec.rooms {
            let resent = resend.as_ref().map(|(_, m)| m.room.id == room.id).unwrap_or(false);
            let posted = self.post_room(room, &super::fail_notice::room_recovered_text(room.seq, worker, resent)).await;
            self.log.line(&format!("room recovered notice room={} #{} -> {worker} posted={posted}", room.id, room.seq));
        }
        if let Some((rid, memo)) = resend {
            self.up_resend(&rid, memo, "").await;
        }
    }

    /// 定時：到時間的補送送出去；過期的清掉
    pub(super) async fn upstream_retry_tick(&mut self, now: u64) {
        self.up_retry.prune(now);
        let due = self.up_retry.due(now);
        self.up_sync_file(); // 到期的已經從等待名單拿掉
        for (id, reason) in due {
            match self.up_retry.take_for_resend(&id, now) {
                Ok(memo) => self.up_resend(&id, memo, &reason).await,
                Err(why) => {
                    self.log.line(&format!("upstream-retry dropped id={id}: {why}"));
                    if why == "過期" {
                        self.up_retry.strand(&id);
                    }
                }
            }
        }
    }

    /// 把記著的點名重新交給工作者（同一個編號，回覆照舊貼回原群組）。reason＝上一次失敗的原因，送不出去時拿來貼說明
    async fn up_resend(&mut self, id: &str, memo: Memo, reason: &str) {
        let target = memo.target.clone();
        // 等補送的這段時間，群組裡可能已經有人回了這則（#1828）：有就不補送，免得多回一次
        if let Some(why) = self.up_room_answered(&memo).await {
            self.log.line(&format!("upstream-retry not resent id={id} room={} #{}: {why}", memo.room.id, memo.room.seq));
            self.up_retry.forget(id);
            self.up_sync_file();
            return;
        }
        if self.idx(id).is_some() {
            self.log.line(&format!("upstream-retry not resent id={id}: already in progress or handled"));
            return;
        }
        if !self.forwardable(&target) {
            self.log.line(&format!("upstream-retry not resent id={id}: {target} not available"));
            self.up_give_up(id, &memo, reason).await;
            return;
        }
        let mut p = Pending::new(id, "", "", &target, self.now, false);
        p.room = Some(memo.room.clone());
        self.room_trig.insert(id.to_string(), RoomTrig { name: memo.room_name.clone(), from: memo.from.clone() });
        self.pending.push(p);
        self.persist();
        match self.deliver(id, &target, &memo.text) {
            Ok(()) => self.log.line(&format!("upstream-retry resent id={id} room={} #{} to={target} attempt={}", memo.room.id, memo.room.seq, memo.tries)),
            Err(e) => {
                self.log.line(&format!("upstream-retry resend failed id={id}: {e}"));
                self.up_retry.strand(id);
                self.up_give_up(id, &memo, reason).await;
            }
        }
    }

    /// 讀群組後台（只讀：帶 since、不標已讀），看這則點名之後是否已經有人回了。回 Some(原因)＝已回，不必補送。
    /// 讀不到（網路、5xx）回 None＝照常補送：最壞只是多回一次，比漏回好
    async fn up_room_answered(&self, memo: &Memo) -> Option<&'static str> {
        let as_agent = if memo.room.window.is_empty() { String::new() } else { format!("&as_agent={}", crate::relay::encode_component(&memo.room.window)) };
        let action = format!("room_read&room={}{as_agent}&since={}&limit=100", crate::relay::encode_component(&memo.room.id), memo.room.seq);
        match self.relay.api(&action, None).await {
            Ok(res) => answered_in(res.get("messages").and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[]), memo),
            Err(e) => {
                self.log.line(&format!("upstream-retry room_read failed room={} #{}: {e} (resend anyway)", memo.room.id, memo.room.seq));
                None
            }
        }
    }

    /// 補送不成：貼原本那則失敗說明（沿用冷卻）
    async fn up_give_up(&mut self, id: &str, memo: &Memo, reason: &str) {
        self.up_retry.strand(id);
        if self.idx(id).is_none() {
            let mut p = Pending::new(id, "", "", &memo.target, self.now, false);
            p.room = Some(memo.room.clone());
            self.pending.push(p);
        }
        let why = if reason.is_empty() { "API error: request failed (code 502): HTML response" } else { reason };
        self.room_forward_failed(id, "room", false, why).await;
        self.remove(id);
    }
}

/// 這則點名之後的群組訊息裡，有沒有人已經回了（#1828）。只認一條：有人用 reply_to 指向這則（不論是誰）。
/// 後台沒有「回給誰」以外的欄位；目標夥伴之後發了別的話、或別人沒引用就口頭回，都看不出是回這則，照常補送（最壞多回一次，不會漏）
fn answered_in(msgs: &[Value], memo: &Memo) -> Option<&'static str> {
    msgs.iter()
        .any(|m| json_u64(m.get("seq")) > memo.room.seq && json_u64(m.get("reply_to").and_then(|r| r.get("seq"))) == memo.room.seq)
        .then_some("群組裡已經有人回覆這則")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn room() -> RoomRef {
        RoomRef { id: "R1".into(), seq: 2, window: "甲".into(), member: "W~甲".into() }
    }
    fn memo(born: u64) -> Memo {
        Memo { room: room(), room_name: "群".into(), from: "x".into(), target: "甲".into(), text: "t".into(), born, tries: 0, last_chance: false, told: false }
    }
    const D: [u64; MAX_DELAYED_RETRIES] = [100, 600];
    const WHY: &str = "API error (attempt 1): request failed (code 502): HTML response";

    #[test]
    fn 單號1670_補送最多兩次_第三次失敗就放棄() {
        let mut b = Book::default();
        b.remember("a", memo(0));
        assert_eq!(b.plan("a", 10, WHY, &D), Plan::Wait(110));
        assert!(b.due(109).is_empty());
        assert_eq!(b.due(110), vec![("a".to_string(), WHY.to_string())]);
        assert_eq!(b.take_for_resend("a", 110).unwrap().tries, 1);
        assert_eq!(b.plan("a", 120, WHY, &D), Plan::Wait(720), "第二次等比較久（退避）");
        b.due(720);
        assert_eq!(b.take_for_resend("a", 720).unwrap().tries, 2);
        assert_eq!(b.plan("a", 730, WHY, &D), Plan::GiveUp("次數用完"), "延遲補送上限 {MAX_DELAYED_RETRIES}");
    }

    #[test]
    fn 單號1670_過期的不排也不送() {
        let mut b = Book::default();
        b.remember("a", memo(0));
        assert_eq!(b.plan("a", RETRY_TTL_MS - 50, WHY, &D), Plan::GiveUp("過期"));
        b.remember("b", memo(0));
        assert_eq!(b.plan("b", 10, WHY, &D), Plan::Wait(110));
        b.due(110);
        assert_eq!(b.take_for_resend("b", RETRY_TTL_MS + 1), Err("過期"));
    }

    #[test]
    fn 單號1670_已經處理過的不送_沒記下的不排() {
        let mut b = Book::default();
        b.remember("a", memo(0));
        assert_eq!(b.plan("a", 10, WHY, &D), Plan::Wait(110));
        b.forget("a");
        assert_eq!(b.waiting_len(), 0);
        assert_eq!(b.take_for_resend("a", 110), Err("已經處理過"));
        assert_eq!(b.plan("zzz", 10, WHY, &D), Plan::NotMine);
    }

    #[test]
    fn 單號1670_恢復要連續三次成功_中間失敗從頭算_同一次事故只通知一次() {
        let mut b = Book::default();
        assert!(b.note_ok("甲", 0).is_none(), "沒出過錯不通知");
        b.mark_down("甲", Some(&room()));
        assert!(b.note_ok("甲", 1).is_none());
        assert!(b.note_ok("甲", 2).is_none());
        b.note_fail("甲");
        assert!(b.note_ok("甲", 3).is_none() && b.note_ok("甲", 4).is_none(), "失敗後重算");
        let r = b.note_ok("甲", 5).expect("第三次");
        assert_eq!(r.rooms.len(), 1);
        for t in 6..12 {
            assert!(b.note_ok("甲", t).is_none(), "同一次事故只通知一次");
        }
        b.mark_down("甲", None);
        assert!(b.note_ok("甲", 20).is_none() && b.note_ok("甲", 21).is_none());
        assert!(b.note_ok("甲", 22).is_some(), "新的事故可以再通知");
    }

    #[test]
    fn 單號1670_恢復時重送最近一則沒處理的_過期的不送() {
        let mut b = Book::default();
        b.remember("old", memo(0));
        b.remember("new", memo(500));
        b.strand("old");
        b.strand("new");
        b.mark_down("甲", Some(&room()));
        b.note_ok("甲", 600);
        b.note_ok("甲", 601);
        let r = b.note_ok("甲", 602).unwrap();
        let (id, m) = r.resend.expect("最近那則");
        assert_eq!(id, "new");
        assert!(m.last_chance);
        b.remember("e", memo(0));
        b.strand("e");
        b.mark_down("甲", None);
        b.note_ok("甲", RETRY_TTL_MS + 1);
        b.note_ok("甲", RETRY_TTL_MS + 2);
        assert!(b.note_ok("甲", RETRY_TTL_MS + 3).unwrap().resend.is_none(), "過期的不重送");
    }

    #[test]
    fn 單號1670_恢復時重送的那一次再失敗_不再排補送() {
        let mut b = Book::default();
        let mut m = memo(0);
        m.last_chance = true;
        b.remember("a", m);
        assert_eq!(b.plan("a", 1, WHY, &D), Plan::GiveUp("次數用完"));
        b.strand("a");
        assert!(b.stranded.is_empty(), "最後機會用掉就不再留");
    }

    #[test]
    fn 單號1670_判斷只認上游5xx() {
        assert!(upstream_5xx(WHY).is_some());
        assert!(upstream_5xx("Gemini 處理這封信太久沒有動靜").is_none());
        assert!(upstream_5xx("API error (attempt 1): request failed (code 401): HTML response").is_none());
    }

    fn msg(seq: u64, from: &str, body: &str, reply_seq: Option<u64>) -> Value {
        let mut m = serde_json::json!({ "seq": seq, "from": from, "body": body });
        if let Some(r) = reply_seq {
            m["reply_to"] = serde_json::json!({ "seq": r, "from": "x" });
        }
        m
    }
    fn memo_in_room() -> Memo {
        let mut m = memo(0);
        m.room.member = "W~甲".into();
        m
    }
    #[test]
    fn 單號1828_已回覆的判斷規則_只認回覆引用這則() {
        let m = memo(0); // 點名在第 2 則
        assert!(answered_in(&[], &m).is_none());
        assert!(answered_in(&[msg(3, "W~乙", "閒聊", None), msg(4, "W~乙", "別則的回覆", Some(1))], &m).is_none(), "別人閒聊、引用別則都不算");
        assert!(answered_in(&[msg(3, "甲", "目標夥伴發了別的話", None)], &m).is_none(), "目標夥伴沒引用這則：照常補送");
        assert!(answered_in(&[msg(2, "W~乙", "這則本身", Some(2))], &m).is_none(), "這則以前（含這則）不算");
        assert!(answered_in(&[msg(3, "W~乙", "我來", Some(2))], &m).is_some(), "有人用回覆引用這則");
    }
}

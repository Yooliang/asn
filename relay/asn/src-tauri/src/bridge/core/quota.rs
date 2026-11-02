//! 收發室 worker 的 Claude 額度用完時的處理（todo-next-173）。
//! worker 偵測到額度用完（WorkerEvent::Quota）後：轉交中的信改成 Held（不算轉交逾時、不 ack）、
//! 之後進來的信直接扣住；恢復後依原收到順序重送，抬頭加一行「這封因額度用完延遲」。
//! 恢復的判斷：扣住期間每小時（或到重置時間時）只把最舊的一封試送給 worker；worker 回報任何 Sent／Fail／回覆
//! （代表它真的在工作）就解除、依序重送其餘；又撞到額度就繼續扣住（暫停時間只會延長，不會先清掉，也不重複通知）。
//! 這樣主人提早換帳號、或 rate_limit_event 的 rejected 其實請求照常進行時，不必等到重置時間。
//! 安全底線：就算被假訊息騙進來，最壞只是延後一小時再試，絕不丟信、絕不 ack。
use super::*;
use crate::bridge::mail::{quota_late_line, taipei_hm};
use crate::bridge::rooms::Wake;

impl Core {
    /// 這台電腦因收發室 worker 額度用完而暫停收信到什麼時候（毫秒）；沒有暫停回 None。
    /// 名單回報會把它帶給後台（relay.nodes.inbox_hold_until），收信監控用來抑制通知；值存在 pending.json（quotaUntil），重啟後驗過範圍才沿用
    pub fn inbox_hold_until(&self) -> Option<u64> {
        (self.quota_until > 0).then_some(self.quota_until)
    }

    /// 超過上限的旗標還沒報給後台（暫停進行中、有超過上限、還沒報過）
    pub(super) fn hold_cap_due(&self) -> bool {
        self.inbox_hold_until().is_some() && !self.cap_sent && self.quota_ep.as_ref().is_some_and(|e| e.capped)
    }

    /// 扣住中（到真的恢復才解除，不是重置時間一到就算）
    pub(super) fn quota_active(&self, _now: u64) -> bool {
        self.quota_until > 0
    }

    /// 扣住的個人信筆數
    pub(super) fn quota_held_mails(&self) -> usize {
        self.pending.iter().filter(|p| p.state == State::Held).count()
    }

    /// 額度扣住的群組訊息筆數
    pub(super) fn quota_held_rooms(&self) -> usize {
        self.held.items().iter().filter(|h| h.held_at > 0).count()
    }

    /// 扣住的筆數：個人信＋額度扣住的群組訊息
    pub(super) fn quota_held_total(&self) -> usize {
        self.quota_held_mails() + self.quota_held_rooms()
    }

    /// 試送的那一封還在等 worker 的結果
    fn probe_inflight(&self) -> bool {
        self.probe_id.as_ref().is_some_and(|id| self.pending.iter().any(|p| &p.id == id && p.state == State::Forwarding))
    }

    /// worker 真的在工作（Sent／Fail／回覆）：解除扣住，下一個 tick 依序重送其餘的信
    pub(super) fn quota_release(&mut self, why: &str) {
        if self.quota_until == 0 {
            return;
        }
        self.quota_until = 0;
        self.probe_id = None;
        self.log.line(&format!("quota hold released ({why}): resending held mail in order"));
        self.persist();
    }

    /// 這個收件人的信要經過收發室 worker（Claude 引擎）才送得到；其他引擎不受額度影響
    pub(super) fn via_worker(&self, target: &str) -> bool {
        self.engine_of(target) == "claude"
    }

    /// 在轉交文字的第一行（抬頭）後面加一行延遲說明
    pub(super) fn with_late_line(text: String, received_ms: u64) -> String {
        match text.split_once('\n') {
            Some((head, rest)) => format!("{head}\n{}\n{rest}", quota_late_line(received_ms)),
            None => format!("{text}\n{}", quota_late_line(received_ms)),
        }
    }

    /// 收發室 worker 回報額度用完
    pub(super) async fn on_quota(&mut self, resets_at: Option<u64>, kind: &str) {
        let now = self.now;
        let until = resets_at.map(|s| s * 1000 + QUOTA_MARGIN_MS).filter(|u| *u > now).unwrap_or(now + QUOTA_RETRY_MS);
        // 暫停時間只會延長：扣住期間試送又撞額度（時間不明）不能把已知的重置時間縮短，也不能先清掉
        self.quota_until = self.quota_until.max(until);
        let until = self.quota_until;
        self.next_probe_at = (now + QUOTA_RETRY_MS).min(until);
        self.probe_id = None;
        self.log.line(&format!("worker quota exhausted ({kind}): hold until {} (resets_at={resets_at:?}), next probe {}", taipei_hm(until), taipei_hm(self.next_probe_at)));
        self.quota_ep.get_or_insert_with(Default::default);
        // 轉交中的信：個人信改成 Held；群組訊息改排進 HeldStore（存檔，重置後向後台重讀）
        let ids: Vec<String> = self.pending.iter().filter(|p| p.state == State::Forwarding).map(|p| p.id.clone()).collect();
        let mut newly: Vec<Mail> = vec![];
        for id in ids {
            let Some(i) = self.idx(&id) else { continue };
            if self.pending[i].room.is_some() {
                let Some(rf) = self.fwd_rooms.get(&id) else { continue };
                let h = Held { room_id: rf.room_id.clone(), room_name: rf.room_name.clone(), member: rf.member.clone(), seq: rf.seq, due: until, delay_ms: 0, wake: Wake { rank: 1, total: 1, before: vec![] }, fails: 0, held_at: rf.received_at };
                let ok = self.held.contains(&h.room_id, h.seq, &h.member) || self.held.add(h).is_ok();
                if ok {
                    self.fwd_rooms.remove(&id);
                    self.pending.remove(i);
                    self.log.line(&format!("room message id={id} held for quota"));
                } else {
                    self.log.line(&format!("rooms held save failed: room message id={id} stays forwarding"));
                }
            } else if let Some(it) = self.fwd_items.remove(&id) {
                self.pending[i].state = State::Held;
                self.pending[i].t0 = it.received_at;
                newly.push(it.mail.clone());
                self.held_items.insert(id.clone(), it);
                self.log.line(&format!("mail id={id} held for quota (not acked)"));
            }
        }
        self.persist();
        for m in newly {
            self.quota_notify_sender(&m).await;
        }
    }

    /// 通知私信原寄件人：同一寄件人同一次額度用完只通知一次；收發室寄來的與收發室自己寫的通知不回
    pub(super) async fn quota_notify_sender(&mut self, m: &Mail) {
        let from_agent = m.from_agent.clone().unwrap_or_default();
        if Self::is_mailbox_sender(&from_agent) || m.body.trim_start().starts_with("[收發室]") {
            return;
        }
        let key = format!("{}/{}", m.from_node, from_agent);
        let Some(ep) = self.quota_ep.as_mut() else { return };
        if !ep.senders.insert(key) {
            return;
        }
        let text = format!("[收發室] 這台的收發室 Claude 額度用完，約 {}（台北）重置；信已收到，重置後自動轉交。", taipei_hm(self.quota_until));
        let o = Origin { id: m.id.clone(), from_node: m.from_node.clone(), from_agent };
        self.send_back(&o, &text, None, Some(false)).await;
    }

    /// 扣住的筆數已達上限（what＝哪一筆，max＝哪一種上限）：這筆不收（不 ack、不推進游標，留在伺服器下次再拉）；記 log。
    /// 通知主人由後台寄：名單回報會帶 inbox_hold_capped（每次額度用完只帶一次），見 refresh_roster
    pub(super) async fn quota_cap_hit(&mut self, what: &str, max: usize) {
        if self.unrouted.insert(format!("quota-cap:{what}")) {
            self.log.line(&format!("quota hold full ({max}): {what} not taken (left on server)"));
        }
        if let Some(ep) = self.quota_ep.as_mut() {
            ep.capped = true;
        }
    }

    /// 扣住中進來的個人信：扣住（Held），不送 worker、不 ack。回 false＝已達上限而不收（呼叫端要把收件視窗名排除出下一輪拉信，才拉得到其他視窗的信）。
    /// 上限比信箱一頁（INBOX_PAGE）少 10 筆：扣住的信不 ack 會一直排在信箱最前面，留空位才不會把整頁占滿
    pub(super) async fn quota_hold_mail(&mut self, mut p: Pending, m: &Mail, raw: Option<Value>) -> bool {
        if self.quota_held_mails() >= QUOTA_MAIL_MAX {
            self.quota_cap_hit(&m.id, QUOTA_MAIL_MAX).await;
            return false;
        }
        let received = self.late_from.take().unwrap_or(self.now);
        p.state = State::Held;
        p.t0 = received;
        p.t = received;
        self.pending.push(p);
        self.held_items.insert(m.id.clone(), HeldItem { mail: m.clone(), raw, received_at: received });
        self.persist();
        self.log.line(&format!("mail id={} held for quota (not acked)", m.id));
        self.quota_notify_sender(m).await;
        true
    }

    /// 群組訊息遇到額度用完：排進 HeldStore（存檔後游標才前進），重置後重讀再轉交。回 false＝已達上限，先不收（游標不前進）
    pub(super) async fn quota_hold_room(&mut self, room: &Value, member: &str, msg: &Value) -> bool {
        let room_id = room.get("id").and_then(Value::as_str).unwrap_or("").to_string();
        let seq = json_u64(msg.get("seq"));
        if self.idx(&rooms::room_uuid(&room_id, seq, member)).is_some() || self.held.contains(&room_id, seq, member) {
            return true;
        }
        if self.quota_held_rooms() >= QUOTA_ROOM_MAX {
            self.quota_cap_hit(&format!("room={room_id} #{seq}"), QUOTA_ROOM_MAX).await;
            return false;
        }
        let h = Held { room_id: room_id.clone(), room_name: room.get("name").and_then(Value::as_str).unwrap_or("").to_string(), member: member.to_string(), seq, due: self.quota_until, delay_ms: 0, wake: Wake { rank: 1, total: 1, before: vec![] }, fails: 0, held_at: self.now };
        match self.held.add(h) {
            Ok(_) => {
                self.log.line(&format!("room={room_id} #{seq} member={member} held for quota"));
                true
            }
            Err(e) => {
                self.log.line(&format!("rooms held save failed: {e} (cursor not advanced)"));
                false
            }
        }
    }

    /// 超過保留期的額度扣住群組訊息：不轉交，恢復時給該夥伴一則收發室寫的摘要（每個群組＋成員一則）
    pub(super) fn quota_room_summary(&mut self, items: &[Held]) {
        let mut groups: BTreeMap<(String, String), (String, u64, u64, u64)> = BTreeMap::new();
        for h in items {
            let e = groups.entry((h.room_id.clone(), h.member.clone())).or_insert((h.room_name.clone(), 0, u64::MAX, 0));
            e.1 += 1;
            e.2 = e.2.min(h.seq);
            e.3 = e.3.max(h.seq);
        }
        for ((room_id, member), (name, n, lo, hi)) in groups {
            let mut window = self.canonical_target(&format!("room:{room_id}"), &rooms::member_window(&member));
            if window.is_empty() {
                window = self.unaddressed_window().unwrap_or_default();
            }
            let text = format!("（收發室）額度用完期間群組 {} 有 {n} 則沒有轉交，範圍 #{lo}～#{hi}，要看請讀群組", rooms::clean_label(&name));
            if window.is_empty() || !self.forwardable(&window) {
                self.log.line(&format!("quota room summary room={room_id} not delivered (no window): {n} messages #{lo}-#{hi}"));
                continue;
            }
            self.log.line(&format!("quota room summary room={room_id} -> {window}: {n} messages #{lo}-#{hi} not forwarded (over keep time)"));
            self.tell_window(&window, &text);
        }
    }

    /// 定時：整理暫存、重置後依原收到順序重送扣住的信
    pub(super) async fn quota_tick(&mut self, now: u64) {
        // 已不在轉交中的暫存不留
        self.fwd_items.retain(|id, _| self.pending.iter().any(|p| &p.id == id && p.state == State::Forwarding));
        self.fwd_rooms.retain(|id, _| self.pending.iter().any(|p| &p.id == id && p.state == State::Forwarding));
        // 只剩存檔、沒有內文的扣住信（重啟後）：保留期內等重新拉到的同一封補回，過了就放棄
        let keep = self.cfg.late_keep_ms;
        let stale: Vec<String> = self.pending.iter().filter(|p| p.state == State::Held && !self.held_items.contains_key(&p.id) && now.saturating_sub(p.t0) > keep).map(|p| p.id.clone()).collect();
        for id in stale {
            self.log.line(&format!("held mail id={id} expired without being pulled again"));
            self.remove(&id);
        }
        if self.quota_until == 0 {
            self.resend_held().await;
        } else {
            self.quota_probe(now).await;
        }
    }

    /// 恢復後：依原收到順序重送扣住的個人信（群組訊息由 release_held 處理）
    async fn resend_held(&mut self) {
        let mut order: Vec<(u64, usize, String)> = self.pending.iter().enumerate().filter(|(_, p)| p.state == State::Held && self.held_items.contains_key(&p.id)).map(|(i, p)| (p.t0, i, p.id.clone())).collect();
        if order.is_empty() {
            return;
        }
        order.sort();
        self.log.line(&format!("quota over: resending {} held mails in received order", order.len()));
        for (_, _, id) in order {
            let Some(it) = self.held_items.remove(&id) else { continue };
            self.pending.retain(|p| p.id != id);
            self.late_from = Some(it.received_at);
            self.handle_mail_raw(it.mail, it.raw).await;
            self.late_from = None;
        }
        self.persist();
    }

    /// 扣住期間的試送：每小時（或到重置時間時）只把最舊的一封（個人信或群組訊息，收到時間較早的）送給 worker。
    /// 結果由 worker 的回報決定：Sent／Fail／回覆＝恢復（quota_release）；又撞額度＝on_quota 繼續扣住並延長
    async fn quota_probe(&mut self, now: u64) {
        if self.probe_inflight() || now < self.next_probe_at {
            return;
        }
        let keep = self.cfg.late_keep_ms;
        let mail = self.pending.iter().enumerate().filter(|(_, p)| p.state == State::Held && self.held_items.contains_key(&p.id)).map(|(i, p)| (p.t0, i, p.id.clone())).min();
        let room = self.held.items().iter().filter(|h| h.held_at > 0 && now.saturating_sub(h.held_at) <= keep).min_by_key(|h| h.held_at).cloned();
        let pick_mail = match (&mail, &room) {
            (Some(m), Some(r)) => m.0 <= r.held_at,
            (Some(_), None) => true,
            (None, Some(_)) => false,
            (None, None) => {
                // 沒有東西可試送：到了重置時間就解除（沒有信在等，不必再延長）
                if now >= self.quota_until {
                    self.quota_release("nothing waiting");
                }
                return;
            }
        };
        self.next_probe_at = now + QUOTA_RETRY_MS;
        self.quota_until = self.quota_until.max(now + QUOTA_RETRY_MS); // 先延長，試送失敗時暫停時間不會中斷
        self.probing = true;
        if let (true, Some((_, _, id))) = (pick_mail, mail) {
            if let Some(it) = self.held_items.remove(&id) {
                self.log.line(&format!("quota probe: sending oldest held mail id={id}"));
                self.pending.retain(|p| p.id != id);
                self.late_from = Some(it.received_at);
                self.handle_mail_raw(it.mail, it.raw).await;
                self.late_from = None;
                self.probe_id = Some(id);
            }
        } else if let Some(h) = room {
            self.log.line(&format!("quota probe: sending oldest held room message room={} #{}", h.room_id, h.seq));
            self.probe_id = Some(rooms::room_uuid(&h.room_id, h.seq, &h.member));
            self.release_held_item(&h, now, &mut vec![]).await;
        }
        self.probing = false;
        self.persist();
    }
}

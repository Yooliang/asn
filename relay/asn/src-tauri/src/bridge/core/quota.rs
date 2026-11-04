//! 收發室 worker 的 Claude 額度用完時的處理（todo-next-173）。
//! worker 偵測到額度用完（WorkerEvent::Quota）後：轉交中的信改成 Held（不算轉交逾時、不 ack）、
//! 之後進來的信直接扣住；恢復後依原收到順序重送，抬頭加一行「這封因額度用完延遲」。
//! 恢復的判斷：扣住期間每小時（或到重置時間時）只把最舊的一封試送給 worker；worker 回報任何 Sent／Fail／回覆
//! （代表它真的在工作）就解除、依序重送其餘；又撞到額度就繼續扣住（暫停時間只會延長，不會先清掉，也不重複通知）。
//! 這樣主人提早換帳號、或 rate_limit_event 的 rejected 其實請求照常進行時，不必等到重置時間。
//! 安全底線：就算被假訊息騙進來，最壞只是延後一小時再試，絕不丟信、絕不 ack。
//! 不含自動回信模式（cfg.respond）：那個模式的 worker 自己回答，信交出去就算已轉交（立刻 ack），沒有「轉交中」可以扣，
//! 扣住與試送都沒有意義，所以額度事件在該模式一律略過，照原本的等回覆逾時流程。
use super::*;
use crate::bridge::mail::{hold_late_line, taipei_hm};
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
        // 登入失效的扣住：worker 真的在工作了（不是「沒東西等」或試送沒回應），告訴登入失效偵測它好了，失效狀態才會解除（不然一時失敗會一直標失效、每 6 小時再提醒）
        #[cfg(feature = "gui")]
        if self.hold_auth && matches!(why, "worker reported sent" | "worker reported fail" | "worker reported misrouted" | "worker replied") {
            crate::login_watch::record_worker_recovered(self.now as i64);
        }
        self.quota_until = 0;
        self.probe_id = None;
        self.probe_misses = 0;
        self.log.line(&format!("quota hold released ({why}): resending held mail in order"));
        self.persist();
    }

    /// 這個收件人的信要經過收發室 worker（Claude 引擎）才送得到；其他引擎不受額度影響
    pub(super) fn via_worker(&self, target: &str) -> bool {
        self.engine_of(target) == "claude"
    }

    /// 在轉交文字的第一行（抬頭）後面加一行延遲說明
    pub(super) fn with_late_line(text: String, received_ms: u64, auth: bool) -> String {
        match text.split_once('\n') {
            Some((head, rest)) => format!("{head}\n{}\n{rest}", hold_late_line(received_ms, auth)),
            None => format!("{text}\n{}", hold_late_line(received_ms, auth)),
        }
    }

    /// 偵測重新登入的預設做法：Claude 登入檔比「扣住開始」新（只有電腦版才有，測試不用）
    pub(super) fn default_relogin_check() -> Option<Arc<dyn Fn(u64) -> bool + Send + Sync>> {
        #[cfg(all(feature = "gui", not(test)))]
        return Some(Arc::new(|since| crate::login_watch::credentials_updated_since(since)));
        #[allow(unreachable_code)]
        None
    }

    /// 收發室 worker 自己的 Claude 登入失效（todo-next-197）：照額度用完的做法扣住——這輪交辦的信放回去、不 ack、不再一封一封試，
    /// 寄件人同一段失效期間只通知一次；恢復靠每小時試送最舊的一封，或偵測到重新登入就提早試送，worker 能工作就依序重送。
    /// 同時記進登入失效偵測，讓本人收到通知（worker 明確回報的登入失效一筆就算，見 login_watch 的 WorkerAuth；試送成功就告訴偵測它好了）。自動回信模式沒有「轉交中」可扣，照原本的逾時流程
    pub(super) async fn on_worker_auth_failed(&mut self) {
        #[cfg(feature = "gui")]
        crate::login_watch::record_worker_login_error(self.now as i64);
        if self.cfg.respond.is_some() {
            self.log.line("worker reported an authentication failure (respond mode: not held, normal timeout flow)");
            return;
        }
        self.log.line("worker reported an authentication failure: holding mail until login is restored");
        self.on_hold(None, "auth", true).await;
    }

    /// 收發室 worker 回報額度用完
    pub(super) async fn on_quota(&mut self, resets_at: Option<u64>, kind: &str) {
        self.on_hold(resets_at, kind, false).await;
    }

    /// 扣住：額度用完（auth＝false）或收發室登入失效（auth＝true），除了通知寄件人的字、延遲說明的字，做法完全一樣
    async fn on_hold(&mut self, resets_at: Option<u64>, kind: &str, auth: bool) {
        let now = self.now;
        let was_holding = self.quota_until > 0;
        if !was_holding {
            self.hold_since = now;
        }
        self.hold_auth = auth;
        let until = resets_at.map(|s| s * 1000 + QUOTA_MARGIN_MS).filter(|u| *u > now).unwrap_or(now + QUOTA_RETRY_MS);
        // 暫停時間只會延長：扣住期間試送又撞額度（時間不明）不能把已知的重置時間縮短，也不能先清掉
        self.quota_until = self.quota_until.max(until);
        let until = self.quota_until;
        // 登入失效的第一次試送提早（約 5 分鐘）：馬上知道是不是暫時的，也讓登入失效偵測湊得到第二筆；之後才每小時一次
        let first_probe = if auth && !was_holding { AUTH_FIRST_PROBE_MS } else { QUOTA_RETRY_MS };
        self.next_probe_at = (now + first_probe).min(until);
        self.probe_id = None;
        self.log.line(&format!("worker quota exhausted ({kind}): hold until {} (resets_at={resets_at:?}), next probe {}", taipei_hm(until), taipei_hm(self.next_probe_at)));
        self.quota_ep.get_or_insert_with(Default::default).auth = auth;
        self.probe_misses = 0; // 收到真的額度事件：試送沒回應的計數歸零
        let newly = self.quota_hold_forwarding();
        self.persist();
        for m in newly {
            self.quota_notify_sender(&m).await;
        }
    }

    /// 轉交中的信改成扣住：個人信改成 Held；群組訊息改排進 HeldStore（存檔，恢復後向後台重讀）。回傳新扣住的個人信（通知寄件人用）
    pub(super) fn quota_hold_forwarding(&mut self) -> Vec<Mail> {
        let until = self.quota_until;
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
                self.held_first.entry(id.clone()).or_insert(it.received_at);
                if self.hold_auth {
                    self.held_auth.insert(id.clone());
                }
                self.held_items.insert(id.clone(), it);
                self.log.line(&format!("mail id={id} held for quota (not acked)"));
            }
        }
        newly
    }

    /// 排隊中的群組訊息的收件視窗是不是要經過收發室 worker（額度扣住時，其他引擎的視窗不受影響）
    pub(super) fn room_item_via_worker(&self, h: &Held) -> bool {
        let w = self.canonical_target(&format!("room:{}", h.room_id), &rooms::member_window(&h.member));
        let target = if w.is_empty() { self.unaddressed_window().unwrap_or_default() } else { w };
        target.is_empty() || self.via_worker(&target)
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
        let text = if self.quota_ep.as_ref().is_some_and(|e| e.auth) {
            "[收發室] 這台收發室的 Claude 登入失效了，信已收到、先留著，重新登入後會送出。".to_string()
        } else {
            format!("[收發室] 這台的收發室 Claude 額度用完，約 {}（台北）重置；信已收到，重置後自動轉交。", taipei_hm(self.quota_until))
        };
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
        // 第一次收到的時間：重送中用 late_from；信被重新拉回再扣住時用 held_first（延遲抬頭才不會變成最後一次拉到的時間）
        let received = self.late_from.take().or_else(|| self.held_first.get(&m.id).copied()).unwrap_or(self.now);
        self.held_first.insert(m.id.clone(), received);
        if self.hold_auth {
            self.held_auth.insert(m.id.clone());
        }
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
            let why = if self.hold_auth { "收發室登入失效" } else { "額度用完" };
            let text = format!("（收發室）{why}期間群組 {} 有 {n} 則沒有轉交，範圍 #{lo}～#{hi}，要看請讀群組", rooms::clean_label(&name));
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
            if self.quota_held_total() == 0 {
                self.hold_auth = false;
            }
        } else {
            // 登入失效期間偵測到重新登入（登入檔比扣住開始新）：不等下一個整點，馬上試送；試送後重新起算，免得每個 tick 都試
            if self.hold_auth && now < self.next_probe_at && self.relogin_since.as_ref().is_some_and(|f| f(self.hold_since)) {
                self.log.line("login credentials updated since the hold started: probing now");
                self.hold_since = now;
                self.next_probe_at = now;
            }
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
        self.probe_after_reset = now >= self.quota_until; // 暫停時間已過才試送：第一次沒回應就解除
        self.probe_prev_until = self.quota_until;
        self.quota_until = self.quota_until.max(now + QUOTA_RETRY_MS); // 先延長，試送期間暫停時間不會中斷
        self.probing = true;
        let mut expired: Vec<Held> = vec![];
        let outcome = if let (true, Some((_, _, id))) = (pick_mail, mail) {
            match self.held_items.remove(&id) {
                Some(it) => {
                    self.log.line(&format!("quota probe: sending oldest held mail id={id}"));
                    self.pending.retain(|p| p.id != id);
                    self.late_from = Some(it.received_at);
                    let left = self.handle_mail_raw(it.mail, it.raw).await;
                    self.late_from = None;
                    if self.pending.iter().any(|p| p.id == id && p.state == State::Forwarding) {
                        self.probe_id = Some(id);
                        RelOutcome::Delivered
                    } else if left.is_some() {
                        RelOutcome::Failed // 沒交成（worker 掛了）：信留在信箱，算一次沒回應
                    } else {
                        RelOutcome::Gone // 正常處理掉了（例如收件視窗已不在，回了說明並 ack）
                    }
                }
                None => RelOutcome::Gone,
            }
        } else if let Some(h) = room {
            self.log.line(&format!("quota probe: sending oldest held room message room={} #{}", h.room_id, h.seq));
            let r = self.release_held_item(&h, now, &mut expired).await;
            if matches!(r, RelOutcome::Delivered) {
                self.probe_id = Some(rooms::room_uuid(&h.room_id, h.seq, &h.member));
            }
            r
        } else {
            RelOutcome::Gone
        };
        self.probing = false;
        if !expired.is_empty() {
            self.quota_room_summary(&expired);
        }
        match outcome {
            RelOutcome::Delivered => {}
            RelOutcome::Failed => {
                self.quota_probe_miss("probe could not be handed to the worker");
            }
            RelOutcome::Gone => {
                // 這一則本身不需要試送了：不算沒回應，還原暫停時間，下一個 tick 換下一則
                self.quota_until = self.probe_prev_until;
                self.next_probe_at = now;
            }
        }
        self.persist();
    }

    /// 試送沒有得到 worker 的回報（逾時，或根本交不出去）算一次沒回應。沒回應不是額度用完的證據（worker 可能卡死或壞了），
    /// 所以不延長暫停：已過暫停時間才試送的，第一次就解除；還沒到的，連續第二次才解除。回 true＝已解除（信走一般流程）
    pub(super) fn quota_probe_miss(&mut self, why: &str) -> bool {
        self.probe_misses += 1;
        if self.probe_after_reset || self.probe_misses >= 2 {
            self.log.line(&format!("quota probe miss {} ({why}): hold released, normal flow", self.probe_misses));
            self.quota_release(why);
            self.quota_ep = None;
            true
        } else {
            self.log.line(&format!("quota probe miss {} ({why}): back to held, retry in an hour", self.probe_misses));
            self.quota_until = self.probe_prev_until; // 沒回應不延長暫停
            self.probe_id = None;
            false
        }
    }

    /// Sent 比額度事件晚到、而那封是群組訊息（已排進 HeldStore）：其實已經轉交成功，從清單拿掉並開始等回覆，恢復後不再轉交一次
    pub(super) fn quota_sent_after_hold_room(&mut self, id: &str) {
        let Some(h) = self.held.items().iter().find(|h| h.held_at > 0 && rooms::room_uuid(&h.room_id, h.seq, &h.member) == id).cloned() else { return };
        let window = rooms::member_window(&h.member);
        let target = if window.is_empty() { self.unaddressed_window().unwrap_or_default() } else { self.canonical_target(&format!("room:{}", h.seq), &window) };
        if let Err(e) = self.held.remove(&h.room_id, h.seq, &h.member) {
            self.log.line(&format!("rooms held save failed: {e}"));
            return;
        }
        self.log.line(&format!("sent room={} #{} arrived after the quota event: already forwarded, not resending", h.room_id, h.seq));
        let mut p = Pending::new(id, "", "", &target, self.now, false);
        p.room = Some(RoomRef { id: h.room_id.clone(), seq: h.seq, window });
        p.state = State::Waiting;
        self.pending.push(p);
        self.persist();
    }
}

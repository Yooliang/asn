//! 核對轉交對象：worker 把信送到不是橋指定的視窗時的處理（hook 與 SENT 比對見 bridge/forward_gate.rs、worker.rs）。
//! 送錯的那封：不 ack，重送一次給正確的視窗，第二次還是錯就回 Fail；寄件人收到固定文字的通知（不帶內文，寫明可能已被讀取）；
//! 拿錯信的視窗收到一封固定文字的更正。
use super::*;

/// 第二次送錯回給寄件人的 Fail 原因
const MISROUTE_FAIL: &str = "核對轉交對象失敗";

impl Core {
    /// worker 回報：帶著這封的編號呼叫 SendMessage 並且成功，但收件人不是橋指定的
    pub(super) async fn on_misrouted(&mut self, id: &str, expected: &str, actual: &str) {
        self.log.line(&format!("misrouted id={id} expected={expected} actual={actual}"));
        self.quota_release("worker reported misrouted"); // worker 有在動（但不算轉交成功）
        // 通知與更正：每個編號各一次（同一個編號對的、錯的呼叫都有時也一樣：算 Sent，照樣通知）
        if self.misroute_notified.len() >= 1000 {
            self.misroute_notified.clear();
        }
        if self.misroute_notified.insert(id.to_string()) {
            self.misroute_notify_owner(id).await;
            self.misroute_notify_sender(id, expected).await;
            self.misroute_correct_receiver(id, expected, actual);
        }
        // 已經算轉交成功（Sent）的，只通知；還在轉交中的才重送
        let Some(i) = self.idx(id) else { return };
        if self.pending[i].state != State::Forwarding {
            return;
        }
        if self.misrouted_once.len() >= 1000 {
            self.misrouted_once.clear();
        }
        if self.misrouted_once.insert(id.to_string()) {
            let Some((to, text)) = self.fwd_text.get(id).cloned() else {
                self.on_fail(id, MISROUTE_FAIL).await;
                return;
            };
            let payload = self.register_forward(id, &to, &text);
            self.write_inflight();
            match self.sink.say(payload) {
                Ok(_) => self.log.line(&format!("misrouted id={id}: resent once to {to}")),
                Err(e) => {
                    self.log.line(&format!("misrouted id={id}: resend failed: {e}"));
                    self.on_fail(id, MISROUTE_FAIL).await;
                }
            }
        } else {
            self.parser.forget(id);
            self.fwd_text.remove(id);
            self.write_inflight();
            self.log.line(&format!("misrouted id={id}: second time, giving up"));
            self.on_fail(id, MISROUTE_FAIL).await;
        }
    }

    /// 通知這台電腦的主人：請後台寄一封固定內文的通知給節點擁有者（內文只有設備名與信件編號，由後台決定）。
    /// 失敗（後台還沒有這個動作、連不上）只記 log，不影響重送、Fail 與寄件人通知
    async fn misroute_notify_owner(&mut self, id: &str) {
        // 群組訊息沒有信件編號
        let is_mail = match self.idx(id) {
            Some(i) => self.pending[i].room.is_none(),
            None => self.fwd_origin.contains_key(id),
        };
        let body = json!({ "mail_id": if is_mail { json!(id) } else { Value::Null } });
        match self.relay.api("misroute_notice", Some(body)).await {
            Ok(_) => self.log.line(&format!("misrouted id={id}: owner notice requested")),
            Err(e) => self.log.line(&format!("misrouted id={id}: owner notice failed: {e}")),
        }
    }

    /// 寄件人收到固定文字的通知（不帶信件內文）。群組訊息、收發室寄來的不通知
    async fn misroute_notify_sender(&mut self, id: &str, expected: &str) {
        let origin = match self.idx(id) {
            Some(i) if self.pending[i].room.is_some() => None,
            Some(i) => Some(Origin::of(&self.pending[i])),
            None => self.fwd_origin.get(id).cloned(),
        };
        let Some(o) = origin else { return };
        if Self::is_system_notice(&o.from_agent) {
            return;
        }
        // 只寫寄件人自己指定的收件人；實際收到的視窗名可能是這台電腦上別人的，不寫進通知
        let text = format!("[收發室] 你寄給 {expected} 的信（編號 {id}）曾被誤送到同一台電腦的另一個視窗，可能已被讀取，收發室正在重新轉交給 {expected}。");
        self.send_back(&o, &text, None, Some(false)).await;
    }

    /// 拿錯信的視窗收到一封固定文字的更正（這封有自己的編號，hook 才放行）
    fn misroute_correct_receiver(&mut self, id: &str, expected: &str, actual: &str) {
        if actual == expected || !self.forwardable(actual) {
            return;
        }
        self.tell_window(actual, &format!("（收發室更正）剛才編號 {id} 那封信不是寄給你的，請不要照做，也不要回覆寄件人。"));
    }

    /// 這個編號是額度扣住中的群組訊息（已從 pending 移除、排在清單裡）：它的轉交結果可能還在路上，編號要留到它真的放行或放棄
    fn held_room_id(&self, id: &str) -> bool {
        self.held.items().iter().any(|h| h.held_at > 0 && rooms::room_uuid(&h.room_id, h.seq, &h.member) == id)
    }

    /// 定時整理：不在轉交中、也不是剛送出的說明的編號，從 hook 的 inflight 檔拿掉（hook 之後一律擋）
    pub(super) fn prune_inflight(&mut self) {
        let stale: Vec<String> = self.parser.inflight_pairs().into_iter().map(|(id, _)| id).filter(|id| self.idx(id).is_none() && !self.notice_ids.contains_key(id) && !self.held_room_id(id)).collect();
        for id in stale {
            self.parser.forget(&id);
        }
        let live: HashSet<String> = self.parser.inflight_pairs().into_iter().map(|(id, _)| id).collect();
        self.fwd_text.retain(|id, _| live.contains(id));
        self.write_inflight();
    }
}

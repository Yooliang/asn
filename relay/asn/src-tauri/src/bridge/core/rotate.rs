//! 同一種被擋原因連續幾次就換一輪新的收發室對話，並通知擁有者（#2146 ③）。
//! 收發室 worker 轉交信件被轉交閘門（forward_gate）擋下時，模型可能照著對話歷史裡的錯誤示範一直犯同一個錯，整輪卡死。
//! 這裡數「同一類原因」連續被擋幾次，達到 ROTATE_AFTER 就殺掉 worker（監督程式會起一個全新的 claude，沒有舊對話歷史），
//! 重新起來之後把還在轉交中的信照原文重送。log 與通知只寫原因分類與次數，不寫信件內文。
use super::super::forward_gate::DenyKind;
use super::*;

/// 同一類被擋原因連續幾次就換一輪。取 3：1 次可能只是模型手滑，2 次還可能自己改對；
/// 連續 3 次同樣的錯，通常代表它在照歷史裡的錯誤示範抄，再等下去只是白白逾時
pub const ROTATE_AFTER: u32 = 3;
/// 連續換幾輪都沒有成功轉交過就停手（換了還是被擋，換輪救不了，要人處理）。中間有任何一次轉交成功就從頭算
pub const ROTATE_MAX_CHAIN: u32 = 3;
/// 同一台、同一個視窗、同一種通知，最短隔多久才再通知一次（毫秒）
pub const ROTATE_NOTICE_GAP_MS: u64 = 10 * 60 * 1000;

#[derive(Default)]
pub(in super::super) struct RotateState {
    /// 目前連續被擋的原因與次數
    streak: Option<(DenyKind, u32)>,
    /// 已經連續換了幾輪（中間沒有轉交成功過）
    chain: u32,
    /// 新的 worker 起來之後要把轉交中的信重送
    resend: bool,
    /// 上次通知的時間：(視窗名, 是不是「需要人工處理」) → 毫秒
    notice_at: HashMap<(String, bool), u64>,
}

impl RotateState {
    #[cfg(test)]
    pub(in super::super) fn chain(&self) -> u32 {
        self.chain
    }
}

impl Core {
    /// 轉交成功了：被擋的連續次數與換輪次數都歸零
    pub(super) fn rotate_note_ok(&mut self) {
        self.rotate.streak = None;
        self.rotate.chain = 0;
    }

    /// 一次被閘門擋下：同一類就累計，不同類就從 1 重數
    pub(super) async fn on_gate_denied(&mut self, kind: DenyKind) {
        if self.cfg.respond.is_some() {
            return; // 自動回信模式沒有轉交閘門
        }
        let n = match self.rotate.streak {
            Some((k, n)) if k == kind => n + 1,
            _ => 1,
        };
        self.rotate.streak = Some((kind, n));
        if n < ROTATE_AFTER {
            return;
        }
        self.rotate.streak = None;
        let window = self.cfg.mailbox_name.clone();
        if self.rotate.chain >= ROTATE_MAX_CHAIN {
            self.log.line(&format!("ERROR forward-gate-rotate-stop reason={} count={n} rotations={}: still blocked after {} fresh conversations, auto-rotate stopped, needs manual handling", kind.code(), self.rotate.chain, self.rotate.chain));
            self.rotate_notice(&window, kind, n, true).await;
            return;
        }
        self.rotate.chain += 1;
        self.log.line(&format!("WARN forward-gate-rotate reason={} count={n} rotation={}/{}: same gate denial in a row, replacing the mailbox worker conversation (queued forwards will be resent)", kind.code(), self.rotate.chain, ROTATE_MAX_CHAIN));
        self.rotate_notice(&window, kind, n, false).await;
        self.rotate.resend = true;
        self.sink.kill();
    }

    /// 通知擁有者（沿用 waiting_notice：後台寫固定內文，只收視窗名、原因代號、次數）。同一個視窗同一種通知 10 分鐘內只送一次
    async fn rotate_notice(&mut self, window: &str, kind: DenyKind, n: u32, manual: bool) {
        let key = (window.to_string(), manual);
        let now = self.now;
        if self.rotate.notice_at.get(&key).is_some_and(|t| now.saturating_sub(*t) < ROTATE_NOTICE_GAP_MS) {
            self.log.line(&format!("forward-gate-rotate notice skipped window={window} manual={manual}: sent within the last 10 minutes"));
            return;
        }
        let body = json!({ "window": window, "kind": if manual { "forward_stuck_manual" } else { "forward_stuck" }, "detail": kind.code(), "tool": n.to_string() });
        match self.relay.api("waiting_notice", Some(body)).await {
            Ok(v) => {
                let notify = v.get("notify").and_then(Value::as_str).unwrap_or("");
                self.log.line(&format!("forward-gate-rotate notice window={window} manual={manual} notify={notify}"));
                // 後台查不到擁有者（skipped）再試也寄不到，一樣算過了；沒寄到（failed、到上限）不算，下次再試
                if matches!(notify, "sent" | "skipped") {
                    self.rotate.notice_at.insert(key, now);
                }
            }
            Err(e) => self.log.line(&format!("forward-gate-rotate notice failed window={window} manual={manual}: {e}")),
        }
    }

    /// 換輪後新的 worker 起來了：還在轉交中的信（個人信、群組訊息）照橋存的原文重送，並把逾時重新算起，不讓它們在換輪空檔逾時
    pub(super) fn rotate_resend(&mut self) {
        if !std::mem::take(&mut self.rotate.resend) {
            return;
        }
        let mut ids: Vec<(u64, String)> = self.pending.iter().filter(|p| p.state == State::Forwarding).map(|p| (p.t0, p.id.clone())).collect();
        ids.sort();
        let mut sent = 0;
        for (_, id) in ids {
            let Some((to, text)) = self.fwd_text.get(&id).cloned() else { continue };
            let payload = self.register_forward(&id, &to, &text);
            self.write_inflight();
            if self.sink.say(payload).is_err() {
                self.log.line("forward-gate-rotate: resend failed, the new worker is not ready (the forward will time out as usual)");
                break;
            }
            if let Some(i) = self.idx(&id) {
                self.pending[i].t0 = self.now;
            }
            sent += 1;
        }
        if sent > 0 {
            self.fwd_turn_open = Some(self.now);
        }
        self.log.line(&format!("forward-gate-rotate: resent {sent} forwards to the new worker conversation"));
    }
}

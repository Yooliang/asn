//! 對方視窗沒收下信（#773）：寄件端工具回成功，信其實還沒進去。CLI 串流只給收件人名字，沒有信件編號，
//! 所以用「收件人＋最近轉交」對回去，通知寫「可能」。第一版只通知與記 log：不重送、不撤回 ack。
use super::*;

/// 扣住的通知通常一秒內就到；超過這麼久的轉交不對回去
const HELD_MATCH_WINDOW_MS: u64 = 300_000;
const RECENT_FORWARDS_MAX: usize = 50;
const HELD_NOTICE_SENT_MAX: usize = 1000;

impl Core {
    pub(super) fn note_forwarded(&mut self, target: String, origin: Origin) {
        if self.recent_forwards.len() >= RECENT_FORWARDS_MAX {
            self.recent_forwards.remove(0);
        }
        self.recent_forwards.push((target, origin, self.now));
    }

    pub(super) async fn on_delivery_problem(&mut self, kind: &str, recipient: &str) {
        let now = self.now;
        let hits: Vec<Origin> = self
            .recent_forwards
            .iter()
            .filter(|(to, _, at)| to.eq_ignore_ascii_case(recipient) && now.saturating_sub(*at) <= HELD_MATCH_WINDOW_MS)
            .map(|(_, origin, _)| origin.clone())
            .collect();
        self.log.line(&format!("delivery {kind}: recent mail candidates={}", hits.len()));
        if self.held_notice_sent.len() >= HELD_NOTICE_SENT_MAX {
            self.held_notice_sent.clear();
        }
        for origin in hits {
            // 同一封先扣住、後來被拒絕，兩種各通知一次
            if !self.held_notice_sent.insert(format!("{kind}:{}", origin.id)) || Self::is_mailbox_sender(&origin.from_agent) {
                continue;
            }
            self.log.line(&format!("delivery {kind}: notifying sender id={}", origin.id));
            let text = match kind {
                "denied" => format!("[收發室] 你寄給 {recipient} 的這封信可能被對方視窗的使用者拒絕了，沒有送進去。收發室不會重送。"),
                "refused" => format!("[收發室] 你寄給 {recipient} 的這封信可能沒送進去：對方視窗目前不接受其他視窗的信。收發室不會重送。"),
                _ => format!("[收發室] 你寄給 {recipient} 的這封信可能卡在對方視窗的確認框，對方還沒看到。需要有人在那台電腦上按確認；收發室不會重送。"),
            };
            self.send_back(&origin, &text, None, Some(false)).await;
        }
    }
}

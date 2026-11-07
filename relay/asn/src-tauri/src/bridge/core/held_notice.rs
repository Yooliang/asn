//! 對方視窗沒收下信（#773）：寄件端工具回成功，信其實還沒進去。CLI 串流只給收件人名字，沒有信件編號，
//! 所以用「收件人＋最近轉交」對回去，通知寫「可能」。只通知與記 log：不重送、不撤回 ack。
//! 對回：held／refused 對回最新一封還沒通知過的；denied 對回最早一封卡住中的（人按拒絕可能很久以後），released 只把它拿掉。
//! 本人那邊走 #784：確認框上的視窗 session 檔是 waiting／permission prompt，wait_notice_tick 會通知。
use super::*;

/// 扣住的通知通常一秒內就到；超過這麼久的轉交不對回去
const HELD_MATCH_WINDOW_MS: u64 = 300_000;
const RECENT_FORWARDS_MAX: usize = 50;
const HELD_OPEN_MAX: usize = 50;
/// 卡住中的信放這麼久：視窗關掉就等不到結果，不能留著對到之後的信
const HELD_OPEN_TTL_MS: u64 = 86_400_000;

#[derive(Clone)]
pub(super) struct Forwarded {
    target: String,
    origin: Origin,
    /// 群組訊息：通知貼回群組
    room: Option<RoomRef>,
    /// 這封本身是收發室通知：出問題也不再發通知
    is_notice: bool,
    at: u64,
}

impl Forwarded {
    fn is_for(&self, recipient: &str) -> bool {
        self.target.trim_start_matches('@').eq_ignore_ascii_case(recipient)
    }
}

impl Core {
    pub(super) fn note_forwarded(&mut self, p: &Pending) {
        if self.recent_forwards.len() >= RECENT_FORWARDS_MAX {
            self.recent_forwards.remove(0);
        }
        let is_notice = self.bounce_notices.contains(&p.id);
        self.recent_forwards.push(Forwarded { target: p.target.clone(), origin: Origin::of(p), room: p.room.clone(), is_notice, at: self.now });
    }

    /// 時間窗內最新一封還沒通知過的
    fn take_recent(&mut self, recipient: &str) -> Option<Forwarded> {
        let now = self.now;
        let i = self.recent_forwards.iter().rposition(|f| f.is_for(recipient) && now.saturating_sub(f.at) <= HELD_MATCH_WINDOW_MS)?;
        Some(self.recent_forwards.remove(i))
    }

    /// 最早一封卡住中的（不看時間窗）
    fn take_held(&mut self, recipient: &str) -> Option<Forwarded> {
        let i = self.held_open.iter().enumerate().filter(|(_, f)| f.is_for(recipient)).min_by_key(|(_, f)| f.at).map(|(i, _)| i)?;
        Some(self.held_open.remove(i))
    }

    pub(super) async fn on_delivery_problem(&mut self, kind: &str, recipient: &str) {
        let now = self.now;
        self.held_open.retain(|f| now.saturating_sub(f.at) <= HELD_OPEN_TTL_MS);
        let hit = match kind {
            "released" => self.take_held(recipient),
            // 收發室重開過就沒有卡住中的紀錄，退回時間窗
            "denied" => match self.take_held(recipient) {
                Some(f) => Some(f),
                None => self.take_recent(recipient),
            },
            _ => self.take_recent(recipient),
        };
        let Some(f) = hit else {
            self.log.line(&format!("delivery {kind}: no matching mail"));
            return;
        };
        self.log.line(&format!("delivery {kind}: matched id={}", f.origin.id));
        if kind == "held" {
            if self.held_open.len() >= HELD_OPEN_MAX {
                self.held_open.remove(0);
            }
            self.held_open.push(f.clone());
        }
        if kind == "released" || f.is_notice || Self::is_system_notice(&f.origin.from_agent) {
            return;
        }
        if let Some(room) = &f.room {
            self.room_delivery_notice(room, &f.target, kind).await;
            return;
        }
        let text = match kind {
            "denied" => format!("[收發室] 你寄給 {recipient} 的這封信可能被對方視窗的使用者拒絕了，沒有送進去。收發室不會重送。"),
            "refused" => format!("[收發室] 你寄給 {recipient} 的這封信可能沒送進去：對方視窗目前不接受其他視窗的信。收發室不會重送。"),
            _ => format!("[收發室] 你寄給 {recipient} 的這封信可能卡在對方視窗的確認框，對方還沒看到。需要有人在那台電腦上按確認；收發室不會重送。"),
        };
        self.send_back(&f.origin, &text, None, Some(false)).await;
    }
}

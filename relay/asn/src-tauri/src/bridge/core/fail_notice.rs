//! 轉交失敗的通知：群組訊息轉交失敗時在群組留一則不點名的說明；收發室通知本身被退時不再發通知，不會連環。
//! 失敗次數固定寫 `forward-fail kind=...`，放行時用 log 統計。
use super::*;

/// 私信通知（失敗、逾時、送錯）的開頭
const MAIL_NOTICE_HEAD: &str = "[收發室] ";
/// 群組通知的開頭
const ROOM_NOTICE_HEAD: &str = "（收發室）群組訊息 #";
/// 同一個群組、同一個收件視窗，隔這麼久才再貼一則
const ROOM_NOTICE_GAP_MS: u64 = 600_000;
/// 同一個 worker 失敗到這個次數就在 log 留警告
const WORKER_FAIL_WARN_AT: u32 = 3;
/// 之後每多這麼多次再警告一次
const WORKER_FAIL_WARN_EVERY: u32 = 10;

/// 不寫 @：不點名任何人，通知不會指定叫醒誰。逾時只知道沒等到回報，信可能已經到了，說法不能講死
fn room_notice_text(seq: u64, target: &str, skipped: u32, timed_out: bool, reply_blocked: bool) -> String {
    let name = target.replace('@', "");
    let what = if reply_blocked {
        format!("{name} 收到了，但它的回覆被內容過濾擋下，沒有回到群組。")
    } else if timed_out {
        format!("可能沒有轉交給 {name}。")
    } else {
        format!("沒有轉交給 {name}，對方還沒看到。")
    };
    let more = if skipped > 0 { format!("這段時間另有 {skipped} 則情況相同。") } else { String::new() };
    format!("{ROOM_NOTICE_HEAD}{seq} {what}{more}需要對方處理請重新點名，或請對方讀群組。")
}

/// 群組訊息卡在對方視窗或被拒：不寫 @，說法是「可能」（CLI 只給收件人名字）
fn room_delivery_text(seq: u64, target: &str, kind: &str, skipped: u32) -> String {
    let name = target.replace('@', "");
    let what = match kind {
        "denied" => format!("可能被 {name} 視窗的使用者拒絕了，沒有送進去。"),
        "refused" => format!("可能沒送進 {name} 視窗：對方目前不接受其他視窗的信。"),
        _ => format!("可能卡在 {name} 視窗的確認框，對方還沒看到。需要有人在那台電腦上按確認。"),
    };
    let more = if skipped > 0 { format!("這段時間另有 {skipped} 則情況相同。") } else { String::new() };
    format!("{ROOM_NOTICE_HEAD}{seq} {what}{more}收發室不會重送。")
}

#[cfg(test)]
mod notice_tests {
    use super::*;

    #[test]
    fn 群組失敗通知三種說法_沒轉交_可能沒轉交_收到了但回覆被擋下() {
        let a = room_notice_text(5, "@甲", 0, false, false);
        assert!(a.contains("沒有轉交給 甲，對方還沒看到") && !a.contains('@'), "{a}");
        assert!(room_notice_text(5, "甲", 0, true, false).contains("可能沒有轉交給 甲"));
        let c = room_notice_text(5, "甲", 2, false, true);
        assert!(c.contains("甲 收到了，但它的回覆被內容過濾擋下，沒有回到群組") && !c.contains("對方還沒看到") && !c.contains("沒有轉交"), "{c}");
        assert!(c.contains("另有 2 則情況相同"));
    }

    #[test]
    fn 群組卡住通知三種說法_不點名_都寫可能() {
        for (kind, word) in [("held", "確認框"), ("denied", "拒絕"), ("refused", "不接受")] {
            let t = room_delivery_text(5, "@甲", kind, 0);
            assert!(t.starts_with(ROOM_NOTICE_HEAD) && t.contains(word) && t.contains("可能") && !t.contains('@'), "{t}");
        }
        assert!(room_delivery_text(5, "甲", "held", 2).contains("另有 2 則情況相同"));
    }
}

impl Core {
    /// 記下這封信本身是不是收發室通知：之後被退就不再發通知。
    /// 主要看寄件名／kind（is_notice，由呼叫端用 Mail::is_system_notice 判斷）；內文字頭只是備援，
    /// 因為代夥伴寄的「轉交失敗」說明寄件名是夥伴名，只有字頭認得出來
    pub(super) fn note_if_notice(&mut self, id: &str, body: &str, is_notice: bool) {
        if is_notice || body.starts_with(MAIL_NOTICE_HEAD) || body.starts_with(ROOM_NOTICE_HEAD) {
            self.bounce_notices.insert(id.to_string());
        }
    }

    /// 失敗次數的固定字樣（每次失敗一行）
    pub(super) fn count_forward_fail(&self, kind: &str, id: &str, target: &str) {
        self.log.line(&format!("forward-fail kind={kind} id={id} target={target}"));
    }

    /// worker 回報失敗：這個 worker 累積太多次就留警告，只寫 log，要不要重開由人決定
    pub(super) fn count_worker_fail(&mut self) {
        self.worker_fails += 1;
        let n = self.worker_fails;
        if n == WORKER_FAIL_WARN_AT || (n > WORKER_FAIL_WARN_AT && (n - WORKER_FAIL_WARN_AT) % WORKER_FAIL_WARN_EVERY == 0) {
            self.log.line(&format!("WARN worker-fail-streak count={n}: this mailbox worker keeps failing forwards, consider restarting it"));
        }
    }

    /// 群組訊息轉交失敗或逾時：貼一則說明到群組，不經收發室。通知本身失敗就不再通知；同一個收件視窗有冷卻
    pub(super) async fn room_forward_failed(&mut self, id: &str, kind: &str, timed_out: bool, why: &str) {
        let Some(p) = self.idx(id).map(|i| self.pending[i].clone()) else { return };
        let Some(room) = p.room else { return };
        self.count_forward_fail(kind, id, &p.target);
        if self.bounce_notices.contains(id) {
            self.log.line(&format!("room failure notice not posted id={id}: the failed message is itself a notice"));
            return;
        }
        let key = (room.id.clone(), p.target.clone());
        let Some(skipped) = self.room_notice_turn(&key) else {
            self.log.line(&format!("room failure notice skipped id={id}: posted recently for {}", p.target));
            return;
        };
        let posted = self.post_room(&room, &room_notice_text(room.seq, &p.target, skipped, timed_out, Self::reply_blocked(why))).await;
        self.log.line(&format!("room failure notice room={} #{} -> {} posted={posted}", room.id, room.seq, p.target));
        if posted {
            self.room_fail_notices.insert(key, (self.now, 0));
        }
    }

    /// 群組訊息卡在對方視窗或被拒：貼一則說明。每種情況各自冷卻，卡住之後被拒絕還是貼得出來
    pub(super) async fn room_delivery_notice(&mut self, room: &RoomRef, target: &str, kind: &str) {
        let key = (room.id.clone(), format!("{kind}:{target}"));
        let Some(skipped) = self.room_notice_turn(&key) else {
            self.log.line(&format!("room delivery {kind} notice skipped room={} #{}: posted recently for {target}", room.id, room.seq));
            return;
        };
        let posted = self.post_room(room, &room_delivery_text(room.seq, target, kind, skipped)).await;
        self.log.line(&format!("room delivery {kind} notice room={} #{} -> {target} posted={posted}", room.id, room.seq));
        if posted {
            self.room_fail_notices.insert(key, (self.now, 0));
        }
    }

    /// 這個群組、這個對象現在能不能貼通知：冷卻中回 None 並記一則；能貼就回冷卻期間略過了幾則
    fn room_notice_turn(&mut self, key: &(String, String)) -> Option<u32> {
        let now = self.now;
        self.room_fail_notices.retain(|_, (t, _)| now.saturating_sub(*t) < ROOM_NOTICE_GAP_MS * 6);
        match self.room_fail_notices.get_mut(key) {
            Some((t, n)) if now.saturating_sub(*t) < ROOM_NOTICE_GAP_MS => {
                *n += 1;
                None
            }
            Some((_, n)) => Some(*n),
            None => Some(0),
        }
    }
}

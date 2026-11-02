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

/// 不寫 @：不點名任何人，通知不會指定叫醒誰
fn room_notice_text(seq: u64, target: &str, skipped: u32) -> String {
    let name = target.replace('@', "");
    let more = if skipped > 0 { format!("這段時間另有 {skipped} 則也沒轉交。") } else { String::new() };
    format!("{ROOM_NOTICE_HEAD}{seq} 沒有轉交給 {name}，對方還沒看到。{more}需要對方處理請重新點名，或請對方讀群組。")
}

impl Core {
    /// 記下這封信本身是不是收發室通知：之後被退就不再發通知
    pub(super) fn note_if_notice(&mut self, id: &str, body: &str) {
        if body.starts_with(MAIL_NOTICE_HEAD) || body.starts_with(ROOM_NOTICE_HEAD) {
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

    /// 群組訊息轉交失敗：貼一則說明到群組，不經收發室。通知本身失敗就不再通知；同一個收件視窗有冷卻
    pub(super) async fn room_forward_failed(&mut self, id: &str, kind: &str) {
        let Some(p) = self.idx(id).map(|i| self.pending[i].clone()) else { return };
        let Some(room) = p.room else { return };
        self.count_forward_fail(kind, id, &p.target);
        if self.bounce_notices.contains(id) {
            self.log.line(&format!("room failure notice not posted id={id}: the failed message is itself a notice"));
            return;
        }
        let now = self.now;
        let key = (room.id.clone(), p.target.clone());
        self.room_fail_notices.retain(|_, (t, _)| now.saturating_sub(*t) < ROOM_NOTICE_GAP_MS * 6);
        let skipped = match self.room_fail_notices.get_mut(&key) {
            Some((t, n)) if now.saturating_sub(*t) < ROOM_NOTICE_GAP_MS => {
                *n += 1;
                self.log.line(&format!("room failure notice skipped id={id}: posted recently for {}", p.target));
                return;
            }
            Some((_, n)) => *n,
            None => 0,
        };
        let posted = self.post_room(&room, &room_notice_text(room.seq, &p.target, skipped)).await;
        self.log.line(&format!("room failure notice room={} #{} -> {} posted={posted}", room.id, room.seq, p.target));
        if posted {
            self.room_fail_notices.insert(key, (now, 0));
        }
    }
}

//! ack 失敗的信：信已經處理完了，只是後台沒記到。記下來隔一段時間補 ack，拉信時也不再轉交一次。
//! 清單寫進 pending.json，重開後接著補。真的不見了（超過上限、存檔壞掉）：
//! 還在 pending 的信拉到時直接補 ack；不在 pending 的信會再轉交一次，多一封但不會漏信。
use super::*;

const ACK_RETRY_MAX: usize = 500;
const ACK_RETRY_FIRST_MS: u64 = 30_000;
const ACK_RETRY_MAX_GAP_MS: u64 = 600_000;
/// 後台一次最多收 100 筆，而且每筆都要是 UUID，否則整批回 400
const ACK_BATCH_MAX: usize = 100;

fn is_uuid(s: &str) -> bool {
    let groups: Vec<&str> = s.split('-').collect();
    groups.iter().map(|g| g.len()).eq([8, 4, 4, 4, 12]) && groups.iter().all(|g| g.chars().all(|c| c.is_ascii_hexdigit()))
}

impl Core {
    pub(super) fn is_ack_retry(&self, id: &str) -> bool {
        self.ack_retry.iter().any(|i| i == id)
    }

    /// 這些信 ack 失敗：記下來；已經在等下一次補的話時間不變
    pub(super) fn note_ack_failed(&mut self, ids: &[String]) {
        for id in ids {
            if !self.is_ack_retry(id) {
                self.ack_retry.push(id.clone());
            }
        }
        while self.ack_retry.len() > ACK_RETRY_MAX {
            let dropped = self.ack_retry.remove(0);
            self.log.line(&format!("ack retry list full: dropped id={dropped}, it may be forwarded again"));
        }
        if self.ack_retry_at == 0 {
            self.ack_retry_gap = ACK_RETRY_FIRST_MS;
            self.ack_retry_at = self.now + ACK_RETRY_FIRST_MS;
        }
        self.persist();
    }

    /// ack 成功：從清單拿掉；清空了就重設退避
    pub(super) fn note_acked(&mut self, ids: &[String]) {
        for id in ids {
            self.seen.insert(id.clone());
            self.held_first.remove(id);
            self.held_auth.remove(id);
        }
        if self.ack_retry.is_empty() {
            return;
        }
        self.ack_retry.retain(|i| !ids.contains(i));
        if self.ack_retry.is_empty() {
            self.ack_retry_at = 0;
            self.ack_retry_gap = 0;
        }
        self.persist();
    }

    /// 重開後讀回的清單：下一個 tick 就補
    pub(super) fn restore_ack_retry(&mut self, ids: Vec<String>) {
        let all = ids.len();
        let ids: Vec<String> = ids.into_iter().filter(|i| is_uuid(i)).collect();
        if ids.len() < all {
            self.log.line(&format!("ack retry restored: dropped {} invalid ids", all - ids.len()));
        }
        if !ids.is_empty() {
            self.log.line(&format!("ack retry restored: {}", ids.len()));
            self.ack_retry = ids;
            self.ack_retry_gap = ACK_RETRY_FIRST_MS;
            self.ack_retry_at = self.now;
        }
    }

    /// 到時間就補一次；一直失敗時間隔加倍，最多 10 分鐘
    pub async fn ack_retry_tick(&mut self, now: u64) {
        if self.ack_retry.is_empty() || now < self.ack_retry_at {
            return;
        }
        let ids = self.ack_retry.clone();
        // 分批送；某批失敗就停，已送成功的不用再送
        for batch in ids.chunks(ACK_BATCH_MAX) {
            if let Err(e) = self.relay.api("ack", Some(json!({ "ids": batch }))).await {
                self.ack_retry_gap = (self.ack_retry_gap * 2).clamp(ACK_RETRY_FIRST_MS, ACK_RETRY_MAX_GAP_MS);
                self.ack_retry_at = now + self.ack_retry_gap;
                self.log.line(&format!("ack retry failed: {} waiting, next in {}s: {e}", self.ack_retry.len(), self.ack_retry_gap / 1000));
                return;
            }
            self.note_acked(batch);
        }
        self.log.line(&format!("ack retry ok: {}", ids.len()));
    }
}

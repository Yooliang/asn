//! 共用的終端服務中斷：請後台寄信通知本人（#596）。偵測在背景執行緒（launch/mux_watch），那邊只排一個通知檔；
//! 這裡每輪看有沒有，有就呼叫後台 `mux_down_notice`。文字固定在後台，只帶人數與有沒有接回，不帶夥伴名字。
//! 舊後台（404）、參數不合（400）、節點停用（403）都只記 log、不重試；寄送失敗隔一分鐘再試，事故過了十分鐘就放棄。
use super::*;
use crate::launch::mux_watch;

const RETRY_MS: u64 = 60_000;
/// 事故過了這麼久還沒通知成功就放棄（太晚的通知只會讓人困惑）
const GIVE_UP_MS: u64 = 600_000;

impl Core {
    pub async fn mux_notice_tick(&mut self, now: u64) {
        if self.cfg.respond.is_some() || now < self.mux_notice_retry_at {
            return;
        }
        let dir = self.cfg.work_dir.clone();
        let Some((count, resumed, at)) = mux_watch::read_notice(&dir) else { return };
        let wall = crate::heartbeat::now_ms();
        if at > 0 && wall.saturating_sub(at) > GIVE_UP_MS {
            self.log.line(&format!("mux-notice: 事故已過十分鐘，不再通知 count={count}"));
            mux_watch::clear_notice(&dir);
            return;
        }
        let body = json!({ "count": count, "resumed": resumed });
        match self.relay.api_status("mux_down_notice", body).await {
            Ok((200, v)) => {
                let notify = v.get("notify").and_then(Value::as_str).unwrap_or("");
                self.log.line(&format!("mux-notice count={count} resumed={resumed} notify={notify}"));
                match notify {
                    // 寄出了、後台查不到擁有者、到上限：這次事故到此為止
                    "sent" | "skipped" | "rate_limited" => mux_watch::clear_notice(&dir),
                    // 寄送失敗（或看不懂的回答）：隔一分鐘再試
                    _ => self.mux_notice_retry_at = now + RETRY_MS,
                }
            }
            // 舊後台沒有這個動作、參數不合、節點停用：再試也一樣，只留本機提示
            Ok((status @ (400 | 403 | 404), _)) => {
                self.log.line(&format!("mux-notice: 後台回 {status}，只留本機提示 count={count}"));
                mux_watch::clear_notice(&dir);
            }
            Ok((status, _)) => {
                self.mux_notice_retry_at = now + RETRY_MS;
                self.log.line(&format!("mux-notice: 後台回 {status}，稍後再試"));
            }
            Err(e) => {
                self.mux_notice_retry_at = now + RETRY_MS;
                self.log.line(&format!("mux-notice failed: {e}"));
            }
        }
    }
}

//! 共用的終端服務中斷：請後台寄信通知本人（#596）。偵測在背景執行緒（launch/mux_watch），那邊只排一個通知檔；
//! 這裡每輪看有沒有，有就呼叫後台 `mux_down_notice`。文字固定在後台，只帶人數與有沒有接回，不帶夥伴名字。
//! 舊後台（404）、參數不合（400）、節點停用（403）都只記 log、不重試；寄送失敗隔一分鐘再試，事故過了十分鐘就放棄。
use super::*;
use crate::launch::mux_watch;

const RETRY_MS: u64 = 60_000;
/// 事故過了這麼久還沒通知成功就放棄（太晚的通知只會讓人困惑）
const GIVE_UP_MS: u64 = 600_000;

/// 接回結果的通知做完後過了這麼久還沒送成就放棄
const RESUME_GIVE_UP_MS: u64 = 3_600_000;

/// 「監看看不到終端服務」的通知過了這麼久還沒送成就放棄
const BLIND_GIVE_UP_MS: u64 = 3_600_000;

/// 後台收的夥伴名字長度上限（Edge 以 UTF-16 單位算）
const NAME_MAX_UNITS: usize = 64;
const NAME_EMPTY: &str = "未命名夥伴";

/// 接回結果通知用的名字：去頭尾空白；空的寫「未命名夥伴」；超過 64 個字就截短、結尾加「…」
fn tidy_name(name: &str) -> String {
    let t = name.trim();
    if t.is_empty() {
        return NAME_EMPTY.to_string();
    }
    if t.encode_utf16().count() <= NAME_MAX_UNITS {
        return t.to_string();
    }
    let mut out = String::new();
    let mut units = 0;
    for c in t.chars() {
        units += c.len_utf16();
        if units > NAME_MAX_UNITS - 1 {
            break;
        }
        out.push(c);
    }
    out.push('…');
    out
}

impl Core {
    /// 監看連續看不到終端服務（launch/mux_watch 排了通知檔）：請後台寄一則通知給本人（同一台 24 小時一次由後台擋）。
    /// 舊後台（404）、參數不合（400）、節點停用（403）只記 log 不重試；寄送失敗隔一分鐘再試，過一小時放棄
    pub async fn mux_blind_tick(&mut self, now: u64) {
        if self.cfg.respond.is_some() || now < self.mux_blind_retry_at {
            return;
        }
        let dir = self.cfg.work_dir.clone();
        let Some(at) = mux_watch::read_blind(&dir) else { return };
        if crate::heartbeat::now_ms().saturating_sub(at) > BLIND_GIVE_UP_MS {
            self.log.line("mux-blind: 過了一小時，不再通知");
            mux_watch::clear_blind(&dir);
            return;
        }
        match self.relay.api_status("mux_blind_notice", json!({})).await {
            Ok((200, v)) => {
                let notify = v.get("notify").and_then(Value::as_str).unwrap_or("");
                self.log.line(&format!("mux-blind notify={notify}"));
                match notify {
                    "sent" | "skipped" | "rate_limited" => mux_watch::clear_blind(&dir),
                    _ => self.mux_blind_retry_at = now + RETRY_MS,
                }
            }
            Ok((status @ (400 | 403 | 404), _)) => {
                self.log.line(&format!("mux-blind: 後台回 {status}，只留本機紀錄"));
                mux_watch::clear_blind(&dir);
            }
            Ok((status, _)) => {
                self.mux_blind_retry_at = now + RETRY_MS;
                self.log.line(&format!("mux-blind: 後台回 {status}，稍後再試"));
            }
            Err(e) => {
                self.mux_blind_retry_at = now + RETRY_MS;
                self.log.line(&format!("mux-blind failed: {e}"));
            }
        }
    }

    /// 讀共用終端服務監看的名單（至多每 5 秒一次）：中斷後還沒接回來的、和最近還看得到的夥伴名字
    fn refresh_mux_pending(&mut self, now: u64) {
        if now.saturating_sub(self.mux_pending_at) < 5_000 {
            return;
        }
        self.mux_pending_at = now;
        let file = self.cfg.work_dir.join(mux_watch::STATE_FILE);
        let wall = crate::heartbeat::now_ms();
        let (lost, recent) = mux_watch::pending_split(&file, wall);
        self.mux_lost = lost.iter().cloned().collect();
        self.mux_pending = lost.into_iter().chain(recent).collect();
        // 確定自己結束的：忘掉它（不再等它接回），寄給它的信馬上退回「找不到」
        // 同名的又開起來、已經在名單上的不算（監看下一輪也會拿掉）
        self.mux_exited = mux_watch::exited_names(&file, wall).into_iter().filter(|n| !self.roster.iter().any(|w| w.name == *n)).collect();
        for n in self.mux_exited.clone() {
            if self.known.contains(&n) {
                self.log.line(&format!("window {n} exited on its own: forgotten, mail to it is bounced"));
                self.known.forget(&n);
            }
            self.seen_run.remove(&n);
            self.missing.remove(&n);
        }
    }

    /// 終端服務中斷後的自動接回做完了（launch/mux_round 排了結果檔）：請後台寄一則「斷了幾位、接回幾位、誰沒接回」給本人，
    /// 放在原本的 mux_down 通知種類裡。舊後台（404）、參數不合（400）、節點停用（403）只記 log 不重試（事故當下那一則已經寄過）；
    /// 寄送失敗隔一分鐘再試，過一小時放棄。名字只在這則通知帶；沒接回的原因是技術細節，只進 ui.log
    pub async fn mux_resume_notice_tick(&mut self, now: u64) {
        if self.cfg.respond.is_some() || now < self.mux_resume_notice_retry_at {
            return;
        }
        let dir = self.cfg.work_dir.clone();
        let Some((count, resumed, failed, at)) = crate::launch::mux_round::read_resume_notice(&dir) else { return };
        if at > 0 && crate::heartbeat::now_ms().saturating_sub(at) > RESUME_GIVE_UP_MS {
            self.log.line(&format!("mux-resume-notice: 過了一小時，不再通知 count={count}"));
            crate::launch::mux_round::clear_resume_notice(&dir);
            return;
        }
        // 名字先整理：太長的截短、空的補名字，後台才不會整則回 400、通知寄不出去
        let failed: Vec<String> = failed.iter().map(|n| tidy_name(n)).collect();
        let body = json!({ "count": count, "resumed": resumed, "failed": failed });
        match self.relay.api_status("mux_resume_notice", body).await {
            Ok((200, v)) => {
                let notify = v.get("notify").and_then(Value::as_str).unwrap_or("");
                self.log.line(&format!("mux-resume-notice count={count} resumed={resumed} failed={} notify={notify}", failed.len()));
                match notify {
                    "sent" | "skipped" | "rate_limited" => crate::launch::mux_round::clear_resume_notice(&dir),
                    _ => self.mux_resume_notice_retry_at = now + RETRY_MS,
                }
            }
            Ok((status @ (400 | 403 | 404), _)) => {
                self.log.line(&format!("mux-resume-notice: 後台回 {status}，只留本機提示 count={count}"));
                crate::launch::mux_round::clear_resume_notice(&dir);
            }
            Ok((status, _)) => {
                self.mux_resume_notice_retry_at = now + RETRY_MS;
                self.log.line(&format!("mux-resume-notice: 後台回 {status}，稍後再試"));
            }
            Err(e) => {
                self.mux_resume_notice_retry_at = now + RETRY_MS;
                self.log.line(&format!("mux-resume-notice failed: {e}"));
            }
        }
    }

    pub async fn mux_notice_tick(&mut self, now: u64) {
        self.refresh_mux_pending(now);
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

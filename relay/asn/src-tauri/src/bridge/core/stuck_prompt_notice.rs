//! 夥伴視窗卡在確認框超過 5 分鐘的保底通知（#2256）：寄兩份。
//! 判斷在 launch/stuck_prompt.rs（背景讀畫面放進佇列），這裡只負責送：
//! - 給擁有者：後台 waiting_notice（kind=stuck_prompt，內文由後台寫「…卡在確認框超過 5 分鐘」，附擷取的那一段畫面，最多 600 字）。
//! - 給夥伴本人：寄一封給自己這台電腦、指定那個視窗的信，橋收到後照一般來信轉進視窗（和 partner_ops 的 tell 同一條路）。
//!   主代理不知道自己的子代理卡在確認框（確認框只顯示在終端上給人按），所以即使手機已經有權限確認，這份仍要寄。
//! 兩份各自記有沒有送成：一份失敗只重試那一份，隔一分鐘再試，過一小時放棄；失敗原因只進 log。
use super::super::login_alert::login_window_text;
use super::*;
use crate::launch::stuck_prompt::{StuckPrompt, PARTNER_TEXT};

const RETRY_MS: u64 = 60_000;
/// 排了這麼久還沒送成就放棄（太晚的通知只會讓人困惑）
const GIVE_UP_MS: u64 = 3_600_000;
/// 等著送的最多幾筆
const TODO_MAX: usize = 50;

pub(super) struct StuckItem {
    p: StuckPrompt,
    at: u64,
    owner_done: bool,
    partner_done: bool,
}

impl Core {
    /// 背景讀畫面排進佇列的卡住視窗；沒有桌面或測試時為空
    fn stuck_prompts() -> Vec<StuckPrompt> {
        #[cfg(all(feature = "gui", not(test)))]
        {
            return crate::launch::stuck_prompt::take_pending();
        }
        #[allow(unreachable_code)]
        Vec::new()
    }

    pub async fn stuck_prompt_tick(&mut self, now: u64) {
        if self.cfg.respond.is_some() {
            return;
        }
        for p in Self::stuck_prompts() {
            self.stuck_prompt_enqueue(now, p);
        }
        if now < self.stuck_retry_at {
            return;
        }
        self.stuck_prompt_send(now).await;
    }

    pub(in crate::bridge) fn stuck_prompt_enqueue(&mut self, now: u64, p: StuckPrompt) {
        if self.stuck_todo.len() < TODO_MAX {
            self.stuck_todo.push(StuckItem { p, at: now, owner_done: false, partner_done: false });
        }
    }

    pub(in crate::bridge) async fn stuck_prompt_send(&mut self, now: u64) {
        let mut todo = std::mem::take(&mut self.stuck_todo);
        let mut failed = false;
        for item in todo.iter_mut() {
            if !item.owner_done {
                item.owner_done = self.stuck_notice_owner(&item.p).await;
                failed |= !item.owner_done;
            }
            if !item.partner_done {
                item.partner_done = self.stuck_notice_partner(&item.p).await;
                failed |= !item.partner_done;
            }
        }
        todo.retain(|i| {
            let done = i.owner_done && i.partner_done;
            if !done && now.saturating_sub(i.at) > GIVE_UP_MS {
                self.log.line(&format!("stuck-prompt window={}: 過了一小時還沒送成，不再通知", i.p.name));
                return false;
            }
            !done
        });
        if failed && !todo.is_empty() {
            self.stuck_retry_at = now + RETRY_MS;
        }
        self.stuck_todo = todo;
    }

    /// 給擁有者。送成、後台查不到擁有者、舊後台不認得這個種類（400／403／404，再試也一樣）都算做完
    async fn stuck_notice_owner(&self, p: &StuckPrompt) -> bool {
        let body = json!({ "window": login_window_text(&p.name), "kind": "stuck_prompt", "detail": p.excerpt, "tool": Value::Null });
        match self.relay.api_status("waiting_notice", body).await {
            Ok((200, v)) => {
                let notify = v.get("notify").and_then(Value::as_str).unwrap_or("");
                self.log.line(&format!("stuck-prompt owner window={} notify={notify}", p.name));
                matches!(notify, "sent" | "skipped" | "rate_limited")
            }
            Ok((status @ (400 | 403 | 404), _)) => {
                self.log.line(&format!("stuck-prompt owner window={}: 後台回 {status}，只留本機紀錄", p.name));
                true
            }
            Ok((status, _)) => {
                self.log.line(&format!("stuck-prompt owner window={}: 後台回 {status}，稍後再試", p.name));
                false
            }
            Err(e) => {
                self.log.line(&format!("stuck-prompt owner failed window={}: {e}", p.name));
                false
            }
        }
    }

    /// 給那個夥伴本人（寄進它自己的視窗）
    async fn stuck_notice_partner(&self, p: &StuckPrompt) -> bool {
        let body = json!({ "to_node": self.cfg.node, "to_agent": p.name, "body": PARTNER_TEXT, "from_agent": self.cfg.mailbox_name, "expects_reply": false });
        match self.relay.api("send", Some(body)).await {
            Ok(_) => {
                self.log.line(&format!("stuck-prompt partner window={} sent", p.name));
                true
            }
            Err(e) => {
                self.log.line(&format!("stuck-prompt partner failed window={}: {e}", p.name));
                false
            }
        }
    }
}

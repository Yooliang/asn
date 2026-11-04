//! 夥伴卡在要人處理的框上超過兩分鐘：請後台通知本人（todo-next-162）。開關 ASN_WAIT_ALERT=1，預設關。
//! 權限框與 hook 框只帶視窗名和種類，不帶指令內容；選擇框才帶問題和選項。失敗只記 log，隔一分鐘再試。
use super::super::wait_alert::{kind_of, Waiting};
use super::*;

const RETRY_MS: u64 = 60_000;

impl Core {
    pub async fn wait_notice_tick(&mut self, now: u64) {
        if !self.cfg.wait_alert || self.cfg.respond.is_some() || now < self.wait_retry_at {
            return;
        }
        let mut waiting = Vec::new();
        let mut missing_fields = false;
        for w in &self.claude_roster {
            let Some(s) = roster::read_session_wait(&self.cfg.sessions_dir, w.pid) else { continue };
            missing_fields |= s.status.is_none() || s.since == 0;
            if s.status.as_deref() == Some("waiting") {
                waiting.push(Waiting { name: w.name.clone(), session_id: w.session_id.clone(), waiting_for: s.waiting_for, since: s.since });
            }
        }
        if missing_fields {
            self.warn_session_fields();
        }
        for w in self.wait_alerts.due(now, &waiting) {
            let kind = kind_of(w.waiting_for.as_deref());
            // 選擇框才帶問題和選項（外掛有回報時）；權限框不帶任何指令內容
            let detail = if kind == "input" { w.session_id.as_deref().and_then(|sid| roster::read_mod_question(&self.cfg.status_dir, sid)) } else { None };
            // 權限框只帶工具名（外掛有回報時），不帶指令內容
            let tool = if kind == "permission" { w.session_id.as_deref().and_then(|sid| roster::read_mod_tool(&self.cfg.status_dir, sid)) } else { None };
            let body = json!({ "window": w.name, "kind": kind, "detail": detail, "tool": tool });
            match self.relay.api("waiting_notice", Some(body)).await {
                Ok(v) => {
                    self.wait_alerts.mark_sent(&w, now);
                    self.log.line(&format!("wait-alert window={} kind={kind} notify={}", w.name, v.get("notify").and_then(Value::as_str).unwrap_or("")));
                }
                Err(e) => {
                    self.wait_retry_at = now + RETRY_MS;
                    self.log.line(&format!("wait-alert failed window={} kind={kind}: {e}", w.name));
                    return;
                }
            }
        }
    }

    /// session 檔沒有 status 或 statusUpdatedAt：Claude 改了內部欄位，這個提醒可能失效。每次啟動記一次
    fn warn_session_fields(&mut self) {
        if !self.wait_fields_warned {
            self.wait_fields_warned = true;
            self.log.line("wait-alert: session file has no status or statusUpdatedAt; waiting windows may go unnoticed");
        }
    }
}

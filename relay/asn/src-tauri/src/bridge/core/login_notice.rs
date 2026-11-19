//! 夥伴視窗停在登入逾時畫面（#1792）：通知本人手機。走 waiting_notice（kind=login，後台寫固定內文），
//! 也不吃 ASN_WAIT_ALERT 開關。失敗只記 log，隔一分鐘再試。
use super::super::login_alert::{login_window_text, LOGIN_FILE};
use super::*;

const RETRY_MS: u64 = 60_000;

impl Core {
    /// 讀畫面（背景工作）最新判成 login 的視窗名；沒有桌面或測試時為空
    fn login_windows() -> Vec<String> {
        #[cfg(all(feature = "gui", not(test)))]
        {
            let login = crate::launch::claude_screen::status_code(crate::launch::claude_screen::ClaudeScreenKind::Login);
            return crate::launch::term::partner_notices().into_iter().filter(|n| n.code == login).map(|n| n.name).collect();
        }
        #[allow(unreachable_code)]
        Vec::new()
    }

    pub async fn login_notice_tick(&mut self, now: u64) {
        if self.cfg.respond.is_some() || now < self.login_retry_at {
            return;
        }
        let names = Self::login_windows();
        self.login_notice_send(now, &names).await;
    }

    pub(super) async fn login_notice_send(&mut self, now: u64, names: &[String]) {
        for name in self.login_alerts.due(now, names) {
            let body = json!({ "window": login_window_text(&name), "kind": "login", "detail": Value::Null, "tool": Value::Null });
            match self.relay.api("waiting_notice", Some(body)).await {
                Ok(v) => {
                    let notify = v.get("notify").and_then(Value::as_str).unwrap_or("");
                    self.log.line(&format!("login-alert window={name} notify={notify}"));
                    match notify {
                        // 後台查不到擁有者：再試也寄不到，這次停住到此為止
                        "sent" | "skipped" => {
                            self.login_alerts.mark_sent(&name, now);
                            if let Err(e) = self.login_alerts.save(&self.cfg.work_dir.join(LOGIN_FILE)) {
                                self.log.line(&format!("login-alert: save failed: {e}"));
                            }
                        }
                        _ => {
                            self.login_retry_at = now + RETRY_MS;
                            return;
                        }
                    }
                }
                Err(e) => {
                    self.login_retry_at = now + RETRY_MS;
                    self.log.line(&format!("login-alert failed window={name}: {e}"));
                    return;
                }
            }
        }
    }
}

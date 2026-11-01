//! 收件名同時有兩個以上 Claude 視窗時的處理（#584，說明文字與規則見 bridge/dup_session.rs）。
use super::*;
use crate::bridge::dup_session::{self, Hold};

impl Core {
    /// 名單上這個名字的 Claude 視窗有幾個（名單只收活著的程序，殘檔不算）
    fn claude_count(&self, name: &str) -> usize {
        self.roster.iter().filter(|w| w.name == name && w.engine == "claude").count()
    }

    /// 回 Some(結果)＝這封信在這裡處理完（handle_mail_raw 直接回傳它）；None＝照常往下轉交
    pub(super) async fn dup_gate(&mut self, m: &Mail, target: &str, o: &Origin) -> Option<Option<String>> {
        let po = self.partner_ops.clone()?;
        if self.engine_of(target) != "claude" || self.is_respond(target) {
            return None;
        }
        // 本人按了「關掉」：只關指定的那一個（不管現在還是不是同名，交給 close_dup 判斷並回覆）
        if let Some(cmd) = slash::parse(m).filter(|c| c.command == dup_session::CLOSE_CMD) {
            return Some(self.close_dup_cmd(&po, m, target, &cmd.args).await);
        }
        if self.claude_count(target) < 2 {
            if self.dup_held.remove(&m.id).is_some() {
                self.log.line(&format!("id={} to={target}: only one window now, delivering held mail", m.id));
            }
            return None;
        }
        match dup_session::hold_state(self.dup_held.get(&m.id).copied(), self.now) {
            Hold::Waiting => Some(Some(target.to_string())),
            Hold::Expired => {
                self.dup_held.remove(&m.id);
                self.log.line(&format!("id={} to={target}: still duplicate windows after waiting, gave up", m.id));
                if !Self::is_mailbox_sender(&o.from_agent) {
                    self.send_back(o, &dup_session::expired_text(target), Some(target), None).await;
                }
                self.ack_ids(&[m.id.clone()]).await;
                Some(None)
            }
            Hold::First => {
                let name = target.to_string();
                let wins = tokio::task::spawn_blocking(move || po.dup_windows(&name)).await.unwrap_or_default();
                if wins.len() < 2 {
                    return None; // 名單慢了一步，其實已經剩一個
                }
                self.dup_held.insert(m.id.clone(), self.now);
                let pids: Vec<String> = wins.iter().map(|w| w.pid.to_string()).collect();
                self.log.line(&format!("id={} to={target}: {} live windows share this name (pids {}), mail held until one is closed", m.id, wins.len(), pids.join(",")));
                if !Self::is_mailbox_sender(&o.from_agent) {
                    let text = dup_session::notice_text(target, &wins, self.now, mail::is_person_mail(m));
                    self.send_back(o, &text, Some(target), None).await;
                }
                Some(Some(target.to_string()))
            }
        }
    }

    /// 本人寄來的 `/asn-close-dup <pid>`：背景關掉那一個，做完由 PartnerOps 回信並 ack
    async fn close_dup_cmd(&mut self, po: &Arc<PartnerOps>, m: &Mail, target: &str, args: &str) -> Option<String> {
        match po.command_state(&m.id) {
            Some(true) => {
                self.ack_ids(&[m.id.clone()]).await;
                return None;
            }
            Some(false) => return Some(target.to_string()),
            None => {}
        }
        let from_agent = m.from_agent.clone().unwrap_or_default();
        let Some(pid) = dup_session::parse_close_args(args) else {
            let o = Origin { id: m.id.clone(), from_node: m.from_node.clone(), from_agent };
            self.send_back(&o, "沒關掉：不知道要關哪一個", Some(target), Some(false)).await;
            self.ack_ids(&[m.id.clone()]).await;
            return None;
        };
        self.log.line(&format!("id={} from={}/{from_agent}: owner asked to close duplicate window pid={pid} of {target}", m.id, m.from_node));
        let sender = mail::sender_line(m).trim_start_matches("寄件人：").to_string();
        let job = CommandJob { mail_id: m.id.clone(), window: target.to_string(), command: dup_session::CLOSE_CMD.into(), args: pid.to_string(), from_node: m.from_node.clone(), from_agent, sender, reply_from: target.to_string() };
        po.start_close_dup(job, pid);
        Some(target.to_string())
    }
}

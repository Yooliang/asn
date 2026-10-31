//! 同名的多個 Claude 視窗（#584）：列出是哪幾個、本人按「關掉」時只關指定的那一個 pid。
//! 守門與一般「關閉」相同（遠端管理開關、保護名單、可結束清單，見 guard／close）；
//! 另外要求「現在仍然同名的活視窗有兩個以上、而且這個 pid 是其中之一」，不是同名的視窗一律不動。
use super::*;
use crate::bridge::dup_session::{self, DupWin};

impl PartnerOps {
    /// 這個名字目前活著的互動式 Claude 視窗（殘檔、pid 被重用的不算），依開啟時間排序
    pub(crate) fn dup_windows(&self, name: &str) -> Vec<DupWin> {
        let os = self.env.os();
        let live: Vec<(u32, String, u64)> = console::read_sessions(&self.dirs.sessions)
            .iter()
            .filter(|s| s.get("name").and_then(Value::as_str) == Some(name))
            .filter(|s| s.get("kind").and_then(Value::as_str).map(|k| k == "interactive").unwrap_or(true))
            .filter(|s| self.session_live(s))
            .filter_map(|s| {
                let pid = u32::try_from(s.get("pid").and_then(Value::as_u64)?).ok()?;
                Some((pid, s.get("sessionId").and_then(Value::as_str).unwrap_or("").to_string(), s.get("startedAt").and_then(Value::as_u64).unwrap_or(0)))
            })
            .filter(|(p, _, _)| *p != 0 && os.alive(*p))
            .collect();
        if live.len() < 2 {
            return live.into_iter().map(|(pid, session_id, started_ms)| DupWin { pid, session_id, started_ms, by_asn: false, remote: false }).collect();
        }
        let table = os.processes();
        let mut out: Vec<DupWin> = live
            .into_iter()
            .map(|(pid, session_id, started_ms)| DupWin {
                pid,
                session_id,
                started_ms,
                by_asn: switch::opened_by_asn(os, &table, pid),
                remote: os.cmdline(pid).map(|l| dup_session::has_remote_control(&switch::parse_cmdline(&l))).unwrap_or(false),
            })
            .collect();
        out.sort_by_key(|w| (w.started_ms, w.pid));
        out
    }

    /// 關掉同名視窗中指定的那一個。回（成功與否, 給寄件人看的短句）
    pub(crate) fn close_dup(&self, name: &str, pid: u32) -> (bool, String) {
        let key = name.to_lowercase();
        if !self.inflight.lock().unwrap().insert(key.clone()) {
            return (false, "這個視窗正在處理上一個操作，請稍後再試".into());
        }
        let r = self.close_dup_turn(name, pid);
        self.inflight.lock().unwrap().remove(&key);
        r
    }

    fn close_dup_turn(&self, name: &str, pid: u32) -> (bool, String) {
        let wins = self.dup_windows(name);
        if wins.len() < 2 {
            return (false, "已經只剩一個視窗了".into());
        }
        let Some(w) = wins.iter().find(|w| w.pid == pid) else {
            return (false, "找不到這個視窗，可能已經關了".into());
        };
        if (self.protect)(name, pid) {
            return (false, PROTECTED.into());
        }
        let t = match switch::resolve(self.env.os(), &self.dirs.sessions, name, Some((pid, &w.session_id))) {
            Ok(t) => t,
            Err(e) => return (false, format!("沒關掉：{e}")),
        };
        let r = self.close(&t);
        if r.status == "ok" {
            (true, "已關掉，剛才的信會自動重送".into())
        } else {
            (false, format!("沒關掉：{}", r.detail))
        }
    }

    /// 本人按了「關掉」：背景關（不擋收信），做完回信、寫往來記錄與 log、ack 原信
    pub(crate) fn start_close_dup(self: &Arc<Self>, job: CommandJob, pid: u32) {
        self.mark_job_started(&job.mail_id);
        let me = self.clone();
        tokio::spawn(async move {
            let (m2, name) = (me.clone(), job.window.clone());
            let (good, text) = tokio::task::spawn_blocking(move || m2.close_dup(&name, pid)).await.unwrap_or_else(|e| (false, format!("沒關掉：背景工作失敗：{e}")));
            me.finish_job(&job, good, &text).await;
        });
    }
}

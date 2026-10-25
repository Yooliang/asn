//! 工作者的遠端管理（詳情、重開、接班換手）。放在 acp_worker 的子模組，才讀得到它的私有欄位。
//! 只動收發室自己啟動、記錄在案的驅動程序：結束的是驅動回報的那個 pid（帳本上的那一個），絕不用名稱比對找程序。
use super::{Store, Worker};
use crate::bridge::engines::acp_config::WorkerCfg;
use std::sync::Arc;

/// 接班換手給新對話的第一則提示（比照 Claude 視窗的接班說明）：ACP 工作者沒有前任的對話紀錄檔可讀，
/// 換手時也沒有請前任寫交接，所以明說「從空白開始」，請它先向寄件人確認進度；使用者補的話換行附上
pub fn handover_prompt(name: &str, note: &str) -> String {
    let mut s = format!(
        "你是『{name}』的下一任，前任的對話已經換掉了。這類工作者沒有可以讀的前任對話紀錄，換手時也沒有請前任寫交接，所以你不會記得前任做過什麼。\
先向寄件人確認目前的進度與待辦，再把工作接著做下去。"
    );
    let note = note.trim();
    if !note.is_empty() {
        s.push_str("\n前任交代：");
        s.push_str(&note.chars().take(1000).collect::<String>());
    }
    s
}

#[derive(Debug, Clone, PartialEq)]
pub enum LoadState {
    Loading,
    Ready,
    Failed(String),
}

/// 詳情用的快照
#[derive(Debug, Clone)]
pub struct WorkerSnapshot {
    pub name: String,
    pub protocol: String,
    pub engine_label: String,
    pub model: String,
    pub permissions: [(&'static str, &'static str); 4],
    pub cwd: String,
    /// 驅動程序現在是否在跑，以及帳本上的 pid（沒在跑 0）
    pub process_running: bool,
    pub pid: u32,
    pub status: &'static str,
    pub has_session: bool,
    pub load_session: Option<bool>,
}

impl Store {
    /// 清掉某個工作者的對話編號（接班換手）。下次啟動時會開全新的對話
    pub fn clear(&self, cfg: &WorkerCfg) {
        let mut g = self.state.lock().unwrap();
        if g.remove(&cfg.name).is_some() {
            self.persist(&g);
        }
    }
}

impl Worker {
    pub fn snapshot(&self) -> WorkerSnapshot {
        let cfg = &self.i.cfg;
        let (d, status) = {
            let s = self.st.lock().unwrap();
            (s.driver.clone(), s.health.name())
        };
        let rule = |c: &'static str| (c, cfg.permissions.rule(c).name());
        WorkerSnapshot {
            name: cfg.name.clone(),
            protocol: cfg.protocol.clone(),
            engine_label: cfg.roster_engine.clone(),
            model: cfg.model.clone(),
            permissions: [rule("read"), rule("write"), rule("execute"), rule("network")],
            cwd: cfg.cwd.to_string_lossy().to_string(),
            process_running: d.as_ref().map(|d| d.alive()).unwrap_or(false),
            pid: d.as_ref().filter(|d| d.alive()).map(|d| d.pid()).unwrap_or(0),
            status: if self.status() == "busy" { "busy" } else { status },
            has_session: !self.i.store.get(cfg).is_empty(),
            load_session: d.as_ref().and_then(|d| d.load_session()),
        }
    }

    /// 接手：這個工作者要載入的是別人（使用者在終端機開的 grok）的對話。第一則提示附接手說明；對話編號已由呼叫端存好
    pub fn mark_adopted(&self) {
        let mut s = self.st.lock().unwrap();
        s.need_preamble = true;
        s.handover = Some(crate::bridge::engines::grok_adopt::adopt_prompt(&self.i.cfg.name));
    }

    /// 接手載入的進度：Ready＝驅動在跑且已載入指定的對話；Failed＝啟動失敗（附原因）；否則還在載入
    pub fn load_state(&self, session_id: &str) -> LoadState {
        let s = self.st.lock().unwrap();
        if let Some(d) = s.driver.as_ref().filter(|d| d.alive() && d.session_id() == session_id) {
            let _ = d;
            return LoadState::Ready;
        }
        if !s.start_error.is_empty() && !s.starting {
            return LoadState::Failed(s.start_error.clone());
        }
        LoadState::Loading
    }

    /// 動手前的共同檢查：正在處理信件、正在啟動或正在關閉時不動（回原因）。通過就把目前的驅動拿走（回它的 pid 與本體）
    fn take_driver_for_admin(&self) -> Result<(u32, Option<Arc<dyn super::Driver>>), String> {
        let mut s = self.st.lock().unwrap();
        if s.stopping {
            return Err("這個工作者正在關閉".into());
        }
        if s.running || !s.queue.is_empty() {
            return Err("工作者正在處理信件，等它做完再試".into());
        }
        if s.starting {
            return Err("工作者正在啟動，稍後再試".into());
        }
        let d = s.driver.take();
        let pid = d.as_ref().filter(|d| d.alive()).map(|d| d.pid()).unwrap_or(0);
        Ok((pid, d))
    }

    /// 重開：結束驅動程序，讓收發室重新啟動它；對話編號留著，能接續就接續。回被結束的 pid（本來就沒在跑 0）
    pub fn admin_restart(self: &Arc<Self>) -> Result<u32, String> {
        let (pid, d) = self.take_driver_for_admin()?;
        if let Some(d) = d {
            d.stop();
        }
        self.log(format!("遠端管理：重開（結束程序 pid={pid}）"));
        self.warm();
        Ok(pid)
    }

    /// 接班換手：清掉對話編號、結束驅動程序後重開；第一則提示是接班說明。回被結束的 pid
    pub fn admin_handover(self: &Arc<Self>, note: &str) -> Result<u32, String> {
        let (pid, d) = self.take_driver_for_admin()?;
        if let Some(d) = d {
            d.stop();
        }
        self.i.store.clear(&self.i.cfg);
        {
            let mut s = self.st.lock().unwrap();
            s.need_preamble = true;
            s.handover = Some(handover_prompt(&self.i.cfg.name, note));
        }
        self.log(format!("遠端管理：接班換手（結束程序 pid={pid}，對話編號已清掉）"));
        self.warm();
        Ok(pid)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 接班提示_說明沒有前任紀錄_使用者補的話附在後面_最多一千字() {
        let p = handover_prompt("Gemini", "");
        assert!(p.contains("『Gemini』的下一任") && p.contains("沒有請前任寫交接") && !p.contains("前任交代"));
        let p = handover_prompt("Gemini", &format!(" 小心 {}", "字".repeat(1500)));
        assert!(p.contains("\n前任交代：小心"));
        assert_eq!(p.split("前任交代：").nth(1).unwrap().chars().count(), 1000);
    }
}

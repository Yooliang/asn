//! 工作者的遠端管理（詳情、重開、換班接手）。放在 acp_worker 的子模組，才讀得到它的私有欄位。
//! 只動收發室自己啟動、記錄在案的驅動程序：結束的是驅動回報的那個 pid（帳本上的那一個），絕不用名稱比對找程序。
use super::{Store, Worker};
use crate::bridge::engines::acp_config::WorkerCfg;
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

/// 切換模型最多等這麼久（原生切換的回應、或列出 agy 可選模型）
const SET_MODEL_WAIT: Duration = Duration::from_secs(40);

/// 遠端管理是同步呼叫：把非同步的工作丟到執行環境上跑，在這裡等結果（逾時回錯誤）。不用 block_on，呼叫端在不在執行環境的執行緒上都可以
fn run_blocking<T: Send + 'static>(fut: impl std::future::Future<Output = T> + Send + 'static, wait: Duration) -> Result<T, String> {
    let (tx, rx) = std::sync::mpsc::channel();
    crate::rt::spawn(async move {
        let _ = tx.send(fut.await);
    });
    rx.recv_timeout(wait).map_err(|_| "工作者太久沒有回應，稍後再試".to_string())
}

/// 換班接手給新對話的第一則提示（比照 Claude 視窗的接班說明）：ACP 工作者沒有前任的對話紀錄檔可讀，
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

/// 改名後給工作者的提示（接在開頭說明後面）：名字改了、對話照舊
pub fn rename_prompt(old_name: &str, new_name: &str) -> String {
    format!("使用者把你的名字改成了『{new_name}』（原本叫『{old_name}』）。之後請用新名字自稱；前面的對話與手上的工作照舊接著做。")
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
    /// 清掉某個工作者的對話編號（換班接手）。下次啟動時會開全新的對話
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
            model: self.effective_model(),
            permissions: [rule("read"), rule("write"), rule("execute"), rule("network")],
            cwd: cfg.cwd.to_string_lossy().to_string(),
            process_running: d.as_ref().map(|d| d.alive()).unwrap_or(false),
            pid: d.as_ref().filter(|d| d.alive()).map(|d| d.pid()).unwrap_or(0),
            status: match self.status() {
                "busy" => "busy",
                "stopped" => "stopped",
                _ => status,
            },
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

    /// 動手前的共同檢查：正在處理信件、正在啟動或正在關閉時不動（回原因）
    fn admin_busy(s: &super::St) -> Result<(), String> {
        if s.stopping {
            return Err("這個工作者正在關閉".into());
        }
        if s.running || !s.queue.is_empty() {
            return Err("工作者正在處理信件，等它做完再試".into());
        }
        if s.starting {
            return Err("工作者正在啟動，稍後再試".into());
        }
        Ok(())
    }

    /// 通過共同檢查就把目前的驅動拿走（回它的 pid 與本體）
    fn take_driver_for_admin(&self) -> Result<(u32, Option<Arc<dyn super::Driver>>), String> {
        let mut s = self.st.lock().unwrap();
        Self::admin_busy(&s)?;
        let d = s.driver.take();
        let pid = d.as_ref().filter(|d| d.alive()).map(|d| d.pid()).unwrap_or(0);
        Ok((pid, d))
    }

    /// 關閉（停止本次執行）：結束驅動程序，不再收信，名單上暫時看不到；只改記憶體狀態，不動 agents.json 等設定檔。
    /// 「重開」「換班接手」或 ASN 重啟可恢復。回被結束的 pid（本來就沒在跑 0）
    pub fn admin_stop(self: &Arc<Self>) -> Result<u32, String> {
        if self.st.lock().unwrap().admin_stopped {
            return Err("這個工作者已經關閉了".into());
        }
        let (pid, d) = self.take_driver_for_admin()?;
        self.st.lock().unwrap().admin_stopped = true;
        if let Some(d) = d {
            d.stop();
        }
        self.i.approvals.cancel_all(&self.i.cfg.name);
        self.log(format!("遠端管理：關閉（結束程序 pid={pid}，本次執行不再收信）"));
        let _ = self.i.events.send(crate::bridge::engines::EngineEvent::RosterChanged);
        Ok(pid)
    }

    /// 移除（給 acp_admin 用；名冊與記下的模型由呼叫端刪）：正在處理信件就拒絕；結束驅動程序、不再收信、取消等著的授權、清掉對話編號。
    /// 之後這個工作者就從工作者清單拿掉，不會再啟動。回被結束的 pid（本來就沒在跑 0）
    pub fn admin_remove(self: &Arc<Self>) -> Result<u32, String> {
        let (pid, d) = self.take_driver_for_admin()?;
        {
            let mut s = self.st.lock().unwrap();
            s.admin_stopped = true;
            s.stopping = true;
        }
        if let Some(d) = d {
            d.stop();
        }
        self.i.approvals.cancel_all(&self.i.cfg.name);
        self.i.store.clear(&self.i.cfg);
        self.log(format!("遠端管理：移除（結束程序 pid={pid}，對話編號已清掉；工作資料夾的檔案留著）"));
        Ok(pid)
    }

    /// 改名的第一步（給 acp_admin 用）：正在處理信件、啟動中就拒絕；結束驅動程序、不再收信、取消等著的授權，**不清對話編號**（要搬到新名字）。
    /// 改名失敗時呼叫 [`Worker::start`] 就用原名原樣重開。回被結束的 pid（本來就沒在跑 0）
    pub fn admin_detach(self: &Arc<Self>) -> Result<u32, String> {
        let (pid, d) = {
            let mut s = self.st.lock().unwrap();
            Self::admin_busy(&s)?;
            s.stopping = true;
            let d = s.driver.take();
            (d.as_ref().filter(|d| d.alive()).map(|d| d.pid()).unwrap_or(0), d)
        };
        if let Some(d) = d {
            d.stop();
        }
        self.i.approvals.cancel_all(&self.i.cfg.name);
        self.log(format!("遠端管理：改名前先停下（結束程序 pid={pid}，對話編號留著）"));
        Ok(pid)
    }

    /// 改名用：同一份設定（含目前實際用的模型、原本的工作資料夾），只換名字
    pub fn renamed_cfg(&self, new_name: &str) -> WorkerCfg {
        WorkerCfg { name: new_name.to_string(), ..(*self.cfg_now()).clone() }
    }

    /// 還沒送出去的第一則提示（例如接手說明）：改名後的新工作者要接著帶
    pub fn pending_intro(&self) -> Option<String> {
        let s = self.st.lock().unwrap();
        s.handover.clone().filter(|_| s.need_preamble)
    }

    /// 改名後的新工作者：下一輪重送開頭說明（裡面是新名字），並告訴它名字改了；before＝舊工作者還沒送出的提示，接在前面
    pub fn mark_renamed(&self, old_name: &str, before: Option<String>) {
        let note = rename_prompt(old_name, &self.i.cfg.name);
        let mut s = self.st.lock().unwrap();
        s.need_preamble = true;
        s.handover = Some(match before {
            Some(b) => format!("{b}\n{note}"),
            None => note,
        });
    }

    /// 之前被「關閉」過：恢復收信並通知名單有變（沒被關過就什麼都不做）
    fn revive_after_admin_stop(&self) {
        let was = std::mem::replace(&mut self.st.lock().unwrap().admin_stopped, false);
        if was {
            let _ = self.i.events.send(crate::bridge::engines::EngineEvent::RosterChanged);
        }
    }

    /// 重開：結束驅動程序，讓收發室重新啟動它；對話編號留著，能接續就接續。回被結束的 pid（本來就沒在跑 0）
    pub fn admin_restart(self: &Arc<Self>) -> Result<u32, String> {
        let (pid, d) = self.take_driver_for_admin()?;
        if let Some(d) = d {
            d.stop();
        }
        self.log(format!("遠端管理：重開（結束程序 pid={pid}）"));
        self.revive_after_admin_stop();
        self.warm();
        Ok(pid)
    }

    /// 切換模型。模型一律先比對可選清單，不在清單裡就拒絕；正在處理信件就直接回「等它做完再試」，不排隊。
    /// 標準 ACP（Grok）：用 agent 原生的 session/set_model，不重啟、對話不斷；可選清單＝agent 在 session/new 回的 availableModels。
    /// agy 原生：換掉模型後帶同一個對話編號重開（停幾秒）；可選清單＝`agy models`。
    /// 成功就把模型記進 acp-models.json（重開 ASN 也照新模型）。回 (驅動 pid, 有沒有重開, 有沒有記下來)
    pub fn admin_set_model(self: &Arc<Self>, model: &str, models_file: &Path) -> Result<(u32, bool, bool), String> {
        if !crate::bridge::engines::acp_models::valid_model(model) {
            return Err("模型代號只能用英數與 . _ -，開頭要是英數，最多 60 字".into());
        }
        {
            let s = self.st.lock().unwrap();
            if s.admin_stopped {
                return Err("這個工作者已經關閉了，先「重開」再切換模型".into());
            }
            Self::admin_busy(&s)?;
        }
        if self.i.cfg.protocol == "acp" {
            let d = self.st.lock().unwrap().driver.clone().filter(|d| d.alive()).ok_or("工作者沒有在跑，先「重開」再切換模型")?;
            let list = d.models();
            if list.is_empty() {
                return Err("這個工作者沒有列出可選的模型，不能從這裡切換".into());
            }
            if !list.iter().any(|m| m == model) {
                return Err(crate::bridge::engines::acp_models::not_listed(model, &list));
            }
            let pid = d.pid();
            let m = model.to_string();
            run_blocking(async move { d.set_model(m).await }, SET_MODEL_WAIT)??;
            self.st.lock().unwrap().model = model.to_string();
            let saved = self.save_model(models_file, model);
            self.log(format!("遠端管理：切換模型為 {model}（原生切換，沒有重開）"));
            let _ = self.i.events.send(crate::bridge::engines::EngineEvent::RosterChanged);

            return Ok((pid, false, saved));
        }
        let (cfg, env) = (self.cfg_now(), self.i.env.clone());
        let list = run_blocking(async move { crate::bridge::engines::acp_models::agy_models(&cfg, &env).await }, SET_MODEL_WAIT)??;
        if !list.iter().any(|m| m == model) {
            return Err(crate::bridge::engines::acp_models::not_listed(model, &list));
        }
        let (pid, d) = self.take_driver_for_admin()?;
        self.st.lock().unwrap().model = model.to_string();
        if let Some(d) = d {
            d.stop();
        }
        let saved = self.save_model(models_file, model);
        self.log(format!("遠端管理：切換模型為 {model}（結束程序 pid={pid}，帶同一段對話重開）"));
        self.revive_after_admin_stop();
        self.warm();
        let _ = self.i.events.send(crate::bridge::engines::EngineEvent::RosterChanged);
        Ok((pid, true, saved))
    }

    fn save_model(&self, file: &Path, model: &str) -> bool {
        match crate::bridge::engines::acp_models::set(file, &self.i.cfg.name, model) {
            Ok(()) => true,
            Err(e) => {
                self.log(format!("切換模型：{e}（這次執行照新模型，重開 ASN 後會回到原本的）"));
                false
            }
        }
    }

    /// 換班接手：清掉對話編號、結束驅動程序後重開；第一則提示是接班說明。回被結束的 pid
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
        self.log(format!("遠端管理：換班接手（結束程序 pid={pid}，對話編號已清掉）"));
        self.revive_after_admin_stop();
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

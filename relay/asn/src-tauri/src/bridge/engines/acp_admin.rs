//! 遠端管理 ACP 工作者（Gemini、agy 等收發室自己跑的背景工作者）的入口：給 bridge/partner_ops.rs 用。
//! 只管詳情、重開、接班換手三件事；改名、切換模型、關閉、喚醒不支援（由呼叫端回「這類夥伴不支援」）。
//! 只認收發室記在案的工作者（agents.json 讀進來、已啟動的），而且只結束驅動回報的那個 pid。
use super::acp_config::WorkerCfg;
use super::acp_worker::admin::LoadState;
use super::acp_worker::{Store, WorkerHandle};
use super::{EngineEvent, EventTx};
use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

/// 接手載入對話最多等這麼久（毫秒）：子程序冷啟動加 session/load
pub const ADOPT_WAIT_MS: u64 = 60_000;

pub trait AcpAdmin: Send + Sync {
    /// 名字對得上收發室管理的工作者嗎
    fn has_worker(&self, name: &str) -> bool;
    /// 詳情（欄位名與 Claude 視窗的詳情一致，另加 permissions、process_running、has_session、load_session）
    fn info(&self, name: &str) -> Option<Value>;
    /// 重開（保留對話）
    fn restart(&self, name: &str) -> Result<Value, String>;
    /// 接班換手（清掉對話後重開，第一則提示是接班說明）
    fn handover(&self, name: &str, note: &str) -> Result<Value, String>;
    /// 接手：另開一個專屬的 Grok 工作者，載入指定的對話（session）。會等到載入成功或失敗才回；只動自己新開的工作者，不碰任何既有程序
    fn adopt(&self, _session_id: &str, _cwd: &str) -> Result<Value, String> {
        Err("沒有可以接手的 Grok 工作者設定".into())
    }
}

pub struct AcpAdminImpl {
    pub workers: Arc<Mutex<Vec<(String, WorkerHandle)>>>,
    /// 接手用：做工作者的函式、存對話編號的帳本、接手名冊檔、通知名單有變的通道、等載入的上限
    pub adopt: Option<AdoptEnv>,
}

#[derive(Clone)]
pub struct AdoptEnv {
    pub make: Arc<dyn Fn(Arc<WorkerCfg>) -> WorkerHandle + Send + Sync>,
    pub store: Arc<Store>,
    pub file: PathBuf,
    pub events: EventTx,
    pub wait_ms: u64,
}

/// 接手名冊（重啟後把專屬工作者建回來）：[{name, session_id, cwd}]
pub fn read_adopted(file: &std::path::Path) -> Vec<(String, String, String)> {
    let Ok(t) = std::fs::read_to_string(file) else { return vec![] };
    let Ok(v) = serde_json::from_str::<Value>(&t) else { return vec![] };
    v.get("adopted").and_then(Value::as_array).into_iter().flatten().filter_map(|e| {
        let g = |k: &str| e.get(k).and_then(Value::as_str).map(String::from).filter(|s| !s.is_empty());
        Some((g("name")?, g("session_id")?, g("cwd")?))
    }).collect()
}

fn write_adopted(file: &std::path::Path, list: &[(String, String, String)]) {
    let arr: Vec<Value> = list.iter().map(|(n, s, c)| json!({ "name": n, "session_id": s, "cwd": c })).collect();
    let _ = crate::write_atomic(file, &json!({ "version": 1, "adopted": arr }).to_string());
}

impl AcpAdminImpl {
    fn find(&self, name: &str) -> Option<WorkerHandle> {
        self.workers.lock().unwrap().iter().find(|(n, _)| n == name).map(|(_, w)| w.clone())
    }
}

impl AcpAdmin for AcpAdminImpl {
    fn has_worker(&self, name: &str) -> bool {
        self.find(name).is_some()
    }

    fn info(&self, name: &str) -> Option<Value> {
        let s = self.find(name)?.snapshot();
        let model = Some(s.model.trim()).filter(|m| !m.is_empty());
        let [r, w, e, n] = s.permissions;
        Some(json!({
            "pid": s.pid,
            "model": model,
            "engine": s.engine_label,
            "cwd": s.cwd,
            "status": s.status,
            "kind": "acp",
            "protocol": s.protocol,
            "permissions": { r.0: r.1, w.0: w.1, e.0: e.1, n.0: n.1 },
            "process_running": s.process_running,
            "has_session": s.has_session,
            "load_session": s.load_session,
        }))
    }

    fn restart(&self, name: &str) -> Result<Value, String> {
        let w = self.find(name).ok_or("找不到這個工作者")?;
        let pid = w.admin_restart()?;
        Ok(json!({ "kind": "acp", "pid": pid, "kept_session": w.snapshot().has_session }))
    }

    fn handover(&self, name: &str, note: &str) -> Result<Value, String> {
        let w = self.find(name).ok_or("找不到這個工作者")?;
        let pid = w.admin_handover(note)?;
        Ok(json!({ "kind": "acp", "pid": pid, "handoff_done": false }))
    }

    fn adopt(&self, session_id: &str, cwd: &str) -> Result<Value, String> {
        let env = self.adopt.as_ref().ok_or("沒有可以接手的 Grok 工作者設定")?;
        // 以現有的 Grok 工作者（名單引擎 grok、標準 ACP）的設定為底；沒有就不做，不猜指令
        let base = self
            .workers
            .lock()
            .unwrap()
            .iter()
            .map(|(_, w)| w.cfg().clone())
            .find(|c| c.roster_engine == "grok" && c.protocol == "acp" && !c.adopted)
            .ok_or("沒有設定 Grok 工作者（agents.json 裡名單引擎是 grok 的標準 ACP 工作者），不知道要用哪個指令接手")?;
        let mut name = super::grok_adopt::worker_name(cwd, "");
        if let Some(w) = self.find(&name) {
            if env.store.get(w.cfg()) == session_id {
                return Ok(json!({ "kind": "adopt", "name": name, "already": true }));
            }
            name = super::grok_adopt::worker_name(cwd, session_id);
            if let Some(w) = self.find(&name) {
                if env.store.get(w.cfg()) == session_id {
                    return Ok(json!({ "kind": "adopt", "name": name, "already": true }));
                }
                return Err("已經有同名的專屬工作者在用別的對話，沒辦法再開".into());
            }
        }
        let cfg = Arc::new(super::grok_adopt::adopted_cfg(&base, &name, cwd));
        env.store.set(&cfg, session_id);
        let w = (env.make)(cfg.clone());
        w.mark_adopted();
        self.workers.lock().unwrap().push((name.clone(), w.clone()));
        w.start();
        let t0 = std::time::Instant::now();
        let outcome = loop {
            match w.load_state(session_id) {
                LoadState::Ready => break Ok(()),
                LoadState::Failed(e) => break Err(e),
                LoadState::Loading => {}
            }
            if t0.elapsed().as_millis() as u64 > env.wait_ms {
                break Err("等了太久，對話還沒載入完".to_string());
            }
            std::thread::sleep(std::time::Duration::from_millis(50));
        };
        if let Err(e) = outcome {
            w.stop();
            self.workers.lock().unwrap().retain(|(n, _)| *n != name);
            env.store.clear(&cfg);
            return Err(format!("專屬工作者沒能載入那段對話，已撤掉：{e}"));
        }
        // 成功才寫進接手名冊
        let mut list = read_adopted(&env.file);
        list.retain(|(n, _, _)| *n != name);
        list.push((name.clone(), session_id.to_string(), cwd.to_string()));
        write_adopted(&env.file, &list);
        let _ = env.events.send(EngineEvent::RosterChanged);
        Ok(json!({ "kind": "adopt", "name": name, "already": false }))
    }
}

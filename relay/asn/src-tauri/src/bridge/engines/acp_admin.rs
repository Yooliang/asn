//! 遠端管理 ACP 工作者（Gemini、agy 等收發室自己跑的背景工作者）的入口：給 bridge/partner_ops.rs 用。
//! 只管詳情、重開、接班換手三件事；改名、切換模型、關閉、喚醒不支援（由呼叫端回「這類夥伴不支援」）。
//! 只認收發室記在案的工作者（agents.json 讀進來、已啟動的），而且只結束驅動回報的那個 pid。
use super::acp_worker::WorkerHandle;
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};

pub trait AcpAdmin: Send + Sync {
    /// 名字對得上收發室管理的工作者嗎
    fn has_worker(&self, name: &str) -> bool;
    /// 詳情（欄位名與 Claude 視窗的詳情一致，另加 permissions、process_running、has_session、load_session）
    fn info(&self, name: &str) -> Option<Value>;
    /// 重開（保留對話）
    fn restart(&self, name: &str) -> Result<Value, String>;
    /// 接班換手（清掉對話後重開，第一則提示是接班說明）
    fn handover(&self, name: &str, note: &str) -> Result<Value, String>;
}

pub struct AcpAdminImpl {
    pub workers: Arc<Mutex<Vec<(String, WorkerHandle)>>>,
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
}

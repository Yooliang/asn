//! 開新夥伴：本機啟動、遠端 launch API（全 Rust，不呼叫 Node）。
mod config;
mod console;
mod local;
mod prefs;
mod profiles;

use crate::relay::Relay;
use prefs::{launch_prefs_get_sync, launch_prefs_set_sync};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::PathBuf;
use std::time::Duration;

pub(crate) const IPC_TIMEOUT: Duration = Duration::from_secs(60);

pub(crate) async fn blocking_timeout<T, F>(f: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    tokio::time::timeout(IPC_TIMEOUT, tokio::task::spawn_blocking(f))
        .await
        .map_err(|_| "操作逾時".to_string())?
        .map_err(|e| format!("背景工作失敗：{e}"))?
}

#[derive(Serialize, Deserialize)]
pub struct LocalLaunchReq {
    pub profile: String,
    pub name: String,
    pub cwd: String,
    #[serde(default)]
    pub display: String,
}

#[derive(Serialize, Deserialize)]
pub struct PartnerConsoleReq {
    pub engine: String,
    pub name: String,
    #[serde(default)]
    pub visible: Option<bool>,
}

pub async fn partner_launch_local(node: String, work_dir: PathBuf, req: LocalLaunchReq) -> Result<Value, String> {
    blocking_timeout(move || local::partner_launch_local(&node, &work_dir, req)).await
}

pub async fn partner_console_query(req: PartnerConsoleReq) -> Result<Value, String> {
    blocking_timeout(move || console::partner_console_query(req)).await
}

pub async fn partner_console_set(req: PartnerConsoleReq) -> Result<Value, String> {
    blocking_timeout(move || console::partner_console_set(req)).await
}

pub async fn launch_prefs_get(data_dir: PathBuf) -> Result<Value, String> {
    blocking_timeout(move || launch_prefs_get_sync(&data_dir)).await
}

pub async fn launch_prefs_set(data_dir: PathBuf, prefs: Value) -> Result<(), String> {
    blocking_timeout(move || launch_prefs_set_sync(&data_dir, prefs)).await
}

pub async fn relay_launch(relay: &Relay, body: Value) -> Result<Value, String> {
    relay.api("launch", Some(body)).await
}

pub async fn relay_launchers(relay: &Relay, ids: Option<Vec<String>>) -> Result<Value, String> {
    let body = ids.map(|v| json!({ "ids": v }));
    relay.api("launchers", body).await
}

#[cfg(test)]
mod tests {
    use super::config::{canonical_launch_cwd, valid_partner_name};

    #[test]
    fn 夥伴名字格式() {
        assert!(valid_partner_name("Gemini-2"));
        assert!(!valid_partner_name("-bad"));
        assert!(!valid_partner_name(""));
    }

    #[test]
    fn 工作資料夾正規化() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("proj");
        std::fs::create_dir_all(&p).unwrap();
        assert_eq!(canonical_launch_cwd(p.to_str().unwrap()).unwrap(), std::fs::canonicalize(&p).unwrap());
    }
}

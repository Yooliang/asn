//! 開新夥伴：本機啟動、遠端 launch API。CLI 偵測請用 `agent_tools::ai_cli_detect`（#49）。
use crate::relay::Relay;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::process::Command;

fn relay_root() -> PathBuf {
    if let Ok(p) = std::env::var("IRORI_RELAY_ROOT") {
        return PathBuf::from(p);
    }
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..")
}

fn node_script(rel: &str) -> PathBuf {
    relay_root().join(rel)
}

fn run_node_json(script: &Path, args: &[&str]) -> Result<Value, String> {
    let out = Command::new("node")
        .arg(script)
        .args(args)
        .output()
        .map_err(|e| format!("無法執行 node：{}", e))?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
        return Err(if err.is_empty() { "啟動失敗".into() } else { err });
    }
    serde_json::from_slice(&out.stdout).map_err(|e| format!("回傳不是 JSON：{}", e))
}

#[derive(Serialize, Deserialize)]
pub struct LocalLaunchReq {
    pub profile: String,
    pub name: String,
    pub cwd: String,
}

pub fn partner_launch_local(node: String, req: LocalLaunchReq) -> Result<Value, String> {
    if req.profile.is_empty() || req.name.is_empty() || req.cwd.is_empty() {
        return Err("請填寫模型、名字與工作資料夾".into());
    }
    let script = node_script("machine/local-partner-launch.mjs");
    run_node_json(
        &script,
        &["--node", &node, "--profile", &req.profile, "--name", &req.name, "--cwd", &req.cwd],
    )
}

pub async fn relay_launch(relay: &Relay, body: Value) -> Result<Value, String> {
    relay.api("launch", Some(body)).await
}

pub async fn relay_launchers(relay: &Relay, ids: Option<Vec<String>>) -> Result<Value, String> {
    let body = ids.map(|v| json!({ "ids": v }));
    relay.api("launchers", body).await
}

pub fn launch_prefs_path(data_dir: &Path) -> PathBuf {
    data_dir.join("launch-prefs.json")
}

pub fn launch_prefs_get(data_dir: PathBuf) -> Result<Value, String> {
    let p = launch_prefs_path(&data_dir);
    let text = std::fs::read_to_string(&p).unwrap_or_else(|_| "{}".into());
    serde_json::from_str(&text).map_err(|e| e.to_string())
}

pub fn launch_prefs_set(data_dir: PathBuf, prefs: Value) -> Result<(), String> {
    let p = launch_prefs_path(&data_dir);
    if let Some(parent) = p.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let text = serde_json::to_string(&prefs).map_err(|e| e.to_string())?;
    if text.len() > 200_000 {
        return Err("設定太大".into());
    }
    crate::write_atomic(&p, &text).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 本機啟動腳本存在() {
        let p = node_script("machine/local-partner-launch.mjs");
        assert!(p.exists(), "{}", p.display());
    }
}

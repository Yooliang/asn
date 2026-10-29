//! 開新夥伴：本機啟動、遠端 launch API（全 Rust，不呼叫 Node）。
pub(crate) mod config;
pub(crate) mod console;
pub(crate) mod console_resolve;
pub(crate) mod cwds;
pub(crate) mod local;
pub(crate) mod pi;
pub(crate) mod pi_models;
pub(crate) mod pi_term;
pub(crate) mod pi_setup;
pub(crate) mod prefs;
pub(crate) mod profiles;
mod resume;
mod subagents;
mod tasks;
pub(crate) mod switch;
#[cfg(desktop)]
#[allow(dead_code)]
pub(crate) mod wezterm;
#[cfg(desktop)]
mod term_adopt;
#[cfg(desktop)]
#[cfg_attr(not(feature = "gui"), allow(dead_code))]
pub(crate) mod term;

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
    /// true＝不接續舊對話、強制新開（預設 false：有同名舊對話就接續）
    #[serde(default)]
    pub fresh: bool,
    /// 第一句話（目前只有 pi 用：當成開場訊息帶進啟動參數）
    #[serde(default)]
    pub first_message: String,
    /// 經 pi 開時指定提供者與模型（兩個要一起給；只有 profile 是 pi 才收，其他 profile 給了就報錯，不悄悄忽略）
    #[serde(default)]
    pub pi_provider: String,
    #[serde(default)]
    pub pi_model: String,
}

#[derive(Serialize, Deserialize)]
pub struct PartnerConsoleReq {
    pub engine: String,
    pub name: String,
    #[serde(default)]
    pub visible: Option<bool>,
    /// 名單條目種類（kind）；「process」＝程序掃描列出的本機程式
    #[serde(default)]
    pub kind: Option<String>,
    /// 名單條目明確帶的 pid（選填；一定會再比對本機掃描結果才採用）
    #[serde(default)]
    pub pid: Option<u32>,
}

pub async fn partner_launch_local(node: String, work_dir: PathBuf, data_dir: PathBuf, req: LocalLaunchReq) -> Result<Value, String> {
    blocking_timeout(move || local::partner_launch_local(&node, &work_dir, &data_dir, req)).await
}

/// 工作資料夾下拉的候選（白名單＋自動建議，最多 15 筆）。
pub async fn launch_cwd_candidates(data_dir: PathBuf) -> Result<Vec<String>, String> {
    blocking_timeout(move || {
        let allow = config::load_launch_config().map(|c| c.cwd_allow).unwrap_or_default();
        Ok(cwds::candidates(&crate::identity::home_dir(), &data_dir, &allow))
    })
    .await
}

/// 「瀏覽…」選好的資料夾：存在才收，並寫進本機白名單；回傳正規化後的路徑。
pub async fn launch_cwd_add(data_dir: PathBuf, cwd: String) -> Result<String, String> {
    blocking_timeout(move || {
        let p = cwds::norm_path(&cwd).ok_or_else(|| "資料夾是空的".to_string())?;
        if !std::path::Path::new(&p).is_dir() {
            return Err(format!("資料夾不存在：{p}"));
        }
        cwds::add_to_prefs_allow(&data_dir, &p)?;
        Ok(p)
    })
    .await
}

pub async fn partner_console_query(req: PartnerConsoleReq) -> Result<Value, String> {
    blocking_timeout(move || console::partner_console_query(req)).await
}

pub use subagents::SubagentsReq;
pub use tasks::TasksReq;
pub use switch::{SwitchQueryReq, SwitchRunReq};

/// 這個 Claude 視窗正在跑哪些子代理（只讀對話記錄檔）
pub async fn subagents_query(req: SubagentsReq) -> Result<Value, String> {
    blocking_timeout(move || subagents::subagents_query(req)).await
}

/// 這個 Claude 視窗正在跑哪些背景工作（只讀外掛寫的狀態檔，#539 之三）
pub async fn tasks_query(req: TasksReq) -> Result<Value, String> {
    blocking_timeout(move || tasks::tasks_query(req)).await
}

/// 讀這個夥伴 Claude 視窗的目前模型與是否閒置（只讀檔與讀程序命令列，不啟動子程序）
pub async fn model_switch_query(req: SwitchQueryReq) -> Result<Value, String> {
    blocking_timeout(move || switch::model_switch_query(req)).await
}

/// 切換模型：關掉那一個視窗、照原參數重開、等新對話出現。最久約一分多鐘，所以不用 60 秒的一般逾時。
pub async fn model_switch_run(req: SwitchRunReq) -> Result<Value, String> {
    tokio::time::timeout(Duration::from_secs(120), tokio::task::spawn_blocking(move || switch::model_switch_run(req)))
        .await
        .map_err(|_| "操作逾時".to_string())?
        .map_err(|e| format!("背景工作失敗：{e}"))?
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

/// 各電腦的啟動設定。有登入就帶本人簽章（#380：成員角色的電腦不帶會被後台擋 403）；沒登入照舊不帶，擁有者角色的電腦一樣查得到
pub async fn relay_launchers(relay: &Relay, ids: Option<Vec<String>>, token: Option<&str>) -> Result<Value, String> {
    let body = ids.map(|v| json!({ "ids": v }));
    relay.api_signed("launchers", body, token).await
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

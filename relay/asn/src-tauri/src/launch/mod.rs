//! 開新夥伴：本機啟動、遠端 launch API（全 Rust，不呼叫 Node）。
pub(crate) mod config;
pub(crate) mod console;
pub(crate) mod console_resolve;
pub(crate) mod cwds;
pub(crate) mod local;
pub(crate) mod pretrust;
pub(crate) mod pi;
pub(crate) mod pi_models;
pub(crate) mod pi_term;
pub(crate) mod pi_setup;
pub(crate) mod prefs;
pub(crate) mod profiles;
pub(crate) mod claude_screen;
pub(crate) mod perm_risk;
#[cfg(desktop)]
mod screen_watch;
mod resume;
pub(crate) mod opening;
pub(crate) mod live_process;
pub(crate) mod integrity;
#[cfg_attr(not(all(feature = "gui", desktop)), allow(dead_code))]
pub(crate) mod stuck_resume;
pub(crate) mod stuck_notice;
#[cfg_attr(not(all(feature = "gui", desktop)), allow(dead_code))]
pub(crate) mod awaiting;
pub mod auto_resume;
pub mod mux_watch;
pub mod mux_heartbeat;
pub mod mux_round;
#[cfg(all(feature = "gui", not(test)))]
pub use auto_resume::{boot_ms, probe_window};
mod subagents;
mod tasks;
pub(crate) mod switch;
#[cfg(desktop)]
#[cfg_attr(not(feature = "gui"), allow(dead_code))]
pub(crate) mod taskmgr;
pub(crate) mod win_term;
#[cfg(desktop)]
#[allow(dead_code)]
pub(crate) mod wezterm;
#[cfg(desktop)]
#[allow(dead_code)] // 呼叫點只在視窗版的 term::live，無畫面版編進來但不用
pub(crate) mod wezterm_fetch;
#[cfg(desktop)]
pub(crate) mod proc_tree;
#[cfg(desktop)]
#[allow(dead_code)] // B2a 只放生命週期，呼叫點在 B2b 接上
pub(crate) mod mux;
#[cfg(desktop)]
mod term_adopt;
#[cfg(desktop)]
#[cfg_attr(not(feature = "gui"), allow(dead_code))]
pub(crate) mod term_view;
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
    /// 開新夥伴選的型號（#539 之四，空＝不指定）：Claude 視窗帶 `--model`，內建通道記進 acp-models.json；其他廠牌給了就報錯
    #[serde(default)]
    pub model: String,
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

/// 「瀏覽…」選好的資料夾：經 [`cwds::validate_cwd`] 驗證（存在、是資料夾、不超過上限）後寫進本機白名單；回傳正規化後的路徑。
/// 已經在清單裡的不算錯（開新夥伴對話框挑到舊資料夾照樣選得到）。
pub async fn launch_cwd_add(data_dir: PathBuf, cwd: String) -> Result<String, String> {
    blocking_timeout(move || match cwds::add_validated(&data_dir, &cwd) {
        Ok(p) => Ok(p),
        Err(cwds::CwdReject::Duplicate(p)) => Ok(p),
        Err(e) => {
            elog!("[launch] 加入工作資料夾被拒：{e:?}");
            Err(e.text())
        }
    })
    .await
}

/// 設定頁「移除」：依路徑從本機白名單拿掉一筆，回傳移除後的清單。
pub async fn launch_cwd_remove(data_dir: PathBuf, cwd: String) -> Result<Vec<String>, String> {
    blocking_timeout(move || {
        cwds::remove_from_prefs_allow(&data_dir, &cwd).inspect_err(|e| elog!("[launch] 移除工作資料夾失敗：{cwd}：{e}"))
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

/// 給設定頁讀：沒存過每小時上限時填上實際生效的那個值（launcher.json 寫的或 6），畫面跟真正擋的同一個來源（#1548）
pub async fn launch_prefs_get(data_dir: PathBuf) -> Result<Value, String> {
    blocking_timeout(move || {
        let prefs = launch_prefs_get_sync(&data_dir)?;
        Ok(with_effective_max(prefs, config::file_max_per_hour(&config::launcher_config_path())))
    })
    .await
}

/// 給畫面顯示的「目前生效值」另外放在 maxPerHourEffective（不碰存檔裡的任何欄位、不寫回檔案）
pub fn with_effective_max(prefs: Value, file: Option<u32>) -> Value {
    let mut p = if prefs.is_object() { prefs } else { serde_json::json!({}) };
    p["maxPerHourEffective"] = serde_json::json!(config::effective_max_per_hour(&p, file));
    p
}

pub async fn launch_prefs_set(data_dir: PathBuf, prefs: Value) -> Result<(), String> {
    blocking_timeout(move || launch_prefs_set_checked(&data_dir, prefs)).await
}

/// 設定頁整份存檔：只驗「新加入」的工作資料夾（舊存檔裡的原樣保留，含已不存在的），不合格整份拒絕；詳見 [`cwds::check_prefs_write`]。
pub fn launch_prefs_set_checked(data_dir: &std::path::Path, prefs: Value) -> Result<(), String> {
    prefs::check_prefs_shape(&prefs)?;
    // 檢查與存檔在同一把鎖裡：檢查看到的「目前存檔」就是被取代的那一份
    prefs::launch_prefs_try_update(data_dir, |current| {
        cwds::check_prefs_write(current, &prefs).inspect_err(|e| elog!("[launch] 啟動設定存檔被拒：{e}"))?;
        *current = prefs;
        Ok::<(), String>(())
    })?

}

/// 遠端開新夥伴。有登入就帶本人簽章（成員角色的電腦不帶，後台回 403 forbidden；跟 [`relay_launchers`] 一樣），沒登入照舊不帶。
/// 錯誤一律換成白話（[`launch_error_text`]），畫面不會看到動作名與 HTTP 字樣；原文（只有動作名、狀態碼、後台的錯誤代碼，不含金鑰與內文）先交給 `log` 留底，
/// 不然下次遇到不認得的錯誤，畫面只剩一句「沒成功」，也沒有任何地方能查
pub async fn relay_launch(relay: &Relay, body: Value, token: Option<&str>, log: &(dyn Fn(String) + Sync)) -> Result<Value, String> {
    let signed = token.is_some_and(|t| !t.is_empty());
    relay.api_signed("launch", Some(body), token).await.map_err(|e| {
        log(format!("開新夥伴失敗：{e}（{}）", if signed { "有帶本人簽章" } else { "沒登入，沒帶簽章" }));
        launch_error_text(&e, signed)
    })
}

/// 後台回的開窗錯誤（「launch HTTP 403 forbidden」這種）→ 給人看的話：講發生什麼事、要怎麼做。
/// 錯誤代碼對照 supabase/functions/_shared/launch.ts 的 ERROR_TEXT；不認得的代碼與狀態碼走最後一句，不把原字串秀出來
/// `signed`＝這次有沒有帶本人簽章：沒登入又被擋（forbidden），要請他先登入，不是「兩台不同帳號」
pub fn launch_error_text(e: &str, signed: bool) -> String {
    if e.contains("連線失敗") || e.contains("讀回應中斷") {
        return "連不上收發室，請確認網路後再試一次".into();
    }
    let code = e.split("HTTP").nth(1).map(|r| r.trim().splitn(2, ' ').nth(1).unwrap_or("").trim()).unwrap_or("");
    let status = e.split("HTTP").nth(1).map(|r| r.trim().split(' ').next().unwrap_or("")).unwrap_or("");
    match code {
        "forbidden" if !signed => "這台還沒登入帳號，請先登入後再試（要替別台開夥伴得先登入）",
        "forbidden" => "這台沒有權限替那台開夥伴，請確認兩台登入同一個帳號",
        "not_found" => "找不到那台電腦，它可能離線太久或已被移除",
        "no_launcher" => "那台電腦還沒開放遠端開新夥伴，請到那台的設定打開「允許我的其他設備替這台開新視窗」",
        "bad_name" => "夥伴名稱只能用英數、連字號與中文，1～40 字，不能以連字號開頭",
        "bad_profile" => "那台電腦沒有這個啟動設定，請換一個模型",
        "bad_cwd" => "工作資料夾不在那台電腦允許的清單裡，請換一個資料夾",
        "bad_first_message" => "第一句話太長了，最多 4000 字",
        "bad_pi_model" => "經 pi 的提供者和模型要一起選，請重新選一次",
        "name_taken" => "那台電腦已經有同名的夥伴（或剛開過），請換個名字",
        "rate_limited" => "那台電腦這個小時開太多視窗了，請稍後再試",
        "bad_request" => "送出的資料格式不對，請重新選一次",
        "internal" => "收發室發生錯誤，請稍後再試",
        _ if status == "401" => "登入過期了，請重新登入後再試",
        _ => "開新夥伴沒成功，請稍後再試",
    }
    .into()
}

/// 各電腦的啟動設定。有登入就帶本人簽章（#380：成員角色的電腦不帶會被後台擋 403）；沒登入照舊不帶，擁有者角色的電腦一樣查得到
pub async fn relay_launchers(relay: &Relay, ids: Option<Vec<String>>, token: Option<&str>) -> Result<Value, String> {
    let body = ids.map(|v| json!({ "ids": v }));
    relay.api_signed("launchers", body, token).await
}

#[cfg(test)]
mod tests {
    use super::launch_error_text;
    use super::config::{canonical_launch_cwd, valid_partner_name};
    use super::with_effective_max;
    use serde_json::json;

    #[test]
    fn 開窗錯誤_全部換成白話_沒有動作名也沒有狀態碼字樣() {
        let all = [
            ("launch HTTP 403 forbidden", "這台沒有權限替那台開夥伴，請確認兩台登入同一個帳號"),
            ("launch HTTP 404 not_found", "找不到那台電腦，它可能離線太久或已被移除"),
            ("launch HTTP 409 no_launcher", "那台電腦還沒開放遠端開新夥伴，請到那台的設定打開「允許我的其他設備替這台開新視窗」"),
            ("launch HTTP 400 bad_name", "夥伴名稱只能用英數、連字號與中文，1～40 字，不能以連字號開頭"),
            ("launch HTTP 400 bad_profile", "那台電腦沒有這個啟動設定，請換一個模型"),
            ("launch HTTP 400 bad_cwd", "工作資料夾不在那台電腦允許的清單裡，請換一個資料夾"),
            ("launch HTTP 400 bad_first_message", "第一句話太長了，最多 4000 字"),
            ("launch HTTP 400 bad_pi_model", "經 pi 的提供者和模型要一起選，請重新選一次"),
            ("launch HTTP 409 name_taken", "那台電腦已經有同名的夥伴（或剛開過），請換個名字"),
            ("launch HTTP 429 rate_limited", "那台電腦這個小時開太多視窗了，請稍後再試"),
            ("launch HTTP 400 bad_request", "送出的資料格式不對，請重新選一次"),
            ("launch HTTP 500 internal", "收發室發生錯誤，請稍後再試"),
            ("launch HTTP 401", "登入過期了，請重新登入後再試"),
            ("launch HTTP 502", "開新夥伴沒成功，請稍後再試"),
            ("launch HTTP 400 something_new", "開新夥伴沒成功，請稍後再試"),
            ("launch 連線失敗：timeout", "連不上收發室，請確認網路後再試一次"),
        ];
        for (raw, want) in all {
            let got = launch_error_text(raw, true);
            assert_eq!(got, want, "{raw}");
            assert!(!got.contains("HTTP") && !got.contains("launch") && !got.contains("forbidden"), "{raw} → {got}");
        }
    }

    #[test]
    fn 開窗錯誤_沒登入被擋_請他先登入_不說是帳號不同() {
        let t = launch_error_text("launch HTTP 403 forbidden", false);
        assert_eq!(t, "這台還沒登入帳號，請先登入後再試（要替別台開夥伴得先登入）");
        assert!(!t.contains("HTTP") && !t.contains("forbidden"));
        // 沒登入但是別的錯誤：照原本的白話
        assert_eq!(launch_error_text("launch HTTP 429 rate_limited", false), launch_error_text("launch HTTP 429 rate_limited", true));
    }

    #[test]
    fn 設定頁讀到的上限跟實際擋的同一個來源() {
        // 沒改過：生效值是 launcher.json 寫的；連那個也沒有就是 6。生效值放在另一個欄位，存檔原有的欄位一個都不動
        assert_eq!(with_effective_max(json!({ "cwdAllow": ["D:\\w"] }), Some(3)), json!({ "cwdAllow": ["D:\\w"], "maxPerHourEffective": 3 }));
        assert_eq!(with_effective_max(json!({}), None), json!({ "maxPerHourEffective": 6 }));
        assert_eq!(with_effective_max(serde_json::Value::Null, None), json!({ "maxPerHourEffective": 6 }));
        // 舊程式寫的 maxPerHour:6 不算：生效值是 launcher.json 的 10，舊欄位原樣留著（前端不再讀它）
        assert_eq!(with_effective_max(json!({ "maxPerHour": 6 }), Some(10)), json!({ "maxPerHour": 6, "maxPerHourEffective": 10 }));
        // 設定頁改過：生效值就是它
        assert_eq!(with_effective_max(json!({ "maxPerHourSet": 2 }), Some(9)), json!({ "maxPerHourSet": 2, "maxPerHourEffective": 2 }));
    }

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

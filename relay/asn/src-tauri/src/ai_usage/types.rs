use serde::Serialize;

/// 單一額度視窗（例如五小時、一週）。
#[derive(Debug, Clone, Serialize)]
pub struct UsageWindow {
    pub label: String,
    pub used_percent: Option<f64>,
    pub remaining_percent: Option<f64>,
    pub reset_at: Option<String>,
    pub detail: Option<String>,
}

/// 登入／查詢狀態（不含任何 token）。
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AuthState {
    NotInstalled,
    NotLoggedIn,
    LoggedIn,
    Unavailable,
}

#[derive(Debug, Clone, Serialize)]
pub struct ProviderUsage {
    pub id: String,
    pub label: String,
    pub auth: AuthState,
    pub plan: Option<String>,
    pub windows: Vec<UsageWindow>,
    pub note: Option<String>,
    /// 可否在 ASN 內一鍵走官方安裝。
    pub install_available: bool,
    pub binary_found: bool,
    /// 是否實作遠端額度查詢（否則顯示「尚不支援」或僅登入狀態）。
    pub usage_supported: bool,
    /// 已安裝但未登入時，可否開「登入用」終端機（不是啟動工具捷徑）。
    pub login_available: bool,
    pub install_blurb: String,
    pub login_blurb: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct UsageSnapshot {
    pub fetched_at: String,
    pub providers: Vec<ProviderUsage>,
}

#[derive(Debug, Clone, Serialize)]
pub struct InstallResult {
    pub ok: bool,
    pub message: String,
    /// 安裝完成後是否已開啟登入用終端機（僅安裝流程，不是常駐按鈕）。
    pub opened_login: bool,
}

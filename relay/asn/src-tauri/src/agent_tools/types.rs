use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
pub struct ToolDetectRow {
    pub id: String,
    pub label: String,
    pub binary_found: bool,
    pub install_available: bool,
    /// 已偵測到指令且 catalog 有登入流程時為 true（不讀取任何登入憑證）。
    pub login_available: bool,
    pub install_blurb: String,
    pub login_blurb: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct ToolsDetectSnapshot {
    pub checked_at: String,
    pub tools: Vec<ToolDetectRow>,
}

#[derive(Debug, Clone, Serialize)]
pub struct InstallResult {
    pub ok: bool,
    pub message: String,
    pub opened_login: bool,
}

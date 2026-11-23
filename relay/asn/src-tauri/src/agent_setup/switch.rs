//! 本機開關：「允許從手機替這台電腦安裝並登入」（#628 條件 E 的第二道；預設關）。
//! 存在本機設定檔裡，只有視窗的設定能改（沒有 asn-cli 的指令、夥伴能呼叫的指令）。
//! 注意：設定檔是一般檔案，夥伴 AI 也寫得到——所以這個開關**不是**唯一防線，主要的防線是後台要求遠端請求一定帶本人簽章。

use crate::settings::AgentSetupPrefsDoc;
use std::path::{Path, PathBuf};

#[cfg(test)]
pub fn prefs_path(data_dir: &Path) -> PathBuf {
    data_dir.join("agent-setup-prefs.json")
}

/// 沒設過、檔案壞掉、值不是布林，一律當「關」
pub fn remote_allowed(data_dir: &Path) -> bool {
    crate::settings::load_in::<AgentSetupPrefsDoc>(data_dir).value.remote_allow_install
}

pub fn set_remote_allowed(data_dir: &Path, on: bool) -> Result<(), String> {
    // 走共用設定層（#2162）：持鎖讀改寫、保留不認得的欄位；寫不進去回錯誤字串
    crate::settings::update_in::<AgentSetupPrefsDoc, _>(data_dir, |d| d.remote_allow_install = on).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 預設關_設了才開_壞檔當關() {
        let d = tempfile::tempdir().unwrap();
        assert!(!remote_allowed(d.path()), "沒設過＝關");
        set_remote_allowed(d.path(), true).unwrap();
        assert!(remote_allowed(d.path()));
        set_remote_allowed(d.path(), false).unwrap();
        assert!(!remote_allowed(d.path()));
        std::fs::write(prefs_path(d.path()), "不是 json").unwrap();
        assert!(!remote_allowed(d.path()), "壞檔＝關");
        std::fs::write(prefs_path(d.path()), r#"{"remote_allow_install":"yes"}"#).unwrap();
        assert!(!remote_allowed(d.path()), "值不是布林＝關");
        set_remote_allowed(d.path(), true).unwrap();
        assert!(remote_allowed(d.path()), "壞檔可以被重寫");
    }
}

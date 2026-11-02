//! 本機開關：「允許從手機替這台電腦安裝並登入」（#628 條件 E 的第二道；預設關）。
//! 存在本機設定檔裡，只有視窗的設定能改（沒有 asn-cli 的指令、夥伴能呼叫的指令）。
//! 注意：設定檔是一般檔案，夥伴 AI 也寫得到——所以這個開關**不是**唯一防線，主要的防線是後台要求遠端請求一定帶本人簽章。

use serde_json::{json, Value};
use std::path::{Path, PathBuf};

const KEY: &str = "remote_allow_install";

pub fn prefs_path(data_dir: &Path) -> PathBuf {
    data_dir.join("agent-setup-prefs.json")
}

/// 沒設過、檔案壞掉、值不是布林，一律當「關」
pub fn remote_allowed(data_dir: &Path) -> bool {
    std::fs::read_to_string(prefs_path(data_dir)).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok()).and_then(|v| v.get(KEY).and_then(Value::as_bool)).unwrap_or(false)
}

pub fn set_remote_allowed(data_dir: &Path, on: bool) -> Result<(), String> {
    let mut v = std::fs::read_to_string(prefs_path(data_dir)).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok()).filter(Value::is_object).unwrap_or_else(|| json!({}));
    v[KEY] = json!(on);
    crate::write_atomic(&prefs_path(data_dir), &v.to_string()).map_err(|e| e.to_string())
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

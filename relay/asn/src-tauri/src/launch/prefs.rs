use crate::write_atomic;
use serde_json::Value;
use std::path::{Path, PathBuf};

pub fn launch_prefs_path(data_dir: &Path) -> PathBuf {
    data_dir.join("launch-prefs.json")
}

pub fn launch_prefs_get_sync(data_dir: &Path) -> Result<Value, String> {
    let p = launch_prefs_path(data_dir);
    let text = std::fs::read_to_string(&p).unwrap_or_else(|_| "{}".into());
    serde_json::from_str(&text).map_err(|e| e.to_string())
}

/// 這台「開新夥伴的顯示方式」偏好（launchDisplay：foreground／background）；沒存過、讀不到或不是字串回 None（#931 遠端開照這台設定用）
pub fn launch_display_pref(data_dir: &Path) -> Option<String> {
    launch_prefs_get_sync(data_dir).ok()?.get("launchDisplay")?.as_str().map(String::from)
}

pub fn launch_prefs_set_sync(data_dir: &Path, prefs: Value) -> Result<(), String> {
    let p = launch_prefs_path(data_dir);
    if let Some(parent) = p.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let text = serde_json::to_string(&prefs).map_err(|e| e.to_string())?;
    if text.len() > 200_000 {
        return Err("設定太大".into());
    }
    write_atomic(&p, &text).map_err(|e| e.to_string())
}

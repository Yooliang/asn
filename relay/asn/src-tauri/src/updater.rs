//! 自動更新（tauri-plugin-updater）：檢查、下載、驗簽、安裝都在 Rust 端；前端只拿得到「有沒有新版」與下載進度。
//! 更新來源與驗簽公鑰寫在 tauri.conf.json 的 plugins.updater（網址固定 https；只接受私鑰簽過的更新檔）。
//! 外掛本身的 JS 指令不開權限（capabilities 不含 updater:*）：前端只能呼叫下面兩個自訂命令。
use crate::App;
use serde::Serialize;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, State};
use tauri_plugin_updater::{Update, UpdaterExt};

/// 檢查到的新版（等使用者按「更新」才下載）與是否正在安裝
#[derive(Default)]
pub struct Pending {
    update: Mutex<Option<Update>>,
    busy: AtomicBool,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct UpdateInfo {
    pub version: String,
    pub notes: String,
}

#[derive(Serialize, Clone)]
struct Progress {
    done: u64,
    total: Option<u64>,
}

/// 更新說明只取前 2000 字（避免伺服器亂塞超長內容進介面）
pub fn clean_notes(body: Option<&str>) -> String {
    body.unwrap_or("").trim().chars().take(2000).collect()
}

/// 前端的檢查：`--shot` 模式不檢查（不碰網路）；沒有新版回 null
#[tauri::command]
pub async fn update_check(app: AppHandle, st: State<'_, App>, pending: State<'_, Pending>) -> Result<Option<UpdateInfo>, String> {
    if st.shot.is_some() {
        return Ok(None);
    }
    let updater = app.updater().map_err(|e| format!("無法檢查更新：{e}"))?;
    let found = updater.check().await.map_err(|e| format!("檢查更新失敗：{e}"))?;
    let info = found.as_ref().map(|u| UpdateInfo { version: u.version.clone(), notes: clean_notes(u.body.as_deref()) });
    *pending.update.lock().unwrap() = found;
    Ok(info)
}

/// 下載（進度以 `update-progress` 事件送給前端）→ 驗簽（下載完成時由外掛做，不符就丟錯）→ 安裝；Windows 安裝程式會結束本程式並自動重開
#[tauri::command]
pub async fn update_install(app: AppHandle, st: State<'_, App>, pending: State<'_, Pending>) -> Result<(), String> {
    if st.shot.is_some() {
        return Err("--shot 模式不更新".into());
    }
    let update = pending.update.lock().unwrap().clone().ok_or("沒有可安裝的新版，請先檢查更新")?;
    if pending.busy.swap(true, Ordering::SeqCst) {
        return Err("正在更新中".into());
    }
    let r = run_install(&app, &update).await;
    pending.busy.store(false, Ordering::SeqCst);
    r
}

async fn run_install(app: &AppHandle, update: &Update) -> Result<(), String> {
    let mut done: u64 = 0;
    let h = app.clone();
    let bytes = update
        .download(
            move |chunk, total| {
                done += chunk as u64;
                let _ = h.emit("update-progress", Progress { done, total });
            },
            || {},
        )
        .await
        .map_err(|e| format!("下載或驗簽失敗：{e}"))?;
    // 安裝程式一啟動就會結束本程式：先清掉心跳檔
    crate::cleanup(app);
    update.install(bytes).map_err(|e| format!("安裝失敗：{e}"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 更新說明_沒有就空字串_太長截斷() {
        assert_eq!(clean_notes(None), "");
        assert_eq!(clean_notes(Some("  修好了\n第二行 ")), "修好了\n第二行");
        assert_eq!(clean_notes(Some(&"字".repeat(5000))).chars().count(), 2000);
    }

    #[test]
    fn 設定檔_更新來源固定_https_且有公鑰() {
        let conf: serde_json::Value = serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        let u = &conf["plugins"]["updater"];
        let eps = u["endpoints"].as_array().unwrap();
        assert!(!eps.is_empty() && eps.iter().all(|e| e.as_str().unwrap().starts_with("https://asnmessenger.web.app/update/")));
        assert!(u["pubkey"].as_str().unwrap().len() > 60);
        assert_eq!(conf["bundle"]["createUpdaterArtifacts"], true);
    }
}

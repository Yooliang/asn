//! 安卓版專屬：App 私有資料夾、開系統瀏覽器、收到的檔案存放。
//! 整個模組只在安卓建置編進去（lib.rs 的 `#[cfg(target_os = "android")] mod android;`）。
//! 登入的回呼網址與電腦版同一套（本機回送位址，見 auth.rs），所以後台的轉址白名單不用改。
use crate::{attach, relay_of, App};
use std::path::PathBuf;
use tauri::{AppHandle, State};
use tauri_plugin_opener::OpenerExt;

/// 這個 App 的私有資料夾（`/data/user/<使用者>/<套件>/files`）；讀不到行程資訊時退回主要使用者與預設套件名
pub fn files_dir() -> PathBuf {
    use std::os::unix::fs::MetadataExt;
    let pkg = std::fs::read("/proc/self/cmdline").ok().and_then(|b| crate::appdir::package_from_cmdline(&b)).unwrap_or_else(|| crate::appdir::PACKAGE.to_string());
    let user = std::fs::metadata("/proc/self").map(|m| crate::appdir::user_of_uid(m.uid())).unwrap_or(0);
    crate::appdir::files_dir_for(&pkg, user)
}

/// 用系統預設瀏覽器開網址（走系統的 Intent；只准 http／https）
pub fn open_url(handle: &AppHandle, url: &str) -> Result<(), String> {
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return Err("只能開 http(s) 網址".into());
    }
    handle.opener().open_url(url, None::<&str>).map_err(|e| format!("無法開啟瀏覽器：{e}"))
}

/// 收到的檔案先存進 App 私有的「收到的檔案」資料夾；同名的加上 (2)、(3)…。
/// 之後由外殼（Kotlin）複製到系統的「下載/ASN」資料夾，使用者才看得到。
fn unique_in(dir: &std::path::Path, fname: &str) -> PathBuf {
    let p = dir.join(fname);
    if !p.exists() {
        return p;
    }
    let (stem, ext) = match fname.rsplit_once('.') {
        Some((s, e)) if !s.is_empty() => (s.to_string(), format!(".{e}")),
        _ => (fname.to_string(), String::new()),
    };
    (2..1000).map(|n| dir.join(format!("{stem}({n}){ext}"))).find(|c| !c.exists()).unwrap_or(p)
}

/// 另存：手機上沒有「另存新檔」對話框。下載後存進私有的「收到的檔案」，回完整路徑，畫面再請外殼匯出到「下載」。
#[tauri::command]
pub async fn relay_attachment_save(app: State<'_, App>, id: String, name: Option<String>) -> Result<Option<String>, String> {
    let r = relay_of(&app)?;
    let dir = app.data_dir.join("received");
    std::fs::create_dir_all(&dir).map_err(|e| format!("建不了資料夾：{e}"))?;
    let saved = attach::save_as(&r, &reqwest::Client::new(), &id, name.as_deref().unwrap_or(""), |fname, _ext| Some(unique_in(&dir, fname))).await?;
    Ok(saved.map(|p| p.display().to_string()))
}

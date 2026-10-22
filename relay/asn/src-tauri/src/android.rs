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

// ---------- 手機自動更新（只有 `sideload` 版；Play 版這兩個指令只回「不提供」） ----------

/// 查官網的更新清單。`url`＝本機測試用的清單網址（只收 http://127.0.0.1…，正式畫面不帶）。
/// 回 { enabled, available, version, notes, line }；Play 版回 { enabled: false }
#[tauri::command]
pub async fn android_update_check(url: Option<String>) -> Result<serde_json::Value, String> {
    #[cfg(feature = "sideload")]
    {
        sideload::check(url).await
    }
    #[cfg(not(feature = "sideload"))]
    {
        let _ = url;
        Ok(serde_json::json!({ "enabled": false }))
    }
}

/// 下載新版 APK 到 App 私有的 updates/，邊下載邊算 sha256，不符就刪檔拒絕；進度用事件 `android-update-progress`（{ done, total }）。回 { path, version }
#[tauri::command]
pub async fn android_update_download(app: State<'_, App>, handle: AppHandle, url: Option<String>) -> Result<serde_json::Value, String> {
    #[cfg(feature = "sideload")]
    {
        sideload::download(&handle, &app.data_dir, url).await
    }
    #[cfg(not(feature = "sideload"))]
    {
        let _ = (app, handle, url);
        Err("這個版本不提供自動更新".into())
    }
}

#[cfg(feature = "sideload")]
mod sideload {
    use crate::android_update::*;
    use serde_json::{json, Value};
    use std::io::Write;
    use std::path::Path;
    use tauri::{AppHandle, Emitter};

    /// 抓並檢查清單。回（清單，是不是本機測試網址）
    async fn fetch_manifest(client: &reqwest::Client, url: Option<String>) -> Result<(Manifest, bool), String> {
        let test = match url.as_deref() {
            Some(u) if is_loopback_url(u) => Some(u.to_string()),
            Some(_) => return Err("不接受這個測試網址".into()),
            None => None,
        };
        let target = test.clone().unwrap_or_else(|| UPDATE_URL.to_string());
        let r = client.get(&target).timeout(std::time::Duration::from_secs(15)).send().await.map_err(|_| "連不上更新伺服器".to_string())?;
        if !r.status().is_success() {
            return Err(format!("更新伺服器回應異常（{}）", r.status().as_u16()));
        }
        let bytes = r.bytes().await.map_err(|_| "讀不到更新清單".to_string())?;
        if bytes.len() > MAX_MANIFEST_BYTES {
            return Err("更新清單太大".into());
        }
        let text = String::from_utf8(bytes.to_vec()).map_err(|_| "更新清單的格式不對".to_string())?;
        Ok((parse_manifest(&text, test.is_some())?, test.is_some()))
    }

    pub async fn check(url: Option<String>) -> Result<Value, String> {
        let (m, _) = fetch_manifest(&reqwest::Client::new(), url).await?;
        Ok(json!({ "enabled": true, "available": is_newer(&m, env!("CARGO_PKG_VERSION")), "version": m.version, "notes": m.notes, "line": first_line(&m.notes) }))
    }

    pub async fn download(handle: &AppHandle, data_dir: &Path, url: Option<String>) -> Result<Value, String> {
        let client = reqwest::Client::new();
        // 下載網址一律用「重新抓到的清單」裡的，不收畫面傳來的
        let (m, _) = fetch_manifest(&client, url).await?;
        if !is_newer(&m, env!("CARGO_PKG_VERSION")) {
            return Err("已經是最新版".into());
        }
        let dir = data_dir.join("updates");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).map_err(|e| format!("建不了資料夾：{e}"))?;
        let name = apk_file_name(&m.version);
        let part = dir.join(format!("{name}.part"));
        let fin = dir.join(&name);
        let mut r = client.get(&m.url).send().await.map_err(|_| "連不上下載伺服器".to_string())?;
        if !r.status().is_success() {
            return Err(format!("下載失敗（{}）", r.status().as_u16()));
        }
        let total = r.content_length().or(m.bytes).unwrap_or(0);
        if total > MAX_APK_BYTES {
            return Err("更新檔太大".into());
        }
        let mut file = std::fs::File::create(&part).map_err(|e| format!("寫不了檔案：{e}"))?;
        let mut hasher = Hasher::default();
        let (mut done, mut last_emit) = (0u64, 0u64);
        let fail = |part: &Path, msg: String| {
            let _ = std::fs::remove_file(part);
            Err(msg)
        };
        loop {
            match r.chunk().await {
                Ok(Some(c)) => {
                    done += c.len() as u64;
                    if done > MAX_APK_BYTES {
                        return fail(&part, "更新檔太大".into());
                    }
                    hasher.update(&c);
                    if let Err(e) = file.write_all(&c) {
                        return fail(&part, format!("寫檔失敗：{e}"));
                    }
                    if done - last_emit >= 256 * 1024 {
                        last_emit = done;
                        let _ = handle.emit("android-update-progress", json!({ "done": done, "total": total }));
                    }
                }
                Ok(None) => break,
                Err(_) => return fail(&part, "下載中斷".into()),
            }
        }
        drop(file);
        if let Err(e) = verify_sha256(&hasher.hex(), &m.sha256) {
            return fail(&part, e);
        }
        std::fs::rename(&part, &fin).map_err(|e| format!("存檔失敗：{e}"))?;
        let _ = handle.emit("android-update-progress", json!({ "done": done, "total": done }));
        Ok(json!({ "path": fin.display().to_string(), "version": m.version }))
    }
}

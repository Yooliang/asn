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

// ---------- 幫電腦開新夥伴（遠端開視窗；視窗開在那台電腦上，手機只下指令） ----------

/// 各電腦的啟動設定（模型、允許的資料夾、在不在線）與最近開視窗的進度。要本人簽章；沒登入回錯，不打後台
#[tauri::command]
pub async fn android_launchers(app: State<'_, App>, auth: State<'_, crate::auth::AuthState>, ids: Option<Vec<String>>) -> Result<serde_json::Value, String> {
    let r = relay_of(&app)?;
    let token = crate::account::signing_token(&auth).await;
    r.launchers_signed(ids.as_deref(), token.as_deref()).await
}

/// 下令在某台電腦開新夥伴（後台再驗一次：本人、那台有這個模型與資料夾、名字沒重、每小時上限）。要本人簽章；沒登入回錯，不打後台。回 { id }
#[tauri::command]
pub async fn android_launch(app: State<'_, App>, auth: State<'_, crate::auth::AuthState>, body: serde_json::Value) -> Result<serde_json::Value, String> {
    let r = relay_of(&app)?;
    let token = crate::account::signing_token(&auth).await;
    r.launch_signed(&body, token.as_deref()).await
}

// ---------- 遠端管理夥伴視窗（詳情、改名、切換模型、關閉、轉交下一任；動作在那台電腦上，手機只下指令） ----------

/// 下令管理某台電腦上的某個夥伴視窗（後台再驗一次：本人、兩台都是你的、名單上有、有開放、名字、忙碌、每小時上限）。要本人簽章；沒登入回錯，不打後台。回 { id }
#[tauri::command]
pub async fn android_partner_op(app: State<'_, App>, auth: State<'_, crate::auth::AuthState>, body: serde_json::Value) -> Result<serde_json::Value, String> {
    let r = relay_of(&app)?;
    let token = crate::account::signing_token(&auth).await;
    r.partner_op_signed(&body, token.as_deref()).await
}

/// 封存／取消封存夥伴（記在帳號層，不需要那台電腦在線）。要本人簽章；沒登入回錯，不打後台。回 { ok, archived }
#[tauri::command]
pub async fn android_partner_archive(app: State<'_, App>, auth: State<'_, crate::auth::AuthState>, body: serde_json::Value) -> Result<serde_json::Value, String> {
    let r = relay_of(&app)?;
    let token = crate::account::signing_token(&auth).await;
    r.partner_archive_signed(&body, token.as_deref()).await
}

/// 查管理操作的進度（最多 20 筆）。要本人簽章；沒登入回錯，不打後台。回 { ops: [...] }
#[tauri::command]
pub async fn android_partner_ops(app: State<'_, App>, auth: State<'_, crate::auth::AuthState>, ids: Vec<String>) -> Result<serde_json::Value, String> {
    let r = relay_of(&app)?;
    let token = crate::account::signing_token(&auth).await;
    r.partner_ops_signed(&ids, token.as_deref()).await
}

// ---------- 遠端切換電腦的 Claude 帳號（#227；後台動作與電腦版相同：acct_list／acct_switch／acct_switch_status，手機靠本人簽章當擁有者） ----------

/// 某台電腦回報的帳號清單（只有 email、方案、使用中，沒有任何權杖）與對方 ASN 是否在線。要本人簽章；沒登入回錯，不打後台。回 { accounts, reported_at, asn_online }
#[tauri::command]
pub async fn android_acct_list(app: State<'_, App>, auth: State<'_, crate::auth::AuthState>, node: String) -> Result<serde_json::Value, String> {
    let r = relay_of(&app)?;
    let token = crate::account::signing_token(&auth).await;
    r.acct_list_signed(&node, token.as_deref()).await
}

/// 送出「切換成這個 email」的指令（對方電腦預設要使用者按同意才會換）。要本人簽章；沒登入回錯，不打後台。回 { id }
#[tauri::command]
pub async fn android_acct_switch(app: State<'_, App>, auth: State<'_, crate::auth::AuthState>, node: String, email: String) -> Result<serde_json::Value, String> {
    let r = relay_of(&app)?;
    let token = crate::account::signing_token(&auth).await;
    r.acct_switch_signed(&node, &email, token.as_deref()).await
}

/// 查切換指令的結果（pending／taken／ok／failed／denied 與失敗原因）。回 { switches: [...] }
#[tauri::command]
pub async fn android_acct_status(app: State<'_, App>, ids: Vec<String>) -> Result<serde_json::Value, String> {
    relay_of(&app)?.acct_switch_status(&ids).await
}

// ---------- 電腦要往終端送字／代答提問的確認（#285、#296；後台 term_req_list／term_req_decide，要本人簽章；桌面才能建立請求，手機只能決定） ----------

/// 待確認的終端請求（哪台電腦、哪個終端與資料夾、預覽前 200 字、有沒有 Enter、選項、雜湊、到期時間）。要本人簽章；沒登入回錯，不打後台。回 { requests: [...] }
#[tauri::command]
pub async fn android_term_req_list(app: State<'_, App>, auth: State<'_, crate::auth::AuthState>) -> Result<serde_json::Value, String> {
    let r = relay_of(&app)?;
    let token = crate::account::signing_token(&auth).await;
    let Some(t) = token.as_deref().filter(|t| !t.is_empty()) else { return Err("尚未登入，不能確認終端請求".into()) };
    r.api_signed("term_req_list", None, Some(t)).await
}

/// 本人按了確認或拒絕：欄位先在這裡檢查（編號、決定、雜湊、選項）才送；雜湊由桌面算、原樣帶回，後台比對。要本人簽章；沒登入回錯，不打後台
#[tauri::command]
pub async fn android_term_req_decide(app: State<'_, App>, auth: State<'_, crate::auth::AuthState>, id: String, decision: String, choice_n: Option<i64>, hash: String) -> Result<serde_json::Value, String> {
    let body = crate::relay::build_term_decide_body(&id, &decision, choice_n, &hash)?;
    let r = relay_of(&app)?;
    let token = crate::account::signing_token(&auth).await;
    let Some(t) = token.as_deref().filter(|t| !t.is_empty()) else { return Err("尚未登入，不能確認終端請求".into()) };
    r.api_signed("term_req_decide", Some(body), Some(t)).await
}

// ---------- 遠端密碼請求的確認（#26 第二期；別台電腦／雲端代理要密碼，由手機本人確認；設計見 docs/design/SECRET-REMOTE.md） ----------

/// 待確認的密碼請求（哪台電腦、哪個程式、要做什麼、公鑰指紋、剩幾秒；沒有任何機密）。要本人簽章；沒登入回錯，不打後台。回 { requests: [...] }
#[tauri::command]
pub async fn android_secret_pending(app: State<'_, App>, auth: State<'_, crate::auth::AuthState>) -> Result<serde_json::Value, String> {
    let r = relay_of(&app)?;
    let token = crate::account::signing_token(&auth).await;
    crate::secret_remote::confirm::list_for_ui(r.as_ref(), token.as_deref()).await
}

/// 本人按了確定（secret 有值）或取消（null）：在這裡（Rust 端）用請求公鑰加密後才送後台，畫面只拿到成功或失敗。要本人簽章；沒登入回錯，不打後台
#[tauri::command]
pub async fn android_secret_reply(app: State<'_, App>, auth: State<'_, crate::auth::AuthState>, id: String, secret: Option<String>) -> Result<(), String> {
    let r = relay_of(&app)?;
    let token = crate::account::signing_token(&auth).await;
    crate::secret_remote::confirm::answer_from_ui(r.as_ref(), token.as_deref(), &id, secret.map(zeroize::Zeroizing::new)).await
}

// ---------- 群組對話（讀沿用電腦版的節點金鑰路徑；發言要本人簽章） ----------

/// 讀群組訊息（限成員）：一定帶 since；mark＝讀完標已讀。回 { messages, last_seq }
#[tauri::command]
pub async fn android_room_read(app: State<'_, App>, auth: State<'_, crate::auth::AuthState>, room: String, agent: Option<String>, since: u64, limit: Option<u64>, mark: bool) -> Result<serde_json::Value, String> {
    let token = crate::account::signing_token(&auth).await;
    relay_of(&app)?.room_read_as(&room, agent.as_deref(), since, limit, mark, token.as_deref()).await
}

/// 在群組發言（限成員）：要本人簽章，後台才標成本人發言；沒登入回錯，不打後台。回 { seq, mentions }
#[tauri::command]
pub async fn android_room_post(app: State<'_, App>, auth: State<'_, crate::auth::AuthState>, body: serde_json::Value) -> Result<serde_json::Value, String> {
    let r = relay_of(&app)?;
    let token = crate::account::signing_token(&auth).await;
    r.room_post_signed(&body, token.as_deref()).await
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

    /// 抓並檢查清單。回 Some（清單，是不是本機測試網址）；官網還沒有清單（404）回 None＝沒有新版。
    /// 連不上、其他錯誤、清單壞掉都只回「暫時無法檢查更新」，不把原始錯誤（狀態碼、英文）帶給畫面
    async fn fetch_manifest(client: &reqwest::Client, url: Option<String>) -> Result<Option<(Manifest, bool)>, String> {
        let test = match url.as_deref() {
            Some(u) if is_loopback_url(u) => Some(u.to_string()),
            Some(_) => return Err("不接受這個測試網址".into()),
            None => None,
        };
        let target = test.clone().unwrap_or_else(|| UPDATE_URL.to_string());
        let r = client.get(&target).timeout(std::time::Duration::from_secs(15)).send().await.map_err(|_| MSG_UNAVAILABLE.to_string())?;
        match classify_status(r.status().as_u16()) {
            CheckStatus::Ok => {}
            CheckStatus::NotFound => return Ok(None),
            CheckStatus::Unavailable => return Err(MSG_UNAVAILABLE.into()),
        }
        let bytes = r.bytes().await.map_err(|_| MSG_UNAVAILABLE.to_string())?;
        if bytes.len() > MAX_MANIFEST_BYTES {
            return Err(MSG_UNAVAILABLE.into());
        }
        let text = String::from_utf8(bytes.to_vec()).map_err(|_| MSG_UNAVAILABLE.to_string())?;
        let m = parse_manifest(&text, test.is_some()).map_err(|_| MSG_UNAVAILABLE.to_string())?;
        Ok(Some((m, test.is_some())))
    }

    pub async fn check(url: Option<String>) -> Result<Value, String> {
        let Some((m, _)) = fetch_manifest(&reqwest::Client::new(), url).await? else {
            return Ok(json!({ "enabled": true, "available": false }));
        };
        Ok(json!({ "enabled": true, "available": is_newer(&m, env!("CARGO_PKG_VERSION")), "version": m.version, "notes": m.notes, "line": first_line(&m.notes) }))
    }

    pub async fn download(handle: &AppHandle, data_dir: &Path, url: Option<String>) -> Result<Value, String> {
        let client = reqwest::Client::new();
        // 下載網址一律用「重新抓到的清單」裡的，不收畫面傳來的
        let Some((m, _)) = fetch_manifest(&client, url).await? else {
            return Err(MSG_LATEST.into());
        };
        if !is_newer(&m, env!("CARGO_PKG_VERSION")) {
            return Err(MSG_LATEST.into());
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

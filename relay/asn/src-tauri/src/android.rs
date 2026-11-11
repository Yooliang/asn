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

// ---------- 手機推播（#797，FCM）：權杖由外殼（Kotlin）向 Firebase 取得、經畫面交給這裡，這裡再交給後台 ----------

/// 把 FCM 權杖交給後台。要先有一次在線回報成功（沒有回 not_ready，畫面稍後再試）；權杖不寫 log，錯誤一律是固定字串
#[tauri::command]
pub async fn android_push_register(app: State<'_, App>, token: String) -> Result<(), String> {
    relay_of(&app)?.push_register(&token).await
}

/// 登出、換帳號前先取消這支手機的推播權杖（連不上也沒關係，後台清除規則會補）
#[tauri::command]
pub async fn android_push_unregister(app: State<'_, App>) -> Result<(), String> {
    relay_of(&app)?.push_unregister().await
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

/// 帳號列表（#374）：本人所有設備回報的各廠牌帳號與額度（跟電腦版的 acct_roster 同一個後台動作）。要本人簽章；沒登入回錯，不打後台
#[tauri::command]
pub async fn android_acct_roster(app: State<'_, App>, auth: State<'_, crate::auth::AuthState>) -> Result<serde_json::Value, String> {
    let r = relay_of(&app)?;
    let token = crate::account::signing_token(&auth).await;
    r.acct_roster_signed(token.as_deref()).await
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

// ---------- 手機回答 Claude 夥伴的權限框（#853）

/// 名下電腦的權限框（全文、選項）和最近的結果。一定要本人簽章
#[tauri::command]
pub async fn android_perm_req_list(app: State<'_, App>, auth: State<'_, crate::auth::AuthState>) -> Result<serde_json::Value, String> {
    let r = relay_of(&app)?;
    let token = crate::account::signing_token(&auth).await;
    let Some(t) = token.as_deref().filter(|t| !t.is_empty()) else { return Err("尚未登入，不能回答權限提示".into()) };
    r.api_signed("perm_req_list", None, Some(t)).await
}

/// 本人按了一個選項：只有編號、數字、雜湊，沒有文字欄位
#[tauri::command]
pub async fn android_perm_req_decide(app: State<'_, App>, auth: State<'_, crate::auth::AuthState>, id: String, choice_n: i64, hash: String) -> Result<serde_json::Value, String> {
    let body = crate::relay::build_perm_decide_body(&id, choice_n, &hash)?;
    let r = relay_of(&app)?;
    let token = crate::account::signing_token(&auth).await;
    let Some(t) = token.as_deref().filter(|t| !t.is_empty()) else { return Err("尚未登入，不能回答權限提示".into()) };
    r.api_signed("perm_req_decide", Some(body), Some(t)).await
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

// ---------- 看電腦的終端（只能看，不能打字）：和電腦版同名同參數，前端共用 remoteViewApi 的呼叫方式 ----------

/// 這支手機能不能發起：連得上即時頻道、不是自己
#[tauri::command]
pub async fn term_view_remote_available(app: State<'_, App>, net: State<'_, crate::ViewNet>, node: String) -> Result<bool, String> {
    Ok(net.0.is_some() && node != app.node)
}

/// 發起查看。只收看畫面，`scope` 帶 input（打字）一律拒絕。回 { id, expires_s, scope }
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn term_view_remote_start(window: tauri::WebviewWindow, app: State<'_, App>, views: State<'_, std::sync::Arc<crate::view_remote::RemoteViews>>, net: State<'_, crate::ViewNet>, to_node: String, partner: String, machine: Option<String>, scope: Option<String>) -> Result<serde_json::Value, String> {
    use tauri::Manager;
    // 要求打字的先擋下，連即時頻道都不看
    crate::view_d::parse_scope(scope.as_deref(), false)?;
    let url = net.0.clone().ok_or("這支手機現在連不上即時頻道，不能看畫面")?;
    let relay = relay_of(&app)?;
    let handle = window.app_handle().clone();
    let backend = std::sync::Arc::new(crate::LiveBackend::new(handle.clone(), relay, app.data_dir.clone()));
    let begun = crate::view_d::start_view(backend.as_ref(), views.inner(), &app.node, to_node, partner, machine, scope.as_deref(), crate::auth::now_ms()).await?;
    // 回給畫面的資料多帶有沒有確認過（不帶指紋）
    let started = crate::view_d::started_view_json(&begun);
    let sink = std::sync::Arc::new(crate::LiveSink::new(handle, window.label().to_string()));
    crate::view_d::spawn_view(backend, sink, views.inner().clone(), url, begun);
    Ok(started)
}

/// 暫停（畫面藏起來）或繼續
#[tauri::command]
pub fn term_view_remote_set(views: State<'_, std::sync::Arc<crate::view_remote::RemoteViews>>, id: String, paused: bool) {
    crate::view_d::set_paused(views.inner(), &id, paused);
}

/// 本人按「結束」
#[tauri::command]
pub fn term_view_remote_stop(views: State<'_, std::sync::Arc<crate::view_remote::RemoteViews>>, id: String) {
    crate::view_d::stop(views.inner(), &id);
}

// ---------- 認得的電腦（手機）：列表、確認指紋、忘記。確認與忘記前的本人確認（生物辨識或螢幕鎖）由畫面做，命令只收具體的電腦 ----------

/// 設定頁「認得的電腦」：名字、節點、有沒有確認過；只有確認過的才帶指紋。不含完整公鑰
#[tauri::command]
pub fn android_known_list(app: State<'_, App>) -> Result<serde_json::Value, String> {
    crate::device_id::live::phone_view(&app.data_dir)
}

/// 出四選一的題目：只給題目編號與四個選項文字；正確的是哪一個只留在 Rust。那台要先記住（否則 not_ready）。
/// 每台電腦的四個選項固定（第一次出題時產生並存檔），同一台同時只有一題；答錯過就回鎖住（還要等幾分鐘）或擋住。
/// 回 { state:"ok", id, options, name } | { state:"locked", minutes } | { state:"blocked" }；name＝這支手機本機記的名字（可能是空字串）
#[tauri::command]
pub fn android_known_challenge(app: State<'_, App>, node: String) -> Result<serde_json::Value, String> {
    use crate::device_id::PickGate;
    let prep = crate::device_id::live::pick_prepare(&app.data_dir, &node, crate::auth::now_ms(), crate::known_pick::options_for)?.ok_or_else(|| "not_ready".to_string())?;
    match prep.gate {
        PickGate::Blocked => Ok(serde_json::json!({ "state": "blocked" })),
        PickGate::Locked { minutes } => Ok(serde_json::json!({ "state": "locked", "minutes": minutes })),
        PickGate::Open => {
            let id = crate::known_pick::issue(&node, &prep.sign_pub, prep.answer)?;
            let name = crate::device_id::live::local_name(&app.data_dir, &node)?.unwrap_or_default();
            Ok(serde_json::json!({ "state": "ok", "id": id, "options": prep.options, "name": name }))
        }
    }
}

/// 回答四選一：pick 是第幾個（從 0 起），-1 是「都不一樣」。回 right／wrong／locked／blocked／none／expired。
/// 答錯記在那台的紀錄上（第一次鎖 10 分鐘、第二次擋住）；「都不一樣」直接擋住；選對只是過關，這裡不會記住任何東西
#[tauri::command]
pub fn android_known_answer(app: State<'_, App>, id: String, pick: i64) -> Result<String, String> {
    use crate::device_id::PickGate;
    let Some(node) = crate::known_pick::node_of(&id) else { return Ok("expired".to_string()) };
    match crate::device_id::live::pick_gate(&app.data_dir, &node, crate::auth::now_ms())? {
        None => return Ok("expired".to_string()),
        Some(PickGate::Blocked) => return Ok("blocked".to_string()),
        Some(PickGate::Locked { .. }) => return Ok("locked".to_string()),
        Some(PickGate::Open) => {}
    }
    let out = crate::known_pick::answer(&id, pick);
    match out {
        crate::known_pick::Outcome::Wrong => {
            let now = crate::auth::now_ms();
            crate::device_id::live::pick_record_wrong(&app.data_dir, &node, now)?;
            // 第二次答錯：已經擋住，回 blocked（畫面顯示擋住的字，不是「10 分鐘後」）
            if crate::device_id::live::pick_gate(&app.data_dir, &node, now)? == Some(PickGate::Blocked) {
                return Ok("blocked".to_string());
            }
        }
        crate::known_pick::Outcome::NoneMatch => {
            crate::device_id::live::pick_block(&app.data_dir, &node)?;
            elog!("本人表示手機上的指紋選項都和電腦不一樣，沒有記住");
        }
        _ => {}
    }
    Ok(out.as_str().to_string())
}

/// 要一個一次性的確認憑證（`action`＝confirm 或 forget，要對哪台電腦）：32 位元組亂數的十六進位字串，30 秒內有效、只能用一次。
/// 畫面拿它請外殼跳生物辨識；外殼驗證通過才寫出對應的憑證檔，之後的確認、忘記帶著它回來才算數（見 consent.rs）。只接受主畫面（手機只有一個畫面，這條主要是防將來多視窗時誤用）
#[tauri::command]
pub fn android_known_token(window: tauri::WebviewWindow, app: State<'_, App>, action: String, node: String) -> Result<String, String> {
    if !crate::consent::label_ok(window.label()) {
        return Err(crate::consent::NOT_VERIFIED.to_string());
    }
    let Some(act) = crate::consent::Action::parse(&action) else { return Err("bad_action".to_string()) };
    if node.is_empty() || node.len() > 64 {
        return Err("bad_node".to_string());
    }
    // 框上的字由這裡決定：動作＋本人自己取的名字（沒取就未命名）＋記住的那把公鑰的指紋前兩組（網頁給的字不進框）
    let known = crate::device_id::live::known(&app.data_dir)?;
    let peer = known.peer(&node).ok_or_else(|| "not_ready".to_string())?;
    // 掃 QR code 是四選一以外的另一條確認路：答錯被鎖住或擋住的電腦一樣不給掃（不開相機）
    if act == crate::consent::Action::Scan {
        match crate::device_id::live::pick_gate(&app.data_dir, &node, crate::auth::now_ms())? {
            Some(crate::device_id::PickGate::Blocked) => return Err("blocked".to_string()),
            Some(crate::device_id::PickGate::Locked { .. }) => return Err("locked".to_string()),
            _ => {}
        }
    }
    let text = crate::consent::describe(act, crate::consent::prompt_name(peer), &crate::device_id::fp_grouped(&peer.sign_pub));
    let challenge = crate::consent::issue(act, &node)?;
    crate::consent::write_desc(&app.data_dir, &challenge, &text)?;
    Ok(challenge)
}

/// 選對之後才記住：先取走過關的題目（一次、60 秒內），再用那台的憑證（本人剛在這支手機上驗證過、30 秒內、一次）；
/// 兩者都通過才用記住的那把公鑰重算指紋交給確認（成功會清掉答錯紀錄）。這期間那台被忘記、換了公鑰、或被鎖住就不記。回有沒有記到
#[tauri::command]
pub fn android_known_confirm(window: tauri::WebviewWindow, app: State<'_, App>, id: String, challenge: String) -> Result<bool, String> {
    if !crate::consent::label_ok(window.label()) {
        return Ok(false);
    }
    let Some((node, sign_pub)) = crate::known_pick::take_passed(&id) else { return Ok(false) };
    if !crate::consent::redeem(&app.data_dir, crate::consent::Action::Confirm, &node, &challenge) {
        return Ok(false);
    }
    crate::device_id::live::confirm(&app.data_dir, &node, &crate::device_id::fingerprint(&sign_pub), crate::auth::now_ms())
}

/// 用相機掃電腦設定頁上的 QR code 核對指紋（先用 `android_known_token` 要 scan 憑證，外殼掃描、本人驗證通過後才寫掃描檔與憑證檔）。
/// 掃到的字不經過畫面：這裡先用憑證（本人驗證過）、再讀出並刪掉掃描檔，格式、節點、指紋由 Rust 判斷（fp_scan.rs），
/// 指紋是用這支手機記住的公鑰重算的。一樣就記住（清掉答錯紀錄）；不一樣就擋住（和「都不一樣」同一種），不是 ASN 的 QR code 什麼都不動。
/// 回 ok／mismatch／bad_qr／not_verified／blocked／locked
#[tauri::command]
pub fn android_known_scan_confirm(window: tauri::WebviewWindow, app: State<'_, App>, node: String, challenge: String) -> Result<String, String> {
    use crate::device_id::PickGate;
    if !crate::consent::label_ok(window.label()) {
        return Ok(crate::consent::NOT_VERIFIED.to_string());
    }
    let known = crate::device_id::live::known(&app.data_dir)?;
    let peer = known.peer(&node).ok_or_else(|| "not_ready".to_string())?;
    let remembered = crate::device_id::fingerprint(&peer.sign_pub);
    let dir = &app.data_dir;
    let now = crate::auth::now_ms();
    let out = crate::fp_scan::run(
        || crate::consent::redeem(dir, crate::consent::Action::Scan, &node, &challenge),
        || crate::consent::take_scan(dir, &challenge),
        || {
            Ok(match crate::device_id::live::pick_gate(dir, &node, now)? {
                Some(PickGate::Blocked) => Some("blocked"),
                Some(PickGate::Locked { .. }) => Some("locked"),
                _ => None,
            })
        },
        &node,
        &remembered,
        || crate::device_id::live::confirm(dir, &node, &remembered, now),
        || {
            crate::device_id::live::pick_block(dir, &node)?;
            elog!("掃到的指紋和這支手機記住的不一樣，已經擋下");
            Ok(())
        },
    )?;
    Ok(out.to_string())
}

/// 本人在設定頁按「忘記」：要帶這台的憑證（本人剛在這支手機上驗證過）。下次再連就當第一次。回有沒有這台
#[tauri::command]
pub fn android_known_forget(window: tauri::WebviewWindow, app: State<'_, App>, node: String, challenge: String) -> Result<bool, String> {
    if !crate::consent::label_ok(window.label()) || !crate::consent::redeem(&app.data_dir, crate::consent::Action::Forget, &node, &challenge) {
        return Err(crate::consent::NOT_VERIFIED.to_string());
    }
    let gone = crate::device_id::live::forget(&app.data_dir, &node)?;
    crate::known_pick::drop_node(&node);
    crate::consent::drop_node(&node);
    Ok(gone)
}

/// 本人替這台電腦改名（只改這支手機上記的名字；不用生物辨識，因為不影響信任）。名字先整理過（去控制字元、最多 32 字，空的＝未命名）。
/// 只有這個命令能改手機上的名字（守門測試）。回有沒有這台
#[tauri::command]
pub fn android_known_rename(window: tauri::WebviewWindow, app: State<'_, App>, node: String, name: String) -> Result<bool, String> {
    if !crate::consent::label_ok(window.label()) {
        return Ok(false);
    }
    crate::device_id::live::rename_peer(&app.data_dir, &node, &name)
}

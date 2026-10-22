//! 登入帳號的動作：呼叫後台的 account_bootstrap／node_create／node_claim，並把新節點金鑰存成本機檔案。
//! 登入憑證只在這裡用（Authorization 標頭）；節點金鑰只經過這裡一次（寫進 ~/.irori-relay/<節點>.key，不回前端、不進 log）。
use crate::auth::{self, AuthState, AuthStatus};
use crate::{identity, App};
use serde::Serialize;
use serde_json::{json, Value};
use std::path::Path;
use tauri::{AppHandle, State};

/// 後台回的錯誤碼 → 給人看的話
pub fn error_text(code: &str) -> String {
    match code {
        "unauthorized" => "登入已失效，請重新登入",
        "tenant_not_yours" => "這個節點還在舊的收發室租戶底下，要等舊租戶認領到你的帳號",
        "already_claimed" => "這個節點已經被別的帳號認領了",
        "invalid_key" => "這台電腦的節點金鑰後台不認得（可能已被換掉）",
        "too_many" => "這個帳號的電腦數量已達上限",
        "tenant_inactive" => "這個帳號的收發室目前停用中",
        "bad_request" => "送出的內容不合格",
        "internal" => "後台暫時有問題，請稍後再試",
        "not_found" => "找不到這台設備（它不在你的帳號底下）",
        "asn_offline" => "那台電腦的 ASN 目前沒有開著，等它上線再試",
        "rate_limited" => "剛剛更新失敗，請稍候一分鐘再試",
        _ => "後台沒有接受這個要求",
    }
    .to_string()
}

/// 帳號動作失敗：code＝後台回的錯誤碼（連不上時是空字串），text＝給人看的話
#[derive(Debug)]
pub struct CallErr {
    pub code: String,
    pub text: String,
}
impl From<CallErr> for String {
    fn from(e: CallErr) -> String {
        e.text
    }
}

/// 呼叫帳號動作（POST）。token＝登入存取憑證；node_key 只有 node_claim 才帶（x-relay-key）。
pub async fn call(client: &reqwest::Client, relay_url: &str, token: &str, action: &str, node_key: Option<&str>, body: Value) -> Result<Value, CallErr> {
    let net = |t: &str| CallErr { code: String::new(), text: t.to_string() };
    let mut rb = client
        .post(format!("{relay_url}?action={action}"))
        .timeout(std::time::Duration::from_secs(30))
        .header("authorization", format!("Bearer {token}"))
        .json(&body);
    if let Some(k) = node_key {
        rb = rb.header("x-relay-key", k);
    }
    let r = rb.send().await.map_err(|_| net("連不上後台，請檢查網路"))?;
    let status = r.status();
    let text = r.text().await.map_err(|_| net("讀不到後台的回應"))?;
    let v: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
    if status.is_success() {
        return Ok(v);
    }
    let code = v.get("error").and_then(Value::as_str).unwrap_or("");
    Err(CallErr { code: code.to_string(), text: error_text(code) })
}

// ---------- 「暫時不登入」的記號 ----------

const SKIP_FILE: &str = "login_skipped";

/// 使用者在登入畫面按過「暫時不登入」（只在這台已有節點金鑰時才有這個選項）
pub fn login_skipped(data_dir: &Path) -> bool {
    data_dir.join(SKIP_FILE).exists()
}
pub fn set_login_skipped(data_dir: &Path, on: bool) -> Result<(), String> {
    let f = data_dir.join(SKIP_FILE);
    if on {
        crate::write_atomic(&f, "1").map_err(|e| format!("存不了設定：{e}"))
    } else {
        match std::fs::remove_file(&f) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(format!("清不掉設定：{e}")),
        }
    }
}

/// 啟動時要不要先顯示登入畫面：沒有節點金鑰一定要；有金鑰但沒登入，除非使用者選了「暫時不登入」
pub fn needs_login(has_node: bool, signed_in: bool, skipped: bool) -> bool {
    !has_node || (!signed_in && !skipped)
}

/// 綁定結果給前端的樣子
#[derive(Serialize, Debug, PartialEq)]
pub struct BindOutcome {
    /// created＝新建節點（稍後重新啟動）；bound＝已綁到帳號；pending＝這台沒擋，但還沒綁到
    pub state: &'static str,
    pub note: String,
}

/// 有節點金鑰時 node_claim 的結果 → 綁定結果。任何失敗都不擋使用（tenant_not_yours＝舊租戶還沒被認領，之後每次啟動再試）
pub fn claim_outcome(r: Result<Value, CallErr>) -> BindOutcome {
    match r {
        Ok(v) if v.get("already").and_then(Value::as_bool) == Some(true) => BindOutcome { state: "bound", note: "這台電腦本來就在你的帳號底下".into() },
        Ok(_) => BindOutcome { state: "bound", note: "已把這台電腦連到你的帳號".into() },
        Err(e) => BindOutcome { state: "pending", note: if e.code == "tenant_not_yours" { "這台電腦尚未綁到你的帳號（認領後會自動完成）".into() } else { e.text } },
    }
}

// ---------- 本機檔案 ----------

/// 讀不到設備名稱時用的名字：電腦版叫「我的電腦」，手機版叫「我的手機」
pub const DEVICE_FALLBACK: &str = if cfg!(target_os = "android") { "我的手機" } else { "我的電腦" };

/// 這台電腦的名字（給後台當節點顯示名與機器名）：Windows 電腦名稱；去控制字元、限 40 字
pub fn computer_name(env: impl Fn(&str) -> Option<String>) -> String {
    let raw = env("COMPUTERNAME").or_else(|| env("HOSTNAME")).unwrap_or_default();
    let clean: String = raw.chars().filter(|c| !c.is_control()).collect::<String>().trim().chars().take(40).collect();
    if clean.is_empty() { DEVICE_FALLBACK.to_string() } else { clean }
}

/// 每台電腦自己的亂數識別，存在資料夾裡；有就沿用（重送 node_create 時後台靠它認出同一台）
pub fn load_or_create_device_id(data_dir: &Path) -> Result<String, String> {
    let f = data_dir.join("device_id");
    if let Ok(s) = std::fs::read_to_string(&f) {
        let s = s.trim();
        if s.len() >= 16 && s.len() <= 64 && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
            return Ok(s.to_string());
        }
    }
    let id = auth::new_device_id();
    crate::write_atomic(&f, &id).map_err(|e| format!("存不了裝置識別：{e}"))?;
    Ok(id)
}

/// 檔案權限只給本人（Windows 用 icacls 拿掉繼承、只授權目前使用者；其他系統 0600）。回是否成功
fn restrict_file(path: &Path) -> bool {
    #[cfg(windows)]
    {
        use crate::nowin::NoWindow;
        let user = std::env::var("USERNAME").unwrap_or_default();
        if user.is_empty() {
            return false;
        }
        let who = match std::env::var("USERDOMAIN") {
            Ok(d) if !d.is_empty() => format!("{d}\\{user}:F"),
            _ => format!("{user}:F"),
        };
        std::process::Command::new("icacls")
            .no_window()
            .arg(path)
            .args(["/inheritance:r", "/grant:r"])
            .arg(who)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .map(|s| s.success())
            .unwrap_or(false)
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600)).is_ok()
    }
}

/// 把新金鑰寫進 <relay_home>/<節點>.key（沿用現有格式：只有金鑰本身），再寫 <relay_home>/node。
/// 先建空檔並限縮權限、才寫入內容；寫完讀回比對；任何一步失敗就刪掉金鑰檔（不留下權限鬆的金鑰）。
/// restrict 由呼叫端傳入，測試可換成假的。
pub fn write_node_files(relay_home: &Path, node: &str, key: &str, restrict: impl Fn(&Path) -> bool) -> Result<(), String> {
    if !identity::valid_id(node) || key.trim().is_empty() {
        return Err("後台回的節點資料格式不對".into());
    }
    std::fs::create_dir_all(relay_home).map_err(|e| format!("建不了資料夾：{e}"))?;
    let kf = relay_home.join(format!("{node}.key"));
    let cleanup = |m: String| {
        let _ = std::fs::remove_file(&kf);
        Err(m)
    };
    if let Err(e) = std::fs::write(&kf, b"") {
        return cleanup(format!("寫不了金鑰檔：{e}"));
    }
    if !restrict(&kf) {
        return cleanup("沒辦法把金鑰檔限制成只有你能讀，已放棄寫入".into());
    }
    if let Err(e) = std::fs::write(&kf, key) {
        return cleanup(format!("寫不了金鑰檔：{e}"));
    }
    match std::fs::read_to_string(&kf) {
        Ok(back) if back.trim() == key => {}
        _ => return cleanup("金鑰存到這台電腦後讀回不一致".into()),
    }
    if let Err(e) = std::fs::write(relay_home.join("node"), node) {
        return cleanup(format!("寫不了節點代號檔：{e}"));
    }
    Ok(())
}

// ---------- 給前端看的資料（不含任何權杖與金鑰） ----------

#[derive(Serialize)]
pub struct AccountInfo {
    pub email: Option<String>,
    pub created: bool,
    pub node_count: usize,
    pub this_node_mine: bool,
}

/// 後台回的名下節點是否包含這台的節點
/// 名下「電腦」數：只算電腦本身（舊的機器節點 kind=claude，登入後建的 created_via=login-device），
/// 雲端代理（grok）、服務（aegis）、角色（希緒）不算電腦
pub fn computer_count(nodes: &Value) -> usize {
    nodes.as_array().map(|a| a.iter().filter(|n| {
        n.get("kind").and_then(Value::as_str) == Some("claude") || n.get("created_via").and_then(Value::as_str) == Some("login-device")
    }).count()).unwrap_or(0)
}

pub fn node_in_list(nodes: &Value, node: &str) -> bool {
    nodes.as_array().map(|a| a.iter().any(|n| n.get("id").and_then(Value::as_str) == Some(node))).unwrap_or(false)
}

pub(crate) struct Ctx {
    pub(crate) client: reqwest::Client,
    pub(crate) relay_url: String,
    pub(crate) auth_base: String,
    pub(crate) anon: String,
}

pub(crate) fn ctx() -> Result<Ctx, String> {
    let relay_url = identity::base_url(crate::envc::get("ASN_RELAY_URL"));
    let anon = identity::read_anon(&identity::relay_home(), crate::envc::get("ASN_RELAY_ANON_KEY"), &relay_url).ok_or("找不到後台的公開金鑰（anon），沒辦法登入")?;
    Ok(Ctx { client: reqwest::Client::new(), auth_base: auth::auth_base_from(&relay_url), relay_url, anon })
}

/// 本人簽章用的登入憑證（盡力而為）：沒登入、過期、換憑證失敗、逾時、找不到公開金鑰都回 None，
/// 呼叫端照舊寄信（不帶憑證＝一般信），絕不因此擋寄送。憑證只在 Rust 端，不交給前端、不寫 log。
pub async fn signing_token(auth: &AuthState) -> Option<String> {
    let c = ctx().ok()?;
    match tokio::time::timeout(std::time::Duration::from_secs(4), auth.access_token(&c.client, &c.auth_base, &c.anon)).await {
        Ok(Ok(t)) if !t.is_empty() => Some(t),
        _ => None,
    }
}

// ---------- 指令 ----------

#[tauri::command]
pub fn auth_status(auth: State<'_, AuthState>) -> AuthStatus {
    auth.status()
}

/// 開瀏覽器登入並等回呼（最多 5 分鐘）。provider＝google 或 github
#[tauri::command]
pub async fn auth_login(app: State<'_, App>, auth: State<'_, AuthState>, handle: AppHandle, provider: String) -> Result<AuthStatus, String> {
    let c = ctx()?;
    let st = auth.login(&c.client, &c.auth_base, &c.anon, &provider, |u| crate::open_in_browser(&handle, u)).await?;
    set_login_skipped(&app.data_dir, false)?;   // 登入了就不再是「暫時不登入」
    // 記住這次的登入方式與帳號頭像（下載失敗不擋登入；檔案裡沒有任何權杖）
    let avatar = match auth.session_avatar_url() {
        Some(u) => crate::lastlogin::fetch_avatar(&c.client, &u).await,
        None => None,
    };
    let _ = crate::lastlogin::save_login(&app.data_dir, &provider, avatar);
    Ok(st)
}

/// 名單視窗的這台大頭貼有變：同步到「上次登入」的記憶（None＝清掉）
#[tauri::command]
pub fn last_login_set_avatar(app: State<'_, App>, avatar: Option<String>) -> Result<(), String> {
    crate::lastlogin::set_custom_avatar(&app.data_dir, avatar)
}

#[tauri::command]
pub fn auth_cancel(auth: State<'_, AuthState>) {
    auth.cancel.store(true, std::sync::atomic::Ordering::SeqCst);
}

/// 登出：通知後台作廢這個登入（盡力而為），再清掉本機登入權杖與「暫時不登入」記號，重新啟動回到登入畫面。不刪節點金鑰。
#[tauri::command]
pub async fn auth_logout(app: State<'_, App>, auth: State<'_, AuthState>, handle: AppHandle) -> Result<(), String> {
    if let Ok(c) = ctx() {
        if let Ok(t) = auth.access_token(&c.client, &c.auth_base, &c.anon).await {
            let _ = c.client.post(format!("{}/auth/v1/logout?scope=local", c.auth_base)).header("apikey", &c.anon).bearer_auth(t).timeout(std::time::Duration::from_secs(5)).send().await;
        }
    }
    auth.sign_out()?;
    set_login_skipped(&app.data_dir, false)?;
    restart_soon(&app, handle);
    Ok(())
}

/// 晚一點再重新啟動，讓指令先把結果回給畫面（--shot 模式不重啟）
fn restart_soon(app: &App, handle: AppHandle) {
    if app.shot.is_some() {
        return;
    }
    // 安卓：行程不能由自己重新啟動（沒有可執行檔可再叫起）。由畫面請外殼重開（lib 的 android 模組），這裡不動
    if cfg!(target_os = "android") {
        return;
    }
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_millis(600)).await;
        crate::cleanup(&handle);
        handle.restart();
    });
}

/// 登入畫面的「暫時不登入」：只有這台已有節點金鑰時才准（記住這個選擇，之後開機照舊進名單）
#[tauri::command]
pub fn auth_skip_login(app: State<'_, App>) -> Result<(), String> {
    if app.relay.is_none() {
        return Err("這台電腦還沒有收發室金鑰，需要先登入".into());
    }
    set_login_skipped(&app.data_dir, true)
}

/// 帳號資訊：第一次呼叫時後台會替這個帳號建租戶；回名下電腦數與「這台是不是已經在名下」
#[tauri::command]
pub async fn auth_account_info(app: State<'_, App>, auth: State<'_, AuthState>) -> Result<AccountInfo, String> {
    let c = ctx()?;
    let token = auth.access_token(&c.client, &c.auth_base, &c.anon).await?;
    let v = call(&c.client, &c.relay_url, &token, "account_bootstrap", None, json!({})).await?;
    let nodes = v.get("nodes").cloned().unwrap_or(Value::Null);
    Ok(AccountInfo {
        email: auth.status().email,
        created: v.get("created").and_then(Value::as_bool).unwrap_or(false),
        node_count: computer_count(&nodes),
        this_node_mine: !app.node.is_empty() && node_in_list(&nodes, &app.node),
    })
}

/// 登入後自動處理金鑰（使用者不用按任何鈕）：
/// - 這台已有節點金鑰 → node_claim 綁到帳號；失敗（含舊租戶還沒被認領）都不擋使用，回 pending，下次啟動再試
/// - 沒有節點金鑰 → node_create 建新節點、存好金鑰（呼叫端稍後重新啟動）
/// 金鑰從本機檔案讀，只放在送出的標頭裡；新金鑰只經過這裡一次。
pub async fn bind_this(app: &App, auth: &AuthState) -> Result<BindOutcome, String> {
    let c = ctx()?;
    let token = auth.access_token(&c.client, &c.auth_base, &c.anon).await?;
    if app.relay.is_some() {
        let id = match identity::resolve() {
            Ok(i) => i,
            Err(t) => return Ok(BindOutcome { state: "pending", note: t }),
        };
        if let Err(e) = call(&c.client, &c.relay_url, &token, "account_bootstrap", None, json!({})).await {
            return Ok(claim_outcome(Err(e)));
        }
        return Ok(claim_outcome(call(&c.client, &c.relay_url, &token, "node_claim", Some(&id.key), json!({})).await));
    }
    call(&c.client, &c.relay_url, &token, "account_bootstrap", None, json!({})).await?;
    let name = computer_name(|k| std::env::var(k).ok());
    let device_id = load_or_create_device_id(&app.data_dir)?;
    let v = call(&c.client, &c.relay_url, &token, "node_create", None, json!({ "name": name, "machine": name, "device_id": device_id })).await?;
    let id = v.get("id").and_then(Value::as_str).unwrap_or("");
    let key = v.get("key").and_then(Value::as_str).unwrap_or("");
    write_node_files(&identity::relay_home(), id, key, restrict_file)?;
    Ok(BindOutcome { state: "created", note: "已替這台電腦建立節點".into() })
}

/// 遠端更新：對自己帳號下的別台設備留一筆「更新」請求（後台只認登入憑證的本人，對別人的設備一律 not_found）。
/// 那台 ASN 下次回報在線時讀到旗標，自己用內建更新器更新。→ { ok, already, state }
#[tauri::command]
pub async fn update_remote_request(app: State<'_, App>, auth: State<'_, AuthState>, node: String) -> Result<Value, String> {
    if app.shot.is_some() {
        return Err("--shot 模式不更新".into());
    }
    let c = ctx()?;
    let token = auth.access_token(&c.client, &c.auth_base, &c.anon).await?;
    Ok(call(&c.client, &c.relay_url, &token, "node_update_request", None, json!({ "node": node })).await?)
}

/// 遠端更新的狀態：自己帳號下各設備 → { nodes: [{ id, update: null | { state: pending | taken | failed, detail, at } }] }。
/// 沒登入、--shot 模式回空清單（不報錯，名單照常顯示、只是沒有「更新」鈕）。
#[tauri::command]
pub async fn update_remote_status(app: State<'_, App>, auth: State<'_, AuthState>) -> Result<Value, String> {
    if app.shot.is_some() || !auth.status().signed_in {
        return Ok(json!({ "nodes": [] }));
    }
    let c = ctx()?;
    let token = auth.access_token(&c.client, &c.auth_base, &c.anon).await?;
    Ok(call(&c.client, &c.relay_url, &token, "node_update_status", None, json!({})).await?)
}

#[tauri::command]
pub async fn auth_bind(app: State<'_, App>, auth: State<'_, AuthState>, handle: AppHandle) -> Result<BindOutcome, String> {
    let out = bind_this(&app, &auth).await?;
    if out.state == "created" {
        restart_soon(&app, handle);
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 錯誤碼對映成中文() {
        assert!(error_text("tenant_not_yours").contains("舊"));
        assert!(error_text("already_claimed").contains("別的帳號"));
        assert!(error_text("whatever").contains("沒有接受"));
        assert!(error_text("not_found").contains("不在你的帳號") && error_text("asn_offline").contains("沒有開著") && error_text("rate_limited").contains("稍候"));
        assert!(error_text("unauthorized").contains("重新登入"));
    }

    #[test]
    fn 電腦數只算電腦() {
        let v = json!([{"id":"H","kind":"claude"},{"id":"w02","kind":"claude"},{"id":"grok","kind":"grok"},{"id":"aegis","kind":"other"},{"id":"t1-ab","kind":"other","created_via":"login-device"}]);
        assert_eq!(computer_count(&v), 3);
        assert_eq!(computer_count(&Value::Null), 0);
    }

    #[test]
    fn 電腦名稱清理() {
        let env = |v: &'static str| move |k: &str| if k == "COMPUTERNAME" { Some(v.to_string()) } else { None };
        assert_eq!(computer_name(env("  H-PC\n")), "H-PC");
        assert_eq!(computer_name(env("")), "我的電腦");
        assert_eq!(computer_name(env("字字字字字字字字字字字字字字字字字字字字字字字字字字字字字字字字字字字字字字字字字字字字")).chars().count(), 40);
        assert_eq!(computer_name(|k| if k == "HOSTNAME" { Some("linuxbox".into()) } else { None }), "linuxbox");
    }

    #[test]
    fn 裝置識別第一次建立之後沿用() {
        let d = tempfile::tempdir().unwrap();
        let a = load_or_create_device_id(d.path()).unwrap();
        assert!(a.len() >= 16);
        assert_eq!(load_or_create_device_id(d.path()).unwrap(), a);
        std::fs::write(d.path().join("device_id"), "bad id!").unwrap();
        let b = load_or_create_device_id(d.path()).unwrap();
        assert_ne!(b, "bad id!");
    }

    #[test]
    fn 金鑰檔_格式沿用_讀回一致_並寫節點代號() {
        let d = tempfile::tempdir().unwrap();
        write_node_files(d.path(), "t5-ab12cd34", "KEY-value_1", |_| true).unwrap();
        assert_eq!(std::fs::read_to_string(d.path().join("t5-ab12cd34.key")).unwrap(), "KEY-value_1");
        assert_eq!(std::fs::read_to_string(d.path().join("node")).unwrap(), "t5-ab12cd34");
        // 新電腦的身分判定讀得到它
        assert_eq!(identity::machine_node(d.path(), None, |_| false).unwrap(), "t5-ab12cd34");
        assert_eq!(identity::read_key(d.path(), "t5-ab12cd34", None).unwrap(), "KEY-value_1");
    }

    #[test]
    fn 金鑰檔_限縮權限失敗就不留金鑰() {
        let d = tempfile::tempdir().unwrap();
        let e = write_node_files(d.path(), "t5-ab12cd34", "SECRETKEY", |_| false).unwrap_err();
        assert!(e.contains("只有你能讀"));
        assert!(!d.path().join("t5-ab12cd34.key").exists());
        assert!(!d.path().join("node").exists());
        // 限縮要在寫入內容「之前」：限縮時檔案還是空的
        let seen = std::cell::Cell::new(usize::MAX);
        write_node_files(d.path(), "t5-ab12cd34", "SECRETKEY", |p| { seen.set(std::fs::metadata(p).unwrap().len() as usize); true }).unwrap();
        assert_eq!(seen.get(), 0);
    }

    #[test]
    fn 金鑰檔_不合格的代號或空金鑰不寫() {
        let d = tempfile::tempdir().unwrap();
        assert!(write_node_files(d.path(), "../evil", "K", |_| true).is_err());
        assert!(write_node_files(d.path(), "ok", "  ", |_| true).is_err());
        assert!(std::fs::read_dir(d.path()).unwrap().next().is_none());
    }

    #[test]
    fn 啟動要不要先顯示登入畫面() {
        assert!(needs_login(false, false, false), "新電腦一定要登入");
        assert!(needs_login(false, true, true), "沒有金鑰就算登入過也要走建立節點");
        assert!(needs_login(true, false, false), "舊電腦沒登入：要登入一次");
        assert!(!needs_login(true, true, false), "舊電腦已登入：直接進名單");
        assert!(!needs_login(true, false, true), "舊電腦選了暫時不登入：進名單");
    }

    #[test]
    fn 暫時不登入的記號_寫入_讀取_清除() {
        let d = tempfile::tempdir().unwrap();
        assert!(!login_skipped(d.path()));
        set_login_skipped(d.path(), true).unwrap();
        assert!(login_skipped(d.path()));
        set_login_skipped(d.path(), false).unwrap();
        assert!(!login_skipped(d.path()));
        set_login_skipped(d.path(), false).unwrap();   // 本來就沒有也不出錯
    }

    #[test]
    fn 綁定結果_成功_已綁_舊租戶沒認領不擋_其他失敗也不擋() {
        let ok = claim_outcome(Ok(json!({ "ok": true, "already": false })));
        assert_eq!((ok.state, ok.note.as_str()), ("bound", "已把這台電腦連到你的帳號"));
        assert_eq!(claim_outcome(Ok(json!({ "ok": true, "already": true }))).state, "bound");
        let old = claim_outcome(Err(CallErr { code: "tenant_not_yours".into(), text: error_text("tenant_not_yours") }));
        assert_eq!(old.state, "pending");
        assert!(old.note.contains("尚未綁到你的帳號") && old.note.contains("自動完成"));
        let net = claim_outcome(Err(CallErr { code: String::new(), text: "連不上後台，請檢查網路".into() }));
        assert_eq!((net.state, net.note.as_str()), ("pending", "連不上後台，請檢查網路"));
        assert_eq!(claim_outcome(Err(CallErr { code: "already_claimed".into(), text: error_text("already_claimed") })).state, "pending");
    }

    #[test]
    fn 名下節點比對() {
        let nodes = json!([{ "id": "H" }, { "id": "t5-x" }]);
        assert!(node_in_list(&nodes, "H") && !node_in_list(&nodes, "W") && !node_in_list(&Value::Null, "H"));
    }
}

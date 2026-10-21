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
        "tenant_not_yours" => "這個節點還在舊的收發室租戶底下，請先請管理者把舊租戶認領到你的帳號，再回來連結",
        "already_claimed" => "這個節點已經被別的帳號認領了",
        "invalid_key" => "這台電腦的節點金鑰後台不認得（可能已被換掉）",
        "too_many" => "這個帳號的電腦數量已達上限",
        "tenant_inactive" => "這個帳號的收發室目前停用中",
        "bad_request" => "送出的內容不合格",
        "internal" => "後台暫時有問題，請稍後再試",
        _ => "後台沒有接受這個要求",
    }
    .to_string()
}

/// 呼叫帳號動作（POST）。token＝登入存取憑證；node_key 只有 node_claim 才帶（x-relay-key）。
pub async fn call(client: &reqwest::Client, relay_url: &str, token: &str, action: &str, node_key: Option<&str>, body: Value) -> Result<Value, String> {
    let mut rb = client
        .post(format!("{relay_url}?action={action}"))
        .timeout(std::time::Duration::from_secs(30))
        .header("authorization", format!("Bearer {token}"))
        .json(&body);
    if let Some(k) = node_key {
        rb = rb.header("x-relay-key", k);
    }
    let r = rb.send().await.map_err(|_| "連不上後台，請檢查網路".to_string())?;
    let status = r.status();
    let text = r.text().await.map_err(|_| "讀不到後台的回應".to_string())?;
    let v: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
    if status.is_success() {
        return Ok(v);
    }
    let code = v.get("error").and_then(Value::as_str).unwrap_or("");
    Err(error_text(code))
}

// ---------- 本機檔案 ----------

/// 這台電腦的名字（給後台當節點顯示名與機器名）：Windows 電腦名稱；去控制字元、限 40 字
pub fn computer_name(env: impl Fn(&str) -> Option<String>) -> String {
    let raw = env("COMPUTERNAME").or_else(|| env("HOSTNAME")).unwrap_or_default();
    let clean: String = raw.chars().filter(|c| !c.is_control()).collect::<String>().trim().chars().take(40).collect();
    if clean.is_empty() { "我的電腦".to_string() } else { clean }
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
pub fn node_in_list(nodes: &Value, node: &str) -> bool {
    nodes.as_array().map(|a| a.iter().any(|n| n.get("id").and_then(Value::as_str) == Some(node))).unwrap_or(false)
}

struct Ctx {
    client: reqwest::Client,
    relay_url: String,
    auth_base: String,
    anon: String,
}

fn ctx() -> Result<Ctx, String> {
    let relay_url = identity::base_url(std::env::var("IRORI_RELAY_URL").ok());
    let anon = identity::read_anon(&identity::relay_home(), std::env::var("IRORI_RELAY_ANON_KEY").ok(), &relay_url).ok_or("找不到後台的公開金鑰（anon），沒辦法登入")?;
    Ok(Ctx { client: reqwest::Client::new(), auth_base: auth::auth_base_from(&relay_url), relay_url, anon })
}

// ---------- 指令 ----------

#[tauri::command]
pub fn auth_status(auth: State<'_, AuthState>) -> AuthStatus {
    auth.status()
}

/// 開瀏覽器登入並等回呼（最多 5 分鐘）。provider＝google 或 github
#[tauri::command]
pub async fn auth_login(auth: State<'_, AuthState>, provider: String) -> Result<AuthStatus, String> {
    let c = ctx()?;
    auth.login(&c.client, &c.auth_base, &c.anon, &provider, |u| crate::spawn_browser(u)).await
}

#[tauri::command]
pub fn auth_cancel(auth: State<'_, AuthState>) {
    auth.cancel.store(true, std::sync::atomic::Ordering::SeqCst);
}

/// 登出：通知後台作廢這個登入（盡力而為），再清掉本機登入權杖。不刪節點金鑰。
#[tauri::command]
pub async fn auth_logout(auth: State<'_, AuthState>) -> Result<(), String> {
    if let Ok(c) = ctx() {
        if let Ok(t) = auth.access_token(&c.client, &c.auth_base, &c.anon).await {
            let _ = c.client.post(format!("{}/auth/v1/logout?scope=local", c.auth_base)).header("apikey", &c.anon).bearer_auth(t).timeout(std::time::Duration::from_secs(5)).send().await;
        }
    }
    auth.sign_out()
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
        node_count: nodes.as_array().map(|a| a.len()).unwrap_or(0),
        this_node_mine: !app.node.is_empty() && node_in_list(&nodes, &app.node),
    })
}

/// 把這台電腦（目前的節點金鑰）連到登入帳號。金鑰從本機檔案讀，只放在送出的標頭裡
#[tauri::command]
pub async fn auth_claim_this(auth: State<'_, AuthState>) -> Result<String, String> {
    let c = ctx()?;
    let id = identity::resolve()?;
    let token = auth.access_token(&c.client, &c.auth_base, &c.anon).await?;
    call(&c.client, &c.relay_url, &token, "account_bootstrap", None, json!({})).await?;
    let v = call(&c.client, &c.relay_url, &token, "node_claim", Some(&id.key), json!({})).await?;
    Ok(if v.get("already").and_then(Value::as_bool) == Some(true) { "這台電腦本來就在你的帳號底下".into() } else { "已把這台電腦連到你的帳號".into() })
}

/// 新電腦：替這台建節點、存好金鑰，然後重新啟動 ASN（重啟後就以新節點進入名單）
#[tauri::command]
pub async fn auth_setup_device(app: State<'_, App>, auth: State<'_, AuthState>, handle: AppHandle) -> Result<(), String> {
    if app.relay.is_some() {
        return Err("這台電腦已經有節點金鑰了".into());
    }
    let c = ctx()?;
    let token = auth.access_token(&c.client, &c.auth_base, &c.anon).await?;
    call(&c.client, &c.relay_url, &token, "account_bootstrap", None, json!({})).await?;
    let name = computer_name(|k| std::env::var(k).ok());
    let device_id = load_or_create_device_id(&app.data_dir)?;
    let v = call(&c.client, &c.relay_url, &token, "node_create", None, json!({ "name": name, "machine": name, "device_id": device_id })).await?;
    let id = v.get("id").and_then(Value::as_str).unwrap_or("");
    let key = v.get("key").and_then(Value::as_str).unwrap_or("");
    write_node_files(&identity::relay_home(), id, key, restrict_file)?;
    if app.shot.is_none() {
        // 晚一點再重啟，讓這個指令先把結果回給畫面
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_millis(600)).await;
            crate::cleanup(&handle);
            handle.restart();
        });
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 錯誤碼對映成中文() {
        assert!(error_text("tenant_not_yours").contains("舊"));
        assert!(error_text("already_claimed").contains("別的帳號"));
        assert!(error_text("whatever").contains("沒有接受"));
        assert!(error_text("unauthorized").contains("重新登入"));
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
    fn 名下節點比對() {
        let nodes = json!([{ "id": "H" }, { "id": "t5-x" }]);
        assert!(node_in_list(&nodes, "H") && !node_in_list(&nodes, "W") && !node_in_list(&Value::Null, "H"));
    }
}

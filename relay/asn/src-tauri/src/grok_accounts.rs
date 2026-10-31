//! Grok 帳號：讀目前登入、自動加入帳號庫、切換（做法與 Claude 帳號同一套，只是 Grok 的登入整份放在 ~/.grok/auth.json）。
//!
//! 帳號庫放在 ~/.asn/grok-accounts/<email>/auth.json（整份複製）。目前登入的 email 從 auth.json 裡那筆登入資料的 email 欄位讀；
//! 權杖與金鑰只做「整檔複製」，不解析、不印、不回報；回報與畫面都只有 email。
//! 切換：先把目前登入存回帳號庫（沒存過就先存，才不會切走遺失）、備份到 ~/.asn/grok-backup、再把目標那份整檔換進去。
//! 開著的 Grok 視窗還握著舊登入，要重開才會用新帳號（回傳的 notice 會說）。
use crate::claude_accounts::{email_dir_name, normalize_email, AutoOutcome, SwitchOutcome};
use serde::Serialize;
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

/// 與切換、加入、背景同步共用的一把鎖，避免同時寫檔
pub static LOCK: Mutex<()> = Mutex::new(());
const AUTH: &str = "auth.json";

#[derive(Serialize, Debug, PartialEq, Clone)]
pub struct GrokAccount {
    pub email: String,
    pub current: bool,
    /// 已經在帳號庫裡
    pub saved: bool,
}

pub fn grok_home() -> PathBuf {
    crate::envc::get_os("ASN_GROK_HOME").map(PathBuf::from).unwrap_or_else(crate::identity::home_dir)
}
fn auth_path(home: &Path) -> PathBuf {
    home.join(".grok").join(AUTH)
}
fn store_root(home: &Path) -> PathBuf {
    home.join(".asn").join("grok-accounts")
}
fn backup_path(home: &Path) -> PathBuf {
    home.join(".asn").join("grok-backup").join(AUTH)
}

/// 從 auth.json 的內容取出目前登入的 email：每一筆登入資料有 email 欄位；有好幾筆就取 create_time 最新的那筆。
/// 不是合法 JSON、沒有任何筆有合格 email，回 None。
pub fn email_of_auth(bytes: &[u8]) -> Option<String> {
    let v: Value = serde_json::from_slice(bytes).ok()?;
    let mut best: Option<(String, String)> = None;
    for e in v.as_object()?.values() {
        let Some(email) = e.get("email").and_then(Value::as_str).and_then(normalize_email) else { continue };
        let at = e.get("create_time").and_then(Value::as_str).unwrap_or("").to_string();
        if best.as_ref().map(|(t, _)| at > *t).unwrap_or(true) {
            best = Some((at, email));
        }
    }
    best.map(|(_, e)| e)
}

fn read_auth(home: &Path) -> Option<Vec<u8>> {
    std::fs::read(auth_path(home)).ok()
}
fn write_bytes(path: &Path, bytes: &[u8]) -> Result<(), String> {
    if let Some(p) = path.parent() {
        std::fs::create_dir_all(p).map_err(|e| e.to_string())?;
    }
    let tmp = PathBuf::from(format!("{}.{}.tmp", path.display(), std::process::id()));
    std::fs::write(&tmp, bytes).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, path).map_err(|e| e.to_string())
}

fn saved_emails(home: &Path) -> Vec<(String, PathBuf)> {
    let mut v = vec![];
    let Ok(rd) = std::fs::read_dir(store_root(home)) else { return v };
    for e in rd.flatten() {
        let f = e.path().join(AUTH);
        let Ok(b) = std::fs::read(&f) else { continue };
        if let Some(email) = email_of_auth(&b) {
            v.push((email, f));
        }
    }
    v.sort();
    v
}

/// 帳號庫清單（current＝目前登入的那個）
pub fn list(home: &Path) -> Vec<GrokAccount> {
    let cur = read_auth(home).and_then(|b| email_of_auth(&b));
    saved_emails(home).into_iter().map(|(email, _)| GrokAccount { current: cur.as_deref() == Some(email.as_str()), email, saved: true }).collect()
}

/// 目前登入（可能還沒進帳號庫）
pub fn current_login(home: &Path) -> Option<GrokAccount> {
    let email = email_of_auth(&read_auth(home)?)?;
    let saved = saved_emails(home).iter().any(|(e, _)| *e == email);
    Some(GrokAccount { email, current: true, saved })
}

/// 把目前登入整檔存進帳號庫（已在庫就覆蓋成最新）
pub fn save_current(home: &Path) -> Result<GrokAccount, String> {
    let bytes = read_auth(home).ok_or("Grok 目前沒有登入")?;
    let email = email_of_auth(&bytes).ok_or("目前登入的資料裡沒有 email，無法加入")?;
    write_bytes(&store_root(home).join(email_dir_name(&email)).join(AUTH), &bytes)?;
    Ok(GrokAccount { email, current: true, saved: true })
}

/// 做一次：目前登入不在庫就加入；在庫但內容和庫裡不同（權杖換新過）就回存；沒登入什麼都不動
pub fn auto_sync(home: &Path) -> Result<AutoOutcome, String> {
    let Some(bytes) = read_auth(home) else { return Ok(AutoOutcome::Nothing) };
    let Some(email) = email_of_auth(&bytes) else { return Ok(AutoOutcome::Nothing) };
    let target = store_root(home).join(email_dir_name(&email)).join(AUTH);
    match std::fs::read(&target) {
        Err(_) => {
            save_current(home)?;
            Ok(AutoOutcome::Added(email))
        }
        Ok(old) if old == bytes => Ok(AutoOutcome::Nothing),
        Ok(_) => {
            write_bytes(&target, &bytes)?;
            Ok(AutoOutcome::Updated(email))
        }
    }
}

/// 切換到帳號庫裡的某個帳號。已經是目前登入就什麼都不做（回成功）。
pub fn switch_to(home: &Path, email: &str) -> Result<SwitchOutcome, String> {
    let email = normalize_email(email).ok_or("email 格式不對")?;
    let target = saved_emails(home).into_iter().find(|(e, _)| *e == email).map(|(_, f)| f).ok_or("帳號庫裡沒有這個 Grok 帳號")?;
    let want = std::fs::read(&target).map_err(|e| format!("讀不到帳號庫裡的登入資料：{e}"))?;
    if email_of_auth(&want).as_deref() != Some(email.as_str()) {
        return Err("帳號庫裡的登入資料與 email 對不上，不切換".into());
    }
    if let Some(cur) = read_auth(home) {
        if cur == want {
            return Ok(SwitchOutcome { email, notice: "目前就是這個帳號".into() });
        }
        // 目前登入先留住：看得出 email 的先回存（沒存過就等於加入），再備份一份
        if email_of_auth(&cur).is_some() {
            save_current(home)?;
        }
        write_bytes(&backup_path(home), &cur)?;
    }
    write_bytes(&auth_path(home), &want)?;
    Ok(SwitchOutcome { email, notice: "已切換。開著的 Grok 視窗還在用舊帳號，請重開才會生效".into() })
}

/// 連續兩次看到完全相同的內容才動作（登入到一半不誤存）；指紋只留在記憶體
#[derive(Default)]
pub struct Steady(Option<u64>);
impl Steady {
    pub fn settled(&mut self, home: &Path) -> bool {
        use std::hash::{Hash, Hasher};
        let mut h = std::collections::hash_map::DefaultHasher::new();
        read_auth(home).hash(&mut h);
        let now = Some(h.finish());
        let ok = self.0 == now;
        self.0 = now;
        ok
    }
}

/// 拿著 LOCK 做一次 auto_sync
pub fn auto_tick(home: &Path) -> Result<AutoOutcome, String> {
    let _g = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    auto_sync(home)
}

/// 背景工作：先等 first，之後每 every 同步一次；有動作就叫 on_event
pub async fn auto_loop(first: std::time::Duration, every: std::time::Duration, on_event: impl Fn(&AutoOutcome) + Send + 'static) {
    tokio::time::sleep(first).await;
    let mut steady = Steady::default();
    loop {
        let mut st = std::mem::take(&mut steady);
        let r = tokio::task::spawn_blocking(move || {
            let home = grok_home();
            let out = if st.settled(&home) { auto_tick(&home).unwrap_or(AutoOutcome::Nothing) } else { AutoOutcome::Nothing };
            (out, st)
        })
        .await;
        if let Ok((out, st)) = r {
            steady = st;
            match &out {
                AutoOutcome::Added(e) => elog!("已自動加入 Grok 帳號 {e}"),
                AutoOutcome::Updated(e) => elog!("已更新 Grok 帳號 {e} 的登入資料"),
                AutoOutcome::Nothing | AutoOutcome::External(_) => {}
            }
            if out != AutoOutcome::Nothing {
                on_event(&out);
            }
        }
        tokio::time::sleep(every).await;
    }
}

/// 遠端回報用：帳號庫清單（拿著鎖）
pub fn local_list() -> Vec<GrokAccount> {
    let _g = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    list(&grok_home())
}
/// 遠端切換用
pub fn local_switch(email: &str) -> Result<SwitchOutcome, String> {
    let _g = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    switch_to(&grok_home(), email)
}

#[cfg_attr(feature = "gui", tauri::command)]
pub fn grok_accounts_list() -> Vec<GrokAccount> {
    local_list()
}
#[cfg_attr(feature = "gui", tauri::command)]
pub fn grok_account_current() -> Option<GrokAccount> {
    let _g = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    current_login(&grok_home())
}
#[cfg_attr(feature = "gui", tauri::command)]
pub fn grok_account_switch(email: String) -> Result<SwitchOutcome, String> {
    local_switch(&email)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn auth(email: &str, tok: &str, at: &str) -> String {
        format!(r#"{{"https://auth.x.ai::u-{email}":{{"key":"{tok}","email":"{email}","create_time":"{at}","refresh_token":"R-{tok}"}}}}"#)
    }
    fn login(h: &Path, email: &str, tok: &str) {
        let f = auth_path(h);
        std::fs::create_dir_all(f.parent().unwrap()).unwrap();
        std::fs::write(f, auth(email, tok, "2026-10-26T00:00:00Z")).unwrap();
    }
    fn cur_tok(h: &Path) -> String {
        std::fs::read_to_string(auth_path(h)).unwrap()
    }

    #[test]
    fn 讀得出目前登入的_email_多筆取最新_壞檔沒有() {
        assert_eq!(email_of_auth(auth("A@X.test", "t", "2026-01-01").as_bytes()), Some("a@x.test".into()));
        let two = r#"{"k1":{"email":"old@x.test","create_time":"2026-01-01"},"k2":{"email":"new@x.test","create_time":"2026-05-01"},"k3":{"no":"email"}}"#;
        assert_eq!(email_of_auth(two.as_bytes()), Some("new@x.test".into()));
        for bad in ["{壞", "[]", r#"{"k":{"email":"不是信箱"}}"#, r#"{"k":{"email":5}}"#, "{}"] {
            assert_eq!(email_of_auth(bad.as_bytes()), None, "{bad}");
        }
    }

    #[test]
    fn 自動加入_沒登入不動_新帳號加入_沒變不動_權杖換新回存() {
        let d = tempfile::tempdir().unwrap();
        let h = d.path();
        assert_eq!(auto_sync(h).unwrap(), AutoOutcome::Nothing);
        login(h, "a@x.test", "T1");
        assert_eq!(auto_sync(h).unwrap(), AutoOutcome::Added("a@x.test".into()));
        assert_eq!(list(h), vec![GrokAccount { email: "a@x.test".into(), current: true, saved: true }]);
        assert_eq!(auto_sync(h).unwrap(), AutoOutcome::Nothing);
        login(h, "a@x.test", "T2");
        assert_eq!(auto_sync(h).unwrap(), AutoOutcome::Updated("a@x.test".into()));
        let saved = std::fs::read_to_string(store_root(h).join("a@x.test").join(AUTH)).unwrap();
        assert!(saved.contains("T2"));
    }

    #[test]
    fn 切換_先回存目前的再換檔_備份一份_可切回來() {
        let d = tempfile::tempdir().unwrap();
        let h = d.path();
        login(h, "a@x.test", "TA");
        auto_sync(h).unwrap();
        login(h, "b@x.test", "TB");
        auto_sync(h).unwrap();
        assert_eq!(list(h).iter().filter(|a| a.current).map(|a| a.email.as_str()).collect::<Vec<_>>(), vec!["b@x.test"]);
        let out = switch_to(h, "a@x.test").unwrap();
        assert_eq!(out.email, "a@x.test");
        assert!(out.notice.contains("重開"));
        assert!(cur_tok(h).contains("TA") && !cur_tok(h).contains("TB"));
        assert!(std::fs::read_to_string(backup_path(h)).unwrap().contains("TB"), "切走前備份了原本的登入");
        switch_to(h, "b@x.test").unwrap();
        assert!(cur_tok(h).contains("TB"));
        assert_eq!(switch_to(h, "b@x.test").unwrap().notice, "目前就是這個帳號");
    }

    #[test]
    fn 切換_目前登入沒存過會先存起來_不會因為切走而遺失() {
        let d = tempfile::tempdir().unwrap();
        let h = d.path();
        login(h, "a@x.test", "TA");
        auto_sync(h).unwrap();
        login(h, "c@x.test", "TC"); // 新登入，還沒被自動加入
        switch_to(h, "a@x.test").unwrap();
        assert!(list(h).iter().any(|a| a.email == "c@x.test"), "被切走的新登入先進了帳號庫");
        switch_to(h, "c@x.test").unwrap();
        assert!(cur_tok(h).contains("TC"));
    }

    #[test]
    fn 切換_沒有這個帳號_格式不對_庫裡資料與信箱對不上_都不動目前登入() {
        let d = tempfile::tempdir().unwrap();
        let h = d.path();
        login(h, "a@x.test", "TA");
        auto_sync(h).unwrap();
        let before = cur_tok(h);
        assert!(switch_to(h, "nobody@x.test").is_err());
        assert!(switch_to(h, "不是信箱").is_err());
        // 庫裡那份被改成別人的登入：資料夾名是 b，內容 email 是 z
        let bad = store_root(h).join("b@x.test");
        std::fs::create_dir_all(&bad).unwrap();
        std::fs::write(bad.join(AUTH), auth("z@x.test", "TZ", "2026")).unwrap();
        assert!(switch_to(h, "b@x.test").is_err(), "資料夾名與內容 email 不同不能當 b");
        assert_eq!(cur_tok(h), before);
    }

    #[test]
    fn 登入到一半不誤存_連兩次相同才動作() {
        let d = tempfile::tempdir().unwrap();
        let h = d.path();
        let mut s = Steady::default();
        login(h, "a@x.test", "T1");
        assert!(!s.settled(h), "第一次看到不算穩定");
        assert!(s.settled(h));
        login(h, "a@x.test", "T2");
        assert!(!s.settled(h), "內容又變了就重新等");
    }

    #[test]
    fn 輸出與錯誤訊息裡沒有權杖() {
        let d = tempfile::tempdir().unwrap();
        let h = d.path();
        login(h, "a@x.test", "SECRET-TOKEN");
        auto_sync(h).unwrap();
        let shown = format!("{:?}{:?}{:?}", list(h), current_login(h), switch_to(h, "a@x.test"));
        assert!(!shown.contains("SECRET") && !shown.contains("R-"), "{shown}");
        let err = format!("{:?}", switch_to(h, "x@x.test"));
        assert!(!err.contains("SECRET"));
    }
}

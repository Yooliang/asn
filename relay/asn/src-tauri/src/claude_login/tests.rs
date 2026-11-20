//! #1880：實際登入的帳號只信讀回來的 email；切換不准假成功；帳號變了要立刻知道；讀不到要說讀不到。
//! 全部用暫存資料夾裡的假 `.claude.json`，不碰真實家目錄、不讀任何權杖檔。
use super::*;
use crate::claude_accounts;
use std::time::Duration;

fn cj(email: &str) -> String {
    format!("{{\n  \"numStartups\": 3,\n  \"oauthAccount\": {{\n    \"accountUuid\": \"u-{email}\",\n    \"emailAddress\": \"{email}\"\n  }}\n}}\n")
}
fn write(dir: &Path, text: &str) -> PathBuf {
    std::fs::create_dir_all(dir).unwrap();
    let p = dir.join(".claude.json");
    std::fs::write(&p, text).unwrap();
    p
}
fn login(home: &Path, email: &str, tag: &str) {
    std::fs::create_dir_all(home.join(".claude")).unwrap();
    std::fs::write(home.join(".claude").join(".credentials.json"), format!(r#"{{"claudeAiOauth":{{"accessToken":"FAKE-{tag}","refreshToken":"FAKE-REFRESH-{tag}","subscriptionType":"max"}}}}"#)).unwrap();
    write(home, &cj(email));
}
/// 家目錄裡有 a、b 兩個帳號在庫裡，現在登入的是 a
fn two_accounts() -> tempfile::TempDir {
    let home = tempfile::tempdir().unwrap();
    let h = home.path();
    login(h, "a@x.test", "A");
    claude_accounts::save_current(h).unwrap();
    login(h, "b@x.test", "B");
    claude_accounts::save_current(h).unwrap();
    login(h, "a@x.test", "A");
    home
}

#[test]
fn 讀登入檔_有帳號_沒登入_讀不到_是三件不同的事() {
    let d = tempfile::tempdir().unwrap();
    assert_eq!(read_login(&d.path().join(".claude.json")), Login::NotLoggedIn, "沒有檔案＝沒登入");
    assert_eq!(read_login(&write(d.path(), "{\"numStartups\":1}")), Login::NotLoggedIn, "沒有 oauthAccount＝沒登入");
    assert_eq!(read_login(&write(d.path(), &cj("A@X.test"))), Login::In("a@x.test".into()), "email 正規化");
    assert!(matches!(read_login(&write(d.path(), "{ 壞掉")), Login::Unreadable(_)), "壞檔不是沒登入");
    assert!(matches!(read_login(&write(d.path(), "{\"oauthAccount\":{\"accountUuid\":\"u\"}}")), Login::Unreadable(_)), "有帳號資訊卻沒 email＝讀不到");
}

#[test]
fn 讀不到的原因不含檔案內容() {
    let d = tempfile::tempdir().unwrap();
    let Login::Unreadable(why) = read_login(&write(d.path(), "{\"oauthAccount\":{\"accessToken\":\"SECRET-TOKEN-XYZ\"}}")) else { panic!() };
    assert!(!why.contains("SECRET"), "{why}");
}

#[test]
fn 讀哪一份_有設資料夾就以那邊為準_資料夾裡沒有才看家目錄() {
    let home = tempfile::tempdir().unwrap();
    let cfg = tempfile::tempdir().unwrap();
    assert_eq!(live_json_path(home.path(), None), home.path().join(".claude.json"));
    assert_eq!(live_json_path(home.path(), Some("".into())), home.path().join(".claude.json"), "空字串＝沒設");
    assert_eq!(live_json_path(home.path(), Some(cfg.path().into())), home.path().join(".claude.json"), "資料夾裡沒有 .claude.json");
    write(cfg.path(), &cj("c@x.test"));
    assert_eq!(live_json_path(home.path(), Some(cfg.path().into())), cfg.path().join(".claude.json"));
}

#[test]
fn 帳號變了才回報_讀不到同一個原因只報一次_恢復也報() {
    let mut t = Tracker::default();
    assert_eq!(t.observe(Login::In("a@x.test".into())), None, "第一次只記下來");
    assert_eq!(t.observe(Login::In("a@x.test".into())), None, "沒變不報");
    assert_eq!(t.observe(Login::In("b@x.test".into())), Some(Change::Email("b@x.test".into())), "email 變了要報");
    assert_eq!(t.observe(Login::Unreadable("x".into())), Some(Change::Unreadable("x".into())), "讀不到要報");
    assert_eq!(t.observe(Login::Unreadable("y".into())), None, "還是讀不到不重複報");
    assert_eq!(t.observe(Login::In("b@x.test".into())), Some(Change::Email("b@x.test".into())), "恢復要報，不沿用舊值");
    assert_eq!(t.observe(Login::NotLoggedIn), Some(Change::LoggedOut));
    let mut t2 = Tracker::default();
    assert_eq!(t2.observe(Login::Unreadable("x".into())), Some(Change::Unreadable("x".into())), "一開始就讀不到也要報");
}

#[test]
fn 檔案一變就收到通知_不用輪詢() {
    let d = tempfile::tempdir().unwrap();
    let p = write(d.path(), &cj("a@x.test"));
    let (tx, rx) = std::sync::mpsc::channel();
    let _h = start(p.clone(), Duration::from_millis(100), move |c| {
        let _ = tx.send(c);
    })
    .unwrap();
    std::thread::sleep(Duration::from_millis(300));
    std::fs::write(&p, cj("b@x.test")).unwrap();
    assert_eq!(rx.recv_timeout(Duration::from_secs(10)).unwrap(), Change::Email("b@x.test".into()));
    std::fs::write(&p, "{ 壞掉").unwrap();
    assert!(matches!(rx.recv_timeout(Duration::from_secs(10)).unwrap(), Change::Unreadable(_)), "讀不到要通知，不沿用舊值");
}

#[test]
fn 資料夾不存在時監看開不起來_回原因讓呼叫端記_log() {
    let d = tempfile::tempdir().unwrap();
    assert!(start(d.path().join("沒有這個資料夾").join(".claude.json"), Duration::from_millis(50), |_| {}).is_err());
}

#[test]
fn 切換回報成功但實際帳號沒換_要失敗() {
    // 帳號寫進家目錄的 .claude.json，但這台 Claude 實際用的是另一個設定資料夾（裡面還是 a）
    let home = two_accounts();
    let cfg = tempfile::tempdir().unwrap();
    write(cfg.path(), &cj("a@x.test"));
    let r = claude_accounts::switch_verified(home.path(), "b@x.test", Some(cfg.path().into()), Duration::ZERO);
    assert!(matches!(r, Err(claude_accounts::AccErr::NotSwitched)), "{r:?}");
    assert_eq!(r.unwrap_err().to_string(), SWITCH_FAILED_TEXT);
}

#[test]
fn 切換真的換了才算成功() {
    let home = two_accounts();
    let r = claude_accounts::switch_verified(home.path(), "b@x.test", None, Duration::ZERO).unwrap();
    assert_eq!(r.email, "b@x.test");
    assert_eq!(read_login(&home.path().join(".claude.json")), Login::In("b@x.test".into()));
}

#[test]
fn 切換之後又被寫回舊帳號_隔一下再讀要失敗() {
    let home = two_accounts();
    let p = home.path().join(".claude.json");
    let back = cj("a@x.test");
    let t = std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(500));
        std::fs::write(p, back).unwrap();
    });
    let r = claude_accounts::switch_verified(home.path(), "b@x.test", None, Duration::from_millis(1500));
    t.join().unwrap();
    assert!(matches!(r, Err(claude_accounts::AccErr::NotSwitched)), "{r:?}");
}

#[test]
fn 切換後登入檔讀不到_也是失敗() {
    let home = two_accounts();
    let cfg = tempfile::tempdir().unwrap();
    write(cfg.path(), "{ 壞掉");
    let r = claude_accounts::switch_verified(home.path(), "b@x.test", Some(cfg.path().into()), Duration::ZERO);
    assert!(matches!(r, Err(claude_accounts::AccErr::NotSwitched)), "{r:?}");
}

#[tokio::test]
async fn 叫醒之後帳號回報立刻再跑一次_不等下一輪() {
    let n = std::sync::Arc::new(std::sync::atomic::AtomicU32::new(0));
    let wake = std::sync::Arc::new(tokio::sync::Notify::new());
    let (n2, w2) = (n.clone(), wake.clone());
    let task = tokio::spawn(async move {
        let tick = || {
            let n3 = n2.clone();
            async move {
                n3.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                Ok::<(), String>(())
            }
        };
        crate::acct_remote::report_loop_with(&w2, Duration::from_millis(1), Duration::from_secs(3600), tick).await
    });
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(n.load(std::sync::atomic::Ordering::SeqCst), 1, "每一輪隔很久，沒人叫就只跑第一次");
    wake.notify_one();
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(n.load(std::sync::atomic::Ordering::SeqCst), 2, "叫一聲就立刻再報一次");
    task.abort();
}

#[test]
fn 帳號變了的通知接上回報與額度重查() {
    let src = include_str!("../claude_login.rs");
    let body = src.split("pub fn spawn_watch").nth(1).unwrap();
    assert!(body.contains("wake_report()") && body.contains("claude_quota::kick()"));
    let lib = include_str!("../lib.rs");
    assert!(lib.contains("claude_login::spawn_watch("), "啟動時要開監看");
}

#[test]
fn 畫面文字_讀不到與切換失敗_都是白話() {
    assert_eq!(UNREADABLE_TEXT, "讀不到目前登入的帳號");
    assert!(SWITCH_FAILED_TEXT.starts_with("切換沒有成功"));
    let js = include_str!("../../../ui/lib/claude-accounts.mjs");
    assert!(js.contains(&format!("CURRENT_UNREADABLE = '{UNREADABLE_TEXT}'")), "前端與 Rust 同一句");
}

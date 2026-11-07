use super::*;
#[cfg(windows)]
use crate::nowin::NoWindow;

const NOW: i64 = 1_793_000_000_000;
const MIN: i64 = 60_000;

fn login(dir: &Path) {
    std::fs::create_dir_all(dir).unwrap();
    std::fs::write(dir.join(CREDENTIALS), r#"{"claudeAiOauth":{"accessToken":"a","refreshToken":"r","expiresAt":1}}"#).unwrap();
}

fn oauth(expires: i64) -> Value {
    json!({ "accessToken": "a", "refreshToken": "r", "expiresAt": expires })
}

#[test]
fn no_folder_means_nothing() {
    let d = tempfile::tempdir().unwrap();
    assert!(dirs(d.path()).is_empty());
}

#[test]
fn lists_only_folders_with_login_inside_root() {
    let d = tempfile::tempdir().unwrap();
    login(&d.path().join(ROOT).join("b"));
    login(&d.path().join(ROOT).join("a"));
    std::fs::create_dir_all(d.path().join(ROOT).join("empty")).unwrap();
    std::fs::write(d.path().join(ROOT).join("file.txt"), "x").unwrap();
    assert_eq!(dirs(d.path()).iter().map(|x| x.0.as_str()).collect::<Vec<_>>(), ["a", "b"]);
}

#[test]
fn never_looks_at_normal_login_folder() {
    let d = tempfile::tempdir().unwrap();
    login(&d.path().join(".claude"));
    assert!(dirs(d.path()).is_empty());
}

#[cfg(windows)]
#[test]
fn junction_to_normal_login_is_skipped() {
    let d = tempfile::tempdir().unwrap();
    let normal = d.path().join(".claude");
    login(&normal);
    std::fs::create_dir_all(d.path().join(ROOT)).unwrap();
    let link = d.path().join(ROOT).join("link");
    let st = std::process::Command::new("cmd").no_window().args(["/c", "mklink", "/J"]).arg(&link).arg(&normal).output().unwrap();
    assert!(st.status.success(), "建不出測試用連結");
    assert!(link.join(CREDENTIALS).exists(), "連結真的通");
    assert!(dirs(d.path()).is_empty(), "指到外面的連結要跳過");
}

#[test]
fn caps_folder_count() {
    let d = tempfile::tempdir().unwrap();
    for i in 0..(MAX_DIRS + 2) {
        login(&d.path().join(ROOT).join(format!("d{i}")));
    }
    assert_eq!(dirs(d.path()).len(), MAX_DIRS);
}

#[test]
fn plan_reads_while_valid() {
    assert_eq!(plan(&oauth(NOW + 60 * MIN), NOW, true), Step::Read);
    assert_eq!(plan(&oauth(NOW + 60 * MIN), NOW, false), Step::Read);
}

#[test]
fn plan_refreshes_only_when_allowed() {
    assert_eq!(plan(&oauth(NOW + 5 * MIN), NOW, true), Step::Refresh);
    assert_eq!(plan(&oauth(NOW - MIN), NOW, true), Step::Refresh);
    assert_eq!(plan(&oauth(NOW + 5 * MIN), NOW, false), Step::Read, "開關關著：還沒到期照讀");
    assert_eq!(plan(&oauth(NOW - MIN), NOW, false), Step::Expired, "開關關著：到期就是到期，不換");
}

#[test]
fn plan_bad_login_is_expired() {
    assert_eq!(plan(&json!({}), NOW, false), Step::Expired);
    assert_eq!(plan(&Value::Null, NOW, true), Step::Expired);
    assert_eq!(plan(&json!({ "accessToken": "a", "expiresAt": NOW - MIN }), NOW, true), Step::Expired, "沒有 refresh token 換不了");
    assert_eq!(plan(&json!({ "accessToken": "a", "refreshToken": "r" }), NOW, false), Step::Expired, "讀不出到期時間不當有效");
}

fn raw() -> Value {
    json!({ "claudeAiOauth": { "accessToken": "old-a", "refreshToken": "old-r", "expiresAt": 1, "scopes": ["x"] }, "other": 1 })
}

#[test]
fn merged_keeps_other_fields() {
    let m = merged(&raw(), &json!({ "access_token": "new-a", "refresh_token": "new-r", "expires_in": 3600 }), NOW).unwrap();
    assert_eq!(m["other"], 1);
    assert_eq!(m[OAUTH_KEY]["scopes"], json!(["x"]));
    assert_eq!(m[OAUTH_KEY]["accessToken"], "new-a");
    assert_eq!(m[OAUTH_KEY]["refreshToken"], "new-r");
    assert_eq!(m[OAUTH_KEY]["expiresAt"], NOW + 3_600_000);
}

#[test]
fn merged_without_new_refresh_keeps_old() {
    let m = merged(&raw(), &json!({ "access_token": "new-a", "expires_in": 3600 }), NOW).unwrap();
    assert_eq!(m[OAUTH_KEY]["refreshToken"], "old-r");
}

#[test]
fn merged_rejects_incomplete_reply() {
    for got in [json!({}), json!({ "access_token": "" , "expires_in": 3600 }), json!({ "access_token": "a" }), json!({ "access_token": "a", "expires_in": 0 }), json!({ "access_token": "a", "expires_in": "3600" })] {
        assert!(merged(&raw(), &got, NOW).is_none(), "{got}");
    }
}

#[test]
fn write_atomic_replaces_and_leaves_no_temp() {
    let d = tempfile::tempdir().unwrap();
    let p = d.path().join(CREDENTIALS);
    std::fs::write(&p, "old").unwrap();
    write_atomic(&p, &json!({ "new": true })).unwrap();
    assert_eq!(std::fs::read_to_string(&p).unwrap(), r#"{"new":true}"#);
    assert_eq!(std::fs::read_dir(d.path()).unwrap().count(), 1);
}

#[test]
fn write_atomic_failure_keeps_old_file() {
    let d = tempfile::tempdir().unwrap();
    // 目標是資料夾：改名一定失敗
    let target = d.path().join("target");
    std::fs::create_dir_all(target.join("inside")).unwrap();
    assert!(write_atomic(&target, &json!({ "new": true })).is_err());
    assert!(target.join("inside").is_dir());
    let names: Vec<_> = std::fs::read_dir(d.path()).unwrap().map(|e| e.unwrap().file_name()).collect();
    assert_eq!(names, [std::ffi::OsString::from("target")], "暫存檔要清掉");
}

#[test]
fn usage_used_becomes_left() {
    let w = parse_usage(&json!({
        "five_hour": { "utilization": 81.0, "resets_at": "2026-11-04T19:00:00.827707+00:00" },
        "seven_day": { "utilization": 29, "resets_at": "2026-11-11T09:00:00Z" },
        "seven_day_opus": { "utilization": 99 },
    }), NOW);
    assert_eq!(w.iter().map(|x| (x["name"].as_str().unwrap(), x["left_pct"].as_u64().unwrap())).collect::<Vec<_>>(), [("five_hour", 19), ("weekly", 71)]);
    assert_eq!(w[0]["resets_at"], "2026-11-04T19:00:00Z");
}

#[test]
fn usage_missing_is_not_zero() {
    assert!(parse_usage(&json!({}), NOW).is_empty());
    assert!(parse_usage(&json!({ "five_hour": { "utilization": null } }), NOW).is_empty());
    assert!(parse_usage(&json!({ "five_hour": { "utilization": "81" } }), NOW).is_empty());
    assert!(parse_usage(&json!({ "five_hour": { "utilization": 130 } }), NOW).is_empty());
    let w = parse_usage(&json!({ "seven_day": { "utilization": 10, "resets_at": "2026-11-11T09:00:00+08:00" } }), NOW);
    assert_eq!(w[0]["resets_at"], Value::Null, "不是 UTC 不猜");
}

#[test]
fn stop_survives_restart_until_file_changes_or_cleared() {
    let d = tempfile::tempdir().unwrap();
    assert!(!is_stopped(d.path(), "a", Some(5)));
    add_stop(d.path(), "a", Some(5));
    assert!(is_stopped(d.path(), "a", Some(5)), "從檔案讀回來，重開也算");
    assert!(!is_stopped(d.path(), "a", Some(6)), "憑證檔變了就可以再試");
    assert!(!is_stopped(d.path(), "b", Some(5)), "別的資料夾不受影響");
    assert!(!is_stopped(d.path(), "a", None));
    clear_stops(d.path());
    assert!(!is_stopped(d.path(), "a", Some(5)));
}

#[tokio::test]
async fn expired_without_refresh_never_touches_file_or_network() {
    let d = tempfile::tempdir().unwrap();
    let dir = d.path().join(ROOT).join("a");
    login(&dir);
    let before = std::fs::read(dir.join(CREDENTIALS)).unwrap();
    let r = read_dir(d.path(), "a", &dir, false, NOW).await;
    assert_eq!(r.err(), Some(Failure::Auth));
    assert_eq!(std::fs::read(dir.join(CREDENTIALS)).unwrap(), before);
}

#[tokio::test]
async fn stopped_folder_does_not_refresh_even_if_allowed() {
    let d = tempfile::tempdir().unwrap();
    let dir = d.path().join(ROOT).join("a");
    login(&dir);
    add_stop(d.path(), "a", modified_ms(&dir));
    let before = std::fs::read(dir.join(CREDENTIALS)).unwrap();
    let r = read_dir(d.path(), "a", &dir, true, NOW).await;
    assert_eq!(r.err(), Some(Failure::Auth), "停了就當沒開換新：過期直接回，不連網");
    assert_eq!(std::fs::read(dir.join(CREDENTIALS)).unwrap(), before);
}

#[test]
fn source_only_mentions_its_own_folder() {
    let src = include_str!("../claude_extra.rs");
    let code = src.lines().filter(|l| !l.trim_start().starts_with("//")).collect::<Vec<_>>().join("\n");
    let stripped = code.replace(".claude-quota", "").replace("platform.claude.com", "");
    assert!(!stripped.contains(".claude"), "不能提到平常的登入資料夾");
    assert!(!code.contains("claude_home"));
    assert!(!code.contains("println!") && !code.contains("eprintln!") && !code.contains("log::"), "這裡有權杖，不印東西");
}

#[test]
fn lock_only_one_holder_and_released_on_drop() {
    let d = tempfile::tempdir().unwrap();
    let held = RefreshLock::take(d.path(), LOCK_STALE).unwrap();
    assert!(RefreshLock::take(d.path(), LOCK_STALE).is_none(), "另一個程式拿不到");
    drop(held);
    assert!(!d.path().join(LOCK).exists());
    assert!(RefreshLock::take(d.path(), LOCK_STALE).is_some(), "放掉就拿得到");
}

#[test]
fn stale_lock_is_taken_over() {
    let d = tempfile::tempdir().unwrap();
    std::fs::write(d.path().join(LOCK), "").unwrap();
    assert!(RefreshLock::take(d.path(), LOCK_STALE).is_none(), "還新的鎖不搶");
    assert!(RefreshLock::take(d.path(), std::time::Duration::ZERO).is_some(), "當掉留下的鎖可以接手");
}

#[tokio::test]
async fn locked_folder_does_not_refresh_and_is_not_a_stop() {
    let d = tempfile::tempdir().unwrap();
    let dir = d.path().join(ROOT).join("a");
    login(&dir);
    let _held = RefreshLock::take(&dir, LOCK_STALE).unwrap();
    let before = std::fs::read(dir.join(CREDENTIALS)).unwrap();
    let r = read_dir(d.path(), "a", &dir, true, NOW).await;
    assert_eq!(r.err(), Some(Failure::Other("另一個程式正在換新".into())), "不算登入失效，下一輪再看");
    assert!(!is_stopped(d.path(), "a", modified_ms(&dir)), "別人在換不算換新失敗");
    assert_eq!(std::fs::read(dir.join(CREDENTIALS)).unwrap(), before);
}

#[cfg(unix)]
#[test]
fn written_credentials_are_private() {
    use std::os::unix::fs::PermissionsExt;
    let d = tempfile::tempdir().unwrap();
    let p = d.path().join(CREDENTIALS);
    write_atomic(&p, &json!({})).unwrap();
    assert_eq!(std::fs::metadata(&p).unwrap().permissions().mode() & 0o777, 0o600);
}

#[test]
fn rename_retries_until_success() {
    let mut calls = 0;
    let r = retry_rename(5, std::time::Duration::ZERO, || {
        calls += 1;
        if calls < 3 { Err(std::io::Error::from(std::io::ErrorKind::PermissionDenied)) } else { Ok(()) }
    });
    assert!(r.is_ok());
    assert_eq!(calls, 3, "成功就不再試");
}

#[test]
fn rename_gives_up_after_limit() {
    let mut calls = 0;
    let r = retry_rename(5, std::time::Duration::ZERO, || {
        calls += 1;
        Err(std::io::Error::from(std::io::ErrorKind::PermissionDenied))
    });
    assert!(r.is_err());
    assert_eq!(calls, 5);
}

#[cfg(windows)]
#[test]
fn write_atomic_waits_for_briefly_locked_file() {
    use std::os::windows::fs::OpenOptionsExt;
    let d = tempfile::tempdir().unwrap();
    let p = d.path().join(CREDENTIALS);
    std::fs::write(&p, "old").unwrap();
    // 不開放刪除共用：跟防毒短暫開著檔案時一樣，改名會失敗
    let held = std::fs::OpenOptions::new().read(true).share_mode(1).open(&p).unwrap();
    let release = std::thread::spawn(move || {
        std::thread::sleep(RENAME_WAIT);
        drop(held);
    });
    write_atomic(&p, &json!({ "new": true })).unwrap();
    release.join().unwrap();
    assert_eq!(std::fs::read_to_string(&p).unwrap(), r#"{"new":true}"#);
}

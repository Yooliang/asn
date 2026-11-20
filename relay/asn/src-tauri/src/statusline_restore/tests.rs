use super::*;
use serde_json::json;

fn setup(settings: &str, orig: Option<&str>) -> (tempfile::TempDir, tempfile::TempDir) {
    let ch = tempfile::tempdir().unwrap();
    let ah = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(ch.path().join(".claude")).unwrap();
    std::fs::write(settings_path(ch.path()), settings).unwrap();
    if let Some(o) = orig {
        std::fs::write(orig_path(ah.path()), o).unwrap();
    }
    (ch, ah)
}
fn ours() -> String {
    format!(r#"if [ -f "x/asn-cli" ]; then "x/asn-cli" {MARK}; fi"#)
}
fn settings(cmd: &str) -> String {
    json!({ "theme": "dark", "statusLine": { "type": "command", "command": cmd }, "env": { "A": "1" } }).to_string()
}
fn read(ch: &tempfile::TempDir) -> Value {
    serde_json::from_str(&std::fs::read_to_string(settings_path(ch.path())).unwrap()).unwrap()
}

#[test]
fn 升級還原_只動_asn_寫的那一條_有原指令就寫回_其他鍵不動_並先備份() {
    let before = settings(&ours());
    let (ch, ah) = setup(&before, Some("echo 原本的狀態列"));
    assert_eq!(restore(ch.path(), ah.path()), Ok(Restored::Done));
    let v = read(&ch);
    assert_eq!(v["statusLine"]["command"], "echo 原本的狀態列");
    assert_eq!((v["theme"].as_str(), v["env"]["A"].as_str()), (Some("dark"), Some("1")));
    assert_eq!(std::fs::read_to_string(bak_path(ch.path())).unwrap(), before, "備份是還原前的原文");
    assert!(orig_path(ah.path()).exists(), "原指令檔保留一版");
}

#[test]
fn 升級還原_原本沒有狀態列就整個拿掉() {
    let (ch, ah) = setup(&settings(&ours()), None);
    assert_eq!(restore(ch.path(), ah.path()), Ok(Restored::Done));
    assert!(read(&ch).get("statusLine").is_none());
    assert_eq!(read(&ch)["theme"], "dark");
}

#[test]
fn 升級還原_使用者自己的狀態列或沒有狀態列_完全不碰() {
    let mine = settings("echo 我自己的");
    let (ch, ah) = setup(&mine, Some("echo x"));
    assert_eq!(restore(ch.path(), ah.path()), Ok(Restored::Nothing));
    assert_eq!(std::fs::read_to_string(settings_path(ch.path())).unwrap(), mine);
    assert!(!bak_path(ch.path()).exists(), "沒動就不備份");
    let (ch, ah) = setup(r#"{"theme":"dark"}"#, None);
    assert_eq!(restore(ch.path(), ah.path()), Ok(Restored::Nothing));
    let ch2 = tempfile::tempdir().unwrap();
    assert_eq!(restore(ch2.path(), ah.path()), Ok(Restored::Nothing), "連 settings.json 都沒有");
    assert!(!settings_path(ch2.path()).exists(), "不會憑空建出檔案");
}

#[test]
fn 升級還原_失敗時保留原狀_壞掉的設定檔與備份寫不進去() {
    let (ch, ah) = setup("{壞掉", None);
    assert!(restore(ch.path(), ah.path()).is_err());
    assert_eq!(std::fs::read_to_string(settings_path(ch.path())).unwrap(), "{壞掉");
    let before = settings(&ours());
    let (ch, ah) = setup(&before, Some("echo x"));
    std::fs::create_dir(bak_path(ch.path())).unwrap(); // 備份寫不進去
    assert!(restore(ch.path(), ah.path()).is_err());
    assert_eq!(std::fs::read_to_string(settings_path(ch.path())).unwrap(), before, "備份失敗就不動");
}

#[test]
fn 還原後再跑一次不會再動() {
    let (ch, ah) = setup(&settings(&ours()), Some("echo x"));
    assert_eq!(restore(ch.path(), ah.path()), Ok(Restored::Done));
    assert_eq!(restore(ch.path(), ah.path()), Ok(Restored::Nothing));
}

#[test]
fn 還沒還原前_串接還在_沒有原指令就什麼都不輸出_結束碼_0() {
    let ah = tempfile::tempdir().unwrap();
    assert_eq!(run_original(ah.path(), b"{}"), (Vec::new(), 0));
}

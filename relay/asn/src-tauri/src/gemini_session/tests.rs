use super::*;

fn snapshot(dir: &Path) -> Vec<(PathBuf, Vec<u8>)> {
    let mut out = vec![];
    if let Ok(rd) = std::fs::read_dir(dir) {
        for e in rd.flatten() {
            let p = e.path();
            if p.is_dir() {
                out.extend(snapshot(&p));
            } else {
                out.push((p.clone(), std::fs::read(&p).unwrap()));
            }
        }
    }
    out.sort();
    out
}

#[test]
fn 使用者設定整份保留_只換掉_statusline_順序不變() {
    let user = r#"{"model":"gemini-x","theme":"dark","statusLine":{"type":"command","command":"my.cmd","padding":1},"trustedFolders":["D:/a"]}"#;
    let v = session_settings(Some(user), "\"C:/asn/gemini-statusline.cmd\"");
    let keys: Vec<&String> = v.as_object().unwrap().keys().collect();
    assert_eq!(keys, ["model", "theme", "statusLine", "trustedFolders"]);
    assert_eq!(v["model"], "gemini-x");
    assert_eq!(v["trustedFolders"], json!(["D:/a"]));
    assert_eq!(v["statusLine"], json!({ "type": "command", "command": "\"C:/asn/gemini-statusline.cmd\"", "enabled": true, "stack_with_default": true, "padding": 1 }));
}

#[test]
fn 使用者設定沒有_壞掉_不是物件_就只放_statusline() {
    for u in [None, Some(""), Some("壞掉{"), Some("[1,2]"), Some("\"x\"")] {
        let v = session_settings(u, "c");
        assert_eq!(v.as_object().unwrap().keys().collect::<Vec<_>>(), ["statusLine"], "{u:?}");
    }
    let v = session_settings(Some("\u{feff}{\"a\":1}"), "c");
    assert_eq!(v["a"], 1, "開頭的 BOM 不影響");
}

#[test]
fn cmd_包一層_路徑加引號_不用括號區塊_找不到_asn_cli_也印一行() {
    let cli = r"C:\Program Files (x86)\ASN\asn-cli.exe";
    let s = cmd_script(cli);
    assert!(s.starts_with("@echo off\r\n"));
    assert!(s.contains("if not exist \"C:\\Program Files (x86)\\ASN\\asn-cli.exe\" goto none\r\n"));
    assert!(s.contains("\"C:\\Program Files (x86)\\ASN\\asn-cli.exe\" gemini-quota\r\n"));
    assert!(s.contains(":none\r\necho Gemini\r\n"));
    assert!(!s.contains(" (\r\n") && !s.contains(") else ("), "不能用括號區塊（路徑裡的 (x86) 會讓 cmd 解析錯）");
    assert_eq!(statusline_command(cli, r"C:\Users\A B\.asn\gemini-statusline.cmd", true), "\"C:\\Users\\A B\\.asn\\gemini-statusline.cmd\"");
    assert_eq!(statusline_command("/opt/a'b/asn-cli", "", false), "if [ -x '/opt/a'\\''b/asn-cli' ]; then '/opt/a'\\''b/asn-cli' gemini-quota; else echo Gemini; fi");
}

#[test]
fn 準備參數_只寫_asn_資料夾_使用者的_agy_設定一個位元組都不動() {
    let home = tempfile::tempdir().unwrap();
    let asn = tempfile::tempdir().unwrap();
    let user = user_settings_path(home.path());
    std::fs::create_dir_all(user.parent().unwrap()).unwrap();
    std::fs::write(&user, r#"{"model":"m","statusLine":{"type":"command","command":"mine"}}"#).unwrap();
    let before = snapshot(home.path());
    let cli = asn.path().join("asn-cli.exe");
    let args = prepare(home.path(), asn.path(), &cli, true).unwrap();
    assert_eq!(snapshot(home.path()), before, "家目錄底下（含 ~/.gemini）完全沒變");
    assert_eq!(args.len(), 2);
    assert_eq!(args[0], "--settings");
    let out = PathBuf::from(&args[1]);
    assert!(out.starts_with(asn.path()));
    let v: Value = serde_json::from_str(&std::fs::read_to_string(&out).unwrap()).unwrap();
    assert_eq!(v["model"], "m");
    let cmd = asn.path().join("gemini-statusline.cmd");
    assert_eq!(v["statusLine"]["command"], format!("\"{}\"", cmd.to_string_lossy()));
    assert_eq!(std::fs::read_to_string(&cmd).unwrap(), cmd_script(&cli.to_string_lossy()));
    // 再準備一次：內容一樣就不重寫
    let t1 = std::fs::metadata(&out).unwrap().modified().unwrap();
    std::thread::sleep(std::time::Duration::from_millis(20));
    prepare(home.path(), asn.path(), &cli, true).unwrap();
    assert_eq!(std::fs::metadata(&out).unwrap().modified().unwrap(), t1);
}

#[test]
fn 使用者沒有_agy_設定時不會建出_gemini_資料夾() {
    let home = tempfile::tempdir().unwrap();
    let asn = tempfile::tempdir().unwrap();
    prepare(home.path(), asn.path(), &asn.path().join("asn-cli"), false).unwrap();
    assert!(!home.path().join(".gemini").exists());
    assert!(!asn.path().join("gemini-statusline.cmd").exists(), "非 Windows 不寫 .cmd");
}

#[test]
fn 路徑含引號_百分比_控制字元就不接() {
    let home = tempfile::tempdir().unwrap();
    let asn = tempfile::tempdir().unwrap();
    for bad in ["C:/a%PATH%/asn-cli.exe", "C:/a\"b/asn-cli.exe", "C:/a\nb/asn-cli.exe", ""] {
        assert!(prepare(home.path(), asn.path(), Path::new(bad), true).is_err(), "{bad:?}");
    }
    assert!(snapshot(asn.path()).is_empty(), "拒絕時什麼都不寫");
}

#[test]
fn 守門_不寫使用者的_agy_設定檔() {
    let src = include_str!("../gemini_session.rs");
    let body = src.split("#[cfg(test)]").next().unwrap_or("");
    // 寫檔只有 write_if_changed 一個地方，而且只拿 asn_home 底下的路徑
    assert_eq!(body.matches("write_atomic(").count(), 1);
    assert_eq!(body.matches("write_if_changed(&").count(), 2);
    assert!(body.contains("write_if_changed(&cmd_path") && body.contains("write_if_changed(&out"));
    assert!(!body.contains(&["std::fs::", "write("].concat()));
}

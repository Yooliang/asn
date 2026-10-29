use super::*;
use std::path::PathBuf;

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

const SHORT: &str = r"C:\Users\ABCDEF~1\.asn\GEMINI~1.CMD";

#[test]
fn 設定只有_statusline_一個鍵() {
    let v = session_settings(SHORT);
    assert_eq!(v.as_object().unwrap().keys().collect::<Vec<_>>(), ["statusLine"]);
    assert_eq!(v["statusLine"], json!({ "type": "command", "command": SHORT, "enabled": true, "stack_with_default": true }));
}

#[test]
fn 短路徑判斷_正常的才當指令_含空白或特殊字元就不接() {
    assert_eq!(cmd_command(SHORT).as_deref(), Some(SHORT));
    assert_eq!(cmd_command(r"C:\Users\a\.asn\gemini-statusline.cmd").as_deref(), Some(r"C:\Users\a\.asn\gemini-statusline.cmd"), "本來就沒空白的長路徑可用");
    // 磁碟關了 8.3：GetShortPathNameW 回原本的長路徑，有空白、特殊字元就不能用
    for bad in [
        r"C:\Users\A B\.asn\gemini-statusline.cmd",
        "C:\\Users\\A\u{3000}B\\.asn\\x.cmd",
        "C:\\Users\\A\tB\\x.cmd",
        r"C:\Program Files (x86)\ASN\x.cmd",
        r"C:\a&b\x.cmd",
        r"C:\a^b\x.cmd",
        r"C:\a(b\x.cmd",
        r"C:\a)b\x.cmd",
        r"C:\a<b\x.cmd",
        r"C:\a>b\x.cmd",
        r"C:\a|b\x.cmd",
        r"C:\a%b%\x.cmd",
        r"C:\a!b\x.cmd",
        r#"C:\a"b\x.cmd"#,
        r#""C:\a\x.cmd""#,
        "C:\\a\nb\\x.cmd",
        "",
    ] {
        assert_eq!(cmd_command(bad), None, "{bad:?}");
    }
}

#[test]
fn cmd_包一層_asn_cli_路徑加引號不轉短路徑_不用括號區塊_找不到也印一行() {
    let cli = r"C:\Program Files (x86)\ASN\asn-cli.exe";
    let s = cmd_script(cli);
    assert!(s.starts_with("@echo off\r\n"));
    assert!(s.contains("if not exist \"C:\\Program Files (x86)\\ASN\\asn-cli.exe\" goto none\r\n"));
    assert!(s.contains("\"C:\\Program Files (x86)\\ASN\\asn-cli.exe\" gemini-quota\r\n"));
    assert!(s.contains(":none\r\necho Gemini\r\n"));
    assert!(!s.contains(" (\r\n") && !s.contains(") else ("), "不能用括號區塊（路徑裡的 (x86) 會讓 cmd 解析錯）");
    assert_eq!(sh_command("/opt/a'b/asn-cli"), "if [ -x '/opt/a'\\''b/asn-cli' ]; then '/opt/a'\\''b/asn-cli' gemini-quota; else echo Gemini; fi");
}

#[test]
fn 準備參數_windows_先寫好_cmd_再轉短路徑_指令不加引號_內容一樣不重寫() {
    let asn = tempfile::tempdir().unwrap();
    let cli = PathBuf::from(r"C:\Program Files\ASN\asn-cli.exe");
    let cmd = asn.path().join("gemini-statusline.cmd");
    let seen = std::cell::RefCell::new(None);
    let shorten = |p: &Path| {
        assert!(p.is_file(), "轉短路徑前 .cmd 要先寫好（短路徑只認得存在的檔）");
        *seen.borrow_mut() = Some(p.to_path_buf());
        Some(SHORT.to_string())
    };
    let args = prepare_with(asn.path(), &cli, true, shorten).unwrap();
    assert_eq!(seen.borrow().as_deref(), Some(cmd.as_path()));
    assert_eq!(args.len(), 2);
    assert_eq!(args[0], "--settings");
    let out = PathBuf::from(&args[1]);
    assert!(out.starts_with(asn.path()));
    let v: Value = serde_json::from_str(&std::fs::read_to_string(&out).unwrap()).unwrap();
    assert_eq!(v, session_settings(SHORT));
    assert!(!v["statusLine"]["command"].as_str().unwrap().contains('"'), "指令不能有引號");
    assert_eq!(std::fs::read_to_string(&cmd).unwrap(), cmd_script(&cli.to_string_lossy()), ".cmd 裡是 asn-cli 的長路徑加引號");
    let t1 = std::fs::metadata(&out).unwrap().modified().unwrap();
    std::thread::sleep(std::time::Duration::from_millis(20));
    prepare_with(asn.path(), &cli, true, |_| Some(SHORT.to_string())).unwrap();
    assert_eq!(std::fs::metadata(&out).unwrap().modified().unwrap(), t1, "內容一樣就不重寫");
}

#[test]
fn 轉不出短路徑_或回原長路徑仍有空白特殊字元_就不帶_settings() {
    let asn = tempfile::tempdir().unwrap();
    let cli = asn.path().join("asn-cli.exe");
    let e = prepare_with(asn.path(), &cli, true, |_| None).unwrap_err();
    assert!(e.contains("轉不出"), "{e}");
    for long in [r"C:\Users\A B\.asn\gemini-statusline.cmd", r"C:\Users\a&b\.asn\gemini-statusline.cmd", r"C:\Users\a(1)\.asn\gemini-statusline.cmd", r"C:\Users\a^b\.asn\gemini-statusline.cmd"] {
        let e = prepare_with(asn.path(), &cli, true, |_| Some(long.to_string())).unwrap_err();
        assert!(e.contains("短路徑仍含"), "{long:?}: {e}");
    }
    assert!(!asn.path().join("gemini-session-settings.json").exists(), "不接時不寫設定檔");
}

#[test]
fn 非_windows_不寫_cmd_也不轉短路徑() {
    let asn = tempfile::tempdir().unwrap();
    let cli = asn.path().join("asn-cli");
    let args = prepare_with(asn.path(), &cli, false, |_| panic!("非 Windows 不該轉短路徑")).unwrap();
    assert!(!asn.path().join("gemini-statusline.cmd").exists());
    let v: Value = serde_json::from_str(&std::fs::read_to_string(&args[1]).unwrap()).unwrap();
    assert_eq!(v, session_settings(&sh_command(&cli.to_string_lossy())));
}

#[test]
fn asn_cli_路徑含引號_百分比_控制字元就不接_什麼都不寫() {
    let asn = tempfile::tempdir().unwrap();
    for bad in ["C:/a%PATH%/asn-cli.exe", "C:/a\"b/asn-cli.exe", "C:/a\nb/asn-cli.exe", ""] {
        assert!(prepare_with(asn.path(), Path::new(bad), true, |_| Some(SHORT.to_string())).is_err(), "{bad:?}");
    }
    assert!(snapshot(asn.path()).is_empty(), "拒絕時什麼都不寫");
}

#[cfg(windows)]
#[test]
fn 真的短路徑_存在的檔轉得出來_不存在的轉不出來() {
    let asn = tempfile::tempdir().unwrap();
    let p = asn.path().join("gemini-statusline.cmd");
    std::fs::write(&p, "x").unwrap();
    let s = short_path(&p).expect("存在的檔要轉得出來");
    assert!(Path::new(&s).is_file());
    assert_eq!(short_path(&asn.path().join("not-here.cmd")), None);
}

#[test]
fn 守門_不讀不寫使用者的_agy_設定檔() {
    let src = include_str!("../gemini_session.rs");
    let body = src.split("#[cfg(test)]").next().unwrap_or("");
    // 不再碰使用者家目錄：沒有 home 參數、不組 ~/.gemini 路徑
    assert!(!body.contains("join(\".gemini\")") && !body.contains("home_dir()"), "不能讀使用者的 agy 設定");
    assert!(!body.contains("(home: &Path") && !body.contains(" home: &Path"), "只有 asn_home，沒有使用者的 home");
    // 寫檔只有 write_if_changed 一個地方，而且只拿 asn_home 底下的路徑
    assert_eq!(body.matches("write_atomic(").count(), 1);
    assert_eq!(body.matches("write_if_changed(&").count(), 2);
    assert!(body.contains("write_if_changed(&cmd_path") && body.contains("write_if_changed(&out"));
    assert!(!body.contains(&["std::fs::", "write("].concat()));
    // 讀檔只有 write_if_changed 比對自己寫的檔
    assert_eq!(body.matches("read_to_string(").count(), 1);
}

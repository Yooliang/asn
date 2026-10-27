use super::*;
use tempfile::TempDir;

fn setup(settings: Option<&str>) -> (TempDir, PathBuf, PathBuf, PathBuf) {
    let d = TempDir::new().unwrap();
    let home = d.path().join("home");
    let asn = d.path().join("asn");
    std::fs::create_dir_all(home.join(".claude")).unwrap();
    std::fs::create_dir_all(&asn).unwrap();
    if let Some(s) = settings {
        std::fs::write(settings_path(&home), s).unwrap();
    }
    let cli = d.path().join("ASN").join("asn-cli.exe");
    (d, home, asn, cli)
}

fn read(home: &Path) -> Value {
    serde_json::from_str(&std::fs::read_to_string(settings_path(home)).unwrap()).unwrap()
}

const ORCA: &str = r#"{"zeta":1,"statusLine":{"type":"command","command":"echo 'orca \"x\"' && cat","padding":2},"alpha":{"k":[1,2]}}"#;

#[test]
fn 沒有設定檔也能接上_取消後不留狀態列() {
    let (_d, home, asn, cli) = setup(None);
    assert_eq!(status(&home, &asn, &cli).state, "off");
    connect(&home, &asn, &cli).unwrap();
    assert_eq!(status(&home, &asn, &cli).state, "on");
    assert!(command_of(&read(&home)).unwrap().contains(MARK));
    disconnect(&home, &asn).unwrap();
    assert!(read(&home).get("statusLine").is_none());
    assert_eq!(status(&home, &asn, &cli).state, "off");
}

#[test]
fn 接上只改指令欄位_其他鍵與順序保留_取消後原指令一字不差() {
    let (_d, home, asn, cli) = setup(Some(ORCA));
    connect(&home, &asn, &cli).unwrap();
    let v = read(&home);
    let keys: Vec<_> = v.as_object().unwrap().keys().cloned().collect();
    assert_eq!(keys, ["zeta", "statusLine", "alpha"], "鍵的順序不變");
    assert_eq!(v["alpha"], json!({"k":[1,2]}));
    assert_eq!(v["statusLine"]["padding"], 2, "statusLine 裡別的鍵保留");
    assert_eq!(std::fs::read_to_string(orig_path(&asn)).unwrap(), "echo 'orca \"x\"' && cat");
    assert!(bak_path(&home).exists(), "原設定檔另存一份");
    disconnect(&home, &asn).unwrap();
    let back = read(&home);
    assert_eq!(back, serde_json::from_str::<Value>(ORCA).unwrap());
    assert!(!orig_path(&asn).exists());
}

#[test]
fn 重複接上不會把我們自己的指令存成原指令() {
    let (_d, home, asn, cli) = setup(Some(ORCA));
    connect(&home, &asn, &cli).unwrap();
    connect(&home, &asn, &cli).unwrap();
    assert_eq!(std::fs::read_to_string(orig_path(&asn)).unwrap(), "echo 'orca \"x\"' && cat");
}

#[test]
fn 路徑對不上是stale_重新接上只換路徑_原指令不動() {
    let (d, home, asn, cli) = setup(Some(ORCA));
    connect(&home, &asn, &cli).unwrap();
    let cli2 = d.path().join("moved").join("asn-cli.exe");
    assert_eq!(status(&home, &asn, &cli2).state, "stale");
    connect(&home, &asn, &cli2).unwrap();
    assert_eq!(status(&home, &asn, &cli2).state, "on");
    assert_eq!(std::fs::read_to_string(orig_path(&asn)).unwrap(), "echo 'orca \"x\"' && cat");
}

#[test]
fn 別人改過就不動它() {
    let (_d, home, asn, cli) = setup(Some(ORCA));
    connect(&home, &asn, &cli).unwrap();
    let mut v = read(&home);
    v["statusLine"]["command"] = json!("echo someone-else");
    std::fs::write(settings_path(&home), serde_json::to_string(&v).unwrap()).unwrap();
    assert!(disconnect(&home, &asn).is_err());
    assert_eq!(command_of(&read(&home)), Some("echo someone-else"));
}

#[test]
fn 狀態列不是指令型或設定檔壞掉_不動() {
    let (_d, home, asn, cli) = setup(Some(r#"{"statusLine":{"type":"static","text":"x"}}"#));
    assert_eq!(status(&home, &asn, &cli).state, "blocked");
    assert!(connect(&home, &asn, &cli).is_err());
    let (_d2, home2, asn2, cli2) = setup(Some("{ not json"));
    assert!(connect(&home2, &asn2, &cli2).is_err());
    assert_eq!(std::fs::read_to_string(settings_path(&home2)).unwrap(), "{ not json", "壞檔原樣不動");
}

#[test]
fn 指令含空白路徑與反斜線時用正斜線加引號() {
    let c = command_for(Path::new(r"C:\Users\A B\AppData\Local\ASN\asn-cli.exe"), Path::new(r"C:\Users\A B\.asn"));
    assert!(c.contains("\"C:/Users/A B/AppData/Local/ASN/asn-cli.exe\" claude-quota --chain"));
    assert!(c.contains("bash \"C:/Users/A B/.asn/statusline-orig.sh\""), "asn-cli 不在時直接跑原指令");
    assert!(!c.contains("\\"));
}

fn have_bash() -> bool {
    shell_candidates().iter().any(|p| Command::new(p).no_window().arg("-c").arg("exit 0").status().map(|s| s.success()).unwrap_or(false))
}

#[test]
fn chain沒有原指令就什麼都不輸出() {
    let (_d, _h, asn, _c) = setup(None);
    assert_eq!(run_original(&asn, b"x"), (Vec::new(), 0));
}

#[test]
fn chain把同一份輸入餵給原指令並原樣輸出() {
    if !have_bash() {
        return;
    }
    let (_d, _h, asn, _c) = setup(None);
    std::fs::write(orig_path(&asn), "cat; echo -n '|tail'").unwrap();
    let (out, code) = run_original(&asn, b"hello");
    assert_eq!(String::from_utf8_lossy(&out), "hello|tail");
    assert_eq!(code, 0);
}

#[test]
fn chain原指令卡住會在逾時後被砍掉_輸出過大會截斷() {
    if !have_bash() {
        return;
    }
    let (_d, _h, asn, _c) = setup(None);
    std::fs::write(orig_path(&asn), "echo partial; sleep 20").unwrap();
    let t = Instant::now();
    let (out, _) = run_original(&asn, b"");
    assert!(t.elapsed() < Duration::from_secs(6), "不能被卡住的原指令拖住");
    assert!(String::from_utf8_lossy(&out).contains("partial"), "逾時前印出的部分保留");
    std::fs::write(orig_path(&asn), "yes aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa | head -c 100000").unwrap();
    let (big, _) = run_original(&asn, b"");
    assert!(big.len() <= CHAIN_OUT_MAX, "輸出上限 4 KB，實際 {}", big.len());
}

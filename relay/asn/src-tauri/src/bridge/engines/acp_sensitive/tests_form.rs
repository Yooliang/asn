//! 敏感位置判定的測試（續）：路徑形式變體、清單、正式路徑建立清單。
//! 測試只用暫存資料夾裡的假家目錄與假檔案，不碰真的使用者資料夾；Windows 的網路與裝置寫法也只指向暫存資料夾。
use super::*;
use serde_json::json;

struct Rig {
    _d: tempfile::TempDir,
    home: PathBuf,
    work: PathBuf,
    roots: SensitiveRoots,
}

fn rig_with(env: &[(String, String)]) -> Rig {
    let d = tempfile::tempdir().unwrap();
    let home = d.path().join("home");
    let work = d.path().join("work");
    std::fs::create_dir_all(&home).unwrap();
    std::fs::create_dir_all(&work).unwrap();
    let roots = SensitiveRoots::build(&[home.clone()], env);
    Rig { _d: d, home, work, roots }
}
fn rig() -> Rig {
    rig_with(&[])
}
fn verdict(r: &Rig, p: &str, tool: ReadTool) -> ReadVerdict {
    read_verdict(p, &ReadCtx { roots: &r.roots, base: &r.work, tool })
}
fn blocked(r: &Rig, p: &str) -> bool {
    verdict(r, p, ReadTool::Single) != ReadVerdict::Allow
}
fn ps(p: &Path) -> String {
    p.display().to_string()
}
fn kv(v: &[(&str, &str)]) -> Vec<(String, String)> {
    v.iter().map(|(a, b)| (a.to_string(), b.to_string())).collect()
}

#[test]
fn 路徑形式變體_網路與裝置寫法_純字串判斷() {
    let local = vec!["localhost".to_string(), "127.0.0.1".to_string(), "mypc".to_string()];
    // 看不出實際指向哪裡的：磁碟機以外的裝置前綴、別台主機的管理共用
    for p in [
        r"\\?\UNC\localhost\C$\a",
        r"\\?\UNC\mypc\C$\a",
        r"\\?\Volume{00000000-0000-0000-0000-000000000000}\a",
        r"\\.\Volume{00000000-0000-0000-0000-000000000000}\a",
        r"\\.\HarddiskVolume3\a",
        r"\\?\GLOBALROOT\Device\x\a",
        r"\\.\GLOBALROOT\Device\x\a",
        r"\\other-host\C$\a",
        "//?/UNC/localhost/C$/a",
    ] {
        assert!(opaque_device_path(p, &local), "{p}");
    }
    // 一般寫法：磁碟機、指向本機的管理共用、一般共用、一般路徑
    for p in [r"\\?\C:\a", r"\\.\C:\a", r"\\?\C:", r"\\localhost\C$\a", r"\\MyPC\D$\a", r"\\other-host\share\a", r"C:\a", "/etc/x", "relative/a", ""] {
        assert!(!opaque_device_path(p, &local), "{p}");
    }
}

#[cfg(windows)]
#[test]
fn 路徑形式變體_網路與裝置寫法_windows() {
    let r0 = rig();
    let h = ps(&r0.home);
    let drive = h[..1].to_string();
    let rest = h[2..].trim_start_matches('\\').to_string();
    let name = std::env::var("COMPUTERNAME").unwrap_or_else(|_| "localhost".into());
    let r = rig_with(&kv(&[("COMPUTERNAME", &name)]));
    let h = ps(&r.home);
    let rest = if h[2..].trim_start_matches('\\') == rest { rest } else { h[2..].trim_start_matches('\\').to_string() };
    // 目標都是測試自己的暫存資料夾：一般寫法與本機主機名的寫法都要判成敏感
    let fake = r.home.join(".ssh").join("id");
    std::fs::create_dir_all(r.home.join(".ssh")).unwrap();
    std::fs::write(&fake, "x").unwrap();
    for host in ["localhost", "127.0.0.1", name.as_str()] {
        let p = format!(r"\\{host}\{drive}$\{rest}\.ssh\id");
        assert_eq!(verdict(&r, &p, ReadTool::Single), ReadVerdict::Sensitive, "{p}");
        let fake_url = format!("file://{host}/{drive}$/{}/.ssh/id", rest.replace('\\', "/"));
        assert_eq!(verdict(&r, &fake_url, ReadTool::Single), ReadVerdict::Sensitive, "{fake_url}");
    }
    // 磁碟機前綴的寫法：敏感的擋、一般的放行
    assert_eq!(verdict(&r, &format!(r"\\?\{h}\.ssh\id"), ReadTool::Single), ReadVerdict::Sensitive);
    assert_eq!(verdict(&r, &format!(r"\\.\{h}\.ssh\id"), ReadTool::Single), ReadVerdict::Sensitive);
    let ok = r.work.join("a.txt");
    std::fs::write(&ok, "x").unwrap();
    assert_eq!(verdict(&r, &format!(r"\\?\{}", ps(&ok)), ReadTool::Single), ReadVerdict::Allow);
    assert_eq!(verdict(&r, &format!(r"\\localhost\{drive}$\{}", ps(&ok)[3..].to_string()), ReadTool::Single), ReadVerdict::Allow);
    // 看不出實際指向哪裡的寫法：一律當解析不了。只判結果，不讀任何檔
    for p in [
        format!(r"\\?\UNC\localhost\{drive}$\x"),
        format!(r"\\?\UNC\{name}\{drive}$\x"),
        r"\\?\Volume{00000000-0000-0000-0000-000000000000}\x".to_string(),
        r"\\.\Volume{00000000-0000-0000-0000-000000000000}\x".to_string(),
        r"\\.\HarddiskVolume3\x".to_string(),
        r"\\?\GLOBALROOT\Device\HarddiskVolume3\x".to_string(),
        r"\\.\GLOBALROOT\Device\HarddiskVolume3\x".to_string(),
        format!(r"\\not-this-machine-{}\{drive}$\x", std::process::id()),
    ] {
        assert_eq!(verdict(&r, &p, ReadTool::Single), ReadVerdict::Unresolvable, "{p}");
    }
}

#[test]
fn 路徑形式變體_超長與多行的路徑欄位() {
    let r = rig();
    // 超過長度上限：路徑類欄位照收，判定直接擋（不是丟掉）
    let long = format!("{}/{}", ps(&r.home), "a/../".repeat(900) + ".ssh/id");
    assert!(long.len() > MAX_PATH_LEN);
    let got = extract_read_paths(&json!({"Path": long}));
    assert_eq!(got.len(), 1, "超長的路徑類欄位要收進來");
    assert_eq!(verdict(&r, &got[0], ReadTool::Single), ReadVerdict::Unresolvable);
    // 含換行
    let multi = format!("{}\n{}", ps(&r.work.join("a.txt")), ps(&r.home.join(".ssh").join("id")));
    let got = extract_read_paths(&json!({"files": [multi]}));
    assert_eq!(got.len(), 1);
    assert_eq!(verdict(&r, &got[0], ReadTool::Single), ReadVerdict::Unresolvable);
    // 其他欄位的超長、多行文字：有空白的一般文字不收
    assert!(extract_read_paths(&json!({"note": format!("see a/b {}", "word ".repeat(1000))})).is_empty());
    assert!(extract_read_paths(&json!({"note": "first line has spaces / and slash\nsecond one too"})).is_empty());
    // 一般長度的正常路徑不受影響
    assert_eq!(verdict(&r, &ps(&r.work.join("a.txt")), ReadTool::Single), ReadVerdict::Allow);
}

#[test]
fn 抽取_參數本身是_json_字串時先解開() {
    let r = rig();
    let bad = ps(&r.home.join(".ssh").join("id"));
    let text = json!({"Path": bad, "n": 1}).to_string();
    let got = extract_read_paths(&Value::String(text));
    assert_eq!(got, vec![bad.clone()]);
    assert!(blocked(&r, &got[0]));
    assert_eq!(param_keys(&Value::String(json!({"Path": "x", "Other": 1}).to_string())).len(), 2);
    // 不是 JSON 的字串照原樣當候選
    assert_eq!(extract_read_paths(&Value::String(bad.clone())), vec![bad]);
}

#[test]
fn 路徑形式變體_多位元組字元不會當掉() {
    let r = rig();
    for p in ["file://一二三四五六七八九十/x", "file://localhos一/x", "file:一二三", "文件:一二三", "file:", "file://", "一", "~一/x", "%一%/x", "$一/x", "file:///一:/x", "file:///%E4%B8%80%/x", "file://localhost一二三四五六七/x"] {
        let _ = verdict(&r, p, ReadTool::Single);
        let _ = strip_file_url(p);
    }
    assert_eq!(strip_file_url("file://localhost/一二/x"), "/一二/x");
    assert_eq!(strip_file_url("file://%E4%B8%80/x"), "//一/x");
}

#[test]
fn 路徑形式變體_網址的其他寫法() {
    assert_eq!(strip_file_url("file:/C:/a/b"), "C:/a/b");
    assert_eq!(strip_file_url("FILE:/C:/a"), "C:/a");
    assert_eq!(strip_file_url("file:///C%3A/a"), "C:/a");
    assert_eq!(strip_file_url("file:///c%3a/a%20b"), "c:/a b");
    assert_eq!(strip_file_url("file://pc-name/C$/a"), "//pc-name/C$/a");
    assert_eq!(strip_file_url("file://localhost/C:/a"), "C:/a");
    assert_eq!(strip_file_url("file:///etc/x"), "/etc/x");
    assert_eq!(strip_file_url("not-a-url"), "not-a-url");
    // 判定也要認：單斜線、百分號編碼的磁碟機、帶主機名的寫法
    let r = rig();
    let h = ps(&r.home).replace('\\', "/");
    let ssh = format!("{h}/.ssh/id");
    let forms = if ssh.starts_with('/') { vec![format!("file:{ssh}"), format!("file://{ssh}")] } else { vec![format!("file:/{ssh}"), format!("file:///{ssh}"), format!("file:///{}%3A{}", &ssh[..1], &ssh[2..])] };
    for f in forms {
        assert!(blocked(&r, &f), "{f}");
    }
}

#[test]
fn 路徑形式變體_家目錄磁碟機與路徑兩個變數() {
    let r = rig();
    for p in [r"%HOMEDRIVE%%HOMEPATH%\.ssh\id", "%HOMEDRIVE%%HOMEPATH%/.aws/credentials", "%homedrive%%homepath%/.ssh/id"] {
        assert!(blocked(&r, p), "{p}");
    }
    assert!(!blocked(&r, r"%HOMEDRIVE%%HOMEPATH%\Desktop\a.txt"));
}

#[test]
fn 路徑形式變體_萬用字元() {
    assert_eq!(wildcard_prefix("a/b/c"), None);
    assert_eq!(wildcard_prefix("a/b/*.txt").as_deref(), Some("a/b"));
    assert_eq!(wildcard_prefix("/a/*/c").as_deref(), Some("/a"));
    assert_eq!(wildcard_prefix("/*").as_deref(), Some("/"));
    assert_eq!(wildcard_prefix("*.rs").as_deref(), Some("."));
    assert_eq!(wildcard_prefix("C:/*").as_deref(), Some("C:/"));
    assert_eq!(wildcard_prefix("C:\\a\\b?.txt").as_deref(), Some("C:/a"));
    assert_eq!(wildcard_prefix("a/[x]/b").as_deref(), Some("a"));
    assert_eq!(wildcard_prefix("a/{x,y}/b").as_deref(), Some("a"));
    let r = rig();
    let h = ps(&r.home);
    // 前綴是敏感位置，或是敏感位置的上層（照遞迴搜尋判定）：擋
    for p in [format!("{h}/.ssh/*"), format!("{h}/.ssh/id*"), format!("{h}/*"), format!("{h}/*/id"), format!("{h}/.s?h/id"), format!("{h}/[.]ssh/id"), format!("{h}/.ssh/{{id,id.pub}}")] {
        assert!(blocked(&r, &p), "{p}");
    }
    // 前綴不含敏感位置：放行
    for p in [format!("{h}/Desktop/*"), ps(&r.work.join("*.txt")), "*.txt".to_string(), "sub/*/x".to_string()] {
        assert!(!blocked(&r, &p), "{p}");
    }
    // 相對路徑以工作資料夾為準：工作資料夾本身是使用者資料夾時，單獨一個萬用字元就掃到敏感位置
    let ctx = |base: &Path, p: &str| read_verdict(p, &ReadCtx { roots: &r.roots, base, tool: ReadTool::Single });
    assert_eq!(ctx(&r.home, "*"), ReadVerdict::Sensitive);
    assert_eq!(ctx(&r.work, "*"), ReadVerdict::Allow);
}

#[test]
fn 清單_新增的位置都擋() {
    let r = rig();
    for d in [
        "AppData/Local/Microsoft/Credentials",
        "AppData/Local/Microsoft/Vault",
        "AppData/Roaming/Microsoft/Vault",
        "AppData/Roaming/gcloud",
        "AppData/Roaming/GitHub CLI",
        "AppData/Roaming/Mozilla/Firefox/Profiles/x.default",
        "AppData/Local/BraveSoftware/Brave-Browser/User Data/Default",
        "AppData/Local/Vivaldi/User Data/Default",
        "AppData/Roaming/Opera Software/Opera Stable",
        "AppData/Roaming/Microsoft/Windows/PowerShell/PSReadLine/ConsoleHost_history.txt",
        ".config/gh/hosts.yml",
        ".bash_history",
        ".zsh_history",
        ".pgpass",
        ".my.cnf",
        ".pypirc",
        ".m2/settings.xml",
        ".cursor/mcp.json",
        ".codeium/config.json",
        ".cargo/credentials",
        ".cargo/credentials.toml",
        ".terraform.d/credentials.tfrc.json",
    ] {
        assert!(blocked(&r, &ps(&r.home.join(d))), "{d}");
    }
    // 不加的：一般設定檔
    for d in [".gitconfig", ".env", ".cargo/config.toml", ".cargo/registry/x", ".m2/repository/x", ".terraform.d/plugins/x"] {
        assert!(!blocked(&r, &ps(&r.home.join(d))), "{d}");
    }
    // 檔名前綴的資料夾：遞迴搜尋擋、列舉放行
    let cargo = ps(&r.home.join(".cargo"));
    assert_eq!(verdict(&r, &cargo, ReadTool::Recursive), ReadVerdict::Sensitive);
    assert_eq!(verdict(&r, &cargo, ReadTool::List), ReadVerdict::Allow);
}

#[test]
fn 清單_系統層與別人的家目錄() {
    let d = tempfile::tempdir().unwrap();
    let users = d.path().join("users");
    let (me, bob, public, work) = (users.join("alice"), users.join("bob"), users.join("public"), d.path().join("work"));
    for p in [&me, &bob, &public, &work] {
        std::fs::create_dir_all(p).unwrap();
    }
    let roots = SensitiveRoots::build(&[me.clone()], &[]);
    let v = |p: &str, tool: ReadTool| read_verdict(p, &ReadCtx { roots: &roots, base: &work, tool });
    for p in ["/etc/shadow", "/etc/gshadow", "/proc/1234/environ", "/proc/self/environ", "/root/x", "/root", "/home/someone/.bashrc", &ps(&bob.join("Desktop").join("a.txt")), &ps(&bob)] {
        assert_eq!(v(p, ReadTool::Single), ReadVerdict::Sensitive, "{p}");
    }
    for p in ["/etc/hostname", "/etc/shadowx", "/proc/cpuinfo", "/proc/1234/status", "/homes/x", &ps(&public.join("a.txt")), &ps(&me.join("Desktop").join("a.txt")), &ps(&work.join("a.txt"))] {
        assert_eq!(v(p, ReadTool::Single), ReadVerdict::Allow, "{p}");
    }
    // 遞迴搜尋：別人家目錄的上層、系統層的上層都擋；列舉放行
    for p in [ps(&users), "/proc".to_string(), "/home".to_string(), "/etc".to_string()] {
        assert_eq!(v(&p, ReadTool::Recursive), ReadVerdict::Sensitive, "{p}");
    }
    assert_eq!(v(&ps(&users), ReadTool::List), ReadVerdict::Allow);
    assert_eq!(v("/proc/1234", ReadTool::Recursive), ReadVerdict::Sensitive);
}

#[test]
fn 清單_環境變數指定的位置_新增的三個() {
    let d = tempfile::tempdir().unwrap();
    let home = d.path().join("home");
    std::fs::create_dir_all(&home).unwrap();
    let (a, b, c) = (d.path().join("iro"), d.path().join("cl"), d.path().join("gk"));
    let e = kv(&[("IRORI_HOME", &ps(&a)), ("ASN_CLAUDE_HOME", &ps(&b)), ("ASN_GROK_HOME", &ps(&c)), ("XDG_CONFIG_HOME", &ps(&d.path().join("xdg")))]);
    let roots = SensitiveRoots::build(&[home], &e);
    let v = |p: &Path| read_verdict(&ps(p), &ReadCtx { roots: &roots, base: d.path(), tool: ReadTool::Single });
    for p in [&a, &b, &c] {
        assert_eq!(v(&p.join("x")), ReadVerdict::Sensitive, "{}", p.display());
    }
    assert_eq!(v(&d.path().join("xdg").join("x")), ReadVerdict::Allow, "XDG 變數不整個加");
}

#[test]
fn 正式路徑建立清單_兩個家目錄與環境變數過濾() {
    let d = tempfile::tempdir().unwrap();
    let (h1, h2, h3, work) = (d.path().join("h1"), d.path().join("h2"), d.path().join("h3"), d.path().join("work"));
    for p in [&h1, &h2, &h3, &work] {
        std::fs::create_dir_all(p).unwrap();
    }
    let cx = d.path().join("cx");
    let e = kv(&[
        ("USERPROFILE", &ps(&h1)),
        ("HOME", &ps(&h2)),
        ("CODEX_HOME", &ps(&cx)),
        ("MYDIR", &ps(&h1.join(".ssh"))),
        ("API_TOKEN", &ps(&h1.join(".ssh"))),
        ("MY_SECRET_DIR", &ps(&h1.join(".ssh"))),
    ]);
    let roots = roots_for_worker(&e, h3.clone());
    let v = |p: &str| read_verdict(p, &ReadCtx { roots: &roots, base: &work, tool: ReadTool::Single });
    // 兩個環境家目錄加上實際的家目錄，每個都算
    for h in [&h1, &h2, &h3] {
        assert_eq!(v(&ps(&h.join(".ssh").join("id"))), ReadVerdict::Sensitive, "{}", h.display());
    }
    assert_eq!(v(&ps(&cx.join("auth.json"))), ReadVerdict::Sensitive, "環境變數指定的位置");
    // 一般名字的變數可以用來展開；名字像金鑰的不帶進來
    assert_eq!(v("%MYDIR%/id"), ReadVerdict::Sensitive);
    assert_eq!(v("%API_TOKEN%/id"), ReadVerdict::Allow);
    assert_eq!(v("$MY_SECRET_DIR/id"), ReadVerdict::Allow);
    assert!(roots.env.iter().all(|(k, _)| !k.contains("TOKEN") && !k.contains("SECRET")), "{:?}", roots.env.iter().map(|(k, _)| k).collect::<Vec<_>>());
    // Debug 不印環境變數
    assert!(!format!("{roots:?}").contains("MYDIR"));
}

#[test]
fn 路徑形式變體_磁碟機後面不接分隔符_純字串判斷() {
    for p in ["C:..\\a", "C:.ssh\\id", "c:Users\\a", "C:a", "Z:*", "\\\\?\\C:a", "//?/C:a", "\\\\.\\C:a", "C:../a"] {
        assert!(drive_relative(p), "{p}");
    }
    for p in ["C:", "C:\\", "C:/", "C:\\a", "C:/a", "\\\\?\\C:\\a", "a", "", "ab:c", "https://x/y", "/etc/x", "relative\\a", "1:a"] {
        assert!(!drive_relative(p), "{p}");
    }
}

#[cfg(windows)]
#[test]
fn 路徑形式變體_windows丁() {
    let r = rig();
    // 不管實際會解到哪裡，磁碟機後面不接分隔符的寫法一律當解析不了；工作資料夾在家目錄底下時也一樣
    let home_work = r.home.join("proj");
    std::fs::create_dir_all(&home_work).unwrap();
    for p in [r"C:..\Users\x\.ssh\id", r"C:.ssh\id", r"c:Users\x\a", r"C:..\.ssh\id", r"\\?\C:foo", "file:///C:foo", "C:foo/bar"] {
        for base in [&r.work, &home_work] {
            let v = read_verdict(p, &ReadCtx { roots: &r.roots, base, tool: ReadTool::Single });
            assert_eq!(v, ReadVerdict::Unresolvable, "{p}");
        }
    }
    // 對照：磁碟機本身、磁碟機加分隔符，以及一般的暫存檔不受影響
    for p in ["C:", r"C:\", "C:/"] {
        assert_ne!(verdict(&r, p, ReadTool::Single), ReadVerdict::Unresolvable, "{p}");
    }
    assert_eq!(verdict(&r, &ps(&r.work.join("a.txt")), ReadTool::Single), ReadVerdict::Allow);
    assert_eq!(verdict(&r, &ps(&r.home.join(".ssh").join("id")), ReadTool::Single), ReadVerdict::Sensitive);
}

#[test]
fn 抽取_其他欄位的超長與多行路徑字串也收_交給判定擋() {
    let r = rig();
    // 超長、沒有空白、長得像路徑：收進來，判定回解析不了
    let long = format!("{}/{}", ps(&r.home), "a/../".repeat(900) + ".ssh/id");
    assert!(long.len() > MAX_PATH_LEN);
    let got = extract_read_paths(&json!({"note": long}));
    assert_eq!(got, vec![long.clone()]);
    assert_eq!(verdict(&r, &got[0], ReadTool::Single), ReadVerdict::Unresolvable);
    // 多行：含敏感路徑的那一行收進來，判定擋下；其他行不影響
    let bad = ps(&r.home.join(".ssh").join("id"));
    let multi = format!("說明文字 有 空白\n{bad}\nlast line");
    let got = extract_read_paths(&json!({"note": multi}));
    assert_eq!(got, vec![bad.clone()]);
    assert_eq!(verdict(&r, &got[0], ReadTool::Single), ReadVerdict::Sensitive);
    // 一般的長文字（有空白）不收，不會誤擋
    let prose = format!("please look at src/lib.rs and docs/a.md {}", "more words here ".repeat(500));
    assert!(extract_read_paths(&json!({"note": prose.clone(), "other": [prose]})).is_empty());
}

#[test]
fn 抽取_有空白的行夾著敏感位置_片段由清單自動產生() {
    use super::fragments::{fragments, prose_candidates};
    let r = rig();
    // 片段是從清單每一項的最後兩段產生的，清單每一項都要有對應的片段
    let all: Vec<String> = SENSITIVE_HOME_DIRS.iter().chain(EXTRA_HOME_PATHS.iter()).map(|s| s.to_string()).collect();
    for e in &all {
        let n = e.replace('\\', "/").to_ascii_lowercase();
        assert!(fragments().iter().any(|f| n.ends_with(f.as_str())), "{e}");
    }
    assert!(fragments().iter().any(|f| f == "chrome/user data"));
    // 夾在多行提示裡的敏感路徑：收進來、判定擋下；一般含斜線的長提示不收
    let chrome = ps(&r.home.join("AppData").join("Local").join("Google").join("Chrome").join("User Data").join("Default").join("Cookies"));
    let multi = format!("請幫我看一下\nsee src/lib.rs and docs/a.md for context\nplease read {chrome} for details\n結尾 /x y");
    let got = extract_read_paths(&json!({"Message": multi}));
    assert!(got.contains(&chrome), "{got:?}");
    assert!(got.len() <= 3, "多出來的只是從前面幾個空白邊界起算的候選：{got:?}");
    assert_eq!(verdict(&r, &chrome, ReadTool::Single), ReadVerdict::Sensitive);
    let prose = format!("see src/lib.rs and docs/a.md for context\n{}", "more words with a/b slash and .config-like text\n".repeat(200));
    assert!(extract_read_paths(&json!({"Message": prose})).is_empty());
    // 路徑本身含空白時，往前找得到起點；不在路徑段邊界上的不算
    let spaced = format!("note: C:\\Program Files\\x\\y {}", "word ".repeat(10));
    assert!(prose_candidates(&spaced).is_empty());
    assert!(prose_candidates("my.sshkey is here / ok").is_empty() && prose_candidates("a x.ssh/y b").is_empty());
    assert!(prose_candidates("please open ~/.ssh/id now").contains(&"~/.ssh/id".to_string()));
    assert!(prose_candidates("read \"/etc/shadow\", thanks").contains(&"/etc/shadow".to_string()));
}

#[test]
fn 抽取_巢狀_json_字串要解開_有層數上限() {
    let r = rig();
    let bad = ps(&r.home.join(".ssh").join("id"));
    let nest = |levels: usize| {
        let mut cur = json!({"p": bad});
        for _ in 0..levels {
            cur = json!({"arguments": cur.to_string()});
        }
        cur
    };
    // 參數裡的字串是 JSON，裡面再帶路徑：抽得到、也擋得住
    for levels in 1..=MAX_JSON_DEPTH {
        let got = extract_read_paths(&nest(levels));
        assert_eq!(got, vec![bad.clone()], "{levels} 層");
        assert!(blocked(&r, &got[0]));
    }
    // 超過上限：沒解開的原樣收進來，判定當解析不了
    let got = extract_read_paths(&nest(MAX_JSON_DEPTH + 1));
    assert_eq!(got.len(), 1, "{got:?}");
    assert!(!got.contains(&bad));
    assert_eq!(verdict(&r, &got[0], ReadTool::Single), ReadVerdict::Unresolvable);
    // 陣列形式的 JSON 字串也解
    assert_eq!(extract_read_paths(&json!({"arguments": json!([bad.clone()]).to_string()})), vec![bad.clone()]);
    // 不是物件或陣列的字串照舊
    assert!(extract_read_paths(&json!({"arguments": "{not json"})).is_empty());
}

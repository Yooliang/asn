use super::*;
use serde_json::json;

struct Rig {
    _d: tempfile::TempDir,
    home: PathBuf,
    work: PathBuf,
    roots: SensitiveRoots,
}

fn rig() -> Rig {
    let d = tempfile::tempdir().unwrap();
    let home = d.path().join("home");
    let work = d.path().join("work");
    std::fs::create_dir_all(&home).unwrap();
    std::fs::create_dir_all(&work).unwrap();
    let roots = SensitiveRoots::build(&[home.clone()], &[]);
    Rig { _d: d, home, work, roots }
}

fn chk(r: &Rig, p: &str, tool: ReadTool) -> bool {
    is_sensitive_read(p, &ReadCtx { roots: &r.roots, base: &r.work, tool })
}
fn blocked(r: &Rig, p: &str) -> bool {
    chk(r, p, ReadTool::Single)
}
fn ps(p: &Path) -> String {
    p.display().to_string()
}
fn link(l: &Path, t: &Path) {
    use crate::home::Ops;
    crate::home::RealOps.make_link(l, t).unwrap();
}
fn fail_canon(_: &Path) -> io::Result<PathBuf> {
    Err(io::Error::other("無法解析"))
}
fn env(v: &[(&str, &Path)]) -> Vec<(String, String)> {
    v.iter().map(|(k, p)| (k.to_string(), ps(p))).collect()
}

#[test]
fn 資料夾外與家目錄裡的一般檔可以讀() {
    let r = rig();
    for p in [r.work.join("a.txt"), r.home.join("Desktop").join("a.txt"), r.home.join("Documents"), r.home.join(".geminiX").join("a"), r.home.join(".ssh2").join("a"), r.home.join(".claude.json.bak")] {
        assert!(!blocked(&r, &ps(&p)), "{}", p.display());
    }
    assert!(!blocked(&r, "a.txt"), "相對路徑以工作資料夾為準");
    assert!(!blocked(&r, ""));
}

#[test]
fn 清單內每個位置都擋_本身與底下的檔() {
    let r = rig();
    for d in SENSITIVE_HOME_DIRS.iter().chain(EXTRA_HOME_PATHS.iter()) {
        let root = r.home.join(d);
        assert!(blocked(&r, &ps(&root)), "{d} 本身");
        assert!(blocked(&r, &ps(&root.join("x").join("y.txt"))), "{d} 底下");
    }
    // 清單本身另外寫死一份：誰把項目拿掉，這裡會紅
    for d in [
        ".gemini", ".ssh", ".asn", ".irori-relay", ".claude", ".codex", ".pi", ".aws", ".config", ".gnupg", ".grok", ".claude.json", ".netrc", ".git-credentials", ".docker", ".kube", ".azure", ".npmrc",
        "AppData/Roaming/Microsoft/Credentials", "AppData/Roaming/Microsoft/Protect", "AppData/Local/Google/Chrome/User Data", "AppData/Local/Microsoft/Edge/User Data", "AppData/Local/tw.yooliang.asn",
    ] {
        assert!(blocked(&r, &ps(&r.home.join(d).join("x"))), "{d}");
    }
}

#[test]
fn 環境變數指定的位置也擋() {
    let d = tempfile::tempdir().unwrap();
    let home = d.path().join("home");
    let work = d.path().join("work");
    let (cx, pi, la, ap, ah) = (d.path().join("cx"), d.path().join("pi"), d.path().join("local"), d.path().join("roam"), d.path().join("ah"));
    std::fs::create_dir_all(&home).unwrap();
    let e = env(&[("CODEX_HOME", &cx), ("PI_CODING_AGENT_DIR", &pi), ("LOCALAPPDATA", &la), ("APPDATA", &ap), ("ASN_HOME", &ah)]);
    let roots = SensitiveRoots::build(&[home.clone()], &e);
    let ok = |p: &Path| is_sensitive_read(&ps(p), &ReadCtx { roots: &roots, base: &work, tool: ReadTool::Single });
    for p in [cx.join("auth.json"), pi.join("a"), la.join("tw.yooliang.asn").join("x"), la.join("Google/Chrome/User Data/Default/Cookies"), la.join("Microsoft/Edge/User Data/x"), ap.join("Microsoft/Credentials/x"), ap.join("Microsoft/Protect/x"), ah.join("k")] {
        assert!(ok(&p), "{}", p.display());
    }
    assert!(!ok(&la.join("ASN").join("tools").join("agy.exe")), "安裝的工具執行檔不在清單");
    assert!(!ok(&ap.join("Other").join("x")), "整個應用資料夾不列");
    // 設錯成使用者資料夾本身：不採用，不會把整個家都擋掉
    let bad = SensitiveRoots::build(&[home.clone()], &env(&[("CODEX_HOME", &home)]));
    assert!(!is_sensitive_read(&ps(&home.join("Desktop").join("a")), &ReadCtx { roots: &bad, base: &work, tool: ReadTool::Single }));
}

#[test]
fn 路徑形式變體_展開家目錄與環境變數() {
    let r = rig();
    for p in ["~/.ssh/id", "~\\.ssh\\id", "$HOME/.ssh/id", "${HOME}/.ssh/id", "%USERPROFILE%/.ssh/id", "%USERPROFILE%\\.ssh\\id", "~/.claude.json", "~"] {
        let want = p != "~";
        assert_eq!(blocked(&r, p), want, "{p}");
    }
    assert!(!blocked(&r, "~/Desktop/a.txt"));
    // 一般環境變數
    let e = env(&[("MYDIR", &r.home.join(".aws"))]);
    let roots = SensitiveRoots::build(&[r.home.clone()], &e);
    let c = |p: &str| is_sensitive_read(p, &ReadCtx { roots: &roots, base: &r.work, tool: ReadTool::Single });
    assert!(c("%MYDIR%/credentials") && c("$MYDIR/credentials") && c("%mydir%/credentials"));
    // 展開不了的變數：字面不在使用者資料夾底下就放行
    assert!(!c("$NOPE/x") && !c("%NOPE%/x"));
}

#[test]
fn 路徑形式變體_檔案網址() {
    let r = rig();
    let url = |p: &Path| {
        let s = ps(p).replace('\\', "/");
        if s.starts_with('/') { format!("file://{s}") } else { format!("file:///{s}") }
    };
    assert!(blocked(&r, &url(&r.home.join(".ssh").join("id"))));
    assert!(blocked(&r, &url(&r.home.join(".ssh").join("id")).replace(".ssh", "%2essh")));
    assert!(blocked(&r, &url(&r.home.join(".ssh").join("id")).replace("file://", "FILE://")));
    assert!(!blocked(&r, &url(&r.work.join("a.txt"))));
    assert_eq!(strip_file_url("file:///C:/a%20b/c"), "C:/a b/c");
    assert_eq!(strip_file_url("file://localhost/etc/x"), "/etc/x");
    assert_eq!(strip_file_url("/plain/%20"), "/plain/%20");
}

#[test]
fn 相對路徑看工作資料夾() {
    let r = rig();
    let ctx = |base: &Path, p: &str| is_sensitive_read(p, &ReadCtx { roots: &r.roots, base, tool: ReadTool::Single });
    assert!(ctx(&r.home, ".ssh/id"), "工作資料夾就是使用者資料夾");
    assert!(!ctx(&r.work, ".ssh/id"));
    assert!(ctx(&r.work, "../home/.ssh/id"), "往上一層再進去");
    assert!(ctx(&r.work, "x/../../home/.config/a"), "不存在的中間層折疊後也比");
}

#[test]
fn 抽取_陣列與巢狀欄位都拿得到() {
    let r = rig();
    let bad = ps(&r.home.join(".ssh").join("id"));
    let v = json!({"paths": ["a.txt", bad], "opts": {"files": [{"p": "~/.aws/credentials"}], "n": 3, "flag": true}, "query": "hello world", "x": ["C:\\Users\\a\\b", "file:///etc/x", "%USERPROFILE%\\a"]});
    let got = extract_read_paths(&v);
    for want in ["a.txt", bad.as_str(), "~/.aws/credentials", "C:\\Users\\a\\b", "file:///etc/x", "%USERPROFILE%\\a"] {
        assert!(got.iter().any(|g| g == want), "{want} 在 {got:?}");
    }
    assert!(!got.iter().any(|g| g == "hello world"), "一般文字不算");
    assert_eq!(got.iter().filter(|g| g.as_str() == "a.txt").count(), 1, "不重複");
    assert!(got.iter().any(|p| blocked(&r, p)), "抽出來逐一判定就會命中");
    // 路徑欄位名底下的字串不管長相都要，其他欄位要長得像路徑
    assert_eq!(extract_read_paths(&json!({"SearchDirectory": ".ssh", "Query": "x"})), vec![".ssh".to_string()]);
    assert!(extract_read_paths(&json!({})).is_empty());
    assert!(extract_read_paths(&json!({"a": 1, "b": [null, false]})).is_empty());
    assert!(extract_read_paths(&json!({"a": "x y\nz w/q"})).is_empty(), "多行一般文字不當路徑");
}

#[test]
fn 抽取_實機事件形狀_讀檔工具的路徑欄位首字大寫() {
    let r = rig();
    let bad = ps(&r.home.join(".ssh").join("id"));
    let ok = ps(&r.work.join("test.txt"));
    let step = |path: &str| json!({"event": "step_update", "step_update": {"step_index": 2, "state": "ACTIVE", "step_type": "tool", "tool_name": "read_file", "tool_info": {"name": "read_file", "parameters": {"Path": path}, "output": "1 lines, 59 bytes"}}});
    for (path, want_block) in [(bad.as_str(), true), (ok.as_str(), false), ("~/.ssh/id", true), ("~/Desktop/a.txt", false)] {
        let ev = step(path);
        // 只給參數，或給整個事件，都要抽得到
        for src in [ev.pointer("/step_update/tool_info/parameters").unwrap().clone(), ev.clone()] {
            let got = extract_read_paths(&src);
            assert!(got.iter().any(|g| g == path), "{path} 在 {got:?}");
            assert_eq!(got.iter().any(|p| blocked(&r, p)), want_block, "{path}");
        }
    }
    // 沒有分隔符的單純檔名，靠欄位名（不分大小寫）才抽得到
    assert_eq!(extract_read_paths(&step("id_rsa").pointer("/step_update/tool_info/parameters").unwrap().clone()), vec!["id_rsa".to_string()]);
    assert_eq!(ReadTool::of_agy("read_file"), ReadTool::Single);
    // 內部控制步驟沒有路徑
    assert!(extract_read_paths(&json!({"steps": [{"status": "done", "title": "整理"}]})).is_empty());
}

#[test]
fn 上層資料夾_遞迴搜尋擋_列舉與單檔放行() {
    let r = rig();
    let up = [ps(&r.home), ps(r.home.parent().unwrap()), ps(&r.home.join(".config").parent().unwrap().to_path_buf())];
    for p in &up {
        assert!(chk(&r, p, ReadTool::Recursive), "{p} 遞迴");
        assert!(!chk(&r, p, ReadTool::List), "{p} 列舉");
        assert!(!chk(&r, p, ReadTool::Single), "{p} 單檔");
    }
    assert!(!chk(&r, &ps(&r.home.join("Desktop")), ReadTool::Recursive), "不含敏感位置的資料夾");
    assert!(!chk(&r, &ps(&r.work), ReadTool::Recursive));
    for t in [ReadTool::Single, ReadTool::List, ReadTool::Recursive] {
        assert!(chk(&r, &ps(&r.home.join(".ssh")), t), "{t:?} 敏感資料夾本身");
        assert!(chk(&r, &ps(&r.home.join(".ssh").join("a")), t), "{t:?} 底下");
    }
}

#[test]
fn 工具類別對照() {
    for (n, t) in [("list_dir", ReadTool::List), ("list_resources", ReadTool::List), ("find_by_name", ReadTool::Recursive), ("grep_search", ReadTool::Recursive), ("view_file", ReadTool::Single), ("read_resource", ReadTool::Single), ("沒看過", ReadTool::Single)] {
        assert_eq!(ReadTool::of_agy(n), t, "{n}");
    }
    assert_eq!(ReadTool::of_acp_kind("search"), ReadTool::Recursive);
    assert_eq!(ReadTool::of_acp_kind("SEARCH"), ReadTool::Recursive);
    assert_eq!(ReadTool::of_acp_kind("read"), ReadTool::Single);
    assert_eq!(ReadTool::of_acp_kind("think"), ReadTool::Single);
}

#[test]
fn 系統層的主機金鑰() {
    let r = rig();
    for p in ["/etc/ssh/ssh_host_ed25519_key", "/etc/ssh/ssh_host_rsa_key"] {
        assert!(blocked(&r, p), "{p}");
    }
    for p in ["/etc/ssh/ssh_host_rsa_key.pub", "/etc/ssh/sshd_config", "/etc/hostname"] {
        assert!(!blocked(&r, p), "{p}");
    }
    for p in ["/etc", "/etc/ssh"] {
        assert!(chk(&r, p, ReadTool::Recursive), "{p} 遞迴");
        assert!(!chk(&r, p, ReadTool::List), "{p} 列舉");
    }
}

#[test]
fn 家目錄有兩個來源時各算一次() {
    let d = tempfile::tempdir().unwrap();
    let (h1, h2, work) = (d.path().join("agyhome"), d.path().join("realhome"), d.path().join("work"));
    for p in [&h1, &h2, &work] {
        std::fs::create_dir_all(p).unwrap();
    }
    let roots = SensitiveRoots::build(&[h1.clone(), h2.clone()], &[]);
    let c = |p: &str| is_sensitive_read(p, &ReadCtx { roots: &roots, base: &work, tool: ReadTool::Single });
    assert!(c(&ps(&h1.join(".ssh").join("a"))) && c(&ps(&h2.join(".ssh").join("a"))));
    assert!(c(&ps(&h2.join(".claude.json"))) && c(&ps(&h1.join(".claude.json"))));
    assert!(c("~/.kube/config") && c("$HOME/.docker/config.json"));
    assert!(!c("~/Desktop/a") && !c(&ps(&h2.join("Desktop"))));
    // 只有一個來源時，另一個來源的家不在清單
    let one = SensitiveRoots::build(&[h1.clone()], &[]);
    assert!(!is_sensitive_read(&ps(&h2.join(".ssh").join("a")), &ReadCtx { roots: &one, base: &work, tool: ReadTool::Single }));
}

#[test]
fn 捷徑指向敏感位置的也擋() {
    let r = rig();
    std::fs::create_dir_all(r.home.join(".ssh")).unwrap();
    std::fs::write(r.home.join(".ssh").join("id"), "x").unwrap();
    let l = r.work.join("shortcut");
    link(&l, &r.home.join(".ssh"));
    assert!(blocked(&r, &ps(&l)), "捷徑本身");
    assert!(blocked(&r, &ps(&l.join("id"))), "已存在的檔");
    assert!(blocked(&r, &ps(&l.join("not-yet.txt"))), "還不存在的檔");
    assert!(blocked(&r, "shortcut/id"), "相對路徑");
    // 對照：指到一般資料夾的捷徑放行
    let ok = r.work.join("plain");
    std::fs::create_dir_all(r.home.join("Desktop")).unwrap();
    link(&ok, &r.home.join("Desktop"));
    assert!(!blocked(&r, &ps(&ok.join("a.txt"))));
}

#[cfg(unix)]
#[test]
fn 路徑形式變體_捷徑加相對段_unix() {
    let r = rig();
    std::fs::create_dir_all(r.home.join(".ssh").join("inner")).unwrap();
    std::fs::write(r.home.join(".ssh").join("secret"), "x").unwrap();
    link(&r.work.join("hop"), &r.home.join(".ssh").join("inner"));
    let p = format!("{}/hop/../secret", ps(&r.work));
    assert!(blocked(&r, &p));
    // 折疊後落在敏感位置的寫法也擋（兩種形式任一命中）
    assert!(blocked(&r, &format!("{}/x/../../home/.ssh/secret", ps(&r.work))));
}

#[test]
fn 路徑形式變體_相對段() {
    let r = rig();
    let p = format!("{}/nowhere/../../home/.ssh/secret", ps(&r.work));
    assert!(blocked(&r, &p));
}

#[test]
fn 解析失敗時_字面在使用者資料夾底下就擋() {
    let mut r = rig();
    r.roots.canon = fail_canon;
    assert!(blocked(&r, &ps(&r.home.join("docs").join("a.txt"))), "家目錄底下解析不了：擋");
    assert!(blocked(&r, &ps(&r.home.join(".ssh").join("a"))), "清單內照擋");
    assert!(!blocked(&r, &ps(&r.work.join("a.txt"))), "不在家目錄底下：放行");
    assert!(!blocked(&r, "/somewhere/else/a.txt"));
    // 展開不了的變數：基準資料夾在家目錄底下才擋
    let r2 = rig();
    let in_home = r2.home.join("proj");
    std::fs::create_dir_all(&in_home).unwrap();
    let ctx = |base: &Path| is_sensitive_read("$NOPE/x", &ReadCtx { roots: &r2.roots, base, tool: ReadTool::Single });
    assert!(ctx(&in_home));
    assert!(!ctx(&r2.work));
}

#[test]
fn 對話資料夾的例外_不外溢到其他位置() {
    let r = rig();
    let brain = agy_brain(&r.home);
    let c1 = brain.join("c1");
    std::fs::create_dir_all(c1.join(".system_generated")).unwrap();
    std::fs::create_dir_all(c1.join("sub")).unwrap();
    let g = r.home.join(".gemini");
    for p in [c1.join("notes.md"), c1.join("sub").join("a.md"), brain.join("c3").join("new.md")] {
        assert!(!blocked(&r, &ps(&p)), "{}", p.display());
    }
    for p in [g.join("oauth_creds.json"), g.join("antigravity-cli").join("x"), brain.join("x.md"), c1.join(".system_generated").join("x"), c1.join(".SYSTEM_GENERATED").join("x"), brain.join("a b").join("x"), g.clone()] {
        assert!(blocked(&r, &ps(&p)), "{}", p.display());
    }
    // 對話資料夾本身與 brain 本身：單檔與列舉放行，遞迴搜尋照擋（會掃進系統目錄）
    for p in [&brain, &c1, &brain.join("c3")] {
        assert!(!blocked(&r, &ps(p)), "{}", p.display());
        assert!(!chk(&r, &ps(p), ReadTool::List), "{}", p.display());
        assert!(chk(&r, &ps(p), ReadTool::Recursive), "{}", p.display());
    }
    for p in [&g, &g.join("antigravity-cli"), &c1.join(".system_generated"), &brain.join("a b")] {
        assert!(chk(&r, &ps(p), ReadTool::List), "列舉也不能開到 {}", p.display());
    }
    // 往上跳出對話資料夾
    assert!(blocked(&r, &ps(&c1.join("sub").join("..").join("..").join("..").join("oauth_creds.json"))));
    assert!(blocked(&r, &ps(&c1.join("sub").join("..").join(".system_generated").join("x"))));
    // 對話資料夾裡的捷徑指到登入檔所在位置：用實際位置判，不放行
    link(&c1.join("hop"), &g);
    assert!(blocked(&r, &ps(&c1.join("hop").join("oauth_creds.json"))));
    // 帶 .. 且還不存在的路徑不套例外
    assert!(blocked(&r, &ps(&c1.join("sub").join("..").join("not-yet.md"))));
}

#[test]
fn 家目錄來源_工作者環境的與這台電腦實際的都要算() {
    let e = |v: &[(&str, &str)]| v.iter().map(|(a, b)| (a.to_string(), b.to_string())).collect::<Vec<_>>();
    let real = Some(PathBuf::from("/real"));
    assert_eq!(homes_from(&e(&[("HOME", "/h"), ("UserProfile", "/p")]), real.clone()), vec![PathBuf::from("/p"), PathBuf::from("/h"), PathBuf::from("/real")], "USERPROFILE 與 HOME 兩個都算");
    assert_eq!(homes_from(&e(&[("HOME", "/h"), ("USERPROFILE", " ")]), real.clone()), vec![PathBuf::from("/h"), PathBuf::from("/real")]);
    assert_eq!(homes_from(&e(&[("HOME", "/real")]), real.clone()), vec![PathBuf::from("/real")], "同一個不重複");
    assert_eq!(homes_from(&[], real), vec![PathBuf::from("/real")], "環境沒有就只有實際的");
    assert!(homes_from(&[], None).is_empty());
    assert!(homes_from(&e(&[("HOME", "/h")]), Some(PathBuf::new())).len() == 1, "空的實際家目錄不算");
}

#[test]
fn 對話資料夾的例外_兩個家目錄各自的對話資料夾() {
    let d = tempfile::tempdir().unwrap();
    let (h1, h2, work) = (d.path().join("a"), d.path().join("b"), d.path().join("work"));
    for h in [&h1, &h2] {
        std::fs::create_dir_all(agy_brain(h).join("c1")).unwrap();
    }
    std::fs::create_dir_all(&work).unwrap();
    let roots = SensitiveRoots::build(&[h1.clone(), h2.clone()], &[]);
    let c = |p: &Path| is_sensitive_read(&ps(p), &ReadCtx { roots: &roots, base: &work, tool: ReadTool::Single });
    assert!(!c(&agy_brain(&h1).join("c1").join("x.md")) && !c(&agy_brain(&h2).join("c1").join("x.md")));
    assert!(c(&h1.join(".gemini").join("oauth_creds.json")) && c(&h2.join(".gemini").join("oauth_creds.json")));
}

#[test]
fn 路徑形式變體_純字串正規化() {
    assert_eq!(win_clean(r"C:\u\.ssh.\id"), "C:/u/.ssh/id");
    assert_eq!(win_clean(r"C:\u\.ssh \id. "), "C:/u/.ssh/id");
    assert_eq!(win_clean(r"C:\u\.ssh\id:stream"), "C:/u/.ssh/id");
    assert_eq!(win_clean(r"C:\u\.ssh::$INDEX_ALLOCATION\id"), "C:/u/.ssh/id");
    assert_eq!(win_clean(r"C:\u\a\..\b\.\c"), "C:/u/a/../b/./c");
    assert_eq!(win_clean(r"C:\u\...\x"), "C:/u/x");
    assert_eq!(win_clean(r"\\?\C:\u\x"), "C:/u/x");
    assert_eq!(win_clean(r"\\localhost\C$\u\x"), "C:/u/x");
    assert_eq!(win_clean("rel/.ssh./a"), "rel/.ssh/a");
    assert_eq!(win_clean("/etc/ssh/x"), "/etc/ssh/x");
}

#[cfg(windows)]
#[test]
fn 路徑形式變體_windows甲() {
    let r = rig();
    let h = ps(&r.home);
    for p in [format!(r"{h}\.ssh.\id"), format!(r"{h}\.ssh \id"), format!(r"{h}\.ssh\id."), format!(r"{h}\.ssh\id "), format!(r"{h}\.SSH.\ID"), format!(r"{h}\.config. .\a")] {
        assert!(blocked(&r, &p), "{p}");
    }
    assert!(!blocked(&r, &format!(r"{h}\Desktop.\a.txt")));
    // 資料夾真的存在時一樣
    std::fs::create_dir_all(r.home.join(".ssh")).unwrap();
    assert!(blocked(&r, &format!(r"{h}\.ssh.\id")));
}

#[cfg(windows)]
#[test]
fn 路徑形式變體_windows乙() {
    let r = rig();
    let h = ps(&r.home);
    for p in [format!(r"{h}\.ssh\id:stream"), format!(r"{h}\.ssh\id::$DATA"), format!(r"{h}\.ssh::$INDEX_ALLOCATION"), format!(r"{h}\.ssh:x\id")] {
        assert!(blocked(&r, &p), "{p}");
    }
    assert!(!blocked(&r, &format!(r"{h}\Desktop\a.txt:stream")));
}

#[cfg(windows)]
#[test]
fn 路徑形式變體_windows丙() {
    let r = rig();
    let h = ps(&r.home);
    assert!(blocked(&r, &format!(r"\\?\{h}\.ssh\id")));
    assert!(blocked(&r, &format!(r"\\.\{h}\.ssh\id")));
    let (drive, rest) = h.split_at(2);
    assert!(blocked(&r, &format!(r"\\localhost\{}$\{}\.ssh\id", &drive[..1], rest.trim_start_matches('\\'))));
    // 大小寫不分
    assert!(blocked(&r, &format!(r"{}\.SsH\id", h.to_uppercase())));
}

#[cfg(windows)]
#[test]
fn 捷徑指向敏感位置_windows() {
    let r = rig();
    std::fs::create_dir_all(r.home.join(".gemini")).unwrap();
    link(&r.work.join("innocent"), &r.home.join(".gemini"));
    assert!(blocked(&r, &ps(&r.work.join("innocent").join("oauth_creds.json"))));
    assert!(blocked(&r, &format!(r"{}\innocent.\oauth_creds.json", ps(&r.work))), "捷徑加路徑形式變體");
}

use super::*;
use std::cell::{Cell, RefCell};

/// 假的執行器：`alive_after`＝第幾次試連開始連得上（None＝永遠連不上）；記下每條指令與環境
struct Fake {
    calls: RefCell<Vec<(String, Vec<String>, BTreeMap<String, String>)>>,
    tries: Cell<usize>,
    alive_after: Cell<Option<usize>>,
    /// 起了 mux 之後才連得上
    alive_once_started: bool,
    started: RefCell<Vec<u32>>,
    killed: RefCell<Vec<u32>>,
    birth: RefCell<BTreeMap<u32, u64>>,
    list_json: String,
    /// 起完之後查不到建立時間
    no_birth: bool,
    /// 起完之後這個編號被別的程式拿走（第二次查建立時間就變了）
    reborn: bool,
    birth_queries: Cell<usize>,
}
impl Fake {
    fn new() -> Self {
        Fake { calls: RefCell::new(vec![]), tries: Cell::new(0), alive_after: Cell::new(None), alive_once_started: true, started: RefCell::new(vec![]), killed: RefCell::new(vec![]), birth: RefCell::new(BTreeMap::new()), list_json: "[]".into(), no_birth: false, reborn: false, birth_queries: Cell::new(0) }
    }
    fn cli_calls(&self) -> Vec<Vec<String>> {
        self.calls.borrow().iter().filter(|c| c.0.ends_with("wezterm.exe")).map(|c| c.1.clone()).collect()
    }
}
impl Runner for Fake {
    fn run(&self, program: &Path, args: &[String], env: &BTreeMap<String, String>, _t: Duration) -> Result<RunOutput, String> {
        self.calls.borrow_mut().push((program.to_string_lossy().into(), args.to_vec(), env.clone()));
        let n = self.tries.get();
        self.tries.set(n + 1);
        let up = self.alive_after.get().is_some_and(|k| n >= k) || (self.alive_once_started && !self.started.borrow().is_empty());
        Ok(RunOutput { success: up, stdout: if up { self.list_json.clone() } else { String::new() }, stderr: String::new() })
    }
    fn spawn(&self, _p: &Path, _a: &[String], _e: &BTreeMap<String, String>) -> Result<u32, String> {
        unreachable!("mux 一律用 spawn_detached 起")
    }
    fn spawn_detached(&self, program: &Path, args: &[String], env: &BTreeMap<String, String>) -> Result<u32, String> {
        self.calls.borrow_mut().push((program.to_string_lossy().into(), args.to_vec(), env.clone()));
        let pid = 4000 + self.started.borrow().len() as u32;
        self.started.borrow_mut().push(pid);
        if !self.no_birth {
            self.birth.borrow_mut().insert(pid, 777);
        }
        Ok(pid)
    }
    fn kill_tree(&self, pid: u32) {
        self.killed.borrow_mut().push(pid);
    }
    fn started_ms(&self, pid: u32) -> Option<u64> {
        // 只數剛起的那些編號被查的次數（啟動鎖也會查 ASN 自己的編號，不算）
        if self.started.borrow().contains(&pid) {
            let n = self.birth_queries.get();
            self.birth_queries.set(n + 1);
            if self.reborn && n > 0 {
                return Some(888);
            }
        }
        self.birth.borrow().get(&pid).copied()
    }
    fn sleep(&self, _d: Duration) {}
}

fn base() -> BTreeMap<String, String> {
    [("PATH".to_string(), "C:\\bin".to_string())].into_iter().collect()
}
fn mux<'a>(r: &'a Fake, d: &Path) -> Mux<'a> {
    Mux { runner: r, cli: PathBuf::from("W\\wezterm.exe"), server: PathBuf::from("W\\wezterm-mux-server.exe"), paths: paths(d).unwrap(), base_env: base() }
}

#[test]
fn socket_放短路徑_太長就拒絕() {
    let base = Path::new(r"C:\Users\u\AppData\Local");
    let p = paths(base).unwrap();
    assert_eq!(p.sock, base.join("ASN").join("m").join("sock"), "跟平台無關的寫法（CI 在 Linux 上跑）");
    assert!(p.sock.as_os_str().len() < SOCK_MAX);
    let long = format!(r"C:\Users\{}\AppData\Local", "x".repeat(80));
    let e = paths(Path::new(&long)).unwrap_err();
    assert!(e.contains("路徑太長"), "{e}");
    assert!(SOCK_MAX <= 108, "AF_UNIX 的 sun_path 上限");
}

#[test]
fn 每條_cli_都帶_no_auto_start_與_socket() {
    let d = tempfile::tempdir().unwrap();
    let r = Fake::new();
    r.alive_after.set(Some(0));
    let m = mux(&r, d.path());
    assert!(m.alive());
    m.pane_count().unwrap();
    m.ensure().unwrap();
    let calls = r.calls.borrow();
    assert!(!calls.is_empty());
    for (prog, args, env) in calls.iter() {
        assert!(prog.ends_with("wezterm.exe"));
        assert_eq!(&args[..2], ["cli", "--no-auto-start"], "{args:?}");
        assert_eq!(env.get("WEZTERM_UNIX_SOCKET").map(String::as_str), Some(m.paths.sock.to_string_lossy().as_ref()));
        assert_eq!(env.get("PATH").map(String::as_str), Some("C:\\bin"), "其餘只有白名單");
        assert_eq!(env.len(), 2);
    }
}

#[test]
fn 連得上就沿用_不起新的() {
    let d = tempfile::tempdir().unwrap();
    let r = Fake::new();
    r.alive_after.set(Some(0));
    assert_eq!(mux(&r, d.path()).ensure(), Ok(Ensure::Reused));
    assert!(r.started.borrow().is_empty());
}

#[test]
fn 連不上才起_用脫離方式_窗格_0_立刻結束_設定檔只設_socket() {
    let d = tempfile::tempdir().unwrap();
    let r = Fake::new();
    let m = mux(&r, d.path());
    assert_eq!(m.ensure(), Ok(Ensure::Started { pid: 4000 }));
    let calls = r.calls.borrow();
    let (prog, args, env) = calls.iter().find(|c| c.0.ends_with(MUX_EXE)).unwrap();
    assert!(prog.ends_with(MUX_EXE));
    assert_eq!(args[0], "--config-file");
    assert_eq!(&args[2..], ["--", "cmd.exe", "/c", "exit"], "窗格 0 不常駐");
    assert_eq!(env, &base(), "mux 的環境只有白名單，不帶 socket 以外的任何東西");
    let cfg = std::fs::read_to_string(&m.paths.config).unwrap();
    assert!(cfg.contains(&format!("socket_path = [[{}]]", m.paths.sock.display())), "{cfg}");
    assert_eq!(std::fs::read_to_string(&m.paths.pid).unwrap(), "4000 777");
    assert!(!m.paths.lock.exists(), "啟動鎖用完就刪");
}

#[test]
fn pid_檔記的_mux_還在起_就等它_絕不起第二個() {
    let d = tempfile::tempdir().unwrap();
    let mut r = Fake::new();
    r.alive_once_started = false;
    let m = mux(&r, d.path());
    std::fs::create_dir_all(&m.paths.dir).unwrap();
    std::fs::write(&m.paths.pid, "3000 555").unwrap();
    r.birth.borrow_mut().insert(3000, 555);
    r.alive_after.set(Some(3)); // 第三次試連才連得上
    assert_eq!(m.ensure(), Ok(Ensure::Reused));
    assert!(r.started.borrow().is_empty(), "不起第二個");
    // 那個一直連不上：回錯誤，也不起第二個、不殺它
    let mut r2 = Fake::new();
    r2.alive_once_started = false;
    let m2 = mux(&r2, d.path());
    r2.birth.borrow_mut().insert(3000, 555);
    assert!(m2.ensure().is_err());
    assert!(r2.started.borrow().is_empty() && r2.killed.borrow().is_empty());
}

#[test]
fn pid_檔的程式編號被回收_建立時間對不上_當作沒有在跑() {
    let d = tempfile::tempdir().unwrap();
    let r = Fake::new();
    let m = mux(&r, d.path());
    std::fs::create_dir_all(&m.paths.dir).unwrap();
    std::fs::write(&m.paths.pid, "3000 555").unwrap();
    r.birth.borrow_mut().insert(3000, 999);
    assert_eq!(m.ensure(), Ok(Ensure::Started { pid: 4000 }));
    assert!(r.killed.borrow().is_empty(), "不殺編號被回收後的別人");
    assert_eq!(m.stop(), Ok(()));
    assert_eq!(*r.killed.borrow(), vec![4000]);
}

#[test]
fn 拿到鎖之後再試連一次_別的_ASN_剛起好就沿用() {
    let d = tempfile::tempdir().unwrap();
    let r = Fake::new();
    r.alive_after.set(Some(1)); // 第一次連不上，拿到鎖後第二次連得上
    assert_eq!(mux(&r, d.path()).ensure(), Ok(Ensure::Reused));
    assert!(r.started.borrow().is_empty());
}

#[test]
fn 起了卻一直連不上_只清自己剛起的那一個() {
    let d = tempfile::tempdir().unwrap();
    let mut r = Fake::new();
    r.alive_once_started = false;
    let m = mux(&r, d.path());
    assert!(m.ensure().unwrap_err().contains("起不來"));
    assert_eq!(*r.killed.borrow(), vec![4000]);
    assert!(!m.paths.pid.exists());
}

#[test]
fn 別的_ASN_拿著啟動鎖_等它_過期的鎖會清掉() {
    let d = tempfile::tempdir().unwrap();
    let r = Fake::new();
    let m = mux(&r, d.path());
    std::fs::create_dir_all(&m.paths.dir).unwrap();
    std::fs::write(&m.paths.lock, "").unwrap();
    // 新的鎖：等到上限就放棄，不起任何東西
    assert!(m.ensure().unwrap_err().contains("另一個 ASN 正在啟動"));
    assert!(r.started.borrow().is_empty());
    let old = std::time::SystemTime::now() - Duration::from_secs(120);
    let f = std::fs::File::options().write(true).open(&m.paths.lock).unwrap();
    f.set_modified(old).unwrap();
    drop(f);
    assert_eq!(m.ensure(), Ok(Ensure::Started { pid: 4000 }), "過期的鎖當作上一個 ASN 起到一半當掉");
}

#[test]
fn 停之前數得出有幾個窗格_停只停_pid_檔記的那一個() {
    let d = tempfile::tempdir().unwrap();
    let mut r = Fake::new();
    // 窗格 0（workspace default，Hold 留著的畫面）不算夥伴
    r.list_json = r#"[{"pane_id":0,"workspace":"default"},{"pane_id":1,"workspace":"asn-1"},{"pane_id":2,"workspace":"asn-2"}]"#.into();
    r.alive_after.set(Some(0));
    let m = mux(&r, d.path());
    assert_eq!(m.pane_count(), Ok(2));
    assert!(m.stop().is_err(), "沒有 pid 檔：不是 ASN 起的就不停");
    assert!(r.killed.borrow().is_empty());
}

#[test]
fn lua_長字串避開收尾記號() {
    assert_eq!(config_text(Path::new(r"C:\a\sock")).lines().nth(1).unwrap(), r#"return { exit_behavior = "Hold", unix_domains = { { name = 'asn', socket_path = [[C:\a\sock]] } } }"#);
    let t = config_text(Path::new(r"C:\a]]b\sock"));
    assert!(t.contains(r"[=[C:\a]]b\sock]=]"), "{t}");
}

#[test]
fn 只清更新留下的舊檔_而且只在_wezterm_資料夾這一層() {
    let d = tempfile::tempdir().unwrap();
    let w = d.path();
    for f in ["wezterm-mux-server.exe.old", "conpty.dll.old3", "wezterm-mux-server.exe", "notes.old", "conpty.dll.oldx"] {
        std::fs::write(w.join(f), "x").unwrap();
    }
    std::fs::create_dir_all(w.join("sub")).unwrap();
    std::fs::write(w.join("sub").join("conpty.dll.old"), "x").unwrap();
    assert_eq!(clean_old(w, &["wezterm-mux-server.exe", "conpty.dll"]), 2);
    let left: Vec<String> = std::fs::read_dir(w).unwrap().flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect();
    for keep in ["wezterm-mux-server.exe", "notes.old", "conpty.dll.oldx", "sub"] {
        assert!(left.contains(&keep.to_string()), "{keep} 要留著：{left:?}");
    }
    assert!(w.join("sub").join("conpty.dll.old").exists());
}

#[test]
fn 守門_脫離啟動的旗標_不繼承控制代碼_不帶_socket_進白名單() {
    let src = include_str!("../wezterm.rs").replace("\r\n", "\n");
    let det = &src[src.find("    fn spawn_detached(&self, program: &Path, args: &[String], env: &BTreeMap<String, String>) -> Result<u32, String> {\n        const").unwrap()..];
    assert!(det.contains("BREAKAWAY_FROM_JOB: u32 = 0x0100_0000") && det.contains("NEW_PROCESS_GROUP: u32 = 0x0000_0200"));
    let cp = &src[src.find("fn create_detached(").unwrap()..];
    assert!(cp.contains("0, // 不繼承控制代碼"), "std 的 Command 一律繼承控制代碼，mux 會一直握著 ASN 的輸出管道");
    assert!(cp.contains("CREATE_UNICODE_ENVIRONMENT") && cp.contains("env_block(env)"), "環境只有給的那些");
    let cfg = include_str!("../config.rs");
    assert!(!cfg.contains("WEZTERM_UNIX_SOCKET"), "socket 位置不進窗格白名單（接受的風險見 mux.rs 檔頭）");
}

/// 實測（要真的 WezTerm，預設不跑）：`ASN_MUX_REAL=<含 wezterm-mux-server.exe 的資料夾>` 才跑。
/// 從一個中介程序脫離啟動 mux、讓中介程序結束，mux 還在；最後只停自己起的那一個
#[test]
#[ignore]
fn 實測_起_mux_的程序結束後_mux_還在() {
    let Some(w) = std::env::var_os("ASN_MUX_REAL").map(PathBuf::from) else { return };
    let d = tempfile::tempdir().unwrap();
    let r = super::super::wezterm::RealRunner;
    let m = Mux { runner: &r, cli: w.join("wezterm.exe"), server: w.join(MUX_EXE), paths: paths(d.path()).unwrap(), base_env: super::super::config::child_env().into_iter().collect() };
    let Ensure::Started { pid } = m.ensure().unwrap() else { panic!("暫存資料夾裡不該已經有 mux") };
    assert_eq!(m.pane_count().unwrap(), 0, "窗格 0 已經結束");
    assert!(m.alive(), "窗格 0 結束後 mux 還活著");
    if let Some(f) = std::env::var_os("ASN_MUX_LEAVE") {
        // 留著讓外面在這個測試程序結束後確認 mux 還在（等於 ASN 結束），外面確認完照這個編號自己停
        std::fs::write(f, format!("{pid} {}", m.paths.dir.display())).unwrap();
        std::mem::forget(d);
        return;
    }
    m.stop().unwrap();
    std::thread::sleep(Duration::from_secs(1));
    assert!(!crate::heartbeat::pid_alive(pid));
}

#[cfg(windows)]
#[test]
fn 命令列引號_用_Windows_自己的拆法拆回來一字不差() {
    use super::super::wezterm::quote_arg;
    use windows_sys::Win32::UI::Shell::CommandLineToArgvW;
    let samples = ["plain", "", "有 空白", r#"a"b"#, r"C:\dir with space\", r"C:\x\", r#"x\"y"#, "a & b", "%PATH%", "^caret|pipe<>", r#"\\"\\"#, "tab\there"];
    let line = std::iter::once("prog.exe".to_string()).chain(samples.iter().map(|s| quote_arg(s))).collect::<Vec<_>>().join(" ");
    let w: Vec<u16> = line.encode_utf16().chain(std::iter::once(0)).collect();
    let mut n = 0i32;
    let back: Vec<String> = unsafe {
        let p = CommandLineToArgvW(w.as_ptr(), &mut n);
        assert!(!p.is_null());
        let v = (0..n as usize)
            .map(|i| {
                let s = *p.add(i);
                let len = (0..).take_while(|&k| *s.add(k) != 0).count();
                String::from_utf16_lossy(std::slice::from_raw_parts(s, len))
            })
            .collect();
        windows_sys::Win32::Foundation::LocalFree(p as _);
        v
    };
    assert_eq!(&back[1..], samples.map(String::from).as_slice(), "{line}");
}

#[test]
fn 環境區塊_只有給的變數_兩個零收尾() {
    use super::super::wezterm::env_block;
    let e: BTreeMap<String, String> = [("A".to_string(), "1".to_string()), ("B".to_string(), "x y".to_string())].into_iter().collect();
    let b = env_block(&e);
    assert_eq!(String::from_utf16_lossy(&b), "A=1\0B=x y\0\0");
    assert_eq!(env_block(&BTreeMap::new()), vec![0, 0]);
}

#[test]
fn 起了卻連不上_編號已被別的程式拿走就不殺() {
    let d = tempfile::tempdir().unwrap();
    let mut r = Fake::new();
    r.alive_once_started = false;
    r.reborn = true;
    assert!(mux(&r, d.path()).ensure().is_err());
    assert!(r.killed.borrow().is_empty(), "建立時間對不上：不是剛才起的那一個");
}

#[test]
fn 起了卻查不到建立時間_結束它並回錯_不留孤兒() {
    let d = tempfile::tempdir().unwrap();
    let mut r = Fake::new();
    r.no_birth = true;
    let m = mux(&r, d.path());
    assert!(m.ensure().unwrap_err().contains("查不到它的建立時間"));
    assert_eq!(*r.killed.borrow(), vec![4000], "用剛拿到的編號結束它");
    assert!(!m.paths.pid.exists());
}

#[test]
fn 啟動鎖_寫鎖的程序不在了才算過期_還在就等() {
    // 寫鎖的程序（3100）不在了：清掉鎖、照常起
    let d = tempfile::tempdir().unwrap();
    let r = Fake::new();
    let m = mux(&r, d.path());
    std::fs::create_dir_all(&m.paths.dir).unwrap();
    std::fs::write(&m.paths.lock, "3100 123").unwrap();
    assert_eq!(m.ensure(), Ok(Ensure::Started { pid: 4000 }));
    assert!(!m.paths.lock.exists() && !m.paths.dir.join(format!("start.lock.stale.{}", std::process::id())).exists(), "暫存名也清掉");
    // 寫鎖的程序（3200）還在：就算檔案很舊也等，等不到就放棄，不起任何東西、不動別人的鎖
    let d2 = tempfile::tempdir().unwrap();
    let r2 = Fake::new();
    r2.birth.borrow_mut().insert(3200, 456);
    let m2 = mux(&r2, d2.path());
    std::fs::create_dir_all(&m2.paths.dir).unwrap();
    std::fs::write(&m2.paths.lock, "3200 456").unwrap();
    let f = std::fs::File::options().write(true).open(&m2.paths.lock).unwrap();
    f.set_modified(std::time::SystemTime::now() - Duration::from_secs(3600)).unwrap();
    drop(f);
    assert!(m2.ensure().unwrap_err().contains("另一個 ASN 正在啟動"));
    assert!(r2.started.borrow().is_empty());
    assert_eq!(std::fs::read_to_string(&m2.paths.lock).unwrap(), "3200 456");
}

#[test]
fn 啟動鎖_判過期只看寫鎖的程序_內容還沒寫好的新鎖不算過期() {
    let d = tempfile::tempdir().unwrap();
    let p = d.path().join("start.lock");
    let r = Fake::new();
    r.birth.borrow_mut().insert(3300, 789);
    std::fs::write(&p, "3300 789").unwrap();
    assert!(!lock_stale(&p, "3300 789", &r), "主人還活著就不算過期");
    assert!(lock_stale(&p, "3100 123", &r), "主人不在了");
    assert!(lock_stale(&p, "3300 788", &r), "編號被回收（建立時間不同）也算不在");
    std::fs::write(&p, "").unwrap();
    assert!(!lock_stale(&p, "", &r), "剛建、內容還沒寫好的鎖不算過期");
}

#[test]
fn 守門_清過期的鎖先改名再核對內容_不直接刪() {
    let src = include_str!("../mux.rs").replace("\r\n", "\n");
    let body = &src[src.find("fn acquire(p: &Path, r: &dyn Runner)").unwrap()..src.find("fn lock_stale(").unwrap()];
    assert!(!body.contains("remove_file(p)"), "不能直接刪鎖檔（會刪到別人剛建的新鎖）");
    assert!(body.contains("std::fs::rename(p, &tmp)") && body.contains("== seen"));
}

#[test]
fn 登錄檔撞名與金鑰類名字_只看名字_不分大小寫() {
    let names: Vec<String> = ["Path", "asn_pi_name", "ASN_RELAY_KEY", "claude_code_x", "No_Color", "CLAUDE_CONFIG_DIR", "Temp", "irori_relay_anon_key"].iter().map(|s| s.to_string()).collect();
    let pane: BTreeMap<String, String> = [("PATH".to_string(), "x".to_string()), ("ASN_PI_NAME".to_string(), "小皮".to_string()), ("CLAUDE_CONFIG_DIR".to_string(), "D:/c".to_string())].into();
    let (collide, secret) = registry_conflicts(&names, &pane);
    assert_eq!(collide, ["Path", "asn_pi_name", "CLAUDE_CONFIG_DIR"], "窗格也要設的名字：登錄檔的值會蓋過去");
    assert_eq!(secret, ["ASN_RELAY_KEY", "claude_code_x", "No_Color", "irori_relay_anon_key"], "child_env 會濾掉的名字；CLAUDE_CONFIG_DIR 是例外");
    assert_eq!(registry_conflicts(&[], &pane), (vec![], vec![]));
}

#[test]
fn 讀登錄檔使用者變數名字_不當掉_名字裡沒有等號() {
    // 只驗不 panic、回的是名字（這台電腦的 HKCU\Environment 是什麼不管）；非 Windows 為空
    let n = user_env_names();
    assert!(n.iter().all(|s| !s.is_empty() && !s.contains('=')), "{n:?}");
}

#[test]
fn 撞名只看窗格自己的變數_跟共用白名單一樣的和_path_不算() {
    let base: BTreeMap<String, String> = [("PATH".to_string(), "C:/bin".to_string()), ("USERPROFILE".to_string(), "C:/u".to_string())].into();
    let mut pane = base.clone();
    pane.insert("ASN_PI_NAME".into(), "小皮".into());
    pane.insert("PATH".into(), "D:/extra;C:/bin".into());
    let names: Vec<String> = ["Path", "asn_pi_name", "UserProfile", "Temp"].iter().map(|s| s.to_string()).collect();
    assert_eq!(pane_collisions(&names, &pane, &base), ["asn_pi_name"], "PATH 不算；跟白名單一樣的 USERPROFILE 不是這個窗格自己的");
    assert!(pane_collisions(&names, &base, &base).is_empty(), "沒有逐窗格的變數就不會撞");
    assert!(pane_collisions(&[], &pane, &base).is_empty());
}

#[test]
fn 金鑰類變數的提示_只列名字_最多五個() {
    assert_eq!(secret_notice(&[]), None);
    assert_eq!(secret_notice(&["Path".to_string(), "Temp".to_string()]), None, "一般變數不提示");
    let one = secret_notice(&["Path".to_string(), "ASN_RELAY_KEY".to_string()]).unwrap();
    assert_eq!(one, "使用者環境變數裡有看起來像金鑰的變數（ASN_RELAY_KEY），會被帶進每個夥伴的終端；建議移到別處");
    assert!(!one.contains("Path"));
    let two = secret_notice(&["ASN_RELAY_KEY".to_string(), "claude_code_x".to_string()]).unwrap();
    assert!(two.contains("（ASN_RELAY_KEY、claude_code_x）"), "{two}");
    let many: Vec<String> = (0..8).map(|i| format!("CLAUDE_X{i}")).collect();
    let n = secret_notice(&many).unwrap();
    assert!(n.contains("CLAUDE_X4、…）") && !n.contains("CLAUDE_X5"), "{n}");
}

#[test]
fn 起好之後關掉_hold_留著的窗格_0() {
    let d = tempfile::tempdir().unwrap();
    let r = Fake::new();
    assert_eq!(mux(&r, d.path()).ensure(), Ok(Ensure::Started { pid: 4000 }));
    let kills: Vec<_> = r.cli_calls().into_iter().filter(|a| a.iter().any(|x| x == "kill-pane")).collect();
    assert_eq!(kills, vec![vec!["cli", "--no-auto-start", "kill-pane", "--pane-id", "0"].into_iter().map(String::from).collect::<Vec<_>>()]);
    // 沿用既有的 mux：不關任何窗格
    let r2 = Fake::new();
    r2.alive_after.set(Some(0));
    assert_eq!(mux(&r2, d.path()).ensure(), Ok(Ensure::Reused));
    assert!(r2.cli_calls().iter().all(|a| !a.iter().any(|x| x == "kill-pane")));
}

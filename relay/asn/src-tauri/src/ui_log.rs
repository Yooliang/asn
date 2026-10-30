//! 主視窗的記錄寫進檔案（#339 收尾）：畫面上 `[ASN]` 開頭的 console 記錄（收信失敗、ack 失敗、連線原因…）以前只進 devtools，
//! 事後查不到。前端（ui/lib/ui-log.mjs）每隔幾秒整批送來，這裡附加到機器資料夾的 ui.log（跟 bridge.log 放一起）。
//! 每行限長、拿掉控制字元；檔案超過 1 MB 就只留後半。寫不進去不影響畫面。
use std::path::{Path, PathBuf};

pub const UI_LOG_FILE: &str = "ui.log";
const MAX_BYTES: u64 = 1024 * 1024;
/// 一行最多幾個字（前端也會截，這裡再擋一次）
pub const LINE_MAX: usize = 500;
/// 一次最多收幾行（多的丟掉，不讓畫面一次塞爆檔案）
pub const LINES_MAX: usize = 200;

pub fn path(dir: &Path) -> PathBuf {
    dir.join(UI_LOG_FILE)
}

/// 設定頁「檢視記錄」要開的檔：只會是機器資料夾裡的 ui.log（路徑由這裡決定，不接受前端傳入）。
/// 還沒寫過記錄（檔案不存在）或同名的不是檔案，回錯誤，讓畫面退回開記錄資料夾
pub fn existing(dir: &Path) -> Result<PathBuf, String> {
    let p = path(dir);
    if p.is_file() {
        Ok(p)
    } else {
        Err("記錄檔還沒有產生".into())
    }
}

/// 一行記錄：拿掉控制字元（含換行），去頭尾空白，限長；整行空白回 None
pub fn clean_line(s: &str) -> Option<String> {
    let t: String = s.chars().map(|c| if c.is_control() { ' ' } else { c }).take(LINE_MAX).collect();
    let t = t.trim();
    (!t.is_empty()).then(|| t.to_string())
}

/// 附加一批記錄。回實際寫進去的行數
pub fn append(dir: &Path, lines: &[String]) -> Result<usize, String> {
    use std::io::Write;
    let rows: Vec<String> = lines.iter().take(LINES_MAX).filter_map(|l| clean_line(l)).collect();
    if rows.is_empty() {
        return Ok(0);
    }
    let p = path(dir);
    if std::fs::metadata(&p).map(|m| m.len() > MAX_BYTES).unwrap_or(false) {
        if let Ok(t) = std::fs::read_to_string(&p) {
            // 從中間往後找第一個換行再切：用位元組找（換行一定在字元邊界上）。
            // 以前用 t.get(t.len() / 2..)，中文一個字 3 個位元組，切在字中間會回 None，整個記錄就被清空
            let mid = t.len() / 2;
            let keep = t.as_bytes()[mid..].iter().position(|&b| b == b'\n').map(|i| &t[mid + i + 1..]).unwrap_or("");
            let _ = std::fs::write(&p, keep);
        }
    }
    let mut f = std::fs::OpenOptions::new().create(true).append(true).open(&p).map_err(|e| e.to_string())?;
    let mut text = rows.join("\n");
    text.push('\n');
    f.write_all(text.as_bytes()).map_err(|e| e.to_string())?;
    Ok(rows.len())
}

// ---------- 程式結束的原因（#1749：10-30 家用機閃退 4 次，panic 訊息沒進任何記錄，查不出是哪一行） ----------

/// panic 訊息裡看起來像權杖的長字串（32 字以上的英數與 `-_.+/=`）換成「…略…」；訊息最多留 200 字。
/// panic 訊息通常是「called `Option::unwrap()` on a `None` value」之類，但 expect 的字串可能帶進變數，保險起見再遮一次
pub fn redact(msg: &str) -> String {
    let mut out = String::new();
    let mut run = String::new();
    let flush = |run: &mut String, out: &mut String| {
        if run.chars().count() >= 32 {
            out.push_str("…略…");
        } else {
            out.push_str(run);
        }
        run.clear();
    };
    for c in msg.chars() {
        if c.is_ascii_alphanumeric() || "-_.+/=".contains(c) {
            run.push(c);
        } else {
            flush(&mut run, &mut out);
            out.push(c);
        }
    }
    flush(&mut run, &mut out);
    out.chars().take(200).collect()
}

/// panic 那一行：時間、執行緒名、檔案行號、遮過的訊息
pub fn panic_line(now_ms: i64, thread: Option<&str>, location: Option<(&str, u32, u32)>, msg: &str) -> String {
    let at = location.map(|(f, l, c)| format!("{f}:{l}:{c}")).unwrap_or_else(|| "不明".into());
    format!(
        "{} error [ASN] 程式錯誤結束（panic）：執行緒={} 位置={} 訊息={}",
        crate::claude_quota::iso_secs(now_ms),
        thread.unwrap_or("未命名"),
        at,
        redact(msg)
    )
}

/// 程式自己結束時寫一行原因；沒有這行就表示是被結束（工作管理員、關機、閃退）
pub fn exit_line(now_ms: i64, reason: &str) -> String {
    format!("{} info [ASN] 程式結束：{}", crate::claude_quota::iso_secs(now_ms), reason)
}

pub fn log_exit(dir: &Path, reason: &str) {
    if dir.as_os_str().is_empty() {
        return;
    }
    let _ = append(dir, &[exit_line(crate::heartbeat::now_ms() as i64, reason)]);
}

/// 裝 panic hook：把 panic 寫進 ui.log 就好，不再交給預設 hook。預設 hook 會寫 stderr，
/// 10-30 家用機閃退正是 stderr 是斷掉的管線、寫不進去才 panic，再寫一次只會在 hook 裡又失敗（#1767）。panic = "abort"，寫完程式就結束
pub fn install_panic_hook(dir: PathBuf) {
    if dir.as_os_str().is_empty() {
        return;
    }
    std::panic::set_hook(Box::new(move |info| {
        let msg = info
            .payload()
            .downcast_ref::<&str>()
            .map(|s| s.to_string())
            .or_else(|| info.payload().downcast_ref::<String>().cloned())
            .unwrap_or_default();
        let loc = info.location().map(|l| (l.file(), l.line(), l.column()));
        let t = std::thread::current();
        let _ = append(&dir, &[panic_line(crate::heartbeat::now_ms() as i64, t.name(), loc, &msg)]);
    }));
}

// ---------- 自己重開（#1771）：新程序的 stdin／stdout／stderr 一律接空，不繼承可能已斷的管線 ----------

/// 重開用的指令：同一個執行檔、同樣的參數，三個標準輸入輸出都接空、不開主控台視窗
pub fn relaunch_command(exe: &Path, args: &[std::ffi::OsString]) -> std::process::Command {
    use crate::nowin::NoWindow;
    let mut c = std::process::Command::new(exe);
    c.args(args).stdin(std::process::Stdio::null()).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null()).no_window();
    c
}

/// 新程序等舊程序結束用的參數：`--after-pid <舊 pid>`（不然舊的心跳還新鮮，新的會被判成「同名已在跑」自己退出）
pub const AFTER_PID_FLAG: &str = "--after-pid";
/// 舊程序最多等多久
pub const AFTER_PID_WAIT: std::time::Duration = std::time::Duration::from_secs(10);

/// 重開時給新程序的參數：拿掉舊的 `--after-pid <x>`，最後補上本程序的 pid
pub fn relaunch_args(old: &[std::ffi::OsString], my_pid: u32) -> Vec<std::ffi::OsString> {
    let mut out = Vec::new();
    let mut it = old.iter();
    while let Some(a) = it.next() {
        if a == AFTER_PID_FLAG {
            it.next();
            continue;
        }
        out.push(a.clone());
    }
    out.push(AFTER_PID_FLAG.into());
    out.push(my_pid.to_string().into());
    out
}

/// 從參數取 `--after-pid` 後面那個數字；沒有或不是數字回 None
pub fn after_pid(args: &[String]) -> Option<u32> {
    let i = args.iter().position(|a| a == AFTER_PID_FLAG)?;
    let v = args.get(i + 1)?;
    (!v.is_empty() && v.chars().all(|c| c.is_ascii_digit())).then(|| v.parse().ok()).flatten()
}

/// 等 pid 結束：只在它確定是 asn 時才等，最多 `timeout`。回傳是否已結束（不是 asn、本來就不在都算結束）
pub fn wait_gone(pid: u32, timeout: std::time::Duration, alive: impl Fn(u32) -> bool, is_asn: impl Fn(u32) -> Option<bool>) -> bool {
    if is_asn(pid) != Some(true) {
        return true;
    }
    let end = std::time::Instant::now() + timeout;
    while alive(pid) {
        if std::time::Instant::now() >= end {
            return false;
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
    true
}

/// 開一個新的自己（參數照舊，再帶 `--after-pid <本程序>`），成功回 Ok；呼叫端接著結束本程式。
/// 取代 tauri 的 `AppHandle::restart`（它讓新程序繼承本程序的 stderr）
pub fn relaunch_self() -> Result<(), String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let old: Vec<std::ffi::OsString> = std::env::args_os().skip(1).collect();
    relaunch_command(&exe, &relaunch_args(&old, std::process::id())).spawn().map(|_| ()).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn panic_那一行_有執行緒_檔案行號_訊息() {
        let l = panic_line(0, Some("tokio-runtime-worker"), Some(("src/bridge/core.rs", 12, 5)), "called `Option::unwrap()` on a `None` value");
        assert_eq!(l, "1970-01-01T00:00:00Z error [ASN] 程式錯誤結束（panic）：執行緒=tokio-runtime-worker 位置=src/bridge/core.rs:12:5 訊息=called `Option::unwrap()` on a `None` value");
        assert!(panic_line(0, None, None, "x").contains("執行緒=未命名 位置=不明"));
    }

    #[test]
    fn panic_訊息裡像權杖的長字串要遮掉_而且限長() {
        let tok = format!("sk-ant-oat01-{}", "A".repeat(40));
        let r = redact(&format!("bad token {tok} here"));
        assert_eq!(r, "bad token …略… here");
        assert!(!r.contains("AAAA"));
        assert!(!panic_line(0, None, None, &tok).contains("AAAA"), "寫進記錄的那一行也要遮");
        assert_eq!(redact("短字 abc123 不遮"), "短字 abc123 不遮");
        assert_eq!(redact(&"字".repeat(300)).chars().count(), 200);
    }

    #[test]
    fn panic_hook_真的寫進_ui_log() {
        let d = tempfile::tempdir().unwrap();
        let dir = d.path().to_path_buf();
        let h = std::thread::Builder::new()
            .name("測試執行緒".into())
            .spawn(move || {
                install_panic_hook(dir);
                let v: Option<u8> = None;
                v.expect("測試用的 panic");
            })
            .unwrap();
        assert!(h.join().is_err());
        let _ = std::panic::take_hook(); // 拆掉，別影響其他測試
        let t = std::fs::read_to_string(path(d.path())).unwrap();
        assert!(t.contains("程式錯誤結束（panic）") && t.contains("執行緒=測試執行緒") && t.contains("ui_log.rs:") && t.contains("訊息=測試用的 panic"), "{t}");
    }

    #[test]
    fn panic_hook_寫完_ui_log_不再交給預設_hook() {
        // 預設 hook 會寫 stderr；stderr 是斷掉的管線時會在 hook 裡再失敗一次（#1767）
        let src = include_str!("ui_log.rs");
        let hook = src.split("pub fn install_panic_hook").nth(1).unwrap().split("
}").next().unwrap();
        assert!(!hook.contains("take_hook") && !hook.contains("prev(info)"), "hook 不該再呼叫原本的 hook");
    }

    #[test]
    fn 重開自己_三個標準輸入輸出都接空_而且不再用_tauri_的_restart() {
        let src = include_str!("ui_log.rs");
        let f = src.split("pub fn relaunch_command").nth(1).unwrap().split("
}").next().unwrap();
        for k in [".stdin(std::process::Stdio::null())", ".stdout(std::process::Stdio::null())", ".stderr(std::process::Stdio::null())"] {
            assert!(f.contains(k), "缺 {k}");
        }
        let acct = include_str!("account.rs");
        assert!(!acct.contains("handle.restart()") && acct.contains("crate::ui_log::relaunch_self()"), "account.rs 的重開要走 relaunch_self");
    }

    #[test]
    fn 重開的新程序真的開得起來_輸出不接到本程序() {
        // 用系統內建的指令試：會往 stdout／stderr 寫字，接空也能正常結束
        #[cfg(windows)]
        let (exe, args) = (std::path::PathBuf::from(std::env::var("ComSpec").unwrap_or_else(|_| r"C:\Windows\System32\cmd.exe".into())), vec!["/c".into(), "echo out & echo err 1>&2".into()]);
        #[cfg(not(windows))]
        let (exe, args) = (std::path::PathBuf::from("/bin/sh"), vec!["-c".into(), "echo out; echo err 1>&2".into()]);
        let st = relaunch_command(&exe, &args).status().unwrap();
        assert!(st.success());
    }

    #[test]
    fn 重開參數_換掉舊的_after_pid_補上本程序() {
        let a: Vec<std::ffi::OsString> = ["--background", "--after-pid", "11", "asn://invite/x"].iter().map(|s| s.into()).collect();
        let out: Vec<String> = relaunch_args(&a, 42).into_iter().map(|s| s.into_string().unwrap()).collect();
        assert_eq!(out, ["--background", "asn://invite/x", "--after-pid", "42"]);
    }

    #[test]
    fn after_pid_只收數字() {
        let v = |xs: &[&str]| xs.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert_eq!(after_pid(&v(&["asn.exe", "--after-pid", "1234"])), Some(1234));
        assert_eq!(after_pid(&v(&["asn.exe", "--after-pid", "12a"])), None);
        assert_eq!(after_pid(&v(&["asn.exe", "--after-pid", "-5"])), None);
        assert_eq!(after_pid(&v(&["asn.exe", "--after-pid", "+5"])), None, "u32 的 parse 收 +5，這裡不收");
        assert_eq!(after_pid(&v(&["asn.exe", "--after-pid"])), None);
        assert_eq!(after_pid(&v(&["asn.exe"])), None);
    }

    #[test]
    fn 舊的還活著先等_結束後才往下_不是_asn_不等() {
        use std::sync::atomic::{AtomicU32, Ordering};
        let n = AtomicU32::new(0);
        // 前 3 次問都還活著，第 4 次結束
        let gone = wait_gone(7, std::time::Duration::from_secs(5), |_| n.fetch_add(1, Ordering::SeqCst) < 3, |_| Some(true));
        assert!(gone && n.load(Ordering::SeqCst) >= 4, "要等到舊的結束才回");
        // 一直活著：等到逾時回 false（照原規則判斷同名）
        assert!(!wait_gone(7, std::time::Duration::from_millis(250), |_| true, |_| Some(true)));
        // 那個 pid 不是 asn（被別的程式重用）或查不到：不等
        let t = std::time::Instant::now();
        assert!(wait_gone(7, std::time::Duration::from_secs(5), |_| true, |_| Some(false)));
        assert!(wait_gone(7, std::time::Duration::from_secs(5), |_| true, |_| None));
        assert!(t.elapsed() < std::time::Duration::from_secs(1));
    }

    #[test]
    fn 啟動時同名檢查之前先等_after_pid() {
        let src = include_str!("lib.rs");
        let wait = src.find("ui_log::wait_gone(").expect("run() 要等 --after-pid");
        let check = src.find("heartbeat::other_instance(&work_dir").unwrap();
        assert!(wait < check, "要在同名檢查之前等");
    }

    #[test]
    fn 自己結束寫一行原因_沒有資料夾就不寫() {
        let d = tempfile::tempdir().unwrap();
        log_exit(d.path(), "同一個視窗名已經有 ASN 在跑");
        assert!(std::fs::read_to_string(path(d.path())).unwrap().contains("info [ASN] 程式結束：同一個視窗名已經有 ASN 在跑"));
        log_exit(Path::new(""), "x"); // 不會 panic、不會寫到奇怪的地方
    }

    #[test]
    fn 每行拿掉控制字元_限長_空白行不寫() {
        assert_eq!(clean_line("  [ASN] pull failed\nx\t y  ").as_deref(), Some("[ASN] pull failed x  y"));
        assert_eq!(clean_line(" \n\t ").as_deref(), None);
        assert_eq!(clean_line(&"字".repeat(LINE_MAX + 50)).unwrap().chars().count(), LINE_MAX);
    }

    #[test]
    fn 超過上限修剪時_中文不會把整個記錄清空_開頭是一整行() {
        // asn真 審 #432：用位元組位置切，切在中文字中間 get 會回 None，整個檔案就被清空
        let d = tempfile::tempdir().unwrap();
        let line = "中".repeat(100);
        let mut text = String::new();
        while (text.len() as u64) <= MAX_BYTES {
            text.push_str(&line);
            text.push('\n');
        }
        // 確定中點落在字的中間（舊寫法會清空的情形）
        while text.is_char_boundary(text.len() / 2) {
            text.insert(0, 'a');
        }
        std::fs::write(path(d.path()), &text).unwrap();
        append(d.path(), &["最後一行".into()]).unwrap();
        let after = std::fs::read_to_string(path(d.path())).unwrap();
        assert!(after.len() > 1000, "修剪後不能是空的：{} bytes", after.len());
        assert!((after.len() as u64) < MAX_BYTES);
        assert_eq!(after.lines().next().unwrap(), line, "開頭是一整行，不留半個字");
        assert!(after.ends_with("最後一行\n"));
    }

    #[test]
    fn 檢視記錄_只開機器資料夾裡的_ui_log_沒有檔案就回錯誤() {
        let d = tempfile::tempdir().unwrap();
        assert!(existing(d.path()).is_err(), "還沒寫過記錄");
        std::fs::create_dir(path(d.path())).unwrap();
        assert!(existing(d.path()).is_err(), "同名的是資料夾也不開");
        std::fs::remove_dir(path(d.path())).unwrap();
        append(d.path(), &["[ASN] pull failed".into()]).unwrap();
        assert_eq!(existing(d.path()).unwrap(), d.path().join("ui.log"));
    }

    #[test]
    fn 附加到_ui_log_一次最多收_lines_max_行_超過一_mb_只留後半() {
        let d = tempfile::tempdir().unwrap();
        assert_eq!(append(d.path(), &["a".into(), " ".into(), "b".into()]).unwrap(), 2);
        assert_eq!(append(d.path(), &[]).unwrap(), 0);
        assert_eq!(std::fs::read_to_string(path(d.path())).unwrap(), "a\nb\n");
        let many: Vec<String> = (0..LINES_MAX + 30).map(|i| format!("line{i}")).collect();
        assert_eq!(append(d.path(), &many).unwrap(), LINES_MAX);
        // 灌到超過上限：下一次寫入前先砍成後半，檔案不會一直長大
        let big = "x".repeat(LINE_MAX);
        while std::fs::metadata(path(d.path())).unwrap().len() <= MAX_BYTES {
            append(d.path(), &vec![big.clone(); 100]).unwrap();
        }
        append(d.path(), &["最後一行".into()]).unwrap();
        let after = std::fs::read_to_string(path(d.path())).unwrap();
        assert!((after.len() as u64) < MAX_BYTES, "{}", after.len());
        assert!(after.ends_with("最後一行\n"));
        assert!(!after.starts_with('x') || after.lines().next().unwrap().len() == LINE_MAX, "砍在行尾，不留半行");
    }
}

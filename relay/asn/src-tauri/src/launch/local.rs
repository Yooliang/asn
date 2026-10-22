use super::config::{build_spawn_spec, check_launch, load_launch_config, LaunchReq};
use super::profiles::LaunchMode;
use crate::claude_accounts::claude_home;
use crate::claude_json::{claude_project_key, ensure_project_trusted};
use crate::launch::LocalLaunchReq;
use serde_json::{json, Value};
use std::path::Path;
use crate::nowin::NoWindow;
use std::process::{Command, Stdio};

pub fn partner_launch_local(_node: &str, work_dir: &Path, data_dir: &Path, req: LocalLaunchReq) -> Result<Value, String> {
    if req.profile.is_empty() || req.name.is_empty() || req.cwd.is_empty() {
        return Err("請填寫模型、名字與工作資料夾".into());
    }
    let mut config = load_launch_config()?;
    super::cwds::grant_local_cwd(&mut config, &req.cwd, &crate::identity::home_dir(), data_dir)?;
    let mut launch_req = LaunchReq {
        profile: &req.profile,
        name: &req.name,
        cwd: req.cwd.clone(),
    };
    check_launch(&config, &mut launch_req, &[], now_ms())?;
    let prof = config.profiles.get(&req.profile).ok_or_else(|| "沒有這個啟動設定".to_string())?;
    maybe_trust_claude_cwd(prof.engine.as_str(), &launch_req.cwd);

    if prof.mode == LaunchMode::Background {
        enqueue_background(work_dir, &req.profile, &req.name, &launch_req.cwd)?;
        return Ok(json!({ "ok": true, "mode": "background", "queued": true }));
    }

    let display_bg = req.display == "background";
    let (command, mut args, cwd) = build_spawn_spec(&config, &launch_req)?;
    // 預設接續同名夥伴上一段對話（issue #82）；沒有舊對話才新開
    let resumed = if req.fresh { None } else { super::resume::apply_resume_real(&mut args, &command, prof.engine.as_str(), &req.name, &launch_req.cwd) };
    let pid = start_window(&req.name, &command, &args, &cwd, display_bg)?;
    Ok(json!({
        "ok": true,
        "mode": "window",
        "pid": pid,
        "resumed": resumed.is_some(),
        "display": if display_bg { "background" } else { "foreground" }
    }))
}

/// 遠端開視窗（內建收發室橋）用：驗證（profile、名字、白名單、上限）都已在呼叫端做完，
/// 這裡只做「自動信任資料夾 → 依本機設定組命令 → 開視窗」。指令只來自本機的 profile，遠端只決定 profile 名、名字與資料夾。
/// hidden＝視窗樣式 Hidden（測試用，正式一律 false）。回傳外層視窗（PowerShell）的 PID。
pub fn start_remote_window(config: &super::config::LaunchConfig, profile: &str, name: &str, cwd: &str, hidden: bool) -> Result<u32, String> {
    let prof = config.profiles.get(profile).ok_or_else(|| "沒有這個啟動設定".to_string())?;
    // 沒寫 engine 的自訂 profile 與 Node 橋相同，視為 Claude
    maybe_trust_claude_cwd(if prof.engine.is_empty() { "claude" } else { prof.engine.as_str() }, cwd);
    let req = LaunchReq { profile, name, cwd: cwd.to_string() };
    let (command, mut args, cwd) = build_spawn_spec(config, &req)?;
    // 同本機開窗：預設接續同名夥伴上一段對話；hidden（測試用）不查真實的對話檔
    if !hidden {
        super::resume::apply_resume_real(&mut args, &command, if prof.engine.is_empty() { "claude" } else { prof.engine.as_str() }, name, &cwd.to_string_lossy());
    }
    start_window(name, &command, &args, &cwd, hidden)
}

/// Claude 引擎：在啟動前把 cwd_allow 內、本次使用的資料夾標成已信任（失敗只記 log，不擋啟動）。
fn maybe_trust_claude_cwd(engine: &str, cwd: &str) {
    if engine != "claude" {
        return;
    }
    let home = claude_home();
    let key = claude_project_key(Path::new(cwd));
    if let Err(e) = ensure_project_trusted(&home, &key) {
        eprintln!("開新夥伴前寫入 Claude 資料夾信任失敗（不影響啟動）：{e}");
    }
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn enqueue_background(work_dir: &Path, profile: &str, name: &str, cwd: &str) -> Result<(), String> {
    let file = work_dir.join("partner-queue.jsonl");
    if let Some(p) = file.parent() {
        std::fs::create_dir_all(p).map_err(|e| e.to_string())?;
    }
    let line = serde_json::to_string(&json!({ "profile": profile, "name": name, "cwd": cwd })).map_err(|e| e.to_string())?;
    use std::io::Write;
    let mut f = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&file)
        .map_err(|e| e.to_string())?;
    writeln!(f, "{line}").map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg_attr(windows, allow(dead_code))]
fn quote_arg(a: &str) -> String {
    if !a.is_empty() && !a.chars().any(|c| c.is_whitespace() || c == '"') {
        return a.to_string();
    }
    format!("\"{}\"", a.replace('\\', "\\\\").replace('"', "\\\""))
}

pub(super) fn start_window(title: &str, command: &str, args: &[String], cwd: &Path, hidden: bool) -> Result<u32, String> {
    #[cfg(windows)]
    {
        start_window_windows(title, command, args, cwd, hidden)
    }
    #[cfg(not(windows))]
    {
        let _ = title;
        start_window_unix(command, args, cwd)
    }
}

/// PowerShell 單引號字串（內部單引號加倍），整串都是字面值，不會展開 $ 或反引號。
#[cfg_attr(not(windows), allow(dead_code))]
pub(super) fn ps_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "''"))
}

/// 去掉 Windows 的長路徑前綴（canonicalize 會加）；不少 CLI 對它處理不一致，工作資料夾也會被當成不同的專案路徑。
#[cfg_attr(not(windows), allow(dead_code))]
pub(super) fn strip_verbatim_prefix(p: &str) -> String {
    if let Some(rest) = p.strip_prefix(r"\\?\UNC\") {
        return format!(r"\\{rest}");
    }
    p.strip_prefix(r"\\?\").unwrap_or(p).to_string()
}

/// 視窗裡實際執行的腳本：設標題、跑指令、指令結束後印出結束碼並停住，讓錯誤訊息看得到而不是視窗一閃就沒。
/// 啟動失敗（找不到檔案等）也會把錯誤原文印在視窗裡。
#[cfg_attr(not(windows), allow(dead_code))]
fn build_window_script(title: &str, command: &str, args: &[String]) -> String {
    let mut call = format!("& {}", ps_quote(command));
    for a in args {
        call.push(' ');
        call.push_str(&ps_quote(a));
    }
    format!(
        "try {{ $Host.UI.RawUI.WindowTitle = {title} }} catch {{}}\n\
         $code = 0\n\
         try {{\n\
         {call}\n\
         $code = $LASTEXITCODE\n\
         }} catch {{\n\
         Write-Host ('[ASN] 無法啟動：' + $_.Exception.Message) -ForegroundColor Red\n\
         $code = -1\n\
         }}\n\
         Write-Host ''\n\
         Write-Host ('[ASN] 程式已結束（結束碼 ' + $code + '）。上面如果有錯誤訊息請截圖回報；關閉這個視窗即可。') -ForegroundColor Yellow\n",
        title = ps_quote(title),
        call = call
    )
}

/// -EncodedCommand 要的格式：UTF-16LE 的 Base64，中文、空白與引號都不必再跳脫。
#[cfg_attr(not(windows), allow(dead_code))]
fn encode_ps_command(script: &str) -> String {
    use base64::Engine;
    let bytes: Vec<u8> = script.encode_utf16().flat_map(|u| u.to_le_bytes()).collect();
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

/// 外層 PowerShell（承載視窗）的參數字串：-NoExit 讓視窗留著。
#[cfg_attr(not(windows), allow(dead_code))]
pub(super) fn window_launcher_args(title: &str, command: &str, args: &[String]) -> String {
    let enc = encode_ps_command(&build_window_script(title, command, args));
    format!("-NoLogo -NoProfile -NoExit -ExecutionPolicy Bypass -EncodedCommand {enc}")
}

/// 解析啟動器的 stdout／stderr，得到外層視窗的 PID；失敗時把原文帶進錯誤。
#[cfg_attr(not(windows), allow(dead_code))]
fn parse_launcher_output(stdout: &str, stderr: &str, success: bool) -> Result<u32, String> {
    if let Ok(pid) = stdout.trim().parse::<u32>() {
        if pid > 0 {
            return Ok(pid);
        }
    }
    let detail = [stderr.trim(), stdout.trim()]
        .iter()
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
        .collect::<Vec<_>>()
        .join("\n");
    let detail: String = detail.chars().take(600).collect();
    let head = if success { "Start-Process 沒有回傳 PID" } else { "開不起來" };
    if detail.is_empty() {
        Err(head.to_string())
    } else {
        Err(format!("{head}：{detail}"))
    }
}

/// 回傳的 PID 是「承載視窗的 PowerShell」，不是 claude 本身（claude 是它的子程序、共用同一個主控台）。
/// 主控台顯示／隱藏另外靠 ~/.claude/sessions 依名字找 claude 的 PID，不依賴這個值。
#[cfg(windows)]
fn start_window_windows(title: &str, command: &str, args: &[String], cwd: &Path, hidden: bool) -> Result<u32, String> {
    // 失敗要大聲：舊版 Start-Process 出錯時 PowerShell 仍以結束碼 0 離開、stdout 空白、stderr 被丟掉，
    // 使用者只看到「沒有回傳 PID」。這裡 Stop + catch，錯誤原文走 stderr 並以結束碼 1 回報。
    let script = r#"
$ErrorActionPreference = 'Stop'
$a = $env:IRORI_LAUNCH_ARGS; $d = $env:IRORI_LAUNCH_DIR; $w = $env:IRORI_LAUNCH_STYLE
Remove-Item env:IRORI_LAUNCH_ARGS, env:IRORI_LAUNCH_DIR, env:IRORI_LAUNCH_STYLE -ErrorAction SilentlyContinue
if (-not $w) { $w = 'Normal' }
try {
  $p = Start-Process -FilePath ($env:SystemRoot + '\System32\WindowsPowerShell\v1.0\powershell.exe') -ArgumentList $a -WorkingDirectory $d -WindowStyle $w -PassThru
  [Console]::Out.Write($p.Id)
} catch {
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 1
}
"#;
    let root = std::env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".into());
    let ps = format!("{root}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
    let cwd_s = strip_verbatim_prefix(&cwd.to_string_lossy());
    let style = if hidden { "Hidden" } else { "Normal" };
    let mut cmd = Command::new(&ps);
    cmd.no_window()
        .env_clear()
        .envs(super::config::child_env())
        .args(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script])
        .env("IRORI_LAUNCH_ARGS", window_launcher_args(title, command, args))
        .env("IRORI_LAUNCH_DIR", &cwd_s)
        .env("IRORI_LAUNCH_STYLE", style)
        .current_dir(&cwd_s)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let out = cmd.output().map_err(|e| format!("開不起來：{e}"))?;
    parse_launcher_output(&String::from_utf8_lossy(&out.stdout), &String::from_utf8_lossy(&out.stderr), out.status.success())
}

#[cfg(not(windows))]
fn start_window_unix(command: &str, args: &[String], cwd: &Path) -> Result<u32, String> {
    let joined = std::iter::once(command)
        .chain(args.iter().map(String::as_str))
        .map(quote_arg)
        .collect::<Vec<_>>()
        .join(" ");
    if let Some(term) = pick_linux_terminal() {
        let mut cmd = Command::new(&term.binary);
        cmd.env_clear().envs(super::config::child_env());
        cmd.args(&term.args_prefix)
            .args(&term.args_suffix)
            .arg(&joined)
            .current_dir(cwd)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        let child = cmd.spawn().map_err(|e| format!("開不起來：{e}"))?;
        return Ok(child.id());
    }
    let mut cmd = Command::new(command);
    cmd.env_clear().envs(super::config::child_env());
    cmd.args(args).current_dir(cwd).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    let child = cmd.spawn().map_err(|e| format!("開不起來：{e}"))?;
    Ok(child.id())
}

#[cfg(not(windows))]
struct Term {
    binary: String,
    args_prefix: Vec<String>,
    args_suffix: Vec<String>,
}

#[cfg(not(windows))]
fn pick_linux_terminal() -> Option<Term> {
    let path = std::env::var("PATH").unwrap_or_default();
    let tries: &[(&str, &[&str], &[&str])] = &[
        ("gnome-terminal", &[] as &[&str], &["--", "bash", "-lc"]),
        ("konsole", &[], &["-e", "bash", "-lc"]),
        ("xfce4-terminal", &[], &["-e", "bash", "-lc"]),
        ("xterm", &[], &["-e", "bash", "-lc"]),
    ];
    for dir in path.split(':').filter(|d| !d.is_empty()) {
        for (name, pre, suf) in tries {
            let p = format!("{dir}/{name}");
            if std::path::Path::new(&p).is_file() {
                return Some(Term {
                    binary: p,
                    args_prefix: pre.iter().map(|s| s.to_string()).collect(),
                    args_suffix: suf.iter().map(|s| s.to_string()).collect(),
                });
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn decode(enc: &str) -> String {
        use base64::Engine;
        let bytes = base64::engine::general_purpose::STANDARD.decode(enc).unwrap();
        let u: Vec<u16> = bytes.chunks(2).map(|c| u16::from_le_bytes([c[0], c[1]])).collect();
        String::from_utf16(&u).unwrap()
    }

    #[test]
    fn 單引號加倍_其他字元照原樣() {
        assert_eq!(ps_quote("a b"), "'a b'");
        assert_eq!(ps_quote("it's"), "'it''s'");
        assert_eq!(ps_quote("$x `y \"z\""), "'$x `y \"z\"'");
    }

    #[test]
    fn 長路徑前綴被去掉() {
        assert_eq!(strip_verbatim_prefix(r"\\?\C:\Users\a b"), r"C:\Users\a b");
        assert_eq!(strip_verbatim_prefix(r"\\?\UNC\srv\share"), r"\\srv\share");
        assert_eq!(strip_verbatim_prefix(r"C:\x"), r"C:\x");
    }

    #[test]
    fn 視窗腳本_路徑有空白_名字有中文() {
        let args: Vec<String> = ["--dangerously-skip-permissions", "-n", "小良哥-1", "--remote-control", "小良哥-1"].iter().map(|s| s.to_string()).collect();
        let sc = build_window_script("小良哥-1", r"C:\Program Files\Claude Code\claude.exe", &args);
        assert!(sc.contains(r"& 'C:\Program Files\Claude Code\claude.exe' '--dangerously-skip-permissions' '-n' '小良哥-1' '--remote-control' '小良哥-1'"));
        assert!(sc.contains("WindowTitle = '小良哥-1'"));
        assert!(sc.contains("程式已結束"));
    }

    #[test]
    fn 外層參數有_noexit_且編碼可還原() {
        let args = vec!["-n".to_string(), "測 試".to_string()];
        let a = window_launcher_args("測 試", "claude", &args);
        assert!(a.contains("-NoExit"));
        let enc = a.rsplit(' ').next().unwrap();
        assert!(decode(enc).contains("& 'claude' '-n' '測 試'"));
    }

    #[test]
    fn 啟動器輸出解析() {
        assert_eq!(parse_launcher_output("1234", "", true), Ok(1234));
        assert_eq!(parse_launcher_output(" 77\r\n", "", true), Ok(77));
        let e = parse_launcher_output("", "找不到檔案", false).unwrap_err();
        assert!(e.contains("開不起來") && e.contains("找不到檔案"));
        assert_eq!(parse_launcher_output("", "", true).unwrap_err(), "Start-Process 沒有回傳 PID");
        assert!(parse_launcher_output("oops", "", true).unwrap_err().contains("oops"));
    }

    /// 真機手動測試：用 cmd /k 走同一條啟動路徑，確認有回傳 PID、視窗留著（3 秒後仍活著），最後只關自己開的那一棵。
    /// 執行：cargo test --manifest-path src-tauri/Cargo.toml -- --ignored 真機_視窗會留著 --nocapture
    #[cfg(windows)]
    #[test]
    #[ignore]
    fn 真機_視窗會留著() {
        let dir = std::env::temp_dir();
        let pid = start_window_windows("ASN 測試", "cmd.exe", &["/c".into(), "echo ASN 測試 & exit 3".into()], &dir, false).unwrap();
        println!("ASN_TEST_PID={pid}");
        std::thread::sleep(std::time::Duration::from_secs(3));
        let list = Command::new("tasklist").no_window().args(["/FI", &format!("PID eq {pid}"), "/NH"]).output().unwrap();
        let alive = String::from_utf8_lossy(&list.stdout).contains(&pid.to_string());
        let _ = Command::new("taskkill").no_window().args(["/PID", &pid.to_string(), "/T", "/F"]).output();
        assert!(alive, "指令結束後外層視窗應該還在（-NoExit）");
    }

    /// 回歸：舊版 Start-Process 失敗時結束碼 0、stdout 空白，錯誤原文被吞掉。現在要回傳帶原文的錯誤。
    #[cfg(windows)]
    #[test]
    fn 啟動失敗_錯誤原文會被帶出來() {
        let bad = Path::new(r"C:\ASN-不存在的資料夾-xyz");
        let e = start_window_windows("t", "cmd.exe", &[], bad, true).unwrap_err();
        assert!(e.starts_with("開不起來"), "{e}");
        assert!(e.len() > "開不起來：".len(), "{e}");
    }
}

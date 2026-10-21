use super::config::{build_spawn_spec, check_launch, load_launch_config, LaunchReq};
use super::profiles::LaunchMode;
use crate::launch::LocalLaunchReq;
use serde_json::{json, Value};
use std::path::Path;
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

    if prof.mode == LaunchMode::Background {
        enqueue_background(work_dir, &req.profile, &req.name, &launch_req.cwd)?;
        return Ok(json!({ "ok": true, "mode": "background", "queued": true }));
    }

    let display_bg = req.display == "background";
    let (command, args, cwd) = build_spawn_spec(&config, &launch_req)?;
    let pid = start_window(&command, &args, &cwd, display_bg)?;
    Ok(json!({
        "ok": true,
        "mode": "window",
        "pid": pid,
        "display": if display_bg { "background" } else { "foreground" }
    }))
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

fn quote_arg(a: &str) -> String {
    if !a.is_empty() && !a.chars().any(|c| c.is_whitespace() || c == '"') {
        return a.to_string();
    }
    format!("\"{}\"", a.replace('\\', "\\\\").replace('"', "\\\""))
}

fn start_window(command: &str, args: &[String], cwd: &Path, hidden: bool) -> Result<u32, String> {
    #[cfg(windows)]
    {
        start_window_windows(command, args, cwd, hidden)
    }
    #[cfg(not(windows))]
    {
        start_window_unix(command, args, cwd)
    }
}

#[cfg(windows)]
fn start_window_windows(command: &str, args: &[String], cwd: &Path, hidden: bool) -> Result<u32, String> {
    let script = r#"
$f = $env:IRORI_LAUNCH_FILE; $a = $env:IRORI_LAUNCH_ARGS; $d = $env:IRORI_LAUNCH_DIR; $w = $env:IRORI_LAUNCH_STYLE
Remove-Item env:IRORI_LAUNCH_FILE, env:IRORI_LAUNCH_ARGS, env:IRORI_LAUNCH_DIR, env:IRORI_LAUNCH_STYLE -ErrorAction SilentlyContinue
if (-not $w) { $w = 'Normal' }
$p = if ($a) { Start-Process -FilePath $f -ArgumentList $a -WorkingDirectory $d -WindowStyle $w -PassThru } else { Start-Process -FilePath $f -WorkingDirectory $d -WindowStyle $w -PassThru }
[Console]::Out.Write($p.Id)
"#;
    let root = std::env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".into());
    let ps = format!("{root}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
    let arglist = args.iter().map(|a| quote_arg(a)).collect::<Vec<_>>().join(" ");
    let style = if hidden { "Hidden" } else { "Normal" };
    let mut cmd = Command::new(&ps);
    cmd.args([
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        script,
    ])
    .env("IRORI_LAUNCH_FILE", command)
    .env("IRORI_LAUNCH_ARGS", arglist)
    .env("IRORI_LAUNCH_DIR", cwd.to_string_lossy().as_ref())
    .env("IRORI_LAUNCH_STYLE", style)
    .current_dir(cwd)
    .stdout(Stdio::piped())
    .stderr(Stdio::piped());
    let out = cmd.output().map_err(|e| format!("開不起來：{e}"))?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        return Err(format!("開不起來：{}", err.lines().next().unwrap_or("Start-Process 失敗")));
    }
    let pid: u32 = String::from_utf8_lossy(&out.stdout).trim().parse().map_err(|_| "Start-Process 沒有回傳 PID".to_string())?;
    Ok(pid)
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

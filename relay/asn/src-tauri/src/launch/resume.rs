//! 開同名夥伴視窗時預設接續上一段對話（issue #82）。
//! 找法：看 Claude 放在 `<設定資料夾>/projects/<資料夾編碼>/*.jsonl` 的對話檔，每個檔裡「最後一筆」標題記錄
//! （`custom-title`／`agent-name`，/rename 與 `-n` 都會寫）就是這段對話現在的名字；名字相同的檔取最近修改的那個，
//! 把它的 sessionId 以 `--resume <sessionId>` 放進啟動參數。找不到就維持原樣（新開）。
//! 只讀標題那幾行，不解析、不外傳對話內容。這個檔案格式是 Claude Code 的內部格式：認不得就當沒有，退回新開，不會擋啟動。
//! 守門：同名視窗還開著時不接續（照舊直接新開）；那段對話正被另一個活著的視窗使用（手開、被改過名字的也算）時，
//! 不再悄悄改開新對話，而是回錯誤請使用者切過去（兩個視窗寫同一段對話會互相覆蓋）。
use serde_json::Value;
use std::io::BufRead;
use std::path::{Path, PathBuf};

/// 最多看最近修改的幾個對話檔（舊的不用找）
const MAX_FILES: usize = 60;

/// Claude 把資料夾路徑編成 projects 底下的資料夾名：非英數字元一律換成 `-`
pub(super) fn project_dir_name(cwd: &str) -> String {
    cwd.chars().map(|c| if c.is_ascii_alphanumeric() { c } else { '-' }).collect()
}

fn find_project_dir(projects_root: &Path, cwd: &str) -> Option<PathBuf> {
    let want = project_dir_name(super::local::strip_verbatim_prefix(cwd).trim_end_matches(['\\', '/']));
    let exact = projects_root.join(&want);
    if exact.is_dir() {
        return Some(exact);
    }
    // Windows 磁碟機代號大小寫可能不同
    std::fs::read_dir(projects_root)
        .ok()?
        .flatten()
        .find(|e| e.file_name().to_string_lossy().eq_ignore_ascii_case(&want) && e.path().is_dir())
        .map(|e| e.path())
}

fn valid_session_id(s: &str) -> bool {
    !s.is_empty() && s.len() <= 64 && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// 一個對話檔現在的名字與編號：最後一筆標題記錄
fn last_title(path: &Path) -> Option<(String, String)> {
    let f = std::fs::File::open(path).ok()?;
    let mut rd = std::io::BufReader::new(f);
    let mut line = String::new();
    let mut found: Option<(String, Option<String>)> = None;
    loop {
        line.clear();
        match rd.read_line(&mut line) {
            Ok(0) | Err(_) => break,
            Ok(_) => {}
        }
        if !(line.contains("custom-title") || line.contains("agent-name")) {
            continue;
        }
        let Ok(v) = serde_json::from_str::<Value>(line.trim()) else { continue };
        let name = match v.get("type").and_then(Value::as_str) {
            Some("custom-title") => v.get("customTitle").and_then(Value::as_str),
            Some("agent-name") => v.get("agentName").and_then(Value::as_str),
            _ => None,
        };
        if let Some(n) = name {
            found = Some((n.to_string(), v.get("sessionId").and_then(Value::as_str).map(str::to_string)));
        }
    }
    let (name, sid) = found?;
    let sid = sid.or_else(|| path.file_stem().and_then(|s| s.to_str()).map(str::to_string))?;
    Some((name, sid))
}

/// 這個資料夾裡、名字相同的最近一段對話的 sessionId
pub(super) fn find_latest_session(projects_root: &Path, cwd: &str, name: &str) -> Option<String> {
    let dir = find_project_dir(projects_root, cwd)?;
    let mut files: Vec<(std::time::SystemTime, PathBuf)> = std::fs::read_dir(&dir)
        .ok()?
        .flatten()
        .filter(|e| e.path().extension().map(|x| x == "jsonl").unwrap_or(false))
        .filter_map(|e| Some((e.metadata().ok()?.modified().ok()?, e.path())))
        .collect();
    files.sort_by(|a, b| b.0.cmp(&a.0));
    for (_, p) in files.into_iter().take(MAX_FILES) {
        if let Some((n, sid)) = last_title(&p) {
            if n == name && valid_session_id(&sid) {
                return Some(sid);
            }
        }
    }
    None
}

/// 指令本身是不是 claude（claude／claude.exe／claude.cmd）；包在 cmd /c 或 sh -lc 裡的自訂指令不碰
pub(super) fn is_claude_command(command: &str) -> bool {
    let base = command.rsplit(['\\', '/']).next().unwrap_or(command).to_lowercase();
    let stem = base.rsplit_once('.').map(|(s, _)| s.to_string()).unwrap_or(base);
    stem == "claude"
}

/// 啟動參數裡已經自己指定要接續或固定編號：尊重它，不再加
fn has_session_flags(args: &[String]) -> bool {
    args.iter().any(|a| matches!(a.as_str(), "--resume" | "-r" | "--continue" | "-c" | "--session-id" | "--fork-session") || a.starts_with("--resume=") || a.starts_with("--session-id="))
}

/// 有同名的活視窗就回 true（對話編號的衝突改看 live_process::session_holders，不在這裡）
fn live_conflict(sessions: &[Value], name: &str, alive: &dyn Fn(u32) -> bool) -> bool {
    sessions.iter().any(|s| s.get("name").and_then(Value::as_str) == Some(name) && s.get("pid").and_then(Value::as_u64).and_then(|p| u32::try_from(p).ok()).map(alive).unwrap_or(false))
}

/// 這段對話已經有活著的視窗開著時給使用者看的說明
fn sid_conflict_error(holders: &[super::live_process::Holder]) -> String {
    let which = super::live_process::holder_name(holders).map(|n| format!("（{n}）")).unwrap_or_default();
    format!("這段對話已經有視窗開著{which}，請直接切過去；要開新的夥伴，請換一個名字，或先關掉那個視窗")
}

/// 在 claude 的啟動參數最前面加 `--resume <sessionId>`；回傳接續的 sessionId（沒加就是 Ok(None)）。
/// 同名視窗還活著就不接續（Ok(None)，照舊）；那段對話已被別的活視窗用著則回 Err（說明給使用者看），不悄悄改開新對話。
/// `config_dir`＝Claude 設定資料夾（有 projects 與 sessions 兩個子資料夾）；`holders`＝查某段對話現在有哪些活視窗在用。
pub(super) fn apply_resume(args: &mut Vec<String>, command: &str, engine: &str, name: &str, cwd: &str, config_dir: &Path, alive: &dyn Fn(u32) -> bool, holders: &dyn Fn(&str) -> Vec<super::live_process::Holder>) -> Result<Option<String>, String> {
    if !(engine == "claude" || engine.is_empty()) || !is_claude_command(command) || has_session_flags(args) {
        return Ok(None);
    }
    let Some(sid) = find_latest_session(&config_dir.join("projects"), cwd, name) else { return Ok(None) };
    if live_conflict(&super::console::read_sessions(&config_dir.join("sessions")), name, alive) {
        return Ok(None);
    }
    let held = holders(&sid);
    if !held.is_empty() {
        return Err(sid_conflict_error(&held));
    }
    args.splice(0..0, ["--resume".to_string(), sid.clone()]);
    Ok(Some(sid))
}

/// 真實環境：Claude 設定資料夾與程序存活判斷。找不到設定資料夾就當沒有舊對話（Ok(None)）
pub(super) fn apply_resume_real(args: &mut Vec<String>, command: &str, engine: &str, name: &str, cwd: &str) -> Result<Option<String>, String> {
    let Some(dir) = super::console::sessions_dir().and_then(|d| d.parent().map(|p| p.to_path_buf())) else { return Ok(None) };
    #[cfg(windows)]
    let alive = |p: u32| super::console::win::pid_alive(p);
    #[cfg(not(windows))]
    let alive = |_p: u32| false;
    let sessions_dir = dir.join("sessions");
    let holders = |sid: &str| {
        let os = super::switch::RealOs;
        super::live_process::session_holders(&os, &super::switch::Os::processes(&os), &super::console::read_sessions(&sessions_dir), sid, None)
    };
    apply_resume(args, command, engine, name, cwd, &dir, &alive, &holders)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(v: &[&str]) -> Vec<String> {
        v.iter().map(|x| x.to_string()).collect()
    }

    /// 在暫存的設定資料夾裡造一個對話檔；titles＝依序寫入的標題記錄
    fn mk_session(cfg: &Path, cwd: &str, sid: &str, titles: &[(&str, &str)], age_secs: u64) {
        let d = cfg.join("projects").join(project_dir_name(cwd));
        std::fs::create_dir_all(&d).unwrap();
        let mut text = String::from("{\"type\":\"user\",\"message\":\"agent-name 這行是對話內容，不是標題\"}\n");
        for (kind, n) in titles {
            let line = if *kind == "custom" {
                format!("{{\"type\":\"custom-title\",\"customTitle\":\"{n}\",\"sessionId\":\"{sid}\"}}\n")
            } else {
                format!("{{\"type\":\"agent-name\",\"agentName\":\"{n}\",\"sessionId\":\"{sid}\"}}\n")
            };
            text.push_str(&line);
        }
        let p = d.join(format!("{sid}.jsonl"));
        std::fs::write(&p, text).unwrap();
        let t = std::time::SystemTime::now() - std::time::Duration::from_secs(age_secs);
        std::fs::File::options().write(true).open(&p).unwrap().set_modified(t).unwrap();
    }

    fn no_alive(_: u32) -> bool {
        false
    }

    /// 沒有任何視窗佔著對話編號的情況下呼叫 apply_resume，回傳值照舊用 Option 比對（Err 一律當測試失敗）
    fn ar(args: &mut Vec<String>, command: &str, engine: &str, name: &str, cwd: &str, dir: &Path, alive: &dyn Fn(u32) -> bool) -> Option<String> {
        apply_resume(args, command, engine, name, cwd, dir, alive, &|_| Vec::new()).unwrap()
    }

    fn holder(pid: u32, name: Option<&str>) -> super::super::live_process::Holder {
        super::super::live_process::Holder { pid, name: name.map(str::to_string) }
    }

    #[test]
    fn 資料夾編碼_非英數都變橫線() {
        assert_eq!(project_dir_name(r"D:\Github\Yooliang\asn"), "D--Github-Yooliang-asn");
        assert_eq!(project_dir_name("/home/a b/擁有者"), "-home-a-b----");
    }

    #[test]
    fn 找最近一段同名對話_取最近修改的() {
        let d = tempfile::tempdir().unwrap();
        let cwd = r"D:\Work\proj";
        mk_session(d.path(), cwd, "old-1", &[("custom", "擁有者")], 5000);
        mk_session(d.path(), cwd, "new-2", &[("agent", "擁有者")], 100);
        mk_session(d.path(), cwd, "other-3", &[("custom", "別人")], 10);
        assert_eq!(find_latest_session(&d.path().join("projects"), cwd, "擁有者").as_deref(), Some("new-2"));
        assert_eq!(find_latest_session(&d.path().join("projects"), cwd, "沒有的名字"), None);
        // 磁碟機代號大小寫不同也找得到；\\?\ 前綴會被去掉
        assert_eq!(find_latest_session(&d.path().join("projects"), r"\\?\d:\Work\proj", "擁有者").as_deref(), Some("new-2"));
    }

    #[test]
    fn 後來改名了_以最後一筆標題為準() {
        let d = tempfile::tempdir().unwrap();
        let cwd = "/w/p";
        mk_session(d.path(), cwd, "aaa", &[("custom", "舊名"), ("custom", "新名")], 10);
        assert_eq!(find_latest_session(&d.path().join("projects"), cwd, "舊名"), None);
        assert_eq!(find_latest_session(&d.path().join("projects"), cwd, "新名").as_deref(), Some("aaa"));
    }

    #[test]
    fn 內文裡提到名字不算_壞行與壞編號略過() {
        let d = tempfile::tempdir().unwrap();
        let cwd = "/w/p";
        let dir = d.path().join("projects").join(project_dir_name(cwd));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("x.jsonl"), "{\"type\":\"user\",\"message\":\"custom-title 擁有者\"}\nnot json custom-title\n").unwrap();
        std::fs::write(dir.join("y.jsonl"), "{\"type\":\"custom-title\",\"customTitle\":\"擁有者\",\"sessionId\":\"a b;rm\"}\n").unwrap();
        assert_eq!(find_latest_session(&d.path().join("projects"), cwd, "擁有者"), None);
    }

    #[test]
    fn 沒有projects資料夾_回none() {
        let d = tempfile::tempdir().unwrap();
        assert_eq!(find_latest_session(&d.path().join("projects"), "/w/p", "擁有者"), None);
    }

    #[test]
    fn 只對claude指令加() {
        for c in ["claude", r"C:\Users\a\.local\bin\claude.exe", "/usr/bin/claude", r"C:\npm\claude.cmd"] {
            assert!(is_claude_command(c), "{c}");
        }
        for c in ["cmd.exe", "/bin/sh", "codex", "claude-wrapper", r"C:\claude\other.exe"] {
            assert!(!is_claude_command(c), "{c}");
        }
    }

    #[test]
    fn 加上resume_放在最前面_其餘照舊() {
        let d = tempfile::tempdir().unwrap();
        let cwd = "/w/p";
        mk_session(d.path(), cwd, "sess-1", &[("custom", "擁有者")], 10);
        let mut a = s(&["--dangerously-skip-permissions", "-n", "擁有者", "--remote-control", "擁有者"]);
        let r = ar(&mut a, "claude", "claude", "擁有者", cwd, d.path(), &no_alive);
        assert_eq!(r.as_deref(), Some("sess-1"));
        assert_eq!(a, s(&["--resume", "sess-1", "--dangerously-skip-permissions", "-n", "擁有者", "--remote-control", "擁有者"]));
    }

    #[test]
    fn 不加的情況() {
        let d = tempfile::tempdir().unwrap();
        let cwd = "/w/p";
        mk_session(d.path(), cwd, "sess-1", &[("custom", "擁有者")], 10);
        let base = s(&["-n", "擁有者"]);
        // 沒有舊對話
        let mut a = base.clone();
        assert!(ar(&mut a, "claude", "claude", "沒有", cwd, d.path(), &no_alive).is_none());
        assert_eq!(a, base);
        // 不是 claude 引擎或指令
        assert!(ar(&mut a, "claude", "codex", "擁有者", cwd, d.path(), &no_alive).is_none());
        assert!(ar(&mut a, "cmd.exe", "claude", "擁有者", cwd, d.path(), &no_alive).is_none());
        assert_eq!(a, base);
        // 使用者自己的 profile 已經指定接續
        for flag in ["--resume", "-c", "--continue", "--session-id", "-r"] {
            let mut a = s(&[flag, "x"]);
            assert!(ar(&mut a, "claude", "claude", "擁有者", cwd, d.path(), &no_alive).is_none(), "{flag}");
            assert_eq!(a, s(&[flag, "x"]));
        }
    }

    #[test]
    fn 同名的視窗還活著_不接續() {
        let d = tempfile::tempdir().unwrap();
        let cwd = "/w/p";
        mk_session(d.path(), cwd, "sess-1", &[("custom", "擁有者")], 10);
        let sd = d.path().join("sessions");
        std::fs::create_dir_all(&sd).unwrap();
        // 同名但已結束的記錄不擋
        std::fs::write(sd.join("11.json"), r#"{"pid":11,"name":"擁有者","sessionId":"zzz","kind":"interactive"}"#).unwrap();
        let mut a = s(&["-n", "擁有者"]);
        assert!(ar(&mut a, "claude", "claude", "擁有者", cwd, d.path(), &|p| p != 11).is_some());
        // 同名活著
        let mut a = s(&["-n", "擁有者"]);
        assert!(ar(&mut a, "claude", "claude", "擁有者", cwd, d.path(), &|p| p == 11).is_none());
    }

    /// 換個名字但同一段對話正被別的視窗開著：不再悄悄改開新對話，回要使用者看的錯誤（舊程式回 None＝靜默開新，這裡會紅）
    #[test]
    fn 同一段對話被別名視窗開著_回錯誤_不靜默開新() {
        let d = tempfile::tempdir().unwrap();
        let cwd = "/w/p";
        mk_session(d.path(), cwd, "sess-1", &[("custom", "擁有者")], 10);
        let mut a = s(&["-n", "擁有者"]);
        let held = |sid: &str| if sid == "sess-1" { vec![holder(11, Some("別名"))] } else { Vec::new() };
        let e = apply_resume(&mut a, "claude", "claude", "擁有者", cwd, d.path(), &no_alive, &held).unwrap_err();
        assert_eq!(e, "這段對話已經有視窗開著（別名），請直接切過去；要開新的夥伴，請換一個名字，或先關掉那個視窗");
        assert_eq!(a, s(&["-n", "擁有者"]), "不改啟動參數");
        // 名字取不到就省略括號那段
        let held = |_: &str| vec![holder(11, None)];
        let e = apply_resume(&mut s(&["-n", "擁有者"]), "claude", "claude", "擁有者", cwd, d.path(), &no_alive, &held).unwrap_err();
        assert!(e.contains("這段對話已經有視窗開著，請直接切過去") && e.contains("請換一個名字，或先關掉那個視窗") && !e.contains('（'), "{e}");
        // 同名活著照舊：不接續、不報錯，直接新開
        let sd = d.path().join("sessions");
        std::fs::create_dir_all(&sd).unwrap();
        std::fs::write(sd.join("11.json"), r#"{"pid":11,"name":"擁有者","sessionId":"zzz"}"#).unwrap();
        let mut a = s(&["-n", "擁有者"]);
        assert_eq!(apply_resume(&mut a, "claude", "claude", "擁有者", cwd, d.path(), &|p| p == 11, &held), Ok(None));
    }

    /// 守門：兩條開視窗的路徑（本機 UI、遠端 launch）都要呼叫接續；測試用的隱藏視窗不查真實的對話檔
    #[test]
    fn 守門_兩條開視窗路徑都接上接續() {
        let local = include_str!("local.rs");
        assert!(local.matches("super::resume::apply_resume_real(").count() >= 2, "partner_launch_local 與 start_remote_window 都要接續");
        assert!(local.contains("if show.real_resume {"), "測試用的隱藏視窗（real_resume＝false）不可讀真實的對話檔；正式路徑背景開也要接續（#931）");
    }
}

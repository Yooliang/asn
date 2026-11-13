//! 「命令列帶 `--resume <對話編號>` 的活 Claude 程序」判斷。視窗剛開、session 檔還沒寫出來的那段空檔，
//! 只有程序表看得到它。自動接回（auto_resume）與手動喚醒（partner_ops::resume）共用，兩邊對「已經在開」的看法才一致。
//! 只回有沒有，不回傳也不記錄命令列內容。
/// 命令列是不是接續這段對話：`--resume <編號>`、`-r <編號>`、`--resume=<編號>`、`--session-id <編號>`（引號與大小寫以外逐字相同）。
/// 只回有沒有，不回傳也不記錄命令列內容
pub(crate) fn cmdline_resumes(cmdline: &str, session: &str) -> bool {
    if session.is_empty() {
        return false;
    }
    let toks: Vec<&str> = cmdline.split_whitespace().map(|t| t.trim_matches('"')).collect();
    toks.iter().enumerate().any(|(i, t)| match *t {
        "--resume" | "-r" | "--session-id" => toks.get(i + 1).is_some_and(|v| *v == session),
        _ => t.strip_prefix("--resume=").is_some_and(|v| v == session),
    })
}

/// 程序表裡有沒有「活著、而且命令列接續這段對話」的 Claude 程序（只看 claude／node 的程序，不逐一讀所有程序的命令列）。
/// 讀不到命令列的程序當作不是
pub(crate) fn process_resumes(procs: &[super::switch::Proc], alive: &dyn Fn(u32) -> bool, cmdline: &dyn Fn(u32) -> Option<String>, session: &str) -> bool {
    procs.iter().filter(|p| p.name.starts_with("claude") || p.name == "node.exe" || p.name == "node").any(|p| alive(p.pid) && cmdline(p.pid).is_some_and(|c| cmdline_resumes(&c, session)))
}

/// 用給定的作業系統介面查：有沒有活程序在接續這段對話。對話編號格式不合就當沒有
pub(crate) fn os_resumes(os: &dyn super::switch::Os, session: &str) -> bool {
    if !crate::bridge::roster::valid_sid(session) {
        return false;
    }
    process_resumes(&os.processes(), &|p| os.alive(p), &|p| os.cmdline(p), session)
}

#[cfg(feature = "gui")]
pub(crate) fn real_resumes(session: &str) -> bool {
    os_resumes(&super::switch::RealOs, session)
}

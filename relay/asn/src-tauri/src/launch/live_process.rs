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
    resuming_pids(os, session).is_some()
}

/// 接續這段對話的活程序編號；沒有（或對話編號格式不合）回 None
pub(crate) fn resuming_pids(os: &dyn super::switch::Os, session: &str) -> Option<Vec<u32>> {
    if !crate::bridge::roster::valid_sid(session) {
        return None;
    }
    let pids: Vec<u32> = os
        .processes()
        .iter()
        .filter(|p| p.name.starts_with("claude") || p.name == "node.exe" || p.name == "node")
        .filter(|p| os.alive(p.pid) && os.cmdline(p.pid).is_some_and(|c| cmdline_resumes(&c, session)))
        .map(|p| p.pid)
        .collect();
    if pids.is_empty() {
        None
    } else {
        Some(pids)
    }
}

/// 啟動超過這麼久、程序還在，就當作可能卡住了（毫秒）
pub(crate) const STUCK_AFTER_MS: u64 = 5 * 60 * 1000;

/// 已經在線上或正在啟動的提示
pub(crate) const STARTING_HINT: &str = "這位夥伴已經在線上或正在啟動，請稍候";
/// 啟動太久的提示
pub(crate) const STUCK_HINT: &str = "可能卡住了，先關掉那個終端再喚醒";

/// 依程序的啟動時間挑提示：啟動滿 5 分鐘 → 可能卡住；未滿或查不到啟動時間 → 原句（純函式）
pub(crate) fn resume_block_hint(now_ms: u64, started_ms: Option<u64>) -> &'static str {
    match started_ms {
        Some(s) if now_ms.saturating_sub(s) >= STUCK_AFTER_MS => STUCK_HINT,
        _ => STARTING_HINT,
    }
}

/// 這段對話的活程序裡最早啟動的那個的啟動時間（任何一個查不到就不採用它）
pub(crate) fn earliest_started_ms(os: &dyn super::switch::Os, pids: &[u32]) -> Option<u64> {
    pids.iter().filter_map(|p| os.started_ms(*p)).min()
}

#[cfg(feature = "gui")]
pub(crate) fn real_resumes(session: &str) -> bool {
    os_resumes(&super::switch::RealOs, session)
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: u64 = 1_800_000_000_000;

    #[test]
    fn 啟動未滿五分鐘_維持原句() {
        assert_eq!(resume_block_hint(NOW, Some(NOW - 60_000)), STARTING_HINT);
        assert_eq!(resume_block_hint(NOW, Some(NOW - STUCK_AFTER_MS + 1)), STARTING_HINT);
    }

    #[test]
    fn 啟動滿五分鐘_提示可能卡住() {
        assert_eq!(resume_block_hint(NOW, Some(NOW - STUCK_AFTER_MS)), STUCK_HINT);
        assert_eq!(resume_block_hint(NOW, Some(NOW - 3_600_000)), STUCK_HINT);
        assert!(STUCK_HINT.contains("可能卡住了") && STUCK_HINT.contains("先關掉那個終端") && !STUCK_HINT.contains("工作管理員"));
    }

    #[test]
    fn 拿不到啟動時間_維持原句() {
        assert_eq!(resume_block_hint(NOW, None), STARTING_HINT);
    }

    #[test]
    fn 啟動時間比現在還晚_不當作卡住() {
        assert_eq!(resume_block_hint(NOW, Some(NOW + 1000)), STARTING_HINT);
    }
}

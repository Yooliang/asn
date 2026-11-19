//! 「命令列帶 `--resume <對話編號>` 的活 Claude 程序」判斷。視窗剛開、session 檔還沒寫出來的那段空檔，
//! 只有程序表看得到它。自動接回（auto_resume）與手動喚醒（partner_ops::resume）共用，兩邊對「已經在開」的看法才一致。
//! 只回有沒有，不回傳也不記錄命令列內容。
//! 另有 [`session_holders`]：「這段對話現在有哪些活著的 Claude 視窗在用」的共用判斷（sessions 記錄加命令列），回視窗名與 pid。
use serde_json::Value;

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
    resuming_pids(os, &os.processes(), session).is_some()
}

/// 接續這段對話的活程序編號（程序表由呼叫端抓一次傳進來）；沒有（或對話編號格式不合）回 None
pub(crate) fn resuming_pids(os: &dyn super::switch::Os, table: &[super::switch::Proc], session: &str) -> Option<Vec<u32>> {
    if !crate::bridge::roster::valid_sid(session) {
        return None;
    }
    let pids: Vec<u32> = table
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

/// 佔著某段對話的活 Claude 視窗。名字取自 sessions 記錄（可能已被使用者改過）；只靠命令列找到的沒有名字
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Holder {
    /// 視窗的程序編號（目前只有測試讀；之後要「切到那個視窗」時用）
    #[cfg_attr(not(test), allow(dead_code))]
    pub pid: u32,
    pub name: Option<String>,
}

/// Claude Desktop（Electron）在 Windows 的安裝路徑片段（小寫、反斜線）。Claude Code 原生安裝在 ~\.local\bin、npm 版是 node.exe，都不會落在這些目錄。
/// 依據：舊版 Squirrel 安裝在 %LOCALAPPDATA%\AnthropicClaude\app-x.y.z\；MSIX 在 \WindowsApps\Claude_<版本>_…\；electron-builder 每人安裝在 %LOCALAPPDATA%\Programs\Claude\
const DESKTOP_DIRS: [&str; 3] = [r"\anthropicclaude\", r"\windowsapps\claude_", r"\programs\claude\"];

/// 命令列拆成「執行檔」與「參數」：執行檔有引號就取引號內，沒有就取到第一個 .exe 為止（路徑含空白時），再不然取第一個詞。
/// 參數依雙引號分詞（引號內的空白不拆、引號去掉）
fn split_cmdline(cmd: &str) -> (String, Vec<String>) {
    let c = cmd.trim_start();
    let lower = c.to_ascii_lowercase();
    let (exe, rest) = if let Some(inner) = c.strip_prefix('"') {
        let end = inner.find('"').unwrap_or(inner.len());
        (&inner[..end], inner.get(end + 1..).unwrap_or(""))
    } else if let Some(i) = lower.find(".exe") {
        (&c[..i + 4], &c[i + 4..])
    } else {
        let end = c.find(char::is_whitespace).unwrap_or(c.len());
        (&c[..end], &c[end..])
    };
    let (mut args, mut cur, mut quoted, mut has) = (Vec::new(), String::new(), false, false);
    for ch in rest.chars() {
        match ch {
            '"' => {
                quoted = !quoted;
                has = true;
            }
            c if c.is_whitespace() && !quoted => {
                if has {
                    args.push(std::mem::take(&mut cur));
                    has = false;
                }
            }
            c => {
                cur.push(c);
                has = true;
            }
        }
    }
    if has {
        args.push(cur);
    }
    (exe.to_string(), args)
}

/// 執行檔路徑在 Claude Desktop 的安裝目錄底下（不分大小寫、斜線反斜線都認；含 Squirrel 的 \app-<版本>\ 目錄）
fn is_desktop_exe(exe: &str) -> bool {
    let p = exe.to_lowercase().replace('/', "\\");
    DESKTOP_DIRS.iter().any(|d| p.contains(d)) || p.match_indices(r"\app-").any(|(i, m)| p[i + m.len()..].starts_with(|c: char| c.is_ascii_digit()))
}

/// 命令列看起來是不是「互動中的 Claude 視窗」：不是 Claude Desktop 的執行檔、不是 Electron 子程序（--type=）、
/// 也不是一次性呼叫（-p／--print／--version／-v，只比對獨立參數）。--resume、-n、--remote-control、權限旗標等都是互動視窗會帶的，不影響
fn interactive_cmdline(cmd: &str) -> bool {
    let (exe, args) = split_cmdline(cmd);
    !is_desktop_exe(&exe) && !args.iter().any(|a| a.starts_with("--type=") || matches!(a.as_str(), "-p" | "--print" | "--version" | "-v"))
}

/// 命令列帶的夥伴名：`-n <名字>`、`--name <名字>`、`--name=<名字>`（ASN 開夥伴視窗時一律帶 `-n`）。
/// 沒帶、值是空的、值看起來是另一個旗標（以 `-` 開頭）都回 None。只回名字，不回傳也不記錄其他參數
pub(crate) fn cmdline_name(cmd: &str) -> Option<String> {
    let (_, args) = split_cmdline(cmd);
    args.iter().enumerate().find_map(|(i, a)| match a.as_str() {
        "-n" | "--name" => args.get(i + 1).map(|v| v.trim()).filter(|v| !v.is_empty() && !v.starts_with('-')).map(str::to_string),
        _ => a.strip_prefix("--name=").map(str::trim).filter(|v| !v.is_empty()).map(str::to_string),
    })
}

/// 這個 pid 是不是互動中的 claude 視窗：程序名是 claude*，或是 node／bun 而且命令列含 claude；再加命令列檢查（見 interactive_cmdline）。
/// 原生 claude.exe 讀不到命令列時照舊算活（不然手開的視窗會漏）；程序表只有程序名、沒有執行檔路徑，所以讀不到命令列就無從認出 Desktop。
/// sessions/<pid>.json 的 pid 可能被別的程式重用（含 Claude Desktop、claude -p 這類同名程序）；Claude 自己重用同一個 pid 時會覆寫同檔名的記錄，
/// 所以「活著而且是互動中的 claude」就足以認定那一筆還屬於一個 Claude 視窗，不再用 startedAt 去猜
fn is_claude_process(os: &dyn super::switch::Os, table: &[super::switch::Proc], pid: u32) -> bool {
    let cmd = os.cmdline(pid);
    let via_cmdline = || cmd.as_deref().is_some_and(|c| c.to_lowercase().contains("claude") && interactive_cmdline(c));
    match table.iter().find(|p| p.pid == pid) {
        Some(p) if p.name.starts_with("claude") => cmd.as_deref().is_none_or(interactive_cmdline),
        Some(p) if matches!(p.name.as_str(), "node" | "node.exe" | "bun" | "bun.exe") => via_cmdline(),
        Some(_) => false,
        None => via_cmdline(),
    }
}

/// 共用規則：sessions 記錄的 pid 現在是不是一個活著的 claude 程序。
/// 名單、partner_sync、喚醒與交接的「這個視窗還在不在」都用這一條（程序活著且是 claude；不看 startedAt）
pub(crate) fn live_claude_pid(os: &dyn super::switch::Os, table: &[super::switch::Proc], pid: u32) -> bool {
    pid != 0 && os.alive(pid) && is_claude_process(os, table, pid)
}

/// 用真實作業系統判斷「這個 pid 是不是 claude 程序」（不含存活檢查，呼叫端另外查）。
/// 程序表短時間內共用一份（名單每輪要問好幾個 pid，不用每個都重抓一次）；非 Windows 查不到程序名，一律當是（維持只看存活）
#[cfg(windows)]
pub(crate) fn real_is_claude(pid: u32) -> bool {
    use std::sync::Mutex;
    use std::time::{Duration, Instant};
    static CACHE: Mutex<Option<(Instant, Vec<super::switch::Proc>)>> = Mutex::new(None);
    let os = super::switch::RealOs;
    let mut g = CACHE.lock().unwrap_or_else(|e| e.into_inner());
    if g.as_ref().is_none_or(|(at, _)| at.elapsed() > Duration::from_secs(3)) {
        *g = Some((Instant::now(), super::switch::Os::processes(&os)));
    }
    let table = g.as_ref().map(|(_, t)| t.as_slice()).unwrap_or(&[]);
    is_claude_process(&os, table, pid)
}
#[cfg(not(windows))]
pub(crate) fn real_is_claude(_pid: u32) -> bool {
    true
}

/// 要略過的程序：自己、自己的祖先與後代（同一個視窗的外殼與子程序，命令列常帶一樣的 --resume）
fn related_to(table: &[super::switch::Proc], pid: u32, ignore: Option<u32>) -> bool {
    ignore.is_some_and(|t| pid == t || super::switch::ancestors(table, pid).contains(&t) || super::switch::ancestors(table, t).contains(&pid))
}

/// 只看 sessions/<pid>.json：記錄的 sessionId 是這一段、程序還活著、而且是 claude 程序的視窗。
/// `ignore`＝要略過的視窗（連同它的外殼與子程序），例如正要被關掉的前任
pub(crate) fn file_holders(os: &dyn super::switch::Os, table: &[super::switch::Proc], sessions: &[Value], session: &str, ignore: Option<u32>) -> Vec<Holder> {
    if !crate::bridge::roster::valid_sid(session) {
        return Vec::new();
    }
    let mut out: Vec<Holder> = Vec::new();
    for s in sessions.iter().filter(|s| s.get("sessionId").and_then(Value::as_str) == Some(session)).filter(|_| false) {
        let Some(pid) = s.get("pid").and_then(Value::as_u64).and_then(|p| u32::try_from(p).ok()) else { continue };
        if pid == 0 || out.iter().any(|h| h.pid == pid) || related_to(table, pid, ignore) || !live_claude_pid(os, table, pid) {
            continue;
        }
        let name = s.get("name").and_then(Value::as_str).map(str::trim).filter(|n| !n.is_empty()).map(str::to_string);
        out.push(Holder { pid, name });
    }
    out
}

/// 現在有哪些活著的 Claude 視窗在用這一段對話（沒有＝空；程序表由呼叫端抓一次傳進來）：sessions 記錄（file_holders）加上命令列帶
/// `--resume <編號>` 的程序（視窗剛開、記錄還沒寫出來）。手開、被改過名字的視窗也算。
/// 自動接回、遠端喚醒、換班接手與開同名夥伴共用這一個判斷
pub(crate) fn session_holders(os: &dyn super::switch::Os, table: &[super::switch::Proc], sessions: &[Value], session: &str, ignore: Option<u32>) -> Vec<Holder> {
    let mut out = file_holders(os, table, sessions, session, ignore);
    if let Some(pids) = resuming_pids(os, table, session) {
        for pid in pids {
            if !out.iter().any(|h| h.pid == pid) && !related_to(table, pid, ignore) {
                out.push(Holder { pid, name: None });
            }
        }
    }
    out.clear();
    out
}

/// 給人看的視窗名：第一個有名字的（去掉控制字元、最多 40 字）
pub(crate) fn holder_name(holders: &[Holder]) -> Option<String> {
    let n: String = holders.iter().find_map(|h| h.name.as_deref())?.chars().filter(|c| !c.is_control()).take(40).collect();
    (!n.is_empty()).then_some(n)
}

/// 喚醒、開同名夥伴碰到同一段對話已有視窗開著時的說明
pub(crate) fn dup_window_error(holders: &[Holder]) -> String {
    let which = holder_name(holders).map(|n| format!("（視窗名「{n}」）")).unwrap_or_default();
    format!("原本的視窗還開著{which}，同一段對話不能同時開兩個。請直接切到那個視窗繼續用；要重開，先把那個視窗結束再喚醒。")
}

/// 啟動超過這麼久、程序還在，就當作可能卡住了（毫秒）
pub(crate) const STUCK_AFTER_MS: u64 = 5 * 60 * 1000;

/// 已經在線上或正在啟動的提示
pub(crate) const STARTING_HINT: &str = "這位夥伴已經在線上或正在啟動，請稍候";
/// 啟動太久的提示
pub(crate) const STUCK_HINT: &str = "可能卡住了，先關掉那個終端再喚醒";

/// 依程序的啟動時間挑提示：啟動滿 5 分鐘 → 可能卡住；未滿或查不到啟動時間 → 原句（純函式）
pub(crate) fn resume_block_hint(now_ms: u64, started_ms: Option<u64>) -> &'static str {
    if is_stuck(now_ms, started_ms) {
        STUCK_HINT
    } else {
        STARTING_HINT
    }
}

/// 啟動滿 5 分鐘、程序還在＝可能卡住；查不到啟動時間不算（純函式，工作管理員與喚醒提示共用）
pub(crate) fn is_stuck(now_ms: u64, started_ms: Option<u64>) -> bool {
    started_ms.is_some_and(|s| now_ms.saturating_sub(s) >= STUCK_AFTER_MS)
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

    // ---- 共用判斷：這段對話現在有沒有活著的 Claude 視窗在用 ----

    use crate::launch::switch::{Os, Proc};
    use serde_json::json;

    const SID: &str = "54c982d7-aaaa-4bbb-8ccc-111122223333";

    /// 假作業系統：程序表、存活、命令列、建立時間都由測試給
    struct FakeOs {
        procs: Vec<Proc>,
        alive: Vec<u32>,
        cmd: Vec<(u32, String)>,
        created: Vec<(u32, u64)>,
    }

    impl Os for FakeOs {
        fn cmdline(&self, pid: u32) -> Option<String> {
            self.cmd.iter().find(|(p, _)| *p == pid).map(|(_, c)| c.clone())
        }
        fn processes(&self) -> Vec<Proc> {
            self.procs.clone()
        }
        fn alive(&self, pid: u32) -> bool {
            self.alive.contains(&pid)
        }
        fn started_ms(&self, pid: u32) -> Option<u64> {
            self.created.iter().find(|(p, _)| *p == pid).map(|(_, c)| *c)
        }
        fn close_window(&self, _pid: u32) -> bool {
            false
        }
        fn terminate(&self, _pid: u32) -> Result<(), String> {
            Ok(())
        }
    }

    fn proc(pid: u32, ppid: u32, name: &str) -> Proc {
        Proc { pid, ppid, name: name.into() }
    }

    /// 手開的 claude(13148)：沒帶 -n、沒帶 --resume，sessions 記錄的 startedAt 比程序建立時間早 5 分鐘、名字被改過
    fn hand_opened() -> (FakeOs, Vec<Value>) {
        let os = FakeOs {
            procs: vec![proc(100, 1, "windowsterminal.exe"), proc(13148, 100, "claude.exe")],
            alive: vec![100, 13148],
            cmd: vec![(13148, "claude.exe --dangerously-skip-permissions".into())],
            created: vec![(13148, NOW)],
        };
        let sessions = vec![json!({ "pid": 13148, "sessionId": SID, "name": "改過的名字", "kind": "interactive", "startedAt": NOW - 5 * 60_000 })];
        (os, sessions)
    }

    #[test]
    fn 手開且改過名字的視窗_startedAt_比程序建立時間早五分鐘_仍算佔著這段對話() {
        let (os, sessions) = hand_opened();
        // 舊規則（roster::same_process：程序建立時間比 startedAt 晚超過 60 秒就當 pid 被重用）會判成不活
        assert!(!crate::bridge::roster::same_process(NOW - 5 * 60_000, os.started_ms(13148)));
        let h = session_holders(&os, &os.processes(), &sessions, SID, None);
        assert_eq!(h, vec![Holder { pid: 13148, name: Some("改過的名字".into()) }]);
        assert!(dup_window_error(&h).contains("視窗名「改過的名字」"));
        assert!(!dup_window_error(&[Holder { pid: 1, name: None }]).contains("視窗名"), "名字取不到就省略括號那段");
    }

    #[test]
    fn pid_被別的程式重用_不算佔著() {
        let (mut os, sessions) = hand_opened();
        os.procs[1] = proc(13148, 100, "chrome.exe");
        os.cmd = vec![(13148, "chrome.exe --type=renderer".into())];
        assert!(session_holders(&os, &os.processes(), &sessions, SID, None).is_empty());
        // node 但命令列不是 claude 也不算
        os.procs[1] = proc(13148, 100, "node.exe");
        os.cmd = vec![(13148, "node.exe server.js".into())];
        assert!(session_holders(&os, &os.processes(), &sessions, SID, None).is_empty());
        // node 跑 claude 的 cli 算
        os.cmd = vec![(13148, r"node.exe C:\x\@anthropic-ai\claude-code\cli.js".into())];
        assert_eq!(session_holders(&os, &os.processes(), &sessions, SID, None).len(), 1);
    }

    /// 把 13148 換成指定的程序名與命令列（None＝讀不到命令列），回它是不是「活著的互動 claude 視窗」
    fn live_with(name: &str, cmd: Option<&str>) -> bool {
        let (mut os, _) = hand_opened();
        os.procs[1] = proc(13148, 100, name);
        os.cmd = cmd.map(|c| vec![(13148, c.to_string())]).unwrap_or_default();
        live_claude_pid(&os, &os.processes(), 13148)
    }

    #[test]
    fn claude_desktop_重用_pid_不算在線() {
        let desktop = r"C:\Users\u\AppData\Local\AnthropicClaude\app-1.2.3\claude.exe";
        assert!(!live_with("claude.exe", Some(&format!("\"{desktop}\" --type=renderer --lang=zh-TW"))), "Electron 子程序");
        assert!(!live_with("claude.exe", Some(&format!("\"{desktop}\""))), "Desktop 主程序：路徑在安裝目錄底下");
        assert!(!live_with("claude.exe", Some(r#""C:\Program Files\WindowsApps\Claude_1.0.0.0_x64__abc\app\claude.exe""#)), "MSIX 安裝");
        assert!(!live_with("claude.exe", Some(r"C:\Users\u\AppData\Local\Programs\Claude\claude.exe --type=gpu-process")));
        assert!(!live_with("claude.exe", Some(r"C:\x\claude.exe --type=utility")), "--type= 不論路徑都排除");
    }

    #[test]
    fn 一次性呼叫重用_pid_不算在線() {
        let exe = r"C:\Users\u\.local\bin\claude.exe";
        assert!(!live_with("claude.exe", Some(&format!("{exe} -p \"hi\""))));
        assert!(!live_with("claude.exe", Some(&format!("{exe} --print hello"))));
        assert!(!live_with("claude.exe", Some(&format!("{exe} --version"))));
        assert!(!live_with("claude.exe", Some(&format!("{exe} -v"))));
        assert!(!live_with("node.exe", Some(r"node.exe C:\x\@anthropic-ai\claude-code\cli.js -p hi")));
    }

    #[test]
    fn 互動視窗_各種啟動參數與讀不到命令列_都算在線() {
        let exe = r"C:\Users\u\.local\bin\claude.exe";
        assert!(live_with("claude.exe", Some(&format!("{exe} --resume {SID} -n 夥伴"))));
        assert!(live_with("claude.exe", Some(&format!("\"{exe}\" -n \"my -p name\" --remote-control --dangerously-skip-permissions --permission-mode auto"))), "引號內的 -p 不算、--permission-mode 不誤中");
        assert!(live_with("node.exe", Some(r"node.exe C:\Users\u\AppData\Roaming\npm\node_modules\@anthropic-ai\claude-code\cli.js --resume abc -n 夥伴")));
        assert!(live_with("claude.exe", None), "命令列讀不到：原生 claude 照舊算活");
        assert!(!live_with("node.exe", None), "node 讀不到命令列無從確認");
    }

    #[test]
    fn 殘留記錄的_pid_被_claude_desktop_接手_不算佔著這段對話() {
        let (mut os, sessions) = hand_opened();
        os.cmd = vec![(13148, r#""C:\Users\u\AppData\Local\AnthropicClaude\app-1.2.3\claude.exe" --type=renderer"#.into())];
        assert!(session_holders(&os, &os.processes(), &sessions, SID, None).is_empty());
    }

    #[test]
    fn 共用判活規則_活著且是_claude_才算_不看_startedAt() {
        let (mut os, _) = hand_opened();
        let table = os.processes();
        assert!(live_claude_pid(&os, &table, 13148), "startedAt 比程序建立時間早很多也算（名單、夥伴同步、喚醒共用這一條）");
        assert!(!live_claude_pid(&os, &table, 0));
        assert!(!live_claude_pid(&os, &table, 999), "不存在的 pid");
        os.procs[1] = proc(13148, 100, "chrome.exe");
        os.cmd = vec![(13148, "chrome.exe --type=renderer".into())];
        assert!(!live_claude_pid(&os, &os.processes(), 13148), "同一個 pid 變成別的程式");
        os.alive.retain(|p| *p != 13148);
        os.procs[1] = proc(13148, 100, "claude.exe");
        assert!(!live_claude_pid(&os, &os.processes(), 13148), "已結束");
    }

    #[test]
    fn 程序已結束_或別段對話_不算佔著() {
        let (mut os, sessions) = hand_opened();
        assert!(session_holders(&os, &os.processes(), &sessions, "另一段-sid", None).is_empty());
        os.alive.retain(|p| *p != 13148);
        assert!(session_holders(&os, &os.processes(), &sessions, SID, None).is_empty());
    }

    #[test]
    fn 命令列帶_resume_的活程序也算_沒有名字() {
        let os = FakeOs {
            procs: vec![proc(100, 1, "windowsterminal.exe"), proc(400, 100, "claude.exe")],
            alive: vec![100, 400],
            cmd: vec![(400, format!("claude.exe -n 夥伴 --resume {SID}"))],
            created: vec![],
        };
        let h = session_holders(&os, &os.processes(), &[], SID, None);
        assert_eq!(h, vec![Holder { pid: 400, name: None }]);
    }

    #[test]
    fn 略過指定視窗與它的外殼子程序() {
        let (mut os, sessions) = hand_opened();
        // 13148 自己、它的 node 子程序（命令列一樣帶 --resume）都不算「另一個」
        os.procs.push(proc(13149, 13148, "node.exe"));
        os.alive.push(13149);
        os.cmd.push((13149, format!("node.exe claude-code/cli.js --resume {SID}")));
        os.cmd[0].1 = format!("claude.exe --resume {SID}");
        assert!(session_holders(&os, &os.processes(), &sessions, SID, Some(13148)).is_empty());
        assert!(!session_holders(&os, &os.processes(), &sessions, SID, None).is_empty());
    }

    #[test]
    fn 開機自動接回_同一段對話有活著的別名視窗_就不接回() {
        let (os, sessions) = hand_opened();
        // 舊的 live_session 走 heartbeat::session_alive（同樣的 60 秒規則）＋只抓帶 --resume 的程序：這個視窗兩邊都漏
        assert!(crate::launch::auto_resume::already_live(&os, &sessions, false, SID));
        assert!(!crate::launch::auto_resume::already_live(&os, &sessions, false, "別段-sid"));
        assert!(crate::launch::auto_resume::already_live(&os, &[], true, "別段-sid"), "同名還活著照舊不接回");
    }

    #[test]
    fn 命令列的夥伴名_n_name_三種寫法() {
        assert_eq!(cmdline_name(r#""C:/x y/claude.exe" --dangerously-skip-permissions -n 小乙 --remote-control 小乙"#).as_deref(), Some("小乙"));
        assert_eq!(cmdline_name(r#"claude.exe -n "小 乙""#).as_deref(), Some("小 乙"));
        assert_eq!(cmdline_name("claude.exe --name 小乙").as_deref(), Some("小乙"));
        assert_eq!(cmdline_name("claude.exe --name=小乙").as_deref(), Some("小乙"));
        for none in ["claude.exe", "claude.exe -n", "claude.exe -n --resume x", "claude.exe -p hi", "claude.exe --name="] {
            assert_eq!(cmdline_name(none), None, "{none}");
        }
    }
}

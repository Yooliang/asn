//! Codex 視窗的「關閉」與「切換模型」（#235）。
//!
//! **未用真的 Codex 實機驗證**（這台家用機沒有 Codex，也沒有帳號）：
//! 官方文件只確認啟動時可指定模型（`codex --model <名稱>`）、互動中可用 `/model`；`codex resume` 能不能同時換模型沒有官方依據。
//! 所以下面的行為都用「假的作業系統與假的 Codex 命令列」驗證邏輯；等有帳號要補實測：
//!   1. 用 `codex resume <名字或 thread 編號>` 開的視窗，命令列長什麼樣（是 codex.exe 還是 node 包著、有沒有子程序）；
//!   2. `codex -m <模型> resume <名字>` 重開後，是不是真的接續原對話並用新模型；
//!   3. 結束行程後，thread 的鎖（thread-writer-locks）是不是會釋放。
//!
//! 做法與 Claude 視窗一致（bridge/partner_ops.rs）：
//! - 名單上的 Codex 視窗沒有 pid（只有 thread 鎖），所以從「正在跑的程序」找：執行檔是 codex、命令列有 `resume <名字或 thread 編號>`，
//!   而且剛好一個才動手（多個或沒有一律回錯，不猜）；包裝程序與它的子程序同時符合時取最上層那個。
//! - 關閉：用 launch/switch.rs 的 `kill_set` 守門（只結束目標與它的後代，永遠不含 ASN 自己與它的祖先）＋ `close_session`。
//! - 切換模型：關閉後照原命令列重開，去掉舊的 `-m`／`--model`，在 `resume` 前面插入 `-m <新模型>`；
//!   重開後確認出現新的 codex 程序（不是舊 pid、命令列帶著新模型與同一個接續目標）。
//! - 對話進行中（名單狀態忙碌）不動，回「等它閒置」。
use crate::launch::switch::{asn_host_of, close_session, in_windows_terminal, is_idle, kill_set, manual_command, parse_cmdline, wait_until, Os, Plan, Proc, Timing};
use serde_json::{json, Value};
use std::path::PathBuf;

/// Codex 模型名稱：英數與 . _ : - /（例如 gpt-5.5、gpt-5.6-sol），不能以 - 開頭（免得被當成旗標），最長 64
pub fn valid_codex_model(m: &str) -> bool {
    !m.is_empty() && m.chars().count() <= 64 && !m.starts_with('-') && m.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | ':' | '-' | '/'))
}

/// 找到的 Codex 程序（已確認是目標視窗）
#[derive(Clone, Debug)]
pub struct CodexTarget {
    pub pid: u32,
    /// 完整命令列（含程式本身）
    pub args: Vec<String>,
    /// 接續目標（`resume` 後面那個：名字或 thread 編號）
    pub resume_target: String,
}

fn exe_stem(token: &str) -> String {
    let base = token.rsplit(['/', '\\']).next().unwrap_or(token).to_ascii_lowercase();
    base.strip_suffix(".exe").or_else(|| base.strip_suffix(".cmd")).or_else(|| base.strip_suffix(".js")).unwrap_or(&base).to_string()
}

/// 這個命令列是不是 codex：第一個字或第二個字（node／bun 包著跑 codex.js）的檔名主體是 codex
fn is_codex_cmd(args: &[String]) -> bool {
    args.first().map(|a| exe_stem(a) == "codex").unwrap_or(false) || (args.len() >= 2 && matches!(exe_stem(&args[0]).as_str(), "node" | "bun") && exe_stem(&args[1]) == "codex")
}

/// `resume` 後面第一個不是旗標的字（接續目標）。沒有 resume、或 resume 後面沒給目標＝None
pub fn resume_target(args: &[String]) -> Option<String> {
    let i = args.iter().position(|a| a == "resume")?;
    args[i + 1..].iter().find(|a| !a.starts_with('-')).cloned()
}

/// 目前的模型：最後一個 `-m <值>`／`--model <值>`／`--model=<值>`；沒有＝None
pub fn current_model(args: &[String]) -> Option<String> {
    let mut found = None;
    let mut i = 1;
    while i < args.len() {
        let a = &args[i];
        if a == "-m" || a == "--model" {
            if let Some(v) = args.get(i + 1) {
                found = Some(v.clone());
            }
            i += 2;
            continue;
        }
        if let Some(v) = a.strip_prefix("--model=") {
            found = Some(v.to_string());
        }
        i += 1;
    }
    found.filter(|m| !m.is_empty())
}

/// 照原命令列重開用的新參數：去掉舊的 -m／--model（含值），在 `resume` 前面插入 `-m <新模型>`；其餘原樣。
/// 原命令列沒有 `resume` 時改用 `resume <接續目標>` 接在最後（保證接續同一段對話）
pub fn rewrite_args(args: &[String], resume_to: &str, model: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::with_capacity(args.len() + 3);
    let mut i = 0;
    while i < args.len() {
        let a = &args[i];
        if i > 0 && (a == "-m" || a == "--model") {
            i += 2;
            continue;
        }
        if i > 0 && a.starts_with("--model=") {
            i += 1;
            continue;
        }
        out.push(a.clone());
        i += 1;
    }
    match out.iter().position(|a| a == "resume") {
        Some(p) => {
            out.insert(p, model.to_string());
            out.insert(p, "-m".to_string());
        }
        None => {
            out.push("-m".to_string());
            out.push(model.to_string());
            out.push("resume".to_string());
            out.push(resume_to.to_string());
        }
    }
    out
}

/// 在正在跑的程序裡找出要動的 Codex：命令列的 resume 目標等於 `name` 或 `thread_id`。
/// 剛好一個才算；包裝程序與它的子程序同時符合時取最上層（沒有符合的祖先）那個。
pub(crate) fn resolve(os: &dyn Os, table: &[Proc], name: &str, thread_id: &str) -> Result<CodexTarget, String> {
    if name.is_empty() && thread_id.is_empty() {
        return Err("缺少視窗名字".into());
    }
    let mut hits: Vec<CodexTarget> = vec![];
    for p in table {
        if p.pid == 0 || !os.alive(p.pid) {
            continue;
        }
        let Some(line) = os.cmdline(p.pid) else { continue };
        let args = parse_cmdline(&line);
        if !is_codex_cmd(&args) {
            continue;
        }
        let Some(t) = resume_target(&args) else { continue };
        if (!name.is_empty() && t == name) || (!thread_id.is_empty() && t == thread_id) {
            hits.push(CodexTarget { pid: p.pid, args, resume_target: t });
        }
    }
    let pids: Vec<u32> = hits.iter().map(|h| h.pid).collect();
    let tops: Vec<CodexTarget> = hits.into_iter().filter(|h| !crate::launch::switch::ancestors(table, h.pid).iter().any(|a| *a != h.pid && pids.contains(a))).collect();
    match tops.len() {
        0 => Err("找不到這個 Codex 視窗的程序（可能已經關了，或不是用 codex resume 開的）".into()),
        1 => Ok(tops.into_iter().next().unwrap()),
        _ => Err("有不只一個符合的 Codex 視窗，無法確定是哪一個，請先在電腦上處理".into()),
    }
}

/// 守門：算出這次允許結束的 pid（含它的後代與直接父殼）。目標不在允許清單裡（例如是 ASN 自己或它的祖先）就拒絕
fn guard(os: &dyn Os, table: &[Proc], t: &CodexTarget) -> Result<(Option<u32>, Vec<u32>, bool), String> {
    let host = asn_host_of(os, table, t.pid);
    let allowed = kill_set(table, t.pid, host, os.own_pid());
    if !allowed.contains(&t.pid) {
        return Err("守門：這個程序不允許結束".into());
    }
    Ok((host, allowed, in_windows_terminal(table, t.pid)))
}

/// 關閉 Codex 視窗。使用者自己開的視窗（沒有 ASN 承載殼）不送關閉訊息，只結束 codex 與子孫，留下終端機
pub(crate) fn close(os: &dyn Os, timing: &Timing, name: &str, thread_id: &str, status: Option<&str>) -> Result<Value, String> {
    if !is_idle(status) {
        return Err("對話進行中，等它閒置再關閉".into());
    }
    let table = os.processes();
    let t = resolve(os, &table, name, thread_id)?;
    let (host, allowed, _) = guard(os, &table, &t)?;
    close_session(os, timing, t.pid, &allowed, host, host.is_some())?;
    let kept = host.is_none();
    Ok(json!({ "pid": t.pid, "kept_terminal": kept, "detail": if kept { "已結束 Codex；原本的終端機分頁會留下" } else { "已關閉視窗" } }))
}

/// 切換 Codex 視窗的模型：關閉後照原命令列重開（`-m <新模型>` 插在 `resume` 前），確認出現新的 codex 程序。
/// `cwd`＝這個視窗的工作資料夾（名單的 cwd）；要真的存在才動手。`launch` 負責真的開新視窗
pub(crate) fn switch_model(os: &dyn Os, timing: &Timing, name: &str, thread_id: &str, status: Option<&str>, cwd: &str, model: &str, launch: &dyn Fn(&Plan) -> Result<(), String>) -> Result<Value, String> {
    if !valid_codex_model(model) {
        return Err("模型名稱不合法".into());
    }
    if !is_idle(status) {
        return Err("對話進行中，等它閒置再切換".into());
    }
    let dir = PathBuf::from(crate::launch::local::strip_verbatim_prefix(cwd));
    if cwd.is_empty() || !dir.is_dir() {
        return Err(format!("工作資料夾不存在：{cwd}"));
    }
    let table = os.processes();
    let t = resolve(os, &table, name, thread_id)?;
    let (host, allowed, in_wt) = guard(os, &table, &t)?;
    let argv = rewrite_args(&t.args, &t.resume_target, model);
    let manual = manual_command(&dir.to_string_lossy(), &argv);
    let old: Vec<u32> = table.iter().map(|p| p.pid).collect();
    close_session(os, timing, t.pid, &allowed, host, host.is_some()).map_err(|e| format!("{e}（手動：{manual}）"))?;
    let plan = Plan { name: name.to_string(), cwd: dir, argv, in_wt };
    launch(&plan).map_err(|e| format!("原視窗已關閉，但重開失敗：{e}（手動：{manual}）"))?;
    // 確認出現新的 codex 程序：不是舊 pid、活著、接續目標相同、命令列帶著新模型
    let mut found: Option<u32> = None;
    let appeared = wait_until(os, timing.appear_wait_ms, timing.poll_ms, || {
        for p in os.processes() {
            if old.contains(&p.pid) || !os.alive(p.pid) {
                continue;
            }
            let Some(line) = os.cmdline(p.pid) else { continue };
            let args = parse_cmdline(&line);
            if is_codex_cmd(&args) && resume_target(&args).as_deref() == Some(t.resume_target.as_str()) && current_model(&args).as_deref() == Some(model) {
                found = Some(p.pid);
                return true;
            }
        }
        false
    });
    match (appeared, found) {
        (true, Some(pid)) => Ok(json!({ "pid": pid, "old_pid": t.pid, "model": model, "manual": manual })),
        _ => Err(format!("原視窗已關閉、新視窗已送出，但一直沒看到帶著新模型的 Codex 出現（手動：{manual}）")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;
    use std::collections::HashMap;

    /// 假的作業系統：程序表、命令列、存活狀態都在記憶體裡；記錄被結束的 pid；可模擬「結束後（或重開後）出現的程序」
    struct FakeOs {
        procs: RefCell<Vec<Proc>>,
        cmd: RefCell<HashMap<u32, String>>,
        dead: RefCell<Vec<u32>>,
        terminated: RefCell<Vec<u32>>,
        closed_msgs: RefCell<Vec<u32>>,
        own: u32,
        refuse_terminate: bool,
    }
    impl FakeOs {
        fn new(own: u32) -> Self {
            FakeOs { procs: RefCell::new(vec![]), cmd: RefCell::new(HashMap::new()), dead: RefCell::new(vec![]), terminated: RefCell::new(vec![]), closed_msgs: RefCell::new(vec![]), own, refuse_terminate: false }
        }
        fn add(&self, pid: u32, ppid: u32, name: &str, line: &str) {
            self.procs.borrow_mut().push(Proc { pid, ppid, name: name.to_string() });
            self.cmd.borrow_mut().insert(pid, line.to_string());
        }
    }
    impl Os for FakeOs {
        fn cmdline(&self, pid: u32) -> Option<String> {
            self.cmd.borrow().get(&pid).cloned()
        }
        fn processes(&self) -> Vec<Proc> {
            self.procs.borrow().iter().filter(|p| !self.dead.borrow().contains(&p.pid)).cloned().collect()
        }
        fn alive(&self, pid: u32) -> bool {
            self.procs.borrow().iter().any(|p| p.pid == pid) && !self.dead.borrow().contains(&pid)
        }
        fn close_window(&self, pid: u32) -> bool {
            self.closed_msgs.borrow_mut().push(pid);
            false // 假的主控台視窗：關閉訊息沒用，逼它走強制結束
        }
        fn terminate(&self, pid: u32) -> Result<(), String> {
            if self.refuse_terminate {
                return Err("拒絕存取".into());
            }
            self.terminated.borrow_mut().push(pid);
            self.dead.borrow_mut().push(pid);
            Ok(())
        }
        fn own_pid(&self) -> u32 {
            self.own
        }
        fn sleep(&self, _ms: u64) {}
    }
    fn fast() -> Timing {
        Timing { close_grace_ms: 0, gone_wait_ms: 0, appear_wait_ms: 0, poll_ms: 1 }
    }
    const LINE: &str = r#""C:\Users\u\codex.exe" -c check_for_update_on_startup=false -s workspace-write -a on-request resume 小乙"#;
    fn v(a: &[&str]) -> Vec<String> {
        a.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn 命令列_辨認_codex_接續目標_目前模型() {
        let a = parse_cmdline(LINE);
        assert!(is_codex_cmd(&a));
        assert_eq!(resume_target(&a).as_deref(), Some("小乙"));
        assert_eq!(current_model(&a), None);
        assert!(is_codex_cmd(&v(&["node", "C:/x/bin/codex.js", "resume", "a"])), "node 包著跑");
        assert!(!is_codex_cmd(&v(&["claude", "--resume", "a"])));
        assert!(!is_codex_cmd(&v(&["node", "server.js"])));
        assert_eq!(resume_target(&v(&["codex", "resume"])), None, "resume 後面沒給目標");
        assert_eq!(resume_target(&v(&["codex", "resume", "--last"])), None);
        assert_eq!(resume_target(&v(&["codex", "chat"])), None);
        assert_eq!(current_model(&v(&["codex", "-m", "a", "--model", "b", "resume", "x"])).as_deref(), Some("b"));
        assert_eq!(current_model(&v(&["codex", "--model=c", "resume", "x"])).as_deref(), Some("c"));
    }

    #[test]
    fn 重開參數_去舊模型_resume_前插入新模型_其餘原樣() {
        let a = v(&["codex", "-m", "old", "-s", "workspace-write", "--model=older", "resume", "小乙"]);
        assert_eq!(rewrite_args(&a, "小乙", "gpt-5.5"), v(&["codex", "-s", "workspace-write", "-m", "gpt-5.5", "resume", "小乙"]));
        let b = v(&["codex", "-s", "x", "resume", "t-1"]);
        assert_eq!(rewrite_args(&b, "t-1", "m"), v(&["codex", "-s", "x", "-m", "m", "resume", "t-1"]));
        let c = v(&["codex", "chat"]);
        assert_eq!(rewrite_args(&c, "t-9", "m"), v(&["codex", "chat", "-m", "m", "resume", "t-9"]), "沒有 resume 就補上，保證接續同一段對話");
        assert_eq!(rewrite_args(&v(&["-m"]), "t", "m")[0], "-m", "第一個字（程式本身）不當旗標");
    }

    #[test]
    fn 模型名稱() {
        for ok in ["gpt-5.5", "gpt-5.6-sol", "o3", "openai/gpt-5"] {
            assert!(valid_codex_model(ok), "{ok}");
        }
        for bad in ["", "-m", "a b", "x;y", "a\"b", &"x".repeat(65)] {
            assert!(!valid_codex_model(bad), "{bad}");
        }
    }

    #[test]
    fn 找程序_剛好一個才算_包裝程序與子程序取最上層_多個或沒有都回錯() {
        let os = FakeOs::new(1);
        os.add(10, 5, "node.exe", r#"node "C:\x\codex.js" resume 小乙"#);
        os.add(11, 10, "codex.exe", r#"C:\x\codex.exe resume 小乙"#);
        os.add(20, 5, "codex.exe", r#"C:\x\codex.exe resume 小丙"#);
        os.add(30, 5, "claude.exe", "claude --resume 小乙");
        let t = resolve(&os, &os.processes(), "小乙", "").unwrap();
        assert_eq!(t.pid, 10, "包裝程序與子程序同時符合，取最上層");
        assert_eq!(resolve(&os, &os.processes(), "", "小丙").unwrap().pid, 20, "thread 編號也行");
        assert!(resolve(&os, &os.processes(), "沒這個", "").unwrap_err().contains("找不到"));
        os.add(40, 6, "codex.exe", r#"C:\x\codex.exe resume 小丙"#);
        assert!(resolve(&os, &os.processes(), "小丙", "").unwrap_err().contains("不只一個"));
        assert!(resolve(&os, &os.processes(), "", "").is_err());
    }

    #[test]
    fn 關閉_只結束目標與後代_留下終端機_忙碌不動_守門擋自己() {
        let os = FakeOs::new(1);
        os.add(5, 4, "powershell.exe", "powershell");
        os.add(10, 5, "node.exe", r#"node "C:\x\codex.js" resume 小乙"#);
        os.add(11, 10, "codex.exe", r#"C:\x\codex.exe resume 小乙"#);
        os.add(50, 5, "codex.exe", r#"C:\x\codex.exe resume 別人"#);
        assert!(close(&os, &fast(), "小乙", "", Some("busy")).unwrap_err().contains("閒置"));
        assert!(os.terminated.borrow().is_empty(), "忙碌時一個都沒動");
        let r = close(&os, &fast(), "小乙", "", Some("idle")).unwrap();
        assert_eq!(r["pid"], 10);
        assert_eq!(r["kept_terminal"], true, "沒有 ASN 承載殼＝使用者自己開的，終端機留下");
        assert_eq!(*os.terminated.borrow(), vec![11, 10], "子先孫後，只動目標與它的後代");
        assert!(os.alive(5) && os.alive(50), "終端機殼與別人的 codex 都還在");
        assert!(os.closed_msgs.borrow().is_empty(), "使用者自己開的視窗不送關閉訊息");

        // 目標是 ASN 自己的祖先 → 守門拒絕
        let me = FakeOs::new(11);
        me.add(10, 4, "codex.exe", r#"C:\x\codex.exe resume 小乙"#);
        me.add(11, 10, "asn.exe", "asn");
        assert!(close(&me, &fast(), "小乙", "", Some("idle")).unwrap_err().contains("守門"));
        assert!(me.terminated.borrow().is_empty());
    }

    #[test]
    fn 關閉_結束失敗回原因() {
        let mut os = FakeOs::new(1);
        os.refuse_terminate = true;
        os.add(10, 4, "codex.exe", r#"C:\x\codex.exe resume 小乙"#);
        assert!(close(&os, &fast(), "小乙", "", Some("idle")).unwrap_err().contains("結束程序失敗"));
    }

    #[test]
    fn 切換模型_關舊的_照原命令列加新模型重開_確認新程序出現() {
        let dir = tempfile::tempdir().unwrap();
        let cwd = dir.path().to_string_lossy().to_string();
        let os = FakeOs::new(1);
        os.add(5, 4, "powershell.exe", "powershell");
        os.add(10, 5, "codex.exe", r#"C:\x\codex.exe -m old -s workspace-write resume 小乙"#);
        let launched: RefCell<Vec<Vec<String>>> = RefCell::new(vec![]);
        let launch = |plan: &Plan| -> Result<(), String> {
            launched.borrow_mut().push(plan.argv.clone());
            assert_eq!(plan.name, "小乙");
            assert!(plan.cwd.is_dir());
            // 假的 Codex：照 argv 開出新程序
            os.add(99, 5, "codex.exe", &plan.argv.join(" "));
            Ok(())
        };
        let r = switch_model(&os, &fast(), "小乙", "", Some("idle"), &cwd, "gpt-5.5", &launch).unwrap();
        assert_eq!(r["pid"], 99);
        assert_eq!(r["old_pid"], 10);
        assert_eq!(r["model"], "gpt-5.5");
        assert_eq!(launched.borrow().len(), 1);
        assert_eq!(launched.borrow()[0][1..], v(&["-s", "workspace-write", "-m", "gpt-5.5", "resume", "小乙"])[..], "舊模型被換掉，其餘參數照舊");
        assert_eq!(*os.terminated.borrow(), vec![10]);
        assert!(r["manual"].as_str().unwrap().contains("gpt-5.5"), "附手動指令，失敗時使用者自己能開");
    }

    #[test]
    fn 切換模型_各種拒絕與失敗() {
        let dir = tempfile::tempdir().unwrap();
        let cwd = dir.path().to_string_lossy().to_string();
        let os = FakeOs::new(1);
        os.add(10, 4, "codex.exe", r#"C:\x\codex.exe resume 小乙"#);
        let never = |_: &Plan| -> Result<(), String> { panic!("不該重開") };
        assert!(switch_model(&os, &fast(), "小乙", "", Some("idle"), &cwd, "bad model", &never).unwrap_err().contains("不合法"));
        assert!(switch_model(&os, &fast(), "小乙", "", Some("busy"), &cwd, "m", &never).unwrap_err().contains("閒置"));
        assert!(switch_model(&os, &fast(), "小乙", "", Some("idle"), "", "m", &never).unwrap_err().contains("工作資料夾不存在"));
        assert!(switch_model(&os, &fast(), "小乙", "", Some("idle"), "Z:/nope/nope", "m", &never).unwrap_err().contains("工作資料夾不存在"));
        assert!(switch_model(&os, &fast(), "沒這個", "", Some("idle"), &cwd, "m", &never).unwrap_err().contains("找不到"));
        assert!(os.terminated.borrow().is_empty(), "前面的拒絕都沒動到任何程序");
        // 重開失敗：原視窗已關，回報並附手動指令
        let fail = |_: &Plan| -> Result<(), String> { Err("沒有 wt".into()) };
        let e = switch_model(&os, &fast(), "小乙", "", Some("idle"), &cwd, "m", &fail).unwrap_err();
        assert!(e.contains("原視窗已關閉，但重開失敗") && e.contains("手動："), "{e}");
        // 重開了但新程序沒出現（或沒帶新模型）
        let os2 = FakeOs::new(1);
        os2.add(10, 4, "codex.exe", r#"C:\x\codex.exe resume 小乙"#);
        let wrong = |plan: &Plan| -> Result<(), String> {
            os2.add(77, 4, "codex.exe", &format!("{} resume 小乙", plan.argv[0])); // 忘了帶 -m
            Ok(())
        };
        assert!(switch_model(&os2, &fast(), "小乙", "", Some("idle"), &cwd, "m", &wrong).unwrap_err().contains("一直沒看到帶著新模型的 Codex"));
    }
}

//! 同名的多個視窗（#584）：列出、只關指定的那一個。沿用上層的假作業系統與 rig。
use super::*;

/// rig 的「目標」(220) 之外，再用 /resume 接同一段對話開一個同名視窗 240（使用者自己開、掛在 Windows Terminal 底下）。
/// 另外留一個殘檔 250（同名、程序已不在）與一個 pid 被重用的 260（程序是在 session 開始之後才建立）。
fn dup_rig(o: Opt) -> Rig {
    let r = rig(o);
    let cwd = r.work.to_string_lossy().to_string();
    write_session(&r.sessions, 240, "sid-220", "目標", "idle", &cwd);
    write_session(&r.sessions, 250, "sid-220", "目標", "idle", &cwd);
    // 260：session 檔記的開始時間是一小時前，程序卻是現在才建立的
    let j = json!({ "pid": 260, "sessionId": "sid-220", "name": "目標", "status": "idle", "cwd": cwd, "kind": "interactive", "startedAt": NOW - 3_600_000 });
    std::fs::write(r.sessions.join("260.json"), j.to_string()).unwrap();
    let os = r.os();
    os.alive.lock().unwrap().extend([240, 241, 260]);
    os.table.lock().unwrap().extend([p(240, 100, "claude.exe"), p(241, 240, "node.exe"), p(260, 100, "claude.exe")]);
    os.cmd.lock().unwrap().insert(240, "claude.exe --resume sid-220".into());
    os.cmd.lock().unwrap().insert(260, "claude.exe".into());
    os.started.lock().unwrap().insert(260, NOW);
    r
}

#[test]
fn 列出同名視窗_殘檔與_pid_被重用的不算_帶開啟時間與是否_asn_開() {
    let r = dup_rig(Opt { asn_host: true, ..Opt::default() });
    // 讓 220 看起來是 ASN 開、有遠端控制
    r.os().cmd.lock().unwrap().insert(220, r#"claude.exe -n "目標" --remote-control "目標""#.into());
    let w = r.ops.dup_windows("目標");
    assert_eq!(w.iter().map(|w| w.pid).collect::<Vec<_>>(), vec![220, 240], "{w:?}");
    assert_eq!((w[0].by_asn, w[0].remote, w[0].started_ms), (true, true, 1220));
    assert_eq!((w[1].by_asn, w[1].remote, w[1].session_id.as_str()), (false, false, "sid-220"));
    assert_eq!(r.ops.dup_windows("別人").len(), 1, "不同名的不算");
}

#[test]
fn 只關按下的那一個_另一個與它的終端機不動() {
    let r = dup_rig(Opt::default());
    let (good, text) = r.ops.close_dup("目標", 240);
    assert!(good, "{text}");
    assert_eq!(text, "已關掉，剛才的信會自動重送");
    let t = r.terminated();
    assert!(t.contains(&240) && t.contains(&241), "{t:?}");
    assert!(!t.contains(&220) && !t.contains(&221) && !t.contains(&100) && !t.contains(&300), "{t:?}");
    assert!(!r.sessions.join("240.json").exists(), "關掉的那個不留 session 檔");
    assert_eq!(r.ops.dup_windows("目標").len(), 1, "剩一個");
}

#[test]
fn 只剩一個或_pid_不在同名名單裡_一律不動() {
    let r = dup_rig(Opt::default());
    let (good, text) = r.ops.close_dup("目標", 231);
    assert!(!good && text.contains("找不到這個視窗"), "別的名字的視窗不能用這個指令關：{text}");
    let (good, text) = r.ops.close_dup("目標", 250);
    assert!(!good && text.contains("找不到"), "殘檔：{text}");
    assert!(r.ops.close_dup("目標", 240).0);
    let (good, text) = r.ops.close_dup("目標", 220);
    assert!(!good && text.contains("只剩一個"), "{text}");
    assert_eq!(r.terminated().iter().filter(|p| **p == 220).count(), 0, "最後一個不關");
}

#[test]
fn 沒開遠端管理_不關() {
    let r = dup_rig(Opt { allow_first: 0, ..Opt::default() });
    let (good, text) = r.ops.close_dup("目標", 240);
    assert!(!good && text.contains("允許遠端"), "{text}");
    assert!(r.terminated().is_empty());
}

#[test]
fn 保護名單上的不關() {
    let r = dup_rig(Opt::default());
    let cwd = r.work.to_string_lossy().to_string();
    write_session(&r.sessions, 777, "sid-x", "目標", "idle", &cwd);
    r.os().alive.lock().unwrap().insert(777);
    r.os().table.lock().unwrap().push(p(777, 100, "claude.exe"));
    r.os().cmd.lock().unwrap().insert(777, "claude.exe".into());
    let (good, text) = r.ops.close_dup("目標", 777);
    assert!(!good, "{text}");
    assert!(!r.terminated().contains(&777));
}

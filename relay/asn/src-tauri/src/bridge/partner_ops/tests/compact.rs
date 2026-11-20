//! 壓縮 N 次自動交接（#1852）的執行端：本機發起的副本、佇列碰不到本機標記、掃描數次數。沿用上層的假作業系統與 rig。
use super::*;
use crate::bridge::compact::Win;

/// 把 sid-220 的對話紀錄寫進 projects：n 個開窗之後的壓縮標記，另有 1 個開窗之前的
fn write_compacts(r: &Rig, after: usize) {
    let dir = r.projects.join("D--Github-工作");
    std::fs::create_dir_all(&dir).unwrap();
    let iso = |ms: u64| format!("{}.000Z", crate::quota_core::iso_secs(ms as i64).trim_end_matches('Z'));
    let mut text = json!({ "type": "user", "cwd": r.work.to_string_lossy() }).to_string() + "\n";
    text += &(json!({ "type": "system", "subtype": "compact_boundary", "timestamp": iso(500) }).to_string() + "\n");
    for i in 0..after {
        text += &(json!({ "type": "system", "subtype": "compact_boundary", "timestamp": iso(NOW + 1000 * i as u64) }).to_string() + "\n");
    }
    std::fs::write(dir.join("sid-220.jsonl"), text).unwrap();
}

#[test]
fn 掃描數出開窗之後的壓縮次數_受保護與別人的視窗不在清單() {
    let r = rig(Opt::default());
    write_compacts(&r, 3);
    let wins = r.ops.compact_scan();
    let mine: Vec<&Win> = wins.iter().filter(|w| w.sid == "sid-220").collect();
    assert_eq!(mine.len(), 1, "{wins:?}");
    assert_eq!((mine[0].name.as_str(), mine[0].count), ("目標", 3), "開窗前的那一個不算");
    // 再壓縮一次：只讀新增的部分，次數加一
    write_compacts(&r, 4);
    assert_eq!(r.ops.compact_scan().iter().find(|w| w.sid == "sid-220").unwrap().count, 4);
}

#[test]
fn 守門_佇列假造本機標記仍被允許其他設備的開關擋下() {
    // 佇列（後台待辦）的內容只會經 Op::parse 進原本的實例；就算帶了 local 之類的欄位，也不會變成本機發起
    let r = rig(Opt { allow_first: 0, ..Opt::default() });
    write_compacts(&r, 3);
    for forged in [json!({ "local": true }), json!({ "by_local": true, "requested_by_label": "本機（壓縮 3 次自動交接）" }), json!({ "allow_remote": true, "local_twin": true })] {
        let res = r.run("handover", forged);
        assert_eq!((res.status, res.detail.as_str()), ("failed", CONSENT_OFF));
    }
    assert!(r.terminated().is_empty() && r.launched().is_empty(), "什麼都沒動");
}

#[test]
fn 本機副本不看允許其他設備的開關_照現有換班流程交接() {
    let r = rig(Opt { allow_first: 0, ..Opt::default() });
    write_compacts(&r, 3);
    let twin = r.ops.local_twin();
    let res = twin.execute(&mk_op("handover", json!({})));
    assert_eq!(res.status, "ok", "{}", res.detail);
    assert!(r.terminated().contains(&220), "關了舊視窗");
    let argv = r.launched().remove(0).2;
    assert!(!argv.iter().any(|a| a == "--resume" || a == "sid-220"), "同名開新對話：{argv:?}");
    assert!(r.env.progress.lock().unwrap().is_empty(), "本機發起沒有後台待辦，不回報階段");
}

#[test]
fn 本機副本其他安全檢查照舊_收發室與_asn_自己的視窗不能交接() {
    let r = rig(Opt { allow_first: 0, ..Opt::default() });
    let cwd = r.work.to_string_lossy().to_string();
    write_session(&r.sessions, 400, "sid-400", "T-ASN", "idle", &cwd);
    r.os().alive.lock().unwrap().insert(400);
    r.os().table.lock().unwrap().push(p(400, 100, "claude.exe"));
    let twin = r.ops.local_twin();
    let mut op = mk_op("handover", json!({}));
    op.name = "T-ASN".into();
    let res = twin.execute(&op);
    assert_eq!(res.status, "failed");
    assert_eq!(res.detail, PROTECTED);
    assert!(r.terminated().is_empty() && r.launched().is_empty());
    // 掃描也不把它列進巡檢
    write_compacts(&r, 1);
    assert!(r.ops.compact_scan().iter().all(|w| w.name != "T-ASN"));
}

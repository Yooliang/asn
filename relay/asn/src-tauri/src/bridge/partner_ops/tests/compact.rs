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
fn 掃描標出可能用自訂設定資料夾的視窗_命令列有寫就算() {
    let r = rig(Opt::default());
    write_compacts(&r, 3);
    assert!(!r.ops.compact_scan().iter().find(|w| w.sid == "sid-220").unwrap().custom_config, "一般視窗");
    r.os().cmd.lock().unwrap().insert(110, r#"cmd /c set CLAUDE_CONFIG_DIR=D:\c&& claude"#.into());
    assert!(r.ops.compact_scan().iter().find(|w| w.sid == "sid-220").unwrap().custom_config, "外殼命令列有寫 CLAUDE_CONFIG_DIR");
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

#[tokio::test]
async fn 守門_後台_pull_拿到帶本機標記的待辦_仍被當成遠端() {
    // 走真正的 pull 路徑：後台回傳的待辦帶 local:true 也不會變成本機發起，照樣被「允許其他設備」的開關擋下
    let st = Arc::new(Mutex::new(Srv::default()));
    st.lock().unwrap().ops = vec![json!({ "id": "f1", "name": "目標", "op": "handover", "local": true, "by_local": true, "requested_by": "U1", "requested_by_label": "本機（壓縮 3 次自動交接）", "created_at": "t" })];
    let r = rig_with_server(Opt { allow_first: 0, ..Opt::default() }, st.clone());
    write_compacts(&r, 3);
    r.ops.pull().await;
    let res = wait_results(&st, 1).await;
    assert_eq!(res.len(), 1, "{res:?}");
    assert_eq!((res[0]["status"].as_str(), res[0]["detail"].as_str()), (Some("failed"), Some(CONSENT_OFF)), "{res:?}");
    assert!(r.terminated().is_empty() && r.launched().is_empty(), "什麼都沒動");
}

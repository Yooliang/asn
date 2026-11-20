use super::*;
use serde_json::json;

const T0: u64 = 1_800_000_000_000; // 開窗時間（毫秒）

fn iso(ms: u64) -> String {
    crate::quota_core::iso_secs(ms as i64).replace('Z', &format!(".{:03}Z", ms % 1000))
}
fn boundary(ms: u64) -> String {
    json!({ "type": "system", "subtype": "compact_boundary", "timestamp": iso(ms), "content": "Conversation compacted" }).to_string()
}
fn win(sid: &str, name: &str, count: u32) -> Win {
    Win { sid: sid.into(), name: name.into(), count, custom_config: false }
}
fn ok_quota() -> Quota {
    Quota::Known { five: 62.0, week: 55.0 }
}
fn run(t: &mut Tracker, wins: &[Win], enabled: bool, n: u32, q: &Quota, manual: &[String]) -> Vec<Act> {
    t.step(&Input { wins, enabled, n, quota: q, manual })
}
fn handovers(a: &[Act]) -> usize {
    a.iter().filter(|x| matches!(x, Act::Handover { .. })).count()
}

// ---------- 數 compact_boundary ----------

#[test]
fn 只數系統類的壓縮標記_其他行不算() {
    let lines = [
        boundary(T0 + 1000),
        json!({ "type": "user", "message": "compact_boundary 這句話只是聊天內容", "timestamp": iso(T0 + 2000) }).to_string(),
        json!({ "type": "system", "subtype": "other", "timestamp": iso(T0 + 3000) }).to_string(),
        json!({ "type": "assistant", "subtype": "compact_boundary", "timestamp": iso(T0 + 4000) }).to_string(),
        "不是 json compact_boundary".to_string(),
        boundary(T0 + 5000),
    ];
    assert_eq!(lines.iter().filter(|l| is_compact_line(l, T0)).count(), 2);
}

#[test]
fn 只算開窗之後_舊的壓縮和讀不出時間的都不算() {
    assert!(!is_compact_line(&boundary(T0 - 1), T0), "開窗前的壓縮不算");
    assert!(is_compact_line(&boundary(T0), T0));
    let no_ts = json!({ "type": "system", "subtype": "compact_boundary" }).to_string();
    assert!(!is_compact_line(&no_ts, T0), "沒有時間戳＝沒有證據是開窗後");
    let bad_ts = json!({ "type": "system", "subtype": "compact_boundary", "timestamp": "昨天" }).to_string();
    assert!(!is_compact_line(&bad_ts, T0));
}

#[test]
fn 對話紀錄檔只讀新增的部分_寫到一半的行下次再算() {
    let d = tempfile::tempdir().unwrap();
    let p = d.path().join("s.jsonl");
    std::fs::write(&p, format!("{}\n{}\n", boundary(T0 - 5000), boundary(T0 + 10))).unwrap();
    let mut pr = Progress::new(p.clone());
    assert_eq!(pr.advance(T0).unwrap(), 1);
    // 再寫一行，但沒有換行（寫到一半）
    use std::io::Write;
    let mut f = std::fs::OpenOptions::new().append(true).open(&p).unwrap();
    write!(f, "{}", boundary(T0 + 20)).unwrap();
    assert_eq!(pr.advance(T0).unwrap(), 1, "沒換行的行先不算");
    writeln!(f).unwrap();
    assert_eq!(pr.advance(T0).unwrap(), 2);
    assert_eq!(pr.advance(T0).unwrap(), 2, "沒新增就不重複算");
    // 檔案被換成更短的：從頭數
    std::fs::write(&p, format!("{}\n", boundary(T0 + 30))).unwrap();
    assert_eq!(pr.advance(T0).unwrap(), 1);
}

#[test]
fn 新視窗是新的對話紀錄檔_次數從零算() {
    let d = tempfile::tempdir().unwrap();
    let old = d.path().join("old.jsonl");
    let new = d.path().join("new.jsonl");
    std::fs::write(&old, format!("{0}\n{0}\n{0}\n", boundary(T0 + 10))).unwrap();
    std::fs::write(&new, "{\"type\":\"user\"}\n").unwrap();
    assert_eq!(Progress::new(old).advance(T0).unwrap(), 3);
    assert_eq!(Progress::new(new).advance(T0 + 100).unwrap(), 0);
}

// ---------- 設定 ----------

#[test]
fn 次數夾在二到十_缺值是三() {
    assert_eq!(clamp_n(None), 3);
    assert_eq!(clamp_n(Some(1)), 2);
    assert_eq!(clamp_n(Some(2)), 2);
    assert_eq!(clamp_n(Some(10)), 10);
    assert_eq!(clamp_n(Some(99)), 10);
    assert_eq!(clamp_n(Some(-5)), 2);
}

// ---------- 額度 ----------

fn view(status: &str, five: f64, week: f64, read_ms: i64) -> Value {
    json!({ "email": "a@x.test", "status": status, "read_at": crate::quota_core::iso_secs(read_ms), "windows": [
        { "name": "five_hour", "left_pct": five }, { "name": "weekly", "left_pct": week } ] })
}
const NOW: i64 = 1_800_000_000_000;

#[test]
fn 額度讀數的各種不確定都回_unknown() {
    assert_eq!(quota_from_view(&view("ok", 62.0, 55.0, NOW), false, NOW), Quota::Known { five: 62.0, week: 55.0 });
    assert_eq!(quota_from_view(&view("unavailable", 62.0, 55.0, NOW), false, NOW), Quota::Unknown, "讀取失敗");
    assert_eq!(quota_from_view(&view("login_expired", 62.0, 55.0, NOW), false, NOW), Quota::Unknown);
    assert_eq!(quota_from_view(&view("ok", 62.0, 55.0, NOW - 31 * 60_000), false, NOW), Quota::Unknown, "讀數太舊");
    let only_five = json!({ "status": "ok", "read_at": crate::quota_core::iso_secs(NOW), "windows": [{ "name": "five_hour", "left_pct": 62.0 }] });
    assert_eq!(quota_from_view(&only_five, false, NOW), Quota::Unknown, "缺每週");
    assert_eq!(quota_from_view(&json!({ "status": "none", "windows": [] }), false, NOW), Quota::Unknown);
}

#[test]
fn 有設自訂設定資料夾一律當讀不到() {
    assert_eq!(quota_from_view(&view("ok", 90.0, 90.0, NOW), true, NOW), Quota::Unknown);
}

#[test]
fn 門檻是兩個窗都剩二十以上() {
    assert_eq!(judge(true, &Quota::Known { five: 20.0, week: 20.0 }), Ok(Some(20)));
    assert_eq!(judge(true, &Quota::Known { five: 19.9, week: 80.0 }), Err(Why::Quota { which: "5 小時", pct: 19 }));
    assert_eq!(judge(true, &Quota::Known { five: 80.0, week: 8.0 }), Err(Why::Quota { which: "每週", pct: 8 }));
    assert_eq!(judge(true, &Quota::Unknown), Err(Why::Unknown));
    assert_eq!(judge(false, &ok_quota()), Err(Why::Off), "設定沒勾就只提醒，不看額度");
}

#[test]
fn 自訂設定資料夾的判斷_任何一個來源看得到就算() {
    assert!(!window_custom_config(false, &["claude.exe -n 小悠".into()], None));
    assert!(window_custom_config(true, &[], None), "ASN 自己的環境有設");
    assert!(window_custom_config(false, &["cmd /c set CLAUDE_CONFIG_DIR=D:\\c&& claude".into()], None), "外殼命令列有寫");
    assert!(window_custom_config(false, &[], Some(b"PATH=x\0CLAUDE_CONFIG_DIR=/home/a/.c\0")), "Linux 視窗自己的環境");
    assert!(!window_custom_config(false, &[], Some(b"PATH=x\0CLAUDE_CONFIG_DIR=\0")), "設成空的等於沒設");
    assert!(!window_custom_config(false, &[], Some(b"PATH=x\0MY_CLAUDE_CONFIG_DIR=/a\0")), "只認完整名字");
}

// ---------- 守門：額度讀不到卻照樣自動交接 ----------

#[test]
fn 守門_視窗用自訂設定資料夾_額度再夠也只提醒() {
    let mut t = Tracker::default();
    let mut w = win("s1", "小悠", 3);
    w.custom_config = true;
    let a = run(&mut t, &[w, win("s2", "西川", 3)], true, 3, &ok_quota(), &[]);
    assert_eq!(handovers(&a), 1, "沒設自訂資料夾的視窗照常自動交接");
    assert!(matches!(&a[0], Act::Mail { sid, kind: MailKind::Remind(Why::Unknown), .. } if sid == "s1"), "{a:?}");
}

#[test]
fn 守門_額度讀不到絕不自動交接_只提醒一次() {
    let mut t = Tracker::default();
    let w = [win("s1", "調查員", 4)];
    let a = run(&mut t, &w, true, 3, &Quota::Unknown, &[]);
    assert_eq!(handovers(&a), 0, "讀不到額度不能自動交接");
    assert_eq!(a, vec![Act::Mail { sid: "s1".into(), name: "調查員".into(), count: 4, kind: MailKind::Remind(Why::Unknown) }]);
    let a2 = run(&mut t, &w, true, 3, &Quota::Unknown, &[]);
    assert!(a2.is_empty(), "同一個視窗不重複寄信");
    assert_eq!(t.view()["s1"].state, "remind");
}

#[test]
fn 守門_額度不夠和設定沒勾都不自動交接() {
    let mut t = Tracker::default();
    let w = [win("s1", "a", 3), win("s2", "b", 3)];
    let low = Quota::Known { five: 8.0, week: 90.0 };
    let a = run(&mut t, &w[..1], true, 3, &low, &[]);
    assert_eq!(handovers(&a), 0);
    let a = run(&mut t, &w[1..], false, 3, &ok_quota(), &[]);
    assert_eq!(handovers(&a), 0);
}

#[test]
fn 額度恢復後才自動交接() {
    let mut t = Tracker::default();
    let w = [win("s1", "a", 3)];
    assert_eq!(run(&mut t, &w, true, 3, &Quota::Unknown, &[]).len(), 1);
    let a = run(&mut t, &w, true, 3, &ok_quota(), &[]);
    assert_eq!(handovers(&a), 1, "恢復後自動交接");
    assert_eq!(t.view()["s1"].state, "handing");
}

#[test]
fn 還沒到次數什麼都不做() {
    let mut t = Tracker::default();
    assert!(run(&mut t, &[win("s1", "a", 2)], true, 3, &ok_quota(), &[]).is_empty());
    assert_eq!(t.view()["s1"].state, "count");
}

// ---------- 守門：次數沒歸零重複觸發 ----------

#[test]
fn 守門_交接後不重複觸發_舊視窗閃回來和新視窗從零都不會再觸發() {
    let mut t = Tracker::default();
    let old = [win("old", "小悠", 3)];
    assert_eq!(handovers(&run(&mut t, &old, true, 3, &ok_quota(), &[])), 1);
    // 交接進行中，下一輪舊視窗仍在、次數仍是 3：不能再觸發
    assert_eq!(handovers(&run(&mut t, &old, true, 3, &ok_quota(), &[])), 0, "交接中不重複觸發");
    // 交接成功：寄「已自動交接」信
    let m = t.finish("old", true).unwrap();
    assert!(matches!(m, Act::Mail { kind: MailKind::Auto { pct5: Some(62) }, .. }));
    // 新視窗同名、新 session、次數 0：不觸發；名單閃一下舊視窗又出現：也不觸發
    let both = [win("old", "小悠", 3), win("new", "小悠", 0)];
    assert!(run(&mut t, &both, true, 3, &ok_quota(), &[]).is_empty(), "已交接過的 session 不再觸發；新視窗次數 0 不觸發");
    assert!(run(&mut t, &[win("new", "小悠", 0)], true, 3, &ok_quota(), &[]).is_empty());
    assert!(run(&mut t, &both, true, 3, &ok_quota(), &[]).is_empty(), "舊視窗之後又出現也不觸發");
}

#[test]
fn 守門_狀態用_session_當鍵_同名新視窗不繼承舊視窗的請交接() {
    let mut t = Tracker::default();
    run(&mut t, &[win("old", "小悠", 3)], true, 3, &Quota::Unknown, &[]);
    run(&mut t, &[win("new", "小悠", 0)], true, 3, &Quota::Unknown, &[]);
    assert_eq!(t.view()["new"].state, "count", "新視窗從 0 次算起，不繼承舊視窗的請交接");
    let a = run(&mut t, &[win("new", "小悠", 3)], true, 3, &Quota::Unknown, &[]);
    assert_eq!(a.len(), 1, "新視窗自己壓縮到 N 次，照樣會提醒一次");
}

#[test]
fn 自動交接失敗不重試_改成只提醒並寄一次信() {
    let mut t = Tracker::default();
    let w = [win("s1", "a", 3)];
    run(&mut t, &w, true, 3, &ok_quota(), &[]);
    let m = t.finish("s1", false).unwrap();
    assert!(matches!(m, Act::Mail { kind: MailKind::Remind(Why::Failed), .. }));
    assert_eq!(handovers(&run(&mut t, &w, true, 3, &ok_quota(), &[])), 0, "失敗後不自動重試");
    assert_eq!(t.view()["s1"].state, "remind");
    // 但人按「交接」可以再來，而且不寄信
    let man = ["a".to_string()];
    let a = run(&mut t, &w, true, 3, &ok_quota(), &man);
    assert_eq!(a, vec![Act::Handover { sid: "s1".into(), name: "a".into(), count: 3, auto: false, pct5: None }]);
    assert_eq!(t.finish("s1", true), None, "手動交接不寄信");
}

#[test]
fn 手動交接不查額度也不管設定() {
    let mut t = Tracker::default();
    let man = ["a".to_string()];
    let a = run(&mut t, &[win("s1", "a", 4)], false, 3, &Quota::Unknown, &man);
    assert_eq!(handovers(&a), 1);
    assert!(!a.iter().any(|x| matches!(x, Act::Mail { .. })));
}

#[test]
fn 信的欄位對得上後台() {
    assert_eq!(mail_fields(&MailKind::Auto { pct5: Some(62) }), ("auto", None, Some(62)));
    assert_eq!(mail_fields(&MailKind::Remind(Why::Quota { which: "每週", pct: 8 })), ("remind_quota", Some("每週"), Some(8)));
    assert_eq!(mail_fields(&MailKind::Remind(Why::Unknown)).0, "remind_unknown");
    assert_eq!(mail_fields(&MailKind::Remind(Why::Off)).0, "remind_off");
    assert_eq!(mail_fields(&MailKind::Remind(Why::Failed)).0, "remind_failed");
}

#[test]
fn 一輪最多自動交接一個視窗_其餘達標的留到下一輪() {
    let mut t = Tracker::default();
    let wins = [win("s1", "小悠", 3), win("s2", "西川", 4)];
    let a = run(&mut t, &wins, true, 3, &ok_quota(), &[]);
    assert_eq!(handovers(&a), 1, "兩個都達標，只交接第一個：{a:?}");
    assert!(matches!(&a[0], Act::Handover { sid, auto: true, .. } if sid == "s1"), "{a:?}");
    assert_eq!(t.view()["s2"].state, "count", "沒輪到的不能標成交接中");
    // 下一輪：第一個還在交接中，輪到第二個
    let a = run(&mut t, &wins, true, 3, &ok_quota(), &[]);
    assert_eq!(handovers(&a), 1, "{a:?}");
    assert!(matches!(&a[0], Act::Handover { sid, .. } if sid == "s2"), "{a:?}");
    // 只寄提醒的路不受上限影響：額度讀不到時兩個都各寄一封
    let mut t = Tracker::default();
    let a = run(&mut t, &wins, true, 3, &Quota::Unknown, &[]);
    assert_eq!((handovers(&a), a.len()), (0, 2), "{a:?}");
}

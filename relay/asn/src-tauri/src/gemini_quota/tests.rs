use super::*;

// 2026-10-29T14:51:00Z（實測樣本收到的時間附近；樣本 gemini-5h 的重置時間是 16:37:30）
const NOW: i64 = 1_793_285_460_000;
const ME: &str = "me@example.test";

/// 實測樣本（agy 1.4.10，帳號、路徑、編號都已遮掉）；email 遮成 <redacted>，測試時換成假帳號
fn samples() -> Vec<String> {
    include_str!("statusline-samples.jsonl").lines().filter(|l| !l.trim().is_empty()).map(|l| l.replace("\"<redacted>\"", "\"Me@Example.test\"")).collect()
}

fn status(five: Option<f64>, week: Option<f64>) -> String {
    let mut q = serde_json::Map::new();
    if let Some(f) = five {
        q.insert("gemini-5h".into(), json!({ "remaining_fraction": f, "reset_time": "2026-10-29T16:37:30Z", "reset_in_seconds": 6350 }));
    }
    if let Some(w) = week {
        q.insert("gemini-weekly".into(), json!({ "remaining_fraction": w, "reset_time": "2026-11-02T01:53:41Z", "reset_in_seconds": 298921 }));
    }
    q.insert("3p-5h".into(), json!({ "remaining_fraction": 1, "reset_time": "2026-10-29T19:50:27Z" }));
    json!({ "cwd": "D:/secret-proj", "session_id": "S-1", "conversation_id": "C-1", "context_window": { "total_input_tokens": 12345 },
            "email": ME, "plan_tier": "Google AI Pro", "quota": Value::Object(q) })
    .to_string()
}

#[test]
fn 實測樣本_前幾筆沒有_email_或_quota_略過_有了才讀() {
    let s = samples();
    assert_eq!(s.len(), 8);
    for (i, line) in s.iter().take(3).enumerate() {
        assert!(parse_statusline(line, NOW).is_none(), "第 {} 筆還沒有 quota，不能當成沒額度", i + 1);
    }
    let r = parse_statusline(&s[3], NOW).expect("第 4 筆有 email 與 quota");
    assert_eq!(r.email, ME, "email 正規化成小寫");
    assert_eq!(r.plan, "", "第 4 筆還沒有 plan_tier");
    let r = parse_statusline(&s[7], NOW).unwrap();
    assert_eq!(r.plan, "Google AI Pro");
    assert_eq!((r.parsed.five_hour_pct, r.parsed.weekly_pct), (Some(98), Some(30)), "0.9767→98、0.3009→30，四捨五入");
    assert_eq!(r.parsed.five_reset_ms.map(iso_secs).as_deref(), Some("2026-10-29T16:37:30Z"));
    assert_eq!(r.parsed.week_reset_ms.map(iso_secs).as_deref(), Some("2026-11-02T01:53:41Z"));
    let mut d = r.dropped.clone();
    d.sort();
    assert_eq!(d, ["3p-5h", "3p-weekly", "gemini-argon-wtu-weekly"], "其他桶丟掉並記下名字");
}

#[test]
fn 窗名只認_gemini_5h_與_gemini_weekly_停用_算不出比例_已過期的丟掉() {
    let t = json!({ "email": ME, "quota": {
        "gemini-5h": { "remaining_fraction": 0.5, "reset_time": "2026-10-29T16:00:00.123Z" },
        "gemini-weekly": { "remaining_amount": 30, "reset_time": "2026-11-02T00:00:00Z" },
        "gemini-pro-weekly": { "remaining_fraction": 0.1 },
    }})
    .to_string();
    let r = parse_statusline(&t, NOW).unwrap();
    assert_eq!(r.parsed.five_hour_pct, Some(50));
    assert_eq!(r.parsed.five_reset_ms.map(iso_secs).as_deref(), Some("2026-10-29T16:00:00Z"), "小數秒也認");
    assert_eq!(r.parsed.weekly_pct, None, "只有數量算不出 %");
    assert!(r.dropped.contains(&"gemini-weekly".to_string()) && r.dropped.contains(&"gemini-pro-weekly".to_string()));
    for b in [
        json!({ "remaining_fraction": 0.5, "disabled": true }),
        json!({ "remaining_fraction": 1.5 }),
        json!({ "remaining_fraction": -0.1 }),
        json!({ "remaining_fraction": "0.5" }),
        json!({ "remaining_fraction": 0.5, "reset_time": "2026-10-29T14:00:00Z" }),
    ] {
        let t = json!({ "email": ME, "quota": { "gemini-5h": b } }).to_string();
        let r = parse_statusline(&t, NOW).unwrap();
        assert_eq!(r.parsed.five_hour_pct, None, "{b}");
    }
    // 沒有 reset_time 就用 reset_in_seconds
    let t = json!({ "email": ME, "quota": { "gemini-5h": { "remaining_fraction": 1, "reset_in_seconds": 3600 } } }).to_string();
    assert_eq!(parse_statusline(&t, NOW).unwrap().parsed.five_reset_ms, Some(NOW + 3_600_000));
}

#[test]
fn 沒有_email_或_quota_或格式不對都是_none() {
    for t in ["", "不是 json", "{}", r#"{"quota":{}}"#, r#"{"email":"壞掉","quota":{}}"#, r#"{"email":"a@x.test"}"#, r#"{"email":"a@x.test","quota":null}"#, r#"{"email":"a@x.test","quota":[]}"#] {
        assert!(parse_statusline(t, NOW).is_none(), "{t}");
    }
    assert!(parse_statusline(&"x".repeat(MAX_INPUT + 1), NOW).is_none());
}

#[test]
fn 本機檔只存額度窗_方案_讀取時間_不留路徑編號_token() {
    let h = tempfile::tempdir().unwrap();
    assert_eq!(hook(h.path(), &status(Some(0.9767), Some(0.3009)), NOW), "Gemini 5h 98% | wk 30%");
    let raw = std::fs::read_to_string(path(h.path())).unwrap();
    for bad in ["secret-proj", "cwd", "session", "conversation", "S-1", "C-1", "token", "12345", "3p-", "\"reset_at\""] {
        assert!(!raw.contains(bad), "本機檔不該含 {bad}：{raw}");
    }
    let v: Value = serde_json::from_str(&raw).unwrap();
    let mut keys: Vec<&String> = v[ME].as_object().unwrap().keys().collect();
    keys.sort();
    assert_eq!(keys, ["at", "five_at", "five_hour_pct", "five_reset_at", "plan_tier", "week_at", "week_reset_at", "weekly_pct"]);
    let all = load_all(h.path());
    assert_eq!(all[ME].plan, "Google AI Pro");
    assert_eq!((all[ME].quota.five_hour_pct, all[ME].quota.weekly_pct), (Some(98), Some(30)));
}

#[test]
fn 值沒變不寫檔_五分鐘後才重寫_值變了馬上寫() {
    let h = tempfile::tempdir().unwrap();
    let r = parse_statusline(&status(Some(0.9), Some(0.5)), NOW).unwrap();
    assert!(record(h.path(), &r, NOW).unwrap());
    assert!(!record(h.path(), &r, NOW + 300).unwrap(), "300ms 後同樣的值不寫");
    assert!(!record(h.path(), &r, NOW + 4 * 60_000).unwrap());
    let r2 = parse_statusline(&status(Some(0.8), Some(0.5)), NOW).unwrap();
    assert!(record(h.path(), &r2, NOW + 4 * 60_000 + 1).unwrap(), "值變了就寫");
    assert!(record(h.path(), &r2, NOW + 10 * 60_000).unwrap(), "超過 5 分鐘沒寫，同樣的值也重寫一次（讀取時間才不會停住）");
}

#[test]
fn 滿額的窗重置時間一直往後跑_十分鐘內算沒變_不寫檔() {
    let h = tempfile::tempdir().unwrap();
    let full = json!({ "email": ME, "quota": { "gemini-5h": { "remaining_fraction": 1, "reset_in_seconds": 18000 } } }).to_string();
    let r = parse_statusline(&full, NOW).unwrap();
    assert!(record(h.path(), &r, NOW).unwrap());
    let r = parse_statusline(&full, NOW + 60_000).unwrap();
    assert!(!record(h.path(), &r, NOW + 60_000).unwrap(), "重置時間往後跑 1 分鐘＝沒變");
    let all = load_all(h.path());
    assert_eq!(all[ME].quota.five_hour_pct, Some(100));
}

#[test]
fn 用_gemini_規則合併_記著滿額照收新的_同一期回升不收() {
    let h = tempfile::tempdir().unwrap();
    let mk = |f: f64, reset: &str| json!({ "email": ME, "quota": { "gemini-weekly": { "remaining_fraction": f, "reset_time": reset } } }).to_string();
    let r = parse_statusline(&mk(1.0, "2026-11-05T14:51:00Z"), NOW).unwrap();
    assert!(record(h.path(), &r, NOW).unwrap());
    // 開始用了：重置時間固定成較早的時間（Claude 規則會當成「比較早」擋掉；Gemini 記著 100% 照收）
    let r = parse_statusline(&mk(0.9, "2026-11-05T13:00:00Z"), NOW + 600_000).unwrap();
    assert!(record(h.path(), &r, NOW + 600_000).unwrap());
    assert_eq!(load_all(h.path())[ME].quota.weekly_pct, Some(90));
    // 同一期回升不收，記 log（不含 email）
    let r = parse_statusline(&mk(0.95, "2026-11-05T13:00:00Z"), NOW + 1_200_000).unwrap();
    assert!(!record(h.path(), &r, NOW + 1_200_000).unwrap());
    assert_eq!(load_all(h.path())[ME].quota.weekly_pct, Some(90));
    let log = std::fs::read_to_string(log_path(h.path())).unwrap();
    assert!(log.contains("回升") && !log.contains("example.test"), "{log}");
}

#[test]
fn 丟掉的桶記_log_同樣的內容不重複寫() {
    let h = tempfile::tempdir().unwrap();
    for i in 0..5 {
        let _ = hook(h.path(), &status(Some(0.9), Some(0.5)), NOW + i * 300);
    }
    let log = std::fs::read_to_string(log_path(h.path())).unwrap();
    assert_eq!(log.lines().count(), 1, "{log}");
    assert!(log.contains("3p-5h"));
}

#[test]
fn 最多_20_個帳號_留最新的() {
    let h = tempfile::tempdir().unwrap();
    for i in 0..25 {
        let t = status(Some(0.5), None).replace(ME, &format!("u{i}@x.test"));
        assert!(record(h.path(), &parse_statusline(&t, NOW).unwrap(), NOW + i * 1000).unwrap());
    }
    let all = load_all(h.path());
    assert_eq!(all.len(), MAX_ACCOUNTS);
    assert!(all.contains_key("u24@x.test") && !all.contains_key("u0@x.test"));
}

#[test]
fn 本機檔壞掉或被竄改_讀出來是空的或逐欄丟掉() {
    let h = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(h.path().join(".asn")).unwrap();
    std::fs::write(path(h.path()), "壞掉{").unwrap();
    assert!(load_all(h.path()).is_empty());
    std::fs::write(path(h.path()), r#"{"A@X.test":{"weekly_pct":5,"at":"2026-10-29T14:00:00Z"},"b@x.test":{"weekly_pct":40,"five_hour_pct":999,"at":"2026-10-29T14:00:00Z","plan_tier":"P\nlan"}}"#).unwrap();
    let all = load_all(h.path());
    assert!(!all.contains_key("A@X.test"), "鍵沒正規化不收");
    assert_eq!((all["b@x.test"].quota.five_hour_pct, all["b@x.test"].quota.weekly_pct), (None, Some(40)));
    assert_eq!(all["b@x.test"].plan, "Plan");
}

#[test]
fn 狀態列那一行一定有字_只用_ascii() {
    let h = tempfile::tempdir().unwrap();
    for t in ["", "{}", "垃圾\u{0}", samples()[0].as_str()] {
        assert_eq!(hook(h.path(), t, NOW), "Gemini");
    }
    let line = hook(h.path(), &samples()[7], NOW);
    assert_eq!(line, "Gemini 5h 98% | wk 30%");
    assert!(line.is_ascii() && !line.contains('\n'));
}

#[test]
fn 回報列_最近讀到的是使用中_最多五個_過期的窗不送() {
    let h = tempfile::tempdir().unwrap();
    for i in 0..7 {
        let t = status(Some(0.5), Some(0.25)).replace(ME, &format!("u{i}@x.test"));
        record(h.path(), &parse_statusline(&t, NOW).unwrap(), NOW + i * 1000).unwrap();
    }
    let rows = report_rows(&load_all(h.path()), NOW + 10_000);
    assert_eq!(rows.len(), MAX_REPORT);
    assert_eq!(rows[0]["email"], "u6@x.test");
    assert_eq!(rows[0]["current"], true);
    assert!(rows[1..].iter().all(|r| r["current"] == false));
    assert_eq!(rows[0]["vendor"], "gemini");
    assert_eq!(rows[0]["plan"], "Google AI Pro");
    assert_eq!(rows[0]["windows"][0], json!({ "name": "five_hour", "left_pct": 50, "resets_at": "2026-10-29T16:37:30Z", "read_at": "2026-10-29T14:51:06Z" }));
    assert_eq!(rows[0]["windows"][1]["name"], "weekly");
    // 5 小時那窗重置過了：不送那窗，每週的照送
    let later = report_rows(&load_all(h.path()), NOW + 2 * 3_600_000);
    assert_eq!(later[0]["windows"].as_array().unwrap().len(), 1);
    assert_eq!(later[0]["windows"][0]["name"], "weekly");
}

#[test]
fn 守門_gemini_額度模組不碰憑證檔也不連網() {
    let src = include_str!("../gemini_quota.rs");
    let body = src.split("#[cfg(test)]").next().unwrap_or("");
    let banned = [
        ["oauth", "_creds"].concat(),
        ["access", "_token"].concat(),
        ["refresh", "_token"].concat(),
        ["http", "://"].concat(),
        ["https", "://"].concat(),
        ["reqw", "est"].concat(),
        ["Comm", "and::new"].concat(),
        ["antigravity", "-cli"].concat(),
    ];
    for b in banned {
        assert!(!body.contains(&b), "Gemini 額度模組不該出現 {b}");
    }
}

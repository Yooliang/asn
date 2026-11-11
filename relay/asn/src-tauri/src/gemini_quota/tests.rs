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
    assert!(!path(h.path()).exists(), "第一次看到這個視窗：只記下來、不送");
    // 第二次（數值沒變）才送，資料時間是第一次看到的時間
    assert_eq!(hook(h.path(), &status(Some(0.9767), Some(0.3009)), NOW + 60_000), "Gemini 5h 98% | wk 30%");
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
fn 簡化後的規則合併_同一期回升照收_滾動窗與四捨五入的回升是合法的新數字() {
    let h = tempfile::tempdir().unwrap();
    let mk = |f: f64, reset: &str| json!({ "email": ME, "quota": { "gemini-weekly": { "remaining_fraction": f, "reset_time": reset } } }).to_string();
    let r = parse_statusline(&mk(1.0, "2026-11-05T14:51:00Z"), NOW).unwrap();
    assert!(record(h.path(), &r, NOW).unwrap());
    // 開始用了：重置時間固定成較早的時間，照收
    let r = parse_statusline(&mk(0.9, "2026-11-05T13:00:00Z"), NOW + 600_000).unwrap();
    assert!(record(h.path(), &r, NOW + 600_000).unwrap());
    assert_eq!(load_all(h.path())[ME].quota.weekly_pct, Some(90));
    // 同一期剩餘回升（滾動窗、四捨五入）：照收，不再被擋
    let r = parse_statusline(&mk(0.95, "2026-11-05T13:00:00Z"), NOW + 1_200_000).unwrap();
    assert!(record(h.path(), &r, NOW + 1_200_000).unwrap());
    assert_eq!(load_all(h.path())[ME].quota.weekly_pct, Some(95));
    // 重置時間離譜（不在現在前 1 天到後 8 天之間）：不收，記 log（不含 email）
    let r = parse_statusline(&mk(0.5, "2099-01-01T00:00:00Z"), NOW + 1_800_000).unwrap();
    assert!(!record(h.path(), &r, NOW + 1_800_000).unwrap());
    assert_eq!(load_all(h.path())[ME].quota.weekly_pct, Some(95));
    let log = std::fs::read_to_string(log_path(h.path())).unwrap();
    assert!(log.contains("重置時間") && !log.contains("example.test"), "{log}");
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

#[test]
fn 讀數沒有某一窗_存著的那窗已過重置時間才拿掉_還沒過就留著() {
    let h = tempfile::tempdir().unwrap();
    let r = parse_statusline(&status(Some(0.9), Some(0.5)), NOW).unwrap();
    assert!(record(h.path(), &r, NOW).unwrap());
    // 10 分鐘後的讀數只有每週：5 小時（重置時間 16:37）還沒過，留著
    let r = parse_statusline(&status(None, Some(0.4)), NOW + 600_000).unwrap();
    assert!(record(h.path(), &r, NOW + 600_000).unwrap());
    let q = load_all(h.path())[ME].quota.clone();
    assert_eq!((q.five_hour_pct, q.weekly_pct), (Some(90), Some(40)));
    // 2 小時後（過了 16:37）：讀數仍然沒有 5 小時，拿掉
    let t = NOW + 2 * 3_600_000;
    let r = parse_statusline(&status(None, Some(0.4)), t).unwrap();
    record(h.path(), &r, t).unwrap();
    let q = load_all(h.path())[ME].quota.clone();
    assert_eq!((q.five_hour_pct, q.five_reset_at, q.five_at), (None, None, None));
    assert_eq!(q.weekly_pct, Some(40));
}

#[test]
fn 讀數有那一窗但這次不送_存著的過期窗不算缺_不拿掉() {
    // #1321 的「缺一窗」看實際讀數裡有沒有那一窗；#1316 因為「第一次看到」而不送的那窗，讀數裡其實有，不能被當成缺
    let h = tempfile::tempdir().unwrap();
    let r = parse_statusline(&status(Some(0.9), Some(0.5)), NOW).unwrap();
    assert!(record(h.path(), &r, NOW).unwrap());
    let t = NOW + 2 * 3_600_000; // 存著的 5 小時重置時間（16:37）已過
    // 讀數裡的 5 小時是新一期（重置時間在未來），這次不送；每週照送
    let line = status(Some(0.8), Some(0.4)).replace("2026-10-29T16:37:30Z", "2026-10-29T21:37:30Z");
    let r = parse_statusline(&line, t).unwrap();
    assert_eq!(r.parsed.five_hour_pct, Some(80), "讀數裡有 5 小時");
    assert!(record_at(h.path(), &r, (None, Some(t)), t).unwrap());
    let q = load_all(h.path())[ME].quota.clone();
    assert_eq!((q.five_hour_pct, q.weekly_pct), (Some(90), Some(40)), "5 小時沒送也沒被拿掉，每週照新值");
}

#[test]
fn 讀數裡的桶重置時間已過_算沒有這一窗_存著的過期窗拿掉() {
    // bucket() 會丟掉重置時間已過的桶（那個比例是重置前的舊值）：這種讀數＝沒有這一窗，存著的也已過期就拿掉
    let h = tempfile::tempdir().unwrap();
    let r = parse_statusline(&status(Some(0.9), Some(0.5)), NOW).unwrap();
    assert!(record(h.path(), &r, NOW).unwrap());
    let t = NOW + 2 * 3_600_000;
    let r = parse_statusline(&status(Some(0.9), Some(0.4)), t).unwrap();
    assert_eq!(r.parsed.five_hour_pct, None, "重置時間已過的桶被丟掉");
    assert!(record_at(h.path(), &r, (Some(t), Some(t)), t).unwrap());
    let q = load_all(h.path())[ME].quota.clone();
    assert_eq!((q.five_hour_pct, q.five_reset_at, q.weekly_pct), (None, None, Some(40)));
}

// ---------- 資料時間：數值有變才前進（#1316） ----------
const MIN: i64 = 60_000;
/// 某個 agy 視窗（session_id＝sid）送來的狀態列
fn win_status(sid: &str, five: Option<f64>, week: Option<f64>) -> String {
    status(five, week).replace("\"S-1\"", &format!("\"{sid}\""))
}
fn quota_of(h: &tempfile::TempDir) -> Quota {
    load_all(h.path()).remove(ME).expect("要有紀錄").quota
}

#[test]
fn 閒置視窗一直重送同樣的數字_資料時間不前進_別處較新的值不被蓋掉() {
    let h = tempfile::tempdir().unwrap();
    // 視窗 A：第一次看到只記下來；5 小時變了才送，每週沒變沿用第一次看到的時間
    hook(h.path(), &win_status("S-A", Some(0.9), Some(0.5)), NOW);
    assert!(!path(h.path()).exists());
    hook(h.path(), &win_status("S-A", Some(0.8), Some(0.5)), NOW + MIN);
    let q = quota_of(&h);
    assert_eq!((q.five_hour_pct, q.five_at.clone(), q.weekly_pct, q.week_at.clone()), (Some(80), Some(iso_secs(NOW + MIN)), Some(50), Some(iso_secs(NOW))));
    // 視窗 A 閒置，每 5 分鐘一直重送同樣的數字：資料時間不前進
    for i in 2..8 {
        hook(h.path(), &win_status("S-A", Some(0.8), Some(0.5)), NOW + i * 5 * MIN);
    }
    let q = quota_of(&h);
    assert_eq!((q.five_at.clone(), q.week_at.clone()), (Some(iso_secs(NOW + MIN)), Some(iso_secs(NOW))), "重送舊數字不會讓資料時間往前走");
    // 視窗 B（另一個視窗）有新的數字：第一次記下來，變了才送，資料時間是現在
    hook(h.path(), &win_status("S-B", Some(0.7), Some(0.4)), NOW + 40 * MIN);
    hook(h.path(), &win_status("S-B", Some(0.6), Some(0.4)), NOW + 41 * MIN);
    let q = quota_of(&h);
    assert_eq!((q.five_hour_pct, q.five_at.clone(), q.weekly_pct), (Some(60), Some(iso_secs(NOW + 41 * MIN)), Some(40)));
    // 視窗 A 又重送它的舊數字：資料時間是舊的，比記著的早，不收（後台一樣用 older_read 擋）
    hook(h.path(), &win_status("S-A", Some(0.8), Some(0.5)), NOW + 50 * MIN);
    let q = quota_of(&h);
    assert_eq!((q.five_hour_pct, q.weekly_pct), (Some(60), Some(40)), "別處較新的值沒被蓋掉");
    let log = std::fs::read_to_string(log_path(h.path())).unwrap();
    assert!(log.contains("資料時間") && !log.contains("S-A") && !log.contains(ME), "{log}");
}

#[test]
fn 數值變了照送_資料時間是現在_重置時間差十分鐘內算沒變() {
    let h = tempfile::tempdir().unwrap();
    hook(h.path(), &win_status("S-A", Some(0.9), None), NOW);
    hook(h.path(), &win_status("S-A", Some(0.9), None), NOW + MIN);
    assert_eq!(quota_of(&h).five_at, Some(iso_secs(NOW)), "沒變：沿用第一次看到的時間");
    hook(h.path(), &win_status("S-A", Some(0.85), None), NOW + 10 * MIN);
    let q = quota_of(&h);
    assert_eq!((q.five_hour_pct, q.five_at), (Some(85), Some(iso_secs(NOW + 10 * MIN))), "變了：照送，資料時間是現在");
    // 剩餘一樣、重置時間只差幾秒（agy 的重置時間會晃）：算沒變
    let jitter = win_status("S-A", Some(0.85), None).replace("2026-10-29T16:37:30Z", "2026-10-29T16:37:40Z");
    hook(h.path(), &jitter, NOW + 20 * MIN);
    assert_eq!(quota_of(&h).five_at, Some(iso_secs(NOW + 10 * MIN)));
}

#[test]
fn 跨過重置時間_剩餘百分比沒變_新一期照送_資料時間是現在() {
    let h = tempfile::tempdir().unwrap();
    hook(h.path(), &win_status("S-A", Some(0.9), Some(0.5)), NOW);
    hook(h.path(), &win_status("S-A", Some(0.9), Some(0.5)), NOW + MIN);
    let q = quota_of(&h);
    assert_eq!((q.five_hour_pct, q.five_at.clone()), (Some(90), Some(iso_secs(NOW))), "沒變：沿用第一次看到的時間");
    // 3 小時後：舊的重置時間（16:37）已過，agy 給新一期的重置時間，剩餘 % 一樣
    let t = NOW + 3 * 3_600_000;
    let next = win_status("S-A", Some(0.9), Some(0.5)).replace("2026-10-29T16:37:30Z", "2026-10-29T22:37:30Z");
    hook(h.path(), &next, t);
    let q = quota_of(&h);
    assert_eq!((q.five_hour_pct, q.five_at, q.five_reset_at), (Some(90), Some(iso_secs(t)), Some("2026-10-29T22:37:30Z".to_string())), "新一期照送，資料時間是現在");
    assert_eq!(q.week_at, Some(iso_secs(NOW)), "每週沒變，沿用舊的時間");
}

#[test]
fn 第一次看到的視窗只記下來_不送_不寫進本機檔_也不留原值() {
    let h = tempfile::tempdir().unwrap();
    let line = hook(h.path(), &win_status("S-X", Some(0.9), Some(0.5)), NOW);
    assert_eq!(line, "Gemini 5h 90% | wk 50%", "狀態列照樣有字");
    assert!(!path(h.path()).exists(), "不寫進 gemini-quota.json");
    let raw = std::fs::read_to_string(seen::path(h.path())).unwrap();
    for bad in ["S-X", "S-1", "C-1", ME, "secret-proj"] {
        assert!(!raw.contains(bad), "不留 {bad}：{raw}");
    }
    assert!(raw.contains(&seen::session_key("S-X")), "只存雜湊");
    // 同一個視窗之後數值沒變：才送
    hook(h.path(), &win_status("S-X", Some(0.9), Some(0.5)), NOW + MIN);
    assert!(path(h.path()).exists());
}

#[test]
fn 重開後狀態檔還在_不會又變成第一次看到_狀態檔不見才重來() {
    let h = tempfile::tempdir().unwrap();
    hook(h.path(), &win_status("S-A", Some(0.9), None), NOW);
    hook(h.path(), &win_status("S-A", Some(0.8), None), NOW + MIN);
    assert_eq!(quota_of(&h).five_hour_pct, Some(80));
    // 這個視窗之後的讀數直接比對記著的值（沒有「第一次」的空窗）
    hook(h.path(), &win_status("S-A", Some(0.7), None), NOW + 2 * MIN);
    assert_eq!(quota_of(&h).five_hour_pct, Some(70));
    // 狀態檔不見（例如被清掉）：又是第一次看到，只記不送，本機檔維持原樣
    std::fs::remove_file(seen::path(h.path())).unwrap();
    hook(h.path(), &win_status("S-A", Some(0.6), None), NOW + 3 * MIN);
    assert_eq!(quota_of(&h).five_hour_pct, Some(70), "不送");
}

#[test]
fn 兩個視窗的數字不同_各自記_互不影響() {
    let h = tempfile::tempdir().unwrap();
    hook(h.path(), &win_status("S-A", Some(0.9), Some(0.5)), NOW);
    hook(h.path(), &win_status("S-B", Some(0.4), Some(0.3)), NOW + MIN);
    let (ka, kb) = (seen::session_key("S-A"), seen::session_key("S-B"));
    let s = seen::Seen::load(h.path());
    assert_eq!(s.len(), 2);
    assert_eq!(s.get(&ka).unwrap().five.as_ref().map(|w| (w.pct, w.read_ms)), Some((90, NOW)));
    assert_eq!(s.get(&kb).unwrap().five.as_ref().map(|w| (w.pct, w.read_ms)), Some((40, NOW + MIN)));
    // B 的數值變了，只動 B 自己的紀錄
    hook(h.path(), &win_status("S-B", Some(0.35), Some(0.3)), NOW + 2 * MIN);
    let s = seen::Seen::load(h.path());
    assert_eq!(s.get(&ka).unwrap().five.as_ref().map(|w| (w.pct, w.read_ms)), Some((90, NOW)), "A 不受影響");
    assert_eq!(s.get(&kb).unwrap().five.as_ref().map(|w| (w.pct, w.read_ms)), Some((35, NOW + 2 * MIN)));
}

#[test]
fn 沒有視窗代號就沒辦法判斷新舊_這筆不記_狀態列照樣有字() {
    let h = tempfile::tempdir().unwrap();
    let t = status(Some(0.9), Some(0.5)).replace("\"S-1\"", "\"\"").replace("\"C-1\"", "\"\"");
    assert_eq!(hook(h.path(), &t, NOW), "Gemini 5h 90% | wk 50%");
    assert_eq!(hook(h.path(), &t, NOW + MIN), "Gemini 5h 90% | wk 50%");
    assert!(!path(h.path()).exists() && !seen::path(h.path()).exists());
    // session_id 沒有、conversation_id 有：用它
    let t2 = status(Some(0.9), Some(0.5)).replace("\"S-1\"", "\"\"");
    hook(h.path(), &t2, NOW);
    assert!(seen::Seen::load(h.path()).get(&seen::session_key("C-1")).is_some());
}

#[test]
fn 狀態檔最多_32_個視窗_7_天沒更新就刪_壞掉或太大當空的() {
    let h = tempfile::tempdir().unwrap();
    let mut s = seen::Seen::default();
    let p = Parsed { five_hour_pct: Some(50), weekly_pct: None, reset_at: None, five_reset_ms: Some(NOW + 3_600_000), week_reset_ms: None };
    for i in 0..40i64 {
        s.observe(&seen::session_key(&format!("w{i}")), &p, NOW + i * MIN);
    }
    assert_eq!(s.len(), seen::MAX_SESSIONS);
    assert!(s.get(&seen::session_key("w39")).is_some() && s.get(&seen::session_key("w0")).is_none(), "留最近的");
    // 8 天後有新視窗來：舊的全過期被刪
    s.observe(&seen::session_key("new"), &p, NOW + 8 * 86_400_000);
    assert_eq!(s.len(), 1);
    // 壞掉、太大：當空的
    std::fs::create_dir_all(h.path().join(".asn")).unwrap();
    std::fs::write(seen::path(h.path()), "{壞").unwrap();
    assert_eq!(seen::Seen::load(h.path()).len(), 0);
    std::fs::write(seen::path(h.path()), "x".repeat(100_000)).unwrap();
    assert_eq!(seen::Seen::load(h.path()).len(), 0);
}

#[test]
fn 行程代號優先_沒有行程代號才用_session_id_都沒有就不記() {
    let h = tempfile::tempdir().unwrap();
    let no_ids = status(Some(0.9), Some(0.5)).replace("\"S-1\"", "\"\"").replace("\"C-1\"", "\"\"");
    // 剛開窗、還沒對話：沒有 session_id／conversation_id，但找得到 agy 行程 → 照樣記（第一次只記下來）
    let pk = |k: &'static str| move || Some(seen::session_key(k));
    hook_with(h.path(), &no_ids, NOW, &pk("proc-A"));
    assert!(!path(h.path()).exists(), "第一次看到：只記下來");
    assert!(seen::Seen::load(h.path()).get(&seen::session_key("proc-A")).is_some());
    let changed = status(Some(0.8), Some(0.5)).replace("\"S-1\"", "\"\"").replace("\"C-1\"", "\"\"");
    hook_with(h.path(), &changed, NOW + MIN, &pk("proc-A"));
    assert_eq!(quota_of(&h).five_hour_pct, Some(80));
    // 行程代號優先：有 session_id 也用行程代號（同一個行程之後換了對話，代號不變）
    let with_session = win_status("S-NEW", Some(0.7), Some(0.5));
    hook_with(h.path(), &with_session, NOW + 2 * MIN, &pk("proc-A"));
    assert_eq!(quota_of(&h).five_hour_pct, Some(70), "沿用同一個行程代號的紀錄，不會又變成第一次看到");
    assert!(seen::Seen::load(h.path()).get(&seen::session_key("S-NEW")).is_none());
    // 找不到行程代號：退回 session_id
    hook_with(h.path(), &win_status("S-B", Some(0.4), None), NOW + 3 * MIN, &|| None);
    assert!(seen::Seen::load(h.path()).get(&seen::session_key("S-B")).is_some());
    // 兩個都沒有：不記
    let h2 = tempfile::tempdir().unwrap();
    assert_eq!(hook_with(h2.path(), &no_ids, NOW, &|| None), "Gemini 5h 90% | wk 50%");
    assert!(!path(h2.path()).exists() && !seen::path(h2.path()).exists());
}

#[test]
fn 行程代號只在需要時才算_沒有額度的資料不用找行程() {
    let h = tempfile::tempdir().unwrap();
    let called = std::cell::Cell::new(0);
    let f = || {
        called.set(called.get() + 1);
        None
    };
    hook_with(h.path(), "{}", NOW, &f);
    hook_with(h.path(), &samples()[0], NOW, &f);
    assert_eq!(called.get(), 0, "資料還沒有 email 或額度，不用走行程鏈");
    hook_with(h.path(), &status(Some(0.9), None), NOW, &f);
    assert_eq!(called.get(), 1);
}

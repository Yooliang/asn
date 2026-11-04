use super::*;
use crate::acct_remote::with_reader_rows;

const NOW: i64 = 1_793_000_000_000;
const HOUR: i64 = 3_600_000;

fn write_settings(home: &Path, text: &str) {
    std::fs::create_dir_all(home.join(".asn")).unwrap();
    std::fs::write(settings_path(home), text).unwrap();
}

#[test]
fn settings_default_off() {
    let d = tempfile::tempdir().unwrap();
    assert_eq!(load_settings(d.path()), Settings::default(), "沒有檔案就全關");
    write_settings(d.path(), "不是 JSON");
    assert_eq!(load_settings(d.path()), Settings::default(), "壞檔也全關");
    write_settings(d.path(), r#"{"grok":"yes"}"#);
    assert_eq!(load_settings(d.path()), Settings::default(), "型別不對也全關");
    write_settings(d.path(), r#"{"grok":true}"#);
    let s = load_settings(d.path());
    assert!(s.grok && !s.agy && s.minimax.is_empty(), "只開有寫的那項");
}

#[test]
fn settings_minimax_cleaned_and_capped() {
    let d = tempfile::tempdir().unwrap();
    write_settings(d.path(), r#"{"minimax":["A@x.test","壞","b@x.test","c@x.test"]}"#);
    assert_eq!(load_settings(d.path()).minimax, ["a@x.test", "b@x.test"]);
}

#[tokio::test]
async fn all_off_touches_nothing() {
    let d = tempfile::tempdir().unwrap();
    let mut gates = Gates::default();
    let lines = Mutex::new(vec![]);
    tick(d.path(), d.path(), &mut gates, NOW, &|l| lines.lock().unwrap().push(l)).await;
    assert_eq!(gates.grok, Gate::default());
    assert_eq!(gates.agy, Gate::default());
    assert!(lines.lock().unwrap().is_empty());
    assert!(!d.path().join(".asn").exists(), "全關時不建立任何檔案");
}

#[test]
fn grok_login_takes_newest_and_needs_key() {
    let two = br#"{"a":{"email":"Old@x.test","key":"k-old","create_time":"2026-01-01"},"b":{"email":"new@x.test","key":"k-new","create_time":"2026-06-01"}}"#;
    assert_eq!(grok_login(two), Some(("new@x.test".into(), "k-new".into())));
    assert_eq!(grok_login(br#"{"a":{"email":"a@x.test"}}"#), None);
    assert_eq!(grok_login(br#"{"a":{"email":"a@x.test","key":""}}"#), None);
    assert_eq!(grok_login(b"nope"), None);
}

#[test]
fn grok_used_becomes_left() {
    let w = parse_grok(&json!({"config": {"creditUsagePercent": 53, "currentPeriod": {"end": "2026-11-08T00:15:00.000Z"}}}), NOW);
    assert_eq!(w.len(), 1);
    assert_eq!((w[0]["name"].as_str(), w[0]["left_pct"].as_u64()), (Some("weekly"), Some(47)));
    assert_eq!(w[0]["resets_at"], "2026-11-08T00:15:00Z");
    assert_eq!(w[0]["read_at"], iso_secs(NOW));
}

#[test]
fn grok_missing_value_is_not_zero() {
    for v in [json!({"config": {"creditUsagePercent": null}}), json!({"config": {}}), json!({}), json!({"config": {"creditUsagePercent": "53"}}), json!({"config": {"creditUsagePercent": 130}})] {
        assert!(parse_grok(&v, NOW).is_empty(), "{v}");
    }
    let no_end = parse_grok(&json!({"config": {"creditUsagePercent": 10, "currentPeriod": {"end": "壞"}}}), NOW);
    assert_eq!(no_end[0]["resets_at"], Value::Null, "重置時間壞掉不猜");
}

fn minimax_ok() -> Value {
    json!({"base_resp": {"status_code": 0}, "model_remains": [
        {"model_name": "other", "current_interval_remaining_percent": 1},
        {"model_name": "general", "current_interval_remaining_percent": 80.4, "end_time": NOW + HOUR,
         "current_weekly_status": 1, "current_weekly_remaining_percent": 60, "weekly_end_time": NOW + 24 * HOUR}]})
}

#[test]
fn minimax_reads_general() {
    let w = parse_minimax(&minimax_ok(), NOW).unwrap();
    assert_eq!(w.iter().map(|x| (x["name"].as_str().unwrap(), x["left_pct"].as_u64().unwrap())).collect::<Vec<_>>(), [("five_hour", 80), ("weekly", 60)]);
    assert_eq!(w[0]["resets_at"], iso_secs(NOW + HOUR));
}

#[test]
fn minimax_http_200_failure_is_failure() {
    for v in [json!({"base_resp": {"status_code": 1004}}), json!({}), json!({"base_resp": {"status_code": 0}}), json!({"base_resp": {"status_code": 0}, "model_remains": []})] {
        assert!(parse_minimax(&v, NOW).is_err(), "{v}");
    }
}

#[test]
fn minimax_weekly_status_and_missing() {
    let mut v = minimax_ok();
    v["model_remains"][1]["current_weekly_status"] = json!(2);
    v["model_remains"][1]["current_weekly_remaining_percent"] = json!(0);
    let w = parse_minimax(&v, NOW).unwrap();
    assert_eq!(w[1]["left_pct"], 0, "status 2 是真的用完");
    v["model_remains"][1]["current_weekly_status"] = json!(3);
    assert_eq!(parse_minimax(&v, NOW).unwrap().len(), 1, "其他狀態不採用");
    v["model_remains"][1]["current_interval_remaining_percent"] = Value::Null;
    assert!(parse_minimax(&v, NOW).unwrap().is_empty(), "缺值不補 0");
}

const AGY_OK: &str = r#"{"status":"SUCCESS","command":{"data":{"groups":[
  {"name":"Claude and GPT models","buckets":[{"window":"5h","remaining_fraction":0.1,"reset_time":"2030-01-01T00:00:00Z"}]},
  {"name":"Gemini Models","buckets":[{"window":"5h","remaining_fraction":0.8,"reset_time":"2030-01-01T00:00:00Z"},
    {"window":"weekly","remaining_fraction":0.5,"reset_time":"2030-01-02T00:00:00Z"},{"window":"other","remaining_fraction":0.9}]}]}}}"#;

#[test]
fn agy_only_gemini_group_through_statusline_parser() {
    let line = agy_statusline(AGY_OK, "a@x.test").unwrap();
    let r = crate::gemini_quota::parse_statusline(&line, NOW).unwrap();
    assert_eq!(r.email, "a@x.test");
    assert_eq!((r.parsed.five_hour_pct, r.parsed.weekly_pct), (Some(80), Some(50)));
}

#[test]
fn agy_model_reply_is_not_quota() {
    for s in [
        r#"{"status":"SUCCESS","response":"您的額度還有 100%"}"#,
        r#"{"status":"FAILED","command":{"data":{"groups":[]}}}"#,
        r#"{"status":"SUCCESS","command":{"data":{"groups":[{"name":"Other","buckets":[]}]}}}"#,
        "這不是 JSON",
    ] {
        assert_eq!(agy_statusline(s, "a@x.test"), None, "{s}");
    }
}

#[test]
fn gate_success_waits_ten_minutes() {
    let mut g = Gate::default();
    assert!(g.due(NOW, None));
    g.success(NOW);
    assert!(!g.due(NOW + READ_EVERY_MS - 1, None));
    assert!(g.due(NOW + READ_EVERY_MS, None));
}

#[test]
fn gate_backs_off_and_logs_once() {
    let mut g = Gate::default();
    let f = Failure::Other("x".into());
    assert!(g.failure(&f, NOW, None), "第一次記");
    assert!(!g.due(NOW + READ_EVERY_MS - 1, None));
    assert!(!g.failure(&f, NOW, None), "之後不洗版");
    assert!(!g.due(NOW + 2 * READ_EVERY_MS - 1, None), "等待加倍");
    for _ in 0..40 {
        g.failure(&f, NOW, None);
    }
    assert!(g.due(NOW + BACKOFF_MAX_MS, None), "最多等 6 小時，次數再多也不溢位");
    g.success(NOW);
    assert!(g.failure(&f, NOW, None), "恢復後再失敗要再記");
}

#[test]
fn gate_rejected_never_retries_until_login_changes() {
    let mut g = Gate::default();
    assert!(g.failure(&Failure::Auth, NOW, Some(1)));
    assert!(!g.due(NOW + 365 * 24 * HOUR, Some(1)), "憑證沒變就一直不打");
    assert!(g.due(NOW + 1, Some(2)), "重新登入後馬上試");
    let mut g = Gate::default();
    g.failure(&Failure::Other("x".into()), NOW, None);
    assert!(g.failure(&Failure::Auth, NOW, None), "變成被拒要記一次");
    assert!(!g.due(NOW + 365 * 24 * HOUR, None), "沒有記號的來源（MiniMax）要重開或換 key 才再試");
}

#[test]
fn failure_text_has_no_response_content() {
    assert_eq!(Failure::Auth.text(), "登入失效，要重新登入");
}

fn with_windows() -> Store {
    let w = vec![json!({"name": "weekly", "left_pct": 40})];
    let mut s = Store::default();
    s.grok.insert("g@x.test".into(), (w.clone(), NOW));
    s.minimax.insert("m@x.test".into(), (w, NOW));
    s
}

#[test]
fn store_drops_old_and_empty() {
    let s = with_windows();
    assert_eq!(s.grok_windows(NOW).len(), 1);
    assert_eq!(s.minimax_rows(NOW)[0]["vendor"], "minimax");
    assert!(s.grok_windows(NOW + KEEP_MS).is_empty(), "放太久不送");
    assert!(s.minimax_rows(NOW + KEEP_MS).is_empty());
    let mut empty = Store::default();
    empty.minimax.insert("m@x.test".into(), (vec![], NOW));
    assert!(empty.minimax_rows(NOW).is_empty(), "沒讀到就不送列");
}

#[test]
fn store_turned_off_stops_immediately() {
    let mut s = with_windows();
    s.retain(&Settings::default());
    assert!(s.grok_windows(NOW).is_empty() && s.minimax_rows(NOW).is_empty());
}

#[test]
fn report_rows_unchanged_when_nothing_read() {
    let a = vec![json!({"accounts": [{"vendor": "grok", "email": "g@x.test", "plan": "", "current": true}]})];
    assert_eq!(with_reader_rows(a.clone(), &HashMap::new(), &[]), a);
}

#[test]
fn report_grok_windows_go_to_matching_row() {
    let a = vec![json!({"accounts": [{"vendor": "grok", "email": "g@x.test"}, {"vendor": "grok", "email": "h@x.test"}, {"vendor": "claude", "email": "g@x.test"}]})];
    let got = with_reader_rows(a, &with_windows().grok_windows(NOW), &[]);
    assert_eq!(got.len(), 1, "只有 Grok 窗不多一份：舊後台本來就丟掉");
    let rows = got[0]["accounts"].as_array().unwrap();
    assert!(rows[0].get("windows").is_some());
    assert!(rows[1].get("windows").is_none() && rows[2].get("windows").is_none());
}

#[test]
fn report_minimax_goes_first_with_fallback() {
    let a = vec![json!({"accounts": [{"vendor": "claude", "email": "a@x.test", "current": true}]}), json!({"accounts": []})];
    let got = with_reader_rows(a.clone(), &HashMap::new(), &with_windows().minimax_rows(NOW));
    assert_eq!(got.len(), 3);
    assert_eq!(got[0]["accounts"][1]["vendor"], "minimax");
    assert_eq!(got[1..], a[..], "舊後台退回後照原本的順序送");
}

#[test]
fn report_stays_within_twenty_rows() {
    let mut rows: Vec<Value> = (0..20).map(|i| json!({"vendor": "claude", "email": format!("u{i}@x.test"), "current": i == 19})).collect();
    rows[0]["vendor"] = json!("grok");
    let m = vec![json!({"vendor": "minimax"}), json!({"vendor": "minimax"})];
    let got = with_reader_rows(vec![json!({ "accounts": rows })], &HashMap::new(), &m);
    let first = got[0]["accounts"].as_array().unwrap();
    assert_eq!(first.len(), 20);
    assert!(first.iter().any(|r| r["current"] == true), "使用中的留著");
    assert_eq!(first[0]["vendor"], "grok");
}

#[test]
fn source_never_touches_claude_home() {
    let src = include_str!("../quota_readers.rs");
    let code = src.lines().filter(|l| !l.trim_start().starts_with("//")).collect::<Vec<_>>().join("\n");
    assert!(!code.contains(".claude") && !code.contains("claude_home"));
    assert!(!code.contains("println!") && !code.contains("eprintln!"));
}

#[cfg(windows)]
#[test]
fn cred_round_trip() {
    let target = format!("ASN/quota-minimax-test/{}", std::process::id());
    assert_eq!(cred::read(&target), None);
    cred::write(&target, "test-value").unwrap();
    let got = cred::read(&target);
    cred::delete(&target);
    assert_eq!(got.as_deref(), Some("test-value"));
    assert_eq!(cred::read(&target), None);
}

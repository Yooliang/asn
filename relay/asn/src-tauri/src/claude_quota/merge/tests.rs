use super::super::{hook, load_all, parse_iso_secs, parse_statusline};
use super::*;
use serde_json::{json, Value};

// 2026-10-24T12:00:00Z
const NOW: i64 = 1_792_843_200_000;
const H: i64 = 3_600_000;

fn ms(iso: &str) -> i64 {
    parse_iso_secs(iso).expect(iso)
}
/// 狀態列資料：five／week 是 (已用百分比, 重置毫秒)，None＝沒有這條
fn status(five: Option<(f64, i64)>, week: Option<(f64, i64)>) -> String {
    let mut rl = serde_json::Map::new();
    if let Some((u, r)) = five {
        rl.insert("five_hour".into(), json!({ "used_percentage": u, "resets_at": r / 1000 }));
    }
    if let Some((u, r)) = week {
        rl.insert("seven_day".into(), json!({ "used_percentage": u, "resets_at": r / 1000 }));
    }
    json!({ "rate_limits": Value::Object(rl) }).to_string()
}
/// 假的登入狀態：目前帳號要有 accountUuid 才認得（少了它掛鉤會一律回 false）
fn home_as(email: &str) -> tempfile::TempDir {
    let h = tempfile::tempdir().unwrap();
    std::fs::write(h.path().join(".claude.json"), json!({ "oauthAccount": { "emailAddress": email, "accountUuid": "11111111-2222-3333-4444-555555555555" } }).to_string()).unwrap();
    h
}
fn q(h: &tempfile::TempDir) -> Quota {
    load_all(h.path()).remove("a@x.test").expect("要有紀錄")
}
fn log(h: &tempfile::TempDir) -> String {
    std::fs::read_to_string(log_path(h.path())).unwrap_or_default()
}

#[test]
fn 時間字串可以換回毫秒_格式不對就是沒有() {
    assert_eq!(parse_iso_secs("2026-10-24T12:00:00Z"), Some(NOW));
    assert_eq!(parse_iso_secs(&iso_secs(NOW + 12_345_000)), Some(NOW + 12_345_000));
    assert_eq!(parse_iso_secs("2000-02-29T00:00:00Z").map(iso_secs).as_deref(), Some("2000-02-29T00:00:00Z"));
    for bad in ["", "T", "2026-10-24 12:00:00Z", "2026-13-01T00:00:00Z", "2026-10-24T12:00:00+08:00", "２０２６-10-24T12:00:00Z"] {
        assert_eq!(parse_iso_secs(bad), None, "{bad}");
    }
}

#[test]
fn 同一期先_4_再送_35_維持_4_並記_log_記錄時間不動() {
    let h = home_as("a@x.test");
    let r = NOW + 2 * H;
    assert!(hook(h.path(), &status(Some((96.0, r)), None), NOW));
    assert!(!hook(h.path(), &status(Some((65.0, r)), None), NOW + 60_000), "回升的不收");
    let got = q(&h);
    assert_eq!(got.five_hour_pct, Some(4));
    assert_eq!(got.at, iso_secs(NOW), "沒收進新值，記錄時間不動");
    let l = log(&h);
    assert!(l.contains("5 小時額度沒收") && l.contains("4% → 35%"), "{l}");
    assert!(!l.contains("a@x.test"), "log 不印 email");
    // 同一期繼續下降照收，記錄時間跟著更新
    assert!(hook(h.path(), &status(Some((98.0, r)), None), NOW + 120_000));
    assert_eq!((q(&h).five_hour_pct, q(&h).at), (Some(2), iso_secs(NOW + 120_000)));
}

#[test]
fn _5_小時_記著的過了才收較晚的新一期_還沒過就來更晚的不收() {
    let h = home_as("a@x.test");
    assert!(hook(h.path(), &status(Some((96.0, NOW + 2 * H)), None), NOW));
    assert!(!hook(h.path(), &status(Some((10.0, NOW + 4 * H)), None), NOW + H), "記著的還沒到就來更晚的：別的帳號");
    assert_eq!(q(&h).five_hour_pct, Some(4));
    assert!(log(&h).contains("還沒重置"));
    assert!(hook(h.path(), &status(Some((10.0, NOW + 7 * H)), None), NOW + 3 * H), "記著的已過：新的一期");
    let got = q(&h);
    assert_eq!((got.five_hour_pct, got.reset_at.as_deref(), got.at.as_str()), (Some(90), Some(iso_secs(NOW + 7 * H).as_str()), iso_secs(NOW + 3 * H).as_str()));
}

#[test]
fn 重置時間比記著的早是舊視窗的數字_不收() {
    let h = home_as("a@x.test");
    assert!(hook(h.path(), &status(Some((50.0, NOW + 4 * H)), None), NOW));
    assert!(!hook(h.path(), &status(Some((20.0, NOW + 2 * H)), None), NOW + 60_000));
    assert_eq!(q(&h).five_hour_pct, Some(50));
    assert!(log(&h).contains("早"));
}

#[test]
fn 只送每週那條時_5_小時那條保留() {
    let h = home_as("a@x.test");
    let r5 = NOW + 2 * H;
    assert!(hook(h.path(), &status(Some((60.0, r5)), Some((30.0, NOW + 100 * H))), NOW));
    assert!(hook(h.path(), &status(None, Some((40.0, NOW + 100 * H))), NOW + 60_000));
    let got = q(&h);
    assert_eq!((got.five_hour_pct, got.weekly_pct), (Some(40), Some(60)));
    assert_eq!(got.reset_at, Some(iso_secs(r5)), "存的重置時間仍是 5 小時那條的");
}

#[test]
fn 兩條各自判斷_一條不收不影響另一條() {
    // 記著的重置時間屬於 5 小時那條：5 小時回升不收，每週照收
    let h = home_as("a@x.test");
    let r5 = NOW + 2 * H;
    assert!(hook(h.path(), &status(Some((96.0, r5)), Some((30.0, NOW + 100 * H))), NOW));
    assert!(hook(h.path(), &status(Some((65.0, r5)), Some((45.0, NOW + 100 * H))), NOW + 60_000));
    let got = q(&h);
    assert_eq!((got.five_hour_pct, got.weekly_pct), (Some(4), Some(55)));
    assert_eq!(got.at, iso_secs(NOW + 60_000), "有一條收進新值就更新記錄時間");
    assert!(log(&h).contains("5 小時額度沒收") && !log(&h).contains("每週額度沒收"));
    // 記著的重置時間屬於每週那條（每週用完）：每週回升不收，5 小時照收
    let h = home_as("a@x.test");
    let rw = NOW + 100 * H;
    assert!(hook(h.path(), &status(Some((70.0, r5)), Some((100.0, rw))), NOW));
    assert_eq!(q(&h).reset_at, Some(iso_secs(rw)));
    assert!(hook(h.path(), &status(Some((80.0, r5)), Some((50.0, rw))), NOW + 60_000));
    let got = q(&h);
    assert_eq!((got.five_hour_pct, got.weekly_pct), (Some(20), Some(0)));
    assert!(log(&h).contains("每週額度沒收") && !log(&h).contains("5 小時額度沒收"));
}

#[test]
fn 每週_調查員的例子_別的帳號的較晚重置時間不收_新一期要差_7_天的倍數() {
    // gmail 帳號每週在 11/2 00:00（台灣時間）重置；yooliang 帳號在 11/4 17:00 重置
    let gmail = ms("2026-11-01T16:00:00Z");
    let yooliang = ms("2026-11-04T09:00:00Z");
    let next_gmail = ms("2026-11-08T16:00:00Z");
    // 現在＝gmail 重置前 3 天（重置時間要在「現在 +8 天」內才收）
    let start = gmail - 3 * 86_400_000;
    let h = home_as("a@x.test");
    assert!(hook(h.path(), &status(None, Some((30.0, gmail))), start));
    // 記著 gmail（11/2 還沒到），舊視窗送來 yooliang 的數字
    assert!(!hook(h.path(), &status(None, Some((5.0, yooliang))), start + H));
    assert_eq!(q(&h).weekly_pct, Some(70));
    assert!(log(&h).contains("每週額度沒收") && log(&h).contains("還沒重置"));
    // 時間推到 11/2 過後
    let after = gmail + H;
    assert!(!hook(h.path(), &status(None, Some((5.0, yooliang))), after), "差不是 7 天的倍數");
    assert!(log(&h).contains("7 天的倍數"));
    assert_eq!(q(&h).weekly_pct, Some(70));
    assert!(hook(h.path(), &status(None, Some((10.0, next_gmail))), after + 60_000), "差 7 天：新的一期");
    let got = q(&h);
    assert_eq!((got.weekly_pct, got.reset_at), (Some(90), Some(iso_secs(next_gmail))));
}

#[test]
fn 每週_差_7_天倍數的誤差_10_分鐘內才算() {
    let old = ms("2026-11-01T16:00:00Z");
    let now = old + H;
    let w = |d: i64| judge(Kind::Week, Some((50, Some(old))), 80, Some(old + d), now);
    assert!(w(WEEK_MS).is_ok());
    assert!(w(WEEK_MS + 9 * 60_000).is_ok());
    // 隔了兩週：現在要推到記著的過了 6 天，新的重置時間才落在「現在 +8 天」內
    assert!(judge(Kind::Week, Some((50, Some(old))), 80, Some(old + 2 * WEEK_MS - 9 * 60_000), old + 6 * 86_400_000).is_ok(), "隔了兩週也算");
    assert!(w(WEEK_MS + 11 * 60_000).is_err());
    assert!(w(3 * 86_400_000).is_err());
    // 5 小時那條不看倍數：記著的過了，任何較晚的都收
    assert!(judge(Kind::Five, Some((50, Some(old))), 80, Some(old + 7 * H + 123_000), now).is_ok());
}

#[test]
fn 記著的重置時間過了超過_7_天就照收_只過_6_天仍照原規則() {
    let h = home_as("a@x.test");
    let old = NOW + H;
    assert!(hook(h.path(), &status(None, Some((30.0, old))), NOW));
    let odd = 3 * 86_400_000 + 5 * H; // 不是 7 天的倍數
    // 只過了 6 天：仍照原規則，不收
    let six = old + 6 * 86_400_000;
    assert!(!hook(h.path(), &status(None, Some((50.0, six + odd))), six));
    assert_eq!(q(&h).weekly_pct, Some(70));
    // 過了 8 天：任意重置時間都收
    let eight = old + 8 * 86_400_000;
    assert!(hook(h.path(), &status(None, Some((50.0, eight + odd))), eight));
    assert_eq!((q(&h).weekly_pct, q(&h).reset_at), (Some(50), Some(iso_secs(eight + odd))));
    // 5 小時那條也一樣
    assert!(judge(Kind::Five, Some((10, Some(old))), 90, Some(eight + 123_000), eight).is_ok());
}

#[test]
fn 分不出新舊時照舊收下() {
    // 記著的那條沒有重置時間、或新來的沒有重置時間、或之前沒有紀錄
    assert!(judge(Kind::Five, Some((4, None)), 90, Some(NOW + H), NOW).is_ok());
    assert!(judge(Kind::Five, Some((4, Some(NOW + H))), 90, None, NOW).is_ok());
    assert!(judge(Kind::Week, None, 90, Some(NOW + H), NOW).is_ok());
    // 兩條都用完時存的是較晚的那個，分不出是哪條的，兩條都當沒有重置時間
    let both = Quota { five_hour_pct: Some(0), weekly_pct: Some(0), reset_at: Some(iso_secs(NOW + H)), at: iso_secs(NOW) };
    assert_eq!(stored_resets(&both), (None, None));
}

#[test]
fn _5_小時有百分比卻沒有重置時間時_不拿每週的重置時間來頂() {
    let t = r#"{"rate_limits":{"five_hour":{"used_percentage":10},"seven_day":{"used_percentage":20,"resets_at":1793000000}}}"#;
    let p = parse_statusline(t, NOW).unwrap();
    assert_eq!((p.five_hour_pct, p.weekly_pct, p.reset_at.as_deref()), (Some(90), Some(80), None), "畫面會標成 5 小時額度，存的就不能是每週的");
    assert_eq!(p.week_reset_ms, Some(1_793_000_000_000), "每週的重置時間仍用來判斷新舊");
    // 5 小時用完但沒有重置時間、每週沒用完：一樣不拿每週的
    let t = r#"{"rate_limits":{"five_hour":{"used_percentage":100},"seven_day":{"used_percentage":20,"resets_at":1793000000}}}"#;
    assert_eq!(parse_statusline(t, NOW).unwrap().reset_at, None);
    // 只有每週那條：就是每週的
    let t = r#"{"rate_limits":{"seven_day":{"used_percentage":20,"resets_at":1793000000}}}"#;
    assert_eq!(parse_statusline(t, NOW).unwrap().reset_at, Some(iso_secs(1_793_000_000_000)));
}

#[test]
fn log_超過上限只留後半_不會無限長() {
    let h = home_as("a@x.test");
    std::fs::create_dir_all(h.path().join(".asn")).unwrap();
    std::fs::write(log_path(h.path()), "舊的一行記錄\n".repeat(5000)).unwrap();
    log_skipped(h.path(), &[Skipped { kind: Kind::Five, reason: "測試".into() }], NOW);
    let l = log(&h);
    assert!((l.len() as u64) < LOG_MAX_BYTES, "{}", l.len());
    assert!(l.ends_with("5 小時額度沒收：測試\n"));
}

// ---------- 重置時間的合理範圍（#524 審查）：現在前 1 天到後 8 天 ----------
const DAY: i64 = 86_400_000;

#[test]
fn 範圍_很遠的重置時間不收_也不會存進來() {
    let h = home_as("a@x.test");
    let far = ms("2099-01-01T00:00:00Z");
    assert!(!hook(h.path(), &status(None, Some((30.0, far))), NOW), "2099 年的重置時間不收");
    assert!(load_all(h.path()).get("a@x.test").is_none(), "沒有紀錄時也不會存進來");
    assert!(log(&h).contains("每週額度沒收") && log(&h).contains("不在現在前 1 天到後 8 天之間"), "{}", log(&h));
    // 之後正常的回報照收
    assert!(hook(h.path(), &status(None, Some((40.0, NOW + 100 * H))), NOW + 60_000));
    assert_eq!(q(&h).weekly_pct, Some(60));
    // 已經有正常紀錄時，送很遠的也不收，正常的那條不動
    assert!(!hook(h.path(), &status(None, Some((10.0, far))), NOW + 120_000));
    assert_eq!((q(&h).weekly_pct, q(&h).reset_at), (Some(60), Some(iso_secs(NOW + 100 * H))));
}

#[test]
fn 範圍_已經存了很遠的重置時間_正常的照收_鎖住的會解開() {
    let h = home_as("a@x.test");
    std::fs::create_dir_all(h.path().join(".asn")).unwrap();
    let far = "2099-01-01T00:00:00Z";
    std::fs::write(super::super::quota_path(h.path()), json!({ "a@x.test": { "weekly_pct": 70, "reset_at": far, "at": iso_secs(NOW) } }).to_string()).unwrap();
    assert!(hook(h.path(), &status(None, Some((60.0, NOW + 100 * H))), NOW + 60_000), "記著 2099 年的，正常的要收");
    assert_eq!((q(&h).weekly_pct, q(&h).reset_at), (Some(40), Some(iso_secs(NOW + 100 * H))));
    // 解開以後照一般規則：同一期回升不收
    assert!(!hook(h.path(), &status(None, Some((20.0, NOW + 100 * H))), NOW + 120_000));
}

#[test]
fn 範圍_邊界_後_8_天內收_超過不收_前_1_天內收_超過不收() {
    let j = |r: i64| judge(Kind::Five, None, 50, Some(r), NOW);
    assert!(j(NOW + 8 * DAY).is_ok(), "剛好 8 天");
    assert!(j(NOW + 8 * DAY + 1000).is_err());
    assert!(j(NOW - DAY).is_ok(), "剛好前 1 天");
    assert!(j(NOW - DAY - 1000).is_err());
    // 記著的剛好在 +8 天內仍照一般規則（較早不收）；超過 +8 天才當沒有重置時間
    assert!(judge(Kind::Five, Some((40, Some(NOW + 8 * DAY))), 90, Some(NOW + H), NOW).is_err());
    assert!(judge(Kind::Five, Some((40, Some(NOW + 8 * DAY + 1000))), 90, Some(NOW + H), NOW).is_ok());
    // 記著的早於前 1 天不另外處理，照「已過 7 天才照收」（過 2 天、差不是 7 天倍數仍不收）
    assert!(judge(Kind::Week, Some((40, Some(NOW - 2 * DAY))), 90, Some(NOW + 3 * DAY), NOW).is_err());
}

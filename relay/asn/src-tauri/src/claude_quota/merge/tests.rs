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
    let both = Quota { five_hour_pct: Some(0), weekly_pct: Some(0), reset_at: Some(iso_secs(NOW + H)), at: iso_secs(NOW), ..Default::default() };
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
    log_skipped(h.path(), &[Skipped { kind: Kind::Five, code: "same_period_rise", reason: "測試".into() }], NOW);
    let l = log(&h);
    assert!((l.len() as u64) < LOG_MAX_BYTES, "{}", l.len());
    assert!(l.ends_with("5 小時額度沒收：測試\n"));
}

// ---------- 共用案例（#374）：跟後台 SQL 讀同一份，規則不會分成兩套 ----------
const SHARED_CASES: &str = include_str!("../../../../../../tests/fixtures/quota-merge-cases.json");

#[test]
fn 共用案例_每一個都跟預期一致() {
    let v: Value = serde_json::from_str(SHARED_CASES).expect("共用案例要是 JSON");
    let c = &v["constants"];
    assert_eq!((c["same_period_ms"].as_i64(), c["week_ms"].as_i64(), c["expired_after_ms"].as_i64()), (Some(SAME_MS), Some(WEEK_MS), Some(WEEK_MS)), "常數跟案例檔一致");
    assert_eq!((c["reset_past_ms"].as_i64(), c["reset_future_ms"].as_i64()), (Some(RESET_PAST_MS), Some(RESET_FUTURE_MS)), "重置時間範圍跟案例檔一致");
    let cases = v["cases"].as_array().expect("cases");
    assert!(cases.iter().any(|t| t["reason"] == "reset_out_of_range"), "要有範圍外的反向案例");
    assert!(cases.len() >= 20, "案例不該變少：{}", cases.len());
    let win = |w: &Value| -> Option<(u8, Option<i64>)> {
        if w.is_null() {
            return None;
        }
        Some((w["left_pct"].as_u64().unwrap() as u8, w["resets_at"].as_str().map(ms)))
    };
    let mut wrong = vec![];
    for t in cases {
        let id = t["id"].as_str().unwrap();
        // 只有後台的案例（older_read／future_read）：客戶端不做資料讀取時間的判斷，由後台守，這裡跳過
        if t["scope"].as_str() == Some("backend_only") {
            continue;
        }
        let vendor = match t["vendor"].as_str() {
            Some("claude") => Vendor::Claude,
            Some("codex") => Vendor::Codex,
            Some("gemini") => Vendor::Gemini,
            o => panic!("{id} 廠牌不認得：{o:?}"),
        };
        let kind = match t["window"].as_str() {
            Some("five_hour") => Kind::Five,
            Some("weekly") => Kind::Week,
            o => panic!("{id} 窗名不認得：{o:?}"),
        };
        let (new_pct, new_reset) = win(&t["new"]).expect("new 一定有");
        let got = judge_for(vendor, kind, win(&t["old"]), new_pct, new_reset, ms(t["now"].as_str().unwrap()));
        let want_accept = t["accept"].as_bool().unwrap();
        let want_reason = t["reason"].as_str();
        let got_reason = got.as_ref().err().map(|r| r.code);
        if got.is_ok() != want_accept || got_reason != want_reason {
            wrong.push(format!("{id}：預期 {want_accept}/{want_reason:?}，實際 {}/{got_reason:?}", got.is_ok()));
        }
    }
    assert!(wrong.is_empty(), "跟共用案例不一致：{wrong:#?}");
    // 代碼表裡的每個代碼，Rust 都可能回（反過來也守：Rust 回的代碼都在表裡）
    let codes: Vec<&str> = v["reasons"].as_object().unwrap().keys().map(String::as_str).collect();
    for c in ["same_period_rise", "earlier", "later_not_expired", "not_week_multiple", "reset_out_of_range"] {
        assert!(codes.contains(&c), "{c} 不在案例檔的代碼表");
    }
}

// ---------- 兩條各記自己的重置時間（#374） ----------
#[test]
fn 新格式_兩條各存自己的重置時間與讀取時間_舊欄位照寫() {
    let h = home_as("a@x.test");
    let (r5, rw) = (NOW + 2 * H, NOW + 100 * H);
    assert!(hook(h.path(), &status(Some((96.0, r5)), Some((100.0, rw))), NOW));
    let got = q(&h);
    assert_eq!((got.five_reset_at.clone(), got.week_reset_at.clone()), (Some(iso_secs(r5)), Some(iso_secs(rw))));
    assert_eq!(got.reset_at, Some(iso_secs(rw)), "舊的 reset_at 照 pick_reset：每週用完給每週的");
    assert_eq!((got.five_at.clone(), got.week_at.clone()), (Some(iso_secs(NOW)), Some(iso_secs(NOW))));
    // 只有 5 小時那條收進新值：它的讀取時間更新，每週那條留原本的
    assert!(hook(h.path(), &status(Some((97.0, r5)), None), NOW + 60_000));
    let got = q(&h);
    assert_eq!((got.five_at, got.week_at, got.at), (Some(iso_secs(NOW + 60_000)), Some(iso_secs(NOW)), iso_secs(NOW + 60_000)));
}

#[test]
fn 兩條都用完時每週那條也分得出新舊_以前的限制解掉了() {
    // 舊做法兩條都用完時只存一個較晚的時間，兩條都當沒有重置時間、照收；現在各存一個，每週回升照樣擋下
    let h = home_as("a@x.test");
    let (r5, rw) = (NOW + 2 * H, NOW + 100 * H);
    assert!(hook(h.path(), &status(Some((100.0, r5)), Some((100.0, rw))), NOW));
    assert!(!hook(h.path(), &status(None, Some((60.0, rw))), NOW + 60_000), "同一期每週回升不收");
    assert_eq!(q(&h).weekly_pct, Some(0));
    assert!(log(&h).contains("每週額度沒收"));
}

#[test]
fn 舊格式的檔照樣讀得到_沒有各條重置時間就照舊反推() {
    let h = home_as("a@x.test");
    std::fs::create_dir_all(h.path().join(".asn")).unwrap();
    let r5 = NOW + 2 * H;
    std::fs::write(super::super::quota_path(h.path()), json!({ "a@x.test": { "five_hour_pct": 40, "weekly_pct": 70, "reset_at": iso_secs(r5), "at": iso_secs(NOW) } }).to_string()).unwrap();
    let got = q(&h);
    assert_eq!((got.five_hour_pct, got.weekly_pct, got.reset_at.clone(), got.five_reset_at.clone(), got.five_at.clone()), (Some(40), Some(70), Some(iso_secs(r5)), None, None));
    assert_eq!(stored_resets(&got), (Some(r5), None), "舊檔：沒用完時那一個屬於 5 小時那條");
    // 回報的額度窗：讀取時間退回整筆的 at；每週那條推不出重置時間就是 null
    let w = got.windows();
    assert_eq!(w[0], json!({ "name": "five_hour", "left_pct": 40, "resets_at": iso_secs(r5), "read_at": iso_secs(NOW) }));
    assert_eq!(w[1], json!({ "name": "weekly", "left_pct": 70, "resets_at": null, "read_at": iso_secs(NOW) }));
    // 舊檔照舊判斷：5 小時回升不收
    assert!(!hook(h.path(), &status(Some((50.0, r5)), None), NOW + 60_000));
    // 新格式的檔：不認得的欄位舊版會略過（這裡確認新版讀新欄位、各條沒百分比的就不留）
    std::fs::write(super::super::quota_path(h.path()), json!({ "a@x.test": { "weekly_pct": 70, "at": iso_secs(NOW), "five_reset_at": iso_secs(r5), "week_reset_at": "壞", "week_at": iso_secs(NOW) } }).to_string()).unwrap();
    let got = q(&h);
    assert_eq!((got.five_reset_at, got.week_reset_at, got.week_at), (None, None, Some(iso_secs(NOW))), "沒有 5 小時百分比就不留它的重置時間；格式不對的丟掉");
}

#[test]
fn 新格式那條明寫的重置時間優先_不拿舊的反推() {
    let r5 = NOW + 2 * H;
    let rw = NOW + 100 * H;
    let qq = Quota { five_hour_pct: Some(0), weekly_pct: Some(0), reset_at: Some(iso_secs(rw)), at: iso_secs(NOW), five_reset_at: Some(iso_secs(r5)), week_reset_at: Some(iso_secs(rw)), ..Default::default() };
    assert_eq!(stored_resets(&qq), (Some(r5), Some(rw)));
}

#[test]
fn 不收的原因代碼跟後台一致() {
    let old = Some((40, Some(NOW + H)));
    assert_eq!(judge(Kind::Five, old, 50, Some(NOW + H), NOW).unwrap_err().code, "same_period_rise");
    assert_eq!(judge(Kind::Five, old, 50, Some(NOW - H), NOW).unwrap_err().code, "earlier");
    assert_eq!(judge(Kind::Five, old, 50, Some(NOW + 5 * H), NOW).unwrap_err().code, "later_not_expired");
    assert_eq!(judge(Kind::Week, old, 50, Some(NOW + 5 * H), NOW + 2 * H).unwrap_err().code, "not_week_multiple");
    assert!(judge_for(Vendor::Codex, Kind::Week, old, 50, Some(NOW + 5 * H), NOW + 2 * H).is_ok(), "Codex 每週不看倍數");
    assert_eq!(judge(Kind::Five, None, 50, Some(NOW + 9 * 86_400_000), NOW).unwrap_err().code, "reset_out_of_range");
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

// ---------- 每週待確認（#1184）：過期後同一個新重置時間連續 3 次、隔滿 10 分鐘才收 ----------

fn parsed_week(pct: u8, reset: i64) -> Parsed {
    Parsed { five_hour_pct: None, weekly_pct: Some(pct), reset_at: Some(iso_secs(reset)), five_reset_ms: None, week_reset_ms: Some(reset) }
}

fn state_text(h: &tempfile::TempDir) -> String {
    std::fs::read_to_string(super::super::state::state_path(h.path())).unwrap_or_default()
}

#[test]
fn 共用案例_待確認序列_每一步都跟預期一致() {
    let v: Value = serde_json::from_str(SHARED_CASES).expect("共用案例要是 JSON");
    let c = &v["constants"];
    assert_eq!((c["confirm_count"].as_u64(), c["confirm_span_ms"].as_i64()), (Some(CONFIRM_COUNT as u64), Some(CONFIRM_SPAN_MS)), "待確認常數跟案例檔一致");
    let seqs = v["confirm_sequences"].as_array().expect("confirm_sequences");
    assert!(seqs.len() >= 6, "序列不該變少");
    let win = |w: &Value| -> (u8, Option<i64>) { (w["left_pct"].as_u64().unwrap() as u8, w["resets_at"].as_str().map(ms)) };
    let mut wrong = vec![];
    for t in seqs {
        let id = t["id"].as_str().unwrap();
        let mut old = Some(win(&t["old"]));
        let mut pend: Option<Pending> = None;
        for (i, st) in t["steps"].as_array().unwrap().iter().enumerate() {
            let (pct, reset) = win(&st["new"]);
            let (merged, took, skipped, next) = merge_one(Vendor::Claude, Kind::Week, old, Some((pct, reset)), pend, ms(st["now"].as_str().unwrap()));
            let want = st["accept"].as_bool().unwrap();
            let got_reason = skipped.as_ref().map(|s| s.code);
            if took != want || got_reason != st["reason"].as_str() {
                wrong.push(format!("{id} 第 {} 步：預期 {want}/{:?}，實際 {took}/{got_reason:?}", i + 1, st["reason"].as_str()));
            }
            old = merged;
            pend = next;
        }
    }
    assert!(wrong.is_empty(), "跟共用案例不一致：{wrong:#?}");
}

#[test]
fn 待確認_次數與間隔的邊界() {
    let r = 1_000_000_000_000;
    let (ok, p) = confirm_week(None, r, NOW);
    assert!(!ok && p == Some(Pending { reset_ms: r, count: 1, first_ms: NOW }));
    let (ok, p) = confirm_week(p, r + 9 * 60_000, NOW + 1000); // 差 10 分鐘內算同一個
    assert!(!ok && p.unwrap().count == 2 && p.unwrap().reset_ms == r, "待確認的重置時間不跟著漂");
    let (ok, p) = confirm_week(p, r + 11 * 60_000, NOW + 2000); // 差超過 10 分鐘＝不同，重新計
    assert!(!ok && p == Some(Pending { reset_ms: r + 11 * 60_000, count: 1, first_ms: NOW + 2000 }));
    let (ok, p) = confirm_week(Some(Pending { reset_ms: r, count: 2, first_ms: NOW }), r, NOW + CONFIRM_SPAN_MS);
    assert!(ok && p.is_none(), "第 3 次且剛好隔 10 分鐘＝收");
}

/// 記著 gmail 的一期，時間推到它過期 5 天後；回 (家目錄, 現在, 新重置時間 A, 新重置時間 B)，A、B 都不是 7 天倍數
fn expired_home() -> (tempfile::TempDir, i64, i64, i64) {
    let gmail = ms("2026-11-01T16:00:00Z");
    let h = home_as("a@x.test");
    assert!(hook(h.path(), &status(None, Some((30.0, gmail))), gmail - 3 * DAY));
    let now = gmail + 5 * DAY;
    (h, now, now + 6 * DAY + 5 * H, now + 5 * DAY + 2 * H)
}

#[test]
fn 待確認_同一個新重置時間連續三次且隔十分鐘才收_狀態存檔重開不歸零() {
    let (h, now, a, _) = expired_home();
    assert!(!hook(h.path(), &status(None, Some((40.0, a))), now));
    assert!(!hook(h.path(), &status(None, Some((40.0, a))), now + 5 * 60_000));
    assert!(state_text(&h).contains("\"count\":2"), "次數存在狀態檔：{}", state_text(&h));
    assert_eq!(q(&h).weekly_pct, Some(70), "還沒收");
    assert!(hook(h.path(), &status(None, Some((40.0, a))), now + 10 * 60_000), "第 3 次且隔滿 10 分鐘");
    let got = q(&h);
    assert_eq!((got.weekly_pct, got.week_reset_at), (Some(60), Some(iso_secs(a))), "換成新基準");
    assert!(!state_text(&h).contains("pending_week"), "收下後待確認清掉：{}", state_text(&h));
}

#[test]
fn 待確認_交錯送兩組重置時間_不會誤收() {
    let (h, now, a, b) = expired_home();
    for i in 0..12 {
        let r = if i % 2 == 0 { a } else { b };
        assert!(!hook(h.path(), &status(None, Some((40.0, r))), now + i * 5 * 60_000), "第 {i} 次");
    }
    assert_eq!(q(&h).weekly_pct, Some(70));
}

#[test]
fn 待確認_記著的還沒過期時倍數規則照擋_不累計() {
    let gmail = ms("2026-11-01T16:00:00Z");
    let yooliang = ms("2026-11-04T09:00:00Z");
    let start = gmail - 3 * DAY;
    let h = home_as("a@x.test");
    assert!(hook(h.path(), &status(None, Some((30.0, gmail))), start));
    for i in 1..=6 {
        assert!(!hook(h.path(), &status(None, Some((5.0, yooliang))), start + i * 20 * 60_000));
    }
    assert_eq!(q(&h).weekly_pct, Some(70));
    assert!(!state_text(&h).contains("pending_week"), "還沒過期不累計待確認：{}", state_text(&h));
}

#[test]
fn log_同一個原因只記一次_收進新值後再發生才再記() {
    let (h, now, a, _) = expired_home();
    let lines = |h: &tempfile::TempDir| log(h).lines().filter(|l| l.contains("7 天的倍數")).count();
    for i in 0..5 {
        hook(h.path(), &status(None, Some((40.0, a))), now + i * 1000);
    }
    assert_eq!(lines(&h), 1, "連續 5 次同一原因只記一行：{}", log(&h));
    // 隔滿 10 分鐘收下新的一期，原因清掉
    assert!(hook(h.path(), &status(None, Some((40.0, a))), now + 11 * 60_000));
    assert_eq!(lines(&h), 1);
    // a 過期之後又來一個不是 7 天倍數的：原因又發生，要再記一行
    let later = a + 2 * DAY;
    let odd = later + 3 * DAY + 5 * H;
    assert!(!hook(h.path(), &status(None, Some((40.0, odd))), later));
    assert_eq!(lines(&h), 2, "收下之後再發生要再記：{}", log(&h));
}

#[test]
fn 換身分_該帳號舊基準丟掉_照新帳號的數字收_同帳號正常更新照舊() {
    let gmail = ms("2026-11-01T16:00:00Z");
    let yooliang = ms("2026-11-04T09:00:00Z");
    let start = gmail - 3 * DAY;
    let write = |h: &tempfile::TempDir, email: &str, uuid: &str| {
        std::fs::write(h.path().join(".claude.json"), json!({ "oauthAccount": { "emailAddress": email, "accountUuid": uuid } }).to_string()).unwrap();
    };
    let h = tempfile::tempdir().unwrap();
    write(&h, "a@x.test", "uuid-a");
    assert!(hook(h.path(), &status(None, Some((30.0, gmail))), start));
    assert!(!hook(h.path(), &status(None, Some((5.0, yooliang))), start + H), "同一個身分：照舊規則擋");
    assert!(hook(h.path(), &status(None, Some((35.0, gmail))), start + 2 * H), "同帳號正常更新照舊");
    // 換成 b：b 沒有基準，第一筆不收，同一組重置時間連續 3 次隔 10 分鐘才收
    write(&h, "b@x.test", "uuid-b");
    let t = start + 3 * H;
    assert!(!hook(h.path(), &status(None, Some((50.0, yooliang))), t));
    assert!(!hook(h.path(), &status(None, Some((50.0, yooliang))), t + 5 * 60_000));
    assert!(hook(h.path(), &status(None, Some((50.0, yooliang))), t + 10 * 60_000));
    assert_eq!(load_all(h.path())["b@x.test"].weekly_pct, Some(50));
    // 換回 a：a 的舊基準丟掉，同樣要確認才收
    write(&h, "a@x.test", "uuid-a");
    let t = start + 5 * H;
    assert!(!hook(h.path(), &status(None, Some((10.0, yooliang))), t));
    assert!(!load_all(h.path()).contains_key("a@x.test"));
    assert!(!hook(h.path(), &status(None, Some((10.0, yooliang))), t + 5 * 60_000));
    assert!(hook(h.path(), &status(None, Some((10.0, yooliang))), t + 10 * 60_000));
    assert_eq!(load_all(h.path())["a@x.test"].weekly_pct, Some(90));
}

#[test]
fn 換身分後_舊帳號視窗交錯送兩組重置時間_不會收() {
    let gmail = ms("2026-11-01T16:00:00Z");
    let a = gmail + 4 * DAY;
    let b = gmail + 6 * DAY + 5 * H;
    let write = |h: &tempfile::TempDir, email: &str, uuid: &str| {
        std::fs::write(h.path().join(".claude.json"), json!({ "oauthAccount": { "emailAddress": email, "accountUuid": uuid } }).to_string()).unwrap();
    };
    let h = tempfile::tempdir().unwrap();
    write(&h, "a@x.test", "uuid-a");
    assert!(hook(h.path(), &status(None, Some((30.0, gmail))), gmail - 3 * DAY));
    write(&h, "b@x.test", "uuid-b");
    let t = gmail - 2 * DAY;
    for i in 0..12 {
        let r = if i % 2 == 0 { a } else { b };
        assert!(!hook(h.path(), &status(None, Some((40.0, r))), t + i * 5 * 60_000), "第 {i} 次");
    }
    assert!(!load_all(h.path()).contains_key("b@x.test"));
}

#[test]
fn 讀不到身分_什麼都不記_也不留狀態檔() {
    let h = tempfile::tempdir().unwrap();
    assert!(!hook(h.path(), &status(None, Some((30.0, NOW + 100 * H))), NOW));
    assert!(!super::super::state::state_path(h.path()).exists());
    assert!(!super::super::quota_path(h.path()).exists());
}

#[test]
fn 狀態檔壞掉或太大_當成空的_不當機() {
    let h = home_as("a@x.test");
    std::fs::create_dir_all(h.path().join(".asn")).unwrap();
    std::fs::write(super::super::state::state_path(h.path()), "{壞掉").unwrap();
    assert!(hook(h.path(), &status(None, Some((30.0, NOW + 100 * H))), NOW));
    std::fs::write(super::super::state::state_path(h.path()), "x".repeat(10_000)).unwrap();
    assert!(hook(h.path(), &status(None, Some((40.0, NOW + 100 * H))), NOW + 60_000));
}

#[test]
fn 沒帶待確認狀態的_merge_每次都當第一次看到_行為跟以前一樣() {
    let gmail = ms("2026-11-01T16:00:00Z");
    let old = Quota { weekly_pct: Some(70), week_reset_at: Some(iso_secs(gmail)), at: iso_secs(gmail - DAY), ..Default::default() };
    let now = gmail + 5 * DAY;
    let (q, s) = merge(Some(&old), &parsed_week(60, now + 6 * DAY + 5 * H), now);
    assert!(q.is_none() && s.len() == 1 && s[0].code == "not_week_multiple");
}

// ---------- 視窗帶帳號身分（#1185）：同一台同時開著兩個帳號的視窗，數字各記各的 ----------
const UA: &str = "aaaaaaaa-1111-2222-3333-444444444444";
const UB: &str = "bbbbbbbb-1111-2222-3333-444444444444";

fn add_account(h: &std::path::Path, email: &str, uuid: &str) {
    let d = h.join(".asn").join("claude-accounts").join(crate::claude_accounts::email_dir_name(email));
    std::fs::create_dir_all(&d).unwrap();
    std::fs::write(d.join("account.json"), json!({ "accountUuid": uuid, "emailAddress": email }).to_string()).unwrap();
}
/// 這個視窗的對話紀錄：`<home>/.claude/projects/p/<name>.jsonl`，最後一筆是 session-owner
fn transcript(h: &std::path::Path, name: &str, uuid: &str) -> std::path::PathBuf {
    let d = h.join(".claude").join("projects").join("p");
    std::fs::create_dir_all(&d).unwrap();
    let f = d.join(format!("{name}.jsonl"));
    let line = json!({ "type": "session-owner", "accountUuid": uuid, "organizationUuid": "cccccccc-1111-2222-3333-444444444444" }).to_string();
    std::fs::write(&f, format!("{{\"type\":\"user\"}}\n{line}\n")).unwrap();
    f
}
/// 狀態列輸入加上 transcript_path
fn with_tp(status_json: String, tp: &std::path::Path) -> String {
    let mut v: Value = serde_json::from_str(&status_json).unwrap();
    v["transcript_path"] = json!(tp.to_string_lossy());
    v.to_string()
}
fn hook_owned_in(h: &tempfile::TempDir, input: &str, now: i64) -> bool {
    super::super::hook_in(h.path(), &h.path().join(".claude"), input, now)
}
fn quota_of(h: &tempfile::TempDir, email: &str) -> Quota {
    load_all(h.path()).remove(email).unwrap_or_else(|| panic!("{email} 要有紀錄"))
}

#[test]
fn 身分_兩個帳號的視窗交錯回報_各記各的_不互相污染() {
    // 目前 .claude.json 登入的是 a；b 的視窗還開著，兩邊交錯送數字，重置時間也不同（c8 的情形）
    let h = home_as("a@x.test");
    add_account(h.path(), "a@x.test", UA);
    add_account(h.path(), "b@x.test", UB);
    let (ta, tb) = (transcript(h.path(), "wa", UA), transcript(h.path(), "wb", UB));
    let (ra, rb) = (NOW + 3 * DAY, NOW + 5 * DAY + 5 * H); // 兩個重置時間差不是 7 天的倍數
    for i in 0..12 {
        let t = NOW + i * 5 * 60_000;
        assert!(hook_owned_in(&h, &with_tp(status(None, Some((10.0 + i as f64, ra))), &ta), t), "a 第 {i} 次");
        assert!(hook_owned_in(&h, &with_tp(status(None, Some((50.0 + i as f64, rb))), &tb), t + 1000), "b 第 {i} 次");
    }
    let (qa, qb) = (quota_of(&h, "a@x.test"), quota_of(&h, "b@x.test"));
    assert_eq!((qa.weekly_pct, qa.week_reset_at), (Some(100 - 21), Some(iso_secs(ra))));
    assert_eq!((qb.weekly_pct, qb.week_reset_at), (Some(100 - 61), Some(iso_secs(rb))));
    assert!(qa.owner && qb.owner, "有身分的紀錄有標記");
    assert!(!log(&h).contains("沒收"), "沒有任何一筆被當成別的帳號：{}", log(&h));
}

#[test]
fn 身分_對不到已知帳號_只留本機未知區_不進額度檔() {
    let h = home_as("a@x.test");
    add_account(h.path(), "a@x.test", UA);
    let t = transcript(h.path(), "wx", "dddddddd-1111-2222-3333-444444444444");
    assert!(!hook_owned_in(&h, &with_tp(status(None, Some((30.0, NOW + 3 * DAY))), &t), NOW));
    assert!(!super::super::quota_path(h.path()).exists(), "不進額度檔");
    let unk = super::super::owner_store::unknown_load(h.path());
    assert_eq!(unk.keys().collect::<Vec<_>>(), ["dddddddd-1111-2222-3333-444444444444"]);
}

#[test]
fn 身分_查不到時走舊辦法_記在目前登入的帳號() {
    let h = home_as("a@x.test");
    // 沒有 transcript_path
    assert!(hook_owned_in(&h, &status(None, Some((30.0, NOW + 3 * DAY))), NOW));
    assert!(!q(&h).owner, "舊辦法記的沒有身分標記");
    // transcript_path 指到 projects 以外：不信，也走舊辦法
    let outside = h.path().join("evil.jsonl");
    std::fs::write(&outside, json!({ "type": "session-owner", "accountUuid": UB }).to_string()).unwrap();
    add_account(h.path(), "b@x.test", UB);
    assert!(hook_owned_in(&h, &with_tp(status(None, Some((20.0, NOW + 3 * DAY))), &outside), NOW + 60_000));
    assert_eq!(q(&h).weekly_pct, Some(80), "記在 a，不是 b");
    assert!(!load_all(h.path()).contains_key("b@x.test"));
}

#[test]
fn 身分_第一次有身分的回報清掉沒有標記的舊基準_備份一份_log_只記筆數() {
    let h = home_as("a@x.test");
    add_account(h.path(), "a@x.test", UA);
    // 舊辦法記一筆（可能混進別的帳號的數字）
    assert!(hook_owned_in(&h, &status(None, Some((5.0, NOW + 3 * DAY))), NOW));
    assert_eq!(q(&h).weekly_pct, Some(95));
    let t = transcript(h.path(), "wa", UA);
    // 有身分的回報，剩餘比舊基準高、重置時間也不同：因為舊基準被清掉，照收
    assert!(hook_owned_in(&h, &with_tp(status(None, Some((60.0, NOW + 5 * DAY + 5 * H))), &t), NOW + 60_000));
    let got = q(&h);
    assert_eq!(got.weekly_pct, Some(40));
    assert!(got.owner);
    let bak = super::super::owner_store::backup_path(h.path());
    assert!(bak.exists(), "備份了一份");
    let bak_text = std::fs::read_to_string(&bak).unwrap();
    assert!(bak_text.contains("\"weekly_pct\":95"), "備份是清掉之前的內容");
    let l = log(&h);
    assert!(l.contains("清掉 1 筆沒有身分的舊基準"), "{l}");
    assert!(!l.contains("a@x.test") && !l.contains(UA), "log 不含 email 與 uuid");
    // 之後同一個帳號的回報不再清、不再備份
    std::fs::remove_file(&bak).unwrap();
    assert!(hook_owned_in(&h, &with_tp(status(None, Some((70.0, NOW + 5 * DAY + 5 * H))), &t), NOW + 120_000));
    assert!(!bak.exists());
    assert_eq!(q(&h).weekly_pct, Some(30));
    assert_eq!(log(&h).matches("清掉").count(), 1);
}

#[test]
fn 身分_uuid_對應_email_先看帳號庫_資料夾名對不上不用_再看登入檔_都沒有就是未知() {
    let h = home_as("cur@x.test"); // .claude.json 的 accountUuid 是 11111111-2222-3333-4444-555555555555
    add_account(h.path(), "a@x.test", UA);
    assert_eq!(crate::claude_accounts::email_of_account_uuid(h.path(), &h.path().join(".claude"), UA).as_deref(), Some("a@x.test"));
    // 資料夾名跟 email 對不上（被改名／被塞假檔）：不用
    let root = h.path().join(".asn").join("claude-accounts");
    std::fs::create_dir_all(root.join("wrong-name")).unwrap();
    std::fs::write(root.join("wrong-name").join("account.json"), json!({ "accountUuid": UB, "emailAddress": "b@x.test" }).to_string()).unwrap();
    assert_eq!(crate::claude_accounts::email_of_account_uuid(h.path(), &h.path().join(".claude"), UB), None);
    // 帳號庫沒有、但正是目前登入的帳號：看 .claude.json
    assert_eq!(crate::claude_accounts::email_of_account_uuid(h.path(), &h.path().join(".claude"), "11111111-2222-3333-4444-555555555555").as_deref(), Some("cur@x.test"));
    assert_eq!(crate::claude_accounts::email_of_account_uuid(h.path(), &h.path().join(".claude"), ""), None);
    assert_eq!(crate::claude_accounts::email_of_account_uuid(h.path(), &h.path().join(".claude"), "eeeeeeee-0000-0000-0000-000000000000"), None);
}

// ---------- 狀態檔不留明文身分、舊格式平順轉換、剛換帳號的提示（#1185） ----------
fn state_file(h: &tempfile::TempDir) -> String {
    std::fs::read_to_string(super::super::state::state_path(h.path())).unwrap_or_default()
}
fn login_as(h: &tempfile::TempDir, email: &str, uuid: &str) {
    std::fs::write(h.path().join(".claude.json"), json!({ "oauthAccount": { "emailAddress": email, "accountUuid": uuid } }).to_string()).unwrap();
}

#[test]
fn 狀態檔的登入身分存雜湊_不留明文_email_與_uuid() {
    let h = home_as("a@x.test");
    assert!(hook(h.path(), &status(None, Some((30.0, NOW + 3 * DAY))), NOW));
    let t = state_file(&h);
    assert!(t.contains("\"identity\":\"h1:"), "{t}");
    assert!(!t.contains("a@x.test") && !t.contains("11111111-2222-3333-4444-555555555555"), "狀態檔不該有明文身分：{t}");
}

#[test]
fn 舊格式明文身分的狀態檔_平順轉成雜湊_不會誤判成換帳號() {
    let h = home_as("a@x.test");
    std::fs::create_dir_all(h.path().join(".asn")).unwrap();
    std::fs::write(super::super::state::state_path(h.path()), r#"{"identity":"a@x.test|11111111-2222-3333-4444-555555555555"}"#).unwrap();
    // 若被當成換帳號，第一筆要等確認、不會收；平順轉換則第一筆直接收
    assert!(hook(h.path(), &status(None, Some((30.0, NOW + 3 * DAY))), NOW));
    let t = state_file(&h);
    assert!(t.contains("\"identity\":\"h1:") && !t.contains("a@x.test"), "{t}");
    assert!(!t.contains("\"rebase\""), "{t}");
    // 真的換成別的身分，舊格式也照樣判斷得出來
    std::fs::write(super::super::state::state_path(h.path()), r#"{"identity":"zzz@x.test|99999999-0000-0000-0000-000000000000"}"#).unwrap();
    assert!(!hook(h.path(), &status(None, Some((20.0, NOW + 3 * DAY))), NOW + 60_000), "別的身分：要等確認");
    assert!(state_file(&h).contains("\"rebase\":true"));
}

#[test]
fn 剛換帳號等確認時畫面資料標_waiting_確認收下後就沒有了() {
    let h = home_as("a@x.test");
    assert!(hook(h.path(), &status(None, Some((30.0, NOW + 3 * DAY))), NOW));
    assert!(super::super::quota_all_with_waiting(h.path()).get("b@x.test").is_none());
    login_as(&h, "b@x.test", "22222222-0000-0000-0000-000000000000");
    let r = NOW + 4 * DAY;
    assert!(!hook(h.path(), &status(None, Some((40.0, r))), NOW + 60_000));
    let all = super::super::quota_all_with_waiting(h.path());
    assert_eq!(all.get("b@x.test"), Some(&json!({ "waiting": true })), "b 還在等確認");
    assert!(all.get("a@x.test").is_some_and(|v| v.get("weekly_pct").is_some()), "a 的紀錄照舊");
    assert!(!hook(h.path(), &status(None, Some((40.0, r))), NOW + 5 * 60_000 + 60_000));
    assert!(hook(h.path(), &status(None, Some((40.0, r))), NOW + 10 * 60_000 + 60_000));
    let all = super::super::quota_all_with_waiting(h.path());
    assert_eq!(all["b@x.test"]["weekly_pct"], 60);
    assert!(all["b@x.test"].get("waiting").is_none());
}

#[test]
fn 身分_備援先看視窗自己的設定資料夾裡的_claude_json_再看家目錄_uuid_要對得上() {
    let h = tempfile::tempdir().unwrap();
    let cfg = h.path().join("cfg-b");
    std::fs::create_dir_all(&cfg).unwrap();
    // 家目錄那份登入的是 home@x.test；這個視窗的設定資料夾登入的是 cfgb@x.test
    let cj = |dir: &std::path::Path, email: &str, uuid: &str| std::fs::write(dir.join(".claude.json"), json!({ "oauthAccount": { "emailAddress": email, "accountUuid": uuid } }).to_string()).unwrap();
    cj(h.path(), "home@x.test", "11111111-0000-0000-0000-00000000000a");
    cj(&cfg, "cfgb@x.test", "22222222-0000-0000-0000-00000000000b");
    let f = |uuid: &str| crate::claude_accounts::email_of_account_uuid(h.path(), &cfg, uuid);
    assert_eq!(f("22222222-0000-0000-0000-00000000000b").as_deref(), Some("cfgb@x.test"), "先看這個視窗自己的設定資料夾");
    assert_eq!(f("11111111-0000-0000-0000-00000000000a").as_deref(), Some("home@x.test"), "設定資料夾沒有才看家目錄");
    assert_eq!(f("33333333-0000-0000-0000-000000000000"), None, "uuid 對不上就不用");
}

#[test]
fn 狀態檔裡各帳號自己的狀態用_email_雜湊當鍵_不留明文() {
    let h = home_as("a@x.test");
    add_account(h.path(), "a@x.test", UA);
    let t = transcript(h.path(), "wa", UA);
    assert!(hook_owned_in(&h, &with_tp(status(None, Some((30.0, NOW + 3 * DAY))), &t), NOW));
    let s = state_file(&h);
    assert!(s.contains("\"e1:") && !s.contains("a@x.test"), "{s}");
}

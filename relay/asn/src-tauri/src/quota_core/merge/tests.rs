use super::super::{parse_iso_secs, quota_from_value};
use super::*;
use serde_json::{json, Value};

// 2026-10-24T12:00:00Z
const NOW: i64 = 1_792_843_200_000;
const H: i64 = 3_600_000;
const DAY: i64 = 86_400_000;
const MIN: i64 = 60_000;

fn ms(iso: &str) -> i64 {
    parse_iso_secs(iso).expect(iso)
}
/// 一次讀到的額度：five／week 是 (已用百分比, 重置毫秒)，None＝沒有這條（跟 Gemini 讀取器組 Parsed 的方式一樣：剩餘＝100−已用）
fn parsed(five: Option<(f64, i64)>, week: Option<(f64, i64)>) -> Parsed {
    let left = |u: f64| (100.0 - u).clamp(0.0, 100.0).round() as u8;
    let (f, w) = (five.map(|x| (left(x.0), Some(x.1))), week.map(|x| (left(x.0), Some(x.1))));
    Parsed {
        five_hour_pct: f.map(|x| x.0),
        weekly_pct: w.map(|x| x.0),
        reset_at: pick_reset(f, w).map(iso_secs),
        five_reset_ms: five.map(|x| x.1),
        week_reset_ms: week.map(|x| x.1),
    }
}

#[test]
fn 時間字串可以換回毫秒_格式不對就是沒有() {
    assert_eq!(parse_iso_secs("2026-10-24T12:00:00Z"), Some(NOW));
    assert_eq!(parse_iso_secs(&iso_secs(NOW + 12_345_000)), Some(NOW + 12_345_000));
    assert_eq!(parse_iso_secs("2000-02-29T00:00:00Z").map(iso_secs).as_deref(), Some("2000-02-29T00:00:00Z"));
    for bad in ["", "壞", "2026-13-01T00:00:00Z", "2026-10-24 12:00:00Z", "2026-10-24T12:00:00", "2026-10-24T25:00:00Z"] {
        assert_eq!(parse_iso_secs(bad), None, "{bad}");
    }
}

// ---------- 共用案例：跟後台 SQL 讀同一份，規則不會分成兩套 ----------
const SHARED_CASES: &str = include_str!("../../../../../../tests/fixtures/quota-merge-cases-local.json");

#[test]
fn 共用案例_每一個都跟預期一致() {
    let v: Value = serde_json::from_str(SHARED_CASES).expect("共用案例要是 JSON");
    let c = &v["constants"];
    assert_eq!((c["reset_past_ms"].as_i64(), c["reset_future_ms"].as_i64(), c["future_read_ms"].as_i64()), (Some(RESET_PAST_MS), Some(RESET_FUTURE_MS), Some(FUTURE_READ_MS)), "常數跟案例檔一致");
    let cases = v["cases"].as_array().expect("cases");
    assert!(cases.len() >= 20, "案例不該變少：{}", cases.len());
    let mut wrong = vec![];
    for t in cases {
        let id = t["id"].as_str().unwrap();
        let now = ms(t["now"].as_str().unwrap());
        let new_read = ms(t["new"]["read_at"].as_str().unwrap());
        let new_reset = t["new"]["resets_at"].as_str().map(ms);
        let old_read = t["old"]["read_at"].as_str().map(ms);
        let got = judge(old_read, new_read, new_reset, now);
        let want_accept = t["accept"].as_bool().unwrap();
        let want_reason = t["reason"].as_str();
        let got_reason = got.as_ref().err().map(|r| r.code);
        if got.is_ok() != want_accept || got_reason != want_reason {
            wrong.push(format!("{id}：預期 {want_accept}/{want_reason:?}，實際 {}/{got_reason:?}", got.is_ok()));
        }
        // 同樣的案例走 merge_one（含有沒有舊的窗）：收不收要一樣
        let kind = if t["window"].as_str() == Some("five_hour") { Kind::Five } else { Kind::Week };
        let old = t["old"]["left_pct"].as_u64().map(|p| (p as u8, t["old"]["resets_at"].as_str().map(ms)));
        let new = Some((t["new"]["left_pct"].as_u64().unwrap() as u8, new_reset));
        let (_, took, sk) = merge_one(kind, old, old_read, new, new_read, now);
        if took != want_accept || sk.map(|s| s.code) != want_reason {
            wrong.push(format!("{id}：merge_one 跟預期不一致"));
        }
    }
    assert!(wrong.is_empty(), "跟共用案例不一致：{wrong:#?}");
    // 代碼表裡的每個代碼，Rust 都可能回（反過來也守：Rust 回的代碼都在表裡）
    let codes: Vec<&str> = v["reasons"].as_object().unwrap().keys().map(String::as_str).collect();
    assert_eq!(codes.len(), 3);
    for c in ["older_read", "future_read", "reset_out_of_range"] {
        assert!(codes.contains(&c), "{c} 不在案例檔的代碼表");
    }
}

#[test]
fn 共用案例_兩條窗各自判斷_一條被擋另一條照收() {
    let v: Value = serde_json::from_str(SHARED_CASES).expect("共用案例要是 JSON");
    let cases = v["window_pair_cases"].as_array().expect("window_pair_cases");
    assert!(cases.len() >= 4, "案例不該變少");
    for t in cases {
        let id = t["id"].as_str().unwrap();
        let now = ms(t["now"].as_str().unwrap());
        let pct = |side: &str, w: &str| t[side][w]["left_pct"].as_u64().unwrap() as u8;
        let rst = |side: &str, w: &str| t[side][w]["resets_at"].as_str().unwrap().to_string();
        let read = |side: &str, w: &str| t[side][w]["read_at"].as_str().unwrap().to_string();
        assert_eq!(read("new", "five_hour"), read("new", "weekly"), "{id} 同一次讀取兩條窗共用一個資料時間");
        let new_read = ms(&read("new", "weekly"));
        let old = Quota {
            five_hour_pct: Some(pct("old", "five_hour")),
            weekly_pct: Some(pct("old", "weekly")),
            at: read("old", "five_hour"),
            five_reset_at: Some(rst("old", "five_hour")),
            week_reset_at: Some(rst("old", "weekly")),
            five_at: Some(read("old", "five_hour")),
            week_at: Some(read("old", "weekly")),
            ..Default::default()
        };
        let newp = Parsed {
            five_hour_pct: Some(pct("new", "five_hour")),
            weekly_pct: Some(pct("new", "weekly")),
            reset_at: None,
            five_reset_ms: Some(ms(&rst("new", "five_hour"))),
            week_reset_ms: Some(ms(&rst("new", "weekly"))),
        };
        let m = merge_full(Some(&old), &newp, new_read, now);
        let want = |w: &str| t["expect"][w]["accept"].as_bool().unwrap();
        assert_eq!((m.took_five, m.took_week), (want("five_hour"), want("weekly")), "{id} 各條收不收");
        for (w, took) in [("five_hour", m.took_five), ("weekly", m.took_week)] {
            let got = m.skipped.iter().find(|s| s.kind == if w == "weekly" { Kind::Week } else { Kind::Five }).map(|s| s.code);
            assert_eq!(got, t["expect"][w]["reason"].as_str(), "{id} {w} 原因（收了就沒有）");
            assert_eq!(took, got.is_none());
        }
        // 只要有一條收下，整筆就要寫（不會因為另一條被擋就整筆不存）
        let q = m.quota.unwrap_or_else(|| panic!("{id} 有一條收下，紀錄不該是 None"));
        let pick = |took: bool, new_v: u8, old_v: u8| if took { new_v } else { old_v };
        assert_eq!(q.five_hour_pct, Some(pick(m.took_five, pct("new", "five_hour"), pct("old", "five_hour"))), "{id} 5 小時：被擋的維持舊值、收下的用新值");
        assert_eq!(q.weekly_pct, Some(pick(m.took_week, pct("new", "weekly"), pct("old", "weekly"))), "{id} 每週");
        assert_eq!(q.five_at, Some(if m.took_five { iso_secs(new_read) } else { read("old", "five_hour") }), "{id} 5 小時的資料時間：收下才往前走");
        assert_eq!(q.week_at, Some(if m.took_week { iso_secs(new_read) } else { read("old", "weekly") }), "{id} 每週的資料時間");
        if !m.took_five {
            assert_eq!(q.five_reset_at, Some(rst("old", "five_hour")), "{id} 被擋的那條連重置時間也維持舊的");
        }
    }
}

#[test]
fn 兩條都被擋時整筆不動_有一條收下就整筆寫() {
    let r = NOW + 3 * DAY;
    let old = Quota { weekly_pct: Some(50), week_reset_at: Some(iso_secs(r)), week_at: Some(iso_secs(NOW)), at: iso_secs(NOW), ..Default::default() };
    let p = Parsed { five_hour_pct: None, weekly_pct: Some(10), reset_at: None, five_reset_ms: None, week_reset_ms: Some(r) };
    let m = merge_full(Some(&old), &p, NOW - MIN, NOW);
    assert!(m.quota.is_none() && !m.took_week && m.skipped.len() == 1 && m.skipped[0].code == "older_read");
    let m = merge_full(Some(&old), &p, NOW + MIN, NOW + MIN);
    assert!(m.took_week && m.quota.is_some_and(|q| q.weekly_pct == Some(10)));
}

#[test]
fn 簡化後的規則_同期回升_重置時間倒退_不是七天倍數都照收() {
    let r = NOW + 3 * DAY;
    let old = Some((10u8, Some(r)));
    // 同一期剩餘回升（滾動窗、四捨五入）
    assert!(judge(Some(NOW), NOW + MIN, Some(r), NOW + MIN).is_ok());
    let (m, took, sk) = merge_one(Kind::Five, old, Some(NOW), Some((99, Some(r))), NOW + MIN, NOW + MIN);
    assert!(took && sk.is_none() && m == Some((99, Some(r))));
    // 重置時間倒退、不是 7 天倍數
    assert!(judge(Some(NOW), NOW + MIN, Some(r - 2 * DAY - 5 * H), NOW + MIN).is_ok());
    assert!(judge(Some(NOW), NOW + MIN, Some(r + 3 * DAY + 5 * H), NOW + MIN).is_ok());
}

// ---------- 兩條各記自己的重置時間與資料時間（#374） ----------
#[test]
fn 新格式_兩條各存自己的重置時間與資料時間_舊欄位照寫() {
    let (r5, rw) = (NOW + 2 * H, NOW + 100 * H);
    let p = parsed(Some((96.0, r5)), Some((100.0, rw)));
    let m = merge_full(None, &p, NOW - 30 * MIN, NOW);
    let got = m.quota.unwrap();
    assert_eq!((got.five_reset_at.clone(), got.week_reset_at.clone()), (Some(iso_secs(r5)), Some(iso_secs(rw))));
    assert_eq!(got.reset_at, Some(iso_secs(rw)), "舊的 reset_at 照 pick_reset：每週用完給每週的");
    assert_eq!((got.five_at.clone(), got.week_at.clone(), got.at.clone()), (Some(iso_secs(NOW - 30 * MIN)), Some(iso_secs(NOW - 30 * MIN)), iso_secs(NOW)), "各條記資料時間，at 記錄當下");
    // 只有 5 小時那條收進新值：它的資料時間更新，每週那條留原本的
    let p2 = parsed(Some((97.0, r5)), None);
    let got2 = merge_full(Some(&got), &p2, NOW + MIN, NOW + MIN).quota.unwrap();
    assert_eq!((got2.five_at, got2.week_at, got2.at), (Some(iso_secs(NOW + MIN)), Some(iso_secs(NOW - 30 * MIN)), iso_secs(NOW + MIN)));
}

#[test]
fn 舊格式的檔照樣讀得到_沒有各條重置時間就照舊反推() {
    let r5 = NOW + 2 * H;
    let got = quota_from_value(&json!({ "five_hour_pct": 40, "weekly_pct": 70, "reset_at": iso_secs(r5), "at": iso_secs(NOW) })).unwrap();
    assert_eq!((got.five_hour_pct, got.weekly_pct, got.reset_at.clone(), got.five_reset_at.clone(), got.five_at.clone()), (Some(40), Some(70), Some(iso_secs(r5)), None, None));
    assert_eq!(stored_resets(&got), (Some(r5), None), "舊檔：沒用完時那一個屬於 5 小時那條");
    // 回報的額度窗：讀取時間退回整筆的 at；每週那條推不出重置時間就是 null
    let w = got.windows();
    assert_eq!(w[0], json!({ "name": "five_hour", "left_pct": 40, "resets_at": iso_secs(r5), "read_at": iso_secs(NOW) }));
    assert_eq!(w[1], json!({ "name": "weekly", "left_pct": 70, "resets_at": null, "read_at": iso_secs(NOW) }));
    // 舊檔沒有各條的資料時間，合併時退回整筆的 at 來比：比它早的資料時間不收
    let p = Parsed { five_hour_pct: Some(50), weekly_pct: None, reset_at: None, five_reset_ms: Some(r5), week_reset_ms: None };
    let m = merge_full(Some(&got), &p, NOW - MIN, NOW);
    assert!(m.quota.is_none() && m.skipped[0].code == "older_read");
    // 新格式的檔：沒有 5 小時百分比就不留它的重置時間；格式不對的丟掉
    let got = quota_from_value(&json!({ "weekly_pct": 70, "at": iso_secs(NOW), "five_reset_at": iso_secs(r5), "week_reset_at": "壞", "week_at": iso_secs(NOW) })).unwrap();
    assert_eq!((got.five_reset_at, got.week_reset_at, got.week_at), (None, None, Some(iso_secs(NOW))));
}

#[test]
fn 新格式那條明寫的重置時間優先_不拿舊的反推() {
    let r5 = NOW + 2 * H;
    let rw = NOW + 100 * H;
    let qq = Quota { five_hour_pct: Some(0), weekly_pct: Some(0), reset_at: Some(iso_secs(rw)), at: iso_secs(NOW), five_reset_at: Some(iso_secs(r5)), week_reset_at: Some(iso_secs(rw)), ..Default::default() };
    assert_eq!(stored_resets(&qq), (Some(r5), Some(rw)));
}

#[test]
fn _5_小時有百分比卻沒有重置時間時_不拿每週的重置時間來頂() {
    let p = Parsed { five_hour_pct: Some(60), weekly_pct: Some(30), reset_at: None, five_reset_ms: None, week_reset_ms: Some(NOW + 3 * DAY) };
    let got = merge_full(None, &p, NOW, NOW).quota.unwrap();
    assert_eq!(got.five_reset_at, None);
    assert_eq!(got.week_reset_at, Some(iso_secs(NOW + 3 * DAY)));
    assert!(got.windows()[0]["resets_at"].is_null(), "5 小時那條沒有重置時間就是 null，不編");
}

#[test]
fn log_超過上限只留後半_不會無限長() {
    let h = tempfile::tempdir().unwrap();
    let p = h.path().join("x.log");
    std::fs::write(&p, "舊的一行記錄\n".repeat(5000)).unwrap();
    append_log(&p, "最後一行\n");
    let l = std::fs::read_to_string(&p).unwrap();
    assert!((l.len() as u64) < LOG_MAX_BYTES, "{}", l.len());
    assert!(l.ends_with("最後一行\n"));
}

#[test]
fn 沒帶資料時間的_merge_資料時間用現在() {
    let r = NOW + 3 * DAY;
    let old = Quota { weekly_pct: Some(70), week_reset_at: Some(iso_secs(r)), week_at: Some(iso_secs(NOW - H)), at: iso_secs(NOW - H), ..Default::default() };
    let p = Parsed { five_hour_pct: None, weekly_pct: Some(60), reset_at: None, five_reset_ms: None, week_reset_ms: Some(r) };
    let m = merge_full(Some(&old), &p, NOW, NOW);
    let (q, s) = (m.quota, m.skipped);
    assert!(s.is_empty());
    let q = q.unwrap();
    assert_eq!((q.weekly_pct, q.week_at), (Some(60), Some(iso_secs(NOW))));
}

#[test]
fn without_missing_expired_邊界_剛好等於現在算已過_兩窗都缺都過期_讀數有的窗不動() {
    let r = NOW + H;
    let old = Quota { five_hour_pct: Some(50), weekly_pct: Some(10), five_reset_at: Some(iso_secs(r)), week_reset_at: Some(iso_secs(r)), five_at: Some(iso_secs(NOW)), week_at: Some(iso_secs(NOW)), at: iso_secs(NOW), ..Default::default() };
    let none = Parsed { five_hour_pct: None, weekly_pct: None, reset_at: None, five_reset_ms: None, week_reset_ms: None };
    assert_eq!(without_missing_expired(&old, &none, r - 1), None, "還沒到");
    let got = without_missing_expired(&old, &none, r).expect("剛好等於現在＝已過");
    assert_eq!((got.five_hour_pct, got.weekly_pct, got.reset_at), (None, None, None), "兩窗都缺都過期：都拿掉");
    // 讀數裡有每週：每週不動（交給合併判斷），只拿掉 5 小時
    let wk_only = Parsed { weekly_pct: Some(5), week_reset_ms: Some(r + DAY), ..none.clone() };
    let got = without_missing_expired(&old, &wk_only, r).unwrap();
    assert_eq!((got.five_hour_pct, got.weekly_pct), (None, Some(10)));
}

#[test]
fn 共用案例_缺一窗而存著的那窗已過重置時間才拿掉() {
    let v: Value = serde_json::from_str(SHARED_CASES).expect("共用案例要是 JSON");
    let cases = v["missing_window_cases"].as_array().expect("missing_window_cases");
    assert!(cases.len() >= 5, "案例不該變少");
    for t in cases {
        let id = t["id"].as_str().unwrap();
        let now = ms(t["now"].as_str().unwrap());
        let side = |w: &str| (t["old"][w]["left_pct"].as_u64().map(|p| p as u8), t["old"][w]["resets_at"].as_str().map(String::from), t["old"][w]["read_at"].as_str().map(String::from));
        let (f, w) = (side("five_hour"), side("weekly"));
        let old = Quota { five_hour_pct: f.0, weekly_pct: w.0, five_reset_at: f.1, week_reset_at: w.1, five_at: f.2.clone(), week_at: w.2, at: f.2.unwrap(), ..Default::default() };
        let has = |n: &str| t["new_has"].as_array().unwrap().iter().any(|x| x.as_str() == Some(n));
        let p = Parsed { five_hour_pct: has("five_hour").then_some(40), weekly_pct: has("weekly").then_some(40), reset_at: None, five_reset_ms: has("five_hour").then_some(now + 2 * H), week_reset_ms: has("weekly").then_some(now + 4 * DAY) };
        let after = without_missing_expired(&old, &p, now).unwrap_or(old);
        let mut present: Vec<String> = after.windows().iter().map(|x| x["name"].as_str().unwrap().to_string()).collect();
        present.sort();
        let mut want: Vec<String> = t["expect_present"].as_array().unwrap().iter().map(|x| x.as_str().unwrap().to_string()).collect();
        want.sort();
        assert_eq!(present, want, "{id} {}", t["note"].as_str().unwrap());
    }
}


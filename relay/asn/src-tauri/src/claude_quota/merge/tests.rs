use super::super::{hook_in, load_all, parse_iso_secs, parse_statusline, quota_from_value};
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
fn log(h: &tempfile::TempDir) -> String {
    std::fs::read_to_string(log_path(h.path())).unwrap_or_default()
}

#[test]
fn 時間字串可以換回毫秒_格式不對就是沒有() {
    assert_eq!(parse_iso_secs("2026-10-24T12:00:00Z"), Some(NOW));
    assert_eq!(parse_iso_secs(&iso_secs(NOW + 12_345_000)), Some(NOW + 12_345_000));
    assert_eq!(parse_iso_secs("2000-02-29T00:00:00Z").map(iso_secs).as_deref(), Some("2000-02-29T00:00:00Z"));
    for bad in ["", "壞", "2026-13-01T00:00:00Z", "2026-10-24 12:00:00Z", "2026-10-24T12:00:00", "2026-10-24T25:00:00Z"] {
        assert_eq!(parse_iso_secs(bad), None, "{bad}");
    }
    // 帶毫秒也認（Claude 對話紀錄的時間戳）
    assert_eq!(super::super::parse_iso_ms("2026-10-24T12:00:00.250Z"), Some(NOW + 250));
    assert_eq!(super::super::parse_iso_ms("2026-10-24T12:00:00.5Z"), Some(NOW + 500));
    assert_eq!(super::super::parse_iso_ms("2026-10-24T12:00:00.123456Z"), Some(NOW + 123));
    assert_eq!(super::super::parse_iso_ms("2026-10-24T12:00:00+08:00"), None);
}

// ---------- 共用案例：跟後台 SQL 讀同一份，規則不會分成兩套 ----------
const SHARED_CASES: &str = include_str!("../../../../../../tests/fixtures/quota-merge-cases.json");

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
    let p = parse_statusline(&status(Some((96.0, r5)), Some((100.0, rw))), NOW).unwrap();
    let m = merge_full(None, &p, NOW - 30 * MIN, NOW);
    let got = m.quota.unwrap();
    assert_eq!((got.five_reset_at.clone(), got.week_reset_at.clone()), (Some(iso_secs(r5)), Some(iso_secs(rw))));
    assert_eq!(got.reset_at, Some(iso_secs(rw)), "舊的 reset_at 照 pick_reset：每週用完給每週的");
    assert_eq!((got.five_at.clone(), got.week_at.clone(), got.at.clone()), (Some(iso_secs(NOW - 30 * MIN)), Some(iso_secs(NOW - 30 * MIN)), iso_secs(NOW)), "各條記資料時間，at 記錄當下");
    // 只有 5 小時那條收進新值：它的資料時間更新，每週那條留原本的
    let p2 = parse_statusline(&status(Some((97.0, r5)), None), NOW).unwrap();
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
    std::fs::create_dir_all(h.path().join(".asn")).unwrap();
    std::fs::write(log_path(h.path()), "舊的一行記錄\n".repeat(5000)).unwrap();
    log_skipped(h.path(), &[Skipped { kind: Kind::Five, code: "older_read", reason: "測試".into() }], NOW);
    let l = log(&h);
    assert!((l.len() as u64) < LOG_MAX_BYTES, "{}", l.len());
    assert!(l.ends_with("5 小時額度沒收：測試\n"));
}

// ---------- 視窗帶帳號身分與資料時間（#1185、#1266） ----------
const UA: &str = "aaaaaaaa-1111-2222-3333-444444444444";
const UB: &str = "bbbbbbbb-1111-2222-3333-444444444444";

fn home_as(email: &str) -> tempfile::TempDir {
    let h = tempfile::tempdir().unwrap();
    std::fs::write(h.path().join(".claude.json"), json!({ "oauthAccount": { "emailAddress": email, "accountUuid": "11111111-2222-3333-4444-555555555555" } }).to_string()).unwrap();
    h
}
fn add_account(h: &std::path::Path, email: &str, uuid: &str) {
    let d = h.join(".asn").join("claude-accounts").join(crate::claude_accounts::email_dir_name(email));
    std::fs::create_dir_all(&d).unwrap();
    std::fs::write(d.join("account.json"), json!({ "accountUuid": uuid, "emailAddress": email }).to_string()).unwrap();
}
/// 對話紀錄的時間戳（帶毫秒）
fn stamp(t: i64) -> String {
    iso_secs(t).replace('Z', ".250Z")
}
/// 這個視窗的對話紀錄：`<home>/.claude/projects/p/<name>.jsonl`。最後一筆 assistant 回應的時間是 `assistant_ms`（None＝沒有 assistant 行）。
/// `pad` 讓每次寫出來的長度不一樣（身分快取以檔案大小與修改時間判斷有沒有變）
fn transcript(h: &std::path::Path, name: &str, uuid: &str, assistant_ms: Option<i64>, pad: usize) -> std::path::PathBuf {
    let d = h.join(".claude").join("projects").join("p");
    std::fs::create_dir_all(&d).unwrap();
    let f = d.join(format!("{name}.jsonl"));
    let owner = json!({ "type": "session-owner", "accountUuid": uuid, "organizationUuid": "cccccccc-1111-2222-3333-444444444444" }).to_string();
    let mut text = format!("{}\n{owner}\n", json!({ "type": "user", "pad": "x".repeat(pad) }));
    if let Some(t) = assistant_ms {
        text.push_str(&format!("{}\n", json!({ "type": "assistant", "timestamp": stamp(t) })));
    }
    std::fs::write(&f, text).unwrap();
    f
}
/// 狀態列輸入加上 transcript_path
fn with_tp(status_json: String, tp: &std::path::Path) -> String {
    let mut v: Value = serde_json::from_str(&status_json).unwrap();
    v["transcript_path"] = json!(tp.to_string_lossy());
    v.to_string()
}
fn hook_at(h: &tempfile::TempDir, input: &str, now: i64) -> bool {
    hook_in(h.path(), &h.path().join(".claude"), input, now)
}
/// 一個視窗回報一次：寫對話紀錄（最後一筆 assistant 的時間 ts）、送狀態列
fn feed(h: &tempfile::TempDir, name: &str, uuid: &str, ts: i64, pad: usize, st: String, now: i64) -> bool {
    let t = transcript(h.path(), name, uuid, Some(ts), pad);
    hook_at(h, &with_tp(st, &t), now)
}
fn quota_of(h: &tempfile::TempDir, email: &str) -> Quota {
    load_all(h.path()).remove(email).unwrap_or_else(|| panic!("{email} 要有紀錄"))
}
fn state_file(h: &tempfile::TempDir) -> String {
    std::fs::read_to_string(super::super::state::state_path(h.path())).unwrap_or_default()
}
/// 兩個視窗各自的狀態列：每週剩餘 = 100 − used，重置時間固定
fn wk(used: f64) -> String {
    status(None, Some((used, NOW + 3 * DAY)))
}

#[test]
fn 身分_兩個帳號的視窗交錯回報_各記各的_不互相污染() {
    // 目前 .claude.json 登入 a；b 的視窗還開著，兩邊交錯送數字，重置時間也不同
    let h = home_as("a@x.test");
    add_account(h.path(), "a@x.test", UA);
    add_account(h.path(), "b@x.test", UB);
    let (ra, rb) = (NOW + 3 * DAY, NOW + 5 * DAY + 5 * H);
    for i in 0..12i64 {
        let t = NOW + i * 5 * MIN;
        assert!(feed(&h, "wa", UA, t, i as usize, status(None, Some((10.0 + i as f64, ra))), t), "a 第 {i} 次");
        assert!(feed(&h, "wb", UB, t, i as usize, status(None, Some((50.0 + i as f64, rb))), t + 1000), "b 第 {i} 次");
    }
    let (qa, qb) = (quota_of(&h, "a@x.test"), quota_of(&h, "b@x.test"));
    assert_eq!((qa.weekly_pct, qa.week_reset_at), (Some(100 - 21), Some(iso_secs(ra))));
    assert_eq!((qb.weekly_pct, qb.week_reset_at), (Some(100 - 61), Some(iso_secs(rb))));
    assert!(qa.owner && qb.owner, "有身分的紀錄有標記");
    assert!(!log(&h).contains("沒收"), "沒有任何一筆被當成別的帳號：{}", log(&h));
}

#[test]
fn 身分_同一個帳號的舊視窗重送舊數字_不蓋過新的_同期回升照收() {
    let h = home_as("a@x.test");
    add_account(h.path(), "a@x.test", UA);
    // 視窗 X 最近有回應（12:00，剩 30%）
    assert!(feed(&h, "wx", UA, NOW, 1, wk(70.0), NOW + MIN));
    // 視窗 Y 閒置很久，最後一次回應是 11:30（剩 90%）：它每次重繪都用現在的時間重送這個舊數字，資料時間是 11:30，不收
    assert!(!feed(&h, "wy", UA, NOW - 30 * MIN, 2, wk(10.0), NOW + 2 * MIN));
    assert!(!feed(&h, "wy", UA, NOW - 30 * MIN, 3, wk(10.0), NOW + 20 * MIN));
    assert_eq!(quota_of(&h, "a@x.test").weekly_pct, Some(30));
    assert!(log(&h).contains("資料時間") && !log(&h).contains("a@x.test"));
    // 視窗 X 之後回應了，資料時間 12:30，剩餘回升到 95%（滾動窗／四捨五入）：照收
    assert!(feed(&h, "wx", UA, NOW + 30 * MIN, 4, wk(5.0), NOW + 31 * MIN));
    assert_eq!(quota_of(&h, "a@x.test").weekly_pct, Some(95));
}

#[test]
fn 身分_對不到已知帳號_只留本機未知區_不進額度檔() {
    let h = home_as("a@x.test");
    add_account(h.path(), "a@x.test", UA);
    assert!(!feed(&h, "wx", "dddddddd-1111-2222-3333-444444444444", NOW, 1, wk(70.0), NOW));
    assert!(!super::super::quota_path(h.path()).exists(), "不進額度檔");
    let unk = super::super::owner_store::unknown_load(h.path());
    assert_eq!(unk.keys().collect::<Vec<_>>(), ["dddddddd-1111-2222-3333-444444444444"]);
}

#[test]
fn 舊版_沒帶_transcript_path_不收_只記下看過舊版視窗_畫面寫固定一句() {
    let h = home_as("a@x.test");
    assert!(!hook_at(&h, &wk(70.0), NOW));
    assert!(!super::super::quota_path(h.path()).exists(), "不收");
    assert!(state_file(&h).contains("legacy_at"), "{}", state_file(&h));
    // 畫面資料：目前登入的帳號沒有紀錄、最近有舊版視窗 → 標 legacy
    let v = super::super::quota_all_view(h.path(), NOW + MIN);
    assert_eq!(v.get("a@x.test"), Some(&json!({ "legacy": true })));
    // 太久以前看到的舊版視窗不再提示
    assert!(super::super::quota_all_view(h.path(), NOW + 2 * H).is_empty());
    // 狀態列叫得很勤：10 分鐘內不重寫狀態檔
    let before = state_file(&h);
    assert!(!hook_at(&h, &wk(70.0), NOW + 5 * MIN));
    assert_eq!(state_file(&h), before);
    // 有紀錄了（別的視窗帶了身分）：照紀錄顯示，不再寫 legacy
    add_account(h.path(), "a@x.test", UA);
    assert!(feed(&h, "wa", UA, NOW + 6 * MIN, 1, wk(70.0), NOW + 7 * MIN));
    let v = super::super::quota_all_view(h.path(), NOW + 8 * MIN);
    assert!(v["a@x.test"].get("legacy").is_none() && v["a@x.test"].get("weekly_pct").is_some());
}

#[test]
fn 身分_有帶_transcript_path_卻解不出身分或取不到時間戳_這次不記() {
    let h = home_as("a@x.test");
    add_account(h.path(), "a@x.test", UA);
    assert!(feed(&h, "wa", UA, NOW, 1, wk(70.0), NOW));
    let before = quota_of(&h, "a@x.test");
    let state_before = state_file(&h);
    let dir = h.path().join(".claude").join("projects").join("p");
    // 1. 沒有 assistant 回應（取不到時間戳）
    let no_ts = transcript(h.path(), "nots", UA, None, 1);
    // 2. 檔裡沒有 session-owner
    let none = dir.join("nb.jsonl");
    std::fs::write(&none, "{\"type\":\"user\"}\n").unwrap();
    // 3. 最後一筆 session-owner 格式壞掉
    let bad = dir.join("bad.jsonl");
    std::fs::write(&bad, format!("{{\"type\":\"session-owner\",\"accountUuid\":\"../x\"}}\n{}\n", json!({ "type": "assistant", "timestamp": stamp(NOW) }))).unwrap();
    // 4. 路徑不在 projects 底下（不安全）
    let outside = h.path().join("evil.jsonl");
    std::fs::write(&outside, format!("{}\n{}\n", json!({ "type": "session-owner", "accountUuid": UB }), json!({ "type": "assistant", "timestamp": stamp(NOW) }))).unwrap();
    // 5. 檔案不存在
    let missing = dir.join("missing.jsonl");
    // 6. assistant 時間戳格式不對
    let badts = dir.join("badts.jsonl");
    std::fs::write(&badts, format!("{}\n{}\n", json!({ "type": "session-owner", "accountUuid": UA, "organizationUuid": "cccccccc-1111-2222-3333-444444444444" }), json!({ "type": "assistant", "timestamp": "昨天" }))).unwrap();
    for (i, tp) in [&no_ts, &none, &bad, &outside, &missing, &badts].into_iter().enumerate() {
        assert!(!hook_at(&h, &with_tp(wk(5.0), tp), NOW + (i as i64 + 1) * MIN), "第 {i} 種：這次不記");
    }
    assert_eq!(quota_of(&h, "a@x.test"), before, "A 的紀錄完全不變");
    assert_eq!(load_all(h.path()).len(), 1, "沒有多出別的帳號");
    assert_eq!(state_file(&h), state_before, "狀態檔也沒動");
    assert!(!super::super::owner_store::unknown_path(h.path()).exists(), "也不進未知區");
}

#[test]
fn log_同一個原因只記一次_收進新值後再發生才再記() {
    let h = home_as("a@x.test");
    add_account(h.path(), "a@x.test", UA);
    assert!(feed(&h, "wa", UA, NOW, 1, wk(70.0), NOW));
    let lines = |h: &tempfile::TempDir| log(h).lines().filter(|l| l.contains("每週額度沒收")).count();
    for i in 0..5 {
        assert!(!feed(&h, "wold", UA, NOW - 10 * MIN, 10 + i, wk(60.0), NOW + MIN + i as i64));
    }
    assert_eq!(lines(&h), 1, "連續 5 次同一原因只記一行：{}", log(&h));
    // 收進新值（資料較新）後原因清掉；再發生同一原因要再記
    assert!(feed(&h, "wa", UA, NOW + 10 * MIN, 20, wk(50.0), NOW + 11 * MIN));
    assert!(!feed(&h, "wold", UA, NOW - 10 * MIN, 30, wk(60.0), NOW + 12 * MIN));
    assert_eq!(lines(&h), 2, "收下之後再發生要再記：{}", log(&h));
}

#[test]
fn 身分_第一次有身分的回報清掉沒有標記的舊基準_備份一份_log_只記筆數() {
    let h = home_as("a@x.test");
    add_account(h.path(), "a@x.test", UA);
    // 沒有身分標記的舊紀錄（舊辦法記的，資料時間是記錄當下 12:00，可能混進別的帳號的數字）
    std::fs::create_dir_all(h.path().join(".asn")).unwrap();
    let rec = json!({ "weekly_pct": 95, "at": iso_secs(NOW), "week_reset_at": iso_secs(NOW + 3 * DAY), "week_at": iso_secs(NOW) });
    std::fs::write(super::super::quota_path(h.path()), json!({ "a@x.test": rec }).to_string()).unwrap();
    // 有身分的回報，資料時間 11:00（比舊紀錄的「記錄當下」早）：舊基準被清掉，所以照收
    assert!(feed(&h, "wa", UA, NOW - H, 1, wk(40.0), NOW + MIN));
    let got = quota_of(&h, "a@x.test");
    assert_eq!(got.weekly_pct, Some(60));
    assert!(got.owner);
    let bak = super::super::owner_store::backup_path(h.path());
    assert!(std::fs::read_to_string(&bak).unwrap().contains("\"weekly_pct\":95"), "備份是清掉之前的內容");
    let l = log(&h);
    assert!(l.contains("清掉 1 筆沒有身分的舊基準") && !l.contains("a@x.test") && !l.contains(UA), "log 只記筆數：{l}");
    // 之後同一個帳號的回報不再清、不再備份
    std::fs::remove_file(&bak).unwrap();
    assert!(feed(&h, "wa", UA, NOW + 10 * MIN, 2, wk(30.0), NOW + 11 * MIN));
    assert!(!bak.exists());
    assert_eq!(log(&h).matches("清掉").count(), 1);
}

#[test]
fn 身分_備份失敗就不清舊基準_log_記一句() {
    let h = home_as("a@x.test");
    add_account(h.path(), "a@x.test", UA);
    std::fs::create_dir_all(h.path().join(".asn")).unwrap();
    let rec = json!({ "weekly_pct": 95, "at": iso_secs(NOW), "week_reset_at": iso_secs(NOW + 3 * DAY), "week_at": iso_secs(NOW) });
    std::fs::write(super::super::quota_path(h.path()), json!({ "a@x.test": rec }).to_string()).unwrap();
    let tmp = super::super::owner_store::backup_tmp_path(h.path());
    std::fs::create_dir_all(&tmp).unwrap(); // 備份必失敗
    // 資料時間 11:00 比舊紀錄的 12:00 早：沒清舊基準就被擋
    assert!(!feed(&h, "wa", UA, NOW - H, 1, wk(40.0), NOW + MIN));
    let got = quota_of(&h, "a@x.test");
    assert_eq!((got.weekly_pct, got.owner), (Some(95), false), "舊基準還在、沒有標記");
    assert!(log(&h).contains("備份失敗，沒有清舊基準"));
    assert!(!super::super::owner_store::backup_path(h.path()).exists());
    // 備份恢復：下一次清掉舊基準、照新數字收、蓋上標記
    std::fs::remove_dir_all(&tmp).unwrap();
    assert!(feed(&h, "wa", UA, NOW - H, 2, wk(40.0), NOW + 2 * MIN));
    let got = quota_of(&h, "a@x.test");
    assert_eq!((got.weekly_pct, got.owner), (Some(60), true));
    assert!(super::super::owner_store::backup_path(h.path()).exists());
    assert!(!tmp.exists(), "沒有留下暫存檔");
}

#[test]
fn 身分_備份只留一份_兩個帳號各自第一次清舊基準時都覆寫同一個備份檔() {
    let h = home_as("a@x.test");
    add_account(h.path(), "a@x.test", UA);
    add_account(h.path(), "b@x.test", UB);
    let rec = |pct: u8| json!({ "weekly_pct": pct, "at": iso_secs(NOW - DAY), "week_reset_at": iso_secs(NOW + 3 * DAY), "week_at": iso_secs(NOW - DAY) });
    std::fs::create_dir_all(h.path().join(".asn")).unwrap();
    std::fs::write(super::super::quota_path(h.path()), json!({ "a@x.test": rec(90), "b@x.test": rec(80) }).to_string()).unwrap();
    let baks = |h: &tempfile::TempDir| std::fs::read_dir(h.path().join(".asn")).unwrap().flatten().filter(|e| e.file_name().to_string_lossy().contains(".bak")).count();
    assert!(feed(&h, "wa", UA, NOW, 1, wk(60.0), NOW));
    assert_eq!(baks(&h), 1);
    let first = std::fs::read_to_string(super::super::owner_store::backup_path(h.path())).unwrap();
    assert!(first.contains("\"weekly_pct\":90") && first.contains("\"weekly_pct\":80"), "第一份備份含兩個舊紀錄");
    assert!(feed(&h, "wb", UB, NOW, 2, wk(50.0), NOW + MIN));
    assert_eq!(baks(&h), 1, "還是只有一份備份檔");
    let second = std::fs::read_to_string(super::super::owner_store::backup_path(h.path())).unwrap();
    assert!(second.contains("\"owner\":true") && second.contains("\"weekly_pct\":80"), "第二次覆寫成清 b 之前的內容（a 已有標記）");
    assert!(feed(&h, "wa", UA, NOW + MIN, 3, wk(40.0), NOW + 2 * MIN));
    assert_eq!(std::fs::read_to_string(super::super::owner_store::backup_path(h.path())).unwrap(), second, "a 已有標記，不再備份");
}

#[test]
fn 身分_uuid_對應_email_先看帳號庫_資料夾名對不上不用_再看登入檔_都沒有就是未知() {
    let h = home_as("cur@x.test"); // .claude.json 的 accountUuid 是 11111111-2222-3333-4444-555555555555
    add_account(h.path(), "a@x.test", UA);
    let cfg = h.path().join(".claude");
    assert_eq!(crate::claude_accounts::email_of_account_uuid(h.path(), &cfg, UA).as_deref(), Some("a@x.test"));
    // 資料夾名跟 email 對不上（被改名／被塞假檔）：不用
    let root = h.path().join(".asn").join("claude-accounts");
    std::fs::create_dir_all(root.join("wrong-name")).unwrap();
    std::fs::write(root.join("wrong-name").join("account.json"), json!({ "accountUuid": UB, "emailAddress": "b@x.test" }).to_string()).unwrap();
    assert_eq!(crate::claude_accounts::email_of_account_uuid(h.path(), &cfg, UB), None);
    // 帳號庫沒有、但正是目前登入的帳號：看 .claude.json
    assert_eq!(crate::claude_accounts::email_of_account_uuid(h.path(), &cfg, "11111111-2222-3333-4444-555555555555").as_deref(), Some("cur@x.test"));
    assert_eq!(crate::claude_accounts::email_of_account_uuid(h.path(), &cfg, ""), None);
    assert_eq!(crate::claude_accounts::email_of_account_uuid(h.path(), &cfg, "eeeeeeee-0000-0000-0000-000000000000"), None);
}

#[test]
fn 身分_備援先看視窗自己的設定資料夾裡的_claude_json_再看家目錄_uuid_要對得上() {
    let h = tempfile::tempdir().unwrap();
    let cfg = h.path().join("cfg-b");
    std::fs::create_dir_all(&cfg).unwrap();
    let cj = |dir: &std::path::Path, email: &str, uuid: &str| std::fs::write(dir.join(".claude.json"), json!({ "oauthAccount": { "emailAddress": email, "accountUuid": uuid } }).to_string()).unwrap();
    cj(h.path(), "home@x.test", "11111111-0000-0000-0000-00000000000a");
    cj(&cfg, "cfgb@x.test", "22222222-0000-0000-0000-00000000000b");
    let f = |uuid: &str| crate::claude_accounts::email_of_account_uuid(h.path(), &cfg, uuid);
    assert_eq!(f("22222222-0000-0000-0000-00000000000b").as_deref(), Some("cfgb@x.test"), "先看這個視窗自己的設定資料夾");
    assert_eq!(f("11111111-0000-0000-0000-00000000000a").as_deref(), Some("home@x.test"), "設定資料夾沒有才看家目錄");
    assert_eq!(f("33333333-0000-0000-0000-000000000000"), None, "uuid 對不上就不用");
}

#[test]
fn 狀態檔壞掉或太大_當成空的_不當機() {
    let h = home_as("a@x.test");
    add_account(h.path(), "a@x.test", UA);
    std::fs::create_dir_all(h.path().join(".asn")).unwrap();
    std::fs::write(super::super::state::state_path(h.path()), "{壞掉").unwrap();
    assert!(feed(&h, "wa", UA, NOW, 1, wk(70.0), NOW));
    std::fs::write(super::super::state::state_path(h.path()), "x".repeat(40_000)).unwrap();
    assert!(feed(&h, "wa", UA, NOW + MIN, 2, wk(60.0), NOW + MIN));
    assert_eq!(quota_of(&h, "a@x.test").weekly_pct, Some(40));
}

#[test]
fn 沒帶資料時間的_merge_資料時間用現在() {
    let r = NOW + 3 * DAY;
    let old = Quota { weekly_pct: Some(70), week_reset_at: Some(iso_secs(r)), week_at: Some(iso_secs(NOW - H)), at: iso_secs(NOW - H), ..Default::default() };
    let p = Parsed { five_hour_pct: None, weekly_pct: Some(60), reset_at: None, five_reset_ms: None, week_reset_ms: Some(r) };
    let (q, s) = merge(Some(&old), &p, NOW);
    assert!(s.is_empty());
    let q = q.unwrap();
    assert_eq!((q.weekly_pct, q.week_at), (Some(60), Some(iso_secs(NOW))));
}

#[test]
fn 身分_備份失敗那次的紀錄不蓋有身分標記_下一次備份成功才清舊基準並蓋標記() {
    // 西川在 #1213 指出：備份失敗那次沒清舊基準，這筆還混著舊基準，不能蓋「有身分」標記，否則之後永遠不會再清
    let h = home_as("a@x.test");
    add_account(h.path(), "a@x.test", UA);
    std::fs::create_dir_all(h.path().join(".asn")).unwrap();
    // 沒有標記的舊紀錄（舊辦法記的）：剩 95%、資料時間 11:00
    let rec = json!({ "weekly_pct": 95, "at": iso_secs(NOW - H), "week_reset_at": iso_secs(NOW + 3 * DAY), "week_at": iso_secs(NOW - H) });
    std::fs::write(super::super::quota_path(h.path()), json!({ "a@x.test": rec }).to_string()).unwrap();
    let tmp = super::super::owner_store::backup_tmp_path(h.path());
    std::fs::create_dir_all(&tmp).unwrap(); // 備份必失敗
    // 資料較新（12:00）、剩 90%：沒清舊基準也會被收下，但這筆不能蓋有身分的標記
    assert!(feed(&h, "wa", UA, NOW, 1, wk(10.0), NOW + MIN));
    let got = quota_of(&h, "a@x.test");
    assert_eq!((got.weekly_pct, got.owner), (Some(90), false), "收下了，但沒有蓋標記");
    assert!(log(&h).contains("備份失敗，沒有清舊基準"));
    assert!(!super::super::owner_store::backup_path(h.path()).exists());
    // 備份恢復：下一次因為還沒有標記，清掉舊基準（備份一份）、照有身分的數字收、蓋上標記
    std::fs::remove_dir_all(&tmp).unwrap();
    assert!(feed(&h, "wa", UA, NOW + 30 * MIN, 2, wk(20.0), NOW + 31 * MIN));
    let got = quota_of(&h, "a@x.test");
    assert_eq!((got.weekly_pct, got.owner), (Some(80), true));
    assert!(super::super::owner_store::backup_path(h.path()).exists());
    assert_eq!(log(&h).matches("清掉 1 筆沒有身分的舊基準").count(), 1);
    assert!(!tmp.exists(), "沒有留下暫存檔");
}

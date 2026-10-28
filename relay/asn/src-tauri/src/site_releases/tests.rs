use super::*;

#[test]
fn 整理後只留版本_日期_條列() {
    let body = json!([
        { "version": "0.1.100", "released_on": "2026-10-28", "items": ["新增：甲", " 修正：乙 ", ""], "commit_sha": "abc1234", "notes": "不該帶出去" },
        { "version": "0.1.99", "released_on": null, "items": [] },
    ]);
    let r = parse_releases(&body).unwrap();
    assert_eq!(r.len(), 2);
    assert_eq!(r[0], json!({ "version": "0.1.100", "date": "2026-10-28", "lines": ["新增：甲", "修正：乙"] }));
    assert_eq!(r[1], json!({ "version": "0.1.99", "date": "", "lines": [] }));
}

#[test]
fn 壞的列略過_不信任資料庫給的形狀() {
    let body = json!([
        { "version": "x.y.z", "released_on": "2026-10-28", "items": ["a"] },
        { "version": "1.2", "items": ["a"] },
        { "version": "0.1.5; drop", "items": ["a"] },
        { "released_on": "2026-10-28", "items": ["a"] },
        { "version": "0.1.7", "released_on": "<b>2026</b>", "items": [1, null, {"a": 1}, "ok"] },
        "不是物件",
    ]);
    let r = parse_releases(&body).unwrap();
    assert_eq!(r, vec![json!({ "version": "0.1.7", "date": "", "lines": ["ok"] })]);
}

#[test]
fn 限長_限筆數() {
    let long = "字".repeat(MAX_ITEM_CHARS + 50);
    let many: Vec<String> = (0..MAX_ITEMS + 5).map(|i| format!("條{i}")).collect();
    let rows: Vec<Value> = (0..MAX_ROWS + 10).map(|i| json!({ "version": format!("0.1.{i}"), "released_on": "2026-10-28", "items": [long.clone()] })).collect();
    let r = parse_releases(&json!(rows)).unwrap();
    assert_eq!(r.len(), MAX_ROWS);
    assert_eq!(r[0]["lines"][0].as_str().unwrap().chars().count(), MAX_ITEM_CHARS);
    let r = parse_releases(&json!([{ "version": "0.1.1", "items": many }])).unwrap();
    assert_eq!(r[0]["lines"].as_array().unwrap().len(), MAX_ITEMS);
}

#[test]
fn 不是陣列就是錯() {
    assert!(parse_releases(&json!({ "message": "JWT expired" })).is_err());
    assert!(parse_releases(&json!(null)).is_err());
    assert_eq!(parse_releases(&json!([])).unwrap().len(), 0);
}

#[test]
fn 網址只查公開表的三個欄位() {
    let u = request_url();
    assert_eq!(u, format!("https://etccgmkrosbzpltudlgt.supabase.co/rest/v1/asn_site_releases?select=version,released_on,items&order=released_on.desc,version.desc&limit={MAX_ROWS}"));
    assert!(!u.contains("commit_sha") && !u.contains("notes"));
}

#[test]
fn 介面看到的錯誤是固定一句() {
    assert_eq!(UNREADABLE, "暫時讀不到版本紀錄");
}

#[test]
fn 快取十分鐘內直接用_過期就重抓() {
    let now = Instant::now();
    *CACHE.lock().unwrap() = Some((now, vec![json!({ "version": "0.1.1", "date": "", "lines": [] })]));
    assert_eq!(cached(now + Duration::from_secs(599)).unwrap().len(), 1);
    assert!(cached(now + CACHE_TTL).is_none());
    *CACHE.lock().unwrap() = None;
    assert!(cached(now).is_none());
}

#[test]
fn 內建公開金鑰對得上固定專案() {
    assert!(identity::BUILTIN_ANON.iter().any(|(r, _)| *r == PROJECT_REF));
}

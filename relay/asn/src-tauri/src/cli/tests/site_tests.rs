//! `asn-cli site release／meeting／item`：本機假後端（127.0.0.1）；確認參數解析、送出的內容、輸出與結束碼，金鑰不得出現在輸出。
use super::*;
use crate::cli::site_cmd::{held_at_of, meetings_from_json, parse_item, parse_release};
use std::sync::Mutex;

fn v(a: &[&str]) -> Vec<String> {
    a.iter().map(|s| s.to_string()).collect()
}

/// 假後台：記下送來的 body；`reply` 決定回什麼
fn server(reply: impl Fn(&str, &Value) -> (u16, Value) + Send + Sync + 'static) -> (Fake, Arc<Mutex<Vec<(String, Value)>>>) {
    let got: Arc<Mutex<Vec<(String, Value)>>> = Arc::new(Mutex::new(vec![]));
    let g2 = got.clone();
    let fake = Fake::start(move |req: &Req, _| {
        let (a, b) = (req.action(), req.json());
        g2.lock().unwrap().push((a.clone(), b.clone()));
        let (s, body) = reply(a.as_str(), &b);
        Resp::json(s, body)
    });
    (fake, got)
}

fn ok_server() -> (Fake, Arc<Mutex<Vec<(String, Value)>>>) {
    server(|a, b| match a {
        "site_release_upsert" => (200, json!({"ok": true, "version": b["version"], "created": true})),
        "site_item_upsert" => (200, json!({"ok": true, "item_key": b["item_key"], "created": false})),
        "site_meeting_add" => (200, json!({"ok": true, "id": 12, "created": true})),
        _ => (404, json!({"error": "not_found"})),
    })
}

#[test]
fn release_參數_只放有給的欄位_可重複_item_與_platform() {
    let b = parse_release(&v(&["--version", "0.1.96", "--date", "2026-10-28", "--commit", "ABC1234", "--item", "新增：`asn site`（#400）", "--item", "修正：x", "--platform", "官網、家用機", "--platform", "Play"]))
        .unwrap()
        .unwrap();
    assert_eq!(
        b,
        json!({"version": "0.1.96", "released_on": "2026-10-28", "commit_sha": "abc1234", "items": ["新增：`asn site`（#400）", "修正：x"], "platforms": ["官網", "家用機", "Play"]})
    );
    let upd = parse_release(&v(&["--version", "0.1.96", "--notes", "", "--commit", ""])).unwrap().unwrap();
    assert_eq!(upd, json!({"version": "0.1.96", "notes": "", "commit_sha": ""}), "空字串＝清掉");
    assert_eq!(parse_release(&v(&["--help"])).unwrap(), None);
}

#[test]
fn release_參數不對_結束碼_1() {
    for args in [vec![], vec!["--date", "2026-10-28"], vec!["--version", "0.1.96"], vec!["--version"], vec!["--version", "0.1.96", "--bogus", "x"]] {
        assert_eq!(parse_release(&v(&args)).unwrap_err().code, 1, "{args:?}");
    }
}

#[test]
fn item_參數_ref_可重複_逗號_井號_去重_body_file() {
    let b = parse_item(&v(&["--key", "todo-next-15b", "--section", "todo", "--lane", "next", "--title", " 標題 ", "--body", "內文", "--ref", "#400,402", "--ref", "400", "--status", "doing", "--sort", "35"]))
        .unwrap()
        .unwrap();
    assert_eq!(
        b,
        json!({"item_key": "todo-next-15b", "section": "todo", "lane": "next", "title": "標題", "body": "內文", "refs": [400, 402], "status": "doing", "sort_order": 35})
    );
    let upd = parse_item(&v(&["--key", "todo-next-15b", "--status", "released", "--version", "0.1.96"])).unwrap().unwrap();
    assert_eq!(upd, json!({"item_key": "todo-next-15b", "status": "released", "version": "0.1.96"}));
    let d = tempfile::tempdir().unwrap();
    let p = d.path().join("body.md");
    std::fs::write(&p, "\u{feff}第一行\n- 子項目\n\n").unwrap();
    let f = parse_item(&v(&["--key", "a", "--body-file", p.to_str().unwrap()])).unwrap().unwrap();
    assert_eq!(f["body"], "第一行\n- 子項目");
}

#[test]
fn item_參數不對_結束碼_1() {
    for args in [
        vec!["--status", "doing"],
        vec!["--key", "a"],
        vec!["--key", "a", "--section", "todo"],
        vec!["--key", "a", "--lane", "next"],
        vec!["--key", "a", "--ref", "abc"],
        vec!["--key", "a", "--ref", "0"],
        vec!["--key", "a", "--sort", "-1"],
        vec!["--key", "a", "--sort", "2000000"],
        vec!["--key", "a", "--body", "x", "--body-file", "y"],
        vec!["--key", "a", "--body-file", "不存在的檔.md"],
        vec!["--key", "a", "--x"],
    ] {
        assert_eq!(parse_item(&v(&args)).unwrap_err().code, 1, "{args:?}");
    }
}

#[test]
fn meeting_檔案_舊格式_time_台北時間_字串拆行() {
    let text = json!([{
        "time": "2026-10-28 08:00",
        "attendees": "ASN-開發 主持",
        "progress": "第一項\n第二項\n",
        "decisions": ["無"],
        "assignments": ["甲 做 A", "乙 做 B"],
        "improvements": "無",
        "extra": 1
    }])
    .to_string();
    let list = meetings_from_json(&text).unwrap();
    assert_eq!(
        list,
        vec![json!({"held_at": "2026-10-28T08:00:00+08:00", "attendees": ["ASN-開發 主持"], "progress": ["第一項", "第二項"], "decisions": ["無"], "assignments": ["甲 做 A", "乙 做 B"], "improvements": ["無"]})]
    );
    let one = json!({"held_at": "2026-10-28T00:00:00Z", "attendees": "a", "progress": "b", "decisions": "c", "assignments": "d", "improvements": "e"});
    assert_eq!(meetings_from_json(&format!("\u{feff}{one}")).unwrap()[0]["held_at"], "2026-10-28T00:00:00Z");
}

#[test]
fn meeting_檔案_內容不對_結束碼_1() {
    let base = json!({"time": "2026-10-28 08:00", "attendees": "a", "progress": "b", "decisions": "c", "assignments": "d", "improvements": "e"});
    let with = |k: &str, val: Value| {
        let mut m = base.clone();
        m[k] = val;
        m.to_string()
    };
    let mut lack = base.clone();
    lack.as_object_mut().unwrap().remove("decisions");
    for bad in [
        with("time", json!("2026/10/28 08:00")),
        with("time", json!("2026-10-28 8:00")),
        with("progress", json!("")),
        with("progress", json!("\n  \n")),
        with("progress", json!([1])),
        with("progress", json!({})),
        lack.to_string(),
        "[]".into(),
        "3".into(),
        "not json".into(),
        Value::Array((0..21).map(|_| base.clone()).collect()).to_string(),
    ] {
        assert_eq!(meetings_from_json(&bad).unwrap_err().code, 1, "{bad}");
    }
    assert!(held_at_of(base.as_object().unwrap(), 0).is_ok());
}

#[test]
fn 子命令與參數不對_結束碼_1_不打後台() {
    let (fake, _) = ok_server();
    let f = fx(&fake.url(), None);
    for args in [
        vec!["site"],
        vec!["site", "bogus"],
        vec!["site", "release"],
        vec!["site", "item", "--key", "a"],
        vec!["site", "meeting"],
        vec!["site", "meeting", "--file", "不存在的檔.json"],
        vec!["site", "meeting", "--x"],
    ] {
        let (c, out, _) = go(&f.env, &args, "");
        assert_eq!(c, 1, "{args:?}");
        assert_eq!(out, "", "{args:?}");
    }
    assert_eq!(fake.count(), 0);
    let (c, out, _) = go(&f.env, &["site", "--help"], "");
    assert_eq!(c, 0);
    assert!(out.contains("asn-cli site release"));
}

#[test]
fn release_送出_用金鑰_印一行結果_不印金鑰_不自填節點() {
    let (fake, got) = ok_server();
    let f = fx(&fake.url(), None);
    let (c, out, err) = go(&f.env, &["site", "release", "--version", "0.1.96", "--date", "2026-10-28", "--item", "x"], "");
    assert_eq!(c, 0, "{err}");
    assert_eq!(out.trim(), "已新增 0.1.96 發版記錄");
    let r = &fake.of("site_release_upsert")[0];
    assert_eq!(r.method, "POST");
    assert_eq!(r.headers.get("x-relay-key").map(String::as_str), Some(KEY));
    assert!(!out.contains(KEY) && !err.contains(KEY));
    assert_eq!(got.lock().unwrap()[0].1, json!({"version": "0.1.96", "released_on": "2026-10-28", "items": ["x"]}));
}

#[test]
fn item_與_meeting_送出() {
    let (fake, got) = ok_server();
    let f = fx(&fake.url(), None);
    let (c, out, err) = go(&f.env, &["site", "item", "--key", "todo-next-15b", "--status", "released", "--version", "0.1.96"], "");
    assert_eq!(c, 0, "{err}");
    assert_eq!(out.trim(), "已更新項目 todo-next-15b");
    let p = f.home.join("meeting.json");
    let m = json!({"time": "2026-10-28 08:00", "attendees": "a", "progress": "b", "decisions": "c", "assignments": "d", "improvements": "e"});
    std::fs::write(&p, json!([m, m]).to_string()).unwrap();
    let (c, out, err) = go(&f.env, &["site", "meeting", "--file", p.to_str().unwrap()], "");
    assert_eq!(c, 0, "{err}");
    assert_eq!(out.lines().collect::<Vec<_>>(), vec!["已新增 2026-10-28T08:00:00+08:00 會議記錄（編號 12）"; 2]);
    let g = got.lock().unwrap();
    assert_eq!(g.iter().map(|(a, _)| a.as_str()).collect::<Vec<_>>(), vec!["site_item_upsert", "site_meeting_add", "site_meeting_add"]);
    assert_eq!(g[1].1["held_at"], "2026-10-28T08:00:00+08:00");
}

#[test]
fn 後台的錯誤_印中文說明_結束碼依類別() {
    let cases: Vec<(u16, Value, i32, &str)> = vec![
        (403, json!({"error": "not_allowed", "detail": "這個節點不能寫官網內容（帳號不在官網寫入名單）"}), 3, "官網寫入名單"),
        (429, json!({"error": "rate_limited", "detail": "寫入太頻繁"}), 3, "太頻繁"),
        (400, json!({"error": "unsafe_content", "field": "items", "detail": "內容不能放上公開頁面（更新說明）"}), 1, "公開頁面"),
        (404, json!({"error": "not_found"}), 4, "還沒有官網寫入功能"),
        (500, json!({"error": "internal"}), 4, "HTTP 500"),
        (200, json!({"weird": true}), 4, "HTTP 200"),
    ];
    for (status, body, code, needle) in cases {
        let b2 = body.clone();
        let (fake, _) = server(move |_, _| (status, b2.clone()));
        let f = fx(&fake.url(), None);
        let (c, out, err) = go(&f.env, &["site", "release", "--version", "0.1.96", "--item", "x"], "");
        assert_eq!((c, out.as_str()), (code, ""), "{status} {body}");
        assert!(err.contains(needle), "{status}: {err}");
        assert!(!err.contains(KEY));
    }
}

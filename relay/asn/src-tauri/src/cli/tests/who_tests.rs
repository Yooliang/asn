//! asn who：名單 → 完整收件位址（#320）
use super::*;
use crate::cli::who::{who_line, who_rows};

fn members() -> Value {
    json!([
        {"id": "W", "name": "公司機", "agents": [{"name": "W-政策"}], "offline_agents": []},
        {"id": "T", "name": "家用機", "agents": [{"name": "Test-Gemini"}, {"name": "藏起來", "hidden": true}, {"name": "看板", "receivable": false}],
         "offline_agents": [{"name": "舊視窗"}]},
        {"id": "G", "agents": [{"name": "grok"}]}
    ])
}

#[test]
fn 名單轉位址_本機排最前_隱藏的不列_離線與只顯示有標_片段過濾() {
    let rows = who_rows(&members(), "T", "");
    let lines: Vec<String> = rows.iter().map(who_line).collect();
    assert_eq!(lines, vec![
        "T/Test-Gemini\t在線\t家用機（本機）",
        "T/看板\t在線、只顯示\t家用機（本機）",
        "T/舊視窗\t離線\t家用機（本機）",
        "G/grok\t在線\tG",
        "W/W-政策\t在線\t公司機",
    ]);
    assert_eq!(who_rows(&members(), "T", "gemini").len(), 1, "不分大小寫");
    assert_eq!(who_rows(&members(), "T", "公司").iter().map(|r| r.address.as_str()).collect::<Vec<_>>(), vec!["W/W-政策"], "也能用電腦名稱找");
    assert!(who_rows(&json!({"x": 1}), "T", "").is_empty(), "壞資料不丟錯");
}

#[test]
fn who_指令_印位址_json_與參數錯誤() {
    let b = Fake::start(|req: &Req, _| match req.action().as_str() {
        "list" => Resp::ok(json!({"members": members()})),
        _ => Resp::json(404, json!({"error": "not_found"})),
    });
    let f = fx(&b.url(), Some("T-視窗甲"));
    let (c, out, err) = go(&f.env, &["who"], "");
    assert_eq!(c, 0, "{err}");
    assert!(out.starts_with("T/Test-Gemini\t在線\t家用機（本機）"), "{out}");
    let (c, out, _) = go(&f.env, &["who", "政策", "--json"], "");
    assert_eq!(c, 0);
    let v: Value = serde_json::from_str(out.trim()).unwrap();
    assert_eq!(v, json!([{"address": "W/W-政策", "node": "W", "name": "W-政策", "online": true, "device": "公司機", "receivable": true, "here": false}]));
    let (c, out, _) = go(&f.env, &["who", "沒有這個"], "");
    assert_eq!((c, out.trim()), (0, "沒有符合的夥伴"));
    assert_eq!(go(&f.env, &["who", "--x"], "").0, 1);
    assert_eq!(go(&f.env, &["who", "a", "b"], "").0, 1);
    assert_eq!(b.of("list").len(), 3);
    // 後端錯誤：結束碼 4
    let e = Fake::start(|_: &Req, _| Resp::json(500, json!({"error": "internal"})));
    let f2 = fx(&e.url(), Some("T-視窗甲"));
    assert_eq!(go(&f2.env, &["who"], "").0, 4);
}

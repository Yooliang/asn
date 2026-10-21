//! 由 room.test.mjs 改寫：列出我在的群組、讀訊息（最近 N／某則之後／JSON）、只讀不推進已讀、被擋與找不到
use super::*;
use crate::cli::room::{parse_args, taipei};

fn rooms_backend(status_for_read: u16) -> Fake {
    Fake::start(move |req: &Req, _| match req.action().as_str() {
        "room_list" => Resp::ok(json!({"rooms": [
            {"id": "g1", "name": "Proj群", "last_seq": 6, "last_body": "最後一則   很長\n換行", "last_from_name": "政策", "mine": [{"member": "T~T-視窗甲", "read_seq": 2}]},
            {"id": "g2", "name": "別人的群", "last_seq": 3, "mine": [{"member": "T~T-別人", "read_seq": 0}]},
            {"id": "g3", "name": "空群", "last_seq": 0, "mine": [{"member": "T~T-視窗甲", "read_seq": 0}]}
        ]})),
        "room_read" => {
            if status_for_read != 200 {
                return Resp::json(status_for_read, json!({"error": if status_for_read == 403 { "not_member" } else { "nope" }}));
            }
            let since: u64 = req.param("since").unwrap().parse().unwrap();
            let msgs: Vec<Value> = (1..=6u64)
                .filter(|s| *s > since)
                .map(|s| json!({"seq": s, "from": if s == 1 { "~owner".to_string() } else { "W~W-政策".to_string() }, "from_name": if s == 1 { Value::Null } else { json!("政策") }, "trust": "member", "at": "2026-10-21T10:30:05.000Z", "mentions": [], "body": format!("內文{s}\r\n第二行")}))
                .collect();
            Resp::ok(json!({"messages": msgs, "last_seq": 6}))
        }
        _ => Resp::json(404, json!({})),
    })
}

#[test]
fn 參數檢查() {
    let p = |a: &[&str]| parse_args(&a.iter().map(|s| s.to_string()).collect::<Vec<_>>());
    assert!(p(&["--rooms"]).unwrap().rooms);
    let a = p(&["--room-read", "g1", "--last", "5", "--json"]).unwrap();
    assert_eq!((a.read.as_deref(), a.last, a.json), (Some("g1"), Some(5), true));
    for (bad, re) in [
        (vec![], "二選一"),
        (vec!["--rooms", "--room-read", "g"], "二選一"),
        (vec!["--rooms", "--json"], "只用在 --room-read"),
        (vec!["--room-read", "g", "--last", "3", "--since", "1"], "只能擇一"),
        (vec!["--room-read", "g", "--last", "0"], "1～200"),
        (vec!["--room-read", "g", "--last", "201"], "1～200"),
        (vec!["--room-read", "g", "--last", "x"], "非負整數"),
        (vec!["--room-read", "g", "--last"], "缺少參數"),
        (vec!["--zzz"], "不認得的參數 --zzz"),
    ] {
        let e = p(&bad).unwrap_err();
        assert!(e.code == 1 && e.msg.contains(re), "{bad:?} → {}", e.msg);
    }
}

#[test]
fn rooms_只列我在的群組_新訊息數用本機記錄與後端已讀較大者() {
    let b = rooms_backend(200);
    let f = fx(&b.url(), Some("T-視窗甲"));
    let (c, out, err) = go(&f.env, &["room", "--rooms"], "");
    assert_eq!(c, 0, "{err}");
    let ls: Vec<&str> = out.lines().collect();
    assert_eq!(ls[0], "g1　Proj群　共 6 則，新訊息 4 則　最後：政策：最後一則 很長 換行");
    assert_eq!(ls[1], "g3　空群　共 0 則，新訊息 0 則");
    assert_eq!(ls[2], "看內容：/x/asn-cli room --room-read <群組id> --last 20");
    assert_eq!(ls.len(), 3);
    // 沒在任何群組
    let g = fx(&b.url(), Some("T-沒人要"));
    let (c, out, _) = go(&g.env, &["room", "--rooms"], "");
    assert_eq!((c, out.trim()), (0, "（T~T-沒人要 目前不在任何群組）"));
}

#[test]
fn room_read_最近_n_則_群組名不分大小寫_只讀帶_since_記下讀到哪() {
    let b = rooms_backend(200);
    let f = fx(&b.url(), Some("T-視窗甲"));
    let (c, out, err) = go(&f.env, &["room", "--room-read", "Proj群", "--last", "2"], "");
    assert_eq!(c, 0, "{err}");
    let ls: Vec<&str> = out.lines().collect();
    assert_eq!(ls[0], "[群組 Proj群]（g1）第 5～6 則，共 6 則");
    assert_eq!(ls[1], "#5 2026/10/21 18:30:05 政策（member）：");
    assert_eq!(ls[2], "    內文5");
    assert_eq!(ls[3], "    第二行");
    let rr = b.of("room_read");
    assert_eq!(rr[0].param("since").as_deref(), Some("4"));
    assert_eq!(rr[0].param("as_agent").as_deref(), Some("T-視窗甲"));
    assert_eq!(rr[0].param("limit").as_deref(), Some("2"));
    let seen: Value = serde_json::from_str(&std::fs::read_to_string(f.work().join("room-seen.json")).unwrap()).unwrap();
    assert_eq!(seen["g1|T~T-視窗甲"], 6);
    // 讀過了：--rooms 的新訊息數歸零
    let (_, out, _) = go(&f.env, &["room", "--rooms"], "");
    assert!(out.lines().next().unwrap().contains("新訊息 0 則"), "{out}");
    // 大小寫不同的群組名、--since、預設 20 則
    let (c, out, _) = go(&f.env, &["room", "--room-read", "PROJ群", "--since", "4"], "");
    assert_eq!(c, 0);
    assert!(out.starts_with("[群組 Proj群]（g1）第 5～6 則") && out.contains("#6 "), "{out}");
    assert_eq!(b.of("room_read")[1].param("since").as_deref(), Some("4"));
    // 主人（~owner）的顯示
    let (_, out, _) = go(&f.env, &["room", "--room-read", "g1", "--since", "0"], "");
    assert!(out.contains("#1 2026/10/21 18:30:05 主人（member）："), "{out}");
    // 每次都帶 since（不帶會推進後端已讀）
    assert!(b.of("room_read").iter().all(|r| r.param("since").is_some()));
}

#[test]
fn room_read_json_一則一行_欄位順序固定() {
    let b = rooms_backend(200);
    let f = fx(&b.url(), Some("T-視窗甲"));
    let (c, out, _) = go(&f.env, &["room", "--room-read", "g1", "--last", "1", "--json"], "");
    assert_eq!(c, 0);
    assert_eq!(out.lines().count(), 1);
    assert!(out.starts_with("{\"seq\":6,\"from\":\"W~W-政策\",\"from_name\":\"政策\",\"trust\":\"member\",\"at\":\"2026-10-21T10:30:05.000Z\",\"mentions\":[],\"body\":\"內文6\\r\\n第二行\""), "{out}");
}

#[test]
fn room_read_被擋_找不到_不是成員_後端錯誤_結束碼() {
    let f403 = rooms_backend(403);
    let f = fx(&f403.url(), Some("T-視窗甲"));
    let (c, _, err) = go(&f.env, &["room", "--room-read", "g1"], "");
    assert_eq!(c, 3);
    assert!(err.contains("被擋：不是這個群組的成員（not_member）"), "{err}");
    let (c, _, err) = go(&f.env, &["room", "--room-read", "g2"], "");
    assert_eq!(c, 3);
    assert!(err.contains("找不到「g2」或你（T~T-視窗甲）不在這個群組"), "{err}");
    let f404 = rooms_backend(404);
    let g = fx(&f404.url(), Some("T-視窗甲"));
    let (c, _, err) = go(&g.env, &["room", "--room-read", "g1"], "");
    assert_eq!((c, err.trim()), (3, "找不到這個群組"));
    let f500 = rooms_backend(500);
    let h = fx(&f500.url(), Some("T-視窗甲"));
    let (c, _, err) = go(&h.env, &["room", "--room-read", "g1"], "");
    assert_eq!(c, 4);
    assert!(err.contains("room_read HTTP 500"), "{err}");
}

#[test]
fn room_read_有附件_內文多下載指令行() {
    let b = Fake::start(|req: &Req, _| match req.action().as_str() {
        "room_list" => Resp::ok(json!({"rooms": [{"id": "g1", "name": "群", "last_seq": 1, "mine": [{"member": "T~T-視窗甲", "read_seq": 0}]}]})),
        _ => Resp::ok(json!({"messages": [{"seq": 1, "from": "W~W-政策", "trust": "member", "at": "2026-10-21T10:30:05Z", "body": "〔檔案〕報告.pdf\n看看", "attachments": [{"id": uid(60), "kind": "file", "name": "報告.pdf", "mime": "application/pdf", "bytes": 2621440}]}], "last_seq": 1})),
    });
    let f = fx(&b.url(), Some("T-視窗甲"));
    let (c, out, _) = go(&f.env, &["room", "--room-read", "g1"], "");
    assert_eq!(c, 0);
    assert!(out.contains(&format!("    看看\n    〔檔案〕報告.pdf（2.5 MB）下載：/x/asn-cli attach --id {}", uid(60))), "{out}");
}

#[test]
fn 台北時間格式() {
    assert_eq!(taipei("2026-10-21T10:30:05.000Z"), "2026/10/21 18:30:05");
    assert_eq!(taipei("2026-12-31T20:00:00Z"), "2027/1/1 04:00:00");
    assert_eq!(taipei("2026-03-05T00:00:00+08:00"), "2026/3/5 00:00:00");
    assert_eq!(taipei("不是時間"), "不是時間");
}

//! asn room confirm-request／confirm-status：危險操作前請主持人確認、查放行（假後端，不碰真實後端）
use super::*;
use crate::cli::confirm::{parse_args, status_line};

const CID: &str = "0b9c8f3a-1111-4222-8333-444455556666";

fn confirm_backend(status: &'static str, consumed: bool) -> Fake {
    Fake::start(move |req: &Req, _| match req.action().as_str() {
        "room_list" => Resp::ok(json!({"rooms": [
            {"id": "g1", "name": "財務小組", "last_seq": 6, "mine": [{"member": "T~T-視窗甲", "read_seq": 2}]},
            {"id": "g2", "name": "別人的群", "last_seq": 3, "mine": [{"member": "T~T-別人", "read_seq": 0}]}
        ]})),
        "room_confirm_request" => {
            let b = req.json();
            if b["kind"] == "spend" && b["summary"].as_str().unwrap_or("").contains("太多") {
                return Resp::json(429, json!({"error": "rate_limited"}));
            }
            Resp::ok(json!({"id": CID, "short": "0b9c8f3a", "seq": 7, "status": "pending"}))
        }
        "room_confirm_status" => Resp::ok(json!({"status": status, "consumed": consumed})),
        _ => Resp::json(404, json!({})),
    })
}

#[test]
fn 參數檢查() {
    let p = |sub: &str, a: &[&str]| parse_args(sub, &a.iter().map(|s| s.to_string()).collect::<Vec<_>>());
    let ok = p("confirm-request", &["--room", "財務小組", "--kind", "spend", "--summary", "付款 3 萬"]).unwrap();
    assert_eq!((ok.room.as_deref(), ok.kind.as_deref(), ok.summary.as_deref()), (Some("財務小組"), Some("spend"), Some("付款 3 萬")));
    let st = p("confirm-status", &[CID, "--peek"]).unwrap();
    assert_eq!((st.id.as_deref(), st.peek), (Some(CID), true));
    for (sub, bad, re) in [
        ("confirm-request", vec!["--kind", "spend", "--summary", "x"], "--room"),
        ("confirm-request", vec!["--room", "g", "--kind", "rm", "--summary", "x"], "其中之一"),
        ("confirm-request", vec!["--room", "g", "--kind", "spend"], "--summary"),
        ("confirm-request", vec!["--room", "g", "--kind", "spend", "--summary", "  "], "--summary"),
        ("confirm-request", vec!["--room", "g", "--kind", "spend", "--summary", "字\u{4e00}".repeat(251).as_str()], "--summary"),
        ("confirm-request", vec!["--room", "g", "--kind", "spend", "--summary", "x", "--peek"], "只用在 confirm-status"),
        ("confirm-status", vec![], "編號"),
        ("confirm-status", vec!["不是編號"], "編號"),
        ("confirm-status", vec![CID, "--room", "g"], "只用在 confirm-request"),
        ("confirm-status", vec![CID, "--zzz"], "不認得的參數"),
    ] {
        let e = p(sub, &bad).unwrap_err();
        assert!(e.code == 1 && e.msg.contains(re), "{sub} {bad:?} → {}", e.msg);
    }
}

#[test]
fn 狀態對照_只有_approved_才是可以做() {
    assert_eq!(status_line("approved", true).1, 0);
    assert_eq!(status_line("pending", false).1, 10);
    assert_eq!(status_line("denied", false).1, 11);
    assert_eq!(status_line("used", false).1, 12);
    assert_eq!(status_line("expired", false).1, 12);
    assert_eq!(status_line("亂來", false).1, 4, "不認得的狀態一律當作不能做");
    assert!(status_line("approved", true).0.contains("用掉"));
}

#[test]
fn 請求_用我在的群組送出_內容帶視窗名_印出編號() {
    let b = confirm_backend("pending", false);
    let f = fx(&b.url(), Some("T-視窗甲"));
    let (c, out, err) = go(&f.env, &["room", "confirm-request", "--room", "財務小組", "--kind", "data_change", "--summary", "沖銷 12 筆既有帳目"], "");
    assert_eq!(c, 0, "{err}");
    assert!(out.contains("已請主持人確認（#0b9c8f3a，修改或刪除既有資料）") && out.contains(&format!("id={CID}")) && out.contains("confirm-status"), "{out}");
    let post = b.of("room_confirm_request").into_iter().next().unwrap();
    let body = post.json();
    assert_eq!((body["room"].as_str(), body["as_agent"].as_str(), body["kind"].as_str(), body["summary"].as_str()), (Some("g1"), Some("T-視窗甲"), Some("data_change"), Some("沖銷 12 筆既有帳目")));
    assert_eq!(post.param("room").as_deref(), Some("g1"));
}

#[test]
fn 請求_不在的群組被擋_太多筆待確認有提示() {
    let b = confirm_backend("pending", false);
    let f = fx(&b.url(), Some("T-視窗甲"));
    let (c, _, err) = go(&f.env, &["room", "confirm-request", "--room", "別人的群", "--kind", "spend", "--summary", "付款"], "");
    assert_eq!(c, 3, "{err}");
    assert!(err.contains("不在這個群組"), "{err}");
    assert!(b.of("room_confirm_request").is_empty(), "不在群組就不送請求");
    let (c, _, err) = go(&f.env, &["room", "confirm-request", "--room", "g1", "--kind", "spend", "--summary", "太多筆了"], "");
    assert_eq!(c, 4, "{err}");
    assert!(err.contains("最多 5 筆"), "{err}");
}

#[test]
fn 查放行_approved_用掉一次_peek_不用掉_其他狀態有各自的結束碼() {
    for (status, consumed, code, text) in [("approved", true, 0, "approved"), ("pending", false, 10, "pending"), ("denied", false, 11, "denied"), ("used", false, 12, "used"), ("expired", false, 12, "expired")] {
        let b = confirm_backend(status, consumed);
        let f = fx(&b.url(), Some("T-視窗甲"));
        let (c, out, err) = go(&f.env, &["room", "confirm-status", CID], "");
        assert_eq!((c, out.starts_with(text)), (code, true), "{status}: {out}{err}");
        let q = b.of("room_confirm_status").into_iter().next().unwrap();
        assert_eq!((q.json()["id"].as_str(), q.json()["as_agent"].as_str(), q.json()["consume"].as_bool()), (Some(CID), Some("T-視窗甲"), Some(true)));
    }
    let b = confirm_backend("approved", false);
    let f = fx(&b.url(), Some("T-視窗甲"));
    let (c, out, _) = go(&f.env, &["room", "confirm-status", CID, "--peek"], "");
    assert_eq!(c, 0);
    assert!(out.contains("只是查看"));
    assert_eq!(b.of("room_confirm_status")[0].json()["consume"].as_bool(), Some(false));
}

#[test]
fn 查放行_別人的請求被擋_找不到請求() {
    for (status, code, re) in [(403u16, 3, "不是你"), (404, 3, "找不到")] {
        let b = Fake::start(move |req: &Req, _| if req.action() == "room_confirm_status" { Resp::json(status, json!({"error": "x"})) } else { Resp::json(404, json!({})) });
        let f = fx(&b.url(), Some("T-視窗甲"));
        let (c, _, err) = go(&f.env, &["room", "confirm-status", CID], "");
        assert!(c == code && err.contains(re), "{status}: {err}");
    }
}
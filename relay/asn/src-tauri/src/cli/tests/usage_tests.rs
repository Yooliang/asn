//! `asn-cli usage report／list`：本機假後端（127.0.0.1）；只確認送出的內容與輸出，金鑰不得出現在輸出。
use super::*;
use crate::cli::usage_cmd::{hour_floor_iso, parse_report, row_from_flags, rows_from_json};
use std::sync::Mutex;

fn v(a: &[&str]) -> Vec<String> {
    a.iter().map(|s| s.to_string()).collect()
}

fn good(hour: &str) -> Value {
    json!({"hour": hour, "input_tokens": 1, "cache_read_tokens": 2, "cache_creation_tokens": 3, "output_tokens": 4, "tasks_ok": 5, "tasks_failed": 6, "rounds": 7})
}

/// 假後台：report 記下收到的列；list 回固定兩列
fn server(status: u16) -> (Fake, Arc<Mutex<Vec<Value>>>) {
    let got: Arc<Mutex<Vec<Value>>> = Arc::new(Mutex::new(vec![]));
    let g2 = got.clone();
    let fake = Fake::start(move |req: &Req, _| {
        if status != 200 {
            return Resp::json(status, json!({"error": "not_found"}));
        }
        match req.action().as_str() {
            "usage_report" => {
                let rows = req.json()["rows"].as_array().cloned().unwrap_or_default();
                let n = rows.len();
                g2.lock().unwrap().extend(rows);
                Resp::ok(json!({"ok": true, "saved": n}))
            }
            "usage_list" => Resp::ok(json!({"rows": [good("2026-10-24T11:00:00Z"), good("2026-10-24T10:00:00Z")]})),
            _ => Resp::json(404, json!({"error": "not_found"})),
        }
    });
    (fake, got)
}

#[test]
fn 整點字串_取目前的_utc_整點() {
    assert_eq!(hour_floor_iso(1_792_845_000_000), "2026-10-24T12:00:00Z"); // 12:30:00Z
    assert_eq!(hour_floor_iso(1_792_839_600_000), "2026-10-24T11:00:00Z"); // 剛好整點
}

#[test]
fn 檔案_單一物件或陣列都收_多餘欄位丟掉() {
    let mut one = good("2026-10-24T11:00:00Z");
    one["node"] = json!("別人");
    one["evil"] = json!(1);
    let rows = rows_from_json(&one.to_string()).unwrap();
    assert_eq!(rows, vec![good("2026-10-24T11:00:00Z")]);
    let arr = json!([good("2026-10-24T10:00:00Z"), good("2026-10-24T11:00:00Z")]).to_string();
    assert_eq!(rows_from_json(&arr).unwrap().len(), 2);
    assert_eq!(rows_from_json(&format!("\u{feff}{}", one)).unwrap().len(), 1, "容許 BOM");
}

#[test]
fn 檔案_內容不對_結束碼_1() {
    let mut neg = good("2026-10-24T11:00:00Z");
    neg["rounds"] = json!(-1);
    let mut frac = good("2026-10-24T11:00:00Z");
    frac["tasks_ok"] = json!(1.5);
    let mut lack = good("2026-10-24T11:00:00Z");
    lack.as_object_mut().unwrap().remove("output_tokens");
    let mut nohour = good("2026-10-24T11:00:00Z");
    nohour.as_object_mut().unwrap().remove("hour");
    let too_many = Value::Array((0..49).map(|_| good("2026-10-24T11:00:00Z")).collect());
    for bad in [neg.to_string(), frac.to_string(), lack.to_string(), nohour.to_string(), too_many.to_string(), "[]".into(), "not json".into(), "3".into()] {
        assert_eq!(rows_from_json(&bad).unwrap_err().code, 1, "{bad}");
    }
}

#[test]
fn 旗標_沒給的計數算_0_hour_預設目前整點() {
    let a = parse_report(&v(&["--output-tokens", "9", "--rounds", "2"])).unwrap();
    let r = row_from_flags(&a, 1_792_845_000_000);
    assert_eq!(r["hour"], "2026-10-24T12:00:00Z");
    assert_eq!((r["output_tokens"].as_u64(), r["rounds"].as_u64(), r["input_tokens"].as_u64()), (Some(9), Some(2), Some(0)));
    let b = parse_report(&v(&["--hour", "2026-10-24T03:00:00Z", "--tasks-ok", "1"])).unwrap();
    assert_eq!(row_from_flags(&b, 0)["hour"], "2026-10-24T03:00:00Z");
}

#[test]
fn 參數不對_結束碼_1_不打後台() {
    let (fake, _) = server(200);
    let f = fx(&fake.url(), None);
    for args in [
        vec!["usage"],
        vec!["usage", "bogus"],
        vec!["usage", "report"],
        vec!["usage", "report", "--rounds", "abc"],
        vec!["usage", "report", "--rounds", "-1"],
        vec!["usage", "report", "--rounds"],
        vec!["usage", "report", "--file", "x.json", "--rounds", "1"],
        vec!["usage", "report", "--file", "不存在的檔.json"],
        vec!["usage", "report", "--x"],
        vec!["usage", "list", "--x"],
        vec!["usage", "list", "--since"],
    ] {
        let (c, out, _) = go(&f.env, &args, "");
        assert_eq!(c, 1, "{args:?}");
        assert_eq!(out, "", "{args:?}");
    }
    assert_eq!(fake.count(), 0);
}

#[test]
fn report_檔案_整批送出_用金鑰_不印金鑰() {
    let (fake, got) = server(200);
    let f = fx(&fake.url(), None);
    let p = f.home.join("hourly.json");
    std::fs::write(&p, json!([good("2026-10-24T10:00:00Z"), good("2026-10-24T11:00:00Z")]).to_string()).unwrap();
    let (c, out, err) = go(&f.env, &["usage", "report", "--file", p.to_str().unwrap()], "");
    assert_eq!(c, 0, "{err}");
    assert_eq!(serde_json::from_str::<Value>(out.trim()).unwrap(), json!({"ok": true, "saved": 2}));
    assert_eq!(got.lock().unwrap().len(), 2);
    assert_eq!(fake.of("usage_report")[0].headers.get("x-relay-key").map(String::as_str), Some(KEY));
    assert!(!out.contains(KEY) && !err.contains(KEY));
    assert!(fake.of("usage_report")[0].json().get("node").is_none(), "不自填節點");
}

#[test]
fn report_旗標_一行指令就能報_重報送同一個整點() {
    let (fake, got) = server(200);
    let f = fx(&fake.url(), None);
    let args = ["usage", "report", "--hour", "2026-10-24T09:00:00Z", "--input-tokens", "100", "--output-tokens", "50", "--tasks-ok", "3", "--rounds", "4"];
    let (c, _, err) = go(&f.env, &args, "");
    assert_eq!(c, 0, "{err}");
    let (c2, _, _) = go(&f.env, &args, "");
    assert_eq!(c2, 0);
    let g = got.lock().unwrap();
    assert_eq!(g.len(), 2);
    assert_eq!(g[0], g[1], "同一小時重報送的是同樣的鍵");
    assert_eq!(g[0]["hour"], "2026-10-24T09:00:00Z");
    assert_eq!(g[0]["input_tokens"], 100);
    assert_eq!(g[0]["cache_read_tokens"], 0);
}

#[test]
fn report_旗標_沒給_hour_用目前整點() {
    let (fake, got) = server(200);
    let f = fx(&fake.url(), None);
    let (c, _, err) = go(&f.env, &["usage", "report", "--rounds", "1"], "");
    assert_eq!(c, 0, "{err}");
    let h = got.lock().unwrap()[0]["hour"].as_str().unwrap().to_string();
    assert!(h.ends_with(":00:00Z") && h.len() == 20, "{h}");
}

#[test]
fn list_帶_since_編碼後送出_印出後台的列() {
    let (fake, _) = server(200);
    let f = fx(&fake.url(), None);
    let (c, out, err) = go(&f.env, &["usage", "list", "--since", "2026-10-24T00:00:00+08:00"], "");
    assert_eq!(c, 0, "{err}");
    assert_eq!(serde_json::from_str::<Value>(out.trim()).unwrap()["rows"].as_array().unwrap().len(), 2);
    let r = &fake.of("usage_list")[0];
    assert_eq!(r.param("since").as_deref(), Some("2026-10-24T00:00:00+08:00"));
    assert!(!out.contains(KEY));
    let (c2, _, _) = go(&f.env, &["usage", "list"], "");
    assert_eq!(c2, 0);
    assert_eq!(fake.of("usage_list")[1].param("since"), None);
}

#[test]
fn 後台還沒部署_結束碼_4() {
    let (fake, _) = server(404);
    let f = fx(&fake.url(), None);
    let (c, out, err) = go(&f.env, &["usage", "report", "--rounds", "1"], "");
    assert_eq!((c, out.as_str()), (4, ""));
    assert!(err.contains("404") && !err.contains(KEY));
    let (c2, _, _) = go(&f.env, &["usage", "list"], "");
    assert_eq!(c2, 4);
}

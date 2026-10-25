//! 由 attach.test.mjs 改寫：換短效網址、下載、檢查（主機、大小、檔頭）、不覆蓋既有檔案
use super::*;
use crate::cli::attach_cmd::{local_name, parse_args};

fn pdf_bytes() -> Vec<u8> {
    let mut b = b"%PDF-1.4\n".to_vec();
    b.resize(100, b' ');
    b
}

/// 假後端：attach_url 回 /dl/<id> 或指定的網址；mode 控制各種壞情況
fn dl_backend(mode: &'static str) -> Fake {
    Fake::start(move |req: &Req, port: u16| {
        if req.path.starts_with("/dl/") {
            return Resp::bytes(200, if mode == "badcontent" { b"not a pdf at all, sorry".to_vec() } else { pdf_bytes() });
        }
        if req.action() != "attach_url" {
            return Resp::json(404, json!({}));
        }
        match mode {
            "404" => Resp::json(404, json!({"error": "not_found"})),
            "410" => Resp::json(410, json!({"error": "expired"})),
            "evilhost" => Resp::ok(json!({"url": "http://evil.example/dl/x", "mime": "application/pdf", "name": "a.pdf", "bytes": 100})),
            "badsize" => Resp::ok(json!({"url": format!("http://127.0.0.1:{port}/dl/x"), "mime": "application/pdf", "name": "a.pdf", "bytes": 999})),
            "badmime" => Resp::ok(json!({"url": format!("http://127.0.0.1:{port}/dl/x"), "mime": "application/x-msdownload", "name": "a.exe", "bytes": 100})),
            _ => Resp::ok(json!({"url": format!("http://127.0.0.1:{port}/dl/x?sig=SECRET"), "mime": "application/pdf", "name": "報告 (最終).pdf", "bytes": if mode == "badcontent" { 23 } else { 100 }})),
        }
    })
}

#[test]
fn 參數() {
    let p = |a: &[&str]| parse_args(&a.iter().map(|s| s.to_string()).collect::<Vec<_>>());
    let a = p(&["--id", "x", "--out", "y"]).unwrap();
    assert_eq!((a.id.as_deref(), a.out.as_deref()), (Some("x"), Some("y")));
    assert!(p(&["--id"]).unwrap_err().msg.contains("缺少參數"));
    assert!(p(&["--q"]).unwrap_err().msg.contains("不認得的參數"));
    assert_eq!(local_name(&uid(1), "報告 (最終).pdf", "application/pdf"), "00000000-報告_最終_.pdf");
    assert_eq!(local_name(&uid(1), "", "image/webp"), "00000000-file.webp");
}

#[test]
fn 下載到預設資料夾_印_saved_路徑_已存在不重抓_檔案內容正確() {
    let b = dl_backend("ok");
    let f = fx(&b.url(), Some("T-視窗甲"));
    let id = uid(7);
    let (c, out, err) = go(&f.env, &["attach", "--id", &id], "");
    assert_eq!(c, 0, "{err}");
    let want = f.work().join("attachments").join("00000000-報告_最終_.pdf");
    assert_eq!(out.trim(), format!("saved {}", want.display()));
    assert_eq!(std::fs::read(&want).unwrap(), pdf_bytes());
    assert!(!out.contains("SECRET"));
    let n = b.count();
    let (c, out2, _) = go(&f.env, &["attach", "--id", &id], "");
    assert_eq!((c, out2), (0, out));
    assert_eq!(b.count(), n + 1, "再下載一次只換網址（attach_url），檔案已在就不重抓");
    assert!(b.of("attach_url").iter().all(|r| r.headers.get("x-relay-key").map(String::as_str) == Some(KEY)));
}

#[test]
fn out_指定路徑_已有檔案就拒絕_不覆蓋() {
    let b = dl_backend("ok");
    let f = fx(&b.url(), Some("T-視窗甲"));
    let out = f.home.join("sub").join("x.pdf");
    let (c, o, err) = go(&f.env, &["attach", "--id", &uid(7), "--out", out.to_str().unwrap()], "");
    assert_eq!(c, 0, "{err}");
    assert!(o.trim() == format!("saved {}", out.display()));
    assert_eq!(std::fs::read(&out).unwrap(), pdf_bytes());
    std::fs::write(&out, b"mine").unwrap();
    let (c, _, err) = go(&f.env, &["attach", "--id", &uid(7), "--out", out.to_str().unwrap()], "");
    assert_eq!(c, 1);
    assert!(err.contains("目的地已有檔案，不覆蓋"), "{err}");
    assert_eq!(std::fs::read(&out).unwrap(), b"mine");
}

#[test]
fn 各種失敗_結束碼與白話訊息_不存檔() {
    for (mode, code, re) in [
        ("404", 4, "取不到下載網址：找不到這個附件，或你沒有權限下載"),
        ("410", 4, "取不到下載網址：這個附件已過期"),
        ("evilhost", 4, "下載網址不在 ASN 的主機上，拒絕下載"),
        ("badsize", 4, "檔案大小不符（應為 999，收到 100）"),
        ("badmime", 4, "不認得的檔案型別，拒絕存檔"),
        ("badcontent", 4, "檔案內容跟型別對不上，拒絕存檔"),
    ] {
        let b = dl_backend(mode);
        let f = fx(&b.url(), Some("T-視窗甲"));
        let (c, out, err) = go(&f.env, &["attach", "--id", &uid(7)], "");
        assert_eq!(c, code, "{mode}");
        assert!(err.contains(re), "{mode} → {err}");
        assert_eq!(out, "");
        assert!(read_dir_names(&f.work().join("attachments")).is_empty(), "{mode}：不能留下檔案");
    }
    let b = dl_backend("ok");
    let f = fx(&b.url(), Some("T-視窗甲"));
    for (args, re) in [(vec!["attach"], "缺少 --id"), (vec!["attach", "--id", "不是uuid"], "--id 要是附件編號")] {
        let (c, _, err) = go(&f.env, &args, "");
        assert_eq!(c, 1);
        assert!(err.contains(re), "{err}");
    }
    assert_eq!(b.count(), 0);
}

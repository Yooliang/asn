//! asn avatar（#446）：身分取自呼叫者、node 不在請求內容裡、圖在本機處理後才上傳、後台各種回覆的說明與結束碼
use super::*;

fn png_file(dir: &Path, name: &str, w: u32, h: u32) -> String {
    let img = image::RgbaImage::from_fn(w, h, |x, y| image::Rgba([(x % 256) as u8, (y % 256) as u8, 120, 255]));
    let p = dir.join(name);
    img.save_with_format(&p, image::ImageFormat::Png).unwrap();
    p.display().to_string()
}

fn backend_with(status: u16, error: &'static str) -> Fake {
    Fake::start(move |req: &Req, _| {
        if req.action() != "set_partner_avatar" {
            return Resp::json(404, json!({}));
        }
        if status == 200 {
            return Resp::ok(json!({"ok": true, "partner_id": "p_00000000000000000001", "avatar_updated_at": "2026-10-28T00:00:00Z"}));
        }
        Resp::json(status, json!({"error": error}))
    })
}

#[test]
fn 設定頭像_身分取自視窗_圖在本機縮成_96_後才上傳_請求裡沒有節點() {
    let b = backend_with(200, "");
    let f = fx(&b.url(), Some("T-視窗甲"));
    let file = png_file(&f.home, "a.png", 300, 200);
    let (c, out, err) = go(&f.env, &["avatar", "set", "--file", &file], "");
    assert_eq!(c, 0, "{err}");
    assert_eq!(out.trim(), "avatar set p_00000000000000000001");
    let reqs = b.of("set_partner_avatar");
    assert_eq!(reqs.len(), 1);
    let body = reqs[0].json();
    assert_eq!(body["agent"], "T-視窗甲");
    assert_eq!(body.as_object().unwrap().keys().cloned().collect::<std::collections::BTreeSet<_>>(), ["agent", "avatar"].iter().map(|s| s.to_string()).collect(), "只有 agent 與 avatar");
    let url = body["avatar"].as_str().unwrap();
    assert!(crate::avatar::validate(url).is_ok());
    assert!(url.starts_with("data:image/png;base64,"));
    assert_eq!(reqs[0].headers.get("x-relay-key").map(String::as_str), Some(KEY));
}

#[test]
fn 移除頭像_avatar_是_null() {
    let b = backend_with(200, "");
    let f = fx(&b.url(), Some("T-視窗甲"));
    let (c, out, err) = go(&f.env, &["avatar", "clear"], "");
    assert_eq!(c, 0, "{err}");
    assert_eq!(out.trim(), "avatar cleared");
    assert_eq!(b.of("set_partner_avatar")[0].json(), json!({"agent": "T-視窗甲", "avatar": null}));
}

#[test]
fn 圖不合法_在本機就擋下_不送出任何請求() {
    let b = backend_with(200, "");
    let f = fx(&b.url(), Some("T-視窗甲"));
    let svg = f.home.join("a.svg");
    std::fs::write(&svg, "<svg xmlns='http://www.w3.org/2000/svg'/>").unwrap();
    let (c, _, err) = go(&f.env, &["avatar", "set", "--file", &svg.display().to_string()], "");
    assert_eq!(c, 1);
    assert!(err.contains("只收 png"), "{err}");
    let (c, _, err) = go(&f.env, &["avatar", "set", "--file", &f.home.join("沒有.png").display().to_string()], "");
    assert_eq!(c, 1);
    assert!(err.contains("讀不到"), "{err}");
    let (c, _, err) = go(&f.env, &["avatar", "set"], "");
    assert_eq!(c, 1);
    assert!(err.contains("缺少 --file"), "{err}");
    assert_eq!(b.count(), 0);
}

#[test]
fn 不在_claude_視窗裡就拒絕_不送請求() {
    let b = backend_with(200, "");
    let mut f = fx(&b.url(), Some("T-視窗甲"));
    f.env.procs = Arc::new(|| Ok([(SELF_PID, (1, "asn-cli.exe".to_string()))].into_iter().collect()));
    let file = png_file(&f.home, "a.png", 64, 64);
    let (c, _, err) = go(&f.env, &["avatar", "set", "--file", &file], "");
    assert_eq!(c, 2);
    assert!(err.contains("換頭像"), "{err}");
    assert_eq!(b.count(), 0);
}

#[test]
fn 後台各種回覆都有清楚的說明與結束碼() {
    let file_for = |f: &Fx| png_file(&f.home, "a.png", 64, 64);
    for (status, error, code, want) in [
        (404u16, "partner_not_found", 4, "找不到這位夥伴"),
        (404, "not_found", 4, "後台還不支援"),
        (429, "rate_limited", 3, "每小時最多改 5 次"),
        (400, "bad_avatar_format", 4, "格式或大小不對"),
        (500, "internal", 4, "internal"),
    ] {
        let b = backend_with(status, error);
        let f = fx(&b.url(), Some("T-視窗甲"));
        let file = file_for(&f);
        let (c, _, err) = go(&f.env, &["avatar", "set", "--file", &file], "");
        assert_eq!(c, code, "{error}: {err}");
        assert!(err.contains(want), "{error}: {err}");
        assert!(!err.contains(KEY), "金鑰不外洩");
    }
}

#[test]
fn help_說明信任邊界() {
    let b = backend_with(200, "");
    let f = fx(&b.url(), Some("T-視窗甲"));
    let (c, out, _) = go(&f.env, &["avatar", "--help"], "");
    assert_eq!(c, 0);
    assert!(out.contains("同一台電腦上的視窗在伺服器看起來是同一個人"), "{out}");
    assert!(out.contains("每小時最多改 5 次") && out.contains("不收 SVG"));
    assert_eq!(b.count(), 0);
}

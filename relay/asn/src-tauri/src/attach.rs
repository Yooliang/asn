//! 傳照片：格式與大小在 Rust 端檢查（金鑰也只在這裡），通過才向收發室要上傳網址、上傳、確認、寄信。
//! 規則與 ui/lib/photo.mjs、supabase/functions/_shared/attachments.ts 一致：只收 webp（檔頭 RIFF….WEBP）、≤ 5 MB，
//! 縮圖是 `data:image/webp;base64,…` ≤ 12000 字，檔名清掉控制字元與括號。設計見 docs/ATTACHMENTS.md。
use crate::relay::{encode_component, Relay};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::{json, Map, Value};
use std::path::{Path, PathBuf};
use std::time::Duration;

/// 照片（ASN 在前端壓成 webp）上限 5 MB；一般檔案不壓縮不轉檔，上限 25 MB
pub const MAX_BYTES: usize = 5 * 1024 * 1024;
pub const MAX_FILE_BYTES: usize = 25 * 1024 * 1024;
pub const THUMB_MAX_CHARS: usize = 12_000;
pub const NAME_MAX: usize = 80;
pub const DIM_MAX: u64 = 20_000;
const THUMB_PREFIX: &str = "data:image/webp;base64,";
/// 內文最前面給舊版用戶端看的替代文字（新版用戶端有結構化的附件，不重複顯示）
pub const PHOTO_LABEL: &str = "〔照片〕";
pub const FILE_LABEL: &str = "〔檔案〕";

/// 一般檔案的白名單：副檔名 → 型別（同 supabase/functions/_shared/attachments.ts 的 FILE_TYPES）。可執行檔、腳本、安裝檔一律不在裡面。
pub const FILE_TYPES: [(&str, &str); 9] = [
    ("pdf", "application/pdf"),
    ("txt", "text/plain"),
    ("md", "text/markdown"),
    ("json", "application/json"),
    ("csv", "text/csv"),
    ("zip", "application/zip"),
    ("docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"),
    ("xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"),
    ("pptx", "application/vnd.openxmlformats-officedocument.presentationml.presentation"),
];

/// 檔名的副檔名在白名單內才回型別
pub fn file_mime(name: &str) -> Option<&'static str> {
    let ext = name.rsplit_once('.')?.1.to_ascii_lowercase();
    FILE_TYPES.iter().find(|(e, _)| *e == ext).map(|(_, m)| *m)
}

/// 型別 → 副檔名（含照片）；不認得回 None
pub fn ext_of(mime: &str) -> Option<&'static str> {
    if mime == "image/webp" { return Some("webp"); }
    FILE_TYPES.iter().find(|(_, m)| *m == mime).map(|(e, _)| *e)
}

/// 內容要跟型別對得上：webp＝RIFF….WEBP、pdf＝%PDF-、zip 系＝PK 檔頭、文字檔前 8 KB 不能有 NUL（排除偽裝的執行檔）
pub fn content_ok(mime: &str, b: &[u8]) -> bool {
    match mime {
        "image/webp" => is_webp(b),
        "application/pdf" => b.starts_with(b"%PDF-"),
        "text/plain" | "text/markdown" | "application/json" | "text/csv" => !b[..b.len().min(8192)].contains(&0),
        m if ext_of(m).is_some() => b.len() >= 4 && b[0] == 0x50 && b[1] == 0x4b && (b[2] == 3 || b[2] == 5),
        _ => false,
    }
}

pub fn limit_of(mime: &str) -> usize {
    if mime == "image/webp" { MAX_BYTES } else { MAX_FILE_BYTES }
}

/// 檔名來自使用者的檔案系統或寄件人，視為外部資料：控制字元、括號、引號、路徑與 shell 符號都換成空白
#[cfg(test)]
pub fn clean_name(s: &str) -> String {
    clean_name_or(s, "photo.webp")
}

pub fn clean_name_or(s: &str, fallback: &str) -> String {
    const BAD: &str = "〔〕［］【】「」『』()（）[]{}<>《》`'\"“”‘’\\/|:*?;&$%!#^~=,";
    let spaced: String = s
        .chars()
        .map(|c| {
            let u = c as u32;
            let ctrl = c.is_control() || matches!(u, 0x2028 | 0x2029 | 0x200b..=0x200f | 0x202a..=0x202e | 0x2066..=0x2069);
            if ctrl || BAD.contains(c) { ' ' } else { c }
        })
        .collect();
    let joined = spaced.split_whitespace().collect::<Vec<_>>().join(" ");
    let trimmed = joined.trim_start_matches(|c: char| c == '.' || c.is_whitespace());
    let cut: String = trimmed.chars().take(NAME_MAX).collect();
    let cut = cut.trim().to_string();
    if cut.is_empty() { fallback.to_string() } else { cut }
}

/// webp 檔頭：RIFF 四個位元組、長度、WEBP
pub fn is_webp(b: &[u8]) -> bool {
    b.len() >= 12 && &b[0..4] == b"RIFF" && &b[8..12] == b"WEBP"
}

pub fn validate_thumb(s: &str) -> Result<(), String> {
    let rest = s.strip_prefix(THUMB_PREFIX).ok_or("縮圖只接受 webp")?;
    if s.len() > THUMB_MAX_CHARS {
        return Err("縮圖太大了".into());
    }
    let bytes = STANDARD.decode(rest).map_err(|_| "縮圖的內容不是有效的圖片資料")?;
    if !is_webp(&bytes) {
        return Err("縮圖內容跟格式對不上".into());
    }
    Ok(())
}

/// 前端交來的要傳的東西：照片（kind=image，已壓縮、已轉 webp）或一般檔案（kind=file，原檔不動）
#[derive(Debug, PartialEq)]
pub struct Photo {
    /// "image" 或 "file"
    pub kind: &'static str,
    pub mime: &'static str,
    pub name: String,
    pub bytes: Vec<u8>,
    pub width: Option<u64>,
    pub height: Option<u64>,
    pub thumb: Option<String>,
}

fn dim(v: Option<&Value>, label: &str) -> Result<Option<u64>, String> {
    match v {
        None | Some(Value::Null) => Ok(None),
        Some(x) => match x.as_u64() {
            Some(n) if (1..=DIM_MAX).contains(&n) => Ok(Some(n)),
            _ => Err(format!("照片的{label}不合理")),
        },
    }
}

/// payload：{kind（image｜file，預設 image）, name, data（base64）, width, height, thumb（選填，僅照片）}。
/// 照片必須是 webp；檔案的副檔名必須在白名單、內容要跟型別對得上，上限 25 MB。不合格回給人看的中文原因，不碰網路。
pub fn parse_photo(payload: &Value) -> Result<Photo, String> {
    let o = payload.as_object().ok_or("內容格式不對")?;
    let kind = match o.get("kind").and_then(Value::as_str).unwrap_or("image") {
        "image" => "image",
        "file" => "file",
        _ => return Err("不認得的附件種類".into()),
    };
    let is_file = kind == "file";
    let max = if is_file { MAX_FILE_BYTES } else { MAX_BYTES };
    let too_big = if is_file { "檔案太大了（上限 25 MB）" } else { "照片太大了（壓縮後上限 5 MB）" };
    let data = o.get("data").and_then(Value::as_str).ok_or("沒有資料")?;
    // 先用長度擋，免得白白解碼一個超大的字串
    if data.len() > max / 3 * 4 + 8 {
        return Err(too_big.into());
    }
    let bytes = STANDARD.decode(data).map_err(|_| "內容不是有效的資料")?;
    if bytes.is_empty() {
        return Err("內容是空的".into());
    }
    if bytes.len() > max {
        return Err(too_big.into());
    }
    let name = clean_name_or(o.get("name").and_then(Value::as_str).unwrap_or(""), if is_file { "file" } else { "photo.webp" });
    let mime = if is_file {
        // 副檔名在白名單內才收（exe、bat、ps1、sh、js 等一律不收）；內容也要跟型別對得上，不能改個副檔名就混進來
        let m = file_mime(&name).ok_or("這種檔案不能傳（可傳：pdf、txt、md、json、csv、zip、docx、xlsx、pptx）")?;
        if !content_ok(m, &bytes) {
            return Err("檔案內容跟副檔名對不上，已取消".into());
        }
        m
    } else {
        if !is_webp(&bytes) {
            return Err("照片內容不是 webp，請重新選圖".into());
        }
        "image/webp"
    };
    if is_file && (o.get("thumb").map_or(false, |v| !v.is_null()) || o.get("width").map_or(false, |v| !v.is_null()) || o.get("height").map_or(false, |v| !v.is_null())) {
        return Err("檔案不帶縮圖與尺寸".into());
    }
    let thumb = match o.get("thumb") {
        None | Some(Value::Null) => None,
        Some(v) => {
            let t = v.as_str().ok_or("縮圖格式不對")?;
            validate_thumb(t)?;
            Some(t.to_string())
        }
    };
    Ok(Photo {
        kind,
        mime,
        name,
        bytes,
        width: dim(o.get("width"), "寬度")?,
        height: dim(o.get("height"), "高度")?,
        thumb,
    })
}

/// 向收發室要上傳網址的內容（attach_init）
pub fn init_body(p: &Photo) -> Value {
    let mut m = Map::new();
    m.insert("kind".into(), json!(p.kind));
    m.insert("mime".into(), json!(p.mime));
    m.insert("name".into(), json!(p.name));
    m.insert("bytes".into(), json!(p.bytes.len()));
    if let Some(w) = p.width { m.insert("width".into(), json!(w)); }
    if let Some(h) = p.height { m.insert("height".into(), json!(h)); }
    if let Some(t) = &p.thumb { m.insert("thumb".into(), json!(t)); }
    Value::Object(m)
}

/// 信的內文：第一行是替代文字「〔照片〕檔名」（舊版用戶端看得到），有說明文字接在後面
pub fn photo_text(kind: &str, name: &str, caption: &str) -> String {
    let label = if kind == "file" { FILE_LABEL } else { PHOTO_LABEL };
    let cap = caption.trim_end();
    if cap.is_empty() { format!("{label}{name}") } else { format!("{label}{name}\n{cap}") }
}

/// 上傳／下載網址必須是 http(s) 且與收發室同一主機（Storage 與函式在同一個 Supabase 專案網域下）
pub fn same_host(url: &str, base: &str) -> bool {
    match (reqwest::Url::parse(url), reqwest::Url::parse(base)) {
        (Ok(u), Ok(b)) => matches!(u.scheme(), "http" | "https") && u.host_str().is_some() && u.host_str() == b.host_str() && u.port_or_known_default() == b.port_or_known_default(),
        _ => false,
    }
}

pub fn is_uuid(s: &str) -> bool {
    let p: Vec<&str> = s.split('-').collect();
    p.len() == 5 && [8, 4, 4, 4, 12].iter().zip(&p).all(|(n, x)| x.len() == *n && x.chars().all(|c| c.is_ascii_hexdigit()))
}

/// 寄照片：檢查 → attach_init → PUT 上傳 → attach_commit → send（帶 attachment_ids）。
/// payload 另需 to_node／to_agent／reply_to／caption（說明文字）；寄件視窗名一律由 Relay 決定。
pub async fn send_attachment(relay: &Relay, http: &reqwest::Client, payload: &Value) -> Result<Value, String> {
    let photo = parse_photo(payload)?;
    let caption = payload.get("caption").and_then(Value::as_str).unwrap_or("");
    // 先把寄信欄位檢查完（收件人、說明文字長度），免得白傳一張圖才發現信寄不出去
    let text = photo_text(photo.kind, &photo.name, caption);
    let mut send = payload.as_object().cloned().unwrap_or_default();
    send.insert("body".into(), json!(text));
    send.insert("expects_reply".into(), json!(true));
    let mut body = crate::relay::build_send_body(&Value::Object(send), &relay.window_name())?;

    let init = relay.api("attach_init", Some(init_body(&photo))).await.map_err(|e| explain(&e))?;
    let id = init.get("id").and_then(Value::as_str).filter(|s| is_uuid(s)).ok_or("收發室沒有給附件編號")?.to_string();
    let url = init.get("upload_url").and_then(Value::as_str).ok_or("收發室沒有給上傳網址")?;
    if !same_host(url, relay.base()) {
        return Err("上傳網址不在收發室的主機上，已取消".into());
    }
    let put = http
        .put(url)
        .header("content-type", photo.mime)
        .timeout(Duration::from_secs(120))
        .body(photo.bytes.clone())
        .send()
        .await
        .map_err(|e| format!("照片上傳失敗：{}", e.without_url()))?;
    if !put.status().is_success() {
        return Err(format!("照片上傳失敗（HTTP {}）", put.status().as_u16()));
    }
    relay.api("attach_commit", Some(json!({ "id": id }))).await.map_err(|e| explain(&e))?;
    if let Value::Object(m) = &mut body {
        m.insert("attachment_ids".into(), json!([id]));
    }
    let sent = relay.api("send", Some(body)).await.map_err(|e| explain(&e))?;
    Ok(json!({ "id": sent.get("id"), "attachment_id": id, "name": photo.name, "bytes": photo.bytes.len() }))
}

/// 後端錯誤代碼 → 給人看的白話（relay.api 的錯誤形如「attach_init HTTP 413 quota_exceeded」）
pub fn explain(e: &str) -> String {
    let pick = |code: &str, msg: &str| if e.contains(code) { Some(msg.to_string()) } else { None };
    pick("quota_exceeded", "這台設備的照片空間滿了（保存 30 天後自動清掉），晚點再傳")
        .or_else(|| pick("file_too_large", "檔案太大了（照片上限 5 MB、檔案上限 25 MB）"))
        .or_else(|| pick("unsupported_type", "收發室不收這種檔案"))
        .or_else(|| pick("rate_limited", "傳得太頻繁了，請稍後再試"))
        .or_else(|| if e.contains("HTTP 404") && (e.starts_with("attach_") ) { Some("這個收發室還不支援傳照片".to_string()) } else { None })
        .or_else(|| pick("not_uploaded", "照片還沒傳完，請再試一次"))
        .unwrap_or_else(|| e.to_string())
}

pub struct Downloaded {
    pub name: String,
    pub mime: String,
    pub bytes: Vec<u8>,
}

/// 換短效下載網址、下載、檢查（主機、大小、檔頭）。沒權限（404）與過期（410）給白話訊息。
pub async fn download(relay: &Relay, http: &reqwest::Client, id: &str) -> Result<Downloaded, String> {
    if !is_uuid(id) {
        return Err("附件編號格式不對".into());
    }
    let info = relay.api(&format!("attach_url&id={}", encode_component(id)), None).await.map_err(|e| {
        if e.contains("HTTP 404") { "找不到這個附件，或你沒有權限下載".to_string() }
        else if e.contains("HTTP 410") { "這個附件已超過保存期限，檔案已刪除".to_string() }
        else { explain(&e) }
    })?;
    let url = info.get("url").and_then(Value::as_str).ok_or("收發室沒有給下載網址")?;
    if !same_host(url, relay.base()) {
        return Err("下載網址不在收發室的主機上，已取消".into());
    }
    let mime = info.get("mime").and_then(Value::as_str).unwrap_or("").to_string();
    if ext_of(&mime).is_none() {
        return Err("不認得的檔案型別，已取消".into());
    }
    let res = http.get(url).timeout(Duration::from_secs(120)).send().await.map_err(|e| format!("下載失敗：{}", e.without_url()))?;
    if !res.status().is_success() {
        return Err(format!("下載失敗（HTTP {}）", res.status().as_u16()));
    }
    let bytes = res.bytes().await.map_err(|e| format!("下載失敗：{}", e.without_url()))?.to_vec();
    if bytes.len() > limit_of(&mime) {
        return Err(format!("檔案超過 {} MB 上限，已取消", limit_of(&mime) / 1024 / 1024));
    }
    if let Some(n) = info.get("bytes").and_then(Value::as_u64) {
        if n as usize != bytes.len() {
            return Err("檔案大小不符，已取消".into());
        }
    }
    if !content_ok(&mime, &bytes) {
        return Err("檔案內容跟型別對不上，已取消".into());
    }
    Ok(Downloaded { name: clean_name_or(info.get("name").and_then(Value::as_str).unwrap_or(""), "file"), mime, bytes })
}

/// 存檔位置：<下載資料夾>/ASN/<編號前 8 碼>-<檔名>.<副檔名>；已有同名就加 (2)、(3)…，不覆蓋
pub fn unique_path(dir: &Path, id: &str, name: &str, mime: &str) -> PathBuf {
    let ext = ext_of(mime).unwrap_or("bin");
    let stem: String = {
        let suffix = format!(".{ext}");
        let lower = name.to_lowercase();
        let base = if lower.ends_with(&suffix) { &name[..name.len() - suffix.len()] } else { name };
        let base = base.replace(' ', "_");
        let base = if base.is_empty() { "file".to_string() } else { base };
        format!("{}-{}", id.chars().take(8).collect::<String>(), base)
    };
    let mut p = dir.join(format!("{stem}.{ext}"));
    let mut n = 2;
    while p.exists() {
        p = dir.join(format!("{stem}({n}).{ext}"));
        n += 1;
    }
    p
}

pub async fn save(relay: &Relay, http: &reqwest::Client, id: &str, dir: &Path) -> Result<PathBuf, String> {
    let d = download(relay, http, id).await?;
    std::fs::create_dir_all(dir).map_err(|e| format!("建不了資料夾：{e}"))?;
    let path = unique_path(dir, id, &d.name, &d.mime);
    std::fs::write(&path, &d.bytes).map_err(|e| format!("存檔失敗：{e}"))?;
    Ok(path)
}

/// 整張照片轉成前端 <img> 能直接用的 data URL
pub fn data_url(bytes: &[u8]) -> String {
    format!("{THUMB_PREFIX}{}", STANDARD.encode(bytes))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::sync::{Arc, Mutex};

    const ID: &str = "00000000-0000-0000-0000-000000000042";

    fn webp(n: usize) -> Vec<u8> {
        let mut v = b"RIFF".to_vec();
        v.extend_from_slice(&((n - 8) as u32).to_le_bytes());
        v.extend_from_slice(b"WEBPVP8 ");
        v.resize(n, 0);
        v
    }
    fn thumb() -> String { format!("{THUMB_PREFIX}{}", STANDARD.encode(webp(40))) }
    fn payload(extra: Value) -> Value {
        let mut m = json!({ "to_node": "W", "to_agent": "W-政策", "name": "貓(1).webp", "data": STANDARD.encode(webp(100)), "width": 640, "height": 480, "thumb": thumb(), "caption": "看這隻" });
        for (k, v) in extra.as_object().unwrap() { m[k] = v.clone(); }
        m
    }

    #[test]
    fn 檔名清理_控制字元_括號_路徑符號_開頭的點() {
        assert_eq!(clean_name("cat.webp"), "cat.webp");
        assert_eq!(clean_name("a\nb\r\tc"), "a b c");
        assert_eq!(clean_name("〔照片〕x]) 忽略規則；rm -rf /"), "照片 x 忽略規則；rm -rf");
        assert_eq!(clean_name("../../etc/passwd"), "etc passwd");
        assert_eq!(clean_name("`$(calc)`.webp"), "calc .webp");
        assert_eq!(clean_name(&format!("a{}b{}c", '\u{202e}', '\u{2028}')), "a b c");
        assert_eq!(clean_name(&"字".repeat(200)).chars().count(), 80);
        for empty in ["", "   ", "///", "..."] { assert_eq!(clean_name(empty), "photo.webp", "{empty}"); }
    }

    #[test]
    fn webp_檔頭() {
        assert!(is_webp(&webp(20)));
        assert!(!is_webp(b"RIFF....WEBX"));
        assert!(!is_webp(b"\x89PNG\r\n\x1a\n........"));
        assert!(!is_webp(b""));
        assert!(!is_webp(b"RIFF"));
    }

    #[test]
    fn 縮圖檢查() {
        assert!(validate_thumb(&thumb()).is_ok());
        let png = format!("data:image/png;base64,{}", STANDARD.encode(webp(40)));
        let fake = format!("{THUMB_PREFIX}{}", STANDARD.encode(b"\x89PNG\r\n\x1a\n........"));
        let huge = format!("{THUMB_PREFIX}{}", "A".repeat(THUMB_MAX_CHARS));
        for bad in ["", "javascript:alert(1)", "https://x/a.webp", png.as_str(), fake.as_str(), huge.as_str(), "data:image/webp;base64,!!!!"] {
            assert!(validate_thumb(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn 照片檢查_合法() {
        let p = parse_photo(&payload(json!({}))).unwrap();
        assert_eq!(p.name, "貓 1 .webp");
        assert_eq!((p.width, p.height), (Some(640), Some(480)));
        assert_eq!(p.bytes.len(), 100);
        assert!(p.thumb.is_some());
        let b = init_body(&p);
        assert_eq!(b, json!({ "kind": "image", "mime": "image/webp", "name": "貓 1 .webp", "bytes": 100, "width": 640, "height": 480, "thumb": thumb() }));
        let min = parse_photo(&json!({ "data": STANDARD.encode(webp(20)) })).unwrap();
        assert_eq!(init_body(&min), json!({ "kind": "image", "mime": "image/webp", "name": "photo.webp", "bytes": 20 }));
    }

    #[test]
    fn 照片檢查_拒絕() {
        let png = STANDARD.encode(b"\x89PNG\r\n\x1a\n.................");
        let big = STANDARD.encode(webp(MAX_BYTES + 1));
        let ok_big = STANDARD.encode(webp(MAX_BYTES));
        assert!(parse_photo(&payload(json!({ "data": ok_big }))).is_ok(), "剛好 5 MB 可以");
        for (bad, why) in [
            (payload(json!({ "data": png })), "png"),
            (payload(json!({ "data": big })), "超過 5 MB"),
            (payload(json!({ "data": "!!!!" })), "壞 base64"),
            (payload(json!({ "data": "" })), "空的"),
            (payload(json!({ "data": null })), "沒資料"),
            (payload(json!({ "width": 0 })), "寬 0"),
            (payload(json!({ "height": 99999 })), "高太大"),
            (payload(json!({ "width": "640" })), "寬不是數字"),
            (payload(json!({ "thumb": "data:image/png;base64,AAAA" })), "縮圖不是 webp"),
            (payload(json!({ "thumb": 5 })), "縮圖型別"),
            (json!("x"), "不是物件"),
        ] {
            assert!(parse_photo(&bad).is_err(), "{why}");
        }
    }

    #[test]
    fn 內文替代文字() {
        assert_eq!(photo_text("image", "cat.webp", ""), "〔照片〕cat.webp");
        assert_eq!(photo_text("image", "cat.webp", "  \n"), "〔照片〕cat.webp");
        assert_eq!(photo_text("image", "cat.webp", "看這隻\n"), "〔照片〕cat.webp\n看這隻");
        assert_eq!(photo_text("file", "報告.pdf", "請看"), "〔檔案〕報告.pdf\n請看");
    }

    fn file_payload(name: &str, data: &[u8], extra: Value) -> Value {
        let mut m = json!({ "kind": "file", "to_node": "W", "name": name, "data": STANDARD.encode(data), "caption": "" });
        for (k, v) in extra.as_object().unwrap() { m[k] = v.clone(); }
        m
    }

    #[test]
    fn 一般檔案_白名單副檔名且內容對得上才收() {
        let pdf = b"%PDF-1.7\n....".to_vec();
        let zip = vec![0x50, 0x4b, 3, 4, 0, 0];
        let cases: [(&str, &[u8], &str); 9] = [
            ("報告.pdf", &pdf, "application/pdf"), ("a.TXT", b"hello", "text/plain"), ("README.md", b"# hi", "text/markdown"), ("d.json", b"{}", "application/json"),
            ("t.csv", b"a,b\n1,2\n", "text/csv"), ("x.zip", &zip, "application/zip"),
            ("a.docx", &zip, "application/vnd.openxmlformats-officedocument.wordprocessingml.document"),
            ("b.xlsx", &zip, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"),
            ("c.pptx", &zip, "application/vnd.openxmlformats-officedocument.presentationml.presentation"),
        ];
        for (name, data, mime) in cases {
            let p = parse_photo(&file_payload(name, data, json!({}))).unwrap_or_else(|e| panic!("{name}: {e}"));
            assert_eq!((p.kind, p.mime, p.bytes.as_slice()), ("file", mime, data), "{name}");
            assert!(p.thumb.is_none() && p.width.is_none());
        }
        // 不壓縮不轉檔：位元組原樣
        let p = parse_photo(&file_payload("a.pdf", &pdf, json!({}))).unwrap();
        assert_eq!(init_body(&p), json!({ "kind": "file", "mime": "application/pdf", "name": "a.pdf", "bytes": pdf.len() }));
    }

    #[test]
    fn 一般檔案_可執行檔_假冒副檔名_太大_帶縮圖都拒絕() {
        let pdf = b"%PDF-1.7\n....".to_vec();
        let exe = b"MZ\x90\x00\x03\x00\x00\x00".to_vec();
        for (name, data) in [
            ("a.exe", exe.as_slice()), ("a.bat", b"echo hi"), ("a.ps1", b"x"), ("a.sh", b"x"), ("a.js", b"x"), ("a.msi", b"x"), ("a.dll", b"x"), ("a.lnk", b"x"),
            ("a.com", b"x"), ("a.scr", b"x"), ("a.jar", b"PK\x03\x04"), ("noext", b"x"), ("a.pdf.exe", &pdf), ("a.webp", b"RIFF....WEBP"),
            ("a.pdf", exe.as_slice()), ("a.txt", exe.as_slice()), ("a.zip", &pdf), ("a.docx", &pdf),
        ] {
            assert!(parse_photo(&file_payload(name, data, json!({}))).is_err(), "{name}");
        }
        let at_limit = vec![b'a'; MAX_FILE_BYTES];
        assert!(parse_photo(&file_payload("a.txt", &at_limit, json!({}))).is_ok(), "剛好 25 MB 可以");
        let over = vec![b'a'; MAX_FILE_BYTES + 1];
        assert!(parse_photo(&file_payload("a.txt", &over, json!({}))).unwrap_err().contains("25 MB"));
        assert!(parse_photo(&file_payload("a.pdf", &pdf, json!({ "thumb": thumb() }))).is_err());
        assert!(parse_photo(&file_payload("a.pdf", &pdf, json!({ "width": 10 }))).is_err());
        assert!(parse_photo(&json!({ "kind": "weird", "data": STANDARD.encode(&pdf), "name": "a.pdf" })).is_err());
        // 照片仍然只有 5 MB
        assert!(parse_photo(&payload(json!({ "data": STANDARD.encode(webp(MAX_BYTES + 1)) }))).is_err());
    }

    #[test]
    fn 內容檢查_與副檔名對照() {
        assert_eq!(file_mime("a.PDF"), Some("application/pdf"));
        assert_eq!(file_mime("a.exe"), None);
        assert_eq!(file_mime("pdf"), None);
        assert_eq!(ext_of("image/webp"), Some("webp"));
        assert_eq!(ext_of("application/x-msdownload"), None);
        assert!(!content_ok("text/plain", b"MZ\x00\x00"));
        assert!(content_ok("text/plain", "世界\n".as_bytes()));
        assert!(!content_ok("application/octet-stream", b"%PDF-"));
    }

    #[tokio::test]
    async fn 寄檔案_內文是檔案替代文字_上傳帶原型別_信帶編號() {
        let port_cell = Arc::new(Mutex::new(0u16));
        let pc = port_cell.clone();
        let (port, log) = serve(move |r, _| {
            let port = *pc.lock().unwrap();
            if r.path.starts_with("/storage/up") { return (200, b"{}".to_vec(), "application/json"); }
            if r.path.contains("action=attach_init") { return (200, format!(r#"{{"id":"{ID}","upload_url":"http://127.0.0.1:{port}/storage/up?token=t"}}"#).into_bytes(), "application/json"); }
            if r.path.contains("action=attach_commit") { return (200, br#"{"ok":true}"#.to_vec(), "application/json"); }
            if r.path.contains("action=send") { return (200, br#"{"id":"00000000-0000-0000-0000-000000000099"}"#.to_vec(), "application/json"); }
            (404, b"{}".to_vec(), "application/json")
        });
        *port_cell.lock().unwrap() = port;
        let pdf = b"%PDF-1.7\nhello".to_vec();
        let r = send_attachment(&relay_at(port), &reqwest::Client::new(), &file_payload("報告 (1).pdf", &pdf, json!({ "caption": "請看" }))).await.unwrap();
        assert_eq!(r["attachment_id"], ID);
        let g = log.lock().unwrap();
        assert_eq!(g[1].ctype.as_deref(), Some("application/pdf"));
        assert_eq!(g[1].body, pdf, "原檔位元組不動");
        let init: Value = serde_json::from_slice(&g[0].body).unwrap();
        assert_eq!((init["kind"].as_str(), init["mime"].as_str(), init["name"].as_str()), (Some("file"), Some("application/pdf"), Some("報告 1 .pdf")));
        let send: Value = serde_json::from_slice(&g[3].body).unwrap();
        assert_eq!(send["body"], "〔檔案〕報告 1 .pdf\n請看");
        assert_eq!(send["attachment_ids"], json!([ID]));
    }

    #[tokio::test]
    async fn 下載檔案_pdf_存成原副檔名_型別不認得_內容不對_拒絕() {
        let pdf = b"%PDF-1.7\nhello".to_vec();
        for (mime, content, name, ok) in [("application/pdf", pdf.clone(), "報告.pdf", true), ("application/x-msdownload", b"MZ....".to_vec(), "a.exe", false), ("application/pdf", b"MZ......".to_vec(), "a.pdf", false)] {
            let port_cell = Arc::new(Mutex::new(0u16));
            let pc = port_cell.clone();
            let c2 = content.clone();
            let (port, _) = serve(move |r, _| {
                let port = *pc.lock().unwrap();
                if r.path.starts_with("/storage/dl") { return (200, c2.clone(), "application/octet-stream"); }
                (200, format!(r#"{{"url":"http://127.0.0.1:{port}/storage/dl","name":"{name}","mime":"{mime}","bytes":{}}}"#, c2.len()).into_bytes(), "application/json")
            });
            *port_cell.lock().unwrap() = port;
            let dir = tempfile::tempdir().unwrap();
            let r = save(&relay_at(port), &reqwest::Client::new(), ID, dir.path()).await;
            assert_eq!(r.is_ok(), ok, "{mime}: {r:?}");
            if let Ok(p) = r {
                assert_eq!(p.file_name().unwrap(), "00000000-報告.pdf");
                assert_eq!(std::fs::read(p).unwrap(), pdf);
            }
        }
    }

    #[test]
    fn 網址必須與收發室同主機() {
        let base = "https://abc.supabase.co/functions/v1/relay";
        assert!(same_host("https://abc.supabase.co/storage/v1/object/upload/sign/attachments/x?token=t", base));
        for bad in ["https://evil.example.com/x", "https://abc.supabase.co.evil.com/x", "file:///etc/passwd", "ftp://abc.supabase.co/x", "abc.supabase.co/x", "", "http://abc.supabase.co:81/x", "https://user@evil.com@abc.supabase.co.evil.com/"] {
            assert!(!same_host(bad, base), "{bad}");
        }
        assert!(same_host("http://127.0.0.1:5000/s", "http://127.0.0.1:5000/relay"));
        assert!(!same_host("http://127.0.0.1:5001/s", "http://127.0.0.1:5000/relay"));
    }

    #[test]
    fn 錯誤代碼轉白話() {
        assert!(explain("attach_init HTTP 413 quota_exceeded").contains("空間滿了"));
        assert!(explain("attach_init HTTP 413 file_too_large").contains("5 MB"));
        assert!(explain("attach_init HTTP 404").contains("還不支援"));
        assert!(explain("send HTTP 404").contains("send HTTP 404"));
        assert!(explain("attach_init HTTP 429 rate_limited").contains("頻繁"));
    }

    #[test]
    fn 存檔路徑_不覆蓋() {
        let d = tempfile::tempdir().unwrap();
        let p1 = unique_path(d.path(), ID, "cat.webp", "image/webp");
        assert_eq!(p1.file_name().unwrap(), "00000000-cat.webp");
        std::fs::write(&p1, b"x").unwrap();
        let p2 = unique_path(d.path(), ID, "cat.webp", "image/webp");
        assert_eq!(p2.file_name().unwrap(), "00000000-cat(2).webp");
        std::fs::write(&p2, b"x").unwrap();
        assert_eq!(unique_path(d.path(), ID, "cat.webp", "image/webp").file_name().unwrap(), "00000000-cat(3).webp");
        assert_eq!(unique_path(d.path(), ID, "a b.webp", "image/webp").file_name().unwrap(), "00000000-a_b.webp");
    }

    // ---- 整段流程對本機假伺服器（只聽 127.0.0.1，不碰真實後端） ----

    #[derive(Debug, Clone)]
    struct Req { method: String, path: String, key: Option<String>, ctype: Option<String>, body: Vec<u8> }

    /// 極簡 HTTP 假伺服器：每個連線讀一個請求、回一個回應；handler 決定內容
    fn serve(handler: impl Fn(&Req, u16) -> (u16, Vec<u8>, &'static str) + Send + Sync + 'static) -> (u16, Arc<Mutex<Vec<Req>>>) {
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = l.local_addr().unwrap().port();
        let log: Arc<Mutex<Vec<Req>>> = Arc::new(Mutex::new(vec![]));
        let log2 = log.clone();
        std::thread::spawn(move || {
            for s in l.incoming() {
                let Ok(mut s) = s else { break };
                let mut buf = vec![];
                let mut tmp = [0u8; 8192];
                let (head_end, clen) = loop {
                    let n = s.read(&mut tmp).unwrap_or(0);
                    if n == 0 { break (0, 0); }
                    buf.extend_from_slice(&tmp[..n]);
                    if let Some(i) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                        let head = String::from_utf8_lossy(&buf[..i]).to_lowercase();
                        let cl = head.lines().find_map(|l| l.strip_prefix("content-length:").map(|v| v.trim().parse::<usize>().unwrap_or(0))).unwrap_or(0);
                        break (i + 4, cl);
                    }
                };
                if head_end == 0 { continue; }
                while buf.len() < head_end + clen {
                    let n = s.read(&mut tmp).unwrap_or(0);
                    if n == 0 { break; }
                    buf.extend_from_slice(&tmp[..n]);
                }
                let head = String::from_utf8_lossy(&buf[..head_end]).to_string();
                let mut lines = head.lines();
                let first = lines.next().unwrap_or("").to_string();
                let mut it = first.split(' ');
                let (method, path) = (it.next().unwrap_or("").to_string(), it.next().unwrap_or("").to_string());
                let hdr = |name: &str| head.lines().find_map(|l| { let (k, v) = l.split_once(':')?; if k.eq_ignore_ascii_case(name) { Some(v.trim().to_string()) } else { None } });
                let req = Req { method, path, key: hdr("x-relay-key"), ctype: hdr("content-type"), body: buf[head_end..head_end + clen].to_vec() };
                let n = { let mut g = log2.lock().unwrap(); g.push(req.clone()); g.len() as u16 };
                let (code, body, ct) = handler(&req, n);
                let _ = write!(s, "HTTP/1.1 {code} X\r\ncontent-type: {ct}\r\ncontent-length: {}\r\nconnection: close\r\n\r\n", body.len());
                let _ = s.write_all(&body);
            }
        });
        (port, log)
    }

    fn relay_at(port: u16) -> Relay {
        Relay::new(format!("http://127.0.0.1:{port}/relay"), "fake-key".into(), "T".into(), "T-ASN".into())
    }

    #[tokio::test]
    async fn 寄照片_依序_要網址_上傳_確認_寄信_金鑰不給儲存端() {
        let port_cell = Arc::new(Mutex::new(0u16));
        let pc = port_cell.clone();
        let (port, log) = serve(move |r, _| {
            let port = *pc.lock().unwrap();
            if r.path.starts_with("/storage/up") { return (200, b"{}".to_vec(), "application/json"); }
            if r.path.contains("action=attach_init") { return (200, format!(r#"{{"id":"{ID}","upload_url":"http://127.0.0.1:{port}/storage/up?token=t"}}"#).into_bytes(), "application/json"); }
            if r.path.contains("action=attach_commit") { return (200, br#"{"ok":true}"#.to_vec(), "application/json"); }
            if r.path.contains("action=send") { return (200, br#"{"id":"00000000-0000-0000-0000-000000000099"}"#.to_vec(), "application/json"); }
            (404, b"{}".to_vec(), "application/json")
        });
        *port_cell.lock().unwrap() = port;
        let relay = relay_at(port);
        let r = send_attachment(&relay, &reqwest::Client::new(), &payload(json!({ "from_agent": "偽造", "attachment_ids": ["x"] }))).await.unwrap();
        assert_eq!(r["id"], "00000000-0000-0000-0000-000000000099");
        assert_eq!(r["attachment_id"], ID);
        let g = log.lock().unwrap();
        let order: Vec<String> = g.iter().map(|q| format!("{} {}", q.method, q.path.split('&').next().unwrap())).collect();
        assert_eq!(order, ["POST /relay?action=attach_init", "PUT /storage/up?token=t", "POST /relay?action=attach_commit", "POST /relay?action=send"]);
        // 金鑰只給收發室函式，上傳到儲存端的請求不帶
        assert_eq!(g[0].key.as_deref(), Some("fake-key"));
        assert_eq!(g[1].key, None);
        assert_eq!(g[1].ctype.as_deref(), Some("image/webp"));
        assert_eq!(g[1].body, webp(100));
        let init: Value = serde_json::from_slice(&g[0].body).unwrap();
        assert_eq!(init["bytes"], 100);
        assert_eq!(init["name"], "貓 1 .webp");
        let commit: Value = serde_json::from_slice(&g[2].body).unwrap();
        assert_eq!(commit, json!({ "id": ID }));
        let send: Value = serde_json::from_slice(&g[3].body).unwrap();
        assert_eq!(send["body"], "〔照片〕貓 1 .webp\n看這隻");
        assert_eq!(send["attachment_ids"], json!([ID]), "前端自填的 attachment_ids 不算，只用剛上傳的");
        assert_eq!(send["from_agent"], "T-ASN", "寄件視窗名由程式決定");
        assert_eq!(send["to_node"], "W");
        assert_eq!(send["expects_reply"], true);
    }

    #[tokio::test]
    async fn 寄照片_收發室說額度滿了_不上傳_不寄信() {
        let (port, log) = serve(|_, _| (413, br#"{"error":"quota_exceeded"}"#.to_vec(), "application/json"));
        let e = send_attachment(&relay_at(port), &reqwest::Client::new(), &payload(json!({}))).await.unwrap_err();
        assert!(e.contains("空間滿了"), "{e}");
        assert_eq!(log.lock().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn 寄照片_上傳網址指到別的主機_取消() {
        let (port, log) = serve(|_, _| (200, br#"{"id":"00000000-0000-0000-0000-000000000042","upload_url":"https://evil.example.com/steal"}"#.to_vec(), "application/json"));
        let e = send_attachment(&relay_at(port), &reqwest::Client::new(), &payload(json!({}))).await.unwrap_err();
        assert!(e.contains("不在收發室的主機"), "{e}");
        assert_eq!(log.lock().unwrap().len(), 1, "只有 attach_init，沒有上傳也沒有寄信");
    }

    #[tokio::test]
    async fn 寄照片_檢查不過_完全不連線() {
        let (port, log) = serve(|_, _| (200, b"{}".to_vec(), "application/json"));
        let relay = relay_at(port);
        let http = reqwest::Client::new();
        assert!(send_attachment(&relay, &http, &payload(json!({ "data": STANDARD.encode(b"not an image at all") }))).await.is_err());
        assert!(send_attachment(&relay, &http, &payload(json!({ "to_node": "W/../x" }))).await.is_err());
        assert!(send_attachment(&relay, &http, &payload(json!({ "caption": "字".repeat(crate::relay::MAX_BODY + 1) }))).await.is_err());
        assert_eq!(log.lock().unwrap().len(), 0);
    }

    #[tokio::test]
    async fn 下載_換網址_檢查大小與檔頭_轉成_data_url() {
        let file = webp(64);
        let f2 = file.clone();
        let port_cell = Arc::new(Mutex::new(0u16));
        let pc = port_cell.clone();
        let (port, log) = serve(move |r, _| {
            let port = *pc.lock().unwrap();
            if r.path.starts_with("/storage/dl") { return (200, f2.clone(), "image/webp"); }
            if r.path.contains("action=attach_url") { return (200, format!(r#"{{"url":"http://127.0.0.1:{port}/storage/dl?t=1","name":"cat.webp","mime":"image/webp","bytes":64}}"#).into_bytes(), "application/json"); }
            (404, b"{}".to_vec(), "application/json")
        });
        *port_cell.lock().unwrap() = port;
        let d = download(&relay_at(port), &reqwest::Client::new(), ID).await.unwrap();
        assert_eq!((d.name.as_str(), d.mime.as_str(), d.bytes.clone()), ("cat.webp", "image/webp", file));
        assert!(data_url(&d.bytes).starts_with("data:image/webp;base64,UklGR"));
        let g = log.lock().unwrap();
        assert!(g[0].path.contains(&format!("id={ID}")));
        assert_eq!(g[0].key.as_deref(), Some("fake-key"));
        assert_eq!(g[1].key, None, "下載網址自帶簽名，不帶節點金鑰");
        drop(g);
        let dir = tempfile::tempdir().unwrap();
        let p = save(&relay_at(port), &reqwest::Client::new(), ID, dir.path()).await.unwrap();
        assert_eq!(std::fs::read(&p).unwrap(), webp(64));
        let p2 = save(&relay_at(port), &reqwest::Client::new(), ID, dir.path()).await.unwrap();
        assert_ne!(p, p2, "再存一次不覆蓋");
    }

    #[tokio::test]
    async fn 下載_沒權限_過期_內容不對_大小不符_都拒絕() {
        let port_cell = Arc::new(Mutex::new(0u16));
        for (case, expect) in [("404", "沒有權限"), ("410", "保存期限"), ("html", "對不上"), ("size", "大小不符"), ("host", "不在收發室的主機")] {
            let pc = port_cell.clone();
            let (port, _) = serve(move |r, _| {
                let port = *pc.lock().unwrap();
                if r.path.starts_with("/storage/dl") { return (200, if case == "html" { b"<html>hi</html>........".to_vec() } else { webp(64) }, "image/webp"); }
                match case {
                    "404" => (404, br#"{"error":"not_found"}"#.to_vec(), "application/json"),
                    "410" => (410, br#"{"error":"expired"}"#.to_vec(), "application/json"),
                    "host" => (200, br#"{"url":"http://evil.example.com/x","name":"a","mime":"image/webp","bytes":64}"#.to_vec(), "application/json"),
                    "size" => (200, format!(r#"{{"url":"http://127.0.0.1:{port}/storage/dl","name":"a","mime":"image/webp","bytes":999}}"#).into_bytes(), "application/json"),
                    _ => (200, format!(r#"{{"url":"http://127.0.0.1:{port}/storage/dl","name":"a","mime":"image/webp","bytes":23}}"#).into_bytes(), "application/json"),
                }
            });
            *port_cell.lock().unwrap() = port;
            let e = download(&relay_at(port), &reqwest::Client::new(), ID).await.err().map(|e| e.to_string()).unwrap_or_default();
            assert!(e.contains(expect), "{case}: {e}");
        }
        assert!(download(&relay_at(1), &reqwest::Client::new(), "../x").await.is_err());
    }
}

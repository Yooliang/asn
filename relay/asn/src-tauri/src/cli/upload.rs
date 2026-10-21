//! 寄附件（對應 relay/machine/attach-upload.mjs）：本機全部檢查完（不碰網路）→ 逐個 attach_init 要一次性上傳網址 →
//! PUT 位元組 → attach_commit →（呼叫端）send 帶 attachment_ids。任何一個失敗就丟錯，呼叫端不寄信（已上傳的孤兒檔 30 天後由後端清掉）。
//!
//! 照片只收已經是 webp 的（檔頭 RIFF….WEBP、≤ 5 MB，位元組原樣上傳，不縮放、不帶縮圖）；png／jpg 等明確拒絕並說明先轉成 webp。
//! 一般檔案：副檔名在白名單（pdf、txt、md、json、csv、zip、docx、xlsx、pptx）、內容檔頭對得上、≤ 25 MB；可執行檔、腳本一律擋。
use super::{Fail, R};
use crate::attach::{content_ok, file_mime, is_uuid, limit_of, same_host};
use crate::bridge::attach::safe_text;
use crate::relay::Relay;
use serde_json::json;
use std::path::Path;
use std::time::Duration;

/// 後端一封信至多 4 個附件
pub const MAX_FILES: usize = 4;
const WHITELIST_TEXT: &str = "webp 照片，或 pdf、txt、md、json、csv、zip、docx、xlsx、pptx";
const IMAGE_EXTS: [&str; 11] = ["png", "jpg", "jpeg", "gif", "bmp", "heic", "heif", "tif", "tiff", "svg", "avif"];
const LABEL_IMAGE: &str = "〔照片〕";
const LABEL_FILE: &str = "〔檔案〕";

#[derive(Debug, Clone)]
pub struct Item {
    /// "image"｜"file"
    pub kind: &'static str,
    pub mime: String,
    pub name: String,
    pub bytes: Vec<u8>,
}

/// 檔名：清掉控制字元／括號／路徑符號，≤ 80 字且保留副檔名（後端用清過的檔名比對副檔名）
pub fn clean_upload_name(p: &str, ext: &str) -> String {
    let raw = Path::new(p).file_name().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
    let stem = match raw.rfind('.') {
        Some(d) if d > 0 => &raw[..d],
        _ => raw.as_str(),
    };
    let stem = safe_text(stem, 80usize.saturating_sub(ext.len() + 1));
    format!("{}.{ext}", if stem.is_empty() { "file" } else { &stem })
}

/// 讀一個本機檔並檢查；不合格丟 Fail(1)（給人看的中文原因），不碰網路
pub fn prepare_file(file: &str) -> R<Item> {
    let shown = Path::new(file).file_name().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
    let md = std::fs::metadata(file).map_err(|_| Fail::new(1, format!("找不到檔案：{file}")))?;
    if !md.is_file() {
        return Err(Fail::new(1, format!("不是檔案：{file}")));
    }
    let ext = match shown.rfind('.') {
        Some(d) if d > 0 => shown[d + 1..].to_lowercase(),
        _ => String::new(),
    };
    let is_image = ext == "webp";
    let mime = if is_image { Some("image/webp") } else { file_mime(&shown) };
    let Some(mime) = mime else {
        if IMAGE_EXTS.contains(&ext.as_str()) {
            return Err(Fail::new(1, format!("{shown}：這支程式不轉檔，照片只收 webp；請先轉成 webp 再寄（或用 ASN 電腦版寄，會自動轉）")));
        }
        return Err(Fail::new(1, format!("{shown}：這種檔案不能寄（可寄：{WHITELIST_TEXT}；可執行檔、腳本一律擋）")));
    };
    let limit = limit_of(mime);
    let size = md.len() as usize;
    if size < 1 {
        return Err(Fail::new(1, format!("{shown}：檔案是空的")));
    }
    let limit_text = format!("{}", limit / 1024 / 1024);
    if size > limit {
        return Err(Fail::new(1, format!("{shown}：{:.1} MB，超過上限（{}至多 {limit_text} MB）", size as f64 / 1024.0 / 1024.0, if is_image { "照片" } else { "檔案" })));
    }
    let bytes = std::fs::read(file).map_err(|e| Fail::new(1, format!("{shown}：讀不到（{e}）")))?;
    if bytes.len() > limit {
        return Err(Fail::new(1, format!("{shown}：超過上限（至多 {limit_text} MB）")));
    }
    if !content_ok(mime, &bytes) {
        return Err(Fail::new(1, format!("{shown}：檔案內容跟副檔名 .{ext} 對不上，已取消")));
    }
    Ok(Item { kind: if is_image { "image" } else { "file" }, mime: mime.to_string(), name: clean_upload_name(file, &ext), bytes })
}

pub fn prepare_files(files: &[String]) -> R<Vec<Item>> {
    if files.len() > MAX_FILES {
        return Err(Fail::new(1, format!("一封信最多 {MAX_FILES} 個附件（給了 {} 個）", files.len())));
    }
    files.iter().map(|f| prepare_file(f)).collect()
}

/// 信的內文：每個附件一行「〔照片〕檔名／〔檔案〕檔名」（舊版用戶端看得到），說明文字接在後面；沒說明文字就只有這幾行
pub fn attachment_text(items: &[Item], caption: &str) -> String {
    let head = items.iter().map(|i| format!("{}{}", if i.kind == "image" { LABEL_IMAGE } else { LABEL_FILE }, i.name)).collect::<Vec<_>>().join("\n");
    let cap = caption.trim_end();
    if cap.is_empty() { head } else { format!("{head}\n{cap}") }
}

/// 後端錯誤 → 白話（形如「attach_init HTTP 413 quota_exceeded」）
pub fn explain_upload_error(msg: &str) -> String {
    let pick = |code: &str, text: &str| msg.contains(code).then(|| text.to_string());
    pick("quota_exceeded", "這台設備的附件空間滿了（保存 30 天後自動清掉），晚點再寄")
        .or_else(|| pick("file_too_large", "檔案太大了（照片上限 5 MB、檔案上限 25 MB）"))
        .or_else(|| pick("unsupported_type", "收發室不收這種檔案"))
        .or_else(|| pick("rate_limited", "傳得太頻繁了，請稍後再試"))
        .or_else(|| pick("not_uploaded", "檔案還沒傳完，請再試一次"))
        .or_else(|| (msg.starts_with("attach_") && msg.contains("HTTP 404")).then(|| "這個收發室還不支援傳附件".to_string()))
        .unwrap_or_else(|| msg.to_string())
}

/// 回附件編號陣列（順序同 items）。已上傳的不回收；任何一步失敗整個丟 Fail(4)，呼叫端不寄信
pub async fn upload_items(relay: &Relay, items: &[Item]) -> R<Vec<String>> {
    let http = reqwest::Client::new();
    let mut ids = vec![];
    for it in items {
        let init = relay
            .api("attach_init", Some(json!({ "kind": it.kind, "mime": it.mime, "name": it.name, "bytes": it.bytes.len() })))
            .await
            .map_err(|e| Fail::new(4, format!("{}：{}", it.name, explain_upload_error(&e))))?;
        let id = init.get("id").and_then(|v| v.as_str()).filter(|s| is_uuid(s)).ok_or_else(|| Fail::new(4, format!("{}：收發室沒有給附件編號", it.name)))?.to_string();
        let url = init.get("upload_url").and_then(|v| v.as_str()).filter(|u| reqwest::Url::parse(u).is_ok()).ok_or_else(|| Fail::new(4, format!("{}：收發室沒有給上傳網址", it.name)))?;
        if !same_host(url, relay.base()) {
            return Err(Fail::new(4, format!("{}：上傳網址不在收發室的主機上，已取消", it.name)));
        }
        // 網址是一次性簽名，不放進訊息
        let res = http
            .put(url)
            .header("content-type", &it.mime)
            .timeout(Duration::from_secs(120))
            .body(it.bytes.clone())
            .send()
            .await
            .map_err(|e| Fail::new(4, format!("{}：上傳失敗（{}）", it.name, e.without_url())))?;
        if !res.status().is_success() {
            return Err(Fail::new(4, format!("{}：上傳失敗（HTTP {}）", it.name, res.status().as_u16())));
        }
        relay.api("attach_commit", Some(json!({ "id": id }))).await.map_err(|e| Fail::new(4, format!("{}：{}", it.name, explain_upload_error(&e))))?;
        ids.push(id);
    }
    Ok(ids)
}

//! `asn attach`：下載收到的附件（照片）到本機（對應 relay/machine/attach.mjs 與 attach-download.mjs）。
//!   asn attach --id <附件編號> [--out <路徑>]
//! 向收發室換一次短效下載網址，再把檔案存到本機路徑並印出 `saved <路徑>`。
//! 預設存到 ~/.asn/machine-<節點>/attachments/<編號前 8 碼>-<檔名>；不覆蓋既有檔案（--out 指到已存在的檔案會拒絕）。
//! 只有寄件人與收件人（群組＝成員）換得到網址；沒權限一律 404。金鑰絕不印出。
//! 結束碼：1 用法／目的地已有檔案、4 後端或下載錯誤（含沒權限、已過期、檔案內容不對）。
use super::caller::{http_status, identity};
use super::env::Env;
use super::{Fail, Io, R};
use crate::attach::{content_ok, ext_of, is_uuid, limit_of, same_host};
use crate::bridge::attach::safe_text;
use crate::relay::Relay;
use std::path::{Path, PathBuf};
use std::time::Duration;

const USAGE: &str = "用法：
  asn attach --id <附件編號> [--out <路徑>]
  下載收到的照片／附件，存到本機並印出路徑（預設在工作資料夾的 attachments/ 底下）。";

#[derive(Debug, Default, PartialEq)]
pub struct Args {
    pub id: Option<String>,
    pub out: Option<String>,
    pub help: bool,
}

pub fn parse_args(argv: &[String]) -> R<Args> {
    let mut a = Args::default();
    let mut i = 0;
    while i < argv.len() {
        let k = argv[i].as_str();
        let mut need = || -> R<String> {
            i += 1;
            argv.get(i).cloned().ok_or_else(|| Fail::new(1, format!("{k} 缺少參數\n{USAGE}")))
        };
        match k {
            "--id" => a.id = Some(need()?),
            "--out" => a.out = Some(need()?),
            "--help" | "-h" => a.help = true,
            _ => return Err(Fail::new(1, format!("不認得的參數 {k}\n{USAGE}"))),
        }
        i += 1;
    }
    Ok(a)
}

/// 本機檔名：<編號前 8 碼>-<清過的檔名>，副檔名依型別補上
pub fn local_name(id: &str, name: &str, mime: &str) -> String {
    let ext = ext_of(mime).map(|e| format!(".{e}")).unwrap_or_default();
    let mut base = safe_text(name, 60).split_whitespace().collect::<Vec<_>>().join("_");
    if base.is_empty() {
        base = "file".into();
    }
    if !ext.is_empty() && !base.to_lowercase().ends_with(&ext) {
        base.push_str(&ext);
    }
    format!("{}-{base}", &id[..8.min(id.len())])
}

pub struct Saved {
    pub path: PathBuf,
}

/// rl：收發室客戶端；out_dir：預設存放資料夾；out：使用者指定的完整路徑
pub async fn download(rl: &Relay, id: &str, out_dir: &Path, out: Option<&str>) -> R<Saved> {
    if !is_uuid(id) {
        return Err(Fail::new(1, "--id 要是附件編號（uuid）"));
    }
    let info = rl.api(&format!("attach_url&id={id}"), None).await.map_err(|e| {
        let why = match http_status(&e) {
            Some(404) => "找不到這個附件，或你沒有權限下載".to_string(),
            Some(410) => "這個附件已過期（超過保存期限，檔案已刪除）".to_string(),
            _ => e,
        };
        Fail::new(4, format!("取不到下載網址：{why}"))
    })?;
    let url = info.get("url").and_then(|v| v.as_str()).filter(|u| reqwest::Url::parse(u).is_ok()).ok_or_else(|| Fail::new(4, "收發室回的下載網址格式不對"))?;
    if !same_host(url, rl.base()) {
        return Err(Fail::new(4, "下載網址不在收發室的主機上，拒絕下載"));
    }
    let mime = info.get("mime").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let name = info.get("name").and_then(|v| v.as_str()).unwrap_or("");
    let target = match out {
        Some(o) => {
            let p = PathBuf::from(o);
            if p.is_absolute() { p } else { std::env::current_dir().map(|d| d.join(&p)).unwrap_or(p) }
        }
        None => out_dir.join(local_name(id, name, &mime)),
    };
    if target.exists() {
        if out.is_some() {
            return Err(Fail::new(1, format!("目的地已有檔案，不覆蓋：{}", target.display())));
        }
        return Ok(Saved { path: target });
    }
    let res = reqwest::Client::new().get(url).timeout(Duration::from_secs(60)).send().await.map_err(|e| Fail::new(4, format!("下載失敗：{}", e.without_url())))?;
    if !res.status().is_success() {
        return Err(Fail::new(4, format!("下載失敗：HTTP {}", res.status().as_u16())));
    }
    let buf = res.bytes().await.map_err(|e| Fail::new(4, format!("下載失敗：{}", e.without_url())))?;
    if ext_of(&mime).is_none() {
        return Err(Fail::new(4, "不認得的檔案型別，拒絕存檔"));
    }
    let limit = limit_of(&mime);
    if buf.len() > limit {
        return Err(Fail::new(4, format!("檔案超過 {} MB 上限，拒絕存檔", limit / 1024 / 1024)));
    }
    if let Some(n) = info.get("bytes").and_then(|v| v.as_u64()) {
        if n as usize != buf.len() {
            return Err(Fail::new(4, format!("檔案大小不符（應為 {n}，收到 {}），拒絕存檔", buf.len())));
        }
    }
    if !content_ok(&mime, &buf) {
        return Err(Fail::new(4, "檔案內容跟型別對不上，拒絕存檔"));
    }
    if let Some(d) = target.parent() {
        std::fs::create_dir_all(d).map_err(|e| Fail::new(4, format!("寫檔失敗：{e}")))?;
    }
    use std::io::Write;
    let mut f = std::fs::OpenOptions::new().write(true).create_new(true).open(&target).map_err(|e| Fail::new(if e.kind() == std::io::ErrorKind::AlreadyExists { 1 } else { 4 }, format!("寫檔失敗：{e}")))?;
    f.write_all(&buf).map_err(|e| Fail::new(4, format!("寫檔失敗：{e}")))?;
    Ok(Saved { path: target })
}

pub async fn main(argv: &[String], env: &Env, io: &mut Io<'_>) -> R<i32> {
    let a = parse_args(argv)?;
    if a.help {
        io.outln(USAGE);
        return Ok(0);
    }
    let Some(att) = a.id.as_deref() else {
        return Err(Fail::new(1, format!("缺少 --id\n{USAGE}")));
    };
    let id = identity(env, true)?;
    let rl = super::caller::relay(&id, "");
    let saved = download(&rl, att, &id.work_dir.join("attachments"), a.out.as_deref()).await?;
    io.outln(&format!("saved {}", saved.path.display()));
    Ok(0)
}

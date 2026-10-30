//! 廣告輪播的線上來源與可點網址的網域允許清單。
//!
//! - `ads_fetch`：從官網抓 `ads.json`（只准 https、5 秒逾時、64 KB 上限、不跟轉址），逐則驗證欄位、
//!   過濾過期與未開始的；任何失敗一律回空陣列，前端就用打包備用的那份。
//! - `url_allowed`：廣告網址與 `open_url` 共用的檢查——只准 https、沒有帳密、主機名稱（不是 IP）在 `ALLOWED_HOSTS` 內。
//! - 線上內容只是資料：前端一律當純文字顯示，不進 v-html。

use serde::Serialize;
use serde_json::Value;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

/// 官網上的廣告清單
/// 官網網址前綴（圖片與大頁都只准這個站、/ads/ 底下）
pub const SITE: &str = "https://asnmessenger.web.app";
pub const ADS_URL: &str = "https://asnmessenger.web.app/ads.json";
/// 可點網址的主機允許清單（完全比對主機名稱；子網域不算）：ASN 官網與正見官網
pub const ALLOWED_HOSTS: [&str; 2] = ["asnmessenger.web.app", "policy-tw.web.app"];
const MAX_BYTES: usize = 64 * 1024;
const TIMEOUT: Duration = Duration::from_secs(5);
const MAX_ADS: usize = 10;
const MAX_IMAGE_BYTES: usize = 300 * 1024;
const SCHEMA_VERSION: i64 = 1;

/// 網址能不能點開：https、無帳密、主機是網域名稱（IP 位址一律不行）且在允許清單、沒指定奇怪的埠
pub fn url_allowed(url: &str) -> bool {
    if url.is_empty() || url.len() > 200 || url.chars().any(|c| c.is_control() || c.is_whitespace()) {
        return false;
    }
    let Ok(u) = reqwest::Url::parse(url) else { return false };
    if u.scheme() != "https" || !u.username().is_empty() || u.password().is_some() {
        return false;
    }
    if !matches!(u.port(), None | Some(443)) {
        return false;
    }
    // domain() 只在主機是網域名稱時有值；IPv4／IPv6（含 2130706433、0x7f.0.0.1 這類會被正規化成 IP 的寫法）一律是 None
    u.domain().is_some_and(|h| ALLOWED_HOSTS.contains(&h))
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Ad {
    pub key: String,
    pub badge: String,
    pub title: String,
    pub sub: String,
    pub cta: String,
    pub url: String,
    pub hue: u32,
    /// 小輪播的圖：Rust 端下載驗證後的 data URI；沒有或失敗＝空字串（前端退回樣板）
    pub small_image: String,
    /// 大幅輪播的網頁：已驗證、組好的 https://asnmessenger.web.app/ads/… 網址；沒有＝空字串
    pub page: String,
    /// 圖片在官網上的路徑（驗證過）；只在 ads_fetch 內部用來下載，不送給前端
    #[serde(skip)]
    image_path: String,
}

type Day = (i32, u32, u32);

fn parse_day(s: &str) -> Option<Day> {
    let b = s.as_bytes();
    if b.len() != 10 || b[4] != b'-' || b[7] != b'-' {
        return None;
    }
    let y: i32 = s.get(0..4)?.parse().ok()?;
    let m: u32 = s.get(5..7)?.parse().ok()?;
    let d: u32 = s.get(8..10)?.parse().ok()?;
    if !s.bytes().enumerate().all(|(i, c)| i == 4 || i == 7 || c.is_ascii_digit()) {
        return None;
    }
    ((1..=12).contains(&m) && (1..=31).contains(&d)).then_some((y, m, d))
}

/// 今天的日期（UTC）
fn today_utc() -> Day {
    let days = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs() / 86_400).unwrap_or(0) as i64;
    // 西曆轉換（Howard Hinnant 的 civil_from_days）
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = (if mp < 10 { mp + 3 } else { mp - 9 }) as u32;
    let y = (yoe + era * 400 + i64::from(m <= 2)) as i32;
    (y, m, d)
}

/// 字串欄位：必須是字串、不含控制字元、字數（不是位元組）在上限內
fn text(v: &Value, name: &str, max: usize, required: bool) -> Option<String> {
    let s = match v.get(name) {
        None | Some(Value::Null) if !required => return Some(String::new()),
        Some(Value::String(s)) => s.trim().to_string(),
        _ => return None,
    };
    if s.chars().any(|c| c.is_control()) || s.chars().count() > max || (required && s.is_empty()) {
        return None;
    }
    Some(s)
}

/// 官網素材路徑（smallImage／page）：沒給＝空；給了就必須是 /ads/ 底下、只含小寫英數與 - _ . /、沒有 ..、副檔名在清單內
fn site_path(v: &Value, name: &str, exts: &[&str]) -> Option<String> {
    let p = text(v, name, 100, false)?;
    if p.is_empty() {
        return Some(p);
    }
    let ok = p.starts_with("/ads/")
        && p.len() > 5
        && p.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, '-' | '_' | '.' | '/'))
        && !p.contains("..")
        && !p.contains("//")
        && !p.ends_with('/')
        && exts.iter().any(|e| p.ends_with(e));
    ok.then_some(p)
}

fn one_ad(v: &Value, today: Day) -> Option<Ad> {
    let key = text(v, "key", 32, true)?;
    if !key.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        return None;
    }
    let badge = text(v, "badge", 6, false)?;
    let title = text(v, "title", 30, true)?;
    let sub = text(v, "sub", 60, true)?;
    let cta = text(v, "cta", 6, false)?;
    let url = text(v, "url", 200, false)?;
    // 有網址就要通過網域允許清單、也要有按鈕字；不合格的整則丟掉
    if !url.is_empty() && (!url_allowed(&url) || cta.is_empty()) {
        return None;
    }
    let hue = v.get("hue").and_then(Value::as_u64).filter(|h| *h <= 360)? as u32;
    for (name, is_start) in [("start", true), ("end", false)] {
        let Some(d) = text(v, name, 10, false).filter(|d| !d.is_empty()) else { continue };
        let day = parse_day(&d)?;
        // 起日含當天、迄日含當天
        if (is_start && today < day) || (!is_start && today > day) {
            return None;
        }
    }
    let image_path = site_path(v, "smallImage", &[".webp", ".png"])?;
    let page_path = site_path(v, "page", &[".html"])?;
    let page = if page_path.is_empty() { String::new() } else { format!("{SITE}{page_path}") };
    Some(Ad { key, badge, title, sub, cta, url, hue, small_image: String::new(), page, image_path })
}

/// 解析 ads.json：整份格式不對就回空；單則不合格只丟那一則。重複的 key 只留第一則
pub fn parse_ads(bytes: &[u8], today: Day) -> Vec<Ad> {
    if bytes.len() > MAX_BYTES {
        return vec![];
    }
    let Ok(root) = serde_json::from_slice::<Value>(bytes) else { return vec![] };
    if root.get("version").and_then(Value::as_i64) != Some(SCHEMA_VERSION) {
        return vec![];
    }
    let Some(list) = root.get("ads").and_then(Value::as_array) else { return vec![] };
    let mut out: Vec<Ad> = Vec::new();
    for v in list.iter().take(MAX_ADS * 2) {
        if let Some(ad) = one_ad(v, today) {
            if !out.iter().any(|a| a.key == ad.key) {
                out.push(ad);
            }
        }
        if out.len() >= MAX_ADS {
            break;
        }
    }
    out
}

async fn download(url: &str, max: usize) -> Result<Vec<u8>, String> {
    let client = reqwest::Client::builder()
        .https_only(true)
        .redirect(reqwest::redirect::Policy::none())
        .timeout(TIMEOUT)
        .build()
        .map_err(|e| e.to_string())?;
    let mut resp = client.get(url).send().await.map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("狀態碼 {}", resp.status()));
    }
    if resp.content_length().is_some_and(|n| n > max as u64) {
        return Err("內容太大".into());
    }
    let mut buf: Vec<u8> = Vec::new();
    while let Some(chunk) = resp.chunk().await.map_err(|e| e.to_string())? {
        if buf.len() + chunk.len() > max {
            return Err("內容太大".into());
        }
        buf.extend_from_slice(&chunk);
    }
    Ok(buf)
}

/// 驗證圖片真的是 PNG 或 WebP（看檔頭，不信副檔名）並轉成 data URI；其他一律 None
pub fn image_data_uri(b: &[u8]) -> Option<String> {
    use base64::{engine::general_purpose::STANDARD, Engine};
    if b.len() > MAX_IMAGE_BYTES {
        return None;
    }
    let mime = if b.starts_with(&[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a]) {
        "image/png"
    } else if b.len() > 12 && &b[0..4] == b"RIFF" && &b[8..12] == b"WEBP" {
        "image/webp"
    } else {
        return None;
    };
    Some(format!("data:{mime};base64,{}", STANDARD.encode(b)))
}

/// 從官網抓廣告清單；任何失敗都回空陣列（前端改用打包備用）
#[tauri::command]
pub async fn ads_fetch() -> Vec<Ad> {
    match download(ADS_URL, MAX_BYTES).await {
        Ok(bytes) => {
            let mut ads = parse_ads(&bytes, today_utc());
            for ad in ads.iter_mut().filter(|a| !a.image_path.is_empty()) {
                // 圖抓不到、太大、格式不對都只是這一則退回樣板，不影響其他廣告
                match download(&format!("{SITE}{}", ad.image_path), MAX_IMAGE_BYTES).await.ok().and_then(|b| image_data_uri(&b)) {
                    Some(uri) => ad.small_image = uri,
                    None => elog!("[asn] 廣告圖不可用，退回樣板：{}", ad.key),
                }
            }
            ads
        }
        Err(e) => {
            elog!("[asn] 抓廣告清單失敗，用打包備用：{e}");
            vec![]
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const TODAY: Day = (2026, 10, 21);

    #[test]
    fn 網址只准_https_加允許清單的網域() {
        for ok in [
            "https://asnmessenger.web.app/",
            "https://asnmessenger.web.app/privacy",
            "https://asnmessenger.web.app/update/latest.json?x=1",
            "https://policy-tw.web.app",
            "https://POLICY-TW.web.app/",
            "https://policy-tw.web.app:443/",
        ] {
            assert!(url_allowed(ok), "{ok}");
        }
        for bad in [
            "http://asnmessenger.web.app/",
            "http://policy-tw.web.app",
            "https://evil.example/",
            "https://asnmessenger.web.app.evil.example/",
            "https://evil-asnmessenger.web.app/",
            "https://sub.asnmessenger.web.app/",
            "https://user:pw@asnmessenger.web.app/",
            "https://user@asnmessenger.web.app/",
            "https://asnmessenger.web.app@evil.example/",
            "https://evil.example/@asnmessenger.web.app",
            "https://asnmessenger.web.app:8443/",
            "https://127.0.0.1/",
            "https://[::1]/",
            "https://192.168.1.1/",
            "https://2130706433/",
            "https://0x7f.0.0.1/",
            "https://irori.web.app/",
            "https://islandmade.app",
            "ftp://asnmessenger.web.app/",
            "file:///c:/windows/system32/calc.exe",
            "javascript:alert(1)",
            "calc.exe",
            "https://asnmessenger.web.app/ & calc",
            "https://asnmessenger.web.app/\n",
            " https://asnmessenger.web.app/",
            "",
        ] {
            assert!(!url_allowed(bad), "{bad:?}");
        }
    }

    #[test]
    fn 抓取網址本身合格() {
        assert!(url_allowed(ADS_URL));
        assert!(ADS_URL.starts_with("https://"));
    }

    fn one(extra: &str) -> Vec<u8> {
        format!(r#"{{"version":1,"ads":[{{"key":"a","title":"標題","sub":"一句話","hue":10 {extra}}}]}}"#).into_bytes()
    }

    #[test]
    fn 正常解析並過濾日期() {
        assert_eq!(parse_ads(&one(""), TODAY).len(), 1);
        assert_eq!(parse_ads(&one(r#","start":"2026-10-21","end":"2026-10-21""#), TODAY).len(), 1, "當天含頭尾");
        assert!(parse_ads(&one(r#","start":"2026-10-22""#), TODAY).is_empty(), "還沒開始");
        assert!(parse_ads(&one(r#","end":"2026-10-20""#), TODAY).is_empty(), "已過期");
        assert!(parse_ads(&one(r#","end":"明天""#), TODAY).is_empty(), "日期格式錯就丟掉");
    }

    #[test]
    fn 站上的_ads_json_能全部通過驗證() {
        let bytes = std::fs::read(concat!(env!("CARGO_MANIFEST_DIR"), "/../../../site/public/ads.json")).expect("讀得到官網的 ads.json");
        let raw: Value = serde_json::from_slice(&bytes).unwrap();
        let n = raw["ads"].as_array().unwrap().len();
        assert_eq!(parse_ads(&bytes, TODAY).len(), n, "官網 ads.json 每一則都要通過 Rust 端驗證");
    }

    #[test]
    fn 欄位型別與長度不合格就丟那一則() {
        let long = "字".repeat(31);
        for extra in [
            format!(r#","title":"{long}""#),
            format!(r#","sub":"{}""#, "字".repeat(61)),
            r#","title":""#.to_string() + "\"",
            r#","title":5"#.to_string(),
            r#","hue":361"#.to_string(),
            r#","hue":"10""#.to_string(),
            r#","hue":-1"#.to_string(),
            r#","key":"a b""#.to_string(),
            r#","badge":"1234567""#.to_string(),
            r#","title":"a\u0007b""#.to_string(),
        ] {
            // 後面重複的欄位會覆蓋前面的（serde_json 取最後一個）
            assert!(parse_ads(&one(&extra), TODAY).is_empty(), "{extra}");
        }
        assert_eq!(parse_ads(&one(&format!(r#","title":"{}""#, "字".repeat(30))), TODAY).len(), 1, "剛好 30 字可以");
    }

    #[test]
    fn 網址不在允許清單的整則丟掉_有網址要有按鈕字() {
        assert!(parse_ads(&one(r#","url":"https://evil.example/","cta":"點""#), TODAY).is_empty());
        assert!(parse_ads(&one(r#","url":"http://asnmessenger.web.app/","cta":"點""#), TODAY).is_empty());
        assert!(parse_ads(&one(r#","url":"https://asnmessenger.web.app/","cta":"""#), TODAY).is_empty());
        assert_eq!(parse_ads(&one(r#","url":"https://asnmessenger.web.app/privacy","cta":"看""#), TODAY).len(), 1);
        assert_eq!(parse_ads(&one(r#","url":"","cta":"""#), TODAY).len(), 1, "純文字提示不用網址");
    }

    #[test]
    fn 整份壞掉就回空_重複_key_只留第一則() {
        for bad in ["", "not json", "[]", r#"{"ads":[]}"#, r#"{"version":2,"ads":[{"key":"a","title":"t","sub":"s","hue":1}]}"#, r#"{"version":1,"ads":{}}"#] {
            assert!(parse_ads(bad.as_bytes(), TODAY).is_empty(), "{bad}");
        }
        let dup = r#"{"version":1,"ads":[{"key":"a","title":"一","sub":"s","hue":1},{"key":"a","title":"二","sub":"s","hue":2},{"key":"b","title":"三","sub":"s","hue":3}]}"#;
        let got = parse_ads(dup.as_bytes(), TODAY);
        assert_eq!(got.iter().map(|a| a.title.as_str()).collect::<Vec<_>>(), ["一", "三"]);
    }

    #[test]
    fn 超過大小上限就回空() {
        let mut big = br#"{"version":1,"ads":[],"pad":""#.to_vec();
        big.extend(std::iter::repeat(b'x').take(MAX_BYTES));
        big.extend_from_slice(br#""}"#);
        assert!(parse_ads(&big, TODAY).is_empty());
    }

    #[test]
    fn 圖片與大頁路徑只准官網_ads_底下() {
        let ok = parse_ads(&one(r#","smallImage":"/ads/policy-small.png","page":"/ads/policy.html""#), TODAY);
        assert_eq!(ok.len(), 1);
        assert_eq!(ok[0].page, "https://asnmessenger.web.app/ads/policy.html");
        assert_eq!(ok[0].image_path, "/ads/policy-small.png");
        assert!(ok[0].small_image.is_empty(), "解析階段還沒下載");
        for extra in [
            r#","page":"https://evil.example/ads/x.html""#,
            r#","page":"//evil.example/ads/x.html""#,
            r#","page":"/ads/../x.html""#,
            r#","page":"/other/x.html""#,
            r#","page":"/ads/x.html?a=1""#,
            r#","page":"/ads/x.html#a""#,
            r#","page":"/ads/x.js""#,
            r#","page":"/ads/""#,
            r#","page":"/ads/%2e%2e/x.html""#,
            r#","page":"/ads/X.html""#,
            r#","smallImage":"/ads/x.svg""#,
            r#","smallImage":"/ads/x.gif""#,
            r#","smallImage":"https://evil.example/ads/x.png""#,
            r#","smallImage":"/img/x.png""#,
            r#","smallImage":5"#,
        ] {
            assert!(parse_ads(&one(extra), TODAY).is_empty(), "{extra}");
        }
    }

    #[test]
    fn 圖片只認_png_與_webp_的檔頭且有大小上限() {
        let mut png = vec![0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a];
        png.extend_from_slice(&[0; 20]);
        assert!(image_data_uri(&png).unwrap().starts_with("data:image/png;base64,"));
        let mut webp = b"RIFF\x10\0\0\0WEBPVP8 ".to_vec();
        webp.extend_from_slice(&[0; 8]);
        assert!(image_data_uri(&webp).unwrap().starts_with("data:image/webp;base64,"));
        assert!(image_data_uri(b"<svg xmlns='http://www.w3.org/2000/svg'/>").is_none());
        assert!(image_data_uri(b"GIF89a......").is_none());
        assert!(image_data_uri(b"<html>").is_none());
        assert!(image_data_uri(b"").is_none());
        png.resize(MAX_IMAGE_BYTES + 1, 0);
        assert!(image_data_uri(&png).is_none(), "超過 300 KB");
    }

    #[test]
    fn 日期換算() {
        let t = today_utc();
        assert!(t.0 >= 2026 && (1..=12).contains(&t.1) && (1..=31).contains(&t.2));
        assert_eq!(parse_day("2026-13-01"), None);
        assert_eq!(parse_day("20261001"), None);
    }
}

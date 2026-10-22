//! 手機自動更新（只給「自行安裝版」用，Google Play 版不啟用）的純邏輯：更新清單 android.json 的解析與檢查、網址白名單、版本比較、sha256 比對。
//! 不碰網路與檔案，所以電腦上也能測；下載與交給系統安裝在 android.rs（要 `sideload` 功能旗標才編進去）。
//!
//! 更新清單（官網 `update/android.json`）：
//! `{ "version": "0.1.33", "versionCode": 1033, "url": "https://asnmessenger.web.app/update/ASN_0.1.33_android.apk", "sha256": "<64 位小寫十六進位>", "notes": "更新說明", "bytes": 8600000 }`
//! versionCode 的算法與 Tauri 相同：主版 × 1,000,000 ＋ 次版 × 1,000 ＋ 修訂（0.1.32 → 1032），單調遞增。
#![cfg_attr(not(all(target_os = "android", feature = "sideload")), allow(dead_code))]
use serde::Deserialize;
use sha2::{Digest, Sha256};

pub const UPDATE_URL: &str = "https://asnmessenger.web.app/update/android.json";
pub const UPDATE_PREFIX: &str = "https://asnmessenger.web.app/update/";
/// 檢查更新時官網的回應怎麼處理：404（官網還沒有 android.json）＝目前沒有新版；其他錯誤＝暫時無法檢查（畫面不顯示原始錯誤）
#[derive(Debug, PartialEq)]
pub enum CheckStatus {
    Ok,
    NotFound,
    Unavailable,
}
pub fn classify_status(code: u16) -> CheckStatus {
    match code {
        200..=299 => CheckStatus::Ok,
        404 => CheckStatus::NotFound,
        _ => CheckStatus::Unavailable,
    }
}
pub const MSG_UNAVAILABLE: &str = "暫時無法檢查更新";
pub const MSG_LATEST: &str = "目前已是最新版";

/// 清單最大 64 KB、APK 最大 200 MB（防亂塞）
pub const MAX_MANIFEST_BYTES: usize = 64 * 1024;
pub const MAX_APK_BYTES: u64 = 200 * 1024 * 1024;

/// "主.次.修訂" → 版本碼（與 Tauri 的 android versionCode 算法一致）；格式不對回 None
pub fn version_code_of(version: &str) -> Option<u64> {
    let mut it = version.split('.');
    let (a, b, c) = (it.next()?, it.next()?, it.next()?);
    if it.next().is_some() {
        return None;
    }
    let n = |s: &str| (!s.is_empty() && s.len() <= 4 && s.chars().all(|c| c.is_ascii_digit())).then(|| s.parse::<u64>().ok()).flatten();
    let (a, b, c) = (n(a)?, n(b)?, n(c)?);
    (b < 1000 && c < 1000).then(|| a * 1_000_000 + b * 1_000 + c)
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct Manifest {
    pub version: String,
    #[serde(rename = "versionCode")]
    pub version_code: u64,
    pub url: String,
    pub sha256: String,
    #[serde(default)]
    pub notes: String,
    #[serde(default)]
    pub bytes: Option<u64>,
}

pub fn is_hex64(s: &str) -> bool {
    s.len() == 64 && s.chars().all(|c| c.is_ascii_digit() || ('a'..='f').contains(&c))
}

/// 網址白名單：官網 update/ 底下的 https；或（只有明確帶了本機測試網址時）http://127.0.0.1:埠/…
pub fn url_allowed(url: &str, loopback_test: bool) -> bool {
    if url.len() > 300 || url.chars().any(|c| c.is_control() || c == ' ' || c == '\\' || c == '"' || c == '\'' || c == '<' || c == '>') {
        return false;
    }
    if let Some(rest) = url.strip_prefix(UPDATE_PREFIX) {
        return !rest.is_empty() && !rest.contains("..") && !rest.contains('@') && !rest.contains('?') && !rest.contains('#');
    }
    loopback_test && url.starts_with("http://127.0.0.1:") && !url.contains('@')
}

/// 只准本機測試用的網址是回送位址（`http://127.0.0.1:埠/…`）
pub fn is_loopback_url(url: &str) -> bool {
    url.starts_with("http://127.0.0.1:") && !url.contains('@') && !url.chars().any(|c| c.is_control() || c == ' ')
}

/// 解析並檢查清單。版本、版本碼、sha256、網址任何一項不合格都整份拒絕；版本碼必須與版本號算出來的一致（防人為寫錯造成降版或永遠更新）
pub fn parse_manifest(text: &str, loopback_test: bool) -> Result<Manifest, String> {
    if text.len() > MAX_MANIFEST_BYTES {
        return Err("更新清單太大".into());
    }
    let m: Manifest = serde_json::from_str(text).map_err(|_| "更新清單的格式不對".to_string())?;
    let code = version_code_of(&m.version).ok_or("更新清單的版本號格式不對")?;
    if code != m.version_code {
        return Err("更新清單的版本碼與版本號對不上".into());
    }
    if !is_hex64(&m.sha256) {
        return Err("更新清單的 sha256 格式不對".into());
    }
    if !url_allowed(&m.url, loopback_test) {
        return Err("更新清單的下載網址不在允許範圍內".into());
    }
    if m.bytes.is_some_and(|b| b == 0 || b > MAX_APK_BYTES) {
        return Err("更新清單的檔案大小不合理".into());
    }
    Ok(m)
}

/// 清單版本比現在新（版本碼嚴格較大）才算有新版
pub fn is_newer(m: &Manifest, current_version: &str) -> bool {
    version_code_of(current_version).is_some_and(|cur| m.version_code > cur)
}

/// 更新說明的第一行（橫幅用）；去掉條列符號與頭尾空白
pub fn first_line(notes: &str) -> String {
    let l = notes.lines().map(|l| l.trim().trim_start_matches(['-', '*', '•']).trim()).find(|l| !l.is_empty()).unwrap_or("");
    l.chars().take(80).collect()
}

/// 下載串流邊收邊算 sha256
#[derive(Default)]
pub struct Hasher(Sha256);
impl Hasher {
    pub fn update(&mut self, b: &[u8]) {
        self.0.update(b);
    }
    pub fn hex(self) -> String {
        self.0.finalize().iter().map(|b| format!("{b:02x}")).collect()
    }
}

/// 算出來的 sha256 和清單寫的比對（不分大小寫）；不符就不能安裝
pub fn verify_sha256(actual_hex: &str, expected: &str) -> Result<(), String> {
    if actual_hex.eq_ignore_ascii_case(expected) {
        Ok(())
    } else {
        Err("下載的檔案和更新清單的 sha256 對不上，已放棄安裝".into())
    }
}

/// 下載存放的檔名：只由版本號組成（版本號已驗過格式）
pub fn apk_file_name(version: &str) -> String {
    format!("ASN_{version}_android.apk")
}

#[cfg(test)]
mod tests {
    use super::*;

    const SHA: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    fn manifest(extra: &str) -> String {
        format!(r#"{{"version":"0.1.33","versionCode":1033,"url":"https://asnmessenger.web.app/update/ASN_0.1.33_android.apk","sha256":"{SHA}","notes":"- 第一行\n- 第二行"{extra}}}"#)
    }

    #[test]
    fn 版本碼算法與_tauri_相同() {
        assert_eq!(version_code_of("0.1.32"), Some(1032));
        assert_eq!(version_code_of("1.2.3"), Some(1_002_003));
        for bad in ["", "1", "1.2", "1.2.3.4", "a.b.c", "1.2.x", "1..3", "0.1000.0", "0.0.1000", "-1.0.0", "1.2.3-beta"] {
            assert_eq!(version_code_of(bad), None, "{bad}");
        }
        assert!(version_code_of("0.1.33") > version_code_of("0.1.32") && version_code_of("0.2.0") > version_code_of("0.1.999"));
    }

    #[test]
    fn 清單解析_合格的收_任何一項不合格整份拒絕() {
        let m = parse_manifest(&manifest(""), false).unwrap();
        assert_eq!((m.version.as_str(), m.version_code), ("0.1.33", 1033));
        assert_eq!(first_line(&m.notes), "第一行");
        assert!(parse_manifest("{壞掉", false).is_err());
        assert!(parse_manifest(&manifest("").replace("1033", "1034"), false).unwrap_err().contains("對不上"), "版本碼與版本號不一致");
        assert!(parse_manifest(&manifest("").replace(SHA, "XYZ"), false).unwrap_err().contains("sha256"));
        assert!(parse_manifest(&manifest("").replace(SHA, &SHA.to_uppercase()), false).is_err(), "sha256 只收小寫十六進位");
        assert!(parse_manifest(&manifest("").replace("https://asnmessenger.web.app/update/", "https://evil.example/"), false).unwrap_err().contains("網址"));
        assert!(parse_manifest(&manifest(r#","bytes":0"#), false).is_err());
        assert!(parse_manifest(&manifest(r#","bytes":999999999999"#), false).is_err());
        assert!(parse_manifest(&"x".repeat(MAX_MANIFEST_BYTES + 1), false).is_err());
    }

    #[test]
    fn 下載網址白名單_官網_update_底下的_https_本機網址只有測試時才收() {
        let ok = |u: &str, t| url_allowed(u, t);
        assert!(ok("https://asnmessenger.web.app/update/ASN_0.1.33_android.apk", false));
        for bad in ["http://asnmessenger.web.app/update/a.apk", "https://asnmessenger.web.app/other/a.apk", "https://asnmessenger.web.app/update/", "https://asnmessenger.web.app/update/../a.apk", "https://asnmessenger.web.app/update/a.apk?x=1", "https://asnmessenger.web.app.evil.com/update/a.apk", "https://asnmessenger.web.app/update/a b.apk", "file:///data/a.apk", "http://127.0.0.1:1/a.apk"] {
            assert!(!ok(bad, false), "{bad}");
        }
        assert!(ok("http://127.0.0.1:5000/a.apk", true));
        assert!(!ok("http://127.0.0.1:5000/a.apk", false), "沒有帶本機測試網址就不收回送位址");
        assert!(!ok("http://127.0.0.1:5000@evil.example/a.apk", true));
        assert!(is_loopback_url("http://127.0.0.1:5000/android.json") && !is_loopback_url("https://asnmessenger.web.app/update/android.json") && !is_loopback_url("http://localhost:1/x"));
        assert!(UPDATE_URL.starts_with(UPDATE_PREFIX));
    }

    #[test]
    fn 有新版才提示_同版或較舊都不提示() {
        let m = parse_manifest(&manifest(""), false).unwrap();
        assert!(is_newer(&m, "0.1.32"));
        assert!(!is_newer(&m, "0.1.33") && !is_newer(&m, "0.1.34") && !is_newer(&m, "0.2.0"));
        assert!(!is_newer(&m, "壞版本"), "現在的版本號讀不懂就不提示，免得亂更新");
    }

    #[test]
    fn sha256_不符不安裝() {
        let mut h = Hasher::default();
        h.update(b"abc");
        let hex = h.hex();
        assert_eq!(hex, "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
        assert!(verify_sha256(&hex, &hex.to_uppercase()).is_ok());
        let e = verify_sha256(&hex, SHA).unwrap_err();
        assert!(e.contains("放棄安裝"));
        let mut h2 = Hasher::default();
        h2.update(b"ab");
        h2.update(b"c");
        assert_eq!(h2.hex(), hex, "分段送入結果相同");
    }

    #[test]
    fn 檢查更新的回應處理_404是沒有新版_其他錯誤是暫時無法() {
        assert_eq!(classify_status(200), CheckStatus::Ok);
        assert_eq!(classify_status(404), CheckStatus::NotFound);
        for c in [301, 400, 403, 500, 502, 503] {
            assert_eq!(classify_status(c), CheckStatus::Unavailable, "{c}");
        }
        for m in [MSG_UNAVAILABLE, MSG_LATEST] {
            assert!(!m.is_ascii() && !m.chars().any(|c| c.is_ascii_digit()), "純中文、不含狀態碼：{m}");
        }
    }

    #[test]
    fn 說明第一行與檔名() {
        assert_eq!(first_line(""), "");
        assert_eq!(first_line("\n\n  * 修正 bug\n- 另一項"), "修正 bug");
        assert_eq!(first_line(&"字".repeat(200)).chars().count(), 80);
        assert_eq!(apk_file_name("0.1.33"), "ASN_0.1.33_android.apk");
    }
}

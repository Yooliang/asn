//! 用手機相機掃電腦設定頁上的 QR code 來核對指紋。
//!
//! QR code 的內容固定是 `asn-fp:v1:<電腦的節點>:<16 個小寫十六進位字元的指紋>`。
//! - 電腦版：把自己的節點與指紋排成 QR code 的格子畫在設定頁上（[`qr_rows`]，只編在電腦版）。
//! - 手機版：相機由外殼（Kotlin）開，掃到的字**不經過網頁**：外殼在本人驗證通過的那一刻把它存進 App 私有資料夾，
//!   Rust 的 `android_known_scan_confirm` 讀出並刪掉，再用這裡的 [`run`] 判斷（格式、節點、指紋）。
//! - 判斷用的是這支手機記住的那把公鑰重算的指紋，不是畫面給的任何字。
//! 這個檔案不寫日誌、不發事件、不碰檔案（守門測試鎖住）。

/// QR code 內容的開頭（含版本）
pub const PREFIX: &str = "asn-fp:v1:";
/// 掃到的字最多幾個字元（超過一律當不是 ASN 的 QR code）
pub const MAX_LEN: usize = 200;
/// 節點最多幾個字元
const NODE_MAX: usize = 64;

/// 電腦排進 QR code 的字串
#[allow(dead_code)]
pub fn payload(node: &str, fp16: &str) -> String {
    format!("{PREFIX}{node}:{fp16}")
}

/// 嚴格解析：開頭固定、指紋剛好 16 個小寫十六進位字元、節點不空且沒有控制字元、整段不超過上限。回（節點、指紋）
pub fn parse(text: &str) -> Option<(&str, &str)> {
    if text.chars().count() > MAX_LEN {
        return None;
    }
    let rest = text.strip_prefix(PREFIX)?;
    let (node, fp) = rest.rsplit_once(':')?;
    if node.is_empty() || node.chars().count() > NODE_MAX || node.chars().any(|c| c.is_control()) {
        return None;
    }
    if fp.len() != 16 || !fp.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) {
        return None;
    }
    Some((node, fp))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Verdict {
    /// 節點與指紋都和這支手機記住的一樣
    Match,
    /// 是 ASN 的 QR code，但節點或指紋不一樣
    Mismatch,
    /// 不是 ASN 的指紋 QR code
    BadQr,
}

/// 掃到的字對照要確認的電腦（節點）與這支手機記住的公鑰算出的指紋
pub fn judge(text: &str, want_node: &str, remembered_fp16: &str) -> Verdict {
    match parse(text) {
        None => Verdict::BadQr,
        Some((n, f)) if n == want_node && f == remembered_fp16 => Verdict::Match,
        Some(_) => Verdict::Mismatch,
    }
}

/// 掃描確認的整個流程（動作由呼叫端以函式帶進來，所以不用碰檔案也能測）：
/// 先用憑證（本人驗證過）→ 讀出並刪掉掃到的字 → 看有沒有被鎖住或擋住 → 判斷；
/// 一樣才叫 `on_match`（記住），不一樣叫 `on_mismatch`（擋住）；不是 ASN 的 QR code 什麼都不動。
/// 回給畫面的字：ok／mismatch／bad_qr／not_verified／blocked／locked
pub fn run(
    redeem: impl FnOnce() -> bool,
    take_scan: impl FnOnce() -> Option<String>,
    gate: impl FnOnce() -> Result<Option<&'static str>, String>,
    node: &str,
    remembered_fp16: &str,
    on_match: impl FnOnce() -> Result<bool, String>,
    on_mismatch: impl FnOnce() -> Result<(), String>,
) -> Result<&'static str, String> {
    if !redeem() {
        return Ok("not_verified");
    }
    let Some(text) = take_scan() else { return Ok("not_verified") };
    if let Some(stop) = gate()? {
        return Ok(stop);
    }
    match judge(&text, node, remembered_fp16) {
        Verdict::Match => Ok(if on_match()? { "ok" } else { "not_verified" }),
        Verdict::Mismatch => {
            on_mismatch()?;
            Ok("mismatch")
        }
        Verdict::BadQr => Ok("bad_qr"),
    }
}

/// QR code 的格子（電腦版）：{ size, rows }，rows 每列一個字串，'1'＝深色、'0'＝淺色。糾錯等級 M
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub fn qr_rows(node: &str, fp16: &str) -> Result<serde_json::Value, String> {
    use qrcode::{Color, EcLevel, QrCode};
    let code = QrCode::with_error_correction_level(payload(node, fp16).as_bytes(), EcLevel::M).map_err(|e| format!("做不出 QR code：{e}"))?;
    let size = code.width();
    let colors = code.to_colors();
    let rows: Vec<String> = colors.chunks(size).map(|r| r.iter().map(|c| if *c == Color::Dark { '1' } else { '0' }).collect()).collect();
    Ok(serde_json::json!({ "size": size, "rows": rows }))
}

#[cfg(test)]
mod tests {
    use super::*;

    const FP: &str = "a93cc5191f2e3b4d";

    #[test]
    fn 解析_格式嚴格_大小寫_長度_多餘的字() {
        assert_eq!(parse("asn-fp:v1:pc-1:a93cc5191f2e3b4d"), Some(("pc-1", FP)));
        assert_eq!(parse(&payload("工作機", FP)), Some(("工作機", FP)));
        // 節點裡有冒號：以最後一個冒號切指紋
        assert_eq!(parse("asn-fp:v1:a:b:a93cc5191f2e3b4d"), Some(("a:b", FP)));
        for bad in [
            "",
            "asn-fp:v1:pc:A93CC5191F2E3B4D",
            "asn-fp:v1:pc:a93cc5191f2e3b4",
            "asn-fp:v1:pc:a93cc5191f2e3b4de",
            "asn-fp:v1:pc:a93cc5191f2e3b4g",
            "asn-fp:v1::a93cc5191f2e3b4d",
            "asn-fp:v1:a93cc5191f2e3b4d",
            "asn-fp:v2:pc:a93cc5191f2e3b4d",
            "ASN-FP:v1:pc:a93cc5191f2e3b4d",
            " asn-fp:v1:pc:a93cc5191f2e3b4d",
            "asn-fp:v1:pc:a93cc5191f2e3b4d\n",
            "asn-fp:v1:p\nc:a93cc5191f2e3b4d",
            "https://example.com/",
        ] {
            assert_eq!(parse(bad), None, "{bad:?}");
        }
        let long = format!("{PREFIX}{}:{FP}", "n".repeat(MAX_LEN));
        assert_eq!(parse(&long), None, "太長");
        let node65 = format!("{PREFIX}{}:{FP}", "n".repeat(65));
        assert_eq!(parse(&node65), None, "節點太長");
        assert!(parse(&format!("{PREFIX}{}:{FP}", "n".repeat(64))).is_some());
    }

    #[test]
    fn 判斷_節點和指紋都一樣才算_別的都是不一樣_不是ASN的是bad() {
        assert_eq!(judge(&payload("pc", FP), "pc", FP), Verdict::Match);
        assert_eq!(judge(&payload("pc2", FP), "pc", FP), Verdict::Mismatch, "節點不同");
        assert_eq!(judge(&payload("pc", "0000000000000000"), "pc", FP), Verdict::Mismatch, "指紋不同");
        assert_eq!(judge("hello", "pc", FP), Verdict::BadQr);
        assert_eq!(judge(&payload("pc", &FP.to_uppercase()), "pc", FP), Verdict::BadQr, "大寫不算格式正確");
    }

    use std::cell::Cell;

    /// 用 consent 的真實函式（暫存資料夾）跑整個流程，回 (結果, 記住幾次, 擋住幾次)
    fn flow(data_dir: &std::path::Path, scanned: Option<&str>, marker: bool, gate: Option<&'static str>, node: &str) -> (Result<&'static str, String>, u32, u32) {
        let ch = "ab".repeat(32);
        let dir = data_dir.join(crate::consent::MARKER_DIR);
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        if marker {
            std::fs::write(dir.join(crate::consent::hash_hex(&ch)), "1").unwrap();
        }
        if let Some(s) = scanned {
            std::fs::write(dir.join(format!("{}.{}", crate::consent::hash_hex(&ch), crate::consent::SCAN_EXT)), s).unwrap();
        }
        let mut store = crate::consent::Store::default();
        let t = std::time::Instant::now();
        let issued = store.issue(crate::consent::Action::Scan, node, t, |b: &mut [u8]| b.fill(0xab));
        assert_eq!(issued, ch, "固定亂數發出的憑證");
        let (matched, blocked) = (Cell::new(0u32), Cell::new(0u32));
        let r = run(
            || store.redeem(crate::consent::Action::Scan, node, &ch, t, |h| crate::consent::take_marker(data_dir, h)),
            || crate::consent::take_scan(data_dir, &ch),
            || Ok(gate),
            node,
            FP,
            || {
                matched.set(matched.get() + 1);
                Ok(true)
            },
            || {
                blocked.set(blocked.get() + 1);
                Ok(())
            },
        );
        (r, matched.get(), blocked.get())
    }

    #[test]
    fn 流程_一樣就記住_不一樣就擋住_不是ASN的不動_沒驗證或沒有掃到都不算() {
        let d = tempfile::tempdir().unwrap();
        let good = payload("pc", FP);
        assert_eq!(flow(d.path(), Some(&good), true, None, "pc"), (Ok("ok"), 1, 0));
        assert_eq!(flow(d.path(), Some(&payload("pc", "0000000000000000")), true, None, "pc"), (Ok("mismatch"), 0, 1));
        assert_eq!(flow(d.path(), Some(&payload("other", FP)), true, None, "pc"), (Ok("mismatch"), 0, 1));
        assert_eq!(flow(d.path(), Some("https://example.com"), true, None, "pc"), (Ok("bad_qr"), 0, 0));
        assert_eq!(flow(d.path(), Some(&good), false, None, "pc"), (Ok("not_verified"), 0, 0), "沒有憑證檔＝本人沒驗證");
        assert_eq!(flow(d.path(), None, true, None, "pc"), (Ok("not_verified"), 0, 0), "沒有掃到的字");
        assert_eq!(flow(d.path(), Some(&good), true, Some("blocked"), "pc"), (Ok("blocked"), 0, 0));
        assert_eq!(flow(d.path(), Some(&good), true, Some("locked"), "pc"), (Ok("locked"), 0, 0));
        // 憑證有效時，掃到的字與憑證檔都用掉了（最後一個情境是有效憑證）
        let left: Vec<_> = std::fs::read_dir(d.path().join(crate::consent::MARKER_DIR)).unwrap().flatten().collect();
        assert!(left.is_empty(), "不能留下檔案：{left:?}");
    }

    #[test]
    fn 流程_記住失敗或動作出錯_照實回() {
        let r = run(|| true, || Some(payload("pc", FP)), || Ok(None), "pc", FP, || Ok(false), || Ok(()));
        assert_eq!(r, Ok("not_verified"), "記不到（被忘記、換了金鑰）");
        let r = run(|| true, || Some(payload("pc", "1111111111111111")), || Ok(None), "pc", FP, || Ok(true), || Err("寫不出".to_string()));
        assert_eq!(r, Err("寫不出".to_string()));
        let called = Cell::new(false);
        let r = run(|| false, || { called.set(true); None }, || Ok(None), "pc", FP, || Ok(true), || Ok(()));
        assert_eq!((r, called.get()), (Ok("not_verified"), false), "憑證不對就不讀掃到的字");
    }

    #[test]
    fn 守門_這裡不寫日誌_不發事件_不碰檔案_不當掉() {
        let src = std::fs::read_to_string(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src").join("fp_scan.rs")).unwrap().replace("\r\n", "\n");
        let code = src.split("\n#[cfg(test)]").next().unwrap();
        for bad in ["elog!", "olog!", concat!("print", "ln!"), concat!("db", "g!"), "log::", "tracing::", "emit(", "ui_log", "std::fs", "fs::", "File::", ".unwrap()", ".expect("] {
            assert!(!code.contains(bad), "fp_scan.rs 不能有：{bad}");
        }
    }

    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    #[test]
    fn qr_格子_方形_只有一和零_有留白以外的深色_同樣的字同樣的格子() {
        let v = qr_rows("pc-1", FP).unwrap();
        let size = v["size"].as_u64().unwrap() as usize;
        let rows: Vec<&str> = v["rows"].as_array().unwrap().iter().map(|r| r.as_str().unwrap()).collect();
        assert!(size >= 21 && (size - 21) % 4 == 0, "QR code 的邊長是 21＋4n：{size}");
        assert_eq!(rows.len(), size);
        assert!(rows.iter().all(|r| r.len() == size && r.bytes().all(|b| b == b'0' || b == b'1')));
        // 左上角的定位方塊：第一列前 7 格都是深色
        assert!(rows[0].starts_with("1111111"), "{}", rows[0]);
        assert_eq!(qr_rows("pc-1", FP).unwrap(), v);
        assert_ne!(qr_rows("pc-2", FP).unwrap()["rows"], v["rows"]);
    }
}

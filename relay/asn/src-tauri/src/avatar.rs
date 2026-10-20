//! 設備大頭貼：上傳前在 Rust 端檢查格式與大小（金鑰也只在這裡），通過才送給收發室。
//! 規則與 ui/lib/avatar.mjs、supabase/functions/_shared/avatar.ts 一致：`data:image/png;base64,` 或 `data:image/webp;base64,`
//! 開頭、base64 字元、全長 ≤ 48000 字、圖檔 ≤ 32 KB、檔頭要跟格式對得上。

pub const MAX_CHARS: usize = 48_000;
pub const MAX_BYTES: usize = 32 * 1024;

fn b64_val(c: u8) -> Option<u8> {
    match c {
        b'A'..=b'Z' => Some(c - b'A'),
        b'a'..=b'z' => Some(c - b'a' + 26),
        b'0'..=b'9' => Some(c - b'0' + 52),
        b'+' => Some(62),
        b'/' => Some(63),
        _ => None,
    }
}

/// 只解前 n 個位元組（驗檔頭用）
fn head_bytes(b64: &[u8], n: usize) -> Vec<u8> {
    let mut out = vec![];
    let (mut acc, mut bits) = (0u32, 0u32);
    for &c in b64 {
        let Some(v) = b64_val(c) else { break };
        acc = (acc << 6) | v as u32;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push(((acc >> bits) & 0xff) as u8);
            acc &= (1 << bits) - 1;
        }
        if out.len() >= n {
            break;
        }
    }
    out
}

/// 通過回 Ok(解碼後的位元組數)；不通過回給人看的中文原因
pub fn validate(s: &str) -> Result<usize, String> {
    let (kind, rest) = if let Some(r) = s.strip_prefix("data:image/png;base64,") {
        ("png", r)
    } else if let Some(r) = s.strip_prefix("data:image/webp;base64,") {
        ("webp", r)
    } else {
        return Err("大頭貼只接受 png 或 webp 圖片".into());
    };
    if s.len() > MAX_CHARS {
        return Err("大頭貼太大了".into());
    }
    let b = rest.as_bytes();
    let body = b.iter().position(|&c| c == b'=').map(|i| &b[..i]).unwrap_or(b);
    let pad = b.len() - body.len();
    if body.is_empty() || pad > 2 || !body.iter().all(|&c| b64_val(c).is_some()) || !b[body.len()..].iter().all(|&c| c == b'=') || b.len() % 4 == 1 {
        return Err("大頭貼的內容不是有效的圖片資料".into());
    }
    let bytes = b.len() * 3 / 4 - pad;
    if bytes > MAX_BYTES {
        return Err(format!("大頭貼不能超過 {} KB", MAX_BYTES / 1024));
    }
    let head = head_bytes(body, 12);
    let ok = match kind {
        "png" => head.starts_with(&[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        _ => head.len() >= 12 && &head[0..4] == b"RIFF" && &head[8..12] == b"WEBP",
    };
    if !ok {
        return Err("圖片內容跟格式對不上".into());
    }
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    // 最小的合法檔頭（驗檔頭用，不需要是完整圖片）
    const PNG: &str = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==";
    const WEBP: &str = "data:image/webp;base64,UklGRiIAAABXRUJQVlA4IBYAAAAw";

    #[test]
    fn 合法的_png_與_webp_通過() {
        assert!(validate(PNG).is_ok());
        assert!(validate(WEBP).is_ok());
    }

    #[test]
    fn 格式不對一律拒絕() {
        for bad in [
            "",
            "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=",
            "data:image/gif;base64,R0lGODlhAQABAAAAACw=",
            "javascript:alert(1)",
            "https://example.com/a.png",
            "data:image/png;base64,",
            "data:image/png;base64,!!!!",
            "data:image/png;base64,iVBORw0KGgo=AAA",
            "data:image/png;base64,/9j/4AAQSkZJRgABAQEASABIAAD/",   // jpeg 檔頭冒充 png
            "data:image/webp;base64,iVBORw0KGgoAAAANSUhEUg==",     // png 檔頭冒充 webp
            "data:text/html;base64,PGgxPg==",
        ] {
            assert!(validate(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn 大小上限_三萬二千位元組與四萬八千字() {
        let head = "iVBORw0KGgoAAAANSUhEUg";   // PNG 檔頭
        let mk = |n_bytes: usize| {
            let chars = (n_bytes + 2) / 3 * 4;
            let mut s = String::from("data:image/png;base64,");
            s.push_str(head);
            while s.len() < "data:image/png;base64,".len() + chars { s.push('A'); }
            s
        };
        assert!(validate(&mk(MAX_BYTES - 2)).is_ok());
        assert!(validate(&mk(MAX_BYTES + 1)).is_err());
        let huge = format!("data:image/png;base64,{head}{}", "A".repeat(MAX_CHARS));
        assert!(validate(&huge).is_err());
    }
}

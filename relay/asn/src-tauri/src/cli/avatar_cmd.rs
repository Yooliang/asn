//! `asn avatar`：夥伴自己換頭像（#446）。
//!   asn avatar set --file <圖>     把圖在本機裁成正方形、縮成 96×96（太大就再縮）、重新編成 png，上傳成「呼叫者自己」的頭像
//!   asn avatar clear               移除自己的自訂頭像（改回自動產生）
//! 只收 png、jpg、webp 原圖（原檔 ≤ 5 MB，解碼前先限長寬與記憶體，防解壓縮炸彈）；不收 SVG、GIF 或其他格式。
//! 輸出一律從像素重新編碼，原檔的 metadata（EXIF 等）不會帶上去。上傳後後台與資料庫還會再驗一次格式與大小。
//! 信任邊界（照實說）：後台只認節點金鑰，同一台電腦上的視窗在伺服器看起來是同一個人（和寄信的寄件視窗名一樣）；
//! 不同電腦、不同帳號改不到。每位夥伴每小時最多改 5 次。
//! 結束碼：1 用法／圖片不合、2 認不出呼叫者、3 太頻繁、4 後端錯誤。
use super::caller::{find_caller, http_status, identity, relay};
use super::env::Env;
use super::{Fail, Io, R};
use base64::Engine as _;
use image::codecs::png::{CompressionType, FilterType, PngEncoder};
use image::imageops::FilterType as Resize;
use image::{ImageEncoder, ImageFormat, ImageReader, Limits};
use serde_json::json;
use std::io::Cursor;

/// 原檔上限
pub const MAX_FILE_BYTES: u64 = 5 * 1024 * 1024;
/// 解碼前的長寬與記憶體上限（防解壓縮炸彈）
pub const MAX_SIDE: u32 = 4096;
pub const MAX_ALLOC: u64 = 64 * 1024 * 1024;
/// 輸出邊長：先 96，檔案超過 32 KB 再依序縮到 80、64
const SIDES: [u32; 3] = [96, 80, 64];

const USAGE: &str = "用法：
  asn avatar set --file <圖>   把圖換成自己的頭像（只能改呼叫者自己）
  asn avatar clear             移除自己的自訂頭像，改回自動產生
圖片：png、jpg、webp，原檔 ≤ 5 MB、長寬各 ≤ 4096；會在本機置中裁成正方形、縮成 96×96、重新編成 png（原檔的 EXIF 等資料不會上傳）。不收 SVG、GIF。
每位夥伴每小時最多改 5 次。
注意：後台只認這台電腦的金鑰，同一台電腦上的視窗在伺服器看起來是同一個人；不同電腦、不同帳號改不到。";

#[derive(Debug, Default, PartialEq)]
pub struct Args {
    pub action: Option<String>,
    pub file: Option<String>,
    pub help: bool,
}

pub fn parse_args(argv: &[String]) -> R<Args> {
    let mut a = Args::default();
    let mut i = 0;
    while i < argv.len() {
        let k = argv[i].as_str();
        match k {
            "set" | "clear" if a.action.is_none() => a.action = Some(k.to_string()),
            "--file" => {
                i += 1;
                a.file = Some(argv.get(i).cloned().ok_or_else(|| Fail::new(1, format!("--file 缺少參數\n{USAGE}")))?);
            }
            "--help" | "-h" => a.help = true,
            _ => return Err(Fail::new(1, format!("不認得的參數 {k}\n{USAGE}"))),
        }
        i += 1;
    }
    Ok(a)
}

fn sniff(head: &[u8]) -> Option<ImageFormat> {
    if head.starts_with(&[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) {
        Some(ImageFormat::Png)
    } else if head.starts_with(&[0xff, 0xd8, 0xff]) {
        Some(ImageFormat::Jpeg)
    } else if head.len() >= 12 && &head[0..4] == b"RIFF" && &head[8..12] == b"WEBP" {
        Some(ImageFormat::WebP)
    } else {
        None
    }
}

fn encode_png(img: &image::RgbaImage) -> Result<Vec<u8>, String> {
    let mut out = Vec::new();
    PngEncoder::new_with_quality(&mut out, CompressionType::Best, FilterType::Adaptive)
        .write_image(img.as_raw(), img.width(), img.height(), image::ExtendedColorType::Rgba8)
        .map_err(|e| format!("編碼失敗：{e}"))?;
    Ok(out)
}

/// 原檔位元組 → 可上傳的 data URL（png、96×96，太大再縮）。錯誤是給人看的中文
pub fn process(bytes: &[u8]) -> Result<String, String> {
    if bytes.len() as u64 > MAX_FILE_BYTES {
        return Err(format!("圖檔太大了（上限 {} MB）", MAX_FILE_BYTES / 1024 / 1024));
    }
    let fmt = sniff(bytes).ok_or("只收 png、jpg、webp 圖片（不收 SVG、GIF 或其他格式）")?;
    let mut reader = ImageReader::with_format(Cursor::new(bytes), fmt);
    let mut limits = Limits::default();
    limits.max_image_width = Some(MAX_SIDE);
    limits.max_image_height = Some(MAX_SIDE);
    limits.max_alloc = Some(MAX_ALLOC);
    reader.limits(limits);
    let img = reader.decode().map_err(|e| format!("讀不了這張圖（損壞、太大或格式不支援）：{e}"))?.to_rgba8();
    let (w, h) = img.dimensions();
    if w == 0 || h == 0 {
        return Err("圖片是空的".into());
    }
    let s = w.min(h);
    let square = image::imageops::crop_imm(&img, (w - s) / 2, (h - s) / 2, s, s).to_image();
    for side in SIDES {
        let small = image::imageops::resize(&square, side, side, Resize::Lanczos3);
        let png = encode_png(&small)?;
        let url = format!("data:image/png;base64,{}", base64::engine::general_purpose::STANDARD.encode(&png));
        if crate::avatar::validate(&url).is_ok() {
            return Ok(url);
        }
    }
    Err(format!("圖片太複雜，縮到 {} px 後還是超過 {} KB，請換一張簡單一點的", SIDES[SIDES.len() - 1], crate::avatar::MAX_BYTES / 1024))
}

fn read_file(path: &str) -> R<Vec<u8>> {
    let meta = std::fs::metadata(path).map_err(|e| Fail::new(1, format!("讀不到 {path}：{e}")))?;
    if !meta.is_file() {
        return Err(Fail::new(1, format!("{path} 不是檔案")));
    }
    if meta.len() > MAX_FILE_BYTES {
        return Err(Fail::new(1, format!("圖檔太大了（上限 {} MB）", MAX_FILE_BYTES / 1024 / 1024)));
    }
    std::fs::read(path).map_err(|e| Fail::new(1, format!("讀不到 {path}：{e}")))
}

pub async fn main(argv: &[String], env: &Env, io: &mut Io<'_>) -> R<i32> {
    let a = parse_args(argv)?;
    if a.help {
        io.outln(USAGE);
        return Ok(0);
    }
    let avatar = match a.action.as_deref() {
        Some("set") => {
            let Some(f) = a.file.as_deref() else {
                return Err(Fail::new(1, format!("缺少 --file\n{USAGE}")));
            };
            Some(process(&read_file(f)?).map_err(|e| Fail::new(1, e))?)
        }
        Some("clear") => {
            if a.file.is_some() {
                return Err(Fail::new(1, format!("clear 不用 --file\n{USAGE}")));
            }
            None
        }
        _ => return Err(Fail::new(1, format!("缺少子命令 set 或 clear\n{USAGE}"))),
    };
    let caller = find_caller(env, "換頭像")?;
    let id = identity(env, true)?;
    let rl = relay(&id, &caller.name);
    let r = rl.api("set_partner_avatar", Some(json!({ "agent": caller.name, "avatar": avatar }))).await.map_err(|e| {
        let status = http_status(&e);
        let why = match (status, e.rsplit(' ').next().unwrap_or("")) {
            (Some(404), "partner_not_found") => "後台找不到這位夥伴（視窗剛開還沒登記到名單，等一分鐘再試；沒有夥伴編號的舊視窗不支援）".to_string(),
            (Some(404), _) => "後台還不支援換頭像（請等後台更新）".to_string(),
            (Some(429), _) => "太頻繁了：每位夥伴每小時最多改 5 次，晚點再試".to_string(),
            (Some(400), "bad_avatar_format") | (Some(400), "avatar_too_large") => "後台說這張圖的格式或大小不對".to_string(),
            _ => e,
        };
        Fail::new(if status == Some(429) { 3 } else { 4 }, format!("換頭像失敗：{why}"))
    })?;
    match avatar {
        Some(_) => io.outln(&format!("avatar set {}", r.get("partner_id").and_then(|v| v.as_str()).unwrap_or(&caller.name))),
        None => io.outln("avatar cleared"),
    }
    Ok(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{Rgba, RgbaImage};

    fn png_of(w: u32, h: u32) -> Vec<u8> {
        let img = RgbaImage::from_fn(w, h, |x, y| Rgba([(x % 256) as u8, (y % 256) as u8, ((x + y) % 256) as u8, 255]));
        encode_png(&img).unwrap()
    }
    fn decode_url(u: &str) -> image::DynamicImage {
        let b = base64::engine::general_purpose::STANDARD.decode(u.strip_prefix("data:image/png;base64,").unwrap()).unwrap();
        image::load_from_memory(&b).unwrap()
    }

    #[test]
    fn 參數() {
        let p = |a: &[&str]| parse_args(&a.iter().map(|s| s.to_string()).collect::<Vec<_>>());
        let a = p(&["set", "--file", "x.png"]).unwrap();
        assert_eq!((a.action.as_deref(), a.file.as_deref()), (Some("set"), Some("x.png")));
        assert_eq!(p(&["clear"]).unwrap().action.as_deref(), Some("clear"));
        assert!(p(&["--file"]).unwrap_err().msg.contains("缺少參數"));
        assert!(p(&["--x"]).unwrap_err().msg.contains("不認得的參數"));
        assert!(p(&["set", "clear"]).is_err());
        assert!(p(&["--help"]).unwrap().help);
    }

    #[test]
    fn 大圖裁成正方形_縮成_96_重新編成_png_且通過後台同一套檢查() {
        let u = process(&png_of(300, 200)).unwrap();
        assert!(crate::avatar::validate(&u).is_ok());
        let img = decode_url(&u);
        assert_eq!((img.width(), img.height()), (96, 96));
    }

    #[test]
    fn jpeg_與_webp_也收() {
        let rgb = image::RgbImage::from_fn(200, 150, |x, y| image::Rgb([(x % 256) as u8, (y % 256) as u8, 90]));
        let mut jpg = Vec::new();
        image::codecs::jpeg::JpegEncoder::new(&mut jpg).encode_image(&rgb).unwrap();
        assert!(process(&jpg).is_ok(), "jpeg");
        let mut webp = Vec::new();
        image::codecs::webp::WebPEncoder::new_lossless(&mut webp).write_image(image::DynamicImage::ImageRgb8(rgb).to_rgba8().as_raw(), 200, 150, image::ExtendedColorType::Rgba8).unwrap();
        assert!(process(&webp).is_ok(), "webp");
    }

    #[test]
    fn 不收_svg_gif_與其他格式_也不信副檔名() {
        for bad in [&b"<svg xmlns='http://www.w3.org/2000/svg'/>"[..], b"GIF89a\x01\x00\x01\x00", b"BM\x00\x00", b"%PDF-1.4", b"", b"hello"] {
            assert!(process(bad).unwrap_err().contains("只收 png"), "{:?}", String::from_utf8_lossy(bad));
        }
    }

    #[test]
    fn 原檔超過_5_mb_直接拒絕() {
        let mut big = png_of(8, 8);
        big.resize(MAX_FILE_BYTES as usize + 1, 0);
        assert!(process(&big).unwrap_err().contains("太大"));
    }

    #[test]
    fn 長寬超過上限在解碼前就拒絕_不吃記憶體() {
        // 5000×5000 的全白 png 很小（壓縮後），但宣告的長寬超過 4096
        let img = RgbaImage::from_pixel(5000, 20, Rgba([255, 255, 255, 255]));
        let png = encode_png(&img).unwrap();
        assert!((png.len() as u64) < MAX_FILE_BYTES);
        assert!(process(&png).unwrap_err().contains("讀不了這張圖"));
    }

    #[test]
    fn 損壞的圖拒絕() {
        let mut p = png_of(50, 50);
        p.truncate(40);
        assert!(process(&p).unwrap_err().contains("讀不了這張圖"));
    }

    #[test]
    fn 輸出不帶原檔的_metadata_重新編成的_png_只有圖像區塊() {
        // 在原圖的 png 裡塞一個 tEXt 區塊（模擬 metadata），輸出裡不應該出現
        let src = png_of(40, 40);
        let marker = b"SECRET-EXIF-MARKER";
        let mut chunk = Vec::new();
        chunk.extend_from_slice(&(marker.len() as u32 + 4).to_be_bytes());   // "Keychunk.extend_from_slice(&(marker.len() as u32 + 5).to_be_bytes());" 4 個位元組 + 內容
        let mut body = b"tEXt".to_vec();
        body.extend_from_slice(b"Key\0");
        body.extend_from_slice(marker);
        chunk.extend_from_slice(&body);
        chunk.extend_from_slice(&crc32(&body).to_be_bytes());
        let ihdr_end = 8 + 4 + 4 + 13 + 4;
        let mut with = src[..ihdr_end].to_vec();
        with.extend_from_slice(&chunk);
        with.extend_from_slice(&src[ihdr_end..]);
        assert!(with.windows(marker.len()).any(|w| w == marker), "測試用的原圖要有 metadata");
        let u = process(&with).unwrap();
        let out = base64::engine::general_purpose::STANDARD.decode(u.strip_prefix("data:image/png;base64,").unwrap()).unwrap();
        assert!(!out.windows(marker.len()).any(|w| w == marker), "輸出不能帶原檔的 metadata");
        assert!(!out.windows(4).any(|w| w == b"tEXt" || w == b"eXIf" || w == b"iCCP"), "輸出不該有文字或 EXIF 區塊");
    }

    #[test]
    fn 太複雜的圖縮到最小還是超過_32_kb_就說清楚() {
        // 雜訊圖壓不下去：96／80／64 都超過 32 KB 時回明確說明
        let mut seed = 12345u32;
        let img = RgbaImage::from_fn(600, 600, |_, _| {
            seed = seed.wrapping_mul(1664525).wrapping_add(1013904223);
            Rgba([(seed >> 24) as u8, (seed >> 16) as u8, (seed >> 8) as u8, 255])
        });
        let r = process(&encode_png(&img).unwrap());
        assert!(r.is_err() || crate::avatar::validate(r.as_ref().unwrap()).is_ok());
        if let Err(e) = r {
            assert!(e.contains("太複雜") && e.contains("32 KB"), "{e}");
        }
    }

    fn crc32(data: &[u8]) -> u32 {
        let mut c = !0u32;
        for &b in data {
            c ^= b as u32;
            for _ in 0..8 {
                c = if c & 1 != 0 { 0xedb8_8320 ^ (c >> 1) } else { c >> 1 };
            }
        }
        !c
    }
}

//! 下載用的薄薄一層：只讓流程看到「取一段文字」「下載到寫入器」兩件事，測試用假的就不必連網。
//! 真的那份不跟轉址（官方清單與執行檔都在同一個網域，轉走一律當失敗），並限制大小與時間。

use std::io::Write;
use std::time::Duration;

pub trait Fetch {
    /// 取一小段文字（版本號、清單）；超過 `max` 位元組當失敗
    fn get_text(&self, url: &str, max: u64) -> Result<String, String>;
    /// 下載到 `out`，回傳實際寫入的位元組數；超過 `max` 位元組當失敗
    fn download(&self, url: &str, out: &mut dyn Write, max: u64) -> Result<u64, String>;
}

pub struct RealFetch;

fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(20))
        .timeout(Duration::from_secs(600))
        .build()
        .map_err(|e| format!("無法建立下載連線：{e}"))
}

impl Fetch for RealFetch {
    fn get_text(&self, url: &str, max: u64) -> Result<String, String> {
        let mut buf: Vec<u8> = Vec::new();
        self.download(url, &mut buf, max)?;
        String::from_utf8(buf).map_err(|_| "官方回的內容不是文字".to_string())
    }

    fn download(&self, url: &str, out: &mut dyn Write, max: u64) -> Result<u64, String> {
        crate::rt::block_on(async {
            let c = client()?;
            let mut resp = c.get(url).send().await.map_err(|e| format!("連不上官方下載網站：{e}"))?;
            if !resp.status().is_success() {
                return Err(format!("官方下載網站回 {}（網址不在預期內或服務暫時不可用）", resp.status().as_u16()));
            }
            let mut total: u64 = 0;
            while let Some(chunk) = resp.chunk().await.map_err(|e| format!("下載中斷：{e}"))? {
                total += chunk.len() as u64;
                if total > max {
                    return Err("下載的內容比預期的大，已中止".to_string());
                }
                out.write_all(&chunk).map_err(|e| format!("寫入下載檔失敗：{e}"))?;
            }
            Ok(total)
        })
    }
}

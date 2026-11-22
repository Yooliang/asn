//! `asn-cli claude-usage --shape`（#1883 除錯用）：由程式自己讀這台目前登入的憑證，向額度端點查一次，
//! 只印回應的欄位結構（每個鍵與它的型別名；數字、字串、布林的值一律不印）。不印標頭；失敗只印狀態碼。
//! `--profile-shape`（#1646）：同樣只印結構，但查的是帳號資料端點，且白名單內的固定代碼欄位（方案、計費類型等）會印實際值。
//! 查詢走的是正式查額度的同一個函式（`claude_quota::HttpNet`），遮罩函式見 `claude_quota::shape_of`。
use super::env::Env;
use super::{Io, R};

fn usage() -> &'static str {
    "用法：asn-cli claude-usage --shape | --profile-shape
--shape          讀這台目前登入的憑證，向 Claude 的額度端點查一次，只印回應的欄位結構（每個鍵與它的型別；任何值都不印）。
--profile-shape  向 Claude 的帳號資料端點查一次，只印欄位結構；字串印成 <字串>，只有固定代碼欄位
                 （organization_type、subscription_type、subscription_status、billing_type、rate_limit_tier、has_claude_pro、has_claude_max）印實際值，
                 email、uuid、名字等一律不印。用來比對免費或停訂帳號的回應長什麼樣。
失敗只印狀態碼。供除錯用，結束碼一律 0。"
}

pub async fn main(args: &[String], _env: &Env, io: &mut Io<'_>) -> R<i32> {
    let profile = args.iter().any(|a| a == "--profile-shape");
    if !(profile || args.iter().any(|a| a == "--shape")) || args.iter().any(|a| a == "--help" || a == "-h") {
        io.outln(usage());
        return Ok(0);
    }
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0);
    let home = crate::claude_accounts::claude_home();
    // 查詢是阻塞的（另開執行緒跑），不佔用非同步執行緒
    let out = tokio::task::spawn_blocking(move || {
        let net = crate::claude_quota::HttpNet::real();
        if profile {
            crate::claude_quota::profile_shape_report(&home, now, &net)
        } else {
            crate::claude_quota::shape_report(&home, now, &net)
        }
    })
    .await
    .unwrap_or_else(|_| "查詢沒有完成".into());
    io.outln(&out);
    Ok(0)
}

#[cfg(test)]
mod tests {
    /// --help 列出的「會印實際值的欄位」要跟程式的白名單一字不差（#2080 一審：白名單加了 subscription_status，說明卻沒跟上）
    #[test]
    fn 說明列出的欄位等於白名單() {
        let text = super::usage();
        let start = text.find("（organization_type").expect("說明裡找不到欄位清單") + "（".len();
        let end = start + text[start..].find('）').expect("欄位清單沒有結尾括號");
        let listed: Vec<&str> = text[start..end].split('、').collect();
        assert_eq!(listed, crate::claude_quota::PROFILE_VALUE_KEYS.to_vec());
    }
}

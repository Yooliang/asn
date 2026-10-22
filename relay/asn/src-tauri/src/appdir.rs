//! 安卓 App 私有資料夾的算法（純函式，電腦上也能測）。
//! 安卓沒有 HOME／APPDATA。App 的私有資料夾固定是 `/data/user/<使用者編號>/<套件名>/files`：
//! - 套件名＝行程名稱（`/proc/self/cmdline` 的第一段；預設行程名稱就是套件名）；讀不到或不合格就用 `tw.yooliang.asn`
//! - 使用者編號＝App 的 uid ÷ 100000（主要使用者是 0；工作資料夾、訪客是別的編號）
//! 這個資料夾只有本 App 讀得到（系統沙盒），再加上 0600 權限；金鑰與登入存檔都放在這裡面。
#![cfg_attr(not(target_os = "android"), allow(dead_code))]
use std::path::PathBuf;

/// 上架後不能改的套件名（tauri.android.conf.json 的 identifier 也是它）
pub const PACKAGE: &str = "tw.yooliang.asn";

/// 套件名的格式：點隔開的幾段，每段是英數底線、不以數字開頭
pub fn valid_package(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 128
        && s.contains('.')
        && s.split('.').all(|seg| !seg.is_empty() && !seg.starts_with(|c: char| c.is_ascii_digit()) && seg.chars().all(|c| c.is_ascii_alphanumeric() || c == '_'))
}

/// `/proc/self/cmdline` 的內容（以 NUL 分隔）→ 套件名；行程名稱後面可能帶 `:服務名`，不是主行程就不採用
pub fn package_from_cmdline(raw: &[u8]) -> Option<String> {
    let first = raw.split(|b| *b == 0).next()?;
    let s = std::str::from_utf8(first).ok()?.trim();
    valid_package(s).then(|| s.to_string())
}

pub fn user_of_uid(uid: u32) -> u32 {
    uid / 100_000
}

pub fn files_dir_for(package: &str, user: u32) -> PathBuf {
    PathBuf::from(format!("/data/user/{user}/{package}/files"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 套件名格式() {
        assert!(valid_package("tw.yooliang.asn") && valid_package("com.example.a_b"));
        for bad in ["", "asn", "tw..asn", "1tw.asn", "tw.yooliang.asn:push", "tw/yooliang.asn", "../x.y", "tw.yooliang.asn\n"] {
            assert!(!valid_package(bad), "{bad:?}");
        }
        assert_eq!(PACKAGE, "tw.yooliang.asn");
    }

    #[test]
    fn 行程名稱取出套件名() {
        assert_eq!(package_from_cmdline(b"tw.yooliang.asn\0").as_deref(), Some("tw.yooliang.asn"));
        assert_eq!(package_from_cmdline(b"tw.yooliang.asn\0-x\0").as_deref(), Some("tw.yooliang.asn"));
        assert_eq!(package_from_cmdline(b"tw.yooliang.asn:push\0"), None);
        assert_eq!(package_from_cmdline(b"zygote64\0"), None);
        assert_eq!(package_from_cmdline(b""), None);
        assert_eq!(package_from_cmdline(&[0xff, 0xfe, 0]), None);
    }

    #[test]
    fn 私有資料夾路徑() {
        assert_eq!(user_of_uid(10_345), 0);
        assert_eq!(user_of_uid(1_010_345), 10);
        assert_eq!(files_dir_for(PACKAGE, 0), PathBuf::from("/data/user/0/tw.yooliang.asn/files"));
        assert_eq!(files_dir_for(PACKAGE, 10), PathBuf::from("/data/user/10/tw.yooliang.asn/files"));
    }
}

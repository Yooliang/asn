//! 探測失敗的「原因原文」寫進本機 ui.log 之前的遮罩（#2353 一審）。原因原文可能帶家目錄路徑、帳號、金鑰；
//! 這裡不依賴 gui 才有的模組（型號探測在所有桌面建置都會編），所以自成一份小規則：
//! 家目錄路徑 → `~`、email → `<email>`、`token=…` 這類「名稱＋值」→ 值換成 `<隱藏>`、32 字以上的長英數串 → `<token>`，最後限長。
use regex::Regex;
use std::sync::OnceLock;

/// 遮完之後最多留幾個字
pub const REASON_LOG_MAX_CHARS: usize = 200;

struct Rules {
    win_home: Regex,
    unix_home: Regex,
    root_home: Regex,
    email: Regex,
    secret_kv: Regex,
    bearer: Regex,
    long_token: Regex,
}

fn rules() -> &'static Rules {
    static R: OnceLock<Rules> = OnceLock::new();
    R.get_or_init(|| Rules {
        win_home: Regex::new(r#"(?i)[A-Za-z]:(?:\\\\|\\|/)Users(?:\\\\|\\|/)[^\\/\s"'<>:*?|,;)\]]+"#).unwrap(),
        unix_home: Regex::new(r#"(^|[\s"'=(\[,;:])/(?:Users|home)/[^/\\\s"'<>:*?|,;)\]]+"#).unwrap(),
        root_home: Regex::new(r#"(^|[\s"'=(\[,;:])/root([/\\\s"',;:)\]]|$)"#).unwrap(),
        email: Regex::new(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+").unwrap(),
        secret_kv: Regex::new(r#"(?i)(token|api[_-]?key|key|secret|password|passwd|pwd|authorization|credential)(\s*[=:]\s*)("[^"]*"|'[^']*'|\S+)"#).unwrap(),
        bearer: Regex::new(r"(?i)\bbearer\s+\S+").unwrap(),
        long_token: Regex::new(r"[A-Za-z0-9_\-+=]{32,}").unwrap(),
    })
}

/// 遮一段原因原文，給 ui.log 與 `Debug` 之外的任何地方用。順序：家目錄 → email → 名稱＋值 → 長字串 → 限長
pub fn mask_reason(raw: &str) -> String {
    let r = rules();
    let s = r.win_home.replace_all(raw, "~").into_owned();
    let s = r.unix_home.replace_all(&s, "${1}~").into_owned();
    let s = r.root_home.replace_all(&s, "${1}~${2}").into_owned();
    let s = r.email.replace_all(&s, "<email>").into_owned();
    let s = r.bearer.replace_all(&s, "bearer=<隱藏>").into_owned();
    let s = r.secret_kv.replace_all(&s, "${1}=<隱藏>").into_owned();
    let s = r.long_token.replace_all(&s, "<token>").into_owned();
    // 換行等控制字元壓成空白（一筆記錄一行）、限長
    let one_line: String = s.chars().map(|c| if c.is_control() { ' ' } else { c }).collect();
    let t = one_line.trim();
    if t.chars().count() > REASON_LOG_MAX_CHARS {
        let cut: String = t.chars().take(REASON_LOG_MAX_CHARS).collect();
        format!("{cut}…")
    } else {
        t.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 家目錄路徑_三種寫法都遮() {
        assert_eq!(mask_reason(r"pi 起不來：C:\Users\someone\AppData\pi.exe"), r"pi 起不來：~\AppData\pi.exe");
        assert_eq!(mask_reason("開不了 /home/alice/.pi/x"), "開不了 ~/.pi/x");
        assert_eq!(mask_reason("在 /Users/Bob/bin"), "在 ~/bin");
        assert_eq!(mask_reason("在 /root/.pi"), "在 ~/.pi");
    }

    #[test]
    fn 金鑰與長字串與_email_都遮() {
        let m = mask_reason("token=SECRET123 api_key: abc password=\"p w\" Authorization: Bearer zzz9 ok");
        assert!(!m.contains("SECRET123") && !m.contains("abc") && !m.contains("p w") && !m.contains("zzz9") && m.contains("<隱藏>"), "{m}");
        let long = "x".repeat(40);
        assert_eq!(mask_reason(&format!("壞了 {long} 結束")), "壞了 <token> 結束");
        assert_eq!(mask_reason("帳號 a.b@corp.example.com 失敗"), "帳號 <email> 失敗");
    }

    #[test]
    fn 限長且壓成一行_一般文字不動() {
        assert_eq!(mask_reason("pi 逾時沒有回應"), "pi 逾時沒有回應");
        let m = mask_reason(&format!("a\nb\t{}", "好 ".repeat(300)));
        assert!(!m.contains('\n') && !m.contains('\t') && m.chars().count() <= REASON_LOG_MAX_CHARS + 1, "{}", m.chars().count());
    }
}

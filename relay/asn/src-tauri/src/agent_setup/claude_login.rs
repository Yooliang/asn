//! Claude Code 的「授權碼送回型」登入（#628）：`claude auth login --claudeai` 會印出登入網址，授權碼從標準輸入讀；
//! 登入後用 `claude auth status` 確認（結束碼 0 才算已登入）。不讀、不寫 `.credentials.json`，不用長效權杖的登入方式。

use super::login::{Limits, LoginEngine, Outcome, Phone, Step};
use super::proc::{reap_stale, run_capture, RealSpawner};
use std::path::{Path, PathBuf};
use std::time::Duration;

/// 登入網址只收這些網域（含子網域）的 https
const ALLOWED_HOSTS: [&str; 3] = ["claude.ai", "claude.com", "anthropic.com"];
const STATUS_TIMEOUT: Duration = Duration::from_secs(30);

/// 網址的主機是不是官方網域：只收 https、不帶帳號密碼、埠只能是 443、主機要是白名單網域本身或其子網域
pub fn host_allowed(url: &str) -> bool {
    let Some(rest) = url.strip_prefix("https://") else { return false };
    if url.chars().any(|c| c.is_whitespace() || c.is_control() || !c.is_ascii() || c == '\\') {
        return false;
    }
    let end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    let authority = &rest[..end];
    if authority.is_empty() || authority.contains('@') {
        return false;
    }
    let host = match authority.split_once(':') {
        Some((h, port)) if port == "443" => h,
        Some(_) => return false,
        None => authority,
    };
    let host = host.to_ascii_lowercase();
    ALLOWED_HOSTS.iter().any(|h| host == *h || host.ends_with(&format!(".{h}")))
}

/// 一行輸出裡的第一個登入網址（去掉結尾的標點與括號）；第一個 https 不是官方網域就整行不要，不去挑後面的
pub fn url_in_line(line: &str) -> Option<String> {
    let start = line.find("https://")?;
    let tok: String = line[start..].chars().take_while(|c| !c.is_whitespace()).collect();
    let tok = tok.trim_end_matches(['.', ',', ')', ']', '>', '"', '\'', ';']).to_string();
    host_allowed(&tok).then_some(tok)
}

/// 取一個短命令的輸出與結束碼；真的環境走 `run_capture`，測試用假的
pub trait CaptureRunner {
    fn run(&self, exe: &Path, args: &[&str], timeout: Duration) -> Result<(i32, String), String>;
}

pub struct RealCapture;
impl CaptureRunner for RealCapture {
    fn run(&self, exe: &Path, args: &[&str], timeout: Duration) -> Result<(i32, String), String> {
        run_capture(exe, args, timeout)
    }
}

pub struct ClaudeLogin<'a> {
    pub exe: PathBuf,
    pub runner: &'a dyn CaptureRunner,
}

impl LoginEngine for ClaudeLogin<'_> {
    fn exe(&self) -> PathBuf {
        self.exe.clone()
    }

    fn args(&self) -> Vec<&'static str> {
        vec!["auth", "login", "--claudeai"]
    }

    fn find_url(&self, line: &str) -> Option<String> {
        url_in_line(line)
    }

    fn invalid_code_hint(&self, line: &str) -> bool {
        let l = line.to_lowercase();
        l.contains("invalid code") || l.contains("oauth error") || l.contains("expired")
    }

    fn check_login(&self) -> Result<bool, String> {
        let (code, out) = self.runner.run(&self.exe, &["auth", "status"], STATUS_TIMEOUT).map_err(|e| format!("問不出登入狀態：{e}"))?;
        if code != 0 {
            return Ok(false);
        }
        // 結束碼 0＝已登入；輸出若是 JSON 且寫了登入方式，必須是 claude.ai（不是 API 計費等別的方式）
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(out.trim()) {
            if let Some(m) = v.get("authMethod").and_then(|x| x.as_str()) {
                return Ok(m == "claude.ai");
            }
        }
        Ok(true)
    }
}

/// 真的環境：在這台電腦上用手機登入 Claude Code。呼叫端（桌面按鈕、遠端指令）自己負責「本人簽章放行」
pub fn login_here(phone: &dyn Phone, report: &dyn Fn(Step)) -> Outcome {
    let Some(home) = std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME")).map(PathBuf::from) else {
        return Outcome::Failed("找不到使用者資料夾".to_string());
    };
    let exe = home.join(".local").join("bin").join("claude.exe");
    if !exe.exists() {
        return Outcome::Failed("還沒有安裝 Claude Code，請先安裝".to_string());
    }
    let pid_file = crate::identity::relay_home().join("setup").join("login.pid");
    // 上次 ASN 被關掉時可能留下的登入程序
    if reap_stale(&pid_file) {
        elog!("已結束上次留下的登入程序");
    }
    let eng = ClaudeLogin { exe, runner: &RealCapture };
    let sp = RealSpawner { pid_file: Some(pid_file) };
    super::login::run_login(&eng, &sp, phone, &Limits::default(), report)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    #[test]
    fn 網域只收官方_https() {
        for ok in [
            "https://claude.ai/oauth/authorize?x=1",
            "https://www.claude.ai/a",
            "https://platform.claude.com/oauth/authorize",
            "https://console.anthropic.com/oauth",
            "https://claude.ai:443/x",
            "https://CLAUDE.AI/x",
            "https://claude.ai",
        ] {
            assert!(host_allowed(ok), "{ok}");
        }
        for bad in [
            "http://claude.ai/x",
            "https://claude.ai.evil.com/x",
            "https://evilclaude.ai/x",
            "https://claude.ai@evil.com/x",
            "https://evil.com/claude.ai",
            "https://evil.com?x=claude.ai",
            "https://claude.ai:8443/x",
            "https://claude.ai\\@evil.com/x",
            "https://claude。ai/x",
            "https://",
            "https:///claude.ai",
            "https://claude.ai./x",
            "ftp://claude.ai/x",
            "claude.ai",
            "https://claude.ai/x y",
        ] {
            assert!(!host_allowed(bad), "{bad}");
        }
    }

    #[test]
    fn 從一行輸出找出網址() {
        assert_eq!(url_in_line("Open this URL: https://claude.ai/oauth/authorize?a=b&c=d.").as_deref(), Some("https://claude.ai/oauth/authorize?a=b&c=d"));
        assert_eq!(url_in_line("(https://claude.ai/x)").as_deref(), Some("https://claude.ai/x"));
        assert_eq!(url_in_line("Visit https://evil.example/claude.ai now"), None);
        assert_eq!(url_in_line("沒有網址"), None);
        // 同一行有壞網址在前、好網址在後：只看第一個 https，不挑後面的
        assert_eq!(url_in_line("https://evil.example/ https://claude.ai/x"), None);
    }

    struct FakeCapture {
        r: RefCell<Result<(i32, String), String>>,
        seen: RefCell<Vec<Vec<String>>>,
    }
    impl CaptureRunner for FakeCapture {
        fn run(&self, _exe: &Path, args: &[&str], _t: Duration) -> Result<(i32, String), String> {
            self.seen.borrow_mut().push(args.iter().map(|s| s.to_string()).collect());
            self.r.borrow().clone()
        }
    }
    fn eng(fc: &FakeCapture) -> ClaudeLogin<'_> {
        ClaudeLogin { exe: PathBuf::from("claude.exe"), runner: fc }
    }
    fn mk(r: Result<(i32, String), String>) -> FakeCapture {
        FakeCapture { r: RefCell::new(r), seen: RefCell::new(vec![]) }
    }

    #[test]
    fn 登入後確認_結束碼與登入方式() {
        let fc = mk(Ok((0, r#"{"loggedIn":true,"authMethod":"claude.ai"}"#.into())));
        assert_eq!(eng(&fc).check_login(), Ok(true));
        assert_eq!(fc.seen.borrow()[0], vec!["auth".to_string(), "status".to_string()]);
        assert_eq!(eng(&mk(Ok((1, "".into())))).check_login(), Ok(false), "結束碼 1＝沒登入");
        assert_eq!(eng(&mk(Ok((0, r#"{"authMethod":"api_key"}"#.into())))).check_login(), Ok(false), "不是 claude.ai 的登入方式不算");
        assert_eq!(eng(&mk(Ok((0, "Logged in".into())))).check_login(), Ok(true), "輸出不是 JSON 就只看結束碼");
        assert!(eng(&mk(Err("跑太久".into()))).check_login().is_err());
    }

    #[test]
    fn 登入指令固定_不用長效權杖的登入方式() {
        let fc = mk(Ok((0, String::new())));
        assert_eq!(eng(&fc).args(), vec!["auth", "login", "--claudeai"]);
        // 禁用清單：會印出或接收長效權杖的做法不能出現在這支引擎的正式程式碼
        let src = include_str!("claude_login.rs");
        let body = &src[..src.find("#[cfg(test)]").unwrap()];
        for banned in [["setup", "-token"].concat(), ["CLAUDE_CODE_", "OAUTH_TOKEN"].concat(), ["ANTHROPIC_", "API_KEY"].concat()] {
            assert!(!body.contains(&banned), "不能用 {banned}");
        }
    }

    #[test]
    fn 授權碼無效的提示認得() {
        let fc = mk(Ok((0, String::new())));
        let e = eng(&fc);
        assert!(e.invalid_code_hint("OAuth error: Invalid code"));
        assert!(e.invalid_code_hint("code has EXPIRED"));
        assert!(!e.invalid_code_hint("Opening browser"));
    }
}

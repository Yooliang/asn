//! Claude Code 的「授權碼送回型」登入（#628）：`claude auth login --claudeai` 會印出登入網址，授權碼從標準輸入讀；
//! 登入後用 `claude auth status` 確認（結束碼 0 才算已登入）。不讀、不寫 `.credentials.json`，不用長效權杖的登入方式。

use super::authenticode::{SignatureCheck, SystemSignatureCheck};
use super::claude_install::EXPECTED_SIGNER;
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

/// 完整的 OAuth 授權網址一定有這幾個參數；少了任何一個（例如網址被折行截斷）就不當成登入網址，退回開終端機
const REQUIRED_PARAMS: [&str; 4] = ["client_id", "redirect_uri", "state", "code_challenge"];

fn has_required_params(url: &str) -> bool {
    let Some((_, q)) = url.split_once('?') else { return false };
    let q = q.split('#').next().unwrap_or("");
    REQUIRED_PARAMS.iter().all(|k| q.split('&').any(|kv| kv.split('=').next() == Some(*k) && kv.len() > k.len() + 1))
}

/// 一行輸出裡的第一個登入網址（去掉結尾的標點與括號）；第一個 https 不是官方網域、或參數不齊（可能被截斷）就整行不要，不去挑後面的
pub fn url_in_line(line: &str) -> Option<String> {
    let start = line.find("https://")?;
    let tok: String = line[start..].chars().take_while(|c| !c.is_whitespace()).collect();
    let tok = tok.trim_end_matches(['.', ',', ')', ']', '>', '"', '\'', ';']).to_string();
    (host_allowed(&tok) && has_required_params(&tok)).then_some(tok)
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
        // 實測（新家用機）授權碼錯誤時印的是「Login failed: Request failed with status code 400」，結束碼 1，不會再問一次
        l.contains("invalid code") || l.contains("oauth error") || l.contains("expired") || l.contains("login failed") || l.contains("status code 400")
    }

    fn check_login(&self) -> Result<bool, String> {
        let (code, out) = self.runner.run(&self.exe, &["auth", "status"], STATUS_TIMEOUT).map_err(|e| format!("問不出登入狀態：{e}"))?;
        if code != 0 {
            return Ok(false);
        }
        // 結束碼 0 還不夠：輸出必須是 JSON，登入方式是 claude.ai（不是 API 計費等別的方式），有 loggedIn 欄位時必須為 true。
        // 輸出不是 JSON（格式可能改了）就說「無法確認」，不當成已登入
        let v: serde_json::Value = serde_json::from_str(out.trim()).map_err(|_| "無法確認登入狀態（輸出格式不認得）".to_string())?;
        if v.get("loggedIn").and_then(|x| x.as_bool()) == Some(false) {
            return Ok(false);
        }
        Ok(v.get("authMethod").and_then(|x| x.as_str()) == Some("claude.ai"))
    }
}

/// 開始登入前先確認要交出授權碼的那支程式是官方的（簽章有效、簽署者完全等於 Anthropic, PBC）
pub fn precheck_exe(exe: &Path, sig: &dyn SignatureCheck) -> Result<(), String> {
    let who = sig.signer(exe).map_err(|e| format!("claude.exe 的數位簽章沒通過，沒有開始登入：{e}"))?;
    if who != EXPECTED_SIGNER {
        return Err("claude.exe 的簽署者不是 Anthropic, PBC，沒有開始登入".to_string());
    }
    Ok(())
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
    if let Err(e) = precheck_exe(&exe, &SystemSignatureCheck) {
        return Outcome::Failed(e);
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
        let q = "client_id=C&redirect_uri=R&state=S&code_challenge=H";
        assert_eq!(url_in_line(&format!("Open this URL: https://claude.ai/oauth/authorize?{q}.")).as_deref(), Some(format!("https://claude.ai/oauth/authorize?{q}").as_str()));
        assert_eq!(url_in_line(&format!("(https://claude.ai/x?{q})")).as_deref(), Some(format!("https://claude.ai/x?{q}").as_str()));
        assert_eq!(url_in_line(&format!("Visit https://evil.example/claude.ai?{q} now")), None);
        assert_eq!(url_in_line("沒有網址"), None);
        // 同一行有壞網址在前、好網址在後：只看第一個 https，不挑後面的
        assert_eq!(url_in_line(&format!("https://evil.example/ https://claude.ai/x?{q}")), None);
    }

    #[test]
    fn 參數不齊的網址不收_可能被折行截斷() {
        // 網域對、但少了參數（長網址被折行時第一段就是這樣）→ 不當成登入網址
        for cut in [
            "https://claude.ai/oauth/authorize?code=true&client_id=C&redirect_uri=R",
            "https://claude.ai/oauth/authorize?client_id=C&redirect_uri=R&state=S",
            "https://claude.ai/oauth/authorize",
            "https://claude.ai/oauth/authorize?client_id=&redirect_uri=R&state=S&code_challenge=H",
            "https://claude.ai/oauth/authorize?client_id=C&redirect_uri=R&state=S&code_challenge",
        ] {
            assert_eq!(url_in_line(cut), None, "{cut}");
        }
        // 參數齊全（順序、多的參數不影響）
        assert!(url_in_line("https://claude.ai/o?code_challenge=H&state=S&client_id=C&redirect_uri=R&x=1").is_some());
        // 值裡有 key 名稱不算
        assert_eq!(url_in_line("https://claude.ai/o?x=client_id&y=redirect_uri&z=state&w=code_challenge"), None);
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
        assert!(eng(&mk(Ok((0, "Logged in".into())))).check_login().is_err(), "輸出不是 JSON：無法確認，不當成已登入");
        assert_eq!(eng(&mk(Ok((0, r#"{"loggedIn":false,"authMethod":"claude.ai"}"#.into())))).check_login(), Ok(false), "loggedIn 為 false 不算");
        assert_eq!(eng(&mk(Ok((0, r#"{"loggedIn":true}"#.into())))).check_login(), Ok(false), "沒寫登入方式不算");
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

    struct FakeSig(Result<String, String>);
    impl SignatureCheck for FakeSig {
        fn signer(&self, _p: &Path) -> Result<String, String> {
            self.0.clone()
        }
    }

    #[test]
    fn 開始登入前先確認_claude_exe_是官方的() {
        let p = Path::new("claude.exe");
        assert!(precheck_exe(p, &FakeSig(Ok(EXPECTED_SIGNER.into()))).is_ok());
        assert!(precheck_exe(p, &FakeSig(Ok("Someone Else".into()))).unwrap_err().contains("沒有開始登入"));
        assert!(precheck_exe(p, &FakeSig(Err("沒有簽章".into()))).unwrap_err().contains("沒有開始登入"));
    }

    #[test]
    fn 授權碼無效的提示認得() {
        let fc = mk(Ok((0, String::new())));
        let e = eng(&fc);
        assert!(e.invalid_code_hint("OAuth error: Invalid code"));
        assert!(e.invalid_code_hint("code has EXPIRED"));
        // 實測的真實輸出
        assert!(e.invalid_code_hint("Login failed: Request failed with status code 400"));
        assert!(!e.invalid_code_hint("Opening browser"));
    }
}

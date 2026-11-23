//! 「送記錄給開發者」的出口（#2129 ②）：把這台的 ui.log（含輪替後的 ui.log.1）依時間範圍取出，在「送出這一層」統一遮罩，
//! 回給畫面預覽，或存成一個文字附件寄到固定的私人「ASN 開發」群組。電腦與手機共用。
//!
//! 遮罩只在這裡做：本機的 ui.log 照舊保留完整路徑（ui_log::append 只遮 email，不遮家目錄與權杖樣式的字串；有測試守著）。
//! 遮三大類：email；祕密（password／secret／token／api_key／authorization 這類鍵後面的值、私鑰整段、AKIA 金鑰、gh*_ 與 github_pat_、sk-…、Bearer …、JWT 三段式、32 字以上含數字的英數長串）；家目錄路徑（任何使用者的 Windows、macOS、Linux 家目錄與 /root，換成 ~）。
//! 收件處 `RECIPIENT_ROOM` 是寫死的設定值，目前留空（群組還沒建立）：留空一律拒絕寄出，不碰網路。
use serde_json::{json, Value};
use std::path::Path;

/// 收件處：私人「ASN 開發」群組的代號。群組由擁有者建立後才填；留空＝一律不能寄（領隊 asn真 11-23 的決定，見 #2129）
pub const RECIPIENT_ROOM: &str = "";

/// 最多取幾行（取最新的）
pub const MAX_LINES: usize = 2000;
/// 附件總大小上限（位元組）：超過只留最新的部分
pub const MAX_BYTES: usize = 1024 * 1024;

pub const NO_RECIPIENT_MSG: &str = "還沒設定記錄的收件處，暫時不能寄";

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Range {
    Hour1,
    Hour24,
    Day7,
}

impl Range {
    /// "1h"、"24h"、"7d"；沒給（None 或空字串）＝預設 24 小時；其他字串回錯誤
    pub fn parse(s: Option<&str>) -> Result<Range, String> {
        match s.map(str::trim).unwrap_or("") {
            "" | "24h" => Ok(Range::Hour24),
            "1h" => Ok(Range::Hour1),
            "7d" => Ok(Range::Day7),
            _ => Err("記錄的範圍只能選最近 1 小時、24 小時或 7 天".into()),
        }
    }
    pub fn ms(self) -> i64 {
        match self {
            Range::Hour1 => 3_600_000,
            Range::Hour24 => 86_400_000,
            Range::Day7 => 7 * 86_400_000,
        }
    }
    pub fn label(self) -> &'static str {
        match self {
            Range::Hour1 => "最近 1 小時",
            Range::Hour24 => "最近 24 小時",
            Range::Day7 => "最近 7 天",
        }
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct MaskCounts {
    pub email: usize,
    pub token: usize,
    pub home: usize,
}

impl MaskCounts {
    fn add(&mut self, o: MaskCounts) {
        self.email += o.email;
        self.token += o.token;
        self.home += o.home;
    }
    fn to_json(self) -> Value {
        json!({ "email": self.email, "token": self.token, "home": self.home })
    }
}

#[derive(Debug, PartialEq)]
pub struct Report {
    pub text: String,
    pub lines: usize,
    pub bytes: usize,
    pub masked: MaskCounts,
    pub range: Range,
}

impl Report {
    pub fn to_json(&self) -> Value {
        json!({
            "text": self.text,
            "lines": self.lines,
            "bytes": self.bytes,
            "masked": self.masked.to_json(),
            "range": self.range.label(),
        })
    }
}

struct Rule {
    re: regex::Regex,
    rep: &'static str,
    /// 比對到的字串要有數字才算（長串那條用，整串純字母不遮）
    need_digit: bool,
}

fn token_rules() -> &'static [Rule] {
    static RE: std::sync::OnceLock<Vec<Rule>> = std::sync::OnceLock::new();
    RE.get_or_init(|| {
        let r = |p: &str, rep: &'static str, need_digit: bool| Rule { re: regex::Regex::new(p).unwrap(), rep, need_digit };
        vec![
            // 鍵值類：鍵名（大小寫不分，前面可以有別的字，例如 refresh_token、x-api-key）後面接 = 或 :，值整個遮掉。
            // 三種寫法都抓：key=value、key: value、"key": "value"（含單引號）；authorization 後面的 Bearer／Basic 連同憑證一起遮。
            // 鍵名後面一定要緊接引號、空白或 = :，所以 tokenizer、token_count 這類字不會被當成鍵
            r(r#"(?i)(["']?[A-Za-z0-9_.-]*(?:password|passwd|secret|token|api[_-]?key|authorization)["']?\s*[:=]\s*)("[^"]*"|'[^']*'|(?:bearer|basic)\s+[^\s,;"'}]+|[^\s,;&"'}]+)"#, "${1}<secret>", false),
            // JWT 三段式：eyJ 開頭的 base64url 三段，以點相連
            r(r"eyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}", "<token>", false),
            // Bearer 後面接的整串
            r(r"(?i)\bBearer\s+[A-Za-z0-9._~+/=-]{8,}", "Bearer <token>", false),
            // AWS 存取金鑰：AKIA 後面 16 個大寫英數（不足長度不遮）
            r(r"\bAKIA[0-9A-Z]{16}\b", "<token>", false),
            // GitHub：gh 加 p／o／u／s／r 再底線，後面 20 字以上；細粒度的 github_pat_
            r(r"\bgh[pousr]_[A-Za-z0-9]{20,}", "<token>", false),
            r(r"\bgithub_pat_[A-Za-z0-9_]{20,}", "<token>", false),
            // sk- 開頭的金鑰（sk-ant-…、sk-proj-… 都有連字號與底線）
            r(r"\bsk-[A-Za-z0-9_-]{16,}", "<token>", false),
            // 32 字以上、只含英數與 +=、而且至少有一個數字的長串（hex、base64）。不含 / - _：路徑與 kebab-case 的長名字不會誤遮
            r(r"[A-Za-z0-9+=]{32,}", "<token>", true),
        ]
    })
}

/// 私鑰：從 BEGIN 到 END 整段（同一行或跨行都行）；只有 BEGIN 沒有 END 就遮到行尾
const KEY_MARK: &str = "<private-key>";
fn key_regex() -> &'static regex::Regex {
    static RE: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    RE.get_or_init(|| regex::Regex::new(r"(?s)-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----(?:.*?-----END [A-Z0-9 ]*PRIVATE KEY-----|[^\n]*)").unwrap())
}

/// 通用的家目錄規則（不只目前這個使用者）：Windows 的 `X:\Users\<名>`（反斜線、正斜線、JSON 的雙反斜線都算）、
/// macOS 的 `/Users/<名>`、Linux 的 `/home/<名>`、`/root`。名字一律整個吃到下一個路徑分隔，所以 bobby 不會變成「~by」
fn generic_home_regexes() -> &'static (regex::Regex, regex::Regex, regex::Regex) {
    static RE: std::sync::OnceLock<(regex::Regex, regex::Regex, regex::Regex)> = std::sync::OnceLock::new();
    RE.get_or_init(|| {
        (
            regex::Regex::new(r#"(?i)[A-Za-z]:(?:\\\\|\\|/)Users(?:\\\\|\\|/)[^\\/\s"'<>:*?|,;)\]]+"#).unwrap(),
            regex::Regex::new(r#"(^|[\s"'=(\[,;:])/(?:Users|home)/[^/\\\s"'<>:*?|,;)\]]+"#).unwrap(),
            regex::Regex::new(r#"(^|[\s"'=(\[,;:])/root([/\\\s"',;:)\]]|$)"#).unwrap(),
        )
    })
}

/// 家目錄的各種寫法：原樣、斜線版、JSON 跳脫的雙反斜線版；比對不分大小寫（Windows 路徑）。太短（例如 "/"）不遮
fn home_regex(home: &str) -> Option<regex::Regex> {
    let h = home.trim().trim_end_matches(['/', '\\']);
    if h.chars().count() < 3 {
        return None;
    }
    let mut forms = vec![h.to_string(), h.replace('\\', "/"), h.replace('\\', "\\\\")];
    forms.sort();
    forms.dedup();
    let alt = forms.iter().map(|f| regex::escape(f)).collect::<Vec<_>>().join("|");
    // 後面一定要接路徑分隔、空白、標點或字串結尾（捕捉起來原樣放回）：名字只是前綴相同的別人（bobby）不吃這一條
    regex::Regex::new(&format!(r#"(?i)(?:{alt})([\\/\s"',;:)\]]|$)"#)).ok()
}

/// 送出前遮一行：先家目錄、再 email、最後權杖樣式。回遮過的行與各種遮了幾處。
/// 只給送出出口用（預覽、寄出）；寫本機 ui.log 的 append 不呼叫這個
pub fn redact_line(line: &str, home: Option<&regex::Regex>) -> (String, MaskCounts) {
    let mut c = MaskCounts::default();
    // 私鑰整段先處理（裡面的內容不能再被別的規則切碎）
    let mut s = key_regex().replace_all(line, KEY_MARK).into_owned();
    c.token += s.matches(KEY_MARK).count();
    // 家目錄：先換目前使用者那一條（名字可以有空白），再套通用規則
    if let Some(re) = home {
        c.home += re.find_iter(&s).count();
        s = re.replace_all(&s, "~$1").into_owned();
    }
    let (win, unix, root) = generic_home_regexes();
    c.home += win.find_iter(&s).count() + unix.find_iter(&s).count() + root.find_iter(&s).count();
    s = win.replace_all(&s, "~").into_owned();
    s = unix.replace_all(&s, "${1}~").into_owned();
    s = root.replace_all(&s, "${1}~${2}").into_owned();
    let before = s.matches("<email>").count();
    s = crate::ui_log::mask_emails(&s);
    c.email = s.matches("<email>").count().saturating_sub(before);
    for rule in token_rules() {
        let mut n = 0;
        s = rule
            .re
            .replace_all(&s, |caps: &regex::Captures| {
                let m = &caps[0];
                if rule.need_digit && !m.bytes().any(|b| b.is_ascii_digit()) {
                    return m.to_string();
                }
                n += 1;
                let mut out = String::new();
                caps.expand(rule.rep, &mut out);
                out
            })
            .into_owned();
        c.token += n;
    }
    (s, c)
}

fn read_lines(p: &Path) -> Vec<String> {
    match std::fs::read(p) {
        // 私鑰跨行的整段先在整份檔案上遮掉：本文每一行都沒有時間戳，逐行處理會漏
        Ok(b) => {
            let t = String::from_utf8_lossy(&b);
            key_regex().replace_all(&t, KEY_MARK).lines().map(str::to_string).collect()
        }
        Err(_) => vec![],
    }
}

/// 行首的時間戳（`2026-11-23T08:00:00.000Z info …`）→ 毫秒；解析不出來回 None
fn line_ms(l: &str) -> Option<i64> {
    crate::timeutil::parse_ts_ms(l.split_whitespace().next()?)
}

/// 讀 dir 底下的 ui.log.1 與 ui.log，取範圍內最新的 MAX_LINES 行，逐行遮罩，總大小超過 MAX_BYTES 就只留最新的部分
pub fn collect(dir: &Path, range: Range, now_ms: i64, home: &str) -> Report {
    let mut rows: Vec<String> = read_lines(&dir.join(crate::ui_log::UI_LOG_OLD_FILE));
    rows.extend(read_lines(&crate::ui_log::path(dir)));
    let since = now_ms - range.ms();
    // 時間戳解析不出來的行（不是這個程式寫的）不收；沒有時間戳就沒辦法判斷範圍
    rows.retain(|l| line_ms(l).map_or(false, |t| t >= since && t <= now_ms + 60_000));
    if rows.len() > MAX_LINES {
        rows.drain(..rows.len() - MAX_LINES);
    }
    let home_re = home_regex(home);
    let masked: Vec<(String, MaskCounts)> = rows.iter().map(|l| redact_line(l, home_re.as_ref())).collect();
    // 從最新的往回累計，超過上限就停（每行加一個換行）
    let mut total = 0usize;
    let mut start = masked.len();
    while start > 0 {
        let add = masked[start - 1].0.len() + 1;
        if total + add > MAX_BYTES {
            break;
        }
        total += add;
        start -= 1;
    }
    let kept = &masked[start..];
    let mut counts = MaskCounts::default();
    let mut text = String::with_capacity(total);
    for (l, c) in kept {
        text.push_str(l);
        text.push('\n');
        counts.add(*c);
    }
    Report { lines: kept.len(), bytes: text.len(), text, masked: counts, range }
}

/// 收件處沒設定（空白）就回白話錯誤；有設定才回去掉空白的代號
pub fn check_recipient(room: &str) -> Result<&str, String> {
    let r = room.trim();
    if r.is_empty() {
        Err(NO_RECIPIENT_MSG.into())
    } else if !crate::relay::valid_room_id(r) {
        Err("記錄的收件處設定格式不對，暫時不能寄".into())
    } else {
        Ok(r)
    }
}

/// 寄給群組用的附件內容（交給 attach::send_attachment_signed，kind=file 的 .txt）；內文自動帶 App 版本、平台、時間範圍
pub fn build_payload(room: &str, rep: &Report, version: &str, platform: &str, now_ms: i64) -> Value {
    use base64::{engine::general_purpose::STANDARD, Engine};
    let stamp: String = crate::auth_notice::iso_secs(now_ms).chars().filter(|c| c.is_ascii_digit()).take(12).collect();
    let caption = format!("ASN 記錄｜版本 {version}｜平台 {platform}｜範圍 {}｜{} 行", rep.range.label(), rep.lines);
    json!({
        "kind": "file",
        "name": format!("asn-log-{stamp}.txt"),
        "data": STANDARD.encode(rep.text.as_bytes()),
        "room": room,
        "caption": caption,
    })
}

/// 寄出的流程：先檢查收件處（沒設定就在這裡擋下，`send` 一次都不會被呼叫＝不碰網路），再產生內容，最後呼叫 `send` 送出
pub async fn send_with<F, Fut>(room: &str, dir: &Path, range: Option<&str>, now_ms: i64, home: &str, send: F) -> Result<Value, String>
where
    F: FnOnce(Value) -> Fut,
    Fut: std::future::Future<Output = Result<Value, String>>,
{
    let room = check_recipient(room)?;
    let range = Range::parse(range)?;
    let rep = collect(dir, range, now_ms, home);
    if rep.lines == 0 {
        return Err("這段時間沒有記錄可寄".into());
    }
    let payload = build_payload(room, &rep, env!("CARGO_PKG_VERSION"), std::env::consts::OS, now_ms);
    send(payload).await?;
    Ok(json!({ "ok": true, "lines": rep.lines, "bytes": rep.bytes, "masked": rep.masked.to_json(), "range": rep.range.label() }))
}

#[cfg(test)]
mod tests {
    use super::*;

    const HOME_WIN: &str = r"C:\Users\fakeuser";
    const NOW: i64 = 1_795_000_000_000;

    fn iso(ms: i64) -> String {
        crate::auth_notice::iso_secs(ms)
    }
    fn write_logs(dir: &Path, old: &[String], cur: &[String]) {
        let j = |v: &[String]| v.iter().map(|l| format!("{l}\n")).collect::<String>();
        std::fs::write(dir.join("ui.log.1"), j(old)).unwrap();
        std::fs::write(dir.join("ui.log"), j(cur)).unwrap();
    }
    fn line(ago_ms: i64, rest: &str) -> String {
        format!("{} info [ASN] {rest}", iso(NOW - ago_ms))
    }
    fn run<T>(f: impl std::future::Future<Output = T>) -> T {
        tokio::runtime::Builder::new_current_thread().build().unwrap().block_on(f)
    }

    #[test]
    fn 遮_email_正例與反例() {
        let (o, c) = redact_line("登入失敗 fake.user@example.com 再試", None);
        assert_eq!(o, "登入失敗 <email> 再試");
        assert_eq!(c.email, 1);
        let (o, c) = redact_line("版本 1.2.3 單獨的 @ 符號 x @ y", None);
        assert_eq!(o, "版本 1.2.3 單獨的 @ 符號 x @ y");
        assert_eq!(c, MaskCounts::default());
    }

    #[test]
    fn 遮權杖_各種樣式正例() {
        let jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJmYWtlIn0.c2lnbmF0dXJlZmFrZQ";
        let (o, c) = redact_line(&format!("jwt={jwt} end"), None);
        assert_eq!(o, "jwt=<token> end");
        assert_eq!(c.token, 1);
        let (o, c) = redact_line("header X-Foo: Bearer abcDEF123456.fake-token_xyz done", None);
        assert_eq!(o, "header X-Foo: Bearer <token> done");
        assert_eq!(c.token, 1);
        let (o, c) = redact_line("key sk-ant-api03-FAKEFAKEFAKEFAKE1234 ok", None);
        assert_eq!(o, "key <token> ok");
        assert_eq!(c.token, 1);
        let hex = "0123456789abcdef0123456789abcdef01234567";
        let (o, c) = redact_line(&format!("sha {hex} x"), None);
        assert_eq!(o, "sha <token> x");
        assert_eq!(c.token, 1);
        let b64 = "QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVowMTIzNDU2Nzg5";
        let (o, _) = redact_line(&format!("b64 {b64}"), None);
        assert_eq!(o, "b64 <token>");
    }

    #[test]
    fn 遮權杖_反例不誤遮() {
        for s in [
            "commit 0123abc 短的十六進位不遮",
            "uuid 0a1b2c3d-4e5f-6a7b-8c9d-0e1f2a3b4c5d 有連字號不遮",
            "a-very-long-kebab-case-name-with-many-dashes-in-it 不遮",
            "純字母的長字 abcdefghijklmnopqrstuvwxyzabcdefghijklmnop 沒有數字不遮",
            "path /usr/local/share/some/long/directory/name/here/x 不遮",
            "sk-short 太短不遮 Bearer 也不遮 token",
        ] {
            let (o, c) = redact_line(s, None);
            assert_eq!(o, s, "不該被遮：{s}");
            assert_eq!(c.token, 0, "{s}");
        }
    }

    #[test]
    fn 遮家目錄_目前使用者_正例與反例() {
        let re = home_regex(HOME_WIN);
        let (o, c) = redact_line(r"open C:\Users\fakeuser\AppData\x.json and c:/users/fakeuser/y", re.as_ref());
        assert_eq!(o, r"open ~\AppData\x.json and ~/y");
        assert_eq!(c.home, 2);
        let (o, c) = redact_line(r#"{"p":"C:\\Users\\fakeuser\\z"}"#, re.as_ref());
        assert_eq!(o, r#"{"p":"~\\z"}"#);
        assert_eq!(c.home, 1);
        // 名字有空白的使用者（通用規則吃不到空白，靠這條）
        let sp = home_regex(r"C:\Users\John Smith");
        let (o, _) = redact_line(r"open C:\Users\John Smith\x.txt", sp.as_ref());
        assert_eq!(o, r"open ~\x.txt");
        // 家目錄是空的或太短就不套這一條
        assert!(home_regex("").is_none() && home_regex("/").is_none());
        let (o, _) = redact_line("/home/bob/x", home_regex("/home/bob").as_ref());
        assert_eq!(o, "~/x");
    }

    #[test]
    fn 遮家目錄_通用規則_任何使用者_各平台() {
        for (src, want) in [
            (r"open C:\Users\anyone\AppData\x", r"open ~\AppData\x"),
            (r"open d:/users/zed/y.txt", "open ~/y.txt"),
            (r#"{"p":"E:\\Users\\kim\\z"}"#, r#"{"p":"~\\z"}"#),
            (r"C:\Users\anyone", "~"),
            ("read /Users/alice/Library/x", "read ~/Library/x"),
            ("read /home/carol/.config/asn", "read ~/.config/asn"),
            ("path=/home/dave/x", "path=~/x"),
            ("cwd /root/work and /root", "cwd ~/work and ~"),
            ("(/root)", "(~)"),
        ] {
            let (o, c) = redact_line(src, None);
            assert_eq!(o, want, "{src}");
            assert!(c.home >= 1, "{src}");
        }
    }

    #[test]
    fn 遮家目錄_邊界_bobby_不會變成_by_與看起來像但不是家目錄的路徑() {
        // 目前使用者是 bob，路徑是 bobby：名字整個遮掉，不能漏出「by」
        let re = home_regex(r"C:\Users\bob");
        let (o, _) = redact_line(r"C:\Users\bobby\x", re.as_ref());
        assert_eq!(o, r"~\x");
        assert!(!o.contains("by"));
        let (o, _) = redact_line(r"C:\Users\bob\x", re.as_ref());
        assert_eq!(o, r"~\x");
        let (o, _) = redact_line("/home/bobby/x and /home/bob", home_regex("/home/bob").as_ref());
        assert_eq!(o, "~/x and ~");
        assert!(!o.contains("by"));
        // 反例：不是家目錄的就不動
        for s in [
            "mount /rootfs/x and /roots",
            "https://example.com/home/page",
            "see /homes/x and /usr/home",
            r"C:\Windows\System32 與 D:\Program Files\x",
            "Users home 只是兩個字",
        ] {
            let (o, c) = redact_line(s, None);
            assert_eq!(o, s, "不該被遮：{s}");
            assert_eq!(c.home, 0, "{s}");
        }
    }

    #[test]
    fn 遮鍵值類_正例_三種寫法_大小寫不分() {
        for (src, left) in [
            ("login password=hunter2 ok", "login password=<secret> ok"),
            ("PASSWORD: abc123", "PASSWORD: <secret>"),
            ("passwd=x", "passwd=<secret>"),
            ("secret = s3cr3t-v4lue", "secret = <secret>"),
            ("token=ab/cd-ef_gh", "token=<secret>"),
            ("x-api-key=abc", "x-api-key=<secret>"),
            ("api_key='k-1/2'", "api_key=<secret>"),
            ("apikey: zzz", "apikey: <secret>"),
            (r#"{"refresh_token":"1//0gAbC-d_eFg"}"#, r#"{"refresh_token":<secret>}"#),
            (r#"{"Password": "p w d", "n": 1}"#, r#"{"Password": <secret>, "n": 1}"#),
            ("Authorization: Bearer abc.def-ghi", "Authorization: <secret>"),
            ("authorization=Basic dXNlcjpwYXNz", "authorization=<secret>"),
        ] {
            let (o, c) = redact_line(src, None);
            assert_eq!(o, left, "{src}");
            assert_eq!(c.token, 1, "{src}");
        }
        // 後面的欄位不受影響
        let (o, _) = redact_line("a=1&token=xyz&b=2", None);
        assert_eq!(o, "a=1&token=<secret>&b=2");
    }

    #[test]
    fn 遮鍵值類_反例_看起來像但不是祕密() {
        for s in [
            "tokenizer=fast 與 tokenizer: bpe",
            "token_count=5 secrets=none passwords: 3",
            "the password was reset，token 已過期",
            "password",
            "token = ",
            "mytokens=1",
        ] {
            let (o, c) = redact_line(s, None);
            assert_eq!(o, s, "不該被遮：{s}");
            assert_eq!(c.token, 0, "{s}");
        }
    }

    #[test]
    fn 遮_aws_與_github_金鑰_正例與反例() {
        let (o, c) = redact_line("key AKIAIOSFODNN7EXAMPLE used", None);
        assert_eq!(o, "key <token> used");
        assert_eq!(c.token, 1);
        for p in ["ghp_", "gho_", "ghs_", "ghu_", "ghr_"] {
            let (o, c) = redact_line(&format!("auth {p}abcdefghijklmnopqrstuvwxyz0123456789 end"), None);
            assert_eq!(o, "auth <token> end", "{p}");
            assert_eq!(c.token, 1);
        }
        let (o, _) = redact_line("pat github_pat_11ABCDEFG0abcdefghijkl_mnopqrstuvwxyz end", None);
        assert_eq!(o, "pat <token> end");
        // 反例：長度不足、前綴不對、前面還連著別的字
        for s in [
            "AKIAIOSFODNN7EXAMPL 少一個字",
            "AKIAIOSFODNN7EXAMPLEXX 多了字不是金鑰",
            "akiaiosfodnn7example 小寫",
            "ghp_short",
            "ghx_abcdefghijklmnopqrstuvwxyz",
            "light_ghp_abcdefghijklmnopqrstuvwxyz",
            "github_pat_short",
        ] {
            let (o, c) = redact_line(s, None);
            assert_eq!(o, s, "不該被遮：{s}");
            assert_eq!(c.token, 0, "{s}");
        }
    }

    #[test]
    fn 遮私鑰_同一行與跨行整段_反例不動() {
        // 同一行（ui.log 的換行會被換成空白，實際上是這種）
        let (o, c) = redact_line("ts info key=-----BEGIN RSA PRIVATE KEY----- MIIEabc def -----END RSA PRIVATE KEY----- after", None);
        assert_eq!(o, "ts info key=<private-key> after");
        assert_eq!(c.token, 1);
        // 只有 BEGIN、沒有 END：遮到行尾
        let (o, c) = redact_line("x -----BEGIN PRIVATE KEY----- MIIEabc 後面全部", None);
        assert_eq!(o, "x <private-key>");
        assert_eq!(c.token, 1);
        // 跨行：本文每一行都沒有時間戳、也不到 32 字，整份檔案先遮才不會漏
        let d = tempfile::tempdir().unwrap();
        let body = "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXk\nAAAAB3NzaC1yc2E\nSECRETLINE\n-----END OPENSSH PRIVATE KEY-----";
        let l1 = format!("{} info [ASN] dump: {body}", iso(NOW - 2000));
        std::fs::write(d.path().join("ui.log"), format!("{l1}\n{}\n", line(1000, "後一行"))).unwrap();
        let r = collect(d.path(), Range::Hour1, NOW, "");
        assert!(!r.text.contains("SECRETLINE") && !r.text.contains("b3BlbnNz") && !r.text.contains("PRIVATE KEY"), "{}", r.text);
        assert!(r.text.contains("<private-key>") && r.text.contains("後一行"));
        assert_eq!(r.masked.token, 1);
        // 反例：不是私鑰的 PEM、只是提到這幾個字
        for s in ["-----BEGIN CERTIFICATE----- MIIC -----END CERTIFICATE-----", "沒有 private key 檔案", "BEGIN PRIVATE KEY 沒有橫線"] {
            let (o, c) = redact_line(s, None);
            assert_eq!(o, s, "{s}");
            assert_eq!(c.token, 0);
        }
    }

    #[test]
    fn 範圍篩選_預設_24_小時() {
        assert_eq!(Range::parse(None).unwrap(), Range::Hour24);
        assert_eq!(Range::parse(Some("")).unwrap(), Range::Hour24);
        assert_eq!(Range::parse(Some("1h")).unwrap(), Range::Hour1);
        assert_eq!(Range::parse(Some("7d")).unwrap(), Range::Day7);
        assert!(Range::parse(Some("30d")).is_err());
        let d = tempfile::tempdir().unwrap();
        write_logs(
            d.path(),
            &[line(8 * 86_400_000, "八天前"), line(3 * 86_400_000, "三天前")],
            &[line(2 * 3_600_000, "兩小時前"), line(60_000, "一分鐘前"), "沒有時間戳的行".into()],
        );
        let t = |r| collect(d.path(), r, NOW, "").text;
        let h1 = t(Range::Hour1);
        assert!(h1.contains("一分鐘前") && !h1.contains("兩小時前"), "{h1}");
        let h24 = t(Range::Hour24);
        assert!(h24.contains("兩小時前") && h24.contains("一分鐘前") && !h24.contains("三天前"), "{h24}");
        let d7 = t(Range::Day7);
        assert!(d7.contains("三天前") && !d7.contains("八天前") && !d7.contains("沒有時間戳"), "{d7}");
        // 輪替檔（.1）排在前面，順序是舊到新
        assert!(d7.find("三天前").unwrap() < d7.find("一分鐘前").unwrap());
    }

    #[test]
    fn 只取最新的_2000_行() {
        let d = tempfile::tempdir().unwrap();
        let cur: Vec<String> = (0..MAX_LINES + 50).map(|i| line(1000, &format!("n{i}n"))).collect();
        write_logs(d.path(), &[], &cur);
        let r = collect(d.path(), Range::Hour1, NOW, "");
        assert_eq!(r.lines, MAX_LINES);
        assert!(r.text.contains("n2049n") && !r.text.contains("n49n"));
    }

    #[test]
    fn 超過_1_mb_只留最新的部分() {
        let d = tempfile::tempdir().unwrap();
        // 2000 行，每行約 650 位元組（中文一個字 3 位元組）≈ 1.3 MB
        let pad = "記".repeat(200);
        let cur: Vec<String> = (0..MAX_LINES).map(|i| line(1000, &format!("序號{i:04}序 {pad}"))).collect();
        write_logs(d.path(), &[], &cur);
        let r = collect(d.path(), Range::Hour1, NOW, "");
        assert!(r.bytes <= MAX_BYTES, "{}", r.bytes);
        assert_eq!(r.bytes, r.text.len());
        assert!(r.lines < MAX_LINES && r.lines > 0);
        assert!(r.text.contains("序號1999序"), "最新的一行要留");
        assert!(!r.text.contains("序號0000序"), "最舊的要被丟掉");
        assert_eq!(r.lines, r.text.lines().count());
    }

    #[test]
    fn 回傳的遮罩計數只算留下來的行() {
        let d = tempfile::tempdir().unwrap();
        write_logs(
            d.path(),
            &[],
            &[line(1000, "a@b.example.com"), line(900, r"C:\Users\fakeuser\x sk-FAKEFAKEFAKEFAKEFAKE1")],
        );
        let r = collect(d.path(), Range::Hour1, NOW, HOME_WIN);
        assert_eq!(r.masked, MaskCounts { email: 1, token: 1, home: 1 });
        assert_eq!(r.lines, 2);
        assert!(!r.text.contains("fakeuser") && !r.text.contains("a@b"));
    }

    #[test]
    fn 收件處留空_拒絕寄出_而且完全不呼叫網路() {
        let d = tempfile::tempdir().unwrap();
        write_logs(d.path(), &[], &[line(1000, "有記錄")]);
        for room in ["", "   "] {
            let calls = std::sync::atomic::AtomicUsize::new(0);
            let r = run(send_with(room, d.path(), None, NOW, "", |_p| {
                calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                async { Ok(json!({})) }
            }));
            assert_eq!(r.unwrap_err(), NO_RECIPIENT_MSG);
            assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 0, "留空時不可呼叫送出");
        }
        // 目前寫死的設定值就是留空
        assert_eq!(RECIPIENT_ROOM, "", "群組建好前設定值要留空；填了要同時改這個測試與設定值清單");
        assert!(check_recipient(RECIPIENT_ROOM).is_err());
    }

    #[test]
    fn 有設定收件處才寄_附件是遮罩後的文字檔_內文帶版本平台範圍() {
        let d = tempfile::tempdir().unwrap();
        write_logs(d.path(), &[], &[line(1000, "mail x@y.example.org 有記錄")]);
        let seen = std::sync::Mutex::new(None::<Value>);
        let r = run(send_with("asn-dev", d.path(), Some("1h"), NOW, "", |p| {
            *seen.lock().unwrap() = Some(p);
            async { Ok(json!({})) }
        }));
        assert_eq!(r.unwrap()["lines"], 1);
        let p = seen.lock().unwrap().clone().unwrap();
        assert_eq!(p["room"], "asn-dev");
        assert_eq!(p["kind"], "file");
        assert!(p["name"].as_str().unwrap().ends_with(".txt"));
        let cap = p["caption"].as_str().unwrap();
        assert!(cap.contains(env!("CARGO_PKG_VERSION")) && cap.contains(std::env::consts::OS) && cap.contains("最近 1 小時"), "{cap}");
        use base64::{engine::general_purpose::STANDARD, Engine};
        let body = String::from_utf8(STANDARD.decode(p["data"].as_str().unwrap()).unwrap()).unwrap();
        assert!(body.contains("<email>") && !body.contains("x@y.example.org"));
        // 附件通得過既有的附件檢查（txt、內容、大小）
        let ph = crate::attach::parse_photo(&p).unwrap();
        assert_eq!(ph.kind, "file");
    }

    #[test]
    fn 沒有記錄可寄也不呼叫送出() {
        let d = tempfile::tempdir().unwrap();
        let r = run(send_with("asn-dev", d.path(), None, NOW, "", |_p| async { panic!("不該呼叫") }));
        assert!(r.unwrap_err().contains("沒有記錄"));
    }

    #[test]
    fn 守門_遮罩只在送出出口用_本機_ui_log_照舊保留完整路徑() {
        // 行為：append 之後檔案裡的家目錄與權杖樣式字串原封不動（只有 email 照舊被遮）
        let d = tempfile::tempdir().unwrap();
        let l = format!(r"{} info [ASN] open C:\Users\fakeuser\x sk-FAKEFAKEFAKEFAKEFAKE1 a@b.example.com", iso(NOW));
        crate::ui_log::append(d.path(), &[l]).unwrap();
        let t = std::fs::read_to_string(crate::ui_log::path(d.path())).unwrap();
        assert!(t.contains(r"C:\Users\fakeuser\x"), "本機記錄要保留完整路徑：{t}");
        assert!(t.contains("sk-FAKEFAKEFAKEFAKEFAKE1"));
        assert!(!t.contains("a@b.example.com") && t.contains("<email>"));
        // 原始碼：ui_log.rs 的正式程式不引用送出出口的遮罩
        let ui = include_str!("ui_log.rs");
        let prod = ui.split("#[cfg(test)]").next().unwrap();
        for bad in ["log_report", "redact_line", "home_regex"] {
            assert!(!prod.contains(bad), "ui_log 的正式程式不可以用送出出口的遮罩：{bad}");
        }
    }
}

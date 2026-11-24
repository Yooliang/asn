//! 保底通知（#2256）：夥伴視窗的畫面停在「Do you want to proceed?」加編號選項，超過 5 分鐘沒變，
//! 就算 `claude_screen` 沒認成完整的權限框（或認成了但沒送出手機確認），也要通知。不能出現「認不出就安靜」。
//!
//! 這裡只有判斷與擷取，不碰畫面、不連後台：背景讀畫面（term.rs）把畫面文字餵進 [`StuckWatch::observe`]，
//! 要通知的放進佇列，收發室（bridge/core/stuck_prompt_notice.rs）取走後寄兩份：給擁有者、給那個夥伴本人。
//!
//! 「畫面沒變」比對的是擷取出來的那一段（Do you want to proceed? 附近），不是整個畫面：
//! 整個畫面可能有計時器、旋轉的字樣一直在變，會讓卡了五個小時的框永遠湊不滿五分鐘。
//! 比對行首（去掉框線與 ⎿ 之後的開頭），● 開頭的 AI 回覆、使用者打的字不算（開發紀律 三之 6）。
use std::collections::HashMap;
use std::sync::Mutex;

/// 畫面這麼久沒變才通知（毫秒）
pub(crate) const STUCK_AFTER_MS: u64 = 5 * 60_000;
/// 同一扇視窗、同一段畫面，兩次通知至少隔這麼久（毫秒）
pub(crate) const COOLDOWN_MS: u64 = 30 * 60_000;
/// 擷取的畫面最多幾行
pub(crate) const EXCERPT_MAX_LINES: usize = 15;
/// 每一行最多幾字（超過的截掉，加「…」）
const LINE_MAX_CHARS: usize = 100;
/// 整段最多幾字：和後台收的上限（600）一致
pub(crate) const EXCERPT_MAX_CHARS: usize = 600;
/// 要有這麼多條編號選項才算（`1.`、`2.`）
const MIN_OPTIONS: usize = 2;
/// 提示字樣之後最多往下看幾行找編號選項
const OPTION_WINDOW: usize = 8;
const PROCEED: &str = "Do you want to proceed?";
const REDACTED: &str = "（這一行可能含密碼或憑證，已省略）";
/// 含這些字（不分大小寫）的行整行省略
const SECRET_WORDS: [&str; 13] = ["password", "passwd", "secret", "token", "api_key", "apikey", "authorization", "bearer ", "sk-", "-----begin", "ghp_", "gho_", "github_pat_"];
/// 含這些字（分大小寫）的行整行省略；後面要接像金鑰的字元才算，避免一般英文字誤擋
/// （字首, 後面至少幾個 `[A-Za-z0-9_-]`）
const SECRET_PREFIXES: [(&str, usize); 3] = [("AKIA", 12), ("AIza", 20), ("eyJ", 10)];
/// 大寫名稱含這些字、後面接 `=值` 的整行省略（`DB_PASS=…`、`MY_KEY=…`）
const SECRET_ENV_PARTS: [&str; 8] = ["KEY", "TOKEN", "SECRET", "PASS", "PWD", "CRED", "AUTH", "PRIVATE"];
/// 連續這麼長的 hex 或 base64／base64url 字串，視為金鑰
const LONG_RUN: usize = 32;

/// 寄給那個夥伴本人的話（主代理不知道自己的子代理卡在確認框，因為確認框只顯示在終端上給人按）
pub(crate) const PARTNER_TEXT: &str = "你的視窗卡在確認框超過 5 分鐘，可能是子代理在等權限；可以停掉它，換只用編輯工具的方式重做。";

/// 一次該通知的卡住
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct StuckPrompt {
    pub name: String,
    pub excerpt: String,
}

/// 去掉行首的框線、⎿、游標，剩下的開頭
fn line_head(line: &str) -> &str {
    line.trim_start_matches(|c: char| c.is_whitespace() || "│┃║|⎿".contains(c))
}

/// 這一行是不是編號選項（`1. Yes`、`❯ 2. No`）
fn is_option_line(line: &str) -> bool {
    let h = line_head(line).trim_start_matches(|c: char| c == '❯' || c == '›' || c == '>' || c.is_whitespace());
    let digits = h.chars().take_while(char::is_ascii_digit).count();
    digits > 0 && digits <= 2 && h[digits..].starts_with(". ") && !h[digits + 2..].trim().is_empty()
}

/// 選項行上有 ❯ 游標（`❯ 1. Yes`）。`>` 不算：那是 markdown 引用
fn has_cursor(line: &str) -> bool {
    let h = line_head(line);
    (h.starts_with('❯') || h.starts_with('›')) && is_option_line(line)
}

fn is_key_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_' || c == '-'
}

/// 字首之後接著至少 `min` 個金鑰字元
fn has_prefixed_key(line: &str, prefix: &str, min: usize) -> bool {
    line.match_indices(prefix).any(|(i, _)| line[i + prefix.len()..].chars().take_while(|c| is_key_char(*c)).count() >= min)
}

/// `xoxb-`、`xoxp-` 之類（Slack）
fn has_slack_token(line: &str) -> bool {
    line.match_indices("xox").any(|(i, _)| {
        let mut it = line[i + 3..].chars();
        matches!((it.next(), it.next()), (Some(a), Some('-')) if a.is_ascii_alphabetic())
    })
}

/// `://帳號:密碼@主機`
fn has_url_credentials(line: &str) -> bool {
    line.match_indices("://").any(|(i, _)| {
        let rest = &line[i + 3..];
        let authority = rest.split(|c: char| c == '/' || c.is_whitespace()).next().unwrap_or("");
        authority.rfind('@').is_some_and(|at| authority[..at].contains(':'))
    })
}

/// `DB_PASS=值`：全大寫的名稱含 KEY／TOKEN／SECRET／PASS 等，等號後面有值
fn has_secret_assignment(line: &str) -> bool {
    line.split_whitespace().any(|tok| {
        let Some((name, value)) = tok.split_once('=') else { return false };
        let name = name.trim_start_matches(|c: char| !c.is_ascii_alphanumeric());
        let upper_name = !name.is_empty() && name.chars().all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == '_');
        upper_name && !value.is_empty() && SECRET_ENV_PARTS.iter().any(|p| name.contains(p))
    })
}

/// 連續 32 字以上的 hex，或同時有大寫、小寫、數字的 base64／base64url 字串（只有小寫的長路徑、長單字不算）
fn has_long_secret_run(line: &str) -> bool {
    line.split(|c: char| !(c.is_ascii_alphanumeric() || "+/=_-".contains(c))).any(|run| {
        let run = run.trim_matches(|c: char| "=/-_+".contains(c));
        if run.chars().count() < LONG_RUN {
            return false;
        }
        let hex = run.chars().all(|c| c.is_ascii_hexdigit());
        let mixed = run.chars().any(|c| c.is_ascii_uppercase()) && run.chars().any(|c| c.is_ascii_lowercase()) && run.chars().any(|c| c.is_ascii_digit());
        hex || mixed
    })
}

/// 這一行是不是可能含密碼、憑證（寧可多擋，不可漏）
fn is_secret_line(line: &str) -> bool {
    let low = line.to_lowercase();
    let dashed = low.replace('-', "_");
    SECRET_WORDS.iter().any(|w| low.contains(w))
        // `api-key`、`api_key`、`apikey` 不分連字號與底線
        || dashed.contains("api_key")
        || SECRET_PREFIXES.iter().any(|(p, n)| has_prefixed_key(line, p, *n))
        || has_slack_token(line)
        || has_url_credentials(line)
        || has_secret_assignment(line)
        || has_long_secret_run(line)
}

fn shorten(line: &str) -> String {
    if line.chars().count() > LINE_MAX_CHARS {
        let mut s: String = line.chars().take(LINE_MAX_CHARS).collect();
        s.push('…');
        return s;
    }
    line.to_string()
}

/// 畫面上「Do you want to proceed?」加編號選項附近的那一段（最多 15 行、600 字），去掉控制字元；
/// 沒有提示字樣、或提示字樣後面沒有編號選項（一般對話裡夾一句）回 None
pub(crate) fn excerpt_of(screen: &str) -> Option<String> {
    analyze(screen).map(|(e, _)| e)
}

/// （擷取的那一段, 比對「有沒有變」用的內容）。比對只看框本身：從最近的實線（框的頂端）到選項為止，
/// 框上面的旋轉字樣、計時器不算；找不到實線就用擷取的那一段
fn analyze(screen: &str) -> Option<(String, String)> {
    let lines: Vec<&str> = screen.lines().collect();
    // 取最後一個（畫面最底下的才是現在的框）
    let idx = lines.iter().rposition(|l| line_head(l).starts_with(PROCEED))?;
    let below = &lines[idx + 1..];
    let options = below.iter().take(OPTION_WINDOW).filter(|l| is_option_line(l)).count();
    // 真的確認框，選項上一定有 ❯ 游標；AI 回覆裡縮排寫的編號清單沒有（#2264 一審 3）
    if options < MIN_OPTIONS || !below.iter().take(OPTION_WINDOW).any(|l| has_cursor(l)) {
        return None;
    }
    let start = idx.saturating_sub(EXCERPT_MAX_LINES - 6);
    let end = lines.len().min(start + EXCERPT_MAX_LINES);
    let mut kept: Vec<String> = Vec::new();
    // 命中機密的那一行，下一行也省略（長指令折行，值會跑到下一行）；提示字樣與選項不省略，使用者要看得到
    let mut prev_secret = false;
    for l in &lines[start..end] {
        let clean = super::claude_screen::strip_unsafe(l);
        let clean = clean.trim_end();
        let structural = line_head(clean).starts_with(PROCEED) || is_option_line(clean);
        let secret = is_secret_line(clean);
        kept.push(if secret || (prev_secret && !structural) { REDACTED.to_string() } else { shorten(clean) });
        prev_secret = secret;
    }
    while kept.last().is_some_and(|l| l.trim().is_empty()) {
        kept.pop();
    }
    // 超過字數上限就從最上面的行開始丟，提示字樣與選項（在下面）留著
    while kept.len() > 1 && kept.join("\n").chars().count() > EXCERPT_MAX_CHARS {
        kept.remove(0);
    }
    let text: String = kept.join("\n").chars().take(EXCERPT_MAX_CHARS).collect();
    let top = lines[..idx].iter().rposition(|l| l.trim_start().starts_with("──")).filter(|t| *t >= start);
    let basis = match top {
        Some(t) => lines[t..end].iter().map(|l| super::claude_screen::strip_unsafe(l).trim_end().to_string()).collect::<Vec<_>>().join("\n"),
        None => text.clone(),
    };
    Some((text, basis))
}

struct Track {
    hash: String,
    since: u64,
    told: bool,
}

/// 每扇視窗的「這段畫面從何時起沒變」與通知紀錄。純邏輯
#[derive(Default)]
pub(crate) struct StuckWatch {
    tracks: HashMap<String, Track>,
    /// 視窗 → 上次通知的（畫面雜湊, 時間）：框消失又出現時，冷卻內同一段不重寄
    sent: HashMap<String, (String, u64)>,
}

impl StuckWatch {
    /// `screen`＝這一輪讀到的畫面（讀到了才呼叫；讀不到就別呼叫，不算框消失）；視窗已結束給 None。
    /// 回該通知的：畫面沒變滿 5 分鐘、這一次卡住還沒通知過、冷卻內沒通知過同一段
    pub(crate) fn observe(&mut self, name: &str, screen: Option<&str>, now: u64) -> Option<StuckPrompt> {
        let Some((excerpt, basis)) = screen.and_then(analyze) else {
            // 框消失（或畫面沒有提示字樣）：重新算
            self.tracks.remove(name);
            return None;
        };
        let hash = crate::term_remote::hash_hex(&basis);
        let track = self.tracks.entry(name.to_string()).or_insert_with(|| Track { hash: hash.clone(), since: now, told: false });
        if track.hash != hash {
            // 畫面變了：重新算
            *track = Track { hash: hash.clone(), since: now, told: false };
        }
        if track.told || now.saturating_sub(track.since) < STUCK_AFTER_MS {
            return None;
        }
        track.told = true;
        if self.sent.get(name).is_some_and(|(h, at)| *h == hash && now.saturating_sub(*at) < COOLDOWN_MS) {
            return None;
        }
        self.sent.insert(name.to_string(), (hash, now));
        Some(StuckPrompt { name: name.to_string(), excerpt })
    }

    /// 已經不在名單上的視窗：紀錄拿掉
    pub(crate) fn retain_windows(&mut self, names: &[String]) {
        self.tracks.retain(|n, _| names.contains(n));
        self.sent.retain(|n, _| names.contains(n));
    }
}

/// 背景讀畫面放進來、收發室取走（只在記憶體）
static PENDING: Mutex<Vec<StuckPrompt>> = Mutex::new(Vec::new());
/// 佇列最多放幾筆（收發室一直取不走時不無限長）
const PENDING_MAX: usize = 50;

pub(crate) fn push_pending(p: StuckPrompt) {
    if let Ok(mut g) = PENDING.lock() {
        if g.len() < PENDING_MAX {
            g.push(p);
        }
    }
}

pub(crate) fn take_pending() -> Vec<StuckPrompt> {
    PENDING.lock().map(|mut g| std::mem::take(&mut *g)).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    const T: u64 = 1_800_000_000_000;
    const BOX: &str = "● 好的\n──────\n Bash command\n   cd x && rm y\n Do you want to proceed?\n ❯ 1. Yes\n   2. No\n";

    fn watch_once(w: &mut StuckWatch, screen: &str, now: u64) -> Option<StuckPrompt> {
        w.observe("甲", Some(screen), now)
    }

    #[test]
    fn 有提示字樣加編號選項_滿五分鐘才通知() {
        let mut w = StuckWatch::default();
        assert_eq!(watch_once(&mut w, BOX, T), None, "剛出現");
        assert_eq!(watch_once(&mut w, BOX, T + STUCK_AFTER_MS - 1), None, "差一毫秒");
        let p = watch_once(&mut w, BOX, T + STUCK_AFTER_MS).expect("滿五分鐘");
        assert_eq!(p.name, "甲");
        assert!(p.excerpt.contains("Do you want to proceed?") && p.excerpt.contains("1. Yes") && p.excerpt.contains("2. No"));
    }

    #[test]
    fn 沒有提示字樣_或沒有編號選項_不通知() {
        let mut w = StuckWatch::default();
        for s in ["", "隨便一段畫面\n❯ 1. Yes\n  2. No", "我問你：Do you want to proceed?\n好", "Do you want to proceed?\n(沒有選項)", "Do you want to proceed?\n 1. 只有一條"] {
            watch_once(&mut w, s, T);
            assert_eq!(watch_once(&mut w, s, T + 10 * STUCK_AFTER_MS), None, "{s}");
        }
    }

    #[test]
    fn 一般對話夾一句提示字樣不算_行首是_ai_回覆或使用者打的字() {
        let mut w = StuckWatch::default();
        let chat = "● Do you want to proceed?\n  1. 好\n  2. 不好\n> Do you want to proceed?\n 1. a\n 2. b\n";
        watch_once(&mut w, chat, T);
        assert_eq!(watch_once(&mut w, chat, T + 10 * STUCK_AFTER_MS), None);
    }

    #[test]
    fn 畫面變了重新算_同一段只通知一次() {
        let mut w = StuckWatch::default();
        let other = BOX.replace("rm y", "rm z");
        watch_once(&mut w, BOX, T);
        assert_eq!(watch_once(&mut w, &other, T + STUCK_AFTER_MS - 1), None, "換了一個框，從頭算");
        assert_eq!(watch_once(&mut w, &other, T + STUCK_AFTER_MS), None, "新的框才過一毫秒");
        assert!(watch_once(&mut w, &other, T + 2 * STUCK_AFTER_MS - 1).is_some());
        assert_eq!(watch_once(&mut w, &other, T + 3 * STUCK_AFTER_MS), None, "同一次卡住只通知一次");
        assert_eq!(watch_once(&mut w, &other, T + 50 * STUCK_AFTER_MS), None, "放再久也不重寄");
    }

    #[test]
    fn 框之外的畫面一直在變_不影響計時() {
        let mut w = StuckWatch::default();
        let at = |n: u64| format!("✻ Working… ({n}s · esc to interrupt)\n{BOX}");
        watch_once(&mut w, &at(1), T);
        assert!(watch_once(&mut w, &at(301), T + STUCK_AFTER_MS).is_some(), "計時器在跑，框沒動");
    }

    #[test]
    fn 框消失就重置_冷卻內同一段不重寄_冷卻後可以再寄() {
        let mut w = StuckWatch::default();
        watch_once(&mut w, BOX, T);
        assert!(watch_once(&mut w, BOX, T + STUCK_AFTER_MS).is_some());
        let t1 = T + STUCK_AFTER_MS;
        assert_eq!(w.observe("甲", Some("一般畫面"), t1 + 1000), None, "框消失");
        // 冷卻內又出現同一段：滿五分鐘也不寄
        let t2 = t1 + 60_000;
        watch_once(&mut w, BOX, t2);
        assert_eq!(watch_once(&mut w, BOX, t2 + STUCK_AFTER_MS), None, "冷卻內同一段不重寄");
        // 超過冷卻又出現：滿五分鐘再寄
        w.observe("甲", Some("一般畫面"), t1 + COOLDOWN_MS);
        let t3 = t1 + COOLDOWN_MS + 1000;
        watch_once(&mut w, BOX, t3);
        assert!(watch_once(&mut w, BOX, t3 + STUCK_AFTER_MS).is_some(), "冷卻過了");
    }

    #[test]
    fn 視窗結束也重置_兩扇視窗各算各的() {
        let mut w = StuckWatch::default();
        w.observe("甲", Some(BOX), T);
        w.observe("乙", Some(BOX), T + 1000);
        assert_eq!(w.observe("甲", None, T + 2000), None, "視窗結束");
        assert_eq!(w.observe("甲", Some(BOX), T + STUCK_AFTER_MS), None, "甲重新算");
        assert!(w.observe("乙", Some(BOX), T + 1000 + STUCK_AFTER_MS).is_some(), "乙照原本的時間");
    }

    #[test]
    fn 擷取只取提示字樣附近_最多十五行_去掉控制字元() {
        let mut s = String::new();
        for i in 0..40 {
            s.push_str(&format!("前面第 {i} 行\n"));
        }
        s.push_str("──────\n echo \u{1b}[31m紅\u{202E}反\u{7}\n Do you want to proceed?\n ❯ 1. Yes\n   2. No\n");
        for i in 0..40 {
            s.push_str(&format!("後面第 {i} 行\n"));
        }
        // 後面還有很多行時，最後一個提示字樣仍在中間：擷取範圍固定在附近
        let e = excerpt_of(&s).unwrap();
        assert!(e.lines().count() <= EXCERPT_MAX_LINES, "{e}");
        assert!(e.contains("Do you want to proceed?") && e.contains("2. No"));
        assert!(!e.contains("前面第 0 行") && !e.contains("後面第 39 行"), "不帶整個畫面：{e}");
        assert!(!e.contains('\u{1b}') && !e.contains('\u{202E}') && !e.contains('\u{7}'), "控制字元要去掉：{e:?}");
    }

    #[test]
    fn 擷取有字數上限_長行截斷_機密字樣整行省略() {
        let long = "長".repeat(500);
        let s = format!("{long}\n curl -H 'Authorization: Bearer abc.def' x\n export API_KEY=1\n Do you want to proceed?\n ❯ 1. Yes\n   2. No\n");
        let e = excerpt_of(&s).unwrap();
        assert!(e.chars().count() <= EXCERPT_MAX_CHARS, "{}", e.chars().count());
        assert!(!e.contains("abc.def") && !e.contains("API_KEY"), "{e}");
        assert!(e.contains(REDACTED));
        assert!(e.contains("Do you want to proceed?") && e.contains("2. No"), "上限內留下提示字樣與選項：{e}");
    }

    fn with_line(line: &str) -> String {
        format!("──────\n {line}\n Do you want to proceed?\n ❯ 1. Yes\n   2. No\n")
    }

    #[test]
    fn 各種金鑰樣式整行省略() {
        let b64 = "Zm9vYmFyQmF6MTIzNDU2Nzg5MEFiQ2RFZkdoSWo";
        let hex = "0123456789abcdef0123456789abcdef";
        let bad: Vec<String> = vec![
            "echo ghp_abcdefghijklmnopqrstuvwxyz0123".into(),
            "echo gho_abcdefghijklmnopqrstuvwxyz0123".into(),
            "echo github_pat_11ABCDEFG0abcdef".into(),
            "aws --key AKIAIOSFODNN7EXAMPLE".into(),
            "curl 'https://x/?key=AIzaSyA-abcdefghijklmnopqrstuvwxyz'".into(),
            "echo xoxb-1234-5678-abcdef".into(),
            "echo xoxp-1234".into(),
            "echo eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9".into(),
            "curl -H 'api-key: abc'".into(),
            "curl -H 'X-API-KEY: abc'".into(),
            "curl --apikey abc".into(),
            "git clone https://user:pw1234@github.com/a/b".into(),
            "DB_PASS=hunter2 ./run".into(),
            "export MY_KEY=abc".into(),
            "GH_TOKEN=abc gh pr list".into(),
            "APP_SECRET=abc node a.js".into(),
            format!("echo {hex}"),
            format!("echo {b64}"),
        ];
        for line in &bad {
            let e = excerpt_of(&with_line(line)).unwrap();
            assert!(e.contains(REDACTED), "要省略：{line} → {e}");
            assert!(e.contains("Do you want to proceed?") && e.contains("2. No"), "提示字樣與選項要留著：{e}");
        }
    }

    #[test]
    fn 一般指令不被誤擋() {
        let good = [
            "docker compose config -q 2>&1 | head -5",
            "git clone https://github.com/a/b",
            "git clone git@github.com:a/b.git",
            "curl https://example.com/api/v1/items?page=2",
            "cd /home/user/projects/some-very-long-directory-name/sub-directory-name && ls",
            "echo xoxo hello",
            "AKIA",
            "PORT=8080 node server.js",
            "LOAN_WATCH_STATE_PATH=/app/data/state.json",
            "pnpm exec vue-tsc -b",
        ];
        for line in good {
            let e = excerpt_of(&with_line(line)).unwrap();
            assert!(!e.contains(REDACTED), "不該省略：{line} → {e}");
            assert!(e.contains(line), "{line}");
        }
    }

    #[test]
    fn 命中那一行的下一行也省略_折行的值不外洩() {
        let s = "──────\n curl -H 'Authorization: Bearer\n   abc.def.ghi' https://x\n 這行不相關\n Do you want to proceed?\n ❯ 1. Yes\n   2. No\n";
        let e = excerpt_of(s).unwrap();
        assert!(!e.contains("abc.def.ghi"), "折到下一行的值要省略：{e}");
        assert!(e.contains("這行不相關"), "只多省略一行：{e}");
        // 命中的行緊貼著提示字樣時，提示字樣與選項仍留著
        let t = "──────\n export API_KEY=1 \\\n Do you want to proceed?\n ❯ 1. Yes\n   2. No\n";
        let e = excerpt_of(t).unwrap();
        assert!(e.contains("Do you want to proceed?") && e.contains("1. Yes") && e.contains("2. No"), "{e}");
    }

    #[test]
    fn ai_回覆裡縮排的提示字樣加編號清單_沒有游標不是確認框() {
        let mut w = StuckWatch::default();
        for s in [
            // 兩格縮排的 markdown 清單（前面沒有 ●）
            "  Do you want to proceed?\n  1. 好\n  2. 不好\n",
            // 程式碼區塊裡
            "```\nDo you want to proceed?\n1. Yes\n2. No\n```\n",
            // markdown 引用的 > 不算游標
            "Do you want to proceed?\n> 1. Yes\n  2. No\n",
        ] {
            assert_eq!(excerpt_of(s), None, "{s}");
            watch_once(&mut w, s, T);
            assert_eq!(watch_once(&mut w, s, T + 10 * STUCK_AFTER_MS), None, "{s}");
        }
    }

    #[test]
    fn 真的權限框畫面照樣判成確認框() {
        macro_rules! fx {
            ($n:literal) => {
                (include_str!(concat!("../../tests/fixtures/term-screens/", $n, ".txt")).replace("\r\n", "\n"), $n)
            };
        }
        for (text, name) in [fx!("claude-permission-bash"), fx!("claude-permission-long-bash"), fx!("claude-permission-scrolled-more-lines")] {
            let e = excerpt_of(&text).unwrap_or_else(|| panic!("{name} 要判成確認框"));
            assert!(e.contains("Do you want to proceed?"), "{name}");
        }
    }

    #[test]
    fn 佇列放進去取走一次() {
        // 全域佇列：先清空再測，不和其他測試搶（只有這個測試動它）
        let _ = take_pending();
        push_pending(StuckPrompt { name: "甲".into(), excerpt: "x".into() });
        assert_eq!(take_pending().len(), 1);
        assert!(take_pending().is_empty());
    }
}

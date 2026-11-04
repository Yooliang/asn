//! 從 Claude Code 的終端畫面判斷它停在哪種提示（藍圖 todo-next-162 第 1 段）。
//! 這裡只做判斷、不送字；這一段還沒有接到正式流程。
//!
//! 畫面文字會混入模型輸出與外部內容，所以規則的方向是：只看畫面最底下的區塊，每個條件都符合才給按鈕；
//! 有任何一點對不上，就回 `Attention`（需要人工確認、不給按鈕）或 `None`（沒有偵測到提示）。
//! 寧可漏報，不可給錯按鈕。規則字串會隨 Claude Code 版本變動，對不上時一樣落到沒有按鈕。
#![cfg_attr(not(test), allow(dead_code))]

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ClaudeScreenKind {
    /// 工具權限詢問：選單第一項是 Yes，另有一項以 No 開頭
    Permission,
    /// 信任資料夾
    TrustFolder,
    /// 第一次使用略過權限模式的警告。字串取自執行檔，尚未實測真實畫面；同意與否一律由本人決定，不給按鈕
    BypassWarning,
    /// 未登入或登入失效。只標狀態
    Login,
    /// 額度用完。只標狀態
    UsageLimit,
    /// 看起來停在某個選單，但不是認得的種類：需要人工確認
    Attention,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClaudeOption {
    pub n: u32,
    pub label: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClaudeScreen {
    pub kind: ClaudeScreenKind,
    pub question: String,
    pub options: Vec<ClaudeOption>,
    /// 目前游標所在的選項（從 0 算）；沒有選單是 0
    pub cursor: usize,
    /// 「允許這一次」對應的選項編號。只有條件全符合才有值
    pub allow_once: Option<u32>,
    /// 「拒絕」對應的選項編號。只有條件全符合才有值
    pub deny: Option<u32>,
}

const CURSOR: char = '❯';
/// 選單最後一項到畫面底部之間，最多容許的頁尾行數
const MAX_FOOTER_LINES: usize = 3;
/// 選單最多幾項：再多就不是認得的權限詢問
const MAX_OPTIONS: usize = 9;
/// 分隔線至少要有幾個線的字元
const MIN_RULE_CHARS: usize = 10;
const STATUS_LINE_MARKS: [&str; 6] = ["bypass permissions on", "auto mode on", "manual mode on", "accept edits on", "plan mode on", "? for shortcuts"];
const FOOTER_PREFIXES: [&str; 4] = ["Esc to cancel", "Enter to confirm", "Enter to select", "Enter to continue"];
const TRUST_NO: &str = "No, exit";
const TRUST_YES: &str = "Yes, I trust this folder";
const BYPASS_YES: &str = "Yes, I accept";
const LOGIN_MENU: &str = "Select login method";
const LOGIN_EXPIRED: &str = "Please run /login";
const USAGE_LIMIT: &str = "You've hit your limit";
/// 輸入框上方往回看幾行，找登入失效與額度訊息
const NOTICE_LOOKBACK: usize = 8;

/// 這個種類對應的固定代號（寫進狀態檔的只有它，不含畫面文字；名單顯示的字見 bridge::roster 的 screen_label）
pub fn status_code(kind: ClaudeScreenKind) -> &'static str {
    match kind {
        ClaudeScreenKind::Permission => "permission",
        ClaudeScreenKind::TrustFolder => "trust",
        ClaudeScreenKind::BypassWarning => "bypass_warning",
        ClaudeScreenKind::Login => "login",
        ClaudeScreenKind::UsageLimit => "usage_limit",
        ClaudeScreenKind::Attention => "attention",
    }
}

/// 權限詢問顯示給本人看的文字最多幾行：再長就不算完整
const PROMPT_TEXT_MAX_LINES: usize = 40;

/// 權限詢問的完整文字（指令、路徑、選項）。只給本機畫面確認用
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PromptText {
    pub text: String,
    /// 看得到提示的開頭，而且沒有超過行數上限。不完整就不能按「允許」
    pub complete: bool,
}

/// 畫面文字是外部內容：去掉控制字元與會改變顯示順序、藏字的字元，只留換行
fn clean_prompt_line(line: &str) -> String {
    line.chars().filter(|c| !c.is_control() && !matches!(*c, '\u{200B}'..='\u{200F}' | '\u{202A}'..='\u{202E}' | '\u{2060}'..='\u{2069}' | '\u{FEFF}')).collect::<String>().trim_end().to_string()
}

/// 只有認得的權限詢問才有文字，其他畫面一律 None
pub fn permission_text(screen: &str) -> Option<PromptText> {
    if classify(screen)?.kind != ClaudeScreenKind::Permission {
        return None;
    }
    let lines: Vec<&str> = screen.lines().map(str::trim_end).collect();
    let end = lines.iter().rposition(|l| !l.trim().is_empty() && !is_rule(l))? + 1;
    let cursor = lines[..end].iter().rposition(|l| l.trim_start().starts_with(CURSOR))?;
    // 提示框的開頭是實線（裡面的分隔是虛線）；看不到實線就是提示比畫面長
    let top = lines[..cursor].iter().rposition(|l| is_rule(l) && l.trim().starts_with('─'));
    let start = top.map_or(0, |t| t + 1);
    let kept: Vec<String> = lines[start..end].iter().map(|l| clean_prompt_line(l)).collect();
    let complete = top.is_some() && kept.len() <= PROMPT_TEXT_MAX_LINES;
    Some(PromptText { text: kept.join("\n"), complete })
}

/// 判斷畫面。回 None 代表沒有偵測到提示（包含閒置、執行中，以及認不出來的畫面）
pub fn classify(text: &str) -> Option<ClaudeScreen> {
    let lines: Vec<&str> = text.lines().map(str::trim_end).collect();
    let end = lines.iter().rposition(|l| !l.trim().is_empty())? + 1;
    let lines = &lines[..end];
    if input_box_at_bottom(lines) {
        return notice_above_input(lines);
    }
    menu_at_bottom(lines)
}

/// 底部有輸入框或狀態列：這時選單不會擋住輸入，畫面上任何長得像選單的文字都不當提示
fn input_box_at_bottom(lines: &[&str]) -> bool {
    let start = lines.len().saturating_sub(4);
    (start..lines.len()).any(|i| {
        let t = lines[i].trim();
        if STATUS_LINE_MARKS.iter().any(|m| t.contains(m)) {
            return true;
        }
        let Some(rest) = t.strip_prefix(CURSOR) else { return false };
        let numbered_row = rest.trim_start().starts_with(|c: char| c.is_ascii_digit());
        i > 0 && is_rule(lines[i - 1]) && !numbered_row
    })
}

/// 分隔線。有名字的視窗會把名字嵌在線上（`─── 名字 ─`），所以只要頭尾是線、線的字元夠多就算
fn is_rule(line: &str) -> bool {
    let is_line = |c: char| matches!(c, '─' | '╌' | '▔' | '▁');
    let t = line.trim();
    t.chars().next().is_some_and(is_line) && t.chars().last().is_some_and(is_line) && t.chars().filter(|c| is_line(*c)).count() >= MIN_RULE_CHARS
}

/// 輸入框還在，訊息又緊貼在它上方的 Claude 輸出行：只標狀態，不給按鈕
fn notice_above_input(lines: &[&str]) -> Option<ClaudeScreen> {
    let start = lines.len().saturating_sub(NOTICE_LOOKBACK);
    let notice = lines[start..].iter().rev().find_map(|l| {
        let t = l.trim_start();
        if !(t.starts_with('●') || t.starts_with('⎿')) {
            return None;
        }
        let body = t.trim_start_matches(['●', '⎿', ' ']);
        if body.starts_with(USAGE_LIMIT) {
            Some(ClaudeScreenKind::UsageLimit)
        } else if body.ends_with(LOGIN_EXPIRED) {
            Some(ClaudeScreenKind::Login)
        } else {
            None
        }
    })?;
    Some(screen(notice, "", Vec::new(), 0, None, None))
}

fn screen(kind: ClaudeScreenKind, question: &str, options: Vec<ClaudeOption>, cursor: usize, allow_once: Option<u32>, deny: Option<u32>) -> ClaudeScreen {
    ClaudeScreen { kind, question: question.to_string(), options, cursor, allow_once, deny }
}

struct Menu {
    question: String,
    options: Vec<ClaudeOption>,
    cursor: usize,
    numbered: bool,
    above: usize,
}

fn menu_at_bottom(lines: &[&str]) -> Option<ClaudeScreen> {
    let cursors = lines.iter().filter(|l| l.trim_start().starts_with(CURSOR)).count();
    // 用來判斷的是最底下的區塊：往上跳過頁尾與分隔線，碰到別的內容就算不是選單
    let mut last = lines.len();
    let mut footers = 0;
    while last > 0 {
        let t = lines[last - 1].trim();
        if t.is_empty() || is_rule(t) {
            last -= 1;
        } else if FOOTER_PREFIXES.iter().any(|f| t.starts_with(f)) {
            footers += 1;
            last -= 1;
        } else {
            break;
        }
        if footers > MAX_FOOTER_LINES {
            return None;
        }
    }
    let Some(menu) = parse_options(&lines[..last]) else {
        // 底部沒有選單。還有選單游標的話，有東西在等但認不出來
        return (cursors > 0).then(|| screen(ClaudeScreenKind::Attention, "", Vec::new(), 0, None, None));
    };
    // 同一個區塊裡只能有一個游標：區塊從上一條分隔線算起
    let block_start = lines[..menu.above].iter().rposition(|l| is_rule(l)).map_or(0, |i| i + 1);
    let cursors_in_block = lines[block_start..last].iter().filter(|l| l.trim_start().starts_with(CURSOR)).count();
    let kind_ok = cursors_in_block == 1;
    let context = lines[block_start..menu.above].join("\n");
    Some(judge(menu, kind_ok, &context))
}

fn judge(m: Menu, single_cursor: bool, context: &str) -> ClaudeScreen {
    let labels: Vec<&str> = m.options.iter().map(|o| o.label.as_str()).collect();
    let n_of = |want: &str| m.options.iter().find(|o| o.label == want).map(|o| o.n);
    let attention = |m: Menu| screen(ClaudeScreenKind::Attention, &m.question, m.options, m.cursor, None, None);
    if !single_cursor {
        return attention(m);
    }
    if !m.numbered && labels.len() == 2 && labels.contains(&TRUST_NO) && labels.contains(&TRUST_YES) && context.contains("Quick safety check") {
        let (allow, deny) = (n_of(TRUST_YES), n_of(TRUST_NO));
        return screen(ClaudeScreenKind::TrustFolder, &m.question, m.options, m.cursor, allow, deny);
    }
    if labels.contains(&BYPASS_YES) && labels.contains(&TRUST_NO) && context.contains("Bypass Permissions mode") {
        return screen(ClaudeScreenKind::BypassWarning, &m.question, m.options, m.cursor, None, None);
    }
    if context.contains(LOGIN_MENU) || m.question.contains(LOGIN_MENU) {
        return screen(ClaudeScreenKind::Login, &m.question, m.options, m.cursor, None, None);
    }
    let asks = m.question.starts_with("Do you want to ") && m.question.ends_with('?');
    let yes_first = m.options.first().is_some_and(|o| o.n == 1 && o.label == "Yes");
    let deny = m.options.iter().rev().find(|o| o.label == "No" || o.label.starts_with("No,")).map(|o| o.n);
    if m.numbered && asks && yes_first && m.cursor == 0 && deny.is_some() {
        return screen(ClaudeScreenKind::Permission, &m.question, m.options, m.cursor, Some(1), deny);
    }
    attention(m)
}

/// 由下往上解析選單：`❯ 1. Yes`、`  2. Yes, and …`（可折行），或沒有編號的 `❯ No, exit`。
/// 編號要從 1 連續；只有一個游標；對不上就回 None
fn parse_options(lines: &[&str]) -> Option<Menu> {
    let mut rows: Vec<(usize, String, bool)> = Vec::new();
    let mut pending: Vec<String> = Vec::new();
    let mut i = lines.len();
    let base_indent = |l: &str| l.chars().take_while(|c| *c == ' ').count();
    while i > 0 {
        let line = lines[i - 1];
        let t = line.trim_start();
        if t.is_empty() {
            break;
        }
        let selected = t.starts_with(CURSOR);
        let body = if selected { t[CURSOR.len_utf8()..].trim_start() } else { t };
        if selected || numbered(body).is_some() {
            let mut label = body.to_string();
            for p in pending.drain(..).rev() {
                label.push(' ');
                label.push_str(&p);
            }
            rows.push((base_indent(line), label, selected));
            i -= 1;
            if rows.len() > MAX_OPTIONS {
                return None;
            }
            continue;
        }
        // 沒有編號也沒有游標：可能是折行，或（沒有編號的選單）下一個選項。先記著，上面碰到選項才算折行
        if rows.is_empty() && base_indent(line) == 0 {
            return None;
        }
        pending.push(t.to_string());
        i -= 1;
        if pending.len() > 3 {
            break;
        }
    }
    let above_extra = pending.len();
    rows.reverse();
    if rows.iter().filter(|r| r.2).count() != 1 {
        return unnumbered(lines);
    }
    if rows.len() == 1 {
        return unnumbered(lines);
    }
    let mut options = Vec::with_capacity(rows.len());
    for (idx, r) in rows.iter().enumerate() {
        let (n, label) = numbered(&r.1)?;
        if n as usize != idx + 1 {
            return None;
        }
        options.push(ClaudeOption { n, label: label.to_string() });
    }
    let cursor = rows.iter().position(|r| r.2)?;
    let above = i + above_extra;
    Some(Menu { question: question_above(lines, above), options, cursor, numbered: true, above })
}

/// 信任資料夾這種沒有編號的選單：最底下連續的幾行，恰好一行帶游標
fn unnumbered(lines: &[&str]) -> Option<Menu> {
    let mut start = lines.len();
    while start > 0 && !lines[start - 1].trim().is_empty() {
        start -= 1;
    }
    let block = &lines[start..];
    if !(2..=MAX_OPTIONS).contains(&block.len()) {
        return None;
    }
    let cursor = block.iter().position(|l| l.trim_start().starts_with(CURSOR))?;
    if block.iter().filter(|l| l.trim_start().starts_with(CURSOR)).count() != 1 {
        return None;
    }
    let options = block
        .iter()
        .enumerate()
        .map(|(i, l)| {
            let t = l.trim_start();
            let label = if i == cursor { t[CURSOR.len_utf8()..].trim_start() } else { t };
            ClaudeOption { n: i as u32 + 1, label: label.to_string() }
        })
        .collect();
    Some(Menu { question: question_above(lines, start), options, cursor, numbered: false, above: start })
}

fn numbered(s: &str) -> Option<(u32, &str)> {
    let (n, rest) = s.split_once(". ")?;
    if n.is_empty() || n.len() > 2 || !n.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    Some((n.parse().ok()?, rest.trim()))
}

fn question_above(lines: &[&str], above: usize) -> String {
    lines[..above].iter().rev().map(|l| l.trim()).find(|l| !l.is_empty() && !is_rule(l)).unwrap_or("").to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use ClaudeScreenKind as K;

    macro_rules! fixture {
        ($name:literal) => {
            include_str!(concat!("../../tests/fixtures/term-screens/", $name, ".txt"))
        };
    }

    fn kind(text: &str) -> Option<K> {
        classify(text).map(|s| s.kind)
    }

    #[test]
    fn 權限詢問_三種工具都認得_拒絕對到最後的_no() {
        for (text, deny) in [(fixture!("claude-permission-bash"), 4), (fixture!("claude-permission-write"), 3), (fixture!("claude-permission-webfetch"), 3)] {
            let s = classify(text).expect("要認得");
            assert_eq!(s.kind, K::Permission, "{}", s.question);
            assert_eq!(s.allow_once, Some(1));
            assert_eq!(s.deny, Some(deny));
            assert_eq!(s.cursor, 0);
        }
    }

    #[test]
    fn 信任資料夾_游標兩個位置都認得_預設在拒絕() {
        let s = classify(fixture!("claude-trust-folder")).unwrap();
        assert_eq!(s.kind, K::TrustFolder);
        assert_eq!((s.cursor, s.deny, s.allow_once), (0, Some(1), Some(2)));
        let s = classify(fixture!("claude-trust-folder-yes-selected")).unwrap();
        assert_eq!((s.kind, s.cursor), (K::TrustFolder, 1));
    }

    #[test]
    fn 略過權限警告_只標狀態_不給按鈕() {
        let s = classify(fixture!("claude-bypass-warning.synthetic")).unwrap();
        assert_eq!(s.kind, K::BypassWarning);
        assert_eq!((s.allow_once, s.deny), (None, None));
    }

    #[test]
    fn 登入與額度_只標狀態_不給按鈕() {
        // 合成樣本只有訊息本身；真實畫面底下還有輸入框
        let with_input = |t: &str| format!("{t}
──────────────
❯ 
──────────────
  ? for shortcuts
");
        let cases = [
            (fixture!("claude-login-method").to_string(), K::Login),
            (with_input(fixture!("claude-login-expired.synthetic")), K::Login),
            (with_input(fixture!("claude-usage-limit.synthetic")), K::UsageLimit),
        ];
        for (text, want) in cases {
            let s = classify(&text).expect("要認得");
            assert_eq!(s.kind, want);
            assert_eq!((s.allow_once, s.deny), (None, None));
        }
    }

    #[test]
    fn 認不得的選單_需要人工確認_不給按鈕() {
        for text in [fixture!("claude-ask-user-question"), fixture!("claude-plan-approval"), fixture!("claude-firstrun-theme")] {
            let s = classify(text).expect("要標人工確認");
            assert_eq!(s.kind, K::Attention, "{}", s.question);
            assert_eq!((s.allow_once, s.deny), (None, None));
        }
    }

    #[test]
    fn 閒置與執行中_沒有提示() {
        for text in [
            fixture!("claude-idle-auto-mode"),
            fixture!("claude-idle-manual-mode"),
            fixture!("claude-idle-after-reply"),
            fixture!("claude-running"),
            fixture!("claude-auto-mode-teach"),
            "",
            "\n\n",
        ] {
            assert_eq!(kind(text), None, "{text}");
        }
    }

    #[test]
    fn 內容長得像提示_底部還有輸入框_一律不給按鈕() {
        for text in [fixture!("claude-lookalike-model-text"), fixture!("claude-lookalike-tool-output")] {
            assert_eq!(kind(text), None, "{text}");
        }
    }

    #[test]
    fn 內容長得像提示_沒有輸入框也不給按鈕() {
        // 窗格裡已經不是 Claude（例如結束後的殼層印出檔案）時的最壞情況：確認前景是 Claude 由第 2 段負責，這裡至少不能出現多游標還給按鈕
        let two = "Do you want to proceed?\n ❯ 1. Yes\n   2. No\n\nQuick safety check: Is this a project\n ❯ No, exit\n   Yes, I trust this folder\n";
        let s = classify(two).unwrap();
        assert_eq!((s.allow_once, s.deny), (None, None), "{s:?}");
    }

    #[test]
    fn 選單條件缺一項_都不給按鈕() {
        let cases = [
            // 第一項不是 Yes
            "Do you want to proceed?\n ❯ 1. Yes, always\n   2. No\n",
            // 沒有拒絕
            "Do you want to proceed?\n ❯ 1. Yes\n   2. Later\n",
            // 問句不對
            "Please choose\n ❯ 1. Yes\n   2. No\n",
            // 游標不在第一項：畫面狀態對不上，寧可不給
            "Do you want to proceed?\n   1. Yes\n ❯ 2. No\n",
            // 編號不連續
            "Do you want to proceed?\n ❯ 1. Yes\n   3. No\n",
        ];
        for text in cases {
            if let Some(s) = classify(text) {
                assert_eq!((s.kind, s.allow_once, s.deny), (K::Attention, None, None), "{text}");
            }
        }
    }

    #[test]
    fn 模型輸出提到登入或額度_不算() {
        let text = "我查到這句 You've hit your limit，還有 Please run /login 的說明
──────────────
❯ 
──────────────
  ? for shortcuts
";
        assert_eq!(kind(text), None);
    }

    #[test]
    fn 權限文字_只有權限詢問才有_看得到開頭才算完整() {
        let t = permission_text(fixture!("claude-permission-bash")).unwrap();
        assert!(t.complete);
        assert!(t.text.contains("mkdir c1dir") && t.text.contains("Do you want to proceed?") && t.text.contains("4. No"), "{}", t.text);
        assert!(!t.text.contains("Use a shell command"), "提示框外的內容不算：{}", t.text);
        for other in [fixture!("claude-trust-folder"), fixture!("claude-ask-user-question"), fixture!("claude-lookalike-model-text"), fixture!("claude-idle-auto-mode"), fixture!("claude-login-method")] {
            assert_eq!(permission_text(other), None);
        }
        // 提示比畫面長：看不到開頭的實線
        let cut = " rm -rf a\n Do you want to proceed?\n ❯ 1. Yes\n   2. No\n";
        assert!(!permission_text(cut).unwrap().complete);
        let long = format!("──────────────\n{}\n Do you want to proceed?\n ❯ 1. Yes\n   2. No\n", " x\n".repeat(50));
        assert!(!permission_text(&long).unwrap().complete, "超過行數上限");
    }

    #[test]
    fn 權限文字_清掉控制字元與藏字元() {
        let s = "──────────────\n echo \u{1b}[31m紅\u{202E}反\u{200B}藏\u{7}\n Do you want to proceed?\n ❯ 1. Yes\n   2. No\n";
        let t = permission_text(s).unwrap();
        assert!(t.text.contains("echo [31m紅反藏"), "{:?}", t.text);
        assert!(!t.text.chars().any(|c| c.is_control() && c != '\n'), "{:?}", t.text);
    }

    #[test]
    fn 信任提示缺上下文_不算信任資料夾() {
        let s = classify(" ❯ No, exit\n   Yes, I trust this folder\n").unwrap();
        assert_eq!((s.kind, s.allow_once), (K::Attention, None));
    }
}

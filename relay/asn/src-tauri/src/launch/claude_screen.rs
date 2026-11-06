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
    /// AI 用選項框問的單選題（AskUserQuestion）：按數字鍵就送出
    Question,
    /// 選項框，但手機不能按：多選、一次多題，或正停在自由輸入那一列
    QuestionView,
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
const QUESTION_FOOTER: &str = "Enter to select";
const QUESTION_CHAT: &str = "Chat about this";
const QUESTION_TYPE: &str = "Type something";
const QUESTION_TYPE_DOT: &str = "Type something.";
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
        ClaudeScreenKind::Question => "question",
        ClaudeScreenKind::QuestionView => "question_view",
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

/// 權限框傳到手機時給哪些選項（#853）。**只有這裡決定，** 要改就改這裡。
/// 目前只給「只有這一次」和拒絕：其他選項（例如以後都允許）影響的不只這一次，留在電腦上決定。
/// 內容不完整時本人看不到全部，只能拒絕。
/// 選項框的單選題全部給；多選、一次多題看得到但不能按；內容不完整也不給。
/// 權限框的按鈕字在手機上用中文（Claude 原文是英文的 Yes／No）；選項框的選項是夥伴自己寫的，照原文
pub const PHONE_ALLOW_ONCE: &str = "只有這一次";
pub const PHONE_DENY: &str = "拒絕";

pub fn phone_options(screen: &ClaudeScreen, complete: bool) -> Vec<ClaudeOption> {
    match screen.kind {
        ClaudeScreenKind::Permission => screen
            .options
            .iter()
            .filter_map(|o| {
                let label = if Some(o.n) == screen.deny {
                    PHONE_DENY
                } else if complete && Some(o.n) == screen.allow_once {
                    PHONE_ALLOW_ONCE
                } else {
                    return None;
                };
                Some(ClaudeOption { n: o.n, label: label.to_string() })
            })
            .collect(),
        ClaudeScreenKind::Question if complete => screen.options.clone(),
        _ => Vec::new(),
    }
}

/// 這個狀態代號的內容要不要傳到手機（`status_code` 的值）
pub fn goes_to_phone(code: &str) -> bool {
    code == status_code(ClaudeScreenKind::Permission) || code == status_code(ClaudeScreenKind::Question) || code == status_code(ClaudeScreenKind::QuestionView)
}

/// 傳到手機的文字：權限框或選項框本身，不含上方的對話
pub fn phone_text(screen: &str) -> Option<PromptText> {
    match classify(screen)?.kind {
        ClaudeScreenKind::Permission => permission_text(screen),
        ClaudeScreenKind::Question | ClaudeScreenKind::QuestionView => {
            let lines: Vec<&str> = screen.lines().map(str::trim_end).collect();
            let end = lines.iter().rposition(|l| !l.trim().is_empty())? + 1;
            let q = question_box(&lines[..end])?;
            let kept: Vec<String> = lines[q.top + 1..q.bottom].iter().map(|l| clean_prompt_line(l)).collect();
            let complete = kept.len() <= PROMPT_TEXT_MAX_LINES;
            Some(PromptText { text: kept.join("\n").trim().to_string(), complete })
        }
        _ => None,
    }
}

/// 選項框（AskUserQuestion）。樣本見 #853（Claude Code 2.1.318）。由下往上：頁尾、`N. Chat about this`、
/// 分隔線、選項、問題、標題列、分隔線。條件全符合才算，對不上就回 None，交給一般的判斷（不給按鈕）。
///
/// **單選和多選只差 `[ ]`：** 多選按數字只是切換勾選，不會送出，所以只有確定是單選才給按鈕。
struct QuestionBox {
    screen: ClaudeScreen,
    top: usize,
    bottom: usize,
}

/// 選項列：`❯ 1. 文字` 或兩格縮排的 `  2. 文字`。說明行縮排更深，內文裡的 `1. x` 沒有縮排，都不算。回（編號, 文字, 有游標）
fn question_row(line: &str) -> Option<(u32, &str, bool)> {
    let (rest, cursor) = match line.strip_prefix(CURSOR) {
        Some(r) => (r.strip_prefix(' ')?, true),
        None => (line.strip_prefix("  ")?, false),
    };
    let (n, label) = rest.split_once(". ")?;
    if n.is_empty() || !n.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    Some((n.parse().ok()?, label.trim(), cursor))
}

fn question_box(lines: &[&str]) -> Option<QuestionBox> {
    // 夥伴視窗有名字時，Claude 會在最底下再畫一條嵌著名字的分隔線（「─── 名字 ─」）：先略過，頁尾才是倒數那一行
    let mut n = lines.len();
    while n > 0 && (lines[n - 1].trim().is_empty() || is_rule(lines[n - 1])) {
        n -= 1;
    }
    let lines = &lines[..n];
    let footer = lines.last()?.trim();
    if !footer.starts_with(QUESTION_FOOTER) || !footer.contains("Esc to cancel") {
        return None;
    }
    let mut i = lines.len() - 1;
    while i > 0 && (i == lines.len() - 1 || lines[i].trim().is_empty()) {
        i -= 1;
    }
    let (chat_n, chat, chat_cursor) = question_row(lines[i])?;
    if chat != QUESTION_CHAT || i == 0 || !is_rule(lines[i - 1]) {
        return None;
    }
    let bottom = i - 1;
    let top = lines[..bottom].iter().rposition(|l| is_rule(l))?;
    let body = &lines[top + 1..bottom];
    let tab_at = body.iter().position(|l| !l.trim().is_empty())?;
    let tab = body[tab_at].trim();
    if !tab.starts_with(['☐', '☒', '←']) {
        return None;
    }
    let mut rows: Vec<(u32, &str, bool)> = Vec::new();
    let mut question: Vec<&str> = Vec::new();
    for line in &body[tab_at + 1..] {
        if let Some(r) = question_row(line) {
            rows.push(r);
        } else if rows.is_empty() {
            if !line.trim().is_empty() {
                question.push(line.trim());
            }
        } else if !line.trim().is_empty() && !line.starts_with("   ") {
            return None; // 選項之間冒出認不得的東西
        }
    }
    let consecutive = rows.iter().enumerate().all(|(i, r)| r.0 == i as u32 + 1);
    let cursors = rows.iter().filter(|r| r.2).count();
    let (last_n, last_label, last_cursor) = *rows.last()?;
    if rows.len() < 2 || !consecutive || cursors + usize::from(chat_cursor) != 1 || chat_n != last_n + 1 {
        return None;
    }
    if !last_label.ends_with(QUESTION_TYPE) && !last_label.ends_with(QUESTION_TYPE_DOT) {
        return None;
    }
    let checkbox = rows.iter().any(|r| r.1.starts_with('['));
    let single = !checkbox
        && last_label == QUESTION_TYPE_DOT
        && !tab.contains("Submit")
        && !tab.starts_with('←')
        && footer.contains("↑/↓ to navigate")
        && !footer.contains("ctrl+g")
        && !last_cursor
        && !chat_cursor
        && last_n <= 9;
    let options: Vec<ClaudeOption> = rows[..rows.len() - 1].iter().map(|r| ClaudeOption { n: r.0, label: r.1.to_string() }).collect();
    let cursor = rows.iter().position(|r| r.2).unwrap_or(0);
    let kind = if single { ClaudeScreenKind::Question } else { ClaudeScreenKind::QuestionView };
    Some(QuestionBox { screen: screen(kind, &question.join(" "), options, cursor, None, None), top, bottom })
}

/// 判斷畫面。回 None 代表沒有偵測到提示（包含閒置、執行中，以及認不出來的畫面）
pub fn classify(text: &str) -> Option<ClaudeScreen> {
    let lines: Vec<&str> = text.lines().map(str::trim_end).collect();
    let end = lines.iter().rposition(|l| !l.trim().is_empty())? + 1;
    let lines = &lines[..end];
    if let Some(q) = question_box(lines) {
        return Some(q.screen);
    }
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
    fn 權限詢問_最底下多一條嵌著視窗名字的分隔線也認得() {
        // ASN 開的夥伴都有名字：Claude 在頁尾下面再畫一條「─── 名字 ─」（40家用 實機，#863）
        let named = format!("{}\n────────── wake-test3 ─\n", fixture!("claude-permission-write").trim_end());
        let s = classify(&named).expect("帶名字線的權限框");
        assert_eq!(s.kind, K::Permission, "{}", s.question);
        assert_eq!((s.allow_once, s.deny), (Some(1), Some(3)));
        let t = phone_text(&named).expect("手機看得到內容");
        assert!(!t.text.contains("wake-test3"), "{}", t.text);
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

#[cfg(test)]
mod phone_option_tests {
    use super::*;

    fn screen() -> ClaudeScreen {
        let opt = |n, l: &str| ClaudeOption { n, label: l.to_string() };
        ClaudeScreen {
            kind: ClaudeScreenKind::Permission,
            question: "Do you want to proceed?".into(),
            options: vec![opt(1, "Yes"), opt(2, "Yes, and don't ask again"), opt(3, "No")],
            cursor: 0,
            allow_once: Some(1),
            deny: Some(3),
        }
    }

    #[test]
    fn 手機只給這一次和拒絕() {
        let n: Vec<u32> = phone_options(&screen(), true).iter().map(|o| o.n).collect();
        assert_eq!(n, vec![1, 3]);
    }

    #[test]
    fn 手機的權限按鈕用中文_編號照原本() {
        let o = phone_options(&screen(), true);
        let got: Vec<(u32, &str)> = o.iter().map(|o| (o.n, o.label.as_str())).collect();
        assert_eq!(got, vec![(1, PHONE_ALLOW_ONCE), (3, PHONE_DENY)], "按鈕字不是 Claude 的英文原文");
        let o = phone_options(&screen(), false);
        assert_eq!(o.iter().map(|o| (o.n, o.label.as_str())).collect::<Vec<_>>(), vec![(3, PHONE_DENY)]);
    }

    #[test]
    fn 內容不完整只能拒絕() {
        let n: Vec<u32> = phone_options(&screen(), false).iter().map(|o| o.n).collect();
        assert_eq!(n, vec![3]);
    }
}

#[cfg(test)]
mod question_box_tests {
    use super::*;

    const RULE: &str = "────────────────────────────────────────────────────────────";
    const FOOT: &str = "Enter to select · ↑/↓ to navigate · Esc to cancel";

    fn page(tab: &str, q: &str, rows: &str, chat: u32, foot: &str) -> String {
        format!("● 上面的對話 rm -rf x\n{RULE}\n{tab}\n\n{q}\n\n{rows}\n{RULE}\n  {chat}. Chat about this\n\n{foot}\n")
    }
    fn single() -> String {
        page(" ☐ 顏色", "你喜歡哪種顏色？", "❯ 1. 紅\n     紅色\n  2. 綠\n     綠色\n  3. 藍\n     藍色\n  4. Type something.", 5, FOOT)
    }
    fn multi() -> String {
        page("←  ☐ 水果  ✔ Submit  →", "你想吃哪些水果？", "❯ 1. [ ] 蘋果\n         蘋果\n  2. [ ] 香蕉\n         香蕉\n  3. [ ] Type something\n     Submit", 4, FOOT)
    }
    fn two() -> String {
        page("←  ☐ Q one  ☐ Q two  ✔ Submit  →", "Q one?", "❯ 1. Alpha\n     Alpha\n  2. Beta\n     Beta\n  3. Type something.", 4, "Enter to select · Tab/Arrow keys to navigate · Esc to cancel")
    }
    fn labels(s: &ClaudeScreen) -> Vec<(u32, String)> {
        s.options.iter().map(|o| (o.n, o.label.clone())).collect()
    }

    #[test]
    fn 單選_最底下多一條嵌著視窗名字的分隔線也認得() {
        // ASN 開的夥伴都有名字：Claude 在頁尾下面再畫一條「─── 名字 ─」（40家用 實機，#863 第 6 項）
        let named = format!("{}────────── wake-test3 ─\n", single());
        let s = classify(&named).expect("帶名字線的選項框");
        assert_eq!(s.kind, ClaudeScreenKind::Question);
        assert_eq!(labels(&s), vec![(1, "紅".to_string()), (2, "綠".to_string()), (3, "藍".to_string())]);
        let t = phone_text(&named).expect("手機看得到題目");
        assert!(t.text.contains("你喜歡哪種顏色？") && !t.text.contains("wake-test3"), "{}", t.text);
    }

    #[test]
    fn 單選_選項全部給_不含自由輸入和聊天列() {
        let s = classify(&single()).unwrap();
        assert_eq!(s.kind, ClaudeScreenKind::Question);
        assert_eq!(s.question, "你喜歡哪種顏色？");
        assert_eq!(labels(&s), vec![(1, "紅".to_string()), (2, "綠".to_string()), (3, "藍".to_string())]);
        assert_eq!(phone_options(&s, true).len(), 3);
    }

    #[test]
    fn 多選_看得到不能按() {
        let s = classify(&multi()).unwrap();
        assert_eq!(s.kind, ClaudeScreenKind::QuestionView);
        assert!(phone_options(&s, true).is_empty());
        assert!(goes_to_phone(status_code(s.kind)));
    }

    #[test]
    fn 多選_沒有標題列的提交也算多選_靠勾選框判斷() {
        let t = page(" ☐ 水果", "q", "❯ 1. [ ] 蘋果\n  2. [✔] 香蕉\n  3. Type something.", 4, FOOT);
        assert_eq!(classify(&t).unwrap().kind, ClaudeScreenKind::QuestionView);
    }

    #[test]
    fn 一次多題_看得到不能按() {
        let s = classify(&two()).unwrap();
        assert_eq!(s.kind, ClaudeScreenKind::QuestionView);
        assert!(phone_options(&s, true).is_empty());
    }

    #[test]
    fn 游標停在自由輸入或聊天列_不能按() {
        let t = page(" ☐ 色", "q", "  1. 紅\n❯ 2. Type something.", 3, FOOT);
        assert_eq!(classify(&t).unwrap().kind, ClaudeScreenKind::QuestionView);
        let t = format!("x\n{RULE}\n ☐ 色\n\nq\n\n  1. 紅\n  2. Type something.\n{RULE}\n❯ 3. Chat about this\n\n{FOOT}\n");
        assert_eq!(classify(&t).unwrap().kind, ClaudeScreenKind::QuestionView);
        let t = page(" ☐ 色", "q", "❯ 1. 紅\n  2. Type something.", 3, "Enter to select · ↑/↓ to navigate · ctrl+g to edit in Notepad · Esc to cancel");
        assert_ne!(classify(&t).unwrap().kind, ClaudeScreenKind::Question);
    }

    #[test]
    fn 打字之後_確認頁_對不上的都不給按鈕() {
        // 自由輸入打了字：最後一列不再是 Type something
        let t = page(" ☐ 色", "q", "  1. 紅\n❯ 2. abc", 3, FOOT);
        assert_eq!(classify(&t).unwrap().kind, ClaudeScreenKind::Attention);
        // Review 頁：頁尾不同，也有編號
        let t = format!("{RULE}\nReview your answers\n\n q → a\n\n❯ 1. Submit answers\n  2. Cancel\n");
        assert_ne!(classify(&t).map(|s| s.kind), Some(ClaudeScreenKind::Question));
        // 編號不連續、兩個游標、聊天列編號不對
        for t in [
            page(" ☐ 色", "q", "❯ 1. 紅\n  3. Type something.", 4, FOOT),
            page(" ☐ 色", "q", "❯ 1. 紅\n❯ 2. 綠\n  3. Type something.", 4, FOOT),
            page(" ☐ 色", "q", "❯ 1. 紅\n  2. Type something.", 9, FOOT),
            page("不是標題列", "q", "❯ 1. 紅\n  2. Type something.", 3, FOOT),
        ] {
            assert_ne!(classify(&t).map(|s| s.kind), Some(ClaudeScreenKind::Question), "{t}");
        }
    }

    #[test]
    fn 模型照抄選項框_底下有輸入框_不算() {
        let t = format!("{}\n{RULE}\n❯ \n{RULE}\n  ? for shortcuts\n", single().trim_end());
        assert_ne!(classify(&t).map(|s| s.kind), Some(ClaudeScreenKind::Question));
    }

    #[test]
    fn 問題裡有編號_選項文字像權限框_都不會弄錯() {
        let t = page(" ☐ 色", "1. 第一點\n2. 第二點", "❯ 1. Yes\n  2. No\n  3. Type something.", 4, FOOT);
        let s = classify(&t).unwrap();
        assert_eq!(s.kind, ClaudeScreenKind::Question, "不是權限框");
        assert_eq!(s.allow_once, None);
        assert_eq!(labels(&s), vec![(1, "Yes".to_string()), (2, "No".to_string())]);
    }

    #[test]
    fn 傳到手機的文字只有框_不含上方對話() {
        let p = phone_text(&single()).unwrap();
        assert!(p.complete);
        assert!(p.text.contains("你喜歡哪種顏色") && p.text.contains("紅色"));
        assert!(!p.text.contains("rm -rf"), "{}", p.text);
        assert!(!p.text.contains("Chat about this"));
    }

    #[test]
    fn 內容太長不給按鈕() {
        let s = classify(&single()).unwrap();
        assert!(phone_options(&s, false).is_empty());
    }

    #[test]
    fn 只有認得的代號才傳到手機() {
        for k in [ClaudeScreenKind::TrustFolder, ClaudeScreenKind::BypassWarning, ClaudeScreenKind::Login, ClaudeScreenKind::UsageLimit, ClaudeScreenKind::Attention] {
            assert!(!goes_to_phone(status_code(k)), "{k:?}");
        }
    }
}

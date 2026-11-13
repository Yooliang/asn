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
    /// 外來訊息確認框：只能由本人在電腦或手機的提示框上按，其他代答路徑一律不收
    HeldMessage,
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
/// 底部認不出的選單游標往上看幾行（真的選單底下可能還有預覽）
const MENU_CURSOR_LOOKBACK: usize = 16;

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
        ClaudeScreenKind::HeldMessage => "held_message",
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
    /// 不顯示、只綁進雜湊的內容：外來訊息框是整個框的內文（顯示的只是摘要，兩則摘要相同也要分得出來）；其他是空字串
    pub bind: String,
}

/// 畫面文字是外部內容：去掉控制字元與會改變顯示順序、藏字的字元，只留換行
fn clean_prompt_line(line: &str) -> String {
    strip_unsafe(line).trim_end().to_string()
}

/// 去掉控制字元與會改變顯示順序、藏字的字元（不處理空白）：零寬字元、方向控制、行／段分隔、軟連字號、標籤字元等
fn strip_unsafe(s: &str) -> String {
    s.chars()
        .filter(|c| {
            !c.is_control()
                && !matches!(
                    *c,
                    '\u{00AD}' | '\u{061C}' | '\u{180E}' | '\u{200B}'..='\u{200F}' | '\u{2028}'..='\u{202E}' | '\u{2060}'..='\u{206F}' | '\u{FEFF}' | '\u{FFF9}'..='\u{FFFB}' | '\u{E0000}'..='\u{E007F}'
                )
        })
        .collect()
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
    Some(PromptText { text: kept.join("\n"), complete, bind: String::new() })
}

/// 權限框傳到手機時給哪些選項（#853）。**只有這裡決定，** 要改就改這裡。
/// 目前只給「只有這一次」和拒絕：其他選項（例如以後都允許）影響的不只這一次，留在電腦上決定。
/// 內容不完整時本人看不到全部，只能拒絕。
/// 選項框的單選題全部給；多選、一次多題看得到但不能按；內容不完整也不給。
/// 權限框的按鈕字在手機上用中文（Claude 原文是英文的 Yes／No）；選項框的選項是夥伴自己寫的，照原文
pub const PHONE_ALLOW_ONCE: &str = "只有這一次";
pub const PHONE_DENY: &str = "拒絕";
/// 外來訊息確認框的兩顆按鈕字。沒有「以後都放行」這類選項
pub const PHONE_HELD_DENY: &str = "不放行";
pub const PHONE_HELD_DELIVER: &str = "放行這一則";

pub fn phone_options(screen: &ClaudeScreen, complete: bool) -> Vec<ClaudeOption> {
    match screen.kind {
        // 游標不在「不放行」上就只能看，不給按鈕：送鍵的算法只認游標在第一項
        ClaudeScreenKind::HeldMessage if screen.cursor == 0 => vec![
            ClaudeOption { n: 1, label: PHONE_HELD_DENY.to_string() },
            ClaudeOption { n: 2, label: PHONE_HELD_DELIVER.to_string() },
        ],
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

/// 選項的種類（#1445）：手機用來決定要不要按住一秒；舊手機看不到警告時，電腦端用它決定舊的選項只給拒絕。
/// 只有權限框才判斷，而且選項是從底部的選項區依位置解析出來的（`menu_at_bottom`），本文裡像選項的行不算。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OptionKind {
    /// 只放行這一次：編號 1、字就是 Claude 固定的「Yes」
    AllowOnce,
    /// 其他以「Yes」開頭的（以後都允許、改成自動模式等）：影響不只這一次
    AllowAlways,
    /// 拒絕：權限框判斷出來的那一項
    Deny,
    /// 認不出的
    Other,
}

pub fn option_kind_code(k: OptionKind) -> &'static str {
    match k {
        OptionKind::AllowOnce => "allow_once",
        OptionKind::AllowAlways => "allow_always",
        OptionKind::Deny => "deny",
        OptionKind::Other => "other",
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FullOption {
    /// 畫面上的數字鍵（和 `phone_options` 同一套編號）
    pub n: u32,
    pub label: String,
    pub kind: OptionKind,
}

/// 選項的字上限（和後台相同）
const FULL_LABEL_MAX: usize = 200;

/// 權限框的完整原始選項（#1445：小良哥要求照原本的選項顯示）。只有權限框有，其他框回空的（手機照舊用 `phone_options`）。
/// 種類只靠「這是認得的權限框」加上 Claude 固定的字與位置判斷；夥伴寫的字不會變成放行類：
/// - 編號 1 而且字恰好是「Yes」（而且權限框判斷的「允許這一次」就是它）才算 AllowOnce；
/// - 權限框判斷的拒絕那一項算 Deny；
/// - 其他以「Yes」開頭的一律算 AllowAlways（寧可多要求按住）。
pub fn phone_options_full(screen: &ClaudeScreen) -> Vec<FullOption> {
    if screen.kind != ClaudeScreenKind::Permission {
        return Vec::new();
    }
    screen
        .options
        .iter()
        .map(|o| {
            let kind = if o.n == 1 && o.label == "Yes" && screen.allow_once == Some(1) {
                OptionKind::AllowOnce
            } else if Some(o.n) == screen.deny {
                OptionKind::Deny
            } else if o.label.starts_with("Yes") {
                OptionKind::AllowAlways
            } else {
                OptionKind::Other
            };
            // cap_chars 截斷時會補一個「…」，所以少留一個字
            FullOption { n: o.n, label: cap_chars(&strip_unsafe(&o.label), FULL_LABEL_MAX - 1), kind }
        })
        .collect()
}

/// 這個狀態代號的內容要不要傳到手機（`status_code` 的值）
pub fn goes_to_phone(code: &str) -> bool {
    code == status_code(ClaudeScreenKind::Permission)
        || code == status_code(ClaudeScreenKind::Question)
        || code == status_code(ClaudeScreenKind::QuestionView)
        || code == status_code(ClaudeScreenKind::HeldMessage)
}

/// 選項列開頭的游標符號換成空格：游標在哪一列不算內容。**雜湊就是從這份文字算的**，建請求和送字前重查
/// 都走 `phone_text`，所以只有這一處決定游標算不算（#921）。列的寬度不變，內容其餘部分一個字不動
fn hide_cursor(line: &str) -> String {
    match line.strip_prefix(CURSOR) {
        Some(rest) => format!(" {rest}"),
        None => line.to_string(),
    }
}

/// 傳到手機的文字：權限框或選項框本身，不含上方的對話
pub fn phone_text(screen: &str) -> Option<PromptText> {
    match classify(screen)?.kind {
        ClaudeScreenKind::Permission => permission_text(screen),
        // 外來訊息只顯示整理過的摘要（寄件名、前幾行），不放畫面原文
        ClaudeScreenKind::HeldMessage => Some(PromptText { text: held_phone_text(&held_view(screen)), complete: true, bind: held_bind(screen) }),
        ClaudeScreenKind::Question | ClaudeScreenKind::QuestionView => {
            let lines: Vec<&str> = screen.lines().map(str::trim_end).collect();
            let end = lines.iter().rposition(|l| !l.trim().is_empty())? + 1;
            let q = question_box(&lines[..end])?;
            // 自由輸入那一行（「N. Type something.」）手機沒有按鈕，內容也不放（#914）
            let kept: Vec<String> = lines[q.top + 1..q.bottom].iter().filter(|l| !is_free_input_row(l)).map(|l| hide_cursor(&clean_prompt_line(l))).collect();
            let complete = kept.len() <= PROMPT_TEXT_MAX_LINES;
            Some(PromptText { text: kept.join("\n").trim().to_string(), complete, bind: String::new() })
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

/// 選項框裡的自由輸入那一行（單選「N. Type something.」、多選「N. [ ] Type something」）
fn is_free_input_row(line: &str) -> bool {
    question_row(line).is_some_and(|(_, label, _)| label.ends_with(QUESTION_TYPE) || label.ends_with(QUESTION_TYPE_DOT))
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
/// Claude Code 的「Held message from another session」確認框（#1254）：別的 session 塞進來的訊息被擋住，等本人決定要不要放行。
/// 以畫面最底端的框為準：最後兩個非空行是兩個沒有編號的選項（Deny…、Deliver…），只有一個游標，上面不遠處有標題列。
/// 對話記錄裡的「● Held peer message」在框收掉後還會留著，不能單獨當依據；對話內容剛好引用標題也不算（那時底端是輸入框）。
pub const HELD_TITLE: &str = "Held message from another session";
pub fn is_held_message(text: &str) -> bool {
    let lines: Vec<&str> = text.lines().map(str::trim_end).filter(|l| !l.trim().is_empty()).collect();
    let n = lines.len();
    if n < 3 {
        return false;
    }
    let opt = |l: &str| {
        let t = l.trim();
        match t.strip_prefix(CURSOR) {
            Some(r) => (true, r.trim_start().to_string()),
            None => (false, t.to_string()),
        }
    };
    let ((c1, a), (c2, b)) = (opt(lines[n - 2]), opt(lines[n - 1]));
    if !(a.starts_with("Deny") && b.starts_with("Deliver")) || c1 == c2 {
        return false;
    }
    lines[n.saturating_sub(40)..n - 2].iter().any(|l| l.trim() == HELD_TITLE)
}

/// 外來訊息確認框底下兩個選項的原文與游標位置（0＝不放行、1＝放行）。只在 `is_held_message` 成立時呼叫
fn held_options(text: &str) -> (Vec<ClaudeOption>, usize) {
    let lines: Vec<&str> = text.lines().map(str::trim_end).filter(|l| !l.trim().is_empty()).collect();
    let n = lines.len();
    let label = |l: &str| {
        let t = l.trim();
        t.strip_prefix(CURSOR).map_or(t, str::trim_start).to_string()
    };
    let cursor = usize::from(!lines[n - 2].trim_start().starts_with(CURSOR));
    (vec![ClaudeOption { n: 1, label: label(lines[n - 2]) }, ClaudeOption { n: 2, label: label(lines[n - 1]) }], cursor)
}

/// 外來訊息確認框裡要給本人看的部分。框裡的字是外來內容：只拿來顯示，不能決定任何動作
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct HeldView {
    /// 對方自稱的名字（不一定是真的）
    pub sender: Option<String>,
    /// 訊息前幾行
    pub body: Vec<String>,
    /// 框裡寫的總行數（比顯示的多時，代表還有沒列出來的）
    pub more_lines: Option<u32>,
}

const HELD_CLAIMS: &str = "(peer claims name: ";
const HELD_BODY_HEAD: &str = "Message body (this is what will be delivered):";
const HELD_SENDER_MAX: usize = 40;
const HELD_BODY_LINE_MAX: usize = 100;
const HELD_BODY_MAX_LINES: usize = 6;

fn cap_chars(s: &str, max: usize) -> String {
    if s.chars().count() > max {
        let mut out: String = s.chars().take(max).collect();
        out.push('…');
        out
    } else {
        s.to_string()
    }
}

/// Claude 自己寫在框裡最後一行的總行數標記：整行剛好是「│ …[N lines, M chars total — full body will be delivered on approve]」。
/// 只認這個固定格式：訊息本文自己寫的「[1 lines] …」之類不算，照樣留在摘要裡
const HELD_TOTAL_TAIL: &str = " chars total — full body will be delivered on approve]";
fn held_total_lines(line: &str) -> Option<u32> {
    let rest = line.trim_start().strip_prefix('│')?.trim().strip_prefix("…[")?;
    let lines: String = rest.chars().take_while(char::is_ascii_digit).collect();
    let after = rest[lines.len()..].strip_prefix(" lines, ")?;
    let chars: String = after.chars().take_while(char::is_ascii_digit).collect();
    if lines.is_empty() || chars.is_empty() || &after[chars.len()..] != HELD_TOTAL_TAIL {
        return None;
    }
    lines.parse().ok()
}

/// 只從畫面最底下的框（最後一個標題列起）取出寄件名與訊息前幾行
pub fn held_view(text: &str) -> HeldView {
    let lines: Vec<&str> = text.lines().collect();
    let Some(title) = lines.iter().rposition(|l| l.trim() == HELD_TITLE) else { return HeldView::default() };
    let region = &lines[title + 1..];
    let head_at = region.iter().position(|l| l.contains(HELD_BODY_HEAD));
    let (desc, after) = match head_at {
        Some(i) => (&region[..i], &region[i + 1..]),
        None => (region, &region[region.len()..]),
    };
    // 說明那段會被終端機折行，名字可能被折到下一行：先併成一行再找
    let joined = desc.iter().flat_map(|l| l.split_whitespace()).collect::<Vec<_>>().join(" ");
    let sender = joined.split_once(HELD_CLAIMS).and_then(|(_, rest)| rest.split_once(')')).and_then(|(name, _)| {
        let clean = strip_unsafe(name);
        let shown = cap_chars(clean.trim(), HELD_SENDER_MAX);
        (!shown.is_empty()).then_some(shown)
    });
    let bars: Vec<&str> = after.iter().map(|l| l.trim_start()).filter(|l| l.starts_with('│')).collect();
    let more_lines = bars.last().and_then(|l| held_total_lines(l));
    let content = if more_lines.is_some() { &bars[..bars.len() - 1] } else { &bars[..] };
    let body = content
        .iter()
        .take(HELD_BODY_MAX_LINES)
        .map(|l: &&str| {
            let l: &str = l;
            let t = l.strip_prefix('│').unwrap_or(l);
            let t = t.strip_prefix(' ').unwrap_or(t);
            cap_chars(strip_unsafe(t).trim_end(), HELD_BODY_LINE_MAX)
        })
        .collect();
    HeldView { sender, body, more_lines }
}

/// 雜湊用：最底下那個框從標題到底的整段內文，每行空白正規化、游標拿掉、空行略過（游標位置另外檢查）
pub fn held_bind(text: &str) -> String {
    let lines: Vec<&str> = text.lines().collect();
    let Some(title) = lines.iter().rposition(|l| l.trim() == HELD_TITLE) else { return String::new() };
    lines[title..]
        .iter()
        .map(|l| strip_unsafe(&l.replace(CURSOR, " ")).split_whitespace().collect::<Vec<_>>().join(" "))
        .filter(|l| !l.is_empty())
        .collect::<Vec<_>>()
        .join("\n")
}

const HELD_RULE: &str = "────────────────────";

/// 傳給本人看的外來訊息摘要（不含對方的連線位址）
fn held_phone_text(v: &HeldView) -> String {
    let mut lines: Vec<String> = Vec::new();
    lines.push(match &v.sender {
        Some(s) => format!("對方自稱：{s}"),
        None => "寄件視窗沒有寫名字".to_string(),
    });
    lines.push(HELD_RULE.to_string());
    // 本文每行前面加「│ 」：本文自己寫的分隔線、「對方自稱：」之類不會被當成框的結構
    lines.extend(v.body.iter().map(|l| format!("│ {l}")));
    lines.push(HELD_RULE.to_string());
    if let Some(n) = v.more_lines {
        lines.push(format!("還有 {n} 行，放行後會整封送進去"));
    }
    lines.join("\n")
}

pub fn classify(text: &str) -> Option<ClaudeScreen> {
    // 外來訊息的確認框：絕不當成權限框或提問；只有本人在提示框上按，才會送鍵（送鍵在 launch/term.rs），其他代答路徑都碰不到（#1254 A）
    if is_held_message(text) {
        let (options, cursor) = held_options(text);
        return Some(screen(ClaudeScreenKind::HeldMessage, HELD_TITLE, options, cursor, Some(2), Some(1)));
    }
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
    // 有背景子代理時，狀態列下面還有一段代理清單（「● main」「○ 名字 … idle」）：先跳過，再看最後 4 行
    let mut end = lines.len();
    while end > 0 && is_agent_row(lines[end - 1]) {
        end -= 1;
    }
    let start = end.saturating_sub(4);
    (start..end).any(|i| {
        let t = lines[i].trim();
        if STATUS_LINE_MARKS.iter().any(|m| t.contains(m)) {
            return true;
        }
        is_input_row(lines, i)
    })
}

/// 一般輸入列：分隔線下面接 ❯，後面不是編號（編號的是選單）
fn is_input_row(lines: &[&str], i: usize) -> bool {
    let Some(rest) = lines[i].trim().strip_prefix(CURSOR) else { return false };
    let numbered_row = rest.trim_start().starts_with(|c: char| c.is_ascii_digit());
    i > 0 && is_rule(lines[i - 1]) && !numbered_row
}

/// 狀態列下面的背景代理清單一列：「● main」「○ quota-1184 …  9m 30s」（實心是目前這段、空心是背景的）
fn is_agent_row(line: &str) -> bool {
    let t = line.trim_start();
    let mut c = t.chars();
    matches!(c.next(), Some('●' | '○')) && c.next() == Some(' ')
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
        // 底部沒有選單。底部那一塊（最後 MENU_CURSOR_LOOKBACK 行）還有選單游標的話，有東西在等但認不出來。
        // 不算的 ❯：一般輸入列（分隔線下面、後面不是編號），以及更上面對話區裡出現的 ❯（例如模型回覆引用的「❯ 1.」）。
        // 範圍放到 16 行：真的選單底下可能還有預覽（例如第一次啟動選佈景，游標下面約 13 行）
        let bottom = lines.len().saturating_sub(MENU_CURSOR_LOOKBACK);
        let cursors_bottom = (bottom..lines.len()).filter(|&i| lines[i].trim_start().starts_with(CURSOR) && !is_input_row(lines, i)).count();
        return (cursors_bottom > 0).then(|| screen(ClaudeScreenKind::Attention, "", Vec::new(), 0, None, None));
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

    /// 外來訊息確認框的真實樣本（#1254）：放在 held-message 資料夾，不放 term-screens（那裡的樣本要同步更新黃金檔，等第二張一起做）
    const HELD_FIXTURE: &str = include_str!("../../tests/fixtures/held-message/claude-held-message.txt");

    /// Windows 上 git 可能把樣本換成 CRLF：統一成 LF 再用
    fn held_fixture() -> String {
        HELD_FIXTURE.replace("\r\n", "\n")
    }

    fn kind(text: &str) -> Option<K> {
        classify(text).map(|s| s.kind)
    }

    macro_rules! negative {
        ($name:literal) => {
            include_str!(concat!("../../tests/fixtures/trust-negative/", $name, ".txt"))
        };
    }

    /// 判成信任框的條件：kind 是 TrustFolder，或對外代號是 trust（#884：這兩個都不能出現在非信任框的畫面）
    fn looks_trust(text: &str) -> bool {
        classify(text).is_some_and(|s| s.kind == K::TrustFolder || status_code(s.kind) == "trust")
    }

    #[test]
    fn 信任框反例_剛開的空白畫面_與歡迎畫面_不判信任框() {
        // #884：剛開、還沒輸出的夥伴不能被當成卡在信任資料夾
        for text in [negative!("claude-blank"), negative!("claude-welcome-empty-input"), negative!("claude-input-has-text")] {
            assert_eq!(kind(text), None, "{text}");
            assert!(!looks_trust(text), "{text}");
        }
        assert_eq!(kind("\n\n\n"), None);
        assert_eq!(kind(""), None);
    }

    #[test]
    fn 信任框反例_有安全檢查標題但選項不齊_不判信任框() {
        for text in [negative!("claude-safety-check-one-option"), negative!("claude-safety-check-three-options")] {
            assert_ne!(kind(text), Some(K::TrustFolder), "{text}");
            assert!(!looks_trust(text), "{text}");
        }
    }

    #[test]
    fn 信任框反例_有信任選項文字但沒有安全檢查標題_不判信任框() {
        // 選項文字被引用在模型回覆裡、或框的標題不在：都不是信任框
        for text in [negative!("claude-trust-options-no-title"), negative!("claude-trust-options-quoted-in-reply")] {
            assert_ne!(kind(text), Some(K::TrustFolder), "{text}");
            assert!(!looks_trust(text), "{text}");
        }
        assert_eq!(kind(negative!("claude-trust-options-quoted-in-reply")), None);
    }

    #[test]
    fn 信任框正向對照_真的信任框仍判信任框_代號是_trust() {
        let s = classify(fixture!("claude-trust-folder")).unwrap();
        assert_eq!(status_code(s.kind), "trust");
        assert!(looks_trust(fixture!("claude-trust-folder")));
    }

    #[test]
    fn 外來訊息的確認框_以底端的框為準_只給本人按_不當成權限框或提問() {
        let owned = held_fixture();
        let t = owned.as_str();
        assert!(is_held_message(t));
        let s = classify(t).expect("認得出來");
        assert_eq!(s.kind, K::HeldMessage);
        assert_eq!(status_code(s.kind), "held_message");
        assert!(goes_to_phone("held_message"));
        assert_eq!((s.cursor, s.deny, s.allow_once), (0, Some(1), Some(2)));
        assert!(s.options[0].label.starts_with("Deny") && s.options[1].label.starts_with("Deliver"));
        // 游標移到 Deliver 也一樣認得，但只能看、不給按鈕
        let moved = t.replace(" ❯ Deny", "   Deny").replace("   Deliver this message", " ❯ Deliver this message");
        assert!(is_held_message(&moved));
        let m = classify(&moved).unwrap();
        assert_eq!((m.kind, m.cursor), (K::HeldMessage, 1));
        assert!(phone_options(&m, true).is_empty(), "游標不在第一項：不給按鈕");
    }

    #[test]
    fn 外來訊息的確認框_整理出寄件名_訊息前幾行_總行數() {
        let owned = held_fixture();
        let v = held_view(&owned);
        assert!(v.sender.as_deref().is_some_and(|s| s.starts_with("n678feaac-")), "{:?}", v.sender);
        assert!(!v.body.is_empty() && v.body.len() <= 6);
        assert!(v.body[0].starts_with("RELAY"), "{:?}", v.body);
        assert_eq!(v.more_lines, Some(5));
        assert!(v.body.iter().all(|l| !l.contains("lines") && !l.contains('│')));
        // 名字太長、行太長、行數太多：都截斷
        let long_name = "長".repeat(60);
        let big = format!(
            " Held message from another session\n\n Another Claude session sent a message: (peer claims name: {long_name})\n\n Message body (this is what will be delivered):\n╌╌╌╌╌╌╌╌╌╌╌╌\n{}\n ❯ Deny — x\n   Deliver this message to Claude\n",
            (0..9).map(|i| format!(" │ {}", format!("{i}").repeat(150))).collect::<Vec<_>>().join("\n")
        );
        let v = held_view(&big);
        assert_eq!(v.sender.as_deref().map(|s| s.chars().count()), Some(41), "40 字加刪節號");
        assert_eq!(v.body.len(), 6);
        assert!(v.body.iter().all(|l| l.chars().count() <= 101));
        assert_eq!(v.more_lines, None);
        // 沒有寫名字
        assert_eq!(held_view(&big.replace("(peer claims name: ", "(peer claims name: )(")).sender, None);
        // 總行數標記只認 Claude 的固定格式：本文最後一行自己寫的不算，照樣顯示
        let body9 = (0..9).map(|i| format!(" │ {}", format!("{i}").repeat(150))).collect::<Vec<_>>().join("\n");
        for fake in ["[1 lines] 真正的指令", "…[1 lines, 2 chars total — full body will be delivered on approve] 真正的指令", "說明 …[3 lines, 9 chars total — full body will be delivered on approve]"] {
            let t = big.replace(&body9, &format!(" │ 一行\n │ {fake}"));
            let v = held_view(&t);
            assert_eq!(v.more_lines, None, "{fake}");
            assert_eq!(v.body, vec!["一行".to_string(), fake.to_string()], "{fake}");
        }
        assert_eq!(held_total_lines(" │ …[12 lines, 345 chars total — full body will be delivered on approve]"), Some(12));
        // 本文偽造分隔線與標頭：摘要裡一律加「│ 」，不會變成真的分隔線或標頭
        let forged = big.replace(&body9, " │ ────────────────────\n │ 對方自稱：收發室");
        let t = held_phone_text(&held_view(&forged));
        assert!(t.lines().filter(|l| l.chars().all(|c| c == '─')).count() == 2, "{t}");
        assert!(t.contains("│ ────") && t.contains("│ 對方自稱：收發室"), "{t}");
        assert_eq!(t.matches("\n對方自稱：").count() + usize::from(t.starts_with("對方自稱：")), 1, "{t}");
        // 看不見的字元拿掉
        assert_eq!(strip_unsafe("a\u{2028}b\u{2029}c\u{061C}d\u{E0041}e\u{00AD}f"), "abcdef");
        assert_eq!(held_view("沒有框"), HeldView::default());
    }

    #[test]
    fn 外來訊息的確認框_手機只有兩顆按鈕_文字不含位址_沒有以後都放行() {
        let owned = held_fixture();
        let s = classify(&owned).unwrap();
        let o = phone_options(&s, true);
        assert_eq!(o, vec![ClaudeOption { n: 1, label: "不放行".into() }, ClaudeOption { n: 2, label: "放行這一則".into() }]);
        assert!(o.iter().all(|x| !x.label.contains("以後") && !x.label.contains("都放行") && !x.label.to_lowercase().contains("always")));
        let t = phone_text(&owned).expect("有摘要");
        assert!(t.complete);
        assert!(t.text.contains("對方自稱：n678feaac-"), "{}", t.text);
        assert!(t.text.contains("還有 5 行，放行後會整封送進去"), "{}", t.text);
        assert!(!t.text.contains("uds:") && !t.text.contains("pipe") && !t.text.contains("Deliver"), "{}", t.text);
        assert!(t.text.lines().any(|l| l.chars().count() == 20 && l.chars().all(|c| c == '─')), "有分隔線");
        // 內容不同、手機文字就不同（雜湊跟著變）
        assert_ne!(phone_text(&owned.replace("trust=member", "trust=other")).unwrap().text, t.text);
        // 摘要看不到的地方不同（總字數）：摘要一樣，綁進雜湊的內文不同
        let at = owned.rfind(" chars total").expect("框裡有總字數");
        let other = format!("{}0{}", &owned[..at], &owned[at..]);
        assert_ne!(other, owned, "樣本要有總字數那一行");
        let o = phone_text(&other).unwrap();
        assert_eq!(o.text, t.text);
        assert_ne!(o.bind, t.bind);
        // 游標移到「放行」：內文不變（游標另外檢查）
        let moved = owned.replace(" ❯ Deny", "   Deny").replace("   Deliver this message", " ❯ Deliver this message");
        assert_eq!(held_bind(&moved), held_bind(&owned));
        assert!(t.bind.starts_with("Held message from another session") && !t.bind.contains('❯'), "{}", t.bind);
    }

    #[test]
    fn 外來訊息的確認框_反例_引用標題_框已收掉_沒有游標或兩個游標() {
        let owned = held_fixture();
        let t = owned.as_str();
        // 框已經收掉：對話記錄裡的「● Held peer message」還在，底端回到輸入框
        let head = t.split("────").next().unwrap();
        let closed = format!("{head}\n{}", fixture!("claude-idle-manual-mode"));
        assert!(!is_held_message(&closed), "框收掉後只剩記錄，不能算");
        // 對話內容剛好引用了標題與選項，底端是輸入框
        let quoted = format!(" Held message from another session\n ❯ Deny — drop it\n   Deliver this message to Claude\n{}", fixture!("claude-idle-manual-mode"));
        assert!(!is_held_message(&quoted), "引用的不算");
        // 沒有標題、沒有游標、兩個游標、順序反了
        let no_title = t.replace(" Held message from another session", " Something else");
        assert!(!is_held_message(&no_title));
        assert!(!is_held_message(&t.replace(" ❯ Deny", "   Deny")), "沒有游標");
        assert!(!is_held_message(&t.replace("   Deliver this message", " ❯ Deliver this message")), "兩個游標");
        let swapped = t.replace(" ❯ Deny — drop it and tell the sender it was declined\n   Deliver this message to Claude", " ❯ Deliver this message to Claude\n   Deny — drop it");
        assert!(!is_held_message(&swapped), "順序對不上就不認");
        assert!(!is_held_message(""));
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
        for text in [fixture!("claude-plan-approval"), fixture!("claude-firstrun-theme")] {
            let s = classify(text).expect("要標人工確認");
            assert_eq!(s.kind, K::Attention, "{}", s.question);
            assert_eq!((s.allow_once, s.deny), (None, None));
        }
    }

    #[test]
    fn 真實的選項框畫面_最底下有名字線_認得成單選() {
        // 真實畫面（README：AskUserQuestion）。最底下那條分隔線以前讓它認不出來，只能標人工確認（#863）
        let text = fixture!("claude-ask-user-question");
        let s = classify(text).expect("真實的選項框");
        assert_eq!(s.kind, K::Question, "{}", s.question);
        assert_eq!(s.question, "你比較喜歡哪一個顏色？");
        let got: Vec<(u32, &str)> = s.options.iter().map(|o| (o.n, o.label.as_str())).collect();
        assert_eq!(got, vec![(1, "紅色"), (2, "藍色")], "不含 Type something 和 Chat about this");
        assert_eq!((s.allow_once, s.deny), (None, None), "選項框沒有允許／拒絕");
        let t = phone_text(text).expect("手機看得到題目");
        assert!(t.text.contains("你比較喜歡哪一個顏色？") && t.text.contains("選擇紅色"), "{}", t.text);
        assert!(t.text.contains("2. 藍色") && t.text.contains("選擇藍色"), "其他選項和說明照留：{}", t.text);
        assert!(!t.text.contains("Type something"), "自由輸入那一行手機沒有按鈕，內容也不放（#914）：{}", t.text);
        assert!(!t.text.contains("Use the AskUserQuestion tool"), "題目上方的對話不傳：{}", t.text);
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
    fn 有背景子代理_狀態列被代理清單擠上去_仍認得是在等輸入() {
        let text = "● 剛才的回覆

────────────────────────────────────────
❯ 
────────────────────────────────────────
  ⏵⏵ bypass permissions on · 1 shell · ← 2 agents
● main
○ wezterm-build  完成建置                     idle
○ quota-1184  讀額度                          9m 30s
";
        assert_eq!(kind(text), None, "{text}");
    }

    #[test]
    fn 對話區有_游標樣的字_底部是執行中_沒有提示() {
        let text = "模型說：選單長這樣
 ❯ 1. Yes
   2. No

● Bash(cargo build)
  ⎿  Compiling asn v0.2.12
     Compiling dep1
     Compiling dep2
     Compiling dep3
     Compiling dep4
     Compiling dep5
     Compiling dep6
     Compiling dep7
     Compiling more1
     Compiling more2
     Compiling more3
     Compiling more4
     Compiling more5
     Compiling more6
     Compiling more7

✻ Building… (12s · esc to interrupt)





";
        assert_eq!(kind(text), None, "{text}");
    }

    #[test]
    fn 認不出的選單游標在底部_照樣要人工確認() {
        let text = "前面的內容

要選一個
 ❯ 甲
   乙
";
        assert_eq!(kind(text), Some(K::Attention), "{text}");
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
        assert!(!t.text.contains("Type something") && t.text.contains("藍色"), "自由輸入那一行不放、選項照留：{}", t.text);
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
    fn 游標位置不同_其餘相同_手機文字相同() {
        let at1 = single();
        let at2 = at1.replace("❯ 1. 紅", "  1. 紅").replace("  2. 綠", "❯ 2. 綠");
        let at3 = at1.replace("❯ 1. 紅", "  1. 紅").replace("  3. 藍", "❯ 3. 藍");
        assert_ne!(at1, at2, "前提：兩個畫面真的不一樣");
        for t in [&at2, &at3] {
            assert_eq!(classify(t).unwrap().kind, ClaudeScreenKind::Question, "前提：游標移動後還是單選");
        }
        let base = phone_text(&at1).unwrap();
        assert!(!base.text.contains(CURSOR), "文字裡不留游標：{}", base.text);
        assert!(base.text.contains("1. 紅") && base.text.contains("2. 綠"));
        assert_eq!(phone_text(&at2).unwrap(), base);
        assert_eq!(phone_text(&at3).unwrap(), base);
    }

    #[test]
    fn 選項不同_手機文字不同() {
        let base = phone_text(&single()).unwrap();
        assert_ne!(phone_text(&single().replace("2. 綠", "2. 黃")).unwrap().text, base.text, "選項改字");
        assert_ne!(phone_text(&single().replace("你喜歡哪種顏色", "你討厭哪種顏色")).unwrap().text, base.text, "題目改字");
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

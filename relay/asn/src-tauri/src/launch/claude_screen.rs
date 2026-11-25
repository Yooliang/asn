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
    /// 額度用完後 Claude 問「What do you want to do?」的選單（#1512）。手機只給「停下來等」「在這裡等、恢復後自動繼續」兩項；
    /// 付費類（改用額度點數、加值、升級方案）一律不給手機
    UsageMenu,
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
/// 選項區底下「↑／↓ N more lines」最多認幾行（#2256）
const MAX_MORE_MARKS: usize = 2;
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
/// 登入失效那一行（#1512 C 收緊）：Claude Code 把錯誤掛在 ⎿ 底下，原樣是「<固定開頭> · Please run /login」。
/// 開頭只認這幾種（字串取自 claude.exe 內嵌文字）；● 開頭的是模型自己的回覆，一律不算
const LOGIN_ERROR_HEADS: [&str; 3] = ["Login expired", "OAuth token revoked", "API Error"];
const LOGIN_ERROR_TAIL: &str = " · Please run /login";

fn is_login_error(body: &str) -> bool {
    body.ends_with(LOGIN_ERROR_TAIL) && LOGIN_ERROR_HEADS.iter().any(|h| body.starts_with(h))
}
/// 登入逾時（#1792）：「Login reached its time limit · Please run /login」「Failed to authenticate: this login reached its time limit · Sign in again to continue」
/// 「Failed to authenticate: this login reached its time limit and cannot be renewed. Run `claude auth login` to sign in a…」（被截斷）。不認行位置，認開頭：
/// 去掉行首空白與 ⎿（真的登入錯誤掛在 ⎿ 底下）後，一開頭就是這兩句之一才算。句子中間才出現的都不算：
/// ● 開頭的模型回覆、⎿ 底下的工具輸出（grep 結果、文件）、使用者訊息的回顯（收發室轉進來的信內文）。
/// 「Could not refresh your login because another Claude Code process…」是暫時的，不是這兩句開頭，不算登入
const LOGIN_TIME_LIMIT_HEADS: [&str; 2] = ["login reached its time limit", "failed to authenticate: this login reached its time limit"];

fn is_login_time_limit(line: &str) -> bool {
    let t = line.trim_start();
    if t.starts_with('●') {
        return false;
    }
    let lower = t.to_ascii_lowercase();
    let rest = lower.strip_prefix('⎿').unwrap_or(lower.as_str()).trim_start();
    LOGIN_TIME_LIMIT_HEADS.iter().any(|h| rest.starts_with(h))
}
/// 額度用完那一句（#2335）：「You've hit your <名稱> limit」，後面接「 · resets <時間>」之類。名稱最多兩個詞，也可以沒有
const USAGE_LIMIT: &str = "You've hit your ";
const USAGE_NAME_MAX_CHARS: usize = 24;
const USAGE_NAME_MAX_WORDS: usize = 2;
/// claude 2.1.331 執行檔內嵌的額度名稱（空字串＝「You've hit your limit」）。名單外的名稱要後面真的帶「· resets」才算
const USAGE_KNOWN_NAMES: [&str; 9] = ["", "5-hour", "weekly", "session", "Opus", "Sonnet", "Fable", "usage credit", "monthly spend"];
/// 快速模式的冷卻提示（會自己退回一般速度），不是帳號額度用完
const USAGE_IGNORED_NAME: &str = "fast";
/// 額度提示在輸入框上方往回看幾行：提示後面可能接著子代理的結束通知（#2335）
const USAGE_LOOKBACK: usize = 30;
/// 提示之後出現這些開頭的 ● 行不代表對話又往下走了：背景子代理、背景指令的結束通知
const BACKGROUND_STATUS_HEADS: [&str; 2] = ["Agent \"", "Background command \""];
/// 工具被收起來時的摘要行（「Read 1 file」「Ran 1 shell command」）：開頭字後面接數字
const COLLAPSED_TOOL_HEADS: [&str; 5] = ["Read ", "Ran ", "Searched for ", "Listed ", "Called "];
/// 額度用完的選單（#1512，claude 2.1.325）：標題、頁尾和兩個不花錢的選項都是 Claude 固定的字。
/// 選項的順序因帳號而異（付費類可能排第一），所以認字、不認編號
const USAGE_MENU_TITLE: &str = "What do you want to do?";
const USAGE_MENU_FOOTER: &str = "Enter to confirm";
const USAGE_STOP: &str = "Stop and wait for limit to reset";
const USAGE_WAIT: &str = "Wait here, then continue automatically";
/// 畫面底部往回看幾行找登入失效；認不出輸入框時，找額度訊息也只看這麼多
const NOTICE_LOOKBACK: usize = 8;
/// 底部認不出的選單游標往上看幾行（真的選單底下可能還有預覽）
const MENU_CURSOR_LOOKBACK: usize = 16;

/// 這個種類對應的固定代號（寫進狀態檔的只有它，不含畫面文字）。
/// 代號、名單說明、提醒文字全部在 `screen_catalog::SCREEN_CATALOG`，這裡不再自己列一份（#1813）
pub fn status_code(kind: ClaudeScreenKind) -> &'static str {
    super::screen_catalog::code_of(kind)
}

/// 權限詢問顯示給本人看的文字最多幾行：再長就不算完整
const PROMPT_TEXT_MAX_LINES: usize = 40;

/// 權限詢問的完整文字（指令、路徑、選項）。只給本機畫面確認用
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PromptText {
    pub text: String,
    /// 看得到提示的開頭，而且沒有超過行數上限。不完整就不能按「允許」
    pub complete: bool,
    /// 只有行數超過上限（看得到開頭、也沒被收起來）：電腦版的框可以捲動看完，所以另外標出來；手機仍照 `complete` 判斷
    pub only_too_long: bool,
    /// 不顯示、只綁進雜湊的內容：外來訊息框是整個框的內文（顯示的只是摘要，兩則摘要相同也要分得出來）；其他是空字串
    pub bind: String,
}

/// 畫面文字是外部內容：去掉控制字元與會改變顯示順序、藏字的字元，只留換行
fn clean_prompt_line(line: &str) -> String {
    strip_unsafe(line).trim_end().to_string()
}

/// 去掉控制字元與會改變顯示順序、藏字的字元（不處理空白）：零寬字元、方向控制、行／段分隔、軟連字號、標籤字元等
pub(crate) fn strip_unsafe(s: &str) -> String {
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
    // Claude Code 自己把長內容收起來（「… +12 lines」「(ctrl+o to expand)」這類）：畫面上本來就不完整（#1445 asn真 審查必修 2）
    let elided = kept.iter().any(|l| is_elision_line(l));
    let complete = top.is_some() && kept.len() <= PROMPT_TEXT_MAX_LINES && !elided;
    let only_too_long = top.is_some() && !elided && kept.len() > PROMPT_TEXT_MAX_LINES;
    Some(PromptText { text: kept.join("\n"), complete, only_too_long, bind: String::new() })
}

/// Claude Code 收起長內容時留的記號：「… +N lines」「... +N lines」，或「ctrl+o to expand」這類展開提示。
/// 認不準就當收起來（只會讓手機多一層小心，不會少）
fn is_elision_line(line: &str) -> bool {
    let t = line.trim();
    let after = t.strip_prefix('…').or_else(|| t.strip_prefix("...")).map(str::trim_start);
    let plus_lines = after.is_some_and(|a| {
        let a = a.strip_prefix('+').unwrap_or("");
        let digits = a.chars().take_while(char::is_ascii_digit).count();
        digits > 0 && a[digits..].trim_start().starts_with("line")
    });
    let lc = t.to_ascii_lowercase();
    plus_lines || is_more_lines_marker(t) || lc.contains("to expand)") || lc.contains("ctrl+o to expand") || lc.contains("ctrl+r to expand")
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
/// 額度用完選單的兩顆按鈕字與手機上顯示的固定文字（#1512）：不送畫面原文（重置時間、付費選項都不送）
pub const PHONE_USAGE_STOP: &str = "停下來，等額度恢復";
pub const PHONE_USAGE_WAIT: &str = "在這裡等，額度恢復後自動繼續";
pub const PHONE_USAGE_TEXT: &str = "額度用完了，Claude 在問接下來要怎麼做。\n付費相關的選項（改用額度點數、加值、升級方案）只能在電腦上選。";

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
        // 認字給按鈕，編號照畫面上的；其他選項（付費類、「不要自動繼續」等）一律不給
        ClaudeScreenKind::UsageMenu => screen
            .options
            .iter()
            .filter_map(|o| usage_phone_label(&o.label).map(|label| ClaudeOption { n: o.n, label: label.to_string() }))
            .collect(),
        _ => Vec::new(),
    }
}

/// 額度選單裡手機可以按的選項 → 按鈕字；其他回 None
fn usage_phone_label(label: &str) -> Option<&'static str> {
    if label == USAGE_STOP {
        Some(PHONE_USAGE_STOP)
    } else if label.starts_with(USAGE_WAIT) {
        Some(PHONE_USAGE_WAIT)
    } else {
        None
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

/// 權限框的完整原始選項（#1445：擁有者要求照原本的選項顯示）。只有權限框有，其他框回空的（手機照舊用 `phone_options`）。
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
        || code == status_code(ClaudeScreenKind::UsageMenu)
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
        ClaudeScreenKind::HeldMessage => Some(PromptText { text: held_phone_text(&held_view(screen)), complete: true, only_too_long: false, bind: held_bind(screen) }),
        // 額度選單：手機只看固定文字；選單本身（游標不算）綁進雜湊，選項或重置時間變了就答不出去
        ClaudeScreenKind::UsageMenu => Some(PromptText { text: PHONE_USAGE_TEXT.to_string(), complete: true, only_too_long: false, bind: usage_menu_bind(screen)? }),
        ClaudeScreenKind::Question | ClaudeScreenKind::QuestionView => {
            let lines: Vec<&str> = screen.lines().map(str::trim_end).collect();
            let end = lines.iter().rposition(|l| !l.trim().is_empty())? + 1;
            let q = question_box(&lines[..end])?;
            // 自由輸入那一行（「N. Type something.」）手機沒有按鈕，內容也不放（#914）
            let kept: Vec<String> = lines[q.top + 1..q.bottom].iter().filter(|l| !is_free_input_row(l)).map(|l| hide_cursor(&clean_prompt_line(l))).collect();
            let complete = kept.len() <= PROMPT_TEXT_MAX_LINES;
            Some(PromptText { text: kept.join("\n").trim().to_string(), complete, only_too_long: false, bind: String::new() })
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
    menu_at_bottom(lines).or_else(|| {
        // 整頁被登入流程蓋住、沒有輸入框：只看最後幾行
        let start = lines.len().saturating_sub(4);
        lines[start..].iter().any(|l| is_login_time_limit(l)).then(|| screen(ClaudeScreenKind::Login, "", Vec::new(), 0, None, None))
    })
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

/// 輸入框還在，上方有 Claude 的錯誤訊息：只標狀態，不給按鈕。兩種都有時，靠下面（較新）的算數
fn notice_above_input(lines: &[&str]) -> Option<ClaudeScreen> {
    let start = lines.len().saturating_sub(NOTICE_LOOKBACK);
    let login = (start..lines.len()).rev().find(|&i| is_login_notice(lines[i]));
    let usage = usage_notice_row(lines);
    let kind = match (login, usage) {
        (None, None) => return None,
        _ if login > usage => ClaudeScreenKind::Login,
        _ => ClaudeScreenKind::UsageLimit,
    };
    Some(screen(kind, "", Vec::new(), 0, None, None))
}

fn is_login_notice(line: &str) -> bool {
    let t = line.trim_start();
    is_login_time_limit(t) || (t.starts_with('⎿') && is_login_error(t.trim_start_matches(['●', '⎿', ' '])))
}

/// 還有效的額度提示在第幾行。這個判斷會讓人換帳號，所以寧可漏報：
/// 要是 Claude 掛出來的錯誤行（不是對話或工具輸出裡引用的同一句話），而且之後對話沒有再往下走
fn usage_notice_row(lines: &[&str]) -> Option<usize> {
    // 輸入框：最底下那個「分隔線接 ❯」。框裡和框下面（狀態列、代理清單）的字都不看
    let input = (1..lines.len()).rev().find(|&i| lines[i].trim_start().starts_with(CURSOR) && is_rule(lines[i - 1]));
    let (end, lookback) = input.map_or((lines.len(), NOTICE_LOOKBACK), |i| (i - 1, USAGE_LOOKBACK));
    let above = &lines[..end];
    (end.saturating_sub(lookback)..end).rev().find(|&i| is_usage_error_row(above, i) && !conversation_moved_on(&above[i + 1..]))
}

fn indent_of(line: &str) -> usize {
    line.chars().take_while(|c| c.is_whitespace()).count()
}

/// 「You've hit your <名稱> limit」開頭的訊息才回名稱。limit 後面只能沒有字，或接「·」
fn usage_limit_name(body: &str) -> Option<&str> {
    let rest = body.strip_prefix(USAGE_LIMIT)?;
    let (name, tail) = match rest.strip_prefix("limit") {
        Some(tail) => ("", tail),
        None => rest.split_once(" limit")?,
    };
    let tail = tail.trim_start();
    let detail = tail.strip_prefix('·').map(str::trim_start);
    let plain = name.len() <= USAGE_NAME_MAX_CHARS
        && name.split_whitespace().count() <= USAGE_NAME_MAX_WORDS
        && name.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, ' ' | '.' | '-'));
    let known = USAGE_KNOWN_NAMES.contains(&name) && (tail.is_empty() || detail.is_some());
    let has_reset = detail.is_some_and(|d| d.starts_with("resets "));
    (plain && name != USAGE_IGNORED_NAME && (known || has_reset)).then_some(name)
}

/// 這一行是不是 Claude 自己掛出來的額度錯誤：
/// - `⎿` 開頭、縮排不超過 2（引用在回覆、工具輸出裡的同一行縮排更深），而且不是某則 ● 訊息自己的內容，後面也沒有接著回覆內文
/// - `●` 開頭的只認舊的「You've hit your limit」：新字樣沒有看過掛在 ● 上，● 開頭的多半是模型在引用
fn is_usage_error_row(lines: &[&str], i: usize) -> bool {
    let line = lines[i];
    let t = line.trim_start();
    if let Some(rest) = t.strip_prefix('⎿') {
        return indent_of(line) <= 2 && usage_limit_name(rest.trim_start()).is_some() && !belongs_to_reply(lines, i) && !followed_by_reply_text(&lines[i + 1..]);
    }
    indent_of(line) == 0 && t.strip_prefix('●').and_then(|r| usage_limit_name(r.trim_start())) == Some("")
}

fn is_background_status(line: &str) -> bool {
    let body = line.trim_start_matches(['●', '⏺', ' ']);
    BACKGROUND_STATUS_HEADS.iter().any(|h| body.starts_with(h))
}

fn is_collapsed_tool_summary(line: &str) -> bool {
    COLLAPSED_TOOL_HEADS.iter().any(|h| line.strip_prefix(h).is_some_and(|r| r.starts_with(|c: char| c.is_ascii_digit())))
}

/// 第 i 行的 `⎿` 是不是某則 ● 訊息自己的內容（工具的第一行輸出、模型回覆裡引用的字）。
/// 往上找到訊息開頭（沒有縮排的行）：是 ● 而且中間沒有別的 `⎿` 或工具摘要，就算它的內容
fn belongs_to_reply(lines: &[&str], i: usize) -> bool {
    let mut nearest = None;
    for line in lines[..i].iter().rev().filter(|l| !l.trim().is_empty()) {
        let t = line.trim_start();
        if indent_of(line) == 0 {
            return t.starts_with(['●', '⏺']) && !is_background_status(t);
        }
        if t.starts_with('⎿') || is_collapsed_tool_summary(t) {
            return false;
        }
        nearest.get_or_insert(*line);
    }
    // 訊息開頭捲出畫面：緊鄰的上一行像回覆內文（縮排不超過 4），當成回覆裡引用的
    nearest.is_some_and(|l| indent_of(l) <= 4)
}

/// 錯誤訊息的續行縮排在 5 以上。接下來第一個縮排較淺的行如果是一般內文，代表那句話只是某段回覆中間的引用
fn followed_by_reply_text(after: &[&str]) -> bool {
    let next = after.iter().find(|l| !l.trim().is_empty() && indent_of(l) < 5);
    next.is_some_and(|l| indent_of(l) > 0 && !l.trim_start().starts_with(['⎿', '✻', '✢', '✳', '✶', '✽', '○']))
}

/// 提示之後對話有沒有再往下走（額度恢復了，或換帳號後繼續做事）：
/// 新的 ● 回覆或工具呼叫、本人送出新的提問、登入成功。斜線指令（/usage-credits 之類）不算
fn conversation_moved_on(after: &[&str]) -> bool {
    after.iter().any(|line| {
        let t = line.trim_start();
        if t.strip_prefix('⎿').is_some_and(|r| r.trim_start().starts_with("Login successful")) {
            return true;
        }
        if indent_of(line) != 0 {
            return false;
        }
        if t.starts_with(['●', '⏺']) {
            return !is_background_status(t);
        }
        t.strip_prefix([CURSOR, '>']).map(str::trim).is_some_and(|q| !q.is_empty() && !q.starts_with('/'))
    })
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

/// 額度選單綁進雜湊的內容：選單所在區塊（標題上面那條分隔線以下到畫面底），每行去掉開頭的空白和游標（游標在哪一列不算內容）。只綁不顯示
fn usage_menu_bind(text: &str) -> Option<String> {
    let lines: Vec<&str> = text.lines().map(str::trim_end).collect();
    let end = lines.iter().rposition(|l| !l.trim().is_empty())? + 1;
    let start = lines[..end].iter().rposition(|l| l.trim() == USAGE_MENU_TITLE)?;
    let top = lines[..start].iter().rposition(|l| is_rule(l)).map_or(start, |i| i + 1);
    Some(lines[top..end].iter().map(|l| clean_prompt_line(l).trim_start().trim_start_matches(CURSOR).trim_start().to_string()).collect::<Vec<_>>().join("\n"))
}

/// Claude Code 在選項下方標「還有幾行沒顯示」：`↑ 10 more lines`、`↓ 1 more line`（#2256）。不是選項，也不是對話內容
fn is_more_lines_marker(line: &str) -> bool {
    let Some(rest) = line.trim().strip_prefix(['↑', '↓']) else { return false };
    let rest = rest.trim_start();
    let digits = rest.chars().take_while(char::is_ascii_digit).count();
    digits > 0 && matches!(rest[digits..].trim(), "more line" | "more lines")
}

/// 頁尾太長在窄視窗折成好幾行：第一行是 `Esc to cancel` 這類開頭，後面緊接的延續行也算頁尾（#2256）。
/// 只認「緊接在頁尾行下面一行」，而且那行要像頁尾的後半段（含 `·`、`ctrl` 或頁尾常見字）：
/// 判成權限框後手機可以遠端回答、答案會當按鍵送進終端，所以這裡寧可認不出來，也不要把一般文字當頁尾（#2256 二審）
fn is_footer_continuation(lines: &[&str], idx: usize) -> bool {
    const TAIL_WORDS: [&str; 8] = ["·", "ctrl", "Tab to", "to cancel", "to amend", "to stop", "twice", "agents"];
    let t = lines[idx].trim();
    if idx == 0 || t.starts_with(CURSOR) || numbered(t).is_some() || !TAIL_WORDS.iter().any(|w| t.contains(w)) {
        return false;
    }
    let above = lines[idx - 1].trim();
    FOOTER_PREFIXES.iter().any(|f| above.starts_with(f))
}

fn menu_at_bottom(lines: &[&str]) -> Option<ClaudeScreen> {
    // 用來判斷的是最底下的區塊：往上跳過頁尾與分隔線，碰到別的內容就算不是選單
    let mut last = lines.len();
    let mut footers = 0;
    let mut confirm_footer = false;
    let mut more_marks = 0;
    while last > 0 {
        let t = lines[last - 1].trim();
        if is_more_lines_marker(t) {
            // 上下各一個就夠了；連著好幾個不是權限框會有的樣子（#2256 二審）
            more_marks += 1;
            if more_marks > MAX_MORE_MARKS {
                return None;
            }
            last -= 1;
        } else if t.is_empty() || is_rule(t) {
            last -= 1;
        } else if FOOTER_PREFIXES.iter().any(|f| t.starts_with(f)) {
            footers += 1;
            confirm_footer |= t.starts_with(USAGE_MENU_FOOTER);
            last -= 1;
        } else if is_footer_continuation(lines, last - 1) {
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
        // 底部沒有認得的選單。底部那一塊（最後 MENU_CURSOR_LOOKBACK 行）有「選單形狀」的游標列，才算有東西在等但認不出來（#1799）。
        // 只看到 ❯ 開頭不夠：視窗被捲動、重繪中或對話記錄模式時看不到輸入框，對話區裡使用者提問的回顯（`❯ 提問`）也會落在這一塊。
        // 範圍放到 16 行：真的選單底下可能還有預覽（例如第一次啟動選佈景，游標下面約 13 行）
        let bottom = lines.len().saturating_sub(MENU_CURSOR_LOOKBACK);
        let shaped = (bottom..lines.len()).any(|i| lines[i].trim_start().starts_with(CURSOR) && !is_input_row(lines, i) && menu_shaped_cursor(lines, i, footers > 0));
        return shaped.then(|| screen(ClaudeScreenKind::Attention, "", Vec::new(), 0, None, None));
    };
    // 同一個區塊裡只能有一個游標：區塊從上一條分隔線算起
    let block_start = lines[..menu.above].iter().rposition(|l| is_rule(l)).map_or(0, |i| i + 1);
    let cursors_in_block = lines[block_start..last].iter().filter(|l| l.trim_start().starts_with(CURSOR)).count();
    let kind_ok = cursors_in_block == 1;
    let context = lines[block_start..menu.above].join("\n");
    Some(judge(menu, kind_ok, &context, confirm_footer))
}

/// 這一列游標像不像選單的游標（#1799，只給「認不出的選單」的後備判斷用）。三條都要成立：
/// 1. 緊鄰（上一列或下一列、中間沒有空行）有選項列：選項列的縮排比游標列深（文字對齊在 ❯ 之後）
/// 2. 游標列之後到畫面底沒有對話標記（● ✻ ⎿ ⏺）：使用者提問的回顯後面一定接 Claude 的回覆，選單後面不會
/// 3. 有操作提示頁尾，或游標列帶編號（`❯ 1. …`），或上下連著至少兩個選項列（選佈景那種沒有頁尾、沒有編號的清單）
fn menu_shaped_cursor(lines: &[&str], i: usize, has_footer: bool) -> bool {
    let indent = |l: &str| l.chars().take_while(|c| *c == ' ').count();
    let is_dialogue = |l: &str| l.trim_start().starts_with(['●', '✻', '⎿', '⏺']);
    let option_like = |l: &str| !l.trim().is_empty() && !is_rule(l) && !is_dialogue(l) && indent(l) > indent(lines[i]);
    let above = lines[..i].iter().rev().take_while(|l| option_like(l)).count();
    let below = lines[i + 1..].iter().take_while(|l| option_like(l)).count();
    let no_dialogue_after = !lines[i + 1..].iter().any(|l| is_dialogue(l));
    let body = lines[i].trim_start()[CURSOR.len_utf8()..].trim_start();
    above + below >= 1 && no_dialogue_after && (has_footer || numbered(body).is_some() || above + below >= 2)
}

fn judge(m: Menu, single_cursor: bool, context: &str, confirm_footer: bool) -> ClaudeScreen {
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
    // 額度用完的選單（#1512）：標題完全相同、頁尾是「Enter to confirm」、有編號，「停下來等」「在這裡等」各恰好一項
    let count = |f: &dyn Fn(&str) -> bool| m.options.iter().filter(|o| f(&o.label)).count();
    if m.numbered && confirm_footer && m.question == USAGE_MENU_TITLE && count(&|l| l == USAGE_STOP) == 1 && count(&|l| l.starts_with(USAGE_WAIT)) == 1 {
        return screen(ClaudeScreenKind::UsageMenu, &m.question, m.options, m.cursor, None, None);
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

    #[test]
    fn 真實的長指令權限框_框比畫面高_算不完整_選項種類照固定字判斷() {
        // #1445 實測（asn真 要求）：claude 2.1.323 的權限框把長指令整段列出，沒有收起記號；框比畫面高，頂端實線不在畫面裡
        let text = include_str!("../../tests/fixtures/term-screens/claude-permission-long-bash.txt").replace("\r\n", "\n");
        let s = classify(&text).expect("認得出權限框");
        assert_eq!(s.kind, K::Permission);
        let p = permission_text(&text).unwrap();
        assert!(!p.complete, "看不到框的頂端：不完整");
        assert!(!p.text.lines().any(is_elision_line), "這個版本的框裡沒有收起記號");
        let kinds: Vec<&str> = phone_options_full(&s).iter().map(|o| option_kind_code(o.kind)).collect();
        assert_eq!(kinds, vec!["allow_once", "allow_always", "allow_always", "deny"], "「don’t ask again」「switch to auto mode」都算不再詢問");
        // 舊手機只給拒絕（不完整）
        let old: Vec<u32> = phone_options(&s, p.complete).iter().map(|o| o.n).collect();
        assert_eq!(old, vec![4]);
    }

    fn limit_menu(name: &str) -> String {
        let dir = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/term-screens/");
        std::fs::read_to_string(format!("{dir}{name}")).unwrap().replace("\r\n", "\n")
    }

    fn phone_pairs(s: &ClaudeScreen) -> Vec<(u32, String)> {
        phone_options(s, true).into_iter().map(|o| (o.n, o.label)).collect()
    }

    #[test]
    fn 額度選單_真實畫面_認得出來_手機只給停下來等與在這裡等_文字是固定的() {
        // #1512：依 11-14 截圖逐字轉錄（claude 2.1.32x，工作機）
        let text = limit_menu("claude-limit-menu.real.txt");
        let s = classify(&text).expect("認得出選單");
        assert_eq!(s.kind, K::UsageMenu);
        assert_eq!(status_code(s.kind), "usage_menu");
        assert!(goes_to_phone("usage_menu") && !goes_to_phone("usage_limit"), "只標狀態的額度訊息照舊不上手機");
        assert_eq!(s.options.len(), 3);
        assert_eq!(phone_pairs(&s), vec![(1, PHONE_USAGE_STOP.to_string()), (2, PHONE_USAGE_WAIT.to_string())], "付費的第 3 項不給");
        assert!(phone_options_full(&s).is_empty());
        let p = phone_text(&text).unwrap();
        assert_eq!(p.text, PHONE_USAGE_TEXT, "手機只看固定文字，不送畫面原文");
        assert!(p.complete);
        // 選單本身綁進雜湊（不顯示）：重置時間、付費選項都在，游標不算，上方的對話不算
        assert!(p.bind.contains("at Nov 16, 12am") && p.bind.contains("Switch to usage credits"), "{}", p.bind);
        assert!(!p.bind.contains('❯') && !p.bind.contains("weekly limit"), "{}", p.bind);
        let moved = text.replace("❯ 1. Stop", "  1. Stop").replace("    2. Wait", "  ❯ 2. Wait");
        assert_eq!(classify(&moved).unwrap().cursor, 1);
        assert_eq!(phone_text(&moved).unwrap().bind, p.bind, "游標移動不改雜湊");
    }

    #[test]
    fn 額度選單_付費選項排在前面_認字不認編號_用畫面上的編號() {
        let s = classify(&limit_menu("claude-limit-menu-paid-first.synthetic.txt")).unwrap();
        assert_eq!(s.kind, K::UsageMenu);
        assert_eq!(phone_pairs(&s), vec![(3, PHONE_USAGE_STOP.to_string()), (4, PHONE_USAGE_WAIT.to_string())]);
    }

    #[test]
    fn 額度選單_對不上的一律不給按鈕() {
        // 已經設好自動繼續：沒有「Wait here」，只剩停下來和付費 → 需要人工確認
        let armed = classify(&limit_menu("claude-limit-menu-auto-armed.synthetic.txt")).unwrap();
        assert_eq!(armed.kind, K::Attention);
        assert!(phone_options(&armed, true).is_empty());
        let real = limit_menu("claude-limit-menu.real.txt");
        let not_menu = |t: String, why: &str| {
            let k = classify(&t).map(|s| s.kind);
            assert_ne!(k, Some(K::UsageMenu), "{why}");
            assert!(k.is_none_or(|k| !goes_to_phone(status_code(k))), "{why}：不上手機");
        };
        not_menu(real.replace("What do you want to do?", "What do you want to do next?"), "標題不同");
        not_menu(real.replace("Enter to confirm · Esc to cancel", "Enter to select · Esc to cancel"), "頁尾不同");
        not_menu(real.replace("  Enter to confirm · Esc to cancel", ""), "沒有頁尾");
        not_menu(real.replace("Stop and wait for limit to reset", "Stop and wait for limit to reset now"), "「停下來等」字不同");
        not_menu(real.replace("2. Wait here, then", "2. Please wait here, then"), "「在這裡等」字不同");
        not_menu(real.replace("    3. Switch", "  ❯ 3. Switch"), "兩個游標");
        not_menu(real.replace("3. Switch to usage credits", "3. Stop and wait for limit to reset"), "「停下來等」有兩項");
        // 模型回覆裡引用整段選單、下面還有輸入框：不是選單
        let rule = "─".repeat(80);
        let quoted = format!("{real}\n\n● 上面是額度用完時的選單。\n{rule}\n❯ \n{rule}\n  ? for shortcuts");
        not_menu(quoted, "模型引用選單文字");
        // 工具輸出裡出現選單文字、上面是執行中：不是選單
        let tool = format!("● Bash(cat menu.txt)\n  ⎿  What do you want to do?\n     ❯ 1. Stop and wait for limit to reset\n       2. Wait here, then continue automatically at 3pm\n     Enter to confirm · Esc to cancel\n\n✻ Running… (3s)\n{rule}\n❯ \n{rule}\n  ? for shortcuts");
        not_menu(tool, "工具輸出");
    }

    #[test]
    fn 權限框裡_claude_自己收起長內容的記號_算不完整() {
        let rule = "─".repeat(60);
        let page = |mid: &str| format!("{rule}\n Bash command\n{mid}\n Do you want to proceed?\n ❯ 1. Yes\n   2. No\n");
        assert!(permission_text(&page(" mkdir x")).unwrap().complete, "平常的指令是完整的");
        for mid in [" for f in a b c; do\n … +12 lines (ctrl+o to expand)", "   ... +3 lines", " echo x\n   (ctrl+r to expand)", " … +1 line"] {
            assert!(!permission_text(&page(mid)).unwrap().complete, "{mid:?}");
        }
        for ok in ["echo '1 … 2'", "echo +3 lines", "echo …"] {
            assert!(!is_elision_line(ok), "{ok:?} 不是收起的記號");
        }
    }

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
        // #1799 有意調整：原本只有「 ❯ 甲 / 乙」兩列也算選單；現在要選單形狀（帶頁尾、帶編號，或連著至少兩個選項列）。
        // 只有一個選項列又沒頁尾、沒編號的畫面，和對話區的提問回顯分不開，不再當選單
        let with_footer = "前面的內容

要選一個
 ❯ 甲
   乙

Esc to cancel
";
        assert_eq!(kind(with_footer), Some(K::Attention), "{with_footer}");
        let three = "前面的內容

要選一個
 ❯ 甲
   乙
   丙
";
        assert_eq!(kind(three), Some(K::Attention), "{three}");
    }

    #[test]
    fn 單號1799_回顯加編號清單加表格_底部沒有輸入框_不是選單() {
        // 視窗被捲動、輸入框不在畫面裡時，提問的回顯 `❯ 提問` 落在最後 16 行內
        let text = fixture!("claude-1799-reply-list-table-no-input.synthetic");
        assert_eq!(kind(text), None, "{text}");
    }

    #[test]
    fn 單號1799_回顯本身是編號行_底部沒有輸入框_不是選單() {
        let text = fixture!("claude-1799-echo-numbered-no-input.synthetic");
        assert_eq!(kind(text), None, "{text}");
    }

    #[test]
    fn 單號1799_完整畫面_回顯加清單加表格加空輸入框_不是選單() {
        let text = fixture!("claude-1799-reply-list-table-idle.synthetic");
        assert_eq!(kind(text), None, "{text}");
    }

    #[test]
    fn 單號1799_編號回顯和後面的縮排清單隔著空行_不算緊鄰_不是選單() {
        // 回顯的游標列帶編號，後面沒有 ● 標記（回覆開頭被捲走），但中間隔著空行：不是同一份選單
        let text = "❯ 1. 照甲做

  1. 讀設定檔
  2. 改欄位
";
        assert_eq!(kind(text), None, "{text}");
    }

    #[test]
    fn 單號1799_回顯後面緊接選項形狀的縮排行_只要後面有回覆就不是選單() {
        // 使用者多行提問的回顯（第二行縮排）：後面接 ● 回覆，不算選單
        let text = "❯ 1. 照甲做
  2. 照乙做

● 收到。
";
        assert_eq!(kind(text), None, "{text}");
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
    fn 登入失效_只認掛在錯誤符號底下的固定錯誤字_模型回覆寫的不算() {
        let page = |line: &str| format!("{line}\n──────────────\n❯ \n──────────────\n  ? for shortcuts\n");
        for ok in ["  ⎿  Login expired · Please run /login", "  ⎿  OAuth token revoked · Please run /login", "  ⎿  API Error: 401 Invalid API key · Please run /login"] {
            assert_eq!(kind(&page(ok)), Some(K::Login), "{ok}");
        }
        for bad in [
            "● 你的登入好像過期了，Please run /login",
            "● Login expired · Please run /login",
            "● API Error: 401 · Please run /login",
            "  ⎿  隨便寫的字 · Please run /login",
            "  ⎿  Please run /login",
            "  ⎿  Login expired · Please run /login 然後再試",
            "  ⎿  login expired · please run /login",
        ] {
            assert_ne!(kind(&page(bad)), Some(K::Login), "{bad}");
        }
        // 模型回覆的最後一行（緊貼輸入框）寫成這樣：不認成要登入
        let reply = "● 我幫你查了錯誤訊息，原文是：\n  Login expired · Please run /login\n● Please run /login";
        assert_ne!(kind(&page(reply)), Some(K::Login));
    }

    #[test]
    fn 登入逾時_認字不認行位置_暫時性的更新失敗不算登入() {
        let page = |line: &str| format!("{line}\n──────────────\n❯ \n──────────────\n  ? for shortcuts\n");
        for ok in [
            "Login reached its time limit · Please run /login",
            "  ⎿  Login reached its time limit · Please run /login",
            "Failed to authenticate: this login reached its time limit · Sign in again to continue",
            "  ⎿  Failed to authenticate: this login reached its time limit and cannot be renewed. Run `claude auth login` to sign in a…",
        ] {
            assert_eq!(kind(&page(ok)), Some(K::Login), "{ok}");
            // 訊息和輸入框之間隔幾行別的東西也認得
            assert_eq!(kind(&page(&format!("{ok}\n\n  ✻ Churned for 3s\n"))), Some(K::Login), "{ok}");
        }
        // 整頁被登入流程蓋住、沒有輸入框
        assert_eq!(kind("Login reached its time limit · Please run /login\n"), Some(K::Login));
        // 另一個 Claude 程序正在更新登入：暫時的，不是要重新登入
        let transient = "Could not refresh your login because another Claude Code process is refreshing it (or exited mid-refresh) · Try again";
        assert_ne!(kind(&page(transient)), Some(K::Login));
        assert_ne!(kind(&page(&format!("  ⎿  {transient}"))), Some(K::Login));
        // ⎿ 底下的工具輸出（grep 結果、文件）只是引用這句話：不算
        for quoted in [
            "  ⎿  relay/asn/src-tauri/src/launch/claude_screen.rs:82:const LOGIN_TIME_LIMIT: &str = \"reached its time limit\";",
            "  ⎿  docs/x.md: 畫面停在 Login reached its time limit 時推播",
        ] {
            assert_ne!(kind(&page(quoted)), Some(K::Login), "{quoted}");
        }
        // 使用者訊息的回顯、收發室轉進來的信內文：句子中間才提到這句，不算
        for echo in [
            "> 畫面停在 Login reached its time limit 時要推播到手機",
            "  #1792：Claude 視窗停在「Login reached its time limit」時推播到本人手機",
        ] {
            assert_ne!(kind(&page(echo)), Some(K::Login), "{echo}");
        }
        // 模型自己的回覆（引用這句話）不算
        assert_ne!(kind(&page("● Login reached its time limit · Please run /login")), Some(K::Login));
        assert_ne!(kind(&page("● 這句是「Failed to authenticate: this login reached its time limit」的意思")), Some(K::Login));
    }

    /// 一段對話底下接空的輸入框與狀態列
    fn above_input(rows: &[&str]) -> String {
        let rule = "─".repeat(40);
        format!("{}\n\n{rule}\n❯ \n{rule}\n  ? for shortcuts\n", rows.join("\n"))
    }

    const WEEKLY: &str = "  ⎿  You've hit your weekly limit · resets Nov 26, 8pm (Asia/Taipei)";
    const WEEKLY_HINT: &str = "     /usage-credits to finish what you're working on.";

    #[test]
    fn 單號2335_週額度用完_後面接子代理輸出_認得出來_只標狀態() {
        let text = fixture!("claude-limit-weekly-subagents.synthetic").replace("\r\n", "\n");
        let s = classify(&text).expect("要認得週額度用完");
        assert_eq!((s.kind, status_code(s.kind)), (K::UsageLimit, "usage_limit"));
        assert_eq!((s.allow_once, s.deny, s.options.len()), (None, None, 0));
        // 前提：提示離底部超過舊的回看行數，不然這支測不到回看範圍
        let lines: Vec<&str> = text.trim_end().lines().collect();
        let at = lines.iter().position(|l| *l == WEEKLY).unwrap();
        assert!(lines.len() - at > NOTICE_LOOKBACK + 4, "{}", lines.len() - at);
    }

    #[test]
    fn 單號2335_各種額度名稱與掛法都認得() {
        for said in [
            "You've hit your limit · resets 5pm (Asia/Taipei)",
            "You've hit your weekly limit · resets Nov 26, 8pm (Asia/Taipei)",
            "You've hit your weekly limit · resets Jan 2, 2027, 8:30pm (Asia/Taipei) · progress saved",
            "You've hit your weekly limit",
            "You've hit your session limit · resets 3pm",
            "You've hit your 5-hour limit · resets 5pm (Asia/Taipei)",
            "You've hit your Opus limit · resets 5pm (Asia/Taipei)",
            "You've hit your Opus 4.1 limit · resets 5pm (Asia/Taipei)",
            "You've hit your Sonnet limit",
            "You've hit your Fable limit",
            "You've hit your usage credit limit",
            "You've hit your monthly spend limit · /usage-credits to raise it",
            "You've hit your daily limit · resets 8:30pm (Asia/Taipei)",
        ] {
            let text = above_input(&["❯ 繼續", &format!("  ⎿  {said}"), WEEKLY_HINT]);
            assert_eq!(kind(&text), Some(K::UsageLimit), "{text}");
        }
        for rows in [
            // ⎿ 後面是不換行空白
            vec!["❯ 繼續", "  ⎿ \u{a0}You've hit your weekly limit · resets 8pm"],
            // 排程工作、工具摘要、前一個工具的結果後面
            vec!["✻ Running scheduled task (Nov 14 3:51pm)", WEEKLY, WEEKLY_HINT],
            vec!["● 我先讀檔。", "", "  Read 1 file", "", WEEKLY, WEEKLY_HINT],
            vec!["● Bash(ls)", "  ⎿  a.txt", "", WEEKLY, WEEKLY_HINT],
            // 掛在背景子代理的結束通知底下
            vec!["● Agent \"查額度\" failed", WEEKLY],
            // 提示就是畫面第一行
            vec![WEEKLY, WEEKLY_HINT],
            // 舊字樣掛在 ● 上
            vec!["● You've hit your limit · resets 3pm (Asia/Taipei)", "  /upgrade to increase your usage limit."],
        ] {
            let text = above_input(&rows);
            assert_eq!(kind(&text), Some(K::UsageLimit), "{text}");
        }
        // 選單選了「停下來等」之後：選單收掉、輸入框回來
        let menu = limit_menu("claude-limit-menu.real.txt");
        let kept: Vec<&str> = menu.lines().take_while(|l| !l.starts_with('─')).collect();
        assert_eq!(kind(&above_input(&kept)), Some(K::UsageLimit), "{kept:?}");
    }

    #[test]
    fn 單號2335_一般句子與別種限制_不算() {
        for said in [
            "You've hit your stride limit",
            "You've hit your stride limit today",
            "You've hit your weekly limits · resets 3pm",
            "You've hit your weekly limit, so we wait",
            "You've hit your limitless potential",
            "You've hit your fast limit · resets in 2h",
            "You've hit your very own weekly limit · resets 3pm",
            "You've hit your src/weekly limit · resets 3pm",
            "You've hit your abcdefghijklmnopqrstuvwxyz limit · resets 3pm",
            "他說 You've hit your weekly limit · resets 3pm",
        ] {
            let text = above_input(&["❯ 繼續", &format!("  ⎿  {said}")]);
            assert_eq!(kind(&text), None, "{text}");
        }
    }

    #[test]
    fn 單號2335_對話或工具輸出引用這句話_不算() {
        // 前提：同一句話照 Claude 自己的掛法是認得的，下面的反例才有意義
        assert_eq!(kind(&above_input(&["❯ 繼續", WEEKLY, WEEKLY_HINT])), Some(K::UsageLimit));
        let said = "You've hit your weekly limit · resets Nov 26, 8pm (Asia/Taipei)";
        let bullet = format!("● {said}");
        let echo = format!("❯ 夥伴畫面寫 {said}");
        let deep = format!("    {}", WEEKLY.trim_start());
        let grep = format!("     fixtures/a.txt:2:{WEEKLY}");
        let cat = format!("   {WEEKLY}");
        let diff = format!("     +{WEEKLY}");
        let cases: Vec<(&str, Vec<&str>)> = vec![
            ("使用者提問裡貼這句話", vec![&echo]),
            ("模型回覆以 ● 開頭引用", vec![&bullet, "", "✻ Baked for 5s · done"]),
            ("回覆裡的程式碼區塊", vec!["● 畫面上是：", "", &deep, "", "✻ Baked for 5s · done"]),
            ("回覆裡引用在最後一行", vec!["● 畫面上是：", "", WEEKLY, WEEKLY_HINT, "", "✻ Baked for 5s · done"]),
            ("回覆中間引用、後面還有內文", vec!["❯ 貼給你看", WEEKLY, "  上面這句是額度用完的意思。"]),
            ("回覆開頭捲出畫面", vec!["  上面那句是：", "", WEEKLY, "", "✻ Baked for 5s · done"]),
            ("工具輸出第一行", vec!["● Bash(cat notes.txt)", WEEKLY, WEEKLY_HINT]),
            ("工具指令折行後的輸出", vec!["● Bash(cd /x &&", "      cat notes.txt)", WEEKLY]),
            ("grep 輸出", vec!["● Bash(grep -rn limit .)", "  ⎿  a.rs:97: const X", &grep]),
            ("git diff 輸出", vec!["● Bash(git diff)", "  ⎿  diff --git a/x b/x", &diff]),
            ("印出樣本檔", vec!["● Bash(cat screen.txt)", "  ⎿  ✻ Running", &cat]),
            ("看這張單的內文", vec!["● Bash(gh issue view 2335)", "  ⎿  畫面上的字：", "     ```", &cat, "     ```"]),
        ];
        for (why, rows) in cases {
            let text = above_input(&rows);
            assert_eq!(kind(&text), None, "{why}\n{text}");
        }
        // 打在輸入框裡還沒送出
        let rule = "─".repeat(40);
        let typing = format!("● 好。\n\n{rule}\n❯ 看這個\n{WEEKLY}\n{rule}\n  ? for shortcuts\n");
        assert_eq!(kind(&typing), None, "{typing}");
    }

    #[test]
    fn 單號2335_提示之後對話又往下走_不算() {
        let after = |rest: &[&str]| {
            let mut rows = vec!["❯ 繼續", WEEKLY, WEEKLY_HINT, ""];
            rows.extend_from_slice(rest);
            above_input(&rows)
        };
        for (why, rest) in [
            ("新的回覆", vec!["● 好，我接著做。"]),
            ("新的工具呼叫", vec!["● Bash(ls)", "  ⎿  a.txt"]),
            ("本人送出新的提問、正在想", vec!["❯ 換好帳號了，繼續", "", "✻ Thinking… (esc to interrupt)"]),
            ("換帳號登入成功", vec!["❯ /login", "  ⎿  Login successful"]),
            ("子代理通知之後有回覆", vec!["● Agent \"查額度\" completed", "", "● 結果整理如下。"]),
        ] {
            let text = after(&rest);
            assert_eq!(kind(&text), None, "{why}\n{text}");
        }
        for (why, rest) in [
            ("只有結束字樣", vec!["✻ Crunched for 0s · done"]),
            ("背景子代理的通知", vec!["● Agent \"查額度\" completed"]),
            ("背景指令的通知", vec!["● Background command \"build\" failed with exit code 1"]),
            ("打了斜線指令", vec!["❯ /usage-credits", "  ⎿  Opening your options…"]),
            ("再送一次又撞到", vec!["❯ 再試", WEEKLY, WEEKLY_HINT]),
        ] {
            let text = after(&rest);
            assert_eq!(kind(&text), Some(K::UsageLimit), "{why}\n{text}");
        }
    }

    #[test]
    fn 單號2335_回看範圍有上限_和登入錯誤並存時看較新的() {
        let mut rows = vec!["❯ 繼續", WEEKLY];
        rows.extend(std::iter::repeat("").take(USAGE_LOOKBACK));
        assert_eq!(kind(&above_input(&rows)), None, "太舊的提示不看");
        let login = "  ⎿  Login expired · Please run /login";
        assert_eq!(kind(&above_input(&["❯ 繼續", WEEKLY, login])), Some(K::Login));
        assert_eq!(kind(&above_input(&["❯ 繼續", login, WEEKLY])), Some(K::UsageLimit));
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
    use ClaudeScreenKind as K;

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

    const SCROLLED_MORE: &str = include_str!("../../tests/fixtures/term-screens/claude-permission-scrolled-more-lines.txt");

    #[test]
    fn 捲動過的長指令權限框_選項下方有更多行的提示_仍判成權限框_不完整_只給拒絕() {
        // #2256：擁有者截圖。標題捲出畫面、安全提示帶左邊框、選項只有 Yes／No、選項下方 `↑ 10 more lines`、頁尾很長
        let text = SCROLLED_MORE.replace("\r\n", "\n");
        let s = classify(&text).expect("認得出權限框");
        assert_eq!(s.kind, K::Permission);
        assert_eq!(s.question, "Do you want to proceed?");
        let opts: Vec<(u32, &str)> = s.options.iter().map(|o| (o.n, o.label.as_str())).collect();
        assert_eq!(opts, vec![(1, "Yes"), (2, "No")], "「↑ 10 more lines」不能併進最後一個選項");
        assert_eq!(s.deny, Some(2));
        let p = permission_text(&text).unwrap();
        assert!(!p.complete, "標題捲出、還有更多行：不完整");
        let old: Vec<u32> = phone_options(&s, p.complete).iter().map(|o| o.n).collect();
        assert_eq!(old, vec![2], "舊手機只給拒絕");
    }

    #[test]
    fn 有_more_lines_提示的畫面算不完整_沒有的照舊() {
        for ok in ["↑ 10 more lines", "  ↓ 1 more line", "↑ 3 more lines  "] {
            assert!(is_elision_line(ok), "{ok:?}");
        }
        for no in ["echo '↑ 3 more lines' > x", "more lines", "↑ more lines"] {
            assert!(!is_elision_line(no), "{no:?}");
        }
    }

    #[test]
    fn 框頂端看得到_但選項下方還有更多行_一樣不完整() {
        let rule = "─".repeat(60);
        let page = |tail: &str| format!("{rule}\n Bash command\n mkdir x\n\n Do you want to proceed?\n ❯ 1. Yes\n   2. No\n{tail}Esc to cancel · Tab to amend\n");
        assert!(permission_text(&page("")).unwrap().complete, "對照：沒有提示就是完整");
        assert!(!permission_text(&page("↑ 3 more lines\n")).unwrap().complete);
    }

    #[test]
    fn 一般對話裡有_proceed_和_yes_但沒有頁尾_不判成權限框() {
        let text = "● 我想問你：\n\nDo you want to proceed?\n❯ 1. Yes\n  2. No\n\n● 等你回答\n";
        assert!(classify(text).is_none_or(|s| s.kind != K::Permission));
        let text2 = "Do you want to proceed?\n  1. Yes\n  2. No\n↑ 3 more lines\n";
        assert!(classify(text2).is_none_or(|s| s.kind != K::Permission));
    }

    #[test]
    fn 只有_more_lines_沒有選項_不判成權限框() {
        let text = "● 輸出：\n  ⎿  ↑ 3 more lines\n↑ 3 more lines\nEsc to cancel · Tab to amend\n";
        assert!(classify(text).is_none_or(|s| s.kind != K::Permission));
    }

    #[test]
    fn 頁尾折成兩行也認得() {
        let text = SCROLLED_MORE.replace("\r\n", "\n").replace("Tab to amend · ctrl+x", "Tab to amend ·\nctrl+x");
        let s = classify(&text).expect("認得出權限框");
        assert_eq!(s.kind, K::Permission);
        assert_eq!(s.options.len(), 2);
    }

    #[test]
    fn 頁尾折到第三行也認得_但頁尾後面接一般文字就不算頁尾() {
        let base = SCROLLED_MORE.replace("\r\n", "\n");
        // 窄視窗把頁尾折在單字中間：最後一行只剩「background agents」
        let folded = base.replace("to stop background agents", "to stop\nbackground agents");
        assert_eq!(classify(&folded).map(|s| s.kind), Some(K::Permission));
        // 頁尾下面接的是一般文字（不像頁尾後半）：不能當頁尾吃掉，也就不能判成權限框
        for tail in ["好的，我來處理", "running build…\nstill running"] {
            let text = base.replace("background agents\n", &format!("background agents\n{tail}\n"));
            assert!(classify(&text).is_none_or(|s| s.kind != K::Permission), "頁尾後接：{tail}");
        }
    }

    #[test]
    fn more_lines_標記最多認兩行_連著三行不判成權限框() {
        let base = SCROLLED_MORE.replace("\r\n", "\n");
        let two = base.replace("↑ 10 more lines\n", "↑ 10 more lines\n↓ 2 more lines\n");
        assert_eq!(classify(&two).map(|s| s.kind), Some(K::Permission));
        let three = base.replace("↑ 10 more lines\n", "↑ 10 more lines\n↑ 9 more lines\n↑ 8 more lines\n");
        assert!(classify(&three).is_none_or(|s| s.kind != K::Permission));
    }

    #[test]
    fn 有游標_沒頁尾_沒輸入框_結尾是_more_lines_仍判成權限框_與沒有標記時一致() {
        // 二審點出的情況：Claude 偶爾不畫頁尾。有沒有 more lines 標記，判斷要一樣（舊行為沒頁尾也判成權限框）
        let without = "Do you want to proceed?\n❯ 1. Yes\n  2. No\n";
        let with = "Do you want to proceed?\n❯ 1. Yes\n  2. No\n↑ 10 more lines\n";
        assert_eq!(classify(without).map(|s| s.kind), Some(K::Permission));
        assert_eq!(classify(with).map(|s| s.kind), Some(K::Permission));
        assert!(!permission_text(with).expect("有權限框文字").complete, "有 more lines 就標不完整");
    }

    #[test]
    fn 只有認得的代號才傳到手機() {
        for k in [ClaudeScreenKind::TrustFolder, ClaudeScreenKind::BypassWarning, ClaudeScreenKind::Login, ClaudeScreenKind::UsageLimit, ClaudeScreenKind::Attention] {
            assert!(!goes_to_phone(status_code(k)), "{k:?}");
        }
    }
}

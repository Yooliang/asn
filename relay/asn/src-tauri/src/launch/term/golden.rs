//! G1 黃金檔與特徵測試（term.rs 的純函式）。
//!
//! 鎖的是「現況」不是「期望」：畫面分類、按鍵編碼、指令解析、遠端白名單等純函式在固定輸入下的輸出，
//! 記成 tests/golden/term/*.json。看起來像誤判的結果也如實記著（見各黃金檔），不在這裡修。
//! 更新方式：ASN_UPDATE_GOLDEN=1 cargo test --lib golden，重跑一次後審 git diff（CI 禁止重寫）。

use super::*;
use crate::golden;
use crate::golden_util::to_golden;
use crate::launch::profiles::{LaunchMode, Profile};
use serde::Serialize;
use std::collections::{BTreeMap, HashMap};

// ---- 共用：畫面樣本 ----------------------------------------------------------------------------------

macro_rules! fixtures {
    ($($n:literal),* $(,)?) => {
        &[$(($n, include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/term-screens/", $n)))),*]
    };
}

/// tests/fixtures/term-screens/ 底下全部現有樣本（新增樣本要同步加進這張表；有守門測試核對數量）
const FIXTURES: &[(&str, &str)] = fixtures![
    "claude-ask-user-question.txt",
    "claude-auto-mode-teach.txt",
    "claude-bypass-warning.synthetic.txt",
    "claude-firstrun-theme.txt",
    "claude-idle-after-reply.txt",
    "claude-idle-auto-mode.txt",
    "claude-idle-manual-mode.txt",
    "claude-login-expired.synthetic.txt",
    "claude-login-method.txt",
    "claude-lookalike-model-text.txt",
    "claude-lookalike-tool-output.txt",
    "claude-permission-bash.txt",
    "claude-permission-webfetch.txt",
    "claude-permission-write.txt",
    "claude-plan-approval.txt",
    "claude-running.txt",
    "claude-trust-folder-yes-selected.txt",
    "claude-trust-folder.txt",
    "claude-usage-limit.synthetic.txt",
    "pi-crash-verbatim-cwd.txt",
    "pi-error-400-credit-low.txt",
    "pi-error-401-invalid-key.txt",
    "pi-idle-no-auth.txt",
    "pi-idle.txt",
    "pi-trust-folder.txt",
];

/// 合成邊界案例：(名稱, 畫面)
fn synthetic() -> Vec<(&'static str, String)> {
    let long_q = "Ａ".repeat(600);
    vec![
        ("空字串", String::new()),
        ("只有空白行", "   \n\n  \n".into()),
        ("兩個游標", "請選擇\n> 第一項\n> 第二項\n  第三項".into()),
        ("兩個游標_符號式", "請選擇\n❯ 甲\n❯ 乙\n○ 丙".into()),
        ("單一游標_第一項", "要繼續嗎？\n> 是\n  否".into()),
        ("單一游標_第二項", "要繼續嗎？\n  是\n> 否".into()),
        ("輸入框在下方", "要繼續嗎？\n> 是\n  否\n\n│ ❯ \n╰──────╯".into()),
        ("輸入框在下方_有字", "要繼續嗎？\n> 是\n  否\n│ ❯ hello │".into()),
        ("選單下方恰好三行", "要繼續嗎？\n> 是\n  否\n\n頁尾一\n頁尾二\n頁尾三".into()),
        ("選單下方四行", "要繼續嗎？\n> 是\n  否\n\n頁尾一\n頁尾二\n頁尾三\n頁尾四".into()),
        ("grok信任句_下方有輸入框與版本", "Do you trust the contents of this directory? C:/work\n\n│ ❯ \n╰──────╯\ngrok v1.0".into()),
        ("grok信任句_下方四行", "Do you trust the contents of this directory?\n一\n二\n三\n四".into()),
        ("grok信任句_前面有縮排", "   Do you trust the contents of this directory?".into()),
        ("grok信任句_不在行首", "說明 Do you trust the contents of this directory?".into()),
        ("符號清單_兩個空心圈", "○ a\n○ b".into()),
        ("符號清單_三個中點", "· a\n· b\n· c".into()),
        ("符號清單_單項", "○ a".into()),
        ("符號清單_實心加空心", "Pick\n● 甲\n○ 乙\n○ 丙".into()),
        ("符號清單_項目後無空格", "○a\n○b".into()),
        ("縮排不一致", "Q\n> a\n   b".into()),
        ("選項含控制字元", "Q\n> a\u{7}b\n  c".into()),
        ("問題三行", "第一行\n第二行\n第三行？\n> a\n  b".into()),
        ("問題超過五百字_menu取頭", format!("{long_q}\n> a\n  b")),
        ("兩個游標_內文超過五百字_取尾", format!("{long_q}\n> a\n> b")),
        ("pi式箭頭_選單", "Select\n→ one\n  two\n  three".into()),
        ("pi式箭頭_輸出裡的箭頭", "輸出 → 結果\n完成".into()),
        ("pi式箭頭_兩個箭頭", "Select\n→ one\n→ two".into()),
        ("pi式箭頭_縮排箭頭", "Select\n  → one\n    two".into()),
    ]
}

/// 全部畫面（樣本檔 + 合成）：(名稱, 畫面)，順序固定
fn all_screens() -> Vec<(String, String)> {
    let mut v: Vec<(String, String)> = FIXTURES.iter().map(|(n, t)| (format!("fixture/{n}"), t.replace("\r\n", "\n"))).collect();
    v.extend(synthetic().into_iter().map(|(n, t)| (format!("synthetic/{n}"), t)));
    v
}

#[derive(Serialize)]
struct PromptOut {
    kind: &'static str,
    cursor: u32,
    option_count: usize,
    options: Vec<TermOption>,
    text_chars: usize,
    text: String,
}

fn prompt_out(p: Option<ScreenPrompt>) -> Option<PromptOut> {
    p.map(|p| PromptOut { kind: p.kind, cursor: p.cursor, option_count: p.options.len(), options: p.options, text_chars: p.text.chars().count(), text: p.text })
}

/// 簡短形式（矩陣用）：kind／cursor／選項標籤／內文字數
fn brief(p: Option<ScreenPrompt>) -> String {
    match p {
        None => "None".into(),
        Some(p) => format!("{} cursor={} options={:?} text_chars={}", p.kind, p.cursor, p.options.iter().map(|o| format!("{}:{}", o.n, o.label)).collect::<Vec<_>>(), p.text.chars().count()),
    }
}

#[test]
fn 守門_樣本表與資料夾內的檔案數一致() {
    let dir = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/term-screens");
    let n = std::fs::read_dir(dir).unwrap().filter_map(|e| e.ok()).filter(|e| e.file_name().to_string_lossy().ends_with(".txt")).count();
    assert_eq!(n, FIXTURES.len(), "tests/fixtures/term-screens 有新樣本，請加進 FIXTURES 並更新黃金檔");
}

// ---- 1. classify_prompt ------------------------------------------------------------------------------

#[test]
fn 畫面分類_全部樣本與合成邊界案例的現況結果() {
    // 鎖的是 classify_prompt 對每張畫面的 kind／選項／游標／內文。現行誤判或 None 一併照記。
    let out: BTreeMap<String, Option<PromptOut>> = all_screens().into_iter().map(|(n, t)| (n, prompt_out(classify_prompt(&t)))).collect();
    golden!("term/classify_prompt.json", &to_golden(&out));
}

#[test]
fn 畫面分類_常數現況() {
    // 這四個常數改了，分類範圍就變；單獨鎖數值
    assert_eq!((PROMPT_TAIL_LINES, PROMPT_TEXT_CHARS, MAX_MENU_DOWN, MAX_ANSWER_KEYS), (3, 500, 20, 32));
}

#[test]
fn 輔助函式_split_marker_與_at_bottom_的現況() {
    #[derive(Serialize)]
    struct M {
        indent: usize,
        marker: String,
        label_col: usize,
        label: String,
    }
    let lines = ["> a", "  > a", "❯ 甲", "● x", "▶ y", "○ z", "◦ z", "· z", ">a", ">", "> ", "\t> a", "  ○   多空格", "- a", "→ a", "> \u{7}", "", "   "];
    let marks: BTreeMap<String, Option<M>> = lines
        .iter()
        .map(|l| (format!("{l:?}"), split_marker(l).map(|(indent, m, label_col, label)| M { indent, marker: m.to_string(), label_col, label })))
        .collect();
    // at_bottom：游標下方非空白行數 0..=4，以及下方有輸入框
    let mut bottom: BTreeMap<String, bool> = BTreeMap::new();
    for after in 0..=4usize {
        let mut v = vec!["> a".to_string()];
        v.extend((0..after).map(|i| format!("x{i}")));
        let refs: Vec<&str> = v.iter().map(String::as_str).collect();
        bottom.insert(format!("下方{after}行"), at_bottom(&refs, 0));
    }
    bottom.insert("下方有輸入框".into(), at_bottom(&["> a", "│ ❯ "], 0));
    bottom.insert("下方空白行不算".into(), at_bottom(&["> a", "", "", "", "", "x"], 0));
    #[derive(Serialize)]
    struct All {
        split_marker: BTreeMap<String, Option<M>>,
        at_bottom: BTreeMap<String, bool>,
    }
    golden!("term/helpers.json", &to_golden(&All { split_marker: marks, at_bottom: bottom }));
}

// ---- 2. classify_prompt_for --------------------------------------------------------------------------

#[test]
fn 依終端種類分類_只有_pi_把行首箭頭當游標() {
    let mut out: BTreeMap<String, BTreeMap<&str, String>> = BTreeMap::new();
    for (name, text) in all_screens() {
        let row: BTreeMap<&str, String> = ["pi", "agy", "grok", "claude"].into_iter().map(|p| (p, brief(classify_prompt_for(p, &text)))).collect();
        out.insert(name, row);
    }
    golden!("term/classify_prompt_for.json", &to_golden(&out));
}

#[test]
fn 依終端種類分類_非_pi_等同不分種類的分類() {
    // 與黃金檔互為旁證：非 pi 一律走 classify_prompt
    for (name, text) in all_screens() {
        for p in ["agy", "grok", "claude", "", "PI", "Pi"] {
            assert_eq!(brief(classify_prompt_for(p, &text)), brief(classify_prompt(&text)), "{name} / {p}");
        }
    }
}

// ---- 3. grok_input_box / grok_processing -------------------------------------------------------------

#[test]
fn grok_輸入框與忙碌判斷表() {
    let cases: Vec<&str> = vec![
        "",
        "   ",
        "hello",
        "│ ❯",
        "│ ❯ ",
        "│ ❯ │",
        "  │ ❯   │  ",
        "│ ❯ …",
        "│ ❯ … │",
        "│ ❯ … x",
        "│ ❯ hello",
        "│ ❯ hello │",
        "│❯ hello",
        "| ❯ hello",
        "x │ ❯ hello",
        "│ ❯ \n│ ❯ hello",
        "│ ❯ hello\n│ ❯ ",
        "│ ❯ \n│ ❯ ",
        "│ ❯ │ │",
        "│ ❯ …│",
        "\u{3000}│ ❯",
        "line\r\n│ ❯ \r\n",
        "[stop]",
        "Ctrl+c:cancel",
        "Ctrl+C:cancel",
        "ctrl+c:cancel",
        "Ctrl+c: cancel",
        "xx[stop]yy",
        "[ stop ]",
        "[STOP]",
        "[stop] Ctrl+c:cancel",
        "│ ❯ [stop]",
        "思考中 Ctrl+c:cancel │ ❯ ",
    ];
    #[derive(Serialize)]
    struct Row {
        input_box: &'static str,
        processing: bool,
    }
    let out: Vec<(String, Row)> = cases
        .into_iter()
        .map(|t| {
            let b = match grok_input_box(t) {
                InputBox::None => "None",
                InputBox::Empty => "Empty",
                InputBox::Typing => "Typing",
            };
            (t.to_string(), Row { input_box: b, processing: grok_processing(t) })
        })
        .collect();
    golden!("term/grok_screen.json", &to_golden(&out));
}

// ---- 4. argv_for -------------------------------------------------------------------------------------

fn bare_svc() -> TermService<wezterm::RealRunner, wezterm::RealFs> {
    // argv_for 不會碰 runner／fs，用正式型別即可；不改產品程式
    TermService::fixed(WezTermDir { gui: Some("g".into()), cli: "c".into() }, "cfg.lua".into(), "t.json".into(), "H".into(), wezterm::RealRunner, wezterm::RealFs)
}

#[test]
fn 執行檔參數組合_agy_額外參數只認_settings_一組() {
    let extras: Vec<(&str, Option<Vec<&str>>)> = vec![
        ("沒設額外參數函式", None),
        ("回空陣列", Some(vec![])),
        ("settings加路徑", Some(vec!["--settings", "C:/asn/gemini-session-settings.json"])),
        ("settings值為空字串", Some(vec!["--settings", ""])),
        ("settings值為空白", Some(vec!["--settings", "   "])),
        ("settings值含換行", Some(vec!["--settings", "a\nb"])),
        ("settings值含跳脫字元", Some(vec!["--settings", "a\u{1b}[31m"])),
        ("settings值含tab", Some(vec!["--settings", "a\tb"])),
        ("settings值前後有空白不修剪", Some(vec!["--settings", "  x.json  "])),
        ("旗標大小寫不同", Some(vec!["--SETTINGS", "x.json"])),
        ("旗標不同", Some(vec!["--dangerously-skip-permissions", "x"])),
        ("旗標少一槓", Some(vec!["-settings", "x.json"])),
        ("只有一個元素", Some(vec!["--settings"])),
        ("三個元素", Some(vec!["--settings", "a", "b"])),
        ("三個元素_旗標值在前", Some(vec!["x", "--settings", "a"])),
        ("兩個值順序顛倒", Some(vec!["x.json", "--settings"])),
    ];
    let mut out: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for profile in ["agy", "grok", "claude", "pi", "AGY", ""] {
        for (label, extra) in &extras {
            let mut svc = bare_svc();
            if let Some(e) = extra {
                let e: Vec<String> = e.iter().map(|s| s.to_string()).collect();
                svc.set_agy_args(Box::new(move || e.clone()));
            }
            out.insert(format!("{profile:?} / {label}"), svc.argv_for(profile, "C:/bin/x.exe".into()));
        }
    }
    golden!("term/argv_for.json", &to_golden(&out));
}

// ---- 5. resolve_command / binary_stem ----------------------------------------------------------------

#[derive(Serialize)]
struct ResOut {
    ok: Option<String>,
    err: Option<String>,
}
fn res<T: ToString>(r: Result<T, String>) -> ResOut {
    match r {
        Ok(v) => ResOut { ok: Some(v.to_string()), err: None },
        Err(e) => ResOut { ok: None, err: Some(e) },
    }
}

fn prof(command: &str, disabled: bool, reason: &str) -> Profile {
    Profile { label: String::new(), command: command.into(), args: vec![], engine: String::new(), mode: LaunchMode::Window, disabled, disabled_reason: reason.into() }
}

fn cfg_of(entries: &[(&str, Profile)]) -> LaunchConfig {
    let mut profiles = HashMap::new();
    for (k, p) in entries {
        profiles.insert(k.to_string(), p.clone());
    }
    LaunchConfig { profiles, cwd_allow: vec![], max_per_hour: 6 }
}

#[test]
fn 解析終端指令_設定組合表() {
    let cases: Vec<(&str, &str, LaunchConfig)> = vec![
        ("agy_gemini正常", "agy", cfg_of(&[("gemini", prof("C:/bin/agy.exe", false, ""))])),
        ("agy_cmd副檔名", "agy", cfg_of(&[("gemini", prof("C:/bin/agy.cmd", false, ""))])),
        ("agy_無副檔名", "agy", cfg_of(&[("gemini", prof("/usr/local/bin/agy", false, ""))])),
        ("agy_大小寫混合與反斜線", "agy", cfg_of(&[("gemini", prof(r"C:\Program Files\Agy\AGY.EXE", false, ""))])),
        ("agy_前後空白被修剪", "agy", cfg_of(&[("gemini", prof("  C:/bin/agy.exe  ", false, ""))])),
        ("agy_多重副檔名", "agy", cfg_of(&[("gemini", prof("C:/bin/agy.exe.bak", false, ""))])),
        ("agy_資料夾叫agy但檔名是cmd", "agy", cfg_of(&[("gemini", prof("C:/agy/cmd.exe", false, ""))])),
        ("agy_指向cmd_exe", "agy", cfg_of(&[("gemini", prof(r"C:\Windows\System32\cmd.exe", false, ""))])),
        ("agy_結尾是分隔線", "agy", cfg_of(&[("gemini", prof("C:/bin/agy.exe/", false, ""))])),
        ("agy_只有agy編號沒有gemini", "agy", cfg_of(&[("agy", prof("C:/bin/agy.exe", false, ""))])),
        ("agy_同時有兩個編號只看gemini", "agy", cfg_of(&[("agy", prof("C:/bin/cmd.exe", false, "")), ("gemini", prof("C:/bin/agy.exe", false, ""))])),
        ("agy_設定缺", "agy", cfg_of(&[])),
        ("agy_停用有原因", "agy", cfg_of(&[("gemini", prof("C:/bin/agy.exe", true, "找不到 agy"))])),
        ("agy_停用無原因", "agy", cfg_of(&[("gemini", prof("C:/bin/agy.exe", true, ""))])),
        ("agy_停用且命令空_先報停用", "agy", cfg_of(&[("gemini", prof("", true, "原因"))])),
        ("agy_命令空", "agy", cfg_of(&[("gemini", prof("", false, ""))])),
        ("agy_命令只有空白", "agy", cfg_of(&[("gemini", prof("   ", false, ""))])),
        ("agy_控制字元", "agy", cfg_of(&[("gemini", prof("C:/bin/a\u{7}gy.exe", false, ""))])),
        ("agy_換行在中間", "agy", cfg_of(&[("gemini", prof("C:/bin/agy.exe\n--x", false, ""))])),
        ("agy_帶參數的字串", "agy", cfg_of(&[("gemini", prof("agy.exe --yolo", false, ""))])),
        ("agy_路徑含空白", "agy", cfg_of(&[("gemini", prof("C:/Program Files/agy/agy.exe", false, ""))])),
        ("grok_正常", "grok", cfg_of(&[("grok", prof("C:/bin/grok.exe", false, ""))])),
        ("grok_無副檔名", "grok", cfg_of(&[("grok", prof("grok", false, ""))])),
        ("grok_指向agy", "grok", cfg_of(&[("grok", prof("C:/bin/agy.exe", false, ""))])),
        ("grok_設定缺", "grok", cfg_of(&[("gemini", prof("C:/bin/agy.exe", false, ""))])),
        ("grok_停用有原因", "grok", cfg_of(&[("grok", prof("C:/bin/grok.exe", true, "未安裝"))])),
        ("grok_命令空", "grok", cfg_of(&[("grok", prof("", false, ""))])),
        ("grok_控制字元", "grok", cfg_of(&[("grok", prof("gro\u{0}k", false, ""))])),
        ("白名單外_claude", "claude", cfg_of(&[("claude", prof("C:/bin/claude.exe", false, ""))])),
        ("白名單外_pi", "pi", cfg_of(&[("pi", prof("pi", false, ""))])),
        ("白名單外_gemini編號", "gemini", cfg_of(&[("gemini", prof("C:/bin/agy.exe", false, ""))])),
        ("白名單外_空字串", "", cfg_of(&[("", prof("agy", false, ""))])),
        ("白名單外_大寫AGY", "AGY", cfg_of(&[("gemini", prof("agy", false, ""))])),
        ("白名單外_agy加空白", "agy ", cfg_of(&[("gemini", prof("agy", false, ""))])),
    ];
    let out: Vec<(String, ResOut)> = cases.into_iter().map(|(label, p, c)| (format!("{label} [{p:?}]"), res(resolve_command(p, &c)))).collect();
    golden!("term/resolve_command.json", &to_golden(&out));
}

#[test]
fn 檔名主檔_binary_stem_表() {
    let inputs = [
        "", " ", "agy", "agy.exe", "AGY.EXE", "C:/bin/agy.exe", r"C:\bin\agy.cmd", r"C:\bin/agy.exe", "  grok.exe  ", ".agy", ".hidden.agy", "agy.", "a.b.c", "dir/", r"dir\", "/", "a//b.exe", "C:/Program Files/agy/agy.exe", "agy.exe --x", "cmd.exe", "中文.exe", "AGY.tar.gz",
    ];
    let out: Vec<(String, String)> = inputs.iter().map(|s| (s.to_string(), binary_stem(s))).collect();
    golden!("term/binary_stem.json", &to_golden(&out));
}

// ---- 6. remote_allowed -------------------------------------------------------------------------------

#[test]
fn 遠端可開項目_完整矩陣() {
    // remote_allowed 在 bridge/launcher.rs（pub fn），不改該檔，從這裡呼叫
    let mut out: BTreeMap<String, bool> = BTreeMap::new();
    for id in ["claude", "codex", "gemini", "grok", "pi", "default", "agy", ""] {
        for engine in ["", "claude", "pi", "codex", "acp", "gemini", "Claude"] {
            for (mode_name, mode) in [("window", LaunchMode::Window), ("background", LaunchMode::Background)] {
                for disabled in [false, true] {
                    let p = Profile { label: String::new(), command: String::new(), args: vec![], engine: engine.into(), mode: mode.clone(), disabled, disabled_reason: String::new() };
                    out.insert(format!("id={id:?} engine={engine:?} mode={mode_name} disabled={disabled}"), crate::bridge::launcher::remote_allowed(id, &p));
                }
            }
        }
    }
    golden!("term/remote_allowed.json", &to_golden(&out));
}

// ---- 7. 答案按鍵 -------------------------------------------------------------------------------------

fn key_name(k: &AnswerKey) -> String {
    match k {
        AnswerKey::Up => "Up".into(),
        AnswerKey::Down => "Down".into(),
        AnswerKey::Enter => "Enter".into(),
        AnswerKey::Esc => "Esc".into(),
        AnswerKey::Char(c) => format!("Char({c:?})"),
    }
}

#[derive(Serialize)]
struct KeysOut {
    keys: Option<Vec<String>>,
    key_count: Option<usize>,
    describe: Option<String>,
    encoded: Option<String>,
    err: Option<String>,
}

/// 把 keys 結果完整展開：描述、編碼（含 encode_keys 的長度把關）、各個拒絕訊息
fn keys_out(r: Result<Vec<AnswerKey>, String>) -> KeysOut {
    match r {
        Err(e) => KeysOut { keys: None, key_count: None, describe: None, encoded: None, err: Some(e) },
        Ok(keys) => {
            let enc = encode_keys(&keys);
            KeysOut {
                keys: Some(keys.iter().map(key_name).collect()),
                key_count: Some(keys.len()),
                describe: Some(describe_keys(&keys)),
                encoded: enc.as_ref().ok().cloned(),
                err: enc.err(),
            }
        }
    }
}

#[test]
fn 答案按鍵_信任提問表() {
    let out: BTreeMap<String, KeysOut> = [0u32, 1, 2, 3, 4, 20, u32::MAX].into_iter().map(|n| (format!("n={n}"), keys_out(trust_keys(n)))).collect();
    golden!("term/trust_keys.json", &to_golden(&out));
}

#[test]
fn 答案按鍵_選單游標與目標表() {
    // 邊界：0（拒絕）、1、2、20、21（上限附近）、22、32、33（序列長度上限附近）
    let pts = [0u32, 1, 2, 3, 20, 21, 22, 32, 33];
    let mut out: BTreeMap<String, KeysOut> = BTreeMap::new();
    for c in pts {
        for n in pts {
            out.insert(format!("cursor={c:02} n={n:02}"), keys_out(menu_keys(c, n)));
        }
    }
    out.insert("cursor=1 n=21".into(), keys_out(menu_keys(1, 21)));
    out.insert("cursor=1 n=22".into(), keys_out(menu_keys(1, 22)));
    out.insert("cursor=33 n=1".into(), keys_out(menu_keys(33, 1)));
    // 注意：menu_keys 往下有上限（MAX_MENU_DOWN），但往上（cursor 大於 n）沒有上限——cursor 很大時會一次配置同等數量的鍵，
    // 例如 cursor=u32::MAX、n=1 會要配置約 43 億個元素而讓程序中止。實際上 cursor 來自畫面分類出的選單項目，到不了這麼大，
    // 所以這裡不鎖那種輸入（會讓測試程序崩潰），只記在 PR 說明；cursor=1000 代表「很大但配得起來」的現況。
    out.insert("cursor=1000 n=1".into(), keys_out(menu_keys(1000, 1)));
    out.insert("cursor=1 n=u32max".into(), keys_out(menu_keys(1, u32::MAX)));
    golden!("term/menu_keys.json", &to_golden(&out));
}

#[test]
fn 答案按鍵_單鍵編碼與序列長度與描述() {
    #[derive(Serialize)]
    struct All {
        encode_key: Vec<(String, ResOut)>,
        encode_keys: Vec<(String, ResOut)>,
        describe_keys: Vec<(String, String)>,
    }
    let single = [AnswerKey::Up, AnswerKey::Down, AnswerKey::Enter, AnswerKey::Esc, AnswerKey::Char('a'), AnswerKey::Char('Z'), AnswerKey::Char('0'), AnswerKey::Char('y'), AnswerKey::Char('é'), AnswerKey::Char('!'), AnswerKey::Char(' '), AnswerKey::Char('\n'), AnswerKey::Char('\r'), AnswerKey::Char('\u{1b}'), AnswerKey::Char('\u{0}'), AnswerKey::Char('中'), AnswerKey::Char('１')];
    let encode_key_rows = single.iter().map(|k| (key_name(k), res(encode_key(*k)))).collect();
    let rep = |k: AnswerKey, n: usize| vec![k; n];
    let seqs: Vec<(&str, Vec<AnswerKey>)> = vec![
        ("空序列", vec![]),
        ("一個Enter", vec![AnswerKey::Enter]),
        ("三十二個Down", rep(AnswerKey::Down, 32)),
        ("三十三個Down", rep(AnswerKey::Down, 33)),
        ("Up Down Enter Esc", vec![AnswerKey::Up, AnswerKey::Down, AnswerKey::Enter, AnswerKey::Esc]),
        ("中間夾非法字元鍵", vec![AnswerKey::Down, AnswerKey::Char('!'), AnswerKey::Enter]),
        ("字元鍵y", vec![AnswerKey::Char('y')]),
        ("兩個字元鍵", vec![AnswerKey::Char('y'), AnswerKey::Char('n')]),
    ];
    let encode_keys_rows = seqs.iter().map(|(n, k)| (n.to_string(), res(encode_keys(k)))).collect();
    let desc: Vec<(&str, Vec<AnswerKey>)> = vec![
        ("空序列", vec![]),
        ("單一字元鍵", vec![AnswerKey::Char('y')]),
        ("單一Enter", vec![AnswerKey::Enter]),
        ("單一Esc", vec![AnswerKey::Esc]),
        ("單一Up", vec![AnswerKey::Up]),
        ("Down二加Enter", vec![AnswerKey::Down, AnswerKey::Down, AnswerKey::Enter]),
        ("Up一加Enter", vec![AnswerKey::Up, AnswerKey::Enter]),
        ("Up Down Enter Esc 全有", vec![AnswerKey::Esc, AnswerKey::Enter, AnswerKey::Down, AnswerKey::Up]),
        ("Esc加Enter", vec![AnswerKey::Esc, AnswerKey::Enter]),
        ("兩個字元鍵", vec![AnswerKey::Char('y'), AnswerKey::Char('n')]),
        ("字元鍵加Enter", vec![AnswerKey::Char('1'), AnswerKey::Enter]),
        ("順序不影響描述", vec![AnswerKey::Enter, AnswerKey::Down]),
    ];
    let describe_rows = desc.iter().map(|(n, k)| (n.to_string(), describe_keys(k))).collect();
    golden!("term/answer_keys.json", &to_golden(&All { encode_key: encode_key_rows, encode_keys: encode_keys_rows, describe_keys: describe_rows }));
}

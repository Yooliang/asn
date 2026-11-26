//! ACP 工作者的權限政策與錯誤分類（純函式，不碰檔案、不碰行程）。對應 engines/acp-policy.mjs、acp-errors.mjs。
//! 政策＝每個「類別」一個決定 allow／deny／ask，外加「白名單資料夾」（有路徑的寫入請求，路徑在白名單外一律拒絕）。
//!   read 讀檔搜尋思考、write 寫刪搬、execute 執行指令、network 上網（預設都是 allow）；other 分不出類別（預設 deny）。
//!   寫入以白名單資料夾（預設只有工作者自己的工作資料夾）為界；讀取不限資料夾，只擋敏感位置（登入資料、金鑰、各工具的設定，見 acp_sensitive.rs）。
//!   執行指令沒有路徑可查，敏感位置清單不是邊界：邊界只靠 agents.json 的明寫設定（要完全封閉就把 execute 與 network 都設 deny）。
use super::acp_sensitive::{extract_read_paths, read_verdict, ReadCtx, ReadTool, ReadVerdict, SensitiveRoots, SENSITIVE_HOME_DIRS};
use serde_json::Value;
use std::collections::BTreeMap;
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;

pub const CATEGORIES: [&str; 5] = ["read", "write", "execute", "network", "other"];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Verdict {
    Allow,
    Deny,
    Ask,
}
impl Verdict {
    pub fn parse(s: &str) -> Option<Verdict> {
        match s {
            "allow" => Some(Verdict::Allow),
            "deny" => Some(Verdict::Deny),
            "ask" => Some(Verdict::Ask),
            _ => None,
        }
    }
    pub fn name(self) -> &'static str {
        match self {
            Verdict::Allow => "allow",
            Verdict::Deny => "deny",
            Verdict::Ask => "ask",
        }
    }
}

fn default_rule(c: &str) -> Verdict {
    match c {
        "read" | "write" | "execute" | "network" => Verdict::Allow,
        _ => Verdict::Deny,
    }
}

pub fn category_label(c: &str) -> &str {
    match c {
        "read" => "讀取",
        "write" => "寫入",
        "execute" => "執行指令",
        "network" => "上網",
        "other" => "其他動作",
        x => x,
    }
}

/// ACP toolCall.kind → 類別（協定的 kind：read, edit, delete, move, search, execute, think, fetch, switch_mode, other）
pub fn category_of_acp_kind(kind: &str) -> &'static str {
    match kind.to_lowercase().as_str() {
        "read" | "search" | "think" => "read",
        "edit" | "delete" | "move" => "write",
        "execute" => "execute",
        "fetch" => "network",
        _ => "other",
    }
}

// 實機看到的工具名（agy 1.5.18）：read_file（參數 Path）、run_command（CommandLine）、update_steps；列目錄與搜尋都走 run_command。
// 舊版名字（view_file、write_to_file…）一併保留
const AGY_READ: [&str; 7] = ["read_file", "view_file", "list_dir", "find_by_name", "grep_search", "read_resource", "list_resources"];
const AGY_WRITE: [&str; 7] = ["write_file", "edit_file", "write_to_file", "replace_file_content", "multi_replace_file_content", "sed_file", "notebook_edit"];
// 會啟動指令、子代理、工作流程，或把訊息、排程送出去的，都照執行類的政策
const AGY_EXEC: [&str; 12] = [
    "run_command", "send_command_input", "command_status", "notebook_execution", "execute_browser_javascript", "run_workflow", "swarm", "invoke_subagent", "define_subagent", "manage_subagents", "send_message", "schedule",
];
const AGY_NET: [&str; 8] = ["read_url_content", "search_web", "open_browser_url", "read_browser_page", "capture_browser_console_logs", "capture_browser_screenshot", "list_browser_pages", "get_browser_dom"];
const AGY_INTERNAL: &[&str] = &[
    "finish", "wait", "wait_5_seconds", "ask_question", "ask_permission", "ask_custom_permission", "list_permissions", "manage_task", "update_steps", "manage_inbox", "delete_knowledge", "search_marketplace", "list_plugin_accounts",
    "call_mcp_tool", "generate_image"
];

/// 這個工具名登記過嗎（五張表裡有）。沒登記的會用關鍵字推測類別，但呼叫端要記一行 log，不能默默放行
pub fn is_registered_agy_tool(name: &str) -> bool {
    let n = name.to_lowercase();
    [&AGY_READ[..], &AGY_WRITE[..], &AGY_EXEC[..], &AGY_NET[..], AGY_INTERNAL].iter().any(|t| t.contains(&n.as_str()))
}

/// agy 原生 stream-json 的工具名 → 類別。"internal"＝代理自己的內部控制（規劃、等待、結束…），一律放行。
/// 沒登記的新工具名用關鍵字推測；推測不出來視為 internal（呼叫端用 is_registered_agy_tool 判斷要不要記 log）
pub fn category_of_agy_tool(name: &str) -> &'static str {
    let n = name.to_lowercase();
    let n = n.as_str();
    if AGY_READ.contains(&n) {
        return "read";
    }
    if AGY_WRITE.contains(&n) {
        return "write";
    }
    if AGY_EXEC.contains(&n) {
        return "execute";
    }
    if AGY_NET.contains(&n) {
        return "network";
    }
    if AGY_INTERNAL.contains(&n) {
        return "internal";
    }
    if n.starts_with("browser_") {
        return "network";
    }
    if ["write", "edit", "replace", "delete", "remove", "move", "create", "patch", "sed_"].iter().any(|k| n.contains(k)) {
        return "write";
    }
    if ["run", "exec", "command", "shell", "terminal", "bash"].iter().any(|k| n.contains(k)) {
        return "execute";
    }
    if ["url", "web", "http", "fetch"].iter().any(|k| n.contains(k)) {
        return "network";
    }
    "internal"
}

#[derive(Clone, Debug)]
pub struct Permissions {
    pub rules: BTreeMap<&'static str, Verdict>,
    pub allow_dirs: Vec<PathBuf>,
    /// 寫入再多一層限制（可選）：有設時，寫檔的路徑還要在這些資料夾裡（同時也必須在 allow_dirs 裡）；沒設就只看 allow_dirs（#708）
    pub write_dirs: Option<Vec<PathBuf>>,
    /// 讀取不能碰的敏感位置（#2356）：工作者建立時用兩個家目錄算好放進來；None＝不檢查讀取（只有單元測試會是 None）
    pub sensitive: Option<Arc<SensitiveRoots>>,
}
impl Permissions {
    pub fn rule(&self, c: &str) -> Verdict {
        self.rules.get(c).copied().unwrap_or_else(|| self.rules.get("other").copied().unwrap_or(Verdict::Deny))
    }
}

/// 不碰檔案系統的路徑正規化：以 base 補成絕對路徑，去掉 `.` 與 `..`（對應 Node 的 path.resolve）
pub fn resolve(base: &Path, p: &str) -> PathBuf {
    let joined = if Path::new(p).is_absolute() || p.starts_with('/') || p.starts_with('\\') { PathBuf::from(p) } else { base.join(p) };
    let mut out = PathBuf::new();
    for c in joined.components() {
        match c {
            Component::ParentDir => {
                if !out.pop() {
                    out.push("..");
                }
            }
            Component::CurDir => {}
            other => out.push(other.as_os_str()),
        }
    }
    out
}

/// raw：agents.json 裡的 permissions；cwd：工作者的工作資料夾（預設白名單）。回傳（政策, 提醒）
pub fn normalize_permissions(raw: Option<&Value>, cwd: &Path) -> (Permissions, Vec<String>) {
    let mut warnings = vec![];
    let empty = serde_json::Map::new();
    let src = raw.and_then(Value::as_object).unwrap_or(&empty);
    let mut rules = BTreeMap::new();
    for c in CATEGORIES {
        let mut v = default_rule(c);
        if let Some(x) = src.get(c) {
            match x.as_str().and_then(Verdict::parse) {
                Some(p) => v = p,
                None => warnings.push(format!("permissions.{c} 必須是 allow／deny／ask，收到 {x}，改用預設 {}", default_rule(c).name())),
            }
        }
        rules.insert(c, v);
    }
    for k in src.keys() {
        if !CATEGORIES.contains(&k.as_str()) && k != "allow_dirs" && k != "write_dirs" {
            warnings.push(format!("permissions.{k} 不認得，已忽略"));
        }
    }
    let listed: Vec<&Value> = src.get("allow_dirs").and_then(Value::as_array).map(|a| a.iter().collect()).unwrap_or_default();
    let mut dirs: Vec<PathBuf> = if listed.is_empty() { vec![cwd.to_path_buf()] } else { listed.iter().filter_map(|d| d.as_str()).filter(|s| !s.trim().is_empty()).map(|s| resolve(cwd, s)).collect() };
    if dirs.is_empty() {
        dirs.push(cwd.to_path_buf());
    }
    let write_dirs = match src.get("write_dirs") {
        None => None,
        Some(v) => match v.as_array() {
            Some(a) => {
                let w: Vec<PathBuf> = a.iter().filter_map(|d| d.as_str()).filter(|s| !s.trim().is_empty()).map(|s| resolve(cwd, s)).collect();
                if w.is_empty() {
                    warnings.push("permissions.write_dirs 是空的，寫入一律拒絕".into());
                }
                Some(w)
            }
            None => {
                // 設錯了不能放大權限：型別不對就當空清單，寫入一律拒絕
                warnings.push("permissions.write_dirs 必須是資料夾陣列，寫入一律拒絕".into());
                Some(Vec::new())
            }
        },
    };
    (Permissions { rules, allow_dirs: dirs, write_dirs, sensitive: None }, warnings)
}

fn norm(p: &Path) -> String {
    let s = p.to_string_lossy().replace('\\', "/");
    if cfg!(windows) { s.to_lowercase() } else { s }
}

pub fn inside_dirs(p: &str, dirs: &[PathBuf], base: &Path) -> bool {
    let abs = norm(&resolve(base, p));
    dirs.iter().any(|d| {
        let nd = norm(d);
        let nd = nd.trim_end_matches('/');
        abs == nd || abs.starts_with(&format!("{nd}/"))
    })
}

#[derive(Clone, Debug, Default)]
pub struct Req {
    pub category: String,
    pub paths: Vec<String>,
    pub summary: String,
    /// 工具名（agy）或請求種類（ACP），只用來寫 log
    pub tool: String,
    /// 讀取類才用：單檔、列舉或遞迴搜尋
    pub read_tool: ReadTool,
}

/// 讀取沒有帶路徑時的提醒（寫進 log 的原因文字）
pub const NO_READ_PATH_NOTE: &str = "讀取請求沒有可辨識的路徑，無法檢查敏感位置";

/// 讀取請求逐一判定：回傳（擋下的原因）。沒有敏感位置清單（None）或沒有路徑時不擋
pub fn read_block_reason(roots: &SensitiveRoots, req: &Req, base: &Path) -> Option<(ReadVerdict, String)> {
    let ctx = ReadCtx { roots, base, tool: req.read_tool };
    req.paths.iter().find_map(|p| match read_verdict(p, &ctx) {
        ReadVerdict::Allow => None,
        ReadVerdict::Sensitive => Some((ReadVerdict::Sensitive, format!("這個位置不能讀（登入資料、金鑰或設定）：{}", redact(p)))),
        ReadVerdict::Unresolvable => Some((ReadVerdict::Unresolvable, format!("路徑無法解析，偏向不讀：{}", redact(p)))),
    })
}

/// 回傳（決定, 原因）。內部控制一律放行；寫入有路徑在白名單外就拒絕；讀取不看白名單資料夾，只擋敏感位置（#2356）
pub fn decide(policy: &Permissions, req: &Req, base: &Path) -> (Verdict, String) {
    if req.category == "internal" {
        return (Verdict::Allow, "內部控制".into());
    }
    let rule = policy.rule(&req.category);
    if req.category == "read" {
        if let Some(roots) = &policy.sensitive {
            if req.paths.is_empty() {
                return (rule, format!("{}的政策是 {}（{NO_READ_PATH_NOTE}）", category_label(&req.category), rule.name()));
            }
            if let Some((_, why)) = read_block_reason(roots, req, base) {
                return (Verdict::Deny, why);
            }
        }
    }
    if req.category == "write" {
        if let Some(out) = req.paths.iter().find(|p| !inside_dirs(p, &policy.allow_dirs, base)) {
            return (Verdict::Deny, format!("路徑在白名單資料夾之外：{}", redact(out)));
        }
        if let Some(wd) = &policy.write_dirs {
            if req.paths.is_empty() {
                return (Verdict::Deny, "有設可寫入的資料夾，但這次寫入沒有帶路徑，拒絕".into());
            }
            if let Some(out) = req.paths.iter().find(|p| !inside_dirs(p, wd, base)) {
                return (Verdict::Deny, format!("路徑不在可寫入的資料夾裡：{}", redact(out)));
            }
        }
    }
    (rule, format!("{}的政策是 {}", category_label(&req.category), rule.name()))
}

// ---- agy 自己各段對話的資料夾（#608、#2351）----

/// agy 用的使用者資料夾：它的環境裡的 USERPROFILE，再來 HOME，都沒有就用這台電腦的
pub fn agy_user_home(env: &[(String, String)]) -> PathBuf {
    let get = |n: &str| env.iter().find(|(k, v)| k.eq_ignore_ascii_case(n) && !v.trim().is_empty()).map(|(_, v)| PathBuf::from(v));
    get("USERPROFILE").or_else(|| get("HOME")).unwrap_or_else(crate::identity::home_dir)
}

/// agy 存各段對話資料夾的地方：`<家>/.gemini/antigravity-cli/brain`
pub fn agy_brain(user_home: &Path) -> PathBuf {
    user_home.join(".gemini").join("antigravity-cli").join("brain")
}

/// 對話編號長得像編號（英數與 -、_，最多 100 字）才算，免得拼出 `..` 之類跑到別處
pub fn valid_conv_id(sid: &str) -> bool {
    !sid.is_empty() && sid.len() <= 100 && sid.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// 解析成實際位置：最深一層存在的上層用 canonicalize 解開捷徑與 junction，還不存在的部分接在後面（resolve 已去掉 `.`、`..`）
pub fn real_path(base: &Path, p: &str) -> Option<PathBuf> {
    let abs = resolve(base, p);
    let mut cur = abs.as_path();
    let mut rest: Vec<&std::ffi::OsStr> = vec![];
    loop {
        if let Ok(c) = std::fs::canonicalize(cur) {
            let mut out = c;
            for r in rest.iter().rev() {
                out.push(r);
            }
            return Some(out);
        }
        rest.push(cur.file_name()?);
        cur = cur.parent()?;
    }
}

/// 寫入的路徑解析成實際位置後，是不是都在 brain 底下「某一段對話的資料夾」裡的檔：`brain/<合法編號>/<檔>`（含 scratch）。
/// 為什麼不只限 scratch、也不只限目前這段：agy 會把分析檔寫在對話資料夾本身，換班或重開後的新一段也要能改舊段寫的文件。
/// 不算：直接寫在 `brain/` 底下的檔、對話資料夾本身、任一段的 `.system_generated/`（agy 自己的內部資料）、brain 以外的地方。
/// brain 一定要已經存在；路徑先解開捷徑與 junction 再比，所以經捷徑跳出 brain（或跳進 `.system_generated`）的一律不算
pub fn inside_agy_conv_dir(paths: &[String], brain: &Path, base: &Path) -> bool {
    let Ok(real_brain) = std::fs::canonicalize(brain) else { return false };
    let root = norm(&real_brain);
    let prefix = format!("{}/", root.trim_end_matches('/'));
    !paths.is_empty()
        && paths.iter().all(|p| {
            let Some(r) = real_path(base, p) else { return false };
            let n = norm(&r);
            let Some(rest) = n.strip_prefix(&prefix) else { return false };
            let mut parts = rest.split('/');
            let (Some(id), Some(first)) = (parts.next(), parts.next()) else { return false };
            // Windows 會吃掉名字尾巴的點與空白（`.system_generated.` 開到同一個資料夾），先去掉再比
            let first = first.trim_end_matches(['.', ' ']);
            valid_conv_id(id) && !first.is_empty() && !first.eq_ignore_ascii_case(".system_generated")
        })
}

/// 使用者資料夾底下放登入資料、金鑰、對話記錄的地方：寫到這些地方算真的越權，整輪中止，不給它換位置再試（#608）。
/// 清單（SENSITIVE_HOME_DIRS）與讀取共用，只定義在 acp_sensitive.rs
pub fn sensitive_write(paths: &[String], user_home: &Path, base: &Path) -> bool {
    let real_home = std::fs::canonicalize(user_home).unwrap_or_else(|_| user_home.to_path_buf());
    paths.iter().any(|p| {
        // 實際位置與字面位置都比：路徑或使用者資料夾本身都可能經過捷徑
        let mut cands = vec![resolve(base, p)];
        cands.extend(real_path(base, p));
        cands.iter().any(|c| {
            let r = norm(c);
            let r = r.trim_start_matches("//?/");
            SENSITIVE_HOME_DIRS.iter().any(|d| {
                [real_home.as_path(), user_home].iter().any(|h| {
                    let h = norm(&h.join(d));
                    let h = h.trim_start_matches("//?/").trim_end_matches('/').to_string();
                    r == h || r.starts_with(&format!("{h}/"))
                })
            })
        })
    })
}

// ---- 摘要（要寄給人看的，不含機密）----

const MASK: &str = "［已遮蔽］";

/// 共用的遮蔽規則（Node 端 acp-policy.mjs 用同一份）：依序套用，每一步都是子字串比對。
/// 值的寫法：整段引號、或到空白／引號／& # , ; ) 為止。
fn redact_rules() -> &'static [(regex::Regex, &'static str)] {
    static RULES: std::sync::OnceLock<Vec<(regex::Regex, &'static str)>> = std::sync::OnceLock::new();
    RULES.get_or_init(|| {
        let val = r#"(?:"[^"]*"|'[^']*'|[^\s"'&#,;)]+)"#;
        let list: Vec<(String, &'static str)> = vec![
            // 網址的 帳號:密碼@
            (r"(?i)(^|[^a-z0-9+.-])([a-z][a-z0-9+.-]{0,19}://)[^/\s:@]*:[^/\s@]*@".into(), "${1}${2}［已遮蔽］@"),
            // Authorization 標頭（含 Bearer／Basic）：整段只遮一次
            (format!(r#"(?i)(authorization["']?[ \t]*[=:][ \t]*)(?:(?:bearer|basic)[ \t]+)?{val}"#), "${1}［已遮蔽］"),
            // 單獨出現的 Bearer 憑證
            (r#"(?i)(?-u:\b)bearer[ \t]+[^\s"'`]+"#.into(), "［已遮蔽］"),
            // key=value／key: value（token、secret、password…，含查詢字串與 JSON 寫法）
            (format!(r#"(?i)((?:(?:api[_-]?key|token|secret|password|passwd|passphrase|credential|signature)[A-Za-z0-9_-]{{0,40}}["']?[ \t]*[=:]|key["']?[ \t]*=)[ \t]*){val}"#), "${1}［已遮蔽］"),
            // 金鑰樣字串（前面不能緊接英數字，避免誤遮一般詞的尾巴）
            (r"(?i)(^|[^A-Za-z0-9])(?:sk-[A-Za-z0-9_-]{12,}|AIza[0-9A-Za-z_-]{20,}|gh[pousr]_[A-Za-z0-9_-]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|eyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})".into(), "${1}［已遮蔽］"),
        ];
        list.into_iter().map(|(p, r)| (regex::Regex::new(&p).expect("遮蔽規則"), r)).collect()
    })
}

/// 遮蔽看起來像金鑰的字串（API 金鑰、Authorization／Bearer 憑證、網址帳密、key=value 形式的 token／secret／password）。
/// 只換掉機密本身，其餘文字（含空白）原樣保留；重複套用結果不變
pub fn redact(s: &str) -> String {
    let mut t = std::borrow::Cow::Borrowed(s);
    for (re, rep) in redact_rules() {
        if let std::borrow::Cow::Owned(n) = re.replace_all(&t, *rep) {
            t = std::borrow::Cow::Owned(n);
        }
    }
    t.into_owned()
}

fn clip(s: &str, n: usize) -> String {
    let t = redact(s);
    let t = t.split_whitespace().collect::<Vec<_>>().join(" ");
    if t.chars().count() > n { format!("{}…", t.chars().take(n).collect::<String>()) } else { t.to_string() }
}

fn uniq(v: Vec<String>) -> Vec<String> {
    let mut out: Vec<String> = vec![];
    for x in v {
        if !out.contains(&x) {
            out.push(x);
        }
    }
    out
}

/// ACP session/request_permission 的 params → 請求摘要
pub fn describe_acp_request(params: &Value) -> Req {
    let tc = params.get("toolCall").cloned().unwrap_or(Value::Null);
    let category = category_of_acp_kind(tc.get("kind").and_then(Value::as_str).unwrap_or(""));
    let mut paths: Vec<String> = tc.get("locations").and_then(Value::as_array).into_iter().flatten().filter_map(|l| l.get("path").and_then(Value::as_str)).map(String::from).collect();
    for k in ["path", "file_path", "filePath"] {
        if let Some(p) = tc.pointer(&format!("/rawInput/{k}")).and_then(Value::as_str) {
            paths.push(p.to_string());
        }
    }
    // 讀取：參數裡所有像路徑的字串（含陣列、巢狀）都要逐一判定，不只認固定幾個欄位
    if category == "read" {
        if let Some(raw) = tc.get("rawInput") {
            paths.extend(extract_read_paths(raw));
        }
    }
    paths.retain(|p| !p.is_empty());
    let cmd = match tc.pointer("/rawInput/command") {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Array(a)) => a.iter().filter_map(Value::as_str).collect::<Vec<_>>().join(" "),
        _ => String::new(),
    };
    let title = tc.get("title").and_then(Value::as_str).unwrap_or("");
    let paths = uniq(paths);
    let what = if !cmd.is_empty() {
        format!("指令：{}", clip(&cmd, 160))
    } else if let Some(p) = paths.first() {
        format!("檔案：{}", clip(p, 160))
    } else if !title.is_empty() {
        clip(title, 160)
    } else {
        "（沒有說明）".into()
    };
    let kind = tc.get("kind").and_then(Value::as_str).unwrap_or("");
    Req { category: category.into(), paths, summary: format!("{}：{what}", category_label(category)), tool: kind.into(), read_tool: ReadTool::of_acp_kind(kind) }
}

/// agy tool_info.parameters → 路徑與摘要
pub fn describe_agy_tool(tool_name: &str, parameters: Option<&Value>) -> Req {
    let category = category_of_agy_tool(tool_name);
    let empty = serde_json::Map::new();
    let p = parameters.and_then(Value::as_object).unwrap_or(&empty);
    let mut paths: Vec<String> = p
        .iter()
        .filter(|(k, v)| {
            let l = k.to_lowercase();
            ["path", "file", "dir", "target"].iter().any(|w| l.contains(w)) && v.as_str().map(|s| !s.is_empty()).unwrap_or(false)
        })
        .filter_map(|(_, v)| v.as_str().map(String::from))
        .collect();
    // 讀取：所有字串值（含陣列、巢狀）裡像路徑的都要逐一判定
    if category == "read" {
        if let Some(v) = parameters {
            paths.extend(extract_read_paths(v));
        }
    }
    let paths = uniq(paths);
    let cmd = p.get("CommandLine").or_else(|| p.get("command")).and_then(Value::as_str).unwrap_or("");
    let what = if !cmd.is_empty() {
        format!("指令：{}", clip(cmd, 160))
    } else if let Some(x) = paths.first() {
        format!("檔案：{}", clip(x, 160))
    } else {
        clip(tool_name, 60)
    };
    Req { category: category.into(), paths, summary: format!("{}：{what}", category_label(category)), tool: tool_name.into(), read_tool: ReadTool::of_agy(&tool_name.to_lowercase()) }
}

// ---- 錯誤分類 ----

fn has_word(t: &str, w: &str) -> bool {
    let b = t.as_bytes();
    let mut from = 0;
    while let Some(i) = t[from..].find(w) {
        let s = from + i;
        let e = s + w.len();
        let before = s == 0 || !b[s - 1].is_ascii_alphanumeric();
        let after = e >= b.len() || !b[e].is_ascii_alphanumeric();
        if before && after {
            return true;
        }
        from = s + 1;
        while from < t.len() && !t.is_char_boundary(from) {
            from += 1;
        }
    }
    false
}

/// 引擎回報的錯誤字串分成「沒登入」「額度用完」兩類。先判額度：「Quota exceeded… check your plan and billing」不該被當成登入問題
pub fn classify_failure(text: &str) -> Option<&'static str> {
    let t = text.to_lowercase();
    let squeezed = t.split_whitespace().collect::<Vec<_>>().join(" ");
    let quota = squeezed.contains("quota")
        || ["rate limit", "rate-limit", "ratelimit", "rate_limit"].iter().any(|k| squeezed.contains(k))
        || squeezed.contains("resource_exhausted")
        || squeezed.contains("resource exhausted")
        || squeezed.contains("too many requests")
        || has_word(&squeezed, "429")
        || squeezed.contains("usage limit")
        || squeezed.contains("limit exceeded")
        || squeezed.contains("exceeded your")
        || squeezed.contains("out of credits")
        || squeezed.contains("額度");
    if quota {
        return Some("quota");
    }
    let auth = ["not logged in", "not loggedin", "not signed in", "not signedin", "authenticat", "unauthori", "oauth", "invalid_grant", "invalid grant", "請登入", "尚未登入", "登入失效"].iter().any(|k| squeezed.contains(k))
        || ["login", "log in", "sign in", "credential", "credentials"].iter().any(|k| {
            let mut from = 0;
            while let Some(i) = squeezed[from..].find(k) {
                let e = from + i + k.len();
                if e >= squeezed.len() || !squeezed.as_bytes()[e].is_ascii_alphanumeric() {
                    return true;
                }
                from = from + i + 1;
            }
            false
        })
        || squeezed.contains("auth required")
        || squeezed.contains("authorization required")
        || ["token expired", "token has expired", "token invalid", "token has invalid"].iter().any(|k| squeezed.contains(k))
        || has_word(&squeezed, "401");
    if auth {
        return Some("auth");
    }
    None
}

/// 引擎回報的錯誤是不是「網路暫時斷了」（連線被中斷、被重設、DNS／TLS 失敗）。這類通常幾秒後就好，值得自動再試一次；
/// 登入、額度已經先分過類，這裡不會誤判它們（先判 [`classify_failure`]）。只認明確的網路字眼，認不出來的當一般錯誤
pub fn is_network_error(text: &str) -> bool {
    if classify_failure(text).is_some() {
        return false;
    }
    let t = text.to_lowercase();
    let t = t.split_whitespace().collect::<Vec<_>>().join(" ");
    [
        "wsarecv",
        "wsasend",
        "connection reset",
        "connection refused",
        "connection aborted",
        "connection closed",
        "a connection attempt failed",
        "an existing connection was forcibly closed",
        "broken pipe",
        "econnreset",
        "econnaborted",
        "etimedout",
        "i/o timeout",
        "no such host",
        "tls handshake",
        "unexpected eof",
        "dial tcp",
        "network is unreachable",
        "temporary failure in name resolution",
    ]
    .iter()
    .any(|k| t.contains(k))
}

/// 上游回了 5xx 加一整頁 HTML 錯誤頁（#1366、#1673）：兩個特徵都要有才算，回那個狀態碼。
/// 只看 502 這個數字會誤認（例如內容剛好提到 502）。真實的前綴：`API error (attempt 1): request failed (code 502): HTML response`。
/// 這類是上游暫時出錯，值得自動再試一次（見 acp_worker）；逾時、內容過濾、驗證錯誤都不是
pub fn upstream_5xx(why: &str) -> Option<u16> {
    if !why.to_lowercase().contains("html response") {
        return None;
    }
    why.match_indices("(code ").find_map(|(i, m)| {
        let digits: String = why[i + m.len()..].chars().take(4).collect();
        let (code, rest) = digits.split_at(digits.char_indices().nth(3).map(|(j, _)| j).unwrap_or(digits.len()));
        (code.len() == 3 && code.starts_with('5') && code.bytes().all(|b| b.is_ascii_digit()) && rest.starts_with(')')).then(|| code.parse().ok()).flatten()
    })
}

/// 帶分類的錯誤。code：auth／quota／timeout／crash／violation／agent／stopped
#[derive(Clone, Debug)]
pub struct WorkerError {
    pub code: &'static str,
    pub message: String,
    pub spawn_failed: bool,
    pub summary: Option<String>,
    /// 這一輪失敗前已經有工具步驟（跑過指令、改過檔…）：不能把整封信重送，會做第二次
    pub had_steps: bool,
    /// 寫到不能寫的位置、但不是敏感位置（#608）：帶那個路徑，上層接回同一段對話請它改寫到工作資料夾，一輪最多一次
    pub redirect: Option<String>,
}
impl WorkerError {
    pub fn new(code: &'static str, message: impl Into<String>) -> WorkerError {
        WorkerError { code, message: message.into(), spawn_failed: false, summary: None, had_steps: false, redirect: None }
    }
    /// 依錯誤文字分類（沒登入／額度），分不出來用 fallback 代碼
    pub fn classify(text: &str, fallback: &'static str, message: impl Into<String>) -> WorkerError {
        WorkerError::new(classify_failure(text).unwrap_or(fallback), message)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn 網路斷線判斷_只認明確的網路字眼_登入額度不算() {
        assert!(is_network_error(r#"API error (attempt 1): request failed: Post "https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse": read tcp 192.168.0.101:57534->172.217.113.4:443: wsarecv: A connection attempt failed"#));
        assert!(is_network_error("read tcp 1.2.3.4:5->6.7.8.9:443: wsarecv: An existing connection was forcibly closed by the remote host."));
        assert!(is_network_error("dial tcp: lookup example.com: no such host"));
        assert!(!is_network_error("UNAUTHENTICATED (code 401): Request had invalid authentication credentials"));
        assert!(!is_network_error("RESOURCE_EXHAUSTED: quota exceeded for this account"));
        assert!(!is_network_error("fatal: boom"));
        assert!(!is_network_error(""));
    }

    #[test]
    fn guard_1685_上游5xx只認_括號code5xx_加_HTML_response_兩個特徵都有() {
        assert_eq!(upstream_5xx("API error (attempt 1): request failed (code 502): HTML response"), Some(502));
        assert_eq!(upstream_5xx("API error (attempt 3): request failed (code 503): html response"), Some(503));
        assert_eq!(upstream_5xx("request failed (code 502)"), None, "沒有 HTML response");
        assert_eq!(upstream_5xx("HTML response (code 404)"), None, "不是 5xx");
        assert_eq!(upstream_5xx("內容提到 502 與 HTML response"), None);
        assert_eq!(upstream_5xx("UNAUTHENTICATED (code 401): HTML response"), None);
        assert_eq!(upstream_5xx(""), None);
        assert!(!is_network_error("API error (attempt 1): request failed (code 502): HTML response"), "502 不是網路斷線，兩種各自判斷");
    }

    #[test]
    fn 類別對照() {
        assert_eq!(category_of_acp_kind("edit"), "write");
        assert_eq!(category_of_acp_kind("Search"), "read");
        assert_eq!(category_of_acp_kind("fetch"), "network");
        assert_eq!(category_of_acp_kind("xyz"), "other");
        assert_eq!(category_of_agy_tool("write_to_file"), "write");
        assert_eq!(category_of_agy_tool("run_command"), "execute");
        assert_eq!(category_of_agy_tool("browser_click"), "network");
        assert_eq!(category_of_agy_tool("totally_new_tool"), "internal");
        assert_eq!(category_of_agy_tool("make_patch_x"), "write");
    }

    #[test]
    fn agy_工具分類_實機看到的名字與登記表() {
        for (n, c) in [
            ("read_file", "read"),
            ("write_file", "write"),
            ("edit_file", "write"),
            ("run_command", "execute"),
            ("run_workflow", "execute"),
            ("swarm", "execute"),
            ("invoke_subagent", "execute"),
            ("define_subagent", "execute"),
            ("manage_subagents", "execute"),
            ("send_message", "execute"),
            ("schedule", "execute"),
            ("search_web", "network"),
            ("manage_task", "internal"),
            ("update_steps", "internal"),
            ("ask_question", "internal"),
            ("READ_FILE", "read"),
        ] {
            assert_eq!(category_of_agy_tool(n), c, "{n}");
            assert!(is_registered_agy_tool(n), "{n} 要在登記表裡");
        }
        for n in ["totally_new_tool", "", "make_patch_x", "browser_click"] {
            assert!(!is_registered_agy_tool(n), "{n:?} 沒登記");
        }
    }

    #[test]
    fn 敏感讀取_決定_讀取不看白名單資料夾_只擋敏感位置() {
        let d = tempfile::tempdir().unwrap();
        let (home, work) = (d.path().join("home"), d.path().join("work"));
        std::fs::create_dir_all(&home).unwrap();
        std::fs::create_dir_all(&work).unwrap();
        let (mut p, _) = normalize_permissions(None, &work);
        p.sensitive = Some(Arc::new(SensitiveRoots::build(&[home.clone()], &[])));
        let rd = |path: &Path| Req { category: "read".into(), paths: vec![s(path)], ..Default::default() };
        // 資料夾外的一般檔可以讀，寫入範圍不變
        assert_eq!(decide(&p, &rd(&home.join("Desktop").join("a.txt")), &work).0, Verdict::Allow);
        assert_eq!(decide(&p, &rd(&d.path().join("elsewhere.txt")), &work).0, Verdict::Allow);
        let wr = |path: &Path| Req { category: "write".into(), paths: vec![s(path)], ..Default::default() };
        assert_eq!(decide(&p, &wr(&home.join("Desktop").join("a.txt")), &work).0, Verdict::Deny);
        assert_eq!(decide(&p, &wr(&work.join("a.txt")), &work).0, Verdict::Allow);
        // 敏感位置擋，原因不含內部代號
        let (v, why) = decide(&p, &rd(&home.join(".ssh").join("id")), &work);
        assert_eq!(v, Verdict::Deny);
        assert!(why.contains("不能讀"), "{why}");
        // 多個路徑只要一個敏感就擋
        let mut two = rd(&work.join("a.txt"));
        two.paths.push(s(&home.join(".aws").join("credentials")));
        assert_eq!(decide(&p, &two, &work).0, Verdict::Deny);
        // 沒帶路徑：照規則放行，原因講明沒有可辨識的路徑
        let none = Req { category: "read".into(), ..Default::default() };
        let (v, why) = decide(&p, &none, &work);
        assert_eq!(v, Verdict::Allow);
        assert!(why.contains(NO_READ_PATH_NOTE), "{why}");
        // 遞迴搜尋對上層資料夾要擋，列舉放行
        let mut up = rd(&home);
        up.read_tool = ReadTool::Recursive;
        assert_eq!(decide(&p, &up, &work).0, Verdict::Deny);
        up.read_tool = ReadTool::List;
        assert_eq!(decide(&p, &up, &work).0, Verdict::Allow);
        // 讀取規則本身仍照政策（deny 就是 deny）
        let (mut p2, _) = normalize_permissions(Some(&json!({"read": "deny"})), &work);
        p2.sensitive = p.sensitive.clone();
        assert_eq!(decide(&p2, &rd(&work.join("a.txt")), &work).0, Verdict::Deny);
    }

    #[test]
    fn 敏感讀取_請求描述_取出所有像路徑的字串與讀取類別() {
        let g = describe_agy_tool("read_file", Some(&json!({"Path": "C:\\fake\\a.txt", "Extra": ["~/b.txt"]})));
        assert_eq!((g.category.as_str(), g.tool.as_str(), g.read_tool), ("read", "read_file", ReadTool::Single));
        assert!(g.paths.contains(&"C:\\fake\\a.txt".to_string()) && g.paths.contains(&"~/b.txt".to_string()), "{:?}", g.paths);
        assert_eq!(describe_agy_tool("grep_search", Some(&json!({"SearchPath": "/x"}))).read_tool, ReadTool::Recursive);
        assert_eq!(describe_agy_tool("list_dir", Some(&json!({"DirectoryPath": "/x"}))).read_tool, ReadTool::List);
        // 寫入類不多抽路徑（寫入範圍不變）
        let w = describe_agy_tool("write_file", Some(&json!({"TargetFile": "/w/a", "Note": "/other/b"})));
        assert_eq!(w.paths, vec!["/w/a".to_string()]);
        let a = describe_acp_request(&json!({"toolCall": {"kind": "search", "rawInput": {"roots": ["/a", "/b"], "pattern": "x"}}}));
        assert_eq!((a.category.as_str(), a.read_tool), ("read", ReadTool::Recursive));
        assert!(a.paths.contains(&"/a".to_string()) && a.paths.contains(&"/b".to_string()), "{:?}", a.paths);
        let e = describe_acp_request(&json!({"toolCall": {"kind": "edit", "rawInput": {"roots": ["/a"]}}}));
        assert!(e.paths.is_empty(), "寫入類只認原本的欄位");
    }

    #[test]
    fn 預設政策_開放_讀取不限資料夾_寫入限白名單() {
        let cwd = Path::new("/w/Gemini");
        let (p, warn) = normalize_permissions(None, cwd);
        assert!(warn.is_empty());
        let req = |c: &str, paths: &[&str]| Req { category: c.into(), paths: paths.iter().map(|s| s.to_string()).collect(), ..Default::default() };
        assert_eq!(decide(&p, &req("read", &["/w/Gemini/a.txt"]), cwd).0, Verdict::Allow);
        assert_eq!(decide(&p, &req("read", &["/etc/passwd"]), cwd).0, Verdict::Allow, "讀取不再受白名單資料夾限制");
        assert_eq!(decide(&p, &req("read", &["/w/Gemini/../x"]), cwd).0, Verdict::Allow);
        assert_eq!(decide(&p, &req("write", &["/w/Gemini/a.txt"]), cwd).0, Verdict::Allow);
        assert_eq!(decide(&p, &req("write", &["/etc/x"]), cwd).0, Verdict::Deny, "預設開放仍擋資料夾外的寫入");
        assert_eq!(decide(&p, &req("write", &["/w/Gemini/../x"]), cwd).0, Verdict::Deny);
        assert_eq!(decide(&p, &req("execute", &[]), cwd).0, Verdict::Allow);
        assert_eq!(decide(&p, &req("network", &[]), cwd).0, Verdict::Allow);
        assert_eq!(decide(&p, &req("internal", &[]), cwd).0, Verdict::Allow);
        assert_eq!(decide(&p, &req("other", &[]), cwd).0, Verdict::Deny);
    }

    #[test]
    fn write_dirs_只收窄寫入_讀取不受影響() {
        let cwd = Path::new("/w/Review");
        let raw = json!({"write": "allow", "allow_dirs": ["/w/Review"], "write_dirs": ["/w/Review/_preview"]});
        let (p, warn) = normalize_permissions(Some(&raw), cwd);
        assert!(warn.is_empty());
        let req = |c: &str, paths: &[&str]| Req { category: c.into(), paths: paths.iter().map(|s| s.to_string()).collect(), ..Default::default() };
        assert_eq!(decide(&p, &req("write", &["/w/Review/_preview/a.html"]), cwd).0, Verdict::Allow);
        assert_eq!(decide(&p, &req("write", &["/w/Review/_patches/x.diff"]), cwd).0, Verdict::Deny, "_patches 不在可寫資料夾");
        assert_eq!(decide(&p, &req("write", &["/w/Review/_preview/../_patches/x"]), cwd).0, Verdict::Deny, ".. 逃出可寫資料夾");
        assert_eq!(decide(&p, &req("write", &["/w/Review/_preview/a", "/w/Review/b"]), cwd).0, Verdict::Deny, "多個路徑只要一個在外面就拒絕");
        assert_eq!(decide(&p, &req("read", &["/w/Review/_patches/x.diff"]), cwd).0, Verdict::Allow, "讀不受 write_dirs 影響");
        assert_eq!(decide(&p, &req("read", &["/etc/passwd"]), cwd).0, Verdict::Allow, "讀取不看 allow_dirs");
        // write_dirs 設在 allow_dirs 外面也寫不進去（兩層都要過）
        let raw2 = json!({"write": "allow", "allow_dirs": ["/w/Review"], "write_dirs": ["/elsewhere"]});
        let (p2, _) = normalize_permissions(Some(&raw2), cwd);
        assert_eq!(decide(&p2, &req("write", &["/elsewhere/x"]), cwd).0, Verdict::Deny);
        // 空陣列＝全部拒絕並提醒；壞型別＝忽略並提醒；沒設＝行為不變
        let (p3, w3) = normalize_permissions(Some(&json!({"write": "allow", "write_dirs": []})), cwd);
        assert_eq!(w3.len(), 1);
        assert_eq!(decide(&p3, &req("write", &["/w/Review/a"]), cwd).0, Verdict::Deny);
        let (p4, w4) = normalize_permissions(Some(&json!({"write": "allow", "write_dirs": "oops"})), cwd);
        assert_eq!(w4.len(), 1);
        assert_eq!(decide(&p4, &req("write", &["/w/Review/a"]), cwd).0, Verdict::Deny, "壞型別不能放大權限：寫入一律拒絕");
        // 有設 write_dirs 時，沒帶路徑的寫入不能跳過檢查
        assert_eq!(decide(&p, &req("write", &[]), cwd).0, Verdict::Deny);
        // 沒設 write_dirs：行為不變（沒帶路徑照規則）
        let (p5, _) = normalize_permissions(Some(&json!({"write": "allow"})), cwd);
        assert_eq!(decide(&p5, &req("write", &[]), cwd).0, Verdict::Allow);
    }

    #[test]
    fn 自訂政策_壞值被忽略並提醒() {
        let cwd = Path::new("/w/G");
        let raw = json!({"write": "ask", "execute": "maybe", "weird": 1, "allow_dirs": ["/w/G", "/shared"]});
        let (p, warn) = normalize_permissions(Some(&raw), cwd);
        assert_eq!(p.rule("write"), Verdict::Ask);
        assert_eq!(p.rule("execute"), Verdict::Allow);
        assert_eq!(warn.len(), 2);
        assert_eq!(decide(&p, &Req { category: "write".into(), paths: vec!["/shared/x".into()], ..Default::default() }, cwd).0, Verdict::Ask);
    }

    // 遮蔽規則的共用表格：Node 端（relay/machine/test/acp-policy.test.mjs）讀同一份檔
    #[test]
    fn 遮蔽規則_共用表格() {
        let table: Value = serde_json::from_str(include_str!("../../../../../machine/test/redact-cases.json")).unwrap();
        let cases = table["cases"].as_array().unwrap();
        assert!(cases.len() > 20);
        for c in cases {
            let input = c["in"].as_str().unwrap().replace("{M}", MASK);
            let want = c["out"].as_str().unwrap().replace("{M}", MASK);
            let name = c["name"].as_str().unwrap();
            assert_eq!(redact(&input), want, "{name}");
            assert_eq!(redact(&redact(&input)), want, "{name}（重複遮蔽不疊加）");
        }
    }

    #[test]
    fn 遮蔽規則_超長字串() {
        let long = "x".repeat(100_000);
        assert_eq!(redact(&long), long);
        let mid = format!("{}sk-FAKExxxxxxxxxxxx{}", "ab ".repeat(5000), " cd".repeat(5000));
        assert_eq!(redact(&mid), format!("{}{MASK}{}", "ab ".repeat(5000), " cd".repeat(5000)));
    }

    #[test]
    fn 顯示面_路徑裡的機密樣字串不進摘要與拒絕原因_判斷用的路徑維持原值() {
        let bad = "/other/sk-FAKExxxxxxxxxxxx/a.txt";
        let cwd = Path::new("/w/Review");
        let (p, _) = normalize_permissions(None, cwd);
        let d = describe_acp_request(&json!({"toolCall": {"kind": "edit", "locations": [{"path": bad}]}}));
        assert_eq!(d.paths, vec![bad.to_string()]);
        assert!(!d.summary.contains("FAKE"), "{}", d.summary);
        let g = describe_agy_tool("write_to_file", Some(&json!({"TargetFile": bad})));
        assert_eq!(g.paths, vec![bad.to_string()]);
        assert!(!g.summary.contains("FAKE"), "{}", g.summary);
        let (v, reason) = decide(&p, &d, cwd);
        assert_eq!(v, Verdict::Deny);
        assert!(!reason.contains("FAKE") && reason.contains(MASK), "{reason}");
        let rw = Req { category: "write".into(), paths: vec![bad.to_string()], ..Default::default() };
        let (p2, _) = normalize_permissions(Some(&json!({"allow_dirs": ["/other"], "write_dirs": ["/w/Review"]})), cwd);
        let (_, reason2) = decide(&p2, &rw, cwd);
        assert!(!reason2.contains("FAKE"), "{reason2}");
    }

    #[test]
    fn 摘要不含機密_指令與路徑會截斷() {
        let r = describe_acp_request(&json!({"toolCall": {"kind": "execute", "rawInput": {"command": "curl -H 'Authorization: Bearer abc.def' https://x --token=sk-1234567890abcdef"}}}));
        assert_eq!(r.category, "execute");
        assert!(r.summary.starts_with("執行指令：指令："));
        assert!(!r.summary.contains("abc.def") && !r.summary.contains("sk-1234567890abcdef"), "{}", r.summary);
        let long = "a".repeat(500);
        let r = describe_acp_request(&json!({"toolCall": {"kind": "edit", "locations": [{"path": long}]}}));
        assert!(r.summary.chars().count() < 200);
        assert_eq!(r.category, "write");
        let r = describe_agy_tool("write_to_file", Some(&json!({"TargetFile": "/x/y.txt", "CodeContent": "z"})));
        assert_eq!(r.paths, vec!["/x/y.txt".to_string()]);
        assert!(redact("key AIzaSyA1234567890123456789012 ok").contains("［已遮蔽］"));
        assert_eq!(redact("password=hunter2 done"), "password=［已遮蔽］ done");
    }

    #[test]
    fn 錯誤分類_登入_額度_其他() {
        assert_eq!(classify_failure("Authentication required"), Some("auth"));
        assert_eq!(classify_failure("please login first"), Some("auth"));
        assert_eq!(classify_failure("HTTP 401"), Some("auth"));
        assert_eq!(classify_failure("Quota exceeded for metric, check your plan and billing"), Some("quota"));
        assert_eq!(classify_failure("429 Too Many Requests"), Some("quota"));
        assert_eq!(classify_failure("額度用完了"), Some("quota"));
        assert_eq!(classify_failure("segfault at 0x4010"), None);
        assert_eq!(classify_failure("code 4012 happened"), None);
    }

    fn s(p: &Path) -> String {
        p.display().to_string()
    }

    #[test]
    fn 對話編號空著或不像編號就不合法() {
        for bad in ["", "..", ".", "a/b", r"a\b", "a b", ".system_generated"] {
            assert!(!valid_conv_id(bad), "{bad}");
        }
        assert!(!valid_conv_id(&"a".repeat(101)));
        assert!(valid_conv_id("abc-1_2"));
        let h = Path::new("/u");
        assert_eq!(agy_brain(h), h.join(".gemini").join("antigravity-cli").join("brain"));
    }

    #[test]
    fn agy_user_home_先看它環境的_userprofile_再看_home() {
        let e = |v: &[(&str, &str)]| v.iter().map(|(a, b)| (a.to_string(), b.to_string())).collect::<Vec<_>>();
        assert_eq!(agy_user_home(&e(&[("HOME", "/h"), ("UserProfile", "/p")])), PathBuf::from("/p"));
        assert_eq!(agy_user_home(&e(&[("HOME", "/h"), ("USERPROFILE", " ")])), PathBuf::from("/h"));
    }

    #[test]
    fn inside_agy_conv_dir_任一段對話資料夾裡的檔放行_系統目錄_brain_本身_外面都不算() {
        let d = tempfile::tempdir().unwrap();
        let brain = agy_brain(d.path());
        let base = d.path();
        let c1 = brain.join("c1");
        // brain 還不存在：不放行
        assert!(!inside_agy_conv_dir(&[s(&c1.join("x.md"))], &brain, base));
        std::fs::create_dir_all(c1.join("scratch")).unwrap();
        std::fs::create_dir_all(c1.join(".system_generated")).unwrap();
        std::fs::create_dir_all(brain.join("c2")).unwrap();
        // 對話資料夾裡的檔、scratch 裡的檔、更深的檔
        assert!(inside_agy_conv_dir(&[s(&c1.join("x.md"))], &brain, base));
        assert!(inside_agy_conv_dir(&[s(&c1.join("scratch").join("a.md")), s(&c1.join("sub").join("b.md"))], &brain, base));
        // 別段對話（換班接手後改舊段寫的文件）；還沒建出來的編號也一樣
        assert!(inside_agy_conv_dir(&[s(&brain.join("c2").join("old.md"))], &brain, base));
        assert!(inside_agy_conv_dir(&[s(&brain.join("c3").join("new.md"))], &brain, base));
        assert!(!inside_agy_conv_dir(&[], &brain, base), "沒帶路徑不放行");
        assert!(!inside_agy_conv_dir(&[s(&brain.join("x.md"))], &brain, base), "直接寫在 brain 底下不算");
        assert!(!inside_agy_conv_dir(&[s(&brain)], &brain, base), "brain 本身不算");
        assert!(!inside_agy_conv_dir(&[s(&c1)], &brain, base), "對話資料夾本身不是裡面的檔");
        for sys in [".system_generated", ".SYSTEM_GENERATED", ".system_generated."] {
            assert!(!inside_agy_conv_dir(&[s(&c1.join(sys).join("x"))], &brain, base), "{sys}");
            assert!(!inside_agy_conv_dir(&[s(&brain.join("c2").join(sys).join("x"))], &brain, base), "別段的 {sys}");
        }
        assert!(!inside_agy_conv_dir(&[s(&c1.join("scratch").join("..").join(".system_generated").join("x"))], &brain, base), "用 .. 繞進去");
        assert!(!inside_agy_conv_dir(&[s(&brain.join("a b").join("x.md"))], &brain, base), "編號格式不對");
        assert!(!inside_agy_conv_dir(&[s(&d.path().join(".gemini").join("oauth_creds.json"))], &brain, base), "brain 以外的 .gemini");
        assert!(!inside_agy_conv_dir(&[s(&c1.join("a.md")), s(&d.path().join("x"))], &brain, base), "有一個在外面就不行");
        // 相對路徑以工作資料夾為準，不是 brain
        assert!(!inside_agy_conv_dir(&["a.md".into()], &brain, base));
    }

    #[cfg(windows)]
    fn junction(link: &Path, target: &Path) {
        use crate::home::Ops;
        crate::home::RealOps.make_link(link, target).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn inside_agy_conv_dir_經過_junction_跳出去的不算_對話資料夾本身是_junction_也不算() {
        let d = tempfile::tempdir().unwrap();
        let out = d.path().join("elsewhere");
        std::fs::create_dir_all(&out).unwrap();
        let brain = agy_brain(d.path());
        let c1 = brain.join("c1");
        std::fs::create_dir_all(&c1).unwrap();
        junction(&c1.join("j"), &out);
        assert!(!inside_agy_conv_dir(&[s(&c1.join("j").join("x.txt"))], &brain, d.path()));
        std::fs::write(out.join("e.txt"), "x").unwrap();
        assert!(!inside_agy_conv_dir(&[s(&c1.join("j").join("e.txt"))], &brain, d.path()), "已經存在的檔也一樣");
        // 對話資料夾自己是 junction（指到別處）：不放行
        junction(&brain.join("c2"), &out);
        assert!(!inside_agy_conv_dir(&[s(&brain.join("c2").join("x.txt"))], &brain, d.path()));
        // 對話資料夾裡的 junction 指進別段的 .system_generated：也不放行
        std::fs::create_dir_all(brain.join("c3").join(".system_generated")).unwrap();
        junction(&c1.join("k"), &brain.join("c3").join(".system_generated"));
        assert!(!inside_agy_conv_dir(&[s(&c1.join("k").join("x.txt"))], &brain, d.path()));
        // 對照：正常的對話資料夾放行（證明上面不是因為別的原因失敗）
        assert!(inside_agy_conv_dir(&[s(&c1.join("x.txt"))], &brain, d.path()));
    }

    #[test]
    fn sensitive_write_使用者資料夾底下放登入資料的地方() {
        let d = tempfile::tempdir().unwrap();
        let h = d.path();
        let w = h.join("work");
        for p in [h.join(".gemini").join("oauth_creds.json"), h.join(".gemini").join("antigravity-cli").join("brain").join("c1").join(".system_generated").join("x"), h.join(".ssh").join("id"), h.join(".asn")] {
            assert!(sensitive_write(&[s(&p)], h, &w), "{}", p.display());
        }
        assert!(sensitive_write(&["../.claude/x".into()], h, &w), "相對路徑解開後也算");
        for p in [w.join("a.txt"), h.join("Desktop").join("a.txt"), h.join(".geminiX").join("a")] {
            assert!(!sensitive_write(&[s(&p)], h, &w), "{}", p.display());
        }
    }

    #[cfg(windows)]
    #[test]
    fn sensitive_write_經過_junction_指進去的也算() {
        let d = tempfile::tempdir().unwrap();
        let h = d.path();
        std::fs::create_dir_all(h.join(".gemini")).unwrap();
        junction(&h.join("innocent"), &h.join(".gemini"));
        assert!(sensitive_write(&[s(&h.join("innocent").join("x.json"))], h, h));
    }
}

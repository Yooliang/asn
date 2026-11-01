//! ACP 工作者的權限政策與錯誤分類（純函式，不碰檔案、不碰行程）。對應 engines/acp-policy.mjs、acp-errors.mjs。
//! 政策＝每個「類別」一個決定 allow／deny／ask，外加「白名單資料夾」（有路徑的讀寫請求，路徑在白名單外一律拒絕）。
//!   read 讀檔搜尋思考、write 寫刪搬、execute 執行指令、network 上網（預設都是 allow）；other 分不出類別（預設 deny）。
//!   寫入以白名單資料夾（預設只有工作者自己的工作資料夾）為界；執行指令沒有路徑可查，邊界只靠工作資料夾與 agents.json 的明寫設定。
use serde_json::Value;
use std::collections::BTreeMap;
use std::path::{Component, Path, PathBuf};

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

const AGY_READ: [&str; 6] = ["view_file", "list_dir", "find_by_name", "grep_search", "read_resource", "list_resources"];
const AGY_WRITE: [&str; 5] = ["write_to_file", "replace_file_content", "multi_replace_file_content", "sed_file", "notebook_edit"];
const AGY_EXEC: [&str; 5] = ["run_command", "send_command_input", "command_status", "notebook_execution", "execute_browser_javascript"];
const AGY_NET: [&str; 8] = ["read_url_content", "search_web", "open_browser_url", "read_browser_page", "capture_browser_console_logs", "capture_browser_screenshot", "list_browser_pages", "get_browser_dom"];
const AGY_INTERNAL: &[&str] = &[
    "finish", "wait", "wait_5_seconds", "ask_question", "ask_permission", "ask_custom_permission", "list_permissions", "manage_task", "manage_inbox", "manage_subagents", "define_subagent", "invoke_subagent",
    "send_message", "schedule", "run_workflow", "delete_knowledge", "search_marketplace", "list_plugin_accounts", "call_mcp_tool", "generate_image"
];

/// agy 原生 stream-json 的工具名 → 類別。"internal"＝代理自己的內部控制（規劃、等待、結束…），一律放行。
/// 沒列到的新工具名用關鍵字推測；推測不出來視為 internal
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
    (Permissions { rules, allow_dirs: dirs, write_dirs }, warnings)
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
}

/// 回傳（決定, 原因）。內部控制一律放行；讀寫類請求有路徑在白名單外就拒絕
pub fn decide(policy: &Permissions, req: &Req, base: &Path) -> (Verdict, String) {
    if req.category == "internal" {
        return (Verdict::Allow, "內部控制".into());
    }
    let rule = policy.rule(&req.category);
    if req.category == "read" || req.category == "write" {
        if let Some(out) = req.paths.iter().find(|p| !inside_dirs(p, &policy.allow_dirs, base)) {
            return (Verdict::Deny, format!("路徑在白名單資料夾之外：{out}"));
        }
        if req.category == "write" {
            if let Some(wd) = &policy.write_dirs {
                if req.paths.is_empty() {
                    return (Verdict::Deny, "有設可寫入的資料夾，但這次寫入沒有帶路徑，拒絕".into());
                }
                if let Some(out) = req.paths.iter().find(|p| !inside_dirs(p, wd, base)) {
                    return (Verdict::Deny, format!("路徑不在可寫入的資料夾裡：{out}"));
                }
            }
        }
    }
    (rule, format!("{}的政策是 {}", category_label(&req.category), rule.name()))
}

// ---- agy 自己這段對話的暫存資料夾（#608）----

/// agy 用的使用者資料夾：它的環境裡的 USERPROFILE，再來 HOME，都沒有就用這台電腦的
pub fn agy_user_home(env: &[(String, String)]) -> PathBuf {
    let get = |n: &str| env.iter().find(|(k, v)| k.eq_ignore_ascii_case(n) && !v.trim().is_empty()).map(|(_, v)| PathBuf::from(v));
    get("USERPROFILE").or_else(|| get("HOME")).unwrap_or_else(crate::identity::home_dir)
}

/// 這段對話的 scratch：`<家>/.gemini/antigravity-cli/brain/<對話編號>/scratch`。
/// 對話編號空著或不像編號（只收英數與 -、_）就沒有，免得拼出 `..` 之類跑到別處
pub fn agy_scratch(user_home: &Path, sid: &str) -> Option<PathBuf> {
    if sid.is_empty() || sid.len() > 100 || !sid.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        return None;
    }
    Some(user_home.join(".gemini").join("antigravity-cli").join("brain").join(sid).join("scratch"))
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

/// 寫入的路徑解析成實際位置後，是不是都在這段對話的 scratch 裡。
/// scratch 一定要已經存在，而且它和上面的對話資料夾都不能是捷徑或 junction（實際位置要等於 brain 的實際位置接上 `<編號>/scratch`）
pub fn inside_agy_scratch(paths: &[String], scratch: &Path, base: &Path) -> bool {
    let (Some(sid_dir), Some(brain)) = (scratch.parent(), scratch.parent().and_then(Path::parent)) else { return false };
    let (Ok(real_scratch), Ok(real_brain), Some(sid)) = (std::fs::canonicalize(scratch), std::fs::canonicalize(brain), sid_dir.file_name()) else { return false };
    if norm(&real_scratch) != norm(&real_brain.join(sid).join("scratch")) {
        return false;
    }
    let root = norm(&real_scratch);
    let root = root.trim_end_matches('/');
    !paths.is_empty()
        && paths.iter().all(|p| match real_path(base, p) {
            Some(r) => norm(&r).starts_with(&format!("{root}/")),
            None => false,
        })
}

/// 使用者資料夾底下放登入資料、金鑰、對話記錄的地方：寫到這些地方算真的越權，整輪中止，不給它換位置再試（#608）
const SENSITIVE_HOME_DIRS: [&str; 10] = [".gemini", ".ssh", ".asn", ".irori-relay", ".claude", ".codex", ".pi", ".aws", ".config", ".gnupg"];

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

fn is_secret_key_word(w: &str) -> bool {
    let l = w.to_lowercase();
    ["api_key", "api-key", "apikey", "token", "secret", "password", "passwd", "authorization"].iter().any(|k| l.contains(k))
}

fn looks_secret_token(t: &str) -> bool {
    let long = |p: &str, n: usize| t.starts_with(p) && t.len() >= p.len() + n && t[p.len()..].chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-');
    long("sk-", 12)
        || long("AIza", 20)
        || ["ghp_", "gho_", "ghu_", "ghs_", "ghr_"].iter().any(|p| long(p, 20))
        || (t.starts_with("xox") && t.len() >= 14 && t.chars().nth(3).map(|c| "abprs".contains(c)).unwrap_or(false) && t.chars().nth(4) == Some('-'))
        || (t.starts_with("eyJ") && t.matches('.').count() == 2 && t.len() >= 40)
}

/// 遮蔽看起來像金鑰的字串（API 金鑰、Bearer 憑證、key=value 形式的 token／secret／password）
pub fn redact(s: &str) -> String {
    let words: Vec<&str> = s.split_whitespace().collect();
    let mut out: Vec<String> = vec![];
    let mut mask_next = false;
    for w in words {
        if mask_next {
            out.push("［已遮蔽］".into());
            mask_next = w.eq_ignore_ascii_case("bearer"); // Authorization: Bearer <憑證>：連憑證一起遮
            continue;
        }
        if looks_secret_token(w) {
            out.push("［已遮蔽］".into());
        } else if w.eq_ignore_ascii_case("bearer") {
            out.push(w.into());
            mask_next = true;
        } else if let Some(i) = w.find(['=', ':']).filter(|_| is_secret_key_word(w)) {
            let (k, v) = w.split_at(i + 1);
            if v.is_empty() {
                out.push(w.into());
                mask_next = true;
            } else {
                out.push(format!("{k}［已遮蔽］"));
            }
        } else if is_secret_key_word(w) && w.ends_with(['=', ':']) {
            out.push(w.into());
            mask_next = true;
        } else {
            out.push(w.into());
        }
    }
    out.join(" ")
}

fn clip(s: &str, n: usize) -> String {
    let t = redact(s);
    let t = t.trim();
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
    Req { category: category.into(), paths, summary: format!("{}：{what}", category_label(category)) }
}

/// agy tool_info.parameters → 路徑與摘要
pub fn describe_agy_tool(tool_name: &str, parameters: Option<&Value>) -> Req {
    let category = category_of_agy_tool(tool_name);
    let empty = serde_json::Map::new();
    let p = parameters.and_then(Value::as_object).unwrap_or(&empty);
    let paths: Vec<String> = uniq(
        p.iter()
            .filter(|(k, v)| {
                let l = k.to_lowercase();
                ["path", "file", "dir", "target"].iter().any(|w| l.contains(w)) && v.as_str().map(|s| !s.is_empty()).unwrap_or(false)
            })
            .filter_map(|(_, v)| v.as_str().map(String::from))
            .collect(),
    );
    let cmd = p.get("CommandLine").or_else(|| p.get("command")).and_then(Value::as_str).unwrap_or("");
    let what = if !cmd.is_empty() {
        format!("指令：{}", clip(cmd, 160))
    } else if let Some(x) = paths.first() {
        format!("檔案：{}", clip(x, 160))
    } else {
        clip(tool_name, 60)
    };
    Req { category: category.into(), paths, summary: format!("{}：{what}", category_label(category)) }
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
    fn 預設政策_開放_白名單外一律拒絕() {
        let cwd = Path::new("/w/Gemini");
        let (p, warn) = normalize_permissions(None, cwd);
        assert!(warn.is_empty());
        let req = |c: &str, paths: &[&str]| Req { category: c.into(), paths: paths.iter().map(|s| s.to_string()).collect(), summary: String::new() };
        assert_eq!(decide(&p, &req("read", &["/w/Gemini/a.txt"]), cwd).0, Verdict::Allow);
        assert_eq!(decide(&p, &req("read", &["/etc/passwd"]), cwd).0, Verdict::Deny);
        assert_eq!(decide(&p, &req("read", &["/w/Gemini/../x"]), cwd).0, Verdict::Deny, ".. 逃出白名單");
        assert_eq!(decide(&p, &req("write", &["/w/Gemini/a.txt"]), cwd).0, Verdict::Allow);
        assert_eq!(decide(&p, &req("write", &["/etc/x"]), cwd).0, Verdict::Deny, "預設開放仍擋資料夾外的寫入");
        assert_eq!(decide(&p, &req("write", &["/w/Gemini/../x"]), cwd).0, Verdict::Deny);
        assert_eq!(decide(&p, &req("execute", &[]), cwd).0, Verdict::Allow);
        assert_eq!(decide(&p, &req("network", &[]), cwd).0, Verdict::Allow);
        assert_eq!(decide(&p, &req("internal", &[]), cwd).0, Verdict::Allow);
        assert_eq!(decide(&p, &req("other", &[]), cwd).0, Verdict::Deny);
    }

    #[test]
    fn write_dirs_只收窄寫入_讀仍看_allow_dirs() {
        let cwd = Path::new("/w/Review");
        let raw = json!({"write": "allow", "allow_dirs": ["/w/Review"], "write_dirs": ["/w/Review/_preview"]});
        let (p, warn) = normalize_permissions(Some(&raw), cwd);
        assert!(warn.is_empty());
        let req = |c: &str, paths: &[&str]| Req { category: c.into(), paths: paths.iter().map(|s| s.to_string()).collect(), summary: String::new() };
        assert_eq!(decide(&p, &req("write", &["/w/Review/_preview/a.html"]), cwd).0, Verdict::Allow);
        assert_eq!(decide(&p, &req("write", &["/w/Review/_patches/x.diff"]), cwd).0, Verdict::Deny, "_patches 不在可寫資料夾");
        assert_eq!(decide(&p, &req("write", &["/w/Review/_preview/../_patches/x"]), cwd).0, Verdict::Deny, ".. 逃出可寫資料夾");
        assert_eq!(decide(&p, &req("write", &["/w/Review/_preview/a", "/w/Review/b"]), cwd).0, Verdict::Deny, "多個路徑只要一個在外面就拒絕");
        assert_eq!(decide(&p, &req("read", &["/w/Review/_patches/x.diff"]), cwd).0, Verdict::Allow, "讀不受 write_dirs 影響");
        assert_eq!(decide(&p, &req("read", &["/etc/passwd"]), cwd).0, Verdict::Deny);
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
        assert_eq!(decide(&p, &Req { category: "write".into(), paths: vec!["/shared/x".into()], summary: String::new() }, cwd).0, Verdict::Ask);
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
    fn agy_scratch_對話編號空著或不像編號就沒有() {
        let h = Path::new("/u");
        assert_eq!(agy_scratch(h, ""), None);
        assert_eq!(agy_scratch(h, ".."), None);
        assert_eq!(agy_scratch(h, "a/b"), None);
        assert_eq!(agy_scratch(h, r"a\b"), None);
        assert_eq!(agy_scratch(h, "abc-1_2"), Some(h.join(".gemini").join("antigravity-cli").join("brain").join("abc-1_2").join("scratch")));
    }

    #[test]
    fn agy_user_home_先看它環境的_userprofile_再看_home() {
        let e = |v: &[(&str, &str)]| v.iter().map(|(a, b)| (a.to_string(), b.to_string())).collect::<Vec<_>>();
        assert_eq!(agy_user_home(&e(&[("HOME", "/h"), ("UserProfile", "/p")])), PathBuf::from("/p"));
        assert_eq!(agy_user_home(&e(&[("HOME", "/h"), ("USERPROFILE", " ")])), PathBuf::from("/h"));
    }

    #[test]
    fn inside_agy_scratch_只認目前對話的_scratch_其他位置與跳出去的都不算() {
        let d = tempfile::tempdir().unwrap();
        let sc = agy_scratch(d.path(), "c1").unwrap();
        let base = d.path();
        // scratch 還不存在：不放行
        assert!(!inside_agy_scratch(&[s(&sc.join("a.md"))], &sc, base));
        std::fs::create_dir_all(&sc).unwrap();
        std::fs::create_dir_all(sc.parent().unwrap().join(".system_generated")).unwrap();
        assert!(inside_agy_scratch(&[s(&sc.join("a.md")), s(&sc.join("sub").join("b.md"))], &sc, base));
        assert!(!inside_agy_scratch(&[], &sc, base), "沒帶路徑不放行");
        assert!(!inside_agy_scratch(&[s(&sc)], &sc, base), "scratch 本身不是裡面的檔");
        assert!(!inside_agy_scratch(&[s(&sc.join("..").join(".system_generated").join("x"))], &sc, base));
        assert!(!inside_agy_scratch(&[s(&sc.join("a.md")), s(&d.path().join("x"))], &sc, base), "有一個在外面就不行");
        // 相對路徑以工作資料夾為準，不是 scratch
        assert!(!inside_agy_scratch(&["a.md".into()], &sc, base));
    }

    #[cfg(windows)]
    fn junction(link: &Path, target: &Path) {
        let st = std::process::Command::new("cmd").args(["/c", "mklink", "/J"]).arg(link).arg(target).output().unwrap();
        assert!(st.status.success(), "{st:?}");
    }

    #[cfg(windows)]
    #[test]
    fn inside_agy_scratch_經過_junction_跳出去的不算_scratch_本身是_junction_也不算() {
        let d = tempfile::tempdir().unwrap();
        let out = d.path().join("elsewhere");
        std::fs::create_dir_all(&out).unwrap();
        let sc = agy_scratch(d.path(), "c1").unwrap();
        std::fs::create_dir_all(&sc).unwrap();
        junction(&sc.join("j"), &out);
        assert!(!inside_agy_scratch(&[s(&sc.join("j").join("x.txt"))], &sc, d.path()));
        std::fs::write(out.join("e.txt"), "x").unwrap();
        assert!(!inside_agy_scratch(&[s(&sc.join("j").join("e.txt"))], &sc, d.path()), "已經存在的檔也一樣");
        // scratch 自己是 junction（指到別處）：整個不放行
        let sc2 = agy_scratch(d.path(), "c2").unwrap();
        std::fs::create_dir_all(sc2.parent().unwrap()).unwrap();
        junction(&sc2, &out);
        assert!(!inside_agy_scratch(&[s(&sc2.join("x.txt"))], &sc2, d.path()));
        // 對照：正常的 scratch 放行（證明上面不是因為別的原因失敗）
        assert!(inside_agy_scratch(&[s(&sc.join("x.txt"))], &sc, d.path()));
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

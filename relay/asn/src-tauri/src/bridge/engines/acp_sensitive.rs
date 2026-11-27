//! 讀取的敏感位置判定（#2356 PR-1，純函式）。
//! 規則：背景夥伴可以讀這台電腦上的檔，但登入資料、金鑰、各 AI 工具的設定與對話記錄不行。
//! 判定本身是純函式；`acp_policy::decide`（標準 ACP）與 `acp_worker` 的 `check_tool`（agy）呼叫它。
//! 敏感清單只定義在這個檔：寫入（`acp_policy::sensitive_write`）用 `SENSITIVE_HOME_DIRS`，讀取再加上 `EXTRA_HOME_PATHS` 與環境變數指定的位置。
//! 比對的是路徑，不是邊界：執行指令的內容不經這裡。已知限制：大小寫不分的檔案系統（例如 macOS 預設）上，只有 Windows 會把比對轉成小寫。
#![allow(dead_code)]

use super::acp_policy::{agy_brain, inside_agy_conv_dir, resolve, valid_conv_id};
use serde_json::Value;
use std::io;
use std::path::{Component, Path, PathBuf};

/// 使用者資料夾底下放登入資料、金鑰、對話記錄的地方（寫入與讀取共用）。
// ASN 的新舊資料夾名取自 home.rs（舊名只准寫在那裡）
pub const SENSITIVE_HOME_DIRS: [&str; 10] = [".gemini", ".ssh", crate::home::NEW_NAME, crate::home::LEGACY_NAME, ".claude", ".codex", ".pi", ".aws", ".config", ".gnupg"];

/// 只有讀取才列的位置（相對於使用者資料夾，可以是檔案或資料夾）
pub const EXTRA_HOME_PATHS: [&str; 33] = [
    ".grok",
    ".claude.json",
    ".netrc",
    ".git-credentials",
    ".docker",
    ".kube",
    ".azure",
    ".npmrc",
    ".pgpass",
    ".my.cnf",
    ".pypirc",
    ".m2/settings.xml",
    ".bash_history",
    ".zsh_history",
    ".cursor",
    ".codeium",
    "AppData/Roaming/Microsoft/Credentials",
    "AppData/Roaming/Microsoft/Protect",
    "AppData/Roaming/Microsoft/Vault",
    "AppData/Roaming/Microsoft/Windows/PowerShell/PSReadLine",
    "AppData/Roaming/gcloud",
    "AppData/Roaming/GitHub CLI",
    "AppData/Roaming/Mozilla/Firefox",
    "AppData/Roaming/Opera Software",
    "AppData/Local/Microsoft/Credentials",
    "AppData/Local/Microsoft/Vault",
    "AppData/Local/Google/Chrome/User Data",
    "AppData/Local/Microsoft/Edge/User Data",
    "AppData/Local/BraveSoftware/Brave-Browser/User Data",
    "AppData/Local/Vivaldi/User Data",
    "AppData/Local/Opera Software",
    "AppData/Local/Mozilla/Firefox",
    // 電腦版的應用資料夾
    concat!("AppData/Local/", "tw.yooliang.asn"),
];

/// 檔名只寫前綴的位置：（資料夾, 檔名前綴），相對於使用者資料夾
pub const PREFIX_HOME_FILES: [(&str, &str); 2] = [(".cargo", "credentials"), (".terraform.d", "credentials")];

/// 本機應用資料夾（環境變數 LOCALAPPDATA 底下）與漫遊資料夾（APPDATA 底下）裡的敏感位置
const LOCALAPPDATA_ROOTS: [&str; 3] = [crate::appdir::PACKAGE, "Google/Chrome/User Data", "Microsoft/Edge/User Data"];
const APPDATA_ROOTS: [&str; 2] = ["Microsoft/Credentials", "Microsoft/Protect"];

/// 參數是整段指令或程式碼的欄位名（小寫）：路徑判定管不到，抽取時略過（名字裡有路徑字眼的不略過）
const SKIP_KEYS: [&str; 9] = ["command", "commandline", "command_line", "commands", "cmd", "script", "scripts", "scriptblock", "script_block"];

/// 環境變數指定的位置（絕對路徑才算）
const ENV_ROOTS: [&str; 6] = ["CODEX_HOME", "PI_CODING_AGENT_DIR", "ASN_HOME", "IRORI_HOME", "ASN_CLAUDE_HOME", "ASN_GROK_HOME"];

/// 系統層：這個資料夾底下 `ssh_host_*_key` 樣式的檔
const HOST_KEY_DIR: &str = "/etc/ssh";

/// 系統層的單一檔案
const SYSTEM_FILES: [&str; 2] = ["/etc/shadow", "/etc/gshadow"];

/// 其他使用者的家目錄所在的資料夾（底下每個子資料夾都算別人的家，自己的家除外）；`/root` 另算
const OTHER_HOME_PARENTS: [&str; 2] = ["/home", "/users"];

/// 別人的家目錄資料夾裡，這幾個是共用的，不算別人的
const SHARED_HOME_NAMES: [&str; 4] = ["public", "default", "default user", "all users"];

/// 路徑字串長度上限：路徑類欄位超過就直接擋
const MAX_PATH_LEN: usize = 4096;

type Canon = fn(&Path) -> io::Result<PathBuf>;

fn std_canon(p: &Path) -> io::Result<PathBuf> {
    std::fs::canonicalize(p)
}

/// 這次讀取是哪一類工具：單檔讀取、只列名字的列舉、會掃內容的遞迴搜尋
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum ReadTool {
    #[default]
    Single,
    List,
    Recursive,
}
impl ReadTool {
    pub fn of_agy(name: &str) -> ReadTool {
        match name {
            "list_dir" | "list_resources" => ReadTool::List,
            "find_by_name" | "grep_search" => ReadTool::Recursive,
            _ => ReadTool::Single,
        }
    }
    pub fn of_acp_kind(kind: &str) -> ReadTool {
        if kind.eq_ignore_ascii_case("search") { ReadTool::Recursive } else { ReadTool::Single }
    }
}

/// 判定結果：可以讀、落在敏感位置、解析不了（偏向擋）
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ReadVerdict {
    Allow,
    Sensitive,
    Unresolvable,
}

/// 敏感根清單。啟動時算好（每個家目錄各算一次，字面與實際位置兩種形式），之後每次請求只比字串
#[derive(Clone)]
pub struct SensitiveRoots {
    roots: Vec<String>,
    /// （資料夾, 檔名前綴）：資料夾底下檔名以前綴開頭的檔
    prefix_files: Vec<(String, String)>,
    /// 其他使用者的家目錄所在的資料夾（已正規化）
    other_home_parents: Vec<String>,
    /// 指向本機的主機名（小寫）：`\\<名>\C$\` 這種寫法轉回本機磁碟機
    local_names: Vec<String>,
    homes: Vec<String>,
    home_paths: Vec<PathBuf>,
    brains: Vec<PathBuf>,
    /// 明確放行的資料夾（已正規化）：自己的工作資料夾、附件下載資料夾、agy 的內建說明檔。見 exempt.rs
    exempt_dirs: Vec<String>,
    env: Vec<(String, String)>,
    canon: Canon,
}

// 手寫 Debug：裡面存著環境變數（可能含金鑰），不能被印出來
impl std::fmt::Debug for SensitiveRoots {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "SensitiveRoots {{ roots: {}, homes: {} }}", self.roots.len(), self.homes.len())
    }
}

pub struct ReadCtx<'a> {
    pub roots: &'a SensitiveRoots,
    pub base: &'a Path,
    pub tool: ReadTool,
}

impl SensitiveRoots {
    /// homes：agy 環境的家目錄＋這台電腦實際的使用者資料夾；env：展開變數與環境變數指定位置用
    pub fn build(homes: &[PathBuf], env: &[(String, String)]) -> SensitiveRoots {
        Self::build_with(homes, env, std_canon)
    }

    fn build_with(homes: &[PathBuf], env: &[(String, String)], canon: Canon) -> SensitiveRoots {
        let get = |n: &str| env.iter().find(|(k, v)| k.eq_ignore_ascii_case(n) && !v.trim().is_empty()).map(|(_, v)| PathBuf::from(v.trim()));
        let mut home_strs: Vec<String> = vec![];
        for h in homes {
            push_forms(&mut home_strs, h, canon);
        }
        let mut paths: Vec<PathBuf> = vec![];
        for h in homes {
            for d in SENSITIVE_HOME_DIRS.iter().chain(EXTRA_HOME_PATHS.iter()) {
                paths.push(h.join(d));
            }
        }
        let mut env_paths: Vec<PathBuf> = ENV_ROOTS.iter().filter_map(|n| get(n)).collect();
        if let Some(la) = get("LOCALAPPDATA") {
            env_paths.extend(LOCALAPPDATA_ROOTS.iter().map(|r| la.join(r)));
        }
        if let Some(ap) = get("APPDATA") {
            env_paths.extend(APPDATA_ROOTS.iter().map(|r| ap.join(r)));
        }
        for p in env_paths {
            if !p.is_absolute() && !p.to_string_lossy().starts_with('/') {
                continue;
            }
            // 指到使用者資料夾本身或它的上層會把整個家都擋掉：設錯了，不採用
            let n = nstr(&p.to_string_lossy());
            if home_strs.iter().any(|h| *h == n || h.starts_with(&format!("{n}/"))) {
                continue;
            }
            paths.push(p);
        }
        let mut roots: Vec<String> = vec![];
        for p in &paths {
            push_forms(&mut roots, p, canon);
        }
        let mut prefix_files: Vec<(String, String)> = vec![];
        for h in homes {
            for (d, pre) in PREFIX_HOME_FILES {
                let mut dirs: Vec<String> = vec![];
                push_forms(&mut dirs, &h.join(d), canon);
                for dir in dirs {
                    if !prefix_files.iter().any(|(x, y)| *x == dir && y == pre) {
                        prefix_files.push((dir, pre.to_string()));
                    }
                }
            }
        }
        // 別人的家目錄：自己的家所在資料夾若叫 users／home，同一層其他資料夾都算別人的
        let mut other_home_parents: Vec<String> = OTHER_HOME_PARENTS.iter().map(|s| s.to_string()).collect();
        for h in &home_strs {
            if let Some((parent, _)) = h.rsplit_once('/') {
                if (parent.ends_with("/users") || parent.ends_with("/home") || parent == "users" || parent == "home") && !other_home_parents.iter().any(|p| p == parent) {
                    other_home_parents.push(parent.to_string());
                }
            }
        }
        let mut local_names: Vec<String> = vec!["localhost".into(), "127.0.0.1".into()];
        if let Some(n) = env.iter().find(|(k, v)| k.eq_ignore_ascii_case("COMPUTERNAME") && !v.trim().is_empty()) {
            local_names.push(n.1.trim().to_lowercase());
        }
        SensitiveRoots {
            roots,
            prefix_files,
            other_home_parents,
            local_names,
            homes: home_strs,
            home_paths: homes.to_vec(),
            brains: homes.iter().map(|h| agy_brain(h)).collect(),
            exempt_dirs: vec![],
            env: env.to_vec(),
            canon,
        }
    }
}

/// 字面與實際位置兩種形式都放進清單（去重）
fn push_forms(out: &mut Vec<String>, p: &Path, canon: Canon) {
    let mut add = |s: String| {
        if !out.contains(&s) {
            out.push(s);
        }
    };
    add(nstr(&p.to_string_lossy()));
    if let Some(r) = real_path_with(canon, p) {
        add(nstr(&r.to_string_lossy()));
    }
}

/// 比對用的字串：反斜線換成斜線、去掉 `\\?\` 與 `\\.\` 前綴與尾端斜線，Windows 轉小寫
fn nstr(s: &str) -> String {
    let mut t = s.replace('\\', "/");
    for p in ["//?/", "//./"] {
        if let Some(rest) = t.strip_prefix(p) {
            t = rest.to_string();
            break;
        }
    }
    let t = t.trim_end_matches('/');
    if cfg!(windows) { t.to_lowercase() } else { t.to_string() }
}

/// 最深一層存在的上層用 canonicalize 解開捷徑，還不存在的尾段接回去；一層都解不開回 None
fn real_path_with(canon: Canon, abs: &Path) -> Option<PathBuf> {
    let mut cur = abs;
    let mut rest: Vec<&std::ffi::OsStr> = vec![];
    loop {
        if let Ok(c) = canon(cur) {
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

// ---- ① 展開 ----

/// `file:` 網址：解開 `%XX`、剝掉前綴與 `localhost`、補掉 `/C:` 前面的斜線；有別的主機名就當網路路徑 `//主機/…`。
/// 不是 file 網址就原樣回傳。全程只用 `get` 與位元組比較，遇到多位元組字元不會 panic
fn strip_file_url(s: &str) -> String {
    if !s.get(..5).is_some_and(|p| p.eq_ignore_ascii_case("file:")) {
        return s.to_string();
    }
    let decoded = percent_decode(&s[5..]);
    let mut rest: &str = &decoded;
    let mut unc: Option<String> = None;
    if let Some(after) = rest.strip_prefix("//") {
        let end = after.find('/').unwrap_or(after.len());
        let (host, path) = after.split_at(end);
        let pb = path.as_bytes();
        let admin_share = pb.len() >= 3 && pb[0] == b'/' && pb[1].is_ascii_alphabetic() && pb[2] == b'$';
        if host.is_empty() || (host.eq_ignore_ascii_case("localhost") && !admin_share) {
            rest = path;
        } else {
            unc = Some(format!("//{host}{path}"));
        }
    }
    if let Some(u) = unc {
        return u;
    }
    let b = rest.as_bytes();
    if b.len() >= 3 && b[0] == b'/' && b[1].is_ascii_alphabetic() && b[2] == b':' {
        rest = &rest[1..];
    }
    rest.to_string()
}

fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() &&b[i + 1].is_ascii_hexdigit() && b[i + 2].is_ascii_hexdigit() {
            let h = u8::from_str_radix(&s[i + 1..i + 3], 16).unwrap_or(b'%');
            out.push(h);
            i += 3;
        } else {
            out.push(b[i]);
            i += 1;
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn valid_var(name: &str) -> bool {
    let mut it = name.chars();
    matches!(it.next(), Some(c) if c.is_ascii_alphabetic() || c == '_') && it.all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '(' || c == ')')
}

/// 展開 `~`、`$NAME`、`${NAME}`、`%NAME%`。home 為 None 時家目錄相關的展開不了。回傳（結果, 有沒有展開不了的）
fn expand_one(raw: &str, home: Option<&Path>, env: &[(String, String)]) -> (String, bool) {
    let chars: Vec<char> = raw.chars().collect();
    let lookup = |name: &str| -> Option<String> {
        if let Some(h) = home {
            let hs = h.to_string_lossy();
            if name.eq_ignore_ascii_case("HOME") || name.eq_ignore_ascii_case("USERPROFILE") {
                return Some(hs.into_owned());
            }
            // 家目錄拆成磁碟機與其餘部分（沒有磁碟機的路徑，磁碟機是空的）
            let split = if hs.as_bytes().get(1) == Some(&b':') && hs.get(..2).is_some() { 2 } else { 0 };
            if name.eq_ignore_ascii_case("HOMEDRIVE") {
                return Some(hs[..split].to_string());
            }
            if name.eq_ignore_ascii_case("HOMEPATH") {
                return Some(hs[split..].to_string());
            }
        }
        env.iter().find(|(k, v)| k.eq_ignore_ascii_case(name) && !v.is_empty()).map(|(_, v)| v.clone())
    };
    let mut out = String::new();
    let mut bad = false;
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        if c == '~' && i == 0 && (chars.len() == 1 || chars[1] == '/' || chars[1] == '\\') {
            match home {
                Some(h) => out.push_str(&h.to_string_lossy()),
                None => {
                    out.push('~');
                    bad = true;
                }
            }
            i += 1;
            continue;
        }
        if c == '$' {
            let (name, next) = if chars.get(i + 1) == Some(&'{') {
                match chars[i + 2..].iter().position(|x| *x == '}') {
                    Some(p) => (chars[i + 2..i + 2 + p].iter().collect::<String>(), i + 3 + p),
                    None => (String::new(), i + 1),
                }
            } else {
                let mut j = i + 1;
                while j < chars.len() && (chars[j].is_ascii_alphanumeric() || chars[j] == '_') {
                    j += 1;
                }
                (chars[i + 1..j].iter().collect::<String>(), j)
            };
            if valid_var(&name) {
                match lookup(&name) {
                    Some(v) => out.push_str(&v),
                    None => {
                        out.extend(chars[i..next].iter());
                        bad = true;
                    }
                }
                i = next;
                continue;
            }
        }
        if c == '%' {
            if let Some(p) = chars[i + 1..].iter().position(|x| *x == '%') {
                let name: String = chars[i + 1..i + 1 + p].iter().collect();
                if valid_var(&name) {
                    match lookup(&name) {
                        Some(v) => out.push_str(&v),
                        None => {
                            out.extend(chars[i..i + p + 2].iter());
                            bad = true;
                        }
                    }
                    i += p + 2;
                    continue;
                }
            }
        }
        out.push(c);
        i += 1;
    }
    (out, bad)
}

/// 每個家目錄各展開一次（`~`、`$HOME` 在兩個來源下各是一條路徑）
fn expand(raw: &str, homes: &[PathBuf], env: &[(String, String)]) -> (Vec<String>, bool) {
    let mut outs: Vec<String> = vec![];
    let mut bad = false;
    if homes.is_empty() {
        let (s, b) = expand_one(raw, None, env);
        outs.push(s);
        bad = b;
    }
    for h in homes {
        let (s, b) = expand_one(raw, Some(h), env);
        if !outs.contains(&s) {
            outs.push(s);
        }
        bad |= b;
    }
    (outs, bad)
}

// ---- ③ Windows 路徑形式 ----

fn is_drive(seg: &str) -> bool {
    let b = seg.as_bytes();
    b.len() == 2 && b[0].is_ascii_alphabetic() && b[1] == b':'
}

/// Windows 路徑的寫法變體：逐段正規化成一般寫法，並把磁碟機前綴與指向本機的網路路徑轉回一般盤符路徑。
/// 純字串處理，任何平台都能測
pub fn win_clean(s: &str) -> String {
    win_clean_with(s, &["localhost", "127.0.0.1"])
}

/// 兩個 `/` 開頭的路徑（網路路徑）：回傳（主機, 其餘）
fn split_unc(t: &str) -> Option<(&str, &str)> {
    let rest = t.strip_prefix("//")?;
    Some(rest.split_once('/').unwrap_or((rest, "")))
}

/// 這個路徑是不是「看不出實際指向哪裡」的寫法：磁碟機以外的裝置前綴，或指向別台（或無法確認是本機）管理共用的網路路徑。
/// 這類一律當解析不了。純字串判斷，任何平台都能測
pub fn opaque_device_path(s: &str, local_names: &[String]) -> bool {
    let t = s.replace('\\', "/");
    let drive_after = |rest: &str| {
        let b = rest.as_bytes();
        b.len() >= 2 && b[0].is_ascii_alphabetic() && b[1] == b':' && (b.len() == 2 || b[2] == b'/')
    };
    if let Some(rest) = t.strip_prefix("//?/") {
        return !drive_after(rest);
    }
    if let Some(rest) = t.strip_prefix("//./") {
        return !drive_after(rest);
    }
    if let Some((host, rest)) = split_unc(&t) {
        let share = rest.split('/').next().unwrap_or("");
        let admin_share = share.len() == 2 && share.as_bytes()[0].is_ascii_alphabetic() && share.ends_with('$');
        let host_l = host.to_lowercase();
        return admin_share && !local_names.iter().any(|n| *n == host_l);
    }
    false
}

/// 磁碟機字母加冒號、後面接的不是分隔符（`C:xxx`）：這種寫法的意思取決於各程序自己的目前資料夾，沒辦法在這裡確定。
/// `C:`、`C:\`、`C:/` 本身不算。裝置前綴後面的磁碟機同樣看。純字串判斷，任何平台都能測
pub fn drive_relative(s: &str) -> bool {
    let t = s.replace('\\', "/");
    let t = t.strip_prefix("//?/").or_else(|| t.strip_prefix("//./")).unwrap_or(&t);
    let b = t.as_bytes();
    b.len() >= 3 && b[0].is_ascii_alphabetic() && b[1] == b':' && b[2] != b'/'
}

fn win_clean_with(s: &str, hosts: &[&str]) -> String {
    let mut t = s.replace('\\', "/");
    for p in ["//?/", "//./"] {
        if let Some(rest) = t.strip_prefix(p) {
            t = rest.to_string();
            break;
        }
    }
    if let Some((host, rest)) = split_unc(&t) {
        if hosts.iter().any(|h| h.eq_ignore_ascii_case(host)) {
            let (first, tail) = rest.split_once('/').unwrap_or((rest, ""));
            if first.len() == 2 && first.as_bytes()[0].is_ascii_alphabetic() && first.ends_with('$') {
                t = format!("{}:/{}", &first[..1], tail);
            }
        }
    }
    let mut segs: Vec<String> = vec![];
    for (i, seg) in t.split('/').enumerate() {
        if i == 0 && is_drive(seg) {
            segs.push(seg.to_string());
            continue;
        }
        if seg.is_empty() || seg == "." || seg == ".." {
            segs.push(seg.to_string());
            continue;
        }
        let name = seg.split(':').next().unwrap_or("");
        let name = name.trim_end_matches(['.', ' ']);
        if !name.is_empty() {
            segs.push(name.to_string());
        }
    }
    segs.join("/")
}

// ---- ④ 比對 ----

fn is_host_key(f: &str) -> bool {
    match f.rsplit_once('/') {
        Some((d, n)) => d == HOST_KEY_DIR && n.starts_with("ssh_host_") && n.ends_with("_key"),
        None => false,
    }
}

fn is_ancestor_of(f: &str, root: &str) -> bool {
    root.starts_with(&format!("{f}/"))
}

/// 這個（已正規化的）位置算不算命中：等於或在敏感根底下；遞迴類工具再加上「是敏感根的上層」
fn hits(f: &str, tool: ReadTool, roots: &SensitiveRoots) -> bool {
    for r in &roots.roots {
        if f == r || f.starts_with(&format!("{r}/")) {
            return true;
        }
        if tool == ReadTool::Recursive && is_ancestor_of(f, r) {
            return true;
        }
    }
    let recursive = tool == ReadTool::Recursive;
    // 檔名前綴：資料夾底下以前綴開頭的檔
    for (dir, pre) in &roots.prefix_files {
        if f.rsplit_once('/').is_some_and(|(d, n)| d == dir && n.starts_with(pre.as_str())) || (recursive && (f == dir || is_ancestor_of(f, dir))) {
            return true;
        }
    }
    if is_host_key(f) || is_proc_environ(f) || SYSTEM_FILES.contains(&f) {
        return true;
    }
    if recursive && (f == HOST_KEY_DIR || is_ancestor_of(f, HOST_KEY_DIR) || f == "/proc" || is_ancestor_of(f, "/proc") || is_proc_environ_dir(f) || SYSTEM_FILES.iter().any(|s| is_ancestor_of(f, s))) {
        return true;
    }
    other_home_hit(f, tool, roots)
}

/// `/proc/<編號>/environ`，以及執行緒形式 `/proc/<編號>/task/<執行緒編號>/environ`
fn is_proc_environ(f: &str) -> bool {
    let Some(rest) = f.strip_prefix("/proc/") else { return false };
    let segs: Vec<&str> = rest.split('/').collect();
    match segs.as_slice() {
        [pid, "environ"] => !pid.is_empty(),
        [pid, "task", tid, "environ"] => !pid.is_empty() && !tid.is_empty(),
        _ => false,
    }
}

/// 底下含環境檔的 /proc 資料夾（遞迴搜尋會掃進去）：`/proc/<編號>`、`/proc/<編號>/task`、`/proc/<編號>/task/<執行緒編號>`
fn is_proc_environ_dir(f: &str) -> bool {
    let Some(rest) = f.strip_prefix("/proc/") else { return false };
    let segs: Vec<&str> = rest.split('/').collect();
    match segs.as_slice() {
        [_] => true,
        [pid, "task"] => !pid.is_empty(),
        [pid, "task", tid] => !pid.is_empty() && !tid.is_empty(),
        _ => false,
    }
}

/// 別人的家目錄：`/root`，以及家目錄所在資料夾（`/home`、`C:\Users`…）底下不是自己家的子資料夾（共用的 Public 等不算）
fn other_home_hit(f: &str, tool: ReadTool, roots: &SensitiveRoots) -> bool {
    let recursive = tool == ReadTool::Recursive;
    let mine = |p: &str| roots.homes.iter().any(|h| h == p);
    if (f == "/root" || f.starts_with("/root/")) && !mine("/root") {
        return true;
    }
    for parent in &roots.other_home_parents {
        if recursive && (f == parent || is_ancestor_of(f, parent)) {
            return true;
        }
        let Some(rest) = f.strip_prefix(&format!("{parent}/")) else { continue };
        let name = rest.split('/').next().unwrap_or("");
        let home = format!("{parent}/{name}");
        if !name.is_empty() && !SHARED_HOME_NAMES.contains(&name) && !mine(&home) {
            return true;
        }
    }
    false
}

fn under_home(f: &str, roots: &SensitiveRoots) -> bool {
    roots.homes.iter().any(|h| f == h || f.starts_with(&format!("{h}/")))
}

/// agy 自己的對話資料夾：裡面的檔放行；對話資料夾本身與 brain 本身只開給單檔與列舉（遞迴搜尋會掃進系統目錄，照擋）
fn exempt_brain(f: &str, roots: &SensitiveRoots, base: &Path, tool: ReadTool) -> bool {
    roots.brains.iter().any(|b| {
        inside_agy_conv_dir(&[f.to_string()], b, base)
            || (tool != ReadTool::Recursive && {
                let mut forms = vec![nstr(&b.to_string_lossy())];
                forms.extend(real_path_with(roots.canon, b).map(|r| nstr(&r.to_string_lossy())));
                forms.iter().any(|d| f == d || f.strip_prefix(&format!("{d}/")).is_some_and(valid_conv_id))
            })
    })
}

/// 路徑段含萬用字元（`* ? [ {`）：回傳第一個萬用字元段之前的部分（沒有萬用字元回 None）。前面什麼都沒有就是根或目前資料夾
fn wildcard_prefix(c: &str) -> Option<String> {
    let segs: Vec<&str> = c.split(['/', '\\']).collect();
    let i = segs.iter().position(|s| s.contains(['*', '?', '[', '{']))?;
    let prefix = segs[..i].join("/");
    Some(if prefix.is_empty() {
        if c.starts_with(['/', '\\']) { "/".to_string() } else { ".".to_string() }
    } else if prefix.len() == 2 && is_drive(&prefix) {
        format!("{prefix}/")
    } else {
        prefix
    })
}

fn join_base(base: &Path, p: &str) -> PathBuf {
    if Path::new(p).is_absolute() || p.starts_with('/') || p.starts_with('\\') { PathBuf::from(p) } else { base.join(p) }
}

/// 這條讀取路徑是不是敏感位置。
/// 每個展開結果各取四種形式比對（字面折疊、原字串的實際位置、折疊後的實際位置），任一命中就擋；
/// agy 自己的對話資料夾（brain/<編號>/，不含系統目錄）例外，且每個命中的形式都要各自符合例外才放行。
/// 解析不了（含展開不了的變數）而字面落在使用者資料夾底下，偏向擋
pub fn is_sensitive_read(path_raw: &str, ctx: &ReadCtx) -> bool {
    read_verdict(path_raw, ctx) != ReadVerdict::Allow
}

/// 同 [`is_sensitive_read`]，但分得出是「落在敏感位置」還是「解析不了而偏向擋」（後者要另記一行 log）
pub fn read_verdict(path_raw: &str, ctx: &ReadCtx) -> ReadVerdict {
    let raw = path_raw.trim();
    if raw.is_empty() {
        return ReadVerdict::Allow;
    }
    // 超長或含換行的路徑欄位：沒辦法逐段判定，偏向擋
    if path_raw.len() > MAX_PATH_LEN || path_raw.contains(['\n', '\r', '\0']) {
        return ReadVerdict::Unresolvable;
    }
    // 層數超過上限、還沒解開的巢狀 JSON 字串（抽取時原樣收進來的）：沒辦法判定，偏向擋
    if container_like(raw) {
        return ReadVerdict::Unresolvable;
    }
    let roots = ctx.roots;
    let hosts: Vec<&str> = roots.local_names.iter().map(String::as_str).collect();
    let (cands, mut failed) = expand(&strip_file_url(raw), &roots.home_paths, &roots.env);
    let mut literals: Vec<String> = vec![];
    for c0 in cands {
        if cfg!(windows) && (opaque_device_path(&c0, &roots.local_names) || drive_relative(&c0)) {
            return ReadVerdict::Unresolvable;
        }
        let cleaned = if cfg!(windows) { win_clean_with(&c0, &hosts) } else { c0.clone() };
        // 清理過的形式也要看：磁碟機後面不接分隔符的寫法，在接上工作資料夾之前就擋下
        if cfg!(windows) && drive_relative(&cleaned) {
            return ReadVerdict::Unresolvable;
        }
        // 路徑段有萬用字元：取第一個萬用字元之前的部分，照遞迴搜尋判定
        let (c, tool) = match wildcard_prefix(&cleaned) {
            Some(p) => (p, ReadTool::Recursive),
            None => (cleaned.clone(), ctx.tool),
        };
        let joined = join_base(ctx.base, &c);
        let has_dotdot = joined.components().any(|x| matches!(x, Component::ParentDir));
        let folded = resolve(ctx.base, &c);
        let canon_joined = (roots.canon)(&joined);
        // （形式, 可不可以套 brain 例外）
        let mut forms: Vec<(String, bool)> = vec![(nstr(&folded.to_string_lossy()), !has_dotdot)];
        if let Ok(p) = &canon_joined {
            forms.push((nstr(&p.to_string_lossy()), true));
        }
        // 展開後的原字串（沒做過任何清理）也直接解一次
        if cleaned != c0 && wildcard_prefix(&c0).is_none() {
            if let Ok(p) = (roots.canon)(&join_base(ctx.base, &c0)) {
                forms.push((nstr(&p.to_string_lossy()), true));
            }
        }
        match real_path_with(roots.canon, &folded) {
            Some(p) => forms.push((nstr(&p.to_string_lossy()), !has_dotdot)),
            None => failed = true,
        }
        literals.push(nstr(&folded.to_string_lossy()));
        literals.push(nstr(&joined.to_string_lossy()));
        for (f, may_exempt) in &forms {
            if hits(f, tool, roots) && !(*may_exempt && (roots.exempt(f) || exempt_brain(f, roots, ctx.base, tool))) {
                return ReadVerdict::Sensitive;
            }
        }
    }
    if failed && literals.iter().any(|l| under_home(l, roots)) { ReadVerdict::Unresolvable } else { ReadVerdict::Allow }
}

// ---- 路徑抽取 ----

const PATH_KEY_WORDS: [&str; 12] = ["path", "file", "dir", "target", "uri", "url", "source", "glob", "root", "folder", "location", "cwd"];

fn key_is_path(k: &str) -> bool {
    let l = k.to_lowercase();
    PATH_KEY_WORDS.iter().any(|w| l.contains(w))
}

fn looks_like_path(s: &str) -> bool {
    let b = s.as_bytes();
    s.contains('/')
        || s.contains('\\')
        || s.starts_with('~')
        || s.starts_with('$')
        || s.to_ascii_lowercase().starts_with("file:")
        || (b.len() >= 2 && b[0].is_ascii_alphabetic() && b[1] == b':')
        || s.matches('%').count() >= 2
}

/// JSON 字串裡再包 JSON 字串，最多往下解幾層；再深的原樣收進來，判定那邊直接當解析不了
const MAX_JSON_DEPTH: usize = 4;

fn push_unique(out: &mut Vec<String>, s: &str) {
    if !s.trim().is_empty() && !out.iter().any(|x| x == s) {
        out.push(s.to_string());
    }
}

fn walk(v: &Value, under_key: bool, out: &mut Vec<String>, depth: usize) {
    match v {
        Value::String(s) => {
            // 字串能解成物件或陣列：往裡面找（有層數上限，超過的原樣收進來由判定擋）
            if let Some(inner) = json_container(s) {
                if depth < MAX_JSON_DEPTH {
                    walk(&inner, under_key, out, depth + 1);
                } else {
                    push_unique(out, s);
                }
                return;
            }
            // 長得像 JSON 容器卻解不開（缺括號、多接文字、單引號、多重編碼…）：原樣收進來，判定那邊當解析不了
            if container_like(s) {
                push_unique(out, s);
                return;
            }
            if under_key {
                // 路徑類欄位的字串一律收（超長、含換行的由判定那邊直接擋）
                push_unique(out, s);
            } else if s.len() <= MAX_PATH_LEN && !s.contains('\n') {
                if looks_like_path(s) {
                    push_unique(out, s);
                }
            } else {
                // 其他欄位的超長或多行文字，逐行看：沒有空白又像路徑的收；有空白的，夾著敏感位置片段的才把那段路徑收進來（片段由清單自動產生）
                for line in s.lines().map(str::trim).filter(|l| !l.is_empty()) {
                    if !line.contains(char::is_whitespace) { if looks_like_path(line) { push_unique(out, line) } } else { fragments::prose_candidates(line).iter().for_each(|c| push_unique(out, c)) }
                }
            }
        }
        Value::Array(a) => a.iter().for_each(|x| walk(x, under_key, out, depth)),
        Value::Object(m) => m.iter().for_each(|(k, x)| {
            // 指令與程式碼欄位是整段命令，不是路徑，路徑判定管不到（敏感清單不是邊界）
            let l = k.to_lowercase();
            if key_is_path(k) || !SKIP_KEYS.contains(&l.as_str()) {
                walk(x, under_key || key_is_path(k), out, depth)
            }
        }),
        _ => {}
    }
}

/// 讀取請求的參數 → 所有可能是路徑的字串：路徑類欄位名底下的字串（含陣列、巢狀），以及任何位置長得像路徑的字串
pub fn extract_read_paths(params: &Value) -> Vec<String> {
    let mut out = vec![];
    walk(params, false, &mut out, 0);
    out
}

/// 參數的最上層欄位名（只有名字、沒有值；寫 log 用）
pub fn param_keys(params: &Value) -> Vec<String> {
    match params {
        Value::Object(m) => m.keys().cloned().collect(),
        Value::String(s) => match serde_json::from_str::<Value>(s) {
            Ok(Value::Object(m)) => m.keys().cloned().collect(),
            _ => vec![],
        },
        _ => vec![],
    }
}

mod exempt;
pub use exempt::{homes_from, roots_for_worker, ATTACHMENTS_READABLE};
#[cfg(test)]
pub use exempt::env_without_homes;
mod fragments;
mod jsonstr;
use jsonstr::{container_like, json_container};
#[cfg(test)]
mod tests;
#[cfg(test)]
mod tests_form;
#[cfg(test)]
mod tests_shared;

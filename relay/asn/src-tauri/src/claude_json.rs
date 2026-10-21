//! 安全編輯使用者家目錄的 `.claude.json`（只動指定片段、原子寫入、寫前驗證 JSON）。
//!
//! Claude Code 的 `projects` 鍵格式（實測 2.1.306，Linux VM）：
//! - 鍵名是 **工作資料夾的 canonical 絕對路徑**（`readlink -f`／`fs::canonicalize` 後的字串）。
//! - Linux／macOS：維持 POSIX 路徑，例如 `/tmp/foo/workdir`（正斜線）。
//! - Windows：同一實體路徑存成 **正斜線**，例如 `C:/Users/alice/Github/demo`（反斜線版可能變成另一筆 entry，實務上只寫正斜線 canonical）。
//! - 不附加尾隨斜線；值只設 `hasTrustDialogAccepted: true`，不動該 project 的其他欄位。
use std::fmt;
use std::path::{Path, PathBuf};

const TRUST_KEY: &str = "hasTrustDialogAccepted";

#[derive(Debug, PartialEq, Eq)]
pub enum TrustWrite {
    /// 已是 true 或無需變更
    Noop,
    /// 原本沒有 .claude.json，建立最小檔
    Created,
    /// 已存在檔案且寫入更新
    Updated,
}

#[derive(Debug, PartialEq, Eq)]
pub enum TrustErr {
    Corrupt(&'static str),
    Io(String),
}

impl fmt::Display for TrustErr {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            TrustErr::Corrupt(m) => write!(f, "{m}"),
            TrustErr::Io(e) => write!(f, "檔案操作失敗：{e}"),
        }
    }
}

impl From<std::io::Error> for TrustErr {
    fn from(e: std::io::Error) -> Self {
        TrustErr::Io(e.kind().to_string())
    }
}

pub fn claude_json_path(home: &Path) -> PathBuf {
    home.join(".claude.json")
}

/// 對應 Claude Code `projects` 的鍵（與本次啟動 cwd 一致，需已 canonicalize）。
pub fn claude_project_key(cwd: &Path) -> String {
    let p = std::fs::canonicalize(cwd).unwrap_or_else(|_| cwd.to_path_buf());
    #[cfg(windows)]
    {
        return p.to_string_lossy().replace('\\', "/");
    }
    #[cfg(not(windows))]
    {
        p.to_string_lossy().into_owned()
    }
}

pub fn write_atomic(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    let dir = path.parent().ok_or_else(|| std::io::Error::other("no parent"))?;
    std::fs::create_dir_all(dir)?;
    let tmp = dir.join(format!(
        ".asn-tmp-{}-{}",
        std::process::id(),
        path.file_name().and_then(|s| s.to_str()).unwrap_or("f")
    ));
    let res = (|| {
        let mut f = std::fs::File::create(&tmp)?;
        f.write_all(bytes)?;
        f.sync_all()?;
        drop(f);
        std::fs::rename(&tmp, path)
    })();
    if res.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    res
}

fn skip_ws(b: &[u8], mut i: usize) -> usize {
    while i < b.len() && (b[i] as char).is_ascii_whitespace() {
        i += 1;
    }
    i
}

fn skip_string(b: &[u8], mut i: usize) -> Option<usize> {
    i += 1;
    while i < b.len() {
        match b[i] {
            b'\\' => i += 2,
            b'"' => return Some(i + 1),
            _ => i += 1,
        }
    }
    None
}

fn skip_value(b: &[u8], i: usize) -> Option<usize> {
    match *b.get(i)? {
        b'"' => skip_string(b, i),
        b'{' | b'[' => {
            let mut depth = 0usize;
            let mut j = i;
            while j < b.len() {
                match b[j] {
                    b'"' => {
                        j = skip_string(b, j)?;
                        continue;
                    }
                    b'{' | b'[' => depth += 1,
                    b'}' | b']' => {
                        depth = depth.checked_sub(1)?;
                        if depth == 0 {
                            return Some(j + 1);
                        }
                    }
                    _ => {}
                }
                j += 1;
            }
            None
        }
        _ => {
            let mut j = i;
            while j < b.len() && !matches!(b[j], b',' | b'}' | b']') && !(b[j] as char).is_ascii_whitespace() {
                j += 1;
            }
            Some(j)
        }
    }
}

fn json_key_at(text: &str, key: &str, obj_body_start: usize, obj_close: usize) -> Option<(usize, usize, usize)> {
    let b = text.as_bytes();
    let bad = || None;
    let mut i = skip_ws(b, obj_body_start);
    loop {
        i = skip_ws(b, i);
        if i >= obj_close {
            return None;
        }
        if b.get(i) == Some(&b'}') {
            return None;
        }
        if b.get(i) != Some(&b'"') {
            return bad();
        }
        let ks = i;
        let ke = skip_string(b, i)?;
        let name = &text[ks + 1..ke - 1];
        i = skip_ws(b, ke);
        if b.get(i) != Some(&b':') {
            return bad();
        }
        i = skip_ws(b, i + 1);
        let vs = i;
        let ve = skip_value(b, i)?;
        if name == key {
            return Some((ks, vs, ve));
        }
        i = skip_ws(b, ve);
        if b.get(i) == Some(&b',') {
            i += 1;
        }
    }
}

struct TopObj {
    close: usize,
    members: usize,
    first_key: Option<usize>,
}

fn scan_top_object(text: &str) -> Result<TopObj, TrustErr> {
    let b = text.as_bytes();
    let bad = || TrustErr::Corrupt(".claude.json 不是合法的 JSON 物件，已停止（沒有改任何檔案）");
    let mut i = skip_ws(b, if text.starts_with('\u{feff}') { 3 } else { 0 });
    if b.get(i) != Some(&b'{') {
        return Err(bad());
    }
    i += 1;
    let mut t = TopObj { close: 0, members: 0, first_key: None };
    loop {
        i = skip_ws(b, i);
        match b.get(i) {
            Some(b'}') => {
                t.close = i;
                return Ok(t);
            }
            Some(b'"') => {
                let ks = i;
                let ke = skip_string(b, i).ok_or_else(bad)?;
                i = skip_ws(b, ke);
                if b.get(i) != Some(&b':') {
                    return Err(bad());
                }
                i = skip_ws(b, i + 1);
                let ve = skip_value(b, i).ok_or_else(bad)?;
                t.first_key.get_or_insert(ks);
                t.members += 1;
                i = skip_ws(b, ve);
                if b.get(i) == Some(&b',') {
                    i += 1;
                }
            }
            _ => return Err(bad()),
        }
    }
}

fn line_indent(text: &str, at: usize) -> String {
    let ls = text[..at].rfind('\n').map(|p| p + 1).unwrap_or(0);
    let pre = &text[ls..at];
    if pre.chars().all(|c| c == ' ' || c == '\t') {
        pre.to_string()
    } else {
        String::new()
    }
}

fn trust_already_true(project_obj: &str) -> Result<bool, TrustErr> {
    let b = project_obj.as_bytes();
    if b.is_empty() || b[0] != b'{' {
        return Err(TrustErr::Corrupt(".claude.json 不是合法的 JSON 物件，已停止（沒有改任何檔案）"));
    }
    let body_start = skip_ws(b, 1);
    let close = project_obj.rfind('}').ok_or(TrustErr::Corrupt(".claude.json 不是合法的 JSON 物件，已停止（沒有改任何檔案）"))?;
    if let Some((_, vs, ve)) = json_key_at(project_obj, TRUST_KEY, body_start, close) {
        let v = project_obj[vs..ve].trim();
        if v == "true" {
            return Ok(true);
        }
        if v == "false" {
            return Ok(false);
        }
        return Err(TrustErr::Corrupt(".claude.json 不是合法的 JSON 物件，已停止（沒有改任何檔案）"));
    }
    Ok(false)
}

fn set_trust_true_in_project_obj(project_obj: &str) -> Result<String, TrustErr> {
    let b = project_obj.as_bytes();
    if b.is_empty() || b[0] != b'{' {
        return Err(TrustErr::Corrupt(".claude.json 不是合法的 JSON 物件，已停止（沒有改任何檔案）"));
    }
    let body_start = skip_ws(b, 1);
    let close = project_obj.rfind('}').ok_or(TrustErr::Corrupt(".claude.json 不是合法的 JSON 物件，已停止（沒有改任何檔案）"))?;
    if let Some((_, vs, ve)) = json_key_at(project_obj, TRUST_KEY, body_start, close) {
        let v = project_obj[vs..ve].trim();
        if v == "true" {
            return Ok(project_obj.to_string());
        }
        if v != "false" {
            return Err(TrustErr::Corrupt(".claude.json 不是合法的 JSON 物件，已停止（沒有改任何檔案）"));
        }
        let out = format!("{}true{}", &project_obj[..vs], &project_obj[ve..]);
        validate_json(&out)?;
        return Ok(out);
    }
    let before = project_obj[..close].trim_end();
    let ind = line_indent(project_obj, body_start);
    let inner_ind = if ind.is_empty() { "  ".to_string() } else { format!("{ind}  ") };
    let sep = if before.len() > 1 && !before.ends_with('{') { "," } else { "" };
    let out = format!("{before}{sep}\n{inner_ind}\"{TRUST_KEY}\": true\n{ind}}}");
    validate_json(&out)?;
    Ok(out)
}

fn validate_json(text: &str) -> Result<(), TrustErr> {
    serde_json::from_str::<serde_json::Value>(text.trim_start_matches('\u{feff}')).map_err(|_| {
        TrustErr::Corrupt(".claude.json 不是合法的 JSON 物件，已停止（沒有改任何檔案）")
    })?;
    Ok(())
}

fn minimal_new_file(project_key: &str) -> String {
    let k = quote_json_string(project_key);
    format!("{{\n  \"projects\": {{\n    {k}: {{\n      \"{TRUST_KEY}\": true\n    }}\n  }}\n}}\n")
}

fn quote_json_string(s: &str) -> String {
    serde_json::Value::String(s.to_string()).to_string()
}

fn patch_existing(text: &str, project_key: &str) -> Result<Option<String>, TrustErr> {
    validate_json(text)?;
    let top = scan_top_object(text)?;
    let body_start = skip_ws(text.as_bytes(), if text.starts_with('\u{feff}') { 3 } else { 0 } + 1);
    let projects = json_key_at(text, "projects", body_start, top.close);
    let project_key_json = quote_json_string(project_key);

    let out = if let Some((_, ps, pe)) = projects {
        let projects_text = &text[ps..pe];
        if projects_text.as_bytes().first() != Some(&b'{') {
            return Err(TrustErr::Corrupt(".claude.json 不是合法的 JSON 物件，已停止（沒有改任何檔案）"));
        }
        let p_body = skip_ws(projects_text.as_bytes(), 1);
        let p_close = projects_text.rfind('}').ok_or(TrustErr::Corrupt(".claude.json 不是合法的 JSON 物件，已停止（沒有改任何檔案）"))?;
        if let Some((_, pvs, pve)) = json_key_at(projects_text, project_key, p_body, p_close) {
            let proj = &projects_text[pvs..pve];
            if trust_already_true(proj)? {
                return Ok(None);
            }
            let new_proj = set_trust_true_in_project_obj(proj)?;
            let abs_s = ps + pvs;
            let abs_e = ps + pve;
            format!("{}{}{}", &text[..abs_s], new_proj, &text[abs_e..])
        } else {
            let before = projects_text[..p_close].trim_end();
            let ind = line_indent(text, ps + 1);
            let inner = if ind.is_empty() { "    ".to_string() } else { format!("{ind}  ") };
            let sep = if before.len() > 1 && !before.ends_with('{') { "," } else { "" };
            let insert = format!(
                "{before}{sep}\n{inner}{project_key_json}: {{\n{inner}  \"{TRUST_KEY}\": true\n{inner}}}\n{ind}}}",
                ind = ind
            );
            format!("{}{}{}", &text[..ps], insert, &text[pe..])
        }
    } else {
        let before = text[..top.close].trim_end();
        let ind = top.first_key.map(|k| line_indent(text, k)).unwrap_or_else(|| "  ".into());
        let sep = if top.members > 0 { "," } else { "" };
        format!(
            "{before}{sep}\n{ind}\"projects\": {{\n{ind}  {project_key_json}: {{\n{ind}    \"{TRUST_KEY}\": true\n{ind}  }}\n{ind}}}{}",
            &text[top.close..],
        )
    };
    validate_json(&out)?;
    Ok(Some(out))
}

/// 將 `projects[project_key].hasTrustDialogAccepted` 設為 true；已是 true 則不寫檔。
pub fn ensure_project_trusted(home: &Path, project_key: &str) -> Result<TrustWrite, TrustErr> {
    let path = claude_json_path(home);
    let Ok(meta) = std::fs::metadata(&path) else {
        let body = minimal_new_file(project_key);
        validate_json(&body)?;
        write_atomic(&path, body.as_bytes())?;
        return Ok(TrustWrite::Created);
    };
    let mtime_before = meta.modified().ok();
    let text = std::fs::read_to_string(&path)?;
    let Some(out) = patch_existing(&text, project_key)? else {
        return Ok(TrustWrite::Noop);
    };
    if out == text {
        return Ok(TrustWrite::Noop);
    }
    write_atomic(&path, out.as_bytes())?;
    if let (Some(b), Ok(a)) = (mtime_before, std::fs::metadata(&path).and_then(|m| m.modified())) {
        if b == a && out != text {
            // 部分檔案系統 mtime 粒度較粗；內容已變仍算 Updated
        }
    }
    Ok(TrustWrite::Updated)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::time::{Duration, SystemTime};

    fn setup() -> tempfile::TempDir {
        tempfile::tempdir().unwrap()
    }

    fn read(home: &Path) -> String {
        fs::read_to_string(claude_json_path(home)).unwrap()
    }

    fn mtime(home: &Path) -> SystemTime {
        fs::metadata(claude_json_path(home)).unwrap().modified().unwrap()
    }

    #[test]
    fn 已是信任的不重複寫檔() {
        let d = setup();
        let h = d.path();
        let key = "/tmp/ws";
        let src = format!(
            "{{\n  \"oauthAccount\": {{\"accountUuid\": \"u\"}},\n  \"projects\": {{\n    \"{key}\": {{\"hasTrustDialogAccepted\": true, \"other\": 1}}\n  }}\n}}\n"
        );
        fs::write(claude_json_path(h), &src).unwrap();
        let t0 = mtime(h);
        std::thread::sleep(Duration::from_millis(20));
        assert_eq!(ensure_project_trusted(h, key).unwrap(), TrustWrite::Noop);
        assert_eq!(read(h), src);
        assert_eq!(mtime(h), t0);
    }

    #[test]
    fn 未信任寫成_true() {
        let d = setup();
        let h = d.path();
        let key = "/tmp/ws";
        let src = format!(
            "{{\n  \"projects\": {{\n    \"{key}\": {{\"hasTrustDialogAccepted\": false}}\n  }}\n}}\n"
        );
        fs::write(claude_json_path(h), &src).unwrap();
        assert_eq!(ensure_project_trusted(h, key).unwrap(), TrustWrite::Updated);
        assert!(read(h).contains("\"hasTrustDialogAccepted\": true"));
        assert!(!read(h).contains("false"));
    }

    #[test]
    fn 檔案不存在建立最小檔() {
        let d = setup();
        let h = d.path();
        let key = "/data/proj";
        assert_eq!(ensure_project_trusted(h, key).unwrap(), TrustWrite::Created);
        let t = read(h);
        assert!(t.contains("\"projects\""));
        assert!(t.contains(key));
        assert!(t.contains("\"hasTrustDialogAccepted\": true"));
    }

    #[test]
    fn 其他_project_與_oauthAccount_位元組不變() {
        let d = setup();
        let h = d.path();
        let other = "/other";
        let target = "/target";
        let src = format!(
            "{{\n  \"oauthAccount\": {{\"emailAddress\": \"a@x.test\"}},\n  \"projects\": {{\n    \"{other}\": {{\"x\": 1}},\n    \"{target}\": {{\"hasTrustDialogAccepted\": false}}\n  }},\n  \"tail\":   null\n}}\n"
        );
        fs::write(claude_json_path(h), &src).unwrap();
        ensure_project_trusted(h, target).unwrap();
        let after = read(h);
        let before_o = src.find("\"oauthAccount\"").unwrap();
        let after_o = after.find("\"oauthAccount\"").unwrap();
        assert_eq!(&src[before_o..src.find("\"projects\"").unwrap()], &after[after_o..after.find("\"projects\"").unwrap()]);
        assert!(after.contains(&format!("\"{other}\": {{\"x\": 1}}")));
        assert!(after.contains("\"tail\":   null"));
    }

    #[test]
    fn json_壞掉不改檔() {
        let d = setup();
        let h = d.path();
        fs::write(claude_json_path(h), "{壞").unwrap();
        let before = read(h);
        assert!(ensure_project_trusted(h, "/x").is_err());
        assert_eq!(read(h), before);
    }

    #[test]
    fn claude_project_key_linux_用_canonical() {
        let d = setup();
        let sub = d.path().join("a").join("b");
        fs::create_dir_all(&sub).unwrap();
        let key = claude_project_key(&sub);
        assert_eq!(key, fs::canonicalize(&sub).unwrap().to_string_lossy());
        assert!(key.starts_with('/'));
    }
}

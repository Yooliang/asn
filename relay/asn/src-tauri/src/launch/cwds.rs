//! 開新夥伴對話框的「工作資料夾」候選：白名單＋自動建議（開著的 Claude 視窗、信任過的資料夾、最近用過）。
//! 使用者從下拉或「瀏覽…」選了＝明確同意，才會加進本機啟動設定（launch-prefs.json）的 cwdAllow；
//! 這份名單只管本機啟動，不會回報給收發室，遠端來的啟動仍只看 launcher.json。
use super::config::{canonical_launch_cwd, LaunchConfig};
use super::prefs::{launch_prefs_get_sync, launch_prefs_set_sync};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};

pub const MAX_CANDIDATES: usize = 15;

/// 正規化成「看起來一致」的路徑字串：去 \\?\ 前綴、Windows 上 / 換成 \、去尾端分隔線（磁碟根目錄除外）。
pub fn norm_path(s: &str) -> Option<String> {
    let mut t = s.trim().to_string();
    if let Some(r) = t.strip_prefix("\\\\?\\") {
        t = r.to_string();
    }
    if t.is_empty() {
        return None;
    }
    if cfg!(windows) {
        t = t.replace('/', "\\");
    }
    let is_root = |x: &str| x == "/" || (x.len() == 3 && x.ends_with(":\\")) || (x.len() == 2 && x.ends_with(':'));
    while t.len() > 1 && (t.ends_with('\\') || t.ends_with('/')) && !is_root(&t) {
        t.pop();
    }
    if cfg!(windows) && t.len() == 2 && t.ends_with(':') {
        t.push('\\');
    }
    Some(t)
}

fn dedupe_key(p: &str) -> String {
    if cfg!(windows) {
        p.to_lowercase()
    } else {
        p.to_string()
    }
}

/// 依來源先後合併：正規化、去重、略過不存在的資料夾、最多 limit 筆。
pub fn merge_sources(sources: &[Vec<String>], is_dir: &dyn Fn(&str) -> bool, limit: usize) -> Vec<String> {
    let mut seen = std::collections::HashSet::new();
    let mut out = Vec::new();
    for list in sources {
        for raw in list {
            let Some(p) = norm_path(raw) else { continue };
            if !seen.insert(dedupe_key(&p)) {
                continue;
            }
            if !is_dir(&p) {
                continue;
            }
            out.push(p);
            if out.len() >= limit {
                return out;
            }
        }
    }
    out
}

/// 開著的 Claude 視窗的 cwd：~/.claude/sessions/*.json 只讀 cwd 欄位，新的在前。
pub fn read_session_cwds(home: &Path) -> Vec<String> {
    let dir = home.join(".claude").join("sessions");
    let Ok(rd) = std::fs::read_dir(&dir) else { return vec![] };
    let mut rows: Vec<(std::time::SystemTime, String)> = rd
        .filter_map(|e| e.ok())
        .filter(|e| e.path().extension().map(|x| x == "json").unwrap_or(false))
        .filter_map(|e| {
            let mtime = e.metadata().ok()?.modified().ok()?;
            let v: Value = serde_json::from_str(&std::fs::read_to_string(e.path()).ok()?).ok()?;
            let cwd = v.get("cwd")?.as_str()?.to_string();
            Some((mtime, cwd))
        })
        .collect();
    rows.sort_by(|a, b| b.0.cmp(&a.0));
    rows.into_iter().map(|r| r.1).collect()
}

/// ~/.claude.json 的 projects：只看鍵與 hasTrustDialogAccepted，其餘內容不碰。
pub fn read_trusted_dirs(home: &Path) -> Vec<String> {
    let Ok(text) = std::fs::read_to_string(home.join(".claude.json")) else { return vec![] };
    let Ok(v) = serde_json::from_str::<Value>(&text) else { return vec![] };
    let Some(projects) = v.get("projects").and_then(Value::as_object) else { return vec![] };
    projects
        .iter()
        .filter(|(_, p)| p.get("hasTrustDialogAccepted").and_then(Value::as_bool) == Some(true))
        .map(|(k, _)| k.clone())
        .collect()
}

fn str_list(v: &Value, key: &str) -> Vec<String> {
    v.get(key)
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect())
        .unwrap_or_default()
}

fn paths_to_strings(v: &[PathBuf]) -> Vec<String> {
    v.iter().map(|p| p.to_string_lossy().into_owned()).collect()
}

/// 候選清單：最近用過 → 開著的視窗 → 信任過的 → 本機同意過的白名單 → 啟動設定白名單。
pub fn candidates(home: &Path, data_dir: &Path, launcher_allow: &[PathBuf]) -> Vec<String> {
    let prefs = launch_prefs_get_sync(data_dir).unwrap_or(Value::Null);
    let sources = vec![
        str_list(&prefs, "recentCwd"),
        read_session_cwds(home),
        read_trusted_dirs(home),
        str_list(&prefs, "cwdAllow"),
        paths_to_strings(launcher_allow),
    ];
    merge_sources(&sources, &|p| Path::new(p).is_dir(), MAX_CANDIDATES)
}

fn same_dir(a: &str, b: &Path) -> bool {
    canonical_launch_cwd(a).map(|x| x == b).unwrap_or(false)
}

/// 使用者同意的資料夾寫進本機白名單（去重）。
pub fn add_to_prefs_allow(data_dir: &Path, cwd: &str) -> Result<(), String> {
    let Some(p) = norm_path(cwd) else { return Err("資料夾是空的".into()) };
    let mut prefs = launch_prefs_get_sync(data_dir).unwrap_or(Value::Null);
    if !prefs.is_object() {
        prefs = json!({});
    }
    let mut allow = str_list(&prefs, "cwdAllow");
    if allow.iter().any(|x| norm_path(x).map(|y| dedupe_key(&y) == dedupe_key(&p)).unwrap_or(false)) {
        return Ok(());
    }
    allow.push(p);
    prefs["cwdAllow"] = json!(allow);
    launch_prefs_set_sync(data_dir, prefs)
}

/// 本機啟動前：cwd 已在白名單就放行；否則只有它是候選（自己的建議／本機同意過）才視為使用者同意，
/// 加進本機白名單並放行。其他來源的任意路徑一律不放行。
pub fn grant_local_cwd(config: &mut LaunchConfig, cwd: &str, home: &Path, data_dir: &Path) -> Result<(), String> {
    let canon = canonical_launch_cwd(cwd)?;
    if config.cwd_allow.contains(&canon) {
        return Ok(());
    }
    let prefs = launch_prefs_get_sync(data_dir).unwrap_or(Value::Null);
    let in_prefs = str_list(&prefs, "cwdAllow").iter().any(|s| same_dir(s, &canon));
    if !in_prefs {
        let cands = candidates(home, data_dir, &config.cwd_allow);
        if !cands.iter().any(|s| same_dir(s, &canon)) {
            return Ok(()); // 不放行：交給 check_launch 回「不在允許清單裡」
        }
        let _ = add_to_prefs_allow(data_dir, cwd);
    }
    config.cwd_allow.push(canon);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::launch::config::LaunchConfig;
    use std::collections::HashMap;

    fn cfg(allow: Vec<PathBuf>) -> LaunchConfig {
        LaunchConfig { profiles: HashMap::new(), cwd_allow: allow, max_per_hour: 6 }
    }

    fn w(p: &Path, text: &str) {
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, text).unwrap();
    }

    #[test]
    fn 正規化去尾端分隔線與前綴() {
        assert_eq!(norm_path("  "), None);
        let d = tempfile::tempdir().unwrap();
        let base = d.path().to_string_lossy().into_owned();
        assert_eq!(norm_path(&format!("{base}/")).unwrap(), norm_path(&base).unwrap());
        #[cfg(windows)]
        {
            assert_eq!(norm_path("D:/x/y/").unwrap(), "D:\\x\\y");
            assert_eq!(norm_path("\\\\?\\D:\\x").unwrap(), "D:\\x");
            assert_eq!(norm_path("D:\\").unwrap(), "D:\\");
        }
    }

    #[test]
    fn 合併去重略過不存在並限量() {
        let d = tempfile::tempdir().unwrap();
        let a = d.path().join("a");
        let b = d.path().join("b");
        std::fs::create_dir_all(&a).unwrap();
        std::fs::create_dir_all(&b).unwrap();
        let sa = a.to_string_lossy().into_owned();
        let sb = b.to_string_lossy().into_owned();
        let gone = d.path().join("gone").to_string_lossy().into_owned();
        let out = merge_sources(&[vec![sa.clone(), gone.clone()], vec![format!("{sa}/"), sb.clone()]], &|p| Path::new(p).is_dir(), 15);
        assert_eq!(out, vec![norm_path(&sa).unwrap(), norm_path(&sb).unwrap()]);
        let out = merge_sources(&[vec![sa, sb]], &|p| Path::new(p).is_dir(), 1);
        assert_eq!(out.len(), 1);
        let many: Vec<String> = (0..40).map(|i| format!("/m{i}")).collect();
        assert_eq!(merge_sources(&[many], &|_| true, MAX_CANDIDATES).len(), 15);
    }

    #[cfg(windows)]
    #[test]
    fn 兩種斜線寫法與大小寫視為同一個() {
        let d = tempfile::tempdir().unwrap();
        let a = d.path().join("Proj");
        std::fs::create_dir_all(&a).unwrap();
        let back = a.to_string_lossy().into_owned();
        let fwd = back.replace('\\', "/").to_lowercase();
        let out = merge_sources(&[vec![back.clone()], vec![fwd]], &|p| Path::new(p).is_dir(), 15);
        assert_eq!(out.len(), 1);
    }

    #[test]
    fn 讀開著的視窗與信任過的資料夾() {
        let home = tempfile::tempdir().unwrap();
        let proj = home.path().join("proj");
        let trusted = home.path().join("trusted");
        let untrusted = home.path().join("untrusted");
        for p in [&proj, &trusted, &untrusted] {
            std::fs::create_dir_all(p).unwrap();
        }
        w(&home.path().join(".claude/sessions/1.json"), &json!({ "cwd": proj.to_string_lossy(), "other": "x" }).to_string());
        w(&home.path().join(".claude/sessions/bad.json"), "not json");
        w(&home.path().join(".claude/sessions/nocwd.json"), "{}");
        let t = trusted.to_string_lossy().into_owned();
        let projects = json!({
            t.clone(): { "hasTrustDialogAccepted": true },
            t.replace('\\', "/"): { "hasTrustDialogAccepted": true },
            untrusted.to_string_lossy(): { "hasTrustDialogAccepted": false },
            home.path().join("missing").to_string_lossy(): { "hasTrustDialogAccepted": true },
        });
        w(&home.path().join(".claude.json"), &json!({ "projects": projects, "oauthAccount": { "secret": 1 } }).to_string());
        assert_eq!(read_session_cwds(home.path()), vec![proj.to_string_lossy().into_owned()]);
        let data = tempfile::tempdir().unwrap();
        let c = candidates(home.path(), data.path(), &[]);
        assert!(c.contains(&norm_path(&proj.to_string_lossy()).unwrap()));
        assert_eq!(c.iter().filter(|x| dedupe_key(x) == dedupe_key(&norm_path(&t).unwrap())).count(), 1);
        assert!(!c.iter().any(|x| x.ends_with("untrusted") || x.ends_with("missing")));
    }

    #[test]
    fn 沒有任何來源時是空的() {
        let home = tempfile::tempdir().unwrap();
        let data = tempfile::tempdir().unwrap();
        assert!(candidates(home.path(), data.path(), &[]).is_empty());
    }

    #[test]
    fn 候選順序_最近用過在前() {
        let home = tempfile::tempdir().unwrap();
        let data = tempfile::tempdir().unwrap();
        let (r, s) = (home.path().join("r"), home.path().join("s"));
        std::fs::create_dir_all(&r).unwrap();
        std::fs::create_dir_all(&s).unwrap();
        w(&home.path().join(".claude/sessions/1.json"), &json!({ "cwd": s.to_string_lossy() }).to_string());
        w(&data.path().join("launch-prefs.json"), &json!({ "recentCwd": [r.to_string_lossy()] }).to_string());
        let c = candidates(home.path(), data.path(), &[]);
        assert_eq!(c, vec![norm_path(&r.to_string_lossy()).unwrap(), norm_path(&s.to_string_lossy()).unwrap()]);
    }

    #[test]
    fn 瀏覽加入白名單_去重且遠端設定不動() {
        let data = tempfile::tempdir().unwrap();
        let d = tempfile::tempdir().unwrap();
        let p = d.path().to_string_lossy().into_owned();
        add_to_prefs_allow(data.path(), &p).unwrap();
        add_to_prefs_allow(data.path(), &format!("{p}/")).unwrap();
        let prefs = launch_prefs_get_sync(data.path()).unwrap();
        assert_eq!(str_list(&prefs, "cwdAllow").len(), 1);
        assert!(add_to_prefs_allow(data.path(), "  ").is_err());
        // 只寫 launch-prefs.json，不碰 launcher.json
        assert!(!data.path().join("launcher.json").exists());
    }

    #[test]
    fn 啟動前同意_建議的資料夾放行並記住_陌生路徑不放行() {
        let home = tempfile::tempdir().unwrap();
        let data = tempfile::tempdir().unwrap();
        let proj = home.path().join("proj");
        let stranger = home.path().join("stranger");
        std::fs::create_dir_all(&proj).unwrap();
        std::fs::create_dir_all(&stranger).unwrap();
        w(&home.path().join(".claude/sessions/1.json"), &json!({ "cwd": proj.to_string_lossy() }).to_string());

        let mut c = cfg(vec![]);
        grant_local_cwd(&mut c, &stranger.to_string_lossy(), home.path(), data.path()).unwrap();
        assert!(c.cwd_allow.is_empty());

        grant_local_cwd(&mut c, &proj.to_string_lossy(), home.path(), data.path()).unwrap();
        assert_eq!(c.cwd_allow, vec![canonical_launch_cwd(&proj.to_string_lossy()).unwrap()]);
        let prefs = launch_prefs_get_sync(data.path()).unwrap();
        assert_eq!(str_list(&prefs, "cwdAllow").len(), 1);

        // 之後視窗關了、建議消失，本機同意過的仍然放行
        std::fs::remove_dir_all(home.path().join(".claude")).unwrap();
        let mut c2 = cfg(vec![]);
        grant_local_cwd(&mut c2, &proj.to_string_lossy(), home.path(), data.path()).unwrap();
        assert_eq!(c2.cwd_allow.len(), 1);
    }

    #[test]
    fn 已在啟動設定白名單的直接放行() {
        let home = tempfile::tempdir().unwrap();
        let data = tempfile::tempdir().unwrap();
        let p = home.path().join("ok");
        std::fs::create_dir_all(&p).unwrap();
        let canon = canonical_launch_cwd(&p.to_string_lossy()).unwrap();
        let mut c = cfg(vec![canon.clone()]);
        grant_local_cwd(&mut c, &p.to_string_lossy(), home.path(), data.path()).unwrap();
        assert_eq!(c.cwd_allow, vec![canon]);
        assert!(!data.path().join("launch-prefs.json").exists());
    }
}

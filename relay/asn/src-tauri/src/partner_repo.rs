//! 夥伴的 GitHub 倉庫（#1776）：訊息裡單獨寫「#111」時，要連到這位夥伴工作資料夾對應的 GitHub 倉庫。
//! 只讀本機檔案：從工作資料夾往上找 `.git`，讀設定檔裡 `[remote "origin"]` 的 url，認出 github.com 的「擁有者/倉庫」。
//! 不起任何程序、不碰網路（不 fetch、不 ls-remote）。讀不到、不是 github.com、格式怪＝None（前端就把 #編號當普通文字，不會連錯倉庫）。
//! 路徑不由前端給：前端只給視窗名，工作資料夾由本機視窗清單（~/.claude/sessions）查出來；名單上沒有的名字一律 None，
//! 所以這個指令探測不了任意路徑。結果快取 5 分鐘（同一個資料夾不必每則訊息都讀檔）。
use std::collections::HashMap;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

const CACHE_TTL: Duration = Duration::from_secs(300);
const CACHE_MAX: usize = 256;
const READ_MAX: u64 = 1_000_000;
const UP_MAX: usize = 12;

/// GitHub 使用者／組織名：英數與 -，1～39 字，不以 - 開頭或結尾，不連續兩個 -
pub fn valid_owner(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 39
        && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
        && !s.starts_with('-')
        && !s.ends_with('-')
        && !s.contains("--")
}

/// 倉庫名：英數與 . _ -，1～100 字，不能是 . 或 ..
pub fn valid_repo(s: &str) -> bool {
    !s.is_empty() && s.len() <= 100 && s != "." && s != ".." && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-')
}

/// 從 git remote 的 url 認出「擁有者/倉庫」。只認 github.com（https、ssh://、git@github.com:擁有者/倉庫）；
/// 帳密（https://帳號:密碼@github.com/…）只用來剝掉，不會出現在結果裡。
pub fn github_repo_from_url(url: &str) -> Option<String> {
    let u = url.trim();
    if u.is_empty() || u.len() > 500 || u.chars().any(|c| c.is_control() || c.is_whitespace()) {
        return None;
    }
    let lower = u.to_ascii_lowercase();
    let path: &str = if lower.starts_with("https://") || lower.starts_with("ssh://") {
        let rest = &u[lower.find("://")? + 3..];
        let (authority, path) = rest.split_once('/')?;
        let host = authority.rsplit('@').next()?.to_ascii_lowercase();
        let host = if lower.starts_with("ssh://") { host.strip_suffix(":22").unwrap_or(&host).to_string() } else { host };
        if host != "github.com" {
            return None;
        }
        path
    } else if u.contains("://") {
        return None;
    } else {
        // git@github.com:擁有者/倉庫.git
        let (left, path) = u.split_once(':')?;
        let host = left.rsplit('@').next()?.to_ascii_lowercase();
        if host != "github.com" {
            return None;
        }
        path
    };
    let path = path.trim_matches('/');
    let path = path.strip_suffix(".git").unwrap_or(path);
    let (owner, repo) = path.split_once('/')?;
    if repo.contains('/') || !valid_owner(owner) || !valid_repo(repo) {
        return None;
    }
    Some(format!("{owner}/{repo}"))
}

/// git 設定檔裡 `[remote "origin"]` 的第一個 url
pub fn origin_url_from_config(text: &str) -> Option<String> {
    let mut in_origin = false;
    for raw in text.lines() {
        let line = raw.trim();
        if line.starts_with('[') {
            let inner = line.trim_start_matches('[').split(']').next().unwrap_or("");
            let mut parts = inner.split_whitespace();
            in_origin = parts.next().is_some_and(|k| k.eq_ignore_ascii_case("remote")) && parts.next() == Some("\"origin\"") && parts.next().is_none();
            continue;
        }
        if !in_origin {
            continue;
        }
        if let Some((k, v)) = line.split_once('=') {
            if k.trim().eq_ignore_ascii_case("url") {
                let v = v.trim().trim_matches('"').trim();
                if !v.is_empty() {
                    return Some(v.to_string());
                }
            }
        }
    }
    None
}

fn read_small(p: &Path) -> Option<String> {
    let f = std::fs::File::open(p).ok()?;
    let mut buf = Vec::new();
    f.take(READ_MAX).read_to_end(&mut buf).ok()?;
    Some(String::from_utf8_lossy(&buf).into_owned())
}

/// 只跟本機路徑：開頭是兩個路徑分隔符（`\\`、`//`、`\/`、`/\`，涵蓋網路與裝置寫法）或 `\??\` 的一律不跟。
/// 純字串判斷，在碰任何檔案系統之前先擋。
fn local_target_ok(p: &str) -> bool {
    let s = p.trim();
    let sep = |c: char| c == '\\' || c == '/';
    let mut it = s.chars();
    let two_seps = matches!((it.next(), it.next()), (Some(a), Some(b)) if sep(a) && sep(b));
    !(two_seps || s.starts_with("\\??\\"))
}

/// 只在字面上消掉 `.`、`..`（不碰檔案系統、不跟隨任何連結）。`..` 退到根以上就回 None
fn lexical(p: &Path) -> Option<PathBuf> {
    use std::path::Component;
    let mut out: Vec<Component> = Vec::new();
    for c in p.components() {
        match c {
            Component::CurDir => {}
            Component::ParentDir => match out.last() {
                Some(Component::Normal(_)) => {
                    out.pop();
                }
                _ => return None,
            },
            other => out.push(other),
        }
    }
    Some(out.iter().collect())
}

/// 是不是連結（symlink；Windows 上連 junction 等 reparse point 也算）。讀不到也當成是（保守）
fn is_link(p: &Path) -> bool {
    match std::fs::symlink_metadata(p) {
        Ok(m) => {
            #[cfg(windows)]
            {
                use std::os::windows::fs::MetadataExt;
                if m.file_attributes() & 0x400 != 0 {
                    return true;
                }
            }
            m.file_type().is_symlink()
        }
        Err(_) => true,
    }
}

/// 從這個路徑一路往上到根，每一層都不是連結（只跟本機、實體的路徑）
fn no_links(p: &Path) -> bool {
    p.ancestors().filter(|a| !a.as_os_str().is_empty() && a.parent().is_some()).all(|a| !is_link(a))
}

/// 是一般檔案：本身與每一層父資料夾都不是連結，而且是檔案
fn plain_file(p: &Path) -> bool {
    no_links(p) && std::fs::symlink_metadata(p).map(|m| m.is_file()).unwrap_or(false)
}

/// 正規化後的 gitdir：必須在某個 repo 的 `.git/worktrees/<名>` 或 `.git/modules/<…>` 底下。
/// 回 (那個 `.git` 資料夾, 是否在 modules 底下)
fn git_dir_layout(gitdir: &Path) -> Option<(PathBuf, bool)> {
    let comps: Vec<_> = gitdir.components().collect();
    let idx = comps.iter().rposition(|c| c.as_os_str() == ".git")?;
    let rest = &comps[idx + 1..];
    let first = rest.first()?.as_os_str();
    let modules = first == "modules" && rest.len() >= 2;
    let worktree = first == "worktrees" && rest.len() == 2;
    if !(modules || worktree) {
        return None;
    }
    let git: PathBuf = comps[..=idx].iter().collect();
    Some((git, modules))
}

/// worktree 的 `.git` 檔：跟著 gitdir 找到共用的設定檔路徑（只跟本機、同一個 repo 底下的路徑）
fn worktree_config_path(d: &Path, text: &str, read: &dyn Fn(&Path) -> Option<String>) -> Option<PathBuf> {
    let target = text.lines().next()?.trim().strip_prefix("gitdir:")?.trim().to_string();
    if !local_target_ok(&target) {
        return None;
    }
    let raw = if Path::new(&target).is_absolute() { PathBuf::from(&target) } else { d.join(&target) };
    let gitdir = lexical(&raw)?;
    if !no_links(&gitdir) {
        return None;
    }
    let (git, in_modules) = git_dir_layout(&gitdir)?;
    let cd = gitdir.join("commondir");
    let common = if plain_file(&cd) {
        match read(&cd) {
            Some(c) if !c.trim().is_empty() => {
                let c = c.trim();
                if !local_target_ok(c) {
                    return None;
                }
                let raw = if Path::new(c).is_absolute() { PathBuf::from(c) } else { gitdir.join(c) };
                let common = lexical(&raw)?;
                if common != git {
                    return None;
                }
                common
            }
            _ => return None,
        }
    } else if in_modules {
        gitdir
    } else {
        return None;
    };
    let cfg = common.join("config");
    plain_file(&cfg).then_some(cfg)
}

/// 從資料夾往上找 .git，回要讀的 git 設定檔路徑。.git 是檔案（git worktree）時，跟著「gitdir:」找到真正的 git 資料夾，
/// 再跟著它的 commondir 找到共用的設定檔（worktree 的 remote 設定在共用的那份）。
fn git_config_path(start: &Path, read: &dyn Fn(&Path) -> Option<String>) -> Option<PathBuf> {
    let mut dir = Some(start);
    for _ in 0..UP_MAX {
        let d = dir?;
        let dot = d.join(".git");
        if dot.exists() && !no_links(&dot) {
            return None;
        }
        if dot.is_dir() {
            let cfg = dot.join("config");
            return plain_file(&cfg).then_some(cfg);
        }
        if dot.is_file() {
            let text = read(&dot)?;
            return worktree_config_path(d, &text, read);
        }
        dir = d.parent();
    }
    None
}

fn repo_of_dir_with(dir: &Path, read: &dyn Fn(&Path) -> Option<String>) -> Option<String> {
    let text = read(&git_config_path(dir, read)?)?;
    github_repo_from_url(&origin_url_from_config(&text)?)
}

/// 資料夾對應的 GitHub 倉庫（擁有者/倉庫）；讀不到或不是 github.com 就是 None
pub fn repo_of_dir(dir: &Path) -> Option<String> {
    repo_of_dir_with(dir, &read_small)
}

/// 快取：資料夾 → (讀的時間, 結果)；沒讀到也記（None），同樣 5 分鐘內不重讀
#[derive(Default)]
pub struct Cache {
    map: Mutex<HashMap<String, (Instant, Option<String>)>>,
}

impl Cache {
    pub fn get_or_load(&self, key: &str, now: Instant, load: impl FnOnce() -> Option<String>) -> Option<String> {
        if let Ok(m) = self.map.lock() {
            if let Some((at, v)) = m.get(key) {
                if now.saturating_duration_since(*at) < CACHE_TTL {
                    return v.clone();
                }
            }
        }
        let v = load();
        if let Ok(mut m) = self.map.lock() {
            if m.len() >= CACHE_MAX {
                m.retain(|_, (at, _)| now.saturating_duration_since(*at) < CACHE_TTL);
                if m.len() >= CACHE_MAX {
                    m.clear();
                }
            }
            m.insert(key.to_string(), (now, v.clone()));
        }
        v
    }
}

/// 名單（視窗名, 工作資料夾）上有這個名字才查它的資料夾；名單沒有、資料夾是空的＝None（不接受任意路徑）
pub fn repo_for_window(windows: &[(String, String)], name: &str, cache: &Cache, now: Instant) -> Option<String> {
    let (_, cwd) = windows.iter().find(|(n, _)| n == name)?;
    if cwd.trim().is_empty() {
        return None;
    }
    cache.get_or_load(cwd, now, || repo_of_dir(Path::new(cwd)))
}

fn shared_cache() -> &'static Cache {
    static C: OnceLock<Cache> = OnceLock::new();
    C.get_or_init(Cache::default)
}

/// 命令用：讀本機視窗清單（同「local_windows」），照視窗名查它的倉庫
pub fn lookup(name: &str) -> Option<String> {
    if name.is_empty() || name.len() > 200 {
        return None;
    }
    let home = crate::identity::home_dir();
    let l = crate::bridge::roster::read_local_with(&home.join(".claude").join("sessions"), &home.join(".asn").join("status"), crate::heartbeat::session_alive, 0, "", crate::heartbeat::now_ms())?;
    let windows: Vec<(String, String)> = l.into_iter().map(|w| (w.name, w.cwd)).collect();
    repo_for_window(&windows, name, shared_cache(), Instant::now())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn gh(u: &str) -> Option<String> {
        github_repo_from_url(u)
    }

    #[test]
    fn url_https_ssh_scp_都認得() {
        assert_eq!(gh("https://github.com/Yooliang/asn.git").as_deref(), Some("Yooliang/asn"));
        assert_eq!(gh("https://github.com/Yooliang/asn").as_deref(), Some("Yooliang/asn"));
        assert_eq!(gh("https://github.com/Yooliang/asn/").as_deref(), Some("Yooliang/asn"));
        assert_eq!(gh("HTTPS://GitHub.com/Yooliang/asn.git").as_deref(), Some("Yooliang/asn"));
        assert_eq!(gh("git@github.com:Yooliang/asn.git").as_deref(), Some("Yooliang/asn"));
        assert_eq!(gh("git@github.com:Yooliang/asn").as_deref(), Some("Yooliang/asn"));
        assert_eq!(gh("ssh://git@github.com/Yooliang/asn.git").as_deref(), Some("Yooliang/asn"));
        assert_eq!(gh("ssh://git@github.com:22/Yooliang/asn.git").as_deref(), Some("Yooliang/asn"));
        assert_eq!(gh("https://x-access-token:SECRET@github.com/Yooliang/asn.git").as_deref(), Some("Yooliang/asn"), "帳密剝掉");
        assert!(!gh("https://x-access-token:SECRET@github.com/Yooliang/asn.git").unwrap().contains("SECRET"));
        assert_eq!(gh("https://github.com/a/b.c_d-e").as_deref(), Some("a/b.c_d-e"));
    }

    #[test]
    fn url_不是_github_或格式怪_一律_none() {
        for u in [
            "",
            "   ",
            "https://gitlab.com/o/r.git",
            "https://github.com.evil.com/o/r.git",
            "https://evil.com/x@github.com/o/r.git",
            "https://github.com@evil.com/o/r.git",
            "git@gitlab.com:o/r.git",
            "git@github.com.evil.com:o/r.git",
            "http://github.com/o/r.git",
            "git://github.com/o/r.git",
            "file:///C:/repo",
            "C:/repo/asn",
            "../asn",
            "https://github.com/o",
            "https://github.com/o/r/extra",
            "https://github.com//r",
            "https://github.com/-o/r",
            "https://github.com/o--x/r",
            "https://github.com/o/..",
            "https://github.com/o/r r",
            "https://github.com/o/r%20x",
            "git@github.com:o",
            "ssh://git@github.com:2222/o/r.git",
        ] {
            assert_eq!(gh(u), None, "{u}");
        }
        assert_eq!(gh(&format!("https://github.com/{}/r", "a".repeat(40))), None, "擁有者太長");
        assert_eq!(gh(&format!("https://github.com/o/{}", "r".repeat(101))), None, "倉庫名太長");
    }

    #[test]
    fn 設定檔只取_origin_的_url() {
        let cfg = "[core]\n\trepositoryformatversion = 0\n[remote \"upstream\"]\n\turl = https://github.com/other/up.git\n[remote \"origin\"]\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n\turl = git@github.com:Yooliang/asn.git\n[branch \"main\"]\n\turl = https://github.com/no/no\n";
        assert_eq!(origin_url_from_config(cfg).as_deref(), Some("git@github.com:Yooliang/asn.git"));
        assert_eq!(origin_url_from_config("[remote \"upstream\"]\nurl = https://github.com/a/b\n"), None, "沒有 origin");
        assert_eq!(origin_url_from_config("[remote \"origin\"]\nfetch = x\n"), None, "origin 沒有 url");
        assert_eq!(origin_url_from_config("").as_deref(), None);
        assert_eq!(origin_url_from_config("[remote \"origin\"]\r\n\tURL = \"https://github.com/a/b\"\r\n").as_deref(), Some("https://github.com/a/b"));
    }

    fn write(p: &Path, s: &str) {
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, s).unwrap();
    }

    #[test]
    fn 資料夾往上找_git_子資料夾也認得() {
        let t = tempfile::tempdir().unwrap();
        write(&t.path().join(".git/config"), "[remote \"origin\"]\n\turl = https://github.com/Yooliang/asn.git\n");
        std::fs::create_dir_all(t.path().join("a/b")).unwrap();
        assert_eq!(repo_of_dir(t.path()).as_deref(), Some("Yooliang/asn"));
        assert_eq!(repo_of_dir(&t.path().join("a/b")).as_deref(), Some("Yooliang/asn"));
    }

    #[test]
    fn worktree_跟著_gitdir_與_commondir_找共用設定() {
        let t = tempfile::tempdir().unwrap();
        write(&t.path().join("main/.git/config"), "[remote \"origin\"]\n\turl = git@github.com:Yooliang/asn.git\n");
        write(&t.path().join("main/.git/worktrees/wt/commondir"), "../..\n");
        let gd = t.path().join("main/.git/worktrees/wt");
        write(&t.path().join("wt/.git"), &format!("gitdir: {}\n", gd.to_string_lossy()));
        assert_eq!(repo_of_dir(&t.path().join("wt")).as_deref(), Some("Yooliang/asn"));
        // 相對路徑的 gitdir
        write(&t.path().join("wt2/.git"), "gitdir: ../main/.git/worktrees/wt\n");
        assert_eq!(repo_of_dir(&t.path().join("wt2")).as_deref(), Some("Yooliang/asn"));
    }

    #[test]
    fn gitdir_或_commondir_指到網路路徑_一律不跟() {
        assert!(local_target_ok("C:/x/.git/worktrees/a") && local_target_ok("../main/.git") && local_target_ok("/home/u/.git"));
        for bad in [
            "\\\\host\\share\\.git", "//host/share/.git", "\\\\?\\UNC\\host\\share\\.git", "  \\\\host\\s",
            "\\\\?\\C:\\x\\.git", "\\\\.\\C:\\x", "\\\\?\\unc\\h\\s", "//?/C:/x", "//./pipe/x", "\\??\\C:\\x",
        ] {
            assert!(!local_target_ok(bad), "{bad}");
        }
        let t = tempfile::tempdir().unwrap();
        for (i, bad) in ["\\\\host\\share\\repo\\.git", "//host/share/.git", "\\\\?\\C:\\x\\.git", "\\\\.\\C:\\x"].iter().enumerate() {
            write(&t.path().join(format!("w{i}/.git")), &format!("gitdir: {bad}\n"));
            let (reads, got) = recorded(&t.path().join(format!("w{i}")));
            assert_eq!(got, None, "gitdir {bad} 不跟");
            assert_eq!(reads, vec![t.path().join(format!("w{i}/.git"))], "只讀過那個 .git 檔，沒去讀其他東西");
        }
        write(&t.path().join("main/.git/worktrees/wt/commondir"), "//host/share/.git\n");
        write(&t.path().join("w9/.git"), "gitdir: ../main/.git/worktrees/wt\n");
        assert_eq!(repo_of_dir(&t.path().join("w9")), None, "commondir 是網路路徑就不跟");
        write(&t.path().join("main/.git/worktrees/wt/commondir"), "\\\\?\\C:\\x\\.git\n");
        assert_eq!(repo_of_dir(&t.path().join("w9")), None, "commondir 是裝置路徑就不跟");
    }

    /// 記錄讀過哪些檔的 repo_of_dir
    fn recorded(dir: &Path) -> (Vec<PathBuf>, Option<String>) {
        let log = std::cell::RefCell::new(Vec::new());
        let got = repo_of_dir_with(dir, &|p: &Path| {
            log.borrow_mut().push(p.to_path_buf());
            read_small(p)
        });
        (log.into_inner(), got)
    }

    const CFG: &str = "[remote \"origin\"]\n\turl = git@github.com:Yooliang/asn.git\n";

    #[test]
    fn 路徑只在字面上消掉_點與點點_不碰檔案系統() {
        let p = |s: &str| lexical(Path::new(s)).map(|x| x.to_string_lossy().replace('\\', "/"));
        assert_eq!(p("/a/b/./c/../d").as_deref(), Some("/a/b/d"));
        assert_eq!(p("a/./b/..").as_deref(), Some("a"));
        assert_eq!(p("/a/../.."), None, "退到根以上就不要");
        assert_eq!(p("../x"), None, "相對路徑一開頭就往上也不要");
        // 不存在的路徑也照樣算得出來（證明沒去碰檔案系統）
        assert_eq!(p("/沒有這個資料夾/x/../y").as_deref(), Some("/沒有這個資料夾/y"));
    }

    #[test]
    fn gitdir_用點點繞出_git_底下_一律_none() {
        let t = tempfile::tempdir().unwrap();
        write(&t.path().join("main/.git/config"), CFG);
        write(&t.path().join("other/config"), CFG);
        // 字面上先進 .git/worktrees 再用 .. 繞到外面：正規化後不在 .git/worktrees 底下
        write(&t.path().join("w/.git"), "gitdir: ../main/.git/worktrees/x/../../../other\n");
        let (read, got) = recorded(&t.path().join("w"));
        assert_eq!(got, None);
        assert!(!read.iter().any(|p| p.ends_with("other/config")), "沒讀到外面的設定：{read:?}");
    }

    #[test]
    fn gitdir_指到_repo_外_或_commondir_指到別的_git_一律_none_且不讀它的設定() {
        let t = tempfile::tempdir().unwrap();
        // 別的資料夾裡任意的 config
        write(&t.path().join("elsewhere/config"), CFG);
        write(&t.path().join("elsewhere/commondir"), ".\n");
        write(&t.path().join("w1/.git"), &format!("gitdir: {}\n", t.path().join("elsewhere").to_string_lossy()));
        let (reads, got) = recorded(&t.path().join("w1"));
        assert_eq!(got, None, "gitdir 不在 .git/worktrees 或 .git/modules 底下");
        assert!(!reads.iter().any(|p| p.ends_with("config") || p.ends_with("commondir")), "{reads:?}");
        // 在 .git 底下但不是 worktrees/<名>、modules
        write(&t.path().join("main/.git/config"), CFG);
        write(&t.path().join("main/.git/hooks/commondir"), "..\n");
        write(&t.path().join("w2/.git"), &format!("gitdir: {}\n", t.path().join("main/.git/hooks").to_string_lossy()));
        assert_eq!(recorded(&t.path().join("w2")).1, None, "gitdir 在 .git 底下但不是 worktrees／modules");
        // commondir 指到別的 .git
        write(&t.path().join("other/.git/config"), CFG);
        write(&t.path().join("main/.git/worktrees/wt/commondir"), "../../../../other/.git\n");
        write(&t.path().join("w3/.git"), "gitdir: ../main/.git/worktrees/wt\n");
        let (reads, got) = recorded(&t.path().join("w3"));
        assert_eq!(got, None, "commondir 不是這個 repo 的 .git");
        assert!(!reads.iter().any(|p| p.ends_with("config")), "{reads:?}");
        // 對照：commondir 正確就找得到
        write(&t.path().join("main/.git/worktrees/wt/commondir"), "../..\n");
        assert_eq!(recorded(&t.path().join("w3")).1.as_deref(), Some("Yooliang/asn"));
        // commondir 沒寫、又不在 modules 底下
        std::fs::remove_file(t.path().join("main/.git/worktrees/wt/commondir")).unwrap();
        assert_eq!(recorded(&t.path().join("w3")).1, None);
    }

    #[test]
    fn submodule_的_gitdir_在_modules_底下可以讀() {
        let t = tempfile::tempdir().unwrap();
        write(&t.path().join("super/.git/modules/sub/config"), CFG);
        write(&t.path().join("super/sub/.git"), "gitdir: ../.git/modules/sub\n");
        assert_eq!(repo_of_dir(&t.path().join("super/sub")).as_deref(), Some("Yooliang/asn"));
    }

    #[test]
    fn config_是資料夾或連結_不讀() {
        let t = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(t.path().join("a/.git/config")).unwrap();
        let (reads, got) = recorded(&t.path().join("a"));
        assert_eq!(got, None, "config 是資料夾");
        assert!(reads.is_empty(), "{reads:?}");
        // 共用的 config 是資料夾（worktree 路線）
        std::fs::create_dir_all(t.path().join("main/.git/config")).unwrap();
        write(&t.path().join("main/.git/worktrees/wt/commondir"), "../..\n");
        write(&t.path().join("w/.git"), "gitdir: ../main/.git/worktrees/wt\n");
        assert_eq!(recorded(&t.path().join("w")).1, None);
        // 連結：建不起來（Windows 沒權限）就略過這段斷言
        write(&t.path().join("real-config"), CFG);
        write(&t.path().join("b/.git/HEAD"), "x");
        #[cfg(unix)]
        let linked = std::os::unix::fs::symlink(t.path().join("real-config"), t.path().join("b/.git/config")).is_ok();
        #[cfg(windows)]
        let linked = std::os::windows::fs::symlink_file(t.path().join("real-config"), t.path().join("b/.git/config")).is_ok();
        if linked {
            let (reads, got) = recorded(&t.path().join("b"));
            assert_eq!(got, None, "config 是連結");
            assert!(reads.is_empty(), "{reads:?}");
        }
    }

    #[test]
    fn 沒有_git_沒有_origin_不是_github_都是_none() {
        let t = tempfile::tempdir().unwrap();
        assert_eq!(repo_of_dir(t.path()), None, "不是 git 資料夾");
        write(&t.path().join("a/.git/config"), "[core]\n\tbare = false\n");
        assert_eq!(repo_of_dir(&t.path().join("a")), None, "沒有 origin");
        write(&t.path().join("b/.git/config"), "[remote \"origin\"]\n\turl = https://gitlab.com/o/r.git\n");
        assert_eq!(repo_of_dir(&t.path().join("b")), None, "不是 github.com");
        write(&t.path().join("c/.git"), "壞掉的內容\n");
        assert_eq!(repo_of_dir(&t.path().join("c")), None, ".git 檔案格式怪");
        assert_eq!(repo_of_dir(&t.path().join("不存在的資料夾")), None);
    }

    #[test]
    fn 名單上沒有的視窗名或空資料夾一律_none_不探測任意路徑() {
        let t = tempfile::tempdir().unwrap();
        write(&t.path().join(".git/config"), "[remote \"origin\"]\n\turl = https://github.com/Yooliang/asn.git\n");
        let dir = t.path().to_string_lossy().into_owned();
        let windows = vec![("T-甲".to_string(), dir.clone()), ("T-空".to_string(), String::new())];
        let c = Cache::default();
        let now = Instant::now();
        assert_eq!(repo_for_window(&windows, "T-甲", &c, now).as_deref(), Some("Yooliang/asn"));
        assert_eq!(repo_for_window(&windows, "T-乙", &c, now), None, "名單上沒有");
        assert_eq!(repo_for_window(&windows, &dir, &c, now), None, "拿路徑當名字也不行");
        assert_eq!(repo_for_window(&windows, "T-空", &c, now), None, "沒有工作資料夾");
        assert_eq!(repo_for_window(&[], "T-甲", &c, now), None);
    }

    #[test]
    fn 快取五分鐘內不重讀_過期才重讀() {
        let c = Cache::default();
        let t0 = Instant::now();
        let mut calls = 0;
        let load = |v: &'static str, calls: &mut i32| { *calls += 1; Some(v.to_string()) };
        assert_eq!(c.get_or_load("d", t0, || load("a/b", &mut calls)).as_deref(), Some("a/b"));
        assert_eq!(c.get_or_load("d", t0 + Duration::from_secs(299), || load("c/d", &mut calls)).as_deref(), Some("a/b"), "5 分鐘內用快取");
        assert_eq!(calls, 1);
        assert_eq!(c.get_or_load("d", t0 + Duration::from_secs(301), || load("c/d", &mut calls)).as_deref(), Some("c/d"), "過期重讀");
        assert_eq!(calls, 2);
        // 讀不到（None）也記，不每次重讀
        let mut n = 0;
        assert_eq!(c.get_or_load("x", t0, || { n += 1; None }), None);
        assert_eq!(c.get_or_load("x", t0, || { n += 1; None }), None);
        assert_eq!(n, 1);
    }
}

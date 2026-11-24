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

/// `.git` 檔裡的 gitdir、commondir 只准指到本機路徑：網路路徑（`\\主機\…`、`//主機/…`、`\\?\UNC\…`）一律不跟，
/// 免得只為了認出 repo 就去連別台主機。
fn local_target_ok(p: &str) -> bool {
    let s = p.trim();
    !(s.starts_with("\\\\") || s.starts_with("//") || s.to_ascii_lowercase().starts_with("\\\\?\\unc\\"))
}

/// 從資料夾往上找 .git，回要讀的 git 設定檔路徑。.git 是檔案（git worktree）時，跟著「gitdir:」找到真正的 git 資料夾，
/// 再跟著它的 commondir 找到共用的設定檔（worktree 的 remote 設定在共用的那份）。
fn git_config_path(start: &Path) -> Option<PathBuf> {
    let mut dir = Some(start);
    for _ in 0..UP_MAX {
        let d = dir?;
        let dot = d.join(".git");
        if dot.is_dir() {
            return Some(dot.join("config"));
        }
        if dot.is_file() {
            let text = read_small(&dot)?;
            let target = text.lines().next()?.trim().strip_prefix("gitdir:")?.trim().to_string();
            if !local_target_ok(&target) {
                return None;
            }
            let gitdir = if Path::new(&target).is_absolute() { PathBuf::from(&target) } else { d.join(&target) };
            let common = match read_small(&gitdir.join("commondir")) {
                Some(c) if !c.trim().is_empty() => {
                    let c = c.trim();
                    if !local_target_ok(c) {
                        return None;
                    }
                    if Path::new(c).is_absolute() { PathBuf::from(c) } else { gitdir.join(c) }
                }
                _ => gitdir,
            };
            return Some(common.join("config"));
        }
        dir = d.parent();
    }
    None
}

/// 資料夾對應的 GitHub 倉庫（擁有者/倉庫）；讀不到或不是 github.com 就是 None
pub fn repo_of_dir(dir: &Path) -> Option<String> {
    let text = read_small(&git_config_path(dir)?)?;
    github_repo_from_url(&origin_url_from_config(&text)?)
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
        for bad in ["\\\\host\\share\\.git", "//host/share/.git", "\\\\?\\UNC\\host\\share\\.git", "  \\\\host\\s"] {
            assert!(!local_target_ok(bad), "{bad}");
        }
        let t = tempfile::tempdir().unwrap();
        write(&t.path().join("w1/.git"), "gitdir: \\\\host\\share\\repo\\.git\n");
        assert_eq!(repo_of_dir(&t.path().join("w1")), None, "gitdir 是網路路徑就不讀");
        write(&t.path().join("main/.git/worktrees/wt/commondir"), "//host/share/.git\n");
        write(&t.path().join("w2/.git"), "gitdir: ../main/.git/worktrees/wt\n");
        assert_eq!(repo_of_dir(&t.path().join("w2")), None, "commondir 是網路路徑就不讀");
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

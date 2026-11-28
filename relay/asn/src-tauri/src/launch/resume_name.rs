//! 接回一位 Claude 夥伴時要用的名字與帶不帶 `-n`（#2493，唯一出口）。
//! 名字的正本是對話檔裡最後一筆標題（`custom-title`／`agent-name`）；known-windows、終端對照表、手機名單裡的名字都是副本，
//! 可能還是舊名。接回時帶 `-n <舊名>` 會把對話名字改回舊的，所以：對話有名字就**不帶 -n**（Claude 接續時保留原名），
//! 之後 ASN 這邊用到名字的地方（視窗標題、登記、`--remote-control`）一律用這裡回的 `name`。
//! 只有對話本身沒有名字、或讀不到對話檔時，才維持舊做法（帶 `-n <存檔名>`）。
use std::path::{Path, PathBuf};

/// 名字從哪來（只給記錄用）
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Source {
    /// 對話檔裡的現名
    Current,
    /// 對話檔讀得到，但對話本身沒有名字：用存檔名
    Stored,
    /// 找不到對話檔：用存檔名
    Unreadable,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ResumeName {
    /// 之後 ASN 這邊要用的名字（視窗標題、登記、`--remote-control` 的值、回報名單）
    pub name: String,
    /// 要不要帶 `-n <name>`：只有對話本身沒有名字（或讀不到）才帶；對話有名字一律不帶，蓋不到正本
    pub pass_n: bool,
    pub source: Source,
}

/// 用對話編號找對話檔：有資料夾就直接算，沒有（或不在那裡）就掃 projects 底下每個資料夾找 `<編號>.jsonl`
fn find_transcript_file(projects_root: &Path, session: &str, cwd: Option<&str>) -> Option<PathBuf> {
    let file = format!("{session}.jsonl");
    if let Some(dir) = cwd.filter(|c| !c.trim().is_empty()).and_then(|c| super::resume::find_project_dir(projects_root, c)) {
        let p = dir.join(&file);
        if p.is_file() {
            return Some(p);
        }
    }
    std::fs::read_dir(projects_root).ok()?.flatten().map(|e| e.path().join(&file)).find(|p| p.is_file())
}

/// 接回一位 Claude 夥伴時用的名字（唯一出口）。`stored`＝ASN 存的名字（副本）。
/// 現名與存檔名不同、或讀不到現名時各記一行 log，不靜默
pub(crate) fn resume_name(projects_root: &Path, session: &str, cwd: Option<&str>, stored: &str) -> ResumeName {
    let fallback = |source: Source| ResumeName { name: stored.to_string(), pass_n: true, source };
    if !crate::bridge::roster::valid_sid(session) {
        elog!("[接回] 對話編號格式不對，名字照存檔用：{stored}");
        return fallback(Source::Unreadable);
    }
    let Some(path) = find_transcript_file(projects_root, session, cwd) else {
        elog!("[接回] 找不到對話檔，名字照存檔用（帶 -n）：對話 {session}、存檔名 {stored}");
        return fallback(Source::Unreadable);
    };
    match super::resume::last_title(&path).map(|(n, _)| n).filter(|n| !n.trim().is_empty()) {
        Some(current) => {
            if current != stored {
                elog!("[接回] 存檔名與對話現名不同，用現名且不帶 -n：對話 {session}、存檔名 {stored}、現名 {current}");
            }
            ResumeName { name: current, pass_n: false, source: Source::Current }
        }
        None => fallback(Source::Stored),
    }
}

/// 真實環境：Claude 設定資料夾的 projects。找不到設定資料夾就當讀不到對話檔
pub(crate) fn resume_name_real(session: &str, cwd: Option<&str>, stored: &str) -> ResumeName {
    match projects_root_real() {
        Some(root) => resume_name(&root, session, cwd, stored),
        None => {
            elog!("[接回] 找不到 Claude 設定資料夾，名字照存檔用（帶 -n）：對話 {session}、存檔名 {stored}");
            ResumeName { name: stored.to_string(), pass_n: true, source: Source::Unreadable }
        }
    }
}

pub(crate) fn projects_root_real() -> Option<PathBuf> {
    super::console::sessions_dir().and_then(|d| d.parent().map(|p| p.join("projects")))
}

/// 把啟動參數裡的名字換成接回該用的：`-n`／`--name` 只在 `pass_n` 時留（值換成 name），否則整組拿掉；
/// `--remote-control <值>` 的值一律換成 name。其餘參數原樣。只有接回路徑用（開新夥伴不經這裡）
pub(crate) fn apply_to_args(args: &[String], rn: &ResumeName) -> Vec<String> {
    let mut out = Vec::with_capacity(args.len());
    let mut i = 0;
    while i < args.len() {
        let a = args[i].as_str();
        let has_value = args.get(i + 1).is_some_and(|v| !v.starts_with('-'));
        match a {
            "-n" | "--name" => {
                if rn.pass_n {
                    out.extend(["-n".to_string(), rn.name.clone()]);
                }
                i += if has_value { 2 } else { 1 };
            }
            "--remote-control" => {
                out.push(args[i].clone());
                if has_value {
                    out.push(rn.name.clone());
                    i += 2;
                } else {
                    i += 1;
                }
            }
            _ if a.starts_with("--name=") => {
                if rn.pass_n {
                    out.extend(["-n".to_string(), rn.name.clone()]);
                }
                i += 1;
            }
            _ if a.starts_with("--remote-control=") => {
                out.push(format!("--remote-control={}", rn.name));
                i += 1;
            }
            _ => {
                out.push(args[i].clone());
                i += 1;
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(v: &[&str]) -> Vec<String> {
        v.iter().map(|x| x.to_string()).collect()
    }

    /// 假的 projects 資料夾：放一個對話檔，titles 依序寫入
    pub(crate) fn mk_transcript(root: &Path, cwd: &str, sid: &str, titles: &[&str]) {
        let d = root.join(super::super::resume::project_dir_name(cwd));
        std::fs::create_dir_all(&d).unwrap();
        let mut text = String::from("{\"type\":\"user\",\"message\":\"hi\"}\n");
        for t in titles {
            text.push_str(&format!("{{\"type\":\"custom-title\",\"customTitle\":\"{t}\",\"sessionId\":\"{sid}\"}}\n"));
        }
        std::fs::write(d.join(format!("{sid}.jsonl")), text).unwrap();
    }

    const SID: &str = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";

    #[test]
    fn 對話有現名_用現名_不帶n() {
        let d = tempfile::tempdir().unwrap();
        mk_transcript(d.path(), "/w/p", SID, &["舊名", "新名"]);
        for cwd in [Some("/w/p"), None, Some("/別的/資料夾")] {
            let r = resume_name(d.path(), SID, cwd, "舊名");
            assert_eq!(r, ResumeName { name: "新名".into(), pass_n: false, source: Source::Current }, "cwd={cwd:?}");
        }
    }

    #[test]
    fn 對話沒有名字_帶n用存檔名() {
        let d = tempfile::tempdir().unwrap();
        mk_transcript(d.path(), "/w/p", SID, &[]);
        let r = resume_name(d.path(), SID, Some("/w/p"), "存檔名");
        assert_eq!(r, ResumeName { name: "存檔名".into(), pass_n: true, source: Source::Stored });
    }

    #[test]
    fn 讀不到對話檔_照舊用存檔名_帶n() {
        let d = tempfile::tempdir().unwrap();
        let r = resume_name(d.path(), SID, Some("/w/p"), "存檔名");
        assert_eq!(r, ResumeName { name: "存檔名".into(), pass_n: true, source: Source::Unreadable });
        // 編號格式不對：不當檔名用
        assert_eq!(resume_name(d.path(), "../x", None, "存檔名").source, Source::Unreadable);
    }

    #[test]
    fn 參數換名字_有名字就拿掉n_遙控換現名() {
        let rn = ResumeName { name: "新名".into(), pass_n: false, source: Source::Current };
        let a = s(&["--dangerously-skip-permissions", "-n", "舊名", "--remote-control", "舊名", "--model", "opus"]);
        assert_eq!(apply_to_args(&a, &rn), s(&["--dangerously-skip-permissions", "--remote-control", "新名", "--model", "opus"]));
        let rn = ResumeName { name: "存檔名".into(), pass_n: true, source: Source::Stored };
        assert_eq!(apply_to_args(&a, &rn), s(&["--dangerously-skip-permissions", "-n", "存檔名", "--remote-control", "存檔名", "--model", "opus"]));
        // 沒有值的 --remote-control 不亂補
        assert_eq!(apply_to_args(&s(&["--remote-control", "--model", "x"]), &rn), s(&["--remote-control", "--model", "x"]));
    }
}

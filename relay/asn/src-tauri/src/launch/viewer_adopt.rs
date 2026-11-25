//! 重開 ASN 後認回還開著的「看畫面的 GUI」（#2309）。
//!
//! 看 mux 窗格的 GUI（`wezterm-gui connect`）登記在 ASN 的記憶體裡（`viewers`）；只重開 ASN、整台沒重開機時，
//! 登記清空，但原本的 GUI 視窗還在。這裡把「命令列 → 哪位夥伴」的判斷抽成純函式：
//! GUI 的命令列長這樣（見 `term::view_args`）：
//! `wezterm-gui --config-file <mux.lua> --config initial_cols=N --config initial_rows=N connect asn --workspace asn-{編號}`
//!
//! 只認這個 ASN 自己的服務：`--config-file` 要指到這個 ASN 的 mux.lua、連的 domain 要是 `asn`。
//! 別的設定檔、別的 domain、使用者自己開的 wezterm 一律不收。不碰任何程序，只做判斷。
use std::path::Path;

/// 掃到的一個 wezterm-gui 程序
#[derive(Clone, Debug, PartialEq)]
pub struct GuiProc {
    pub pid: u32,
    /// 建立時間（毫秒）；後續關窗偵測靠「編號＋建立時間」對得上才算同一個
    pub started_ms: u64,
    /// 命令列（含第 0 項執行檔）
    pub cmdline: Vec<String>,
}

/// 認回的結果：這位夥伴（終端編號）的畫面就是這個程序
#[derive(Clone, Debug, PartialEq)]
pub struct Found {
    pub id: String,
    pub pid: u32,
    pub started_ms: u64,
}

/// 判斷結果：認回的，加上沒收的原因（只給 log，不含命令列原文）
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Plan {
    pub found: Vec<Found>,
    pub skipped: Vec<String>,
}

fn norm(p: &str) -> String {
    p.replace('\\', "/").trim_end_matches('/').to_lowercase()
}

/// 命令列若是「連到 ASN 自己的服務、看某個 workspace」就回 workspace 名；格式不對、設定檔不是這個 ASN 的、連別的 domain 都回 None
pub fn view_workspace(cmdline: &[String], config: &Path) -> Option<String> {
    let ci = cmdline.iter().position(|a| a == "--config-file")?;
    let cfg = cmdline.get(ci + 1)?;
    if norm(cfg) != norm(&config.to_string_lossy()) {
        return None;
    }
    let ki = cmdline.iter().position(|a| a == "connect")?;
    if cmdline.get(ki + 1).map(String::as_str) != Some("asn") {
        return None;
    }
    let tail = &cmdline[ki + 2..];
    let wi = tail.iter().position(|a| a == "--workspace")?;
    let ws = tail.get(wi + 1)?;
    (!ws.is_empty() && !ws.starts_with('-')).then(|| ws.clone())
}

/// 把掃到的 GUI 對回夥伴。
/// - `known`：現在名單上、開在服務裡的夥伴（終端編號, workspace）
/// - `already`：已經登記著的終端編號（不重複登記）
/// 同一位夥伴有兩扇以上的 GUI：只收最早開的那一個（之後「關畫面」只結束登記的這一個），其餘寫進 skipped
pub fn plan(procs: &[GuiProc], config: &Path, known: &[(String, String)], already: &[String]) -> Plan {
    let mut out = Plan::default();
    let mut ordered: Vec<&GuiProc> = procs.iter().collect();
    ordered.sort_by_key(|p| (p.started_ms, p.pid));
    for p in ordered {
        let Some(ws) = view_workspace(&p.cmdline, config) else {
            out.skipped.push(format!("pid={} 不是這個 ASN 的看畫面視窗", p.pid));
            continue;
        };
        let Some((id, _)) = known.iter().find(|(_, w)| *w == ws) else {
            out.skipped.push(format!("pid={} 對不到名單上的夥伴", p.pid));
            continue;
        };
        if already.contains(id) || out.found.iter().any(|f| f.id == *id) {
            out.skipped.push(format!("pid={} 這位夥伴已經有一個畫面了（id={id}）", p.pid));
            continue;
        }
        out.found.push(Found { id: id.clone(), pid: p.pid, started_ms: p.started_ms });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn cfg() -> PathBuf {
        PathBuf::from(r"C:\U\ASN\m\mux.lua")
    }

    fn cmd(config: &str, domain: &str, ws: &str) -> Vec<String> {
        ["wezterm-gui.exe", "--config-file", config, "--config", "initial_cols=120", "--config", "initial_rows=40", "connect", domain, "--workspace", ws].iter().map(|s| s.to_string()).collect()
    }

    fn gui(pid: u32, at: u64, ws: &str) -> GuiProc {
        GuiProc { pid, started_ms: at, cmdline: cmd(r"C:\U\ASN\m\mux.lua", "asn", ws) }
    }

    fn known() -> Vec<(String, String)> {
        vec![("3".into(), "asn-3".into()), ("4".into(), "asn-4".into())]
    }

    #[test]
    fn 對得上_回夥伴編號_pid_與建立時間() {
        let p = plan(&[gui(10, 500, "asn-3")], &cfg(), &known(), &[]);
        assert_eq!(p.found, vec![Found { id: "3".into(), pid: 10, started_ms: 500 }]);
        assert!(p.skipped.is_empty());
    }

    #[test]
    fn 設定檔路徑大小寫與斜線不同也算同一個() {
        let g = GuiProc { pid: 1, started_ms: 1, cmdline: cmd("c:/u/asn/m/MUX.LUA", "asn", "asn-4") };
        assert_eq!(plan(&[g], &cfg(), &known(), &[]).found.len(), 1);
    }

    #[test]
    fn 不是自己的_domain_或設定檔_不收() {
        let other_domain = GuiProc { pid: 1, started_ms: 1, cmdline: cmd(r"C:\U\ASN\m\mux.lua", "別人", "asn-3") };
        let other_cfg = GuiProc { pid: 2, started_ms: 1, cmdline: cmd(r"C:\Users\x\.wezterm.lua", "asn", "asn-3") };
        let user_own = GuiProc { pid: 3, started_ms: 1, cmdline: vec!["wezterm-gui.exe".into(), "start".into()] };
        let p = plan(&[other_domain, other_cfg, user_own], &cfg(), &known(), &[]);
        assert!(p.found.is_empty());
        assert_eq!(p.skipped.len(), 3);
    }

    #[test]
    fn 格式不對_不收也不當掉() {
        let c = r"C:\U\ASN\m\mux.lua".to_string();
        let w = |v: &[&str]| -> Vec<String> { std::iter::once("wezterm-gui.exe".to_string()).chain(std::iter::once("--config-file".to_string())).chain(std::iter::once(c.clone())).chain(v.iter().map(|s| s.to_string())).collect() };
        for bad in [
            vec![],
            vec!["wezterm-gui.exe".to_string(), "--config-file".into()],
            w(&["connect"]),
            w(&["connect", "asn"]),
            w(&["connect", "asn", "--workspace"]),
            w(&["connect", "asn", "--workspace", "--x"]),
        ] {
            assert_eq!(view_workspace(&bad, &cfg()), None, "{bad:?}");
            assert!(plan(&[GuiProc { pid: 1, started_ms: 1, cmdline: bad }], &cfg(), &known(), &[]).found.is_empty());
        }
    }

    #[test]
    fn 同一位夥伴兩扇_gui_只收最早的() {
        let p = plan(&[gui(20, 900, "asn-3"), gui(10, 500, "asn-3")], &cfg(), &known(), &[]);
        assert_eq!(p.found, vec![Found { id: "3".into(), pid: 10, started_ms: 500 }]);
        assert_eq!(p.skipped.len(), 1);
    }

    #[test]
    fn 夥伴已經不在名單上_不收() {
        let p = plan(&[gui(10, 500, "asn-9")], &cfg(), &known(), &[]);
        assert!(p.found.is_empty());
        assert_eq!(p.skipped.len(), 1);
    }

    #[test]
    fn 已經登記著的夥伴_不重複登記() {
        let p = plan(&[gui(10, 500, "asn-3"), gui(11, 600, "asn-4")], &cfg(), &known(), &["3".into()]);
        assert_eq!(p.found, vec![Found { id: "4".into(), pid: 11, started_ms: 600 }]);
    }
}

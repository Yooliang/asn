//! 登記表守門測試（#2163 PR-1）。掃描器本身的自我測試在 `scan.rs`。
use super::scan::{rs_files, scan_source, stripped};
use super::*;
use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

fn manifest() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}
fn src_dir() -> PathBuf {
    manifest().join("src")
}
fn rel(p: &Path) -> String {
    p.strip_prefix(src_dir()).or_else(|_| p.strip_prefix(manifest())).unwrap_or(p).to_string_lossy().replace('\\', "/")
}

/// 要掃的檔：src 與 tests 底下所有 .rs，但不含登記表自己（`flags/`，裡面本來就寫滿所有名字）
fn scan_files() -> Vec<(String, String)> {
    let mut out = vec![];
    for dir in [src_dir(), manifest().join("tests")] {
        for f in rs_files(&dir) {
            let r = rel(&f);
            if r.starts_with("flags/") {
                continue;
            }
            out.push((r, std::fs::read_to_string(&f).unwrap()));
        }
    }
    out
}

#[test]
fn 登記表的欄位都合規() {
    let mut seen = BTreeSet::new();
    let mut bad = vec![];
    for f in FLAGS {
        if !seen.insert(f.name) {
            bad.push(format!("{} 重複登記", f.name));
        }
        if !f.name.starts_with("ASN_") || !f.name.chars().all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == '_') {
            bad.push(format!("{} 不是 ASN_ 大寫名", f.name));
        }
        if let Some(l) = f.legacy {
            if !l.starts_with("IRORI_") {
                bad.push(format!("{} 舊名 {l} 不是 IRORI_ 開頭", f.name));
            }
        }
        for (what, v) in [("預設", f.default), ("用途", f.purpose)] {
            if v.trim().is_empty() || v.contains('|') || v.contains('\n') {
                bad.push(format!("{} 的{what}是空的，或含直線符號／換行（文件表格會壞）", f.name));
            }
        }
        if f.readers.is_empty() {
            bad.push(format!("{} 沒寫讀者檔案", f.name));
        }
        match (f.kind, f.pin) {
            (Kind::Prod, Pin::Na) => bad.push(format!("{} 是正式分類，預設值要釘住或寫明沒釘的原因", f.name)),
            (Kind::Prod, Pin::Unpinned(r)) if r.trim().is_empty() => bad.push(format!("{} 沒釘測試卻沒寫原因", f.name)),
            (k, Pin::Value(_) | Pin::Unpinned(_)) if k != Kind::Prod => bad.push(format!("{} 非正式分類不該有釘測試欄", f.name)),
            _ => {}
        }
        if f.secret && f.kind != Kind::Prod {
            bad.push(format!("{} 機密只會出現在正式分類", f.name));
        }
    }
    assert!(bad.is_empty(), "登記表有問題：\n{}", bad.join("\n"));
    assert!(FLAGS.len() > 100, "登記表筆數異常少（{}）", FLAGS.len());
}

#[test]
fn 登記表與_envc_pairs_互相一致() {
    let mut bad = vec![];
    for (new, old) in crate::envc::PAIRS {
        match find(new) {
            None => bad.push(format!("PAIRS 的 {new} 沒登記在登記表")),
            Some(f) if f.legacy != Some(*old) => bad.push(format!("{new} 舊名不一致：登記表 {:?}、PAIRS {old}", f.legacy)),
            _ => {}
        }
    }
    for f in FLAGS {
        if let Some(l) = f.legacy {
            if crate::envc::legacy(f.name) != Some(l) {
                bad.push(format!("{} 登記了舊名 {l}，但 PAIRS 沒有（或不同）", f.name));
            }
        }
    }
    // 機密：登記表的 secret 與 envc::SECRET_NAMES 的新名一一對應
    let secrets: BTreeSet<&str> = FLAGS.iter().filter(|f| f.secret).map(|f| f.name).collect();
    let envc_secrets: BTreeSet<&str> = crate::envc::SECRET_NAMES.iter().copied().filter(|n| n.starts_with("ASN_")).collect();
    if secrets != envc_secrets {
        bad.push(format!("機密名單不一致：登記表 {secrets:?}、envc::SECRET_NAMES {envc_secrets:?}"));
    }
    assert!(bad.is_empty(), "登記表與 envc 對不上：\n{}", bad.join("\n"));
}

#[test]
fn 守門_原始碼出現的每個_asn_名字都要登記() {
    let mut bad = vec![];
    for (file, text) in scan_files() {
        for h in scan_source(&text) {
            if h.dynamic {
                if !DYNAMIC_OK.iter().any(|(f, t, _)| *f == file && *t == h.text) {
                    bad.push(format!("{file}:{} 動態組名「{}」沒有放行（用 concat!／format! 拼環境變數名要明講，見 table.rs 的 DYNAMIC_OK）", h.line, h.text));
                }
            } else if find(&h.text).is_none() && !NOT_ENV.iter().any(|(n, _, _)| *n == h.text) {
                bad.push(format!("{file}:{} {} 沒登記在 flags::FLAGS（新增環境變數要在 flags/table.rs 加一列）", h.line, h.text));
            }
        }
    }
    assert!(bad.is_empty(), "原始碼有沒登記的 ASN_ 名字：\n{}", bad.join("\n"));
}

#[test]
fn 守門_登記的名字原始碼都還找得到() {
    // envc.rs 的 PAIRS 本身就寫滿所有舊相容名字，不能拿它當「還有人在用」的證據，所以不算
    let files: Vec<(String, String)> = scan_files().into_iter().filter(|(f, _)| f != "envc.rs").collect();
    let found: BTreeSet<String> = files.iter().flat_map(|(_, t)| scan_source(t)).filter(|h| !h.dynamic).map(|h| h.text).collect();
    let mut dead: Vec<String> = FLAGS.iter().filter(|f| !found.contains(f.name)).map(|f| f.name.to_string()).collect();
    dead.extend(NOT_ENV.iter().filter(|(n, _, _)| !found.contains(*n)).map(|(n, _, _)| format!("{n}（NOT_ENV）")));
    assert!(dead.is_empty(), "這些登記在原始碼已經找不到（登記表沒跟著清）：{dead:?}");
}

#[test]
fn 守門_登記的讀者檔案真的有這個名字() {
    let files = scan_files();
    let mut bad = vec![];
    for f in FLAGS {
        for r in f.readers {
            match files.iter().find(|(p, _)| p == r) {
                None => bad.push(format!("{} 的讀者檔 {r} 不存在", f.name)),
                Some((_, t)) if !stripped(t).contains(f.name) => bad.push(format!("{} 的讀者檔 {r} 裡找不到這個名字", f.name)),
                _ => {}
            }
        }
    }
    for (n, file, _) in NOT_ENV {
        match files.iter().find(|(p, _)| p == file) {
            Some((_, t)) if stripped(t).contains(n) => {}
            _ => bad.push(format!("NOT_ENV 的 {n} 在 {file} 找不到")),
        }
    }
    assert!(bad.is_empty(), "讀者欄對不上：\n{}", bad.join("\n"));
}

// ---- 預設值釘住 ------------------------------------------------------------------------

/// 讀取函式在沒設定時的回傳值（轉成文字）。不是「釘住」的名字回 None。
fn pinned_value(name: &str, bridge: &crate::bridge::core::Config, aegis: &crate::bridge::engines::aegis::AegisCfg) -> Option<String> {
    let platform_default = || {
        let (w, m) = crate::launch::win_term::switches_from(None, None);
        if (w, m) == (cfg!(windows), cfg!(windows)) {
            "Windows 開、其他平台關".to_string()
        } else {
            format!("實際 wezterm={w} mux={m}")
        }
    };
    Some(match name {
        "ASN_RELAY_DEFAULT_AGENT" => bridge.default_agent.clone(),
        "ASN_RELAY_ALLOW" => bridge.extra_allow.join(","),
        "ASN_RELAY_POLL_MS" => bridge.poll_ms.to_string(),
        "ASN_ROSTER_MS" => {
            assert_eq!(bridge.roster_ms, bridge.engine_refresh_ms, "名單輪詢與引擎刷新要同值");
            bridge.roster_ms.to_string()
        }
        "ASN_BRIDGE_TICK_MS" => bridge.tick_ms.to_string(),
        "ASN_REPLY_TIMEOUT_MS" => bridge.reply_timeout_ms.to_string(),
        "ASN_LATE_KEEP_MS" => bridge.late_keep_ms.to_string(),
        "ASN_LATE_MAX" => bridge.late_max.to_string(),
        "ASN_NUDGE_MS" => bridge.nudge_ms.to_string(),
        "ASN_FORWARD_TIMEOUT_MS" => bridge.forward_timeout_ms.to_string(),
        "ASN_FORWARD_ONE_PER_TURN" => bridge.one_per_turn.to_string(),
        "ASN_ROOM_STAGGER_MS" => bridge.room_stagger_ms.to_string(),
        "ASN_MAILBOX_NAME" => bridge.mailbox_name.replace("NODE", "<節點>"),
        "ASN_MAILBOX_MODEL" => bridge.model.clone(),
        "ASN_WAIT_ALERT" => bridge.wait_alert.to_string(),
        "ASN_FORWARD_EXACT_UNVERIFIED" => bridge.forward_exact_unverified.to_string(),
        "ASN_FORWARD_EXACT" => crate::bridge::worker::forward_exact_enabled().to_string(),
        "ASN_AEGIS_URL" => aegis.url.clone(),
        "ASN_AEGIS_FROM_MEMBER" => aegis.from_member.clone(),
        "ASN_AEGIS_ALLOW" => aegis.allow.join(","),
        "ASN_AEGIS_SELF" => aegis.self_member.clone(),
        "ASN_AEGIS_DEFAULT" => aegis.default_member.clone(),
        "ASN_AEGIS_TIMEOUT_MS" => aegis.ask_timeout_ms.to_string(),
        "ASN_AEGIS_RETRY_MS" => aegis.retry_ms.to_string(),
        "ASN_RECV_HEARTBEAT_MS" => crate::heartbeat::heartbeat_ms().to_string(),
        "ASN_RECV_STALE_MS" => crate::heartbeat::stale_ms().to_string(),
        "ASN_CLI_UNATTENDED" => crate::cli::env::unattended_enabled(None, true, false).to_string(),
        "ASN_PULL_BACKOFF_MS" => crate::cli::env::DEFAULT_BACKOFF_MS.iter().map(|n| n.to_string()).collect::<Vec<_>>().join(","),
        "ASN_SEAL_NODE_KEY" => crate::secret_file::seal_node_key_from(None).to_string(),
        "ASN_TERM_WEZTERM" | "ASN_TERM_MUX" => platform_default(),
        "ASN_SCREEN_WATCH" => {
            if crate::launch::screen_watch::enabled(None) == cfg!(windows) {
                "Windows 開、其他平台關".to_string()
            } else {
                "實際與平台預設不符".to_string()
            }
        }
        _ => return None,
    })
}

#[test]
fn 正式變數的預設值釘住_與登記表寫的一致() {
    let dir = std::env::temp_dir().join("asn-flags-pin-unused");
    let bridge = crate::bridge::core::Config::from_env("NODE", dir);
    let aegis = crate::bridge::engines::aegis::AegisCfg::from_env(&[]);
    let mut bad = vec![];
    let mut skipped = vec![];
    let mut pinned = 0;
    for f in FLAGS {
        let got = pinned_value(f.name, &bridge, &aegis);
        match f.pin {
            Pin::Value(want) => {
                // 這台機器自己設了這個變數：讀到的是設定值不是預設，略過（CI 的環境是乾淨的，會全部比）
                let set_here = std::env::var(f.name).is_ok() || f.legacy.map(|l| std::env::var(l).is_ok()).unwrap_or(false);
                if set_here {
                    skipped.push(f.name);
                    continue;
                }
                pinned += 1;
                match got {
                    None => bad.push(format!("{} 登記為釘住，測試裡卻沒有對應的讀取（pinned_value）", f.name)),
                    Some(g) if g != want => bad.push(format!("{} 預設值對不上：登記表寫 {want:?}，讀取函式回 {g:?}", f.name)),
                    _ => {}
                }
            }
            _ => {
                if got.is_some() {
                    bad.push(format!("{} 測試有讀它的預設，登記表卻沒標釘住", f.name));
                }
            }
        }
    }
    if !skipped.is_empty() {
        eprintln!("（本機設了這些環境變數，略過比對：{skipped:?}）");
    }
    assert!(bad.is_empty(), "預設值釘住有問題：\n{}", bad.join("\n"));
    assert!(pinned + skipped.len() >= 30, "釘住的筆數異常少：{pinned}（略過 {}）", skipped.len());
}

// ---- 文件 ------------------------------------------------------------------------------

fn doc_row(f: &Flag) -> String {
    format!("| `{}` | {} | {} | {} |", f.name, f.kind_label(), f.default, f.purpose)
}

fn doc_text() -> String {
    let p = manifest().join("../../../docs/設定值清單.md");
    std::fs::read_to_string(&p).unwrap_or_else(|e| panic!("讀不到 {}：{e}", p.display())).replace("\r\n", "\n")
}

#[test]
fn 守門_設定值清單的環境變數一節與登記表一致() {
    let doc = doc_text();
    let mut lines = doc.lines().skip_while(|l| !l.starts_with("## 環境變數"));
    assert!(lines.next().is_some(), "docs/設定值清單.md 缺「## 環境變數」一節");
    let rows: Vec<&str> = lines.take_while(|l| !l.starts_with("## ")).filter(|l| l.starts_with("| `")).collect();
    let expected: Vec<String> = FLAGS.iter().map(doc_row).collect();
    let mut bad = vec![];
    for e in &expected {
        if !rows.contains(&e.as_str()) {
            bad.push(format!("文件缺這一列（或內容和登記表不同）：{e}"));
        }
    }
    for r in &rows {
        if !expected.iter().any(|e| e == r) {
            bad.push(format!("文件多了登記表沒有的列：{r}"));
        }
    }
    if rows.len() != expected.len() {
        bad.push(format!("列數不同：文件 {}、登記表 {}", rows.len(), expected.len()));
    }
    assert!(
        bad.is_empty(),
        "設定值清單的「環境變數」與登記表不一致：\n{}\n\n期望的整段表格：\n| 名稱 | 分類 | 沒設時 | 用途 |\n|---|---|---|---|\n{}",
        bad.join("\n"),
        expected.join("\n")
    );
}

//! 環境變數改名相容（ONBOARDING §5.2，第一期）：`IRORI_<名>` → `ASN_<名>`。
//!
//! 規則：新名（`ASN_`）優先；新名沒設（或只有空白）才讀舊名（`IRORI_`）；兩個都沒有就是沒設。
//! 給子程序的環境要兩個名字都帶（[`mirror`]），沒更新的舊程式（例如還沒換版的 `send.mjs`）照樣讀得到；
//! 金鑰類（[`SECRET_NAMES`]）新舊名都不可交給子程序。只記變數名，不記值。
//!
//! 新增一個改名時，必須加進 [`PAIRS`]；守門測試會掃原始碼，確認沒有程式還在直接讀 `IRORI_*`。
use std::collections::HashMap;
use std::ffi::OsString;

/// （新名, 舊名）。舊名多半就是把 `ASN_` 換成 `IRORI_`；`IRORI_ASN_*` 的重複 ASN 去掉。
pub const PAIRS: &[(&str, &str)] = &[
    ("ASN_RELAY_ID", "IRORI_RELAY_ID"),
    ("ASN_RELAY_URL", "IRORI_RELAY_URL"),
    ("ASN_RELAY_KEY", "IRORI_RELAY_KEY"),
    ("ASN_RELAY_ANON_KEY", "IRORI_RELAY_ANON_KEY"),
    ("ASN_RELAY_DEFAULT_AGENT", "IRORI_RELAY_DEFAULT_AGENT"),
    ("ASN_RELAY_ALLOW", "IRORI_RELAY_ALLOW"),
    ("ASN_RELAY_POLL_MS", "IRORI_RELAY_POLL_MS"),
    ("ASN_MAILBOX_NAME", "IRORI_MAILBOX_NAME"),
    ("ASN_MAILBOX_MODEL", "IRORI_MAILBOX_MODEL"),
    ("ASN_ROSTER_MS", "IRORI_ROSTER_MS"),
    ("ASN_BRIDGE_TICK_MS", "IRORI_BRIDGE_TICK_MS"),
    ("ASN_REPLY_TIMEOUT_MS", "IRORI_REPLY_TIMEOUT_MS"),
    ("ASN_LATE_KEEP_MS", "IRORI_LATE_KEEP_MS"),
    ("ASN_LATE_MAX", "IRORI_LATE_MAX"),
    ("ASN_NUDGE_MS", "IRORI_NUDGE_MS"),
    ("ASN_FORWARD_TIMEOUT_MS", "IRORI_FORWARD_TIMEOUT_MS"),
    ("ASN_ENGINES", "IRORI_ENGINES"),
    ("ASN_AGENTS_FILE", "IRORI_AGENTS_FILE"),
    ("ASN_AEGIS_URL", "IRORI_AEGIS_URL"),
    ("ASN_AEGIS_FROM_MEMBER", "IRORI_AEGIS_FROM_MEMBER"),
    ("ASN_AEGIS_ALLOW", "IRORI_AEGIS_ALLOW"),
    ("ASN_AEGIS_SELF", "IRORI_AEGIS_SELF"),
    ("ASN_AEGIS_DEFAULT", "IRORI_AEGIS_DEFAULT"),
    ("ASN_AEGIS_TIMEOUT_MS", "IRORI_AEGIS_TIMEOUT_MS"),
    ("ASN_AEGIS_RETRY_MS", "IRORI_AEGIS_RETRY_MS"),
    ("ASN_LAUNCHER_FILE", "IRORI_LAUNCHER_FILE"),
    ("ASN_ATTACH_CMD", "IRORI_ATTACH_CMD"),
    ("ASN_ROOM_CMD", "IRORI_ROOM_CMD"),
    ("ASN_SEND_PER_HOUR", "IRORI_SEND_PER_HOUR"),
    ("ASN_RECV_POLL_MS", "IRORI_RECV_POLL_MS"),
    ("ASN_RECV_HEARTBEAT_MS", "IRORI_RECV_HEARTBEAT_MS"),
    ("ASN_RECV_STALE_MS", "IRORI_RECV_STALE_MS"),
    ("ASN_PULL_BACKOFF_MS", "IRORI_PULL_BACKOFF_MS"),
    ("ASN_CODEX_SCRIPT", "IRORI_CODEX_SCRIPT"),
    ("ASN_CODEX_BIN", "IRORI_CODEX_BIN"),
    ("ASN_CODEX_POLL_MS", "IRORI_CODEX_POLL_MS"),
    ("ASN_CODEX_HEALTH_TTL_MS", "IRORI_CODEX_HEALTH_TTL_MS"),
    ("ASN_CODEX_OUTSTANDING_MAX_MS", "IRORI_CODEX_OUTSTANDING_MAX_MS"),
    ("ASN_CODEX_DRAIN_WARN_MS", "IRORI_CODEX_DRAIN_WARN_MS"),
    ("ASN_CODEX_MAX_MAIL_CHARS", "IRORI_CODEX_MAX_MAIL_CHARS"),
    ("ASN_CODEX_LOCK_MODE", "IRORI_CODEX_LOCK_MODE"),
    ("ASN_CODEX_ALLOW_FULL_ACCESS", "IRORI_CODEX_ALLOW_FULL_ACCESS"),
    ("ASN_CODEX_REPLY_NOTE", "IRORI_CODEX_REPLY_NOTE"),
    ("ASN_CODEX_SKIP_VERSION_CHECK", "IRORI_CODEX_SKIP_VERSION_CHECK"),
    ("ASN_LAUNCH_ARGS", "IRORI_LAUNCH_ARGS"),
    ("ASN_LAUNCH_DIR", "IRORI_LAUNCH_DIR"),
    ("ASN_LAUNCH_STYLE", "IRORI_LAUNCH_STYLE"),
    // 電腦版自己的（舊名是 IRORI_ASN_*）
    ("ASN_HOME", "IRORI_HOME"),
    // 收件匣節點（Linux 無頭）：視窗名、引擎名、命令列無人值守開關
    ("ASN_INBOX_NAME", "IRORI_INBOX_NAME"),
    ("ASN_INBOX_ENGINE", "IRORI_INBOX_ENGINE"),
    ("ASN_CLI_UNATTENDED", "IRORI_CLI_UNATTENDED"),
    ("ASN_DATA", "IRORI_ASN_DATA"),
    ("ASN_POLL_MS", "IRORI_ASN_POLL_MS"),
    ("ASN_APP_ROSTER_MS", "IRORI_ASN_ROSTER_MS"),
    ("ASN_SHOT_LOGIN", "IRORI_ASN_SHOT_LOGIN"),
    ("ASN_CLAUDE_HOME", "IRORI_ASN_CLAUDE_HOME"),
    ("ASN_CLAUDE_AUTO_MS", "IRORI_ASN_CLAUDE_AUTO_MS"),
    ("ASN_PRESENCE_MS", "IRORI_ASN_PRESENCE_MS"),
    ("ASN_MOCK_BIN_DIR", "IRORI_ASN_MOCK_BIN_DIR"),
];

/// 金鑰類：不可交給子程序。新舊名都要擋（大小寫不分）。
pub const SECRET_NAMES: [&str; 4] = ["ASN_RELAY_KEY", "ASN_RELAY_ANON_KEY", "IRORI_RELAY_KEY", "IRORI_RELAY_ANON_KEY"];

pub fn is_secret(name: &str) -> bool {
    let u = name.to_ascii_uppercase();
    SECRET_NAMES.contains(&u.as_str())
}

/// 新名對應的舊名；沒登記的回 None
pub fn legacy(new: &str) -> Option<&'static str> {
    PAIRS.iter().find(|(n, _)| *n == new).map(|(_, o)| *o)
}

fn filled(v: &Option<String>) -> bool {
    v.as_deref().map(|s| !s.trim().is_empty()).unwrap_or(false)
}

/// 用任意查詢函式讀：新名有值（不是空白）就用新名，否則退回舊名，否則回新名的原值（可能是空字串）
pub fn pick(lookup: &dyn Fn(&str) -> Option<String>, new: &str) -> Option<String> {
    debug_assert!(legacy(new).is_some(), "環境變數 {new} 沒登記在 envc::PAIRS");
    let n = lookup(new);
    if filled(&n) {
        return n;
    }
    match legacy(new).and_then(|o| lookup(o)) {
        Some(o) => Some(o),
        None => n,
    }
}

/// 讀本行程的環境變數（新名優先，沒有才讀舊名）
pub fn get(new: &str) -> Option<String> {
    pick(&|k| std::env::var(k).ok(), new)
}

/// 同 [`get`]，但回 OsString（路徑類用）
pub fn get_os(new: &str) -> Option<OsString> {
    let n = std::env::var_os(new);
    if n.as_ref().map(|s| !s.is_empty()).unwrap_or(false) {
        return n;
    }
    debug_assert!(legacy(new).is_some(), "環境變數 {new} 沒登記在 envc::PAIRS");
    legacy(new).and_then(std::env::var_os).or(n)
}

/// 從一份環境快照讀（變數名大小寫不分，Windows 的環境變數就是這樣）
pub fn pick_from(vars: &[(String, String)], new: &str) -> Option<String> {
    pick(&|k| vars.iter().find(|(n, _)| n.eq_ignore_ascii_case(k)).map(|(_, v)| v.clone()), new)
}

/// 給子程序的環境：登記過的（非金鑰）變數新舊名都帶，值以新名優先。已存在的其他變數原樣不動。
pub fn mirror(vars: &mut HashMap<String, String>) {
    let snapshot: Vec<(String, String)> = vars.iter().map(|(k, v)| (k.clone(), v.clone())).collect();
    for (new, old) in PAIRS {
        if is_secret(new) {
            continue;
        }
        if let Some(v) = pick_from(&snapshot, new) {
            vars.insert((*new).to_string(), v.clone());
            vars.insert((*old).to_string(), v);
        }
    }
}

/// 同 [`mirror`]，但針對 `Vec<(名, 值)>`（引擎用的環境快照）
pub fn mirror_vec(mut vars: Vec<(String, String)>) -> Vec<(String, String)> {
    for (new, old) in PAIRS {
        if is_secret(new) {
            continue;
        }
        if let Some(v) = pick_from(&vars, new) {
            for name in [new, old] {
                match vars.iter_mut().find(|(n, _)| n.eq_ignore_ascii_case(name)) {
                    Some(slot) => slot.1 = v.clone(),
                    None => vars.push(((*name).to_string(), v.clone())),
                }
            }
        }
    }
    vars
}

#[cfg(test)]
mod tests {
    use super::*;

    fn look<'a>(pairs: &'a [(&'a str, &'a str)]) -> impl Fn(&str) -> Option<String> + 'a {
        move |k| pairs.iter().find(|(n, _)| *n == k).map(|(_, v)| v.to_string())
    }

    #[test]
    fn 只設舊名也行_只設新名也行_兩個都設以新名為準_新名空白退回舊名() {
        for (new, old) in PAIRS {
            assert_eq!(pick(&look(&[(old, "o")]), new).as_deref(), Some("o"), "{new} 只設舊名");
            assert_eq!(pick(&look(&[(new, "x")]), new).as_deref(), Some("x"), "{new} 只設新名");
            assert_eq!(pick(&look(&[(new, "x"), (old, "o")]), new).as_deref(), Some("x"), "{new} 兩個都設");
            assert_eq!(pick(&look(&[(new, "  "), (old, "o")]), new).as_deref(), Some("o"), "{new} 新名空白");
            assert_eq!(pick(&look(&[]), new), None, "{new} 都沒設");
        }
    }

    #[test]
    fn 對照表沒有重複_舊名都是_irori_開頭() {
        let mut news: Vec<_> = PAIRS.iter().map(|p| p.0).collect();
        let mut olds: Vec<_> = PAIRS.iter().map(|p| p.1).collect();
        news.sort();
        olds.sort();
        news.dedup();
        olds.dedup();
        assert_eq!(news.len(), PAIRS.len());
        assert_eq!(olds.len(), PAIRS.len());
        assert!(PAIRS.iter().all(|(n, o)| n.starts_with("ASN_") && o.starts_with("IRORI_")));
    }

    #[test]
    fn 快照讀取大小寫不分() {
        let vars = vec![("irori_relay_id".to_string(), "OLD".to_string())];
        assert_eq!(pick_from(&vars, "ASN_RELAY_ID").as_deref(), Some("OLD"));
        let vars = vec![("Asn_Relay_Id".to_string(), "NEW".to_string()), ("IRORI_RELAY_ID".to_string(), "OLD".to_string())];
        assert_eq!(pick_from(&vars, "ASN_RELAY_ID").as_deref(), Some("NEW"));
    }

    #[test]
    fn 子程序環境新舊名都帶_金鑰不補() {
        let mut m: HashMap<String, String> = HashMap::new();
        m.insert("IRORI_RELAY_URL".into(), "http://127.0.0.1:1".into());
        m.insert("ASN_RELAY_ID".into(), "N".into());
        m.insert("IRORI_RELAY_KEY".into(), "k".into());
        m.insert("PATH".into(), "p".into());
        mirror(&mut m);
        assert_eq!(m["ASN_RELAY_URL"], "http://127.0.0.1:1");
        assert_eq!(m["IRORI_RELAY_URL"], "http://127.0.0.1:1");
        assert_eq!(m["ASN_RELAY_ID"], "N");
        assert_eq!(m["IRORI_RELAY_ID"], "N");
        assert_eq!(m["PATH"], "p");
        assert!(!m.contains_key("ASN_RELAY_KEY"), "金鑰不補名字");
        // 兩個都有且不同：兩個名字都給新名的值
        let mut m: HashMap<String, String> = HashMap::new();
        m.insert("ASN_RELAY_URL".into(), "new".into());
        m.insert("IRORI_RELAY_URL".into(), "old".into());
        mirror(&mut m);
        assert_eq!(m["IRORI_RELAY_URL"], "new");
    }

    #[test]
    fn 金鑰名單新舊都有_大小寫不分() {
        for n in ["ASN_RELAY_KEY", "asn_relay_anon_key", "IRORI_RELAY_KEY", "irori_relay_anon_key"] {
            assert!(is_secret(n), "{n}");
        }
        assert!(!is_secret("ASN_RELAY_ID"));
    }

    /// 守門：程式不得再直接讀 `IRORI_*`（一律走 envc）。拿掉 envc 的舊名退路或把某處改回直接讀，這個測試或上面的就會紅。
    #[test]
    fn 守門_原始碼不直接讀_irori_環境變數() {
        fn walk(dir: &std::path::Path, out: &mut Vec<std::path::PathBuf>) {
            for e in std::fs::read_dir(dir).unwrap().flatten() {
                let p = e.path();
                if p.is_dir() {
                    walk(&p, out);
                } else if p.extension().map(|x| x == "rs").unwrap_or(false) {
                    out.push(p);
                }
            }
        }
        let mut files = vec![];
        walk(&std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src"), &mut files);
        let readers = ["env::var(", "env::var_os(", "env_u64(", "env_ms(", "num(", "list(", "flag(", "var(", "env_get("];
        let mut bad = vec![];
        for f in files {
            if f.file_name().map(|n| n == "envc.rs").unwrap_or(false) {
                continue;
            }
            let src = std::fs::read_to_string(&f).unwrap();
            for (i, line) in src.lines().enumerate() {
                let t = line.trim_start();
                if t.starts_with("//") {
                    continue;
                }
                for r in readers {
                    for sep in ["\"IRORI_", "&env, \"IRORI_", "env, \"IRORI_"] {
                        if line.contains(&format!("{r}{sep}")) {
                            bad.push(format!("{}:{}", f.file_name().unwrap().to_string_lossy(), i + 1));
                        }
                    }
                }
            }
        }
        assert!(bad.is_empty(), "這些位置還在直接讀 IRORI_*：{bad:?}");
    }
}

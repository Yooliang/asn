//! 工具清單：與 `relay/shared/agent-tools.catalog.json` 同步（issue #23／#48 共用）。
//! 安裝方式只有兩種（#933）：`verified`＝ASN 自己下載、比對雜湊、驗數位簽章後安裝；`manual`＝請使用者到官網安裝，ASN 只偵測。
//! 清單裡不放任何安裝腳本網址，也沒有「用 npm 全域安裝」這一種：ASN 不執行下載來的腳本。

use serde::Deserialize;

const CATALOG_JSON: &str = include_str!("../../../../shared/agent-tools.catalog.json");

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InstallKind {
    /// 請使用者到官網安裝；ASN 只偵測
    Manual,
    /// ASN 有「驗過再執行」的安裝流程（`agent_setup`）
    Verified,
}

#[derive(Debug, Clone)]
pub struct ToolDef {
    pub id: String,
    pub label: String,
    pub binary: String,
    pub engine: String,
    pub install: InstallKind,
    pub login_argv: Vec<String>,
    pub install_blurb: String,
    pub login_blurb: String,
}

#[derive(Debug, Deserialize)]
struct CatalogFile {
    tools: Vec<CatalogTool>,
}

#[derive(Debug, Deserialize)]
struct CatalogTool {
    id: String,
    label: String,
    binary: String,
    engine: String,
    install: CatalogInstall,
    #[serde(rename = "loginCommand")]
    login_command: Vec<String>,
    install_blurb: String,
    login_blurb: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct CatalogInstall {
    kind: String,
}

/// 認不得的種類一律當 `Manual`（預設不安裝）
fn parse_install(i: &CatalogInstall) -> InstallKind {
    match i.kind.as_str() {
        "verified" => InstallKind::Verified,
        _ => InstallKind::Manual,
    }
}

fn load_tools() -> Vec<ToolDef> {
    let cat: CatalogFile = serde_json::from_str(CATALOG_JSON).expect("agent-tools.catalog.json 必須合法");
    cat.tools
        .into_iter()
        .map(|t| ToolDef {
            install: parse_install(&t.install),
            id: t.id,
            label: t.label,
            binary: t.binary,
            engine: t.engine,
            login_argv: t.login_command,
            install_blurb: t.install_blurb,
            login_blurb: t.login_blurb,
        })
        .collect()
}

static TOOLS: std::sync::OnceLock<Vec<ToolDef>> = std::sync::OnceLock::new();

pub fn tools() -> &'static [ToolDef] {
    TOOLS.get_or_init(load_tools)
}

pub fn tool(id: &str) -> Option<&'static ToolDef> {
    tools().iter().find(|t| t.id == id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 清單與_issue23_一致() {
        let ids: Vec<_> = tools().iter().map(|t| t.id.as_str()).collect();
        assert_eq!(ids, ["claude", "codex", "agy", "grok", "pi"]);
        assert_eq!(tool("agy").unwrap().binary, "agy");
    }

    #[test]
    fn 只有_claude_能一鍵安裝_其他都是請使用者到官網() {
        let verified: Vec<_> = tools().iter().filter(|t| t.install == InstallKind::Verified).map(|t| t.id.as_str()).collect();
        assert_eq!(verified, ["claude"]);
    }

    #[test]
    fn 清單裡沒有安裝腳本網址也沒有_npm_安裝() {
        let v: serde_json::Value = serde_json::from_str(CATALOG_JSON).unwrap();
        for t in v["tools"].as_array().unwrap() {
            let keys: Vec<_> = t["install"].as_object().unwrap().keys().cloned().collect();
            assert_eq!(keys, ["kind"], "{}：install 只能有 kind", t["id"]);
        }
        let low = CATALOG_JSON.to_ascii_lowercase();
        for bad in ["install.ps1", "install.sh", "\"npm\"", "\"sh\"", "\"ps1\""] {
            assert!(!low.contains(bad), "清單不能再有 {bad}");
        }
    }

    #[test]
    fn 認不得的安裝種類當成請使用者到官網() {
        assert_eq!(parse_install(&CatalogInstall { kind: "native".into() }), InstallKind::Manual);
        assert_eq!(parse_install(&CatalogInstall { kind: "npm".into() }), InstallKind::Manual);
        assert_eq!(parse_install(&CatalogInstall { kind: "".into() }), InstallKind::Manual);
    }
}

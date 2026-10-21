//! 工具清單：與 `relay/shared/agent-tools.catalog.json` 同步（issue #23／#48 共用）。

use serde::Deserialize;

const CATALOG_JSON: &str = include_str!("../../../../shared/agent-tools.catalog.json");

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InstallKind {
    None,
    NativeInstaller,
    NpmGlobal,
}

#[derive(Debug, Clone)]
pub struct ToolDef {
    pub id: String,
    pub label: String,
    pub binary: String,
    pub engine: String,
    pub install: InstallKind,
    pub install_sh_url: Option<String>,
    pub install_ps1_url: Option<String>,
    pub npm_package: Option<String>,
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
struct CatalogInstall {
    kind: String,
    sh: Option<String>,
    ps1: Option<String>,
    npm: Option<String>,
}

fn parse_install(i: &CatalogInstall) -> (InstallKind, Option<String>, Option<String>, Option<String>) {
    match i.kind.as_str() {
        "native" => (
            InstallKind::NativeInstaller,
            i.sh.clone(),
            i.ps1.clone(),
            i.npm.clone(),
        ),
        "npm" => (InstallKind::NpmGlobal, None, None, i.npm.clone()),
        _ => (InstallKind::None, None, None, None),
    }
}

fn load_tools() -> Vec<ToolDef> {
    let cat: CatalogFile = serde_json::from_str(CATALOG_JSON).expect("agent-tools.catalog.json 必須合法");
    cat.tools
        .into_iter()
        .map(|t| {
            let (install, sh, ps1, npm) = parse_install(&t.install);
            ToolDef {
                id: t.id,
                label: t.label,
                binary: t.binary,
                engine: t.engine,
                install,
                install_sh_url: sh,
                install_ps1_url: ps1,
                npm_package: npm,
                login_argv: t.login_command,
                install_blurb: t.install_blurb,
                login_blurb: t.login_blurb,
            }
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
}

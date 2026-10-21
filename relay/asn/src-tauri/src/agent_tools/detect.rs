//! 僅偵測 PATH 上是否有 CLI 指令；不讀取 ~/.claude、auth.json 等任何憑證檔。

use std::path::PathBuf;

pub fn binary_on_path(name: &str) -> bool {
    resolve_binary(name).is_some()
}

/// PATH 上第一個可執行檔路徑（與 agent-tools-detect.mjs 的 lookup 對齊）。
pub fn resolve_binary(name: &str) -> Option<PathBuf> {
    if let Ok(p) = std::env::var("IRORI_ASN_MOCK_BIN_DIR") {
        let base = PathBuf::from(p);
        let win = base.join(format!("{name}.exe"));
        if win.is_file() {
            return Some(win);
        }
        let nx = base.join(name);
        if nx.is_file() {
            return Some(nx);
        }
    }
    #[cfg(windows)]
    {
        let out = std::process::Command::new("where")
            .arg(name)
            .output()
            .ok()?;
        if !out.status.success() {
            return None;
        }
        let line = String::from_utf8_lossy(&out.stdout).lines().next()?.trim().to_string();
        if line.is_empty() {
            None
        } else {
            Some(PathBuf::from(line))
        }
    }
    #[cfg(not(windows))]
    {
        let out = std::process::Command::new("sh")
            .arg("-c")
            .arg(format!("command -v {name}"))
            .output()
            .ok()?;
        if !out.status.success() {
            return None;
        }
        let line = String::from_utf8_lossy(&out.stdout).trim().to_string();
        if line.is_empty() {
            None
        } else {
            Some(PathBuf::from(line))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent_tools::catalog::tool;

    #[test]
    fn agy_用_binary_名() {
        assert_eq!(tool("agy").unwrap().binary, "agy");
    }
}

//! 僅偵測 PATH 上是否有 CLI 指令；不讀取 ~/.claude、auth.json 等任何憑證檔。

use std::path::PathBuf;

pub fn binary_on_path(name: &str) -> bool {
    if let Ok(p) = std::env::var("IRORI_ASN_MOCK_BIN_DIR") {
        let base = PathBuf::from(p);
        if base.join(name).exists() || (cfg!(windows) && base.join(format!("{name}.exe")).exists()) {
            return true;
        }
    }
    which(name)
}

fn which(name: &str) -> bool {
    #[cfg(windows)]
    {
        std::process::Command::new("where")
            .arg(name)
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
    }
    #[cfg(not(windows))]
    {
        std::process::Command::new("sh")
            .arg("-c")
            .arg(format!("command -v {name}"))
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
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

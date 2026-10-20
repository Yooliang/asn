//! 本機身分：節點代號、節點金鑰、anon 金鑰、BASE_URL。判定順序照 relay/machine/identity.mjs：
//! 節點＝IRORI_RELAY_ID → ~/.irori-relay/node → 橋正在跑的 machine-<ID> → 唯一有金鑰檔的 machine-<ID>。
//! 金鑰＝IRORI_RELAY_KEY → ~/.irori-relay/<節點>.key。金鑰只在 Rust 記憶體，絕不進 log、不傳前端。
use crate::heartbeat::pid_alive;
use std::fs;
use std::path::{Path, PathBuf};

pub const DEFAULT_URL: &str = "https://etccgmkrosbzpltudlgt.supabase.co/functions/v1/relay";

pub fn home_dir() -> PathBuf {
    std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME")).map(PathBuf::from).unwrap_or_default()
}
pub fn relay_home() -> PathBuf {
    home_dir().join(".irori-relay")
}
pub fn work_dir(relay_home: &Path, node: &str) -> PathBuf {
    relay_home.join(format!("machine-{node}"))
}

pub fn base_url(env: Option<String>) -> String {
    env.filter(|s| !s.trim().is_empty()).unwrap_or_else(|| DEFAULT_URL.to_string()).trim().trim_end_matches('/').to_string()
}

pub fn valid_id(s: &str) -> bool {
    !s.is_empty() && s.len() <= 32 && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

pub fn machine_node(relay_home: &Path, env_id: Option<String>, alive: impl Fn(u32) -> bool) -> Result<String, String> {
    if let Some(v) = env_id.map(|s| s.trim().to_string()).filter(|s| !s.is_empty()) {
        return Ok(v);
    }
    if let Ok(v) = fs::read_to_string(relay_home.join("node")) {
        let v = v.trim();
        if !v.is_empty() {
            return Ok(v.to_string());
        }
    }
    let ids: Vec<String> = fs::read_dir(relay_home)
        .map(|rd| {
            rd.filter_map(|e| e.ok())
                .filter_map(|e| e.file_name().to_str().and_then(|n| n.strip_prefix("machine-").map(String::from)))
                .filter(|id| valid_id(id))
                .collect()
        })
        .unwrap_or_default();
    let live: Vec<&String> = ids
        .iter()
        .filter(|id| {
            fs::read_to_string(work_dir(relay_home, id).join("bridge.pid"))
                .ok()
                .and_then(|s| s.trim().parse::<u32>().ok())
                .map(&alive)
                .unwrap_or(false)
        })
        .collect();
    if live.len() == 1 {
        return Ok(live[0].clone());
    }
    let keyed: Vec<&String> = ids.iter().filter(|id| relay_home.join(format!("{id}.key")).exists()).collect();
    if keyed.len() == 1 {
        return Ok(keyed[0].clone());
    }
    let cand = if !live.is_empty() { live } else if !keyed.is_empty() { keyed } else { ids.iter().collect() };
    Err(format!(
        "認不出這台機器的節點代號（候選：{}）：設環境變數 IRORI_RELAY_ID，或在 ~/.irori-relay/node 寫上節點代號",
        if cand.is_empty() { "無".to_string() } else { cand.iter().map(|s| s.as_str()).collect::<Vec<_>>().join("、") }
    ))
}

pub fn read_key(relay_home: &Path, node: &str, env_key: Option<String>) -> Result<String, String> {
    if let Some(k) = env_key.map(|s| s.trim().to_string()).filter(|s| !s.is_empty()) {
        return Ok(k);
    }
    fs::read_to_string(relay_home.join(format!("{node}.key")))
        .map(|s| s.trim().to_string())
        .ok()
        .filter(|s| !s.is_empty())
        .ok_or_else(|| format!("找不到機器金鑰 {}", relay_home.join(format!("{node}.key")).display()))
}

pub fn read_anon(relay_home: &Path, env_key: Option<String>) -> Option<String> {
    env_key
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .or_else(|| fs::read_to_string(relay_home.join("anon.key")).ok().map(|s| s.trim().to_string()).filter(|s| !s.is_empty()))
}

pub struct Identity {
    pub node: String,
    pub base_url: String,
    pub relay_home: PathBuf,
    pub key: String,
    pub anon: Option<String>,
}

pub fn resolve() -> Result<Identity, String> {
    let relay_home = relay_home();
    let node = machine_node(&relay_home, std::env::var("IRORI_RELAY_ID").ok(), pid_alive)?;
    if !valid_id(&node) {
        return Err(format!("節點代號格式不對：{node}"));
    }
    let key = read_key(&relay_home, &node, std::env::var("IRORI_RELAY_KEY").ok())?;
    let anon = read_anon(&relay_home, std::env::var("IRORI_RELAY_ANON_KEY").ok());
    Ok(Identity { node, base_url: base_url(std::env::var("IRORI_RELAY_URL").ok()), relay_home, key, anon })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dir() -> tempfile::TempDir {
        tempfile::tempdir().unwrap()
    }

    #[test]
    fn 環境變數優先_其次_node_檔() {
        let d = dir();
        assert_eq!(machine_node(d.path(), Some(" Q ".into()), |_| false).unwrap(), "Q");
        fs::write(d.path().join("node"), "H\n").unwrap();
        assert_eq!(machine_node(d.path(), None, |_| false).unwrap(), "H");
        assert_eq!(machine_node(d.path(), Some("".into()), |_| false).unwrap(), "H");
    }

    #[test]
    fn 橋在跑的優先_否則唯一有金鑰的_否則報錯() {
        let d = dir();
        fs::create_dir_all(d.path().join("machine-A")).unwrap();
        fs::create_dir_all(d.path().join("machine-B")).unwrap();
        fs::create_dir_all(d.path().join("machine-bad name")).unwrap();
        assert!(machine_node(d.path(), None, |_| true).is_err(), "沒有 pid 檔、沒有金鑰＝認不出");
        fs::write(d.path().join("machine-B").join("bridge.pid"), "123").unwrap();
        assert_eq!(machine_node(d.path(), None, |p| p == 123).unwrap(), "B");
        fs::remove_file(d.path().join("machine-B").join("bridge.pid")).unwrap();
        fs::write(d.path().join("A.key"), "k").unwrap();
        assert_eq!(machine_node(d.path(), None, |_| false).unwrap(), "A");
        fs::write(d.path().join("B.key"), "k").unwrap();
        let e = machine_node(d.path(), None, |_| false).unwrap_err();
        assert!(e.contains("A") && e.contains("B"), "{e}");
    }

    #[test]
    fn 金鑰_環境變數優先_否則讀檔_都沒有就報錯且錯誤訊息不含金鑰() {
        let d = dir();
        assert_eq!(read_key(d.path(), "H", Some(" env-key ".into())).unwrap(), "env-key");
        assert!(read_key(d.path(), "H", None).is_err());
        fs::write(d.path().join("H.key"), "file-key\r\n").unwrap();
        assert_eq!(read_key(d.path(), "H", None).unwrap(), "file-key");
        fs::write(d.path().join("anon.key"), " anon \n").unwrap();
        assert_eq!(read_anon(d.path(), None).as_deref(), Some("anon"));
        assert_eq!(read_anon(d.path(), Some("e".into())).as_deref(), Some("e"));
        let e = read_key(d.path(), "Z", None).unwrap_err();
        assert!(!e.contains("file-key"));
    }

    #[test]
    fn base_url_預設值與去尾斜線() {
        assert_eq!(DEFAULT_URL, "https://etccgmkrosbzpltudlgt.supabase.co/functions/v1/relay");
        assert_eq!(base_url(None), DEFAULT_URL);
        assert_eq!(base_url(Some("http://127.0.0.1:1/relay//".into())), "http://127.0.0.1:1/relay");
        assert_eq!(base_url(Some("  ".into())), DEFAULT_URL);
        assert!(valid_id("H-1_a") && !valid_id("a b") && !valid_id(""));
    }
}

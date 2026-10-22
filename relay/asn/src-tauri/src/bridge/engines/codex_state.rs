//! 直接讀 Codex 資料夾（CODEX_HOME，預設 ~/.codex）裡幾個「穩定、只讀」的檔案。對應 engines/codex-state.mjs：
//! - session_index.jsonl：thread id ↔ 名字（附加式，後面的行蓋過前面的）
//! - thread-writer-locks/<thread-id>.lock：某個行程（TUI／桌面版／codex exec）正開著這個 thread 時持有；
//!   Windows 上持有者以不允許共用的方式開著它，所以「試著用不共用的方式開開看」開得起來＝沒人在用（檔案可能是被強制結束後留下的殘檔）。
//!   不開 PowerShell，直接用 Win32 的共用模式 0 開檔。
//! - rollout 檔最後一個 turn_context：該視窗目前的核准／沙盒設定（用來擋「完全存取」的視窗）
use std::collections::{HashMap, HashSet};
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;

/// → (id → 名字, 名字 → id 們（舊→新）)；名字被改成空字串就視為沒有名字
pub fn read_name_index(home: &Path) -> (HashMap<String, String>, HashMap<String, Vec<String>>) {
    let text = std::fs::read_to_string(home.join("session_index.jsonl")).unwrap_or_default();
    let mut by_id: Vec<(String, String)> = vec![]; // 保持寫入順序
    for line in text.lines() {
        let Ok(j) = serde_json::from_str::<serde_json::Value>(line.trim()) else { continue };
        let Some(id) = j.get("id").and_then(|v| v.as_str()) else { continue };
        let name = j.get("thread_name").and_then(|v| v.as_str()).map(str::trim).unwrap_or("");
        by_id.retain(|(i, _)| i != id);
        if !name.is_empty() {
            by_id.push((id.to_string(), name.to_string()));
        }
    }
    let mut by_name: HashMap<String, Vec<String>> = HashMap::new();
    for (id, name) in &by_id {
        by_name.entry(name.clone()).or_default().push(id.clone());
    }
    (by_id.into_iter().collect(), by_name)
}

fn lock_id(file_name: &str) -> Option<String> {
    let stem = file_name.strip_suffix(".lock").or_else(|| file_name.strip_suffix(".LOCK"))?;
    let parts: Vec<&str> = stem.split('-').collect();
    let lens = [8, 4, 4, 4, 12];
    (parts.len() == 5 && parts.iter().zip(lens).all(|(p, n)| p.len() == n && p.chars().all(|c| c.is_ascii_hexdigit()))).then(|| stem.to_lowercase())
}

#[cfg(windows)]
fn held(path: &Path) -> bool {
    use std::os::windows::fs::OpenOptionsExt;
    match std::fs::OpenOptions::new().read(true).write(true).share_mode(0).open(path) {
        Ok(_) => false,
        // 2、3＝檔案或資料夾不存在；32、33、5＝被別的行程鎖住／拒絕存取（持有中）
        Err(e) => matches!(e.raw_os_error(), Some(32) | Some(33) | Some(5)),
    }
}
#[cfg(not(windows))]
fn held(_path: &Path) -> bool {
    true // 非 Windows 只看檔案在不在
}

/// 正被某個行程開著的 thread id 集合。exists_only＝只看鎖檔在不在（測試與不支援的平台用）
pub fn locked_thread_ids(home: &Path, exists_only: bool) -> HashSet<String> {
    let dir = home.join("thread-writer-locks");
    let Ok(rd) = std::fs::read_dir(&dir) else { return HashSet::new() };
    rd.flatten()
        .filter_map(|e| {
            let id = lock_id(&e.file_name().to_string_lossy())?;
            (exists_only || held(&e.path())).then_some(id)
        })
        .collect()
}

#[derive(Clone, Debug, PartialEq)]
pub struct Policy {
    pub approval: String,
    pub sandbox: String,
}

/// rollout（.jsonl）從結尾往回一段一段讀（每段 chunk 位元組），找最近一筆 turn_context；最多讀 max_bytes。
/// 回 None＝真的不知道（還沒有任何 turn、讀不到、超過上限）；呼叫端要當成「不能轉信」（fail-closed）
pub fn read_policy(rollout: &Path, chunk: usize, max_bytes: u64) -> Option<Policy> {
    let mut f = std::fs::File::open(rollout).ok()?;
    let size = f.metadata().ok()?.len();
    let mut pos = size;
    let mut carry: Vec<u8> = vec![];
    while pos > 0 && size - pos < max_bytes {
        let len = (chunk as u64).min(pos);
        pos -= len;
        let mut buf = vec![0u8; len as usize];
        f.seek(SeekFrom::Start(pos)).ok()?;
        f.read_exact(&mut buf).ok()?;
        // carry＝後面那段開頭還沒讀完整的一行（位元組，免得中文字被切在兩段之間解壞），接在這段後面
        buf.extend_from_slice(&carry);
        carry.clear();
        let data: Vec<u8> = if pos > 0 {
            // 還沒到檔案開頭：第一個換行之前那截可能是被切斷的行，留到下一輪跟更前面的內容接起來
            match buf.iter().position(|b| *b == b'\n') {
                None => {
                    carry = buf;
                    continue;
                }
                Some(nl) => {
                    carry = buf[..nl].to_vec();
                    buf[nl + 1..].to_vec()
                }
            }
        } else {
            buf
        };
        let text = String::from_utf8_lossy(&data);
        for line in text.lines().rev() {
            if !line.contains("\"type\":\"turn_context\"") {
                continue;
            }
            let Ok(j) = serde_json::from_str::<serde_json::Value>(line) else { continue };
            let Some(p) = j.get("payload") else { continue };
            let approval = match p.get("approval_policy") {
                Some(serde_json::Value::String(s)) => s.clone(),
                Some(v) if !v.is_null() && v != &serde_json::Value::Bool(false) => "granular".into(),
                _ => String::new(),
            };
            return Some(Policy { approval, sandbox: p.pointer("/sandbox_policy/type").and_then(|v| v.as_str()).unwrap_or("").to_string() });
        }
    }
    None
}

/// 沙盒是否為「完全存取」（danger-full-access／external-sandbox 都不當成可信的收件視窗）
pub fn is_full_access(p: &Policy) -> bool {
    matches!(p.sandbox.as_str(), "danger-full-access" | "external-sandbox" | "externalSandbox" | "dangerFullAccess")
}

#[cfg(test)]
mod tests {
    use super::*;

    const A: &str = "00000000-0000-7000-8000-000000000001";
    const B: &str = "00000000-0000-7000-8000-000000000002";

    #[test]
    fn 名字索引_後面的行蓋過前面_空名字等於沒有名字() {
        let d = tempfile::tempdir().unwrap();
        std::fs::write(
            d.path().join("session_index.jsonl"),
            format!("{{\"id\":\"{A}\",\"thread_name\":\"甲\"}}\n壞行\n{{\"id\":\"{B}\",\"thread_name\":\"乙\"}}\n{{\"id\":\"{A}\",\"thread_name\":\"甲2\"}}\n{{\"id\":\"{B}\",\"thread_name\":\"  \"}}\n"),
        )
        .unwrap();
        let (by_id, by_name) = read_name_index(d.path());
        assert_eq!(by_id.get(A).map(String::as_str), Some("甲2"));
        assert!(!by_id.contains_key(B));
        assert_eq!(by_name.get("甲2"), Some(&vec![A.to_string()]));
        assert!(read_name_index(&d.path().join("none")).0.is_empty());
    }

    #[test]
    fn 鎖檔_只認_uuid_格式_exists_模式只看檔案在不在() {
        let d = tempfile::tempdir().unwrap();
        let dir = d.path().join("thread-writer-locks");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(format!("{A}.lock")), "").unwrap();
        std::fs::write(dir.join("notes.txt"), "").unwrap();
        std::fs::write(dir.join("zz.lock"), "").unwrap();
        let ids = locked_thread_ids(d.path(), true);
        assert_eq!(ids.into_iter().collect::<Vec<_>>(), vec![A.to_string()]);
        assert!(locked_thread_ids(&d.path().join("none"), true).is_empty());
    }

    #[cfg(windows)]
    #[test]
    fn windows_殘檔沒人持有不算開著_有人以不共用方式開著才算() {
        use std::os::windows::fs::OpenOptionsExt;
        let d = tempfile::tempdir().unwrap();
        let dir = d.path().join("thread-writer-locks");
        std::fs::create_dir_all(&dir).unwrap();
        let f = dir.join(format!("{A}.lock"));
        std::fs::write(&f, "").unwrap();
        assert!(locked_thread_ids(d.path(), false).is_empty(), "殘檔：沒人持有");
        let _holder = std::fs::OpenOptions::new().read(true).write(true).share_mode(0).open(&f).unwrap();
        assert_eq!(locked_thread_ids(d.path(), false).len(), 1, "有人以不共用方式開著");
    }

    fn turn_context(sandbox: &str, approval: &str) -> String {
        format!("{{\"type\":\"turn_context\",\"payload\":{{\"approval_policy\":\"{approval}\",\"sandbox_policy\":{{\"type\":\"{sandbox}\"}}}}}}\n")
    }

    #[test]
    fn 權限設定_取最後一個_turn_context_完全存取被認出() {
        let d = tempfile::tempdir().unwrap();
        let f = d.path().join("r.jsonl");
        std::fs::write(&f, format!("{}{{\"type\":\"x\"}}\n{}{{\"type\":\"y\"}}\n", turn_context("read-only", "on-request"), turn_context("danger-full-access", "never"))).unwrap();
        let p = read_policy(&f, 1 << 20, 64 << 20).unwrap();
        assert_eq!(p, Policy { approval: "never".into(), sandbox: "danger-full-access".into() });
        assert!(is_full_access(&p));
        assert!(!is_full_access(&Policy { approval: String::new(), sandbox: "workspace-write".into() }));
        assert!(read_policy(&d.path().join("none"), 1 << 20, 64 << 20).is_none());
        std::fs::write(&f, "{\"type\":\"x\"}\n").unwrap();
        assert!(read_policy(&f, 1 << 20, 64 << 20).is_none(), "完全沒有 turn_context＝不知道");
    }

    #[test]
    fn 長對話_turn_context_離結尾很遠也讀得到_中文不會被段落切壞() {
        let d = tempfile::tempdir().unwrap();
        let f = d.path().join("long.jsonl");
        let mut text = turn_context("danger-full-access", "never");
        for i in 0..4000 {
            text.push_str(&format!("{{\"type\":\"item\",\"text\":\"填充內容{i}：中文字中文字中文字中文字\"}}\n"));
        }
        std::fs::write(&f, &text).unwrap();
        // 每段 4KB：turn_context 在最前面，要往回讀很多段，段落邊界會切到中文字
        let p = read_policy(&f, 4096, 64 << 20).unwrap();
        assert_eq!(p.sandbox, "danger-full-access");
        // 上限不夠大＝讀不到＝None（呼叫端 fail-closed）
        assert!(read_policy(&f, 4096, 8192).is_none());
    }
}

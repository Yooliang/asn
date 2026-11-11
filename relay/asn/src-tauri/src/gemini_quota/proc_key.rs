//! 視窗代號：這次狀態列指令是哪個 agy 行程叫起來的（#1316）。
//!
//! agy 的狀態列資料在剛開窗、還沒對話時沒有 session_id／conversation_id（實測），所以認不出是哪個視窗；
//! 但狀態列指令是 agy 叫起來的（agy → cmd／sh → asn-cli），同一個 agy 視窗從開到關都是同一個行程。
//! 所以從 asn-cli 自己的父行程往上找 agy 那一層，取「PID＋行程啟動時間」雜湊當視窗代號（key 優先；沒有才退回用 session_id）。
//! 規則（嚴格，不猜）：
//! - 從 asn-cli 自己的父行程開始，最多往上 40 層（跟 cli/caller.rs 的父行程鏈同一個上限）。
//! - 殼層（cmd、sh、bash、zsh、dash、powershell、pwsh）跳過，繼續往上。
//! - 名字要完全等於 `agy` 或 `agy.exe`（不分大小寫；不是「以 agy 開頭」）才取。
//! - 遇到別的行程（不是殼層也不是 agy）就停下來，不記；鏈斷掉（父行程不在行程表）、取不到啟動時間、macOS（沒有行程表）也不記。
//! 只用行程表的 pid、父 pid、執行檔名（比對用，不存、不進 log）與啟動時間；不讀命令列、工作目錄、環境變數或任何檔案。存下來的只有雜湊。
use super::seen::session_key;
use std::collections::HashMap;

/// pid → (父 pid, 程式名)；跟 cli/env.rs 的 `ProcTable` 是同一個型別（那個模組不對外，這裡不用它）
pub type ProcTable = HashMap<u32, (u32, String)>;

/// 往上最多找幾層（沿用 cli/caller.rs 的父行程鏈上限）
pub const MAX_HOPS: usize = 40;

/// 殼層名字（小寫、去掉 .exe 之後）
const SHELLS: [&str; 7] = ["cmd", "sh", "bash", "zsh", "dash", "powershell", "pwsh"];

fn base(name: &str) -> String {
    let n = name.to_ascii_lowercase();
    n.strip_suffix(".exe").map(String::from).unwrap_or(n)
}

/// 這個行程的 agy 視窗代號：找不到（鏈斷掉、遇到別的行程、層數超過、取不到啟動時間）回 None。
/// `started`＝行程啟動時間（毫秒，Linux 只到秒）；`self_pid`＝asn-cli 自己的 pid。
pub fn agy_key(self_pid: u32, table: &ProcTable, started: &dyn Fn(u32) -> Option<u64>) -> Option<String> {
    let mut pid = table.get(&self_pid)?.0;
    for _ in 0..MAX_HOPS {
        if pid == 0 {
            return None;
        }
        let (ppid, name) = table.get(&pid)?;
        let n = base(name);
        if n == "agy" {
            let st = started(pid)?;
            return Some(session_key(&format!("agy-process:{pid}:{st}")));
        }
        if !SHELLS.contains(&n.as_str()) {
            return None;
        }
        pid = *ppid;
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tbl(rows: &[(u32, u32, &str)]) -> ProcTable {
        rows.iter().map(|(p, pp, n)| (*p, (*pp, n.to_string()))).collect()
    }
    fn st(m: &[(u32, u64)]) -> impl Fn(u32) -> Option<u64> + '_ {
        move |p| m.iter().find(|(q, _)| *q == p).map(|(_, t)| *t)
    }

    #[test]
    fn windows_的鏈_asn_cli_cmd_agy_找到_agy_那一層() {
        let t = tbl(&[(100, 50, "asn-cli.exe"), (50, 10, "cmd.exe"), (10, 1, "agy.exe"), (1, 0, "explorer.exe")]);
        let k = agy_key(100, &t, &st(&[(10, 1_700_000_000_000)])).unwrap();
        assert_eq!(k.len(), 64, "sha256 十六進位");
        // 同一個 agy 行程：cmd 每次都是新的（pid 不同），key 一樣
        let t2 = tbl(&[(101, 51, "asn-cli.exe"), (51, 10, "cmd.exe"), (10, 1, "agy.exe")]);
        assert_eq!(agy_key(101, &t2, &st(&[(10, 1_700_000_000_000)])), Some(k));
    }

    #[test]
    fn linux_的鏈_asn_cli_sh_agy_名字不分大小寫() {
        let t = tbl(&[(100, 50, "asn-cli"), (50, 10, "sh"), (10, 1, "AGY")]);
        assert!(agy_key(100, &t, &st(&[(10, 5_000)])).is_some());
    }

    #[test]
    fn 多隔幾層殼層也找得到() {
        let t = tbl(&[(100, 50, "asn-cli.exe"), (50, 40, "cmd.exe"), (40, 30, "cmd.exe"), (30, 20, "powershell.exe"), (20, 10, "bash"), (10, 1, "agy.exe")]);
        assert!(agy_key(100, &t, &st(&[(10, 1)])).is_some());
    }

    #[test]
    fn 名字要完全相符_以_agy_開頭或包含_agy_都不算() {
        for name in ["agy-helper.exe", "agyd", "notagy.exe", "agy.exe.bak", "my-agy", "agy2"] {
            let t = tbl(&[(100, 50, "asn-cli"), (50, 10, "sh"), (10, 1, name)]);
            assert_eq!(agy_key(100, &t, &st(&[(10, 1)])), None, "{name}");
        }
    }

    #[test]
    fn 遇到不是殼層也不是_agy_的行程就停下來_不往上猜() {
        // agy 在更上面，但中間隔了別的程式（例如終端機或 IDE）：不記
        let t = tbl(&[(100, 50, "asn-cli"), (50, 40, "node.exe"), (40, 10, "cmd.exe"), (10, 1, "agy.exe")]);
        assert_eq!(agy_key(100, &t, &st(&[(10, 1)])), None);
        // 沒有 agy：一路是殼層和使用者的終端機
        let t = tbl(&[(100, 50, "asn-cli"), (50, 40, "bash"), (40, 1, "gnome-terminal")]);
        assert_eq!(agy_key(100, &t, &st(&[])), None);
    }

    #[test]
    fn 鏈斷掉_自己或父行程不在行程表_取不到啟動時間_都不記() {
        let t = tbl(&[(100, 50, "asn-cli"), (50, 10, "sh"), (10, 1, "agy")]);
        assert_eq!(agy_key(999, &t, &st(&[(10, 1)])), None, "自己不在行程表");
        let t2 = tbl(&[(100, 50, "asn-cli"), (50, 10, "sh")]);
        assert_eq!(agy_key(100, &t2, &st(&[(10, 1)])), None, "父行程已不在（鏈斷掉）");
        assert_eq!(agy_key(100, &t, &st(&[])), None, "取不到啟動時間（沒權限）");
        assert_eq!(agy_key(100, &tbl(&[(100, 0, "asn-cli")]), &st(&[])), None, "沒有父行程");
        assert_eq!(agy_key(100, &ProcTable::new(), &st(&[])), None, "空的行程表（例如 macOS 沒有 /proc）");
    }

    #[test]
    fn 層數上限_40_層_超過不記() {
        // 41 層殼層之後才是 agy
        let mut rows: Vec<(u32, u32, String)> = vec![(1000, 1001, "asn-cli".into())];
        for i in 0..41u32 {
            rows.push((1001 + i, 1002 + i, "cmd.exe".into()));
        }
        rows.push((1042, 1, "agy.exe".into()));
        let t: ProcTable = rows.iter().map(|(p, pp, n)| (*p, (*pp, n.clone()))).collect();
        assert_eq!(agy_key(1000, &t, &st(&[(1042, 1)])), None, "超過上限");
        // 39 層殼層：剛好在上限內
        let mut rows: Vec<(u32, u32, String)> = vec![(1000, 1001, "asn-cli".into())];
        for i in 0..39u32 {
            rows.push((1001 + i, 1002 + i, "cmd.exe".into()));
        }
        rows.push((1040, 1, "agy.exe".into()));
        let t: ProcTable = rows.iter().map(|(p, pp, n)| (*p, (*pp, n.clone()))).collect();
        assert!(agy_key(1000, &t, &st(&[(1040, 1)])).is_some());
    }

    #[test]
    fn 迴圈的行程表不會卡住() {
        let t = tbl(&[(100, 50, "asn-cli"), (50, 60, "cmd.exe"), (60, 50, "cmd.exe")]);
        assert_eq!(agy_key(100, &t, &st(&[])), None);
    }

    #[test]
    fn pid_被重用但啟動時間不同_key_不同_兩個視窗_key_不同() {
        let t = tbl(&[(100, 50, "asn-cli"), (50, 10, "sh"), (10, 1, "agy")]);
        let a = agy_key(100, &t, &st(&[(10, 1_000)])).unwrap();
        let b = agy_key(100, &t, &st(&[(10, 2_000)])).unwrap();
        assert_ne!(a, b, "同 pid、啟動時間不同＝不同行程");
        let t2 = tbl(&[(100, 50, "asn-cli"), (50, 11, "sh"), (11, 1, "agy")]);
        assert_ne!(agy_key(100, &t2, &st(&[(11, 1_000)])).unwrap(), a, "不同視窗");
    }

    #[test]
    fn key_只是雜湊_不含_pid_或啟動時間的原文() {
        let t = tbl(&[(100, 50, "asn-cli"), (50, 4242, "sh"), (4242, 1, "agy")]);
        let k = agy_key(100, &t, &st(&[(4242, 1_700_000_123_456)])).unwrap();
        assert!(k.chars().all(|c| c.is_ascii_hexdigit()));
        assert!(!k.contains("4242") || k.len() == 64, "{k}");
        assert_ne!(k, session_key("4242"), "跟 session_id 的雜湊不會撞（內容帶了前綴）");
    }
}

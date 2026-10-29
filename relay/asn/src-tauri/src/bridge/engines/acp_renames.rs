//! 內建通道工作者改名後的「舊名 → 新名」對照：工作資料夾的 acp-renames.json（{"version":1,"renamed":[{from,to,at}]}）。
//! 後台會把寄給舊名的信轉投 7 天，但舊名在名單上還會留幾分鐘、改名前已排在後台的信也還寫著舊名；
//! 這裡記 7 天補那段空窗（`AcpEngine::canonical_name` 用它把舊名換成新名）。ASN 重開後照樣讀得到；連續改名 A→B→C 串起來。
//! 檔案壞了就當沒有（不影響收信）；寫檔一律原子寫入，失敗回錯誤讓改名整個還原。
use serde_json::{json, Value};
use std::path::Path;

pub const RENAMES_FILE: &str = "acp-renames.json";

/// 對照只記這麼久（毫秒）：和後台轉投舊名的期限一樣是 7 天
pub const KEEP_MS: u64 = 7 * 24 * 60 * 60 * 1000;

#[derive(Debug, Clone, PartialEq)]
pub struct Renamed {
    pub from: String,
    pub to: String,
    pub at: u64,
}

/// 讀對照：沒有檔案、讀不懂都當沒有；超過 7 天的不算
pub fn read(file: &Path, now_ms: u64) -> Vec<Renamed> {
    let Ok(t) = std::fs::read_to_string(file) else { return vec![] };
    let Ok(v) = serde_json::from_str::<Value>(t.trim_start_matches('\u{feff}')) else { return vec![] };
    v.get("renamed")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|e| {
            let s = |k: &str| e.get(k).and_then(Value::as_str).map(str::to_string).filter(|x| !x.is_empty());
            Some(Renamed { from: s("from")?, to: s("to")?, at: e.get("at").and_then(Value::as_u64)? })
        })
        .filter(|r| now_ms.saturating_sub(r.at) < KEEP_MS)
        .collect()
}

/// 舊名一路串到現在的名字（A→B→C：問 A 得到 C）。不在對照裡、或繞回自己，回 None
pub fn resolve(list: &[Renamed], name: &str) -> Option<String> {
    let mut cur = name.to_string();
    for _ in 0..=list.len() {
        match list.iter().filter(|r| r.from == cur).max_by_key(|r| r.at) {
            Some(r) => cur = r.to.clone(),
            None => break,
        }
        if cur == name {
            return None;
        }
    }
    (cur != name).then_some(cur)
}

/// 記一筆 from → to。新名字現在是活的名字，所以以它當舊名的舊紀錄一併拿掉（改回原名 B→A 時，A 不再被轉走）；過期的順手清掉
pub fn record(file: &Path, from: &str, to: &str, now_ms: u64) -> Result<(), String> {
    let mut list = read(file, now_ms);
    list.retain(|r| r.from != from && !r.from.eq_ignore_ascii_case(to));
    list.push(Renamed { from: from.to_string(), to: to.to_string(), at: now_ms });
    let arr: Vec<Value> = list.iter().map(|r| json!({ "from": r.from, "to": r.to, "at": r.at })).collect();
    crate::write_atomic(file, &json!({ "version": 1, "renamed": arr }).to_string()).map_err(|e| format!("{}：{e}", file.display()))
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: u64 = 1_800_000_000_000;
    const DAY: u64 = 24 * 60 * 60 * 1000;

    #[test]
    fn 記下的對照_連續改名串起來_改回原名不再轉走_繞圈回_none() {
        let d = tempfile::tempdir().unwrap();
        let f = d.path().join(RENAMES_FILE);
        assert!(read(&f, NOW).is_empty(), "沒有檔案＝沒有對照");
        record(&f, "甲", "乙", NOW).unwrap();
        record(&f, "乙", "丙", NOW + 1).unwrap();
        let l = read(&f, NOW + 2);
        assert_eq!(resolve(&l, "甲").as_deref(), Some("丙"), "A→B→C 串起來");
        assert_eq!(resolve(&l, "乙").as_deref(), Some("丙"));
        assert_eq!(resolve(&l, "丙"), None, "現在的名字不用換");
        assert_eq!(resolve(&l, "別人"), None);
        // 改回原名：丙 → 甲，甲是活的名字了，不能再被轉走
        record(&f, "丙", "甲", NOW + 3).unwrap();
        let l = read(&f, NOW + 4);
        assert_eq!(resolve(&l, "甲"), None);
        assert_eq!(resolve(&l, "丙").as_deref(), Some("甲"));
        assert_eq!(resolve(&l, "乙").as_deref(), Some("甲"), "乙 → 丙 → 甲");
        // 手改出來的繞圈不會卡住
        let ring = vec![Renamed { from: "A".into(), to: "B".into(), at: NOW }, Renamed { from: "B".into(), to: "A".into(), at: NOW }];
        assert_eq!(resolve(&ring, "A"), None);
    }

    #[test]
    fn 七天後自動忘_檔案壞了當沒有() {
        let d = tempfile::tempdir().unwrap();
        let f = d.path().join(RENAMES_FILE);
        record(&f, "甲", "乙", NOW).unwrap();
        assert_eq!(resolve(&read(&f, NOW + 7 * DAY - 1), "甲").as_deref(), Some("乙"), "7 天內還記得");
        assert!(read(&f, NOW + 7 * DAY).is_empty(), "滿 7 天就忘");
        // 再記一筆時把過期的清掉
        record(&f, "丙", "丁", NOW + 8 * DAY).unwrap();
        assert_eq!(read(&f, NOW + 8 * DAY).len(), 1);
        assert!(!std::fs::read_to_string(&f).unwrap().contains("甲"), "過期的不留在檔案裡");
        std::fs::write(&f, "{壞").unwrap();
        assert!(read(&f, NOW).is_empty());
    }
}

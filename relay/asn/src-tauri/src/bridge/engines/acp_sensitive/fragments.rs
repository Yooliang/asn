//! 一般文字（有空白的長文字、多行文字）裡夾著敏感位置路徑時，把那段路徑挑出來交給判定。
//! 片段不手寫：從敏感清單（`SENSITIVE_HOME_DIRS`、`EXTRA_HOME_PATHS`、檔名前綴清單、系統層清單）的每一項取最後兩段自動產生，
//! 所以清單加一項，這裡自動跟著認得。比對不分大小寫、斜線方向不分，而且要在路徑段的邊界上。
use super::{EXTRA_HOME_PATHS, HOST_KEY_DIR, PREFIX_HOME_FILES, SENSITIVE_HOME_DIRS, SYSTEM_FILES};
use std::sync::OnceLock;

/// 同時處理的片段命中上限（防超長文字拖慢）
pub(super) const MAX_HITS: usize = 50;
/// 每個命中往前找幾個空白邊界當路徑起點（路徑本身可能含空白，例如 `Program Files`）
pub(super) const MAX_STARTS: usize = 8;

/// 正規化：只轉 ASCII 小寫與斜線方向，位元組長度不變，索引才能對回原字串
fn norm(s: &str) -> String {
    s.replace('\\', "/").to_ascii_lowercase()
}

/// 清單每一項的最後兩段（只有一段的就是那一段）
pub(super) fn fragments() -> &'static Vec<String> {
    static F: OnceLock<Vec<String>> = OnceLock::new();
    F.get_or_init(|| {
        let rels = SENSITIVE_HOME_DIRS
            .iter()
            .chain(EXTRA_HOME_PATHS.iter())
            .map(|s| s.to_string())
            .chain(PREFIX_HOME_FILES.iter().map(|(d, p)| format!("{d}/{p}")))
            .chain(SYSTEM_FILES.iter().map(|s| s.to_string()))
            .chain([HOST_KEY_DIR.to_string()]);
        let mut out: Vec<String> = vec![];
        for r in rels {
            let n = norm(&r);
            let segs: Vec<&str> = n.split('/').filter(|s| !s.is_empty()).collect();
            if segs.is_empty() {
                continue;
            }
            let tail = segs[segs.len().saturating_sub(2)..].join("/");
            if !out.contains(&tail) {
                out.push(tail);
            }
        }
        out
    })
}

pub(super) const LEAD: &[u8] = b"/ \t\"'(=:";
pub(super) const TRAIL: &[u8] = b"/ \t\"'),;:";
/// 片段兩側夾著的修剪字元（候選路徑前後去掉）
pub(super) const TRIM: &str = "\"'(),;";

/// 一行有空白的文字：夾著敏感位置片段的，回傳可能的路徑候選（從幾個空白邊界到片段後面那段路徑結束），其餘回空
pub(super) fn prose_candidates(line: &str) -> Vec<String> {
    let n = norm(line);
    let b = n.as_bytes();
    let mut out: Vec<String> = vec![];
    let mut hits = 0;
    for f in fragments() {
        for (i, _) in n.match_indices(f.as_str()) {
            let end = i + f.len();
            let lead_ok = i == 0 || LEAD.contains(&b[i - 1]);
            let trail_ok = end == b.len() || TRAIL.contains(&b[end]);
            if !lead_ok || !trail_ok {
                continue;
            }
            hits += 1;
            if hits > MAX_HITS {
                return out;
            }
            let stop = line[end..].find(char::is_whitespace).map_or(line.len(), |k| end + k);
            let mut starts: Vec<usize> = vec![0];
            starts.extend(line[..i].char_indices().filter(|(_, c)| c.is_whitespace()).map(|(k, c)| k + c.len_utf8()));
            starts.dedup();
            let from = starts.len().saturating_sub(MAX_STARTS);
            for j in &starts[from..] {
                let c = line[*j..stop].trim_matches(|c: char| TRIM.contains(c));
                if !c.is_empty() && !out.iter().any(|x| x == c) {
                    out.push(c.to_string());
                }
            }
        }
    }
    out
}

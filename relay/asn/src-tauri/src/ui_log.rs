//! 主視窗的記錄寫進檔案（#339 收尾）：畫面上 `[ASN]` 開頭的 console 記錄（收信失敗、ack 失敗、連線原因…）以前只進 devtools，
//! 事後查不到。前端（ui/lib/ui-log.mjs）每隔幾秒整批送來，這裡附加到機器資料夾的 ui.log（跟 bridge.log 放一起）。
//! 每行限長、拿掉控制字元；檔案超過 1 MB 就只留後半。寫不進去不影響畫面。
use std::path::{Path, PathBuf};

pub const UI_LOG_FILE: &str = "ui.log";
const MAX_BYTES: u64 = 1024 * 1024;
/// 一行最多幾個字（前端也會截，這裡再擋一次）
pub const LINE_MAX: usize = 500;
/// 一次最多收幾行（多的丟掉，不讓畫面一次塞爆檔案）
pub const LINES_MAX: usize = 200;

pub fn path(dir: &Path) -> PathBuf {
    dir.join(UI_LOG_FILE)
}

/// 一行記錄：拿掉控制字元（含換行），去頭尾空白，限長；整行空白回 None
pub fn clean_line(s: &str) -> Option<String> {
    let t: String = s.chars().map(|c| if c.is_control() { ' ' } else { c }).take(LINE_MAX).collect();
    let t = t.trim();
    (!t.is_empty()).then(|| t.to_string())
}

/// 附加一批記錄。回實際寫進去的行數
pub fn append(dir: &Path, lines: &[String]) -> Result<usize, String> {
    use std::io::Write;
    let rows: Vec<String> = lines.iter().take(LINES_MAX).filter_map(|l| clean_line(l)).collect();
    if rows.is_empty() {
        return Ok(0);
    }
    let p = path(dir);
    if std::fs::metadata(&p).map(|m| m.len() > MAX_BYTES).unwrap_or(false) {
        if let Ok(t) = std::fs::read_to_string(&p) {
            let keep = t.get(t.len() / 2..).unwrap_or("");
            let keep = keep.find('\n').map(|i| &keep[i + 1..]).unwrap_or("");
            let _ = std::fs::write(&p, keep);
        }
    }
    let mut f = std::fs::OpenOptions::new().create(true).append(true).open(&p).map_err(|e| e.to_string())?;
    let mut text = rows.join("\n");
    text.push('\n');
    f.write_all(text.as_bytes()).map_err(|e| e.to_string())?;
    Ok(rows.len())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 每行拿掉控制字元_限長_空白行不寫() {
        assert_eq!(clean_line("  [ASN] pull failed\nx\t y  ").as_deref(), Some("[ASN] pull failed x  y"));
        assert_eq!(clean_line(" \n\t ").as_deref(), None);
        assert_eq!(clean_line(&"字".repeat(LINE_MAX + 50)).unwrap().chars().count(), LINE_MAX);
    }

    #[test]
    fn 附加到_ui_log_一次最多收_lines_max_行_超過一_mb_只留後半() {
        let d = tempfile::tempdir().unwrap();
        assert_eq!(append(d.path(), &["a".into(), " ".into(), "b".into()]).unwrap(), 2);
        assert_eq!(append(d.path(), &[]).unwrap(), 0);
        assert_eq!(std::fs::read_to_string(path(d.path())).unwrap(), "a\nb\n");
        let many: Vec<String> = (0..LINES_MAX + 30).map(|i| format!("line{i}")).collect();
        assert_eq!(append(d.path(), &many).unwrap(), LINES_MAX);
        // 灌到超過上限：下一次寫入前先砍成後半，檔案不會一直長大
        let big = "x".repeat(LINE_MAX);
        while std::fs::metadata(path(d.path())).unwrap().len() <= MAX_BYTES {
            append(d.path(), &vec![big.clone(); 100]).unwrap();
        }
        append(d.path(), &["最後一行".into()]).unwrap();
        let after = std::fs::read_to_string(path(d.path())).unwrap();
        assert!((after.len() as u64) < MAX_BYTES, "{}", after.len());
        assert!(after.ends_with("最後一行\n"));
        assert!(!after.starts_with('x') || after.lines().next().unwrap().len() == LINE_MAX, "砍在行尾，不留半行");
    }
}

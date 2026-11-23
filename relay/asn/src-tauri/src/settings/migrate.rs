//! 版本與遷移、壞檔處理（只有檔案與 JSON 的動作，不管鎖與快取）。
//! 規則（#2162 方案 B-5）：
//! - 檔案沒有 `version`＝版本 0＝舊檔。讀取時只在記憶體裡升版，**不改檔**；第一次正常寫入才補上 `version`。
//! - 升版前先備份 `<檔>.json.v<舊版>.bak`（同名已存在就不覆蓋）；備份發生在「第一次要把升版結果寫回去」之前。
//! - 壞檔改名（失敗改複製）成 `<檔>.json.bad-<時間>`，最多留 3 份；記錄只寫檔名與原因，不寫內容。兩個都失敗就不准覆蓋原檔。
use super::{Doc, SettingsError};
use serde_json::{Map, Value};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

/// 壞檔最多留幾份
pub const KEEP_BAD: usize = 3;

/// 純函式：把檔案文字解析成 Doc。回傳（值，檔案上的版本）；失敗回固定的中文原因（不含檔案內容）。
pub fn parse<T: Doc>(text: &str) -> Result<(T, u32), String> {
    // 手改設定的人常帶 UTF-8 BOM：先去掉再解析，不因此搬成壞檔
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    let raw: Value = serde_json::from_str(text).map_err(|_| "不是合法的 JSON".to_string())?;
    let Value::Object(mut obj) = raw else {
        return Err("最上層不是物件".into());
    };
    let file_version = take_version(&mut obj);
    let mut raw = Value::Object(obj);
    if file_version < T::VERSION {
        for from in file_version..T::VERSION {
            T::migrate(from, &mut raw).map_err(|e| format!("遷移第 {from} 版失敗：{e}"))?;
        }
    }
    let mut v: T = serde_json::from_value(raw).map_err(|_| "欄位型別不符".to_string())?;
    v.normalize();
    Ok((v, file_version))
}

/// 取出並移除 `version`；沒有或不是非負整數＝0
fn take_version(obj: &mut Map<String, Value>) -> u32 {
    obj.remove("version").and_then(|v| v.as_u64()).map(|n| n.min(u32::MAX as u64) as u32).unwrap_or(0)
}

/// 把 Doc 序列化成要寫的文字：`version` 放第一個欄位，其餘照序列化順序
pub fn render<T: Doc>(v: &T, version: u32) -> Result<String, SettingsError> {
    let Value::Object(body) = serde_json::to_value(v).map_err(|e| SettingsError(e.to_string()))? else {
        return Err(SettingsError("設定的最上層必須是物件".into()));
    };
    let mut out = Map::new();
    out.insert("version".into(), Value::from(version));
    for (k, val) in body {
        if k != "version" {
            out.insert(k, val);
        }
    }
    serde_json::to_string_pretty(&Value::Object(out)).map_err(|e| SettingsError(e.to_string()))
}

fn suffixed(path: &Path, suffix: &str) -> PathBuf {
    let mut s = path.as_os_str().to_os_string();
    s.push(suffix);
    PathBuf::from(s)
}

/// 升版（或讀到比程式新的版本）後第一次寫回之前備份舊內容：`<檔>.v<檔案版本>.bak`，已存在就不動。
/// 備份失敗回 Err（錯誤種類），呼叫端不准寫入，免得舊檔在沒有備份下被蓋掉
pub fn backup_old(path: &Path, from: u32) -> Result<(), String> {
    let bak = suffixed(path, &format!(".v{from}.bak"));
    if bak.exists() || !path.is_file() {
        return Ok(());
    }
    do_copy(path, &bak).map(|_| ()).map_err(|e| {
        elog!("[ASN] 設定檔 {} 寫入前備份失敗：{}，這次不寫入", file_name(path), e.kind());
        let _ = std::fs::remove_file(&bak);
        format!("{:?}", e.kind())
    })
}

static BAD_SEQ: AtomicU64 = AtomicU64::new(0);

/// 測試用的失敗注入（只有當前執行緒；正式版沒有這段）
#[cfg(test)]
thread_local! {
    pub static FAIL_RENAME: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
    pub static FAIL_COPY: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

fn do_rename(from: &Path, to: &Path) -> std::io::Result<()> {
    #[cfg(test)]
    if FAIL_RENAME.with(|f| f.get()) {
        return Err(std::io::Error::new(std::io::ErrorKind::PermissionDenied, "測試注入：改名失敗"));
    }
    std::fs::rename(from, to)
}

fn do_copy(from: &Path, to: &Path) -> std::io::Result<u64> {
    #[cfg(test)]
    if FAIL_COPY.with(|f| f.get()) {
        return Err(std::io::Error::new(std::io::ErrorKind::PermissionDenied, "測試注入：複製失敗"));
    }
    std::fs::copy(from, to)
}

/// 壞檔留一份副本：優先改名為 `<檔>.bad-<毫秒>-<序號>`；改名失敗就複製（成功後再盡量刪掉原檔）。
/// 兩個都失敗回 Err（錯誤種類）：原檔還在原位，呼叫端不准寫入覆蓋它。
/// 舊的副本只留 KEEP_BAD 份，剛建的這份絕不刪。記一行，只含檔名與原因
pub fn quarantine(path: &Path, reason: &str) -> Result<(), String> {
    let ms = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0);
    let seq = BAD_SEQ.fetch_add(1, Ordering::Relaxed);
    let bad = suffixed(path, &format!(".bad-{ms:015}-{seq:06}"));
    let r = match do_rename(path, &bad) {
        Ok(()) => {
            elog!("[ASN] 設定檔 {} 損毀（{reason}），已改名為 {} 並退回預設", file_name(path), file_name(&bad));
            Ok(())
        }
        Err(e) => match do_copy(path, &bad) {
            Ok(_) => {
                let _ = std::fs::remove_file(path);
                elog!("[ASN] 設定檔 {} 損毀（{reason}），改名失敗（{}），已複製為 {} 並退回預設", file_name(path), e.kind(), file_name(&bad));
                Ok(())
            }
            Err(e2) => {
                let _ = std::fs::remove_file(&bad);
                elog!("[ASN] 設定檔 {} 損毀（{reason}），改名失敗（{}）、複製也失敗（{}），不覆蓋原檔", file_name(path), e.kind(), e2.kind());
                Err(format!("{:?}", e2.kind()))
            }
        },
    };
    if r.is_ok() {
        prune_bad(path, &bad);
    }
    r
}

/// 只留 KEEP_BAD 份：依檔名排序刪最舊的，`keep`（剛建的）絕不刪——時鐘倒退時它可能排在最前面
fn prune_bad(path: &Path, keep: &Path) {
    let (Some(dir), Some(name)) = (path.parent(), path.file_name().and_then(|n| n.to_str())) else { return };
    let prefix = format!("{name}.bad-");
    let keep_name = file_name(keep);
    let Ok(rd) = std::fs::read_dir(dir) else { return };
    let mut others: Vec<String> = rd.flatten().filter_map(|e| e.file_name().into_string().ok()).filter(|n| n.starts_with(&prefix) && *n != keep_name).collect();
    others.sort(); // 毫秒補零到固定位數，字典序＝時間序
    while others.len() + 1 > KEEP_BAD {
        let old = others.remove(0);
        let _ = std::fs::remove_file(dir.join(old));
    }
}

fn file_name(p: &Path) -> String {
    p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()
}

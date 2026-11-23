use crate::settings::{LoadStatus, LaunchPrefsDoc};
use serde_json::Value;
use std::path::{Path, PathBuf};

pub fn launch_prefs_path(data_dir: &Path) -> PathBuf {
    data_dir.join("launch-prefs.json")
}

/// 讀整份啟動偏好（走共用設定層，#2162）。**唯讀**：不搬檔、不寫檔（收發室橋那一側也在讀，搬檔只准在寫入時發生）。
/// 沒有檔＝`{}`；暫時讀不到＝`{}`（照舊）；壞檔回 `Err`（固定白話句），呼叫端照舊用預設，下次畫面存檔時才把壞檔搬走
pub fn launch_prefs_get_sync(data_dir: &Path) -> Result<Value, String> {
    let l = crate::settings::peek_in::<LaunchPrefsDoc>(data_dir);
    match l.status {
        LoadStatus::Corrupt { .. } => Err("啟動設定檔損毀，這次先用預設值".into()),
        _ => Ok(Value::Object(l.value.extra)),
    }
}

/// 這台「開新夥伴的顯示方式」偏好（launchDisplay：foreground／background）；沒存過、讀不到或不是字串回 None（#931 遠端開照這台設定用）
pub fn launch_display_pref(data_dir: &Path) -> Option<String> {
    launch_prefs_get_sync(data_dir).ok()?.get("launchDisplay")?.as_str().map(String::from)
}

/// 整份存（畫面存檔用）。上限 200,000 位元組、一定要是物件。檔案是壞的就先搬成 `.bad-` 再寫；檔裡的 `version` 另外管，不受這份影響
pub fn launch_prefs_set_sync(data_dir: &Path, prefs: Value) -> Result<(), String> {
    check_prefs_shape(&prefs)?;
    launch_prefs_update(data_dir, |v| *v = prefs).map(|_| ())
}

/// 存檔前的形狀檢查：要是物件、序列化後不超過 200,000 位元組
pub fn check_prefs_shape(prefs: &Value) -> Result<(), String> {
    if !prefs.is_object() {
        return Err("設定格式不對".into());
    }
    let text = serde_json::to_string(prefs).map_err(|e| e.to_string())?;
    if text.len() > 200_000 {
        return Err("設定太大".into());
    }
    Ok(())
}

/// 持鎖「讀、改、寫」啟動偏好（一律重讀原檔）。`f` 拿到整份物件，欄位原樣保留，改哪個動哪個。寫不進去回固定白話句
pub fn launch_prefs_update<R>(data_dir: &Path, f: impl FnOnce(&mut Value) -> R) -> Result<R, String> {
    match launch_prefs_try_update::<R, std::convert::Infallible>(data_dir, |v| Ok(f(v)))? {
        Ok(r) => Ok(r),
        Err(never) => match never {},
    }
}

/// 同上，但 `f` 回 `Err`（驗證沒過）就不寫檔，原樣交回
pub fn launch_prefs_try_update<R, E>(data_dir: &Path, f: impl FnOnce(&mut Value) -> Result<R, E>) -> Result<Result<R, E>, String> {
    std::fs::create_dir_all(data_dir).map_err(|_| "設定資料夾建不起來，這次沒有存".to_string())?;
    crate::settings::try_update_in::<LaunchPrefsDoc, R, E>(data_dir, |d| {
        let mut v = Value::Object(std::mem::take(&mut d.extra));
        let r = f(&mut v);
        if let Value::Object(m) = v {
            d.extra = m;
        }
        r
    })
    .map_err(|e| e.to_string())
}

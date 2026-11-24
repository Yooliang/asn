//! 每視窗每小時寄信上限的計數（~/.asn/send-rate.json）。
//! 寄信（asn send）與收信端（橋轉交、視窗自己 recv）都會寫這個檔，所以讀改寫一律先拿鎖檔、寫入用暫存檔＋rename，避免寫壞。
//! 本人（擁有者）簽章的私信寄到某視窗時，退回那個視窗一封額度（`refund`）：一來一回不累積，沒人在場時夥伴失控連發照樣被擋。
use serde_json::{json, Map, Value};
use std::path::{Path, PathBuf};

const HOUR: u64 = 3_600_000;
const FILE: &str = "send-rate.json";
/// 已經退過額度的信（一封信只退一次；橋重送、重啟後重看到同一封都不會再退）
const REFUNDED: &str = "send-refunded.json";
const LOCK: &str = "send-rate.lock";
const KEEP_IDS: usize = 200;
/// 鎖檔超過這麼久還在，當作前一個程序掛掉遺留
const LOCK_STALE_MS: u128 = 10_000;
/// 寄信等鎖最多 8 秒（比 `LOCK_STALE_MS` 短，不會等到把活著的鎖當遺留）；退額度是在橋的收信迴圈裡做，等太久會卡住收信，所以只等約 0.4 秒，拿不到就不退。
/// 以時間計、不以次數計：機器很忙時睡眠會拖長，次數用完的牆上時間不可預期（#2291：整套測試高並行時 2 秒內沒輪到就放棄、無鎖照寫，少算 1～3 封）。
const LOCK_WAIT_SEND: std::time::Duration = std::time::Duration::from_secs(8);
const LOCK_WAIT_REFUND: std::time::Duration = std::time::Duration::from_millis(400);
/// 輪詢間隔：短一點，鎖一放掉就有人接手；各程序／執行緒錯開一點，避免同拍搶
const LOCK_POLL_MS: u64 = 5;
/// 剩這麼多封（含）以下，寄信後提醒
pub const WARN_LEFT: usize = 5;

/// 持鎖者：鎖檔內容是自己的辨識碼（程序號－時間－流水號），放鎖時內容對得上才刪，
/// 免得清理競態把自己的鎖搬走後，放鎖時又刪到別人的新鎖（#2294）
struct Lock(PathBuf, String);
impl Drop for Lock {
    fn drop(&mut self) {
        if std::fs::read_to_string(&self.0).map(|c| c == self.1).unwrap_or(false) {
            let _ = std::fs::remove_file(&self.0);
        }
    }
}

fn new_token() -> String {
    static SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    format!("{}-{}-{}", std::process::id(), nanos, SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed))
}

/// 建鎖檔並寫入辨識碼。建檔與寫內容之間別的程序會讀到空檔：清理端以修改時間判遺留，空檔但剛建立不算遺留
fn create_lock(p: &Path) -> std::io::Result<Lock> {
    use std::io::Write;
    let mut f = std::fs::OpenOptions::new().write(true).create_new(true).open(p)?;
    let token = new_token();
    if let Err(e) = f.write_all(token.as_bytes()) {
        drop(f);
        let _ = std::fs::remove_file(p);
        return Err(e);
    }
    Ok(Lock(p.to_path_buf(), token))
}

fn is_stale_mtime(p: &Path) -> bool {
    std::fs::metadata(p).and_then(|m| m.modified()).ok().and_then(|t| t.elapsed().ok()).map(|d| d.as_millis() > LOCK_STALE_MS).unwrap_or(false)
}

/// 清理遺留鎖（#2294）。不能直接刪：判斷遺留後、刪之前，別人可能已刪掉舊鎖並建好新鎖，直接刪會刪到人家的新鎖。
/// 做法：記下判斷時讀到的內容 → rename 到專屬暫存名（這一步之後路徑上就沒有這把鎖，別人看不到）→
/// 暫存檔內容仍等於記下的內容、且修改時間仍是遺留，才刪；否則搬到的是別人的新鎖，原樣還回。
/// 還回用 hard_link（目標已存在就失敗、不會蓋掉別人）：失敗代表這段空窗裡又有人建了鎖，保留他的、丟掉暫存檔。
/// 殘留風險：搬走到還回之間是微秒級空窗，若恰有第三人在此時建鎖，會有兩人同時持鎖；
/// 這把鎖只護一個小計數檔，最壞結果是少算一次（與拿不到鎖照寫的後備相同），放鎖時也只刪自己的內容，不會連鎖刪錯。
fn reap_stale(p: &Path, before_rename: impl FnOnce()) {
    if !is_stale_mtime(p) {
        return;
    }
    let seen = std::fs::read_to_string(p).ok();
    before_rename(); // 測試掛鉤：判斷遺留之後、rename 之前
    let Some(seen) = seen else { return };
    let tmp = p.with_file_name(format!("{LOCK}.reap-{}", new_token()));
    // 搬不動（已被別人刪掉、或 Windows 上被開著）就算了，下一圈再判斷
    if std::fs::rename(p, &tmp).is_err() {
        return;
    }
    let same = std::fs::read_to_string(&tmp).map(|c| c == seen).unwrap_or(false) && is_stale_mtime(&tmp);
    if same {
        let _ = std::fs::remove_file(&tmp);
        return;
    }
    match std::fs::hard_link(&tmp, p) {
        Ok(()) => {
            let _ = std::fs::remove_file(&tmp);
        }
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
            let _ = std::fs::remove_file(&tmp);
        }
        // 檔案系統不支援硬連結：退而求其次用 rename（目標已存在時在 Windows 會失敗，失敗就留著暫存檔不刪，不丟別人的鎖）
        Err(_) => {
            if std::fs::rename(&tmp, p).is_err() && p.exists() {
                let _ = std::fs::remove_file(&tmp);
            }
        }
    }
}

/// 拿鎖（最多等 `wait` 的時間）；拿不到回 None，由呼叫端決定要不要照樣做
fn lock(home: &Path, wait: std::time::Duration) -> Option<Lock> {
    let _ = std::fs::create_dir_all(home);
    let p = home.join(LOCK);
    let start = std::time::Instant::now();
    let mut n: u64 = 0;
    while n == 0 || start.elapsed() < wait {
        n += 1;
        match create_lock(&p) {
            Ok(l) => return Some(l),
            // Windows：鎖檔剛被刪、還在刪除中時，建檔回「拒絕存取」不是「已存在」。當成別人拿著，等一下再試；
            // 回 None 的話 take 會不拿鎖照樣寫，互相蓋掉就少算（#752，平行測試約 10% 會紅）
            Err(e) if matches!(e.kind(), std::io::ErrorKind::AlreadyExists | std::io::ErrorKind::PermissionDenied) => {
                if is_stale_mtime(&p) {
                    reap_stale(&p, || {});
                } else {
                    // 加上程序號與次數造成的小抖動（0～4 毫秒）
                    std::thread::sleep(std::time::Duration::from_millis(LOCK_POLL_MS + (u64::from(std::process::id()) + n) % 5));
                }
            }
            Err(_) => return None,
        }
    }
    None
}

/// 讀計數檔，只留一小時內的時間點
fn load(home: &Path, now: u64) -> Map<String, Value> {
    let all: Map<String, Value> = std::fs::read_to_string(home.join(FILE)).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default();
    let mut cleaned = Map::new();
    for (k, v) in all.iter() {
        let kept: Vec<Value> = v.as_array().map(|a| a.iter().filter(|t| t.as_u64().map(|t| now.saturating_sub(t) < HOUR).unwrap_or(false)).cloned().collect()).unwrap_or_default();
        if !kept.is_empty() {
            cleaned.insert(k.clone(), Value::Array(kept));
        }
    }
    cleaned
}

fn recent_of(all: &Map<String, Value>, window: &str) -> Vec<u64> {
    all.get(window).and_then(Value::as_array).map(|a| a.iter().filter_map(Value::as_u64).collect()).unwrap_or_default()
}

/// 寄一封前先計次。成功回「寄完還剩幾封」；已滿回 Err(幾分鐘後可再寄)
pub fn take(home: &Path, window: &str, limit: usize, now: u64) -> Result<usize, u64> {
    let _lock = lock(home, LOCK_WAIT_SEND); // 拿不到就照樣算：寧可多算一次，也不因為鎖卡住寄不出信
    let mut all = load(home, now);
    let recent = recent_of(&all, window);
    if recent.len() >= limit {
        return Err((recent[0] + HOUR - now).div_ceil(60_000));
    }
    let mut next = recent;
    next.push(now);
    let left = limit.saturating_sub(next.len());
    all.insert(window.to_string(), json!(next));
    let _ = std::fs::create_dir_all(home);
    // 純狀態（掉了可重建）：不 fsync；錯誤照舊吞掉
    let _ = crate::settings::atomic::write(&home.join(FILE), serde_json::to_string(&all).unwrap_or_default().as_bytes(), crate::settings::atomic::STATE);
    Ok(left)
}

/// 本人簽章的私信寄到 `window`：退回一封額度（刪掉最舊的一筆）。
/// 一封信只退一次（`mail_id`）；窗口這一小時沒有任何紀錄就沒有東西可退——額度只會回到上限，不會存成「欠額」。
/// 拿不到鎖就不退（少退一封比寫壞計數檔好）。回傳這次有沒有真的退。
pub fn refund(home: &Path, window: &str, mail_id: &str, now: u64) -> bool {
    let Some(_lock) = lock(home, LOCK_WAIT_REFUND) else { return false };
    let ids_file = home.join(REFUNDED);
    let mut ids: Vec<String> = std::fs::read_to_string(&ids_file).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default();
    if ids.iter().any(|i| i == mail_id) {
        return false;
    }
    ids.push(mail_id.to_string());
    if ids.len() > KEEP_IDS {
        ids.drain(..ids.len() - KEEP_IDS);
    }
    let _ = crate::settings::atomic::write(&ids_file, serde_json::to_string(&ids).unwrap_or_default().as_bytes(), crate::settings::atomic::STATE);
    let mut all = load(home, now);
    let mut recent = recent_of(&all, window);
    if recent.is_empty() {
        return false;
    }
    recent.remove(0);
    if recent.is_empty() {
        all.remove(window);
    } else {
        all.insert(window.to_string(), json!(recent));
    }
    let _ = crate::settings::atomic::write(&home.join(FILE), serde_json::to_string(&all).unwrap_or_default().as_bytes(), crate::settings::atomic::STATE);
    true
}

/// 寄完後的提醒（剩很少才有字）
pub fn warn_text(window: &str, left: usize, limit: usize) -> Option<String> {
    (left <= WARN_LEFT.min(limit)).then(|| format!("提醒：視窗「{window}」這一小時還能寄 {left} 封（上限 {limit} 封），用完要等一下才能再寄；本人直接傳訊息給它會退回額度"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn home() -> tempfile::TempDir {
        tempfile::tempdir().unwrap()
    }
    fn count(h: &Path, w: &str, now: u64) -> usize {
        recent_of(&load(h, now), w).len()
    }

    #[test]
    fn 計次到上限才擋_剩餘數照實回報() {
        let d = home();
        assert_eq!(take(d.path(), "甲", 3, 1000), Ok(2));
        assert_eq!(take(d.path(), "甲", 3, 2000), Ok(1));
        assert_eq!(take(d.path(), "甲", 3, 3000), Ok(0));
        assert!(take(d.path(), "甲", 3, 4000).is_err());
        assert_eq!(take(d.path(), "乙", 3, 4000), Ok(2), "別的視窗各算各的");
    }

    #[test]
    fn 退回一封_刪掉最舊的一筆_一封信只退一次() {
        let d = home();
        for t in [1000, 2000, 3000] {
            take(d.path(), "甲", 3, t).unwrap();
        }
        assert!(take(d.path(), "甲", 3, 4000).is_err());
        assert!(refund(d.path(), "甲", "mail-1", 5000));
        assert_eq!(count(d.path(), "甲", 5000), 2);
        assert!(!refund(d.path(), "甲", "mail-1", 5000), "同一封信不會再退");
        assert_eq!(count(d.path(), "甲", 5000), 2);
        assert_eq!(take(d.path(), "甲", 3, 6000), Ok(0), "退回的那一封又能寄");
    }

    #[test]
    fn 沒有紀錄就沒有東西可退_額度不超過上限也不存欠額() {
        let d = home();
        assert!(!refund(d.path(), "甲", "m1", 1000));
        assert!(!refund(d.path(), "甲", "m2", 1000));
        assert_eq!(take(d.path(), "甲", 3, 2000), Ok(2), "之前退過兩次也不會多出額度");
        assert_eq!(take(d.path(), "甲", 3, 3000), Ok(1));
        assert_eq!(take(d.path(), "甲", 3, 4000), Ok(0));
        assert!(take(d.path(), "甲", 3, 5000).is_err());
    }

    #[test]
    fn 只退自己那個視窗_一小時前的紀錄不算() {
        let d = home();
        take(d.path(), "甲", 3, 1000).unwrap();
        take(d.path(), "乙", 3, 1000).unwrap();
        assert!(refund(d.path(), "甲", "m1", 2000));
        assert_eq!(count(d.path(), "甲", 2000), 0);
        assert_eq!(count(d.path(), "乙", 2000), 1);
        take(d.path(), "丙", 3, 1000).unwrap();
        assert!(!refund(d.path(), "丙", "m2", 1000 + HOUR + 1), "過了一小時已經不在計數裡");
    }

    #[test]
    fn 兩邊同時寫不會寫壞_鎖留下的舊檔會被清掉() {
        let d = home();
        let h = d.path().to_path_buf();
        let hs: Vec<_> = (0..8)
            .map(|i| {
                let h = h.clone();
                std::thread::spawn(move || {
                    for j in 0..5u64 {
                        take(&h, "甲", 1000, 1000 + i * 10 + j).unwrap();
                    }
                })
            })
            .collect();
        for t in hs {
            t.join().unwrap();
        }
        assert_eq!(count(&h, "甲", 2000), 40, "每次都讀到上一次的結果，沒有互相蓋掉");
        std::fs::write(h.join(LOCK), "").unwrap();
        let old = std::time::SystemTime::now() - std::time::Duration::from_secs(60);
        std::fs::File::options().write(true).open(h.join(LOCK)).unwrap().set_modified(old).unwrap();
        assert_eq!(take(&h, "乙", 3, 3000), Ok(2), "超過 10 秒的鎖檔當作遺留，不卡住");
    }

    #[test]
    fn 鎖被占著超過舊的兩秒等待上限_寄信照樣等到放掉才算_不無鎖照寫() {
        let d = home();
        let h = d.path().to_path_buf();
        let held = lock(&h, std::time::Duration::from_secs(1)).expect("先拿到鎖");
        let h2 = h.clone();
        let t0 = std::time::Instant::now();
        let waiter = std::thread::spawn(move || {
            let r = take(&h2, "甲", 5, 1000);
            (r, t0.elapsed())
        });
        std::thread::sleep(std::time::Duration::from_millis(2500)); // 舊程式 50 次 × 40 毫秒＝約 2 秒就放棄、無鎖照寫
        assert_eq!(count(&h, "甲", 1000), 0, "鎖還被占著，等鎖的人不能先寫");
        drop(held);
        let (r, waited) = waiter.join().unwrap();
        assert_eq!(r, Ok(4));
        assert!(waited >= std::time::Duration::from_millis(2400), "要等到鎖放掉：{waited:?}");
        assert_eq!(count(&h, "甲", 1000), 1);
    }

    fn make_old_lock(p: &Path, content: &str) {
        std::fs::write(p, content).unwrap();
        let old = std::time::SystemTime::now() - std::time::Duration::from_secs(60);
        std::fs::File::options().write(true).open(p).unwrap().set_modified(old).unwrap();
    }

    #[test]
    fn 清遺留鎖時別人剛換上新鎖_新鎖不會被刪_也不會兩人同時持鎖() {
        // #2294：A 判斷舊鎖遺留 → （B 刪掉舊鎖、建好新鎖）→ A 才 rename。舊程式這裡直接 remove，刪到 B 的新鎖
        let d = home();
        let p = d.path().join(LOCK);
        make_old_lock(&p, "old-holder");
        let mut b: Option<Lock> = None;
        reap_stale(&p, || {
            std::fs::remove_file(&p).unwrap();
            b = Some(create_lock(&p).unwrap());
        });
        let b = b.unwrap();
        assert_eq!(std::fs::read_to_string(&p).unwrap(), b.1, "B 的新鎖還在原位、內容沒變");
        assert!(lock(d.path(), std::time::Duration::from_millis(50)).is_none(), "B 還持鎖，別人拿不到");
        assert!(std::fs::read_dir(d.path()).unwrap().all(|e| !e.unwrap().file_name().to_string_lossy().contains(".reap-")), "暫存檔不留");
        drop(b);
        assert!(!p.exists(), "B 放鎖後才消失");
    }

    #[test]
    fn 舊鎖是空檔_別人換上剛建好還沒寫內容的新鎖_也不能刪() {
        let d = home();
        let p = d.path().join(LOCK);
        make_old_lock(&p, "");
        reap_stale(&p, || {
            std::fs::remove_file(&p).unwrap();
            std::fs::OpenOptions::new().write(true).create_new(true).open(&p).unwrap(); // 剛建、內容還是空的
        });
        assert!(p.exists(), "內容同為空，但修改時間是新的，不是遺留");
    }

    #[test]
    fn 真的遺留的鎖照樣被清掉() {
        let d = home();
        let p = d.path().join(LOCK);
        make_old_lock(&p, "dead-holder");
        reap_stale(&p, || {});
        assert!(!p.exists());
    }

    #[test]
    fn 放鎖只刪自己的內容() {
        let d = home();
        let p = d.path().join(LOCK);
        let a = create_lock(&p).unwrap();
        std::fs::write(&p, "someone-else").unwrap(); // 鎖被別人換掉
        drop(a);
        assert!(p.exists(), "不是自己的鎖就不刪");
    }

    #[test]
    fn 提醒只在快用完時才出現() {
        assert!(warn_text("甲", 6, 30).is_none());
        assert!(warn_text("甲", 5, 30).unwrap().contains("還能寄 5 封"));
        assert!(!warn_text("甲", 5, 30).unwrap().contains("擁有者"), "給所有使用者看的字不寫特定人名");
        assert!(warn_text("甲", 0, 30).is_some());
        assert!(warn_text("甲", 2, 2).is_some(), "上限本來就很小時一開始就提醒");
    }
}

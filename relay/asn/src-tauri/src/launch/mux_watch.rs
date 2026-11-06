//! 共用終端服務（mux）掛掉要有人知道（#596 第 4 項，0.2.4）。
//! mux 掛了，底下所有夥伴的窗格一起結束；以前沒有偵測、沒有通知、沒有接回，只有下操作時 `verify_mux` 才發現。
//! 這裡每 30 秒看一次：mux 還活著時記下「mux 的（程序編號，建立時間）和裡面的夥伴名字」，下一輪發現
//! mux 不見了（或換成別的 mux）而且不是我們自己收的，就算一次事故：
//! - 寫進 mux.log；
//! - 把這些夥伴交給 #788 的自動接回（`auto_resume::after_mux_crash`），畫面跳「已自動接回…／沒有接回…」，原因寫「終端服務中斷了」；
//! - **一次事故接一次**；十分鐘內又掛，只通知（把名字與原因列出來），不再接，不能循環。
//! 不算掛掉：ASN 自己停／收空的 mux（留記號）、使用者關單一窗格（mux 還活著）、重開機（交給 #788）。
//! 只掉一輪的偵測不算（連續兩輪都看不到才算，查程序偶爾會暫時失敗）。ASN 關著期間掛掉的，下次啟動時對照狀態檔補報。
#![cfg(desktop)]

use serde::{Deserialize, Serialize};
use std::path::Path;

/// 多久看一次
pub const TICK_MS: u64 = 30_000;
/// 一次事故接回之後，這段時間內又掛就只通知
pub const RESUME_GAP_MS: u64 = 600_000;
/// 狀態檔（機器資料夾）：最後看到的 mux 與夥伴、上次接回的時間、當時的開機時間
pub const STATE_FILE: &str = "mux-resume.json";
/// 畫面與紀錄用的原因（一個字都不要改，測試比對）
/// 事故後「還沒接回來」的夥伴，寄給它們的信先留著的最久時間（和重開機後等接回一樣 12 小時）
pub const LOST_KEEP_MS: u64 = 12 * 3_600_000;
/// 狀態檔超過這麼久沒更新，就當監看沒在跑，不拿「還看得到的夥伴」當依據
pub const STATE_FRESH_MS: u64 = 120_000;
pub const CAUSE: &str = "共用的終端服務中斷了";
/// 十分鐘內又中斷時，每位夥伴的失敗原因
pub const COOLDOWN_REASON: &str = "終端服務十分鐘內又中斷了，這次沒有自動接回，請手動喚醒";

/// 這一輪看到的 mux 現況
#[derive(Debug, Clone, PartialEq, Default)]
pub struct Observed {
    /// mux 活著：（程序編號, 建立時間）；沒有 mux 或不活就是 None
    pub live: Option<(u32, u64)>,
    /// 共用 mux 裡的夥伴名字
    pub partners: Vec<String>,
    /// ASN 上一次自己停 mux 的記號：（程序編號, 毫秒）
    pub stopped: Option<(u32, u64)>,
}

/// 一次事故
#[derive(Debug, Clone, PartialEq)]
pub struct Incident {
    pub partners: Vec<String>,
    /// 這次要不要自動接回（十分鐘內第二次是 false）
    pub resume: bool,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
struct Seen {
    mux: (u32, u64),
    partners: Vec<String>,
    /// 記下的時間：ASN 的停止記號晚於這個才算「我們收的」
    at: u64,
}

#[derive(Debug, Default, Serialize, Deserialize)]
pub struct Watch {
    seen: Option<Seen>,
    pub last_resume_at: Option<u64>,
    /// 存檔時的開機時間：開機時間變了＝重開機，夥伴不見了是 #788 的事，不重複接
    #[serde(default)]
    boot: Option<u64>,
    /// 事故後還沒接回來的夥伴名字：寄給它們的信先留著、不退回（橋接核心讀這份）。回來了或過 12 小時就拿掉
    #[serde(default)]
    lost: Vec<String>,
    #[serde(default)]
    lost_at: u64,
    /// 上一輪就看不到 mux（還沒下結論）
    #[serde(skip)]
    suspect: bool,
}

impl Watch {
    /// 讀狀態檔；沒有或看不懂就是空的。`boot_now` 和存檔的開機時間不同（重開機）就丟掉記著的 mux，交給 #788
    pub fn load(file: &Path, boot_now: Option<u64>) -> Watch {
        let mut w: Watch = std::fs::read_to_string(file).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default();
        if let (Some(a), Some(b)) = (w.boot, boot_now) {
            if !crate::bridge::known::same_boot(a, b) {
                w.seen = None;
                w.lost.clear();
            }
        }
        w.boot = boot_now;
        w
    }

    pub fn save(&self, file: &Path) {
        if let Ok(t) = serde_json::to_string(self) {
            let _ = crate::write_atomic(file, &t);
        }
    }

    /// 看一輪。有事故就回（同一次事故只回一次）
    pub fn tick(&mut self, o: &Observed, now: u64) -> Option<Incident> {
        // 已經回來的（又出現在 mux 裡）、或等太久的，不再算還沒接回
        self.lost.retain(|n| !o.partners.iter().any(|p| p == n));
        if self.lost_at > 0 && now.saturating_sub(self.lost_at) > LOST_KEEP_MS {
            self.lost.clear();
        }
        let prev = self.seen.clone();
        // 這一輪看到的：mux 活著而且裡面有夥伴才值得記（沒有夥伴，不見了也沒有誰要通知）
        let current = o.live.filter(|_| !o.partners.is_empty()).map(|mux| Seen { mux, partners: o.partners.clone(), at: now });
        let Some(p) = prev else {
            self.suspect = false;
            self.seen = current;
            return None;
        };
        let replaced = o.live.is_some_and(|m| m != p.mux);
        let missing = o.live.is_none();
        if !replaced && !missing {
            // 還是同一個 mux：更新夥伴名單（可能有人加入、有人自己關了）
            self.suspect = false;
            self.seen = match current {
                Some(c) => Some(Seen { at: p.at, ..c }),
                None => None,
            };
            return None;
        }
        // 消失了：換成別的 mux（確定舊的沒了）馬上算；只是暫時看不到 mux，要連續兩輪
        if missing && !self.suspect {
            self.suspect = true;
            return None;
        }
        self.suspect = false;
        self.seen = current;
        // 我們自己收的（記號是這個 mux、晚於記下的時間）：不算掛掉
        if o.stopped.is_some_and(|(pid, at)| pid == p.mux.0 && at.saturating_add(5_000) >= p.at) {
            return None;
        }
        let resume = self.last_resume_at.is_none_or(|t| now.saturating_sub(t) >= RESUME_GAP_MS);
        if resume {
            self.last_resume_at = Some(now);
        }
        for n in &p.partners {
            if !self.lost.contains(n) {
                self.lost.push(n.clone());
            }
        }
        self.lost_at = now;
        Some(Incident { partners: p.partners, resume })
    }
}

/// 橋接核心要知道的名字：這些夥伴現在名單上沒有，但很可能只是共用的終端服務掛了、正在（或等著）接回，
/// 寄給它們的信先留著、不退回，也先別當成本人關掉而忘掉。
/// 包含：①事故後還沒接回來的（最久 12 小時）；②監看最近一輪還看到、現在可能剛掛的（狀態檔很新才算；
/// 本人剛關掉的下一輪監看就會拿掉，最多多留一輪）
pub fn pending_names(file: &Path, now_ms: u64) -> Vec<String> {
    let (lost, recent) = pending_split(file, now_ms);
    let mut names: Vec<String> = lost.into_iter().chain(recent).collect();
    names.sort();
    names.dedup();
    names
}

/// 同上，分成兩份：（確定中斷、還沒接回的, 最近還看得到、可能剛掛的）。
/// 只有前者可以跟寄件人說「服務中斷」：後者也可能是夥伴自己結束了，下一輪監看就會知道
pub fn pending_split(file: &Path, now_ms: u64) -> (Vec<String>, Vec<String>) {
    let Some(w) = std::fs::read_to_string(file).ok().and_then(|t| serde_json::from_str::<Watch>(&t).ok()) else { return (Vec::new(), Vec::new()) };
    let lost: Vec<String> = if w.lost_at > 0 && now_ms.saturating_sub(w.lost_at) <= LOST_KEEP_MS { w.lost.clone() } else { Vec::new() };
    let mut names: Vec<String> = Vec::new();
    let fresh = std::fs::metadata(file).and_then(|m| m.modified()).ok().and_then(|t| t.elapsed().ok()).is_some_and(|e| e.as_millis() as u64 <= STATE_FRESH_MS);
    if fresh {
        if let Some(s) = &w.seen {
            names.extend(s.partners.iter().filter(|n| !lost.contains(n)).cloned());
        }
    }
    names.sort();
    names.dedup();
    (lost, names)
}

/// 要請後台通知本人的事故檔：偵測到中斷就寫，橋接核心下一輪讀走、呼叫後台成功（或確定不用再試）就刪
pub const NOTICE_FILE: &str = "mux-notice.json";
/// 後台一次最多收幾位（超過會被擋，所以自己夾住）
pub const NOTICE_MAX_COUNT: usize = 100;

/// 排一則通知：只存人數與有沒有接回，不存夥伴名字（後台文字固定）
pub fn queue_notice(work_dir: &Path, count: usize, resumed: bool, now_ms: u64) {
    if work_dir.as_os_str().is_empty() {
        return;
    }
    let body = serde_json::json!({ "count": count.clamp(1, NOTICE_MAX_COUNT), "resumed": resumed, "at": now_ms });
    let tmp = work_dir.join(format!("{NOTICE_FILE}.tmp"));
    if std::fs::write(&tmp, body.to_string()).is_ok() {
        let _ = std::fs::rename(&tmp, work_dir.join(NOTICE_FILE));
    }
}

/// 讀排著的通知：（人數, 有沒有接回, 事故時間）；沒有或壞掉的檔回 None（壞檔順手刪掉）
pub fn read_notice(work_dir: &Path) -> Option<(usize, bool, u64)> {
    let f = work_dir.join(NOTICE_FILE);
    let text = std::fs::read_to_string(&f).ok()?;
    let v: serde_json::Value = match serde_json::from_str(&text) {
        Ok(v) => v,
        Err(_) => {
            let _ = std::fs::remove_file(&f);
            return None;
        }
    };
    let count = v.get("count").and_then(serde_json::Value::as_u64)? as usize;
    let resumed = v.get("resumed").and_then(serde_json::Value::as_bool)?;
    Some((count.clamp(1, NOTICE_MAX_COUNT), resumed, v.get("at").and_then(serde_json::Value::as_u64).unwrap_or(0)))
}

pub fn clear_notice(work_dir: &Path) {
    let _ = std::fs::remove_file(work_dir.join(NOTICE_FILE));
}

/// 使用者自己結束 ASN（比照 #788「自己關的不接」）：忘掉記著的 mux，之後 ASN 不在時 mux 才掛掉，下次啟動不補報、不接回
static QUITTING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

pub fn note_user_quit(work_dir: &Path) {
    QUITTING.store(true, std::sync::atomic::Ordering::SeqCst);
    if let Some(f) = state_file(work_dir) {
        let _ = std::fs::remove_file(f);
    }
}

/// 狀態檔的路徑。還沒有節點金鑰時工作資料夾是空路徑：不能組成目前目錄的同名檔去讀寫、刪除（#859）
fn state_file(work_dir: &Path) -> Option<std::path::PathBuf> {
    (!work_dir.as_os_str().is_empty()).then(|| work_dir.join(STATE_FILE))
}

/// 把工作丟到另一條執行緒，馬上回來（接回要等登入、等記憶體，最久 12 小時；監看不能跟著停住，
/// 不然這段時間第二次中斷沒人知道）。同時只有一條在接回由 `auto_resume` 的鎖保證
pub fn dispatch<F: FnOnce() + Send + 'static>(name: &str, f: F) -> bool {
    std::thread::Builder::new().name(name.into()).spawn(f).is_ok()
}

/// 背景執行緒：ASN 啟動後一直跑。沒開 mux 模式時 `mux_snapshot` 回 None，什麼都不做
#[cfg(feature = "gui")]
pub fn start(terms: std::sync::Arc<super::term::LiveTerms>, work_dir: &Path, data_dir: &Path) {
    // 沒有工作資料夾（還沒有節點金鑰）：沒有地方記，也沒有收發室能通知，不監看（#859）
    if std::env::args().any(|a| a == "--shot") || state_file(work_dir).is_none() {
        return;
    }
    let (work_dir, data_dir) = (work_dir.to_path_buf(), data_dir.to_path_buf());
    let spawned = std::thread::Builder::new().name("asn-mux-watch".into()).spawn(move || {
        let file = work_dir.join(STATE_FILE);
        let mut w = Watch::load(&file, super::auto_resume::boot_ms(crate::heartbeat::now_ms()));
        loop {
            std::thread::sleep(std::time::Duration::from_millis(TICK_MS));
            if QUITTING.load(std::sync::atomic::Ordering::SeqCst) {
                return;
            }
            let Some(o) = terms.mux_snapshot() else { continue };
            let now = crate::heartbeat::now_ms();
            let incident = w.tick(&o, now);
            w.save(&file);
            if let Some(inc) = incident {
                let line = format!("終端服務中斷：{} 位夥伴（{}）{}", inc.partners.len(), inc.partners.join("、"), if inc.resume { "，自動接回" } else { "，十分鐘內又中斷，只通知不接回" });
                elog!("{line}");
                if let Some(base) = std::env::var_os("LOCALAPPDATA") {
                    super::mux::note(&std::path::PathBuf::from(base).join("ASN").join("m"), &line);
                }
                queue_notice(&work_dir, inc.partners.len(), inc.resume, now);
                let (wd, dd, partners, resume) = (work_dir.clone(), data_dir.clone(), inc.partners, inc.resume);
                if !dispatch("asn-mux-resume", move || super::auto_resume::after_mux_crash(&wd, &dd, &partners, resume)) {
                    elog!("接回夥伴的背景工作開不了（不影響監看）");
                }
            }
        }
    });
    if let Err(e) = spawned {
        elog!("終端服務監看的背景工作開不了（不影響啟動）：{e}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 沒有工作資料夾_不碰目前目錄() {
        assert_eq!(state_file(Path::new("")), None, "不能組成目前目錄的路徑");
        assert_eq!(state_file(Path::new("a")), Some(Path::new("a").join(STATE_FILE)));
        let notice = std::env::current_dir().unwrap().join(NOTICE_FILE);
        let before = notice.exists();
        queue_notice(Path::new(""), 1, true, 0);
        assert_eq!(notice.exists(), before, "通知檔不能寫到目前目錄");
        let src = include_str!("mux_watch.rs").replace("\r\n", "\n");
        let start = src.find("pub fn start(terms").unwrap();
        let (guard, spawn) = (src[start..].find("state_file(work_dir).is_none()").unwrap(), src[start..].find("spawn(move").unwrap());
        assert!(guard < spawn, "要在開監看之前擋下");
    }

    const M1: (u32, u64) = (100, 1_000);
    const M2: (u32, u64) = (200, 2_000);

    fn obs(live: Option<(u32, u64)>, names: &[&str]) -> Observed {
        Observed { live, partners: names.iter().map(|s| s.to_string()).collect(), stopped: None }
    }

    #[test]
    fn mux_不見了_連續兩輪才算_同一次事故只回一次() {
        let mut w = Watch::default();
        assert_eq!(w.tick(&obs(Some(M1), &["甲", "乙"]), 0), None);
        assert_eq!(w.tick(&obs(Some(M1), &["甲", "乙"]), TICK_MS), None);
        assert_eq!(w.tick(&obs(None, &[]), 2 * TICK_MS), None, "第一輪看不到只是懷疑（查程序偶爾會暫時失敗）");
        let inc = w.tick(&obs(None, &[]), 3 * TICK_MS).expect("第二輪還看不到才算");
        assert_eq!((inc.partners.as_slice(), inc.resume), (&["甲".to_string(), "乙".to_string()][..], true));
        assert_eq!(w.tick(&obs(None, &[]), 4 * TICK_MS), None, "同一個 mux 只算一次");
        assert_eq!(w.tick(&obs(None, &[]), 5 * TICK_MS), None);
    }

    #[test]
    fn 暫時看不到又回來_不算掛掉() {
        let mut w = Watch::default();
        w.tick(&obs(Some(M1), &["甲"]), 0);
        assert_eq!(w.tick(&obs(None, &[]), TICK_MS), None);
        assert_eq!(w.tick(&obs(Some(M1), &["甲"]), 2 * TICK_MS), None);
        assert_eq!(w.tick(&obs(None, &[]), 3 * TICK_MS), None, "又懷疑一次，懷疑的次數重新算");
        assert_eq!(w.tick(&obs(Some(M1), &["甲"]), 4 * TICK_MS), None);
    }

    #[test]
    fn 換成別的_mux_馬上算_舊的夥伴名單照記著的報() {
        let mut w = Watch::default();
        w.tick(&obs(Some(M1), &["甲", "乙"]), 0);
        // 舊 mux 沒了、被下一次 ensure 起了新的；對照表那幾列已被移除
        let inc = w.tick(&obs(Some(M2), &[]), TICK_MS).expect("換了 mux 就是舊的沒了");
        assert_eq!(inc.partners, ["甲", "乙"]);
    }

    #[test]
    fn 我們自己收的不算掛掉_記號是這個_mux_而且晚於記下的時間() {
        let mut w = Watch::default();
        w.tick(&obs(Some(M1), &["甲"]), 10_000);
        let mut gone = obs(None, &[]);
        gone.stopped = Some((M1.0, 20_000));
        assert_eq!(w.tick(&gone, 40_000), None);
        assert_eq!(w.tick(&gone, 70_000), None, "留記號的收法不算事故");
        // 記號是別的 mux 的、或比記下的時間早很多（上一個 mux 的記號）：不能拿來放過這一次
        let mut w2 = Watch::default();
        w2.tick(&obs(Some(M1), &["甲"]), 100_000);
        let mut other = obs(None, &[]);
        other.stopped = Some((999, 120_000));
        w2.tick(&other, 130_000);
        assert!(w2.tick(&other, 160_000).is_some(), "別的 mux 的記號不算");
        let mut w3 = Watch::default();
        w3.tick(&obs(Some(M1), &["甲"]), 100_000);
        let mut old = obs(None, &[]);
        old.stopped = Some((M1.0, 10_000));
        w3.tick(&old, 130_000);
        assert!(w3.tick(&old, 160_000).is_some(), "記號早於記下的時間，是更早收掉的上一個 mux");
    }

    #[test]
    fn 沒有夥伴或夥伴自己關光_mux_不見了也不報() {
        let mut w = Watch::default();
        assert_eq!(w.tick(&obs(Some(M1), &[]), 0), None, "mux 活著但沒夥伴，不記");
        assert_eq!(w.tick(&obs(None, &[]), TICK_MS), None);
        assert_eq!(w.tick(&obs(None, &[]), 2 * TICK_MS), None);
        // 夥伴都自己關了，mux 之後被收掉：看到的最後一輪沒有夥伴
        let mut w2 = Watch::default();
        w2.tick(&obs(Some(M1), &["甲"]), 0);
        w2.tick(&obs(Some(M1), &[]), TICK_MS);
        assert_eq!(w2.tick(&obs(None, &[]), 2 * TICK_MS), None);
        assert_eq!(w2.tick(&obs(None, &[]), 3 * TICK_MS), None);
    }

    #[test]
    fn 十分鐘內又掛_只通知不接回_隔夠久又可以接() {
        let mut w = Watch::default();
        w.tick(&obs(Some(M1), &["甲"]), 0);
        w.tick(&obs(None, &[]), TICK_MS);
        let first = w.tick(&obs(None, &[]), 2 * TICK_MS).unwrap();
        assert!(first.resume);
        // 接回後新的 mux 起來又掛（不到十分鐘）
        let t = 3 * TICK_MS;
        w.tick(&obs(Some(M2), &["甲"]), t);
        w.tick(&obs(None, &[]), t + TICK_MS);
        let second = w.tick(&obs(None, &[]), t + 2 * TICK_MS).unwrap();
        assert!(!second.resume, "十分鐘內第二次只通知");
        // 又過了十分鐘以上
        let t2 = t + 2 * TICK_MS + RESUME_GAP_MS + 1;
        let m3 = (300, 3_000);
        w.tick(&obs(Some(m3), &["甲"]), t2);
        w.tick(&obs(None, &[]), t2 + TICK_MS);
        let third = w.tick(&obs(None, &[]), t2 + 2 * TICK_MS).unwrap();
        assert!(third.resume, "隔夠久再掛又可以接回一次");
        // 只通知的那一次不更新接回時間：不會因為連續掛而一直延後
        assert_eq!(w.last_resume_at, Some(t2 + 2 * TICK_MS));
    }

    #[test]
    fn 狀態檔_ASN_關著期間掛掉_下次啟動補報_重開機不重複接() {
        let d = tempfile::tempdir().unwrap();
        let f = d.path().join(STATE_FILE);
        let mut w = Watch::load(&f, Some(5_000_000));
        w.tick(&obs(Some(M1), &["甲", "乙"]), 1_000);
        w.save(&f);
        // ASN 關掉、mux 掛了、ASN 又開（開機時間沒變）：第一輪對照狀態檔發現 mux 不見
        let mut again = Watch::load(&f, Some(5_000_100));
        assert_eq!(again.tick(&obs(None, &[]), 900_000), None, "先懷疑一輪");
        let inc = again.tick(&obs(None, &[]), 930_000).expect("補報");
        assert_eq!(inc.partners, ["甲", "乙"]);
        // 開機時間變了（重開機）：夥伴是跟著電腦一起沒的，#788 會接，這裡丟掉記著的
        let mut rebooted = Watch::load(&f, Some(9_999_999));
        assert_eq!(rebooted.tick(&obs(None, &[]), 900_000), None);
        assert_eq!(rebooted.tick(&obs(None, &[]), 930_000), None, "重開機交給 #788，不重複接");
        // 壞檔當空的
        std::fs::write(&f, "壞掉").unwrap();
        assert_eq!(Watch::load(&f, None).tick(&obs(None, &[]), 0), None);
    }

    #[test]
    fn 通知檔_寫了讀得到_人數夾在一到一百_刪了就沒有() {
        let d = tempfile::tempdir().unwrap();
        assert_eq!(read_notice(d.path()), None);
        queue_notice(d.path(), 250, false, 42);
        assert_eq!(read_notice(d.path()), Some((100, false, 42)));
        queue_notice(d.path(), 0, true, 43);
        assert_eq!(read_notice(d.path()), Some((1, true, 43)));
        clear_notice(d.path());
        assert_eq!(read_notice(d.path()), None);
        std::fs::write(d.path().join(NOTICE_FILE), "壞掉").unwrap();
        assert_eq!(read_notice(d.path()), None);
        assert!(!d.path().join(NOTICE_FILE).exists(), "壞檔要刪掉，不然每輪都讀");
    }

    #[test]
    fn 接回丟到另一條執行緒_呼叫馬上回來_監看不會被等登入卡住() {
        let (release_tx, release_rx) = std::sync::mpsc::channel::<()>();
        let (done_tx, done_rx) = std::sync::mpsc::channel::<&'static str>();
        let t = std::time::Instant::now();
        assert!(dispatch("asn-mux-resume-test", move || {
            release_rx.recv().unwrap(); // 模擬卡在等登入
            done_tx.send("done").unwrap();
        }));
        assert!(t.elapsed() < std::time::Duration::from_secs(2), "dispatch 不能等工作做完");
        assert!(done_rx.try_recv().is_err(), "工作還在等，沒有完成");
        release_tx.send(()).unwrap();
        assert_eq!(done_rx.recv_timeout(std::time::Duration::from_secs(5)), Ok("done"));
    }

    #[test]
    fn 使用者自己結束_忘掉記著的_mux_之後不補報() {
        let d = tempfile::tempdir().unwrap();
        let f = d.path().join(STATE_FILE);
        let mut w = Watch::default();
        w.tick(&obs(Some(M1), &["甲"]), 0);
        w.save(&f);
        assert!(f.exists());
        note_user_quit(d.path());
        assert!(!f.exists());
        // 下次啟動：沒有記著的 mux，mux 不在也不算事故
        let mut w2 = Watch::load(&f, None);
        assert_eq!(w2.tick(&obs(None, &[]), TICK_MS), None);
        assert_eq!(w2.tick(&obs(None, &[]), 2 * TICK_MS), None);
    }

    #[test]
    fn 事故後還沒接回來的夥伴記著_回來了或過十二小時就拿掉() {
        let mut w = Watch::default();
        w.tick(&obs(Some(M1), &["甲", "乙"]), 1_000);
        // 換成新 mux、夥伴都不在
        let inc = w.tick(&obs(Some(M2), &[]), 1_000 + TICK_MS).expect("事故");
        assert_eq!(inc.partners, ["甲", "乙"]);
        assert_eq!(w.lost, ["甲", "乙"]);
        // 甲接回來了
        w.tick(&obs(Some(M2), &["甲"]), 1_000 + 2 * TICK_MS);
        assert_eq!(w.lost, ["乙"]);
        // 乙一直沒回來，過 12 小時就不留了
        w.tick(&obs(Some(M2), &["甲"]), 1_000 + TICK_MS + LOST_KEEP_MS + 1);
        assert!(w.lost.is_empty());
    }

    #[test]
    fn 重開機後不留還沒接回來的_交給_788() {
        let d = tempfile::tempdir().unwrap();
        let f = d.path().join(STATE_FILE);
        let mut w = Watch::load(&f, Some(1_000_000));
        w.tick(&obs(Some(M1), &["甲"]), 1_000);
        w.tick(&obs(Some(M2), &[]), 1_000 + TICK_MS);
        w.save(&f);
        assert_eq!(Watch::load(&f, Some(1_000_000)).lost, ["甲"]);
        assert!(Watch::load(&f, Some(1_000_000 + 10 * 3_600_000)).lost.is_empty());
    }

    #[test]
    fn 橋接核心讀的名單_事故後的加上最近還看得到的_狀態檔太舊就只看事故後的() {
        let d = tempfile::tempdir().unwrap();
        let f = d.path().join(STATE_FILE);
        assert!(pending_names(&f, 5_000).is_empty());
        let mut w = Watch::default();
        w.tick(&obs(Some(M1), &["甲", "乙"]), 1_000);
        w.save(&f);
        assert_eq!(pending_names(&f, 2_000), ["乙", "甲"], "最近還看得到的（可能剛掛）");
        assert!(pending_split(&f, 2_000).0.is_empty(), "還沒確定中斷");
        w.tick(&obs(Some(M2), &[]), 1_000 + TICK_MS);
        w.save(&f);
        assert_eq!(pending_names(&f, 1_000 + TICK_MS), ["乙", "甲"], "事故後還沒接回來的");
        let (lost, recent) = pending_split(&f, 1_000 + TICK_MS);
        assert_eq!((lost.len(), recent.len()), (2, 0), "事故後的才算確定中斷");
        assert!(pending_names(&f, 1_000 + TICK_MS + LOST_KEEP_MS + 1).is_empty(), "過 12 小時不留");
        // 狀態檔很久沒更新：監看沒在跑，不拿「還看得到的夥伴」當依據
        let mut w2 = Watch::default();
        w2.tick(&obs(Some(M1), &["丙"]), 1_000);
        w2.save(&f);
        let old = std::time::SystemTime::now() - std::time::Duration::from_secs(600);
        std::fs::File::options().write(true).open(&f).unwrap().set_modified(old).unwrap();
        assert!(pending_names(&f, 2_000).is_empty());
    }
}

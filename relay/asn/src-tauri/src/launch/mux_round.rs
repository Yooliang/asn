//! 終端服務監看的「一輪」與「接回結果通知」（#1818）。
//! 從 `mux_watch::start` 的迴圈抽出來：一輪做的事（寫狀態檔、算事故、寫紀錄、排通知、交給接回）集中在 [`run_round`]，
//! 對外的動作（開程序控制代碼、查事件記錄、寫紀錄、接回）經 [`Sink`]，測試換成假的，才能從「服務被砍」一路驗到「夥伴全部接回、通知排出」。
//! 另外放接回做完後的結果通知檔。
#![cfg(desktop)]

use super::mux_watch::{empty_normal_exit, incident_line, queue_notice, Incident, Observed, ProcHandle, Tracker, Watch};
use std::path::Path;

/// 一輪的對外動作
pub trait Sink {
    /// 開程序控制代碼（讀結束碼用）
    fn open(&self, pid: u32) -> Option<Box<dyn ProcHandle>>;
    /// 事件記錄那一段的白話；沒有就 None
    fn event_text(&self, pid: Option<u32>) -> Option<String>;
    /// 寫一行事故紀錄（程式紀錄與 mux.log）
    fn record(&self, line: &str);
    /// 把夥伴交給自動接回（`resume` 為假＝十分鐘內第二次，只通知）。正式環境丟到另一條執行緒
    fn resume(&self, partners: Vec<String>, resume: bool);
}

/// 一輪要用的路徑與時間
pub struct Round<'a> {
    pub state_file: &'a Path,
    pub work_dir: &'a Path,
    /// 這台 ASN 已經跑了幾秒（事故紀錄用）
    pub uptime_secs: u64,
}

/// 看一輪：記下確定結束的夥伴、算事故、存狀態檔；有事故就寫紀錄、排通知、交給接回。
/// 回這一輪處理的事故（正常結束的空服務略過，回 None）
pub fn run_round(w: &mut Watch, tracker: &mut Tracker, o: &Observed, exited: &[String], now: u64, ctx: &Round, sink: &dyn Sink) -> Option<Incident> {
    w.note_exited(exited, now);
    let incident = w.tick(o, now);
    w.save(ctx.state_file);
    // 事故的原因與最後活著的時間要先讀（observe 會換掉控制代碼、更新時間）
    let info = incident.as_ref().map(|_| {
        let pid = tracker.held_pid();
        (tracker.take_reason(), tracker.last_alive_ms, sink.event_text(pid))
    });
    tracker.observe(o, now, &|pid| sink.open(pid));
    let inc = incident?;
    let (reason, last_alive, event) = info.unwrap_or_default();
    // 裡面沒有夥伴、而且是正常結束（結束碼 0）：不是事故，不寫紀錄、不通知
    if empty_normal_exit(&inc, &reason) {
        return None;
    }
    sink.record(&incident_line(&inc, &reason, last_alive, ctx.uptime_secs, event.as_deref()));
    queue_notice(ctx.work_dir, inc.partners.len(), inc.resume, now);
    if !inc.partners.is_empty() {
        sink.resume(inc.partners.clone(), inc.resume);
    }
    Some(inc)
}

// ---- 接回結果通知 ----

/// 接回做完之後的結果通知檔（工作資料夾）：橋接核心下一輪讀走、請後台寄給本人，成功就刪
pub const RESUME_NOTICE_FILE: &str = "mux-resume-notice.json";
/// 通知名單最多帶幾位名字（後台一次最多收這麼多）
pub const RESUME_NOTICE_MAX: usize = 100;

/// 排一則接回結果通知：斷了幾位、接回幾位、哪些沒接回（名字）。名字之外不帶任何原因（技術細節只進 log）
pub fn queue_resume_notice(work_dir: &Path, broke: usize, failed: &[String], now_ms: u64) {
    if work_dir.as_os_str().is_empty() || broke == 0 {
        return;
    }
    let failed: Vec<&String> = failed.iter().take(RESUME_NOTICE_MAX).collect();
    let broke = broke.clamp(failed.len(), RESUME_NOTICE_MAX);
    let body = serde_json::json!({ "count": broke, "resumed": broke - failed.len(), "failed": failed, "at": now_ms });
    let tmp = work_dir.join(format!("{RESUME_NOTICE_FILE}.tmp"));
    if std::fs::write(&tmp, body.to_string()).is_ok() {
        let _ = std::fs::rename(&tmp, work_dir.join(RESUME_NOTICE_FILE));
    }
}

/// 排著的接回結果：（斷了幾位, 接回幾位, 沒接回的名字, 完成時間）。沒有或壞掉的檔回 None（壞檔順手刪掉）
pub fn read_resume_notice(work_dir: &Path) -> Option<(usize, usize, Vec<String>, u64)> {
    let f = work_dir.join(RESUME_NOTICE_FILE);
    let text = std::fs::read_to_string(&f).ok()?;
    let parsed = serde_json::from_str::<serde_json::Value>(&text).ok().and_then(|v| {
        let count = usize::try_from(v.get("count")?.as_u64()?).ok()?;
        let resumed = usize::try_from(v.get("resumed")?.as_u64()?).ok()?;
        let failed: Vec<String> = v.get("failed")?.as_array()?.iter().filter_map(|n| n.as_str().map(String::from)).collect();
        Some((count.min(RESUME_NOTICE_MAX), resumed.min(RESUME_NOTICE_MAX), failed, v.get("at").and_then(serde_json::Value::as_u64).unwrap_or(0)))
    });
    if parsed.is_none() {
        let _ = std::fs::remove_file(&f);
    }
    parsed
}

pub fn clear_resume_notice(work_dir: &Path) {
    let _ = std::fs::remove_file(work_dir.join(RESUME_NOTICE_FILE));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn t1818_接回結果檔_寫了讀得到_人數對得上_壞檔當沒有() {
        let d = tempfile::tempdir().unwrap();
        assert_eq!(read_resume_notice(d.path()), None);
        queue_resume_notice(d.path(), 3, &["丙".to_string()], 42);
        assert_eq!(read_resume_notice(d.path()), Some((3, 2, vec!["丙".to_string()], 42)));
        clear_resume_notice(d.path());
        assert_eq!(read_resume_notice(d.path()), None);
        queue_resume_notice(d.path(), 0, &[], 1);
        assert_eq!(read_resume_notice(d.path()), None, "沒有人斷就不通知");
        std::fs::write(d.path().join(RESUME_NOTICE_FILE), "壞掉").unwrap();
        assert_eq!(read_resume_notice(d.path()), None);
        assert!(!d.path().join(RESUME_NOTICE_FILE).exists());
        queue_resume_notice(Path::new(""), 1, &[], 1);
        assert!(!Path::new(RESUME_NOTICE_FILE).exists(), "沒有工作資料夾不寫到目前目錄");
    }
}

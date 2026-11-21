//! 卡死處置（#1897 ④）：終端服務的程序還在、記錄也對得上，但心跳停了（主執行緒卡住）。
//! 這裡只做「確認、結束、清檔」；要不要做、做完怎麼報事故由 `mux_round` 決定。
//!
//! 整段持啟動鎖與開窗鎖，九步依序，任何一步不過就取消（取消＝什麼都沒動，呼叫端這一輪照舊判斷）：
//! 1. pid 檔記的程序編號＋建立時間對得上而且還活著；2. 該程序是這個資料夾的 mux 執行檔；3. 心跳檔的 pid 等於記錄的 pid；
//! 4. 跑一次 `alive()`，連得上就取消；5. 跑完之後再讀一次心跳，seq 動了就取消；
//! 6. 先蒐集子孫（排除建立時間早於 mux 的）再結束，確認 mux 與子孫都消失；
//! 7. 刪檔前重讀 pid 檔，仍是被結束的那一組才刪 pid 檔與心跳檔；8. 刪掉同一個 pid 的 `stopped` 記號（不寫新記號、不呼叫 `stop()`）；
//! 9. 交回呼叫端，由監看的「已確認消失」入口接回。
use super::*;

/// 處置的結果
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Disposal {
    /// 已結束並確認消失
    Done,
    /// 取消或失敗（沒有結束，或沒結束乾淨）。文字寫進 mux.log
    Cancelled(String),
    /// 啟動鎖或開窗鎖別人拿著：這一輪不處理，下一輪再看（不算取消，不進冷卻）
    Busy,
}

/// 這個程序（建立時間要對得上）還在不在
fn gone(r: &dyn Runner, pid: u32, born: u64) -> bool {
    r.started_ms(pid) != Some(born) || !r.alive(pid)
}

impl Mux<'_> {
    /// 卡死處置。`read_hb`＝讀心跳檔，回（pid, seq）；讀不到回 None
    pub fn dispose_stuck(&self, read_hb: &dyn Fn() -> Option<(u64, u64)>) -> Disposal {
        if let Err(e) = std::fs::create_dir_all(&self.paths.dir) {
            return Disposal::Cancelled(format!("建立終端服務資料夾失敗：{e}"));
        }
        let Ok(_start) = StartLock::try_acquire(&self.paths.lock, self.runner) else { return Disposal::Busy };
        let Ok(_open) = StartLock::try_acquire(&self.paths.open_lock, self.runner) else { return Disposal::Busy };

        // 1. 記錄的程序還在、建立時間對得上
        let Some((pid, born)) = read_pid(&self.paths.pid) else { return Disposal::Cancelled("沒有終端服務的記錄，沒有結束".into()) };
        // 建立時間對得上還不夠（#1818）：程序已結束但還有人握著控制代碼時，建立時間照樣查得到，所以用 live_pid（同時看還活著）
        if self.live_pid() != Some((pid, born)) {
            return Disposal::Cancelled(format!("記錄的終端服務（程序 {pid}）已經不在，沒有結束"));
        }
        // 2. 執行檔要是這個資料夾的 mux
        if !self.runner.exe_path(pid).is_some_and(|p| is_server_image(&p, &self.server)) {
            return Disposal::Cancelled(format!("程序 {pid} 不是這個資料夾的終端服務執行檔，沒有結束"));
        }
        // 3. 心跳檔的 pid 就是記錄的 pid
        let Some((hb_pid, seq0)) = read_hb() else { return Disposal::Cancelled("讀不到心跳檔，沒有結束".into()) };
        if hb_pid != u64::from(pid) {
            return Disposal::Cancelled(format!("心跳檔的程序（{hb_pid}）不是記錄的程序（{pid}），沒有結束"));
        }
        // 4. 連得上就不是卡死
        if self.alive() {
            return Disposal::Cancelled("心跳停了但連得上，沒有結束".into());
        }
        // 5. 跑完連線測試之後再看一次心跳：這段期間動了就取消
        match read_hb() {
            Some((p, s)) if p == hb_pid && s == seq0 => {}
            _ => return Disposal::Cancelled("確認期間心跳又動了（或讀不到），沒有結束".into()),
        }
        // 6. 先蒐集子孫（排除建立時間早於 mux 的：編號被重用的別人），再結束，確認都消失
        let kids: Vec<(u32, u64)> = self.runner.descendants_of(pid).into_iter().filter_map(|d| self.runner.started_ms(d).filter(|b| *b >= born).map(|b| (d, b))).collect();
        self.runner.kill_tree(pid);
        let mut cleared = false;
        for _ in 0..GONE_RETRIES {
            if gone(self.runner, pid, born) && kids.iter().all(|(d, b)| gone(self.runner, *d, *b)) {
                cleared = true;
                break;
            }
            self.runner.sleep(POLL);
        }
        if !cleared {
            return Disposal::Cancelled(format!("終端服務（程序 {pid}）或它的子程序沒有結束乾淨，保留記錄"));
        }
        // 7. 刪檔前重讀 pid 檔：仍是被結束的那一組才刪（比照 stop()）
        if read_pid(&self.paths.pid) == Some((pid, born)) {
            let _ = std::fs::remove_file(&self.paths.pid);
            self.clear_heartbeat();
        }
        // 8. 舊記號會把這次事故判成「ASN 自己收的」：同一個 pid 的記號刪掉。不寫新記號
        let mark = self.paths.dir.join(STOPPED_FILE);
        if read_pid(&mark).is_some_and(|(p, _)| p == pid) {
            let _ = std::fs::remove_file(&mark);
        }
        Disposal::Done
    }
}

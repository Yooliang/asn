//! 重新啟動 ASN（#2204）：換帳號、登入狀態改變、之後工作管理員的「重啟 ASN」都走這一條，不再各寫一份。
//!
//! 順序（任何一步失敗都不能讓 ASN 消失）：
//! 1. 確認執行檔還在；不在就回錯，什麼都不停。
//! 2. 收橋：停止收新信，等進行中的送出／ack 做完（最多 [`DRAIN_TIMEOUT`]），逾時才 abort。
//! 3. 開新程序。開不起來：**不結束**，撤回守護記號、恢復收發，回錯給畫面。
//! 4. 開起來了才做其餘收尾並結束。重新啟動**不寫**「正常結束」記號，新程序萬一沒起來守護還救得回來。

use std::future::Future;
use std::path::Path;
use std::time::Duration;

/// 收橋時等進行中的送出／ack 的上限
pub const DRAIN_TIMEOUT: Duration = Duration::from_secs(3);
/// 新程序開起來之後，舊程序再等多久才結束（讓指令先把結果回給畫面）
pub const EXIT_DELAY: Duration = Duration::from_millis(600);
/// 給畫面的白話錯誤；原始錯誤只寫 ui.log
pub const FAIL_TEXT: &str = "重新啟動失敗，ASN 會繼續執行。請稍後再試，或自己關閉後再重新開啟。";

/// 執行檔還在、而且是檔案（更新換檔中或被刪掉時重新啟動一定開不起來）
pub fn exe_usable(exe: &Path) -> Result<(), String> {
    match std::fs::metadata(exe) {
        Ok(m) if m.is_file() => Ok(()),
        Ok(_) => Err(format!("執行檔不是檔案：{}", exe.display())),
        Err(e) => Err(format!("找不到執行檔 {}：{e}", exe.display())),
    }
}

/// 重新啟動的步驟（純流程，動作都由呼叫端傳進來，好測）。
/// 回 Ok＝新程序已開起來，呼叫端接著收尾並結束；回 Err＝沒有結束的理由，ASN 要繼續跑（Err 內是原始錯誤，給 log）。
/// - `exe_ok`：確認執行檔；失敗時 `drain` 與 `spawn` 都不會被呼叫（什麼都沒停）
/// - `drain`：收橋，回傳收橋前橋是不是在跑
/// - `spawn`：開新程序
/// - `on_spawn_failed`：開新程序失敗時復原（撤回守護記號、恢復收發），參數是收橋前橋是不是在跑
pub async fn run_steps<Fut: Future<Output = bool>>(exe_ok: impl FnOnce() -> Result<(), String>, drain: impl FnOnce() -> Fut, spawn: impl FnOnce() -> Result<(), String>, on_spawn_failed: impl FnOnce(bool)) -> Result<(), String> {
    exe_ok()?;
    let was_running = drain().await;
    match spawn() {
        Ok(()) => Ok(()),
        Err(e) => {
            on_spawn_failed(was_running);
            Err(format!("開不起新的程序：{e}"))
        }
    }
}

/// 開新程序失敗後撤回守護記號：刪「正常結束」記號並補一次心跳（之後真的當掉守護照樣會重開）
pub fn undo_marks(guard_dir: &Path, pid: u32, now_ms: u64) {
    crate::guard::note_still_running(guard_dir, pid, now_ms);
}

/// 重新啟動：成功回 Ok（新程序已開起來，`exit_delay` 後這個舊程序做完收尾自己結束）；
/// 失敗回白話錯誤（ASN 繼續跑，原始錯誤寫 ui.log）。呼叫端要負責 --shot／安卓不走這裡
pub async fn relaunch_and_exit(handle: &tauri::AppHandle, work_dir: &Path, reason: &'static str, exit_delay: Duration) -> Result<(), String> {
    use tauri::Manager as _;
    let pid = std::process::id();
    let mgr = handle.state::<crate::bridge::Manager>();
    let res = run_steps(
        || std::env::current_exe().map_err(|e| e.to_string()).and_then(|p| exe_usable(&p)),
        || mgr.drain_for_relaunch(DRAIN_TIMEOUT),
        // 不用 tauri 的 AppHandle 重開：它讓新程序繼承本程序的 stderr，斷掉的管線會一路傳下去（#1771）
        crate::ui_log::relaunch_self,
        |was_running| {
            if let Some(gd) = crate::guard::guard_dir() {
                undo_marks(&gd, pid, crate::heartbeat::now_ms());
            }
            mgr.resume_after_failed_relaunch(was_running);
        },
    )
    .await;
    if let Err(e) = res {
        crate::ui_log::log_info(work_dir, &format!("重新啟動失敗，ASN 繼續執行：{e}"));
        return Err(FAIL_TEXT.to_string());
    }
    let (h, wd) = (handle.clone(), work_dir.to_path_buf());
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(exit_delay).await;
        // 重新啟動不寫「正常結束」記號
        crate::cleanup_with(&h, crate::ExitKind::Relaunch);
        crate::ui_log::log_exit(&wd, reason);
        h.exit(0);
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    fn flow(exe: Result<(), String>, spawn: Result<(), String>, was_running: bool) -> (Result<(), String>, Vec<String>) {
        let calls = RefCell::new(Vec::<String>::new());
        let r = futures_block(run_steps(
            || {
                calls.borrow_mut().push("exe".into());
                exe
            },
            || {
                calls.borrow_mut().push("drain".into());
                async move { was_running }
            },
            || {
                calls.borrow_mut().push("spawn".into());
                spawn
            },
            |w| calls.borrow_mut().push(format!("failed(was_running={w})")),
        ));
        (r, calls.into_inner())
    }

    fn futures_block<F: Future>(f: F) -> F::Output {
        tokio::runtime::Builder::new_current_thread().enable_time().build().unwrap().block_on(f)
    }

    #[test]
    fn _2204_開新程序失敗_不結束_復原_回錯() {
        let (r, calls) = flow(Ok(()), Err("拒絕存取".into()), true);
        assert!(r.unwrap_err().contains("拒絕存取"), "原始錯誤要帶出去給 log");
        assert_eq!(calls, ["exe", "drain", "spawn", "failed(was_running=true)"], "失敗要走復原，且橋原本在跑才恢復");
        let (_, calls) = flow(Ok(()), Err("x".into()), false);
        assert_eq!(calls.last().unwrap(), "failed(was_running=false)", "橋原本沒在跑就不能硬開");
    }

    #[test]
    fn _2204_開新程序成功_不走復原() {
        let (r, calls) = flow(Ok(()), Ok(()), true);
        assert!(r.is_ok());
        assert_eq!(calls, ["exe", "drain", "spawn"]);
    }

    #[test]
    fn _2204_執行檔不在_什麼都不停() {
        let (r, calls) = flow(Err("找不到".into()), Ok(()), true);
        assert!(r.is_err());
        assert_eq!(calls, ["exe"], "執行檔不在就不能收橋也不能開新程序");
    }

    #[test]
    fn _2204_執行檔檢查_存在的檔案過_不存在與資料夾不過() {
        let d = tempfile::tempdir().unwrap();
        let f = d.path().join("asn.exe");
        std::fs::write(&f, b"x").unwrap();
        assert!(exe_usable(&f).is_ok());
        assert!(exe_usable(&d.path().join("不存在.exe")).is_err());
        assert!(exe_usable(d.path()).is_err(), "資料夾不是執行檔");
    }

    #[test]
    fn _2204_開新程序失敗_撤回正常結束記號並補心跳() {
        let d = tempfile::tempdir().unwrap();
        crate::guard::note_user_quit(d.path());
        assert!(crate::guard::quit_path(d.path()).exists());
        undo_marks(d.path(), 4242, 1_800_000_000_000);
        assert!(!crate::guard::quit_path(d.path()).exists(), "記號要撤回，守護才救得了");
        assert_eq!(crate::guard::read_alive(d.path()).unwrap().pid, 4242);
    }

    #[test]
    fn _2204_重新啟動不寫正常結束記號_一般結束照寫() {
        let d = tempfile::tempdir().unwrap();
        crate::guard::note_exit(d.path(), true);
        assert!(!crate::guard::quit_path(d.path()).exists(), "重新啟動不能寫 user-quit");
        crate::guard::note_exit(d.path(), false);
        assert!(crate::guard::quit_path(d.path()).exists(), "一般結束仍要寫");
    }

    #[test]
    fn _2204_收尾的種類_重新啟動走_relaunch_一般結束走_quit() {
        let lib = include_str!("lib.rs");
        let cleanup = lib.split("pub(crate) fn cleanup(app: &AppHandle) {").nth(1).unwrap().split("\n}").next().unwrap();
        assert!(cleanup.contains("cleanup_with(app, ExitKind::Quit)"), "一般結束要走 Quit");
        let with = lib.split("pub(crate) fn cleanup_with").nth(1).unwrap().split("\n}").next().unwrap();
        assert!(with.contains("guard::note_exit(&gd, kind == ExitKind::Relaunch)"), "cleanup_with 要依種類決定寫不寫記號");
        let src = include_str!("relaunch.rs");
        let body = src.split("pub async fn relaunch_and_exit").nth(1).unwrap();
        let body = body.split("#[cfg(test)]").next().unwrap();
        assert!(body.contains("cleanup_with(&h, crate::ExitKind::Relaunch)") && !body.contains("note_user_quit"), "重新啟動路徑不能寫 user-quit");
    }

    #[test]
    fn _2204_呼叫端都走_relaunch_and_exit_不再各寫一份() {
        let acct = include_str!("account.rs");
        assert!(acct.contains("crate::relaunch::relaunch_and_exit("), "account.rs 要走共用的重新啟動");
        assert!(!acct.contains("crate::ui_log::relaunch_self()"), "account.rs 不能自己 spawn 後無條件結束");
        assert!(!acct.contains("fn restart_soon"), "舊的 restart_soon 已被取代");
    }
}

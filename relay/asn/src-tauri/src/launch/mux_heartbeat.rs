//! 讀終端服務（mux）的心跳檔（#1897 拆項 3）。**只讀不判**：這裡只產出 [`Hb`]，`Watch::tick` 完全不看它（下一張才切換）。
//!
//! 心跳檔是自建的 mux-server 每 5 秒寫的一行 JSON：`{"v":1,"pid":…,"started_ms":…,"seq":…,"at_ms":…}`，與 `mux.pid` 同資料夾。
//! 規則：
//! - 檔案上限 4 KB，超過當壞檔；
//! - 合格＝`v==1`、`pid` 等於 pid 檔記的 pid、`started_ms` 與記錄的建立時間差 ≤ 60 秒（兩邊時間來源不同，所以給容差）；
//!   不合格一律走舊判斷（`NotSupported`），方向安全；
//! - 過期＝`seq` 最後一次變動距今 ≥ 90 秒；
//! - 睡眠／凍結保護：比較兩次讀取之間「單調時鐘的差」與「牆上時鐘的差」，差超過 30 秒就這一輪不下結論、計時重設。
//!   不能用「兩輪間隔」判斷：服務卡死時 cli 逾時本來就會把兩輪拉長；
//! - 讀不到、解析失敗＝`Unreadable`（之後等同 `NotSupported`）。
//!
//! 時鐘與檔案內容都由呼叫端傳進來，狀態與判斷是純函式，測試用假時鐘、假檔案。
#![cfg(desktop)]

use serde::Deserialize;
use std::path::Path;

/// 心跳檔大小上限，超過當壞檔
pub const MAX_BYTES: usize = 4096;
/// `seq` 這麼久沒動就算心跳停了（毫秒）
pub const STALE_AFTER_MS: u64 = 90_000;
/// 兩種時鐘的差超過這個，就當作睡眠或被凍結（毫秒）
pub const SLEEP_GAP_MS: u64 = 30_000;
/// 心跳檔的 `started_ms` 與 pid 檔記錄的建立時間，最多差這麼多（毫秒）
pub const BIRTH_TOLERANCE_MS: u64 = 60_000;

/// 這一輪心跳的結果
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Hb {
    /// 沒有心跳（舊版、上游原版、檔案對不上）：走舊判斷
    #[default]
    NotSupported,
    /// 支援心跳，而且還在動（或這一輪不下結論）
    Fresh,
    /// 支援心跳，但 `seq` 已經 `secs` 秒沒動
    Stale { secs: u64 },
    /// 讀不到或內容壞了：等同 NotSupported
    Unreadable,
}

/// 讀檔的結果（由呼叫端讀；測試直接給）
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FileRead {
    Missing,
    Failed,
    Bytes(Vec<u8>),
}

/// 真的去讀心跳檔：最多讀 `MAX_BYTES + 1` 個位元組，多讀的那一個用來判斷「超過上限」，不會把大檔整個讀進記憶體
pub fn read_file(path: &Path) -> FileRead {
    use std::io::Read;
    let f = match std::fs::File::open(path) {
        Ok(f) => f,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return FileRead::Missing,
        Err(_) => return FileRead::Failed,
    };
    let mut buf = Vec::new();
    match f.take(MAX_BYTES as u64 + 1).read_to_end(&mut buf) {
        Ok(_) => FileRead::Bytes(buf),
        Err(_) => FileRead::Failed,
    }
}

#[derive(Debug, Deserialize)]
struct Beat {
    v: u64,
    pid: u64,
    started_ms: u64,
    seq: u64,
}

fn parse(bytes: &[u8]) -> Option<Beat> {
    if bytes.len() > MAX_BYTES {
        return None;
    }
    serde_json::from_slice(bytes).ok()
}

/// 卡死處置（#1897 ④）用：讀心跳檔，只取（`pid`, `seq`）。讀不到、超過上限、壞檔、`v`≠1 都回 None
pub fn peek_file(path: &Path) -> Option<(u64, u64)> {
    let FileRead::Bytes(b) = read_file(path) else { return None };
    let beat = parse(&b)?;
    (beat.v == 1).then_some((beat.pid, beat.seq))
}

/// 單一 mux（以程序編號＋建立時間為 key）的記憶體狀態
#[derive(Debug)]
struct State {
    key: (u32, u64),
    qualified: bool,
    last_seq: u64,
    /// `seq` 最後一次變動（或睡眠重設）的單調時間
    last_change: u64,
    /// 上一次讀取時的單調、牆上時鐘
    last_mono: u64,
    last_wall: u64,
    /// 合格後最後一次讀得到好內容的單調時間
    last_ok: u64,
    unreadable_logged: bool,
    mismatch_logged: bool,
}

/// 心跳狀態物件：每輪呼叫 [`HbTracker::observe`]。ASN 重啟後狀態歸零，要重新看到 seq 不動滿 90 秒才算過期（預期行為）
#[derive(Debug, Default)]
pub struct HbTracker {
    state: Option<State>,
}

impl HbTracker {
    /// 目前這個 mux 的（程序編號＋建立時間, 最後看到的 seq）；還沒合格回 None。判成 `Stale` 的那一輪用它記下「停在哪個 seq」，
    /// 卡死處置時拿來核對（#1897 ④）
    pub fn stale_at(&self) -> Option<((u32, u64), u64)> {
        self.state.as_ref().filter(|s| s.qualified).map(|s| (s.key, s.last_seq))
    }

    /// `record`＝pid 檔記的（程序編號, 建立時間）；`mono_ms`／`wall_ms`＝這次讀取當下的單調／牆上時鐘。
    /// 回（結果, 要寫進 mux.log 的行）；每個 mux 每種情況只會回一行
    pub fn observe(&mut self, record: Option<(u32, u64)>, read: FileRead, mono_ms: u64, wall_ms: u64) -> (Hb, Vec<String>) {
        let mut logs = Vec::new();
        let Some(key) = record else {
            self.state = None;
            return (Hb::NotSupported, logs);
        };
        if self.state.as_ref().is_none_or(|s| s.key != key) {
            self.state = Some(State { key, qualified: false, last_seq: 0, last_change: mono_ms, last_mono: mono_ms, last_wall: wall_ms, last_ok: mono_ms, unreadable_logged: false, mismatch_logged: false });
        }
        let s = self.state.as_mut().expect("上面剛設過");

        // 睡眠／凍結：兩種時鐘走的時間差太多。這一輪不下結論，計時重設為現在
        let d_mono = mono_ms as i128 - s.last_mono as i128;
        let d_wall = wall_ms as i128 - s.last_wall as i128;
        let slept = (d_mono - d_wall).unsigned_abs() > SLEEP_GAP_MS as u128;
        s.last_mono = mono_ms;
        s.last_wall = wall_ms;
        if slept {
            s.last_change = mono_ms;
            s.last_ok = mono_ms;
        }

        let beat = match &read {
            FileRead::Bytes(b) => parse(b),
            _ => None,
        };
        let Some(beat) = beat else {
            // 沒檔案、讀失敗、壞檔、超過上限
            if !s.qualified {
                // 從來沒合格：沒檔案就是沒有心跳，其餘是讀不到。兩者之後都走舊判斷
                return (if read == FileRead::Missing { Hb::NotSupported } else { Hb::Unreadable }, logs);
            }
            if mono_ms.saturating_sub(s.last_ok) > STALE_AFTER_MS && !s.unreadable_logged {
                s.unreadable_logged = true;
                logs.push(format!("終端服務：心跳檔讀不到超過 {} 秒，先照舊判斷（程序 {}）", STALE_AFTER_MS / 1000, key.0));
            }
            return (Hb::Unreadable, logs);
        };

        let ok = beat.v == 1 && beat.pid == u64::from(key.0) && beat.started_ms.abs_diff(key.1) <= BIRTH_TOLERANCE_MS;
        if !ok {
            if !s.mismatch_logged {
                s.mismatch_logged = true;
                logs.push(format!(
                    "終端服務：心跳檔和記錄對不上（版本 {}、程序 {}、啟動 {}；記錄是程序 {}、建立 {}），不採用",
                    beat.v, beat.pid, beat.started_ms, key.0, key.1
                ));
            }
            // 已合格的 mux 檔案忽然變得對不上：當作讀不到，不能拿它判過期
            return (if s.qualified { Hb::Unreadable } else { Hb::NotSupported }, logs);
        }

        s.last_ok = mono_ms;
        if !s.qualified {
            s.qualified = true;
            s.last_seq = beat.seq;
            s.last_change = mono_ms;
            return (Hb::Fresh, logs);
        }
        if beat.seq != s.last_seq || slept {
            s.last_seq = beat.seq;
            s.last_change = mono_ms;
            return (Hb::Fresh, logs);
        }
        let stale = mono_ms.saturating_sub(s.last_change);
        if stale >= STALE_AFTER_MS {
            (Hb::Stale { secs: stale / 1000 }, logs)
        } else {
            (Hb::Fresh, logs)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const REC: (u32, u64) = (4242, 1_700_000_000_000);

    fn beat(pid: u64, started: u64, seq: u64, v: u64) -> FileRead {
        FileRead::Bytes(format!(r#"{{"v":{v},"pid":{pid},"started_ms":{started},"seq":{seq},"at_ms":0}}"#).into_bytes())
    }
    fn good(seq: u64) -> FileRead {
        beat(REC.0 as u64, REC.1 + 1_500, seq, 1)
    }
    /// 假時鐘：單調與牆上一起走（正常情況）
    fn at(t: &mut HbTracker, rec: Option<(u32, u64)>, r: FileRead, secs: u64) -> (Hb, Vec<String>) {
        t.observe(rec, r, secs * 1000, 5_000_000_000_000 + secs * 1000)
    }

    #[test]
    fn 合格_pid_建立時間都對_是_fresh() {
        let mut t = HbTracker::default();
        let (hb, logs) = at(&mut t, Some(REC), good(1), 0);
        assert_eq!((hb, logs.len()), (Hb::Fresh, 0));
    }

    #[test]
    fn 沒有檔案_是_notsupported_不寫_log() {
        let mut t = HbTracker::default();
        let (hb, logs) = at(&mut t, Some(REC), FileRead::Missing, 0);
        assert_eq!((hb, logs.len()), (Hb::NotSupported, 0));
    }

    #[test]
    fn 沒有記錄的_mux_是_notsupported() {
        let mut t = HbTracker::default();
        assert_eq!(at(&mut t, None, good(1), 0).0, Hb::NotSupported);
    }

    #[test]
    fn pid_不對_舊檔_是_notsupported_且記一行_log_只記一次() {
        let mut t = HbTracker::default();
        let old = || beat(9999, REC.1 + 1_000, 7, 1);
        let (hb, logs) = at(&mut t, Some(REC), old(), 0);
        assert_eq!((hb, logs.len()), (Hb::NotSupported, 1));
        let (hb, logs) = at(&mut t, Some(REC), old(), 30);
        assert_eq!((hb, logs.len()), (Hb::NotSupported, 0), "每個 mux 只記一次");
        // 舊檔一直不動，也不能被判成過期
        assert_eq!(at(&mut t, Some(REC), old(), 300).0, Hb::NotSupported);
    }

    #[test]
    fn started_ms_差太多_不合格() {
        let mut t = HbTracker::default();
        let (hb, logs) = at(&mut t, Some(REC), beat(REC.0 as u64, REC.1 + 61_000, 1, 1), 0);
        assert_eq!((hb, logs.len()), (Hb::NotSupported, 1));
        let mut t = HbTracker::default();
        assert_eq!(at(&mut t, Some(REC), beat(REC.0 as u64, REC.1 + 60_000, 1, 1), 0).0, Hb::Fresh, "剛好 60 秒內合格");
        let mut t = HbTracker::default();
        assert_eq!(at(&mut t, Some(REC), beat(REC.0 as u64, REC.1 - 60_000, 1, 1), 0).0, Hb::Fresh, "早於記錄也一樣看差距");
    }

    #[test]
    fn v_不是_1_不合格() {
        let mut t = HbTracker::default();
        let (hb, logs) = at(&mut t, Some(REC), beat(REC.0 as u64, REC.1, 1, 2), 0);
        assert_eq!((hb, logs.len()), (Hb::NotSupported, 1));
    }

    #[test]
    fn 壞檔_是_unreadable() {
        let mut t = HbTracker::default();
        assert_eq!(at(&mut t, Some(REC), FileRead::Bytes(b"not json".to_vec()), 0).0, Hb::Unreadable);
        assert_eq!(at(&mut t, Some(REC), FileRead::Bytes(br#"{"v":1,"pid":4242}"#.to_vec()), 5).0, Hb::Unreadable, "缺欄位");
        assert_eq!(at(&mut t, Some(REC), FileRead::Bytes(Vec::new()), 10).0, Hb::Unreadable, "空檔");
        assert_eq!(at(&mut t, Some(REC), FileRead::Failed, 15).0, Hb::Unreadable, "讀檔失敗");
    }

    #[test]
    fn 超過_4kb_當壞檔() {
        let mut t = HbTracker::default();
        let mut body = format!(r#"{{"v":1,"pid":{},"started_ms":{},"seq":1,"at_ms":0}}"#, REC.0, REC.1).into_bytes();
        body.extend(std::iter::repeat_n(b' ', MAX_BYTES));
        assert!(body.len() > MAX_BYTES);
        assert_eq!(at(&mut t, Some(REC), FileRead::Bytes(body), 0).0, Hb::Unreadable);
        // 剛好 4 KB 還是收
        let mut ok = format!(r#"{{"v":1,"pid":{},"started_ms":{},"seq":1,"at_ms":0}}"#, REC.0, REC.1).into_bytes();
        ok.resize(MAX_BYTES, b' ');
        let mut t = HbTracker::default();
        assert_eq!(at(&mut t, Some(REC), FileRead::Bytes(ok), 0).0, Hb::Fresh);
    }

    #[test]
    fn seq_有動_不過期() {
        let mut t = HbTracker::default();
        let mut seq = 1;
        for s in (0..600).step_by(5) {
            seq += 1;
            assert_eq!(at(&mut t, Some(REC), good(seq), s).0, Hb::Fresh, "第 {s} 秒");
        }
    }

    #[test]
    fn seq_不動滿_90_秒_是_stale() {
        let mut t = HbTracker::default();
        assert_eq!(at(&mut t, Some(REC), good(5), 0).0, Hb::Fresh);
        assert_eq!(at(&mut t, Some(REC), good(5), 30).0, Hb::Fresh);
        assert_eq!(at(&mut t, Some(REC), good(5), 89).0, Hb::Fresh);
        assert_eq!(at(&mut t, Some(REC), good(5), 90).0, Hb::Stale { secs: 90 });
        assert_eq!(at(&mut t, Some(REC), good(5), 120).0, Hb::Stale { secs: 120 });
        assert_eq!(at(&mut t, Some(REC), good(6), 125).0, Hb::Fresh, "seq 動了就恢復");
    }

    #[test]
    fn 睡眠_兩種時鐘差超過_30_秒_這一輪不下結論_計時重設() {
        let mut t = HbTracker::default();
        assert_eq!(at(&mut t, Some(REC), good(5), 0).0, Hb::Fresh);
        assert_eq!(at(&mut t, Some(REC), good(5), 60).0, Hb::Fresh);
        // 睡了 10 分鐘：牆上時鐘走了 600 秒，單調時鐘只走 5 秒（Linux 型）
        let (hb, _) = t.observe(Some(REC), good(5), 65_000, 5_000_000_000_000 + 660_000);
        assert_eq!(hb, Hb::Fresh, "睡眠那輪不下結論");
        // 醒來後計時從頭算：再過 60 秒（兩種時鐘一起走）還不到 90 秒
        let (hb, _) = t.observe(Some(REC), good(5), 125_000, 5_000_000_000_000 + 720_000);
        assert_eq!(hb, Hb::Fresh);
        let (hb, _) = t.observe(Some(REC), good(5), 160_000, 5_000_000_000_000 + 755_000);
        assert_eq!(hb, Hb::Stale { secs: 95 }, "從睡眠那輪起算滿 90 秒才過期");
    }

    #[test]
    fn 睡眠_單調時鐘把睡眠算進去_牆上沒走_也不下結論() {
        let mut t = HbTracker::default();
        assert_eq!(at(&mut t, Some(REC), good(5), 0).0, Hb::Fresh);
        // Windows 型：單調走了 300 秒、牆上時鐘被往回調（只走 10 秒）
        let (hb, _) = t.observe(Some(REC), good(5), 300_000, 5_000_000_000_000 + 10_000);
        assert_eq!(hb, Hb::Fresh);
    }

    /// 服務卡死時每輪 cli 逾時耗 60 秒以上：兩輪間隔很長，但單調與牆上一起走，不是睡眠，仍要判出 Stale
    #[test]
    fn cli_逾時拉長間隔_心跳持續停_仍判_stale() {
        let mut t = HbTracker::default();
        assert_eq!(at(&mut t, Some(REC), good(5), 0).0, Hb::Fresh);
        assert_eq!(at(&mut t, Some(REC), good(5), 65).0, Hb::Fresh);
        assert_eq!(at(&mut t, Some(REC), good(5), 130).0, Hb::Stale { secs: 130 });
        assert_eq!(at(&mut t, Some(REC), good(5), 195).0, Hb::Stale { secs: 195 });
    }

    #[test]
    fn 已合格後讀不到超過_90_秒_unreadable_並記一行_log_只記一次() {
        let mut t = HbTracker::default();
        assert_eq!(at(&mut t, Some(REC), good(5), 0).0, Hb::Fresh);
        let (hb, logs) = at(&mut t, Some(REC), FileRead::Missing, 30);
        assert_eq!((hb, logs.len()), (Hb::Unreadable, 0), "還沒滿 90 秒不記");
        let (hb, logs) = at(&mut t, Some(REC), FileRead::Missing, 91);
        assert_eq!((hb, logs.len()), (Hb::Unreadable, 1));
        let (hb, logs) = at(&mut t, Some(REC), FileRead::Failed, 150);
        assert_eq!((hb, logs.len()), (Hb::Unreadable, 0), "每個 mux 只記一次");
    }

    #[test]
    fn 換了新_mux_狀態重來() {
        let mut t = HbTracker::default();
        assert_eq!(at(&mut t, Some(REC), good(5), 0).0, Hb::Fresh);
        assert_eq!(at(&mut t, Some(REC), good(5), 100).0, Hb::Stale { secs: 100 });
        let new = (5000, REC.1 + 900_000);
        // 新 mux 還沒寫檔，舊檔還在：對不上，不能沿用舊的過期
        assert_eq!(at(&mut t, Some(new), good(5), 105).0, Hb::NotSupported);
        let fresh = beat(5000, new.1 + 800, 1, 1);
        assert_eq!(at(&mut t, Some(new), fresh, 110).0, Hb::Fresh);
    }

    /// 心跳要在 mux_snapshot 最前面讀，早於服務卡死時各等逾時的 sweep_exited／sweep_missing
    #[test]
    fn 心跳在_mux_snapshot_最前面讀() {
        let src = include_str!("term.rs").replace("
", "
");
        let f = src.find("fn mux_snapshot_at(").unwrap();
        let body = &src[f..];
        let hb = body.find("self.read_heartbeat(now)").unwrap();
        assert!(hb < body.find("self.sweep_exited(").unwrap());
        assert!(hb < body.find("self.sweep_missing(").unwrap());
    }

    #[test]
    fn 真的讀檔_沒檔案_壞檔_超長() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("heartbeat.json");
        assert_eq!(read_file(&p), FileRead::Missing);
        std::fs::write(&p, b"{\"v\":1}").unwrap();
        assert_eq!(read_file(&p), FileRead::Bytes(b"{\"v\":1}".to_vec()));
        std::fs::write(&p, vec![b'x'; 1_000_000]).unwrap();
        match read_file(&p) {
            FileRead::Bytes(b) => assert_eq!(b.len(), MAX_BYTES + 1, "只讀到上限加一個位元組"),
            other => panic!("{other:?}"),
        }
    }
}

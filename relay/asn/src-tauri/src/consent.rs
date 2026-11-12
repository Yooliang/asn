//! 手機上「記住這台」與「忘記」要本人在這支手機上驗證過：一次性的確認憑證。
//!
//! 流程：畫面先向 Rust 要一個憑證（[`issue`]，32 位元組亂數、30 秒內有效、用一次），再請外殼（Kotlin）跳生物辨識或螢幕鎖；
//! **只有外殼在驗證通過的那一刻**，才在 App 私有資料夾的 `consent/` 底下寫一個檔，檔名是憑證的 SHA-256（小寫十六進位）。
//! 之後的 `android_known_confirm`／`android_known_forget` 帶憑證回來，Rust 算出同一個雜湊，核對記憶體裡的紀錄
//! （動作、那台電腦、沒過期、沒用過）並刪掉那個檔：刪得掉才算數，刪不掉就當失敗。
//!
//! 範圍：這道關只防網頁內容直接呼叫（不防 root 或原生層被改）。
//!
//! - 畫面能碰到的只有憑證字串。沒有任何給畫面的橋接方法會寫那個檔（外殼的守門測試），Rust 的命令也不會寫；
//!   專案沒有檔案外掛、權限也沒開檔案存取（守門測試），所以網頁沒辦法自己造出那個檔。
//! - 檔名由外殼自己算雜湊，不用畫面給的字串組路徑。
//! - 資料夾位置：手機的 `app.data_dir` 是 `<App 私有資料夾 filesDir>/.irori-asn`（沒有 APPDATA，見 datadir.rs 的 `FALLBACK_NAME`），
//!   所以憑證檔在 `<filesDir>/.irori-asn/consent/<雜湊>`，外殼用 `File(filesDir, ".irori-asn/consent")` 寫到同一處。
//! - 這個檔案不寫日誌、不發事件（守門測試鎖住）。
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::path::Path;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;
use crate::view_handshake::Scope;

/// 憑證的有效時間
pub const TOKEN_TTL: Duration = Duration::from_secs(30);
/// 外殼寫憑證檔的子資料夾（在 data_dir 底下）
pub const MARKER_DIR: &str = "consent";
/// 手機上唯一的主畫面視窗代號（tauri.android.conf.json）。只接受主畫面（手機只有一個畫面，這條主要是防將來多視窗時誤用）
pub const MAIN_LABEL: &str = "list";
/// 同時最多留幾筆
const MAX_RECORDS: usize = 64;
/// 本人沒有在這支手機上驗證過
pub const NOT_VERIFIED: &str = "not_verified";
/// 手機開始打字前沒有完成本人驗證（沒帶憑證、用過、過期）：給本人看的話
pub const INPUT_NOT_VERIFIED: &str = "沒有完成本人驗證，這次沒有開始打字";
/// 系統亂數取不到
pub const NO_RANDOM: &str = "系統亂數不可用";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Action {
    Confirm,
    Forget,
    /// 用相機掃電腦畫面上的 QR code 核對指紋（fp_scan.rs）
    Scan,
    /// 在那台電腦的終端開始打字（#1378）：`term_view_remote_start` 帶 scope=input 時要用掉這個憑證
    Input,
}

impl Action {
    pub fn parse(s: &str) -> Option<Action> {
        match s {
            "confirm" => Some(Action::Confirm),
            "forget" => Some(Action::Forget),
            "scan" => Some(Action::Scan),
            "input" => Some(Action::Input),
            _ => None,
        }
    }
}

/// 只接受主畫面（手機只有一個畫面，這條主要是防將來多視窗時誤用）
pub fn label_ok(label: &str) -> bool {
    label == MAIN_LABEL
}

const HEX: &[u8; 16] = b"0123456789abcdef";

fn hex_of(bytes: &[u8]) -> String {
    bytes.iter().flat_map(|b| [HEX[(b >> 4) as usize] as char, HEX[(b & 15) as usize] as char]).collect()
}

/// 憑證字串的 SHA-256，小寫十六進位（64 字元）。外殼用同樣的算法（字串的 UTF-8 位元組）命名憑證檔
pub fn hash_hex(challenge: &str) -> String {
    hex_of(&Sha256::digest(challenge.as_bytes()))
}

struct Rec {
    hash: String,
    issued: Duration,
}

#[derive(Default)]
pub struct Store {
    map: HashMap<(Action, String), Rec>,
}

impl Store {
    fn prune(&mut self, now: Duration) {
        self.map.retain(|_, r| now.saturating_sub(r.issued) < TOKEN_TTL);
    }

    /// 發一個新憑證：同一個動作、同一台電腦只留最新的一個。回憑證（64 個十六進位字元）
    pub fn issue(&mut self, action: Action, node: &str, now: Duration, mut rng: impl FnMut(&mut [u8])) -> String {
        self.prune(now);
        let mut b = [0u8; 32];
        rng(&mut b);
        let challenge = hex_of(&b);
        self.map.remove(&(action, node.to_string()));
        while self.map.len() >= MAX_RECORDS {
            let oldest = self.map.iter().min_by_key(|(_, r)| r.issued).map(|(k, _)| k.clone());
            match oldest {
                Some(k) => {
                    self.map.remove(&k);
                }
                None => break,
            }
        }
        self.map.insert((action, node.to_string()), Rec { hash: hash_hex(&challenge), issued: now });
        challenge
    }

    /// 用憑證：動作、電腦、雜湊都對、沒過期，而且 `marker_taken(雜湊)` 回 true（憑證檔存在並已刪掉）才算數；算數就把紀錄用掉。
    /// 沒過期但憑證檔還沒出現（本人還沒驗證）時紀錄保留，到期才清
    pub fn redeem(&mut self, action: Action, node: &str, challenge: &str, now: Duration, marker_taken: impl FnOnce(&str) -> bool) -> bool {
        self.prune(now);
        let key = (action, node.to_string());
        let hash = hash_hex(challenge);
        match self.map.get(&key) {
            Some(r) if r.hash == hash => {}
            _ => return false,
        }
        if !marker_taken(&hash) {
            return false;
        }
        self.map.remove(&key);
        true
    }

    /// 手機開始看畫面或打字前：看畫面不用憑證（不碰紀錄）；打字要帶 [`Action::Input`] 的憑證並用得掉
    /// （本人剛在這支手機驗證過、沒過期、沒用過），否則回 [`INPUT_NOT_VERIFIED`]
    pub fn gate_start(&mut self, scope: Scope, node: &str, challenge: Option<&str>, now: Duration, marker_taken: impl FnOnce(&str) -> bool) -> Result<(), String> {
        if scope != Scope::Input {
            return Ok(());
        }
        match challenge {
            Some(c) if self.redeem(Action::Input, node, c, now, marker_taken) => Ok(()),
            _ => Err(INPUT_NOT_VERIFIED.to_string()),
        }
    }

    /// 這台電腦被忘記：它的憑證都作廢
    pub fn drop_node(&mut self, node: &str) {
        self.map.retain(|(_, n), _| n != node);
    }

    pub fn len(&self) -> usize {
        self.map.len()
    }
}

fn store() -> &'static Mutex<Store> {
    static S: OnceLock<Mutex<Store>> = OnceLock::new();
    S.get_or_init(|| Mutex::new(Store::default()))
}

fn is_hash(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// 讀出、檢查、刪掉憑證檔，一步做完：檔案要是一般檔案而且刪得掉才回 true（刪不掉當失敗）
pub fn take_marker(data_dir: &Path, hash: &str) -> bool {
    if !is_hash(hash) {
        return false;
    }
    let p = data_dir.join(MARKER_DIR).join(hash);
    if !std::fs::symlink_metadata(&p).is_ok_and(|m| m.is_file()) {
        return false;
    }
    std::fs::remove_file(&p).is_ok()
}

/// 發憑證（亂數取不到回錯誤）
pub fn issue(action: Action, node: &str) -> Result<String, String> {
    let mut failed = false;
    let mut g = store().lock().unwrap_or_else(|e| e.into_inner());
    let c = g.issue(action, node, crate::boottime::now_boot(), |b: &mut [u8]| {
        if getrandom::fill(b).is_err() {
            failed = true;
            b.fill(0);
        }
    });
    if failed {
        // 亂數失敗時剛放進去的紀錄不能留（憑證是全零）
        g.drop_node(node);
        return Err(NO_RANDOM.to_string());
    }
    Ok(c)
}

/// 用憑證：成功回 true（憑證檔已刪、紀錄已用掉）
pub fn redeem(data_dir: &Path, action: Action, node: &str, challenge: &str) -> bool {
    let ok = store().lock().unwrap_or_else(|e| e.into_inner()).redeem(action, node, challenge, crate::boottime::now_boot(), |h| take_marker(data_dir, h));
    // 說明檔用不到了：不管成不成功都收掉
    if is_hash(&hash_hex(challenge)) {
        let _ = std::fs::remove_file(desc_path(data_dir, &hash_hex(challenge)));
    }
    ok
}

/// 手機開始打字前用憑證（[`Store::gate_start`]）：看畫面直接過；打字要用得掉憑證，說明檔不管成不成功都收掉
pub fn gate_start(data_dir: &Path, scope: Scope, node: &str, challenge: Option<&str>) -> Result<(), String> {
    if scope != Scope::Input {
        return Ok(());
    }
    let r = store().lock().unwrap_or_else(|e| e.into_inner()).gate_start(scope, node, challenge, crate::boottime::now_boot(), |h| take_marker(data_dir, h));
    if let Some(c) = challenge {
        let _ = std::fs::remove_file(desc_path(data_dir, &hash_hex(c)));
    }
    r
}

/// 生物辨識框上的字最多幾個字
pub const DESC_MAX: usize = 60;
/// 外殼確認框上名字最多顯示幾個字（外殼 DESC_MAX 60 字的限制；設備名本身最多 40 字，框上截短，指紋永遠在後面）
const NAME_SHOW_MAX: usize = 32;
/// 說明檔的副檔名：`<consent>/<憑證雜湊>.desc`
pub const DESC_EXT: &str = "desc";

fn desc_path(data_dir: &Path, hash: &str) -> std::path::PathBuf {
    data_dir.join(MARKER_DIR).join(format!("{hash}.{DESC_EXT}"))
}

/// 框上顯示的電腦名字：後台的設備名（#1388：每台只有一個名字，本人可以從任一台改）。名字不可信，所以框上一律緊接指紋；
/// 像指紋或含「指紋」的名字回空字串（＝「未命名的電腦」＋指紋）。判斷在 device_id.rs，這裡轉呼叫
pub fn prompt_name(peer: &crate::device_id::KnownPeer) -> &str {
    crate::device_id::owner_given_name(peer)
}

/// 框上要寫的字（純函式）：動作＋本人取的名字（沒有就「未命名的電腦」，去掉控制字元與改變文字方向的字元、最多 32 字）＋指紋前兩組。
/// 指紋永遠在最後、不會被截掉：名字先處理好長度，再用組合的方式接上；網頁給的字一律不進來。
/// 最長 2＋34＋1＋9＋1＝47 字，小於外殼的 DESC_MAX（60）
pub fn describe(action: Action, local_name: &str, fp_grouped: &str) -> String {
    let cleaned: String = crate::device_id::clean_owner_name(local_name).chars().take(NAME_SHOW_MAX).collect();
    let name = if cleaned.trim().is_empty() { "未命名的電腦".to_string() } else { format!("「{}」", cleaned.trim()) };
    let fp: String = fp_grouped.chars().filter(|c| !c.is_control()).take(9).collect();
    match action {
        Action::Confirm => format!("記住{name}（{fp}）"),
        Action::Forget => format!("忘記{name}（{fp}）"),
        // 掃 QR code：最長 2＋34＋3＋1＋9＋1＝50 字，指紋一樣固定在最後
        Action::Scan => format!("核對{name}的指紋（{fp}）"),
        // 開始打字：最長 2＋34＋2＋1＋9＋1＝49 字
        Action::Input => format!("在{name}打字（{fp}）"),
    }
}

/// 可以收掉的舊檔：說明檔（.desc）、掃描暫存（.scan）、沒人來兌換的憑證檔（64 個十六進位字元、沒有副檔名）
fn stale_kind(p: &Path) -> bool {
    match p.extension() {
        Some(x) => x == DESC_EXT || x == "scan",
        None => p.file_name().and_then(|n| n.to_str()).is_some_and(is_hash),
    }
}

/// 發憑證時把框上要寫的字存起來（外殼用憑證的雜湊來讀；沒有這個檔外殼就不跳框）。順手清掉放太久的舊說明檔、舊憑證檔與 .scan 暫存
pub fn write_desc(data_dir: &Path, challenge: &str, text: &str) -> Result<(), String> {
    let dir = data_dir.join(MARKER_DIR);
    std::fs::create_dir_all(&dir).map_err(|e| format!("建不了資料夾：{e}"))?;
    if let Ok(rd) = std::fs::read_dir(&dir) {
        for e in rd.flatten() {
            let p = e.path();
            let old = e.metadata().ok().and_then(|m| m.modified().ok()).and_then(|t| t.elapsed().ok()).is_some_and(|d| d > TOKEN_TTL * 4);
            if old && stale_kind(&p) {
                let _ = std::fs::remove_file(&p);
            }
        }
    }
    std::fs::write(desc_path(data_dir, &hash_hex(challenge)), text).map_err(|e| format!("寫不出說明：{e}"))
}

/// 掃描檔的副檔名：`<consent>/<憑證雜湊>.scan`，內容是相機掃到的字（UTF-8）。只有外殼在本人驗證通過的那一刻寫，Rust 不寫
pub const SCAN_EXT: &str = "scan";
/// 掃到的字最多幾個字元（和 fp_scan::MAX_LEN 一樣）；外殼寫入時也照這個截
pub const SCAN_MAX: usize = 200;
/// 掃描檔最多幾個位元組（200 個字元最多 800 位元組）
const SCAN_BYTES_MAX: u64 = 1024;

/// 讀出並刪掉掃描檔，一步做完：一般檔案、大小合理、刪得掉、是 UTF-8 且不超過上限才回內容；刪不掉當失敗（不回內容）
pub fn take_scan(data_dir: &Path, challenge: &str) -> Option<String> {
    let hash = hash_hex(challenge);
    if !is_hash(&hash) {
        return None;
    }
    let p = data_dir.join(MARKER_DIR).join(format!("{hash}.{SCAN_EXT}"));
    let small = std::fs::symlink_metadata(&p).is_ok_and(|m| m.is_file() && m.len() <= SCAN_BYTES_MAX);
    if !small {
        // 太大或不是一般檔案的，能刪就刪，不讀
        if std::fs::symlink_metadata(&p).is_ok() {
            let _ = std::fs::remove_file(&p);
        }
        return None;
    }
    let bytes = std::fs::read(&p).ok();
    if std::fs::remove_file(&p).is_err() {
        return None;
    }
    let text = String::from_utf8(bytes?).ok()?;
    if text.chars().count() > SCAN_MAX {
        return None;
    }
    Some(text)
}

pub fn drop_node(node: &str) {
    store().lock().unwrap_or_else(|e| e.into_inner()).drop_node(node)
}

#[cfg(test)]
mod tests {
    const FPG: &str = "a93c c519 1f2e 3b4d";

    fn peer(name: &str, owner: bool) -> crate::device_id::KnownPeer {
        let j = serde_json::json!({ "node": "n", "name": name, "sign_pub": "pk", "first_seen_ms": 1, "named_by_owner": owner });
        serde_json::from_value(j).unwrap()
    }

    #[test]
    fn 框上的字_動作加本人取的名字加指紋前兩組_沒有名字寫未命名_控制字元和方向字元去掉() {
        assert_eq!(describe(Action::Confirm, "工作機", FPG), "記住「工作機」（a93c c519）");
        assert_eq!(describe(Action::Forget, "", FPG), "忘記未命名的電腦（a93c c519）");
        assert_eq!(describe(Action::Confirm, "甲\n乙", FPG), "記住「甲 乙」（a93c c519）");
        let s = describe(Action::Confirm, "甲\u{202e}乙\u{2066}丙", FPG);
        assert!(!s.contains('\u{202e}') && !s.contains('\u{2066}'), "{s}");
    }

    #[test]
    fn 框上的字_名字很長也不會截掉指紋_名字最多三十二字_總長不超過外殼上限() {
        let s = describe(Action::Forget, &"長".repeat(200), FPG);
        assert!(s.ends_with("（a93c c519）"), "{s}");
        assert!(s.chars().count() <= DESC_MAX);
        let name_part = s.strip_prefix("忘記「").unwrap().strip_suffix("」（a93c c519）").unwrap();
        assert_eq!(name_part.chars().count(), 32);
        // 最長的一種：32 字名字、忘記／記住
        for act in [Action::Confirm, Action::Forget] {
            let s = describe(act, &"長".repeat(500), "a93c c519 1f2e 3b4d");
            assert!(s.chars().count() <= DESC_MAX, "{}", s.chars().count());
            assert!(s.ends_with("（a93c c519）"));
        }
        assert!(DESC_MAX >= 2 + 2 + 32 + 1 + 9 + 1);
    }

    #[test]
    fn 框上的字_名字裡假冒的指紋改不了最後真的那一組() {
        let s = describe(Action::Confirm, "甲」（a93c c519）記住「乙（0000 1111）", FPG);
        assert!(s.ends_with("（a93c c519）"), "{s}");
        let name_part = s.strip_prefix("記住「").unwrap().strip_suffix("」（a93c c519）").unwrap();
        assert!(name_part.chars().count() <= 32, "{name_part}");
        let s2 = describe(Action::Confirm, &format!("{}（0000 1111）", "甲".repeat(40)), FPG);
        assert!(s2.ends_with("（a93c c519）") && s2.chars().count() <= DESC_MAX, "{s2}");
    }

    #[test]
    fn 框上的名字_用後台的設備名_像指紋的當未命名() {
        assert_eq!(prompt_name(&peer("工作機", true)), "工作機");
        assert_eq!(prompt_name(&peer("工作機", false)), "工作機", "舊的本機小名旗標不再影響");
        assert_eq!(prompt_name(&peer("a93cc519", false)), "");
        let t = describe(Action::Confirm, prompt_name(&peer("我的指紋 a93c c519", false)), FPG);
        assert_eq!(t, "記住未命名的電腦（a93c c519）");
    }

    #[test]
    fn 舊檔收掉_說明檔_掃描暫存_沒兌換的憑證檔都收_名字不合的不碰() {
        let d = tempfile::tempdir().unwrap();
        let dir = d.path().join(MARKER_DIR);
        std::fs::create_dir_all(&dir).unwrap();
        assert!(stale_kind(&dir.join(format!("{}.desc", hash_hex("a")))));
        assert!(stale_kind(&dir.join("x.scan")));
        assert!(stale_kind(&dir.join(hash_hex("b"))));
        assert!(!stale_kind(&dir.join("readme")) && !stale_kind(&dir.join("x.txt")));
    }

    #[test]
    fn 說明檔_以憑證雜湊命名_兌換後收掉() {
        let dir = std::env::temp_dir().join(format!("asn-consent-desc-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let ch = "ab".repeat(32);
        write_desc(&dir, &ch, "記住「甲」（a93c c519）").unwrap();
        let p = dir.join(MARKER_DIR).join(format!("{}.{DESC_EXT}", hash_hex(&ch)));
        assert_eq!(std::fs::read_to_string(&p).unwrap(), "記住「甲」（a93c c519）");
        assert!(!redeem(&dir, Action::Confirm, "沒發過", &ch));
        assert!(!p.exists(), "兌換（不論成敗）後說明檔收掉");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn 掃描動作_框上的字_動作代號() {
        assert_eq!(Action::parse("scan"), Some(Action::Scan));
        assert_eq!(Action::parse("Scan"), None);
        assert_eq!(describe(Action::Scan, "工作機", "a93c c519 1f2e 3b4d"), "核對「工作機」的指紋（a93c c519）");
        assert_eq!(describe(Action::Scan, "", "a93c c519 1f2e 3b4d"), "核對未命名的電腦的指紋（a93c c519）");
    }

    #[test]
    fn 掃描檔_讀出就刪掉_只能一次_太大_不是檔案_不是文字_名字不合格都不給() {
        let d = tempfile::tempdir().unwrap();
        let dir = d.path().join(MARKER_DIR);
        std::fs::create_dir_all(&dir).unwrap();
        let ch = "cd".repeat(32);
        let p = dir.join(format!("{}.{SCAN_EXT}", hash_hex(&ch)));
        assert_eq!(take_scan(d.path(), &ch), None, "還沒有檔");
        std::fs::write(&p, "asn-fp:v1:pc:a93cc5191f2e3b4d").unwrap();
        assert_eq!(take_scan(d.path(), &ch).as_deref(), Some("asn-fp:v1:pc:a93cc5191f2e3b4d"));
        assert!(!p.exists(), "已刪掉");
        assert_eq!(take_scan(d.path(), &ch), None, "只能一次");
        std::fs::write(&p, "x".repeat(SCAN_MAX + 1)).unwrap();
        assert_eq!(take_scan(d.path(), &ch), None, "超過字數上限");
        assert!(!p.exists(), "超過上限也收掉");
        std::fs::write(&p, "y".repeat(2000)).unwrap();
        assert_eq!(take_scan(d.path(), &ch), None, "檔案太大不讀");
        assert!(!p.exists());
        std::fs::write(&p, [0xffu8, 0xfe, 0x00]).unwrap();
        assert_eq!(take_scan(d.path(), &ch), None, "不是 UTF-8");
        assert!(!p.exists());
        std::fs::create_dir_all(&p).unwrap();
        assert_eq!(take_scan(d.path(), &ch), None, "資料夾不算");
        std::fs::remove_dir_all(&p).unwrap();
        // 憑證字串的格式不管：取的是它的雜湊，不能用它組出別的路徑
        for bad in ["", "../x", "ABC"] {
            assert_eq!(take_scan(d.path(), bad), None, "{bad:?}");
        }
    }

    use super::*;

    /// 不同的種子一定給不同的序列
    fn rng(seed: u64) -> impl FnMut(&mut [u8]) {
        let mut s = (seed << 1) | 1;
        move |buf: &mut [u8]| {
            for b in buf.iter_mut() {
                s ^= s << 13;
                s ^= s >> 7;
                s ^= s << 17;
                *b = (s >> 24) as u8;
            }
        }
    }

    fn at(base: Duration, ms: u64) -> Duration {
        base + Duration::from_millis(ms)
    }

    #[test]
    fn 開始打字_沒有憑證拒絕_用過拒絕_過期拒絕_看畫面不受影響() {
        use crate::view_handshake::Scope;
        let t = Duration::from_secs(1000);
        let mut s = Store::default();
        assert_eq!(Action::parse("input"), Some(Action::Input));
        assert_eq!(describe(Action::Input, "工作機", FPG), "在「工作機」打字（a93c c519）");
        // 沒帶憑證
        assert_eq!(s.gate_start(Scope::Input, "pc", None, t, |_| true).err().unwrap(), INPUT_NOT_VERIFIED);
        // 本人還沒驗證（憑證檔沒出現）：不算，紀錄留著
        let c = s.issue(Action::Input, "pc", t, rng(20));
        assert_eq!(s.gate_start(Scope::Input, "pc", Some(&c), at(t, 1), |_| false).err().unwrap(), INPUT_NOT_VERIFIED);
        // 驗證過：過，而且只能用一次
        assert!(s.gate_start(Scope::Input, "pc", Some(&c), at(t, 2), |h| h == hash_hex(&c)).is_ok());
        assert_eq!(s.gate_start(Scope::Input, "pc", Some(&c), at(t, 3), |_| true).err().unwrap(), INPUT_NOT_VERIFIED, "用過就不算");
        // 過期
        let c2 = s.issue(Action::Input, "pc", t, rng(21));
        assert_eq!(s.gate_start(Scope::Input, "pc", Some(&c2), t + TOKEN_TTL, |_| true).err().unwrap(), INPUT_NOT_VERIFIED, "到期就不算");
        // 別的動作、別台的憑證不算
        let c3 = s.issue(Action::Confirm, "pc", t, rng(22));
        assert!(s.gate_start(Scope::Input, "pc", Some(&c3), at(t, 1), |_| true).is_err());
        let c4 = s.issue(Action::Input, "pc2", t, rng(23));
        assert!(s.gate_start(Scope::Input, "pc", Some(&c4), at(t, 1), |_| true).is_err());
        assert!(s.gate_start(Scope::Input, "pc2", Some(&c4), at(t, 1), |_| true).is_ok(), "那台自己的照常");
        // 看畫面：不用憑證、不碰紀錄與憑證檔
        let c5 = s.issue(Action::Input, "pc", at(t, 5), rng(24));
        let before = s.len();
        assert!(s.gate_start(Scope::View, "pc", None, at(t, 6), |_| panic!("看畫面不碰憑證檔")).is_ok());
        assert!(s.gate_start(Scope::View, "pc", Some("亂寫"), at(t, 6), |_| panic!("看畫面不碰憑證檔")).is_ok());
        assert_eq!(s.len(), before, "看畫面不用掉打字的憑證");
        assert!(s.gate_start(Scope::Input, "pc", Some(&c5), at(t, 7), |_| true).is_ok());
    }

    #[test]
    fn 開始打字_憑證檔要真的在_用過就刪掉() {
        use crate::view_handshake::Scope;
        let dir = tempfile::tempdir().unwrap();
        let t = Duration::from_secs(1000);
        let mut s = Store::default();
        let c = s.issue(Action::Input, "pc", t, rng(30));
        let take = |h: &str| take_marker(dir.path(), h);
        assert!(s.gate_start(Scope::Input, "pc", Some(&c), at(t, 1), take).is_err(), "憑證檔還沒寫：不算");
        std::fs::create_dir_all(dir.path().join(MARKER_DIR)).unwrap();
        std::fs::write(dir.path().join(MARKER_DIR).join(hash_hex(&c)), b"").unwrap();
        assert!(s.gate_start(Scope::Input, "pc", Some(&c), at(t, 2), take).is_ok());
        assert!(!dir.path().join(MARKER_DIR).join(hash_hex(&c)).exists(), "用掉就刪");
    }

    #[test]
    fn 雜湊_和標準答案一致_小寫六十四碼() {
        assert_eq!(hash_hex("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
        assert!(is_hash(&hash_hex("x")));
        assert!(!is_hash("ABC") && !is_hash(&"g".repeat(64)) && !is_hash("../x"));
    }

    #[test]
    fn 發憑證_六十四個十六進位字元_不同種子不同_同一個動作同一台只留最新() {
        let t = Duration::from_secs(1000);
        let mut s = Store::default();
        let a = s.issue(Action::Confirm, "pc", t, rng(1));
        assert!(is_hash(&a));
        let b = s.issue(Action::Confirm, "pc", at(t, 5), rng(2));
        assert_ne!(a, b);
        assert_eq!(s.len(), 1);
        assert!(!s.redeem(Action::Confirm, "pc", &a, at(t, 6), |_| true), "舊的憑證作廢");
        assert!(s.redeem(Action::Confirm, "pc", &b, at(t, 6), |_| true));
    }

    #[test]
    fn 用憑證_動作和電腦都要對_只能用一次_三十秒內() {
        let t = Duration::from_secs(1000);
        let mut s = Store::default();
        let c = s.issue(Action::Forget, "pc", t, rng(3));
        assert!(!s.redeem(Action::Confirm, "pc", &c, at(t, 1), |_| true), "動作不對");
        assert!(!s.redeem(Action::Forget, "pc2", &c, at(t, 1), |_| true), "電腦不對");
        assert!(!s.redeem(Action::Forget, "pc", "0000", at(t, 1), |_| true), "憑證不對");
        assert!(s.redeem(Action::Forget, "pc", &c, at(t, 29_999), |_| true));
        assert!(!s.redeem(Action::Forget, "pc", &c, at(t, 30_000), |_| true), "用過就沒了");
        let c = s.issue(Action::Forget, "pc", t, rng(4));
        assert!(!s.redeem(Action::Forget, "pc", &c, t + TOKEN_TTL, |_| true), "剛好到期算過期");
        assert_eq!(s.len(), 0);
    }

    #[test]
    fn 憑證檔沒出現或刪不掉_不算數_紀錄還在_出現了才算並用掉() {
        let t = Duration::from_secs(1000);
        let mut s = Store::default();
        let c = s.issue(Action::Confirm, "pc", t, rng(5));
        assert!(!s.redeem(Action::Confirm, "pc", &c, at(t, 1), |_| false));
        assert_eq!(s.len(), 1, "本人還沒驗證，紀錄保留");
        assert!(s.redeem(Action::Confirm, "pc", &c, at(t, 2), |h| h == hash_hex(&c)));
        assert_eq!(s.len(), 0);
    }

    #[test]
    fn 數量有上限_忘記一台它的憑證都作廢() {
        let t = Duration::from_secs(1000);
        let mut s = Store::default();
        let first = s.issue(Action::Confirm, "n0", t, rng(10));
        for i in 1..(MAX_RECORDS as u64 + 5) {
            s.issue(Action::Confirm, &format!("n{i}"), at(t, i), rng(10 + i));
        }
        assert_eq!(s.len(), MAX_RECORDS);
        assert!(!s.redeem(Action::Confirm, "n0", &first, at(t, 100), |_| true), "最舊的被丟掉");
        let a = s.issue(Action::Confirm, "x", at(t, 200), rng(900));
        s.issue(Action::Forget, "x", at(t, 200), rng(901));
        s.drop_node("x");
        assert!(!s.redeem(Action::Confirm, "x", &a, at(t, 201), |_| true));
    }

    #[test]
    fn 憑證檔_存在才算_刪掉_再用就沒有_不是一般檔案或名字不合格都不算() {
        let d = tempfile::tempdir().unwrap();
        let dir = d.path().join(MARKER_DIR);
        std::fs::create_dir_all(&dir).unwrap();
        let h = hash_hex("c1");
        assert!(!take_marker(d.path(), &h), "還沒有檔");
        std::fs::write(dir.join(&h), "1").unwrap();
        assert!(take_marker(d.path(), &h));
        assert!(!dir.join(&h).exists(), "已刪掉");
        assert!(!take_marker(d.path(), &h), "只能用一次");
        std::fs::create_dir_all(dir.join(&h)).unwrap();
        assert!(!take_marker(d.path(), &h), "資料夾不算");
        let short = "a".repeat(63);
        for bad in ["", "../device_known.json", "ABCDEF", short.as_str()] {
            assert!(!take_marker(d.path(), bad), "{bad:?}");
        }
    }

    #[test]
    fn 只有主畫面視窗() {
        assert!(label_ok("list"));
        assert!(!label_ok("chat-x") && !label_ok("") && !label_ok("List"));
        let conf = std::fs::read_to_string(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tauri.android.conf.json")).unwrap();
        assert!(conf.contains(&format!("\"label\": \"{MAIN_LABEL}\"")), "手機的主視窗代號");
    }

    #[test]
    fn 守門_資料夾位置和外殼一致_沒有檔案外掛也沒開檔案權限() {
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
        assert_eq!(crate::datadir::FALLBACK_NAME, ".irori-asn", "手機的 data_dir 是 filesDir 底下的這個資料夾");
        let kt = std::fs::read_to_string(root.join("gen/android/app/src/main/java/tw/yooliang/asn/ViewerConfirm.kt")).unwrap().replace("\r\n", "\n");
        assert!(kt.contains(&format!("\"{}/{}\"", crate::datadir::FALLBACK_NAME, MARKER_DIR)), "外殼寫在 filesDir/.irori-asn/consent");
        let cargo = std::fs::read_to_string(root.join("Cargo.toml")).unwrap();
        assert!(!cargo.contains("tauri-plugin-fs"), "不能有檔案外掛：網頁不能自己寫憑證檔");
        let caps = std::fs::read_dir(root.join("capabilities")).unwrap().flatten().map(|e| std::fs::read_to_string(e.path()).unwrap()).collect::<String>();
        assert!(!caps.contains("\"fs:") && !caps.contains("fs:default") && !caps.contains("plugin-fs"), "權限清單不能開檔案存取");
    }

    fn body_of<'a>(code: &'a str, name: &str) -> &'a str {
        let at = code.find(&format!("pub fn {name}(")).or_else(|| code.find(&format!("pub async fn {name}("))).unwrap_or_else(|| panic!("找不到 {name}"));
        code[at..].split("\n}\n").next().unwrap()
    }

    #[test]
    fn 守門_確認與忘記都先用憑證才動手_只有主畫面視窗_憑證只被這幾個命令碰() {
        let rs = std::fs::read_to_string(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src").join("android.rs")).unwrap().replace("\r\n", "\n");
        let code = rs.split("\n#[cfg(test)]").next().unwrap();
        let confirm = body_of(code, "android_known_confirm");
        let (t, r, c) = (confirm.find("take_passed(").unwrap(), confirm.find("consent::redeem(").expect("確認要先用憑證"), confirm.find("live::confirm(").unwrap());
        assert!(t < r && r < c, "先取走過關的題目、再用憑證、最後才記住");
        assert!(confirm.contains("Action::Confirm"));
        let forget = body_of(code, "android_known_forget");
        assert!(forget.find("consent::redeem(").expect("忘記要先用憑證") < forget.find("live::forget(").unwrap(), "先用憑證才忘記");
        assert!(forget.contains("Action::Forget"));
        for name in ["android_known_token", "android_known_confirm", "android_known_forget", "android_known_rename", "android_known_scan_confirm"] {
            let b = body_of(code, name);
            assert!(b.contains("label_ok(window.label())"), "{name} 要檢查視窗代號");
            let head = &code[code.find(&format!("pub fn {name}(")).or_else(|| code.find(&format!("pub async fn {name}("))).unwrap()..];
            assert!(head.split(')').next().unwrap().contains(concat!("window: tau", "ri::WebviewWindow")), "{name} 要收視窗");
        }
        for (i, _) in code.match_indices("consent::") {
            let before = &code[..i];
            // 比照 device_id.rs 的 owner_at：async 的命令也要認得
            let (start, len) = ["\npub async fn ", "\npub fn "].iter().filter_map(|p| before.rfind(p).map(|at| (at, p.len()))).max().unwrap();
            let owner: String = before[start + len..].chars().take_while(|c| c.is_alphanumeric() || *c == '_').collect();
            assert!(["android_known_token", "android_known_confirm", "android_known_forget", "android_known_rename", "android_known_scan_confirm", "term_view_remote_start"].contains(&owner.as_str()), "{owner} 不能碰憑證");
        }
        // 開始打字（#1378）：先檢查視窗、用掉 input 憑證，才發起；憑證由參數帶進來，沒有「已驗證」這類布林參數
        let at = code.find("pub async fn term_view_remote_start(").expect("有手機的發起");
        let start = code[at..].split("\n}\n").next().unwrap();
        let sig = start.split(") ->").next().unwrap();
        assert!(sig.contains("challenge: Option<String>") && !sig.contains("bool"), "{sig}");
        let g = start.find("consent::gate_start(").expect("發起前用掉打字的憑證");
        assert!(start.find("consent::label_ok(window.label())").expect("要檢查視窗") < g);
        for later in ["relay_of(", "view_d::start_view("] {
            assert!(g < start.find(later).unwrap(), "先用憑證，再 {later}");
        }
        for name in ["android_known_challenge", "android_known_answer", "android_known_list"] {
            assert!(!body_of(code, name).contains("consent::"), "{name}");
        }
        // 掃描確認：先用憑證（本人驗證過）、再讀出並刪掉掃到的字，最後才記住或擋住；掃到的字不從畫面來（沒有字串參數以外的內容）
        let scan = body_of(code, "android_known_scan_confirm");
        let (r, t) = (scan.find("consent::redeem(").expect("掃描要先用憑證"), scan.find("consent::take_scan(").expect("要讀出掃到的字"));
        assert!(r < t, "先用憑證、再讀掃到的字");
        assert!(scan.contains("Action::Scan") && scan.contains("fp_scan::run("));
        let sig = code[code.find("pub fn android_known_scan_confirm(").unwrap()..].split(") ->").next().unwrap();
        assert!(sig.contains("challenge: String") && !sig.contains("bool") && !sig.contains("text"), "不收掃到的字：{sig}");
        // 確認、忘記、改名的畫面命令不收「已驗證」這類布林參數：驗證只認憑證檔
        for name in ["android_known_confirm", "android_known_forget"] {
            let head = &code[code.find(&format!("pub fn {name}(")).unwrap()..];
            let sig = head.split(") ->").next().unwrap();
            assert!(sig.contains("challenge: String") && !sig.contains("bool"), "{name}：{sig}");
        }
    }

    #[test]
    fn 守門_這裡不寫日誌_不發事件_不寫憑證檔_正式程式不當掉() {
        let src = std::fs::read_to_string(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src").join("consent.rs")).unwrap().replace("\r\n", "\n");
        let code = src.split("\n#[cfg(test)]").next().unwrap();
        for bad in ["elog!", "olog!", concat!("print", "ln!"), concat!("db", "g!"), "log::", "tracing::", "emit(", "ui_log", "File::create", "OpenOptions", ".unwrap()", ".expect("] {
            assert!(!code.contains(bad), "consent.rs 不能有：{bad}");
        }
        // 只寫一種檔：框上的說明檔（`<雜湊>.desc`）。憑證檔（記號）只有外殼在驗證通過時寫，Rust 一律不寫
        assert_eq!(code.matches("fs::write(").count(), 1, "只有寫說明檔那一處");
        let w = &code[code.find("fs::write(").unwrap()..];
        assert!(w.starts_with("fs::write(desc_path(data_dir, &hash_hex(challenge)), text)"), "只能寫說明檔：{}", &w[..w.find('\n').unwrap_or(w.len())]);
    }
}

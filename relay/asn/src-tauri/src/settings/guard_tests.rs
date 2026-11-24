//! #2162 ⑨、#2232 A：Rust 守門。擋住「新增私有的 json 讀寫」與「另寫一份原子寫入」。
//!
//! 【這是靠規則抓的守門】用字樣（`.json` 加上讀寫檔動作、`fn write_atomic`、`.tmp"`）去比對，不是型別或語意檢查；
//! 不保證抓得到所有私有讀寫，漏網的靠審查補。切掉測試碼用的是 `settings/src_scan.rs`（真的數大括號、
//! 由 `#[cfg(test)] mod x;` 反推外部測試檔）；計數按「出現次數」算，同一行兩處就是兩次。
//!
//! 已知的限制（#2232 B 要處理）：
//! 1. 讀寫動作只認 `read_to_string`／`fs::write`／`File::create`／`OpenOptions`；`File::open`、`fs::read(`、
//!    `from_reader`／`to_writer`、`fs::copy`、`fs::rename`、`use std::fs::write;` 之後的 `write(` 不在內。
//! 2. 錯誤訊息文字裡提到檔名也會被當成一處（寧可多算）；`with_extension("json")` 數不到。檔名放在 const（例如 `KNOWN_FILE = "device_known.json"`）、用 `with_extension("json")` 或 `format!` 組出來時，
//!    只靠「`.json` 與動作在前後一行內」抓不到。
//! 3. 原子寫入只認三個函式名與 `.tmp"`；暫存檔改 `.part`／`.new`／`.bak`、`NamedTempFile`／`persist`、
//!    自己取別的函式名都繞得過。
//! 4. 只掃 `src-tauri/src`，不含 `build.rs` 與其他 crate。
//! 5. 巨集展開出來的程式、`cfg_attr`、`#[cfg(any(test, …))]` 都當正式碼，不特別處理。
//!    例：procscan.rs 的 fake_proc_tests，因為 cfg 裡含 `not(`／`any(`，被當成正式碼掃（不影響結果，只是多掃）。
//! 6. 切割時結構不完整（找不到結尾）會直接 panic 並指出檔名與行號，不會悄悄當成整檔都是測試碼。
//!
//! 兩份待搬／例外清單的規則比照 `test/invoke-exit.test.mjs`：次數只准變少、不准變多；
//! 變少時清單也要同步改，否則一樣紅（讓清單只會縮、不會留著過期的空白支票）。
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use super::src_scan::{prod_files, strip_comments};

const HOW_TO: &str = "新增的設定請走 settings::（Doc，或 load_text／save_text）；狀態、佇列、快取類請用 settings::atomic::write(STATE／QUEUE)；\
真的需要例外，請在 guard_tests.rs 的對應清單加一行（檔、次數）並寫理由。";

/// 私有 json 讀寫：目前還允許的檔與次數（次數＝「`.json` 字樣出現幾次；該處同行或前後一行有讀寫檔動作」，同一行兩處算兩次）。
/// 分類依 #2162 A-3：乙組＝使用者手寫、外部程式要讀；丙組＝狀態、佇列、計數、快取、產生檔、憑證類，明確不搬進設定層。
/// 「待搬」＝設定類但還沒搬。
const PENDING_JSON: &[(&str, usize)] = &[
    // ---- 讀外部程式（Claude／Codex／Grok／Pi）自己維護的檔：不是 ASN 的設定，格式由對方決定，不搬 ----
    ("bridge/engines/codex_state.rs", 1), // 讀 Codex 的 session_index.jsonl（唯讀）
    ("bridge/engines/grok_adopt.rs", 2),  // 讀 Grok 的 ~/.grok/active_sessions.json（唯讀）；第 2 處是同一行錯誤訊息文字裡提到檔名（#2232 A 改按出現次數後多算，不是第二次讀寫）
    ("bridge/partner_ops.rs", 2),         // 讀 Claude 的 sessions/<pid>.json 與外掛狀態檔、寫外掛要讀的 control 檔（外部程式要讀的檔）
    ("bridge/roster.rs", 1),              // 讀 Claude 的 sessions/<pid>.json 與外掛狀態檔（唯讀）
    ("claude_mod.rs", 1),                 // 讀自家外掛包的 plugin.json（隨安裝包、唯讀）
    ("cli/caller.rs", 1),                 // 讀 Claude 的 sessions/<pid>.json 找呼叫者（唯讀）
    ("codex_accounts.rs", 1),             // 讀 Codex 的 auth.json（外部程式的憑證，唯讀）
    ("launch/cwds.rs", 1),                // 讀 ~/.claude.json 的 projects 當候選（唯讀；launch-prefs.json 本身走共用層，計數仍是 0）
    ("launch/pi.rs", 1),                  // 讀 pi 的 settings.json 看有沒有裝擴充（唯讀）
    ("launch/pi_setup.rs", 1),            // 讀 pi 的 settings.json（唯讀；pi-auto.json 本身走共用層）
    ("launch/term.rs", 1),                // 讀 Claude 外掛寫的 <sid>.json 狀態檔（唯讀）
    ("statusline_restore.rs", 2),         // 讀寫使用者的 ~/.claude/settings.json 還原狀態列（外部程式的設定，帶備份）
    // ---- 丙組：狀態、佇列、游標、產生檔（程式自己產生，不是使用者選的設定）----
    ("bridge/engines/pi_control.rs", 1),  // pi-control 請求／結果佇列（給 pi 擴充讀；R 丙）
    ("bridge/forward_selftest.rs", 2),    // 自我測試產生的 sender-settings.json、recv-settings.json 兩個檔（給 claude --settings 讀的產生檔，R54；同一行兩處，以前只算一次）
    ("bridge/rooms.rs", 2),                // rooms-held.json（佇列）、rooms-cursor.json（游標，Node 橋共用格式）
];

/// 原子寫入重複實作：目前還允許的檔與次數（`fn write_atomic`／`fn atomic_write`／`fn save_atomic`、自己拼 `.tmp"`）。
const PENDING_ATOMIC: &[(&str, usize)] = &[
    // ---- 轉接函式：本身只是呼叫 settings::atomic::write（沒有自己寫 tmp），為了讓舊呼叫處不用大改而留著 ----
    ("lib.rs", 1),                // crate::write_atomic：轉接到 atomic::write(STATE)
    ("bridge/pending.rs", 1),     // save_atomic：轉接到 atomic::write(QUEUE)
    ("claude_extra.rs", 1),       // write_atomic：轉接到 atomic::write（憑證，私有權限）
    ("claude_json.rs", 1),        // write_atomic：轉接到 atomic::write(SETTINGS)
    ("cli/send_rate.rs", 1),      // write_atomic：轉接到 atomic::write(STATE)
    ("launch/term.rs", 1),        // atomic_write：先建資料夾再轉接到 atomic::write(STATE)，並把錯誤改成白話
    // ---- 不是「寫設定」，只是清掃或另有用途的 .tmp ----
    ("launch/mux.rs", 1),         // 清掉舊心跳檔旁的 .tmp（只刪不寫）
    ("stt.rs", 2),                // 語音模型下載／解壓用的 .tmp 資料夾，整個資料夾換名，不是單一檔案寫入
    ("attach_cache.rs", 3),       // 附件快取的 bin＋meta 成對暫存檔（兩個檔要一起換名，單檔寫入做不到）；第 3 處是清掃殘留 .tmp
    // ---- 金鑰類：刻意不併，維持自己的寫法（建檔就是 0600、檔名帶 pid 與序號，不能經過預設權限）----
    ("device_id.rs", 1),          // 設備金鑰 write_private
    ("secret_file.rs", 2),         // 節點金鑰／login.bin 的暫存檔命名與殘留清掃
];

/// 只有 settings/atomic.rs 可以實作原子寫入。本檔與 src_scan.rs 是 `#[cfg(test)] mod` 宣告的測試檔，已由反推排除，不用列在這裡
const SELF_FILES: &[&str] = &["settings/atomic.rs"];

const JSON_OPS: &[&str] = &["read_to_string", "fs::write", "File::create", "OpenOptions"];
const ATOMIC_PATS: &[&str] = &["fn write_atomic", "fn atomic_write", "fn save_atomic", ".tmp\""];

fn src_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("src")
}

/// (相對路徑, 正式碼文字)：去掉 `#[cfg(test)]` 項目與外部測試檔；註解已拿掉（註解裡寫到字樣不算）
fn prod_sources() -> Vec<(String, String)> {
    prod_files(&src_root()).into_iter().map(|(rel, prod)| (rel, strip_comments(&prod))).collect()
}

fn near_ops(lines: &[&str], i: usize) -> bool {
    let lo = i.saturating_sub(1);
    let hi = (i + 1).min(lines.len() - 1);
    lines[lo..=hi].iter().any(|w| JSON_OPS.iter().any(|op| w.contains(op)))
}

/// 每一處 `.json`（含訊息文字裡提到的檔名，會多算，由清單註解說明），只要同行或前後一行有讀寫檔動作就算一次（同一行兩處算兩次）。傳入的文字要已去掉註解
fn count_json(prod: &str) -> usize {
    let lines: Vec<&str> = prod.lines().collect();
    lines.iter().enumerate().filter(|(i, _)| near_ops(&lines, *i)).map(|(_, l)| l.matches(".json").count()).sum()
}

/// 每一處原子寫入字樣算一次。傳入的文字要已去掉註解
fn count_atomic(prod: &str) -> usize {
    ATOMIC_PATS.iter().map(|p| prod.matches(p).count()).sum()
}

/// 清單比對：實際多於清單 → 紅（新增）；少於清單 → 也紅（要同步改清單）
fn check(kind: &str, actual: &BTreeMap<String, usize>, pending: &[(&str, usize)]) {
    let mut seen = std::collections::BTreeSet::new();
    for (f, _) in pending {
        assert!(seen.insert(*f), "{kind}：清單裡 {f} 出現兩次");
    }
    let mut errs = Vec::new();
    for (f, n) in actual {
        let allow = pending.iter().find(|(p, _)| p == f).map_or(0, |(_, c)| *c);
        if *n > allow {
            errs.push(format!("  {f}：實際 {n} 處，清單只允許 {allow} 處（多了 {}）", n - allow));
        }
    }
    for (f, allow) in pending {
        let n = actual.get(*f).copied().unwrap_or(0);
        if n < *allow {
            errs.push(format!("  {f}：實際只剩 {n} 處，清單還寫 {allow} 處，請把清單改成 {n}（為 0 就整行刪掉）"));
        }
    }
    assert!(errs.is_empty(), "{kind}守門不過：\n{}\n怎麼辦：{HOW_TO}", errs.join("\n"));
}

fn scan(counter: fn(&str) -> usize) -> BTreeMap<String, usize> {
    let mut actual = BTreeMap::new();
    for (rel, prod) in prod_sources() {
        if SELF_FILES.contains(&rel.as_str()) {
            continue;
        }
        let n = counter(&prod);
        if n > 0 {
            actual.insert(rel, n);
        }
    }
    actual
}

#[test]
fn 私有json讀寫只准清單內的檔案且次數只准少() {
    check("私有 json 讀寫", &scan(count_json), PENDING_JSON);
}

#[test]
fn 原子寫入只准在共用層實作且例外次數只准少() {
    check("原子寫入重複實作", &scan(count_atomic), PENDING_ATOMIC);
}

// 甲組（已搬進共用層）的檔案不准留在清單裡，也不准在別處偷偷複製一份私有讀寫
#[test]
fn 已搬進共用層的甲組檔案不在清單且計數為零() {
    let moved = ["launch-prefs", "bridge", "voice", "acct-prefs", "agent-setup-prefs", "quota-readers", "pi-auto", "asn-me", "asn-onboard", "asn-chats"];
    let json_pending: Vec<&str> = PENDING_JSON.iter().map(|(f, _)| *f).collect();
    // 注意 settings.json 這個檔名 pi／Claude 也有，所以不用檔名掃；改查「甲組檔案的擁有者」不在清單
    // （launch/cwds.rs、launch/pi_setup.rs 在清單裡，只因為它們另外唯讀外部程式的檔，已在清單註明）
    for f in ["settings/docs.rs", "settings/raw.rs", "settings/mod.rs", "launch/prefs.rs", "bridge/mod.rs", "voicecfg.rs", "names.rs", "quota_readers.rs", "acct_remote.rs", "agent_setup/switch.rs", "me.rs"] {
        assert!(!json_pending.contains(&f), "{f} 已搬進共用層，不准出現在 PENDING_JSON（次數要是 0）");
    }
    let mut hits = Vec::new();
    for (rel, prod) in prod_sources() {
        if rel.starts_with("settings/") {
            continue;
        }
        let lines: Vec<&str> = prod.lines().collect();
        for (i, l) in lines.iter().enumerate() {
            for m in moved {
                for _ in 0..l.matches(&format!("\"{m}.json\"")).count() * usize::from(near_ops(&lines, i)) {
                    hits.push(format!("{rel}:{} {m}", i + 1));
                }
            }
        }
    }
    assert!(hits.is_empty(), "已搬進共用層的設定檔又出現私有讀寫：{hits:?}\n怎麼辦：{HOW_TO}");
}

#[test]
fn 守門自己的前提() {
    // 切法本身的單元測試在 src_scan.rs；這裡只釘「守門用得到它」與計數的算法
    let s = "fn a() {}
#[cfg(test)]
mod tests {
    fn b() {}
}
fn after() {}
";
    let p = super::src_scan::prod_source(s);
    assert!(p.contains("fn a()") && p.contains("fn after()") && !p.contains("fn b()"), "{p}");
    // 計數：同行、相鄰行算；相隔兩行以上不算；註解不算
    assert_eq!(count_json("let a = std::fs::read_to_string(dir.join(\"x.json\"));"), 1);
    assert_eq!(count_json("let p = dir.join(\"x.json\");
let s = std::fs::read_to_string(&p);"), 1);
    assert_eq!(count_json("let p = dir.join(\"x.json\");
let q = 1;
let r = 2;
let s = std::fs::read_to_string(&p);"), 0);
    assert_eq!(count_json(&strip_comments("// std::fs::write(\"x.json\", \"\")")), 0);
    // 按出現次數：同一行兩處算兩次；相鄰兩行各一處、中間一行有動作，各算一次
    assert_eq!(count_json("let a = std::fs::read_to_string(\"a.json\").or(std::fs::read_to_string(\"b.json\"));"), 2);
    assert_eq!(count_json("let p = \"a.json\";
let s = std::fs::read_to_string(p);
let q = \"b.json\";"), 2);
    assert_eq!(count_atomic("fn write_atomic(p: &Path) {}"), 1);
    assert_eq!(count_atomic("let t = format!(\"{}.tmp\", p); let u = format!(\"{}.tmp\", q);"), 2);
    // 清單比對：變多、變少都要紅
    assert!(std::panic::catch_unwind(|| check("t", &BTreeMap::from([("a.rs".to_string(), 2)]), &[("a.rs", 1)])).is_err());
    assert!(std::panic::catch_unwind(|| check("t", &BTreeMap::from([("a.rs".to_string(), 1)]), &[("a.rs", 2)])).is_err());
    assert!(std::panic::catch_unwind(|| check("t", &BTreeMap::new(), &[("a.rs", 1)])).is_err());
    check("t", &BTreeMap::from([("a.rs".to_string(), 1)]), &[("a.rs", 1)]);
    // 掃描沒掃空；測試檔（由宣告反推）有被排除；account.rs 測試模組之後的正式碼掃得到
    let all = prod_sources();
    assert!(all.iter().any(|(r, p)| r == "settings/raw.rs" && !p.is_empty()));
    assert!(all.iter().all(|(r, _)| r != "settings/guard_tests.rs" && r != "settings/src_scan.rs"));
    let account = &all.iter().find(|(r, _)| r == "account.rs").expect("account.rs 要被掃到").1;
    assert!(!account.contains("fn 帳號名稱驗證"), "account.rs 的測試碼要切掉");
    // 測試模組（約 597 行起）之後的已知正式碼字樣（約 839 行）要在切完的結果裡；尾巴被吞掉就會紅。切法本身的同類前提在 src_scan.rs 的同名結構測試
    assert!(account.contains("pub async fn setup_remote_status("), "account.rs 測試模組後面的正式碼要掃得到");
    let probe = format!("{account}
fn probe() {{ std::fs::write(\"x.json\", \"\"); }}
");
    assert_eq!(count_json(&probe), count_json(account) + 1, "account.rs 尾端加一處私有 json 寫入，計數要多一");
    // 失敗訊息要講怎麼做
    assert!(HOW_TO.contains("settings::") && HOW_TO.contains("清單"));
}

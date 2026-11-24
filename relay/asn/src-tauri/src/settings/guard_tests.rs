//! #2162 ⑨、#2232 A：Rust 守門。擋住「新增私有的 json 讀寫」與「另寫一份原子寫入」。
//!
//! 【這是靠規則抓的守門】用字樣（`.json` 加上讀寫檔動作、`fn write_atomic`、`.tmp"`）去比對，不是型別或語意檢查；
//! 不保證抓得到所有私有讀寫，漏網的靠審查補。切掉測試碼用的是 `settings/src_scan.rs`（真的數大括號、
//! 由 `#[cfg(test)] mod x;` 反推外部測試檔）；計數按「出現次數」算，同一行兩處就是兩次。
//!
//! 已知的限制：
//! 1. 讀寫動作認 `read_to_string`／`fs::write`／`File::create`／`OpenOptions`／`File::open`／`fs::read(`／
//!    `from_reader`／`to_writer`／`fs::copy`／`fs::rename`（#2232 B）；`use std::fs::write;` 之後的 `write(`、
//!    自己包一層的函式名不在內。
//! 2. 檔名：`.json` 字樣，加上「檔內 `const`／`static` 宣告的 `.json` 檔名常數，在動作前後一行內被用到」（#2232 B，
//!    例：`KNOWN_FILE`、`MARKER`）。追不到的寫法：常數放在別的檔再 `use` 進來（只追同一個檔）、`with_extension("json")`、
//!    `format!("{x}.json")`、字串相接、把檔名放進結構欄位再傳來傳去。錯誤訊息文字裡提到檔名也會被當成一處（寧可多算）。
//! 3. 原子寫入認 `fn write_atomic`／`fn atomic_write`／`fn save_atomic`、`.tmp"`、`.part"`、`.new"`、`.tmp.{`、
//!    `with_extension("tmp")`、`NamedTempFile`、`.persist_noclobber(`（#2232 B）。單獨的 `.persist(` 不收：專案裡
//!    `self.persist()` 到處都是（存檔方法），收了全是誤報；暫存檔取別的副檔名（`.bak`、`.swp`）、自己取別的函式名仍繞得過。
//! 4. 只掃 `src-tauri/src`，不含 `build.rs` 與其他 crate。
//! 5. 巨集展開出來的程式、`cfg_attr`、`#[cfg(any(test, …))]` 都當正式碼，不特別處理。
//!    例：procscan.rs 的 fake_proc_tests，因為 cfg 裡含 `not(`／`any(`，被當成正式碼掃（不影響結果，只是多掃）。
//! 6. 切割時結構不完整（找不到結尾）會直接 panic 並指出檔名與行號，不會悄悄當成整檔都是測試碼。
//! 7. 路徑如果經過函式參數或回傳值才傳進讀寫，守門抓不到（只看「檔名字樣」和「讀寫動作」是否在相鄰行）。
//!    例：`launch/config.rs` 在第 16 行組出 launcher.json 的路徑並回傳，到第 63 行起才以參數接手去讀，兩處相隔太遠；agents.json 則是把路徑
//!    交給 `load_workers_config` 處理，實作沒有追進去。這兩個都是使用者手寫、不搬進設定層的檔（乙組），靠審查補。
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
    ("claude_mod.rs", 2),                 // 讀自家外掛包的 plugin.json（隨安裝包、唯讀）；第 2 處是 MARKER_FILE claude-mod.json：外掛安裝標記（#2232 B 常數追蹤新增，狀態）
    ("cli/caller.rs", 1),                 // 讀 Claude 的 sessions/<pid>.json 找呼叫者（唯讀）
    ("codex_accounts.rs", 1),             // 讀 Codex 的 auth.json（外部程式的憑證，唯讀）
    ("launch/cwds.rs", 1),                // 讀 ~/.claude.json 的 projects 當候選（唯讀；launch-prefs.json 本身走共用層，計數仍是 0）
    ("launch/pi.rs", 1),                  // 讀 pi 的 settings.json 看有沒有裝擴充（唯讀）
    ("launch/pi_setup.rs", 1),            // 讀 pi 的 settings.json（唯讀；pi-auto.json 本身走共用層）
    ("launch/term.rs", 1),                // 讀 Claude 外掛寫的 <sid>.json 狀態檔（唯讀）
    ("statusline_restore.rs", 2),         // 讀寫使用者的 ~/.claude/settings.json 還原狀態列（外部程式的設定，帶備份）
    // ---- 丙組：狀態、佇列、游標、產生檔（程式自己產生，不是使用者選的設定）----
    ("bridge/engines/pi_control.rs", 1),  // pi-control 請求／結果佇列（給 pi 擴充讀；R 丙）
    ("bridge/forward_selftest.rs", 3),    // 自我測試產生的 sender-settings.json、recv-settings.json 兩個檔（給 claude --settings 讀的產生檔，R54；同一行兩處，以前只算一次）；第 3 處是 SELFTEST_FILE 常數的讀寫（#2232 B 常數追蹤新增，自我測試結果＝狀態）
    ("bridge/rooms.rs", 2),                // rooms-held.json（佇列）、rooms-cursor.json（游標，Node 橋共用格式）
    // ---- #2232 B 擴大規則（檔名常數、File::open／fs::read／rename 等）新掃出的命中；逐一看過都是狀態／佇列／憑證／標記檔，沒有「設定類該走共用層卻沒走」的，所以沒有「待搬」項 ----
    ("bridge/core/outbox.rs", 1),         // OUTBOX_FILE reply-outbox.json：待重送的回信佇列（丙組）。實際計到的只有 1 處：load_with 裡「改名失敗」那句 log 訊息用到 OUTBOX_FILE，且緊鄰標記檔的 read_to_string；真正讀寫寄件匣的地方是用 file 變數（先 join(OUTBOX_FILE) 再傳），守門追不到（已知限制 7）
    ("bridge/core/upstream_retry.rs", 1), // RETRY_FILE retry-pending.json：上游重試佇列（丙組）
    ("bridge/engines/partner_queue.rs", 1), // PARTNERS_FILE acp-partners.json：ACP 夥伴的登記狀態（丙組）
    ("bridge/forward_gate.rs", 1),        // INFLIGHT_FILE forward-inflight.json：轉交進行中的標記（狀態）
    ("claude_accounts.rs", 9),            // 讀寫 Claude 的 .credentials.json／.claude.json（外部程式的檔）與帳號庫的 account.json／憑證備份（憑證類，明確不搬進設定層；以前檔名在常數裡掃不到）
    ("claude_extra.rs", 1),               // 計到的是 read_dir 裡讀 CREDENTIALS（額外帳號的 .credentials.json 憑證檔，fs::read）1 處；STOPS（claude-extra-stops.json 停用狀態）的路徑經 stops_path 函式回傳才讀，守門沒計到（已知限制 7）；寫入走 atomic::write，不算
    ("cli/send_rate.rs", 2),              // FILE send-rate.json、REFUNDED send-refunded.json：送信頻率計數（計數類，丙組）
    ("datadir.rs", 1),                    // MARKER：資料夾搬遷完成的標記檔（一次性標記，不是設定）
    ("device_id.rs", 1),                  // KNOWN_FILE device_known.json：已知設備清單（狀態；與金鑰同一支，刻意維持自己的寫法）
    ("grok_accounts.rs", 2),              // 讀寫 Grok 的 auth.json 與帳號庫副本（外部程式的憑證檔，憑證類）
    ("home.rs", 1),                       // MARKER：舊資料夾搬遷完成的標記檔（一次性標記）
    ("lastlogin.rs", 1),                  // last-login.json：上次登入的記憶（狀態；寫入已走 atomic::write(STATE)，讀取是直接讀）
    ("launch/auto_resume.rs", 1),         // STATUS_FILE auto-resume.json：自動接回的狀態（狀態）
    ("launch/mux_round.rs", 1),           // RESUME_NOTICE_FILE mux-resume-notice.json：接回通知（狀態）
    ("launch/mux_watch.rs", 2),           // 計到的是 BLIND_FILE（mux-blind.json 盲區紀錄）與 NOTICE_FILE（mux-notice.json 服務停通知）各一處 read_to_string（狀態）；STATE_FILE（mux-resume.json）的路徑由 state_file 函式回傳、以參數傳進讀寫，守門沒計到（已知限制 7）；寫入走 atomic::write，不算
    ("launch/wezterm_fetch.rs", 2),       // STATE_FILE fetch-state.json（wezterm 下載退避紀錄，狀態）的兩處 read_to_string（read_fail 讀失敗種類與時間、read_fail_lib 讀缺少的函式庫名，各一處）；寫入走 atomic::write，不算；隨包的 wezterm-pins.json 是 include_str! 編進來的，不在讀寫動作內，沒有計到
    ("relay.rs", 2),                      // SPOOL_FILE window-spool.json：視窗訊息暫存佇列（佇列，丙組）
];

/// 原子寫入重複實作：目前還允許的檔與次數（`fn write_atomic`／`fn atomic_write`／`fn save_atomic`、自己拼 `.tmp"`）。
const PENDING_ATOMIC: &[(&str, usize)] = &[
    // ---- 轉接函式：本身只是呼叫 settings::atomic::write（沒有自己寫 tmp）。#2232 C 已把 claude_extra、claude_json、cli/send_rate、launch/term 四個改成直接呼叫並刪掉；下面兩個還有呼叫端，留著 ----
    ("lib.rs", 1),                // crate::write_atomic：轉接到 atomic::write(STATE)。仍有約 40 處呼叫（bridge/core.rs 屬 #2161 範圍，其餘分散在 bridge/、guard.rs、acct_remote.rs 等 20 多個檔），待另開單逐一改，改完才能刪
    ("bridge/pending.rs", 1),     // save_atomic：轉接到 atomic::write(QUEUE)。只剩 bridge/core.rs（#2161 範圍）呼叫，待 #2161 一起改；outbox.rs 的三處已在 #2232 C 改成直接呼叫
    // ---- 不是「寫設定」，只是清掃或另有用途的 .tmp ----
    ("launch/mux.rs", 1),         // 清掉舊心跳檔旁的 .tmp（只刪不寫）
    ("stt.rs", 3),                // 語音模型下載／解壓用的 .tmp 資料夾，整個資料夾換名，不是單一檔案寫入；第 3 處是下載到 `.part` 再換名（大檔下載，#2232 B 新增）
    // ---- #2232 B 新掃出的 .part／.new 暫存：都是下載或安裝可執行檔／金鑰輪換，不是寫設定 ----
    ("agent_setup/agy_install.rs", 1),      // agy.exe.new：安裝時先放新版執行檔再換名
    ("agent_setup/verified_install.rs", 2), // 下載到 .part 驗證後換名，與清掃殘留的 .part
    ("android.rs", 1),                      // 下載 apk 到 .part 再換名
    // ---- 金鑰類：刻意不併，維持自己的寫法（建檔就是 0600、檔名帶 pid 與序號，不能經過預設權限）----
    ("device_id.rs", 2),          // 設備金鑰 write_private；第 2 處是同函式的 `.new` 暫存（#2232 B 新增，同一支金鑰寫入）
    ("node_rotate.rs", 1),        // 節點金鑰輪換的 <node>.key.new（金鑰類，同上）
    ("secret_file.rs", 2),         // 節點金鑰／login.bin 的暫存檔命名與殘留清掃
];

/// 只有 settings/atomic.rs 可以實作原子寫入。本檔與 src_scan.rs 是 `#[cfg(test)] mod` 宣告的測試檔，已由反推排除，不用列在這裡
const SELF_FILES: &[&str] = &["settings/atomic.rs"];

const JSON_OPS: &[&str] = &["read_to_string", "fs::write", "File::create", "OpenOptions", "File::open", "fs::read(", "from_reader", "to_writer", "fs::copy", "fs::rename"];
const ATOMIC_PATS: &[&str] = &["fn write_atomic", "fn atomic_write", "fn save_atomic", ".tmp\"", ".part\"", ".new\"", "NamedTempFile", ".persist_noclobber(", "with_extension(\"tmp\")", ".tmp.{"];

/// 找出檔內宣告的「檔名常數」：`const`／`static` 的值裡有 `.json"`（`const NAME: &str = "x.json";`、陣列也算）。
/// 回傳 (常數名, 宣告所在行號 0 起算)。傳入的文字要已去掉註解
fn json_consts(prod: &str) -> Vec<(String, usize)> {
    let b = prod.as_bytes();
    let mut out = Vec::new();
    for kw in ["const ", "static "] {
        for (at, _) in prod.match_indices(kw) {
            if at > 0 && (b[at - 1].is_ascii_alphanumeric() || b[at - 1] == b'_') {
                continue; // 例如 `xconst `
            }
            let rest = &prod[at + kw.len()..];
            let name: String = rest.chars().take_while(|c| c.is_ascii_alphanumeric() || *c == '_').collect();
            if name.is_empty() || !rest[name.len()..].trim_start().starts_with(':') {
                continue; // `const fn`、`static mut` 之類
            }
            // 值從 `=` 之後算到 `;`（型別裡的 `[&str; 2]` 也有分號，所以要先越過 `=`）
            let value = rest.find('=').map_or("", |e| &rest[e..]);
            let stmt = &value[..value.find(';').unwrap_or(value.len())];
            if stmt.contains(".json\"") {
                out.push((name, prod[..at].matches('\n').count()));
            }
        }
    }
    out
}

/// `name` 在 `line` 裡以完整識別字出現幾次
fn word_count(line: &str, name: &str) -> usize {
    let b = line.as_bytes();
    let id = |c: u8| c.is_ascii_alphanumeric() || c == b'_';
    line.match_indices(name).filter(|(at, _)| (*at == 0 || !id(b[at - 1])) && !b.get(at + name.len()).copied().is_some_and(id)).count()
}

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
    let direct: usize = lines.iter().enumerate().filter(|(i, _)| near_ops(&lines, *i)).map(|(_, l)| l.matches(".json").count()).sum();
    // 檔名放在常數（`const NAME: &str = "x.json"`）時，常數在同檔被讀寫動作相鄰的行用到，也算一處（宣告那一行不算）
    let consts = json_consts(prod);
    let via_const: usize = lines.iter().enumerate().filter(|(i, _)| near_ops(&lines, *i)).map(|(i, l)| consts.iter().filter(|(_, decl)| *decl != i).map(|(name, _)| word_count(l, name)).sum::<usize>()).sum();
    direct + via_const
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

// 反例（#2267 一審建議）：這些寫法不該被判成命中；對照的正例確認規則真的有在運作
#[test]
fn 守門的反例不誤判() {
    // 只有宣告那一行、旁邊沒有讀寫動作：不算（宣告不是讀寫）
    assert_eq!(count_json("const F: &str = \"x.json\";"), 0);
    assert_eq!(count_json("const F: &str = \"x.json\";\nfn f() {\n    let a = 1;\n}"), 0);
    // 對照：同一個常數在讀寫動作旁被用到就算 1 處（宣告那行仍不算）
    assert_eq!(count_json("const F: &str = \"x.json\";\nfn f() {\n    let a = 1;\n    let b = 2;\n    let s = std::fs::read_to_string(F);\n}"), 1);
    // self.persist()（存檔方法）不是原子寫入的寫法
    assert_eq!(count_atomic("fn save(&self) {\n    self.persist();\n    self.inner.persist()?;\n}"), 0);
    // 對照：真正的 NamedTempFile 轉正寫法有算
    assert_eq!(count_atomic("let f = tmp.persist_noclobber(&p)?;"), 1);
    // Foo::new" 這類字樣（`::new` 後面接引號）不是 `.new"` 暫存檔名
    assert_eq!(count_atomic("let x = Foo::new\"abc\";"), 0);
    assert_eq!(count_atomic("let x = Foo::new(\"abc\");"), 0);
    // 對照：真的把暫存檔取名成 `.new` 才算
    assert_eq!(count_atomic("let t = format!(\"{}.new\", p);"), 1);
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
    let p = super::src_scan::prod_source_of("守門前提的範例文字", s);
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
    // #2232 B：更多讀寫動作（每個動作字單獨成立）
    for op in ["File::open(&p)", "std::fs::read(&p)", "serde_json::from_reader(f)", "serde_json::to_writer(f, &v)", "std::fs::copy(&p, &q)", "std::fs::rename(&p, &q)"] {
        assert_eq!(count_json(&format!("let p = dir.join(\"x.json\");\nlet r = {op};")), 1, "{op} 要算讀寫動作");
    }
    // 檔名放常數：宣告本身不算、同檔在動作相鄰行的使用才算；沒有動作相鄰就不算；不是 .json 的常數不算
    let c = "const MODELS_FILE: &str = \"models.json\";\nfn f() {\n    let p = dir.join(MODELS_FILE);\n    let s = std::fs::read_to_string(&p);\n}";
    assert_eq!(count_json(c), 1);
    assert_eq!(count_json("const F: &str = \"y.json\";\nfn f() {\n    let a = 1;\n    let b = 2;\n    let s = std::fs::read_to_string(F);\n}"), 1);
    assert_eq!(count_json("const F: &str = \"y.json\";\nfn f() {\n    let a = F;\n    let b = 2;\n    let c = 3;\n}"), 0);
    assert_eq!(count_json("const N: &str = \"y.txt\";\nfn f() { let s = std::fs::read_to_string(N); }"), 0);
    assert_eq!(json_consts("pub(crate) const A: &str = \"a.json\";\nstatic B: [&str; 1] = [\"b.json\"];\nconst C: u8 = 1;\nconst fn d() {}"), vec![("A".to_string(), 0), ("B".to_string(), 1)]);
    assert_eq!(word_count("FILE.join(MY_FILE) + FILE", "FILE"), 2);
    // #2232 B：其他暫存／原子寫入的寫法
    for pat in ["let t = p.with_extension(\"x.part\");", "let t = format!(\"{}.part\", p);", "let f = tempfile::NamedTempFile::new_in(d)?;", "f.persist_noclobber(&p)?;", "let t = p.with_extension(\"tmp\");", "let t = format!(\"{}.new\", p);", "let t = format!(\"{}.tmp.{}\", p, n);"] {
        assert!(count_atomic(pat) >= 1, "{pat} 要算原子寫入字樣");
    }
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

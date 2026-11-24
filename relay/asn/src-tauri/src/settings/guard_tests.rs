//! #2162 ⑨：Rust 守門。擋住「新增私有的 json 讀寫」與「另寫一份原子寫入」。
//! 兩份待搬／例外清單的規則比照 `test/invoke-exit.test.mjs`：次數只准變少、不准變多；
//! 變少時清單也要同步改，否則一樣紅（讓清單只會縮、不會留著過期的空白支票）。
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

const HOW_TO: &str = "新增的設定請走 settings::（Doc，或 load_text／save_text）；狀態、佇列、快取類請用 settings::atomic::write(STATE／QUEUE)；\
真的需要例外，請在 guard_tests.rs 的對應清單加一行（檔、次數）並寫理由。";

/// 私有 json 讀寫：目前還允許的檔與次數（次數＝「有 .json 字樣、同行或前後一行有讀寫檔動作」的行數）。
/// 分類依 #2162 A-3：乙組＝使用者手寫、外部程式要讀；丙組＝狀態、佇列、計數、快取、產生檔、憑證類，明確不搬進設定層。
/// 「待搬」＝設定類但還沒搬。
const PENDING_JSON: &[(&str, usize)] = &[
    // ---- 讀外部程式（Claude／Codex／Grok／Pi）自己維護的檔：不是 ASN 的設定，格式由對方決定，不搬 ----
    ("bridge/engines/codex_state.rs", 1), // 讀 Codex 的 session_index.jsonl（唯讀）
    ("bridge/engines/grok_adopt.rs", 1),  // 讀 Grok 的 ~/.grok/active_sessions.json（唯讀）
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
    ("bridge/forward_selftest.rs", 1),    // 自我測試產生的 sender／recv-settings.json（給 claude --settings 讀的產生檔，R54）
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

/// 只有 settings/atomic.rs 可以實作原子寫入；本檔含有被掃的字樣，所以也排除
const SELF_FILES: &[&str] = &["settings/atomic.rs", "settings/guard_tests.rs"];

const JSON_OPS: &[&str] = &["read_to_string", "fs::write", "File::create", "OpenOptions"];
const ATOMIC_PATS: &[&str] = &["fn write_atomic", "fn atomic_write", "fn save_atomic", ".tmp\""];

fn src_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("src")
}

fn walk(dir: &Path, out: &mut Vec<PathBuf>) {
    for e in std::fs::read_dir(dir).unwrap() {
        let p = e.unwrap().path();
        if p.is_dir() {
            walk(&p, out);
        } else if p.extension().is_some_and(|x| x == "rs") {
            out.push(p);
        }
    }
}

fn is_test_file(rel: &str) -> bool {
    let name = rel.rsplit('/').next().unwrap();
    name == "tests.rs" || name.ends_with("_tests.rs") || rel.split('/').any(|d| d == "tests")
}

/// 測試模組結尾：獨佔一行的第 0 欄 `}`，而且後面是檔尾、或下一個非空行以字母、`#`、`/` 開頭（排除字串字面值裡剛好有一行 `}` 的情形）
fn module_end(rest: &str) -> Option<usize> {
    let mut from = 0;
    while let Some(i) = rest[from..].find("\n}") {
        let at = from + i;
        let after = &rest[at + 2..];
        if after.is_empty() || after.starts_with('\n') {
            let next = after.trim_start();
            let ok = next.chars().next().map_or(true, |c| c.is_alphabetic() || c == '#' || c == '/');
            if ok {
                return Some(at);
            }
        }
        from = at + 1;
    }
    None
}

/// 去掉測試模組後的正式碼：`#[cfg(...test...)]`（可疊其他屬性）後面緊接 `mod x {` 的整個區塊（到第一個獨佔一行的 `}` 為止，檔案都是 rustfmt 過的），
/// 或 `mod x;` 那一行。單一函式上的 #[cfg(test)] 不算。測試區在檔案中間時，後面的正式碼仍然會被掃到（不是只切到結尾）。
fn strip_tests(rel: &str, src: &str) -> String {
    let mut out = String::new();
    let mut pos = 0;
    let mut search = 0;
    while let Some(i) = src[search..].find("#[cfg(") {
        let at = search + i;
        let mut end = src[at..].find(']').map_or(src.len(), |e| at + e + 1);
        let attr = src[at..end].to_string();
        loop {
            let rest = src[end..].trim_start();
            if rest.starts_with("#[") {
                end = src.len() - rest.len() + rest.find(']').map_or(rest.len(), |e| e + 1);
            } else {
                break;
            }
        }
        let rest = src[end..].trim_start();
        let start = src.len() - rest.len();
        let is_mod = rest.starts_with("mod ") || rest.starts_with("pub mod ");
        if attr.contains("test") && !attr.contains("not(test") && is_mod && at >= pos {
            let head = rest.lines().next().unwrap();
            let stop = if head.trim_end().ends_with('{') {
                // 行內測試模組：找到第一個獨佔一行、縮排在第 0 欄的 `}`
                let close = module_end(&src[start..]);
                let close = close.unwrap_or_else(|| panic!("{rel}：找不到測試模組的結尾 `}}`，守門無法判斷哪裡是正式碼"));
                start + close + 3
            } else {
                start + head.len()
            };
            out.push_str(&src[pos..at]);
            pos = stop.min(src.len());
            search = pos;
        } else {
            search = at + 1;
        }
    }
    out.push_str(&src[pos..]);
    out
}

/// (相對路徑, 正式碼文字) 的清單，排除測試檔
fn prod_sources() -> Vec<(String, String)> {
    let root = src_root();
    let mut files = Vec::new();
    walk(&root, &mut files);
    assert!(files.len() > 100, "掃到的 .rs 太少（{}），路徑不對？", files.len());
    let mut out = Vec::new();
    for f in files {
        let rel = f.strip_prefix(&root).unwrap().to_string_lossy().replace('\\', "/");
        if is_test_file(&rel) {
            continue;
        }
        let src = std::fs::read_to_string(&f).unwrap().replace("\r\n", "\n");
        let prod = strip_tests(&rel, &src);
        assert!(!prod.contains("mod tests {"), "{rel}：還有沒切掉的測試模組");
        out.push((rel, prod));
    }
    out
}

fn near_ops(lines: &[&str], i: usize) -> bool {
    let lo = i.saturating_sub(1);
    let hi = (i + 1).min(lines.len() - 1);
    lines[lo..=hi].iter().any(|w| JSON_OPS.iter().any(|op| w.contains(op)))
}

fn count_json(prod: &str) -> usize {
    let lines: Vec<&str> = prod.lines().collect();
    lines.iter().enumerate().filter(|(i, l)| !l.trim_start().starts_with("//") && l.contains(".json") && near_ops(&lines, *i)).count()
}

fn count_atomic(prod: &str) -> usize {
    prod.lines().filter(|l| !l.trim_start().starts_with("//") && ATOMIC_PATS.iter().any(|p| l.contains(p))).count()
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
            if l.trim_start().starts_with("//") {
                continue;
            }
            for m in moved {
                if l.contains(&format!("\"{m}.json\"")) && near_ops(&lines, i) {
                    hits.push(format!("{rel}:{} {m}", i + 1));
                }
            }
        }
    }
    assert!(hits.is_empty(), "已搬進共用層的設定檔又出現私有讀寫：{hits:?}\n怎麼辦：{HOW_TO}");
}

#[test]
fn 守門自己的前提() {
    // 行內測試模組被切掉；測試區在中間時，後面的正式碼仍會被掃到
    let s = "fn a() {}\n#[cfg(test)]\nmod tests {\n    fn b() {}\n}\nfn after() {}\n";
    let p = strip_tests("x.rs", s);
    assert!(p.contains("fn a()") && p.contains("fn after()") && !p.contains("fn b()"), "{p}");
    // 單一函式上的 #[cfg(test)] 不算切點
    let s2 = "#[cfg(test)]\nfn only_test() {}\nfn prod() {}\n";
    assert_eq!(strip_tests("x.rs", s2), s2);
    // 疊屬性、只宣告 mod x;
    let s3 = "fn a() {}\n#[cfg(all(test, desktop))]\n#[allow(dead_code)]\nmod x;\nfn z() {}\n";
    let p3 = strip_tests("x.rs", s3);
    assert!(p3.contains("fn a()") && p3.contains("fn z()") && !p3.contains("mod x;"), "{p3}");
    // 計數：同行、相鄰行算；相隔兩行以上不算；註解不算
    assert_eq!(count_json("let a = std::fs::read_to_string(dir.join(\"x.json\"));"), 1);
    assert_eq!(count_json("let p = dir.join(\"x.json\");\nlet s = std::fs::read_to_string(&p);"), 1);
    assert_eq!(count_json("let p = dir.join(\"x.json\");\nlet q = 1;\nlet r = 2;\nlet s = std::fs::read_to_string(&p);"), 0);
    assert_eq!(count_json("// std::fs::write(\"x.json\", \"\")"), 0);
    assert_eq!(count_atomic("fn write_atomic(p: &Path) {}"), 1);
    assert_eq!(count_atomic("let t = format!(\"{}.tmp\", p);"), 1);
    // 清單比對：變多、變少都要紅
    assert!(std::panic::catch_unwind(|| check("t", &BTreeMap::from([("a.rs".to_string(), 2)]), &[("a.rs", 1)])).is_err());
    assert!(std::panic::catch_unwind(|| check("t", &BTreeMap::from([("a.rs".to_string(), 1)]), &[("a.rs", 2)])).is_err());
    assert!(std::panic::catch_unwind(|| check("t", &BTreeMap::new(), &[("a.rs", 1)])).is_err());
    check("t", &BTreeMap::from([("a.rs".to_string(), 1)]), &[("a.rs", 1)]);
    // 掃描沒掃空、測試檔有被排除
    assert!(is_test_file("settings/raw_tests.rs") && is_test_file("settings/tests.rs") && !is_test_file("settings/raw.rs"));
    let all = prod_sources();
    assert!(all.iter().any(|(r, p)| r == "settings/raw.rs" && !p.is_empty()));
    assert!(all.iter().all(|(r, _)| !is_test_file(r)));
    // 失敗訊息要講怎麼做
    assert!(HOW_TO.contains("settings::") && HOW_TO.contains("清單"));
}

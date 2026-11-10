//! 手機確認電腦的指紋：從四個選項裡選出電腦上顯示的那一組（只在手機建置使用）。
//! 正確答案與四個選項只留在這裡的記憶體；畫面只拿到選項文字，答案由 Rust 判斷，畫面永遠不知道哪個是對的。
//! 這個檔案不寫任何日誌、不發事件（守門測試鎖住）。

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

/// 選項的有效時間
pub const CHALLENGE_TTL_MS: u64 = 120_000;
/// 選對之後，到真正記住之前的有效時間
pub const PASSED_TTL_MS: u64 = 60_000;
/// 同時最多留幾個題目，超過就丟最舊的
pub const MAX_PENDING: usize = 16;
/// 畫面回「都不一樣」的數字
pub const PICK_NONE: i64 = -1;

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Stage {
    Asked,
    Passed,
}

#[derive(Clone)]
pub struct Pending {
    pub node: String,
    /// 出題當時這支手機記住的公鑰
    pub sign_pub: String,
    pub answer: usize,
    pub issued_ms: u64,
    pub expires_ms: u64,
    pub stage: Stage,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Outcome {
    Right,
    Wrong,
    NoneMatch,
    Expired,
}

impl Outcome {
    /// 給畫面的字
    pub fn as_str(self) -> &'static str {
        match self {
            Outcome::Right => "right",
            Outcome::Wrong => "wrong",
            Outcome::NoneMatch => "none",
            Outcome::Expired => "expired",
        }
    }
}

const HEX: &[u8; 16] = b"0123456789abcdef";

fn hex_of(bytes: &[u8]) -> String {
    bytes.iter().flat_map(|b| [HEX[(b >> 4) as usize] as char, HEX[(b & 15) as usize] as char]).collect()
}

/// 每 4 個字元一組、空格隔開（和 device_id::fp_grouped 同一種寫法）
fn grouped(fp16: &str) -> String {
    fp16.as_bytes().chunks(4).map(|c| String::from_utf8_lossy(c).into_owned()).collect::<Vec<_>>().join(" ")
}

fn rand_below(rng: &mut impl FnMut(&mut [u8]), n: usize) -> usize {
    let mut b = [0u8; 4];
    rng(&mut b);
    (u32::from_le_bytes(b) as usize) % n
}

/// 出四個選項：正確的一個、三個亂數湊的（前 4 個字元與正確的、彼此都不同），洗牌後回（四個分組字串、正確的是第幾個）
pub fn make_options(correct_fp16: &str, mut rng: impl FnMut(&mut [u8])) -> (Vec<String>, usize) {
    let mut used: Vec<String> = vec![correct_fp16.chars().take(4).collect()];
    let mut items: Vec<(String, bool)> = vec![(grouped(correct_fp16), true)];
    for _ in 0..3 {
        let mut fp = String::new();
        for _ in 0..64 {
            let mut b = [0u8; 8];
            rng(&mut b);
            let cand = hex_of(&b);
            if !used.contains(&cand[..4].to_string()) {
                fp = cand;
                break;
            }
        }
        if fp.is_empty() {
            // 亂數一直撞（不該發生）：照順序找一個沒用過的開頭
            let head = (0..=0xffffu32).map(|n| format!("{n:04x}")).find(|h| !used.contains(h)).unwrap_or_default();
            fp = format!("{head}0000000000{:02x}", items.len());
        }
        used.push(fp[..4].to_string());
        items.push((grouped(&fp), false));
    }
    for i in (1..items.len()).rev() {
        let j = rand_below(&mut rng, i + 1);
        items.swap(i, j);
    }
    let answer = items.iter().position(|(_, ok)| *ok).unwrap_or(0);
    (items.into_iter().map(|(s, _)| s).collect(), answer)
}

#[derive(Default)]
pub struct Store {
    map: HashMap<String, Pending>,
}

impl Store {
    fn prune(&mut self, now_ms: u64) {
        self.map.retain(|_, p| now_ms < p.expires_ms);
    }

    /// 出題：記下答案，回（題目編號、四個選項）。correct_fp16 由呼叫端用記住的公鑰算
    pub fn issue(&mut self, node: &str, sign_pub: &str, correct_fp16: &str, now_ms: u64, mut rng: impl FnMut(&mut [u8])) -> (String, Vec<String>) {
        self.prune(now_ms);
        let (options, answer) = make_options(correct_fp16, &mut rng);
        let mut idb = [0u8; 16];
        rng(&mut idb);
        let id = hex_of(&idb);
        while self.map.len() >= MAX_PENDING {
            let oldest = self.map.iter().min_by_key(|(_, p)| p.issued_ms).map(|(k, _)| k.clone());
            match oldest {
                Some(k) => {
                    self.map.remove(&k);
                }
                None => break,
            }
        }
        self.map.insert(id.clone(), Pending { node: node.to_string(), sign_pub: sign_pub.to_string(), answer, issued_ms: now_ms, expires_ms: now_ms + CHALLENGE_TTL_MS, stage: Stage::Asked });
        (id, options)
    }

    /// 回答：pick 是第幾個（從 0 起），-1 是「都不一樣」。錯、都不一樣、過期都把題目收掉（不能重選）；選對就換成「過關」，再給 60 秒記住
    pub fn answer(&mut self, id: &str, pick: i64, now_ms: u64) -> Outcome {
        self.prune(now_ms);
        let (stage, correct) = match self.map.get(id) {
            Some(p) => (p.stage, p.answer as i64),
            None => return Outcome::Expired,
        };
        if stage != Stage::Asked {
            self.map.remove(id);
            return Outcome::Expired;
        }
        if pick == correct {
            if let Some(p) = self.map.get_mut(id) {
                p.stage = Stage::Passed;
                p.expires_ms = now_ms + PASSED_TTL_MS;
            }
            return Outcome::Right;
        }
        self.map.remove(id);
        if pick == PICK_NONE {
            Outcome::NoneMatch
        } else {
            Outcome::Wrong
        }
    }

    /// 記住之前取走過關的題目（只能取一次）；沒過關、過期、沒有這題都回 None
    pub fn take_passed(&mut self, id: &str, now_ms: u64) -> Option<(String, String)> {
        self.prune(now_ms);
        if self.map.get(id).is_some_and(|p| p.stage == Stage::Passed) {
            self.map.remove(id).map(|p| (p.node, p.sign_pub))
        } else {
            None
        }
    }

    pub fn len(&self) -> usize {
        self.map.len()
    }
}

fn store() -> &'static Mutex<Store> {
    static S: OnceLock<Mutex<Store>> = OnceLock::new();
    S.get_or_init(|| Mutex::new(Store::default()))
}

fn os_rng(b: &mut [u8]) {
    getrandom::fill(b).expect("系統亂數不可用");
}

/// 出題：正確的指紋由這裡用記住的公鑰算，不收外面給的值
pub fn issue(node: &str, sign_pub: &str, now_ms: u64) -> (String, Vec<String>) {
    let fp = crate::device_id::fingerprint(sign_pub);
    store().lock().unwrap_or_else(|e| e.into_inner()).issue(node, sign_pub, &fp, now_ms, os_rng)
}

pub fn answer(id: &str, pick: i64, now_ms: u64) -> Outcome {
    store().lock().unwrap_or_else(|e| e.into_inner()).answer(id, pick, now_ms)
}

pub fn take_passed(id: &str, now_ms: u64) -> Option<(String, String)> {
    store().lock().unwrap_or_else(|e| e.into_inner()).take_passed(id, now_ms)
}

#[cfg(test)]
mod tests {
    use super::*;

    const FP: &str = "a93cc5191f2e3b4d";

    /// 固定的亂數：xorshift，種子相同結果相同
    fn rng(seed: u64) -> impl FnMut(&mut [u8]) {
        // 不同的種子一定給不同的序列（不能用 seed | 1：20 和 21 會變成同一個）
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

    #[test]
    fn 四個選項_只有一個是正確的_開頭四碼都不同_答案位置對() {
        for seed in 1..200u64 {
            let (opts, ans) = make_options(FP, rng(seed));
            assert_eq!(opts.len(), 4);
            assert_eq!(opts[ans], "a93c c519 1f2e 3b4d");
            assert_eq!(opts.iter().filter(|o| o.replace(' ', "") == FP).count(), 1);
            let mut heads: Vec<&str> = opts.iter().map(|o| &o[..4]).collect();
            heads.sort();
            heads.dedup();
            assert_eq!(heads.len(), 4, "{opts:?}");
            for o in &opts {
                assert_eq!(o.len(), 19);
                assert_eq!(o.split(' ').count(), 4);
                assert!(o.replace(' ', "").chars().all(|c| c.is_ascii_digit() || ('a'..='f').contains(&c)), "{o}");
            }
        }
    }

    #[test]
    fn 洗牌會隨亂數變_答案不固定在同一格() {
        let ans: std::collections::HashSet<usize> = (1..100u64).map(|s| make_options(FP, rng(s)).1).collect();
        assert_eq!(ans.len(), 4, "四個位置都會出現：{ans:?}");
        assert_ne!(make_options(FP, rng(1)).0, make_options(FP, rng(2)).0);
        assert_eq!(make_options(FP, rng(7)), make_options(FP, rng(7)), "同樣的亂數同樣的結果");
    }

    #[test]
    fn 亂數一直撞也不卡住_還是四個不同開頭() {
        let (opts, ans) = make_options(FP, |b: &mut [u8]| b.fill(0xa9));
        assert_eq!(opts.len(), 4);
        assert_eq!(opts[ans], "a93c c519 1f2e 3b4d");
        let mut heads: Vec<&str> = opts.iter().map(|o| &o[..4]).collect();
        heads.sort();
        heads.dedup();
        assert_eq!(heads.len(), 4, "{opts:?}");
    }

    fn issued(s: &mut Store, now: u64, seed: u64) -> (String, Vec<String>) {
        s.issue("pc", "pk", FP, now, rng(seed))
    }

    fn ans_of(s: &Store, id: &str) -> usize {
        s.map[id].answer
    }

    #[test]
    fn 選對_錯_都不一樣_過期_各自的結果() {
        let mut s = Store::default();
        let (id, opts) = issued(&mut s, 1000, 3);
        assert_eq!(opts.len(), 4);
        let a = ans_of(&s, &id);
        assert_eq!(s.answer(&id, a as i64, 1500), Outcome::Right);
        let (id, _) = issued(&mut s, 1000, 4);
        let a = ans_of(&s, &id) as i64;
        assert_eq!(s.answer(&id, (a + 1) % 4, 1500), Outcome::Wrong);
        let (id, _) = issued(&mut s, 1000, 5);
        assert_eq!(s.answer(&id, PICK_NONE, 1500), Outcome::NoneMatch);
        let (id, _) = issued(&mut s, 1000, 6);
        let a = ans_of(&s, &id) as i64;
        assert_eq!(s.answer(&id, a, 1000 + CHALLENGE_TTL_MS), Outcome::Expired, "剛好到期就算過期");
        assert_eq!(s.answer("沒有這題", 0, 1500), Outcome::Expired);
        let (id, _) = issued(&mut s, 1000, 7);
        assert_eq!(s.answer(&id, 4, 1500), Outcome::Wrong, "超出範圍算選錯");
        let (id, _) = issued(&mut s, 1000, 8);
        assert_eq!(s.answer(&id, -2, 1500), Outcome::Wrong);
    }

    #[test]
    fn 選錯就收掉_不能重選_再回答是過期() {
        let mut s = Store::default();
        let (id, _) = issued(&mut s, 0, 9);
        let a = ans_of(&s, &id) as i64;
        assert_eq!(s.answer(&id, (a + 1) % 4, 10), Outcome::Wrong);
        assert_eq!(s.answer(&id, a, 20), Outcome::Expired, "選對的那個也不行");
        assert_eq!(s.len(), 0);
        let (id, _) = issued(&mut s, 0, 10);
        assert_eq!(s.answer(&id, PICK_NONE, 10), Outcome::NoneMatch);
        assert_eq!(s.answer(&id, PICK_NONE, 20), Outcome::Expired);
    }

    #[test]
    fn 過關才取得走_只能一次_六十秒內() {
        let mut s = Store::default();
        let (id, _) = issued(&mut s, 0, 11);
        assert_eq!(s.take_passed(&id, 5), None, "沒選過不能取");
        let a = ans_of(&s, &id) as i64;
        assert_eq!(s.answer(&id, a, 100_000), Outcome::Right, "選的時候還在 120 秒內");
        assert_eq!(s.map[&id].expires_ms, 100_000 + PASSED_TTL_MS);
        assert_eq!(s.take_passed(&id, 100_000 + 59_999), Some(("pc".to_string(), "pk".to_string())));
        assert_eq!(s.take_passed(&id, 100_000 + 59_999), None, "只能取一次");
        let (id, _) = issued(&mut s, 0, 12);
        let a = ans_of(&s, &id) as i64;
        assert_eq!(s.answer(&id, a, 10), Outcome::Right);
        assert_eq!(s.take_passed(&id, 10 + PASSED_TTL_MS), None, "過了 60 秒");
        assert_eq!(s.len(), 0);
        let (id, _) = issued(&mut s, 0, 13);
        let a = ans_of(&s, &id) as i64;
        assert_eq!(s.answer(&id, a, 10), Outcome::Right);
        assert_eq!(s.answer(&id, a, 11), Outcome::Expired, "過關後再答不算數");
        assert_eq!(s.take_passed(&id, 12), None);
    }

    #[test]
    fn 過期的每次呼叫都清掉_數量有上限丟最舊的() {
        let mut s = Store::default();
        let (old, _) = issued(&mut s, 0, 20);
        issued(&mut s, CHALLENGE_TTL_MS + 5, 21);
        assert!(!s.map.contains_key(&old) && s.len() == 1, "出新題時舊的過期題被清掉");
        let mut s = Store::default();
        let first = issued(&mut s, 0, 30).0;
        for i in 1..(MAX_PENDING as u64 + 5) {
            issued(&mut s, i, 30 + i);
        }
        assert_eq!(s.len(), MAX_PENDING);
        assert!(!s.map.contains_key(&first), "最舊的被丟掉");
        let last = issued(&mut s, 100, 99).0;
        assert!(s.map.contains_key(&last) && s.len() == MAX_PENDING);
    }

    #[test]
    fn 守門_這裡不寫日誌_不發事件() {
        let src = std::fs::read_to_string(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src").join("known_pick.rs")).unwrap().replace("\r\n", "\n");
        let code = src.split("\n#[cfg(test)]").next().unwrap();
        for bad in ["elog!", "olog!", "println!", "dbg!", "log::", "tracing::", "emit(", "emit_to(", "ui_log"] {
            assert!(!code.contains(bad), "known_pick.rs 不能有：{bad}");
        }
    }
}

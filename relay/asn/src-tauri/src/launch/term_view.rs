//! 在畫面裡看夥伴的終端（0.2.5，#597）：把窗格的快照送給 xterm.js。全程在本機，不經過後台。
//! 這裡只有判斷（過濾、節奏、一個觀看的迴圈），不碰 WezTerm、不碰視窗，方便測試。
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::Duration;

/// 有輸入後這段時間內讀快一點，打字才看得到（工作機實測 50 毫秒輪詢 p95 約 87 毫秒，#597）
pub const INPUT_ACTIVE_MS: u64 = 2_000;
pub const FAST_MS: u64 = 50;
pub const IDLE_MS: u64 = 1_000;
/// 視窗看不到時多久再看一次要不要恢復（這段時間不讀窗格）
pub const HIDDEN_MS: u64 = 1_000;

/// 下一輪隔多久
pub fn next_delay_ms(now_ms: u64, last_input_ms: u64) -> u64 {
    if last_input_ms != 0 && now_ms.saturating_sub(last_input_ms) < INPUT_ACTIVE_MS {
        FAST_MS
    } else {
        IDLE_MS
    }
}

/// 畫面內容是外部資料。只放行顏色（SGR）、字元集 `ESC(B`、換行和一般文字，其他序列一律拿掉：
/// 連結（OSC 8）、剪貼簿（OSC 52）、標題、終端查詢（會讓 xterm.js 自動回覆，變成輸入）、移動游標都不放行。
/// `get-text --escapes` 實測只會給顏色、`ESC(B` 和 OSC 8；這裡是第二層，WezTerm 換版也不會多放東西進來。
pub fn filter_frame(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    let mut it = raw.chars().peekable();
    while let Some(c) = it.next() {
        match c {
            '\x1b' => match it.next() {
                Some('[') => {
                    let mut params = String::new();
                    let mut last = None;
                    for p in it.by_ref() {
                        if ('\u{40}'..='\u{7e}').contains(&p) {
                            last = Some(p);
                            break;
                        }
                        params.push(p);
                    }
                    if last == Some('m') && params.len() <= 64 && params.chars().all(|p| p.is_ascii_digit() || p == ';' || p == ':') {
                        out.push_str("\x1b[");
                        out.push_str(&params);
                        out.push('m');
                    }
                }
                Some('(') => {
                    if it.next() == Some('B') {
                        out.push_str("\x1b(B");
                    }
                }
                Some(']') | Some('P') | Some('X') | Some('^') | Some('_') => {
                    // 字串類序列：跳到 BEL 或 ST；沒有結尾就全部丟掉
                    while let Some(p) = it.next() {
                        if p == '\x07' {
                            break;
                        }
                        if p == '\x1b' && it.peek() == Some(&'\\') {
                            it.next();
                            break;
                        }
                    }
                }
                _ => {}
            },
            '\n' | '\r' | '\t' => out.push(c),
            // 其他控制字元，包括 8 位元的 C1（\u{9b} 等於 CSI）
            c if (c as u32) < 0x20 || (0x7f..=0x9f).contains(&(c as u32)) => {}
            c => out.push(c),
        }
    }
    out
}

/// 單次送進窗格的字數上限（位元組）。`wezterm cli send-text` 的字是放在命令列參數裡，Windows 命令列有約 32 KB 的上限，
/// 留一半以上的餘裕；超過的分段送，順序不變
pub const INPUT_CHUNK_BYTES: usize = 8 * 1024;
/// 一次呼叫最多收多少（位元組）。貼上 1 萬字（約 3 萬位元組）要過，所以比單次送出的大
pub const INPUT_CALL_MAX_BYTES: usize = 256 * 1024;
/// 等著送的字積壓到這麼多就先擋住（回錯給畫面），不丟字
pub const INPUT_QUEUE_MAX_BYTES: usize = 512 * 1024;

/// xterm.js 送出來的是按鍵序列（Enter、方向鍵、Ctrl＋字母、一般文字）。這裡擋掉不是按鍵的東西：
/// 字串類序列（OSC、DCS、APC、PM、SOS）和 8 位元的控制字元（\u{9b} 等於 CSI）。其他一律放行（含單獨的 Esc、CSI／SS3 按鍵序列）
pub fn check_input(data: &str) -> Result<(), String> {
    if data.is_empty() {
        return Err("沒有要送的字".into());
    }
    if data.len() > INPUT_CALL_MAX_BYTES {
        return Err("一次送的字太多，請分段貼上".into());
    }
    let mut it = data.chars().peekable();
    while let Some(c) = it.next() {
        if c == '\x1b' && matches!(it.peek(), Some(']') | Some('P') | Some('X') | Some('^') | Some('_')) {
            return Err("這不是按鍵，不送".into());
        }
        if (0x80..=0x9f).contains(&(c as u32)) {
            return Err("這不是按鍵，不送".into());
        }
    }
    Ok(())
}

/// 把字切成不超過 `max` 位元組的幾段，不從字中間切開，順序不變
pub fn split_chunks(text: &str, max: usize) -> Vec<&str> {
    let mut out = Vec::new();
    let mut rest = text;
    while !rest.is_empty() {
        if rest.len() <= max {
            out.push(rest);
            break;
        }
        let mut cut = max;
        while cut > 0 && !rest.is_char_boundary(cut) {
            cut -= 1;
        }
        // 不把跳脫序列切在 ESC 和後面的字元中間（ESC 在尾巴就留給下一段）
        if cut > 0 && rest[..cut].ends_with('\x1b') {
            cut -= 1;
        }
        if cut == 0 {
            cut = rest.chars().next().map_or(rest.len(), |c| c.len_utf8());
        }
        out.push(&rest[..cut]);
        rest = &rest[cut..];
    }
    out
}

/// 等著送進窗格的字：先進先出、一次一支。積壓時把相鄰的同類（都是打字、或都是貼上）合併成一支，
/// 打字和貼上不混在一起（貼上要讓 WezTerm 依程式的模式處理）。積壓太多就擋住新的，**不丟舊的字**
#[derive(Default)]
pub struct InputQueue {
    inner: std::sync::Mutex<InputQueueInner>,
    ready: std::sync::Condvar,
}

#[derive(Default)]
struct InputQueueInner {
    items: std::collections::VecDeque<(bool, String)>,
    bytes: usize,
    closed: bool,
}

impl InputQueue {
    /// 排進去。積壓太多回錯（字沒有收，畫面要告訴使用者稍等再打）
    pub fn push(&self, data: &str, paste: bool) -> Result<(), String> {
        let mut g = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        if g.closed {
            return Err("這個畫面已經關了".into());
        }
        if g.bytes + data.len() > INPUT_QUEUE_MAX_BYTES {
            return Err("輸入來不及送進終端，請稍等一下再打".into());
        }
        g.bytes += data.len();
        g.items.push_back((paste, data.to_string()));
        self.ready.notify_one();
        Ok(())
    }

    /// 取出下一支要送的：把開頭相鄰的同類合併，合併後不超過 `max`（單一段本來就比 `max` 大的，原樣取出，由呼叫的人分段）。
    /// 沒有就等最多 `wait`；等不到或收掉了回 None
    pub fn next_batch(&self, max: usize, wait: Duration) -> Option<(bool, String)> {
        let mut g = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        if g.items.is_empty() {
            if g.closed {
                return None;
            }
            let (ng, _) = self.ready.wait_timeout(g, wait).unwrap_or_else(|e| e.into_inner());
            g = ng;
        }
        let (paste, first) = g.items.pop_front()?;
        let mut merged = first;
        while let Some((p, next)) = g.items.front() {
            if *p != paste || merged.len() + next.len() > max {
                break;
            }
            merged.push_str(next);
            g.items.pop_front();
        }
        g.bytes = g.bytes.saturating_sub(merged.len());
        Some((paste, merged))
    }

    /// 等著送的位元組數（測試與提示用）
    pub fn pending_bytes(&self) -> usize {
        self.inner.lock().unwrap_or_else(|e| e.into_inner()).bytes
    }

    /// 清掉等著的字並不再收新的（畫面關了、窗格換了）。回丟掉的位元組數，讓呼叫的人告訴使用者
    pub fn close(&self) -> usize {
        let mut g = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        g.closed = true;
        let n = g.bytes;
        g.items.clear();
        g.bytes = 0;
        self.ready.notify_all();
        n
    }
}

/// 窗格的游標與大小
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct ViewMeta {
    pub cursor_x: i64,
    pub cursor_y: i64,
    pub cols: u32,
    pub rows: u32,
}

/// 送給畫面的一幅
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct ViewFrame {
    pub view_id: u64,
    pub seq: u64,
    pub text: String,
    pub meta: ViewMeta,
}

/// 一個觀看的共用狀態：要不要停、上次輸入的時間（0＝沒有）、等著送出的字、已經送出的字數
#[derive(Default)]
pub struct ViewState {
    pub stop: AtomicBool,
    pub last_input_ms: AtomicU64,
    pub input: InputQueue,
    /// 這次觀看一共送出幾個字（只記字數，內容不記；結束時寫一行紀錄）
    pub sent_chars: AtomicU64,
}

/// 迴圈會用到的外部動作，正式版接窗格和視窗，測試接假的
pub trait ViewPort {
    fn text(&mut self) -> Result<String, String>;
    fn meta(&mut self) -> Result<ViewMeta, String>;
    /// 畫面看得到才讀；回 None＝視窗已經不在
    fn visible(&mut self) -> Option<bool>;
    fn emit(&mut self, frame: ViewFrame) -> bool;
    fn now_ms(&mut self) -> u64;
    fn sleep(&mut self, d: Duration);
}

/// 跑到被要求停止、視窗不在、或窗格讀不到為止。回結束原因（窗格讀不到時，給畫面顯示）
pub fn run_view(view_id: u64, state: &ViewState, port: &mut impl ViewPort) -> Option<String> {
    let mut seq = 0u64;
    let mut last: Option<(String, ViewMeta)> = None;
    let mut last_meta_ms = 0u64;
    while !state.stop.load(Ordering::SeqCst) {
        match port.visible() {
            None => return None,
            Some(false) => {
                port.sleep(Duration::from_millis(HIDDEN_MS));
                continue;
            }
            Some(true) => {}
        }
        let text = match port.text() {
            Ok(t) => filter_frame(&t),
            Err(e) => return Some(e),
        };
        let now = port.now_ms();
        let changed = last.as_ref().is_none_or(|(t, _)| *t != text);
        // 內容沒變時游標也可能動，每秒看一次就好：每次讀都多開一支程序
        if changed || now.saturating_sub(last_meta_ms) >= IDLE_MS {
            let meta = match port.meta() {
                Ok(m) => m,
                Err(e) => return Some(e),
            };
            last_meta_ms = now;
            if changed || last.as_ref().is_none_or(|(_, m)| *m != meta) {
                seq += 1;
                last = Some((text.clone(), meta.clone()));
                if !port.emit(ViewFrame { view_id, seq, text, meta }) {
                    return None;
                }
            }
        }
        let delay = next_delay_ms(now, state.last_input_ms.load(Ordering::SeqCst));
        port.sleep(Duration::from_millis(delay));
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 放行顏色_字元集_換行_中文() {
        let s = "\x1b[31m紅\x1b(B\x1b[0;1m粗\x1b[38:5:9m\r\n\t全形ｘ";
        assert_eq!(filter_frame(s), s);
    }

    #[test]
    fn 連結_剪貼簿_標題_查詢_游標_都拿掉() {
        assert_eq!(filter_frame("\x1b]8;id=1;https://evil.example/\x1b\\LINK\x1b]8;;\x1b\\"), "LINK");
        assert_eq!(filter_frame("a\x1b]52;c;aGVsbG8=\x07b"), "ab");
        assert_eq!(filter_frame("a\x1b]0;TITLE\x07b"), "ab");
        assert_eq!(filter_frame("a\x1b[cb\x1b[6nc\x1b[18td"), "abcd");
        assert_eq!(filter_frame("a\x1b[2J\x1b[H\x1b[?1049h\x1b[?1000hb"), "ab");
        assert_eq!(filter_frame("a\x1bP+q544e\x1b\\b\x1bXs\x1b\\c\x1b^p\x1b\\d\x1b_a\x1b\\e"), "abcde");
    }

    #[test]
    fn 假裝是顏色的序列不放行() {
        assert_eq!(filter_frame("a\x1b[?1mb"), "ab", "帶 ? 不是 SGR");
        assert_eq!(filter_frame("a\x1b[1;2 mb"), "ab", "帶空白不是 SGR");
        let long = format!("a\x1b[{}mb", "1;".repeat(40));
        assert_eq!(filter_frame(&long), "ab", "太長不放行");
    }

    #[test]
    fn 八位元控制字元和其他控制字元拿掉() {
        assert_eq!(filter_frame("a\u{9b}6nb\u{9d}0;t\u{7}c\u{8}d\u{7f}e"), "a6nb0;tcde");
    }

    #[test]
    fn 沒結尾的序列不會吃掉別的_也不會卡住() {
        assert_eq!(filter_frame("a\x1b"), "a");
        assert_eq!(filter_frame("a\x1b["), "a");
        assert_eq!(filter_frame("a\x1b]52;c;xxxx"), "a", "沒結尾的字串類序列全部丟掉");
        assert_eq!(filter_frame("a\x1b("), "a");
        assert_eq!(filter_frame("a\x1b(0b"), "ab");
    }

    #[test]
    fn 輸出再過濾一次不變() {
        let s = filter_frame("\x1b[31m紅\x1b]8;;x\x1b\\連\x1b[6n\u{9b}1m");
        assert_eq!(filter_frame(&s), s);
    }

    #[test]
    fn 節奏_有輸入快_之後退回() {
        assert_eq!(next_delay_ms(10_000, 0), IDLE_MS, "沒輸入過");
        assert_eq!(next_delay_ms(10_000, 9_999), FAST_MS);
        assert_eq!(next_delay_ms(10_000, 10_000 - INPUT_ACTIVE_MS + 1), FAST_MS);
        assert_eq!(next_delay_ms(10_000, 10_000 - INPUT_ACTIVE_MS), IDLE_MS);
    }

    struct Fake<'a> {
        texts: Vec<Result<String, String>>,
        metas: u32,
        meta: ViewMeta,
        visible: Vec<Option<bool>>,
        emitted: Vec<ViewFrame>,
        sleeps: Vec<u64>,
        now: u64,
        reads: u32,
        emit_ok: bool,
        state: &'a ViewState,
        input_at_read: Option<u32>,
    }

    fn meta() -> ViewMeta {
        ViewMeta { cursor_x: 1, cursor_y: 2, cols: 120, rows: 40 }
    }

    impl ViewPort for Fake<'_> {
        fn text(&mut self) -> Result<String, String> {
            self.reads += 1;
            if self.input_at_read == Some(self.reads) {
                self.state.last_input_ms.store(self.now, Ordering::SeqCst);
            }
            if self.texts.is_empty() {
                self.state.stop.store(true, Ordering::SeqCst);
                return Ok(String::new());
            }
            self.texts.remove(0)
        }
        fn meta(&mut self) -> Result<ViewMeta, String> {
            self.metas += 1;
            Ok(self.meta.clone())
        }
        fn visible(&mut self) -> Option<bool> {
            if self.visible.is_empty() {
                Some(true)
            } else {
                self.visible.remove(0)
            }
        }
        fn emit(&mut self, frame: ViewFrame) -> bool {
            self.emitted.push(frame);
            self.emit_ok
        }
        fn now_ms(&mut self) -> u64 {
            self.now
        }
        fn sleep(&mut self, d: Duration) {
            self.sleeps.push(d.as_millis() as u64);
            self.now += d.as_millis() as u64;
        }
    }

    fn fake<'a>(state: &'a ViewState, texts: &[&str]) -> Fake<'a> {
        Fake {
            texts: texts.iter().map(|t| Ok(t.to_string())).collect(),
            metas: 0,
            meta: meta(),
            visible: vec![],
            emitted: vec![],
            sleeps: vec![],
            now: 100_000,
            reads: 0,
            emit_ok: true,
            state,
            input_at_read: None,
        }
    }

    #[test]
    fn 內容沒變不送_送出的已過濾_序號遞增() {
        let st = ViewState::default();
        let mut f = fake(&st, &["甲\x1b[6n", "甲", "乙"]);
        assert_eq!(run_view(7, &st, &mut f), None);
        let got: Vec<(u64, u64, &str)> = f.emitted.iter().filter(|x| !x.text.is_empty()).map(|x| (x.view_id, x.seq, x.text.as_str())).collect();
        assert_eq!(got, vec![(7, 1, "甲"), (7, 2, "乙")]);
    }

    #[test]
    fn 內容沒變時游標動了也要送_但不是每輪都查() {
        let st = ViewState::default();
        let mut f = fake(&st, &["甲", "甲"]);
        run_view(1, &st, &mut f);
        assert!(f.metas <= 3, "每秒一次：{}", f.metas);
    }

    #[test]
    fn 讀不到就結束並回原因() {
        let st = ViewState::default();
        let mut f = fake(&st, &[]);
        f.texts = vec![Err("窗格不見了".into())];
        assert_eq!(run_view(1, &st, &mut f).as_deref(), Some("窗格不見了"));
    }

    #[test]
    fn 看不到不讀窗格_視窗不在就結束() {
        let st = ViewState::default();
        let mut f = fake(&st, &["甲"]);
        f.visible = vec![Some(false), Some(false), None];
        assert_eq!(run_view(1, &st, &mut f), None);
        assert_eq!(f.reads, 0, "看不到時不讀");
        assert_eq!(f.sleeps, vec![HIDDEN_MS, HIDDEN_MS]);
    }

    #[test]
    fn 畫面送不出去就結束() {
        let st = ViewState::default();
        let mut f = fake(&st, &["甲", "乙"]);
        f.emit_ok = false;
        assert_eq!(run_view(1, &st, &mut f), None);
        assert_eq!(f.emitted.len(), 1);
    }

    #[test]
    fn 有輸入後變快() {
        let st = ViewState::default();
        let mut f = fake(&st, &["甲", "乙", "丙"]);
        f.input_at_read = Some(2);
        run_view(1, &st, &mut f);
        assert_eq!(f.sleeps[0], IDLE_MS);
        assert_eq!(f.sleeps[1], FAST_MS);
    }

    #[test]
    fn 要求停止就不再讀() {
        let st = ViewState::default();
        st.stop.store(true, Ordering::SeqCst);
        let mut f = fake(&st, &["甲"]);
        run_view(1, &st, &mut f);
        assert_eq!(f.reads, 0);
    }

    #[test]
    fn 輸入檢查_按鍵和文字放行_字串類序列和八位元控制字元擋掉() {
        for ok in ["a", "你好，world", "\r", "\x03", "\x7f", "\t", "\x1b", "\x1b[A", "\x1b[1;5C", "\x1bOP", "\x1b[200~貼上\x1b[201~", "第一行\n第二行"] {
            assert!(check_input(ok).is_ok(), "{ok:?}");
        }
        for bad in ["", "\x1b]52;c;aGVsbG8=\x07", "a\x1bPq\x1b\\", "\x1b_x\x1b\\", "\x1b^x", "\x1bXx", "\u{9b}6n", "a\u{9d}b"] {
            assert!(check_input(bad).is_err(), "{bad:?}");
        }
        assert!(check_input(&"字".repeat(INPUT_CALL_MAX_BYTES)).is_err(), "太大擋掉");
    }

    #[test]
    fn 切段_不超過上限_不切壞字_不切開跳脫序列_順序不變() {
        let t = "中".repeat(10);
        let parts = split_chunks(&t, 7);
        assert!(parts.iter().all(|p| p.len() <= 7), "{parts:?}");
        assert_eq!(parts.concat(), t);
        let esc = format!("{}\x1b[A{}", "a".repeat(6), "b".repeat(5));
        let parts = split_chunks(&esc, 7);
        assert_eq!(parts.concat(), esc);
        assert!(parts.iter().all(|p| !p.ends_with('\x1b')), "ESC 不留在一段的尾巴：{parts:?}");
        assert_eq!(split_chunks("", 7), Vec::<&str>::new());
        assert_eq!(split_chunks("abc", 7), vec!["abc"]);
        // 一個字就比上限大：照樣一個字一個字往前走，不卡住
        assert_eq!(split_chunks("中中", 1).concat(), "中中");
    }

    #[test]
    fn 佇列_積壓合併_順序不變_打字和貼上不混在一起() {
        let q = InputQueue::default();
        for (d, p) in [("a", false), ("b", false), ("貼\n上", true), ("c", false), ("d", false)] {
            q.push(d, p).unwrap();
        }
        let w = Duration::from_millis(1);
        assert_eq!(q.next_batch(100, w), Some((false, "ab".to_string())));
        assert_eq!(q.next_batch(100, w), Some((true, "貼\n上".to_string())));
        assert_eq!(q.next_batch(100, w), Some((false, "cd".to_string())));
        assert_eq!(q.next_batch(100, w), None, "空了等一下就回 None");
        assert_eq!(q.pending_bytes(), 0);
    }

    #[test]
    fn 佇列_合併不超過上限_超過的留給下一支() {
        let q = InputQueue::default();
        for d in ["12345", "67890", "abc"] {
            q.push(d, false).unwrap();
        }
        let w = Duration::from_millis(1);
        assert_eq!(q.next_batch(8, w), Some((false, "12345".to_string())));
        assert_eq!(q.next_batch(8, w), Some((false, "67890abc".to_string())));
    }

    #[test]
    fn 佇列_積壓太多擋住新的_不丟舊的() {
        let q = InputQueue::default();
        let big = "x".repeat(INPUT_QUEUE_MAX_BYTES / 2);
        q.push(&big, false).unwrap();
        q.push(&big, false).unwrap();
        let before = q.pending_bytes();
        assert!(q.push("y", false).unwrap_err().contains("來不及"));
        assert_eq!(q.pending_bytes(), before, "擋住的那筆沒有進來，舊的也一個字沒少");
        let (_, first) = q.next_batch(usize::MAX, Duration::from_millis(1)).unwrap();
        assert_eq!(first.len(), before, "舊的字全部還在、順序沒變");
        q.push("y", false).unwrap();
    }

    #[test]
    fn 佇列_關掉後不收也不送_回丟掉多少() {
        let q = InputQueue::default();
        q.push("abc", false).unwrap();
        assert_eq!(q.close(), 3);
        assert!(q.push("d", false).is_err());
        assert_eq!(q.next_batch(10, Duration::from_millis(1)), None);
    }

    #[test]
    fn 佇列_等字的人會被叫醒() {
        let q = std::sync::Arc::new(InputQueue::default());
        let q2 = q.clone();
        let t = std::thread::spawn(move || q2.next_batch(100, Duration::from_secs(5)));
        std::thread::sleep(Duration::from_millis(50));
        q.push("hi", false).unwrap();
        assert_eq!(t.join().unwrap(), Some((false, "hi".to_string())));
    }
}

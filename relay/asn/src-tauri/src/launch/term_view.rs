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

/// 一個觀看的共用狀態：要不要停、上次輸入的時間（0＝沒有）
#[derive(Default)]
pub struct ViewState {
    pub stop: AtomicBool,
    pub last_input_ms: AtomicU64,
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
}

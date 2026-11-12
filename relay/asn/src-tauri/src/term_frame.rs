//! 終端畫面的過濾與打字的檢查（全平台都編；電腦端的 `launch::term_view` 與看別台終端的收幀、送字共用）。
//! 畫面內容是外部資料，這裡只做純文字判斷，不碰視窗、不碰網路。

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

/// 一次呼叫最多收多少（位元組）。貼上 1 萬字（約 3 萬位元組）要過，所以比單次送出的大
pub const INPUT_CALL_MAX_BYTES: usize = 256 * 1024;

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
}

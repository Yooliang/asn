//! 同一個名字有兩個以上活著的 Claude 視窗（多半是同一段對話用 /resume 接到另一個視窗，#584）。
//! 收發員分不出要轉給哪一個，所以橋不交給它，改跟寄件人講清楚是哪幾個視窗、附「關掉」按鈕用的記號；
//! 本人按了之後 ASN 收到「/asn-close-dup <pid>」，只關那一個 pid（見 partner_ops/dup.rs）。
//! 原信留在信箱不 ack，剩一個視窗時下一輪收信自動照常轉交（＝自動重送）；等太久就說明沒送出、請再寄一次。
//! 判斷「同名」只看還活著、而且還是當初那個程序的 sessions 記錄（殘檔不算，見 roster::read_sessions_with）。

/// 本人按「關掉」時寄出的指令名（`/asn-close-dup <pid>`；只認本人簽章的信，見 slash.rs）
pub const CLOSE_CMD: &str = "asn-close-dup";
/// 說明信最後一行的記號開頭；畫面認得它就不顯示這行，改成每個視窗一顆「關掉」按鈕（ui/lib/dup-windows.mjs）
pub const MARK_PREFIX: &str = "〔重複視窗";
/// 原信最多留多久等使用者關掉其中一個；過了就說明沒送出、ack 掉
pub const HOLD_MAX_MS: u64 = 6 * 3_600_000;

/// 同名的其中一個視窗
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DupWin {
    pub pid: u32,
    pub session_id: String,
    /// sessions 記錄的 startedAt（毫秒；沒有＝0）
    pub started_ms: u64,
    /// ASN 開的（自帶終端或舊式承載殼）
    pub by_asn: bool,
    /// 啟動參數有 --remote-control
    pub remote: bool,
}

/// 啟動參數有沒有遠端控制
pub fn has_remote_control(args: &[String]) -> bool {
    args.iter().any(|a| a == "--remote-control" || a.starts_with("--remote-control="))
}

/// 「約 2 小時前」這類相對時間（不用時區，手機與電腦看都一樣）
pub fn ago_text(started_ms: u64, now_ms: u64) -> String {
    if started_ms == 0 {
        return "開啟時間不明".into();
    }
    let min = now_ms.saturating_sub(started_ms) / 60_000;
    match min {
        0..=1 => "剛剛開的".into(),
        2..=59 => format!("約 {min} 分鐘前開的"),
        60..=2879 => format!("約 {} 小時前開的", min / 60),
        _ => format!("約 {} 天前開的", min / 1440),
    }
}

fn same_conversation(wins: &[DupWin]) -> bool {
    wins.first().is_some_and(|f| !f.session_id.is_empty() && wins.iter().all(|w| w.session_id == f.session_id))
}

/// 建議留下哪一個：只有一個是 ASN 開、有遠端控制的才建議（1 起算）
fn keep_hint(wins: &[DupWin]) -> Option<usize> {
    let good: Vec<usize> = wins.iter().enumerate().filter(|(_, w)| w.by_asn && w.remote).map(|(i, _)| i + 1).collect();
    (good.len() == 1).then(|| good[0])
}

/// 記號行：`〔重複視窗 1=1234 2=5678〕`
pub fn mark_line(wins: &[DupWin]) -> String {
    let items: Vec<String> = wins.iter().enumerate().map(|(i, w)| format!("{}={}", i + 1, w.pid)).collect();
    format!("{MARK_PREFIX} {}〕", items.join(" "))
}

/// 給寄件人的說明。with_buttons＝寄件人是本人（看得到按鈕、按了會以本人簽章寄回指令）；AI 寄件人只拿文字
pub fn notice_text(name: &str, wins: &[DupWin], now_ms: u64, with_buttons: bool) -> String {
    let n = wins.len();
    let count = if n == 2 { "兩".to_string() } else { n.to_string() };
    let same = same_conversation(wins);
    let mut out = if same {
        format!("「{name}」同一段對話開了{count}個視窗，這封信沒送出。\n")
    } else {
        format!("這台電腦有{count}個視窗都叫「{name}」，這封信沒送出。\n")
    };
    out.push_str(if with_buttons {
        "請按下面的「關掉」關掉其中一個，剩一個時會自動重送。\n"
    } else {
        "請這台電腦的主人關掉其中一個，剩一個時會自動重送。\n"
    });
    for (i, w) in wins.iter().enumerate() {
        out.push_str(&format!(
            "{}. {}，{}，{}\n",
            i + 1,
            ago_text(w.started_ms, now_ms),
            if w.by_asn { "ASN 開的" } else { "自己開的" },
            if w.remote { "有遠端控制" } else { "沒有遠端控制" }
        ));
    }
    if let Some(k) = keep_hint(wins) {
        out.push_str(&format!("建議留下第 {k} 個（ASN 開的、有遠端控制）。\n"));
    }
    if same {
        out.push_str("以後請不要用 /resume 把夥伴的對話接到另一個視窗。\n");
    }
    if with_buttons {
        out.push_str(&mark_line(wins));
    }
    out.trim_end().to_string()
}

/// 等太久還是同名：說明這封沒送出
pub fn expired_text(name: &str) -> String {
    format!("「{name}」一直有兩個視窗，這封信沒送出，請關掉一個後再寄一次。")
}

/// `/asn-close-dup <pid>` 的參數：只收一個正整數
pub fn parse_close_args(args: &str) -> Option<u32> {
    let a = args.trim();
    if a.is_empty() || !a.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    a.parse::<u32>().ok().filter(|p| *p != 0)
}

/// 留在信箱等使用者處理的信：第一次看到記時間，之後依時間決定繼續等、或放棄
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Hold {
    /// 第一次看到：寄說明、留著
    First,
    /// 已經說明過：安靜留著
    Waiting,
    /// 等太久：說明沒送出、ack
    Expired,
}

pub fn hold_state(first_seen: Option<u64>, now_ms: u64) -> Hold {
    match first_seen {
        None => Hold::First,
        Some(t) if now_ms.saturating_sub(t) >= HOLD_MAX_MS => Hold::Expired,
        Some(_) => Hold::Waiting,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: u64 = 1_800_000_000_000;

    fn w(pid: u32, sid: &str, ago_min: u64, by_asn: bool, remote: bool) -> DupWin {
        DupWin { pid, session_id: sid.into(), started_ms: NOW - ago_min * 60_000, by_asn, remote }
    }

    #[test]
    fn 遠端控制_只認旗標本身() {
        let s = |v: &[&str]| v.iter().map(|x| x.to_string()).collect::<Vec<_>>();
        assert!(has_remote_control(&s(&["claude", "-n", "甲", "--remote-control", "甲"])));
        assert!(has_remote_control(&s(&["claude", "--remote-control=甲"])));
        assert!(!has_remote_control(&s(&["claude", "-n", "--remote-control-x"])));
        assert!(!has_remote_control(&s(&["claude", "-n", "甲"])));
    }

    #[test]
    fn 相對時間() {
        assert_eq!(ago_text(NOW - 30_000, NOW), "剛剛開的");
        assert_eq!(ago_text(NOW - 15 * 60_000, NOW), "約 15 分鐘前開的");
        assert_eq!(ago_text(NOW - 3 * 3_600_000, NOW), "約 3 小時前開的");
        assert_eq!(ago_text(NOW - 3 * 86_400_000, NOW), "約 3 天前開的");
        assert_eq!(ago_text(0, NOW), "開啟時間不明");
    }

    #[test]
    fn 同一段對話_講清楚兩個視窗_建議留_asn_開的_附按鈕記號() {
        let wins = [w(1234, "s1", 180, true, true), w(5678, "s1", 10, false, false)];
        let t = notice_text("甲", &wins, NOW, true);
        assert!(t.starts_with("「甲」同一段對話開了兩個視窗，這封信沒送出。"), "{t}");
        assert!(t.contains("1. 約 3 小時前開的，ASN 開的，有遠端控制"), "{t}");
        assert!(t.contains("2. 約 10 分鐘前開的，自己開的，沒有遠端控制"), "{t}");
        assert!(t.contains("建議留下第 1 個"), "{t}");
        assert!(t.contains("/resume"), "{t}");
        assert_eq!(t.lines().last().unwrap(), "〔重複視窗 1=1234 2=5678〕");
        assert!(!t.contains("收發室") && !t.contains("session"), "不說內部名詞：{t}");
    }

    #[test]
    fn 不同對話同名_換說法_不提_resume() {
        let wins = [w(1, "s1", 5, false, false), w(2, "s2", 5, false, false)];
        let t = notice_text("甲", &wins, NOW, true);
        assert!(t.starts_with("這台電腦有兩個視窗都叫「甲」"), "{t}");
        assert!(!t.contains("/resume") && !t.contains("建議留下"), "{t}");
    }

    #[test]
    fn ai_寄件人_沒有按鈕記號_改請主人處理() {
        let wins = [w(1, "s1", 5, true, true), w(2, "s1", 5, false, false)];
        let t = notice_text("甲", &wins, NOW, false);
        assert!(!t.contains(MARK_PREFIX) && t.contains("請這台電腦的主人"), "{t}");
    }

    #[test]
    fn 兩個都是_asn_開的_不亂建議() {
        let wins = [w(1, "s1", 5, true, true), w(2, "s1", 5, true, true), w(3, "s1", 1, false, false)];
        let t = notice_text("甲", &wins, NOW, true);
        assert!(t.contains("開了3個視窗") && !t.contains("建議留下"), "{t}");
    }

    #[test]
    fn 關閉指令參數_只收正整數() {
        assert_eq!(parse_close_args(" 1234 "), Some(1234));
        for bad in ["", "0", "-1", "12 34", "abc", "1234;rm", "99999999999"] {
            assert_eq!(parse_close_args(bad), None, "{bad}");
        }
    }

    #[test]
    fn 留信狀態_第一次說明_之後安靜_太久放棄() {
        assert_eq!(hold_state(None, NOW), Hold::First);
        assert_eq!(hold_state(Some(NOW - 60_000), NOW), Hold::Waiting);
        assert_eq!(hold_state(Some(NOW - HOLD_MAX_MS), NOW), Hold::Expired);
    }
}

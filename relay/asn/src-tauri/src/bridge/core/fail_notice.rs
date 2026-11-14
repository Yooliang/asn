//! 轉交失敗的通知：群組訊息轉交失敗時在群組留一則不點名的說明；收發室通知本身被退時不再發通知，不會連環。
//! 失敗次數固定寫 `forward-fail kind=...`，放行時用 log 統計。
use super::*;

/// 私信通知（失敗、逾時、送錯）的開頭
const MAIL_NOTICE_HEAD: &str = "[收發室] ";
/// 群組通知的開頭
const ROOM_NOTICE_HEAD: &str = "（收發室）群組訊息 #";
/// 同一個群組、同一個收件視窗，隔這麼久才再貼一則
const ROOM_NOTICE_GAP_MS: u64 = 600_000;
/// 同一個 worker 失敗到這個次數就在 log 留警告
const WORKER_FAIL_WARN_AT: u32 = 3;
/// 之後每多這麼多次再警告一次
const WORKER_FAIL_WARN_EVERY: u32 = 10;

/// 失敗原因 → 貼在群組的一句白話（#1366）。只放固定的分類，不放原文：原文可能帶檔案路徑、API 錯誤內容，群組裡不必看到。
/// 認不出來回 None（照舊的說法）
fn room_fail_reason(why: &str) -> Option<&'static str> {
    let w = why.to_lowercase();
    let has = |k: &str| why.contains(k) || w.contains(k);
    if has("需要登入") || has("登入失效") {
        Some("需要重新登入")
    } else if has("額度用完") || Core::is_payment_error(why) {
        Some("額度用完了")
    } else if has("太久沒有動靜") {
        Some("處理太久沒有動靜，已中止")
    } else if has("想做不被允許的事") || has("被政策拒絕") {
        Some("它想寫檔或執行指令，被擋下了")
    } else if has("沒有產出回覆文字") {
        Some("它沒有產出回覆")
    } else if has("沒有在跑") || has("被關閉") || has("被停止") || has("正在關閉") || has("起不來") || has("中途結束") {
        Some("它的工作者沒在跑")
    } else if has("前面還排著") {
        Some("前面排太多信，這則先沒收")
    } else {
        None
    }
}

/// 不寫 @：不點名任何人，通知不會指定叫醒誰。逾時只知道沒等到回報，信可能已經到了，說法不能講死。
/// why＝失敗原因（認得的分類會寫出來，#1366）；認不出來就照舊說「沒有轉交」
fn room_notice_text(seq: u64, target: &str, skipped: u32, timed_out: bool, reply_blocked: bool, why: &str) -> String {
    let name = target.replace('@', "");
    let what = if reply_blocked {
        format!("{name} 收到了，但它的回覆被內容過濾擋下，沒有回到群組。")
    } else if timed_out {
        format!("可能沒有轉交給 {name}。")
    } else if let Some(r) = room_fail_reason(why) {
        format!("轉交給 {name} 沒有成功：{r}。")
    } else {
        format!("沒有轉交給 {name}，對方還沒看到。")
    };
    let more = if skipped > 0 { format!("這段時間另有 {skipped} 則情況相同。") } else { String::new() };
    format!("{ROOM_NOTICE_HEAD}{seq} {what}{more}需要對方處理請重新點名，或請對方讀群組。")
}

/// 群組訊息卡在對方視窗或被拒：不寫 @，說法是「可能」（CLI 只給收件人名字）
fn room_delivery_text(seq: u64, target: &str, kind: &str, skipped: u32) -> String {
    let name = target.replace('@', "");
    let what = match kind {
        "denied" => format!("可能被 {name} 視窗的使用者拒絕了，沒有送進去。"),
        "refused" => format!("可能沒送進 {name} 視窗：對方目前不接受其他視窗的信。"),
        _ => format!("可能卡在 {name} 視窗的確認框，對方還沒看到。需要有人在那台電腦上按確認。"),
    };
    let more = if skipped > 0 { format!("這段時間另有 {skipped} 則情況相同。") } else { String::new() };
    format!("{ROOM_NOTICE_HEAD}{seq} {what}{more}收發室不會重送。")
}

#[cfg(test)]
mod notice_tests {
    use super::*;

    #[test]
    fn 群組失敗通知三種說法_沒轉交_可能沒轉交_收到了但回覆被擋下() {
        let a = room_notice_text(5, "@甲", 0, false, false, "");
        assert!(a.contains("沒有轉交給 甲，對方還沒看到") && !a.contains('@'), "{a}");
        assert!(room_notice_text(5, "甲", 0, true, false, "").contains("可能沒有轉交給 甲"));
        let c = room_notice_text(5, "甲", 2, false, true, "");
        assert!(c.contains("甲 收到了，但它的回覆被內容過濾擋下，沒有回到群組") && !c.contains("對方還沒看到") && !c.contains("沒有轉交"), "{c}");
        assert!(c.contains("另有 2 則情況相同"));
    }

    #[test]
    fn 群組失敗通知帶出原因_只寫固定的白話分類_不寫原文() {
        let cases = [
            ("Gemini審查 需要登入：帳號登入失效或還沒登入。請登入 agy", "需要重新登入"),
            ("Gemini審查 的額度用完了（或被限流），請稍後再試。", "額度用完了"),
            ("Gemini審查 處理這封信太久沒有動靜（超過 5 分鐘），已中止這一輪。", "處理太久沒有動靜"),
            ("Gemini審查 想做不被允許的事：寫入檔案（D:/Github/x/asn-gemini-review/a.html）（…）", "它想寫檔或執行指令，被擋下了"),
            ("Gemini審查 沒有產出回覆文字（它想做的事被政策拒絕了：執行指令：dir）", "它想寫檔或執行指令，被擋下了"),
            ("Gemini審查 沒有產出回覆文字", "它沒有產出回覆"),
            ("Gemini審查 工作者目前沒有在跑：…", "它的工作者沒在跑"),
            ("前面還排著 3 封信，這封先不收", "前面排太多信"),
        ];
        for (why, want) in cases {
            let t = room_notice_text(7, "Gemini審查", 0, false, false, why);
            assert!(t.contains("轉交給 Gemini審查 沒有成功") && t.contains(want), "{why} → {t}");
            assert!(!t.contains("D:/") && !t.contains("dir") && !t.contains("agy"), "不寫原文：{t}");
        }
        // 認不出來的（例如 API 502）照舊的說法，也不寫原文
        let t = room_notice_text(7, "甲", 0, false, false, "這一輪出錯：API error ... code 502");
        assert!(t.contains("沒有轉交給 甲，對方還沒看到") && !t.contains("502"), "{t}");
    }

    #[test]
    fn 群組卡住通知三種說法_不點名_都寫可能() {
        for (kind, word) in [("held", "確認框"), ("denied", "拒絕"), ("refused", "不接受")] {
            let t = room_delivery_text(5, "@甲", kind, 0);
            assert!(t.starts_with(ROOM_NOTICE_HEAD) && t.contains(word) && t.contains("可能") && !t.contains('@'), "{t}");
        }
        assert!(room_delivery_text(5, "甲", "held", 2).contains("另有 2 則情況相同"));
    }
}

impl Core {
    /// 記下這封信本身是不是收發室通知：之後被退就不再發通知。
    /// 主要看寄件名／kind（is_notice，由呼叫端用 Mail::is_system_notice 判斷）；內文字頭只是備援，
    /// 因為代夥伴寄的「轉交失敗」說明寄件名是夥伴名，只有字頭認得出來
    pub(super) fn note_if_notice(&mut self, id: &str, body: &str, is_notice: bool) {
        if is_notice || body.starts_with(MAIL_NOTICE_HEAD) || body.starts_with(ROOM_NOTICE_HEAD) {
            self.bounce_notices.insert(id.to_string());
        }
    }

    /// 失敗次數的固定字樣（每次失敗一行）
    pub(super) fn count_forward_fail(&self, kind: &str, id: &str, target: &str) {
        self.log.line(&format!("forward-fail kind={kind} id={id} target={target}"));
    }

    /// worker 回報失敗：這個 worker 累積太多次就留警告，只寫 log，要不要重開由人決定
    pub(super) fn count_worker_fail(&mut self) {
        self.worker_fails += 1;
        let n = self.worker_fails;
        if n == WORKER_FAIL_WARN_AT || (n > WORKER_FAIL_WARN_AT && (n - WORKER_FAIL_WARN_AT) % WORKER_FAIL_WARN_EVERY == 0) {
            self.log.line(&format!("WARN worker-fail-streak count={n}: this mailbox worker keeps failing forwards, consider restarting it"));
        }
    }

    /// 群組訊息轉交失敗或逾時：貼一則說明到群組，不經收發室。通知本身失敗就不再通知；同一個收件視窗有冷卻
    pub(super) async fn room_forward_failed(&mut self, id: &str, kind: &str, timed_out: bool, why: &str) {
        let Some(p) = self.idx(id).map(|i| self.pending[i].clone()) else { return };
        let Some(room) = p.room else { return };
        self.count_forward_fail(kind, id, &p.target);
        if self.bounce_notices.contains(id) {
            self.log.line(&format!("room failure notice not posted id={id}: the failed message is itself a notice"));
            return;
        }
        let key = (room.id.clone(), p.target.clone());
        let Some(skipped) = self.room_notice_turn(&key) else {
            self.log.line(&format!("room failure notice skipped id={id}: posted recently for {}", p.target));
            return;
        };
        let posted = self.post_room(&room, &room_notice_text(room.seq, &p.target, skipped, timed_out, Self::reply_blocked(why), why)).await;
        self.log.line(&format!("room failure notice room={} #{} -> {} posted={posted}", room.id, room.seq, p.target));
        if posted {
            self.room_fail_notices.insert(key, (self.now, 0));
        }
    }

    /// 群組訊息卡在對方視窗或被拒：貼一則說明。每種情況各自冷卻，卡住之後被拒絕還是貼得出來
    pub(super) async fn room_delivery_notice(&mut self, room: &RoomRef, target: &str, kind: &str) {
        let key = (room.id.clone(), format!("{kind}:{target}"));
        let Some(skipped) = self.room_notice_turn(&key) else {
            self.log.line(&format!("room delivery {kind} notice skipped room={} #{}: posted recently for {target}", room.id, room.seq));
            return;
        };
        let posted = self.post_room(room, &room_delivery_text(room.seq, target, kind, skipped)).await;
        self.log.line(&format!("room delivery {kind} notice room={} #{} -> {target} posted={posted}", room.id, room.seq));
        if posted {
            self.room_fail_notices.insert(key, (self.now, 0));
        }
    }

    /// 這個群組、這個對象現在能不能貼通知：冷卻中回 None 並記一則；能貼就回冷卻期間略過了幾則
    fn room_notice_turn(&mut self, key: &(String, String)) -> Option<u32> {
        let now = self.now;
        self.room_fail_notices.retain(|_, (t, _)| now.saturating_sub(*t) < ROOM_NOTICE_GAP_MS * 6);
        match self.room_fail_notices.get_mut(key) {
            Some((t, n)) if now.saturating_sub(*t) < ROOM_NOTICE_GAP_MS => {
                *n += 1;
                None
            }
            Some((_, n)) => Some(*n),
            None => Some(0),
        }
    }
}

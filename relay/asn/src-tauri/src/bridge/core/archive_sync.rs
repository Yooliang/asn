//! 重開機後不接回「本人已經不要的」視窗（known-windows.json 的清理）：
//! - 本人下令關閉（手機或電腦名單，都經 partner_ops 在這台執行）：關成功就從認得的夥伴拿掉；
//! - 本人封存（可能在手機或別台電腦操作，記在帳號層）：定時向後台查這台的封存名單，命中的名字拿掉，並記在存檔的 archived，
//!   封存的視窗就算還開著也不會被記回來、重開機後也不接回。本機封存會要求馬上重查（known::request_archive_refresh）。
//! 查不到（離線、舊後台沒有 archived_keys）就維持現狀，不亂拿掉；取消封存後名單換掉，視窗再被看到時自然會重新記。
use super::*;
use crate::bridge::known;
use std::collections::BTreeSet;

/// 向後台查封存名單的間隔（手機、別台電腦封存要等到下一輪才同步過來）。
/// 名單回報（roster）與夥伴對照（partner_sync）的回應都不帶封存資料，只有 list 有，所以另外查；不改後台的前提下拉長到 10 分鐘，本機封存另會立即重查
const REFRESH_MS: u64 = 600_000;

impl Core {
    pub async fn archive_tick(&mut self, now: u64) {
        self.forget_closed(now);
        if !self.cfg.archive_sync {
            return;
        }
        let forced = known::take_archive_refresh();
        if !forced && now < self.archive_next_at {
            return;
        }
        self.archive_next_at = now + REFRESH_MS;
        // 要比對的名字：認得的、現在看得到的、已經記為封存的（要看有沒有被取消）
        let mut names: BTreeSet<String> =
            self.known.entries().into_iter().map(|e| e.name).collect();
        names.extend(
            self.roster
                .iter()
                .filter(|w| w.name != self.cfg.mailbox_name)
                .map(|w| w.name.clone()),
        );
        names.extend(self.known.archived_names().iter().cloned());
        if names.is_empty() {
            return;
        }
        let names: Vec<String> = names.into_iter().collect();
        match self.relay.list().await {
            Ok(v) => {
                self.archive_warned = false;
                if let Some(set) = known::archived_among(&v, &self.cfg.node, &self.partners, &names)
                {
                    self.known.set_archived(set);
                    self.save_known_now(now);
                }
            }
            Err(e) => {
                if !self.archive_warned {
                    self.log.line(&format!(
                        "archive list failed: {e} (will keep trying quietly)"
                    ));
                    self.archive_warned = true;
                }
            }
        }
    }

    /// 本人關掉的視窗：從認得的夥伴拿掉，也不再等它接回（寄給它的信馬上退回「找不到」）
    fn forget_closed(&mut self, now: u64) {
        let Some(p) = self.partner_ops.clone() else {
            return;
        };
        let closed = p.take_closed();
        if closed.is_empty() {
            return;
        }
        for n in &closed {
            self.just_closed.mark(n, now);
            release_opening_of(&self.known, n);
            self.known.forget(n);
            self.seen_run.remove(n);
            self.missing.remove(n);
            self.awaiting.remove(n);
        }
        self.save_known_now(now);
    }

    fn save_known_now(&mut self, now: u64) {
        if let Err(e) = self
            .known
            .save_if_dirty(&self.cfg.work_dir.join(known::KNOWN_FILE), now)
        {
            self.log
                .line(&format!("known-windows.json save failed: {e}"));
        }
    }
}

/// 本人關掉視窗：解除它的「正在開」登記（對話編號從存檔記的資料找，沒有就只解除名字）。
/// 關掉之後馬上喚醒同一位不會被剛剛的登記擋住；要在 forget 之前呼叫（forget 會把對話編號一起拿掉）
fn release_opening_of(known: &known::Known, name: &str) {
    let session = known
        .entries()
        .into_iter()
        .find(|e| e.name == name)
        .map(|e| e.facts.session)
        .unwrap_or_default();
    crate::launch::opening::release(&session, name);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 關閉成功就解除登記_關掉後馬上喚醒同一位不會被擋() {
        let mut k = known::Known::default();
        k.touch("archive-test-名字", "claude", 1000);
        k.set_facts(
            "archive-test-名字",
            known::WindowFacts {
                session: "archive-test-sid".into(),
                asn_opened: true,
                ..Default::default()
            },
        );
        assert!(crate::launch::opening::claim(
            "archive-test-sid",
            "archive-test-名字"
        ));
        assert!(
            !crate::launch::opening::claim("archive-test-sid", "archive-test-名字"),
            "登記中會擋"
        );
        release_opening_of(&k, "archive-test-名字");
        assert!(
            crate::launch::opening::claim("archive-test-sid", "archive-test-名字"),
            "關閉之後解除了，喚醒不被擋"
        );
        crate::launch::opening::release("archive-test-sid", "archive-test-名字");
        // 存檔沒有這位：只解除名字
        assert!(crate::launch::opening::claim("", "archive-test-沒記到"));
        release_opening_of(&k, "archive-test-沒記到");
        assert!(crate::launch::opening::claim("", "archive-test-沒記到"));
        crate::launch::opening::release("", "archive-test-沒記到");
    }
}

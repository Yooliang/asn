//! 開窗格逾時（或回的不是窗格編號）之後，把窗格找回來（#2424 B）。
//! 逾時不代表窗格沒開：終端服務多半已經把窗格開好了，只是回得太慢。這時用剛配的工作區 `asn-{編號}` 去清單裡找，
//! 找到唯一一個就當作開成功，走原本的登記流程；有多個，分不出哪個就不登記、報失敗；清單讀不到、或這一刻還沒看到
//! （服務慢的時候窗格可能晚幾秒才出現），就把這一列放進暫時接不回，交給背景重試（`term_reclaim`）用同一個工作區認回，
//! 沒看到的那種再看一輪還沒有才移除。
#![cfg_attr(not(feature = "gui"), allow(dead_code))]

use super::wezterm::{Fs, PaneProbe, Runner, WezTerm};
use super::{pane_is_ours, view_log, StoreTerm, TermService};
use std::path::Path;

/// 逾時後找窗格的結果
#[derive(Debug, PartialEq, Eq)]
pub(super) enum Found {
    /// 清單裡剛好一個屬於這個編號的窗格
    One(u64),
    /// 清單讀成功，沒有屬於這個編號的窗格
    Missing,
    /// 清單讀成功，卻有好幾個：分不出哪個才是剛開的，不亂認
    Many(usize),
    /// 清單讀不到（原因只進 log）
    ListFailed(String),
}

/// 在這個通訊檔的窗格清單裡找屬於 `id` 的窗格：只看 ASN 自己取的名字（工作區 `asn-{編號}` 或分頁標題 `ASN:{編號}`），
/// 使用者自己開的窗格不會對上（編號是剛配的，不會跟別的窗格重複）。
/// 前提：只認 `ASN:{編號}` 標題與 `asn-{編號}` 工作區；使用者若手動把分頁標題改成一模一樣的，可能撞到。
/// 已結束的窗格（跟認領一樣，看畫面上帶暗號的結束標記）不算；讀不到畫面當作還活著
pub(super) fn find_spawned(w: &WezTerm<'_>, sock: &Path, id: &str, exit_nonce: Option<&str>) -> Found {
    match w.list(sock) {
        Err(e) => Found::ListFailed(e),
        Ok(panes) => {
            let ours: Vec<u64> = panes
                .iter()
                .filter(|p| pane_is_ours(id, p) && !matches!(w.pane_probe(sock, p.pane_id, exit_nonce), PaneProbe::Exited(_)))
                .map(|p| p.pane_id)
                .collect();
            match ours.as_slice() {
                [] => Found::Missing,
                [one] => Found::One(*one),
                many => Found::Many(many.len()),
            }
        }
    }
}

/// 開窗格逾時、窗格還沒確認時回給使用者看的話
const SLOW_MSG: &str = "終端服務回應得比較慢，這位夥伴的終端稍後會自己接回來，不用重開";

impl<R: Runner, F: Fs> TermService<R, F> {
    /// 找不回唯一窗格時的善後，回給使用者看的白話訊息。
    /// 清單讀不到、或這一刻沒看到：把這一列記成暫時接不回（寫進對照表，重開 ASN 也會再認），並叫背景重試；
    /// 有多個：不登記，直接說開不起來
    pub(super) fn settle_unsure_spawn(&self, found: Found, row: StoreTerm, why: &str) -> String {
        match found {
            Found::ListFailed(list_err) => {
                view_log(&format!("終端服務：開窗格逾時（{why}），清單也讀不到（{list_err}），先記成暫時接不回、稍後自動接回（編號 {}）", row.id));
                self.park_unsure(row, format!("開窗格逾時，窗格還沒確認：{list_err}"), false);
                SLOW_MSG.to_string()
            }
            // 清單這一刻沒看到不代表沒開：服務慢的時候窗格可能晚幾秒才出現。當作暫時接不回，
            // 交給背景重試再看一輪（連續兩輪都沒有才移除），不直接說失敗，免得留下沒人管的窗格、使用者重開又多一位
            Found::Missing | Found::One(_) => {
                view_log(&format!("終端服務：開窗格逾時（{why}），清單裡暫時沒看到這個窗格，先記成暫時接不回、稍後再確認（編號 {}）", row.id));
                self.park_unsure(row, "開窗格逾時，窗格清單裡暫時還沒看到".to_string(), true);
                SLOW_MSG.to_string()
            }
            Found::Many(n) => {
                view_log(&format!("終端服務：開窗格逾時（{why}），清單裡有 {n} 個同名窗格，分不出哪個是剛開的（編號 {}）", row.id));
                "終端服務開窗格逾時，而且分不出哪個是剛開的視窗，請到終端服務確認後再重開這位夥伴".to_string()
            }
        }
    }

    /// 把這一列放進暫時接不回（對照表與原因紀錄成對寫，重開 ASN 也會再認），寫檔，再叫背景重試起來或醒來。
    /// `absent_once`＝清單讀成功但沒看到：重試只再看一輪，還沒有才移除
    fn park_unsure(&self, row: StoreTerm, reason: String, absent_once: bool) {
        {
            let mut g = self.inner.lock().unwrap();
            let id = row.id.clone();
            g.parked.retain(|t| t.id != id);
            g.parked.push(row);
            g.parked_info.insert(id, super::reclaim_rows::ParkInfo { attempts: 1, reason, absent_since: absent_once.then(std::time::Instant::now), ..Default::default() });
        }
        if let Err(e) = self.persist() {
            elog!("開窗格逾時後寫不進終端對照表：{e}");
        }
        super::reclaim_rows::kick_retry();
    }
}

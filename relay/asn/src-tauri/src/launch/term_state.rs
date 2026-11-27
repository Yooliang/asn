//! 夥伴的終端狀態（#2424 C）：前台／後台鈕、詳情、監看啟動紀錄都讀這一份，不各看各的。
//! 只有三種：
//! - 已登記：在終端對照表的 sessions 裡，終端按鈕可以按；
//! - 暫時接不回：在 parked 裡（記著原因、背景重試中），按鈕先不能按，說明講「正在重新連上」，不叫人重開；
//! - 確定不在：兩邊都沒有，才提示重新開一次。
//!
//! 只讀記憶體裡的對照表，不叫終端、不讀畫面（聊天頁一打開就問，要快）。
#![cfg_attr(not(feature = "gui"), allow(dead_code))]

use super::wezterm::{Fs, Runner};
use super::{partner_label, TermService};
use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum TermState {
    /// 已登記
    Ok,
    /// 暫時接不回（重試中）
    Waiting,
    /// 確定不在終端服務裡
    Gone,
    /// 沒有使用終端服務（共用終端開關關著）：只給詳情用，聊天頁的按鈕不走這一種
    Off,
}

/// 給畫面的答案：狀態加上原因（原因只給 console 與 log，不直接顯示在畫面上）
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct TermStateInfo {
    pub state: TermState,
    pub reason: String,
}

impl<R: Runner, F: Fs> TermService<R, F> {
    /// 這位夥伴的終端狀態。名字不合夥伴名規則、沒開共用終端模式、對照表裡沒有它：確定不在
    pub fn partner_term_state(&self, name: &str) -> TermStateInfo {
        let gone = |why: &str| TermStateInfo { state: TermState::Gone, reason: why.to_string() };
        if !self.use_mux || !crate::launch::config::valid_partner_name(name) {
            return gone("不在共用終端服務裡");
        }
        let g = self.inner.lock().unwrap();
        if g.sessions.iter().any(|s| s.window.mux && !s.kind.is_empty() && partner_label(&s.id, &s.title) == Some(name)) {
            return TermStateInfo { state: TermState::Ok, reason: String::new() };
        }
        // 放在 parked 裡的列一律當「暫時接不回」：有記原因就用它，沒記（理論上不會發生）也不能叫人重開——
        // 重開會再開出一個，而原本那個可能還在
        let parked = g.parked.iter().find(|t| t.mux && !t.kind.is_empty() && partner_label(&t.id, &t.title) == Some(name));
        match parked {
            Some(t) => {
                let reason = g.parked_info.get(&t.id).map_or_else(|| "對照表有這位夥伴的終端，還沒接回".to_string(), |i| i.reason.clone());
                TermStateInfo { state: TermState::Waiting, reason }
            }
            None => gone("對照表裡沒有這位夥伴的終端"),
        }
    }

    /// 詳情用的終端狀態：共用終端開關關著就是 `Off`（沒有使用終端服務，不能說「沒有接上」），其餘照 `partner_term_state`
    pub fn partner_term_state_for_info(&self, name: &str) -> TermStateInfo {
        if !self.use_mux {
            return TermStateInfo { state: TermState::Off, reason: "沒有使用共用終端服務".to_string() };
        }
        self.partner_term_state(name)
    }

    /// 夥伴視窗的數量：（已登記, 暫時接不回）。啟動紀錄與「還沒接回幾位」都讀這一份
    pub fn partner_term_counts(&self) -> (usize, usize) {
        let g = self.inner.lock().unwrap();
        let ok = g.sessions.iter().filter(|s| s.window.mux && !s.kind.is_empty()).count();
        let waiting = g.parked.iter().filter(|t| t.mux && !t.kind.is_empty() && g.parked_info.contains_key(&t.id)).count();
        (ok, waiting)
    }
}

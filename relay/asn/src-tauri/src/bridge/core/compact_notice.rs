//! 壓縮 N 次自動交接（#1852）的巡檢入口：讀這台的設定（開關、次數），交給 PartnerOps 巡檢。邏輯與測試都在 compact.rs／partner_ops/compact.rs。
use super::*;

impl Core {
    pub async fn compact_handoff_tick(&mut self) {
        // 自動回信模式的橋沒有夥伴視窗要管（和其他視窗巡檢一致）
        if self.cfg.respond.is_some() {
            return;
        }
        let Some(p) = self.partner_ops.clone() else { return };
        let (enabled, n) = match self.cfg.data_dir.as_ref().map(|d| super::super::read_settings(d)) {
            Some(s) => (!s.compact_handoff_off, s.compact_handoff_n),
            None => (true, super::super::compact::N_DEFAULT),
        };
        p.compact_tick(enabled, n).await;
    }
}

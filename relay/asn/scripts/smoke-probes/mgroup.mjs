// 冒煙探測「手機群組按鈕檢查」（probe.mgroup）。scripts/smoke-probes/ 底下的檔案由 smoke-registry.mjs 自動收集（#1540）

export const mgroupProbeSource = ({ mgroup }) => `(async () => {
  const want = ${JSON.stringify(mgroup)};
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  let btn = null;
  for (let i = 0; i < 60 && !btn; i++) { btn = document.querySelector('.m-chathead .m-icon-btn[aria-label="更多操作"]'); if (!btn) await sleep(100) }
  if (!btn) return { ok: false, why: '群組對話沒有「⋯」' };
  const bars = [...document.querySelectorAll('.m-chat .actionbar, .m-chat .m-abar-row, .m-chat .abtn')].filter(e => e.offsetParent !== null);
  if (bars.length) return { ok: false, why: '群組對話還有按鈕列' };
  btn.click();
  let got = [];
  for (let i = 0; i < 30; i++) { await sleep(100); got = [...document.querySelectorAll('.m-ops-panel .m-ops-item .m-opt-t')].map(e => e.textContent.trim()); if (got.length) break }
  if (JSON.stringify(got) !== JSON.stringify(want)) return { ok: false, why: '群組選單不符：' + JSON.stringify(got) };
  return { ok: true, why: '' };
})()`

export default {
  key: 'mgroup',
  kind: '手機群組按鈕檢查',
  source: probe => mgroupProbeSource(probe),
}

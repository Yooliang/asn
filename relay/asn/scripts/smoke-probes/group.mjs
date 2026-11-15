// 冒煙探測「群組按鈕檢查」（probe.group）。scripts/smoke-probes/ 底下的檔案由 smoke-registry.mjs 自動收集（#1540）

export const groupProbeSource = ({ group }) => `(async () => {
  const want = ${JSON.stringify(group)};
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const shown = sel => [...document.querySelectorAll(sel)].filter(e => e.offsetParent !== null);
  const menuText = () => [...document.querySelectorAll('.ab-menu')].flatMap(m => [...m.querySelectorAll('.mi-t')].map(e => e.textContent.trim()));
  const esc = () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
  let btn = null;
  for (let i = 0; i < 60 && !btn; i++) { btn = shown('.actionbar .abtn[data-slot="group"]')[0] || null; if (!btn) await sleep(100) }
  if (!btn) return { ok: false, why: '群組分頁沒有「群組」按鈕' };
  if (btn.hasAttribute('disabled')) return { ok: false, why: '「群組」按鈕不能用 disabled' };
  btn.click(); await sleep(200);
  const got = menuText();
  if (JSON.stringify(got) !== JSON.stringify(want)) return { ok: false, why: '群組選單不符：' + JSON.stringify(got) };
  esc(); await sleep(150);
  const mg = shown('.actionbar .abtn[data-slot="manage"]')[0];
  if (mg) {
    mg.click(); await sleep(200);
    const left = menuText().filter(t => want.includes(t));
    esc();
    if (left.length) return { ok: false, why: '「管理」裡還有：' + left.join('、') };
  }
  return { ok: true, why: '' };
})()`

export default {
  key: 'group',
  kind: '群組按鈕檢查',
  source: probe => groupProbeSource(probe),
}

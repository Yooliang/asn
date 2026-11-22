// 冒煙探測「額度畫面檢查」（probe.quota）。scripts/smoke-probes/ 底下的檔案由 smoke-registry.mjs 自動收集（#1540）

export const quotaProbeSource = ({ quota, open = '', want, absent = {}, trackPx = 0 }) => `(async () => {
  const sel = ${JSON.stringify(quota)}, open = ${JSON.stringify(open)}, want = ${JSON.stringify(want)}, absent = ${JSON.stringify(absent)};
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  if (open) {
    let btn = null;
    for (let i = 0; i < 60 && !btn; i++) { btn = [...document.querySelectorAll('.m-row-btn')].find(b => b.textContent.includes(open)) || null; if (!btn) await sleep(100) }
    if (!btn) return { ok: false, why: '找不到「' + open + '」' };
    btn.click();
  }
  let why = '';
  for (let i = 0; i < 60; i++) {
    const box = document.querySelector(sel);
    why = box ? '' : '找不到「我的帳號」區';
    if (box) for (const [v, parts] of Object.entries(want)) {
      const el = box.querySelector('[data-vendor="' + v + '"]');
      const text = el ? el.textContent.replace(/\\s+/g, ' ') : '';
      let at = 0;
      for (const p of parts) { const k = text.indexOf(p, at); if (k < 0) { why = (el ? v + ' 少了「' + p + '」：' + text : '沒有 ' + v + ' 這一組'); break } at = k + p.length }
      if (!why) for (const p of absent[v] ?? []) if (text.includes(p)) { why = v + ' 不該出現「' + p + '」：' + text; break }
      if (why) break;
    }
    if (!why && ${JSON.stringify(trackPx)}) {
      const w = [...box.querySelectorAll('.dv-track, .m-dv-track')].filter(e => e.offsetParent !== null).map(e => Math.round(e.getBoundingClientRect().width));
      if (w.length < 2) why = '額度條少於 2 條：' + w.length;
      else if (w.some(x => x !== ${JSON.stringify(trackPx)})) why = '額度條寬度不是固定的 ' + ${JSON.stringify(trackPx)} + 'px：' + w.join(',');
    }
    if (!why) return { ok: true, why: '' };
    await sleep(100);
  }
  return { ok: false, why };
})()`

export default {
  key: 'quota',
  kind: '額度畫面檢查',
  source: probe => quotaProbeSource(probe),
}

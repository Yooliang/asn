// 冒煙探測「看大圖縮放檢查」（probe.photoZoom）。scripts/smoke-probes/ 底下的檔案由 smoke-registry.mjs 自動收集（#1540）

export const photoZoomProbeSource = mode => `(async () => {
  try {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const real = req => { globalThis.__smokeInput(JSON.stringify(req)); return sleep(400) };
  const at = el => { const r = el.getBoundingClientRect(); return [Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2)] };
  const pv = () => document.querySelector('.photo-viewer img.pv-img');
  const w = () => pv().getBoundingClientRect().width;
  const near = (a, b) => Math.abs(a - b) <= Math.max(2, b * 0.04);
  async function openIt() {
    let btn = null;
    for (let i = 0; i < 60 && !btn; i++) { btn = [...document.querySelectorAll('.chatpane button.photo')].find(e => e.getClientRects().length); if (!btn) await sleep(100) }
    if (!btn) return '對話裡找不到照片';
    btn.scrollIntoView({ block: 'center' }); await sleep(150);
    await real({ click: at(btn) });
    for (let i = 0; i < 40; i++) { const img = pv(); if (img && img.complete && img.naturalWidth) return ''; await sleep(100) }
    return '點照片沒有打開大圖';
  }
  let bad = await openIt();
  if (bad) return { ok: false, why: bad };
  const w0 = w();
  if (w0 < 50) return { ok: false, why: '大圖太小：' + w0 };
  if (${JSON.stringify(mode)} === 'touch') {
    await real({ pinch: [...at(pv()), 80, 200] });
    if (!(w() > w0 * 2)) return { ok: false, why: '雙指捏合沒有放大：' + w0 + ' → ' + w() };
    await real({ tap2: at(pv()) });
    if (!near(w(), w0)) return { ok: false, why: '放大時點兩下沒有還原：' + w() };
    await real({ tap2: at(pv()) });
    if (!near(w(), w0 * 2.5)) return { ok: false, why: '點兩下沒有放大到 2.5 倍：' + w() };
  } else {
    await real({ wheel: [...at(pv()), -400] });
    if (!(w() > w0 * 1.4)) return { ok: false, why: '滾輪沒有放大：' + w0 + ' → ' + w() };
    const c1 = at(pv());
    await real({ drag: [c1[0], c1[1], c1[0] + 60, c1[1] + 30] });
    const c2 = at(pv());
    if (!(c2[0] - c1[0] > 40)) return { ok: false, why: '放大後拖曳沒有跟著移動：' + c1 + ' → ' + c2 };
    await real({ dblclick: at(pv()) });
    if (!near(w(), w0)) return { ok: false, why: '放大時雙擊沒有還原：' + w() };
    await real({ dblclick: at(pv()) });
    if (!near(w(), w0 * 2.5)) return { ok: false, why: '雙擊沒有放大到 2.5 倍：' + w() };
  }
  const close = [...document.querySelectorAll('.photo-viewer .pv-bar button')].find(b => b.getAttribute('aria-label') === '關閉');
  if (!close) return { ok: false, why: '找不到「關閉」' };
  await real({ click: at(close) });
  if (document.querySelector('.photo-viewer')) return { ok: false, why: '按「關閉」沒有關掉' };
  bad = await openIt();
  if (bad) return { ok: false, why: '再開一次：' + bad };
  if (!near(w(), w0)) return { ok: false, why: '關掉再打開沒有回到原本大小：' + w0 + ' → ' + w() };
  return { ok: true, why: '' };
  } catch (e) { return { ok: false, why: '檢查出錯：' + (e && e.message || e) } }
})()`

export default {
  key: 'photoZoom',
  kind: '看大圖縮放檢查',
  source: probe => photoZoomProbeSource(probe.photoZoom),
}

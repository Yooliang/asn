// 冒煙探測「手機設備清單每列直接有詳情」（probe.devSel）。scripts/smoke-probes/ 底下的檔案由 smoke-registry.mjs 自動收集（#1540）

// 手機設備頁（#1860）：每列右邊直接一顆「詳情」，不用先點一列展開；沒有上移／下移鈕。全部用真觸控：
// 手指滑過列只是捲動、不會進詳情；點「詳情」進那台的頁面、返回回到清單；拖拉把手不會進詳情
export const devSelProbeSource = () => `(async () => {
  try {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const vis = e => !!e && e.getClientRects().length > 0 && getComputedStyle(e).display !== 'none';
  const at = el => { const r = el.getBoundingClientRect(); return [Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2)] };
  const real = async (req, ms) => { globalThis.__smokeInput(JSON.stringify(req)); await sleep(ms || 400) };
  const tap = async el => { el.scrollIntoView({ block: 'center' }); await sleep(150); await real({ hold: [...at(el), 60] }) };
  let btn = null;
  for (let i = 0; i < 60 && !btn; i++) { btn = [...document.querySelectorAll('.m-row-btn')].find(b => vis(b) && b.textContent.includes('設備')) || null; if (!btn) await sleep(100) }
  if (!btn) return { ok: false, why: '找不到設定裡的「設備」' };
  await real({ click: at(btn) });
  const rows = () => [...document.querySelectorAll('.m-dv-row')].filter(vis);
  for (let i = 0; i < 60 && rows().length < 3; i++) await sleep(100);
  if (rows().length < 3) return { ok: false, why: '設備列少於 3 列' };
  const row = name => rows().find(r => (r.querySelector('.m-dv-rn b')?.textContent ?? '').trim() === name);
  const detailBtn = r => [...r.querySelectorAll('button')].find(b => b.textContent.trim() === '詳情');
  if (rows().some(r => !detailBtn(r))) return { ok: false, why: '有的設備列沒有直接的「詳情」鈕' };
  if (rows().some(r => [...r.querySelectorAll('button')].some(b => /上移|下移/.test(b.textContent)))) return { ok: false, why: '設備列上不該再有上移／下移' };
  await real({ touch: true }, 100);
  // 一、手指滑過列（捲動）：不會進詳情
  const office = row('辦公室');
  office.scrollIntoView({ block: 'center' }); await sleep(150);
  let scroller = office.parentElement;
  while (scroller && !(scroller.scrollHeight > scroller.clientHeight + 1 && ['auto', 'scroll'].includes(getComputedStyle(scroller).overflowY))) scroller = scroller.parentElement;
  if (!scroller) return { ok: false, why: '設備清單沒有可以捲動的外層，測不到「捲動不會進詳情」（情境的高度要再小一點）' };
  const top0 = scroller.scrollTop;
  { const c = at(office.querySelector('.m-dv-rowinfo')); await real({ gesture: [c[0], c[1], 0, -90] }, 600) }
  if (!(scroller.scrollTop > top0 + 4)) return { ok: false, why: '手指往上滑沒有真的捲動：scrollTop ' + top0 + ' → ' + scroller.scrollTop };
  if (!rows().length) return { ok: false, why: '手指滑過列（捲動）就進了詳情' };
  // 二、拖拉把手：不會進詳情
  const grip = row('工作機').querySelector('.m-dv-grip');
  if (grip) { const c = at(grip); await real({ gesture: [c[0], c[1], 0, 60] }, 600) }
  if (!rows().length) return { ok: false, why: '拖拉把手就進了詳情' };
  // 三、點「詳情」進那台的頁面，返回回到清單
  await tap(detailBtn(row('工作機')));
  let back = null;
  for (let i = 0; i < 30 && !back; i++) { back = [...document.querySelectorAll('.m-icon-btn[aria-label="返回"]')].find(vis) || null; if (!back) await sleep(100) }
  if (!back || rows().length) return { ok: false, why: '按「詳情」沒有進到那台的頁面' };
  await tap(back);
  for (let i = 0; i < 30 && rows().length < 3; i++) await sleep(100);
  if (rows().length < 3) return { ok: false, why: '從詳情返回後沒有回到設備清單' };
  await real({ touch: false }, 100);
  return { ok: true, why: '' };
  } catch (e) { return { ok: false, why: '檢查出錯：' + (e && e.message || e) } }
})()`

export default {
  key: 'devSel',
  kind: '手機設備清單每列直接有詳情檢查',
  source: () => devSelProbeSource(),
}

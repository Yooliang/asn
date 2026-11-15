// 冒煙探測「下載中進度條檢查」（probe.updDl）。scripts/smoke-probes/ 底下的檔案由 smoke-registry.mjs 自動收集（#1540）

// 下載中（#1526）：按通知列的「更新」（真點擊），再推下載進度事件到 pct%；進度條要直角、依百分比填滿、文字（%、MB）保留、左右和分頁對齊
export const UPD_DL_TOTAL = Math.round(38.3 * 1048576)

export const updDlProbeSource = pct => `(async () => {
  try {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const vis = e => !!e && e.getClientRects().length > 0;
  const at = el => { const r = el.getBoundingClientRect(); return [Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2)] };
  const T = ${UPD_DL_TOTAL}, pct = ${pct};
  let btn = null;
  for (let i = 0; i < 60 && !btn; i++) { btn = [...document.querySelectorAll('.upd-bar .upd-btn')].find(b => vis(b) && b.textContent.trim() === '更新') || null; if (!btn) await sleep(100) }
  if (!btn) return { ok: false, why: '找不到通知列的「更新」' };
  globalThis.__smokeInput(JSON.stringify({ click: at(btn) })); await sleep(300);
  const bar = document.querySelector('.upd-bar.dl'), prog = bar && bar.querySelector('.upd-prog');
  if (!vis(prog)) return { ok: false, why: '按「更新」後沒有出現進度條' };
  if (bar.querySelector('.upd-btn')) return { ok: false, why: '下載中不該有按鈕' };
  const emit = done => { for (const fn of ((globalThis.__smokeListeners || {})['update-progress'] || [])) fn({ event: 'update-progress', payload: { done, total: T } }) };
  if (pct > 0) { emit(Math.ceil(T / 100)); await sleep(100) }
  const done = Math.ceil(T * pct / 100);
  emit(done); await sleep(500);
  const fill = prog.querySelector('.upd-fill'), text = prog.querySelector('.upd-text');
  const want = '下載中 ' + pct + '%（' + (done / 1048576).toFixed(1) + ' / 38.3 MB）';
  if (!text || text.textContent.trim() !== want) return { ok: false, why: '進度文字不對：' + (text && text.textContent.trim()) + '（應該是 ' + want + '）' };
  if (text.scrollWidth > text.clientWidth + 1) return { ok: false, why: '進度文字被截掉' };
  if (prog.getAttribute('aria-valuenow') !== String(pct)) return { ok: false, why: '進度條的 aria-valuenow 不是 ' + pct };
  const fw = fill.getBoundingClientRect().width, inner = prog.clientWidth;
  if (Math.abs(fw - inner * pct / 100) > 1) return { ok: false, why: '填滿寬度不對：' + Math.round(fw) + ' ／ ' + inner + '（' + pct + '%）' };
  for (const [el, name] of [[bar, '通知列'], [prog, '進度條'], [fill, '填滿']]) if (getComputedStyle(el).borderTopLeftRadius !== '0px' || getComputedStyle(el).borderBottomRightRadius !== '0px') return { ok: false, why: name + '不是直角' };
  const P = prog.getBoundingClientRect();
  const tabs = [...document.querySelectorAll('.top-tabs .ttab')].filter(vis);
  if (tabs.length < 2) return { ok: false, why: '找不到分頁' };
  const a = tabs[0].getBoundingClientRect(), b = tabs[tabs.length - 1].getBoundingClientRect();
  if (Math.abs(a.top - b.top) < 1) {
    if (Math.abs(P.left - a.left) > 1 || Math.abs(P.right - b.right) > 1) return { ok: false, why: '進度條左右沒和分頁對齊：進度條 ' + Math.round(P.left) + '～' + Math.round(P.right) + '、分頁 ' + Math.round(a.left) + '～' + Math.round(b.right) };
  } else {
    // LINE：分頁是左側直排圖示欄，進度條對齊右邊名單欄的左右（各留 8px，跟名單欄的內距一樣）
    const rail = document.querySelector('.top-tabs').getBoundingClientRect(), pane = document.querySelector('.list-pane').getBoundingClientRect();
    if (Math.abs(P.left - (rail.right + 8)) > 1 || Math.abs(P.right - (pane.right - 8)) > 1) return { ok: false, why: '進度條沒對齊名單欄：' + Math.round(P.left) + '～' + Math.round(P.right) + '、名單欄 ' + Math.round(rail.right) + '～' + Math.round(pane.right) };
  }
  return { ok: true, why: '' };
  } catch (e) { return { ok: false, why: '檢查出錯：' + (e && e.message || e) } }
})()`

export default {
  key: 'updDl',
  has: probe => probe.updDl !== undefined,
  kind: '下載中進度條檢查',
  source: probe => updDlProbeSource(probe.updDl),
}

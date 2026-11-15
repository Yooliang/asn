// 冒煙探測「設備「更多」收起檢查」（probe.devMore）。scripts/smoke-probes/ 底下的檔案由 smoke-registry.mjs 自動收集（#1540）

export const devMoreProbeSource = () => `(async () => {
  try {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const real = req => { globalThis.__smokeInput(JSON.stringify(req)); return sleep(350) };
  const at = el => { const r = el.getBoundingClientRect(); return [Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2)] };
  let btn = null;
  for (let i = 0; i < 60 && !btn; i++) { btn = document.querySelector('.rail .more-wrap > .rtab'); if (!btn) await sleep(100) }
  if (!btn) return { ok: false, why: '設備多於 6 台，左邊應該有「⋯」' };
  const open = () => !!document.querySelector('.rail .more-pop');
  await real({ click: at(btn) });
  if (!open()) return { ok: false, why: '按「⋯」沒有打開小清單' };
  if (document.querySelectorAll('.rail .more-pop li').length < 1) return { ok: false, why: '小清單是空的' };
  // 1. 點旁邊（名單區）
  const pane = document.querySelector('.content');
  const pr = pane.getBoundingClientRect();
  await real({ click: [Math.round(pr.right - 40), Math.round(pr.bottom - 40)] });
  if (open()) return { ok: false, why: '點旁邊，小清單沒有收起來' };
  // 2. 再打開，按 Esc
  await real({ click: at(btn) });
  if (!open()) return { ok: false, why: '第二次按「⋯」沒有打開' };
  await real({ key: 'Escape' });
  if (open()) return { ok: false, why: '按 Esc，小清單沒有收起來' };
  // 3. 再打開，點上面的分頁切到「設定」，再切回「夥伴」
  await real({ click: at(btn) });
  if (!open()) return { ok: false, why: '第三次按「⋯」沒有打開' };
  const tabs = [...document.querySelectorAll('.top-tabs .ttab')];
  await real({ click: at(tabs.find(t => t.textContent.trim() === '設定')) });
  await real({ click: at(tabs.find(t => t.textContent.trim() === '夥伴')) });
  if (open()) return { ok: false, why: '切到別的分頁再回來，小清單不該還開著' };
  btn = document.querySelector('.rail .more-wrap > .rtab');   // 切分頁時左邊那排重新畫過，要重新找
  if (!btn) return { ok: false, why: '切回夥伴後找不到「⋯」' };
  // 4. 再打開，按「⋯」本身要收起（原本的開關照舊）；點清單裡的一台會切過去並收起
  await real({ click: at(btn) });
  await real({ click: at(btn) });
  if (open()) return { ok: false, why: '再按一次「⋯」應該收起' };
  await real({ click: at(btn) });
  const item = document.querySelector('.rail .more-pop li button');
  await real({ click: at(item) });
  if (open()) return { ok: false, why: '點清單裡的一台，小清單要收起' };
  if (!btn.classList.contains('on')) return { ok: false, why: '點清單裡的一台，應該切到那台（「⋯」標成目前所在）' };
  return { ok: true, why: '' };
  } catch (e) { return { ok: false, why: '探測出錯：' + e.message } }
})()`

export default {
  key: 'devMore',
  kind: '設備「更多」收起檢查',
  source: () => devMoreProbeSource(),
}

// 冒煙探測「釘選徽章不蓋住搜尋框」（probe.pinScroll，#1658）。scripts/smoke-probes/ 底下的檔案由 smoke-registry.mjs 自動收集（#1540）
// 手機夥伴頁：釘選的對話在名單最上面，往上捲時它頭像右下角的藍色圖釘徽章要被固定在頂端的搜尋列蓋住，不能浮到搜尋框上面。
// 做法：名單捲到釘選那幾列的徽章正好和搜尋列重疊，再把徽章暫時改成可點到（它平常 pointer-events:none，點不到就量不出誰在上面），
// 在重疊處用 elementFromPoint 看最上面的是誰：必須是搜尋列（或它裡面的東西），不能是徽章。捲動用真手指。
// 復古 Aero、現代、line 三種外觀各一張；舊程式（徽章 z-index 和搜尋列一樣高，又排在後面）一定紅。

export const pinScrollProbeSource = () => `(async () => {
  try {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const vis = e => !!e && e.getClientRects().length > 0 && getComputedStyle(e).display !== 'none';
  const real = async (req, ms) => { globalThis.__smokeInput(JSON.stringify(req)); await sleep(ms || 500) };
  const waitFor = async (fn, n = 60) => { for (let i = 0; i < n; i++) { const v = fn(); if (v) return v; await sleep(100) } return null };
  const page = () => document.querySelector('section.m-pg[aria-label="夥伴"]');
  if (!(await waitFor(() => page() && page().querySelectorAll('.m-buddy').length >= 8))) return { ok: false, why: '夥伴頁沒有列出足夠的夥伴（要能捲動）' };
  const dots = () => [...page().querySelectorAll('.pin-dot')].filter(vis);
  if (dots().length < 2) return { ok: false, why: '沒有兩個以上的釘選徽章（情境沒有釘到）：' + dots().length };
  const search = page().querySelector('.m-search');
  if (!search) return { ok: false, why: '找不到頂端的搜尋列' };
  // 找可以捲的外層
  let scroller = search.parentElement;
  while (scroller && !(scroller.scrollHeight > scroller.clientHeight + 1 && ['auto', 'scroll'].includes(getComputedStyle(scroller).overflowY))) scroller = scroller.parentElement;
  if (!scroller) return { ok: false, why: '名單沒有可以捲動的外層（情境的高度要再小一點）' };
  const stat = () => { const s = search.getBoundingClientRect(); return dots().map(d => ({ d, r: d.getBoundingClientRect() })).filter(x => x.r.bottom > s.top + 2 && x.r.top < s.bottom - 2 && x.r.right > s.left && x.r.left < s.right) };
  // 手指往上滑，慢慢滑到有徽章和搜尋列重疊（最多滑 12 次）
  let hit = stat();
  for (let i = 0; i < 12 && !hit.length; i++) {
    const r = scroller.getBoundingClientRect();
    await real({ gesture: [Math.round(r.left + r.width / 2), Math.round(r.top + r.height * 0.75), 0, -28] }, 450);
    hit = stat();
  }
  if (!hit.length) return { ok: false, why: '捲動後沒有任何釘選徽章和搜尋列重疊，量不出（scrollTop ' + scroller.scrollTop + '）' };
  const s = search.getBoundingClientRect();
  for (const x of hit) x.d.style.pointerEvents = 'auto';
  const bad = [];
  for (const x of hit) {
    // 取徽章和搜尋列重疊區的中心點
    const top = Math.max(x.r.top, s.top), bottom = Math.min(x.r.bottom, s.bottom), left = Math.max(x.r.left, s.left), right = Math.min(x.r.right, s.right);
    const px = Math.round((left + right) / 2), py = Math.round((top + bottom) / 2);
    const el = document.elementFromPoint(px, py);
    if (!el || !(el === search || search.contains(el))) bad.push((el && (el.className || el.tagName)) + '');
  }
  for (const x of hit) x.d.style.pointerEvents = '';
  if (bad.length) return { ok: false, why: '釘選徽章浮在搜尋列上面（重疊處最上面是：' + bad.join('、') + '）' };
  // 徽章還在頭像上：沒重疊時（捲回頂端）徽章仍在它那個頭像的下半部
  scroller.scrollTop = 0; await sleep(300);
  const d0 = dots()[0], wrap = d0 && d0.closest('.m-av-wrap, .avb');
  if (!d0 || !wrap) return { ok: false, why: '捲回頂端後徽章不在頭像上' };
  const a = d0.getBoundingClientRect(), w = wrap.getBoundingClientRect();
  // 復古 Aero 的廠商小方塊佔右下角時徽章在左下角：只看它還貼在頭像的下半部、沒跑出頭像外一個徽章寬
  const cx = (a.left + a.right) / 2, cy = (a.top + a.bottom) / 2;
  if (!(cy > w.top + w.height / 2 && cy < w.bottom + 8 && cx > w.left - 8 && cx < w.right + 8)) return { ok: false, why: '徽章不在頭像的下半部（位置被動到）' };
  return { ok: true, why: '' };
  } catch (e) { return { ok: false, why: '檢查出錯：' + (e && e.message || e) } }
})()`

const NAMES = ['甲', '乙', '丙', '丁', '戊', '己', '庚', '辛', '壬', '癸']
const MEMBERS = [{ id: 'Q', name: '辦公室', agents: NAMES.map(n => ({ name: '夥伴' + n, status: 'idle', cwd_label: 'w' })) }]
const PINS = { pins: [{ id: 'Q/夥伴甲', at: 1000 }, { id: 'Q/夥伴乙', at: 2000 }, { id: 'Q/夥伴丙', at: 3000 }], unpinned: [], rev: 3 }

const phone = (name, skin) => ({ name, page: 'm.html', height: 520, state: { signedIn: true, pinScroll: true, ...(skin ? { skin } : {}) }, ready: '#app.m .m-buddy', probe: { pinScroll: true }, shot: `${name}.png` })

export default {
  key: 'pinScroll',
  kind: '釘選徽章不蓋住搜尋框檢查',
  source: () => pinScrollProbeSource(),
  scenarios: [phone('m-pin-scroll'), phone('m-pin-scroll-modern', 'modern'), phone('m-pin-scroll-line', 'line')],
  table: (scenario, t) => (scenario.state?.pinScroll
    ? {
      relay_list: { members: MEMBERS },
      store_load: { ...t.store_load, values: { ...t.store_load.values, me: JSON.stringify({ navTab: 'list', ...(scenario.state.skin ? {} : {}), mobilePrefs: { chatPins: PINS } }) } },
    }
    : undefined),
}

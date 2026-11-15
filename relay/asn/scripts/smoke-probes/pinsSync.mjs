// 冒煙探測「釘選帳號同步檢查」（probe.pinsSync，#1479 第二部分）。scripts/smoke-probes/ 底下的檔案由 smoke-registry.mjs 自動收集（#1540）
// 用假後台（table 裡給 auth_chat_pins_get／auth_chat_pins_set 的回應）：
//   本機（手機存檔 mobilePrefs.chatPins）釘了 demo，帳號層（假後台）已經有釘了小工 → 開啟後同步一次，兩個都在夥伴頁最上面的「釘選」那一組，
//   依釘選時間由早到晚（demo、小工）；有搜尋字時「釘選」那一組照搜尋條件過濾、仍在最上面（不是整組藏起來）。
// 還沒跑過：工作機要等 0.2.26 建置結束才能跑冒煙，先寫好，之後在別台或建置結束後補跑。

const SOURCE = () => `(async () => {
  try {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const vis = e => !!e && e.getClientRects().length > 0 && getComputedStyle(e).display !== 'none';
  const txt = e => (e?.textContent || '').replace(/\\s+/g, ' ').trim();
  const waitFor = async (fn, n = 80) => { for (let i = 0; i < n; i++) { const v = fn(); if (v) return v; await sleep(100) } return null };
  const page = () => document.querySelector('section.m-pg[aria-label="夥伴"]');
  const pinnedGroup = () => page()?.querySelector('.m-pinned');
  const pinnedNames = () => [...(pinnedGroup()?.querySelectorAll('li .m-buddy') || [])].filter(vis).map(b => txt(b.querySelector('.b-nick')));
  if (!(await waitFor(() => pinnedNames().length >= 2))) return { ok: false, why: '本機釘 demo、帳號層釘小工，同步後「釘選」那一組要有兩個，實際：' + JSON.stringify(pinnedNames()) };
  if (JSON.stringify(pinnedNames()) !== JSON.stringify(['demo', '小工'])) return { ok: false, why: '依釘選時間由早到晚要是 demo、小工，實際：' + JSON.stringify(pinnedNames()) };
  if (page().querySelector('.m-group') !== pinnedGroup()) return { ok: false, why: '「釘選」那一組要在夥伴頁最上面' };
  // 搜尋：釘選那一組照條件過濾、仍排最上面
  const box = page().querySelector('.m-search input');
  if (!box) return { ok: false, why: '夥伴頁沒有搜尋框' };
  box.value = '小工'; box.dispatchEvent(new Event('input', { bubbles: true })); await sleep(400);
  if (!pinnedGroup()) return { ok: false, why: '有搜尋字時「釘選」那一組不該整組藏起來' };
  if (JSON.stringify(pinnedNames()) !== JSON.stringify(['小工'])) return { ok: false, why: '搜尋「小工」時，釘選那一組只該剩小工，實際：' + JSON.stringify(pinnedNames()) };
  if (page().querySelector('.m-group') !== pinnedGroup()) return { ok: false, why: '有搜尋字時「釘選」那一組仍要在最上面' };
  box.value = '不存在的名字'; box.dispatchEvent(new Event('input', { bubbles: true })); await sleep(400);
  if (pinnedGroup()) return { ok: false, why: '搜尋沒有符合的釘選時，那一組要消失' };
  box.value = ''; box.dispatchEvent(new Event('input', { bubbles: true })); await sleep(400);
  if (JSON.stringify(pinnedNames()) !== JSON.stringify(['demo', '小工'])) return { ok: false, why: '清掉搜尋字後兩個都要回來，實際：' + JSON.stringify(pinnedNames()) };
  return { ok: true, why: '' };
  } catch (e) { return { ok: false, why: '檢查出錯：' + (e && e.message || e) } }
})()`

const MEMBERS = [{ id: 'Q', name: '辦公室', agents: [{ name: 'demo', status: 'idle', cwd_label: 'demo' }, { name: '小工', status: 'idle', cwd_label: 'work' }] }]
const LOCAL = { navTab: 'list', mobilePrefs: { chatPins: { pins: [{ id: 'Q/demo', at: 1_763_000_000_000 }], unpinned: [], rev: 1 } } }
const REMOTE = { pins: [{ id: 'Q/小工', at: 1_763_000_100_000 }], unpinned: [], rev: 4, at: 1_763_000_100_000 }
const MERGED = { pins: [{ id: 'Q/demo', at: 1_763_000_000_000 }, { id: 'Q/小工', at: 1_763_000_100_000 }], unpinned: [], rev: 5, at: 1_763_000_200_000 }

const phone = (name, skin) => ({ name, page: 'm.html', state: { signedIn: true, pinsSync: true, ...(skin ? { skin } : {}) }, ready: '#app.m .m-pager .m-search', probe: { pinsSync: true }, shot: `${name}.png` })

export default {
  key: 'pinsSync',
  kind: '釘選帳號同步檢查',
  source: () => SOURCE(),
  scenarios: [phone('m-pins-sync'), phone('m-pins-sync-modern', 'modern'), phone('m-pins-sync-line', 'line')],
  table: (scenario, t) => (scenario.state?.pinsSync
    ? {
      relay_list: { members: MEMBERS },
      store_load: { ...t.store_load, values: { ...t.store_load.values, me: JSON.stringify(LOCAL) } },
      auth_chat_pins_get: { pins: REMOTE },
      auth_chat_pins_set: { pins: MERGED, stale: false, rate_limited: false },
    }
    : undefined),
}

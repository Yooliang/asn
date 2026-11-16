// 冒煙探測「釘選帳號同步檢查」（probe.pinsSync，#1479 第二部分）。scripts/smoke-probes/ 底下的檔案由 smoke-registry.mjs 自動收集（#1540）
// 用假後台（table 裡給 auth_chat_pins_get／auth_chat_pins_set 的回應）：
//   本機（手機存檔 mobilePrefs.chatPins）釘了 demo，帳號層（假後台）已經有釘了小工 → 開啟後同步一次，兩個都在夥伴頁最上面的「釘選」那一組，
//   依釘選時間由早到晚（demo、小工）；有搜尋字時「釘選」那一組照搜尋條件過濾、仍在最上面（不是整組藏起來）。
//   搜尋用真輸入：真點搜尋框、真打字（{ text }）、清空是全選後真按刪除鍵（{ key: 'Backspace' }）。
// 電腦版（desk）：本機 asn-me.json 的 chatPins 釘了 demo，假後台已釘小工 → 開啟同步後，「對話」分頁兩個都排在最上面、都有圖釘徽章。

const SOURCE = () => `(async () => {
  try {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const vis = e => !!e && e.getClientRects().length > 0 && getComputedStyle(e).display !== 'none';
  const txt = e => (e?.textContent || '').replace(/\\s+/g, ' ').trim();
  const waitFor = async (fn, n = 80) => { for (let i = 0; i < n; i++) { const v = fn(); if (v) return v; await sleep(100) } return null };
  const at = el => { const r = el.getBoundingClientRect(); return [Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2)] };
  const real = async (req, ms) => { globalThis.__smokeInput(JSON.stringify(req)); await sleep(ms || 400) };
  const page = () => document.querySelector('section.m-pg[aria-label="夥伴"]');
  const pinnedGroup = () => page()?.querySelector('.m-pinned');
  const pinnedNames = () => [...(pinnedGroup()?.querySelectorAll('li .m-buddy') || [])].filter(vis).map(b => txt(b.querySelector('.b-nick')));
  if (!(await waitFor(() => pinnedNames().length >= 2))) return { ok: false, why: '本機釘 demo、帳號層釘小工，同步後「釘選」那一組要有兩個，實際：' + JSON.stringify(pinnedNames()) };
  if (JSON.stringify(pinnedNames()) !== JSON.stringify(['demo', '小工'])) return { ok: false, why: '依釘選時間由早到晚要是 demo、小工，實際：' + JSON.stringify(pinnedNames()) };
  if (page().querySelector('.m-group') !== pinnedGroup()) return { ok: false, why: '「釘選」那一組要在夥伴頁最上面' };
  // 搜尋：釘選那一組照條件過濾、仍排最上面
  const box = page().querySelector('.m-search input');
  if (!box) return { ok: false, why: '夥伴頁沒有搜尋框' };
  // 真點搜尋框、真打字；清空＝點一下、全選（只是用 DOM 設選取範圍）、真按刪除鍵
  const typeInto = async text => { await real({ click: at(box) }, 300); await real({ text }, 500) };
  const clearBox = async () => { await real({ click: at(box) }, 300); box.select(); await real({ key: 'Backspace' }, 500); return box.value === '' };
  await typeInto('小工');
  if (box.value !== '小工') return { ok: false, why: '真打字沒有打進搜尋框：' + JSON.stringify(box.value) };
  if (!pinnedGroup()) return { ok: false, why: '有搜尋字時「釘選」那一組不該整組藏起來' };
  if (JSON.stringify(pinnedNames()) !== JSON.stringify(['小工'])) return { ok: false, why: '搜尋「小工」時，釘選那一組只該剩小工，實際：' + JSON.stringify(pinnedNames()) };
  if (page().querySelector('.m-group') !== pinnedGroup()) return { ok: false, why: '有搜尋字時「釘選」那一組仍要在最上面' };
  if (!(await clearBox())) return { ok: false, why: '全選後按刪除鍵沒有清空搜尋框：' + JSON.stringify(box.value) };
  await typeInto('不存在的名字');
  if (pinnedGroup()) return { ok: false, why: '搜尋沒有符合的釘選時，那一組要消失' };
  if (!(await clearBox())) return { ok: false, why: '全選後按刪除鍵沒有清空搜尋框：' + JSON.stringify(box.value) };
  await sleep(300);
  if (JSON.stringify(pinnedNames()) !== JSON.stringify(['demo', '小工'])) return { ok: false, why: '清掉搜尋字後兩個都要回來，實際：' + JSON.stringify(pinnedNames()) };
  return { ok: true, why: '' };
  } catch (e) { return { ok: false, why: '檢查出錯：' + (e && e.message || e) } }
})()`

const DESK_SOURCE = () => `(async () => {
  try {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const vis = e => !!e && e.getClientRects().length > 0 && getComputedStyle(e).display !== 'none';
  const txt = e => (e?.textContent || '').replace(/\\s+/g, ' ').trim();
  const at = el => { const r = el.getBoundingClientRect(); return [Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2)] };
  const waitFor = async (fn, n = 80) => { for (let i = 0; i < n; i++) { const v = fn(); if (v) return v; await sleep(100) } return null };
  const tab = await waitFor(() => [...document.querySelectorAll('.top-tabs .ttab')].find(t => txt(t).startsWith('對話')));
  if (!tab) return { ok: false, why: '找不到「對話」分頁' };
  globalThis.__smokeInput(JSON.stringify({ click: at(tab) })); await sleep(600);
  const rows = () => [...document.querySelectorAll('.chat-list ul > li')].filter(vis);
  const nameOf = li => txt(li.querySelector('.b-nick'));
  const top2 = () => rows().slice(0, 2).map(nameOf);
  if (!(await waitFor(() => top2().length === 2 && top2().join() === 'demo,小工'))) return { ok: false, why: '本機釘 demo、帳號層釘小工，同步後對話分頁最上面要是 demo、小工，實際：' + JSON.stringify(rows().map(nameOf)) };
  const bare = rows().slice(0, 2).filter(li => !li.querySelector('.pin-dot'));
  if (bare.length) return { ok: false, why: '釘選的列沒有圖釘徽章：' + bare.map(nameOf).join('、') };
  return { ok: true, why: '' };
  } catch (e) { return { ok: false, why: '檢查出錯：' + (e && e.message || e) } }
})()`

const MEMBERS = [{ id: 'Q', name: '辦公室', agents: [{ name: 'demo', status: 'idle', cwd_label: 'demo' }, { name: '小工', status: 'idle', cwd_label: 'work' }] }]
const DESK_LOCAL = { chatPins: { pins: [{ id: 'Q/demo', at: 1_763_000_000_000 }], unpinned: [], rev: 1 } }
const LOCAL = { navTab: 'list', mobilePrefs: { chatPins: { pins: [{ id: 'Q/demo', at: 1_763_000_000_000 }], unpinned: [], rev: 1 } } }
const REMOTE = { pins: [{ id: 'Q/小工', at: 1_763_000_100_000 }], unpinned: [], rev: 4, at: 1_763_000_100_000 }
const MERGED = { pins: [{ id: 'Q/demo', at: 1_763_000_000_000 }, { id: 'Q/小工', at: 1_763_000_100_000 }], unpinned: [], rev: 5, at: 1_763_000_200_000 }

const desk = (name, skin) => ({ name, page: 'list.html', width: 900, height: 640, state: { signedIn: true, pinsSync: 'desk', ...(skin ? { skin } : {}) }, ready: '#app.win .top-tabs .ttab', probe: { pinsSync: 'desk' }, shot: `${name}.png` })
const phone = (name, skin) => ({ name, page: 'm.html', state: { signedIn: true, pinsSync: 'phone', ...(skin ? { skin } : {}) }, ready: '#app.m .m-pager .m-search', probe: { pinsSync: 'phone' }, shot: `${name}.png` })

export default {
  key: 'pinsSync',
  kind: '釘選帳號同步檢查',
  source: probe => (probe.pinsSync === 'desk' ? DESK_SOURCE() : SOURCE()),
  scenarios: [phone('m-pins-sync'), phone('m-pins-sync-modern', 'modern'), phone('m-pins-sync-line', 'line'), desk('list-pins-sync')],
  table: (scenario, t) => (scenario.state?.pinsSync
    ? {
      relay_list: { members: MEMBERS },
      store_load: { ...t.store_load, values: { ...t.store_load.values, me: JSON.stringify(scenario.state.pinsSync === 'desk' ? DESK_LOCAL : LOCAL) } },
      auth_chat_pins_get: { pins: REMOTE },
      auth_chat_pins_set: { pins: MERGED, stale: false, rate_limited: false },
    }
    : undefined),
}

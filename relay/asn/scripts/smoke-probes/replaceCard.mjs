// 冒煙探測「新設備取代卡片」（probe.replaceCard，#1860 H）。scripts/smoke-probes/ 底下的檔案由 smoke-registry.mjs 自動收集（#1540）
// 假後台回一張卡、兩個候選（形狀照後台 asn_device_replace_candidates 的實際輸出）：
// 設定 → 設備清單最上面要有卡片、標題與兩顆按鈕都在、選第二個候選按鈕跟著換、畫面沒有節點代號或 email。電腦與手機各一個情境。

export const replaceCardProbeSource = mode => `(async () => {
  try {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const vis = e => !!e && e.getClientRects().length > 0 && getComputedStyle(e).display !== 'none';
  const at = el => { const r = el.getBoundingClientRect(); return [Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2)] };
  const real = async req => { globalThis.__smokeInput(JSON.stringify(req)); await sleep(400) };
  const phone = ${JSON.stringify(mode)} === 'phone';
  if (phone) {
    let btn = null;
    for (let i = 0; i < 60 && !btn; i++) { btn = [...document.querySelectorAll('.m-row-btn')].find(b => vis(b) && b.textContent.includes('設備')) || null; if (!btn) await sleep(100) }
    if (!btn) return { ok: false, why: '找不到設定裡的「設備」' };
    await real({ click: at(btn) });
  }
  const cardSel = phone ? '.m-dv-replace' : '.dv-replace', listSel = phone ? '.m-dv-list' : '.dv-list';
  let card = null;
  for (let i = 0; i < 80 && !card; i++) { card = [...document.querySelectorAll(cardSel)].find(vis) || null; if (!card) await sleep(100) }
  if (!card) return { ok: false, why: '設備頁沒有「是不是取代舊的」卡片' };
  const list = [...document.querySelectorAll(listSel)].find(vis);
  if (!list) return { ok: false, why: '找不到設備清單' };
  if (!(card.getBoundingClientRect().top < list.getBoundingClientRect().top)) return { ok: false, why: '卡片不在清單最上面' };
  const text = card.textContent.replace(/\\s+/g, ' ');
  for (const need of ['有一台新的' + (phone ? '手機' : '電腦') + '連上了', '是第一次連上', '40家用', '離線中 · 最後在線 3 天前', '舊筆電', '不是，兩台都留', '取代 40家用', '取代後，40家用 會移到「已移除的設備」，可以恢復；新的這台沿用「40家用」這個名字。']) {
    if (!text.includes(need)) return { ok: false, why: '卡片缺少「' + need + '」：' + text };
  }
  if (/nodeNEW|nodeOLD|@/.test(text)) return { ok: false, why: '卡片上出現節點代號或 email：' + text };
  const btns = [...card.querySelectorAll('button')].filter(vis);
  const keep = btns.find(b => b.textContent.trim() === '不是，兩台都留'), go = btns.find(b => b.textContent.trim().startsWith('取代 '));
  if (!keep || !go || keep.disabled || go.disabled) return { ok: false, why: '兩顆按鈕要都在而且能按' };
  if (phone && go.getBoundingClientRect().right < card.getBoundingClientRect().right - 40) return { ok: false, why: '手機的按鈕要靠右' };
  const radios = [...card.querySelectorAll('input[type=radio]')];
  if (radios.length !== 2 || !radios[0].checked) return { ok: false, why: '候選要有兩個、預設選第一個' };
  await real({ click: at(radios[1].closest('label')) });
  const go2 = [...card.querySelectorAll('button')].find(b => b.textContent.trim().startsWith('取代 '));
  if (!go2 || go2.textContent.trim() !== '取代 舊筆電' || !card.textContent.includes('取代後，舊筆電 會移到')) return { ok: false, why: '選第二個候選後按鈕與說明沒有跟著換：' + (go2 && go2.textContent) };
  return { ok: true, why: '' };
  } catch (e) { return { ok: false, why: '檢查出錯：' + (e && e.message || e) } }
})()`

const NOW = Date.now()
const day = n => new Date(NOW - n * 86400000).toISOString()
const cardsOf = mode => ({ cards: [{ node: 'nodeNEW-aaaa-0001', name: mode === 'phone' ? '手機（X7K2）' : '電腦（X7K2）', platform: mode === 'phone' ? 'android' : 'windows', created_at: day(0), candidates: [{ node: 'nodeOLD-bbbb-0002', name: '40家用', last_seen: day(3) }, { node: 'nodeOLD-cccc-0003', name: '舊筆電', last_seen: day(70) }] }] })
const members = [{ id: 'Q', name: '辦公室', agents: [{ name: 'demo', status: 'idle', cwd_label: 'demo' }] }, { id: 'R', name: '工作機', agents: [{ name: 'demo', status: 'idle', cwd_label: 'demo' }] }]
const DESK_ME = { winMode: 'merged', session: { v: 1, tabs: [{ id: '@setting' }], active: { id: '@setting' }, panel: { guide: '', setting: 'devices' }, windows: [], panelWindows: [] } }
const PHONE_ME = { navTab: 'me' }

const desk = name => ({ name, page: 'list.html', width: 900, height: 640, state: { signedIn: true, replaceCard: 'desk' }, ready: '#app.win .dv-set', probe: { replaceCard: 'desk' }, shot: `${name}.png` })
const phone = name => ({ name, page: 'm.html', width: 360, state: { signedIn: true, replaceCard: 'phone' }, ready: '#app.m .m-row-btn', probe: { replaceCard: 'phone' }, shot: `${name}.png` })

export default {
  key: 'replaceCard',
  kind: '新設備取代卡片檢查',
  source: probe => replaceCardProbeSource(probe.replaceCard),
  scenarios: [desk('list-replace-card'), phone('m-replace-card')],
  table: (scenario, t) => {
    const mode = scenario.state?.replaceCard
    if (!mode) return undefined
    const me = mode === 'desk' ? DESK_ME : PHONE_ME
    return { relay_list: { members }, relay_device_replace_candidates: cardsOf(mode), store_load: { ...t.store_load, values: { ...t.store_load.values, me: JSON.stringify(me) } } }
  },
}

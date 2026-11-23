// 冒煙探測「設定頁畫出來了」（情境的 probe.setPage，#1763 T3）。scripts/smoke-probes/ 底下的檔案由 smoke-registry.mjs 自動收集（#1540）
// 檔名開頭的 z 是為了排在最後：探測檔自帶的情境照檔名順序接在 smoke-lib 的 SCENARIOS 後面，這支排最後，既有情境的順序就完全不變。
// 本檔自給自足（不 import smoke-lib）：設定頁基準情境用的假後台資料都在這裡，不跟別的情境共用，別人改共用資料不會讓這組基準跟著變。
//
// 情境：從 SETTING_CATS（電腦 12 類）、MOBILE_SETTING_KEYS（手機 8 類）算出來，每一類 × 三套外觀；手機 look／update／notify／about 另加 360 寬。
// 設備、帳號、雲端代理三類另補「空、錯誤、忙碌」狀態（有資料＝每類每外觀那一組）；忙碌只有雲端代理做得出來（見 SET_STATE_GAPS）。
// 名稱：電腦 list-set-<類>-<外觀>、手機 m-set-<類>-<外觀>、手機 360 m-set-<類>-360、狀態 list-set-<類>-<empty|error|busy>、m-set-<類>-<empty|error|busy>
// 每個情境都帶 shot（進 ui-shots 比對），並用本檔的探測等到該類的標題與代表字（沒畫出來就失敗，不會拍到空白頁，R9）：
//   電腦（mode: 'desk'）：存檔就停在該分類，等 .panel-h 出現「設定：<分類名>」，再確認內容區有字、含該類的代表字。
//   手機（mode: 'phone'）：先在設定清單點那一列，等內頁標題（.m-fourth .m-title）出現，再確認內頁有字、含該類的代表字。
// probe 欄位：{ setPage, mode, key, heading（標題全文）, want（內容區必須出現的字）, row（手機清單那一列的名稱）, settle（毫秒，狀態類情境多等一下）, flow }
import { MOBILE_SETTING_KEYS, mobileSettingTitle } from '../../ui/lib/mobile-settings.mjs'
import { SETTING_CATS } from '../../ui/lib/settings-cats.mjs'

export const SET_SKINS = ['aero', 'modern', 'line']
// 狀態矩陣：每一類做哪幾個狀態。做不出來的組合寫在 SET_STATE_GAPS（附原因），覆蓋清單測試要求兩者加起來涵蓋全部組合
export const SET_STATES = ['empty', 'error', 'busy']
export const SET_STATE_MATRIX = { devices: ['empty', 'error'], accounts: ['empty', 'error'], cloud: ['empty', 'error', 'busy'] }
export const SET_STATE_GAPS = {
  'devices:busy': '設備頁的清單、已記住的電腦、帳號回報都在背景讀，讀的時候畫面照舊顯示現有清單、沒有讀取中的樣子；讓它們永遠不回，截圖和「有資料」一樣（量過），不是獨立的狀態',
  'accounts:busy': '帳號頁讀額度與帳號庫時沒有讀取中的樣子，畫面和「錯誤」逐像素相同（電腦與手機都量過）：這個頁面把「還沒讀到」和「讀失敗」畫成同一個畫面',
}
export const SET_PHONE_360 = ['look', 'update', 'notify', 'about']
// 每一類畫面上固定會出現的字（電腦：設定頁內容區；手機：內頁內容區）。標題另外驗（「設定：<分類名>」／手機內頁標題）
const SET_WANT_DESK = {
  me: ['我的名字'], devices: ['運作中'], accounts: ['Claude'], cloud: ['邀請雲端代理'], look: ['復古 Aero', 'LINE 風格', '分組依'], notify: ['通知聲音'],
  voice: ['念出訊息的聲音'], window: ['關閉視窗時'], launch: ['別的設備一小時最多替這台開'], usage: ['重新整理'], update: ['自動檢查更新'], about: ['隱私權政策'],
}
const SET_WANT_PHONE = { me: ['我的名字'], devices: ['運作中'], accounts: ['Claude'], cloud: ['邀請雲端代理'], look: ['復古 Aero', '現代'], notify: ['收到新訊息時輕輕震一下'], update: ['版本紀錄'], about: ['隱私權政策'] }
// 狀態類情境的代表字：空／錯誤／忙碌各自該看到的字（沒列的代表只驗標題與內容非空）
const SET_WANT_STATE = {
  'desk:devices': { empty: ['運作中'], error: ['運作中'] },
  'desk:accounts': { empty: ['Grok'], error: ['Grok'] },
  'desk:cloud': { empty: ['還沒有邀請過雲端代理'], error: ['連線逾時，請稍後再試'], busy: ['代理的名字'] },
  'phone:devices': { empty: ['運作中'], error: ['操作沒有成功'] },
  'phone:accounts': { empty: ['帳號'], error: ['現在讀不到帳號列表'] },
  'phone:cloud': { empty: ['還沒有邀請過雲端代理'], error: ['連線逾時，請稍後再試'], busy: ['代理的名字'] },
}
const setScenario = ({ name, mode, cat, skin, width, fx }) => {
  const desk = mode === 'desk'
  const title = desk ? SETTING_CATS.find(c => c.key === cat).title : mobileSettingTitle(cat)
  const want = fx ? SET_WANT_STATE[`${mode}:${cat}`]?.[fx] ?? [] : (desk ? SET_WANT_DESK : SET_WANT_PHONE)[cat]
  return {
    name, page: desk ? 'list.html' : 'm.html', ...(desk ? { width: width ?? 900, height: 640 } : width ? { width } : {}),
    state: { signedIn: true, ...(skin && skin !== 'aero' ? { skin } : {}), setPage: { mode, cat, fx: fx ?? 'data' } },
    ready: desk ? (cat === 'devices' ? '#app.win .panel-pane .dv-set' : '#app.win .panel-pane .panel-h') : '#app.m .m-row-btn',
    probe: { setPage: true, ...(fx === 'busy' && cat === 'cloud' ? { flow: 'cloud-busy' } : {}), mode, key: cat, heading: desk ? `設定：${title}` : title, want, row: title, settle: fx ? 1500 : 600 },
    shot: `${name}.png`,
  }
}
export const SET_SCENARIOS = Object.freeze([
  ...SETTING_CATS.flatMap(c => SET_SKINS.map(skin => setScenario({ name: `list-set-${c.key}-${skin}`, mode: 'desk', cat: c.key, skin }))),
  ...MOBILE_SETTING_KEYS.flatMap(k => SET_SKINS.map(skin => setScenario({ name: `m-set-${k}-${skin}`, mode: 'phone', cat: k, skin, width: 412 }))),
  ...SET_PHONE_360.map(k => setScenario({ name: `m-set-${k}-360`, mode: 'phone', cat: k, skin: 'aero', width: 360 })),
  ...Object.entries(SET_STATE_MATRIX).flatMap(([k, fxs]) => fxs.flatMap(fx => [
    setScenario({ name: `list-set-${k}-${fx}`, mode: 'desk', cat: k, skin: 'aero', fx }),
    setScenario({ name: `m-set-${k}-${fx}`, mode: 'phone', cat: k, skin: 'aero', width: 412, fx }),
  ])),
])

// ---- 假後台資料（自給自足）----
// 時間跟著「現在」走（畫面用瀏覽器的現在算）：ui-shots 組表時把 Date 換成固定值，所以基準與新版一致
const toMinute = ms => new Date(Math.floor(ms / 60_000) * 60_000).toISOString()
const desk = (id, name, agent) => ({ id, name, agents: [{ name: agent, status: 'idle', cwd_label: agent }] })
const DESK_MEMBERS = [desk('Q', '辦公室', 'demo'), desk('M1', '擁有者的手機', 'm1'), desk('M2', '舊手機', 'm2')]
const PHONE_MEMBERS = [desk('Q', '辦公室', 'demo'), desk('R', '工作機', 'demo')]
const FP = '3fa2c91b7d0e4a5f8c6b2d1e0f9a8b7c'
const claudeAcct = (account, plan, node, left5, leftWeek, now) => {
  const read = toMinute(now - 10 * 60_000)
  return { vendor: 'claude', account, plan, shared: true, seen_at: read, seen_node: node, nodes: [{ node, current: true, reported_at: read }],
    windows: [{ name: 'five_hour', left_pct: left5, resets_at: toMinute(now + 3 * 3600_000), read_at: read, read_node: node }, { name: 'weekly', left_pct: leftWeek, resets_at: toMinute(now + 3 * 24 * 3600_000), read_at: read, read_node: node }] }
}
const roster = (now, accounts) => ({ now: toMinute(now), accounts })
const phoneAcctList = now => ({ by: 'node', values: {
  Q: { asn_online: true, reported_at: toMinute(now - 5 * 60_000), accounts: [{ vendor: 'claude', email: 'work@example.com', plan: 'claude_pro', current: true }, { vendor: 'claude', email: 'me@example.com', plan: 'claude_max', current: false }] },
  R: { asn_online: false, reported_at: toMinute(now - 9 * 24 * 3600_000), accounts: [{ vendor: 'claude', email: 'work@example.com', plan: 'claude_pro', current: true }, { vendor: 'claude', email: 'me@example.com', plan: 'claude_max', current: false }] },
}, fallback: null })
const cloudNodes = now => ({ nodes: [
  { id: 'C1', name: '小真', last_seen_at: new Date(now - 60_000).toISOString(), online: true },
  { id: 'C2', name: '日本VM', last_seen_at: new Date(now - 5 * 3600_000).toISOString(), online: false },
  { id: 'C3', name: '新代理', last_seen_at: null, online: false },
] })
const FAIL_TEXT = '連線逾時，請稍後再試'
const failing = cmds => ({ __fail: Object.fromEntries(cmds.map(c => [c, FAIL_TEXT])) })

// 設定頁假後台：依 setPage.fx（data｜empty｜error｜busy）換掉設備、帳號、雲端代理三類的資料；其他類不動
// error＝讓那幾個指令回錯誤（表裡的 __fail：呼叫被拒絕、帶一句錯誤文字，畫面走「後台沒回應」那條路）；busy＝讓指令永遠不回（表裡的 __hang）
export const setPageTable = ({ mode, cat, fx }, t, now = Date.now()) => {
  const me = mode === 'desk'
    ? { winMode: 'merged', session: { v: 1, tabs: [{ id: '@setting' }], active: { id: '@setting' }, panel: { guide: '', setting: cat }, windows: [], panelWindows: [] } }
    : { navTab: 'me' }
  const patch = { store_load: { ...t.store_load, values: { ...t.store_load.values, me: JSON.stringify(me) } } }
  if (cat === 'devices' || cat === 'accounts') {
    if (mode === 'desk') {
      Object.assign(patch, {
        relay_list: { members: DESK_MEMBERS },
        relay_launchers: { machines: [{ node: 'M1', platform: 'android', launcher: null }, { node: 'M2', platform: 'android', launcher: null }] },
        device_known_list: { peers: [{ node: 'M1', name: '擁有者的手機', fingerprint: FP, first_seen_ms: 1763000000000 }] },
        acct_roster: roster(now, [claudeAcct('me@example.com', 'claude_max', 'P', 40, 72, now)]),
        claude_accounts_list: [{ email: 'me@example.com', plan: 'max', current: true }, { email: 'work@example.com', plan: 'pro', current: false }],
        claude_account_current: 'me@example.com',
      })
      if (fx === 'empty') Object.assign(patch, { relay_list: { members: [] }, relay_launchers: { machines: [] }, device_known_list: { peers: [] }, acct_roster: roster(now, []), claude_accounts_list: [], claude_account_current: null })
      if (fx === 'error') Object.assign(patch, failing(['relay_launchers', 'device_known_list', 'acct_roster', 'claude_accounts_list']))
    } else {
      Object.assign(patch, {
        relay_list: { members: PHONE_MEMBERS },
        android_launchers: { machines: [] },
        android_known_list: { peers: [{ node: 'Q', name: '辦公室', confirmed: true, fp: FP, first_seen_ms: 1763000000000 }, { node: 'R', name: '工作機', confirmed: false, first_seen_ms: 1763000000000 }] },
        android_acct_roster: roster(now, [claudeAcct('me@example.com', 'claude_max', 'P', 40, 72, now), claudeAcct('work@example.com', 'claude_pro', 'Q', 64, 50, now)]),
        android_acct_list: phoneAcctList(now),
      })
      if (fx === 'empty') Object.assign(patch, { relay_list: { members: [] }, android_known_list: { peers: [] }, android_acct_roster: roster(now, []), android_acct_list: { by: 'node', values: {}, fallback: null } })
      if (fx === 'error') Object.assign(patch, failing(['relay_list', 'android_launchers', 'android_known_list', 'android_acct_roster', 'android_acct_list']))
    }
  }
  if (cat === 'cloud') {
    patch.cloud_agent_list = fx === 'empty' ? { nodes: [] } : cloudNodes(now)
    if (fx === 'error') Object.assign(patch, failing(['cloud_agent_list']))
    if (fx === 'busy') patch.__hang = ['cloud_agent_create']   // 按下「建立」之後後台一直沒回：探測會真的點過去（flow: cloud-busy）
  }
  return patch
}

export const setPageProbeSource = ({ mode, key, heading, want = [], row = '', settle = 600, flow = '' }) => `(async () => { try {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const mode = ${JSON.stringify(mode)}, key = ${JSON.stringify(key)}, heading = ${JSON.stringify(heading)}, want = ${JSON.stringify(want)}, rowName = ${JSON.stringify(row)}, flow = ${JSON.stringify(flow)};
  const vis = e => e && e.offsetParent !== null;
  let root = null;
  if (mode === 'phone') {
    let btn = null;
    for (let i = 0; i < 80 && !btn; i++) { btn = [...document.querySelectorAll('#app.m .m-row-btn')].find(b => (b.querySelector('b')?.textContent ?? '').trim() === rowName) || null; if (!btn) await sleep(100) }
    if (!btn) return { ok: false, why: '設定清單裡找不到「' + rowName + '」那一列' };
    btn.click();
    for (let i = 0; i < 80 && !root; i++) {
      const t = [...document.querySelectorAll('#app.m .m-fourth .m-head .m-title')].find(vis);
      if (t && t.textContent.trim() === heading) root = t.closest('.m-fourth');
      if (!root) await sleep(100);
    }
    if (!root) return { ok: false, why: '內頁標題沒有出現「' + heading + '」：' + [...document.querySelectorAll('#app.m .m-fourth .m-title')].map(e => e.textContent.trim()).join('／') };
  } else {
    for (let i = 0; i < 80 && !root; i++) {
      // 設備頁（#1864）：復古外觀的頁內標題用樣式收起（標題在分頁標籤），元素還在，所以不要求看得見；其他分類照舊
      const h = key === 'devices'
        ? document.querySelector('#app.win .panel-pane .panel-h')
        : [...document.querySelectorAll('#app.win .panel-pane .panel-h')].find(vis);
      if (h && h.textContent.trim() === heading) root = h.closest('.panel-pane');
      if (!root) await sleep(100);
    }
    if (!root) return { ok: false, why: '分類標題沒有出現「' + heading + '」：' + [...document.querySelectorAll('#app.win .panel-h')].map(e => e.textContent.trim()).join('／') };
  }
  // 忙碌（雲端代理）：真的點「邀請雲端代理」→「建立」，後台（假）一直不回，「建立」要變成不能按
  if (flow === 'cloud-busy') {
    const press = async name => { const b = [...root.querySelectorAll('button')].find(x => x.textContent.trim() === name && vis(x)); if (!b) return null; b.click(); await sleep(300); return b };
    if (!(await press('邀請雲端代理'))) return { ok: false, why: '找不到「邀請雲端代理」鈕' };
    const go = await press('建立');
    if (!go) return { ok: false, why: '找不到「建立」鈕' };
    if (!go.disabled && ![...root.querySelectorAll('button')].some(x => x.textContent.trim() === '建立' && x.disabled)) return { ok: false, why: '按下「建立」後沒有進入忙碌（按鈕仍可按）' };
  }
  // 狀態類情境（資料要等假後台回應才畫完）多等一下；每個代表字最多再等 3 秒
  await sleep(${Number(settle) || 0});
  let miss = want;
  for (let i = 0; i < 30 && miss.length; i++) {
    const text = root.textContent;
    miss = want.filter(w => !text.includes(w));
    if (miss.length) await sleep(100);
  }
  if (miss.length) return { ok: false, why: '設定「' + key + '」頁少了：' + miss.join('、') };
  const body = root.textContent.replace(heading, '').replace(/\\s+/g, '');
  if (body.length < 8) return { ok: false, why: '設定「' + key + '」頁幾乎是空的（' + body.length + ' 字）' };
  if (!vis(root) || root.getBoundingClientRect().height < 100) return { ok: false, why: '設定「' + key + '」頁高度不足' };
  return { ok: true, why: '' };
} catch (e) { return { ok: false, why: '探測丟出例外：' + (e && e.message) } } })()`

export default {
  key: 'zSetPage',   // 登記表要求 key＝檔名；z 開頭讓它排在所有探測檔最後（見檔頭）。情境的 probe 寫 setPage: true（has 對應）
  has: probe => probe.setPage === true,
  kind: probe => (probe.mode === 'phone' ? '手機設定內頁' : '電腦設定頁') + '檢查（' + probe.key + '）',
  source: probe => setPageProbeSource(probe),
  scenarios: SET_SCENARIOS,
  table: (scenario, t) => (scenario.state.setPage ? setPageTable(scenario.state.setPage, t) : undefined),
}

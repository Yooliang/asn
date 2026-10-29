// 啟動冒煙測試的純邏輯：參數、入口頁清單、假 Tauri 回應表、瀏覽器尋找、掛上判斷。
// smoke-ui.mjs 負責真的起伺服器與無頭瀏覽器；這裡不碰程序與網路，方便單元測試。
import fs from 'node:fs'
import path from 'node:path'

const badTimeout = () => new Error('--timeout 要是不小於 1000 的毫秒數')
export const parseSmokeArgs = argv => {
  const o = { only: [], timeoutMs: 15000, browser: '', verbose: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--verbose') o.verbose = true
    else if (a === '--only') { const v = argv[++i]; if (!v) throw new Error('--only 後面要接情境名稱（可用逗號分隔）'); o.only.push(...v.split(',').filter(Boolean)) }
    else if (a.startsWith('--only=')) o.only.push(...a.slice(7).split(',').filter(Boolean))
    else if (a === '--timeout') { o.timeoutMs = Number(argv[++i]); if (!(o.timeoutMs >= 1000)) throw badTimeout() }
    else if (a.startsWith('--timeout=')) { o.timeoutMs = Number(a.slice(10)); if (!(o.timeoutMs >= 1000)) throw badTimeout() }
    else if (a === '--browser') { o.browser = argv[++i] ?? ''; if (!o.browser) throw new Error('--browser 後面要接瀏覽器執行檔路徑') }
    else if (a.startsWith('--browser=')) o.browser = a.slice(10)
    else throw new Error(`不認得的參數：${a}`)
  }
  return o
}

// ---- 假狀態：沿用真機會回的欄位 ----
const startup = over => ({ node: 'P', window_name: '測試機', old_names: [], error: null, needs_login: false, can_skip_login: true, last_login: null, shot: false, poll_ms: 600000, roster_ms: 600000, version: '0.0.0', ...over })

// 每個值都要能 JSON 序列化（會整包注入頁面）。{ by: 'name', values, fallback } 代表依參數 name 挑值。
export const fakeTable = ({ signedIn = true, needsLogin = false } = {}) => ({
  startup_info: startup({ needs_login: needsLogin }),
  auth_status: { signed_in: signedIn, email: signedIn ? 'me@example.com' : null },
  auth_account_info: signedIn ? { email: 'me@example.com', created: '2026-01-01', node_count: 1, this_node_mine: true, name: '測試者' } : null,
  store_load: { by: 'name', values: { onboard: JSON.stringify({ done: true }), chats: JSON.stringify({ friends: [], logs: {} }), me: JSON.stringify({}) }, fallback: null },
  store_save: null,
  relay_list: { members: [] },
  relay_inbox: { mails: [] },
  relay_rooms: { rooms: [] },
  relay_sent_status: { status: [] },
  relay_chat_history: { messages: [] },
  relay_launchers: { machines: [] },
  relay_avatar: null,
  local_windows: [],
  frame_native: false,
  shot_supported: false,
  tray_available: false,
  autostart_get: false,
  main_visible: true,
  chat_visible: false,
  main_layout: null,
  invite_pending: null,
  open_windows: [],
  acct_remote_list: { accounts: [] },
  claude_accounts_list: [],
  claude_account_current: null,
  codex_account_current: null,
  claude_mod_status: null,
  android_launchers: [],
  stt_status: { installed: false },
  tts_voices: [],
  usage_summary: null,
  voice_cfg_get: null,
  launch_prefs_get: null,
  launch_cwd_candidates: [],
  update_remote_status: null,
  win_ctl: null, set_presence: null, set_window_name: null, set_tray_unread: null, show_main: null, close_panels: null, close_chats: null, capture_ui_ready: null,
  // 故意沒放的指令（例如 android_update_check、ai_cli_detect）：呼叫會被拒絕，模擬真機沒註冊它的情況
})

// 遮罩檢查（#536）：steps＝依序點的 [選擇器, 文字]，mask＝遮罩選擇器，cover＝必須被遮罩蓋住的區塊
export const MASK_PROBES = {
  desktop: { steps: [['.actionbar .abtn[aria-label="管理"]', ''], ['.ab-ops button:not(.off)', '詳情']], mask: '.dlg-back', cover: ['.me .me-dp', '.me-info', '.rail', '.list-pane .content', '.tabbar'] },
  mobile: { steps: [['.m-plus-wrap .m-icon-btn', ''], ['.m-plus-menu button', '建立群組']], mask: '.gs-back', cover: ['.m-head .m-me', '.m-head .m-plus-wrap', '.m-search'] },
}
// 夥伴分頁情境：名單上有一個在線的 Claude 視窗，整合模式開著它的對話分頁（大按鈕區有「管理」）
export const PARTNER_MEMBERS = [{ id: 'P', agents: [{ name: 'demo', status: 'idle', cwd_label: 'demo' }] }]
export const PARTNER_ME = { winMode: 'merged', session: { v: 1, tabs: [{ id: 'P/demo' }], active: { id: 'P/demo' }, panel: { guide: '', setting: '' }, windows: [], panelWindows: [] } }

// 在頁面內執行（await）：依序點開對話框，再檢查遮罩蓋滿視窗、指定區塊的左上角點下去會落在遮罩上
export const maskProbeSource = ({ steps, mask, cover }) => `(async () => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const find = async (sel, text) => { for (let i = 0; i < 50; i++) { const el = [...document.querySelectorAll(sel)].find(e => !text || e.textContent.includes(text)); if (el) return el; await sleep(100) } return null };
  for (const [sel, text] of ${JSON.stringify(steps)}) {
    const el = await find(sel, text);
    if (!el) return { ok: false, why: '找不到 ' + sel + (text ? '「' + text + '」' : '') };
    el.click(); await sleep(200);
  }
  const back = await find(${JSON.stringify(mask)}, '');
  if (!back) return { ok: false, why: '對話框沒有打開（找不到 ' + ${JSON.stringify(mask)} + '）' };
  const r = back.getBoundingClientRect();
  if (r.left > 0 || r.top > 0 || r.right < innerWidth || r.bottom < innerHeight) return { ok: false, why: '遮罩沒有蓋滿視窗：' + [r.left, r.top, r.right, r.bottom].map(Math.round).join(',') };
  for (const sel of ${JSON.stringify(cover)}) {
    const t = document.querySelector(sel);
    if (!t) return { ok: false, why: '找不到要被蓋住的 ' + sel };
    const b = t.getBoundingClientRect();
    const x = Math.min(b.left + 6, b.right - 1), y = Math.min(b.top + 6, b.bottom - 1);
    const hit = document.elementFromPoint(x, y);
    if (!hit || !back.contains(hit)) return { ok: false, why: sel + ' 沒被遮罩蓋住（點到 ' + (hit ? hit.tagName.toLowerCase() + '.' + String(hit.className).trim().split(/\s+/).join('.') : '空白') + '）' };
  }
  return { ok: true, why: '' };
})()`

// 固定 6 顆大按鈕（#539）：依序找 .actionbar 裡的 .abtn，比對 data-slot、名稱與反灰；名單與查詢是非同步的，等到一致或逾時（回最後一次的差異）
export const BAR_MEMBERS = {
  claude: [{ id: 'P', agents: [{ name: 'demo', status: 'idle', cwd_label: 'demo' }] }],
  offline: [{ id: 'P', agents: [{ name: 'demo', status: 'idle', online: false, cwd_label: 'demo' }] }],
  acp: [{ id: 'P', agents: [{ name: 'demo', status: 'idle', engine: 'gemini', cwd_label: 'demo' }] }],
  // #539 之三：外掛回報「背景工作 3 件」（名單上的 detail）
  tasks: [{ id: 'P', agents: [{ name: 'demo', status: 'busy', cwd_label: 'demo', detail: '背景工作 3 件' }] }],
}
// 工作項目列表的假查詢結果（本機 tasks_query）：3 件只列 2 件，畫面要補「還有 1 件沒列出」
export const TASKS_SAMPLE = { ok: true, known: true, count: 3, items: [{ id: 'b1', description: '建置', kind: 'shell' }, { id: 'b2', description: '跑測試', kind: '' }] }
// [data-slot, 名稱, 反灰]
export const BAR_PROBES = {
  claude: { bar: [['call', '通話', false], ['window', '後台隱藏', false], ['model', '切換模型', false], ['subs', '子代理', false], ['tasks', '工作項目', true], ['manage', '管理', false]], badge: '' },
  offline: { bar: [['call', '通話', true], ['window', '前台／後台', true], ['model', '切換模型', true], ['subs', '子代理', true], ['tasks', '工作項目', true], ['manage', '管理', false]] },
  acp: { bar: [['call', '通話', false], ['window', 'ACP 模式', true], ['model', '切換模型', false], ['subs', '子代理', true], ['tasks', '工作項目', true], ['manage', '管理', false]] },
  // 有背景工作：工作項目可按、徽章 3；按下去列出 2 件＋「還有 1 件」；header 不再有「背景工作 N 件」
  tasks: { bar: [['call', '通話', false], ['window', '後台隱藏', false], ['model', '切換模型', false], ['subs', '子代理', false], ['tasks', '工作項目', false], ['manage', '管理', false]], badge: '3', taskItems: ['建置', '跑測試', '還有 1 件沒列出'], header: 'demo' },
}
export const barProbeSource = ({ bar, badge, taskItems, header }) => `(async () => {
  const want = ${JSON.stringify(bar)};
  const wantBadge = ${JSON.stringify(badge ?? null)}, wantItems = ${JSON.stringify(taskItems ?? null)}, wantHeader = ${JSON.stringify(header ?? null)};
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  let why = '';
  for (let i = 0; i < 60; i++) {
    const bars = [...document.querySelectorAll('.actionbar')].filter(b => b.offsetParent !== null);
    const btns = bars.length === 1 ? [...bars[0].querySelectorAll('.abtn')] : [];
    const off = b => b.getAttribute('aria-disabled') === 'true';
    const got = btns.map(b => [b.dataset.slot || '', b.querySelector('.ab-name')?.textContent.replace(/\s*▾\s*$/, '').trim() || '', off(b)]);
    why = bars.length !== 1 ? '看得到的功能列有 ' + bars.length + ' 條' : JSON.stringify(got) === JSON.stringify(want) ? '' : '按鈕不符：' + JSON.stringify(got);
    if (!why) {
      const bad = btns.find(b => off(b) && !b.title);
      if (btns.some(b => b.hasAttribute('disabled'))) why = '反灰不能用 disabled（滑鼠、Tab 讀不到原因）';
      else if (bad) why = bad.dataset.slot + ' 反灰卻沒有原因';
      else if (btns.some(b => off(b) && b.title.length > 20)) why = '反灰原因超過 20 字';
      else {
        // 反灰的選單鈕點了不能打開選單
        for (const b of btns.filter(b => off(b) && b.getAttribute('aria-haspopup'))) {
          b.click(); await sleep(150);
          if (b.getAttribute('aria-expanded') === 'true' || document.querySelector('.ab-menu')) return { ok: false, why: b.dataset.slot + ' 反灰卻點得開' };
        }
        // 工作項目（#539 之三）：徽章數字、header 拿掉件數、按下去的列表
        const tb = btns.find(b => b.dataset.slot === 'tasks');
        const badgeText = tb?.querySelector('.ab-badge')?.textContent.trim() ?? '';
        if (wantBadge !== null && badgeText !== wantBadge) return { ok: false, why: '工作項目徽章是「' + badgeText + '」，應為「' + wantBadge + '」' };
        if (wantHeader !== null) {
          const h = document.querySelector('.to-psm')?.textContent.trim() ?? '';
          if (h !== wantHeader) return { ok: false, why: 'header 個人訊息是「' + h + '」，應為「' + wantHeader + '」' };
        }
        if (wantItems) {
          tb.click();
          let items = [];
          for (let j = 0; j < 30; j++) { await sleep(100); items = [...document.querySelectorAll('.ab-tasks li')].map(e => e.querySelector('.ab-sub-text')?.textContent.trim() ?? e.textContent.trim()); if (JSON.stringify(items) === JSON.stringify(wantItems)) break }
          if (JSON.stringify(items) !== JSON.stringify(wantItems)) return { ok: false, why: '工作項目列表不符：' + JSON.stringify(items) };
        }
        return { ok: true, why: '' };
      }
    }
    await sleep(100);
  }
  return { ok: false, why };
})()`

// 群組分頁（#539 之二）：按鈕列有「群組」，選單是四項；「管理」不再有這四項（沒有管理也可以）
export const GROUP_ITEMS = ['邀請別人加入', '輸入邀請碼加入', '加我的另一個 AI', '成員與設定']
export const GROUP_ROOM = { id: 'g1', name: '測試群', members: [{ member: 'P~測試機', name: '測試機' }], mine: [{ member: 'P~測試機', unread: 0 }], last_seq: 0, created_at: '2026-10-29T00:00:00Z' }
export const GROUP_ME = { winMode: 'merged', session: { v: 1, tabs: [{ id: 'room:g1' }], active: { id: 'room:g1' }, panel: { guide: '', setting: '' }, windows: [], panelWindows: [] } }
export const groupProbeSource = ({ group }) => `(async () => {
  const want = ${JSON.stringify(group)};
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const shown = sel => [...document.querySelectorAll(sel)].filter(e => e.offsetParent !== null);
  const menuText = () => [...document.querySelectorAll('.ab-menu')].flatMap(m => [...m.querySelectorAll('.mi-t')].map(e => e.textContent.trim()));
  const esc = () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
  let btn = null;
  for (let i = 0; i < 60 && !btn; i++) { btn = shown('.actionbar .abtn[data-slot="group"]')[0] || null; if (!btn) await sleep(100) }
  if (!btn) return { ok: false, why: '群組分頁沒有「群組」按鈕' };
  if (btn.hasAttribute('disabled')) return { ok: false, why: '「群組」按鈕不能用 disabled' };
  btn.click(); await sleep(200);
  const got = menuText();
  if (JSON.stringify(got) !== JSON.stringify(want)) return { ok: false, why: '群組選單不符：' + JSON.stringify(got) };
  esc(); await sleep(150);
  const mg = shown('.actionbar .abtn[data-slot="manage"]')[0];
  if (mg) {
    mg.click(); await sleep(200);
    const left = menuText().filter(t => want.includes(t));
    esc();
    if (left.length) return { ok: false, why: '「管理」裡還有：' + left.join('、') };
  }
  return { ok: true, why: '' };
})()`
export const probeKind = probe => (probe.bar ? '大按鈕檢查' : probe.group ? '群組按鈕檢查' : '遮罩檢查')
export const probeSource = probe => (probe.bar ? barProbeSource(probe) : probe.group ? groupProbeSource(probe) : maskProbeSource(probe))

// ---- 入口頁清單：每個情境載一頁，指定假狀態、等待的畫面特徵 ----
// ready：頁面掛上後必須存在的選擇器；頁面不能被導走（導走＝流程錯）
export const SCENARIOS = [
  { name: 'm-signed-out', page: 'm.html', state: { signedIn: false, needsLogin: true }, ready: '#app.m .m-login' },
  { name: 'm-signed-in', page: 'm.html', state: { signedIn: true }, ready: '#app.m .m-pager .m-search' },
  { name: 'list', page: 'list.html', state: { signedIn: true }, ready: '#app.win' },
  { name: 'list-roster', page: 'list.html', state: { signedIn: true, devicesPage: true, roster: true }, ready: '#app.win .dv-my .dv-acct' },
  { name: 'list-roster-missing', page: 'list.html', state: { signedIn: true, devicesPage: true }, ready: '#app.win .dv-set' },
  { name: 'chat', page: 'chat.html?id=P%2Fdemo', state: { signedIn: true }, ready: '#app.win' },
  { name: 'onboard', page: 'onboard.html', state: { signedIn: true, onboard: true }, ready: '#app.win' },
  { name: 'login', page: 'login.html', state: { signedIn: false, needsLogin: true }, ready: '#app.win' },
  { name: 'panel', page: 'panel.html', state: { signedIn: true }, ready: '#app.win' },
  { name: 'askpass', page: 'askpass.html', state: { signedIn: true }, ready: '#app' },
  { name: 'toast', page: 'toast.html', state: { signedIn: true }, ready: '#app' },
  // 對話框遮罩（#536）：打開對話框後，遮罩要蓋滿整個視窗，左上使用者區與名單也點不到
  { name: 'list-dialog-mask', page: 'list.html', state: { signedIn: true, partnerTab: true }, ready: '#app.win .actionbar .abtn[aria-label="管理"]', probe: MASK_PROBES.desktop },
  { name: 'm-dialog-mask', page: 'm.html', state: { signedIn: true }, ready: '#app.m .m-pager .m-search', probe: MASK_PROBES.mobile },
  // 固定 6 顆大按鈕（#539）：閒置 Claude、離線 Claude、ACP 工作者，各自依序都在、反灰正確、反灰有 20 字內的原因
  { name: 'list-bar-fixed', page: 'list.html', state: { signedIn: true, bar: 'claude' }, ready: '#app.win .actionbar .abtn[aria-label="管理"]', probe: BAR_PROBES.claude },
  { name: 'list-bar-fixed-offline', page: 'list.html', state: { signedIn: true, bar: 'offline' }, ready: '#app.win .actionbar .abtn[aria-label="管理"]', probe: BAR_PROBES.offline },
  { name: 'list-bar-fixed-acp', page: 'list.html', state: { signedIn: true, bar: 'acp' }, ready: '#app.win .actionbar .abtn[aria-label="管理"]', probe: BAR_PROBES.acp },
  // 工作項目（#539 之三）：本機 Claude 有 3 件背景工作，按鈕可按、數字顯示、列表打得開；上面三個情境是 0 件反灰、沒有徽章
  { name: 'list-bar-tasks', page: 'list.html', state: { signedIn: true, bar: 'tasks' }, ready: '#app.win .actionbar .abtn[aria-label="管理"]', probe: BAR_PROBES.tasks },
  // 群組按鈕（#539 之二）：整合模式開著群組分頁，按鈕列有「群組」（四項），「管理」不再放這些
  { name: 'list-group-tab', page: 'list.html', state: { signedIn: true, groupTab: true }, ready: '#app.win .actionbar', probe: { group: GROUP_ITEMS } },
]
// 刻意不測的 ui/*.html（要寫理由）；其餘 html 都必須有情境（見單元測試）
export const EXCLUDED_PAGES = {
  'shot.html': '截圖框選覆蓋層：由 Rust 端帶截圖資料開啟，沒有獨立的啟動流程，另有 shot 測試',
}

// 這個情境的完整假回應表（引導情境不預設「已引導」，讓引導畫面出現）
// 帳號列表（#374）情境：整合模式、上次開著「設定：設備與帳號」，開機就會讀 acct_roster
export const ROSTER_ME = { winMode: 'merged', session: { v: 1, tabs: [{ id: '@setting' }], active: { id: '@setting' }, panel: { guide: '', setting: 'devices' }, windows: [], panelWindows: [] } }
export const ROSTER_SAMPLE = {
  now: '2026-10-29T00:00:00Z',
  accounts: [
    { vendor: 'claude', account: 'me@example.com', plan: 'max', windows: [{ name: 'five_hour', left_pct: 40, resets_at: null, read_at: '2026-10-28T21:00:00Z', read_node: 'P' }, { name: 'weekly', left_pct: 72, resets_at: null, read_at: '2026-10-28T21:00:00Z', read_node: 'P' }], seen_at: '2026-10-28T21:00:00Z', seen_node: 'P', nodes: [{ node: 'P', current: true, reported_at: '2026-10-28T21:00:00Z' }] },
    { vendor: 'codex', account: 'me@example.com', plan: 'plus', windows: [], seen_at: '2026-10-28T21:00:00Z', seen_node: 'P', nodes: [] },
  ],
}
export const tableFor = scenario => {
  const t = fakeTable(scenario.state)
  if (scenario.state.onboard) t.store_load = { by: 'name', values: {}, fallback: null }
  if (scenario.state.devicesPage) t.store_load = { ...t.store_load, values: { ...t.store_load.values, me: JSON.stringify(ROSTER_ME) } }
  if (scenario.state.partnerTab) { t.relay_list = { members: PARTNER_MEMBERS }; t.store_load = { ...t.store_load, values: { ...t.store_load.values, me: JSON.stringify(PARTNER_ME) } } }
  if (scenario.state.bar) {
    t.relay_list = { members: BAR_MEMBERS[scenario.state.bar] }
    t.store_load = { ...t.store_load, values: { ...t.store_load.values, me: JSON.stringify(PARTNER_ME) } }
    t.relay_launchers = { machines: [{ node: 'P', online: true, launcher: { profiles: [] } }] }   // 這台開放遠端管理：ACP 的切換模型可按
    t.partner_console_query = { can_toggle: true, visible: true }
    if (scenario.state.bar === 'tasks') t.tasks_query = TASKS_SAMPLE
  }
  if (scenario.state.groupTab) {
    t.relay_rooms = { rooms: [GROUP_ROOM] }
    t.relay_room_read = { messages: [] }
    t.relay_group = { by: 'action', values: { group_confirm_list: { confirms: [] } }, fallback: null }
    t.store_load = { ...t.store_load, values: { ...t.store_load.values, me: JSON.stringify(GROUP_ME) } }
  }
  if (scenario.state.roster) t.acct_roster = ROSTER_SAMPLE   // 沒放＝後台沒部署（指令被拒），畫面要退回舊的顯示、不出錯
  return t
}

// 注入頁面的腳本（在任何頁面程式之前執行）：假 Tauri
export const injectSource = table => `(() => {
  const T = ${JSON.stringify(table)};
  const missing = (globalThis.__smokeMissing = []);
  globalThis.__TAURI__ = {
    event: { listen: async () => () => {}, emit: async () => {} },
    window: { getCurrentWindow: () => ({ startResizeDragging() {}, label: 'smoke' }) },
    core: { invoke: async (cmd, args) => {
      if (!Object.prototype.hasOwnProperty.call(T, cmd)) { missing.push(cmd); throw 'command ' + cmd + ' not found' }
      const v = T[cmd];
      if (v && typeof v === 'object' && v.by) { const k = args && args[v.by]; return Object.prototype.hasOwnProperty.call(v.values, k) ? v.values[k] : v.fallback }
      return v === undefined ? null : JSON.parse(JSON.stringify(v));
    } },
  };
})();`

export const pathOf = page => '/' + page.split('?')[0]

// 掛上判斷（在頁面內執行的表達式，回 { ok, why }）：#app 有實際內容、沒有殘留樣板原文、v-cloak 已被 Vue 拿掉、特徵選擇器存在、開機畫面已移除
export const mountCheckSource = (ready, expectedPath) => `(() => {
  const app = document.querySelector('#app');
  if (location.pathname !== ${JSON.stringify(expectedPath)}) return { ok: false, why: '頁面被導到別處：' + location.pathname + location.search };
  if (!app) return { ok: false, why: '找不到 #app' };
  if (app.hasAttribute('v-cloak')) return { ok: false, why: 'Vue 還沒掛上（#app 仍有 v-cloak）' };
  if (!app.innerHTML.trim()) return { ok: false, why: '#app 是空的' };
  if (/\\{\\{/.test(app.innerHTML)) return { ok: false, why: '#app 殘留未渲染的樣板原文' };
  if (!document.querySelector(${JSON.stringify(ready)})) return { ok: false, why: '找不到特徵元素 ' + ${JSON.stringify(ready)} };
  if (document.querySelector('#splash')) return { ok: false, why: '開機畫面 #splash 還在' };
  return { ok: true, why: '' };
})()`

export const selectScenarios = (only, all = SCENARIOS) => {
  if (!only.length) return all
  const bad = only.filter(n => !all.some(s => s.name === n))
  if (bad.length) throw new Error(`沒有這些情境：${bad.join('、')}（可用：${all.map(s => s.name).join('、')}）`)
  return all.filter(s => only.includes(s.name))
}

// ---- 找系統已安裝的 Chrome／Edge（不下載） ----
export const browserCandidates = (platform, env) => {
  if (platform === 'win32') {
    const roots = [env.PROGRAMFILES, env['PROGRAMFILES(X86)'], env.LOCALAPPDATA].filter(Boolean)
    return roots.flatMap(r => [path.join(r, 'Google', 'Chrome', 'Application', 'chrome.exe'), path.join(r, 'Microsoft', 'Edge', 'Application', 'msedge.exe')])
  }
  if (platform === 'darwin') return ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', '/Applications/Chromium.app/Contents/MacOS/Chromium']
  const dirs = (env.PATH || '').split(':').filter(Boolean)
  return ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge', 'microsoft-edge-stable'].flatMap(n => dirs.map(d => path.join(d, n)))
}
export const findBrowser = ({ explicit = '', platform = process.platform, env = process.env, exists = fs.existsSync } = {}) => {
  const pick = explicit || env.ASN_SMOKE_BROWSER
  if (pick) {
    if (!exists(pick)) throw new Error(`指定的瀏覽器不存在：${pick}`)
    return pick
  }
  const found = browserCandidates(platform, env).find(p => exists(p))
  if (!found) throw new Error('找不到已安裝的 Chrome 或 Edge（冒煙測試不會下載瀏覽器）。請安裝其一，或用 --browser <路徑>／環境變數 ASN_SMOKE_BROWSER 指定。')
  return found
}

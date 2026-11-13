// 啟動冒煙測試的純邏輯：參數、入口頁清單、假 Tauri 回應表、瀏覽器尋找、掛上判斷。
// smoke-ui.mjs 負責真的起伺服器與無頭瀏覽器；這裡不碰程序與網路，方便單元測試。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { resetWhen } from '../ui/lib/account-quota.mjs'
import { CHAT_PANE_MIN_W, SIDE_OPEN_W } from '../ui/lib/merge.mjs'
import { LAUNCH_DISPLAY_NOTE, launchRun, launchVendors } from '../ui/lib/mobile-launch.mjs'

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
  mobile: { steps: [['.m-plus-wrap .m-icon-btn', ''], ['.m-plus-menu button', '建立群組']], mask: '.gs-back', cover: ['section[aria-label="夥伴"] .m-head .m-me', '.m-head .m-plus-wrap', 'section[aria-label="夥伴"] .m-search'] },   // 0.2.18：對話分頁也有標頭與搜尋框，指定夥伴頁那一份
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
  // #539 收尾：離線時第 2 格是「喚醒」、可按、換喚醒圖示；點了開喚醒對話框；「管理」裡不再有喚醒
  offline: { bar: [['call', '通話', true], ['window', '喚醒', false], ['model', '切換模型', true], ['subs', '子代理', true], ['tasks', '工作項目', true], ['manage', '管理', false]], wake: true },
  acp: { bar: [['call', '通話', false], ['window', 'ACP 模式', true], ['model', '切換模型', false], ['subs', '子代理', true], ['tasks', '工作項目', true], ['manage', '管理', false]] },
  // 有背景工作：工作項目可按、徽章 3；按下去列出 2 件＋「還有 1 件」；header 不再有「背景工作 N 件」
  tasks: { bar: [['call', '通話', false], ['window', '後台隱藏', false], ['model', '切換模型', false], ['subs', '子代理', false], ['tasks', '工作項目', false], ['manage', '管理', false]], badge: '3', taskItems: ['建置', '跑測試', '還有 1 件沒列出'], header: 'demo' },
}
export const barProbeSource = ({ bar, badge, taskItems, header, wake }) => `(async () => {
  const want = ${JSON.stringify(bar)}, wantWake = ${JSON.stringify(wake === true)};
  const wantBadge = ${JSON.stringify(badge ?? null)}, wantItems = ${JSON.stringify(taskItems ?? null)}, wantHeader = ${JSON.stringify(header ?? null)};
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  let why = '';
  for (let i = 0; i < 60; i++) {
    const bars = [...document.querySelectorAll('.actionbar')].filter(b => b.offsetParent !== null);
    const btns = bars.length === 1 ? [...bars[0].querySelectorAll('.abtn')] : [];
    const off = b => b.getAttribute('aria-disabled') === 'true';
    const got = btns.map(b => [b.dataset.slot || '', b.querySelector('.ab-name')?.textContent.replace(/\\s*▾\\s*$/, '').trim() || '', off(b)]);
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
        // 第 2 格：喚醒時是喚醒圖示、點了開「喚醒」對話框，「管理」選單裡沒有喚醒；不是喚醒時是視窗圖示
        const wb = btns.find(b => b.dataset.slot === 'window');
        const wimg = wb?.querySelector('img')?.getAttribute('src') ?? '';
        if (wantWake) {
          if (wimg !== 'img/ab-wake.svg') return { ok: false, why: '喚醒的圖示是「' + wimg + '」' };
          const mg = btns.find(b => b.dataset.slot === 'manage');
          mg.click(); await sleep(200);
          const left = [...document.querySelectorAll('.ab-menu .mi-t')].map(e => e.textContent.trim()).filter(t => /喚醒/.test(t));
          window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); await sleep(150);
          if (left.length) return { ok: false, why: '「管理」裡還有喚醒' };
          wb.click();
          let dlg = null;
          for (let j = 0; j < 30 && !dlg; j++) { await sleep(100); dlg = document.querySelector('.dlg[role="dialog"][aria-label="喚醒"]') }
          if (!dlg) return { ok: false, why: '點了喚醒沒有開喚醒對話框' };
        } else if (wb && wimg !== 'img/ab-window.svg') return { ok: false, why: '第 2 格圖示是「' + wimg + '」' };
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

// 手機對話頁（不放按鈕列）：上方沒有任何按鈕列（手機版、電腦版的都沒有），管理項目都在右上角「⋯」；
// 「⋯」不列永遠用不到的項目（前台／後台、在線的喚醒、一般視窗的重開／移除），喚醒、切換模型排最前；個人訊息照樣顯示「背景工作 N 件」
// 手機自己是節點 P；夥伴開在另一台電腦 Q（手機只能遠端管理）
export const MBAR_ME = { lastChat: 'Q/demo', navTab: 'chats' }
// 對話記錄樣本（後台 relay_chat_history 的格式）：一來一回，含一則長一點的
const CHAT_MSGS_SAMPLE = [
  { id: '00000000-0000-4000-8000-000000000001', dir: 'me', body: '幫我看一下 CI 為什麼紅了', created_at: '2026-11-13T01:00:00Z', delivered_at: '2026-11-13T01:00:01Z', acked_at: '2026-11-13T01:00:02Z' },
  { id: '00000000-0000-4000-8000-000000000002', dir: 'them', body: '看過了，是 e2e 那一項在找舊的截圖名稱，改成新的名字就會過。', created_at: '2026-11-13T01:01:00Z' },
  { id: '00000000-0000-4000-8000-000000000003', dir: 'me', body: '好，改完推上來', created_at: '2026-11-13T01:02:00Z', delivered_at: '2026-11-13T01:02:01Z' },
  { id: '00000000-0000-4000-8000-000000000004', dir: 'them', body: '推了，新頭 0531。', created_at: '2026-11-13T01:03:00Z' },
]
export const MBAR_MEMBERS = {
  claude: [{ id: 'Q', name: '辦公室', agents: [{ name: 'demo', status: 'idle', cwd_label: 'demo', detail: '背景工作 3 件' }] }],
  offline: [{ id: 'Q', name: '辦公室', agents: [{ name: 'demo', status: 'idle', online: false, cwd_label: 'demo' }] }],
  acp: [{ id: 'Q', name: '辦公室', agents: [{ name: 'demo', status: 'idle', engine: 'gemini', cwd_label: 'demo' }] }],
  busy: [{ id: 'Q', name: '辦公室', agents: [{ name: 'demo', status: 'busy', cwd_label: 'demo' }] }],
}
// lead＝「⋯」前幾項的 [名稱, 反灰]；present／absent＝一定要有／不能有的項目；tasks＝標頭要看到的字（選填）；menu:false＝不打開「⋯」（截對話頁本身）；wake＝點第一項（喚醒）要送出
export const MCHAT_PROBES = {
  plain: { mchat: { menu: false, tasks: '背景工作 3 件' } },
  claude: { mchat: { lead: [['切換模型', false], ['詳情', false]], tasks: '背景工作 3 件', absent: ['喚醒', '重開', '移除'] } },
  acp: { mchat: { lead: [['切換模型', false], ['詳情', false]], present: ['重開', '移除'], absent: ['喚醒'] } },
  offlineMenu: { mchat: { lead: [['喚醒', false], ['切換模型', true]], absent: ['重開', '移除'] } },
  offline: { mchat: { lead: [['喚醒', false], ['切換模型', true]], absent: ['重開', '移除'], wake: true } },
}
export const mchatProbeSource = ({ mchat }) => `(async () => {
  const want = ${JSON.stringify({ lead: [], present: [], absent: [], tasks: '', menu: true, wake: false, ...mchat })};
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const shown = sel => [...document.querySelectorAll(sel)].filter(e => e.offsetParent !== null);
  for (let i = 0; i < 60 && !document.querySelector('.m-chat .chatpane'); i++) await sleep(100);
  await sleep(300);
  const bars = shown('.m-chat .actionbar, .m-chat .m-abar, .m-chat .m-abar-row, .m-chat .m-abtn, .m-chat .abtn');
  if (bars.length) return { ok: false, why: '手機對話頁還有按鈕列：' + bars.map(e => e.className).join('、') };
  if (want.tasks) {
    const conn = document.querySelector('.m-chathead .m-conn')?.textContent ?? '';
    if (!conn.includes(want.tasks)) return { ok: false, why: '標頭沒有「' + want.tasks + '」：' + conn };
  }
  const dots = document.querySelector('.m-chathead .m-icon-btn[aria-label="更多操作"]');
  if (!dots) return { ok: false, why: '找不到「⋯」' };
  if (!want.menu) return { ok: true, why: '' };
  dots.click();
  let rows = [];
  for (let i = 0; i < 30; i++) { await sleep(100); rows = [...document.querySelectorAll('.m-ops-panel .m-ops-item')]; if (rows.length) break }
  const items = rows.map(b => [b.querySelector('.m-opt-t')?.textContent.trim() ?? '', b.getAttribute('aria-disabled') === 'true']);
  if (!items.length) return { ok: false, why: '「⋯」選單是空的' };
  if (JSON.stringify(items.slice(0, want.lead.length)) !== JSON.stringify(want.lead)) return { ok: false, why: '「⋯」前幾項不符：' + JSON.stringify(items) };
  const names = items.map(x => x[0]);
  const lack = want.present.filter(t => !names.includes(t));
  if (lack.length) return { ok: false, why: '「⋯」少了：' + lack.join('、') };
  const bad = items.filter(([t]) => /前台|後台/.test(t) || want.absent.includes(t));
  if (bad.length) return { ok: false, why: '「⋯」不該有：' + bad.map(x => x[0]).join('、') };
  if (want.wake) {
    rows[0].click();
    let run = null;
    for (let j = 0; j < 30 && !run; j++) { await sleep(100); run = document.querySelector('.m-ops-run') }
    if (!run) return { ok: false, why: '點了喚醒沒有送出（對話頁頂端沒有進度）' };
    if (document.querySelector('.m-ops-panel')) return { ok: false, why: '喚醒送出後「⋯」選單沒有收起' };
  }
  return { ok: true, why: '' };
})()`

// 群組分頁（#539 之二）：按鈕列有「群組」，選單是三項（#539 收尾拿掉「輸入邀請碼加入」）；「管理」不再有這些（沒有管理也可以）
export const GROUP_ITEMS = ['邀請別人加入', '加我的另一個 AI', '成員與設定']
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
// 手機群組對話：上方沒有按鈕列，右上角「⋯」打開是群組的三項（邀請、加 AI、成員與設定），沒有「輸入邀請碼加入」
export const MGROUP_ME = { lastChat: 'room:g1', navTab: 'chats' }
export const mgroupProbeSource = ({ mgroup }) => `(async () => {
  const want = ${JSON.stringify(mgroup)};
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  let btn = null;
  for (let i = 0; i < 60 && !btn; i++) { btn = document.querySelector('.m-chathead .m-icon-btn[aria-label="更多操作"]'); if (!btn) await sleep(100) }
  if (!btn) return { ok: false, why: '群組對話沒有「⋯」' };
  const bars = [...document.querySelectorAll('.m-chat .actionbar, .m-chat .m-abar-row, .m-chat .abtn')].filter(e => e.offsetParent !== null);
  if (bars.length) return { ok: false, why: '群組對話還有按鈕列' };
  btn.click();
  let got = [];
  for (let i = 0; i < 30; i++) { await sleep(100); got = [...document.querySelectorAll('.m-ops-panel .m-ops-item .m-opt-t')].map(e => e.textContent.trim()); if (got.length) break }
  if (JSON.stringify(got) !== JSON.stringify(want)) return { ok: false, why: '群組選單不符：' + JSON.stringify(got) };
  return { ok: true, why: '' };
})()`
// 手機群組附件：群組（含有外部成員的群組）看得到「傳照片」「傳送檔案」，選一個檔案會送出 room 附件
export const mattachProbeSource = ({ mattach }) => `(async () => {
  const want = ${JSON.stringify(mattach)};
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const labels = () => [...document.querySelectorAll('.m-chat .toolbar>.tool')].filter(b => b.offsetParent !== null).map(b => b.getAttribute('aria-label'));
  for (let i = 0; i < 60 && !document.querySelector('.m-chat .toolbar .tool'); i++) await sleep(100);
  const got = labels().filter(l => l === '傳照片' || l === '傳送檔案');
  if (JSON.stringify(got) !== JSON.stringify(want.labels)) return { ok: false, why: '群組工具列的附件鈕不符：' + JSON.stringify(got) };
  const bad = labels().filter(l => /語音|麥克風|聽寫/.test(l || ''));
  if (want.labels.length && bad.length) return { ok: false, why: '群組不該有語音鈕：' + bad.join('、') };
  if (!want.labels.length) return { ok: true, why: '' };
  const input = document.querySelector('.m-chat .toolbar input[type=file]:not([accept="image/*"])');
  if (!input) return { ok: false, why: '找不到傳送檔案的 input' };
  const dt = new DataTransfer(); dt.items.add(new File(['hello'], 'a.txt', { type: 'text/plain' }));
  input.files = dt.files; input.dispatchEvent(new Event('change', { bubbles: true }));
  let call = null;
  for (let i = 0; i < 40 && !call; i++) { await sleep(100); call = (globalThis.__smokeCalls || []).find(c => c[0] === 'relay_send_attachment') }
  if (!call) return { ok: false, why: '選了檔案沒有送出附件' };
  if (call[1]?.payload?.room !== 'g1') return { ok: false, why: '附件沒有帶群組代號：' + JSON.stringify(call[1]?.payload?.room) };
  return { ok: true, why: '' };
})()`
// 額度畫面（#374 之三）：「我的帳號」區每個廠牌（data-vendor）的文字要依序含 want 列的每一段；先等 open 指定的入口（手機要從設定點進「帳號」）
// #374：兩條改成額度條（「5 小時」「剩 40%」各自一段）；absent＝那一組裡不能出現的字
const CLAUDE_BARS = ['Claude', '5 小時', '剩 40%', '每週', '剩 72%']
export const QUOTA_PROBES = {
  gemini: { quota: '.dv-my', want: { claude: CLAUDE_BARS, gemini: ['Gemini', '5 小時', '剩', '每週', '剩'] } },
  geminiEmpty: { quota: '.dv-my', want: { claude: CLAUDE_BARS, gemini: ['Gemini', '開 Gemini 視窗後才讀得到'] } },
  mobile: { quota: '.m-dv-my', open: '帳號', want: { claude: CLAUDE_BARS, gemini: ['Gemini', '5 小時', '剩', '每週', '剩'] } },
}
export const quotaProbeSource = ({ quota, open = '', want, absent = {} }) => `(async () => {
  const sel = ${JSON.stringify(quota)}, open = ${JSON.stringify(open)}, want = ${JSON.stringify(want)}, absent = ${JSON.stringify(absent)};
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  if (open) {
    let btn = null;
    for (let i = 0; i < 60 && !btn; i++) { btn = [...document.querySelectorAll('.m-row-btn')].find(b => b.textContent.includes(open)) || null; if (!btn) await sleep(100) }
    if (!btn) return { ok: false, why: '找不到「' + open + '」' };
    btn.click();
  }
  let why = '';
  for (let i = 0; i < 60; i++) {
    const box = document.querySelector(sel);
    why = box ? '' : '找不到「我的帳號」區';
    if (box) for (const [v, parts] of Object.entries(want)) {
      const el = box.querySelector('[data-vendor="' + v + '"]');
      const text = el ? el.textContent.replace(/\\s+/g, ' ') : '';
      let at = 0;
      for (const p of parts) { const k = text.indexOf(p, at); if (k < 0) { why = (el ? v + ' 少了「' + p + '」：' + text : '沒有 ' + v + ' 這一組'); break } at = k + p.length }
      if (!why) for (const p of absent[v] ?? []) if (text.includes(p)) { why = v + ' 不該出現「' + p + '」：' + text; break }
      if (why) break;
    }
    if (!why) return { ok: true, why: '' };
    await sleep(100);
  }
  return { ok: false, why };
})()`
// 手機「設備與帳號」帳號卡（#374）：每張固定三行（帳號＋右邊固定位置的「使用中」／「切換」、方案、額度）；
// 方案寫 Max 這類、沒有底線；額度兩條各有重置時間；舊資料寫「資料較舊」且不是斜體；頁內沒有第二個返回；說明在最下面
export const MCARDS_PROBE = { mcards: true, open: '帳號' }
export const mcardsProbeSource = ({ open }) => `(async () => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const open = ${JSON.stringify(open)};
  let btn = null;
  for (let i = 0; i < 60 && !btn; i++) { btn = [...document.querySelectorAll('.m-row-btn')].find(b => b.textContent.includes(open)) || null; if (!btn) await sleep(100) }
  if (!btn) return { ok: false, why: '找不到「' + open + '」' };
  btn.click();
  let cards = [];
  for (let i = 0; i < 60 && cards.length < 2; i++) { cards = [...document.querySelectorAll('.m-dv-my .m-dv-acct')].filter(c => c.offsetParent !== null); if (cards.length < 2) await sleep(100) }
  if (cards.length < 2) return { ok: false, why: '帳號卡少於 2 張：' + cards.length };
  await sleep(300);
  const rect = (c, sel) => { const e = c.querySelector(sel); return e ? e.getBoundingClientRect() : null };
  let right = null;
  for (const c of cards) {
    const mail = rect(c, '.m-dv-mail'), act = rect(c, '.m-dv-act'), plan = rect(c, '.m-dv-planrow'), quota = rect(c, '.m-dv-quota');
    const name = (c.closest('[data-vendor]')?.dataset.vendor ?? '') + ' ' + (c.querySelector('.m-dv-mail')?.textContent.trim() ?? '');
    if (!mail || !act || !plan || !quota) return { ok: false, why: name + ' 不是三行卡片（少了某一行）' };
    if (Math.abs((act.top + act.bottom) / 2 - (mail.top + mail.bottom) / 2) > Math.max(mail.height, act.height) / 2) return { ok: false, why: name + ' 的使用中／切換不在第一行' };
    if (plan.top < mail.bottom - 1 || quota.top < plan.bottom - 1) return { ok: false, why: name + ' 三行順序不對' };
    if (right === null) right = act.right; else if (Math.abs(act.right - right) > 1) return { ok: false, why: name + ' 的使用中／切換位置跟別張不一樣' };
    const planText = c.querySelector('.m-dv-plan')?.textContent.trim() ?? '';
    if (!planText || /_/.test(planText)) return { ok: false, why: name + ' 的方案寫成「' + planText + '」' };
    if (getComputedStyle(c.querySelector('.m-dv-quota')).fontStyle === 'italic') return { ok: false, why: name + ' 的額度是斜體' };
  }
  const claude = cards.find(c => c.closest('[data-vendor="claude"]'));
  if (!claude) return { ok: false, why: '沒有 Claude 帳號卡' };
  if (claude.querySelector('.m-dv-plan')?.textContent.trim() !== 'Max') return { ok: false, why: 'claude_max 沒寫成 Max' };
  const bars = [...claude.querySelectorAll('.m-dv-bar')];
  if (bars.length !== 2) return { ok: false, why: 'Claude 額度條是 ' + bars.length + ' 條' };
  if (bars.some(b => !(b.querySelector('.m-dv-br')?.textContent.trim() ?? '').endsWith('重置'))) return { ok: false, why: 'Claude 額度條沒有各自的重置時間' };
  if (!cards.some(c => c.textContent.includes('資料較舊'))) return { ok: false, why: '舊資料那張沒寫「資料較舊」' };
  if (document.querySelector('.m-fourth .m-dv-back')) return { ok: false, why: '頁內還有第二個返回' };
  const foot = document.querySelector('.m-fourth .m-dv-foot');
  if (!foot) return { ok: false, why: '最下面沒有說明' };
  const last = [...foot.parentElement.children].filter(e => e.offsetParent !== null).at(-1);
  if (last !== foot) return { ok: false, why: '說明不在最下面' };
  if (Array.from(foot.textContent.trim()).length > 20) return { ok: false, why: '說明超過 20 字' };
  return { ok: true, why: '' };
})()`
// 手機「設備與帳號」返回（修返回鍵退不回設備列表）：從夥伴列表某台設備旁「選項」進來（直接開那台細部）或從設定進來（先看列表），
// 按系統返回鍵一層一層退：細部 → 設備列表 → 收起整頁；兩種進法、一台或多台設備都要。列表＝有 .m-dv-list，細部＝內頁開著但沒有列表
export const MACCT_BACK_PROBE = { macctBack: true }
export const macctBackProbeSource = () => `(async () => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const vis = sel => [...document.querySelectorAll(sel)].some(e => e.offsetParent !== null);
  const view = () => !vis('.m-fourth') ? 'closed' : vis('.m-dv-list') ? 'list' : 'detail';
  const waitView = async want => { for (let i = 0; i < 30 && view() !== want; i++) await sleep(100); await sleep(150); return view() };
  const press = async want => { history.back(); return waitView(want) };
  const one = document.querySelectorAll('.m-ghead-act').length < 2;
  const steps = [];
  const check = (label, got, want) => { steps.push(label + '=' + got); return got === want ? null : { ok: false, why: label + '：應為 ' + want + '，實際 ' + got + '（' + steps.join('；') + '）' } };
  // 一、夥伴列表某台設備旁的「選項」
  const opt = [...document.querySelectorAll('.m-ghead-act')][0];
  if (!opt) return { ok: false, why: '夥伴列表找不到設備旁的「選項」' };
  opt.click();
  let bad = check('選項進來', await waitView('detail'), 'detail'); if (bad) return bad;
  bad = check('返回一次', await press('list'), 'list'); if (bad) return bad;
  if (!one) {
    const rows = [...document.querySelectorAll('.m-dv-accbtn')];
    rows[rows.length - 1].click();
    bad = check('點另一台', await waitView('detail'), 'detail'); if (bad) return bad;
    bad = check('再返回', await press('list'), 'list'); if (bad) return bad;
  }
  bad = check('返回收起', await press('closed'), 'closed'); if (bad) return bad;
  // 二、從設定進來：先看列表，點一台，返回
  const go = [...document.querySelectorAll('.m-tab, [role=tab], button')].find(b => b.textContent.trim() === '設定' || b.getAttribute('aria-label') === '設定');
  if (go) { go.click(); await sleep(300) }
  let btn = null;
  for (let i = 0; i < 30 && !btn; i++) { btn = [...document.querySelectorAll('.m-row-btn')].find(b => b.textContent.includes('設備')) || null; if (!btn) await sleep(100) }
  if (!btn) return { ok: false, why: '找不到設定裡的「設備」（' + steps.join('；') + '）' };
  btn.click();
  bad = check('設定進來', await waitView('list'), 'list'); if (bad) return bad;
  document.querySelector('.m-dv-accbtn').click();
  bad = check('設定點一台', await waitView('detail'), 'detail'); if (bad) return bad;
  bad = check('設定返回一次', await press('list'), 'list'); if (bad) return bad;
  bad = check('設定返回收起', await press('closed'), 'closed'); if (bad) return bad;
  return { ok: true, why: steps.join('；') };
})()`
const MACCT_ME = { navTab: 'list' }
const MACCT_MEMBERS = {
  one: [{ id: 'Q', name: '辦公室', agents: [{ name: 'demo', status: 'idle', cwd_label: 'demo' }] }],
  two: [{ id: 'Q', name: '辦公室', agents: [{ name: 'demo', status: 'idle', cwd_label: 'demo' }] }, { id: 'R', name: '工作機', agents: [{ name: 'demo', status: 'idle', cwd_label: 'demo' }] }],
}
// 手機設定頁排版（#930）：設定 → 設備／帳號，412、360 寬與大字型（字放大 1.3 倍，模擬手機系統的大字型）各一張。
// 檢查：分頁鈕的字沒被切、每列三行都在列內、「這支手機」的圓點和別列對齊、設備頁沒有額度註腳；
// 帳號頁註腳在、沒有「這台沒有存這個帳號」、切換鈕右緣對齊且字沒被切
export const MLAYOUT_PROBES = {
  devices: { mlayout: true, tab: 'devices', big: false },
  accounts: { mlayout: true, tab: 'accounts', big: false },
  devicesBig: { mlayout: true, tab: 'devices', big: true },
  accountsBig: { mlayout: true, tab: 'accounts', big: true },
}
export const mlayoutProbeSource = ({ tab, big }) => `(async () => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const tab = ${JSON.stringify(tab)};
  let btn = null;
  for (let i = 0; i < 60 && !btn; i++) { btn = [...document.querySelectorAll('.m-row-btn')].find(b => b.textContent.includes('設備')) || null; if (!btn) await sleep(100) }
  if (!btn) return { ok: false, why: '找不到設定裡的「設備」' };
  btn.click();
  // 帳號頁的「切換到…」要先讀過各台的帳號回報（點進那台細部才讀）：逐台點進去再返回
  if (tab === 'accounts') {
    await sleep(500);
    const n = document.querySelectorAll('.m-dv-row .m-dv-grip').length;
    for (let i = 0; i < n; i++) {
      const go = [...document.querySelectorAll('.m-dv-row')].filter(r => r.querySelector('.m-dv-grip'))[i]?.querySelector('.m-dv-accbtn');
      if (!go) break;
      go.click(); await sleep(500);
      const back = [...document.querySelectorAll('.m-icon-btn[aria-label="返回"]')].find(e => e.offsetParent !== null);
      if (back) { back.click(); await sleep(400) }
    }
  }
  let seg = null;
  for (let i = 0; i < 60 && !seg; i++) { seg = document.querySelector('.m-dv-segbtn[data-tab="' + tab + '"]'); if (!seg) await sleep(100) }
  if (!seg) return { ok: false, why: '找不到「' + tab + '」分頁鈕' };
  seg.click();
  await sleep(600);
  if (${big ? 'true' : 'false'}) {
    const els = [...document.querySelectorAll('#app *')];
    const sizes = els.map(e => parseFloat(getComputedStyle(e).fontSize) || 0);
    els.forEach((e, i) => { if (sizes[i]) e.style.fontSize = (sizes[i] * 1.3) + 'px' });
    await sleep(300);
  }
  const vis = e => e && e.offsetParent !== null;
  const R = e => e.getBoundingClientRect();
  const textRect = e => { const r = document.createRange(); r.selectNodeContents(e); return r.getBoundingClientRect() };
  for (const b of document.querySelectorAll('.m-dv-segbtn')) {
    const t = textRect(b), r = R(b);
    if (t.bottom > r.bottom + 0.5 || t.top < r.top - 0.5) return { ok: false, why: '分頁鈕「' + b.textContent.trim() + '」的字被切' };
  }
  const foot = [...document.querySelectorAll('.m-dv-foot')].find(vis);
  if (tab === 'devices') {
    const rows = [...document.querySelectorAll('.m-dv-row')].filter(vis);
    if (rows.length < 3) return { ok: false, why: '設備列少於 3 列：' + rows.length };
    if (!rows.some(r => (r.querySelector('.m-dv-line')?.textContent ?? '').includes('還沒收到這台的回報'))) return { ok: false, why: '沒有一列有第三行「還沒收到這台的回報」' };
    const list = R(document.querySelector('.m-dv-list'));
    for (const row of rows) {
      const rr = R(row);
      for (const e of row.querySelectorAll('.m-dv-rn b, .m-dv-rs, .m-dv-line')) {
        const t = textRect(e);
        if (t.bottom > rr.bottom + 0.5 || t.bottom > list.bottom + 0.5) return { ok: false, why: '「' + (row.querySelector('b')?.textContent ?? '') + '」那列的「' + e.textContent.trim() + '」被切' };
      }
    }
    const dots = rows.map(r => R(r.querySelector('.m-dv-dot')).left);
    if (Math.max(...dots) - Math.min(...dots) > 1) return { ok: false, why: '圓點沒對齊：' + dots.map(x => x.toFixed(1)).join('／') };
    if (foot) return { ok: false, why: '設備頁不該有額度註腳' };
  } else {
    if (!foot) return { ok: false, why: '帳號頁沒有額度註腳' };
    if (document.querySelector('.m-dv-my')?.textContent.includes('這台沒有存這個帳號')) return { ok: false, why: '還有「這台沒有存這個帳號」' };
    // 帳號卡片的設備按鈕（原本的「切換到…」按鈕併進來）：字不被切、按鈕與說明字都不超出卡片
    const devs = [...document.querySelectorAll('.m-dv-my .m-dv-dev')].filter(vis);
    if (!devs.length) return { ok: false, why: '沒有設備按鈕可以檢查' };
    for (const b of devs) if (b.scrollWidth > b.clientWidth + 1) return { ok: false, why: '「' + b.textContent.trim() + '」的字被切' };
    for (const c of [...document.querySelectorAll('.m-dv-acct')].filter(c => c.querySelector('.m-dv-dev'))) {
      const box = R(c);
      for (const e of [...c.querySelectorAll('.m-dv-dev, .m-dv-devb small')].filter(vis)) if (R(e).right > box.right + 0.5 || R(e).left < box.left - 0.5) return { ok: false, why: '「' + e.textContent.trim() + '」超出帳號卡' };
    }
  }
  return { ok: true, why: '' };
})()`
// 帳號卡片的設備按鈕（小良哥 11-09）：用過這個帳號的每台一顆；使用中＝黃色、選中（aria-pressed）、有勾與「使用中」（不能只靠顏色）、
// 不停用但按了不做事（不發出任何切換指令）；「用在：」一行與「切換到…」按鈕都拿掉；按鈕不超出卡片；手機不能切換自己
export const DEVBTN_PROBES = { desktop: { devbtn: 'desktop' }, mobile: { devbtn: 'mobile', open: '帳號' } }
export const devbtnProbeSource = ({ devbtn, open = '' }) => `(async () => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const vis = e => e && e.offsetParent !== null;
  const mobile = ${JSON.stringify(devbtn)} === 'mobile', open = ${JSON.stringify(open)};
  if (open) {
    let row = null;
    for (let i = 0; i < 60 && !row; i++) { row = [...document.querySelectorAll('.m-row-btn')].find(b => b.textContent.includes(open)) || null; if (!row) await sleep(100) }
    if (!row) return { ok: false, why: '找不到「' + open + '」' };
    row.click();
  }
  const sel = mobile ? '.m-dv-my .m-dv-dev' : '.dv-my .dv-devbtn';
  let btns = [];
  for (let i = 0; i < 60; i++) { btns = [...document.querySelectorAll(sel)].filter(vis); if (btns.some(b => b.classList.contains('on'))) break; await sleep(100) }
  const on = btns.filter(b => b.classList.contains('on'));
  for (const b of btns) { const t = b.textContent.trim(); const bad = ['✓', '使用中', '（這台）'].find(w => t.includes(w)); if (bad) return { ok: false, why: '設備按鈕「' + t + '」不該有「' + bad + '」，只寫設備名' } }
  if (!on.length) return { ok: false, why: '沒有使用中的設備按鈕（共 ' + btns.length + ' 顆）' };
  for (const b of on) {
    const t = b.textContent.trim();
    if (b.getAttribute('aria-pressed') !== 'true') return { ok: false, why: '「' + t + '」不是選中的樣子（aria-pressed）' };
    if (b.disabled) return { ok: false, why: '使用中的「' + t + '」被停用了' };
    const rgb = (getComputedStyle(b).backgroundColor.match(/[0-9]+/g) || []).map(Number);
    if (!(rgb[0] > 200 && rgb[1] > 170 && rgb[2] < 140)) return { ok: false, why: '使用中的「' + t + '」不是黃色：' + getComputedStyle(b).backgroundColor };
  }
  const box = document.querySelector(mobile ? '.m-dv-my' : '.dv-my');
  if (box.textContent.includes('用在：')) return { ok: false, why: '還有「用在：」那一行' };
  // 卡片與裡面的東西都不超出窗格（窄的時候額度條原本會把卡片撐出去）：卡片在「我的帳號」區內、卡片裡看得到的元素都在卡片內
  const area = box.getBoundingClientRect();
  for (const c of [...box.querySelectorAll(mobile ? '.m-dv-acct' : '.dv-acct')].filter(vis)) {
    const k = c.getBoundingClientRect(), who = c.querySelector(mobile ? '.m-dv-mail' : '.dv-mail')?.textContent.trim() ?? '';
    if (k.right > area.right + 0.5 || k.left < area.left - 0.5) return { ok: false, why: who + ' 的帳號卡超出窗格' };
    for (const e of [...c.querySelectorAll('*')].filter(vis)) { const r = e.getBoundingClientRect(); if (r.width && (r.right > k.right + 0.5 || r.left < k.left - 0.5)) return { ok: false, why: who + ' 的「' + (e.textContent.trim().slice(0, 20) || e.className) + '」超出帳號卡' } }
  }
  if ([...box.querySelectorAll('button')].some(b => vis(b) && b.textContent.includes('切換到'))) return { ok: false, why: '還有「切換到…」按鈕' };
  for (const b of btns) {
    const c = b.closest(mobile ? '.m-dv-acct' : '.dv-acct');
    const r = b.getBoundingClientRect(), k = c.getBoundingClientRect();
    if (r.right > k.right + 0.5 || r.left < k.left - 0.5) return { ok: false, why: '「' + b.textContent.trim() + '」超出帳號卡' };
    if (b.scrollWidth > b.clientWidth + 1) return { ok: false, why: '「' + b.textContent.trim() + '」的字被切' };
  }
  if (!mobile) {
    // 開放查詢是卡片右上 tag 列（和方案、使用中同一排）的標示，不在下方按鈕列
    for (const c of [...box.querySelectorAll('.dv-acct')].filter(vis)) {
      const tag = c.querySelector('.dv-side .dv-shared'), row = c.querySelector('.dv-share');
      if (row && row.textContent.includes('開放查詢')) return { ok: false, why: '「開放查詢」還在下方按鈕列' };
      if (!tag) continue;
      if (tag.textContent.trim() !== '開放查詢') return { ok: false, why: '開放查詢 tag 的字不對：' + tag.textContent.trim() };
      const tr = tag.getBoundingClientRect(), k = c.getBoundingClientRect(), q = c.querySelector('.dv-quota').getBoundingClientRect();
      if (tr.bottom > q.top + 0.5) return { ok: false, why: '開放查詢 tag 不在卡片上方的 tag 列' };
      if (tr.right > k.right + 0.5) return { ok: false, why: '開放查詢 tag 超出卡片' };
    }
    if (![...box.querySelectorAll('.dv-side .dv-shared')].some(vis)) return { ok: false, why: '情境資料有開放分享的帳號，卻沒有看到「開放查詢」tag' };
  }
  const before = (globalThis.__smokeCalls || []).length;
  on[0].click();
  await sleep(600);
  const sw = (globalThis.__smokeCalls || []).slice(before).map(c => c[0]).filter(c => /switch/i.test(c));
  if (sw.length) return { ok: false, why: '按使用中的按鈕發出了切換：' + sw.join('、') };
  if (document.querySelector('.m-sheet.open, .acct-confirm, [role="alertdialog"]')) return { ok: false, why: '按使用中的按鈕跳出了確認畫面' };
  return { ok: true, why: '' };
})()`
// 手機設備細部頁（設備 → 點某台電腦）：整個詳情區塊與底下的廠商卡片、關閉鈕、註腳不能互疊、不能超出視窗、卡片不被水平切掉
export const MDEVSHEET_PROBES = { mobile: { mdevsheet: true } }
export const mdevsheetProbeSource = () => `(async () => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const vis = e => e && e.offsetParent !== null;
  const W = window.innerWidth;
  let btn = null;
  for (let i = 0; i < 60 && !btn; i++) { btn = [...document.querySelectorAll('.m-row-btn')].find(b => b.textContent.includes('設備')) || null; if (!btn) await sleep(100) }
  if (!btn) return { ok: false, why: '找不到設定裡的「設備」' };
  btn.click(); await sleep(500);
  let opened = false;
  for (const row of [...document.querySelectorAll('.m-dv-row')].filter(vis)) {
    if ((row.querySelector('b')?.textContent ?? '').includes('這支手機')) continue;
    const go = row.querySelector('.m-dv-accbtn');
    if (!go) continue;
    go.click(); await sleep(600);
    if ([...document.querySelectorAll('.m-dv-vendor')].some(vis)) { opened = true; break }
    const back = [...document.querySelectorAll('.m-icon-btn[aria-label="返回"]')].find(vis);
    if (back) { back.click(); await sleep(400) }
  }
  if (!opened) return { ok: false, why: '找不到有廠商卡片的電腦細部頁' };
  const R = e => e.getBoundingClientRect();
  const head = [...document.querySelectorAll('.m-dv .m-dv-dh')].find(vis);
  const sec = head && head.parentElement;
  if (!sec) return { ok: false, why: '找不到設備詳情區塊' };
  const sr = R(sec);
  if (sr.left < -0.5 || sr.right > W + 0.5) return { ok: false, why: '詳情區塊超出視窗：' + Math.round(sr.left) + '～' + Math.round(sr.right) + '（視窗寬 ' + W + '）' };
  if (document.documentElement.scrollWidth > W + 1) return { ok: false, why: '頁面出現橫向捲動：' + document.documentElement.scrollWidth + '（視窗寬 ' + W + '）' };
  if (sec.scrollWidth > sec.clientWidth + 1) return { ok: false, why: '詳情區塊內容被水平切掉：' + sec.scrollWidth + '／' + sec.clientWidth };
  const cards = [...document.querySelectorAll('.m-dv-vendor')].filter(vis);
  for (const c of cards) {
    const r = R(c), name = c.querySelector('b')?.textContent.trim() ?? '';
    if (r.left < sr.left - 0.5 || r.right > sr.right + 0.5) return { ok: false, why: '「' + name + '」卡片超出詳情區塊：' + Math.round(r.left) + '～' + Math.round(r.right) + '，區塊 ' + Math.round(sr.left) + '～' + Math.round(sr.right) };
    if (r.right > W + 0.5) return { ok: false, why: '「' + name + '」卡片右邊超出視窗：' + Math.round(r.right) + '／' + W };
    if (c.scrollWidth > c.clientWidth + 1) return { ok: false, why: '「' + name + '」卡片內容被水平切掉' };
    const hit = document.elementFromPoint(r.left + r.width / 2, Math.min(r.top + 20, window.innerHeight - 1));
    if (r.top + 20 < window.innerHeight && r.top + 20 > 0 && hit && !c.contains(hit)) return { ok: false, why: '「' + name + '」卡片上面蓋著別的東西：' + (hit.className || hit.tagName) };
  }
  const close = [...document.querySelectorAll('.m-dv .m-ops-cancel')].find(b => vis(b) && b.textContent.includes('關閉'));
  const foot = [...document.querySelectorAll('.m-dv .m-dv-foot')].find(vis);
  const hit = (r, a, b) => !(a.right <= b.left + 0.5 || a.left >= b.right - 0.5 || a.bottom <= b.top + 0.5 || a.top >= b.bottom - 0.5);
  for (const [label, e] of [['關閉鈕', close], ['額度註腳', foot]]) {
    if (!e) continue;
    const r = R(e);
    for (const c of cards) if (hit(r, r, R(c))) return { ok: false, why: label + '與「' + (c.querySelector('b')?.textContent.trim() ?? '') + '」卡片互疊' };
    if (hit(r, r, sr)) return { ok: false, why: label + '壓在詳情區塊上' };
    if (r.right > W + 0.5 || r.left < -0.5) return { ok: false, why: label + '超出視窗' };
  }
  if (close) {
    close.scrollIntoView({ block: 'center' }); await sleep(200);
    const r = R(close), top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    if (!top || !close.contains(top)) return { ok: false, why: '關閉鈕中心點到的不是它：' + (top ? (top.className || top.tagName) : '無') };
  }
  return { ok: true, why: '' };
})()`
// #930 帳號永遠不能切到這支手機自己：noplat＝這支手機的平台還沒讀到（設備樹會先把它當成電腦）；android＝讀到了
export const MNOSELF_PROBES = { noplat: { mnoself: 'noplat' }, android: { mnoself: 'android' } }
export const mnoselfProbeSource = () => `(async () => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const vis = e => e && e.offsetParent !== null;
  let btn = null;
  for (let i = 0; i < 60 && !btn; i++) { btn = [...document.querySelectorAll('.m-row-btn')].find(b => b.textContent.includes('設備')) || null; if (!btn) await sleep(100) }
  if (!btn) return { ok: false, why: '找不到設定裡的「設備」' };
  btn.click(); await sleep(500);
  const rows = () => [...document.querySelectorAll('.m-dv-row')].filter(vis);
  const n = rows().length;
  if (n < 3) return { ok: false, why: '設備列少於 3 列：' + n };
  let sawSelf = false;
  for (let i = 0; i < n; i++) {
    const row = rows()[i];
    const name = row?.querySelector('b')?.textContent ?? '';
    const go = row?.querySelector('.m-dv-accbtn');
    if (!go) continue;
    go.click(); await sleep(500);
    if (name.includes('這支手機')) {
      sawSelf = true;
      if ([...document.querySelectorAll('.m-dv-sw')].some(vis)) return { ok: false, why: '「這支手機」的細部頁出現切換鈕' };
    }
    const back = [...document.querySelectorAll('.m-icon-btn[aria-label="返回"]')].find(vis);
    if (back) { back.click(); await sleep(400) }
  }
  if (!sawSelf) return { ok: false, why: '設備列表沒有「這支手機」' };
  let seg = null;
  for (let i = 0; i < 60 && !seg; i++) { seg = document.querySelector('.m-dv-segbtn[data-tab="accounts"]'); if (!seg) await sleep(100) }
  if (!seg) return { ok: false, why: '找不到「帳號」分頁鈕' };
  seg.click(); await sleep(600);
  const devs = [...document.querySelectorAll('.m-dv-my .m-dv-dev')].filter(vis);
  const names = devs.map(b => b.textContent.trim()).join('、') || '（沒有按鈕）';
  if (devs.some(b => (b.textContent.includes('這支手機') || b.textContent.includes('測試機')) && !b.classList.contains('on') && !b.disabled)) return { ok: false, why: '帳號頁可以把帳號切到這支手機：' + names };
  if (!devs.some(b => b.textContent.includes('辦公室') && !b.classList.contains('on') && !b.disabled)) return { ok: false, why: '別台電腦的切換鈕不見了：' + names };
  return { ok: true, why: '' };
})()`
// 整合模式窄視窗（#1192）：兩個窗格放不下時一次只顯示一個，右窗格開著時要有「返回名單」回到名單；放得下就維持左右並排。
// single=true：這個寬度必須是單窗格；single=false：必須是兩窗格且右邊夠寬。共通：不橫向捲動、標題不直排、帳號卡看得到
export const MPANE_PROBES = { single: { mpane: true, single: true }, double: { mpane: true, single: false } }
export const MPANE_CHAT_MIN = CHAT_PANE_MIN_W   // 跟斷點用同一個常數（200）
export const mpaneProbeSource = ({ single }) => `(async () => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const shown = e => { if (!e) return false; const r = e.getBoundingClientRect(); return getComputedStyle(e).display !== 'none' && r.width > 0 && r.height > 0 };
  const W = window.innerWidth, wantSingle = ${single ? 'true' : 'false'};
  const list = document.querySelector('.shell > .list-pane'), chat = document.querySelector('.shell > .chat-area');
  if (!list || !chat) return { ok: false, why: '找不到名單或對話窗格' };
  const noScroll = () => document.documentElement.scrollWidth <= W + 1 && document.body.scrollWidth <= W + 1;
  if (!noScroll()) return { ok: false, why: '寬 ' + W + ' 出現橫向捲動：' + document.documentElement.scrollWidth };
  const both = shown(list) && shown(chat);
  if (wantSingle && both) return { ok: false, why: '寬 ' + W + ' 應該一次只顯示一個窗格，但名單 ' + Math.round(list.getBoundingClientRect().width) + 'px、右邊 ' + Math.round(chat.getBoundingClientRect().width) + 'px 同時顯示' };
  if (!wantSingle && !both) return { ok: false, why: '寬 ' + W + ' 應該左右並排，但只顯示一個窗格' };
  if (!shown(chat)) return { ok: false, why: '開著設定時右窗格沒顯示' };
  const cw = chat.getBoundingClientRect().width;
  if (cw < ${MPANE_CHAT_MIN}) return { ok: false, why: '右窗格只有 ' + Math.round(cw) + 'px（至少 ${MPANE_CHAT_MIN}）' };
  const h = document.querySelector('.panel-pane .panel-h');
  if (!h) return { ok: false, why: '找不到設定標題' };
  const lh = parseFloat(getComputedStyle(h).lineHeight) || parseFloat(getComputedStyle(h).fontSize) * 1.3;
  if (h.getBoundingClientRect().height > lh * 2 + 2) return { ok: false, why: '設定標題高 ' + Math.round(h.getBoundingClientRect().height) + 'px，被擠成直排' };
  const card = document.querySelector('.panel-pane .dv-acct');
  if (!card || !shown(card) || card.getBoundingClientRect().width < 120) return { ok: false, why: '帳號卡看不到或太窄：' + (card ? Math.round(card.getBoundingClientRect().width) : '不存在') };
  if (wantSingle) {
    const back = chat.querySelector('button[aria-label="返回名單"]');
    if (!back || !shown(back)) return { ok: false, why: '單窗格顯示右邊時沒有「返回名單」按鈕' };
    if (back.disabled) return { ok: false, why: '返回名單按鈕不能按' };
    back.click(); await sleep(400);
    if (!shown(list) || shown(chat)) return { ok: false, why: '按返回名單後應只剩名單' };
    if (list.getBoundingClientRect().right > W + 1 || !noScroll()) return { ok: false, why: '名單單獨顯示時超出視窗寬 ' + W };
    // 從名單再開一次設定的帳號：應切回右窗格、看得到帳號卡
    const gear = [...list.querySelectorAll('.top-tabs .ttab')].find(e => e.getAttribute('aria-label') === '設定');   // 0.2.18：齒輪拿掉，改成上方的「設定」分頁
    if (!gear) return { ok: false, why: '名單找不到設定分頁' };
    gear.click(); await sleep(300);
    const acct = [...list.querySelectorAll('.cat-list .buddy')].find(e => e.textContent.includes('帳號'));
    if (!acct) return { ok: false, why: '設定清單找不到帳號' };
    acct.click(); await sleep(500);
    if (!shown(chat) || shown(list) || !shown(chat.querySelector('.dv-acct'))) return { ok: false, why: '從名單開帳號後應只顯示右窗格與帳號卡' };
  }
  return { ok: true, why: '' };
})()`
// 整合模式窄視窗、右邊開著對話（#1227 後續）：量右窗格各層寬度，輸入框、傳送鈕要完整看得到。
// 左右並排（single=false）時：對話區（.conv-main）至少 CHAT_CONV_MIN 寬、輸入框與傳送鈕在右窗格內、不橫向溢出；
// 單窗格（single=true）時：只顯示右邊，同樣檢查輸入框完整可見。
export const MPANE_CHAT_PROBES = { single: { mpane: true, chat: true, single: true, folded: true }, double: { mpane: true, chat: true, single: false, folded: true }, wide: { mpane: true, chat: true, single: false, folded: false } }
export const MPANE_CONV_MIN = 160
export const mpaneChatProbeSource = ({ single, folded }) => `(async () => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const shown = e => { if (!e) return false; const r = e.getBoundingClientRect(); return getComputedStyle(e).display !== 'none' && r.width > 0 && r.height > 0 };
  const W = window.innerWidth, wantSingle = ${single ? 'true' : 'false'};
  const R = e => { if (!e) return null; const r = e.getBoundingClientRect(); return { l: Math.round(r.left), w: Math.round(r.width), r: Math.round(r.right) } };
  const q = s => document.querySelector(s);
  let box = null;
  for (let i = 0; i < 40 && !(box = q('.chat-area .compose-main textarea')); i++) await sleep(100);
  await sleep(300);
  const list = q('.shell > .list-pane'), chat = q('.shell > .chat-area');
  const m = { W, list: R(list), chat: R(chat), side: R(q('.chat-area .dp-side')), main: R(q('.chat-area .chatpane-main')), conv: R(q('.chat-area .conv-main')), compose: R(q('.chat-area .compose-main')), ta: R(box), send: R(q('.chat-area .composer .aero-btn')), doc: document.documentElement.scrollWidth };
  if (${JSON.stringify(process.env.ASN_MEASURE || '')}) return { ok: false, why: 'MEASURE ' + JSON.stringify(m) };
  if (!list || !chat) return { ok: false, why: '找不到名單或對話窗格' };
  if (!box) return { ok: false, why: '右邊沒有輸入框：' + JSON.stringify(m) };
  const both = shown(list) && shown(chat);
  if (wantSingle && both) return { ok: false, why: '寬 ' + W + ' 應該一次只顯示一個窗格：' + JSON.stringify(m) };
  if (!wantSingle && !both) return { ok: false, why: '寬 ' + W + ' 應該左右並排：' + JSON.stringify(m) };
  if (document.documentElement.scrollWidth > W + 1 || document.body.scrollWidth > W + 1) return { ok: false, why: '寬 ' + W + ' 出現橫向捲動：' + JSON.stringify(m) };
  const send = q('.chat-area .composer .aero-btn');
  const cr = chat.getBoundingClientRect();
  for (const [name, e] of [['輸入框', box], ['傳送鈕', send]]) {
    if (!shown(e)) return { ok: false, why: name + '看不到：' + JSON.stringify(m) };
    const r = e.getBoundingClientRect();
    if (r.left < cr.left - 1 || r.right > cr.right + 1 || r.right > W + 1) return { ok: false, why: name + '被截掉（超出右窗格 ' + Math.round(cr.left) + '~' + Math.round(cr.right) + '）：' + JSON.stringify(m) };
  }
  if (box.getBoundingClientRect().width < 60) return { ok: false, why: '輸入框只剩 ' + Math.round(box.getBoundingClientRect().width) + 'px：' + JSON.stringify(m) };
  // 大頭貼欄被自動收起（右窗格放不下展開的欄）時展開鈕反灰並寫原因；放得下時照舊可按
  const strip = q('.chat-area .dp-fold-strip'), foldBtn = strip || q('.chat-area .dp-fold-bar');
  if (!foldBtn) return { ok: false, why: '找不到大頭貼欄的收合鈕' };
  if (${folded ? 'true' : 'false'}) {
    if (!strip) return { ok: false, why: '寬 ' + W + ' 大頭貼欄應該被自動收起' };
    if (!strip.disabled) return { ok: false, why: '自動收起時展開鈕應該反灰' };
    const cs = getComputedStyle(strip);
    if (!(parseFloat(cs.opacity) < 1) || cs.cursor === 'pointer') return { ok: false, why: '自動收起時展開鈕要看得出反灰：opacity ' + cs.opacity + '、cursor ' + cs.cursor };
    strip.click(); await sleep(300);   // 反灰的鈕按了不能改設定（放寬後的 widen 探測會確認欄恢復展開）
    if (!q('.chat-area .dp-fold-strip')) return { ok: false, why: '點反灰的展開鈕後欄不該展開' };
    if (strip.title !== '視窗太窄，放寬就會恢復' || strip.getAttribute('aria-label') !== '視窗太窄，放寬就會恢復') return { ok: false, why: '展開鈕提示不對：' + strip.title + ' / ' + strip.getAttribute('aria-label') };
  } else {
    if (strip) return { ok: false, why: '寬 ' + W + ' 大頭貼欄不該被收起' };
    const cs = getComputedStyle(foldBtn);
    if (cs.opacity !== '1' || cs.cursor !== 'pointer') return { ok: false, why: '可按的收合鈕 opacity 要 1、cursor 要 pointer：' + cs.opacity + ' / ' + cs.cursor };
    if (foldBtn.disabled || foldBtn.title.includes('視窗太窄')) return { ok: false, why: '放得下時收合鈕應該可按、沒有「視窗太窄」提示：' + foldBtn.title };
  }
  const conv = q('.chat-area .conv-main');
  if (!conv || conv.getBoundingClientRect().width < ${MPANE_CONV_MIN}) return { ok: false, why: '對話區只有 ' + (conv ? Math.round(conv.getBoundingClientRect().width) : 0) + 'px（至少 ${MPANE_CONV_MIN}）：' + JSON.stringify(m) };
  return { ok: true, why: '' };
})()`
// 放寬視窗後（smoke-ui 把寬度改成 sc.widen 再跑這個）：自動收起沒有寫進設定，所以大頭貼欄要恢復展開、收合鈕可按
export const mpaneWidenProbeSource = () => `(async () => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  await sleep(500);
  const side = document.querySelector('.chat-area .dp-side'), bar = document.querySelector('.chat-area .dp-fold-bar');
  if (!side) return { ok: false, why: '找不到大頭貼欄' };
  if (document.querySelector('.chat-area .dp-fold-strip')) return { ok: false, why: '放寬到 ' + window.innerWidth + ' 後大頭貼欄還是收起（自動收起不該寫進設定）' };
  if (Math.round(side.getBoundingClientRect().width) !== ${SIDE_OPEN_W}) return { ok: false, why: '大頭貼欄寬 ' + side.getBoundingClientRect().width + '，應該恢復展開的 ${SIDE_OPEN_W}' };
  if (!bar || bar.disabled) return { ok: false, why: '放寬後收合鈕應該可按' };
  return { ok: true, why: '' };
})()`
// 手機四個分頁（0.2.18；#1429 改順序與第四格）：開 App 先看「對話」清單；點一則進到對話、「‹」回清單；設定裡打開「關於」，內頁暫時佔第四格（字換成「關於」），
// 切到夥伴、再點第四格回到內頁；分頁列的字與順序和電腦版一樣
export const MTABS_PROBE = { mtabs: true }
export const mtabsProbeSource = () => `(async () => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const inView = e => { if (!e) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.left > -2 && r.right < innerWidth + 2 };
  let tabs = [];
  for (let i = 0; i < 60 && tabs.length < 4; i++) { tabs = [...document.querySelectorAll('.m-tabs button')]; if (tabs.length < 4) await sleep(100) }
  const labels = tabs.map(b => b.textContent.trim()).join('|');
  if (labels !== '夥伴|對話|設定|通知') return { ok: false, why: '分頁的字或順序不對：' + labels };
  const tab = l => tabs.find(b => b.querySelector('span')?.textContent.trim() === l);   // 用字找分頁，不靠位置（#1429 改過順序）
  if (!tab('對話').classList.contains('on')) return { ok: false, why: '開 App 應該先在「對話」（順序改了，預設停的頁不變）' };
  const sec = () => document.querySelector('section.m-pg[aria-label="對話"]');
  let row = null;
  for (let i = 0; i < 60 && !row; i++) { row = sec().querySelector('.m-chat-list .m-buddy, .m-buddy'); if (!row) await sleep(100) }
  if (!row || !sec().classList.contains('m-chat-list')) return { ok: false, why: '對話分頁沒有顯示對話清單' };
  if (!row.textContent.includes('demo')) return { ok: false, why: '清單裡沒有上次那一位：' + row.textContent.trim().slice(0, 30) };
  row.click(); await sleep(500);
  if (!sec().classList.contains('m-chat') || !inView(sec().querySelector('.chatpane'))) return { ok: false, why: '點了沒有進到對話' };
  if (!tab('對話').classList.contains('on')) return { ok: false, why: '進到對話時分頁列應該還標著「對話」' };
  const back = sec().querySelector('[aria-label="回對話清單"]');
  if (!back) return { ok: false, why: '對話上方沒有回清單的鍵' };
  back.click(); await sleep(500);
  if (!sec().classList.contains('m-chat-list')) return { ok: false, why: '按「‹」沒有回到對話清單' };
  tab('設定').click(); await sleep(500);
  const about = [...document.querySelectorAll('section.m-pg[aria-label="設定"] .m-row-btn')].find(b => b.textContent.includes('關於'));
  if (!about) return { ok: false, why: '設定裡找不到「關於」' };
  about.click(); await sleep(600);
  const page = document.querySelector('.m-fourth');
  if (!inView(page)) return { ok: false, why: '「關於」內頁沒有出現在畫面上' };
  // #1429：內頁暫時佔第四格（通知那一格），分頁字換成內頁的標題、選中第四格；分頁還是四個
  let cur = [...document.querySelectorAll('.m-tabs button')];
  if (cur.length !== 4) return { ok: false, why: '內頁不該多出一個分頁' };
  const fourthLabel = () => [...document.querySelectorAll('.m-tabs button')][3]?.querySelector('span')?.textContent.trim();
  if (fourthLabel() !== '關於') return { ok: false, why: '第四格應該換成內頁「關於」，實際：' + fourthLabel() };
  if (!cur[3].classList.contains('on')) return { ok: false, why: '在內頁上分頁列應該標著第四格' };
  const pg = document.querySelector('.m-fourth').getBoundingClientRect();
  if (Math.abs(pg.left) > 2) return { ok: false, why: '內頁沒有停在畫面上（第四格）' };
  tab('夥伴').click(); await sleep(600);
  if (inView(document.querySelector('.m-fourth'))) return { ok: false, why: '切到夥伴後內頁還蓋在畫面上' };
  if (fourthLabel() !== '關於') return { ok: false, why: '離開內頁後第四格應該還是「關於」（3 分鐘內）' };
  [...document.querySelectorAll('.m-tabs button')][3].click(); await sleep(600);
  if (!inView(document.querySelector('.m-fourth'))) return { ok: false, why: '點第四格沒有回到「關於」內頁' };
  return { ok: true, why: '' };
})()`
// 電腦版四個大分頁（0.2.18）：名單上方「夥伴／對話／設定／通知」（#1429 改順序），和手機同樣的字與順序；開窗停在夥伴（本機那台），左邊直排的設備頁籤只在夥伴裡、
// 不再有通知、群組、指引、齒輪；對話分頁最上面有建立／加入群組；設定最後一列是使用指引，點進去有「‹ 設定」回來；點夥伴回到剛才的設備頁籤
export const DTABS_PROBE = { dtabs: true }
export const dtabsProbeSource = () => `(async () => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const shown = e => { if (!e) return false; const r = e.getBoundingClientRect(); return getComputedStyle(e).display !== 'none' && r.width > 0 && r.height > 0 };
  const tops = () => [...document.querySelectorAll('.top-tabs .ttab')];
  for (let i = 0; i < 60 && tops().length < 4; i++) await sleep(100);
  const t = tops(), byLabel = l => t.find(e => e.querySelector('span').textContent.trim() === l);
  const order = t.map(e => e.querySelector('span').textContent.trim()).join('|');
  if (order !== '夥伴|對話|設定|通知') return { ok: false, why: '上方大分頁的字或順序不對：' + order };
  if (!byLabel('夥伴').classList.contains('on')) return { ok: false, why: '開窗應該停在「夥伴」' };
  const rail = document.querySelector('.rail');
  if (!shown(rail)) return { ok: false, why: '夥伴分頁沒有左邊的設備頁籤' };
  if (rail.querySelector('.rtab-notice, .rtab-groups, [aria-label="設定"], [aria-label="指引"]')) return { ok: false, why: '左邊直排頁籤還有通知、群組、指引或齒輪' };
  const devOn = rail.querySelector('.rtab.on');
  const devKey = devOn ? devOn.getAttribute('aria-label') : '';
  if (!devKey) return { ok: false, why: '夥伴分頁沒有選中的設備頁籤' };
  byLabel('對話').click(); await sleep(300);
  if (document.querySelector('.rail')) return { ok: false, why: '對話分頁不該有左邊的設備頁籤' };
  const chats = document.querySelector('.chat-list');
  if (!shown(chats)) return { ok: false, why: '對話分頁沒有顯示對話清單' };
  const acts = [...chats.querySelectorAll('.gl-actions .gs-btn')].map(e => e.textContent.trim()).join('|');
  if (acts !== '建立群組|加入群組') return { ok: false, why: '對話分頁最上面應有建立／加入群組：' + acts };
  byLabel('設定').click(); await sleep(300);
  const entry = document.querySelector('.cat-list .guide-entry');
  if (!shown(entry) || !entry.textContent.includes('使用指引')) return { ok: false, why: '設定清單最後沒有「使用指引」' };
  entry.click(); await sleep(300);
  if (!byLabel('設定').classList.contains('on')) return { ok: false, why: '使用指引應該算在「設定」底下' };
  const back = document.querySelector('.guide-list .guide-back');
  if (!shown(back) || !document.querySelector('.guide-list .guide-item')) return { ok: false, why: '使用指引沒有篇目或沒有「‹ 設定」' };
  back.click(); await sleep(300);
  if (!shown(document.querySelector('.cat-list'))) return { ok: false, why: '按「‹ 設定」沒有回到設定清單' };
  byLabel('夥伴').click(); await sleep(300);
  const again = document.querySelector('.rail .rtab.on');
  if (!again || again.getAttribute('aria-label') !== devKey) return { ok: false, why: '點夥伴沒有回到剛才的設備頁籤' };
  if (document.documentElement.scrollWidth > innerWidth + 1) return { ok: false, why: '視窗出現橫向捲動' };
  return { ok: true, why: '' };
})()`
// 外觀「現代」（0.2.18）：存檔選了現代，畫面一開就是現代（<html data-skin="modern">、主色變青綠），而且沒有橫向捲動；截圖給人看整體樣子
export const SKIN_PROBE = { skinCheck: true }
export const skinProbeSource = () => `(async () => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  for (let i = 0; i < 40 && document.documentElement.dataset.skin !== 'modern'; i++) await sleep(100);
  if (document.documentElement.dataset.skin !== 'modern') return { ok: false, why: '存檔選了現代，畫面卻是 ' + (document.documentElement.dataset.skin || '沒有設定') };
  const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim().toLowerCase();
  if (accent !== '#2f7a70') return { ok: false, why: '現代的主色沒有套上：' + accent };
  const on = document.querySelector('.top-tabs .ttab.on, .m-tabs button.on');
  if (on && getComputedStyle(on).color !== 'rgb(47, 122, 112)') return { ok: false, why: '選中的分頁不是主色：' + getComputedStyle(on).color };
  // 危險動作（忘記這台、移除帳號、登出、退出群組…）的紅色在現代底下還要在：放幾顆同樣 class 的按鈕量顏色
  const host = document.createElement('div'); host.className = 'logout-set'; document.body.appendChild(host);
  const reds = [];
  for (const cls of ['aero-btn danger', 'aero-btn dv-danger', 'gs-btn danger', 'aero-btn logout-btn', 'm-btn m-danger', 'm-btn m-dv-danger']) { const b = document.createElement('button'); b.className = cls; b.textContent = '移除'; host.appendChild(b); reds.push([cls, b]) }
  const redOf = b => { const c = getComputedStyle(b); return cls => (cls === 'm-btn m-dv-danger' ? c.backgroundColor : c.color) };
  const bad = reds.filter(([cls, b]) => redOf(b)(cls) !== 'rgb(179, 38, 30)').map(([cls, b]) => cls + '＝' + redOf(b)(cls));
  host.remove();
  if (bad.length) return { ok: false, why: '危險按鈕在現代底下不是紅色：' + bad.join('、') };
  // #1421 A：畫面上有的元件才量（各情境畫面不同）
  for (let i = 0; i < 20 && document.querySelector('.msgs') && !document.querySelector('.msg .m-body.tone-them, .msg .m-body.tone-me'); i++) await sleep(100);
  const css = (sel, prop, pseudo) => { const el = document.querySelector(sel); return el ? getComputedStyle(el, pseudo).getPropertyValue(prop).trim() : null };
  const checks = [
    ['.msg .m-body.tone-them', 'border-top-left-radius', '18px', '對方訊息卡片的圓角'],
    ['.msg .m-body.tone-me', 'border-top-right-radius', '18px', '自己訊息卡片的圓角'],
    ['.dp', 'border-top-left-radius', '50%', '頭像要是圓的'],
    ['.m-chat .compose-main', 'border-top-width', '1px', '手機輸入框的邊框（mobile.css 的 border:0 不能蓋掉）'],
  ];
  for (const [sel, prop, want, label] of checks) { const v = css(sel, prop); if (v !== null && v !== want) return { ok: false, why: label + '：' + v } }
  const dot = document.querySelector('.dp:not(.room-av)');
  if (dot && getComputedStyle(dot, '::before').content === 'none') return { ok: false, why: '頭像右下沒有狀態點' };
  // 忙碌／離線的標題列、離線的收件人列：要有自己的底色，不能被現代的一般底色（#f6f5f2／白）蓋掉
  const plainBg = ['rgb(246, 245, 242)', 'rgb(255, 255, 255)'];
  for (const [sel, label] of [['.m-chathead.is-busy', '手機標題列忙碌變色'], ['.m-chathead.is-offline', '手機標題列離線變色'], ['.conv-main .to-line.is-offline', '電腦收件人列離線灰底']]) {
    const v = css(sel, 'background-color'); if (v !== null && plainBg.includes(v)) return { ok: false, why: label + '被現代底色蓋掉：' + v }
  }
  // 廣告框（#1421）：現代下是白底細灰框圓角卡片，不留 Aero 的藍框藍底、漸層彩球、斜緞帶
  const adw = document.querySelector('.ad-wrap');
  if (adw) {
    const w = getComputedStyle(adw);
    if (w.backgroundColor !== 'rgb(255, 255, 255)' || w.borderTopColor === 'rgb(155, 184, 214)' || w.borderTopLeftRadius !== '14px') return { ok: false, why: '廣告框外層還是 Aero：' + w.backgroundColor + ' ' + w.borderTopColor + ' ' + w.borderTopLeftRadius };
    const ad = adw.querySelector('.ad:not([style*="display: none"])');
    if (ad && getComputedStyle(ad).backgroundImage !== 'none') return { ok: false, why: '廣告底色還是漸層' };
    const ball = adw.querySelector('.ad-art i');
    if (ball && getComputedStyle(ball).backgroundImage !== 'none') return { ok: false, why: '廣告的彩球還是漸層' };
    const tag = adw.querySelector('.ad-new');
    if (tag && getComputedStyle(tag).transform !== 'none') return { ok: false, why: '廣告的緞帶還是斜的' };
  }
  await sleep(400);
  if (document.documentElement.scrollWidth > innerWidth + 1) return { ok: false, why: '出現橫向捲動' };
  return { ok: true, why: '' };
})()`
export const probeKind = probe => (probe.skinCheck ? '現代外觀檢查' : probe.dtabs ? '電腦版四個大分頁檢查' : probe.mtabs ? '手機四個分頁檢查' : probe.dterm || probe.dtermTab || probe.ltermPause ? '電腦版看終端檢查' : probe.dnotice ? '電腦版通知頁籤檢查' : probe.mpermreq ? '手機權限框分隔線檢查' : probe.mpane ? '整合模式窄視窗檢查' : probe.devbtn ? '帳號設備按鈕檢查' : probe.mtermview ? (probe.statusLine ? '手機看終端狀態列檢查' : probe.swipe ? '手機看終端左右滑檢查' : '手機看終端檢查') : probe.mlaunch ? '手機開新夥伴檢查' : probe.mnoticeLegacy ? '手機舊收發室列併進通知檢查' : probe.mnotice ? '手機通知分頁檢查' : probe.mdevsheet ? '手機設備詳情排版檢查' : probe.mnoself ? '手機不能切到本機檢查' : probe.mcloud ? '手機設備列雲端標示檢查' : probe.mlayout ? '手機設定頁排版檢查' : probe.macctBack ? '手機設備與帳號返回檢查' : probe.mcards ? '手機帳號卡檢查' : probe.mattach ? '手機群組附件檢查' : probe.quota ? '額度畫面檢查' : probe.mgroup ? '手機群組按鈕檢查' : probe.mchat ? '手機對話頁檢查' : probe.bar ? '大按鈕檢查' : probe.group ? '群組按鈕檢查' : '遮罩檢查')
export const probeSource = probe => (probe.skinCheck ? skinProbeSource() : probe.dtabs ? dtabsProbeSource() : probe.mtabs ? mtabsProbeSource() : probe.ltermPause ? ltermPauseProbeSource() : probe.dtermTab ? dtermTabProbeSource(probe.dtermTab) : probe.dterm ? dtermProbeSource(probe.dterm) : probe.dnotice ? dnoticeProbeSource(probe) : probe.mpermreq ? mpermreqProbeSource(probe) : probe.mpane ? (probe.chat ? mpaneChatProbeSource(probe) : mpaneProbeSource(probe)) : probe.devbtn ? devbtnProbeSource(probe) : probe.mtermview ? mtermviewProbeSource(probe) : probe.mlaunch ? mlaunchProbeSource(probe) : probe.mnoticeLegacy ? mnoticeLegacyProbeSource(probe) : probe.mnotice ? mnoticeProbeSource(probe) : probe.mdevsheet ? mdevsheetProbeSource(probe) : probe.mnoself ? mnoselfProbeSource(probe) : probe.mcloud ? mcloudProbeSource(probe) : probe.mlayout ? mlayoutProbeSource(probe) : probe.macctBack ? macctBackProbeSource(probe) : probe.mcards ? mcardsProbeSource(probe) : probe.mattach ? mattachProbeSource(probe) : probe.quota ? quotaProbeSource(probe) : probe.mgroup ? mgroupProbeSource(probe) : probe.mchat ? mchatProbeSource(probe) : probe.bar ? barProbeSource(probe) : probe.group ? groupProbeSource(probe) : maskProbeSource(probe))

// 兩條各自的重置時間（#374）：時間要跟著現在走（畫面用瀏覽器的現在算），所以載入時算一次，探測要找的字用同一個時間算
const SMOKE_NOW = Date.now()
const toMinute = ms => new Date(Math.floor(ms / 60_000) * 60_000).toISOString()
export function resetRoster(now = SMOKE_NOW, { passed = false } = {}) {
  const read = toMinute(now - 10 * 60_000)
  const five = passed ? toMinute(now - 30 * 60_000) : toMinute(now + 3 * 3600_000 + 10 * 60_000)
  const week = toMinute(now + 3 * 24 * 3600_000)
  return {
    now: toMinute(now),
    accounts: [{ vendor: 'claude', account: 'me@example.com', plan: 'claude_max', shared: true, seen_at: read, seen_node: 'P', nodes: [{ node: 'P', current: true, reported_at: read }],
      windows: [{ name: 'five_hour', left_pct: 40, resets_at: five, read_at: read, read_node: 'P' }, { name: 'weekly', left_pct: 72, resets_at: week, read_at: read, read_node: 'P' }] }],
  }
}
const RESET_WEEK_TEXT = resetWhen(resetRoster().accounts[0].windows[1].resets_at, SMOKE_NOW)
export const RESET_PROBES = {
  resets: { quota: '.dv-my', want: { claude: ['Claude', '5 小時', '剩 40%', '約 3 小時後重置', '每週', '剩 72%', RESET_WEEK_TEXT] } },
  passed: { quota: '.dv-my', want: { claude: ['Claude', '每週', '剩 72%'] }, absent: { claude: ['剩 40%'] } },
}
// 手機三行卡片：Claude（claude_max、兩條各有重置時間、使用中）＋ Gemini 一張舊資料（9 小時前讀的）＋ Codex 沒有額度
function cardsRoster(now = SMOKE_NOW) {
  const r = resetRoster(now)
  const old = toMinute(now - 9 * 3600_000)
  return { ...r, accounts: [...r.accounts,
    { vendor: 'gemini', account: 'me@example.com', plan: 'Google AI Pro', seen_at: old, seen_node: 'P', nodes: [{ node: 'P', current: true, reported_at: old }],
      windows: [{ name: 'five_hour', left_pct: 55, resets_at: toMinute(now + 2 * 3600_000), read_at: old, read_node: 'P' }, { name: 'weekly', left_pct: 81, resets_at: toMinute(now + 4 * 24 * 3600_000), read_at: old, read_node: 'P' }] },
    { vendor: 'codex', account: 'me@example.com', plan: 'plus', windows: [], seen_at: old, seen_node: 'P', nodes: [] }] }
}
// #930 手機設定頁排版：這支手機＋兩台電腦（工作機的回報是舊的，第三行會是「還沒收到這台的回報」）；
// 辦公室有兩個 Claude 帳號、ASN 在線（可以切換）；工作機也存了兩個但 ASN 不在線（按鈕停用、左邊有說明字），第 8 點的對齊才看得到
function layoutRoster(now = SMOKE_NOW) {
  const r = resetRoster(now)
  const read = toMinute(now - 10 * 60_000)
  return { ...r, accounts: [...r.accounts,
    { vendor: 'claude', account: 'work@example.com', plan: 'claude_pro', seen_at: read, seen_node: 'Q', nodes: [{ node: 'Q', current: true, reported_at: read }],
      windows: [{ name: 'five_hour', left_pct: 64, resets_at: toMinute(now + 2 * 3600_000), read_at: read, read_node: 'Q' }, { name: 'weekly', left_pct: 50, resets_at: toMinute(now + 3 * 24 * 3600_000), read_at: read, read_node: 'Q' }] }] }
}
// #930：這支手機也掛著 work@（不是使用中），本機若被當成切換對象就會出現「切換到這支手機」
function noselfRoster(now = SMOKE_NOW) {
  const r = layoutRoster(now)
  const read = toMinute(now - 10 * 60_000)
  return { ...r, accounts: r.accounts.map(a => (a.account === 'work@example.com' ? { ...a, nodes: [...a.nodes, { node: 'P', current: false, reported_at: read }] } : a)) }
}
const layoutAcctList = (now = SMOKE_NOW) => ({ by: 'node', values: {
  Q: { asn_online: true, reported_at: toMinute(now - 5 * 60_000), accounts: [{ vendor: 'claude', email: 'work@example.com', plan: 'claude_pro', current: true }, { vendor: 'claude', email: 'me@example.com', plan: 'claude_max', current: false }] },
  R: { asn_online: false, reported_at: toMinute(now - 9 * 24 * 3600_000), accounts: [{ vendor: 'claude', email: 'work@example.com', plan: 'claude_pro', current: true }, { vendor: 'claude', email: 'me@example.com', plan: 'claude_max', current: false }] },
}, fallback: null })
// 手機設備列的「雲端」標示（#930，0.2.15）：一開始沒有任何帳號回報，進設備頁後讀到（不點進任何一台）→ Aegis（只有橋）、日本VM（橋＋代理）、Grok 雲端（雲端代理）各自一列、種類旁標「雲端」；
// 實體電腦不標；這支手機一定是「手機」、不標雲端（平台還沒讀到 noplat、讀到 android 兩種都驗）
const MCLOUD_MEMBERS = [
  { id: 'Q', name: '辦公室', agents: [{ name: 'demo', status: 'idle', engine: 'claude', cwd_label: 'demo' }] },
  { id: 'A', name: '牧陽 Aegis', agents: [{ name: '麗麗', status: 'idle', engine: 'aegis', cwd_label: '' }] },
  { id: 'J', name: '日本VM', agents: [{ name: 'jp-claude', status: 'idle', engine: 'claude', cwd_label: 'jp' }, { name: 'jp-pi', status: 'working', engine: 'pi', cwd_label: 'jp' }] },
  { id: 'G', name: 'Grok 雲端', agents: [{ name: 'Grok正見', status: 'idle', engine: 'cloud', cwd_label: '' }] },
]
const mcloudAcctList = (now = SMOKE_NOW) => ({ by: 'node', values: {
  Q: { asn_online: true, reported_at: toMinute(now - 5 * 60_000), accounts: [{ vendor: 'claude', email: 'work@example.com', plan: 'claude_pro', current: true }] },
  A: { asn_online: false, reported_at: '', accounts: [] },
  J: { asn_online: false, reported_at: '', accounts: [] },
  G: { asn_online: false, reported_at: '', accounts: [] },
}, fallback: null })
export const MCLOUD_PROBE = { mcloud: true }
export const mcloudProbeSource = () => `(async () => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  let btn = null;
  for (let i = 0; i < 60 && !btn; i++) { btn = [...document.querySelectorAll('.m-row-btn')].find(b => b.textContent.includes('設備')) || null; if (!btn) await sleep(100) }
  if (!btn) return { ok: false, why: '找不到設定裡的「設備」' };
  btn.click();
  await sleep(500);
  // 不點進任何一台：進設備頁時就會把各台的帳號回報讀進來（#930），讀到之後雲端節點才標得出來；最多等 3 秒
  const tagged = () => [...document.querySelectorAll('.m-dv-row .m-dv-rs')].filter(e => e.textContent.includes('雲端')).length;
  for (let i = 0; i < 30 && tagged() < 3; i++) await sleep(100);
  await sleep(300);
  const rows = [...document.querySelectorAll('.m-dv-row')].filter(e => e.offsetParent !== null).map(r => ({ name: r.querySelector('.m-dv-rn b')?.textContent.trim() ?? '', kind: r.querySelector('.m-dv-rs')?.textContent.trim() ?? '' }));
  const row = name => rows.find(r => r.name === name);
  for (const name of ['牧陽 Aegis', '日本VM', 'Grok 雲端']) {
    const r = row(name);
    if (!r) return { ok: false, why: '找不到「' + name + '」那列（各自一列）：' + rows.map(x => x.name).join('／') };
    if (!r.kind.startsWith('雲端')) return { ok: false, why: '「' + name + '」沒標雲端：' + r.kind };
  }
  const pc = row('辦公室');
  if (!pc || pc.kind.includes('雲端')) return { ok: false, why: '實體電腦不該標雲端：' + (pc?.kind ?? '找不到') };
  const me = rows.find(r => r.kind.includes('這支手機'));
  if (!me) return { ok: false, why: '找不到這支手機那列' };
  if (!me.kind.startsWith('手機') || me.kind.includes('雲端')) return { ok: false, why: '這支手機要是「手機」、不標雲端：' + me.kind };
  return { ok: true, why: '' };
})()`
// 手機「開新夥伴」第 2 步的運行選項：夥伴 → ＋ → 開新夥伴 → 選辦公室 → 下一步；412、360 寬與大字型（1.3 倍）各一張。
// 辦公室回報的啟動設定只有 Claude；選項名稱、預設都要跟電腦版同一份目錄（model-catalog）算出來的一樣，並看得到「前台或背景」的說明
const MLAUNCH_LAUNCHER = { profiles: [{ id: 'claude' }], cwd_allow: ['D:/work'] }
const MLAUNCH_RUN = launchRun(launchVendors(MLAUNCH_LAUNCHER).find(v => v.id === 'claude'), MLAUNCH_LAUNCHER)
export const MLAUNCH_PROBES = {
  base: { mlaunch: true, big: false, labels: MLAUNCH_RUN.options.map(o => o.label), selected: MLAUNCH_RUN.options.find(o => o.key === MLAUNCH_RUN.selected)?.label ?? '', note: LAUNCH_DISPLAY_NOTE },
}
MLAUNCH_PROBES.big = { ...MLAUNCH_PROBES.base, big: true }
export const mlaunchProbeSource = ({ big, labels, selected, note }) => `(async () => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const vis = e => e && e.offsetParent !== null;
  const want = ${JSON.stringify({ labels, selected, note })};
  const wait = async (fn, n = 80) => { for (let i = 0; i < n; i++) { const v = fn(); if (v) return v; await sleep(100) } return null };
  const plus = await wait(() => document.querySelector('.m-plus-wrap .m-icon-btn'));
  if (!plus) return { ok: false, why: '找不到名單頁的「新增」鈕' };
  plus.click();
  const item = await wait(() => [...document.querySelectorAll('.m-plus-menu button')].find(b => b.textContent.includes('開新夥伴')));
  if (!item) return { ok: false, why: '新增選單沒有「開新夥伴」' };
  item.click();
  const dev = await wait(() => [...document.querySelectorAll('.m-lch .m-opt')].find(b => b.textContent.includes('辦公室') && !b.disabled));
  if (!dev) return { ok: false, why: '第 1 步找不到可選的「辦公室」：' + (document.querySelector('.m-lch')?.innerText || '').slice(0, 120) };
  dev.click();
  await sleep(100);
  const next = [...document.querySelectorAll('.m-lch .m-btn-big')].find(b => b.textContent.includes('下一步'));
  if (!next || next.disabled) return { ok: false, why: '「下一步」不能按' };
  next.click();
  const fs = await wait(() => [...document.querySelectorAll('.m-lch fieldset')].find(f => f.querySelector('legend')?.textContent.trim() === '運行'));
  if (!fs) return { ok: false, why: '第 2 步沒有「運行」選項：' + (document.querySelector('.m-lch')?.innerText || '').slice(0, 120) };
  if (${big ? 'true' : 'false'}) {
    const els = [...document.querySelectorAll('#app *')];
    const sizes = els.map(e => parseFloat(getComputedStyle(e).fontSize) || 0);
    els.forEach((e, i) => { if (sizes[i]) e.style.fontSize = (sizes[i] * 1.3) + 'px' });
  }
  await sleep(400);
  const opts = [...fs.querySelectorAll('.m-opt')];
  const labels = opts.map(o => o.querySelector('.m-opt-t')?.textContent.trim() ?? '');
  if (labels.join('|') !== want.labels.join('|')) return { ok: false, why: '運行選項不對：' + labels.join('、') + '（應為 ' + want.labels.join('、') + '）' };
  const on = opts.filter(o => o.getAttribute('aria-pressed') === 'true').map(o => o.querySelector('.m-opt-t').textContent.trim());
  if (on.join('|') !== want.selected) return { ok: false, why: '預設選到的不對：' + on.join('、') + '（應為 ' + want.selected + '）' };
  const note = document.querySelector('.m-lch-display');
  if (!vis(note) || note.textContent.trim() !== want.note) return { ok: false, why: '沒看到前台或背景的說明：' + (note?.textContent ?? '沒有') };
  fs.scrollIntoView({ block: 'start' });
  await sleep(200);
  const bad = [];
  for (const e of [...fs.querySelectorAll('.m-opt, .m-opt-t, .m-opt-why'), note]) {
    if (e.scrollWidth > e.clientWidth + 1) bad.push(e.textContent.trim().slice(0, 20));
    const r = e.getBoundingClientRect();
    if (r.left < -0.5 || r.right > window.innerWidth + 0.5) bad.push('超出畫面：' + e.textContent.trim().slice(0, 20));
  }
  if (bad.length) return { ok: false, why: '字被切或超出畫面：' + bad.join('、') };
  const de = document.documentElement;
  if (de.scrollWidth > window.innerWidth + 1 || document.body.scrollWidth > window.innerWidth + 1) return { ok: false, why: '頁面有橫向捲動：' + de.scrollWidth + ' > ' + window.innerWidth };
  const m = /#\\d+/.exec(document.querySelector('#app').innerText);
  if (m) return { ok: false, why: '畫面出現議題編號：' + m[0] };
  return { ok: true, why: '' };
})()`
// 手機「通知」分頁（#895，PR-H；0.2.18 起是固定的一格，#1429 起在最後）：四個頁籤固定「夥伴／對話／設定／通知」；通知分頁顯示系統通知對話（唯讀）、紅點在通知那一格。
// view: 'tab'＝存檔停在通知，看到通知內容（不會有紅點，因為正在看）；'dot'＝存檔停在設定，通知那一格亮紅點。412、360 寬與大字型（1.3 倍）各一張
const MNOTICE_ME = { tab: { navTab: 'notice' }, dot: { navTab: 'me' } }
const noticeMails = (now = Date.now()) => [
  { id: '00000000-0000-4000-8000-0000000000a1', from_node: 'Q', from_agent: '額度通知收發室', kind: 'notice:quota', body: '辦公室：Claude 額度剩 18%，約 2 小時後重置。', trust: 'member', to_agent: '測試機', created_at: new Date(now - 9 * 60_000).toISOString() },
  { id: '00000000-0000-4000-8000-0000000000a2', from_node: 'R', from_agent: 'ASN 通知', kind: 'notice:waiting', body: '工作機：夥伴 demo 正在等你確認。', trust: 'member', to_agent: '測試機', created_at: new Date(now - 5 * 60_000).toISOString() },
  { id: '00000000-0000-4000-8000-0000000000a3', from_node: 'Q', from_agent: 'ASN 通知', kind: 'notice:device_key', body: '辦公室：這台的設備金鑰剛換過。', trust: 'member', to_agent: '測試機', created_at: new Date(now - 60_000).toISOString() },
]
// 電腦版「通知」大分頁（方案 A；0.2.18 起是名單上方的大分頁，#1429 起在最後，和手機一樣）：右上角有未讀數；點開是通知清單（分類小籤、新的在前）；名單裡沒有「通知」；
// 通知內文一律純文字（內文夾 <b> 標籤要原樣顯示、不能變成元素）；畫面不能橫向捲動。
// mode：'merged'＝點第一則、右邊顯示內容；'split'＝點第一則改開「通知」對話視窗；'narrow'＝窄視窗只顯示右邊，有「‹ 通知」返回鈕
const DNOTICE_ME = { merged: { winMode: 'merged' }, split: {}, narrow: { winMode: 'merged' } }
const dnoticeMails = (now = Date.now()) => [...noticeMails(now), { id: '00000000-0000-4000-8000-0000000000a4', from_node: 'Q', from_agent: 'ASN 通知', kind: 'notice:login', body: '辦公室有新的登入\n登入的設備 <b>不認得</b> 的話請到設定檢查', trust: 'member', to_agent: '測試機', created_at: new Date(now - 30_000).toISOString() }]
export const DNOTICE_PROBES = { merged: { dnotice: 'merged' }, split: { dnotice: 'split' }, narrow: { dnotice: 'narrow' } }
export const dnoticeProbeSource = ({ dnotice }) => `(async () => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const shown = e => { if (!e) return false; const r = e.getBoundingClientRect(); return getComputedStyle(e).display !== 'none' && r.width > 0 && r.height > 0 };
  const mode = ${JSON.stringify(dnotice)}, W = window.innerWidth;
  const noScroll = () => document.documentElement.scrollWidth <= W + 1 && document.body.scrollWidth <= W + 1;
  const badge = () => { const c = document.querySelector('.top-tabs .ttab-notice .rtab-count'); return c ? c.textContent.trim() : '' };
  let bell = null;
  for (let i = 0; i < 60 && badge() !== '4'; i++) await sleep(100);
  bell = document.querySelector('.top-tabs .ttab-notice');
  if (!bell) return { ok: false, why: '上方沒有「通知」分頁' };
  if (badge() !== '4') return { ok: false, why: '通知頁籤的未讀數應是 4，實際：' + (badge() || '沒有') };
  const tops = [...document.querySelectorAll('.top-tabs .ttab')].filter(shown).sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left);
  const order = tops.map(e => e.querySelector('span').textContent.trim()).join('|');
  if (order !== '夥伴|對話|設定|通知') return { ok: false, why: '上方大分頁的字或順序不對：' + order };
  if (tops[3] !== bell) return { ok: false, why: '通知應是上方最後一個分頁（和手機一樣，#1429）' };
  if (document.querySelector('.rail .rtab-notice, .rail .rtab-groups')) return { ok: false, why: '左邊直排頁籤還有通知或群組' };
  if ([...document.querySelectorAll('.content .buddy')].some(b => b.textContent.trim().startsWith('通知'))) return { ok: false, why: '名單裡還有「通知」' };
  bell.click(); await sleep(300);
  const rows = [...document.querySelectorAll('.notice-list .nt-row')];
  if (rows.length !== 4) return { ok: false, why: '通知清單應有 4 則，實際 ' + rows.length };
  const chips = [...document.querySelectorAll('.notice-list .nt-chip')].map(e => e.textContent.trim()).join('／');
  if (chips !== '全部／卡住／登入／額度／安全／其他') return { ok: false, why: '分類小籤不對：' + chips };
  const first = rows[0];
  if (!first.textContent.includes('辦公室有新的登入')) return { ok: false, why: '最新的一則不在最上面：' + first.textContent.trim().slice(0, 30) };
  if (first.querySelector('b')) return { ok: false, why: '通知內文被當成 HTML（出現 <b> 元素）' };
  if (!first.textContent.includes('<b>不認得</b>')) return { ok: false, why: '摘要沒有原樣顯示角括號' };
  if (!first.querySelector('.nt-dot')) return { ok: false, why: '未讀的通知沒有紅點' };
  if (!document.querySelector('.notice-list .nt-head') || !document.querySelector('.notice-list .nt-all')) return { ok: false, why: '找不到通知標頭或「全部標為已讀」' };
  const chip = t => [...document.querySelectorAll('.notice-list .nt-chip')].find(e => e.textContent.trim() === t);
  chip('登入').click(); await sleep(200);
  const loginRows = document.querySelectorAll('.notice-list .nt-row').length;
  if (loginRows !== 1) return { ok: false, why: '「登入」分類應只剩 1 則，實際 ' + loginRows };
  chip('全部').click(); await sleep(200);
  if (!noScroll()) return { ok: false, why: '寬 ' + W + ' 出現橫向捲動：' + document.documentElement.scrollWidth };
  document.querySelector('.notice-list .nt-row').click(); await sleep(500);
  if (mode === 'split') {
    const calls = (globalThis.__smokeCalls || []).filter(c => c[0] === 'open_chat');
    if (!calls.some(c => c[1] && c[1].id === 'notice:me')) return { ok: false, why: '分離模式點通知應打開「通知」對話視窗' };
    if (document.querySelector('.notice-pane')) return { ok: false, why: '分離模式不該有右邊的通知內容' };
    return noScroll() ? { ok: true, why: '' } : { ok: false, why: '點開後出現橫向捲動' };
  }
  const pane = document.querySelector('.notice-pane');
  if (!shown(pane)) return { ok: false, why: '右邊沒有顯示通知內容' };
  const body = pane.querySelector('.nt-body');
  if (!body || body.querySelector('b') || !body.textContent.includes('<b>不認得</b>')) return { ok: false, why: '通知內容沒有用純文字顯示' };
  if (pane.querySelector('textarea, .compose-row')) return { ok: false, why: '通知內容不該有輸入列' };
  if (document.querySelector('.chat-stack .compose-row')) return { ok: false, why: '通知被開成一般對話分頁' };
  if (badge() !== '3') return { ok: false, why: '點開一則後未讀數應剩 3，實際：' + (badge() || '沒有') };
  if (mode === 'narrow') {
    const list = document.querySelector('.shell > .list-pane');
    if (shown(list)) return { ok: false, why: '窄視窗點開通知後應只顯示右邊' };
    const back = document.querySelector('.chat-area .pane-back');
    if (!shown(back) || back.textContent.replace(/\\s+/g, '') !== '‹通知') return { ok: false, why: '返回鈕應寫「‹ 通知」，實際：' + (back ? back.textContent.trim() : '沒有') };
    back.click(); await sleep(400);
    if (!shown(list) || !document.querySelector('.notice-list')) return { ok: false, why: '按返回後應回到通知清單' };
    if (!noScroll()) return { ok: false, why: '通知清單單獨顯示時出現橫向捲動' };
    document.querySelector('.notice-list .nt-row').click(); await sleep(400);
    if (shown(list) || !shown(document.querySelector('.notice-pane'))) return { ok: false, why: '再點一次應切回右邊的通知內容' };
  }
  return noScroll() ? { ok: true, why: '' } : { ok: false, why: '點開後出現橫向捲動：' + document.documentElement.scrollWidth };
})()`
export const MNOTICE_PROBES = {
  tab: { mnotice: true, view: 'tab', big: false },
  dot: { mnotice: true, view: 'dot', big: false },
  tabBig: { mnotice: true, view: 'tab', big: true },
  dotBig: { mnotice: true, view: 'dot', big: true },
}
export const mnoticeProbeSource = ({ view, big }) => `(async () => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const vis = e => e && e.offsetParent !== null;
  const view = ${JSON.stringify(view)};
  let tabs = [];
  for (let i = 0; i < 60 && tabs.length < 4; i++) { tabs = [...document.querySelectorAll('.m-tabs button')]; if (tabs.length < 4) await sleep(100) }
  if (tabs.length !== 4) return { ok: false, why: '頁籤應該固定四個，實際 ' + tabs.length };
  for (let i = 0; i < 80 && document.querySelector('.m-banner'); i++) await sleep(100);   // 新通知的橫幅幾秒後自己消失，不要蓋住頁籤列
  await sleep(600);
  if (${big ? 'true' : 'false'}) {
    const els = [...document.querySelectorAll('#app *')];
    const sizes = els.map(e => parseFloat(getComputedStyle(e).fontSize) || 0);
    els.forEach((e, i) => { if (sizes[i]) e.style.fontSize = (sizes[i] * 1.3) + 'px' });
    await sleep(300);
  }
  const labels = tabs.map(b => b.querySelector('span')?.textContent.trim());
  if (labels.join('|') !== '夥伴|對話|設定|通知') return { ok: false, why: '四個頁籤的字不對：' + labels.join('、') };
  const tab = l => tabs.find(b => b.querySelector('span')?.textContent.trim() === l);   // 用字找分頁，不靠位置（#1429 改過順序）
  // 四個字都要完整顯示：沒被省略、沒被切、沒有橫向溢出
  const nav = document.querySelector('.m-tabs');
  if (nav.scrollWidth > nav.clientWidth + 1) return { ok: false, why: '頁籤列橫向溢出：' + nav.scrollWidth + ' > ' + nav.clientWidth };
  if (document.documentElement.scrollWidth > window.innerWidth + 1) return { ok: false, why: '整頁橫向溢出' };
  for (const b of tabs) {
    const sp = b.querySelector('span'), r = b.getBoundingClientRect();
    const rg = document.createRange(); rg.selectNodeContents(sp); const t = rg.getBoundingClientRect();
    if (t.left < r.left - 0.5 || t.right > r.right + 0.5) return { ok: false, why: '頁籤「' + sp.textContent.trim() + '」的字超出按鈕：' + Math.round(t.width) + ' > ' + Math.round(r.width) };
    if (t.bottom > r.bottom + 0.5 || t.top < r.top - 0.5) return { ok: false, why: '頁籤「' + sp.textContent.trim() + '」的字被切' };
    if (sp.scrollWidth > sp.clientWidth + 1) return { ok: false, why: '頁籤「' + sp.textContent.trim() + '」被省略號截斷' };
  }
  const dot = tab('通知').querySelector('i.red');
  if (view === 'dot') {
    if (!dot || !vis(dot)) return { ok: false, why: '通知有未讀，通知那一格卻沒有紅點' };
    if (tab('對話').querySelector('i.red')) return { ok: false, why: '對話分頁不該因為通知未讀而亮紅點' };
    const d = dot.getBoundingClientRect(), b = tab('通知').getBoundingClientRect();
    if (d.right > b.right + 0.5 || d.left < b.left - 0.5) return { ok: false, why: '紅點跑出通知那一格' };
    return { ok: true, why: '' };
  }
  if (dot) return { ok: false, why: '正在看通知，紅點應該清掉' };
  if (!tab('通知').classList.contains('on')) return { ok: false, why: '存檔停在通知，通知那一格卻沒選中' };
  const pane = document.querySelector('.m-notice');
  if (!pane || !vis(pane)) return { ok: false, why: '看不到通知分頁的內容' };
  const msgs = [...pane.querySelectorAll('.msg')].filter(vis);
  if (msgs.length < 3) return { ok: false, why: '通知訊息少於 3 則：' + msgs.length };
  const text = pane.textContent;
  for (const w of ['Claude 額度剩 18%', '正在等你確認', '設備金鑰剛換過']) if (!text.includes(w)) return { ok: false, why: '通知內容缺「' + w + '」' };
  if (pane.querySelector('textarea, .compose-row')) return { ok: false, why: '通知是唯讀，不該有輸入列' };
  if (pane.querySelector('.tool.call, .tool.icon.call')) return { ok: false, why: '通知不該有通話鈕' };
  return { ok: true, why: '' };
})()`
// 手機舊「○○收發室」聯絡人列不再出現在夥伴頁／對話頁、改集中在「通知」分頁（#895 驗收，重現 11-06 截圖）：
// 「30家用」節點底下本機存檔裡留著五個舊系統寄件人（沒 kind、各有信），後台另來一封新式通知（kind）與一封舊名無 kind 的信，外加兩位正常夥伴。
// view: 'list'＝存檔停在夥伴頁；'lastchat'＝最後使用的對話是某個舊收發室列（升級前的狀態），對話頁不該還開著它
const LEGACY_SENDERS = [
  { agent: '終端服務收發室', text: '終端服務：設備 30家用 的終端已就緒。' },
  { agent: '登入通知收發室', text: '登入通知：你的帳號剛在新設備登入。' },
  { agent: '等待確認收發室', text: '等待確認：夥伴 demo 正在等你確認。' },
  { agent: '額度通知收發室', text: '額度通知：Claude 額度剩 25%。' },
  { agent: 'H-收發室', text: 'H 設備：本機服務已重新啟動。' },
]
const LEGACY_NODE = 'Q'
const LEGACY_T = Date.parse('2026-11-05T08:00:00Z')
const legacyMembers = () => [
  { id: LEGACY_NODE, name: '30家用', agents: [{ name: 'demo', status: 'idle', cwd_label: 'demo' }, { name: '小工', status: 'idle', cwd_label: 'work' }] },
  { id: 'R', name: '工作機', agents: [{ name: 'alpha', status: 'idle', cwd_label: 'alpha' }] },
]
const legacyChats = () => ({
  friends: LEGACY_SENDERS.map((s, i) => ({ id: `${LEGACY_NODE}/${s.agent}`, node: LEGACY_NODE, agent: s.agent, nick: s.agent, psm: '', engine: null, known: true, onRoster: false, lastAt: LEGACY_T + i * 60_000 })),
  logs: Object.fromEntries(LEGACY_SENDERS.map((s, i) => [`${LEGACY_NODE}/${s.agent}`, [{ k: 'them', text: s.text, t: LEGACY_T + i * 60_000, id: `00000000-0000-4000-8000-00000000b0${i}1` }]])),
})
const legacyMails = (now = Date.now()) => [
  { id: '00000000-0000-4000-8000-00000000c001', from_node: LEGACY_NODE, from_agent: 'ASN 通知', kind: 'notice:device_key', body: '30家用：這台的設備金鑰剛換過。', trust: 'member', to_agent: '測試機', created_at: new Date(now - 120_000).toISOString() },
  { id: '00000000-0000-4000-8000-00000000c002', from_node: LEGACY_NODE, from_agent: 'H-收發室', body: 'H 設備：舊寄件名、沒有類別的新信。', trust: 'member', to_agent: '測試機', created_at: new Date(now - 60_000).toISOString() },
]
const legacyMe = view => (view === 'lastchat' ? { navTab: 'list', lastChat: `${LEGACY_NODE}/${LEGACY_SENDERS[0].agent}` } : { navTab: 'list' })
export const MNOTICE_LEGACY_PROBES = { list: { mnoticeLegacy: true, view: 'list' }, lastchat: { mnoticeLegacy: true, view: 'lastchat' } }
export const mnoticeLegacyProbeSource = ({ view }) => `(async () => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const vis = e => e && e.offsetParent !== null;
  const view = ${JSON.stringify(view)};
  const SENDERS = ${JSON.stringify(LEGACY_SENDERS.map(s => s.agent))};
  const MARKS = ${JSON.stringify([...LEGACY_SENDERS.map(s => s.text.slice(0, 8)), '設備金鑰剛換過', '舊寄件名、沒有類別'])};
  const legacyName = t => { const s = String(t || '').trim(); return s.endsWith('收發室') || s === 'ASN 通知' };
  let tabs = [];
  for (let i = 0; i < 60 && tabs.length < 4; i++) { tabs = [...document.querySelectorAll('.m-tabs button')]; if (tabs.length < 4) await sleep(100) }
  if (tabs.length !== 4) return { ok: false, why: '頁籤應該固定四個，實際 ' + tabs.length };
  const tab = l => tabs.find(b => b.querySelector('span')?.textContent.trim() === l);   // 用字找分頁，不靠位置（#1429 改過順序）
  const pg = label => document.querySelector('section.m-pg[aria-label="' + label + '"]');
  const nicks = () => [...pg('夥伴').querySelectorAll('.m-buddy .b-nick')].map(e => e.textContent.trim());
  for (let i = 0; i < 80 && !(nicks().includes('小工') && nicks().includes('alpha')); i++) await sleep(100);
  for (let i = 0; i < 80 && document.querySelector('.m-banner'); i++) await sleep(100);   // 新通知的橫幅幾秒後自己消失
  await sleep(600);
  // 1) 夥伴頁：正常夥伴在、沒有任何舊系統寄件人列
  const names = nicks();
  for (const n of ['demo', '小工', 'alpha']) if (!names.includes(n)) return { ok: false, why: '夥伴頁少了正常夥伴「' + n + '」：' + names.join('、') };
  const bad = names.filter(legacyName);
  if (bad.length) return { ok: false, why: '夥伴頁還列著系統寄件人：' + [...new Set(bad)].join('、') };
  const listText = pg('夥伴').textContent;
  for (const s of SENDERS) if (listText.includes(s)) return { ok: false, why: '夥伴頁的文字裡還出現「' + s + '」' };
  if (names.includes('通知')) return { ok: false, why: '夥伴頁不該再有「通知」列（通知有自己的分頁）：' + names.join('、') };
  // 2) 對話頁：清單與內容都沒有舊收發室的對話（列、標題、內容都不能有）
  tab('對話').click();
  await sleep(700);
  const chat = pg('對話');
  const rows = [...chat.querySelectorAll('.m-buddy .b-nick')].map(e => e.textContent.trim());
  if (rows.some(legacyName)) return { ok: false, why: '對話清單列著系統寄件人：' + rows.join('、') };
  const title = chat.querySelector('.m-head .m-title')?.textContent.trim() || '';
  if (legacyName(title)) return { ok: false, why: '對話頁開著舊系統寄件人的對話：「' + title + '」' };
  for (const s of SENDERS) if (chat.textContent.includes(s)) return { ok: false, why: '對話頁的文字裡還出現「' + s + '」' };
  for (const w of MARKS) if (chat.textContent.includes(w)) return { ok: false, why: '對話頁顯示了通知內容「' + w + '」（通知只該在通知分頁）' };
  // 3) 「通知」分頁：每位系統寄件人的信都看得到，唯讀，版面不超出畫面寬度
  tab('通知').click();
  await sleep(900);
  if (!tab('通知').classList.contains('on')) return { ok: false, why: '點通知那一格後沒有選中通知' };
  const pane = document.querySelector('.m-notice');
  if (!pane || !vis(pane)) return { ok: false, why: '看不到通知分頁的內容' };
  const text = pane.textContent;
  for (const w of MARKS) if (!text.includes(w)) return { ok: false, why: '通知裡找不到「' + w + '」' };
  if (pane.querySelector('textarea, .compose-row')) return { ok: false, why: '通知是唯讀，不該有輸入列' };
  const W = window.innerWidth;
  if (document.documentElement.scrollWidth > W + 1 || document.body.scrollWidth > W + 1) return { ok: false, why: '整頁橫向溢出：' + document.documentElement.scrollWidth + ' > ' + W };
  if (pane.scrollWidth > pane.clientWidth + 1) return { ok: false, why: '通知內容橫向溢出：' + pane.scrollWidth + ' > ' + pane.clientWidth };
  for (const e of pane.querySelectorAll('.msg, .msg *')) {
    const r = e.getBoundingClientRect();
    if (r.width > 0 && (r.right > W + 1 || r.left < -1)) return { ok: false, why: '通知內容超出畫面寬度：' + (e.className || e.tagName) + ' ' + Math.round(r.left) + '~' + Math.round(r.right) + ' / ' + W };
  }
  return { ok: true, why: '' };
})()`
// ---- 手機看別台電腦夥伴的終端（PR④，只能看）：對話頁頂端「訊息／終端」切換 ----
// 手機是節點 P，夥伴開在另一台電腦 Q；手機端的 Rust 指令之後才有，這裡用假資料驗畫面
import { mtermviewCursorProbeSource } from './smoke-term-cursor.mjs'
import { mtermviewFollowProbeSource } from './smoke-term-follow.mjs'
import { mtermBarProbeSource, mtermSwipeProbeSource } from './smoke-term-swipe.mjs'
import { DTERM_ME, DTERM_ME2, DTERM_MEMBERS, DTERM_MEMBERS2, DTERM_NODE, DTERM_PROBES, DTERM_TAB_PROBES, LTERM_ME, LTERM_MEMBERS, LTERM_PROBES, dtermProbeSource, dtermTabProbeSource, ltermPauseProbeSource } from './smoke-desk-term.mjs'
export const MTERMVIEW_PROBES = {
  cursor: { mtermview: true, cursor: true },
  base: { mtermview: true, big: false },
  big: { mtermview: true, big: true },
  cancel: { mtermview: true, gate: 'cancel' },
  noLock: { mtermview: true, gate: 'no_lock' },
  late: { mtermview: true, gate: 'late' },
  // 停在對話畫面截圖：看切換鈕在這排最後面、寫「終端」、沒有選中樣式（小良哥 11-10）
  toggle: { mtermview: true, big: false, stayChat: true },
  // 看終端時輸入框要照樣在最下面（小良哥 11-10）；kb＝鍵盤開著（視窗高度縮小、輸入框取得焦點）
  composer: { mtermview: true, composer: true, kb: false },
  composerKb: { mtermview: true, composer: true, kb: true },
  follow: { mtermview: true, follow: true },
  // 提示在最下面的狀態列、終端上方沒有那一條（0.2.17）；終端區內水平拖動不換分頁、區外照舊換頁
  // 旗標不能叫 bar：smoke-ui.test.mjs 用 probe.bar 篩大按鈕情境（#539）
  statusLine: { mtermview: true, statusLine: true },
  swipe: { mtermview: true, swipe: true },
}
export const MTERMVIEW_TEXT = [
  'Claude Code v2.1.0  Opus  ~/demo',
  '',
  '> 幫我看一下測試結果',
  '',
  '● 全部 128 項測試通過，沒有失敗。',
  '',
  '╭──────────────────────────────────────────────╮',
  '│ > 輸入訊息                                     │',
  '╰──────────────────────────────────────────────╯',
].join('\r\n')
// 手機權限框（詢問內容從終端抄來，整排分隔線要變成一條細線）：指令前後各四行線、行首有框線；中段再夾一組四行線
export const MPERMREQ_TEXT = '│ ──────────────────────────────\n│ ──────────────────────────────\n│ ──────────────────────────────\n│ ──────────────────────────────\n│ Bash command\n│ npm test --silent\n│ Run the unit tests\n│ ──────────────────────────────\n│ ──────────────────────────────\n│ ──────────────────────────────\n│ ──────────────────────────────\nDo you want to proceed?\n❯ 1. Yes\n  2. No'
export const mpermreqRows = () => [{ id: '11111111-2222-3333-4444-555555555555', node: 'Q', window_name: 'demo', prompt_text: MPERMREQ_TEXT, complete: true, options: [{ n: 1, label: 'Yes' }, { n: 2, label: 'No' }], body_hash: 'a'.repeat(64), expires_at: new Date(Date.now() + 600_000).toISOString() }]
export const mpermreqProbeSource = () => `(async () => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  let box = null;
  for (let i = 0; i < 80 && !box; i++) { box = document.querySelector('.m-perm-text'); if (!box) { for (const fn of ((globalThis.__smokeListeners || {})['relay-bell'] || [])) fn({ event: 'relay-bell', payload: null }); await sleep(250) } }
  if (!box) return { ok: false, why: '權限框沒有跳出來' };
  await sleep(300);
  const ALL = '│┃║| ─━═-_=', RULE = '─━═-_=';
  const lines = box.innerText.split(String.fromCharCode(10));
  const ruleOnly = lines.filter(l => [...l].every(c => ALL.includes(c) || c === String.fromCharCode(9)) && [...l].filter(c => RULE.includes(c)).length >= 3);
  if (ruleOnly.length) return { ok: false, why: '還有整行是分隔線的文字：' + ruleOnly[0].slice(0, 20) };
  const hrs = box.querySelectorAll('hr.m-perm-rule');
  if (hrs.length !== 1) return { ok: false, why: '分隔線應該剛好一條（前後的拿掉、中間四行合成一條），實際 ' + hrs.length };
  if (hrs[0].getBoundingClientRect().height > 3) return { ok: false, why: '分隔線太粗' };
  if (!box.textContent.includes('npm test --silent')) return { ok: false, why: '指令文字不見了' };
  if (!box.textContent.includes('Do you want to proceed?')) return { ok: false, why: '問題文字不見了' };
  const panel = box.closest('.m-ops-panel');
  const bad = [box, panel].find(e => e && e.scrollWidth > e.clientWidth + 1);
  if (bad) return { ok: false, why: '卡片橫向溢出：' + bad.className };
  if (document.documentElement.scrollWidth > window.innerWidth + 1) return { ok: false, why: '整頁橫向溢出' };
  return { ok: true, why: '' };
})()`
export const mtermviewFrames = (id = 'v1') => [1, 2, 3, 4].map(n => ({ event: 'term-view-remote-frame', payload: { id, text: MTERMVIEW_TEXT + '\r\n  更新 ' + n, meta: { cursor_x: 2, cursor_y: 3 + n, cols: 120, rows: 40 } } }))
// 看終端時輸入框要在：可見、可聚焦、在畫面內；終端區的底不超過輸入框的頂（不重疊）；不橫向溢出；切回對話也正常
export const mtermComposerProbeSource = ({ kb }) => `(async () => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const vis = e => e && e.offsetParent !== null;
  let sw = null;
  for (let i = 0; i < 80 && !sw; i++) { sw = document.querySelector('.m-term-switch'); if (!sw) await sleep(100) }
  if (!sw) return { ok: false, why: '對話頁沒有「對話／終端」切換鈕' };
  const H = window.innerHeight, W = window.innerWidth;
  sw.click();
  let rows = '';
  for (let i = 0; i < 80 && !rows.includes('測試通過'); i++) { await sleep(100); rows = document.querySelector('.term-view-screen .xterm-rows')?.textContent || '' }
  if (!rows.includes('測試通過')) return { ok: false, why: '終端畫面沒有出現假畫面的字' };
  await sleep(300);
  const ta = document.querySelector('.m-chat .composer textarea');
  const form = document.querySelector('.m-chat .composer');
  if (!vis(ta) || !vis(form)) return { ok: false, why: '看終端時輸入框被藏起來了' };
  if (${kb ? 'true' : 'false'}) { ta.focus(); await sleep(300) }
  const check = (tag) => {
    const f = form.getBoundingClientRect(), t = ta.getBoundingClientRect();
    const term = document.querySelector('.m-chat .term-remote').getBoundingClientRect();
    if (!(f.height > 20 && t.height > 20)) return tag + '輸入框高度太小：' + Math.round(t.height);
    if (f.top < -0.5 || f.bottom > window.innerHeight + 0.5 || f.left < -0.5 || f.right > window.innerWidth + 0.5) return tag + '輸入框跑出畫面：' + [f.left, f.top, f.right, f.bottom].map(Math.round).join(',') + ' / ' + window.innerWidth + 'x' + window.innerHeight;
    if (!(term.height > 40)) return tag + '終端區被擠扁：' + Math.round(term.height);
    if (term.bottom > f.top + 0.5) return tag + '終端區蓋到輸入框：終端底 ' + Math.round(term.bottom) + ' > 輸入框頂 ' + Math.round(f.top);
    if (term.top < -0.5) return tag + '終端區頂端跑出畫面：' + Math.round(term.top);
    const s = document.querySelector('.m-chat .term-view-screen').getBoundingClientRect();
    if (s.bottom > f.top + 0.5) return tag + '終端畫面溢出到輸入框：' + Math.round(s.bottom) + ' > ' + Math.round(f.top);
    if (document.documentElement.scrollWidth > window.innerWidth + 1 || document.body.scrollWidth > window.innerWidth + 1) return tag + '整頁橫向溢出';
    if (document.documentElement.scrollHeight > window.innerHeight + 1) return tag + '整頁縱向溢出：' + document.documentElement.scrollHeight + ' > ' + window.innerHeight;
    const sr = sw.getBoundingClientRect();
    if (sr.right > window.innerWidth + 0.5 || sr.left < -0.5 || sr.bottom > window.innerHeight + 0.5) return tag + '切換鈕跑出畫面';
    return '';
  };
  let bad = check('看終端：');
  if (bad) return { ok: false, why: bad };
  ta.focus();
  if (document.activeElement !== ta) return { ok: false, why: '輸入框無法取得焦點' };
  const stopSend = e => { e.preventDefault() };
  form.addEventListener('submit', stopSend);
  const setVal = v => { ta.value = v; ta.dispatchEvent(new Event('input', { bubbles: true })) };
  setVal('你好');
  await sleep(100);
  if (ta.value !== '你好') return { ok: false, why: '輸入框打不了字' };
  const btn = form.querySelector('button[type=submit]');
  if (!btn || btn.disabled) return { ok: false, why: '打了字之後傳送鈕沒有啟用' };
  setVal('');
  form.removeEventListener('submit', stopSend);
  await sleep(100);
  bad = check('打字後：');
  if (bad) return { ok: false, why: bad };
  // 切回對話：訊息列表回來、輸入框仍在、不溢出
  sw.click();
  await sleep(500);
  if (!vis(document.querySelector('.m-chat .conv'))) return { ok: false, why: '切回對話後訊息列表沒回來' };
  if (!vis(ta)) return { ok: false, why: '切回對話後輸入框不見了' };
  const f2 = form.getBoundingClientRect();
  if (f2.bottom > window.innerHeight + 0.5 || document.documentElement.scrollWidth > window.innerWidth + 1) return { ok: false, why: '切回對話後版面跑掉' };
  // 再切到終端，讓截圖停在終端畫面
  sw.click();
  rows = '';
  for (let i = 0; i < 60 && !rows.includes('測試通過'); i++) { await sleep(100); rows = document.querySelector('.term-view-screen .xterm-rows')?.textContent || '' }
  if (${kb ? 'true' : 'false'}) ta.focus();
  await sleep(300);
  bad = check('再切到終端：');
  if (bad) return { ok: false, why: bad };
  return { ok: true, why: '' };
})()`
export const mtermviewProbeSource = ({ big, gate, stayChat, cursor, composer, kb, follow, statusLine, swipe }) => statusLine ? mtermBarProbeSource() : swipe ? mtermSwipeProbeSource() : follow ? mtermviewFollowProbeSource() : composer ? mtermComposerProbeSource({ kb }) : cursor ? mtermviewCursorProbeSource() : gate ? mtermviewGateProbeSource(gate) : `(async () => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const vis = e => e && e.offsetParent !== null;
  let sw = null;
  for (let i = 0; i < 80 && !sw; i++) { sw = document.querySelector('.m-term-switch'); if (!sw) await sleep(100) }
  if (!sw) return { ok: false, why: '對話頁沒有「對話／終端」切換鈕' };
  if (${big ? 'true' : 'false'}) {
    const els = [...document.querySelectorAll('#app *')];
    const sizes = els.map(e => parseFloat(getComputedStyle(e).fontSize) || 0);
    els.forEach((e, i) => { if (sizes[i]) e.style.fontSize = (sizes[i] * 1.3) + 'px' });
    await sleep(300);
  }
  // 小良哥 11-10：合成一顆、放在這排最後面、不做選中樣式；字寫「按了會去哪裡」（看對話時「終端」、看終端時「對話」）
  if (document.querySelectorAll('.m-term-switch').length !== 1 || sw.tagName !== 'BUTTON') return { ok: false, why: '對話／終端切換應該只有一顆按鈕' };
  const btns = [sw];
  const plain = () => {
    if (sw.hasAttribute('aria-pressed')) return '有 aria-pressed（不要選中狀態）';
    if (sw.classList.contains('on')) return '有選中樣式（.on）';
    return '';
  };
  const lastInRow = () => {
    const kids = [...sw.parentElement.children].filter(e => e.tagName === 'BUTTON' || e.classList.contains('tool-group')).filter(e => getComputedStyle(e).display !== 'none');
    return kids[kids.length - 1] === sw;
  };
  if (!sw.closest('.compose-row .toolbar')) return { ok: false, why: '切換鈕應該在下方圖示列' };
  if (!lastInRow()) return { ok: false, why: '切換鈕應該放在這排按鈕的最後面' };
  if (sw.getAttribute('aria-label') !== '終端') return { ok: false, why: '看對話時按鈕應該寫「終端」：' + sw.getAttribute('aria-label') };
  if (plain()) return { ok: false, why: '看對話時切換鈕' + plain() };
  if (${stayChat ? 'true' : 'false'}) {
    const r = sw.getBoundingClientRect();
    if (r.width < 43.5 || r.height < 43.5 || r.left < -0.5 || r.right > window.innerWidth + 0.5) return { ok: false, why: '切換鈕跑出畫面或太小' };
    if (document.documentElement.scrollWidth > window.innerWidth + 1) return { ok: false, why: '整頁橫向溢出' };
    return { ok: true, why: '' };
  }
  // 兩個圖示都要整顆在畫面內、夠大好按（電腦版的 44px 觸控下限）
  const inView = () => btns.every(b => { const r = b.getBoundingClientRect(); return r.width >= 43.5 && r.height >= 43.5 && r.left >= -0.5 && r.right <= window.innerWidth + 0.5 && r.top >= -0.5 && r.bottom <= window.innerHeight + 0.5 });
  if (!inView()) return { ok: false, why: '切換圖示跑出畫面或太小' };
  const conv = () => document.querySelector('.m-chat .conv');
  if (!vis(conv())) return { ok: false, why: '一開始應該先顯示訊息列表' };
  sw.click();
  let bar = null;
  for (let i = 0; i < 80 && !(bar && bar.textContent.includes('正在看')); i++) { await sleep(100); bar = document.querySelector('.m-chat .typing') }   // 0.2.17：提示在最下面的狀態列
  if (!bar || !bar.textContent.includes('正在看')) return { ok: false, why: '點「終端」後沒出現「正在看」：' + (document.querySelector('.term-remote')?.textContent || '').slice(0, 80) };
  let rows = '';
  for (let i = 0; i < 60 && !rows.includes('測試通過'); i++) { await sleep(100); rows = document.querySelector('.term-view-screen .xterm-rows')?.textContent || '' }
  if (!rows.includes('測試通過')) return { ok: false, why: '終端畫面沒有出現假畫面的字：' + rows.slice(0, 60) };
  await sleep(300);
  if (vis(conv())) return { ok: false, why: '看終端時訊息列表應該收起來' };
  if (document.querySelector('.term-remote-switch')) return { ok: false, why: '不該有「打字」切換鈕（打字走下方輸入框）' };
  if (document.documentElement.scrollWidth > window.innerWidth + 1) return { ok: false, why: '整頁橫向溢出' };
  if (sw.getAttribute('aria-label') !== '對話') return { ok: false, why: '看終端時按鈕應該寫「對話」：' + sw.getAttribute('aria-label') };
  if (plain()) return { ok: false, why: '看終端時切換鈕' + plain() };
  if (!lastInRow()) return { ok: false, why: '看終端時切換鈕應該還在這排最後面' };
  // 終端至少半個螢幕高（橫向 412 高時曾被擠成 0）；「正在看」縮成一行；輸入框收起、切換圖示仍在畫面內
  const th = document.querySelector('.m-chat .term-remote').getBoundingClientRect().height;
  if (!(th > 0) || th < window.innerHeight * 0.4 - 1) return { ok: false, why: '終端高度不到螢幕的四成（輸入框回來後橫向 412 高約 46%）：' + Math.round(th) + ' / ' + window.innerHeight };
  const sh = document.querySelector('.m-chat .term-view-screen').getBoundingClientRect().height;
  if (!(sh > 0)) return { ok: false, why: '終端畫面高度是 0' };
  if (document.querySelector('.m-chat .term-remote .term-remote-bar')) return { ok: false, why: '終端上方不該再有提示條（已移到最下面的狀態列）' };
  if (!vis(document.querySelector('.m-chat .composer'))) return { ok: false, why: '看終端時輸入框應該還在（小良哥 11-10）' };
  if (!inView()) return { ok: false, why: '看終端時切換圖示跑出畫面' };
  // 切回「對話」：訊息列表回來、終端收掉、有通知那台停止；再切回「終端」讓截圖停在終端畫面
  sw.click();
  await sleep(500);
  if (!vis(conv())) return { ok: false, why: '切回「訊息」後訊息列表沒回來' };
  if (document.querySelector('.term-view-screen')) return { ok: false, why: '切回「訊息」後終端畫面還在' };
  const calls = (globalThis.__smokeCalls || []).map(c => c[0]);
  if (!calls.includes('term_view_remote_start')) return { ok: false, why: '沒呼叫 term_view_remote_start' };
  if ((globalThis.__smokeConfirms || []).length < 1) return { ok: false, why: '發起前沒有先跳本人確認' };
  if (!calls.includes('term_view_remote_stop')) return { ok: false, why: '切回訊息沒呼叫 term_view_remote_stop' };
  if (sw.getAttribute('aria-label') !== '終端') return { ok: false, why: '切回對話後按鈕應該寫「終端」' };
  sw.click();
  rows = '';
  for (let i = 0; i < 60 && !rows.includes('測試通過'); i++) { await sleep(100); rows = document.querySelector('.term-view-screen .xterm-rows')?.textContent || '' }
  if (!rows.includes('測試通過')) return { ok: false, why: '再切回「終端」後畫面沒出來' };
  await sleep(300);
  return { ok: true, why: '' };
})()`
// 本人確認沒過（PR③ 的閘門）：取消＝什麼都不送、靜默回到訊息；沒設螢幕鎖＝顯示提示、也不送。兩種都不能出現任何 start 呼叫
export const mtermviewGateProbeSource = gate => `(async () => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const vis = e => e && e.offsetParent !== null;
  let sw = null;
  for (let i = 0; i < 80 && !sw; i++) { sw = document.querySelector('.m-term-switch'); if (!sw) await sleep(100) }
  if (!sw) return { ok: false, why: '對話頁沒有「對話／終端」切換鈕' };
  sw.click();
  for (let i = 0; i < 30 && (globalThis.__smokeConfirms || []).length < 1; i++) await sleep(100);
  if ((globalThis.__smokeConfirms || []).length < 1) return { ok: false, why: '點「終端」沒有先跳本人確認' };
  if (${JSON.stringify(gate)} === 'late') {
    sw.click();   // 確認還在等（1.5 秒後才回 ok）就切回訊息（這時按鈕寫「對話」）
    await sleep(2500);  // 等確認回 ok
    const late = (globalThis.__smokeCalls || []).map(c => c[0]);
    if (late.includes('term_view_remote_start')) return { ok: false, why: '已經切回訊息，晚回來的 ok 還是送了 term_view_remote_start' };
    if (!vis(document.querySelector('.m-chat .conv'))) return { ok: false, why: '切回訊息後訊息列表應該在' };
    if (document.querySelector('.term-remote')) return { ok: false, why: '切回訊息後不該有終端區' };
    return { ok: true, why: '' };
  }
  await sleep(800);
  const calls = (globalThis.__smokeCalls || []).map(c => c[0]);
  if (calls.includes('term_view_remote_start')) return { ok: false, why: '確認沒過，卻呼叫了 term_view_remote_start' };
  const conv = document.querySelector('.m-chat .conv');
  const area = document.querySelector('.term-remote');
  if (${JSON.stringify(gate)} === 'cancel') {
    if (!vis(conv)) return { ok: false, why: '取消後應該靜默回到訊息列表' };
    if (area) return { ok: false, why: '取消後不該留著終端區：' + area.textContent.slice(0, 60) };
    if (sw.getAttribute('aria-label') !== '終端') return { ok: false, why: '取消後回到對話，按鈕應該寫「終端」' };
    return { ok: true, why: '' };
  }
  const nbar = document.querySelector('.m-chat .typing');
  if (!area || !nbar || !nbar.textContent.includes('這支手機沒有設定螢幕鎖，請先設定再查看終端')) return { ok: false, why: '沒設螢幕鎖要顯示提示（在最下面的狀態列）：' + (nbar?.textContent || '').slice(0, 80) };
  if (document.querySelector('.term-view-screen .xterm')) return { ok: false, why: '沒設螢幕鎖不該開終端畫面' };
  return { ok: true, why: '' };
})()`
// ---- 入口頁清單：每個情境載一頁，指定假狀態、等待的畫面特徵 ----
// ready：頁面掛上後必須存在的選擇器；頁面不能被導走（導走＝流程錯）
export const SCENARIOS = [
  { name: 'm-signed-out', page: 'm.html', state: { signedIn: false, needsLogin: true }, ready: '#app.m .m-login' },
  { name: 'm-signed-in', page: 'm.html', state: { signedIn: true }, ready: '#app.m .m-pager .m-search' },
  { name: 'list', page: 'list.html', state: { signedIn: true }, ready: '#app.win' },
  { name: 'list-roster', page: 'list.html', state: { signedIn: true, devicesPage: true, roster: true }, ready: '#app.win .dv-my .dv-acct' },
  { name: 'list-roster-missing', page: 'list.html', state: { signedIn: true, devicesPage: true }, ready: '#app.win .dv-set' },
  // Gemini 額度（#374 之三）：有額度時兩條都顯示、沒資料時寫提示；Claude 那一組照舊。手機從設定點進「帳號」看同一區
  { name: 'list-roster-gemini', page: 'list.html', state: { signedIn: true, devicesPage: true, roster: 'gemini' }, ready: '#app.win .dv-my .dv-acct', probe: QUOTA_PROBES.gemini },
  { name: 'list-roster-gemini-empty', page: 'list.html', state: { signedIn: true, devicesPage: true, roster: 'geminiEmpty' }, ready: '#app.win .dv-my .dv-acct', probe: QUOTA_PROBES.geminiEmpty },
  { name: 'm-roster-gemini', page: 'm.html', state: { signedIn: true, mroster: true }, ready: '#app.m .m-row-btn', probe: QUOTA_PROBES.mobile },
  // 兩條額度各自的重置時間（#374）：電腦「我的帳號」各條自己寫；已過的那條不列、不寫舊百分比；手機三行卡片（存截圖）
  { name: 'list-roster-resets', page: 'list.html', state: { signedIn: true, devicesPage: true, roster: 'resets' }, ready: '#app.win .dv-my .dv-acct', probe: RESET_PROBES.resets },
  { name: 'list-roster-reset-passed', page: 'list.html', state: { signedIn: true, devicesPage: true, roster: 'resetPassed' }, ready: '#app.win .dv-my .dv-acct', probe: RESET_PROBES.passed },
  { name: 'm-acct-cards', page: 'm.html', state: { signedIn: true, mroster: 'cards' }, ready: '#app.m .m-row-btn', probe: MCARDS_PROBE, shot: 'm-acct-cards.png' },
  { name: 'm-acct-back-one', page: 'm.html', state: { signedIn: true, macct: 'one' }, ready: '#app.m .m-ghead-act', probe: MACCT_BACK_PROBE },
  { name: 'm-acct-back-two', page: 'm.html', state: { signedIn: true, macct: 'two' }, ready: '#app.m .m-ghead-act', probe: MACCT_BACK_PROBE },
  // 手機設定頁排版（#930）：412、360 寬與大字型各一張
  { name: 'm-layout-devices', page: 'm.html', state: { signedIn: true, mlayout: true }, ready: '#app.m .m-row-btn', probe: MLAYOUT_PROBES.devices, shot: 'm-layout-devices-412.png' },
  { name: 'm-layout-devices-360', page: 'm.html', width: 360, state: { signedIn: true, mlayout: true }, ready: '#app.m .m-row-btn', probe: MLAYOUT_PROBES.devices, shot: 'm-layout-devices-360.png' },
  { name: 'm-layout-devices-big', page: 'm.html', width: 360, state: { signedIn: true, mlayout: true }, ready: '#app.m .m-row-btn', probe: MLAYOUT_PROBES.devicesBig, shot: 'm-layout-devices-big.png' },
  { name: 'm-layout-accounts', page: 'm.html', state: { signedIn: true, mlayout: true }, ready: '#app.m .m-row-btn', probe: MLAYOUT_PROBES.accounts, shot: 'm-layout-accounts-412.png' },
  { name: 'm-layout-accounts-360', page: 'm.html', width: 360, state: { signedIn: true, mlayout: true }, ready: '#app.m .m-row-btn', probe: MLAYOUT_PROBES.accounts, shot: 'm-layout-accounts-360.png' },
  // 手機設備列的雲端標示（#930）：這支手機的平台還沒讀到（noplat）、讀到 android 各一張
  { name: 'm-cloud-tag-noplat', page: 'm.html', state: { signedIn: true, mcloud: 'noplat' }, ready: '#app.m .m-row-btn', probe: MCLOUD_PROBE, shot: 'm-cloud-tag-noplat.png' },
  { name: 'm-cloud-tag-android', page: 'm.html', state: { signedIn: true, mcloud: 'android' }, ready: '#app.m .m-row-btn', probe: MCLOUD_PROBE, shot: 'm-cloud-tag-android.png' },
  { name: 'm-layout-accounts-big', page: 'm.html', width: 360, state: { signedIn: true, mlayout: true }, ready: '#app.m .m-row-btn', probe: MLAYOUT_PROBES.accountsBig, shot: 'm-layout-accounts-big.png' },
  { name: 'm-noself-noplat', page: 'm.html', state: { signedIn: true, mnoself: 'noplat' }, ready: '#app.m .m-row-btn', probe: MNOSELF_PROBES.noplat, shot: 'm-noself-noplat.png' },
  { name: 'm-noself-android', page: 'm.html', state: { signedIn: true, mnoself: 'android' }, ready: '#app.m .m-row-btn', probe: MNOSELF_PROBES.android, shot: 'm-noself-android.png' },
  // 帳號卡片的設備按鈕：桌面兩種寬度、手機兩種寬度
  { name: 'list-acct-devbtn', page: 'list.html', state: { signedIn: true, devicesPage: true, roster: 'resets' }, ready: '#app.win .dv-my .dv-acct', probe: DEVBTN_PROBES.desktop, shot: 'list-acct-devbtn-1100.png' },
  { name: 'list-acct-devbtn-520', page: 'list.html', width: 520, state: { signedIn: true, devicesPage: true, roster: 'resets' }, ready: '#app.win .dv-my .dv-acct', probe: DEVBTN_PROBES.desktop, shot: 'list-acct-devbtn-520.png' },
  { name: 'list-merged-280', page: 'list.html', width: 280, state: { signedIn: true, devicesPage: true, roster: 'resets' }, ready: '#app.win .dv-my .dv-acct', probe: MPANE_PROBES.single, shot: 'list-merged-280.png' },
  { name: 'list-merged-360', page: 'list.html', width: 360, state: { signedIn: true, devicesPage: true, roster: 'resets' }, ready: '#app.win .dv-my .dv-acct', probe: MPANE_PROBES.single, shot: 'list-merged-360.png' },
  { name: 'list-merged-chat-520', page: 'list.html', width: 520, widen: 700, state: { signedIn: true, partnerTab: true }, ready: '#app.win .chat-area .compose-main', probe: MPANE_CHAT_PROBES.double, shot: 'list-merged-chat-520.png' },
  { name: 'list-merged-chat-600', page: 'list.html', width: 600, state: { signedIn: true, partnerTab: true }, ready: '#app.win .chat-area .compose-main', probe: MPANE_CHAT_PROBES.double, shot: 'list-merged-chat-600.png' },
  { name: 'list-merged-chat-700', page: 'list.html', width: 700, state: { signedIn: true, partnerTab: true }, ready: '#app.win .chat-area .compose-main', probe: MPANE_CHAT_PROBES.wide, shot: 'list-merged-chat-700.png' },
  { name: 'list-merged-chat-800', page: 'list.html', width: 800, state: { signedIn: true, partnerTab: true }, ready: '#app.win .chat-area .compose-main', probe: MPANE_CHAT_PROBES.wide, shot: 'list-merged-chat-800.png' },
  { name: 'list-merged-chat-500', page: 'list.html', width: 500, state: { signedIn: true, partnerTab: true }, ready: '#app.win .chat-area .compose-main', probe: MPANE_CHAT_PROBES.single, shot: 'list-merged-chat-500.png' },
  { name: 'list-merged-chat-655', page: 'list.html', width: 655, state: { signedIn: true, partnerTab: true }, ready: '#app.win .chat-area .compose-main', probe: MPANE_CHAT_PROBES.double, shot: 'list-merged-chat-655.png' },
  { name: 'list-merged-chat-656', page: 'list.html', width: 656, state: { signedIn: true, partnerTab: true }, ready: '#app.win .chat-area .compose-main', probe: MPANE_CHAT_PROBES.wide, shot: 'list-merged-chat-656.png' },
  { name: 'list-merged-520', page: 'list.html', width: 520, state: { signedIn: true, devicesPage: true, roster: 'resets' }, ready: '#app.win .dv-my .dv-acct', probe: MPANE_PROBES.double, shot: 'list-merged-520.png' },
  { name: 'm-acct-devbtn', page: 'm.html', state: { signedIn: true, mnoself: 'android' }, ready: '#app.m .m-row-btn', probe: DEVBTN_PROBES.mobile, shot: 'm-acct-devbtn-412.png' },
  { name: 'm-acct-devbtn-360', page: 'm.html', width: 360, state: { signedIn: true, mnoself: 'android' }, ready: '#app.m .m-row-btn', probe: DEVBTN_PROBES.mobile, shot: 'm-acct-devbtn-360.png' },
  { name: 'm-devsheet', page: 'm.html', state: { signedIn: true, mnoself: 'android' }, ready: '#app.m .m-row-btn', probe: MDEVSHEET_PROBES.mobile, shot: 'm-devsheet-412.png' },
  { name: 'm-devsheet-360', page: 'm.html', width: 360, state: { signedIn: true, mnoself: 'android' }, ready: '#app.m .m-row-btn', probe: MDEVSHEET_PROBES.mobile, shot: 'm-devsheet-360.png' },
  // 手機「通知」分頁（#895）：通知分頁看到幾則通知＋四個頁籤的字都放得下；以及通知那一格的未讀紅點。412、360 寬與大字型各一張
  // 手機開新夥伴的運行選項（#931）：名稱與預設跟電腦版同一份目錄，另有「前台或背景」的說明。412、360 寬與大字型各一張
  { name: 'm-launch', page: 'm.html', state: { signedIn: true, mlaunch: true }, ready: '#app.m .m-plus-wrap', probe: MLAUNCH_PROBES.base, shot: 'm-launch-412.png' },
  { name: 'm-launch-360', page: 'm.html', width: 360, state: { signedIn: true, mlaunch: true }, ready: '#app.m .m-plus-wrap', probe: MLAUNCH_PROBES.base, shot: 'm-launch-360.png' },
  { name: 'm-launch-big', page: 'm.html', width: 360, state: { signedIn: true, mlaunch: true }, ready: '#app.m .m-plus-wrap', probe: MLAUNCH_PROBES.big, shot: 'm-launch-big.png' },
  { name: 'm-notice-tab', page: 'm.html', state: { signedIn: true, mnotice: 'tab' }, ready: '#app.m .m-notice .msg', probe: MNOTICE_PROBES.tab, shot: 'm-notice-tab-412.png' },
  { name: 'm-notice-tab-360', page: 'm.html', width: 360, state: { signedIn: true, mnotice: 'tab' }, ready: '#app.m .m-notice .msg', probe: MNOTICE_PROBES.tab, shot: 'm-notice-tab-360.png' },
  { name: 'm-notice-tab-big', page: 'm.html', width: 360, state: { signedIn: true, mnotice: 'tab' }, ready: '#app.m .m-notice .msg', probe: MNOTICE_PROBES.tabBig, shot: 'm-notice-tab-big.png' },
  // 手機看別台電腦夥伴的終端（PR④，只能看）：「訊息／終端」切換、終端畫面占滿訊息區、不能打字。412、360 寬與大字型各一張
  // 手機權限框的分隔線：指令前後各四行線、行首有框線 → 只剩一條細線、沒有整行分隔字元、不橫向溢出。412 寬
  { name: 'm-perm-rules', page: 'm.html', state: { signedIn: true, mpermreq: true }, ready: '#app.m .m-pager .m-search', probe: { mpermreq: true }, shot: 'm-perm-rules-412.png' },
  { name: 'm-term-view', page: 'm.html', state: { signedIn: true, mtermview: true }, ready: '#app.m .m-term-switch', probe: MTERMVIEW_PROBES.base, shot: 'm-term-view-412.png' },
  { name: 'm-term-view-360', page: 'm.html', width: 360, state: { signedIn: true, mtermview: true }, ready: '#app.m .m-term-switch', probe: MTERMVIEW_PROBES.base, shot: 'm-term-view-360.png' },
  { name: 'm-term-cursor', page: 'm.html', state: { signedIn: true, mtermview: true }, ready: '#app.m .m-term-switch', probe: MTERMVIEW_PROBES.cursor, shot: 'm-term-cursor-412.png' },
  { name: 'm-term-cursor-360', page: 'm.html', width: 360, state: { signedIn: true, mtermview: true }, ready: '#app.m .m-term-switch', probe: MTERMVIEW_PROBES.cursor, shot: 'm-term-cursor-360.png' },
  { name: 'm-term-view-big', page: 'm.html', width: 360, state: { signedIn: true, mtermview: true }, ready: '#app.m .m-term-switch', probe: MTERMVIEW_PROBES.big, shot: 'm-term-view-big.png' },
  { name: 'm-term-view-land', page: 'm.html', width: 915, height: 412, state: { signedIn: true, mtermview: true }, ready: '#app.m .m-term-switch', probe: MTERMVIEW_PROBES.base, shot: 'm-term-view-land.png' },
  { name: 'm-term-view-cancel', page: 'm.html', width: 360, state: { signedIn: true, mtermview: 'cancel' }, ready: '#app.m .m-term-switch', probe: MTERMVIEW_PROBES.cancel, shot: 'm-term-view-cancel.png' },
  { name: 'm-term-view-nolock', page: 'm.html', width: 360, state: { signedIn: true, mtermview: 'no_lock' }, ready: '#app.m .m-term-switch', probe: MTERMVIEW_PROBES.noLock, shot: 'm-term-view-nolock.png' },
  { name: 'm-term-view-late', page: 'm.html', width: 360, state: { signedIn: true, mtermview: 'late' }, ready: '#app.m .m-term-switch', probe: MTERMVIEW_PROBES.late, shot: 'm-term-view-late.png' },
  // 對話／終端合成一顆、放在最後面（小良哥 11-10）：停在對話畫面截圖，412、360 兩種寬度
  { name: 'm-term-toggle', page: 'm.html', state: { signedIn: true, mtermview: true }, ready: '#app.m .m-term-switch', probe: MTERMVIEW_PROBES.toggle, shot: 'm-term-toggle-412.png' },
  { name: 'm-term-toggle-360', page: 'm.html', width: 360, state: { signedIn: true, mtermview: true }, ready: '#app.m .m-term-switch', probe: MTERMVIEW_PROBES.toggle, shot: 'm-term-toggle-360.png' },
  // 看終端時輸入框照樣在最下面、終端縮到它上面不重疊；412、360 寬各兩種：鍵盤收著（高 800）、鍵盤開著（高 420、輸入框聚焦）
  { name: 'm-term-composer', page: 'm.html', state: { signedIn: true, mtermview: true }, ready: '#app.m .m-term-switch', probe: MTERMVIEW_PROBES.composer, shot: 'm-term-composer-412.png' },
  { name: 'm-term-composer-360', page: 'm.html', width: 360, state: { signedIn: true, mtermview: true }, ready: '#app.m .m-term-switch', probe: MTERMVIEW_PROBES.composer, shot: 'm-term-composer-360.png' },
  { name: 'm-term-composer-kb', page: 'm.html', height: 420, state: { signedIn: true, mtermview: true }, ready: '#app.m .m-term-switch', probe: MTERMVIEW_PROBES.composerKb, shot: 'm-term-composer-kb-412.png' },
  { name: 'm-term-composer-kb-360', page: 'm.html', width: 360, height: 420, state: { signedIn: true, mtermview: true }, ready: '#app.m .m-term-switch', probe: MTERMVIEW_PROBES.composerKb, shot: 'm-term-composer-kb-360.png' },
  // 鍵盤開著（視窗高 420）、40 列假畫面、游標在倒數第 2 列：游標那一列要完整看得到；使用者捲到頂後來新畫面不拉回去
  { name: 'm-term-follow', page: 'm.html', height: 420, state: { signedIn: true, mtermview: true }, ready: '#app.m .m-term-switch', probe: MTERMVIEW_PROBES.follow, shot: 'm-term-follow-412.png' },
  { name: 'm-term-status', page: 'm.html', state: { signedIn: true, mtermview: true }, ready: '#app.m .m-term-switch', probe: MTERMVIEW_PROBES.statusLine, shot: 'm-term-status-412.png' },
  { name: 'm-term-status-360', page: 'm.html', width: 360, state: { signedIn: true, mtermview: true }, ready: '#app.m .m-term-switch', probe: MTERMVIEW_PROBES.statusLine, shot: 'm-term-status-360.png' },
  { name: 'm-term-swipe', page: 'm.html', state: { signedIn: true, mtermview: true }, ready: '#app.m .m-term-switch', probe: MTERMVIEW_PROBES.swipe, shot: 'm-term-swipe-412.png' },
  { name: 'm-term-swipe-360', page: 'm.html', width: 360, state: { signedIn: true, mtermview: true }, ready: '#app.m .m-term-switch', probe: MTERMVIEW_PROBES.swipe, shot: 'm-term-swipe-360.png' },
  { name: 'm-term-follow-360', page: 'm.html', width: 360, height: 420, state: { signedIn: true, mtermview: true }, ready: '#app.m .m-term-switch', probe: MTERMVIEW_PROBES.follow, shot: 'm-term-follow-360.png' },
  // 電腦版看別台終端：狀態列（視窗最下面）放「正在看…」或打字中的警示，黑色畫面和訊息框等寬、四周同樣間距；寬窗與窄窗各一
  { name: 'list-term-view', page: 'list.html', state: { signedIn: true, dterm: true }, ready: '#app.win .chatpane .actionbar', probe: DTERM_PROBES.watch, shot: 'list-term-view-1100.png' },
  { name: 'list-term-view-360', page: 'list.html', width: 360, state: { signedIn: true, dterm: true }, ready: '#app.win .chatpane .actionbar', probe: DTERM_PROBES.watch, shot: 'list-term-view-360.png' },
  // 切分頁再切回來：終端還在、有內容、不重新請求同意；離開超過 5 分鐘在到期當下結束（切回來看到「已結束＋重新看」）；打字中離開馬上結束打字
  { name: 'list-term-switchback', page: 'list.html', state: { signedIn: true, dterm: true, dtermTabs: true }, ready: '#app.win .chatpane .actionbar', probe: DTERM_TAB_PROBES.switchback, shot: 'list-term-switchback-1100.png' },
  { name: 'list-term-expired', page: 'list.html', state: { signedIn: true, dterm: true, dtermTabs: true }, ready: '#app.win .chatpane .actionbar', probe: DTERM_TAB_PROBES.expired, shot: 'list-term-expired-1100.png' },
  { name: 'list-term-typeaway', page: 'list.html', state: { signedIn: true, dterm: true, dtermTabs: true }, ready: '#app.win .chatpane .actionbar', probe: DTERM_TAB_PROBES.typeaway, shot: 'list-term-typeaway-1100.png' },
  // 本機終端：分頁隱藏時暫停讀取（隱藏期間後台不推畫面），切回來補一幅再恢復
  { name: 'list-term-local-pause', page: 'list.html', state: { signedIn: true, dtermLocal: true }, ready: '#app.win .chatpane .actionbar', probe: LTERM_PROBES.pause, shot: 'list-term-local-pause-1100.png' },
  { name: 'list-term-typing', page: 'list.html', state: { signedIn: true, dterm: true }, ready: '#app.win .chatpane .actionbar', probe: DTERM_PROBES.typing, shot: 'list-term-typing-1100.png' },
  { name: 'list-term-typing-360', page: 'list.html', width: 360, state: { signedIn: true, dterm: true }, ready: '#app.win .chatpane .actionbar', probe: DTERM_PROBES.typing, shot: 'list-term-typing-360.png' },
  { name: 'list-term-multi', page: 'list.html', state: { signedIn: true, dterm: true }, ready: '#app.win .chatpane .actionbar', probe: DTERM_PROBES.multi, shot: 'list-term-multi-1100.png' },
  { name: 'list-term-refused', page: 'list.html', state: { signedIn: true, dterm: true }, ready: '#app.win .chatpane .actionbar', probe: DTERM_PROBES.refused, shot: 'list-term-refused-1100.png' },
  { name: 'm-notice-dot', page: 'm.html', state: { signedIn: true, mnotice: 'dot' }, ready: '#app.m .m-tabs i.red', probe: MNOTICE_PROBES.dot, shot: 'm-notice-dot-412.png' },
  { name: 'm-notice-dot-360', page: 'm.html', width: 360, state: { signedIn: true, mnotice: 'dot' }, ready: '#app.m .m-tabs i.red', probe: MNOTICE_PROBES.dot, shot: 'm-notice-dot-360.png' },
  { name: 'm-notice-dot-big', page: 'm.html', width: 360, state: { signedIn: true, mnotice: 'dot' }, ready: '#app.m .m-tabs i.red', probe: MNOTICE_PROBES.dotBig, shot: 'm-notice-dot-big.png' },
  // 舊「○○收發室」列併進通知（#895 驗收）：夥伴頁／對話頁沒有收發室、通知分頁看得到每位寄件人的信；412、360 寬各一張。
  // lastchat 變體：存檔最後開著的對話是舊收發室列（升級前的狀態），對話頁不該還開著它
  { name: 'm-notice-legacy', page: 'm.html', state: { signedIn: true, mnoticeLegacy: 'list' }, ready: '#app.m .m-buddy', probe: MNOTICE_LEGACY_PROBES.list, shot: 'm-notice-legacy-412.png' },
  { name: 'm-notice-legacy-360', page: 'm.html', width: 360, state: { signedIn: true, mnoticeLegacy: 'list' }, ready: '#app.m .m-buddy', probe: MNOTICE_LEGACY_PROBES.list, shot: 'm-notice-legacy-360.png' },
  { name: 'm-notice-legacy-lastchat', page: 'm.html', state: { signedIn: true, mnoticeLegacy: 'lastchat' }, ready: '#app.m .m-buddy', probe: MNOTICE_LEGACY_PROBES.lastchat, shot: 'm-notice-legacy-lastchat-412.png' },
  // 電腦版「通知」大分頁（方案 A）：整合模式右邊顯示內容、分離模式開通知對話視窗、窄視窗（360）只顯示右邊並有「‹ 通知」返回鈕
  { name: 'list-notice-merged', page: 'list.html', width: 900, height: 640, state: { signedIn: true, dnotice: 'merged' }, ready: '#app.win .top-tabs .ttab-notice', probe: DNOTICE_PROBES.merged, shot: 'list-notice-merged.png' },
  { name: 'list-notice-split', page: 'list.html', width: 360, height: 660, state: { signedIn: true, dnotice: 'split' }, ready: '#app.win .top-tabs .ttab-notice', probe: DNOTICE_PROBES.split, shot: 'list-notice-split.png' },
  { name: 'list-notice-narrow', page: 'list.html', width: 360, height: 640, state: { signedIn: true, dnotice: 'narrow' }, ready: '#app.win .top-tabs .ttab-notice', probe: DNOTICE_PROBES.narrow, shot: 'list-notice-narrow-360.png' },
  { name: 'chat', page: 'chat.html?id=P%2Fdemo', state: { signedIn: true }, ready: '#app.win' },
  { name: 'onboard', page: 'onboard.html', state: { signedIn: true, onboard: true }, ready: '#app.win' },
  { name: 'login', page: 'login.html', state: { signedIn: false, needsLogin: true }, ready: '#app.win' },
  { name: 'panel', page: 'panel.html', state: { signedIn: true }, ready: '#app.win' },
  { name: 'askpass', page: 'askpass.html', state: { signedIn: true }, ready: '#app' },
  { name: 'toast', page: 'toast.html', state: { signedIn: true }, ready: '#app' },
  { name: 'setup-progress', page: 'setup-progress.html', state: { signedIn: true }, ready: '#app .sp' },
  // 對話框遮罩（#536）：打開對話框後，遮罩要蓋滿整個視窗，左上使用者區與名單也點不到
  { name: 'list-modern', page: 'list.html', width: 420, height: 720, state: { signedIn: true, skin: 'modern' }, ready: '#app.win .top-tabs .ttab', probe: SKIN_PROBE, shot: 'list-modern.png' },
  { name: 'list-modern-chat', page: 'list.html', width: 900, height: 640, state: { signedIn: true, partnerTab: true, skin: 'modern' }, ready: '#app.win .actionbar', probe: SKIN_PROBE, shot: 'list-modern-chat.png' },
  { name: 'm-modern', page: 'm.html', state: { signedIn: true, mbar: 'claude', skin: 'modern' }, ready: '#app.m .m-chat .chatpane', probe: SKIN_PROBE, shot: 'm-modern-chat.png' },
  { name: 'm-modern-list', page: 'm.html', state: { signedIn: true, mbar: 'claude', mchatList: true, skin: 'modern' }, ready: '#app.m .m-chat-list', probe: SKIN_PROBE, shot: 'm-modern-list.png' },
  // #1421 A：有訊息的對話（卡片圓角、頭像）、離線／忙碌的標題列與收件人列（權重衝突修正）
  { name: 'list-modern-msgs', page: 'list.html', width: 900, height: 640, state: { signedIn: true, bar: 'offline', chatMsgs: true, skin: 'modern' }, ready: '#app.win .actionbar', probe: SKIN_PROBE, shot: 'list-modern-msgs.png' },
  { name: 'm-modern-msgs', page: 'm.html', state: { signedIn: true, mbar: 'offline', chatMsgs: true, skin: 'modern' }, ready: '#app.m .m-chat .chatpane', probe: SKIN_PROBE, shot: 'm-modern-msgs.png' },
  { name: 'm-modern-busy', page: 'm.html', state: { signedIn: true, mbar: 'busy', skin: 'modern' }, ready: '#app.m .m-chat .chatpane', probe: SKIN_PROBE, shot: 'm-modern-busy.png' },
  { name: 'list-tabs', page: 'list.html', width: 420, height: 720, state: { signedIn: true }, ready: '#app.win .top-tabs .ttab', probe: DTABS_PROBE, shot: 'list-tabs.png' },
  { name: 'list-dialog-mask', page: 'list.html', state: { signedIn: true, partnerTab: true }, ready: '#app.win .actionbar .abtn[aria-label="管理"]', probe: MASK_PROBES.desktop },
  { name: 'm-dialog-mask', page: 'm.html', state: { signedIn: true, mtab: 'list' }, ready: '#app.m .m-pager .m-search', probe: MASK_PROBES.mobile },
  // 固定 6 顆大按鈕（#539）：閒置 Claude、離線 Claude、ACP 工作者，各自依序都在、反灰正確、反灰有 20 字內的原因
  { name: 'list-bar-fixed', page: 'list.html', state: { signedIn: true, bar: 'claude' }, ready: '#app.win .actionbar .abtn[aria-label="管理"]', probe: BAR_PROBES.claude },
  { name: 'list-bar-fixed-offline', page: 'list.html', state: { signedIn: true, bar: 'offline' }, ready: '#app.win .actionbar .abtn[aria-label="管理"]', probe: BAR_PROBES.offline },
  { name: 'list-bar-fixed-acp', page: 'list.html', state: { signedIn: true, bar: 'acp' }, ready: '#app.win .actionbar .abtn[aria-label="管理"]', probe: BAR_PROBES.acp },
  // 工作項目（#539 之三）：本機 Claude 有 3 件背景工作，按鈕可按、數字顯示、列表打得開；上面三個情境是 0 件反灰、沒有徽章
  { name: 'list-bar-tasks', page: 'list.html', state: { signedIn: true, bar: 'tasks' }, ready: '#app.win .actionbar .abtn[aria-label="管理"]', probe: BAR_PROBES.tasks },
  // 群組按鈕（#539 之二）：整合模式開著群組分頁，按鈕列有「群組」（四項），「管理」不再放這些
  // 手機對話頁（不放按鈕列）：412 寬，Claude 視窗、ACP 工作者、離線 Claude；上方沒有按鈕列、「⋯」不列永遠用不到的項目（在線：切換模型、詳情在前；離線：喚醒、切換模型在前；內建通道才有重開、移除）、標頭留著背景工作件數
  { name: 'm-tabs', page: 'm.html', state: { signedIn: true, mbar: 'claude', mchatList: true }, ready: '#app.m .m-chat-list', probe: MTABS_PROBE, shot: 'm-tabs.png' },
  { name: 'm-chat-plain', page: 'm.html', state: { signedIn: true, mbar: 'claude' }, ready: '#app.m .m-chat .chatpane', probe: MCHAT_PROBES.plain, shot: 'm-chat.png' },
  { name: 'm-chat-claude', page: 'm.html', state: { signedIn: true, mbar: 'claude' }, ready: '#app.m .m-chat .chatpane', probe: MCHAT_PROBES.claude, shot: 'm-chat-ops.png' },
  { name: 'm-chat-acp', page: 'm.html', state: { signedIn: true, mbar: 'acp' }, ready: '#app.m .m-chat .chatpane', probe: MCHAT_PROBES.acp },
  { name: 'm-chat-offline-menu', page: 'm.html', state: { signedIn: true, mbar: 'offline' }, ready: '#app.m .m-chat .chatpane', probe: MCHAT_PROBES.offlineMenu, shot: 'm-chat-ops-offline.png' },
  { name: 'm-chat-offline', page: 'm.html', state: { signedIn: true, mbar: 'offline' }, ready: '#app.m .m-chat .chatpane', probe: MCHAT_PROBES.offline },
  // 手機群組對話：「⋯」裡是群組的三項（沒有「輸入邀請碼加入」）
  { name: 'm-group-chat', page: 'm.html', state: { signedIn: true, mgroup: true }, ready: '#app.m .m-chat .chatpane', probe: { mgroup: GROUP_ITEMS } },
  // 手機群組附件（0.1.111）：沒有外部成員、有外部成員的群組都看得到「傳照片」「傳送檔案」且送得出去
  { name: 'm-group-attach', page: 'm.html', state: { signedIn: true, mgroup: true }, ready: '#app.m .m-chat .chatpane', probe: { mattach: { labels: ['傳照片', '傳送檔案'] } } },
  { name: 'm-group-attach-external', page: 'm.html', state: { signedIn: true, mgroup: true, external: true }, ready: '#app.m .m-chat .chatpane', probe: { mattach: { labels: ['傳照片', '傳送檔案'] } } },
  { name: 'list-group-tab', page: 'list.html', state: { signedIn: true, groupTab: true }, ready: '#app.win .actionbar', probe: { group: GROUP_ITEMS } },
  { name: 'list-aero-chat', page: 'list.html', width: 900, height: 640, state: { signedIn: true, partnerTab: true }, ready: '#app.win .actionbar', shot: 'list-aero-chat.png' },
  { name: 'list-modern-term', page: 'list.html', width: 900, height: 640, state: { signedIn: true, dterm: true, skin: 'modern' }, ready: '#app.win .chatpane .actionbar', probe: DTERM_PROBES.watch, shot: 'list-modern-term.png' },
]
// 刻意不測的 ui/*.html（要寫理由）；其餘 html 都必須有情境（見單元測試）
export const EXCLUDED_PAGES = {
  'shot.html': '截圖框選覆蓋層：由 Rust 端帶截圖資料開啟，沒有獨立的啟動流程，另有 shot 測試',
}

// 這個情境的完整假回應表（引導情境不預設「已引導」，讓引導畫面出現）
// 帳號列表（#374）情境：整合模式、上次開著「設定：帳號」，開機就會讀 acct_roster
export const ROSTER_ME = { winMode: 'merged', session: { v: 1, tabs: [{ id: '@setting' }], active: { id: '@setting' }, panel: { guide: '', setting: 'accounts' }, windows: [], panelWindows: [] } }
export const ROSTER_SAMPLE = {
  now: '2026-10-29T00:00:00Z',
  accounts: [
    { vendor: 'claude', account: 'me@example.com', plan: 'max', windows: [{ name: 'five_hour', left_pct: 40, resets_at: null, read_at: '2026-10-28T21:00:00Z', read_node: 'P' }, { name: 'weekly', left_pct: 72, resets_at: null, read_at: '2026-10-28T21:00:00Z', read_node: 'P' }], seen_at: '2026-10-28T21:00:00Z', seen_node: 'P', nodes: [{ node: 'P', current: true, reported_at: '2026-10-28T21:00:00Z' }] },
    { vendor: 'codex', account: 'me@example.com', plan: 'plus', windows: [], seen_at: '2026-10-28T21:00:00Z', seen_node: 'P', nodes: [] },
  ],
}
const GEMINI_ROW = { vendor: 'gemini', account: 'me@example.com', plan: 'Google AI Pro', windows: [{ name: 'five_hour', left_pct: 55, resets_at: null, read_at: '2026-10-28T22:00:00Z', read_node: 'P' }, { name: 'weekly', left_pct: 81, resets_at: null, read_at: '2026-10-28T22:00:00Z', read_node: 'P' }], seen_at: '2026-10-28T22:00:00Z', seen_node: 'P', nodes: [] }
export const ROSTER_GEMINI = { ...ROSTER_SAMPLE, accounts: [...ROSTER_SAMPLE.accounts, GEMINI_ROW] }
export const ROSTER_GEMINI_EMPTY = { ...ROSTER_SAMPLE, accounts: [...ROSTER_SAMPLE.accounts, { ...GEMINI_ROW, windows: [] }] }
const ROSTERS = { gemini: ROSTER_GEMINI, geminiEmpty: ROSTER_GEMINI_EMPTY, resets: resetRoster(), resetPassed: resetRoster(SMOKE_NOW, { passed: true }) }
/** 截圖存哪：環境變數 ASN_SMOKE_SHOTS 指定的資料夾，沒指定就放暫存資料夾（不放 repo 裡） */
export const shotPath = (name, env = process.env) => path.join(env.ASN_SMOKE_SHOTS || path.join(os.tmpdir(), 'asn-smoke-shots'), name)
export const MROSTER_ME = { navTab: 'me' }
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
  if (scenario.state.mbar) {
    t.relay_list = { members: MBAR_MEMBERS[scenario.state.mbar] }
    t.store_load = { ...t.store_load, values: { ...t.store_load.values, me: JSON.stringify(MBAR_ME) } }
    t.android_launchers = { machines: [{ node: 'Q', online: true, launcher: { profiles: [] } }] }   // 那台開放遠端管理：切換模型、管理可按
  }
  if (scenario.state.mgroup) {
    t.relay_rooms = { rooms: [scenario.state.external ? { ...GROUP_ROOM, external: true } : GROUP_ROOM] }
    t.relay_send_attachment = { seq: 1 }
    t.android_room_read = { messages: [] }
    t.relay_group = { by: 'action', values: { group_confirm_list: { confirms: [] } }, fallback: null }
    t.store_load = { ...t.store_load, values: { ...t.store_load.values, me: JSON.stringify(MGROUP_ME) } }
  }
  if (scenario.state.groupTab) {
    t.relay_rooms = { rooms: [GROUP_ROOM] }
    t.relay_room_read = { messages: [] }
    t.relay_group = { by: 'action', values: { group_confirm_list: { confirms: [] } }, fallback: null }
    t.store_load = { ...t.store_load, values: { ...t.store_load.values, me: JSON.stringify(GROUP_ME) } }
  }
  if (scenario.state.chatMsgs) t.relay_chat_history = { messages: CHAT_MSGS_SAMPLE }   // 對話裡放幾則來回的信（看訊息卡片）
  if (scenario.state.mchatList) t.store_load = { ...t.store_load, values: { ...t.store_load.values, me: JSON.stringify({ ...MBAR_ME, navChat: false }) } }   // 上次停在對話清單（不是某一則）
  // 手機開 App 先看「對話」清單（0.2.18）：要從夥伴頁開始的情境（例如點右上角「＋」）用 mtab 指定存檔停在哪一頁
  if (scenario.state.mtab) t.store_load = { ...t.store_load, values: { ...t.store_load.values, me: JSON.stringify({ navTab: scenario.state.mtab }) } }
  if (scenario.state.roster) t.acct_roster = ROSTERS[scenario.state.roster] ?? ROSTER_SAMPLE   // 沒放＝後台沒部署（指令被拒），畫面要退回舊的顯示、不出錯
  if (scenario.state.macct) {
    t.relay_list = { members: MACCT_MEMBERS[scenario.state.macct] }
    t.store_load = { ...t.store_load, values: { ...t.store_load.values, me: JSON.stringify(MACCT_ME) } }
    t.android_launchers = { machines: [] }
    t.android_acct_roster = ROSTER_SAMPLE
  }
  if (scenario.state.mlayout) {
    t.relay_list = { members: MACCT_MEMBERS.two }
    t.store_load = { ...t.store_load, values: { ...t.store_load.values, me: JSON.stringify(MROSTER_ME) } }
    t.android_launchers = { machines: [] }
    t.android_acct_roster = layoutRoster()
    t.android_acct_list = layoutAcctList()
  }
  if (scenario.state.mlaunch) {
    t.relay_list = { members: MACCT_MEMBERS.one }
    t.store_load = { ...t.store_load, values: { ...t.store_load.values, me: JSON.stringify(MACCT_ME) } }
    t.android_launchers = { machines: [{ node: 'Q', online: true, launcher: MLAUNCH_LAUNCHER }] }
  }
  if (scenario.state.mnotice) {
    t.relay_list = { members: MACCT_MEMBERS.two }
    t.relay_inbox = { messages: noticeMails() }
    t.relay_ack = null
    t.relay_read_sync = { marks: [] }
    t.store_load = { ...t.store_load, values: { ...t.store_load.values, me: JSON.stringify(MNOTICE_ME[scenario.state.mnotice]) } }
  }
  if (scenario.state.dnotice) {
    t.relay_inbox = { messages: dnoticeMails() }
    t.relay_ack = null
    t.relay_read_sync = { marks: [] }
    t.open_chat = null
    t.show_toast = null   // 新通知會跳右下角提示
    t.store_load = { ...t.store_load, values: { ...t.store_load.values, me: JSON.stringify(DNOTICE_ME[scenario.state.dnotice]) } }
  }
  if (scenario.state.mnoticeLegacy) {
    t.relay_list = { members: legacyMembers() }
    t.relay_inbox = { messages: legacyMails() }
    t.relay_ack = null
    t.relay_read_sync = { marks: [] }
    t.store_load = { ...t.store_load, values: { ...t.store_load.values, chats: JSON.stringify(legacyChats()), me: JSON.stringify(legacyMe(scenario.state.mnoticeLegacy)) } }
  }
  if (scenario.state.mtermview) {
    t.relay_list = { members: MBAR_MEMBERS.claude }
    t.store_load = { ...t.store_load, values: { ...t.store_load.values, me: JSON.stringify(MBAR_ME) } }
    t.android_launchers = { machines: [{ node: 'Q', online: true, launcher: { profiles: [] } }] }
    t.term_view_remote_available = true
    t.term_view_remote_start = { id: 'v1', expires_s: Math.floor(Date.now() / 1000) + 600 }
    t.__confirmViewer = scenario.state.mtermview === true || scenario.state.mtermview === 'late' ? 'ok' : scenario.state.mtermview
    if (scenario.state.mtermview === 'late') t.__confirmDelay = 1500
    t.term_view_remote_set = null
    t.term_view_remote_stop = null
    t.__emitOn = { term_view_remote_start: mtermviewFrames('v1') }
  }
  if (scenario.state.dtermLocal) {
    // 電腦版本機終端：夥伴在這台、在共用終端服務裡；假後台依 paused 停推畫面（見 injectSource 的 __tvLive）
    t.relay_list = { members: LTERM_MEMBERS }
    t.store_load = { ...t.store_load, values: { ...t.store_load.values, me: JSON.stringify(LTERM_ME) } }
    t.term_view_available = true
    t.term_view_open = 7
    t.term_view_close = null
    t.term_view_set = null
    t.term_view_input = null
    t.term_view_history = null
    t.__tvLive = { text: MTERMVIEW_TEXT }
  }
  if (scenario.state.dterm) {
    // 電腦版：開著別台（Q）上夥伴的對話，按鈕列「終端」＝看那台的畫面；那台在本人帳號底下（update_remote_status 有它）
    t.relay_list = { members: scenario.state.dtermTabs ? DTERM_MEMBERS2 : DTERM_MEMBERS }
    t.store_load = { ...t.store_load, values: { ...t.store_load.values, me: JSON.stringify(scenario.state.dtermTabs ? DTERM_ME2 : DTERM_ME) } }
    t.update_remote_status = { nodes: [{ id: DTERM_NODE, update: null }] }
    t.term_view_remote_available = true
    t.term_view_remote_start = { id: 'v1', expires_s: Math.floor(Date.now() / 1000) + 600 }
    t.term_view_remote_set = null
    t.term_view_remote_stop = null
    t.term_view_remote_input = null
    t.stt_status = { ready: true }   // 語音引擎已就緒：按麥克風會留下語音提示（驗證打字中的警示不被蓋掉）
    t.__emitOn = { term_view_remote_start: mtermviewFrames('v1') }
  }
  if (scenario.state.mpermreq) {
    t.relay_list = { members: MBAR_MEMBERS.claude }
    t.store_load = { ...t.store_load, values: { ...t.store_load.values, me: JSON.stringify(MBAR_ME) } }
    t.android_perm_req_list = { requests: mpermreqRows(), recent: [] }
  }
  if (scenario.state.mnoself) {
    t.relay_list = { members: MACCT_MEMBERS.two }
    t.store_load = { ...t.store_load, values: { ...t.store_load.values, me: JSON.stringify(MROSTER_ME) } }
    // noplat：後台的設備清單沒有這支手機（平台還沒回報）；android：有，平台是 android
    t.android_launchers = { machines: scenario.state.mnoself === 'android' ? [{ node: 'P', platform: 'android', launcher: null }] : [] }
    t.android_acct_roster = noselfRoster()
    t.android_acct_list = layoutAcctList()
  }
  if (scenario.state.mcloud) {
    t.relay_list = { members: MCLOUD_MEMBERS }
    t.store_load = { ...t.store_load, values: { ...t.store_load.values, me: JSON.stringify(MROSTER_ME) } }
    t.android_launchers = { machines: scenario.state.mcloud === 'android' ? [{ node: 'P', platform: 'android', launcher: null }] : [] }
    t.android_acct_roster = ROSTER_SAMPLE
    t.android_acct_list = mcloudAcctList()
  }
  if (scenario.state.mroster) { t.android_acct_roster = scenario.state.mroster === 'cards' ? cardsRoster() : ROSTER_GEMINI; t.store_load = { ...t.store_load, values: { ...t.store_load.values, me: JSON.stringify(MROSTER_ME) } } }
  // 外觀「現代」（0.2.18）：存檔裡的外觀（電腦 me.skin、手機 me.mobilePrefs.skin）設成 skin，其他存檔照各情境
  if (scenario.state.skin) {
    const me = JSON.parse(t.store_load?.values?.me ?? '{}')
    t.store_load = { ...t.store_load, values: { ...t.store_load.values, me: JSON.stringify({ ...me, skin: scenario.state.skin, mobilePrefs: { ...(me.mobilePrefs ?? {}), skin: scenario.state.skin } }) } }
  }
  return t
}

// 注入頁面的腳本（在任何頁面程式之前執行）：假 Tauri
export const injectSource = table => `(() => {
  const T = ${JSON.stringify(table)};
  const missing = (globalThis.__smokeMissing = []);
  // 手機看終端的本人確認（PR③ 的外殼）：表裡的 __confirmViewer＝'ok'／'cancel'／'no_lock'；每次確認都記在 __smokeConfirms
  if (T.__confirmViewer) globalThis.AsnAndroid = { confirmViewer(id) { (globalThis.__smokeConfirms ||= []).push(id); setTimeout(() => globalThis.__asnConfirmViewer && globalThis.__asnConfirmViewer(id, T.__confirmViewer), T.__confirmDelay || 30) } };
  const tv = T.__tvLive ? (globalThis.__smokeTv = { paused: false, timer: 0, seq: 0, sent: 0, id: 7 }) : null;
  const tvSend = () => {
    tv.seq++; tv.sent++;
    const payload = { view_id: tv.id, seq: tv.seq, text: T.__tvLive.text + String.fromCharCode(13, 10) + '  更新 ' + tv.seq, meta: { cursor_x: 2, cursor_y: 3, cols: 120, rows: 40 } };
    for (const fn of ((globalThis.__smokeListeners || {})['term-view-frame'] || [])) fn({ event: 'term-view-frame', payload });
  };
  globalThis.__TAURI__ = {
    // 事件：listen 記下回呼；表裡的 __emitOn[指令] 在那個指令被呼叫後依序推事件（例如看別台終端的假畫面幀）。回呼收到的是 { payload }，和真的 Tauri 一樣
    event: {
      listen: async (evt, fn) => { const ls = (globalThis.__smokeListeners ||= {}); (ls[evt] ||= []).push(fn); return () => { ls[evt] = (ls[evt] || []).filter(f => f !== fn) } },
      emit: async () => {},
    },
    window: { getCurrentWindow: () => ({ startResizeDragging() {}, label: 'smoke' }) },
    core: { invoke: async (cmd, args) => {
      if (!Object.prototype.hasOwnProperty.call(T, cmd)) { missing.push(cmd); throw 'command ' + cmd + ' not found' }
      (globalThis.__smokeCalls ||= []).push([cmd, args]);
      // 本機終端的假後台（__tvLive）：開了就每 100 毫秒推一幅，paused 時不推、恢復時補推一幅；__smokeTv.sent＝一共推了幾幅
      if (tv) {
        if (cmd === 'term_view_open') { clearInterval(tv.timer); tv.timer = setInterval(() => { if (!tv.paused) tvSend() }, 100); setTimeout(tvSend, 50); return tv.id }
        if (cmd === 'term_view_close') { clearInterval(tv.timer); return null }
        if (cmd === 'term_view_set') { const was = tv.paused; tv.paused = !!(args && args.paused); if (was && !tv.paused) tvSend(); return null }
      }
      const ev = T.__emitOn && T.__emitOn[cmd];
      if (Array.isArray(ev)) ev.forEach((e, i) => setTimeout(() => { for (const fn of ((globalThis.__smokeListeners || {})[e.event] || [])) fn({ event: e.event, payload: JSON.parse(JSON.stringify(e.payload)) }) }, 50 * (i + 1)));
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

// 啟動冒煙測試的純邏輯：參數、入口頁清單、假 Tauri 回應表、瀏覽器尋找、掛上判斷。
// smoke-ui.mjs 負責真的起伺服器與無頭瀏覽器；這裡不碰程序與網路，方便單元測試。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { resetWhen } from '../ui/lib/account-quota.mjs'
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
export const MBAR_MEMBERS = {
  claude: [{ id: 'Q', name: '辦公室', agents: [{ name: 'demo', status: 'idle', cwd_label: 'demo', detail: '背景工作 3 件' }] }],
  offline: [{ id: 'Q', name: '辦公室', agents: [{ name: 'demo', status: 'idle', online: false, cwd_label: 'demo' }] }],
  acp: [{ id: 'Q', name: '辦公室', agents: [{ name: 'demo', status: 'idle', engine: 'gemini', cwd_label: 'demo' }] }],
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
// 額度畫面（#374 之三）：「我的帳號」區每個廠牌（data-vendor）的文字要依序含 want 列的每一段；先等 open 指定的入口（手機要從設置點進「帳號」）
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
// 手機「設備與帳號」返回（修返回鍵退不回設備列表）：從夥伴列表某台設備旁「選項」進來（直接開那台細部）或從設置進來（先看列表），
// 按系統返回鍵一層一層退：細部 → 設備列表 → 收起整頁；兩種進法、一台或多台設備都要。列表＝有 .m-dv-list，細部＝第四頁籤開著但沒有列表
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
    const rows = [...document.querySelectorAll('.m-dv-go')];
    rows[rows.length - 1].click();
    bad = check('點另一台', await waitView('detail'), 'detail'); if (bad) return bad;
    bad = check('再返回', await press('list'), 'list'); if (bad) return bad;
  }
  bad = check('返回收起', await press('closed'), 'closed'); if (bad) return bad;
  // 二、從設置進來：先看列表，點一台，返回
  const go = [...document.querySelectorAll('.m-tab, [role=tab], button')].find(b => b.textContent.trim() === '設置' || b.getAttribute('aria-label') === '設置');
  if (go) { go.click(); await sleep(300) }
  let btn = null;
  for (let i = 0; i < 30 && !btn; i++) { btn = [...document.querySelectorAll('.m-row-btn')].find(b => b.textContent.includes('設備')) || null; if (!btn) await sleep(100) }
  if (!btn) return { ok: false, why: '找不到設置裡的「設備」（' + steps.join('；') + '）' };
  btn.click();
  bad = check('設置進來', await waitView('list'), 'list'); if (bad) return bad;
  document.querySelector('.m-dv-go').click();
  bad = check('設置點一台', await waitView('detail'), 'detail'); if (bad) return bad;
  bad = check('設置返回一次', await press('list'), 'list'); if (bad) return bad;
  bad = check('設置返回收起', await press('closed'), 'closed'); if (bad) return bad;
  return { ok: true, why: steps.join('；') };
})()`
const MACCT_ME = { navTab: 'list' }
const MACCT_MEMBERS = {
  one: [{ id: 'Q', name: '辦公室', agents: [{ name: 'demo', status: 'idle', cwd_label: 'demo' }] }],
  two: [{ id: 'Q', name: '辦公室', agents: [{ name: 'demo', status: 'idle', cwd_label: 'demo' }] }, { id: 'R', name: '工作機', agents: [{ name: 'demo', status: 'idle', cwd_label: 'demo' }] }],
}
// 手機設置頁排版（#930）：設置 → 設備／帳號，412、360 寬與大字型（字放大 1.3 倍，模擬手機系統的大字型）各一張。
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
  if (!btn) return { ok: false, why: '找不到設置裡的「設備」' };
  btn.click();
  // 帳號頁的「切換到…」要先讀過各台的帳號回報（點進那台細部才讀）：逐台點進去再返回
  if (tab === 'accounts') {
    await sleep(500);
    const n = document.querySelectorAll('.m-dv-row .m-dv-grip').length;
    for (let i = 0; i < n; i++) {
      const go = [...document.querySelectorAll('.m-dv-row')].filter(r => r.querySelector('.m-dv-grip'))[i]?.querySelector('.m-dv-go');
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
// #930 帳號永遠不能切到這支手機自己：noplat＝這支手機的平台還沒讀到（設備樹會先把它當成電腦）；android＝讀到了
export const MNOSELF_PROBES = { noplat: { mnoself: 'noplat' }, android: { mnoself: 'android' } }
export const mnoselfProbeSource = () => `(async () => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const vis = e => e && e.offsetParent !== null;
  let btn = null;
  for (let i = 0; i < 60 && !btn; i++) { btn = [...document.querySelectorAll('.m-row-btn')].find(b => b.textContent.includes('設備')) || null; if (!btn) await sleep(100) }
  if (!btn) return { ok: false, why: '找不到設置裡的「設備」' };
  btn.click(); await sleep(500);
  const rows = () => [...document.querySelectorAll('.m-dv-row')].filter(vis);
  const n = rows().length;
  if (n < 3) return { ok: false, why: '設備列少於 3 列：' + n };
  let sawSelf = false;
  for (let i = 0; i < n; i++) {
    const row = rows()[i];
    const name = row?.querySelector('b')?.textContent ?? '';
    const go = row?.querySelector('.m-dv-go');
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
export const MPANE_CHAT_MIN = 180
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
    const gear = [...list.querySelectorAll('.rtab')].find(e => e.getAttribute('aria-label') === '設定');
    if (!gear) return { ok: false, why: '名單找不到設定分頁' };
    gear.click(); await sleep(300);
    const acct = [...list.querySelectorAll('.cat-list .buddy')].find(e => e.textContent.includes('帳號'));
    if (!acct) return { ok: false, why: '設定清單找不到帳號' };
    acct.click(); await sleep(500);
    if (!shown(chat) || shown(list) || !shown(chat.querySelector('.dv-acct'))) return { ok: false, why: '從名單開帳號後應只顯示右窗格與帳號卡' };
  }
  return { ok: true, why: '' };
})()`
export const probeKind = probe => (probe.mpane ? '整合模式窄視窗檢查' : probe.devbtn ? '帳號設備按鈕檢查' : probe.mtermview ? '手機看終端檢查' : probe.mlaunch ? '手機開新夥伴檢查' : probe.mnoticeLegacy ? '手機舊收發室列併進通知檢查' : probe.mnotice ? '手機通知分頁檢查' : probe.mnoself ? '手機不能切到本機檢查' : probe.mcloud ? '手機設備列雲端標示檢查' : probe.mlayout ? '手機設置頁排版檢查' : probe.macctBack ? '手機設備與帳號返回檢查' : probe.mcards ? '手機帳號卡檢查' : probe.mattach ? '手機群組附件檢查' : probe.quota ? '額度畫面檢查' : probe.mgroup ? '手機群組按鈕檢查' : probe.mchat ? '手機對話頁檢查' : probe.bar ? '大按鈕檢查' : probe.group ? '群組按鈕檢查' : '遮罩檢查')
export const probeSource = probe => (probe.mpane ? mpaneProbeSource(probe) : probe.devbtn ? devbtnProbeSource(probe) : probe.mtermview ? mtermviewProbeSource(probe) : probe.mlaunch ? mlaunchProbeSource(probe) : probe.mnoticeLegacy ? mnoticeLegacyProbeSource(probe) : probe.mnotice ? mnoticeProbeSource(probe) : probe.mnoself ? mnoselfProbeSource(probe) : probe.mcloud ? mcloudProbeSource(probe) : probe.mlayout ? mlayoutProbeSource(probe) : probe.macctBack ? macctBackProbeSource(probe) : probe.mcards ? mcardsProbeSource(probe) : probe.mattach ? mattachProbeSource(probe) : probe.quota ? quotaProbeSource(probe) : probe.mgroup ? mgroupProbeSource(probe) : probe.mchat ? mchatProbeSource(probe) : probe.bar ? barProbeSource(probe) : probe.group ? groupProbeSource(probe) : maskProbeSource(probe))

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
  passed: { quota: '.dv-my', want: { claude: ['Claude', '5 小時', '可能已恢復', '每週', '剩 72%'] }, absent: { claude: ['剩 40%'] } },
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
// #930 手機設置頁排版：這支手機＋兩台電腦（工作機的回報是舊的，第三行會是「還沒收到這台的回報」）；
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
  if (!btn) return { ok: false, why: '找不到設置裡的「設備」' };
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
// 手機第四格「通知」（#895，PR-H）：四個頁籤固定；通知分頁顯示系統通知對話（唯讀）、紅點在第四格。
// view: 'tab'＝存檔停在第四格，看到通知內容（不會有紅點，因為正在看）；'dot'＝存檔停在設置，第四格亮紅點。412、360 寬與大字型（1.3 倍）各一張
const MNOTICE_ME = { tab: { navTab: 'page' }, dot: { navTab: 'me' } }
const noticeMails = (now = Date.now()) => [
  { id: '00000000-0000-4000-8000-0000000000a1', from_node: 'Q', from_agent: '額度通知收發室', kind: 'notice:quota', body: '辦公室：Claude 額度剩 18%，約 2 小時後重置。', trust: 'member', to_agent: '測試機', created_at: new Date(now - 9 * 60_000).toISOString() },
  { id: '00000000-0000-4000-8000-0000000000a2', from_node: 'R', from_agent: 'ASN 通知', kind: 'notice:waiting', body: '工作機：夥伴 demo 正在等你確認。', trust: 'member', to_agent: '測試機', created_at: new Date(now - 5 * 60_000).toISOString() },
  { id: '00000000-0000-4000-8000-0000000000a3', from_node: 'Q', from_agent: 'ASN 通知', kind: 'notice:device_key', body: '辦公室：這台的設備金鑰剛換過。', trust: 'member', to_agent: '測試機', created_at: new Date(now - 60_000).toISOString() },
]
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
  if (labels.join('|') !== '夥伴|對話|設置|通知') return { ok: false, why: '四個頁籤的字不對：' + labels.join('、') };
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
  const dot = tabs[3].querySelector('i.red');
  if (view === 'dot') {
    if (!dot || !vis(dot)) return { ok: false, why: '通知有未讀，第四格卻沒有紅點' };
    if (tabs[1].querySelector('i.red')) return { ok: false, why: '對話分頁不該因為通知未讀而亮紅點' };
    const d = dot.getBoundingClientRect(), b = tabs[3].getBoundingClientRect();
    if (d.right > b.right + 0.5 || d.left < b.left - 0.5) return { ok: false, why: '紅點跑出第四格' };
    return { ok: true, why: '' };
  }
  if (dot) return { ok: false, why: '正在看通知，紅點應該清掉' };
  if (!tabs[3].classList.contains('on')) return { ok: false, why: '存檔停在第四格，第四格卻沒選中' };
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
// 手機舊「○○收發室」聯絡人列不再出現在夥伴頁／對話頁、改集中在第四格「通知」（#895 驗收，重現 11-06 截圖）：
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
  const pg = label => document.querySelector('section.m-pg[aria-label="' + label + '"]');
  const nicks = () => [...pg('夥伴').querySelectorAll('.m-buddy .b-nick')].map(e => e.textContent.trim());
  for (let i = 0; i < 80 && !(nicks().includes('小工') && nicks().includes('alpha')); i++) await sleep(100);
  for (let i = 0; i < 80 && document.querySelector('.m-banner'); i++) await sleep(100);   // 新通知的橫幅幾秒後自己消失
  await sleep(600);
  // 1) 夥伴頁（第一格）：正常夥伴在、沒有任何舊系統寄件人列
  const names = nicks();
  for (const n of ['demo', '小工', 'alpha']) if (!names.includes(n)) return { ok: false, why: '夥伴頁少了正常夥伴「' + n + '」：' + names.join('、') };
  const bad = names.filter(legacyName);
  if (bad.length) return { ok: false, why: '夥伴頁還列著系統寄件人：' + [...new Set(bad)].join('、') };
  const listText = pg('夥伴').textContent;
  for (const s of SENDERS) if (listText.includes(s)) return { ok: false, why: '夥伴頁的文字裡還出現「' + s + '」' };
  if (!names.includes('通知')) return { ok: false, why: '夥伴頁最上面該有單一「通知」對話列：' + names.join('、') };
  // 2) 對話頁（第二格）：沒有舊收發室的對話（列、標題、內容都不能有）
  tabs[1].click();
  await sleep(700);
  const chat = pg('對話');
  if (chat.querySelectorAll('.m-buddy').length) return { ok: false, why: '對話頁出現對話列' };
  const title = chat.querySelector('.m-head .m-title')?.textContent.trim() || '';
  if (legacyName(title)) return { ok: false, why: '對話頁開著舊系統寄件人的對話：「' + title + '」' };
  for (const s of SENDERS) if (chat.textContent.includes(s)) return { ok: false, why: '對話頁的文字裡還出現「' + s + '」' };
  for (const w of MARKS) if (chat.textContent.includes(w)) return { ok: false, why: '對話頁顯示了通知內容「' + w + '」（通知只該在第四格）' };
  // 3) 第四格「通知」：每位系統寄件人的信都看得到，唯讀，版面不超出畫面寬度
  tabs[3].click();
  await sleep(900);
  if (!tabs[3].classList.contains('on')) return { ok: false, why: '點第四格後沒有選中通知' };
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
export const MTERMVIEW_PROBES = {
  base: { mtermview: true, big: false },
  big: { mtermview: true, big: true },
  cancel: { mtermview: true, gate: 'cancel' },
  noLock: { mtermview: true, gate: 'no_lock' },
  late: { mtermview: true, gate: 'late' },
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
export const mtermviewFrames = (id = 'v1') => [1, 2, 3, 4].map(n => ({ event: 'term-view-remote-frame', payload: { id, text: MTERMVIEW_TEXT + '\r\n  更新 ' + n, meta: { cursor_x: 2, cursor_y: 3 + n, cols: 120, rows: 40 } } }))
export const mtermviewProbeSource = ({ big, gate }) => gate ? mtermviewGateProbeSource(gate) : `(async () => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const vis = e => e && e.offsetParent !== null;
  let sw = null;
  for (let i = 0; i < 80 && !sw; i++) { sw = document.querySelector('.m-term-switch'); if (!sw) await sleep(100) }
  if (!sw) return { ok: false, why: '對話頁沒有「訊息／終端」切換' };
  if (${big ? 'true' : 'false'}) {
    const els = [...document.querySelectorAll('#app *')];
    const sizes = els.map(e => parseFloat(getComputedStyle(e).fontSize) || 0);
    els.forEach((e, i) => { if (sizes[i]) e.style.fontSize = (sizes[i] * 1.3) + 'px' });
    await sleep(300);
  }
  const btns = [...sw.querySelectorAll('button')];
  const labels = btns.map(b => b.getAttribute('aria-label'));
  if (labels.join('|') !== '訊息|終端') return { ok: false, why: '切換圖示的名稱不對：' + labels.join('、') };
  if (!sw.closest('.compose-row .toolbar')) return { ok: false, why: '切換圖示應該在下方圖示列' };
  // 兩個圖示都要整顆在畫面內、夠大好按（電腦版的 44px 觸控下限）
  const inView = () => btns.every(b => { const r = b.getBoundingClientRect(); return r.width >= 43.5 && r.height >= 43.5 && r.left >= -0.5 && r.right <= window.innerWidth + 0.5 && r.top >= -0.5 && r.bottom <= window.innerHeight + 0.5 });
  if (!inView()) return { ok: false, why: '切換圖示跑出畫面或太小' };
  const conv = () => document.querySelector('.m-chat .conv');
  if (!vis(conv())) return { ok: false, why: '一開始應該先顯示訊息列表' };
  btns[1].click();
  let bar = null;
  for (let i = 0; i < 80 && !(bar && bar.textContent.includes('正在看')); i++) { await sleep(100); bar = document.querySelector('.term-remote-bar') }
  if (!bar || !bar.textContent.includes('正在看')) return { ok: false, why: '點「終端」後沒出現「正在看」：' + (document.querySelector('.term-remote')?.textContent || '').slice(0, 80) };
  let rows = '';
  for (let i = 0; i < 60 && !rows.includes('測試通過'); i++) { await sleep(100); rows = document.querySelector('.term-view-screen .xterm-rows')?.textContent || '' }
  if (!rows.includes('測試通過')) return { ok: false, why: '終端畫面沒有出現假畫面的字：' + rows.slice(0, 60) };
  await sleep(300);
  if (vis(conv())) return { ok: false, why: '看終端時訊息列表應該收起來' };
  if (document.querySelector('.term-remote-switch')) return { ok: false, why: '手機只能看，不該有「打字」切換鈕' };
  if (document.documentElement.scrollWidth > window.innerWidth + 1) return { ok: false, why: '整頁橫向溢出' };
  if (!btns[1].classList.contains('on')) return { ok: false, why: '「終端」鈕沒有選中' };
  // 終端至少半個螢幕高（橫向 412 高時曾被擠成 0）；「正在看」縮成一行；輸入框收起、切換圖示仍在畫面內
  const th = document.querySelector('.m-chat .term-remote').getBoundingClientRect().height;
  if (!(th > 0) || th < window.innerHeight * 0.5 - 1) return { ok: false, why: '終端高度不到半個螢幕：' + Math.round(th) + ' / ' + window.innerHeight };
  const sh = document.querySelector('.m-chat .term-view-screen').getBoundingClientRect().height;
  if (!(sh > 0)) return { ok: false, why: '終端畫面高度是 0' };
  const bs = getComputedStyle(bar);
  if (bar.getBoundingClientRect().height > parseFloat(bs.lineHeight) * 1.5 + 2) return { ok: false, why: '「正在看」那行沒有縮成一行' };
  if (vis(document.querySelector('.m-chat .composer'))) return { ok: false, why: '看終端時輸入框應該收起' };
  if (!inView()) return { ok: false, why: '看終端時切換圖示跑出畫面' };
  // 切回「訊息」：訊息列表回來、終端收掉、有通知那台停止；再切回「終端」讓截圖停在終端畫面
  btns[0].click();
  await sleep(500);
  if (!vis(conv())) return { ok: false, why: '切回「訊息」後訊息列表沒回來' };
  if (document.querySelector('.term-view-screen')) return { ok: false, why: '切回「訊息」後終端畫面還在' };
  const calls = (globalThis.__smokeCalls || []).map(c => c[0]);
  if (!calls.includes('term_view_remote_start')) return { ok: false, why: '沒呼叫 term_view_remote_start' };
  if ((globalThis.__smokeConfirms || []).length < 1) return { ok: false, why: '發起前沒有先跳本人確認' };
  if (!calls.includes('term_view_remote_stop')) return { ok: false, why: '切回訊息沒呼叫 term_view_remote_stop' };
  btns[1].click();
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
  if (!sw) return { ok: false, why: '對話頁沒有「訊息／終端」切換' };
  const btns = [...sw.querySelectorAll('button')];
  btns[1].click();
  for (let i = 0; i < 30 && (globalThis.__smokeConfirms || []).length < 1; i++) await sleep(100);
  if ((globalThis.__smokeConfirms || []).length < 1) return { ok: false, why: '點「終端」沒有先跳本人確認' };
  if (${JSON.stringify(gate)} === 'late') {
    btns[0].click();   // 確認還在等（1.5 秒後才回 ok）就切回訊息
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
    if (!btns[0].classList.contains('on')) return { ok: false, why: '取消後「訊息」鈕應該選中' };
    return { ok: true, why: '' };
  }
  if (!area || !area.textContent.includes('這支手機沒有設定螢幕鎖，請先設定再查看終端')) return { ok: false, why: '沒設螢幕鎖要顯示提示：' + (area?.textContent || '').slice(0, 80) };
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
  // Gemini 額度（#374 之三）：有額度時兩條都顯示、沒資料時寫提示；Claude 那一組照舊。手機從設置點進「帳號」看同一區
  { name: 'list-roster-gemini', page: 'list.html', state: { signedIn: true, devicesPage: true, roster: 'gemini' }, ready: '#app.win .dv-my .dv-acct', probe: QUOTA_PROBES.gemini },
  { name: 'list-roster-gemini-empty', page: 'list.html', state: { signedIn: true, devicesPage: true, roster: 'geminiEmpty' }, ready: '#app.win .dv-my .dv-acct', probe: QUOTA_PROBES.geminiEmpty },
  { name: 'm-roster-gemini', page: 'm.html', state: { signedIn: true, mroster: true }, ready: '#app.m .m-row-btn', probe: QUOTA_PROBES.mobile },
  // 兩條額度各自的重置時間（#374）：電腦「我的帳號」各條自己寫；已過的寫「可能已恢復」、不寫舊百分比；手機三行卡片（存截圖）
  { name: 'list-roster-resets', page: 'list.html', state: { signedIn: true, devicesPage: true, roster: 'resets' }, ready: '#app.win .dv-my .dv-acct', probe: RESET_PROBES.resets },
  { name: 'list-roster-reset-passed', page: 'list.html', state: { signedIn: true, devicesPage: true, roster: 'resetPassed' }, ready: '#app.win .dv-my .dv-acct', probe: RESET_PROBES.passed },
  { name: 'm-acct-cards', page: 'm.html', state: { signedIn: true, mroster: 'cards' }, ready: '#app.m .m-row-btn', probe: MCARDS_PROBE, shot: 'm-acct-cards.png' },
  { name: 'm-acct-back-one', page: 'm.html', state: { signedIn: true, macct: 'one' }, ready: '#app.m .m-ghead-act', probe: MACCT_BACK_PROBE },
  { name: 'm-acct-back-two', page: 'm.html', state: { signedIn: true, macct: 'two' }, ready: '#app.m .m-ghead-act', probe: MACCT_BACK_PROBE },
  // 手機設置頁排版（#930）：412、360 寬與大字型各一張
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
  { name: 'list-merged-520', page: 'list.html', width: 520, state: { signedIn: true, devicesPage: true, roster: 'resets' }, ready: '#app.win .dv-my .dv-acct', probe: MPANE_PROBES.double, shot: 'list-merged-520.png' },
  { name: 'm-acct-devbtn', page: 'm.html', state: { signedIn: true, mnoself: 'android' }, ready: '#app.m .m-row-btn', probe: DEVBTN_PROBES.mobile, shot: 'm-acct-devbtn-412.png' },
  { name: 'm-acct-devbtn-360', page: 'm.html', width: 360, state: { signedIn: true, mnoself: 'android' }, ready: '#app.m .m-row-btn', probe: DEVBTN_PROBES.mobile, shot: 'm-acct-devbtn-360.png' },
  // 手機第四格「通知」（#895）：通知分頁看到幾則通知＋四個頁籤的字都放得下；以及第四格的未讀紅點。412、360 寬與大字型各一張
  // 手機開新夥伴的運行選項（#931）：名稱與預設跟電腦版同一份目錄，另有「前台或背景」的說明。412、360 寬與大字型各一張
  { name: 'm-launch', page: 'm.html', state: { signedIn: true, mlaunch: true }, ready: '#app.m .m-plus-wrap', probe: MLAUNCH_PROBES.base, shot: 'm-launch-412.png' },
  { name: 'm-launch-360', page: 'm.html', width: 360, state: { signedIn: true, mlaunch: true }, ready: '#app.m .m-plus-wrap', probe: MLAUNCH_PROBES.base, shot: 'm-launch-360.png' },
  { name: 'm-launch-big', page: 'm.html', width: 360, state: { signedIn: true, mlaunch: true }, ready: '#app.m .m-plus-wrap', probe: MLAUNCH_PROBES.big, shot: 'm-launch-big.png' },
  { name: 'm-notice-tab', page: 'm.html', state: { signedIn: true, mnotice: 'tab' }, ready: '#app.m .m-notice .msg', probe: MNOTICE_PROBES.tab, shot: 'm-notice-tab-412.png' },
  { name: 'm-notice-tab-360', page: 'm.html', width: 360, state: { signedIn: true, mnotice: 'tab' }, ready: '#app.m .m-notice .msg', probe: MNOTICE_PROBES.tab, shot: 'm-notice-tab-360.png' },
  { name: 'm-notice-tab-big', page: 'm.html', width: 360, state: { signedIn: true, mnotice: 'tab' }, ready: '#app.m .m-notice .msg', probe: MNOTICE_PROBES.tabBig, shot: 'm-notice-tab-big.png' },
  // 手機看別台電腦夥伴的終端（PR④，只能看）：「訊息／終端」切換、終端畫面占滿訊息區、不能打字。412、360 寬與大字型各一張
  { name: 'm-term-view', page: 'm.html', state: { signedIn: true, mtermview: true }, ready: '#app.m .m-term-switch', probe: MTERMVIEW_PROBES.base, shot: 'm-term-view-412.png' },
  { name: 'm-term-view-360', page: 'm.html', width: 360, state: { signedIn: true, mtermview: true }, ready: '#app.m .m-term-switch', probe: MTERMVIEW_PROBES.base, shot: 'm-term-view-360.png' },
  { name: 'm-term-view-big', page: 'm.html', width: 360, state: { signedIn: true, mtermview: true }, ready: '#app.m .m-term-switch', probe: MTERMVIEW_PROBES.big, shot: 'm-term-view-big.png' },
  { name: 'm-term-view-land', page: 'm.html', width: 915, height: 412, state: { signedIn: true, mtermview: true }, ready: '#app.m .m-term-switch', probe: MTERMVIEW_PROBES.base, shot: 'm-term-view-land.png' },
  { name: 'm-term-view-cancel', page: 'm.html', width: 360, state: { signedIn: true, mtermview: 'cancel' }, ready: '#app.m .m-term-switch', probe: MTERMVIEW_PROBES.cancel, shot: 'm-term-view-cancel.png' },
  { name: 'm-term-view-nolock', page: 'm.html', width: 360, state: { signedIn: true, mtermview: 'no_lock' }, ready: '#app.m .m-term-switch', probe: MTERMVIEW_PROBES.noLock, shot: 'm-term-view-nolock.png' },
  { name: 'm-term-view-late', page: 'm.html', width: 360, state: { signedIn: true, mtermview: 'late' }, ready: '#app.m .m-term-switch', probe: MTERMVIEW_PROBES.late, shot: 'm-term-view-late.png' },
  { name: 'm-notice-dot', page: 'm.html', state: { signedIn: true, mnotice: 'dot' }, ready: '#app.m .m-tabs i.red', probe: MNOTICE_PROBES.dot, shot: 'm-notice-dot-412.png' },
  { name: 'm-notice-dot-360', page: 'm.html', width: 360, state: { signedIn: true, mnotice: 'dot' }, ready: '#app.m .m-tabs i.red', probe: MNOTICE_PROBES.dot, shot: 'm-notice-dot-360.png' },
  { name: 'm-notice-dot-big', page: 'm.html', width: 360, state: { signedIn: true, mnotice: 'dot' }, ready: '#app.m .m-tabs i.red', probe: MNOTICE_PROBES.dotBig, shot: 'm-notice-dot-big.png' },
  // 舊「○○收發室」列併進通知（#895 驗收）：夥伴頁／對話頁沒有收發室、第四格看得到每位寄件人的信；412、360 寬各一張。
  // lastchat 變體：存檔最後開著的對話是舊收發室列（升級前的狀態），對話頁不該還開著它
  { name: 'm-notice-legacy', page: 'm.html', state: { signedIn: true, mnoticeLegacy: 'list' }, ready: '#app.m .m-buddy', probe: MNOTICE_LEGACY_PROBES.list, shot: 'm-notice-legacy-412.png' },
  { name: 'm-notice-legacy-360', page: 'm.html', width: 360, state: { signedIn: true, mnoticeLegacy: 'list' }, ready: '#app.m .m-buddy', probe: MNOTICE_LEGACY_PROBES.list, shot: 'm-notice-legacy-360.png' },
  { name: 'm-notice-legacy-lastchat', page: 'm.html', state: { signedIn: true, mnoticeLegacy: 'lastchat' }, ready: '#app.m .m-buddy', probe: MNOTICE_LEGACY_PROBES.lastchat, shot: 'm-notice-legacy-lastchat-412.png' },
  { name: 'chat', page: 'chat.html?id=P%2Fdemo', state: { signedIn: true }, ready: '#app.win' },
  { name: 'onboard', page: 'onboard.html', state: { signedIn: true, onboard: true }, ready: '#app.win' },
  { name: 'login', page: 'login.html', state: { signedIn: false, needsLogin: true }, ready: '#app.win' },
  { name: 'panel', page: 'panel.html', state: { signedIn: true }, ready: '#app.win' },
  { name: 'askpass', page: 'askpass.html', state: { signedIn: true }, ready: '#app' },
  { name: 'toast', page: 'toast.html', state: { signedIn: true }, ready: '#app' },
  { name: 'setup-progress', page: 'setup-progress.html', state: { signedIn: true }, ready: '#app .sp' },
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
  // 手機對話頁（不放按鈕列）：412 寬，Claude 視窗、ACP 工作者、離線 Claude；上方沒有按鈕列、「⋯」不列永遠用不到的項目（在線：切換模型、詳情在前；離線：喚醒、切換模型在前；內建通道才有重開、移除）、標頭留著背景工作件數
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
  return t
}

// 注入頁面的腳本（在任何頁面程式之前執行）：假 Tauri
export const injectSource = table => `(() => {
  const T = ${JSON.stringify(table)};
  const missing = (globalThis.__smokeMissing = []);
  // 手機看終端的本人確認（PR③ 的外殼）：表裡的 __confirmViewer＝'ok'／'cancel'／'no_lock'；每次確認都記在 __smokeConfirms
  if (T.__confirmViewer) globalThis.AsnAndroid = { confirmViewer(id) { (globalThis.__smokeConfirms ||= []).push(id); setTimeout(() => globalThis.__asnConfirmViewer && globalThis.__asnConfirmViewer(id, T.__confirmViewer), T.__confirmDelay || 30) } };
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

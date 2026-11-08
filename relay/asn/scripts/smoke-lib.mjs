// 啟動冒煙測試的純邏輯：參數、入口頁清單、假 Tauri 回應表、瀏覽器尋找、掛上判斷。
// smoke-ui.mjs 負責真的起伺服器與無頭瀏覽器；這裡不碰程序與網路，方便單元測試。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { resetWhen } from '../ui/lib/account-quota.mjs'

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
    const sws = [...document.querySelectorAll('.m-dv-sw')].filter(vis);
    if (!sws.length) return { ok: false, why: '沒有切換鈕可以檢查' };
    for (const b of sws) if (b.scrollWidth > b.clientWidth + 1) return { ok: false, why: '「' + b.textContent.trim() + '」的字被切' };
    const cards = [...document.querySelectorAll('.m-dv-acct')].filter(c => c.querySelector('.m-dv-sw'));
    for (const c of cards) {
      const rights = [...c.querySelectorAll('.m-dv-sw')].map(b => R(b).right);
      if (Math.max(...rights) - Math.min(...rights) > 1) return { ok: false, why: '同一張卡的切換鈕右緣沒對齊' };
      const smalls = [...c.querySelectorAll('.m-dv-swt small')].filter(vis);
      const left = [...c.querySelectorAll('.m-dv-sw')].map(b => R(b).left);
      if (Math.max(...left) - Math.min(...left) > 1) return { ok: false, why: '同一張卡的切換鈕寬度不一' };
      for (const sm of smalls) if (R(sm).right > Math.min(...left) + 0.5) return { ok: false, why: '說明字壓到按鈕' };
    }
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
  const sws = [...document.querySelectorAll('.m-dv-sw')].filter(vis).map(b => b.textContent.trim());
  if (sws.some(t => t.includes('這支手機') || t.includes('測試機'))) return { ok: false, why: '帳號頁出現切到這支手機的按鈕：' + sws.join('、') };
  if (!sws.some(t => t.includes('辦公室'))) return { ok: false, why: '別台電腦的切換鈕不見了：' + (sws.join('、') || '（沒有按鈕）') };
  return { ok: true, why: '' };
})()`
export const probeKind = probe => (probe.mtermview ? '手機看終端檢查' : probe.mnotice ? '手機通知分頁檢查' : probe.mnoself ? '手機不能切到本機檢查' : probe.mcloud ? '手機設備列雲端標示檢查' : probe.mlayout ? '手機設置頁排版檢查' : probe.macctBack ? '手機設備與帳號返回檢查' : probe.mcards ? '手機帳號卡檢查' : probe.mattach ? '手機群組附件檢查' : probe.quota ? '額度畫面檢查' : probe.mgroup ? '手機群組按鈕檢查' : probe.mchat ? '手機對話頁檢查' : probe.bar ? '大按鈕檢查' : probe.group ? '群組按鈕檢查' : '遮罩檢查')
export const probeSource = probe => (probe.mtermview ? mtermviewProbeSource(probe) : probe.mnotice ? mnoticeProbeSource(probe) : probe.mnoself ? mnoselfProbeSource(probe) : probe.mcloud ? mcloudProbeSource(probe) : probe.mlayout ? mlayoutProbeSource(probe) : probe.macctBack ? macctBackProbeSource(probe) : probe.mcards ? mcardsProbeSource(probe) : probe.mattach ? mattachProbeSource(probe) : probe.quota ? quotaProbeSource(probe) : probe.mgroup ? mgroupProbeSource(probe) : probe.mchat ? mchatProbeSource(probe) : probe.bar ? barProbeSource(probe) : probe.group ? groupProbeSource(probe) : maskProbeSource(probe))

// 兩條各自的重置時間（#374）：時間要跟著現在走（畫面用瀏覽器的現在算），所以載入時算一次，探測要找的字用同一個時間算
const SMOKE_NOW = Date.now()
const toMinute = ms => new Date(Math.floor(ms / 60_000) * 60_000).toISOString()
export function resetRoster(now = SMOKE_NOW, { passed = false } = {}) {
  const read = toMinute(now - 10 * 60_000)
  const five = passed ? toMinute(now - 30 * 60_000) : toMinute(now + 3 * 3600_000 + 10 * 60_000)
  const week = toMinute(now + 3 * 24 * 3600_000)
  return {
    now: toMinute(now),
    accounts: [{ vendor: 'claude', account: 'me@example.com', plan: 'claude_max', seen_at: read, seen_node: 'P', nodes: [{ node: 'P', current: true, reported_at: read }],
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
    if (!r.kind.startsWith('電腦 · 雲端')) return { ok: false, why: '「' + name + '」沒標雲端：' + r.kind };
  }
  const pc = row('辦公室');
  if (!pc || pc.kind.includes('雲端')) return { ok: false, why: '實體電腦不該標雲端：' + (pc?.kind ?? '找不到') };
  const me = rows.find(r => r.kind.includes('這支手機'));
  if (!me) return { ok: false, why: '找不到這支手機那列' };
  if (!me.kind.startsWith('手機') || me.kind.includes('雲端')) return { ok: false, why: '這支手機要是「手機」、不標雲端：' + me.kind };
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
// ---- 手機看別台電腦夥伴的終端（PR④，只能看）：對話頁頂端「訊息／終端」切換 ----
// 手機是節點 P，夥伴開在另一台電腦 Q；手機端的 Rust 指令之後才有，這裡用假資料驗畫面
export const MTERMVIEW_PROBES = {
  base: { mtermview: true, big: false },
  big: { mtermview: true, big: true },
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
export const mtermviewProbeSource = ({ big }) => `(async () => {
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
  const labels = btns.map(b => b.textContent.trim());
  if (labels.join('|') !== '訊息|終端') return { ok: false, why: '切換鈕的字不對：' + labels.join('、') };
  for (const b of btns) {
    const r = b.getBoundingClientRect(), rg = document.createRange(); rg.selectNodeContents(b); const t = rg.getBoundingClientRect();
    if (t.left < r.left - 0.5 || t.right > r.right + 0.5 || t.bottom > r.bottom + 0.5 || t.top < r.top - 0.5) return { ok: false, why: '切換鈕「' + b.textContent.trim() + '」的字被切' };
  }
  const sr = sw.getBoundingClientRect();
  if (sr.left < -0.5 || sr.right > window.innerWidth + 0.5) return { ok: false, why: '切換列跑出畫面' };
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
  // 切回「訊息」：訊息列表回來、終端收掉、有通知那台停止；再切回「終端」讓截圖停在終端畫面
  btns[0].click();
  await sleep(500);
  if (!vis(conv())) return { ok: false, why: '切回「訊息」後訊息列表沒回來' };
  if (document.querySelector('.term-view-screen')) return { ok: false, why: '切回「訊息」後終端畫面還在' };
  const calls = (globalThis.__smokeCalls || []).map(c => c[0]);
  if (!calls.includes('term_view_remote_start')) return { ok: false, why: '沒呼叫 term_view_remote_start' };
  if (!calls.includes('term_view_remote_stop')) return { ok: false, why: '切回訊息沒呼叫 term_view_remote_stop' };
  btns[1].click();
  rows = '';
  for (let i = 0; i < 60 && !rows.includes('測試通過'); i++) { await sleep(100); rows = document.querySelector('.term-view-screen .xterm-rows')?.textContent || '' }
  if (!rows.includes('測試通過')) return { ok: false, why: '再切回「終端」後畫面沒出來' };
  await sleep(300);
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
  // 手機第四格「通知」（#895）：通知分頁看到幾則通知＋四個頁籤的字都放得下；以及第四格的未讀紅點。412、360 寬與大字型各一張
  { name: 'm-notice-tab', page: 'm.html', state: { signedIn: true, mnotice: 'tab' }, ready: '#app.m .m-notice .msg', probe: MNOTICE_PROBES.tab, shot: 'm-notice-tab-412.png' },
  { name: 'm-notice-tab-360', page: 'm.html', width: 360, state: { signedIn: true, mnotice: 'tab' }, ready: '#app.m .m-notice .msg', probe: MNOTICE_PROBES.tab, shot: 'm-notice-tab-360.png' },
  { name: 'm-notice-tab-big', page: 'm.html', width: 360, state: { signedIn: true, mnotice: 'tab' }, ready: '#app.m .m-notice .msg', probe: MNOTICE_PROBES.tabBig, shot: 'm-notice-tab-big.png' },
  // 手機看別台電腦夥伴的終端（PR④，只能看）：「訊息／終端」切換、終端畫面占滿訊息區、不能打字。412、360 寬與大字型各一張
  { name: 'm-term-view', page: 'm.html', state: { signedIn: true, mtermview: true }, ready: '#app.m .m-term-switch', probe: MTERMVIEW_PROBES.base, shot: 'm-term-view-412.png' },
  { name: 'm-term-view-360', page: 'm.html', width: 360, state: { signedIn: true, mtermview: true }, ready: '#app.m .m-term-switch', probe: MTERMVIEW_PROBES.base, shot: 'm-term-view-360.png' },
  { name: 'm-term-view-big', page: 'm.html', width: 360, state: { signedIn: true, mtermview: true }, ready: '#app.m .m-term-switch', probe: MTERMVIEW_PROBES.big, shot: 'm-term-view-big.png' },
  { name: 'm-notice-dot', page: 'm.html', state: { signedIn: true, mnotice: 'dot' }, ready: '#app.m .m-tabs i.red', probe: MNOTICE_PROBES.dot, shot: 'm-notice-dot-412.png' },
  { name: 'm-notice-dot-360', page: 'm.html', width: 360, state: { signedIn: true, mnotice: 'dot' }, ready: '#app.m .m-tabs i.red', probe: MNOTICE_PROBES.dot, shot: 'm-notice-dot-360.png' },
  { name: 'm-notice-dot-big', page: 'm.html', width: 360, state: { signedIn: true, mnotice: 'dot' }, ready: '#app.m .m-tabs i.red', probe: MNOTICE_PROBES.dotBig, shot: 'm-notice-dot-big.png' },
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
  if (scenario.state.mnotice) {
    t.relay_list = { members: MACCT_MEMBERS.two }
    t.relay_inbox = { messages: noticeMails() }
    t.relay_ack = null
    t.relay_read_sync = { marks: [] }
    t.store_load = { ...t.store_load, values: { ...t.store_load.values, me: JSON.stringify(MNOTICE_ME[scenario.state.mnotice]) } }
  }
  if (scenario.state.mtermview) {
    t.relay_list = { members: MBAR_MEMBERS.claude }
    t.store_load = { ...t.store_load, values: { ...t.store_load.values, me: JSON.stringify(MBAR_ME) } }
    t.android_launchers = { machines: [{ node: 'Q', online: true, launcher: { profiles: [] } }] }
    t.term_view_remote_available = true
    t.term_view_remote_start = { id: 'v1', expires_s: Math.floor(Date.now() / 1000) + 600 }
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

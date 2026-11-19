// 啟動冒煙測試的純邏輯：參數、入口頁清單、假 Tauri 回應表、瀏覽器尋找、掛上判斷。
// smoke-ui.mjs 負責真的起伺服器與無頭瀏覽器；這裡不碰程序與網路，方便單元測試。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { resetWhen } from '../ui/lib/account-quota.mjs'
import { LAUNCH_DISPLAY_NOTE, launchRun, launchVendors } from '../ui/lib/mobile-launch.mjs'
import { findProbe, loadProbes, withProbeScenarios, withProbeTables } from './smoke-registry.mjs'
export { aboutProbeSource } from './smoke-probes/aboutCheck.mjs'
export { barProbeSource } from './smoke-probes/bar.mjs'
export { cameraProbeSource } from './smoke-probes/camera.mjs'
export { devbtnProbeSource } from './smoke-probes/devbtn.mjs'
export { devMoreProbeSource } from './smoke-probes/devMore.mjs'
export { devSelProbeSource } from './smoke-probes/devSel.mjs'
export { dnoticeProbeSource } from './smoke-probes/dnotice.mjs'
export { dtabsProbeSource } from './smoke-probes/dtabs.mjs'
export { fpMarkProbeSource } from './smoke-probes/fpMark.mjs'
export { gjumpProbeSource } from './smoke-probes/gjump.mjs'
export { gofflineProbeSource } from './smoke-probes/goffline.mjs'
export { groupProbeSource } from './smoke-probes/group.mjs'
export { lineDeskProbeSource } from './smoke-probes/lineDesk.mjs'
export { lineMProbeSource } from './smoke-probes/lineM.mjs'
export { lineTimesProbeSource } from './smoke-probes/lineTimes.mjs'
export { lineUiProbeSource } from './smoke-probes/lineUi.mjs'
export { listTrimProbeSource } from './smoke-probes/listTrim.mjs'
export { macctBackProbeSource } from './smoke-probes/macctBack.mjs'
export { mattachProbeSource } from './smoke-probes/mattach.mjs'
export { mcardsProbeSource } from './smoke-probes/mcards.mjs'
export { mchatProbeSource } from './smoke-probes/mchat.mjs'
export { mchatBackProbeSource } from './smoke-probes/mchatBack.mjs'
export { mchatEmptyProbeSource } from './smoke-probes/mchatEmpty.mjs'
export { mcloudProbeSource } from './smoke-probes/mcloud.mjs'
export { mdevsheetProbeSource } from './smoke-probes/mdevsheet.mjs'
export { menuIconsProbeSource } from './smoke-probes/menuIcons.mjs'
export { mgofflineProbeSource } from './smoke-probes/mgoffline.mjs'
export { mgroupProbeSource } from './smoke-probes/mgroup.mjs'
export { mlaunchProbeSource } from './smoke-probes/mlaunch.mjs'
export { mlayoutProbeSource } from './smoke-probes/mlayout.mjs'
export { mnoselfProbeSource } from './smoke-probes/mnoself.mjs'
export { mnoticeProbeSource } from './smoke-probes/mnotice.mjs'
import { LEGACY_SENDERS } from './smoke-probes/mnoticeLegacy.mjs'
export { mnoticeLegacyProbeSource } from './smoke-probes/mnoticeLegacy.mjs'
export { MPANE_CHAT_MIN, MPANE_CONV_MIN, mpaneChatProbeSource, mpaneProbeSource, mpaneWidenProbeSource } from './smoke-probes/mpane.mjs'
export { permDangerProbeSource } from './smoke-probes/mpermDanger.mjs'
export { mpermreqProbeSource } from './smoke-probes/mpermreq.mjs'
export { mreleaseProbeSource } from './smoke-probes/mrelease.mjs'
export { mtabsProbeSource } from './smoke-probes/mtabs.mjs'
export { mtermComposerProbeSource, mtermviewGateProbeSource, mtermviewProbeSource } from './smoke-probes/mtermview.mjs'
export { multiPhotoProbeSource } from './smoke-probes/multiPhoto.mjs'
export { munreadProbeSource } from './smoke-probes/munread.mjs'
export { photoBackProbeSource } from './smoke-probes/photoBack.mjs'
export { photoZoomProbeSource } from './smoke-probes/photoZoom.mjs'
export { quotaProbeSource } from './smoke-probes/quota.mjs'
export { skinProbeSource } from './smoke-probes/skinCheck.mjs'
import { TASKMGR_RESUMING_SID } from './smoke-probes/taskmgr.mjs'
export { TASKMGR_RESUMING_SID, taskmgrProbeSource } from './smoke-probes/taskmgr.mjs'
export { UPD_DL_TOTAL, updDlProbeSource } from './smoke-probes/updDl.mjs'

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
  claude_login_failed: false,
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
// 設備多於 6 台（左邊設備頁籤第 6 格變「⋯」）：8 台別的電腦，各一位在線的夥伴
export const MANY_DEVICES = Array.from({ length: 8 }, (_, i) => ({ id: `D${i + 1}`, name: `電腦${i + 1}`, agents: [{ name: `夥伴${i + 1}`, status: 'idle', cwd_label: 'w' }] }))
// 「⋯」小清單點外面、按 Esc、切分頁都會收起（小良哥 11-12）。用真的滑鼠與按鍵（__smokeInput 由測試程式用偵錯協定送）
export const DEVMORE_PROBE = { devMore: true }
// LINE 手機（#1536）：一則很寬的表格（對方的回覆，markdown）、一句長的文字（看泡泡最大寬度）、自己一句長的
export const LINE_TABLE_MSGS = [
  { id: '00000000-0000-4000-8000-0000000000e1', dir: 'me', body: '幫我整理這週三台電腦的測試結果，列成表格給我看', created_at: '2026-11-15T01:00:00Z', delivered_at: '2026-11-15T01:00:01Z', acked_at: '2026-11-15T01:00:02Z' },
  { id: '00000000-0000-4000-8000-0000000000e2', dir: 'them', body: '整理好了，三台都跑完全套冒煙，下面是每一台的結果和花的時間：', created_at: '2026-11-15T01:01:00Z' },
  { id: '00000000-0000-4000-8000-0000000000e3', dir: 'them', body: ['| 電腦 | 版本 | 情境數 | 通過 | 失敗 | 花費時間 | 備註 |', '|---|---|---|---|---|---|---|', '| 工作機 | 0.2.23 | 207 | 207 | 0 | 12 分 30 秒 | 全綠，沒有雜訊 |', '| 40家用 | 0.2.23 | 207 | 206 | 1 | 13 分 05 秒 | 終端計時那張是雜訊 |', '| 30家用 | 0.2.22 | 193 | 193 | 0 | 11 分 48 秒 | 還沒更新到新版 |'].join(String.fromCharCode(10)), created_at: '2026-11-15T01:01:30Z' },
  { id: '00000000-0000-4000-8000-0000000000e4', dir: 'them', body: '好', created_at: '2026-11-15T01:01:40Z' },
]
// 看大圖縮放（#1498）：一則帶照片的信；大圖用 800×600 的 svg（縮圖是 1×1 的 webp）
export const PHOTO_ZOOM_ID = '00000000-0000-4000-8000-0000000000aa'
export const PHOTO_ZOOM_MSGS = [
  { id: '00000000-0000-4000-8000-000000000011', dir: 'them', body: '〔照片〕貓.webp', created_at: '2026-11-13T01:00:00Z',
    attachments: [{ id: PHOTO_ZOOM_ID, kind: 'image', name: '貓.webp', mime: 'image/webp', bytes: 120000, width: 800, height: 600, thumb: 'data:image/webp;base64,UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA==', expires_at: '2099-01-01T00:00:00Z' }] },
]
export const PHOTO_ZOOM_FULL = "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='800' height='600'><rect width='800' height='600' fill='%2399bbdd'/><circle cx='400' cy='300' r='200' fill='%23ffcc66'/></svg>"
// 設備頁精簡（#1499）：列上只留名字和「電腦／手機・在線／離線」，「已確認／未確認」換成指紋小圖示。
// desk＝電腦版設定的設備頁（兩支手機：一支記住了指紋、一支還沒）；phone＝手機設定的設備頁（兩台電腦：一台確認過、一台還沒，長按看說明）
export const FPMARK_MEMBERS = {
  desk: [{ id: 'Q', name: '辦公室', agents: [{ name: 'demo', status: 'idle', cwd_label: 'demo' }] }, { id: 'M1', name: '小良的手機', agents: [{ name: 'm1', status: 'idle', cwd_label: 'm' }] }, { id: 'M2', name: '舊手機', agents: [{ name: 'm2', status: 'idle', cwd_label: 'm' }] }],
  phone: [{ id: 'Q', name: '辦公室', agents: [{ name: 'demo', status: 'idle', cwd_label: 'demo' }] }, { id: 'R', name: '工作機', agents: [{ name: 'demo', status: 'idle', cwd_label: 'demo' }] }],
}
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

// 手機對話頁（不放按鈕列）：上方沒有任何按鈕列（手機版、電腦版的都沒有），管理項目都在右上角「⋯」；
// 「⋯」不列永遠用不到的項目（前台／後台、在線的喚醒、一般視窗的重開／移除），喚醒、切換模型排最前；個人訊息照樣顯示「背景工作 N 件」
// 手機自己是節點 P；夥伴開在另一台電腦 Q（手機只能遠端管理）
export const MBAR_ME = { lastChat: 'Q/demo', navTab: 'chats' }
// #1438：夥伴頁最上面的「未讀」—— demo 兩則（較早）、小工一則（較新）
const UNREAD_MEMBERS = [{ id: 'Q', name: '辦公室', agents: [{ name: 'demo', status: 'idle', cwd_label: 'demo' }, { name: '小工', status: 'idle', cwd_label: 'work' }] }]
const unreadMails = (now = Date.now()) => [
  { id: '00000000-0000-4000-8000-0000000000b1', from_node: 'Q', from_agent: 'demo', body: '第一則', trust: 'member', to_agent: '測試機', created_at: new Date(now - 30 * 60_000).toISOString() },
  { id: '00000000-0000-4000-8000-0000000000b2', from_node: 'Q', from_agent: 'demo', body: '第二則', trust: 'member', to_agent: '測試機', created_at: new Date(now - 20 * 60_000).toISOString() },
  { id: '00000000-0000-4000-8000-0000000000b3', from_node: 'Q', from_agent: '小工', body: '新的一則', trust: 'member', to_agent: '測試機', created_at: new Date(now - 5 * 60_000).toISOString() },
]
export const MUNREAD_PROBE = { munread: true }
export const MCHAT_EMPTY_PROBE = { mchatEmpty: true }
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

// 群組分頁（#539 之二）：按鈕列有「群組」，選單是三項（#539 收尾拿掉「輸入邀請碼加入」）；「管理」不再有這些（沒有管理也可以）
export const GROUP_ITEMS = ['邀請別人加入', '加我的另一個 AI', '成員與設定']
export const GROUP_ROOM = { id: 'g1', name: '測試群', members: [{ member: 'P~測試機', name: '測試機' }], mine: [{ member: 'P~測試機', unread: 0 }], last_seq: 0, created_at: '2026-10-29T00:00:00Z' }
export const GROUP_ME = { winMode: 'merged', session: { v: 1, tabs: [{ id: 'room:g1' }], active: { id: 'room:g1' }, panel: { guide: '', setting: '' }, windows: [], panelWindows: [] } }
// 群組頂端「N 人離線」（#1460）：現代外觀才有。want＝{ count, names }：按鈕出現、人數、點開列名單、Esc 關閉、點外面關閉；want.none＝不該出現（全員在線，或復古外觀被藏起來）
export const GROUP_OFFLINE_ROOM = { ...GROUP_ROOM, members: [
  { key: '~u:me', name: '我', member_kind: 'human', kind: 'owner', mine: true },
  { key: 'P~財務', name: '財務', member_kind: 'ai', kind: 'window', mine: true, engine: 'claude', online: true },
  { key: 'P~審稿', name: '審稿', member_kind: 'ai', kind: 'window', mine: true, engine: 'gemini', online: false },
  { key: 'x:r2bbbbbb', name: '報表', member_kind: 'ai', kind: 'ai', mine: false, engine: 'gpt', online: false },
] }
// 群組裡點成員跳一對一（#1515）：審稿（P~審稿）在夥伴名單裡、報表（x:…）是別人的 AI 不在。兩人各說一句
export const GJUMP_MEMBERS = [{ id: 'P', name: '測試機', agents: [{ name: '審稿', status: 'offline', cwd_label: 'r' }, { name: '財務', status: 'idle', cwd_label: 'f' }] }]
export const GJUMP_MSGS = [
  { seq: 1, from: 'P~審稿', at: '2026-11-13T01:00:00Z', body: '審稿這邊看完了。', relation: 'mine_ai', from_kind: 'ai', from_name: '審稿' },
  { seq: 2, from: 'x:r2bbbbbb', at: '2026-11-13T01:01:00Z', body: '報表也好了。', relation: 'other', from_kind: 'ai', from_name: '報表' },
]
export const LONG_ROOM_NAME = '這是一個名字很長很長的專案討論群組'
export const GROUP_OFFLINE_LONG_ROOM = { ...GROUP_OFFLINE_ROOM, name: LONG_ROOM_NAME }
export const GOFFLINE_WANT = { count: 2, names: ['審稿', '報表'], label: '2 人離線', center: true }
// 長群組名字：按鈕左緣要在名牌右緣之右（不蓋名牌），且整顆按鈕在視窗內
export const GOFFLINE_LONG_WANT = { count: 2, names: ['審稿', '報表'], label: '2 人離線', fit: true }
// 窄視窗／手機：名字放不下，名牌要出現省略號
export const GOFFLINE_LONG_ELL = { ...GOFFLINE_LONG_WANT, ell: true }
// 名牌置中：一對一、沒有離線鈕的群組，名牌中心與 .mbar 中心相差不得超過 4px
export const GOFFLINE_NONE_CENTER = { none: true, center: true }
// 手機群組對話：上方沒有按鈕列，右上角「⋯」打開是群組的三項（邀請、加 AI、成員與設定），沒有「輸入邀請碼加入」
export const MGROUP_ME = { lastChat: 'room:g1', navTab: 'chats' }
// 額度畫面（#374 之三）：「我的帳號」區每個廠牌（data-vendor）的文字要依序含 want 列的每一段；先等 open 指定的入口（手機要從設定點進「帳號」）
// #374：兩條改成額度條（「5 小時」「剩 40%」各自一段）；absent＝那一組裡不能出現的字
const CLAUDE_BARS = ['Claude', '5 小時', '剩 40%', '每週', '剩 72%']
export const QUOTA_PROBES = {
  gemini: { quota: '.dv-my', want: { claude: CLAUDE_BARS, gemini: ['Gemini', '5 小時', '剩', '每週', '剩'] } },
  geminiEmpty: { quota: '.dv-my', want: { claude: CLAUDE_BARS, gemini: ['Gemini', '開 Gemini 視窗後才讀得到'] } },
  mobile: { quota: '.m-dv-my', open: '帳號', want: { claude: CLAUDE_BARS, gemini: ['Gemini', '5 小時', '剩', '每週', '剩'] } },
}
// 手機「設備與帳號」帳號卡（#374）：每張固定三行（帳號＋右邊固定位置的「使用中」／「切換」、方案、額度）；
// 方案寫 Max 這類、沒有底線；額度兩條各有重置時間；舊資料寫「資料較舊」且不是斜體；頁內沒有第二個返回；說明在最下面
export const MCARDS_PROBE = { mcards: true, open: '帳號' }
// 手機「設備與帳號」返回（修返回鍵退不回設備列表）：從夥伴列表某台設備旁「選項」進來（直接開那台細部）或從設定進來（先看列表），
// 按系統返回鍵一層一層退：細部 → 設備列表 → 收起整頁；兩種進法、一台或多台設備都要。列表＝有 .m-dv-list，細部＝內頁開著但沒有列表
export const MACCT_BACK_PROBE = { macctBack: true }
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
// 帳號卡片的設備按鈕（小良哥 11-09）：用過這個帳號的每台一顆；使用中＝黃色、選中（aria-pressed）、有勾與「使用中」（不能只靠顏色）、
// 不停用但按了不做事（不發出任何切換指令）；「用在：」一行與「切換到…」按鈕都拿掉；按鈕不超出卡片；手機不能切換自己
// 工作管理員（0.2.21）：設定 → 設備 → 這台電腦 → 工作管理員。兩個同名的 asn真（重複）、一般視窗、pi、內建工作者、自己開的前景程式、終端服務、ASN 本體
export const TASKMGR_ME = { winMode: 'merged', session: { v: 1, tabs: [{ id: '@setting' }], active: { id: '@setting' }, panel: { guide: '', setting: 'devices' }, windows: [], panelWindows: [] } }
export const TASKMGR_MEMBERS = [{ id: 'P', agents: [
  { name: 'asn真', status: 'idle', cwd_label: 'asn' }, { name: '西川', status: 'busy', cwd_label: 'asn' },
  { name: '小東', status: 'idle', engine: 'pi', cwd_label: 'pi' }, { name: '小雙', status: 'idle', engine: 'gemini', cwd_label: 'agy' },
] }]
export const taskmgrSnapshot = (now = Date.now()) => ({
  now_ms: now,
  rows: [
    { kind: 'claude', name: 'asn真', engine: 'claude', pid: 18420, memory_bytes: 412 * 1024 * 1024, started_ms: now - (3 * 60 + 12) * 60_000, status: 'idle', detail: null, by_asn: true, cwd: 'G:\\Yooliang\\asn', session_id: 's1', term_id: null, live: true, inside: null },
    { kind: 'claude', name: 'asn真', engine: 'claude', pid: 21096, memory_bytes: 380 * 1024 * 1024, started_ms: now - 41 * 60_000, status: 'idle', detail: null, by_asn: false, cwd: 'G:\\Yooliang\\asn', session_id: 's2', term_id: null, live: true, inside: null },
    { kind: 'claude', name: '西川', engine: 'claude', pid: 3001, memory_bytes: 520 * 1024 * 1024, started_ms: now - 5 * 3600_000, status: 'busy', detail: null, by_asn: true, cwd: 'G:\\Yooliang\\asn', session_id: 's3', term_id: null, live: true, inside: null },
    { kind: 'pi', name: '小東', engine: 'pi', pid: 4002, memory_bytes: 210 * 1024 * 1024, started_ms: now - 90 * 60_000, status: 'idle', detail: null, by_asn: true, cwd: 'G:\\work', session_id: null, term_id: null, live: true, inside: null },
    { kind: 'resuming', name: '小乙', engine: 'claude', pid: 23100, memory_bytes: 96 * 1024 * 1024, started_ms: now - 8 * 60_000, status: 'stuck', detail: null, by_asn: true, cwd: 'G:\\work', session_id: TASKMGR_RESUMING_SID, term_id: '7', live: true, inside: null },
    { kind: 'process', name: 'pi #5120（前景）', engine: 'pi', pid: 5120, memory_bytes: null, started_ms: null, status: 'running', detail: null, by_asn: null, cwd: '', session_id: null, term_id: null, live: true, inside: null },
    { kind: 'mux', name: '終端服務', engine: '', pid: 6000, memory_bytes: 98 * 1024 * 1024, started_ms: now - 2 * 86400_000, status: 'running', detail: null, by_asn: true, cwd: '', session_id: null, term_id: null, live: true, inside: 2 },
    { kind: 'asn', name: 'ASN', engine: 'asn', pid: 7000, memory_bytes: 310 * 1024 * 1024, started_ms: now - 6 * 3600_000, status: 'running', detail: null, by_asn: true, cwd: '', session_id: null, term_id: null, live: true, inside: null },
  ],
  known: [{ name: '阿福', engine: 'claude', cwd: 'G:\\work' }],
})
export const TASKMGR_PROBES = { taskmgr: { taskmgr: true } }
export const DEVBTN_PROBES = { desktop: { devbtn: 'desktop' }, mobile: { devbtn: 'mobile', open: '帳號' } }
// 手機設備細部頁（設備 → 點某台電腦）：整個詳情區塊與底下的廠商卡片、關閉鈕、註腳不能互疊、不能超出視窗、卡片不被水平切掉
export const MDEVSHEET_PROBES = { mobile: { mdevsheet: true } }
// #930 帳號永遠不能切到這支手機自己：noplat＝這支手機的平台還沒讀到（設備樹會先把它當成電腦）；android＝讀到了
export const MNOSELF_PROBES = { noplat: { mnoself: 'noplat' }, android: { mnoself: 'android' } }
// 整合模式窄視窗（#1192）：兩個窗格放不下時一次只顯示一個，右窗格開著時要有「返回名單」回到名單；放得下就維持左右並排。
// single=true：這個寬度必須是單窗格；single=false：必須是兩窗格且右邊夠寬。共通：不橫向捲動、標題不直排、帳號卡看得到
export const MPANE_PROBES = { single: { mpane: true, single: true }, double: { mpane: true, single: false } }
// 整合模式窄視窗、右邊開著對話（#1227 後續）：量右窗格各層寬度，輸入框、傳送鈕要完整看得到。
// 左右並排（single=false）時：對話區（.conv-main）至少 CHAT_CONV_MIN 寬、輸入框與傳送鈕在右窗格內、不橫向溢出；
// 單窗格（single=true）時：只顯示右邊，同樣檢查輸入框完整可見。
export const MPANE_CHAT_PROBES = { single: { mpane: true, chat: true, single: true, folded: true }, double: { mpane: true, chat: true, single: false, folded: true }, wide: { mpane: true, chat: true, single: false, folded: false } }
// 手機四個分頁（0.2.18；#1429 改順序與第四格；#1438 對話分頁直接是那一則）：開 App 先看「對話」＝上次那一則（沒有清單）；設定裡打開「關於」，內頁暫時佔第四格（字換成「關於」），
// 切到夥伴、再點第四格回到內頁；分頁列的字與順序和電腦版一樣
export const MTABS_PROBE = { mtabs: true }
// 手機對話頂端左上的「返回」（0.2.21 小良哥拍板加回來）：一對一、群組都有；現代外觀名牌照樣置中、不和返回鈕重疊；按下去切到「夥伴」分頁
export const MCHAT_BACK_PROBE = { mchatBack: true }
export const DTABS_PROBE = { dtabs: true }
// 外觀「現代」（0.2.18）：存檔選了現代，畫面一開就是現代（<html data-skin="modern">、主色變青綠），而且沒有橫向捲動；截圖給人看整體樣子
export const SKIN_PROBE = { skinCheck: true }
// #1461：現代外觀打開電腦的「更多」或手機的「⋯」，每一項前面都有線條圖示（同一個 key 同一個圖）；移除是紅色。探測完選單留著，截圖看得到
export const MENU_ICONS_PROBE = { menuIcons: true }
// 電腦版「關於」區（#1439）：簡介、版本、四個按鈕（官網、版本紀錄、隱私權政策、使用指引）、記錄、出品都在，且不撐破設定窗寬度
export const ABOUT_PROBE = { aboutCheck: true }
export const SKIN_KEYS_PROBE = { skinCheck: true, keys: true }
// 探測登記表（#1540）：每個探測一個檔，放在 scripts/smoke-probes/，載入時自動收集；情境的 probe 對不到任何登記就是遮罩檢查
export const PROBES = await loadProbes()
export const probeEntry = probe => findProbe(PROBES, probe)
export const probeKind = probe => { const e = probeEntry(probe); return e ? (typeof e.kind === 'function' ? e.kind(probe) : e.kind) : '遮罩檢查' }
export const probeSource = probe => { const e = probeEntry(probe); return e ? e.source(probe) : maskProbeSource(probe) }

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
// #930 手機設定頁排版：這支手機＋兩台電腦（工作機的回報是舊的；#1499 起狀態那一行搬到詳情，列上不再出現）；
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
// 手機「開新夥伴」第 2 步的運行選項：夥伴 → ＋ → 開新夥伴 → 選辦公室 → 下一步；412、360 寬與大字型（1.3 倍）各一張。
// 辦公室回報的啟動設定只有 Claude；選項名稱、預設都要跟電腦版同一份目錄（model-catalog）算出來的一樣，並看得到「前台或背景」的說明
const MLAUNCH_LAUNCHER = { profiles: [{ id: 'claude' }], cwd_allow: ['D:/work'] }
const MLAUNCH_RUN = launchRun(launchVendors(MLAUNCH_LAUNCHER).find(v => v.id === 'claude'), MLAUNCH_LAUNCHER)
export const MLAUNCH_PROBES = {
  base: { mlaunch: true, big: false, labels: MLAUNCH_RUN.options.map(o => o.label), selected: MLAUNCH_RUN.options.find(o => o.key === MLAUNCH_RUN.selected)?.label ?? '', note: LAUNCH_DISPLAY_NOTE },
}
MLAUNCH_PROBES.big = { ...MLAUNCH_PROBES.base, big: true }
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
export const MNOTICE_PROBES = {
  tab: { mnotice: true, view: 'tab', big: false },
  dot: { mnotice: true, view: 'dot', big: false },
  tabBig: { mnotice: true, view: 'tab', big: true },
  dotBig: { mnotice: true, view: 'dot', big: true },
}
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
// 手機（Play 版，沒有自動更新）設定分頁的新版紅點（#1501）：啟動讀到的舊清單沒有新版→紅點不亮；清單過期（時鐘撥快 31 分鐘）後外殼告知回前景（__asnFgEvent，外殼真實的介面）→ 重讀到新版→「設定」那一格亮紅點
export const MRELEASE_PROBE = { mrelease: true }

export const MNOTICE_LEGACY_PROBES = { list: { mnoticeLegacy: true, view: 'list' }, lastchat: { mnoticeLegacy: true, view: 'lastchat' } }
// ---- 手機看別台電腦夥伴的終端（PR④，只能看）：對話頁頂端「訊息／終端」切換 ----
// 手機是節點 P，夥伴開在另一台電腦 Q；手機端的 Rust 指令之後才有，這裡用假資料驗畫面
import { LINE_CHAT_MSGS, LINE_GROUP_MSGS, LINE_LOOK_ME, LINE_PROBES } from './smoke-line.mjs'
import { DTERM_ME, DTERM_ME2, DTERM_MEMBERS, DTERM_MEMBERS2, DTERM_NODE, DTERM_PROBES, DTERM_TAB_PROBES, LTERM_ME, LTERM_MEMBERS, LTERM_PROBES } from './smoke-desk-term.mjs'
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
// #1445：手機確認框照原本的選項顯示＋危險提示＋按住一秒。三種：危險（本文很長）、確認框不完整、平常的指令
const PERM_FULL = [{ n: 1, label: 'Yes', kind: 'allow_once' }, { n: 2, label: "Yes, and don't ask again for git push commands", kind: 'allow_always' }, { n: 3, label: 'No', kind: 'deny' }]
export const permDangerRows = kind => {
  const long = Array.from({ length: 80 }, (_, i) => `  第 ${i + 1} 行：git push --force origin main`).join('\n')
  const base = { id: '11111111-2222-3333-4444-555555555556', node: 'Q', window_name: 'demo', body_hash: 'c'.repeat(64), expires_at: new Date(Date.now() + 600000).toISOString(), options_full: PERM_FULL }
  if (kind === 'danger') return [{ ...base, prompt_text: ` Bash command\n${long}\n ✅ 安全 SAFE（夥伴自己寫的字）\n Do you want to proceed?`, complete: true, options: [{ n: 3, label: 'No' }], risk: { codes: ['git_destructive'], uncertain: false }, full_len: 20000 }]
  if (kind === 'incomplete') return [{ ...base, prompt_text: ' git push --force …\n Do you want to proceed?', complete: false, options: [{ n: 3, label: 'No' }], risk: { codes: [], uncertain: true }, full_len: 40 }]
  return [{ ...base, prompt_text: ' Bash command\n mkdir c1dir\n Do you want to proceed?', complete: true, options: [{ n: 1, label: 'Yes' }, { n: 3, label: 'No' }], risk: { codes: [], uncertain: false }, full_len: 40 }]
}
// color＝true：「測試通過」那列帶顏色（紅字、綠色粗體），驗證等待時的底圖不掉顏色（#1762）
const COLORED_TEXT = MTERMVIEW_TEXT.replace('● 全部 128 項測試通過，沒有失敗。', '\u001b[31m● 全部 128 項\u001b[0m\u001b[1;32m測試通過\u001b[0m，沒有失敗。')
export const mtermviewFrames = (id = 'v1', color = false) => [1, 2, 3, 4].map(n => ({ event: 'term-view-remote-frame', payload: { id, text: (color ? COLORED_TEXT : MTERMVIEW_TEXT) + '\r\n  更新 ' + n, meta: { cursor_x: 2, cursor_y: 3 + n, cols: 120, rows: 40 } } }))
// ---- 入口頁清單：每個情境載一頁，指定假狀態、等待的畫面特徵 ----
// ready：頁面掛上後必須存在的選擇器；頁面不能被導走（導走＝流程錯）
const BASE_SCENARIOS = [
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
  { name: 'm-perm-danger', page: 'm.html', state: { signedIn: true, mpermreq: true, permKind: 'danger' }, ready: '#app.m .m-pager .m-search', probe: { mpermDanger: 'danger' }, shot: 'm-perm-danger.png' },
  { name: 'm-perm-incomplete', page: 'm.html', state: { signedIn: true, mpermreq: true, permKind: 'incomplete' }, ready: '#app.m .m-pager .m-search', probe: { mpermDanger: 'incomplete' }, shot: 'm-perm-incomplete.png' },
  { name: 'm-perm-plain', page: 'm.html', state: { signedIn: true, mpermreq: true, permKind: 'plain', skin: 'modern' }, ready: '#app.m .m-pager .m-search', probe: { mpermDanger: 'plain' }, shot: 'm-perm-plain-modern.png' },
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
  { name: 'list-term-waitcolor', page: 'list.html', width: 1100, height: 640, state: { signedIn: true, dterm: true, dtermColor: true }, ready: '#app.win .chatpane .actionbar', probe: DTERM_PROBES.waitcolor, shot: 'list-term-waitcolor.png' },
  { name: 'list-term-waitcolor-modern', page: 'list.html', width: 900, height: 640, state: { signedIn: true, dterm: true, dtermColor: true, skin: 'modern' }, ready: '#app.win .chatpane .actionbar', probe: DTERM_PROBES.waitcolor, shot: 'list-term-waitcolor-modern.png' },
  { name: 'list-term-waitcolor-line', page: 'list.html', width: 900, height: 640, state: { signedIn: true, dterm: true, dtermColor: true, skin: 'line' }, ready: '#app.win .chatpane .actionbar', probe: DTERM_PROBES.waitcolor, shot: 'list-term-waitcolor-line.png' },
  { name: 'list-term-compose', page: 'list.html', state: { signedIn: true, dterm: true }, ready: '#app.win .chatpane .actionbar', probe: DTERM_PROBES.compose, shot: 'list-term-compose-1100.png' },
  { name: 'list-term-compose-modern', page: 'list.html', width: 900, height: 640, state: { signedIn: true, dterm: true, skin: 'modern' }, ready: '#app.win .chatpane .actionbar', probe: DTERM_PROBES.compose, shot: 'list-term-compose-modern.png' },
  { name: 'm-release-dot', page: 'm.html', state: { signedIn: true, mrelease: true }, ready: '#app.m .m-tabs', probe: MRELEASE_PROBE, shot: 'm-release-dot-412.png' },
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
  { name: 'list-dev-more', page: 'list.html', width: 900, height: 640, state: { signedIn: true, manyDevices: true }, ready: '#app.win .rail .more-wrap', probe: DEVMORE_PROBE, shot: 'list-dev-more.png' },
  { name: 'list-dev-more-modern', page: 'list.html', width: 900, height: 640, state: { signedIn: true, manyDevices: true, skin: 'modern' }, ready: '#app.win .rail .more-wrap', probe: DEVMORE_PROBE, shot: 'list-dev-more-modern.png' },
  { name: 'list-upd-dl-0', page: 'list.html', width: 420, height: 640, state: { signedIn: true, updDl: true }, ready: '#app.win .upd-bar .upd-btn', probe: { updDl: 0 }, shot: 'list-upd-dl-0.png' },
  { name: 'list-upd-dl-4', page: 'list.html', width: 420, height: 640, state: { signedIn: true, updDl: true }, ready: '#app.win .upd-bar .upd-btn', probe: { updDl: 4 }, shot: 'list-upd-dl-4.png' },
  { name: 'list-upd-dl-60', page: 'list.html', width: 420, height: 640, state: { signedIn: true, updDl: true }, ready: '#app.win .upd-bar .upd-btn', probe: { updDl: 60 }, shot: 'list-upd-dl-60.png' },
  { name: 'list-upd-dl-100', page: 'list.html', width: 420, height: 640, state: { signedIn: true, updDl: true }, ready: '#app.win .upd-bar .upd-btn', probe: { updDl: 100 }, shot: 'list-upd-dl-100.png' },
  { name: 'list-upd-dl-0-modern', page: 'list.html', width: 420, height: 640, state: { signedIn: true, updDl: true, skin: 'modern' }, ready: '#app.win .upd-bar .upd-btn', probe: { updDl: 0 }, shot: 'list-upd-dl-0-modern.png' },
  { name: 'list-upd-dl-4-modern', page: 'list.html', width: 420, height: 640, state: { signedIn: true, updDl: true, skin: 'modern' }, ready: '#app.win .upd-bar .upd-btn', probe: { updDl: 4 }, shot: 'list-upd-dl-4-modern.png' },
  { name: 'list-upd-dl-60-modern', page: 'list.html', width: 420, height: 640, state: { signedIn: true, updDl: true, skin: 'modern' }, ready: '#app.win .upd-bar .upd-btn', probe: { updDl: 60 }, shot: 'list-upd-dl-60-modern.png' },
  { name: 'list-upd-dl-100-modern', page: 'list.html', width: 420, height: 640, state: { signedIn: true, updDl: true, skin: 'modern' }, ready: '#app.win .upd-bar .upd-btn', probe: { updDl: 100 }, shot: 'list-upd-dl-100-modern.png' },
  { name: 'list-upd-dl-0-line', page: 'list.html', width: 420, height: 640, state: { signedIn: true, updDl: true, skin: 'line' }, ready: '#app.win .upd-bar .upd-btn', probe: { updDl: 0 }, shot: 'list-upd-dl-0-line.png' },
  { name: 'list-upd-dl-4-line', page: 'list.html', width: 420, height: 640, state: { signedIn: true, updDl: true, skin: 'line' }, ready: '#app.win .upd-bar .upd-btn', probe: { updDl: 4 }, shot: 'list-upd-dl-4-line.png' },
  { name: 'list-upd-dl-60-line', page: 'list.html', width: 420, height: 640, state: { signedIn: true, updDl: true, skin: 'line' }, ready: '#app.win .upd-bar .upd-btn', probe: { updDl: 60 }, shot: 'list-upd-dl-60-line.png' },
  { name: 'list-upd-dl-100-line', page: 'list.html', width: 420, height: 640, state: { signedIn: true, updDl: true, skin: 'line' }, ready: '#app.win .upd-bar .upd-btn', probe: { updDl: 100 }, shot: 'list-upd-dl-100-line.png' },
  { name: 'm-camera', page: 'm.html', state: { signedIn: true, mbar: 'offline', chatMsgs: true, camera: true }, ready: '#app.m .m-chat .chatpane', probe: { camera: 'phone' }, shot: 'm-camera.png' },
  { name: 'm-camera-modern', page: 'm.html', state: { signedIn: true, mbar: 'offline', chatMsgs: true, camera: true, skin: 'modern' }, ready: '#app.m .m-chat .chatpane', probe: { camera: 'phone' }, shot: 'm-camera-modern.png' },
  { name: 'list-no-camera', page: 'list.html', width: 900, height: 640, state: { signedIn: true, bar: 'offline', chatMsgs: true, camera: true }, ready: '#app.win .actionbar', probe: { camera: 'desk' } },
  { name: 'list-multi-photo', page: 'list.html', width: 900, height: 640, state: { signedIn: true, bar: 'offline', chatMsgs: true, multiPhoto: true }, ready: '#app.win .actionbar', probe: { multiPhoto: true }, shot: 'list-multi-photo.png' },
  { name: 'm-multi-photo', page: 'm.html', state: { signedIn: true, mbar: 'offline', chatMsgs: true, multiPhoto: true }, ready: '#app.m .m-chat .chatpane', probe: { multiPhoto: true }, shot: 'm-multi-photo.png' },
  { name: 'list-photo-zoom', page: 'list.html', width: 900, height: 640, state: { signedIn: true, bar: 'offline', photoMsg: true }, ready: '#app.win .actionbar', probe: { photoZoom: 'mouse' }, shot: 'list-photo-zoom.png' },
  { name: 'm-photo-zoom', page: 'm.html', state: { signedIn: true, mbar: 'offline', photoMsg: true }, ready: '#app.m .m-chat .chatpane', probe: { photoZoom: 'touch' }, shot: 'm-photo-zoom.png' },
  // #1537：手機看大圖按返回鍵只關掉看圖，三種外觀各一
  { name: 'm-photo-back', page: 'm.html', state: { signedIn: true, mbar: 'offline', photoMsg: true }, ready: '#app.m .m-chat .chatpane', probe: { photoBack: true }, shot: 'm-photo-back.png' },
  { name: 'm-photo-back-modern', page: 'm.html', state: { signedIn: true, mbar: 'offline', photoMsg: true, skin: 'modern' }, ready: '#app.m .m-chat .chatpane', probe: { photoBack: true }, shot: 'm-photo-back-modern.png' },
  { name: 'm-photo-back-line', page: 'm.html', state: { signedIn: true, mbar: 'offline', photoMsg: true, skin: 'line' }, ready: '#app.m .m-chat .chatpane', probe: { photoBack: true }, shot: 'm-photo-back-line.png' },
  { name: 'list-dev-fpmark', page: 'list.html', width: 900, height: 640, state: { signedIn: true, fpMark: 'desk' }, ready: '#app.win .dv-set', probe: { fpMark: 'desk' }, shot: 'list-dev-fpmark.png' },
  { name: 'list-dev-fpmark-modern', page: 'list.html', width: 900, height: 640, state: { signedIn: true, fpMark: 'desk', skin: 'modern' }, ready: '#app.win .dv-set', probe: { fpMark: 'desk' }, shot: 'list-dev-fpmark-modern.png' },
  { name: 'm-dev-select', page: 'm.html', height: 420, state: { signedIn: true, fpMark: 'phone' }, ready: '#app.m .m-row-btn', probe: { devSel: true }, shot: 'm-dev-select.png' },
  { name: 'm-dev-select-modern', page: 'm.html', height: 420, state: { signedIn: true, fpMark: 'phone', skin: 'modern' }, ready: '#app.m .m-row-btn', probe: { devSel: true }, shot: 'm-dev-select-modern.png' },
  { name: 'm-dev-select-line', page: 'm.html', height: 420, state: { signedIn: true, fpMark: 'phone', skin: 'line' }, ready: '#app.m .m-row-btn', probe: { devSel: true }, shot: 'm-dev-select-line.png' },
  { name: 'm-dev-fpmark', page: 'm.html', state: { signedIn: true, fpMark: 'phone' }, ready: '#app.m .m-row-btn', probe: { fpMark: 'phone' }, shot: 'm-dev-fpmark.png' },
  { name: 'm-dev-fpmark-modern', page: 'm.html', state: { signedIn: true, fpMark: 'phone', skin: 'modern' }, ready: '#app.m .m-row-btn', probe: { fpMark: 'phone' }, shot: 'm-dev-fpmark-modern.png' },
  { name: 'list-modern', page: 'list.html', width: 420, height: 720, state: { signedIn: true, skin: 'modern' }, ready: '#app.win .top-tabs .ttab', probe: SKIN_PROBE, shot: 'list-modern.png' },
  { name: 'list-modern-chat', page: 'list.html', width: 900, height: 640, state: { signedIn: true, partnerTab: true, skin: 'modern' }, ready: '#app.win .actionbar', probe: SKIN_KEYS_PROBE, shot: 'list-modern-chat.png' },
  { name: 'm-modern', page: 'm.html', state: { signedIn: true, mbar: 'claude', skin: 'modern' }, ready: '#app.m .m-chat .chatpane', probe: SKIN_PROBE, shot: 'm-modern-chat.png' },
  { name: 'm-modern-list', page: 'm.html', state: { signedIn: true, mbar: 'claude', mtab: 'list', skin: 'modern' }, ready: '#app.m section[aria-label="夥伴"] .m-buddy', probe: SKIN_PROBE, shot: 'm-modern-list.png' },
  // #1421 A：有訊息的對話（卡片圓角、頭像）、離線／忙碌的標題列與收件人列（權重衝突修正）
  { name: 'list-modern-msgs', page: 'list.html', width: 900, height: 640, state: { signedIn: true, bar: 'offline', chatMsgs: true, skin: 'modern' }, ready: '#app.win .actionbar', probe: SKIN_PROBE, shot: 'list-modern-msgs.png' },
  { name: 'm-modern-msgs', page: 'm.html', state: { signedIn: true, mbar: 'offline', chatMsgs: true, skin: 'modern' }, ready: '#app.m .m-chat .chatpane', probe: SKIN_KEYS_PROBE, shot: 'm-modern-msgs.png' },
  { name: 'm-modern-busy', page: 'm.html', state: { signedIn: true, mbar: 'busy', skin: 'modern' }, ready: '#app.m .m-chat .chatpane', probe: SKIN_PROBE, shot: 'm-modern-busy.png' },
  // #1421 B 之三：可以看終端的夥伴，頂端右邊有「看終端」圓鈕
  { name: 'list-modern-more', page: 'list.html', width: 900, height: 640, state: { signedIn: true, bar: 'offline', chatMsgs: true, skin: 'modern' }, ready: '#app.win .actionbar', probe: MENU_ICONS_PROBE, shot: 'list-modern-more.png' },
  { name: 'm-modern-ops', page: 'm.html', state: { signedIn: true, mbar: 'claude', skin: 'modern' }, ready: '#app.m .m-chat .chatpane', probe: MENU_ICONS_PROBE, shot: 'm-modern-ops.png' },
  { name: 'm-modern-term', page: 'm.html', state: { signedIn: true, mtermview: true, skin: 'modern' }, ready: '#app.m .m-head-term', probe: SKIN_PROBE, shot: 'm-modern-term.png' },
  { name: 'list-tabs', page: 'list.html', width: 420, height: 720, state: { signedIn: true }, ready: '#app.win .top-tabs .ttab', probe: DTABS_PROBE, shot: 'list-tabs.png' },
  // #1531：電腦版名單頂端精簡，三種外觀各一張（真點框內放大鏡、真點「＋」選單裡的建立／加入群組）
  { name: 'list-trim', page: 'list.html', width: 420, height: 720, state: { signedIn: true }, ready: '#app.win .top-tabs .ttab', probe: { listTrim: 'aero' }, shot: 'list-trim.png' },
  { name: 'list-trim-modern', page: 'list.html', width: 420, height: 720, state: { signedIn: true, skin: 'modern' }, ready: '#app.win .top-tabs .ttab', probe: { listTrim: 'modern' }, shot: 'list-trim-modern.png' },
  { name: 'list-trim-line', page: 'list.html', width: 420, height: 720, state: { signedIn: true, skin: 'line' }, ready: '#app.win .top-tabs .ttab', probe: { listTrim: 'line' }, shot: 'list-trim-line.png' },
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
  { name: 'm-chat-back', page: 'm.html', state: { signedIn: true, mbar: 'claude' }, ready: '#app.m .m-chat .chatpane', probe: MCHAT_BACK_PROBE, shot: 'm-chat-back.png' },
  { name: 'm-chat-back-modern', page: 'm.html', state: { signedIn: true, mbar: 'claude', skin: 'modern' }, ready: '#app.m .m-chat .chatpane', probe: MCHAT_BACK_PROBE, shot: 'm-chat-back-modern.png' },
  { name: 'm-chat-back-group-modern', page: 'm.html', state: { signedIn: true, mgroup: true, offline: true, skin: 'modern' }, ready: '#app.m .m-chat .chatpane', probe: MCHAT_BACK_PROBE, shot: 'm-chat-back-group-modern.png' },
  { name: 'm-tabs', page: 'm.html', state: { signedIn: true, mbar: 'claude' }, ready: '#app.m .m-chat .chatpane', probe: MTABS_PROBE, shot: 'm-tabs.png' },
  // #1438：夥伴頁最上面的「未讀」（Aero 與現代各一）、對話分頁還沒有最後一則時的提示
  { name: 'm-unread', page: 'm.html', state: { signedIn: true, munread: true, mtab: 'list' }, ready: '#app.m .m-unread', probe: MUNREAD_PROBE, shot: 'm-unread.png' },
  { name: 'm-unread-modern', page: 'm.html', state: { signedIn: true, munread: true, mtab: 'list', skin: 'modern' }, ready: '#app.m .m-unread', probe: MUNREAD_PROBE, shot: 'm-unread-modern.png' },
  { name: 'm-chat-empty', page: 'm.html', state: { signedIn: true, mbar: 'claude', mtab: 'chats' }, ready: '#app.m section[aria-label="對話"] .empty-list', probe: MCHAT_EMPTY_PROBE, shot: 'm-chat-empty.png' },
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
  { name: 'list-group-offline-modern', page: 'list.html', width: 900, height: 640, state: { signedIn: true, groupTab: true, offline: true, skin: 'modern' }, ready: '#app.win .actionbar', probe: { goffline: GOFFLINE_WANT }, shot: 'list-group-offline-modern.png' },
  { name: 'list-group-offline-long-modern', page: 'list.html', width: 900, height: 640, state: { signedIn: true, groupTab: true, offline: true, longName: true, skin: 'modern' }, ready: '#app.win .actionbar', probe: { goffline: GOFFLINE_LONG_WANT }, shot: 'list-group-offline-long-modern.png' },
  { name: 'list-group-offline-long-narrow-modern', page: 'list.html', width: 420, height: 640, state: { signedIn: true, groupTab: true, offline: true, longName: true, skin: 'modern' }, ready: '#app.win .actionbar', probe: { goffline: GOFFLINE_LONG_ELL }, shot: 'list-group-offline-long-narrow-modern.png' },
  { name: 'm-group-offline-long-modern', page: 'm.html', state: { signedIn: true, mgroup: true, offline: true, longName: true, skin: 'modern' }, ready: '#app.m .m-chat .chatpane', probe: { mgoffline: GOFFLINE_LONG_ELL }, shot: 'm-group-offline-long-modern.png' },
  { name: 'list-gjump', page: 'list.html', width: 900, height: 640, state: { signedIn: true, groupTab: true, offline: true, gjump: true }, ready: '#app.win .actionbar', probe: { gjump: { mode: 'desk', list: false } }, shot: 'list-gjump.png' },
  { name: 'm-gjump', page: 'm.html', state: { signedIn: true, mgroup: true, offline: true, gjump: true }, ready: '#app.m .m-chat .chatpane', probe: { gjump: { mode: 'phone', list: false } }, shot: 'm-gjump.png' },
  { name: 'list-gjump-modern', page: 'list.html', width: 900, height: 640, state: { signedIn: true, groupTab: true, offline: true, gjump: true, skin: 'modern' }, ready: '#app.win .actionbar', probe: { gjump: { mode: 'desk', list: true } }, shot: 'list-gjump-modern.png' },
  { name: 'm-gjump-stale', page: 'm.html', state: { signedIn: true, mgroup: true, offline: true, gjump: true }, ready: '#app.m .m-chat .chatpane', probe: { gjump: { mode: 'phone', stale: true } }, shot: 'm-gjump-stale.png' },
  { name: 'm-gjump-modern', page: 'm.html', state: { signedIn: true, mgroup: true, offline: true, gjump: true, skin: 'modern' }, ready: '#app.m .m-chat .chatpane', probe: { gjump: { mode: 'phone', list: true } }, shot: 'm-gjump-modern.png' },
  { name: 'list-gjump-line', page: 'list.html', width: 900, height: 640, state: { signedIn: true, groupTab: true, offline: true, gjump: true, skin: 'line' }, ready: '#app.win .actionbar', probe: { gjump: { mode: 'desk', list: false } }, shot: 'list-gjump-line.png' },
  { name: 'm-gjump-line', page: 'm.html', state: { signedIn: true, mgroup: true, offline: true, gjump: true, skin: 'line' }, ready: '#app.m .m-chat .chatpane', probe: { gjump: { mode: 'phone', list: false } }, shot: 'm-gjump-line.png' },
  { name: 'list-gjump-shot', page: 'list.html', width: 900, height: 640, state: { signedIn: true, groupTab: true, offline: true, gjump: true }, ready: '#app.win .actionbar', probe: { gjump: { mode: 'desk', shotOnly: true } }, shot: 'list-gjump-shot.png' },
  { name: 'm-gjump-shot', page: 'm.html', state: { signedIn: true, mgroup: true, offline: true, gjump: true }, ready: '#app.m .m-chat .chatpane', probe: { gjump: { mode: 'phone', shotOnly: true } }, shot: 'm-gjump-shot.png' },
  { name: 'list-gjump-shot-modern', page: 'list.html', width: 900, height: 640, state: { signedIn: true, groupTab: true, offline: true, gjump: true, skin: 'modern' }, ready: '#app.win .actionbar', probe: { gjump: { mode: 'desk', shotOnly: true } }, shot: 'list-gjump-shot-modern.png' },
  { name: 'm-gjump-shot-modern', page: 'm.html', state: { signedIn: true, mgroup: true, offline: true, gjump: true, skin: 'modern' }, ready: '#app.m .m-chat .chatpane', probe: { gjump: { mode: 'phone', shotOnly: true } }, shot: 'm-gjump-shot-modern.png' },
  { name: 'list-group-online-modern', page: 'list.html', width: 900, height: 640, state: { signedIn: true, groupTab: true, skin: 'modern' }, ready: '#app.win .actionbar', probe: { goffline: GOFFLINE_NONE_CENTER } },
  { name: 'list-modern-msgs-center', page: 'list.html', width: 900, height: 640, state: { signedIn: true, bar: 'offline', chatMsgs: true, skin: 'modern' }, ready: '#app.win .actionbar', probe: { goffline: GOFFLINE_NONE_CENTER } },
  { name: 'list-group-offline-aero', page: 'list.html', state: { signedIn: true, groupTab: true, offline: true }, ready: '#app.win .actionbar', probe: { goffline: { none: true } } },
  { name: 'm-group-offline-modern', page: 'm.html', state: { signedIn: true, mgroup: true, offline: true, skin: 'modern' }, ready: '#app.m .m-chat .chatpane', probe: { mgoffline: GOFFLINE_WANT }, shot: 'm-group-offline-modern.png' },
  { name: 'm-group-online-modern', page: 'm.html', state: { signedIn: true, mgroup: true, skin: 'modern' }, ready: '#app.m .m-chat .chatpane', probe: { mgoffline: { none: true, center: true } } },
  { name: 'm-group-offline-aero', page: 'm.html', state: { signedIn: true, mgroup: true, offline: true }, ready: '#app.m .m-chat .chatpane', probe: { mgoffline: { none: true } } },
  { name: 'list-group-tab', page: 'list.html', state: { signedIn: true, groupTab: true }, ready: '#app.win .actionbar', probe: { group: GROUP_ITEMS } },
  { name: 'list-aero-chat', page: 'list.html', width: 900, height: 640, state: { signedIn: true, partnerTab: true }, ready: '#app.win .actionbar', shot: 'list-aero-chat.png' },
  // 工作管理員（0.2.21）：Aero 與現代各一張；兩個同名視窗標「重複」、只能看的列沒有停止鈕，並實際打開停止確認框
  { name: 'list-taskmgr-aero', page: 'list.html', width: 1100, height: 760, state: { signedIn: true, taskmgr: true }, ready: '#app.win .dv-set', probe: TASKMGR_PROBES.taskmgr, shot: 'list-taskmgr-aero.png' },
  { name: 'list-taskmgr-modern', page: 'list.html', width: 1100, height: 760, state: { signedIn: true, taskmgr: true, skin: 'modern' }, ready: '#app.win .dv-set', probe: TASKMGR_PROBES.taskmgr, shot: 'list-taskmgr-modern.png' },
  { name: 'list-aero-about', page: 'list.html', width: 900, height: 640, state: { signedIn: true, aboutPage: true }, ready: '#app.win .settings', probe: ABOUT_PROBE, shot: 'list-aero-about.png' },
  { name: 'list-modern-about', page: 'list.html', width: 900, height: 640, state: { signedIn: true, aboutPage: true, skin: 'modern' }, ready: '#app.win .settings', probe: ABOUT_PROBE, shot: 'list-modern-about.png' },
  // 外觀「LINE 風格」（0.2.22，#1449 第一張）：淡藍底、白色對方泡泡有尾巴、自己泡泡＝--line-me、清單、設定頁三選一（真的點擊，要有 __smokeInput）
  { name: 'list-line-msgs', page: 'list.html', width: 900, height: 640, state: { signedIn: true, bar: 'offline', chatMsgs: true, skin: 'line' }, ready: '#app.win .actionbar', probe: LINE_PROBES.deskMsgs, shot: 'list-line-msgs.png' },
  { name: 'list-line-group', page: 'list.html', width: 900, height: 640, state: { signedIn: true, groupTab: true, groupMsgs: true, skin: 'line' }, ready: '#app.win .actionbar', probe: LINE_PROBES.deskMsgs, shot: 'list-line-group.png' },
  { name: 'list-line-list', page: 'list.html', width: 900, height: 640, state: { signedIn: true, bar: 'offline', skin: 'line' }, ready: '#app.win .buddy', probe: LINE_PROBES.deskList, shot: 'list-line-list.png' },
  { name: 'list-line-settings', page: 'list.html', width: 900, height: 640, state: { signedIn: true, lookPage: true, skin: 'line' }, ready: '#app.win .skin-pick', probe: LINE_PROBES.deskSettings, shot: 'list-line-settings.png' },
  { name: 'm-line-msgs', page: 'm.html', state: { signedIn: true, mbar: 'offline', chatMsgs: true, skin: 'line' }, ready: '#app.m .m-chat .chatpane', probe: LINE_PROBES.mobileMsgs, shot: 'm-line-msgs.png' },
  { name: 'm-line-group', page: 'm.html', state: { signedIn: true, mgroup: true, groupMsgs: true, skin: 'line' }, ready: '#app.m .m-chat .chatpane', probe: LINE_PROBES.mobileMsgs, shot: 'm-line-group.png' },
  { name: 'm-line-list', page: 'm.html', state: { signedIn: true, mbar: 'claude', mtab: 'list', skin: 'line' }, ready: '#app.m section[aria-label="夥伴"] .m-buddy', probe: LINE_PROBES.mobileList, shot: 'm-line-list.png' },
  { name: 'list-line-nav', page: 'list.html', width: 900, height: 640, state: { signedIn: true, bar: 'offline', skin: 'line' }, ready: '#app.win .top-tabs .ttab', probe: LINE_PROBES.deskNav, shot: 'list-line-nav.png' },
  { name: 'list-line-chat', page: 'list.html', width: 900, height: 640, state: { signedIn: true, partnerTab: true, lineMsgs: true, skin: 'line' }, ready: '#app.win .chat-area .compose-main', probe: LINE_PROBES.deskChat, shot: 'list-line-chat.png' },
  { name: 'list-line-narrow', page: 'list.html', width: 500, height: 640, state: { signedIn: true, partnerTab: true, lineMsgs: true, skin: 'line' }, ready: '#app.win .chat-area .compose-main', probe: LINE_PROBES.deskNarrow, shot: 'list-line-narrow.png' },
  { name: 'list-line-desk', page: 'list.html', width: 900, height: 640, state: { signedIn: true, partnerTab: true, lineMsgs: true, lineDesk: true, skin: 'line' }, ready: '#app.win .list .g-head', probe: { lineDesk: 'wide' }, shot: 'list-line-desk.png' },
  { name: 'list-line-desk-narrow', page: 'list.html', width: 500, height: 640, state: { signedIn: true, partnerTab: true, lineMsgs: true, lineDesk: true, skin: 'line' }, ready: '#app.win .list .g-head', probe: { lineDesk: 'narrow' }, shot: 'list-line-desk-narrow.png' },
  { name: 'm-line-nav', page: 'm.html', state: { signedIn: true, mbar: 'claude', mtab: 'list', skin: 'line' }, ready: '#app.m section[aria-label="夥伴"] .m-buddy', probe: LINE_PROBES.mobileNav, shot: 'm-line-nav.png' },
  { name: 'm-line-compose-ui', page: 'm.html', state: { signedIn: true, mbar: 'offline', lineMsgs: true, skin: 'line' }, ready: '#app.m .m-chat .chatpane', probe: { lineUi: { mode: 'phone', part: 'compose' } }, shot: 'm-line-compose-ui.png' },
  { name: 'list-line-compose-ui', page: 'list.html', width: 900, height: 640, state: { signedIn: true, partnerTab: true, lineMsgs: true, skin: 'line' }, ready: '#app.win .actionbar', probe: { lineUi: { mode: 'desk', part: 'compose' } }, shot: 'list-line-compose-ui.png' },
  { name: 'm-line-busy', page: 'm.html', state: { signedIn: true, mbar: 'busy', skin: 'line' }, ready: '#app.m .m-chat .chatpane', probe: { lineUi: { mode: 'phone', part: 'busy' } }, shot: 'm-line-busy.png' },
  { name: 'list-line-busy', page: 'list.html', width: 900, height: 640, state: { signedIn: true, bar: 'tasks', skin: 'line' }, ready: '#app.win .actionbar', probe: { lineUi: { mode: 'desk', part: 'busy' } }, shot: 'list-line-busy.png' },
  { name: 'm-line-times', page: 'm.html', state: { signedIn: true, mbar: 'offline', lineMsgs: true, skin: 'line' }, ready: '#app.m .m-chat .chatpane', probe: { lineTimes: true }, shot: 'm-line-times.png' },
  { name: 'list-line-times', page: 'list.html', width: 900, height: 640, state: { signedIn: true, partnerTab: true, lineMsgs: true, skin: 'line' }, ready: '#app.win .actionbar', probe: { lineTimes: true }, shot: 'list-line-times.png' },
  { name: 'm-line-table-360', page: 'm.html', width: 360, state: { signedIn: true, mbar: 'offline', lineTable: true, skin: 'line' }, ready: '#app.m .m-chat .chatpane', probe: { lineM: 'table' }, shot: 'm-line-table-360.png' },
  { name: 'm-line-table-412', page: 'm.html', width: 412, state: { signedIn: true, mbar: 'offline', lineTable: true, skin: 'line' }, ready: '#app.m .m-chat .chatpane', probe: { lineM: 'table' }, shot: 'm-line-table-412.png' },
  { name: 'm-line-dict', page: 'm.html', state: { signedIn: true, mbar: 'offline', lineMsgs: true, lineDict: true, skin: 'line' }, ready: '#app.m .m-chat .chatpane', probe: { lineM: 'dict' }, shot: 'm-line-dict.png' },
  { name: 'm-line-send', page: 'm.html', state: { signedIn: true, mbar: 'offline', lineMsgs: true, lineDict: true, skin: 'line' }, ready: '#app.m .m-chat .chatpane', probe: { lineM: 'send' }, shot: 'm-line-send.png' },
  { name: 'm-line-head-online', page: 'm.html', state: { signedIn: true, mbar: 'claude', lineMsgs: true, skin: 'line' }, ready: '#app.m .m-chat .chatpane', probe: { lineM: 'head' }, shot: 'm-line-head-online.png' },
  { name: 'm-line-head-busy', page: 'm.html', state: { signedIn: true, mbar: 'busy', lineMsgs: true, skin: 'line' }, ready: '#app.m .m-chat .chatpane', probe: { lineM: 'head' }, shot: 'm-line-head-busy.png' },
  { name: 'm-line-group-head', page: 'm.html', state: { signedIn: true, mgroup: true, groupMsgs: true, skin: 'line' }, ready: '#app.m .m-chat .chatpane', probe: { lineM: 'group' }, shot: 'm-line-group-head.png' },
  { name: 'm-line-chat', page: 'm.html', state: { signedIn: true, mbar: 'offline', lineMsgs: true, skin: 'line' }, ready: '#app.m .m-chat .chatpane', probe: LINE_PROBES.mobileChat, shot: 'm-line-chat.png' },
  { name: 'm-line-settings', page: 'm.html', state: { signedIn: true, skin: 'line' }, ready: '#app.m .m-pager .m-search', probe: LINE_PROBES.mobileSettings, shot: 'm-line-settings.png' },
  { name: 'list-line-rows', page: 'list.html', width: 900, height: 640, state: { signedIn: true, munread: true, skin: 'line' }, ready: '#app.win .top-tabs .ttab', probe: LINE_PROBES.deskRows, shot: 'list-line-rows.png' },
  { name: 'm-line-rows', page: 'm.html', state: { signedIn: true, munread: true, mtab: 'list', skin: 'line' }, ready: '#app.m .m-unread', probe: LINE_PROBES.mobileRows, shot: 'm-line-rows.png' },
  { name: 'list-line-compose', page: 'list.html', width: 900, height: 640, state: { signedIn: true, partnerTab: true, lineMsgs: true, skin: 'line' }, ready: '#app.win .chat-area .compose-main', probe: LINE_PROBES.deskCompose, shot: 'list-line-compose.png' },
  { name: 'm-line-compose', page: 'm.html', state: { signedIn: true, mbar: 'offline', lineMsgs: true, skin: 'line' }, ready: '#app.m .m-chat .chatpane', probe: LINE_PROBES.mobileCompose, shot: 'm-line-compose.png' },
  { name: 'list-modern-term', page: 'list.html', width: 900, height: 640, state: { signedIn: true, dterm: true, skin: 'modern' }, ready: '#app.win .chatpane .actionbar', probe: DTERM_PROBES.watch, shot: 'list-modern-term.png' },
]
// 探測檔自帶的情境（#1540）接在後面：新增情境不用改上面這張表
export const SCENARIOS = withProbeScenarios(BASE_SCENARIOS, PROBES)
// 刻意不測的 ui/*.html（要寫理由）；其餘 html 都必須有情境（見單元測試）
export const EXCLUDED_PAGES = {
  'shot.html': '截圖框選覆蓋層：由 Rust 端帶截圖資料開啟，沒有獨立的啟動流程，另有 shot 測試',
}

// 這個情境的完整假回應表（引導情境不預設「已引導」，讓引導畫面出現）
// 帳號列表（#374）情境：整合模式、上次開著「設定：帳號」，開機就會讀 acct_roster
export const ABOUT_ME = { winMode: 'merged', session: { v: 1, tabs: [{ id: '@setting' }], active: { id: '@setting' }, panel: { guide: '', setting: 'about' }, windows: [], panelWindows: [] } }
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
  let t = fakeTable(scenario.state)
  if (scenario.state.onboard) t.store_load = { by: 'name', values: {}, fallback: null }
  if (scenario.state.aboutPage) t.store_load = { ...t.store_load, values: { ...t.store_load.values, me: JSON.stringify(ABOUT_ME) } }
  if (scenario.state.devicesPage) t.store_load = { ...t.store_load, values: { ...t.store_load.values, me: JSON.stringify(ROSTER_ME) } }
  if (scenario.state.fpMark === 'desk') {   // 設備頁精簡（#1499）：電腦版
    t.relay_list = { members: FPMARK_MEMBERS.desk }
    t.store_load = { ...t.store_load, values: { ...t.store_load.values, me: JSON.stringify(TASKMGR_ME) } }
    t.relay_launchers = { machines: [{ node: 'M1', platform: 'android', launcher: null }, { node: 'M2', platform: 'android', launcher: null }] }
    t.device_known_list = { peers: [{ node: 'M1', name: '小良的手機', fingerprint: '3fa2c91b7d0e4a5f8c6b2d1e0f9a8b7c', first_seen_ms: 1763000000000 }] }
  }
  if (scenario.state.fpMark === 'phone') {   // 設備頁精簡（#1499）：手機
    t.relay_list = { members: FPMARK_MEMBERS.phone }
    t.store_load = { ...t.store_load, values: { ...t.store_load.values, me: JSON.stringify(MROSTER_ME) } }
    t.android_launchers = { machines: [{ node: 'P', platform: 'android', launcher: null }] }
    t.android_known_list = { peers: [{ node: 'Q', name: '辦公室', confirmed: true, fp: '3fa2c91b7d0e4a5f8c6b2d1e0f9a8b7c', first_seen_ms: 1763000000000 }, { node: 'R', name: '工作機', confirmed: false, first_seen_ms: 1763000000000 }] }
  }
  if (scenario.state.manyDevices) t.relay_list = { members: MANY_DEVICES }
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
    t.relay_rooms = { rooms: [scenario.state.external ? { ...GROUP_ROOM, external: true } : scenario.state.offline ? (scenario.state.longName ? GROUP_OFFLINE_LONG_ROOM : GROUP_OFFLINE_ROOM) : GROUP_ROOM] }
    t.relay_send_attachment = { seq: 1 }
    t.android_room_read = { messages: [] }
    t.relay_group = { by: 'action', values: { group_confirm_list: { confirms: [] } }, fallback: null }
    t.store_load = { ...t.store_load, values: { ...t.store_load.values, me: JSON.stringify(MGROUP_ME) } }
  }
  if (scenario.state.groupTab) {
    t.relay_rooms = { rooms: [scenario.state.offline ? (scenario.state.longName ? GROUP_OFFLINE_LONG_ROOM : GROUP_OFFLINE_ROOM) : GROUP_ROOM] }
    t.relay_room_read = { messages: [] }
    t.relay_group = { by: 'action', values: { group_confirm_list: { confirms: [] } }, fallback: null }
    t.store_load = { ...t.store_load, values: { ...t.store_load.values, me: JSON.stringify(GROUP_ME) } }
  }
  if (scenario.state.lineDict) t.__dict = true   // LINE 手機（#1536）：有語音輸入的麥克風
  if (scenario.state.lineTable) t.relay_chat_history = { messages: LINE_TABLE_MSGS }   // LINE 手機（#1536）：寬表格與長句
  if (scenario.state.lineMsgs) t.relay_chat_history = { messages: LINE_CHAT_MSGS }   // LINE 外觀（二）：自己、對方連發兩則、自己
  if (scenario.state.lineDesk) t.relay_send_attachment = { id: '00000000-0000-4000-8000-0000000000d1', attachment_id: '00000000-0000-4000-8000-0000000000d2', name: 'photo.webp', bytes: 120 }   // LINE 電腦版（#1527）：按鈕區送圖片回成功
  if (scenario.state.updDl) { t.update_check = { version: '0.2.99', notes: '下載中改成直角進度條' }; t.update_install = null }   // 下載中（#1526）：有新版、按「更新」後一直停在下載中（進度由探測推事件）
  if (scenario.state.chatMsgs) t.relay_chat_history = { messages: CHAT_MSGS_SAMPLE }   // 對話裡放幾則來回的信（看訊息卡片）
  if (scenario.state.camera) t.relay_send_attachment = { id: '00000000-0000-4000-8000-0000000000c1', attachment_id: '00000000-0000-4000-8000-0000000000c2', name: 'photo.webp', bytes: 120 }   // 拍照（#1490）：送出回成功
  if (scenario.state.multiPhoto) t.relay_send_attachment = { id: '00000000-0000-4000-8000-0000000000b1', attachment_id: '00000000-0000-4000-8000-0000000000b2', name: 'photo.webp', bytes: 120 }   // 一次選多張（#1497）：每一張都回寄出成功
  if (scenario.state.gjump) {   // 群組點成員跳一對一（#1515）：夥伴名單有審稿；群組裡審稿、報表各說一句
    t.relay_list = { members: GJUMP_MEMBERS }
    t.relay_room_read = { messages: GJUMP_MSGS }; t.android_room_read = { messages: GJUMP_MSGS }
  }
  if (scenario.state.photoMsg) { t.relay_chat_history = { messages: PHOTO_ZOOM_MSGS }; t.relay_attachment_fetch = { name: '貓.webp', mime: 'image/webp', data_url: PHOTO_ZOOM_FULL } }   // 看大圖縮放（#1498）
  if (scenario.state.groupMsgs) { t.relay_room_read = { messages: LINE_GROUP_MSGS }; t.android_room_read = { messages: LINE_GROUP_MSGS } }   // 群組裡放對方、自己、系統提示各一則（LINE 外觀看泡泡）
  if (scenario.state.lookPage) t.store_load = { ...t.store_load, values: { ...t.store_load.values, me: JSON.stringify(LINE_LOOK_ME) } }   // 電腦「設定 → 外觀」（存檔的頭像模式／底色是 left／none）
  if (scenario.state.munread) {
    t.relay_list = { members: UNREAD_MEMBERS }
    t.relay_inbox = { messages: unreadMails() }
    t.show_toast = null   // 電腦版收到新信會跳通知
    t.relay_ack = null
    t.relay_read_sync = { marks: [] }
  }
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
  if (scenario.state.mrelease) {
    const rows = v => [{ version: v, date: '', lines: [], platforms: ['官網', 'Play'] }]
    t.site_releases = []
    t.__releasesSeq = [rows('0.0.0'), rows('99.0.0')]
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
    t.__emitOn = { term_view_remote_start: scenario.state.dtermColor ? mtermviewFrames('v1', true) : mtermviewFrames('v1') }
  }
  if (scenario.state.mpermreq) {
    t.relay_list = { members: MBAR_MEMBERS.claude }
    t.store_load = { ...t.store_load, values: { ...t.store_load.values, me: JSON.stringify(MBAR_ME) } }
    t.android_perm_req_list = { requests: scenario.state.permKind ? permDangerRows(scenario.state.permKind) : mpermreqRows(), recent: [] }
    if (scenario.state.permKind) t.android_perm_req_decide = { ok: true, status: 'decided' }
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
  if (scenario.state.taskmgr) {
    t.relay_list = { members: TASKMGR_MEMBERS }
    t.relay_launchers = { machines: [{ node: 'P', online: true, launcher: { profiles: [] } }] }   // 這台開放遠端管理：停止才能按
    t.task_manager_list = taskmgrSnapshot()
    t.term_stop = null   // 假後台：停止「接回中」那一列會呼叫它，參數記在 __smokeCalls
    t.store_load = { ...t.store_load, values: { ...t.store_load.values, me: JSON.stringify(TASKMGR_ME) } }
  }
  if (scenario.state.mroster) { t.android_acct_roster = scenario.state.mroster === 'cards' ? cardsRoster() : ROSTER_GEMINI; t.store_load = { ...t.store_load, values: { ...t.store_load.values, me: JSON.stringify(MROSTER_ME) } } }
  // 探測檔自帶的假後台欄位（#1540）：table(scenario, t) 回傳要蓋上去的欄位，沒有就回 undefined
  t = withProbeTables(t, scenario, PROBES)
  // 外觀「現代」（0.2.18）：存檔裡的外觀（電腦 me.skin、手機 me.mobilePrefs.skin）設成 skin，其他存檔照各情境
  if (scenario.state.skin) {
    const me = JSON.parse(t.store_load?.values?.me ?? '{}')
    t.relay_send = t.relay_send ?? { seq: 1 }   // 現代情境的鍵盤檢查會真的送出一則
    t.store_load = { ...t.store_load, values: { ...t.store_load.values, me: JSON.stringify({ ...me, skin: scenario.state.skin, mobilePrefs: { ...(me.mobilePrefs ?? {}), skin: scenario.state.skin } }) } }
  }
  return t
}

// 注入頁面的腳本（在任何頁面程式之前執行）：假 Tauri
export const injectSource = table => `(() => {
  const T = ${JSON.stringify(table)};
  const missing = (globalThis.__smokeMissing = []);
  // 手機看終端的本人確認（PR③ 的外殼）：表裡的 __confirmViewer＝'ok'／'cancel'／'no_lock'；每次確認都記在 __smokeConfirms
  // 語音輸入（#1536）：表裡的 __dict＝true 就給一個假的通話外殼（還沒允許麥克風：按下去先停在準備中，探測用 __asnCallEvent 送「允許」才開始聽；開始聽之後一直停在聆聽中、不回結果），手機輸入列才會有麥克風
  if (T.__dict) globalThis.AsnAndroid = Object.assign(globalThis.AsnAndroid || {}, { vibrate() {}, callAvailable: () => true, callMicState: () => 'ask', callRequestMic() { (globalThis.__smokeDict ||= []).push('ask') }, callListen() { (globalThis.__smokeDict ||= []).push('listen') }, callStopListen() {}, callEnd() {}, callSpeak() {}, callStopSpeak() {} });
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
      // 版本紀錄（#1501）：表裡的 __releasesSeq 是一串回應，第 n 次讀回第 n 筆（不夠就一直回最後一筆）；__smokeRelReads 記讀了幾次
      if (cmd === 'site_releases' && Array.isArray(T.__releasesSeq)) { const i = globalThis.__smokeRelReads = (globalThis.__smokeRelReads || 0) + 1; return JSON.parse(JSON.stringify(T.__releasesSeq[Math.min(i, T.__releasesSeq.length) - 1])) }
      const ev = T.__emitOn && T.__emitOn[cmd];
      if (Array.isArray(ev)) ev.forEach((e, i) => setTimeout(() => { for (const fn of ((globalThis.__smokeListeners || {})[e.event] || [])) fn({ event: e.event, payload: JSON.parse(JSON.stringify(e.payload)) }) }, 50 * (i + 1)));
      // 探測中途換掉某個指令的回應（例如「剛裝好 Claude，再偵測一次」）：頁面設 globalThis.__smokeOverride = { 指令: 值 }
      if (globalThis.__smokeOverride && Object.prototype.hasOwnProperty.call(globalThis.__smokeOverride, cmd)) return JSON.parse(JSON.stringify(globalThis.__smokeOverride[cmd]));
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

// 截圖前等手機滑頁停下來（#1565）：探測一切到別的分頁就回結果的話，截圖會拍到 0.28 秒轉場的半途，每次停在不同格。
// 停下來＝pager 沒有進行中的動畫、而且已經拿掉 will-change（轉場結束才拿掉）；再等兩格畫面讓內頁重畫到整像素。沒有 pager 的頁面直接過
export const PAGER_SETTLE_WAIT_MS = 3000
export const pagerSettleSource = () => `(async () => {
  const p = document.querySelector('.m-pager');
  if (!p) return { ok: true, why: '' };
  const still = () => !p.getAnimations().length && getComputedStyle(p).willChange === 'auto';
  for (let t = 0; t < ${PAGER_SETTLE_WAIT_MS} && !still(); t += 50) await new Promise(r => setTimeout(r, 50));
  if (!still()) return { ok: false, why: '截圖前滑頁一直沒停下來：' + getComputedStyle(p).willChange + '、動畫 ' + p.getAnimations().length + ' 個' };
  await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
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

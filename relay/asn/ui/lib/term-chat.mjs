// 終端整合進對話視窗（#331）的純邏輯（node 與瀏覽器都能跑）：終端列→名單列、對話視窗輸入區、確認列狀態機、送字時間軸、畫面文字。
// 接線（list.js／list.html／TermPane）不在這裡；這裡只決定「現在能不能送、按了什麼要呼叫哪個後端命令」，由守門測試鎖住。
// 安全規則沿用 term-panel.mjs：只有確認列按「確認送出」才產生 send；只有按「改用手機確認」才產生 offer（不再一開確認就傳手機）；
// 確認列裡有手機請求時，取消、改字、離開這個視窗都會產生 withdraw（後端 #330 只撤送字那筆，不動代答）。
import { sendDraftView, sendConfirmView, sendRequest } from './term-panel.mjs'
import { hueOf, initial } from './text.mjs'

export const TERM_ID_PREFIX = 'term:'
export const termFriendId = id => `${TERM_ID_PREFIX}${id}`
export const isTermFriend = f => typeof f?.id === 'string' && f.id.startsWith(TERM_ID_PREFIX)
/** 名單列的 id → 終端編號；不是終端列回空字串 */
export const termIdOf = fid => (typeof fid === 'string' && fid.startsWith(TERM_ID_PREFIX) ? fid.slice(TERM_ID_PREFIX.length) : '')

// 終端狀態 → 名單的 status（名單只認 online／busy／offline）；等你回答也算 busy，另外用 termBadge 標出來
const ROSTER_STATUS = { idle: 'online', unknown: 'online', busy: 'busy', waiting_user: 'busy' }

/**
 * 終端清單列（term-panel.mjs 的 rowsOf 輸出）→ 名單上的列，掛在自己這台電腦底下。
 * 只放顯示要的欄位；不進「記得的好友」、不上傳、不封存（終端關掉就從名單消失）。
 * engine 用 profile，名單的廠商小圖（vendorBadgeHtml）照常運作。
 */
export function termFriends(rows, { selfNode = '', device = '' } = {}) {
  return (Array.isArray(rows) ? rows : []).filter(r => r && typeof r.id === 'string' && r.id).map(r => {
    const id = termFriendId(r.id)
    const nick = r.folder ? `${r.profile || '終端'}・${r.folder}` : r.title || `終端 #${r.id}`
    return {
      id, termId: r.id, node: selfNode, device, agent: '', nick, psm: r.folder ?? '',
      engine: r.profile || null, entryKind: 'term', onRoster: true, archived: false,
      status: ROSTER_STATUS[r.state] ?? 'online', termState: r.state, termBadge: r.state === 'waiting_user' ? '等你回答' : r.adopted ? '已接手' : '終端',
      adopted: r.adopted === true, hue: hueOf(id), dp: initial(nick),
    }
  })
}

/**
 * 對話視窗下方輸入區的狀態。回 { mode, reason, unlock }：
 * mode＝'locked'（接手的窗格還沒允許代送；unlock＝'send' 給「允許…」按鈕）／'blocked'（暫時不能送，reason 說明）／'ready'。
 * 比終端面板嚴：忙碌時也不能送（#331 安全底線「不在忙碌或等使用者回答時直接送」）。
 */
export function composerView(row) {
  if (!row) return { mode: 'blocked', reason: '找不到這個終端（可能已經關掉）', unlock: '' }
  if (row.adopted === true && row.sendUnlocked !== true) return { mode: 'locked', reason: '這個視窗還沒允許 ASN 代送文字', unlock: 'send' }
  if (row.state === 'waiting_user') return { mode: 'blocked', reason: '終端正在等你回答，請先處理上面的提示', unlock: '' }
  if (row.state === 'busy') return { mode: 'blocked', reason: '終端忙碌中，等它停下來再送', unlock: '' }
  if (!row.cwd) return { mode: 'blocked', reason: '這個終端沒有工作資料夾紀錄，不能代送', unlock: '' }
  return { mode: 'ready', reason: '', unlock: '' }
}

// ---- 確認列狀態機 ----
// phase：idle（沒有確認列）／confirm（確認列出現，等使用者在電腦按）／phone（已傳到手機，等手機或電腦先確認）／sending（已按確認送出，等結果）
// 每個動作回 { state, effects }；effects 只會是下面幾種，接線照順序呼叫：
//   { type: 'offer', req }    → invoke('term_remote_offer_send', { req })
//   { type: 'withdraw', id }  → invoke('term_remote_withdraw', { id })
//   { type: 'send', req }     → term_send（只有 confirm 動作會產生）
export const IDLE = Object.freeze({ phase: 'idle', termId: '', text: '', enter: true, error: '' })

const withdrawIf = s => (s.phase === 'phone' ? [{ type: 'withdraw', id: s.termId }] : [])

/** row：目前的終端列（rowsOf 輸出）；action.type：ask／phone／confirm／cancel／edit／leave／done／failed */
export function confirmReduce(state, action, row) {
  const s = state && typeof state === 'object' ? state : IDLE
  const a = action ?? {}
  switch (a.type) {
    case 'ask': {   // 輸入框按「送出」：只跳確認列，不送、不傳手機
      if (s.phase !== 'idle') return { state: s, effects: [] }
      const text = String(a.text ?? '')
      const enter = a.enter !== false
      if (composerView(row).mode !== 'ready' || !sendDraftView(row, text).ok) return { state: { ...IDLE, error: composerView(row).reason || sendDraftView(row, text).reason }, effects: [] }
      return { state: { phase: 'confirm', termId: row.id, text, enter, error: '' }, effects: [] }
    }
    case 'phone': {   // 確認列按「改用手機確認」：這時才傳到手機
      if (s.phase !== 'confirm' || !row || row.id !== s.termId) return { state: s, effects: [] }
      const req = sendRequest(row, s.text, s.enter)
      if (!req) return { state: { ...IDLE, error: sendDraftView(row, s.text).reason }, effects: [] }
      return { state: { ...s, phase: 'phone' }, effects: [{ type: 'offer', req }] }
    }
    case 'confirm': {   // 確認列按「確認送出」（電腦本機）：唯一會產生 send 的地方；有手機請求時後端 local_confirm_send 會一併作廢
      if ((s.phase !== 'confirm' && s.phase !== 'phone') || !row || row.id !== s.termId) return { state: s, effects: [] }
      if (composerView(row).mode !== 'ready') return { state: { ...IDLE, error: composerView(row).reason }, effects: withdrawIf(s) }
      const req = sendRequest(row, s.text, s.enter)
      if (!req) return { state: { ...IDLE, error: sendDraftView(row, s.text).reason }, effects: withdrawIf(s) }
      return { state: { ...s, phase: 'sending' }, effects: [{ type: 'send', req }] }
    }
    case 'cancel':   // 確認列按「取消」
    case 'edit':     // 確認列出現時又改了輸入框的字：舊的作廢，要重新按送出
    case 'leave':    // 換到別的對話、關掉視窗、終端從清單消失
      if (s.phase === 'idle' || s.phase === 'sending') return { state: s, effects: [] }
      return { state: { ...IDLE }, effects: withdrawIf(s) }
    case 'done':     // 送出成功（本機或手機確認後回報）
      return { state: { ...IDLE }, effects: [] }
    case 'failed':   // 送出失敗、手機拒絕或過期
      return { state: { ...IDLE, error: String(a.error ?? '沒有送出') }, effects: [] }
    default:
      return { state: s, effects: [] }
  }
}

/** 確認列要顯示的內容（沿用終端面板的確認框文字）；phase 是 idle／sending 時回 null */
export function confirmBarView(state, row) {
  if (!state || (state.phase !== 'confirm' && state.phase !== 'phone') || !row || row.id !== state.termId) return null
  const v = sendConfirmView(row, state.text, state.enter)
  if (!v) return null
  return { ...v, preview: state.text.length > 60 ? `${state.text.slice(0, 60)}…` : state.text, waitingPhone: state.phase === 'phone', phoneNote: state.phase === 'phone' ? '已傳到手機，2 分鐘內在手機按確認或拒絕；也可以直接在這裡按確認送出' : '' }
}

// ---- 送字時間軸（只記在本機記憶體，ASN 重開就清掉）----
export const TIMELINE_MAX = 50
const ENTRY_LABEL = { confirm: '等你確認', phone: '等手機確認', sending: '送出中', sent: '已送出', rejected: '手機已拒絕', withdrawn: '已撤回', expired: '已過期', failed: '沒有送出' }
export const entryLabel = st => ENTRY_LABEL[st] ?? ENTRY_LABEL.failed

/** 加一筆（最新的在最後，超過上限丟最舊的）。key 由呼叫端給（例如時間戳＋序號），同 key 不重複加 */
export function timelineAdd(list, { key, at, text, status }) {
  const arr = Array.isArray(list) ? list : []
  if (!key || arr.some(e => e.key === key)) return arr
  const next = [...arr, { key, at: Number(at) || 0, text: String(text ?? '').slice(0, 2000), status: Object.hasOwn(ENTRY_LABEL, status) ? status : 'failed', detail: '' }]
  return next.length > TIMELINE_MAX ? next.slice(next.length - TIMELINE_MAX) : next
}
/** 更新一筆的狀態；找不到 key 就原樣回傳 */
export function timelineSet(list, key, status, detail = '') {
  const arr = Array.isArray(list) ? list : []
  if (!arr.some(e => e.key === key)) return arr
  return arr.map(e => (e.key === key ? { ...e, status: Object.hasOwn(ENTRY_LABEL, status) ? status : 'failed', detail: String(detail ?? '').slice(0, 200) } : e))
}
/** 後台 term_requests.status → 時間軸狀態（migration 20261026400000 的八種；不認得的當 failed） */
const REMOTE_TO_ENTRY = { pending: 'phone', approved: 'sending', taken: 'sending', done: 'sent', denied: 'rejected', cancelled: 'withdrawn', expired: 'expired', failed: 'failed' }
export const remoteStatusToEntry = s => (Object.hasOwn(REMOTE_TO_ENTRY, s) ? REMOTE_TO_ENTRY[s] : 'failed')

// ---- 終端畫面文字（#331 決定 B：只在本機顯示、唯讀；不轉寄、不上傳、不進信件）----
export const SCREEN_LINES = 40
export const SCREEN_MAX = 4000
/** term_read 的原文 → 顯示用純文字：去掉 ANSI 跳脫序列與控制字元（保留換行與 tab）、只留最後 SCREEN_LINES 行、限制字數。畫面用 {{ }} 顯示，不准 v-html */
export function screenText(raw) {
  const t = String(raw ?? '')
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')          // CSI（顏色、游標）
    .replace(/\u001b\][^\u0007\u001b]*(\u0007|\u001b\\)/g, '')   // OSC（標題、超連結）
    .replace(/\u001b[@-_]/g, '')
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '')
  const lines = t.split('\n')
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop()
  const tail = lines.slice(-SCREEN_LINES).join('\n')
  return tail.length > SCREEN_MAX ? tail.slice(tail.length - SCREEN_MAX) : tail
}

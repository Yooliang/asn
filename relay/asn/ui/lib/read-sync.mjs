// 已讀多端同步的純函式（電腦版與手機版共用；設計見 docs/design/READ-SYNC.md）。
// 已讀位置＝該對話「最後一則收到的信」的時間（毫秒，信件自己的時間，不是設備時鐘）；只往前不往後。
// 後台鍵與資料庫的封存鍵同一套寫法：夥伴 ID（p_…）優先，否則「n:節點/名字」，群組「g:群組代號」。

const PARTNER_ID = /^p_[0-9a-f]{20}$/
const ROOM_ID = /^[A-Za-z0-9_-]{1,64}$/
export const READ_KEY_MIN = 3
export const READ_KEY_MAX = 140
export const READ_BATCH = 100        // 一次最多送幾筆（後台上限同為 100）
export const READ_DEBOUNCE_MS = 3000 // 讀過之後等多久才回寫（短時間連讀多位只打一次）

// 對話鍵。好友（夥伴／人／設備）→ 夥伴 ID 或 n:節點/名字；群組 { room } → g:代號。算不出來回 null（不同步）
export function readKey(x) {
  if (!x || typeof x !== 'object') return null
  if (typeof x.room === 'string') return ROOM_ID.test(x.room) ? `g:${x.room}` : null
  if (typeof x.partnerId === 'string' && PARTNER_ID.test(x.partnerId)) return x.partnerId
  const node = typeof x.node === 'string' ? x.node : ''
  const agent = typeof x.agent === 'string' ? x.agent : ''
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(node) || agent.length > 80 || /[\u0000-\u001f\u007f]/.test(agent)) return null
  const k = `n:${node}/${agent}`
  return k.length >= READ_KEY_MIN && k.length <= READ_KEY_MAX ? k : null
}

// 對方傳來的、算「未讀」的記錄：收到的信，以及對方的震動（不含我自己發的震動）
const isIncoming = m => m && (m.k === 'them' || (m.k === 'sys' && m.nudge === true && m.mine !== true)) && Number.isFinite(m.t)

// 該對話最後一則收到的信的時間（毫秒）；沒有回 0
export function lastIncomingAt(log) {
  let at = 0
  for (const m of Array.isArray(log) ? log : []) if (isIncoming(m) && m.t > at) at = m.t
  return at
}

// 已讀位置之後還有幾則收到的信
export function unreadAfter(log, mark) {
  let n = 0
  for (const m of Array.isArray(log) ? log : []) if (isIncoming(m) && m.t > (mark || 0)) n++
  return n
}

// 把後台回的已讀位置整理乾淨（外部資料）：只留 鍵→正整數毫秒
export function cleanMarks(raw) {
  const out = {}
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out
  for (const [k, v] of Object.entries(raw)) {
    if (k.length >= READ_KEY_MIN && k.length <= READ_KEY_MAX && Number.isFinite(v) && v > 0 && v < 4102444800000) out[k] = Math.floor(v)
  }
  return out
}

// 兩邊合併：每個鍵取較大者（只往前）
export function mergeMarks(a, b) {
  const out = { ...cleanMarks(a) }
  for (const [k, v] of Object.entries(cleanMarks(b))) if (!(out[k] >= v)) out[k] = v
  return out
}

// 待送清單 → 一批請求內容 [{key, at}]（最多 READ_BATCH 筆，較新的優先）
export function batchOf(dirty) {
  return Object.entries(cleanMarks(dirty)).sort((x, y) => y[1] - x[1]).slice(0, READ_BATCH).map(([key, at]) => ({ key, at }))
}

// 這次錯誤是不是「後台還不支援」（舊後台對沒見過的動作回 404）
export const readSyncUnsupported = msg => /HTTP 404/.test(String(msg ?? ''))
// 沒登入：Rust 端在打後台之前就回的錯，靜默略過
export const readSyncSignedOut = msg => /尚未登入/.test(String(msg ?? ''))

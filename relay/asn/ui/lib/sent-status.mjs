// 自己寄出訊息的送達／已讀／已回覆狀態（純邏輯，瀏覽器與 node 共用）。
import { fmt } from './text.mjs'

export const STATUS_LABEL = { sent: '已送出', delivered: '已送達', read: '已讀', replied: '已回覆' }

/** 狀態優先序：已回覆 > 已讀 > 已送達 > 已送出 */
export function tierOf(msg) {
  if (!msg || msg.k !== 'me') return null
  if (msg.repliedAt) return 'replied'
  if (msg.ackedAt) return 'read'
  if (msg.deliveredAt) return 'delivered'
  return 'sent'
}

export function statusTip(msg) {
  const tier = tierOf(msg)
  if (!tier) return ''
  const parts = [STATUS_LABEL[tier]]
  const tSent = msg.t
  if (tier === 'sent' && tSent) parts.push(`送出 ${fmt(tSent)}`)
  if (msg.deliveredAt) parts.push(`送達 ${fmt(msg.deliveredAt)}`)
  if (msg.ackedAt) parts.push(`已讀 ${fmt(msg.ackedAt)}`)
  if (msg.repliedAt) parts.push(`回覆 ${fmt(msg.repliedAt)}`)
  return parts.join(' · ')
}

const pick = (v) => (typeof v === 'string' && v ? v : null)

/** 套用 sent_status 單筆；id 須吻合。有變更回 true。 */
export function applyStatusRow(msg, row) {
  if (!msg?.id || !row || row.id !== msg.id) return false
  let changed = false
  const d = pick(row.delivered_at)
  const a = pick(row.acked_at)
  const r = pick(row.replied_at)
  if (d && !msg.deliveredAt) { msg.deliveredAt = d; changed = true }
  if (a && !msg.ackedAt) { msg.ackedAt = a; changed = true }
  if (r && !msg.repliedAt) { msg.repliedAt = r; changed = true }
  return changed
}

/** 是否還值得向後端查（未已讀且未已回覆） */
export function needsPoll(msg, now = Date.now(), maxAgeMs = 7 * 24 * 3600_000) {
  if (!msg?.id || msg.k !== 'me') return false
  if (msg.ackedAt || msg.repliedAt) return false
  const t = typeof msg.t === 'number' ? msg.t : Date.parse(msg.t)
  if (!Number.isFinite(t) || now - t > maxAgeMs) return false
  return true
}

/** 依訊息年齡決定多久查一次：1 小時內 15 秒、1～24 小時 3 分鐘、更久 30 分鐘 */
export function pollEveryMs(ageMs) {
  if (ageMs < 3600_000) return 15_000
  if (ageMs < 24 * 3600_000) return 180_000
  return 1_800_000
}

const msgTime = (m) => (typeof m.t === 'number' ? m.t : Date.parse(m.t))

/** 收這輪要查的 id：needsPoll 為真，且距該 id 上次被查已超過它的間隔（沒記錄的一律收） */
export function collectPollIds(logs, now = Date.now(), lastPolledById = new Map()) {
  const ids = []
  for (const lg of logs.values()) {
    for (const m of lg) {
      if (!needsPoll(m, now)) continue
      const last = lastPolledById.get(m.id)
      if (last !== undefined && now - last < pollEveryMs(now - msgTime(m))) continue
      ids.push(m.id)
    }
  }
  return ids
}

/** 每批最多 50 個 uuid */
export function chunkIds(ids, size = 50) {
  const out = []
  for (let i = 0; i < ids.length; i += size) out.push(ids.slice(i, i + size))
  return out
}

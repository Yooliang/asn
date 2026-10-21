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

export function collectPollIds(logs, now = Date.now()) {
  const ids = []
  for (const lg of logs.values()) {
    for (const m of lg) if (needsPoll(m, now)) ids.push(m.id)
  }
  return ids
}

/** 每批最多 50 個 uuid */
export function chunkIds(ids, size = 50) {
  const out = []
  for (let i = 0; i < ids.length; i += size) out.push(ids.slice(i, i + size))
  return out
}

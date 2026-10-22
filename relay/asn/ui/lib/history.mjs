// 後台往來記錄 → 本機對話記錄的合併（#108，純函式，瀏覽器與 node 共用）。
// 聊天紀錄以後台為準：打開對話時向後台取「我和這位夥伴」90 天內的信，本機的 asn-chats.json 只當快取。
// 合併只「補」本機沒有的信，不改、不刪本機已有的（含系統提示行）；補進來的信不算未讀、不跳提示（人是自己打開對話看的）。
import { normalizePhotos, stripPhotoLines } from './photo.mjs'
import { hasNudge, plain, stripNudge, stripReplyHead, unwrapShell } from './text.mjs'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const str = v => (typeof v === 'string' && v ? v : null)

// 整理後台一則（外部資料，格式不對回 null）：{ id, fanoutId, ids, dir, body, t, deliveredAt, ackedAt, photos, replyTo, fromNode, fromName }
// fanoutId＝扇出回信的群組 id（同一個 fanout_id 只算一則）；fromNode／fromName＝真實寄出的節點與設備名（自己寄的信用來標「從 Oppo 手機」）
export function cleanRow(r) {
  if (!r || typeof r !== 'object' || !UUID.test(String(r.id ?? ''))) return null
  if (r.dir !== 'me' && r.dir !== 'them') return null
  if (typeof r.body !== 'string') return null
  const t = Date.parse(r.created_at)
  if (!Number.isFinite(t)) return null
  const fanoutId = UUID.test(String(r.fanout_id ?? '')) ? r.fanout_id : null
  const ids = [r.id, ...(fanoutId ? [fanoutId] : []), ...(Array.isArray(r.ids) ? r.ids : [])].filter(i => UUID.test(String(i)))
  const name = typeof r.from_node_name === 'string' ? r.from_node_name.replace(/\s+/g, ' ').trim().slice(0, 40) : ''
  return { id: r.id, fanoutId, fromNode: str(r.from_node), fromName: name, ids: [...new Set(ids)], dir: r.dir, body: r.body, t, deliveredAt: str(r.delivered_at), ackedAt: str(r.acked_at), photos: normalizePhotos(r.attachments), replyTo: str(r.reply_to) }
}

// 後台一則 → 本機對話記錄的一列（或兩列：震動只留系統提示）。friendNick＝對方暱稱（震動提示用）
// from＝自己寄的信、寄出設備不是目前這台時的設備名（畫面標「從 …」）；目前這台寄的、或對方寄來的不標
export function entriesOf(row, friendNick = '', from = '') {
  const body = row.dir === 'them' ? stripReplyHead(unwrapShell(row.body)) : row.body
  const nudge = hasNudge(body)
  const text = stripPhotoLines(nudge ? stripNudge(body) : body, row.photos.length)
  const out = []
  const rid = row.fanoutId ?? row.id
  if (text || row.photos.length) {
    const e = { k: row.dir, text, t: row.t, id: rid }   // 記錄用的 id 與收信一致（扇出回信＝群組 id）
    if (row.photos.length) e.photos = row.photos
    if (row.dir === 'me') {
      if (row.deliveredAt) e.deliveredAt = row.deliveredAt
      if (row.ackedAt) e.ackedAt = row.ackedAt
      if (from) e.from = from
    }
    out.push(e)
  }
  if (nudge) out.push(row.dir === 'me' ? { k: 'sys', nudge: true, mine: true, rid, text: '你已傳送震動。', t: row.t } : { k: 'sys', nudge: true, rid, text: `${plain(friendNick)} 傳送了一個震動。`, t: row.t })
  return out
}

// 這則自己寄的信要標的設備名：寄出節點不是這台（selfNode）才有；名字優先用名單的（deviceOf），沒有再用後台帶的，都沒有就籠統說「另一台設備」
export function fromDeviceOf(row, selfNode, deviceOf) {
  if (row.dir !== 'me' || !row.fromNode || !selfNode || row.fromNode === selfNode) return ''
  return (typeof deviceOf === 'function' ? String(deviceOf(row.fromNode) ?? '').trim() : '') || row.fromName || '另一台設備'
}

// 把後台的信補進本機記錄：本機已有同一則（任何一個複本 id、或同一個 fanout_id）就略過，本機那則優先；後台一次回多列同 fanout_id 也只收一則。
// 回 { log, added }；log 依時間排好（穩定排序，同時間維持原順序）。selfNode／deviceOf 用來標「從哪台設備寄出」
export function mergeHistory(log, rows, friendNick = '', { selfNode = '', deviceOf = null } = {}) {
  const have = new Set()
  for (const m of log) { if (m?.id) have.add(m.id); if (m?.rid) have.add(m.rid) }   // rid＝震動提示列帶的信件 id（它自己沒有文字列可比對）
  const fresh = []
  for (const raw of Array.isArray(rows) ? rows : []) {
    const row = cleanRow(raw)
    if (!row || row.ids.some(i => have.has(i))) continue
    row.ids.forEach(i => have.add(i))
    fresh.push(...entriesOf(row, friendNick, fromDeviceOf(row, selfNode, deviceOf)))
  }
  if (!fresh.length) return { log, added: 0 }
  const merged = [...log, ...fresh]
  merged.sort((a, b) => (a.t ?? 0) - (b.t ?? 0))
  return { log: merged, added: fresh.length }
}

// 後台不支援（還沒部署）的錯誤：之後這次執行不再問。沒登入／連不上不算，下次打開對話再試
export const historyUnsupported = msg => /HTTP (404|400)\b/.test(String(msg ?? ''))

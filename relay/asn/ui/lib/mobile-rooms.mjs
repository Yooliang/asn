// 手機版「群組對話」的純邏輯：名單分組的列、對話分頁用的假夥伴、訊息轉成對話記錄、用哪個身分發言、錯誤文字。
// 群組列表來自 Rust 的 relay_rooms（node 金鑰、限成員），訊息來自 android_room_read，發言走 android_room_post（要本人簽章）。
// node 與瀏覽器都能跑，不碰 DOM、不碰 Tauri。給人看的文字純繁體中文，不顯示節點代號與群組代號。

export const ROOM_PREFIX = 'room:'
export const ROOM_GROUP_KEY = 'rooms'
export const ROOM_GROUP_LABEL = '群組對話'
export const ROOM_POLL_MS = 60_000
export const ROOM_FIRST_LOAD = 50        // 第一次打開一個群組，讀最近幾則
export const ROOM_KEEP = 300             // 畫面上最多留幾則
export const ROOM_BODY_MAX = 20_000

// 對話分頁記的「最後使用」可以是夥伴 id，也可以是 room:<群組代號>
export const roomChatId = id => `${ROOM_PREFIX}${id}`
export const isRoomChat = id => typeof id === 'string' && id.startsWith(ROOM_PREFIX) && id.length > ROOM_PREFIX.length
export const roomIdOf = chatId => (isRoomChat(chatId) ? chatId.slice(ROOM_PREFIX.length) : '')

const oneLine = (s, n) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n)
const memberList = r => (Array.isArray(r?.mine) ? r.mine : [])
// 這個群組裡「我」的未讀（我的各個成員身分加總）
export const roomUnread = r => memberList(r).reduce((n, m) => n + (Number.isInteger(m?.unread) && m.unread > 0 ? m.unread : 0), 0)

// 名單上的群組列：最近有動靜的在前；搜尋字比對群組名
export function roomItems(rooms, { query = '', plainText = s => s } = {}) {
  const q = String(query ?? '').trim().toLowerCase()
  const rows = []
  for (const r of Array.isArray(rooms) ? rooms : []) {
    if (!r || typeof r.id !== 'string') continue
    const name = String(r.name || '未命名的群組')
    if (q && !plainText(name).toLowerCase().includes(q)) continue
    const count = Array.isArray(r.members) ? r.members.length : memberList(r).length
    rows.push({
      id: r.id, chatId: roomChatId(r.id), name, count, unread: roomUnread(r), lastSeq: Number.isInteger(r.last_seq) ? r.last_seq : 0,
      last: r.last_body ? `${r.last_from_name ? `${r.last_from_name}：` : ''}${oneLine(r.last_body, 40)}` : '',
      at: Date.parse(r.last_at ?? r.created_at) || 0,
    })
  }
  return rows.sort((a, b) => b.at - a.at)
}

// 總未讀 ＝ 夥伴未讀 ＋ 群組未讀
export const totalUnreadWithRooms = (friendsUnread, rooms) => (Number.isInteger(friendsUnread) ? friendsUnread : 0) + roomItems(rooms).reduce((n, r) => n + r.unread, 0)

// 用哪個成員身分發言／讀取：優先「本機節點~這支手機的視窗名」，其次整個節點，再其次這個節點底下任一身分。
// 回 { key, agent }：agent 空字串＝以節點本身發言
export function memberIdentity(room, selfNode, windowName) {
  const keys = memberList(room).map(m => m?.member).filter(k => typeof k === 'string')
  const own = k => k === selfNode || k.startsWith(`${selfNode}~`)
  const pick = keys.find(k => k === `${selfNode}~${windowName}`) ?? keys.find(k => k === selfNode) ?? keys.find(own) ?? ''
  if (!pick) return { key: '', agent: '' }
  return { key: pick, agent: pick === selfNode ? '' : pick.slice(selfNode.length + 1) }
}

// 對話分頁用的假夥伴：沿用 ChatPane，群組標頭顯示群組名與人數
export function roomPseudoFriend(row) {
  return { id: row.chatId, nick: row.name, psm: `${row.count} 位成員`, status: 'online', room: true, group: true, node: '', device: '', agent: '', hue: 205, dp: row.name.slice(0, 1), unread: 0 }
}

// 後台的訊息 → 對話記錄（ChatPane 的格式）。自己的成員身分發的算 me；who＝每則上的發言者名字
const fromLabel = m => {
  const n = typeof m?.from_name === 'string' ? m.from_name.trim() : ''
  if (n) return n
  const f = typeof m?.from === 'string' ? m.from : ''
  if (f === '~owner') return '帳號擁有者'
  const i = f.indexOf('~')
  return i >= 0 ? f.slice(i + 1) : f
}
export function roomLog(messages, myKeys) {
  const mine = new Set(myKeys ?? [])
  const out = []
  for (const m of Array.isArray(messages) ? messages : []) {
    if (!m || !Number.isInteger(m.seq)) continue
    const att = Array.isArray(m.attachments) ? m.attachments.map(a => String(a?.name ?? '').trim()).filter(Boolean) : []
    const text = [String(m.body ?? ''), ...att.map(n => `（附件：${n}，請用電腦版查看）`)].filter(Boolean).join('\n')
    const isMe = mine.has(m.from)
    out.push({ k: isMe ? 'me' : 'them', who: isMe ? '' : fromLabel(m), text, t: Date.parse(m.at) || 0, id: `room-${m.seq}`, seq: m.seq })
  }
  return out
}
// 合併新讀到的與已有的（依序號去重、排序、只留最近 ROOM_KEEP 則）
export function mergeRoomLog(oldLog, incoming) {
  const bySeq = new Map()
  for (const e of [...(oldLog ?? []), ...(incoming ?? [])]) bySeq.set(e.seq, e)
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq).slice(-ROOM_KEEP)
}
export const roomTopSeq = log => (log?.length ? log[log.length - 1].seq : 0)
// 該從哪一則之後讀：已有記錄就接著讀；第一次只讀最近 ROOM_FIRST_LOAD 則
export const readSince = (log, lastSeq) => (log?.length ? roomTopSeq(log) : Math.max(0, (Number.isInteger(lastSeq) ? lastSeq : 0) - ROOM_FIRST_LOAD))
// 要不要去讀：後台的最後序號比畫面上多
export const needsRead = (log, lastSeq) => (Number.isInteger(lastSeq) ? lastSeq : 0) > roomTopSeq(log)

// 發言前的檢查；回空字串＝可以送
export function postError(text, { signedIn, identity }) {
  const t = String(text ?? '')
  if (!t.trim()) return '請先輸入內容。'
  if (t.length > ROOM_BODY_MAX) return `訊息太長，最多 ${ROOM_BODY_MAX} 字。`
  if (!signedIn) return '要先登入，才能在群組發言。'
  if (!identity?.key) return '這支手機不在這個群組裡，沒辦法發言。'
  return ''
}

// 後台與 Rust 回來的錯誤 → 中文（不顯示原始代碼）
export function roomErrorText(msg) {
  const s = String(msg ?? '')
  if (/尚未登入/.test(s)) return '要先登入，才能在群組發言。'
  if (/rate_limited|HTTP 429/.test(s)) return '發言太頻繁了（每小時有上限），晚點再試。'
  if (/not_member|HTTP 403|forbidden|unknown_agent/.test(s)) return '你已經不在這個群組裡，沒辦法發言。'
  if (/HTTP 404|not_found/.test(s)) return '找不到這個群組。'
  if (/連線失敗|timeout|逾時/.test(s)) return '連不上收發室，請檢查網路。'
  return '群組暫時無法使用，晚點再試。'
}
export const ROOM_EMPTY_TEXT = '目前不在任何群組。'
export const ROOM_LOAD_FAIL_TEXT = '讀不到群組，晚點再試。'

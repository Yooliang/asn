// 對話名單的「釘選」（純邏輯，node 與瀏覽器共用，不碰 DOM）。全部回新物件，不改傳進來的那份。
// 存的格式就是之後帳號層同步要用的那一份：{ pins: [{ id, at }], unpinned: [{ id, at }], rev }
//   - id：一對一用夥伴位址（節點/視窗名，可含中文與空白），群組用 room:<群組代號>
//   - at：釘選（或取消釘選）當下的毫秒時間；釘選的排序用它，合併兩份時也看它
//   - unpinned：取消釘選的紀錄，合併時才知道「這個 id 是被取消的，不是沒釘過」
//   - rev：每改一次加一
// 同一個 id 只會在 pins 或 unpinned 其中一邊（normalize 會收斂）。

export const MAX_PINS = 50
export const MAX_UNPINNED = 200   // 取消紀錄只留最近的這麼多筆，免得越存越大
export const MAX_ID_LEN = 200     // 跟「最後使用的對話」同一個上限
export const PIN_LIMIT_TEXT = `最多只能釘選 ${MAX_PINS} 個對話，請先取消一些再釘選。`
export const EMPTY_PINS = Object.freeze({ pins: Object.freeze([]), unpinned: Object.freeze([]), rev: 0 })

// 對話位址：任何非空字串（夥伴名字可含中文、空白，不能比名單本身更嚴）；只擋空字串、控制字元、過長
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f]/
export const validChatId = id => typeof id === 'string' && id.length > 0 && id.length <= MAX_ID_LEN && !CONTROL_RE.test(id)
const validAt = at => typeof at === 'number' && Number.isFinite(at) && at > 0
const revOf = v => (Number.isInteger(v) && v >= 0 ? v : 0)

// 一筆 { id, at }：壞資料回 null
function entryOf(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  if (!validChatId(raw.id) || !validAt(raw.at)) return null
  return { id: raw.id, at: Math.floor(raw.at) }
}

// 同一個 id 的兩邊：at 比較新的贏；at 相同釘選勝
function settle(pinAt, unpinAt) {
  if (pinAt === undefined) return 'unpin'
  if (unpinAt === undefined) return 'pin'
  return pinAt >= unpinAt ? 'pin' : 'unpin'
}

/** 讀回存檔／收到的資料：壞資料、重複 id、不合法的時間都容錯；超過上限留釘得最早的 */
export function normalizePins(raw) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const pinAt = new Map()
  const unpinAt = new Map()
  const fold = (list, into) => {
    for (const r of Array.isArray(list) ? list : []) {
      const e = entryOf(r)
      if (!e) continue
      const old = into.get(e.id)
      if (old === undefined || e.at > old) into.set(e.id, e.at)   // 重複 id：留較新的
    }
  }
  fold(src.pins, pinAt)
  fold(src.unpinned, unpinAt)
  const pins = []
  const unpinned = []
  for (const id of new Set([...pinAt.keys(), ...unpinAt.keys()])) {
    if (settle(pinAt.get(id), unpinAt.get(id)) === 'pin') pins.push({ id, at: pinAt.get(id) })
    else unpinned.push({ id, at: unpinAt.get(id) })
  }
  pins.sort((a, b) => a.at - b.at)
  unpinned.sort((a, b) => b.at - a.at)
  return { pins: pins.slice(0, MAX_PINS), unpinned: unpinned.slice(0, MAX_UNPINNED), rev: revOf(src.rev) }
}

export const isPinned = (state, id) => Boolean(validChatId(id) && state?.pins?.some(p => p.id === id))
export const pinCount = state => (Array.isArray(state?.pins) ? state.pins.length : 0)

/** 釘選：回 { ok, state, text }。已經釘了就原樣回；滿 50 個拒絕並給提示字；id 不合法也拒絕 */
export function pinChat(state, id, at = Date.now()) {
  const cur = normalizePins(state)
  if (!validChatId(id)) return { ok: false, state: cur, text: '這個對話釘不了。' }
  if (isPinned(cur, id)) return { ok: true, state: cur, text: '' }
  if (cur.pins.length >= MAX_PINS) return { ok: false, state: cur, text: PIN_LIMIT_TEXT }
  const when = validAt(at) ? Math.floor(at) : Date.now()
  const next = { pins: [...cur.pins, { id, at: when }], unpinned: cur.unpinned.filter(u => u.id !== id), rev: cur.rev + 1 }
  return { ok: true, state: normalizePins(next), text: '' }
}

/** 取消釘選：留一筆取消紀錄（同步合併用）。本來就沒釘也記一筆，方便另一台之後蓋掉舊的釘選 */
export function unpinChat(state, id, at = Date.now()) {
  const cur = normalizePins(state)
  if (!validChatId(id)) return cur
  const when = validAt(at) ? Math.floor(at) : Date.now()
  return normalizePins({ pins: cur.pins.filter(p => p.id !== id), unpinned: [{ id, at: when }, ...cur.unpinned.filter(u => u.id !== id)], rev: cur.rev + 1 })
}

/** 選單按「釘選／取消釘選」：回 { ok, state, text, pinned }（pinned＝按完之後是不是釘著） */
export function togglePin(state, id, at = Date.now()) {
  if (isPinned(state, id)) return { ok: true, state: unpinChat(state, id, at), text: '', pinned: false }
  const r = pinChat(state, id, at)
  return { ...r, pinned: r.ok }
}
export const pinMenuLabel = (state, id) => (isPinned(state, id) ? '取消釘選' : '釘選')

/** 排序：釘選的排最上面，依釘選時間由舊到新；其餘維持傳進來的順序。idOf 取一列的對話位址 */
export function sortPinned(rows, state, idOf = r => r?.id) {
  const list = Array.isArray(rows) ? rows : []
  const at = new Map((state?.pins ?? []).map(p => [p.id, p.at]))
  const pinned = list.filter(r => at.has(idOf(r))).sort((a, b) => at.get(idOf(a)) - at.get(idOf(b)))
  return [...pinned, ...list.filter(r => !at.has(idOf(r)))]
}
/** 只取釘選的那幾列（手機最上面的「釘選」組）：依釘選時間由舊到新 */
export const pinnedRows = (rows, state, idOf = r => r?.id) => sortPinned(rows, state, idOf).filter(r => isPinned(state, idOf(r)))

/**
 * 釘選對得到的對話：依釘選時間由早到晚，每筆 { id, friend } 或 { id, room }。
 * friends 請傳「沒封存」的夥伴（封存優先：已封存的就算釘選了也不顯示，但釘選紀錄照留，解除封存後自然回到最上面）；
 * 夥伴與群組都找不到的（夥伴已不在名單、群組已退出）也不列，紀錄一樣留著。
 */
export function pinnedTargets(state, friends, rooms) {
  const fr = new Map((Array.isArray(friends) ? friends : []).map(f => [f.id, f]))
  const rm = new Map((Array.isArray(rooms) ? rooms : []).map(r => [r.chatId, r]))
  const out = []
  for (const p of state?.pins ?? []) {
    const friend = fr.get(p.id), room = rm.get(p.id)
    if (friend) out.push({ id: p.id, friend })
    else if (room) out.push({ id: p.id, room })
  }
  return out
}

/** 合併兩份（本機與帳號層）：同一個 id 看 pins／unpinned 誰的 at 新，at 相同釘選勝；rev 取大的再加一 */
export function mergePins(a, b) {
  const x = normalizePins(a)
  const y = normalizePins(b)
  return normalizePins({ pins: [...x.pins, ...y.pins], unpinned: [...x.unpinned, ...y.unpinned], rev: Math.max(x.rev, y.rev) + 1 })
}

/** 夥伴改名：舊位址的釘選搬到新位址（釘選時間不變），舊位址留一筆取消紀錄。舊位址沒釘就原樣回 */
export function renamedChatId(state, from, to, at = Date.now()) {
  const cur = normalizePins(state)
  if (from === to || !validChatId(to)) return cur
  const old = cur.pins.find(p => p.id === from)
  if (!old) return cur
  const when = validAt(at) ? Math.floor(at) : Date.now()
  return normalizePins({
    pins: [...cur.pins.filter(p => p.id !== from && p.id !== to), { id: to, at: old.at }],
    unpinned: [{ id: from, at: when }, ...cur.unpinned.filter(u => u.id !== from && u.id !== to)],
    rev: cur.rev + 1,
  })
}

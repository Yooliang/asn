// 橋的「回覆對應表」持久化（WORK_DIR/pending.json）。橋重啟後，已轉交、還在等或已通知「沒回」的信仍對得上回覆。
// 只存轉回覆需要的最小欄位（信件 id、寄件節點／視窗、收件視窗、時間、狀態、群組資訊），不存信件內文。
// 純函式＋檔案讀寫，不依賴橋本身；檔案損毀或欄位怪異時安全忽略（回傳空狀態）。
import fs from 'node:fs'

const VERSION = 1
const STATES = new Set(['waiting', 'notified'])   // forwarding 沒有轉交完成，重啟後由 inbox 重送；done 不用留
const str = v => typeof v === 'string'
const num = v => typeof v === 'number' && Number.isFinite(v)

export function toRecord(p) {
  return {
    id: p.mail.id, from_node: p.mail.from_node ?? '', from_agent: p.mail.from_agent ?? '', target: p.target,
    state: p.state, t0: p.t0, t: p.t, noReply: !!p.noReply, replied: !!p.replied, nudged: !!p.nudged, notifiedAt: p.notifiedAt ?? null,
    room: p.room ? { id: p.room.id, seq: p.room.seq, window: p.room.window ?? null } : null,
  }
}

export function snapshot(pending, lastRequester) {
  const items = []
  for (const p of pending.values()) if (STATES.has(p.state)) items.push(toRecord(p))
  return { version: VERSION, pending: items, lastRequester: { ...lastRequester } }
}

function fromRecord(r) {
  if (!r || !str(r.id) || !str(r.target) || !STATES.has(r.state) || !num(r.t0) || !num(r.t)) return null
  if (r.state === 'notified' && !num(r.notifiedAt)) return null
  const room = r.room && str(r.room.id) && num(r.room.seq) ? { id: r.room.id, seq: r.room.seq, window: str(r.room.window) ? r.room.window : undefined } : null
  const p = {
    mail: { id: r.id, from_node: str(r.from_node) ? r.from_node : '', from_agent: str(r.from_agent) ? r.from_agent : '' },
    target: r.target, state: r.state, t0: r.t0, t: r.t, noReply: !!r.noReply, replied: !!r.replied,
  }
  if (r.nudged) p.nudged = true
  if (r.state === 'notified') p.notifiedAt = r.notifiedAt
  if (room) p.room = room
  return p
}

const expired = (p, now, keepMs) => now - (p.state === 'notified' ? p.notifiedAt : p.t0) > keepMs

// 讀檔＋清過期。回傳 { pending: [[id, p]...], lastRequester, dropped, error }
export function loadState(file, now, keepMs) {
  const empty = { pending: [], lastRequester: {}, dropped: 0, error: null }
  let raw
  try { raw = fs.readFileSync(file, 'utf8') } catch (e) { return e.code === 'ENOENT' ? empty : { ...empty, error: e.message } }
  let data
  try { data = JSON.parse(raw) } catch (e) { return { ...empty, error: `JSON 損毀：${e.message}` } }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return { ...empty, error: '格式不符' }
  let dropped = 0
  const pending = []
  for (const r of Array.isArray(data.pending) ? data.pending : []) {
    const p = fromRecord(r)
    if (!p || expired(p, now, keepMs)) { dropped++; continue }
    pending.push([p.mail.id, p])
  }
  const lastRequester = {}
  const lr = data.lastRequester && typeof data.lastRequester === 'object' ? data.lastRequester : {}
  for (const [target, v] of Object.entries(lr)) {
    if (v && str(v.from_node) && str(v.mail_id) && num(v.t) && now - v.t <= keepMs) lastRequester[target] = { from_node: v.from_node, from_agent: str(v.from_agent) ? v.from_agent : '', mail_id: v.mail_id, t: v.t }
    else dropped++
  }
  return { pending, lastRequester, dropped, error: null }
}

// 原子寫入：先寫暫存檔再 rename，不會留下寫一半的 pending.json
export function saveAtomic(file, data) {
  const tmp = `${file}.${process.pid}.tmp`
  try {
    fs.writeFileSync(tmp, JSON.stringify(data))
    fs.renameSync(tmp, file)
  } catch (e) {
    try { fs.unlinkSync(tmp) } catch {}
    throw e
  }
}

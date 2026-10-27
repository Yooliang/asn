// 群組對話的資料中樞（電腦版與手機版共用）：群組列表、各群組的對話記錄、待主持人確認的卡片、發言與同意／拒絕。
// 不碰 DOM；後台的呼叫經 invoke（Rust 指令）與 groupApi。發言與主持人確認都要本人簽章，由 Rust 端帶憑證，這裡拿不到。
// reactive 由頁面帶進來（Vue 的 reactive），測試用預設的原物件。
import { confirmCards } from './groups.mjs'
import { ROOM_FIRST_LOAD, ROOM_LOAD_FAIL_TEXT, applyReads, applyWakes, hasPendingReads, hasPendingWakes, mergeRoomLog, memberIdentity, needsRead, postError, readSince, roomErrorText, roomItems, roomLog } from './mobile-rooms.mjs'
import { groupErrorText } from './groups.mjs'

export function createRoomHub({ invoke, groupApi, selfNode, windowName, readCmd = 'relay_room_read', postCmd = 'relay_room_post', attachCmd = 'relay_send_attachment', photos = false, visible = () => true, now = () => Date.now(), reactive = x => x }) {
  const st = reactive({ rooms: [], loaded: false, err: false, logs: {}, cards: {}, note: '', deciding: false })
  const raw = id => st.rooms.find(r => r?.id === id) ?? null
  const rows = (opts = {}) => roomItems(st.rooms, opts)
  const rowOf = id => rows().find(r => r.id === id) ?? null
  const identityOf = id => memberIdentity(raw(id), selfNode, windowName)

  async function refresh() {
    try {
      const r = await invoke('relay_rooms')
      st.rooms = Array.isArray(r?.rooms) ? r.rooms : []
      st.err = false; st.loaded = true
    } catch { st.err = true }
    return st.rooms
  }

  let reading = new Set()
  let noWakes = false
  // 讀一個群組的新訊息（第一次讀最近 ROOM_FIRST_LOAD 則）；回 true＝有新資料
  async function read(id, { force = false } = {}) {
    const room = raw(id), row = rowOf(id)
    if (!room || !row || reading.has(id)) return false
    const ident = identityOf(id)
    if (!ident.key) { st.note = '這個群組裡沒有你的身分，沒辦法讀取。'; return false }
    const log = st.logs[id] ?? []
    const first = !log.length
    const unread = row.unread > 0
    if (!first && !force && !needsRead(log, row.lastSeq) && !unread) return await refreshReceipts(id, ident, log)
    reading.add(id)
    try {
      // 後台只在讀到新訊息時才標已讀：未讀還在就多讀最後一則
      const since = unread && !first ? Math.max(0, readSince(log, row.lastSeq) - 1) : readSince(log, row.lastSeq)
      const r = await invoke(readCmd, { room: id, agent: ident.agent || null, since, limit: first ? ROOM_FIRST_LOAD : 200, mark: visible() })
      const mine = (room.mine ?? []).map(m => m?.member)
      st.logs[id] = applyWakes(applyReads(mergeRoomLog(log, roomLog(r?.messages, mine, room.members, { photos })), r?.reads), r?.wakes)
      if (visible()) for (const m of room.mine ?? []) if (m.member === ident.key) m.unread = 0
      st.note = ''
      return true
    } catch (e) { st.note = roomErrorText(e?.message) || ROOM_LOAD_FAIL_TEXT; return false } finally { reading.delete(id) }
  }

  // 沒有新訊息時：自己發的訊息還有人沒讀，就問一次後台「已讀 N」有沒有變（不標已讀、只讀最後一則之後＝不會有訊息內容）
  // 同一次呼叫也補晚到的叫醒順序（最近 10 分鐘內發出、還沒有順序的訊息）；後台只回已存的結果，不會重新排序
  async function refreshReceipts(id, ident, log) {
    const wakeWait = !noWakes && hasPendingWakes(log, now())
    if (!hasPendingReads(log) && !wakeWait) return false
    try {
      const r = await invoke(readCmd, { room: id, agent: ident.agent || null, since: log[log.length - 1].seq, limit: 1, mark: false })
      if (wakeWait && !Array.isArray(r?.wakes)) noWakes = true   // 舊後台沒有這個欄位：不再為順序而問
      const cur = st.logs[id] ?? log
      const next = applyWakes(applyReads(cur, r?.reads), r?.wakes)
      if (next !== cur) { st.logs[id] = next; return true }
    } catch { /* 舊後台或暫時連不上：維持原樣 */ }
    return false
  }

  async function loadCards(id) {
    if (!raw(id)) return
    try { const r = await groupApi.confirmList(id); st.cards[id] = confirmCards(r?.confirms) } catch { /* 舊後台沒有這個動作：不顯示卡片 */ }
  }

  // 打開一個群組：讀訊息與確認卡片
  async function open(id) { await refresh(); await Promise.all([read(id, { force: true }), loadCards(id)]) }

  async function post(id, text, opts = {}) {
    const ident = identityOf(id)
    const err = postError(text, { signedIn: true, identity: ident })
    if (err) { st.note = err; return false }
    try {
      const reply = Number.isInteger(opts?.replySeq) && opts.replySeq > 0 ? { reply_to: opts.replySeq } : {}   // 回覆某則訊息：後台記下引用並自動 @ 原作者
      await invoke(postCmd, { body: { room: id, body: text, ...(ident.agent ? { from_agent: ident.agent } : {}), ...reply } })
      st.note = ''
      await refresh(); await read(id, { force: true })
      return true
    } catch (e) { st.note = roomErrorText(e?.message); return false }
  }

  // 在群組傳照片或檔案：Rust 端上傳後以本人簽章發言（附件編號由 Rust 填，前端不能自填）
  async function postAttachment(id, item, caption = '') {
    const ident = identityOf(id)
    const err = postError('附件', { signedIn: true, identity: ident })
    if (err) { st.note = err; return false }
    if (!item?.data) { st.note = '沒有內容'; return false }
    try {
      await invoke(attachCmd, { payload: { room: id, ...(ident.agent ? { from_agent: ident.agent } : {}), kind: item.kind === 'file' ? 'file' : 'image', caption: String(caption ?? '').trim(), name: item.name, data: item.data, width: item.width, height: item.height, thumb: item.thumb || undefined } })
      st.note = ''
      await refresh(); await read(id, { force: true })
      return true
    } catch (e) { st.note = roomErrorText(e?.message); return false }
  }

  // 主持人按「同意」「拒絕」：後台用本人簽章核對，不是主持人或沒簽章會被擋
  async function decide(id, cardId, approve) {
    if (st.deciding) return false
    st.deciding = true
    try {
      await groupApi.confirmDecide(id, cardId, approve === true)
      st.note = ''
      await Promise.all([loadCards(id), read(id, { force: true })])
      return true
    } catch (e) { st.note = groupErrorText(e?.message); await loadCards(id); return false } finally { st.deciding = false }
  }

  return { st, raw, rows, rowOf, identityOf, refresh, read, loadCards, open, post, postAttachment, decide }
}
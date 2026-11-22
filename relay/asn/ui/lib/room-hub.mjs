// 群組對話的資料中樞（電腦版與手機版共用）：群組列表、各群組的對話記錄、待主持人確認的卡片、發言與同意／拒絕。
// 不碰 DOM；後台的呼叫經 invoke（Rust 指令）與 groupApi。發言與主持人確認都要本人簽章，由 Rust 端帶憑證，這裡拿不到。
// reactive 由頁面帶進來（Vue 的 reactive），測試用預設的原物件。
import { confirmCards } from './groups.mjs'
import { ROOM_BACK_MAX, ROOM_FIRST_LOAD, ROOM_KEEP_MAX, ROOM_LOAD_FAIL_TEXT, applyReads, applyWakes, hasPendingReads, hasPendingWakes, mergeRoomLog, memberIdentity, needsRead, postError, readSince, roomErrorText, roomItems, roomLog } from './mobile-rooms.mjs'
import { groupErrorText } from './groups.mjs'
import { offlineNames } from './group-offline.mjs'
import { makeRoomApi } from './tauri.mjs'

// 後台回的 unmatched：內文裡 @ 了但對不到任何群組成員的名字；舊後台沒有這個欄位＝空。回要顯示的一句話（沒有就空字串）
export function unmatchedText(r) {
  const names = (Array.isArray(r?.unmatched) ? r.unmatched : []).map(n => (typeof n === 'string' ? n.trim() : '')).filter(Boolean)
  if (!names.length) return ''
  return `${names.join('、')} 不在這個群組，這則沒有點到${names.length > 1 ? '他們' : '他'}。`
}

// visible(群組代號)：使用者現在正在看這個群組嗎（可回 Promise）；沒指定 mark 的讀取只有看著的那個才標已讀
export function createRoomHub({ invoke, groupApi, selfNode, windowName, readCmd = 'relay_room_read', postCmd = 'relay_room_post', attachCmd = 'relay_send_attachment', photos = false, visible = () => true, now = () => Date.now(), reactive = x => x, onRooms = () => {}, onFail = () => {} }) {
  const api = makeRoomApi(invoke, { readCmd, postCmd, attachCmd })   // 後端呼叫一律走 tauri.mjs 的具名出口；invoke 仍可注入（測試用）
  const st = reactive({ rooms: [], loaded: false, err: false, signed: true, logs: {}, cards: {}, note: '', deciding: false, notices: {} })
  const raw = id => st.rooms.find(r => r?.id === id) ?? null
  // 目前離線的成員鍵（叫醒順序標籤把離線的畫灰色加「離線」，#1656）；讀不到成員就是空集合
  const offlineKeysOf = room => new Set(offlineNames(room?.members).map(n => n.key))
  const rows = (opts = {}) => roomItems(st.rooms, opts)
  const rowOf = id => rows().find(r => r.id === id) ?? null
  const identityOf = id => memberIdentity(raw(id), selfNode, windowName)

  async function refresh() {
    try {
      const r = await api.rooms()
      st.rooms = Array.isArray(r?.rooms) ? r.rooms : []
      st.err = false; st.loaded = true
      st.signed = r?.signed !== false   // 沒帶本人簽章（登入失效）：後台只回得出這台的群組，畫面要在原位說一句（#1764）
      try { onRooms(r) } catch { console.warn('[ASN]', '群組提醒條（onRooms）出錯，不影響群組本身') }
    } catch (e) { st.err = true; try { onFail(e) } catch { console.warn('[ASN]', '群組失敗回呼（onFail）出錯，群組維持失敗狀態') } }
    return st.rooms
  }

  let reading = new Set()
  let noWakes = false
  // 讀一個群組的新訊息（第一次讀最近 ROOM_FIRST_LOAD 則）；回 true＝有新資料
  async function read(id, { force = false, mark } = {}) {
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
      // mark:false＝背景讀進來（例如重開還原的分頁）；沒指定就問這個群組現在是不是正在看（背景分頁、視窗看不到都不標已讀）
      const seen = typeof mark === 'boolean' ? mark : (await Promise.resolve().then(() => visible(id)).catch(() => false)) === true
      // 後台只在讀到新訊息時才標已讀：未讀還在就多讀最後一則
      const since = unread && !first ? Math.max(0, readSince(log, row.lastSeq) - 1) : readSince(log, row.lastSeq)
      const r = await api.read({ room: id, agent: ident.agent || null, since, limit: first ? ROOM_FIRST_LOAD : 200, mark: seen })
      const mine = (room.mine ?? []).map(m => m?.member)
      st.logs[id] = applyWakes(applyReads(mergeRoomLog(log, roomLog(r?.messages, mine, room.members, { photos })), r?.reads), r?.wakes, offlineKeysOf(room))
      if (seen) for (const m of room.mine ?? []) if (m.member === ident.key) m.unread = 0
      st.note = ''
      return true
    } catch (e) { st.note = roomErrorText(e?.message) || ROOM_LOAD_FAIL_TEXT; return false } finally { reading.delete(id) }
  }

  // 點了群組訊息編號（#1530）、那一則還沒載入：從那一則的前一則往後讀，一直接到已載入最舊的那則（每次最多 200 則）。
  // 不標已讀；比已載入最舊的舊太多（超過 ROOM_BACK_MAX 則）就不讀。回 { found, tooOld?, error? }
  async function loadBack(id, seq) {
    const room = raw(id)
    const has = () => (st.logs[id] ?? []).some(e => e?.seq === seq)
    if (!Number.isInteger(seq) || seq < 1 || !room) return { found: false }
    if (has()) return { found: true }
    const ident = identityOf(id)
    if (!ident.key) return { found: false }
    const log = st.logs[id] ?? []
    const oldest = log.length ? log[0].seq : (Number.isInteger(room.last_seq) ? room.last_seq + 1 : seq + 1)   // 讀到這一則之前為止（讀之前先定好，補進來的不會改它）
    if (seq >= oldest) return { found: false }
    if (oldest - seq > ROOM_BACK_MAX) return { found: false, tooOld: true }
    const mine = (room.mine ?? []).map(m => m?.member)
    let since = seq - 1
    try {
      while (since < oldest - 1) {
        const r = await api.read({ room: id, agent: ident.agent || null, since, limit: Math.min(200, oldest - 1 - since), mark: false })
        const got = roomLog(r?.messages, mine, room.members, { photos })
        if (!got.length) break
        st.logs[id] = mergeRoomLog(st.logs[id] ?? [], got, ROOM_KEEP_MAX)
        const top = Math.max(...got.map(e => e.seq))
        if (!(top > since)) break
        since = top
      }
    } catch { return { found: has(), error: true } }
    return has() ? { found: true } : { found: false, tooOld: true }
  }

  // 沒有新訊息時：自己發的訊息還有人沒讀，就問一次後台「已讀 N」有沒有變（不標已讀、只讀最後一則之後＝不會有訊息內容）
  // 同一次呼叫也補晚到的叫醒順序（最近 10 分鐘內發出、還沒有順序的訊息）；後台只回已存的結果，不會重新排序
  async function refreshReceipts(id, ident, log) {
    const wakeWait = !noWakes && hasPendingWakes(log, now())
    if (!hasPendingReads(log) && !wakeWait) return false
    try {
      const r = await api.read({ room: id, agent: ident.agent || null, since: log[log.length - 1].seq, limit: 1, mark: false })
      if (wakeWait && !Array.isArray(r?.wakes)) noWakes = true   // 舊後台沒有這個欄位：不再為順序而問
      const cur = st.logs[id] ?? log
      const next = applyWakes(applyReads(cur, r?.reads), r?.wakes, offlineKeysOf(raw(id)))
      if (next !== cur) { st.logs[id] = next; return true }
    } catch { /* 舊後台或暫時連不上：維持原樣；背景補查已讀，出口已把失敗寫進 log，不必再提醒使用者 */ }
    return false
  }

  async function loadCards(id) {
    if (!raw(id)) return
    try { const r = await groupApi.confirmList(id); st.cards[id] = confirmCards(r?.confirms) } catch { /* 舊後台沒有這個動作：不顯示卡片；出口已把失敗寫進 log */ }
  }

  // 打開一個群組：讀訊息與確認卡片
  async function open(id, { mark } = {}) { await refresh(); await Promise.all([read(id, { force: true, mark }), loadCards(id)]) }

  async function post(id, text, opts = {}) {
    const ident = identityOf(id)
    const err = postError(text, { signedIn: true, identity: ident })
    if (err) { st.note = err; return false }
    try {
      const reply = Number.isInteger(opts?.replySeq) && opts.replySeq > 0 ? { reply_to: opts.replySeq } : {}   // 回覆某則訊息：後台記下引用並自動 @ 原作者
      const r = await api.post({ room: id, body: text, ...(ident.agent ? { from_agent: ident.agent } : {}), ...reply })
      st.note = ''
      const warn = unmatchedText(r)
      if (warn) st.notices[id] = [...(st.notices[id] ?? []), { seq: Number.isInteger(r?.seq) ? r.seq : null, text: warn, t: now() }].slice(-20)   // 只留在本機畫面，不寄出去
      await refresh(); await read(id, { force: true })
      return true
    } catch (e) { st.note = roomErrorText(e?.message); return false }
  }

  // 畫面上看到的記錄：對話記錄加上本機提示（接在該則發言之後；沒有序號就放最後）
  function view(id) {
    const log = st.logs[id] ?? [], notes = st.notices[id]
    if (!notes?.length) return log
    const sys = n => ({ k: 'sys', text: n.text, t: n.t, id: `unmatched-${n.t}` })
    const seqs = new Set(log.map(e => e.seq))
    const tail = notes.filter(n => n.seq === null || !seqs.has(n.seq))
    return [...log.flatMap(e => [e, ...notes.filter(n => n.seq === e.seq).map(sys)]), ...tail.map(sys)]
  }

  // 在群組傳照片或檔案：Rust 端上傳後以本人簽章發言（附件編號由 Rust 填，前端不能自填）
  async function postAttachment(id, item, caption = '') {
    const ident = identityOf(id)
    const err = postError('附件', { signedIn: true, identity: ident })
    if (err) { st.note = err; return false }
    if (!item?.data) { st.note = '沒有內容'; return false }
    try {
      await api.attach({ room: id, ...(ident.agent ? { from_agent: ident.agent } : {}), kind: item.kind === 'file' ? 'file' : 'image', caption: String(caption ?? '').trim(), name: item.name, data: item.data, width: item.width, height: item.height, thumb: item.thumb || undefined })
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

  return { st, raw, rows, rowOf, identityOf, refresh, read, loadBack, loadCards, open, view, post, postAttachment, decide }
}
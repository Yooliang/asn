// ASN 狀態核心（瀏覽器與 node 都能跑）：好友、對話、未讀、收信、寄信、震動。
// 不碰網路細節：transport 由外面注入（桌面版＝Rust 命令，金鑰留在 Rust；測試＝連本機假 relay）。
//   transport: { list(), inbox(), ack(ids), send(payload), avatar?(node), setAvatar?(dataUrl|null), sendAttachment?(payload), history?(node, agent, partnerId) }
//   store:     { load() → 物件|null, save(物件) }
//   isChatVisible(id) → Promise<boolean>：該好友的對話視窗是否開著且沒最小化
import { isAvatarDataUrl } from './avatar.mjs'
import { asnByNode } from './presence.mjs'
import { buildFriends, cleanPsm, mergeFriends } from './roster.mjs'
import { routeMail, stubFriend } from './routing.mjs'
import { hasNudge, hueOf, initial, noReplyNoticeOf, plain, stripNudge, stripReplyHead, unwrapShell } from './text.mjs'
import { noticeOf, expiresAt, fileMimeOf, friendlyPhotoError, normalizePhotos, stripPhotoLines } from './photo.mjs'
import { applyStatusRow, chunkIds, collectPollIds } from './sent-status.mjs'
import { historyUnsupported, mergeHistory } from './history.mjs'

export const MAX_BODY = 20000
const LOG_KEEP = 200
const STATUS_POLL_MS = 15_000
const HISTORY_MIN_GAP_MS = 20_000   // 同一位夥伴的往來記錄，兩次向後台取的最短間隔（強制重取除外）

export class AsnCore {
  constructor({ transport, store, selfNode, windowName, isChatVisible = async () => false, now = () => Date.now(), log = () => {}, pollMs = 120_000, rosterMs = 60_000, statusPollMs = STATUS_POLL_MS, aliases = [] }) {
    Object.assign(this, { aliases: new Set(aliases), transport, store, selfNode, windowName, isChatVisible, now, log, pollMs, rosterMs, statusPollMs })
    this.friends = new Map()   // id → 好友
    this.logs = new Map()      // id → 訊息陣列
    this.seen = new Set()      // 已處理過的信件 id（ack 失敗重拉時不重複顯示）
    this.nodeOrder = []        // 收發室名單裡的節點順序（設備頁籤照這個排）
    this.asn = {}              // 節點 → 在線的 ASN 視窗（名單帶的 asn：版本與狀態）
    this.avatars = new Map()   // 節點 → { at, data }：各設備上傳的大頭貼（名單只帶更新時間，圖按需取、依更新時間快取）
    this.conn = 'connecting'   // connecting | on | off
    this.rosterLoaded = false
    this.handlers = {}
    this.timers = []
    this.pulling = false
    this.again = false
    this.statusPulling = false
    this.statusAgain = false
    this.saveTimer = null
    this.historyAt = new Map()   // 好友 id → 上次向後台取往來記錄的時間
    this.historyOff = false      // 後台還沒支援往來記錄（404／400）：這次執行不再問
    this.historyBusy = new Set()
  }

  on(evt, fn) { (this.handlers[evt] ??= []).push(fn); return this }
  emit(evt, arg) { for (const fn of this.handlers[evt] ?? []) { try { fn(arg) } catch (e) { this.log(`handler ${evt}: ${e.message}`) } } }

  // ---------- 啟動／停止 ----------
  async start() {
    const saved = await this.store.load()
    for (const f of saved?.friends ?? []) this.friends.set(f.id, this.#decorate({ ...f, psm: cleanPsm(f.psm, f.node), status: 'offline', unread: 0, waiting: false, replyTo: null }))
    for (const [id, l] of Object.entries(saved?.logs ?? {})) this.logs.set(id, l)
    this.emit('state')
    await this.refreshRoster()
    await this.pull('startup')
    await this.refreshSentStatus('startup')
    this.timers.push(setInterval(() => void this.refreshRoster(), this.rosterMs))
    this.timers.push(setInterval(() => void this.pull('poll'), this.pollMs))
    this.timers.push(setInterval(() => void this.refreshSentStatus('poll'), this.statusPollMs))
  }
  async stop() { this.timers.forEach(clearInterval); this.timers = []; await this.flush() }

  // ---------- 名單 ----------
  async refreshRoster() {
    let members
    try { members = (await this.transport.list())?.members; this.#setConn('on') }
    catch (e) { this.log(`list failed: ${e.message}`); this.#setConn('off'); return }
    this.nodeOrder = (Array.isArray(members) ? members : []).map(m => m?.id).filter(x => typeof x === 'string')
    this.asn = asnByNode(members)
    const live = buildFriends(members, { selfNode: this.selfNode, selfName: this.windowName })
    this.#mergeRenamed(live)
    const prev = new Map([...this.friends].map(([id, f]) => [id, f.status]))
    const known = [...this.friends.values()].filter(f => this.logs.has(f.id) || f.known)
    const merged = mergeFriends(known, live)
    const next = new Map()
    for (const m of merged) {
      const old = this.friends.get(m.id)
      const f = this.#decorate({ unread: 0, waiting: false, replyTo: null, ...(old ?? {}), ...m })
      next.set(m.id, f)
      if (this.rosterLoaded && f.status !== 'offline' && (prev.get(m.id) ?? 'offline') === 'offline') {
        queueMicrotask(() => this.emit('notify', { kind: 'login', friend: f, line: '已經登入', sound: 'login', toast: true }))
      }
    }
    this.friends = next
    this.rosterLoaded = true
    this.emit('state')
    await this.#syncAvatars(members)
  }

  // 改名合併（夥伴 ID）：本機記住的舊名那筆若夥伴 ID 和名單上某位成員相同，就是同一位夥伴改了名——
  // 往來記錄、未讀、最後時間併進新名那筆，舊鍵移除並存檔。沒有夥伴 ID 的舊資料不動。
  #mergeRenamed(live) {
    const byPid = new Map(live.filter(l => l.partnerId).map(l => [l.partnerId, l]))
    let changed = false
    for (const old of [...this.friends.values()]) {
      const l = old.partnerId && byPid.get(old.partnerId)
      if (!l || l.id === old.id) continue
      const to = this.friends.get(l.id) ?? this.#decorate({ ...l, unread: 0, waiting: false, replyTo: null })
      to.unread = (to.unread || 0) + (old.unread || 0)
      to.lastAt = Math.max(to.lastAt ?? 0, old.lastAt ?? 0)
      to.waiting = Boolean(to.waiting || old.waiting)
      to.replyTo = to.replyTo ?? old.replyTo ?? null
      to.known = true
      to.partnerId = old.partnerId
      const seenIds = new Set()
      const merged = [...(this.logs.get(to.id) ?? []), ...(this.logs.get(old.id) ?? [])]
        .filter(m => { if (!m.id) return true; if (seenIds.has(m.id)) return false; seenIds.add(m.id); return true })
        .map((m, i) => [m, i]).sort((a, b) => (a[0].t ?? 0) - (b[0].t ?? 0) || a[1] - b[1]).map(x => x[0])
      if (merged.length) this.logs.set(to.id, merged)
      this.logs.delete(old.id)
      this.friends.delete(old.id)
      this.historyAt.delete(old.id)
      this.friends.set(to.id, to)
      changed = true
    }
    if (changed) this.#scheduleSave()
  }

  // ---------- 設備大頭貼 ----------
  // 名單每個節點帶 avatar_updated_at（沒上傳＝空）；時間跟快取不同才去取圖，不再上傳了就清掉。收到的圖一律驗格式（外部資料）。
  async #syncAvatars(members) {
    if (!this.transport.avatar) return
    const want = new Map()
    for (const m of Array.isArray(members) ? members : []) if (typeof m?.id === 'string' && typeof m.avatar_updated_at === 'string' && m.avatar_updated_at) want.set(m.id, m.avatar_updated_at)
    let changed = false
    for (const node of [...this.avatars.keys()]) if (!want.has(node)) { this.avatars.delete(node); changed = true }
    for (const [node, at] of want) {
      if (this.avatars.get(node)?.at === at) continue
      try {
        const r = await this.transport.avatar(node)
        if (isAvatarDataUrl(r?.avatar)) { this.avatars.set(node, { at, data: r.avatar }); changed = true }
        else this.log(`avatar ${node}: 格式不合，略過`)
      } catch (e) { this.log(`avatar ${node} failed: ${e.message}`) }
    }
    if (changed) this.emit('avatars')
  }
  avatarMap() { return Object.fromEntries([...this.avatars].map(([n, e]) => [n, e.data])) }

  // 上傳／移除本機設備的大頭貼（null＝移除，改回自動產生）。成功後直接更新本機快取，不等下一輪名單
  async setSelfAvatar(dataUrl) {
    if (!this.transport.setAvatar) return { ok: false, error: '這個版本不支援大頭貼' }
    if (dataUrl !== null && !isAvatarDataUrl(dataUrl)) return { ok: false, error: '大頭貼格式不對' }
    try {
      const r = await this.transport.setAvatar(dataUrl)
      if (dataUrl === null) this.avatars.delete(this.selfNode)
      else this.avatars.set(this.selfNode, { at: String(r?.avatar_updated_at ?? this.now()), data: dataUrl })
      this.emit('avatars')
      return { ok: true }
    } catch (e) { return { ok: false, error: e.message } }
  }

  #setConn(c) { if (this.conn !== c) { this.conn = c; this.emit('state') } }
  #decorate(f) { return { ...f, hue: hueOf(f.id), dp: initial(f.nick) } }

  // ---------- 收信 ----------
  async pull(why = 'poll') {
    if (this.pulling) { this.again = true; return }
    this.pulling = true
    try {
      do {
        this.again = false
        const { messages = [] } = (await this.transport.inbox()) ?? {}
        this.#setConn('on')
        const ids = []
        for (const m of messages) {
          if (m.to_agent !== this.windowName && !this.aliases.has(m.to_agent)) continue   // 不是寄給本視窗（或還沒過期的舊名）的絕不處理、不 ack
          if (!this.seen.has(m.id)) { this.seen.add(m.id); if (!this.#noReplyNotice(m)) await this.#incoming(m) }
          ids.push(m.id)
        }
        if (ids.length) { await this.flush(); await this.transport.ack(ids); ids.forEach(i => this.seen.delete(i)) }
      } while (this.again)
    } catch (e) { this.log(`pull failed (${why}): ${e.message}`); this.#setConn('off') }
    finally { this.pulling = false }
    void this.refreshSentStatus(why)
  }

  // 收發室的「等了 N 分鐘仍沒收到回覆」提醒信不是對話：不進對話、不提示、不算未讀。
  // 有 reply_to 對得到我們自己寄出的那則（log 裡 me 訊息存了寄出時的信件 id）就在那則標 unanswered＝等待分鐘數（資料欄位，畫面只顯示小字）；對不到就丟掉。回傳 true＝已處理（呼叫端不再當一般信）
  #noReplyNotice(m) {
    const n = noReplyNoticeOf(m)
    if (!n) return false
    if (m.reply_to) {
      for (const [fid, lg] of this.logs) {
        const mine = lg.find(x => x.k === 'me' && x.id === m.reply_to)
        if (!mine) continue
        mine.unanswered = n.mins
        this.#scheduleSave()
        this.emit('log', fid)
        break
      }
    }
    return true
  }

  async #incoming(m) {
    const r = routeMail(this.friends, m)
    let f = this.friends.get(r.id)
    if (!f) { f = this.#decorate({ ...stubFriend(r), unread: 0, waiting: false, replyTo: null }); this.friends.set(r.id, f) }
    f.known = true
    f.waiting = false
    const t = Date.parse(m.created_at) || this.now()
    const lg = this.#log(r.id)
    const body = stripReplyHead(unwrapShell(m.body))
    const nudge = hasNudge(body)
    // 照片：信裡的 attachments 整理乾淨（只留白名單欄位），內文開頭給舊版用戶端看的〔照片〕替代文字行不重複顯示
    const photos = normalizePhotos(m.attachments)
    const text = stripPhotoLines(stripNudge(body), photos.length)
    const shown = Boolean(text) || photos.length > 0
    // 往來記錄（打開對話／回前景）可能已先把這封補進記錄、後台還沒 ack 又回給 pull：記錄已有就不再推一列（提示與未讀照舊，這是新到的信）
    const rid = m.fanout_id ?? m.id
    const dup = lg.some(x => x.id === rid || x.id === m.id || x.rid === rid)
    // 沒指定收件視窗、由橋交給本人的信：先標出「寄件人 → 未指定收件人」，由使用者決定轉給誰或自己回
    if (shown && !dup && m.unaddressed === true) lg.push({ k: 'sys', text: `${plain(f.nick)} → 未指定收件人`, t })
    if (shown) { if (!dup) lg.push({ k: 'them', text, t, id: rid, ...(photos.length ? { photos } : {}) }); f.lastAt = t; f.replyTo = m.id }
    if (m.reply_to) this.#markReplied(m.reply_to, typeof m.created_at === 'string' ? m.created_at : new Date(t).toISOString())
    const visible = await this.isChatVisible(r.id)
    if (nudge) {
      if (!dup) lg.push({ k: 'sys', nudge: true, rid, text: `${plain(f.nick)} 傳送了一個震動。`, t })
      if (!shown && !visible) f.unread++
    }
    if (shown && !visible) f.unread++
    this.#scheduleSave()
    this.emit('state')
    this.emit('log', r.id)
    if (shown) this.emit('notify', { kind: 'msg', friend: f, line: text ? plain(text) : noticeOf(photos), sound: 'msg', toast: !visible, hasFile: photos.some(a => a.kind === 'file') })
    if (nudge) this.emit('notify', { kind: 'nudge', friend: f, line: '傳送了一個震動', sound: 'nudge', toast: !visible, shake: visible })
    // 回信是扇出給我所有設備的：我在別台設備上說的話這台還沒有，順手補一次（人在別台說、這台只看到 AI 的回覆就會斷掉）
    if (typeof m.fanout_id === 'string') void this.syncHistory(r.id, { force: true })
  }

  // ---------- 寄信 ----------
  async send(id, raw) {
    const f = this.friends.get(id)
    const text = String(raw ?? '').trim()
    if (!f || !text) return { ok: false, error: '沒有內容或找不到好友' }
    if (text.length > MAX_BODY) return { ok: false, error: `內文超過 ${MAX_BODY} 字` }
    const payload = { to_node: f.node, to_agent: f.agent || undefined, body: text, reply_to: f.replyTo || undefined, from_agent: this.windowName, expects_reply: true, ...this.#personFlag(f) }
    let sent
    try { sent = await this.transport.send(payload) } catch (e) { return this.#fail(id, e) }
    const mid = typeof sent?.id === 'string' ? sent.id : null
    this.#log(id).push({ k: 'me', text, t: this.now(), ...(mid ? { id: mid } : {}) })
    f.waiting = true
    f.replyTo = null
    f.known = true
    this.#scheduleSave()
    this.emit('state')
    this.emit('log', id)
    await this.refreshSentStatus('send')
    return { ok: true }
  }

  // 寄照片或檔案（可重用：截圖標註等功能把 Blob 交給 photo-canvas.mjs 的 imageFromBlob／fileFromBlob 再呼叫這個）。item＝{ kind, name, data（base64）, width?, height?, thumb? }，caption＝說明文字（可空）。
  // 格式與大小由 Rust 端再檢查一次；失敗就在對話裡留一行「沒有傳出去：原因」
  async sendAttachment(id, photo, caption = "") {
    const f = this.friends.get(id)
    if (!f || !photo?.data) return { ok: false, error: '沒有內容或找不到好友' }
    const cap = String(caption ?? '').trim()
    if (cap.length > MAX_BODY - 200) return { ok: false, error: `說明文字超過 ${MAX_BODY - 200} 字` }
    if (typeof this.transport.sendAttachment !== "function") return { ok: false, error: "這個版本不能傳照片或檔案" }
    const payload = { ...this.#personFlag(f), kind: photo.kind === 'file' ? 'file' : 'image', to_node: f.node, to_agent: f.agent || undefined, reply_to: f.replyTo || undefined, caption: cap, name: photo.name, data: photo.data, width: photo.width, height: photo.height, thumb: photo.thumb || undefined }
    let r
    try { r = await this.transport.sendAttachment(payload) } catch (e) {
      const msg = friendlyPhotoError(e.message)
      this.#log(id).push({ k: 'sys', text: `沒有傳出去：${msg}`, t: this.now() })
      this.emit('log', id)
      return { ok: false, error: msg }
    }
    const now = this.now()
    const isFile = photo.kind === 'file'
    const mine = { id: r?.attachment_id, kind: isFile ? 'file' : 'image', name: r?.name || photo.name, mime: isFile ? fileMimeOf(r?.name || photo.name) : 'image/webp', bytes: r?.bytes ?? null, width: photo.width ?? null, height: photo.height ?? null, thumb: photo.thumb ?? null, expires_at: expiresAt(now), expired: false }
    const photos = normalizePhotos([mine])
    const mid = typeof r?.id === 'string' ? r.id : null
    this.#log(id).push({ k: 'me', text: cap, t: now, ...(mid ? { id: mid } : {}), ...(photos.length ? { photos } : {}) })
    f.waiting = true
    f.replyTo = null
    f.known = true
    this.#scheduleSave()
    this.emit('state')
    this.emit('log', id)
    await this.refreshSentStatus('send')
    return { ok: true }
  }

  async nudge(id) {
    const f = this.friends.get(id)
    if (!f) return { ok: false, error: '找不到好友' }
    try { await this.transport.send({ to_node: f.node, to_agent: f.agent || undefined, nudge: true, from_agent: this.windowName, expects_reply: false, ...this.#personFlag(f) }) }
    catch (e) { return this.#fail(id, e) }
    this.#log(id).push({ k: 'sys', nudge: true, mine: true, text: '你已傳送震動。', t: this.now() })
    f.known = true
    this.#scheduleSave()
    this.emit('log', id)
    return { ok: true }
  }

  // 以「人」寄出（#108）：登入時由 Rust 端帶憑證才會生效（沒登入＝照舊以這台設備的視窗名寄出）。寄給自己帳號另一台 ASN 的設備互聊不套用（對方要看到是哪台設備）
  #personFlag(f) {
    const peer = (this.asn[f.node] ?? []).some(w => w.window_name === f.agent)
    return peer ? {} : { person: true }
  }

  // ---------- 往來記錄（以後台為準，本機只當快取） ----------
  // 節點的設備名（名單上的，例如「Oppo 手機」）；名單裡沒有就空字串，由後台帶的名字補
  #deviceName(node) { for (const f of this.friends.values()) if (f.node === node && f.device) return f.device; return '' }
  // 向後台取「我和這位夥伴」90 天內的信，補進本機記錄。沒登入、連不上、後台還沒支援都靜默略過（本機快取照用）。回補進幾則
  async syncHistory(id, { force = false } = {}) {
    const f = this.friends.get(id)
    if (!f || !this.transport.history || this.historyOff || this.historyBusy.has(id)) return 0
    const last = this.historyAt.get(id) ?? 0
    if (!force && this.now() - last < HISTORY_MIN_GAP_MS) return 0
    this.historyBusy.add(id)
    this.historyAt.set(id, this.now())
    try {
      const r = await this.transport.history(f.node, f.agent || '', f.partnerId || null)
      const { log, added } = mergeHistory(this.logOf(id), r?.messages, f.nick, { selfNode: this.selfNode, deviceOf: node => this.#deviceName(node) })
      if (!added) return 0
      this.logs.set(id, log)
      f.known = true
      const lastThem = [...log].reverse().find(m => m.k === 'them')
      if (lastThem && (f.lastAt ?? 0) < lastThem.t) f.lastAt = lastThem.t
      this.#scheduleSave()
      this.emit('state')
      this.emit('log', id)
      return added
    } catch (e) {
      if (historyUnsupported(e.message)) this.historyOff = true
      this.log(`history ${id} failed: ${e.message}`)
      return 0
    } finally { this.historyBusy.delete(id) }
  }

  #fail(id, e) {
    this.#log(id).push({ k: 'sys', text: `訊息沒有送到：${e.message}`, t: this.now() })
    this.emit('log', id)
    return { ok: false, error: e.message }
  }

  #markReplied(replyTo, at) {
    let changed = false
    for (const lg of this.logs.values()) {
      for (const m of lg) {
        if (m.k === 'me' && m.id === replyTo && !m.repliedAt) {
          m.repliedAt = at
          changed = true
        }
      }
    }
    if (changed) {
      this.#scheduleSave()
      this.emit('state')
    }
  }

  /** 批次查自己寄出訊息的 delivered_at／acked_at／replied_at */
  async refreshSentStatus(why = 'poll') {
    if (typeof this.transport.sentStatus !== 'function') return
    if (this.statusPulling) { this.statusAgain = true; return }
    this.statusPulling = true
    try {
      do {
        this.statusAgain = false
        const ids = collectPollIds(this.logs, this.now())
        if (!ids.length) break
        let changed = false
        for (const batch of chunkIds(ids)) {
          const rows = await this.transport.sentStatus(batch)
          if (!Array.isArray(rows)) continue
          for (const row of rows) {
            for (const lg of this.logs.values()) {
              for (const m of lg) if (applyStatusRow(m, row)) changed = true
            }
          }
        }
        if (changed) {
          this.#scheduleSave()
          this.emit('state')
        }
      } while (this.statusAgain)
    } catch (e) { this.log(`sent_status failed (${why}): ${e.message}`) }
    finally { this.statusPulling = false }
  }

  // ---------- 讀取 ----------
  markRead(id) { const f = this.friends.get(id); if (f && f.unread) { f.unread = 0; this.emit('state') } }
  #log(id) { if (!this.logs.has(id)) this.logs.set(id, []); return this.logs.get(id) }
  logOf(id) { return this.logs.get(id) ?? [] }
  snapshot() { return { conn: this.conn, windowName: this.windowName, selfNode: this.selfNode, nodeOrder: [...this.nodeOrder], asn: this.asn, friends: [...this.friends.values()].map(f => ({ ...f })) } }

  // ---------- 存檔 ----------
  #scheduleSave() { if (!this.saveTimer) this.saveTimer = setTimeout(() => { this.saveTimer = null; void this.flush() }, 300) }
  async flush() {
    if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = null }
    const withLog = [...this.friends.values()].filter(f => this.logs.has(f.id) || f.known)
    try {
      await this.store.save({
        friends: withLog.map(f => ({ id: f.id, node: f.node, agent: f.agent, nick: f.nick, psm: f.psm, engine: f.engine, ...(f.partnerId ? { partnerId: f.partnerId } : {}), lastAt: f.lastAt ?? 0, known: true, onRoster: f.onRoster === true })),
        logs: Object.fromEntries(withLog.filter(f => this.logs.has(f.id)).map(f => [f.id, this.logs.get(f.id).slice(-LOG_KEEP)])),
      })
    } catch (e) { this.log(`save failed: ${e.message}`) }
  }
}

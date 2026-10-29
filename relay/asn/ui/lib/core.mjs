// ASN 狀態核心（瀏覽器與 node 都能跑）：好友、對話、未讀、收信、寄信、震動。
// 不碰網路細節：transport 由外面注入（桌面版＝Rust 命令，金鑰留在 Rust；測試＝連本機假 relay）。
//   transport: { list(), inbox(), ack(ids), send(payload), avatar?(node), partnerAvatar?(partnerId), setAvatar?(dataUrl|null), sendAttachment?(payload), history?(node, agent, partnerId) }
//   store:     { load() → 物件|null, save(物件) }
//   isChatVisible(id) → Promise<boolean>：該好友的對話視窗是否開著且沒最小化
import { PARTNER_ID_RE, isAvatarDataUrl, partnerAvatarKey } from './avatar.mjs'
import { renamedInfo } from './rename.mjs'
import { asnByNode } from './presence.mjs'
import { coalesced, overlayLocal } from './local-status.mjs'
import { isProcessName, archivedKeysOf, buildFriends, cleanPsm, expectsReplyTo, friendId, isAsnWindow, mergeFriends } from './roster.mjs'
import { contextAlertText, createContextWatch } from './context-usage.mjs'
import { routeMail, stubFriend } from './routing.mjs'
import { hasNudge, hueOf, initial, noReplyNoticeOf, plain, stripNudge, stripReplyHead, unwrapShell } from './text.mjs'
import { friendlySendError } from './display-only.mjs'
import { noticeOf, expiresAt, fileMimeOf, friendlyPhotoError, normalizePhotos, stripPhotoLines } from './photo.mjs'
import { applyStatusRow, chunkIds, collectPollIds } from './sent-status.mjs'
import { OLDER_PAGE, historyUnsupported, judgeOlder, mergeHistory, olderBeforeIso, olderCursor } from './history.mjs'
import { READ_DEBOUNCE_MS, batchOf, cleanMarks, lastIncomingAt, readKey, readSyncSignedOut, readSyncUnsupported, unreadAfter } from './read-sync.mjs'

export const MAX_BODY = 20000
const LOG_KEEP = 2000   // 存檔最多留幾列（往上捲載入的也算）
export const VIEW_BASE = 200   // 畫面預設顯示最近幾列；往上載入更舊的之後，依載入範圍加寬
const STATUS_POLL_MS = 15_000
const HISTORY_MIN_GAP_MS = 20_000   // 同一位夥伴的往來記錄，兩次向後台取的最短間隔（強制重取除外）
const STEP_MS = 60_000              // 收信流程裡任何一個「等外面回應」的步驟最久等多久；超過就放棄這一步，不讓 pulling 旗標永遠卡住、定時收信整個停擺

// 等一個承諾，最久 ms 毫秒；逾時就以錯誤結束（原承諾若之後才回來，結果丟掉）
function withTimeout(p, ms, what) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${what} 逾時`)), ms)
    Promise.resolve(p).then(v => { clearTimeout(t); resolve(v) }, e => { clearTimeout(t); reject(e) })
  })
}

// 連線中斷的簡短原因（給畫面顯示；原始錯誤只進 log）：分不出來就回空字串，畫面維持原本的說法
export function connReason(e) {
  const m = String(e?.message ?? e ?? '')
  if (/逾時|timeout|timed out/i.test(m)) return '請求逾時'
  if (/HTTP 401|HTTP 403|unauthorized|forbidden/i.test(m)) return '憑證被拒（請重新登入或重新設定）'
  if (/HTTP 5\d\d/.test(m)) return '後台暫時出錯'
  if (/格式不對/.test(m)) return '本機送出的資料格式不對（詳見記錄）'
  if (/HTTP 400/.test(m)) return '後台拒絕了這次請求'
  if (/連線失敗|network|dns|connect/i.test(m)) return '連不上後台（請檢查網路或代理）'
  if (/save|儲存|寫入/i.test(m)) return '本機存檔失敗（磁碟滿了或檔案被占用？）'
  return ''
}
const ACK_CHUNK = 100   // 一次 ack 最多 100 個編號（本機 relay.rs 的 build_ack_body 檢查：超過或有任何一個格式不對就整批不送）
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const ITEM_RETRY_MAX = 3   // 同一封信處理失敗幾次後就先 ack 掉，不讓一封壞信擋住後面所有信
// 一次收到超過這麼多封「Rust 代收的信」（畫面沒開時存下來的，m.spooled）就不逐封跳提示、只跳一則摘要（#339：曾一次湧進 437 封）
export const SPOOL_QUIET_OVER = 3

// 舊好友存檔的一筆：畫面離線時還要用的欄位。model（模型）決定 pi 夥伴的廠商小圖示、device（設備名）與 kind（設備種類，手機與否）決定設備分組的名字與圖示；
// 這三欄名單沒給就不寫（舊存檔本來就沒有，讀回時照舊退回 pi 圖示／未命名設備）。欄位名與名單（buildFriends）一致，讀回直接沿用
const optStr = (key, v) => (typeof v === 'string' && v.trim() ? { [key]: v.trim() } : {})
export const savedFriendOf = f => ({
  id: f.id, node: f.node, agent: f.agent, nick: f.nick, psm: f.psm, engine: f.engine,
  ...optStr('model', f.model), ...optStr('device', f.device), ...optStr('kind', f.kind),
  ...(f.partnerId ? { partnerId: f.partnerId } : {}), lastAt: f.lastAt ?? 0, known: true, onRoster: f.onRoster === true,
})
// 讀回存檔的一筆：這三欄只收非空字串（存檔是本機檔，壞掉或被改過的值不帶進畫面）；沒有就不補，畫面照舊退回
export const restoredFriendOf = ({ model, device, kind, ...rest }) => ({ ...rest, ...optStr('model', model), ...optStr('device', device), ...optStr('kind', kind) })

export class AsnCore {
  constructor({ transport, store, selfNode, windowName, isChatVisible = async () => false, now = () => Date.now(), log = () => {}, pollMs = 120_000, rosterMs = 60_000, localMs = 2_000, soonGapMs = 1_000, statusPollMs = STATUS_POLL_MS, aliases = [], stepMs = STEP_MS }) {
    // 讀取類的呼叫一律加逾時（寄信、寄檔另有自己的流程，不在這裡限時）。收信（inbox、ack）可能一次要走好幾個名字，給兩倍時間
    const guarded = { ...transport }
    for (const k of ['list', 'inbox', 'ack', 'sentStatus', 'avatar', 'partnerAvatar', 'history', 'readSync']) {
      if (typeof transport[k] === 'function') guarded[k] = (...a) => withTimeout(transport[k](...a), k === 'inbox' || k === 'ack' ? stepMs * 2 : stepMs, k)
    }
    Object.assign(this, { aliases: new Set(aliases), transport: guarded, store, selfNode, windowName, isChatVisible, now, log, pollMs, rosterMs, localMs, statusPollMs, stepMs })
    this.localSeen = new Set()   // 本機現讀曾經看到過的視窗名（之後不見＝剛關掉，見 overlayLocal）
    this.cwdOf = new Map()   // 好友 id → 資料夾標籤（後台名單給的），本機現讀狀態時用來重組個人訊息
    // 門鈴響、回到前景時立刻重拉名單；1 秒內多次合併成一次
    this.refreshRosterSoon = coalesced(() => this.refreshRoster(), soonGapMs)
    this.friends = new Map()   // id → 好友
    this.logs = new Map()      // id → 訊息陣列
    this.seen = new Set()      // 已處理過的信件 id（ack 失敗重拉時不重複顯示）
    this.nodeOrder = []        // 收發室名單裡的節點順序（設備頁籤照這個排）
    this.asn = {}              // 節點 → 在線的 ASN 視窗（名單帶的 asn：版本與狀態）
    this.avatars = new Map()   // 節點（或 p:夥伴編號）→ { at, data }：各設備、各夥伴上傳的大頭貼（名單只帶更新時間，圖按需取、依更新時間快取）
    this.conn = 'connecting'   // connecting | on | off
    this.connWhy = ''          // conn 為 off 時的簡短原因（connReason）
    this.itemFails = new Map() // 信件 id → 處理失敗次數
    this.rosterLoaded = false
    this.contextWatch = createContextWatch()   // 上下文升破 90％的提醒記錄（只在記憶體）
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
    this.readMarks = {}          // 對話鍵 → 已讀位置（毫秒）：本機與後台合併後的結果，只往前（見 lib/read-sync.mjs）
    this.readDirty = {}          // 還沒送上後台的已讀位置（離線或剛讀完在等節流）
    this.readOff = false         // 後台還沒支援已讀同步（404）：這次執行不再問
    this.readTimer = null
    this.readBusy = false
    this.olderBusy = new Set()     // 正在往上載入更舊的信的好友（同一時間只跑一個）
    this.olderDone = new Set()     // 後台已沒有更早的信（或不支援往上載入）的好友：這次執行不再問
    this.olderExtra = new Map()    // 好友 id → 往上載入而多顯示的列數（畫面顯示 = 最近 VIEW_BASE + 這個數字）
  }

  on(evt, fn) { (this.handlers[evt] ??= []).push(fn); return this }
  emit(evt, arg) { for (const fn of this.handlers[evt] ?? []) { try { fn(arg) } catch (e) { this.log(`handler ${evt}: ${e.message}`) } } }

  // ---------- 啟動／停止 ----------
  async start() {
    const saved = await withTimeout(this.store.load(), this.stepMs, 'load').catch(e => { this.log(`load failed: ${e.message}`); return null })
    for (const f of saved?.friends ?? []) this.friends.set(f.id, this.#decorate({ ...restoredFriendOf(f), psm: cleanPsm(f.psm, f.node), status: 'offline', unread: 0, waiting: false, replyTo: null }))
    for (const [id, l] of Object.entries(saved?.logs ?? {})) this.logs.set(id, l)
    this.readDirty = cleanMarks(saved?.readDirty)   // 上次離線時沒送出的已讀位置，連線後補送
    this.emit('state')
    await this.refreshRoster()
    await this.pull('startup')
    await this.refreshSentStatus('startup')
    this.timers.push(setInterval(() => void this.refreshRoster(), this.rosterMs))
    // 這台電腦的視窗直接讀本機狀態（沒有 localWindows 的平台＝手機，不啟動）
    if (typeof this.transport.localWindows === 'function' && this.localMs > 0) this.timers.push(setInterval(() => void this.refreshLocal(), this.localMs))
    this.timers.push(setInterval(() => void this.pull('poll'), this.pollMs))
    this.timers.push(setInterval(() => void this.refreshSentStatus('poll'), this.statusPollMs))
  }
  // 改名後就地換名：記下舊名（改名前寄來的回信還要收）、立刻通知畫面、重抓名單（自己的視窗名要從名單濾掉）。不重載頁面
  setWindowName(name) {
    const r = renamedInfo({ window_name: this.windowName, old_names: [...this.aliases] }, name)
    this.windowName = r.window_name
    this.aliases = new Set(r.old_names)
    this.emit('state')
    void this.refreshRoster()
  }
  async stop() { this.timers.forEach(clearInterval); this.timers = []; await this.flush() }

  // ---------- 名單 ----------
  async refreshRoster() {
    let members
    try { members = (await this.transport.list())?.members; this.#setConn('on') }
    catch (e) { this.log(`list failed: ${e.message}`); this.#setConn('off', connReason(e)); return }
    this.nodeOrder = (Array.isArray(members) ? members : []).map(m => m?.id).filter(x => typeof x === 'string')
    this.asn = asnByNode(members)
    const live = buildFriends(members, { selfNode: this.selfNode, selfName: this.windowName })
    this.#mergeRenamed(live)
    const prev = new Map([...this.friends].map(([id, f]) => [id, f.status]))
    const known = [...this.friends.values()].filter(f => (this.logs.has(f.id) || f.known) && !(f.entryKind === 'process' || isProcessName(f.agent)))   // 程序條目（「pi #pid」這類）不當離線好友記住，有沒有對話記錄都一樣（#447）；對話記錄本身不刪
    const merged = mergeFriends(known, live, archivedKeysOf(members))
    const next = new Map()
    for (const m of merged) {
      const old = this.friends.get(m.id)
      const f = this.#decorate({ unread: 0, waiting: false, replyTo: null, ...(old ?? {}), ...m, contextPct: m.contextPct ?? null, modLoaded: m.modLoaded ?? null, deviceMod: m.deviceMod ?? null })   // 上下文用量每輪以名單為準，不沿用舊值
      next.set(m.id, f)
      if (this.rosterLoaded && !isAsnWindow(f) && f.status !== 'offline' && (prev.get(m.id) ?? 'offline') === 'offline') {
        queueMicrotask(() => this.emit('notify', { kind: 'login', friend: f, line: '已經登入', sound: 'login', toast: true }))
      }
    }
    this.friends = next
    for (const a of this.contextWatch.update([...next.values()].filter(f => !isAsnWindow(f)))) {
      const f = next.get(a.id)
      queueMicrotask(() => this.emit('notify', { kind: 'context', friend: f, line: contextAlertText(f.nick, a.pct), pct: a.pct, toast: true }))
    }
    this.cwdOf = new Map(live.map(l => [l.id, '']))
    for (const m of Array.isArray(members) ? members : []) for (const a of Array.isArray(m?.agents) ? m.agents : []) if (a && typeof a.name === 'string' && a.cwd_label) this.cwdOf.set(friendId(m.id, a.name), String(a.cwd_label))
    await this.refreshLocal(true)   // 本機視窗以本機現讀為準，蓋掉後台稍舊的狀態
    this.rosterLoaded = true
    this.emit('state')
    void this.syncReads()   // 定期順便取回別台設備的已讀、補送沒送出的
    await this.#syncAvatars(members)
  }

  // 本機視窗現讀：名單上「這台電腦」的夥伴，狀態以本機狀態檔為準（延遲 ≤ localMs，不經後台）。讀失敗就維持名單給的
  async refreshLocal(quiet = false) {
    if (typeof this.transport.localWindows !== 'function') return
    let locals
    try { locals = await this.transport.localWindows() } catch { return }
    const next = overlayLocal(this.friends, this.selfNode, locals, this.cwdOf, this.localSeen)
    for (const w of Array.isArray(locals) ? locals : []) if (w && typeof w.name === 'string' && w.name) this.localSeen.add(w.name)
    if (!next) return
    this.friends = next
    if (!quiet) this.emit('state')
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
      this.olderDone.delete(old.id); this.olderExtra.delete(old.id)
      this.friends.set(to.id, to)
      changed = true
    }
    if (changed) this.#scheduleSave()
  }

  // ---------- 設備大頭貼 ----------
  // 名單每個節點帶 avatar_updated_at（沒上傳＝空）；時間跟快取不同才去取圖，不再上傳了就清掉。收到的圖一律驗格式（外部資料）。
  // 夥伴自己換的頭像（#446）：名單的每位夥伴（在線與離線）也帶 avatar_updated_at 與 partner_id，圖放在同一張表，鍵是 'p:<夥伴編號>'（改名不會斷）。
  // 舊後台沒有這個欄位＝沒有夥伴頭像；沒有 partnerAvatar 通道的舊傳輸層略過夥伴這一層。
  async #syncAvatars(members) {
    if (!this.transport.avatar) return
    const want = new Map()   // 鍵 → [更新時間, 取圖的函式]
    for (const m of Array.isArray(members) ? members : []) {
      if (typeof m?.id === 'string' && typeof m.avatar_updated_at === 'string' && m.avatar_updated_at) want.set(m.id, [m.avatar_updated_at, () => this.transport.avatar(m.id)])
      if (!this.transport.partnerAvatar) continue
      for (const a of [...(Array.isArray(m?.agents) ? m.agents : []), ...(Array.isArray(m?.offline_agents) ? m.offline_agents : [])]) {
        if (typeof a?.partner_id === 'string' && PARTNER_ID_RE.test(a.partner_id) && typeof a.avatar_updated_at === 'string' && a.avatar_updated_at) {
          want.set(partnerAvatarKey(a.partner_id), [a.avatar_updated_at, () => this.transport.partnerAvatar(a.partner_id)])
        }
      }
    }
    let changed = false
    for (const key of [...this.avatars.keys()]) if (!want.has(key)) { this.avatars.delete(key); changed = true }
    for (const [key, [at, fetchOne]] of want) {
      if (this.avatars.get(key)?.at === at) continue
      try {
        const r = await fetchOne()
        if (isAvatarDataUrl(r?.avatar)) { this.avatars.set(key, { at, data: r.avatar }); changed = true }
        else this.log(`avatar ${key}: 格式不合，略過`)
      } catch (e) { this.log(`avatar ${key} failed: ${e.message}`) }
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

  #setConn(c, why = '') { if (this.conn !== c || this.connWhy !== why) { this.conn = c; this.connWhy = c === 'off' ? why : ''; this.emit('state') } }
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
        let itemErr = null
        const forMe = m => m.to_agent === this.windowName || this.aliases.has(m.to_agent)
        // 代收的舊信很多時照常進對話、算未讀，但不逐封跳提示與音效，最後合成一則
        const quiet = messages.filter(m => m?.spooled === true && forMe(m) && !this.seen.has(m.id)).length > SPOOL_QUIET_OVER
        let quietN = 0, quietLast = null
        for (const m of messages) {
          if (!forMe(m)) continue   // 不是寄給本視窗（或還沒過期的舊名）的絕不處理、不 ack
          try {
            if (!this.seen.has(m.id)) {
              this.seen.add(m.id)
              if (!this.#noReplyNotice(m)) {
                const q = quiet && m.spooled === true
                const f = await this.#incoming(m, { quiet: q })
                if (q && f) { quietN++; quietLast = f }
              }
            }
            this.itemFails.delete(m.id)
            ids.push(m.id)
          } catch (e) {
            // 一封信處理失敗不能擋住後面的信：記下、跳過；同一封連續失敗 ITEM_RETRY_MAX 次就放棄它（照常 ack，免得每輪都卡在同一封）
            itemErr = e
            const n = (this.itemFails.get(m.id) ?? 0) + 1
            this.itemFails.set(m.id, n)
            this.seen.delete(m.id)
            this.log(`pull item failed (${String(m.id).slice(0, 8)} #${n}): ${e.message}`)
            if (n >= ITEM_RETRY_MAX) {
              this.itemFails.delete(m.id); this.seen.add(m.id); ids.push(m.id); this.log(`pull item dropped (${String(m.id).slice(0, 8)})`)
              try { const r = routeMail(this.friends, m); if (this.friends.has(r.id)) this.#log(r.id).push({ k: 'sys', text: '有一封信無法顯示，已跳過（詳見記錄）', t: this.now() }) } catch { /* 連留一行都做不到就算了 */ }
            }
          }
        }
        if (ids.length) {
          await this.flush()
          // 不是 UUID 的編號會讓整批 ack 永遠失敗：先濾掉、寫 log（那封信在後台不會被確認收到，但不再擋住其他信）
          const bad = ids.filter(i => !UUID_RE.test(String(i)))
          if (bad.length) { this.log(`ack skipped ${bad.length} bad id(s): ${bad.slice(0, 3).map(i => String(i).slice(0, 12)).join(',')}`); ids.splice(0, ids.length, ...ids.filter(i => UUID_RE.test(String(i)))) }
          for (let i = 0; i < ids.length; i += ACK_CHUNK) await this.transport.ack(ids.slice(i, i + ACK_CHUNK))   // 分批 ack，一批最多 100 個
          ids.forEach(i => this.seen.delete(i))
        }
        if (quietN) {
          this.log(`spool delivered ${quietN} message(s) quietly`)
          this.emit('notify', { kind: 'msg', friend: quietLast, line: `收到 ${quietN} 封你不在時代收的信`, sound: 'msg', toast: true })
        }
        if (itemErr) this.#setConn('off', '有信件處理失敗（已跳過，詳見記錄）')
      } while (this.again)
    } catch (e) { this.log(`pull failed (${why}): ${e.message}`); this.#setConn('off', connReason(e)) }
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

  // quiet：照常記進對話、算未讀，只是不跳提示（代收舊信一次很多時由 pull 合成一則）。回這封信落在哪位夥伴
  async #incoming(m, { quiet = false } = {}) {
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
    // 沒指定收件視窗、由橋交給本人的信：先標出「XX 寄來的信沒有指定收件人」，由使用者決定轉給誰或自己回；震動信一律只顯示「傳送了一個震動」，不加這行
    if (shown && !nudge && !dup && m.unaddressed === true) lg.push({ k: 'sys', text: `${plain(f.nick)} 寄來的信沒有指定收件人`, t })
    if (shown) { if (!dup) lg.push({ k: 'them', text, t, id: rid, ...(photos.length ? { photos } : {}) }); f.lastAt = t; f.replyTo = m.id }
    if (m.reply_to) this.#markReplied(m.reply_to, typeof m.created_at === 'string' ? m.created_at : new Date(t).toISOString())
    // 視窗狀態查不到（沒回應、出錯）就當沒看見：照常記進對話、算未讀，不卡住收信
    const visible = await withTimeout(this.isChatVisible(r.id), this.stepMs, 'isChatVisible').catch(() => false)
    // 這封信的時間不晚於帳號的已讀位置（別台設備已經讀過）：不算未讀
    const already = (this.readMarks[readKey(f) ?? ''] ?? 0) >= t
    if (nudge) {
      if (!dup) lg.push({ k: 'sys', nudge: true, rid, text: `${plain(f.nick)} 傳送了一個震動。`, t })
      if (!shown && !visible && !already) f.unread++
    }
    if (shown && !visible && !already) f.unread++
    if (visible && (shown || nudge)) this.#advanceRead(r.id)   // 對話開著正在看，等於當場讀了：別台設備也跟著消
    this.#scheduleSave()
    this.emit('state')
    this.emit('log', r.id)
    if (shown && !quiet) this.emit('notify', { kind: 'msg', friend: f, line: text ? plain(text) : noticeOf(photos), sound: 'msg', toast: !visible, hasFile: photos.some(a => a.kind === 'file') })
    if (nudge && !quiet) this.emit('notify', { kind: 'nudge', friend: f, line: '傳送了一個震動', sound: 'nudge', toast: !visible, shake: visible })
    // 回信是扇出給我所有設備的：我在別台設備上說的話這台還沒有，順手補一次（人在別台說、這台只看到 AI 的回覆就會斷掉）
    if (typeof m.fanout_id === 'string') void this.syncHistory(r.id, { force: true })
    return f
  }

  // ---------- 寄信 ----------
  // opts.voice＝true：語音通話中辨識出來的句子。寄信帶結構化旗標 voice（收信端的收發室據此提醒夥伴），本機記錄也標上，畫面顯示「語音」小標示
  async send(id, raw, opts = {}) {
    const voice = opts?.voice === true
    const f = this.friends.get(id)
    const text = String(raw ?? '').trim()
    if (!f || !text) return { ok: false, error: '沒有內容或找不到好友' }
    if (text.length > MAX_BODY) return { ok: false, error: `內文超過 ${MAX_BODY} 字` }
    const payload = { to_node: f.node, to_agent: f.agent || undefined, body: text, reply_to: f.replyTo || undefined, from_agent: this.windowName, expects_reply: expectsReplyTo(f), ...this.#personFlag(f), ...(voice ? { voice: true } : {}) }
    let sent
    try { sent = await this.transport.send(payload) } catch (e) { return this.#fail(id, e) }
    const mid = typeof sent?.id === 'string' ? sent.id : null
    this.#log(id).push({ k: 'me', text, t: this.now(), ...(mid ? { id: mid } : {}), ...(voice ? { voice: true } : {}) })
    f.waiting = expectsReplyTo(f)
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
    f.waiting = expectsReplyTo(f)
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
    let sent
    try { sent = await this.transport.send({ to_node: f.node, to_agent: f.agent || undefined, nudge: true, from_agent: this.windowName, expects_reply: false, ...this.#personFlag(f) }) }
    catch (e) { return this.#fail(id, e) }
    // 帶上寄出的信件 id（rid）：之後往來記錄回來同一則才認得是它，不會再多一行
    const rid = typeof sent?.id === 'string' ? sent.id : null
    this.#log(id).push({ k: 'sys', nudge: true, mine: true, text: '你已傳送震動。', t: this.now(), ...(rid ? { rid } : {}) })
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

  // 往上捲載入更舊的信：以目前記錄最早一則的時間當 before，向後台要 OLDER_PAGE 則，去重後接在前面。
  // 回 { more, added, busy?, error? }：more＝可能還有更多（回來不到一頁＝沒有了）；busy＝已有一個在跑；error＝這次失敗（連不上、沒登入），可以稍後再試。
  // 後台還沒支援（404／400，或舊後台忽略 before 回了最新那批）→ more＝false，這次執行不再問
  async loadOlder(id) {
    const f = this.friends.get(id)
    if (!f || !this.transport.history || this.historyOff || this.olderDone.has(id)) return { more: false, added: 0 }
    if (this.olderBusy.has(id)) return { more: true, added: 0, busy: true }
    this.olderBusy.add(id)
    try {
      for (let i = 0; i < 100 && this.historyBusy.has(id); i++) await new Promise(r => setTimeout(r, 100))   // 打開對話時的那次補記錄還在跑：等它先完成，錨點才準
      const cursor = olderCursor(this.logOf(id))
      if (cursor === null) return { more: false, added: 0 }
      const r = await this.transport.history(f.node, f.agent || '', f.partnerId || null, olderBeforeIso(cursor), OLDER_PAGE)
      const verdict = judgeOlder(r?.messages, cursor, OLDER_PAGE)
      if (!verdict.supported) { this.olderDone.add(id); this.log(`history older ${id}: 後台忽略 before，停止往上載入`); return { more: false, added: 0 } }
      const { log, added } = mergeHistory(this.logOf(id), r?.messages, f.nick, { selfNode: this.selfNode, deviceOf: node => this.#deviceName(node) })
      if (added) {
        this.logs.set(id, log)
        this.olderExtra.set(id, (this.olderExtra.get(id) ?? 0) + added)
        this.#scheduleSave()
        this.emit('log', id)
      }
      const more = verdict.more && added > 0   // 一則都沒補進來也算到底（免得一直問）
      if (!more) this.olderDone.add(id)
      return { more, added }
    } catch (e) {
      this.log(`history older ${id} failed: ${e.message}`)
      if (historyUnsupported(e.message)) { this.olderDone.add(id); return { more: false, added: 0 } }
      return { more: true, added: 0, error: true }
    } finally { this.olderBusy.delete(id) }
  }

  #fail(id, e) {
    this.#log(id).push({ k: 'sys', text: `訊息沒有送到：${friendlySendError(e.message)}`, t: this.now() })
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
  markRead(id) {
    const f = this.friends.get(id)
    if (f) this.#advanceRead(id)
    if (f && f.unread) { f.unread = 0; this.emit('state') }
  }

  // ---------- 已讀多端同步（設計見 docs/design/READ-SYNC.md） ----------
  // 本機讀到這位最後一則收到的信：位置只往前，記進待送清單，等節流計時到了一次送出
  #advanceRead(id) {
    const f = this.friends.get(id)
    const key = f && readKey(f)
    const at = lastIncomingAt(this.logs.get(id))
    if (!key || !at || at <= (this.readMarks[key] ?? 0)) return
    this.readMarks[key] = at
    this.readDirty[key] = at
    this.#scheduleReadSync()
    this.#scheduleSave()
  }
  #scheduleReadSync() {
    if (this.readOff || this.readTimer || typeof this.transport.readSync !== 'function') return
    this.readTimer = setTimeout(() => { this.readTimer = null; void this.syncReads() }, READ_DEBOUNCE_MS)
  }
  // 一次呼叫＝送出待送的已讀位置＋取回整個帳號的已讀位置，合併（取較新）後把已經在別台讀過的未讀消掉。
  // 沒登入（本機行為不變）、後台還沒支援（404，這次執行不再問）、連不上（待送清單留著，下次補送）都靜默
  async syncReads() {
    if (this.readOff || this.readBusy || typeof this.transport.readSync !== 'function') return
    this.readBusy = true
    try {
      const marks = batchOf(this.readDirty)
      const r = await this.transport.readSync({ marks })
      for (const m of marks) if (this.readDirty[m.key] === m.at) delete this.readDirty[m.key]
      if (marks.length) this.#scheduleSave()
      this.#applyRemoteMarks(cleanMarks(r?.marks))
      if (Object.keys(this.readDirty).length) this.#scheduleReadSync()
    } catch (e) {
      if (readSyncUnsupported(e.message)) this.readOff = true
      else if (!readSyncSignedOut(e.message)) this.log(`read_sync failed: ${e.message}`)
    } finally { this.readBusy = false }
  }
  #applyRemoteMarks(remote) {
    let changed = false
    for (const [k, v] of Object.entries(remote)) if (v > (this.readMarks[k] ?? 0)) this.readMarks[k] = v
    for (const f of this.friends.values()) {
      if (!f.unread) continue
      const key = readKey(f)
      const mark = key ? this.readMarks[key] : 0
      if (!mark) continue
      const left = unreadAfter(this.logs.get(f.id), mark)
      if (left < f.unread) { f.unread = left; changed = true }
    }
    if (changed) this.emit('state')
  }
  #log(id) { if (!this.logs.has(id)) this.logs.set(id, []); return this.logs.get(id) }
  logOf(id) { return this.logs.get(id) ?? [] }
  // 畫面要顯示的範圍：最近 VIEW_BASE 列，加上往上載入而多出來的
  viewOf(id) { return this.logOf(id).slice(-(VIEW_BASE + (this.olderExtra.get(id) ?? 0))) }
  snapshot() { return { conn: this.conn, connWhy: this.connWhy, windowName: this.windowName, selfNode: this.selfNode, nodeOrder: [...this.nodeOrder], asn: this.asn, friends: [...this.friends.values()].map(f => ({ ...f })) } }

  // ---------- 存檔 ----------
  #scheduleSave() { if (!this.saveTimer) this.saveTimer = setTimeout(() => { this.saveTimer = null; void this.flush() }, 300) }
  async flush() {
    if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = null }
    const withLog = [...this.friends.values()].filter(f => this.logs.has(f.id) || f.known)
    try {
      await withTimeout(this.store.save({
        friends: withLog.map(savedFriendOf),
        logs: Object.fromEntries(withLog.filter(f => this.logs.has(f.id)).map(f => [f.id, this.logs.get(f.id).slice(-LOG_KEEP)])),
        ...(Object.keys(this.readDirty).length ? { readDirty: this.readDirty } : {}),
      }), this.stepMs, 'save')
    } catch (e) { this.log(`save failed: ${e.message}`) }
  }
}

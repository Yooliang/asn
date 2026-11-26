// 待貼佇列（#2345）：發佈完成或回報產生、但群組通知沒貼成的紀錄。檔案 <state 資料夾>/post-pending.json。
// 格式：{ v: 1, updatedAt, items: [ { id, kind, platform, version, commit, at, createdAt, attempts, lastError, claimedBy, claimedAt } ] }
// 規則：
//   - 每一筆只放上面這些固定欄位，型別固定；多出欄位、型別不對、單筆序列化超過 MAX_ITEM_BYTES 都整筆拒絕。
//   - version 是三段數字（每段最多 6 位）；commit 是 8 位小寫 hex（寫入端只收剛好 40 碼的 SHA、取前 8 碼）；platform 只認 desktop、linux；kind 只認 PENDING_KINDS。
//   - at、createdAt、claimedAt 要與 new Date().toISOString() 往返一致；attempts 0～MAX_ATTEMPTS；claimedBy 0～MAX_CLAIMED_BY。
//   - createdAt 比現在晚超過 FUTURE_TIME_MS 整筆拒絕（寫入、讀取都擋）；claimedAt 同樣，但讀取端不拒絕整筆，由代貼命令當成認領逾時處理。
//   - id ＝ 平台@版號#kind，同一筆重複寫入只留一筆；讀檔時同一個 id 只留第一筆。
//   - 同 id 但 commit 不同：那一筆正被認領中（未逾 CLAIM_TIMEOUT_MS）就不取代、記 log；否則用新的取代，attempts 歸 0、lastError 清空、createdAt 改現在、claimedBy／claimedAt 清掉。commit 相同則不寫檔。
//   - 讀寫都在獨立的 post-pending.json.lock 內進行（不用 state.json.lock）；寫入走 atomicWrite。
//   - 鎖檔時間戳在未來超過 LOCK_FUTURE_MS、或內容讀不懂，視為壞鎖：改名留存並留 pending-bad 告警，再重新取鎖；改名後重讀隔離檔，與改名前讀到的不同就還原並放棄。
//   - 整個檔讀不懂或超過 MAX_FILE_BYTES 時改名成 post-pending.json.bad-<時間>、留 pending-bad 告警，不覆寫。
//   - 檔案讀得懂但有單筆不合格：合格的留下，不合格的另存 post-pending.json.rejected-<時間>，留 pending-bad 告警（帶筆數）。
//   - 筆數超過 MAX_ITEMS 或檔案超過 MAX_FILE_BYTES：新的一筆不寫，留 pending-bad 告警。
//   - 驗證失敗的 warn 只說哪個欄位不合格，不印內容。
import path from 'node:path'
import { atomicWrite, acquireLock, releaseLock, parseLock, makeAlerts } from './auto_publish.mjs'
import { CLAIM_TIMEOUT_MS } from './post_pending_rules.mjs'

export const PENDING_FILE = 'post-pending.json'
export const pendingPathOf = (opts) => path.join(path.dirname(opts.state), PENDING_FILE)

// 平台白名單：與 auto_publish.mjs 的 WORKFLOWS 一致（測試有對照）
export const PENDING_PLATFORMS = ['desktop', 'linux']
// kind：published ＝已發佈但通知沒貼成；其餘是常駐程式的同名回報（ci-failed、blocked、dryrun-failed、publish-failed）沒貼成
export const PENDING_KINDS = ['published', 'ci-failed', 'blocked', 'dryrun-failed', 'publish-failed']
// 待貼佇列的壞檔、壞鎖、檔案過大都發這一類告警；程式不自動 resolve，只能 --ack-alert pending-bad 人工清
export const PENDING_BAD_MESSAGE = '待貼佇列檔或它的鎖不正常，已改名保留、沒有覆寫，請人工檢查'
export const MAX_ITEM_BYTES = 512
export const MAX_FILE_BYTES = 64 * 1024
export const LOCK_FUTURE_MS = 5 * 60 * 1000
// 時間欄位（createdAt、claimedAt）比現在晚超過這個值就不合格：晚的時間永遠不會逾時，會讓項目卡住
export const FUTURE_TIME_MS = 5 * 60 * 1000
export const PENDING_FIELDS = ['at', 'attempts', 'claimedAt', 'claimedBy', 'commit', 'createdAt', 'id', 'kind', 'lastError', 'platform', 'version']

// lastError：只寫進待貼檔給人排錯，不得出現在群組文案或 --post-pending 的輸出。
// 只能是 null，或同時符合下列三條的字串：
//   - 碼點數 ≤ LAST_ERROR_MAX
//   - 加上引號與跳脫後的 JSON 位元組數 ≤ LAST_ERROR_MAX_BYTES
//   - 不含 Unicode 類別 Cc、Cf、Zl、Zp、Cs 的字元（含零寬、雙向控制、落單代理字元）；清洗時直接拿掉
export const LAST_ERROR_MAX = 100
export const LAST_ERROR_MAX_BYTES = 160
const BAD_CHAR_SRC = '[\\p{Cc}\\p{Cf}\\p{Zl}\\p{Zp}\\p{Cs}]'
const BAD_CHAR_RE = new RegExp(BAD_CHAR_SRC, 'u')
const BAD_CHAR_ALL_RE = new RegExp(BAD_CHAR_SRC, 'gu')
const jsonBytes = (s) => Buffer.byteLength(JSON.stringify(s), 'utf8')
// 以完整碼點為單位截斷，字數與位元組數都不超過上限
export function cleanLastError(s) {
  if (typeof s !== 'string') return null
  let out = ''
  let count = 0
  let bytes = 2
  for (const ch of s.replace(BAD_CHAR_ALL_RE, '')) {
    const b = jsonBytes(ch) - 2
    if (count + 1 > LAST_ERROR_MAX || bytes + b > LAST_ERROR_MAX_BYTES) break
    out += ch
    count += 1
    bytes += b
  }
  return out
}
export const isLastError = (s) => typeof s === 'string' && !BAD_CHAR_RE.test(s) && Array.from(s).length <= LAST_ERROR_MAX && jsonBytes(s) <= LAST_ERROR_MAX_BYTES

// 待貼佇列的筆數上限；超過就不再收新的
export const MAX_ITEMS = 50
export const MAX_ATTEMPTS = 1000
export const MAX_CLAIMED_BY = 4294967295

const SEMVER_RE = /^\d{1,6}\.\d{1,6}\.\d{1,6}$/
const COMMIT_RE = /^[0-9a-f]{8}$/
const FULL_SHA_RE = /^[0-9a-f]{40}$/
const ISO_RE = /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/
// 時間欄位：格式對、而且 new Date 往返後完全相同
const isIso = (v) => {
  if (typeof v !== 'string' || !ISO_RE.test(v)) return false
  const t = Date.parse(v)
  return Number.isFinite(t) && new Date(t).toISOString() === v
}

export const isSemver = (v) => typeof v === 'string' && SEMVER_RE.test(v)
export const isCommit = (v) => typeof v === 'string' && COMMIT_RE.test(v)
export const isPlatform = (v) => typeof v === 'string' && PENDING_PLATFORMS.includes(v)
export const isKind = (v) => typeof v === 'string' && PENDING_KINDS.includes(v)
export const pendingId = (platform, version, kind) => `${platform}@${version}#${kind}`

const isFuture = (iso, nowMs) => Date.parse(iso) - nowMs > FUTURE_TIME_MS

// 驗一筆；回 { ok:true, item } 或 { ok:false, field }
// nowMs 有給時，createdAt、claimedAt 比現在晚超過 FUTURE_TIME_MS 都不合格；
// allowFutureClaim：讀取端用，claimedAt 太晚不拒絕整筆（由代貼命令當成認領逾時處理），createdAt 照擋
export function checkItem(x, { nowMs = null, allowFutureClaim = false } = {}) {
  if (!x || typeof x !== 'object' || Array.isArray(x)) return { ok: false, field: 'item' }
  const extra = Object.keys(x).find((k) => !PENDING_FIELDS.includes(k))
  if (extra !== undefined) return { ok: false, field: 'extra' }
  const missing = PENDING_FIELDS.find((k) => !(k in x))
  if (missing !== undefined) return { ok: false, field: missing }
  if (!isKind(x.kind)) return { ok: false, field: 'kind' }
  if (!isPlatform(x.platform)) return { ok: false, field: 'platform' }
  if (!isSemver(x.version)) return { ok: false, field: 'version' }
  if (!isCommit(x.commit)) return { ok: false, field: 'commit' }
  if (x.id !== pendingId(x.platform, x.version, x.kind)) return { ok: false, field: 'id' }
  if (!isIso(x.at)) return { ok: false, field: 'at' }
  if (!isIso(x.createdAt) || (nowMs !== null && isFuture(x.createdAt, nowMs))) return { ok: false, field: 'createdAt' }
  if (!Number.isInteger(x.attempts) || x.attempts < 0 || x.attempts > MAX_ATTEMPTS) return { ok: false, field: 'attempts' }
  if (x.lastError !== null && !isLastError(x.lastError)) return { ok: false, field: 'lastError' }
  if (x.claimedBy !== null && !(Number.isInteger(x.claimedBy) && x.claimedBy >= 0 && x.claimedBy <= MAX_CLAIMED_BY)) return { ok: false, field: 'claimedBy' }
  if (x.claimedAt !== null && (!isIso(x.claimedAt) || (nowMs !== null && !allowFutureClaim && isFuture(x.claimedAt, nowMs)))) return { ok: false, field: 'claimedAt' }
  if (Buffer.byteLength(JSON.stringify(x), 'utf8') > MAX_ITEM_BYTES) return { ok: false, field: 'size' }
  return { ok: true, item: { ...x } }
}

// 驗並丟掉不合格的；warn 只講欄位名，不印欄位內容
export function validateItem(x, warn = console.warn, check = {}) {
  const r = checkItem(x, check)
  if (!r.ok) { warn(`待貼佇列：有一筆的 ${r.field} 欄位不合格，整筆丟掉`); return null }
  return r.item
}

// 由寫入端給的資料組一筆新項目（id、時間、計數由這裡補）；commit 給完整 SHA，取前 8 碼；格式不合格回 null 並 warn
export function buildItem({ kind, platform, version, commit }, nowMs, warn = console.warn) {
  const iso = new Date(nowMs).toISOString()
  const short = typeof commit === 'string' && FULL_SHA_RE.test(commit) ? commit.slice(0, 8) : null
  return validateItem({ id: pendingId(platform, version, kind), kind, platform, version, commit: short, at: iso, createdAt: iso, attempts: 0, lastError: null, claimedBy: null, claimedAt: null }, warn, { nowMs })
}

// 讀佇列；回 { ok:true, items, rejected } 或 { ok:false, bad:true }（整個檔讀不懂或太大，呼叫端要先處理壞檔）
// rejected：檔案讀得懂、但驗證不合格的原始單筆；同一個 id 重複的只留第一筆
export function readPending(opts, deps, warn = console.warn) {
  const p = pendingPathOf(opts)
  if (!deps.exists(p)) return { ok: true, items: [], rejected: [] }
  let doc
  try {
    if (typeof deps.fileSize === 'function' && deps.fileSize(p) > MAX_FILE_BYTES) return { ok: false, bad: true }
    const text = deps.readFile(p)
    if (Buffer.byteLength(text, 'utf8') > MAX_FILE_BYTES) return { ok: false, bad: true }
    doc = JSON.parse(text)
  } catch { return { ok: false, bad: true } }
  if (!doc || typeof doc !== 'object' || doc.v !== 1 || !Array.isArray(doc.items)) return { ok: false, bad: true }
  const items = []
  const rejected = []
  const seen = new Set()
  for (const x of doc.items) {
    const it = validateItem(x, warn, { nowMs: deps.now(), allowFutureClaim: true })
    if (!it) { rejected.push(x); continue }
    if (seen.has(it.id)) continue
    seen.add(it.id)
    items.push(it)
  }
  return { ok: true, items, rejected }
}

export const stampOf = (deps) => new Date(deps.now()).toISOString().replace(/[:.]/g, '-')

export const PENDING_FULL_MESSAGE = '待貼佇列已滿，新的一筆沒有寫入，請人工處理佇列'
export const PENDING_LOCK_BAD_MESSAGE = '待貼佇列的鎖檔不正常，已改名保留，請人工檢查'
export const PENDING_REJECTED_MESSAGE = '待貼佇列有項目格式不合格，已另存到 .rejected 檔，其餘照留，請人工檢查'
const raisePendingBad = (opts, deps, message) => makeAlerts(opts, deps).raiseLine('pending-bad', 'pending-bad', message, 'post-pending')

// 整個檔讀不懂：改名留存、留 pending-bad 告警、不覆寫
export function quarantine(opts, deps) {
  const p = pendingPathOf(opts)
  const to = `${p}.bad-${stampOf(deps)}`
  deps.rename(p, to)
  deps.log(`待貼佇列檔讀不懂或太大，已改名保留為 ${to}（沒有覆寫）`)
  raisePendingBad(opts, deps, PENDING_BAD_MESSAGE)
}

// 只有部分筆不合格：不合格的另存成 .rejected-<時間>、留 pending-bad 告警（帶筆數），合格的留在佇列
export function saveRejected(opts, deps, rejected) {
  const to = `${pendingPathOf(opts)}.rejected-${stampOf(deps)}`
  atomicWrite(deps, to, JSON.stringify({ v: 1, rejectedAt: new Date(deps.now()).toISOString(), items: rejected }, null, 2))
  deps.log(`待貼佇列有 ${rejected.length} 筆不合格，已另存為 ${to}`)
  raisePendingBad(opts, deps, PENDING_REJECTED_MESSAGE)
}

// 壞鎖改名隔離：改名前記下讀到的內容，改名後重讀隔離檔比對；對不上代表搬到的是別人剛換上的鎖，要還原並放棄
function quarantineLock(opts, deps, lockPath, seen, reason) {
  const to = `${lockPath}.bad-${stampOf(deps)}`
  try { deps.rename(lockPath, to) } catch (e) { return { got: false, why: `壞鎖改名失敗：${e.message}` } }
  let moved = null
  try { moved = deps.readFile(to) } catch { /* 讀不到當作不一致 */ }
  if (moved !== seen) {
    if (typeof moved === 'string') {
      try { deps.createLock(lockPath, moved); deps.unlink(to) } catch (e) { deps.log(`搬到的不是壞鎖而是別人剛換上的鎖，且還原失敗（${to}）：${e.message}`) }
    }
    deps.log('待貼佇列的鎖在改名前被換成新的，已還原，這一輪放棄')
    raisePendingBad(opts, deps, PENDING_LOCK_BAD_MESSAGE)
    return { got: false, why: '壞鎖改名時鎖已被換成新的，已還原，這一輪放棄' }
  }
  deps.log(`待貼佇列的鎖檔${reason}，視為壞鎖，已改名為 ${to}`)
  raisePendingBad(opts, deps, PENDING_LOCK_BAD_MESSAGE)
  return null
}

// 取待貼鎖：沿用 acquireLock；鎖檔時間戳在未來超過 LOCK_FUTURE_MS、或內容讀不懂的先當壞鎖處理（只作用在待貼鎖，不影響 state 鎖）
export function acquirePendingLock(opts, deps) {
  const lockPath = `${pendingPathOf(opts)}.lock`
  if (deps.exists(lockPath)) {
    let text = null
    try { text = deps.readFile(lockPath) } catch { /* 讀不到交給 acquireLock 處理 */ }
    if (typeof text === 'string') {
      const { pid, ts } = parseLock(text)
      const unreadable = !Number.isFinite(pid) || !Number.isFinite(ts)
      if (unreadable || ts - deps.now() > LOCK_FUTURE_MS) {
        const failed = quarantineLock(opts, deps, lockPath, text, unreadable ? '內容讀不懂' : '時間戳在未來')
        if (failed) return failed
      }
    }
  }
  return { lockPath, ...acquireLock(lockPath, deps) }
}

// 認領還有效：有認領者與認領時間、認領時間不比現在晚超過 FUTURE_TIME_MS、且未超過 CLAIM_TIMEOUT_MS
const claimIsLive = (x, nowMs) => x.claimedBy !== null && x.claimedAt !== null && !isFuture(x.claimedAt, nowMs) && nowMs - Date.parse(x.claimedAt) < CLAIM_TIMEOUT_MS

// 把新的一筆併進現有清單；沒有要改時回傳同一個陣列（呼叫端據此判斷不用寫檔）
//   - id 沒有：加在最後
//   - id 有、commit 相同：保留
//   - id 有、commit 不同：認領中就不取代（記 log）；否則用新的一筆取代（attempts、lastError、createdAt、認領欄位都重置），取代後再驗一次
function mergeItem(list, item, deps, warn) {
  const old = list.find((x) => x.id === item.id)
  if (!old) return [...list, item]
  if (old.commit === item.commit) return list
  const nowMs = deps.now()
  if (claimIsLive(old, nowMs)) {
    deps.log(`待貼佇列：${item.id} 正被認領中，commit 不同的新一筆先不取代`)
    return list
  }
  const next = validateItem(item, warn, { nowMs })
  if (!next) return list
  deps.log(`待貼佇列：${item.id} 的 commit 不同，已用新的一筆取代`)
  return list.map((x) => (x.id === item.id ? next : x))
}

// 寫入一筆待貼項目。任何失敗只記 log、回 { ok:false, why }，絕不丟例外（不能影響發版結果）
export function enqueuePending(opts, deps, input) {
  const warn = (m) => { deps.log(m); console.warn(m) }
  try {
    const item = buildItem(input, deps.now(), warn)
    if (!item) return { ok: false, why: 'invalid' }
    const p = pendingPathOf(opts)
    const lock = acquirePendingLock(opts, deps)
    if (!lock.got) { deps.log(`待貼佇列的鎖被佔用，這筆沒寫入：${lock.why ?? `pid ${lock.pid ?? '未知'}`}`); return { ok: false, why: 'locked' } }
    try {
      let cur = readPending(opts, deps, warn)
      if (!cur.ok) { quarantine(opts, deps); cur = { ok: true, items: [], rejected: [] } }
      else if (cur.rejected.length > 0) saveRejected(opts, deps, cur.rejected)
      const items = mergeItem(cur.items, item, deps, warn)
      if (items === cur.items && cur.rejected.length === 0) return { ok: true, count: cur.items.length }
      const render = (list) => JSON.stringify({ v: 1, updatedAt: new Date(deps.now()).toISOString(), items: list }, null, 2)
      const text = render(items)
      if (items.length > MAX_ITEMS || Buffer.byteLength(text, 'utf8') > MAX_FILE_BYTES) {
        if (cur.rejected.length > 0) atomicWrite(deps, p, render(cur.items))
        deps.log('待貼佇列已滿，這筆沒寫入')
        raisePendingBad(opts, deps, PENDING_FULL_MESSAGE)
        return { ok: false, why: 'full' }
      }
      atomicWrite(deps, p, text)
      return { ok: true, count: items.length }
    } finally {
      releaseLock(lock.lockPath, deps, lock.content)
    }
  } catch (e) {
    try { deps.log(`寫待貼佇列失敗（不影響發版）：${e.message}`) } catch { /* log 本身壞了也不能往外丟 */ }
    return { ok: false, why: 'error' }
  }
}

// 待貼佇列（#2345）：發佈完成或回報產生、但群組通知沒貼成的紀錄。檔案 <state 資料夾>/post-pending.json。
// 格式：{ v: 1, updatedAt, items: [ { id, kind, platform, version, commit, at, createdAt, attempts, lastError, claimedBy, claimedAt } ] }
// 規則：
//   - 每一筆只放上面這些固定欄位，型別固定；多出欄位、型別不對、單筆序列化超過 MAX_ITEM_BYTES 都整筆拒絕。
//   - version 是三段數字；commit 是 8 位小寫 hex（寫入端由完整 SHA 取前 8 碼）；platform 只認 desktop、linux；kind 只認 PENDING_KINDS。
//   - id ＝ 平台@版號#kind，同一筆重複寫入只留一筆。
//   - 讀寫都在獨立的 post-pending.json.lock 內進行（不用 state.json.lock）；寫入走 atomicWrite。
//   - 鎖檔時間戳在未來超過 LOCK_FUTURE_MS 視為壞鎖：改名留存並留 pending-bad 告警，再重新取鎖。
//   - 檔案讀不懂或超過 MAX_FILE_BYTES 時改名成 post-pending.json.bad-<時間>、留 pending-bad 告警，不覆寫。
//   - 驗證失敗的 warn 只說哪個欄位不合格，不印內容。
import path from 'node:path'
import { atomicWrite, acquireLock, releaseLock, parseLock, makeAlerts } from './auto_publish.mjs'

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
export const PENDING_FIELDS = ['at', 'attempts', 'claimedAt', 'claimedBy', 'commit', 'createdAt', 'id', 'kind', 'lastError', 'platform', 'version']

// lastError：只寫進待貼檔給人排錯，不得出現在群組文案或 --post-pending 的輸出。
// 只能是 null，或 ≤ LAST_ERROR_MAX 字、不含控制字元（C0、DEL、C1、行分隔 U+2028、段分隔 U+2029）的字串
export const LAST_ERROR_MAX = 100
const CONTROL_SRC = '[\\u0000-\\u001f\\u007f-\\u009f\\u2028\\u2029]'
const CONTROL_RE = new RegExp(CONTROL_SRC)
const CONTROL_ALL_RE = new RegExp(CONTROL_SRC, 'g')
export const cleanLastError = (s) => (typeof s === 'string' ? s.replace(CONTROL_ALL_RE, '').slice(0, LAST_ERROR_MAX) : null)

const SEMVER_RE = /^\d+\.\d+\.\d+$/
const COMMIT_RE = /^[0-9a-f]{8}$/
const FULL_SHA_RE = /^[0-9a-f]{8,40}$/
const ISO_RE = /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/

export const isSemver = (v) => typeof v === 'string' && SEMVER_RE.test(v)
export const isCommit = (v) => typeof v === 'string' && COMMIT_RE.test(v)
export const isPlatform = (v) => typeof v === 'string' && PENDING_PLATFORMS.includes(v)
export const isKind = (v) => typeof v === 'string' && PENDING_KINDS.includes(v)
export const pendingId = (platform, version, kind) => `${platform}@${version}#${kind}`

// 驗一筆；回 { ok:true, item } 或 { ok:false, field }
export function checkItem(x) {
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
  if (typeof x.at !== 'string' || !ISO_RE.test(x.at)) return { ok: false, field: 'at' }
  if (typeof x.createdAt !== 'string' || !ISO_RE.test(x.createdAt)) return { ok: false, field: 'createdAt' }
  if (!Number.isInteger(x.attempts) || x.attempts < 0) return { ok: false, field: 'attempts' }
  if (x.lastError !== null && !(typeof x.lastError === 'string' && x.lastError.length <= LAST_ERROR_MAX && !CONTROL_RE.test(x.lastError))) return { ok: false, field: 'lastError' }
  if (x.claimedBy !== null && !Number.isInteger(x.claimedBy)) return { ok: false, field: 'claimedBy' }
  if (x.claimedAt !== null && !(typeof x.claimedAt === 'string' && ISO_RE.test(x.claimedAt))) return { ok: false, field: 'claimedAt' }
  if (Buffer.byteLength(JSON.stringify(x), 'utf8') > MAX_ITEM_BYTES) return { ok: false, field: 'size' }
  return { ok: true, item: { ...x } }
}

// 驗並丟掉不合格的；warn 只講欄位名，不印欄位內容
export function validateItem(x, warn = console.warn) {
  const r = checkItem(x)
  if (!r.ok) { warn(`待貼佇列：有一筆的 ${r.field} 欄位不合格，整筆丟掉`); return null }
  return r.item
}

// 由寫入端給的資料組一筆新項目（id、時間、計數由這裡補）；commit 給完整 SHA，取前 8 碼；格式不合格回 null 並 warn
export function buildItem({ kind, platform, version, commit }, nowMs, warn = console.warn) {
  const iso = new Date(nowMs).toISOString()
  const short = typeof commit === 'string' && FULL_SHA_RE.test(commit) ? commit.slice(0, 8) : commit
  return validateItem({ id: pendingId(platform, version, kind), kind, platform, version, commit: short, at: iso, createdAt: iso, attempts: 0, lastError: null, claimedBy: null, claimedAt: null }, warn)
}

// 讀佇列；回 { ok:true, items } 或 { ok:false, bad:true }（檔案讀不懂或太大，呼叫端要先處理壞檔）
export function readPending(opts, deps, warn = console.warn) {
  const p = pendingPathOf(opts)
  if (!deps.exists(p)) return { ok: true, items: [] }
  let doc
  try {
    const text = deps.readFile(p)
    if (Buffer.byteLength(text, 'utf8') > MAX_FILE_BYTES) return { ok: false, bad: true }
    doc = JSON.parse(text)
  } catch { return { ok: false, bad: true } }
  if (!doc || typeof doc !== 'object' || doc.v !== 1 || !Array.isArray(doc.items)) return { ok: false, bad: true }
  const items = []
  for (const x of doc.items) { const it = validateItem(x, warn); if (it) items.push(it) }
  return { ok: true, items }
}

const stampOf = (deps) => new Date(deps.now()).toISOString().replace(/[:.]/g, '-')

// 壞檔：改名留存、留 pending-bad 告警、不覆寫
function quarantine(opts, deps) {
  const p = pendingPathOf(opts)
  const to = `${p}.bad-${stampOf(deps)}`
  deps.rename(p, to)
  deps.log(`待貼佇列檔讀不懂或太大，已改名保留為 ${to}（沒有覆寫）`)
  makeAlerts(opts, deps).raise('pending-bad', 'pending-bad', PENDING_BAD_MESSAGE, 'post-pending')
}

// 取待貼鎖：沿用 acquireLock；鎖檔時間戳在未來超過 LOCK_FUTURE_MS 的先當壞鎖處理（只作用在待貼鎖，不影響 state 鎖）
export function acquirePendingLock(opts, deps) {
  const lockPath = `${pendingPathOf(opts)}.lock`
  if (deps.exists(lockPath)) {
    let ts = NaN
    try { ts = parseLock(deps.readFile(lockPath)).ts } catch { /* 讀不到交給 acquireLock 處理 */ }
    if (Number.isFinite(ts) && ts - deps.now() > LOCK_FUTURE_MS) {
      const to = `${lockPath}.bad-${stampOf(deps)}`
      try {
        deps.rename(lockPath, to)
        deps.log(`待貼佇列的鎖檔時間戳在未來，視為壞鎖，已改名為 ${to}`)
        makeAlerts(opts, deps).raise('pending-bad', 'pending-bad', PENDING_BAD_MESSAGE, 'post-pending')
      } catch (e) { return { got: false, why: `壞鎖改名失敗：${e.message}` } }
    }
  }
  return { lockPath, ...acquireLock(lockPath, deps) }
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
      if (!cur.ok) { quarantine(opts, deps); cur = { ok: true, items: [] } }
      const items = cur.items.some((x) => x.id === item.id) ? cur.items : [...cur.items, item]
      const text = JSON.stringify({ v: 1, updatedAt: new Date(deps.now()).toISOString(), items }, null, 2)
      if (Buffer.byteLength(text, 'utf8') > MAX_FILE_BYTES) { deps.log('待貼佇列已滿，這筆沒寫入'); return { ok: false, why: 'full' } }
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

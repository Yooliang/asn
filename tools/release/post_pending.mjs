// 待貼佇列（#2345）：發佈已完成、但群組通知沒貼成的紀錄。檔案 <state 資料夾>/post-pending.json。
// 格式：{ v: 1, updatedAt, items: [ { id, kind, platform, version, commit, at, createdAt, attempts, lastError, claimedBy, claimedAt } ] }
// 規則：
//   - 每一筆只放上面這些固定欄位；不放文案、不放群組代號、不放任何自由文字。
//   - id ＝ 平台@版號#kind，同一筆重複寫入只留一筆。
//   - 讀寫都在獨立的 post-pending.json.lock 內進行（不用 state.json.lock）；寫入走 atomicWrite。
//   - 檔案讀不懂時改名成 post-pending.json.bad-<時間>、留 bad-state 告警，不覆寫。
//   - 讀到或要寫入的每一筆都要驗格式（validateItem）；不合格整筆丟掉並 warn，warn 只說哪個欄位不合格，不印原文。
import path from 'node:path'
import { atomicWrite, acquireLock, releaseLock, makeAlerts } from './auto_publish.mjs'

export const PENDING_FILE = 'post-pending.json'
export const pendingPathOf = (opts) => path.join(path.dirname(opts.state), PENDING_FILE)

// 平台白名單：與 auto_publish.mjs 的 WORKFLOWS 一致（測試有對照）
export const PENDING_PLATFORMS = ['desktop', 'linux']
// kind：published ＝已發佈但通知沒貼成；notice ＝常駐程式自己的回報沒貼成
export const PENDING_KINDS = ['published', 'notice']

const SEMVER_RE = /^\d+\.\d+\.\d+(-[0-9A-Za-z]+(\.[0-9A-Za-z]+)*)?$/
const COMMIT_RE = /^[0-9a-f]{40}$/
const ISO_RE = /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/

export const isSemver = (v) => typeof v === 'string' && SEMVER_RE.test(v)
export const isCommit = (v) => typeof v === 'string' && COMMIT_RE.test(v)
export const isPlatform = (v) => typeof v === 'string' && PENDING_PLATFORMS.includes(v)
export const isKind = (v) => typeof v === 'string' && PENDING_KINDS.includes(v)
export const pendingId = (platform, version, kind) => `${platform}@${version}#${kind}`

// 驗一筆；回 { ok:true, item }（只含固定欄位的新物件）或 { ok:false, field }
export function checkItem(x) {
  if (!x || typeof x !== 'object' || Array.isArray(x)) return { ok: false, field: 'item' }
  if (!isKind(x.kind)) return { ok: false, field: 'kind' }
  if (!isPlatform(x.platform)) return { ok: false, field: 'platform' }
  if (!isSemver(x.version)) return { ok: false, field: 'version' }
  if (!isCommit(x.commit)) return { ok: false, field: 'commit' }
  if (x.id !== pendingId(x.platform, x.version, x.kind)) return { ok: false, field: 'id' }
  if (typeof x.at !== 'string' || !ISO_RE.test(x.at)) return { ok: false, field: 'at' }
  if (typeof x.createdAt !== 'string' || !ISO_RE.test(x.createdAt)) return { ok: false, field: 'createdAt' }
  if (!Number.isInteger(x.attempts) || x.attempts < 0) return { ok: false, field: 'attempts' }
  if (x.lastError !== null && !(typeof x.lastError === 'string' && x.lastError.length <= 300)) return { ok: false, field: 'lastError' }
  if (x.claimedBy !== null && !Number.isInteger(x.claimedBy)) return { ok: false, field: 'claimedBy' }
  if (x.claimedAt !== null && !(typeof x.claimedAt === 'string' && ISO_RE.test(x.claimedAt))) return { ok: false, field: 'claimedAt' }
  const { id, kind, platform, version, commit, at, createdAt, attempts, lastError, claimedBy, claimedAt } = x
  return { ok: true, item: { id, kind, platform, version, commit, at, createdAt, attempts, lastError, claimedBy, claimedAt } }
}

// 驗並丟掉不合格的；warn 只講欄位名，不印欄位內容
export function validateItem(x, warn = console.warn) {
  const r = checkItem(x)
  if (!r.ok) { warn(`待貼佇列：有一筆的 ${r.field} 欄位格式不合格，整筆丟掉`); return null }
  return r.item
}

// 由寫入端給的資料組一筆新項目（id、時間、計數由這裡補）；格式不合格回 null 並 warn
export function buildItem({ kind, platform, version, commit }, nowMs, warn = console.warn) {
  const iso = new Date(nowMs).toISOString()
  return validateItem({ id: pendingId(platform, version, kind), kind, platform, version, commit, at: iso, createdAt: iso, attempts: 0, lastError: null, claimedBy: null, claimedAt: null }, warn)
}

// 讀佇列；回 { ok:true, items } 或 { ok:false, bad:true }（檔案讀不懂，呼叫端要先處理壞檔）
export function readPending(opts, deps, warn = console.warn) {
  const p = pendingPathOf(opts)
  if (!deps.exists(p)) return { ok: true, items: [] }
  let doc
  try { doc = JSON.parse(deps.readFile(p)) } catch { return { ok: false, bad: true } }
  if (!doc || typeof doc !== 'object' || doc.v !== 1 || !Array.isArray(doc.items)) return { ok: false, bad: true }
  const items = []
  for (const x of doc.items) { const it = validateItem(x, warn); if (it) items.push(it) }
  return { ok: true, items }
}

// 壞檔：改名留存、留 bad-state 告警、不覆寫
function quarantine(opts, deps) {
  const p = pendingPathOf(opts)
  const stamp = new Date(deps.now()).toISOString().replace(/[:.]/g, '-')
  const to = `${p}.bad-${stamp}`
  deps.rename(p, to)
  deps.log(`待貼佇列檔讀不懂，已改名保留為 ${to}（沒有覆寫）`)
  makeAlerts(opts, deps).raise('bad-state', 'bad-state', '待貼佇列檔讀不懂，已改名保留、沒有覆寫，請人工檢查', 'post-pending')
}

// 寫入一筆待貼項目。任何失敗只記 log、回 { ok:false, why }，絕不丟例外（不能影響發版結果）
export function enqueuePending(opts, deps, input) {
  const warn = (m) => { deps.log(m); console.warn(m) }
  try {
    const item = buildItem(input, deps.now(), warn)
    if (!item) return { ok: false, why: 'invalid' }
    const p = pendingPathOf(opts)
    const lockPath = `${p}.lock`
    const lock = acquireLock(lockPath, deps)
    if (!lock.got) { deps.log(`待貼佇列的鎖被佔用，這筆沒寫入：${lock.why ?? `pid ${lock.pid ?? '未知'}`}`); return { ok: false, why: 'locked' } }
    try {
      let cur = readPending(opts, deps, warn)
      if (!cur.ok) { quarantine(opts, deps); cur = { ok: true, items: [] } }
      const items = cur.items.some((x) => x.id === item.id) ? cur.items : [...cur.items, item]
      atomicWrite(deps, p, JSON.stringify({ v: 1, updatedAt: new Date(deps.now()).toISOString(), items }, null, 2))
      return { ok: true, count: items.length }
    } finally {
      releaseLock(lockPath, deps, lock.content)
    }
  } catch (e) {
    try { deps.log(`寫待貼佇列失敗（不影響發版）：${e.message}`) } catch { /* log 本身壞了也不能往外丟 */ }
    return { ok: false, why: 'error' }
  }
}

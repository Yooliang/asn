// --post-pending 子命令（#2345）：由發版視窗跑，把待貼佇列裡的通知貼到群組。
// 運行手冊：docs/release/自動發佈運行手冊.md。待貼佇列的格式與驗證在 post_pending.mjs，固定規則在 post_pending_rules.mjs。
// 輸出（回傳的 lines）只由固定句、平台、版號、kind、結果組成：不印待貼檔內容、lastError、群組內容或外部指令的輸出。
import { atomicWrite, releaseLock, makeAlerts } from './auto_publish.mjs'
import { readPending, acquirePendingLock, pendingPathOf, quarantine, saveRejected, stampOf, cleanLastError, MAX_ATTEMPTS, FUTURE_TIME_MS } from './post_pending.mjs'
import { MAX_AGE_MS, MAX_PER_RUN, CLAIM_TIMEOUT_MS, POST_FAILED_FIXED, EXPIRED_FIXED, BAD_CLAIM_FIXED, labelOf, composeMessage, loadRoom, defaultConfigPath, checkGithub, roomHas, selfFrom } from './post_pending_rules.mjs'

const iso = (ms) => new Date(ms).toISOString()
const refOf = (item) => `${item.platform}@${item.version}`

// 在待貼鎖內讀、改、寫佇列。fn(items) 回 { items: 新的陣列或 null（不改）, value }。
// 壞檔、不合格的單筆照 PR-1 的規則隔離並發告警。回 { ok:true, items, value } 或 { ok:false }（拿不到鎖）
function withQueue(opts, deps, fn) {
  const lock = acquirePendingLock(opts, deps)
  if (!lock.got) { deps.log(`待貼佇列的鎖被佔用：${lock.why ?? `pid ${lock.pid ?? '未知'}`}`); return { ok: false } }
  try {
    let cur = readPending(opts, deps, (m) => deps.log(m))
    let dirty = false
    if (!cur.ok) { quarantine(opts, deps); cur = { ok: true, items: [], rejected: [] }; dirty = true }
    else if (cur.rejected.length > 0) { saveRejected(opts, deps, cur.rejected); dirty = true }
    const r = fn(cur.items)
    const items = r.items ?? cur.items
    if (r.items !== null || dirty) atomicWrite(deps, pendingPathOf(opts), JSON.stringify({ v: 1, updatedAt: iso(deps.now()), items }, null, 2))
    return { ok: true, items, value: r.value }
  } finally { releaseLock(lock.lockPath, deps, lock.content) }
}

// 認領還有效：認領時間不能比現在晚超過 FUTURE_TIME_MS（太晚的是壞的認領，當成逾時）
const claimFuture = (x, now) => x.claimedAt !== null && Date.parse(x.claimedAt) - now > FUTURE_TIME_MS
const claimLive = (x, now) => x.claimedBy !== null && x.claimedAt !== null && !claimFuture(x, now) && now - Date.parse(x.claimedAt) < CLAIM_TIMEOUT_MS

// 超過期限的移到 .expired 檔（佇列裡不再有）
function expireOld(opts, deps) {
  return withQueue(opts, deps, (items) => {
    const now = deps.now()
    const old = items.filter((x) => now - Date.parse(x.createdAt) > MAX_AGE_MS)
    if (old.length === 0) return { items: null, value: [] }
    atomicWrite(deps, `${pendingPathOf(opts)}.expired-${stampOf(deps)}`, JSON.stringify({ v: 1, expiredAt: iso(now), items: old }, null, 2))
    return { items: items.filter((x) => !old.includes(x)), value: old }
  })
}

// 認領：只有這一筆還在、而且沒有別人還有效的認領時才成功
function claim(opts, deps, id) {
  const at = iso(deps.now())
  const r = withQueue(opts, deps, (items) => {
    const cur = items.find((x) => x.id === id)
    if (!cur || claimLive(cur, deps.now())) return { items: null, value: false }
    return { items: items.map((x) => (x.id === id ? { ...x, claimedBy: deps.pid, claimedAt: at } : x)), value: true }
  })
  return r.ok && r.value === true ? at : null
}

// 確定送出（或群組已經有同則）之後才清這一筆
// 回 { ok }：false＝待貼檔沒更新成（拿不到鎖等），呼叫端要講白話、告警不清
const removeItem = (opts, deps, id) => withQueue(opts, deps, (items) => ({ items: items.filter((x) => x.id !== id), value: null }))

// 失敗：attempts 加 1、寫清洗過的 lastError、放掉自己的認領（認領已被別人接手就不動）
function fail(opts, deps, item, claimAt, text) {
  return withQueue(opts, deps, (items) => ({
    items: items.map((x) => (x.id === item.id && x.claimedBy === deps.pid && x.claimedAt === claimAt
      ? { ...x, attempts: Math.min(MAX_ATTEMPTS, x.attempts + 1), lastError: cleanLastError(text), claimedBy: null, claimedAt: null } : x)),
    value: null,
  }))
}

// 回 { code, lines }
export function runPostPending(opts, deps) {
  const lines = []
  const out = (s) => { lines.push(s) }
  const alerts = makeAlerts(opts, deps)
  const cfg = loadRoom(deps.postConfigPath ?? defaultConfigPath(deps.env), pendingPathOf(opts), deps)
  if (!cfg.ok) return { code: 2, lines: [cfg.msg] }

  const scan = expireOld(opts, deps)
  if (!scan.ok) return { code: 3, lines: ['待貼佇列正在被另一個程序使用，請稍後再試'] }
  for (const x of scan.value) {
    deps.log(`待貼項目超過期限，已移到 .expired 檔：${refOf(x)}#${x.kind}`)
    out(`${labelOf(x)}：超過 48 小時，不再代貼，已移到 .expired 檔`)
  }
  if (scan.value.length > 0) alerts.raise('pending-bad', 'pending-bad', EXPIRED_FIXED, 'post-pending')

  const snapshot = [...scan.items].sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : 1))
  let handled = 0
  // 這一輪確實處理完（已貼出、或群組已有而清掉待貼檔）的項目；只有它們算「恢復」
  const cleared = []
  // 自己的身分（群組裡每則的 from）：整輪只查一次，拿不到就當成讀不到群組、不送
  let meCache
  const me = () => (meCache === undefined ? (meCache = selfFrom(deps)) : meCache)
  const NOT_READ = '讀不到群組最近的訊息，或確認不了自己的身分'
  for (const item of snapshot) {
    if (handled >= MAX_PER_RUN) break
    if (claimFuture(item, deps.now())) {
      deps.log(`待貼項目的認領時間比現在晚，當成認領逾時處理：${refOf(item)}#${item.kind}`)
      alerts.raise('pending-bad', 'bad-claim', BAD_CLAIM_FIXED, 'post-pending')
    }
    if (claimLive(item, deps.now())) { out(`${labelOf(item)}：別人正在處理，略過`); continue }
    handled += 1
    const done = (s) => out(`${labelOf(item)}：${s}`)
    // 待貼檔沒更新成（拿不到鎖等）：這一筆不算處理完，告警維持
    const clear = (okText) => {
      if (removeItem(opts, deps, item.id).ok) { cleared.push(refOf(item)); done(okText) } else done(`${okText.startsWith('已貼') ? '已貼' : '群組已經有這則'}，但待貼檔沒更新`)
    }
    // 認領前先比對一次：群組已經有就只清，不必佔認領
    const pre = roomHas(item, cfg.room, me(), deps)
    if (pre.ok && pre.found) { clear('群組已經有這則，只清掉待貼'); continue }
    const at = claim(opts, deps, item.id)
    if (at === null) { done('認領沒成功（別人先處理了），略過'); continue }
    const stop = (why) => {
      const f = fail(opts, deps, item, at, why)
      alerts.raise('post-failed', 'post-failed', POST_FAILED_FIXED, refOf(item))
      done(f.ok ? `沒有貼：${why}` : `沒有貼：${why}，而且待貼檔沒更新`)
    }
    if (!pre.ok) { stop(NOT_READ); continue }
    const gh = checkGithub(item, deps)
    if (!gh.ok) { stop(gh.why); continue }
    // 認領到送出之間可能有別人貼了：真正送出前再比對一次
    const again = roomHas(item, cfg.room, me(), deps)
    if (!again.ok) { stop(NOT_READ); continue }
    if (again.found) { clear('群組已經有這則，只清掉待貼'); continue }
    let r
    try { r = deps.asnCli(['send', '--room', cfg.room, '--body', composeMessage(item)]) } catch { r = { status: 1 } }
    if (r?.status !== 0) { deps.log(`貼群組失敗：${labelOf(item)}，結束碼 ${Number.isInteger(r?.status) ? r.status : '未知'}`); stop(`送出失敗（結束碼 ${Number.isInteger(r?.status) ? r.status : '未知'}）`); continue }
    clear('已貼到群組')
  }

  // 恢復的條件要同時成立：這一輪至少處理完一筆、佇列已空、而且 post-failed 的每個來源都是這一輪處理完的。
  // 沒進佇列的失敗（寫佇列失敗、來源不明）與這一輪沒處理到的來源，告警一律維持
  const remain = cleared.length > 0 ? alerts.dropRefs('post-failed', cleared) : null
  const left = withQueue(opts, deps, () => ({ items: null, value: null }))
  if (left.ok && left.items.length > 0) out(`佇列還有 ${left.items.length} 筆沒處理完，告警維持`)
  else if (left.ok && remain === 0) alerts.resolve('post-failed')
  else if (left.ok && remain !== null) out('還有不在佇列裡或這一輪沒處理到的失敗，告警維持')
  return { code: 0, lines }
}

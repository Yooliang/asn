import { envGet } from './env-compat.mjs'
// 收信 pull 失敗時的短退避重試（cloud-agent recv 與 machine recv 共用）。
// 預設 5s→10s→20s→40s→60s（上限）；成功後重置。等待退避期間的門鈴會合併成一次 pull，且永不並行兩個 pull。
// 每一輪有整體時限（預設 2 分鐘，#177）：正見的收信程式曾在 10/27 之後停擺五天——pullOnce 裡有一個 await 永遠不結束，
// `pulling` 旗標就一直是 true，之後所有門鈴與輪詢都只設 coalesce、什麼也不做。現在逾時就放掉這一輪（記 log、算一次失敗、走退避重試），
// 舊的那一輪如果晚點才完成，收到的 ctx.stale() 會是 true：它該停手；它做完的事靠 pullOnce 自己的去重（以信件 id）不會和新一輪重複處理。
export const DEFAULT_PULL_BACKOFF_MS = [5_000, 10_000, 20_000, 40_000, 60_000]
export const DEFAULT_ROUND_TIMEOUT_MS = 120_000

// ASN_PULL_BACKOFF_MS（舊名 IRORI_PULL_BACKOFF_MS）="5,10,20"（毫秒，逗號分隔）；測試用短間隔
export function parsePullBackoffMs(env = process.env) {
  const raw = (envGet(env, 'PULL_BACKOFF_MS') || '').trim()
  if (!raw) return undefined
  const arr = raw.split(',').map(s => Number(s.trim())).filter(n => Number.isFinite(n) && n > 0)
  return arr.length ? arr : undefined
}

export function createPullWithRetry({
  pullOnce,
  log,
  sleep = ms => new Promise(r => setTimeout(r, ms)),
  backoffMs = DEFAULT_PULL_BACKOFF_MS,
  roundTimeoutMs = DEFAULT_ROUND_TIMEOUT_MS,
  now = () => Date.now(),
}) {
  const steps = backoffMs.length ? backoffMs : DEFAULT_PULL_BACKOFF_MS
  let pulling = false
  let coalesce = false
  let failStep = 0
  let retryPending = false
  let retryToken = 0
  let retryTimer = null
  let destroyed = false
  const scheduledDelays = []
  // 觀測用：最近一次成功、逾時次數、目前這一輪開始的時間（log 與測試用）
  const stats = { rounds: 0, ok: 0, failed: 0, timeouts: 0, lastOkAt: null, lastStartAt: null }

  const delayFor = step => steps[Math.min(step, steps.length - 1)]

  function clearRetryTimer() {
    if (retryTimer != null) {
      clearTimeout(retryTimer)
      retryTimer = null
    }
  }

  function clearRetry() {
    retryPending = false
    retryToken++
    clearRetryTimer()
  }

  class RoundTimeout extends Error {}

  // 一輪（含合併進來的補拉）。ctx.stale()：這一輪已經被放棄（逾時或關閉），該停手
  async function runBatch(ctx) {
    do { coalesce = false; await pullOnce(ctx) } while (coalesce && !ctx.stale())
  }

  // 整體時限：逾時就放掉這一輪（不取消它，JS 沒辦法；它之後的結果和錯誤都吞掉，只會被 ctx.stale() 擋住繼續做事）
  function withDeadline(work, ctx) {
    let timer
    const limit = new Promise((_, reject) => {
      timer = setTimeout(() => { ctx.stale = () => true; reject(new RoundTimeout(`pull round exceeded ${roundTimeoutMs}ms`)) }, roundTimeoutMs)
    })
    work.catch(() => {})   // 被放棄的那一輪之後才失敗：不能變成 unhandled rejection
    return Promise.race([work, limit]).finally(() => clearTimeout(timer))
  }

  async function executePull(why) {
    if (destroyed) return
    if (pulling) { coalesce = true; return }
    pulling = true
    clearRetry()
    let needsRetry = false
    const ctx = { stale: () => destroyed }
    stats.rounds++
    stats.lastStartAt = now()
    try {
      await withDeadline(runBatch(ctx), ctx)
      failStep = 0
      stats.ok++
      stats.lastOkAt = now()
    } catch (e) {
      if (e instanceof RoundTimeout) {
        stats.timeouts++
        log(`pull timed out (${why}): ${e.message}; abandoning this round and retrying`)
      } else {
        log(`pull failed (${why}): ${e.message}`)
      }
      stats.failed++
      needsRetry = true
    } finally {
      pulling = false
      if (destroyed) return
      if (needsRetry) scheduleRetry()
      else if (coalesce) void executePull('coalesce')
    }
  }

  function scheduleRetry() {
    if (destroyed || retryPending || pulling) return
    const delay = delayFor(failStep)
    scheduledDelays.push(delay)
    failStep = Math.min(failStep + 1, steps.length - 1)
    retryPending = true
    const token = ++retryToken
    clearRetryTimer()
    retryTimer = setTimeout(() => {
      retryTimer = null
      void (async () => {
        if (destroyed || !retryPending || token !== retryToken) return
        retryPending = false
        await executePull('retry')
      })()
    }, delay)
    retryTimer.unref?.()
  }

  function pull(why) {
    if (destroyed) return Promise.resolve()
    if (pulling) { coalesce = true; return Promise.resolve() }
    if (retryPending) { clearRetry(); return executePull(why) }
    return executePull(why)
  }

  function destroy() {
    destroyed = true
    clearRetry()
    pulling = false
    coalesce = false
  }

  return {
    pull, executePull, destroy, getFailStep: () => failStep, isRetryPending: () => retryPending,
    getStats: () => ({ ...stats, pulling }),
    getScheduledDelays: () => [...scheduledDelays], _delayFor: delayFor,
  }
}

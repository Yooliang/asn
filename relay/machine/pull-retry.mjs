// 收信 pull 失敗時的短退避重試（cloud-agent recv 與 machine recv 共用）。
// 預設 5s→10s→20s→40s→60s（上限）；成功後重置。等待退避期間的門鈴會合併成一次 pull，且永不並行兩個 pull。
export const DEFAULT_PULL_BACKOFF_MS = [5_000, 10_000, 20_000, 40_000, 60_000]

// IRORI_PULL_BACKOFF_MS="5,10,20"（毫秒，逗號分隔）；測試用短間隔
export function parsePullBackoffMs(env = process.env) {
  const raw = (env.IRORI_PULL_BACKOFF_MS || '').trim()
  if (!raw) return undefined
  const arr = raw.split(',').map(s => Number(s.trim())).filter(n => Number.isFinite(n) && n > 0)
  return arr.length ? arr : undefined
}

export function createPullWithRetry({
  pullOnce,
  log,
  sleep = ms => new Promise(r => setTimeout(r, ms)),
  backoffMs = DEFAULT_PULL_BACKOFF_MS,
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

  async function runBatch() {
    do { coalesce = false; await pullOnce() } while (coalesce)
  }

  async function executePull(why) {
    if (destroyed) return
    if (pulling) { coalesce = true; return }
    pulling = true
    clearRetry()
    let needsRetry = false
    try {
      await runBatch()
      failStep = 0
    } catch (e) {
      log(`pull failed (${why}): ${e.message}`)
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
    getScheduledDelays: () => [...scheduledDelays], _delayFor: delayFor,
  }
}

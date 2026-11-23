// 別台帳號回報的「自動重讀」（#2158，電腦版、手機版共用這一份判斷與排程；node 與瀏覽器都能跑）。
// 以前別台的回報只在第一次出現時讀一次，之後不重讀，開超過 15 分鐘（REPORT_FRESH_MS）每台在線的別台都變成「沒收到回報」。
// 現在：設備頁（含帳號頁）開著時，每 REPORT_RELOAD_MS（5 分鐘）把各台的回報重讀一次；讀失敗的照舊 REPORT_RETRY_MS（1 分鐘）後再讀。
// 排程只在頁面開著時跑，頁面關掉就停；同一台正在讀就不再發。畫面上的四種狀態看 device-state.mjs 的 deviceReportStatus。
import { REPORT_RELOAD_MS, REPORT_RETRY_MS, reportFreshness, shouldRetryReport } from './device-state.mjs'

/**
 * 讀完一台的回報，算出要存的新紀錄（純函式）。
 * prev：上一筆紀錄；outcome：{ value }（後台回的 { asn_online, reported_at, accounts }）或 { error }（給畫面的白話）
 * failCount＝連續沒讀到新回報的次數：讀失敗、或讀到的回報仍然過期（那台在線卻沒在回報）都算；讀到新的就歸零。
 * 計次要間隔：距上次計次滿 REPORT_RELOAD_MS（5 分鐘）才再 +1（countedAt 記上次計次的時間）。失敗後每分鐘照樣重試，讀到就恢復，
 * 但畫面要等第一次失敗後約 5 分鐘仍讀不到才說「讀不到」（設計定案），不會因為每分鐘重試而 2 分鐘就跳出來
 */
export function nextReport(prev, outcome, now) {
  const before = prev?.failCount ?? 0
  const due = !before || !Number.isFinite(prev?.countedAt) || now - prev.countedAt >= REPORT_RELOAD_MS
  const failCount = due ? before + 1 : before
  const countedAt = due ? now : prev.countedAt
  if (outcome?.error !== undefined) return { error: String(outcome.error) || '讀取失敗', failedAt: now, asnOnline: false, reportedAt: '', accounts: [], readAt: now, failCount, countedAt }
  const v = outcome?.value
  const rep = { error: '', asnOnline: v?.asn_online === true, reportedAt: v?.reported_at ?? '', accounts: v?.accounts ?? [], readAt: now }
  return reportFreshness(rep, now) === 'fresh' ? { ...rep, failCount: 0 } : { ...rep, failCount, countedAt }
}

/**
 * 這一輪該重讀哪幾台。reports：節點 → 紀錄（可以是手機版存的形狀；failedOf 判斷「這筆是不是讀失敗」，預設看 error，手機版看 msg）。
 * 沒讀過的 → 讀（離線的也讀一次）；離線中的設備讀過就不再重讀（isOnline 回 false；剛登入 force 也一樣）；上次讀失敗的 → 過了 retryMs 才再讀（force＝剛登入，不等）；讀成功的 → 距離上次讀超過 reloadMs 就重讀（沒記時間的視為該重讀）
 */
export function reportsDue({ nodes = [], reports = {}, now = Date.now(), retryMs = REPORT_RETRY_MS, reloadMs = REPORT_RELOAD_MS, force = false, failedOf = r => Boolean(r?.error), isOnline = () => true } = {}) {
  return [...new Set(nodes)].filter(n => {
    if (!n) return false
    const rep = reports[n]
    if (!rep) return true   // 沒讀過的（含離線的）至少讀一次
    if (!isOnline(n)) return false   // 離線中的設備不重讀：不然讀取報錯時每分鐘打一次（#2160 一審）
    if (rep.loading === true) return false   // 手機版：點進去的那次讀取還在跑
    if (failedOf(rep)) return force || shouldRetryReport({ read: true, failedAt: rep.failedAt ?? Number.NaN }, now, retryMs)
    return now - (rep.readAt ?? 0) >= reloadMs
  })
}

/**
 * 排程：start() 立刻跑一輪（immediate: false 就不跑這一輪）、之後每 everyMs 跑一輪；stop() 停掉（設備頁關掉時呼叫）。
 * run：一輪要做的事（讀該讀的回報）；isOpen：頁面是不是還開著，關了就自己停（保險，防呼叫端漏了 stop）。上一輪還沒跑完不重疊。
 * isVisible／onVisibleChange：App 在背景（document.visibilityState 不是 visible）時不排程重讀；回到前景（onVisibleChange 的回呼被叫）立刻補一次。
 * 預設看 document；沒有 document（測試、node）就一直當成在前景
 */
const docVisible = () => !globalThis.document || globalThis.document.visibilityState === 'visible'
const docWatch = cb => {
  const d = globalThis.document
  if (!d?.addEventListener) return () => {}
  d.addEventListener('visibilitychange', cb)
  return () => d.removeEventListener('visibilitychange', cb)
}
export function createReportScheduler({ run, isOpen = () => true, everyMs = REPORT_RETRY_MS, setTimer = (f, ms) => setInterval(f, ms), clearTimer = id => clearInterval(id), log = (...a) => console.info(...a), isVisible = docVisible, onVisibleChange = docWatch } = {}) {
  let timer = null
  let running = false
  let unwatch = null
  const tick = async () => {
    if (!isOpen()) { stop(); return 0 }
    if (!isVisible()) return 0   // 背景：不讀，回到前景再補
    if (running) return 0
    running = true
    try { return (await run()) ?? 0 } catch (e) { log('[帳號回報] 自動重讀失敗：', String(e?.message ?? e)); return 0 } finally { running = false }
  }
  function stop() {
    if (timer !== null) { clearTimer(timer); timer = null }
    if (unwatch) { unwatch(); unwatch = null }
  }
  function start({ immediate = true } = {}) {
    if (timer !== null) return
    timer = setTimer(() => { void tick() }, everyMs)
    unwatch = onVisibleChange(() => { if (isVisible()) void tick() })   // 回到前景立刻補一次
    if (immediate) void tick()
  }
  return { start, stop, tick, get active() { return timer !== null } }
}

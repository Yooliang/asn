// 別台帳號回報的「自動重讀」（#2158，電腦版、手機版共用這一份判斷與排程；node 與瀏覽器都能跑）。
// 以前別台的回報只在第一次出現時讀一次，之後不重讀，開超過 15 分鐘（REPORT_FRESH_MS）每台在線的別台都變成「沒收到回報」。
// 現在：設備頁（含帳號頁）開著時，每 REPORT_RELOAD_MS（5 分鐘）把各台的回報重讀一次；讀失敗的照舊 REPORT_RETRY_MS（1 分鐘）後再讀。
// 排程只在頁面開著時跑，頁面關掉就停；同一台正在讀就不再發。畫面上的四種狀態看 device-state.mjs 的 deviceReportStatus。
import { REPORT_RELOAD_MS, REPORT_RETRY_MS, reportFreshness, shouldRetryReport } from './device-state.mjs'

/**
 * 讀完一台的回報，算出要存的新紀錄（純函式）。
 * prev：上一筆紀錄；outcome：{ value }（後台回的 { asn_online, reported_at, accounts }）或 { error }（給畫面的白話）
 * failCount＝連續沒讀到新回報的次數：讀失敗、或讀到的回報仍然過期（那台在線卻沒在回報）都算一次；讀到新的就歸零
 */
export function nextReport(prev, outcome, now) {
  const failCount = (prev?.failCount ?? 0) + 1
  if (outcome?.error !== undefined) return { error: String(outcome.error) || '讀取失敗', failedAt: now, asnOnline: false, reportedAt: '', accounts: [], readAt: now, failCount }
  const v = outcome?.value
  const rep = { error: '', asnOnline: v?.asn_online === true, reportedAt: v?.reported_at ?? '', accounts: v?.accounts ?? [], readAt: now }
  return { ...rep, failCount: reportFreshness(rep, now) === 'fresh' ? 0 : failCount }
}

/**
 * 這一輪該重讀哪幾台。reports：節點 → 紀錄（可以是手機版存的形狀；failedOf 判斷「這筆是不是讀失敗」，預設看 error，手機版看 msg）。
 * 沒讀過的 → 讀；上次讀失敗的 → 過了 retryMs 才再讀（force＝剛登入，不等）；讀成功的 → 距離上次讀超過 reloadMs 就重讀（沒記時間的視為該重讀）
 */
export function reportsDue({ nodes = [], reports = {}, now = Date.now(), retryMs = REPORT_RETRY_MS, reloadMs = REPORT_RELOAD_MS, force = false, failedOf = r => Boolean(r?.error) } = {}) {
  return [...new Set(nodes)].filter(n => {
    if (!n) return false
    const rep = reports[n]
    if (!rep) return true
    if (rep.loading === true) return false   // 手機版：點進去的那次讀取還在跑
    if (failedOf(rep)) return force || shouldRetryReport({ read: true, failedAt: rep.failedAt ?? Number.NaN }, now, retryMs)
    return now - (rep.readAt ?? 0) >= reloadMs
  })
}

/**
 * 排程：start() 立刻跑一輪（immediate: false 就不跑這一輪）、之後每 everyMs 跑一輪；stop() 停掉（設備頁關掉時呼叫）。
 * run：一輪要做的事（讀該讀的回報）；isOpen：頁面是不是還開著，關了就自己停（保險，防呼叫端漏了 stop）。上一輪還沒跑完不重疊。
 */
export function createReportScheduler({ run, isOpen = () => true, everyMs = REPORT_RETRY_MS, setTimer = (f, ms) => setInterval(f, ms), clearTimer = id => clearInterval(id), log = (...a) => console.info(...a) } = {}) {
  let timer = null
  let running = false
  const tick = async () => {
    if (!isOpen()) { stop(); return 0 }
    if (running) return 0
    running = true
    try { return (await run()) ?? 0 } catch (e) { log('[帳號回報] 自動重讀失敗：', String(e?.message ?? e)); return 0 } finally { running = false }
  }
  function stop() { if (timer !== null) { clearTimer(timer); timer = null } }
  function start({ immediate = true } = {}) {
    if (timer !== null) return
    timer = setTimer(() => { void tick() }, everyMs)
    if (immediate) void tick()
  }
  return { start, stop, tick, get active() { return timer !== null } }
}

// 通話中快速收信（#99 第二期）：平常是門鈴即時通知＋每兩分鐘輪詢備援；通話期間每 2 秒多收一次信，通話結束就不再多收。
// 只有一個固定的計時器，每次醒來先問「現在有沒有通話」，沒有就什麼都不做；stop() 清掉它，不會殘留。
// 純邏輯＋注入計時器與收信，好測（見 test/call-poll.test.mjs）。
export const CALL_POLL_MS = 2000

export function startCallPoll({ anyCall, pull, ms = CALL_POLL_MS, setTick = (f, t) => setInterval(f, t), clearTick = id => clearInterval(id) }) {
  let id = setTick(() => {
    let on = false
    try { on = !!anyCall() } catch { on = false }
    if (on) { try { void Promise.resolve(pull('call')).catch(() => {}) } catch { /* 收信自己會記錄失敗 */ } }
  }, ms)
  return { stop() { if (id !== null) { clearTick(id); id = null } } }
}

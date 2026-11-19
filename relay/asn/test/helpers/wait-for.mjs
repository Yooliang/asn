// 測試用的 waitFor：每 10ms 看一次條件，成立就回傳條件的值；超過上限丟錯並帶說明。
// 用它取代「睡固定毫秒數再斷言」（await new Promise(r => setTimeout(r, 500))）：機器快就早點過、慢就多等，不會偶發紅。
//   await waitFor(() => core.state.ready, { timeout: 2000, what: '核心就緒' })
//   const v = await waitFor(() => emitted.find(e => e[0] === 'done'))   // 回傳第一個真值
// cond 可以是同步或 async 函式；回傳 falsy＝還沒好；丟錯＝直接把錯往外丟（不吞）。
export const WAIT_STEP_MS = 10
export const WAIT_TIMEOUT_MS = 2000

export async function waitFor(cond, { timeout = WAIT_TIMEOUT_MS, step = WAIT_STEP_MS, what = '條件' } = {}) {
  const t0 = Date.now()
  for (;;) {
    const v = await cond()
    if (v) return v
    if (Date.now() - t0 >= timeout) {
      throw new Error(`waitFor 逾時：${what}在 ${timeout}ms 內沒有成立（每 ${step}ms 檢查一次）。條件寫對了嗎？要等的事件真的會發生嗎？不要改成更長的固定等待。`)
    }
    await new Promise(r => setTimeout(r, step))
  }
}

// 終端畫面的測試共用（#2038 PR-6）：真的事件中心＋假的底層 listen（記下註冊、取消，可延遲放行）
// 用法：const rh = rigHub(); 把 rh.hub 交給元件／工作階段；rh.fire(事件, 內容) 模擬 Rust 送來；rh.handlers[事件](內容) 是同一件事的簡寫
import { createEventHub } from '../../ui/lib/event-hub.mjs'

// failOn：這些事件名的底層 listen 會被拒絕（模擬沒有事件通道／註冊失敗）；warn：收橋記的 warn 那一行
export function rigHub({ gated = false, failOn = [], warns = [] } = {}) {
  const live = {}        // 事件名 → 底層還沒取消的回呼（Set）
  const registered = []  // 底層註冊過的事件名（含已取消的）
  const gates = []       // gated 時：還沒放行的註冊
  const state = { offs: 0 }
  const listen = (evt, fn) => {
    registered.push(evt)
    if (failOn.includes(evt)) return Promise.reject(new Error('no channel: ' + evt))
    const reg = () => {
      ;(live[evt] ??= new Set()).add(fn)
      return () => { state.offs++; live[evt]?.delete(fn) }
    }
    if (!gated) return Promise.resolve(reg())
    return new Promise(res => gates.push(() => res(reg())))
  }
  const hub = createEventHub({ listen, warn: m => warns.push(m) })
  const fire = (evt, payload) => { for (const fn of [...(live[evt] ?? [])]) fn(payload) }
  const handlers = new Proxy({}, { get: (_, evt) => payload => fire(String(evt), payload) })
  return {
    hub, fire, handlers, registered, state,
    liveCount: evt => live[evt]?.size ?? 0,
    liveTotal: () => Object.values(live).reduce((n, s) => n + s.size, 0),
    pendingGates: () => gates.length,
    // 先取走前 n 個還在等的註冊（不放行），回傳「放行這幾個」的函式；用來安排「舊的晚到」
    take(n) { const g = gates.splice(0, n); return () => { for (const f of g) f() } },
    // 放行所有還在等的註冊
    async release() { const g = gates.splice(0); for (const f of g) f(); await hub.ready() },
  }
}

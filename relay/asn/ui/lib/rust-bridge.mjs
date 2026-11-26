// Rust 事件橋（#2038）：每個事件名最多掛一個底層 listener。
// 有人訂閱才註冊、最後一個人退訂就取消；底層 listen 是非同步的，所以要處理「還沒註冊完就退訂」「退訂後馬上又訂閱」的交錯。
// 這裡不碰 __TAURI__：listen 由外面注入（唯一的注入點在 tauri.mjs），形狀＝ (evt, fn) => Promise<() => void>，fn 收到的是 payload。
const safeOff = off => { if (typeof off !== 'function') return; try { off() } catch { /* 取消失敗（視窗已關）：沒有可補救的，不影響其他事件 */ } }

export function createRustBridge({ listen = null, dispatch, log = () => {}, warn = log }) {
  // 每個事件名一格：count＝訂閱者數；gen＝世代號（退訂就加一，讓舊的註冊結果與舊回呼失效）；state＝idle｜starting｜on｜failed
  const slots = new Map()
  let listenFn = listen, disposed = false
  const slotOf = name => {
    let s = slots.get(name)
    if (!s) { s = { count: 0, gen: 0, state: 'idle', off: null, pending: null }; slots.set(name, s) }
    return s
  }
  const stop = s => {
    s.gen++   // 還在註冊的那一次，回來時發現世代不符就自己取消
    const off = s.off
    s.off = null; s.pending = null; s.state = 'idle'
    safeOff(off)
  }
  const start = (name, s) => {
    if (!listenFn || disposed || s.state !== 'idle') return
    const gen = ++s.gen
    s.state = 'starting'
    // new Promise 包起來：listen 同步丟錯（沒有 Tauri）也走 catch，不會漏出去
    s.pending = new Promise(res => res(listenFn(name, payload => { if (s.gen === gen) dispatch(name, payload) })))
      .then(off => {
        if (s.gen !== gen) { safeOff(off); return }   // 註冊期間已退訂（或退訂又重訂）：這個 listener 不要了
        s.off = off; s.state = 'on'
      })
      .catch(e => {
        if (s.gen !== gen) return
        s.state = 'failed'   // 沒有事件通道（純網頁、測試、舊殼）：記一行（warn 等級），不重試，等全部退訂後才會再試
        s.why = String(e?.message ?? e)
        warn(`listen ${name} failed: ${s.why}`)
      })
  }
  return {
    // 訂閱一個事件名；回傳取消函式（可重複呼叫）
    acquire(name) {
      if (disposed) return () => {}
      const s = slotOf(name)
      s.count++
      if (s.count === 1) start(name, s)
      let done = false
      return () => {
        if (done) return
        done = true
        s.count--
        if (s.count === 0) stop(s)
      }
    },
    // 後接 listen（hub 先建、之後才綁橋）：已經有人訂閱的事件現在補註冊。只能接一次
    attach(fn) {
      if (listenFn) { log('rust bridge already attached'); return }
      listenFn = fn
      for (const [name, s] of slots) if (s.count > 0) start(name, s)
    },
    // 目前所有已發出的註冊都完成（成功或失敗）
    async ready() { await Promise.all([...slots.values()].map(s => s.pending).filter(Boolean)) },
    // 只等指定的事件，而且要求它們真的註冊成功：任何一個沒有人訂閱、沒有事件通道、或 listen 失敗就丟錯（呼叫端接回自己的錯誤路徑）。
    // 空陣列、不是陣列都丟錯：空集合恆真會讓「什麼都沒等」看起來像已就緒。ready() 不受影響，照舊一定 resolve
    async readyFor(names) {
      if (!Array.isArray(names) || names.length === 0) throw new Error('readyFor 要給至少一個事件名')
      const picked = names.map(n => [n, slots.get(n)])
      const missing = picked.filter(([, s]) => !s || s.count <= 0).map(([n]) => n)
      if (missing.length) throw new Error(`還沒訂閱：${missing.join('、')}`)
      await Promise.all(picked.map(([, s]) => s.pending).filter(Boolean))
      const bad = picked.filter(([, s]) => s.state !== 'on')
      if (bad.length) throw new Error(`事件沒有註冊成功：${bad.map(([n, s]) => `${n}（${s.state}${s.why ? '：' + s.why : ''}）`).join('、')}`)
    },
    dispose() {
      disposed = true
      for (const s of slots.values()) { s.count = 0; stop(s) }
      slots.clear()
    },
  }
}

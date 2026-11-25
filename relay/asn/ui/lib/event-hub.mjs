// 事件中心（#2038）：畫面檔訂閱事件的唯一介面。
// - 內部事件（AsnCore 的 state／log／notify／avatars）：emit 直接扇出給訂閱者。
// - Rust 事件（事件表 rust-events.mjs 登記的）：第一個訂閱者進來才向橋註冊，最後一個退訂就取消，同名事件最多一個底層 listener。
// listen／emit／emitTo 都由外面注入（注入點在 tauri.mjs），這裡不碰 __TAURI__。
//   listen: (evt, fn) => Promise<() => void>，fn 收到的是 payload
//   emit: (evt, payload) => Promise（視窗之間廣播）；emitTo: (label, evt, payload) => Promise（送給指定視窗）
import { RUST_EVENTS } from './rust-events.mjs'
import { createRustBridge } from './rust-bridge.mjs'

export function createEventHub({ listen = null, emit = null, emitTo = null, events = RUST_EVENTS, log = () => {} } = {}) {
  let handlers = new Map()   // 事件名 → 訂閱項陣列（不就地改，換新陣列，扇出到一半有人退訂也安全）
  const bridge = createRustBridge({ listen, log, dispatch: (evt, arg) => hub.emit(evt, arg) })
  const hub = {
    // 訂閱；回傳取消函式（可重複呼叫）
    subscribe(evt, fn) {
      const entry = { fn, active: true, unsub: null }
      handlers = new Map(handlers).set(evt, [...(handlers.get(evt) ?? []), entry])
      const release = Object.hasOwn(events, evt) ? bridge.acquire(evt) : () => {}
      entry.unsub = () => {
        if (!entry.active) return
        entry.active = false
        const rest = (handlers.get(evt) ?? []).filter(x => x !== entry)
        const next = new Map(handlers)
        if (rest.length) next.set(evt, rest); else next.delete(evt)
        handlers = next
        release()
      }
      return entry.unsub
    },
    // 舊介面：回傳 hub 本身，可串接（AsnCore.on 以前就是這樣）
    on(evt, fn) { hub.subscribe(evt, fn); return hub },
    // 取消第一個登記這個函式的訂閱
    off(evt, fn) {
      const entry = (handlers.get(evt) ?? []).find(x => x.fn === fn)
      entry?.unsub()
      return hub
    },
    // 本視窗內扇出：逐一呼叫，例外 try/catch 後記一行（不中斷同事件的其他處理器）
    emit(evt, arg) {
      for (const entry of handlers.get(evt) ?? []) {
        if (!entry.active) continue
        try { entry.fn(arg) } catch (e) { log(`handler ${evt}: ${e.message}`) }
      }
    },
    // 視窗之間廣播／送給指定視窗（沒注入就什麼都不做）
    broadcast: (evt, payload) => (emit ? emit(evt, payload) : Promise.resolve()),
    sendTo: (label, evt, payload) => (emitTo ? emitTo(label, evt, payload) : Promise.resolve()),
    // 後接 listen（AsnCore 先建 hub，tauri.mjs 的 bindRustEvents 再綁）：已有人訂閱的事件現在補註冊
    attachRust: fn => bridge.attach(fn),
    ready: () => bridge.ready(),
    dispose() { handlers = new Map(); bridge.dispose() },
  }
  return hub
}

// 沒有 AsnCore 的子視窗（chat、panel、setup-progress…）用的輕量 hub：只有 hub＋橋，不跑收信輪詢
export const createWindowHub = ({ listen, emit = null, emitTo = null, events = RUST_EVENTS, log = () => {} }) => createEventHub({ listen, emit, emitTo, events, log })

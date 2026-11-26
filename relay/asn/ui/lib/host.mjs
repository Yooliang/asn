// 主機接縫（#1763 F3）：前端讀主機物件（Tauri 的 __TAURI__）的唯一一處（不經打包的 skin-boot.js 除外，它不能 import）。
// 一個執行環境（Tauri 電腦版、Tauri 手機、之後的網頁殼、測試）提供給前端的最小能力，電腦版與手機版共用同一個 host。
// 名稱是平的（host.listen，不是 host.events.listen）；改名前先在 #1763 通知調查員（#2038 事件中心跟著這個形狀）。
//   available：有沒有後端可以呼叫（core.invoke 在不在）
//   hasEvent：有沒有事件通道（event 在不在；沒有 invoke 只有事件的環境也要能收事件）
//   invoke：（指令名, 參數）回 Promise；錯誤照原樣丟（拆錯誤代號留在 tauri.mjs 的出口）
//   listen(evt, fn)：回 Promise<unlisten>；fn 收到的是 payload，不是事件物件
//   emit(evt, payload)／emitTo(target, evt, payload)：視窗之間廣播／送給指定視窗（簽名照 Tauri）
//   window：沒有視窗物件時是 null；有就帶 startResizeDragging(方向名)
export function makeHost(raw = globalThis.__TAURI__) {
  return {
    available: Boolean(raw?.core?.invoke),
    hasEvent: Boolean(raw?.event),
    invoke: (cmd, args) => raw.core.invoke(cmd, args),
    listen: (evt, fn) => raw.event.listen(evt, e => fn(e.payload)),
    emit: (evt, payload) => raw.event.emit(evt, payload),
    emitTo: (target, evt, payload) => raw.event.emitTo(target, evt, payload),
    window: raw?.window ? { startResizeDragging: dir => raw.window.getCurrentWindow().startResizeDragging(dir) } : null,
  }
}
// 模組載入時就建好（和以前 tauri.mjs 載入時讀主機物件的時機一樣）
export let host = makeHost()
const bootHost = host
export const setHost = h => { host = h }   // 網頁殼、測試注入用
// 有人用 setHost 換過沒有：tauri.mjs 沒換過就用自己載入當下建的那份（測試會對同一支 tauri.mjs 用不同的假主機重複載入），換過就走換進來的
export const isInjected = () => host !== bootHost

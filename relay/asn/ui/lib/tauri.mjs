// Tauri 前端小橋：invoke／事件。錯誤一律包成 Error(字串)，讓 AsnCore 用 e.message 處理。
const T = globalThis.__TAURI__

export const invoke = async (cmd, args) => {
  try { return await T.core.invoke(cmd, args) } catch (e) { throw new Error(typeof e === 'string' ? e : (e?.message ?? String(e))) }
}
export const listen = (evt, fn) => T.event.listen(evt, e => fn(e.payload))
export const emit = (evt, payload) => T.event.emit(evt, payload)
export const ctl = op => invoke('win_ctl', { op })

// 給 AsnCore 的 transport：HTTP 與金鑰都在 Rust 端，這裡拿不到金鑰
export const transport = {
  list: () => invoke('relay_list'),
  inbox: () => invoke('relay_inbox'),
  ack: ids => invoke('relay_ack', { ids }),
  rooms: () => invoke('relay_rooms'),
  send: payload => invoke('relay_send', { payload }),
  avatar: node => invoke('relay_avatar', { node }),                 // 某台設備上傳的大頭貼（按需取）
  setAvatar: avatar => invoke('relay_set_avatar', { avatar }),      // 上傳自己這台的大頭貼；null＝移除
}
export const store = name => ({
  load: async () => { const s = await invoke('store_load', { name }); try { return s ? JSON.parse(s) : null } catch { return null } },
  save: data => invoke('store_save', { name, text: JSON.stringify(data) }),
})

// ---------- 視窗外框（自訂／Windows 原生） ----------
// 原生外框：html 加 frame-native，樣式把自畫的標題列、邊框與拖邊緣的把手藏起來
export const applyFrame = native => document.documentElement.classList.toggle('frame-native', native === true)
// 每扇視窗載入時問一次現在是哪種，之後設定頁一改就會收到 asn:frame
export async function initFrame() {
  try { applyFrame(await invoke('frame_native')) } catch { /* 問不到就維持自訂 */ }
  await listen('asn:frame', native => applyFrame(native))
}
// 自訂外框的八個拖邊緣調整大小的把手
export const RESIZE_DIRS = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw']
const RESIZE_NAME = { n: 'North', s: 'South', e: 'East', w: 'West', ne: 'NorthEast', nw: 'NorthWest', se: 'SouthEast', sw: 'SouthWest' }
export const resizeFrom = dir => { try { return T.window.getCurrentWindow().startResizeDragging(RESIZE_NAME[dir]) } catch { return undefined } }

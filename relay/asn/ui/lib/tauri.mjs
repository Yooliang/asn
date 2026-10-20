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
}
export const store = name => ({
  load: async () => { const s = await invoke('store_load', { name }); try { return s ? JSON.parse(s) : null } catch { return null } },
  save: data => invoke('store_save', { name, text: JSON.stringify(data) }),
})

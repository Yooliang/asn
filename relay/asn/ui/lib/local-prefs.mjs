// 本機小偏好的唯一出口（#2162 ⑧）：前端要用瀏覽器的 localStorage，只准經過這裡。
// localStorage 只放「每台電腦各自的小偏好」（例如這台用哪套外觀、這台關掉了哪張引導卡）；
// 要跨裝置同步、要可靠保存的設定，一律走共用設定層（lib/tauri.mjs 的 store／settings_patch），不要放這裡。
// 存不進去（私密模式、被擋）就當沒存，讀不到就回 null，絕不丟錯出去；
// 但傳進來的鍵不在清單裡是程式寫錯，會立刻丟錯。新增鍵必須同時改這份清單與 test/local-storage-guard.test.mjs 的那一份，兩邊不同守門就紅。
// storage 參數只給測試與既有函式注入假的存放區用；不給就用 globalThis.localStorage。
export const LOCAL_KEYS = ['asnSkin', 'asnCloudNodes', 'asnNewComputerGuideHidden', 'asnUpdateTestUrl']

const check = key => { if (!LOCAL_KEYS.includes(key)) throw new Error(`本機偏好的鍵不在允許清單裡：${key}（要新增請同時改 local-prefs.mjs 與守門測試）`) }
const defaultStorage = () => { try { return globalThis.localStorage ?? null } catch { return null } }

export function getLocal(key, storage = defaultStorage()) {
  check(key)
  try { return storage?.getItem(key) ?? null } catch { return null }
}
export function setLocal(key, v, storage = defaultStorage()) {
  check(key)
  try { storage?.setItem(key, String(v)) } catch { /* 存不進去就當沒存 */ }
}
export function removeLocal(key, storage = defaultStorage()) {
  check(key)
  try { storage?.removeItem(key) } catch { /* 刪不掉就算了 */ }
}

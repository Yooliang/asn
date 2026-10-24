// 設備頁籤的手動排序與自動隱藏（純邏輯，node 與瀏覽器都能跑；電腦版左邊頁籤、設定的設備頁籤、手機共用）。
// 順序存在本機設定（asn-me.json 的 deviceOrder：節點鍵陣列）；手動顯示過的隱藏設備存在 deviceShown。
// 舊存檔沒有這兩個欄位＝空陣列＝維持自動規則（本機第一、有人在線在前）。
import { isAsnWindow } from './roster.mjs'

const MAX_KEYS = 200
export const normalizeKeys = v => {
  if (!Array.isArray(v)) return []
  const out = []
  for (const k of v) if (typeof k === 'string' && k && !out.includes(k)) out.push(k)
  return out.slice(0, MAX_KEYS)
}
export const deviceFieldsFromSaved = saved => ({ deviceOrder: normalizeKeys(saved?.deviceOrder), deviceShown: normalizeKeys(saved?.deviceShown) })
export const deviceFieldsToSave = ({ deviceOrder, deviceShown } = {}) => ({ deviceOrder: normalizeKeys(deviceOrder), deviceShown: normalizeKeys(deviceShown) })

// rows：已按自動規則排好的列（每列有 key）。本機固定第一；手動排過的接著、照手動順序；其餘（新設備、沒排過）照原自動順序接在後面
export function applyDeviceOrder(rows, { selfNode, deviceOrder = [] } = {}) {
  const list = Array.isArray(rows) ? rows : []
  const self = list.filter(r => r.key === selfNode)
  const rest = list.filter(r => r.key !== selfNode)
  const rank = new Map(normalizeKeys(deviceOrder).map((k, i) => [k, i]))
  const manual = rest.filter(r => rank.has(r.key)).sort((a, b) => rank.get(a.key) - rank.get(b.key))
  return [...self, ...manual, ...rest.filter(r => !rank.has(r.key))]
}

// 上移（-1）／下移（+1）：keys 是目前完整順序；visible 給了就跳過看不到的設備（隱藏的相對位置不動）。回傳新的完整順序（不含本機）
export function moveDevice(keys, key, dir, { selfNode, visible } = {}) {
  const full = normalizeKeys(keys).filter(k => k !== selfNode)
  const at = full.indexOf(key)
  if (at < 0 || key === selfNode) return full
  const seen = Array.isArray(visible) ? new Set(visible) : null
  let to = at + dir
  while (to >= 0 && to < full.length && seen && !seen.has(full[to])) to += dir
  if (to < 0 || to >= full.length) return full
  const out = full.slice()
  ;[out[at], out[to]] = [out[to], out[at]]
  return out
}

// 拖放：把 dragKey 放到 targetKey 的前面（after＝false）或後面；放到本機上＝排到非本機的第一位；拖本機或拖到自己不變
export function reorderDevice(keys, dragKey, targetKey, after, { selfNode } = {}) {
  const full = normalizeKeys(keys).filter(k => k !== selfNode)
  if (dragKey === selfNode || dragKey === targetKey || !full.includes(dragKey)) return full
  const rest = full.filter(k => k !== dragKey)
  if (targetKey === selfNode || !rest.includes(targetKey)) return [dragKey, ...rest]
  const i = rest.indexOf(targetKey) + (after ? 1 : 0)
  return [...rest.slice(0, i), dragKey, ...rest.slice(i)]
}

export const showDevice = (shown, key) => (normalizeKeys(shown).includes(key) ? normalizeKeys(shown) : [...normalizeKeys(shown), key])

// 自動隱藏：非本機、沒有任何在線視窗（ASN 視窗也算）、沒有任何未封存的夥伴（ASN 視窗不是夥伴）、沒有未讀。只要一項不成立就不隱藏；手動顯示過的也不隱藏
export function isDeviceHidden(node, friends, { selfNode, shown = [] } = {}) {
  if (!node || node === selfNode || normalizeKeys(shown).includes(node)) return false
  for (const f of Array.isArray(friends) ? friends : []) {
    if ((f.node ?? '') !== node) continue
    if (f.status !== 'offline') return false
    if ((f.unread || 0) > 0) return false
    if (!isAsnWindow(f) && f.archived !== true) return false
  }
  return true
}
export const hiddenDeviceNodes = (friends, nodes, opt) => (nodes ?? []).filter(n => isDeviceHidden(n, friends, opt))

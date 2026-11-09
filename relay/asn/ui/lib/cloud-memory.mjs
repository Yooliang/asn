// 本機記住「上次判成雲端」的節點（電腦版、手機版各自存在自己的 localStorage，不同步）。
// 鍵名 asnCloudNodes，值是節點代號的 JSON 陣列，例如 ["node-a","node-b"]。讀不到、格式不對都當沒有；寫不進去就算了。
export const CLOUD_MEMORY_KEY = 'asnCloudNodes'

export function loadCloudNodes(storage = globalThis.localStorage) {
  try {
    const v = JSON.parse(storage.getItem(CLOUD_MEMORY_KEY) ?? '[]')
    return Array.isArray(v) ? v.filter(n => typeof n === 'string' && n) : []
  } catch { return [] }
}

export function saveCloudNodes(nodes, storage = globalThis.localStorage) {
  try { storage.setItem(CLOUD_MEMORY_KEY, JSON.stringify(nodes)) } catch { /* 存不進去（私密模式等）就當沒記 */ }
}

/** 設備樹算完後，下一份要記住的名單：這次出現的設備照 cloudStore 增減，沒出現的（名單暫時沒載到）維持原樣。不改傳入的陣列 */
export function nextCloudNodes(prev, rows) {
  const seen = new Set(rows.map(r => r.key))
  const keep = (prev ?? []).filter(n => !seen.has(n))
  return [...keep, ...rows.filter(r => r.cloudStore === true).map(r => r.key)]
}
export const sameNodes = (a, b) => a.length === b.length && JSON.stringify([...a].sort()) === JSON.stringify([...b].sort())

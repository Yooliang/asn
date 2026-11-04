// 夥伴名單上「背景執行中」：夥伴在共用終端服務（mux）裡跑、沒有開畫面。按一下看回來；第一次按 X 關畫面時說明一次（todo-next-15q 第 4 步）

export const MUX_CLOSE_EXPLAINED_KEY = 'asn.muxCloseExplained'

export const MUX_CLOSE_NOTICE = {
  title: '夥伴還在背景執行',
  body: '關掉視窗只是關掉畫面，夥伴沒有停，還會繼續收信和工作。要看回來，按名單上的「背景執行中」；要真的停，到夥伴的右鍵選單關閉。',
}

/** 取名單狀態。舊版後端、手機版沒有這個命令，或出錯：一律當沒有 */
export async function loadMuxViews(transport) {
  try {
    const r = await transport?.termMuxViews?.()
    return Array.isArray(r) ? r.filter(v => v && typeof v.name === 'string' && v.name) : []
  } catch {
    return []
  }
}

/** 沒開畫面的夥伴名字 */
export function backgroundNames(views) {
  return new Set(views.filter(v => !v.viewing).map(v => v.name))
}

/** 這個夥伴要不要標「背景執行中」：要在這台電腦、不是離線、不是還在開 */
export function isMuxBackground(friend, selfNode, names) {
  if (!friend || friend.pending || friend.status === 'offline' || friend.node !== selfNode) return false
  return names.has(friend.agent || friend.nick || '')
}

/** 第一次按 X 才要說明。storage 讀寫失敗（私密模式之類）最多多說幾次，不影響其他功能 */
export function closeNoticeOnce(views, storage) {
  if (!views.some(v => v.closed)) return null
  try {
    if (storage?.getItem(MUX_CLOSE_EXPLAINED_KEY)) return null
    storage?.setItem(MUX_CLOSE_EXPLAINED_KEY, '1')
  } catch { /* 寫不進去就下次再說一次 */ }
  return MUX_CLOSE_NOTICE
}

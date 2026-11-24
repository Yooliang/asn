// 工作管理員的樹（#1860 F）：ASN ＞ 終端服務 ＞ 各代理 的純資料整理。電腦、手機、別台設備共用這一份，畫面元件在 task-tree-view.mjs。
// 歸屬只看電腦端清單每一列的 mux_pid（那一列開在哪個終端服務底下），這裡不猜：
//   - mux_pid 對得上某個終端服務 → 那個服務底下
//   - 沒有 mux_pid、或對不上任何服務（原生主控台、Linux 沒有終端服務、舊版沒給欄位、服務那列被截掉）→ 直接掛在 ASN 底下，和終端服務並列，不會不見
// 這個檔不引用別的檔（task-manager.mjs 會引用它），node 與瀏覽器都能跑。

export const TREE_TEXT = Object.freeze({
  running: '運作中',
  agents: n => `底下 ${n} 個代理`,
  fold: '收合',
  unfold: '展開',
  viewOnly: '只能看',
  // 重啟（#1860 F PR3）：確認文字、按鈕與狀態都只有這一份，電腦、手機、別台設備共用
  restart: '重啟',
  cancel: '取消',
  restarting: '正在重啟…',
  disconnected: '斷線中',
  restartFail: '重啟沒有成功，請稍後再試。',
})

/** 重啟確認框的字。prefix 是別台設備才加的主詞（例如「工作機」的），這台自己不給 */
export const restartAsnText = (prefix = '') => `重啟${prefix}ASN？收發室會暫時斷線，代理視窗不受影響，之後會自動連回。`
export const restartMuxText = (n, prefix = '') => `重啟${prefix}終端服務？底下所有代理（${n} 個）會暫時斷線，之後會自動連回。`

export const ROOT_KEY = 'asn'
export const muxKey = pid => `mux:${pid}`

/** ASN 本體：kind 是 asn、名字就是「ASN」（其他 kind 為 asn 的是收發室等 ASN 自己的視窗，照一般視窗歸類） */
export const isRootRow = r => r?.kind === 'asn' && r.name === 'ASN'

/**
 * 把清單排成樹。回新的物件，不改傳進來的列：
 *   asn：ASN 本體那一列（沒有就是 null）
 *   groups：每個終端服務一組 { mux, agents }，agents 是 mux_pid 等於它的列
 *   direct：不在任何終端服務底下的列（代理、主控台、內建工作者、自己開的前景程式）
 *   agentCount：ASN 重啟會一起斷線的代理數＝所有組裡的列加 direct，不含自己開的前景程式（process，不是 ASN 管的）
 * 列的順序照清單原本的順序
 */
export function buildTree(rows) {
  const list = (Array.isArray(rows) ? rows : []).filter(Boolean)
  const asn = list.find(isRootRow) ?? null
  const muxes = list.filter(r => r.kind === 'mux')
  const known = new Set(muxes.map(m => m.pid))
  const rest = list.filter(r => r !== asn && r.kind !== 'mux')
  const groups = muxes.map(mux => ({ mux, agents: rest.filter(r => r.mux_pid === mux.pid) }))
  const direct = rest.filter(r => !known.has(r.mux_pid))
  const members = [...groups.flatMap(g => g.agents), ...direct]
  return { asn, groups, direct, agentCount: members.filter(r => r.kind !== 'process').length }
}

/**
 * 畫面要的樹：節點都用 mapRow 轉成畫面的列（task-manager 的 viewRow）。
 * root 沒有 ASN 本體時是 null，這時終端服務與直接掛的列就是最外層
 */
export function treeView(rows, mapRow, ui = {}) {
  const t = buildTree(rows)
  const { ask = null, restarting = null, frozen = null, prefix = '', error = null } = ui
  // 重啟中：ASN 重啟整棵樹都斷線；終端服務重啟只有它底下的代理斷線（restarting 是節點鍵，'mux:*' 代表不知道是哪一個，全部終端服務）
  const hit = key => restarting === key || (restarting === 'mux:*' && key.startsWith('mux:'))
  const allDown = restarting === ROOT_KEY
  const down = a => ({ ...a, status: TREE_TEXT.disconnected, canStop: false, why: '', canHandover: false, canView: false, canAdopt: false })
  const restartOf = (key, text) => ({ target: key, ask: ask === key ? text : '', busy: hit(key) || (key === ROOT_KEY && allDown), disabled: restarting !== null, error: error?.key === key ? error.text : '' })
  const root = t.asn ? { key: ROOT_KEY, node: mapRow(t.asn), statusText: TREE_TEXT.running, restart: restartOf(ROOT_KEY, restartAsnText(prefix)) } : null
  const mapAgent = (a, isDown) => (isDown ? down(mapRow(a)) : mapRow(a))
  const groups = t.groups.map(g => {
    const key = muxKey(g.mux.pid)
    const isDown = allDown || hit(key)
    return { key, node: mapRow(g.mux), summary: TREE_TEXT.agents(g.agents.length), agents: g.agents.map(a => mapAgent(a, isDown)), restart: restartOf(key, restartMuxText(g.agents.length, prefix)) }
  })
  // 終端服務重啟的當下，舊服務已停、清單裡找不到它：用按下時記的那一組撐著，底下標「斷線中」，直到新的服務回來
  if (frozen && restarting === frozen.key && !groups.some(g => g.key === frozen.key)) {
    groups.push({ ...frozen, agents: frozen.agents.map(down), restart: restartOf(frozen.key, '') })
  }
  const direct = t.direct.map(a => mapAgent(a, allDown))
  return { root, groups, direct, agentCount: t.agentCount }
}

/** 收合：只記被收起的節點鍵；回新的清單，不改原本的 */
export const toggleCollapsed = (collapsed, key) => {
  const list = Array.isArray(collapsed) ? collapsed : []
  return list.includes(key) ? list.filter(k => k !== key) : [...list, key]
}
export const isCollapsed = (collapsed, key) => Array.isArray(collapsed) && collapsed.includes(key)

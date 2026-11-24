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
})

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
export function treeView(rows, mapRow) {
  const t = buildTree(rows)
  const root = t.asn ? { key: ROOT_KEY, node: mapRow(t.asn), statusText: TREE_TEXT.running } : null
  const groups = t.groups.map(g => ({ key: muxKey(g.mux.pid), node: mapRow(g.mux), summary: TREE_TEXT.agents(g.agents.length), agents: g.agents.map(mapRow) }))
  return { root, groups, direct: t.direct.map(mapRow), agentCount: t.agentCount }
}

/** 收合：只記被收起的節點鍵；回新的清單，不改原本的 */
export const toggleCollapsed = (collapsed, key) => {
  const list = Array.isArray(collapsed) ? collapsed : []
  return list.includes(key) ? list.filter(k => k !== key) : [...list, key]
}
export const isCollapsed = (collapsed, key) => Array.isArray(collapsed) && collapsed.includes(key)

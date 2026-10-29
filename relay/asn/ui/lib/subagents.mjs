// 對話上方功能列的「子代理」按鈕（#27）：顯示這個 Claude 視窗正在跑幾個子代理、各自在做什麼。
// 只放純邏輯；後端指令 subagents_query 在 src-tauri/src/launch/subagents.rs（讀對話記錄檔）。
import { partnerEngine } from './partner-ops.mjs'

/** 多久問一次（只在對話視窗開著時）。 */
export const SUBAGENT_POLL_MS = 5000

/** 哪些名單上的人適用：只有本機的 Claude 視窗（雲端代理、其他設備、Codex 等讀不到記錄檔）。 */
export function canOfferSubagents(friend, { selfNode, engine }) {
  if (!friend || friend.pending) return false
  if (engine !== 'claude') return false
  if (partnerEngine(friend) === 'acp') return false
  return friend.node === selfNode
}

/** 把後端結果整理成畫面要的樣子；查不到一律當作 0 個，不報錯。 */
export function subagentView(q) {
  const items = Array.isArray(q?.items) ? q.items.map(it => ({
    id: String(it?.id ?? ''),
    text: String(it?.description || '').trim() || '（沒有描述）',
    kind: String(it?.kind || '').trim(),
  })) : []
  const count = Math.max(items.length, Number(q?.count) || 0)
  return {
    count,
    items,
    more: Math.max(0, count - items.length),
    label: count > 0 ? `子代理 ${count}` : '子代理',
    tip: count > 0 ? `這個代理正在跑 ${count} 個子代理，按一下看各自在做什麼` : '看這個代理有沒有子代理正在跑',
    empty: '目前沒有子代理在執行',
  }
}

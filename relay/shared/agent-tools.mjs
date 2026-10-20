// 與 relay/shared/agent-tools.catalog.json 同步；#23 開新視窗與 ASN 用量分頁共用。
import catalog from './agent-tools.catalog.json' with { type: 'json' }

export const AGENT_TOOLS_CATALOG = catalog
export const AGENT_TOOLS = catalog.tools

/** @param {string} id */
export function toolById(id) {
  return AGENT_TOOLS.find(t => t.id === id)
}

/** issue #23 預設偵測順序 */
export const LAUNCH_TOOL_IDS = ['claude', 'codex', 'agy', 'grok', 'pi']

export function authLabel(auth) {
  switch (auth) {
    case 'not_installed': return '未安裝'
    case 'not_logged_in': return '未登入'
    case 'logged_in': return '已登入'
    case 'unavailable': return '無法取得'
    default: return '未知'
  }
}

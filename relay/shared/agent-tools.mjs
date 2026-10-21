// 與 relay/shared/agent-tools.catalog.json 同步；#23 開新視窗與 ASN 後續功能共用。
import catalog from './agent-tools.catalog.json' with { type: 'json' }

export const AGENT_TOOLS_CATALOG = catalog
export const AGENT_TOOLS = catalog.tools

/** @param {string} id */
export function toolById(id) {
  return AGENT_TOOLS.find(t => t.id === id)
}

/** issue #23 預設偵測順序 */
export const LAUNCH_TOOL_IDS = ['claude', 'codex', 'agy', 'grok', 'pi']

/** @param {boolean} binaryFound */
export function installStateLabel(binaryFound) {
  return binaryFound ? '已安裝' : '未安裝'
}

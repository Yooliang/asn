// 開新夥伴：設備選單、能否在此設備開啟、顯示方式（前台／背景）。
import { MODEL_CATALOG } from './model-catalog.mjs'

export const DISPLAY_MODES = [
  { key: 'foreground', label: '前台顯示' },
  { key: 'background', label: '背景執行' },
]

export function launchDisableReason(nodeKey, { selfNode, partnerModels, remoteLaunchers }) {
  if (nodeKey === selfNode) {
    if (!partnerModels.some(m => m.installed)) return '這台電腦尚未偵測到可開視窗的 AI 指令'
    return ''
  }
  const remote = remoteLaunchers[nodeKey]
  if (!remote?.profiles?.length) return '這台設備尚未回報啟動設定'
  return ''
}

export function canLaunchOnNode(nodeKey, ctx) {
  return !launchDisableReason(nodeKey, ctx)
}

/** 設備列：本機優先，其餘照名單順序 */
export function launchDeviceRows(friends, { selfNode, nodeOrder = [] }) {
  const byNode = new Map()
  for (const f of friends) {
    if (!byNode.has(f.node)) byNode.set(f.node, { key: f.node, label: f.device || f.node })
  }
  if (!byNode.has(selfNode)) byNode.set(selfNode, { key: selfNode, label: selfNode })
  const order = [selfNode, ...nodeOrder.filter(n => n !== selfNode)]
  const seen = new Set()
  const out = []
  for (const k of order) {
    if (seen.has(k) || !byNode.has(k)) continue
    seen.add(k)
    out.push(byNode.get(k))
  }
  for (const [k, row] of byNode) if (!seen.has(k)) out.push(row)
  return out
}

export function profileModeFor(profileId) {
  return MODEL_CATALOG.find(m => m.profileId === profileId)?.mode ?? 'window'
}

export function showDisplayModeChoice(profileId) {
  return profileModeFor(profileId) === 'window'
}

export function engineForProfile(profileId) {
  const row = MODEL_CATALOG.find(m => m.profileId === profileId)
  if (!row) return 'claude'
  if (row.profileId === 'codex') return 'codex'
  if (row.profileId === 'gemini') return 'gemini'
  if (row.profileId === 'grok') return 'grok'
  if (row.profileId === 'pi') return 'pi'
  return 'claude'
}

export function consoleToggleLabel(visible) {
  return visible ? '背景執行' : '前台執行'
}

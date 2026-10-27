// 開新夥伴：對話框狀態、預設名字、啟動中列、輪詢遠端 launch 結果。
import { MODEL_CATALOG } from './model-catalog.mjs'
import { friendId } from './roster.mjs'

export { MODEL_CATALOG } from './model-catalog.mjs'

export function defaultPartnerName(friends, profileId) {
  const base = profileId === 'gemini' ? 'Gemini' : profileId === 'grok' ? 'Grok' : profileId === 'codex' ? 'Codex' : '夥伴'
  const re = new RegExp(`^${base}-(\\d+)$`)
  let max = 0
  for (const f of friends) {
    const m = String(f.nick ?? '').match(re)
    if (m) max = Math.max(max, Number(m[1]))
  }
  return `${base}-${max + 1}`
}

export function pendingFriend({ node, device, name, profileId, mode, launchDisplay, t0 }) {
  return {
    id: `pending:${node}/${name}`,
    node,
    device,
    agent: name,
    nick: name,
    psm: '啟動中…',
    status: 'away',
    onRoster: false,
    pending: true,
    launchProfile: profileId,
    launchMode: mode,
    launchDisplay: launchDisplay === 'background' ? 'background' : 'foreground',
    launchSince: t0 ?? Date.now(),
    engine: profileId === 'gemini' ? 'gemini' : profileId === 'grok' ? 'grok' : null,
  }
}

export function injectPendingGroups(groups, pending) {
  if (!pending.length) return groups
  const byNode = new Map()
  for (const p of pending) {
    if (!byNode.has(p.node)) byNode.set(p.node, [])
    byNode.get(p.node).push(p)
  }
  return groups.map(g => {
    const extra = byNode.get(g.key)
    if (!extra?.length) return g
    return { ...g, items: [...extra, ...g.items] }
  })
}

export function resolvePending(pending, friends) {
  const liveIds = new Set(friends.map(f => f.id))
  return pending.filter(p => {
    const target = friendId(p.node, p.agent)
    return !liveIds.has(target)
  })
}

// 這台電腦有沒有偵測到某個 CLI：讀 ai_cli_detect 的原始列（Rust ToolDetectRow，欄位是 binary_found；舊格式是 cmd）。
// tools 是「id → 原始列」的對照（list.js 的 cliTools）。不要讀 .installed——那是 modelUiRow 整理後才有的欄位（#394 之後查出 0.1.91 起讀錯）
export const toolFound = tool => Boolean(tool?.binary_found ?? tool?.cmd)
export const cliInstalled = (tools, id) => toolFound(tools?.[id])

export function modelUiRow(catalogItem, tool) {
  const installed = toolFound(tool)
  return {
    ...catalogItem,
    installed,
    installHint: tool?.install_blurb ?? tool?.installHint ?? tool?.install_hint ?? '',
    version: tool?.version ?? '',
  }
}

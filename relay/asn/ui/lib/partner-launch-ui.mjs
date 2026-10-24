// 開新夥伴：設備選單、能否在此設備開啟、顯示方式（前台／背景）。
import { MODEL_CATALOG } from './model-catalog.mjs'
import { isAsnWindow } from './roster.mjs'
import { applyDeviceOrder } from './device-order.mjs'

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

/**
 * 別台設備在開新夥伴對話框裡的模型列：用那台回報的 profile（id、標籤），不是本機偵測到的 CLI。
 * 那台是 ASN 內建收發室橋或舊版收發室橋都一樣；回報裡沒有指令，只有 id 與標籤。
 */
export function remoteModelRows(launcher) {
  const list = Array.isArray(launcher?.profiles) ? launcher.profiles : []
  return list.filter(p => p && typeof p.id === 'string' && p.id).map(p => {
    const cat = MODEL_CATALOG.find(m => m.profileId === p.id)
    return {
      id: cat?.id ?? p.id, toolId: cat?.toolId ?? p.id, profileId: p.id,
      label: (typeof p.label === 'string' && p.label.trim()) || cat?.label || p.id,
      mode: cat?.mode ?? 'window', modeLabel: cat?.modeLabel ?? '會開一個視窗',
      installed: true, installHint: '', version: '',
    }
  })
}

export function canLaunchOnNode(nodeKey, ctx) {
  return !launchDisableReason(nodeKey, ctx)
}

/** 設備列：本機優先，其餘照名單順序 */
export function launchDeviceRows(friends, { selfNode, nodeOrder = [], deviceOrder = [] }) {
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
  // 排序：本機第一；其餘「有人在線」的設備在前、整台都離線的排後面（各組內維持原順序）。左邊頁籤、設定的設備頁籤、手機的設備順序共用這一份
  const online = new Set(friends.filter(f => f.status !== 'offline' && !isAsnWindow(f)).map(f => f.node))
  const rank = r => (r.key === selfNode ? 0 : online.has(r.key) ? 1 : 2)
  const auto = out.map((r, i) => ({ r, i })).sort((a, b) => rank(a.r) - rank(b.r) || a.i - b.i).map(x => x.r)
  return applyDeviceOrder(auto, { selfNode, deviceOrder })   // 手動順序（設定檔 deviceOrder）蓋過自動規則
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
  return visible ? '切到背景' : '叫回前台'
}

/** 查詢／切換主控台的請求：引擎、名字、條目種類（名單的 kind，例如 process＝本機掃到的程式）、選填 pid；不從顯示名字串硬解析 */
export function consoleReq(friend, engine) {
  const req = { engine, name: friend?.agent || friend?.nick || '' }
  if (friend?.entryKind) req.kind = String(friend.entryKind)
  const pid = Number(friend?.pid)
  if (Number.isInteger(pid) && pid > 0) req.pid = pid
  return req
}

/** 名單右鍵選單查主控台狀態最多等多久；超過就當查不到，不擋選單 */
export const CONSOLE_QUERY_TIMEOUT_MS = 1500

/** 右鍵選單的「背景／前台切換」項目：文字固定、不隨狀態改字；能切換才可按，檢查中或切不了就反灰 */
export const BUDDY_CONSOLE_LABEL = '背景／前台切換'
export function buddyConsoleItem(state, reason = '') {
  const disabled = state !== 'toggle'
  const tip = state === 'checking' ? '檢查中…' : disabled ? (reason || '找不到這個夥伴的主控台視窗') : ''
  return { label: BUDDY_CONSOLE_LABEL, disabled, tip }
}

/** 等 promise 最多 ms 毫秒；逾時或失敗一律回 null（右鍵選單不能被慢的查詢卡住） */
export function withTimeout(promise, ms) {
  return new Promise(resolve => {
    const t = setTimeout(() => resolve(null), ms)
    Promise.resolve(promise).then(v => { clearTimeout(t); resolve(v) }, () => { clearTimeout(t); resolve(null) })
  })
}

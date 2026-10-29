// 開新夥伴：設備選單、能否在此設備開啟、顯示方式（前台／背景）。
import { MODEL_CATALOG } from './model-catalog.mjs'
import { isAsnWindow } from './roster.mjs'
import { applyDeviceOrder, isDeviceRemoved } from './device-order.mjs'

export const DISPLAY_MODES = [
  { key: 'foreground', label: '前台顯示' },
  { key: 'background', label: '背景運行' },
]

// 0.2 H2：沒開放時依那台回報的內容說明。Linux 的機器橋沒有設定畫面，要改設定檔；那台自己寫了不開放的原因就照它寫的（純文字，畫面只用文字插值顯示）
export const LINUX_CLOSED = '這台是 Linux 設備，沒有設定畫面。要開放的話，請在那台的 ~/.asn/launcher.json 寫好 profiles 和 cwd_allow（工作資料夾白名單），或設環境變數 ASN_LAUNCH_AUTO=1 讓它自動偵測，再重啟 ASN 機器橋。沒有桌面時會用 tmux 開（需要 tmux 3.2 以上）'
export const closedByDevice = reason => `這台設備不開放開新夥伴：${reason}`
/** 沒開放的原因：那台寫的原因 → Linux 的設定方法 → 呼叫端給的一般說法（舊的機器橋沒回報平台就是這個） */
export function closedReasonOf(machine, fallback) {
  const r = typeof machine?.launch_closed_reason === 'string' ? machine.launch_closed_reason.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').trim().slice(0, 120) : ''
  if (r) return closedByDevice(r)
  if (machine?.platform === 'linux') return LINUX_CLOSED
  return fallback
}
export function launchDisableReason(nodeKey, { selfNode, partnerModels, remoteLaunchers, remoteMachines = {} }) {
  if (nodeKey === selfNode) {
    if (!partnerModels.some(m => m.installed)) return '這台電腦尚未偵測到可開視窗的 AI 指令'
    return ''
  }
  const remote = remoteLaunchers[nodeKey]
  if (!remote) return closedReasonOf(remoteMachines[nodeKey], '這台設備尚未回報啟動設定')
  if (!remote.profiles?.length) return '這台設備尚未回報啟動設定'
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
    // 目錄上沒有的項目（自訂設定）：看那台回報的 mode（舊版回報沒有這欄＝視窗）
    const bg = !cat && p.mode === 'background'
    return {
      id: cat?.id ?? p.id, toolId: cat?.toolId ?? p.id, profileId: p.id, cliWhy: cat?.cliWhy, acpWhy: cat?.acpWhy, channels: cat?.channels, channelOnly: cat?.channelOnly,
      label: (typeof p.label === 'string' && p.label.trim()) || cat?.label || p.id,
      mode: cat?.mode ?? (bg ? 'background' : 'window'), modeLabel: cat?.modeLabel ?? (bg ? '由 ASN 內建通道執行' : '會開一個視窗'),
      installed: true, installHint: '', version: '',
    }
  })
}

export function canLaunchOnNode(nodeKey, ctx) {
  return !launchDisableReason(nodeKey, ctx)
}

/** 設備列：本機優先，其餘照名單順序 */
// removed＝使用者「永久移除」的設備（設定 → 設備與帳號）：跟設備頁籤一樣不列出來（本機不會被移除）
export function launchDeviceRows(friends, { selfNode, nodeOrder = [], deviceOrder = [], removed = [] }) {
  const byNode = new Map()
  for (const f of friends) {
    if (isDeviceRemoved(f.node, removed, { selfNode })) continue
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

/** 互動式、無法無人值守的模型（pi）：只能前台，不給背景選項 */
export function foregroundOnlyProfile(profileId) {
  return MODEL_CATALOG.find(m => m.profileId === profileId)?.foregroundOnly === true
}

export function showDisplayModeChoice(profileId) {
  return profileModeFor(profileId) === 'window' && !foregroundOnlyProfile(profileId)
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

/**
 * 這台電腦某個 profile 的 engine（開新夥伴選型號用，要跟後端 launch_model_plan 同一個判斷）：
 * 這台有回報啟動設定（launcher 摘要）就用回報裡的 engine（沒有這欄＝沒寫，回空字串）；沒回報（沒開放遠端管理）就用內建設定（launch/profiles.rs）的 engine；
 * 目錄外的自訂 profile 又沒回報＝不知道，當成沒寫。注意：不能用 engineForProfile，它對不認得的一律當 Claude。
 */
export const BUILTIN_PROFILE_ENGINE = { claude: 'claude', codex: 'codex', gemini: 'acp', grok: 'acp', pi: 'pi' }
export function localProfileEngine(profileId, selfLauncher) {
  const list = Array.isArray(selfLauncher?.profiles) ? selfLauncher.profiles : null
  if (list) {
    const p = list.find(x => x?.id === profileId)
    if (p) return typeof p.engine === 'string' ? p.engine : ''
  }
  return Object.hasOwn(BUILTIN_PROFILE_ENGINE, profileId) ? BUILTIN_PROFILE_ENGINE[profileId] : ''
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

// 收發室名單（list 動作的 members）→ 好友與狀態。純函式。
import { UNNAMED_DEVICE, hueOf, initial } from './text.mjs'
import { pctOf } from './context-usage.mjs'

const PARTNER_ID = /^p_[0-9a-f]{20}$/
// 後台給的這台電腦的 Claude 外掛狀態（claude_mod：state／version／reason）→ 乾淨的物件；舊後台沒有或格式不對＝null
const MOD_STATES = new Set(['installed', 'removed', 'no_claude', 'failed', 'update_failed', 'checking'])
export function modOf(m) {
  if (!m || typeof m !== 'object' || Array.isArray(m) || !MOD_STATES.has(m.state)) return null
  return {
    state: m.state,
    version: typeof m.version === 'string' ? m.version.slice(0, 32) : '',
    reason: typeof m.reason === 'string' ? m.reason.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 120) : '',
  }
}
export const friendId = (node, agent) => `${node}/${agent ?? ''}`
// 收發室自己（名字結尾「收發室」）不當好友
export const isRelayRoom = name => /收發室$/.test(String(name ?? ''))

// 「ASN 程式本身」的視窗（名單回報 engine＝asn，代表某台設備上的 ASN，不是 AI）：名單上的好友項目一律隱藏。
// 設備分組、設備頁籤、遠端更新都以設備為單位，不受影響；往來記錄與好友資料照常保留，只是各處顯示的清單都不列它、也不算進人數與未讀。
export const isAsnWindow = f => String(f?.engine ?? '').trim().toLowerCase() === 'asn'
export const withoutAsn = friends => (Array.isArray(friends) ? friends : []).filter(f => !isAsnWindow(f))
// 寄給 ASN 程式本身的信不期待回信（它不是 AI）：寄信一律 expects_reply＝false，畫面也不顯示「等對方回信」與「未回」提示。
export const expectsReplyTo = f => !isAsnWindow(f)
export const showsWaiting = f => Boolean(f?.waiting) && !isAsnWindow(f)

// 後端回報的視窗狀態 → 介面狀態：busy/working/running 之類＝忙碌，waiting 之類（等人回應）＝暫離，其餘（idle…）＝線上；不在名單＝離線（由 mergeFriends 決定）
const BUSY = new Set(['busy', 'working', 'running', 'thinking'])
const AWAY = new Set(['waiting', 'away', 'blocked', 'paused'])
export function statusOf(raw) {
  const s = String(raw ?? '').trim().toLowerCase()
  return BUSY.has(s) ? 'busy' : AWAY.has(s) ? 'away' : 'online'
}

// 舊存檔的個人訊息是「節點／資料夾」或單獨節點名；設備已由頁籤表示，只留資料夾
export const cleanPsm = (psm, node) => { const s = String(psm ?? ''); return s === node ? '' : s.replace(/^[^／]*／/, '') }

// 個人訊息＝資料夾；Claude Code 外掛回報了說明（背景工作中／等你回答…，純中文、最多 80 字）就接在後面。舊後台沒有 detail 欄位＝只有資料夾
export function psmOf(a) {
  const cwd = a?.cwd_label ? String(a.cwd_label) : ''
  const d = typeof a?.detail === 'string' ? a.detail.replace(/\s+/g, ' ').trim().slice(0, 80) : ''
  return cwd && d ? `${cwd}・${d}` : cwd || d
}

// 一個視窗一列；名字＝視窗名，個人訊息＝資料夾（cwd_label，沒有就空）
export function buildFriends(members, { selfNode, selfName } = {}) {
  const out = []
  // 同一個夥伴 ID 只留一筆（改名後後台的離線成員還掛著舊名）：先掃一遍記下「有在線的夥伴 ID」，離線的同夥伴不列
  const livePids = new Set()
  for (const m of Array.isArray(members) ? members : []) for (const a of Array.isArray(m?.agents) ? m.agents : []) if (a && a.online !== false && PARTNER_ID.test(String(a.partner_id ?? ''))) livePids.add(a.partner_id)
  const pidDone = new Set()
  for (const m of Array.isArray(members) ? members : []) {
    if (!m || typeof m.id !== 'string') continue
    // 在線的 agents ＋ 離線但 30 天內出現過的 offline_agents（#167；舊後台沒有後者）。離線的一律 offline，同名以在線為準
    const seen = new Set()
    const rows = [
      ...(Array.isArray(m.agents) ? m.agents : []).map(a => [a, false]),
      ...(Array.isArray(m.offline_agents) ? m.offline_agents : []).map(a => [a, true]),
    ]
    for (const [a, off] of rows) {
      if (!a || typeof a.name !== 'string' || !a.name) continue
      if (isRelayRoom(a.name)) continue
      if (m.id === selfNode && a.name === selfName) continue
      if (seen.has(a.name)) continue
      const pid = PARTNER_ID.test(String(a.partner_id ?? '')) ? a.partner_id : ''
      const isOff = off || a.online === false
      if (pid && (isOff ? livePids.has(pid) : pidDone.has(pid))) continue
      if (pid && !isOff) pidDone.add(pid)
      seen.add(a.name)
      out.push({
        id: friendId(m.id, a.name), node: m.id, device: typeof m.name === 'string' && m.name.trim() ? m.name.trim() : '', agent: a.name, nick: a.name,
        psm: psmOf(a), contextPct: isOff || a.online === false ? null : pctOf(a.context_pct),   // 上下文已用％（選填；離線或舊後台沒有＝null）
        modLoaded: isOff || a.online === false || typeof a.mod_loaded !== 'boolean' ? null : a.mod_loaded,   // 這個視窗有沒有載入外掛（選填；離線或舊後台沒有＝null）
        deviceMod: modOf(m.claude_mod),   // 這台電腦的外掛狀態（選填；舊後台沒有＝null）
        onRoster: true, engine: a.engine ?? null, kind: typeof m.kind === 'string' && m.kind ? m.kind : null, status: off || a.online === false ? 'offline' : statusOf(a.status),
        archived: a.archived === true,   // 封存（記在帳號層；舊後台沒有這個鍵＝沒封存）。每次名單都明寫，才不會被記住的舊值蓋掉
        ...(PARTNER_ID.test(String(a.partner_id ?? '')) ? { partnerId: a.partner_id } : {}),   // 夥伴 ID（#153）：只在內部用來查往來記錄與交接檔資料夾，不顯示
      })
    }
  }
  return out
}

// 把「這次名單」和「記得的好友（有過對話）」合併：名單裡的 → 線上／忙碌；記得但不在名單 → 離線
export function mergeFriends(known, live) {
  const map = new Map()
  for (const k of known) map.set(k.id, { ...k, status: 'offline' })
  for (const l of live) map.set(l.id, { ...(map.get(l.id) ?? {}), ...l })
  return [...map.values()].map(f => ({ ...f, hue: hueOf(f.id), dp: initial(f.nick) }))
    .sort((a, b) => a.nick.localeCompare(b.nick, 'zh-Hant'))
}

// 依設備分組（跟收發室名單一樣一台機器一組）：自己這台排第一，其餘照設備名；組內線上／忙碌在前、離線在後。q＝搜尋字（已轉小寫）
export function groupByDevice(friends, { selfNode, match = () => true } = {}) {
  const groups = new Map()
  for (const f of friends) {
    if (!match(f)) continue
    const key = f.node ?? ''
    if (!groups.has(key)) groups.set(key, { key, label: f.device || UNNAMED_DEVICE, items: [] })
    const g = groups.get(key)
    if (f.device && g.label === UNNAMED_DEVICE) g.label = f.device
    g.items.push(f)
  }
  const rank = s => (s === 'offline' ? 1 : 0)
  for (const g of groups.values()) g.items.sort((a, b) => rank(a.status) - rank(b.status) || a.nick.localeCompare(b.nick, 'zh-Hant'))
  return [...groups.values()].sort((a, b) => (b.key === selfNode) - (a.key === selfNode) || a.label.localeCompare(b.label, 'zh-Hant'))
}

// 帳號列表（#374 第一批，畫面）：把後台 acct_roster 回的「本人所有設備回報的各廠牌帳號與額度」整理成畫面資料。
// 電腦（list.js、設定頁、切換對話框）與手機（m.js、mobile-acct.mjs）共用這一份。純函式：不改輸入、一律回傳新物件。
// 後台回傳（supabase/migrations/20261029100000_acct_roster.sql 的 asn_relay_acct_roster）：
//   { now, accounts: [{ vendor, account, plan, windows:[{ name, left_pct, resets_at, read_at, read_node }], seen_at, seen_node, nodes:[{ node, current, reported_at }] }] }
//   windows 空陣列＝沒有額度資料；nodes 空陣列＝目前沒有任何一台還在回報它（後台保留 30 天）。
// 後台沒部署、沒登入、回錯（404／forbidden）時一律當「沒有列表」（null），畫面退回各設備自己回報的數字。
import { agoText } from './cloud-invite.mjs'
import { STALE_MS, resetIn } from './account-quota.mjs'
import { UNNAMED_DEVICE } from './text.mjs'

export const ROSTER_TEXT = {
  title: '我的帳號',
  noQuota: '額度讀不到',
  codexOff: '開 Codex 後才讀得到',
  empty: '還沒有帳號回報',
  current: '使用中',
}
export const ROSTER_POLL_MS = 5 * 60_000   // 開著「設備與帳號」時多久重讀一次（跟額度回報同一個節奏，不另開更密的）
export const DEVICE_MAX = 8  // 「3 小時前・工作機」的設備名最多幾個字
const VENDOR_RANK = { claude: 0, codex: 1, grok: 2 }
const VENDOR_NAME = { claude: 'Claude', codex: 'OpenAI（Codex）', grok: 'Grok' }

const pct = v => (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 100 ? Math.round(v) : null)
const time = v => { const t = Date.parse(typeof v === 'string' ? v : ''); return Number.isFinite(t) ? t : null }
const keyOf = (vendor, account) => `${String(vendor ?? '').toLowerCase()}\n${String(account ?? '').trim().toLowerCase()}`

/** 後台回的是不是一份能用的列表（有 accounts 陣列、沒有 error） */
export const rosterOk = r => Boolean(r && typeof r === 'object' && !r.error && Array.isArray(r.accounts))

/** 額度窗名稱 → 給人看的名字：five_hour「5 小時」、weekly「每週」；Codex 其他長度 w<分鐘數> 換成「N 天」「N 小時」「N 分鐘」 */
export function windowLabel(name) {
  if (name === 'five_hour') return '5 小時'
  if (name === 'weekly') return '每週'
  const m = /^w(\d{1,6})$/.exec(String(name ?? ''))
  const min = m ? Number(m[1]) : 0
  if (!min) return '額度'
  if (min === 300) return '5 小時'
  if (min === 10080) return '每週'
  if (min === 1440) return '每天'
  if (min % 1440 === 0) return `${min / 1440} 天`
  if (min % 60 === 0) return `${min / 60} 小時`
  return `${min} 分鐘`
}
const windowRank = name => (name === 'five_hour' ? 0 : name === 'weekly' ? 1 : 2)
const windowMinutes = name => { const m = /^w(\d+)$/.exec(String(name ?? '')); return m ? Number(m[1]) : 0 }

/** 設備名截到 max 個字（以字元計，中文一字算一個） */
export function shortDevice(label, max = DEVICE_MAX) {
  const chars = Array.from(String(label ?? '').trim())
  if (!chars.length) return UNNAMED_DEVICE
  return chars.length > max ? chars.slice(0, max).join('') : chars.join('')
}

/** 節點 → 設備名稱：名單裡那台的 device 欄；本機用 selfLabel；對不到寫「未命名設備」 */
export function nodeLabelOf(friends = [], { selfNode = '', selfLabel = '這台電腦' } = {}) {
  const names = new Map()
  for (const f of Array.isArray(friends) ? friends : []) if (f?.node && f.device && !names.has(f.node)) names.set(f.node, String(f.device))
  return node => names.get(node) || (node && node === selfNode ? selfLabel : UNNAMED_DEVICE)
}

// 一個帳號可用的額度窗（Grok 一律不算；壞掉的窗略過），照 5 小時、每週、其他由短到長排
function cleanWindows(entry) {
  if (entry?.vendor === 'grok' || !Array.isArray(entry?.windows)) return []
  return entry.windows
    .map(w => ({ name: String(w?.name ?? ''), pct: pct(w?.left_pct), reset: time(w?.resets_at), read: time(w?.read_at), node: typeof w?.read_node === 'string' ? w.read_node : '' }))
    .filter(w => w.pct != null && w.read != null)
    .sort((a, b) => windowRank(a.name) - windowRank(b.name) || windowMinutes(a.name) - windowMinutes(b.name))
}

/**
 * 一個帳號的額度顯示（形狀跟 account-quota.mjs 的 quotaView 相同，設備卡的樣板直接用）：
 *   { known, text, parts, meta, resetText, stale, exhausted, gone }
 *   parts：每個額度窗一句（「5 小時剩 40%」）；text＝parts 用頓號接起來；沒有數字時 text 寫原因（不留空白）
 *   meta：「3 小時前・工作機」；目前沒有任何一台還在回報的寫「3 天前讀的・工作機」
 */
export function rosterQuota(entry, { nodeLabel = () => UNNAMED_DEVICE, now = Date.now() } = {}) {
  const wins = cleanWindows(entry)
  const gone = !Array.isArray(entry?.nodes) || entry.nodes.length === 0
  const latest = wins.reduce((best, w) => (!best || w.read > best.read ? w : best), null)
  const at = latest ? latest.read : time(entry?.seen_at)
  const node = latest ? latest.node : (typeof entry?.seen_node === 'string' ? entry.seen_node : '')
  const ago = at != null ? agoText(new Date(at).toISOString(), now) : ''
  const where = node ? shortDevice(nodeLabel(node)) : ''
  const when = ago && gone ? `${ago}讀的` : ago
  const meta = [when, where].filter(Boolean).join('・')
  if (!wins.length) {
    const text = entry?.vendor === 'codex' ? ROSTER_TEXT.codexOff : ROSTER_TEXT.noQuota
    return { known: false, text, parts: [text], meta, resetText: '', stale: true, exhausted: false, gone }
  }
  const parts = wins.map(w => `${windowLabel(w.name)}剩 ${w.pct}%`)
  const out = wins.filter(w => w.pct === 0 && w.reset != null && w.reset > now).sort((a, b) => b.reset - a.reset)[0]
  return {
    known: true, text: parts.join('、'), parts, meta,
    resetText: out ? resetIn(new Date(out.reset).toISOString(), now, `${windowLabel(out.name)}額度`) : '',
    stale: now - latest.read > STALE_MS, exhausted: Boolean(out), gone,
  }
}

/** 查某廠牌某帳號在列表裡的那一筆（email 不分大小寫）；列表不能用就回 null 的查詢函式（永遠查不到） */
export function rosterLookup(roster) {
  if (!rosterOk(roster)) return () => null
  const map = new Map()
  for (const e of roster.accounts) if (e?.vendor && e?.account) map.set(keyOf(e.vendor, e.account), e)
  return (vendor, account) => map.get(keyOf(vendor, account)) ?? null
}

/** 某廠牌某帳號的額度顯示；列表裡沒有就回 undefined（呼叫端退回舊的顯示） */
export function rosterQuotaFor(roster, vendor, account, opts = {}) {
  const e = rosterLookup(roster)(vendor, account)
  return e ? rosterQuota(e, opts) : undefined
}

/**
 * 「我的帳號」整區：按廠牌分組列出全部帳號。列表不能用回 null（畫面不顯示這一區）。
 * 回 { title, empty, vendors:[{ key, label, accounts:[{ vendor, account, plan, current, quota }] }] }
 */
export function rosterView(roster, opts = {}) {
  if (!rosterOk(roster)) return null
  const groups = new Map()
  for (const e of roster.accounts) {
    const vendor = String(e?.vendor ?? '').toLowerCase()
    const account = String(e?.account ?? '').trim()
    if (!vendor || !account) continue
    const row = {
      vendor, account, plan: typeof e.plan === 'string' ? e.plan : '',
      current: Array.isArray(e.nodes) && e.nodes.some(n => n?.current === true),
      quota: rosterQuota(e, opts),
    }
    groups.set(vendor, [...(groups.get(vendor) ?? []), row])
  }
  const vendors = [...groups.entries()]
    .sort(([a], [b]) => (VENDOR_RANK[a] ?? 9) - (VENDOR_RANK[b] ?? 9) || a.localeCompare(b))
    .map(([key, accounts]) => ({ key, label: VENDOR_NAME[key] ?? key, accounts: [...accounts].sort((x, y) => x.account.localeCompare(y.account)) }))
  return { title: ROSTER_TEXT.title, empty: vendors.length ? '' : ROSTER_TEXT.empty, vendors }
}

/**
 * 向後台讀一次列表。call：() => Promise（電腦 invoke('acct_roster')、手機 invoke('android_acct_roster')）。
 * 讀不到（後台沒部署 404、沒登入、forbidden、格式不對）回 null，只在 console 記一筆，不報錯給使用者。
 */
export async function fetchRoster(call, log = (...a) => console.info(...a)) {
  try {
    const v = await call()
    if (rosterOk(v)) return v
    log('[帳號列表] 後台沒有回列表，改用各設備自己回報的額度', v?.error ?? '')
  } catch (e) {
    log('[帳號列表] 讀不到，改用各設備自己回報的額度', typeof e === 'string' ? e : e?.message ?? String(e))
  }
  return null
}

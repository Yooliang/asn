// 帳號列表（#374 第一批，畫面）：把後台 acct_roster 回的「本人所有設備回報的各廠牌帳號與額度」整理成畫面資料。
// 電腦（list.js、設定頁、切換對話框）與手機（m.js、mobile-acct.mjs）共用這一份。純函式：不改輸入、一律回傳新物件。
// 後台回傳（supabase/migrations/20261029100000_acct_roster.sql 的 asn_relay_acct_roster）：
//   { now, accounts: [{ vendor, account, plan, windows:[{ name, left_pct, resets_at, read_at, read_node }], seen_at, seen_node, nodes:[{ node, current, reported_at }] }] }
//   windows 空陣列＝沒有額度資料；nodes 空陣列＝目前沒有任何一台還在回報它（後台保留 30 天）。
// 後台沒部署、沒登入、回錯（404／forbidden）時一律當「沒有列表」（null），畫面退回各設備自己回報的數字。
import { deviceNameOf } from './device-known.mjs'
import { agoText } from './cloud-invite.mjs'
import { QUOTA_LINES, STALE_MS, planLabel, quotaBar, resetIn } from './account-quota.mjs'
import { UNNAMED_DEVICE } from './text.mjs'
import { inDevicePageOrder } from './device-order.mjs'
import { unnamedLabelOf } from './device-known.mjs'

export const ROSTER_TEXT = {
  title: '我的帳號',
  noQuota: QUOTA_LINES.unread,   // 「額度讀不到」只有這一個說法（#1879）
  codexOff: '開 Codex 後才讀得到',
  geminiOff: '開 Gemini 視窗後才讀得到',   // Gemini 額度只有 ASN 開的 Gemini 視窗讀得到（#374 之三）
  empty: '還沒有帳號回報',
  current: '使用中',
  noList: '現在讀不到帳號列表，請稍後再開一次。',
  usedOn: '用在',
  resetPending: '已重置，待更新',   // 那一窗的重置時間已經過了：記著的百分比不代表現在（#527 審查）
}
const FIVE_HOUR_STALE_MS = 30 * 60_000   // 5 小時那條 30 分鐘沒更新就算舊（#1688）；其他窗沿用 STALE_MS（6 小時）
export const FIVE_ONLY_WEEKLY_TEXT = '這個帳號最近只回報每週額度'
const FIVE_GONE_MS = 60 * 60_000   // 同一台後來讀到每週、5 小時卻停了這麼久：當作這個帳號已經沒有 5 小時窗（#1736）
const staleMsOf = name => (name === 'five_hour' || windowMinutes(name) === 300 ? FIVE_HOUR_STALE_MS : STALE_MS)
export const ROSTER_POLL_MS = 5 * 60_000   // 開著「設備與帳號」時多久重讀一次（跟額度回報同一個節奏，不另開更密的）
export const DEVICE_MAX = 8  // 「3 小時前・工作機」的設備名最多幾個字
const VENDOR_RANK = { claude: 0, codex: 1, gemini: 2, grok: 3, minimax: 4 }
const VENDOR_NAME = { claude: 'Claude', codex: 'OpenAI（Codex）', gemini: 'Gemini', grok: 'Grok', minimax: 'MiniMax' }
// 沒有額度窗時寫什麼：Codex、Gemini 要開過才讀得到；其他寫「額度讀不到」
const NO_WINDOW_TEXT = { codex: 'codexOff', gemini: 'geminiOff' }

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

/** 節點 → 設備名稱：名單裡那台的 device 欄；對不到寫「電腦（代號末 4 碼）」這種辨認線索，本機也一樣（#1829、#1803） */
export function nodeLabelOf(friends = [], { nodeNames = null } = {}) {
  return node => deviceNameOf(node, { nodeNames, friends }) || unnamedLabelOf(node, { friends })
}

// 沒有 5 小時窗的帳號（Ultra 等，#1736）：Claude 狀態列只送每週，後台還留著改方案前最後一筆 5 小時。
// 判斷：方案是 Ultra，或同一台電腦後來又讀到每週、但那條 5 小時比每週舊了超過 1 小時（有 5 小時窗的帳號兩條會一起更新；1 小時內仍照舊標舊，#1688）→ 那條 5 小時已經沒有在送，不列、也不拿它算過期。
// 不同電腦讀的不算（那是換帳號前的舊視窗，#1688，照舊標舊）；只動 Claude
const fiveGone = (entry, w, all) => entry?.vendor === 'claude' && (w.name === 'five_hour') && (
  /ultra/i.test(String(entry?.plan ?? '')) ||
  all.some(o => o.name === 'weekly' && o.node === w.node && o.read - w.read > FIVE_GONE_MS))

// 一個帳號可用的額度窗（壞掉的窗略過），照 5 小時、每週、其他由短到長排
function cleanWindows(entry, keepGone = false) {
  if (!Array.isArray(entry?.windows)) return []
  return entry.windows
    .map(w => ({ name: String(w?.name ?? ''), pct: pct(w?.left_pct), reset: time(w?.resets_at), read: time(w?.read_at), node: typeof w?.read_node === 'string' ? w.read_node : '' }))
    .filter(w => w.pct != null && w.read != null)
    .filter((w, _i, all) => keepGone || !fiveGone(entry, w, all))
    .sort((a, b) => windowRank(a.name) - windowRank(b.name) || windowMinutes(a.name) - windowMinutes(b.name))
}

/**
 * 一個帳號的額度顯示（設備卡的樣板直接用）：
 *   { known, text, parts, meta, listMeta, resetText, stale, exhausted, gone }
 *   parts：「我的帳號」區逐窗一句，各窗標自己的讀取時間與哪台讀的（「5 小時剩 40%・2 天前・工作機」）；
 *     重置時間已經過了的窗寫「5 小時已重置，待更新」（那個百分比已經不代表現在）
 *   text＋meta：設備卡、切換對話框的一行版。只接 5 小時、每週兩窗，跳過已重置的窗；
 *     兩窗讀取時間不同時，meta 標**較舊**的那個（「2 天前・工作機」），stale 也看較舊的——舊數字不能看起來像新的（#527 審查）
 *   listMeta：「我的帳號」區那一行後面的括號：有窗時只寫哪台讀的（時間各窗自己標了，最多兩台）；沒有任何窗時同 meta（最後一次回報）
 *   目前沒有任何一台還在回報的，時間寫成「3 天前讀的」
 *   bars（#374）：一行版那幾窗的額度條，每條自己寫重置時間（重置時間已過的那一窗不列）；過期（stale）時畫面把額度區改淡色，不另寫「舊資料」字樣（#2111）
 */
export function rosterQuota(entry, opts = {}) {
  const q = rosterQuotaInner(entry, opts)
  // 5 小時那條停了、被拿掉時，畫面在原位寫一行灰字說明，不是默默不見（#1736）
  const fiveNote = cleanWindows(entry, true).length !== cleanWindows(entry).length
  return fiveNote ? { ...q, fiveNote: FIVE_ONLY_WEEKLY_TEXT } : q
}

function rosterQuotaInner(entry, { nodeLabel = node => unnamedLabelOf(node), now = Date.now() } = {}) {
  const wins = cleanWindows(entry)
  // gemini 的 nodes 後台一律回空陣列（20261029130000_acct_roster_gemini：nodes 來自舊表、舊表不收 gemini），
  // 看不出有沒有設備還在回報，所以不當成「沒有設備在回報」
  const gone = entry?.vendor !== 'gemini' && entry?.vendor !== 'minimax' && (!Array.isArray(entry?.nodes) || entry.nodes.length === 0)
  const readNodesOf = list => [...new Set(list.map(w => w.node).filter(Boolean))]   // 這幾窗是哪幾台讀的（設備按鈕上標藍線用）
  const agoOf = at => (at != null ? agoText(new Date(at).toISOString(), now) : '')   // 「3 天前」（「我的帳號」卡片帳號後面的括號用，不加「讀的」）
  const stamp = (at, node) => {
    const ago = agoOf(at)
    const when = ago && gone ? `${ago}讀的` : ago
    return [when, node ? shortDevice(nodeLabel(node)) : ''].filter(Boolean).join('・')
  }
  if (!wins.length) {
    const text = ROSTER_TEXT[NO_WINDOW_TEXT[entry?.vendor] ?? 'noQuota']
    const seenNode = typeof entry?.seen_node === 'string' ? entry.seen_node : ''
    const meta = stamp(time(entry?.seen_at), seenNode)
    return { known: false, text, parts: [text], meta, listMeta: meta, ageLabel: agoOf(time(entry?.seen_at)), readNodes: seenNode ? [seenNode] : [], resetText: '', bars: [], stale: true, exhausted: false, gone }
  }
  const expired = w => w.reset != null && w.reset <= now
  const parts = wins.map(w => (expired(w)
    ? `${windowLabel(w.name)}${ROSTER_TEXT.resetPending}`
    : [`${windowLabel(w.name)}剩 ${w.pct}%`, stamp(w.read, '')].filter(Boolean).join('・')))
  // 「我的帳號」區括號裡只寫哪台讀的（時間已在各窗自己標了）；不同台讀的最多列兩台，免得超過 20 字
  const devices = [...new Set(wins.filter(w => w.node).map(w => shortDevice(nodeLabel(w.node))))].slice(0, 2)
  const listMeta = devices.join('、')
  // 接成一行的 text 只放 5 小時、每週兩窗，才不會超過 20 字；其他窗只在「我的帳號」區逐窗列出（parts）。
  // 只有其他長度的窗時（目前不會發生），放最短的那一窗，不讓這一行變成空白
  const main = wins.filter(w => ['5 小時', '每週'].includes(windowLabel(w.name)))
  const inLine = main.length ? main : wins.slice(0, 1)
  const live = inLine.filter(w => !expired(w))
  const oldestOf = list => list.reduce((o, w) => (!o || w.read < o.read ? w : o), null)
  const out = wins.filter(w => w.pct === 0 && w.reset != null && w.reset > now).sort((a, b) => b.reset - a.reset)[0]
  const resetText = out ? resetIn(new Date(out.reset).toISOString(), now, `${windowLabel(out.name)}額度`) : ''
  const bars = inLine.filter(w => !expired(w)).map(w => quotaBar(w.name, windowLabel(w.name), w.pct, w.reset != null ? new Date(w.reset).toISOString() : undefined, now))
  if (!live.length) {
    // 這一行該放的窗都已經重置過了：數字不代表現在，不列，寫「已重置，待更新」
    const o = oldestOf(inLine)
    return { known: false, text: ROSTER_TEXT.resetPending, parts, meta: stamp(o.read, o.node), listMeta, ageLabel: agoOf(o.read), readNodes: readNodesOf(inLine), resetText, bars, stale: true, exhausted: Boolean(out), gone }
  }
  const oldest = oldestOf(live)
  const staleWins = live.filter(w => now - w.read > staleMsOf(w.name))
  const stale = staleWins.length > 0
  const shown = stale ? oldestOf(staleWins) : oldest   // 括號裡的時間寫「舊的那一窗」的，免得新的那窗把舊的蓋掉
  return {
    known: true, text: live.map(w => `${windowLabel(w.name)}剩 ${w.pct}%`).join('、'), parts,
    meta: stamp(oldest.read, oldest.node), listMeta,   // 手機與設備卡的時間照舊標「兩窗裡最舊的」（#527 審查）；只有電腦「我的帳號」括號的 ageLabel 寫過期那一窗的
    // 「我的帳號」卡片的新排法：時間放在帳號後面的括號，讀這筆額度的那台只標在它的設備按鈕上；meta 留給手機與設備卡
    ageLabel: agoOf(shown.read), readNodes: readNodesOf(live),
    resetText, bars,
    stale, exhausted: Boolean(out), gone,
  }
}

// ---- 這台自己目前登入的 Claude 帳號（#1883）：本機的查詢狀態 claude_quota_state ----
const STATE_TEXT = { login_expired: QUOTA_LINES.loginExpired, rate_limited: QUOTA_LINES.rateLimited, unavailable: QUOTA_LINES.unavailable }

/** claude_quota_state 的回傳 → 乾淨的狀態（形狀不對、沒有指令一律當 none）：{ email, status, readAt, windows } */
export function normalizeQuotaState(raw) {
  const status = ['ok', 'login_expired', 'rate_limited', 'unavailable'].includes(raw?.status) ? raw.status : 'none'
  const email = typeof raw?.email === 'string' && raw.email.trim() ? raw.email.trim().toLowerCase() : ''
  const windows = status === 'ok' && Array.isArray(raw?.windows) ? raw.windows.filter(w => pct(w?.left_pct) != null && time(w?.read_at) != null) : []
  return { email, status: status === 'ok' && !windows.length ? 'none' : status, readAt: typeof raw?.read_at === 'string' ? raw.read_at : '', windows }
}

const stubQuota = text => ({ known: false, text, parts: [text], meta: '', listMeta: '', ageLabel: '', readNodes: [], resetText: '', bars: [], stale: true, exhausted: false, gone: false })

/**
 * 這台電腦上一個 Claude 帳號的額度顯示：
 * - 這台目前登入的帳號（current）：查詢成功就用本機剛讀到的窗；失敗用固定的一句話寫原因（不沿用舊數字）；還沒讀過就看後台列表，沒有就寫「讀取中」
 * - 其他帳號（帳號庫裡沒在用的）：只看後台列表（別台最後一次讀數），沒有就寫「額度讀不到」
 * state＝normalizeQuotaState 的結果；roster＝後台列表（可為 null）；回形狀同 rosterQuota
 */
export function selfClaudeQuota(state, email, { current = false, roster = null, nodeLabel, now = Date.now() } = {}) {
  const st = state && typeof state === 'object' && 'windows' in state ? state : normalizeQuotaState(state)
  const entry = rosterLookup(roster)('claude', email)
  const opts = { nodeLabel, now }
  if (current && (!st.email || st.email === String(email ?? '').trim().toLowerCase())) {
    if (st.status === 'ok') return rosterQuota({ vendor: 'claude', plan: entry?.plan ?? '', windows: st.windows, nodes: [{ node: '', current: true }] }, opts)
    if (STATE_TEXT[st.status]) return stubQuota(STATE_TEXT[st.status])
    return entry ? rosterQuota(entry, opts) : stubQuota(QUOTA_LINES.reading)
  }
  return entry ? rosterQuota(entry, opts) : stubQuota(QUOTA_LINES.unread)
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
 * 某台設備上某廠牌的帳號（目前給 Gemini 用：它不在各台自己的帳號回報裡，只在列表）。
 * 後台有帶 nodes（20261030100000_acct_reset_times 之後）：只列這台正在用的（current），標使用中——同一個帳號兩台都讀過，只列在用的那台。
 * nodes 是空的（舊後台）：照舊認「哪台讀的」（任一額度窗的 read_node 或 seen_node 是這台），current 一律 false。
 * 回 [{ email, plan, current, quota }]；列表不能用回空陣列
 */
export function rosterAccountsOn(roster, vendor, node, opts = {}) {
  if (!rosterOk(roster) || !node) return []
  const want = String(vendor ?? '').toLowerCase()
  const usingHere = e => Array.isArray(e.nodes) && e.nodes.some(n => n?.node === node && n.current === true)
  const readHere = e => e.seen_node === node || (Array.isArray(e.windows) && e.windows.some(w => w?.read_node === node))
  return roster.accounts
    .filter(e => String(e?.vendor ?? '').toLowerCase() === want && e?.account
      && (Array.isArray(e.nodes) && e.nodes.length ? usingHere(e) : readHere(e)))
    .map(e => ({ email: String(e.account).trim(), plan: planLabel(e.plan), current: usingHere(e), quota: rosterQuota(e, opts) }))
    .sort((a, b) => a.email.localeCompare(b.email))
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
      vendor, account, plan: planLabel(e.plan),
      current: Array.isArray(e.nodes) && e.nodes.some(n => n?.current === true),
      quota: rosterQuota(e, opts),
      shared: e.shared === true,   // 有沒有開查詢代碼（代碼本身讀不回來）
      // 用在哪幾台（目前還有在回報這個帳號的設備；使用中的排前面）
      usedOn: usedOnOf(e, opts),
    }
    groups.set(vendor, [...(groups.get(vendor) ?? []), row])
  }
  const vendors = [...groups.entries()]
    .sort(([a], [b]) => (VENDOR_RANK[a] ?? 9) - (VENDOR_RANK[b] ?? 9) || a.localeCompare(b))
    .map(([key, accounts]) => ({ key, label: VENDOR_NAME[key] ?? key, accounts: [...accounts].sort((x, y) => x.account.localeCompare(y.account)) }))
  return { title: ROSTER_TEXT.title, empty: vendors.length ? '' : ROSTER_TEXT.empty, vendors }
}

/** 這個帳號用在哪幾台：後台 nodes（目前還有在回報它的設備）→ [{ node, label, current }]，使用中的排前面 */
function usedOnOf(e, opts) {
  const label = typeof opts?.nodeLabel === 'function' ? opts.nodeLabel : () => ''
  const seen = new Set()
  const list = []
  for (const n of Array.isArray(e?.nodes) ? e.nodes : []) {
    const node = typeof n?.node === 'string' ? n.node : ''
    if (!node || seen.has(node)) continue
    seen.add(node)
    list.push({ node, label: label(node) || unnamedLabelOf(node), current: n.current === true })
  }
  return list.sort((a, b) => Number(b.current) - Number(a.current))   // 使用中的排前面，其餘保持後台給的順序（不依語系排，免得不同機器順序不一樣）
}
export const usedOnText = row => (row?.usedOn ?? []).map(n => (n.current ? `${n.label}（使用中）` : n.label)).join('、')

export const DEVICE_BUTTON_TEXT = { group: '用在哪幾台' }

/** 帳號卡設備列：按鈕上的字（電腦、手機同一份，#2111） */
export const DEVICE_ROW_TEXT = Object.freeze({ current: '使用中', switch: '切換', busy: '切換中…', blocked: '不能切換', offline: '離線中', self: '這台' })

/** 設備列的鈕畫成哪種狀態：離線中沿用「不能切換」的虛線淡色（#2111 ⑥）；電腦（asn-button 的 state）與手機（m-dv-dev 的 class）共用 */
export const rowLook = state => (state === 'offline' ? 'blocked' : state)

/** 這台設備算不算離線（#2111 ⑥）：本機永遠在線；其餘看設備樹的在線狀態（isDeviceOnline），或對方 ASN 沒開（設備樹給的 switchHint）。電腦、手機共用 */
export const deviceRowOffline = (d, v) => d?.self !== true && (d?.online === false || Boolean(v?.switchHint))

/** 登入失效（#1960，電腦、手機同一份）：設備列、卡片頂端標籤、額度區、名單上方提示的字都在這裡 */
export const LOGIN_LOST_TEXT = Object.freeze({
  button: '重新登入',
  row: '登入已失效',
  rowElsewhere: '登入已失效，到那台重新登入',   // 現在沒辦法從這裡替那台重新登入（離線、ASN 沒開）：不放鈕，講清楚去哪做
  tag: '登入已失效',
  quota: '額度暫時看不到',
  notice: (who, vendor, email) => `${who}的 ${vendor} 帳號 ${email} 需要重新登入，登入前不能切換到這個帳號。`,
  who: (label, self) => (self ? `這台（${label}）` : label),
})

/** 設備列切不過去時，寫在設備名下方的原因：每種都說清楚、說怎麼辦（#2110；電腦、手機同一份） */
export const DEVICE_BLOCK_REASON = Object.freeze({
  vendor: '這個服務不能切換',
  phone: '手機不能切換帳號',
  offline: 'ASN 尚未開啟',
  incomplete: '這台的登入沒完成，到那台重新登入這個帳號',
  single: '這台只有這一個帳號，沒有別的可以切換',
  unknown: '暫時切不了，請稍後再試',
})

/** 這台設備在這個廠商底下的狀態：{ state: 'current'|'switch'|'blocked', reason }（只看設備樹，不看「切換中」） */
function rowStateOf(d, v, has, vendor, isCurrent, vendors) {
  if (isCurrent) return { state: 'current', reason: '' }
  if (!vendors.includes(vendor)) return { state: 'blocked', reason: DEVICE_BLOCK_REASON.vendor }
  if (!has) return { state: 'blocked', reason: DEVICE_BLOCK_REASON.unknown }   // 還沒收到那台的帳號回報：不知道，不說「沒有」
  if (has.incomplete) return { state: 'blocked', reason: DEVICE_BLOCK_REASON.incomplete }
  if (d.phone || d.kind === '手機') return { state: 'blocked', reason: DEVICE_BLOCK_REASON.phone }
  const count = (v.accounts ?? []).length
  if (d.self) {
    if (vendor === 'grok' && count <= 1) return { state: 'blocked', reason: DEVICE_BLOCK_REASON.single }
    return { state: 'switch', reason: '' }
  }
  if (v.switchable) return { state: 'switch', reason: '' }
  if (v.switchHint) return { state: 'blocked', reason: DEVICE_BLOCK_REASON.offline }
  return { state: 'blocked', reason: count < 2 ? DEVICE_BLOCK_REASON.single : DEVICE_BLOCK_REASON.unknown }
}

/**
 * 帳號卡的「用在哪幾台」：一台一列（#2111 ②、#2110、#1858，電腦與手機共用這一個函式）。
 * devices＝設備樹（{ key, label, self, hidden, removed, phone, kind, vendors }）；usedOn＝後台回報的 [{ node, label, current }]；
 * opts.switchingNode＝正在切換的那台（該列顯示「切換中…」）；opts.vendors＝這個平台能切換的服務（預設 Claude、Grok；手機只有 Claude）。
 * 回 [{ node, label, self, current, state: 'current'|'switch'|'busy'|'blocked', reason }]，使用中的排前面。
 * 不列：設備代號在設備樹找不到的舊紀錄、已隱藏、已永久移除、沒登入這個帳號的設備。
 * 本機以本機帳號庫（設備樹裡本機自己的帳號）為準：它說在用就是「使用中」，不管後台列表怎麼說。
 */
export function accountDeviceRows(devices, vendor, email, usedOn, opts = {}) {
  const mail = String(email ?? '').trim().toLowerCase()
  const used = new Map((Array.isArray(usedOn) ? usedOn : []).filter(u => u && typeof u.node === 'string' && u.node).map(u => [u.node, u]))
  const rows = []
  for (const d of inDevicePageOrder(devices)) {
    if (!d || !d.key || d.hidden || d.removed) continue
    const v = (d.vendors ?? []).find(x => x.key === vendor)
    const has = (v?.accounts ?? []).find(x => String(x.email ?? '').trim().toLowerCase() === mail)
    const u = used.get(d.key)
    // 設備樹沒有這個廠商（還沒收到那台的回報）時，後台說它用過這個帳號就列出來；有回報卻沒這個帳號＝沒登入，不列
    const unreported = !d.self && !v && Boolean(u)
    // 後台說這台正在用這個帳號，就一定列出（手機沒有自己的帳號庫、設備樹裡看不到它的帳號，也一樣）
    // 只在設備樹裡根本沒有這個廠商（手機沒有自己的 Claude 帳號庫）時才信後台；本機有這個廠商的帳號庫就以庫為準，
    // 後台舊資料說在用也不畫（#2110：換過帳號、後台還沒更新時，不能把本機沒登入的帳號寫成「使用中」）
    const usingByBackend = u?.current === true && !v
    if (!has && !unreported && !usingByBackend) continue
    const offline = deviceRowOffline(d, v)
    // 離線的設備在每張帳號卡都一律「離線中」：後台舊回報說它正在用這個帳號也一樣，不寫「使用中」（#2111 ⑥）
    const current = !offline && (d.self && has ? has.current === true : (u?.current === true || has?.current === true))
    const st = offline ? { state: 'offline', reason: '' } : rowStateOf(d, v ?? { accounts: [] }, has, vendor, current, Array.isArray(opts.vendors) ? opts.vendors : ['claude', 'grok'])
    const busy = st.state !== 'current' && st.state !== 'offline' && opts.switchingNode === d.key
    const label = d.label || u?.label || unnamedLabelOf(d.key)
    // 登入失效（#1960）：沿用各台帳號回報裡的旗標（device-tree 的 loginFailed）；能不能從這裡替它重新登入看設備樹算好的 relogin 入口（本機／別台）
    if (vendor === 'claude' && has?.loginFailed === true) {
      const kind = v?.relogin?.kind === 'local' || v?.relogin?.kind === 'remote' ? v.relogin.kind : ''
      rows.push({ node: d.key, label, self: d.self === true, current, loginFailed: true, relogin: kind, state: kind ? 'relogin' : 'expired', look: kind ? 'relogin' : 'expired', reason: kind ? LOGIN_LOST_TEXT.row : LOGIN_LOST_TEXT.rowElsewhere })
      continue
    }
    const state = busy ? 'busy' : st.state
    rows.push({ node: d.key, label, self: d.self === true, current, state, look: rowLook(state), reason: busy ? '' : st.reason })
  }
  return rows   // 順序＝「設備」頁的順序（這台第一，其餘照設備頁），每張帳號卡一致；使用中的不再排前面（#2111 ⑥）
}

/** 這個帳號有沒有哪一台登入失效（卡片頂端標籤、額度區改寫「額度暫時看不到」都看這一個） */
export const accountLoginLost = rows => Array.isArray(rows) && rows.some(r => r?.loginFailed === true)

/**
 * 帳號名單上方的提示（#1960）：每個失效的「設備＋帳號」一行，寫明是哪台、哪家的帳號。提示本身不放鈕，鈕在那一列。
 * sections＝[{ key, label, accounts:[{ account }] }]（廠牌分組）；rowsOf(vendorKey, account)＝該帳號的設備列（accountDeviceRows 的結果）。
 * 回 [{ key, text }]
 */
export function loginLostNotices(sections, rowsOf) {
  const out = []
  for (const sec of Array.isArray(sections) ? sections : []) {
    for (const a of sec?.accounts ?? []) {
      for (const r of rowsOf(sec.key, a) ?? []) {
        if (r?.loginFailed !== true) continue
        out.push({ key: `${sec.key}|${a.account}|${r.node}`, text: LOGIN_LOST_TEXT.notice(LOGIN_LOST_TEXT.who(r.label, r.self), sec.label, a.account) })
      }
    }
  }
  return out
}

/** 卡片頂端的「使用中」：以設備列為準（列表裡沒有任何設備時才退回後台說的），兩邊不會互相矛盾（#2110） */
export const accountInUse = (rows, backendCurrent) => (Array.isArray(rows) && rows.length ? rows.some(r => r.current) : backendCurrent === true)

/**
 * 向後台讀一次列表。call：() => Promise（電腦 invoke('acct_roster')、手機 invoke('android_acct_roster')）。
 * 讀不到（後台沒部署 404、沒登入、forbidden、格式不對）時回 prev（上一次讀成功的列表，照它自己的「N 小時前」顯示），
 * 網路短斷不會在新舊數字間跳；從沒讀成功過（prev 是 null）才回 null，畫面退回各設備自己回報的數字。只在 console 記一筆，不報錯給使用者。
 */
export async function fetchRoster(call, log = (...a) => console.info(...a), prev = null) {
  const keep = rosterOk(prev) ? prev : null
  const why = keep ? '沿用上一次讀到的列表' : '改用各設備自己回報的額度'
  try {
    const v = await call()
    if (rosterOk(v)) return v
    log(`[帳號列表] 後台沒有回列表，${why}`, v?.error ?? '')
  } catch (e) {
    log(`[帳號列表] 讀不到，${why}`, typeof e === 'string' ? e : e?.message ?? String(e))
  }
  return keep
}

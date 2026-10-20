// 名單視窗的頁籤、通知紀錄、群組列與廣告輪播（純邏輯，node 與瀏覽器都能跑）。

// 固定在設備頁籤之後的頁籤（群組只有在有唯讀 API 時才放，目前有 room_list）
export const FIXED_TABS = [
  { key: 'groups', label: '群組' },
  { key: 'notices', label: '通知' },
  { key: 'settings', label: '設定' },
]
export const DEVICE_TAB_MAX = 6   // 設備頁籤超過 6 個時，第 6 個起收進「更多」
export const MORE_KEY = 'more'

// 名字後面的灰字狀態：線上不加
const NOTE = { busy: '忙碌', away: '暫離', offline: '離線' }
export const statusNote = status => (NOTE[status] ? `(${NOTE[status]})` : '')

// 組標題：依狀態分的組只寫人數「線上 (3)」；其他組寫「名稱 (線上數/總數)」，線上＝非離線
export function groupHeading(g) {
  const items = g?.items ?? []
  if (g?.kind === 'status') return `${g.label} (${items.length})`
  return `${g?.label ?? ''} (${items.filter(c => c.status !== 'offline').length}/${items.length})`
}

// ---------- 設備頁籤 ----------
// 每台設備一個頁籤：本機永遠第一，其餘照收發室名單順序，名單裡已消失但有對話紀錄的（好友全離線）排在最後。
// 超過 DEVICE_TAB_MAX 個時，第 DEVICE_TAB_MAX 個起收進「更多」；本機不會被收進去。
// 回傳 { all, visible, more }：每項 { key, label, short, unread, online, total }；more 為空代表不需要「更多」。
export const shortOf = label => Array.from(String(label ?? '').trim())[0]?.toUpperCase() ?? '?'
export function deviceTabs(friends, { selfNode, nodeOrder = [], max = DEVICE_TAB_MAX } = {}) {
  const by = new Map()
  const slot = (key, label) => {
    if (!by.has(key)) by.set(key, { key, label: label || key, short: '', unread: 0, online: 0, total: 0 })
    const t = by.get(key)
    if (label && t.label === key) t.label = label
    return t
  }
  slot(selfNode, '')
  for (const f of friends) {
    const t = slot(f.node ?? '', f.device)
    t.total++
    if (f.status !== 'offline') t.online++
    t.unread += f.unread || 0
  }
  const rank = new Map(nodeOrder.map((k, i) => [k, i]))
  const rest = [...by.values()].filter(t => t.key !== selfNode)
  const inRoster = rest.filter(t => rank.has(t.key)).sort((a, b) => rank.get(a.key) - rank.get(b.key))
  const gone = rest.filter(t => !rank.has(t.key)).sort((a, b) => a.label.localeCompare(b.label, 'zh-Hant'))
  const all = [by.get(selfNode), ...inRoster, ...gone].map(t => ({ ...t, short: shortOf(t.label) }))
  if (all.length <= max) return { all, visible: all, more: [] }
  return { all, visible: all.slice(0, max - 1), more: all.slice(max - 1) }
}
// 頁籤上的未讀紅點：該頁籤有未讀；「更多」＝收進去的設備任一有未讀
export const tabUnread = t => t.unread || 0
export const moreUnread = more => more.reduce((n, t) => n + tabUnread(t), 0)
// 某設備的好友清單：線上／忙碌在前、離線在後（同級照名字）；match 為搜尋
export function deviceItems(friends, key, match = () => true) {
  const rank = s => (s === 'offline' ? 1 : 0)
  return friends.filter(f => (f.node ?? '') === key && match(f)).sort((a, b) => rank(a.status) - rank(b.status) || a.nick.localeCompare(b.nick, 'zh-Hant'))
}

// ---------- 通知紀錄：新的在前，最多 max 筆 ----------
export const NOTICE_MAX = 50
export function addNotice(list, n, { max = NOTICE_MAX, now = Date.now } = {}) {
  const item = { cid: n.cid, who: String(n.who ?? ''), line: String(n.line ?? ''), kind: n.kind ?? 'msg', t: n.t ?? now() }
  return [item, ...list].slice(0, max)
}
export function fmtTime(t, now = Date.now()) {
  const d = new Date(t), n = new Date(now)
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  if (d.toDateString() === n.toDateString()) return hm
  return `${d.getMonth() + 1}/${d.getDate()} ${hm}`
}

// ---------- 群組列（room_list 的唯讀結果）：最近有動靜的在前 ----------
export function groupRows(rooms) {
  const rows = []
  for (const r of Array.isArray(rooms) ? rooms : []) {
    if (!r || typeof r.id !== 'string') continue
    const count = Array.isArray(r.members) ? r.members.length : (Array.isArray(r.mine) ? r.mine.length : 0)
    rows.push({
      id: r.id, name: String(r.name || r.id), count,
      last: r.last_body ? `${r.last_from_name ? `${r.last_from_name}：` : ''}${String(r.last_body).replace(/\s+/g, ' ').slice(0, 40)}` : '',
      at: Date.parse(r.last_at ?? r.created_at) || 0,
    })
  }
  return rows.sort((a, b) => b.at - a.at)
}

// ---------- 底部廣告：自家產品宣傳＋一則招租，輪播。不用任何 AdSense 或外部廣告程式碼 ----------
// 文案的事實出處：希緒＝README／docs/HANDOFF.md；正見＝Yooliang/policy-tw 的 README（政見追蹤平台、每筆都附來源網址）；
// 島作＝Yooliang/IslandMade 的 README（繁體中文的 AI 作品介紹與評論網站，聚焦台灣開發者）。每則一句標語＋一個短按鈕字。
// url 只能是下面列的公開網址，且必須同時列在 Rust 端 lib.rs 的 OPEN_ALLOW（有測試比對兩邊一致）。
// 招租的聯絡方式還沒給：AD_CONTACT_URL 是空字串時，招租那則照常輪播顯示，但按鈕不可點、不會開任何網址；
// 之後填上網址時要同步加進 lib.rs 的 OPEN_ALLOW。
export const AD_CONTACT_URL = ''
export const ADS = [
  { key: 'shio', badge: 'NEW', title: '認識希緒', sub: '住在 3D 家裡、陪你聊天的 AI 角色', cta: '去看看', url: 'https://irori.web.app/', hue: 205 },
  { key: 'policy', badge: '', title: '正見', sub: '追蹤政見做到多少，附來源', cta: '看看', url: 'https://policy-tw.web.app', hue: 170 },
  { key: 'islandmade', badge: '', title: '島作', sub: '台灣開發者做的 AI 作品介紹', cta: '逛逛', url: 'https://islandmade.app', hue: 150 },
  { key: 'devlog', badge: '', title: '開發日誌', sub: '每次改動都有截圖可以看', cta: '翻翻看', url: 'https://irori.web.app/dev/shots/', hue: 28 },
  { key: 'rent', badge: '', title: '廣告位招租', sub: '這個位置可以放你的廣告', cta: '洽詢', url: AD_CONTACT_URL, hue: 48 },
]
export const AD_MS = 6000
export const nextAd = (i, n = ADS.length) => (n > 0 ? (i + 1) % n : 0)
export const adUrls = () => [...new Set(ADS.map(a => a.url).filter(Boolean))]
// 點廣告：有網址才呼叫 open（桌面版＝Rust 的 open_url，再比對白名單）；沒有網址（招租尚未填聯絡方式、純文字那種）什麼都不做
export function openAdWith(ad, open) {
  const u = typeof ad?.url === 'string' ? ad.url : ''
  if (!u) return false
  open(u)
  return true
}

// ---------- 設備頁裡的分組 ----------
// mode＝'status'：線上／忙碌／暫離／離線；mode＝'engine'：Claude／Gemini／Grok…（沒回報類型的歸「其他」，排最後）。空的組不列。
const STATUS_GROUPS = [['online', '線上'], ['busy', '忙碌'], ['away', '暫離'], ['offline', '離線']]
const ENGINE_ORDER = ['claude', 'gemini', 'grok', 'codex', 'deepseek']
const ENGINE_LABEL = { claude: 'Claude', gemini: 'Gemini', grok: 'Grok', codex: 'Codex', deepseek: 'DeepSeek', gpt: 'GPT' }
// 節點回報的 kind 只有這幾個值可以拿來推斷廠商；'other' 不採用
const KIND_VENDORS = ['claude', 'gpt', 'gemini', 'grok']
// 廠商：好友自己回報的 engine 優先；沒回報（null）就用所在節點的 kind（claude／gpt／gemini／grok）；都沒有＝其他
export const engineKey = f => {
  const e = String(f?.engine ?? '').trim().toLowerCase()
  if (e) return e
  const k = String(f?.kind ?? '').trim().toLowerCase()
  return KIND_VENDORS.includes(k) ? k : 'other'
}
export const engineRank = k => (k === 'other' ? 1e3 : ENGINE_ORDER.includes(k) ? ENGINE_ORDER.indexOf(k) : 100)
export const engineLabel = k => ENGINE_LABEL[k] ?? (k === 'other' ? '其他' : k.charAt(0).toUpperCase() + k.slice(1))
export function groupInDevice(items, mode = 'status') {
  if (mode === 'engine') {
    const by = new Map()
    for (const f of items) { const k = engineKey(f); if (!by.has(k)) by.set(k, []); by.get(k).push(f) }
    const keys = [...by.keys()].sort((a, b) => engineRank(a) - engineRank(b) || a.localeCompare(b))
    const st = s => STATUS_GROUPS.findIndex(([k]) => k === s)
    return keys.map(k => ({ key: `engine:${k}`, kind: 'engine', label: engineLabel(k),
      items: by.get(k).slice().sort((a, b) => st(a.status) - st(b.status)) }))
  }
  return STATUS_GROUPS.map(([k, label]) => ({ key: `status:${k}`, kind: 'status', label, items: items.filter(f => f.status === k) }))
    .filter(g => g.items.length)
}

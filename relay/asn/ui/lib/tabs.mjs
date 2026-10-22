// 名單視窗的頁籤、群組列與廣告輪播（純邏輯，node 與瀏覽器都能跑）。
import { UNNAMED_DEVICE } from './text.mjs'
import { isAsnWindow } from './roster.mjs'

// 固定在設備頁籤之後的頁籤（群組只有在有唯讀 API 時才放，目前有 room_list）
export const FIXED_TABS = [
  { key: 'groups', label: '群組' },
  { key: 'guide', label: '指引' },
  { key: 'settings', label: '設定' },
]
// 名單頁籤的鍵：舊存檔／設定若寫著已拿掉的頁籤（例如通知）或任何不認得的值，一律當沒有，退回名單第一頁
export const normalizeTab = (key, validKeys = []) => (FIXED_TABS.some(t => t.key === key) || validKeys.includes(key) ? key : '')
export const DEVICE_TAB_MAX = 6   // 設備頁籤超過 6 個時，第 6 個起收進「更多」
export const MORE_KEY = 'more'

// 名字後面的灰字狀態：線上不加
const NOTE = { busy: '忙碌', away: '暫離', offline: '離線' }
export const statusNote = status => (NOTE[status] ? `(${NOTE[status]})` : '')

// 組標題：依狀態分的組只寫人數「線上 (3)」；其他組寫「名稱 (線上數/總數)」，線上＝非離線
export function groupHeading(g) {
  const items = g?.items ?? []
  if (g?.kind === 'archived') return `${g.label}（${items.length}）`   // 名單最底下收合的「已封存」群組
  if (g?.kind === 'status') return `${g.label} (${items.length})`
  return `${g?.label ?? ''} (${items.filter(c => c.status !== 'offline').length}/${items.length})`
}

// ---------- 設備頁籤 ----------
// 每台設備一個頁籤：本機永遠第一，其餘照收發室名單順序，名單裡已消失但有對話紀錄的（好友全離線）排在最後。
// 超過 DEVICE_TAB_MAX 個時，第 DEVICE_TAB_MAX 個起收進「更多」；本機不會被收進去。
// 回傳 { all, visible, more }：每項 { key, label, short, unread, online, total }；more 為空代表不需要「更多」。
export const shortOf = label => Array.from(String(label ?? '').trim())[0]?.toUpperCase() ?? '?'
export function deviceTabs(friends, { selfNode, selfName = '', nodeOrder = [], max = DEVICE_TAB_MAX } = {}) {
  const by = new Map()
  const slot = (key, label) => {
    if (!by.has(key)) by.set(key, { key, label: label || UNNAMED_DEVICE, short: '', unread: 0, online: 0, total: 0 })
    const t = by.get(key)
    if (label && t.label === UNNAMED_DEVICE) t.label = label
    return t
  }
  slot(selfNode, selfName)   // 本機這頁籤＝自己的視窗名；其他設備＝該設備 ASN 設的名字，沒有就「未命名設備」，不顯示節點代號
  for (const f of friends) {
    const t = slot(f.node ?? '', (f.node ?? '') === selfNode && selfName ? selfName : f.device)
    if (isAsnWindow(f)) continue   // ASN 視窗隱藏：設備頁籤照開，但不算進人數與未讀
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
  return friends.filter(f => !isAsnWindow(f) && (f.node ?? '') === key && match(f)).sort((a, b) => rank(a.status) - rank(b.status) || a.nick.localeCompare(b.nick, 'zh-Hant'))
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

// ---------- 廣告：底部小輪播與整合模式「開始」頁的大幅輪播共用這份資料。自家產品宣傳＋一則招租，輪播。不用任何 AdSense 或外部廣告程式碼 ----------
// 平常從官網 site/public/ads.json 線上抓（Rust 的 ads_fetch）；下面這份是打包備用，抓不到時才用，key 集合要跟 ads.json 一致（有守門測試）。
// 可點的網址只准 https 且網域在 Rust 端 ads.rs 的 ALLOWED_HOSTS 內。正見＝Yooliang/policy-tw 的 README（政見追蹤平台、每筆都附來源網址）。
// 招租的聯絡方式還沒給：AD_CONTACT_URL 是空字串時，招租那則照常輪播顯示，但按鈕不可點、不會開任何網址。
export const AD_CONTACT_URL = ''
export const ADS = [
  { key: 'cloud-agent', badge: 'TIP', title: '邀請你的雲端代理', sub: '把雲端上的 AI 夥伴加成好友', cta: '', url: '', hue: 205 },
  { key: 'privacy', badge: '', title: '隱私說明', sub: 'ASN 收什麼、不收什麼，一頁講清楚', cta: '去看看', url: 'https://asnmessenger.web.app/privacy', hue: 190 },
  { key: 'policy', badge: '', title: '正見', sub: '追蹤政見做到多少，附來源', cta: '看看', url: 'https://policy-tw.web.app', hue: 170 },
  { key: 'rent', badge: '', title: '廣告位招租', sub: '這個位置可以放你的廣告', cta: '洽詢', url: AD_CONTACT_URL, hue: 48 },
]
// 線上抓到的清單（Rust 端 ads_fetch 已驗證過）：是非空陣列才採用，否則用打包備用。內容一律當純文字顯示
export const pickAds = (remote, fallback = ADS) => (Array.isArray(remote) && remote.length > 0 ? remote : fallback)
// 大幅廣告可以用官網上的網頁（iframe）：只認官網 /ads/ 底下的 https 網址（Rust 端已驗證，這裡再擋一次）；5 秒內沒載入完就退回樣板
export const AD_PAGE_PREFIX = 'https://asnmessenger.web.app/ads/'
export const AD_PAGE_MS = 5000
export const adPageUrl = a => (typeof a?.page === 'string' && a.page.startsWith(AD_PAGE_PREFIX) && a.page.length <= 200 && !/[\s"'<>\\]/.test(a.page) ? a.page : '')
// 小輪播的圖：只認 Rust 端轉好的 png／webp data URI（CSP 的 img-src 不必放寬）；沒有或格式不對＝空字串，退回樣板
export const adImageSrc = a => (typeof a?.smallImage === 'string' && /^data:image\/(png|webp);base64,[A-Za-z0-9+/=]+$/.test(a.smallImage) ? a.smallImage : '')
export const AD_MS = 6000
export const nextAd = (i, n = ADS.length) => (n > 0 ? (i + 1) % n : 0)
export const prevAd = (i, n = ADS.length) => (n > 0 ? (i - 1 + n) % n : 0)
// 大幅廣告的小圓點：直接跳到第 i 則（超出範圍就夾回合法值）
export const goAd = (i, n = ADS.length) => (n > 0 && Number.isInteger(i) ? Math.min(Math.max(i, 0), n - 1) : 0)
// 有網址才可點；招租在聯絡網址還沒給時＝不可點
export const adClickable = ad => typeof ad?.url === 'string' && ad.url !== ''
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
const ENGINE_LABEL = { claude: 'Claude', gemini: 'Gemini', grok: 'Grok', codex: 'Codex', deepseek: 'DeepSeek', gpt: 'GPT', acp: 'ACP', asn: 'ASN', pi: 'Pi' }
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

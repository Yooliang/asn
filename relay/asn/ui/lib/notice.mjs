// 系統通知的共用判斷（#848，電腦與手機共用；Rust 橋與 Node 橋有各自一份同規則的實作，改動要一起改）。
// 純函式，node 與瀏覽器都能跑。

export const NOTICE_SENDER = 'ASN 通知'          // 後台與橋寄系統通知的固定寄件人
export const NOTICE_LABEL = '通知'               // 名單與對話標題上顯示的名字
export const NOTICE_KIND_PREFIX = 'notice:'      // 信件類別 kind 的前綴
export const LEGACY_NOTICE_SUFFIX = '收發室'      // 舊版寄件名結尾（「○○收發室」「<節點>-收發室」）

// 舊寄件名的相容截止時間（毫秒，或可被 Date.parse 的 ISO 字串）。
// 之後會設成 PR-C（後台改用新寄件人與 kind）上線的日期：created_at 在這個時間以後、又沒有 notice 類別的信，
// 就算寄件名叫「ASN 通知」或結尾是「收發室」也不當系統通知（這兩種寄件名是保留給系統通知的）。
// null＝還沒決定日期，舊寄件名規則對所有信都有效（和目前行為一致）。
export const LEGACY_NOTICE_UNTIL = null

const cutoffMs = until => {
  if (until == null) return null
  const n = typeof until === 'number' ? until : Date.parse(until)
  return Number.isFinite(n) ? n : null
}

// 舊規則（寄件名／內文標記）對這封信是否仍有效：沒設截止＝一律有效；設了就要有 created_at 且早於截止
export function legacyApplies(mail, until = LEGACY_NOTICE_UNTIL) {
  const cut = cutoffMs(until)
  if (cut == null) return true
  const t = Date.parse(mail?.created_at)
  return Number.isFinite(t) && t < cut
}

export const isNoticeKind = kind => typeof kind === 'string' && kind.startsWith(NOTICE_KIND_PREFIX)
// 寄件名保留字檢查用的正規化（和後台、Rust 端同一套；共用案例在 supabase/functions/_shared/reserved_sender_cases.json）：
// NFKD → 去掉控制／格式／空白／組合記號／標點／符號 → 轉小寫 → 長得像的外國字母與日文、簡體字形對照 → NFKC
const IGNORED = /[\p{Cc}\p{Cf}\p{Zs}\p{Zl}\p{Zp}\p{M}\p{P}\p{S}\s]/gu
const FOLD_MAP = { 'а': 'a', 'ɑ': 'a', 'α': 'a', 'ᴀ': 'a', 'ѕ': 's', 'ꜱ': 's', 'ν': 'n', 'ո': 'n', 'ɴ': 'n', 'ᴎ': 'n', '发': '發', '発': '發', '収': '收' }
export const foldName = name => Array.from(String(name ?? '').normalize('NFKD').replace(IGNORED, '').toLowerCase(), c => FOLD_MAP[c] ?? c).join('').normalize('NFKC')
// 是不是保留給系統通知的寄件名：正規化後等於「asn通知」或結尾是「收發室」
export const isLegacyNoticeName = name => {
  const s = foldName(name)
  return s === foldName(NOTICE_SENDER) || s.endsWith(LEGACY_NOTICE_SUFFIX)
}

// 寄件節點是不是同一個帳號的：呼叫端明說就用呼叫端的；否則看後台在信件上帶的 from_owner（布林）；
// 兩個都沒有（舊後台）＝不知道，當作是，照舊規則
export const sameAccountOf = (mail, explicit) => (typeof explicit === 'boolean' ? explicit : typeof mail?.from_owner === 'boolean' ? mail.from_owner : true)

// 這封是不是系統通知（不回信、不建聯絡人、併進「通知」對話）。
// 一律先看 kind；沒有 kind 時才退回舊規則（寄件名），而且舊規則只對截止時間以前的信有效。
// sameAccount：寄件節點是不是同一個帳號的節點（呼叫端明說的優先，其次看信上的 from_owner）；false 的舊寄件名信是一般信。都沒有＝不知道，照舊規則
export function isSystemNotice(mail, { until = LEGACY_NOTICE_UNTIL, sameAccount } = {}) {
  if (!mail || typeof mail !== 'object') return false
  if (isNoticeKind(mail.kind)) return true
  if (sameAccountOf(mail, sameAccount) === false || !legacyApplies(mail, until)) return false
  return isLegacyNoticeName(mail.from_agent)
}

// 「通知」對話的固定代號。用戶端沒有帳號代號可用，整個帳號一個，本機存檔也只屬於這個帳號：固定寫 me
export const noticeId = (account = 'me') => `${NOTICE_KIND_PREFIX}${String(account || 'me').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32) || 'me'}`
export const NOTICE_ID = noticeId()

export const isNoticeFriend = f => Boolean(f) && f.isNotice === true
// 已併進「通知」而隱藏的舊對話列（原始資料還留著）
export const isMergedAway = f => Boolean(f) && typeof f.mergedInto === 'string' && f.mergedInto !== ''
// 舊版自動長出來的「○○收發室」「ASN 通知」聯絡人列
export const isLegacyNoticeFriend = f => Boolean(f) && !isNoticeFriend(f) && isLegacyNoticeName(f.agent)

export const noticeFriend = (extra = {}) => ({
  id: NOTICE_ID, node: 'notice', agent: '', nick: NOTICE_LABEL, psm: '', engine: null, onRoster: false,
  status: 'none', isNotice: true, known: true, ...extra,
})

// 名單最上面固定的「通知」組：沒有這個對話（從沒收過通知）或有搜尋字時不顯示
export function withNoticeGroup(groups, friends, { query = '' } = {}) {
  const f = (Array.isArray(friends) ? friends : []).find(isNoticeFriend)
  if (!f || String(query ?? '').trim()) return groups
  return [{ key: '__notice', kind: 'notice', label: NOTICE_LABEL, items: [f] }, ...groups]
}

/** 「通知」對話裡這則通知是哪一台設備寄的（氣泡上方顯示「通知 · <設備名>」）；其他對話、自己寄的、沒有設備名＝空字串 */
export const noticeDevOf = (m, isNotice) => (isNotice === true && m && m.k === 'them' && typeof m.dev === 'string' ? m.dev : '')

// ---------- 電腦版左側「通知」頁籤（方案 A：通知不再出現在名單與對話分頁） ----------
// 整合模式右邊顯示通知內容用的固定分頁 id（@ 開頭跟指引、設定的面板分頁同一個命名空間，但不在 PANEL_KINDS 裡、不存檔）
export const NOTICE_TAB = '@notice'
// 分頁清單裡拿掉「通知」對話與通知內容分頁（還原上次的分頁、存檔時用）
// 名單分組裡拿掉「通知」對話（電腦版名單不再放通知）；只有「拿掉通知後才變空」的組不列，本來就空的組（例如只放終端的本機組）照留
export const withoutNoticeItems = groups => (Array.isArray(groups) ? groups : []).flatMap(g => {
  const items = Array.isArray(g?.items) ? g.items : []
  if (!items.some(isNoticeFriend)) return [g]
  const rest = items.filter(f => !isNoticeFriend(f))
  return rest.length ? [{ ...g, items: rest }] : []
})
export const withoutNoticeTabs = ids => (Array.isArray(ids) ? ids : []).filter(id => id !== NOTICE_ID && id !== NOTICE_TAB)

// 通知分類：一律看信件的 kind（notice:<主題>），不看標題文字；沒有 kind 的舊通知、認不得的主題都歸「其他」
export const NOTICE_CAT_ALL = 'all'
export const NOTICE_CATS = [
  { key: NOTICE_CAT_ALL, label: '全部' },
  { key: 'stuck', label: '卡住' },
  { key: 'login', label: '登入' },
  { key: 'quota', label: '額度' },
  { key: 'security', label: '安全' },
  { key: 'other', label: '其他' },
]
export const NOTICE_CAT_LABEL = Object.fromEntries(NOTICE_CATS.map(c => [c.key, c.label]))
const TOPIC_CAT = {
  inbox_watch: 'stuck', waiting: 'stuck', mux_down: 'stuck', mux_blind: 'stuck', misroute: 'stuck',
  login: 'login',
  quota: 'quota',
  view: 'security', term_view: 'security', device_key: 'security', node_mismatch: 'security',
}
export function noticeCategory(kind) {
  if (!isNoticeKind(kind)) return 'other'
  const topic = kind.slice(NOTICE_KIND_PREFIX.length)
  return Object.prototype.hasOwnProperty.call(TOPIC_CAT, topic) ? TOPIC_CAT[topic] : 'other'
}

// 一則通知的標題與摘要：內文第一個非空行是標題，第二個非空行是摘要
export function noticeLines(text) {
  const lines = String(text ?? '').split(/\r?\n/).map(s => s.trim()).filter(Boolean)
  return { title: lines[0] ?? '', summary: lines[1] ?? '' }
}
// 內文去掉標題那一行之後的部分（通知內容頁的標題已經單獨顯示，下面不再重複）；中間的換行照原樣保留
export const noticeRest = text => String(text ?? '').replace(/^\s*[^\r\n]*(\r?\n|$)/, '').trim()

const rowKey = (m, i) => (typeof m.id === 'string' && m.id ? m.id : `t${m.t}-${i}`)
// 通知清單（新的在前）：只取收到的通知（k＝them）。unread＝通知對話的未讀數（最新的 N 則算未讀），
// opened＝這次開著期間已點開過的 key（點開一則只消那一則；全部點完才整個標已讀）
// hideDev＝不顯示的設備名（例如「未命名設備」：看了也不知道是哪台，乾脆不寫）
export function noticeRows(log, { unread = 0, opened = [], hideDev = [] } = {}) {
  const seen = new Set(Array.isArray(opened) ? opened : [])
  const devOf = m => (typeof m.dev === 'string' && !hideDev.includes(m.dev) ? m.dev : '')
  const items = (Array.isArray(log) ? log : []).map((m, i) => [m, i]).filter(([m]) => m && m.k === 'them')
  const n = Math.max(0, Number(unread) || 0)
  return items.reverse().map(([m, i], pos) => {
    const key = rowKey(m, i)
    const { title, summary } = noticeLines(m.text)
    return {
      key, title, summary, text: String(m.text ?? ''), rest: noticeRest(m.text), t: Number(m.t) || 0, dev: devOf(m),
      cat: noticeCategory(m.kind), unread: pos < n && !seen.has(key),
    }
  })
}
export const filterNoticeRows = (rows, cat = NOTICE_CAT_ALL) => (cat === NOTICE_CAT_ALL || !NOTICE_CAT_LABEL[cat] ? rows : rows.filter(r => r.cat === cat))
export const noticeUnreadCount = rows => rows.reduce((n, r) => n + (r.unread ? 1 : 0), 0)
// 各分類的小圖示（24×24 的線條路徑，畫面上用 stroke 畫）
export const NOTICE_CAT_ICON = {
  stuck: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 7.5v5M12 16v.5',
  login: 'M10 4h8v16h-8M4 12h10M11 8.5l3.5 3.5-3.5 3.5',
  quota: 'M4 18a8 8 0 1 1 16 0M12 18l4-6M8 18h0M16 18h0',
  security: 'M12 3l7 3v5c0 4.6-3 8.2-7 10-4-1.8-7-5.4-7-10V6zM9 12l2 2 4-4',
  other: 'M12 4a5 5 0 0 0-5 5v4l-2 3h14l-2-3V9a5 5 0 0 0-5-5zM10 19a2 2 0 0 0 4 0',
}
// 清單上的時間：今天只寫時:分，其他天寫 月/日 時:分（本機時區）
export function noticeTime(t, now = Date.now()) {
  const d = new Date(Number(t) || 0), n = new Date(now)
  if (!Number(t)) return ''
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  return d.toDateString() === n.toDateString() ? hm : `${d.getMonth() + 1}/${d.getDate()} ${hm}`
}

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
// 寄件名保留字檢查用的正規化（和後台、Rust 端同一套）：NFKC → 去掉控制／格式／空白字元 → 轉小寫 → 简體「发」換成「發」
export const foldName = name => String(name ?? '').normalize('NFKC').replace(/[\p{Cc}\p{Cf}\p{Zs}\p{Zl}\p{Zp}\s]/gu, '').toLowerCase().replace(/发/g, '發')
// 是不是保留給系統通知的寄件名：正規化後等於「asn通知」或結尾是「收發室」
export const isLegacyNoticeName = name => {
  const s = foldName(name)
  return s === foldName(NOTICE_SENDER) || s.endsWith(LEGACY_NOTICE_SUFFIX)
}

// 這封是不是系統通知（不回信、不建聯絡人、併進「通知」對話）。
// 一律先看 kind；沒有 kind 時才退回舊規則（寄件名），而且舊規則只對截止時間以前的信有效。
// sameAccount：寄件節點是不是同一個帳號的節點（呼叫端用名單的節點判斷）；false 的舊寄件名信是一般信。沒給＝不知道，照舊規則
export function isSystemNotice(mail, { until = LEGACY_NOTICE_UNTIL, sameAccount = true } = {}) {
  if (!mail || typeof mail !== 'object') return false
  if (isNoticeKind(mail.kind)) return true
  if (sameAccount === false || !legacyApplies(mail, until)) return false
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

// 名單搜尋：有關鍵字時跨所有分頁（設備／廠商／狀態）比對；沒有關鍵字時只顯示目前分頁。
import { groupItems, pageItems } from './dims.mjs'
import { withoutAsn } from './roster.mjs'
import { isPinned } from './chat-pins.mjs'

export function normalizeSearchQuery(raw) {
  return String(raw ?? '').trim().toLowerCase()
}

/** @param {(s: string) => string} plainText 與介面相同的 plain（去掉表情代碼） */
export function friendMatchesQuery(friend, q, plainText) {
  if (!q) return true
  return plainText(friend?.nick ?? '').toLowerCase().includes(q)
}

const statusRank = s => (s === 'offline' ? 1 : 0)

/**
 * 同一設備內的夥伴順序（#1729）：釘選的全部在最上面，其餘照最新一則訊息的時間（名單那欄時間）由新到舊，
 * 釘選之間也照時間；時間一樣或都沒有才照名字。pins＝釘選狀態（chat-pins 的 state）。
 * 以前是「線上在前、離線在後、同級照名字」，沒有看釘選，也沒有看時間，所以釘選的夾在中間、日期亂排。
 */
export function pinnedRecentOrder(pins) {
  const at = f => (Number.isFinite(f?.lastAt) ? f.lastAt : 0)
  return (a, b) => (isPinned(pins, b.id) - isPinned(pins, a.id)) || (at(b) - at(a)) || String(a.nick ?? '').localeCompare(String(b.nick ?? ''), 'zh-Hant')
}

export function sortFriends(items, cmp = null) {
  return [...items].sort(cmp ?? ((a, b) => statusRank(a.status) - statusRank(b.status) || a.nick.localeCompare(b.nick, 'zh-Hant')))
}

/** 有搜尋字：全部好友中篩選；無搜尋字：只取目前分頁 */
export function rosterListItems(friends, { tabDim, tabKey, query, plainText, pins }) {
  const q = normalizeSearchQuery(query)
  const match = f => friendMatchesQuery(f, q, plainText)
  const cmp = pins ? pinnedRecentOrder(pins) : null
  if (q) return sortFriends(withoutAsn(friends).filter(match), cmp)
  return pageItems(friends, tabDim, tabKey, match, cmp)
}

export function rosterShownGroups(friends, { tabDim, tabKey, groupDim, selfNode, selfName, nodeNames, deviceOrder, query, plainText, pins }) {
  const items = rosterListItems(friends, { tabDim, tabKey, query, plainText, pins })
  return groupItems(items, groupDim, { selfNode, selfName, nodeNames, deviceOrder, cmp: pins ? pinnedRecentOrder(pins) : null })
}

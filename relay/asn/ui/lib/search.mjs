// 名單搜尋：有關鍵字時跨所有分頁（設備／廠商／狀態）比對；沒有關鍵字時只顯示目前分頁。
import { groupItems, pageItems } from './dims.mjs'
import { withoutAsn } from './roster.mjs'

export function normalizeSearchQuery(raw) {
  return String(raw ?? '').trim().toLowerCase()
}

/** @param {(s: string) => string} plainText 與介面相同的 plain（去掉表情代碼） */
export function friendMatchesQuery(friend, q, plainText) {
  if (!q) return true
  return plainText(friend?.nick ?? '').toLowerCase().includes(q)
}

const statusRank = s => (s === 'offline' ? 1 : 0)

export function sortFriends(items) {
  return [...items].sort((a, b) => statusRank(a.status) - statusRank(b.status) || a.nick.localeCompare(b.nick, 'zh-Hant'))
}

/** 有搜尋字：全部好友中篩選；無搜尋字：只取目前分頁 */
export function rosterListItems(friends, { tabDim, tabKey, query, plainText }) {
  const q = normalizeSearchQuery(query)
  const match = f => friendMatchesQuery(f, q, plainText)
  if (q) return sortFriends(withoutAsn(friends).filter(match))
  return pageItems(friends, tabDim, tabKey, match)
}

export function rosterShownGroups(friends, { tabDim, tabKey, groupDim, selfNode, selfName, query, plainText }) {
  const items = rosterListItems(friends, { tabDim, tabKey, query, plainText })
  return groupItems(items, groupDim, { selfNode, selfName })
}

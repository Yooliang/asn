// 封存夥伴（讓那一位從名單消失）的純邏輯，電腦版名單右鍵與手機「⋯」選單、名單底部的「已封存」群組共用。
// 封存記在帳號層（後台 relay.partner_archives，同租戶所有設備同步）：後台名單每位成員帶 archived 旗標（lib/roster.mjs 轉成 friend.archived），
// 這裡決定怎麼顯示：名單裡不顯示已封存的；最底下一個預設收合的「已封存（N）」群組，展開後可「取消封存」。
// 往來記錄、未讀、通知都不動；封存的夥伴再寄信來，或封存時離線、之後重新上線，後台會自動解除。
// node 與瀏覽器都能跑，不碰 DOM、不碰 Tauri。給人看的文字純繁體中文，不顯示節點代號與夥伴 ID。
import { withoutAsn } from './roster.mjs'
import { isAiPartner, loginBlock, menuItems, opErrorText } from './partner-ops.mjs'

export const ARCHIVE_GROUP_KEY = '__archived'
export const isArchived = f => f?.archived === true
export const archiveHeading = n => `已封存（${Number.isInteger(n) && n > 0 ? n : 0}）`
export const ARCHIVE_LABEL = { archive: '封存', unarchive: '取消封存' }

// 名單上要顯示的 / 已封存的（保持原順序）
export const activeFriends = friends => withoutAsn(friends).filter(f => !isArchived(f))   // ASN 視窗一律不列
export const archivedFriends = friends => withoutAsn(friends).filter(isArchived)

// 名單底部的「已封存」群組：沒有已封存的就回 null（不顯示）。items 是已封存的好友（呼叫端已套好搜尋／分頁），
// 組內離線在後、同級照名字。群組的 kind＝'archived'，介面用 ARCHIVE_GROUP_KEY 記收合狀態（預設收合）
export function archivedGroup(items) {
  const list = archivedFriends(items)
  if (!list.length) return null
  const rank = s => (s === 'offline' ? 1 : 0)
  list.sort((a, b) => rank(a.status) - rank(b.status) || String(a.nick).localeCompare(String(b.nick), 'zh-Hant'))
  return { key: ARCHIVE_GROUP_KEY, kind: 'archived', label: '已封存', node: '', items: list }
}
// 把已封存的群組接在 groups 最後面（沒有就原樣回傳）
export const withArchivedGroup = (groups, items) => {
  const g = archivedGroup(items)
  return g ? [...groups, g] : groups
}
// 收合狀態：已封存群組預設收合（collapsed 是 { [key]: boolean }，沒記過＝預設）；其他群組預設展開
export const isGroupCollapsed = (collapsed, key) => (key in (collapsed ?? {}) ? Boolean(collapsed[key]) : key === ARCHIVE_GROUP_KEY)

// 選單項目（接在 lib/partner-ops.mjs 的 menuItems 後面）：已封存的顯示「取消封存」，其餘顯示「封存」。
// 不需要那台電腦在線，也不需要開放遠端管理；只要登入（要本人簽章）與後台支援。ctx：{ signedIn, supported }
export function archiveMenuItem(friend, ctx = {}) {
  const key = isArchived(friend) ? 'unarchive' : 'archive'
  let reason = ''
  if (ctx.signedIn === false) reason = '要先登入，才能封存夥伴'
  else if (loginBlock(ctx)) reason = loginBlock(ctx)
  else if (ctx.supported === false) reason = '電腦端或收發室還不支援，請先更新'
  return { key, label: ARCHIVE_LABEL[key], ok: !reason, reason }
}

// 完整選單（電腦版右鍵與手機「⋯」共用）：AI 夥伴＝依引擎決定的管理項目（menuItems）＋最後一項「封存／取消封存」。
// 雲端代理（Grok 等）與其他不支援遠端管理的引擎沒有管理項目，只剩封存；離線的夥伴就算不能喚醒，也能封存。
// 不是 AI 夥伴（人、手機、收發室、ASN 自己的視窗）回空陣列
export function manageItems(friend, ctx = {}) {
  if (!isAiPartner(friend, ctx)) return []
  return [...menuItems(friend, ctx), archiveMenuItem(friend, ctx)]
}

// 送給 Rust 的內容：節點與名字來自名單；有夥伴 ID 就帶（內部用，畫面不顯示）
export function buildArchiveRequest(friend, archived) {
  const req = { node: friend.node, name: friend.agent, archived: archived === true }
  if (friend.partnerId) req.partner_id = friend.partnerId
  return req
}

const DONE_TEXT = { true: '已封存，這位夥伴不會再出現在名單上；它再寄信來或重新上線就會自動回來。', false: '已取消封存。' }
// 送出一次封存／取消封存。回 { ok, text }；api 要有 partnerArchive（lib/tauri.mjs 的 transport）。後台舊版（404）會說要先更新
export async function runArchive(api, friend, archived) {
  if (typeof api?.partnerArchive !== 'function') return { ok: false, text: '這個版本還不能封存，請先更新' }
  try {
    const r = await api.partnerArchive(buildArchiveRequest(friend, archived))
    if (r && r.ok === false) return { ok: false, text: '封存失敗，請稍後再試' }
    return { ok: true, text: DONE_TEXT[archived === true] }
  } catch (e) {
    return { ok: false, text: opErrorText(e?.message) }
  }
}

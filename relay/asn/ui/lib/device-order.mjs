// 設備頁籤的手動排序與自動隱藏（純邏輯，node 與瀏覽器都能跑；電腦版左邊頁籤、設定的設備頁籤、手機共用）。
// 順序存在本機設定（asn-me.json 的 deviceOrder：節點鍵陣列）；手動顯示過的隱藏設備存在 deviceShown。
// 舊存檔沒有這兩個欄位＝空陣列＝維持自動規則（本機第一、有人在線在前）。
import { isAsnWindow, isDeviceLiveStatus } from './roster.mjs'
import { isMergedAway, isNoticeFriend } from './notice.mjs'

const MAX_KEYS = 200
// 不是設備的鍵（#1830）：「通知」對話的節點。舊存檔／後台的順序裡若有，讀與存都忽略
export const NON_DEVICE_KEYS = Object.freeze(['notice'])
// 設備列與設備順序的好友來源只有這一個：通知對話、已併進通知的舊列不是設備（#1830）。手機與電腦的設備頁、開新夥伴的設備清單都先過它
export const deviceFriends = friends => (Array.isArray(friends) ? friends : []).filter(f => f && !isNoticeFriend(f) && !isMergedAway(f))
export const normalizeKeys = v => {
  if (!Array.isArray(v)) return []
  const out = []
  for (const k of v) if (typeof k === 'string' && k && !NON_DEVICE_KEYS.includes(k) && !out.includes(k)) out.push(k)
  return out.slice(0, MAX_KEYS)
}
// deviceRemoved＝永久移除的設備（不再出現在任何設備列表；不刪後台資料與對話）。舊存檔沒有＝空陣列
// deviceRev／deviceSynced＝帳號層同步用（lib/device-sync.mjs）：deviceRev＝這份設定最後一次改動的毫秒時間戳，deviceSynced＝這台跟後台同步過。舊存檔沒有＝0／false
const revOf = v => (Number.isSafeInteger(v) && v > 0 ? v : 0)
export const deviceFieldsFromSaved = saved => ({ deviceOrder: normalizeKeys(saved?.deviceOrder), deviceShown: normalizeKeys(saved?.deviceShown), deviceRemoved: normalizeKeys(saved?.deviceRemoved), deviceRev: revOf(saved?.deviceRev), deviceSynced: saved?.deviceSynced === true })
export const deviceFieldsToSave = ({ deviceOrder, deviceShown, deviceRemoved, deviceRev, deviceSynced } = {}) => ({ deviceOrder: normalizeKeys(deviceOrder), deviceShown: normalizeKeys(deviceShown), deviceRemoved: normalizeKeys(deviceRemoved), deviceRev: revOf(deviceRev), deviceSynced: deviceSynced === true })

// rows：已按自動規則排好的列（每列有 key）。本機固定第一；手動排過的接著、照手動順序；其餘（新設備、沒排過）照原自動順序接在後面
export function applyDeviceOrder(rows, { selfNode, deviceOrder = [] } = {}) {
  const list = Array.isArray(rows) ? rows : []
  const self = list.filter(r => r.key === selfNode)
  const rest = list.filter(r => r.key !== selfNode)
  const rank = new Map(normalizeKeys(deviceOrder).map((k, i) => [k, i]))
  const manual = rest.filter(r => rank.has(r.key)).sort((a, b) => rank.get(a.key) - rank.get(b.key))
  return [...self, ...manual, ...rest.filter(r => !rank.has(r.key))]
}

// 上移（-1）／下移（+1）：keys 是目前完整順序；visible 給了就跳過看不到的設備（隱藏的相對位置不動）。回傳新的完整順序（不含本機）
export function moveDevice(keys, key, dir, { selfNode, visible } = {}) {
  const full = normalizeKeys(keys).filter(k => k !== selfNode)
  const at = full.indexOf(key)
  if (at < 0 || key === selfNode) return full
  const seen = Array.isArray(visible) ? new Set(visible) : null
  let to = at + dir
  while (to >= 0 && to < full.length && seen && !seen.has(full[to])) to += dir
  if (to < 0 || to >= full.length) return full
  const out = full.slice()
  ;[out[at], out[to]] = [out[to], out[at]]
  return out
}

// 拖放：把 dragKey 放到 targetKey 的前面（after＝false）或後面；放到本機上＝排到非本機的第一位；拖本機或拖到自己不變
export function reorderDevice(keys, dragKey, targetKey, after, { selfNode } = {}) {
  const full = normalizeKeys(keys).filter(k => k !== selfNode)
  if (dragKey === selfNode || dragKey === targetKey || !full.includes(dragKey)) return full
  const rest = full.filter(k => k !== dragKey)
  if (targetKey === selfNode || !rest.includes(targetKey)) return [dragKey, ...rest]
  const i = rest.indexOf(targetKey) + (after ? 1 : 0)
  return [...rest.slice(0, i), dragKey, ...rest.slice(i)]
}

export const showDevice = (shown, key) => (normalizeKeys(shown).includes(key) ? normalizeKeys(shown) : [...normalizeKeys(shown), key])

// 設備在不在線（設定「設備」頁籤的在線／離線標示，開新夥伴的設備列也用這份）：
// 本機永遠在線；其餘看有沒有在線的 ASN 視窗（asn），或名單上有沒有任何非離線的視窗
export function isDeviceOnline(node, friends, { selfNode = '', asn = {} } = {}) {
  if (node === selfNode) return true
  if (Array.isArray(asn?.[node]) && asn[node].length > 0) return true
  return (Array.isArray(friends) ? friends : []).some(f => f.node === node && isDeviceLiveStatus(f.status))
}

// 自動隱藏：非本機、沒有任何在線視窗（ASN 視窗也算）、沒有任何未封存的夥伴（ASN 視窗不是夥伴）、沒有未讀。只要一項不成立就不隱藏；手動顯示過的也不隱藏
export function isDeviceHidden(node, friends, { selfNode, shown = [] } = {}) {
  if (!node || node === selfNode || normalizeKeys(shown).includes(node)) return false
  for (const f of Array.isArray(friends) ? friends : []) {
    if ((f.node ?? '') !== node) continue
    if (isDeviceLiveStatus(f.status)) return false
    if ((f.unread || 0) > 0) return false
    if (!isAsnWindow(f) && f.archived !== true) return false
  }
  return true
}
export const hiddenDeviceNodes = (friends, nodes, opt) => (nodes ?? []).filter(n => isDeviceHidden(n, friends, opt))

// ---------- 永久移除 ----------
// 本機不能移除。移除只是不再顯示（存在本機設定），不碰任何後台資料與對話。
export const removeDevice = (removed, key, { selfNode } = {}) => {
  const cur = normalizeKeys(removed)
  return !key || key === selfNode || cur.includes(key) ? cur : [...cur, key]
}
export const restoreDevice = (removed, key) => normalizeKeys(removed).filter(k => k !== key)
export const isDeviceRemoved = (key, removed, { selfNode } = {}) => Boolean(key) && key !== selfNode && normalizeKeys(removed).includes(key)
// 自動解除：被移除的設備之後又有在線的視窗（ASN 視窗也算）＝它活過來了，從名單拿掉。
// 移除時它一定是離線；有未讀不算活過來（使用者明確移除了它，舊的未讀不能讓它又冒出來）。
export function pruneRemoved(removed, friends, { selfNode } = {}) {
  const alive = new Set()
  for (const f of Array.isArray(friends) ? friends : []) if (f && isDeviceLiveStatus(f.status)) alive.add(f.node ?? '')
  return normalizeKeys(removed).filter(k => k !== selfNode && !alive.has(k))
}
// 設備列（buildDeviceTree 的結果）：別台、離線的設備都能永久移除（不必等它被自動隱藏；還有未讀或夥伴的也一樣）
export const canRemoveRow = d => Boolean(d && !d.self && !d.online && !d.removed)
// 「顯示回名單」：只看「已隱藏」（和能不能移除無關；電腦、手機同一個條件，#1829）
export const canShowBackRow = d => Boolean(d && d.hidden && !d.removed)
// 設備的顯示順序只有這一個函式（#2111 ⑥）：這台第一，其餘維持設備樹給的順序（＝手動排序後的「設備」頁順序）。
// 「設備」頁的列、帳號卡下的設備列都先過它，各張帳號卡的順序就一定一致，不看誰在用
export const inDevicePageOrder = rows => {
  const list = Array.isArray(rows) ? rows : []
  return [...list.filter(d => d?.self === true), ...list.filter(d => d?.self !== true)]
}
export const visibleRows = rows => inDevicePageOrder(rows).filter(d => !d.removed)
export const removedRows = rows => (Array.isArray(rows) ? rows : []).filter(d => d.removed)

// ---------- 列表：排序把手／拖放（電腦版與手機共用；順序只用拖曳或鍵盤上下鍵，沒有上移／下移鈕，#1860）----------
// 游標在列的下半部＝插在它後面
export const dropAfter = (y, top, height) => y > top + height / 2
// 手機把手拖曳：rows＝每列的 { key, top, height }（畫面由上到下），y＝游標高度；落在列外就用最近的一端
export function dropSlot(rows, y) {
  const list = Array.isArray(rows) ? rows : []
  if (!list.length) return { target: '', after: false }
  const hit = list.find(r => y >= r.top && y <= r.top + r.height)
  if (hit) return { target: hit.key, after: dropAfter(y, hit.top, hit.height) }
  return y < list[0].top ? { target: list[0].key, after: false } : { target: list.at(-1).key, after: true }
}

// ---------- 畫面文字 ----------
// 設備詳情下方的「動作區」（#1829；電腦、手機共用）
export const ACTION_TEXT = {
  title: '要處理這台設備',
  rename: '改名',
  removeOnline: '設備在線時不能移除，離線後才能移除',
}
export const DEVICE_TEXT = {
  back: '返回',        // 讀屏與鍵盤用的名字（aria-label）
  backMark: '‹',        // 畫面上只放這個符號，和手機一樣
  showBack: '顯示回名單',
  remove: '永久移除',
  removeYes: '確定移除',
  cancel: '取消',
  hiddenTag: '已隱藏',
  restore: '恢復',
  empty: '還沒有設備。',
  detail: '詳情',
  thisDevice: '這台',
  forget: '忘記',
  gripLabel: name => `拖曳調整「${name}」的順序，或按鍵盤的上下鍵`,
  detailLabel: name => `查看「${name}」的詳情`,
  removedTitle: n => `已移除的設備（${n}）`,
  firstConnected: t => `第一次連線 ${t}`,
  confirmRemove: name => `確定永久移除「${name || '這台設備'}」嗎？它的對話與帳號資料不會被刪除，只是不再顯示。`,
}

// 設備列第二行（電腦、手機同一個函式，#1860）：「電腦 · 在線」「手機 · 離線中」，本機再接「這台」／「這支手機」。離線一律寫「離線中」
export const deviceRowLine = (d, selfText = '') => [d?.kindLabel || d?.kind || '電腦', d?.online ? '在線' : '離線中', ...(d?.self && selfText ? [selfText] : [])].join(' · ')

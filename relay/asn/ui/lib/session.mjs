// 記住開著的分頁與對話視窗，重啟後回到原狀態。純邏輯（序列化、還原、對應不存在的對象），電腦版與手機版共用，
// 不碰 DOM、不碰 Tauri。存在 asn-me.json 的 session 欄位（跟其他偏好同一份存檔）。
// 對象用夥伴 ID（partnerId）對應：夥伴改名後「節點/視窗名」變了，但夥伴 ID 不變，所以改名也找得回來；
// 找不到（已刪除、已封存、後台沒這位）就略過，不產生空白分頁。
import { isPanelTab, panelItem, panelKindOf, PANEL_KINDS } from './panels.mjs'
import { normalizePinned, orderTabs } from './ctabs.mjs'

export const SESSION_VERSION = 1
const MAX_TABS = 60
const MAX_ID = 200
const MOBILE_TABS = ['list', 'chats', 'me']   // 與 mobile.mjs 的 TABS 相同（守門測試比對）

const str = v => (typeof v === 'string' && v.length > 0 && v.length <= MAX_ID ? v : '')
const isPending = id => id.startsWith('pending:')

/** 一個對話分頁／視窗存成 { id, pid }：pid 是夥伴 ID（沒有就省略）；面板分頁（指引、設定）只存 id */
export function refOf(id, friendOf) {
  const f = isPanelTab(id) ? null : friendOf?.(id)
  const pid = str(f?.partnerId)
  return pid ? { id, pid } : { id }
}

function cleanRef(raw) {
  if (typeof raw === 'string') return str(raw) ? { id: raw } : null
  const id = str(raw?.id)
  if (!id) return null
  const pid = str(raw?.pid)
  return pid ? { id, pid } : { id }
}

function cleanRefs(list) {
  const out = [], seen = new Set()
  for (const x of Array.isArray(list) ? list : []) {
    const r = cleanRef(x)
    if (!r || seen.has(r.id)) continue
    seen.add(r.id); out.push(r)
    if (out.length >= MAX_TABS) break
  }
  return out
}

/**
 * 把目前狀態整理成可存檔的樣子。
 *   tabs／active：整合模式的對話分頁與目前分頁（含 @guide、@setting 面板分頁）
 *   panel：指引、設定現在顯示哪一篇／哪一類
 *   windows：分開模式開著的對話視窗（好友 id 清單）；panelWindows：分開模式開著的指引、設定視窗（種類清單）
 */
export function snapshotSession({ tabs = [], active = '', panel = {}, windows = [], panelWindows = [] } = {}, friendOf) {
  const ref = id => refOf(id, friendOf)
  return {
    v: SESSION_VERSION,
    tabs: [...new Set(tabs)].filter(id => str(id) && !isPending(id)).slice(0, MAX_TABS).map(ref),
    active: str(active) && !isPending(active) ? ref(active) : null,
    panel: { guide: str(panel.guide), setting: str(panel.setting) },
    windows: [...new Set(windows)].filter(id => str(id) && !isPending(id) && !isPanelTab(id)).slice(0, MAX_TABS).map(ref),
    panelWindows: [...new Set(panelWindows)].filter(k => PANEL_KINDS.includes(k)),
  }
}

/** 從存檔讀回：壞值一律當沒有（舊存檔沒有這個欄位＝空狀態） */
export function normalizeSession(raw) {
  const s = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const p = s.panel && typeof s.panel === 'object' ? s.panel : {}
  return {
    v: SESSION_VERSION,
    tabs: cleanRefs(s.tabs),
    active: cleanRef(s.active),
    panel: { guide: str(p.guide), setting: str(p.setting) },
    windows: cleanRefs(s.windows),
    panelWindows: [...new Set(Array.isArray(s.panelWindows) ? s.panelWindows : [])].filter(k => PANEL_KINDS.includes(k)),
  }
}

/**
 * 一個存檔裡的對象，現在對應到哪位夥伴：先用夥伴 ID 找（改名也找得到），再用原本的 id；
 * 找不到、已封存都回 ''。friends 是好友物件的陣列（或 Map）。
 */
export function resolveRef(ref, friends) {
  if (!ref) return ''
  const list = Array.isArray(friends) ? friends : [...(friends?.values?.() ?? [])]
  const ok = f => Boolean(f) && f.archived !== true && !isPending(String(f.id))
  if (ref.pid) {
    const byPid = list.find(f => f.partnerId === ref.pid)
    if (byPid) return ok(byPid) ? byPid.id : ''
  }
  const byId = list.find(f => f.id === ref.id)
  return ok(byId) ? byId.id : ''
}

/**
 * 還原：回傳 { tabs, active, panel, windows, panelWindows, pinned, dropped }。
 *   分頁順序照存檔，再依固定（pinned）排前面；目前分頁不在分頁裡就取最後一個；
 *   面板分頁只留指引／設定內容還認得的；改名的對象（夥伴 ID 相同、id 不同）分頁、固定、目前分頁都換成新 id；
 *   dropped＝找不到而略過的筆數。
 */
export function restoreSession(saved, { friends = [], pinned = [] } = {}) {
  const s = normalizeSession(saved)
  const panel = { ...s.panel }
  const renamed = new Map()
  let dropped = 0
  const resolve = r => {
    if (isPanelTab(r.id)) { const k = panelKindOf(r.id); return panelItem(k, panel[k]) ? r.id : '' }
    const id = resolveRef(r, friends)
    if (id && id !== r.id) renamed.set(r.id, id)
    return id
  }
  const keep = refs => {
    const seen = new Set()
    return refs.map(r => { const id = resolve(r); if (!id) dropped++; return id }).filter(id => id && !seen.has(id) && seen.add(id))
  }
  const tabIds = keep(s.tabs)
  const windows = keep(s.windows)
  const pin = [...new Set(normalizePinned(pinned).map(id => renamed.get(id) ?? id))]
  const tabs = orderTabs(tabIds, pin)
  const wanted = s.active ? resolve(s.active) : ''
  const active = tabs.includes(wanted) ? wanted : (tabs.at(-1) ?? '')
  const panelWindows = s.panelWindows.filter(k => panelItem(k, panel[k]))
  return { tabs, active, panel, windows, panelWindows, pinned: pin, dropped }
}

/** 還原時要對照的對象：1 對 1 夥伴（陣列或 Map）加上群組（假夥伴，id 是 room:<群組代號>） */
export function restoreTargets(friends, rooms = []) {
  const list = Array.isArray(friends) ? friends : [...(friends?.values?.() ?? [])]
  return [...list, ...(Array.isArray(rooms) ? rooms : [])]
}

/** 現在能不能還原：1 對 1 名單與群組列表都載完才行；群組列表讀取失敗（roomsErr）先不還原，等之後重抓成功 */
export const canRestore = ({ rosterLoaded, roomsLoaded, roomsErr } = {}) => rosterLoaded === true && roomsLoaded === true && roomsErr !== true

/**
 * 開機還原的計畫：還不能還原回 null（呼叫端維持存檔不動、不設 ready，免得把群組分頁洗掉）；
 * 可以就回 restoreSession 的結果（對照名單含群組；已退出的群組照規則略過）。
 */
export function planRestore(saved, { friends = [], rooms = [], pinned = [], rosterLoaded, roomsLoaded, roomsErr } = {}) {
  if (!canRestore({ rosterLoaded, roomsLoaded, roomsErr })) return null
  return restoreSession(saved, { friends: restoreTargets(friends, rooms), pinned })
}

/** 兩份整理過的狀態是否一樣（沒變就不必寫檔） */
export const sameSession = (a, b) => JSON.stringify(a) === JSON.stringify(b)

/** 尾端節流：連續呼叫只在安靜 ms 之後執行最後一次；flush 立刻執行還沒執行的 */
export function trailingThrottle(fn, ms, timers = { set: (f, ms) => setTimeout(f, ms), clear: t => clearTimeout(t) }) {
  let t = null
  const run = () => { t = null; fn() }
  const call = () => { if (t !== null) timers.clear(t); t = timers.set(run, ms) }
  call.flush = () => { if (t !== null) { timers.clear(t); run() } }
  call.pending = () => t !== null
  return call
}

/** 手機版重開要回到哪個大分頁（名單／對話／設置）；壞值回名單 */
export const restoreMobileTab = raw => (MOBILE_TABS.includes(raw) ? raw : 'list')

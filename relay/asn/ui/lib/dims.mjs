// 名單的「分頁依」與「分組依」：三個維度（狀態／廠商／設備）的純邏輯，node 與瀏覽器都能跑。
import { UNNAMED_DEVICE } from './text.mjs'
import { isAsnWindow, withoutAsn } from './roster.mjs'
import { DEVICE_TAB_MAX, deviceTabs, engineKey, engineLabel, engineRank, groupInDevice, shortOf } from './tabs.mjs'

export const DIMS = [{ key: 'status', label: '狀態' }, { key: 'engine', label: '廠商' }, { key: 'device', label: '設備' }]
export const DEFAULT_DIMS = { tabDim: 'device', groupDim: 'status' }
const KEYS = DIMS.map(d => d.key)
const STATUS_LIST = [['online', '線上'], ['busy', '忙碌'], ['away', '暫離'], ['offline', '離線']]

// 分組可選的維度：除了分頁用掉的那個，剩下兩個
export const groupOptions = tabDim => DIMS.filter(d => d.key !== tabDim)

// 把任意設定值整理成合法組合：分組跟分頁相同時，自動改成剩下兩個裡的第一個
export function normalizeDims({ tabDim, groupDim } = {}) {
  const t = KEYS.includes(tabDim) ? tabDim : DEFAULT_DIMS.tabDim
  const opts = groupOptions(t).map(d => d.key)
  const g = opts.includes(groupDim) ? groupDim : opts.includes(DEFAULT_DIMS.groupDim) ? DEFAULT_DIMS.groupDim : opts[0]
  return { tabDim: t, groupDim: g }
}
// 讀存檔：新欄位優先；舊存檔只有 groupMode（status／engine）→ 分頁依設備，分組照舊值
export function loadDims(saved) {
  const s = saved ?? {}
  if (s.tabDim || s.groupDim) return normalizeDims(s)
  return normalizeDims({ tabDim: 'device', groupDim: s.groupMode === 'engine' ? 'engine' : 'status' })
}
// 使用者改了分頁依：分組若撞到就自動換
export const withTabDim = (cur, tabDim) => normalizeDims({ ...cur, tabDim })

const online = f => f.status !== 'offline'
const sumTab = (t, friends) => { for (const f of friends) { t.total++; if (online(f)) t.online++; t.unread += f.unread || 0 } return t }

// 頁籤清單 { all, visible, more }；每項 { key, label, short, dot, unread, online, total, empty }
// 設備：本機第一、照名單順序、消失但有紀錄的排最後；廠商：Claude、Gemini、Grok、Codex、DeepSeek、其他字母、「其他」最後；狀態：固定四個。
export function pageTabs(friends, dim, { selfNode, selfName = '', nodeOrder = [], deviceOrder = [], shown = [], max = DEVICE_TAB_MAX } = {}) {
  let all, hidden = []
  const seen = friends   // 設備頁籤要看全部（ASN 視窗讓設備存在，但 deviceTabs 不計它）
  if (dim !== 'device') friends = withoutAsn(friends)
  if (dim === 'status') {
    all = STATUS_LIST.map(([key, label]) => sumTab({ key, label, short: '', dot: key, unread: 0, online: 0, total: 0 }, friends.filter(f => f.status === key)))
  } else if (dim === 'engine') {
    const by = new Map()
    for (const f of friends) { const k = engineKey(f); if (!by.has(k)) by.set(k, []); by.get(k).push(f) }
    all = [...by.keys()].sort((a, b) => engineRank(a) - engineRank(b) || a.localeCompare(b))
      .map(k => sumTab({ key: k, label: engineLabel(k), short: '', vendorKey: k, dot: '', unread: 0, online: 0, total: 0 }, by.get(k)))
  } else {
    const dt = deviceTabs(seen, { selfNode, selfName, nodeOrder, deviceOrder, shown, max })
    all = dt.all.map(t => ({ ...t, dot: '' }))
    hidden = dt.hidden
  }
  all = all.map(t => ({ ...t, empty: t.total === 0 && !(dim === 'device' && t.key === selfNode) }))
  if (all.length <= max) return { all, visible: all, more: [], hidden }
  return { all, visible: all.slice(0, max - 1), more: all.slice(max - 1), hidden }
}

// 某頁籤裡的好友：線上／忙碌在前、離線在後（同級照名字）；match 為搜尋
export function pageItems(friends, dim, key, match = () => true) {
  const of = f => (dim === 'status' ? f.status : dim === 'engine' ? engineKey(f) : (f.node ?? ''))
  const rank = s => (s === 'offline' ? 1 : 0)
  return friends.filter(f => !isAsnWindow(f) && of(f) === key && match(f)).sort((a, b) => rank(a.status) - rank(b.status) || a.nick.localeCompare(b.nick, 'zh-Hant'))
}

// 頁籤裡的分組；設備組用設備名、本機那組排第一，其餘照設備名
export function groupItems(items, groupDim, { selfNode, selfName = '' } = {}) {
  if (groupDim === 'device') {
    const by = new Map()
    for (const f of items) {
      const k = f.node ?? ''
      if (!by.has(k)) by.set(k, { key: `device:${k}`, kind: 'device', node: k, label: (k === selfNode && selfName) || f.device || UNNAMED_DEVICE, items: [] })
      const g = by.get(k)
      if (f.device && g.label === UNNAMED_DEVICE) g.label = f.device
      g.items.push(f)
    }
    return [...by.values()].sort((a, b) => (b.node === selfNode) - (a.node === selfNode) || a.label.localeCompare(b.label, 'zh-Hant'))
      // node 留在組上：設備分組標題旁要用它查那台的 ASN 在線狀態
  }
  return groupInDevice(items, groupDim)
}

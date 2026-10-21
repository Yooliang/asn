// 「指引」與「設定」的聊天窗：跟好友的聊天窗同一套機制，只是內容不是對話。
//   整合模式：右邊分頁列多出「指引：<標題>」「設定：<分類名>」兩種分頁，各最多一個；點另一篇／另一類就換內容並切過去。
//   分離模式：各開一扇獨立視窗（panel.html），點另一篇／另一類就換內容。
// 純邏輯，介面與測試共用，不碰 DOM、不碰 Tauri。
import { guideByKey } from './guides.mjs'
import { catByKey } from './settings-cats.mjs'

export const PANEL_KINDS = ['guide', 'setting']
export const PANEL_LABEL = { guide: '指引', setting: '設定' }
export const PANEL_PREFIX = '@'   // 好友 id 是「節點/視窗名」，不會以 @ 開頭，所以分頁 id 不會撞

export const panelTabId = kind => PANEL_PREFIX + kind
export const panelKindOf = id => PANEL_KINDS.find(k => id === panelTabId(k)) ?? ''
export const isPanelTab = id => panelKindOf(id) !== ''

// 一篇指引／一類設定（認不得的鍵回 null）
export const panelItem = (kind, key) => (kind === 'guide' ? guideByKey(key) : kind === 'setting' ? catByKey(key) : null)
// 分頁與視窗標題：「指引：開始使用 ASN」「設定：外觀」
export const panelTitle = (kind, key) => { const it = panelItem(kind, key); return it ? `${PANEL_LABEL[kind]}：${it.title}` : (PANEL_LABEL[kind] ?? '') }

// 分頁列上的一項：id、種類與顯示名稱（好友分頁的資料由畫面自己帶）
export const panelTabItem = (kind, key) => ({ id: panelTabId(kind), panel: kind, nick: panelTitle(kind, key), status: '', unread: 0 })

// 一組分頁 id 拆成好友分頁與面板分頁（分離↔整合切換時要分開處理）
export function splitTabs(tabs) {
  const chats = [], panels = []
  for (const id of tabs) (isPanelTab(id) ? panels : chats).push(id)
  return { chats, panels: panels.map(panelKindOf) }
}

// ---------- 分離模式的視窗大小（記住） ----------
export const DEFAULT_PANEL_SIZE = { w: 480, h: 560 }
export const MIN_PANEL_SIZE = { w: 360, h: 320 }
const MAX_SIDE = 8000
export function normalizePanelSize(raw) {
  const ok = (v, min) => Number.isFinite(v) && v >= min && v <= MAX_SIDE
  return ok(raw?.w, MIN_PANEL_SIZE.w) && ok(raw?.h, MIN_PANEL_SIZE.h) ? { w: Math.round(raw.w), h: Math.round(raw.h) } : { ...DEFAULT_PANEL_SIZE }
}

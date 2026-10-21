// 視窗模式（分開／整合）、整合模式的對話分頁、大頭貼欄收合的純邏輯。介面與測試共用，不碰 DOM、不碰 Tauri。

export const MODES = ['split', 'merged']
export const MODE_LABEL = { split: '分離（每位好友各一扇視窗）', merged: '整合（一個視窗，右邊分頁聊天）' }
export const normalizeMode = v => (v === 'merged' ? 'merged' : 'split')

// ---------- 視窗大小 ----------
export const DEFAULT_SIZE = { split: { w: 360, h: 660 }, merged: { w: 900, h: 640 } }
export const MIN_SIZE = { split: { w: 280, h: 420 }, merged: { w: 720, h: 480 } }
const MAX_SIDE = 8000
// 讀回存檔的大小：不是數字、小於該模式的最小值或大到離譜就用預設（壞檔不會把視窗變成 1 像素）
export function normalizeSize(raw, mode) {
  const d = DEFAULT_SIZE[mode], m = MIN_SIZE[mode]
  const ok = (v, min) => Number.isFinite(v) && v >= min && v <= MAX_SIDE
  return ok(raw?.w, m.w) && ok(raw?.h, m.h) ? { w: Math.round(raw.w), h: Math.round(raw.h) } : { ...d }
}

// ---------- 對話分頁（整合模式） ----------
// 狀態：{ tabs: [好友 id…], active: 好友 id | '' }。不改傳入的物件。
export function openTab(st, id) {
  const tabs = st.tabs.includes(id) ? [...st.tabs] : [...st.tabs, id]
  return { tabs, active: id }
}
// 關分頁：關到的是目前這個就切到右邊那個（沒有就左邊），都沒有就沒有目前分頁
export function closeTab(st, id) {
  const i = st.tabs.indexOf(id)
  if (i < 0) return { tabs: [...st.tabs], active: st.active }
  const tabs = st.tabs.filter(x => x !== id)
  const active = st.active !== id ? st.active : (tabs[i] ?? tabs[i - 1] ?? '')
  return { tabs, active }
}
// 整合模式下這位好友的對話「看得到」嗎（來信要不要算未讀、要不要彈提示）：是目前分頁，且主視窗開著沒最小化
// （整合視窗右邊正顯示指引分頁時，對話被蓋住，也算看不到）
export const tabVisible = (st, id, windowVisible) => Boolean(windowVisible) && st.active === id && !st.showGuide

// 切換視窗模式時，已開的對話怎麼接：
//   分開→整合：已開的對話視窗（windowIds）全關掉、變成分頁（最後一個當目前分頁）
//   整合→分開：每個分頁開成一扇對話視窗、分頁清空
// 回傳 { tabs, active, openWindows, closeWindows }（closeWindows 只是描述，實際關窗由呼叫端做）
export function switchMode(from, to, { tabs = [], active = '', windowIds = [] } = {}) {
  from = normalizeMode(from); to = normalizeMode(to)
  if (from === to) return { tabs: [...tabs], active, openWindows: [], closeWindows: [] }
  if (to === 'merged') {
    const merged = [...new Set([...tabs, ...windowIds])]
    return { tabs: merged, active: merged.at(-1) ?? '', openWindows: [], closeWindows: [...windowIds] }
  }
  return { tabs: [], active: '', openWindows: [...tabs], closeWindows: [] }
}

// ---------- 對話區外觀：頭像模式與文字底色（跟視窗模式彼此獨立，任意組合都要能用） ----------
// 頭像模式：left／right＝對話區旁邊一欄放大頭貼（對方在上、自己在下），欄旁有箭頭可收合；inline（整合）＝像 LINE，頭像跟著每則訊息、沒有側欄。
export const DP_MODES = ['left', 'right', 'inline']
export const DP_LABEL = { left: '左（對話區左邊一欄）', right: '右（對話區右邊一欄）', inline: '整合（頭像在訊息旁）' }
export const normalizeDpMode = v => (DP_MODES.includes(v) ? v : 'left')
// 文字底色：none＝透明（原樣）；color＝每則訊息一個底色泡泡、雙方同色；auto＝像 LINE，對方一色、自己一色
export const BUBBLES = ['none', 'color', 'auto']
export const BUBBLE_LABEL = { none: '透明', color: '色彩（雙方同色）', auto: '自動（雙方各一色）' }
export const normalizeBubble = v => (BUBBLES.includes(v) ? v : 'none')
// 工具列位置：top＝輸入框上方（預設，舊版 MSN 6～2009：在對話紀錄和輸入框之間）；bottom＝輸入框下方（較新版本）
export const TOOLBARS = ['top', 'bottom']
export const TOOLBAR_LABEL = { top: '輸入框上方', bottom: '輸入框下方' }
export const normalizeToolbar = v => (TOOLBARS.includes(v) ? v : 'top')
export const DEFAULT_LOOK = { dpMode: 'left', bubble: 'none', collapsed: false, toolbar: 'top' }
// 從存檔讀回三個設定（壞值一律退回預設）
export const normalizeLook = raw => ({ dpMode: normalizeDpMode(raw?.dpMode), bubble: normalizeBubble(raw?.bubble), toolbar: normalizeToolbar(raw?.toolbar), collapsed: raw?.dpCollapsed === true || raw?.collapsed === true })

// 有沒有側欄（左右才有；整合沒有側欄，也就沒有收合箭頭）
export const hasSideCol = dpMode => normalizeDpMode(dpMode) !== 'inline'
export const sideOf = dpMode => (normalizeDpMode(dpMode) === 'right' ? 'right' : 'left')
// 收合只對側欄有意義；整合模式一律視為沒收合
export const isCollapsed = (dpMode, collapsed) => hasSideCol(dpMode) && collapsed === true
export const toggleCollapsed = c => c !== true
// 收合箭頭：箭頭指向「按下去大頭貼欄會往哪邊移動」——展開時指向它所在的那一側（收進去），收起時指回來（拉出來）
export function foldArrow(side, collapsed) {
  const towardSide = side === 'left' ? '‹' : '›'
  const towardMiddle = side === 'left' ? '›' : '‹'
  return collapsed ? towardMiddle : towardSide
}

/** 側欄底部橫向收合鈕：展開時指向側欄外（收合），收起時指回（展開） */
export function foldBarArrow(side, collapsed) {
  if (side === 'left') return collapsed ? '›' : '‹'
  return collapsed ? '‹' : '›'
}
// 對話區根元素的版面類別：頭像模式、底色、收合（模式與底色互不影響）
export function paneClasses({ dpMode, bubble, collapsed, toolbar } = {}) {
  const d = normalizeDpMode(dpMode)
  const c = ['dp-' + d, 'bub-' + normalizeBubble(bubble), 'tb-' + normalizeToolbar(toolbar)]
  if (isCollapsed(d, collapsed)) c.push('dp-collapsed')
  return c
}
// 一則訊息怎麼排：kind＝'me'｜'them'
//   整合頭像：對方靠左、帶對方小頭像；自己靠右、不帶頭像。其餘模式：兩邊都靠左、不帶頭像（原版面）
//   tone（底色）：none＝無；same＝雙方同色；them／me＝雙方各一色
export function msgLayout(kind, { dpMode, bubble } = {}) {
  const inline = normalizeDpMode(dpMode) === 'inline'
  const mine = kind === 'me'
  const b = normalizeBubble(bubble)
  return {
    align: inline && mine ? 'right' : 'left',
    avatar: inline && !mine,
    tone: b === 'none' ? 'none' : b === 'color' ? 'same' : mine ? 'me' : 'them',
  }
}

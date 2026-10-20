// 對話輸入列：提示文字與輸入列大頭貼是否顯示（純邏輯，供 ChatPane 與測試共用）。
import { hasSideCol, isCollapsed, normalizeMode } from './merge.mjs'

export const COMPOSE_HINT_FULL = '輸入訊息，Enter 傳送，Shift+Enter 換行'
export const COMPOSE_HINT_MERGED = '輸入訊息…'

/** 輸入框 placeholder：整合模式右側較窄，用較短的一句；分離模式維持完整提示 */
export function composePlaceholder(winMode) {
  return normalizeMode(winMode) === 'merged' ? COMPOSE_HINT_MERGED : COMPOSE_HINT_FULL
}

/** 滑過輸入框時顯示的完整操作說明（整合模式 placeholder 較短時用） */
export function composeHintTitle(winMode) {
  return composePlaceholder(winMode) === COMPOSE_HINT_MERGED ? COMPOSE_HINT_FULL : ''
}

/** 輸入列右側占位（對齊對話區收合箭頭）；與視窗模式無關，只看頭像模式有沒有側欄 */
export function showComposeSideSpacer(_winMode, dpMode) {
  return hasSideCol(dpMode)
}

/** 輸入列旁自己的大頭貼：整合模式一律顯示；分離模式與對話區側欄同步（含收合） */
export function showComposeSideCol(winMode, dpMode, collapsed) {
  if (normalizeMode(winMode) === 'merged') return true
  return hasSideCol(dpMode) && !isCollapsed(dpMode, collapsed)
}

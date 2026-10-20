// 對話輸入列提示文字（純邏輯，供 ChatPane 與測試共用）。
import { normalizeMode } from './merge.mjs'

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

// 對話輸入框 placeholder 與 title 提示（純邏輯，供 ChatPane 與測試共用）。
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

// 看別台夥伴的終端時（電腦版，#1288）：輸入框直接打進那個終端，按鈕與提示字跟著換
export const SEND_LABEL = '傳送'
export const SEND_LABEL_TERM = '送出'
/** 終端畫面時輸入框的提示字 */
export const composeTermHint = name => `輸入的字會直接打進 ${name || '這位夥伴'} 的終端`

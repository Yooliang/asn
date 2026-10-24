// 「僅顯示」條目：本機程序掃描出來的代理（名單標 kind＝process、receivable＝false），只能看、不能收信。
// 頁首不顯示忙碌、輸入框與傳送鈕禁用、通話鈕不提供；就算舊資料或競態仍送出，後台回 409 也轉成白話。
import { engineKey, engineLabel } from './tabs.mjs'

export const DISPLAY_ONLY_TAG = '僅顯示，無法收信'
export const DISPLAY_ONLY_ERROR = '這位夥伴只能顯示，不能收信'

export const isDisplayOnly = f => Boolean(f) && (f.receivable === false || f.entryKind === 'process')

export function displayOnlyHint(f) {
  const k = engineKey(f)
  const name = k === 'other' ? '程式' : engineLabel(k)
  return `這是這台電腦上自己開的 ${name}：ASN 只能顯示，不能傳訊息給它`
}

// 寄信失敗的後端字串（形如「send HTTP 409 not_receivable」）→ 給人看的白話；沒對到的原樣
export function friendlySendError(msg) {
  const e = String(msg ?? '')
  if (/not_receivable/.test(e)) return DISPLAY_ONLY_ERROR
  if (/rate_limited|HTTP 429/.test(e)) return '傳得太頻繁了，請稍後再試。'
  if (/body_too_long|too_long/.test(e)) return '這則訊息太長了，請分成幾則再傳。'
  return e
}

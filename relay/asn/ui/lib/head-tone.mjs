import { isDisplayOnly } from './display-only.mjs'
// 對話標題列的底色與提醒條（純邏輯，瀏覽器與 node 共用）。
// 手機版：對方忙碌時標題列改黃底，已經說了一次「忙碌」，就不再另外顯示黃色說明條。

/** 標題列色調：忙碌＝'busy'（疊黃色半透明）、離線＝'offline'（疊灰色半透明），其餘（線上、暫離）＝'normal'。 */
export function headTone(status, friend = null) {
  if (isDisplayOnly(friend)) return 'normal'
  return status === 'busy' ? 'busy' : status === 'offline' ? 'offline' : 'normal'
}

/** 標題列下方的提醒條種類：null＝不顯示；'offline'＝離線留言說明；'status'＝忙碌／暫離說明。
 *  hideBusy（手機版）：忙碌改由標題列黃底表達，不顯示說明條；暫離與離線照舊。 */
/** 內建通道的工作者「需要登入」時給人看的說明：要到哪一台電腦、執行什麼才能恢復（手機上不能代為登入）。
 *  friend.device＝那位夥伴所在的設備名；沒有就說「它所在的那台電腦」。登入後約一分鐘內會自己恢復，不必重開 */
export function loginNote(friend) {
  const nick = String(friend?.nick ?? '').trim() || '這位夥伴'
  const place = String(friend?.device ?? '').trim() ? `「${String(friend.device).trim()}」` : '它所在的那台電腦'
  const eng = `${friend?.engine ?? ''} ${friend?.agent ?? ''}`.toLowerCase()
  const how = /gemini|agy|antigravity/.test(eng) ? '打開終端機執行 agy，用 Google 帳號登入一次' : '重新登入它用的服務（在終端機執行該工具的登入指令）'
  return `${nick} 需要重新登入，寄來的信暫時不會處理。請到${place}，${how}；登入後約一分鐘內會自己恢復。`
}

export function warnKind(status, { hideBusy = false } = {}) {
  if (status === 'online' || !status) return null
  if (status === 'offline') return 'offline'
  if (status === 'stopped') return 'stopped'
  if (status === 'login-required') return 'login'
  if (status === 'busy' && hideBusy) return null
  return 'status'
}

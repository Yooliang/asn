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
export function warnKind(status, { hideBusy = false } = {}) {
  if (status === 'online' || !status) return null
  if (status === 'offline') return 'offline'
  if (status === 'stopped') return 'stopped'
  if (status === 'busy' && hideBusy) return null
  return 'status'
}

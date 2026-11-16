// 視窗是用系統管理員身分開的（Windows）：收發室轉不進去。名單上的小標記與說明。純函式，可單測。
// 資料來源：電腦版讀本機視窗時帶的 elevated（local_windows）；後台名單帶 elevated:true 時（之後後台支援）手機也一樣顯示。

export const ELEVATED_BADGE = '收不到信'
export const ELEVATED_TIP = '這個視窗是用系統管理員身分開的，收不到收發室轉交的信。請用一般方式（不要用系統管理員）重開這個視窗。'

/** 名單項目旁的小標記：{ text, tip }；不是系統管理員視窗、沒有這個欄位、離線＝null */
export function elevatedBadge(friend) {
  if (!friend || friend.elevated !== true || friend.status === 'offline') return null
  return { text: ELEVATED_BADGE, tip: ELEVATED_TIP }
}

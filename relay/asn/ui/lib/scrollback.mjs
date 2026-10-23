// 對話往上捲載入更舊的信：畫面端的純邏輯（不碰 DOM，方便測試）。chatpane.mjs 負責接線。
export const TOP_THRESHOLD = 120   // 捲到距頂端這麼近（像素）就自動載入
export const REARM_DISTANCE = 240  // 載入失敗後，要先離開頂端這麼遠，才會再試（免得停在頂端一直重試）

// 這次捲動要不要載入更舊的信
//  top＝scrollTop；state＝'loading'｜'done'｜undefined；armed＝上次失敗後是否已離開頂端；visible＝這個對話現在看得到（隱藏的分頁不載入）；hasLog＝已有信可當錨點
export function wantsOlder({ top, state, armed = true, visible = true, hasLog = true, threshold = TOP_THRESHOLD }) {
  return Boolean(visible && hasLog && armed && !state && top <= threshold)
}

// 失敗後是否重新開放：離開頂端夠遠才開
export const rearmed = (top, distance = REARM_DISTANCE) => top > distance

// 前面接上更舊的信後，要把 scrollTop 設成多少，才會停在原本看的那一則（內容變高多少就往下推多少）
export const keepScroll = (prevTop, prevHeight, newHeight) => Math.max(0, prevTop + (newHeight - prevHeight))

// 頂端的小字：載入中／已到盡頭；其餘不顯示。沒有任何信時不顯示「沒有更早」
export function olderNote(state, hasLog = true) {
  if (state === 'loading') return '載入更早的訊息…'
  if (state === 'done' && hasLog) return '沒有更早的訊息了（訊息保存 90 天）'
  return ''
}

// 對方（AI 夥伴）主動掛斷通話的記號。
// 用法：收到語音通話信的 AI，若談完了想結束通話，回信內文的「最後一行」單獨寫這個記號；通話端念完這封回信就自動掛斷。
// 記號本身不念出來、也不顯示在對話裡（畫面改顯示一行小提示）。每封通話信的第一行提示（CALL_MARKER）會告訴 AI 這個用法。
// 防誤觸：只有「最後一行」且整行就是記號才算；內文中間出現的記號不算。
// 是不是「通話對象寄來、且是回覆通話中的信」由通話端判斷（見 mobile-call.mjs、call-session.mjs），這裡只管字串。
export const CALL_END_MARKER = '〔結束通話〕'
export const CALL_END_NOTE = '對方結束了通話。'

/** 拆出記號：{ text: 去掉記號後的內文, ends: 最後一行是不是記號 }；不是記號時 text 原樣回傳 */
export function splitCallEnd(raw) {
  const s = String(raw ?? '')
  const lines = s.replace(/\s+$/, '').split(/\r?\n/)
  if (lines[lines.length - 1].trim() !== CALL_END_MARKER) return { text: s, ends: false }
  return { text: lines.slice(0, -1).join('\n').replace(/\s+$/, ''), ends: true }
}

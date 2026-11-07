// 聊天頁的終端入口（#900／#901／#902）：只有在共用終端服務裡的夥伴才有「終端」按鈕（放在上面那排大按鈕的第 2 格），
// 更新前開的舊夥伴照舊是前台顯示／後台隱藏，下面常駐一行小字請本人重新開一次。打開終端時占滿訊息區，關掉回到原本的捲動位置。
// 「在不在服務裡」由電腦端回答（term_view_available，只回是或否）；查不到（null）時當作不在，但不顯示那行小字。

export const TERM_LABEL = '終端'
export const TERM_TIP = '在 ASN 裡看這位夥伴的終端（再按一次回到訊息）'
export const TERM_BACK_TIP = '回到訊息'
// 上排第 2 個大按鈕（在共用終端服務裡的夥伴）：看訊息時寫「看終端」、看終端時寫「看訊息」，圖示跟著換（不只靠按下去的顏色）
// 對話圖示：專案裡沒有專用的訊息圖示，借用 ab-window.svg（視窗裡有文字行，最接近「看訊息」）
export const TERM_BTN_TERM = { label: '看終端', icon: 'img/ab-term.svg' }
export const TERM_BTN_MSG = { label: '看訊息', icon: 'img/ab-window.svg' }
/** shown：終端畫面是不是正開著。回這一格要顯示的字與圖示（按了會去的地方） */
export function termButtonView(shown, customLabel = '') {
  // 別台夥伴的「看畫面」（#968）：字與圖示固定，不隨開關換（跟本機服務裡夥伴的「看終端／看訊息」互斥，條件在 termBar／props.term.label）
  if (typeof customLabel === 'string' && customLabel !== '') return { label: customLabel, icon: TERM_BTN_TERM.icon }
  return shown === true ? { ...TERM_BTN_MSG } : { ...TERM_BTN_TERM }
}
export const TERM_REOPEN_NOTE = '重新開一次這位夥伴，就能在 ASN 裡看終端'

/**
 * 終端入口要怎麼呈現。base：電腦版、本機、不是內建通道、不是離線（能問的夥伴）；inService：true／false／null（查不到）。
 * 回 { term：上面第 2 格放「終端」, note：大按鈕下方那行小字（只有確定不在服務裡才有） }
 */
export function termEntry(base, inService) {
  const ok = base === true
  return { term: ok && inService === true, note: ok && inService === false ? TERM_REOPEN_NOTE : '' }
}

/** 問電腦端這位夥伴在不在共用終端服務裡：true／false；問不到回 null（原因只進 console） */
export async function askTermService(api, name) {
  if (!api || typeof api.available !== 'function' || !name) return null
  try {
    const r = await api.available(name)
    return typeof r === 'boolean' ? r : null
  } catch (e) {
    console.info('[ASN] 查不到這位夥伴在不在共用終端服務裡', String(e?.message ?? e))
    return null
  }
}

const BOTTOM_SLACK = 2

/** 打開終端前記下訊息列表的捲動位置（在底部的話記「在底部」，回來時新訊息也看得到） */
export function scrollMemo(el) {
  if (!el) return null
  return { top: el.scrollTop, bottom: el.scrollHeight - el.scrollTop - el.clientHeight <= BOTTOM_SLACK }
}

/** 關掉終端、訊息列表回來時該捲到哪 */
export function restoreTop(memo, { scrollHeight, clientHeight }) {
  const max = Math.max(0, scrollHeight - clientHeight)
  if (!memo) return max
  return memo.bottom ? max : Math.min(Math.max(0, memo.top), max)
}

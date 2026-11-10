// 外來訊息確認框（別的對話把訊息塞進夥伴時，等本人決定要不要放行）的共用字：電腦的提示框和手機的提示框都用這裡。
// 手機的請求不帶種類，只能靠選項認：兩顆按鈕的字剛好是這兩個才算（後端 claude_screen 的 PHONE_HELD_* 同一組字）。
export const HELD_LABELS = Object.freeze(['不放行', '放行這一則'])

/** 對方自稱的名字不一定是真的；放行後是整封送進去，不只顯示出來的那幾行 */
export const HELD_HINT = '對方自稱的名字不一定是真的。放行後，整封會送進這位夥伴。'

/** 標題：沒有視窗名就寫「這位夥伴」 */
export function heldTitle(name) {
  const n = typeof name === 'string' ? name.trim() : ''
  return `要讓這則外來訊息進到${n ? `「${n}」` : '這位夥伴'}嗎？`
}

/** 手機請求的選項剛好是 [{n:1,'不放行'},{n:2,'放行這一則'}] 才算外來訊息框 */
export function isHeldOptions(options) {
  return Array.isArray(options) && options.length === 2 && options.every((o, i) => o?.n === i + 1 && o?.label === HELD_LABELS[i])
}

// 殼在 <html> 上設的兩個平台屬性（#1763 F2，規格見 1.5 節第 3 點）：
//   data-input  ＝ pointer（滑鼠）／touch（觸控），決定共用零件的最小點擊尺寸 --asn-hit（指標 28px、觸控 44px）
//   data-layout ＝ split（左右分欄）／stack（上下堆疊），版面層需要的少數間距差
// 目前沒有任何樣式選擇器用到這兩個屬性（parts.css 也還沒被任何頁面載入），加上去不影響現有畫面。
// 這個檔放在 shells/ 而不放進 caps 表：caps 表的 14 個能力名稱已定案，且值一律是 true／false。
export const ATTRS_DESKTOP = Object.freeze({ input: 'pointer', layout: 'split' })
export const ATTRS_ANDROID = Object.freeze({ input: 'touch', layout: 'stack' })
// 網頁版尚未存在：先照電腦的值；之後真的做網頁殼時，input 改看 matchMedia('(pointer: coarse)')
export const ATTRS_WEB = Object.freeze({ input: 'pointer', layout: 'split' })

export const INPUT_VALUES = Object.freeze(['pointer', 'touch'])
export const LAYOUT_VALUES = Object.freeze(['split', 'stack'])

/** 把平台屬性寫到根元素（通常是 document.documentElement）；值不合法就不寫，免得畫出規範外的狀態 */
export function applyPlatformAttrs(root, attrs) {
  if (!root || !attrs) return
  if (INPUT_VALUES.includes(attrs.input)) root.setAttribute('data-input', attrs.input)
  if (LAYOUT_VALUES.includes(attrs.layout)) root.setAttribute('data-layout', attrs.layout)
}

// 「視窗開著，但還沒進到對話」的夥伴（#1635）：Claude 第一次的確認畫面（信任資料夾、略過權限的同意）還在等本人按，
// 所以還沒寫出對話紀錄檔，名單原本看不到它。電腦端把它列成名單的「僅顯示」條目（kind＝process、receivable＝false），
// 後台只保留 detail 等少數欄位，所以新版畫面靠 detail 的固定句認出它（舊版畫面照舊顯示灰點「執行中・僅顯示」加這句說明）。
// 條目的名字固定是「claude · <夥伴名> #<程序編號>」，不會和任何視窗名相撞。
// 這句要和 Rust 端 launch/awaiting.rs 的 DETAIL 一模一樣（test/awaiting.test.mjs 有跨語言一致性測試）。
export const AWAITING_DETAIL = '視窗開著，但在等你按確認'
/** 新版畫面給這類夥伴的狀態值（只在畫面內用，不會回報給後台） */
export const AWAITING_STATUS = 'awaiting'
export const AWAITING_LABEL = '等你在那台電腦按確認'
export const AWAITING_NOTE = '視窗開著，但在等你按確認：打開終端看清楚畫面後自己選，ASN 不會代你按'
export const AWAITING_NOTE_NO_TERM = '視窗開著，但在等你按確認：請到那台電腦的視窗看清楚後自己選'
export const AWAITING_SEND_ERROR = '這位夥伴的視窗開著，但還沒進到對話（在等你按確認），暫時不能收信'

const NAME_RE = /^claude · (.+) #\d+$/

/** 名單條目是不是這類夥伴：kind＝process、不能收信、說明是固定句，而且名字格式對得上 */
export const isAwaitingEntry = a => String(a?.kind ?? '').trim().toLowerCase() === 'process' && a?.receivable === false && typeof a?.detail === 'string' && a.detail.trim() === AWAITING_DETAIL && awaitingName(a?.name) !== ''

/** 條目名字裡的夥伴名；不是這個格式回空字串 */
export function awaitingName(entryName) {
  const m = NAME_RE.exec(String(entryName ?? ''))
  return m ? m[1].trim() : ''
}

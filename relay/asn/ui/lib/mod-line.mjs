// 設定頁「Claude 外掛」那一行狀態：Rust 回報 {state, version?, reason?}，這裡組成白話。
// 外掛是跟著 ASN 一起打包、啟動時比對版本才安裝／更新，不會自己上網更新，所以不寫「自動更新」。
// 失敗原因（reason）只進 log，不顯示在畫面上；沒有版本號就不寫「v」。
const RETRY = '重新開啟 ASN 會再試一次'

const verText = v => {
  const s = String(v ?? '').trim().replace(/^v/i, '')
  return s ? ` v${s}` : ''
}

export const MOD_LINES = {
  installed: mod => `已安裝${verText(mod.version)}，ASN 更新時會一起更新`,
  checking: () => '正在檢查…',
  no_claude: () => '這台電腦沒有 Claude，裝好 Claude 後重新開啟 ASN 會自動安裝',
  removed: () => '外掛已被移除，ASN 不會自動重裝',
  failed: () => `安裝沒有成功，${RETRY}`,
  update_failed: () => `更新沒有成功，${RETRY}`,
}

/** 沒有回報（還沒檢查、截圖模式、舊版 Rust）或認不得的狀態＝空字串，畫面不顯示這一行 */
export function modStatusLine(mod) {
  const f = mod && typeof mod === 'object' ? MOD_LINES[mod.state] : undefined
  return f ? f(mod) : ''
}

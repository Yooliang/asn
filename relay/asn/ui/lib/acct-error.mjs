// 帳號切換（列出別台帳號、送切換）的錯誤白話：手機與電腦共用同一份對照。純函式，不碰 DOM、不碰 Tauri。
const CODE_TEXT = {
  forbidden: '沒有權限：只有登入同一個帳號的本人，才能替自己的電腦切換帳號。請確認這裡已登入，且與那台電腦是同一個帳號。',
  not_found: '找不到這台電腦（可能已經移除或換了帳號）。',
  bad_request: '資料格式不對，請重新整理名單後再試。',
  bad_vendor: '目前只支援切換 Claude 帳號。',
  bad_email: '帳號的 email 格式不對。',
  asn_offline: '那台電腦的 ASN 沒有在線，無法切換。',
  unknown_account: '那台電腦的帳號庫裡沒有這個帳號（請對方開著 ASN 讓清單更新）。',
  busy: '那台電腦還有一個切換指令在處理中，請稍後再試。',
  rate_limited: '這台電腦這個小時切換太多次了，稍後再試。',
  internal: '伺服器發生錯誤，請稍後再試。',
}
// Rust 回來的錯誤長得像「acct_switch HTTP 403 forbidden」或一句中文；翻成給人看的一句話
export function acctErrorText(e) {
  const raw = typeof e === 'string' ? e : e?.message || ''
  if (!raw) return '操作失敗，請稍後再試。'
  const m = /HTTP (\d{3})\s*([a-z_]*)/.exec(raw)
  if (m) {
    if (CODE_TEXT[m[2]]) return CODE_TEXT[m[2]]
    if (m[1] === '404') return '後台還沒支援切換帳號，請等後台更新後再試。'
    if (m[1] === '401') return '尚未登入，請先到「我」分頁登入。'
    return `操作失敗（錯誤代碼 ${m[1]}），請稍後再試。`
  }
  return raw
}

// 是不是後台的「沒有權限」（HTTP 403）
export const isForbidden = e => /HTTP 403/.test(typeof e === 'string' ? e : e?.message || '')

// 收發室自己的系統通知（等待中、扣住、退回、轉交逾時…）走後台 bridge_notice 動作：
// 同帳號收件人收到「ASN 通知」寄的 notice:bridge，由後台決定收件人與限流；跨帳號（409 cross_account）
// 或舊後台沒有這個動作（404）就退回舊的 send（寄件名＝收發室信箱名），其他錯誤不退回、當作寄失敗。
// 請求內文只帶 reply_to 與 body：不帶收件人、寄件人欄位，收件人由後台從原信推出。

/** 要退回舊寄法的錯誤：409 cross_account、404（舊後台）、422 no_origin（原信超過 24 小時，例如關機一天後補拉的舊信）。 */
export function shouldFallback(err) {
  const status = err?.status
  const msg = String(err?.message ?? '')
  if (status === 404) return true
  if (status === 409) return /cross_account/.test(msg)
  if (status === 422) return /no_origin/.test(msg)
  return false
}

/** 原信本身是通知（422 is_notice）：不該回，當作處理完（不退回、回 true，免得補拉時一直重打） */
export function isSkip(err) {
  return err?.status === 422 && /is_notice/.test(String(err?.message ?? ''))
}

export function noticeBody(replyTo, body) {
  return { reply_to: replyTo, body }
}

/**
 * @param {{ api: Function, replyTo: string, body: string, legacy: () => Promise<boolean>, log?: (s: string) => void }} o
 * @returns {Promise<boolean>} 和舊 sendBack 一樣：寄出（或後台決定不寄）回 true，失敗回 false
 */
export async function sendBridgeNotice({ api, replyTo, body, legacy, log = () => {} }) {
  if (!replyTo) return legacy()
  try {
    const r = await api('bridge_notice', { method: 'POST', body: noticeBody(replyTo, body) })
    if (r && r.notify && r.notify !== 'sent') log(`bridge notice not sent id=${replyTo}: ${r.notify}`)
    return true
  } catch (e) {
    if (shouldFallback(e)) return legacy()
    if (isSkip(e)) { log(`bridge notice skipped id=${replyTo}: is_notice`); return true }
    log(`bridge notice failed id=${replyTo}: ${e?.message}`)
    return false
  }
}

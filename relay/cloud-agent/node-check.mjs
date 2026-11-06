// 啟動時確認「設定的節點」和「金鑰實際對到的節點」是同一個（#832）。
// 平台只有一組環境變數：同帳號再加一個雲端節點、貼上第二組設定時，金鑰會蓋掉第一組，後台一律依金鑰認節點。
// 沒有這道檢查時，代理會用別的節點身分回報 bot 名單、收別人的信，而且沒有任何提示。
// 只記變數名與節點代號，不記金鑰。

/** 跟身分有關的環境變數：新舊名同時存在又不同時，不知道該用哪一組，要停下來 */
export const IDENTITY_ENV = ['ASN_RELAY_ID', 'ASN_RELAY_KEY']

export const NODE_CHECK_EXIT = 4

/**
 * @param {{ conflictNames: string[] }} compat
 * @returns {string|null} 要停下來的原因；沒問題回 null
 */
export function identityEnvConflict(compat) {
  const bad = (compat?.conflictNames ?? []).filter(n => IDENTITY_ENV.includes(n))
  if (!bad.length) return null
  return `身分設定有兩組：${bad.join('、')} 和對應的舊名同時存在、內容不同。為了不用錯身分，收發室先停下來；請只留一組設定再啟動。`
}

/**
 * @param {string} configured 設定的節點（ASN_RELAY_ID）
 * @param {unknown} actual 後台 whoami 回的節點
 * @returns {string|null} 要停下來的原因；沒問題回 null
 */
export function nodeMismatch(configured, actual) {
  if (typeof actual !== 'string' || !actual) return null   // 舊後台沒回 node：不擋
  if (actual === configured) return null
  return `設定的節點是 ${configured}，但金鑰對到的是 ${actual}。可能是貼上另一組設定時把金鑰蓋掉了。為了不用別的節點身分收發信，收發室先停下來；請把設定改回同一組再啟動。`
}

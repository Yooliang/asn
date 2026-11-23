// 帳號的狀態判斷（#2111 ⑦、#1879）：帳號頁的卡片（電腦、手機）共用這一份。
// 設備詳情不再放帳號（#1860）：帳號只在設定的「帳號」頁看和管理。純函式、不改輸入。

/**
 * 一個帳號現在是什麼狀態（帳號頁卡片用，不准另寫）：
 * 登入已失效 > 訂閱已失效 > 額度用完 > 正常。訂閱已失效時額度不算用完（那時額度條本來就不畫）。
 */
export function accountStatusOf({ loginLost = false, subLapsed = false, exhausted = false } = {}) {
  if (loginLost) return 'lost'
  if (subLapsed) return 'lapsed'
  if (exhausted) return 'out'
  return 'normal'
}

/** 帳號卡的識別（帳號頁卡片的 data-acct-card）：廠牌＋帳號，帳號不分大小寫 */
export const accountCardKey = (vendor, email) => `${String(vendor ?? '').toLowerCase()}|${String(email ?? '').trim().toLowerCase()}`

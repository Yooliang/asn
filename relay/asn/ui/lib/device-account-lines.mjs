// 設備頁的帳號列（#2111 ⑦、#1879）：「設備 → 某台」裡一個帳號一行＋狀態標籤，點下去跳到帳號頁那張卡。
// 電腦（settings-panel）與手機（m.html）共用這一份。狀態判斷只有一處：accountStatusOf（帳號頁的卡片也用它），
// 登入失效沿用 accountDeviceRows 的判斷（帳號頁設備列同一個函式），訂閱失效與額度用完看帳號頁同一份 rosterView 資料。
// 設備頁不放額度條、切換、「⋯」：這些只在帳號頁（#1879：同一件事只放一個地方）。純函式、不改輸入。
import { LOGIN_LOST_TEXT, SUB_LAPSED_TEXT, accountDeviceRows, accountLoginLost } from './account-roster.mjs'

/** 額度用完（電腦、手機同一份）：標籤與一句下一步 */
export const QUOTA_OUT_TEXT = Object.freeze({
  tag: '額度用完',
  note: '這個帳號的額度用完了，重置後才能再用，或改用其他帳號。',
})

export const ACCOUNT_STATUS_TEXT = Object.freeze({ normal: '正常', lost: LOGIN_LOST_TEXT.tag, out: QUOTA_OUT_TEXT.tag, lapsed: SUB_LAPSED_TEXT.tag })
/** 標籤的 kit 類別（kit.css；帳號頁卡片的標籤同一套顏色） */
export const ACCOUNT_STATUS_CLASS = Object.freeze({ normal: 'asn-tag-ok', lost: 'asn-tag-warn', out: 'asn-tag-warn', lapsed: 'asn-tag-fail' })

/**
 * 一個帳號現在是什麼狀態（帳號頁卡片、設備頁帳號列共用，不准另寫）：
 * 登入已失效 > 訂閱已失效 > 額度用完 > 正常。訂閱已失效時額度不算用完（那時額度條本來就不畫）。
 */
export function accountStatusOf({ loginLost = false, subLapsed = false, exhausted = false } = {}) {
  if (loginLost) return 'lost'
  if (subLapsed) return 'lapsed'
  if (exhausted) return 'out'
  return 'normal'
}

/** 帳號卡的識別（帳號頁卡片的 data-acct-card；設備頁點下去用它找到那張卡）：廠牌＋帳號，帳號不分大小寫 */
export const accountCardKey = (vendor, email) => `${String(vendor ?? '').toLowerCase()}|${String(email ?? '').trim().toLowerCase()}`

const rosterRowOf = (myAccounts, vendor, email) => {
  const want = accountCardKey(vendor, email)
  return ((myAccounts?.vendors ?? []).find(v => v.key === vendor)?.accounts ?? []).find(a => accountCardKey(vendor, a.account) === want) ?? null
}

/** 有問題時那行下面的一句：文字都是帳號頁同一份常數 */
function noteOf(status, vendorLabel, email, device) {
  if (status === 'lost') return LOGIN_LOST_TEXT.notice(LOGIN_LOST_TEXT.who(device?.label ?? '', device?.self === true), vendorLabel, email)
  if (status === 'lapsed') return SUB_LAPSED_TEXT.note
  if (status === 'out') return QUOTA_OUT_TEXT.note
  return ''
}

/**
 * 某台設備上某個廠商的帳號列。
 * device＝設備樹那一台（{ key, label, self, vendors }）；vendor＝它的廠商（{ key, label, accounts }）；
 * myAccounts＝帳號頁用的 rosterView 結果（後台讀不到時是 null：狀態只剩這台自己回報的登入失效，仍然列出，不整塊消失）；
 * emails＝要列的帳號（預設用 vendor.accounts；本機 Claude 用本機帳號庫的清單）。
 * 回 [{ key, vendor, account, status, tag, tagClass, note }]
 */
export function deviceAccountLines(device, vendor, myAccounts, emails = null) {
  if (!device || !vendor?.key) return []
  const list = (Array.isArray(emails) ? emails : (vendor.accounts ?? []).map(a => a?.email))
    .map(e => String(e ?? '').trim()).filter(Boolean)
  const seen = new Set()
  const out = []
  for (const email of list) {
    const key = accountCardKey(vendor.key, email)
    if (seen.has(key)) continue
    seen.add(key)
    const row = rosterRowOf(myAccounts, vendor.key, email)
    // 登入失效：和帳號頁設備列同一個函式；隱藏、已移除的設備也要照實判斷，所以把這兩個旗標拿掉再算
    const rows = accountDeviceRows([{ ...device, hidden: false, removed: false }], vendor.key, email, row?.usedOn)
    const status = accountStatusOf({ loginLost: accountLoginLost(rows), subLapsed: row?.subLapsed === true, exhausted: row?.quota?.exhausted === true })
    out.push({ key, vendor: vendor.key, account: email, status, tag: ACCOUNT_STATUS_TEXT[status], tagClass: ACCOUNT_STATUS_CLASS[status], note: noteOf(status, vendor.label ?? vendor.key, email, device) })
  }
  return out
}

// 手機「設置」分頁的分類列表（對應電腦版 #67 的設定分類）：先列各分類（圖示、名稱、一行目前值），點一列進該項的滿版頁。
// 分類的鍵、名稱、圖示、摘要文字沿用電腦版的 settings-cats.mjs；手機只放手機有的設定，存檔格式不動。
import { SETTING_CATS, catSummary } from './settings-cats.mjs'

// 手機有的分類（順序即畫面順序）：個人（大頭貼、名字、設備名稱、狀態）、通知（震動）、更新、關於（版本）
export const MOBILE_SETTING_KEYS = ['me', 'notify', 'update', 'about']
// 滿版頁的導覽狀態；沒有的分類鍵＝空字串（normalizeNav 會把空字串退回設置分頁）
export const settingNav = (key = '') => ({ tab: 'me', sheet: 'setting', cat: MOBILE_SETTING_KEYS.includes(key) ? key : '' })

const onOff = v => (v ? '開' : '關')

// 一行目前值摘要。s＝目前設定的快照（欄位缺少時用保守的預設，不丟錯）
export function mobileCatSummary(key, s = {}) {
  switch (key) {
    case 'me':
      return [String(s.name ?? '').trim(), catSummary('me', { hasUpload: s.hasUpload })].filter(Boolean).join('、')
    case 'notify':
      return `對方傳震動時震動：${onOff(s.vibrateNudge)}、新訊息輕震：${onOff(s.vibrateMsg)}`
    case 'update':
      return s.updateEnabled === false ? '這個版本不提供自動檢查' : catSummary('update', { autoCheck: s.autoUpdate })
    case 'about':
      return catSummary('about', { version: s.version })
    default:
      return ''
  }
}

export const mobileSettingTitle = key => SETTING_CATS.find(c => c.key === key)?.title ?? ''

// 畫面用的列：[{ key, title, icon, summary }]
export function mobileSettingRows(s = {}) {
  return MOBILE_SETTING_KEYS.map(key => {
    const c = SETTING_CATS.find(x => x.key === key)
    return { key, title: c?.title ?? key, icon: c?.icon ?? '', summary: mobileCatSummary(key, s) }
  })
}

// 手機「設定」分頁的分類列表（對應電腦版 #67 的設定分類）：先列各分類（圖示、名稱、一行目前值），點一列進該項的內頁（蓋在設定分頁上）。
// 分類的鍵、名稱、圖示、摘要文字沿用電腦版的 settings-cats.mjs；手機只放手機有的設定，存檔格式不動。
import { SETTING_CATS, catSummary } from './settings-cats.mjs'
import { SKIN_SHORT, normalizeSkin } from './skin.mjs'
import { deviceSummary } from './device-tree.mjs'

// 手機有的分類（順序即畫面順序，與電腦版一致）：個人（大頭貼、名字、設備名稱、狀態）、設備、帳號、雲端代理、外觀（復古 Aero／現代）、提醒與聲音（震動）、更新、關於（版本）
export const MOBILE_SETTING_KEYS = ['me', 'devices', 'accounts', 'cloud', 'look', 'notify', 'update', 'about']   // look＝外觀（0.2.18：復古 Aero／現代，手機只有這一項）
// 手機上改名的分類（只改標題，鍵不變，存檔與瀏覽記錄照舊有效）：目前沒有（notify 原本在手機叫「提醒」，0.2.18 起兩邊都叫「提醒與聲音」）
export const MOBILE_CAT_TITLE = {}   // 0.2.18 起電腦版的 notify 也改叫「提醒與聲音」（不和「通知」分頁撞名），手機不用再另外改名
// 認得的電腦（指紋、忘記）已併進設備頁：每台設備的詳情、底部的舊設備紀錄
const catOf = key => { const c = SETTING_CATS.find(x => x.key === key); return c && MOBILE_CAT_TITLE[key] ? { ...c, title: MOBILE_CAT_TITLE[key] } : c }
// 設備、帳號（#268、#650）不是設定的一般分類頁：兩列都開同一頁（acct，上方「設備｜帳號」切換，各帶預設分頁），跟名單設備卡「選項」進去的是同一頁，入口並存
export const ACCT_SETTING_KEYS = ['devices', 'accounts']
export const SETTING_SHEET_KEYS = MOBILE_SETTING_KEYS.filter(k => !ACCT_SETTING_KEYS.includes(k))
// 這些分類點進去是內頁（內頁描述見 lib/mobile-fourth.mjs 的 settingPage）

const onOff = v => (v ? '開' : '關')

// 一行目前值摘要。s＝目前設定的快照（欄位缺少時用保守的預設，不丟錯）
export function mobileCatSummary(key, s = {}) {
  switch (key) {
    case 'me':
      return [String(s.name ?? '').trim(), catSummary('me', { hasUpload: s.hasUpload })].filter(Boolean).join('、')
    case 'devices':
      return deviceSummary(s.devices)
    case 'accounts': {
      const n = Number.isInteger(s.accountCount) ? s.accountCount : 0
      return n ? `${n} 個帳號` : '各家 AI 的帳號與額度'
    }
    case 'cloud':
      return catSummary('cloud')
    case 'look':
      return SKIN_SHORT[normalizeSkin(s.skin)]
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

export const mobileSettingTitle = key => catOf(key)?.title ?? ''

// 畫面用的列：[{ key, title, icon, summary }]
export function mobileSettingRows(s = {}) {
  return MOBILE_SETTING_KEYS.map(key => {
    const c = catOf(key)
    return { key, title: c?.title ?? key, icon: c?.icon ?? '', summary: mobileCatSummary(key, s) }
  })
}

// 手機「設置」分頁的分類列表（對應電腦版 #67 的設定分類）：先列各分類（圖示、名稱、一行目前值），點一列進該項的內頁（在第四頁籤上）。
// 分類的鍵、名稱、圖示、摘要文字沿用電腦版的 settings-cats.mjs；手機只放手機有的設定，存檔格式不動。
import { SETTING_CATS, catSummary } from './settings-cats.mjs'
import { deviceSummary } from './device-tree.mjs'

// 手機有的分類（順序即畫面順序，與電腦版一致）：個人（大頭貼、名字、設備名稱、狀態）、設備、帳號、雲端代理、通知（震動）、更新、關於（版本）
export const MOBILE_SETTING_KEYS = ['me', 'devices', 'accounts', 'cloud', 'known', 'notify', 'update', 'about']
// 手機上改名的分類（只改標題，鍵不變，存檔與瀏覽記錄照舊有效）：notify 在電腦版叫「通知」，手機的第四格已是「通知」對話，這裡叫「提醒」
export const MOBILE_CAT_TITLE = { notify: '提醒' }
// 認得的電腦：只有手機有的分類（電腦版的在設備那一頁裡），所以不在 settings-cats.mjs
const KNOWN_CAT = { key: 'known', title: '認得的電腦', icon: 'M12 3l7 3v5c0 5-3 8-7 10-4-2-7-5-7-10V6zM9 12l2 2 4-4' }
const catOf = key => { if (key === 'known') return KNOWN_CAT; const c = SETTING_CATS.find(x => x.key === key); return c && MOBILE_CAT_TITLE[key] ? { ...c, title: MOBILE_CAT_TITLE[key] } : c }
// 設備、帳號（#268、#650）不是設置的一般分類頁：兩列都開同一頁（acct，上方「設備｜帳號」切換，各帶預設分頁），跟名單設備卡「選項」進去的是同一頁，入口並存
export const ACCT_SETTING_KEYS = ['devices', 'accounts']
export const SETTING_SHEET_KEYS = MOBILE_SETTING_KEYS.filter(k => !ACCT_SETTING_KEYS.includes(k))
// 這些分類點進去是第四頁籤上的一頁（內頁描述見 lib/mobile-fourth.mjs 的 settingPage）

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
    case 'known': {
      const n = Number.isInteger(s.knownCount) ? s.knownCount : 0
      return n ? `${n} 台` : '還沒有認得的電腦'
    }
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

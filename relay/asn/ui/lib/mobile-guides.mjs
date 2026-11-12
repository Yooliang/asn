// 手機版「使用指引」：沿用電腦版的篇目（lib/guides.mjs，內容一個字不複製），只多一層「手機上適不適用」的標示。
// 設定分頁的「使用指引」點進去是蓋在設定分頁上的內頁：先列篇目，點一篇看內文；內文用 guide-doc 元件，一律當純文字顯示（不用 v-html）。
// node 與瀏覽器都能跑，不碰 DOM、不碰 Tauri。
import { GUIDES, guideByKey } from './guides.mjs'

export const GUIDE_ENTRY_LABEL = '使用指引'
export const GUIDE_ENTRY_SUB = '名字、群組、常見問題，和電腦版的說明'

// 每一篇在手機上的標示：desktop＝整篇講電腦上的操作；part＝一部分是電腦才有的；phone＝手機也適用
export const GUIDE_FIT = {
  start: { fit: 'part', badge: '部分是電腦版功能', note: '這篇是電腦版的操作說明。名字、大頭貼、狀態在手機的「設定」分頁就能改；截圖與標註、視窗外框、分頁與分組設定是電腦版功能，手機沒有。' },
  bridge: { fit: 'desktop', badge: '電腦版功能', note: '電腦只要裝好 ASN 電腦版並登入，開著的 Claude 視窗就會自動出現在名單上，手機不用設定。這篇是電腦上的說明，只供對照。' },
  cloud: { fit: 'part', badge: '部分是電腦版功能', note: '手機的「設定」分頁有「雲端代理」：可以邀請雲端代理、取得只顯示一次的金鑰與要貼給代理的說明、看代理是否上線、撤銷，也能輸入主機上的短碼核准無畫面主機。金鑰要設到代理平台、說明要貼給代理，這兩步在代理那一邊做。' },
  groups: { fit: 'phone', badge: '手機也能用', note: '手機版比下面的說明多一點：夥伴分頁的「群組對話」分組可以直接看群組訊息，也能用你的登入身分發言。建立群組、加人、改置頂仍然只能在後台做。' },
  faq: { fit: 'phone', badge: '', note: '' },
}
const FALLBACK = { fit: 'phone', badge: '', note: '' }

// 篇目列表（照電腦版的順序）
export const phoneGuideList = () => GUIDES.map(g => ({ key: g.key, title: g.title, sub: g.sub, ...(GUIDE_FIT[g.key] ?? FALLBACK) }))
// 某一篇（沒有這一篇回 null）：附上手機的標示
export function phoneGuide(key) {
  const g = guideByKey(key)
  return g ? { guide: g, ...(GUIDE_FIT[g.key] ?? FALLBACK) } : null
}
// 導覽：內頁（內頁描述見 lib/mobile-fourth.mjs 的 guidePage）

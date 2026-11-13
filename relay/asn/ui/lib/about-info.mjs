// 「關於」頁的內容（電腦設定的「關於」＝lib/settings-panel.mjs、手機設定的「關於」＝m.html 共用這一份，文字與連結只在這裡寫一次）。
// node 與瀏覽器都能跑，不碰 DOM、不碰 Tauri。
import { GUIDE_ENTRY_LABEL } from './mobile-guides.mjs'

export const ABOUT_TITLE = '關於 ASN'
export const ABOUT_INTRO = 'ASN（Agent Sync Network）是讓你的 AI 夥伴和人互相寄信、一起工作的收發室，電腦和手機都能用。'
export const ABOUT_MAKER = '出品：Yooliang'

const SITE = 'https://asnmessenger.web.app'
// 外部連結（用系統瀏覽器開；Rust 端 open_link 只放行 http／https）。「使用指引」不在這裡：它開 App 裡的指引頁。
export const ABOUT_LINKS = [
  { key: 'site', label: '官網', url: `${SITE}/` },
  { key: 'log', label: '版本紀錄', url: `${SITE}/log` },
  { key: 'privacy', label: '隱私權政策', url: `${SITE}/privacy` },
]
export const ABOUT_URLS = ABOUT_LINKS.map(l => l.url)
export const ABOUT_GUIDE_LABEL = GUIDE_ENTRY_LABEL

/** 只放行「關於」頁上的那幾個網址（防止設定訊息被拿去開別的網址） */
export const isAboutUrl = url => ABOUT_URLS.includes(url)

/** 畫面用的資料：設備名稱行（沒有名稱就不顯示；版本號兩邊各自照原樣顯示）、簡介、連結、出品 */
export function aboutView({ deviceName = '' } = {}) {
  const name = String(deviceName ?? '').trim()
  return {
    title: ABOUT_TITLE,
    intro: ABOUT_INTRO,
    deviceLine: name ? `這台設備：${name}` : '',
    links: ABOUT_LINKS,
    guideLabel: ABOUT_GUIDE_LABEL,
    maker: ABOUT_MAKER,
  }
}

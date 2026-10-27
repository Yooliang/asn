// 官網各頁共用的「頁首（Logo＋選單）、頁尾連結、網站圖示」只在這支腳本裡寫一份，再寫進各頁的標記區段之間。
// 改選單或 Logo：編輯下面的 NAV／BRAND，執行 `node site/make-layout.mjs`；守門測試 tests/site_layout.test.mjs 會檢查各頁與這份一致，忘了跑會變紅。
// 不用前端框架也不用執行階段腳本（網站的內容安全政策不允許行內腳本），所以是「建置時產生靜態 HTML」。
// 例外：藍圖與開發日誌兩頁的內容從資料庫讀，載入 timeline/ 底下的外部腳本（這兩頁的內容安全政策在 firebase.json 另外放寬）。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// 選單：固定順序，每頁都一樣；站內錨點一律寫完整連結（/#features），在任何頁面都連得到。
export const NAV = [
  { key: 'home', label: '首頁', href: '/' },
  { key: 'features', label: '功能', href: '/#features' },
  { key: 'screens', label: '畫面', href: '/#screens' },
  { key: 'download', label: '下載', href: '/#download' },
  { key: 'roadmap', label: '藍圖', href: '/roadmap' },
  { key: 'log', label: '開發日誌', href: '/log' },
  { key: 'privacy', label: '隱私權政策', href: '/privacy' },
  { key: 'terms', label: '服務條款', href: '/terms' },
]
export const BRAND = { name: 'Agent Sync Network Messenger', logo: '/img/logo.svg', alt: 'ASN 小機器人' }
// 頁尾左邊的連結（右邊的聯絡資訊各頁自己手寫，不在這裡）
export const FOOTER_NAV = ['home', 'roadmap', 'log', 'privacy', 'terms']

// 要套用的頁面（相對 site/public）：current 是選單要高亮的項目（null＝沒有對應項目）；parts 是要產生的區段
export const PAGES = {
  'index.html': { current: 'home', parts: ['head', 'header', 'footer'] },
  'privacy.html': { current: 'privacy', parts: ['head', 'header', 'footer'] },
  'terms.html': { current: 'terms', parts: ['head', 'header', 'footer'] },
  'roadmap.html': { current: 'roadmap', parts: ['head', 'header', 'footer'] },   // 內容從資料庫讀（timeline/roadmap.mjs）
  'log.html': { current: 'log', parts: ['head', 'header', 'footer'] },           // 內容從資料庫讀（timeline/log.mjs）
  'skill/index.html': { current: null, parts: ['head', 'header'] },
  'i/index.html': { current: null, parts: ['head', 'header'] },
  'link/index.html': { current: null, parts: ['head'] },   // 核准頁有自己的版面（link.css），只套網站圖示
}

const mark = name => ({
  start: `<!-- layout:${name}:start（由 site/make-layout.mjs 產生，不要手改） -->`,
  end: `<!-- layout:${name}:end -->`,
})
export const markers = mark

const link = (n, current) => `<a href="${n.href}"${n.key === current ? ' aria-current="page"' : ''}>${n.label}</a>`

export const renderHead = () => [
  '<link rel="icon" href="/img/logo.svg" type="image/svg+xml">',
  '<link rel="icon" href="/img/favicon-32.png" type="image/png" sizes="32x32">',
  '<link rel="apple-touch-icon" href="/img/apple-touch-icon.png">',
].join('\n')

export const renderHeader = current => [
  '<header class="top">',
  '  <div class="wrap">',
  `    <a class="brand" href="/"><img class="brand-logo" src="${BRAND.logo}" alt="${BRAND.alt}" width="36" height="36">${BRAND.name}</a>`,
  '    <nav class="nav" aria-label="主選單">',
  ...NAV.map(n => `      ${link(n, current)}`),
  '    </nav>',
  '  </div>',
  '</header>',
].join('\n')

export const renderFooterLinks = () =>
  '<div>' + FOOTER_NAV.map(k => link(NAV.find(n => n.key === k), null)).join('') + '</div>'

const RENDER = {
  head: () => renderHead(),
  header: c => renderHeader(c),
  footer: c => renderFooterLinks(c),
}

// 把 name 區段換成新內容；區段不存在就丟錯
export function inject(html, name, body) {
  const { start, end } = mark(name)
  const a = html.indexOf(start)
  const b = html.indexOf(end)
  if (a < 0 || b < a) throw new Error(`找不到 layout:${name} 的標記區段`)
  const indent = /[ \t]*$/.exec(html.slice(0, a))[0]   // 沿用起始標記前面的縮排
  const pad = body.split('\n').map(l => indent + l).join('\n')
  return html.slice(0, a + start.length) + '\n' + pad + '\n' + indent + html.slice(b)
}

export function applyLayout(html, page) {
  let out = html
  for (const p of page.parts) out = inject(out, p, RENDER[p](page.current))
  return out
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const root = new URL('./public/', import.meta.url)
  for (const [file, page] of Object.entries(PAGES)) {
    const f = fileURLToPath(new URL(file, root))
    const before = fs.readFileSync(f, 'utf8')
    const after = applyLayout(before, page)
    if (after !== before) fs.writeFileSync(f, after)
    console.log(`${after !== before ? '已更新' : '沒變　'} ${path.posix.join('site/public', file)}`)
  }
}

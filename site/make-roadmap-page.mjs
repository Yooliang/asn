// 把 relay/asn/CHANGELOG.md（更新記錄的唯一來源）最近 10 版寫進 public/roadmap.html 的標記區段之間。
// 發版後重跑：node site/make-roadmap-page.mjs（守門測試 tests/roadmap_page.test.mjs 會檢查頁面與來源一致）。
// 藍圖部分是手寫的，依 docs/ROADMAP.md 與 issue 更新，不在這支腳本處理範圍。
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

export const KEEP = 10
export const START = '<!-- changelog:start（由 site/make-roadmap-page.mjs 產生，不要手改） -->'
export const END = '<!-- changelog:end -->'

const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

// 解析 `## 版本號（日期）` 加「- 」條列；新版在最上面。
export function parseChangelog(text, keep = KEEP) {
  const out = []
  for (const block of text.replace(/\r\n/g, '\n').split(/^## /m).slice(1)) {
    const lines = block.split('\n')
    const m = /^(\d+\.\d+\.\d+)（(\d{4}-\d{2}-\d{2})）\s*$/.exec(lines[0])
    if (!m) continue
    const items = lines.slice(1).filter(l => l.startsWith('- ')).map(l => l.slice(2).trim()).filter(Boolean)
    out.push({ version: m[1], date: m[2], items })
    if (out.length >= keep) break
  }
  return out
}

export function renderReleases(releases) {
  return releases.map(r => [
    '      <article class="glass release">',
    `        <h3>${esc(r.version)}<span class="date">${esc(r.date)}</span></h3>`,
    '        <ul>',
    ...r.items.map(i => `          <li>${esc(i)}</li>`),
    '        </ul>',
    '      </article>',
  ].join('\n')).join('\n')
}

export function injectReleases(html, releases) {
  const a = html.indexOf(START)
  const b = html.indexOf(END)
  if (a < 0 || b < a) throw new Error('roadmap.html 找不到更新日誌的標記區段')
  return html.slice(0, a + START.length) + '\n' + renderReleases(releases) + '\n      ' + html.slice(b)
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const src = fs.readFileSync(new URL('../relay/asn/CHANGELOG.md', import.meta.url), 'utf8')
  const page = new URL('./public/roadmap.html', import.meta.url)
  const releases = parseChangelog(src)
  fs.writeFileSync(page, injectReleases(fs.readFileSync(page, 'utf8'), releases))
  console.log(`已寫入 ${releases.length} 版：${releases.map(r => r.version).join('、')}`)
}

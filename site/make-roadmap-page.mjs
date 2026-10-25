// 把 relay/asn/CHANGELOG.md（更新記錄的唯一來源）最近 10 版寫進 public/roadmap.html 的標記區段之間；
// 也把 site/meetings.json（會議記錄的唯一來源，新增一筆只要改這個資料檔）寫進「會議記錄」表格的標記區段。
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

// ---- 會議記錄（資料在 site/meetings.json）----
export const M_START = '<!-- meetings:start（由 site/make-roadmap-page.mjs 產生，不要手改；資料在 site/meetings.json） -->'
export const M_END = '<!-- meetings:end -->'
export const M_FIELDS = [
  ['attendees', '出席／回覆'],
  ['progress', '各項進度'],
  ['decisions', '決議'],
  ['assignments', '分派'],
  ['improvements', '改善意見'],
]

// 每筆：{ time: 'YYYY-MM-DD HH:MM'（台北時間，時間可省略）, attendees, progress, decisions, assignments, improvements }
// 後五個欄位可以是字串或字串陣列（陣列顯示成條列）。回傳「最新在上」，同時間維持檔案裡的先後。
export function parseMeetings(list) {
  if (!Array.isArray(list)) throw new Error('meetings.json 必須是陣列')
  const rows = list.map((m, i) => {
    if (!m || typeof m !== 'object') throw new Error(`第 ${i + 1} 筆不是物件`)
    if (!/^\d{4}-\d{2}-\d{2}( \d{2}:\d{2})?$/.test(m.time ?? '')) throw new Error(`第 ${i + 1} 筆 time 格式要是 YYYY-MM-DD HH:MM：${m.time}`)
    const out = { time: m.time }
    for (const [k, label] of M_FIELDS) {
      const raw = m[k]
      const items = (Array.isArray(raw) ? raw : [raw]).flatMap(x => String(x ?? '').split('\n')).map(x => x.trim()).filter(Boolean)
      if (!items.length) throw new Error(`第 ${i + 1} 筆（${m.time}）缺少「${label}」；沒有內容請寫「無」`)
      out[k] = items
    }
    return out
  })
  return rows.map((r, i) => ({ r, i })).sort((a, b) => (a.r.time < b.r.time ? 1 : a.r.time > b.r.time ? -1 : a.i - b.i)).map(x => x.r)
}

const cell = items => items.length === 1 ? esc(items[0]) : `<ul>${items.map(i => `<li>${esc(i)}</li>`).join('')}</ul>`

export function renderMeetings(rows) {
  if (!rows.length) return '        <tr><td colspan="6">還沒有記錄，第一筆從小會議開始後寫入。</td></tr>'
  return rows.map(r => [
    '        <tr>',
    `          <th scope="row">${esc(r.time)}</th>`,
    ...M_FIELDS.map(([k, label]) => `          <td data-label="${label}">${cell(r[k])}</td>`),
    '        </tr>',
  ].join('\n')).join('\n')
}

export function injectMeetings(html, rows) {
  const a = html.indexOf(M_START)
  const b = html.indexOf(M_END)
  if (a < 0 || b < a) throw new Error('roadmap.html 找不到會議記錄的標記區段')
  return html.slice(0, a + M_START.length) + '\n' + renderMeetings(rows) + '\n        ' + html.slice(b)
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const src = fs.readFileSync(new URL('../relay/asn/CHANGELOG.md', import.meta.url), 'utf8')
  const page = new URL('./public/roadmap.html', import.meta.url)
  const releases = parseChangelog(src)
  const meetings = parseMeetings(JSON.parse(fs.readFileSync(new URL('./meetings.json', import.meta.url), 'utf8')))
  fs.writeFileSync(page, injectMeetings(injectReleases(fs.readFileSync(page, 'utf8'), releases), meetings))
  console.log(`已寫入 ${releases.length} 版：${releases.map(r => r.version).join('、')}；會議記錄 ${meetings.length} 筆`)
}

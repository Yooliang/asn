// 把「搬進資料庫之前」的藍圖頁內容轉成種子 SQL（第一期，一次性搬家用；之後資料以資料庫為準）。
// 來源是凍結的快照：site/tools/seed-source/roadmap.html（搬家前的 site/public/roadmap.html）與 seed-source/meetings.json。
// 產出：supabase/migrations/20261027100100_site_content_seed.sql。執行：node site/tools/extract-roadmap-seed.mjs
// 守門測試 tests/roadmap_page.test.mjs 會重跑這支並比對已提交的 SQL，兩邊不一致會變紅。
//
// 內文格式（不存 HTML）：**粗體**、`程式碼`、#123（議題編號，只當文字樣式），以換行開頭的「- 」行是子項目。
// 頁面上的 <span class="refs"> 抽成 refs 陣列；<span class="tag">已隨 X 發佈</span> 抽成 version。
// 遇到不認得的標籤就丟錯，不默默吞掉內容。
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

export const SOURCE_HTML = new URL('./seed-source/roadmap.html', import.meta.url)
export const SOURCE_MEETINGS = new URL('./seed-source/meetings.json', import.meta.url)
export const OUTPUT_SQL = new URL('../../supabase/migrations/20261027100100_site_content_seed.sql', import.meta.url)

const STATUS_OF_CLASS = { 'st-ok': 'ok', 'st-unv': 'unv', 'st-doing': 'doing', 'st-todo': 'todo', 'st-tbc': 'tbc', 'st-na': 'na' }
// 藍圖三欄與待辦三欄：標題文字 → 欄位代號、預設狀態、標籤樣式
const LANES = {
  roadmap: [
    { match: '已完成', key: 'done', status: 'released', tone: 'done' },
    { match: '進行中', key: 'doing', status: 'doing', tone: 'doing' },
    { match: '規劃中', key: 'plan', status: 'planned', tone: 'plan' },
  ],
  todo: [
    { match: '一、需要負責人決定', key: 'decide', status: 'decide', tone: 'plan' },
    { match: '二、近期（依序）', key: 'next', status: 'doing', tone: 'doing' },
    { match: '三、之後', key: 'later', status: 'planned', tone: 'plan' },
  ],
}
const PLATFORM_WORDS = ['官網', 'Play 內部測試', 'Play', '家用機', '工作機', '安卓']

const decode = s => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
const squash = s => s.replace(/\s+/g, ' ').trim()

function sectionOf(html, id) {
  const a = html.indexOf(`<section id="${id}">`)
  const b = html.indexOf('</section>', a)
  if (a < 0 || b < a) throw new Error(`找不到 #${id} 區段`)
  return html.slice(a, b)
}

// 一段行內 HTML → { text（內文格式）, refs, tag }
export function toMarkup(inner) {
  const refs = []
  let tag = null
  let s = inner
    .replace(/<span class="refs">([^<]*)<\/span>/g, (_, r) => { for (const m of r.matchAll(/#(\d+)/g)) refs.push(Number(m[1])); return '' })
    .replace(/<span class="tag">([^<]*)<\/span>/g, (_, t) => { tag = squash(decode(t)); return '' })
    .replace(/<strong>([^<]*)<\/strong>/g, '**$1**')
    .replace(/<code>([^<]*)<\/code>/g, '`$1`')
  // 巢狀清單 → 換行加「- 」
  s = s.replace(/<ul>/g, '\n').replace(/<\/ul>/g, '\n').replace(/<li>/g, '\n- ').replace(/<\/li>/g, '\n')
  const left = /<[^>]+>/.exec(s)
  if (left) throw new Error(`不認得的標籤：${left[0]}（內容：${squash(inner).slice(0, 60)}…）`)
  const lines = decode(s).split('\n').map(squash).filter(Boolean)
  return { text: lines.join('\n'), refs, tag }
}

// 「**標題**：內文」拆成 title／body；開頭不是這個樣子就整段當內文
export function splitTitle(text) {
  const m = /^\*\*([^*]+)\*\*：([\s\S]*)$/.exec(text)
  return m ? { title: m[1], body: m[2].trim() } : { title: null, body: text }
}

// 頂層 <li>…</li>（允許一層巢狀 <ul>）
function topItems(ulInner) {
  const out = []
  let depth = 0, start = -1
  const re = /<(\/?)(li|ul)>/g
  let m
  while ((m = re.exec(ulInner))) {
    const [tok, close, name] = m
    if (name === 'li' && !close && depth === 0) start = m.index + tok.length
    if (name === 'ul') depth += close ? -1 : 1
    if (name === 'li' && close && depth === 0) out.push(ulInner.slice(start, m.index))
  }
  return out
}

function lanesOf(section, sectionKey) {
  const lanes = []
  const items = []
  for (const m of section.matchAll(/<div class="glass lane">\s*<h3><span class="status (\w+)">([^<]+)<\/span><\/h3>\s*<ul>([\s\S]*?)<\/ul>\s*<\/div>/g)) {
    const label = m[2]
    const def = LANES[sectionKey].find(l => l.match === label)
    if (!def) throw new Error(`不認得的欄位：${label}`)
    lanes.push({ section: sectionKey, key: def.key, label, tone: def.tone, sort: lanes.length + 1 })
    topItems(m[3]).forEach((li, i) => {
      const { text, refs, tag } = toMarkup(li)
      const { title, body } = splitTitle(text)
      let version = null
      let status = def.status
      const tagV = tag && /已隨 (\d+\.\d+\.\d+) 發佈/.exec(tag)
      if (tagV) version = tagV[1]
      else if (tag) throw new Error(`不認得的標籤文字：${tag}`)
      const tv = title && /^(\d+\.\d+\.\d+) (驗收|預定)$/.exec(title)
      if (tv) { version = tv[1]; if (tv[2] === '預定') status = 'planned' }
      items.push({ key: `${sectionKey}-${def.key}-${String(i + 1).padStart(2, '0')}`, section: sectionKey, lane: def.key, title, body, refs, status, version, sort: (i + 1) * 10 })
    })
  }
  return { lanes, items }
}

function matrixOf(section) {
  const head = /<thead>([\s\S]*?)<\/thead>/.exec(section)[1]
  const heads = [...head.matchAll(/<th scope="col">([^<]+)<\/th>/g)].map(m => m[1])
  if (heads[0] !== 'AI' || heads[heads.length - 1] !== '備註與限制') throw new Error('總表欄位結構變了')
  const COL_KEYS = { 開啟: 'open', 關閉: 'close', 接手: 'adopt', 切換模型: 'model', 群組聊天: 'group', 帳號切換: 'account' }
  const columns = heads.slice(1, -1).map((label, i) => {
    if (!COL_KEYS[label]) throw new Error(`不認得的總表欄位：${label}`)
    return { key: COL_KEYS[label], label, sort: (i + 1) * 10 }
  })
  const rows = []
  const cells = []
  const body = /<tbody>([\s\S]*?)<\/tbody>/.exec(section)[1]
  for (const tr of body.matchAll(/<tr>([\s\S]*?)<\/tr>/g)) {
    const th = /<th scope="row" data-label="AI"><strong>([^<]+)<\/strong><span class="kind">([^<]+)<\/span><\/th>/.exec(tr[1])
    if (!th) throw new Error('總表列缺 AI 名稱')
    const name = decode(th[1]), kind = decode(th[2])
    const tds = [...tr[1].matchAll(/<td data-label="([^"]+)"([^>]*)>([\s\S]*?)<\/td>/g)]
    const noteTd = tds.find(t => t[1] === '備註與限制')
    if (!noteTd) throw new Error(`${name} 缺備註欄`)
    rows.push({ key: rowKey(name, kind, rows), name, kind, note: toMarkup(noteTd[3]).text, sort: (rows.length + 1) * 10 })
    for (const col of columns) {
      const td = tds.find(t => t[1] === col.label)
      if (!td) throw new Error(`${name} 缺「${col.label}」`)
      const st = /<span class="st (st-[a-z]+)">([^<]+)<\/span>\s*<p>([\s\S]*?)<\/p>/.exec(td[3])
      if (!st || !STATUS_OF_CLASS[st[1]]) throw new Error(`${name}／${col.label} 狀態格式不對`)
      const { text, refs } = toMarkup(st[3])
      cells.push({ row: rows[rows.length - 1].key, column: col.key, status: STATUS_OF_CLASS[st[1]], body: text, refs })
    }
  }
  return { columns, rows, cells }
}

// 列的代號：名稱（小寫）＋形態（Grok 有兩列：本機背景工作者與雲端代理）
function rowKey(name, kind, rows) {
  const base = name.toLowerCase()
  const KIND = { 互動視窗: '', 背景工作者: '', 本機背景工作者: '-local', 雲端代理: '-cloud', '互動視窗＋ASN 擴充': '' }
  if (!(kind in KIND)) throw new Error(`不認得的形態：${kind}`)
  const k = base + KIND[kind]
  if (rows.some(r => r.key === k)) throw new Error(`列代號重複：${k}`)
  return k
}

function releasesOf(section, context) {
  const out = []
  for (const m of section.matchAll(/<article class="glass release">\s*<h3>([\d.]+)<span class="date">(\d{4}-\d{2}-\d{2})<\/span><\/h3>\s*<ul>([\s\S]*?)<\/ul>\s*<\/article>/g)) {
    const version = m[1]
    const items = [...m[3].matchAll(/<li>([\s\S]*?)<\/li>/g)].map(x => toMarkup(x[1]).text)
    out.push({ version, date: m[2], items, ...releaseFacts(version, context) })
  }
  return out
}

// 從待辦與會議記錄的文字裡找這一版的發版 commit 與發佈到哪裡（找不到就留空，不猜）
export function releaseFacts(version, context) {
  const v = version.replace(/\./g, '\\.')
  const commit = new RegExp(`${v} 已發（[^）]*?發版 commit ([0-9a-f]{7,40})`).exec(context)?.[1]
    ?? new RegExp(`${v}（([0-9a-f]{7,40})[；）]`).exec(context)?.[1]
    ?? new RegExp(`${v} 已發（([0-9a-f]{7,40})[；）]`).exec(context)?.[1]
    ?? null
  const where = new RegExp(`${v} 已發（([^）；]*)`).exec(context)?.[1] ?? ''
  const platforms = where.split('、').map(s => s.trim()).filter(s => PLATFORM_WORDS.includes(s))
  return { commit, platforms }
}

export function parseMeetingsJson(list) {
  if (!Array.isArray(list)) throw new Error('meetings.json 必須是陣列')
  const FIELDS = ['attendees', 'progress', 'decisions', 'assignments', 'improvements']
  return list.map((m, i) => {
    if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(m?.time ?? '')) throw new Error(`第 ${i + 1} 筆時間格式不對`)
    const out = { time: m.time }
    for (const k of FIELDS) {
      const items = (Array.isArray(m[k]) ? m[k] : [m[k]]).flatMap(x => String(x ?? '').split('\n')).map(squash).filter(Boolean)
      if (!items.length) throw new Error(`第 ${i + 1} 筆缺 ${k}`)
      out[k] = items
    }
    return out
  }).sort((a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : 0))
}

export function extract(htmlRaw, meetingsRaw) {
  const html = htmlRaw.replace(/\r\n/g, '\n')
  const roadmap = lanesOf(sectionOf(html, 'roadmap'), 'roadmap')
  const todo = lanesOf(sectionOf(html, 'todo'), 'todo')
  const meetings = parseMeetingsJson(JSON.parse(meetingsRaw))
  const context = [...todo.items.map(i => `${i.title ?? ''}：${i.body}`), ...meetings.flatMap(m => m.progress)].join('\n')
  return {
    releases: releasesOf(sectionOf(html, 'changelog'), context),
    meetings,
    lanes: [...roadmap.lanes, ...todo.lanes],
    items: [...roadmap.items, ...todo.items],
    matrix: matrixOf(sectionOf(html, 'matrix')),
  }
}

// ---- 輸出 SQL ----
const q = s => (s == null ? 'null' : `'${String(s).replace(/'/g, "''")}'`)
const textArr = a => (a.length ? `array[${a.map(q).join(', ')}]::text[]` : `'{}'::text[]`)
const intArr = a => `'{${a.join(',')}}'::integer[]`
const values = rows => rows.map(r => `  (${r.join(', ')})`).join(',\n')

export function toSql(data) {
  const { releases, meetings, lanes, items, matrix } = data
  const out = [
    '-- 官網內容第一期的種子資料：搬家前 site/public/roadmap.html 與 site/meetings.json 的全部內容。',
    '-- 由 site/tools/extract-roadmap-seed.mjs 從 site/tools/seed-source/ 的快照產生，不要手改；守門測試會比對。',
    '-- 用自然鍵 on conflict do nothing，重跑不會重複，也不會蓋掉之後在資料庫裡改過的內容。',
    `-- 筆數：發版 ${releases.length}、會議 ${meetings.length}、藍圖與待辦欄位 ${lanes.length}、項目 ${items.length}、總表欄 ${matrix.columns.length}、總表列 ${matrix.rows.length}、總表格 ${matrix.cells.length}`,
    'begin;',
    '',
    'insert into public.asn_site_releases (version, released_on, items, platforms, commit_sha, notes) values',
    values(releases.map(r => [q(r.version), q(r.date), textArr(r.items), textArr(r.platforms), q(r.commit), 'null'])),
    'on conflict (version) do nothing;',
    '',
    'insert into public.asn_site_meetings (held_at, attendees, progress, decisions, assignments, improvements) values',
    values(meetings.map(m => [q(`${m.time}+08`), textArr(m.attendees), textArr(m.progress), textArr(m.decisions), textArr(m.assignments), textArr(m.improvements)])),
    'on conflict (held_at) do nothing;',
    '',
    'insert into public.asn_site_lanes (section, lane, label, tone, sort_order) values',
    values(lanes.map(l => [q(l.section), q(l.key), q(l.label), q(l.tone), String(l.sort)])),
    'on conflict (section, lane) do nothing;',
    '',
    'insert into public.asn_site_roadmap_items (item_key, section, lane, title, body, refs, status, version, sort_order) values',
    values(items.map(i => [q(i.key), q(i.section), q(i.lane), q(i.title), q(i.body), intArr(i.refs), q(i.status), q(i.version), String(i.sort)])),
    'on conflict (item_key) do nothing;',
    '',
    'insert into public.asn_site_matrix_columns (column_key, label, sort_order) values',
    values(matrix.columns.map(c => [q(c.key), q(c.label), String(c.sort)])),
    'on conflict (column_key) do nothing;',
    '',
    'insert into public.asn_site_matrix_rows (row_key, name, kind, note, sort_order) values',
    values(matrix.rows.map(r => [q(r.key), q(r.name), q(r.kind), q(r.note), String(r.sort)])),
    'on conflict (row_key) do nothing;',
    '',
    'insert into public.asn_site_matrix_cells (row_key, column_key, status, body, refs) values',
    values(matrix.cells.map(c => [q(c.row), q(c.column), q(c.status), q(c.body), intArr(c.refs)])),
    'on conflict (row_key, column_key) do nothing;',
    '',
    'commit;',
    '',
  ]
  return out.join('\n')
}

export function generate() {
  return toSql(extract(fs.readFileSync(SOURCE_HTML, 'utf8'), fs.readFileSync(SOURCE_MEETINGS, 'utf8')))
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const sql = generate()
  fs.writeFileSync(OUTPUT_SQL, sql)
  console.log(sql.split('\n').find(l => l.startsWith('-- 筆數')))
  console.log(`已寫入 ${fileURLToPath(OUTPUT_SQL)}`)
}

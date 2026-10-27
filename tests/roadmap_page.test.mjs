// 官網「藍圖」（/roadmap）與「開發日誌」（/log）兩頁的守門測試：node --test --test-force-exit --test-timeout=120000 tests/roadmap_page.test.mjs
// 內容從 2026-10-27 起放在資料庫（public.asn_site_* 表），頁面只剩骨架＋外部腳本 site/public/timeline/。
// 這裡檢查：種子 SQL 與產生腳本一致、頁面沒有行內腳本、畫面程式不用 innerHTML、內容安全政策只對這兩頁放寬、公開內容沒有個資與金鑰、純邏輯正確。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { generate, extract, toMarkup, releaseFacts, SOURCE_HTML, SOURCE_MEETINGS } from '../site/tools/extract-roadmap-seed.mjs'
import * as M from '../site/public/timeline/model.mjs'
import { QUERIES } from '../site/public/timeline/data.mjs'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = p => fs.readFileSync(path.join(root, p), 'utf8').replace(/\r\n/g, '\n')   // Windows 工作樹是 CRLF，統一成 LF 再比對
const SEED = 'supabase/migrations/20261027100100_site_content_seed.sql'
const SCHEMA = 'supabase/migrations/20261027100000_site_content.sql'
const PAGES = ['site/public/roadmap.html', 'site/public/log.html']
const TIMELINE_DIR = 'site/public/timeline'
const timelineFiles = fs.readdirSync(path.join(root, TIMELINE_DIR)).filter(f => f.endsWith('.mjs')).map(f => `${TIMELINE_DIR}/${f}`)
const data = extract(fs.readFileSync(SOURCE_HTML, 'utf8'), fs.readFileSync(SOURCE_MEETINGS, 'utf8'))

// 公開內容守門：電子郵件、本機路徑、金鑰樣式
function assertPublicSafe(text, where) {
  assert.ok(!/[\w.+-]+@[\w-]+\.[\w.]+/.test(text), `${where}：不放電子郵件`)
  assert.ok(!/[A-Za-z]:\\|\/home\/|\/Users\/|~\/\./.test(text), `${where}：不放本機路徑`)
  assert.ok(!/eyJ[A-Za-z0-9_-]{20,}|sk-[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{20,}|service_role/.test(text), `${where}：不放金鑰`)
}

// ---- 種子資料 ----
test('種子 SQL 與產生腳本一致（改了快照或腳本要重跑 node site/tools/extract-roadmap-seed.mjs）', () => {
  assert.equal(read(SEED), generate().replace(/\r\n/g, '\n'))
})

test('種子筆數：發版 10、會議 8、欄位 6、項目 47、總表 6 欄 6 列 36 格', () => {
  assert.equal(data.releases.length, 10)
  assert.equal(data.meetings.length, 8)
  assert.equal(data.lanes.length, 6)
  assert.equal(data.items.length, 47)
  assert.equal(data.matrix.columns.length, 6)
  assert.equal(data.matrix.rows.length, 6)
  assert.equal(data.matrix.cells.length, 36)
  assert.match(read(SEED), /-- 筆數：發版 10、會議 8、藍圖與待辦欄位 6、項目 47、總表欄 6、總表列 6、總表格 36/)
})

test('快照裡的每一版、每一場會議、每一列總表都進了種子 SQL', () => {
  const sql = read(SEED)
  const html = read('site/tools/seed-source/roadmap.html')
  for (const m of html.matchAll(/<h3>(\d+\.\d+\.\d+)<span class="date">/g)) assert.ok(sql.includes(`('${m[1]}', `), `缺 ${m[1]}`)
  for (const m of JSON.parse(read('site/tools/seed-source/meetings.json'))) assert.ok(sql.includes(`'${m.time}+08'`), `缺 ${m.time} 會議`)
  for (const n of ['Claude', 'Codex', 'Gemini', 'Grok', 'pi']) assert.ok(data.matrix.rows.some(r => r.name === n), `缺 ${n}`)
  assert.deepEqual(data.matrix.columns.map(c => c.label), ['開啟', '關閉', '接手', '切換模型', '群組聊天', '帳號切換'])
})

test('種子內容不帶 HTML：只剩 **粗體**、`程式碼`、#編號 這種標記', () => {
  const texts = [
    ...data.releases.flatMap(r => r.items),
    ...data.items.flatMap(i => [i.title ?? '', i.body]),
    ...data.matrix.rows.map(r => r.note),
    ...data.matrix.cells.map(c => c.body),
    ...data.meetings.flatMap(m => [...m.attendees, ...m.progress, ...m.decisions, ...m.assignments, ...m.improvements]),
  ]
  for (const t of texts) assert.ok(!/<\/?[a-z][^>]*>|&(amp|lt|gt|quot);/i.test(t), `還有 HTML：${t.slice(0, 40)}`)
  assert.ok(data.items.some(i => i.body.includes('`tenants_sql`')), '<code> 要轉成 `…`')
  assert.ok(data.items.some(i => /\n- /.test(i.body)), '巢狀清單要轉成「- 」行')
})

test('總表：狀態只能是六種之一，「待確認」與「已完成未驗證」寫明原因', () => {
  for (const c of data.matrix.cells) {
    assert.ok(Object.keys(M.STATUS_LABEL).includes(c.status), c.status)
    if (c.status === 'tbc' || c.status === 'unv') assert.ok(c.body.length >= 12, `說明太短：${c.body}`)
  }
  const cell = (row, col) => data.matrix.cells.find(c => c.row === row && c.column === col)
  assert.equal(cell('codex', 'adopt').status, 'na')
  assert.equal(cell('codex', 'open').status, 'tbc')
  assert.equal(cell('grok-local', 'adopt').status, 'doing')
  assert.match(cell('grok-cloud', 'group').body, /舊版的雲端收信程式/)
  assert.deepEqual(cell('claude', 'adopt').refs, [82, 107, 109, 153])
})

test('發版：commit 與發佈位置從待辦與會議文字找，找不到就留空不猜', () => {
  const r = Object.fromEntries(data.releases.map(x => [x.version, x]))
  assert.equal(r['0.1.94'].commit, '76d7284')
  assert.deepEqual(r['0.1.92'].platforms, ['官網', '家用機', '工作機'])
  assert.equal(r['0.1.89'].commit, '6bb7400')
  assert.deepEqual(releaseFacts('9.9.9', '沒有這版'), { commit: null, platforms: [] })
})

test('轉換：不認得的標籤直接報錯，不默默吞掉', () => {
  assert.throws(() => toMarkup('<em>斜體</em>'), /不認得的標籤/)
  assert.deepEqual(toMarkup('<strong>A</strong>：b &amp; c<span class="refs">#1 #22</span>'), { text: '**A**：b & c', refs: [1, 22], tag: null })
})

test('公開內容守門：種子 SQL、快照、兩頁、畫面程式都沒有電子郵件、本機路徑、金鑰', () => {
  for (const f of [SEED, SCHEMA, 'site/tools/seed-source/roadmap.html', 'site/tools/seed-source/meetings.json', ...PAGES]) assertPublicSafe(read(f), f)
  for (const f of timelineFiles) assertPublicSafe(read(f), f)
})

// ---- 資料表與權限 ----
test('資料表：開 RLS、anon 只能讀，不給新增／修改／刪除', () => {
  const sql = read(SCHEMA)
  const tables = [...sql.matchAll(/create table if not exists public\.(asn_site_\w+)/g)].map(m => m[1])
  assert.deepEqual(tables.sort(), ['asn_site_lanes', 'asn_site_matrix_cells', 'asn_site_matrix_columns', 'asn_site_matrix_rows', 'asn_site_meetings', 'asn_site_releases', 'asn_site_roadmap_items'])
  const loop = /array\[([^\]]+)\]\s*loop/.exec(sql)[1]
  for (const t of tables) assert.ok(loop.includes(`'${t}'`), `${t} 沒套權限`)
  assert.match(sql, /enable row level security/)
  assert.match(sql, /revoke all on table public\.%I from public, anon, authenticated/)
  assert.match(sql, /grant select on table public\.%I to anon, authenticated/)
  assert.match(sql, /for select to anon, authenticated using \(true\)/)
  assert.doesNotMatch(sql, /grant (insert|update|delete|all)/i)
  assert.doesNotMatch(sql, /for (insert|update|delete|all)/i)
  // 前端讀的每張表都在 migration 裡
  for (const q of Object.values(QUERIES)) assert.ok(tables.includes(q.split('?')[0]), q)
})

// ---- 頁面與畫面程式 ----
test('兩頁：沒有行內腳本、行內樣式、行內事件；只載入站內的 timeline 腳本', () => {
  const want = { 'site/public/roadmap.html': '/timeline/roadmap.mjs', 'site/public/log.html': '/timeline/log.mjs' }
  for (const f of PAGES) {
    const html = read(f)
    const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)]
    assert.equal(scripts.length, 1, `${f} 只能有一個腳本`)
    assert.match(scripts[0][1], new RegExp(`type="module" src="${want[f]}"`))
    assert.equal(scripts[0][2].trim(), '', `${f} 不能有行內腳本`)
    assert.ok(!/<style/i.test(html) && !/\sstyle=/i.test(html), `${f} 有行內樣式`)
    assert.ok(!/\son[a-z]+=/i.test(html), `${f} 有行內事件`)
    assert.ok(!/(src|href)="https?:\/\//i.test(html), `${f} 有外部資源`)
  }
})

test('兩頁：讀取中與讀取失敗的提示是給人看的一句話，技術細節只進 console', () => {
  for (const f of ['site/public/timeline/roadmap.mjs', 'site/public/timeline/log.mjs']) {
    const js = read(f)
    assert.match(js, /暫時讀不到資料，請稍後重新整理/)
    assert.match(js, /console\.info\(/)
    assert.doesNotMatch(js, /showStatus\([^)]*\b(e|err|error)\b[.)]/, '錯誤物件不能顯示在畫面上')
  }
  assert.match(read('site/public/roadmap.html'), /id="timeline-status"[^>]*>讀取中…</)
  assert.match(read('site/public/log.html'), /id="log-status"[^>]*>讀取中…</)
})

test('畫面程式不用 innerHTML 這類把字串當 HTML 的寫法（靜態檢查 timeline/ 全部檔案）', () => {
  assert.ok(timelineFiles.length >= 5)
  for (const f of timelineFiles) {
    const js = read(f).split('\n').filter(l => !l.trim().startsWith('//')).join('\n')
    assert.doesNotMatch(js, /\.innerHTML|\.outerHTML|insertAdjacentHTML|document\.write|DOMParser|createContextualFragment|setHTMLUnsafe|\.srcdoc|\beval\(|new Function\(/, f)
  }
  const view = read('site/public/timeline/view.mjs')
  assert.match(view, /createTextNode|textContent/)
  assert.doesNotMatch(view, /setAttribute\(\s*['"]href/, 'href 只能經驗證後設定')
  assert.doesNotMatch(view, /'href'/, '屬性白名單不能有 href')
})

test('畫面程式：網址只連 GitHub 的議題頁，其他協定一律擋', () => {
  assert.equal(M.issueUrl(281), 'https://github.com/Yooliang/asn/issues/281')
  assert.equal(M.issueUrl(0), null)
  assert.equal(M.issueUrl('1'), null)
  assert.equal(M.safeHttpUrl('javascript:alert(1)'), null)
  assert.equal(M.safeHttpUrl('data:text/html,x'), null)
  assert.equal(M.safeHttpUrl('https://example.org/a'), 'https://example.org/a')
})

// ---- 內容安全政策（site/firebase.json）----
test('內容安全政策：只有 /roadmap、/log 放寬腳本與連線，其他頁維持全站的嚴格設定', () => {
  const fb = JSON.parse(read('site/firebase.json')).hosting
  const cspOf = h => h.headers.find(x => x.key === 'Content-Security-Policy')?.value
  const global = fb.headers.find(h => h.source === '**')
  assert.match(cspOf(global), /script-src 'none'/)
  const idxGlobal = fb.headers.indexOf(global)
  const ours = fb.headers.filter(h => /roadmap|log/.test(h.source))
  assert.equal(ours.length, 1, '只加一條')
  const o = ours[0]
  assert.equal(o.source, '/{roadmap,log}{,.html}')
  assert.ok(fb.headers.indexOf(o) > idxGlobal, '要排在全站設定之後才會蓋過')
  const csp = cspOf(o)
  assert.match(csp, /script-src 'self'(;|$)/)
  assert.match(csp, /connect-src https:\/\/etccgmkrosbzpltudlgt\.supabase\.co(;|$)/)
  for (const d of ["default-src 'self'", "style-src 'self'", "frame-ancestors 'none'", "base-uri 'self'", "form-action 'none'", "img-src 'self' data:"]) assert.ok(csp.includes(d), d)
  assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval|\*/)
  // 其他放寬 script-src 的只有原本就有的 /i/ 與 /link/
  const relaxed = fb.headers.filter(h => /script-src 'self'/.test(cspOf(h) ?? '')).map(h => h.source).sort()
  assert.deepEqual(relaxed, ['/i/**', '/link{,/**}', '/{roadmap,log}{,.html}'].sort())
})

test('資料來源：只連 Supabase 的 REST，金鑰沿用核准頁的公開設定，不另外抄一份', () => {
  const js = read('site/public/timeline/data.mjs')
  assert.match(js, /from '\.\.\/link\/config\.mjs'/)
  assert.doesNotMatch(js, /eyJ/)
  assert.match(js, /\/rest\/v1\//)
})

// ---- 純邏輯 ----
test('內文標記：粗體、程式碼、編號、子清單；其餘當純文字（含尖括號）', () => {
  assert.deepEqual(M.parseInline('**A**：用 `x<y>` 修 #12'), [
    { t: 'strong', v: 'A' }, { t: 'text', v: '：用 ' }, { t: 'code', v: 'x<y>' }, { t: 'text', v: ' 修 ' }, { t: 'ref', v: '#12' },
  ])
  assert.deepEqual(M.parseInline('<b>不是標籤</b>'), [{ t: 'text', v: '<b>不是標籤</b>' }])
  const b = M.parseBlocks('第一段\n- 甲\n- 乙\n第二段')
  assert.deepEqual(b.map(x => x.kind), ['p', 'ul', 'p'])
  assert.equal(b[1].items.length, 2)
})

test('版本排序用語意版本（0.1.9 < 0.1.10）', () => {
  assert.deepEqual(['0.1.10', '0.1.9', '0.2.0', '0.1.94'].sort(M.cmpVersion), ['0.1.9', '0.1.10', '0.1.94', '0.2.0'])
})

// 把種子資料轉成資料庫回傳的樣子
const rowsFromSeed = () => ({
  releases: data.releases.map(r => ({ version: r.version, released_on: r.date, items: r.items, platforms: r.platforms, commit_sha: r.commit, notes: null })),
  items: data.items.map(i => ({ item_key: i.key, section: i.section, lane: i.lane, title: i.title, body: i.body, refs: i.refs, status: i.status, version: i.version, sort_order: i.sort })),
  lanes: data.lanes.map(l => ({ section: l.section, lane: l.key, label: l.label, tone: l.tone, sort_order: l.sort })),
  meetings: data.meetings.map((m, i) => ({ id: i + 1, held_at: new Date(`${m.time.replace(' ', 'T')}:00+08:00`).toISOString(), ...m })),
})

test('藍圖時間軸：過去（舊到新）→ 現在 → 未來（預定版本、再來是未定版本）', () => {
  const d = rowsFromSeed()
  const tl = M.buildRoadmapTimeline(d.releases, d.items)
  assert.equal(tl.past[0].version, '0.1.68', '藍圖裡「已隨 0.1.68 發佈」的項目自成一個節點')
  assert.equal(tl.past[tl.past.length - 1].version, '0.1.94')
  assert.equal(tl.latest, '0.1.94')
  assert.equal(tl.earlier.length, 5)
  assert.equal(tl.now.length, 5)
  assert.deepEqual(tl.future.map(n => n.version), ['0.1.95'])
  assert.equal(tl.later.length, 8)
  // 已經發過的版本不能出現在未來
  const t2 = M.buildRoadmapTimeline(d.releases, [...d.items, { section: 'todo', lane: 'next', status: 'planned', version: '0.1.90', body: 'x', refs: [], sort_order: 1 }])
  assert.deepEqual(t2.future.map(n => n.version), ['0.1.95'])
})

test('開發日誌：會議與發版合成一條、最新在上；同一天的發版排在當天會議之上、多版依版本新到舊', () => {
  const d = rowsFromSeed()
  const log = M.buildLog(d.meetings, d.releases)
  assert.equal(log.length, 18)
  assert.deepEqual(log.slice(0, 11).map(e => e.kind), Array(10).fill('release').concat('meeting'))
  assert.equal(log[0].release.version, '0.1.94')
  assert.equal(log[9].release.version, '0.1.85')
  assert.equal(`${log[10].date} ${log[10].time}`, '2026-10-27 20:00', '會議時間以台北時間顯示')
  assert.equal(`${log[17].date} ${log[17].time}`, '2026-10-26 08:00')
})

test('待辦欄位與總表：依排序組好，缺的格子當「待確認」', () => {
  const d = rowsFromSeed()
  const lanes = M.buildLanes(d.lanes, d.items, 'todo')
  assert.deepEqual(lanes.map(l => l.label), ['一、需要負責人決定', '二、近期（依序）', '三、之後'])
  assert.deepEqual(lanes.map(l => l.items.length), [1, 20, 6])
  const m = M.buildMatrix([{ column_key: 'a', label: 'A', sort_order: 1 }], [{ row_key: 'x', name: 'X', kind: 'k', note: 'n', sort_order: 1 }], [])
  assert.equal(m.rows[0].cells[0].status, 'tbc')
})

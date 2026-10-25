// 官網「藍圖與更新日誌」頁（site/public/roadmap.html）的守門測試：node --test --test-force-exit --test-timeout=120000 tests/roadmap_page.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseChangelog, injectReleases, KEEP, parseMeetings, injectMeetings } from '../site/make-roadmap-page.mjs'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = p => fs.readFileSync(path.join(root, p), 'utf8').replace(/\r\n/g, '\n')   // Windows 工作樹是 CRLF，統一成 LF 再比對
const page = read('site/public/roadmap.html')
const changelog = read('relay/asn/CHANGELOG.md')

test('更新日誌區段與 relay/asn/CHANGELOG.md 一致（改了更新記錄要重跑 node site/make-roadmap-page.mjs）', () => {
  const releases = parseChangelog(changelog)
  assert.equal(releases.length, KEEP)
  assert.equal(injectReleases(page, releases), page)
  for (const r of releases) {
    assert.match(r.date, /^\d{4}-\d{2}-\d{2}$/)
    assert.ok(r.items.length >= 1, `${r.version} 沒有內容`)
    assert.ok(page.includes(`<h3>${r.version}<span class="date">${r.date}</span></h3>`), `${r.version} 不在頁面`)
  }
})

test('解析：略過格式不符的段落、跳脫 HTML、只取前 N 版', () => {
  const src = '# 標題\n\n## 0.2.0（2026-11-01）\n- a <b> & "c"\n- 第二行\n\n## 說明\n- 不算\n\n## 0.1.9（2026-10-31）\n- 舊版\n'
  const r = parseChangelog(src, 5)
  assert.deepEqual(r.map(x => x.version), ['0.2.0', '0.1.9'])
  assert.equal(r[0].items.length, 2)
  assert.equal(parseChangelog(src, 1).length, 1)
  const html = injectReleases('x<!-- changelog:start（由 site/make-roadmap-page.mjs 產生，不要手改） -->\nold\n<!-- changelog:end -->y', r)
  assert.ok(html.includes('a &lt;b&gt; &amp; &quot;c&quot;'))
  assert.ok(!html.includes('old'))
  assert.throws(() => injectReleases('沒有標記', r))
})

test('符合網站的內容安全政策：不能有行內樣式、行內腳本、外部資源', () => {
  assert.ok(!/<script/i.test(page))
  assert.ok(!/\sstyle=/i.test(page))
  assert.ok(!/\son[a-z]+=/i.test(page))
  assert.ok(!/(src|href)="https?:\/\//i.test(page))
  assert.ok(page.includes('<link rel="stylesheet" href="/style.css">'))
})

test('只放可以公開的內容：沒有電子郵件、本機路徑、金鑰樣式', () => {
  assert.ok(!/[\w.+-]+@[\w-]+\.[\w.]+/.test(page), '不放電子郵件')
  assert.ok(!/[A-Za-z]:\\|\/home\/|\/Users\/|~\/\./.test(page), '不放本機路徑')
  assert.ok(!/eyJ[A-Za-z0-9_-]{20,}|sk-[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{20,}|service_role/.test(page), '不放金鑰')
})

test('三欄藍圖都在，且每個頁面都連得到藍圖頁', () => {
  for (const s of ['status done">已完成', 'status doing">進行中', 'status plan">規劃中']) assert.ok(page.includes(s), s)
  for (const f of ['index', 'privacy', 'terms', 'roadmap']) {
    const html = read(`site/public/${f}.html`)
    assert.ok(html.includes('href="/roadmap"'), `${f}.html 缺藍圖連結`)
  }
})

test('頁內錨點都有對應 id，站內連結都指到存在的頁面', () => {
  const ids = new Set([...page.matchAll(/\sid="([^"]+)"/g)].map(m => m[1]))
  for (const m of page.matchAll(/href="#([^"]+)"/g)) assert.ok(ids.has(m[1]), `找不到 #${m[1]}`)
  for (const m of page.matchAll(/href="\/([^"#]*)"/g)) {
    const p = m[1]
    const ok = p === '' || p === 'style.css' || fs.existsSync(path.join(root, 'site/public', p + '.html')) || fs.existsSync(path.join(root, 'site/public', p))
    assert.ok(ok, `站內連結 /${p} 不存在`)
  }
})

// ---- 各家 AI 支援總表（#matrix）----
const matrix = (() => {
  const a = page.indexOf('<section id="matrix">')
  const b = page.indexOf('</section>', a)
  assert.ok(a >= 0 && b > a, '找不到 #matrix 區段')
  return page.slice(a, b)
})()
const STATUSES = ['已完成並驗證', '已完成未驗證', '進行中', '尚未做', '待確認', '不適用']
const matrixRows = [...matrix.matchAll(/<tr>\n([\s\S]*?)<\/tr>/g)].map(m => m[1])

test('總表：欄位必須有開啟、關閉、接手、切換模型、群組聊天，且每家都列齊', () => {
  const heads = [...matrix.matchAll(/<th scope="col">([^<]+)<\/th>/g)].map(m => m[1])
  for (const h of ['開啟', '關閉', '接手', '切換模型', '群組聊天', '帳號切換', '備註與限制']) assert.ok(heads.includes(h), `缺欄位：${h}`)
  assert.equal(heads[0], 'AI')
  const names = matrixRows.map(r => /<strong>([^<]+)<\/strong>/.exec(r)?.[1])
  for (const n of ['Claude', 'Codex', 'Gemini', 'Grok', 'pi']) assert.ok(names.includes(n), `缺 ${n}`)
  assert.ok(matrixRows.length >= 6)
})

test('總表：每一列每個功能欄都有狀態（只能是六種之一）與說明，備註欄不為空', () => {
  for (const row of matrixRows) {
    const tds = [...row.matchAll(/<td data-label="([^"]+)"([^>]*)>([\s\S]*?)<\/td>/g)]
    assert.equal(tds.length, 7, '每列 7 格')
    for (const [, label, attrs, inner] of tds) {
      if (label === '備註與限制') { assert.ok(inner.trim().length > 0); continue }
      const st = /<span class="st (st-[a-z]+)">([^<]+)<\/span>/.exec(inner)
      assert.ok(st, `${label} 缺狀態`)
      assert.ok(STATUSES.includes(st[2]), `未知狀態：${st[2]}`)
      assert.ok(/<p>[^<]{4,}/.test(inner), `${label} 缺說明`)
    }
  }
})

test('總表：圖例的六種狀態都在，且表格裡出現的樣式都有圖例；樣式有對應 CSS', () => {
  const css = read('site/public/style.css')
  for (const s of STATUSES) assert.ok(matrix.includes(`>${s}</span>`), `圖例缺 ${s}`)
  for (const cls of new Set([...matrix.matchAll(/class="st (st-[a-z]+)"/g)].map(m => m[1]))) assert.ok(css.includes(`.${cls} `), `style.css 缺 .${cls}`)
})

test('總表：「待確認」與「已完成未驗證」一定寫明原因（說明至少一句完整的話）', () => {
  for (const row of matrixRows) {
    for (const m of row.matchAll(/class="st st-(tbc|unv)">[^<]+<\/span>\s*<p>([^<]*)/g)) assert.ok(m[2].length >= 12, `說明太短：${m[2]}`)
  }
})

test('總表：不出現「收發室」，也不用行內樣式', () => {
  assert.ok(!matrix.includes('收發室'))
  assert.ok(!/\sstyle=/.test(matrix))
})

test('總表：藍圖頁上有這一區、窄螢幕有卡片版型（每格帶 data-label）', () => {
  assert.ok(page.includes('<section id="matrix">'), '總表區段在藍圖頁上（選單改成各頁共用，不再有頁內錨點）')
  const css = read('site/public/style.css')
  assert.match(css, /content: attr\(data-label\)/)
})

test('總表：版本說法與已發版本一致（0.1.68 已發，不再寫「未發版」；pi 收信 0.1.65～0.1.67 沒生效要寫明）', () => {
  const lastVersion = changelog.match(/^## (\d+\.\d+\.\d+)/m)[1]
  assert.ok(lastVersion, '讀不到最新版本')
  assert.doesNotMatch(matrix, /（未發版|已合併（|尚未隨版本發佈/, '已隨 0.1.68 發佈的項目不能再標未發版')
  assert.doesNotMatch(page, /<span class="tag">已合併，尚未隨版本發佈/, '藍圖頁已發版的項目不能再掛未發版標籤')
  const rowOf = name => matrixRows.find(r => r.includes(`<strong>${name}`))
  const pi = rowOf('pi')
  assert.match(pi, /0\.1\.69/, 'pi 接手欄要寫方案 A 隨 0.1.69 發佈')
  assert.ok(pi && /0\.1\.65～0\.1\.67/.test(pi) && /0\.1\.68/.test(pi), 'pi 列要寫明 0.1.65～0.1.67 收信沒生效、0.1.68 起修好')
  assert.match(rowOf('Codex'), /data-label="接手"[^>]*>\s*<span class="st st-na">/, 'Codex 接手是不適用')
  assert.match(rowOf('Codex'), /data-label="開啟"[^>]*>\s*<span class="st st-tbc">/, 'Codex 開啟是待確認')
  assert.match(matrixRows.find(r => r.includes('class="kind">本機背景工作者')), /data-label="接手"[^>]*>\s*<span class="st st-doing">/, 'Grok 本機接手是進行中（實測失敗過一次）')
  assert.match(matrixRows.find(r => r.includes('class="kind">雲端代理')), /舊版的雲端收信程式/, 'Grok 雲端群組要提醒舊收信程式要更新')
  assert.match(pi, /閒置/, 'pi 切換模型要寫明只在閒置時處理')
})

// ---- 會議記錄（#meetings，資料在 site/meetings.json）----
const MEET = (over = {}) => ({ time: '2026-10-26 08:00', attendees: '甲、乙', progress: ['進度一', '進度二'], decisions: '決議', assignments: '分派', improvements: '無', ...over })

test('會議記錄：頁面與 site/meetings.json 一致（改了資料檔要重跑 node site/make-roadmap-page.mjs）', () => {
  const rows = parseMeetings(JSON.parse(read('site/meetings.json')))
  assert.equal(injectMeetings(page, rows), page)
  for (const h of ['時間', '出席／回覆', '各項進度', '決議', '分派', '改善意見']) assert.ok(page.includes(`<th scope="col">${h}</th>`), h)
})

test('會議記錄：最新在上、陣列變條列、跳脫 HTML、缺欄位與壞時間會報錯', () => {
  const rows = parseMeetings([MEET({ time: '2026-10-25 20:00' }), MEET({ time: '2026-10-26 08:00', decisions: '<b>&' }), MEET({ time: '2026-10-26 08:00', attendees: '同時間後來的' })])
  assert.deepEqual(rows.map(r => r.time), ['2026-10-26 08:00', '2026-10-26 08:00', '2026-10-25 20:00'])
  assert.equal(rows[1].attendees[0], '同時間後來的', '同時間維持檔案先後')
  const html = injectMeetings('x<!-- meetings:start（由 site/make-roadmap-page.mjs 產生，不要手改；資料在 site/meetings.json） -->\nold\n<!-- meetings:end -->y', rows)
  assert.ok(html.includes('&lt;b&gt;&amp;') && !html.includes('old'))
  assert.ok(html.includes('<ul><li>進度一</li><li>進度二</li></ul>'))
  assert.throws(() => parseMeetings([MEET({ decisions: '' })]), /缺少「決議」/)
  assert.throws(() => parseMeetings([MEET({ time: '昨天' })]), /time 格式/)
  assert.throws(() => parseMeetings({}), /陣列/)
  assert.throws(() => injectMeetings('沒有標記', rows))
  assert.equal(parseMeetings([MEET({ time: '2026-10-26' })])[0].time, '2026-10-26', '時間可省略')
})

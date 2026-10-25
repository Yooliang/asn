// 官網「藍圖與更新日誌」頁（site/public/roadmap.html）的守門測試：node --test --test-force-exit --test-timeout=120000 tests/roadmap_page.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseChangelog, injectReleases, KEEP } from '../site/make-roadmap-page.mjs'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = p => fs.readFileSync(path.join(root, p), 'utf8')
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

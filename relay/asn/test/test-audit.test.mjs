import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { analyzeTest, auditDir, renderTable, summarize } from '../scripts/test-audit.mjs'

// 假的 ui 檔清單：分析函式不依賴真實檔案
const UI = new Set(['list.js', 'list.html', 'm.html', 'm.js', 'lib/settings-panel.mjs', 'lib/about-info.mjs', 'style.css'])
const run = (src, name = 'x.test.mjs') => analyzeTest(src, name, UI)

test('讀 ui 原始碼：各種寫法都解析成 ui/ 相對路徑', () => {
  const r = run(`
const read = p => fs.readFileSync(new URL(p, import.meta.url), 'utf8')
const a = read('../ui/lib/settings-panel.mjs')
const b = fs.readFileSync(new URL('../ui/list.js', import.meta.url), 'utf8')
const c = fs.readFileSync(path.join(root, 'ui', 'm.html'), 'utf8')
const d = fs.readFileSync(new URL('../src-tauri/src/lib.rs', import.meta.url), 'utf8')
assert.match(a, /x/)
`)
  assert.deepEqual(r.reads, ['ui/lib/settings-panel.mjs', 'ui/list.js', 'ui/m.html'])
  assert.deepEqual(r.fragile, ['ui/lib/settings-panel.mjs', 'ui/list.js', 'ui/m.html'].filter(x => x !== 'ui/list.js'))
})

test('ui 目錄 helper：無前綴字面值才算，沒有 helper 時不誤抓', () => {
  const withHelper = run("const read = f => fs.readFileSync(new URL(`../ui/${f}`, import.meta.url), 'utf8')\nconst h = read('list.html')\nassert.ok(h.includes('a'))")
  assert.deepEqual(withHelper.reads, ['ui/list.html'])
  const noHelper = run("assert.equal(name, 'list.html')\nassert.ok(x.includes('a'))")
  assert.deepEqual(noHelper.reads, [])
  assert.equal(noHelper.stringAsserts, 0)
})

test('import 與讀原始碼分開列', () => {
  const r = run(`
import { aboutInfo } from '../ui/lib/about-info.mjs'
import fs from 'node:fs'
assert.equal(aboutInfo(1), 1)
`)
  assert.deepEqual(r.imports, ['ui/lib/about-info.mjs'])
  assert.deepEqual(r.reads, [])
  assert.equal(r.class, 'A')
})

test('字串斷言計數（粗估）', () => {
  const r = run(`
const js = fs.readFileSync(new URL('../ui/m.js', import.meta.url), 'utf8')
assert.match(js, /a/)
assert.doesNotMatch(js, /b/)
assert.ok(js.includes('c'))
assert.ok(js.indexOf('d') > 0)
const parts = js.split('e')
const m = js.match(/f/)
`)
  assert.equal(r.stringAsserts, 6)
})

test('分類 A：純邏輯', () => {
  assert.equal(run("import { f } from '../ui/lib/about-info.mjs'\nassert.equal(f(), 1)").class, 'A')
})

test('分類 B：可渲染（含混合備註）', () => {
  const r = run(`
import { renderToString } from 'vue/server-renderer'
const js = fs.readFileSync(new URL('../ui/list.js', import.meta.url), 'utf8')
assert.match(js, /x/)
`)
  assert.equal(r.class, 'B')
  assert.ok(r.render)
  assert.ok(r.notes.some(n => n.includes('混合')))
})

test('分類 C：真瀏覽器', () => {
  const r = run("const p = spawnSync(process.execPath, ['scripts/smoke-ui.mjs'])\nconst c = 'Runtime.evaluate'")
  assert.equal(r.class, 'C')
  assert.ok(r.browser)
})

test('#1975 分類 C 看被起的腳本內容：起「只讀清單檔」的守門腳本不算真瀏覽器，起會開瀏覽器的腳本照樣抓到', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'asn-audit-scripts-'))
  try {
    fs.writeFileSync(path.join(dir, 'smoke-fake-gate.mjs'), "import fs from 'node:fs'\nconsole.log(fs.readdirSync('.'))\n")
    fs.writeFileSync(path.join(dir, 'smoke-fake-ui.mjs'), "import { findBrowser } from './smoke-lib.mjs'\nfindBrowser({})\n")
    const runIn = src => analyzeTest(src, 'x.test.mjs', UI, dir)
    // 原本誤判的寫法（檔名叫 smoke-*.mjs 就算瀏覽器）：現在不算
    const gate = runIn("const r = spawnSync(process.execPath, [path.join(root, 'scripts', 'smoke-fake-gate.mjs'), d])")
    assert.equal(gate.browser, false)
    assert.equal(gate.class, 'A')
    // 路徑先組成變數再傳也不受影響（判斷看腳本內容，不看寫法）
    assert.equal(runIn("const p = spawnSync(process.execPath, ['scripts/smoke-fake-gate.mjs'])").class, 'A')
    // 真的啟動瀏覽器的腳本：照樣抓到
    const ui = runIn("const r = spawnSync(process.execPath, [path.join(root, 'scripts', 'smoke-fake-ui.mjs')])")
    assert.equal(ui.browser, true)
    assert.equal(ui.class, 'C')
    // 一支測試同時起兩支：只要有一支會開瀏覽器就算
    assert.equal(runIn("spawnSync(x, ['smoke-fake-gate.mjs'])\nexecFileSync(x, ['smoke-fake-ui.mjs'])").class, 'C')
    // 讀不到腳本（打錯字、被搬走）：保守算會開瀏覽器，不能因為讀不到就漏抓
    assert.equal(runIn("spawnSync(x, ['scripts/smoke-not-there.mjs'])").class, 'C')
    // 寫在測試裡的瀏覽器關鍵字照舊
    assert.equal(runIn("const c = 'Page.navigate'").class, 'C')
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('#1975 真實的彙總守門腳本不算真瀏覽器、真實的 smoke-ui 算', () => {
  assert.equal(analyzeTest("spawnSync(process.execPath, [path.join(root, 'scripts', 'smoke-shard-gate.mjs')])", 'a.test.mjs', UI).class, 'A')
  assert.equal(analyzeTest("spawnSync(process.execPath, ['scripts/smoke-ui.mjs'])", 'b.test.mjs', UI).class, 'C')
})

test('分類 D：原始碼字串', () => {
  const r = run("const h = fs.readFileSync(new URL('../ui/style.css', import.meta.url), 'utf8')\nassert.match(h, /a/)")
  assert.equal(r.class, 'D')
  assert.equal(r.render, false)
})

test('讀了 ui 檔但沒有字串斷言 -> A 加備註', () => {
  const r = run("const h = fs.readFileSync(new URL('../ui/style.css', import.meta.url), 'utf8')\nassert.equal(h.length > 0, true)")
  assert.equal(r.class, 'A')
  assert.ok(r.notes.some(n => n.includes('無字串斷言')))
})

test('真實 test/ 目錄：不丟例外、數量合理、分類加總等於總數', () => {
  const rows = auditDir()
  const s = summarize(rows)
  assert.ok(rows.length >= 240, `找到 ${rows.length} 支`)
  assert.equal(s.byClass.A + s.byClass.B + s.byClass.C + s.byClass.D, s.total)
  assert.ok(s.readsUi > 0)
  const text = renderTable(rows)
  assert.match(text, /A 純邏輯 \d+／B 可渲染 \d+／C 真瀏覽器 \d+／D 原始碼字串 \d+/)
  // 自己這支不在清單裡：它的樣本裡有 Runtime.evaluate 等字，掃進去會被誤判成真瀏覽器測試
  assert.ok(!rows.some(r => r.file === 'test-audit.test.mjs'))
  assert.equal(s.byClass.C, 0, '目前 test/ 底下沒有直接開瀏覽器的測試（真瀏覽器的在 scripts/smoke-*.mjs）')
})

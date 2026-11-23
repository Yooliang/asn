// #2189：ASN 只有亮色外觀（aero／modern／line 都是亮色；手機也是亮色玻璃或淺色底），
// 沒有任何一種深色外觀。樣式若只看作業系統的 prefers-color-scheme:dark，Windows 開深色模式的人
// 就會在亮色視窗裡看到零星幾塊變暗（對話底部的 .typing-info／.typing-op 是最明顯的一條暗色帶）。
// 守門：ui 底下所有 CSS／程式裡的 prefers-color-scheme:dark，只准出現在允許清單，
// 或同一個區塊裡每條選擇器都帶 ASN 深色外觀的條件（:root[data-skin="dark"]）。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const UI = fileURLToPath(new URL('../ui/', import.meta.url))

// 允許清單：{ file: 檔名, selector: 選擇器, why: 原因 }。目前是空的：
// 三種外觀、電腦與手機都是亮色，沒有任何一條「只跟著系統深色走」的規則站得住腳。
// 之後若真的做了整頁一致變深的外觀，請改用 :root[data-skin="dark"] 當條件，不要加到這裡。
const ALLOW = []
const DARK_SKIN_GATE = /:root\[data-skin=["']?dark["']?\]/

const walk = dir => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
  if (e.name === 'vendor' || e.name === 'node_modules') return []
  const p = path.join(dir, e.name)
  return e.isDirectory() ? walk(p) : [p]
})
const files = walk(UI)
const rel = p => path.relative(UI, p).replace(/\\/g, '/')
const read = p => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n')

/** 抓出每個 @media (...prefers-color-scheme: dark...) { ... } 區塊（括號配對），回傳區塊內的所有選擇器 */
export function darkBlocks(css) {
  const out = []
  const re = /@media[^{]*prefers-color-scheme\s*:\s*dark[^{]*\{/g
  let m
  while ((m = re.exec(css))) {
    let depth = 1, i = re.lastIndex
    while (i < css.length && depth) { if (css[i] === '{') depth++; else if (css[i] === '}') depth--; i++ }
    const body = css.slice(re.lastIndex, i - 1)
    const selectors = []
    for (const r of body.matchAll(/([^{}]+)\{[^{}]*\}/g)) selectors.push(...r[1].split(',').map(s => s.trim()).filter(Boolean))
    out.push({ body, selectors })
  }
  return out
}

const allowed = (file, selector) => ALLOW.some(a => a.file === file && a.selector === selector && a.why)

test('ui 的 CSS：prefers-color-scheme:dark 只准在允許清單，或帶 ASN 深色外觀的條件', () => {
  const bad = []
  for (const f of files.filter(p => p.endsWith('.css'))) {
    for (const b of darkBlocks(read(f))) {
      for (const sel of b.selectors) if (!allowed(rel(f), sel) && !DARK_SKIN_GATE.test(sel)) bad.push(`${rel(f)}：${sel}`)
    }
  }
  assert.deepEqual(bad, [], '這些規則只看作業系統深色模式、ASN 沒有深色外觀：\n' + bad.join('\n'))
})

test('ui 的程式與頁面：不用 prefers-color-scheme 在執行時偷偷換色', () => {
  const hits = files.filter(p => /\.(mjs|js|html)$/.test(p)).filter(p => /prefers-color-scheme/.test(read(p))).map(rel)
  assert.deepEqual(hits, [])
})

test('守門剖析器本身：區塊括號配對、抓得到巢狀區塊裡的選擇器，不誤抓亮色規則', () => {
  const css = '.a{color:red}@media (prefers-color-scheme: dark){.b,.c{x:1}.d{y:2}}@media (forced-colors: active){.e{z:3}}'
  assert.deepEqual(darkBlocks(css).map(b => b.selectors), [['.b', '.c', '.d']])
})

test('底部那一行（.typing-info／.typing-op／警示）在亮色外觀下不會被系統深色模式改色', () => {
  const css = read(path.join(UI, 'style.css'))
  const darkSelectors = darkBlocks(css).flatMap(b => b.selectors)
  for (const cls of ['.typing-info', '.typing-op', '.typing-ask', '.typing-warn', '.typing-danger', '.typing.typing-op']) {
    assert.ok(!darkSelectors.some(s => s.includes(cls)), cls + ' 不該出現在深色模式區塊')
  }
  // 亮色那一套還在（沒有一併拿掉）
  assert.match(css, /\.typing-info\{background:#e8f0fe;color:#1a3d7c\}/)
  assert.match(css, /\.typing\.typing-op\{[^}]*background:var\(--panel-head\)/)
  assert.match(css, /\.typing-op\.is-failed\{background:var\(--warn-bg\)/)
  assert.match(css, /\.typing-op\.is-done\{background:var\(--panel-soft\)\}/)
})

test('smoke：ASN_SMOKE_DARK=1 才模擬系統深色，預設不開（驗收 #2189 用）', async () => {
  const { motionMedia } = await import('../scripts/smoke-lib.mjs')
  const names = env => motionMedia({}, env).features.map(f => f.name + '=' + f.value)
  assert.deepEqual(names({}), ['prefers-reduced-motion=no-preference'])
  assert.deepEqual(names({ ASN_SMOKE_DARK: '1' }), ['prefers-reduced-motion=no-preference', 'prefers-color-scheme=dark'])
})

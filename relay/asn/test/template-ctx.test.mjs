// 樣板裡用到的名字，都要出現在 setup 的 return 裡（#359：dlgRow 漏導出，畫面上靜默變成空白，樣板編譯測試抓不到）
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { compile } = require('@vue/compiler-dom')
const read = p => readFileSync(new URL(`../ui/${p}`, import.meta.url), 'utf8')

test('list.html 用到的名字都有從 setup 回傳', () => {
  const html = read('list.html'), js = read('list.js')
  const m = html.match(/<div id="app"[^>]*>([\s\S]*)<\/div>\s*<script/)
  const { code } = compile(m[1], { prefixIdentifiers: true, mode: 'function', onError: () => {} })
  const used = new Set([...code.matchAll(/_ctx\.([A-Za-z_$][\w$]*)/g)].map(x => x[1]))
  const start = js.indexOf('const app = createApp({')
  assert.ok(start > 0, '找得到 createApp')
  const ret = js.slice(js.indexOf('return {', start))
  const returned = new Set(ret.match(/[A-Za-z_$][\w$]*/g))
  const missing = [...used].filter(n => !returned.has(n) && !n.startsWith('$'))
  assert.deepEqual(missing, [], `樣板用到但沒回傳：${missing.join('、')}`)
})

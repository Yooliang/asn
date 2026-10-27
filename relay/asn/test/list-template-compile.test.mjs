// list.html 的樣板能被 Vue 編譯（寫錯標籤、v-if/v-for 同層之類的錯，執行時整個名單視窗會空白，所以先在這裡擋）
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { compile } = require('@vue/compiler-dom')

test('list.html 樣板編譯沒有錯誤', () => {
  const html = readFileSync(new URL('../ui/list.html', import.meta.url), 'utf8')
  const m = html.match(/<div id="app"[^>]*>([\s\S]*)<\/div>\s*<script/)
  assert.ok(m, '找得到 #app 樣板')
  const errs = []
  compile(m[1], { onError: e => errs.push(`${e.message} @${e.loc?.start.line ?? '?'}`) })
  assert.deepEqual(errs, [])
})

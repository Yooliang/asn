// 守門：手機頁面（m.html）的 Vue 樣板能編譯、沒有掛載上的陷阱。
// 這類錯誤在真機上的樣子是「畫面露出 {{ }} 原文」，電腦上看不出來，所以在這裡用 Vue 的編譯器真的編一次。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(path.join(root, 'package.json'))
const { compile } = require('@vue/compiler-dom')
const html = fs.readFileSync(path.join(root, 'ui', 'm.html'), 'utf8').replace(/\r\n/g, '\n')
const m = /<div id="app"([^>]*)>([\s\S]*)<\/div>\s*<script src="vendor\//.exec(html)

test('m.html：#app 的內容能被 Vue 編譯，沒有任何編譯錯誤', () => {
  assert.ok(m, '找不到 #app 根元素或它後面的 vue 腳本')
  const errs = []
  compile(m[2], { onError: e => errs.push(`${e.message} @${e.loc?.start?.line}:${e.loc?.start?.column}`) })
  assert.deepEqual(errs, [])
})

test('m.html：根元素 #app 自己的屬性不含 Vue 指令（只有內容會被編譯；根元素的 :class、v-if 都不會生效）', () => {
  const attrs = m[1]
  assert.match(attrs, /v-cloak/, '掛載前要用 v-cloak 藏起來')
  assert.doesNotMatch(attrs, /[:@]|v-(if|show|bind|on)/, `#app 屬性：${attrs.trim()}`)
})

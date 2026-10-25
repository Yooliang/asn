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

test('m.html：樣板用到的 setup 變數都有放進 return（漏回傳＝真機一開就白屏，電腦看不出來）', () => {
  const js = fs.readFileSync(path.join(root, 'ui', 'm.js'), 'utf8').replace(/\r\n/g, '\n')
  const ret = /\n    return \{([\s\S]*?)\n    \}\n  \},/.exec(js)
  assert.ok(ret, '找不到 setup 的 return 區塊')
  const returned = new Set(ret[1].match(/[A-Za-z_$][\w$]*/g))
  const declared = new Set()
  for (const x of js.matchAll(/^    (?:const|let|async function|function) ([A-Za-z_$][\w$]*)/gm)) declared.add(x[1])
  for (const x of js.matchAll(/^    (?:const|let) [^\n=]*?= [^\n]*?, ([A-Za-z_$][\w$]*) = /gm)) declared.add(x[1])
  const exprs = [...m[2].matchAll(/\{\{([\s\S]*?)\}\}/g)].map(x => x[1])
  for (const a of m[2].matchAll(/\s(?:v-[\w:.-]+|:[\w.-]+|@[\w.:-]+)="([^"]*)"/g)) exprs.push(a[1])
  const used = new Set()
  for (const e of exprs) for (const t of e.replace(/'[^']*'/g, '').matchAll(/(?<![.\w$])[A-Za-z_$][\w$]*/g)) used.add(t[0])
  const local = new Set()   // v-for 自己宣告的別名不算
  for (const f of m[2].matchAll(/v-for="\(?([^)"]*?)\)? (?:in|of) /g)) for (const t of f[1].matchAll(/[A-Za-z_$][\w$]*/g)) local.add(t[0])
  const missing = [...used].filter(n => declared.has(n) && !returned.has(n) && !local.has(n))
  assert.deepEqual(missing, [], `樣板用到卻沒回傳：${missing.join('、')}`)
})

test('m.html：開新夥伴第 1 頁只有電腦與「下一步」，第 2 頁才有模型、工作資料夾、名字、第一句話與開啟（模型清單依電腦而定）', () => {
  const a = html.indexOf(`v-if="lch.phase === 'form' && !lchStep2"`)
  const b = html.indexOf(`v-else-if="lch.phase === 'form'"`, a)
  const c = html.indexOf('<template v-else>', b)
  assert.ok(a > 0 && b > a && c > b, '找不到兩頁的樣板')
  const p1 = html.slice(a, b), p2 = html.slice(b, c)
  assert.match(p1, /<legend>電腦<\/legend>/); assert.match(p1, /nextLaunch/)
  for (const t of ['<legend>模型</legend>', '工作資料夾', '名字', 'submitLaunch']) assert.ok(!p1.includes(t), `第 1 頁不該有 ${t}`)
  for (const t of ['<legend>模型</legend>', '工作資料夾', '名字', '第一句話', 'submitLaunch']) assert.ok(p2.includes(t), `第 2 頁要有 ${t}`)
  assert.ok(!p2.includes('<legend>電腦</legend>'), '第 2 頁不再選電腦')
})

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
  assert.match(p1, /<legend>設備<\/legend>/); assert.match(p1, /nextLaunch/)
  for (const t of ['<legend>廠牌</legend>', '工作資料夾', '名字', 'submitLaunch']) assert.ok(!p1.includes(t), `第 1 頁不該有 ${t}`)
  for (const t of ['<legend>廠牌</legend>', '工作資料夾', '名字', '第一句話', 'submitLaunch']) assert.ok(p2.includes(t), `第 2 頁要有 ${t}`)
  assert.ok(!p2.includes('<legend>模型</legend>'), '選的是廠牌，標題不能寫「模型」（型號清單是另一件事）')
  // 欄位順序跟電腦版第 3 頁一樣：名字 → 工作資料夾 → 第一句話
  const at = t => p2.indexOf(t)
  assert.ok(at('class="m-field">名字') > 0 && at('class="m-field">名字') < at('class="m-field">工作資料夾') && at('class="m-field">工作資料夾') < at('class="m-field">第一句話'), '手機欄位順序：名字、工作資料夾、第一句話')
  assert.ok(!p2.includes('<legend>設備</legend>'), '第 2 頁不再選設備')
})

test('m.html：設定分頁只列分類（每列一行摘要）加使用指引；各項設定（含登出）都在分類頁裡', () => {
  const a = html.indexOf('<section class="m-pg" aria-label="設定">')
  const b = html.indexOf('<div class="m-pgin m-set"', a)   // #461：分類頁是內頁
  assert.ok(a > 0 && b > a, '找不到設定分頁或分類頁')
  const list = html.slice(a, b)
  assert.match(list, /v-for="r in settingRows"/); assert.match(list, /openSetting\(r\.key\)/); assert.match(list, /r\.summary/)
  assert.match(list, /openGuides/)
  for (const t of ['nameDraft', 'prefs.vibrateNudge', 'checkUpdate', 'avFile', 'goDeviceRename', 'doLogout', 'm-logout']) assert.ok(!list.includes(t), `列表頁不該直接放 ${t}`)
  const c = html.indexOf('</section>', b)
  const detail = html.slice(b, c)
  for (const [cat, needles] of [['me', ['nameDraft', 'avFile', 'doLogout']], ['notify', ['prefs.vibrateNudge', 'prefs.vibrateMsg']], ['update', ['prefs.autoUpdate', 'checkUpdate']], ['about', ['info.version']]]) {
    assert.ok(detail.includes(`settingCat === '${cat}'`), `缺 ${cat} 分類頁`)
    for (const n of needles) assert.ok(detail.includes(n), `${cat} 分類頁缺 ${n}`)
  }
})

test('mobile.css：「⋯」選單每一列不能被壓縮（直向 flex 加 overflow 時，列會縮到比內容矮，說明文字就疊在別列上）', () => {
  const css = fs.readFileSync(new URL('../ui/mobile.css', import.meta.url), 'utf8')
  assert.match(css, /\.m-ops-item\{[^}]*flex:none/)
})

test('開新夥伴畫面：只選廠牌，沒有「運行」（電腦版對話框與手機第 2 頁，#2354；原本的運行四選一 D1 #421 拿掉了）', () => {
  const list = fs.readFileSync(path.join(root, 'ui', 'list.html'), 'utf8').replace(/\r\n/g, '\n')
  const d = list.slice(list.indexOf('id="partner-dlg-title"'), list.indexOf('<!-- 終端：等你回答的提示框'))
  assert.ok(d.length > 500, '截到對話框範圍')
  // 反向：畫面上不再有運行的任何東西（原本這裡是「運行存在」的正向斷言）
  for (const gone of ['<legend>運行</legend>', 'partner-run', 'partnerRun', 'partnerRunChoice', 'partnerRunModel', 'name="partner-run"', '運行']) assert.ok(!d.includes(gone), `電腦版對話框不該再有 ${gone}`)
  assert.ok(d.includes('aria-label="模型"') && d.includes('v-for="m in dlgVendors"') && d.includes('m.badge.text') && d.includes(':disabled="m.disabled"'), '電腦版：廠牌卡、右邊的短標示、反灰不能選')
  const p2s = html.indexOf(`<template v-else-if="lch.phase === 'form'">`)
  const p2 = html.slice(p2s, html.indexOf('<p class="m-prog"', p2s))
  assert.ok(p2.length > 500, '截到手機第 2 頁範圍')
  for (const gone of ['<legend>運行</legend>', 'lchRun', 'lchRunKey', 'lch.run', 'm-lch-display', 'LAUNCH_DISPLAY_NOTE', 'showDisplayNote', '運行']) assert.ok(!p2.includes(gone), `手機第 2 頁不該再有 ${gone}`)
  assert.ok(p2.includes('<legend>廠牌</legend>') && p2.includes('v-for="m in lchVendors"') && p2.includes('m.badge.text') && p2.includes(':disabled="m.disabled"'), '手機：廠牌卡、右邊的短標示、尚未安裝反灰不能選')
  assert.ok(p2.includes(`m.badge.kind === 'loggedOut'`) && d.includes(`m.badge.kind === 'loggedOut'`), '尚未登入的字樣有自己的樣式（跟反灰的尚未安裝分開）')
  assert.ok(p2.includes('v-model="lch.piModel"') && p2.includes(`lchAuto.run === 'pi'`), '手機：只能經 pi 的廠牌才有型號下拉')
  assert.ok(p2.includes(`'開始'`) && !p2.includes(`'開啟'`), '送出鈕寫「開始」')
})

test('m.html：「最後一個自行安裝版」提示只掛在 sideloadLast（自行安裝版才有字），沒有關閉鈕', () => {
  const i = html.indexOf('class="m-upd m-upd-last"')
  assert.ok(i > 0, '找不到提示')
  const tag = html.slice(html.lastIndexOf('<div', i), html.indexOf('</div>', i))
  assert.match(tag, /v-if="sideloadLast"/)
  assert.ok(!tag.includes('<button'), '常駐，不給關')
})

test('守門：分頁名統一叫「設定」（0.2.18）——畫面、提示字與 Rust 的提示都不再寫「設置」', () => {
  const root = new URL('../', import.meta.url)
  const walk = dir => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => (e.isDirectory() ? (e.name === 'vendor' ? [] : walk(new URL(e.name + '/', dir))) : [new URL(e.name, dir)]))
  const files = [...walk(new URL('ui/', root)), ...walk(new URL('src-tauri/src/', root))].filter(u => /\.(m?js|html|css|rs)$/.test(u.pathname))
  assert.ok(files.length > 50)
  const bad = files.filter(u => fs.readFileSync(u, 'utf8').includes('設置')).map(u => u.pathname.split('/relay/asn/')[1])
  assert.deepEqual(bad, [])
})

// 守門：群組畫面的 Vue 樣板能編譯；附件鈕只在 attachOk 時出現（外部成員的群組沒有附件鈕）；
// 畫面（樣板）不顯示成員鍵、x: 代號、節點代號；電腦與手機的入口都在（群組分組永遠顯示、建立群組、加入群組、邀請）；簽章動作只走 relay_group。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(path.join(root, 'package.json'))
const { compile } = require('@vue/compiler-dom')
const read = (...p) => fs.readFileSync(path.join(root, ...p), 'utf8').replace(/\r\n/g, '\n')
const templateOf = src => /template: `([\s\S]*?)`,?\n?\}/.exec(src)?.[1]
const compiles = (tpl, name) => {
  const errs = []
  compile(tpl, { onError: e => errs.push(`${e.message} @${e.loc?.start?.line}:${e.loc?.start?.column}`) })
  assert.deepEqual(errs, [], name)
}

const sheet = read('ui', 'lib', 'group-sheet.mjs')
const chatpane = read('ui', 'lib', 'chatpane.mjs')

test('群組對話框與確認卡片的樣板能編譯', () => {
  const tpls = [...sheet.matchAll(/template: `([\s\S]*?)`,/g)].map(m => m[1])
  assert.equal(tpls.length, 2, '建立／邀請／加入／管理，和確認卡片')
  tpls.forEach((t, i) => compiles(t, `group-sheet 樣板 ${i}`))
  compiles(templateOf(chatpane), 'chatpane 樣板')
})

test('電腦版 list.html、chat.html 與手機版 m.html 能編譯', () => {
  for (const f of ['list.html', 'chat.html', 'm.html']) {
    const html = read('ui', f)
    const m = /<div id="app"[^>]*>([\s\S]*)<\/div>\s*<script src="vendor\//.exec(html)
    assert.ok(m, f)
    compiles(m[1], f)
    assert.match(html, /href="group\.css"/, `${f} 要載入 group.css`)
  }
})

test('附件鈕：照片、檔案、截圖都要 attachOk 才出現；群組不顯示震動與通話；外部成員的群組沒有附件鈕', () => {
  const tpl = templateOf(chatpane)
  for (const re of [/<button[^>]*v-if="attachOk"[^>]*@click="fileEl/, /<button[^>]*v-if="attachOk"[^>]*@click="docEl/, /<template v-if="attachOk"><button[^>]*v-if="shotApi && shotOk"[^>]*aria-label="截圖"/]) assert.match(tpl, re)
  assert.match(tpl, /<button[^>]*v-if="!isRoom"[^>]*@click="nudge"/)
  assert.match(chatpane, /roomAttachAllowed\(props\.friend\)/)
  assert.match(tpl, /<confirm-cards v-if="isRoom"/, '群組對話上方有確認卡片')
})

test('畫面不顯示成員鍵與代號：樣板的插值裡沒有 key／ref／member／node（邀請碼 code 是給人貼的，可以顯示）', () => {
  const tpls = [...sheet.matchAll(/template: `([\s\S]*?)`,/g)].map(m => m[1]).join('\n') + templateOf(chatpane)
  const shown = [...tpls.matchAll(/\{\{([\s\S]*?)\}\}/g)].map(m => m[1])
  for (const expr of shown) assert.doesNotMatch(expr, /\b(?:m|a|c|x|s)\.(?:key|ref|member|node|agent)\b/, expr)
  // 成員清單用 label 顯示，key／ref 只拿來當 :key 與呼叫參數
  assert.match(sheet, /\{\{ m\.label \}\}/)
})

test('入口：手機群組分組永遠顯示並有建立／加入；電腦群組分頁可點進對話；對話標頭有邀請', () => {
  const m = read('ui', 'm.html')
  // 手機：建立／加入在右上角「＋」選單；群組對話分組在各設備分組之前，沒有群組就整組不顯示（不放空提示列）
  assert.match(m, /<div class="m-group m-rooms" v-if="roomRows\.length">/)
  assert.ok(m.indexOf('m-group m-rooms') < m.indexOf('v-for="g in groups"'), '群組對話排在設備分組之前')
  assert.doesNotMatch(m, /m-rooms-actions|m-rooms-empty/, '名單裡不再有建立／加入按鈕與空提示')
  const plus = m.slice(m.indexOf('m-plus-wrap'), m.indexOf('</header>'))
  assert.match(plus, /pickPlus\('create'\)/); assert.match(plus, /pickPlus\('join'\)/); assert.match(plus, /pickPlus\('launch'\)/)
  assert.match(plus, /建立群組/); assert.match(plus, /加入群組／貼邀請碼/); assert.match(plus, /開新夥伴/)
  assert.match(read('ui', 'm.js'), /pickPlus = op => \{[^}]*groupFlow\.openCreate\(\)[^}]*groupFlow\.openJoin\(\)[^}]*openLaunch\(''\)/)
  // 本人資訊列：第一行帳號名稱、第二行「狀態・設備名稱」
  assert.match(m, /<div class="m-title">\{\{ myName \}\}<\/div>/)
  assert.match(m, /STATUS\[me\.status\] : CONN_LABEL\[conn\] \}\}<template v-if="conn === 'on' && me\.nick">・\{\{ me\.nick \}\}<\/template>/)
  assert.match(m, /<group-sheet :flow="groupFlow">/)
  assert.match(m, /v-if="opsItems\.length \|\| groupItems\.length"/, '一對一與群組對話的「⋯」')
  const l = read('ui', 'list.html')
  assert.match(l, /@click="openChat\(r\.chatId\)"/); assert.match(l, /groupFlow\.openCreate\(\)/); assert.match(l, /groupFlow\.openJoin\(\)/)
  assert.match(l, /@group-menu="op => openGroupMenu\(t\.id, op\)"/); assert.match(l, /<group-sheet :flow="groupFlow">/)
  const mj = read('ui', 'm.js'); const lj = read('ui', 'list.js')
  assert.match(mj, /'邀請別人加入'/); assert.match(sheet + chatpane, /邀請別人加入/)
  assert.match(lj, /listen\('asn:invite'/); assert.match(mj, /listen\('asn:invite'/)
})

test('簽章動作只走 relay_group／帶簽章的讀寫指令；Rust 端指令都有註冊', () => {
  const lib = read('src-tauri', 'src', 'lib.rs')
  for (const cmd of ['relay_group', 'relay_room_read', 'relay_room_post', 'invite_pending']) assert.match(lib, new RegExp(`\\b${cmd}\\b`))
  const handler = lib.match(/generate_handler!\[([\s\S]*?)\]\);/g) ?? []
  assert.equal(handler.length, 2)
  assert.ok(handler.every(h => /\brelay_group\b/.test(h) && /\binvite_pending\b/.test(h)), '電腦與手機的指令清單都要有')
  const ui = ['list.js', 'm.js'].map(f => read('ui', f)).join('\n') + read('ui', 'lib', 'room-hub.mjs') + read('ui', 'lib', 'group-flow.mjs')
  assert.doesNotMatch(ui, /invoke\('relay_group'/, 'relay_group 只在 groups.mjs 的包裝裡呼叫一次')
  assert.equal((read('ui', 'lib', 'groups.mjs').match(/invoke\('relay_group'/g) ?? []).length, 1)
})

test('頁面腳本語法正確（list.js、m.js、chat.js 與群組模組）：語法錯誤在真機上的樣子是整頁沒掛載、露出 {{ }} 原文', () => {
  const { transformSync } = require('esbuild')
  for (const f of ['ui/list.js', 'ui/m.js', 'ui/chat.js', 'ui/lib/chatpane.mjs', 'ui/lib/groups.mjs', 'ui/lib/group-flow.mjs', 'ui/lib/group-sheet.mjs', 'ui/lib/room-hub.mjs', 'ui/lib/mobile-rooms.mjs']) {
    assert.doesNotThrow(() => transformSync(read(...f.split('/')), { loader: 'js', format: 'esm', target: 'esnext' }), f)
  }
})

test('加我的另一個 AI 入口＋群組附件放行：選單項目、聚焦區塊、旗標不再整個群組禁用', () => {
  assert.match(read('ui', 'lib', 'actionbar.mjs'), /key: 'addai', label: '加我的另一個 AI'/)
  assert.match(read('ui', 'list.js'), /what === 'addai'\) groupFlow\.openManage\(rid, \{ focusAdd: true \}\)/)
  assert.match(read('ui', 'm.js'), /key: 'addai', label: '加我的另一個 AI'/); assert.match(read('ui', 'm.js'), /key === 'addai' && f\.room\) groupFlow\.openManage/)
  assert.match(read('ui', 'lib', 'group-sheet.mjs'), /<h3 class="gs-h"[^>]*>加我的另一個 AI<\/h3>/)
  assert.doesNotMatch(read('ui', 'lib', 'mobile-rooms.mjs'), /attachments: false/, '假夥伴不再寫死 attachments:false（只有 external 才隱藏附件鈕）')
  assert.match(read('ui', 'list.js'), /hub\.postAttachment\(roomIdOf\(id\), item, caption\)/); assert.match(read('ui', 'm.js'), /hub\.postAttachment\(roomIdOf\(id\), item, caption\)/)
})

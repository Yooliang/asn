// 群組訊息版面（10-24）：我自己的發言也有頭像；AI 標籤貼在頭像下方；回覆鈕與叫醒順序同一列、平常隱藏，滑過／鍵盤聚焦／手機點訊息才出現。
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
const chatpane = read('ui', 'lib', 'chatpane.mjs')
const tpl = /template: `([\s\S]*?)`,?\n?\}/.exec(chatpane)[1]
const css = read('ui', 'group.css')
const line = cls => (tpl.split('\n').find(l => l.includes(`class="${cls}`)) ?? '')

test('樣板能編譯', () => {
  const errs = []
  compile(tpl, { onError: e => errs.push(e.message) })
  assert.deepEqual(errs, [])
})

test('我自己的發言：群組裡也畫頭像（用登入者的大頭貼），個人聊天維持不畫', () => {
  const l = line('m-av m-av-spk m-av-me')
  assert.match(l, /v-if="isRoom && m\.k === 'me'"/)
  assert.match(l, /<img :src="meAv" alt="">/)
  // 個人聊天那一顆與對方頭像的條件不變
  assert.match(tpl, /v-if="lay\(m\.k\)\.avatar && !m\.badge && !m\.av"/)
})

// 10-25 改動：頭像下方的「AI」小標籤換成頭像右下角的廠商小圖（有廠商圖的就是 AI），所以原本對 av-tag 的斷言改成對 spk-vendor；名字行的規則不變
test('AI 發言者：廠商小圖在頭像欄裡（頭像之後），名字那行不再塞 AI；沒有頭像時才退回名字旁', () => {
  const av = line('m-av m-av-spk"')
  assert.match(av, /<span class="spk-vendor" v-if="m\.kind === 'ai'"/)
  assert.ok(av.indexOf('class="dp xs"') < av.indexOf('class="spk-vendor"'), '小圖在頭像之後')
  assert.ok(!av.includes('av-tag'), '不再有 AI 小標籤')
  assert.match(tpl, /<span class="who-badge" :class="'is-' \+ m\.kind" v-if="m\.badge && !\(m\.kind === 'ai' && m\.av\)">/)
  assert.match(css, /\.m-av-spk\{[^}]*flex-direction:column/)
  assert.match(css, /\.spk-vendor\{[^}]*width:14px/)
})

test('回覆鈕與叫醒順序同一列，在內文下方；名字那行不再有回覆鈕', () => {
  const who = line('who')
  assert.ok(!who.includes('reply-btn'), '名字行沒有回覆鈕')
  const i = tpl.indexOf('class="m-act"')
  assert.ok(i > tpl.indexOf('class="m-body"'), '操作列在內文下方')
  const row = tpl.slice(i, tpl.indexOf('class="call-end-note"'))
  assert.ok(row.indexOf('class="wake-tags"') > 0 && row.indexOf('class="reply-btn"') >= 0 && row.indexOf('class="reply-btn"') < row.indexOf('class="wake-tags"'), '回覆鈕在最前面，順序標籤接在後面，同一列')
  assert.match(tpl, /class="m-act" v-if="canReply\(m\) \|\| \(m\.wake && m\.wake\.length\)"/)
})

test('樣式：操作列平常隱藏，滑過／鍵盤聚焦才出現；手機點訊息（act-on）才出現；深色模式的廠商小圖可讀', () => {
  assert.match(css, /\.m-act\{[^}]*opacity:0/)
  assert.match(css, /\.msg:hover \.m-act,\.msg:focus-within \.m-act\{[^}]*opacity:1/)
  assert.match(css, /@media \(hover:none\)\{[^@]*\.msg\.act-on \.m-act\{[^}]*opacity:1/)
  assert.ok(!/\.reply-btn\{[^}]*opacity:0/.test(css), '回覆鈕自己不再各自隱藏，由整列控制')
  assert.match(css, /\.spk-vendor\{[^}]*background:#fff/, '白底小方塊，淺色深色都清楚')
})

test('手機點訊息切換操作列：連結、按鈕、引用不算', () => {
  assert.match(tpl, /class="msg" :data-i="i" :class="\[[^\n]*'act-on': actAt === i/)
  assert.match(tpl, /@click="tapMsg\(i, \$event\)"/)
  assert.match(chatpane, /function tapMsg\(i, e\)[\s\S]*?closest\?\.\('a,button/)
})

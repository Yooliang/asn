// #1647：看別台終端按送出後，對方允許前保留原本的畫面、疊「等那台電腦回應」；不允許或逾時自動回到只能看、寫明原因、字放回輸入框；提示字寫清楚要權限
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { composeRemoteHint, composeTermHint } from '../ui/lib/compose.mjs'
import { INPUT_TEXT } from '../ui/lib/term-remote-input.mjs'

const read = p => fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n')
const pane = read('ui/lib/chatpane.mjs'), input = read('ui/lib/term-remote-input.mjs'), css = read('ui/style.css')

test('提示字：還沒開始打字寫「送出會向那台電腦要打字權限」；沒給名字用通用說法；已在打字的提示不變', () => {
  assert.equal(composeRemoteHint('小乙'), '送出會向那台電腦要打字權限（小乙 的終端）')
  assert.match(composeRemoteHint(''), /^送出會向那台電腦要打字權限（這位夥伴 /)
  assert.equal(composeTermHint('小乙'), '輸入的字會直接打進 小乙 的終端')
})

test('等待與拒絕的字：等待那行、沒開始的原因（有原因照寫，沒有就說字已放回）', () => {
  assert.equal(INPUT_TEXT.waitReply, '等那台電腦回應')
  assert.equal(INPUT_TEXT.refused('那邊的人沒有允許'), '沒有開始打字：那邊的人沒有允許')
  assert.match(INPUT_TEXT.refused(''), /沒有開始打字，字已放回輸入框/)
})

test('接線：打字元件拿最後一幅畫面當底（snap）、只在 starting／waiting 疊；沒進過 typing 就結束才發 refused', () => {
  assert.match(input, /snap: \{ type: String, default: null \}/)
  assert.match(input, /v-if="snap !== null && \(phase === 'starting' \|\| phase === 'waiting'\)"/)
  assert.match(input, /\{\{ TEXT\.waitReply \}\}/)
  assert.match(input, /if \(!reached && alive\) emit\('refused', text\)/)
  assert.match(input, /watch\(phase, p => \{ if \(p === 'typing'\) reached = true \}\)/)
  assert.match(pane, /:snap="waitSnap"/)
  assert.match(pane, /@refused="onInputRefused"/)
  assert.match(pane, /const onInputRefused = reason => \{ remoteTyping\.value = false; typingEndedNote\.value = INPUT_TEXT\.refused\(reason\) \}/)
  assert.match(pane, /const waitSnap = computed\(\(\) => screenPlain\.value\)/)
})

test('樣式：等待層蓋在畫面上（absolute、不擋原本版面）', () => {
  assert.match(css, /\.term-wait-cover\{position:absolute;inset:0;/)
  assert.match(css, /\.term-wait-note\{/)
})

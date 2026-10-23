// 對話標題列：忙碌改黃底、手機版不再顯示黃色說明條；電腦版維持原樣。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { headTone, warnKind } from '../ui/lib/head-tone.mjs'

const ui = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'ui')
const read = f => fs.readFileSync(path.join(ui, f), 'utf8').replace(/\r\n/g, '\n')

test('標題列色調：只有忙碌是黃底，其餘維持藍底', () => {
  assert.equal(headTone('busy'), 'busy')
  for (const s of ['online', 'away', 'offline', undefined, '']) assert.equal(headTone(s), 'normal')
})

test('提醒條（電腦版預設）：線上沒有、離線與暫離與忙碌都有', () => {
  assert.equal(warnKind('online'), null)
  assert.equal(warnKind('offline'), 'offline')
  assert.equal(warnKind('away'), 'status')
  assert.equal(warnKind('busy'), 'status')
})

test('提醒條（手機版 hideBusy）：只拿掉忙碌，暫離與離線照舊', () => {
  assert.equal(warnKind('busy', { hideBusy: true }), null)
  assert.equal(warnKind('away', { hideBusy: true }), 'status')
  assert.equal(warnKind('offline', { hideBusy: true }), 'offline')
  assert.equal(warnKind('online', { hideBusy: true }), null)
})

test('接線守門：手機版傳 hide-busy-warn、標題列掛 is-busy、樣式存在；共用元件用 warnKind 且預設不隱藏', () => {
  const html = read('m.html')
  assert.match(html, /<chat-pane [^>]*:hide-busy-warn="true"/s)
  assert.match(html, /m-chathead" :class="\{ 'is-busy': chatFriend && headTone\(chatFriend\.status\) === 'busy' \}"/)
  assert.match(read('m.js'), /headTone/)
  assert.match(read('mobile.css'), /\.m-chathead\.is-busy\{background:rgba\(255,213,74,\.\d+\)/)
  const cp = read('lib/chatpane.mjs')
  assert.match(cp, /hideBusyWarn: \{ type: Boolean, default: false \}/)
  assert.match(cp, /<div class="warn" v-if="warn">/)
  assert.match(cp, /warnKind\(props\.friend\?\.status, \{ hideBusy: props\.hideBusyWarn \}\)/)
  assert.doesNotMatch(read('chat.html'), /hide-busy-warn/)
})

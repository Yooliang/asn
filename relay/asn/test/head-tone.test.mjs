// 對話標題列：忙碌改黃底、手機版不再顯示黃色說明條；電腦版維持原樣。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { headTone, warnKind } from '../ui/lib/head-tone.mjs'

const ui = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'ui')
const read = f => fs.readFileSync(path.join(ui, f), 'utf8').replace(/\r\n/g, '\n')

test('標題列色調：忙碌疊黃、離線疊灰，其餘維持原樣', () => {
  assert.equal(headTone('busy'), 'busy')
  assert.equal(headTone('offline'), 'offline')
  for (const s of ['online', 'away', undefined, '']) assert.equal(headTone(s), 'normal')
})

test('離線疊灰：手機標題列與電腦收件人列都掛 is-offline，樣式是半透明灰、沒有 url 背景；暫離不受影響', () => {
  assert.match(read('m.html'), /'is-offline': chatFriend && !chatFriend\.room && headTone\(chatFriend\.status, chatFriend\) === 'offline'/)
  const css = read('mobile.css')
  const rule = css.match(/\.m-chathead\.is-offline\{([^}]*)\}/)?.[1] ?? ''
  assert.match(rule, /background:rgba\(120,128,140,\.\d+\)/); assert.doesNotMatch(rule, /url\(/)
  assert.doesNotMatch(css, /\.m-chathead\.is-away/, '暫離沒有獨立樣式，維持原樣')
  assert.match(read('lib/chatpane.mjs'), /class="to-line" :class="\{ 'is-offline': !isRoom && friend\.status === 'offline' \}"/)
  const sty = read('style.css').match(/\.conv-main \.to-line\.is-offline\{([^}]*)\}/)?.[1] ?? ''
  assert.match(sty, /background:rgba\(120,128,140,\.\d+\)/); assert.doesNotMatch(sty, /url\(/)
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
  assert.match(html, /m-chathead" :class="\{ 'is-busy': chatFriend && headTone\(chatFriend\.status, chatFriend\) === 'busy', /)
  assert.match(read('m.js'), /headTone/)
  assert.match(read('mobile.css'), /\.m-chathead\.is-busy\{background:rgba\(255,213,74,\.\d+\)/)
  const cp = read('lib/chatpane.mjs')
  assert.match(cp, /hideBusyWarn: \{ type: Boolean, default: false \}/)
  assert.match(cp, /<div class="warn" v-if="warn === 'offline'">/)   // 離線仍是整排說明條
  // 忙碌／暫離：狀態本來就在名字旁的頭像與名牌上，純資訊的「可能無法馬上回應」標籤拿掉了（#2425，畫面規範〈訊息與提示的位置〉）
  assert.doesNotMatch(cp, /可能無法馬上回應/)
  assert.doesNotMatch(cp, /<span class="to-busy" v-if="warn/)
  // 已停止（0.2 B3）：整排說明條，講清楚信不會處理、怎麼恢復；現在是 AsnNote 的 warn 橫幅，附「重開」鈕（#2425）
  assert.match(cp, /<asn-note v-if="warn === 'stopped' && canReopen" kind="warn" banner action-label="重開" @action="reopenPartner">/)
  assert.match(cp, /warnKind\(props\.friend\?\.status, \{ hideBusy: props\.hideBusyWarn \}\)/)   // 僅顯示條目另有專屬標籤（display-only.test.mjs）
  assert.doesNotMatch(read('chat.html'), /hide-busy-warn/)
})

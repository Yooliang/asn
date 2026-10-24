// 本機程序掃描出來的「僅顯示」條目（kind＝process、receivable＝false）：不顯示忙碌、不能輸入、錯誤白話。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { isDisplayOnly, displayOnlyHint, DISPLAY_ONLY_TAG, friendlySendError } from '../ui/lib/display-only.mjs'
import { buildFriends } from '../ui/lib/roster.mjs'
import { headTone, warnKind } from '../ui/lib/head-tone.mjs'
import { canCallPartner } from '../ui/lib/mobile-call.mjs'
import { canOfferCall } from '../ui/lib/actionbar.mjs'

const UI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'ui')
const proc = { id: 'n/grok #65324（前景）', node: 'n', agent: 'grok #65324（前景）', engine: 'grok', entryKind: 'process', receivable: false, status: 'busy' }
const normal = { id: 'n/小明', node: 'n', agent: '小明', engine: 'claude', entryKind: null, status: 'busy' }

test('判斷：kind＝process 或 receivable＝false 才是僅顯示；一般夥伴不是', () => {
  assert.equal(isDisplayOnly(proc), true)
  assert.equal(isDisplayOnly({ entryKind: 'process' }), true)
  assert.equal(isDisplayOnly({ receivable: false }), true)
  assert.equal(isDisplayOnly(normal), false)
  assert.equal(isDisplayOnly(null), false)
})

test('頁首：僅顯示條目不套忙碌色調、標籤文字固定；一般夥伴忙碌照舊', () => {
  assert.equal(DISPLAY_ONLY_TAG, '僅顯示，無法收信')
  assert.equal(headTone('busy', proc), 'normal')
  assert.equal(headTone('busy', normal), 'busy')
  assert.equal(headTone('busy'), 'busy')
  assert.equal(warnKind('busy'), 'status')
})

test('輸入框提示：帶引擎名、不含「雲端」', () => {
  const t = displayOnlyHint(proc)
  assert.equal(t, '這是這台電腦上自己開的 Grok：ASN 只能顯示，不能傳訊息給它')
  assert.ok(!t.includes('雲端'))
  assert.ok(displayOnlyHint({ entryKind: 'process' }).includes('程式'))
})

test('通話鈕：僅顯示條目一律不提供', () => {
  assert.equal(canCallPartner(proc), false)
  assert.equal(canOfferCall(proc), false)
  assert.equal(canOfferCall({ ...normal, status: 'online' }), true)
})

test('錯誤轉白話：not_receivable 不露出狀態碼與英文代碼，其餘照舊', () => {
  const t = friendlySendError('send HTTP 409 not_receivable')
  assert.equal(t, '這位夥伴只能顯示，不能收信')
  assert.ok(!/HTTP|409|not_receivable/.test(t))
  assert.equal(friendlySendError('send HTTP 429 rate_limited'), '傳得太頻繁了，請稍後再試。')
  assert.equal(friendlySendError('fetch failed'), 'fetch failed')
})

test('名單：receivable＝false 會帶進好友物件，沒給的不多出欄位', () => {
  const r = buildFriends([{ id: 'n', name: 'PC', agents: [{ name: 'grok #65324', engine: 'grok', kind: 'process', receivable: false, status: 'running' }, { name: '小明', engine: 'claude', status: 'idle' }] }], { selfNode: 'self', selfName: 'me' })
  const a = r.find(x => x.agent === 'grok #65324'), b = r.find(x => x.agent === '小明')
  assert.equal(a.receivable, false)
  assert.ok(!('receivable' in b))
})

test('守門：ChatPane 用僅顯示判斷禁用輸入與傳送；core 的 #fail 走白話轉換；m.html 頁首色調傳好友', () => {
  const pane = fs.readFileSync(path.join(UI, 'lib', 'chatpane.mjs'), 'utf8')
  assert.ok(pane.includes('displayOnly'))
  assert.ok(pane.includes('class="to-busy to-readonly"'))
  assert.ok(pane.includes(':disabled="displayOnly"'))
  assert.ok(pane.includes(':disabled="displayOnly || !draft.trim()"'))
  const core = fs.readFileSync(path.join(UI, 'lib', 'core.mjs'), 'utf8')
  assert.ok(core.includes('訊息沒有送到：${friendlySendError(e.message)}'))
  const m = fs.readFileSync(path.join(UI, 'm.html'), 'utf8')
  assert.ok(m.includes('headTone(chatFriend.status, chatFriend)'))
})

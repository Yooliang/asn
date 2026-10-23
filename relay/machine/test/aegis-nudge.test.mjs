// 守門：Aegis 橋自帶的震動拆分（machine/nudge.mjs）要和畫面端（asn/ui/lib/text.mjs）判斷一致，橋拆出的震動畫面端也要認得。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { splitNudgeAnswer, nudgeReplyBody } from '../nudge.mjs'
import * as ui from '../../asn/ui/lib/text.mjs'

const cases = [
  ui.nudgeBody('W-政策'),
  '（W-政策 傳送了一個震動）',
  '（W-政策 傳送了一個震動）\n目前沒有進度要回報。',
  '（W-政策 傳送了一個震動）\r\n\r\n第一行\r\n第二行',
  '（W-政策 傳送了一個震動）\n想回應的話，就回一個震動：寄一封內文只有「（你的名字 傳送了一個震動）」的信，不用另外回信。',
  '前面有字（W-政策 傳送了一個震動）',
  '（傳送了一個震動）',
  '你好',
  '',
]

test('橋的拆分與畫面端判斷、剩餘文字一致', () => {
  for (const c of cases) {
    const sp = splitNudgeAnswer(c, '小良')
    assert.equal(sp !== null, ui.hasNudge(c), JSON.stringify(c))
    if (sp) assert.equal(sp.rest, ui.stripNudge(c), JSON.stringify(c))
  }
})

test('橋回的震動畫面端認得、不帶提示、畫面不留文字（不會來回震動）', () => {
  const b = nudgeReplyBody('小良')
  assert.equal(b, '（小良 傳送了一個震動）')
  assert.ok(ui.hasNudge(b))
  assert.equal(ui.stripNudge(b), '')
})

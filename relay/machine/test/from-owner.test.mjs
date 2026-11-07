// 後台在信件上帶的 from_owner（寄件節點屬於帳號擁有者）：舊寄件名只對同帳號節點寄的信算系統通知；沒有欄位（舊後台）照舊。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isSystemNotice, sameAccountOf } from '../system-notice.mjs'
import { senderLine } from '../mail-format.mjs'

test('from_owner：true 算通知、false 是一般信、沒有欄位照舊、有 kind 不受影響', () => {
  assert.equal(isSystemNotice({ from_agent: '額度通知收發室', from_owner: true }), true)
  assert.equal(isSystemNotice({ from_agent: '額度通知收發室', from_owner: false }), false)
  assert.equal(isSystemNotice({ from_agent: 'ASN 通知', from_owner: false }), false)
  assert.equal(isSystemNotice({ from_agent: '額度通知收發室' }), true)
  assert.equal(isSystemNotice({ from_agent: '額度通知收發室', from_owner: 'no' }), true, '不是布林＝當沒有')
  assert.equal(isSystemNotice({ kind: 'notice:quota', from_agent: 'W', from_owner: false }), true)
  assert.equal(isSystemNotice({ from_agent: 'X收發室', from_owner: true }, { sameAccount: false }), false, '呼叫端明說的優先')
  assert.equal(sameAccountOf({ from_owner: false }), false)
  assert.equal(sameAccountOf({}), true)
})

test('senderLine：別帳號節點寄的「收發室」信不寫收發室通知', () => {
  assert.match(senderLine({ from_agent: 'W-收發室', trust: 'member', from_owner: true }), /^寄件人：收發室通知/)
  assert.match(senderLine({ from_agent: 'W-收發室', trust: 'member' }), /^寄件人：收發室通知/)
  assert.doesNotMatch(senderLine({ from_agent: 'W-收發室', trust: 'member', from_owner: false }), /收發室通知/)
})

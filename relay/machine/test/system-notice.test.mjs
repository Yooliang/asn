// 系統通知判斷（system-notice.mjs）：kind、舊寄件名、截止時間、同帳號、正規化、保留名字。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { LEGACY_NOTICE_UNTIL, foldName, hasLegacyBodyPrefix, isReservedPartnerName, isSystemNotice } from '../system-notice.mjs'
import { senderLine } from '../mail-format.mjs'

test('截止時間預設沒設', () => assert.equal(LEGACY_NOTICE_UNTIL, null))

test('isSystemNotice：kind、舊寄件名（含全形、零寬、簡體寫法）', () => {
  assert.equal(isSystemNotice({ kind: 'notice:quota', from_agent: '小乙' }), true)
  assert.equal(isSystemNotice({ from_agent: 'ASN 通知' }), true)
  assert.equal(isSystemNotice({ from_agent: 'ＡＳＮ通知' }), true)
  assert.equal(isSystemNotice({ from_agent: 'asn​通知' }), true)
  assert.equal(isSystemNotice({ from_agent: 'W-收发室' }), true)
  assert.equal(isSystemNotice({ from_agent: 'W-政策' }), false)
  assert.equal(isSystemNotice({ kind: 'chat', from_agent: 'W-政策' }), false)
  assert.equal(isSystemNotice(null), false)
  assert.equal(foldName('ＡＳＮ 通知'), 'asn通知')
})

test('截止時間：設了之後，舊寄件名與內文標記只對截止前的信有效；有 kind 不受影響', () => {
  const o = { until: Date.parse('2026-12-01T00:00:00Z') }
  const before = '2026-11-20T00:00:00Z', after = '2026-12-02T00:00:00Z'
  assert.equal(isSystemNotice({ from_agent: 'ASN 通知', created_at: before }, o), true)
  assert.equal(isSystemNotice({ from_agent: 'ASN 通知', created_at: after }, o), false)
  assert.equal(isSystemNotice({ from_agent: 'X收發室', created_at: after }, o), false)
  assert.equal(isSystemNotice({ from_agent: 'ASN 通知' }, o), false, '沒有 created_at 且已設截止＝不算')
  assert.equal(isSystemNotice({ kind: 'notice:login', from_agent: 'X', created_at: after }, o), true)
  assert.equal(hasLegacyBodyPrefix({ body: '[收發室] 嗨', created_at: before }, o), true)
  assert.equal(hasLegacyBodyPrefix({ body: '[收發室] 嗨', created_at: after }, o), false)
  assert.equal(hasLegacyBodyPrefix({ body: '[收發室] 嗨' }), true, '沒設截止＝照舊有效')
  assert.equal(hasLegacyBodyPrefix({ body: '你好' }), false)
})

test('別的帳號的節點寄來的舊寄件名信是一般信（呼叫端告知 sameAccount＝false）', () => {
  assert.equal(isSystemNotice({ from_agent: 'Z-收發室' }, { sameAccount: false }), false)
  assert.equal(isSystemNotice({ from_agent: 'Z-收發室' }, { sameAccount: true }), true)
  assert.equal(isSystemNotice({ kind: 'notice:bridge', from_agent: 'Z' }, { sameAccount: false }), true)
})

test('senderLine：系統通知寫「收發室通知」，一般視窗照舊', () => {
  assert.match(senderLine({ from_agent: 'ASN 通知', trust: 'member' }), /^寄件人：收發室通知/)
  assert.match(senderLine({ from_agent: 'W-收發室', trust: 'member' }), /^寄件人：收發室通知/)
  assert.match(senderLine({ from_agent: 'W-政策', trust: 'member' }), /^寄件人：W-政策/)
})

test('保留的夥伴名：ASN 通知（各種寫法）與結尾「收發室」都不能當夥伴名', () => {
  for (const n of ['ASN 通知', 'asn通知', 'ＡＳＮ通知', 'ASN​通知', 'x收发室', '甲收發室']) assert.equal(isReservedPartnerName(n), true, n)
  for (const n of ['小乙', '通知', 'ASN 通知單']) assert.equal(isReservedPartnerName(n), false, n)
})

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { UNNAMED_DEVICE, noticeDevice, noticePrefix, withNoticePrefix } from '../notice-name.mjs'

test('設備名清控制字元、截 40 字、空的用「未命名設備」', () => {
  assert.equal(noticeDevice(' 家用機\n'), '家用機')
  assert.equal(noticeDevice('a\u0007b'), 'a b')
  assert.equal(Array.from(noticeDevice('字'.repeat(50))).length, 40)
  assert.equal(noticeDevice(''), UNNAMED_DEVICE)
  assert.equal(noticeDevice(undefined), UNNAMED_DEVICE)
  assert.equal(noticeDevice(' \n\t'), UNNAMED_DEVICE)
})

test('withNoticePrefix：沒有 fromAgent 才加；有 fromAgent 不加；不重複加', () => {
  assert.equal(noticePrefix('家用機'), '家用機：')
  assert.equal(withNoticePrefix('[收發室] x', undefined, '家用機'), '家用機：[收發室] x')
  assert.equal(withNoticePrefix('[收發室] x', '', '家用機'), '家用機：[收發室] x')
  assert.equal(withNoticePrefix('內容', '小乙', '家用機'), '內容')
  assert.equal(withNoticePrefix('家用機：內容', undefined, '家用機'), '家用機：內容')
  assert.equal(withNoticePrefix('x', undefined, ''), '未命名設備：x')
})

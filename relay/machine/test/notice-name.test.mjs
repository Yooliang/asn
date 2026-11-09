import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cleanDevice, ownDeviceName, withNoticePrefix, createDeviceNameCache } from '../notice-name.mjs'

test('設備名清控制字元、截 40 字、空的是空字串', () => {
  assert.equal(cleanDevice(' 家用機\n'), '家用機')
  assert.equal(cleanDevice('a\u0007b'), 'a b')
  assert.equal(Array.from(cleanDevice('字'.repeat(50))).length, 40)
  assert.equal(cleanDevice(''), '')
  assert.equal(cleanDevice(null), '')
})

test('ownDeviceName：從名單找自己節點；沒名字或沒這個節點＝空', () => {
  const l = { members: [{ id: 'H', name: '40家用' }, { id: 'T', name: ' 辦公室 ' }, { id: 'X', name: null }] }
  assert.equal(ownDeviceName(l, 'T'), '辦公室')
  assert.equal(ownDeviceName(l, 'X'), '')
  assert.equal(ownDeviceName(l, 'Z'), '')
  assert.equal(ownDeviceName({ error: 'x' }, 'T'), '')
  assert.equal(ownDeviceName(null, 'T'), '')
})

test('withNoticePrefix：沒有 fromAgent 且有設備名才加；不重複加', () => {
  assert.equal(withNoticePrefix('x', undefined, '家用機'), '家用機：x')
  assert.equal(withNoticePrefix('x', '', '家用機'), '家用機：x')
  assert.equal(withNoticePrefix('內容', '小乙', '家用機'), '內容')
  assert.equal(withNoticePrefix('內容', undefined, ''), '內容', '沒拿到設備名不加')
  assert.equal(withNoticePrefix('內容', undefined, undefined), '內容')
  assert.equal(withNoticePrefix('家用機：內容', undefined, '家用機'), '家用機：內容')
})

test('設備名快取：期限內不重查；查失敗保留上次的名字、隔一段時間才再試', async () => {
  let t = 1000, calls = 0, fail = false, nm = '甲'
  const c = createDeviceNameCache({ node: 'T', now: () => t, refreshMs: 100, getList: async () => { calls++; if (fail) throw new Error('boom'); return { members: [{ id: 'T', name: nm }] } } })
  assert.equal(await c(), '甲'); assert.equal(await c(), '甲'); assert.equal(calls, 1)
  t += 150; nm = '乙'; assert.equal(await c(), '乙'); assert.equal(calls, 2)
  t += 150; fail = true; assert.equal(await c(), '乙', '失敗保留上次'); assert.equal(calls, 3)
  assert.equal(await c(), '乙'); assert.equal(calls, 3, '失敗後也隔一段時間才再試')
})

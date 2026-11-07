// 設備列「種類」那一段的字（#930，0.2.15）：雲端節點照一般設備各自一列，種類旁標「雲端」；不另開分類（小良哥 11-07）。
// 手機版的本機一定是手機（平台還沒讀到也一樣），不標雲端。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CLOUD_TAG, deviceKindLabel } from '../ui/lib/device-state.mjs'
import { buildDeviceTree } from '../ui/lib/device-tree.mjs'
import { acctDeviceTree } from '../ui/lib/mobile-acct.mjs'

test('種類字：雲端 true 在後面加「雲端」；false／null 照舊（null＝資料還不夠，不標示）', () => {
  assert.equal(CLOUD_TAG, '雲端')
  assert.equal(deviceKindLabel({ kind: '電腦', cloud: true }), '電腦 · 雲端')
  assert.equal(deviceKindLabel({ kind: '電腦', cloud: false }), '電腦')
  assert.equal(deviceKindLabel({ kind: '電腦', cloud: null }), '電腦')
  assert.equal(deviceKindLabel({ kind: '手機', cloud: false }), '手機')
  assert.equal(deviceKindLabel({}), '電腦')
})

const friends = [
  { node: 'Q', device: '辦公室', engine: 'claude', status: 'idle' },
  { node: 'G', device: 'Grok 雲端', engine: 'cloud', status: 'idle' },
]

test('設備樹每一列帶 kindLabel：雲端節點各自一列並標「雲端」，實體電腦不標，順序與分組不變', () => {
  const rows = buildDeviceTree({ friends, nodeOrder: ['Q', 'G'], selfNode: 'P' })
  const by = Object.fromEntries(rows.map(r => [r.key, r]))
  assert.equal(by.G.kindLabel, '電腦 · 雲端')
  assert.equal(by.G.kind, '電腦', 'kind 本身不變（給排序、分組、切換判斷用）')
  assert.equal(by.Q.kindLabel, '電腦')
  assert.deepEqual(rows.map(r => r.key), buildDeviceTree({ friends, nodeOrder: ['Q', 'G'], selfNode: 'P' }).map(r => r.key))
})

test('手機版的本機：平台還沒讀到（launchers／machines 空）也是「手機」，不是雲端', () => {
  const rows = acctDeviceTree({ friends, nodeOrder: ['P', 'Q', 'G'], selfNode: 'P', launchers: {}, machines: {} })
  const me = rows.find(r => r.self)
  assert.ok(me, '有本機那列')
  assert.equal(me.kind, '手機')
  assert.equal(me.phone, true)
  assert.equal(me.cloud, false)
  assert.equal(me.kindLabel, '手機')
})

test('電腦版的本機不受影響：沒傳 selfIsPhone 時照舊看平台與名單', () => {
  const rows = buildDeviceTree({ friends, nodeOrder: ['P', 'Q'], selfNode: 'P' })
  const me = rows.find(r => r.self)
  assert.equal(me.kind, '電腦')
  assert.equal(me.cloud, false)
})

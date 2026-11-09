// 記住上次判成雲端、雲端的第三行說明、本機儲存
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CLOUD_STATE_LINE, deviceStateLine, rememberCloud, STATE } from '../ui/lib/device-state.mjs'
import { CLOUD_MEMORY_KEY, loadCloudNodes, nextCloudNodes, saveCloudNodes } from '../ui/lib/cloud-memory.mjs'
import { buildDeviceTree } from '../ui/lib/device-tree.mjs'

test('rememberCloud 三種轉換：true 記住、null 沿用記住的、false 取消記住', () => {
  assert.deepEqual(rememberCloud(false, true), { cloud: true, store: true })
  assert.deepEqual(rememberCloud(true, null), { cloud: true, store: true }, '離線判不出來：沿用上次的雲端')
  assert.deepEqual(rememberCloud(false, null), { cloud: null, store: false }, '沒記過：維持不知道')
  assert.deepEqual(rememberCloud(true, false), { cloud: false, store: false }, '出現電腦版 ASN：取消記住')
  assert.deepEqual(rememberCloud(false, false), { cloud: false, store: false })
})

test('雲端那列的第三行說明：雲端夥伴，沒有安裝電腦版 ASN（離線也是；非雲端照舊）', () => {
  assert.equal(CLOUD_STATE_LINE, '雲端夥伴，沒有安裝電腦版 ASN')
  const v = [{ label: 'Claude', state: STATE.NO_REPORT }]
  assert.equal(deviceStateLine({ vendors: v, cloud: true }), CLOUD_STATE_LINE)
  assert.equal(deviceStateLine({ vendors: [], online: false, cloud: true }), CLOUD_STATE_LINE)
  assert.equal(deviceStateLine({ vendors: v, cloud: null }), '還沒收到這台的回報')
  assert.equal(deviceStateLine({ vendors: v, cloud: false }), '還沒收到這台的回報')
})

test('本機儲存：鍵名 asnCloudNodes、JSON 陣列；讀不到或格式錯當沒有；寫失敗不丟例外', () => {
  const mem = {}
  const st = { getItem: k => mem[k] ?? null, setItem: (k, v) => { mem[k] = v } }
  assert.equal(CLOUD_MEMORY_KEY, 'asnCloudNodes')
  assert.deepEqual(loadCloudNodes(st), [])
  saveCloudNodes(['a', 'b'], st)
  assert.equal(mem.asnCloudNodes, '["a","b"]')
  assert.deepEqual(loadCloudNodes(st), ['a', 'b'])
  mem.asnCloudNodes = '{壞掉'
  assert.deepEqual(loadCloudNodes(st), [])
  mem.asnCloudNodes = '{"a":1}'
  assert.deepEqual(loadCloudNodes(st), [])
  const boom = { getItem: () => { throw new Error('x') }, setItem: () => { throw new Error('x') } }
  assert.deepEqual(loadCloudNodes(boom), [])
  assert.doesNotThrow(() => saveCloudNodes(['a'], boom))
})

test('設備樹：離線的雲端夥伴靠記憶仍標「雲端」；名單算出的下一份記憶照 cloudStore 增減', () => {
  const friends = [{ node: 'J', device: '日本VM', engine: 'claude', status: 'offline' }]
  const base = { friends, nodeOrder: ['J'], selfNode: 'P' }
  const without = buildDeviceTree(base).find(r => r.key === 'J')
  assert.equal(without.cloud, null)
  assert.equal(without.kindLabel, '電腦')
  const rows = buildDeviceTree({ ...base, cloudNodes: ['J'] })
  const j = rows.find(r => r.key === 'J')
  assert.equal(j.cloud, true)
  assert.equal(j.kindLabel, '雲端')
  assert.equal(j.stateLine, CLOUD_STATE_LINE)
  assert.deepEqual(nextCloudNodes(['J', 'X'], rows), ['X', 'J'], '沒出現在這份名單的 X 維持原樣')
  // 出現電腦版 ASN 在線 → 取消記住
  const on = buildDeviceTree({ ...base, cloudNodes: ['J'], asn: { J: [{}] } })
  assert.equal(on.find(r => r.key === 'J').cloud, false)
  assert.deepEqual(nextCloudNodes(['J'], on), [])
})

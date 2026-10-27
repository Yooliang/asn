// tools/run-root-tests.mjs 的純邏輯：參數解析、挑檔、結果分類（#284）。不真的跑別支測試。
import test from 'node:test'
import assert from 'node:assert/strict'
import { classify, parseArgs, pickFiles } from '../tools/run-root-tests.mjs'

test('參數：預設 60 秒；--timeout 要正整數，壞的用預設；其餘當檔名篩選字（小寫）', () => {
  assert.deepEqual(parseArgs([]), { filters: [], timeoutSec: 60 })
  assert.deepEqual(parseArgs(['Tenants', '--timeout=30', 'roadmap']), { filters: ['tenants', 'roadmap'], timeoutSec: 30 })
  for (const bad of ['--timeout=0', '--timeout=-5', '--timeout=abc', '--timeout=1.5', '--timeout=']) assert.equal(parseArgs([bad]).timeoutSec, 60, bad)
  assert.deepEqual(parseArgs(['--unknown']).filters, [], '不認得的旗標不當檔名')
})

test('挑檔：只要 *.test.mjs、排序固定、篩選字比對檔名（不分大小寫）', () => {
  const names = ['b_sql.test.mjs', '_fake_relay.mjs', 'vectors', 'A_roadmap.test.mjs', 'c.test.mjs']
  assert.deepEqual(pickFiles(names), ['A_roadmap.test.mjs', 'b_sql.test.mjs', 'c.test.mjs'])
  assert.deepEqual(pickFiles(names, ['sql']), ['b_sql.test.mjs'])
  assert.deepEqual(pickFiles(names, ['roadmap', 'c.test']), ['A_roadmap.test.mjs', 'c.test.mjs'])
  assert.deepEqual(pickFiles(names, ['沒有']), [])
})

test('結果分類：0 是過、非 0 是失敗、逾時（ETIMEDOUT 或被收掉）單獨一類，不算通過', () => {
  assert.equal(classify({ status: 0 }), 'passed')
  assert.equal(classify({ status: 1 }), 'failed')
  assert.equal(classify({ status: null, error: { code: 'ETIMEDOUT' } }), 'timeout')
  assert.equal(classify({ status: null, signal: 'SIGTERM' }), 'timeout')
  assert.equal(classify({ status: null }), 'failed', '沒有狀態碼也不是通過')
})

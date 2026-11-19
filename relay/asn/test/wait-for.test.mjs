// test/helpers/wait-for.mjs 的單元測試（#994 系列：測試別靠固定等待）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { waitFor } from './helpers/wait-for.mjs'

test('waitFor：條件成立就馬上回傳那個值（不多等）', async () => {
  const t0 = Date.now()
  assert.equal(await waitFor(() => 'ok'), 'ok')
  assert.ok(Date.now() - t0 < 100)
})

test('waitFor：條件稍後才成立（也可以是 async）也等得到', async () => {
  let n = 0
  const v = await waitFor(async () => (++n >= 5 ? { n } : null), { timeout: 1000 })
  assert.deepEqual(v, { n: 5 })
})

test('waitFor：逾時丟錯，訊息帶要等的東西與上限；cond 丟的錯原樣往外丟', async () => {
  await assert.rejects(() => waitFor(() => false, { timeout: 60, what: '假的條件' }), /waitFor 逾時：假的條件在 60ms 內沒有成立/)
  await assert.rejects(() => waitFor(() => { throw new Error('壞了') }), /壞了/)
})

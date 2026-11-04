// ack 失敗待補清單：補上、退避、上限、重開、壞檔。假的時鐘與後台，不連網路。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ACK_RETRY_MAX, createAckRetry } from '../ack-retry.mjs'

function setup({ fail = () => false, file } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ack-retry-'))
  const f = file ?? path.join(dir, 'ack-retry.json')
  const s = { t: 1000, calls: [], logs: [], seen: new Set(), file: f }
  s.make = () => createAckRetry({
    post: async ids => { s.calls.push(ids); if (fail()) throw new Error('boom') },
    file: f, log: l => s.logs.push(l), seen: s.seen, now: () => s.t,
  })
  s.r = s.make()
  return s
}

test('ack 成功：記進 seen，不進清單', async () => {
  const s = setup()
  await s.r.ack(['a'])
  assert.ok(s.seen.has('a'))
  assert.deepEqual(s.r.list(), [])
  await s.r.ack([])
  assert.equal(s.calls.length, 1, '空的不打')
})

test('ack 失敗：進清單，到時間補上，清空後不再打', async () => {
  let down = true
  const s = setup({ fail: () => down })
  await s.r.ack(['a'])
  assert.ok(s.r.has('a') && !s.seen.has('a'))
  down = false
  s.t += 29_999
  await s.r.tick()
  assert.equal(s.calls.length, 1, '還沒到時間')
  s.t += 1
  await s.r.tick()
  assert.ok(s.seen.has('a'))
  assert.deepEqual(s.r.list(), [])
  s.t += 3_600_000
  await s.r.tick()
  assert.equal(s.calls.length, 2)
})

test('一直失敗：間隔加倍，最多十分鐘', async () => {
  const s = setup({ fail: () => true })
  await s.r.ack(['a'])
  s.t += 30_000
  const gaps = [60_000, 120_000, 240_000, 480_000, 600_000, 600_000]
  await s.r.tick()
  for (const gap of gaps) {
    const n = s.calls.length
    s.t += gap - 1
    await s.r.tick()
    assert.equal(s.calls.length, n, `${gap} 之前不打`)
    s.t += 1
    await s.r.tick()
    assert.equal(s.calls.length, n + 1, `${gap} 到了打一次`)
  }
})

test('正在補的時候不會再打一次', async () => {
  const s = setup()
  let release
  const r = createAckRetry({ post: ids => { s.calls.push(ids); if (s.calls.length === 1) throw new Error('boom'); return new Promise(ok => { release = ok }) }, file: s.file, log: () => {}, seen: s.seen, now: () => s.t })
  await r.ack(['a'])
  s.t += 30_000
  const first = r.tick()
  await r.tick()
  assert.equal(s.calls.length, 2)
  release()
  await first
})

test('清單有上限：超過丟最舊的並記 log', async () => {
  const s = setup({ fail: () => true })
  await s.r.ack(Array.from({ length: ACK_RETRY_MAX + 1 }, (_, i) => `id-${i}`))
  assert.equal(s.r.list().length, ACK_RETRY_MAX)
  assert.ok(!s.r.has('id-0') && s.r.has('id-1'))
  assert.ok(s.logs.some(l => l.includes('ack retry list full')))
})

test('重開：清單讀回來，下一個 tick 就補；補完存檔也清掉', async () => {
  let down = true
  const s = setup({ fail: () => down })
  await s.r.ack(['a', 'b'])
  const again = s.make()
  assert.deepEqual(again.list(), ['a', 'b'])
  down = false
  await again.tick()
  assert.ok(s.seen.has('a') && s.seen.has('b'))
  assert.deepEqual(s.make().list(), [])
})

test('存檔壞掉：當成沒有清單，記 log，不會當掉', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ack-retry-'))
  const file = path.join(dir, 'ack-retry.json')
  fs.writeFileSync(file, '{"ids":[')
  const s = setup({ file })
  assert.deepEqual(s.r.list(), [])
  assert.ok(s.logs.some(l => l.includes('unreadable')))
})

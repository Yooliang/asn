// ack 失敗待補清單：補上、退避、上限、重開、壞檔。假的時鐘與後台，不連網路。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ACK_RETRY_MAX, createAckRetry } from '../ack-retry.mjs'

const id = n => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function setup({ fail = () => false, file } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ack-retry-'))
  const f = file ?? path.join(dir, 'ack-retry.json')
  const s = { t: 1000, calls: [], logs: [], seen: new Set(), file: f }
  s.make = () => createAckRetry({
    // 和真的後台同樣的規則：超過 100 筆或不是 UUID，整批 400
    post: async ids => { s.calls.push(ids); if (ids.length > 100 || !ids.every(i => UUID.test(i))) throw new Error('HTTP 400 bad_ids'); if (fail()) throw new Error('boom') },
    file: f, log: l => s.logs.push(l), seen: s.seen, now: () => s.t,
  })
  s.r = s.make()
  return s
}

test('ack 成功：記進 seen，不進清單', async () => {
  const s = setup()
  await s.r.ack([id(1)])
  assert.ok(s.seen.has(id(1)))
  assert.deepEqual(s.r.list(), [])
  await s.r.ack([])
  assert.equal(s.calls.length, 1, '空的不打')
})

test('ack 失敗：進清單，到時間補上，清空後不再打', async () => {
  let down = true
  const s = setup({ fail: () => down })
  await s.r.ack([id(1)])
  assert.ok(s.r.has(id(1)) && !s.seen.has(id(1)))
  down = false
  s.t += 29_999
  await s.r.tick()
  assert.equal(s.calls.length, 1, '還沒到時間')
  s.t += 1
  await s.r.tick()
  assert.ok(s.seen.has(id(1)))
  assert.deepEqual(s.r.list(), [])
  s.t += 3_600_000
  await s.r.tick()
  assert.equal(s.calls.length, 2)
})

test('一直失敗：間隔加倍，最多十分鐘', async () => {
  const s = setup({ fail: () => true })
  await s.r.ack([id(1)])
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
  await r.ack([id(1)])
  s.t += 30_000
  const first = r.tick()
  await r.tick()
  assert.equal(s.calls.length, 2)
  release()
  await first
})

test('清單有上限：超過丟最舊的並記 log', async () => {
  const s = setup({ fail: () => true })
  await s.r.ack(Array.from({ length: ACK_RETRY_MAX + 1 }, (_, i) => id(i)))
  assert.equal(s.r.list().length, ACK_RETRY_MAX)
  assert.ok(!s.r.has(id(0)) && s.r.has(id(1)))
  assert.ok(s.logs.some(l => l.includes('ack retry list full')))
})

test('重開：清單讀回來，下一個 tick 就補；補完存檔也清掉', async () => {
  let down = true
  const s = setup({ fail: () => down })
  await s.r.ack([id(1), id(2)])
  const again = s.make()
  assert.deepEqual(again.list(), [id(1), id(2)])
  down = false
  await again.tick()
  assert.ok(s.seen.has(id(1)) && s.seen.has(id(2)))
  assert.deepEqual(s.make().list(), [])
})

test('累積超過 100 筆：每批最多 100 筆，恢復後全部補完', async () => {
  let down = true
  const s = setup({ fail: () => down })
  const list = Array.from({ length: 250 }, (_, i) => id(i))
  for (let i = 0; i < list.length; i += 50) await s.r.ack(list.slice(i, i + 50))
  assert.equal(s.r.list().length, 250)
  down = false
  s.calls.length = 0
  s.t += 30_000
  await s.r.tick()
  assert.deepEqual(s.calls.map(c => c.length), [100, 100, 50])
  assert.deepEqual(s.r.list(), [])
  assert.equal(s.seen.size, 250)
})

test('某一批失敗：已送成功的拿掉，其他退避後再補', async () => {
  const s = setup()
  const answers = ['fail', 'ok', 'fail', 'ok']   // 第一次 ack 失敗；補的時候第一批成功、第二批失敗；再補成功
  const r = createAckRetry({ post: async () => { if (answers.shift() === 'fail') throw new Error('boom') }, file: s.file, log: () => {}, seen: s.seen, now: () => s.t })
  await r.ack(Array.from({ length: 150 }, (_, i) => id(i)))
  assert.equal(r.list().length, 150)
  s.t += 30_000
  await r.tick()
  assert.equal(r.list().length, 50, '第一批成功就拿掉，第二批失敗留著')
  s.t += 59_999
  await r.tick()
  assert.equal(r.list().length, 50, '失敗後退避')
  s.t += 1
  await r.tick()
  assert.deepEqual(r.list(), [])
})

test('存檔混一筆壞的：濾掉並記 log，其他照補', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ack-retry-'))
  const file = path.join(dir, 'ack-retry.json')
  fs.writeFileSync(file, JSON.stringify({ ids: ['not-a-uuid', id(1), 5] }))
  const s = setup({ file })
  assert.deepEqual(s.r.list(), [id(1)])
  assert.ok(s.logs.some(l => l.includes('dropped 2 invalid')))
  await s.r.tick()
  assert.deepEqual(s.r.list(), [])
  assert.deepEqual(s.calls, [[id(1)]])
})

test('存檔壞掉：當成沒有清單，記 log，不會當掉', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ack-retry-'))
  const file = path.join(dir, 'ack-retry.json')
  fs.writeFileSync(file, '{"ids":[')
  const s = setup({ file })
  assert.deepEqual(s.r.list(), [])
  assert.ok(s.logs.some(l => l.includes('unreadable')))
})

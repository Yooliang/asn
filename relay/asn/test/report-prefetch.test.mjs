// 進設備頁時預讀各台帳號回報（#930，0.2.15）：為了顯示「雲端」標示，進設備頁時讀一次。
// 後台沒有批次版本 → 逐台讀，同時最多 3 台；一分鐘內不重讀；讀失敗不報錯、那台照舊是「電腦」。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createReportPrefetch, REPORT_PREFETCH_GAP_MS, REPORT_PREFETCH_MAX, acctDeviceTree } from '../ui/lib/mobile-acct.mjs'

const sleep = ms => new Promise(r => setTimeout(r, ms))

test('同時最多 3 台：6 台照順序讀完，同一時間最多 3 個在讀', async () => {
  assert.equal(REPORT_PREFETCH_MAX, 3)
  let live = 0, peak = 0
  const seen = []
  const run = createReportPrefetch({ read: async n => { live++; peak = Math.max(peak, live); await sleep(10); live--; return { n } }, log: () => {} })
  assert.equal(await run(['a', 'b', 'c', 'd', 'e', 'f', 'a'], (n, v) => seen.push([n, v.n])), true)
  assert.equal(peak, 3)
  assert.deepEqual(seen.map(([n]) => n).sort(), ['a', 'b', 'c', 'd', 'e', 'f'], '重複的節點只讀一次')
  assert.ok(seen.every(([n, v]) => n === v))
})

test('一分鐘內第二次進設備頁不再讀；過了一分鐘才讀', async () => {
  assert.equal(REPORT_PREFETCH_GAP_MS, 60_000)
  let t = 1_000_000, reads = 0
  const run = createReportPrefetch({ read: async () => { reads++; return {} }, now: () => t, log: () => {} })
  assert.equal(await run(['a', 'b'], () => {}), true)
  assert.equal(reads, 2)
  t += 59_999
  assert.equal(await run(['a', 'b'], () => {}), false, '一分鐘內：不讀，呼叫端用上次的結果')
  assert.equal(reads, 2)
  t += 1
  assert.equal(await run(['a'], () => {}), true)
  assert.equal(reads, 3)
})

test('讀失敗或讀到一半：不丟例外、只記 console、那台不回報；其他台照常', async () => {
  const logs = [], got = []
  const run = createReportPrefetch({ read: async n => { if (n === 'bad') throw new Error('網路斷了'); return { asn_online: false, reported_at: '', accounts: [] } }, log: (...a) => logs.push(a.join(' ')) })
  await assert.doesNotReject(run(['ok1', 'bad', 'ok2'], n => got.push(n)))
  assert.deepEqual(got.sort(), ['ok1', 'ok2'])
  assert.equal(logs.length, 1)
  assert.match(logs[0], /bad/)
})

test('讀到之後 Aegis／日本VM 標「雲端」；沒讀到（或讀失敗）照舊「電腦」', () => {
  const friends = [
    { node: 'A', device: '牧陽 Aegis', engine: 'aegis', status: 'idle' },
    { node: 'J', device: '日本VM', engine: 'claude', status: 'idle' },
    { node: 'Q', device: '辦公室', engine: 'claude', status: 'idle' },
  ]
  const base = { friends, nodeOrder: ['P', 'A', 'J', 'Q'], selfNode: 'P' }
  const before = Object.fromEntries(acctDeviceTree(base).map(d => [d.key, d.kindLabel]))
  assert.deepEqual([before.A, before.J, before.Q], ['電腦', '電腦', '電腦'], '還沒讀到：不猜')
  const never = { loading: false, asnOnline: false, reportedAt: '', msg: '', list: [] }
  const pc = { loading: false, asnOnline: true, reportedAt: '2026-11-08T00:00:00Z', msg: '', list: [] }
  const after = Object.fromEntries(acctDeviceTree({ ...base, reports: { A: never, J: never, Q: pc } }).map(d => [d.key, d.kindLabel]))
  assert.deepEqual([after.A, after.J, after.Q], ['電腦 · 雲端', '電腦 · 雲端', '電腦'])
})

test('守門：手機進設備頁時呼叫預讀（只在 openAcctNow，一次），預讀結果不蓋掉已經讀到的', () => {
  const src = fs.readFileSync(new URL('../ui/m.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n')
  const open = src.slice(src.indexOf('async function openAcctNow('), src.indexOf('function openAcctDevice('))
  assert.equal(open.split('void prefetchReports()').length - 1, 1)
  assert.equal(src.split('prefetchReports()').length - 1, 2, '定義一次、呼叫一次')
  assert.match(src, /if \(epoch === acctEpoch && !acctSw\.reports\[node\]\) acctSw\.reports\[node\] = r/)
})

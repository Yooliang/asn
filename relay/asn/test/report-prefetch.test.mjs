// 進設備頁時預讀各台帳號回報（#930，0.2.15）：為了顯示「雲端」標示，進設備頁時讀一次。
// 後台沒有批次版本 → 逐台讀，同時最多 3 台；一分鐘內不重讀；讀失敗不報錯、那台照舊是「電腦」。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createReportPrefetch, isFailedReport, REPORT_PREFETCH_GAP_MS, REPORT_PREFETCH_MAX, acctDeviceTree } from '../ui/lib/mobile-acct.mjs'

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
  assert.match(src, /if \(epoch === acctEpoch && \(!acctSw\.reports\[node\] \|\| isFailedReport\(acctSw\.reports\[node\]\)\)\) acctSw\.reports\[node\] = r/)
})

test('第一次進設備頁時沒有可讀的節點（名單還沒載入）→ 不記時間；一分鐘內名單載入後再進會讀', async () => {
  let t = 5_000_000, reads = 0
  const run = createReportPrefetch({ read: async () => { reads++; return {} }, now: () => t, log: () => {} })
  assert.equal(await run([], () => {}), true, '沒有可讀的：沒發任何讀取')
  assert.equal(reads, 0)
  t += 5_000
  assert.equal(await run(['A', 'J'], () => {}), true, '一分鐘內，但上次沒讀到任何一台：照讀')
  assert.equal(reads, 2)
  t += 5_000
  assert.equal(await run(['A', 'J'], () => {}), false, '這次真的讀過了：一分鐘內不重讀')
  assert.equal(reads, 2)
})

test('手機：讀失敗的那台，過了重讀時間下次進設備頁會再讀；讀成功的一分鐘內不重讀', async () => {
  let t = 1_000_000
  const reads = []
  let ok = false
  const run = createReportPrefetch({ read: async n => { reads.push(n); if (n === 'bad' && !ok) throw new Error('沒登入'); return {} }, now: () => t, log: () => {} })
  assert.equal(await run(['good', 'bad'], () => {}), true)
  assert.deepEqual(reads, ['good', 'bad'])
  t += 30_000
  assert.equal(await run(['good', 'bad'], () => {}), false, '30 秒：失敗的還沒到時間')
  assert.equal(reads.length, 2)
  t += 30_000
  ok = true
  const got = []
  assert.equal(await run(['good', 'bad'], (n) => got.push(n)), true)
  assert.deepEqual(reads, ['good', 'bad', 'good', 'bad'], '過了 60 秒：兩台都讀（一分鐘間隔也到了）')
  t += 1_000
  await run(['good', 'bad'], () => {})
  assert.equal(reads.length, 4, '都成功了：一分鐘內不再讀')
})

test('手機：retryMs 比間隔短時，一分鐘內只重讀失敗且到時間的，成功的不動', async () => {
  let t = 0
  const reads = []
  let ok = false
  const run = createReportPrefetch({ read: async n => { reads.push(n); if (n === 'bad' && !ok) throw new Error('x'); return {} }, now: () => t, gapMs: 60_000, retryMs: 10_000, log: () => {} })
  await run(['good', 'bad'], () => {})
  t += 5_000
  await run(['good', 'bad'], () => {})
  assert.equal(reads.length, 2)
  t += 6_000; ok = true
  await run(['good', 'bad'], () => {})
  assert.deepEqual(reads, ['good', 'bad', 'bad'])
})

test('手機：點進去讀失敗留下的失敗紀錄，不擋住之後預讀讀到的成功結果', () => {
  assert.equal(isFailedReport({ loading: false, msg: '讀不到', list: [] }), true)
  assert.equal(isFailedReport({ loading: true, msg: '' }), false)
  assert.equal(isFailedReport({ loading: false, msg: '', list: [] }), false)
  assert.equal(isFailedReport(undefined), false)
})

// 手機（Play 版）版本紀錄的重讀時機（#1501）：資料過期、回前景、失敗退避重試，以及三種情況下紅點都會亮。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { RELEASES_MAX_AGE_MS, createReleasesRefresher, initialReleases, loadReleases, releasesStale, retryDelayMs, stampReleases } from '../ui/lib/releases.mjs'
import { playUpdateVersion } from '../ui/lib/play-update.mjs'
import { tabDot } from '../ui/lib/mobile.mjs'

const MIN = 60_000
const T0 = 1_000_000_000_000
const row = (version, platforms = ['官網', 'Play']) => ({ version, date: '', lines: [], platforms })
const okRel = (loadedAt, entries = [row('0.2.20')]) => ({ phase: 'ok', entries, text: '', loadedAt, failedAt: 0, failCount: 0 })
const tick = () => new Promise(r => setImmediate(r))

test('過期判斷：ok 滿 30 分鐘才讀、idle／error 要讀、loading 不讀', () => {
  assert.equal(releasesStale(okRel(T0), T0 + 29 * MIN), false)
  assert.equal(releasesStale(okRel(T0), T0 + RELEASES_MAX_AGE_MS), true)
  assert.equal(releasesStale({ phase: 'ok', entries: [] }, T0), true, '沒有時間戳的 ok 當過期')
  assert.equal(releasesStale(initialReleases(), T0), true)
  assert.equal(releasesStale({ phase: 'error', failedAt: T0 - 5 * MIN, failCount: 2 }, T0), true)
  assert.equal(releasesStale({ phase: 'loading' }, T0 + 99 * MIN), false)
  assert.equal(releasesStale(null, T0), false)
  assert.equal(releasesStale({ phase: 'error', failedAt: T0 - 10_000, failCount: 1 }, T0), false, '剛失敗 30 秒內不連讀')
})

test('退避序列：30 秒、2 分、5 分、15 分，之後每 30 分', () => {
  assert.deepEqual([1, 2, 3, 4, 5, 6, 40].map(retryDelayMs), [30_000, 2 * MIN, 5 * MIN, 15 * MIN, 30 * MIN, 30 * MIN, 30 * MIN])
  assert.equal(retryDelayMs(0), 30_000)
  assert.equal(retryDelayMs(NaN), 30_000)
})

test('記時間戳：成功記 loadedAt 並清失敗；失敗記 failedAt 與次數；有舊資料時失敗不丟資料', async () => {
  const good = await loadReleases(async () => [row('0.2.21')])
  const a = stampReleases(initialReleases(), good, T0)
  assert.deepEqual([a.phase, a.loadedAt, a.failedAt, a.failCount], ['ok', T0, 0, 0])
  const bad = await loadReleases(async () => { throw new Error('x') })
  const b = stampReleases(initialReleases(), bad, T0)
  assert.deepEqual([b.phase, b.failedAt, b.failCount, b.entries], ['error', T0, 1, []])
  assert.equal(stampReleases(b, bad, T0 + 1).failCount, 2)
  const d = stampReleases(a, bad, T0 + 2)
  assert.deepEqual([d.phase, d.entries.length, d.loadedAt, d.failCount], ['ok', 1, T0, 1])
  assert.equal(playUpdateVersion(d, '0.2.10'), '0.2.21', '重讀失敗，紅點照舊')
  assert.equal(a.failCount, 0, '不改傳入的物件')
  assert.equal(stampReleases(d, good, T0 + 3).failCount, 0)
})

// 假環境：時鐘、計時器、rel 與讀取次數
function env({ fg = true, enabled = true, rel = initialReleases(), reads = [] } = {}) {
  const e = { now: T0, fg, enabled, rel, calls: 0, timers: [], seq: reads.slice() }
  e.load = async () => {
    e.calls++
    const next = e.seq.length ? e.seq.shift() : 'fail'
    const res = next === 'fail' ? await loadReleases(async () => { throw new Error('net') }) : await loadReleases(async () => next)
    e.rel = stampReleases(e.rel, res, e.now)
  }
  e.r = createReleasesRefresher({
    getRel: () => e.rel, load: e.load, now: () => e.now, isForeground: () => e.fg, enabled: () => e.enabled,
    setTimer: (fn, ms) => { const t = { fn, ms, on: true }; e.timers.push(t); return t },
    clearTimer: t => { t.on = false },
  })
  e.live = () => e.timers.filter(t => t.on)
  e.fire = async () => { const t = e.live()[0]; t.on = false; t.fn(); await tick() }
  return e
}

test('回到前景：過期才讀；沒過期不讀；不是 Play 版不讀；進背景不讀', async () => {
  const e = env({ rel: okRel(T0, [row('0.2.20')]) })
  e.now = T0 + 10 * MIN
  assert.equal(e.r.onForeground(true), false)
  assert.equal(e.calls, 0)
  e.now = T0 + 31 * MIN
  e.seq = [[row('0.2.20'), row('0.2.30')]]
  assert.equal(playUpdateVersion(e.rel, '0.2.20'), '', '舊清單沒有新版，紅點不亮')
  assert.equal(e.r.onForeground(true), true)
  await tick()
  assert.equal(e.calls, 1)
  assert.equal(playUpdateVersion(e.rel, '0.2.20'), '0.2.30', '回前景重讀後紅點亮')
  assert.equal(tabDot('me', { update: playUpdateVersion(e.rel, '0.2.20') !== '' }), true)
  assert.equal(e.rel.loadedAt, T0 + 31 * MIN)
  e.now += 31 * MIN
  assert.equal(e.r.onForeground(false), false)
  assert.equal(e.calls, 1)
  const off = env({ enabled: false })
  assert.equal(off.r.onForeground(true), false)
  assert.equal(off.r.check(), false)
  assert.equal(off.calls, 0)
})

test('進設定分頁（check）：過期才讀，讀取中不重複讀', async () => {
  const e = env({ rel: okRel(T0), reads: [[row('0.2.20'), row('0.2.40')]] })
  e.now = T0 + 5 * MIN
  assert.equal(e.r.check(), false)
  e.now = T0 + 45 * MIN
  assert.equal(e.r.check(), true)
  await tick()
  assert.equal(playUpdateVersion(e.rel, '0.2.20'), '0.2.40')
  assert.equal(e.r.check(), false, '剛讀完不再讀')
  assert.equal(env({ rel: { phase: 'loading' } }).r.check(), false)
})

test('啟動讀取失敗：依序 30 秒、2 分、5 分、15 分、30 分重試，成功即停', async () => {
  const e = env({ reads: ['fail', 'fail', 'fail', 'fail', 'fail', [row('0.2.50')]] })
  await e.r.run()
  assert.equal(e.calls, 1)
  const delays = []
  for (let i = 0; i < 5; i++) {
    delays.push(e.live()[0].ms)
    e.now += e.live()[0].ms
    await e.fire()
  }
  assert.deepEqual(delays, [30_000, 2 * MIN, 5 * MIN, 15 * MIN, 30 * MIN])
  assert.equal(e.calls, 6)
  assert.equal(e.rel.phase, 'ok')
  assert.equal(e.live().length, 0, '成功就不再排')
  assert.equal(playUpdateVersion(e.rel, '0.2.10'), '0.2.50', '重試成功後紅點亮')
})

test('App 在背景時不重試；回前景才補讀；進背景把計時器清掉', async () => {
  const e = env({ reads: ['fail', [row('0.2.60')]] })
  await e.r.run()
  assert.equal(e.live().length, 1)
  e.fg = false
  e.now += 30_000
  await e.fire()
  assert.equal(e.calls, 1, '背景的計時器到了不讀')
  assert.equal(e.live().length, 0)
  e.fg = true
  e.now += 5 * MIN
  e.r.onForeground(true)
  await tick()
  assert.equal(e.calls, 2)
  assert.equal(playUpdateVersion(e.rel, '0.2.10'), '0.2.60')
  const e2 = env({ reads: ['fail'] })
  await e2.r.run()
  assert.equal(e2.r.pending(), true)
  e2.r.onForeground(false)
  assert.equal(e2.r.pending(), false)
})

test('已有舊資料時重讀失敗：紅點不掉，照退避再試', async () => {
  const e = env({ rel: okRel(T0, [row('0.2.20'), row('0.2.70')]), reads: ['fail', [row('0.2.20'), row('0.2.71')]] })
  e.now = T0 + 40 * MIN
  e.r.check()
  await tick()
  assert.equal(playUpdateVersion(e.rel, '0.2.20'), '0.2.70')
  assert.equal(e.live()[0].ms, 30_000)
  e.now += 30_000
  await e.fire()
  assert.equal(playUpdateVersion(e.rel, '0.2.20'), '0.2.71')
})

test('接線：m.js 的前景事件走既有的 tellFg，手機只有 Play 版才自動重讀', () => {
  const m = fs.readFileSync(new URL('../ui/m.js', import.meta.url), 'utf8')
  assert.match(m, /fgListener\?\.\(fg === true\)/)
  assert.match(m, /enabled: \(\) => upd\.enabled === false/)
  assert.match(m, /nav\.tab, t => \{ if \(t === 'me'\) relRefresh\.check\(\)/)
  assert.equal((m.match(/window\.__asnFgEvent =/g) || []).length, 1, '不另掛一套前景監聽')
})

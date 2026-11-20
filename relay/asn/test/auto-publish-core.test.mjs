import test from 'node:test'
import assert from 'node:assert/strict'
import { decide, applyResult, emptyState } from '../../../tools/release/auto_publish_core.mjs'

const T0 = Date.parse('2026-11-21T10:00:00Z')
const run = (platform, version, over = {}) => ({
  platform, version, tag: `${platform === 'linux' ? 'linux-' : ''}v${version}`,
  runId: `${platform}-${version}-1`, status: 'completed', conclusion: 'success',
  createdAt: '2026-11-21T09:00:00Z', ...over,
})

// 跑完一整輪：decide → 假裝子程序成功 → applyResult
function step(runs, state, now, ok = true) {
  const d = decide({ runs, state, now })
  if (d.action !== 'dryRun' && d.action !== 'publish') return { d, state: d.state }
  const r = applyResult(d.state, { key: d.key, step: d.action, ok, detail: '測試', now })
  return { d, state: r.state, report: r.report }
}

test('run 還在跑 → wait', () => {
  for (const status of ['queued', 'in_progress']) {
    const d = decide({ runs: [run('desktop', '0.2.45', { status, conclusion: null })], state: emptyState(), now: T0 })
    assert.equal(d.action, 'wait')
  }
  assert.equal(decide({ runs: [], state: emptyState(), now: T0 }).action, 'wait')
})

test('全綠 → dryRun → 成功 → publish → 成功 → 之後都 wait', () => {
  const runs = [run('desktop', '0.2.45')]
  let s = emptyState()
  let r = step(runs, s, T0)
  assert.equal(r.d.action, 'dryRun')
  assert.equal(r.d.key, 'desktop@0.2.45')
  assert.equal(r.d.tag, 'v0.2.45')
  assert.equal(r.d.runId, 'desktop-0.2.45-1')
  assert.equal(r.d.platform, 'desktop')
  assert.equal(r.d.state.inflight.key, 'desktop@0.2.45')
  assert.equal(r.report, null)
  assert.ok(r.state.pending['desktop@0.2.45'])
  assert.equal(r.state.inflight, null)
  r = step(runs, r.state, T0 + 1000)
  assert.equal(r.d.action, 'publish')
  assert.equal(r.d.runId, 'desktop-0.2.45-1')
  assert.equal(r.report, null, '成功不回報')
  assert.equal(r.state.done['desktop@0.2.45'].result, 'published')
  assert.equal(r.state.inflight, null)
  for (let i = 0; i < 3; i++) {
    const d = decide({ runs, state: r.state, now: T0 + 5000 + i })
    assert.equal(d.action, 'wait')
  }
})

test('dry-run 失敗 → 回報一次，之後不再做', () => {
  const runs = [run('desktop', '0.2.45')]
  const r = step(runs, emptyState(), T0, false)
  assert.equal(r.d.action, 'dryRun')
  assert.match(r.report, /試跑/)
  assert.equal(r.state.done['desktop@0.2.45'].result, 'dryrun-failed')
  assert.equal(r.state.inflight, null)
  assert.equal(decide({ runs, state: r.state, now: T0 + 1 }).action, 'wait')
})

test('正式發佈失敗 → 回報一次，不重試', () => {
  const runs = [run('desktop', '0.2.45')]
  let r = step(runs, emptyState(), T0)
  r = step(runs, r.state, T0 + 1, false)
  assert.equal(r.d.action, 'publish')
  assert.match(r.report, /正式發佈失敗/)
  assert.equal(r.state.done['desktop@0.2.45'].result, 'publish-failed')
  assert.equal(decide({ runs, state: r.state, now: T0 + 2 }).action, 'wait')
})

test('run 失敗或取消 → 回報一次，之後不再做', () => {
  for (const conclusion of ['failure', 'cancelled']) {
    const runs = [run('desktop', '0.2.45', { conclusion })]
    const d = decide({ runs, state: emptyState(), now: T0 })
    assert.equal(d.action, 'report')
    assert.equal(d.state.done['desktop@0.2.45'].result, 'ci-failed')
    assert.match(d.message, /desktop@0\.2\.45/)
    assert.equal(decide({ runs, state: d.state, now: T0 + 1 }).action, 'wait')
  }
})

test('有 inflight → wait；超過 2 小時 → 回報 stale 且不重跑', () => {
  const runs = [run('desktop', '0.2.45')]
  const d1 = decide({ runs, state: emptyState(), now: T0 })
  assert.equal(d1.action, 'dryRun')
  const busy = d1.state
  // 子程序還在跑：另一個全綠的版本也不准開始
  const more = [...runs, run('linux', '0.2.45')]
  assert.equal(decide({ runs: more, state: busy, now: T0 + 60_000 }).action, 'wait')
  assert.equal(decide({ runs: more, state: busy, now: T0 + 2 * 3600_000 }).action, 'wait', '剛好 2 小時還不算')
  const d2 = decide({ runs: more, state: busy, now: T0 + 2 * 3600_000 + 1 })
  assert.equal(d2.action, 'report')
  assert.match(d2.message, /2 小時/)
  assert.equal(d2.state.done['desktop@0.2.45'].result, 'stale')
  assert.equal(d2.state.inflight, null)
  assert.equal(decide({ runs, state: d2.state, now: T0 + 3 * 3600_000 }).action, 'wait', 'stale 不重跑')
})

test('同一版多個 run 取 createdAt 最新的', () => {
  const old = run('desktop', '0.2.45', { runId: 'old', conclusion: 'failure', createdAt: '2026-11-21T08:00:00Z' })
  const fresh = run('desktop', '0.2.45', { runId: 'fresh', createdAt: '2026-11-21T09:30:00Z' })
  const d = decide({ runs: [fresh, old], state: emptyState(), now: T0 })
  assert.equal(d.action, 'dryRun')
  assert.equal(d.runId, 'fresh')
  const d2 = decide({ runs: [old, { ...fresh, status: 'in_progress', conclusion: null }], state: emptyState(), now: T0 })
  assert.equal(d2.action, 'wait', '最新的還在跑，不拿舊的失敗去報')
})

test('舊版本不理；版號用數字比較', () => {
  let s = emptyState()
  s.done['desktop@0.2.10'] = { result: 'published', at: 'x', runId: 'r' }
  const runs = [run('desktop', '0.2.9')]
  assert.equal(decide({ runs, state: s, now: T0 }).action, 'wait', '0.2.9 比 0.2.10 舊')
  const d = decide({ runs: [run('desktop', '0.2.9'), run('desktop', '0.2.11')], state: s, now: T0 })
  assert.equal(d.action, 'dryRun')
  assert.equal(d.key, 'desktop@0.2.11')
  // 失敗過的版本也算進「最大版號」，更舊的不理
  s = emptyState()
  s.done['desktop@0.2.9'] = { result: 'ci-failed', at: 'x', runId: 'r' }
  assert.equal(decide({ runs: [run('desktop', '0.2.8')], state: s, now: T0 }).action, 'wait')
})

test('done 已有的 key 不論成功失敗都不再做', () => {
  for (const result of ['published', 'ci-failed', 'dryrun-failed', 'publish-failed', 'stale', 'blocked']) {
    const s = emptyState()
    s.done['desktop@0.2.45'] = { result, at: 'x', runId: 'r' }
    assert.equal(decide({ runs: [run('desktop', '0.2.45')], state: s, now: T0 }).action, 'wait')
  }
})

test('Linux 一定要等同版電腦版 published；綠得早也 wait', () => {
  const runs = [run('desktop', '0.2.45', { status: 'in_progress', conclusion: null }), run('linux', '0.2.45')]
  assert.equal(decide({ runs, state: emptyState(), now: T0 }).action, 'wait')
  // 電腦版全綠但還沒發完：先做電腦版，不碰 Linux
  const runs2 = [run('desktop', '0.2.45'), run('linux', '0.2.45')]
  let r = step(runs2, emptyState(), T0)
  assert.equal(r.d.platform, 'desktop')
  assert.equal(decide({ runs: [run('linux', '0.2.45')], state: r.state, now: T0 + 1 }).action, 'publish', '待正式的電腦版先發')
  r = step(runs2, r.state, T0 + 1)
  assert.equal(r.state.done['desktop@0.2.45'].result, 'published')
  r = step(runs2, r.state, T0 + 2)
  assert.equal(r.d.action, 'dryRun')
  assert.equal(r.d.key, 'linux@0.2.45')
  assert.equal(r.d.tag, 'linux-v0.2.45')
})

test('電腦版沒發成 → Linux 同版記 blocked、回報一次、不自動跑', () => {
  const cases = {
    'ci-failed': (s) => { s.done['desktop@0.2.45'] = { result: 'ci-failed', at: 'x', runId: 'r' } },
    'dryrun-failed': (s) => { s.done['desktop@0.2.45'] = { result: 'dryrun-failed', at: 'x', runId: 'r' } },
    'publish-failed': (s) => { s.done['desktop@0.2.45'] = { result: 'publish-failed', at: 'x', runId: 'r' } },
    stale: (s) => { s.done['desktop@0.2.45'] = { result: 'stale', at: 'x', runId: 'r' } },
  }
  for (const [name, setup] of Object.entries(cases)) {
    const s = emptyState()
    setup(s)
    const runs = [run('linux', '0.2.45')]
    const d = decide({ runs, state: s, now: T0 })
    assert.equal(d.action, 'report', name)
    assert.match(d.message, /Linux 等人工處理/)
    assert.equal(d.state.done['linux@0.2.45'].result, 'blocked')
    assert.equal(decide({ runs, state: d.state, now: T0 + 1 }).action, 'wait', name)
  }
})

test('電腦版紅 → 整串（ci 失敗到 Linux 封鎖）各只報一次，不改走別的路', () => {
  const runs = [run('desktop', '0.2.45', { conclusion: 'failure' }), run('linux', '0.2.45')]
  let s = emptyState()
  const actions = []
  for (let i = 0; i < 5; i++) {
    const d = decide({ runs, state: s, now: T0 + i })
    actions.push(d.action)
    s = d.state
  }
  assert.deepEqual(actions, ['report', 'report', 'wait', 'wait', 'wait'])
  assert.equal(s.done['desktop@0.2.45'].result, 'ci-failed')
  assert.equal(s.done['linux@0.2.45'].result, 'blocked')
})

test('電腦版和 Linux 各自獨立（不同版號時一邊失敗不影響另一邊）', () => {
  // Linux 0.2.44 已發、電腦版 0.2.44 已發；新版 0.2.45 電腦版失敗，Linux 0.2.44 補打不受影響
  const s = emptyState()
  s.done['desktop@0.2.44'] = { result: 'published', at: 'x', runId: 'r' }
  const runs = [run('desktop', '0.2.45', { conclusion: 'failure' }), run('linux', '0.2.44')]
  const d = decide({ runs, state: s, now: T0 })
  assert.equal(d.action, 'report')
  assert.equal(d.key, 'desktop@0.2.45')
  const d2 = decide({ runs, state: d.state, now: T0 + 1 })
  assert.equal(d2.action, 'dryRun')
  assert.equal(d2.key, 'linux@0.2.44')
})

test('每一輪最多一件事：同時有多件可做，一輪只回一個動作並佔住 inflight', () => {
  const runs = [run('desktop', '0.2.45'), run('linux', '0.2.45'), run('desktop', '0.2.46')]
  let s = emptyState()
  s.done['desktop@0.2.44'] = { result: 'published', at: 'x', runId: 'r' }
  const d = decide({ runs, state: s, now: T0 })
  assert.equal(d.action, 'dryRun')
  assert.equal(d.key, 'desktop@0.2.45')
  assert.ok(d.state.inflight)
  assert.equal(decide({ runs, state: d.state, now: T0 + 1 }).action, 'wait')
})

test('decide 不改傳進來的 state', () => {
  const s = emptyState()
  const snap = JSON.stringify(s)
  decide({ runs: [run('desktop', '0.2.45')], state: s, now: T0 })
  assert.equal(JSON.stringify(s), snap)
  assert.equal(s.v, 1)
})

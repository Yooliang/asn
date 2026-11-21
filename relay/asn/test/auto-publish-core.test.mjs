import test from 'node:test'
import assert from 'node:assert/strict'
import { decide, applyResult, emptyState, seed, acknowledge, compareVersions } from '../../../tools/release/auto_publish_core.mjs'

// 已播種（起點 0.0.0，等於什麼舊版都不擋）的乾淨 state
const seededState = () => seed(emptyState(), { since: { desktop: '0.0.0', linux: '0.0.0' }, now: 0 }).state
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
    const d = decide({ runs: [run('desktop', '0.2.45', { status, conclusion: null })], state: seededState(), now: T0 })
    assert.equal(d.action, 'wait')
  }
  assert.equal(decide({ runs: [], state: seededState(), now: T0 }).action, 'wait')
})

test('全綠 → dryRun → 成功 → publish → 成功 → 之後都 wait', () => {
  const runs = [run('desktop', '0.2.45')]
  let s = seededState()
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
  const r = step(runs, seededState(), T0, false)
  assert.equal(r.d.action, 'dryRun')
  assert.match(r.report, /試跑/)
  assert.equal(r.state.done['desktop@0.2.45'].result, 'dryrun-failed')
  assert.equal(r.state.inflight, null)
  assert.equal(decide({ runs, state: r.state, now: T0 + 1 }).action, 'wait')
})

test('正式發佈失敗 → 回報一次，不重試', () => {
  const runs = [run('desktop', '0.2.45')]
  let r = step(runs, seededState(), T0)
  r = step(runs, r.state, T0 + 1, false)
  assert.equal(r.d.action, 'publish')
  assert.match(r.report, /正式發佈失敗/)
  assert.equal(r.state.done['desktop@0.2.45'].result, 'publish-failed')
  assert.equal(decide({ runs, state: r.state, now: T0 + 2 }).action, 'wait')
})

test('run 失敗或取消 → 回報一次，之後不再做', () => {
  for (const conclusion of ['failure', 'cancelled']) {
    const runs = [run('desktop', '0.2.45', { conclusion })]
    const d = decide({ runs, state: seededState(), now: T0 })
    assert.equal(d.action, 'report')
    assert.equal(d.state.done['desktop@0.2.45'].result, 'ci-failed')
    assert.match(d.message, /desktop@0\.2\.45/)
    assert.equal(decide({ runs, state: d.state, now: T0 + 1 }).action, 'wait')
  }
})

test('有 inflight → wait；超過 2 小時 → 回報 stale 且不重跑', () => {
  const runs = [run('desktop', '0.2.45')]
  const d1 = decide({ runs, state: seededState(), now: T0 })
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
  const d = decide({ runs: [fresh, old], state: seededState(), now: T0 })
  assert.equal(d.action, 'dryRun')
  assert.equal(d.runId, 'fresh')
  const d2 = decide({ runs: [old, { ...fresh, status: 'in_progress', conclusion: null }], state: seededState(), now: T0 })
  assert.equal(d2.action, 'wait', '最新的還在跑，不拿舊的失敗去報')
})

test('舊版本不理；版號用數字比較', () => {
  let s = seededState()
  s.done['desktop@0.2.10'] = { result: 'published', at: 'x', runId: 'r' }
  const runs = [run('desktop', '0.2.9')]
  assert.equal(decide({ runs, state: s, now: T0 }).action, 'wait', '0.2.9 比 0.2.10 舊')
  const d = decide({ runs: [run('desktop', '0.2.9'), run('desktop', '0.2.11')], state: s, now: T0 })
  assert.equal(d.action, 'dryRun')
  assert.equal(d.key, 'desktop@0.2.11')
  // 失敗過的版本也算進「最大版號」，更舊的不理
  s = seededState()
  s.done['desktop@0.2.9'] = { result: 'ci-failed', at: 'x', runId: 'r' }
  assert.equal(decide({ runs: [run('desktop', '0.2.8')], state: s, now: T0 }).action, 'wait')
})

test('done 已有的 key 不論成功失敗都不再做', () => {
  for (const result of ['published', 'ci-failed', 'dryrun-failed', 'publish-failed', 'stale', 'blocked']) {
    const s = seededState()
    s.done['desktop@0.2.45'] = { result, at: 'x', runId: 'r' }
    assert.equal(decide({ runs: [run('desktop', '0.2.45')], state: s, now: T0 }).action, 'wait')
  }
})

test('Linux 一定要等同版電腦版 published；綠得早也 wait', () => {
  const runs = [run('desktop', '0.2.45', { status: 'in_progress', conclusion: null }), run('linux', '0.2.45')]
  assert.equal(decide({ runs, state: seededState(), now: T0 }).action, 'wait')
  // 電腦版全綠但還沒發完：先做電腦版，不碰 Linux
  const runs2 = [run('desktop', '0.2.45'), run('linux', '0.2.45')]
  let r = step(runs2, seededState(), T0)
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
    const s = seededState()
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
  let s = seededState()
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
  const s = seededState()
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
  let s = seededState()
  s.done['desktop@0.2.44'] = { result: 'published', at: 'x', runId: 'r' }
  const d = decide({ runs, state: s, now: T0 })
  assert.equal(d.action, 'dryRun')
  assert.equal(d.key, 'desktop@0.2.45')
  assert.ok(d.state.inflight)
  assert.equal(decide({ runs, state: d.state, now: T0 + 1 }).action, 'wait')
})

test('decide 不改傳進來的 state', () => {
  const s = seededState()
  const snap = JSON.stringify(s)
  decide({ runs: [run('desktop', '0.2.45')], state: s, now: T0 })
  assert.equal(JSON.stringify(s), snap)
  assert.equal(s.v, 1)
})

test('沒播種：回報要播種、不處理任何版本，只報一次', () => {
  const runs = [run('desktop', '0.2.45')]
  const d = decide({ runs, state: emptyState(), now: T0 })
  assert.equal(d.action, 'report')
  assert.match(d.message, /播種/)
  assert.equal(d.state.inflight, null)
  assert.deepEqual(d.state.done, {})
  assert.equal(decide({ runs, state: d.state, now: T0 + 1 }).action, 'wait')
})

test('播種後：舊版（含起點）不發，只發比起點新的', () => {
  const r = seed(emptyState(), { since: { desktop: '0.2.44', linux: '0.2.44' }, now: T0 })
  assert.equal(r.ok, true)
  assert.equal(r.state.done['desktop@0.2.44'].result, 'seeded')
  assert.equal(r.state.done['linux@0.2.44'].result, 'seeded')
  const old = [run('desktop', '0.2.43'), run('desktop', '0.2.44'), run('linux', '0.2.44')]
  assert.equal(decide({ runs: old, state: r.state, now: T0 }).action, 'wait')
  const d = decide({ runs: [...old, run('desktop', '0.2.45')], state: r.state, now: T0 })
  assert.equal(d.action, 'dryRun')
  assert.equal(d.key, 'desktop@0.2.45')
})

test('重複播種、已有紀錄、版號格式錯：被拒', () => {
  const since = { desktop: '0.2.44', linux: '0.2.44' }
  const r = seed(emptyState(), { since, now: T0 })
  assert.equal(seed(r.state, { since, now: T0 }).ok, false)
  const s = emptyState()
  s.done['desktop@0.2.45'] = { result: 'published', at: 'x', runId: 'r' }
  assert.equal(seed(s, { since, now: T0 }).ok, false)
  assert.equal(seed(emptyState(), { since: { desktop: 'x', linux: '0.2.44' }, now: T0 }).ok, false)
})

test('有失敗：更新的版本暫停（兩個平台都停），只回報一次', () => {
  const runs = [run('desktop', '0.2.45', { conclusion: 'failure' }), run('desktop', '0.2.46'), run('linux', '0.2.44')]
  let s = seededState()
  s.done['linux@0.2.40'] = { result: 'published', at: 'x', runId: 'r' }
  let d = decide({ runs, state: s, now: T0 })
  assert.equal(d.key, 'desktop@0.2.45') // 失敗本身的回報
  s = d.state
  d = decide({ runs, state: s, now: T0 + 1 })
  assert.equal(d.action, 'report')
  assert.match(d.message, /暫停/)
  s = d.state
  for (let i = 0; i < 3; i++) {
    d = decide({ runs, state: s, now: T0 + 2 + i })
    assert.equal(d.action, 'wait', '之後都 wait，不重複回報')
    s = d.state
  }
  // 另一個平台的更新版也停
  const d2 = decide({ runs: [run('linux', '0.2.46')], state: s, now: T0 + 10 })
  assert.equal(d2.action, 'wait')
})

test('acknowledge 之後恢復處理新版', () => {
  const runs = [run('desktop', '0.2.45', { conclusion: 'failure' }), run('desktop', '0.2.46')]
  let s = decide({ runs, state: seededState(), now: T0 }).state
  s = decide({ runs, state: s, now: T0 + 1 }).state // 暫停回報
  assert.equal(decide({ runs, state: s, now: T0 + 2 }).action, 'wait')
  s = acknowledge(s, 'desktop@0.2.45', T0 + 3)
  assert.ok(s.done['desktop@0.2.45'].ackedAt)
  assert.equal(s.pausedNoticed, false)
  const d = decide({ runs, state: s, now: T0 + 4 })
  assert.equal(d.action, 'dryRun')
  assert.equal(d.key, 'desktop@0.2.46')
  assert.throws(() => acknowledge(s, 'desktop@9.9.9', T0))
})

test('applyResult：done 已有的 key 不覆寫', () => {
  const s = seededState()
  s.done['desktop@0.2.45'] = { result: 'ci-failed', at: 'old', runId: 'r0' }
  const r = applyResult(s, { key: 'desktop@0.2.45', step: 'publish', ok: true, now: T0 })
  assert.deepEqual(r.state.done['desktop@0.2.45'], { result: 'ci-failed', at: 'old', runId: 'r0' })
  assert.match(r.log, /不覆寫/)
  assert.equal(r.report, null)
})

test('版號格式錯：compareVersions 丟錯；decide 略過那一筆並記在 notes，不掛', () => {
  assert.throws(() => compareVersions('0.2', '0.2.1'))
  assert.throws(() => compareVersions('0.2.x', '0.2.1'))
  assert.throws(() => compareVersions('v0.2.1', '0.2.1'))
  const d = decide({ runs: [run('desktop', 'abc'), run('desktop', '0.2.45')], state: seededState(), now: T0 })
  assert.equal(d.action, 'dryRun')
  assert.equal(d.key, 'desktop@0.2.45')
  assert.equal(d.notes.length, 1)
  assert.match(d.notes[0], /abc/)
  assert.deepEqual(decide({ runs: [run('desktop', 'abc')], state: seededState(), now: T0 }).action, 'wait')
})

test('#4562 seeded:true 但 done 看不到起點（手改、寫到一半）→ 當成沒播種，不從最舊的綠燈重發', () => {
  const st = { ...emptyState(), seeded: true }
  const runs = [run('desktop', '0.2.40'), run('desktop', '0.2.45')]
  const d = decide({ runs, state: st, now: T0 })
  assert.equal(d.action, 'report')
  assert.equal(d.result, 'unseeded')
  assert.equal(decide({ runs, state: d.state, now: T0 }).action, 'wait', '只報一次')
  // 只有一個平台有起點也不算
  const half = { ...emptyState(), seeded: true, done: { 'desktop@0.2.44': { result: 'seeded', at: 'x', runId: null } } }
  assert.equal(decide({ runs, state: half, now: T0 }).action, 'report')
})

test('#4563 起點存在 state.since：done 被清空也不回頭發 since 以前的版本；maxDone 取 since 與 done 的最大值', () => {
  const st = seed(emptyState(), { since: { desktop: '0.2.44', linux: '0.2.44' }, now: 0 }).state
  assert.deepEqual(st.since, { desktop: '0.2.44', linux: '0.2.44' })
  const wiped = { ...st, done: {} } // 手改把 done 清掉
  const d1 = decide({ runs: [run('desktop', '0.2.40'), run('desktop', '0.2.44')], state: wiped, now: T0 })
  assert.equal(d1.action, 'wait', 'since 以前（含）不發')
  const d2 = decide({ runs: [run('desktop', '0.2.40'), run('desktop', '0.2.45')], state: wiped, now: T0 })
  assert.equal(d2.action, 'dryRun')
  assert.equal(d2.tag, 'v0.2.45')
  // since 格式壞掉 → 當成沒播種
  assert.equal(decide({ runs: [], state: { ...st, since: { desktop: 'x', linux: '0.2.44' } }, now: T0 }).result, 'unseeded')
})

test('acknowledge 只准清失敗類：published／seeded 拒絕，五種失敗都可清', () => {
  for (const result of ['ci-failed', 'dryrun-failed', 'publish-failed', 'stale', 'blocked']) {
    const s = seededState(); s.done['desktop@0.2.45'] = { result, at: 'x', runId: '1' }
    assert.ok(acknowledge(s, 'desktop@0.2.45', T0).done['desktop@0.2.45'].ackedAt, result)
  }
  const s = seededState(); s.done['desktop@0.2.45'] = { result: 'published', at: 'x', runId: '1' }
  assert.throws(() => acknowledge(s, 'desktop@0.2.45', T0), /不是失敗類/)
  assert.throws(() => acknowledge(s, 'desktop@0.0.0', T0), /不是失敗類/)
})

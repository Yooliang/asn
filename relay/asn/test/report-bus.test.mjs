// 回報匯流排前端訂閱（#2161 2c-2）：假 api、假計時器、假門鈴、假前景事件
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createReportBus, isNewer, backoffMs, BATCH_MAX, POLL_MS, FAIL_WAIT_MS, BACKOFF_MAX_MS } from '../ui/lib/report-bus.mjs'

const UI = fileURLToPath(new URL('../ui', import.meta.url))

// 假時鐘：advance 會依序觸發到期的計時器，now 同步前進
function makeClock() {
  let t = 1000, seq = 0
  const timers = new Map()
  return {
    now: () => t,
    setTimer: (f, ms) => { const id = ++seq; timers.set(id, { at: t + ms, f }); return id },
    clearTimer: id => { timers.delete(id) },
    count: () => timers.size,
    async advance(ms) {
      const end = t + ms
      for (;;) {
        let best = null
        for (const [id, x] of timers) if (x.at <= end && (!best || x.at < best[1].at)) best = [id, x]
        if (!best) break
        timers.delete(best[0]); t = Math.max(t, best[1].at); best[1].f()
        await flush()
      }
      t = end
      await flush()
    },
  }
}
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve() }

function setup(opts = {}) {
  const clock = makeClock()
  const calls = [], times = []
  const store = new Map()   // `${kind}\n${node}` -> report
  let gate = null, fail = false
  const api = {
    get: async (kind, nodes) => {
      calls.push({ kind, nodes: [...nodes] }); times.push(clock.now())
      if (gate) await gate.promise
      if (fail) { const e = new Error('讀不到'); if (fail === 'permanent') e.permanent = true; throw e }
      return { ok: true, reports: nodes.map(n => store.get(`${kind}\n${n}`)).filter(Boolean) }
    },
  }
  let bell = null, vis = null, visible = true, offBell = 0, offVis = 0
  const bus = createReportBus({
    api, now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer,
    onReport: cb => { bell = cb; return () => { offBell++; bell = null } },
    isVisible: () => visible, onVisible: cb => { vis = cb; return () => { offVis++; vis = null } },
    ...opts,
  })
  const put = (kind, node, changed_at, payload = { v: changed_at }, updated_at = changed_at) => store.set(`${kind}\n${node}`, { node, kind, payload, updated_at, changed_at })
  return {
    clock, calls, times, bus, put,
    ring: (kind, node) => bell({ kind, node }),
    foreground: () => { visible = true; vis() },
    setVisible: v => { visible = v },
    setFail: v => { fail = v },
    hold: () => { let res; gate = { promise: new Promise(r => { res = r }), release: () => { gate = null; res() } }; return gate },
    offs: () => ({ offBell, offVis }),
  }
}
const quietWarn = fn => async () => { const w = console.warn; const logs = []; console.warn = (...a) => logs.push(a.join(' ')); try { await fn(logs) } finally { console.warn = w } }

test('訂閱時走合併立刻讀一次，並把最新值給 cb', async () => {
  const s = setup(); s.put('acct', 'n1', 5)
  const got = []
  s.bus.subscribe('acct', 'n1', r => got.push(r))
  assert.equal(s.calls.length, 0)
  await s.clock.advance(300)
  assert.deepEqual(s.calls, [{ kind: 'acct', nodes: ['n1'] }])
  assert.deepEqual(got, [{ node: 'n1', kind: 'acct', payload: { v: 5 }, updated_at: 5, changed_at: 5 }])
})

test('合併：同 kind 多台門鈴只一次批次讀（去重）', async () => {
  const s = setup(); for (const n of ['a', 'b', 'c']) { s.put('k', n, 1); s.bus.subscribe('k', n, () => {}) }
  await s.clock.advance(300); s.calls.length = 0
  s.ring('k', 'a'); s.ring('k', 'b'); s.ring('k', 'a'); s.ring('k', 'c')
  await s.clock.advance(299); assert.equal(s.calls.length, 0, '300 毫秒內不讀')
  await s.clock.advance(1)
  assert.equal(s.calls.length, 1)
  assert.deepEqual(s.calls[0].nodes.sort(), ['a', 'b', 'c'])
})

test('debounce：每來一個門鈴重新等 300 毫秒，但從第一個算起最長 1 秒', async () => {
  const s = setup(); s.bus.subscribe('k', 'a', () => {}); await s.clock.advance(300); s.calls.length = 0
  // 每 200 毫秒敲一次：永遠等不到 300 毫秒靜默，最長 1 秒就必須讀
  s.ring('k', 'a')
  for (let i = 0; i < 4; i++) { await s.clock.advance(200); s.ring('k', 'a') }
  assert.equal(s.calls.length, 0, '800 毫秒時還沒讀')
  await s.clock.advance(200)   // 第 1000 毫秒
  assert.equal(s.calls.length, 1, '最長 1 秒必讀')
  // 靜默 300 毫秒就讀
  s.ring('k', 'a'); await s.clock.advance(150); s.ring('k', 'a')
  await s.clock.advance(299); assert.equal(s.calls.length, 1)
  await s.clock.advance(1); assert.equal(s.calls.length, 2)
})

test('在途序列化：同 kind 同時只有一個請求，在途時新來的排進下一批', async () => {
  const s = setup(); for (const n of ['a', 'b']) { s.put('k', n, 1); s.bus.subscribe('k', n, () => {}) }
  await s.clock.advance(300); s.calls.length = 0
  const g = s.hold()
  s.ring('k', 'a'); await s.clock.advance(300)
  assert.equal(s.calls.length, 1)
  s.ring('k', 'b'); await s.clock.advance(2000)
  assert.equal(s.calls.length, 1, '在途時不發第二個')
  g.release(); await s.clock.advance(0)
  await s.clock.advance(300)
  assert.equal(s.calls.length, 2)
  assert.deepEqual(s.calls[1].nodes, ['b'])
})

test('不同 kind 互不影響（在途與合併各自獨立）', async () => {
  const s = setup(); s.bus.subscribe('x', 'a', () => {}); s.bus.subscribe('y', 'a', () => {})
  await s.clock.advance(300); s.calls.length = 0
  const g = s.hold()
  s.ring('x', 'a'); await s.clock.advance(300)
  s.ring('y', 'a'); await s.clock.advance(300)
  assert.deepEqual(s.calls.map(c => c.kind), ['x', 'y'])
  g.release(); await s.clock.advance(0)
})

test('只有 changed_at 變新才通知；保活（只有 updated_at 變）不重複通知', async () => {
  const s = setup(); const got = []
  s.put('k', 'a', 10); s.bus.subscribe('k', 'a', r => got.push(r.changed_at))
  await s.clock.advance(300); assert.deepEqual(got, [10])
  s.put('k', 'a', 10, { v: 10 }, 99); s.ring('k', 'a'); await s.clock.advance(300)
  assert.deepEqual(got, [10], '保活不通知')
  s.put('k', 'a', 20); s.ring('k', 'a'); await s.clock.advance(300)
  assert.deepEqual(got, [10, 20])
  s.put('k', 'a', 15); s.ring('k', 'a'); await s.clock.advance(300)
  assert.deepEqual(got, [10, 20], '比較舊的不通知')
})

test('isNewer：數字、ISO 時間、字串', () => {
  assert.ok(isNewer(2, 1)); assert.ok(!isNewer(1, 1)); assert.ok(isNewer(1, undefined))
  assert.ok(isNewer('2026-11-24T10:00:01Z', '2026-11-24T10:00:00Z')); assert.ok(!isNewer('2026-11-24T10:00:00Z', '2026-11-24T10:00:00Z'))
})

test(`超過 ${BATCH_MAX} 個切批、批間序列`, async () => {
  const s = setup(); const nodes = Array.from({ length: 120 }, (_, i) => `n${i}`)
  for (const n of nodes) { s.put('k', n, 1); s.bus.subscribe('k', n, () => {}) }
  await s.clock.advance(300)
  assert.deepEqual(s.calls.map(c => c.nodes.length), [50, 50, 20])
  assert.equal(new Set(s.calls.flatMap(c => c.nodes)).size, 120)
})

test('回到前景讀一次（所有有訂閱者的 kind）', async () => {
  const s = setup(); s.bus.subscribe('x', 'a', () => {}); s.bus.subscribe('y', 'b', () => {})
  await s.clock.advance(300); s.calls.length = 0
  s.foreground(); await s.clock.advance(300)
  assert.deepEqual(s.calls.map(c => c.kind).sort(), ['x', 'y'])
})

test('5 分鐘後援：可見才讀、背景不讀', async () => {
  const s = setup(); s.bus.subscribe('k', 'a', () => {}); await s.clock.advance(300); s.calls.length = 0
  await s.clock.advance(POLL_MS - 400); assert.equal(s.calls.length, 0)
  await s.clock.advance(400 + 300); assert.equal(s.calls.length, 1)
  s.setVisible(false); await s.clock.advance(POLL_MS + 300); assert.equal(s.calls.length, 1, '背景不讀')
  s.setVisible(true); await s.clock.advance(POLL_MS + 300); assert.equal(s.calls.length, 2, '之後仍照排')
})

test('讀失敗：不拋、只記一次 warn（無內容）、至少隔 5 秒才再試、恢復後照常', quietWarn(async logs => {
  const s = setup(); const got = []
  s.put('k', 'a', 1, { secret: 'TOPSECRET' }); s.bus.subscribe('k', 'a', r => got.push(r.changed_at))
  s.setFail(true)
  await s.clock.advance(300)
  assert.equal(s.calls.length, 1); assert.equal(logs.length, 1)
  assert.ok(logs[0].includes('k') && !logs[0].includes('TOPSECRET'))
  s.ring('k', 'a'); await s.clock.advance(FAIL_WAIT_MS - 1000)
  assert.equal(s.calls.length, 1, '失敗後 5 秒內不再試')
  s.setFail(false); await s.clock.advance(FAIL_WAIT_MS)
  assert.equal(s.calls.length, 2); assert.deepEqual(got, [1])
}))

test('連續失敗只在第 1、5、20 次記 warn，恢復後計數歸零', quietWarn(async logs => {
  const s = setup(); s.put('k', 'a', 1); s.bus.subscribe('k', 'a', () => {})
  s.setFail(true)
  await s.clock.advance(300)
  for (let i = 0; i < 2000 && s.calls.length < 21; i++) await s.clock.advance(10000)
  assert.equal(s.calls.length, 21, `共 ${s.calls.length} 次讀取`)
  assert.equal(logs.length, 3)
  assert.deepEqual(logs.map(l => l.match(/第 (\d+) 次/)[1]), ['1', '5', '20'])
  s.setFail(false); await s.clock.advance(BACKOFF_MAX_MS + 1000)
  s.setFail(true); s.ring('k', 'a'); await s.clock.advance(1000)
  assert.equal(logs.length, 4, '恢復後重新從第 1 次算')
}))

test('退避：連續失敗間隔 5、10、20…秒、300 秒封頂，成功歸零', quietWarn(async () => {
  const s = setup(); s.put('k', 'a', 1); s.bus.subscribe('k', 'a', () => {})
  s.setFail(true)
  for (let i = 0; i < 4000 && s.calls.length < 12; i++) await s.clock.advance(1000)
  const gaps = s.times.slice(1).map((t, i) => t - s.times[i])
  assert.deepEqual(gaps, [5000, 10000, 20000, 40000, 80000, 160000, 300000, 300000, 300000, 300000, 300000])
  assert.deepEqual([1, 2, 3, 7, 8, 40].map(backoffMs), [5000, 10000, 20000, 300000, 300000, 300000])
  s.setFail(false)
  for (let i = 0; i < 400 && s.calls.length < 13; i++) await s.clock.advance(1000)
  s.setFail(true); s.ring('k', 'a')
  const n = s.calls.length; const t0 = s.clock.now()
  for (let i = 0; i < 100 && s.calls.length < n + 2; i++) await s.clock.advance(1000)
  assert.equal(s.times[n + 1] - s.times[n], 5000, '成功之後從 5 秒重新起算')
  assert.ok(t0 > 0)
}))

test('退避期間來的門鈴、訂閱、後援只記待讀，到期才讀一次', quietWarn(async () => {
  const s = setup(); s.put('k', 'a', 1); s.put('k', 'b', 1); s.bus.subscribe('k', 'a', () => {})
  s.setFail(true); await s.clock.advance(300)   // 第 1 次失敗，退避到 +5000
  s.ring('k', 'a'); s.bus.subscribe('k', 'b', () => {}); s.ring('k', 'b'); await s.clock.advance(4000)
  assert.equal(s.calls.length, 1, '退避期間不讀')
  s.setFail(false); await s.clock.advance(1000)
  assert.equal(s.calls.length, 2); assert.deepEqual(s.calls[1].nodes.sort(), ['a', 'b'])
}))

test('看不見時不重試：回到前景才恢復；新的門鈴也會讀', quietWarn(async () => {
  const s = setup(); s.put('k', 'a', 1); const got = []; s.bus.subscribe('k', 'a', r => got.push(r.changed_at))
  s.setFail(true); await s.clock.advance(300); assert.equal(s.calls.length, 1)
  s.setVisible(false); s.setFail(false)
  await s.clock.advance(60000); assert.equal(s.calls.length, 1, '背景到期也不讀')
  s.foreground(); await s.clock.advance(300)
  assert.equal(s.calls.length, 2); assert.deepEqual(got, [1])
  // 另一路：背景中來了門鈴，算新的觸發
  s.setFail(true); s.put('k', 'a', 2); s.ring('k', 'a'); await s.clock.advance(300); assert.equal(s.calls.length, 3)
  s.setVisible(false); s.setFail(false); await s.clock.advance(60000); assert.equal(s.calls.length, 3)
  s.ring('k', 'a'); await s.clock.advance(300); assert.equal(s.calls.length, 4); assert.deepEqual(got, [1, 2])
}))

test('永久錯誤：該 kind 暫停，只在下一次門鈴、回前景、後援才再試一次', quietWarn(async () => {
  const s = setup(); s.put('k', 'a', 1); s.bus.subscribe('k', 'a', () => {})
  s.setFail('permanent'); await s.clock.advance(300); assert.equal(s.calls.length, 1)
  await s.clock.advance(POLL_MS - 1000); assert.equal(s.calls.length, 1, '不自動重試（連 5 秒退避也沒有）')
  s.bus.subscribe('k', 'b', () => {}); await s.clock.advance(600); assert.equal(s.calls.length, 1, '新訂閱不算觸發')
  await s.clock.advance(1000); assert.equal(s.calls.length, 2, '後援（5 分鐘）再試一次')
  s.ring('k', 'a'); await s.clock.advance(300); assert.equal(s.calls.length, 3, '門鈴再試一次')
  s.foreground(); await s.clock.advance(300); assert.equal(s.calls.length, 4, '回前景再試一次')
  await s.clock.advance(60000); assert.equal(s.calls.length, 4, '每次觸發只試一次')
}))

test('取消訂閱：到零就停該 kind 與後援；別人還在訂閱就繼續', async () => {
  const s = setup()
  const u1 = s.bus.subscribe('k', 'a', () => {}); const u2 = s.bus.subscribe('k', 'b', () => {})
  await s.clock.advance(300); s.calls.length = 0
  u1(); s.ring('k', 'a'); await s.clock.advance(300); assert.equal(s.calls.length, 0, '沒人訂閱的節點不讀')
  s.ring('k', 'b'); await s.clock.advance(300); assert.equal(s.calls.length, 1)
  u2(); assert.equal(s.clock.count(), 0, '全部取消後沒有殘留計時器（含後援）')
  s.calls.length = 0; s.ring('k', 'b'); s.foreground(); await s.clock.advance(POLL_MS * 2)
  assert.equal(s.calls.length, 0)
})

test('訂閱後、讀取前就取消：不讀', async () => {
  const s = setup(); const u = s.bus.subscribe('k', 'a', () => {}); u()
  await s.clock.advance(2000); assert.equal(s.calls.length, 0)
})

test('後來的訂閱者馬上拿到目前值', async () => {
  const s = setup(); s.put('k', 'a', 7); s.bus.subscribe('k', 'a', () => {}); await s.clock.advance(300)
  const got = []; s.bus.subscribe('k', 'a', r => got.push(r.changed_at)); assert.deepEqual(got, [7])
})

test('一個 cb 丟錯不影響其他訂閱者', quietWarn(async () => {
  const s = setup(); s.put('k', 'a', 1); const got = []
  s.bus.subscribe('k', 'a', () => { throw new Error('boom') }); s.bus.subscribe('k', 'a', r => got.push(r.changed_at))
  await s.clock.advance(300); assert.deepEqual(got, [1])
}))

test('dispose：清掉計時器與監聽，之後什麼都不做；在途回來也不通知', async () => {
  const s = setup(); s.put('k', 'a', 1); const got = []
  s.bus.subscribe('k', 'a', r => got.push(r)); await s.clock.advance(300); got.length = 0
  const g = s.hold(); s.put('k', 'a', 2); s.ring('k', 'a'); await s.clock.advance(300)
  s.bus.dispose(); g.release(); await s.clock.advance(POLL_MS * 2)
  assert.equal(s.clock.count(), 0); assert.deepEqual(s.offs(), { offBell: 1, offVis: 1 }); assert.deepEqual(got, [])
  const n = s.calls.length; s.bus.subscribe('k', 'a', () => {}); await s.clock.advance(5000); assert.equal(s.calls.length, n)
})

// ---- 守門 ----
const walk = d => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)])
const rel = f => path.relative(UI, f).split(path.sep).join('/')

test('守門：ui/ 底下除 tauri.mjs 外沒有 report_send／report_get／relay-report 字串', () => {
  const bad = walk(UI).filter(f => /\.(m?js|html)$/.test(f) && rel(f) !== 'lib/tauri.mjs')
    .filter(f => /report_send|report_get|relay-report/.test(fs.readFileSync(f, 'utf8'))).map(rel)
  assert.deepEqual(bad, [])
  const ex = fs.readFileSync(path.join(UI, 'lib/tauri.mjs'), 'utf8')
  for (const c of ["'report_send'", "'report_get'", "'relay-report-bell'"]) assert.ok(ex.includes(c), c)
})

test('守門：report-bus.mjs 沒有任何 import（依賴全部注入）、不碰 __TAURI__', () => {
  const s = fs.readFileSync(path.join(UI, 'lib/report-bus.mjs'), 'utf8')
  assert.ok(!/^\s*import\b/m.test(s) && !/\bimport\(/.test(s), 'report-bus.mjs 不該 import 任何東西')
  assert.ok(!s.includes('__TAURI__') && !/(?<![\w.$])invoke\(/.test(s))
})

test('守門：reportSend 只透過 tauri.mjs 的 reportApi.send', async () => {
  const s = fs.readFileSync(path.join(UI, 'lib/report-send.mjs'), 'utf8')
  assert.deepEqual([...s.matchAll(/^import .* from '(.+)'/gm)].map(m => m[1]), ['./tauri.mjs'])
  assert.ok(s.includes('reportApi.send(kind, data)'))
})

test('reportApi／onReport：指令名與參數形狀、門鈴取消', async () => {
  const calls = []; let handler = null, unlistened = 0
  const saved = globalThis.__TAURI__
  globalThis.__TAURI__ = {
    core: { invoke: async (c, a) => { calls.push([c, a]); return { ok: true, reports: [] } } },
    event: { listen: async (evt, fn) => { assert.equal(evt, 'relay-report-bell'); handler = fn; return () => { unlistened++ } }, emit: async () => {} },
  }
  try {
    const m = await import(`../ui/lib/tauri.mjs?t=report-${Date.now()}`)
    await m.reportApi.send('k', { a: 1 }); await m.reportApi.get('k', ['n1'])
    assert.deepEqual(calls, [['report_send', { kind: 'k', data: { a: 1 } }], ['report_get', { kind: 'k', nodes: ['n1'] }]])
    const got = []; const off = m.onReport(p => got.push(p)); await flush()
    handler({ payload: { kind: 'k', node: 'n1' } }); assert.deepEqual(got, [{ kind: 'k', node: 'n1' }])
    off(); assert.equal(unlistened, 1)
    const early = m.onReport(() => {}); early(); await flush(); assert.equal(unlistened, 2, '還沒 listen 完就取消也會收掉')
  } finally { globalThis.__TAURI__ = saved }
})

test('reportApi.get：固定白話句對照成 err.permanent，暫時性錯誤不標', async () => {
  const saved = globalThis.__TAURI__
  let msg = ''
  globalThis.__TAURI__ = { core: { invoke: async () => { throw msg } }, event: { listen: async () => () => {}, emit: async () => {} } }
  try {
    const m = await import(`../ui/lib/tauri.mjs?t=perm-${Date.now()}`)
    const w = console.warn; console.warn = () => {}
    try {
      for (const t of ['不認得這種回報', '查詢內容不正確', '回報種類的格式不正確', '設備代號的格式不正確', '請至少指定一台設備', '一次最多查詢 50 台設備']) {
        msg = t; const e = await m.reportApi.get('k', ['n']).catch(x => x); assert.equal(e.permanent, true, t)
      }
      for (const t of ['查詢太頻繁，請稍後再試', '暫時讀不到回報，請稍後再試', '連不上收發室，請稍後再試']) {
        msg = t; const e = await m.reportApi.get('k', ['n']).catch(x => x); assert.notEqual(e.permanent, true, t); assert.equal(e.message, t)
      }
    } finally { console.warn = w }
  } finally { globalThis.__TAURI__ = saved }
})

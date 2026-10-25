// 設備順序同步（ui/lib/device-sync.mjs）：合併規則與控制器（節流、同內容不重送、stale 採用後台的、沒登入不打後台）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PUSH_GAP_MS, canon, createDeviceSync, decide, toRemote, unionSeed } from '../ui/lib/device-sync.mjs'

const L = (o = {}) => ({ deviceOrder: [], deviceShown: [], deviceRemoved: [], deviceRev: 0, deviceSynced: false, ...o })
const R = (o = {}) => ({ order: [], shown: [], removed: [], rev: 1000, ...o })

test('decide：後台是空的——本機也空＝什麼都不推（標記已同步）；本機有值＝推上去', () => {
  assert.deepEqual(decide({ local: L(), remote: null, now: 5 }), { action: 'none', markSynced: true })
  const d = decide({ local: L({ deviceOrder: ['a'] }), remote: null, now: 5 })
  assert.equal(d.action, 'push')
  assert.equal(d.next.rev, 5, '從沒改過（rev 0）的舊值第一次上傳用現在當版本')
  assert.equal(decide({ local: L({ deviceOrder: ['a'], deviceRev: 300 }), remote: null, now: 5 }).next, undefined, '有版本就照原版本推')
})

test('decide：第一次升級（這台從沒同步過）——本機空＝採用後台；兩邊都有值＝聯集當起點、版本比兩邊都新', () => {
  assert.deepEqual(decide({ local: L(), remote: R({ order: ['x'] }), now: 9 }), { action: 'adopt', next: R({ order: ['x'] }) })
  const d = decide({ local: L({ deviceOrder: ['b', 'c'], deviceShown: ['s1'], deviceRev: 2000 }), remote: R({ order: ['a', 'b'], shown: ['s2'], removed: ['r'], rev: 1500 }), now: 1800 })
  assert.equal(d.action, 'push')
  assert.deepEqual(d.next, { order: ['a', 'b', 'c'], shown: ['s2', 's1'], removed: ['r'], rev: 2001 })
  assert.equal(unionSeed(R({ rev: 50 }), L(), 10).rev, 51)
})

test('decide：已同步過——整份以 rev 較新的為準（不取聯集，「恢復」才回復得了）', () => {
  const local = L({ deviceSynced: true, deviceRev: 2000, deviceOrder: ['a'], deviceRemoved: [] })
  assert.deepEqual(decide({ local, remote: R({ order: ['a'], removed: ['x'], rev: 1000 }), now: 3000 }), { action: 'push' }, '本機較新、內容不同＝推')
  const d = decide({ local, remote: R({ order: ['b'], removed: ['x'], rev: 3000 }), now: 3000 })
  assert.equal(d.action, 'adopt'); assert.deepEqual(d.next.removed, ['x'], '後台較新＝整份採用，removed 不跟本機合併')
  assert.equal(decide({ local, remote: R({ order: ['b'], rev: 2000 }), now: 3000 }).action, 'adopt', '一樣新但內容不同：後台的算')
  assert.deepEqual(decide({ local, remote: R({ order: ['a'], rev: 2000 }), now: 3000 }), { action: 'none' }, '內容與版本都一樣＝不動')
  assert.equal(decide({ local, remote: R({ order: ['a'], rev: 2500 }), now: 3000 }).action, 'adopt', '內容一樣、後台版本較新＝跟上版本（免得之後被當成較舊）')
})

test('toRemote／canon：節點鍵去重、壞值當空；canon 只看三個陣列（不看 rev）', () => {
  assert.deepEqual(toRemote({ deviceOrder: ['a', 'a', 1], deviceShown: 'x', deviceRemoved: ['r'], deviceRev: -3 }), { order: ['a'], shown: [], removed: ['r'], rev: 0 })
  assert.equal(canon(L({ deviceOrder: ['a'], deviceRev: 1 })), canon(L({ deviceOrder: ['a'], deviceRev: 99 })))
})

// ---- 控制器：假時鐘與假後台 ----
function rig({ remote = null, signed = true, setImpl } = {}) {
  const clock = { t: 100_000, timers: [] }
  const calls = { get: 0, set: [] }
  const api = {
    async get() { calls.get++; return { prefs: remote } },
    async set(p) { calls.set.push(p); return setImpl ? setImpl(p) : { prefs: { ...p, at: clock.t }, stale: false } },
  }
  const prefs = L()
  const sync = createDeviceSync({
    prefs, api, canSync: async () => signed, now: () => clock.t,
    schedule: (fn, ms) => { const h = { fn, at: clock.t + ms }; clock.timers.push(h); return h },
    clear: h => { clock.timers = clock.timers.filter(x => x !== h) },
  })
  const run = async ms => { clock.t += ms; for (const h of clock.timers.filter(x => x.at <= clock.t)) { clock.timers = clock.timers.filter(x => x !== h); h.fn(); await Promise.resolve(); await Promise.resolve() } }
  return { prefs, sync, calls, clock, run, tick: () => new Promise(r => setImmediate(r)) }
}

test('控制器：本機改了才更新 rev 並排推送；內容沒變不推、不改 rev', async () => {
  const t = rig()
  t.prefs.deviceOrder = ['a']
  t.sync.noteLocal()
  assert.equal(t.prefs.deviceRev, 100_000)
  t.sync.noteLocal()   // 沒變
  assert.equal(t.prefs.deviceRev, 100_000)
  await t.run(0); await t.tick()
  assert.equal(t.calls.set.length, 1)
  assert.deepEqual(t.calls.set[0], { order: ['a'], shown: [], removed: [], rev: 100_000 })
  assert.equal(t.prefs.deviceSynced, true)
  await t.sync.push()   // 同內容同版本不重送
  assert.equal(t.calls.set.length, 1)
})

test('控制器：連續改動合併成一次推送，兩次推送至少隔 5 秒', async () => {
  const t = rig()
  t.prefs.deviceOrder = ['a']; t.sync.noteLocal()
  await t.run(0); await t.tick()
  assert.equal(t.calls.set.length, 1)
  t.clock.t += 1000
  t.prefs.deviceOrder = ['b']; t.sync.noteLocal()
  t.clock.t += 500
  t.prefs.deviceOrder = ['c']; t.sync.noteLocal()
  await t.run(100); await t.tick()
  assert.equal(t.calls.set.length, 1, '還沒滿 5 秒')
  await t.run(PUSH_GAP_MS); await t.tick()
  assert.equal(t.calls.set.length, 2)
  assert.deepEqual(t.calls.set[1].order, ['c'], '推的是最後的內容')
})

test('控制器：沒登入不打後台；推送被後台回 stale 就改採用後台的（不覆蓋）', async () => {
  const off = rig({ signed: false })
  off.prefs.deviceOrder = ['a']; off.sync.noteLocal(); await off.run(0); await off.tick(); await off.sync.pull()
  assert.equal(off.calls.set.length + off.calls.get, 0)

  const remote = R({ order: ['z'], rev: 999_999 })
  const t = rig({ remote: null, setImpl: () => ({ prefs: remote, stale: true }) })
  t.prefs.deviceOrder = ['a']; t.sync.noteLocal(); await t.run(0); await t.tick()
  assert.deepEqual(t.prefs.deviceOrder, ['z']); assert.equal(t.prefs.deviceRev, 999_999); assert.equal(t.prefs.deviceSynced, true)
  t.sync.noteLocal()   // 採用後台的不算本機改動
  assert.equal(t.prefs.deviceRev, 999_999)
})

test('控制器：啟動拉到後台較新的就整份採用，採用之後不會被當成本機改動再推回去', async () => {
  const t = rig({ remote: R({ order: ['r1', 'r2'], removed: ['gone'], rev: 7777 }) })
  await t.sync.pull()
  assert.deepEqual(t.prefs.deviceOrder, ['r1', 'r2']); assert.deepEqual(t.prefs.deviceRemoved, ['gone']); assert.equal(t.prefs.deviceRev, 7777)
  t.sync.noteLocal(); await t.run(PUSH_GAP_MS); await t.tick()
  assert.equal(t.calls.set.length, 0)
})

test('控制器：推送失敗（後台沒部署、斷線）靜默略過，本機設定照用', async () => {
  const errs = []
  const prefs = L({ deviceOrder: ['a'], deviceRev: 5 })
  const sync = createDeviceSync({ prefs, api: { get: async () => { throw new Error('404') }, set: async () => { throw new Error('404') } }, onError: e => errs.push(e.message) })
  await sync.pull(); await sync.push()
  assert.deepEqual(prefs.deviceOrder, ['a']); assert.equal(errs.length, 2)
})

// #2161 F2：寄出狀態查詢降頻（最小間隔、年齡分級、可見才打）
import test from 'node:test'
import assert from 'node:assert/strict'
import { AsnCore } from '../ui/lib/core.mjs'
import { collectPollIds, pollEveryMs } from '../ui/lib/sent-status.mjs'

const H = 3600_000
const T0 = 1_700_000_000_000

test('pollEveryMs：年齡分級邊界', () => {
  assert.equal(pollEveryMs(0), 15_000)
  assert.equal(pollEveryMs(59 * 60_000), 15_000)
  assert.equal(pollEveryMs(H), 180_000)
  assert.equal(pollEveryMs(23 * H), 180_000)
  assert.equal(pollEveryMs(24 * H), 1_800_000)
  assert.equal(pollEveryMs(6 * 24 * H), 1_800_000)
})

test('collectPollIds：依上次查詢時間過濾', () => {
  const now = T0
  const logs = new Map([['f', [
    { k: 'me', id: 'new', t: now - 1000 },
    { k: 'me', id: 'young-fresh', t: now - 10 * 60_000 },
    { k: 'me', id: 'young-due', t: now - 10 * 60_000 },
    { k: 'me', id: 'hour-fresh', t: now - 2 * H },
    { k: 'me', id: 'hour-due', t: now - 2 * H },
    { k: 'me', id: 'old-fresh', t: now - 3 * 24 * H },
    { k: 'me', id: 'old-due', t: now - 3 * 24 * H },
    { k: 'me', id: 'read', t: now - 1000, ackedAt: 'x' },
    { k: 'me', id: 'replied', t: now - 1000, repliedAt: 'x' },
    { k: 'me', id: 'expired', t: now - 8 * 24 * H },
  ]]])
  const last = new Map([
    ['young-fresh', now - 5_000], ['young-due', now - 16_000],
    ['hour-fresh', now - 120_000], ['hour-due', now - 181_000],
    ['old-fresh', now - 10 * 60_000], ['old-due', now - 1_800_001],
    ['read', now - 999_999_999], ['expired', now - 999_999_999],
  ])
  assert.deepEqual(collectPollIds(logs, now, last), ['new', 'young-due', 'hour-due', 'old-due'])
  assert.equal(collectPollIds(logs, now).length, 7, '沒給記錄＝全收（除已讀、已回覆、過期）')
})

function mk({ active = true, msgs } = {}) {
  const clock = { t: T0 }
  const calls = []
  const state = { active }
  const transport = { sentStatus: async ids => { calls.push([...ids]); return [] }, list: async () => ({ members: [] }), inbox: async () => [], ack: async () => ({}) }
  const core = new AsnCore({ transport, store: { load: async () => null, save: async () => {} }, selfNode: 'T', windowName: 'me', now: () => clock.t, isActive: () => state.active, statusPollMs: 1e9, pollMs: 1e9, rosterMs: 1e9, localMs: 0 })
  core.logs.set('f', msgs ?? [{ k: 'me', id: 'a', t: clock.t - 1000 }])
  return { core, clock, calls, state }
}
const addMsg = (core, id, t) => core.logs.get('f').push({ k: 'me', id, t })

test('最小間隔：10 秒內連兩次非強制只打一次；force／send／resume／startup 不受限', async () => {
  const { core, clock, calls } = mk()
  await core.refreshSentStatus('poll')
  assert.equal(calls.length, 1)
  clock.t += 5_000
  addMsg(core, 'n1', clock.t)   // 有新 id 可查，才看得出是最小間隔擋住而不是沒東西可查
  await core.refreshSentStatus('poll')
  await core.refreshSentStatus('pull')
  assert.equal(calls.length, 1, '10 秒內非強制略過')
  await core.refreshSentStatus('force')
  assert.equal(calls.length, 2, 'force 不受限')
  clock.t += 1_000; addMsg(core, 'n2', clock.t)
  await core.refreshSentStatus('send'); assert.equal(calls.length, 3, 'send 不受限')
  clock.t += 1_000; addMsg(core, 'n3', clock.t)
  await core.resumeSentStatus(); assert.equal(calls.length, 4, 'resume 不受限')
  clock.t += 1_000; addMsg(core, 'n4', clock.t)
  await core.refreshSentStatus('startup'); assert.equal(calls.length, 5, 'startup 不受限')
  clock.t += 11_000; addMsg(core, 'n5', clock.t)
  await core.refreshSentStatus('poll')
  assert.equal(calls.length, 6, '超過 10 秒又可以打')
})

test('年齡分級：1 小時內每 15 秒查；超過 1 小時的 15 秒內不重查、3 分鐘後才查', async () => {
  const { core, clock, calls } = mk({ msgs: [
    { k: 'me', id: 'young', t: T0 - 10 * 60_000 },
    { k: 'me', id: 'hour', t: T0 - 2 * H },
  ] })
  await core.refreshSentStatus('poll')
  assert.deepEqual(calls[0].sort(), ['hour', 'young'])
  clock.t += 15_000
  await core.refreshSentStatus('poll')
  assert.deepEqual(calls[1], ['young'], '15 秒後只有 1 小時內的信')
  clock.t += 15_000
  await core.refreshSentStatus('poll')
  assert.deepEqual(calls[2], ['young'])
  clock.t += 150_000
  await core.refreshSentStatus('poll')
  assert.deepEqual(calls[3].sort(), ['hour', 'young'], '超過 3 分鐘後 1～24 小時的信再查')
})

test('isActive=false：poll 不打；startup 與 resumeSentStatus 會打', async () => {
  const { core, clock, calls, state } = mk({ active: false })
  await core.refreshSentStatus('poll')
  await core.refreshSentStatus('pull')
  assert.equal(calls.length, 0, '背景中 poll／pull 不打')
  await core.refreshSentStatus('startup')
  assert.equal(calls.length, 1, 'startup 照打')
  clock.t += 20_000
  await core.resumeSentStatus()
  assert.equal(calls.length, 2, 'resume 照打（超過 15 秒的信到期）')
  state.active = true
  clock.t += 20_000
  await core.refreshSentStatus('poll')
  assert.equal(calls.length, 3, '回前景後 poll 恢復')
})

test('visibilitychange：變 visible 補打一次，hidden 不打，stop 後移除監聽', async () => {
  const listeners = new Set()
  const doc = { visibilityState: 'visible', addEventListener: (n, f) => { if (n === 'visibilitychange') listeners.add(f) }, removeEventListener: (n, f) => { listeners.delete(f) } }
  const prev = globalThis.document
  globalThis.document = doc
  try {
    const { core, clock, calls } = mk()
    await core.start()
    assert.equal(listeners.size, 1)
    const base = calls.length
    clock.t += 20_000
    doc.visibilityState = 'hidden'; for (const f of [...listeners]) f()
    await new Promise(r => setTimeout(r, 10))
    assert.equal(calls.length, base, 'hidden 不打')
    doc.visibilityState = 'visible'; for (const f of [...listeners]) f()
    await new Promise(r => setTimeout(r, 10))
    assert.equal(calls.length, base + 1, 'visible 補打一次')
    await core.stop()
    assert.equal(listeners.size, 0, 'stop 移除監聽')
  } finally { globalThis.document = prev }
})

test('Map 修剪：消失的 id 被清掉（再出現時不被當成剛查過）', async () => {
  const { core, clock, calls } = mk({ msgs: [{ k: 'me', id: 'a', t: T0 - 1000 }] })
  await core.refreshSentStatus('poll')            // t=0 查 a
  core.logs.get('f').length = 0
  clock.t += 11_000
  await core.refreshSentStatus('poll')            // 沒有可查的，但結尾要修剪掉 a
  core.logs.get('f').push({ k: 'me', id: 'a', t: T0 - 1000 })
  clock.t += 3_000                                // 距第一次查 14 秒：若沒修剪，a 會被視為剛查過而略過
  const before = calls.length
  await core.refreshSentStatus('send')            // send 不受最小間隔，只受年齡分級
  assert.equal(calls.length, before + 1)
  assert.deepEqual(calls.at(-1), ['a'])
})

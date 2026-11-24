// #2161 F3 第一步：群組輪詢的本機計數。只記數、不改行為；未讀紅點的行為要被鎖住（asn真 的要求）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRoomPollCounter } from '../ui/lib/room-poll-counter.mjs'
import { createRoomHub } from '../ui/lib/room-hub.mjs'
import { createGroupApi } from '../ui/lib/groups.mjs'

// ---------- 計數器本身 ----------
function counterOf(over = {}) {
  let t = 0
  const out = []
  const c = createRoomPollCounter({ now: () => t, sink: (...a) => out.push(a), everyMs: 60_000, ...over })
  return { c, out, tick: ms => { t += ms } }
}

test('累計：總數與每房間分開記', () => {
  const { c } = counterOf()
  c.hit('read:first', 'aaaaaaaa-1'); c.hit('read:first', 'aaaaaaaa-1'); c.hit('read:unread', 'bbbbbbbb-2'); c.hit('list:refresh')
  const s = c.snapshot()
  assert.deepEqual(s.總計, { 'read:first': 2, 'read:unread': 1, 'list:refresh': 1 })
  assert.deepEqual(s.各群組, { aaaaaaaa: { 'read:first': 2 }, bbbbbbbb: { 'read:unread': 1 } })
})

test('超過 everyMs：輸出一行並歸零；roomId 只留前 8 碼', () => {
  const { c, out, tick } = counterOf()
  c.hit('read:force', '0123456789abcdef'); assert.equal(out.length, 0)
  tick(60_000); c.hit('read:force', '0123456789abcdef')
  assert.equal(out.length, 1)
  assert.equal(out[0][0], '[ASN] 群組輪詢計數')
  const j = JSON.parse(out[0][1])
  assert.equal(j.秒數, 60); assert.equal(j.總計['read:force'], 2)
  assert.deepEqual(Object.keys(j.各群組), ['01234567'])
  assert.ok(!out[0][1].includes('89abcdef'))
  assert.deepEqual(c.snapshot().總計, {}, '輸出後歸零')
  assert.deepEqual(globalThis.__roomPollCounts.總計, { 'read:force': 2 })
})

test('沒有非零計數不輸出；sink 丟錯不影響', () => {
  const { c, out, tick } = counterOf()
  tick(120_000); assert.equal(c.flush(), false); assert.equal(out.length, 0)
  const bad = counterOf({ sink: () => { throw new Error('x') } })
  bad.c.hit('read:first', 'r1'); bad.tick(61_000)
  assert.doesNotThrow(() => bad.c.hit('read:first', 'r1'))
  assert.deepEqual(bad.c.snapshot().總計, {})
})

// ---------- room-hub：計數與「行為不變」 ----------
const me = { key: '~u:u1', label: '我', member_kind: 'human', mine: true }
const roomOf = (id, over = {}) => ({ id, name: id, last_seq: 3, mine: [{ member: '~u:u1', unread: 0 }], members: [me], ...over })
const msg = (seq, over = {}) => ({ seq, from: 'x:r1', from_name: '別人', from_kind: 'human', relation: 'other', body: `第${seq}則`, at: '2026-10-24T10:00:00Z', mentions: [], ...over })

function setup({ counter, visible = () => true, rooms, readRes } = {}) {
  const calls = []
  let cur = rooms ?? [roomOf('g1')]
  const invoke = async (cmd, args) => {
    calls.push([cmd, JSON.stringify(args)])
    if (cmd === 'relay_rooms') return { rooms: cur }
    if (cmd === 'relay_room_read') return readRes ? readRes(args) : { messages: [], last_seq: 3 }
    return {}
  }
  const hub = createRoomHub({ invoke, groupApi: createGroupApi(invoke), selfNode: 'T', windowName: 'w', visible, counter })
  return { hub, calls, setRooms: r => { cur = r } }
}
const seed = (hub, id, log) => { hub.st.logs[id] = log }
const quiet = () => createRoomPollCounter({ sink: () => {} })

test('first：log 為空 → read:first 與 read:total 各記一次', async () => {
  const c = quiet()
  const { hub } = setup({ counter: c })
  await hub.refresh(); await hub.read('g1')
  const t = c.snapshot().總計
  assert.equal(t['read:first'], 1); assert.equal(t['read:total'], 1); assert.equal(t['list:refresh'], 1)
  assert.equal(t['read:force'], undefined)
})

test('force：已有 log 且沒新訊息、沒未讀，force:true 才打 → 只記 read:force', async () => {
  const c = quiet()
  const { hub, calls } = setup({ counter: c, readRes: () => ({ messages: [msg(3)], last_seq: 3 }) })
  await hub.refresh(); await hub.read('g1'); c.reset(); calls.length = 0
  await hub.read('g1'); assert.equal(calls.length, 0, '沒條件成立不打後台')
  assert.deepEqual(c.snapshot().總計, {})
  await hub.read('g1', { force: true })
  assert.deepEqual(c.snapshot().總計, { 'read:total': 1, 'read:force': 1 })
})

test('needsRead：後台 last_seq 變大 → 只記 read:needsRead', async () => {
  const c = quiet()
  const { hub, setRooms } = setup({ counter: c, readRes: () => ({ messages: [msg(3)], last_seq: 3 }) })
  await hub.refresh(); await hub.read('g1')
  setRooms([roomOf('g1', { last_seq: 5 })]); await hub.refresh(); c.reset()
  await hub.read('g1', { mark: false })
  assert.deepEqual(c.snapshot().總計, { 'read:total': 1, 'read:needsRead': 1 })
})

test('unread：未讀 > 0 → 記 read:unread（同時 needsRead 成立就兩條都記）', async () => {
  const c = quiet()
  const { hub, setRooms } = setup({ counter: c, readRes: () => ({ messages: [msg(3)], last_seq: 3 }) })
  await hub.refresh(); await hub.read('g1', { mark: false })
  setRooms([roomOf('g1', { mine: [{ member: '~u:u1', unread: 2 }] })]); await hub.refresh(); c.reset()
  await hub.read('g1', { mark: false })
  assert.deepEqual(c.snapshot().總計, { 'read:total': 1, 'read:unread': 1 })
  setRooms([roomOf('g1', { last_seq: 9, mine: [{ member: '~u:u1', unread: 2 }] })]); await hub.refresh(); c.reset()
  await hub.read('g1', { mark: false })
  assert.deepEqual(c.snapshot().總計, { 'read:total': 1, 'read:needsRead': 1, 'read:unread': 1 })
})

test('receipts：自己發的訊息有人沒讀 → receipts:reads（limit 1 的輕量讀取）', async () => {
  const c = quiet()
  const { hub, calls } = setup({ counter: c })
  await hub.refresh()
  seed(hub, 'g1', [{ k: 'me', seq: 3, id: 'm3', text: 'x', rd: { n: 1, total: 3 } }]); calls.length = 0; c.reset()
  await hub.read('g1')
  assert.equal(calls.length, 1)
  assert.equal(JSON.parse(calls[0][1]).limit, 1)
  assert.deepEqual(c.snapshot().總計, { 'receipts:reads': 1 })
})

test('loadCards：用呼叫者傳的 why，預設 other', async () => {
  const c = quiet()
  const { hub } = setup({ counter: c })
  await hub.refresh(); await hub.loadCards('g1', 'refreshRooms'); await hub.loadCards('g1')
  const t = c.snapshot().總計
  assert.equal(t['cards:refreshRooms'], 1); assert.equal(t['cards:other'], 1)
})

test('背景群組有新訊息：紅點照亮（未讀進 rows、不被錯標已讀），新訊息進 log', async () => {
  const c = quiet()
  const { hub, setRooms, calls } = setup({ counter: c, visible: id => id === 'g2', rooms: [roomOf('g1'), roomOf('g2')], readRes: a => ({ messages: [msg(3), msg(4)].filter(m => m.seq > a.since), last_seq: 4 }) })
  await hub.refresh(); await hub.read('g1', { mark: false })
  setRooms([roomOf('g1', { last_seq: 4, mine: [{ member: '~u:u1', unread: 1 }] }), roomOf('g2')]); await hub.refresh()
  assert.equal(hub.rowOf('g1').unread, 1, '紅點資料照常進 rows')
  await hub.read('g1')   // visible(g1) 為假 → 背景讀
  const last = calls.filter(([cmd]) => cmd === 'relay_room_read').at(-1)
  assert.equal(JSON.parse(last[1]).mark, false, '背景群組不標已讀')
  assert.equal(hub.rowOf('g1').unread, 1, '紅點沒有被錯誤清掉')
  assert.ok(hub.st.logs.g1.some(e => e.seq === 4), '新訊息進了 log')
})

test('有沒有給 counter：api 呼叫序列完全相同', async () => {
  async function run(counter) {
    const { hub, calls, setRooms } = setup({ counter, visible: id => id === 'g2', rooms: [roomOf('g1'), roomOf('g2')], readRes: a => ({ messages: [msg(3), msg(4)].filter(m => m.seq > a.since), last_seq: 4 }) })
    await hub.refresh()
    for (const id of ['g1', 'g2']) { await hub.read(id); await hub.loadCards(id) }
    setRooms([roomOf('g1', { last_seq: 4, mine: [{ member: '~u:u1', unread: 1 }] }), roomOf('g2', { last_seq: 4 })]); await hub.refresh()
    for (const id of ['g1', 'g2']) { await hub.read(id); await hub.read(id); await hub.loadCards(id, 'refreshRooms') }
    seed(hub, 'g2', [{ k: 'me', seq: 4, id: 'm4', text: 'x', rd: { n: 0, total: 2 } }])
    await hub.read('g2'); await hub.read('g1', { force: true })
    return { calls, logs: JSON.stringify(hub.st.logs), unread: hub.rows().map(r => r.unread) }
  }
  const a = await run(null), b = await run(quiet())
  assert.ok(a.calls.length > 6)
  assert.deepEqual(b.calls, a.calls)
  assert.equal(b.logs, a.logs); assert.deepEqual(b.unread, a.unread)
})

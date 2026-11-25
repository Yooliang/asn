// #2161 F3 第二步：背景群組的已讀補查拉長到 5 分鐘、確認卡片只對看得見／有變動的群組重抓。
// 未讀紅點與新訊息的讀取不能受影響（asn真 的要求）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRoomPollCounter } from '../ui/lib/room-poll-counter.mjs'
import { RECEIPTS_BACKGROUND_MS, createCardGate, createRoomHub } from '../ui/lib/room-hub.mjs'
import { createGroupApi } from '../ui/lib/groups.mjs'

const me = { key: '~u:u1', label: '我', member_kind: 'human', mine: true }
const roomOf = (id, over = {}) => ({ id, name: id, last_seq: 3, mine: [{ member: '~u:u1', unread: 0 }], members: [me], ...over })
const msg = (seq, over = {}) => ({ seq, from: 'x:r1', from_name: '別人', from_kind: 'human', relation: 'other', body: `第${seq}則`, at: '2026-10-24T10:00:00Z', mentions: [], ...over })
const pendingLog = seq => [{ k: 'me', seq, id: `m${seq}`, text: 'x', rd: { n: 1, total: 3 } }]   // 自己發的、有人沒讀

function setup({ rooms, shown = new Set(), readRes } = {}) {
  const calls = []
  let cur = rooms ?? [roomOf('g1'), roomOf('g2')]
  let t = 1_000_000
  const invoke = async (cmd, args) => {
    calls.push([cmd, JSON.parse(JSON.stringify(args ?? {}))])
    if (cmd === 'relay_rooms') return { rooms: cur }
    if (cmd === 'relay_room_read') return readRes ? readRes(args) : { messages: [], last_seq: 3 }
    return {}
  }
  const counter = createRoomPollCounter({ sink: () => {}, now: () => t, everyMs: 1e12 })
  const hub = createRoomHub({ invoke, groupApi: createGroupApi(invoke), selfNode: 'T', windowName: 'w', visible: id => shown.has(id), now: () => t, counter })
  const reads = () => calls.filter(([c]) => c === 'relay_room_read')
  return { hub, calls, reads, counter, shown, setRooms: r => { cur = r }, tick: ms => { t += ms } }
}

test('(a) 背景群組：5 分鐘內不重複補查已讀，超過才打', async () => {
  const { hub, reads, tick, counter } = setup()
  await hub.refresh(); hub.st.logs.g1 = pendingLog(3)
  await hub.read('g1'); assert.equal(reads().length, 1, '第一次（沒記時）照打')
  tick(60_000); await hub.read('g1'); tick(60_000); await hub.read('g1')
  assert.equal(reads().length, 1, '5 分鐘內略過')
  assert.equal(counter.snapshot().總計['receipts:skippedBackground'], 2)
  tick(RECEIPTS_BACKGROUND_MS); await hub.read('g1')
  assert.equal(reads().length, 2, '超過 5 分鐘才再打')
})

test('(b) 群組變成看得見：馬上補查一次，不等間隔', async () => {
  const { hub, reads, tick, shown } = setup()
  await hub.refresh(); hub.st.logs.g1 = pendingLog(3)
  await hub.read('g1'); tick(10_000); await hub.read('g1')
  assert.equal(reads().length, 1)
  shown.add('g1')   // 切到那個分頁
  await hub.read('g1')
  assert.equal(reads().length, 2, '變成可見立即補查')
  assert.equal(reads().at(-1)[1].mark, false)
})

test('(b2) open()（force）也繞過背景間隔', async () => {
  const { hub, reads, tick } = setup({ readRes: () => ({ messages: [msg(3)], last_seq: 3 }) })
  await hub.refresh(); hub.st.logs.g1 = pendingLog(3)
  await hub.read('g1'); tick(1000)
  const n = reads().length
  await hub.open('g1', { mark: false })
  assert.ok(reads().length > n, 'force 讀取照打')
})

test('(c) 可見群組：每次都照打，不受間隔限制', async () => {
  const { hub, reads, tick } = setup({ shown: new Set(['g1']) })
  await hub.refresh(); hub.st.logs.g1 = pendingLog(3)
  for (let i = 0; i < 4; i++) { await hub.read('g1'); tick(5_000) }
  assert.equal(reads().length, 4)
})

// ---------- 確認卡片 ----------
const rowsOf = list => id => list[id] ?? null
const gateRun = async (gate, why, ids, list, shown) => [...await gate(why, ids, { rowOf: rowsOf(list), isVisible: id => shown.has(id) })].sort()
const snap = (a = 3, b = 3, c = 3) => ({ g1: { lastSeq: a, unread: 0 }, g2: { lastSeq: b, unread: 0 }, g3: { lastSeq: c, unread: 0 } })
const IDS = ['g1', 'g2', 'g3']

test('(d) start 全打；timer 只打可見群組；bell 只打可見＋有變動的', async () => {
  const counter = createRoomPollCounter({ sink: () => {} })
  const gate = createCardGate({ counter })
  const shown = new Set(['g1'])
  assert.deepEqual(await gateRun(gate, 'start', IDS, snap(), shown), ['g1', 'g2', 'g3'], 'start 全打並建快照')
  assert.deepEqual(await gateRun(gate, 'timer', IDS, snap(), shown), ['g1'], 'timer 只打可見')
  assert.deepEqual(await gateRun(gate, 'bell', IDS, snap(), shown), ['g1'], '門鈴沒有群組變動：只剩可見的')
  assert.deepEqual(await gateRun(gate, 'bell', IDS, snap(3, 3, 4), shown), ['g1', 'g3'], '門鈴：g3 的 lastSeq 變了（新確認卡片會讓 last_seq 加一）')
  assert.deepEqual(await gateRun(gate, 'bell', IDS, snap(3, 3, 4), shown), ['g1'], '快照已更新，不重複打')
  assert.deepEqual(await gateRun(gate, 'groupFlow', IDS, snap(), shown), ['g1', 'g2', 'g3'], '其他情況全打')
  assert.ok(counter.snapshot().總計['cards:skippedBackground'] >= 5)
})

test('(d2) timer 時 g3 變成可見：會被打；bell 時 unread 變動也算變動', async () => {
  const gate = createCardGate()
  await gateRun(gate, 'start', IDS, snap(), new Set())
  assert.deepEqual(await gateRun(gate, 'timer', IDS, snap(), new Set(['g3'])), ['g3'])
  const l = snap(); l.g2.unread = 1
  assert.deepEqual(await gateRun(gate, 'bell', IDS, l, new Set()), ['g2'])
})

test('(d3) 沒有快照的新群組（第一次出現）門鈴時視為有變動', async () => {
  const gate = createCardGate()
  assert.deepEqual(await gateRun(gate, 'bell', ['g1'], snap(), new Set()), ['g1'])
})

// ---------- 紅點與新訊息鎖定 ----------
test('(e) 背景群組有新訊息：unread 照常更新、read 仍讀到新訊息（不受背景間隔影響）、不標已讀', async () => {
  const { hub, reads, setRooms, tick } = setup({ readRes: a => ({ messages: [msg(3), msg(4)].filter(m => m.seq > a.since), last_seq: 4 }) })
  await hub.refresh(); await hub.read('g1', { mark: false })
  tick(1000)
  setRooms([roomOf('g1', { last_seq: 4, mine: [{ member: '~u:u1', unread: 1 }] }), roomOf('g2')]); await hub.refresh()
  assert.equal(hub.rowOf('g1').unread, 1, 'unread 進畫面')
  const n = reads().length
  await hub.read('g1')   // 背景、剛讀過 1 秒
  assert.equal(reads().length, n + 1, '新訊息的讀取不被略過')
  assert.equal(reads().at(-1)[1].mark, false)
  assert.ok(hub.st.logs.g1.some(e => e.seq === 4))
  assert.equal(hub.rowOf('g1').unread, 1, '背景不標已讀、紅點不被清')
})

test('(e2) unread 單獨成立（needsRead 為假、只有 row.unread>0）：背景群組仍讀取、不受間隔影響', async () => {
  const { hub, reads, setRooms, tick } = setup({ readRes: () => ({ messages: [msg(3)], last_seq: 3 }) })
  await hub.refresh(); await hub.read('g1', { mark: false })
  tick(1000)
  setRooms([roomOf('g1', { last_seq: 3, mine: [{ member: '~u:u1', unread: 2 }] }), roomOf('g2')]); await hub.refresh()
  const n = reads().length
  await hub.read('g1')
  assert.equal(reads().length, n + 1, 'unread>0 走一般讀取')
  assert.equal(reads().at(-1)[1].limit, 200, '不是 limit 1 的輕量補查')
  assert.equal(reads().at(-1)[1].mark, false)
  assert.equal(hub.rowOf('g1').unread, 2)
})

test('(f) 新訊息到達後走一般讀取；之後的補查間隔從那次讀取起算', async () => {
  const { hub, reads, setRooms, tick } = setup({ readRes: a => ({ messages: [msg(3), msg(4)].filter(m => m.seq > a.since), last_seq: 4 }) })
  await hub.refresh(); hub.st.logs.g1 = pendingLog(3)
  await hub.read('g1')                       // 補查（記時）
  tick(200_000)
  setRooms([roomOf('g1', { last_seq: 4 }), roomOf('g2')]); await hub.refresh()
  const n = reads().length
  await hub.read('g1')                       // needsRead 為真：一般讀取，不看間隔
  assert.equal(reads().length, n + 1)
  assert.ok(reads().at(-1)[1].limit > 1)
  hub.st.logs.g1 = pendingLog(4)
  tick(200_000); await hub.read('g1')        // 距上次一般讀取 200 秒：仍在間隔內
  assert.equal(reads().length, n + 1)
  tick(100_000); await hub.read('g1')        // 滿 300 秒
  assert.equal(reads().length, n + 2)
})

test('(g) timer 那一輪沒打到的群組不覆寫快照：之後門鈴看得出變化（asn真 一審 2）', async () => {
  const gate = createCardGate()
  await gateRun(gate, 'start', IDS, snap(), new Set())
  // 計時器那一輪：g3 的 lastSeq 變了（新確認卡片），但 g3 不可見、沒被打到
  assert.deepEqual(await gateRun(gate, 'timer', IDS, snap(3, 3, 4), new Set(['g1'])), ['g1'])
  // 之後門鈴：g3 的列還是新的，要被看出有變動並打到（快照不能被計時器那一輪吃掉）
  assert.deepEqual(await gateRun(gate, 'bell', IDS, snap(3, 3, 4), new Set(['g1'])), ['g1', 'g3'])
  // 打過之後快照才更新，不重複打
  assert.deepEqual(await gateRun(gate, 'bell', IDS, snap(3, 3, 4), new Set(['g1'])), ['g1'])
})

test('(h) list.js：切到已開過的群組分頁時 activateTab 也 loadCards（asn真 一審 1）', async () => {
  const fs = await import('node:fs')
  const src = fs.readFileSync(new URL('../ui/list.js', import.meta.url), 'utf8')
  const line = src.split(/\r?\n/).find(l => l.startsWith('const activateTab ='))
  assert.ok(line, '找得到 activateTab')
  assert.match(line, /hub\.read\(roomIdOf\(id\)\)/)
  assert.match(line, /hub\.loadCards\(roomIdOf\(id\),\s*'activateTab'\)/)
})

// 晚到的叫醒順序：發言者的用戶端比 AI 先讀到訊息時 wake_info 還是 null，之後靠 wakes 補上標籤。
// 只有「最近 10 分鐘內發出、還沒有叫醒順序」的訊息才值得補問；補問沿用 reads 的呼叫（不標已讀、只讀最後一則之後）；超時就停；舊後台不再問。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { WAKE_WAIT_MS, applyWakes, hasPendingWakes, roomLog } from '../ui/lib/mobile-rooms.mjs'
import { createRoomHub } from '../ui/lib/room-hub.mjs'

const NOW = Date.parse('2026-10-24T10:05:00Z')
const M = (seq, over = {}) => ({ seq, from: 'P', from_name: '小良', from_kind: 'human', relation: 'mine', body: '嗨', at: '2026-10-24T10:00:00Z', mentions: [], ...over })
const E = (label, rank, hold = false) => ({ key: 'x:' + label, label, rank, hold })
const INFO = [E('甲', 1), E('乙', 2)]

test('套用 wakes：沒有順序的訊息補上標籤；已有的不覆蓋（先到先得）；沒變動回原陣列；壞資料不炸', () => {
  const log = roomLog([M(1), M(2, { wake_info: [E('丙', 1), E('丁', 2)] })], ['P'], [])
  const next = applyWakes(log, [{ seq: 1, wake_info: INFO }, { seq: 2, wake_info: INFO }])
  assert.deepEqual(next[0].wake, [{ label: '甲', off: false }, { label: '乙', off: false }])
  assert.equal(next[1], log[1], '已有的不覆蓋')
  assert.equal(applyWakes(next, [{ seq: 1, wake_info: INFO }]), next, '沒變動回原陣列')
  assert.equal(applyWakes(log, null), log); assert.equal(applyWakes(log, 'x'), log); assert.equal(applyWakes(log, []), log)
  assert.equal(applyWakes(log, [null, { seq: 1 }, { seq: 9, wake_info: INFO }, { seq: 1, wake_info: 'x' }]), log)
})

test('套用 wakes：只有一位被叫醒（不顯示標籤）也算「已有順序」，之後不再補問', () => {
  const log = roomLog([M(1)], ['P'], [])
  assert.equal(hasPendingWakes(log, NOW), true)
  const next = applyWakes(log, [{ seq: 1, wake_info: [E('甲', 1)] }])
  assert.deepEqual(next[0].wake, [])
  assert.equal(hasPendingWakes(next, NOW), false)
})

test('需要補問的條件：10 分鐘內、非系統、非開頭紀錄、還沒有順序；超時、已有、系統、開頭紀錄都不需要', () => {
  const at = ms => new Date(NOW - ms).toISOString()
  const fresh = roomLog([M(1, { at: at(60 * 1000) })], ['P'], [])
  assert.equal(hasPendingWakes(fresh, NOW), true)
  assert.equal(hasPendingWakes(roomLog([M(1, { at: at(WAKE_WAIT_MS + 1000) })], ['P'], []), NOW), false, '超時停止')
  assert.equal(hasPendingWakes(roomLog([M(1, { at: at(1000), wake_info: INFO })], ['P'], []), NOW), false, '已有')
  assert.equal(hasPendingWakes(roomLog([M(1, { at: at(1000), wake_info: [] })], ['P'], []), NOW), false, '空陣列也算已算過')
  assert.equal(hasPendingWakes(roomLog([M(1, { at: at(1000), from_kind: 'system', relation: 'system' })], ['P'], []), NOW), false, '系統')
  assert.equal(hasPendingWakes(roomLog([M(1, { at: at(1000), is_seed: true })], ['P'], []), NOW), false, '開頭紀錄')
  assert.equal(hasPendingWakes([], NOW), false); assert.equal(hasPendingWakes(null, NOW), false)
})

const ROOM = { id: 'g1', name: '群', last_seq: 2, mine: [{ member: '~u:u1', unread: 0 }], members: [{ key: '~u:u1', label: '牧陽', member_kind: 'human', mine: true, role: 'owner' }] }
function hubWith(read, clock) {
  const calls = []
  const invoke = async (cmd, args) => {
    calls.push([cmd, args])
    if (cmd === 'relay_rooms') return { rooms: [JSON.parse(JSON.stringify(ROOM))] }
    if (cmd === 'relay_room_read') return read(args)
    return {}
  }
  return { hub: createRoomHub({ invoke, groupApi: { confirmList: async () => ({}) }, selfNode: 'T', windowName: 'w', now: () => clock.t }), calls }
}
const fullRead = () => ({ messages: [M(1, { from: '~u:u1', at: '2026-10-24T10:00:00Z', read_count: 3, read_total: 3 }), M(2, { from: '~u:u1', at: '2026-10-24T10:00:30Z', read_count: 3, read_total: 3 })], last_seq: 2, reads: [], wakes: [] })

test('輪詢：已讀都滿了，但最近訊息還沒有順序，就補問一次（不標已讀、只讀最後一則之後），拿到後標籤出現且不再問', async () => {
  const clock = { t: NOW }
  let answer = []
  const { hub, calls } = hubWith(args => (args.since === 0 ? fullRead() : { messages: [], last_seq: 2, reads: [], wakes: answer }), clock)
  await hub.open('g1')
  assert.deepEqual(hub.st.logs.g1.map(e => e.wake), [[], []])
  assert.equal(await hub.read('g1'), false, '後台還沒有順序：問了但沒變')
  const q = calls.filter(([c]) => c === 'relay_room_read').at(-1)[1]
  assert.deepEqual([q.since, q.limit, q.mark], [2, 1, false])
  answer = [{ seq: 1, wake_info: INFO }, { seq: 2, wake_info: [E('甲', 1)] }]
  assert.equal(await hub.read('g1'), true)
  assert.deepEqual(hub.st.logs.g1[0].wake.map(t => t.label), ['甲', '乙'])
  const n = calls.length
  assert.equal(await hub.read('g1'), false)
  assert.equal(calls.length, n, '都補到了：不再問')
})

test('輪詢：超過 10 分鐘就停止補問', async () => {
  const clock = { t: NOW }
  const { hub, calls } = hubWith(args => (args.since === 0 ? fullRead() : { messages: [], last_seq: 2, reads: [], wakes: [] }), clock)
  await hub.open('g1')
  await hub.read('g1')
  const n = calls.length
  clock.t = NOW + WAKE_WAIT_MS + 60 * 1000
  assert.equal(await hub.read('g1'), false)
  assert.equal(calls.length, n, '超時不再問')
})

test('輪詢：舊後台（回應沒有 wakes 欄位）問過一次就不再為順序問；已讀還沒滿時仍照舊問已讀', async () => {
  const clock = { t: NOW }
  const { hub, calls } = hubWith(args => (args.since === 0 ? fullRead() : { messages: [], last_seq: 2, reads: [] }), clock)
  await hub.open('g1')
  await hub.read('g1')
  const n = calls.length
  await hub.read('g1'); await hub.read('g1')
  assert.equal(calls.length, n, '舊後台不再問')
})

test('輪詢：有新訊息的一般讀取也套用 wakes（不多開一條呼叫）', async () => {
  const clock = { t: NOW }
  const { hub, calls } = hubWith(args => (args.since === 0
    ? { messages: [M(1, { from: '~u:u1' })], last_seq: 1, reads: [], wakes: [] }
    : { messages: [M(2, { from: '~u:u1', at: '2026-10-24T10:04:00Z' })], last_seq: 2, reads: [], wakes: [{ seq: 1, wake_info: INFO }] }), clock)
  await hub.open('g1')
  hub.raw('g1').last_seq = 2
  assert.equal(await hub.read('g1', { force: true }), true)
  assert.equal(hub.st.logs.g1[0].wake.length, 2)
  assert.equal(calls.filter(([c]) => c === 'relay_room_read').length, 2)
})

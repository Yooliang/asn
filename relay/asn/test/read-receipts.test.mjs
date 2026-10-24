// 群組訊息的「已讀 N」（#224）：後台的 read_count／read_total／名單 → 自己發的訊息時間旁的小字；
// 沒有新訊息時靠 reads 更新；舊後台（沒有欄位）照舊；桌面與手機共用 ChatPane，深色模式可讀。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { applyReads, hasPendingReads, readInfo, readLabel, readTitle, roomLog } from '../ui/lib/mobile-rooms.mjs'
import { createRoomHub } from '../ui/lib/room-hub.mjs'

const M = (seq, over = {}) => ({ seq, from: 'P', from_name: '小良', from_kind: 'human', relation: 'mine', body: '嗨', at: '2026-10-24T10:00:00Z', mentions: [], ...over })
const RD = (n, total, by = [], un = []) => ({ read_count: n, read_total: total, read_by: by, unread_by: un })

test('文字：0 不顯示；部分讀「已讀 N」；全部讀完「全部已讀」；沒資料不顯示', () => {
  assert.equal(readLabel(readInfo(RD(0, 3))), '')
  assert.equal(readLabel(readInfo(RD(3, 4))), '已讀 3')
  assert.equal(readLabel(readInfo(RD(4, 4))), '全部已讀')
  assert.equal(readLabel(null), '')
  assert.equal(readInfo({}), null); assert.equal(readInfo(null), null); assert.equal(readInfo({ read_count: '3', read_total: 4 }), null)
})

test('提示：列出誰讀了、誰沒讀；沒有名單不給提示；名單裡的代號被濾掉', () => {
  assert.equal(readTitle(readInfo(RD(1, 3, ['甲'], ['乙', '丙']))), '已讀：甲\n未讀：乙、丙')
  assert.equal(readTitle(readInfo(RD(3, 3, ['甲', '乙', '丙'], []))), '已讀：甲、乙、丙')
  assert.equal(readTitle(readInfo(RD(1, 3))), '')
  assert.deepEqual(readInfo(RD(1, 2, ['x:abc', '甲'], [])).by, ['甲'])
})

test('對話記錄：只有自己發的訊息帶 rd；別人的、系統的、開頭紀錄的、舊後台的都沒有', () => {
  const log = roomLog([
    M(1, RD(2, 3)),
    M(2, { relation: 'other', from: 'x:r1', from_kind: 'human', ...RD(1, 3) }),
    M(3, { relation: 'system', from_kind: 'system' }),
    M(4, { is_seed: true, ...RD(1, 2) }),
    M(5),
  ], ['P'], [])
  assert.deepEqual(log.map(e => e.rd), [{ n: 2, total: 3, by: [], un: [] }, null, undefined, null, null].map((v, i) => (i === 2 ? log[2].rd : v)))
  assert.equal(log[0].rd.n, 2); assert.equal(log[1].rd, null); assert.equal(log[3].rd, null); assert.equal(log[4].rd, null)
})

test('套用 reads：只更新自己的訊息；沒變動回原陣列；壞資料不炸', () => {
  const log = roomLog([M(1, RD(0, 3)), M(2, { relation: 'other', from: 'x:r1', ...RD(0, 3) })], ['P'], [])
  const next = applyReads(log, [{ seq: 1, ...RD(2, 3, ['甲', '乙'], ['丙']) }, { seq: 2, ...RD(3, 3) }])
  assert.equal(next[0].rd.n, 2); assert.deepEqual(next[0].rd.by, ['甲', '乙'])
  assert.equal(next[1].rd, null, '別人發的不套用')
  assert.equal(applyReads(next, [{ seq: 1, ...RD(2, 3, ['甲', '乙'], ['丙']) }]), next, '沒變動回原陣列')
  assert.equal(applyReads(log, null), log); assert.equal(applyReads(log, 'x'), log); assert.equal(applyReads(log, [null, { seq: 1 }]), log)
})

test('還有人沒讀才需要在沒有新訊息時更新', () => {
  const log = roomLog([M(1, RD(3, 3)), M(2, RD(1, 3))], ['P'], [])
  assert.equal(hasPendingReads(log), true)
  assert.equal(hasPendingReads(roomLog([M(1, RD(3, 3))], ['P'], [])), false)
  assert.equal(hasPendingReads(roomLog([M(1)], ['P'], [])), false, '舊後台沒有欄位不輪詢')
})

const ROOM = { id: 'g1', name: '群', last_seq: 2, mine: [{ member: '~u:u1', unread: 0 }], members: [{ key: '~u:u1', label: '牧陽', member_kind: 'human', mine: true, role: 'owner' }] }
function hubWith(state) {
  const calls = []
  const invoke = async (cmd, args) => {
    calls.push([cmd, args])
    if (cmd === 'relay_rooms') return { rooms: [JSON.parse(JSON.stringify(ROOM))] }
    if (cmd === 'relay_room_read') return state.read(args)
    return {}
  }
  return { hub: createRoomHub({ invoke, groupApi: { confirmList: async () => ({}) }, selfNode: 'T', windowName: 'w' }), calls }
}

test('輪詢：沒有新訊息時，自己的訊息還有人沒讀就問一次（不標已讀）並更新人數；全部讀完後不再問', async () => {
  let n = 1
  const state = { read: args => (args.since === 0
    ? { messages: [M(1, { from: '~u:u1', ...RD(0, 2) }), M(2, { from: '~u:u1', ...RD(1, 2) })], last_seq: 2, reads: [] }
    : { messages: [], last_seq: 2, reads: [{ seq: 1, ...RD(n, 2, ['甲'], ['乙']) }, { seq: 2, ...RD(n, 2, ['甲'], ['乙']) }] }) }
  const { hub, calls } = hubWith(state)
  await hub.open('g1')
  assert.equal(hub.st.logs.g1[0].rd.n, 0)
  n = 2
  assert.equal(await hub.read('g1'), true)
  const q = calls.filter(([c]) => c === 'relay_room_read').at(-1)[1]
  assert.deepEqual([q.since, q.limit, q.mark], [2, 1, false], '從最後一則之後讀、只要 1 則、不標已讀')
  assert.deepEqual(hub.st.logs.g1.map(e => e.rd.n), [2, 2])
  const before = calls.length
  assert.equal(await hub.read('g1'), false, '全部讀完：不再問後台')
  assert.equal(calls.length, before)
})

test('輪詢：舊後台（沒有 reads、沒有人數欄位）不多打後台、不壞', async () => {
  const { hub, calls } = hubWith({ read: () => ({ messages: [M(2, { from: '~u:u1' })], last_seq: 2 }) })
  await hub.open('g1')
  const n = calls.length
  assert.equal(await hub.read('g1'), false); assert.equal(calls.length, n)
  assert.equal(hub.st.logs.g1[0].rd, null)
})

test('畫面：時間同一行的小字（不增加行高）、只對自己的群組訊息、桌面有 title；深色模式有覆寫', () => {
  const pane = fs.readFileSync(new URL('../ui/lib/chatpane.mjs', import.meta.url), 'utf8')
  assert.match(pane, /<span v-if="isRoom && m\.k === 'me' && readLabel\(m\.rd\)" class="read-n"[\s\S]*?:title="readTitle\(m\.rd\)"/)
  assert.ok(pane.indexOf('class="read-n"') > pane.indexOf('<time>') && pane.indexOf('class="read-n"') < pane.indexOf('class="quote"'), '在發言者行（時間旁）')
  const css = fs.readFileSync(new URL('../ui/group.css', import.meta.url), 'utf8')
  assert.match(css, /\.read-n\{[^}]*font-size:11px[^}]*\}/)
  assert.doesNotMatch(css.match(/\.read-n\{[^}]*\}/)[0], /display:(block|flex)|margin-top|padding/, '不增加行高')
  assert.match(css, /prefers-color-scheme:dark\)\{[\s\S]*?\.read-n\{color:#9fb0c3\}\.read-n\.all\{color:#6eb5ff\}\s*\}/)
})

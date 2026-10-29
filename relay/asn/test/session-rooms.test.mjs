// #539：重開後群組分頁要跟 1 對 1 一樣回來（還原名單含群組、等兩份名單都載完、讀取失敗不覆寫存檔）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { planRestore, snapshotSession } from '../ui/lib/session.mjs'
import { createRoomHub } from '../ui/lib/room-hub.mjs'
import { createGroupApi } from '../ui/lib/groups.mjs'

const read = f => fs.readFileSync(new URL(`../${f}`, import.meta.url), 'utf8')
const F = new Map([['A/a', { id: 'A/a', partnerId: 'p-a' }], ['A/b', { id: 'A/b', partnerId: 'p-b' }]])
const ROOMS = [{ id: 'room:g1', room: true }, { id: 'room:g2', room: true }]
const friendOf = id => F.get(id)
const LOADED = { rosterLoaded: true, roomsLoaded: true, roomsErr: false }

test('1 對 1 與群組分頁都回來，順序照存檔', () => {
  const saved = snapshotSession({ tabs: ['A/a', 'room:g1', 'A/b', 'room:g2'], active: 'A/b' }, friendOf)
  const r = planRestore(saved, { friends: F, rooms: ROOMS, ...LOADED })
  assert.deepEqual(r.tabs, ['A/a', 'room:g1', 'A/b', 'room:g2'])
  assert.equal(r.active, 'A/b')
  assert.equal(r.dropped, 0)
})

test('目前分頁是群組也回來；分開模式的群組視窗也回來', () => {
  const saved = snapshotSession({ tabs: ['A/a', 'room:g1'], active: 'room:g1', windows: ['room:g2', 'A/a'] }, friendOf)
  const r = planRestore(saved, { friends: F, rooms: ROOMS, ...LOADED })
  assert.equal(r.active, 'room:g1')
  assert.deepEqual(r.windows, ['room:g2', 'A/a'])
})

test('群組列表載完：已退出的群組略過（照常存檔），其他照回', () => {
  const saved = snapshotSession({ tabs: ['room:gone', 'A/a', 'room:g1'], active: 'room:gone' }, friendOf)
  const r = planRestore(saved, { friends: F, rooms: [ROOMS[0]], ...LOADED })
  assert.deepEqual(r.tabs, ['A/a', 'room:g1'])
  assert.equal(r.active, 'room:g1')
  assert.equal(r.dropped, 1)
})

test('還沒載完或群組列表讀取失敗：先不還原（回 null，存檔不動）', () => {
  const saved = snapshotSession({ tabs: ['A/a', 'room:g1'], active: 'room:g1' }, friendOf)
  assert.equal(planRestore(saved, { friends: F, rooms: [], rosterLoaded: true, roomsLoaded: false, roomsErr: true }), null, '第一次讀取失敗')
  assert.equal(planRestore(saved, { friends: F, rooms: ROOMS, rosterLoaded: true, roomsLoaded: true, roomsErr: true }), null, '最近一次讀取失敗')
  assert.equal(planRestore(saved, { friends: F, rooms: [], rosterLoaded: true, roomsLoaded: false, roomsErr: false }), null, '群組列表還沒回來')
  assert.equal(planRestore(saved, { friends: F, rooms: ROOMS, rosterLoaded: false, roomsLoaded: true, roomsErr: false }), null, '1 對 1 名單還沒回來')
  const later = planRestore(saved, { friends: F, rooms: ROOMS, ...LOADED })
  assert.deepEqual(later.tabs, ['A/a', 'room:g1'], '之後重抓成功就還原')
})

test('背景還原的群組不標已讀：open 帶 mark:false 就不叫後台標已讀、也不清未讀', async () => {
  const calls = []
  const room = { id: 'g1', name: '群', last_seq: 1, mine: [{ member: '~u:u1', unread: 2 }], members: [{ key: '~u:u1', label: '我', member_kind: 'human', mine: true }] }
  const invoke = async (cmd, args) => {
    calls.push([cmd, args])
    if (cmd === 'relay_rooms') return { rooms: [JSON.parse(JSON.stringify(room))] }
    if (cmd === 'relay_room_read') return { messages: [], last_seq: 1 }
    return {}
  }
  const hub = createRoomHub({ invoke, groupApi: createGroupApi(invoke), selfNode: 'T', windowName: 'w' })
  await hub.open('g1', { mark: false })
  assert.equal(calls.find(([c]) => c === 'relay_room_read')[1].mark, false)
  assert.equal(hub.rowOf('g1').unread, 2)
  await hub.open('g1')
  assert.equal(calls.filter(([c]) => c === 'relay_room_read').at(-1)[1].mark, true, '預設照可見與否')
})

test('接線守門：還原帶群組、等群組列表、整合模式讀進群組訊息但不拉主視窗', () => {
  const l = read('ui/list.js')
  assert.ok(l.includes('rooms: roomFriends.value'), '還原名單要帶群組')
  assert.ok(l.includes('roomsLoaded: hub.st.loaded') && l.includes('roomsErr: hub.st.err'), '要等群組列表載完、讀取失敗不還原')
  assert.ok(/watch\(\(\) => \[hub\.st\.loaded, hub\.st\.err\]/.test(l), '群組列表載完也要觸發還原')
  const fn = l.slice(l.indexOf('async function restoreOpenSession'), l.indexOf('if (!info.shot) {', l.indexOf('async function restoreOpenSession')))
  assert.ok(fn.includes('openedRooms.add(id)') && fn.includes('hub.open('), '整合模式還原群組要讀訊息')
  assert.ok(!fn.includes("'show_main'") && !fn.includes('openRoomChat('), '整合模式還原不拉主視窗')
  assert.ok(fn.includes('!isRoomChat(ui.active)'), '目前分頁是群組時不走 1 對 1 的已讀')
})

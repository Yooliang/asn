// #539：每 60 秒重抓群組時，只有目前看著的那個群組才標已讀；背景分頁的未讀照留（asn真 #1522 定案）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createRoomHub } from '../ui/lib/room-hub.mjs'
import { createGroupApi } from '../ui/lib/groups.mjs'
import { chatShown } from '../ui/lib/merge.mjs'

const read = f => fs.readFileSync(new URL(`../${f}`, import.meta.url), 'utf8')
const me = { key: '~u:u1', label: '我', member_kind: 'human', mine: true }
const roomOf = id => ({ id, name: id, last_seq: 3, mine: [{ member: '~u:u1', unread: 2 }], members: [me] })

function setup(visible) {
  const calls = []
  const invoke = async (cmd, args) => {
    calls.push([cmd, args])
    if (cmd === 'relay_rooms') return { rooms: [roomOf('g1'), roomOf('g2')] }
    if (cmd === 'relay_room_read') return { messages: [], last_seq: 3 }
    return {}
  }
  const hub = createRoomHub({ invoke, groupApi: createGroupApi(invoke), selfNode: 'T', windowName: 'w', visible })
  const markOf = rid => calls.filter(([c, a]) => c === 'relay_room_read' && a.room === rid).at(-1)?.[1].mark
  return { hub, calls, markOf }
}

// 照 list.js 的 refreshRooms：重抓列表，再逐一讀開著的群組（不帶 mark，由 visible 決定）
async function pollRooms(hub, ids) { await hub.refresh(); for (const id of ids) await hub.read(id) }

test('重抓時背景群組不標已讀、未讀保留；目前看著的群組標已讀', async () => {
  const { hub, markOf } = setup(rid => rid === 'g1')
  await pollRooms(hub, ['g1', 'g2'])
  assert.equal(markOf('g1'), true, '目前看著的群組要標已讀')
  assert.equal(hub.rowOf('g1').unread, 0)
  assert.equal(markOf('g2'), false, '背景群組不標已讀')
  assert.equal(hub.rowOf('g2').unread, 2, '背景群組的未讀要保留')
})

test('視窗看不到時，重抓後所有群組都不標已讀', async () => {
  const { hub, markOf } = setup(async () => false)
  await pollRooms(hub, ['g1', 'g2'])
  assert.equal(markOf('g1'), false)
  assert.equal(markOf('g2'), false)
  assert.equal(hub.rowOf('g1').unread, 2)
  assert.equal(hub.rowOf('g2').unread, 2)
})

test('可見判斷可以是非同步的（電腦版要問 Rust 視窗狀態）', async () => {
  const { hub, markOf } = setup(async rid => rid === 'g2')
  await pollRooms(hub, ['g1', 'g2'])
  assert.equal(markOf('g1'), false)
  assert.equal(markOf('g2'), true)
})

test('chatShown：整合模式＝目前分頁且主視窗看得到；分開模式＝該對話自己的視窗看得到', async () => {
  const fx = (main, wins) => ({ mainVisible: async () => main, chatVisible: async id => wins.includes(id) })
  const merged = { mode: 'merged', active: 'room:g1' }
  assert.equal(await chatShown(merged, 'room:g1', fx(true, [])), true)
  assert.equal(await chatShown(merged, 'room:g2', fx(true, [])), false, '背景分頁')
  assert.equal(await chatShown(merged, 'room:g1', fx(false, [])), false, '主視窗最小化或藏起來')
  const split = { mode: 'split', active: '' }
  assert.equal(await chatShown(split, 'room:g1', fx(true, ['room:g1'])), true)
  assert.equal(await chatShown(split, 'room:g2', fx(true, ['room:g1'])), false, '別的群組視窗開著不算')
  assert.equal(await chatShown(split, 'room:g1', fx(true, [])), false, '自己的視窗看不到（最小化／沒開）')
})

test('接線守門：電腦版與手機版的群組可見判斷都看「這個群組」，不是整扇視窗', () => {
  const l = read('ui/list.js')
  assert.ok(/createRoomHub\(\{[^\n]*visible: rid => chatShownId\(roomChatId\(rid\)\)/.test(l), '電腦版群組用同一套 1 對 1 的可見判斷')
  assert.ok(l.includes('isChatVisible: chatShownId'), '1 對 1 與群組共用同一個判斷')
  const m = read('ui/m.js')
  assert.ok(/createRoomHub\(\{[^\n]*visible: rid => core\.isChatVisible\(roomChatId\(rid\)\)/.test(m), '手機版群組也只算正在看的那一個')
})

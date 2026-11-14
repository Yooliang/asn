// 群組頂端「N 人離線」（#1460）：人數與名單的純函式
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { offlineNames, offlineView } from '../ui/lib/group-offline.mjs'
import { MEMBER_NOT_FRIEND, memberFriendId } from '../ui/lib/groups.mjs'
const labels = list => list.map(n => n.label)
import { roomItems, roomPseudoFriend } from '../ui/lib/mobile-rooms.mjs'

const me = { key: '~u:me', name: '我', member_kind: 'human', kind: 'owner', mine: true }
const ai = (key, name, online, extra = {}) => ({ key, name, member_kind: 'ai', kind: 'window', mine: true, engine: 'claude', online, ...extra })

test('全員在線：不顯示', () => {
  const names = offlineNames([me, ai('H~財務', '財務', true), { key: 'x:r1aaaaaa', name: '小良', member_kind: 'human', kind: 'human', mine: false }])
  assert.deepEqual(names, [])
  assert.equal(offlineView(names), null)
})

test('部分離線：人數與名單正確；自己本人與沒有狀態的真人不算，自己名下離線的 AI 要算', () => {
  const names = offlineNames([me, ai('H~財務', '財務', true), ai('H~審稿', '審稿', false), ai('x:r2bbbbbb', '報表', false, { mine: false, kind: 'ai' }), { key: 'x:r1aaaaaa', name: '小良', member_kind: 'human', kind: 'human', mine: false }])
  assert.deepEqual(labels(names), ['審稿', '報表'])
  assert.deepEqual(names.map(n => n.key), ['H~審稿', 'x:r2bbbbbb'], '帶出成員鍵，點了跳一對一（#1515）')
  const v = offlineView(names)
  assert.equal(v.label, '2 人離線')
  assert.deepEqual(v.names, ['審稿', '報表'])
  assert.deepEqual(v.items, [{ key: 'H~審稿', label: '審稿' }, { key: 'x:r2bbbbbb', label: '報表' }])
  assert.match(v.aria, /2 人離線/)
})

test('同名的離線成員第二位起加（2）；名字不外洩內部代號', () => {
  const names = offlineNames([ai('H~a', '審稿', false), ai('H~b', '審稿', false), ai('x:abcdef123456', 'x:abcdef123456', false)])
  assert.equal(names[0].label, '審稿')
  assert.equal(names[1].label, '審稿（2）')
  assert.ok(!labels(names).join('').includes('x:abcdef'))
})

test('舊後台沒有 online 欄位：當在線，不算離線', () => {
  assert.deepEqual(offlineNames([{ key: 'H~a', name: 'a', member_kind: 'ai', kind: 'window' }]), [])
})

test('讀不到成員：不顯示、不報錯', () => {
  for (const bad of [undefined, null, 'x', 42, {}, [null, 1, 'a', {}], [{ key: 5 }]]) {
    assert.deepEqual(offlineNames(bad), [])
  }
  assert.equal(offlineView(undefined), null)
  assert.equal(offlineView(null), null)
  assert.equal(offlineView([]), null)
  assert.equal(offlineView([1, '', null]), null)
})

test('群組名單列與群組偽夥伴把離線名單帶到畫面（電腦與手機同一份）', () => {
  const rows = roomItems([{ id: 'g1', name: '群', members: [me, ai('H~審稿', '審稿', false)], mine: [] }])
  assert.deepEqual(rows[0].offline, [{ key: 'H~審稿', label: '審稿' }])
  assert.deepEqual(roomPseudoFriend(rows[0]).offline, [{ key: 'H~審稿', label: '審稿' }])
  assert.deepEqual(roomPseudoFriend({ chatId: 'c', name: 'g', count: 0 }).offline, [])
})

test('舊格式（只有名字的陣列）照樣顯示，只是列沒有 key 不能點', () => {
  const v = offlineView(['審稿'])
  assert.deepEqual(v.items, [{ key: '', label: '審稿' }])
  assert.equal(v.label, '1 人離線')
})

test('成員鍵 → 一對一夥伴 id（#1515）：找得到回 id；不在名單、真人、別人的 AI、格式不對都回 null', () => {
  const ids = new Map([['H/審稿', {}], ['W/財務', {}]])
  assert.equal(memberFriendId('H~審稿', ids), 'H/審稿')
  assert.equal(memberFriendId('W~財務', [{ id: 'W/財務' }]), 'W/財務', '陣列（夥伴物件）也可以')
  assert.equal(memberFriendId('W~財務', ['W/財務']), 'W/財務', '陣列（id 字串）也可以')
  assert.equal(memberFriendId('H~不認識', ids), null, '不在夥伴名單')
  for (const bad of ['x:r1aaaaaa', '~u:me', '~H~a', 'H~', '', 'H/審稿', null, 42]) assert.equal(memberFriendId(bad, ids), null, String(bad))
  assert.equal(memberFriendId('H~審稿', null), null, '名單讀不到')
  assert.match(MEMBER_NOT_FRIEND, /不在你的夥伴名單/)
})

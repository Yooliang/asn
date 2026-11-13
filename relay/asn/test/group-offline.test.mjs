// 群組頂端「N 人離線」（#1460）：人數與名單的純函式
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { offlineNames, offlineView } from '../ui/lib/group-offline.mjs'
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
  assert.deepEqual(names, ['審稿', '報表'])
  const v = offlineView(names)
  assert.equal(v.label, '2 人離線')
  assert.deepEqual(v.names, ['審稿', '報表'])
  assert.match(v.aria, /2 人離線/)
})

test('同名的離線成員第二位起加（2）；名字不外洩內部代號', () => {
  const names = offlineNames([ai('H~a', '審稿', false), ai('H~b', '審稿', false), ai('x:abcdef123456', 'x:abcdef123456', false)])
  assert.equal(names[0], '審稿')
  assert.equal(names[1], '審稿（2）')
  assert.ok(!names.join('').includes('x:abcdef'))
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
  assert.deepEqual(rows[0].offline, ['審稿'])
  assert.deepEqual(roomPseudoFriend(rows[0]).offline, ['審稿'])
  assert.deepEqual(roomPseudoFriend({ chatId: 'c', name: 'g', count: 0 }).offline, [])
})

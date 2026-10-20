// 整合模式對話分頁：固定、排序、右鍵選單批次關閉
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  closeAllChatTabs,
  closeChatTab,
  closeOtherChatTabs,
  closeRightChatTabs,
  isPinned,
  normalizePinned,
  openChatTab,
  orderTabs,
  toggleChatPin,
} from '../ui/lib/ctabs.mjs'

test('固定清單：只收字串、去重、上限', () => {
  assert.deepEqual(normalizePinned(null), [])
  assert.deepEqual(normalizePinned(['a', 'a', 3, '', 'b']), ['a', 'b'])
  assert.equal(normalizePinned(Array.from({ length: 50 }, (_, i) => `x${i}`)).length, 40)
})

test('排序：固定的排最前，其餘維持相對順序', () => {
  assert.deepEqual(orderTabs(['b', 'c', 'a'], ['a', 'c']), ['a', 'c', 'b'])
  assert.deepEqual(orderTabs(['b', 'a'], ['x', 'a']), ['a', 'b'])
})

test('開分頁：新開的若已固定會排到固定區', () => {
  const st = { tabs: ['b'], active: 'b' }
  const r = openChatTab(st, 'a', ['a'])
  assert.deepEqual(r.tabs, ['a', 'b'])
  assert.equal(r.active, 'a')
})

test('關閉其他：保留目前分頁與所有固定', () => {
  const st = { tabs: ['p', 'a', 'b', 'c'], active: 'b' }
  const pinned = ['p']
  assert.deepEqual(closeOtherChatTabs(st, 'b', pinned), { tabs: ['p', 'b'], active: 'b' })
  assert.deepEqual(closeOtherChatTabs(st, 'a', pinned), { tabs: ['p', 'a'], active: 'a' })
})

test('關閉右側：不含固定分頁', () => {
  const st = { tabs: ['a', 'p', 'b', 'c'], active: 'a' }
  const pinned = ['p']
  assert.deepEqual(closeRightChatTabs(st, 'a', pinned), { tabs: ['a', 'p'], active: 'a' })
  assert.deepEqual(closeRightChatTabs(st, 'p', pinned), { tabs: ['a', 'p'], active: 'a' })
})

test('全部關閉：只留固定；目前分頁若被關掉就切到最後一個固定', () => {
  const st = { tabs: ['p', 'a', 'b'], active: 'b' }
  assert.deepEqual(closeAllChatTabs(st, ['p']), { tabs: ['p'], active: 'p' })
  const st2 = { tabs: ['p', 'q', 'a'], active: 'a' }
  assert.deepEqual(closeAllChatTabs(st2, ['p', 'q']), { tabs: ['p', 'q'], active: 'q' })
})

test('單關：固定分頁也能關（右鍵「關閉」）', () => {
  const st = { tabs: ['p', 'a'], active: 'p' }
  assert.deepEqual(closeChatTab(st, 'p'), { tabs: ['a'], active: 'a' })
})

test('切換固定：加入或移除並重排', () => {
  const st = { tabs: ['a', 'b'], active: 'b' }
  const on = toggleChatPin(st, 'b', [])
  assert.deepEqual(on.pinned, ['b'])
  assert.deepEqual(on.tabs, ['b', 'a'])
  const off = toggleChatPin(st, 'b', ['b'])
  assert.deepEqual(off.pinned, [])
  assert.deepEqual(off.tabs, ['a', 'b'])
})

test('isPinned', () => {
  assert.equal(isPinned('a', ['a']), true)
  assert.equal(isPinned('b', ['a']), false)
})

// 整合模式對話分頁：固定、排序、右鍵選單批次關閉
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import {
  closeAllChatTabs,
  closeIdleChatTabs,
  idleTabIds,
  isTabBusy,
  withCallState,
  closeChatTab,
  closeOtherChatTabs,
  closeRightChatTabs,
  isPinned,
  normalizePinned,
  openChatTab,
  orderTabs,
  toggleChatPin,
  chatTabSameZone,
  dropInsertBefore,
  moveChatTab,
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

test('同一區：固定與一般分開', () => {
  assert.equal(chatTabSameZone('a', 'b', ['a']), false)
  assert.equal(chatTabSameZone('a', 'c', ['a', 'c']), true)
  assert.equal(chatTabSameZone('x', 'y', []), true)
})

test('拖曳固定分頁：只改 pinned 順序', () => {
  const tabs = ['p2', 'p1', 'a', 'b']
  const pinned = ['p1', 'p2']
  const r = moveChatTab(tabs, pinned, 'p2', 'p1')
  assert.deepEqual(r.pinned, ['p2', 'p1'])
  assert.deepEqual(r.tabs, ['p2', 'p1', 'a', 'b'])
})

test('拖曳一般分頁：pinned 不變', () => {
  const tabs = ['p', 'a', 'b', 'c']
  const pinned = ['p']
  const r = moveChatTab(tabs, pinned, 'c', 'a')
  assert.deepEqual(r.pinned, ['p'])
  assert.deepEqual(r.tabs, ['p', 'c', 'a', 'b'])
})

test('跨區拖曳：不變', () => {
  const tabs = ['p', 'a', 'b']
  const pinned = ['p']
  const before = moveChatTab(tabs, pinned, 'a', 'p')
  assert.deepEqual(before, { tabs: ['p', 'a', 'b'], pinned: ['p'] })
  const after = moveChatTab(tabs, pinned, 'p', 'a')
  assert.deepEqual(after, { tabs: ['p', 'a', 'b'], pinned: ['p'] })
})

test('拖到區域最後', () => {
  const tabs = ['a', 'b', 'c']
  assert.deepEqual(moveChatTab(tabs, [], 'a', ''), { tabs: ['b', 'c', 'a'], pinned: [] })
  assert.deepEqual(moveChatTab(['p1', 'p2', 'a'], ['p1', 'p2'], 'p1', null), {
    pinned: ['p2', 'p1'],
    tabs: ['p2', 'p1', 'a'],
  })
})

test('拖到右半＝插在後面；拖到該區最後一個的右半＝放到最後', () => {
  const tabs = ['p1', 'p2', 'a', 'b', 'c'], pinned = ['p1', 'p2']
  assert.equal(dropInsertBefore(tabs, pinned, 'b', false), 'b')
  assert.equal(dropInsertBefore(tabs, pinned, 'b', true), 'c')
  assert.equal(dropInsertBefore(tabs, pinned, 'c', true), '')
  assert.deepEqual(moveChatTab(tabs, pinned, 'a', dropInsertBefore(tabs, pinned, 'c', true)).tabs, ['p1', 'p2', 'b', 'c', 'a'])
  // 固定區最後一個的右半：只到固定區最後，不跑進一般區
  assert.equal(dropInsertBefore(tabs, pinned, 'p2', true), '')
  assert.deepEqual(moveChatTab(tabs, pinned, 'p1', dropInsertBefore(tabs, pinned, 'p2', true)).pinned, ['p2', 'p1'])
})

test('關閉閒置：忙碌、等回信、啟動中、通話中、已固定都留下', () => {
  const fr = { a: { status: 'online' }, b: { status: 'busy' }, c: { status: 'away', waiting: true }, d: { status: 'online', inCall: true }, e: { status: 'online' }, f: { status: 'online' }, g: { status: 'online', pending: true } }
  const of = id => fr[id]
  assert.deepEqual(idleTabIds(['a', 'b', 'c', 'd', 'e', 'f', 'g'], ['e'], of), ['a', 'f'])
  const r = closeIdleChatTabs({ tabs: ['a', 'b', 'e', 'f'], active: 'a' }, ['e'], of)
  assert.deepEqual(r.tabs, ['b', 'e'])
  assert.equal(r.active, 'b')   // 目前分頁閒置也關，換到鄰近留下的
})

test('關閉閒置：全是閒置＝同全部關閉；沒有閒置＝不動；找不到好友算閒置', () => {
  const of = () => ({ status: 'online' })
  const st = { tabs: ['a', 'b', 'p'], active: 'a' }
  assert.deepEqual(closeIdleChatTabs(st, ['p'], of), closeAllChatTabs(st, ['p']))
  assert.deepEqual(closeIdleChatTabs({ tabs: ['a'], active: 'a' }, [], of), { tabs: [], active: '' })
  assert.deepEqual(closeIdleChatTabs({ tabs: ['a'], active: 'a' }, [], () => ({ status: 'busy' })), { tabs: ['a'], active: 'a' })
  assert.deepEqual(idleTabIds(['x'], [], () => undefined), ['x'])
  assert.equal(isTabBusy({ panel: 'guide', status: 'busy' }), false)
})

test('關閉閒置：通話中的分頁（整合模式 chat-pane 的 call-state、分開模式對話視窗的廣播）算忙碌，不被關', async () => {
  const { createCallBeats, CALL_BEAT_EXPIRE_MS } = await import('../ui/lib/call-beats.mjs')
  let t = 1000
  const beats = createCallBeats({ now: () => t })
  const merged = { b: true }
  const fr = { a: { id: 'a', status: 'online' }, b: { id: 'b', status: 'online' }, c: { id: 'c', status: 'online' } }
  const of = id => withCallState(fr[id], merged[id] || beats.isCalling(id))
  // b 在整合模式通話中、c 在分開視窗通話中：只剩 a 可關
  beats.onBeat({ id: 'c', active: true })
  assert.deepEqual(idleTabIds(['a', 'b', 'c'], [], of), ['a'])
  // c 掛斷（active:false）、b 的 chat-pane 回報結束：都變閒置
  beats.onBeat({ id: 'c', active: false }); delete merged.b
  assert.deepEqual(idleTabIds(['a', 'b', 'c'], [], of), ['a', 'b', 'c'])
  // 視窗被直接關掉沒廣播結束：超過期限就當作結束，不會永遠卡著關不掉
  beats.onBeat({ id: 'c', active: true }); t += CALL_BEAT_EXPIRE_MS
  assert.equal(beats.isCalling('c'), false)
  assert.equal(withCallState(undefined, true), undefined, '找不到好友仍當作閒置')
  assert.equal(isTabBusy(withCallState({ status: 'online' }, true)), true)
})

test('關閉閒置：名單視窗真的把通話狀態接到分頁（接線守門）', () => {
  const js = fs.readFileSync(new URL('../ui/list.js', import.meta.url), 'utf8'), html = fs.readFileSync(new URL('../ui/list.html', import.meta.url), 'utf8')
  assert.match(html, /@call-state="on => setPaneCall\(t\.id, on\)"/, '整合模式的 chat-pane 通話事件要接上')
  assert.match(js, /tabFriendOf = id => withCallState\([^\n]*callBeats\.isCalling\(id\)/, '分開模式的廣播也要算進去')
})

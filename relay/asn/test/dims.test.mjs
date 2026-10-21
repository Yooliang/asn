// 分頁依／分組依：維度計算、選項連動、舊設定轉換、廠商推斷。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_DIMS, groupItems, groupOptions, loadDims, normalizeDims, pageItems, pageTabs, withTabDim } from '../ui/lib/dims.mjs'
import { engineKey, groupHeading } from '../ui/lib/tabs.mjs'
import { buildFriends } from '../ui/lib/roster.mjs'

const F = (node, device, nick, status = 'online', engine = null, kind = null, unread = 0) => ({ id: `${node}/${nick}`, node, device, nick, status, engine, kind, unread })
const SAMPLE = [
  F('H', '家用機', 'a', 'online', 'claude'), F('H', '家用機', 'b', 'busy', 'claude', null, 2),
  F('W', '工作機', 'c', 'offline', null, 'claude'), F('G', 'grok機', 'd', 'away', null, 'grok', 1),
  F('A', '牧陽', 'e', 'online', null, 'other'), F('A', '牧陽', 'f', 'online', 'deepseek'),
]

test('預設：分頁依設備、分組依狀態', () => assert.deepEqual(DEFAULT_DIMS, { tabDim: 'device', groupDim: 'status' }))

test('選項連動：分組選項排除分頁維度；撞到時自動改剩下兩個裡的第一個', () => {
  assert.deepEqual(groupOptions('device').map(d => d.key), ['status', 'engine'])
  assert.deepEqual(groupOptions('engine').map(d => d.key), ['status', 'device'])
  assert.deepEqual(groupOptions('status').map(d => d.key), ['engine', 'device'])
  assert.deepEqual(withTabDim({ tabDim: 'device', groupDim: 'status' }, 'status'), { tabDim: 'status', groupDim: 'engine' })
  assert.deepEqual(withTabDim({ tabDim: 'device', groupDim: 'engine' }, 'engine'), { tabDim: 'engine', groupDim: 'status' })
  assert.deepEqual(withTabDim({ tabDim: 'device', groupDim: 'engine' }, 'status'), { tabDim: 'status', groupDim: 'engine' })
  assert.deepEqual(normalizeDims({ tabDim: 'xx', groupDim: 'yy' }), DEFAULT_DIMS)
})

test('舊存檔 groupMode 轉成新設定', () => {
  assert.deepEqual(loadDims({ groupMode: 'status' }), { tabDim: 'device', groupDim: 'status' })
  assert.deepEqual(loadDims({ groupMode: 'engine' }), { tabDim: 'device', groupDim: 'engine' })
  assert.deepEqual(loadDims({}), DEFAULT_DIMS)
  assert.deepEqual(loadDims(null), DEFAULT_DIMS)
  assert.deepEqual(loadDims({ tabDim: 'engine', groupDim: 'device', groupMode: 'status' }), { tabDim: 'engine', groupDim: 'device' })
})

test('廠商推斷：engine 優先；null 用節點 kind（claude/gpt/gemini/grok）；other 不採用', () => {
  assert.equal(engineKey(F('H', 'h', 'x', 'online', 'Gemini', 'claude')), 'gemini')
  assert.equal(engineKey(F('W', 'w', 'x', 'online', null, 'claude')), 'claude')
  assert.equal(engineKey(F('G', 'g', 'x', 'online', null, 'grok')), 'grok')
  assert.equal(engineKey(F('P', 'p', 'x', 'online', null, 'gpt')), 'gpt')
  assert.equal(engineKey(F('A', 'a', 'x', 'online', null, 'other')), 'other')
  assert.equal(engineKey(F('A', 'a', 'x', 'online', null, null)), 'other')
})

test('buildFriends 把節點 kind 帶進好友', () => {
  const fr = buildFriends([{ id: 'W', name: '工作機', kind: 'claude', agents: [{ name: 'W-x', status: 'idle' }] }, { id: 'A', kind: 'other', agents: [{ name: 'A-x', engine: 'claude' }] }], { selfNode: 'H', selfName: 'H-ASN' })
  assert.deepEqual(fr.map(f => [f.node, f.kind, f.engine]), [['W', 'claude', null], ['A', 'other', 'claude']])
  assert.equal(engineKey(fr[0]), 'claude')
})

test('分頁依廠商：用 vendorKey 而非首字母', () => {
  const t = pageTabs(SAMPLE, 'engine', { selfNode: 'H' })
  const cl = t.all.find(x => x.key === 'claude')
  assert.equal(cl.vendorKey, 'claude')
  assert.equal(cl.short, '')
})

test('分頁依廠商：排序、首字母、未讀與人數彙總；kind 推斷的歸進對應廠商', () => {
  const t = pageTabs(SAMPLE, 'engine', { selfNode: 'H' })
  assert.deepEqual(t.all.map(x => x.label), ['Claude', 'Grok', 'DeepSeek', '其他'])
  assert.deepEqual(t.all.map(x => x.vendorKey), ['claude', 'grok', 'deepseek', 'other'])
  const c = t.all[0]
  assert.deepEqual([c.total, c.online, c.unread], [3, 2, 2])
  assert.equal(t.all[1].unread, 1)
})

test('分頁依廠商：超過 6 個收進「更多」，「其他」排最後', () => {
  const fr = ['claude', 'gemini', 'grok', 'codex', 'deepseek', 'zeta', 'alpha'].map((e, i) => F('n' + i, 'd', 'x' + i, 'online', e)).concat(F('o', 'o', 'y', 'online'))
  const t = pageTabs(fr, 'engine', { selfNode: 'n0' })
  assert.deepEqual(t.all.map(x => x.key), ['claude', 'gemini', 'grok', 'codex', 'deepseek', 'alpha', 'zeta', 'other'])
  assert.deepEqual(t.visible.map(x => x.key), ['claude', 'gemini', 'grok', 'codex', 'deepseek'])
  assert.deepEqual(t.more.map(x => x.key), ['alpha', 'zeta', 'other'])
})

test('分頁依狀態：四個固定、沒人的標 empty、未讀彙總', () => {
  const t = pageTabs(SAMPLE, 'status', { selfNode: 'H' })
  assert.deepEqual(t.all.map(x => [x.label, x.total, x.empty]), [['線上', 3, false], ['忙碌', 1, false], ['暫離', 1, false], ['離線', 1, false]])
  assert.equal(t.all[1].unread, 2)
  const none = pageTabs([], 'status', { selfNode: 'H' })
  assert.equal(none.all.length, 4)
  assert.ok(none.all.every(x => x.empty))
})

test('分頁依設備：跟舊的一樣，本機第一、本機沒人也不灰', () => {
  const t = pageTabs(SAMPLE, 'device', { selfNode: 'H', nodeOrder: ['W', 'H', 'G', 'A'] })
  assert.deepEqual(t.all.map(x => x.key), ['H', 'W', 'G', 'A'])
  assert.equal(pageTabs([], 'device', { selfNode: 'H' }).all[0].empty, false)
})

test('pageItems：依維度取該頁籤的好友，線上在前', () => {
  assert.deepEqual(pageItems(SAMPLE, 'engine', 'claude').map(f => f.nick), ['a', 'b', 'c'])
  assert.deepEqual(pageItems(SAMPLE, 'status', 'online').map(f => f.nick), ['a', 'e', 'f'])
  assert.deepEqual(pageItems(SAMPLE, 'device', 'H', f => f.nick === 'b').map(f => f.nick), ['b'])
})

test('分組：設備組用設備名、本機排第一；標題規則照 groupHeading', () => {
  const g = groupItems(pageItems(SAMPLE, 'engine', 'claude'), 'device', { selfNode: 'H' })
  assert.deepEqual(g.map(x => x.label), ['家用機', '工作機'])
  assert.equal(groupHeading(g[0]), '家用機 (2/2)')
  assert.equal(groupHeading(g[1]), '工作機 (0/1)')
  const gw = groupItems(pageItems(SAMPLE, 'engine', 'claude'), 'device', { selfNode: 'W' })
  assert.deepEqual(gw.map(x => x.label), ['工作機', '家用機'])
  const st = groupItems(pageItems(SAMPLE, 'device', 'A'), 'status')
  assert.deepEqual(st.map(x => groupHeading(x)), ['線上 (2)'])
  const en = groupItems(pageItems(SAMPLE, 'status', 'online'), 'engine')
  assert.deepEqual(en.map(x => groupHeading(x)), ['Claude (1/1)', 'DeepSeek (1/1)', '其他 (1/1)'])
})

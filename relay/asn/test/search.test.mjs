// 名單全域搜尋：跨分頁比對、分組仍照設定。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { friendMatchesQuery, normalizeSearchQuery, rosterListItems, rosterShownGroups } from '../ui/lib/search.mjs'

const plain = s => String(s ?? '')
const F = (node, device, nick, status = 'online', engine = null) => ({ id: `${node}/${nick}`, node, device, nick, status, engine })

const SAMPLE = [
  F('H', '家用機', 'Alpha', 'online', 'claude'),
  F('H', '家用機', 'Beta', 'busy', 'claude'),
  F('W', '工作機', 'Alpha-W', 'offline', 'claude'),
  F('G', 'grok機', 'GrokBot', 'away', null),
]

test('normalizeSearchQuery：去空白、轉小寫', () => {
  assert.equal(normalizeSearchQuery('  AbC  '), 'abc')
  assert.equal(normalizeSearchQuery(''), '')
})

test('friendMatchesQuery：比對暱稱（不分大小寫）', () => {
  assert.equal(friendMatchesQuery(F('H', 'h', 'Hello'), 'hel', plain), true)
  assert.equal(friendMatchesQuery(F('H', 'h', 'Hello'), 'xyz', plain), false)
  assert.equal(friendMatchesQuery(F('H', 'h', 'Hello'), '', plain), true)
})

test('rosterListItems：無關鍵字只取目前分頁', () => {
  const onH = rosterListItems(SAMPLE, { tabDim: 'device', tabKey: 'H', query: '', plainText: plain })
  assert.deepEqual(onH.map(f => f.nick), ['Alpha', 'Beta'])
  const claude = rosterListItems(SAMPLE, { tabDim: 'engine', tabKey: 'claude', query: '  ', plainText: plain })
  assert.deepEqual(claude.map(f => f.nick), ['Alpha', 'Beta', 'Alpha-W'])
})

test('rosterListItems：有關鍵字跨所有分頁', () => {
  const hits = rosterListItems(SAMPLE, { tabDim: 'device', tabKey: 'H', query: 'alpha', plainText: plain })
  assert.deepEqual(hits.map(f => f.nick), ['Alpha', 'Alpha-W'])
  const grok = rosterListItems(SAMPLE, { tabDim: 'device', tabKey: 'H', query: 'grok', plainText: plain })
  assert.deepEqual(grok.map(f => f.nick), ['GrokBot'])
})

test('rosterShownGroups：全域搜尋仍依分組設定', () => {
  const g = rosterShownGroups(SAMPLE, {
    tabDim: 'device', tabKey: 'H', groupDim: 'device', selfNode: 'H', query: 'alpha', plainText: plain,
  })
  assert.deepEqual(g.map(x => x.label), ['家用機', '工作機'])
  assert.deepEqual(g[0].items.map(f => f.nick), ['Alpha'])
  assert.deepEqual(g[1].items.map(f => f.nick), ['Alpha-W'])
})

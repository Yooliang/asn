// 名單上「ASN 程式本身」的視窗（engine＝asn）一律隱藏；設備分組、設備頁籤仍在，人數與未讀不算它。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildFriends, isAsnWindow, withoutAsn } from '../ui/lib/roster.mjs'
import { deviceItems, deviceTabs, groupHeading } from '../ui/lib/tabs.mjs'
import { pageItems, pageTabs } from '../ui/lib/dims.mjs'
import { rosterListItems, rosterShownGroups } from '../ui/lib/search.mjs'
import { rosterGroups, totalUnread } from '../ui/lib/mobile.mjs'
import { totalUnread as prefsUnread } from '../ui/lib/prefs.mjs'
import { activeFriends, archivedFriends } from '../ui/lib/archive.mjs'
import { isManageable } from '../ui/lib/partner-ops.mjs'

const F = (node, nick, engine, extra = {}) => ({ id: `${node}/${nick}`, node, agent: nick, nick, device: `設備${node}`, engine, status: 'online', unread: 0, ...extra })
const FRIENDS = [
  F('H', '小良的家用機', 'asn', { unread: 3 }),
  F('H', '甲', 'claude', { unread: 1 }),
  F('H', '乙', 'gemini', { status: 'offline' }),
  F('P', 'Oppo 手機', 'asn'),                                  // 只有 ASN 視窗的設備
  F('W', '啟良的工作機', 'asn', { archived: true }),
  F('W', '丙', 'claude'),
]
const O = { selfNode: 'H', selfName: '小良的家用機', plainText: s => s }
const names = items => items.map(f => f.nick)

test('判斷：engine＝asn（不分大小寫、含空白）才是 ASN 視窗，沒回報類型的不算', () => {
  assert.equal(isAsnWindow({ engine: 'asn' }), true)
  assert.equal(isAsnWindow({ engine: ' ASN ' }), true)
  assert.equal(isAsnWindow({ engine: 'claude' }), false)
  assert.equal(isAsnWindow({ engine: null }), false)
  assert.equal(isAsnWindow(undefined), false)
  assert.deepEqual(names(withoutAsn(FRIENDS)), ['甲', '乙', '丙'])
})

test('資料層照舊保留 ASN 視窗（往來記錄、設備名、遠端更新靠它），隱藏只在顯示層', () => {
  const members = [{ id: 'H', name: '小良的家用機', agents: [{ name: '小良的家用機', engine: 'asn' }, { name: '甲', engine: 'claude' }] }]
  const live = buildFriends(members, { selfNode: 'X', selfName: 'X' })
  assert.deepEqual(live.map(f => f.nick), ['小良的家用機', '甲'])
})

test('手機名單：不列 ASN 視窗；設備分組標題人數不算它；只剩 ASN 視窗的設備不出空組', () => {
  const g = rosterGroups(FRIENDS, O)
  assert.deepEqual(g.map(x => x.node), ['H', 'W'])
  const all = g.flatMap(x => x.items)
  assert.deepEqual(names(all).sort(), ['丙', '乙', '甲'].sort())
  const h = g.find(x => x.node === 'H')
  assert.equal(groupHeading(h), '小良的家用機 (1/2)')
  assert.equal(totalUnread(FRIENDS), 1)
  assert.equal(prefsUnread(FRIENDS), 1)
})

test('電腦名單：設備頁籤照開、人數與未讀不算 ASN；頁內與搜尋都不列', () => {
  const t = deviceTabs(FRIENDS, { selfNode: 'H', selfName: '小良的家用機', nodeOrder: ['H', 'P', 'W'] })
  assert.deepEqual(t.all.map(x => x.key), ['H', 'W', 'P'], '只有 ASN 視窗的設備（P）頁籤也在；沒有人在線的排在有人在線的後面')
  const by = Object.fromEntries(t.all.map(x => [x.key, x]))
  assert.deepEqual([by.H.total, by.H.online, by.H.unread], [2, 1, 1])
  assert.deepEqual([by.P.total, by.P.online], [0, 0])
  assert.equal(by.W.total, 1)
  const dev = pageTabs(FRIENDS, 'device', { selfNode: 'H', selfName: '小良的家用機', nodeOrder: ['H', 'P', 'W'] })
  assert.deepEqual(dev.all.map(x => x.key), ['H', 'W', 'P'])
  assert.deepEqual(names(deviceItems(FRIENDS, 'H')), ['甲', '乙'])
  assert.deepEqual(names(pageItems(FRIENDS, 'device', 'H')), ['甲', '乙'])
  assert.deepEqual(names(rosterListItems(FRIENDS, { tabDim: 'device', tabKey: 'P', query: '', plainText: O.plainText })), [])
  assert.deepEqual(names(rosterListItems(FRIENDS, { tabDim: 'device', tabKey: 'H', query: 'asn', plainText: O.plainText })), [], '搜尋也找不到')
  assert.deepEqual(names(rosterListItems(FRIENDS, { tabDim: 'device', tabKey: 'H', query: '機', plainText: O.plainText })), [])
  const groups = rosterShownGroups(FRIENDS, { tabDim: 'device', tabKey: 'H', groupDim: 'status', query: '', ...O })
  assert.deepEqual(groups.flatMap(g => names(g.items)).sort(), ['乙', '甲'])
})

test('狀態與廠商頁籤：ASN 不算人數，廠商頁籤沒有 asn 那一頁', () => {
  const st = pageTabs(FRIENDS, 'status', { selfNode: 'H' })
  assert.equal(st.all.reduce((n, t) => n + t.total, 0), 3, '只算甲乙丙')
  const en = pageTabs(FRIENDS, 'engine', { selfNode: 'H' })
  assert.deepEqual(en.all.map(t => t.key), ['claude', 'gemini'])
})

test('封存與一般清單：ASN 視窗不進「已封存」也不進一般清單', () => {
  assert.deepEqual(names(activeFriends(FRIENDS)), ['甲', '乙', '丙'])
  assert.deepEqual(names(archivedFriends(FRIENDS)), [])
})

test('夥伴管理仍排除 ASN 視窗', () => {
  assert.equal(isManageable(F('H', '小良的家用機', 'asn')), false)
  assert.equal(isManageable(F('H', '甲', 'claude')), true)
})

test('電腦版 rosterShownGroups：分組依設備時把 deviceOrder 傳下去', () => {
  const f = (node, device, nick) => ({ id: `${node}/${nick}`, node, device, nick, status: 'online', engine: 'claude', unread: 0 })
  const fl = [f('H', '家用機', 'a'), f('W', '工作機', 'b'), f('A', '牧陽', 'd')]
  const o = { tabDim: 'engine', tabKey: 'claude', groupDim: 'device', selfNode: 'H', selfName: '', query: '', plainText: s => s }
  assert.deepEqual(rosterShownGroups(fl, { ...o, deviceOrder: ['A', 'W'] }).map(g => g.node), ['H', 'A', 'W'])
})

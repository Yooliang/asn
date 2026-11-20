// 夥伴列表同一設備內的順序（#1729）：釘選全部在最上面，其餘照最新訊息時間由新到舊
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { pinnedRecentOrder, rosterShownGroups, sortFriends } from '../ui/lib/search.mjs'
import { rosterGroups } from '../ui/lib/mobile.mjs'

const read = p => fs.readFileSync(new URL(p, import.meta.url), 'utf8')
const D = 86_400_000, NOW = Date.UTC(2026, 10, 18)
const F = (nick, lastAt, o = {}) => ({ id: `H/${nick}`, node: 'H', device: '家用機', nick, agent: nick, status: 'online', engine: 'claude', lastAt, ...o })
const pins = ids => ({ pins: ids.map((id, i) => ({ id: `H/${id}`, at: 1000 + i })), unpinned: [], rev: 1 })
// 情境照擁有者的手機截圖：釘選的夾在中間、星期五排在 10/30 前面、10/30 又排在星期一前面
const friends = () => [F('甲', NOW - 3 * D), F('乙釘', NOW - 20 * D), F('丙', NOW - 19 * D), F('丁', NOW - 1 * D), F('戊釘', NOW - 9 * D), F('己離線', NOW - 2 * D, { status: 'offline' }), F('庚', 0)]
const names = list => list.map(f => f.nick)

test('排序：釘選在最上面（釘選之間也照時間），其餘照最新訊息時間由新到舊；沒有時間的最後', () => {
  const out = sortFriends(friends(), pinnedRecentOrder(pins(['乙釘', '戊釘'])))
  assert.deepEqual(names(out), ['戊釘', '乙釘', '丁', '己離線', '甲', '丙', '庚'])
})

test('時間一樣才照名字；離線的不再排在線上的後面', () => {
  const out = sortFriends([F('乙', 5), F('甲', 5), F('丙離線', 9, { status: 'offline' })], pinnedRecentOrder(pins([])))
  assert.deepEqual(names(out), ['丙離線', ...['甲', '乙'].sort((a, b) => a.localeCompare(b, 'zh-Hant'))])
})

test('手機：同一設備組內照新規則；沒給 pins 時照舊（線上在前、同級照名字）', () => {
  const o = { selfNode: 'H', selfName: '家用機', plainText: s => s }
  assert.deepEqual(names(rosterGroups(friends(), { ...o, pins: pins(['乙釘', '戊釘']) })[0].items), ['戊釘', '乙釘', '丁', '己離線', '甲', '丙', '庚'])
  const old = rosterGroups(friends(), o)[0].items
  assert.equal(old.at(-1).status, 'offline', '舊行為：線上在前、離線在後')
})

test('電腦版：分組依活躍度／廠商時，組內都是釘選在前、再照最新訊息時間', () => {
  const base = { tabDim: 'device', tabKey: 'H', selfNode: 'H', selfName: '家用機', deviceOrder: [], query: '', plainText: s => s, pins: pins(['乙釘', '戊釘']) }
  const byEngine = rosterShownGroups(friends(), { ...base, groupDim: 'engine' })
  assert.deepEqual(names(byEngine[0].items), ['戊釘', '乙釘', '丁', '己離線', '甲', '丙', '庚'])
  const byStatus = rosterShownGroups(friends(), { ...base, groupDim: 'status' })
  for (const g of byStatus) {
    const ts = g.items.map(f => f.lastAt || 0), pinned = g.items.map(f => /釘/.test(f.nick))
    assert.deepEqual(pinned, [...pinned].sort((a, b) => b - a), `${g.label}：釘選的都在前面`)
    const free = g.items.filter(f => !/釘/.test(f.nick)).map(f => f.lastAt || 0)
    assert.deepEqual(free, [...free].sort((a, b) => b - a), `${g.label}：其餘由新到舊`)
    assert.ok(ts.length >= 1)
  }
})

test('接線：電腦版與手機都把釘選狀態交給名單排序', () => {
  assert.match(read('../ui/list.js'), /query: query\.value, plainText: plain, pins: chatPins\.value \}/)
  assert.match(read('../ui/m.js'), /plainText: plain, pins: prefs\.chatPins \}/)
  assert.match(read('../ui/lib/mobile.mjs'), /pinnedRecentOrder\(pins\)/)
})

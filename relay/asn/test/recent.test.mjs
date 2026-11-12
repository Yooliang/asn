// 「最近有活動」的規則（8 小時內、最多 8 個、新到舊）與手機「對話」分頁的清單（0.2.18：30 天內、最多 60 則，最後使用的那一位一定在）；接線守門。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ACTIVE_CHAT_MAX, ACTIVE_CHAT_WINDOW_MS, RECENT_MAX, RECENT_WINDOW_MS, activeChats, lastTrafficAt, recentActivity } from '../ui/lib/recent.mjs'

const ui = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'ui')
const read = (...p) => fs.readFileSync(path.join(ui, ...p), 'utf8').replace(/\r\n/g, '\n')
const NOW = Date.parse('2026-10-23T12:00:00Z')
const H = n => n * 3600_000
const F = id => ({ id, nick: id })
const logs = {}
const logOf = id => logs[id] ?? []

test('最後往來時間：只算收與發，系統提示行不算', () => {
  assert.equal(lastTrafficAt([{ k: 'me', t: 5 }, { k: 'sys', t: 99 }, { k: 'them', t: 7 }]), 7)
  assert.equal(lastTrafficAt([]), 0); assert.equal(lastTrafficAt(null), 0)
})

test('24 小時內的夥伴與群組混在一起，新到舊；超過 24 小時、沒有往來的不列', () => {
  logs['H/a'] = [{ k: 'them', t: NOW - H(5) }]
  logs['H/b'] = [{ k: 'me', t: NOW - H(1) }]
  logs['H/old'] = [{ k: 'them', t: NOW - H(25) }]
  logs['H/sys'] = [{ k: 'sys', t: NOW - H(1) }]
  const rooms = [{ chatId: 'room:r1', at: NOW - H(3), name: '群' }, { chatId: 'room:r2', at: NOW - H(30), name: '舊群' }]
  const r = recentActivity({ friends: [F('H/a'), F('H/b'), F('H/old'), F('H/sys'), F('H/none')], logOf, rooms, now: NOW })
  assert.deepEqual(r.map(x => x.id), ['H/b', 'room:r1', 'H/a'])
  assert.deepEqual(r.map(x => x.kind), ['friend', 'room', 'friend'])
})

test('最多 8 個；沒有近期活動就是空的；同一夥伴不重複', () => {
  const fs8 = Array.from({ length: 12 }, (_, i) => { const id = `H/f${i}`; logs[id] = [{ k: 'them', t: NOW - H(1) - i * 1000 }]; return F(id) })
  const r = recentActivity({ friends: [...fs8, fs8[0]], logOf, rooms: [], now: NOW })
  assert.equal(r.length, RECENT_MAX); assert.equal(r[0].id, 'H/f0'); assert.equal(new Set(r.map(x => x.id)).size, RECENT_MAX)
  assert.deepEqual(recentActivity({ friends: [F('H/zzz')], logOf, rooms: [], now: NOW }), [])
  assert.equal(RECENT_WINDOW_MS, 8 * 3600_000, '跟電腦版「活躍」同一個門檻（#347）')
})

test('對話分頁的清單：30 天內有往來的夥伴與群組、新到舊、最多 60 則；最後使用的那一位沒有往來也排在最後', () => {
  logs['C/new'] = [{ k: 'them', t: NOW - H(2) }]
  logs['C/week'] = [{ k: 'me', t: NOW - H(24 * 7) }]
  logs['C/old'] = [{ k: 'them', t: NOW - H(24 * 31) }]
  const rooms = [{ chatId: 'room:c1', at: NOW - H(30), name: '群' }]
  const r = activeChats({ friends: [F('C/new'), F('C/week'), F('C/old'), F('C/none')], logOf, rooms, now: NOW })
  assert.deepEqual(r.map(x => x.id), ['C/new', 'room:c1', 'C/week'], '超過 30 天、沒有往來的不列')
  const withLast = activeChats({ friends: [F('C/new'), F('C/none')], logOf, rooms: [], now: NOW, lastId: 'C/none' })
  assert.deepEqual(withLast.map(x => [x.id, x.at]), [['C/new', NOW - H(2)], ['C/none', 0]], '最後使用的那一位一定在（排最後）')
  assert.deepEqual(activeChats({ friends: [F('C/new')], logOf, rooms: [], now: NOW, lastId: 'C/new' }).map(x => x.id), ['C/new'], '不重複')
  assert.deepEqual(activeChats({ friends: [], logOf, rooms: [{ chatId: 'room:z', at: 0, name: 'z' }], now: NOW, lastId: 'room:z' }).map(x => [x.kind, x.id]), [['room', 'room:z']])
  assert.deepEqual(activeChats({ friends: [], logOf, rooms: [], now: NOW, lastId: 'gone/x' }), [], '名單上沒有的不憑空出現')
  const many = Array.from({ length: 70 }, (_, i) => { const id = `C/m${i}`; logs[id] = [{ k: 'them', t: NOW - H(1) - i * 1000 }]; return F(id) })
  assert.equal(activeChats({ friends: many, logOf, rooms: [], now: NOW }).length, ACTIVE_CHAT_MAX)
  assert.equal(ACTIVE_CHAT_MAX, 60); assert.equal(ACTIVE_CHAT_WINDOW_MS, 30 * 24 * 3600_000)
})

test('接線守門：活動中的對話在「對話」分頁（不在夥伴名單裡）；夥伴名單是群組對話 → 設備分組；清單不含已封存與通知', () => {
  const m = read('m.html')
  const chats = m.slice(m.indexOf('aria-label="對話">'), m.indexOf('<section class="m-pg" aria-label="夥伴">'))
  assert.match(chats, /<div class="m-group m-recent" v-if="chatRows\.length">/)
  assert.match(chats, /<li v-for="x in chatRows" :key="x\.id">/)
  const list = m.slice(m.indexOf('<section class="m-pg" aria-label="夥伴">'), m.indexOf('<section class="m-pg m-chat m-notice"'))
  assert.doesNotMatch(list, /m-recent|recentRows|chatRows/, '夥伴名單不再有「最近有活動」')
  assert.ok(list.indexOf('m-group m-rooms') > 0 && list.indexOf('m-group m-rooms') < list.indexOf('v-for="g in groups"'), '群組對話 → 設備分組')
  const js = read('m.js')
  assert.match(js, /activeChats\(\{ friends: activeFriends\(friends\.value\)\.filter\(f => !isNoticeFriend\(f\) && !isMergedAway\(f\)\)/, '不含已封存、通知、已併進通知的舊列')
  assert.match(js, /lastId: lastChat\.value \}\)/)
  assert.match(js, /rooms: hub\.rows\(\{ plainText: plain \}\)/, '群組不套夥伴頁的搜尋字')
  assert.match(js, /friendMatchesQuery\(\{ nick: x\.room\.name \}, q, plain\) : friendMatchesQuery\(x\.friend, q, plain\)/, '搜尋比對規則和夥伴頁一樣')
  assert.doesNotMatch(js, /recentRows/)
})

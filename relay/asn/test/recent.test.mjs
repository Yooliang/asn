// 「最近有活動」的規則（8 小時內、最多 8 個、新到舊）與手機「對話」分頁的清單（0.2.18：30 天內、最多 60 則，最後使用的那一位一定在）；接線守門。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ACTIVE_CHAT_MAX, ACTIVE_CHAT_WINDOW_MS, RECENT_MAX, RECENT_WINDOW_MS, UNREAD_GROUP_KEY, UNREAD_GROUP_LABEL, activeChats, chatListRows, chatRowsUnread, filterChatRows, lastTrafficAt, recentActivity, rowUnread, unreadChatRows } from '../ui/lib/recent.mjs'

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

test('未讀那一組（#1438，小良哥定）：只放有未讀的夥伴與群組、最新的在前；讀完就離開；全部讀完是空的；紅點和這一組同一份', () => {
  const fr = (id, unread, at) => ({ kind: 'friend', id, at, friend: { ...F(id), unread } })
  const rm = (id, unread, at) => ({ kind: 'room', id, at, room: { chatId: id, name: id, unread } })
  const rows = [fr('U/old', 2, NOW - H(48)), fr('U/read', 0, NOW - H(1)), rm('room:new', 1, NOW - H(0.5)), fr('U/mid', 5, NOW - H(3)), rm('room:read', 0, NOW)]
  const u = unreadChatRows(rows)
  assert.deepEqual(u.map(x => x.id), ['room:new', 'U/mid', 'U/old'], '只放有未讀的、最新的在前（夥伴與群組混在一起）')
  assert.deepEqual(u.map(rowUnread), [1, 5, 2], '每一列的未讀數字')
  assert.equal(chatRowsUnread(u), 8); assert.equal(chatRowsUnread(u), chatRowsUnread(rows), '紅點（夥伴分頁）和這一組同一份：加總一樣')
  const afterRead = rows.map(x => (x.id === 'U/mid' ? fr('U/mid', 0, x.at) : x))
  assert.deepEqual(unreadChatRows(afterRead).map(x => x.id), ['room:new', 'U/old'], '讀完的那一列離開這一組')
  const allRead = rows.map(x => (x.kind === 'room' ? rm(x.id, 0, x.at) : fr(x.id, 0, x.at)))
  assert.deepEqual(unreadChatRows(allRead), [], '全部讀完：這一組是空的（畫面整組不顯示）')
  assert.equal(chatRowsUnread(unreadChatRows(allRead)), 0, '紅點也跟著消失')
  for (const bad of [null, undefined, 'x', [null, { kind: 'friend' }, { kind: 'friend', friend: { unread: -1 } }, { kind: 'friend', friend: { unread: 1.5 } }]]) assert.deepEqual(unreadChatRows(bad), [], JSON.stringify(bad))
  assert.equal(UNREAD_GROUP_LABEL, '未讀'); assert.equal(UNREAD_GROUP_KEY, 'unread')
})

test('接線守門（#1438）：對話分頁直接是最後那一則、沒有清單；夥伴名單最上面是「未讀」→ 群組對話 → 設備分組；紅點和「未讀」同一份', () => {
  const m = read('m.html')
  const chats = m.slice(m.indexOf('aria-label="對話">'), m.indexOf('<section class="m-pg" aria-label="設定">'))   // #1429 起對話後面接設定
  assert.doesNotMatch(chats, /m-recent|v-for="x in chatRows"|m-search/, '對話分頁不再列清單（直接是那一則）')
  assert.match(chats, /<chat-pane v-if="chatFriend"/); assert.match(chats, /\{\{ chatEmptyText \}\}/, '沒有最後一則：提示到夥伴挑一位')
  const list = m.slice(m.indexOf('<section class="m-pg" aria-label="夥伴">'), m.indexOf('<section class="m-pg m-chat" :class="{ shake'))   // #1429 起夥伴是第一頁、後面接對話
  assert.match(list, /<div class="m-group m-recent m-unread" v-if="unreadRows\.length">/, '「未讀」全部讀完整組不顯示')
  assert.match(list, /\{\{ UNREAD_GROUP_LABEL \}\}（\{\{ unreadRows\.length \}\}）/)
  assert.match(list, /<li v-for="x in unreadRows" :key="x\.id">/)
  assert.match(list, /<span class="unread" v-if="x\.friend\.unread">\{\{ x\.friend\.unread \}\}<\/span>/); assert.match(list, /<span class="unread" v-if="x\.room\.unread">\{\{ x\.room\.unread \}\}<\/span>/)
  assert.doesNotMatch(list, /recentRows|RECENT_GROUP/, '不是「最近有活動」')
  const iU = list.indexOf('m-group m-recent m-unread'), iR = list.indexOf('m-group m-rooms'), iG = list.indexOf('v-for="g in groups"')
  assert.ok(iU > 0 && iU < iR && iR < iG, '未讀 → 群組對話 → 設備分組')
  const js = read('m.js')
  assert.match(js, /const chatAll = computed\(\(\) => chatListRows\(\{ friends: activeFriends\(friends\.value\)\.filter\(f => !isNoticeFriend\(f\) && !isMergedAway\(f\)\)/, '不含已封存、通知、已併進通知的舊列')
  assert.match(js, /lastId: lastChat\.value \}\)\)/)
  assert.match(js, /rooms: hub\.rows\(\{ plainText: plain \}\)/, '群組不套夥伴頁的搜尋字')
  assert.match(js, /const chatRows = computed\(\(\) => filterChatRows\(chatAll\.value, normalizeSearchQuery\(chatQuery\.value\), \(f, q\) => friendMatchesQuery\(f, q, plain\)\)\)/, '搜尋比對規則和夥伴頁一樣')
  assert.match(js, /const unreadRows = computed\(\(\) => unreadChatRows\(chatAll\.value\)\)/, '「未讀」不套夥伴頁的搜尋字（紅點和這一組一定對得上）')
  assert.match(js, /const unreadTotal = computed\(\(\) => chatRowsUnread\(unreadRows\.value\)\)/, '夥伴分頁的紅點和「未讀」用同一份')
  assert.doesNotMatch(js, /recentRows/)
})

test('對話分頁真正列出的清單（chatListRows，手機電腦共用）：活動中的對話 → 有未讀但久沒往來的夥伴 → 所有群組（久沒動靜的排最後）；紅點和清單同一份；搜尋', () => {
  logs['L/act'] = [{ k: 'them', t: NOW - H(1) }]
  logs['L/oldUnread'] = [{ k: 'them', t: NOW - H(24 * 60) }]
  logs['L/oldRead'] = [{ k: 'them', t: NOW - H(24 * 60) }]
  const friends = [{ ...F('L/act'), unread: 0 }, { ...F('L/oldUnread'), unread: 2 }, { ...F('L/oldRead'), unread: 0 }, { ...F('L/never'), unread: 1 }]
  const rooms = [{ chatId: 'room:new', at: NOW - H(2), name: '新群', unread: 1 }, { chatId: 'room:old', at: NOW - H(24 * 90), name: '舊群', unread: 0 }, { chatId: 'room:older', at: NOW - H(24 * 200), name: '更舊的群', unread: 3 }]
  const rows = chatListRows({ friends, logOf, rooms, now: NOW })
  assert.deepEqual(rows.map(x => x.id), ['L/act', 'room:new', 'L/oldUnread', 'L/never', 'room:old', 'room:older'], '有未讀的夥伴就算久沒往來也列；群組一個都不少，久沒動靜的排最後')
  assert.ok(!rows.some(x => x.id === 'L/oldRead'), '久沒往來又沒未讀的夥伴不列')
  assert.equal(chatRowsUnread(rows), 2 + 1 + 1 + 3, '紅點＝清單上的未讀加總：有紅點就一定找得到')
  for (const x of rows) if ((x.kind === 'room' ? x.room.unread : x.friend.unread) > 0) assert.ok(rows.includes(x))
  assert.equal(chatRowsUnread([]), 0); assert.equal(chatRowsUnread(null), 0); assert.equal(chatRowsUnread([{ kind: 'room', room: { unread: 'x' } }]), 0)
  // 搜尋：夥伴比名字、群組比群組名（比對規則由呼叫端給，跟名單一樣）；沒有搜尋字就全部
  const m = (f, q) => String(f.nick).toLowerCase().includes(q)
  assert.deepEqual(filterChatRows(rows, '舊群', m).map(x => x.id), ['room:old'])
  assert.deepEqual(filterChatRows(rows, 'l/old', m).map(x => x.id), ['L/oldUnread'])
  assert.equal(filterChatRows(rows, '', m), rows)
  // 最後使用的那一位（手機）照樣在
  assert.ok(chatListRows({ friends, logOf, rooms: [], now: NOW, lastId: 'L/oldRead' }).some(x => x.id === 'L/oldRead'))
})

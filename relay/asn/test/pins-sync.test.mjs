// 對話釘選的帳號層同步（#1479 第二部分，0.2.27）：ui/lib/pins-sync.mjs 的流程與控制器、封存優先、搜尋時釘選照條件過濾、接線。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { EMPTY_PINS, normalizePins, pinChat, pinnedTargets, unpinChat } from '../ui/lib/chat-pins.mjs'
import { COOLDOWN_RETRY_MS, MAX_SEND, canonPins, createPinsSync, syncPinsOnce } from '../ui/lib/pins-sync.mjs'
import { activeFriends } from '../ui/lib/archive.mjs'
import { filterChatRows } from '../ui/lib/recent.mjs'
import { friendMatchesQuery } from '../ui/lib/search.mjs'

const read = p => fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8')
const ids = s => normalizePins(s).pins.map(p => p.id)
const S = (pins = [], unpinned = [], rev = 0) => ({ pins, unpinned, rev })
const E = (id, at) => ({ id, at })

// ---- 假後台：照 SQL account_pref_put 的規則（內容相同不動 → rev 必須是現有＋1 → 2 秒冷卻）----
function fakeServer({ initial = null, cooldownHits = 0 } = {}) {
  const srv = { cur: initial ? { ...initial, at: 1 } : null, gets: 0, sets: [], cooldownLeft: cooldownHits, nowAt: 1 }
  srv.api = {
    async get() { srv.gets++; return { pins: srv.cur } },
    async set(body) {
      srv.sets.push(body)
      if (srv.cur) {
        if (canonPins(srv.cur) === canonPins(body)) return { pins: srv.cur, stale: false, rate_limited: false }
        if (body.rev !== srv.cur.rev + 1) return { pins: srv.cur, stale: true, rate_limited: false }
        if (srv.cooldownLeft > 0) { srv.cooldownLeft--; return { pins: null, stale: false, rate_limited: true } }
      } else if (body.rev < 1) throw new Error('bad_rev')
      srv.cur = { ...body, at: ++srv.nowAt }
      return { pins: srv.cur, stale: false, rate_limited: false }
    },
  }
  return srv
}
const waits = []
const wait = async ms => { waits.push(ms) }

test('canonPins：只看釘選與取消紀錄，順序與 rev 不影響', () => {
  const a = S([E('a', 1), E('b', 2)], [E('c', 3)], 1)
  const b = S([E('b', 2), E('a', 1)], [E('c', 3)], 99)
  assert.equal(canonPins(a), canonPins(b))
  assert.notEqual(canonPins(a), canonPins(S([E('a', 1)], [E('c', 3)], 1)))
})

test('同步：兩邊都空什麼都不做（連後台都不寫）', async () => {
  const srv = fakeServer()
  const r = await syncPinsOnce({ getLocal: () => EMPTY_PINS, api: srv.api, wait })
  assert.equal(r.status, 'noop'); assert.equal(srv.sets.length, 0)
})

test('同步：後台沒有任何一份時用本機的 rev（至少 1）送；成功後回後台那份', async () => {
  const local = S([E('a', 10)], [], 7)
  const srv = fakeServer()
  const r = await syncPinsOnce({ getLocal: () => local, api: srv.api, wait })
  assert.equal(r.status, 'synced'); assert.equal(srv.sets[0].rev, 7); assert.deepEqual(srv.sets[0].pins, [E('a', 10)])
  assert.deepEqual(ids(r.state), ['a']); assert.equal(r.state.rev, 7)
  const srv0 = fakeServer()
  await syncPinsOnce({ getLocal: () => S([E('a', 10)], [], 0), api: srv0.api, wait })
  assert.equal(srv0.sets[0].rev, 1, '本機 rev 是 0 也至少送 1')
})

test('同步：合併後內容跟後台一樣就不送（本機空、後台有＝採用後台那份）', async () => {
  const remote = S([E('a', 10), E('b', 20)], [], 5)
  const srv = fakeServer({ initial: remote })
  const r = await syncPinsOnce({ getLocal: () => EMPTY_PINS, api: srv.api, wait })
  assert.equal(r.status, 'noop'); assert.equal(srv.sets.length, 0)
  assert.deepEqual(ids(r.state), ['a', 'b']); assert.equal(r.state.rev, 5)
  const same = await syncPinsOnce({ getLocal: () => S([E('b', 20), E('a', 10)], [], 99), api: srv.api, wait })
  assert.equal(same.status, 'noop'); assert.equal(srv.sets.length, 0, '內容相同不送，即使本機 rev 比較大')
})

test('同步：本機有後台沒有的 → 合併後以後台 rev＋1 送出', async () => {
  const srv = fakeServer({ initial: S([E('b', 20)], [], 5) })
  const r = await syncPinsOnce({ getLocal: () => S([E('a', 10)], [], 40), api: srv.api, wait })
  assert.equal(r.status, 'synced'); assert.equal(srv.sets.length, 1); assert.equal(srv.sets[0].rev, 6)
  assert.deepEqual(ids(r.state), ['a', 'b'])
})

test('同步：取消釘選的紀錄會送上去，蓋掉另一台舊的釘選（at 較新者贏）', async () => {
  const srv = fakeServer({ initial: S([E('a', 10)], [], 2) })
  const local = unpinChat(S([E('a', 10)], [], 2), 'a', 50)
  const r = await syncPinsOnce({ getLocal: () => local, api: srv.api, wait })
  assert.equal(r.status, 'synced'); assert.deepEqual(ids(r.state), []); assert.deepEqual(r.state.unpinned, [E('a', 50)])
})

test('同步：回 stale 就用回來的那份合併重送；成功就停', async () => {
  const srv = fakeServer({ initial: S([E('b', 20)], [], 5) })
  let first = true
  // 讀完之後別台又寫了一次（後台變成 rev 6、多了 c）
  const api = { ...srv.api, async get() { const r = await srv.api.get(); if (first) { first = false; srv.cur = { ...srv.cur, pins: [E('b', 20), E('c', 30)], rev: 6 } } return r } }
  const r = await syncPinsOnce({ getLocal: () => S([E('a', 10)], [], 1), api, wait })
  assert.equal(r.status, 'synced'); assert.equal(r.sent, 2)
  assert.deepEqual(srv.sets.map(s => s.rev), [6, 7], '第一次送 6 被擋（現有已是 6），用回來的那份合併後送 7')
  assert.deepEqual(ids(r.state), ['a', 'b', 'c'])
})

test('同步：一直 stale 最多送 3 次就放棄，不無限重試', async () => {
  let rev = 5
  const api = {
    async get() { return { pins: S([E('b', 20)], [], rev) } },
    async set() { rev += 5; return { pins: S([E('b', 20), E('z', rev)], [], rev), stale: true, rate_limited: false } },   // 每次都有人搶先
  }
  const r = await syncPinsOnce({ getLocal: () => S([E('a', 10)], [], 1), api, wait })
  assert.equal(r.status, 'gaveup'); assert.equal(r.sent, MAX_SEND); assert.equal(MAX_SEND, 3)
})

test('同步：冷卻（rate_limited）要等一會兒再送，不立刻連打；等的次數也有上限', async () => {
  waits.length = 0
  const srv = fakeServer({ initial: S([E('b', 20)], [], 5), cooldownHits: 2 })
  const r = await syncPinsOnce({ getLocal: () => S([E('a', 10)], [], 1), api: srv.api, wait })
  assert.equal(r.status, 'synced'); assert.deepEqual(waits, [COOLDOWN_RETRY_MS, COOLDOWN_RETRY_MS]); assert.equal(COOLDOWN_RETRY_MS, 2500)
  assert.equal(srv.sets.length, 3); assert.ok(srv.sets.every(s => s.rev === 6), '冷卻沒寫進去，重送還是同一個 rev')
  waits.length = 0
  const stuck = fakeServer({ initial: S([E('b', 20)], [], 5), cooldownHits: 99 })
  const g = await syncPinsOnce({ getLocal: () => S([E('a', 10)], [], 1), api: stuck.api, wait })
  assert.equal(g.status, 'gaveup'); assert.ok(waits.length <= MAX_SEND + 1)
})

test('同步：後台沒回東西（還沒部署）當作這次沒成功，不改本機', async () => {
  const api = { get: async () => ({ pins: null }), set: async () => ({ pins: null, stale: false, rate_limited: false }) }
  const r = await syncPinsOnce({ getLocal: () => S([E('a', 10)], [], 1), api, wait })
  assert.equal(r.status, 'gaveup'); assert.equal(r.state, undefined)
})

// ---- 兩台輪流「讀 → 改 → 寫」----
test('兩台：同一份開始各釘不同的對話；A 先寫成功，B 拿到 stale、合併後重送，最後兩邊的釘選都在', async () => {
  const srv = fakeServer({ initial: S([E('甲', 1000)], [], 1) })
  const a = pinChat(normalizePins(srv.cur), '乙 組', 2000).state
  const b = pinChat(normalizePins(srv.cur), 'room:丙', 3000).state
  // 兩台都先讀到同一份（rev 1），A 先寫；B 讀到之後後台才被 A 改走 → 送出時被擋（stale），合併後用後台 rev＋1 重送
  let bGets = 0
  const apiB = { ...srv.api, async get() { const r = await srv.api.get(); bGets++; return r } }
  const readsBeforeA = await apiB.get()
  const ra = await syncPinsOnce({ getLocal: () => a, api: srv.api, wait })
  assert.equal(ra.status, 'synced'); assert.equal(srv.cur.rev, 2)
  const staleSend = await srv.api.set({ pins: [...readsBeforeA.pins.pins, E('room:丙', 3000)], unpinned: [], rev: readsBeforeA.pins.rev + 1 })
  assert.equal(staleSend.stale, true, 'B 拿舊的 rev 送會被擋')
  const rb = await syncPinsOnce({ getLocal: () => b, api: apiB, wait })
  assert.equal(rb.status, 'synced'); assert.equal(srv.cur.rev, 3)
  assert.deepEqual(ids(srv.cur).sort(), ['room:丙', '乙 組', '甲'].sort())
  const ra2 = await syncPinsOnce({ getLocal: () => ra.state, api: srv.api, wait })
  assert.equal(ra2.status, 'noop'); assert.deepEqual(ids(ra2.state).sort(), ['room:丙', '乙 組', '甲'].sort())
})

test('兩台：B 離線改很多次、rev 衝很大，直接送一定被擋，不會蓋掉 A 的（要先讀、合併、再用後台 rev＋1）', async () => {
  const srv = fakeServer({ initial: S([E('甲', 1000), E('A釘的', 2000)], [], 3) })
  let b = S([E('甲', 1000)], [], 1)
  for (let i = 0; i < 30; i++) b = pinChat(unpinChat(b, 'x' + i, 5000 + i), 'y' + (i % 9), 6000 + i).state   // 離線亂改，rev 變很大
  assert.ok(b.rev > 30)
  const direct = await srv.api.set({ pins: b.pins, unpinned: b.unpinned, rev: b.rev })
  assert.equal(direct.stale, true, '直接送一定 stale')
  assert.ok(ids(srv.cur).includes('A釘的'), 'A 的釘選還在')
  const r = await syncPinsOnce({ getLocal: () => b, api: srv.api, wait })
  assert.equal(r.status, 'synced'); assert.equal(srv.sets.at(-1).rev, 4)
  assert.ok(ids(srv.cur).includes('A釘的') && ids(srv.cur).includes('y0'), '合併後兩邊都在')
})

// ---- 控制器 ----
function rig({ signed = true, remote = null, local = EMPTY_PINS, debounceMs = 1500 } = {}) {
  const clock = { timers: [], t: 0 }
  const schedule = (fn, ms) => { const h = { fn, at: clock.t + ms, done: false }; clock.timers.push(h); return h }
  const clear = h => { if (h) h.done = true }
  const srv = fakeServer({ initial: remote })
  const state = { pins: local }
  const sync = createPinsSync({
    getPins: () => state.pins, setPins: s => { state.pins = s }, api: srv.api, canSync: async () => signed,
    schedule, clear, wait: async () => {}, debounceMs, everyMs: 120_000, onError: e => { state.err = e },
  })
  const flush = () => new Promise(r => setImmediate(r))
  const tick = async ms => {
    clock.t += ms
    for (const h of clock.timers.filter(x => !x.done && x.at <= clock.t)) { h.done = true; h.fn(); await flush() }
    await flush()
  }
  return { srv, state, sync, tick }
}

test('控制器：沒登入完全不碰後台（行為跟只存本機一樣）', async () => {
  const t = rig({ signed: false, local: S([E('a', 1)], [], 1) })
  t.sync.start(); await t.tick(0)
  t.state.pins = pinChat(t.state.pins, 'b', 5).state; t.sync.noteLocal(); await t.tick(2000)
  assert.equal(t.srv.gets, 0); assert.equal(t.srv.sets.length, 0)
  assert.deepEqual(ids(t.state.pins), ['a', 'b'])
  t.sync.stop()
})

test('控制器：開啟時同步一次，本機釘 A、後台有 B → 兩個都在，本機存成後台那份', async () => {
  const t = rig({ remote: S([E('B', 200)], [], 3), local: S([E('A', 100)], [], 1) })
  t.sync.start(); await t.tick(0)
  assert.deepEqual(ids(t.state.pins), ['A', 'B']); assert.equal(t.state.pins.rev, 4)
  assert.deepEqual(ids(t.srv.cur), ['A', 'B'])
  t.sync.stop()
})

test('控制器：本機釘選後去抖動才送，連按只送一次；同步完的狀態不會被當成本機改動再送', async () => {
  const t = rig({ remote: S([E('B', 200)], [], 3), local: S([E('B', 200)], [], 3) })
  t.sync.start(); await t.tick(0)
  assert.equal(t.srv.sets.length, 0)
  t.state.pins = pinChat(t.state.pins, 'c1', 300).state; t.sync.noteLocal()
  await t.tick(500)
  t.state.pins = pinChat(t.state.pins, 'c2', 301).state; t.sync.noteLocal()
  await t.tick(500)
  assert.equal(t.srv.sets.length, 0, '去抖動中還沒送')
  await t.tick(1500)
  assert.equal(t.srv.sets.length, 1); assert.deepEqual(ids(t.srv.cur), ['B', 'c1', 'c2'])
  t.sync.noteLocal(); await t.tick(2000)
  assert.equal(t.srv.sets.length, 1)
  t.sync.stop()
})

test('控制器：內容沒變只是 rev 動了不送', async () => {
  const t = rig({ remote: S([E('B', 200)], [], 3), local: S([E('B', 200)], [], 3) })
  t.sync.start(); await t.tick(0)
  t.state.pins = { ...t.state.pins, rev: 50 }; t.sync.noteLocal(); await t.tick(3000)
  assert.equal(t.srv.sets.length, 0)
  t.sync.stop()
})

test('控制器：定時讀一次，別台釘的會出現在本機', async () => {
  const t = rig({ remote: S([E('B', 200)], [], 3), local: S([E('B', 200)], [], 3) })
  t.sync.start(); await t.tick(0)
  t.srv.cur = { ...S([E('B', 200), E('C', 250)], [], 4), at: 9 }
  await t.tick(120_000)
  assert.deepEqual(ids(t.state.pins), ['B', 'C'])
  t.sync.stop()
})

test('控制器：後台出錯只記下來，不丟出去、本機不動', async () => {
  const t = rig({ local: S([E('A', 100)], [], 1) })
  t.srv.api.get = async () => { throw new Error('boom') }
  t.sync.start(); await t.tick(0)
  assert.equal(t.state.err?.message, 'boom'); assert.deepEqual(ids(t.state.pins), ['A'])
  t.sync.stop()
})

// ---- 封存優先、搜尋時照條件過濾 ----
test('封存優先：已封存的夥伴就算釘選了也不顯示，釘選紀錄保留；解除封存就回到最上面', () => {
  const pins = S([E('Q/demo', 100), E('Q/小工', 200), E('Q/舊人', 300)], [], 3)
  const friends = [{ id: 'Q/demo', nick: 'demo' }, { id: 'Q/小工', nick: '小工', archived: true }, { id: 'Q/無釘', nick: '無釘' }]
  const shown = pinnedTargets(pins, activeFriends(friends), [])
  assert.deepEqual(shown.map(t => t.id), ['Q/demo'], '小工已封存不顯示；舊人不在名單也不顯示')
  assert.deepEqual(pins.pins.map(p => p.id), ['Q/demo', 'Q/小工', 'Q/舊人'], '釘選紀錄一筆不少')
  const back = friends.map(f => ({ ...f, archived: false }))
  assert.deepEqual(pinnedTargets(pins, activeFriends(back), []).map(t => t.id), ['Q/demo', 'Q/小工'], '解除封存後依釘選時間回來')
})

test('pinnedTargets：群組從群組清單補，依釘選時間由早到晚；找不到的不列', () => {
  const pins = S([E('room:g2', 50), E('Q/a', 10), E('room:ghost', 5)], [], 1)
  const t = pinnedTargets(pins, [{ id: 'Q/a' }], [{ chatId: 'room:g2', name: '群二' }])
  assert.deepEqual(t.map(x => x.id), ['room:g2', 'Q/a'], '依 pins 的順序（normalize 後是釘選時間由早到晚）')
  assert.equal(t[0].room.name, '群二')
  assert.deepEqual(pinnedTargets(normalizePins(pins), [{ id: 'Q/a' }], [{ chatId: 'room:g2', name: '群二' }]).map(x => x.id), ['Q/a', 'room:g2'])
})

test('搜尋時釘選照搜尋條件過濾、仍在最上面（手機與電腦一致）：filterChatRows 套在釘選那幾列', () => {
  const pins = S([E('Q/demo', 100), E('Q/小工', 200), E('room:g1', 300)], [], 3)
  const rows = pinnedTargets(pins, [{ id: 'Q/demo', nick: 'demo' }, { id: 'Q/小工', nick: '小工' }], [{ chatId: 'room:g1', name: '測試群' }])
    .map(t => (t.friend ? { kind: 'friend', id: t.id, friend: t.friend } : { kind: 'room', id: t.id, room: t.room }))
  const plain = s => s
  const q = n => filterChatRows(rows, n, (f, query) => friendMatchesQuery(f, query, plain)).map(r => r.id)
  assert.deepEqual(q(''), ['Q/demo', 'Q/小工', 'room:g1'])
  assert.deepEqual(q('小工'), ['Q/小工'])
  assert.deepEqual(q('測試'), ['room:g1'])
  assert.deepEqual(q('不存在'), [])
})

// ---- 接線（讀檔檢查）----
test('接線：電腦與手機都接上同步；手機搜尋時不再藏起釘選那一組；封存優先', () => {
  const list = read('ui/list.js'), m = read('ui/m.js'), tauri = read('ui/lib/tauri.mjs'), rs = read('src-tauri/src/lib.rs')
  assert.match(list, /createPinsSync\(\{ getPins: \(\) => chatPins\.value/)
  assert.match(list, /watch\(chatPins, \(\) => pinsSync\.noteLocal\(\)/)
  assert.match(list, /if \(!info\.shot\) pinsSync\.start\(\)/, '截圖模式不動後台')
  assert.match(m, /createPinsSync\(\{ getPins: \(\) => prefs\.chatPins/)
  assert.match(m, /watch\(\(\) => prefs\.chatPins, \(\) => pinsSync\.noteLocal\(\)/)
  assert.doesNotMatch(m, /pinnedRowsM\.value\.length > 0 && !searching/, '搜尋時釘選那一組不再整組藏起來')
  assert.match(m, /return q \? out\.filter\(x => friendMatchesQuery\(x\.kind === 'room' \? \{ nick: x\.room\.name \} : x\.friend, q, plain\)\) : out/, '釘選那幾列照搜尋條件過濾')
  assert.match(m, /pinnedTargets\(prefs\.chatPins, activeFriends\(friends\.value\)/, '封存優先')
  assert.match(list, /pinnedTargets\(chatPins\.value, activeFriends\(friendsAct\.value\)/, '封存優先')
  assert.match(tauri, /getChatPins: \(\) => invoke\('auth_chat_pins_get'\)/)
  assert.match(tauri, /setChatPins: pins => invoke\('auth_chat_pins_set', \{ pins \}\)/)
  assert.equal((rs.match(/account::auth_chat_pins_get, account::auth_chat_pins_set/g) ?? []).length, 2, '電腦與手機兩份指令清單都要登記')
})

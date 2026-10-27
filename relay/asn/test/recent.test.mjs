// 「最近有活動」分組：24 小時內、最多 8 個、新到舊、沒有就不顯示；接線守門。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { RECENT_MAX, RECENT_WINDOW_MS, lastTrafficAt, recentActivity } from '../ui/lib/recent.mjs'

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

test('接線守門：手機名單最上面、群組對話之前；沒有近期活動不顯示；不從設備分組拿掉', () => {
  const m = read('m.html')
  const a = m.indexOf('m-group m-recent'), b = m.indexOf('m-group m-rooms'), c = m.indexOf('v-for="g in groups"')
  assert.ok(a > 0 && a < b && b < c, '最近有活動 → 群組對話 → 設備分組')
  assert.match(m, /<div class="m-group m-recent" v-if="recentRows\.length">/)
  const js = read('m.js')
  assert.match(js, /recentActivity\(\{ friends: groups\.value\.filter\(g => g\.kind !== 'archived'\)\.flatMap\(g => g\.items\)/)
  assert.doesNotMatch(js, /groups\.value\.filter\([^)]*recent/, '設備分組不因為出現在最近而被拿掉')
})

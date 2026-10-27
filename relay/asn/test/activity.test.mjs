// #347 名單「活躍度」：三級、8 小時門檻、離開活躍的 5 分鐘緩衝、離線 3 分鐘去抖、忙閒切換不換組。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ACTIVE_WINDOW_MS, LEAVE_GRACE_MS, OFFLINE_DEBOUNCE_MS, ACTIVITY_LEVELS, rawActivity, nextActivity, activityRound, withActivity } from '../ui/lib/activity.mjs'
import { groupInDevice } from '../ui/lib/tabs.mjs'
import { pageTabs, pageItems, DIMS } from '../ui/lib/dims.mjs'
import { RECENT_WINDOW_MS } from '../ui/lib/recent.mjs'

const H = 60 * 60 * 1000, M = 60 * 1000
const NOW = 1_800_000_000_000

test('三級與名稱：活躍、閒置、離線；分頁依／分組依的「狀態」改叫「活躍度」', () => {
  assert.deepEqual(ACTIVITY_LEVELS.map(([k, l]) => `${k}:${l}`), ['active:活躍', 'idle:閒置', 'offline:離線'])
  assert.equal(DIMS.find(d => d.key === 'status').label, '活躍度', '存檔鍵仍是 status，舊設定照樣能讀')
  assert.equal(RECENT_WINDOW_MS, ACTIVE_WINDOW_MS, '手機「最近有活動」跟電腦「活躍」同一個門檻')
})

test('原始判斷：在線且 8 小時內有收發＝活躍；忙碌、暫離也一樣看收發，不看忙閒', () => {
  for (const st of ['online', 'busy', 'away']) {
    assert.equal(rawActivity(st, NOW - 7 * H - 59 * M, NOW), 'active', st)
    assert.equal(rawActivity(st, NOW - 8 * H - 1, NOW), 'idle', st)
    assert.equal(rawActivity(st, 0, NOW), 'idle', `${st} 沒有往來`)
  }
  assert.equal(rawActivity('offline', NOW, NOW), 'offline')
})

test('離開活躍要多等 5 分鐘：8:01 仍活躍、8:06 變閒置', () => {
  const last = NOW - ACTIVE_WINDOW_MS - 1 * M
  assert.equal(nextActivity({ level: 'active' }, { status: 'online', lastAt: last }, NOW).level, 'active', '8:01 還在緩衝內')
  assert.equal(nextActivity({ level: 'active' }, { status: 'online', lastAt: NOW - ACTIVE_WINDOW_MS - LEAVE_GRACE_MS - M }, NOW).level, 'idle', '8:06 變閒置')
  assert.equal(nextActivity({ level: 'idle' }, { status: 'online', lastAt: last }, NOW).level, 'idle', '本來就閒置的不會被緩衝拉回活躍')
  assert.equal(nextActivity({ level: 'idle' }, { status: 'online', lastAt: NOW }, NOW).level, 'active', '一有收發立刻進活躍')
})

test('離線要連續 3 分鐘才算；中途回來就重新起算；第一次見到就離線的直接離線', () => {
  let s = nextActivity({ level: 'active', offSince: null }, { status: 'offline', lastAt: NOW }, NOW)
  assert.deepEqual(s, { level: 'active', offSince: NOW }, '剛離線：維持活躍')
  s = nextActivity(s, { status: 'offline', lastAt: NOW }, NOW + 2 * M)
  assert.equal(s.level, 'active', '2 分鐘還不算離線')
  const back = nextActivity(s, { status: 'online', lastAt: NOW }, NOW + 2 * M + 1)
  assert.deepEqual(back, { level: 'active', offSince: null }, '回來了，計時歸零')
  s = nextActivity(s, { status: 'offline', lastAt: NOW }, NOW + OFFLINE_DEBOUNCE_MS)
  assert.equal(s.level, 'offline', '滿 3 分鐘才離線')
  assert.equal(nextActivity(undefined, { status: 'offline', lastAt: 0 }, NOW).level, 'offline')
})

test('忙閒連續切換 60 次，活躍度與所在的組都不變', () => {
  const f = { id: 'H/a', nick: 'a', status: 'idle', lastAt: NOW - H }
  let prev = new Map()
  const seen = new Set()
  for (let i = 0; i < 60; i++) {
    const cur = { ...f, status: i % 2 ? 'busy' : 'online' }
    prev = activityRound([cur], { prev, now: NOW + i * 1000 })
    const groups = groupInDevice(withActivity([cur], prev), 'status')
    seen.add(groups.map(g => `${g.key}:${g.items.map(x => x.id)}`).join('|'))
  }
  assert.deepEqual([...seen], ['status:active:H/a'])
})

test('activityRound：收發時間取名單 lastAt 與對話記錄兩者較新；系統行不算', () => {
  const friends = [{ id: 'x', status: 'online', lastAt: NOW - 10 * H }, { id: 'y', status: 'online' }, { id: 'z', status: 'online' }]
  const logs = { x: [{ k: 'me', t: NOW - 2 * H }], y: [{ k: 'sys', t: NOW }], z: [] }
  const m = activityRound(friends, { logOf: id => logs[id], now: NOW })
  assert.deepEqual([...m].map(([id, v]) => `${id}:${v.level}`), ['x:active', 'y:idle', 'z:idle'])
  assert.deepEqual(withActivity([{ id: 'q', status: 'offline' }, { id: 'r', status: 'busy' }], new Map()).map(f => f.activity), ['offline', 'idle'])
})

test('分組與分頁：依活躍度分三組，組內照名字，不看忙閒', () => {
  const fr = withActivity([
    { id: 'H/b', node: 'H', nick: 'b', status: 'busy' }, { id: 'H/a', node: 'H', nick: 'a', status: 'online' },
    { id: 'H/c', node: 'H', nick: 'c', status: 'away' }, { id: 'H/d', node: 'H', nick: 'd', status: 'offline' },
  ], new Map([['H/b', { level: 'active' }], ['H/a', { level: 'active' }], ['H/c', { level: 'idle' }], ['H/d', { level: 'offline' }]]))
  assert.deepEqual(groupInDevice(fr, 'status').map(g => [g.label, g.items.map(f => f.nick).join('')]), [['活躍', 'ab'], ['閒置', 'c'], ['離線', 'd']])
  const tabs = pageTabs(fr, 'status', { selfNode: 'H' }).all
  assert.deepEqual(tabs.map(t => `${t.key}:${t.total}`), ['active:2', 'idle:1', 'offline:1'])
  assert.deepEqual(pageItems(fr, 'status', 'active').map(f => f.nick), ['a', 'b'])
  assert.deepEqual(pageItems(fr, 'device', 'H').map(f => f.nick), ['a', 'b', 'c', 'd'], '設備頁內：活躍在前、離線在後，同級照名字')
})

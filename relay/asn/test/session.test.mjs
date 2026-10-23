// 記住開著的分頁與視窗：純邏輯＋接線守門
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { normalizeSession, resolveRef, restoreMobileTab, restoreSession, sameSession, snapshotSession, trailingThrottle } from '../ui/lib/session.mjs'
import { TABS } from '../ui/lib/mobile.mjs'

const read = f => fs.readFileSync(new URL(`../${f}`, import.meta.url), 'utf8')
const F = [
  { id: 'A/a', partnerId: 'p-a' }, { id: 'A/b', partnerId: 'p-b' }, { id: 'A/c' },
  { id: 'A/old', partnerId: 'p-old', archived: true },
]
const friendOf = id => F.find(f => f.id === id)

test('存檔再讀回：分頁順序、目前分頁、面板、視窗都在，夥伴 ID 一併記下', () => {
  const snap = snapshotSession({ tabs: ['A/b', '@guide', 'A/a', 'A/c'], active: 'A/a', panel: { guide: 'bridge', setting: '' }, windows: ['A/c'], panelWindows: ['guide'] }, friendOf)
  assert.deepEqual(snap.tabs[0], { id: 'A/b', pid: 'p-b' })
  assert.deepEqual(snap.tabs[1], { id: '@guide' })
  assert.deepEqual(snap.tabs[3], { id: 'A/c' })
  const back = JSON.parse(JSON.stringify(snap))
  assert.ok(sameSession(normalizeSession(back), snap))
  const r = restoreSession(back, { friends: F })
  assert.deepEqual(r.tabs, ['A/b', '@guide', 'A/a', 'A/c'])
  assert.equal(r.active, 'A/a')
  assert.deepEqual(r.windows, ['A/c'])
  assert.deepEqual(r.panelWindows, ['guide'])
  assert.equal(r.dropped, 0)
})

test('固定的分頁還原後排最前面，順序依固定清單', () => {
  const snap = snapshotSession({ tabs: ['A/a', 'A/b', 'A/c'], active: 'A/c' }, friendOf)
  const r = restoreSession(snap, { friends: F, pinned: ['A/c', 'A/b'] })
  assert.deepEqual(r.tabs, ['A/c', 'A/b', 'A/a'])
  assert.equal(r.active, 'A/c')
})

test('夥伴已不存在、已封存：略過，不留空白分頁；目前分頁掉了就改最後一個', () => {
  const snap = snapshotSession({ tabs: ['A/gone', 'A/old', 'A/a'], active: 'A/gone', windows: ['A/gone', 'A/b'] }, id => ({ 'A/old': { partnerId: 'p-old' } })[id])
  const r = restoreSession(snap, { friends: F })
  assert.deepEqual(r.tabs, ['A/a'])
  assert.equal(r.active, 'A/a')
  assert.deepEqual(r.windows, ['A/b'])
  assert.equal(r.dropped, 3)
  const none = restoreSession(snapshotSession({ tabs: ['A/gone'], active: 'A/gone' }), { friends: F })
  assert.deepEqual(none.tabs, [])
  assert.equal(none.active, '')
})

test('改名：夥伴 ID 相同就換成新 id（分頁、目前分頁、固定都跟著）；兩個舊名併成同一位只留一個', () => {
  const now = [{ id: 'A/new', partnerId: 'p-x' }, { id: 'A/z', partnerId: 'p-z' }]
  const raw = { tabs: [{ id: 'A/x1', pid: 'p-x' }, { id: 'A/z', pid: 'p-z' }, { id: 'A/x2', pid: 'p-x' }], active: { id: 'A/x1', pid: 'p-x' } }
  const r = restoreSession(raw, { friends: now, pinned: ['A/x1'] })
  assert.deepEqual(r.tabs, ['A/new', 'A/z'])
  assert.equal(r.active, 'A/new')
  assert.deepEqual(r.pinned, ['A/new'])
  assert.equal(resolveRef({ id: 'A/zz', pid: 'p-z' }, new Map(now.map(f => [f.id, f]))), 'A/z')
})

test('面板分頁：內容認不得（指引被移除）就略過；指引設定所選的篇數保留', () => {
  const ok = restoreSession({ tabs: [{ id: '@guide' }, { id: '@setting' }], panel: { guide: 'bridge', setting: 'look' } }, { friends: F })
  assert.deepEqual(ok.tabs, ['@guide', '@setting'])
  const bad = restoreSession({ tabs: [{ id: '@guide' }], panel: { guide: '不存在' }, panelWindows: ['guide'] }, { friends: F })
  assert.deepEqual(bad.tabs, [])
  assert.deepEqual(bad.panelWindows, [])
})

test('壞存檔與舊存檔（沒有 session）都當空狀態', () => {
  for (const bad of [undefined, null, 5, 'x', [], { tabs: 'x', windows: 3, active: 7, panel: 4, panelWindows: 'guide' }, { tabs: [null, {}, { id: 3 }, { id: '' }] }]) {
    const r = restoreSession(bad, { friends: F })
    assert.deepEqual([r.tabs, r.windows, r.active, r.panelWindows], [[], [], '', []])
  }
  assert.deepEqual(snapshotSession({ tabs: ['pending:x', 'A/a'], windows: ['@guide', 'pending:y'] }).tabs.map(t => t.id), ['A/a'])
  assert.deepEqual(snapshotSession({ windows: ['@guide'] }).windows, [])
})

test('尾端節流：連續變動只寫最後一次，flush 立刻寫', () => {
  const q = []; let n = 0
  const timers = { set: fn => { q.push(fn); return q.length }, clear: id => { q[id - 1] = null } }
  const t = trailingThrottle(() => n++, 500, timers)
  t(); t(); t()
  assert.equal(n, 0)
  q.filter(Boolean).forEach(f => f())
  assert.equal(n, 1)
  t(); t.flush()
  assert.equal(n, 2)
  assert.equal(t.pending(), false)
})

test('手機：回到上次的大分頁；壞值回名單；三個分頁與手機版一致', () => {
  for (const t of TABS) assert.equal(restoreMobileTab(t), t)
  for (const b of [undefined, '', 'x', 3, null]) assert.equal(restoreMobileTab(b), 'list')
})

test('接線守門：電腦版存與還原、手機版存與還原、Rust 視窗清單', () => {
  const l = read('ui/list.js'), m = read('ui/m.js'), w = read('src-tauri/src/wins.rs'), lib = read('src-tauri/src/lib.rs')
  assert.ok(l.includes('session: sess.ready ? currentSession() : sess.saved'), '還原完成前不得把存檔蓋成空的')
  assert.ok(l.includes('() => ui.tabs, () => ui.active, () => ui.panel, () => sess.wins'), '分頁變動要觸發存檔')
  assert.ok(l.includes('restoreSession(sess.saved'), '開機要還原')
  assert.ok(l.includes("invoke('open_windows')"), '分開模式要問 Rust 有哪些視窗開著')
  assert.ok(l.includes('trailingThrottle(') && l.includes("'pagehide'"), '節流寫入並在離開時補寫')
  assert.ok(m.includes('restoreMobileTab(saved.navTab)') && m.includes('navTab: nav.tab'), '手機版要存要還原大分頁')
  assert.ok(w.includes('pub fn open_windows') && lib.includes('wins::open_windows'), 'Rust 端要註冊 open_windows')
})

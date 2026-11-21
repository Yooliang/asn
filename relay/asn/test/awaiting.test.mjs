// 視窗開著、卡在第一次確認畫面還沒進到對話的夥伴（#1635）：名單認出來、顯示「等你在那台電腦按確認」、工作管理員多一列（看畫面／停止）。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { AWAITING_DETAIL, AWAITING_LABEL, AWAITING_STATUS, awaitingName, isAwaitingEntry } from '../ui/lib/awaiting.mjs'
import { buildFriends, statusOf } from '../ui/lib/roster.mjs'
import { displayOnlyHint, isDisplayOnly } from '../ui/lib/display-only.mjs'
import { statusNote } from '../ui/lib/tabs.mjs'
import { PATH, TEXT, confirmView, createTaskManager, initialState, mergeRows, stopPlan, stopRequest, viewRow } from '../ui/lib/task-manager.mjs'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const rust = fs.readFileSync(path.join(root, 'src-tauri/src/launch/awaiting.rs'), 'utf8').replace(/\r\n/g, '\n')
const NOW = 1_800_000_000_000
const SELF = 'P'
const entry = (o = {}) => ({ name: 'claude · 小乙 #502', status: 'running', engine: 'claude', kind: 'process', receivable: false, detail: AWAITING_DETAIL, ...o })
const members = agents => [{ id: SELF, name: '這台', agents }]

test('跨語言：固定句和 Rust 端一致', () => {
  const m = /pub\(crate\) const DETAIL: &str = "([^"]+)";/.exec(rust)
  assert.ok(m, '找不到 Rust 端的 DETAIL')
  assert.equal(m[1], AWAITING_DETAIL)
})

test('認出來：kind、不能收信、固定說明、名字格式都對才算', () => {
  assert.equal(isAwaitingEntry(entry()), true)
  assert.equal(awaitingName('claude · 小乙 #502'), '小乙')
  assert.equal(awaitingName('claude · 小 乙 #1 #502'), '小 乙 #1')
  for (const bad of [entry({ kind: 'window' }), entry({ receivable: true }), entry({ detail: '別的說明' }), entry({ detail: null }), entry({ name: '小乙' }), entry({ name: 'claude #502（背景）' })]) {
    assert.equal(isAwaitingEntry(bad), false, JSON.stringify(bad))
  }
})

test('名單：認出來的夥伴顯示夥伴名與等確認狀態，說明句不重複顯示', () => {
  const f = buildFriends(members([entry()]), { selfNode: 'X', selfName: 'x' })[0]
  assert.equal(f.status, AWAITING_STATUS)
  assert.equal(f.nick, '小乙')
  assert.equal(f.psm, '')
  assert.deepEqual([f.awaiting, f.awaitName, f.receivable, f.entryKind], [true, '小乙', false, 'process'])
  assert.equal(isDisplayOnly(f), true, '仍然不能收信')
  assert.equal(statusNote(f.status), '(等你按確認)')
  assert.match(displayOnlyHint(f), /還沒進到對話/)
  assert.equal(AWAITING_LABEL, '等你在那台電腦按確認')
})

test('名單：別的僅顯示條目照舊（灰點執行中・僅顯示）', () => {
  const f = buildFriends(members([entry({ name: 'claude #9（背景）', detail: null })]), { selfNode: 'X', selfName: 'x' })[0]
  assert.equal(f.status, 'running')
  assert.equal(f.awaiting, undefined)
  assert.equal(statusOf('running', true), 'running')
})

// ---------- 工作管理員 ----------

const row = (o = {}) => ({ kind: 'awaiting', name: '小乙', engine: 'claude', pid: 502, memory_bytes: 400 * 1024 * 1024, started_ms: NOW - 120_000, status: 'awaiting', detail: AWAITING_DETAIL, by_asn: true, cwd: 'G:/w', session_id: null, term_id: '7', live: true, ...o })
const ctx = friends => ({ friends, selfNode: SELF, ops: {}, asn: {} })

test('工作管理員：停止走 term_stop，多帶夥伴名給電腦端再驗；缺編號不能停', () => {
  const c = ctx([])
  assert.deepEqual(stopPlan(row(), c), { path: PATH.term, ok: true, reason: '' })
  assert.deepEqual(stopRequest(row(), c), { path: PATH.term, req: { id: '7', awaiting_name: '小乙' } })
  assert.equal(stopRequest(row({ term_id: null }), c), null)
})

test('工作管理員：這一列的顯示、確認框與「看畫面」', () => {
  const v = viewRow(row(), NOW, ctx([]))
  assert.deepEqual([v.name, v.engine, v.status, v.source, v.canStop, v.canView, v.viewOnly], ['小乙', 'Claude', '等你按確認', '不明', true, true, false])
  assert.equal(viewRow(row({ kind: 'claude', term_id: null }), NOW, ctx([])).canView, false)
  const c = confirmView(row(), [], NOW)
  assert.match(c.title, /等確認/)
  assert.equal(c.ok, TEXT.stop)
  assert.equal(TEXT.view, '看畫面')
  assert.equal(mergeRows({ rows: [row()] }, [], SELF)[0].dup, false)
})

test('工作管理員：看畫面打開名單上那位夥伴的對話頁；名單上還沒有就請稍後再試', () => {
  const opened = []
  const friends = [{ id: 'P/claude · 小乙 #502', node: SELF, agent: 'claude · 小乙 #502', awaiting: true, awaitName: '小乙' }]
  const mk = fr => createTaskManager({ api: {}, getFriends: () => fr, getSelfNode: () => SELF, getOpsCtx: () => ({}), openChat: id => opened.push(id), state: { ...initialState(), open: true } })
  const tm = mk(friends)
  assert.equal(tm.openScreen('小乙'), true)
  assert.deepEqual(opened, ['P/claude · 小乙 #502'])
  const none = mk([])
  assert.equal(none.openScreen('小乙'), false)
  assert.equal(none.state.wakeNote, TEXT.noPlace)
})

// #2242：工作管理員整個畫面不再出現「只能看」（沒有鈕就留白，原因放進細項）；動作鈕從右邊排，停止永遠在最右。
// 真資料：冒煙腳本 taskmgrSnapshot 的形狀；另外自造三種沒有「重啟」鈕的情況（沒給 restart 欄位、沒有終端服務、遠端／Linux 沒有 ASN 本體列）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { treeView } from '../ui/lib/task-tree.mjs'
import { mergeRows, viewRow } from '../ui/lib/task-manager.mjs'
import { TaskTree, TaskNode } from '../ui/lib/task-tree-view.mjs'
import { taskmgrSnapshot } from '../scripts/smoke-lib.mjs'
import { mountComponent } from './helpers/render.mjs'

const NOW = 1_800_000_000_000
const SELF = 'P'
const ctx = { friends: [], selfNode: SELF, ops: {}, asn: {} }
const settle = async m => { for (let i = 0; i < 3; i++) { await new Promise(r => setTimeout(r, 0)); await m.nextTick() } }
const base = (o = {}) => ({ kind: 'claude', name: 'x', engine: 'claude', pid: 1, memory_bytes: null, started_ms: null, status: 'idle', detail: null, by_asn: true, cwd: '', session_id: 's', term_id: null, live: true, inside: null, term: 'unknown', mux_pid: null, ...o })
const asnRow = base({ kind: 'asn', name: 'ASN', engine: 'asn', pid: 7000, status: 'running' })
const muxRow = base({ kind: 'mux', name: '終端服務', engine: '', pid: 6000, status: 'running', inside: 0 })
const own = base({ name: 'own', pid: 21, by_asn: false })
const proc = base({ kind: 'process', name: 'proc', engine: 'grok', pid: 31, by_asn: false, session_id: null })
const mkView = (rows, ui) => treeView(rows, r => viewRow(r, NOW, ctx), ui)
const openAll = async m => {
  for (const b of m.findAll('.tm-title')) if (b.getAttribute('aria-expanded') === 'false') await m.trigger(b, 'click')
  await settle(m)
}
// 一列操作區裡由左到右的鈕（用 class 認，不靠文字）
const order = (m, sel) => [...m.find(`${sel} .tm-act`).children].map(el => el.className.split(' ').find(c => /^tm-(stop|handover|view-btn|adopt|restart)$/.test(c))).filter(Boolean)

// 拿掉重啟欄位：模擬舊版電腦端沒給 restart
const noRestart = tree => ({ ...tree, root: tree.root && { ...tree.root, restart: null }, groups: tree.groups.map(g => ({ ...g, restart: null })) })

const scenarios = () => {
  const full = taskmgrSnapshot(NOW)
  const rows = [asnRow, own, proc, base({ name: 'a', pid: 11 })]
  return {
    '真資料（有重啟）': mkView(mergeRows(full, [], SELF)),
    '真資料但沒給 restart 欄位（舊版電腦端）': noRestart(mkView(mergeRows(full, [], SELF))),
    '這台用終端服務、但清單上沒有任何終端服務（佔位也沒有）': mkView([...rows], { muxExpected: false }),
    '遠端看／Linux：沒有 ASN 本體列、沒有終端服務': mkView([own, proc, base({ name: 'a', pid: 11 }), muxRow]),
  }
}

for (const [name, tree] of Object.entries(scenarios())) {
  test(`#2242 整個畫面不出現「只能看」（${name}）；展開後看得到原因`, async () => {
    const m = mountComponent(TaskTree, { tree })
    try {
      await settle(m)
      assert.ok(!m.container.textContent.includes('只能看'), '收起時')
      await openAll(m)
      const text = m.container.textContent
      assert.ok(!text.includes('只能看'), '全部展開後')
      assert.ok(!m.find('.tm-viewonly'), '沒有那個元素')
      const reasons = m.findAll('.tm-reason').map(e => e.textContent)
      assert.ok(reasons.length >= 1, '不能停止的列，原因在細項')
      assert.ok(reasons.every(t => t && t.length < 40), '一行白話')
    } finally { m.unmount() }
  })
}

test('#2242 沒有鈕的列留白：原因不在操作區、不在主行，只在展開後的細項', async () => {
  const tree = mkView([own, proc], {})
  const m = mountComponent(TaskTree, { tree })
  try {
    await settle(m)
    for (const n of m.findAll('.tm-node')) {
      assert.equal(n.querySelector('.tm-stop'), null)
      assert.equal(n.querySelector('.tm-act').textContent.includes('不能從這裡停止'), false)
      assert.equal(n.querySelector('.tm-reason'), null, '收起時看不到')
    }
    await openAll(m)
    assert.match(m.find('.tm-node[data-kind="process"] .tm-detail .tm-reason').textContent, /不能從這裡停止/)
    assert.equal(m.find('.tm-node[data-kind="process"] .tm-act').querySelector('.tm-reason'), null)
  } finally { m.unmount() }
})

test('#2242 按鈕順序：停止最右、交接在停止左邊、看畫面再往左', async () => {
  const going = base({ name: 'h', pid: 41, compact: { count: 3, state: 'remind' } })
  const wait = base({ kind: 'awaiting', name: 'w', pid: 51, term_id: 't1' })
  const m = mountComponent(TaskTree, { tree: mkView([going, wait]) })
  try {
    await settle(m)
    const hand = order(m, '.tm-node:has(.tm-handover)')
    assert.deepEqual(hand, ['tm-handover', 'tm-stop'], '交接在停止左邊，停止最右')
    const view = order(m, '.tm-node:has(.tm-view-btn)')
    assert.deepEqual(view, ['tm-view-btn', 'tm-stop'], '看畫面在停止左邊')
  } finally { m.unmount() }
})

test('#2242 按鈕順序：沒有停止的列，納入管理最右；ASN、終端服務的重啟最右', async () => {
  const m = mountComponent(TaskTree, { tree: mkView([asnRow, muxRow, own, proc]) })
  try {
    await settle(m)
    assert.deepEqual(order(m, '.tm-node[data-kind="process"]'), ['tm-adopt'])
    assert.deepEqual(order(m, '.tm-node[data-kind="claude"]'), ['tm-adopt'])
    assert.equal(order(m, '.tm-node[data-kind="asn"]').at(-1), 'tm-restart')
    assert.equal(order(m, '.tm-node[data-kind="mux"]').at(-1), 'tm-restart')
    // 沒有重啟欄位時 ASN 列沒有任何鈕
    const bare = mountComponent(TaskNode, { node: viewRow(asnRow, NOW, ctx) })
    try { await settle(bare); assert.deepEqual(order(bare, '.tm-node'), []); assert.ok(!bare.container.textContent.includes('只能看')) } finally { bare.unmount() }
  } finally { m.unmount() }
})

// #1860 F：工作管理員的樹（ASN ＞ 終端服務 ＞ 各代理）。歸屬只看電腦端給的 mux_pid，畫面不猜。
// 真資料：冒煙腳本 taskmgrSnapshot 的形狀（和 Rust build 序列化出來的一樣，含 mux_pid）；另外自造多個終端服務、原生主控台、沒有終端服務的 Linux。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { buildTree, treeView, toggleCollapsed, isCollapsed, muxKey, ROOT_KEY, TREE_TEXT } from '../ui/lib/task-tree.mjs'
import { confirmView, createTaskManager, initialState, mergeRows, viewRow } from '../ui/lib/task-manager.mjs'
import { TaskTree, nodeFields } from '../ui/lib/task-tree-view.mjs'
import { taskmgrSnapshot } from '../scripts/smoke-lib.mjs'
import { mountComponent } from './helpers/render.mjs'

const NOW = 1_800_000_000_000
const SELF = 'P'
const snap = () => taskmgrSnapshot(NOW)
const pids = rows => rows.map(r => r.pid)
const base = (o = {}) => ({ kind: 'claude', name: 'x', engine: 'claude', pid: 1, memory_bytes: null, started_ms: null, status: 'idle', detail: null, by_asn: true, cwd: '', session_id: 's', term_id: null, live: true, inside: null, term: 'unknown', mux_pid: null, ...o })
const mux = (pid, inside = 0) => base({ kind: 'mux', name: '終端服務', engine: '', pid, status: 'running', inside })
const asn = (pid = 7000) => base({ kind: 'asn', name: 'ASN', engine: 'asn', pid, status: 'running' })
const settle = async m => { for (let i = 0; i < 3; i++) { await new Promise(r => setTimeout(r, 0)); await m.nextTick() } }

test('#1860F 真資料：ASN 本體一個、終端服務底下三個、其餘直接掛在 ASN 底下', () => {
  const t = buildTree(snap().rows)
  assert.equal(t.asn.pid, 7000)
  assert.equal(t.groups.length, 1)
  assert.equal(t.groups[0].mux.pid, 6000)
  assert.deepEqual(pids(t.groups[0].agents), [18420, 4002, 23100], '歸屬照 mux_pid，不看運行位置文字、不看名字')
  assert.deepEqual(pids(t.direct), [21096, 3001, 4410, 5120], '原生、不明、自己開的與前景程式不在終端服務底下')
  assert.equal(t.agentCount, 6, '自己開的前景程式（process）不算 ASN 會帶走的代理')
})

test('#1860F 終端服務自己報的視窗數，就是樹裡它底下的代理數（mux_pid 與 inside 一致）', () => {
  const rows = snap().rows
  const t = buildTree(rows)
  const m = rows.find(r => r.kind === 'mux')
  assert.equal(m.inside, t.groups[0].agents.length)
})

test('#1860F 多個終端服務：各歸各的；原生主控台的代理掛在 ASN 底下', () => {
  const rows = [
    asn(),
    base({ name: 'a', pid: 11, mux_pid: 500 }), base({ name: 'b', pid: 12, mux_pid: 500 }),
    base({ name: 'c', pid: 21, mux_pid: 600 }),
    base({ name: 'native', pid: 31, term: 'native' }),
    mux(500, 2), mux(600, 1),
  ]
  const t = buildTree(rows)
  assert.deepEqual(t.groups.map(g => [g.mux.pid, pids(g.agents)]), [[500, [11, 12]], [600, [21]]])
  assert.deepEqual(pids(t.direct), [31])
  assert.equal(t.agentCount, 4)
})

test('#1860F Linux 沒有終端服務：樹只有兩層（ASN ＞ 代理）', () => {
  const rows = [asn(), base({ name: 'a', pid: 11 }), base({ name: 'b', pid: 12 })]
  const t = buildTree(rows)
  assert.deepEqual(t.groups, [])
  assert.deepEqual(pids(t.direct), [11, 12])
  const v = treeView(rows, r => ({ key: String(r.pid), name: r.name }))
  assert.equal(v.groups.length, 0)
  assert.equal(v.root.node.name, 'ASN')
})

test('#1860F mux_pid 對不上任何終端服務（服務那列沒出現、舊版沒給欄位）：直接掛在 ASN 底下，不會不見', () => {
  const rows = [asn(), base({ name: 'orphan', pid: 11, mux_pid: 999 }), (({ mux_pid, ...r }) => r)(base({ name: 'old', pid: 12 }))]
  const t = buildTree(rows)
  assert.deepEqual(pids(t.direct), [11, 12])
  assert.equal(t.groups.length, 0)
})

test('#1860F 每一列只出現一次：樹裡的列數等於清單的列數（含 ASN 與終端服務）', () => {
  const rows = snap().rows
  const t = buildTree(rows)
  const n = (t.asn ? 1 : 0) + t.groups.length + t.groups.reduce((s, g) => s + g.agents.length, 0) + t.direct.length
  assert.equal(n, rows.length)
})

test('#1860F 沒有 ASN 本體那一列：終端服務與直接掛的列就是最外層；收發室視窗照一般視窗歸類', () => {
  const rows = [mux(500, 1), base({ kind: 'asn', name: '辦公室-收發室', pid: 41, mux_pid: 500 }), base({ name: 'z', pid: 9 })]
  const t = buildTree(rows)
  assert.equal(t.asn, null)
  assert.deepEqual(pids(t.groups[0].agents), [41])
  assert.equal(treeView(rows, r => r).root, null)
})

test('#1860F 不改傳進來的清單', () => {
  const rows = snap().rows
  const copy = JSON.stringify(rows)
  buildTree(rows)
  treeView(rows, r => r)
  assert.equal(JSON.stringify(rows), copy)
  assert.deepEqual(buildTree(null).groups, [])
})

test('#1860F 收合：只記被收起的鍵，回新清單，再按一次展開', () => {
  const a = []
  const b = toggleCollapsed(a, muxKey(500))
  assert.deepEqual(a, [], '不改原本的')
  assert.equal(isCollapsed(b, 'mux:500'), true)
  assert.equal(isCollapsed(b, ROOT_KEY), false)
  assert.deepEqual(toggleCollapsed(b, 'mux:500'), [])
  assert.equal(isCollapsed(undefined, 'x'), false)
})

test('#1860F 控制器：view().tree 與平的 rows 同一批；確認框的主詞前綴可由外面給（別台用）', async () => {
  const snapshot = { rows: [asn(), mux(500, 1), base({ name: '西川', pid: 11, mux_pid: 500, by_asn: true })], known: [] }
  const friends = [{ node: SELF, agent: '西川', engine: 'claude', status: 'idle' }]
  const ops = { signedIn: true, loaded: true, checking: false, machines: { [SELF]: { online: true, launcher: { profiles: [] } } } }
  const mk = prefix => createTaskManager({ api: { taskManagerList: async () => snapshot }, getFriends: () => friends, getSelfNode: () => SELF, getOpsCtx: () => ops, now: () => NOW, setTimer: () => 1, clearTimer: () => {}, state: initialState(), confirmPrefix: prefix, log: () => {} })
  const tm = mk(undefined)
  tm.open()
  await new Promise(r => setTimeout(r, 5))
  const v = tm.view()
  assert.equal(v.tree.groups[0].agents.length, 1)
  assert.equal(v.tree.groups[0].summary, TREE_TEXT.agents(1))
  assert.equal(v.tree.root.statusText, '運作中')
  assert.equal(v.rows.length, 3)
  tm.ask(v.tree.groups[0].agents[0].key)
  assert.equal(tm.view().confirm.title, '要停止「西川」的這個視窗嗎？', '這台自己不加前綴')
  const other = mk(() => '「工作機」的')
  other.open()
  await new Promise(r => setTimeout(r, 5))
  other.ask(other.view().tree.groups[0].agents[0].key)
  assert.equal(other.view().confirm.title, '「工作機」的要停止「西川」的這個視窗嗎？')
  assert.equal(confirmView(base({ name: '西川' }), [], NOW, '「X」的').title.startsWith('「X」的'), true)
})

test('#1860F 小字欄位：壓縮次數只有 Claude 視窗有；其他列只寫引擎、編號、記憶體、開了多久', () => {
  const ctx = { friends: [], selfNode: SELF, ops: {}, asn: {} }
  const fields = r => nodeFields(viewRow(r, NOW, ctx)).map(f => f.k)
  assert.deepEqual(fields(base()), ['引擎', '程序編號', '記憶體', '開了多久'])
  assert.deepEqual(fields(base({ compact: { count: 2, state: 'remind' } })), ['引擎', '程序編號', '記憶體', '開了多久', '壓縮次數'])
})

test('#1860F 畫面：樹的層級與收合（真的掛載）', async () => {
  const ctx = { friends: [], selfNode: SELF, ops: {}, asn: {} }
  const rows = mergeRows(snap(), [], SELF)
  const tree = treeView(rows, r => viewRow(r, NOW, ctx))
  const m = mountComponent(TaskTree, { tree })
  try {
    await settle(m)
    const level = pid => [...m.container.querySelectorAll('.tm-node')].find(n => n.querySelector('.tm-meta').textContent.includes(`程序編號 ${pid}`))?.getAttribute('data-level')
    assert.equal(m.find('.tm-node[data-kind="asn"]').getAttribute('data-level'), '1')
    assert.equal(m.find('.tm-node[data-kind="mux"]').getAttribute('data-level'), '2')
    assert.equal(level(18420), '3', '開在終端服務裡的視窗在終端服務底下')
    assert.equal(level(3001), '2', '原生主控台的視窗和終端服務並列')
    assert.match(m.find('.tm-node[data-kind="mux"] .tm-state').textContent, /底下 3 個代理/)
    assert.equal(m.findAll('.tm-node').length, 9)
    // 收合終端服務
    await m.trigger(m.find('.tm-node[data-kind="mux"] .tm-fold'), 'click'); await settle(m)
    assert.equal(level(18420), undefined, '收起來之後底下的視窗不顯示')
    assert.equal(level(3001), '2', '並列的不受影響')
    assert.equal(m.find('.tm-node[data-kind="mux"]').getAttribute('aria-expanded'), 'false')
    await m.trigger(m.find('.tm-node[data-kind="mux"] .tm-fold'), 'click'); await settle(m)
    assert.equal(level(18420), '3')
    // 收合 ASN：整棵收起，只剩 ASN 本身
    await m.trigger(m.find('.tm-node[data-kind="asn"] .tm-fold'), 'click'); await settle(m)
    assert.equal(m.findAll('.tm-node').length, 1)
  } finally { m.unmount() }
})

test('#1860F 畫面：按鈕只往外送 act，納入管理帶那一列的鍵；只能看的節點沒有停止鈕', async () => {
  const ctx = { friends: [], selfNode: SELF, ops: {}, asn: {} }
  const tree = treeView(mergeRows(snap(), [], SELF), r => viewRow(r, NOW, ctx))
  const m = mountComponent(TaskTree, { tree })
  try {
    await settle(m)
    for (const k of ['asn', 'mux', 'process']) assert.equal(m.find(`.tm-node[data-kind="${k}"] .tm-stop`), null, `${k} 只能看`)
    assert.ok(m.find('.tm-node[data-kind="asn"] .tm-viewonly'))
    const adopt = m.findAll('.tm-adopt')
    assert.equal(adopt.length, 2, '自己開的視窗與前景程式各一顆')
    await m.trigger(adopt[0], 'click')
    const ev = m.emitted('act')
    assert.equal(ev.length, 1)
    assert.equal(ev[0][0], 'tm-adopt')
    assert.match(ev[0][1], /^claude:21096:/)
  } finally { m.unmount() }
})

test('#1860F 設定頁用樹、不再有表格；元件不直接呼叫後端', () => {
  const read = p => fs.readFileSync(new URL(p, import.meta.url), 'utf8')
  const panel = read('../ui/lib/settings-panel.mjs')
  assert.match(panel, /<task-tree v-if="st\.taskMgr\.rows\.length" :tree="st\.taskMgr\.tree"/)
  assert.doesNotMatch(panel, /tm-table/)
  const view = read('../ui/lib/task-tree-view.mjs')
  assert.doesNotMatch(view, /invoke\(|fetch\(|taskManagerList|partnerOp/, '元件只吃資料、只送 act')
})

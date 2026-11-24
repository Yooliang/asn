// #1860 F PR3：工作管理員樹上 ASN 與終端服務的「重啟」。確認文字逐字、代理數 N、重啟中顯示、失敗白話、沒有終端服務不出鈕。
// 真資料：冒煙腳本 taskmgrSnapshot 的形狀（ASN 一個、終端服務一個、底下 3 個代理）。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { treeView, restartAsnText, restartMuxText, TREE_TEXT, ROOT_KEY, muxKey } from '../ui/lib/task-tree.mjs'
import { createTaskManager, initialState, mergeRows, viewRow, RESUME_WAIT_MS, ASN_RESTART_WAIT_MS } from '../ui/lib/task-manager.mjs'
import { TaskTree } from '../ui/lib/task-tree-view.mjs'
import { SETTING_OPS } from '../ui/lib/settings-panel.mjs'
import { taskmgrSnapshot } from '../scripts/smoke-lib.mjs'
import { mountComponent } from './helpers/render.mjs'

const NOW = 1_800_000_000_000
const SELF = 'P'
const read = p => fs.readFileSync(new URL(p, import.meta.url), 'utf8')
const settle = async m => { for (let i = 0; i < 3; i++) { await new Promise(r => setTimeout(r, 0)); await m.nextTick() } }
const tick = () => new Promise(r => setTimeout(r, 5))
const OPS = { signedIn: true, loaded: true, checking: false, machines: { [SELF]: { online: true, launcher: { profiles: [] } } } }
const MUX = muxKey(6000)

function mk({ snapshot = taskmgrSnapshot(NOW), api = {}, prefix, logs = [] } = {}) {
  const snap = { current: snapshot }
  const clock = { t: NOW }
  const tm = createTaskManager({
    api: { taskManagerList: async () => snap.current, taskManagerRestartAsn: async () => {}, taskManagerRestartMux: async () => {}, ...api },
    getFriends: () => [], getSelfNode: () => SELF, getOpsCtx: () => OPS, now: () => clock.t,
    setTimer: () => 1, clearTimer: () => {}, state: initialState(), confirmPrefix: prefix, log: m => logs.push(m),
  })
  return { tm, snap, logs, clock }
}
const opened = async o => { o.tm.open(); await tick(); return o }

test('#1860F-3 確認文字逐字：ASN、終端服務（N 是它底下的代理數）', async () => {
  const { tm } = await opened(mk())
  tm.askRestart(ROOT_KEY)
  assert.equal(tm.view().tree.root.restart.ask, '重啟 ASN？收發室會暫時斷線，代理視窗不受影響，之後會自動連回。')
  tm.askRestart(MUX)
  const g = tm.view().tree.groups[0]
  assert.equal(g.agents.length, 3)
  assert.equal(g.restart.ask, '重啟終端服務？底下所有代理（3 個）會暫時斷線，之後會自動連回。')
  assert.equal(tm.view().tree.root.restart.ask, '', '同時只有一個在確認')
  assert.equal(restartMuxText(5), '重啟終端服務？底下所有代理（5 個）會暫時斷線，之後會自動連回。')
})

test('#1860F-3 別台的框前面加那台的名字（前綴機制）', async () => {
  const { tm } = await opened(mk({ prefix: () => '「工作機」的' }))
  tm.askRestart(ROOT_KEY)
  assert.equal(tm.view().tree.root.restart.ask, '重啟「工作機」的 ASN？收發室會暫時斷線，代理視窗不受影響，之後會自動連回。')
  tm.askRestart(MUX)
  assert.equal(tm.view().tree.groups[0].restart.ask, '重啟「工作機」的終端服務？底下所有代理（3 個）會暫時斷線，之後會自動連回。')
  assert.equal(restartAsnText('「工作機」的'), '重啟「工作機」的 ASN？收發室會暫時斷線，代理視窗不受影響，之後會自動連回。')
})

const ASN_BASE = '重啟 ASN？收發室會暫時斷線，代理視窗不受影響，之後會自動連回。'
const ASN_PENDING = '重啟 ASN？還有 2 位代理沒接回，重啟 ASN 會讓這份名單遺失。請先在這台的工作管理員重按「重啟終端服務」把他們接回，再重啟 ASN。'

test('#1860F-3 有代理沒接回時，重啟 ASN 的確認框整句換成提醒、確認鈕照樣能按；沒有時是定稿', async () => {
  assert.equal(restartAsnText('', 2), ASN_PENDING)
  assert.equal(restartAsnText('', 0), ASN_BASE)
  assert.equal(restartAsnText(), ASN_BASE)
  // 走完整條：電腦端清單帶 restart_pending
  const o = await opened(mk({ snapshot: { ...taskmgrSnapshot(NOW), restart_pending: 2 } }))
  o.tm.askRestart(ROOT_KEY)
  assert.equal(o.tm.view().tree.root.restart.ask, ASN_PENDING)
  o.tm.askRestart(MUX)
  assert.equal(o.tm.view().tree.groups[0].restart.ask, '重啟終端服務？底下所有代理（3 個）會暫時斷線，之後會自動連回。', '終端服務的確認框不變')
  const z = await opened(mk({ snapshot: { ...taskmgrSnapshot(NOW), restart_pending: 0 } }))
  z.tm.askRestart(ROOT_KEY)
  assert.equal(z.tm.view().tree.root.restart.ask, ASN_BASE)
  // 畫面：提醒的字逐字、「重啟」鈕可按、按了照樣送確認
  o.tm.askRestart(ROOT_KEY)
  const m = mountComponent(TaskTree, { tree: o.tm.view().tree })
  try {
    await settle(m)
    const box = m.find('.tm-node[data-kind="asn"] .asn-confirm')
    assert.equal(box.querySelector('.asn-confirm-text').textContent, ASN_PENDING)
    const yes = [...box.querySelectorAll('button')][1]
    assert.equal(yes.textContent.trim(), '重啟')
    assert.equal(yes.disabled, false, '有代理沒接回也不擋，讓本人自己決定')
    await m.trigger(yes, 'click')
    assert.deepEqual(m.emitted('act').at(-1), ['tm-restart-confirm', ROOT_KEY])
  } finally { m.unmount() }
})

// 新的起不來之後：沒有終端服務程序，清單上就沒有 kind:'mux' 那一列
const noMux = (extra = {}) => {
  const s = taskmgrSnapshot(NOW)
  return { ...s, rows: s.rows.filter(r => r.kind !== 'mux').map(r => ({ ...r, mux_pid: null })), mux_expected: true, ...extra }
}
const PLACEHOLDER = muxKey('none')

test('#1860F-3 終端服務沒在跑（起不來之後）但這台用終端服務：樹上仍有「終端服務　沒有在運行」和可按的重啟，送到同一個 target', async () => {
  const o = await opened(mk({ snapshot: noMux({ restart_pending: 2 }) }))
  const g = o.tm.view().tree.groups
  assert.equal(g.length, 1, '佔位一組')
  assert.equal(g[0].key, PLACEHOLDER)
  assert.equal(g[0].summary, TREE_TEXT.muxNone)
  assert.equal(TREE_TEXT.muxNone, '沒有在運行')
  assert.equal(g[0].restart.busy, false)
  assert.equal(g[0].restart.disabled, false)
  const m = mountComponent(TaskTree, { tree: o.tm.view().tree })
  try {
    await settle(m)
    const btn = m.find('.tm-node[data-kind="mux"] .tm-restart')
    assert.ok(btn && !btn.disabled, '重啟鈕在、能按')
    assert.ok(m.find('.tm-node[data-kind="mux"]').textContent.includes('沒有在運行'))
    await m.trigger(btn, 'click')
    assert.deepEqual(m.emitted('act').at(-1), ['tm-restart-ask', PLACEHOLDER])
  } finally { m.unmount() }
  // 按下去走同一條重啟終端服務（不是重啟 ASN），確認字講還有幾位沒接回
  const calls = []
  const o2 = await opened(mk({ snapshot: noMux({ restart_pending: 2 }), api: { taskManagerRestartMux: async () => { calls.push('mux') }, taskManagerRestartAsn: async () => { calls.push('asn') } } }))
  o2.tm.askRestart(PLACEHOLDER)
  assert.equal(o2.tm.view().tree.groups[0].restart.ask, '重啟終端服務？還有 2 位代理沒接回，重啟後會自動連回。')
  await o2.tm.confirmRestart()
  assert.deepEqual(calls, ['mux'])
  assert.equal(o2.tm.view().tree.groups[0].restart.busy, true, '重啟中顯示正在重啟')
  // 新服務回來（清單有 mux 列）：佔位消失、換成真的那一組
  o2.snap.current = taskmgrSnapshot(NOW)
  await o2.tm.refresh()
  assert.equal(o2.tm.state.restart, null)
  assert.deepEqual(o2.tm.view().tree.groups.map(x => x.key), [MUX])
  // 沒有名單等著（restart_pending 0）、一般沒在跑：確認字講明是重新啟動
  const o3 = await opened(mk({ snapshot: noMux() }))
  o3.tm.askRestart(PLACEHOLDER)
  assert.equal(o3.tm.view().tree.groups[0].restart.ask, '重啟終端服務？目前沒有在運行，按下後會重新啟動。')
})

test('#1860F-3 沒開終端服務模式（Linux，mux_expected 不是真）：沒有佔位；有真的終端服務時也不多列', async () => {
  const o = await opened(mk({ snapshot: noMux({ mux_expected: false }) }))
  assert.equal(o.tm.view().tree.groups.length, 0)
  const legacy = noMux(); delete legacy.mux_expected   // 舊版電腦端不給欄位
  assert.equal((await opened(mk({ snapshot: legacy }))).tm.view().tree.groups.length, 0)
  const live = await opened(mk({ snapshot: { ...taskmgrSnapshot(NOW), mux_expected: true } }))
  assert.deepEqual(live.tm.view().tree.groups.map(x => x.key), [MUX], '有服務就只有那一組，不再加佔位')
})

test('#1860F-3 重啟終端服務中：那一列顯示「正在重啟…」、底下代理標「斷線中」且不能停止；回來後恢復', async () => {
  let release
  const gate = new Promise(r => { release = r })
  const o = await opened(mk({ api: { taskManagerRestartMux: () => gate } }))
  const { tm, snap } = o
  tm.askRestart(MUX)
  const p = tm.confirmRestart()
  const v = tm.view().tree
  assert.equal(v.groups[0].restart.busy, true)
  assert.ok(v.groups[0].agents.every(a => a.status === '斷線中' && a.canStop === false), '代理斷線中、停止鈕停用')
  assert.equal(v.root.restart.busy, false, 'ASN 本體不受影響')
  assert.equal(v.root.restart.disabled, true, '重啟中其他重啟鈕不能按')
  // 舊服務停了、清單裡找不到它：用按下時記的那一組撐著
  snap.current = { ...snap.current, rows: snap.current.rows.filter(r => r.kind !== 'mux' && r.mux_pid !== 6000) }
  await tm.refresh()
  const g = tm.view().tree.groups
  assert.equal(g.length, 1, '服務不在清單上時，畫面仍有這一組')
  assert.equal(g[0].restart.busy, true)
  assert.ok(g[0].agents.length === 3 && g[0].agents.every(a => a.status === '斷線中'))
  release()
  await p
  // 新服務起好了，但接回要幾十秒：清單裡還沒有它與代理時，畫面繼續標「斷線中」，不能馬上消失（審查 #3 建議）
  assert.equal(tm.state.restart, 'mux:*', '新服務起好後，等接回完成或逾時才放掉')
  const waiting = tm.view().tree.groups
  assert.equal(waiting.length, 1)
  assert.ok(waiting[0].restart.busy && waiting[0].agents.length === 3 && waiting[0].agents.every(a => a.status === '斷線中'))
  // 接回完成：三位代理都回到清單
  snap.current = taskmgrSnapshot(NOW)
  await tm.refresh()
  assert.equal(tm.state.restart, null, '代理回齊就恢復')
  assert.ok(tm.view().tree.groups[0].agents.every(a => a.status !== '斷線中'))
})

test('#1860F-3 接回只回來一部分：繼續標斷線中；超過 90 秒放掉，不永遠卡住', async () => {
  const logs = []
  let release
  const o = await opened(mk({ logs, api: { taskManagerRestartMux: () => new Promise(r => { release = r }) } }))
  const { tm, snap, clock } = o
  tm.askRestart(MUX)
  const p = tm.confirmRestart()
  // 新服務起來時，清單上只回來一位代理
  const full = taskmgrSnapshot(NOW)
  const agents = full.rows.filter(r => r.kind !== 'mux' && r.mux_pid === 6000)
  snap.current = { ...full, rows: full.rows.filter(r => r.kind === 'asn' || r.kind === 'mux' || r === agents[0]) }
  release()
  await p
  assert.equal(tm.state.restart, 'mux:*')
  assert.equal(RESUME_WAIT_MS, 90_000)
  clock.t = NOW + RESUME_WAIT_MS - 1000
  await tm.refresh()
  assert.equal(tm.state.restart, 'mux:*', '還沒逾時、還有人沒回來，繼續標斷線中')
  clock.t = NOW + RESUME_WAIT_MS
  await tm.refresh()
  assert.equal(tm.state.restart, null, '逾時就放掉')
  assert.ok(logs.some(l => l.includes('逾時')), '原因進 log')
})

test('#1860F-3 重啟 ASN 逾時：頁面還在、ASN 沒回來，回報白話字並恢復按鈕', async () => {
  const logs = []
  const o = await opened(mk({ logs }))
  const { tm, clock } = o
  tm.askRestart(ROOT_KEY)
  await tm.confirmRestart()
  assert.equal(tm.state.restart, ROOT_KEY)
  assert.equal(ASN_RESTART_WAIT_MS, 60_000)
  clock.t = NOW + ASN_RESTART_WAIT_MS - 1000
  await tm.refresh()
  assert.equal(tm.state.restart, ROOT_KEY, '還沒到時間，維持正在重啟')
  clock.t = NOW + ASN_RESTART_WAIT_MS
  await tm.refresh()
  const r = tm.view().tree.root.restart
  assert.equal(tm.state.restart, null)
  assert.equal(r.busy, false, '恢復按鈕')
  assert.equal(r.disabled, false)
  assert.equal(r.error, '重啟沒有完成，ASN 仍在執行。')
  assert.ok(logs.some(l => l.includes('逾時')))
})

test('#1860F-3 失敗後馬上重讀清單；錯誤掛在 ASN 列（終端服務那一列重啟後可能換了編號就不見）', async () => {
  let lists = 0
  const o = await opened(mk({ api: { taskManagerList: async () => { lists++; return o.snap.current }, taskManagerRestartMux: async () => { throw '重啟沒有成功，請稍後再試。' } } }))
  const before = lists
  o.tm.askRestart(MUX); await o.tm.confirmRestart()
  assert.ok(lists > before, '失敗後要重讀清單')
  // 終端服務那一列消失（換了編號）後，錯誤還看得到
  o.snap.current = { ...o.snap.current, rows: o.snap.current.rows.filter(r => r.kind !== 'mux' && r.mux_pid !== 6000) }
  await o.tm.refresh()
  assert.equal(o.tm.view().tree.groups.length, 0)
  assert.equal(o.tm.view().tree.root.restart.error, '重啟沒有成功，請稍後再試。')
})

test('#1860F-3 重啟 ASN：按下後先顯示「正在重啟…」，整棵樹斷線中', async () => {
  let release
  const o = await opened(mk({ api: { taskManagerRestartAsn: () => new Promise(r => { release = r }) } }))
  o.tm.askRestart(ROOT_KEY)
  const p = o.tm.confirmRestart()
  const v = o.tm.view().tree
  assert.equal(v.root.restart.busy, true)
  assert.ok(v.groups[0].agents.every(a => a.status === '斷線中'))
  assert.ok(v.direct.every(a => a.status === '斷線中' && !a.canStop))
  release()
  await p
  assert.equal(o.tm.state.restart, ROOT_KEY, '成功後本頁會隨 ASN 重開，維持「正在重啟…」')
})

test('#1860F-3 失敗：畫面白話、原文進 log、可再試；電腦端回的白話字串直接顯示', async () => {
  const logs = []
  const o = await opened(mk({ logs, api: { taskManagerRestartAsn: async () => { throw new Error('os error 5 拒絕存取') }, taskManagerRestartMux: async () => { throw '這台沒有終端服務。' } } }))
  o.tm.askRestart(ROOT_KEY); await o.tm.confirmRestart()
  let r = o.tm.view().tree.root.restart
  assert.equal(r.error, '重啟沒有成功，請稍後再試。')
  assert.ok(!r.error.includes('os error'), '原文不上畫面')
  assert.ok(logs.some(l => l.includes('os error 5 拒絕存取')), '原文寫 log')
  assert.equal(r.busy, false, '失敗後恢復按鈕')
  assert.equal(o.tm.state.restart, null)
  o.tm.askRestart(MUX); await o.tm.confirmRestart()
  assert.equal(o.tm.view().tree.root.restart.error, '這台沒有終端服務。', '錯誤掛在一定存在的 ASN 列')
  assert.equal(o.tm.view().tree.groups[0].restart.error, '', '不重複掛在終端服務那一列')
  assert.ok(o.tm.view().tree.groups[0].agents.every(a => a.status !== '斷線中'), '失敗後代理不再標斷線')
})

test('#1860F-3 電腦端回報重啟中（頁面重新載入後）：終端服務底下標斷線中', async () => {
  const s = { ...taskmgrSnapshot(NOW), mux_restarting: true }
  const { tm } = await opened(mk({ snapshot: s }))
  const g = tm.view().tree.groups[0]
  assert.equal(g.restart.busy, true)
  assert.ok(g.agents.every(a => a.status === '斷線中'))
})

test('#1860F-3 沒有終端服務（Linux）：只有 ASN 的重啟，沒有終端服務的鈕', async () => {
  const ctx = { friends: [], selfNode: SELF, ops: {}, asn: {} }
  const rows = taskmgrSnapshot(NOW).rows.filter(r => r.kind !== 'mux').map(r => ({ ...r, mux_pid: null }))
  const tree = treeView(mergeRows({ rows }, [], SELF), r => viewRow(r, NOW, ctx))
  assert.equal(tree.groups.length, 0)
  const m = mountComponent(TaskTree, { tree })
  try {
    await settle(m)
    assert.equal(m.findAll('.tm-restart').length, 1, '只有 ASN 那一顆')
    assert.ok(m.find('.tm-node[data-kind="asn"] .tm-restart'))
  } finally { m.unmount() }
})

test('#1860F-3 畫面：重啟鈕送 act、確認框原位展開（取消在左、重啟在右且是危險色）、重啟中顯示轉圈', async () => {
  const { tm } = await opened(mk())
  const tree = () => tm.view().tree
  const m = mountComponent(TaskTree, { tree: tree() })
  try {
    await settle(m)
    const btns = m.findAll('.tm-restart')
    assert.equal(btns.length, 2, 'ASN 與終端服務各一顆')
    for (const k of ['asn', 'mux']) {
      assert.equal(m.findAll(`.tm-node[data-kind="${k}"] > * .tm-viewonly, .tm-node[data-kind="${k}"] > .tm-viewonly`).length, 0, `${k} 有「重啟」就不寫「只能看」，免得矛盾`)
    }
    await m.trigger(m.find('.tm-node[data-kind="mux"] .tm-restart'), 'click')
    assert.deepEqual(m.emitted('act').at(-1), ['tm-restart-ask', MUX])
    m.unmount()
    tm.askRestart(MUX)
    const m2 = mountComponent(TaskTree, { tree: tree() })
    try {
      await settle(m2)
      const box = m2.find('.tm-node[data-kind="mux"] .asn-confirm')
      assert.ok(box, '原位展開在終端服務那一列裡')
      assert.equal(box.querySelector('.asn-confirm-text').textContent, '重啟終端服務？底下所有代理（3 個）會暫時斷線，之後會自動連回。')
      const [no, yes] = [...box.querySelectorAll('button')]
      assert.equal(no.textContent.trim(), '取消')
      assert.equal(yes.textContent.trim(), '重啟')
      assert.ok(yes.classList.contains('st-danger'))
      assert.equal(m2.find('.tm-node[data-kind="mux"] .tm-restart'), null, '確認中不再顯示原本的重啟鈕')
      const muxTitle = () => m2.find('.tm-node[data-kind="mux"] .tm-title').getAttribute('aria-expanded')
      const before = muxTitle()
      await m2.trigger(yes, 'click')
      assert.deepEqual(m2.emitted('act').at(-1), ['tm-restart-confirm', MUX])
      assert.equal(muxTitle(), before, '按確認框的「重啟」不能順帶切換那一列的小字（#2219 整列點擊）')
      await m2.trigger(no, 'click')
      assert.equal(m2.emitted('act').at(-1)[0], 'tm-restart-cancel')
      assert.equal(muxTitle(), before, '按確認框的「取消」也不能切換小字')
    } finally { m2.unmount() }
    tm.cancelRestart()
    tm.askRestart(MUX)
    void tm.confirmRestart()
    const m3 = mountComponent(TaskTree, { tree: tree() })
    try {
      await settle(m3)
      const st = m3.find('.tm-node[data-kind="mux"] .tm-restarting')
      assert.ok(st && st.classList.contains('k-busy') && st.textContent.includes('正在重啟…'))
      assert.ok(st.querySelector('.asn-spin'), '帶轉圈')
      assert.equal(m3.find('.tm-node[data-kind="mux"] .tm-restart'), null)
      const agentStops = m3.findAll('.tm-node[data-level="3"] .tm-stop')
      assert.ok(agentStops.length > 0 && agentStops.every(b => b.disabled), '底下代理的停止鈕停用')
      assert.ok(m3.container.textContent.includes('斷線中'))
    } finally { m3.unmount() }
  } finally { m.unmount() }
})

test('#1860F-3 接線：指令名、op 清單、設定值清單、文字只有一份', () => {
  assert.match(read('../ui/lib/tauri.mjs'), /taskManagerRestartAsn: \(\) => invoke\('task_manager_restart_asn'\)/)
  assert.match(read('../ui/lib/tauri.mjs'), /taskManagerRestartMux: \(\) => invoke\('task_manager_restart_mux'\)/)
  const list = read('../ui/list.js')
  for (const [op, call] of [['tm-restart-ask', 'askRestart'], ['tm-restart-cancel', 'cancelRestart'], ['tm-restart-confirm', 'confirmRestart']]) {
    assert.ok(SETTING_OPS.includes(op), op)
    assert.match(list, new RegExp(`case '${op}': .*taskMgr\\.${call}\\(`))
  }
  const lib = read('../src-tauri/src/lib.rs')
  assert.match(lib, /[\s,]task_manager_restart_asn,\s*task_manager_restart_mux[\s,]/)
  assert.ok(read('../../../docs/設定值清單.md').includes('`tm-restart-confirm`'))
  // 文字只有 task-tree.mjs 一份：畫面元件與控制器都不另寫
  for (const f of ['../ui/lib/task-tree-view.mjs', '../ui/lib/task-manager.mjs', '../ui/list.js', '../ui/m.js']) {
    const s = read(f).split('\n').map(l => l.replace(/\s\/\/.*$/, '')).filter(l => !l.trim().startsWith('//')).join('\n')   // 註解不算畫面上的字
    assert.ok(!s.includes('會暫時斷線') && !s.includes('正在重啟…'), `${f} 不另寫重啟的字`)
  }
  assert.equal(TREE_TEXT.restarting, '正在重啟…')
})

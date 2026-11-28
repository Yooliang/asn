// #2470：重啟終端服務後，工作管理員的「接回了沒」和通知頁出自同一份結果（電腦端 restart_result），不再自己算逾時。
// 真資料：冒煙腳本 taskmgrSnapshot 的形狀，再加一列終端類的列和一位開窗失敗、沒寫進對照表的孤兒夥伴「島作」。
import test from 'node:test'
import assert from 'node:assert/strict'
import { createTaskManager, initialState } from '../ui/lib/task-manager.mjs'
import { muxKey } from '../ui/lib/task-tree.mjs'
import { taskmgrSnapshot } from '../scripts/smoke-lib.mjs'

const NOW = 1_800_000_000_000
const SELF = 'P'
const OPS = { signedIn: true, loaded: true, checking: false, machines: { [SELF]: { online: true, launcher: { profiles: [] } } } }
const MUX = muxKey(6000)
const tick = () => new Promise(r => setTimeout(r, 5))

const row = (kind, name, pid) => ({ kind, name, engine: 'claude', pid, memory_bytes: null, started_ms: NOW, status: 'idle', detail: null, by_asn: true, cwd: '', session_id: null, term_id: null, live: true, inside: null, mux_pid: 6000 })
// 重啟前：終端服務底下有 3 位夥伴、1 列終端類、1 位孤兒夥伴
const before = (extra = {}) => { const s = taskmgrSnapshot(NOW); return { ...s, rows: [...s.rows, row('terminal', '終端設定名', 9001), row('claude', '島作', 9002)], ...extra } }
// 重啟後清單上只剩 ASN 與新的終端服務（接回還沒反映在清單上，舊的判斷會等到逾時）
const after = (extra = {}) => { const s = taskmgrSnapshot(NOW); return { ...s, rows: s.rows.filter(r => r.kind === 'asn' || r.kind === 'mux'), ...extra } }

async function restart({ first = before(), next, logs = [] }) {
  const snap = { current: first }
  const clock = { t: NOW }
  let release
  const tm = createTaskManager({
    api: { taskManagerList: async () => snap.current, taskManagerRestartAsn: async () => {}, taskManagerRestartMux: () => new Promise(r => { release = r }) },
    getFriends: () => [], getSelfNode: () => SELF, getOpsCtx: () => OPS, now: () => clock.t,
    setTimer: () => 1, clearTimer: () => {}, state: initialState(), log: m => logs.push(m),
  })
  tm.open(); await tick()
  tm.askRestart(MUX)
  const p = tm.confirmRestart()
  snap.current = next
  release()
  await p
  return { tm, snap, clock, logs }
}

test('#2470 接回結果完成、沒有沒接回的：不報逾時；不在接回名單的夥伴明列「無法接回」，終端類的列不算', async () => {
  const done = { id: 11, state: 'done', resumed: ['asn真', '小東', '小乙'], failed: [] }
  const o = await restart({ next: after({ restart_result: done }) })
  assert.equal(o.tm.state.restart, null, '結果完成就放掉，不用等 90 秒')
  assert.ok(!o.logs.some(l => l.includes('逾時')), '不報逾時')
  const err = o.tm.view().tree.root.restart.error
  assert.ok(err.includes('「島作」不在 ASN 的記錄裡，無法接回'), err)
  assert.ok(!err.includes('終端設定名'), '終端類的列不是夥伴，不列')
  assert.ok(!err.includes('asn真') && !err.includes('小東'), '接回了的不列')
  assert.ok(o.logs.some(l => l.includes('島作')), '名字也寫 log')
})

test('#2470 全部接回、凍結的都在名單裡：不報錯也不報逾時', async () => {
  const s = taskmgrSnapshot(NOW)
  const done = { id: 12, state: 'done', resumed: ['asn真', '小東', '小乙'], failed: [] }
  const o = await restart({ first: s, next: after({ restart_result: done }) })
  assert.equal(o.tm.state.restart, null)
  assert.equal(o.tm.view().tree.root.restart.error, '')
  assert.ok(!o.logs.some(l => l.includes('逾時')))
})

test('#2470 結果有沒接回的「乙」：畫面與 log 都講出名字和原因', async () => {
  const reason = '視窗開了，但一直沒看到它上線，可能停在確認畫面，請到它的視窗看一下'
  const res = { id: 13, state: 'done', resumed: ['asn真', '小東'], failed: [{ name: '乙', reason }] }
  const o = await restart({ first: taskmgrSnapshot(NOW), next: after({ restart_result: res }) })
  assert.equal(o.tm.state.restart, null)
  const err = o.tm.view().tree.root.restart.error
  assert.ok(err.includes('「乙」') && err.includes(reason), err)
  assert.ok(o.logs.some(l => l.includes('乙') && l.includes(reason)))
  assert.ok(!o.logs.some(l => l.includes('逾時')))
})

test('#2470 結果還在接回中：繼續標斷線中，不提早放掉；超過時間才放掉並寫 log', async () => {
  const run = { id: 14, state: 'running', resumed: ['asn真'], failed: [] }
  const o = await restart({ first: taskmgrSnapshot(NOW), next: after({ restart_result: run }) })
  assert.equal(o.tm.state.restart, 'mux:*')
  o.clock.t = NOW + 90_000
  await o.tm.refresh()
  assert.equal(o.tm.state.restart, null)
  assert.ok(o.logs.some(l => l.includes('逾時')))
})

test('#2470 上一次留下的結果（識別沒變）不算這一次', async () => {
  const old = { id: 5, state: 'done', resumed: [], failed: [] }
  // 重啟前清單已經帶著同一識別的舊結果：照舊判斷（清單只剩一部分，繼續等）
  const o = await restart({ first: { ...taskmgrSnapshot(NOW), restart_result: old }, next: after({ restart_result: old }) })
  assert.equal(o.tm.state.restart, 'mux:*', '舊結果不能讓畫面提早放掉')
})

test('#2470 電腦端沒有給結果（舊版）：照舊自己判斷，逾時寫 log', async () => {
  const o = await restart({ first: taskmgrSnapshot(NOW), next: after() })
  assert.equal(o.tm.state.restart, 'mux:*', '名單沒回齊、還沒逾時：繼續等')
  o.clock.t = NOW + 90_000
  await o.tm.refresh()
  assert.equal(o.tm.state.restart, null)
  assert.ok(o.logs.some(l => l.includes('逾時，部分代理還沒接回')))
})

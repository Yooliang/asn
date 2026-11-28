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
// 終端列的名字刻意取成像夥伴的名字：只有「是終端類」才該被排除，不能靠名字看起來像不像
const TERM_NAME = '小明'
const before = (extra = {}) => { const s = taskmgrSnapshot(NOW); return { ...s, rows: [...s.rows, row('terminal', TERM_NAME, 9001), row('claude', '島作', 9002)], ...extra } }
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
  assert.equal(err, '「島作」不在 ASN 的記錄裡，無法接回。', '只有孤兒夥伴一句；終端類的列（畫面上叫「某某 終端」）不是夥伴，不列')
  assert.ok(!err.includes(TERM_NAME) && !err.includes('終端'))
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

test('#2470 沒接回的「乙」同時在重啟前那一組裡：只列一次（沒接回），不再被當孤兒重複列', async () => {
  const reason = '視窗開了，但一直沒看到它上線'
  const first = { ...taskmgrSnapshot(NOW), rows: [...taskmgrSnapshot(NOW).rows, row('claude', '乙', 9003)] }
  const res = { id: 15, state: 'done', resumed: ['asn真', '小東', '小乙'], failed: [{ name: '乙', reason }] }
  const o = await restart({ first, next: after({ restart_result: res }) })
  const err = o.tm.view().tree.root.restart.error
  assert.equal(err.split('「乙」').length - 1, 1, err)
  assert.ok(err.includes(`「乙」沒有接回：${reason}`) && !err.includes('不在 ASN 的記錄裡'), err)
})

test('#2470 沒有重開的夥伴（已經開著、別條路正在開、本人封存）不當孤兒', async () => {
  const res = {
    id: 16, state: 'done', resumed: ['asn真'], failed: [],
    skipped: [{ name: '小東', reason: '已經開著' }, { name: '小乙', reason: '正在由別的地方開' }],
  }
  const o = await restart({ first: taskmgrSnapshot(NOW), next: after({ restart_result: res }) })
  assert.equal(o.tm.state.restart, null)
  assert.equal(o.tm.view().tree.root.restart.error, '', '沒有重開不是錯，畫面不講')
  assert.ok(!o.logs.some(l => l.includes('不在 ASN')))
  // 對照：同樣的凍結列，沒有 skipped 欄（舊的結果檔）時才會列成孤兒
  const o2 = await restart({ first: taskmgrSnapshot(NOW), next: after({ restart_result: { ...res, skipped: undefined } }) })
  const err = o2.tm.view().tree.root.restart.error
  assert.ok(err.includes('「小東」不在 ASN 的記錄裡，無法接回') && err.includes('「小乙」'), err)
})

test('#2470 完成晚於 90 秒（開了卻沒上線的夥伴要等滿 90 秒才寫完）：畫面照樣講出沒接回的名字與原因，log 也寫', async () => {
  const reason = '視窗開了，但一直沒看到它上線，可能停在確認畫面，請到它的視窗看一下'
  const o = await restart({ first: taskmgrSnapshot(NOW), next: after({ restart_result: { id: 20, state: 'running', resumed: ['asn真', '小乙'], failed: [] } }) })
  o.clock.t = NOW + 90_000
  await o.tm.refresh()
  assert.equal(o.tm.state.restart, null, '90 秒到了畫面先放掉')
  assert.equal(o.tm.view().tree.root.restart.error, '', '這時結果還沒寫完，沒有可講的')
  // 放掉之後再讀一次同一識別、仍在接回中的清單（已有一位記成沒接回）：還沒做完，不能提早講，也不能把盯梢清掉
  o.snap.current = after({ restart_result: { id: 20, state: 'running', resumed: ['asn真', '小乙'], failed: [{ name: '小東', reason }] } })
  o.clock.t = NOW + 95_000
  o.logs.length = 0
  await o.tm.refresh()
  assert.equal(o.tm.view().tree.root.restart.error, '', '接回還在做，不等完成就講會在這裡紅')
  assert.ok(!o.logs.some(l => l.includes('小東')), '還沒做完，log 也不寫名字')
  // 100 秒後結果才完成
  o.snap.current = after({ restart_result: { id: 20, state: 'done', resumed: ['asn真', '小乙'], failed: [{ name: '小東', reason }] } })
  o.clock.t = NOW + 100_000
  await o.tm.refresh()
  const err = o.tm.view().tree.root.restart.error
  assert.ok(err.includes('「小東」') && err.includes(reason), err)
  assert.ok(o.logs.some(l => l.includes('小東') && l.includes(reason)), '名字與原因也寫 log')
  // 只講一次：再讀一次清單不重複，也不會留到下一次重啟之後
  o.logs.length = 0
  await o.tm.refresh()
  assert.ok(!o.logs.some(l => l.includes('小東')))
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

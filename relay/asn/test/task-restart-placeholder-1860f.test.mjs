// #1860 F PR3 西川複看 R1：佔位組（終端服務沒在跑）重啟時，底下沒有代理可記，「重啟中」要等存下名單裡的代理都接回才放掉；
// 不能因為 want 是空的就恆真、一出現服務列就太早解除。
import test from 'node:test'
import assert from 'node:assert/strict'
import { muxKey } from '../ui/lib/task-tree.mjs'
import { createTaskManager, initialState } from '../ui/lib/task-manager.mjs'
import { taskmgrSnapshot } from '../scripts/smoke-lib.mjs'

const NOW = 1_800_000_000_000
const SELF = 'P'
const OPS = { signedIn: true, loaded: true, checking: false, machines: { [SELF]: { online: true, launcher: { profiles: [] } } } }
const PLACEHOLDER = muxKey('none')
const tick = () => new Promise(r => setTimeout(r, 5))

const noMux = (extra = {}) => {
  const s = taskmgrSnapshot(NOW)
  return { ...s, rows: s.rows.filter(r => r.kind !== 'mux').map(r => ({ ...r, mux_pid: null })), mux_expected: true, ...extra }
}
// 新服務起來了，但只接回其中一位（名單裡有 asn真、小東）
const partlyBack = () => {
  const s = taskmgrSnapshot(NOW)
  return { ...s, rows: s.rows.filter(r => !(r.mux_pid === 6000 && r.name !== 'asn真')) }
}

function mk(snapshot) {
  const snap = { current: snapshot }
  const clock = { t: NOW }
  const logs = []
  const tm = createTaskManager({
    api: { taskManagerList: async () => snap.current, taskManagerRestartAsn: async () => {}, taskManagerRestartMux: async () => {} },
    getFriends: () => [], getSelfNode: () => SELF, getOpsCtx: () => OPS, now: () => clock.t,
    setTimer: () => 1, clearTimer: () => {}, state: initialState(), confirmPrefix: undefined, log: m => logs.push(m),
  })
  return { tm, snap, clock, logs }
}
const opened = async o => { o.tm.open(); await tick(); return o }

test('#1860F-3 R1 佔位組重啟：新服務出現但名單裡的代理沒回齊，還是「重啟中」；回齊才放掉', async () => {
  const o = await opened(mk(noMux({ restart_pending: 2, restart_pending_names: ['asn真', '小東'] })))
  o.tm.askRestart(PLACEHOLDER)
  await o.tm.confirmRestart()
  assert.equal(o.tm.state.restart, 'mux:*', '剛重啟完還沒回來')
  assert.deepEqual(o.tm.state.restartWant, ['asn真', '小東'], '等的是存下名單的人')
  o.snap.current = partlyBack()
  await o.tm.refresh()
  assert.equal(o.tm.state.restart, 'mux:*', '服務列有了、但小東還沒接回：不能放掉')
  o.snap.current = taskmgrSnapshot(NOW)
  await o.tm.refresh()
  assert.equal(o.tm.state.restart, null, '名單都回來了才放掉')
  assert.equal(o.tm.state.restartWant, null)
})

test('#1860F-3 R1 佔位組重啟：逾時還沒回齊就放掉並寫 log', async () => {
  const o = await opened(mk(noMux({ restart_pending: 2, restart_pending_names: ['asn真', '小東'] })))
  o.tm.askRestart(PLACEHOLDER)
  await o.tm.confirmRestart()
  o.snap.current = partlyBack()
  o.clock.t = NOW + 10 * 60_000
  await o.tm.refresh()
  assert.equal(o.tm.state.restart, null)
  assert.ok(o.logs.some(l => l.includes('逾時')))
})

test('#1860F-3 R1 舊版電腦端沒給名單：至少等到真的服務列出現才放掉（沒有服務列不放）', async () => {
  const o = await opened(mk(noMux({ restart_pending: 2 })))
  o.tm.askRestart(PLACEHOLDER)
  await o.tm.confirmRestart()
  assert.deepEqual(o.tm.state.restartWant, [])
  await o.tm.refresh()
  assert.equal(o.tm.state.restart, 'mux:*', '清單上還沒有服務列：不放')
  o.snap.current = taskmgrSnapshot(NOW)
  await o.tm.refresh()
  assert.equal(o.tm.state.restart, null)
})

test('#1860F-3 R1 一般終端服務重啟（不是佔位）仍用按下時那一組的代理當名單', async () => {
  const o = await opened(mk(taskmgrSnapshot(NOW)))
  o.tm.askRestart(muxKey(6000))
  await o.tm.confirmRestart()
  assert.equal(o.tm.state.restartWant, null, '非佔位不用存下名單')
})

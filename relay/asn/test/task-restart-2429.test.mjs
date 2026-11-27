// 2429 三審：重啟終端服務時，核對遇到服務沒有回應 → 電腦端回一句話，畫面問本人再確認一次，確認後帶 confirmed=true 再呼叫。
import test from 'node:test'
import assert from 'node:assert/strict'
import { muxKey } from '../ui/lib/task-tree.mjs'
import { createTaskManager, initialState } from '../ui/lib/task-manager.mjs'
import { taskmgrSnapshot } from '../scripts/smoke-lib.mjs'

const NOW = 1_800_000_000_000
const SELF = 'P'
const OPS = { signedIn: true, loaded: true, checking: false, machines: { [SELF]: { online: true, launcher: { profiles: [] } } } }
const MUX = muxKey(6000)
const NEED = '終端服務沒有回應，數不出裡面的視窗；仍要重啟的話，沒記錄的視窗也會一起關掉。'
const tick = () => new Promise(r => setTimeout(r, 5))

async function mk(restartMux) {
  const snap = taskmgrSnapshot(NOW)
  const tm = createTaskManager({
    api: { taskManagerList: async () => snap, taskManagerRestartAsn: async () => {}, taskManagerRestartMux: restartMux },
    getFriends: () => [], getSelfNode: () => SELF, getOpsCtx: () => OPS, now: () => NOW,
    setTimer: () => 1, clearTimer: () => {}, state: initialState(), log: () => {},
  })
  tm.open()
  await tick()
  return tm
}

test('#2429 終端服務沒有回應：第一次按回一句話→確認框換成那句話、不顯示重啟中；再按一次才帶確認呼叫', async () => {
  const seen = []
  const tm = await mk(async confirmed => { seen.push(confirmed); return confirmed ? null : NEED })
  tm.askRestart(MUX)
  await tm.confirmRestart()
  assert.deepEqual(seen, [false], '第一次不帶確認')
  const g = () => tm.view().tree.groups.find(x => x.key === MUX)
  assert.equal(g().restart.ask, NEED, '確認框換成電腦端給的那句話')
  assert.equal(g().restart.busy, false, '還沒重啟，不顯示正在重啟')
  assert.equal(tm.state.restart, null)
  await tm.confirmRestart()
  assert.deepEqual(seen, [false, true], '本人再按一次，帶確認呼叫')
  assert.equal(g().restart.ask, '', '確認完框收起')
})

test('#2429 終端服務沒有回應的確認框取消後，重新按重啟又從一般確認開始、不帶確認', async () => {
  const seen = []
  const tm = await mk(async confirmed => { seen.push(confirmed); return confirmed ? null : NEED })
  tm.askRestart(MUX); await tm.confirmRestart()
  tm.cancelRestart()
  tm.askRestart(MUX); await tm.confirmRestart()
  assert.deepEqual(seen, [false, false], '取消後重按，仍是第一次')
})

test('#2429 一般重啟（電腦端回空）不會跳第二段確認', async () => {
  const seen = []
  const tm = await mk(async confirmed => { seen.push(confirmed); return null })
  tm.askRestart(MUX); await tm.confirmRestart()
  assert.deepEqual(seen, [false])
  assert.equal(tm.state.restartNeed, null)
})

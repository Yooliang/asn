// #2462：已停止的背景工作者，列名單時的「試著喚回」不能再把它暖機起來；另補「啟動中被停止、又馬上啟動」。
// 用假驅動（不開真的 AI 工具）。執行：node --test relay/machine/test/acp-no-revive-after-stop.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { WorkerError } from '../engines/acp-errors.mjs'
import { createWorker } from '../engines/acp-worker.mjs'
import { workerSpecFromProfile } from '../partner-background.mjs'

const GROK = { command: 'grok', model: 'grok', label: 'Grok', acp: { protocol: 'acp', roster_engine: 'grok' } }

// failSpawn：start 直接回「起不來」；hold：start 先卡住，要等 release()
function rig({ failSpawn = false, hold = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'asn-2462-'))
  const home = path.join(dir, 'home')
  fs.mkdirSync(home, { recursive: true })
  const cfg = workerSpecFromProfile({ name: 'W', cwd: path.join(dir, 'cwd'), profile: GROK, workDir: dir })
  let t = 1_000_000
  const made = []
  const fails = []
  let holdNext = hold
  const makeDriver = args => {
    let release
    const gate = holdNext ? new Promise(r => { release = r }) : Promise.resolve()
    const d = {
      id: `d${made.length + 1}`, stopped: false, up: true, release: () => release?.(),
      onExit() {}, resumeLost: () => false, alive: () => d.up, touch() {}, sessionId: () => d.id, fullAccess: args.fullAccess,
      async start() { await gate; if (failSpawn) throw new WorkerError('crash', '測試：起不來', { spawnFailed: true }) },
      stop() { d.stopped = true; d.up = false },
    }
    made.push(d)
    return d
  }
  const w = createWorker({
    cfg, env: { USERPROFILE: home, HOME: home }, log: () => {}, now: () => t,
    handlers: { onFail: (id, why) => fails.push([id, why]) }, approvals: { cancelAll() {} }, notify: async () => { fails.push(['notify']) },
    store: { get: () => '', set() {}, clear() {} }, makeDriver, realHome: home, workDir: dir,
  })
  return { w, made, fails, later: ms => { t += ms }, holdNext: v => { holdNext = v } }
}
const settle = () => new Promise(r => setTimeout(r, 60))

async function unavailableAndRevivable(r) {
  r.w.start()
  await settle()
  assert.equal(r.w.health().health, 'unavailable')
  assert.equal(r.made.length, 1)
  r.later(120_000)
  r.w.maybeRevive()
  await settle()
  assert.equal(r.made.length, 2, '對照：沒停止時超過重試間隔，喚回要再試一次')
}

test('已 stop 的工作者：健康狀態不可用、超過重試間隔後 maybeRevive 不會再建驅動', async () => {
  const r = rig({ failSpawn: true })
  await unavailableAndRevivable(r)
  r.w.stop()
  r.later(120_000)
  r.w.maybeRevive()
  await settle()
  assert.equal(r.made.length, 2, '已停止：不能再建新的驅動')
})

test('啟動中被停止、又馬上啟動：第一支被停掉不留下，第二支正常成為目前的驅動，沒有失敗通知', async () => {
  const r = rig({ hold: true })
  r.w.start()
  await settle()
  assert.equal(r.made.length, 1, '第一支驅動開始啟動（卡住）')
  r.w.stop()
  r.holdNext(false)
  r.w.start()
  r.made[0].release()
  await settle()
  assert.equal(r.made.length, 2, '第二支驅動要建出來')
  assert.equal(r.made[0].stopped, true, '第一支要被停掉')
  assert.equal(r.made[1].stopped, false, '第二支沒被停')
  assert.equal(r.w.health().health, 'ok', '健康狀態不變')
  assert.deepEqual(r.fails, [], '沒有失敗通知')
  assert.equal(r.w.status(), 'idle')
})

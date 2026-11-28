// #2422：工作者 start() 之後工作者還在啟動、就被 stop()，啟動中的驅動也要被停掉，啟動完成後不能留下行程。
// 用真的 createWorker 加假驅動（假行程旗標：start 時活、stop 時死），不碰真的 AI、不開真的行程。
// 執行：node --test relay/machine/test/acp-stop-during-start.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createWorker } from '../engines/acp-worker.mjs'
import { workerSpecFromProfile } from '../partner-background.mjs'

const GEMINI = { command: 'agy', model: 'gemini', label: 'Gemini', acp: { protocol: 'agy-stream', roster_engine: 'gemini' } }

function rig() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'asn-2422-'))
  const home = path.join(dir, 'home')
  const work = path.join(home, '.asn', 'machine-T')
  const own = path.join(work, 'workers', '甲')
  fs.mkdirSync(own, { recursive: true })
  const spec = workerSpecFromProfile({ name: '甲', cwd: own, profile: GEMINI, workDir: work })
  const logs = []
  const sent = []
  const drivers = []
  const makeDriver = () => {
    let release
    const d = {
      procAlive: false,
      started: new Promise(r => { release = r }),
      finishStart: () => release(),
      onExit() {}, resumeLost: () => false, touch() {}, alive: () => d.procAlive,
      start() { d.procAlive = true; return d.started },   // 真驅動也是呼叫 start 就立刻開行程，之後才等「起來了」
      stop() { d.procAlive = false },
    }
    drivers.push(d)
    return d
  }
  const w = createWorker({
    cfg: spec, env: { USERPROFILE: home, HOME: home }, log: m => logs.push(m),
    handlers: { onSent() {}, onFail: (id, t) => sent.push(t), onReply() {} }, approvals: { cancelAll() {} },
    notify: async m => { sent.push(m) }, store: { get: () => '', set() {}, clear() {} }, makeDriver, realHome: home, workDir: work,
  })
  return { w, drivers, logs, sent }
}
const settle = () => new Promise(r => setImmediate(r))

test('工作者還在啟動就被停止：啟動中的行程立刻停掉，啟動完成後也不會留下', async () => {
  const { w, drivers, logs, sent } = rig()
  w.start()
  assert.equal(drivers.length, 1)
  assert.equal(drivers[0].procAlive, true, '啟動中行程已經開了')
  w.stop()
  assert.equal(drivers[0].procAlive, false, '停止時啟動中的行程要一併停掉')
  drivers[0].finishStart()
  for (let i = 0; i < 5; i += 1) await settle()
  assert.equal(drivers[0].procAlive, false, '啟動完成後行程不能復活或殘留')
  assert.equal(w.health().health, 'ok', '被停止不算工作者壞掉')
  assert.deepEqual(sent, [], '被停止不寄任何失敗或狀態通知')
  assert.ok(!logs.some(l => l.includes('狀態')), `不該有狀態變更：${logs}`)
})

test('啟動完成時才發現已被停止（停止時行程還沒開起來）：把它停掉，不指給工作者', async () => {
  const { w, drivers } = rig()
  w.start()
  w.stop()
  drivers[0].procAlive = true   // 模擬停止當下行程還沒開出來、停不到，之後才起來
  drivers[0].finishStart()
  for (let i = 0; i < 5; i += 1) await settle()
  assert.equal(drivers[0].procAlive, false, '啟動完成後發現已被停止，要自己把行程停掉')
})

test('沒有被停止時：啟動完成照常留著，不受影響', async () => {
  const { w, drivers } = rig()
  w.start()
  drivers[0].finishStart()
  for (let i = 0; i < 5; i += 1) await settle()
  assert.equal(drivers[0].procAlive, true)
  assert.equal(w.health().health, 'ok')
  w.stop()
  assert.equal(drivers[0].procAlive, false)
})

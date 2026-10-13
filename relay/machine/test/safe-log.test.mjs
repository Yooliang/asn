// 橋的記錄（safe-log.mjs）：主控台寫不出去不會進無限迴圈、不重入、檔案有上限會輪替、重複的話只記一次。
// 2026-10-13：stderr 壞掉後 console.error 丟例外 → uncaughtException 又記錄 → 又丟例外，bridge.log 一天長到 181 GB。
// 執行：node --test relay/machine/test/
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { Writable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { createLog } from '../safe-log.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'irori-safelog-test-'))
const tick = () => new Promise(r => setImmediate(r))
const lines = f => fs.readFileSync(f, 'utf8').trim().split('\n')

test('重現事故：舊的寫法會無限迴圈、記錄檔一直長；createLog 記一次就停', () => {
  const d = tmp()
  try {
    const run = mode => {
      const f = path.join(d, mode + '.log')
      spawnSync(process.execPath, [path.join(here, 'fake-log-loop.mjs'), mode, f], { timeout: 10_000 })
      return fs.statSync(f).size
    }
    const naive = run('naive'), safe = run('safe')
    assert.ok(naive > 100_000, `舊的寫法 1.5 秒就寫了 ${naive} bytes（無限迴圈）`)
    assert.ok(safe < 2_000, `createLog 只寫了 ${safe} bytes`)
  } finally { fs.rmSync(d, { recursive: true, force: true }) }
})

test('主控台非同步出錯（EPIPE）：不變成 uncaughtException，之後只寫檔', async () => {
  const d = tmp(), f = path.join(d, 'b.log')
  try {
    let writes = 0
    const broken = new Writable({ write(_c, _e, cb) { writes++; const e = new Error('EPIPE'); e.code = 'EPIPE'; process.nextTick(() => cb(e)) } })
    const log = createLog(f, { stderr: broken })
    log('一')
    await tick(); await tick()
    assert.equal(log.stderrAlive(), false, '主控台壞了就不再寫')
    log('二')
    assert.equal(writes, 1)
    assert.deepEqual(lines(f).map(l => l.split(' ').slice(1).join(' ')), ['一', '二'])
  } finally { fs.rmSync(d, { recursive: true, force: true }) }
})

test('主控台同步丟例外、或寫主控台時又呼叫 log：都不會往外丟、不遞迴', () => {
  const d = tmp(), f = path.join(d, 'b.log')
  try {
    let log
    let depth = 0
    const reentrant = { write() { depth++; log('在寫主控台的時候又要記錄'); throw new Error('stderr closed') }, on() {} }
    log = createLog(f, { stderr: reentrant })
    assert.doesNotThrow(() => log('開始'))
    assert.equal(depth, 1, '不遞迴')
    assert.equal(log.stderrAlive(), false)
    assert.deepEqual(lines(f).map(l => l.split(' ').slice(1).join(' ')), ['開始'])
  } finally { fs.rmSync(d, { recursive: true, force: true }) }
})

test('檔案有上限：超過就輪替成 .1；同一句話連續重複只記一次', () => {
  const d = tmp(), f = path.join(d, 'b.log')
  try {
    const log = createLog(f, { stderr: null, maxBytes: 2_000 })
    for (let i = 0; i < 200; i++) log(`第 ${i} 句`)
    assert.ok(fs.statSync(f).size <= 2_000, '目前的檔不超過上限')
    assert.ok(fs.existsSync(f + '.1'), '舊的輪替成 .1')
    assert.ok(fs.statSync(f + '.1').size <= 2_000)
    const g = path.join(d, 'r.log')
    const r = createLog(g, { stderr: null })
    for (let i = 0; i < 10_000; i++) r('uncaught: Error: write EPIPE')
    r('好了')
    const out = lines(g)
    assert.equal(out.length, 3, '重複的一句、重複幾次、下一句')
    assert.match(out[1], /重複了 9999 次/)
  } finally { fs.rmSync(d, { recursive: true, force: true }) }
})

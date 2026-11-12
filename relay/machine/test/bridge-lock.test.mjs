// bridge.pid 單一實例鎖（#1373）：bridge.pid 只記編號（格式不變）；編號活著但那個程序比 bridge.pid 的寫入時間晚啟動（寬限 5 秒）
// ＝編號被回收，當殘留檔覆寫。規則同 installer/asn-common.ps1 的 Get-RecordedProcess。
// 只 kill 測試自己 spawn、自己記下 PID 的子程序。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnTracked } from './spawn-tracked.mjs'
import { acquireLock, lockHolder, lockOwnedBy, lockPidAlive, parsePid, processStartMs } from '../bridge-lock.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const MACHINE = path.join(here, '..')
const sleep = ms => new Promise(r => setTimeout(r, ms))

// 一個活著、但不是橋的程序
async function idleChild() {
  const child = spawnTracked(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true })
  await new Promise((r, j) => { child.once('spawn', r); child.once('error', j) })
  return child
}
const stopChild = async child => { if (child.exitCode === null && child.signalCode === null) { const gone = new Promise(r => child.once('exit', r)); child.kill(); await gone } }
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'asn-lock-test-'))
const rm = dir => fs.rmSync(dir, { recursive: true, force: true })
// 寫 bridge.pid，並把寫入時間設到過去：之後才啟動（或早就啟動、但編號在這之後才被拿去用）的程序都會「比寫入時間晚」
const writeOld = (lock, pid, agoMs = 60_000) => { fs.writeFileSync(lock, String(pid)); const t = new Date(Date.now() - agoMs); fs.utimesSync(lock, t, t) }

test('parsePid：正常內容與壞掉的內容', () => {
  assert.equal(parsePid('4567'), 4567); assert.equal(parsePid('4567\r\n'), 4567)
  for (const bad of ['', 'garbage', '0', '12abc', '{"pid":1}', '-3', null]) assert.equal(parsePid(bad), null, String(bad))
})

test('processStartMs：自己與子程序的啟動時間是 epoch 毫秒、合理且子程序較晚；不存在的編號回 null', async () => {
  const t0 = Date.now(), child = await idleChild()
  try {
    const self = await processStartMs(process.pid), kid = await processStartMs(child.pid)
    assert.ok(Number.isFinite(self) && self <= Date.now() + 2000 && self > Date.now() - 24 * 3600_000, `self=${self}`)
    assert.ok(Number.isFinite(kid) && Math.abs(kid - t0) < 5000, `child=${kid} t0=${t0}`)
    assert.ok(kid >= self - 2000)
  } finally { await stopChild(child) }
  assert.equal(await processStartMs(child.pid), null)
})

test('lockHolder：編號被一個在 bridge.pid 寫入之後才啟動的程序佔用 → 殘留檔；程序比寫入時間早 → 視為橋在跑', async () => {
  const dir = tmpDir(), lock = path.join(dir, 'bridge.pid'), child = await idleChild()
  try {
    writeOld(lock, child.pid)                                   // 寫入時間在 60 秒前，子程序剛啟動
    assert.equal(await lockHolder(lock), null)
    fs.writeFileSync(lock, String(child.pid))                   // 子程序啟動之後才寫：真的是它寫的
    assert.equal(await lockHolder(lock), child.pid)
  } finally { await stopChild(child); rm(dir) }
})

test('lockHolder：查不到啟動時間（失敗、丟例外）→ 保守當作在跑；壞檔／死編號／自己／沒檔 → 不擋', async () => {
  const dir = tmpDir(), lock = path.join(dir, 'bridge.pid'), child = await idleChild()
  try {
    writeOld(lock, child.pid)
    assert.equal(await lockHolder(lock, { startMs: async () => null }), child.pid)
    assert.equal(await lockHolder(lock, { startMs: async () => { throw new Error('boom') } }), child.pid)
    fs.writeFileSync(lock, 'garbage'); assert.equal(await lockHolder(lock), null)
    fs.writeFileSync(lock, String(process.pid)); assert.equal(await lockHolder(lock), null)
    assert.equal(await lockHolder(path.join(dir, 'missing.pid')), null)
  } finally { await stopChild(child) }
  fs.writeFileSync(lock, String(child.pid)); assert.equal(await lockHolder(lock), null)   // 程序已結束
  rm(dir)
})

test('lockHolder：查詢不回應時不會卡超過上限，並保守當作在跑', async () => {
  const dir = tmpDir(), lock = path.join(dir, 'bridge.pid'), child = await idleChild()
  try {
    writeOld(lock, child.pid)
    const t0 = Date.now()
    assert.equal(await lockHolder(lock, { startMs: () => new Promise(() => {}), timeoutMs: 300 }), child.pid)
    assert.ok(Date.now() - t0 < 2000, `took ${Date.now() - t0}ms`)
  } finally { await stopChild(child); rm(dir) }
})

test('acquireLock：殘留檔覆寫成自己；真的有人在跑就拒絕且不動檔案', async () => {
  const dir = tmpDir(), lock = path.join(dir, 'bridge.pid'), child = await idleChild()
  try {
    writeOld(lock, child.pid)
    assert.deepEqual(await acquireLock(lock, 999_999_001), { ok: true })
    assert.equal(fs.readFileSync(lock, 'utf8'), '999999001')
    fs.writeFileSync(lock, String(child.pid))
    assert.deepEqual(await acquireLock(lock, 999_999_001), { ok: false, pid: child.pid })
    assert.equal(fs.readFileSync(lock, 'utf8'), String(child.pid))
  } finally { await stopChild(child); rm(dir) }
})

test('acquireLock：判定完、建立前被別的橋搶先寫入（wx 失敗）→ 重新判斷，判定對方在跑就拒絕，不覆寫', async () => {
  const dir = tmpDir(), lock = path.join(dir, 'bridge.pid'), rival = await idleChild()
  try {
    let calls = 0
    const beforeCreate = () => { if (calls++ === 0) fs.writeFileSync(lock, String(rival.pid)) }   // 對方剛寫入（mtime 比它啟動晚）
    assert.deepEqual(await acquireLock(lock, 999_999_002, { beforeCreate }), { ok: false, pid: rival.pid })
    assert.equal(fs.readFileSync(lock, 'utf8'), String(rival.pid))
    assert.equal(calls, 1)
  } finally { await stopChild(rival); rm(dir) }
})

test('lockOwnedBy／lockPidAlive：只看檔案裡的編號', async () => {
  const dir = tmpDir(), lock = path.join(dir, 'bridge.pid')
  try {
    fs.writeFileSync(lock, String(process.pid))
    assert.equal(lockOwnedBy(lock, process.pid), true); assert.equal(lockPidAlive(lock), true)
    fs.writeFileSync(lock, String(process.pid + 1)); assert.equal(lockOwnedBy(lock, process.pid), false)
    fs.writeFileSync(lock, 'garbage'); assert.equal(lockOwnedBy(lock, process.pid), false); assert.equal(lockPidAlive(lock), false)
  } finally { rm(dir) }
})

test('machineNode（寄信路徑）只看編號是否存活，不叫任何子程序', async () => {
  const home = tmpDir()
  try {
    for (const id of ['T', 'X']) fs.mkdirSync(path.join(home, '.asn', `machine-${id}`), { recursive: true })
    fs.writeFileSync(path.join(home, '.asn', 'machine-T', 'bridge.pid'), String(process.pid))   // 活著的編號（測試程序自己）
    // 子程序裡把 child_process 的所有函式換成「被叫就記一筆」，再呼叫 machineNode
    const script = `
      import { createRequire, syncBuiltinESMExports } from 'node:module'
      const cp = createRequire(import.meta.url)('node:child_process')
      let calls = []
      for (const k of ['exec', 'execFile', 'execFileSync', 'execSync', 'fork', 'spawn', 'spawnSync']) cp[k] = (...a) => { calls.push(k); throw new Error('no subprocess allowed') }
      syncBuiltinESMExports()
      const { machineNode } = await import(${JSON.stringify(new URL('../identity.mjs', import.meta.url).href)})
      let node = null; try { node = machineNode() } catch (e) { node = 'ERR ' + e.message }
      process.stdout.write(JSON.stringify({ node, calls }))`
    const child = spawnTracked(process.execPath, ['--input-type=module', '-e', script], {
      stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
      env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, HOME: home, USERPROFILE: home },
    })
    let out = '', err = ''
    child.stdout.on('data', d => out += d); child.stderr.on('data', d => err += d)
    await new Promise(r => child.once('exit', r))
    const r = JSON.parse(out || 'null')
    assert.ok(r, err)
    assert.equal(r.node, 'T')
    assert.deepEqual(r.calls, [])
  } finally { rm(home) }
})

// ---- 真的起橋 ------------------------------------------------------------------------------------
async function fakeServer() {
  const srv = http.createServer((req, res) => {
    const a = new URL(req.url, 'http://x').searchParams.get('action')
    req.resume()
    const out = obj => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)) }
    if (a === 'whoami') return out({ node: 'T', bell_topic: 'bell-test' })
    if (a === 'inbox') return out({ messages: [] })
    out({ ok: true })
  })
  await new Promise(r => srv.listen(0, '127.0.0.1', r))
  return { port: srv.address().port, close: () => new Promise(r => { srv.closeAllConnections?.(); srv.close(r) }) }
}
function makeHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'asn-bridge-lock-'))
  fs.mkdirSync(path.join(home, '.claude', 'sessions'), { recursive: true })
  fs.writeFileSync(path.join(home, 'agents.json'), '[]')
  fs.writeFileSync(path.join(home, 'inbound.jsonl'), ''); fs.writeFileSync(path.join(home, 'record.jsonl'), '')
  const work = path.join(home, '.asn', 'machine-T'); fs.mkdirSync(work, { recursive: true })
  return { home, lock: path.join(work, 'bridge.pid') }
}
function startBridge(h, st) {
  const child = spawnTracked(process.execPath, [path.join(MACHINE, 'bridge.mjs')], {
    cwd: h.home, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true,
    env: {
      PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, HOME: h.home, USERPROFILE: h.home,
      IRORI_RELAY_ID: 'T', IRORI_RELAY_KEY: 'fake-test-key', IRORI_LAUNCH_NO_AUTO: '1', IRORI_RELAY_URL: `http://127.0.0.1:${st.port}/relay`,
      IRORI_RELAY_POLL_MS: '200', IRORI_ROSTER_MS: '150', IRORI_BRIDGE_TICK_MS: '100',
      IRORI_CLAUDE_SCRIPT: path.join(here, 'fake-claude.mjs'), FAKE_AGENTS: path.join(h.home, 'agents.json'),
      FAKE_RECORD: path.join(h.home, 'record.jsonl'), FAKE_INBOUND: path.join(h.home, 'inbound.jsonl'),
    },
  })
  const b = { child, log: '', code: undefined }
  child.stderr.on('data', d => b.log += d)
  child.once('exit', code => { b.code = code })
  b.until = async (cond, what, timeout = 60000) => {
    const t0 = Date.now()
    while (!cond() && Date.now() - t0 < timeout) await sleep(50)
    assert.ok(cond(), `${what} not reached in ${timeout}ms\n--- bridge log ---\n${b.log}`)
  }
  b.stop = async () => { if (b.code === undefined) { const gone = new Promise(r => child.once('exit', r)); child.kill(); await gone } }
  return b
}

test('橋啟動：bridge.pid 的編號被一個在寫入之後才啟動、活著、不是橋的程序佔用 → 照常啟動並覆寫成自己', async () => {
  const st = await fakeServer(), h = makeHome(), other = await idleChild()
  let b
  try {
    writeOld(h.lock, other.pid)                                                 // 寫入時間在 60 秒前；佔用者剛啟動
    b = startBridge(h, st)
    await b.until(() => /bridge starting/.test(b.log) || b.code !== undefined, 'bridge starting')
    assert.doesNotMatch(b.log, /another bridge is running/)
    assert.equal(b.code, undefined, b.log)
    assert.equal(fs.readFileSync(h.lock, 'utf8'), String(b.child.pid))         // bridge.pid 仍只有編號（ASN 內建橋讀得懂）
    assert.equal(fs.existsSync(h.lock + '.start'), false)
  } finally { await b?.stop(); await stopChild(other); await st.close(); fs.rmSync(h.home, { recursive: true, force: true }) }
})

test('橋啟動：兩個橋幾乎同時啟動 → 只留下一個，另一個 exit 3', async () => {
  const st = await fakeServer(), h = makeHome()
  const bs = []
  try {
    bs.push(startBridge(h, st), startBridge(h, st))
    await bs[0].until(() => bs.some(b => b.code !== undefined), 'one bridge exits')
    await sleep(1500)                                                           // 給另一個也有機會（錯誤地）退出
    const exited = bs.filter(b => b.code !== undefined), running = bs.filter(b => b.code === undefined)
    assert.equal(exited.length, 1, bs.map(b => b.log).join('\n----\n'))
    assert.equal(exited[0].code, 3, exited[0].log)
    assert.match(exited[0].log, /another bridge is running/)
    await running[0].until(() => /bridge starting/.test(running[0].log), 'survivor starting')
    assert.equal(parsePid(fs.readFileSync(h.lock, 'utf8')), running[0].child.pid)
  } finally { for (const b of bs) await b.stop(); await st.close(); fs.rmSync(h.home, { recursive: true, force: true }) }
})

test('橋啟動：真的有另一個橋在跑 → 第二個橋拒絕（exit 3），鎖仍是第一個橋的', async () => {
  const st = await fakeServer(), h = makeHome()
  let b1, b2
  try {
    b1 = startBridge(h, st)
    await b1.until(() => /bridge starting/.test(b1.log), 'first bridge starting')
    b2 = startBridge(h, st)
    await b2.until(() => b2.code !== undefined, 'second bridge exit')
    assert.equal(b2.code, 3, b2.log)
    assert.match(b2.log, /another bridge is running \(pid \d+\)/)
    assert.equal(parsePid(fs.readFileSync(h.lock, 'utf8')), b1.child.pid)
  } finally { await b2?.stop(); await b1?.stop(); await st.close(); fs.rmSync(h.home, { recursive: true, force: true }) }
})

test('橋啟動：bridge.pid 內容壞掉 → 當殘留檔覆寫', async () => {
  const st = await fakeServer(), h = makeHome()
  let b
  try {
    fs.writeFileSync(h.lock, '{broken')
    b = startBridge(h, st)
    await b.until(() => /bridge starting/.test(b.log) || b.code !== undefined, 'bridge starting')
    assert.equal(b.code, undefined, b.log)
    assert.equal(parsePid(fs.readFileSync(h.lock, 'utf8')), b.child.pid)
  } finally { await b?.stop(); await st.close(); fs.rmSync(h.home, { recursive: true, force: true }) }
})

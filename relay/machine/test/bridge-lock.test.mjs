// bridge.pid 單一實例鎖（#1373）：bridge.pid 仍只記編號（ASN 內建橋共用這個格式），另記 bridge.pid.start（程序啟動時間），
// 編號被別的程序回收時不再誤判另一個橋在跑。只 kill 測試自己 spawn、自己記下 PID 的子程序。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnTracked } from './spawn-tracked.mjs'
import { encodeStamp, parsePid, parseStamp, startTokens, stampFile, lockHolder, lockOwnedBy } from '../bridge-lock.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const MACHINE = path.join(here, '..')
const sleep = ms => new Promise(r => setTimeout(r, ms))

// 一個活著、但不是橋的程序（模擬「編號被回收給別人」）
async function idleChild() {
  const child = spawnTracked(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true })
  await new Promise((r, j) => { child.once('spawn', r); child.once('error', j) })
  return child
}
const stopChild = async child => { if (child.exitCode === null && child.signalCode === null) { const gone = new Promise(r => child.once('exit', r)); child.kill(); await gone } }
const tmpLock = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'asn-lock-test-')), 'bridge.pid')
// 照橋的順序寫：先 bridge.pid，再啟動時間記錄
const writeLock = (lock, pid, start) => { fs.writeFileSync(lock, String(pid)); if (start !== undefined) fs.writeFileSync(stampFile(lock), encodeStamp(pid, start)) }

test('parsePid／parseStamp：正常內容與壞掉的內容', () => {
  assert.equal(parsePid('4567'), 4567); assert.equal(parsePid('4567\r\n'), 4567)
  for (const bad of ['', 'garbage', '0', '12abc', '{"pid":1}', '-3']) assert.equal(parsePid(bad), null, bad)
  assert.deepEqual(parseStamp(encodeStamp(123, 'tok')), { pid: 123, start: 'tok' })
  assert.deepEqual(parseStamp(encodeStamp(123, null)), { pid: 123, start: null })
  for (const bad of ['', 'garbage', '{"pid":"x"}', '{"pid":-1}', '{"start":"t"}', '{not json', 'null', '[1]', '12']) assert.equal(parseStamp(bad), null, bad)
})

test('startTokens：查得到自己與子程序的啟動時間，兩者不同、重查一致；不存在的編號回 null', async () => {
  const child = await idleChild()
  try {
    const a = startTokens([process.pid, child.pid])
    assert.ok(a.get(process.pid), 'self token')
    assert.ok(a.get(child.pid), 'child token')
    assert.notEqual(a.get(process.pid), a.get(child.pid))
    assert.equal(startTokens([child.pid]).get(child.pid), a.get(child.pid))
  } finally { await stopChild(child) }
  assert.equal(startTokens([child.pid]).get(child.pid) ?? null, null)
})

test('lockHolder：編號活著但啟動時間對不上（被回收）→ 當殘留檔；對得上 → 視為橋在跑', async () => {
  const child = await idleChild(), lock = tmpLock()
  try {
    writeLock(lock, child.pid, 'token-of-a-dead-bridge')
    assert.equal(lockHolder(lock), null)
    writeLock(lock, child.pid, startTokens([child.pid]).get(child.pid))
    assert.equal(lockHolder(lock), child.pid)
  } finally { await stopChild(child); fs.rmSync(path.dirname(lock), { recursive: true, force: true }) }
})

test('lockHolder：沒有有效記錄（舊格式、別人後來改寫 bridge.pid、記錄壞掉）或查不到啟動時間 → 保守只看編號；壞檔／死編號／自己 → 不擋', async () => {
  const child = await idleChild(), lock = tmpLock(), sf = stampFile(lock)
  try {
    writeLock(lock, child.pid); try { fs.unlinkSync(sf) } catch {}           // 舊格式：只有 bridge.pid
    assert.equal(lockHolder(lock), child.pid)
    writeLock(lock, child.pid, null)                                          // 寫入時沒查到自己的啟動時間
    assert.equal(lockHolder(lock), child.pid)
    writeLock(lock, child.pid + 1, 'x'); fs.writeFileSync(lock, String(child.pid))   // 記錄是別的編號的
    assert.equal(lockHolder(lock), child.pid)
    writeLock(lock, child.pid, 'token-of-a-dead-bridge')                      // 記錄比 bridge.pid 舊（ASN 內建橋後來寫了 bridge.pid）
    const old = new Date(Date.now() - 60_000); fs.utimesSync(sf, old, old)
    assert.equal(lockHolder(lock), child.pid)
    writeLock(lock, child.pid); fs.writeFileSync(sf, '{broken')               // 記錄壞掉
    assert.equal(lockHolder(lock), child.pid)
    writeLock(lock, child.pid, 'whatever')                                    // 查詢失敗（逾時／權限）
    assert.equal(lockHolder(lock, { tokens: () => new Map() }), child.pid)
    fs.writeFileSync(lock, 'garbage'); assert.equal(lockHolder(lock), null)
    writeLock(lock, process.pid, 'x'); assert.equal(lockHolder(lock), null)
    assert.equal(lockHolder(lock + '.missing'), null)
  } finally { await stopChild(child) }
  writeLock(lock, child.pid); assert.equal(lockHolder(lock), null)            // 程序已結束
  fs.rmSync(path.dirname(lock), { recursive: true, force: true })
})

test('lockOwnedBy：bridge.pid 是不是自己的編號', () => {
  const lock = tmpLock()
  try {
    fs.writeFileSync(lock, String(process.pid)); assert.equal(lockOwnedBy(lock, process.pid), true)
    fs.writeFileSync(lock, String(process.pid + 1)); assert.equal(lockOwnedBy(lock, process.pid), false)
    fs.writeFileSync(lock, 'garbage'); assert.equal(lockOwnedBy(lock, process.pid), false)
  } finally { fs.rmSync(path.dirname(lock), { recursive: true, force: true }) }
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

test('橋啟動：bridge.pid 的編號被別的（活著、不是橋的）程序佔用 → 照常啟動並覆寫成自己', async () => {
  const st = await fakeServer(), h = makeHome(), other = await idleChild()
  let b
  try {
    writeLock(h.lock, other.pid, 'token-of-a-dead-bridge')
    b = startBridge(h, st)
    await b.until(() => /bridge starting/.test(b.log) || b.code !== undefined, 'bridge starting')
    assert.doesNotMatch(b.log, /another bridge is running/)
    assert.equal(b.code, undefined, b.log)
    assert.equal(fs.readFileSync(h.lock, 'utf8'), String(b.child.pid))         // bridge.pid 仍只有編號（ASN 內建橋讀得懂）
    const stamp = parseStamp(fs.readFileSync(stampFile(h.lock), 'utf8'))
    assert.equal(stamp.pid, b.child.pid); assert.ok(stamp.start, 'start token recorded')
  } finally { await b?.stop(); await stopChild(other); await st.close(); fs.rmSync(h.home, { recursive: true, force: true }) }
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

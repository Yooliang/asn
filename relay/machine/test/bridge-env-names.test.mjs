// 橋端到端的環境變數改名相容：只設舊名（IRORI_*）、只設新名（ASN_*）、兩個都設（以新名為準）。
// 假伺服器只聽 127.0.0.1；home 指到暫存資料夾，不碰真的 ~/.irori-relay、~/.asn。
// 執行：node --test relay/machine/test/
import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const BRIDGE = path.join(here, '..', 'bridge.mjs')
const sleep = ms => new Promise(r => setTimeout(r, ms))

async function fakeServer() {
  const st = { whoami: [], hits: 0 }
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x')
    const out = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)) }
    st.hits++
    const a = u.searchParams.get('action')
    if (a === 'whoami') { st.whoami.push({ key: req.headers['x-relay-key'] }); return out(200, { node: 'N' }) }
    if (a === 'inbox') return out(200, { messages: [] })
    out(403, { error: 'forbidden' })
  })
  await new Promise(r => srv.listen(0, '127.0.0.1', r))
  st.port = srv.address().port
  st.close = () => new Promise(r => { srv.closeAllConnections?.(); srv.close(r) })
  return st
}

async function runWith(envFor) {
  const st = await fakeServer()
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'asn-envnames-'))
  const child = spawn(process.execPath, [BRIDGE], {
    cwd: home, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true,
    env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, HOME: home, USERPROFILE: home, ...envFor(st.port) },
  })
  let log = ''; child.stderr.on('data', d => { log += d })
  const t0 = Date.now()
  while (!st.whoami.length && Date.now() - t0 < 15000) await sleep(50)
  const seen = [...st.whoami]
  child.kill()
  await new Promise(r => child.once('exit', r))
  await sleep(200)
  try { fs.rmSync(home, { recursive: true, force: true }) } catch {}
  await st.close()
  assert.ok(seen.length, `橋沒有連上假伺服器\n${log}`)
  assert.ok(!log.includes('fake-key'), '日誌不得出現金鑰')
  return seen[0]
}

const common = { ASN_LAUNCH_NO_AUTO: '1', ASN_RELAY_POLL_MS: '200', ASN_ROSTER_MS: '10000' }
const commonOld = { IRORI_LAUNCH_NO_AUTO: '1', IRORI_RELAY_POLL_MS: '200', IRORI_ROSTER_MS: '10000' }

test('橋：只設舊名 IRORI_* 照常連線並帶舊金鑰', async () => {
  const r = await runWith(port => ({ IRORI_RELAY_ID: 'N', IRORI_RELAY_KEY: 'fake-key-old', IRORI_RELAY_URL: `http://127.0.0.1:${port}/relay`, ...commonOld }))
  assert.equal(r.key, 'fake-key-old')
})

test('橋：只設新名 ASN_* 照常連線並帶新金鑰', async () => {
  const r = await runWith(port => ({ ASN_RELAY_ID: 'N', ASN_RELAY_KEY: 'fake-key-new', ASN_RELAY_URL: `http://127.0.0.1:${port}/relay`, ...common }))
  assert.equal(r.key, 'fake-key-new')
})

test('橋：新舊名都設以新名為準（舊網址指向不通的埠、舊金鑰不同）', async () => {
  const r = await runWith(port => ({
    ASN_RELAY_ID: 'N', ASN_RELAY_KEY: 'fake-key-new', ASN_RELAY_URL: `http://127.0.0.1:${port}/relay`,
    IRORI_RELAY_ID: 'OLD', IRORI_RELAY_KEY: 'fake-key-old', IRORI_RELAY_URL: 'http://127.0.0.1:9/relay', ...common,
  }))
  assert.equal(r.key, 'fake-key-new')
})

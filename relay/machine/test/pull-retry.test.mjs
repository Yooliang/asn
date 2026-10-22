// machine recv：inbox 失敗退避（與 cloud-agent 共用 pull-retry.mjs）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnTracked } from './spawn-tracked.mjs'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const RECV = path.join(here, '..', 'recv.mjs')
const sleep = ms => new Promise(r => setTimeout(r, ms))
const readBody = req => new Promise(r => { let b = ''; req.on('data', d => b += d); req.on('end', () => r(b ? JSON.parse(b) : null)) })
const U = n => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`
const mail = (n, to_agent) => ({ id: U(n), from_node: 'W', from_agent: 'W-政策', to_node: 'T', to_agent, body: `信${n}`, acked: false })

async function fakeRelay(inboxFailRemaining = 0) {
  let fails = inboxFailRemaining
  const st = { mails: [], reqs: [] }
  const srv = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x'), a = u.searchParams.get('action'), agent = u.searchParams.get('agent')
    const body = await readBody(req)
    st.reqs.push({ action: a, agent })
    const out = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)) }
    if (a === 'whoami') return out(200, { node: 'T', bell_topic: 'bell-test' })
    if (a === 'inbox') {
      if (fails > 0) { fails--; return out(500, { error: 'server_error' }) }
      return out(200, { messages: st.mails.filter(m => !m.acked && m.to_agent === agent) })
    }
    if (a === 'ack') {
      for (const m of st.mails) if (body.ids.includes(m.id)) m.acked = true
      return out(200, { acked: body.ids.length })
    }
    out(404, {})
  })
  await new Promise(r => srv.listen(0, '127.0.0.1', r))
  st.port = srv.address().port
  st.close = () => new Promise(r => { srv.closeAllConnections?.(); srv.close(r) })
  return st
}

function newHome(name = 'T-視窗甲') {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'asn-recv-retry-'))
  fs.mkdirSync(path.join(home, '.asn'), { recursive: true })
  fs.writeFileSync(path.join(home, '.asn', 'T.key'), 'fake-machine-key')
  const sdir = path.join(home, '.claude', 'sessions'); fs.mkdirSync(sdir, { recursive: true })
  fs.writeFileSync(path.join(sdir, `${process.pid}.json`), JSON.stringify({ pid: process.pid, name, kind: 'interactive', entrypoint: 'cli', messagingSocketPath: `\\\\.\\pipe\\fake-${process.pid}` }))
  return home
}

const baseEnv = (home, st, extra = {}) => ({
  PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, HOME: home, USERPROFILE: home,
  IRORI_RELAY_ID: 'T', IRORI_RELAY_URL: `http://127.0.0.1:${st.port}/relay`, CLAUDE_CODE_MESSAGING_SOCKET: `\\\\.\\pipe\\fake-${process.pid}`, ...extra,
})

function spawnRecv(home, st, args, env = {}) {
  const c = spawnTracked(process.execPath, [RECV, ...args], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env: baseEnv(home, st, env) })
  c.out = ''; c.err = ''; c.stdout.on('data', d => (c.out += d)); c.stderr.on('data', d => (c.err += d))
  c.done = new Promise(r => c.on('close', code => r(code)))
  return c
}

async function until(f, ms = 15000) { const t0 = Date.now(); while (!f() && Date.now() - t0 < ms) await sleep(50); return f() }

async function stopChild(c) {
  if (c.exitCode != null || c.killed) return c.done
  c.kill()
  return c.done
}

test('--watch：inbox 多次 500 後成功，短退避內印出信並 ack', async () => {
  const st = await fakeRelay(5)
  st.mails = [mail(1, 'T-視窗甲')]
  const home = newHome()
  const env = {
    IRORI_RECV_POLL_MS: '60000',
    IRORI_PULL_BACKOFF_MS: '5,10,20,40',
  }
  const c = spawnRecv(home, st, ['--watch'], env)
  try {
    assert.ok(await until(() => c.out.includes(U(1))), `stdout=${c.out}\nstderr=${c.err}`)
    assert.ok(await until(() => st.mails[0].acked === true), '印出後應 ack（ack 在印出之後，不能立刻斷言）')
    const inboxCalls = st.reqs.filter(r => r.action === 'inbox').length
    assert.ok(inboxCalls >= 3, `應重試 inbox，實際 ${inboxCalls}`)
  } finally {
    await stopChild(c)
    await st.close()
    fs.rmSync(home, { recursive: true, force: true })
  }
})

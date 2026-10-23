// Aegis 橋的共用測試向量（relay/shared/test-vectors/aegis-bridge.json）：Node 橋（bridge-aegis.mjs、nudge.mjs）跑一遍。
// Rust 內建橋的 Aegis 引擎（relay/asn/src-tauri/src/bridge/engines/aegis.rs、bridge/tests/aegis_it.rs）讀同一份檔案，
// 兩邊對同一組輸入的輸出必須逐字相同。假伺服器只連 127.0.0.1；不碰任何真實金鑰或網路服務。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnTracked } from './spawn-tracked.mjs'
import { splitNudgeAnswer } from '../nudge.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const V = JSON.parse(fs.readFileSync(path.join(here, '..', '..', 'shared', 'test-vectors', 'aegis-bridge.json'), 'utf8'))
const sleep = ms => new Promise(r => setTimeout(r, ms))
const uid = n => `00000000-0000-0000-0000-${n.toString(16).padStart(12, '0')}`
const readBody = req => new Promise(r => { let b = ''; req.on('data', d => b += d); req.on('end', () => r(b ? JSON.parse(b) : null)) })

test('向量：震動拆分', () => {
  assert.ok(V.nudge_split.length >= 10)
  for (const c of V.nudge_split) {
    const sp = splitNudgeAnswer(c.answer, c.name)
    assert.deepEqual(sp, c.split, JSON.stringify(c.answer))
  }
})

async function fakeServer(mails, failSend = new Set()) {
  const st = { acked: new Set(), sent: [], rosterPosts: [], asks: [], calls: {} }
  const inbox = mails.map((m, i) => {
    const x = { id: uid(i + 1), from_node: V.config.mail.from_node, from_agent: V.config.mail.from_agent, trust: V.config.mail.trust, expects_reply: V.config.mail.expects_reply, body: m.body }
    if (m.to_agent) x.to_agent = m.to_agent
    return x
  })
  const srv = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x')
    const out = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)) }
    if (u.pathname === '/relay') {
      const a = u.searchParams.get('action')
      if (a === 'whoami') return out(200, { node: 'T', bell_topic: 'bell-test' })
      if (a === 'inbox') return out(200, { messages: st.rosterPosts.length ? inbox.filter(m => !st.acked.has(m.id)) : [] })
      if (a === 'send') { const b = await readBody(req); if (failSend.has(b.reply_to)) return out(500, { error: 'x' }); st.sent.push(b); return out(200, { ok: true }) }
      if (a === 'ack') { (await readBody(req)).ids.forEach(i => st.acked.add(i)); return out(200, { ok: true }) }
      if (a === 'roster') { st.rosterPosts.push(await readBody(req)); return out(200, { ok: true }) }
    }
    if (u.pathname === '/api/v1/agent-chat/ask') {
      const body = await readBody(req)
      st.asks.push(body)
      // 回應腳本以「信的內文＋成員」為鍵（同一個成員在不同信有不同答案）
      const mail = mails.find(m => body.question.endsWith(m.body) && m.aegis[body.target])
      const list = mail?.aegis[body.target]
      if (!list) return out(404, { detail: 'member not found' })
      const key = mail.body + '|' + body.target
      const n = st.calls[key] = (st.calls[key] ?? 0) + 1
      const r = list[Math.min(n, list.length) - 1]
      return out(r.http, r.json)
    }
    if (u.pathname === '/api/v1/members') return out(200, V.config.members)
    out(404, {})
  })
  await new Promise(r => srv.listen(0, '127.0.0.1', r))
  st.port = srv.address().port
  st.inbox = inbox
  st.close = () => new Promise(r => { srv.closeAllConnections?.(); srv.close(r) })
  return st
}

async function runBridge(st, { until, env = {} }) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'asn-aegis-vec-'))
  const child = spawnTracked(process.execPath, [path.join(here, '..', 'bridge-aegis.mjs')], {
    cwd: home, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true,
    env: {
      PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, HOME: home, USERPROFILE: home,
      IRORI_RELAY_ID: 'T', IRORI_RELAY_KEY: 'fake-test-key', IRORI_RELAY_URL: `http://127.0.0.1:${st.port}/relay`,
      IRORI_RELAY_POLL_MS: '200', IRORI_ROSTER_MS: '150',
      IRORI_AEGIS_URL: `http://127.0.0.1:${st.port}`, IRORI_AEGIS_ALLOW: V.config.allow, IRORI_AEGIS_RETRY_MS: String(V.config.retry_ms), ...env,
    },
  })
  let log = ''; child.stderr.on('data', d => log += d)
  const t0 = Date.now()
  while (!until() && Date.now() - t0 < 30000) await sleep(50)
  await sleep(600)
  const ok = until()
  child.kill()
  await new Promise(r => child.once('exit', r))
  await sleep(200)
  try { fs.rmSync(home, { recursive: true, force: true }) } catch {}
  assert.ok(ok, `條件沒達成\n${log}`)
}

test('向量：每封信的問答、回信、ack、名單', async () => {
  const st = await fakeServer(V.mails)
  try {
    await runBridge(st, { until: () => st.acked.size >= V.mails.length && st.rosterPosts.length >= 1 })
    V.mails.forEach((m, i) => {
      const id = uid(i + 1), label = `${i + 1} ${m.name}`
      const asks = st.asks.filter(a => a.question.endsWith(m.body))
      assert.deepEqual(asks, m.asks, label)
      const got = st.sent.filter(s => s.reply_to === id)
      assert.equal(got.length, m.replies.length, label)
      m.replies.forEach((e, k) => {
        if ('body' in e) assert.equal(got[k].body, e.body, label)
        if ('body_has_node' in e) assert.ok(got[k].body.includes(e.body_has_node), `${label}: ${got[k].body}`)
        if ('from_agent' in e) assert.equal(got[k].from_agent, e.from_agent, label)
        if ('to_node' in e) assert.equal(got[k].to_node, e.to_node, label)
        if ('to_agent' in e) assert.equal(got[k].to_agent, e.to_agent, label)
      })
      assert.ok(st.acked.has(id), `${label} 要 ack`)
    })
    const r = st.rosterPosts[0].agents
    assert.deepEqual(r.map(a => a.name), V.config.roster_names)
    assert.deepEqual(r.map(a => a.cwd_label), r.map(() => ''))
  } finally { await st.close() }
})

test('向量：寄回失敗就不 ack（留在信箱）；寄回成功才 ack', async () => {
  const m = V.mails[0]
  const st = await fakeServer([m], new Set([uid(1)]))
  try {
    await runBridge(st, { until: () => st.asks.length >= 1 })
    assert.equal(st.acked.size, 0, '寄回失敗不 ack')
  } finally { await st.close() }
})

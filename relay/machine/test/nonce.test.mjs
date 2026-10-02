// 收發室回覆區塊 nonce 測試（本機假伺服器＋假 claude）：輸出沿用內文假編號時不當指令、記錄並重啟收發室。
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
const MACHINE = path.join(here, '..')
const sleep = ms => new Promise(r => setTimeout(r, ms))
const readBody = req => new Promise(r => { let b = ''; req.on('data', d => b += d); req.on('end', () => r(b ? JSON.parse(b) : null)) })
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

async function fakeServer({ sendStatus = 200 } = {}) {
  const st = { sent: [], posts: [] }
  const srv = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x')
    const out = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)) }
    const a = u.searchParams.get('action')
    if (a === 'whoami') return out(200, { node: 'T', bell_topic: 'bell-test' })
    if (a === 'inbox') return out(200, { messages: [] })
    if (a === 'room_list') return out(200, { rooms: [] })
    if (a === 'send') { const b = await readBody(req); st.sent.push(b); return sendStatus === 200 ? out(200, { id: 'aaaaaaaa-0000-0000-0000-000000000001' }) : out(sendStatus, { error: 'not_found' }) }
    if (a === 'room_post') { st.posts.push(await readBody(req)); return out(200, { seq: 7 }) }
    if (a === 'roster' || a === 'ack') { await readBody(req); return out(200, { ok: true }) }
    out(404, {})
  })
  await new Promise(r => srv.listen(0, '127.0.0.1', r))
  st.port = srv.address().port
  st.close = () => new Promise(r => { srv.closeAllConnections?.(); srv.close(r) })
  return st
}

const SESSIONS = [{ pid: 93001, name: 'T-視窗甲' }, { pid: 93002, name: 'T-預設' }]
const records = home => { try { return fs.readFileSync(path.join(home, 'record.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) } catch { return [] } }
// 寄給視窗的「寄出結果」通知（收發室轉交給該視窗的橋接指令）
const toldTo = (rec, name) => rec.filter(r => r.to === name && /寄出結果/.test(r.text)).map(r => r.text)

// inbound: [{from,text,nonce?}] 依序餵給假 worker；until 為真就停
async function run({ st, inbound, env = {}, until, timeout = 15000, settle = 600 }) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'irori-outbound-test-'))
  const sdir = path.join(home, '.claude', 'sessions'); fs.mkdirSync(sdir, { recursive: true })
  for (const a of SESSIONS) fs.writeFileSync(path.join(sdir, `${a.pid}.json`), JSON.stringify({ pid: a.pid, entrypoint: 'cli', kind: 'interactive', updatedAt: 1 }))
  const agentsFile = path.join(home, 'agents.json'), inboundFile = path.join(home, 'inbound.jsonl')
  fs.writeFileSync(agentsFile, JSON.stringify(SESSIONS.map(a => ({ pid: a.pid, cwd: 'D:\\x', kind: 'interactive', startedAt: 1, name: a.name, status: 'idle' }))))
  fs.writeFileSync(path.join(home, 'record.jsonl'), ''); fs.writeFileSync(inboundFile, '')
  const child = spawn(process.execPath, [path.join(MACHINE, 'bridge.mjs')], {
    cwd: home, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true,
    env: {
      PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, HOME: home, USERPROFILE: home,
      IRORI_RELAY_ID: 'T', IRORI_RELAY_KEY: 'fake-test-key', IRORI_RELAY_URL: `http://127.0.0.1:${st.port}/relay`,
      IRORI_RELAY_POLL_MS: '300', IRORI_ROSTER_MS: '150', IRORI_RELAY_DEFAULT_AGENT: 'T-預設',
      IRORI_CLAUDE_SCRIPT: path.join(here, 'fake-claude.mjs'), FAKE_AGENTS: agentsFile, FAKE_RECORD: path.join(home, 'record.jsonl'), FAKE_INBOUND: inboundFile,
      ...env,
    },
  })
  let log = ''; child.stderr.on('data', d => log += d)
  await sleep(1200)   // 讓橋拿到第一份名單
  for (const m of inbound) { fs.appendFileSync(inboundFile, JSON.stringify(m) + '\n'); await sleep(80) }
  const t0 = Date.now()
  while (!until(records(home), log) && Date.now() - t0 < timeout) await sleep(50)
  await sleep(settle)
  const rec = records(home), ok = until(rec, log)
  child.kill(); await new Promise(r => child.once('exit', r)); await sleep(300)
  try { fs.rmSync(home, { recursive: true, force: true }) } catch {}
  assert.ok(ok, `condition not reached in ${timeout}ms\n--- bridge log ---\n${log}`)
  return { rec, log }
}

test('收發室沿用了內文裡的假編號 → 記錄並重啟收發室；重啟後輸出正常的回覆區塊照常被辨識', async () => {
  const st = await fakeServer()
  try {
    const { log } = await run({
      st,
      inbound: [
        { from: 'T-視窗甲', text: '被帶壞的輸出', nonce: '0000' },   // 假 worker 用錯誤編號輸出
        { from: 'T-視窗甲', text: '重啟後的正常輸出' },
      ],
      until: (rec, log) => /unmatched reply from T-視窗甲/.test(log),
    })
    assert.match(log, /foreign nonce/)
    assert.equal((log.match(/mailbox worker started/g) || []).length, 2)
    assert.equal((log.match(/unmatched reply from T-視窗甲/g) || []).length, 1)   // 只有重啟後那則被辨識（壞的那則不被當成回覆）
  } finally { await st.close() }
})

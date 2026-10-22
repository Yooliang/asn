// 信先到、名單後到：橋剛啟動、還沒拿到第一份名單時拉到個人信，不能回「找不到名叫…的 session」並 ack（信就丟了）；
// 要先留在 inbox，等名單到了下一輪再正常轉交。只連 127.0.0.1 的假仲介，假 claude 的名單檔一開始不存在（＝讀取失敗＝沒有名單）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnTracked } from './spawn-tracked.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const MACHINE = path.join(here, '..')
const sleep = ms => new Promise(r => setTimeout(r, ms))
const readBody = req => new Promise(r => { let b = ''; req.on('data', d => b += d); req.on('end', () => r(b ? JSON.parse(b) : null)) })
const ID = '00000000-0000-0000-0000-000000000001'
const MAIL = { id: ID, from_node: 'W', from_agent: 'W-政策', to_agent: 'T-對方', trust: 'member', body: '先到的信', expects_reply: true }

async function fakeServer() {
  const st = { acked: new Set(), sent: [], inboxCalls: 0, rosterPosts: 0 }
  const srv = http.createServer(async (req, res) => {
    const a = new URL(req.url, 'http://x').searchParams.get('action')
    const out = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)) }
    if (a === 'whoami') return out(200, { node: 'T', bell_topic: 'bell-test' })
    if (a === 'inbox') { st.inboxCalls++; return out(200, { messages: st.acked.has(ID) ? [] : [MAIL] }) }
    if (a === 'send') { st.sent.push(await readBody(req)); return out(200, { ok: true }) }
    if (a === 'ack') { (await readBody(req)).ids.forEach(i => st.acked.add(i)); return out(200, { ok: true }) }
    if (a === 'roster') { await readBody(req); st.rosterPosts++; return out(200, { ok: true }) }
    out(404, {})
  })
  await new Promise(r => srv.listen(0, '127.0.0.1', r))
  st.port = srv.address().port
  st.close = () => new Promise(r => { srv.closeAllConnections?.(); srv.close(r) })
  return st
}

async function until(cond, what, getLog, timeout = 15000) {
  const t0 = Date.now()
  while (!cond() && Date.now() - t0 < timeout) await sleep(50)
  assert.ok(cond(), `等不到：${what}\n--- bridge log ---\n${getLog()}`)
}

test('信先到、名單後到：名單到之前不 ack、不回找不到；名單到之後信正常轉交', async () => {
  const st = await fakeServer()
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'irori-mail-before-roster-'))
  const dir = path.join(home, '.claude', 'sessions'); fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, '92000.json'), JSON.stringify({ pid: 92000, entrypoint: 'cli', kind: 'interactive', updatedAt: 1 }))
  const agentsFile = path.join(home, 'agents.json')   // 先不建立：假 claude 的 agents 指令會失敗＝名單讀取失敗
  const record = path.join(home, 'record.jsonl')
  fs.writeFileSync(path.join(home, 'inbound.jsonl'), ''); fs.writeFileSync(record, '')
  const work = path.join(home, '.irori-relay', 'machine-T'); fs.mkdirSync(work, { recursive: true })
  const child = spawnTracked(process.execPath, [path.join(MACHINE, 'bridge.mjs')], {
    cwd: home, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true,
    env: {
      PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, HOME: home, USERPROFILE: home,
      IRORI_RELAY_ID: 'T', IRORI_RELAY_KEY: 'fake-test-key', IRORI_LAUNCH_NO_AUTO: '1', IRORI_RELAY_URL: `http://127.0.0.1:${st.port}/relay`,
      IRORI_RELAY_POLL_MS: '200', IRORI_ROSTER_MS: '150', IRORI_RELAY_DEFAULT_AGENT: 'T-對方',
      IRORI_REPLY_TIMEOUT_MS: '60000', IRORI_BRIDGE_TICK_MS: '100', IRORI_NOREPLY_WINDOW_MS: '0',
      IRORI_CLAUDE_SCRIPT: path.join(here, 'fake-claude.mjs'), FAKE_AGENTS: agentsFile,
      FAKE_RECORD: record, FAKE_INBOUND: path.join(home, 'inbound.jsonl'),
    },
  })
  let log = ''
  child.stderr.on('data', d => log += d)
  const getLog = () => log
  try {
    // 名單一直沒到的期間，橋至少拉了好幾輪 inbox
    await until(() => st.inboxCalls >= 4, '橋在沒名單時拉了至少 4 輪 inbox', getLog)
    assert.equal(st.rosterPosts, 0)
    assert.equal(st.acked.size, 0, '名單到之前不能 ack')
    assert.equal(st.sent.filter(s => /找不到名叫/.test(s.body)).length, 0, '名單到之前不能回找不到')
    assert.equal(fs.readFileSync(record, 'utf8'), '', '名單到之前不能轉交')
    // 名單到了
    fs.writeFileSync(agentsFile, JSON.stringify([{ pid: 92000, cwd: 'D:\\x', kind: 'interactive', startedAt: 1, name: 'T-對方', status: 'idle' }]))
    await until(() => fs.readFileSync(record, 'utf8').includes(ID), '名單到之後信被轉交給 T-對方', getLog)
    assert.match(fs.readFileSync(record, 'utf8'), /先到的信/)
    assert.equal(st.sent.filter(s => /找不到名叫/.test(s.body)).length, 0)
  } finally {
    child.kill()
    await new Promise(r => child.exitCode !== null ? r() : child.once('exit', r))
    await st.close()
    try { fs.rmSync(home, { recursive: true, force: true }) } catch {}
  }
})

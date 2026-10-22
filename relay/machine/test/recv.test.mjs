// irori-recv（視窗自己收信）與「有心跳橋就不轉」測試：本機假仲介、不碰真實仲介與真實金鑰。
// 執行：node --test relay/machine/test/*.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnTracked } from './spawn-tracked.mjs'
import { fileURLToPath } from 'node:url'
import { selfRecvAlive, writeHeartbeat, heartbeatFile } from '../self-recv.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const MACHINE = path.join(here, '..')
const RECV = path.join(MACHINE, 'recv.mjs')
const sleep = ms => new Promise(r => setTimeout(r, ms))
const readBody = req => new Promise(r => { let b = ''; req.on('data', d => b += d); req.on('end', () => r(b ? JSON.parse(b) : null)) })
const U = n => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`
const mail = (n, to_agent, extra = {}) => ({ id: U(n), from_node: 'W', from_agent: 'W-政策', to_node: 'T', to_agent, body: `信${n}`, reply_to: null, created_at: '2026-10-02T00:00:00Z', trust: 'member', acked: false, ...extra })

// 假仲介：filterAgent=true 時照新版行為只回 to_agent＝agent 的信；false 模擬還沒部署新版（忽略 agent 參數，回整個節點信箱）
async function fakeRelay({ filterAgent = true } = {}) {
  const st = { mails: [], reqs: [] }
  const srv = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x'), a = u.searchParams.get('action'), agent = u.searchParams.get('agent')
    const body = await readBody(req)
    st.reqs.push({ action: a, agent, key: req.headers['x-relay-key'], body })
    const out = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)) }
    if (a === 'whoami') return out(200, { node: 'T', bell_topic: 'bell-test' })
    if (a === 'inbox') return out(200, { messages: st.mails.filter(m => !m.acked && (!filterAgent || !agent || m.to_agent === agent)) })   // 沒帶 agent＝原本的節點信箱（機器橋用）
    if (a === 'ack') {
      let n = 0
      for (const m of st.mails) if (!m.acked && body.ids.includes(m.id) && (!filterAgent || !agent || m.to_agent === agent)) { m.acked = true; n++ }
      return out(200, { acked: n })
    }
    if (a === 'roster') return out(200, { ok: true })
    if (a === 'room_list') return out(200, { rooms: [] })
    out(404, {})
  })
  await new Promise(r => srv.listen(0, '127.0.0.1', r))
  st.port = srv.address().port
  st.close = () => new Promise(r => { srv.closeAllConnections?.(); srv.close(r) })
  return st
}

// 假視窗身分：用環境變數備援（CLAUDE_CODE_MESSAGING_SOCKET 對上還活著的 session），pid 用測試行程自己
function newHome(name = 'T-視窗甲') {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'asn-recv-test-'))
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
  c.out = ''; c.err = ''; c.stdout.on('data', d => c.out += d); c.stderr.on('data', d => c.err += d)
  c.done = new Promise(r => c.on('close', code => r(code)))
  return c
}
const lines = c => c.out.split('\n').filter(Boolean).map(l => JSON.parse(l))
async function until(f, ms = 8000) { const t0 = Date.now(); while (!f() && Date.now() - t0 < ms) await sleep(50); return f() }
const hbPath = (home, name = 'T-視窗甲') => heartbeatFile(path.join(home, '.asn', 'machine-T'), name)

test('--once：只印寄給本視窗的信（一行一個 JSON、含 id/trust/from/reply_to/body），只 ack 這些', async () => {
  const st = await fakeRelay(), home = newHome()
  st.mails = [mail(1, 'T-視窗甲', { reply_to: U(99), trust: 'owner', expects_reply: true }), mail(2, 'T-視窗乙'), mail(3, null), mail(4, 'T-視窗甲')]
  try {
    const c = spawnRecv(home, st, ['--once'])
    assert.equal(await c.done, 0, c.err)
    const got = lines(c)
    assert.deepEqual(got.map(m => m.id), [U(1), U(4)])
    // expects_reply＝寄件人明說要不要回信（true 要回、false 只是告知）；舊信沒有這個欄位就是 null
    assert.deepEqual(got[0], { id: U(1), trust: 'owner', from_node: 'W', from_agent: 'W-政策', to_agent: 'T-視窗甲', reply_to: U(99), created_at: '2026-10-02T00:00:00Z', expects_reply: true, body: '信1' })
    assert.strictEqual(got[1].expects_reply, null)
    const inbox = st.reqs.find(r => r.action === 'inbox'), ack = st.reqs.find(r => r.action === 'ack')
    assert.equal(inbox.agent, 'T-視窗甲'); assert.equal(inbox.key, 'fake-machine-key')
    assert.equal(ack.agent, 'T-視窗甲'); assert.deepEqual(ack.body.ids, [U(1), U(4)])
    assert.deepEqual(st.mails.map(m => m.acked), [true, false, false, true])
    assert.equal(fs.existsSync(hbPath(home)), false, '--once 不寫心跳')
  } finally { await st.close() }
})

test('--once 對還沒部署新版的仲介（忽略 agent 參數、回整個節點信箱）：別視窗的信與總機信不印、不 ack', async () => {
  const st = await fakeRelay({ filterAgent: false }), home = newHome()
  st.mails = [mail(1, 'T-視窗乙'), mail(2, null), mail(3, 'T-視窗甲')]
  try {
    const c = spawnRecv(home, st, ['--once'])
    assert.equal(await c.done, 0, c.err)
    assert.deepEqual(lines(c).map(m => m.id), [U(3)])
    assert.deepEqual(st.reqs.find(r => r.action === 'ack').body.ids, [U(3)])
    assert.deepEqual(st.mails.map(m => m.acked), [false, false, true])
  } finally { await st.close() }
})

test('不是在 Claude 視窗裡跑（認不出視窗）→ 拒絕、不打後端；參數不合也拒絕', async () => {
  const st = await fakeRelay(), home = newHome()
  try {
    fs.rmSync(path.join(home, '.claude', 'sessions', `${process.pid}.json`))   // 測試行程在父行程鏈上：先拿掉它的 session 登記，才是「沒有視窗」
    const noWin = spawnTracked(process.execPath, [RECV, '--once'], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env: baseEnv(home, st, { CLAUDE_CODE_MESSAGING_SOCKET: '' }) })
    let err = ''; noWin.stderr.on('data', d => err += d)
    assert.equal(await new Promise(r => noWin.on('close', r)), 2); assert.match(err, /找不到呼叫者所屬的 Claude 視窗/)
    const bad = spawnRecv(home, st, ['--once', '--watch']); assert.equal(await bad.done, 1)
    const bad2 = spawnRecv(home, st, ['--agent', 'X']); assert.equal(await bad2.done, 1)
    assert.equal(st.reqs.length, 0)
  } finally { await st.close() }
})

test('--watch：寫心跳（pid＋時間）、印已在信箱的信、之後新來的信由輪詢撿到、不重印；第二個同視窗 --watch 被擋；程序結束後心跳不再算有效', async () => {
  const st = await fakeRelay(), home = newHome()
  st.mails = [mail(1, 'T-視窗甲'), mail(2, 'T-視窗乙')]
  const env = { IRORI_RECV_POLL_MS: '200', IRORI_RECV_HEARTBEAT_MS: '150' }
  const c = spawnRecv(home, st, ['--watch'], env)
  try {
    assert.ok(await until(() => lines(c).length === 1), `沒印出第一封\n${c.err}`)
    const hb = JSON.parse(fs.readFileSync(hbPath(home), 'utf8'))
    assert.equal(hb.pid, c.pid); assert.equal(hb.name, 'T-視窗甲'); assert.ok(Date.now() - hb.t < 5000)
    const t1 = hb.t
    assert.ok(await until(() => JSON.parse(fs.readFileSync(hbPath(home), 'utf8')).t > t1), '心跳沒有更新')
    st.mails.push(mail(5, 'T-視窗甲'), mail(6, 'T-視窗乙'))
    assert.ok(await until(() => lines(c).length === 2), `新信沒被撿到\n${c.err}`)
    await sleep(700)   // 多輪輪詢：不可重印
    assert.deepEqual(lines(c).map(m => m.id), [U(1), U(5)])
    assert.deepEqual(st.mails.map(m => m.acked), [true, false, true, false])
    // 同一視窗第二個 --watch：心跳有效就拒絕
    const dup = spawnRecv(home, st, ['--watch'], env)
    assert.equal(await dup.done, 3); assert.match(dup.err, /已經有一個 recv --watch/)
    assert.equal(selfRecvAlive(path.join(home, '.asn', 'machine-T'), 'T-視窗甲'), true)
  } finally {
    c.kill(); await c.done; await st.close()
  }
  // 被強制結束：心跳檔可能還在，但 pid 已死 → 橋不會再當成有人在收
  assert.equal(selfRecvAlive(path.join(home, '.asn', 'machine-T'), 'T-視窗甲'), false)
})

test('selfRecvAlive：新鮮且 pid 活著才算；過期、pid 已死、沒有檔、時間在未來都不算', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'irori-hb-test-'))
  const now = Date.now()
  assert.equal(selfRecvAlive(dir, 'W1', now), false)
  writeHeartbeat(dir, 'W1', process.pid, now - 10_000); assert.equal(selfRecvAlive(dir, 'W1', now), true)
  writeHeartbeat(dir, 'W1', process.pid, now - 91_000); assert.equal(selfRecvAlive(dir, 'W1', now), false)
  writeHeartbeat(dir, 'W1', 2 ** 22 - 1, now - 1000); assert.equal(selfRecvAlive(dir, 'W1', now), false)
  writeHeartbeat(dir, 'W1', process.pid, now + 600_000); assert.equal(selfRecvAlive(dir, 'W1', now), false)
  writeHeartbeat(dir, 'a/b:c', process.pid, now); assert.equal(selfRecvAlive(dir, 'a/b:c', now), true)   // 視窗名含路徑字元也安全
  assert.equal(path.dirname(heartbeatFile(dir, '../../x')), path.join(dir, 'self-recv'))
  fs.rmSync(dir, { recursive: true, force: true })
})

// ---- 橋：有心跳就不轉，過期照轉 ----
async function bridgeRun({ heartbeat }) {
  const st = await fakeRelay()
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'irori-bridge-hb-test-'))
  const sdir = path.join(home, '.claude', 'sessions'); fs.mkdirSync(sdir, { recursive: true })
  fs.writeFileSync(path.join(sdir, '93001.json'), JSON.stringify({ pid: 93001, entrypoint: 'cli', kind: 'interactive', updatedAt: 1 }))
  const agentsFile = path.join(home, 'agents.json'), inboundFile = path.join(home, 'inbound.jsonl'), recordFile = path.join(home, 'record.jsonl')
  fs.writeFileSync(agentsFile, JSON.stringify([{ pid: 93001, cwd: 'D:\\x', kind: 'interactive', startedAt: 1, name: 'T-視窗甲', status: 'idle' }]))
  fs.writeFileSync(inboundFile, ''); fs.writeFileSync(recordFile, '')
  if (heartbeat) writeHeartbeat(path.join(home, '.asn', 'machine-T'), 'T-視窗甲', process.pid, Date.now() - heartbeat.ageMs)
  const child = spawnTracked(process.execPath, [path.join(MACHINE, 'bridge.mjs')], {
    cwd: home, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true,
    env: {
      PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, HOME: home, USERPROFILE: home,
      IRORI_RELAY_ID: 'T', IRORI_RELAY_KEY: 'fake-test-key', IRORI_LAUNCH_NO_AUTO: '1', IRORI_RELAY_URL: `http://127.0.0.1:${st.port}/relay`,
      IRORI_RELAY_POLL_MS: '300', IRORI_ROSTER_MS: '150', IRORI_RELAY_DEFAULT_AGENT: 'T-預設',
      IRORI_CLAUDE_SCRIPT: path.join(here, 'fake-claude.mjs'), FAKE_AGENTS: agentsFile, FAKE_RECORD: recordFile, FAKE_INBOUND: inboundFile,
    },
  })
  let log = ''; child.stderr.on('data', d => log += d)
  // 等橋第一次回報名單，再放信進信箱（名單還空時橋會回「找不到 session」）；固定等一段時間在負載高時不夠
  await until(() => st.reqs.some(r => r.action === 'roster'), 20000)
  st.mails = [mail(1, 'T-視窗甲')]
  await until(() => /handed id=|window receives by itself/.test(log), 20000)
  await sleep(1000)   // 多輪輪詢，確認不會反悔轉交
  child.kill(); await new Promise(r => child.once('exit', r)); await sleep(300)
  const res = { log, acks: st.reqs.filter(r => r.action === 'ack' && !r.agent), mails: st.mails }
  await st.close(); try { fs.rmSync(home, { recursive: true, force: true }) } catch {}
  return res
}

test('橋：視窗心跳在 90 秒內且 pid 活著 → 不轉交、不 ack（信留給視窗自己拉）', async () => {
  const r = await bridgeRun({ heartbeat: { ageMs: 5_000 } })
  assert.match(r.log, /window receives by itself/)
  assert.doesNotMatch(r.log, /handed id=/)
  assert.equal(r.acks.length, 0); assert.equal(r.mails[0].acked, false)
})

test('橋：心跳過期（超過 90 秒）→ 照舊經收發室轉交，不會漏信', async () => {
  const r = await bridgeRun({ heartbeat: { ageMs: 120_000 } })
  assert.match(r.log, /handed id=00000000-0000-0000-0000-000000000001 .*to=T-視窗甲/)
  assert.doesNotMatch(r.log, /window receives by itself/)
})

test('橋：沒有心跳檔 → 照舊轉交', async () => {
  const r = await bridgeRun({ heartbeat: null })
  assert.match(r.log, /handed id=/)
})

// acp 轉接器接上真的 bridge.mjs 的整合測試（假仲介＋假 agy）：
// 名單帶 engine=gemini（供手機顯示圖示）、收信→回覆寄回（reply_to、from_agent=工作者名）、錯誤回給寄件人不吞信、
// 授權回覆走一般信件、沒指定收件人的信不會被背景工作者代收。不碰真的 AI、不碰真仲介。
// 執行：node --test relay/machine/test/acp-bridge.test.mjs
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
const FAKE_AGY = path.join(here, 'fake-agy.mjs')
const sleep = ms => new Promise(r => setTimeout(r, ms))
const readBody = req => new Promise(r => { let b = ''; req.on('data', d => b += d); req.on('end', () => r(b ? JSON.parse(b) : null)) })
const uid = n => `00000000-0000-0000-0000-${n.toString(16).padStart(12, '0')}`

async function fakeRelay(inbox) {
  const st = { acked: new Set(), sent: [], rosterPosts: [] }
  const srv = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x')
    const out = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)) }
    const a = u.searchParams.get('action')
    if (a === 'whoami') return out(200, { node: 'T', bell_topic: 'bell-test' })
    if (a === 'inbox') return out(200, { messages: inbox.filter(m => !st.acked.has(m.id)) })
    if (a === 'send') { st.sent.push(await readBody(req)); return out(200, { ok: true }) }
    if (a === 'ack') { (await readBody(req)).ids.forEach(i => st.acked.add(i)); return out(200, { ok: true }) }
    if (a === 'roster') { st.rosterPosts.push(await readBody(req)); return out(200, { ok: true }) }
    if (a === 'launch_pending') return out(200, { launches: [] })
    out(404, {})
  })
  await new Promise(r => srv.listen(0, '127.0.0.1', r))
  st.port = srv.address().port
  st.close = () => new Promise(r => { srv.closeAllConnections?.(); srv.close(r) })
  return st
}

async function run({ inbox, workers, until, env = {} }) {
  const st = await fakeRelay(inbox)
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'irori-acp-bridge-'))
  fs.mkdirSync(path.join(home, 'st'))
  const agents = path.join(home, 'agents.json')
  fs.writeFileSync(agents, JSON.stringify({ workers }))
  const child = spawn(process.execPath, [path.join(MACHINE, 'bridge.mjs')], {
    cwd: home, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true,
    env: {
      PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, HOME: home, USERPROFILE: home,
      IRORI_RELAY_ID: 'T', IRORI_RELAY_KEY: 'fake-test-key', IRORI_LAUNCH_NO_AUTO: '1', IRORI_RELAY_URL: `http://127.0.0.1:${st.port}`,
      IRORI_RELAY_POLL_MS: '200', IRORI_ROSTER_MS: '150', IRORI_ENGINES: 'acp', IRORI_AGENTS_FILE: agents,
      FAKE_AGY_STATE: path.join(home, 'st'), ...env,
    },
  })
  let log = ''; child.stderr.on('data', d => log += d)
  const t0 = Date.now()
  while (!until({ st, log }) && Date.now() - t0 < 15000) await sleep(50)
  await sleep(300)
  const final = { st, log }
  const ok = until(final)
  child.kill()
  await new Promise(r => child.once('exit', r))
  await st.close()
  try { fs.rmSync(home, { recursive: true, force: true }) } catch {}
  assert.ok(ok, `condition not reached\n--- sent ---\n${JSON.stringify(st.sent, null, 1)}\n--- bridge log ---\n${log}`)
  return final
}

const worker = (extra = {}) => ({ name: 'Gemini', engine: 'acp', roster_engine: 'gemini', protocol: 'agy-stream', command: process.execPath, args: [FAKE_AGY], env_pass: ['FAKE_AGY_STATE'], ...extra })
const mail = (n, extra = {}) => ({ id: uid(n), from_node: 'W', from_agent: 'W-政策', trust: 'member', body: `內文-${n}`, to_agent: 'Gemini', ...extra })

test('橋＋acp：名單帶 engine=gemini；信送進工作者，回覆帶 reply_to 寄回寄件人，from_agent 是工作者名，信被 ack', async () => {
  const r = await run({ inbox: [mail(1, { body: '你好' })], workers: [worker({ label: '工作者' })], until: c => c.st.sent.some(s => s.reply_to === uid(1)) && c.st.acked.has(uid(1)) })
  const reply = r.st.sent.find(s => s.reply_to === uid(1))
  assert.equal(reply.to_node, 'W'); assert.equal(reply.to_agent, 'W-政策'); assert.equal(reply.from_agent, 'Gemini')
  assert.match(reply.body, /收到：你好/)
  const roster = r.st.rosterPosts.at(-1).agents
  assert.deepEqual(roster, [{ name: 'Gemini', status: 'idle', cwd_label: '工作者', engine: 'gemini' }])
  assert.match(r.log, /handed id=00000000-0000-0000-0000-000000000001 from=W\/W-政策 to=Gemini/)
})

test('橋＋acp：信件標頭的 engine= 用名單上的名稱（gemini）；白名單環境仍有 HOME（登入憑證檔要靠它）', async () => {
  const r = await run({ inbox: [mail(1, { body: '@@HEAD' }), mail(2, { body: '@@ENV HOME' })], workers: [worker()], until: c => c.st.sent.some(s => s.reply_to === uid(1)) && c.st.sent.some(s => s.reply_to === uid(2)) })
  assert.match(r.st.sent.find(s => s.reply_to === uid(1)).body, /^\[RELAY 來信\] trust=member from=W\/W-政策 to=Gemini id=\S+ engine=gemini reply=\?$/)
  assert.match(r.st.sent.find(s => s.reply_to === uid(2)).body, /\[env HOME=present\]/)
})

test('橋＋acp：沒登入——寄件人收到說明（不吞信），信被 ack，名單標 login-required', async () => {
  const r = await run({
    inbox: [mail(1, { body: '@@AUTH' })], workers: [worker()],
    until: c => c.st.sent.some(s => s.reply_to === uid(1) && /需要登入/.test(s.body)) && c.st.acked.has(uid(1)) && c.st.rosterPosts.some(p => p.agents.some(a => a.status === 'login-required')),
  })
  const note = r.st.sent.find(s => s.reply_to === uid(1))
  assert.match(note.body, /^\[收發室\] 轉交給 Gemini 失敗：Gemini 需要登入/)
})

test('橋＋acp：沒指定收件人且預設視窗不在線——背景工作者不代收（信留在 inbox）', async () => {
  const r = await run({ inbox: [mail(1, { to_agent: null })], workers: [worker()], until: c => /no interactive session online/.test(c.log) })
  assert.equal(r.st.acked.has(uid(1)), false)
  assert.equal(r.st.sent.length, 0)
})

test('橋＋acp：問我模式——詢問信寄給 XISU，XISU 回「允許」後放行，確認信與最後回覆各自寄對地方', async () => {
  const inbox = [mail(1, { body: '@@RUN echo hi' })]
  const w = worker({ permissions: { execute: 'ask' }, ask: { notify: [{ node: 'XISU', agent: '希緒' }], timeout_ms: 20000 } })
  let injected = false
  const r = await run({
    inbox, workers: [w],
    until: c => {
      const ask = c.st.sent.find(s => s.to_node === 'XISU' && /授權詢問/.test(s.body))
      if (ask && !injected) {
        injected = true
        const id = /授權詢問 ([0-9A-F]{4})/.exec(ask.body)[1]
        inbox.push({ id: uid(2), from_node: 'XISU', from_agent: '希緒', trust: 'owner', to_agent: 'Gemini', body: `允許 ${id}` })
      }
      return c.st.sent.some(s => s.reply_to === uid(1) && /ran-after-grant/.test(s.body)) && c.st.sent.some(s => s.reply_to === uid(2) && /已收到：允許/.test(s.body))
    },
  })
  assert.equal(r.st.sent.find(s => s.reply_to === uid(2)).to_node, 'XISU')
  assert.equal(r.st.sent.find(s => s.reply_to === uid(1)).to_node, 'W')
})

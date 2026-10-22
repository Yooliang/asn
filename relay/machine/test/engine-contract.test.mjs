// 轉接器介面契約測試：用假引擎（fake-engine.mjs）把 bridge.mjs 主流程跑一遍——名單上報（含 engine）、轉交、SENT／FAIL、回覆寄回、
// 找不到視窗；另外驗證 loadEngines 的介面檢查，以及 Claude 轉接器符合介面。之後新增 Codex 轉接器照這份測試的形狀驗證即可。
// 執行：node --test relay/machine/test/
import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnTracked } from './spawn-tracked.mjs'
import { fileURLToPath } from 'node:url'
import { REQUIRED_METHODS, loadEngines, validateEngine } from '../engines/index.mjs'
import { findCaller } from '../identity.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const MACHINE = path.join(here, '..')
const FAKE = path.join(here, 'fake-engine.mjs')
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
    if (a === 'inbox') return out(200, { messages: st.rosterPosts.length ? inbox.filter(m => !st.acked.has(m.id)) : [] })   // 橋第一次回報名單之後才交信（負載高時名單晚到，信會被判成找不到視窗）
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

async function runWithFakeEngine({ inbox, windows, env = {}, until }) {
  const st = await fakeRelay(inbox)
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'irori-engine-test-'))
  const winFile = path.join(home, 'windows.json'), rec = path.join(home, 'record.jsonl')
  fs.writeFileSync(winFile, JSON.stringify(windows))
  const child = spawnTracked(process.execPath, [path.join(MACHINE, 'bridge.mjs')], {
    cwd: home, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true,
    env: {
      PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, HOME: home, USERPROFILE: home,
      IRORI_RELAY_ID: 'T', IRORI_RELAY_KEY: 'fake-test-key', IRORI_LAUNCH_NO_AUTO: '1', IRORI_RELAY_URL: `http://127.0.0.1:${st.port}`,
      IRORI_RELAY_POLL_MS: '200', IRORI_ROSTER_MS: '150', IRORI_ENGINES: FAKE,
      FAKE_ENGINE_WINDOWS: winFile, FAKE_ENGINE_RECORD: rec, ...env,
    },
  })
  let log = ''; child.stderr.on('data', d => log += d)
  const records = () => { try { return fs.readFileSync(rec, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) } catch { return [] } }
  const t0 = Date.now()
  while (!until({ st, log, records: records() }) && Date.now() - t0 < 15000) await sleep(50)
  await sleep(500)
  const final = { st, log, records: records() }
  const ok = until(final)
  child.kill()
  await new Promise(r => child.once('exit', r))
  await st.close()
  try { fs.rmSync(home, { recursive: true, force: true }) } catch {}
  assert.ok(ok, `condition not reached\n--- bridge log ---\n${log}`)
  return final
}

const mail = (n, extra = {}) => ({ id: uid(n), from_node: 'W', from_agent: 'W-政策', trust: 'member', body: `內文-${n}`, to_agent: '假視窗甲', ...extra })
const wins = [{ name: '假視窗甲', status: 'idle', cwd_label: 'proj' }, { name: '假視窗乙', status: 'busy', cwd_label: 'other' }]

test('契約：名單上報帶 engine、不含 hidden 視窗；沒有 openWindow 能力時 launcher 為 null', async () => {
  const r = await runWithFakeEngine({ inbox: [], windows: [...wins, { name: '隱藏', status: 'idle', cwd_label: 'x', hidden: true }], until: c => c.st.rosterPosts.length > 0 })
  const body = r.st.rosterPosts[0]
  assert.deepEqual(body.agents, [
    { name: '假視窗甲', status: 'idle', cwd_label: 'proj', engine: 'fake' },
    { name: '假視窗乙', status: 'busy', cwd_label: 'other', engine: 'fake' },
  ])
  assert.equal(body.launcher, null)
})

test('契約：轉交一封信 → deliver 收到全文與標頭（含 engine）→ onSent 後 ack → onReply 寄回 reply_to', async () => {
  const r = await runWithFakeEngine({
    inbox: [mail(1)], windows: wins, env: { FAKE_ENGINE_REPLY: '收到了' },
    until: c => c.st.acked.has(uid(1)) && c.st.sent.some(s => s.reply_to === uid(1)),
  })
  assert.equal(r.records.length, 1)
  assert.equal(r.records[0].id, uid(1))
  assert.equal(r.records[0].to, '假視窗甲')
  assert.match(r.records[0].text, /^\[RELAY 來信\] trust=member from=W\/W-政策 to=假視窗甲 id=00000000-0000-0000-0000-000000000001 engine=fake reply=\?\n內文-1$/)
  const back = r.st.sent.find(s => s.reply_to === uid(1))
  assert.equal(back.to_node, 'W'); assert.equal(back.to_agent, 'W-政策'); assert.equal(back.body, '收到了'); assert.equal(back.from_agent, '假視窗甲')
})

test('契約：視窗回信自己加了「[回覆 id=… → …]」抬頭 → 橋寄回前拆掉，內文只剩正文（issue #16）', async () => {
  const r = await runWithFakeEngine({
    inbox: [mail(1)], windows: wins, env: { FAKE_ENGINE_REPLY: `[回覆 id=${uid(1)} → W/W-政策] 收到了` },
    until: c => c.st.acked.has(uid(1)) && c.st.sent.some(s => s.reply_to === uid(1)),
  })
  const back = r.st.sent.find(s => s.reply_to === uid(1))
  assert.equal(back.body, '收到了')
})

test('契約：onFail → 寄「轉交失敗」給寄件人並 ack', async () => {
  const r = await runWithFakeEngine({
    inbox: [mail(2)], windows: wins, env: { FAKE_ENGINE_FAIL: '假的失敗原因' },
    until: c => c.st.acked.has(uid(2)) && c.st.sent.length > 0,
  })
  assert.match(r.st.sent[0].body, /轉交給 假視窗甲 失敗：假的失敗原因/)
  assert.equal(r.st.sent[0].reply_to, uid(2))
})

test('契約：不在名單上的視窗 → 不呼叫 deliver，回「找不到」並列出可達名單', async () => {
  const r = await runWithFakeEngine({
    inbox: [mail(3, { to_agent: '不存在' })], windows: wins,
    until: c => c.st.acked.has(uid(3)) && c.st.sent.length > 0,
  })
  assert.equal(r.records.length, 0)
  assert.match(r.st.sent[0].body, /找不到名叫「不存在」的 session（目前可達：假視窗甲、假視窗乙）/)
})

test('契約：loadEngines 檢查介面，缺方法就拒絕', async () => {
  assert.throws(() => validateEngine({ id: 'x' }), /缺方法/)
  assert.throws(() => validateEngine({}), /缺 id/)
  const e = (await loadEngines({ log() {}, workDir: os.tmpdir(), mailboxName: 'T-收發室' }, 'claude'))[0]
  assert.equal(e.id, 'claude')
  for (const m of REQUIRED_METHODS) assert.equal(typeof e[m], 'function', m)
  assert.deepEqual(e.capabilities(), { listWindows: true, deliver: true, openWindow: true, selfRecv: true, identity: true, fallbackByActivity: true })
  assert.equal(typeof e.openWindow, 'function'); assert.equal(typeof e.childEnv, 'function'); assert.equal(e.identity.engine, 'claude')
  const f = (await loadEngines({ log() {}, workDir: os.tmpdir(), mailboxName: 'T-收發室' }, FAKE))[0]
  assert.equal(f.id, 'fake')
  await assert.rejects(loadEngines({ log() {}, workDir: os.tmpdir(), mailboxName: 'x' }, ' , '), /空的/)
})

test('契約：身分判定經轉接器 identity 區塊；命中者帶 engine，全部沒命中就拒絕', () => {
  const hit = { engine: 'fake', inspectCaller: () => ({ viaChain: { pid: 7, name: '假視窗甲' }, viaEnv: null }) }
  const miss = { engine: 'claude', inspectCaller: () => ({ viaChain: null, viaEnv: null, tableError: null }) }
  assert.deepEqual(findCaller('寄信', [miss, hit]), { pid: 7, name: '假視窗甲', engine: 'fake' })
  assert.throws(() => findCaller('寄信', [miss]), /找不到呼叫者所屬的 Claude 視窗/)
  const noName = { engine: 'fake', inspectCaller: () => ({ viaChain: { pid: 9, name: '' } }) }
  assert.throws(() => findCaller('收信', [noName]), /沒有名字，無法當收件人/)
})

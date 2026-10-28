// pi 轉接器（#456）：名單（讀登記檔）、投遞（寫收件匣）、清理，以及接上真的 bridge.mjs 的名單上報（active_at、model）。
// 完全在暫存資料夾裡跑，不碰真的 ~/.asn。執行：node --test relay/machine/test/pi-engine.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnTracked } from './spawn-tracked.mjs'
import { loadEngines, validateEngine } from '../engines/index.mjs'
import { OLD_EXT_DETAIL, cleanup, createEngine, inboxDir, readWindows, windowsDir, writeInbox } from '../engines/pi.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const MACHINE = path.join(here, '..')
const NOW = 1_800_000_000_000
const sleep = ms => new Promise(r => setTimeout(r, ms))
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'asn-pi-engine-'))
const alive = new Set([100, 200, 300])
const isAlive = pid => alive.has(pid)
const ID = '11111111-1111-4111-8111-111111111111'

function putWindow(home, sid, over = {}) {
  const d = windowsDir(home)
  fs.mkdirSync(d, { recursive: true })
  fs.writeFileSync(path.join(d, `${sid}.json`), JSON.stringify({ v: 1, engine: 'pi', sessionId: sid, name: sid, pid: 100, cwd: '/home/u/proj', state: 'idle', at: NOW, ext: 2, ...over }))
}

test('名單：只收檔名＝sessionId、engine 是 pi、pid 活著、時間新的；欄位對得上', () => {
  const h = tmp()
  putWindow(h, 'a', { name: '甲', model: 'MiniMax-M2', provider: 'minimax', state: 'busy' })
  putWindow(h, 'dead', { pid: 999 })
  putWindow(h, 'old', { at: NOW - 6 * 60 * 1000 })
  putWindow(h, 'wrongid', { sessionId: 'other' })
  putWindow(h, 'notpi', { engine: 'claude' })
  putWindow(h, 'noname', { name: '  ' })
  fs.writeFileSync(path.join(windowsDir(h), 'bad.json'), '{not json')
  fs.writeFileSync(path.join(windowsDir(h), 'big.json'), ' '.repeat(20 * 1024))
  fs.writeFileSync(path.join(windowsDir(h), 'a b.json'), '{}')
  const ws = readWindows(windowsDir(h), NOW, isAlive)
  assert.equal(ws.length, 1)
  assert.deepEqual(ws[0], { name: '甲', status: 'busy', cwd: '/home/u/proj', cwd_label: 'proj', engine: 'pi', pid: 100, sessionId: 'a', mod_loaded: true, model: 'minimax/MiniMax-M2' })
  assert.deepEqual(readWindows(path.join(h, '沒有'), NOW, isAlive), [], '資料夾不存在＝沒有')
})

test('名單：擴充太舊（沒有 ext）名單上提醒更新；名字重複的後者加 -pid；名字裡的斜線與控制字元會換掉', () => {
  const h = tmp()
  putWindow(h, 'a', { name: '同名', ext: undefined })
  putWindow(h, 'b', { name: '同名', pid: 200 })
  putWindow(h, 'c', { name: 'x/y\\z\n', pid: 300 })
  const ws = readWindows(windowsDir(h), NOW, isAlive)
  assert.deepEqual(ws.map(w => w.name).sort(), ['x-y-z', '同名', '同名-200'].sort())
  assert.equal(ws.find(w => w.name === '同名').detail, OLD_EXT_DETAIL)
  assert.equal(ws.find(w => w.name === '同名-200').detail, undefined)
})

test('投遞：寫進 pi-inbox/<視窗>/<信件編號>.json；同編號覆蓋；已在 done/ 的不再寫；不合法的編號擋下', () => {
  const h = tmp()
  writeInbox(h, 'a', ID, '甲', '第一次', NOW)
  const f = path.join(inboxDir(h), 'a', `${ID}.json`)
  assert.deepEqual(JSON.parse(fs.readFileSync(f, 'utf8')), { v: 1, id: ID, to: '甲', text: '第一次', at: NOW })
  writeInbox(h, 'a', ID, '甲', '第二次', NOW)
  assert.equal(JSON.parse(fs.readFileSync(f, 'utf8')).text, '第二次')
  assert.deepEqual(fs.readdirSync(path.join(inboxDir(h), 'a')), [`${ID}.json`], '沒有留下暫存檔')
  fs.mkdirSync(path.join(inboxDir(h), 'a', 'done'))
  fs.writeFileSync(path.join(inboxDir(h), 'a', 'done', 'x1.json'), '{}')
  writeInbox(h, 'a', 'x1', '甲', '不該寫', NOW)
  assert.ok(!fs.existsSync(path.join(inboxDir(h), 'a', 'x1.json')))
  assert.throws(() => writeInbox(h, '../a', ID, '甲', 't', NOW), /不合法/)
  assert.throws(() => writeInbox(h, 'a', '../x', '甲', 't', NOW), /不合法/)
  assert.throws(() => writeInbox(h, 'a', 'big', '甲', 'x'.repeat(256 * 1024 + 1), NOW), /太大/)
})

test('投遞：未處理的信積到上限就拒收（覆蓋舊編號除外）', () => {
  const h = tmp()
  for (let i = 0; i < 200; i++) writeInbox(h, 'a', `m${i}`, '甲', 't', NOW)
  assert.throws(() => writeInbox(h, 'a', 'm200', '甲', 't', NOW), /已積 200 封/)
  writeInbox(h, 'a', 'm5', '甲', '覆蓋', NOW)
})

test('清理：pid 已死且超過一天的登記檔刪掉；沒有登記檔又超過 7 天的收件匣刪掉；活著的與新的不動', () => {
  const h = tmp()
  putWindow(h, 'live')
  putWindow(h, 'deadnew', { pid: 999, at: NOW - 60_000 })
  putWindow(h, 'deadold', { pid: 999, at: NOW - 2 * 24 * 3600 * 1000 })
  for (const s of ['live', 'orphan-old', 'orphan-new']) writeInbox(h, s, ID, 'x', 't', NOW)
  const old = new Date(NOW - 8 * 24 * 3600 * 1000)
  fs.utimesSync(path.join(inboxDir(h), 'orphan-old'), old, old)
  fs.utimesSync(path.join(inboxDir(h), 'orphan-new'), new Date(NOW - 1000), new Date(NOW - 1000))
  const n = cleanup(h, NOW, isAlive)
  assert.equal(n, 2)
  assert.deepEqual(fs.readdirSync(windowsDir(h)).sort(), ['deadnew.json', 'live.json'])
  assert.deepEqual(fs.readdirSync(inboxDir(h)).sort(), ['live', 'orphan-new'])
})

test('轉接器：符合介面；deliver 寫收件匣後才回報已轉交；視窗不在線同步 throw', async () => {
  const h = tmp()
  putWindow(h, 'a', { name: '甲' })
  const sent = []
  const e = validateEngine(createEngine({ log: () => {}, deps: { home: h, now: () => NOW, alive: isAlive } }))
  e.start({ onSent: id => sent.push(id) })
  const l = await e.listWindows()
  assert.deepEqual(l.windows.map(w => w.name), ['甲'])
  assert.deepEqual([...(await e.listNames())], ['甲'])
  e.deliver({ id: ID, to: '甲', text: '全文' })
  assert.ok(fs.existsSync(path.join(inboxDir(h), 'a', `${ID}.json`)))
  await sleep(10)
  assert.deepEqual(sent, [ID])
  assert.throws(() => e.deliver({ id: 'z', to: '不在', text: 't' }), /不在線/)
  assert.ok(!fs.existsSync(path.join(inboxDir(h), 'a', 'z.json')))
})

test('載入：ASN_ENGINES 可以寫 pi', async () => {
  const engines = await loadEngines({ log: () => {}, env: { ASN_HOME: tmp() } }, 'pi')
  assert.deepEqual(engines.map(e => e.id), ['pi'])
})

// ---- 接上真的 bridge.mjs ----
const readBody = req => new Promise(r => { let b = ''; req.on('data', d => b += d); req.on('end', () => r(b ? JSON.parse(b) : null)) })
test('橋：pi 視窗上報帶 engine/model/detail/mod_loaded；忙碌的視窗帶 active_at；信投遞成功後閒著的視窗也帶 active_at，信落在收件匣', async () => {
  const st = { rosterPosts: [], acked: new Set() }
  const mail = { id: ID, from_node: 'W', from_agent: 'W-政策', trust: 'member', body: '你好', to_agent: '閒的', expects_reply: false }
  const srv = http.createServer(async (req, res) => {
    const a = new URL(req.url, 'http://x').searchParams.get('action')
    const out = (c, o) => { res.writeHead(c, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)) }
    if (a === 'whoami') return out(200, { node: 'T', bell_topic: 'bell-test' })
    if (a === 'inbox') return out(200, { messages: st.rosterPosts.length ? [mail].filter(m => !st.acked.has(m.id)) : [] })
    if (a === 'ack') { (await readBody(req)).ids.forEach(i => st.acked.add(i)); return out(200, {}) }
    if (a === 'roster') { st.rosterPosts.push(await readBody(req)); return out(200, {}) }
    if (a === 'launch_pending') return out(200, { launches: [] })
    out(200, {})
  })
  await new Promise(r => srv.listen(0, '127.0.0.1', r))
  const home = tmp()
  const asn = path.join(home, '.asn')
  const at = Date.now()
  putWindow(asn, 'idle1', { name: '閒的', pid: process.pid, at, model: 'm1' })
  putWindow(asn, 'busy1', { name: '忙的', pid: process.pid, state: 'busy', at, ext: undefined })
  const child = spawnTracked(process.execPath, [path.join(MACHINE, 'bridge.mjs')], {
    cwd: home, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true,
    env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, HOME: home, USERPROFILE: home, ASN_HOME: asn, ASN_RELAY_ID: 'T', ASN_RELAY_KEY: 'fake-test-key', ASN_LAUNCH_NO_AUTO: '1',
      ASN_RELAY_URL: `http://127.0.0.1:${srv.address().port}`, ASN_RELAY_POLL_MS: '200', ASN_ROSTER_MS: '150', ASN_ENGINES: 'pi' },
  })
  let log = ''; child.stderr.on('data', d => log += d)
  const idleEntry = () => st.rosterPosts.at(-1)?.agents?.find(a => a.name === '閒的')
  const t0 = Date.now()
  while (!(st.acked.has(ID) && idleEntry()?.active_at) && Date.now() - t0 < 15000) await sleep(50)
  const last = st.rosterPosts.at(-1)
  child.kill(); await new Promise(r => child.once('exit', r)); srv.closeAllConnections?.(); await new Promise(r => srv.close(r))
  const idle = last.agents.find(a => a.name === '閒的'), busy = last.agents.find(a => a.name === '忙的')
  assert.ok(st.acked.has(ID), `信沒有 ack\n${log}`)
  assert.ok(fs.existsSync(path.join(inboxDir(asn), 'idle1', `${ID}.json`)), '信要落在收件匣')
  assert.equal(idle.engine, 'pi'); assert.equal(idle.model, 'm1'); assert.equal(idle.mod_loaded, true); assert.equal(idle.detail, undefined)
  assert.ok(Math.abs(idle.active_at - Date.now()) < 20_000, `投遞成功後要有 active_at：${idle.active_at}`)
  assert.equal(busy.detail, OLD_EXT_DETAIL)
  assert.ok(Math.abs(busy.active_at - Date.now()) < 20_000, '忙碌的視窗帶 active_at')
  assert.ok(!st.rosterPosts[0].agents.find(a => a.name === '閒的').active_at, '還沒收過信也不忙的視窗不帶')
})

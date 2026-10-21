// 回覆對應表持久化（pending.json）：橋重啟後遲到／等待中的回覆仍寄回、對不上的回覆轉給最近交辦者、過期清理、檔案損毀安全忽略。
// 用假仲介伺服器＋假 claude；同一個 home 可連續啟動兩次橋來模擬重啟。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { snapshot, loadState, saveAtomic } from '../pending-store.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const MACHINE = path.join(here, '..')
const sleep = ms => new Promise(r => setTimeout(r, ms))
const readBody = req => new Promise(r => { let b = ''; req.on('data', d => b += d); req.on('end', () => r(b ? JSON.parse(b) : null)) })
const uid = n => `00000000-0000-0000-0000-${n.toString(16).padStart(12, '0')}`
const mail = (n, extra = {}) => ({ id: uid(n), from_node: 'W', from_agent: 'W-政策', to_agent: 'T-對方', trust: 'member', body: `機密內文-${n}`, ...extra })

async function fakeServer(mails = []) {
  const inbox = []
  setTimeout(() => inbox.push(...mails), 1200)
  const st = { acked: new Set(), sent: [], posts: [] }
  const srv = http.createServer(async (req, res) => {
    const a = new URL(req.url, 'http://x').searchParams.get('action')
    const out = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)) }
    if (a === 'whoami') return out(200, { node: 'T', bell_topic: 'bell-test' })
    if (a === 'inbox') return out(200, { messages: inbox.filter(m => !st.acked.has(m.id)) })
    if (a === 'send') { st.sent.push(await readBody(req)); return out(200, { ok: true }) }
    if (a === 'room_post') { st.posts.push(await readBody(req)); return out(200, { ok: true }) }
    if (a === 'ack') { (await readBody(req)).ids.forEach(i => st.acked.add(i)); return out(200, { ok: true }) }
    if (a === 'roster') { await readBody(req); return out(200, { ok: true }) }
    out(404, {})
  })
  await new Promise(r => srv.listen(0, '127.0.0.1', r))
  st.port = srv.address().port
  st.close = () => new Promise(r => { srv.closeAllConnections?.(); srv.close(r) })
  return st
}

const NAMES = ['T-對方', 'T-別人']
function makeHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'irori-pending-test-'))
  const dir = path.join(home, '.claude', 'sessions'); fs.mkdirSync(dir, { recursive: true })
  NAMES.forEach((name, i) => fs.writeFileSync(path.join(dir, `${92000 + i}.json`), JSON.stringify({ pid: 92000 + i, entrypoint: 'cli', kind: 'interactive', updatedAt: 1 })))
  fs.writeFileSync(path.join(home, 'agents.json'), JSON.stringify(NAMES.map((name, i) => ({ pid: 92000 + i, cwd: 'D:\\x', kind: 'interactive', startedAt: 1, name, status: 'idle' }))))
  fs.writeFileSync(path.join(home, 'inbound.jsonl'), ''); fs.writeFileSync(path.join(home, 'record.jsonl'), '')
  const work = path.join(home, '.irori-relay', 'machine-T'); fs.mkdirSync(work, { recursive: true })
  return { home, pendingFile: path.join(work, 'pending.json') }
}

function startBridge(h, st, env = {}) {
  const child = spawn(process.execPath, [path.join(MACHINE, 'bridge.mjs')], {
    cwd: h.home, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true,
    env: {
      PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, HOME: h.home, USERPROFILE: h.home,
      IRORI_RELAY_ID: 'T', IRORI_RELAY_KEY: 'fake-test-key', IRORI_LAUNCH_NO_AUTO: '1', IRORI_RELAY_URL: `http://127.0.0.1:${st.port}/relay`,
      IRORI_RELAY_POLL_MS: '200', IRORI_ROSTER_MS: '150', IRORI_RELAY_DEFAULT_AGENT: 'T-對方',
      IRORI_REPLY_TIMEOUT_MS: '60000', IRORI_BRIDGE_TICK_MS: '100', IRORI_NOREPLY_WINDOW_MS: '0',
      IRORI_CLAUDE_SCRIPT: path.join(here, 'fake-claude.mjs'), FAKE_AGENTS: path.join(h.home, 'agents.json'),
      FAKE_RECORD: path.join(h.home, 'record.jsonl'), FAKE_INBOUND: path.join(h.home, 'inbound.jsonl'), ...env,
    },
  })
  const b = { log: '' }
  child.stderr.on('data', d => b.log += d)
  b.says = (text, from = 'T-對方') => fs.appendFileSync(path.join(h.home, 'inbound.jsonl'), JSON.stringify({ from, text }) + '\n')
  b.stop = async () => { child.kill(); await new Promise(r => child.once('exit', r)); await sleep(300) }
  b.until = async (cond, timeout = 15000) => {
    const t0 = Date.now()
    while (!cond() && Date.now() - t0 < timeout) await sleep(50)
    assert.ok(cond(), `condition not reached in ${timeout}ms\n--- bridge log ---\n${b.log}`)
  }
  return b
}
const cleanup = h => { try { fs.rmSync(h.home, { recursive: true, force: true }) } catch {} }
const notices = st => st.sent.filter(s => /沒有經收發室收到/.test(s.body))

test('重啟：還在等的信（waiting）→ 新的橋仍把回覆寄回原寄件人；pending.json 不含信件內文', async () => {
  const st = await fakeServer([mail(1)]), h = makeHome()
  try {
    const b1 = startBridge(h, st)
    await b1.until(() => /forwarded id=/.test(b1.log))
    await b1.until(() => fs.existsSync(h.pendingFile) && JSON.parse(fs.readFileSync(h.pendingFile, 'utf8')).pending.some(p => p.state === 'waiting'))
    const raw = fs.readFileSync(h.pendingFile, 'utf8')
    assert.doesNotMatch(raw, /機密內文/)
    assert.equal(fs.readdirSync(path.dirname(h.pendingFile)).filter(f => f.endsWith('.tmp')).length, 0)
    await b1.stop()
    const b2 = startBridge(h, st)
    await b2.until(() => /pending restored: 1 \(waiting 1, notified 0\)/.test(b2.log))
    b2.says('重啟後的回覆')
    await b2.until(() => /reply from T-對方 -> W id=/.test(b2.log))
    const back = st.sent.filter(s => /重啟後的回覆/.test(s.body))
    assert.equal(back.length, 1); assert.equal(back[0].reply_to, uid(1)); assert.equal(back[0].to_agent, 'W-政策')
    assert.doesNotMatch(back[0].body, /^（遲到/)
    assert.doesNotMatch(b2.log, /unmatched reply/)
    await b2.stop()
  } finally { await st.close(); cleanup(h) }
})

test('重啟：已通知「沒回」的信（notified）→ 新的橋收到遲到回覆仍寄回（帶「遲到的回覆」）', async () => {
  const st = await fakeServer([mail(1)]), h = makeHome()
  try {
    const b1 = startBridge(h, st, { IRORI_REPLY_TIMEOUT_MS: '300' })
    await b1.until(() => notices(st).length >= 1)
    await b1.stop()
    const b2 = startBridge(h, st, { IRORI_REPLY_TIMEOUT_MS: '300' })
    await b2.until(() => /pending restored: 1 \(waiting 0, notified 1\)/.test(b2.log))
    b2.says('重啟後才做完')
    await b2.until(() => /late reply from T-對方/.test(b2.log))
    const back = st.sent.filter(s => /重啟後才做完/.test(s.body))
    assert.equal(back.length, 1); assert.match(back[0].body, /^（遲到的回覆/); assert.equal(back[0].reply_to, uid(1))
    assert.equal(notices(st).length, 1)   // 重啟沒有重複寄通知
    await b2.stop()
  } finally { await st.close(); cleanup(h) }
})

test('對不上的回覆：24 小時內有最近交辦者 → 轉給他（reply_to＝最近那封、內文前加說明）', async () => {
  const st = await fakeServer(), h = makeHome()
  try {
    saveAtomic(h.pendingFile, { version: 1, pending: [], lastRequester: { 'T-對方': { from_node: 'H', from_agent: 'H-主線-3', mail_id: uid(7), t: Date.now() - 3_600_000 } } })
    const b = startBridge(h, st)
    await b.until(() => /pending restored: 0 .*lastRequester 1/.test(b.log))
    b.says('每小時進度：一切順利')
    await b.until(() => /last requester H\/H-主線-3/.test(b.log))
    const back = st.sent.filter(s => /每小時進度/.test(s.body))
    assert.equal(back.length, 1)
    assert.equal(back[0].to_node, 'H'); assert.equal(back[0].to_agent, 'H-主線-3'); assert.equal(back[0].reply_to, uid(7)); assert.equal(back[0].from_agent, 'T-對方')
    assert.match(back[0].body, /^（收發室：這則回覆對不上特定來信，依最近一次交辦轉給你）\n每小時進度/)
    await b.stop()
  } finally { await st.close(); cleanup(h) }
})

test('對不上的回覆：沒有最近交辦者（或從沒交辦過）→ 照舊丟棄，log 寫清楚', async () => {
  const st = await fakeServer(), h = makeHome()
  try {
    const b = startBridge(h, st)
    await b.until(() => /whoami node=T/.test(b.log))
    b.says('沒人要的回覆')
    await b.until(() => /unmatched reply from T-對方 .*dropped: no pending mail and no requester/.test(b.log))
    assert.equal(st.sent.filter(s => /沒人要的回覆/.test(s.body)).length, 0)
    await b.stop()
  } finally { await st.close(); cleanup(h) }
})

test('過期清理：載入時清掉超過保留期的對應與最近交辦者，之後的回覆照舊丟棄', async () => {
  const st = await fakeServer(), h = makeHome()
  try {
    const old = Date.now() - 5000
    saveAtomic(h.pendingFile, {
      version: 1,
      pending: [{ id: uid(1), from_node: 'W', from_agent: 'W-政策', target: 'T-對方', state: 'notified', t0: old, t: old, noReply: false, replied: false, notifiedAt: old, room: null }],
      lastRequester: { 'T-對方': { from_node: 'W', from_agent: 'W-政策', mail_id: uid(1), t: old } },
    })
    const b = startBridge(h, st, { IRORI_LATE_KEEP_MS: '1000' })
    await b.until(() => /whoami node=T/.test(b.log))
    assert.doesNotMatch(b.log, /pending restored: [1-9]/)
    b.says('太晚了')
    await b.until(() => /unmatched reply from T-對方 .*dropped/.test(b.log))
    assert.equal(st.sent.filter(s => /太晚了/.test(s.body)).length, 0)
    await b.stop()
  } finally { await st.close(); cleanup(h) }
})

test('檔案損毀：忽略並照常運作（log 記下），之後重寫成正確的 JSON', async () => {
  const st = await fakeServer([mail(1)]), h = makeHome()
  try {
    fs.writeFileSync(h.pendingFile, '{"version":1,"pending":[{"id":')   // 寫到一半被截斷
    const b = startBridge(h, st)
    await b.until(() => /pending.json unreadable, ignored/.test(b.log))
    await b.until(() => /forwarded id=/.test(b.log))
    await b.until(() => { try { return JSON.parse(fs.readFileSync(h.pendingFile, 'utf8')).pending.length === 1 } catch { return false } })
    await b.stop()
  } finally { await st.close(); cleanup(h) }
})

test('群組（room）回覆的對應也跨重啟：重啟後群組視窗的回覆仍貼回群組', async () => {
  const st = await fakeServer(), h = makeHome()
  try {
    const now = Date.now()
    saveAtomic(h.pendingFile, {
      version: 1,
      pending: [{ id: uid(9), from_node: '', from_agent: '', target: 'T-別人', state: 'waiting', t0: now, t: now, noReply: false, replied: false, notifiedAt: null, room: { id: 'room-1', seq: 4, window: 'T-別人' } }],
      lastRequester: {},
    })
    const b = startBridge(h, st)
    await b.until(() => /pending restored: 1 \(waiting 1/.test(b.log))
    b.says('群組裡的回覆', 'T-別人')
    await b.until(() => /room reply from T-別人 -> room=room-1 #4 posted=true/.test(b.log))
    assert.equal(st.posts.length, 1); assert.equal(st.posts[0].room, 'room-1'); assert.equal(st.posts[0].from_agent, 'T-別人')
    await b.stop()
  } finally { await st.close(); cleanup(h) }
})

test('pending-store 單元：快照只含 waiting／notified；來回一致；欄位怪異的項目被略過；saveAtomic 不留暫存檔', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'irori-store-test-')), file = path.join(dir, 'pending.json')
  try {
    const now = Date.now()
    const m = new Map([
      ['a', { mail: { id: 'a', from_node: 'H', from_agent: 'H-x', body: '不該存' }, target: 'T-1', state: 'waiting', t0: now, t: now, noReply: false, replied: false }],
      ['b', { mail: { id: 'b', from_node: 'H', from_agent: '' }, target: 'T-1', state: 'notified', t0: now, t: now, notifiedAt: now, noReply: false, replied: true }],
      ['c', { mail: { id: 'c', from_node: 'H' }, target: 'T-1', state: 'forwarding', t0: now, t: now }],
    ])
    const snap = snapshot(m, { 'T-1': { from_node: 'H', from_agent: 'H-x', mail_id: 'a', t: now } })
    assert.deepEqual(snap.pending.map(p => p.id), ['a', 'b'])
    assert.doesNotMatch(JSON.stringify(snap), /不該存/)
    saveAtomic(file, snap)
    assert.deepEqual(fs.readdirSync(dir), ['pending.json'])
    const st = loadState(file, now + 1000, 86_400_000)
    assert.equal(st.error, null); assert.deepEqual(st.pending.map(([id]) => id), ['a', 'b'])
    assert.equal(st.pending[1][1].replied, true); assert.equal(st.lastRequester['T-1'].mail_id, 'a')
    // 過期
    assert.equal(loadState(file, now + 90_000_000, 86_400_000).pending.length, 0)
    // 怪異項目與格式
    fs.writeFileSync(file, JSON.stringify({ pending: [null, { id: 1 }, { id: 'x', target: 'T', state: 'notified', t0: now, t: now }], lastRequester: { 'T-1': { from_node: 5 } } }))
    const bad = loadState(file, now, 86_400_000)
    assert.equal(bad.pending.length, 0); assert.equal(bad.dropped, 4); assert.equal(bad.error, null)
    fs.writeFileSync(file, '[1,2]'); assert.ok(loadState(file, now, 1000).error)
    fs.writeFileSync(file, 'not json'); assert.ok(loadState(file, now, 1000).error)
    assert.equal(loadState(path.join(dir, 'missing.json'), now, 1000).error, null)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

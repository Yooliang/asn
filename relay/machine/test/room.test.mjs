// asn-room CLI 測試（本機假伺服器）：身分自動判定、只看得到自己在的群組、只讀不動已讀（一定帶 since、不帶 mark）、
// --last／--since 範圍、群組名也可、不是成員擋下、本機新訊息數；以及機器橋 context() 讀失敗不擋。
// 執行：node --test relay/machine/test/*.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnTracked } from './spawn-tracked.mjs'
import { fileURLToPath } from 'node:url'
import { parseArgs } from '../room.mjs'
import { createRooms } from '../rooms.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const ROOM = path.join(here, '..', 'room.mjs'), WINDOW = path.join(here, 'fake-window.mjs')

const msgs = n => Array.from({ length: n }, (_, i) => ({ seq: i + 1, from: i % 2 ? '~owner' : 'W~W-政策', from_name: i % 2 ? '小良哥' : '政策', trust: i % 2 ? 'owner' : 'member', body: `內文-${i + 1}${i === 2 ? '\n第二行' : ''}`, mentions: [], at: '2026-10-02T03:00:00Z' }))
const ROOMS = [
  { id: 'R1', name: 'Irori 開發', last_seq: 30, last_from_name: '小良哥', last_body: '內文-30', mine: [{ member: 'T~T-視窗甲', read_seq: 0, unread: 30 }, { member: 'T', read_seq: 0 }], messages: msgs(30) },
  { id: 'R2', name: '別的群', last_seq: 3, mine: [{ member: 'T~T-視窗乙', read_seq: 0 }], messages: msgs(3) },
]

async function fakeServer({ forbidRead = false } = {}) {
  const st = { reqs: [] }
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x'), a = u.searchParams.get('action')
    st.reqs.push({ action: a, key: req.headers['x-relay-key'], q: Object.fromEntries(u.searchParams) })
    const out = (c, o) => { res.writeHead(c, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)) }
    if (a === 'room_list') return out(200, { rooms: ROOMS.map(({ messages, ...r }) => r) })
    if (a === 'room_read') {
      if (forbidRead) return out(403, { error: 'not_member' })
      const r = ROOMS.find(x => x.id === u.searchParams.get('room'))
      const since = Number(u.searchParams.get('since')), limit = Number(u.searchParams.get('limit') || 50)
      return out(200, { messages: r.messages.filter(m => m.seq > since).slice(0, limit), last_seq: r.last_seq })
    }
    out(404, { error: 'not_found' })
  })
  await new Promise(r => srv.listen(0, '127.0.0.1', r))
  st.port = srv.address().port; st.close = () => new Promise(r => { srv.closeAllConnections?.(); srv.close(r) })
  return st
}
const newHome = () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'asn-room-test-'))
  fs.mkdirSync(path.join(home, '.asn'), { recursive: true })
  fs.writeFileSync(path.join(home, '.asn', 'T.key'), 'fake-machine-key')
  return home
}
function run(home, st, script, args) {
  return new Promise(res => {
    const c = spawnTracked(process.execPath, [script, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
      env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, HOME: home, USERPROFILE: home, IRORI_RELAY_ID: 'T', IRORI_RELAY_URL: `http://127.0.0.1:${st.port}/relay`, FAKE_WINDOW_SCRIPT: 'room.mjs' },
    })
    let out = '', err = ''; c.stdout.on('data', d => out += d); c.stderr.on('data', d => err += d)
    c.on('close', code => res({ code, out, err }))
  })
}
const asWindow = (home, st, name, args) => run(home, st, WINDOW, [name, ...args])
const reads = st => st.reqs.filter(r => r.action === 'room_read')

test('參數：--rooms／--room-read 二選一；--last 範圍；--last 與 --since 擇一；沒有自填身分的參數', () => {
  assert.deepEqual(parseArgs(['--rooms']), { rooms: true })
  assert.deepEqual(parseArgs(['--room-read', 'R1', '--last', '5', '--json']), { read: 'R1', last: 5, json: true })
  for (const bad of [[], ['--rooms', '--room-read', 'R1'], ['--room-read', 'R1', '--last', '0'], ['--room-read', 'R1', '--last', '201'],
    ['--room-read', 'R1', '--last', '3', '--since', '2'], ['--room-read', 'R1', '--since', '-1'], ['--rooms', '--last', '3'], ['--room-read', 'R1', '--as', 'T-視窗乙']]) {
    assert.throws(() => parseArgs(bad), /.+/, JSON.stringify(bad))
  }
})

test('--rooms：只列我（T~視窗甲）在的群組，帶新訊息數與最後一則；機器金鑰', async () => {
  const st = await fakeServer(), home = newHome()
  try {
    const r = await asWindow(home, st, 'T-視窗甲', ['--rooms'])
    assert.equal(r.code, 0, r.err)
    assert.match(r.out, /^R1　Irori 開發　共 30 則，新訊息 30 則　最後：小良哥：內文-30/m)
    assert.doesNotMatch(r.out, /別的群/)
    assert.ok(st.reqs.every(q => q.key === 'fake-machine-key'))
    assert.equal(reads(st).length, 0)
  } finally { await st.close() }
})

test('--room-read：預設最近 20 則、一定帶 since 不帶 mark、as_agent＝自己；多行內文縮排；讀過後新訊息數歸零', async () => {
  const st = await fakeServer(), home = newHome()
  try {
    const r = await asWindow(home, st, 'T-視窗甲', ['--room-read', 'R1'])
    assert.equal(r.code, 0, r.err)
    assert.deepEqual(reads(st).map(x => [x.q.room, x.q.as_agent, x.q.since, x.q.limit, x.q.mark]), [['R1', 'T-視窗甲', '10', '20', undefined]])
    assert.match(r.out, /^\[群組 Irori 開發\]（R1）第 11～30 則，共 30 則/)
    assert.equal((r.out.match(/^#\d+ /gm) || []).length, 20)
    assert.match(r.out, /^#30 .*小良哥（owner）：\n {4}內文-30/m)
    const again = await asWindow(home, st, 'T-視窗甲', ['--rooms'])
    assert.match(again.out, /新訊息 0 則/)
    // 群組名也可以（不分大小寫）；--since 3 從第 4 則起；--last 2 只兩則；--json 一行一則
    const byName = await asWindow(home, st, 'T-視窗甲', ['--room-read', 'irori 開發', '--last', '2', '--json'])
    assert.equal(byName.code, 0, byName.err)
    const lines = byName.out.trim().split('\n').map(l => JSON.parse(l))
    assert.deepEqual(lines.map(l => l.seq), [29, 30])
    assert.deepEqual(Object.keys(lines[0]).sort(), ['at', 'body', 'from', 'from_name', 'mentions', 'seq', 'trust'])
    const since = await asWindow(home, st, 'T-視窗甲', ['--room-read', 'R1', '--since', '3'])
    assert.match(since.out, /^#4 /m); assert.doesNotMatch(since.out, /^#3 /m)
    assert.ok(reads(st).every(x => x.q.since !== undefined && x.q.mark === undefined))
  } finally { await st.close() }
})

test('不是成員：別人的群組在本機就擋（不打 room_read）；仲介回 403 也擋；認不出視窗拒絕', async () => {
  const st = await fakeServer(), home = newHome()
  try {
    const other = await asWindow(home, st, 'T-視窗甲', ['--room-read', 'R2'])
    assert.equal(other.code, 3); assert.match(other.err, /不在這個群組/)
    assert.equal(reads(st).length, 0)
    const direct = await run(home, st, ROOM, ['--rooms'])
    assert.equal(direct.code, 2); assert.match(direct.err, /找不到呼叫者所屬的 Claude 視窗/)
  } finally { await st.close() }
  const st2 = await fakeServer({ forbidRead: true }), home2 = newHome()
  try {
    const r = await asWindow(home2, st2, 'T-視窗甲', ['--room-read', 'R1'])
    assert.equal(r.code, 3); assert.match(r.err, /不是這個群組的成員/)
  } finally { await st2.close() }
})

test('機器橋 context()：取前面最多 5 則（舊→新、不含自己）、帶 since 與 as_agent；讀失敗回空、不丟例外', async () => {
  const calls = []
  const api = async q => { calls.push(q); return { messages: msgs(30).filter(m => m.seq > Number(/since=(\d+)/.exec(q)[1])).slice(0, 5) } }
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'irori-ctx-test-'))
  const r = createRooms({ api, workDir: work, log: () => {} })
  assert.deepEqual((await r.context('R1', 'T~T-視窗甲', 12)).map(m => m.seq), [7, 8, 9, 10, 11])
  assert.match(calls[0], /^room_read&room=R1&as_agent=T-%E8%A6%96%E7%AA%97%E7%94%B2&since=6&limit=5$/)
  assert.deepEqual((await r.context('R1', 'T', 3)).map(m => m.seq), [1, 2])
  assert.doesNotMatch(calls[1], /as_agent/)
  const logs = []
  const bad = createRooms({ api: async () => { throw new Error('boom') }, workDir: work, log: m => logs.push(m) })
  assert.deepEqual(await bad.context('R1', 'T', 9), [])
  assert.match(logs[0], /room context failed/)
  fs.rmSync(work, { recursive: true, force: true })
})

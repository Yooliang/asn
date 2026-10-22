// 群組轉交測試（本機假伺服器）：bridge.mjs 只轉 for_me、回覆以視窗身分 room_post、游標不重播；bridge-aegis.mjs 白名單。
// 執行：node --test relay/machine/test/
import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { roomUuid } from '../rooms.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const MACHINE = path.join(here, '..')
const sleep = ms => new Promise(r => setTimeout(r, ms))
const readBody = req => new Promise(r => { let b = ''; req.on('data', d => b += d); req.on('end', () => r(b ? JSON.parse(b) : null)) })

// rooms: [{id,name,last_seq,mine:[{member,read_seq}], messages:[{seq,...,forMe:{as_agent: bool}}]}]
// forMe 以 as_agent（節點本身＝''）為鍵，模擬後端依身分決定 for_me；postStatus 控制 room_post 回應碼
async function fakeServer({ rooms, members, aegis = {}, postStatus = 200 }) {
  const st = { reads: [], posts: [], asks: [] }
  const srv = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x')
    const out = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)) }
    if (u.pathname === '/relay') {
      const a = u.searchParams.get('action')
      if (a === 'whoami') return out(200, { node: 'T', bell_topic: 'bell-test' })
      if (a === 'inbox') return out(200, { messages: [] })
      if (a === 'roster' || a === 'ack' || a === 'send') { await readBody(req); return out(200, { ok: true }) }
      if (a === 'room_list') return out(200, { rooms: rooms.map(({ messages, ...r }) => ({ members: [], ...r })) })
      if (a === 'room_read') {
        const id = u.searchParams.get('room'), since = Number(u.searchParams.get('since') || 0), as = u.searchParams.get('as_agent') ?? ''
        st.reads.push({ room: id, as_agent: u.searchParams.get('as_agent'), since, hasSince: u.searchParams.has('since'), mark: u.searchParams.get('mark') })
        const r = rooms.find(x => x.id === id)
        const messages = r.messages.filter(m => m.seq > since).map(({ forMe, ...m }) => ({ ...m, for_me: !!(forMe ?? {})[as] }))
        return out(200, { messages, last_seq: r.last_seq })
      }
      if (a === 'room_post') { st.posts.push(await readBody(req)); return postStatus === 200 ? out(200, { seq: 99 }) : out(postStatus, { error: 'rate' }) }
    }
    if (u.pathname === '/api/v1/agent-chat/ask') {
      const body = await readBody(req); st.asks.push(body)
      const f = aegis[body.target]
      return f ? out(200, f(body)) : out(404, {})
    }
    if (u.pathname === '/api/v1/members') return out(200, members ?? [])
    out(404, {})
  })
  await new Promise(r => srv.listen(0, '127.0.0.1', r))
  st.port = srv.address().port
  st.close = () => new Promise(r => { srv.closeAllConnections?.(); srv.close(r) })
  return st
}

async function runBridge({ script, workName, env = {}, st, setup, until, timeout = 15000, settle = 1000 }) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'irori-rooms-test-'))
  const workDir = path.join(home, '.irori-relay', workName)
  const extra = setup ? setup(home, workDir) : {}
  const child = spawn(process.execPath, [path.join(MACHINE, script)], {
    cwd: home, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true,
    env: {
      PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, HOME: home, USERPROFILE: home,
      IRORI_RELAY_ID: 'T', IRORI_RELAY_KEY: 'fake-test-key', IRORI_LAUNCH_NO_AUTO: '1', IRORI_RELAY_URL: `http://127.0.0.1:${st.port}/relay`,
      IRORI_RELAY_POLL_MS: '200', IRORI_ROSTER_MS: '150', ...extra, ...env,
    },
  })
  let log = ''; child.stderr.on('data', d => log += d)
  const ctx = () => ({ log, home })
  const t0 = Date.now()
  while (!until(ctx()) && Date.now() - t0 < timeout) await sleep(50)
  await sleep(settle)
  const ok = until(ctx()), final = ctx()
  const rec = forwarded(home)
  let cursor = null
  try { cursor = JSON.parse(fs.readFileSync(path.join(workDir, 'rooms-cursor.json'), 'utf8')) } catch {}
  child.kill()
  await new Promise(r => child.once('exit', r))
  await sleep(300)
  try { fs.rmSync(home, { recursive: true, force: true }) } catch {}
  assert.ok(ok, `condition not reached in ${timeout}ms\n--- bridge log ---\n${final.log}`)
  return { ...final, cursor, rec }
}

const SESSIONS = [
  { pid: 92001, name: 'T-視窗甲', updatedAt: 1000 },
  { pid: 92002, name: 'T-預設', updatedAt: 5000 },
]
const mainSetup = (home, workDir) => {
  const dir = path.join(home, '.claude', 'sessions'); fs.mkdirSync(dir, { recursive: true })
  for (const a of SESSIONS) fs.writeFileSync(path.join(dir, `${a.pid}.json`), JSON.stringify({ pid: a.pid, entrypoint: 'cli', kind: 'interactive', updatedAt: a.updatedAt }))
  const agentsFile = path.join(home, 'agents.json'), record = path.join(home, 'record.jsonl')
  fs.writeFileSync(agentsFile, JSON.stringify(SESSIONS.map(a => ({ pid: a.pid, cwd: 'D:\\x', kind: 'interactive', startedAt: 1, name: a.name, status: 'idle' }))))
  fs.writeFileSync(record, '')
  return { IRORI_CLAUDE_SCRIPT: path.join(here, 'fake-claude.mjs'), FAKE_AGENTS: agentsFile, FAKE_RECORD: record }
}
function forwarded(home) {
  try { return fs.readFileSync(path.join(home, 'record.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) } catch { return [] }
}

const msg = (seq, extra = {}) => ({ seq, from: 'W~W-政策', from_name: '政策', trust: 'member', body: `群組內文-${seq}`, mentions: [], at: 't', forMe: {}, ...extra })
const room = (messages, mine) => ({ id: 'R1', name: '專案群', last_seq: messages.at(-1).seq, mine, messages })
const MAIN_ENV = { IRORI_RELAY_DEFAULT_AGENT: 'T-預設' }

test('bridge 群組：只轉 for_me；點名轉給對的視窗；owner 發的轉；標頭與提示；回覆以 節點~視窗 room_post；游標不重播', async () => {
  const st = await fakeServer({
    rooms: [room([
      msg(2),                                                                                      // 沒人 for_me
      msg(3, { forMe: { 'T-視窗甲': true } }),                                                      // 點名視窗甲
      msg(4, { from: '~owner', from_name: '小良哥', trust: 'owner', forMe: { '': true, 'T-視窗甲': true } }),   // owner 發問
    ], [{ member: 'T~T-視窗甲', read_seq: 1 }, { member: 'T', read_seq: 1 }])],
  })
  try {
    const { rec, cursor, log } = await runBridge({
      script: 'bridge.mjs', workName: 'machine-T', st, setup: mainSetup, env: { ...MAIN_ENV, FAKE_REPLY: '我來回覆' },
      until: ({ home }) => forwarded(home).length >= 3 && st.posts.length >= 3,
    })
    // 恰好 3 次轉交（#2 不轉；重複 pull 不重播）
    assert.equal(rec.length, 3)
    const key = r => `${r.to}#${r.text.match(/ #(\d+)\n/)[1]}`
    assert.deepEqual(rec.map(key).sort(), ['T-視窗甲#3', 'T-視窗甲#4', 'T-預設#4'])
    assert.ok(!rec.some(r => / #2\n/.test(r.text)))   // #2 不單獨轉（但會出現在 #3、#4 的上下文裡）
    // 節點本身 → 預設收件人；id 是確定性 UUID
    const d4 = rec.find(r => key(r) === 'T-預設#4')
    assert.equal(d4.id, roomUuid('R1', 4, 'T')); assert.match(d4.id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
    assert.equal(rec.find(r => key(r) === 'T-視窗甲#4').id, roomUuid('R1', 4, 'T~T-視窗甲'))
    // 標頭、提示、內文
    const j3 = rec.find(r => key(r) === 'T-視窗甲#3').text
    assert.match(j3, /\n\[群組 專案群\] trust=member from=W\/W-政策 #3\n（群組訊息；只有被點名或帳號擁有者本人發問才需要回，回覆會經收發室貼回群組；不需要回就不要回）\n群組內文-3\n---- 前面 1 則（舊→新）----\n#2 政策：群組內文-2\n（要看更多：node "[^"]+room\.mjs" --room-read R1 --last 20）\nMAIL>>>$/)
    // #4 的上下文是 #2、#3（舊→新），不含自己
    assert.match(d4.text, /---- 前面 2 則（舊→新）----\n#2 政策：群組內文-2\n#3 政策：群組內文-3\n（要看更多/)
    // 所有 room_read 都帶 since、不帶 mark（不動後端已讀）
    assert.ok(st.reads.length > 0 && st.reads.every(r => r.hasSince && r.mark === null))
    assert.match(d4.text, /\[群組 專案群\] trust=owner from=主人 #4\n/)
    // room_read：視窗帶 as_agent、節點本身不帶；since 從 read_seq 起算
    assert.ok(st.reads.some(r => r.as_agent === 'T-視窗甲' && r.since === 1))
    assert.ok(st.reads.some(r => r.as_agent === null && r.since === 1))
    // 回覆經收發室後以 節點~視窗 的身分貼回群組（from_agent 由橋帶視窗名，仲介組成 節點~視窗名）
    assert.equal(st.posts.length, 3)
    assert.ok(st.posts.every(p => p.room === 'R1' && p.body === '我來回覆'))
    // 節點本身是成員（key＝T）時以節點發言，不帶 from_agent；視窗成員才帶視窗名
    assert.deepEqual(st.posts.map(p => p.from_agent ?? null).sort(), ['T-視窗甲', 'T-視窗甲', null])
    // 游標推進到 last_seq，之後不再讀
    assert.equal(cursor['R1|T~T-視窗甲'], 4); assert.equal(cursor['R1|T'], 4)
    assert.ok(!/forward failed|逾時/.test(log))
  } finally { await st.close() }
})

test('bridge 群組：沒有游標且 read_seq=0 → 從 last_seq 起算不補播；既有游標檔不重播；視窗不可轉交→略過並推進游標', async () => {
  const st = await fakeServer({
    rooms: [room([
      msg(2, { forMe: { 'T-視窗甲': true, '': true } }),
      msg(3, { forMe: { 'T-視窗甲': true, '': true, 'T-不在': true } }),
    ], [{ member: 'T~T-視窗甲', read_seq: 0 }, { member: 'T', read_seq: 0 }, { member: 'T~T-不在', read_seq: 1 }])],
  })
  try {
    const { rec, cursor, log } = await runBridge({
      script: 'bridge.mjs', workName: 'machine-T', st, env: MAIN_ENV,
      setup: (home, workDir) => { fs.mkdirSync(workDir, { recursive: true }); fs.writeFileSync(path.join(workDir, 'rooms-cursor.json'), JSON.stringify({ 'R1|T~T-視窗甲': 2 })); return mainSetup(home, workDir) },
      until: ({ log }) => /window T-不在 not forwardable: skipped/.test(log),
    })
    // 視窗甲：既有游標 2 → 只轉 #3；節點本身：無游標＋read_seq=0 → 起算點 last_seq=3 → 不轉；T-不在：略過
    assert.deepEqual(rec.map(r => `${r.to}`), ['T-視窗甲'])
    assert.match(rec[0].text, /#3\n/)
    assert.equal(cursor['R1|T'], 3); assert.equal(cursor['R1|T~T-不在'], 3)
    assert.match(log, /not forwardable: skipped/)
  } finally { await st.close() }
})

test('bridge 群組：回覆含（不需回覆）不貼回；room_post 429 只記 log 不重試', async () => {
  const mk = () => fakeServer({ rooms: [room([msg(2, { forMe: { 'T-視窗甲': true } })], [{ member: 'T~T-視窗甲', read_seq: 1 }])] })
  let st = await mk()
  try {
    await runBridge({
      script: 'bridge.mjs', workName: 'machine-T', st, setup: mainSetup, env: { ...MAIN_ENV, FAKE_REPLY: '好的（不需回覆）' },
      until: ({ log }) => /marked no-reply: not posted/.test(log),
    })
    assert.equal(st.posts.length, 0)
  } finally { await st.close() }
  st = await fakeServer({ rooms: [room([msg(2, { forMe: { 'T-視窗甲': true } })], [{ member: 'T~T-視窗甲', read_seq: 1 }])], postStatus: 429 })
  try {
    const { log } = await runBridge({
      script: 'bridge.mjs', workName: 'machine-T', st, setup: mainSetup, env: { ...MAIN_ENV, FAKE_REPLY: '回覆內容' },
      until: ({ log }) => /rate-limited/.test(log),
    })
    assert.equal(st.posts.length, 1)   // 試了一次，不重試
  } finally { await st.close() }
})

test('aegis 群組：白名單外（含節點本身→預設成員不在白名單）不問；白名單內問並以名字 room_post；ask 失敗不貼；游標推進', async () => {
  const hdr = '[群組 專案群] trust=owner from=主人 #2\n（群組訊息；只有被點名或帳號擁有者本人發問才需要回，回覆會經收發室貼回群組；不需要回就不要回）\n群組內文-2'
  const st = await fakeServer({
    members: [{ slug: 'alpha', name: '阿爾法' }, { slug: 'bad', name: '壞人' }],
    aegis: {
      alpha: () => ({ answer: '阿爾法的群組回答', status: 'success', member: 'alpha' }),
      bad: () => ({ answer: '', status: 'error', member: 'bad' }),
      secret: () => ({ answer: 'x', status: 'success', member: 'secret' }),
    },
    rooms: [room([msg(2, { from: '~owner', from_name: '小良哥', trust: 'owner', forMe: { '阿爾法': true, 'bad': true, 'secret': true, '': true } })], [
      { member: 'T~阿爾法', read_seq: 1 }, { member: 'T~bad', read_seq: 1 }, { member: 'T~secret', read_seq: 1 }, { member: 'T', read_seq: 1 },
    ])],
  })
  try {
    const { cursor, log } = await runBridge({
      script: 'bridge-aegis.mjs', workName: 'aegis-T', st,
      env: { IRORI_AEGIS_URL: `http://127.0.0.1:${st.port}`, IRORI_AEGIS_ALLOW: 'alpha,bad', IRORI_AEGIS_RETRY_MS: '100' },
      until: () => st.posts.length >= 1 && st.asks.some(a => a.target === 'bad'),
    })
    assert.ok(!st.asks.some(a => a.target === 'secret'))      // 白名單外不問
    assert.ok(!st.asks.some(a => a.target === 'aegis'))       // 節點本身→預設成員 aegis 不在白名單
    const alpha = st.asks.filter(a => a.target === 'alpha')
    assert.equal(alpha.length, 1); assert.equal(alpha[0].question, hdr)
    assert.equal(st.posts.length, 1)                            // bad 失敗不貼
    assert.deepEqual(st.posts[0], { room: 'R1', body: '阿爾法的群組回答', from_agent: '阿爾法' })
    assert.match(log, /not in allowlist: skipped/); assert.match(log, /to=bad ask failed/)
    for (const k of ['R1|T~阿爾法', 'R1|T~bad', 'R1|T~secret', 'R1|T']) assert.equal(cursor[k], 2, k)
  } finally { await st.close() }
})

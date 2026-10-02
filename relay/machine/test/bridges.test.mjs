// 本機假伺服器測試：bridge-aegis.mjs（白名單／ask／重試／404）與 bridge.mjs（預設收件人退路、roster 403 只記一次）。
// 假伺服器用 node 內建 http 模擬仲介 inbox/send/ack/roster/whoami 與 Aegis /ask、/members；不碰任何真實金鑰或網路服務。
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
// bridge.mjs 只認 UUID 形狀的信件 id（SENT/FAIL 解析），所以測試 id 一律用這個
const uid = n => `00000000-0000-0000-0000-${n.toString(16).padStart(12, '0')}`

// aegis: target -> (第幾次呼叫, body) => {http?, json}
async function fakeServer({ inbox, aegis = {}, members }) {
  const st = { acked: new Set(), sent: [], rosterPosts: [], asks: [], inbox }
  const srv = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x')
    const out = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)) }
    if (u.pathname === '/relay') {
      const a = u.searchParams.get('action')
      if (a === 'whoami') return out(200, { node: 'T', bell_topic: 'bell-test' })
      if (a === 'inbox') return out(200, { messages: st.inbox.filter(m => !st.acked.has(m.id)) })
      if (a === 'send') { st.sent.push(await readBody(req)); return out(200, { ok: true }) }
      if (a === 'ack') { (await readBody(req)).ids.forEach(i => st.acked.add(i)); return out(200, { ok: true }) }
      if (a === 'roster') { st.rosterPosts.push(await readBody(req)); return out(403, { error: 'forbidden' }) }
    }
    if (u.pathname === '/api/v1/agent-chat/ask') {
      const body = await readBody(req)
      st.asks.push(body)
      const n = st.asks.filter(x => x.target === body.target).length
      const f = aegis[body.target]
      if (!f) return out(404, { detail: 'member not found' })
      const r = f(n, body)
      return out(r.http ?? 200, r.json)
    }
    if (u.pathname === '/api/v1/members') return out(200, members ?? [])
    out(404, {})
  })
  await new Promise(r => srv.listen(0, '127.0.0.1', r))
  st.port = srv.address().port
  st.close = () => new Promise(r => { srv.closeAllConnections?.(); srv.close(r) })
  return st
}

// setup(home) 可在啟動前放檔並回傳額外環境變數；until({log, home}) 為真就停（再多等 settle 毫秒讓不該發生的事有機會發生）
async function runBridge({ script, env = {}, st, setup, until, timeout = 15000, settle = 800 }) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'irori-bridge-test-'))
  const extra = setup ? setup(home) : {}
  const child = spawn(process.execPath, [path.join(MACHINE, script)], {
    cwd: home, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true,
    env: {
      PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, HOME: home, USERPROFILE: home,
      IRORI_RELAY_ID: 'T', IRORI_RELAY_KEY: 'fake-test-key', IRORI_RELAY_URL: `http://127.0.0.1:${st.port}/relay`,
      IRORI_RELAY_POLL_MS: '200', IRORI_ROSTER_MS: '150', ...extra, ...env,
    },
  })
  let log = ''; child.stderr.on('data', d => log += d)
  const ctx = () => ({ log, home })
  const t0 = Date.now()
  while (!until(ctx()) && Date.now() - t0 < timeout) await sleep(50)
  await sleep(settle)
  const ok = until(ctx())
  const final = ctx()
  child.kill()
  await new Promise(r => child.once('exit', r))
  await sleep(300)   // 讓假 worker 跟著結束
  try { fs.rmSync(home, { recursive: true, force: true }) } catch {}
  assert.ok(ok, `condition not reached in ${timeout}ms\n--- bridge log ---\n${final.log}`)
  return final
}

const mail = (n, extra = {}) => ({ id: uid(n), from_node: 'W', from_agent: 'W-政策', trust: 'member', body: `內文-${n}`, ...extra })

// ------------------------------------------------------------------------ bridge-aegis（任務 B）
test('aegis: 白名單、成功帶 reply_to、error 重試一次、404、其他 status、無 to_agent、roster 403 只記一次', async () => {
  let flakyCalls = 0
  const st = await fakeServer({
    inbox: [
      mail(1),                          // 無 to_agent
      mail(2, { to_agent: 'secret' }),  // 不在白名單
      mail(3, { to_agent: 'alpha' }),   // 成功
      mail(4, { to_agent: 'err' }),     // 一直 error
      mail(5, { to_agent: 'flaky' }),   // 第一次 error 第二次成功
      mail(6, { to_agent: 'ghost' }),   // 白名單內但 Aegis 404
      mail(7, { to_agent: 'weird' }),   // 其他 status
    ],
    members: [{ slug: 'alpha', name: '阿爾法' }, { slug: 'flaky', name: '不穩' }],
    aegis: {
      alpha: () => ({ json: { answer: '你好 alpha 的答案', status: 'success', member: 'alpha', member_name: '阿爾法' } }),
      err: () => ({ json: { answer: '', status: 'error', member: 'err' } }),
      flaky: n => { flakyCalls++; return n === 1 ? { json: { answer: '', status: 'error', member: 'flaky' } } : { json: { answer: '第二次成功', status: 'success', member: 'flaky' } } },
      ghost: () => ({ http: 404, json: { detail: 'nope' } }),
      weird: () => ({ json: { answer: '半途', status: 'timeout', member: 'weird' } }),
    },
  })
  try {
    const { log } = await runBridge({
      script: 'bridge-aegis.mjs', st,
      env: { IRORI_AEGIS_URL: `http://127.0.0.1:${st.port}`, IRORI_AEGIS_ALLOW: 'alpha,err,flaky,ghost,weird', IRORI_AEGIS_RETRY_MS: '100' },
      until: () => st.acked.size >= 7 && st.rosterPosts.length >= 3,
    })
    const by = n => st.sent.filter(s => s.reply_to === uid(n))
    // 無 to_agent：說明並列出白名單（含中文名），不洩漏白名單外的名字
    assert.match(by(1)[0].body, /請指定要問的成員/)
    assert.match(by(1)[0].body, /alpha（阿爾法）/)
    assert.doesNotMatch(by(1)[0].body, /secret/)
    // 白名單擋下：沒有 ask 打到 Aegis
    assert.match(by(2)[0].body, /沒有開放聯絡/)
    assert.equal(st.asks.filter(a => a.target === 'secret').length, 0)
    // 成功：reply_to、from_agent=member slug、寄回原寄件人；question 帶標頭、from_member、stream=false
    assert.equal(by(3).length, 1)
    assert.equal(by(3)[0].body, '你好 alpha 的答案'); assert.equal(by(3)[0].from_agent, 'alpha')
    assert.equal(by(3)[0].to_node, 'W'); assert.equal(by(3)[0].to_agent, 'W-政策')
    const ask = st.asks.find(a => a.target === 'alpha')
    assert.equal(ask.question, '這是透過仲介轉來的信：from=W/W-政策 trust=member\n內文-3')
    assert.equal(ask.from_member, 'xi-xu'); assert.equal(ask.stream, false)
    // error：重試一次（共 2 次 ask），仍失敗寄忙線
    assert.equal(st.asks.filter(a => a.target === 'err').length, 2)
    assert.match(by(4)[0].body, /對方忙線中，請稍後再問/)
    // 第一次 error、第二次成功
    assert.equal(flakyCalls, 2); assert.equal(by(5)[0].body, '第二次成功')
    // 404：不重試
    assert.equal(st.asks.filter(a => a.target === 'ghost').length, 1)
    assert.match(by(6)[0].body, /查無此成員/)
    // 其他 status 照實回報
    assert.match(by(7)[0].body, /timeout.*半途/)
    // 每封只回一次
    for (let n = 1; n <= 7; n++) assert.equal(by(n).length, 1, `mail ${n}`)
    // roster：只回報白名單，附中文名；403 只記一次
    const r = st.rosterPosts[0].agents
    // name＝中文名（沒有中文名才用 slug）、cwd_label＝slug
    assert.deepEqual(r.map(a => a.name), ['阿爾法', 'err', '不穩', 'ghost', 'weird'])
    assert.deepEqual(r.map(a => a.cwd_label), ['alpha', 'err', 'flaky', 'ghost', 'weird'])
    assert.equal((log.match(/roster post failed/g) || []).length, 1)
  } finally { await st.close() }
})

test('aegis: to_agent 可用中文名；沒有 to_agent 交給預設成員（要在白名單內）', async () => {
  const members = [{ slug: 'alpha', name: '阿爾法' }, { slug: 'aegis', name: '愛吉絲' }]
  const aegis = {
    alpha: () => ({ json: { answer: '阿爾法答', status: 'success', member: 'alpha' } }),
    aegis: () => ({ json: { answer: '總管答', status: 'success', member: 'aegis' } }),
  }
  const st = await fakeServer({ inbox: [mail(1, { to_agent: '阿爾法' }), mail(2), mail(3, { to_agent: '路人' })], members, aegis })
  try {
    await runBridge({
      script: 'bridge-aegis.mjs', st,
      env: { IRORI_AEGIS_URL: `http://127.0.0.1:${st.port}`, IRORI_AEGIS_ALLOW: 'alpha,aegis' },
      until: () => st.acked.size >= 3,
    })
    const by = n => st.sent.filter(s => s.reply_to === uid(n))
    // 中文名 → slug：打到 Aegis 的 target 是 slug，回信 from_agent 是實際回答的成員
    assert.deepEqual(st.asks.filter(a => a.question.endsWith('內文-1')).map(a => a.target), ['alpha'])
    assert.equal(by(1)[0].body, '阿爾法答'); assert.equal(by(1)[0].from_agent, 'alpha')
    // 沒有 to_agent → 預設成員 aegis
    assert.deepEqual(st.asks.filter(a => a.question.endsWith('內文-2')).map(a => a.target), ['aegis'])
    assert.equal(by(2)[0].body, '總管答'); assert.equal(by(2)[0].from_agent, 'aegis')
    // 對不上的名字照舊擋下
    assert.match(by(3)[0].body, /沒有開放聯絡/)
    assert.equal(st.asks.length, 2)
  } finally { await st.close() }
})

test('aegis: 希緒自己不列進 roster，寄給她的信回「不能自己問自己」', async () => {
  const members = [{ slug: 'alpha', name: '阿爾法' }, { slug: 'xi-xu', name: '希緒' }]
  const st = await fakeServer({ inbox: [mail(1, { to_agent: 'xi-xu' }), mail(2, { to_agent: '希緒' })], members, aegis: { 'xi-xu': () => ({ json: { answer: 'x', status: 'success', member: 'xi-xu' } }) } })
  try {
    await runBridge({
      script: 'bridge-aegis.mjs', st,
      env: { IRORI_AEGIS_URL: `http://127.0.0.1:${st.port}`, IRORI_AEGIS_ALLOW: 'alpha,xi-xu' },
      until: () => st.acked.size >= 2 && st.rosterPosts.length >= 1,
    })
    assert.deepEqual(st.rosterPosts[0].agents.map(a => a.cwd_label), ['alpha'])
    for (const n of [1, 2]) assert.match(st.sent.find(s => s.reply_to === uid(n)).body, /不能自己問自己/)
    assert.equal(st.asks.length, 0)
  } finally { await st.close() }
})

test('aegis: 白名單預設空＝全部擋下', async () => {
  const st = await fakeServer({ inbox: [mail(1, { to_agent: 'alpha' })], aegis: { alpha: () => ({ json: { answer: 'x', status: 'success', member: 'alpha' } }) } })
  try {
    await runBridge({ script: 'bridge-aegis.mjs', st, env: { IRORI_AEGIS_URL: `http://127.0.0.1:${st.port}` }, until: () => st.acked.has(uid(1)) })
    assert.match(st.sent[0].body, /沒有開放聯絡/)
    assert.equal(st.asks.length, 0)
  } finally { await st.close() }
})

// ------------------------------------------------------------------------ bridge.mjs（任務 A）
const SESSIONS = [
  { pid: 91001, name: 'T-舊的', updatedAt: 1000 },
  { pid: 91002, name: 'T-最近的', updatedAt: 5000 },
  { pid: 91003, name: 'T-中間', updatedAt: 3000 },
  { pid: 91004, name: 'T-收發室', updatedAt: 9000 },   // 收發室自己，不可被挑中
]
// 把 session 清單寫進假 HOME（~/.claude/sessions/<pid>.json＝entrypoint 與 updatedAt 的來源）與假 `claude agents` 輸出
const mainSetup = agents => home => {
  const dir = path.join(home, '.claude', 'sessions'); fs.mkdirSync(dir, { recursive: true })
  for (const a of agents) fs.writeFileSync(path.join(dir, `${a.pid}.json`), JSON.stringify({ pid: a.pid, entrypoint: 'cli', kind: 'interactive', updatedAt: a.updatedAt }))
  const agentsFile = path.join(home, 'agents.json'), record = path.join(home, 'record.jsonl')
  fs.writeFileSync(agentsFile, JSON.stringify(agents.map(a => ({ pid: a.pid, cwd: 'D:\\x', kind: 'interactive', startedAt: 1, name: a.name, status: 'idle' }))))
  fs.writeFileSync(record, '')
  return { IRORI_CLAUDE_SCRIPT: path.join(here, 'fake-claude.mjs'), FAKE_AGENTS: agentsFile, FAKE_RECORD: record }
}
const forwarded = home => fs.readFileSync(path.join(home, 'record.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l))

test('bridge: 預設收件人在線時轉給它且不加說明', async () => {
  const st = await fakeServer({ inbox: [mail(1)] })
  let rec
  try {
    await runBridge({
      script: 'bridge.mjs', st, setup: mainSetup([...SESSIONS, { pid: 91005, name: 'T-預設', updatedAt: 100 }]),
      env: { IRORI_RELAY_DEFAULT_AGENT: 'T-預設' },
      until: ({ home }) => (rec = forwarded(home)).length >= 1,
    })
    assert.equal(rec[0].to, 'T-預設'); assert.doesNotMatch(rec[0].text, /不在線/)
  } finally { await st.close() }
})

test('bridge: 預設收件人不在線 → 交給最近有活動的 session、內文加說明、排除收發室、roster 403 只記一次', async () => {
  const st = await fakeServer({ inbox: [mail(1)] })
  let rec
  try {
    const { log } = await runBridge({
      script: 'bridge.mjs', st, setup: mainSetup(SESSIONS), env: { IRORI_RELAY_DEFAULT_AGENT: 'T-預設' },
      until: ({ home }) => (rec = forwarded(home)).length >= 1 && st.rosterPosts.length >= 3,
    })
    assert.equal(rec.length, 1)
    assert.equal(rec[0].to, 'T-最近的')
    assert.match(rec[0].text, /這封信原本要給「T-預設」，但它不在線，請你（T-最近的）代收並轉告／處理。\n內文-1/)
    assert.match(log, /fallback to most recently active session T-最近的/)
    assert.equal((log.match(/roster post failed/g) || []).length, 1)
    assert.ok(st.acked.has(uid(1)))
  } finally { await st.close() }
})

test('bridge: 預設不在線且沒有任何互動式 session → 留在 inbox（不 ack、不轉交）', async () => {
  const st = await fakeServer({ inbox: [mail(1)] })
  let rec
  try {
    await runBridge({
      script: 'bridge.mjs', st, setup: mainSetup([{ pid: 91004, name: 'T-收發室', updatedAt: 9000 }]), env: { IRORI_RELAY_DEFAULT_AGENT: 'T-預設' },
      until: ({ log, home }) => { rec = forwarded(home); return /no interactive session online: left in inbox/.test(log) },
    })
    assert.equal(rec.length, 0); assert.equal(st.acked.size, 0)
  } finally { await st.close() }
})

// ------------------------------------------------------------------------ 逾時通知（不需回覆／合併）
const quick = { IRORI_RELAY_DEFAULT_AGENT: 'T-最近的', IRORI_REPLY_TIMEOUT_MS: '300', IRORI_BRIDGE_TICK_MS: '100' }
const noticesOf = st => st.sent.filter(s => /沒有經收發室收到/.test(s.body))

test('bridge: 內文含（不需回覆）／[no-reply] → 照常轉交並 ack，但不計時、不寄逾時通知', async () => {
  const st = await fakeServer({ inbox: [mail(1, { body: '（不需回覆）純告知' }), mail(2, { body: '純告知\n[No-Reply]' })] })
  let rec
  try {
    await runBridge({
      script: 'bridge.mjs', st, setup: mainSetup(SESSIONS), env: quick, settle: 1500,
      until: ({ home }) => (rec = forwarded(home)).length >= 2 && st.acked.size >= 2,
    })
    assert.equal(rec.length, 2); assert.equal(noticesOf(st).length, 0)
  } finally { await st.close() }
})

test('bridge: 視窗已用 send.mjs --reply-to 直接回了（replied 記號）→ 不寄「沒有回覆」；沒記號的照寄', async () => {
  const st = await fakeServer({ inbox: [mail(1), mail(2)] })
  try {
    const setup = home => {
      const env = mainSetup(SESSIONS)(home)
      const dir = path.join(home, '.irori-relay', 'machine-T', 'replied'); fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(path.join(dir, uid(1)), String(Date.now()))
      return env
    }
    const { log } = await runBridge({
      script: 'bridge.mjs', st, setup, env: { ...quick, IRORI_NOREPLY_WINDOW_MS: '0' }, settle: 1500,
      until: ({ log }) => noticesOf(st).length >= 1 && /no-reply notice skipped/.test(log),
    })
    assert.equal(noticesOf(st).length, 1)
    assert.equal(noticesOf(st)[0].reply_to, uid(2))
    assert.match(log, new RegExp(`no-reply notice skipped id=${uid(1)}: T-最近的 replied directly`))
  } finally { await st.close() }
})

test('bridge: 逾時通知 30 分鐘內同寄件人＋同收件視窗只報一次', async () => {
  const st = await fakeServer({ inbox: [mail(1), mail(2), mail(3)] })
  try {
    await runBridge({
      script: 'bridge.mjs', st, setup: mainSetup(SESSIONS), env: quick, settle: 1500,
      until: () => st.acked.size >= 3 && noticesOf(st).length >= 1,
    })
    assert.equal(noticesOf(st).length, 1)
    assert.match(noticesOf(st)[0].body, /對方若已另外回信可忽略/)
  } finally { await st.close() }
  // 視窗設 0：每封都報（確認合併確實來自視窗）
  const st2 = await fakeServer({ inbox: [mail(4), mail(5)] })
  try {
    await runBridge({
      script: 'bridge.mjs', st: st2, setup: mainSetup(SESSIONS), env: { ...quick, IRORI_NOREPLY_WINDOW_MS: '0' },
      until: () => noticesOf(st2).length >= 2,
    })
    assert.equal(noticesOf(st2).length, 2)
  } finally { await st2.close() }
})

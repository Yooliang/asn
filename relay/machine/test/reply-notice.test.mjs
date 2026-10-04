// 「沒有經收發室收到回覆」通知的行為：遲到回覆照寄、對方忙碌時延後、視窗已關閉、收發室系統信不計時、寄出有 log、寄給原寄件人視為已回覆。
// 用假仲介伺服器＋假 claude（agents.json 可在執行中改 status）；用 IRORI_REPLY_TIMEOUT_MS / IRORI_BRIDGE_TICK_MS 縮短時間。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { sentMarkName } from '../sent-mark.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const MACHINE = path.join(here, '..')
const sleep = ms => new Promise(r => setTimeout(r, ms))
const readBody = req => new Promise(r => { let b = ''; req.on('data', d => b += d); req.on('end', () => r(b ? JSON.parse(b) : null)) })
const uid = n => `00000000-0000-0000-0000-${n.toString(16).padStart(12, '0')}`
const mail = (n, extra = {}) => ({ id: uid(n), from_node: 'W', from_agent: 'W-政策', to_agent: 'T-對方', trust: 'member', body: `內文-${n}`, ...extra })

// 信件晚一點才放進 inbox：橋要先拿到第一份 session 名單，不然會誤判「找不到視窗」
async function fakeServer(mails) {
  const inbox = []
  setTimeout(() => inbox.push(...mails), 1200)
  const st = { acked: new Set(), sent: [] }
  const srv = http.createServer(async (req, res) => {
    const a = new URL(req.url, 'http://x').searchParams.get('action')
    const out = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)) }
    if (a === 'whoami') return out(200, { node: 'T', bell_topic: 'bell-test' })
    if (a === 'inbox') return out(200, { messages: inbox.filter(m => !st.acked.has(m.id)) })
    if (a === 'send') { st.sent.push(await readBody(req)); return out(200, { ok: true }) }
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
const writeAgents = (home, list) => fs.writeFileSync(path.join(home, 'agents.json'),
  JSON.stringify(list.map(([name, status], i) => ({ pid: 92000 + i, cwd: 'D:\\x', kind: 'interactive', startedAt: 1, name, status }))))

// step({log, home, st, says, setAgents}) 每 50ms 呼叫一次，回傳 true 就結束（再等 settle 毫秒）；says(text) 讓 T-對方 經收發室「回覆」
async function go({ st, env = {}, step, agents = NAMES.map(n => [n, 'idle']), timeout = 15000, settle = 500 }) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'irori-notice-test-'))
  const dir = path.join(home, '.claude', 'sessions'); fs.mkdirSync(dir, { recursive: true })
  agents.forEach(([name], i) => fs.writeFileSync(path.join(dir, `${92000 + i}.json`), JSON.stringify({ pid: 92000 + i, entrypoint: 'cli', kind: 'interactive', updatedAt: 1 })))
  writeAgents(home, agents)
  const inbound = path.join(home, 'inbound.jsonl'); fs.writeFileSync(inbound, ''); fs.writeFileSync(path.join(home, 'record.jsonl'), '')
  const child = spawn(process.execPath, [path.join(MACHINE, 'bridge.mjs')], {
    cwd: home, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true,
    env: {
      PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, HOME: home, USERPROFILE: home,
      IRORI_RELAY_ID: 'T', IRORI_RELAY_KEY: 'fake-test-key', IRORI_RELAY_URL: `http://127.0.0.1:${st.port}/relay`,
      IRORI_RELAY_POLL_MS: '200', IRORI_ROSTER_MS: '150', IRORI_RELAY_DEFAULT_AGENT: 'T-對方',
      IRORI_REPLY_TIMEOUT_MS: '300', IRORI_BRIDGE_TICK_MS: '100', IRORI_NOREPLY_WINDOW_MS: '0',
      IRORI_CLAUDE_SCRIPT: path.join(here, 'fake-claude.mjs'), FAKE_AGENTS: path.join(home, 'agents.json'),
      FAKE_RECORD: path.join(home, 'record.jsonl'), FAKE_INBOUND: inbound, ...env,
    },
  })
  let log = ''; child.stderr.on('data', d => log += d)
  const ctx = () => ({
    log, home, st,
    says: text => fs.appendFileSync(inbound, JSON.stringify({ from: 'T-對方', text }) + '\n'),
    setAgents: list => writeAgents(home, list),
    forwarded: () => fs.readFileSync(path.join(home, 'record.jsonl'), 'utf8').split('\n').filter(Boolean).length,
  })
  const t0 = Date.now()
  while (!step(ctx()) && Date.now() - t0 < timeout) await sleep(50)
  await sleep(settle)
  const final = ctx(), ok = step(final)
  child.kill(); await new Promise(r => child.once('exit', r)); await sleep(300)
  try { fs.rmSync(home, { recursive: true, force: true }) } catch {}
  assert.ok(ok, `condition not reached in ${timeout}ms\n--- bridge log ---\n${final.log}`)
  return final
}
const notices = st => st.sent.filter(s => /沒有經收發室收到/.test(s.body))

test('遲到的回覆：逾時通知後信仍保留，對方之後才回 → 照常寄回（帶「遲到的回覆」）並清掉；log 記下通知寄出', async () => {
  const st = await fakeServer([mail(1)])
  try {
    let said = false
    const { log } = await go({
      st, step: c => {
        if (!said && notices(c.st).length >= 1) { said = true; c.says('終於做完了') }
        return /late reply from T-對方/.test(c.log)
      },
    })
    assert.equal(notices(st).length, 1)
    assert.match(log, new RegExp(`no-reply notice sent id=${uid(1)} \\(W/W-政策\\|T-對方\\) reason=timeout`))
    const back = st.sent.filter(s => s.reply_to === uid(1) && /終於做完了/.test(s.body))
    assert.equal(back.length, 1); assert.match(back[0].body, /^（遲到的回覆/); assert.equal(back[0].from_agent, 'T-對方')
    assert.doesNotMatch(log, /unmatched reply/)
  } finally { await st.close() }
})

test('遲到的回覆：保留期（IRORI_LATE_KEEP_MS）過了就清掉，之後的回覆照舊丟棄並記 log', async () => {
  const st = await fakeServer([mail(1)])
  try {
    let said = false
    const { log } = await go({
      st, env: { IRORI_LATE_KEEP_MS: '600' }, step: c => {
        if (!said && /late-reply slot expired/.test(c.log)) { said = true; c.says('太晚了') }
        return /unmatched reply from T-對方/.test(c.log)
      },
    })
    assert.equal(st.sent.filter(s => /太晚了/.test(s.body)).length, 0)
  } finally { await st.close() }
})

test('遲到回覆的保留筆數有上限（IRORI_LATE_MAX）：超過就清掉最舊的', async () => {
  const st = await fakeServer([mail(1), mail(2), mail(3)])
  try {
    const { log } = await go({ st, env: { IRORI_LATE_MAX: '1' }, step: c => (c.log.match(/late-reply slot evicted/g) || []).length >= 2 })
    assert.match(log, new RegExp(`evicted id=${uid(1)}`))
  } finally { await st.close() }
})

test('對方忙碌：逾時不寄、延後；閒下來後過寬限仍沒回才寄（reason=busy-idle-grace）', async () => {
  const st = await fakeServer([mail(1)])
  try {
    let idleAt = 0
    const { log } = await go({
      st, agents: [['T-對方', 'busy'], ['T-別人', 'idle']], env: { IRORI_BUSY_GRACE_MS: '700', IRORI_BUSY_MAX_MS: '60000' },
      step: c => {
        if (!idleAt && /no-reply notice deferred/.test(c.log)) { assert.equal(notices(c.st).length, 0); idleAt = Date.now(); c.setAgents([['T-對方', 'idle'], ['T-別人', 'idle']]) }
        return notices(c.st).length >= 1
      },
    })
    assert.match(log, /deferred id=.*T-對方 is busy/)
    assert.match(log, /reason=busy-idle-grace/)
    assert.match(notices(st)[0].body, /先前一直在忙/)
  } finally { await st.close() }
})

test('對方忙碌延後期間又變忙 → 寬限重算；忙到總上限（IRORI_BUSY_MAX_MS）無論如何寄一次（reason=busy-max）', async () => {
  const st = await fakeServer([mail(1)])
  try {
    const { log } = await go({ st, agents: [['T-對方', 'busy'], ['T-別人', 'idle']], env: { IRORI_BUSY_MAX_MS: '1200' }, step: c => notices(c.st).length >= 1 })
    assert.match(log, /reason=busy-max/)
  } finally { await st.close() }
})

test('對方在延後期間回覆了 → 不寄通知', async () => {
  const st = await fakeServer([mail(1)])
  try {
    let said = false
    const { log } = await go({
      st, agents: [['T-對方', 'busy'], ['T-別人', 'idle']], step: c => {
        if (!said && /no-reply notice deferred/.test(c.log)) { said = true; c.says('忙完了，回你') }
        return /reply from T-對方 -> W/.test(c.log)
      },
    })
    assert.equal(notices(st).length, 0)
    assert.equal(st.sent.filter(s => /忙完了/.test(s.body))[0].body.startsWith('（遲到'), false)
  } finally { await st.close() }
})

test('對方視窗已經不在名單（關掉了）→ 逾時直接寄，文字說明視窗已關閉', async () => {
  const st = await fakeServer([mail(1)])
  try {
    let closed = false
    const { log } = await go({
      st, step: c => {
        if (!closed && c.forwarded() >= 1) { closed = true; c.setAgents([['T-別人', 'idle']]) }
        return notices(c.st).length >= 1
      },
    })
    assert.match(notices(st)[0].body, /對方視窗「T-對方」已關閉/)
    assert.match(log, /reason=window-closed/)
  } finally { await st.close() }
})

test('寄件人是收發室（W-收發室／T-收發室）→ 照常轉交並 ack，但不計時、不寄逾時通知', async () => {
  const st = await fakeServer([mail(1, { from_agent: 'W-收發室' }), mail(2, { from_agent: 'T-收發室', from_node: 'T' })])
  try {
    const { log } = await go({ st, settle: 1200, step: c => c.forwarded() >= 2 && c.st.acked.size >= 2 })
    assert.equal(notices(st).length, 0)
    assert.doesNotMatch(log, /no-reply notice sent/)
  } finally { await st.close() }
})

test('對方在轉交後曾用 send.mjs 寄信給原寄件人（sent 記號，沒帶 --reply-to）→ 視為已回覆，不寄通知', async () => {
  const st = await fakeServer([mail(1), mail(2, { from_node: 'Z', from_agent: 'Z-別窗' })])
  try {
    let marked = false
    const { log } = await go({
      st, env: { IRORI_REPLY_TIMEOUT_MS: '1500' }, step: c => {
        if (!marked && c.forwarded() >= 2) {
          marked = true
          const dir = path.join(c.home, '.irori-relay', 'machine-T', 'sent'); fs.mkdirSync(dir, { recursive: true })
          // 只寄給節點 W（沒指定視窗）也算回了第一封（寄件人 W/W-政策）；第二封（Z/Z-別窗）沒有任何記號
          fs.writeFileSync(path.join(dir, sentMarkName('T-對方', 'W', '')), String(Date.now()))
        }
        return notices(c.st).length >= 1 && /sent mail to W\/W-政策/.test(c.log)
      },
    })
    assert.equal(notices(st).length, 1); assert.equal(notices(st)[0].reply_to, uid(2))
    assert.match(log, /sent mail to W\/W-政策 after forward/)
  } finally { await st.close() }
})

test('sent 記號早於轉交時間（舊的寄信）不算已回覆', async () => {
  const st = await fakeServer([mail(1)])
  try {
    const { log } = await go({
      st, env: { IRORI_REPLY_TIMEOUT_MS: '1500' }, step: c => {
        const dir = path.join(c.home, '.irori-relay', 'machine-T', 'sent'); fs.mkdirSync(dir, { recursive: true })
        const f = path.join(dir, sentMarkName('T-對方', 'W', 'W-政策'))
        if (!fs.existsSync(f)) fs.writeFileSync(f, String(Date.now() - 3_600_000))
        return notices(c.st).length >= 1
      },
    })
    assert.match(log, /reason=timeout/)
  } finally { await st.close() }
})

// 10/04：收發室同一輪收到兩封、只寫了一行 SENT，另一封其實轉到了卻被誤報「轉交逾時」
const forwardTimeouts = st => st.sent.filter(s => /轉交給 .+ 逾時/.test(s.body))

test('收發室有成功呼叫 SendMessage 但漏寫 SENT 行 → 照樣算已轉交，不寄「轉交逾時」', async () => {
  const st = await fakeServer([mail(1), mail(2)])
  try {
    const { log } = await go({
      st, env: { FAKE_FORWARD: 'tool', IRORI_FORWARD_TIMEOUT_MS: '400', IRORI_REPLY_TIMEOUT_MS: '60000' },
      step: c => /forwarded id=0+-0+-0+-0+-0+1 /.test(c.log) && /forwarded id=0+-0+-0+-0+-0+2 /.test(c.log),
      settle: 900,
    })
    assert.equal(forwardTimeouts(st).length, 0)
    assert.ok(st.acked.has(uid(1)) && st.acked.has(uid(2)))
  } finally { await st.close() }
})

test('收發室完全沒回報，但對方已經用 --reply-to 回了這封 → 不寄「轉交逾時」；沒回的那封照常寄', async () => {
  const st = await fakeServer([mail(1), mail(2)])
  try {
    let marked = false
    const { log } = await go({
      st, env: { FAKE_FORWARD: 'silent', IRORI_FORWARD_TIMEOUT_MS: '1200', IRORI_REPLY_TIMEOUT_MS: '60000' },
      step: c => {
        if (!marked && c.forwarded() >= 2) {
          marked = true
          const dir = path.join(c.home, '.irori-relay', 'machine-T', 'replied'); fs.mkdirSync(dir, { recursive: true })
          fs.writeFileSync(path.join(dir, uid(1)), '')
        }
        return forwardTimeouts(c.st).length >= 1 && /already replied/.test(c.log)
      },
    })
    assert.equal(forwardTimeouts(st).length, 1); assert.equal(forwardTimeouts(st)[0].reply_to, uid(2))
    assert.match(log, new RegExp(`already replied id=${uid(1)}`))
    assert.ok(st.acked.has(uid(1)))
  } finally { await st.close() }
})

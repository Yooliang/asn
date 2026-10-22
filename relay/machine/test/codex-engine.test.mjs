// Codex 轉接器契約測試：用假 codex（fake-codex.mjs）驗證名單、轉交、回覆、登入／額度、安全閘門、開視窗、身分判定，
// 最後讓 bridge.mjs 載入 codex 轉接器跑一次主流程（IRORI_ENGINES=codex.mjs）。完全不碰真的 codex 與 ~/.codex。
// 執行：node --test relay/machine/test/codex-engine.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { spawnTracked } from './spawn-tracked.mjs'
import { fileURLToPath } from 'node:url'
import { REQUIRED_METHODS, loadEngines, validateEngine } from '../engines/index.mjs'
import { createEngine } from '../engines/codex.mjs'
import { codexChildEnv } from '../engines/codex-bin.mjs'
import { inspectCaller } from '../engines/codex-identity.mjs'
import { lockedThreadIds, readNameIndex, readPolicy } from '../engines/codex-state.mjs'
import { findCaller } from '../identity.mjs'
import { buildSpawn, loadConfig } from '../launcher.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const MACHINE = path.join(here, '..')
const FAKE = path.join(here, 'fake-codex.mjs')
const CODEX_MJS = path.join(MACHINE, 'engines', 'codex.mjs')
const sleep = ms => new Promise(r => setTimeout(r, ms))
const uid = n => `00000000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`
const A = uid(1), B = uid(2), C = uid(3)

// 一個假的 Codex 家目錄：state（執行緒）、session_index.jsonl（名字）、thread-writer-locks（誰開著）
function fixture({ threads, login = true, limit = false, open = threads.map(t => t.id), extraEnv = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'irori-codex-test-'))
  const home = path.join(dir, 'codex-home'); fs.mkdirSync(path.join(home, 'thread-writer-locks'), { recursive: true })
  const state = path.join(dir, 'state.json'), calls = path.join(dir, 'calls.jsonl')
  // 沒指定 rollout 的視窗給一份「一般沙盒」的 turn_context：讀不到權限的視窗收發室一律不轉（fail-closed），測試要明確寫出
  const safeRollout = id => {
    const f = path.join(dir, `rollout-${id}.jsonl`)
    fs.writeFileSync(f, JSON.stringify({ type: 'turn_context', payload: { approval_policy: 'on-request', sandbox_policy: { type: 'workspace-write' } } }) + '\n')
    return f
  }
  const full = threads.map(t => ({ cwd: 'C:\\proj\\' + (t.cwdName ?? 'demo'), updatedAt: 1000, turns: [], ...t, path: t.path ?? safeRollout(t.id) }))
  fs.writeFileSync(state, JSON.stringify({ login, limit, threads: full }))
  fs.writeFileSync(path.join(home, 'session_index.jsonl'), full.filter(t => t.name).map(t => JSON.stringify({ id: t.id, thread_name: t.name, updated_at: 'x' })).join('\n') + '\n')
  for (const id of open) fs.writeFileSync(path.join(home, 'thread-writer-locks', `${id}.lock`), '')
  fs.writeFileSync(path.join(home, 'thread-writer-locks', '.coordination.lock'), '')
  const env = {
    PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, CODEX_HOME: home, IRORI_CODEX_SCRIPT: FAKE, FAKE_CODEX_STATE: state, FAKE_CODEX_CALLS: calls,
    IRORI_CODEX_LOCK_MODE: 'exists', IRORI_CODEX_POLL_MS: '50', IRORI_CODEX_HEALTH_TTL_MS: '10', ...extraEnv,
  }
  const readCalls = () => { try { return fs.readFileSync(calls, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) } catch { return [] } }
  const readState = () => JSON.parse(fs.readFileSync(state, 'utf8'))
  return { dir, home, state, env, readCalls, readState, cleanup: () => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) }
}

function start(fx, deps) {
  const events = []
  const logs = []
  const eng = createEngine({ log: m => logs.push(m), workDir: fx.dir, mailboxName: 'T-收發室', env: fx.env, deps })
  const waiters = []
  const push = e => { events.push(e); for (const w of [...waiters]) w() }
  eng.start({ onSent: id => push({ t: 'sent', id }), onFail: (id, reason) => push({ t: 'fail', id, reason }), onReply: (from, text) => push({ t: 'reply', from, text }) })
  const until = async (pred, ms = 5000) => {
    const t0 = Date.now()
    while (!events.some(pred)) { if (Date.now() - t0 > ms) assert.fail(`event not reached; events=${JSON.stringify(events)} logs=${logs.join(' | ')}`); await sleep(20) }
    return events.find(pred)
  }
  return { eng, events, logs, until, stop: () => eng.stop() }
}
const messageOf = q => q.argv.find(a => a.startsWith('--message=')).slice('--message='.length)   // 真的 codex 要連寫 --message=TEXT（內文以 -- 開頭時才安全）
const mailText = (id, body = '內文') => `[RELAY 來信] trust=member from=W/W-政策 to=視窗甲 id=${id} engine=codex\n${body}`

const THREADS = [
  { id: A, name: '視窗甲', cwdName: 'proj-a', updatedAt: 3000 },
  { id: B, name: '視窗乙', cwdName: 'proj-b', updatedAt: 2000, turns: [{ id: 'old', status: 'inProgress', completedAt: null, items: [{ type: 'userMessage', content: [{ type: 'text', text: '忙著' }] }] }] },
  { id: C, name: null, updatedAt: 1000 },                                    // 開著但沒有名字
  { id: uid(4), name: '子代理', parentThreadId: A, updatedAt: 500 },           // codex 內部子代理，不是給人的視窗
  { id: uid(5), name: '已關閉', updatedAt: 100 },                               // 有名字但沒人開著
]

test('介面：通過 validateEngine、能力宣告、內建名稱 codex 載得進來', async () => {
  const fx = fixture({ threads: THREADS, open: [] })
  try {
    const e = (await loadEngines({ log() {}, workDir: fx.dir, mailboxName: 'T-收發室', env: fx.env }, 'codex'))[0]
    assert.equal(e.id, 'codex')
    for (const m of REQUIRED_METHODS) assert.equal(typeof e[m], 'function', m)
    assert.deepEqual(e.capabilities(), { listWindows: true, deliver: true, openWindow: true, selfRecv: false, identity: true, fallbackByActivity: true })
    assert.equal(e.identity.engine, 'codex'); assert.equal(typeof e.identity.inspectCaller, 'function')
    assert.throws(() => validateEngine({ id: 'codex' }), /缺方法/)
  } finally { fx.cleanup() }
})

test('名單：有名字且正被開著的視窗；忙碌＝最後一個 turn 沒結束；排除沒名字／子代理／已關閉；全程不 resume thread', async () => {
  const fx = fixture({ threads: THREADS, open: [A, B, C, uid(4)] })
  const s = start(fx)
  try {
    const r = await s.eng.listWindows()
    assert.deepEqual(r.windows.map(w => [w.name, w.status, w.cwd_label, w.engine]), [['視窗甲', 'idle', 'proj-a', 'codex'], ['視窗乙', 'busy', 'proj-b', 'codex']])
    assert.deepEqual(r.all, r.windows)
    assert.equal(r.windows[0].threadId, A)
    assert.equal(s.eng.activityOf(r.windows[0]), 3_000_000)
    assert.deepEqual([...(await s.eng.listNames())].sort(), ['視窗乙', '視窗甲'])
    assert.ok(s.logs.some(l => /沒有名字/.test(l)), '沒名字的視窗要記一筆')
    const methods = fx.readCalls().filter(c => c.cmd === 'rpc').map(c => c.method)
    assert.ok(methods.includes('thread/read') && methods.includes('thread/turns/list'))
    assert.ok(!methods.some(m => /resume|thread\/start|turn\/start/.test(m)), `reader 不可載入 thread：${methods}`)
  } finally { await s.stop(); fx.cleanup() }
})

test('名單：兩個開著的視窗同名 → 只留最近有動靜的', async () => {
  const fx = fixture({ threads: [{ id: A, name: '同名', updatedAt: 10 }, { id: B, name: '同名', updatedAt: 20 }] })
  const s = start(fx)
  try {
    const r = await s.eng.listWindows()
    assert.deepEqual(r.windows.map(w => w.threadId), [B])
    assert.ok(s.logs.some(l => /同名/.test(l)))
  } finally { await s.stop(); fx.cleanup() }
})

test('名單：鎖檔存在但沒人持有（殘檔）不算開著——lockedThreadIds 在 exists 模式看檔案、auto 模式在非 Windows 同樣只看檔案', async () => {
  const fx = fixture({ threads: THREADS, open: [A] })
  try {
    assert.deepEqual([...await lockedThreadIds(fx.home, { mode: 'exists' })], [A])
    assert.deepEqual([...await lockedThreadIds(path.join(fx.dir, 'nope'), { mode: 'exists' })], [])
    if (process.platform === 'win32') {
      // 真的 Windows 路徑：沒有任何行程持有 → FileShare.None 開得起來 → 全是殘檔 → 空集合；有行程以不共用方式開著 → 在集合內
      assert.deepEqual([...await lockedThreadIds(fx.home, { mode: 'auto' })], [])
      const lockFile = path.join(fx.home, 'thread-writer-locks', `${A}.lock`)
      const holder = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `$f=[IO.File]::Open('${lockFile}','Open','ReadWrite','None'); [Console]::Out.WriteLine('held'); Start-Sleep 30`], { stdio: ['ignore', 'pipe', 'inherit'], windowsHide: true })
      await new Promise(r => holder.stdout.once('data', r))
      assert.deepEqual([...await lockedThreadIds(fx.home, { mode: 'auto' })], [A])
      // 等持有者真的結束（鎖檔放掉）再清資料夾，不然 Windows 刪不掉（EPERM）
      const exited = new Promise(r => holder.once('exit', r))
      holder.kill()
      await exited
    }
  } finally { fx.cleanup() }
})

test('轉交：onSent 先於回覆；佇列收到「原信全文＋編號標記」且對準 thread id；回覆文字原樣交回', async () => {
  const fx = fixture({ threads: THREADS, open: [A, B], extraEnv: { FAKE_CODEX_REPLY: '收到，已處理', FAKE_CODEX_REPLY_MS: '200' } })
  const s = start(fx)
  try {
    await s.eng.listWindows()
    const id = uid(0x90)
    s.eng.deliver({ id, to: '視窗甲', text: mailText(id, '請幫我看一下 A 專案') })
    const reply = await s.until(e => e.t === 'reply')
    assert.deepEqual(s.events.map(e => e.t), ['sent', 'reply'])
    assert.equal(reply.from, '視窗甲'); assert.equal(reply.text, '收到，已處理')
    const q = fx.readCalls().find(c => c.cmd === 'queue')
    assert.equal(q.argv[q.argv.indexOf('--thread') + 1], A)
    const msg = messageOf(q)
    assert.ok(msg.startsWith(mailText(id, '請幫我看一下 A 專案')), '原信一字不改放在最前面')
    assert.ok(msg.includes(`irori-mail:${id}`), '要有編號標記，回覆才對得上')
  } finally { await s.stop(); fx.cleanup() }
})

test('轉交：信文以 -- 開頭、含引號／換行／反斜線也原樣交給 codex queue（連寫 --message=，不會被當成旗標）', async () => {
  const fx = fixture({ threads: THREADS, open: [A], extraEnv: { FAKE_CODEX_REPLY_MS: '50' } })
  const s = start(fx)
  try {
    await s.eng.listWindows()
    const id = uid(0x95)
    const nasty = '--message injected "quote" \\ back\nslash 100% & | > 😀'
    s.eng.deliver({ id, to: '視窗甲', text: nasty })
    await s.until(e => e.t === 'reply')
    const q = fx.readCalls().find(c => c.cmd === 'queue')
    assert.ok(messageOf(q).startsWith(nasty))
    assert.ok(!q.argv.includes('--message'), '不可分開寫成 --message TEXT')
  } finally { await s.stop(); fx.cleanup() }
})

test('轉交：兩封信連續送進同一個視窗，各自對應各自的回覆（不串、不重複）', async () => {
  const fx = fixture({ threads: THREADS, open: [A, B], extraEnv: { FAKE_CODEX_REPLY: 'ok', FAKE_CODEX_REPLY_MS: '300' } })
  const s = start(fx)
  try {
    await s.eng.listWindows()
    const i1 = uid(0x91), i2 = uid(0x92)
    s.eng.deliver({ id: i1, to: '視窗甲', text: mailText(i1, '第一封') })
    await s.until(e => e.t === 'sent' && e.id === i1)
    s.eng.deliver({ id: i2, to: '視窗甲', text: mailText(i2, '第二封') })
    await s.until(e => e.t === 'sent' && e.id === i2)
    await s.until(e => e.t === 'reply'); await sleep(500)
    assert.equal(s.events.filter(e => e.t === 'reply').length, 2)
    const turns = fx.readState().threads.find(t => t.id === A).turns
    assert.equal(turns.length, 2)
  } finally { await s.stop(); fx.cleanup() }
})

test('回覆時機：turn 還沒結束（視窗在忙或卡在核准提示）就一直沒有 reply；turn 結束後才回，且不重複', async () => {
  const fx = fixture({ threads: THREADS, open: [A], extraEnv: { FAKE_CODEX_TURN: 'never', IRORI_CODEX_DRAIN_WARN_MS: '100' } })
  const s = start(fx)
  try {
    await s.eng.listWindows()
    const id = uid(0x93)
    s.eng.deliver({ id, to: '視窗甲', text: mailText(id) })
    await s.until(e => e.t === 'sent')
    await sleep(400)
    assert.ok(!s.events.some(e => e.t === 'reply'), '進行中的 turn 不能先回')
    const st = fx.readState()   // 模擬使用者按了核准、Codex 做完
    const turn = st.threads.find(t => t.id === A).turns[0]
    Object.assign(turn, { status: 'completed', completedAt: 1, items: [...turn.items, { type: 'agentMessage', text: '想了很久的結果', phase: 'final_answer' }] })
    fs.writeFileSync(fx.state, JSON.stringify(st))
    const r = await s.until(e => e.t === 'reply')
    assert.equal(r.text, '想了很久的結果')
    await sleep(300)
    assert.equal(s.events.filter(e => e.t === 'reply').length, 1)
  } finally { await s.stop(); fx.cleanup() }
})

test('轉交失敗：找不到視窗／視窗已關閉／信太長／queue 指令失敗 → onFail（有原因），不會送進佇列', async () => {
  const fx = fixture({ threads: THREADS, open: [A], extraEnv: { IRORI_CODEX_MAX_MAIL_CHARS: '200' } })
  const s = start(fx)
  try {
    await s.eng.listWindows()
    s.eng.deliver({ id: uid(0xa1), to: '不存在', text: mailText(uid(0xa1)) })
    assert.match((await s.until(e => e.t === 'fail' && e.id === uid(0xa1))).reason, /找不到開著的 Codex 視窗「不存在」/)
    s.eng.deliver({ id: uid(0xa2), to: '視窗甲', text: mailText(uid(0xa2), '長'.repeat(300)) })
    assert.match((await s.until(e => e.t === 'fail' && e.id === uid(0xa2))).reason, /信太長/)
    fs.unlinkSync(path.join(fx.home, 'thread-writer-locks', `${A}.lock`))   // 列名單之後視窗被關掉
    s.eng.deliver({ id: uid(0xa3), to: '視窗甲', text: mailText(uid(0xa3)) })
    assert.match((await s.until(e => e.t === 'fail' && e.id === uid(0xa3))).reason, /已關閉/)
    assert.equal(fx.readCalls().filter(c => c.cmd === 'queue').length, 0)
  } finally { await s.stop(); fx.cleanup() }
  const fx2 = fixture({ threads: THREADS, open: [A], extraEnv: { FAKE_CODEX_QUEUE_FAIL: 'database is locked' } })
  const s2 = start(fx2)
  try {
    await s2.eng.listWindows()
    s2.eng.deliver({ id: uid(0xa4), to: '視窗甲', text: mailText(uid(0xa4)) })
    assert.match((await s2.until(e => e.t === 'fail')).reason, /排進 Codex 佇列失敗：database is locked/)
    assert.ok(!s2.events.some(e => e.t === 'sent'))
  } finally { await s2.stop(); fx2.cleanup() }
})

test('登入與額度：沒登入／額度用完 → 名單狀態標示、轉交明確失敗（不無聲）；health() 可查', async () => {
  const fx = fixture({ threads: THREADS, open: [A], login: false })
  const s = start(fx)
  try {
    const r = await s.eng.listWindows()
    assert.equal(r.windows[0].status, 'login-required')
    assert.equal(s.eng.health().status, 'login-required')
    s.eng.deliver({ id: uid(0xb1), to: '視窗甲', text: mailText(uid(0xb1)) })
    assert.match((await s.until(e => e.t === 'fail')).reason, /codex login/)
    assert.equal(fx.readCalls().filter(c => c.cmd === 'queue').length, 0)
  } finally { await s.stop(); fx.cleanup() }
  const fx2 = fixture({ threads: THREADS, open: [A], limit: true })
  const s2 = start(fx2)
  try {
    const r = await s2.eng.listWindows()
    assert.equal(r.windows[0].status, 'limit')
    s2.eng.deliver({ id: uid(0xb2), to: '視窗甲', text: mailText(uid(0xb2)) })
    assert.match((await s2.until(e => e.t === 'fail')).reason, /額度用完了/)
  } finally { await s2.stop(); fx2.cleanup() }
})

test('turn 失敗（額度在處理中用完）→ onFail 帶原因；狀態變正常後名單恢復', async () => {
  const fx = fixture({ threads: THREADS, open: [A], extraEnv: { FAKE_CODEX_TURN: 'fail', FAKE_CODEX_REPLY_MS: '100' } })
  const s = start(fx)
  try {
    await s.eng.listWindows()
    s.eng.deliver({ id: uid(0xc1), to: '視窗甲', text: mailText(uid(0xc1)) })
    await s.until(e => e.t === 'sent')
    assert.match((await s.until(e => e.t === 'fail')).reason, /額度用完了/)
    assert.ok(!s.events.some(e => e.t === 'reply'))
  } finally { await s.stop(); fx.cleanup() }
})

test('安全閘門：視窗是「完全存取」沙盒就不轉外部來信；IRORI_CODEX_ALLOW_FULL_ACCESS=1 才放行；readPolicy 取最後一個 turn_context', async () => {
  const mkRollout = (dir, sandbox, approval = 'never') => {
    const f = path.join(dir, 'rollout.jsonl')
    fs.writeFileSync(f, [{ type: 'turn_context', payload: { approval_policy: 'on-request', sandbox_policy: { type: 'read-only' } } },
      { type: 'event_msg', payload: {} }, { type: 'turn_context', payload: { approval_policy: approval, sandbox_policy: { type: sandbox } } }].map(o => JSON.stringify(o)).join('\n') + '\n')
    return f
  }
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'irori-codex-pol-'))
  try {
    assert.deepEqual(readPolicy(mkRollout(base, 'danger-full-access')), { approval: 'never', sandbox: 'danger-full-access' })
    assert.equal(readPolicy(path.join(base, 'nope.jsonl')), null)
    for (const allow of [false, true]) {
      const fx = fixture({ threads: [{ id: A, name: '視窗甲', path: mkRollout(base, 'danger-full-access') }], open: [A], extraEnv: { FAKE_CODEX_REPLY_MS: '50', ...(allow ? { IRORI_CODEX_ALLOW_FULL_ACCESS: '1' } : {}) } })
      const s = start(fx)
      try {
        await s.eng.listWindows()
        s.eng.deliver({ id: uid(0xd1), to: '視窗甲', text: mailText(uid(0xd1)) })
        if (!allow) {
          assert.match((await s.until(e => e.t === 'fail')).reason, /完全存取/)
          assert.equal(fx.readCalls().filter(c => c.cmd === 'queue').length, 0)
        } else {
          await s.until(e => e.t === 'reply')
          assert.equal(fx.readCalls().filter(c => c.cmd === 'queue').length, 1)
        }
      } finally { await s.stop(); fx.cleanup() }
    }
  } finally { fs.rmSync(base, { recursive: true, force: true }) }
})

test('安全閘門：長對話的 turn_context 離結尾超過 1MB 也讀得到（往回分段讀，中文不會被段落切壞）；完全讀不到權限＝不轉信（fail-closed）', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'irori-codex-pol2-'))
  const line = o => JSON.stringify(o) + '\n'
  try {
    // w02 10/06 實測：16MB rollout、最近的 turn_context 離結尾約 3MB → 舊版只讀最後 1MB 回 null、閘門放行
    const filler = line({ type: 'event_msg', payload: { text: '中文字'.repeat(300) } })
    const big = path.join(base, 'big.jsonl')
    fs.writeFileSync(big, line({ type: 'turn_context', payload: { approval_policy: 'never', sandbox_policy: { type: 'danger-full-access' }, note: '測試用的中文' } }) + filler.repeat(3500))
    assert.ok(fs.statSync(big).size > 3 << 20)
    assert.deepEqual(readPolicy(big), { approval: 'never', sandbox: 'danger-full-access' })
    // 段落大小刻意取奇數，讓段落邊界切在多位元組中文字與 turn_context 那行中間
    assert.deepEqual(readPolicy(big, 777), { approval: 'never', sandbox: 'danger-full-access' })
    // 超過讀取上限才找得到 → 當成不知道
    assert.equal(readPolicy(big, 1 << 20, 1 << 20), null)
    // 沒有任何 turn_context 的 rollout：deliver 必須拒絕、不能排進佇列
    const none = path.join(base, 'none.jsonl')
    fs.writeFileSync(none, filler.repeat(10))
    const fx = fixture({ threads: [{ id: A, name: '視窗甲', path: none }], open: [A], extraEnv: { FAKE_CODEX_REPLY_MS: '50' } })
    const s = start(fx)
    try {
      await s.eng.listWindows()
      s.eng.deliver({ id: uid(0xd2), to: '視窗甲', text: mailText(uid(0xd2)) })
      assert.match((await s.until(e => e.t === 'fail')).reason, /讀不到.*權限/)
      assert.equal(fx.readCalls().filter(c => c.cmd === 'queue').length, 0)
    } finally { await s.stop(); fx.cleanup() }
  } finally { fs.rmSync(base, { recursive: true, force: true }) }
})

test('codex 不可用：沒安裝／版本太舊 → listWindows 回 null、deliver 同步 throw（橋把信留在 inbox）', async () => {
  const fx = fixture({ threads: THREADS, open: [A], extraEnv: { FAKE_CODEX_VERSION: '0.120.0' } })
  const s = start(fx)
  try {
    assert.equal(await s.eng.listWindows(), null)
    assert.ok(s.logs.some(l => /比已驗證的最低版本/.test(l)))
    assert.throws(() => s.eng.deliver({ id: uid(0xe1), to: '視窗甲', text: 'x' }), /codex 不可用/)
  } finally { await s.stop(); fx.cleanup() }
  const fx2 = fixture({ threads: THREADS, open: [A], extraEnv: { IRORI_CODEX_SCRIPT: '', IRORI_CODEX_BIN: path.join(os.tmpdir(), 'no-such-codex-binary') } })
  const s2 = start(fx2)
  try {
    assert.equal(await s2.eng.listWindows(), null)
    assert.ok(s2.logs.some(l => /找不到可用的 codex/.test(l)))
  } finally { await s2.stop(); fx2.cleanup() }
  const fx3 = fixture({ threads: THREADS, open: [A], extraEnv: { FAKE_CODEX_VERSION: '0.170.1' } })
  const s3 = start(fx3)
  try {
    assert.ok(await s3.eng.listWindows())   // 比驗證過的新：照常用，但記一筆提醒
    assert.ok(s3.logs.some(l => /已驗證版本 0\.154\.0/.test(l)))
  } finally { await s3.stop(); fx3.cleanup() }
})

test('開視窗：替名字建好有內容的 thread（不花模型額度）、釋放鎖、{name} 換成 thread id；同名舊 session 接續；同名已開著就拒絕', async () => {
  const fx = fixture({ threads: [{ id: A, name: '舊的', updatedAt: 5 }], open: [] })
  const launched = []
  const s = start(fx, { startWindow: async spec => { launched.push(spec); return { pid: 4242 } } })
  try {
    await s.eng.listWindows()
    const spec = { command: 'cmd.exe', args: ['/c', 'codex', 'resume', '新視窗', '-s', 'read-only'], cwd: fx.dir, env: {}, name: '新視窗' }
    assert.deepEqual(await s.eng.openWindow(spec), { pid: 4242 })
    const st = fx.readState()
    const made = st.threads.find(t => t.name === '新視窗')
    assert.ok(made && made.seeded?.[0]?.content?.[0]?.text.includes('RELAY 來信'), '要注入說明外部來信的種子內容')
    assert.equal(made.cwd, fx.dir)
    assert.deepEqual(launched[0].args, ['/c', 'codex', 'resume', made.id, '-s', 'read-only'])
    assert.ok(!fs.existsSync(path.join(fx.home, 'thread-writer-locks', `${made.id}.lock`)), '建立用的行程結束後鎖要釋放，視窗才接得上')
    assert.ok(!fx.readCalls().some(c => c.method === 'thread/resume'))
    // 同名的舊 session（沒開著）→ 接續它，不另建
    await s.eng.openWindow({ ...spec, name: '舊的', args: ['resume', '舊的'] })
    assert.deepEqual(launched[1].args, ['resume', A])
    assert.equal(fx.readState().threads.length, 2)
    // 同名已開著 → 拒絕
    fs.writeFileSync(path.join(fx.home, 'thread-writer-locks', `${A}.lock`), '')
    await assert.rejects(s.eng.openWindow({ ...spec, name: '舊的', args: ['resume', '舊的'] }), /已經有叫「舊的」的 Codex 視窗開著/)
    await assert.rejects(s.eng.openWindow({ ...spec, name: '' }), /需要視窗名字/)
  } finally { await s.stop(); fx.cleanup() }
})

test('身分判定：CODEX_THREAD_ID 對 session_index.jsonl；沒名字／不是 thread id／沒變數；findCaller 帶 engine', () => {
  const fx = fixture({ threads: THREADS, open: [] })
  try {
    const env = { CODEX_HOME: fx.home, CODEX_THREAD_ID: A }
    assert.equal(inspectCaller(env).viaEnv.name, '視窗甲')
    assert.equal(inspectCaller({ ...env, CODEX_THREAD_ID: C }).viaEnv.name, '')
    assert.equal(inspectCaller({ ...env, CODEX_THREAD_ID: 'not-a-uuid' }).viaEnv, null)
    assert.equal(inspectCaller({ CODEX_HOME: fx.home }).viaEnv, null)
    assert.deepEqual(readNameIndex(fx.home).byName.get('視窗乙'), [B])
    const provider = { engine: 'codex', inspectCaller: () => inspectCaller(env) }
    assert.deepEqual(findCaller('寄信', [{ engine: 'claude', inspectCaller: () => ({ viaChain: null, viaEnv: null }) }, provider]), { pid: process.ppid, name: '視窗甲', engine: 'codex' })
    assert.throws(() => findCaller('收信', [{ engine: 'codex', inspectCaller: () => inspectCaller({ ...env, CODEX_THREAD_ID: C }) }]), /沒有名字，無法當收件人/)
  } finally { fx.cleanup() }
})

test('launcher.json：profile 可指定 engine；buildSpawn 帶出 name 與 engine，環境過濾依 engine；engine 格式不對就拒絕', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'irori-codex-launcher-'))
  try {
    const file = path.join(d, 'launcher.json')
    const conf = (extra = {}) => ({ cwd_allow: [d], profiles: { codex: { label: 'Codex', command: 'cmd.exe', args: ['/c', 'codex', 'resume', '{name}'], ...extra }, default: { command: 'x', args: ['{name}'] } } })
    fs.writeFileSync(file, JSON.stringify(conf({ engine: 'codex' })))
    const { config } = loadConfig(file)
    assert.equal(config.profiles.codex.engine, 'codex'); assert.equal(config.profiles.default.engine, '')
    const seen = []
    const s = buildSpawn(config, { profile: 'codex', name: 'T-1', cwd: d }, { PATH: 'p' }, (env, engine) => { seen.push(engine); return env })
    assert.deepEqual([s.name, s.engine, s.args, seen], ['T-1', 'codex', ['/c', 'codex', 'resume', 'T-1'], ['codex']])
    fs.writeFileSync(file, JSON.stringify(conf({ engine: 'Bad Engine!' })))
    assert.match(loadConfig(file).error, /engine 要是轉接器代號/)
  } finally { fs.rmSync(d, { recursive: true, force: true }) }
})

test('子行程環境：清 OPENAI_API_KEY／CODEX_API_KEY／視窗識別／CLAUDE*／仲介金鑰，保留 CODEX_HOME 與其他', () => {
  const out = codexChildEnv({ PATH: 'p', CODEX_HOME: 'h', OPENAI_API_KEY: 'sk-x', CODEX_API_KEY: 'k', CODEX_THREAD_ID: 't', CODEX_SESSION_ID: 's', CODEX_CI: '1', CODEX_SANDBOX_NETWORK_DISABLED: '1',
    CLAUDECODE: '1', NO_COLOR: '1', IRORI_RELAY_KEY: 'k', IRORI_RELAY_ANON_KEY: 'a', ASN_RELAY_KEY: 'k2', ASN_RELAY_ANON_KEY: 'a2', IRORI_RELAY_ID: 'H' })
  // 金鑰新舊名都擋；非金鑰的改名變數新舊名都帶
  assert.deepEqual(out, { PATH: 'p', CODEX_HOME: 'h', IRORI_RELAY_ID: 'H', ASN_RELAY_ID: 'H' })
})

// ---------------------------------------------------------------- 讓 bridge.mjs 載入 codex 轉接器跑主流程

const readBody = req => new Promise(r => { let b = ''; req.on('data', d => b += d); req.on('end', () => r(b ? JSON.parse(b) : null)) })
async function fakeRelay(inbox) {
  const st = { acked: new Set(), sent: [], rosterPosts: [] }
  const srv = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x')
    const out = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)) }
    const a = u.searchParams.get('action')
    if (a === 'whoami') return out(200, { node: 'T', bell_topic: 'bell-test' })
    // 名單上報過之後才交出信（真實環境橋的名單早就建好了；codex 第一次列名單要先偵測版本，比 claude 慢一點）
    if (a === 'inbox') return out(200, { messages: st.rosterPosts.length ? inbox.filter(m => !st.acked.has(m.id)) : [] })
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

test('橋整合：IRORI_ENGINES=codex → 名單上報帶 engine=codex；來信轉進 Codex 佇列，回覆以 reply_to 寄回；信標頭帶 engine=codex', async () => {
  const fx = fixture({ threads: THREADS, open: [A, B], extraEnv: { FAKE_CODEX_REPLY: '橋整合回覆', FAKE_CODEX_REPLY_MS: '200' } })
  const inbox = [{ id: uid(0xf1), from_node: 'W', from_agent: 'W-政策', trust: 'member', body: '內文-F1', to_agent: '視窗甲' }]
  const st = await fakeRelay(inbox)
  const child = spawnTracked(process.execPath, [path.join(MACHINE, 'bridge.mjs')], {
    cwd: fx.dir, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true,
    env: { ...fx.env, HOME: fx.dir, USERPROFILE: fx.dir, IRORI_RELAY_ID: 'T', IRORI_RELAY_KEY: 'fake-test-key', IRORI_LAUNCH_NO_AUTO: '1', IRORI_RELAY_URL: `http://127.0.0.1:${st.port}`,
      IRORI_RELAY_POLL_MS: '200', IRORI_ROSTER_MS: '150', IRORI_ENGINES: CODEX_MJS },
  })
  let log = ''; child.stderr.on('data', d => log += d)
  try {
    const t0 = Date.now()
    while (!(st.acked.has(uid(0xf1)) && st.sent.some(s => s.reply_to === uid(0xf1))) && Date.now() - t0 < 20000) await sleep(50)
    assert.ok(st.acked.has(uid(0xf1)), `mail not acked\n${log}`)
    const back = st.sent.find(s => s.reply_to === uid(0xf1))
    assert.ok(back, `reply not sent\n${log}`)
    assert.equal(back.body, '橋整合回覆'); assert.equal(back.from_agent, '視窗甲'); assert.equal(back.to_node, 'W')
    const roster = st.rosterPosts[0]   // 轉交之前的第一次上報（之後視窗甲處理信時會是 busy）
    assert.deepEqual(roster.agents.map(a => [a.name, a.status, a.engine]), [['視窗甲', 'idle', 'codex'], ['視窗乙', 'busy', 'codex']])
    const q = fx.readCalls().find(c => c.cmd === 'queue')
    assert.match(messageOf(q), /^\[RELAY 來信\] trust=member from=W\/W-政策 to=視窗甲 id=00000000-0000-7000-8000-0000000000f1 engine=codex reply=\?\n寄件人：W-政策（成員身分）\n內文-F1/)
  } finally {
    child.kill(); await new Promise(r => child.once('exit', r)); await st.close(); fx.cleanup()
  }
})

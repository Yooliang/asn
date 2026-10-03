// acp 轉接器測試：用假 agy（fake-agy.mjs，原生 stream-json）與假 ACP agent（fake-acp-worker.mjs）跑完整流程——
// 名單、收信回覆、對話延續與 resume、權限政策（預設唯讀、絆線、白名單資料夾）、問人授權（允許／拒絕／全部允許／逾時）、
// 登入／額度／逾時／崩潰／起不來的回報。完全不碰真的 AI。
// 執行：node --test relay/machine/test/acp-engine.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createEngine } from '../engines/acp.mjs'
import { loadEngines, validateEngine } from '../engines/index.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const FAKE_AGY = path.join(here, 'fake-agy.mjs')
const FAKE_ACP = path.join(here, 'fake-acp-worker.mjs')
const sleep = ms => new Promise(r => setTimeout(r, ms))
const PASS = ['FAKE_AGY_STATE', 'FAKE_ACP_STATE', 'FAKE_ACP_LOAD', 'FAKE_ACP_AUTH']

const agy = (extra = {}) => ({ name: 'Gemini', engine: 'acp', roster_engine: 'gemini', protocol: 'agy-stream', command: process.execPath, args: [FAKE_AGY], env_pass: PASS, ...extra })
const acp = (extra = {}) => ({ name: 'Gemini', engine: 'acp', roster_engine: 'gemini', protocol: 'acp', command: process.execPath, args: [FAKE_ACP], env_pass: PASS, ...extra })

function rig(workers, { env = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'irori-acp-engine-'))
  fs.mkdirSync(path.join(dir, 'st'))
  const file = path.join(dir, 'agents.json')
  fs.writeFileSync(file, JSON.stringify({ workers }))
  const events = [], sent = [], logs = []
  const handlers = {
    onSent: id => events.push({ t: 'sent', id }),
    onFail: (id, reason) => events.push({ t: 'fail', id, reason }),
    onReply: (from, text) => events.push({ t: 'reply', from, text }),
  }
  const make = () => {
    const e = createEngine({
      log: m => logs.push(m), workDir: dir, mailboxName: 'T-收發室',
      env: { ...process.env, IRORI_AGENTS_FILE: file, FAKE_AGY_STATE: path.join(dir, 'st'), FAKE_ACP_STATE: path.join(dir, 'st'), ...env },
      send: async m => { sent.push(m) },
    })
    e.start(handlers)
    return e
  }
  const r = {
    dir, events, sent, logs, engine: make(),
    restart() { r.engine.stop(); r.engine = make() },
    mail(id, body, { from = 'W/政策', to = 'Gemini' } = {}) {
      r.engine.deliver({ id, to, text: `[RELAY 來信] trust=member from=${from} to=${to} id=${id} engine=gemini\n${body}` })
    },
    replies: () => events.filter(e => e.t === 'reply').map(e => e.text),
    fails: () => events.filter(e => e.t === 'fail'),
    async waitFor(pred, what = '條件', ms = 8000) {
      const t0 = Date.now()
      while (!pred()) {
        if (Date.now() - t0 > ms) throw new Error(`等不到：${what}\n--- events ---\n${JSON.stringify(events, null, 1)}\n--- sent ---\n${JSON.stringify(sent)}\n--- logs ---\n${logs.join('\n')}`)
        await sleep(20)
      }
    },
    async waitReplies(n) { await r.waitFor(() => r.replies().length >= n, `${n} 則回覆`) },
    async done() { r.engine.stop(); await sleep(150); try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ } },
    status: async () => (await r.engine.listWindows()).windows[0]?.status,
  }
  return r
}
const ID = n => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`

test('介面：符合轉接器介面，可由 IRORI_ENGINES 的內建名稱 acp 載入；沒有設定檔＝沒有工作者、不出錯', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'irori-acp-iface-'))
  const logs = []
  try {
    const [e] = await loadEngines({ log: m => logs.push(m), workDir: dir, mailboxName: 'T-收發室', env: { IRORI_AGENTS_FILE: path.join(dir, 'nope.json') } }, 'acp')
    validateEngine(e)
    assert.equal(e.id, 'acp')
    assert.deepEqual(e.capabilities(), { listWindows: true, deliver: true, openWindow: false, selfRecv: false, identity: false, fallbackByActivity: false })
    e.start({ onSent() {}, onFail() {}, onReply() {} })
    assert.deepEqual((await e.listWindows()).windows, [])
    assert.ok(logs.some(l => /沒有任何工作者/.test(l)))
    e.stop()
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

// ---- agy-stream（第一選擇）-------------------------------------------------------------------------------

test('agy：名單上以工作者出現（engine=gemini 供顯示、路由用 acp、不當預設代收）；收信→onSent→回覆；第二封不再附說明；同一段對話', async () => {
  const r = rig([agy({ label: '工作者' })])
  try {
    const l = await r.engine.listWindows()
    assert.equal(l.windows.length, 1)
    const w = l.windows[0]
    assert.equal(w.name, 'Gemini'); assert.equal(w.status, 'idle'); assert.equal(w.engine, 'acp'); assert.equal(w.engine_label, 'gemini'); assert.equal(w.noFallback, true); assert.equal(w.cwd_label, '工作者')
    assert.deepEqual([...await r.engine.listNames()], ['Gemini'])
    r.mail(ID(1), '你好')
    await r.waitReplies(1)
    assert.deepEqual(r.events[0], { t: 'sent', id: ID(1) })
    assert.match(r.replies()[0], /收到：你好 \[第1輪 normal 含說明 cwd=Gemini\]/)
    r.mail(ID(2), '再問一個')
    await r.waitReplies(2)
    assert.match(r.replies()[1], /收到：再問一個 \[第2輪 normal cwd=Gemini\]/)   // 沒有「含說明」＝同一段對話、不重複附說明
    assert.equal(r.events.find(e => e.t === 'reply').from, 'Gemini')
  } finally { await r.done() }
})

test('agy：橋重啟後 resume 同一段對話（輪數接續、不再附說明）', async () => {
  const r = rig([agy()])
  try {
    r.mail(ID(1), 'one'); await r.waitReplies(1)
    r.restart()
    r.mail(ID(2), 'two'); await r.waitReplies(2)
    assert.match(r.replies()[1], /\[第2輪 normal cwd=Gemini\]/)
    const saved = JSON.parse(fs.readFileSync(path.join(r.dir, 'acp-workers.json'), 'utf8'))
    assert.match(saved.workers.Gemini.session_id, /^conv-/)
  } finally { await r.done() }
})

test('agy：子行程環境是白名單（呼叫端的金鑰不外洩），env_pass 列的才會帶', async () => {
  const r = rig([agy()], { env: { OPENAI_API_KEY: 'sk-should-not-leak' } })
  try {
    r.mail(ID(1), '@@ENV OPENAI_API_KEY'); await r.waitReplies(1)
    assert.match(r.replies()[0], /\[env OPENAI_API_KEY=absent\]/)
  } finally { await r.done() }
})

test('agy：預設唯讀——寫檔（資料夾外）被絆線中止並明確回報，檔案沒寫成；下一封仍可用且接續對話', async () => {
  const r = rig([agy()])
  try {
    const target = path.join(r.dir, 'outside.txt')
    r.mail(ID(1), `@@WRITE ${target}`)
    await r.waitFor(() => r.fails().length === 1, '寫檔被中止')
    assert.match(r.fails()[0].reason, /想做不被允許的事：寫入：檔案：.*outside\.txt/)
    assert.match(r.fails()[0].reason, /檔案可能已經被寫入/)
    await sleep(400)
    assert.equal(fs.existsSync(target), false)
    r.mail(ID(2), '還在嗎'); await r.waitReplies(1)
    assert.match(r.replies()[0], /還在嗎 \[第2輪/)
  } finally { await r.done() }
})

test('agy：write=allow 時資料夾內可寫；資料夾外仍被擋（白名單）', async () => {
  const r = rig([agy({ permissions: { write: 'allow' } })])
  try {
    const inside = path.join(r.dir, 'workers', 'Gemini', 'ok.txt')
    r.mail(ID(1), `@@WRITE ${inside}`); await r.waitReplies(1)
    assert.match(r.replies()[0], /已寫入/)
    assert.equal(fs.readFileSync(inside, 'utf8'), 'written-by-fake-agy')
    const outside = path.join(r.dir, 'nope.txt')
    r.mail(ID(2), `@@WRITE ${outside}`)
    await r.waitFor(() => r.fails().length === 1, '資料夾外被擋')
    assert.match(r.fails()[0].reason, /路徑在白名單資料夾之外/)
    await sleep(300); assert.equal(fs.existsSync(outside), false)
  } finally { await r.done() }
})

test('agy：指令預設被拒絕——回報「沒有回覆內容＋被政策拒絕的動作」', async () => {
  const r = rig([agy()])
  try {
    r.mail(ID(1), '@@RUN echo hi')
    await r.waitFor(() => r.fails().length === 1, '指令被拒')
    assert.match(r.fails()[0].reason, /沒有產出回覆文字.*執行指令：指令：echo hi/)
  } finally { await r.done() }
})

test('agy：讀不到檔案之類的工具錯誤不算「被政策拒絕」（agy 每個工具錯誤都含 declaring permissions 字樣）', async () => {
  const r = rig([agy()])
  try {
    r.mail(ID(1), '@@MISSING'); await r.waitReplies(1)
    assert.equal(r.replies()[0], '找不到那個檔案')
  } finally { await r.done() }
})

test('agy：execute=allow 用放行旗標執行', async () => {
  const r = rig([agy({ permissions: { execute: 'allow' } })])
  try {
    r.mail(ID(1), '@@RUN echo hi'); await r.waitReplies(1)
    assert.match(r.replies()[0], /ran: echo hi \(full\)/)
  } finally { await r.done() }
})

test('agy：execute=ask——指令被拒後事後問人，同意（回信寫給工作者）就用放行模式重跑，之後回到一般模式', async () => {
  const r = rig([agy({ permissions: { execute: 'ask' }, ask: { notify: [{ node: 'XISU', agent: '希緒' }], timeout_ms: 8000 } })])
  try {
    r.mail(ID(1), '@@RUN echo hi')
    await r.waitFor(() => r.sent.length === 1, '授權詢問寄出')
    assert.equal(r.sent[0].to_node, 'XISU'); assert.equal(r.sent[0].to_agent, '希緒'); assert.equal(r.sent[0].from_agent, 'Gemini')
    assert.match(r.sent[0].body, /授權詢問 [0-9A-F]{4}.*Gemini.*執行指令：指令：echo hi/s)
    const approvalId = /授權詢問 ([0-9A-F]{4})/.exec(r.sent[0].body)[1]
    // 別的節點冒名回覆：不算
    r.mail(ID(2), `允許 ${approvalId}`, { from: 'EVIL/希緒' })
    await r.waitFor(() => r.replies().length >= 0 && r.events.some(e => e.t === 'sent' && e.id === ID(2)), '冒名信被當一般信件')
    assert.equal(r.events.filter(e => e.t === 'reply' && /ran-after-grant/.test(e.text)).length, 0)
    // 真正被問的人
    r.mail(ID(3), `允許 ${approvalId}`, { from: 'XISU/希緒' })
    await r.waitFor(() => r.replies().some(t => /ran-after-grant \(full\)/.test(t)), '放行後重跑')
    assert.ok(r.replies().some(t => t.includes(`已收到：允許（${approvalId}）`)))
    // 下一封回到一般模式
    r.mail(ID(4), '普通問題')
    await r.waitFor(() => r.replies().some(t => /普通問題 \[第\d+輪 normal/.test(t)), '回到一般模式')
  } finally { await r.done() }
})

test('agy：execute=ask——逾時當拒絕，並通知被問的人已自動拒絕', async () => {
  const r = rig([agy({ permissions: { execute: 'ask' }, ask: { notify: [{ node: 'XISU' }], timeout_ms: 300 } })])
  try {
    r.mail(ID(1), '@@RUN rm -rf x')
    await r.waitFor(() => r.fails().length === 1, '逾時拒絕')
    assert.match(r.fails()[0].reason, /被政策拒絕/)
    assert.equal(r.sent.length, 2)
    assert.match(r.sent[1].body, /逾時，已自動拒絕/)
  } finally { await r.done() }
})

test('agy：沒登入——回給寄件人說明、名單狀態 login-required、通知指定的人；登入好之後下一封成功並恢復 idle', async () => {
  const r = rig([agy({ ask: { notify: ['sender', { node: 'XISU' }] } })])
  try {
    r.mail(ID(1), '@@AUTH')
    await r.waitFor(() => r.fails().length === 1, '登入失敗回報')
    assert.match(r.fails()[0].reason, /Gemini 需要登入.*執行 agy 完成 Google 瀏覽器登入/)
    assert.equal(await r.status(), 'login-required')
    assert.equal(r.sent.length, 1); assert.equal(r.sent[0].to_node, 'XISU'); assert.match(r.sent[0].body, /需要登入/)
    r.mail(ID(2), '@@AUTH')                                         // 一小時內不重複通知
    await r.waitFor(() => r.fails().length === 2, '第二次回報')
    assert.equal(r.sent.length, 1)
    r.mail(ID(3), '登入好了'); await r.waitReplies(1)
    assert.equal(await r.status(), 'idle')
  } finally { await r.done() }
})

test('agy：額度用完——回報並標示 quota', async () => {
  const r = rig([agy()])
  try {
    r.mail(ID(1), '@@QUOTA')
    await r.waitFor(() => r.fails().length === 1, '額度回報')
    assert.match(r.fails()[0].reason, /額度用完/)
    assert.equal(await r.status(), 'quota')
  } finally { await r.done() }
})

test('agy：太久沒動靜——中止這一輪並回報，之後仍可用', async () => {
  const r = rig([agy({ turn_timeout_ms: 400 })])
  try {
    r.mail(ID(1), '@@SLEEP')
    await r.waitFor(() => r.fails().length === 1, '逾時')
    assert.match(r.fails()[0].reason, /太久沒有動靜/)
    r.mail(ID(2), '醒著嗎'); await r.waitReplies(1)
    assert.match(r.replies()[0], /醒著嗎/)
  } finally { await r.done() }
})

test('agy：行程中途崩潰——回報，之後仍可用', async () => {
  const r = rig([agy()])
  try {
    r.mail(ID(1), '@@CRASH')
    await r.waitFor(() => r.fails().length === 1, '崩潰')
    assert.match(r.fails()[0].reason, /中途結束了.*boom/)
    r.mail(ID(2), '重來'); await r.waitReplies(1)
  } finally { await r.done() }
})

test('agy：指令不存在——名單上不出現，寄信得到明確說明', async () => {
  const r = rig([agy({ command: path.join(os.tmpdir(), 'definitely-not-agy-xyz') })])
  try {
    await r.waitFor(() => r.logs.some(l => /unavailable/.test(l)), '標成不可用')
    assert.deepEqual((await r.engine.listWindows()).windows, [])
    r.mail(ID(1), '在嗎')
    await r.waitFor(() => r.fails().length === 1, '起不來回報')
    assert.match(r.fails()[0].reason, /目前沒有在跑/)
  } finally { await r.done() }
})

test('agy：佇列——一次一輪、依序回覆、忙碌時名單是 busy、超過上限先不收', async () => {
  const r = rig([agy({ queue_max: 3 })])
  try {
    r.mail(ID(1), 'a'); r.mail(ID(2), 'b'); r.mail(ID(3), 'c'); r.mail(ID(4), 'd')
    await r.waitFor(() => r.fails().length === 1, '第 4 封被擋')
    assert.match(r.fails()[0].reason, /前面還排著 3 封/)
    assert.equal(await r.status(), 'busy')
    await r.waitFor(() => r.replies().length === 3, '三封都回覆')
    assert.deepEqual(r.replies().map(t => /收到：(\w)/.exec(t)[1]), ['a', 'b', 'c'])
    assert.equal(await r.status(), 'idle')
  } finally { await r.done() }
})

test('agy：「不需回覆」的信照樣處理但不寄回；不認得的收件人 deliver 會丟錯', async () => {
  const r = rig([agy()])
  try {
    r.mail(ID(1), '通知一下（不需回覆）')
    await r.waitFor(() => r.logs.some(l => /不需回覆的信/.test(l)), '處理完')
    assert.equal(r.replies().length, 0)
    assert.throws(() => r.engine.deliver({ id: ID(2), to: '不存在', text: 'x' }), /沒有名叫/)
  } finally { await r.done() }
})

// ---- 標準 ACP（備援／其他 agent）-------------------------------------------------------------------------

test('acp：收信回覆；預設政策——edit 被拒、讀資料夾內放行、資料夾外被拒；回信附上被拒動作的備註', async () => {
  const r = rig([acp()])
  try {
    const inside = path.join(r.dir, 'workers', 'Gemini', 'a.txt')
    r.mail(ID(1), `@@READ ${inside} @@EDIT ${inside}`); await r.waitReplies(1)
    assert.match(r.replies()[0], /edit:denied,read:allowed/)
    assert.match(r.replies()[0], /想做的這些動作依這個工作者的政策被拒絕了：\n- 寫入：檔案：/)
    r.mail(ID(2), `@@READ ${path.join(r.dir, 'elsewhere.txt')}`); await r.waitReplies(2)
    assert.match(r.replies()[1], /read:denied/)
  } finally { await r.done() }
})

test('acp：write=allow 且在白名單內放行，白名單外仍拒；fetch 預設放行、network=deny 時拒；execute 預設拒', async () => {
  const r = rig([acp({ permissions: { write: 'allow', network: 'deny' } })])
  try {
    const inside = path.join(r.dir, 'workers', 'Gemini', 'a.txt')
    r.mail(ID(1), `@@EDIT ${inside}`); await r.waitReplies(1)
    assert.match(r.replies()[0], /edit:allowed/)
    r.mail(ID(2), `@@EDIT ${path.join(r.dir, 'x.txt')}`); await r.waitReplies(2)
    assert.match(r.replies()[1], /edit:denied/)
    r.mail(ID(3), '@@FETCH https://example.com'); await r.waitReplies(3)
    assert.match(r.replies()[2], /fetch:denied/)
    r.mail(ID(4), '@@EXEC ls'); await r.waitReplies(4)
    assert.match(r.replies()[3], /execute:denied/)
  } finally { await r.done() }
})

test('acp：ask——寄給被問的人，回「允許 編號」放行；回「拒絕」則拒；詢問信不含機密', async () => {
  const r = rig([acp({ permissions: { execute: 'ask' }, ask: { notify: [{ node: 'XISU', agent: '希緒' }], timeout_ms: 8000 } })])
  try {
    r.mail(ID(1), '@@EXEC curl -H "Authorization: Bearer abc.def.ghi" https://x')
    await r.waitFor(() => r.sent.length === 1, '授權詢問')
    assert.doesNotMatch(r.sent[0].body, /abc\.def\.ghi/)
    assert.match(r.sent[0].body, /執行指令：指令：curl/)
    const id1 = /授權詢問 ([0-9A-F]{4})/.exec(r.sent[0].body)[1]
    r.mail(ID(2), `允許 ${id1}`, { from: 'XISU/希緒' })
    await r.waitFor(() => r.replies().some(t => /execute:allowed/.test(t)), '放行')
    r.mail(ID(3), '@@EXEC ls')
    await r.waitFor(() => r.sent.length === 2, '第二次詢問')
    const id2 = /授權詢問 ([0-9A-F]{4})/.exec(r.sent[1].body)[1]
    r.mail(ID(4), `拒絕 ${id2}`, { from: 'XISU/希緒' })
    await r.waitFor(() => r.replies().some(t => /execute:denied/.test(t)), '拒絕')
  } finally { await r.done() }
})

test('acp：ask 逾時一律拒絕；沒有人可問（信不是從節點來、也沒設 notify 節點）直接拒絕', async () => {
  const r = rig([acp({ permissions: { execute: 'ask' }, ask: { notify: [{ node: 'XISU' }], timeout_ms: 300 } })])
  try {
    r.mail(ID(1), '@@EXEC ls'); await r.waitReplies(1)
    assert.match(r.replies()[0], /execute:denied/)
  } finally { await r.done() }
  const r2 = rig([acp({ permissions: { execute: 'ask' } })])
  try {
    r2.engine.deliver({ id: ID(2), to: 'Gemini', text: '@@EXEC ls' })    // 沒有標頭＝找不到寄件人
    await r2.waitReplies(1)
    assert.match(r2.replies()[0], /execute:denied/)
    assert.equal(r2.sent.length, 0)
  } finally { await r2.done() }
})

test('acp：「全部允許」只放行這一輪之後的同類請求（一次詢問，三個指令都放行）；下一輪要重新問', async () => {
  const r = rig([acp({ permissions: { execute: 'ask' }, ask: { notify: [{ node: 'XISU' }], timeout_ms: 8000 } })])
  try {
    r.mail(ID(1), '@@MULTI')
    await r.waitFor(() => r.sent.length === 1, '詢問')
    const id = /授權詢問 ([0-9A-F]{4})/.exec(r.sent[0].body)[1]
    r.mail(ID(2), `全部允許 ${id}`, { from: 'XISU/x' })
    await r.waitFor(() => r.replies().some(t => /execute:allowed,execute:allowed,execute:allowed/.test(t)), '三個都放行')
    assert.equal(r.sent.length, 1)
    r.mail(ID(3), '@@EXEC ls')
    await r.waitFor(() => r.sent.length === 2, '下一輪重新問')
  } finally { await r.done() }
})

test('acp：agent 宣告 loadSession → 重啟後接續同一段 session；沒宣告 → 開新 session 並重附說明', async () => {
  const a = rig([acp()], { env: { FAKE_ACP_LOAD: '1' } })
  try {
    a.mail(ID(1), 'one'); await a.waitReplies(1)
    assert.match(a.replies()[0], /\[第1輪 含說明\]/)
    a.restart()
    a.mail(ID(2), 'two'); await a.waitReplies(2)
    assert.match(a.replies()[1], /\[第2輪\]/)
  } finally { await a.done() }
  const b = rig([acp()])
  try {
    b.mail(ID(1), 'one'); await b.waitReplies(1)
    b.restart()
    b.mail(ID(2), 'two'); await b.waitReplies(2)
    assert.match(b.replies()[1], /\[第1輪 含說明\]/)
    assert.ok(b.logs.some(l => /先前的對話找不到了/.test(l)))
  } finally { await b.done() }
})

test('acp：啟動時要求登入——名單標 login-required，寄信得到說明', async () => {
  const r = rig([acp()], { env: { FAKE_ACP_AUTH: '1' } })
  try {
    await r.waitFor(() => r.logs.some(l => /login-required/.test(l)), '標成需要登入')
    assert.equal(await r.status(), 'login-required')
    r.mail(ID(1), 'hi')
    await r.waitFor(() => r.fails().length === 1, '回報')
    assert.match(r.fails()[0].reason, /需要登入/)
  } finally { await r.done() }
})

test('acp：太久沒動靜——取消並中止，之後仍可用', async () => {
  const r = rig([acp({ turn_timeout_ms: 400 })])
  try {
    r.mail(ID(1), '@@SLEEP')
    await r.waitFor(() => r.fails().length === 1, '逾時')
    assert.match(r.fails()[0].reason, /太久沒有動靜/)
    r.mail(ID(2), '醒著嗎'); await r.waitReplies(1)
    assert.match(r.replies()[0], /醒著嗎/)
  } finally { await r.done() }
})

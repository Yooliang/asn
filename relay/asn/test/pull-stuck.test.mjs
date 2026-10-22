// 畫面收信迴圈不能被「永遠不回來的等待」卡死（w02 事故：寄給 ASN 自己視窗的信從某時起再也沒被 ack）。
// pull 有 pulling 旗標，上一輪只要有一個 await 沒回來（視窗狀態查詢、存檔、後台呼叫），之後每一輪都直接 return；
// start() 裡啟動那一次 pull 若卡住，連定時器都不會建立。這裡用永遠不回的假步驟重現，並驗證逾時後能繼續收、繼續 ack。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { AsnCore } from '../ui/lib/core.mjs'
import { memStore, sleep } from './helpers.mjs'
import { U } from './fake-relay.mjs'

const NEVER = new Promise(() => {})
const mail = (n, to = '本機視窗') => ({ id: U(n), from_node: 'W', from_agent: 'W-政策', to_node: 'T', to_agent: to, body: `信${n}`, created_at: '2026-10-22T08:00:00Z', expects_reply: true })

// 在 ms 內沒結束就算卡住（回傳 'stuck'）
const within = (p, ms = 3000) => Promise.race([p.then(() => 'done'), sleep(ms).then(() => 'stuck')])

function make(over = {}, { pending = [mail(1)] } = {}) {
  const acked = []
  const calls = { inbox: 0 }
  const transport = {
    list: async () => ({ members: [] }),
    inbox: async () => { calls.inbox++; return { messages: pending.filter(m => !acked.includes(m.id)) } },
    ack: async ids => { acked.push(...ids) },
    send: async () => ({}),
    ...over.transport,
  }
  const core = new AsnCore({ transport, store: over.store ?? memStore(), selfNode: 'T', windowName: '本機視窗', stepMs: 60, ...over.core })
  return { core, acked, calls }
}

test('視窗狀態查詢永遠不回：信仍進對話、仍被 ack、pulling 旗標放開，下一輪照收', async () => {
  const { core, acked } = make({ core: { isChatVisible: () => NEVER } })
  assert.equal(await within(core.pull('test')), 'done', '第一輪不能卡住')
  assert.deepEqual(acked, [U(1)])
  assert.deepEqual(core.logOf('W/W-政策').map(m => m.text), ['信1'])
  assert.equal(core.pulling, false)
  await core.stop()
})

test('後台 inbox 這一輪永遠不回：逾時後這一輪結束，下一輪恢復收信（不是永遠 return）', async () => {
  let n = 0
  const { core, acked } = make({ transport: { inbox: async () => (n++ === 0 ? NEVER : { messages: [mail(1)] }) } })
  assert.equal(await within(core.pull('test')), 'done', '卡住的那輪要在逾時後結束')
  assert.equal(core.conn, 'off')
  assert.equal(await within(core.pull('test')), 'done')
  assert.deepEqual(acked, [U(1)], '下一輪恢復收信並 ack')
  await core.stop()
})

test('存檔永遠不回：不擋住 ack', async () => {
  const store = { load: async () => null, save: () => NEVER }
  const { core, acked } = make({ store })
  assert.equal(await within(core.pull('test')), 'done')
  assert.deepEqual(acked, [U(1)])
  await within(core.stop())
})

test('啟動時名單永遠不回：start() 仍會返回並建立定時收信（以前整個停擺）', async () => {
  const { core, calls } = make({ transport: { list: () => NEVER }, core: { pollMs: 40, rosterMs: 10_000, statusPollMs: 10_000 } })
  assert.equal(await within(core.start(), 3000), 'done', 'start 不能卡住')
  const before = calls.inbox
  await sleep(200)
  assert.ok(calls.inbox > before, '沒有門鈴也會定時收')
  await core.stop()
})

test('啟動時第一次收信卡在視窗狀態查詢：定時器照樣建立、之後的輪詢照常 ack', async () => {
  const { core, acked } = make({ core: { isChatVisible: () => NEVER, pollMs: 40, rosterMs: 10_000, statusPollMs: 10_000 } })
  assert.equal(await within(core.start(), 3000), 'done')
  await sleep(150)
  assert.deepEqual(acked, [U(1)])
  await core.stop()
})

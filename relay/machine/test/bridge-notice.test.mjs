import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sendBridgeNotice, noticeBody } from '../bridge-notice.mjs'

const httpErr = (status, error) => Object.assign(new Error(`bridge_notice HTTP ${status} ${error}`), { status })
function setup(apiImpl) {
  const calls = { api: [], legacy: 0, log: [] }
  const api = async (a, o) => { calls.api.push([a, o]); return apiImpl() }
  const legacy = async () => { calls.legacy++; return true }
  const run = () => sendBridgeNotice({ api, replyTo: 'm1', body: 'hi', legacy, log: s => calls.log.push(s) })
  return { calls, run }
}

test('200 sent：不退回', async () => {
  const { calls, run } = setup(() => ({ ok: true, notify: 'sent', id: 'x' }))
  assert.equal(await run(), true)
  assert.equal(calls.legacy, 0)
  assert.deepEqual(calls.api[0], ['bridge_notice', { method: 'POST', body: { reply_to: 'm1', body: 'hi' } }])
})
for (const n of ['rate_limited', 'per_mail_limit']) {
  test(`200 ${n}：不退回，只記 log`, async () => {
    const { calls, run } = setup(() => ({ ok: true, notify: n }))
    assert.equal(await run(), true)
    assert.equal(calls.legacy, 0)
    assert.equal(calls.log.length, 1)
  })
}
test('409 cross_account：退回舊寄法一次', async () => {
  const { calls, run } = setup(() => { throw httpErr(409, 'cross_account') })
  assert.equal(await run(), true)
  assert.equal(calls.legacy, 1)
})
test('404 舊後台：退回舊寄法', async () => {
  const { calls, run } = setup(() => { throw httpErr(404, 'not_found') })
  assert.equal(await run(), true)
  assert.equal(calls.legacy, 1)
})
test('409 其他原因不退回', async () => {
  const { calls, run } = setup(() => { throw httpErr(409, 'other') })
  assert.equal(await run(), false)
  assert.equal(calls.legacy, 0)
})
test('500 與網路錯誤：不退回、回 false', async () => {
  for (const e of [httpErr(500, 'boom'), new Error('bridge_notice 連線失敗')]) {
    const { calls, run } = setup(() => { throw e })
    assert.equal(await run(), false)
    assert.equal(calls.legacy, 0)
  }
})
test('沒有原信 id：直接走舊寄法', async () => {
  const calls = { legacy: 0, api: 0 }
  const ok = await sendBridgeNotice({ api: async () => { calls.api++ }, replyTo: '', body: 'x', legacy: async () => { calls.legacy++; return true } })
  assert.equal(ok, true); assert.equal(calls.api, 0); assert.equal(calls.legacy, 1)
})
test('bridge_notice 內文不含收件人／寄件人欄位', () => {
  const b = noticeBody('m1', 'hi')
  assert.deepEqual(Object.keys(b).sort(), ['body', 'reply_to'])
  for (const k of ['to_node', 'to_agent', 'from_agent', 'expects_reply']) assert.ok(!(k in b))
})

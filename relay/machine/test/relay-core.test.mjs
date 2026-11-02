// relay-core 的防卡住（#177）：1) api() 整個呼叫（含讀完回應內容）有時限，不靠 AbortSignal.timeout  2) 門鈴連線半開時主動斷開重連
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createCore } from '../relay-core.mjs'

const sleep = ms => new Promise(r => setTimeout(r, ms))
const never = () => new Promise(() => {})

async function withFetch(fake, fn) {
  const real = globalThis.fetch
  globalThis.fetch = fake
  try { return await fn() } finally { globalThis.fetch = real }
}
const core = (o = {}) => createCore({ baseUrl: 'http://x.test/relay', key: 'k', anonKey: 'a', log: () => {}, workDir: '.', ...o })

test('api：連線永遠不回（連訊號都不理）也會在時限內失敗', async () => {
  await withFetch(() => never(), async () => {
    const t0 = Date.now()
    const e = await core({ apiTimeoutMs: 60 }).api('inbox').then(() => null, e => e)
    assert.ok(e && /timeout/.test(e.message) && e.code === 'ETIMEDOUT', String(e))
    assert.ok(Date.now() - t0 < 1000)
  })
})

test('api：標頭回來了但內容永遠讀不完，也會在時限內失敗', async () => {
  await withFetch(async () => ({ ok: true, status: 200, text: () => never() }), async () => {
    const e = await core({ apiTimeoutMs: 60 }).api('inbox').then(() => null, e => e)
    assert.ok(e && e.code === 'ETIMEDOUT', String(e))
  })
})

test('api：時限一到就中止底層連線（訊號被 abort）；正常回應不受影響', async () => {
  let signal = null
  await withFetch((url, o) => { signal = o.signal; return never() }, async () => {
    await core({ apiTimeoutMs: 40 }).api('inbox').catch(() => {})
    assert.equal(signal.aborted, true)
  })
  await withFetch(async () => ({ ok: true, status: 200, text: async () => '{"messages":[]}' }), async () => {
    assert.deepEqual(await core({ apiTimeoutMs: 60 }).api('inbox'), { messages: [] })
  })
  await withFetch(async () => ({ ok: false, status: 403, text: async () => '{"error":"forbidden"}' }), async () => {
    const e = await core({ apiTimeoutMs: 60 }).api('roster').then(() => null, e => e)
    assert.equal(e.status, 403)
  })
})

class FakeWS {
  static all = []
  constructor(url) { this.url = url; this.sent = []; this.closed = false; FakeWS.all.push(this) }
  send(s) { this.sent.push(JSON.parse(s)) }
  close() { this.closed = true }
  frame(obj) { this.onmessage({ data: JSON.stringify(obj) }) }
}
async function withWS(fn) {
  const real = globalThis.WebSocket
  FakeWS.all = []
  globalThis.WebSocket = FakeWS
  try { return await fn() } finally { globalThis.WebSocket = real }
}

test('門鈴：太久沒收到任何訊息（半開）就主動斷開並重連；有訊息進來就不斷', async () => {
  await withWS(async () => {
    const logs = []
    const c = core({ log: m => logs.push(m), bellHeartbeatMs: 10, bellStaleMs: 60 })
    c.connectBell('topic1', () => {})
    const ws = FakeWS.all[0]
    ws.onopen()
    // 伺服器一直有回心跳：不會被當成半開
    for (let i = 0; i < 8; i++) { await sleep(15); ws.frame({ event: 'phx_reply', topic: 'phoenix', payload: { status: 'ok' } }) }
    assert.equal(ws.closed, false, '一直有訊息就不該斷')
    // 再也收不到東西（機器暫停／還原後連線半開）
    await sleep(150)
    assert.equal(ws.closed, true, '半開要主動斷開')
    assert.ok(logs.some(l => l.includes('doorbell down (stale')), logs.join('|'))
    // 重連：退避 1 秒後建立新連線
    await sleep(1100)
    assert.ok(FakeWS.all.length >= 2, '應該重連')
    FakeWS.all.forEach(w => { try { w.onclose = null; w.onerror = null } catch {} })
  })
})

test('門鈴：收到 bell 與 join 會通知呼叫端（既有行為不變）', async () => {
  await withWS(async () => {
    const got = []
    const c = core({ bellHeartbeatMs: 1000, bellStaleMs: 5000 })
    c.connectBell('topic1', why => got.push(why))
    const ws = FakeWS.all[0]
    ws.onopen()
    ws.frame({ event: 'phx_reply', topic: 'realtime:topic1', payload: { status: 'ok' } })
    ws.frame({ event: 'broadcast', topic: 'realtime:topic1', payload: { event: 'bell' } })
    assert.deepEqual(got, ['join', 'bell'])
    ws.onclose = null; ws.onerror = null
  })
})

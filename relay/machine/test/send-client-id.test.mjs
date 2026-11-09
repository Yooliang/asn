// 寄信的 client_id 與重試（#1135）：同一次寄信重試沿用同一個 client_id；不同次寄信不同；只有 send 動作帶、帶了才重試；舊後台忽略多出來的欄位。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createCore, retriable, retrySend, withClientId } from '../relay-core.mjs'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const noSleep = () => Promise.resolve()
async function withFetch(fake, fn) {
  const real = globalThis.fetch
  globalThis.fetch = fake
  try { return await fn() } finally { globalThis.fetch = real }
}
const core = () => createCore({ baseUrl: 'http://x.test/relay', key: 'k', anonKey: 'a', log: () => {}, workDir: '.' })
const okRes = (o, status = 200) => new Response(JSON.stringify(o), { status })

test('withClientId：只有 send 補 UUID；呼叫端自己帶的沿用；其他動作與沒有內文原樣', () => {
  const a = withClientId('send', { body: 'x' })
  assert.match(a.client_id, UUID)
  assert.notEqual(withClientId('send', { body: 'x' }).client_id, a.client_id)
  assert.equal(withClientId('send', { body: 'x', client_id: 'mine' }).client_id, 'mine')
  const ack = { ids: [] }
  assert.equal(withClientId('ack', ack), ack)
  assert.equal(withClientId('send', undefined), undefined)
})

test('retriable：沒有 HTTP 狀態（連線、逾時、讀回應）與 502～504 才重試；400、429、500 不重試', () => {
  assert.equal(retriable(new TypeError('fetch failed')), true)
  for (const s of [502, 503, 504]) assert.equal(retriable({ status: s }), true)
  for (const s of [400, 401, 409, 429, 500]) assert.equal(retriable({ status: s }), false)
})

test('retrySend：非 send 只呼叫一次；send 最多再試三次、成功就停', async () => {
  let n = 0
  await assert.rejects(retrySend('ack', async () => { n++; throw new Error('x') }, { sleep: noSleep }))
  assert.equal(n, 1)
  n = 0
  assert.equal(await retrySend('send', async () => { if (++n < 3) throw new Error('x'); return 'ok' }, { sleep: noSleep }), 'ok')
  assert.equal(n, 3)
  n = 0
  await assert.rejects(retrySend('send', async () => { n++; throw new Error('x') }, { sleep: noSleep, delays: [1, 1, 1] }))
  assert.equal(n, 4)
})

test('api(send)：回應讀失敗後重送，兩次請求內文的 client_id 相同、拿到成功結果', async () => {
  const bodies = []
  let n = 0
  await withFetch(async (_u, init) => { bodies.push(JSON.parse(init.body)); if (++n === 1) throw new TypeError('terminated'); return okRes({ id: 'm1' }) }, async () => {
    assert.deepEqual(await core().api('send', { method: 'POST', body: { to_node: 'W', body: 'hi' } }), { id: 'm1' })
  })
  assert.equal(bodies.length, 2)
  assert.match(bodies[0].client_id, UUID)
  assert.equal(bodies[0].client_id, bodies[1].client_id)
})

test('api(send)：兩次不同的寄信用不同的 client_id；後台回 400 不重試', async () => {
  const ids = []
  await withFetch(async (_u, init) => { ids.push(JSON.parse(init.body).client_id); return okRes({ id: 'm' }) }, async () => {
    await core().api('send', { method: 'POST', body: { body: 'a' } })
    await core().api('send', { method: 'POST', body: { body: 'a' } })
  })
  assert.notEqual(ids[0], ids[1])
  let hits = 0
  await withFetch(async () => { hits++; return okRes({ error: 'bad_client_id' }, 400) }, async () => {
    await assert.rejects(core().api('send', { method: 'POST', body: { body: 'a' } }), /HTTP 400 bad_client_id/)
  })
  assert.equal(hits, 1)
})

test('api(ack)：不帶 client_id、失敗不重試（舊行為不變）', async () => {
  const seen = []
  await withFetch(async (_u, init) => { seen.push(init.body); throw new TypeError('x') }, async () => {
    await assert.rejects(core().api('ack', { method: 'POST', body: { ids: ['a'] } }))
  })
  assert.equal(seen.length, 1)
  assert.ok(!seen[0].includes('client_id'))
})

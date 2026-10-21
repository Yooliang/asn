// 多設備對話連貫（#108）：往來記錄合併、以人寄出的旗標、扇出回信後補看別台說的話。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { AsnCore } from '../ui/lib/core.mjs'
import { cleanRow, entriesOf, historyUnsupported, mergeHistory } from '../ui/lib/history.mjs'
import { startFakeRelay, U, FAKE_KEY } from './fake-relay.mjs'
import { createCore } from '../../machine/relay-core.mjs'
import { httpTransport, memStore } from './helpers.mjs'

const NAME = 'T-ASN'
const row = (n, dir, body, at, extra = {}) => ({ id: U(n), ids: [U(n)], dir, body, created_at: at, reply_to: null, delivered_at: null, acked_at: null, ...extra })
const T0 = '2026-10-22T08:00:00Z'
const T1 = '2026-10-22T08:01:00Z'
const T2 = '2026-10-22T08:02:00Z'

test('合併：本機沒有的補進來並依時間排好；已有的（任何一個複本 id 吻合）不重複', () => {
  const log = [{ k: 'me', text: '在家問', t: Date.parse(T0), id: U(1) }, { k: 'them', text: '回', t: Date.parse(T1), id: U(20) }]
  const rows = [
    row(1, 'me', '在家問', T0),
    row(10, 'them', '回', T1, { ids: [U(10), U(20), U(21)] }),   // 本機存的是複本 U(20)
    row(3, 'me', '公司接著問', T2),
    row(4, 'them', '更早的', '2026-10-22T07:59:00Z'),
  ]
  const r = mergeHistory(log, rows)
  assert.equal(r.added, 2)
  assert.deepEqual(r.log.map(m => `${m.k}:${m.text}`), ['them:更早的', 'me:在家問', 'them:回', 'me:公司接著問'])
  assert.deepEqual(log.map(m => m.text), ['在家問', '回'], '不改原本的陣列')
  // 再合併一次沒有新的 → 原封不動
  const again = mergeHistory(r.log, rows)
  assert.equal(again.added, 0)
  assert.equal(again.log, r.log)
})

test('合併：壞資料整列丟掉；來信照一般收信的整理（去回信抬頭／殼）；震動變系統提示；照片留白名單欄位', () => {
  const bad = [null, 5, {}, { id: 'x', dir: 'me', body: 'a', created_at: T0 }, { ...row(1, 'x', 'a', T0) }, { ...row(1, 'me', 5, T0) }, { ...row(1, 'me', 'a', 'not-a-date') }]
  assert.equal(mergeHistory([], bad).added, 0)
  assert.equal(cleanRow(row(1, 'me', 'a', T0)).t, Date.parse(T0))
  const nudge = entriesOf(cleanRow(row(2, 'them', '（小文 傳送了一個震動）\n想回應的話，就回一個震動：寄一封內文只有「（你的名字 傳送了一個震動）」的信，不用另外回信。', T0)), '小文')
  assert.deepEqual(nudge.map(e => [e.k, e.nudge === true]), [['sys', true]])
  assert.equal(nudge[0].text, '小文 傳送了一個震動。')
  const mine = entriesOf(cleanRow(row(3, 'me', '（小良 傳送了一個震動）\n想回應的話，就回一個震動：寄一封內文只有「（你的名字 傳送了一個震動）」的信，不用另外回信。', T0)), '小文')
  assert.deepEqual(mine.map(e => [e.k, e.mine === true]), [['sys', true]])
  // 已送達／已讀狀態一併帶進自己寄的信
  const st = entriesOf(cleanRow(row(4, 'me', '嗨', T0, { delivered_at: T1, acked_at: T2 })))[0]
  assert.equal(st.deliveredAt, T1)
  assert.equal(st.ackedAt, T2)
  // 附件：只留白名單欄位（外部資料）
  const ph = entriesOf(cleanRow(row(5, 'them', '〔照片〕 a.webp', T0, { attachments: [{ id: U(77), kind: 'image', name: 'a.webp', mime: 'image/webp', bytes: 10, evil: '<script>' }] })))[0]
  assert.equal(ph.photos.length, 1)
  assert.ok(!('evil' in ph.photos[0]))
  assert.equal(historyUnsupported('history HTTP 404 not_found'), true)
  assert.equal(historyUnsupported('history HTTP 400 bad_request'), true)
  assert.equal(historyUnsupported('history HTTP 401 unauthorized'), false)
  assert.equal(historyUnsupported('尚未登入，無法取得雲端的往來記錄'), false)
})

const roster = (asn = []) => [
  { id: 'T', agents: [{ name: NAME, status: 'idle', cwd_label: 'asn' }], asn: [{ window_name: NAME, version: '0.1.21', status: 'online' }] },
  { id: 'W', agents: [{ name: 'W-政策', status: 'idle', cwd_label: 'p' }] },
  { id: 'P', agents: [{ name: 'P-ASN', status: 'idle', cwd_label: 'p' }], asn },
]

async function setup(opts = {}) {
  const relay = await startFakeRelay({ node: 'T', members: roster(opts.asn) })
  const base = httpTransport(relay.url, NAME)
  const c = createCore({ baseUrl: relay.url, key: FAKE_KEY, anonKey: '', log: () => {}, workDir: '' })
  const sent = []
  const transport = { ...base, send: p => { sent.push(p); return base.send(p) } }
  if (!opts.noHistory) transport.history = (node, agent) => c.api('chat_history', { method: 'POST', body: { node, agent } })
  const clock = { t: 1_000_000 }
  const core = new AsnCore({ transport, store: memStore(), selfNode: 'T', windowName: NAME, pollMs: 60_000, rosterMs: 60_000, now: () => clock.t, log: () => {} })
  return { relay, core, sent, clock }
}

test('以人寄出：寄給 AI 的信、震動、照片都帶 person；寄給自己帳號另一台 ASN 的不帶', async () => {
  const { relay, core, sent } = await setup({ asn: [{ window_name: 'P-ASN', version: '0.1.21', status: 'online' }] })
  await core.start()
  assert.deepEqual(await core.send('W/W-政策', '嗨'), { ok: true })
  assert.equal(sent.at(-1).person, true)
  await core.nudge('W/W-政策')
  assert.equal(sent.at(-1).person, true)
  assert.deepEqual(await core.send('P/P-ASN', '設備互聊'), { ok: true })
  assert.ok(!('person' in sent.at(-1)), '另一台 ASN：維持視窗名，對方才看得出是哪台設備')
  await core.stop(); await relay.close()
})

test('往來記錄：打開對話補進別台說的話；不算未讀、不跳提示；太頻繁不重問', async () => {
  const { relay, core, clock } = await setup()
  const notes = []
  core.on('notify', n => notes.push(n))
  await core.start()
  await core.send('W/W-政策', '在家問')
  const mine = core.logOf('W/W-政策')[0]
  relay.historyRows = [
    { ...row(900, 'me', '在家問', T0), id: mine.id, ids: [mine.id] },
    row(5, 'them', '小文回', T1),
    row(6, 'me', '公司接著問', T2),
  ]
  relay.historyRows[0].created_at = new Date(mine.t).toISOString()
  assert.equal(await core.syncHistory('W/W-政策'), 2)
  assert.equal(await core.syncHistory('W/W-政策'), 0, '間隔內不重問')
  assert.equal(relay.reqs.filter(r => r.action === 'chat_history').length, 1)
  clock.t += 25_000
  assert.equal(await core.syncHistory('W/W-政策'), 0, '過了間隔會再問（這次沒有新的）')
  assert.equal(relay.reqs.filter(r => r.action === 'chat_history').length, 2)
  assert.deepEqual(core.logOf('W/W-政策').map(m => m.text).sort(), ['公司接著問', '在家問', '小文回'].sort())
  assert.equal(core.snapshot().friends.find(f => f.id === 'W/W-政策').unread, 0)
  assert.equal(notes.length, 0)
  assert.equal(await core.syncHistory('W/W-政策', { force: true }), 0, '都已經有了')
  await core.stop(); await relay.close()
})

test('往來記錄：後台沒部署（404）這次執行不再問；沒登入（401）下次還會試；沒有 history 傳輸就略過', async () => {
  const a = await setup()
  await a.core.start()
  a.relay.historyStatus = 404
  assert.equal(await a.core.syncHistory('W/W-政策', { force: true }), 0)
  assert.equal(a.core.historyOff, true)
  const n = a.relay.reqs.length
  await a.core.syncHistory('W/W-政策', { force: true })
  assert.equal(a.relay.reqs.length, n, '不再送出請求')
  await a.core.stop(); await a.relay.close()

  const b = await setup()
  await b.core.start()
  b.relay.historyStatus = 401
  assert.equal(await b.core.syncHistory('W/W-政策', { force: true }), 0)
  assert.equal(b.core.historyOff, false)
  b.relay.historyStatus = 0
  b.relay.historyRows = [row(5, 'them', '登入後補到', T1)]
  assert.equal(await b.core.syncHistory('W/W-政策', { force: true }), 1)
  await b.core.stop(); await b.relay.close()

  const c = await setup({ noHistory: true })
  await c.core.start()
  assert.equal(await c.core.syncHistory('W/W-政策', { force: true }), 0)
  assert.equal(c.relay.reqs.filter(r => r.action === 'chat_history').length, 0)
  await c.core.stop(); await c.relay.close()
})

test('扇出回信：記錄的 id 用群組代表；收到後順手補看別台說的話；沒有 fanout_id 的一般來信不多問後台', async () => {
  const { relay, core } = await setup()
  relay.mail(1, { to_agent: NAME, from_node: 'W', from_agent: 'W-政策', fanout_id: U(500), body: '扇出的回信', created_at: T1 })
  relay.historyRows = [row(8, 'me', '我在公司說的', T0), { ...row(500, 'them', '扇出的回信', T1), ids: [U(500), U(1)] }]
  await core.start()
  await new Promise(r => setTimeout(r, 100))
  const log = core.logOf('W/W-政策')
  assert.deepEqual(log.map(m => m.text), ['我在公司說的', '扇出的回信'], '補進的在前、回信沒有重複')
  assert.equal(log.find(m => m.text === '扇出的回信').id, U(500))
  assert.equal(relay.reqs.filter(r => r.action === 'chat_history').length, 1)
  relay.mail(2, { to_agent: NAME, from_node: 'W', from_agent: 'W-政策', body: '一般來信' })
  await core.pull()
  assert.equal(relay.reqs.filter(r => r.action === 'chat_history').length, 1, '一般來信不多問')
  await core.stop(); await relay.close()
})

test('守門：往來記錄與以人寄出只在 ASN 視窗的前端（core／tauri 傳輸）出現，AI 用的 CLI／橋沒有', () => {
  const root = new URL('../../', import.meta.url)
  for (const f of ['machine/send.mjs', 'machine/recv.mjs', 'machine/bridge.mjs', 'machine/relay-core.mjs', 'cloud-agent/agent.mjs']) {
    const p = new URL(f, root)
    if (!fs.existsSync(p)) continue
    const t = fs.readFileSync(p, 'utf8')
    assert.ok(!t.includes('as_person') && !t.includes('chat_history'), `${f} 不該碰以人寄出／往來記錄`)
  }
})

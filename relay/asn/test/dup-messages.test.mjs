// 同一則信在手機對話出現兩次（真機：AI 寄給本人位址，同時間同內容兩則；震動疑似重複）。
// 根因：往來記錄（syncHistory）先把這則補進本機記錄，之後 pull 才收到同一封（後台還沒 ack）；
// #incoming 沒查記錄就直接再推一列。震動的系統提示列沒有 id，兩邊更對不上。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { AsnCore } from '../ui/lib/core.mjs'
import { nudgeBody } from '../ui/lib/text.mjs'
import { startFakeRelay, U, FAKE_KEY } from './fake-relay.mjs'
import { createCore } from '../../machine/relay-core.mjs'
import { httpTransport, memStore } from './helpers.mjs'

const NAME = 'T-ASN'
const FID = 'W/W-政策'
const row = (n, dir, body, at, extra = {}) => ({ id: U(n), ids: [U(n)], dir, body, created_at: at, reply_to: null, delivered_at: null, acked_at: null, ...extra })
const T1 = '2026-10-22T08:01:00Z'
const roster = () => [
  { id: 'T', agents: [{ name: NAME, status: 'idle', cwd_label: 'asn' }], asn: [{ window_name: NAME, version: '0.1.35', status: 'online' }] },
  { id: 'W', agents: [{ name: 'W-政策', status: 'idle', cwd_label: 'p' }] },
]

async function setup() {
  const relay = await startFakeRelay({ node: 'T', members: roster() })
  const base = httpTransport(relay.url, NAME)
  const c = createCore({ baseUrl: relay.url, key: FAKE_KEY, anonKey: '', log: () => {}, workDir: '' })
  const transport = { ...base, history: (node, agent) => c.api('chat_history', { method: 'POST', body: { node, agent } }) }
  const core = new AsnCore({ transport, store: memStore(), selfNode: 'T', windowName: NAME, pollMs: 60_000, rosterMs: 60_000, log: () => {} })
  return { relay, core }
}
const mail = (relay, extra = {}) => relay.mail(1, { to_agent: NAME, from_node: 'W', from_agent: 'W-政策', created_at: T1, ...extra })

test('往來記錄先補進、之後 pull 才收到同一封（扇出 id）→ 只一則，提示照舊一次', async () => {
  const { relay, core } = await setup()
  const notes = []
  core.on('notify', n => notes.push(n))
  await core.start()
  relay.historyRows = [{ ...row(500, 'them', '扇出的信', T1, { fanout_id: U(500) }), ids: [U(500), U(1)] }]
  assert.equal(await core.syncHistory(FID, { force: true }), 1)
  mail(relay, { fanout_id: U(500), body: '扇出的信' })
  await core.pull()
  assert.equal(core.logOf(FID).filter(m => m.text === '扇出的信').length, 1)
  assert.equal(notes.filter(n => n.kind === 'msg').length, 1)
  await core.stop(); await relay.close()
})

test('沒有 fanout_id 的一般來信：補進往來記錄後再 pull 也不重複', async () => {
  const { relay, core } = await setup()
  await core.start()
  relay.historyRows = [row(1, 'them', '一般來信', T1)]
  assert.equal(await core.syncHistory(FID, { force: true }), 1)
  mail(relay, { body: '一般來信' })
  await core.pull()
  assert.equal(core.logOf(FID).filter(m => m.text === '一般來信').length, 1)
  await core.stop(); await relay.close()
})

test('震動（只有系統提示）：往來記錄與 pull 不論誰先到，都只留一行提示', async () => {
  for (const historyFirst of [true, false]) {
    const { relay, core } = await setup()
    await core.start()
    const body = nudgeBody('W-政策')
    relay.historyRows = [row(600, 'them', body, T1, { fanout_id: U(600) })]
    mail(relay, { fanout_id: U(600), body })
    if (historyFirst) { await core.syncHistory(FID, { force: true }); await core.pull() }
    else { await core.pull(); await new Promise(r => setTimeout(r, 50)); await core.syncHistory(FID, { force: true }) }
    assert.equal(core.logOf(FID).filter(m => m.nudge).length, 1, historyFirst ? '補歷史在先' : 'pull 在先')
    await core.stop(); await relay.close()
  }
})

test('自己按震動：本機先插的那列，之後往來記錄回來同一則（有信件 id）不再多出第二行「你已傳送震動」', async () => {
  const { relay, core } = await setup()
  await core.start()
  assert.equal((await core.nudge(FID)).ok, true)
  relay.historyRows = [row(901, 'me', nudgeBody(NAME), new Date().toISOString())]   // 假後台寄出的第一封 id＝U(901)
  await core.syncHistory(FID, { force: true })
  assert.equal(core.logOf(FID).filter(m => m.nudge && m.mine).length, 1)
  await core.syncHistory(FID, { force: true })
  assert.equal(core.logOf(FID).filter(m => m.nudge && m.mine).length, 1)
  await core.stop(); await relay.close()
})

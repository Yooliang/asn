// 寄給 ASN 程式本身（engine＝asn）：不期待回信、不顯示「等對方回信」與「未回」。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { AsnCore } from '../ui/lib/core.mjs'
import { expectsReplyTo, showsWaiting } from '../ui/lib/roster.mjs'
import { startFakeRelay } from './fake-relay.mjs'
import { httpTransport, memStore } from './helpers.mjs'

const NAME = 'T-ASN'
const members = [
  { id: 'T', agents: [{ name: NAME, status: 'idle', cwd_label: 'asn' }] },
  { id: 'W', agents: [{ name: 'W-政策', status: 'idle', cwd_label: 'policy-tw' }, { name: 'W-ASN', status: 'idle', engine: 'asn', cwd_label: 'a' }] },
]

test('純函式：ASN 視窗不期待回信、不顯示等待；一般視窗照舊', () => {
  assert.equal(expectsReplyTo({ engine: 'asn' }), false)
  assert.equal(expectsReplyTo({ engine: ' ASN ' }), false)
  assert.equal(expectsReplyTo({ engine: 'claude' }), true)
  assert.equal(expectsReplyTo({ engine: null }), true)
  assert.equal(showsWaiting({ engine: 'asn', waiting: true }), false)
  assert.equal(showsWaiting({ engine: 'claude', waiting: true }), true)
  assert.equal(showsWaiting({ engine: 'claude', waiting: false }), false)
  assert.equal(showsWaiting(null), false)
})

test('寄給 ASN 視窗：expects_reply＝false、waiting＝false；一般視窗不受影響', async () => {
  const relay = await startFakeRelay({ node: 'T', members })
  const core = new AsnCore({ transport: httpTransport(relay.url, NAME), store: memStore(), selfNode: 'T', windowName: NAME, isChatVisible: async () => false, pollMs: 60_000, rosterMs: 60_000 })
  await core.start()
  const id = 'W/W-ASN'
  assert.ok(core.snapshot().friends.some(f => f.id === id), '好友資料仍在')
  assert.equal((await core.send(id, '給設備的訊息')).ok, true)
  assert.equal(relay.sent[0].to_agent, 'W-ASN')
  assert.equal(relay.sent[0].expects_reply, false)
  assert.equal(core.snapshot().friends.find(f => f.id === id).waiting, false)
  assert.equal((await core.send('W/W-政策', '一般視窗')).ok, true)
  assert.equal(relay.sent[1].expects_reply, true)
  assert.equal(core.snapshot().friends.find(f => f.id === 'W/W-政策').waiting, true)
  await core.stop(); await relay.close()
})

test('畫面接線：chatpane 的等待提示與未回都以 ASN 判斷把關', () => {
  const src = fs.readFileSync(new URL('../ui/lib/chatpane.mjs', import.meta.url), 'utf8')
  assert.ok(src.includes('<template v-else-if="showWaiting">'))
  assert.ok(src.includes("m.unanswered != null && !isAsn"))
})

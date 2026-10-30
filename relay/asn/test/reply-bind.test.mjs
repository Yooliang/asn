// 回信綁原信（0.1.113 第 1 階段，設計見 docs/design/OPTION-REPLY.md 3.4）：
// 綁的是「最後一封要回、我還沒回的信」；重開 ASN 後從對話記錄還原；使用者可以取消。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { AsnCore, pendingReplyOf } from '../ui/lib/core.mjs'
import { startFakeRelay, U } from './fake-relay.mjs'
import { httpTransport, memStore } from './helpers.mjs'

const NAME = 'T-ASN'
const members = [
  { id: 'T', agents: [{ name: NAME, status: 'idle', cwd_label: 'asn' }] },
  { id: 'W', agents: [{ name: 'W-政策', status: 'idle', cwd_label: 'policy-tw' }] },
]
const ID = 'W/W-政策'

async function open(relay, store, t) {
  const core = new AsnCore({ transport: httpTransport(relay.url, NAME), store, selfNode: 'T', windowName: NAME, isChatVisible: async () => false, pollMs: 60_000, rosterMs: 60_000 })
  await core.start()
  t.after(() => core.stop())
  return core
}

test('不用回的信不當成回信對象：之後回信仍綁在前一封要回的信', async t => {
  const relay = await startFakeRelay({ node: 'T', members })
  t.after(() => relay.close())
  relay.mail(7, { body: '請問進度？' })
  relay.mail(8, { body: '通知：已部署', expects_reply: false })
  const core = await open(relay, memStore(), t)
  assert.equal((await core.send(ID, '進度八成')).ok, true)
  assert.equal(relay.sent[0].reply_to, U(7))
})

test('重開 ASN 後仍綁得到：從對話記錄還原，不只存在記憶體', async t => {
  const relay = await startFakeRelay({ node: 'T', members })
  t.after(() => relay.close())
  relay.mail(7, { body: '請問進度？' })
  const store = memStore()
  const a = await open(relay, store, t)
  await a.stop()
  // 後台已經沒有這封信待領（已讀走）；第二次啟動只能靠存下來的對話記錄
  const b = await open(relay, store, t)
  assert.equal((await b.send(ID, '回覆')).ok, true)
  assert.equal(relay.sent[0].reply_to, U(7))
})

test('回過就不再綁：我送出之後、下一封要回的信來之前不帶 reply_to', async t => {
  const relay = await startFakeRelay({ node: 'T', members })
  t.after(() => relay.close())
  relay.mail(7, { body: '請問進度？' })
  const store = memStore()
  const a = await open(relay, store, t)
  await a.send(ID, '好')
  await a.stop()
  const b = await open(relay, store, t)
  await b.send(ID, '補一句')
  assert.equal(relay.sent[1].reply_to, undefined)
})

test('取消與預覽：標籤給原信第一行（最多 40 字），取消後這次不帶 reply_to', async t => {
  const relay = await startFakeRelay({ node: 'T', members })
  t.after(() => relay.close())
  relay.mail(7, { body: `第一行${'長'.repeat(60)}\n第二行` })
  const core = await open(relay, memStore(), t)
  const p = core.replyPreview(ID)
  assert.ok(p.startsWith('第一行長') && p.endsWith('…') && p.length === 41, p)
  assert.ok(!p.includes('第二行'))
  core.dropReply(ID)
  assert.equal(core.replyPreview(ID), null)
  await core.send(ID, '不綁')
  assert.equal(relay.sent[0].reply_to, undefined)
})

test('pendingReplyOf：空記錄、只有我送的、ask:false 都沒有；舊記錄（沒有 mid／ask）退回 id', () => {
  assert.equal(pendingReplyOf(undefined), null)
  assert.equal(pendingReplyOf([]), null)
  assert.equal(pendingReplyOf([{ k: 'me', text: 'x' }]), null)
  assert.equal(pendingReplyOf([{ k: 'them', text: 'a', id: 'old-1' }]), 'old-1')
  assert.equal(pendingReplyOf([{ k: 'them', text: 'a', id: 'x', mid: 'm1' }, { k: 'them', text: 'b', id: 'y', mid: 'm2', ask: false }]), 'm1')
  assert.equal(pendingReplyOf([{ k: 'them', text: 'a', id: 'x', mid: 'm1' }, { k: 'me', text: 'r' }]), null)
})

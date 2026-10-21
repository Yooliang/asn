import assert from 'node:assert/strict'
import { test } from 'node:test'
import { applyStatusRow, chunkIds, collectPollIds, needsPoll, statusTip, tierOf } from '../ui/lib/sent-status.mjs'

test('tierOf：已回覆優先於已讀、已讀優先於已送達', () => {
  const base = { k: 'me', id: 'x', t: Date.now() }
  assert.equal(tierOf(base), 'sent')
  assert.equal(tierOf({ ...base, deliveredAt: '2026-01-01T00:00:00Z' }), 'delivered')
  assert.equal(tierOf({ ...base, deliveredAt: 'a', ackedAt: 'b' }), 'read')
  assert.equal(tierOf({ ...base, ackedAt: 'b', repliedAt: 'c' }), 'replied')
  assert.equal(tierOf({ k: 'them', id: 'x' }), null)
})

test('applyStatusRow：只更新自己的 id，時間只往前填', () => {
  const m = { k: 'me', id: 'a', t: 1 }
  assert.equal(applyStatusRow(m, { id: 'b' }), false)
  assert.equal(applyStatusRow(m, { id: 'a', delivered_at: 'd1' }), true)
  assert.equal(m.deliveredAt, 'd1')
  assert.equal(applyStatusRow(m, { id: 'a', delivered_at: 'd2', acked_at: 'a1' }), true)
  assert.equal(m.ackedAt, 'a1')
})

test('needsPoll 與 collectPollIds：已讀或已回覆、過期的不查', () => {
  const now = 1_700_000_000_000
  const logs = new Map([['f', [{ k: 'me', id: '1', t: now - 1000 }, { k: 'me', id: '2', t: now - 8 * 86400_000, ackedAt: null }]]])
  assert.equal(needsPoll({ k: 'me', id: '1', t: now - 1000 }, now), true)
  assert.equal(needsPoll({ k: 'me', id: '1', t: now - 1000, ackedAt: 'x' }, now), false)
  assert.deepEqual(collectPollIds(logs, now), ['1'])
  assert.deepEqual(chunkIds(['a', 'b'], 1), [['a'], ['b']])
})

test('statusTip：繁中標籤與時間', () => {
  const tip = statusTip({ k: 'me', id: '1', t: new Date('2026-10-20T08:00:00Z').getTime(), deliveredAt: '2026-10-20T08:01:00Z' })
  assert.match(tip, /已送達/)
  assert.match(tip, /送達/)
})

test('已讀記號放在訊息標頭時間後面：送出只顯示時間、送達 ✓、已讀／已回覆 ✓✓', async () => {
  const fs = await import('node:fs')
  const s = fs.readFileSync(new URL('../ui/lib/chatpane.mjs', import.meta.url), 'utf8')
  const who = s.split(/\r?\n/).find(l => l.includes('class="who"'))
  assert.ok(who && who.includes('class="msg-st"'), '記號在 who 那一行')
  assert.ok(who.includes("msgTier(m) !== 'sent'"), '只送出時不顯示記號')
  assert.ok(who.includes("'✓'") && who.includes("'✓✓'"))
  assert.equal(s.split('class="msg-st"').length - 1, 1, '訊息下方不再另外放一個')
})

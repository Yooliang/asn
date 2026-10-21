// issue #16：視窗自己在回信開頭加的「[回覆 id=<信件id> → <節點/視窗>]」抬頭，橋寄回前拆掉。
// 執行：node --test relay/machine/test/
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { stripReplyHead } from '../mail-format.mjs'

const id = 'e01a2ae7-e649-4ff7-8bfb-58733b49fe57'

test('stripReplyHead：拆掉抬頭並取出編號', () => {
  assert.deepEqual(stripReplyHead(`[回覆 id=${id} → H/家用機] 現在不忙`), { id, body: '現在不忙' })
  assert.deepEqual(stripReplyHead(`[回覆 id=${id.toUpperCase()} → w02/工作機]\n第一行\n第二行`), { id, body: '第一行\n第二行' })
})

test('stripReplyHead：不是這個格式就原樣、編號 null', () => {
  for (const s of ['一般內文', '[回覆 id=1 → H] x', `內文 [回覆 id=${id} → H] 後面`, '[RELAY 回信] to=H reply=no', `[回覆 id=${id} -> H] x`]) {
    assert.deepEqual(stripReplyHead(s), { id: null, body: s })
  }
  assert.deepEqual(stripReplyHead(null), { id: null, body: '' })
})

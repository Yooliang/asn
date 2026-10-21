// issue #16：對方視窗的 AI 在回信開頭自己加的「[回覆 id=<uuid> → <節點/視窗>]」抬頭，顯示時剝掉。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { AsnCore } from '../ui/lib/core.mjs'
import { esc, stripReplyHead } from '../ui/lib/text.mjs'
import { memStore } from './helpers.mjs'
import { U } from './fake-relay.mjs'

const HEAD = '[回覆 id=e01a2ae7-e649-4ff7-8bfb-58733b49fe57 → H/家用機]'

test('stripReplyHead：剝開頭抬頭（同行接內文、換行接內文、大寫 uuid 都行）', () => {
  assert.equal(stripReplyHead(`${HEAD} 家用正見現在不算忙：…`), '家用正見現在不算忙：…')
  assert.equal(stripReplyHead(`${HEAD}\n第一行\n第二行`), '第一行\n第二行')
  assert.equal(stripReplyHead('  [回覆 id=E01A2AE7-E649-4FF7-8BFB-58733B49FE57 → w02/工作機]\n好'), '好')
  assert.equal(stripReplyHead('[回覆 id=e01a2ae7-e649-4ff7-8bfb-58733b49fe57 → H]\r\n好'), '好')
})

test('stripReplyHead：不是這個格式一律不動', () => {
  for (const s of ['一般內文', '', `先說一句 ${HEAD} 後面`, '[回覆 id=123 → H/家用機] x', '[回覆 id=e01a2ae7-e649-4ff7-8bfb-58733b49fe57 -> H] x',
    '[回覆] 好', '[RELAY 來信] trust=member', '[回覆 id=e01a2ae7-e649-4ff7-8bfb-58733b49fe57 → H/家用機 沒有右括號']) {
    assert.equal(stripReplyHead(s), s)
  }
  assert.equal(stripReplyHead(null), '')
})

test('stripReplyHead：只剝一次；整則只有抬頭時保留原文（不變空訊息）', () => {
  assert.equal(stripReplyHead(`${HEAD}\n${HEAD} 內文`), `${HEAD} 內文`)
  assert.equal(stripReplyHead(HEAD), HEAD)
})

test('stripReplyHead：剝掉後仍要經 esc 才顯示', () => {
  assert.equal(esc(stripReplyHead(`${HEAD} <img src=x onerror=alert(1)>`)), '&lt;img src=x onerror=alert(1)&gt;')
})

test('收信：回信開頭的抬頭不進對話記錄也不進通知（外殼加抬頭一起剝）', async () => {
  const msg = { id: U(1), from_node: 'W', from_agent: 'W-政策', to_node: 'T', to_agent: '新名', created_at: '2026-10-20T08:00:00Z', expects_reply: true,
    body: `<\\cross-session-message from="x">\n${HEAD} 家用正見現在不算忙\n<\\/cross-session-message>` }
  const transport = { list: async () => ({ members: [] }), inbox: async () => ({ messages: [msg] }), ack: async () => {}, send: async () => ({}) }
  const core = new AsnCore({ transport, store: memStore(), selfNode: 'T', windowName: '新名' })
  const notes = []
  core.on('notify', n => notes.push(n))
  await core.pull('test')
  assert.equal(core.logOf('W/W-政策')[0].text, '家用正見現在不算忙')
  assert.equal(notes[0].line, '家用正見現在不算忙')
  await core.stop()
})

// 群組成員／發言者標示改為「夥伴名（設備名）」（後台 display_label／from_display_label）：
// @ 選單、輸入的 @名字、發言者名字、回覆引用的作者必須是同一個字串；舊後台（沒有新欄位）退回 label／from_label。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mentionTargets, markMentions } from '../ui/lib/mention.mjs'
import { memberRows, speakerLabels } from '../ui/lib/groups.mjs'
import { roomLog } from '../ui/lib/mobile-rooms.mjs'
import { replyTarget } from '../ui/lib/reply-quote.mjs'

const MEMBERS = [
  { key: '~u:me', label: '小良哥', display_label: '小良哥', member_kind: 'human', mine: true },
  { key: 'T~asn-2', label: 'asn-2（小良哥）', display_label: 'asn-2（家用機）', member_kind: 'ai', mine: true },
  { key: 'V~asn-test-1', label: 'asn-test-1（小良哥）', display_label: 'asn-test-1（VM測試機）', member_kind: 'ai', mine: true },
  { key: 'x:r2bbbbbb', label: '報表（阿明）', display_label: '報表（阿明）', member_kind: 'ai', mine: false },
]
const OLD = MEMBERS.map(({ display_label, ...m }) => m)

test('@ 選單用 display_label；舊後台退回 label', () => {
  assert.deepEqual(mentionTargets(MEMBERS).map(t => t.label), ['asn-2（家用機）', 'asn-test-1（VM測試機）', '報表（阿明）'])
  assert.deepEqual(mentionTargets(OLD).map(t => t.label), ['asn-2（小良哥）', 'asn-test-1（小良哥）', '報表（阿明）'])
})

test('成員清單列與 @ 標記用同一個字串', () => {
  assert.deepEqual(memberRows(MEMBERS).filter(r => r.kind === 'ai').map(r => r.label), mentionTargets(MEMBERS).map(t => t.label))
  const html = markMentions('<p>@asn-2（家用機） 看一下</p>', mentionTargets(MEMBERS).map(t => t.label))
  assert.match(html, /<span class="mention">@asn-2（家用機）<\/span>/)
})

test('發言者名字與回覆引用的作者＝@ 選單的名字，點「回覆」能自動 @ 對方', () => {
  const msgs = [
    { seq: 1, from: 'T~asn-2', from_kind: 'ai', relation: 'mine_ai', from_label: 'asn-2（小良哥）', from_display_label: 'asn-2（家用機）', body: '嗨', at: '2026-10-24T00:00:00Z' },
    { seq: 2, from: '~u:me', from_kind: 'human', relation: 'mine', from_label: '小良哥', from_display_label: '小良哥', body: '收到', at: '2026-10-24T00:01:00Z',
      reply_to: { seq: 1, from: 'T~asn-2', from_kind: 'ai', from_label: 'asn-2（小良哥）', from_display_label: 'asn-2（家用機）', excerpt: '嗨' } },
  ]
  const log = roomLog(msgs, ['~u:me'], MEMBERS)
  assert.equal(log[0].who, 'asn-2（家用機）')
  assert.equal(log[1].reply.author, 'asn-2（家用機）')
  const friend = { room: true, mentionable: mentionTargets(MEMBERS) }
  assert.equal(replyTarget(log[0], { friend, index: 0 }).mention, 'asn-2（家用機）')
  // 舊後台：整串都是舊標示，彼此仍一致
  const oldLog = roomLog(msgs.map(({ from_display_label, reply_to, ...m }) => ({ ...m, ...(reply_to ? { reply_to: { ...reply_to, from_display_label: undefined } } : {}) })), ['~u:me'], OLD)
  assert.equal(oldLog[0].who, 'asn-2（小良哥）')
  assert.equal(oldLog[1].reply.author, 'asn-2（小良哥）')
})

test('只有訊息帶 from_display_label、成員清單沒有時，發言者仍用新標示', () => {
  const m = [{ seq: 1, from: 'T~asn-2', from_kind: 'ai', from_label: 'asn-2（小良哥）', from_display_label: 'asn-2（家用機）' }]
  assert.equal(speakerLabels(m, []).get('T~asn-2'), 'asn-2（家用機）')
})

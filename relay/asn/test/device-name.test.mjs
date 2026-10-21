// 設備顯示名：前台一律用該設備 ASN 設的名字（nodes.name），沒有就「未命名設備」，不顯示節點代號。
// 收發室「沒有收到回覆」提醒信：不是對話訊息，改在自己寄出的那則標「未回」資料欄位。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { UNNAMED_DEVICE, noReplyNoticeOf } from '../ui/lib/text.mjs'
import { buildFriends, groupByDevice } from '../ui/lib/roster.mjs'
import { deviceTabs } from '../ui/lib/tabs.mjs'
import { groupItems, pageTabs } from '../ui/lib/dims.mjs'
import { AsnCore } from '../ui/lib/core.mjs'
import { startFakeRelay, U } from './fake-relay.mjs'
import { httpTransport, memStore } from './helpers.mjs'

const MEMBERS = [
  { id: 'w02', agents: [{ name: 'claude-8b', status: 'idle' }] },                  // 沒設名字
  { id: 'H', name: '  家用機  ', agents: [{ name: '家用若莉', status: 'idle' }] },   // 有設名字（頭尾空白去掉）
  { id: 'cloud', name: '', agents: [{ name: '雲端', status: 'idle' }] },
]

test('buildFriends：device＝節點名（去空白），沒有就空字串，不再退回節點代號', () => {
  const f = buildFriends(MEMBERS, { selfNode: 'x', selfName: 'x-ASN' })
  assert.deepEqual(f.map(x => [x.node, x.device]), [['w02', ''], ['H', '家用機'], ['cloud', '']])
})

test('分組標題與頁籤：有名字用名字，沒有「未命名設備」，全程看不到節點代號', () => {
  const f = buildFriends(MEMBERS, { selfNode: 'x', selfName: 'x-ASN' })
  const labels = [
    ...groupByDevice(f, { selfNode: 'x' }).map(g => g.label),
    ...groupItems(f, 'device', { selfNode: 'x' }).map(g => g.label),
    ...deviceTabs(f, { selfNode: 'x', selfName: 'x-ASN', nodeOrder: ['w02', 'H', 'cloud'] }).all.map(t => t.label),
    ...pageTabs(f, 'device', { selfNode: 'x', selfName: 'x-ASN', nodeOrder: ['w02', 'H', 'cloud'] }).all.map(t => t.label),
  ]
  for (const code of ['w02', 'cloud', 'x']) assert.ok(!labels.includes(code), `標題不該是節點代號 ${code}`)
  assert.ok(labels.includes('家用機') && labels.includes(UNNAMED_DEVICE) && labels.includes('x-ASN'))
})

test('本機分組與頁籤用自己的視窗名；離線的舊好友（存檔裡沒有 device）不蓋掉已知名字', () => {
  const f = [
    { id: 'H/舊', node: 'H', agent: '舊', nick: '舊', status: 'offline' },
    { id: 'H/新', node: 'H', agent: '新', nick: '新', status: 'online', device: '家用機' },
    { id: 'S/a', node: 'S', agent: 'a', nick: 'a', status: 'online', device: 'S 裝置名' },
  ]
  assert.equal(groupItems(f, 'device', { selfNode: 'S', selfName: '我的視窗' }).find(g => g.items.some(i => i.node === 'S')).label, '我的視窗')
  assert.equal(groupItems(f, 'device', { selfNode: 'S' }).find(g => g.items.some(i => i.node === 'H')).label, '家用機')
  assert.equal(deviceTabs(f, { selfNode: 'S', selfName: '我的視窗' }).all.find(t => t.key === 'H').label, '家用機')
})

test('noReplyNoticeOf：只認收發室寄的、[收發室] 開頭、含「沒有經收發室收到」的提醒', () => {
  const m = (body, from_agent = 'W-收發室') => ({ from_agent, body })
  assert.deepEqual(noReplyNoticeOf(m('[收發室] W-政策 先前一直在忙，等了約 12 分鐘仍沒有經收發室收到回覆（對方若已另外回信可忽略）。')), { mins: 12 })
  assert.deepEqual(noReplyNoticeOf(m('[收發室] 10 分鐘內沒有經收發室收到 W-政策 的回覆（對方若已另外回信可忽略）。')), { mins: 10 })
  assert.deepEqual(noReplyNoticeOf(m('[收發室] 對方視窗「W-政策」已關閉，沒有經收發室收到回覆')), { mins: 0 })
  assert.equal(noReplyNoticeOf(m('[收發室] 轉交給 W-政策 失敗：原因不明')), null)
  assert.equal(noReplyNoticeOf(m('等了約 12 分鐘仍沒有經收發室收到回覆')), null)
  assert.equal(noReplyNoticeOf(m('[收發室] 等了約 3 分鐘仍沒有經收發室收到回覆', 'W-政策')), null)
  assert.equal(noReplyNoticeOf(null), null)
})

const NAME = 'T-ASN'
const members = [
  { id: 'T', agents: [{ name: NAME, status: 'idle' }] },
  { id: 'W', agents: [{ name: 'W-政策', status: 'idle' }] },
]
async function setup() {
  const relay = await startFakeRelay({ node: 'T', members })
  const core = new AsnCore({ transport: httpTransport(relay.url, NAME), store: memStore(), selfNode: 'T', windowName: NAME, pollMs: 60_000, rosterMs: 60_000 })
  const notes = []
  core.on('notify', n => notes.push(n))
  await core.start()
  return { relay, core, notes }
}
const NOTICE = '[收發室] W-政策 先前一直在忙，等了約 12 分鐘仍沒有經收發室收到回覆（對方若已另外回信可忽略）。'

test('端到端：提醒信不進對話、不提示、不算未讀，只在對應的自己那則標未回分鐘數；已 ack', async () => {
  const { relay, core, notes } = await setup()
  assert.equal((await core.send('W/W-政策', '請幫我查')).ok, true)
  const sentId = U(901)
  relay.mail(1, { from_node: 'W', from_agent: 'W-收發室', body: NOTICE, reply_to: sentId })
  await core.pull('test')
  const log = core.logOf('W/W-政策')
  assert.equal(log.length, 1, '提醒信不進對話')
  assert.equal(log[0].k, 'me')
  assert.equal(log[0].unanswered, 12)
  assert.equal(notes.length, 0)
  assert.equal(core.snapshot().friends.find(f => f.id === 'W/W-政策').unread, 0)
  assert.ok(!core.snapshot().friends.some(f => f.agent === 'W-收發室'), '收發室不變成好友')
  assert.equal(relay.mails[0].acked, true)
  await core.stop(); await relay.close()
})

test('端到端：找不到對應那則（reply_to 對不上或沒有）就直接丟掉，仍然不進對話、不提示', async () => {
  const { relay, core, notes } = await setup()
  await core.send('W/W-政策', '請幫我查')
  relay.mail(1, { from_node: 'W', from_agent: 'W-收發室', body: NOTICE, reply_to: U(555) })
  relay.mail(2, { from_node: 'W', from_agent: 'W-收發室', body: NOTICE, reply_to: null })
  await core.pull('test')
  assert.deepEqual(core.logOf('W/W-政策').map(m => [m.k, m.unanswered]), [['me', undefined]])
  assert.equal(notes.length, 0)
  assert.equal(relay.mails.every(m => m.acked), true)
  await core.stop(); await relay.close()
})

test('端到端：同一個視窗的正常回信照舊進對話與提示', async () => {
  const { relay, core, notes } = await setup()
  await core.send('W/W-政策', '請幫我查')
  relay.mail(1, { from_agent: 'W-政策', body: '查好了', reply_to: U(901) })
  await core.pull('test')
  assert.deepEqual(core.logOf('W/W-政策').map(m => m.k), ['me', 'them'])
  assert.equal(notes.length, 1)
  await core.stop(); await relay.close()
})

// #1829 名字空白時，同一個節點在所有畫面得到完全相同的字串；「手機／電腦」只由 node-platform.mjs 判斷。
// 情境（#1803 的前提）：手機沒有夥伴列種類資料，後台只回報它的平台是 android。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { AsnCore } from '../ui/lib/core.mjs'
import { NOTICE_ID, NOTICE_SENDER, noticeRows } from '../ui/lib/notice.mjs'
import { buildDeviceTree } from '../ui/lib/device-tree.mjs'
import { acctDeviceTree } from '../ui/lib/mobile-acct.mjs'
import { deviceTabs } from '../ui/lib/tabs.mjs'
import { groupItems } from '../ui/lib/dims.mjs'
import { groupByDevice } from '../ui/lib/roster.mjs'
import { nodeLabelOf } from '../ui/lib/account-roster.mjs'
import { launchDevices } from '../ui/lib/mobile-launch.mjs'
import { nodeTail, deviceIdentity } from '../ui/lib/device-identity.mjs'
import { setNodePlatforms } from '../ui/lib/node-platform.mjs'
import { memStore } from './helpers.mjs'

const PHONE = '5b0e2c1a-93d4-4f6e-8a17-0c9d2b7ea9f8'   // 後台實際回傳的是 UUID 形狀
const COMP = 'c4d1e7f2-6a58-4b3c-9e20-71f0a8d3b6c5'
const SELF = '11111111-2222-4333-8444-555555556666'
const friendRow = node => ({ id: `${node}/x`, node, agent: 'x', nick: 'x', status: 'offline', engine: 'claude', unread: 1 })   // 沒有 kind
const friends = [PHONE, COMP].map(friendRow)

test('#1829 UUID 形狀的節點代號：末 4 碼取英數字、轉大寫；邊界', () => {
  assert.equal(nodeTail(PHONE), 'A9F8')
  assert.equal(nodeTail(''), '')
  assert.equal(nodeTail(null), '')
  assert.equal(nodeTail('ab'), 'AB')
  assert.equal(nodeTail('a-b-c-d-e'), 'BCDE')
  assert.equal(deviceIdentity({ node: '', named: false }).title, '電腦', '沒有代號就只寫種類')
})

test('#1829 同一個節點在七處得到完全相同的字串：設備樹、頁籤、群組、通知、額度頁、啟動器選單、詳情標題', async () => {
  setNodePlatforms({ [PHONE]: { platform: 'android' }, [COMP]: { platform: 'windows' } }, { node: SELF, phone: false })
  try {
    for (const [node, want] of [[PHONE, `手機（${nodeTail(PHONE)}）`], [COMP, `電腦（${nodeTail(COMP)}）`]]) {
      const tree = buildDeviceTree({ friends, nodeOrder: [node], selfNode: SELF, machines: { [PHONE]: { platform: 'android' }, [COMP]: { platform: 'windows' } } }).find(d => d.key === node)
      const got = {
        設備樹: tree.label,
        詳情標題: tree.identity.title,
        頁籤: deviceTabs(friends, { selfNode: SELF, nodeOrder: [node] }).all.find(t => t.key === node).label,
        群組分組: groupItems(friends, 'device', { selfNode: SELF }).find(g => g.node === node).label,
        收發室分組: groupByDevice(friends, { selfNode: SELF }).find(g => g.key === node).label,
        額度頁: nodeLabelOf(friends)(node),
        啟動器選單: launchDevices(friends, { selfNode: SELF, nodeOrder: [node] }).find(d => d.key === node).label,
      }
      // 通知寄件者：走真的 AsnCore 收信（沒有 sender_device、名單成員沒名字）
      const base = { to_agent: 'T-ASN', trust: 'member', created_at: new Date().toISOString() }
      const msgs = [{ id: '00000000-0000-4000-8000-0000000000aa', from_node: node, from_agent: NOTICE_SENDER, body: '通知', ...base }]
      const core = new AsnCore({ transport: { list: async () => ({ members: [{ id: 'T', agents: [{ name: 'T-ASN', status: 'idle' }] }, { id: node, name: '', agents: [] }] }), inbox: async () => ({ messages: msgs }), ack: async () => ({}) }, store: memStore(), selfNode: 'T', windowName: 'T-ASN', isChatVisible: async () => false })
      await core.start()
      got['通知寄件者'] = core.logOf(NOTICE_ID)[0]?.dev
      await core.stop()
      for (const [where, v] of Object.entries(got)) assert.equal(v, want, `${node === PHONE ? '手機' : '電腦'}：${where}`)
    }
  } finally { setNodePlatforms({}) }
})

test('#1829 本機沒名字：設備樹的列、詳情標題、額度頁都寫辨認線索，「這台電腦」「這支手機」只當小標籤（#1803）', () => {
  setNodePlatforms({}, { node: SELF, phone: true })
  try {
    const want = `手機（${nodeTail(SELF)}）`
    const mine = [friendRow(SELF)]
    const tree = acctDeviceTree({ friends: mine, nodeOrder: [SELF], selfNode: SELF }).find(d => d.key === SELF)
    assert.equal(tree.label, want); assert.equal(tree.identity.title, want); assert.equal(tree.self, true)
    assert.equal(nodeLabelOf(mine)(SELF), want)
    const desk = buildDeviceTree({ friends: mine, nodeOrder: [SELF], selfNode: SELF }).find(d => d.key === SELF)
    assert.match(desk.label, /^(電腦|手機)（[0-9A-F]{4}）$/)
    assert.equal(desk.label, desk.identity.title, '電腦版的列和標題一樣')
  } finally { setNodePlatforms({}) }
})

test('#1829 沒有任何平台資料時，每個畫面退回同一個預設（電腦）', () => {
  setNodePlatforms({})
  const want = `電腦（${nodeTail(PHONE)}）`
  assert.equal(buildDeviceTree({ friends: [friendRow(PHONE)], nodeOrder: [PHONE], selfNode: SELF }).find(d => d.key === PHONE).label, want)
  assert.equal(deviceTabs([friendRow(PHONE)], { selfNode: SELF, nodeOrder: [PHONE] }).all.find(t => t.key === PHONE).label, want)
  assert.equal(nodeLabelOf([friendRow(PHONE)])(PHONE), want)
})

test('#1829 舊存檔的通知：設備名是舊字串「未命名設備」的不顯示（存檔裡沒有節點代號，換不出線索）；有名字、有線索的照常', () => {
  const log = [
    { k: 'them', text: '舊的', t: 1, id: 'a', dev: '未命名設備' },
    { k: 'them', text: '有名字', t: 2, id: 'b', dev: '家用機' },
    { k: 'them', text: '新的', t: 3, id: 'c', dev: '電腦（A9F8）' },
  ]
  const rows = noticeRows(log)
  assert.equal(rows.length, 3)
  assert.ok(!JSON.stringify(rows).includes('未命名設備'), '舊字串不出現在通知清單')
  assert.ok(JSON.stringify(rows).includes('家用機') && JSON.stringify(rows).includes('電腦（A9F8）'))
})

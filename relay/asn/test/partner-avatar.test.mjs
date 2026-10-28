// 夥伴自己換的頭像（#446）：顯示優先序（自訂 > 自動產生，設備頭像不套在 AI 視窗上）與用戶端同步（名單帶更新時間才取圖、改名不斷、不再有圖就清掉、壞圖略過）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { AsnCore } from '../ui/lib/core.mjs'
import { autoAvatarDataUrl, avatarFor, avatarSrc, partnerAvatarKey } from '../ui/lib/avatar.mjs'
import { memStore } from './helpers.mjs'

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg=='
const PNG2 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAA'
const NODE_UP = 'data:image/webp;base64,UklGRiIAAABXRUJQVlA4IBYAAAAw'
const P1 = 'p_00000000000000000001'
const P2 = 'p_00000000000000000002'

test('顯示規則：AI 視窗有夥伴自訂頭像就用它；沒有就自動產生；設備頭像不會套在 AI 視窗上', () => {
  const f = { id: 'W/小文', node: 'W', onRoster: true, partnerId: P1 }
  assert.deepEqual(avatarFor(f, { avatars: { [partnerAvatarKey(P1)]: PNG } }), { kind: 'upload', src: PNG })
  assert.deepEqual(avatarFor(f, { avatars: {} }), { kind: 'auto', seed: 'W/小文' })
  assert.deepEqual(avatarFor(f, { avatars: { W: NODE_UP } }), { kind: 'auto', seed: 'W/小文' }, '設備頭像不套在 AI 視窗上')
  assert.deepEqual(avatarFor({ ...f, partnerId: P2 }, { avatars: { [partnerAvatarKey(P1)]: PNG } }), { kind: 'auto', seed: 'W/小文' }, '別位夥伴的圖不會錯套')
  assert.deepEqual(avatarFor({ ...f, partnerId: undefined }, { avatars: { [partnerAvatarKey(P1)]: PNG } }), { kind: 'auto', seed: 'W/小文' }, '沒有夥伴編號（舊視窗）照舊')
  assert.equal(avatarSrc({ ...f, partnerId: P2 }, { avatars: {} }), autoAvatarDataUrl('W/小文'))
  // 壞圖（外部資料）不採用
  assert.deepEqual(avatarFor(f, { avatars: { [partnerAvatarKey(P1)]: 'data:image/svg+xml;base64,PHN2Zz4=' } }), { kind: 'auto', seed: 'W/小文' })
  // 名單外的寄件人：照舊用設備頭像
  assert.deepEqual(avatarFor({ id: 'K/x', node: 'K', onRoster: false }, { avatars: { K: NODE_UP } }), { kind: 'upload', src: NODE_UP })
})

function setup(members, avatarsByPartner, { withPartnerApi = true } = {}) {
  const calls = []
  const transport = {
    list: async () => ({ members: members() }),
    inbox: async () => ({ messages: [] }),
    ack: async () => ({}),
    avatar: async node => { calls.push(`node:${node}`); return { avatar: NODE_UP } },
    ...(withPartnerApi ? { partnerAvatar: async pid => { calls.push(`partner:${pid}`); const a = avatarsByPartner[pid]; if (a === undefined) throw new Error('HTTP 404 not_found'); return { avatar: a } } } : {}),
  }
  const core = new AsnCore({ transport, store: memStore(), selfNode: 'T', windowName: 'T-ASN', pollMs: 60_000, rosterMs: 60_000 })
  return { core, calls }
}
const node = (agents, extra = {}) => ({ id: 'W', agents, offline_agents: [], ...extra })
const agent = (name, partner_id, avatar_updated_at) => ({ name, status: 'idle', cwd_label: 'x', partner_id, ...(avatar_updated_at ? { avatar_updated_at } : {}) })

test('同步：名單的夥伴帶 avatar_updated_at 才去取圖；時間沒變不重取；改名（同一位夥伴）不斷', async () => {
  let members = [node([agent('小文', P1, 't1'), agent('小武', P2)])]
  const { core, calls } = setup(() => members, { [P1]: PNG })
  await core.refreshRoster()
  assert.deepEqual(calls, [`partner:${P1}`], '沒有 avatar_updated_at 的夥伴不取')
  assert.equal(core.avatarMap()[partnerAvatarKey(P1)], PNG)
  await core.refreshRoster()
  assert.equal(calls.length, 1, '時間沒變不重取')
  members = [node([agent('新名字', P1, 't1'), agent('小武', P2)])]
  await core.refreshRoster()
  assert.equal(calls.length, 1, '改名後鍵是夥伴編號，不重取、圖還在')
  assert.equal(core.avatarMap()[partnerAvatarKey(P1)], PNG)
  members = [node([agent('新名字', P1, 't2'), agent('小武', P2)])]
  await core.refreshRoster()
  assert.equal(calls.length, 2, '更新時間變了才重取')
  await core.stop()
})

test('同步：離線夥伴也取；不再有圖（名單沒帶時間）就清掉；取圖失敗或圖壞了略過，不影響其他', async () => {
  let members = [node([], { offline_agents: [agent('離線的', P1, 't1')] }), { id: 'X', agents: [agent('壞圖', P2, 't1')], offline_agents: [] }]
  const { core, calls } = setup(() => members, { [P1]: PNG, [P2]: 'data:image/svg+xml;base64,PHN2Zz4=' })
  await core.refreshRoster()
  assert.deepEqual(Object.keys(core.avatarMap()), [partnerAvatarKey(P1)], '離線夥伴有取；壞圖略過')
  members = [node([], { offline_agents: [agent('離線的', P1)] })]
  await core.refreshRoster()
  assert.deepEqual(core.avatarMap(), {}, '不再有圖就清掉')
  assert.ok(calls.length >= 2)
  await core.stop()
})

test('同步：設備頭像與夥伴頭像共存，各取各的；夥伴編號格式不對的忽略', async () => {
  const members = [node([agent('小文', P1, 't1'), agent('怪', 'p_x', 't1'), agent('怪2', '../x', 't1')], { avatar_updated_at: 'n1' })]
  const { core, calls } = setup(() => members, { [P1]: PNG })
  await core.refreshRoster()
  assert.deepEqual(calls.sort(), ['node:W', `partner:${P1}`])
  assert.deepEqual(core.avatarMap(), { W: NODE_UP, [partnerAvatarKey(P1)]: PNG })
  await core.stop()
})

test('舊傳輸層沒有 partnerAvatar：夥伴這一層略過，設備頭像照常', async () => {
  const members = [node([agent('小文', P1, 't1')], { avatar_updated_at: 'n1' })]
  const { core, calls } = setup(() => members, {}, { withPartnerApi: false })
  await core.refreshRoster()
  assert.deepEqual(calls, ['node:W'])
  await core.stop()
})

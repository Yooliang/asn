// 群組各個對話框怎麼走（建立、邀請、加入、成員與設定）與群組對話的資料中樞（讀、發言、主持人同意／拒絕）。
// 全用假後台：確認呼叫的動作與內容、錯誤變中文、危險操作只經過 group_confirm_decide（本人簽章）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createGroupFlow } from '../ui/lib/group-flow.mjs'
import { createGroupApi } from '../ui/lib/groups.mjs'
import { createRoomHub } from '../ui/lib/room-hub.mjs'

const CODE = 'AbCdEf0123456789_-xyz'
const F = (node, agent, over = {}) => ({ id: `${node}/${agent}`, node, agent, nick: agent, status: 'online', device: '工作機', ...over })

function setup({ rooms = [], friends = [F('T', '財務'), F('T', '報表')], respond = {}, log = [] } = {}) {
  const calls = [], opened = [], copied = []
  let refreshed = 0
  const roomsRef = { v: rooms }
  const invoke = async (cmd, args) => {
    calls.push([cmd, args])
    if (cmd !== 'relay_group') throw new Error(`unexpected ${cmd}`)
    const r = respond[args.action]
    if (r instanceof Error) throw r
    return typeof r === 'function' ? r(args.body) : r ?? {}
  }
  const flow = createGroupFlow({
    api: createGroupApi(invoke), copy: async t => { copied.push(t) }, openRoom: id => opened.push(id),
    refreshRooms: async () => { refreshed++ }, getFriends: () => friends, getRoom: id => roomsRef.v.find(r => r.id === id), logOf: () => log,
  })
  return { flow, calls, opened, copied, roomsRef, refreshed: () => refreshed }
}

test('建立群組：勾選自己的夥伴、送出後重抓列表並直接開啟新群組', async () => {
  const t = setup({ respond: { group_create: { id: 'g9', name: '財務小組' } } })
  t.flow.openCreate()
  assert.equal(t.flow.state.view, 'create'); assert.deepEqual(t.flow.state.choices.map(c => c.label), ['財務', '報表'])
  t.flow.state.name = '  '; await t.flow.submitCreate()
  assert.match(t.flow.state.error, /名字/); assert.equal(t.calls.length, 0, '名稱不對不打後台')
  t.flow.state.name = '財務小組'; t.flow.togglePick('T~財務'); t.flow.togglePick('T~報表'); t.flow.togglePick('T~報表')
  await t.flow.submitCreate()
  assert.deepEqual(t.calls, [['relay_group', { action: 'group_create', body: { name: '財務小組', ai: ['T~財務'] } }]])
  assert.deepEqual(t.opened, ['g9']); assert.equal(t.refreshed(), 1); assert.equal(t.flow.state.view, '', '建好就關掉對話框')
})

test('建立群組失敗：顯示中文，對話框不關', async () => {
  const t = setup({ respond: { group_create: new Error('group_create HTTP 409 room_limit') } })
  t.flow.openCreate(); t.flow.state.name = 'x'
  await t.flow.submitCreate()
  assert.match(t.flow.state.error, /上限/); assert.equal(t.flow.state.view, 'create'); assert.equal(t.flow.state.busy, false)
})

test('邀請（一對一）：先預覽「對方會看到這些內容」並確認，才產生連結；可複製、可撤銷', async () => {
  const log = Array.from({ length: 60 }, (_, i) => ({ k: i % 2 ? 'them' : 'me', who: '財務', text: `第 ${i} 句`, t: i }))
  const t = setup({ log, respond: { group_invite_create: { id: 'inv1', kind: 'conversation', expires_at: '2026-10-24T10:00:00Z', code: CODE, link: `https://asnmessenger.web.app/i/${CODE}` }, group_invite_revoke: { ok: true } } })
  t.flow.openInvite({ type: 'friend', friend: F('T', '財務') })
  const s = t.flow.state
  assert.equal(s.step, 'confirm'); assert.equal(s.seed, 40); assert.equal(s.preview.length, 40); assert.match(s.lead, /40 則/); assert.equal(s.preview.at(-1).text, '第 59 句')
  assert.equal(t.calls.length, 0, '確認前沒有打後台')
  t.flow.setSeed(5); assert.equal(s.preview.length, 5); t.flow.setSeed(999); assert.equal(s.seed, 50); assert.equal(s.preview.length, 50); t.flow.setSeed(0); assert.equal(s.preview.length, 0); assert.match(s.lead, /不會複製/)
  t.flow.setSeed(10)
  await t.flow.confirmInvite()
  assert.deepEqual(t.calls[0], ['relay_group', { action: 'group_invite_create', body: { kind: 'conversation', node: 'T', agent: '財務', seed: 10 } }])
  assert.equal(s.step, 'link'); assert.equal(s.link.link, `https://asnmessenger.web.app/i/${CODE}`); assert.match(s.link.note, /一次性.*24 小時/)
  await t.flow.copyLink(); assert.deepEqual(t.copied, [s.link.link]); assert.equal(s.copied, true)
  await t.flow.revokeInvite()
  assert.deepEqual(t.calls.at(-1), ['relay_group', { action: 'group_invite_revoke', body: { id: 'inv1' } }]); assert.equal(s.step, 'revoked'); assert.equal(s.link, null)
})

test('邀請（群組）：只看得到加入後的新訊息，不複製紀錄', async () => {
  const t = setup({ respond: { group_invite_create: { id: 'inv2', code: CODE, expires_at: '2026-10-24T10:00:00Z' } } })
  t.flow.openInvite({ type: 'room', roomId: 'g1', name: '財務小組' })
  assert.match(t.flow.state.lead, /加入之後/); assert.equal(t.flow.state.preview.length, 0)
  await t.flow.confirmInvite()
  assert.deepEqual(t.calls[0][1], { action: 'group_invite_create', body: { kind: 'room', room: 'g1' } })
  assert.equal(t.flow.state.link.link, `https://asnmessenger.web.app/i/${CODE}`, '後台沒回連結就自己組')
})

test('邀請：複製失敗給提示；產生失敗顯示中文', async () => {
  const t = setup({ respond: { group_invite_create: new Error('group_invite_create HTTP 429 rate_limited') } })
  t.flow.openInvite({ type: 'room', roomId: 'g1' })
  await t.flow.confirmInvite(); assert.match(t.flow.state.error, /頻繁/); assert.equal(t.flow.state.step, 'confirm')
  const t2 = setup({ respond: { group_invite_create: { id: 'i', code: CODE } } })
  t2.flow.openInvite({ type: 'room', roomId: 'g1' }); await t2.flow.confirmInvite()
  const f2 = createGroupFlow({ api: createGroupApi(async () => ({ id: 'i', code: CODE })), copy: async () => { throw new Error('x') }, openRoom() {}, refreshRooms: async () => {}, getFriends: () => [], getRoom: () => null, logOf: () => [] })
  f2.openInvite({ type: 'room', roomId: 'g' }); await f2.confirmInvite(); await f2.copyLink()
  assert.match(f2.state.note, /複製失敗/); assert.equal(f2.state.copied, false)
})

test('加入群組：貼連結或碼 → 看預覽（群組名、邀請人）→ 加入後開啟該群組；壞碼不打後台', async () => {
  const t = setup({ respond: { group_invite_preview: { kind: 'room', inviter_name: '牧陽', room_name: '財務小組', expires_at: '2026-10-24T10:00:00Z' }, group_invite_accept: { room_id: 'g7', name: '財務小組', kind: 'room' } } })
  t.flow.openJoin(); assert.equal(t.flow.state.step, 'input')
  t.flow.state.input = '亂貼的東西'; await t.flow.lookup(); assert.match(t.flow.state.error, /邀請碼/); assert.equal(t.calls.length, 0)
  t.flow.state.input = `https://asnmessenger.web.app/i/${CODE}`; await t.flow.lookup()
  assert.equal(t.flow.state.step, 'preview'); assert.equal(t.flow.state.join.title, '財務小組'); assert.equal(t.flow.state.join.inviter, '牧陽')
  assert.deepEqual(t.calls[0][1], { action: 'group_invite_preview', body: { code: CODE } })
  await t.flow.acceptInvite()
  assert.deepEqual(t.calls[1][1], { action: 'group_invite_accept', body: { code: CODE } })
  assert.deepEqual(t.opened, ['g7']); assert.equal(t.flow.state.view, ''); assert.equal(t.refreshed(), 1)
})

test('點邀請連結開啟：帶碼進來直接查預覽；已用過／過期顯示中文', async () => {
  const t = setup({ respond: { group_invite_preview: new Error('group_invite_preview HTTP 410 invite_used') } })
  await t.flow.openJoin(CODE)
  assert.equal(t.flow.state.view, 'join'); assert.match(t.flow.state.error, /用過/); assert.equal(t.flow.state.step, 'input')
  const t2 = setup({ respond: { group_invite_preview: { kind: 'conversation', inviter_name: '牧陽', seed_count: 40 } } })
  await t2.flow.openJoin(`asn://invite/${CODE}`)
  assert.equal(t2.flow.state.step, 'preview'); assert.match(t2.flow.state.join.lead, /40 則/)
})

test('成員與設定：帶自己的 AI 進出、接受別人點名開關、退出（主持人要先轉讓會提示）', async () => {
  const room = { id: 'g1', name: '財務小組', is_host: true, external: true, members: [
    { key: '~u:me', label: '牧陽', member_kind: 'human', role: 'owner', mine: true }, { key: 'T~財務', label: '財務（牧陽）', member_kind: 'ai', mine: true },
    { key: 'x:r2', label: '報表（小良）', member_kind: 'ai', mine: false }] }
  const t = setup({ rooms: [room], respond: { group_leave: new Error('group_leave HTTP 409 host_must_transfer') } })
  t.flow.openManage('g1')
  const s = t.flow.state
  assert.equal(s.host, true); assert.equal(s.external, true); assert.deepEqual(s.members.map(m => m.label), ['牧陽', '財務（牧陽）', '報表（小良）']); assert.deepEqual(s.addable.map(a => a.label), ['報表'])
  await t.flow.addAi('T~報表'); assert.deepEqual(t.calls.at(-1)[1], { action: 'group_ai_add', body: { room: 'g1', keys: ['T~報表'] } })
  await t.flow.setAllow('T~財務', false)
  assert.deepEqual(t.calls.at(-1)[1], { action: 'group_allow_others', body: { room: 'g1', key: 'T~財務', allow: false } }); assert.equal(s.members.find(m => m.label === '財務（牧陽）').allowOthers, false)
  const n = t.calls.length
  await t.flow.removeAi('x:r2'); assert.equal(t.calls.length, n, '別人的 AI 不能移（不是我的成員，不打後台）')
  await t.flow.removeAi('T~財務'); assert.deepEqual(t.calls.at(-1)[1], { action: 'group_ai_remove', body: { room: 'g1', key: 'T~財務' } })
  t.flow.askLeave(); assert.equal(s.leaving, true)
  await t.flow.leave(); assert.match(s.error, /轉讓|離開或封存/); assert.equal(s.view, 'manage', '主持人退不出去，對話框不關')
})

test('成員與設定：一般成員退出後關閉對話框並重抓列表', async () => {
  const t = setup({ rooms: [{ id: 'g1', name: 'x', members: [] }] })
  t.flow.openManage('g1'); await t.flow.leave()
  assert.deepEqual(t.calls.at(-1)[1], { action: 'group_leave', body: { room: 'g1' } }); assert.equal(t.flow.state.view, ''); assert.equal(t.refreshed(), 1)
})

// ---------- 群組對話資料中樞 ----------
const ROOM = { id: 'g1', name: '財務小組', last_seq: 3, is_host: true, external: false, mine: [{ member: '~u:u1', unread: 2 }, { member: 'T~財務', unread: 0 }], members: [
  { key: '~u:u1', label: '牧陽', member_kind: 'human', mine: true, role: 'owner' }, { key: 'T~財務', label: '財務（牧陽）', member_kind: 'ai', mine: true }, { key: 'x:r1', label: '小良', member_kind: 'human' }] }
const MSGS = [
  { seq: 1, from: 'x:r1', relation: 'other', from_kind: 'human', from_label: '小良', body: '幫我查報表', at: '2026-10-23T10:00:00Z' },
  { seq: 2, from: 'T~財務', relation: 'mine_ai', from_kind: 'ai', from_label: '財務（牧陽）', body: '好', at: '2026-10-23T10:01:00Z' },
  { seq: 3, from: 'T~財務', relation: 'mine_ai', from_kind: 'ai', from_label: '財務（牧陽）', body: '【待主持人確認 #0b9c8f3a】…', at: '2026-10-23T10:02:00Z' },
]
const CID = '0b9c8f3a-1111-4222-8333-444455556666'
function hubSetup(over = {}) {
  const calls = []
  const invoke = async (cmd, args) => {
    calls.push([cmd, args])
    if (cmd === 'relay_rooms') return { rooms: [JSON.parse(JSON.stringify(ROOM))] }
    if (cmd === 'relay_room_read') return { messages: MSGS.filter(m => m.seq > args.since), last_seq: 3 }
    if (cmd === 'relay_room_post') return { seq: 4 }
    if (cmd === 'relay_group') {
      if (args.action === 'group_confirm_list') return { confirms: [{ id: CID, short: '0b9c8f3a', kind: 'spend', kind_label: '花錢或付款', summary: '付款 3 萬', status: 'pending', requester_name: '財務', requester_owner: '牧陽', is_host: true, created_at: '2026-10-23T10:02:00Z' }] }
      if (args.action === 'group_confirm_decide') { if (over.decideError) throw new Error(over.decideError); return { id: CID, status: args.body.approve ? 'approved' : 'denied' } }
    }
    return {}
  }
  const hub = createRoomHub({ invoke, groupApi: createGroupApi(invoke), selfNode: 'T', windowName: '我的電腦' })
  return { hub, calls }
}

test('群組對話：用本人的真人身分簽章讀取（不帶視窗名），訊息帶發言者標示與徽章', async () => {
  const { hub, calls } = hubSetup()
  await hub.open('g1')
  const read = calls.find(([c]) => c === 'relay_room_read')[1]
  assert.equal(read.room, 'g1'); assert.equal(read.agent, null, '真人身分不帶視窗名'); assert.equal(read.since, 0)
  const log = hub.st.logs.g1
  assert.deepEqual(log.map(e => [e.k, e.who ?? '', e.badge ?? '']), [['them', '小良', '真人'], ['them', '財務（牧陽）', 'AI'], ['them', '財務（牧陽）', 'AI']])
  assert.equal(hub.st.cards.g1.length, 1); assert.equal(hub.st.cards.g1[0].canDecide, true); assert.equal(hub.st.cards.g1[0].requester, '財務（牧陽）')
  assert.equal(hub.rowOf('g1').unread, 0, '讀過就把自己的未讀清掉')
})

test('群組發言：走 relay_room_post，內容只有群組、內文（真人身分不帶 from_agent）；空內容不送', async () => {
  const { hub, calls } = hubSetup()
  await hub.refresh()
  assert.equal(await hub.post('g1', '   '), false); assert.match(hub.st.note, /輸入內容/)
  assert.equal(await hub.post('g1', '收到，請繼續'), true)
  assert.deepEqual(calls.find(([c]) => c === 'relay_room_post')[1], { body: { room: 'g1', body: '收到，請繼續' } })
})

test('主持人按同意／拒絕：只經過 group_confirm_decide（本人簽章），按完重抓卡片；失敗顯示中文', async () => {
  const { hub, calls } = hubSetup()
  await hub.open('g1')
  assert.equal(await hub.decide('g1', CID, true), true)
  assert.deepEqual(calls.filter(([c, a]) => c === 'relay_group' && a.action === 'group_confirm_decide').map(([, a]) => a.body), [{ room: 'g1', id: CID, approve: true }])
  await hub.decide('g1', CID, false)
  assert.equal(calls.filter(([, a]) => a?.action === 'group_confirm_decide').at(-1)[1].body.approve, false)
  const bad = hubSetup({ decideError: 'group_confirm_decide HTTP 403 forbidden' })
  await bad.hub.open('g1')
  assert.equal(await bad.hub.decide('g1', CID, true), false); assert.match(bad.hub.st.note, /本人/)
  assert.doesNotMatch(bad.hub.st.note, /HTTP|forbidden|group_/)
})

test('群組列表壞了不炸：連不上就標記失敗，列表維持原樣', async () => {
  const hub = createRoomHub({ invoke: async () => { throw new Error('relay_rooms 連線失敗') }, groupApi: createGroupApi(async () => ({})), selfNode: 'T', windowName: 'w' })
  await hub.refresh(); assert.equal(hub.st.err, true); assert.deepEqual(hub.rows(), [])
})
test('群組傳附件：走 relay_send_attachment 帶 room（編號由 Rust 填，前端不帶）；沒有內容不送', async () => {
  const { hub, calls } = hubSetup()
  const sent = []
  const invoke = async (cmd, args) => { if (cmd === 'relay_send_attachment') { sent.push(args); return { seq: 4 } } return {} }
  await hub.refresh()
  assert.equal(await hub.postAttachment('g1', null, ''), false)
  assert.equal(sent.length, 0)
  assert.ok(calls.length > 0)
  // 直接用帶假 invoke 的中樞驗送出內容
  const h2 = createRoomHub({ invoke: async (c, a) => (c === 'relay_rooms' ? { rooms: [JSON.parse(JSON.stringify(ROOM))] } : c === 'relay_send_attachment' ? (sent.push(a), { seq: 4 }) : c === 'relay_room_read' ? { messages: [], last_seq: 3 } : {}), groupApi: createGroupApi(async () => ({})), selfNode: 'T', windowName: '我的電腦' })
  await h2.refresh()
  assert.equal(await h2.postAttachment('g1', { kind: 'file', name: 'a.pdf', data: 'QUJD', width: undefined, thumb: '' }, ' 看一下 '), true)
  const p = sent.at(-1).payload
  assert.equal(p.room, 'g1'); assert.equal(p.kind, 'file'); assert.equal(p.caption, '看一下'); assert.equal(p.name, 'a.pdf')
  assert.ok(!('attachment_ids' in p) && !('from_agent' in p), '真人身分不帶視窗名，也不帶自填編號')
})

test('加我的另一個 AI：⋯ 選單（電腦版與手機版）有入口，開成員與設定並聚焦「加」區塊', async () => {
  const room = { id: 'g1', name: '財務小組', is_host: true, members: [{ key: '~u:me', label: '牧陽', member_kind: 'human', role: 'owner', mine: true }] }
  const t = setup({ rooms: [room] })
  t.flow.openManage('g1', { focusAdd: true })
  assert.equal(t.flow.state.view, 'manage'); assert.equal(t.flow.state.focusAdd, true)
  assert.deepEqual(t.flow.state.addable.map(a => a.label).sort(), ['報表', '財務'])
  t.flow.openManage('g1'); assert.equal(t.flow.state.focusAdd, false)
})

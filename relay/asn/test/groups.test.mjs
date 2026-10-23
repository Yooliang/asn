// 真人好友與群組 1b 的純邏輯：邀請碼與連結、錯誤文字、可帶進群組的夥伴、邀請預覽、發言者標示、附件鈕、主持人確認卡片、成員清單、後台呼叫包裝。
// 守門：簽章動作都走 relay_group（Rust 端帶本人簽章）、外部成員的群組不能傳附件、畫面上不出現節點代號與 x: 代號。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { INVITE_NOTE, SEED_DEFAULT, SEED_MAX, addableAi, aiChoices, buildCreate, canInviteFrom, clampSeed, confirmCards, createError, createGroupApi, groupErrorText, inviteAsnLink, inviteBody, inviteLead, inviteLink, inviteView, memberRows, parseInviteInput, pendingCount, previewView, roomAttachAllowed, safeLabel, seedPreview, speakerLabels, windowKeyOf } from '../ui/lib/groups.mjs'
import { roomLog } from '../ui/lib/mobile-rooms.mjs'

const CODE = 'AbCdEf0123456789_-xyz'
const NODE_RE = /(^|[\s（(])x:[0-9a-f-]{6,}|\b[\w-]+~[\w-]+/i   // x: 代號，或「節點~視窗」格式

test('邀請碼：貼碼、https 連結、asn:// 連結都認得，其他不收', () => {
  assert.equal(parseInviteInput(CODE), CODE)
  assert.equal(parseInviteInput(`  ${inviteLink(CODE)}  `), CODE)
  assert.equal(parseInviteInput(inviteAsnLink(CODE)), CODE)
  assert.equal(parseInviteInput(`HTTPS://asnmessenger.web.app/i/${CODE}?from=line#x`), CODE)
  for (const bad of ['', '短', 'https://evil.example/i/' + CODE, 'asn://invite/' + CODE + '%20x', `${CODE}/../..`, null, undefined, 'a'.repeat(65)]) assert.equal(parseInviteInput(bad), '', String(bad))
  assert.equal(inviteLink(CODE), `https://asnmessenger.web.app/i/${CODE}`)
  assert.equal(inviteAsnLink(CODE), `asn://invite/${CODE}`)
})

test('錯誤文字：後台代碼、Rust 訊息都變中文，不外洩代碼', () => {
  const cases = [
    ['group_invite_accept HTTP 410 invite_used', /用過/], ['group_invite_accept HTTP 410 invite_expired', /過期/], ['group_invite_accept HTTP 410 invite_revoked', /撤銷/],
    ['group_invite_accept HTTP 409 already_member', /已經在/], ['group_invite_accept HTTP 409 own_invite', /自己發出/], ['group_invite_preview HTTP 404 invalid_invite', /不正確/],
    ['group_leave HTTP 409 host_must_transfer', /主持人/], ['group_create HTTP 409 room_limit', /上限/], ['group_confirm_decide HTTP 403 forbidden', /本人/],
    ['group_confirm_decide HTTP 409 already_decided', /處理過/], ['尚未登入，無法使用群組', /登入/], ['group_create 連線失敗：x', /網路/], ['group_create HTTP 429', /頻繁/],
    ['group_create HTTP 401', /登入/], ['群組名稱要 1 到 60 字', /群組名稱/], ['奇怪的錯誤 HTTP 500 boom', /失敗/], ['room_post HTTP 403 external_no_attachments', /外部成員/],
  ]
  for (const [raw, want] of cases) {
    const t = groupErrorText(raw)
    assert.match(t, want, raw)
    assert.doesNotMatch(t, /HTTP|group_|invite_|_/, raw)
  }
})

const F = (node, agent, over = {}) => ({ id: `${node}/${agent}`, node, agent, nick: agent, status: 'online', device: '工作機', ...over })

test('可帶進群組的夥伴：只列有節點與視窗名的 AI；ASN 程式本身、收發室、啟動中、群組都不列；上線的在前', () => {
  const list = aiChoices([F('T', '報表', { status: 'offline' }), F('T', '財務'), F('T', '收發室'), F('T', 'ASN', { engine: 'asn' }), { id: 'pending:x', node: 'T', agent: 'x', pending: true }, { id: 'room:r', room: true, nick: '群' }, F('T', 'a~b'), null])
  assert.deepEqual(list.map(c => c.label), ['財務', '報表'])
  assert.equal(list[0].key, 'T~財務')
  assert.equal(windowKeyOf(F('T', 'x')), 'T~x'); assert.equal(windowKeyOf({ node: 'T' }), ''); assert.equal(windowKeyOf(F('T~', 'x')), '')
  assert.ok(canInviteFrom(F('T', '財務')) && !canInviteFrom({ room: true, node: 'T', agent: 'x' }) && !canInviteFrom(F('T', 'ASN', { engine: 'asn' })) && !canInviteFrom(null))
})

test('建立群組：名稱必填、不能太長、最多帶 20 位；內容整理成後台要的樣子', () => {
  assert.match(createError('  ', []), /名字/)
  assert.match(createError('字'.repeat(61), []), /太長/)
  assert.match(createError('財務', Array.from({ length: 21 }, (_, i) => `T~${i}`)), /20/)
  assert.equal(createError('財務小組', ['T~財務']), '')
  assert.deepEqual(buildCreate(' 財務小組 ', ['T~財務', 'T~財務', 'T~報表']), { name: '財務小組', ai: ['T~財務', 'T~報表'] })
  assert.deepEqual(buildCreate('空群', undefined), { name: '空群', ai: [] })
})

test('邀請：複製的則數夾在 0～50；預覽取最近 N 則、系統提示不算；說明文字依一對一／群組不同', () => {
  assert.equal(clampSeed(-5), 0); assert.equal(clampSeed(999), SEED_MAX); assert.equal(clampSeed('12'), 12); assert.equal(clampSeed('x'), SEED_DEFAULT); assert.equal(clampSeed(7.9), 7)
  const log = [{ k: 'me', text: '你好', t: 1 }, { k: 'sys', text: '震動' }, { k: 'them', who: '財務', text: '請說', t: 2 }, { k: 'me', text: '   ', t: 3 }, { k: 'me', text: '查一下\n本月  帳', t: 4 }]
  assert.deepEqual(seedPreview(log, '財務', 2).map(r => [r.who, r.text]), [['財務', '請說'], ['我', '查一下 本月 帳']])
  assert.equal(seedPreview(log, '財務', 0).length, 0)
  assert.equal(seedPreview(log, '財務', 40).length, 3)
  assert.equal(seedPreview(null, '財務', 40).length, 0)
  assert.match(inviteLead({ type: 'friend' }, 40), /最近 40 則/)
  assert.match(inviteLead({ type: 'friend' }, 0), /不會複製/)
  assert.match(inviteLead({ type: 'room' }, 40), /加入之後/)
  const f = F('T', '財務')
  assert.deepEqual(inviteBody({ type: 'friend', friend: f }, 99), { kind: 'conversation', node: 'T', agent: '財務', seed: 50 })
  assert.deepEqual(inviteBody({ type: 'room', roomId: 'g1' }, 5), { kind: 'room', room: 'g1' })
})

test('邀請結果與預覽：連結有備註「一次性、24 小時內有效」；預覽只有群組名與邀請人', () => {
  const v = inviteView({ id: 'i1', code: CODE, link: inviteLink(CODE), expires_at: '2026-10-24T10:00:00Z' })
  assert.equal(v.link, inviteLink(CODE)); assert.equal(v.note, INVITE_NOTE); assert.match(v.note, /一次性.*24 小時/); assert.ok(v.expiresAt > 0)
  assert.equal(inviteView({ code: CODE }).link, inviteLink(CODE), '後台沒給連結就自己組')
  const p = previewView({ kind: 'room', inviter_name: '牧陽', room_name: '財務小組', expires_at: '2026-10-24T10:00:00Z' })
  assert.equal(p.title, '財務小組'); assert.equal(p.inviter, '牧陽'); assert.match(p.lead, /牧陽.*財務小組/)
  const c = previewView({ kind: 'conversation', inviter_name: '牧陽', seed_count: 40 })
  assert.match(c.lead, /40 則/); assert.equal(previewView({ kind: 'conversation', seed_count: 0 }).seed, 0)
  assert.doesNotMatch(JSON.stringify([v, p, c]), NODE_RE)
})

test('發言者標示：同名的不同發言者第二位起加「（2）」；不同人的同名 AI 因帶主人名而分得開', () => {
  const members = [
    { key: '~u:me', label: '牧陽' }, { key: 'x:aaa11111', label: 'H-主線（小良）' }, { key: 'T~H-主線', label: 'H-主線（牧陽）' }, { key: 'x:bbb22222', label: '牧陽' },
  ]
  const labels = speakerLabels([{ seq: 1, from: 'x:ccc33333', from_label: '財務（小良）', from_kind: 'ai' }, { seq: 2, from: 'x:ddd44444', from_label: '財務（小良）', from_kind: 'ai' }, { seq: 3, from: '', from_kind: 'system' }], members)
  assert.equal(labels.get('x:aaa11111'), 'H-主線（小良）'); assert.equal(labels.get('T~H-主線'), 'H-主線（牧陽）')
  assert.equal(labels.get('~u:me'), '牧陽'); assert.equal(labels.get('x:bbb22222'), '牧陽（2）', '兩位帳號名相同的真人')
  assert.equal(labels.get('x:ccc33333'), '財務（小良）'); assert.equal(labels.get('x:ddd44444'), '財務（小良）（2）')
})

test('訊息轉對話記錄：真人與 AI 用不同徽章；我的 AI 也有發言者行；系統訊息置中；不出現節點代號與 x: 代號', () => {
  const members = [{ key: '~u:me', label: '牧陽', member_kind: 'human', mine: true }, { key: 'T~財務', label: '財務（牧陽）', member_kind: 'ai', mine: true }, { key: 'x:r1', label: '小良', member_kind: 'human' }, { key: 'x:r2', label: '報表（小良）', member_kind: 'ai' }]
  const log = roomLog([
    { seq: 1, from: '~u:me', relation: 'mine', from_kind: 'human', from_label: '牧陽', body: '嗨', at: '2026-10-23T10:00:00Z' },
    { seq: 2, from: 'T~財務', relation: 'mine_ai', from_kind: 'ai', from_label: '財務（牧陽）', body: '收到', at: '2026-10-23T10:01:00Z' },
    { seq: 3, from: 'x:r1', relation: 'other', from_kind: 'human', from_label: '小良', body: '請查', at: '2026-10-23T10:02:00Z' },
    { seq: 4, from: 'x:r2', relation: 'other', from_kind: 'ai', from_label: '報表（小良）', body: '好', at: '2026-10-23T10:03:00Z', mentions: ['x:r1'] },
    { seq: 5, from: '~u:me', relation: 'system', from_kind: 'system', body: '小良 加入了群組。', at: '2026-10-23T10:04:00Z' },
  ], ['~u:me', 'T~財務'], members)
  assert.deepEqual(log.map(e => [e.k, e.who ?? '', e.badge ?? '']), [['me', '', ''], ['them', '財務（牧陽）', 'AI'], ['them', '小良', '真人'], ['them', '報表（小良）', 'AI'], ['sys', '', '']])
  assert.deepEqual(log.map(e => e.kind ?? ''), ['human', 'ai', 'human', 'ai', ''])
  for (const e of log) assert.doesNotMatch(`${e.who ?? ''}${e.text}`, NODE_RE)
  // 後台沒給標示的舊訊息：用視窗名或「成員」，不露出節點代號
  const old = roomLog([{ seq: 1, from: 'T~舊視窗', body: 'x' }, { seq: 2, from: 'x:zzz999999', body: 'y' }], [], [])
  assert.deepEqual(old.map(e => e.who), ['舊視窗', '成員'])
  assert.equal(safeLabel('財務 x:0b9c8f3a-1111 T~財務'), '財務  財務')
})

test('附件：有外部成員的群組一律不能傳；一對一不受影響', () => {
  assert.equal(roomAttachAllowed({ room: true, external: true, attachments: true }), false)
  assert.equal(roomAttachAllowed({ room: true, external: false, attachments: true }), true)
  assert.equal(roomAttachAllowed({ room: true, external: false }), true, '只有本人與自己的 AI 的群組能傳附件')
  assert.equal(roomAttachAllowed({ room: true, attachments: false }), true, '舊的 attachments 旗標不再擋')
  assert.equal(roomAttachAllowed({ room: true }), true)
  assert.equal(roomAttachAllowed({ node: 'T', agent: 'a' }), true); assert.equal(roomAttachAllowed(null), true)
})

test('主持人確認卡片：主持人才有同意／拒絕；非主持人只看狀態；待處理在前、已處理只留 3 則', () => {
  const c = (id, status, over = {}) => ({ id, short: id.slice(0, 8), kind: 'spend', kind_label: '花錢或付款', summary: `付款 ${id}`, status, requester_name: '財務', requester_owner: '牧陽', is_host: true, created_at: `2026-10-23T10:0${id.slice(-1)}:00Z`, ...over })
  const list = [c('aaaaaaa1', 'approved'), c('aaaaaaa2', 'pending'), c('aaaaaaa3', 'denied'), c('aaaaaaa4', 'expired'), c('aaaaaaa5', 'pending'), c('aaaaaaa6', 'approved'), { bad: true }, null]
  const cards = confirmCards(list)
  assert.deepEqual(cards.map(x => x.id), ['aaaaaaa5', 'aaaaaaa2', 'aaaaaaa6', 'aaaaaaa4', 'aaaaaaa3'])
  assert.ok(cards[0].canDecide && cards[1].canDecide && !cards[2].canDecide, '已處理的不能再按')
  assert.equal(cards[0].requester, '財務（牧陽）'); assert.equal(cards[0].kindLabel, '花錢或付款'); assert.equal(cards[0].statusText, '等待主持人確認')
  const guest = confirmCards([c('bbbbbbb1', 'pending', { is_host: false })])
  assert.equal(guest[0].canDecide, false); assert.equal(guest[0].statusText, '等待主持人確認')
  assert.equal(pendingCount(list), 2)
  assert.deepEqual(confirmCards(null), [])
})

test('成員清單：真人在前；自己的 AI 可進出；只顯示標示，不顯示鍵；已在群裡的夥伴不再列為可帶進來', () => {
  const members = [
    { key: 'x:r2', label: '報表（小良）', member_kind: 'ai', mine: false }, { key: '~u:me', label: '牧陽', member_kind: 'human', role: 'owner', mine: true },
    { key: 'T~財務', label: '財務（牧陽）', member_kind: 'ai', mine: true, allow_others: false }, { key: 'x:r1', label: '小良', member_kind: 'human', mine: false },
  ]
  const rows = memberRows(members)
  assert.deepEqual(rows.map(r => [r.kind, r.label]), [['human', '牧陽'], ['human', '小良'], ['ai', '報表（小良）'], ['ai', '財務（牧陽）']])
  assert.ok(rows[0].host && rows[0].mine && !rows[1].host)
  assert.equal(rows.find(r => r.label === '財務（牧陽）').allowOthers, false); assert.equal(rows[2].allowOthers, true, '後台沒回報就當作開著')
  assert.deepEqual(addableAi([F('T', '財務'), F('T', '報表')], members).map(a => a.label), ['報表'])
  for (const r of rows) assert.doesNotMatch(`${r.label}`, NODE_RE)
  // 兩位帳號名相同的真人：成員清單也分得開
  assert.deepEqual(memberRows([{ key: 'x:a', label: '牧陽', member_kind: 'human' }, { key: 'x:b', label: '牧陽', member_kind: 'human' }]).map(r => r.label), ['牧陽', '牧陽（2）'])
})

test('後台呼叫包裝：全部走 relay_group（Rust 端帶本人簽章），動作名與欄位正確', async () => {
  const calls = []
  const api = createGroupApi(async (cmd, args) => { calls.push([cmd, args]); return {} })
  await api.create({ name: 'a', ai: [] }); await api.inviteCreate({ kind: 'room', room: 'g' }); await api.inviteRevoke('id1'); await api.invitePreview(CODE); await api.inviteAccept(CODE)
  await api.leave('g'); await api.aiAdd('g', ['T~a']); await api.aiRemove('g', 'T~a'); await api.allowOthers('g', 'T~a', false); await api.confirmDecide('g', 'cid', true); await api.confirmList('g')
  assert.ok(calls.every(([cmd]) => cmd === 'relay_group'))
  assert.deepEqual(calls.map(([, a]) => a.action), ['group_create', 'group_invite_create', 'group_invite_revoke', 'group_invite_preview', 'group_invite_accept', 'group_leave', 'group_ai_add', 'group_ai_remove', 'group_allow_others', 'group_confirm_decide', 'group_confirm_list'])
  assert.deepEqual(calls.at(-2)[1].body, { room: 'g', id: 'cid', approve: true })
  assert.deepEqual(calls.at(-3)[1].body, { room: 'g', key: 'T~a', allow: false })
})
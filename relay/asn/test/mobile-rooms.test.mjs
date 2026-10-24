// 手機版群組對話的純邏輯：名單列、未讀併入總未讀、用哪個成員身分發言、訊息轉對話記錄、讀取區間、發言前檢查、錯誤文字。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ROOM_FIRST_LOAD, ROOM_KEEP, ROOM_BODY_MAX, isRoomChat, memberIdentity, mergeRoomLog, needsRead, postError, readSince, roomChatId, roomErrorText, roomIdOf, roomItems, roomLog, roomPseudoFriend, roomUnread, totalUnreadWithRooms } from '../ui/lib/mobile-rooms.mjs'

const R = (id, name, over = {}) => ({ id, name, last_seq: 10, last_at: '2026-10-20T10:00:00Z', last_body: '大家好\n再說一次', last_from_name: '小文', mine: [{ member: '~u:P', unread: 2 }], members: [{}, {}, {}], ...over })

test('對話代號：room: 前綴來回；一般夥伴 id 不是群組', () => {
  assert.equal(roomChatId('abc'), 'room:abc')
  assert.equal(roomIdOf('room:abc'), 'abc')
  assert.ok(isRoomChat('room:abc') && !isRoomChat('room:') && !isRoomChat('H/小文') && !isRoomChat('') && !isRoomChat(null))
  assert.equal(roomIdOf('H/小文'), '')
})

test('群組列：最近有動靜的在前、人數、最後一句壓成一行、未讀加總、搜尋比對群組名', () => {
  const rows = roomItems([R('a', '舊群', { last_at: '2026-10-01T00:00:00Z' }), R('b', '新群'), null, { name: '沒有代號' }])
  assert.deepEqual(rows.map(r => r.id), ['b', 'a'])
  assert.equal(rows[0].count, 3); assert.equal(rows[0].unread, 2); assert.equal(rows[0].chatId, 'room:b')
  assert.equal(rows[0].last, '小文：大家好 再說一次')
  assert.deepEqual(roomItems([R('a', '英雄傳說'), R('b', '正見')], { query: ' 正 ' }).map(r => r.id), ['b'])
  assert.equal(roomItems([R('a', '')])[0].name, '未命名的群組')
  assert.deepEqual(roomItems(null), [])
  // 只算真人身分（成員鍵 ~ 開頭）的未讀；我名下 AI 視窗各自的未讀不算進徽章（它們要等橋去讀才清，會讓數字卡住）
  assert.equal(roomUnread(R('x', 'x', { mine: [{ member: '~u:a', unread: 1 }, { member: '~owner', unread: 4 }, { member: '~u:b', unread: -3 }, { member: 'H~asn-2', unread: 9 }, { unread: 7 }, {}] })), 5)
})

test('總未讀：夥伴的加上群組的', () => {
  assert.equal(totalUnreadWithRooms(3, [R('a', 'a'), R('b', 'b', { mine: [{ member: '~u:P', unread: 5 }] })]), 10)
  assert.equal(totalUnreadWithRooms(0, []), 0)
  assert.equal(totalUnreadWithRooms(undefined, null), 0)
})

test('用哪個身分發言：這支手機的視窗優先，其次節點本身，其次節點底下任一個；別人的成員不算', () => {
  const room = ks => ({ mine: ks.map(member => ({ member })) })
  assert.deepEqual(memberIdentity(room(['P', 'P~我的手機-ASN']), 'P', '我的手機-ASN'), { key: 'P~我的手機-ASN', agent: '我的手機-ASN' })
  assert.deepEqual(memberIdentity(room(['P~別的', 'P']), 'P', '我的手機-ASN'), { key: 'P', agent: '' })
  assert.deepEqual(memberIdentity(room(['P~別的']), 'P', '我的手機-ASN'), { key: 'P~別的', agent: '別的' })
  assert.deepEqual(memberIdentity(room(['PX~a', 'Q']), 'P', 'w'), { key: '', agent: '' }, '前綴相同但不是同一個節點')
  assert.deepEqual(memberIdentity({}, 'P', 'w'), { key: '', agent: '' })
})

test('對話分頁的假夥伴：標示是群組、不是夥伴視窗，沒有節點與設備', () => {
  const f = roomPseudoFriend(roomItems([R('a', '英雄傳說')])[0])
  assert.equal(f.id, 'room:a'); assert.equal(f.nick, '英雄傳說'); assert.equal(f.psm, '3 位成員')
  assert.ok(f.room === true && f.node === '' && f.device === '')
})

test('訊息轉對話記錄：自己的成員身分算我（不顯示名字）、別人帶發言者名字、附件註明、壞資料略過', () => {
  const log = roomLog([
    { seq: 1, from: 'H~小文', from_name: '小文', body: '嗨', at: '2026-10-20T10:00:00Z' },
    { seq: 2, from: 'P~我的手機-ASN', from_name: '我的手機', body: '收到', at: '2026-10-20T10:01:00Z' },
    { seq: 3, from: '~owner', body: '看圖', at: '2026-10-20T10:02:00Z', attachments: [{ name: 'a.png' }, {}] },
    { seq: 'x', body: '壞的' }, null,
  ], ['P~我的手機-ASN', 'P'])
  assert.deepEqual(log.map(e => [e.seq, e.k, e.who]), [[1, 'them', '小文'], [2, 'me', ''], [3, 'them', '成員']])
  assert.equal(log[2].text, '看圖\n（附件：a.png，請用電腦版查看）')
  assert.equal(log[0].t, Date.parse('2026-10-20T10:00:00Z')); assert.equal(log[0].id, 'room-1')
  assert.deepEqual(roomLog(null, []), [])
})

test('合併記錄：依序號去重排序，最多留 ROOM_KEEP 則', () => {
  const e = s => ({ seq: s, k: 'them', text: String(s) })
  assert.deepEqual(mergeRoomLog([e(1), e(3)], [e(2), e(3)]).map(x => x.seq), [1, 2, 3])
  const many = Array.from({ length: ROOM_KEEP + 20 }, (_, i) => e(i + 1))
  const m = mergeRoomLog([], many)
  assert.equal(m.length, ROOM_KEEP); assert.equal(m.at(-1).seq, ROOM_KEEP + 20)
})

test('從哪一則之後讀：沒記錄只讀最近 ROOM_FIRST_LOAD 則；有記錄接著讀；後台比畫面新才需要讀', () => {
  assert.equal(readSince([], 100), 100 - ROOM_FIRST_LOAD)
  assert.equal(readSince([], 3), 0)
  assert.equal(readSince([{ seq: 90 }, { seq: 95 }], 100), 95)
  assert.equal(readSince(undefined, undefined), 0)
  assert.ok(needsRead([{ seq: 95 }], 96) && !needsRead([{ seq: 95 }], 95) && needsRead([], 1) && !needsRead([], 0))
})

test('發言前檢查：沒內容、太長、沒登入、不是成員都不送；通過回空字串', () => {
  const ok = { signedIn: true, identity: { key: 'P', agent: '' } }
  assert.equal(postError('嗨', ok), '')
  assert.match(postError('   ', ok), /輸入內容/)
  assert.match(postError('字'.repeat(ROOM_BODY_MAX + 1), ok), /太長/)
  assert.match(postError('嗨', { ...ok, signedIn: false }), /登入/)
  assert.match(postError('嗨', { ...ok, identity: { key: '', agent: '' } }), /不在這個群組/)
})

test('錯誤文字：全是中文，不外洩代碼', () => {
  for (const [raw, want] of [['尚未登入，無法在群組發言', /登入/], ['room_post HTTP 429 rate_limited', /頻繁/], ['room_post HTTP 403 not_member', /不在這個群組/], ['room_read HTTP 404', /找不到/], ['room_post 連線失敗：x', /網路/], ['奇怪的錯', /暫時無法/]]) {
    const t = roomErrorText(raw)
    assert.match(t, want, raw)
    assert.doesNotMatch(t, /HTTP|room_|not_member|rate_limited/)
  }
})

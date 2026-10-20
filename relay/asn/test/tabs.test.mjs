// 頁籤、通知紀錄、群組列、廣告輪播的純邏輯。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ADS, DEVICE_TAB_MAX, addNotice, adUrls, deviceItems, deviceTabs, fmtTime, groupHeading, groupRows, moreUnread, nextAd, shortOf, statusNote, NOTICE_MAX } from '../ui/lib/tabs.mjs'

const F = (node, device, nick, status = 'online', unread = 0) => ({ id: `${node}/${nick}`, node, device, nick, status, unread })

test('statusNote：線上不加，其餘灰字', () => {
  assert.equal(statusNote('online'), '')
  assert.equal(statusNote('busy'), '(忙碌)')
  assert.equal(statusNote('offline'), '(離線)')
  assert.equal(statusNote('away'), '(馬上回來)')
})

test('groupHeading：設備名 (線上數/總數)', () => {
  assert.equal(groupHeading({ label: '家用機', items: [{ status: 'online' }, { status: 'busy' }, { status: 'offline' }] }), '家用機 (2/3)')
  assert.equal(groupHeading({ label: 'x', items: [] }), 'x (0/0)')
})

test('deviceTabs：本機第一、其餘照名單順序、名單消失但有紀錄的排最後', () => {
  const friends = [F('W', '工作機', 'a'), F('H', '家用機', 'b'), F('A', '牧陽', 'c'), F('OLD', '舊機', 'd', 'offline')]
  const t = deviceTabs(friends, { selfNode: 'H', nodeOrder: ['W', 'H', 'A'] })
  assert.deepEqual(t.all.map(x => x.key), ['H', 'W', 'A', 'OLD'])
  assert.deepEqual(t.visible, t.all)
  assert.deepEqual(t.more, [])
  assert.deepEqual(t.all.map(x => x.short), ['家', '工', '牧', '舊'])
  assert.equal(t.all[3].online, 0)
})

test('deviceTabs：本機沒有任何好友也有頁籤；標題先用節點名', () => {
  const t = deviceTabs([], { selfNode: 'H', nodeOrder: [] })
  assert.deepEqual(t.all.map(x => [x.key, x.label, x.total]), [['H', 'H', 0]])
})

test('deviceTabs：超過 6 個時第 6 個起收進「更多」，本機不會被收進去', () => {
  assert.equal(DEVICE_TAB_MAX, 6)
  const nodes = ['n1', 'n2', 'n3', 'n4', 'n5', 'n6', 'n7', 'n8']
  const friends = nodes.map(n => F(n, `設備${n}`, `x-${n}`))
  // 本機在名單最後也要排第一
  const t = deviceTabs(friends, { selfNode: 'n8', nodeOrder: nodes })
  assert.equal(t.all.length, 8)
  assert.deepEqual(t.visible.map(x => x.key), ['n8', 'n1', 'n2', 'n3', 'n4'])
  assert.deepEqual(t.more.map(x => x.key), ['n5', 'n6', 'n7'])
  // 剛好 6 個不收
  const six = deviceTabs(friends.slice(0, 6), { selfNode: 'n1', nodeOrder: nodes })
  assert.equal(six.visible.length, 6)
  assert.equal(six.more.length, 0)
})

test('deviceTabs：未讀彙總到各設備頁籤與「更多」', () => {
  const nodes = ['n1', 'n2', 'n3', 'n4', 'n5', 'n6', 'n7']
  const friends = nodes.flatMap(n => [F(n, n, `${n}-a`, 'online', n === 'n6' ? 2 : 0), F(n, n, `${n}-b`, 'offline', n === 'n6' ? 1 : n === 'n2' ? 4 : 0)])
  const t = deviceTabs(friends, { selfNode: 'n1', nodeOrder: nodes })
  assert.equal(t.all.find(x => x.key === 'n2').unread, 4)
  assert.equal(t.all.find(x => x.key === 'n6').unread, 3)
  assert.equal(t.all.find(x => x.key === 'n6').online, 1)
  assert.equal(t.all.find(x => x.key === 'n6').total, 2)
  assert.deepEqual(t.more.map(x => x.key), ['n6', 'n7'])
  assert.equal(moreUnread(t.more), 3)
  assert.equal(moreUnread([]), 0)
})

test('deviceItems：只取該設備、線上忙碌在前離線在後、可搜尋', () => {
  const fr = [F('H', 'h', 'b', 'offline'), F('H', 'h', 'c', 'busy'), F('H', 'h', 'a'), F('W', 'w', 'z')]
  assert.deepEqual(deviceItems(fr, 'H').map(f => f.nick), ['a', 'c', 'b'])
  assert.deepEqual(deviceItems(fr, 'H', f => f.nick === 'c').map(f => f.nick), ['c'])
  assert.equal(shortOf(''), '?')
  assert.equal(shortOf('abc'), 'A')
})

test('通知紀錄：新的在前、上限 50、欄位完整', () => {
  let l = []
  for (let i = 0; i < NOTICE_MAX + 5; i++) l = addNotice(l, { cid: `c${i}`, who: `誰${i}`, line: `句${i}`, t: i })
  assert.equal(l.length, NOTICE_MAX)
  assert.deepEqual(l[0], { cid: `c${NOTICE_MAX + 4}`, who: `誰${NOTICE_MAX + 4}`, line: `句${NOTICE_MAX + 4}`, kind: 'msg', t: NOTICE_MAX + 4 })
  assert.equal(addNotice([], { cid: 'x', who: 'a', line: 'b' }, { now: () => 123 })[0].t, 123)
})

test('fmtTime：當天只顯示時間、其他天加日期', () => {
  const now = new Date(2026, 9, 20, 15, 0).getTime()
  assert.equal(fmtTime(new Date(2026, 9, 20, 9, 5).getTime(), now), '09:05')
  assert.equal(fmtTime(new Date(2026, 9, 19, 23, 59).getTime(), now), '10/19 23:59')
})

test('groupRows：成員數、最近動靜在前、壞資料略過', () => {
  const rows = groupRows([
    { id: 'r1', name: '舊群', created_at: '2026-10-01T00:00:00Z', members: [{}, {}], last_body: null },
    { id: 'r2', name: '新群', created_at: '2026-10-01T00:00:00Z', last_at: '2026-10-20T00:00:00Z', members: [{}, {}, {}], last_from_name: '小牧', last_body: '看一下\n這個' },
    { bad: 1 }, null,
  ])
  assert.deepEqual(rows.map(r => [r.id, r.count]), [['r2', 3], ['r1', 2]])
  assert.equal(rows[0].last, '小牧：看一下 這個')
  assert.deepEqual(groupRows(undefined), [])
})

test('廣告輪播：循環一圈回到起點；連結只有 repo 文件寫明的網址；文案不含英文品牌', () => {
  let i = 0
  const seq = []
  for (let k = 0; k < ADS.length; k++) { seq.push(i); i = nextAd(i) }
  assert.deepEqual(seq, ADS.map((_, k) => k))
  assert.equal(i, 0)
  assert.ok(ADS.length >= 3 && ADS.length <= 4)
  assert.deepEqual(adUrls(), ['https://irori.web.app/', 'https://irori.web.app/dev/shots/'])
  for (const a of ADS) assert.ok(!/msn|messenger|microsoft/i.test(JSON.stringify(a)), a.key)
  assert.equal(nextAd(0, 0), 0)
})

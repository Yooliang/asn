// 頁籤、通知紀錄、群組列、廣告輪播的純邏輯。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { AD_CONTACT_URL, ADS, AD_MS, DEVICE_TAB_MAX, openAdWith, addNotice, adUrls, deviceItems, deviceTabs, fmtTime, groupHeading, groupRows, moreUnread, nextAd, shortOf, statusNote, NOTICE_MAX } from '../ui/lib/tabs.mjs'

const F = (node, device, nick, status = 'online', unread = 0) => ({ id: `${node}/${nick}`, node, device, nick, status, unread })

test('statusNote：線上不加，其餘灰字', () => {
  assert.equal(statusNote('online'), '')
  assert.equal(statusNote('busy'), '(忙碌)')
  assert.equal(statusNote('offline'), '(離線)')
  assert.equal(statusNote('away'), '(暫離)')
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
  assert.deepEqual(adUrls(), ['https://irori.web.app/', 'https://policy-tw.web.app', 'https://islandmade.app', 'https://irori.web.app/dev/shots/'])
  for (const a of ADS) assert.ok(!/msn|messenger|microsoft/i.test(JSON.stringify(a)), a.key)
  assert.equal(nextAd(0, 0), 0)
})

test('groupInDevice：依狀態分線上／忙碌／暫離／離線，空組不列；依類型 Claude、Gemini、Grok 在前，沒回報的歸其他排最後', async () => {
  const { groupInDevice, groupHeading } = await import('../ui/lib/tabs.mjs')
  const f = (nick, status, engine) => ({ id: nick, nick, status, engine })
  const items = [f('a', 'online', 'claude'), f('b', 'busy', 'gemini'), f('c', 'away', null), f('d', 'offline', 'claude'), f('e', 'online', 'grok')]
  const st = groupInDevice(items, 'status')
  assert.deepEqual(st.map(g => [g.label, g.items.map(x => x.nick)]), [['線上', ['a', 'e']], ['忙碌', ['b']], ['暫離', ['c']], ['離線', ['d']]])
  assert.equal(groupHeading(st[0]), '線上 (2)')
  assert.deepEqual(groupInDevice([f('x', 'busy', 'claude')], 'status').map(g => g.label), ['忙碌'])
  const en = groupInDevice(items, 'engine')
  assert.deepEqual(en.map(g => [g.label, g.items.map(x => x.nick)]), [['Claude', ['a', 'd']], ['Gemini', ['b']], ['Grok', ['e']], ['其他', ['c']]])
  assert.equal(groupHeading(en[0]), 'Claude (1/2)')
})

test('statusOf：waiting 之類＝暫離', async () => {
  const { statusOf } = await import('../ui/lib/roster.mjs')
  assert.equal(statusOf('waiting'), 'away')
  assert.equal(statusOf('idle'), 'online')
  assert.equal(statusOf('working'), 'busy')
})

test('廣告：輪播順序＝希緒、正見、島作、開發日誌、招租；Android 那則已拿掉；每則一句標語加一個短按鈕字', () => {
  assert.deepEqual(ADS.map(a => a.key), ['shio', 'policy', 'islandmade', 'devlog', 'rent'])
  assert.ok(!ADS.some(a => /android/i.test(JSON.stringify(a))))
  for (const a of ADS) {
    assert.ok(a.title && a.sub && !/\n/.test(a.sub) && a.sub.length <= 24, `${a.key} 標語要一句`)
    assert.ok(a.cta && a.cta.length <= 3, `${a.key} 按鈕字要短`)
  }
  assert.equal(ADS[0].url, 'https://irori.web.app/')
  assert.equal(ADS[1].url, 'https://policy-tw.web.app')
  assert.equal(ADS[2].url, 'https://islandmade.app')
  assert.equal(ADS[3].url, 'https://irori.web.app/dev/shots/')
  let i = 0; const seq = []
  for (let k = 0; k < ADS.length * 2; k++) { seq.push(ADS[i].key); i = nextAd(i) }
  assert.deepEqual(seq, ['shio', 'policy', 'islandmade', 'devlog', 'rent', 'shio', 'policy', 'islandmade', 'devlog', 'rent'])
  assert.ok(AD_MS >= 3000)
})

test('廣告：每個網址都在 Rust 端 OPEN_ALLOW 白名單裡，白名單裡也沒有多餘的（兩邊一致）', () => {
  const rs = fs.readFileSync(new URL('../src-tauri/src/lib.rs', import.meta.url), 'utf8')
  const block = /pub const OPEN_ALLOW[^=]*=\s*\[([\s\S]*?)\];/.exec(rs)[1]
  const allow = [...block.matchAll(/"([^"]+)"/g)].map(m => m[1])
  const used = [...adUrls(), ...(AD_CONTACT_URL ? [AD_CONTACT_URL] : [])]
  for (const u of used) assert.ok(allow.includes(u), `${u} 沒列在 OPEN_ALLOW`)
  for (const u of allow) assert.ok(used.includes(u), `OPEN_ALLOW 有多餘的 ${u}`)
  assert.ok(allow.every(u => u.startsWith('https://')))
})

test('廣告位招租：聯絡網址還沒給（空字串）時照常輪播，但點下去不呼叫 open_url、不開任何網址', () => {
  assert.equal(AD_CONTACT_URL, '')
  const rent = ADS.find(a => a.key === 'rent')
  assert.equal(rent.title, '廣告位招租')
  assert.equal(rent.cta, '洽詢')
  assert.equal(rent.url, '')
  const opened = []
  assert.equal(openAdWith(rent, u => opened.push(u)), false)
  assert.deepEqual(opened, [])
  assert.equal(openAdWith(ADS.find(a => a.key === 'policy'), u => opened.push(u)), true)
  assert.deepEqual(opened, ['https://policy-tw.web.app'])
  assert.equal(openAdWith(undefined, u => opened.push(u)), false)
  // 有填聯絡網址時（之後）就會開；這裡只驗機制
  assert.equal(openAdWith({ url: 'https://example.invalid/' }, u => opened.push(u)), true)
})

test('守門：廣告不用任何 AdSense／外部廣告程式碼；點廣告一律走 openAdWith；招租沒網址時按鈕是停用的', () => {
  const dir = new URL('../ui/', import.meta.url)
  for (const f of ['list.html', 'list.js', 'toast.html', 'chat.html', 'lib/tabs.mjs']) {
    const t = fs.readFileSync(new URL(f, dir), 'utf8')
    assert.ok(!/adsbygoogle|googlesyndication|pagead|doubleclick|adservice/i.test(t), `${f} 不該有外部廣告程式碼`)
  }
  const js = fs.readFileSync(new URL('list.js', dir), 'utf8')
  assert.ok(js.includes("openAdWith(a, url => void invoke('open_url', { url }))"))
  assert.ok(!js.includes("if (a.url) void invoke('open_url'"))
  assert.ok(fs.readFileSync(new URL('list.html', dir), 'utf8').includes(':disabled="!a.url"'))
  const html = fs.readFileSync(new URL('list.html', dir), 'utf8')
  assert.ok(!/<script[^>]+src="https?:/.test(html), '不載入外部腳本')
})

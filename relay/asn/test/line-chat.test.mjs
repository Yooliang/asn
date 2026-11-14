// LINE 外觀對話區的純邏輯（#1449 第二張）：時間、已讀、日期膠囊、連續訊息。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { clockLabel, dayPillText, sentStateText, lineRows, CONT_GAP_MS } from '../ui/lib/line-chat.mjs'

const at = (y, mo, d, h, mi) => new Date(y, mo - 1, d, h, mi).getTime()

test('clockLabel：上午／下午、十二小時制', () => {
  assert.equal(clockLabel(at(2026, 11, 14, 15, 52)), '下午 3:52')
  assert.equal(clockLabel(at(2026, 11, 14, 0, 5)), '上午 12:05')
  assert.equal(clockLabel(at(2026, 11, 14, 12, 0)), '下午 12:00')
  assert.equal(clockLabel(at(2026, 11, 14, 9, 7)), '上午 9:07')
  assert.equal(clockLabel('不是時間'), '')
})

test('dayPillText：今天不顯示、昨天、更早帶星期', () => {
  const now = at(2026, 11, 14, 10, 0)
  assert.equal(dayPillText(at(2026, 11, 14, 1, 0), now), '')
  assert.equal(dayPillText(at(2026, 11, 13, 23, 59), now), '昨天')
  assert.equal(dayPillText(at(2026, 11, 10, 8, 0), now), '2026/11/10（二）')
  assert.equal(dayPillText(at(2026, 10, 31, 8, 0), at(2026, 11, 1, 8, 0)), '昨天', '跨月的昨天')
})

test('sentStateText：一對一只認真的送達／已讀資料，已送出不冒充已讀', () => {
  assert.equal(sentStateText({ k: 'me' }, false), '')
  assert.equal(sentStateText({ k: 'me', deliveredAt: 'x' }, false), '✓')
  assert.equal(sentStateText({ k: 'me', deliveredAt: 'x', ackedAt: 'y' }, false), '已讀')
  assert.equal(sentStateText({ k: 'me', repliedAt: 'z' }, false), '已讀')
  assert.equal(sentStateText({ k: 'them', ackedAt: 'y' }, false), '')
})

test('sentStateText：群組沿用「已讀 N」「全部已讀」，沒有資料不顯示', () => {
  assert.equal(sentStateText({ k: 'me', rd: { n: 2, total: 5, by: [], un: [] } }, true), '已讀 2')
  assert.equal(sentStateText({ k: 'me', rd: { n: 5, total: 5, by: [], un: [] } }, true), '全部已讀')
  assert.equal(sentStateText({ k: 'me', deliveredAt: 'x' }, true), '')
})

test('lineRows：同一人連發只有第一則不是 cont；換人、超過間隔、系統提示、跨日都重新開始', () => {
  const now = at(2026, 11, 14, 12, 0), t0 = at(2026, 11, 14, 9, 0)
  const log = [
    { k: 'them', who: '甲', t: t0 },
    { k: 'them', who: '甲', t: t0 + 1000 },
    { k: 'them', who: '乙', t: t0 + 2000 },
    { k: 'them', who: '乙', t: t0 + 2000 + CONT_GAP_MS + 1 },
    { k: 'sys', text: '提示', t: t0 },
    { k: 'them', who: '乙', t: t0 + 9e6 },
    { k: 'me', t: t0 + 9e6 + 1 },
    { k: 'me', t: t0 + 9e6 + 2 },
  ]
  assert.deepEqual(lineRows(log, { now }).map(r => r.cont ?? null), [false, true, false, false, null, false, false, true])
})

test('lineRows：日期膠囊只在新的一天第一則，今天沒有膠囊', () => {
  const now = at(2026, 11, 14, 12, 0)
  const log = [
    { k: 'them', t: at(2026, 11, 13, 23, 59) },
    { k: 'them', t: at(2026, 11, 14, 0, 1) },
    { k: 'me', t: at(2026, 11, 14, 0, 2) },
  ]
  const r = lineRows(log, { now })
  assert.deepEqual(r.map(x => x.pill), ['昨天', '', ''])
  assert.equal(r[1].cont, false, '跨日不算連續')
  assert.deepEqual(lineRows([], { now }), [])
  assert.deepEqual(lineRows(null, { now }), [])
})

// ---- 守門：新節點只在 LINE 外觀才輸出（復古 Aero／現代的畫面一個節點都不多）----
import fs from 'node:fs'
const read = p => fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n')
const linesWith = (src, re) => src.split('\n').filter(l => re.test(l))

test('對話區：LINE 專用的節點都帶 isLine 條件，原本的名字列只在非 LINE 輸出', () => {
  const pane = read('ui/lib/chatpane.mjs')
  for (const cls of ['l-day', 'l-name', 'l-line']) {
    const hits = linesWith(pane, new RegExp(`<div class="${cls}"`))
    assert.equal(hits.length, 1, cls)
    assert.match(hits[0], /v-if="isLine/, `${cls} 要在 isLine 條件下才輸出`)
  }
  assert.match(pane, /<div class="who" v-if="!isLine">/)
  assert.match(pane, /v-if="!isLine && shownBody\(m\)\.text"/)
  assert.match(pane, /'l-cont': isLine && lrows\[i\] && lrows\[i\]\.cont/)
  assert.match(pane, /const lrows = computed\(\(\) => \(isLine\.value \? lineRows\(/, '其他外觀不計算 LINE 旗標')
})

test('標題列：返回、人數、通話鍵只在 LINE；通話鍵走既有的 startCall，不新增通話邏輯', () => {
  const bar = read('ui/lib/actionbar.mjs')
  for (const cls of ['mbar-back', 'mbar-count', 'mbtn mbtn-call']) {
    const hits = linesWith(bar, new RegExp(`class="${cls}"`))
    assert.equal(hits.length, 1, cls)
    assert.match(hits[0], /v-if="skin === 'line'/, `${cls} 只在 LINE 才輸出`)
  }
  assert.match(linesWith(bar, /mbtn-call/)[0], /@click="startCall"/)
  const m = read('ui/m.html')
  const call = linesWith(m, /m-head-call/)[0]
  assert.match(call, /v-if="prefs\.skin === 'line'/); assert.match(call, /@click="chatPaneEl\.startCall\(\)"/)
  const list = read('ui/list.html')
  assert.match(linesWith(list, /ttab-ic/)[0], /v-if="skin === 'line'"/)
  assert.match(list, /:title="skin === 'line' \? t\.label : null"/, '其他外觀不多 title 屬性')
  assert.match(m, /:data-line-chat="lineChat \? '' : null"/, '不在 LINE 對話頁時屬性不存在')
})

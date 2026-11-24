// LINE 外觀對話區的純邏輯（#1449 第二張）：時間、已讀、日期膠囊、連續訊息。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { clockLabel, dayPillText, sentStateText, lineRows, CONT_GAP_MS } from '../ui/lib/line-chat.mjs'
import { skinCss } from './skin-css.mjs'

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

// ---- #1449 第三張：清單時間、輸入框高度、輸入列與清單列的節點守門 ----
import { listTimeText, composeFieldHeight, COMPOSE_MAX_LINES } from '../ui/lib/line-chat.mjs'
import { roomPseudoFriend } from '../ui/lib/mobile-rooms.mjs'

test('listTimeText：今天「下午 3:52」、昨天、一週內星期、更早月/日、跨年帶年份；沒有時間回空字串', () => {
  const now = at(2026, 11, 14, 16, 0)   // 星期六
  assert.equal(listTimeText(at(2026, 11, 14, 15, 52), now), '下午 3:52')
  assert.equal(listTimeText(at(2026, 11, 14, 0, 1), now), '上午 12:01')
  assert.equal(listTimeText(at(2026, 11, 13, 23, 59), now), '昨天')
  assert.equal(listTimeText(at(2026, 11, 11, 9, 0), now), '星期三')
  assert.equal(listTimeText(at(2026, 11, 8, 9, 0), now), '星期日')
  assert.equal(listTimeText(at(2026, 11, 7, 9, 0), now), '11/7', '滿七天改寫日期')
  assert.equal(listTimeText(at(2025, 12, 31, 9, 0), now), '2025/12/31')
  assert.equal(listTimeText(0, now), '')
  assert.equal(listTimeText(undefined, now), '')
  assert.equal(listTimeText('不是時間', now), '')
  assert.equal(listTimeText(at(2026, 10, 31, 23, 0), at(2026, 11, 1, 8, 0)), '昨天', '跨月的昨天')
})

test('composeFieldHeight：最少一行、隨內容變高、最多六行後固定並捲動', () => {
  const o = { lineH: 22, extra: 18 }
  assert.deepEqual(composeFieldHeight(40, o), { height: 40, scroll: false })
  assert.deepEqual(composeFieldHeight(0, o), { height: 40, scroll: false }, '空的（量不到）也是一行')
  assert.deepEqual(composeFieldHeight(NaN, o), { height: 40, scroll: false })
  assert.deepEqual(composeFieldHeight(84, o), { height: 84, scroll: false }, '三行')
  assert.deepEqual(composeFieldHeight(150, o), { height: 150, scroll: false }, '剛好六行不捲')
  assert.deepEqual(composeFieldHeight(172, o), { height: 150, scroll: true }, '七行停在六行')
  assert.deepEqual(composeFieldHeight(2000, o), { height: 150, scroll: true })
  assert.equal(COMPOSE_MAX_LINES, 6)
  assert.deepEqual(composeFieldHeight(84, { ...o, border: 2 }), { height: 86, scroll: false }, '邊框算進高度')
  assert.deepEqual(composeFieldHeight(172, { ...o, border: 2 }), { height: 152, scroll: true })
})

test('輸入列：圖片鈕、框內表情鈕只在 LINE 輸出；原本的按鈕一顆不少、沿用既有 handler 與 disabled 條件', () => {
  const pane = read('ui/lib/chatpane.mjs')
  for (const cls of ['lc-photo', 'lc-emo', 'picker lc-picker']) {
    const hits = linesWith(pane, new RegExp(`class="${cls}"`))
    assert.equal(hits.length, 1, cls)
    assert.match(hits[0], /v-if="isLine/, `${cls} 只在 LINE 才輸出`)
  }
  assert.match(linesWith(pane, /class="lc-photo"/)[0], /@click="fileEl && fileEl\.click\(\)" :disabled="photoBusy"/, '圖片鈕沿用既有的選檔 input 與 disabled 條件')
  assert.match(linesWith(pane, /class="lc-emo"/)[0], /pickerOpen = !pickerOpen/, '表情鈕沿用 pickerOpen')
  assert.match(pane, /<div class="picker" v-if="pickerOpen && \(!isLine \|\| plusOpen \|\| lineRow\)"/, '非 LINE 時選單的條件等於原本的 pickerOpen（LINE 電腦版的按鈕區直接開，#1527）')
  // 原本工具列上的按鈕一顆都沒拿掉（LINE 下都收在「＋」選單裡）
  for (const label of ['表情符號', '通話', '語音輸入', '傳送震動', '傳照片', '傳送檔案', '截圖']) assert.ok(pane.includes(`aria-label="${label}"`), `原本的「${label}」還在`)
  assert.match(pane, /@click="startShot"/); assert.match(pane, /@click="nudge"/); assert.match(pane, /@click="startCall"/); assert.match(pane, /@click="dictClick"/); assert.match(pane, /@click="micClick"/)
  // 送出鈕的樣板一個字不動（「有字才出現」純靠 line.css 的 :placeholder-shown）；輸入框高度只在 LINE 才寫 style
  assert.match(pane, /<button class="aero-btn" type="submit" :aria-label="sendLabel" :disabled="composeLocked \|\| !draft\.trim\(\)">/)
  assert.match(read('ui/line.css'), /\.composer:has\(textarea:placeholder-shown\) \.aero-btn\{display:none\}/)
  assert.match(pane, /if \(!isLine\.value\) \{ if \(el\.style\.height \|\| el\.style\.overflowY\)/, '其他外觀不寫輸入框的 style')
  const css = read('ui/line.css')
  assert.doesNotMatch(css, /\.toolbar \.tool\s*\{[^}]*display:\s*none/, 'LINE 的 CSS 不一刀切藏工具列按鈕（之後新增的按鈕才不會被藏起來）')
})

test('清單列：最後時間只在 LINE 才輸出，來源是既有的 lastAt／at，未讀圓圈仍是原本的 .unread', () => {
  const list = read('ui/list.html'), m = read('ui/m.html')
  const lt = linesWith(list, /class="l-time"/), mt = linesWith(m, /class="l-time"/)
  assert.equal(lt.length, 3); assert.equal(mt.length, 4)
  for (const l of lt) assert.match(l, /v-if="skin === 'line' && listTimeText\(/)
  for (const l of mt) assert.match(l, /v-if="prefs\.skin === 'line' && listTimeText\(/)
  assert.equal(linesWith(list, /class="unread" v-if="(c|x\.room|x\.friend)\.unread"/).length, 3, '電腦清單的未讀徽章沒被改')
  assert.equal(linesWith(m, /class="unread" v-if="(c|r|x\.room|x\.friend)\.unread"/).length, 4, '手機清單的未讀徽章沒被改')
})

test('標題列人數：電腦與手機都顯示同一份 psm（「N 位成員」），離線人數兩邊都走 offlineView', () => {
  assert.equal(roomPseudoFriend({ chatId: 'g1', name: '測試群', count: 3 }).psm, '3 位成員')
  const bar = read('ui/lib/actionbar.mjs'), m = read('ui/m.html'), mjs = read('ui/m.js')
  assert.match(linesWith(bar, /class="mbar-count"/)[0], /\{\{ friend\.psm \}\}/)
  assert.match(linesWith(m, /class="m-plate-count"/)[0], /\{\{ chatFriend\.psm \}\}/)
  assert.match(bar, /offlineView\(props\.names\)/); assert.match(mjs, /offlineView\(chatFriend\.value\.offline\)/)
})

test('LINE 外觀：空白的系統提示不畫成一條小橫槓', () => {
  assert.match(read('ui/line.css'), /\[data-skin="line"\] \.sys:empty\{display:none\}/)
})

// 「工具列位置：輸入框下方」要對 LINE 外觀有作用：LINE 的 #app.win .compose-main.lc-row 把工具列固定在輸入框上方（flex-direction:column），
// style.css 的 .tb-bottom .compose-main{column-reverse} 權重比它低、被蓋掉；所以 line.css 要自己有一條權重更高的 .tb-bottom 版本。
// 版面算不出來（沒有瀏覽器），改比選擇器權重：.tb-bottom 版本必須勝過所有設 flex-direction 的 .compose-main.lc-row 規則，且只在 .tb-bottom 底下才反排。
function specificity(sel) {
  const s = sel.replace(/\[[^\]]*\]/g, '[]')
  return [(s.match(/#[\w-]+/g) ?? []).length, (s.match(/\.[\w-]+|\[\]|:(?!:)[\w-]+/g) ?? []).length, (s.match(/(^|[\s>+~])[a-zA-Z][\w-]*/g) ?? []).length]
}
const cmpSpec = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]
function rulesWith(css, prop) {
  const out = []
  for (const m of css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (!new RegExp(String.raw`(^|;)\s*${prop}\s*:`).test(m[2])) continue
    const value = m[2].match(new RegExp(String.raw`(?:^|;)\s*${prop}\s*:\s*([^;]+)`))[1].trim()
    for (const sel of m[1].split(',')) out.push({ sel: sel.trim(), value })
  }
  return out
}
test('LINE 外觀：工具列位置「輸入框下方」（.tb-bottom）有作用，工具列在上方時維持原樣', () => {
  const rules = rulesWith(skinCss('line'), 'flex-direction').filter(r => /\.compose-main\.lc-row$/.test(r.sel))
  const col = rules.filter(r => r.value === 'column'), rev = rules.filter(r => r.value === 'column-reverse')
  assert.ok(col.length >= 1, 'LINE 預設（工具列在上）的 column 規則還在')
  assert.ok(rev.length >= 1, 'line.css 要有 .tb-bottom 底下的 column-reverse 規則')
  for (const r of rev) assert.match(r.sel, /\.tb-bottom /, `column-reverse 只能放在 .tb-bottom 底下（${r.sel}）`)
  for (const r of col) assert.doesNotMatch(r.sel, /\.tb-/, '預設規則不分 tb-top／tb-bottom')
  const best = rev.map(r => specificity(r.sel)).sort(cmpSpec).at(-1)
  for (const r of col) assert.ok(cmpSpec(best, specificity(r.sel)) > 0, `.tb-bottom 版（${best}）要比「${r.sel}」（${specificity(r.sel)}）重`)
  // 內距也要對調：工具列在下方時貼底、輸入框在上方時上方留白
  const pad = rulesWith(skinCss('line'), 'padding').filter(r => /\.tb-bottom /.test(r.sel))
  assert.ok(pad.some(r => /> \.toolbar$/.test(r.sel)) && pad.some(r => /\.composer$/.test(r.sel)), '.tb-bottom 底下工具列與輸入框的內距有對調')
})

// ---- #1785：電腦版 LINE 左欄「通知、設定」靠下，其他外觀與手機不動 ----
import { TOP_TABS, TOP_TABS_LINE } from '../ui/lib/tabs.mjs'

test('#1785：LINE 左欄順序是 夥伴、對話、通知、設定（DOM 順序＝畫面順序＝焦點順序）；其他外觀仍是 夥伴、對話、設定、通知', () => {
  assert.deepEqual(TOP_TABS_LINE.map(t => t.key), ['partners', 'chats', 'notice', 'settings'])
  assert.deepEqual(TOP_TABS.map(t => t.key), ['partners', 'chats', 'settings', 'notice'], '其他外觀與手機的順序照舊')
  assert.match(read('ui/list.html'), /v-for="t in \(skin === 'line' \? TOP_TABS_LINE : TOP_TABS\)"/, '只有 LINE 外觀換順序')
})

test('#1785：通知鈕用 margin-top:auto 把通知與設定一起推到欄底，規則只作用於 LINE 外觀', () => {
  const css = read('ui/line.css')
  const hit = css.split('\n').filter(l => /\.ttab-notice\{[^}]*margin-top:auto/.test(l))
  assert.equal(hit.length, 1)
  assert.ok(hit[0].startsWith(':root[data-skin="line"] '), '選擇器要掛在 LINE 外觀底下')
  for (const f of ['ui/style.css', 'ui/modern.css', 'ui/skin-common.css']) assert.doesNotMatch(read(f), /ttab-notice\{[^}]*margin-top:auto/, `${f} 不能動到其他外觀`)
})

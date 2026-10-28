// 手機的第四頁籤（#461）：出現與收起的時機（含 3 分鐘，用假時鐘）、換內頁、返回鍵一層一層退、舊瀏覽記錄的轉換、畫面接線。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { FOURTH_KEEP_MS, PAGE_TAB, acctPage, fourthExpired, fourthMsLeft, fourthOnTab, guidePage, normalizePage, openFourth, pageLayers, settingPage } from '../ui/lib/mobile-fourth.mjs'
import { createMobileNav, pageTitle } from '../ui/lib/mobile-nav.mjs'
import { TABS, initialNav, normalizeNav, pageNav, tabIndex, tabLabel, tabList, tabNav } from '../ui/lib/mobile.mjs'

const read = (...p) => fs.readFileSync(new URL(`../${p.join('/')}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n')

// 假的瀏覽記錄：跟瀏覽器一樣，back／go 不會立刻觸發 popstate，要等 flush（模擬事件迴圈）
function harness(saved = 'list') {
  const clock = { t: 1_000_000 }
  const entries = [{ state: initialNav() }]
  let idx = 0
  const queue = []
  const history = {
    pushState(s) { entries.splice(idx + 1); entries.push({ state: structuredClone(s) }); idx = entries.length - 1 },
    replaceState(s) { entries[idx] = { state: structuredClone(s) } },
    back() { queue.push(-1) },
    go(d) { if (d) queue.push(d) },
  }
  const nav = { ...initialNav() }, st = { fourth: null }
  const r = createMobileNav({ history, nav, st, now: () => clock.t })
  const flush = () => { while (queue.length) { const d = queue.shift(); const to = Math.max(0, Math.min(entries.length - 1, idx + d)); if (to === idx) continue; idx = to; r.onPop(structuredClone(entries[idx].state)) } }
  const press = () => { history.back(); flush() }   // 系統返回鍵
  if (saved !== 'list') r.go(tabNav(saved))
  return { r, nav, st, clock, flush, press, depth: () => idx, stack: () => entries.slice(0, idx + 1).map(e => e.state) }
}

test('內頁描述：設置分類、指引、設備與帳號；壞資料一律 null 或退回列表；內頁的層', () => {
  assert.deepEqual(settingPage('notify'), { kind: 'setting', cat: 'notify' })
  assert.equal(settingPage('devices'), null, '設備與帳號不是設置的一般分類頁')
  assert.equal(settingPage('nope'), null)
  assert.deepEqual(guidePage(), { kind: 'guide', guide: '' }); assert.deepEqual(guidePage('faq'), { kind: 'guide', guide: 'faq' }); assert.deepEqual(guidePage('../x'), { kind: 'guide', guide: '' })
  assert.deepEqual(acctPage(), { kind: 'acct', node: '' }); assert.deepEqual(acctPage(5), { kind: 'acct', node: '' }); assert.deepEqual(acctPage('W'), { kind: 'acct', node: 'W' })
  for (const bad of [null, undefined, 5, 'x', {}, { kind: 'launch' }, { kind: 'setting', cat: 'devices' }]) assert.equal(normalizePage(bad), null, JSON.stringify(bad))
  assert.deepEqual(pageLayers(guidePage('faq')), [guidePage(), guidePage('faq')], '指引單篇下面是篇目列表')
  assert.deepEqual(pageLayers(acctPage('W')), [acctPage(), acctPage('W')], '設備細部下面是設備列表')
  assert.deepEqual(pageLayers(settingPage('about')), [settingPage('about')])
  assert.deepEqual(pageLayers(null), [])
})

test('頁籤列：沒有第四頁籤時三個，有時四個；標題用內頁的標題；對話分頁永遠叫「對話」', () => {
  assert.deepEqual(tabList(null), TABS)
  assert.deepEqual(tabList(openFourth(settingPage('notify'), 'me')), [...TABS, PAGE_TAB])
  assert.equal(tabIndex(PAGE_TAB, tabList(openFourth(guidePage(), 'me'))), 3)
  assert.equal(tabLabel('chats'), '對話'); assert.equal(tabLabel('list'), '夥伴'); assert.equal(tabLabel('me'), '設置')
  assert.equal(tabLabel(PAGE_TAB, '通知'), '通知')
  assert.equal(pageTitle(settingPage('notify')), '通知')
  assert.equal(pageTitle(acctPage('W')), '設備與帳號')
  assert.equal(pageTitle(guidePage()), '使用指引')
  assert.notEqual(pageTitle(guidePage('faq')), '使用指引', '單篇用那一篇的標題'); assert.ok(pageTitle(guidePage('faq')))
  assert.equal(pageTitle(null), '')
})

test('計時：切走才開始算（已在算不重算）、切回取消；滿 3 分鐘才算到期；剩餘時間', () => {
  const f = openFourth(settingPage('about'), 'me')
  assert.equal(f.leftAt, 0); assert.equal(fourthExpired(f, 10 ** 12), false, '正在看不會到期')
  const left = fourthOnTab(f, 'list', 100)
  assert.equal(left.leftAt, 100)
  assert.equal(fourthOnTab(left, 'chats', 500).leftAt, 100, '在前三頁之間切換不重算')
  assert.equal(fourthOnTab(left, PAGE_TAB, 200).leftAt, 0, '切回第四頁籤取消計時')
  assert.equal(fourthExpired(left, 100 + FOURTH_KEEP_MS - 1), false)
  assert.equal(fourthExpired(left, 100 + FOURTH_KEEP_MS), true)
  assert.equal(fourthMsLeft(left, 100 + 60000), FOURTH_KEEP_MS - 60000); assert.equal(fourthMsLeft(f, 5), Infinity)
  assert.equal(FOURTH_KEEP_MS, 180000)
  assert.equal(fourthOnTab(null, 'list', 1), null)
})

test('進內頁就出現並切過去；切到前三頁開始計時；未滿 3 分鐘切回取消；超過 3 分鐘收起', () => {
  const h = harness('me')
  assert.equal(h.st.fourth, null)
  assert.equal(h.r.openPage(settingPage('notify')), true)
  assert.equal(h.nav.tab, PAGE_TAB); assert.deepEqual(h.st.fourth.page, settingPage('notify')); assert.equal(h.st.fourth.from, 'me'); assert.equal(h.st.fourth.leftAt, 0)
  // 點「夥伴」：第四頁籤留著、開始計時
  h.r.goTab('list'); h.flush()
  assert.equal(h.nav.tab, 'list'); assert.ok(h.st.fourth, '頁籤留著'); assert.equal(h.st.fourth.leftAt, h.clock.t)
  assert.equal(h.depth(), 0, '第四頁籤的記錄退掉了，返回鍵照夥伴分頁的規則（退到背景）')
  h.clock.t += FOURTH_KEEP_MS - 1000
  assert.equal(h.r.check(), false); assert.ok(h.st.fourth)
  h.r.goTab(PAGE_TAB)
  assert.equal(h.nav.tab, PAGE_TAB); assert.equal(h.st.fourth.leftAt, 0, '切回來就取消計時')
  h.clock.t += FOURTH_KEEP_MS * 5
  assert.equal(h.r.check(), false, '正在看的不會收')
  // 再切走（滑到設置），超過 3 分鐘收起
  h.r.goTab('me'); h.flush()
  assert.equal(h.nav.tab, 'me'); assert.deepEqual(h.stack(), [initialNav(), tabNav('me')])
  h.clock.t += FOURTH_KEEP_MS
  assert.equal(h.r.check(), true); assert.equal(h.st.fourth, null)
  assert.deepEqual(tabList(h.st.fourth), TABS, '收起後只剩三個頁籤')
  h.r.goTab(PAGE_TAB); assert.equal(h.nav.tab, 'me', '收起後點不到第四頁籤')
})

test('App 在背景：用絕對時間判斷，回到前景時已超過就收起', () => {
  const h = harness()
  h.r.openPage(guidePage())
  h.r.goTab('chats'); h.flush()
  const at = h.st.fourth.leftAt
  h.clock.t = at + FOURTH_KEEP_MS + 3600_000   // 背景裡計時器沒跑，回到前景才檢查
  assert.equal(h.r.check(), true); assert.equal(h.st.fourth, null)
})

test('換別的內頁：換掉內容、從目前的分頁重新算（計時歸零）', () => {
  const h = harness('me')
  h.r.openPage(settingPage('about'))
  h.r.goTab('list'); h.flush()
  h.clock.t += 60000
  assert.ok(h.st.fourth.leftAt > 0)
  h.r.openPage(acctPage('W'))   // 從夥伴列表某台設備的「選項」進來
  assert.equal(h.nav.tab, PAGE_TAB); assert.deepEqual(h.st.fourth.page, acctPage('W')); assert.equal(h.st.fourth.from, 'list'); assert.equal(h.st.fourth.leftAt, 0)
  h.r.goTab('me'); h.flush()
  assert.equal(h.st.fourth.leftAt, h.clock.t, '重新計時')
  h.clock.t += FOURTH_KEEP_MS - 1
  assert.equal(h.r.check(), false)
})

test('返回鍵：設備細部 → 設備列表 → 收起第四頁籤，回到進來之前的頁籤', () => {
  const h = harness('me')
  h.r.openPage(acctPage('W'))   // 直接開細部：底下墊一層列表
  assert.deepEqual(h.stack(), [initialNav(), tabNav('me'), pageNav(acctPage()), pageNav(acctPage('W'))])
  h.press()
  assert.equal(h.nav.tab, PAGE_TAB); assert.deepEqual(h.st.fourth.page, acctPage())
  h.press()
  assert.equal(h.st.fourth, null); assert.equal(h.nav.tab, 'me')
  h.press()
  assert.equal(h.nav.tab, 'list', '再按照前三頁的規則')
})

test('返回鍵：指引單篇 → 篇目列表 → 收起；從列表點進一篇多一層', () => {
  const h = harness('me')
  h.r.openPage(guidePage())
  h.r.pushLayer(guidePage('faq'))
  assert.deepEqual(h.st.fourth.page, guidePage('faq'))
  h.press(); assert.deepEqual(h.st.fourth.page, guidePage()); assert.equal(h.nav.tab, PAGE_TAB)
  h.press(); assert.equal(h.st.fourth, null); assert.equal(h.nav.tab, 'me')
})

test('離開再回來：內頁的層照原樣推回，返回鍵還是一層一層退；退到頭回「進內頁之前」的頁籤', () => {
  const h = harness('me')
  h.r.openPage(guidePage())
  h.r.pushLayer(guidePage('faq'))
  h.r.goTab('list'); h.flush()
  assert.equal(h.nav.tab, 'list'); assert.deepEqual(h.stack(), [initialNav()])
  h.r.goTab(PAGE_TAB)
  assert.deepEqual(h.stack(), [initialNav(), pageNav(guidePage()), pageNav(guidePage('faq'))])
  h.press(); assert.deepEqual(h.st.fourth.page, guidePage())
  h.press(); h.flush()
  assert.equal(h.st.fourth, null); assert.equal(h.nav.tab, 'me', '從設置進來的，收起回設置')
  assert.deepEqual(h.stack(), [initialNav(), tabNav('me')])
})

test('內頁的「關閉」：一次退掉所有層；從夥伴進來的回夥伴', () => {
  const h = harness()
  h.r.openPage(acctPage())
  h.r.pushLayer(acctPage('W'))
  h.r.closePage(); h.flush()
  assert.equal(h.st.fourth, null); assert.equal(h.nav.tab, 'list'); assert.equal(h.depth(), 0)
})

test('細部那台不見了又點另一台：取代目前這層，不留一筆按了沒反應的返回', () => {
  const h = harness()
  h.r.openPage(acctPage('W'))
  h.r.pushLayer(acctPage('P'), { replace: true })
  h.press(); assert.deepEqual(h.st.fourth.page, acctPage())
  h.press(); assert.equal(h.st.fourth, null)
})

test('浮層開著時不切頁、不開內頁；浮層從第四頁籤上退回來照常', () => {
  const h = harness()
  h.r.openPage(settingPage('me'))
  h.r.go({ tab: 'chats', sheet: 'secret' })   // 要密碼的面板跳出來
  assert.equal(h.r.openPage(guidePage()), false)
  h.r.goTab('list'); assert.equal(h.nav.sheet, 'secret')
  h.press()
  assert.equal(h.nav.tab, PAGE_TAB); assert.equal(h.nav.sheet, ''); assert.deepEqual(h.st.fourth.page, settingPage('me')); assert.equal(h.st.fourth.leftAt, 0)
})

test('舊的存檔或瀏覽記錄（sheet＝acct／setting／guide）轉成第四頁籤；壞資料不會壞', () => {
  assert.deepEqual(normalizeNav({ tab: 'chats', sheet: 'acct' }), pageNav(acctPage()))
  assert.deepEqual(normalizeNav({ tab: 'me', sheet: 'setting', cat: 'about' }), pageNav(settingPage('about')))
  for (const bad of [{ sheet: 'setting' }, { sheet: 'setting', cat: 'devices' }, { sheet: 'setting', cat: 5 }]) assert.deepEqual(normalizeNav(bad), tabNav('me'), JSON.stringify(bad))
  assert.deepEqual(normalizeNav({ tab: 'me', sheet: 'guide', guide: 'faq' }), pageNav(guidePage('faq')))
  assert.deepEqual(normalizeNav({ sheet: 'guide', guide: 5 }), pageNav(guidePage()))
  assert.deepEqual(normalizeNav(pageNav(acctPage('W'))), pageNav(acctPage('W')))
  for (const bad of [{ tab: PAGE_TAB }, { tab: PAGE_TAB, page: { kind: 'x' } }, { tab: PAGE_TAB, page: 7 }]) assert.deepEqual(normalizeNav(bad), initialNav(), JSON.stringify(bad))
  // 瀏覽記錄退到一筆舊格式的記錄：照它打開第四頁籤
  const h = harness()
  h.r.onPop({ tab: 'chats', sheet: 'acct' })
  assert.equal(h.nav.tab, PAGE_TAB); assert.deepEqual(h.st.fourth.page, acctPage()); assert.equal(h.nav.page, undefined, 'nav 裡不放內頁描述')
})

test('畫面接線：第四頁籤在 pager 最右邊、內頁搬進來；對話分頁不再被借用；頁數不寫死三頁', () => {
  const html = read('ui', 'm.html'), js = read('ui', 'm.js'), css = read('ui', 'mobile.css')
  // 頁籤列與 pager 跟著目前的分頁清單
  assert.match(html, /<button v-for="t in tabs"[^>]*@click="goTab\(t\)"><span>\{\{ tabLabel\(t\) \}\}<\/span>/)
  assert.match(html, /<section class="m-page" :style="\{ '--pages': pages \}">/)
  assert.match(css, /\.m-pager\{[^}]*width:calc\(var\(--pages,3\) \* 100%\)/); assert.match(css, /\.m-pg\{[^}]*flex:0 0 calc\(100% \/ var\(--pages,3\)\)/); assert.match(css, /\.m-ind\{[^}]*width:calc\(100% \/ var\(--pages,3\)\)/)
  assert.doesNotMatch(js, /\* 100 \/ 3\}/, 'pager 不再寫死三頁')
  assert.match(js, /\* 100 \/ pages\.value\}%/)
  assert.match(js, /indicatorPos\(idx\.value, sw\.mode === 'pager' \? sw\.shift : 0, sw\.width, pages\.value\)/)
  assert.match(js, /swipeTarget\(\{ index: idx\.value, dx, dt: Date\.now\(\) - t0, width, count: pages\.value \}\)/)
  assert.match(js, /pagerShift\(idx\.value, dx, pages\.value\)/)
  // 第四頁籤：最後一個 m-pg、有第四頁籤才有，三種內頁在裡面；設置與指引不再是 m-sheet 滿版層
  const fourth = html.slice(html.indexOf('<section class="m-pg m-fourth"'), html.indexOf('<!-- /第四頁籤 -->'))
  assert.ok(html.indexOf('<section class="m-pg m-fourth"') > html.indexOf('<section class="m-pg" aria-label="設置">'), '在設置分頁後面')
  assert.match(fourth, /^<section class="m-pg m-fourth" v-if="fourthPage" :aria-label="fourthTitle">/)
  for (const k of ['acct', 'setting', 'guide']) assert.match(fourth, new RegExp(`fourthPage\\.kind === '${k}'`))
  assert.doesNotMatch(html, /nav\.sheet === '(acct|setting|guide)'/)
  assert.doesNotMatch(html, /class="m-sheet m-(set|guide)"/)
  // 對話分頁：不再被借用
  const chat = html.slice(html.indexOf('<section class="m-pg m-chat"'), html.indexOf('<!-- 設置 -->'))
  assert.match(chat, /aria-label="對話"/); assert.doesNotMatch(chat, /acctSw|m-keep|ACCT_PAGE_TITLE/)
  assert.doesNotMatch(js, /sheet !== 'acct'|sheet === 'acct'/, '已讀與提示判斷不再排除設備與帳號')
  assert.match(js, /isChatVisible: async id => document\.visibilityState === 'visible' && nav\.tab === 'chats' && lastChat\.value === id/)
  // 計時：切走時排一個計時器；回到前景檢查
  assert.match(js, /fourthMsLeft\(/); assert.match(js, /visibilitychange[\s\S]{0,120}fourthNav\.check\(\)|fourthNav\.check\(\)[\s\S]{0,40}visibilitychange/)
  assert.match(js, /window\.addEventListener\('popstate', e => \{[\s\S]*?fourthNav\.onPop\(e\.state\)/)
})

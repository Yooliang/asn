// 手機的內頁（#461；0.2.18 起蓋在進來的那個分頁上，不再佔第四格）：出現與收起的時機（含 3 分鐘，用假時鐘）、換內頁、返回鍵一層一層退、舊瀏覽記錄的轉換、畫面接線。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { FOURTH_KEEP_MS, PAGE_TAB, acctPage, launchPage, needsLeaveAsk, fourthExpired, fourthMsLeft, fourthOnTab, guidePage, normalizePage, openFourth, pageLayers, settingPage } from '../ui/lib/mobile-fourth.mjs'
import { createMobileNav, pageTitle } from '../ui/lib/mobile-nav.mjs'
import { HOME_TAB, TABS, chatNav, chatsUnread, initialNav, opsNav, noticeUnread, normalizeNav, pageHost, pageNav, shownTab, tabDot, tabIndex, tabLabel, tabList, tabNav, viewedChatId } from '../ui/lib/mobile.mjs'

const read = (...p) => fs.readFileSync(new URL(`../${p.join('/')}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n')

// 假的瀏覽記錄：跟瀏覽器一樣，back／go 不會立刻觸發 popstate，要等 flush（模擬事件迴圈）
function harness(saved = HOME_TAB) {
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
  if (saved !== HOME_TAB) r.go(tabNav(saved))
  return { r, nav, st, clock, flush, press, depth: () => idx, stack: () => entries.slice(0, idx + 1).map(e => e.state) }
}

test('內頁描述：設定分類、指引、設備與帳號；壞資料一律 null 或退回列表；內頁的層', () => {
  assert.deepEqual(settingPage('notify'), { kind: 'setting', cat: 'notify' })
  assert.equal(settingPage('devices'), null, '設備與帳號不是設定的一般分類頁')
  assert.equal(settingPage('nope'), null)
  assert.deepEqual(guidePage(), { kind: 'guide', guide: '' }); assert.deepEqual(guidePage('faq'), { kind: 'guide', guide: 'faq' }); assert.deepEqual(guidePage('../x'), { kind: 'guide', guide: '' })
  assert.deepEqual(acctPage(), { kind: 'acct', node: '' }); assert.deepEqual(acctPage(5), { kind: 'acct', node: '' }); assert.deepEqual(acctPage('W'), { kind: 'acct', node: 'W' })
  for (const bad of [null, undefined, 5, 'x', {}, { kind: 'ops' }, { kind: 'setting', cat: 'devices' }]) assert.equal(normalizePage(bad), null, JSON.stringify(bad))
  assert.deepEqual(pageLayers(guidePage('faq')), [guidePage(), guidePage('faq')], '指引單篇下面是篇目列表')
  assert.deepEqual(pageLayers(acctPage('W')), [acctPage(), acctPage('W')], '設備細部下面是設備列表')
  assert.deepEqual(pageLayers(settingPage('about')), [settingPage('about')])
  assert.deepEqual(pageLayers(null), [])
})

test('頁籤列：永遠四個「對話／夥伴／通知／設定」；內頁不佔分頁，分頁列標著它蓋著的那一格', () => {
  assert.deepEqual(tabList(null), TABS)
  assert.deepEqual(tabList(openFourth(settingPage('notify'), 'me')), TABS)
  assert.deepEqual(TABS, ['chats', 'list', 'notice', 'me'])
  assert.deepEqual(TABS.map(t => tabLabel(t)), ['對話', '夥伴', '通知', '設定'])
  assert.equal(tabLabel(PAGE_TAB), '', '內頁不是分頁，沒有分頁字')
  assert.equal(pageHost(null), ''); assert.equal(pageHost(openFourth(guidePage(), 'me')), 'me'); assert.equal(pageHost(openFourth(acctPage('W'), 'list')), 'list')
  assert.equal(shownTab(PAGE_TAB, openFourth(guidePage(), 'me')), 'me', '在內頁上標著設定'); assert.equal(shownTab('notice', null), 'notice'); assert.equal(shownTab(PAGE_TAB, null), HOME_TAB)
  assert.equal(tabIndex(shownTab(PAGE_TAB, openFourth(guidePage(), 'me'))), 3)
  assert.equal(pageTitle(settingPage('notify')), '提醒', '設定的 notify 分類改叫「提醒」')
  assert.equal(pageTitle(acctPage('W')), '設備')
  assert.equal(pageTitle(guidePage()), '使用指引')
  assert.notEqual(pageTitle(guidePage('faq')), '使用指引', '單篇用那一篇的標題'); assert.ok(pageTitle(guidePage('faq')))
  assert.equal(pageTitle(null), '')
})

test('計時：切走才開始算（已在算不重算）、切回取消；滿 3 分鐘才算到期；剩餘時間', () => {
  const f = openFourth(settingPage('about'), 'me')
  assert.equal(f.leftAt, 0); assert.equal(fourthExpired(f, 10 ** 12), false, '正在看不會到期')
  const left = fourthOnTab(f, 'list', 100)
  assert.equal(left.leftAt, 100)
  assert.equal(fourthOnTab(left, 'chats', 500).leftAt, 100, '在分頁之間切換不重算')
  assert.equal(fourthOnTab(left, PAGE_TAB, 200).leftAt, 0, '切回內頁取消計時')
  assert.equal(fourthExpired(left, 100 + FOURTH_KEEP_MS - 1), false)
  assert.equal(fourthExpired(left, 100 + FOURTH_KEEP_MS), true)
  assert.equal(fourthMsLeft(left, 100 + 60000), FOURTH_KEEP_MS - 60000); assert.equal(fourthMsLeft(f, 5), Infinity)
  assert.equal(FOURTH_KEEP_MS, 180000)
  assert.equal(fourthOnTab(null, 'list', 1), null)
})

test('進內頁就蓋在目前的分頁上；切到別的分頁開始計時；未滿 3 分鐘切回那一格就回到內頁；超過 3 分鐘收起', () => {
  const h = harness('me')
  assert.equal(h.st.fourth, null)
  assert.equal(h.r.openPage(settingPage('notify')), true)
  assert.equal(h.nav.tab, PAGE_TAB); assert.deepEqual(h.st.fourth.page, settingPage('notify')); assert.equal(h.st.fourth.from, 'me'); assert.equal(h.st.fourth.leftAt, 0)
  assert.equal(shownTab(h.nav.tab, h.st.fourth), 'me', '分頁列照樣標著設定')
  h.r.goTab('me'); assert.equal(h.nav.tab, PAGE_TAB, '在內頁上點它蓋著的那一格不動')
  // 點「夥伴」：內頁留著、開始計時
  h.r.goTab('list'); h.flush()
  assert.equal(h.nav.tab, 'list'); assert.ok(h.st.fourth, '內頁留著'); assert.equal(h.st.fourth.leftAt, h.clock.t)
  assert.deepEqual(h.stack(), [initialNav(), tabNav('list')], '內頁的記錄退掉了，返回鍵照夥伴分頁的規則（回對話清單）')
  h.clock.t += FOURTH_KEEP_MS - 1000
  assert.equal(h.r.check(), false); assert.ok(h.st.fourth)
  h.r.goTab('me')
  assert.equal(h.nav.tab, PAGE_TAB, '切回設定＝回到內頁'); assert.equal(h.st.fourth.leftAt, 0, '切回來就取消計時')
  h.clock.t += FOURTH_KEEP_MS * 5
  assert.equal(h.r.check(), false, '正在看的不會收')
  // 再切走（滑到通知），超過 3 分鐘收起
  h.r.goTab('notice'); h.flush()
  assert.equal(h.nav.tab, 'notice')
  h.clock.t += FOURTH_KEEP_MS
  assert.equal(h.r.check(), true); assert.equal(h.st.fourth, null, '到期後沒有內頁')
  assert.deepEqual(tabList(h.st.fourth), TABS, '分頁仍是四個')
  h.r.goTab('me'); assert.equal(h.nav.tab, 'me', '到期後點設定看到的是設定分類列表')
})

test('App 在背景：用絕對時間判斷，回到前景時已超過就收起', () => {
  const h = harness()
  h.r.openPage(guidePage())
  h.r.goTab('list'); h.flush()
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
  assert.equal(h.nav.tab, PAGE_TAB); assert.deepEqual(h.st.fourth.page, acctPage('W')); assert.equal(h.st.fourth.from, 'list', '改蓋在夥伴分頁上'); assert.equal(h.st.fourth.leftAt, 0)
  h.r.goTab('me'); h.flush()
  assert.equal(h.st.fourth.leftAt, h.clock.t, '重新計時')
  h.clock.t += FOURTH_KEEP_MS - 1
  assert.equal(h.r.check(), false)
})

test('返回鍵：設備細部 → 設備列表 → 收起內頁，回到底下的分頁', () => {
  const h = harness('me')
  h.r.openPage(acctPage('W'))   // 直接開細部：底下墊一層列表
  assert.deepEqual(h.stack(), [initialNav(), tabNav('me'), pageNav(acctPage()), pageNav(acctPage('W'))])
  h.press()
  assert.equal(h.nav.tab, PAGE_TAB); assert.deepEqual(h.st.fourth.page, acctPage())
  h.press()
  assert.equal(h.st.fourth, null); assert.equal(h.nav.tab, 'me')
  h.press()
  assert.equal(h.nav.tab, HOME_TAB, '再按照分頁的規則（回對話清單）')
})

test('返回鍵：指引單篇 → 篇目列表 → 收起；從列表點進一篇多一層', () => {
  const h = harness('me')
  h.r.openPage(guidePage())
  h.r.pushLayer(guidePage('faq'))
  assert.deepEqual(h.st.fourth.page, guidePage('faq'))
  h.press(); assert.deepEqual(h.st.fourth.page, guidePage()); assert.equal(h.nav.tab, PAGE_TAB)
  h.press(); assert.equal(h.st.fourth, null); assert.equal(h.nav.tab, 'me')
})

test('離開再回來：內頁的層照原樣推回，返回鍵還是一層一層退；退到頭回內頁蓋著的那一格', () => {
  const h = harness('me')
  h.r.openPage(guidePage())
  h.r.pushLayer(guidePage('faq'))
  h.r.goTab(HOME_TAB); h.flush()
  assert.equal(h.nav.tab, HOME_TAB); assert.deepEqual(h.stack(), [initialNav()])
  h.r.goTab('me')
  assert.deepEqual(h.stack(), [initialNav(), pageNav(guidePage()), pageNav(guidePage('faq'))])
  h.press(); assert.deepEqual(h.st.fourth.page, guidePage())
  h.press(); h.flush()
  assert.equal(h.st.fourth, null); assert.equal(h.nav.tab, 'me', '從設定進來的，收起回設定')
  assert.deepEqual(h.stack(), [initialNav(), tabNav('me')])
})

test('內頁的「關閉」：一次退掉所有層；從夥伴進來的回夥伴', () => {
  const h = harness('list')
  h.r.openPage(acctPage())
  h.r.pushLayer(acctPage('W'))
  h.r.closePage(); h.flush()
  assert.equal(h.st.fourth, null); assert.equal(h.nav.tab, 'list'); assert.deepEqual(h.stack(), [initialNav(), tabNav('list')])
})

test('細部那台不見了又點另一台：取代目前這層，不留一筆按了沒反應的返回', () => {
  const h = harness()
  h.r.openPage(acctPage('W'))
  h.r.pushLayer(acctPage('P'), { replace: true })
  h.press(); assert.deepEqual(h.st.fourth.page, acctPage())
  h.press(); assert.equal(h.st.fourth, null)
})

test('停在細部、底下沒有列表那層（照記錄重開）時又點另一台：不取代唯一一層，返回鍵仍退得回、不是整頁收起', () => {
  const h = harness()
  h.r.go(pageNav(acctPage('W'))); h.r.onPop(pageNav(acctPage('W')))   // 內頁已收起，卻退到細部的舊記錄＝照記錄重開，底下是否有列表那層不確定
  assert.deepEqual(h.st.fourth.page, acctPage('W'))
  h.r.pushLayer(acctPage('P'), { replace: true })   // 畫面顯示列表（W 不在名單），使用者點 P：標了取代
  assert.deepEqual(h.st.fourth.page, acctPage('P'))
  h.press()
  assert.ok(h.st.fourth, '返回一次不該直接收起整頁（取代唯一一層的話就會）')
  assert.equal(h.nav.tab, PAGE_TAB)
})

test('細部那台不見了又點另一台：底下確有列表層才取代；退回列表後再進細部仍可取代', () => {
  const h = harness('me')
  h.r.openPage(acctPage('W'))
  const before = h.depth()
  h.r.pushLayer(acctPage('P'), { replace: true })
  assert.equal(h.depth(), before, '取代＝不多一筆記錄')
  h.press(); assert.deepEqual(h.st.fourth.page, acctPage())
  h.r.pushLayer(acctPage('W')); h.r.pushLayer(acctPage('P'), { replace: true })
  h.press(); assert.deepEqual(h.st.fourth.page, acctPage())
  h.press(); assert.equal(h.st.fourth, null); assert.equal(h.nav.tab, 'me')
})

test('浮層開著時不切頁、不開內頁；浮層從內頁上退回來照常', () => {
  const h = harness()
  h.r.openPage(settingPage('me'))
  h.r.go({ tab: 'chats', sheet: 'secret' })   // 要密碼的面板跳出來
  assert.equal(h.r.openPage(guidePage()), false)
  h.r.goTab('list'); assert.equal(h.nav.sheet, 'secret')
  h.press()
  assert.equal(h.nav.tab, PAGE_TAB); assert.equal(h.nav.sheet, ''); assert.deepEqual(h.st.fourth.page, settingPage('me')); assert.equal(h.st.fourth.leftAt, 0)
})

test('舊的存檔或瀏覽記錄（sheet＝acct／setting／guide）轉成內頁；舊版第四格的通知轉成通知分頁；壞資料不會壞', () => {
  assert.deepEqual(normalizeNav({ tab: 'chats', sheet: 'acct' }), pageNav(acctPage()))
  assert.deepEqual(normalizeNav({ tab: 'me', sheet: 'setting', cat: 'about' }), pageNav(settingPage('about')))
  for (const bad of [{ sheet: 'setting' }, { sheet: 'setting', cat: 'devices' }, { sheet: 'setting', cat: 5 }]) assert.deepEqual(normalizeNav(bad), tabNav('me'), JSON.stringify(bad))
  assert.deepEqual(normalizeNav({ tab: 'me', sheet: 'guide', guide: 'faq' }), pageNav(guidePage('faq')))
  assert.deepEqual(normalizeNav({ sheet: 'guide', guide: 5 }), pageNav(guidePage()))
  assert.deepEqual(normalizeNav(pageNav(acctPage('W'))), pageNav(acctPage('W')))
  for (const bad of [{ tab: PAGE_TAB }, { tab: PAGE_TAB, page: { kind: 'x' } }, { tab: PAGE_TAB, page: 7 }]) assert.deepEqual(normalizeNav(bad), tabNav('notice'), `舊版第四格沒有合法內頁＝通知分頁：${JSON.stringify(bad)}`)
  assert.deepEqual(normalizeNav({ tab: 'page', sheet: '' }), tabNav('notice'), '舊記錄 tab＝page（第四格的通知）還原成通知分頁')
  // 瀏覽記錄退到一筆舊格式的記錄：照它打開內頁
  const h = harness()
  h.r.onPop({ tab: 'chats', sheet: 'acct' })
  assert.equal(h.nav.tab, PAGE_TAB); assert.deepEqual(h.st.fourth.page, acctPage()); assert.equal(h.nav.page, undefined, 'nav 裡不放內頁描述'); assert.equal(pageHost(h.st.fourth), HOME_TAB, '照記錄重開的蓋在對話分頁上')
})

test('畫面接線：四個分頁在 pager 裡；內頁蓋在進來的那一格上（跟著一起滑）；通知是自己的分頁；頁數不寫死', () => {
  const html = read('ui', 'm.html'), js = read('ui', 'm.js'), css = read('ui', 'mobile.css')
  // 頁籤列與 pager 跟著分頁清單；標著哪一格看 curTab（在內頁上＝內頁蓋著的那一格）
  assert.match(html, /<button v-for="t in tabs" :key="t" type="button" role="tab" :class="\{ on: curTab === t \}" :aria-selected="curTab === t" @click="goTab\(t\)"><span>\{\{ tabLabel\(t\) \}\}<\/span><i class="red" v-if="tabHasDot\(t\)">/)
  assert.match(html, /<section class="m-page" :style="\{ '--pages': pages \}">/)
  assert.match(css, /\.m-pager\{[^}]*width:calc\(var\(--pages,3\) \* 100%\)/); assert.match(css, /\.m-pg\{[^}]*flex:0 0 calc\(100% \/ var\(--pages,3\)\)/); assert.match(css, /\.m-ind\{[^}]*width:calc\(100% \/ var\(--pages,3\)\)/)
  assert.doesNotMatch(js, /\* 100 \/ 3\}/, 'pager 不再寫死頁數')
  assert.match(js, /\* 100 \/ pages\.value\}%/)
  assert.match(js, /const curTab = computed\(\(\) => shownTab\(nav\.tab, fourthSt\.fourth\)\)/)
  assert.match(js, /const idx = computed\(\(\) => tabIndex\(curTab\.value, tabs\.value\)\)/)
  assert.match(js, /indicatorPos\(idx\.value, sw\.mode === 'pager' \? sw\.shift : 0, sw\.width, pages\.value\)/)
  assert.match(js, /swipeTarget\(\{ index: idx\.value, dx, dt: Date\.now\(\) - t0, width, count: pages\.value \}\)/)
  assert.match(js, /pagerShift\(idx\.value, dx, pages\.value\)/)
  // 分頁順序：對話、夥伴、通知、設定，內頁在最後（蓋在 host 那一格上）
  const pos = ['<section class="m-pg" :class="nav.chat', '<section class="m-pg" aria-label="夥伴">', '<section class="m-pg m-chat m-notice" aria-label="通知">', '<section class="m-pg" aria-label="設定">', '<section class="m-pg m-fourth"'].map(x => html.indexOf(x))
  assert.ok(pos.every(p => p > 0), JSON.stringify(pos)); assert.deepEqual([...pos].sort((a, b) => a - b), pos, '順序：對話、夥伴、通知、設定、內頁')
  const fourth = html.slice(html.indexOf('<section class="m-pg m-fourth"'), html.indexOf('<!-- /內頁 -->'))
  assert.match(fourth, /^<section class="m-pg m-fourth" v-if="fourthPage && pageHost" :style="\{ '--host': tabs\.indexOf\(pageHost\) \}" :aria-label="fourthTitle">/)
  for (const k of ['acct', 'setting', 'guide', 'launch']) assert.match(fourth, new RegExp(`fourthPage\\.kind === '${k}'`))
  assert.match(css, /\.m-pg\.m-fourth\{position:absolute;top:0;bottom:0;left:calc\(var\(--host,0\) \* 100% \/ var\(--pages,4\)\);z-index:3;/, '內頁蓋在 host 那一格上，跟著 pager 一起滑')
  assert.match(css, /\.m-pager\{position:relative\}/)
  assert.doesNotMatch(html, /nav\.sheet === '(acct|setting|guide)'/)
  assert.doesNotMatch(html, /class="m-sheet m-(set|guide)"/)
  assert.doesNotMatch(html, /is-page|openNotice|NOTICE_ENTRY/, '設定裡不再有「看通知」入口（通知有自己的分頁）')
  // 對話分頁：不放內頁的東西
  const chat = html.slice(html.indexOf('<section class="m-pg" :class="nav.chat'), html.indexOf('<section class="m-pg" aria-label="夥伴">'))
  assert.match(chat, /aria-label="對話"/); assert.doesNotMatch(chat, /acctSw|m-keep|ACCT_PAGE_TITLE/)
  assert.doesNotMatch(js, /sheet !== 'acct'|sheet === 'acct'/, '已讀與提示判斷不再排除設備與帳號')
  assert.match(js, /isChatVisible: async id => document\.visibilityState === 'visible' && viewedChatId\(\{ tab: nav\.tab, chat: nav\.chat, lastChat: lastChat\.value \}\) === id/)
  // 計時：切走時排一個計時器；回到前景檢查
  assert.match(js, /fourthMsLeft\(/); assert.match(js, /visibilitychange[\s\S]{0,120}checkFourth\(\)|checkFourth\(\)[\s\S]{0,40}visibilitychange/)
  // 通知分頁：通知對話（唯讀，沒有輸入列），永遠在（不再被內頁取代）
  const notice = html.slice(html.indexOf('<section class="m-pg m-chat m-notice"'), html.indexOf('</section>', html.indexOf('<section class="m-pg m-chat m-notice"')))
  assert.match(notice, /^<section class="m-pg m-chat m-notice" aria-label="通知">/, '通知分頁不會被內頁取代（沒有 v-if）')
  assert.match(notice, /<chat-pane v-if="noticeChat" :friend="noticeChat"/); assert.doesNotMatch(notice, /@send|call-api|dict-api/)
  assert.match(js, /const noticeShown = computed\(\(\) => nav\.tab === 'notice' && !nav\.sheet && !!noticeChat\.value\)/)
  assert.match(js, /window\.addEventListener\('popstate', e => \{[\s\S]*?fourthNav\.onPop\(e\.state\)/)
})

test('從夥伴分頁點橫幅的「換班接手」：先退回對話分頁、進那一則，「⋯」選單的記錄等導覽結束才推（不會搶在前面）', async () => {
  const h = harness('list')
  assert.equal(h.r.openChat(), true)
  let opened = false
  const done = h.r.whenSettled().then(() => { opened = true; h.r.go(opsNav()) })
  await Promise.resolve()
  assert.equal(opened, false, '還在退記錄（popstate 還沒回來）時不能推選單')
  h.flush()
  await done
  assert.equal(h.nav.tab, 'chats'); assert.equal(h.nav.sheet, 'ops'); assert.equal(h.nav.chat, true)
  assert.deepEqual(h.stack(), [initialNav(), chatNav(), opsNav()], '選單蓋在那一則對話上；返回鍵先關選單、再回對話清單')
  h.press(); assert.equal(h.nav.sheet, ''); assert.equal(h.nav.chat, true)
  h.press(); assert.equal(h.nav.chat, false); assert.equal(h.nav.tab, 'chats')
  // 已經在對話分頁：不用等，立刻就能推
  const c = harness()
  c.r.openChat()
  let ok = false
  await c.r.whenSettled().then(() => { ok = true })
  assert.equal(ok, true); assert.deepEqual(c.stack(), [initialNav(), chatNav()])
  // 畫面接線：bannerHandover 等導覽結束才開選單
  const js = read('ui', 'm.js')
  assert.match(/async function bannerHandover\(\) \{([\s\S]*?)\n    \}\n/.exec(js)[1], /openChat\(b\.id\)\n\s*await fourthNav\.whenSettled\(\)[\s\S]*openOps\(\)/)
})

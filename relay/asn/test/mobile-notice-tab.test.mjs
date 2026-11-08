// 手機第四格「通知」（#895，PR-H）：預設顯示通知、內頁暫時佔用、3 分鐘到期與關閉都跳回通知、雲端金鑰 30 分鐘、舊狀態還原、未讀紅點。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { FOURTH_KEEP_MS, NOTICE_NEXT, PAGE_TAB, fourthView, guidePage, launchPage, needsLeaveAsk, openFourth, settingPage } from '../ui/lib/mobile-fourth.mjs'
import { createMobileNav, pageTitle } from '../ui/lib/mobile-nav.mjs'
import { TABS, chatsUnread, initialNav, noticeUnread, normalizeNav, pageNav, tabDot, tabLabel, tabNav, totalUnread, viewedChatId } from '../ui/lib/mobile.mjs'
import { restoreMobileTab } from '../ui/lib/session.mjs'
import { NOTICE_ID } from '../ui/lib/notice.mjs'

const CLOUD_KEEP = 30 * 60 * 1000

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
  const press = () => { history.back(); flush() }
  if (saved !== 'list') r.go(tabNav(saved))
  return { r, nav, st, clock, flush, press, depth: () => idx }
}

test('第四格預設就是「通知」：四個固定分頁、標題「通知」、沒有內頁', () => {
  assert.deepEqual(TABS, ['list', 'chats', 'me', PAGE_TAB])
  const h = harness('me')
  assert.equal(h.st.fourth, null)
  h.r.goTab(PAGE_TAB)
  assert.equal(h.nav.tab, PAGE_TAB); assert.equal(h.st.fourth, null, '沒有內頁'); assert.equal(fourthView(h.st.fourth), 'notice')
  assert.equal(tabLabel(PAGE_TAB, pageTitle(h.st.fourth?.page)), '通知')
  assert.deepEqual(h.r.state(), pageNav(null), '通知也佔一筆瀏覽記錄')
  assert.equal(h.r.depth(), 1)
  // 從通知切走再回來：不會冒出內頁，也沒有計時
  h.r.goTab('list'); h.flush()
  assert.equal(h.nav.tab, 'list'); assert.equal(h.st.fourth, null)
  h.clock.t += FOURTH_KEEP_MS * 10
  assert.equal(h.r.check(), false, '通知不會到期')
})

test('內頁暫時佔用第四格：標題換成內頁，3 分鐘沒回來跳回「通知」而不是消失', () => {
  const h = harness('me')
  assert.equal(h.r.openPage(settingPage('about')), true)
  assert.equal(fourthView(h.st.fourth), 'page'); assert.equal(tabLabel(PAGE_TAB, pageTitle(h.st.fourth.page)), '關於')
  h.r.goTab('list'); h.flush()
  h.clock.t += FOURTH_KEEP_MS - 1
  assert.equal(h.r.check(), false); assert.equal(fourthView(h.st.fourth), 'page', '未滿 3 分鐘還是內頁')
  h.clock.t += 1
  assert.equal(h.r.check(), true)
  assert.equal(h.st.fourth, null); assert.equal(fourthView(h.st.fourth), 'notice'); assert.equal(tabLabel(PAGE_TAB, ''), '通知')
  h.r.goTab(PAGE_TAB)
  assert.equal(h.nav.tab, PAGE_TAB, '到期後第四格仍可點，看到通知')
})

test('關閉內頁（關閉鈕、返回鍵退到頭）都回到通知，頁籤還在', () => {
  const h = harness('me')
  h.r.openPage(settingPage('about'))
  h.r.closePage(); h.flush()
  assert.equal(h.st.fourth, null); assert.equal(h.nav.tab, 'me'); assert.equal(fourthView(h.st.fourth), 'notice')
  h.r.openPage(guidePage('faq'))
  h.press(); assert.equal(h.nav.tab, PAGE_TAB, '指引單篇先退到篇目列表')
  h.press(); assert.equal(h.st.fourth, null); assert.equal(h.nav.tab, 'me')
  // 通知本身按返回：回到進來的分頁
  h.r.goTab(PAGE_TAB); assert.equal(h.nav.tab, PAGE_TAB)
  h.press(); assert.equal(h.nav.tab, 'me'); assert.equal(h.st.fourth, null)
})

test('雲端金鑰在畫面上時 30 分鐘才跳回通知（呼叫端給 keep）', () => {
  const h = harness('me')
  h.r.openPage(settingPage('cloud'))
  h.r.goTab('list'); h.flush()
  h.clock.t += FOURTH_KEEP_MS + 1000
  assert.equal(h.r.check(CLOUD_KEEP), false); assert.equal(fourthView(h.st.fourth), 'page')
  h.clock.t += CLOUD_KEEP
  assert.equal(h.r.check(CLOUD_KEEP), true); assert.equal(fourthView(h.st.fourth), 'notice')
})

test('「看通知」：沒有內頁時直接切到通知；內頁佔著時換掉它；已在通知就不動', () => {
  const h = harness('me')
  assert.equal(h.r.openNotice(), true)
  assert.equal(h.nav.tab, PAGE_TAB); assert.equal(h.st.fourth, null)
  assert.equal(h.r.openNotice(), true, '已在通知')
  h.press(); assert.equal(h.nav.tab, 'me')
  // 內頁佔著、人在設置分頁（切走了）
  h.r.openPage(settingPage('about')); h.r.goTab('me'); h.flush()
  assert.equal(fourthView(h.st.fourth), 'page')
  h.r.openNotice()
  assert.equal(h.nav.tab, PAGE_TAB); assert.equal(h.st.fourth, null, '內頁被通知取代')
  // 人就在內頁上按
  h.r.goTab('me'); h.flush()
  h.r.openPage(guidePage()); h.r.openNotice(); h.flush()
  assert.equal(h.nav.tab, PAGE_TAB); assert.equal(h.st.fourth, null)
})

test('換成通知也要走「離開前先問」：開新夥伴第 2 步還沒送出時問，其他不問', () => {
  const launching = openFourth(launchPage(2), 'me')
  assert.equal(needsLeaveAsk(launching, NOTICE_NEXT, { draft: true }), true)
  assert.equal(needsLeaveAsk(launching, NOTICE_NEXT, { draft: false }), false)
  assert.equal(needsLeaveAsk(openFourth(settingPage('about'), 'me'), NOTICE_NEXT, { draft: true }), false)
  assert.equal(needsLeaveAsk(null, NOTICE_NEXT, { draft: true }), false)
})

test('舊的存檔與瀏覽記錄不會壞：navTab 舊值照舊、page 還原成通知、壞資料落回合理的頁', () => {
  for (const old of ['list', 'chats', 'me']) assert.equal(restoreMobileTab(old), old)
  assert.equal(restoreMobileTab('page'), 'page', '存著第四格（通知）就回到通知')
  for (const bad of [undefined, null, 5, 'x', '']) assert.equal(restoreMobileTab(bad), 'list')
  assert.deepEqual(normalizeNav({ tab: 'page', sheet: '' }), pageNav(null))
  assert.deepEqual(normalizeNav({ tab: 'page', page: { kind: 'zzz' } }), pageNav(null))
  assert.deepEqual(normalizeNav({ tab: 'page', page: settingPage('about') }), pageNav(settingPage('about')))
  assert.deepEqual(normalizeNav({ tab: 'nope' }), initialNav())
  // 啟動時還原到第四格：沒有內頁就是通知，返回鍵回夥伴
  const h = harness('page')
  assert.equal(h.nav.tab, PAGE_TAB); assert.equal(h.st.fourth, null)
  h.press(); assert.equal(h.nav.tab, 'list')
})

test('設置裡的 notify 分類改叫「提醒」，沒有任何分類還叫「通知」', () => {
  assert.equal(pageTitle(settingPage('notify')), '提醒')
})

test('未讀紅點：通知有未讀第四格亮（內頁佔著也亮）；對話分頁的紅點不再算通知', () => {
  const friends = [{ id: 'a', unread: 2 }, { id: NOTICE_ID, isNotice: true, unread: 3 }, { id: 'b', unread: 0 }]
  assert.equal(noticeUnread(friends), 3); assert.equal(totalUnread(friends), 5); assert.equal(chatsUnread(friends), 2)
  assert.equal(tabDot(PAGE_TAB, { chats: 2, notice: 3 }), true)
  assert.equal(tabDot(PAGE_TAB, { chats: 2, notice: 0 }), false)
  assert.equal(tabDot('chats', { chats: 2, notice: 0 }), true); assert.equal(tabDot('chats', { chats: 0, notice: 3 }), false)
  assert.equal(tabDot('list', { chats: 9, notice: 9 }), false); assert.equal(tabDot('me', { chats: 9, notice: 9 }), false)
  assert.equal(noticeUnread([]), 0); assert.equal(noticeUnread(null), 0); assert.equal(noticeUnread([{ id: NOTICE_ID, isNotice: true, unread: -1 }]), 0)
  // 內頁佔著第四格時紅點判斷不受影響（只看未讀數）
  const fourth = openFourth(settingPage('about'), 'me')
  assert.equal(fourthView(fourth), 'page'); assert.equal(tabDot(PAGE_TAB, { notice: noticeUnread(friends) }), true)
})

test('正在看通知才算看得到、才標已讀：只有第四格沒有內頁時', () => {
  assert.equal(viewedChatId({ tab: PAGE_TAB, fourth: null, lastChat: 'x' }), NOTICE_ID)
  assert.equal(viewedChatId({ tab: PAGE_TAB, fourth: openFourth(guidePage(), 'me'), lastChat: 'x' }), '', '內頁佔著時看不到通知')
  assert.equal(viewedChatId({ tab: 'chats', fourth: null, lastChat: 'x' }), 'x')
  assert.equal(viewedChatId({ tab: 'list', fourth: null, lastChat: 'x' }), '')
  assert.equal(viewedChatId({ tab: 'me', fourth: null, lastChat: '' }), '')
})

test('冒煙情境：通知分頁六個（412、360、大字型 × 通知內容、紅點），探測表達式語法正確', async () => {
  const { SCENARIOS, MNOTICE_PROBES, mnoticeProbeSource } = await import('../scripts/smoke-lib.mjs')
  const vm = await import('node:vm')
  const names = SCENARIOS.filter(s => s.probe?.mnotice).map(s => s.name)
  assert.deepEqual(names, ['m-notice-tab', 'm-notice-tab-360', 'm-notice-tab-big', 'm-notice-dot', 'm-notice-dot-360', 'm-notice-dot-big'])
  for (const p of Object.values(MNOTICE_PROBES)) assert.doesNotThrow(() => new vm.Script(mnoticeProbeSource(p)))
})

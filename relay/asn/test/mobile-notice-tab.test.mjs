// 手機「通知」分頁（#895 PR-H；0.2.18 起是固定的第三格，不再和內頁共用一格）：永遠是通知、內頁不會取代它、雲端金鑰 30 分鐘、舊狀態還原、未讀紅點、看得到才標已讀。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { FOURTH_KEEP_MS, PAGE_TAB, guidePage, launchPage, needsLeaveAsk, openFourth, settingPage } from '../ui/lib/mobile-fourth.mjs'
import { createMobileNav, pageTitle } from '../ui/lib/mobile-nav.mjs'
import { HOME_TAB, TABS, chatsUnread, initialNav, noticeUnread, normalizeNav, pageNav, tabDot, tabLabel, tabNav, totalUnread, viewedChatId } from '../ui/lib/mobile.mjs'
import { restoreMobileTab } from '../ui/lib/session.mjs'
import { NOTICE_ID } from '../ui/lib/notice.mjs'
import { SETTING_CATS } from '../ui/lib/settings-cats.mjs'

const CLOUD_KEEP = 30 * 60 * 1000

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
  const press = () => { history.back(); flush() }
  if (saved !== HOME_TAB) r.go(tabNav(saved))
  return { r, nav, st, clock, flush, press, depth: () => idx }
}

test('「通知」是固定的第三格：四個分頁「對話／夥伴／通知／設定」，通知佔一筆瀏覽記錄、不會到期', () => {
  assert.deepEqual(TABS, ['chats', 'list', 'notice', 'me'])
  assert.equal(tabLabel('notice'), '通知')
  const h = harness('me')
  h.r.goTab('notice')
  assert.equal(h.nav.tab, 'notice'); assert.equal(h.st.fourth, null, '沒有內頁')
  assert.deepEqual(h.r.state(), { tab: 'notice', sheet: '', chat: false })
  // 從通知切走再回來：沒有計時
  h.r.goTab('list'); h.flush()
  assert.equal(h.nav.tab, 'list'); assert.equal(h.st.fourth, null)
  h.clock.t += FOURTH_KEEP_MS * 10
  assert.equal(h.r.check(), false, '通知不會到期')
  h.r.goTab('notice'); assert.equal(h.nav.tab, 'notice')
  h.press(); assert.equal(h.nav.tab, HOME_TAB, '通知按返回回對話清單（和其他分頁同一套規則）')
})

test('內頁不會取代通知：從設定打開內頁、3 分鐘到期，通知分頁一直都在', () => {
  const h = harness('me')
  assert.equal(h.r.openPage(settingPage('about')), true)
  assert.equal(pageTitle(h.st.fourth.page), '關於'); assert.equal(h.st.fourth.from, 'me', '蓋在設定上，不是通知那一格')
  h.r.goTab('notice'); h.flush()
  assert.equal(h.nav.tab, 'notice', '內頁開著時照樣能切到通知'); assert.ok(h.st.fourth, '內頁留著')
  h.clock.t += FOURTH_KEEP_MS - 1
  assert.equal(h.r.check(), false)
  h.clock.t += 1
  assert.equal(h.r.check(), true); assert.equal(h.st.fourth, null)
  assert.equal(h.nav.tab, 'notice', '收起內頁不影響正在看的通知')
})

test('關閉內頁（關閉鈕、返回鍵退到頭）都回到內頁底下的分頁', () => {
  const h = harness('me')
  h.r.openPage(settingPage('about'))
  h.r.closePage(); h.flush()
  assert.equal(h.st.fourth, null); assert.equal(h.nav.tab, 'me')
  h.r.openPage(guidePage('faq'))
  h.press(); assert.equal(h.nav.tab, PAGE_TAB, '指引單篇先退到篇目列表')
  h.press(); assert.equal(h.st.fourth, null); assert.equal(h.nav.tab, 'me')
})

test('雲端金鑰在畫面上時 30 分鐘才收起（呼叫端給 keep）', () => {
  const h = harness('me')
  h.r.openPage(settingPage('cloud'))
  h.r.goTab('list'); h.flush()
  h.clock.t += FOURTH_KEEP_MS + 1000
  assert.equal(h.r.check(CLOUD_KEEP), false); assert.ok(h.st.fourth)
  h.clock.t += CLOUD_KEEP
  assert.equal(h.r.check(CLOUD_KEEP), true); assert.equal(h.st.fourth, null)
})

test('離開前先問：開新夥伴第 2 步還沒送出時，換成別的內頁要問；切分頁（含通知）不問', () => {
  const launching = openFourth(launchPage(2), 'list')
  assert.equal(needsLeaveAsk(launching, settingPage('about'), { draft: true }), true)
  assert.equal(needsLeaveAsk(launching, settingPage('about'), { draft: false }), false)
  assert.equal(needsLeaveAsk(launching, launchPage(), { draft: true }), false, '再進開新夥伴接著填')
  assert.equal(needsLeaveAsk(launching, { kind: 'notice' }, { draft: true }), false, '通知不是內頁，切過去不問（內容保留 3 分鐘）')
  assert.equal(needsLeaveAsk(openFourth(settingPage('about'), 'me'), guidePage(), { draft: true }), false)
  assert.equal(needsLeaveAsk(null, guidePage(), { draft: true }), false)
  const h = harness('list')
  h.r.openPage(launchPage()); h.r.pushLayer(launchPage(2))
  h.r.goTab('notice'); h.flush()
  assert.equal(h.nav.tab, 'notice'); assert.deepEqual(h.st.fourth.page, launchPage(2), '開新夥伴的進度留著')
  h.r.goTab('list'); assert.equal(h.nav.tab, PAGE_TAB, '切回夥伴就回到開新夥伴第 2 步'); assert.deepEqual(h.st.fourth.page, launchPage(2))
})

test('舊的存檔與瀏覽記錄不會壞：navTab 舊值照舊、page（舊第四格）還原成通知、壞資料落回對話', () => {
  for (const old of ['list', 'chats', 'me', 'notice']) assert.equal(restoreMobileTab(old), old)
  assert.equal(restoreMobileTab('page'), 'notice', '存著舊第四格（通知）就回到通知分頁')
  for (const bad of [undefined, null, 5, 'x', '']) assert.equal(restoreMobileTab(bad), HOME_TAB)
  assert.deepEqual(normalizeNav({ tab: 'page', sheet: '' }), tabNav('notice'))
  assert.deepEqual(normalizeNav({ tab: 'page', page: { kind: 'zzz' } }), tabNav('notice'))
  assert.deepEqual(normalizeNav({ tab: 'page', page: settingPage('about') }), pageNav(settingPage('about')))
  assert.deepEqual(normalizeNav({ tab: 'nope' }), initialNav())
  // 啟動時還原到通知：返回鍵回對話清單
  const h = harness('notice')
  assert.equal(h.nav.tab, 'notice'); assert.equal(h.st.fourth, null)
  h.press(); assert.equal(h.nav.tab, HOME_TAB)
})

test('設定裡的 notify 分類改叫「提醒與聲音」（手機、電腦一樣），沒有任何分類還叫「通知」', () => {
  assert.equal(pageTitle(settingPage('notify')), '提醒與聲音')
  assert.ok(!SETTING_CATS.some(c => c.title === '通知'), '電腦版的設定分類也不叫「通知」')
})

test('未讀紅點：通知有未讀通知分頁亮（內頁開著也亮）；對話分頁的紅點不算通知', () => {
  const friends = [{ id: 'a', unread: 2 }, { id: NOTICE_ID, isNotice: true, unread: 3 }, { id: 'b', unread: 0 }]
  assert.equal(noticeUnread(friends), 3); assert.equal(totalUnread(friends), 5); assert.equal(chatsUnread(friends), 2)
  assert.equal(tabDot('notice', { chats: 2, notice: 3 }), true)
  assert.equal(tabDot('notice', { chats: 2, notice: 0 }), false)
  assert.equal(tabDot('chats', { chats: 2, notice: 0 }), true); assert.equal(tabDot('chats', { chats: 0, notice: 3 }), false)
  assert.equal(tabDot('list', { chats: 9, notice: 9 }), false); assert.equal(tabDot('me', { chats: 9, notice: 9 }), false)
  assert.equal(tabDot(PAGE_TAB, { chats: 9, notice: 9 }), false, '內頁不是分頁，沒有紅點')
  assert.equal(noticeUnread([]), 0); assert.equal(noticeUnread(null), 0); assert.equal(noticeUnread([{ id: NOTICE_ID, isNotice: true, unread: -1 }]), 0)
})

test('正在看才算看得到、才標已讀：通知分頁看的是通知；對話分頁要點進那一則', () => {
  assert.equal(viewedChatId({ tab: 'notice', chat: false, lastChat: 'x' }), NOTICE_ID)
  assert.equal(viewedChatId({ tab: PAGE_TAB, chat: false, lastChat: 'x' }), '', '內頁上看不到通知也看不到對話')
  assert.equal(viewedChatId({ tab: 'chats', chat: true, lastChat: 'x' }), 'x')
  assert.equal(viewedChatId({ tab: 'chats', chat: false, lastChat: 'x' }), '', '對話清單上不算正在看那一位')
  assert.equal(viewedChatId({ tab: 'list', chat: false, lastChat: 'x' }), '')
  assert.equal(viewedChatId({ tab: 'me', chat: false, lastChat: '' }), '')
})

test('冒煙情境：通知分頁六個（412、360、大字型 × 通知內容、紅點），探測表達式語法正確', async () => {
  const { SCENARIOS, MNOTICE_PROBES, mnoticeProbeSource } = await import('../scripts/smoke-lib.mjs')
  const vm = await import('node:vm')
  const names = SCENARIOS.filter(s => s.probe?.mnotice).map(s => s.name)
  assert.deepEqual(names, ['m-notice-tab', 'm-notice-tab-360', 'm-notice-tab-big', 'm-notice-dot', 'm-notice-dot-360', 'm-notice-dot-big'])
  for (const p of Object.values(MNOTICE_PROBES)) assert.doesNotThrow(() => new vm.Script(mnoticeProbeSource(p)))
})

test('冒煙情境：舊收發室列併進通知（#895 驗收）三個（412、360，與存檔最後開著舊收發室列的 412），探測表達式語法正確、資料有五個舊寄件人', async () => {
  const { SCENARIOS, MNOTICE_LEGACY_PROBES, mnoticeLegacyProbeSource, tableFor, probeKind } = await import('../scripts/smoke-lib.mjs')
  const vm = await import('node:vm')
  const sc = SCENARIOS.filter(s => s.probe?.mnoticeLegacy)
  assert.deepEqual(sc.map(s => s.name), ['m-notice-legacy', 'm-notice-legacy-360', 'm-notice-legacy-lastchat'])
  assert.deepEqual(sc.map(s => s.width ?? 412), [412, 360, 412])
  for (const p of Object.values(MNOTICE_LEGACY_PROBES)) assert.doesNotThrow(() => new vm.Script(mnoticeLegacyProbeSource(p)))
  assert.ok(!mnoticeLegacyProbeSource(MNOTICE_LEGACY_PROBES.list).includes(String.fromCharCode(92)), '探測腳本不寫反斜線')
  assert.equal(probeKind(sc[0].probe), '手機舊收發室列併進通知檢查')
  const chats = JSON.parse(tableFor(sc[0]).store_load.values.chats)
  assert.equal(chats.friends.length, 5)
  assert.ok(chats.friends.every(f => !f.kind && Object.keys(chats.logs).includes(f.id)), '舊列沒有 kind、各有信')
  assert.ok(chats.friends.every(f => f.agent === 'H-收發室' || f.agent.endsWith('收發室')))
})

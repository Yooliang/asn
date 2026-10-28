// 手機「開新夥伴」搬進第四頁籤（#461 第二張）：兩層返回、3 分鐘收起後背景照常開、第 2 步還沒送出時換內頁先問、帳號切換離開畫面後的結果提示。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { FOURTH_KEEP_MS, LEAVE_ASK_TEXT, PAGE_TAB, acctPage, guidePage, launchPage, needsLeaveAsk, normalizePage, openFourth, pageLayers, settingPage } from '../ui/lib/mobile-fourth.mjs'
import { createLeaveAsk, createMobileNav, pageTitle } from '../ui/lib/mobile-nav.mjs'
import { initialNav, normalizeNav, pageNav, tabNav } from '../ui/lib/mobile.mjs'
import { initialLaunch, launchInProgress } from '../ui/lib/mobile-launch.mjs'
import { acctResultToast } from '../ui/lib/mobile-acct.mjs'

const read = (...p) => fs.readFileSync(new URL(`../${p.join('/')}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n')

// 假的瀏覽記錄（與 mobile-fourth.test.mjs 同一種）：back／go 要等 flush 才觸發 popstate；afterPop＝m.js 裡監看 nav.sheet 的那一步
function harness(saved = 'list', afterPop = () => {}) {
  const clock = { t: 5_000_000 }
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
  const flush = () => { while (queue.length) { const d = queue.shift(); const to = Math.max(0, Math.min(entries.length - 1, idx + d)); if (to === idx) continue; idx = to; r.onPop(structuredClone(entries[idx].state)); afterPop() } }
  const press = () => { history.back(); flush() }
  if (saved !== 'list') r.go(tabNav(saved))
  return { r, nav, st, clock, flush, press, history, stack: () => entries.slice(0, idx + 1).map(e => e.state) }
}

test('內頁描述：開新夥伴兩步；第 2 步下面墊第 1 步；標題沿用「開新夥伴／設定這位夥伴」', () => {
  assert.deepEqual(launchPage(), { kind: 'launch', step: 1 }); assert.deepEqual(launchPage(2), { kind: 'launch', step: 2 }); assert.deepEqual(launchPage('2'), { kind: 'launch', step: 1 })
  assert.deepEqual(normalizePage({ kind: 'launch', step: 2 }), launchPage(2)); assert.deepEqual(normalizePage({ kind: 'launch', step: 7 }), launchPage())
  assert.deepEqual(pageLayers(launchPage(2)), [launchPage(), launchPage(2)])
  assert.deepEqual(pageLayers(launchPage()), [launchPage()])
  assert.equal(pageTitle(launchPage()), '開新夥伴'); assert.equal(pageTitle(launchPage(2)), '設定這位夥伴')
})

test('開新夥伴在第四頁籤出現；第 2 步按返回回第 1 步，第 1 步再返回就收起、回原本的頁籤', () => {
  const h = harness()
  assert.equal(h.r.openPage(launchPage()), true)   // 夥伴頁右上「＋」→「開新夥伴」
  assert.equal(h.nav.tab, PAGE_TAB); assert.deepEqual(h.st.fourth.page, launchPage()); assert.equal(h.st.fourth.from, 'list')
  h.r.pushLayer(launchPage(2))   // 下一步
  assert.deepEqual(h.stack(), [initialNav(), pageNav(launchPage()), pageNav(launchPage(2))])
  h.press(); assert.deepEqual(h.st.fourth.page, launchPage(), '回第 1 步'); assert.equal(h.nav.tab, PAGE_TAB)
  h.press(); assert.equal(h.st.fourth, null, '收起'); assert.equal(h.nav.tab, 'list')
  // 從設置分頁進來的（例如之後別的入口）也一樣回原頁籤
  const m = harness('me')
  m.r.openPage(launchPage()); m.r.pushLayer(launchPage(2)); m.press(); m.press()
  assert.equal(m.nav.tab, 'me'); assert.equal(m.st.fourth, null)
})

test('「關閉」一次收起兩步；「開始對話」收起後直接切到對話分頁', () => {
  const h = harness()
  h.r.openPage(launchPage()); h.r.pushLayer(launchPage(2))
  h.r.closePage(); h.flush()
  assert.equal(h.st.fourth, null); assert.equal(h.nav.tab, 'list'); assert.deepEqual(h.stack(), [initialNav()])
  const c = harness()
  c.r.openPage(launchPage()); c.r.pushLayer(launchPage(2))
  c.r.closePage('chats'); c.flush()
  assert.equal(c.st.fourth, null); assert.equal(c.nav.tab, 'chats'); assert.deepEqual(c.stack(), [initialNav(), tabNav('chats')], '返回鍵從對話回夥伴')
  const m = harness('me')
  m.r.openPage(launchPage()); m.r.closePage('chats'); m.flush()
  assert.equal(m.nav.tab, 'chats'); assert.deepEqual(m.stack(), [initialNav(), tabNav('chats')], '其他分頁之間互換不增加記錄')
})

test('3 分鐘到了收起、卸載畫面時，背景的開窗照常；再進「開新夥伴」接著顯示進度', () => {
  const h = harness()
  const lch = { ...initialLaunch(), phase: 'progress', vphase: 'opening', id: 'L1' }   // 已送出，還在開
  h.r.openPage(launchPage()); h.r.pushLayer(launchPage(2))
  h.r.goTab('me'); h.flush()
  h.clock.t += FOURTH_KEEP_MS
  assert.equal(h.r.check(), true); assert.equal(h.st.fourth, null, '畫面收起')
  assert.equal(launchInProgress(lch), true, '開窗的狀態不在第四頁籤裡，收起不影響')
  // 再進來：還在開就直接開第 1 層，畫面顯示進度（不是表單）
  h.r.openPage(launchPage())
  assert.deepEqual(h.st.fourth.page, launchPage()); assert.equal(h.nav.tab, PAGE_TAB)
  for (const v of ['done', 'failed']) assert.equal(launchInProgress({ ...lch, vphase: v }), false, `${v} 之後重新開始`)
  assert.equal(launchInProgress(initialLaunch()), false)
  // 接線：追蹤只看 lch.id，不看畫面；開好時只要不是正在看開新夥伴就跳橫幅；表單與進度由 lch.phase 決定
  const js = read('ui', 'm.js'), html = read('ui', 'm.html')
  const track = /async function trackLaunch\(t\) \{([\s\S]*?)\n    \}\n/.exec(js)[1]
  assert.match(track, /while \(lch\.id === t\.id && Date\.now\(\) < stop\)/)
  assert.doesNotMatch(track.replace(/if \(!\(nav\.tab === PAGE_TAB && fourthPage\.value\?\.kind === 'launch'\)\) banner\.value =/, ''), /fourth|nav\./, '追蹤不受第四頁籤影響')
  assert.match(track, /if \(!\(nav\.tab === PAGE_TAB && fourthPage\.value\?\.kind === 'launch'\)\) banner\.value =/)
  assert.match(js, /if \(launchInProgress\(lch\) \|\| \(isLaunch && lch\.phase === 'form'\)\) \{ if \(isLaunch\) goTab\(PAGE_TAB\); else fourthNav\.openPage\(launchPage\(\)\); return \}/, '還在開：接著顯示進度；還在填：接著填')
  const blk = html.slice(html.indexOf('<div class="m-pgin m-lch"'), html.indexOf('<!-- /第四頁籤 -->'))
  assert.match(blk, /v-if="lch\.phase === 'form' && !lchStep2"[\s\S]*v-else-if="lch\.phase === 'form'"[\s\S]*<template v-else>[\s\S]*lch\.text/)
})

test('第 2 步還沒送出時換別的內頁先問：選留下不換、選離開才換；換成開新夥伴自己、單純切頁都不問', () => {
  const f = openFourth(launchPage(2), 'list')
  assert.equal(needsLeaveAsk(f, settingPage('notify'), { draft: true }), true)
  assert.equal(needsLeaveAsk(f, acctPage(), { draft: true }), true)
  assert.equal(needsLeaveAsk(f, guidePage(), { draft: true }), true)
  assert.equal(needsLeaveAsk(f, launchPage(), { draft: true }), false, '再進開新夥伴＝接著填')
  assert.equal(needsLeaveAsk(f, settingPage('notify'), { draft: false }), false, '已送出或還在第 1 步不問')
  assert.equal(needsLeaveAsk(openFourth(guidePage(), 'me'), settingPage('me'), { draft: true }), false)
  assert.equal(needsLeaveAsk(null, settingPage('me'), { draft: true }), false)
  assert.equal(needsLeaveAsk(f, { kind: 'x' }, { draft: true }), false)
  assert.equal(LEAVE_ASK_TEXT.lead, '開新夥伴還沒送出，要離開嗎？')

  let leave = null
  const h = harness('list', () => leave.onSheet(h.nav.sheet))
  const lst = { ask: null }
  let draft = true
  leave = createLeaveAsk({ nav: h.nav, st: lst, go: n => h.r.go(n), back: () => h.history.back(), needs: next => needsLeaveAsk(h.st.fourth, next, { draft }) })
  h.r.openPage(launchPage()); h.r.pushLayer(launchPage(2))
  // 單純切到前三頁：不問，內容留著
  h.r.goTab('me'); h.flush()
  assert.equal(h.nav.tab, 'me'); assert.equal(h.nav.sheet, ''); assert.deepEqual(h.st.fourth.page, launchPage(2))
  // 在設置點「通知」：先問
  const open = () => h.r.openPage(settingPage('notify'))
  assert.equal(leave.ask(settingPage('notify'), open), 'asked')
  assert.equal(h.nav.sheet, 'leave'); assert.ok(lst.ask)
  assert.equal(leave.ask(guidePage(), () => {}), 'blocked', '問的時候不再疊一層')
  // 選留下：不換
  leave.answer(false); h.flush()
  assert.equal(h.nav.sheet, ''); assert.equal(lst.ask, null); assert.deepEqual(h.st.fourth.page, launchPage(2), '第四頁籤維持開新夥伴'); assert.equal(h.nav.tab, 'me')
  // 系統返回鍵＝留下
  leave.ask(settingPage('notify'), open); h.press()
  assert.deepEqual(h.st.fourth.page, launchPage(2)); assert.equal(h.nav.tab, 'me')
  // 選離開：才換
  leave.ask(settingPage('notify'), open)
  leave.answer(true); h.flush()
  assert.deepEqual(h.st.fourth.page, settingPage('notify')); assert.equal(h.nav.tab, PAGE_TAB); assert.equal(h.st.fourth.from, 'me')
  assert.deepEqual(h.stack(), [initialNav(), tabNav('me'), pageNav(settingPage('notify'))], '問的那一層沒留在記錄裡')
  // 不是草稿：直接換
  draft = false
  let ran = 0
  assert.equal(leave.ask(guidePage(), () => { ran++ }), 'ran'); assert.equal(ran, 1)
})

test('畫面接線：開新夥伴在第四頁籤裡、不再是滿版層；先問的浮層用「⋯」選單的樣式，不用瀏覽器的 confirm', () => {
  const html = read('ui', 'm.html'), js = read('ui', 'm.js')
  const fourth = html.slice(html.indexOf('<section class="m-pg m-fourth"'), html.indexOf('<!-- /第四頁籤 -->'))
  assert.match(fourth, /<div class="m-pgin m-lch" v-else-if="fourthPage\.kind === 'launch'">/)
  assert.match(fourth, /<div class="m-title">\{\{ lchTitle \}\}<\/div>/)
  assert.doesNotMatch(html, /nav\.sheet === 'launch'/)
  assert.match(js, /const lchStep2 = computed\(\(\) => fourthPage\.value\?\.kind === 'launch' && fourthPage\.value\.step === 2 && !!lch\.node && lch\.phase === 'form'\)/)
  assert.match(js, /fourthNav\.pushLayer\(launchPage\(2\)\)/, '下一步＝多一層')
  assert.match(js, /const closeLaunch = \(\) => fourthNav\.closePage\(\)/)
  assert.match(js, /fourthNav\.closePage\('chats'\)/, '開始對話：收起後直接到對話分頁')
  assert.doesNotMatch(js, /history\.go\(nav\.step|launchNav|nav\.step === 2/)
  const ask = /<div class="m-ops" v-if="nav\.sheet === 'leave' && leaveAsk"[\s\S]*?<\/div>/.exec(html)
  assert.ok(ask, '有先問的浮層'); assert.match(ask[0], /class="m-ops-panel"/); assert.match(ask[0], /answerLeave\(true\)/); assert.match(ask[0], /answerLeave\(false\)/); assert.match(ask[0], /LEAVE_ASK_TEXT\.lead/)
  assert.doesNotMatch(js, /\bconfirm\(/, '不用瀏覽器的 confirm（會擋住 WebView）')
  for (const k of ['settingPage(key)', 'guidePage()', 'acctPage()']) assert.ok(js.includes(`askBeforeLeave(${k}`), `${k} 走先問`)
  assert.match(js, /watch\(\(\) => nav\.sheet, s => leave\.onSheet\(s\)\)/)
})

test('帳號切換的結果提示：離開進行中的畫面後，完成或失敗都跳一句；還在畫面上就不跳', () => {
  assert.equal(acctResultToast({ phase: 'done', done: true, text: 'x' }, { label: '公司電腦', email: 'b@x.test' }), '公司電腦：已切換到 b@x.test 帳號')
  assert.equal(acctResultToast({ phase: 'failed', done: true, text: '對方拒絕了' }, { label: '公司電腦', email: 'b@x.test' }), '公司電腦：切換沒有成功：對方拒絕了')
  assert.equal(acctResultToast({ phase: 'failed', done: true, text: '' }, { email: 'b@x.test' }), '切換沒有成功：原因不明')
  assert.equal(acctResultToast({ phase: 'waiting', done: false, text: '' }, { email: 'b@x.test' }), '', '還沒結束（例如被新的切換取代）不跳')
  assert.equal(acctResultToast(null), '')
  const js = read('ui', 'm.js'), html = read('ui', 'm.html')
  const submit = /async function submitAcct\(\) \{([\s\S]*?)\n    \}\n/.exec(js)[1]
  assert.match(submit, /cancelled: \(\) => run !== acctRunSeq/, '離開畫面不停止等結果')
  assert.match(submit, /onUpdate: v => \{ if \(token === acctToken\) acctSw\.view = v \}/, '還在畫面上才更新畫面')
  assert.match(submit, /if \(run === acctRunSeq && \(token !== acctToken \|\| nav\.tab !== PAGE_TAB\)\) showToast\(acctResultToast\(v, \{ label, email \}\)\)/, '離開了（或切到別的分頁）才跳提示')
  assert.match(js, /if \(old\?\.kind === 'acct' && old\.node\) acctToken\+\+/, '細部退回列表＝離開進行中的畫面')
  assert.match(html, /<div class="m-toast" v-if="toast" role="status"[^>]*>\{\{ toast \}\}<\/div>/)
})

test('舊的 nav（sheet=launch、step）經 normalizeNav 轉成第四頁籤，不會壞', () => {
  assert.deepEqual(normalizeNav({ tab: 'list', sheet: 'launch' }), pageNav(launchPage()))
  assert.deepEqual(normalizeNav({ tab: 'list', sheet: 'launch', step: 2 }), pageNav(launchPage(2)))
  for (const step of [0, 3, '2', null, {}]) assert.deepEqual(normalizeNav({ sheet: 'launch', step }), pageNav(launchPage()), String(step))
  assert.deepEqual(normalizeNav(pageNav(launchPage(2))), pageNav(launchPage(2)))
  const h = harness()
  h.r.onPop({ tab: 'list', sheet: 'launch', step: 2 })
  assert.equal(h.nav.tab, PAGE_TAB); assert.deepEqual(h.st.fourth.page, launchPage(2))
  assert.equal(normalizeNav({ sheet: 'leave', tab: 'me' }).sheet, '', '先問的浮層不從記錄還原')
})

// 電腦版左側「通知」頁籤（方案 A）：分類只看 kind、清單排序與未讀、名單不再出現通知、通知內容一律純文字、舊存檔的通知分頁不還原
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { FIXED_TABS, TOP_TABS } from '../ui/lib/tabs.mjs'
import {
  NOTICE_CATS, NOTICE_CAT_ALL, NOTICE_CAT_ICON, NOTICE_CAT_LABEL, NOTICE_ID, NOTICE_TAB,
  filterNoticeRows, noticeCategory, noticeLines, noticeRest, noticeRows, noticeTime, noticeUnreadCount, withoutNoticeItems, withoutNoticeTabs,
} from '../ui/lib/notice.mjs'

const UI = new URL('../ui/', import.meta.url)
const read = f => fs.readFileSync(new URL(f, UI), 'utf8')

test('noticeCategory：只看 kind；卡住／登入／額度／安全，其餘與沒有 kind 歸其他', () => {
  const want = {
    'notice:inbox_watch': 'stuck', 'notice:waiting': 'stuck', 'notice:mux_down': 'stuck', 'notice:mux_blind': 'stuck', 'notice:misroute': 'stuck',
    'notice:login': 'login',
    'notice:quota': 'quota',
    'notice:view': 'security', 'notice:term_view': 'security', 'notice:device_key': 'security', 'notice:node_mismatch': 'security',
    'notice:bridge': 'other', 'notice:me': 'other', 'notice:': 'other', 'notice:toString': 'other', 'notice:__proto__': 'other',
  }
  for (const [k, c] of Object.entries(want)) assert.equal(noticeCategory(k), c, k)
  for (const k of [undefined, null, '', 'login', 'quota', 3, {}, 'chat:login']) assert.equal(noticeCategory(k), 'other', String(k))
})

test('分類標籤：全部／卡住／登入／額度／安全／其他，每個分類都有圖示', () => {
  assert.deepEqual(NOTICE_CATS.map(c => c.label), ['全部', '卡住', '登入', '額度', '安全', '其他'])
  assert.equal(NOTICE_CATS[0].key, NOTICE_CAT_ALL)
  for (const c of NOTICE_CATS.slice(1)) { assert.equal(NOTICE_CAT_LABEL[c.key], c.label); assert.equal(typeof NOTICE_CAT_ICON[c.key], 'string') }
})

test('noticeLines：第一個非空行是標題、第二個是摘要', () => {
  assert.deepEqual(noticeLines('\n標題\n\n摘要\n第三行'), { title: '標題', summary: '摘要' })
  assert.deepEqual(noticeLines('只有一行'), { title: '只有一行', summary: '' })
  assert.deepEqual(noticeLines(null), { title: '', summary: '' })
})

test('noticeRows：新的在前、只取收到的通知；最新 N 則未讀，點開過的不算；分類篩選', () => {
  const log = [
    { k: 'them', id: 'a', text: '舊的\n摘要一', t: 1, kind: 'notice:login' },
    { k: 'sys', text: '系統行', t: 2 },
    { k: 'them', id: 'b', text: '中間', t: 3, kind: 'notice:quota', dev: '辦公室' },
    { k: 'them', text: '沒有 id 也沒有 kind', t: 4 },
  ]
  const rows = noticeRows(log, { unread: 2 })
  assert.deepEqual(rows.map(r => r.title), ['沒有 id 也沒有 kind', '中間', '舊的'])
  assert.deepEqual(rows.map(r => r.cat), ['other', 'quota', 'login'])
  assert.deepEqual(rows.map(r => r.unread), [true, true, false])
  assert.equal(rows[1].dev, '辦公室')
  assert.equal(rows[2].summary, '摘要一')
  assert.equal(noticeUnreadCount(rows), 2)
  const opened = noticeRows(log, { unread: 2, opened: ['b'] })
  assert.deepEqual(opened.map(r => r.unread), [true, false, false])
  assert.deepEqual(filterNoticeRows(rows, 'quota').map(r => r.key), ['b'])
  assert.equal(filterNoticeRows(rows, NOTICE_CAT_ALL).length, 3)
  assert.equal(filterNoticeRows(rows, '亂寫').length, 3, '認不得的分類當全部')
  assert.deepEqual(noticeRows(null), [])
  assert.deepEqual(noticeRows(log, { unread: -3 }).map(r => r.unread), [false, false, false])
  assert.deepEqual(log.map(m => m.t), [1, 2, 3, 4], '不改傳入的記錄（順序不變）')
})

test('noticeRest：去掉標題那一行、保留其餘換行；hideDev 不顯示的設備名', () => {
  assert.equal(noticeRest('標題\n第二行\n\n第三行'), '第二行\n\n第三行')
  assert.equal(noticeRest('\n  標題\r\n第二行'), '第二行')
  assert.equal(noticeRest('只有標題'), '')
  assert.equal(noticeRest(undefined), '')
  const log = [{ k: 'them', id: 'a', text: 'x', t: 1, dev: '未命名設備' }, { k: 'them', id: 'b', text: 'y', t: 2, dev: '辦公室' }]
  assert.deepEqual(noticeRows(log, { hideDev: ['未命名設備'] }).map(r => r.dev), ['辦公室', ''])
})

test('noticeTime：今天只寫時:分，其他天加月/日；沒有時間是空字串', () => {
  const now = new Date(2026, 10, 10, 15, 0).getTime()
  assert.equal(noticeTime(new Date(2026, 10, 10, 9, 5).getTime(), now), '09:05')
  assert.equal(noticeTime(new Date(2026, 10, 9, 23, 30).getTime(), now), '11/9 23:30')
  assert.equal(noticeTime(0, now), '')
})

test('withoutNoticeItems：組裡拿掉通知對話；拿掉後才變空的組不列，本來就空的組照留', () => {
  const n = { id: NOTICE_ID, isNotice: true }
  const groups = [
    { key: 'a', items: [n] },
    { key: 'b', items: [{ id: 'P/x' }, n] },
    { key: 'self', items: [] },
  ]
  const out = withoutNoticeItems(groups)
  assert.deepEqual(out.map(g => [g.key, g.items.map(f => f.id)]), [['b', ['P/x']], ['self', []]])
  assert.equal(groups[1].items.length, 2, '不改傳入的組')
  assert.deepEqual(withoutNoticeItems(null), [])
})

test('withoutNoticeTabs：拿掉通知對話與通知內容分頁，其他照順序', () => {
  assert.deepEqual(withoutNoticeTabs(['P/a', NOTICE_ID, '@guide', NOTICE_TAB, 'room:g1']), ['P/a', '@guide', 'room:g1'])
  assert.deepEqual(withoutNoticeTabs(null), [])
})

test('守門：大分頁有「通知」（第三格，和手機一樣）；名單不再放通知組；通知內容用 {{ }} 不用 v-html', () => {
  assert.deepEqual(TOP_TABS[2], { key: 'notice', label: '通知' })
  assert.ok(FIXED_TABS.some(t => t.key === 'notice'))
  const js = read('list.js'), html = read('list.html'), css = read('style.css')
  assert.ok(!/withNoticeGroup/.test(js), '電腦版名單不再用 withNoticeGroup')
  assert.match(js, /withoutNoticeItems\(rosterShownGroups\(activeFriends\(friendsAct\.value\), o\)\)/, '名單（含搜尋）拿掉通知對話')
  assert.match(js, /archivedFriends\(friendsAct\.value\), o\)\.flatMap\(g => g\.items\)\.filter\(f => !isNoticeFriend\(f\)\)/, '已封存組也不放通知')
  assert.ok(!/g\.kind === 'notice'/.test(html), '名單樣板不再有通知組')
  // 通知清單與通知內容兩塊：不能有 v-html
  const list = html.slice(html.indexOf('<div class="list notice-list"'), html.indexOf('<div class="list guide-list"'))
  const pane = html.slice(html.indexOf('<div class="pane panel-pane notice-pane"'), html.indexOf('<div class="pane home-pane"'))
  for (const [name, part] of [['通知清單', list], ['通知內容', pane]]) {
    assert.ok(part.length > 100, `${name} 找得到`)
    assert.ok(!/v-html/.test(part), `${name} 不能用 v-html`)
  }
  assert.match(list, /\{\{ r\.title \}\}/)
  assert.match(list, /\{\{ r\.summary \}\}/)
  assert.match(pane, /\{\{ noticeSelRow\.rest \}\}/)
  assert.match(css, /\.notice-pane \.nt-body\{white-space:pre-wrap/)
  assert.match(html, /全部標為已讀/)
  assert.match(html, /'返回通知' : '返回名單'/, '窄視窗的返回鈕在通知內容時寫「通知」')
})

test('守門：通知不會變成一般對話分頁；存檔與還原都拿掉通知分頁', () => {
  const js = read('list.js')
  assert.match(js, /if \(id === NOTICE_ID \|\| id === NOTICE_TAB\) return openNoticeFromChat\(\)/, 'openChat 遇到通知改走通知頁籤')
  assert.match(js, /snapshotSession\(\{ tabs: withoutNoticeTabs\(ui\.tabs\)/, '存檔不存通知分頁')
  assert.match(js, /const saved = withoutNoticeTabs\(r\.tabs\)/, '還原時丟掉舊存檔的通知分頁')
  assert.match(js, /for \(const id of withoutNoticeTabs\(r\.windows\)\) await openChat\(id\)/, '分離模式還原也不自動開通知視窗')
  assert.match(js, /splitTabs\(withoutNoticeTabs\(ui\.tabs\)\)/, '切換視窗模式不帶通知')
  // 通知相關的程式不做遠端動作：openNoticeRow／markAllNotices 只開本機視窗、標已讀
  const block = js.slice(js.indexOf('const noticeView = reactive('), js.indexOf('async function openChat(id)'))
  assert.ok(block.length > 200)
  const invokes = [...block.matchAll(/invoke\('([a-z_]+)'/g)].map(m => m[1])
  assert.deepEqual([...new Set(invokes)].sort(), ['open_chat', 'show_main'])
  assert.ok(!/transport\./.test(block), '不呼叫後台')
})

test('「通知」分頁不能固定：右鍵選單不給「固定分頁」，就算叫到也不動', () => {
  const js = read('../ui/list.js')
  assert.match(js, /const chatTabMenuPanel = computed\(\(\) => isPanelTab\(chatTabMenu\.value\) \|\| chatTabMenu\.value === NOTICE_TAB\)/)
  assert.match(js, /const menuTogglePin = \(\) => runTabMenu\(id => \{ if \(id === NOTICE_TAB\) return;/)
  const html = read('../ui/list.html')
  assert.match(html, /<li v-if="!chatTabMenuPanel"><button type="button" role="menuitem" @click="menuTogglePin">/, '選單的固定分頁項目由 chatTabMenuPanel 決定')
})

test('正在看通知（左邊選著通知頁籤，或右邊開著通知內容）時，新通知不算未讀、不跳提示', () => {
  const js = read('../ui/list.js')
  assert.match(js, /const noticeOnScreen = \(\) => railTabNow\(\) === 'notice' \|\| \(ui\.mode === 'merged' && ui\.active === NOTICE_TAB\)/)
  assert.match(js, /const chatShownId = async id => \(id === NOTICE_ID && noticeOnScreen\(\) \? Boolean\(await invoke\('main_visible'\)\) : chatShown\(/)
  assert.match(js, /railTabNow = \(\) => shotTab\.value/)
})


// 指引、設定的聊天窗：跟好友的聊天窗同一套機制。
//   整合模式＝右邊分頁「指引：<標題>」「設定：<分類名>」，各最多一個、點另一項就換內容、可關閉、可拖曳、不可固定；
//   分離模式＝各一扇獨立視窗（panel.html），點另一項換內容、記住大小；設定的狀態留在名單視窗，跨視窗走 asn:* 事件。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { DEFAULT_PANEL_SIZE, MIN_PANEL_SIZE, PANEL_KINDS, isPanelTab, normalizePanelSize, panelItem, panelKindOf, panelTabId, panelTabItem, panelTitle, splitTabs } from '../ui/lib/panels.mjs'
import { GUIDES } from '../ui/lib/guides.mjs'
import { SETTING_CATS } from '../ui/lib/settings-cats.mjs'
import { closeAllChatTabs, closeChatTab, closeOtherChatTabs, moveChatTab, normalizePinned, openChatTab, orderTabs, toggleChatPin } from '../ui/lib/ctabs.mjs'

import { Window } from 'happy-dom'

const read = f => fs.readFileSync(new URL(`../${f}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n')

// #1763 T5：電腦端畫面檔（list.html、panel.html、style.css）改成「解析成 DOM 再查」，不再用正規表示式／indexOf 在原始碼字串裡找。
// 模板裡的 v-if／v-for／@click 等都是一般屬性，用選擇器可以直接查；樣式用 getComputedStyle 看實際算出的結果。
// （list.js、panel.js 是入口檔、Rust 是另一種語言，沒有東西可渲染，仍留字串守門。）
const loadDoc = (file) => {
  const win = new Window({ url: 'http://localhost/' })
  win.document.documentElement.innerHTML = read(file).replace(/^<!doctype[^>]*>/i, '')
  return { win, doc: win.document }
}

test('分頁 id：指引、設定各一個固定 id，不會撞到好友 id', () => {
  assert.deepEqual(PANEL_KINDS, ['guide', 'setting'])
  assert.equal(panelTabId('guide'), '@guide')
  assert.equal(panelTabId('setting'), '@setting')
  assert.equal(panelKindOf('@setting'), 'setting')
  assert.ok(isPanelTab('@guide') && isPanelTab('@setting'))
  for (const id of ['W/W-政策', '', 'guide', '@guide2', 'pending:x', '@']) assert.equal(isPanelTab(id), false, id)
})

test('標題：「指引：<標題>」「設定：<分類名>」；認不得的鍵只剩種類名', () => {
  assert.equal(panelTitle('guide', 'bridge'), `指引：${GUIDES[1].title}`)
  assert.equal(panelTitle('setting', 'look'), '設定：外觀')
  for (const g of GUIDES) assert.equal(panelTitle('guide', g.key), `指引：${g.title}`)
  for (const c of SETTING_CATS) assert.equal(panelTitle('setting', c.key), `設定：${c.title}`)
  assert.equal(panelTitle('guide', 'nope'), '指引')
  assert.equal(panelTitle('setting', ''), '設定')
  assert.equal(panelItem('guide', 'nope'), null)
  assert.equal(panelItem('other', 'look'), null)
  assert.deepEqual(panelTabItem('setting', 'voice'), { id: '@setting', panel: 'setting', nick: '設定：語音', status: '', unread: 0 })
})

test('整合模式：各最多一個分頁，點另一項是換內容（分頁不增加）並切過去', () => {
  // 樞紐的 openPanel：只換 ui.panel[kind]，分頁用 openChatTab（已開就只切過去）
  let st = { tabs: ['W/a'], active: 'W/a' }
  const panel = { guide: '', setting: '' }
  const open = (kind, key) => { panel[kind] = key; st = openChatTab(st, panelTabId(kind), []) }
  open('guide', 'start')
  assert.deepEqual(st, { tabs: ['W/a', '@guide'], active: '@guide' })
  open('guide', 'faq')
  assert.deepEqual(st, { tabs: ['W/a', '@guide'], active: '@guide' }, '再點另一篇＝換內容，不多開分頁')
  assert.equal(panelTabItem('guide', panel.guide).nick, `指引：${GUIDES.at(-1).title}`)
  open('setting', 'look')
  open('setting', 'notify')
  assert.deepEqual(st, { tabs: ['W/a', '@guide', '@setting'], active: '@setting' })
  assert.equal(panelTabItem('setting', panel.setting).nick, '設定：提醒與聲音')
  open('guide', 'bridge')
  assert.equal(st.active, '@guide', '點到另一種就切過去')
  assert.equal(st.tabs.length, 3)
})

test('整合模式：可關閉；關掉目前這個切到旁邊；關掉後再點會重新開', () => {
  let st = { tabs: ['W/a', '@guide', '@setting'], active: '@guide' }
  st = closeChatTab(st, '@guide')
  assert.deepEqual(st, { tabs: ['W/a', '@setting'], active: '@setting' })
  st = openChatTab(st, '@guide', [])
  assert.deepEqual(st, { tabs: ['W/a', '@setting', '@guide'], active: '@guide' })
  // 全部關閉、關閉其他也包含面板分頁
  assert.deepEqual(closeAllChatTabs(st, []), { tabs: [], active: '' })
  assert.deepEqual(closeOtherChatTabs(st, 'W/a', []).tabs, ['W/a'])
})

test('整合模式：不可固定（切換固定沒有效果、存檔裡的也丟掉），但可以拖曳排序', () => {
  const base = { tabs: ['W/a', '@guide', 'W/b'], active: 'W/a' }
  const r = toggleChatPin(base, '@guide', ['W/a'])
  assert.deepEqual(r.pinned, ['W/a'], '固定清單不收面板分頁')
  assert.deepEqual(r.tabs, ['W/a', '@guide', 'W/b'])
  assert.deepEqual(normalizePinned(['@guide', 'W/a', '@setting']), ['W/a'])
  // 拖曳：面板分頁在一般區，可以移到別的一般分頁前面／最後
  assert.deepEqual(moveChatTab(['W/a', 'W/b', '@guide'], [], '@guide', 'W/a').tabs, ['@guide', 'W/a', 'W/b'])
  assert.deepEqual(moveChatTab(['@guide', 'W/a', 'W/b'], [], '@guide', '').tabs, ['W/a', 'W/b', '@guide'])
  // 好友固定後排最前，面板分頁留在一般區
  assert.deepEqual(orderTabs(['@guide', 'W/a', 'W/b'], ['W/b']), ['W/b', '@guide', 'W/a'])
})

test('拆分頁：好友與面板分開（切模式時各走各的）', () => {
  assert.deepEqual(splitTabs(['W/a', '@setting', 'W/b', '@guide']), { chats: ['W/a', 'W/b'], panels: ['setting', 'guide'] })
  assert.deepEqual(splitTabs([]), { chats: [], panels: [] })
})

test('分離模式視窗大小：預設 480×560；壞值、太小、不是數字都退回預設；合理值取整', () => {
  assert.deepEqual(DEFAULT_PANEL_SIZE, { w: 480, h: 560 })
  assert.deepEqual(normalizePanelSize(undefined), DEFAULT_PANEL_SIZE)
  assert.deepEqual(normalizePanelSize({ w: 10, h: 10 }), DEFAULT_PANEL_SIZE)
  assert.deepEqual(normalizePanelSize({ w: 'a', h: 600 }), DEFAULT_PANEL_SIZE)
  assert.deepEqual(normalizePanelSize({ w: 99999, h: 600 }), DEFAULT_PANEL_SIZE)
  assert.deepEqual(normalizePanelSize({ w: MIN_PANEL_SIZE.w, h: MIN_PANEL_SIZE.h }), MIN_PANEL_SIZE)
  assert.deepEqual(normalizePanelSize({ w: 640.4, h: 700.6 }), { w: 640, h: 701 })
})

test('守門（樞紐）：openPanel 兩種模式都有、大小記在 asn-me.json、跨視窗走事件', () => {
  const hub = read('ui/list.js')
  assert.ok(/async function openPanel\(kind, key\)/.test(hub) && hub.includes('openChatTab(ui, panelTabId(kind), ui.pinnedChat)'), '整合＝開分頁')
  assert.ok(hub.includes('windowApi.openPanel(kind, panelTitle(kind, key), w, h)') && hub.includes("emit('asn:panel', { kind, key })"), '分離＝開視窗並換內容')
  assert.ok(hub.includes('guideSize: sizes.guide, settingSize: sizes.setting') && hub.includes('normalizePanelSize(savedMe.guideSize)'), '視窗大小存檔與讀回')
  assert.ok(hub.includes("c.op === 'panel-size'") && hub.includes("c.op !== 'panel-hello'"), '收視窗大小與 hello')
  // 設定一變就把快照推給設定視窗（只在分離模式）
  assert.ok(hub.includes("if (ui.mode === 'split') emit('asn:settings', settingsState.value)") && hub.includes('watch(settingsState, pushSettings, { deep: true })'))
  // 分頁列、右鍵選單
  const { doc } = loadDoc('ui/list.html')
  assert.ok(doc.querySelector('[v-for="t in tabItems"].ctab'), '分頁列一個分頁一格')
  const pin = doc.querySelector('[v-if="!chatTabMenuPanel"]')
  assert.ok(pin && pin.querySelector('button[role=menuitem]'), '面板分頁沒有「固定分頁」選項（固定鈕只在不是面板分頁時才顯示）')
  const tpl = doc.querySelector('template[v-for="k in PANEL_KINDS"]')
  assert.ok(tpl, '每種面板各一個窗格（v-for 走 PANEL_KINDS）')
  const pane = (tpl.content ?? tpl).querySelector('.pane.panel-pane')
  assert.ok(pane && pane.getAttribute('v-if').includes('ui.active === panelTabId(k)'), '每種面板各有一個窗格，只在它的分頁作用中時顯示')
  assert.ok(hub.includes('const mergedTabs = computed(() => tabItems.value.filter(t => !t.panel))'), '面板分頁沒有對話窗')
})

test('守門（獨立視窗）：panel.html／panel.js 有自訂外框、標題、可移動與調整大小，並回報大小', () => {
  const { doc } = loadDoc('ui/panel.html'), js = read('ui/panel.js')
  const bar = doc.querySelector('header.titlebar[data-tauri-drag-region]')
  assert.ok(bar, '自訂標題列可以拖')
  const btns = Object.fromEntries([...bar.querySelectorAll('button.tb')].map(b => [b.getAttribute('aria-label'), b.getAttribute('@click')]))
  assert.deepEqual(btns, { 最小化: "ctl('min')", 最大化: "ctl('max')", 關閉: "ctl('close')" }, '自訂標題列：最小化、最大化、關閉各一顆')
  const rz = doc.querySelector('i.rz[v-for="d in RESIZE_DIRS"]')
  assert.ok(rz && rz.getAttribute('@mousedown.left.prevent') === 'resizeFrom(d)', '拖邊緣調整大小')
  assert.ok(js.includes('await initFrame()'), '外框跟著設定（自訂／原生）')
  assert.ok(js.includes("emit('asn:set', { op: 'panel-size'") && js.includes("emit('asn:cmd', { op: 'panel-hello', kind })"))
  assert.ok(js.includes("eventHub.subscribe('asn:panel'") && js.includes("PANEL_KINDS.includes(q) ? q : 'guide'"))
  assert.equal(doc.querySelectorAll('[v-html]').length, 0, '不用 v-html')
})

test('守門（Rust）：open_panel／close_panels 有註冊、只認兩種視窗、外框設定與截圖涵蓋', () => {
  const lib = read('src-tauri/src/lib.rs'), wins = read('src-tauri/src/wins.rs')
  assert.ok(lib.includes('wins::open_panel') && lib.includes('wins::close_panels'))
  // #1863：panel.html 多一種「手機核對指紋時自動跳出的 QR Code」視窗，但只有指引、設定能變分頁、能由畫面叫開
  assert.ok(wins.includes('const PANEL_KINDS: [&str; 3] = ["guide", "setting", "fpshow"]'))
  assert.ok(wins.includes('const DOCKABLE_PANELS: [&str; 2] = ["guide", "setting"]'))
  assert.ok(/label == "list" \|\| label\.starts_with\("chat-"\) \|\| is_panel_label\(&label\)/.test(wins), '切換外框時指引、設定視窗也跟著改')
  assert.ok(wins.includes('panel.html?kind={kind}') && wins.includes('.min_inner_size(360.0, 320.0)'))
  assert.ok(wins.includes('.disable_drag_drop_handler()'))
  const caps = JSON.parse(read('src-tauri/capabilities/default.json'))
  assert.deepEqual(caps.windows, ['*'], '新視窗自動有事件與拖曳權限')
})

test('守門（樣式）：分頁圖示與面板版面的 CSS 都在', () => {
  const win = new Window({ url: 'http://localhost/' })
  const doc = win.document
  const style = doc.createElement('style'); style.textContent = read('ui/style.css'); doc.head.appendChild(style)
  doc.body.innerHTML = '<div class="pane panel-pane"></div><div class="ctab"><svg class="panel-ic"></svg></div><div class="pane"></div>'
  const pane = win.getComputedStyle(doc.querySelector('.pane.panel-pane'))
  assert.equal(pane.overflowY, 'auto', '面板窗格可以捲動')
  assert.equal(win.getComputedStyle(doc.querySelectorAll('.pane')[1]).overflowY === 'auto', false, '一般窗格不受影響（規則只套在 panel-pane）')
  const ic = win.getComputedStyle(doc.querySelector('.ctab .panel-ic'))
  assert.equal(ic.width, '14px', '分頁上的面板圖示有固定大小')
  assert.equal(ic.height, '14px')
})

test('「開始」頁籤只在完全沒有分頁時出現：開了設定或指引分頁也要收掉（跟開對話一樣）', async () => {
  const { doc } = loadDoc('ui/list.html')
  const homes = doc.querySelectorAll('.ctab.home')
  assert.equal(homes.length, 1)
  assert.equal(homes[0].getAttribute('v-if'), '!tabItems.length', '只在沒有任何分頁（對話、設定、指引都算）時出現')
})

// 整合模式與對話區外觀：視窗模式、對話分頁的開關、切模式的轉換、視窗大小記憶、
// 頭像模式（左／右／整合）、側欄收合、文字底色（透明／色彩／自動）的純邏輯。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { splitTabs } from '../ui/lib/panels.mjs'
import { DEFAULT_LOOK, DEFAULT_SIZE, closeTab, foldArrow, hasSideCol, isCollapsed, msgLayout, normalizeBubble, normalizeDpMode, normalizeLook, normalizeMode, normalizeSize, normalizeToolbar, openTab, paneClasses, sideOf, switchMode, tabVisible, toggleCollapsed } from '../ui/lib/merge.mjs'

const UI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'ui')

test('視窗模式：只有 merged 才是整合，其餘（含壞值）都是分離', () => {
  assert.equal(normalizeMode('merged'), 'merged')
  for (const v of ['split', '', null, undefined, 'MERGED', 3]) assert.equal(normalizeMode(v), 'split', String(v))
})

test('分頁：點好友開分頁並切過去；已開的不重複、只切過去；不改傳入物件', () => {
  const s0 = { tabs: [], active: '' }
  const s1 = openTab(s0, 'W/a')
  assert.deepEqual(s1, { tabs: ['W/a'], active: 'W/a' })
  assert.deepEqual(s0, { tabs: [], active: '' })
  const s2 = openTab(s1, 'W/b')
  assert.deepEqual(openTab(s2, 'W/a'), { tabs: ['W/a', 'W/b'], active: 'W/a' })
})

test('分頁：關目前分頁切到右邊、沒有右邊切左邊、全關光＝沒有目前分頁；關別的分頁不動目前分頁', () => {
  const st = { tabs: ['a', 'b', 'c'], active: 'b' }
  assert.deepEqual(closeTab(st, 'b'), { tabs: ['a', 'c'], active: 'c' })
  assert.deepEqual(closeTab({ tabs: ['a', 'b', 'c'], active: 'c' }, 'c'), { tabs: ['a', 'b'], active: 'b' })
  assert.deepEqual(closeTab(st, 'a'), { tabs: ['b', 'c'], active: 'b' })
  assert.deepEqual(closeTab({ tabs: ['a'], active: 'a' }, 'a'), { tabs: [], active: '' })
  assert.deepEqual(closeTab(st, 'zzz'), st)
})

test('整合視窗下對話看不看得到：要是目前分頁，而且主視窗開著沒最小化', () => {
  const st = { tabs: ['a', 'b'], active: 'a' }
  assert.equal(tabVisible(st, 'a', true), true)
  assert.equal(tabVisible(st, 'b', true), false, '背景分頁來信要算未讀')
  assert.equal(tabVisible(st, 'a', false), false, '主視窗最小化時要算未讀並提示')
  assert.equal(tabVisible(st, 'zzz', true), false)
})

test('切模式：分離→整合＝已開的對話視窗變分頁（最後一個當目前分頁）、視窗全關', () => {
  const r = switchMode('split', 'merged', { windowIds: ['W/a', 'W/b'] })
  assert.deepEqual(r, { tabs: ['W/a', 'W/b'], active: 'W/b', openWindows: [], closeWindows: ['W/a', 'W/b'] })
  assert.deepEqual(switchMode('split', 'merged', { windowIds: [] }), { tabs: [], active: '', openWindows: [], closeWindows: [] })
})

test('切模式：整合→分離＝每個分頁開成一扇視窗、分頁清空；同模式不動；來回一趟一個不少', () => {
  const r = switchMode('merged', 'split', { tabs: ['W/a', 'W/b'], active: 'W/a' })
  assert.deepEqual(r, { tabs: [], active: '', openWindows: ['W/a', 'W/b'], closeWindows: [] })
  assert.deepEqual(switchMode('merged', 'merged', { tabs: ['x'], active: 'x', windowIds: ['y'] }), { tabs: ['x'], active: 'x', openWindows: [], closeWindows: [] })
  const there = switchMode('split', 'merged', { windowIds: ['W/a', 'W/b'] })
  const back = switchMode('merged', 'split', there)
  assert.deepEqual(back.openWindows, ['W/a', 'W/b'])
})

test('切模式：指引、設定的分頁不是好友——先拆開，好友的對話照舊轉，面板另外轉成視窗或分頁', () => {
  const tabs = ['W/a', '@setting', 'W/b', '@guide']
  const { chats, panels } = splitTabs(tabs)
  assert.deepEqual(chats, ['W/a', 'W/b'])
  assert.deepEqual(panels, ['setting', 'guide'])
  const r = switchMode('merged', 'split', { tabs: chats, active: 'W/a' })
  assert.deepEqual(r.openWindows, ['W/a', 'W/b'], '面板分頁不會被當成好友開對話視窗')
  const back = switchMode('split', 'merged', { windowIds: ['W/a'] })
  assert.deepEqual(back.tabs, ['W/a'])
  const hub = fs.readFileSync(path.join(UI, 'list.js'), 'utf8')
  assert.ok(hub.includes("await invoke('close_panels')") && hub.includes('closedPanels.map(panelTabId)') && hub.includes('await openPanel(kind, ui.panel[kind])'), '樞紐切模式時也轉指引、設定')
})

test('視窗大小：整合視窗預設 900×640；存檔壞掉／太小／不是數字都退回預設；合理值照用並取整', () => {
  assert.deepEqual(DEFAULT_SIZE.merged, { w: 900, h: 640 })
  assert.deepEqual(normalizeSize(undefined, 'merged'), { w: 900, h: 640 })
  for (const bad of [{ w: 'x', h: 600 }, { w: 100, h: 100 }, { w: 99999, h: 700 }, { w: NaN, h: 700 }, null, 5]) assert.deepEqual(normalizeSize(bad, 'merged'), { w: 900, h: 640 }, JSON.stringify(bad))
  assert.deepEqual(normalizeSize({ w: 1100.4, h: 700.6 }, 'merged'), { w: 1100, h: 701 })
  assert.deepEqual(normalizeSize({ w: 400, h: 700 }, 'split'), { w: 400, h: 700 })
  assert.deepEqual(normalizeSize({ w: 400, h: 700 }, 'merged'), { w: 900, h: 640 }, '整合視窗窄於 720 的值不採用')
})

test('三個外觀設定的預設值：視窗模式分離、頭像模式左、文字底色透明、側欄展開；壞值一律退回預設', () => {
  assert.equal(normalizeMode(undefined), 'split')
  assert.deepEqual(DEFAULT_LOOK, { dpMode: 'left', bubble: 'none', collapsed: false, toolbar: 'top' })
  assert.deepEqual(normalizeLook(undefined), DEFAULT_LOOK)
  assert.deepEqual(normalizeLook({}), DEFAULT_LOOK)
  assert.deepEqual(normalizeLook({ dpMode: '壞', bubble: 3, dpCollapsed: 'yes', toolbar: 'x' }), DEFAULT_LOOK)
  for (const m of ['left', 'right', 'inline']) assert.equal(normalizeDpMode(m), m)
  for (const b of ['none', 'color', 'auto']) assert.equal(normalizeBubble(b), b)
})

test('三個設定存檔再讀回來不變、而且互相獨立（改一個不動另外兩個）', () => {
  const saved = { winMode: 'merged', dpMode: 'inline', bubble: 'auto', dpCollapsed: true }
  const back = JSON.parse(JSON.stringify(saved))
  assert.equal(normalizeMode(back.winMode), 'merged')
  assert.deepEqual(normalizeLook(back), { dpMode: 'inline', bubble: 'auto', collapsed: true, toolbar: 'top' })
  assert.deepEqual(normalizeLook({ ...back, toolbar: 'bottom' }).toolbar, 'bottom')
  assert.deepEqual(normalizeLook({ ...back, bubble: 'none' }), { dpMode: 'inline', bubble: 'none', collapsed: true, toolbar: 'top' })
  assert.equal(normalizeMode(back.winMode), 'merged', '視窗模式跟外觀設定沒有關係')
})

test('側欄：左右才有；整合（頭像在訊息旁）沒有側欄、也不會有收合', () => {
  assert.equal(hasSideCol('left'), true)
  assert.equal(hasSideCol('right'), true)
  assert.equal(hasSideCol('inline'), false)
  assert.equal(sideOf('right'), 'right')
  assert.equal(sideOf('left'), 'left')
  assert.equal(isCollapsed('left', true), true)
  assert.equal(isCollapsed('right', true), true)
  assert.equal(isCollapsed('right', false), false)
  assert.equal(isCollapsed('inline', true), false, '整合沒有收合箭頭，存檔裡的收合旗標不能讓版面壞掉')
})

test('收合狀態：切換、存檔讀回；切換不影響頭像模式（左右共用同一個收合旗標）', () => {
  assert.equal(toggleCollapsed(false), true)
  assert.equal(toggleCollapsed(true), false)
  assert.equal(toggleCollapsed(undefined), true)
  assert.deepEqual(normalizeLook({ dpMode: 'right', dpCollapsed: toggleCollapsed(false) }), { dpMode: 'right', bubble: 'none', collapsed: true, toolbar: 'top' })
})

test('收合箭頭：展開時指向欄所在的那一側、收起時指回中間（右欄 › ‹、左欄 ‹ ›）', () => {
  assert.equal(foldArrow('right', false), '›')
  assert.equal(foldArrow('right', true), '‹')
  assert.equal(foldArrow('left', false), '‹')
  assert.equal(foldArrow('left', true), '›')
})

test('版面類別：九種組合（頭像模式×文字底色）都有對應類別，收合只出現在側欄模式', () => {
  assert.deepEqual(paneClasses(DEFAULT_LOOK), ['dp-left', 'bub-none', 'tb-top'])
  assert.deepEqual(paneClasses({ dpMode: 'right', bubble: 'none', collapsed: true }), ['dp-right', 'bub-none', 'tb-top', 'dp-collapsed'])
  assert.deepEqual(paneClasses({ dpMode: 'left', bubble: 'auto' }), ['dp-left', 'bub-auto', 'tb-top'])
  assert.deepEqual(paneClasses({ dpMode: 'inline', bubble: 'none', toolbar: 'bottom' }), ['dp-inline', 'bub-none', 'tb-bottom'])
  assert.deepEqual(paneClasses({ dpMode: 'inline', bubble: 'auto', collapsed: true }), ['dp-inline', 'bub-auto', 'tb-top'], '整合不加收合類別')
  assert.deepEqual(paneClasses(undefined), ['dp-left', 'bub-none', 'tb-top'])
  const seen = new Set()
  for (const d of ['left', 'right', 'inline']) for (const b of ['none', 'color', 'auto']) for (const t of ['top', 'bottom']) seen.add(paneClasses({ dpMode: d, bubble: b, toolbar: t }).join(' '))
  assert.equal(seen.size, 18, '頭像模式×文字底色×工具列位置，十八種組合各有各的類別')
})

test('訊息排版：整合頭像時對方靠左帶頭像、自己靠右不帶頭像；其餘模式兩邊都靠左、都不帶頭像', () => {
  assert.deepEqual(msgLayout('them', { dpMode: 'inline', bubble: 'none' }), { align: 'left', avatar: true, tone: 'none' })
  assert.deepEqual(msgLayout('me', { dpMode: 'inline', bubble: 'none' }), { align: 'right', avatar: false, tone: 'none' })
  for (const d of ['left', 'right']) for (const k of ['me', 'them']) {
    const l = msgLayout(k, { dpMode: d, bubble: 'none' })
    assert.equal(l.align, 'left', `${d}/${k}`)
    assert.equal(l.avatar, false, `${d}/${k}`)
  }
})

test('訊息底色：透明＝無；色彩＝雙方同色；自動＝對方一色、自己一色（與頭像模式無關）', () => {
  for (const d of ['left', 'right', 'inline']) {
    assert.equal(msgLayout('them', { dpMode: d, bubble: 'none' }).tone, 'none')
    assert.equal(msgLayout('me', { dpMode: d, bubble: 'none' }).tone, 'none')
    assert.equal(msgLayout('them', { dpMode: d, bubble: 'color' }).tone, 'same')
    assert.equal(msgLayout('me', { dpMode: d, bubble: 'color' }).tone, 'same')
    assert.equal(msgLayout('them', { dpMode: d, bubble: 'auto' }).tone, 'them')
    assert.equal(msgLayout('me', { dpMode: d, bubble: 'auto' }).tone, 'me')
  }
  assert.deepEqual(msgLayout('me', { dpMode: 'inline', bubble: 'auto' }), { align: 'right', avatar: false, tone: 'me' })
  assert.deepEqual(msgLayout('them', { dpMode: 'left', bubble: 'auto' }), { align: 'left', avatar: false, tone: 'them' })
  assert.deepEqual(msgLayout('me', undefined), { align: 'left', avatar: false, tone: 'none' })
})

test('工具列位置：預設在輸入框上方；只有 top／bottom，壞值退回上方；與其他設定互相獨立', () => {
  assert.equal(normalizeToolbar(undefined), 'top')
  assert.equal(normalizeToolbar('bottom'), 'bottom')
  for (const v of ['', 'left', null, 1]) assert.equal(normalizeToolbar(v), 'top', String(v))
  assert.ok(paneClasses({ toolbar: 'bottom' }).includes('tb-bottom'))
  assert.ok(!paneClasses({ toolbar: 'bottom' }).includes('tb-top'))
  assert.deepEqual(normalizeLook({ dpMode: 'right', toolbar: 'bottom' }), { dpMode: 'right', bubble: 'none', collapsed: false, toolbar: 'bottom' })
})

// 守門：對話區元件真的用了這些純函式決定版面；樞紐有接上設定與分頁（拿掉就紅）
test('守門：元件依 paneClasses／msgLayout／foldArrow 排版；樞紐用 switchMode／tabVisible 並存三個設定', () => {
  const pane = fs.readFileSync(path.join(UI, 'lib', 'chatpane.mjs'), 'utf8')
  assert.ok(pane.includes('paneClasses({ dpMode: props.dpMode, bubble: props.bubble, collapsed: props.dpCollapsed, toolbar: props.toolbar })'))
  assert.ok(pane.includes('msgLayout(k, { dpMode: props.dpMode, bubble: props.bubble })'))
  assert.ok(pane.includes('foldBarArrow(side.value, collapsed.value)'))
  assert.ok(pane.includes('class="dp-fold-bar"'))
  assert.ok(pane.includes('dp-side-stack'))
  assert.ok(pane.includes("'tone-' + lay(m.k).tone"))
  // 工具列按鈕只有圖示：有中文 aria-label 與提示，圖示用內嵌 SVG；表情鈕本身就開表情選單（旁邊不另放 ▾，功能重複）
  for (const label of ['表情符號', '傳送震動']) assert.ok(pane.includes(`aria-label="${label}"`), `缺 aria-label ${label}`)
  assert.ok(!pane.includes('class="tool caret"') && !pane.includes('>▾</button>'), '表情鈕旁不放重複的 ▾')
  assert.ok(!/>\s*(🙂|〰)?\s*(表情符號|傳送震動)\s*</.test(pane), '工具列按鈕不該再有文字')
  const css = fs.readFileSync(path.join(UI, 'style.css'), 'utf8')
  assert.ok(css.includes('.dp-left .conv,.dp-left .compose-row{flex-direction:row-reverse}'))
  assert.ok(css.includes('.tb-bottom .compose-main{flex-direction:column-reverse}'))
  for (const t of ['tone-same', 'tone-me', 'tone-them']) assert.ok(css.includes('.m-body.' + t), `style.css 缺 ${t}`)
  const hub = fs.readFileSync(path.join(UI, 'list.js'), 'utf8')
  for (const k of ['switchMode(from, to', 'tabVisible(ui, id', 'toggleCollapsed(ui.collapsed)', 'closeChatTab(ui, id)', 'openChatTab(ui, id', 'pinnedChat', 'dpMode: ui.dpMode, bubble: ui.bubble, toolbar: ui.toolbar, dpCollapsed: ui.collapsed']) assert.ok(hub.includes(k), `list.js 缺 ${k}`)
  const htmlTab = fs.readFileSync(path.join(UI, 'list.html'), 'utf8')
  assert.ok(htmlTab.includes('@contextmenu.prevent="openChatTabMenu(t.id, $event)"'))
  // 選單不能放在 .tabbar 裡面（tabbar overflow:hidden 會把選單裁掉，右鍵看起來像沒反應）
  const fromBar = htmlTab.slice(htmlTab.indexOf('<div class="tabbar"'), htmlTab.indexOf('class="av-menu ctab-menu"'))
  const opens = (fromBar.match(/<div[\s>]/g) || []).length, closes = (fromBar.match(/<\/div>/g) || []).length
  assert.ok(closes >= opens, '分頁選單必須在 .tabbar 結束之後')
  assert.ok(/\.ctab-menu\{position:fixed/.test(fs.readFileSync(path.join(UI, 'style.css'), 'utf8')), '分頁選單要 position:fixed')
  assert.ok(/\.buddy-menu[\s\S]*position:fixed/.test(fs.readFileSync(path.join(UI, 'style.css'), 'utf8')), '名單右鍵選單要 position:fixed')
  assert.ok(!htmlTab.includes('g-launch') && !htmlTab.includes('開新夥伴…'), '組標題旁與右鍵不保留舊入口')
  assert.ok(htmlTab.includes('openLaunchPicker') && htmlTab.includes('search-ic'), '搜尋列旁要有開新夥伴')
  for (const label of ['關閉', '關閉其他', '關閉右側', '全部關閉']) assert.ok(htmlTab.includes(label), `list.html 缺 ${label}`)
  assert.ok(htmlTab.includes('menuTogglePin') && htmlTab.includes('tabPinLabel'))
  const html = fs.readFileSync(path.join(UI, 'list.html'), 'utf8')
  // 外觀設定的下拉在設定聊天窗的元件裡（整合模式的分頁與分離視窗共用），改了都經樞紐的 applySetting
  const setPanel = fs.readFileSync(path.join(UI, 'lib', 'settings-panel.mjs'), 'utf8')
  for (const k of ["act('dpMode'", "act('bubble'", "act('toolbar'", "act('mode'"]) assert.ok(setPanel.includes(k), `settings-panel.mjs 缺 ${k}`)
  for (const k of ["case 'dpMode': ui.dpMode = normalizeDpMode(value)", "case 'bubble': ui.bubble = normalizeBubble(value)", "case 'mode': await setMode(value)"]) assert.ok(hub.includes(k), `list.js 缺 ${k}`)
  assert.ok(html.includes('isChatTabPinned'))
})

test('分頁右鍵選單：按選單以外任何地方（pointerdown 捕獲）、Esc、視窗失焦都會收起', () => {
  const js = fs.readFileSync(path.join(UI, 'list.js'), 'utf8')
  assert.match(js, /addEventListener\('pointerdown'[\s\S]*closest\('\.ctab-menu'\)[\s\S]*closeChatTabMenu\(\)[\s\S]*true\)/)
  assert.match(js, /Escape' && chatTabMenu\.value\) closeChatTabMenu\(\)/)
  assert.match(js, /addEventListener\('blur'[\s\S]*closeChatTabMenu\(\)/)
})

// 守門：#60 改壞過——欄寬不夠把大頭貼裁一半、兩顆擠在最上面、收合鈕變成欄底小箭頭
test('守門：側欄寬度不小於大頭貼 xl 尺寸；對方在上、自己在下；橫條收合鈕在兩顆大頭貼之後；收起時仍可點', () => {
  const css = fs.readFileSync(path.join(UI, 'style.css'), 'utf8')
  const xl = Number(/\.dp\.xl\{width:(\d+)px/.exec(css)[1])
  const varXl = Number(/\.dp-side\{--dp-xl:(\d+)px/.exec(css)[1])
  assert.ok(varXl >= xl, '側欄大頭貼尺寸變數不得小於 xl')
  assert.ok(/\.dp-side\{[^}]*width:calc\(var\(--dp-xl\) \+ \d+px\)/.test(css), '側欄寬度要由 xl 尺寸算出')
  assert.ok(!/\.dp-side\{[^}]*;width:\d+px/.test(css), '側欄不得寫死像素寬度')
  assert.ok(/\.dp-side-stack\{[^}]*justify-content:space-between/.test(css), '兩顆大頭貼上下分開，不擠在最上面')
  assert.ok(/\.dp-fold-strip\{flex:1/.test(css), '收起時留一條整欄高的可點條')
  const pane = fs.readFileSync(path.join(UI, 'lib', 'chatpane.mjs'), 'utf8')
  const i = pane.indexOf('<aside class="dp-side"')
  const f = pane.indexOf("'st-' + friend.status", i), bar1 = pane.indexOf('class="dp-fold-bar"', f), m = pane.indexOf("'st-' + me.status", i), bar2 = pane.indexOf('class="dp-fold-bar"', m)
  assert.ok(i > 0 && f > i && bar1 > f && m > bar1 && bar2 > m, '順序：對方大頭貼、其下橫條、自己大頭貼、其下橫條')
  assert.ok(pane.includes('class="dp-fold-strip"'), '收起狀態要有可展開的條')
  assert.ok(/\.dp-grp\{[^}]*width:var\(--dp-xl\)/.test(css), '橫條與大頭貼同寬')
})

test('「點一下換大頭貼」提示不被左側頁籤與名單蓋住：.me 自成較高的堆疊層', () => {
  const css = fs.readFileSync(path.join(UI, 'style.css'), 'utf8')
  assert.match(css, /\.me\{position:relative;z-index:50;/)
})

test('換大頭貼只出現一個提示：有自訂 data-tip 就不再加原生 title', () => {
  const html = fs.readFileSync(path.join(UI, 'list.html'), 'utf8')
  const btn = html.split(/\r?\n/).find(l => l.includes('class="dp me-dp"'))
  assert.ok(btn.includes('data-tip="點一下換大頭貼"'))
  assert.ok(!/\stitle="/.test(btn), '不能同時有 title（會出現兩個提示）')
})

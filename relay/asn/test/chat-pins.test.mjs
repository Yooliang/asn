// 對話名單釘選（#1479，0.2.26）：純邏輯 ＋ 接線（讀檔 regex，照 repo 既有風格）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { EMPTY_PINS, MAX_PINS, PIN_LIMIT_TEXT, isPinned, mergePins, normalizePins, pinChat, pinMenuLabel, pinnedRows, renamedChatId, sortPinned, togglePin, unpinChat, validChatId } from '../ui/lib/chat-pins.mjs'
import { normalizePrefs } from '../ui/lib/mobile.mjs'
import { createRowPress, rowPressBind } from '../ui/lib/row-press.mjs'

const read = p => fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8')
const ids = list => list.map(x => x.id)
const pinAll = (names, t0 = 1000) => names.reduce((s, n, i) => pinChat(s, n, t0 + i).state, EMPTY_PINS)

// ---------- 釘選／取消 ----------
test('pin：加進 pins、記時間、rev 加一；原本的物件不被改動', () => {
  const r = pinChat(EMPTY_PINS, 'A/小幫手', 5000)
  assert.equal(r.ok, true)
  assert.deepEqual(r.state, { pins: [{ id: 'A/小幫手', at: 5000 }], unpinned: [], rev: 1 })
  assert.deepEqual(EMPTY_PINS, { pins: [], unpinned: [], rev: 0 }, '原物件不變')
  assert.notEqual(r.state, EMPTY_PINS)
})
test('pin：已經釘了＝原樣回，不重算時間、不加 rev', () => {
  const s = pinAll(['A/x'])
  const r = pinChat(s, 'A/x', 9999)
  assert.deepEqual(r.state, s)
})
test('unpin：從 pins 拿掉並留一筆取消紀錄；再釘一次會清掉那筆紀錄', () => {
  const s = unpinChat(pinAll(['A/x', 'A/y']), 'A/x', 3000)
  assert.deepEqual(ids(s.pins), ['A/y'])
  assert.deepEqual(s.unpinned, [{ id: 'A/x', at: 3000 }])
  assert.equal(s.rev, 3)
  const again = pinChat(s, 'A/x', 4000).state
  assert.deepEqual(again.unpinned, [])
  assert.equal(isPinned(again, 'A/x'), true)
})
test('isPinned／選單字：釘著寫「取消釘選」，沒釘寫「釘選」；壞 id 都當沒釘', () => {
  const s = pinAll(['A/x'])
  assert.equal(isPinned(s, 'A/x'), true)
  assert.equal(isPinned(s, 'A/z'), false)
  assert.equal(isPinned(s, ''), false)
  assert.equal(isPinned(null, 'A/x'), false)
  assert.equal(pinMenuLabel(s, 'A/x'), '取消釘選')
  assert.equal(pinMenuLabel(s, 'A/z'), '釘選')
})
test('togglePin：釘 → 取消 → 釘，回報按完之後是不是釘著', () => {
  const a = togglePin(EMPTY_PINS, 'room:r1', 100)
  assert.equal(a.pinned, true)
  const b = togglePin(a.state, 'room:r1', 200)
  assert.equal(b.pinned, false)
  assert.equal(isPinned(b.state, 'room:r1'), false)
  assert.equal(togglePin(b.state, 'room:r1', 300).pinned, true)
})

// ---------- 上限 50 ----------
test('上限 50：第 51 個拒絕、給看得懂的提示字，已釘的不動', () => {
  const names = Array.from({ length: MAX_PINS }, (_, i) => `N/夥伴${i}`)
  const full = pinAll(names)
  assert.equal(full.pins.length, 50)
  const r = pinChat(full, 'N/第五十一個', 99999)
  assert.equal(r.ok, false)
  assert.equal(r.text, PIN_LIMIT_TEXT)
  assert.match(r.text, /最多.*50/)
  assert.deepEqual(r.state, full)
  const t = togglePin(full, 'N/第五十一個')
  assert.equal(t.ok, false)
  assert.equal(t.text, PIN_LIMIT_TEXT)
  assert.equal(togglePin(full, 'N/夥伴3').ok, true, '滿了還是可以取消釘選')
})
test('normalize：存檔裡超過 50 個只留釘得最早的 50 個', () => {
  const pins = Array.from({ length: 60 }, (_, i) => ({ id: `N/${i}`, at: 1000 + i }))
  const s = normalizePins({ pins, unpinned: [], rev: 1 })
  assert.equal(s.pins.length, 50)
  assert.equal(s.pins[0].id, 'N/0')
  assert.equal(s.pins[49].id, 'N/49')
})

// ---------- 排序 ----------
test('sortPinned：釘選的在最上面、依釘選時間由舊到新，其餘維持原順序', () => {
  const rows = ['a', 'b', 'c', 'd', 'e'].map(id => ({ id }))
  let s = pinChat(EMPTY_PINS, 'd', 100).state
  s = pinChat(s, 'b', 200).state
  s = pinChat(s, 'e', 150).state
  assert.deepEqual(ids(sortPinned(rows, s)), ['d', 'e', 'b', 'a', 'c'])
  assert.deepEqual(ids(pinnedRows(rows, s)), ['d', 'e', 'b'])
  assert.deepEqual(ids(rows), ['a', 'b', 'c', 'd', 'e'], '傳進來的陣列不被改')
})
test('sortPinned：釘了但不在名單上的略過；沒釘任何東西＝原順序；可指定怎麼取位址', () => {
  const rows = [{ chatId: 'x' }, { chatId: 'y' }]
  assert.deepEqual(sortPinned(rows, pinAll(['gone']), r => r.chatId), rows)
  assert.deepEqual(sortPinned(rows, pinAll(['y']), r => r.chatId).map(r => r.chatId), ['y', 'x'])
  assert.deepEqual(sortPinned(null, EMPTY_PINS), [])
})

// ---------- 合併 ----------
test('merge：同一個 id 看誰的時間新；pin 較新釘選贏、unpin 較新取消贏', () => {
  const a = { pins: [{ id: 'A/x', at: 200 }], unpinned: [], rev: 2 }
  const b = { pins: [], unpinned: [{ id: 'A/x', at: 100 }], rev: 5 }
  assert.equal(isPinned(mergePins(a, b), 'A/x'), true)
  const c = { pins: [{ id: 'A/x', at: 100 }], unpinned: [], rev: 1 }
  const d = { pins: [], unpinned: [{ id: 'A/x', at: 300 }], rev: 1 }
  const m = mergePins(c, d)
  assert.equal(isPinned(m, 'A/x'), false)
  assert.deepEqual(m.unpinned, [{ id: 'A/x', at: 300 }])
})
test('merge：同一個 id 的 pin 與 unpin 時間相同，釘選勝（兩個方向都一樣）', () => {
  const a = { pins: [{ id: 'A/x', at: 500 }], unpinned: [], rev: 1 }
  const b = { pins: [], unpinned: [{ id: 'A/x', at: 500 }], rev: 1 }
  for (const m of [mergePins(a, b), mergePins(b, a)]) {
    assert.equal(isPinned(m, 'A/x'), true)
    assert.deepEqual(m.unpinned, [])
  }
  assert.equal(isPinned(normalizePins({ pins: [{ id: 'A/x', at: 500 }], unpinned: [{ id: 'A/x', at: 500 }] }), 'A/x'), true, 'normalize 也是同一條規則')
})
test('merge：兩邊各自釘的都留；rev 取較大的再加一；不改原物件', () => {
  const a = { pins: [{ id: 'A/x', at: 100 }], unpinned: [], rev: 3 }
  const b = { pins: [{ id: 'A/y', at: 50 }], unpinned: [], rev: 7 }
  const m = mergePins(a, b)
  assert.deepEqual(ids(m.pins), ['A/y', 'A/x'], '依釘選時間由舊到新')
  assert.equal(m.rev, 8)
  assert.equal(a.rev, 3)
})

// ---------- 改名 ----------
test('改名：舊位址的釘選搬到新位址，釘選時間不變，舊位址留取消紀錄', () => {
  let s = pinAll(['A/舊 名字', 'A/別人'], 100)
  s = renamedChatId(s, 'A/舊 名字', 'A/新名字', 900)
  assert.equal(isPinned(s, 'A/舊 名字'), false)
  assert.deepEqual(s.pins.find(p => p.id === 'A/新名字'), { id: 'A/新名字', at: 100 })
  assert.deepEqual(ids(sortPinned([{ id: 'A/別人' }, { id: 'A/新名字' }], s)), ['A/新名字', 'A/別人'], '還是排在原本的位置')
  assert.deepEqual(s.unpinned, [{ id: 'A/舊 名字', at: 900 }])
})
test('改名：舊的沒釘、新舊相同、新位址壞掉，都原樣不動', () => {
  const s = pinAll(['A/x'])
  assert.deepEqual(renamedChatId(s, 'A/沒釘', 'A/新'), s)
  assert.deepEqual(renamedChatId(s, 'A/x', 'A/x'), s)
  assert.deepEqual(renamedChatId(s, 'A/x', ''), s)
})

// ---------- 對話位址 ----------
test('對話位址：節點/視窗名可含中文與空白、群組是 room:代號；只擋空、控制字元、過長', () => {
  for (const id of ['node-1/我的 夥伴', 'room:6f2a', 'N/名字 有 空白', '機/視窗（前景）', 'N/ａｂｃ #12']) assert.equal(validChatId(id), true, id)
  for (const id of ['', 'a\nb', 'a\u0000b', 'x'.repeat(201), null, 5, undefined]) assert.equal(validChatId(id), false, String(id))
  assert.equal(pinChat(EMPTY_PINS, '', 1).ok, false)
})

// ---------- 容錯 ----------
test('normalize：壞資料、重複 id、不合法的時間都容錯', () => {
  assert.deepEqual(normalizePins(undefined), { pins: [], unpinned: [], rev: 0 })
  assert.deepEqual(normalizePins('壞掉'), { pins: [], unpinned: [], rev: 0 })
  assert.deepEqual(normalizePins([]), { pins: [], unpinned: [], rev: 0 })
  const s = normalizePins({
    pins: [{ id: 'A/x', at: 100 }, { id: 'A/x', at: 300 }, { id: 'A/y', at: 'x' }, { id: 'A/z', at: -5 }, { id: 'A/w', at: NaN }, { id: '', at: 1 }, null, 7, { at: 1 }, { id: 'A/ok', at: 50.9 }],
    unpinned: 'not an array',
    rev: -3,
  })
  assert.deepEqual(s.pins, [{ id: 'A/ok', at: 50 }, { id: 'A/x', at: 300 }], '重複留較新的、壞的丟掉、小數捨去')
  assert.equal(s.rev, 0)
  assert.equal(normalizePins({ pins: [], rev: 2.5 }).rev, 0)
  assert.deepEqual(normalizePins(s), s, '再整理一次不變（冪等）')
})
test('normalize：取消紀錄只留最近 200 筆', () => {
  const unpinned = Array.from({ length: 250 }, (_, i) => ({ id: `N/${i}`, at: 1000 + i }))
  const s = normalizePins({ pins: [], unpinned, rev: 1 })
  assert.equal(s.unpinned.length, 200)
  assert.equal(s.unpinned[0].id, 'N/249')
})

// ---------- 手機本機設定 ----------
test('手機 mobilePrefs：chatPins 讀回來會整理，舊存檔沒有就是空的', () => {
  assert.deepEqual(normalizePrefs({}).chatPins, EMPTY_PINS)
  assert.deepEqual(normalizePrefs({ chatPins: { pins: [{ id: 'A/x', at: 10 }, { id: 'bad', at: 'q' }] } }).chatPins.pins, [{ id: 'A/x', at: 10 }])
})

// ---------- 長按 ----------
function fakeTimers() {
  let t = 0
  let seq = 0
  const jobs = new Map()
  return {
    setTimer: (f, ms) => { jobs.set(++seq, { f, at: t + ms }); return seq },
    clearTimer: id => jobs.delete(id),
    now: () => t,
    advance(ms) { t += ms; for (const [k, j] of [...jobs]) if (j.at <= t) { jobs.delete(k); j.f() } },
  }
}
test('長按：按滿半秒才叫選單；手指移太遠、提早放開都不叫', () => {
  const clk = fakeTimers()
  const hits = []
  const p = createRowPress({ ...clk, onLong: id => hits.push(id) })
  p.down('A/x', { pointerType: 'touch', clientX: 10, clientY: 10 }); clk.advance(300); p.up(); clk.advance(500)
  assert.deepEqual(hits, [])
  p.down('A/x', { pointerType: 'touch', clientX: 10, clientY: 10 }); clk.advance(200); p.move({ clientX: 10, clientY: 60 }); clk.advance(500)
  assert.deepEqual(hits, [], '要捲動了就不算長按')
  p.down('A/x', { pointerType: 'touch', clientX: 10, clientY: 10 }); p.move({ clientX: 13, clientY: 12 }); clk.advance(500)
  assert.deepEqual(hits, ['A/x'])
})
test('長按：滑鼠不算；觸發後那一下 click 要吞掉；系統的 contextmenu 不會重複開', () => {
  const clk = fakeTimers()
  const hits = []
  const p = createRowPress({ ...clk, onLong: id => hits.push(id) })
  p.down('A/x', { pointerType: 'mouse' }); clk.advance(900)
  assert.deepEqual(hits, [])
  assert.equal(p.swallowClick(), false)
  p.down('A/x', { pointerType: 'touch' }); clk.advance(500)
  assert.deepEqual(hits, ['A/x'])
  p.menu('A/x')
  assert.equal(hits.length, 1, '同一次長按只開一次')
  assert.equal(p.swallowClick(), true)
  clk.advance(3000); p.up()
  assert.equal(p.swallowClick(), true, '按很久才放開，放開後的 click 還是吞掉')
  clk.advance(1000)
  assert.equal(p.swallowClick(), false, '過了就恢復正常點擊')
  p.menu('B/y')
  assert.deepEqual(hits, ['A/x', 'B/y'], '系統直接送 contextmenu 也能開')
})
test('長按：v-bind 用的事件組含 pointer 與 contextmenu，contextmenu 會擋掉系統選單', () => {
  const clk = fakeTimers()
  const hits = []
  const b = rowPressBind(createRowPress({ ...clk, onLong: id => hits.push(id) }), 'room:g1')
  for (const k of ['onPointerdown', 'onPointermove', 'onPointerup', 'onPointercancel', 'onPointerleave', 'onContextmenu', 'onClickCapture']) assert.equal(typeof b[k], 'function', k)
  let prevented = false
  b.onContextmenu({ preventDefault: () => { prevented = true } })
  assert.equal(prevented, true)
  assert.deepEqual(hits, ['room:g1'])
})

// ---------- 接線（讀檔檢查）----------
test('接線：電腦版對話名單依釘選排序、右鍵一對一與群組都有選單、存進 asn-me.json 的 chatPins', () => {
  const js = read('ui/list.js')
  const html = read('ui/list.html')
  assert.match(js, /normalizePins\(savedMe\.chatPins\)/)
  assert.match(js, /chatPins: chatPins\.value/, '存進 asn-me.json')
  assert.match(js, /const pinnedExtra = computed/, '沒有近期往來的釘選照樣列出')
  assert.match(js, /sortPinned\(\[\.\.\.chatRows\.value, \.\.\.pinnedExtra\.value\], chatPins\.value\)/)
  assert.match(js, /pinnedTargets\(chatPins\.value/, '釘選對得到的對話（含群組）從夥伴與群組清單補')
  assert.doesNotMatch(js, /unpinChat\(chatPins/, '找不到的對話不動釘選紀錄')
  assert.match(js, /groupMenuItems\(\{ room: true \}\)/, '群組那三項')
  assert.match(js, /renamedPinId\(chatPins\.value/, '改名後釘選跟著搬')
  assert.match(html, /v-for="x in chatRowsPinned"/)
  assert.match(html, /openRoomMenu\(x\.room, \$event\)/, '群組列原本沒有右鍵選單')
  assert.match(html, /menu-title[^<]*>\{\{ buddyMenuTitle \}\}/, '選單最上面是名稱')
  assert.match(html, /buddyMenuTogglePin/)
  assert.match(html, /:pinned="isChatPinned\(x\.id\)"/)
  assert.match(html, /<pin-dot v-if="isChatPinned\(x\.id\)">/, '群組頭像也有徽章')
})
test('接線：手機版釘選存 mobilePrefs、最上面多一組「釘選」、三種列都能長按、選單沿用 opsRows', () => {
  const js = read('ui/m.js')
  const html = read('ui/m.html')
  assert.match(js, /prefs\.chatPins = r\.state/)
  assert.match(js, /buildPartnerMenu\(opsFriend\.value, opsCtx\.value, 'phone'\)/)
  assert.match(js, /renamedPinId\(prefs\.chatPins/)
  assert.equal((html.match(/v-bind="rowPressOf\(/g) ?? []).length, 3, '釘選／未讀、群組、設備分組三種列')
  assert.match(html, /v-for="grp in topGroups"/)
  assert.match(html, /v-if="opsTargetId"[^>]*@click="pickPin"/)
  assert.match(html, /:pinned="isChatPinned\(c\.id\)"/)
})
test('接線：徽章三種外觀都有樣式，徽章元件兩個頁面都註冊', () => {
  assert.match(read('ui/style.css'), /\.pin-dot\{[^}]*background:#2f7fe0/)
  assert.match(read('ui/modern.css'), /data-skin="modern"\] \.avb-v~\.pin-dot/)
  assert.match(read('ui/line.css'), /data-skin="line"\] \.avb-v~\.pin-dot/)
  assert.match(read('ui/list.js'), /app\.component\('pin-dot', PinDot\)/)
  assert.match(read('ui/m.js'), /app\.component\('pin-dot', PinDot\)/)
  assert.match(read('ui/lib/avatar-badge.mjs'), /<pin-dot v-if="pinned">/)
})

// 終端畫面往上看更早的內容（#904 B3）：狀態機、歷史畫面組法、捲動位置公式、接線守門
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { HISTORY_COOLDOWN_MS, HISTORY_LINES, atBottom, createHistory, historyScrollTop, historyToWrite, scrollWantsHistory, wheelWantsHistory } from '../ui/lib/term-history.mjs'
import { createTermViewSession, frameToWrite, latestVisible } from '../ui/lib/term-view.mjs'

const SRC = name => fs.readFileSync(new URL('../ui/lib/' + name, import.meta.url), 'utf8')
/** 人編的歷史文字：hist 行歷史＋rows 行畫面，每列 CRLF，整份最後多一個裸換行（--escapes 的形式） */
const makeText = (hist, rows) => {
  const lines = []
  for (let i = 0; i < hist; i++) lines.push(`歷史${i + 1}`)
  for (let i = 0; i < rows; i++) lines.push(`畫面${i + 1}`)
  return lines.join('\r\n') + '\r\n\n'
}
const M = (o = {}) => ({ cursor_x: 3, cursor_y: 4, cols: 120, rows: 40, ...o })
const parse = out => {
  const head = '\x1b[0m\x1b[H\x1b[2J'
  assert.ok(out.startsWith(head))
  const k = out.lastIndexOf('\x1b[0m\x1b[')
  const m = /^\x1b\[0m\x1b\[(\d+);(\d+)H$/.exec(out.slice(k))
  assert.ok(m)
  return { lines: out.slice(head.length, k).split('\r\n'), row: Number(m[1]) - 1, col: Number(m[2]) - 1 }
}
const wait = () => new Promise(res => setTimeout(res, 5))

// ---- historyToWrite ----
test('200 行歷史＋40 行畫面：歷史行數、總列數、游標列＝cursor_y＋歷史行數', () => {
  const r = historyToWrite(makeText(200, 40), M({ cursor_y: 4 }))
  assert.equal(r.histCount, 200)
  assert.equal(r.totalRows, 240)
  const p = parse(r.data)
  assert.equal(p.lines.length, 240)
  assert.equal(p.lines[204], '畫面5', '游標那一列的文字就是畫面第 5 行')
  assert.equal(p.row, 204)
  assert.equal(p.col, 3)
  assert.equal(p.lines[0], '歷史1')
})

test('實測形狀：捲動紀錄夠長時總行數是 lines＋rows＋2，多出來的 2 行算歷史', () => {
  const r = historyToWrite(makeText(202, 40), M())
  assert.equal(r.histCount, 202)
  assert.equal(r.totalRows, 242)
})

test('沒有歷史（行數剛好＝rows）：histCount 0、游標列不變', () => {
  const r = historyToWrite(makeText(0, 40), M({ cursor_y: 7 }))
  assert.equal(r.histCount, 0)
  assert.equal(r.totalRows, 40)
  assert.equal(parse(r.data).row, 7)
})

test('行數比 rows 少或欄位缺：不當歷史、不寫出壞序列', () => {
  const few = historyToWrite(makeText(0, 10), M())
  assert.equal(few.histCount, 0)
  assert.equal(few.totalRows, 40)
  const bad = historyToWrite('', {})
  assert.equal(bad.histCount, 0)
  assert.match(bad.data, /\x1b\[1;1H$/)
  assert.equal(historyToWrite(makeText(5, 10), { cursor_x: 'x', cursor_y: -3 }).histCount, 0, 'rows 缺：沒辦法拆，不猜')
})

test('畫面最後幾列是空列時照算，不因為去掉結尾空列而少算歷史', () => {
  const text = ['舊1', '舊2', '甲', '', ''].join('\r\n') + '\r\n\n'
  const r = historyToWrite(text, M({ rows: 3, cursor_y: 0 }))
  assert.equal(r.histCount, 2)
  assert.equal(parse(r.data).row, 2)
})

test('畫面部分的寫法和 frameToWrite 一致（同一份畫面，歷史只是多出前面的列）', () => {
  const screen = Array.from({ length: 40 }, (_, i) => `畫面${i + 1}`).join('\r\n') + '\r\n\n'
  const a = parse(frameToWrite({ text: screen, meta: M() }))
  const b = parse(historyToWrite(makeText(30, 40), M()).data)
  assert.deepEqual(b.lines.slice(30), a.lines)
  assert.equal(b.row, a.row + 30)
})

// ---- 狀態機 ----
test('live → 要 → loading → 有歷史 → frozen → 回到最新 → live', () => {
  const h = createHistory()
  const t = h.request(0)
  assert.ok(t > 0)
  assert.equal(h.state(), 'loading')
  assert.equal(h.loaded(t, 200, 10), true)
  assert.equal(h.state(), 'frozen')
  h.frame({ seq: 9 })
  const f = h.release()
  assert.equal(f.seq, 9, '回到最新用最新一幅')
  assert.equal(h.state(), 'live')
  assert.ok(h.request(20) > 0, '新的 live 期間可以再要')
})

test('載入後沒有歷史：回 live、冷卻 5 秒內不再要，過了可再要', () => {
  const h = createHistory()
  const t = h.request(1000)
  assert.equal(h.loaded(t, 0, 1000), false)
  assert.equal(h.state(), 'live')
  assert.equal(h.request(1000 + HISTORY_COOLDOWN_MS - 1), 0)
  assert.ok(h.request(1000 + HISTORY_COOLDOWN_MS) > 0)
})

test('失敗：回 live、冷卻；冷卻過後可再要', () => {
  const h = createHistory()
  const t = h.request(0)
  h.failed(t, 0)
  assert.equal(h.state(), 'live')
  assert.equal(h.request(100), 0)
  assert.ok(h.request(HISTORY_COOLDOWN_MS + 1) > 0)
})

test('loading 時重複要不重複要（去抖）；凍結時也不要', () => {
  const h = createHistory()
  assert.ok(h.request(0) > 0)
  assert.equal(h.request(1), 0)
  assert.equal(h.request(2), 0)
  const h2 = createHistory()
  const t = h2.request(0)
  h2.loaded(t, 5, 0)
  assert.equal(h2.request(99999), 0)
})

test('凍結時畫面幅只存不畫；其他狀態照畫', () => {
  const h = createHistory()
  assert.equal(h.frame({ seq: 1 }), true)
  const t = h.request(0)
  assert.equal(h.frame({ seq: 2 }), true, '載入中照畫')
  h.loaded(t, 3, 0)
  assert.equal(h.frame({ seq: 3 }), false)
  assert.equal(h.frame({ seq: 4 }), false)
  assert.equal(h.latest().seq, 4)
})

test('載入中就回到底部：那次載入作廢，晚到的結果不能凍結', () => {
  const h = createHistory()
  const t = h.request(0)
  assert.equal(h.release(), null)
  assert.equal(h.loaded(t, 50, 0), false)
  assert.equal(h.state(), 'live')
})

// ---- 觸發條件 ----
test('滾輪：只有往上而且在最頂才要；捲動：只有人捲離底部超過 2px 才要', () => {
  assert.equal(wheelWantsHistory({ deltaY: -100, scrollTop: 0 }), true)
  assert.equal(wheelWantsHistory({ deltaY: -100, scrollTop: 30 }), false)
  assert.equal(wheelWantsHistory({ deltaY: 100, scrollTop: 0 }), false)
  assert.equal(scrollWantsHistory({ scrollTop: 100, max: 400, mine: false }), true)
  assert.equal(scrollWantsHistory({ scrollTop: 398, max: 400, mine: false }), false, '2px 內算在底部')
  assert.equal(scrollWantsHistory({ scrollTop: 100, max: 400, mine: true }), false, '程式自己設的位置不算')
  assert.equal(atBottom(398, 400), true)
  assert.equal(atBottom(397, 400), false)
  assert.equal(latestVisible(true, true), true, '凍結時一律顯示回到最新')
  assert.equal(latestVisible(true, false), false)
})

// ---- 捲動位置公式 ----
test('scrollTop 保持：舊位置加歷史列數乘列高，夾在可捲範圍內', () => {
  assert.equal(historyScrollTop({ oldTop: 100, oldMax: 400, histCount: 200, rowHeight: 17, newMax: 99999 }), 100 + 200 * 17)
  assert.equal(historyScrollTop({ oldTop: 100, oldMax: 400, histCount: 200, rowHeight: 17, newMax: 500 }), 500, '夾在 newMax')
  assert.equal(historyScrollTop({ oldTop: 0, oldMax: 0, histCount: 0, rowHeight: 17, newMax: 0 }), 0)
})
test('scrollTop 保持：載入前就在底部（含捲不動）則往上讓出 3 列，不會落在底部被當成回到最新', () => {
  const top = historyScrollTop({ oldTop: 0, oldMax: 0, histCount: 200, rowHeight: 17, newMax: 200 * 17 })
  assert.equal(top, 200 * 17 - 3 * 17)
  assert.ok(!atBottom(top, 200 * 17))
  assert.equal(historyScrollTop({ oldTop: 0, oldMax: 0, histCount: 1, rowHeight: 17, newMax: 17 }), 0, '不會變負的')
})

// ---- 接上 session ----
function rig({ history, now } = {}) {
  const handlers = {}, c = { written: [], resized: [], states: [], histCalls: [], painted: [] }
  let t = now ?? 0
  const session = createTermViewSession({
    open: async () => 7, close: async () => {},
    listen: async (evt, fn) => { handlers[evt] = fn; return () => {} },
    createTerm: async () => ({ write: s => c.written.push(s), resize: (a, b) => c.resized.push([a, b]), dispose() {} }),
    onLost() {}, onPainted: f => c.painted.push(f.seq),
    now: () => t,
    history: history ?? (async (id, lines) => { c.histCalls.push([id, lines]); return { text: makeText(200, 40), lines, truncated: false, meta: M() } }),
    onHistoryState: (s, info) => c.states.push([s, info]),
  })
  return { session, handlers, c, tick: ms => { t += ms } }
}
const fr = (seq, text = '畫') => ({ view_id: 7, seq, text, meta: M() })

test('session：滾到頂要一次歷史 → xterm 拉高成 240 列並寫入 → 之後的畫面幅不寫 → 回到最新縮回 40 列用最新幅重畫', async () => {
  const r = rig()
  await r.session.start()
  r.handlers['term-view-frame'](fr(1))
  await r.session.flushed()
  assert.equal(r.c.written.length, 1)
  assert.equal(r.session.wantHistory(), true)
  assert.equal(r.session.wantHistory(), false, '載入中重複不重複要')
  await wait()
  await r.session.flushed()
  assert.deepEqual(r.c.histCalls, [[7, HISTORY_LINES]])
  assert.equal(r.session.frozen(), true)
  assert.deepEqual(r.c.resized.at(-1), [120, 240])
  assert.equal(parse(r.c.written.at(-1)).row, 204)
  const n = r.c.written.length
  r.handlers['term-view-frame'](fr(2, '新的'))
  r.handlers['term-view-frame'](fr(3, '最新的'))
  await r.session.flushed()
  assert.equal(r.c.written.length, n, '凍結期間不寫 xterm')
  assert.equal(r.c.painted.length, 1, '也不通知跟隨')
  assert.equal(r.session.backToBottom(), true)
  assert.deepEqual(r.c.resized.at(-1), [120, 40])
  assert.equal(r.c.written.at(-1), frameToWrite(fr(3, '最新的')))
  assert.equal(r.session.frozen(), false)
  r.handlers['term-view-frame'](fr(4))
  await r.session.flushed()
  assert.equal(r.c.written.length, n + 2, '恢復後照常畫')
})

test('session：後端沒有歷史或失敗都不凍結、不彈窗，冷卻內不再要', async () => {
  const c = { n: 0 }
  const r = rig({ history: async () => { c.n++; if (c.n === 1) return { text: makeText(0, 40), meta: M() }; throw 'boom' } })
  await r.session.start()
  r.handlers['term-view-frame'](fr(1))
  await r.session.flushed()
  r.session.wantHistory()
  await wait()
  await r.session.flushed()
  assert.equal(r.session.frozen(), false)
  assert.equal(r.session.historyState(), 'live')
  assert.equal(r.session.wantHistory(), false, '冷卻中')
  r.tick(HISTORY_COOLDOWN_MS + 1)
  assert.equal(r.session.wantHistory(), true)
  await wait()
  await r.session.flushed()
  assert.equal(r.session.historyState(), 'live')
  assert.equal(c.n, 2)
  assert.equal(r.session.wantHistory(), false, '失敗後也冷卻')
})

test('session：沒有給 history 的 api（舊版）完全不動', async () => {
  const s2 = createTermViewSession({ open: async () => 7, close: async () => {}, listen: async () => () => {}, createTerm: async () => ({ write() {}, resize() {}, dispose() {} }), onLost() {} })
  await s2.start()
  assert.equal(s2.wantHistory(), false)
})

// ---- 原始碼守門（標記字串唯一） ----
test('守門 904-b3：wheel 觸發只在往上且最頂、凍結時 paint 不寫 xterm、transport 與接線存在', () => {
  const v = SRC('term-view.mjs'), h = SRC('term-history.mjs'), tauri = SRC('tauri.mjs')
  assert.equal((v.match(/@wheel\.passive="onPullUp"/g) || []).length, 1)
  assert.match(v, /const onPullUp = ev => \{ if \(wheelWantsHistory\(\{ deltaY: ev\.deltaY, scrollTop: host\.value\.scrollTop \}\)\) session\?\.wantHistory\(\) \}/)
  assert.match(h, /return Number\(deltaY\) < 0 && Number\(scrollTop\) <= 0/)
  assert.match(v, /if \(!hist\.frame\(frame\)\) return\r?\n\s*if \(size\.cols !== cols/, '凍結檢查在 resize 與 write 之前')
  assert.match(v, /scrollWantsHistory\(\{ scrollTop: el\.scrollTop, max, mine \}\)\) session\?\.wantHistory\(\)/)
  assert.match(v, /if \(session\?\.frozen\(\)\) return {3}\/\/ 看歷史時不動捲動位置/)
  assert.match(tauri, /history: \(viewId, lines\) => invoke\('term_view_history', \{ viewId, lines \}\)/)
  assert.match(v, /history: props\.api\.history \? \(viewId, lines\) => props\.api\.history\(viewId, lines\) : undefined/)
  assert.match(v, /t\.attachCustomWheelEventHandler\(\(\) => false\)[\s\S]*t\.onData\(/, '滾輪仍交給外層')
  assert.match(v, /讀取更早的內容…/)
  const css = fs.readFileSync(new URL('../ui/style.css', import.meta.url), 'utf8')
  assert.match(css, /\.term-view-loading\{position:absolute/)
  assert.match(css, /\.term-view-screen::-webkit-scrollbar\{width:0;/, '捲軸隱藏不動')
})

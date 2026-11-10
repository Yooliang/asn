// 手機看終端：游標那一列要看得到（cursorScrollTop），使用者捲離就不拉回
import test from 'node:test'
import assert from 'node:assert/strict'
import { cursorScrollTop } from '../ui/lib/term-remote.mjs'
import { createFollow } from '../ui/lib/term-view.mjs'

// 40 列、每列 15px＝600；可見 180；最多捲 420
const base = { rowHeight: 15, viewHeight: 180, maxScroll: 420, follow: true, offset: 0 }

test('游標在可見範圍內：不動', () => {
  assert.equal(cursorScrollTop({ ...base, cursorRow: 3, scrollTop: 0 }), null)
  assert.equal(cursorScrollTop({ ...base, cursorRow: 30, scrollTop: 400 }), null)
})

test('游標在可見範圍下方：捲到剛好看得到那一整列', () => {
  assert.equal(cursorScrollTop({ ...base, cursorRow: 38, scrollTop: 0 }), 39 * 15 - 180)
  // 剛好完整看得到那一列的下緣
  assert.equal(cursorScrollTop({ ...base, cursorRow: 11, scrollTop: 0 }), null)
  assert.equal(cursorScrollTop({ ...base, cursorRow: 12, scrollTop: 0 }), 13 * 15 - 180)
})

test('游標在最後一列：不超過可捲的最大值', () => {
  assert.equal(cursorScrollTop({ ...base, cursorRow: 39, scrollTop: 0, maxScroll: 410 }), 410)
})

test('內距（offset）要算進去', () => {
  assert.equal(cursorScrollTop({ ...base, cursorRow: 38, scrollTop: 0, offset: 4 }), 39 * 15 + 4 - 180)
})

test('使用者捲離（follow=false）：不動', () => {
  assert.equal(cursorScrollTop({ ...base, cursorRow: 38, scrollTop: 0, follow: false }), null)
})

test('高度變小後重算：原本看得到，縮短後要往下補', () => {
  const before = { ...base, cursorRow: 38, viewHeight: 600, scrollTop: 0, maxScroll: 0 }
  assert.equal(cursorScrollTop(before), null, '夠高時不用動')
  const after = { ...before, viewHeight: 180, maxScroll: 420 }
  assert.equal(cursorScrollTop(after), 405)
})

test('游標在可見範圍上方（跟隨中）：往上補到那一列頂', () => {
  assert.equal(cursorScrollTop({ ...base, cursorRow: 2, scrollTop: 300 }), 30)
})

test('壞輸入：不動、不丟錯', () => {
  assert.equal(cursorScrollTop({ ...base, cursorRow: undefined, scrollTop: 0 }), null)
  assert.equal(cursorScrollTop({ ...base, cursorRow: 5, rowHeight: 0, scrollTop: 0 }), null)
  assert.equal(cursorScrollTop({ ...base, cursorRow: 5, viewHeight: 0, scrollTop: 0 }), null)
})

test('跟隨狀態：使用者往上捲停止跟隨、程式自己設的捲動不算、捲回底部恢復', () => {
  const f = createFollow()
  assert.equal(f.following(), true, '一開始跟隨')
  f.place(405)
  f.onScroll(405, 420)
  assert.equal(f.following(), true, '程式自己設的捲動位置不算使用者捲的')
  f.onScroll(0, 420)
  assert.equal(f.following(), false, '使用者捲到頂')
  assert.equal(cursorScrollTop({ ...base, cursorRow: 38, scrollTop: 0, follow: f.following() }), null)
  f.onScroll(419, 420)
  assert.equal(f.following(), true, '捲回底部恢復')
})

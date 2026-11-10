// 手機看終端：游標那一列要看得到（cursorScrollTop），使用者捲離就不拉回
import test from 'node:test'
import assert from 'node:assert/strict'
import { createCursorFollow, cursorScrollTop } from '../ui/lib/term-remote.mjs'

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

// 游標第 38 列、max 420、可見 180：游標列看得到的 scrollTop 約 390..420，我們設 405（不是最底）
const visible = top => cursorScrollTop({ ...base, cursorRow: 38, scrollTop: top }) === null

test('跟隨狀態：程式設 405 之後，非程式的小幅 scroll 事件（夾值、慣性）不會關掉跟隨', () => {
  const f = createCursorFollow()
  assert.equal(f.away(), false, '一開始跟隨')
  f.onProgrammatic(405)
  for (const top of [405, 404, 406, 405]) {
    f.onScroll(top, { cursorVisible: visible(top) })
    assert.equal(f.away(), false, `scroll 到 ${top} 不算使用者捲的`)
  }
})

test('跟隨狀態：使用者捲到 100 才算捲離；捲回游標看得到的位置（不必到最底）就恢復', () => {
  const f = createCursorFollow()
  f.onProgrammatic(405)
  assert.equal(f.onScroll(100, { cursorVisible: visible(100) }), true)
  assert.equal(f.away(), true)
  assert.equal(cursorScrollTop({ ...base, cursorRow: 38, scrollTop: 100, follow: !f.away() }), null, '捲離時不拉回')
  f.onScroll(300, { cursorVisible: visible(300) })
  assert.equal(f.away(), true, '還沒捲到游標看得到的位置')
  f.onScroll(400, { cursorVisible: visible(400) })
  assert.equal(f.away(), true, '400 還差一點，游標那一列的下緣被切到')
  f.onScroll(410, { cursorVisible: visible(410) })
  assert.equal(f.away(), false, '游標看得到就恢復跟隨')
})

test('跟隨狀態：使用者捲到最底、游標仍看得到：維持跟隨，下一幅不會往上拉', () => {
  const f = createCursorFollow()
  f.onProgrammatic(405)
  f.onScroll(420, { cursorVisible: visible(420) })
  assert.equal(f.away(), false)
  assert.equal(cursorScrollTop({ ...base, cursorRow: 38, scrollTop: 420, follow: !f.away() }), null)
})

test('容器變高被夾回：onLayout 之後的夾值 scroll 不算使用者捲的', () => {
  const f = createCursorFollow()
  f.onProgrammatic(405)
  f.onLayout(300)   // 鍵盤收起，瀏覽器把 scrollTop 夾到 300，游標那一列這時看不到
  f.onScroll(300, { cursorVisible: visible(300) })
  assert.equal(f.away(), false, '夾值不算捲離')
  // 對照：沒先 onLayout 的話，同一件事會被當成使用者捲離（這就是要擋的）
  const g = createCursorFollow()
  g.onProgrammatic(405)
  g.onScroll(300, { cursorVisible: visible(300) })
  assert.equal(g.away(), true)
})

test('容器變高：已經捲離的人，onLayout 不會替他清掉捲離', () => {
  const f = createCursorFollow()
  f.onProgrammatic(405)
  f.onScroll(100, { cursorVisible: false })
  f.onLayout(100)
  f.onScroll(100, { cursorVisible: false })
  assert.equal(f.away(), true)
})

test('跟隨狀態：reset 之後重新開始', () => {
  const f = createCursorFollow()
  f.onScroll(50, { cursorVisible: false })
  assert.equal(f.away(), true)
  f.reset()
  assert.equal(f.away(), false)
})

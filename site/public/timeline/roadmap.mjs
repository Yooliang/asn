// 藍圖頁（/roadmap）的進入點：讀資料庫 → 時間軸、支援總表、待辦欄位。
import { load } from './data.mjs'
import { buildRoadmapTimeline, buildLanes, buildMatrix } from './model.mjs'
import { roadmapTimeline, matrixView, lanesView, showStatus } from './view.mjs'

const $ = id => document.getElementById(id)
const FAIL = '暫時讀不到資料，請稍後重新整理。'

async function main() {
  const status = [$('timeline-status'), $('matrix-status'), $('todo-status')]
  for (const el of status) showStatus(el, '讀取中…')
  try {
    const d = await load(['releases', 'items', 'lanes', 'columns', 'rows', 'cells'])
    $('timeline').replaceChildren(roadmapTimeline(buildRoadmapTimeline(d.releases, d.items)))
    $('matrix-table').replaceChildren(matrixView(buildMatrix(d.columns, d.rows, d.cells)))
    $('todo-lanes').replaceChildren(lanesView(buildLanes(d.lanes, d.items, 'todo')))
    for (const el of status) showStatus(el, '')
  } catch (e) {
    console.info('[藍圖頁] 讀取資料失敗：', e)
    for (const el of status) showStatus(el, FAIL)
  }
}

main()

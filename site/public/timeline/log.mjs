// 開發日誌頁（/log）的進入點：讀資料庫的發版記錄 → 排成一條時間軸，最新在上。會議不顯示（資料庫裡的會議記錄保留，只是這頁不讀）。
import { load } from './data.mjs'
import { buildLog } from './model.mjs'
import { logTimeline, showStatus } from './view.mjs'

const $ = id => document.getElementById(id)

async function main() {
  const status = $('log-status')
  showStatus(status, '讀取中…')
  try {
    const d = await load(['releases'])
    $('log').replaceChildren(logTimeline(buildLog(d.releases)))
    showStatus(status, '')
  } catch (e) {
    console.info('[開發日誌頁] 讀取資料失敗：', e)
    showStatus(status, '暫時讀不到資料，請稍後重新整理。')
  }
}

main()

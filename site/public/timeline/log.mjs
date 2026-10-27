// 開發日誌頁（/log）的進入點：讀資料庫 → 會議與發版合成一條時間軸，最新在上。
import { load } from './data.mjs'
import { buildLog } from './model.mjs'
import { logTimeline, showStatus } from './view.mjs'

const $ = id => document.getElementById(id)

async function main() {
  const status = $('log-status')
  showStatus(status, '讀取中…')
  try {
    const d = await load(['meetings', 'releases'])
    $('log').replaceChildren(logTimeline(buildLog(d.meetings, d.releases)))
    showStatus(status, '')
  } catch (e) {
    console.info('[開發日誌頁] 讀取資料失敗：', e)
    showStatus(status, '暫時讀不到資料，請稍後重新整理。')
  }
}

main()

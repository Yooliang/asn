// 設定頁的分類定義與每類「一行目前值摘要」（純邏輯，node 與瀏覽器都能跑）。
// 設定頁只列分類，點一類才開對話框顯示詳細項目；存檔格式與各設定的行為都不在這裡動。
import { FRAME_LABEL, CLOSE_LABEL, notifySummary } from './prefs.mjs'
import { MODE_LABEL, DP_LABEL, TOOLBAR_LABEL, BUBBLE_LABEL } from './merge.mjs'
import { DIMS } from './dims.mjs'
import { AUTO_LABEL, STT_LANG_LABEL } from './voice-prefs.mjs'

// 每類的圖示：24x24 的線條路徑（畫面用 svg 的 path 顯示，不用 v-html）
export const SETTING_CATS = [
  { key: 'me', title: '個人', icon: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21c0-4.4 3.6-7 8-7s8 2.6 8 7' },
  { key: 'accounts', title: '帳號', icon: 'M9 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM3 20c0-3.3 2.7-5 6-5s6 1.7 6 5M16 5.5a3 3 0 0 1 0 5.5M18 15c2 .5 3 2 3 5' },
  { key: 'look', title: '外觀', icon: 'M12 3a9 9 0 1 0 0 18c1.5 0 2-1 1.5-2s0-2 1.5-2h2a3 3 0 0 0 3-3c0-5-4-11-8-11z' },
  { key: 'tabs', title: '分頁與分組', icon: 'M3 6h7l2 2h9v11H3z' },
  { key: 'notify', title: '通知', icon: 'M6 9a6 6 0 0 1 12 0c0 6 2 7 2 7H4s2-1 2-7zM10 19a2 2 0 0 0 4 0' },
  { key: 'voice', title: '語音', icon: 'M12 3a3 3 0 0 0-3 3v5a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3zM6 11a6 6 0 0 0 12 0M12 17v4' },
  { key: 'window', title: '視窗與系統匣', icon: 'M3 5h18v14H3zM3 9h18' },
  { key: 'launch', title: '啟動設定', icon: 'M6 4l14 8-14 8z' },
  { key: 'usage', title: '用量', icon: 'M4 20V10M10 20V4M16 20v-7M22 20H2' },
  { key: 'update', title: '更新', icon: 'M20 12a8 8 0 1 1-2.3-5.7M20 4v5h-5' },
  { key: 'about', title: '關於', icon: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 11v6M12 7.5v.5' },
]
export const SETTING_KEYS = SETTING_CATS.map(c => c.key)
export const catByKey = key => SETTING_CATS.find(c => c.key === key) ?? null

const onOff = v => (v ? '開' : '關')
const dimLabel = k => DIMS.find(d => d.key === k)?.label ?? ''
const join = parts => parts.filter(Boolean).join('、')

// 一行目前值摘要。s＝目前設定的快照（欄位缺少時用保守的預設，不丟錯）。
export function catSummary(key, s = {}) {
  switch (key) {
    case 'me':
      return s.hasUpload ? '已上傳大頭貼' : '自動產生的大頭貼'
    case 'accounts': {
      const n = Number.isInteger(s.accountCount) ? s.accountCount : 0
      if (!n) return s.accountCurrent ? `使用中：${s.accountCurrent}（還沒加入帳號庫）` : '還沒有加入過帳號'
      return s.accountCurrent ? `${n} 個 Claude 帳號，使用中：${s.accountCurrent}` : `${n} 個 Claude 帳號`
    }
    case 'look':
      return join([FRAME_LABEL[s.frame] ?? FRAME_LABEL.custom, MODE_LABEL[s.mode], `頭像${DP_LABEL[s.dpMode] ?? ''}`, `工具列${TOOLBAR_LABEL[s.toolbar] ?? ''}`, `底色${BUBBLE_LABEL[s.bubble] ?? ''}`])
    case 'tabs':
      return `分頁依${dimLabel(s.tabDim)}、分組依${dimLabel(s.groupDim)}`
    case 'notify':
      return notifySummary(s.notify)
    case 'voice': {
      if (s.voiceEnabled === false) return '念出訊息尚未啟用'
      return join([`自動念：${AUTO_LABEL[s.ttsAuto ? 'on' : 'off']}`, `輸入語言：${STT_LANG_LABEL[s.sttLang] ?? STT_LANG_LABEL.zh}`])
    }
    case 'window': {
      const closeTo = s.trayOk === false ? '結束程式' : (CLOSE_LABEL[s.closeTo] ?? CLOSE_LABEL.tray)
      return s.autostartSupported ? `關閉時${closeTo}、開機啟動：${onOff(s.autostartOn)}` : `關閉時${closeTo}`
    }
    case 'launch': {
      const cwd = Number.isInteger(s.cwdCount) ? s.cwdCount : 0
      return `每小時上限 ${Number.isInteger(s.maxPerHour) ? s.maxPerHour : '-'} 個、白名單 ${cwd} 個資料夾`
    }
    case 'usage':
      return s.usageLine || '本機 Claude 用量估算'
    case 'update':
      return `自動檢查：${onOff(s.autoCheck)}`
    case 'about':
      return s.version ? `版本 ${s.version}` : '版本'
    default:
      return ''
  }
}

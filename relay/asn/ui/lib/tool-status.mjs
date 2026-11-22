// 設定頁「已安裝的工具」每一列的狀態文字（#1548 ④）：版本是不是最新、登入狀態。純邏輯，node 與瀏覽器都能跑。
// 資料來自後端 ai_cli_status（只看各 CLI 自己的狀態指令與官方版本網址，不讀任何憑證檔）。
// 登入的字沿用設備頁那一套（device-state.mjs 的 STATE／STATE_TEXT／SHORT_TEXT），不另寫一份。
// 原則：查不到就說「暫時查不到」，絕不把查不到當成「過期」或「已是最新版」。
import { STATE, STATE_TEXT, SHORT_TEXT } from './device-state.mjs'

export const TOOL_STATUS_TEXT = Object.freeze({
  recheck: '重新檢查',
  rechecking: '正在檢查…',
  latest: '已是最新版',
  behind: v => `有新版 ${v}`,
  latestUnknown: '暫時查不到',
  loginUnknown: '登入狀態查不到',
  checking: '檢查中…',
})

/** 已登入幾家（pi 可以同時登入好幾家；只有一家或不適用就只寫「已登入」） */
const loggedInText = n => (n > 1 ? `${SHORT_TEXT[STATE.LOGGED_IN]} ${n} 家` : SHORT_TEXT[STATE.LOGGED_IN])

/**
 * 一列的「最新版」與「登入」兩格。
 * status：後端 ai_cli_status 的一列（沒有＝還沒回來或這台沒有這個指令）；loading：正在查
 * → { latest: { kind: 'ok'|'behind'|'unknown'|'wait', text }, login: { kind: 'in'|'out'|'unknown'|'wait', text } }
 */
export function toolStatusView(status, loading = false) {
  if (!status) {
    const w = loading ? { kind: 'wait', text: TOOL_STATUS_TEXT.checking } : null
    return {
      latest: w ?? { kind: 'unknown', text: TOOL_STATUS_TEXT.latestUnknown },
      login: w ?? { kind: 'unknown', text: TOOL_STATUS_TEXT.loginUnknown },
    }
  }
  const latest = status.version_state === 'latest' ? { kind: 'ok', text: TOOL_STATUS_TEXT.latest }
    : status.version_state === 'behind' && status.latest ? { kind: 'behind', text: TOOL_STATUS_TEXT.behind(status.latest) }
    : { kind: 'unknown', text: TOOL_STATUS_TEXT.latestUnknown }
  const login = status.login === 'in' ? { kind: 'in', text: loggedInText(Number(status.login_count) || 0) }
    : status.login === 'out' ? { kind: 'out', text: STATE_TEXT[STATE.LOGGED_OUT] }
    : { kind: 'unknown', text: TOOL_STATUS_TEXT.loginUnknown }
  return { latest, login }
}

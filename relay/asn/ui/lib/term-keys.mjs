// 手機看別台終端時的按鍵列與「複製畫面文字」（#1512 B）。這裡只放純函式與固定字，不碰網路與 Tauri。
// 按鍵一律走打字的同一條路（remoteInputApi.send，那台交給窗格前照樣重讀畫面）：
// 停在需要人確認的畫面（認不出的選單、額度選單）時，數字、Enter、方向鍵在那台會被拿掉，不另開繞過檢查的入口。
import { stringWidth } from './term-width.mjs'

/** 按鍵列：顯示的字、送出的按鍵、唸給讀屏的說法。順序就是畫面上的順序 */
export const TERM_KEYS = Object.freeze([
  { id: '1', label: '1', seq: '1', aria: '按 1' },
  { id: '2', label: '2', seq: '2', aria: '按 2' },
  { id: '3', label: '3', seq: '3', aria: '按 3' },
  { id: 'up', label: '↑', seq: '\x1b[A', aria: '按向上鍵' },
  { id: 'down', label: '↓', seq: '\x1b[B', aria: '按向下鍵' },
  { id: 'esc', label: 'Esc', seq: '\x1b', aria: '按 Esc' },
  { id: 'enter', label: 'Enter', seq: '\r', aria: '按 Enter' },
])

export const KEYS_TEXT = Object.freeze({
  row: '按鍵',
  copy: '複製畫面文字',
  copied: '已複製畫面文字',
  copyFailed: '複製沒有成功，請長按畫面自己選取',
  openLogin: host => `開啟登入網址（${host}）`,
  // 那台回報：畫面停在需要人確認的地方，這批按鍵被拿掉了（只交了文字）
  dropped: '這個畫面要人確認，不能用按鍵代選：數字、Enter 和方向鍵沒有送出。請到那台電腦上處理。',
})

const RULE_ROW = /^[\s─━═╌▔▁-]+$/u

/**
 * 終端畫面一列一列的字接回原本的行：一列寫滿（字寬到了欄數）就是被折下去的，和下一列接起來。
 * 每列結尾的空白拿掉，最後的空行拿掉。cols 不明（0、不是數字）就不接
 */
export function joinWrapped(text, cols) {
  const rows = String(text ?? '').replace(/\r\n?/g, '\n').split('\n')
  const n = Number(cols)
  const out = []
  let cur = null
  for (const row of rows) {
    // 整列都是分隔線（─ 等）的不算折行：分隔線本來就畫滿整列
    const full = Number.isInteger(n) && n > 0 && stringWidth(row) >= n && !RULE_ROW.test(row)
    cur = cur === null ? row : cur + row
    if (!full) { out.push(cur.replace(/\s+$/, '')); cur = null }
  }
  if (cur !== null) out.push(cur.replace(/\s+$/, ''))
  while (out.length && !out[out.length - 1]) out.pop()
  return out.join('\n')
}

/** 登入網址只認這幾個官方網域（完全相同，不收子網域、不收長得像的） */
export const LOGIN_HOSTS = Object.freeze(['claude.ai', 'claude.com', 'console.anthropic.com', 'platform.claude.com', 'auth.openai.com'])
/** 畫面上最多給幾個登入網址的按鈕 */
export const LOGIN_MAX = 2
const URL_RE = /https:\/\/[^\s"'<>`]+/g

/** 從（接回折行後的）畫面文字找出登入網址：只收 https、官方網域、沒有帳密；結尾的標點拿掉，重複的只留一個 */
export function findLoginUrls(text) {
  const seen = new Set(), out = []
  for (const m of String(text ?? '').matchAll(URL_RE)) {
    const raw = m[0].replace(/[).,;:!?\]}>」』）。，]+$/u, '')
    let u
    try { u = new URL(raw) } catch { continue }
    if (u.protocol !== 'https:' || u.username || u.password || !LOGIN_HOSTS.includes(u.hostname) || raw.length > 2000) continue
    if (seen.has(raw)) continue
    seen.add(raw)
    out.push({ url: raw, host: u.hostname })
    if (out.length >= LOGIN_MAX) break
  }
  return out
}

/** 那台回報的「按鍵被拿掉的次數」變大了沒（第一次看到大於 0 也算） */
export function droppedGrew(prev, next) {
  const a = Number(prev) || 0, b = Number(next)
  return Number.isFinite(b) && b > a
}

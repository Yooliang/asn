// 看別台（或手機看電腦）的終端時，畫面停在 Claude 第一次的確認畫面：標出「這是哪一種確認」與要選哪一項（#1637）。
// 只做顯示：ASN 不代按、不寫設定、不新增任何送鍵的路；按鍵仍由本人用按鍵列或輸入框自己送（走原本的同意與保護）。
// 標籤只是輔助，原畫面一定照樣顯示在上面，認不出就什麼都不加。
// 判斷方式和 Rust 端 launch/claude_screen.rs 的 judge（TrustFolder／BypassWarning）一致：選單要在畫面最底、頁尾是最後一列、
// 選項恰好是那兩項（有編號或游標都行）、上面有問題標題。對話內容剛好貼了那幾句、或選項多一個，都不算。
// test/confirm-kind.test.mjs 用 Rust 測試用的畫面檔跑同一批畫面，並檢查關鍵字與 Rust 端一致。
import { STUCK_NOTES } from './term-entry.mjs'

const TRUST = { question: 'Quick safety check', options: ['No, exit', 'Yes, I trust this folder'] }
const BYPASS = { question: 'Bypass Permissions mode', options: ['No, exit', 'Yes, I accept'] }
const FOOTER = 'Enter to confirm'

/** 去掉列首的游標（❯）與編號（1. ），剩選項的字 */
const labelOf = row => row.replace(/^[❯>›]\s*/u, '').replace(/^\d+\.\s*/, '').trim()

const sameSet = (a, b) => a.length === b.length && b.every(x => a.includes(x))

/**
 * 畫面現在是不是 Claude 第一次的確認畫面。回 'trust'（信任這個資料夾）、'bypass_warning'（略過權限模式）或 ''。
 * 讀不準就回空字串（寧可不標，原畫面本來就看得到）
 */
export function confirmKindOf(text) {
  const rows = String(text ?? '').replace(/\r\n?/g, '\n').split('\n').map(r => r.trim()).filter(Boolean)
  if (rows.length < 4) return ''
  const last = rows.length - 1
  // 頁尾必須是最後一列：確認畫面停著的時候下面不會再有東西（對話裡貼到同樣的字，後面一定還有輸入框之類）
  if (!rows[last].startsWith(FOOTER)) return ''
  // 選項：頁尾上面連續、字樣是「Yes…」「No…」開頭的幾列（多出來的選項也算進去，所以多一個就對不上）
  const opts = []
  let i = last - 1
  while (i >= 0 && opts.length < 6 && /^(Yes|No)\b/.test(labelOf(rows[i]))) { opts.unshift(labelOf(rows[i])); i-- }
  const context = rows.slice(Math.max(0, i - 8), i + 1).join(' ').replace(/\s+/g, ' ')
  if (sameSet(opts, TRUST.options) && context.includes(TRUST.question)) return 'trust'
  if (sameSet(opts, BYPASS.options) && context.includes(BYPASS.question)) return 'bypass_warning'
  return ''
}

/** 給本人看的說明（一句話）：哪一種確認、要去哪裡按。沿用 #1632 的字，不再另寫一套 */
export const confirmNoteOf = kind => (kind === 'trust' || kind === 'bypass_warning' ? STUCK_NOTES[kind] ?? '' : '')

/** 等確認的夥伴，手機要打字／按鍵，那台還要人按「允許」時的一行提醒（只在真的在等對方回應時才顯示） */
export const AWAITING_CONSENT_HINT = '那台需要先設免問，或有人在電腦前按允許'

export const CONFIRM_KEYWORDS = Object.freeze({ trust: TRUST, bypass: BYPASS, footer: FOOTER })

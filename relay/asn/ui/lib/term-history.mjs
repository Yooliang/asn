// 終端畫面往上看更早的內容（#904 B3）。平常每幅只送畫面；人往上捲到頂、或停在不是底部時，才向後端要「一次」歷史，
// 拿到之後凍結重畫（新的畫面幅只存起來），直到使用者回到底部或按「回到最新」才恢復。這裡只放純函式與狀態機，不碰 xterm 與 DOM。

/** 一次向後端要幾行歷史（後端夾在 1..500） */
export const HISTORY_LINES = 200
/** 這次沒有歷史、或讀取失敗之後，多久內不再要 */
export const HISTORY_COOLDOWN_MS = 5000
/** 離底部多少像素內算「在底部」 */
export const BOTTOM_SLACK = 2
/** 滾輪一格約三列：剛好在底部要看更舊的內容時，載入後往上讓出這麼多列，使用者才看得到歷史出現了 */
export const NUDGE_ROWS = 3

/**
 * 把後端給的「歷史＋畫面」文字組成要寫給 xterm 的內容。最後 meta.rows 行是目前畫面，在那之前的都是歷史。
 * 輸出：清掉重畫、全部行用 CRLF 接起來、游標放回畫面裡的位置（要加上歷史行數）。
 * 行數不足 rows（沒有歷史、或資料不完整）：histCount＝0，totalRows＝rows。
 */
export function historyToWrite(text, meta) {
  // 和 frameToWrite 一樣：整份最後多一個裸換行，先去掉這一個，再去掉最後一列的結尾，剩下的就是一列一個元素
  const full = String(text ?? '').replace(/\r?\n/g, '\r\n').replace(/(\r\n)$/, '')
  const lines = full.split('\r\n')
  if (lines.length && lines[lines.length - 1] === '') lines.pop()
  const rows = Number(meta?.rows)
  const hasRows = Number.isInteger(rows) && rows > 0
  const histCount = hasRows && lines.length > rows ? lines.length - rows : 0
  const totalRows = hasRows ? Math.max(rows, lines.length) : Math.max(1, lines.length)
  const body = lines.join('\r\n').replace(/(\r\n)+$/, '')
  const x = Math.max(0, Number(meta?.cursor_x) || 0)
  const y = Math.max(0, Number(meta?.cursor_y) || 0)
  const row = Math.min(totalRows, y + histCount + 1)
  return { data: `\x1b[0m\x1b[H\x1b[2J${body}\x1b[0m\x1b[${row};${x + 1}H`, histCount, totalRows }
}

/** 滾輪事件要不要去要歷史：往上滾，而且外層已經在最頂（包含內容沒超過容器、本來就捲不動） */
export function wheelWantsHistory({ deltaY, scrollTop }) {
  return Number(deltaY) < 0 && Number(scrollTop) <= 0
}

/** 捲動事件要不要去要歷史：人（不是程式自己設的位置）捲到離底部超過 2px */
export function scrollWantsHistory({ scrollTop, max, mine }) {
  return !mine && scrollTop < max - BOTTOM_SLACK
}

/** 在底部附近嗎 */
export function atBottom(scrollTop, max) {
  return scrollTop >= max - BOTTOM_SLACK
}

/**
 * 歷史載入後外層的 scrollTop：讓原本看到的畫面部分留在原處，歷史出現在上方（舊位置加上歷史列數乘列高）。
 * 例外：載入前就在底部（要看更舊的內容才觸發），照公式會剛好落在底部、馬上被當成「回到底部」，
 * 所以往上讓出 NUDGE_ROWS 列。結果夾在 0..newMax。
 */
export function historyScrollTop({ oldTop, oldMax, histCount, rowHeight, newMax }) {
  let top = oldTop + histCount * rowHeight
  if (oldTop >= oldMax - BOTTOM_SLACK) top -= NUDGE_ROWS * rowHeight
  return Math.min(Math.max(0, newMax), Math.max(0, top))
}

/**
 * 歷史的狀態機：'live'（平常）→ 'loading'（已經去要了）→ 'frozen'（拿到歷史、凍結重畫）→ 回 'live'。
 * 時間由呼叫端傳入（毫秒），好測。
 *   request(now)        → 代號（>0＝去要）或 0（不要要）：不在 live、或還在冷卻都不要；要的過程中重複呼叫不重複要
 *   loaded(代號, 歷史行數, now) → true＝凍結；false＝沒有歷史（回 live、冷卻）或代號過期（什麼都不做）
 *   failed(代號, now)   → 回 live、冷卻
 *   frame(f)            → 存下最新一幅；回傳這幅要不要畫（凍結時 false）
 *   release()           → 回 live；原本是凍結就回最新一幅（拿去重畫），否則 null；載入中也取消那次載入
 */
export function createHistory({ cooldownMs = HISTORY_COOLDOWN_MS } = {}) {
  let state = 'live', token = 0, coolUntil = 0, latest = null
  return {
    state: () => state,
    frozen: () => state === 'frozen',
    loading: () => state === 'loading',
    latest: () => latest,
    request(now = 0) {
      if (state !== 'live' || now < coolUntil) return 0
      state = 'loading'
      return ++token
    },
    loaded(t, histCount, now = 0) {
      if (state !== 'loading' || t !== token) return false
      if (!(histCount > 0)) { state = 'live'; coolUntil = now + cooldownMs; return false }
      state = 'frozen'
      return true
    },
    failed(t, now = 0) {
      if (state !== 'loading' || t !== token) return
      state = 'live'
      coolUntil = now + cooldownMs
    },
    frame(f) {
      latest = f
      return state !== 'frozen'
    },
    release() {
      const was = state
      if (state !== 'live') token++   // 載入中的那次作廢
      state = 'live'
      return was === 'frozen' ? latest : null
    },
  }
}

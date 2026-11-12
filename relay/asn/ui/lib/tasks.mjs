// 對話上方「工作項目」大按鈕（#539 之三）：這個夥伴有幾件背景工作、各自在做什麼。
// 件數：從個人訊息（psm）裡外掛回報的「背景工作 N 件」讀（名單與本機現讀都經 roster.mjs psmOf 接在資料夾後面），
//      不用另外問後台，遠端與手機拿到的名單一樣讀得到。
// #1368：外掛把背景工作分成在跑與閒置，個人訊息是「背景工作 N 件・閒置 M 件」——N 只算在跑的，閒置另外讀。
// 列表：只有本機的 Claude 視窗看得到（後端指令 tasks_query 讀外掛寫的狀態檔，src-tauri/src/launch/tasks.rs）。
// 純邏輯，瀏覽器與 node 都能跑。

const TASK_NOTE_RE = /背景工作 (\d+) 件/
const IDLE_NOTE_RE = /(?:^|・)閒置 (\d+) 件(?=・|$)/
const TASK_SEG_RE = /(^|・)背景工作 \d+ 件(?:・閒置 \d+ 件)?(?=・|$)/

const countIn = (re, psm) => {
  const m = re.exec(String(psm ?? ''))
  const n = m ? Number(m[1]) : 0
  return Number.isSafeInteger(n) && n > 0 ? n : 0
}

/** 個人訊息 → 正在跑的背景工作件數；沒有寫就是 0。 */
export function taskCountOf(psm) {
  return countIn(TASK_NOTE_RE, psm)
}

/** 個人訊息 → 閒置的背景工作件數（「閒置 M 件」那段）；沒有寫就是 0。 */
export function idleCountOf(psm) {
  return countIn(IDLE_NOTE_RE, psm)
}

/** 對話 header 的個人訊息：件數已經在大按鈕上，拿掉「背景工作 N 件」與緊接的「・閒置 M 件」，其餘照舊。 */
export function headerPsm(psm) {
  const s = String(psm ?? '')
  const m = TASK_SEG_RE.exec(s)
  if (!m) return s
  const before = s.slice(0, m.index), after = s.slice(m.index + m[0].length)
  return m[1] ? `${before}${after}` : after.replace(/^・/, '')
}

const itemOf = (it, i) => ({
  id: typeof it.id === 'string' && it.id ? it.id : `t${i}`,
  text: (typeof it.description === 'string' ? it.description.trim() : '') || '（沒有描述）',
  kind: typeof it.kind === 'string' ? it.kind.trim() : '',
})

/** 後端查詢結果 → 畫面要的樣子；查不到一律當作沒有，不報錯。
 * 分兩組：items＝在跑的（沒有 st 或不是 idle 的都算），idle＝閒置的。
 * count＝在跑件數（名單上讀到的與查詢結果取大的；列表比較少時補「還有 N 件」）；idleCount 同理。 */
export function taskView(q, count = 0, idleCount = 0) {
  const all = Array.isArray(q?.items) ? q.items.filter(it => it && typeof it === 'object') : []
  const tagged = all.map((it, i) => ({ ...itemOf(it, i), idle: it.st === 'idle' }))
  const items = tagged.filter(it => !it.idle).map(({ idle: _, ...it }) => it)
  const idle = tagged.filter(it => it.idle).map(({ idle: _, ...it }) => it)
  const total = Math.max(items.length, Number(q?.count) || 0, Number(count) || 0)
  const idleTotal = Math.max(idle.length, Number(q?.idle) || 0, Number(idleCount) || 0)
  return {
    count: total, items, more: Math.max(0, total - items.length),
    idleCount: idleTotal, idle, idleMore: Math.max(0, idleTotal - idle.length),
    empty: '目前沒有背景工作', idleTitle: '閒置中，可以收掉', idleTag: '閒置',
  }
}

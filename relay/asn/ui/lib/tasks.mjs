// 對話上方「工作項目」大按鈕（#539 之三）：這個夥伴有幾件背景工作、各自在做什麼。
// 件數：從個人訊息（psm）裡外掛回報的「背景工作 N 件」讀（名單與本機現讀都經 roster.mjs psmOf 接在資料夾後面），
//      不用另外問後台，遠端與手機拿到的名單一樣讀得到。
// 列表：只有本機的 Claude 視窗看得到（後端指令 tasks_query 讀外掛寫的狀態檔，src-tauri/src/launch/tasks.rs）。
// 純邏輯，瀏覽器與 node 都能跑。

const TASK_NOTE_RE = /背景工作 (\d+) 件/
const TASK_SEG_RE = /(^|・)背景工作 \d+ 件(?=・|$)/

/** 個人訊息 → 背景工作件數；沒有寫就是 0。 */
export function taskCountOf(psm) {
  const m = TASK_NOTE_RE.exec(String(psm ?? ''))
  const n = m ? Number(m[1]) : 0
  return Number.isSafeInteger(n) && n > 0 ? n : 0
}

/** 對話 header 的個人訊息：件數已經在大按鈕上，拿掉「背景工作 N 件」那段，其餘照舊。 */
export function headerPsm(psm) {
  const s = String(psm ?? '')
  const m = TASK_SEG_RE.exec(s)
  if (!m) return s
  const before = s.slice(0, m.index), after = s.slice(m.index + m[0].length)
  return m[1] ? `${before}${after}` : after.replace(/^・/, '')
}

/** 後端查詢結果 → 畫面要的樣子；查不到一律當作沒有，不報錯。count＝名單上讀到的件數（列表比較少時，補「還有 N 件」）。 */
export function taskView(q, count = 0) {
  const items = Array.isArray(q?.items) ? q.items.filter(it => it && typeof it === 'object').map((it, i) => ({
    id: typeof it.id === 'string' && it.id ? it.id : `t${i}`,
    text: (typeof it.description === 'string' ? it.description.trim() : '') || '（沒有描述）',
    kind: typeof it.kind === 'string' ? it.kind.trim() : '',
  })) : []
  const total = Math.max(items.length, Number(q?.count) || 0, Number(count) || 0)
  return { count: total, items, more: Math.max(0, total - items.length), empty: '目前沒有背景工作' }
}

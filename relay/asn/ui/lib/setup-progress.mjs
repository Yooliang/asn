// 常駐進度小窗的畫面邏輯（純函式，node 與瀏覽器都能跑；todo-next-174 的 E1，#650）。
// 手機要求這台電腦安裝並登入 Claude Code 時，電腦右下角跳出這個小窗（不搶輸入焦點、不進工作列、蓋得過隱藏的主視窗），
// 寫現在做到哪、讓人在電腦前能按「取消」；做完換成結果，幾秒後自己關。內容全部來自 Rust 端送的事件（固定句子，不含網址、授權碼、路徑）。
// 事件格式見 agent_setup::setup 的 Event／Done 的 to_json：{ phase, text, ok?, replaced?, cancelled?, terminal? }。

/** 小窗標題：做的當下、做完（成功／沒完成／已取消）各一個 */
export const TITLE = Object.freeze({
  working: '正在依你手機的要求安裝並登入 Claude Code',
  ok: '已替這台電腦安裝並登入 Claude Code',
  failed: '這次沒有完成安裝並登入',
  cancelled: '已取消安裝並登入',
})
export const CANCEL_LABEL = '取消'
export const CANCEL_HINT = '已要求取消。目前這一步做完就會停下來。'
export const CLOSE_LABEL = '關閉'
export const FIRST_LINE = '正在準備'

export const initialView = () => ({ title: TITLE.working, line: FIRST_LINE, notes: [], done: false, ok: null, cancelled: false, cancelRequested: false, terminal: false, already: false, keptLogin: false })

const clean = s => String(s ?? '').replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').trim().slice(0, 200)

/** 收到一個事件，回新的畫面資料（不改輸入） */
export function applyEvent(view, e) {
  const v = { ...view, notes: [...view.notes] }
  if (!e || typeof e !== 'object') return v
  if (e.phase === 'reset') return initialView()   // 新的一輪開始：舊窗還開著時回到開頭（結果與取消狀態都清掉）
  if (v.done) return v   // 結果已經出來，之後的事件（晚到的進度）不再蓋掉結果
  if (e.phase === 'starting') return v   // 開場事件：標題已經寫了這句
  const text = clean(e.text)
  if (e.phase === 'done') {
    v.done = true
    v.ok = e.ok === true
    v.cancelled = e.cancelled === true
    v.terminal = e.terminal === true
    v.already = e.already === true
    v.keptLogin = e.kept_login === true
    v.title = v.cancelled ? TITLE.cancelled : v.ok ? TITLE.ok : TITLE.failed
    v.line = text || (v.ok ? '完成' : '沒有完成')
    const note = clean(e.replaced)
    if (note) v.notes.push(note)
    return v
  }
  if (text) v.line = text
  return v
}

/** 按了「取消」：只是記下要求（真正停在哪一步由 Rust 端決定），畫面照實說 */
export const requestCancel = view => (view.done ? view : { ...view, cancelRequested: true })

/** 取消鈕：還沒做完而且還沒按過才能按 */
export const canCancel = view => !view.done && !view.cancelRequested

/** 畫面上要顯示的狀態行：按過取消就補一句照實的說明 */
export const statusLines = view => [view.line, ...(view.cancelRequested && !view.done ? [CANCEL_HINT] : []), ...view.notes]

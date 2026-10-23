// 手機版「對話」分頁與「⋯」選單的純邏輯：最後使用的那一位、選單走哪一步、手機可選的模型、進度條的內容。
// 管理夥伴視窗的判斷（誰能按、為什麼不能按、請求內容、進度文字）全部用 lib/partner-ops.mjs，這裡不另寫一套。
// node 與瀏覽器都能跑，不碰 DOM、不碰 Tauri。給人看的文字純繁體中文，不顯示節點代號與夥伴 ID。
import { CLAUDE_MODELS } from './model-catalog.mjs'
import { friendId } from './roster.mjs'

// ---------- 「對話」分頁：最後使用的那一位 ----------
export const EMPTY_CHAT_TEXT = '從夥伴分頁點一位開始對話'
export const LOADING_CHAT_TEXT = '載入中…'
// 存在手機本機設定（store('me') 的 lastChat）；讀回來可能是任何東西
export const normalizeLastChat = raw => (typeof raw === 'string' && raw.length > 0 && raw.length <= 200 ? raw : '')
// 對話分頁現在該顯示什麼：friend＝那位的對話；loading＝記得是誰，但名單還沒載入；empty＝從來沒開過（或那位已不在名單上）
export function chatPageState(friends, lastId) {
  const id = normalizeLastChat(lastId)
  if (!id) return { kind: 'empty', friend: null, text: EMPTY_CHAT_TEXT }
  const f = (friends ?? []).find(x => x?.id === id)
  if (f) return { kind: 'friend', friend: f, text: '' }
  if (!(friends ?? []).length) return { kind: 'loading', friend: null, text: LOADING_CHAT_TEXT }
  return { kind: 'empty', friend: null, text: EMPTY_CHAT_TEXT }
}

// ---------- 「⋯」選單 ----------
// 每個項目點下去的下一步：form＝要先填（改名）、pick＝要先選（切換模型）、confirm＝要先確認（關閉、接班換手）、run＝直接送出（詳情、喚醒）
export const OP_STEP = { rename: 'form', model: 'pick', close: 'confirm', handover: 'confirm', restart: 'confirm', info: 'run', resume: 'run' }
export const opStep = op => OP_STEP[op] ?? ''
// 詳情的結果留在選單裡看；其他動作送出後選單收起，進度顯示在對話頁頂端
export const showsInSheet = op => op === 'info'

// 手機沒有本機查詢（電腦版右鍵是問那台電腦現在能切哪些），所以只列常用的三個；實際能不能用以那台電腦的回報為準
export const MODEL_NOTE = '手機查不到電腦實際可用的模型，這裡只列常用的幾個；電腦不支援的會回報失敗。'
export const phoneModels = () => CLAUDE_MODELS.map(m => ({ id: m.id, label: m.label }))

// 改名完成後，對話分頁要跳到新名字（同一位夥伴）。回新的 id；不是改名或沒完成就回空字串
export const renamedChatId = (friend, op, input, view) => (op === 'rename' && view?.phase === 'done' ? friendId(friend.node, String(input?.newName ?? '').trim()) : '')

// 對話頁頂端的進度條：run＝{ op, name, view }；回 null＝不顯示。steps 是接班換手的分段，extra 是補充（交接檔位置）
export const STEP_MARK = { done: '✓', active: '…', todo: '○' }
export function runBanner(run) {
  const v = run?.view
  if (!v) return null
  return {
    phase: v.phase, done: v.done === true, text: v.text,
    steps: (v.steps ?? []).map(s => ({ key: s.key, state: s.state, text: s.text, mark: STEP_MARK[s.state] ?? '' })),
    extra: v.extra ?? [],
  }
}

// 夥伴卡住的本機提醒（todo-next-162）：後端只給視窗名與固定代號，畫面上的字都在這裡，不顯示任何畫面內容。
import { HELD_HINT, heldTitle } from './held.mjs'
import { RISK_TEXT } from './perm-ask.mjs'
import { STUCK_SCREENS } from './stuck-screens.mjs'
export const NOTICE_POLL_MS = 15_000

// 卡住畫面的種類、提醒與終端提示的字都在 Rust 的 SCREEN_CATALOG（src-tauri/src/launch/screen_catalog.rs），
// stuck-screens.mjs 是它產出的檔案；這裡不准再自己列一份（#1813）。
const NOTICES = new Map(STUCK_SCREENS.filter(s => s.notice).map(s => [s.code, s.notice]))

/** 代號 → 要顯示的字；不認得的代號、不跳提醒的種類不顯示 */
export function noticeText(item) {
  const n = NOTICES.get(item?.code)
  if (!n || typeof item.name !== 'string' || !item.name) return null
  return { title: n.title, body: n.body.replaceAll('{name}', item.name) }
}

/** 這一輪要新跳的提醒：上一輪沒有的才跳；回 { fresh, seen }，seen 是下一輪要帶的 */
export function nextNotices(list, seen = new Set()) {
  const now = new Set(), fresh = [], freshItems = []
  for (const item of Array.isArray(list) ? list : []) {
    const text = noticeText(item)
    if (!text) continue
    const key = `${item.code}\n${item.name}`
    now.add(key)
    if (seen.has(key)) continue
    // 權限詢問與外來訊息另外開確認框（要讀完整的提示），不跳一般提醒
    if (item.code === 'permission' || item.code === 'held_message') freshItems.push(item)
    else fresh.push(text)
  }
  // 上一輪有、這一輪沒有的：夥伴已經回答了，開著的提醒要收掉
  const gone = [...seen].filter(k => !now.has(k)).map(k => {
    const i = k.indexOf('\n')
    return { code: k.slice(0, i), name: k.slice(i + 1) }
  })
  return { fresh, freshItems, seen: now, gone }
}

/** 終端畫面上要顯示的一行提示（畫面開著時本機的同意框不跳）。只給本人看，不含畫面內容 */
const VIEW_HINTS = new Map(STUCK_SCREENS.filter(s => s.hint).map(s => [s.code, s.hint]))
export function viewHint(list, name) {
  const hit = (Array.isArray(list) ? list : []).find(i => i?.name === name && VIEW_HINTS.has(i?.code))
  return hit ? VIEW_HINTS.get(hit.code) : ''
}

/** 這個提醒畫面該不該收：提醒的文字就是那一項的文字（別的提醒、別的夥伴不動） */
export const noticeStillFor = (item, body) => noticeText(item)?.body === body

/** 權限確認框要顯示什麼：不完整就不給「允許」 */
export function permissionView(p, name = '') {
  const text = typeof p?.text === 'string' ? p.text : ''
  // 外來訊息：文字是後端整理過的摘要，只能放行或不放行（沒有「以後都放行」）；不完整就不給放行
  if (p?.kind === 'held_message') {
    return { held: true, title: heldTitle(name), text, canAllow: p?.complete === true && !!text, canDeny: !!text, hint: HELD_HINT, denyLabel: '不放行', allowLabel: '放行這一則' }
  }
  const complete = p?.complete === true && !!text
  const hint = complete ? '' : NOT_FULL_HINT
  const risk = riskView(p?.risk, complete)
  const options = ownOptions(p, complete, risk?.danger === true)
  // 有原本的選項就照它顯示（Yes／No 等）；沒有（舊版後端）才用固定的兩顆
  const base = { text, canAllow: complete, canDeny: !!text, hint }
  return options.length ? { ...base, options, risk } : base
}

const NOT_FULL_HINT = '沒有讀到完整的提示內容（可能被夥伴的畫面收起來了），所以先不能在這裡允許。要允許請到它的視窗確認；要拒絕仍可以按下面的選項。'
export const HOLD_TIP = '按住一秒才會送出'
const KINDS = new Set(['allow_once', 'allow_always', 'deny', 'other'])

/** 夥伴給的原選項：只收「編號 1~9＋文字」的；不是拒絕的選項要讀到完整提示才能按 */
function ownOptions(p, complete, danger) {
  if (!Array.isArray(p?.options) || typeof p?.choice_hash !== 'string') return []
  return p.options
    .filter(o => Number.isInteger(o?.n) && o.n >= 1 && o.n <= 9 && typeof o.label === 'string' && o.label)
    .map(o => {
      const kind = KINDS.has(o.kind) ? o.kind : 'other'
      // danger：有比中危險判斷時，放行類的選項畫紅框（拒絕類不變）
      // hold：有危險判斷時的「不再詢問」類要按住一秒才送（比照手機）；一般的 Yes、No 與沒有危險判斷時都點一下就送
      return { n: o.n, label: o.label, kind, disabled: kind !== 'deny' && !complete, danger: danger && kind !== 'deny', hold: danger && kind === 'allow_always' }
    })
}

/** 上方的警示條：只用後端給的危險代碼查表，不讀提示本文。沒有就是 null（不寫「安全」）。
 *  lead＝第一個原因接在「注意：」後面；more＝其餘原因，逐行列在條內；danger＝有比中危險代碼（選項畫紅框用） */
function riskView(r, complete) {
  const codes = Array.isArray(r?.codes) ? [...new Set(r.codes.filter(c => typeof c === 'string' && Object.hasOwn(RISK_TEXT, c)))] : []
  if (codes.length) return { lead: `注意：${RISK_TEXT[codes[0]]}`, more: codes.slice(1).map(c => RISK_TEXT[c]), danger: true }
  if (complete && r?.uncertain === true) return { lead: '注意：看不出這個指令的全貌（有編碼或拼接），請到它的視窗確認', more: [], danger: false }
  return null
}

/** 定時查；查失敗（舊版後端沒有這個命令）就略過這一輪 */
export function createPartnerNoticePoller({ fetch, show, onItem = null, onGone = null, intervalMs = NOTICE_POLL_MS, setTimer = setInterval }) {
  let seen = new Set()
  async function tick() {
    try {
      const r = nextNotices(await fetch(), seen)
      seen = r.seen
      r.fresh.forEach(show)
      for (const i of r.freshItems) {
        // 回 false：這次先不跳（例如本人正開著它的終端畫面），下一輪再問
        if ((await onItem?.(i)) === false) seen.delete(`${i.code}\n${i.name}`)
      }
      r.gone.forEach(i => onGone?.(i))
    } catch { /* 下一輪再查 */ }
  }
  return { tick, start: () => setTimer(tick, intervalMs) }
}

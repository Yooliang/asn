// 對話頁右上角「通話／喚醒」的共用判斷（#1866 ①）：手機、電腦同一份，只判斷、不碰畫面。
// 能不能喚醒完全沿用 menuItems 的 resume 項（內含 resumeReason 的條件），不另寫一套；喚醒的執行狀態來自 createOpRunner 的 runFor(id)。
import { canCallPartner } from './mobile-call.mjs'
import { callBlock } from './actionbar.mjs'
import { NO_RECORD_TEXT, WAKE_ENGINES, menuItems, partnerEngine } from './partner-ops.mjs'

export const HEAD_CALL_KINDS = Object.freeze(['call', 'wake', 'waking', 'retry', 'callgrey'])
const FAIL_PREFIX = /^沒有成功：/
const NOT_AI_WHY = '對方不是 AI 夥伴，不能通話'
const UNCONFIRMED_WHY = '已經送出喚醒，但還沒確認結果'
const grey = reason => ({ kind: 'callgrey', reason })

/**
 * friend：名單上的夥伴；ctx：loadOpsContext 的結果（同 menuItems）；run：createOpRunner.runFor(friend.id) 的 { op, name, view }（沒有就傳 null）。
 * 回 { kind, reason }：kind＝call（在線）／wake（離線可喚醒）／waking（喚醒中）／retry（喚醒失敗、可再試）／callgrey（不能喚醒或通話，含再按也沒用的失敗）；
 * reason 是給最下面一行的白話原因（callgrey、retry 才有，其餘空字串）。
 */
export function headCallView(friend, ctx = {}, run = null) {
  if (!friend) return grey('沒有選到夥伴')
  if (menuItems(friend, ctx).length === 0) return grey(friend.room === true ? '群組不能通話' : friend.pending ? '視窗還在開啟中' : NOT_AI_WHY)
  if (friend.status !== 'offline') {
    const block = callBlock(friend)
    if (block) return grey(block)
    return canCallPartner(friend) ? { kind: 'call', reason: '' } : grey('這位夥伴不支援通話')
  }
  if (friend.pending) return grey('視窗還在開啟中')
  const resume = menuItems(friend, ctx).find(i => i.key === 'resume')
  if (!WAKE_ENGINES.includes(partnerEngine(friend)) || !resume || !resume.ok) return grey(resume?.reason || '現在不能喚醒')
  const v = run?.op === 'resume' ? run.view : null
  if (v?.phase === 'working' || v?.phase === 'sent' || v?.phase === 'done') return { kind: 'waking', reason: '' }
  if (v?.phase === 'failed') {
    const why = String(v.text ?? '').replace(FAIL_PREFIX, '').trim() || '喚醒沒有成功'
    return v.noRetry ? grey(why || NO_RECORD_TEXT) : { kind: 'retry', reason: why }
  }
  if (v?.phase === 'unconfirmed') return { kind: 'retry', reason: UNCONFIRMED_WHY }
  return { kind: 'wake', reason: '' }
}

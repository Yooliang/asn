// 群組對話頂端的「N 人離線」（#1460）：電腦頂部與手機名牌頭共用這一份。純函式，node 與瀏覽器都能跑。
// 資料來源是群組既有的成員清單（後台成員清單多帶的 online 欄位，與 speakerStates 同一來源），不另外查任何東西。
import { safeLabel, speakerLabels } from './groups.mjs'

const isAi = m => m.member_kind === 'ai' || (m.member_kind !== 'human' && (m.kind === 'window' || m.kind === 'ai'))

/**
 * 成員清單 → 目前離線的成員名字（照清單順序，同名第二位起加「（2）」）。
 * - 只有 AI 視窗有在線狀態（真人沒有這個欄位），所以只有 AI 會被算成離線。
 * - 自己本人（mine 的真人身分）不算：自己開著這個畫面就是在線，也沒有狀態可言。
 *   自己名下的 AI 視窗仍然算：它關了就是真的沒人回話，使用者最需要知道。
 * - 後台沒給 online 欄位（舊後台）＝當在線，不算離線；讀不到成員（不是陣列）＝空名單，不報錯。
 */
export function offlineNames(members) {
  const list = (Array.isArray(members) ? members : []).filter(m => m && typeof m === 'object' && typeof m.key === 'string' && m.key)
  const labels = speakerLabels([], list)
  const out = []
  for (const m of list) {
    if (!isAi(m) || m.online !== false) continue
    out.push(safeLabel(labels.get(m.key)) || '未知的成員')
  }
  return out
}

/** 名字清單 → 按鈕與名單的畫面文字；沒人離線（或讀不到）回 null＝不顯示。 */
export function offlineView(names) {
  const list = (Array.isArray(names) ? names : []).filter(n => typeof n === 'string' && n)
  if (!list.length) return null
  const label = `${list.length} 人離線`
  return { count: list.length, names: list, label, aria: `${label}，查看是哪幾位`, title: '目前沒有連線的成員' }
}

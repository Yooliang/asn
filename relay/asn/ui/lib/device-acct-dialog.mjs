// 名單設備標題右鍵「切換這台的 Claude 帳號…」打開的專屬對話框：純邏輯。
// 載入清單、送出切換、等結果都沿用 claude-accounts.mjs 的 remote 狀態（remoteSelect／remoteSwitch），這裡只整理要顯示的字。
import { agoText } from './cloud-invite.mjs'

export const CONFIRM_NOTE = '送出後，那台電腦會跳出確認視窗，對方按「同意」後才會切換；如果對方設定了信任自己的設備，就會直接切換、不再詢問。'
export const CLOSE_NOTE = '切換後，那台電腦開著的 Claude 視窗要關掉重開，才會用新帳號。'

export const dialogTitle = label => `切換「${label || '這台設備'}」的 Claude 帳號`

// remote：accounts.state.remote；selected：使用者在清單上選的 email（空＝還沒選）
export function dialogView(remote, selected = '', now = Date.now()) {
  const list = Array.isArray(remote?.list) ? remote.list : []
  const cur = list.find(a => a.current)
  const ago = agoText(remote?.reportedAt, now)
  const online = remote?.asnOnline === true
  const pick = list.find(a => a.email === selected && !a.current)
  return {
    online,
    onlineText: remote?.loading ? '讀取中…' : online ? '那台電腦的 ASN 在線' : '那台電腦的 ASN 目前沒有在線',
    currentText: cur ? `目前使用：${cur.email}` : '目前使用：（那台沒有回報）',
    reportedText: ago ? `最後回報：${ago}` : '最後回報：（沒有紀錄）',
    rows: list.map(a => ({ email: a.email, plan: a.plan || '', current: a.current === true, picked: a.email === selected && !a.current })),
    canSwitch: Boolean(pick) && online && !remote?.busy && !remote?.loading,
    switchEmail: pick ? pick.email : '',
    status: remote?.loading ? '' : remote?.msg || '',
  }
}

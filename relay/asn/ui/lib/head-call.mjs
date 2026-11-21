// 對話頁右上角「通話／喚醒」的共用判斷（#1866 ①）：手機、電腦同一份，只判斷、不碰畫面。
// 能不能喚醒完全沿用 menuItems 的 resume 項（內含 resumeReason 的條件），不另寫一套。
import { WAKE_ENGINES, menuItems, partnerEngine } from './partner-ops.mjs'

export const HEAD_CALL_KINDS = Object.freeze(['call', 'wake', 'asis'])

/**
 * friend：名單上的夥伴；ctx：loadOpsContext 的結果（同 menuItems）。
 * 回 { kind }：call＝在線，維持原本的通話圖示；wake＝離線且現在可以喚醒，換成紅色喚醒圖示；asis＝其他情況，照現況不變。
 */
export function headCallView(friend, ctx = {}) {
  if (!friend) return { kind: 'asis' }
  if (menuItems(friend, ctx).length === 0) return { kind: 'asis' }   // 人、群組、開啟中：不是 AI 夥伴的操作對象
  if (friend.status !== 'offline') return { kind: 'call' }
  if (friend.pending || !WAKE_ENGINES.includes(partnerEngine(friend))) return { kind: 'asis' }
  const resume = menuItems(friend, ctx).find(i => i.key === 'resume')
  return { kind: resume?.ok ? 'wake' : 'asis' }
}

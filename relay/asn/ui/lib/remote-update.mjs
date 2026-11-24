// 遠端更新（名單上對自己帳號下的別台設備按「更新」）的純邏輯：不碰 DOM、不碰 Tauri。
// 後台 node_update_status 回 { nodes: [{ id, update: null | { state, detail, at } }] }：
// 有出現在 nodes 裡＝這台在本人帳號底下；update 有值＝已送出要求（pending 等對方取走、taken 對方更新中、failed 失敗）。

// 輪詢節奏（#2161 F1）：有遠端更新進行中才 15 秒一次，平時 5 分鐘；視窗隱藏且沒有進行中的更新就暫停（回到可見時補打一次）
export const ACTIVE_POLL_MS = 15000
export const IDLE_POLL_MS = 300000
export const ACTIVE_GRACE_MS = 120000   // 剛按下「更新」、後台還沒回狀態的這段也算進行中
export const POLL_MS = ACTIVE_POLL_MS

// 下一次輪詢的間隔（毫秒）；null＝不排（暫停）。進行中＝任何節點 pending／taken，或距 requestedAt 不到 ACTIVE_GRACE_MS
export function nextPollMs(mine, { hidden = false, requestedAt = 0, now = Date.now() } = {}) {
  const busy = Object.values(mine && typeof mine === 'object' ? mine : {}).some(u => u?.state === 'pending' || u?.state === 'taken')
    || (requestedAt > 0 && now - requestedAt < ACTIVE_GRACE_MS)
  if (busy) return ACTIVE_POLL_MS
  return hidden ? null : IDLE_POLL_MS
}

// 後台回應 → { 節點: null | { state, detail } }。格式不對的列丟掉；沒登入或後台舊版回空物件（＝沒有任何「更新」鈕）
export function mineFromStatus(res) {
  const out = {}
  for (const n of Array.isArray(res?.nodes) ? res.nodes : []) {
    if (!n || typeof n.id !== 'string' || !n.id) continue
    const u = n.update
    const ok = u && typeof u === 'object' && ['pending', 'taken', 'failed'].includes(u.state)
    out[n.id] = ok ? { state: u.state, detail: typeof u.detail === 'string' ? u.detail : '' } : null
  }
  return out
}

// 設備分組標題旁的「更新」動作：沒有鈕回 null。
// 條件：那台有新版（outdated）、而且在本人帳號底下（mine 有這個節點）。送出後沒有版本變化前顯示進度文字，失敗可重試。
export function remoteUpdateView(mine, node, outdated, localErr = '') {
  if (!outdated || !mine || !Object.hasOwn(mine, node)) return null
  const u = mine[node]
  if (u?.state === 'pending') return { label: '已送出更新要求', busy: true, tone: 'busy', title: '等對方的 ASN 下一次回報時就會開始更新' }
  if (u?.state === 'taken') return { label: '更新中…', busy: true, tone: 'busy', title: '對方正在下載、安裝，完成後會自動重開' }
  if (u?.state === 'failed') return { label: '更新失敗，重試', busy: false, tone: 'err', title: u.detail || '對方更新失敗' }
  if (localErr) return { label: '更新', busy: false, tone: 'err', title: localErr }
  return { label: '更新', busy: false, tone: 'idle', title: '請這台設備自己下載、驗簽並安裝新版（不經 AI）' }
}

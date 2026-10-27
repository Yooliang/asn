// 查各電腦啟動設定（launchers）的節奏與失敗說明（#380）。純邏輯，node 也能載入（測試）。
// 被後台擋（401／403）時不要每 15 秒一直打：連續被擋就把間隔加倍，最長 5 分鐘；查到一次就恢復 15 秒。
// 畫面只說使用者能做什麼，HTTP 狀態碼與後台原文留在 console。

export const LAUNCHERS_POLL_MS = 15_000
export const LAUNCHERS_POLL_MAX_MS = 300_000

const msgOf = e => String(e?.message ?? e ?? '')

// 後台以沒有權限擋下（401／403、forbidden、unauthorized）
export const isAuthDenied = e => /\b40[13]\b|forbidden|unauthori[sz]ed/i.test(msgOf(e))

// 下一次查詢要等多久：被擋就加倍（至少從 15 秒起算、最長 5 分鐘）；其他失敗與成功都回到 15 秒
export function nextLaunchersDelay(prevMs, err) {
  if (!err || !isAuthDenied(err)) return LAUNCHERS_POLL_MS
  return Math.min(LAUNCHERS_POLL_MAX_MS, Math.max(LAUNCHERS_POLL_MS, Number(prevMs) || 0) * 2)
}

// 給畫面的說明（接在「查不到這台電腦的設定：」後面）
export function launchersErrorText(e) {
  if (isAuthDenied(e)) return '這台電腦還沒有權限查看，請到「設定」確認已登入本人帳號'
  if (/尚未登入/.test(msgOf(e))) return '請先到「設定」登入本人帳號'
  return '暫時連不上，請稍後再試'
}

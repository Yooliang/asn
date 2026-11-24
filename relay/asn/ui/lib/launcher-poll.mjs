// 查各電腦啟動設定（launchers）的節奏與失敗說明（#380）。純邏輯，node 也能載入（測試）。
// 列表輪詢（#2161 3a）只是保底：每 60 秒一次，收到 relay-bell 時另外刷新（節流 5 秒）。
// 被後台擋（401／403）時不要一直打：連續被擋就把間隔加倍，最長 5 分鐘；查到一次就恢復 60 秒。
// 畫面只說使用者能做什麼，HTTP 狀態碼與後台原文留在 console。

export const LAUNCHERS_LIST_POLL_MS = 60_000   // 列表輪詢（launchersLoop）
export const LAUNCH_TRACK_POLL_MS = 15_000     // 追剛開的夥伴的啟動進度（只在 launchTrack 有項目時才打）
export const ACCT_INCOMING_POLL_MS = 60_000    // 取走別台送來的切換帳號請求；請求 3 分鐘作廢，60 秒保底有 3 倍餘裕
export const BELL_REFRESH_MIN_GAP_MS = 30_000   // 啟動設定很少變：門鈴（寄信也會敲）頂多每 30 秒順便刷新一次，最壞每分鐘 2 次，不會抵銷降頻
export const LAUNCHERS_POLL_MAX_MS = 300_000

const msgOf = e => String(e?.message ?? e ?? '')

// 後台以沒有權限擋下（401／403、forbidden、unauthorized）
export const isAuthDenied = e => /\b40[13]\b|forbidden|unauthori[sz]ed/i.test(msgOf(e))

// 下一次查詢要等多久：被擋就加倍（至少從 60 秒起算、最長 5 分鐘）；其他失敗與成功都回到 60 秒
export function nextLaunchersDelay(prevMs, err) {
  if (!err || !isAuthDenied(err)) return LAUNCHERS_LIST_POLL_MS
  return Math.min(LAUNCHERS_POLL_MAX_MS, Math.max(LAUNCHERS_LIST_POLL_MS, Number(prevMs) || 0) * 2)
}

// relay-bell 時要不要順便刷新啟動設定：距上次刷新至少隔 minGapMs（避免寄信門鈴一直刷）
export function shouldRefreshOnBell(lastAt, now, minGapMs = BELL_REFRESH_MIN_GAP_MS) {
  return !(Number(lastAt) > 0) || now - lastAt >= minGapMs
}

// 給畫面的說明（接在「查不到這台電腦的設定：」後面）
export function launchersErrorText(e) {
  if (isAuthDenied(e)) return '這台電腦還沒有權限查看，請到「設定」確認已登入本人帳號'
  if (/尚未登入/.test(msgOf(e))) return '請先到「設定」登入本人帳號'
  return '暫時連不上，請稍後再試'
}

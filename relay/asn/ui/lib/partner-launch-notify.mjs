// 開新夥伴：背景逾時與遠端啟動失敗的使用者可見通知（純邏輯，可單測）。

export const BACKGROUND_LAUNCH_TIMEOUT_MS = 30_000

export function backgroundRestoreNoticeText(partnerName) {
  const name = String(partnerName ?? '').trim() || '夥伴'
  return {
    title: '已改為前台顯示',
    body: `「${name}」背景啟動沒有成功，已改為前台顯示。可能卡在「信任此資料夾」，請到電腦前按一次 Enter；詳細原因可以看記錄檔。`,
  }
}

export function existingPartnerNoticeText(partnerName, reason, initialDropped = false) {
  const name = String(partnerName ?? '').trim() || '夥伴'
  const why = String(reason ?? '').trim()
  const base = why ? `「${name}」已經在跑，沒有另外開新的。切到前景沒成功：${why}` : `「${name}」已經在跑，已切到前景。`
  return {
    title: '夥伴已在跑',
    body: initialDropped ? `${base}
開場訊息沒有送出。` : base,
  }
}

export function launchFailedNoticeText(partnerName, detail) {
  const name = String(partnerName ?? '').trim() || '夥伴'
  const reason = String(detail ?? '').trim() || '原因不明'
  return {
    title: '開新夥伴失敗',
    body: `「${name}」沒有成功啟動。\n${reason}\n詳細原因可以看記錄檔。`,
  }
}

/** 仍在啟動中、背景模式、本機、逾時且尚未改回前台 */
export function findBackgroundTimeouts(pending, still, now, selfNode, timeoutMs = BACKGROUND_LAUNCH_TIMEOUT_MS) {
  const live = new Set(still)
  const out = []
  for (const p of pending) {
    if (!live.has(p)) continue
    if (p.launchDisplay !== 'background' || p.node !== selfNode) continue
    if (p.trustRestored) continue
    if (now - (p.launchSince ?? 0) <= timeoutMs) continue
    out.push(p)
  }
  return out
}

/** 從 launchers 輪詢結果挑出失敗列（需對照追蹤中的 id→名字） */
export function collectLaunchFailures(launches, track) {
  const byId = new Map((track ?? []).map(t => [t.id, t]))
  const out = []
  for (const row of launches ?? []) {
    if (row.status !== 'failed') continue
    const t = byId.get(row.id)
    out.push({ id: row.id, name: t?.name ?? row.name ?? '', detail: row.detail ?? '' })
  }
  return out
}

/** #884：逾時後只在夥伴真的停在信任框時才切前台。判斷用後端讀畫面監看給的狀態代號（partner_notices 的 trust），前端不另寫文字比對 */
export function hasTrustNotice(notices, name) {
  return (Array.isArray(notices) ? notices : []).some(i => i?.code === 'trust' && typeof name === 'string' && name !== '' && i?.name === name)
}

/** #884：逾時後要不要把背景夥伴切到前台。讀畫面的監看（設定頁「夥伴卡住時跳提示」）關著時後端不讀畫面、notices 永遠是空的，
 *  真卡在信任框也沒人知道，所以照舊切前台；開著時只有後端說這位在信任框（trust）才切 */
export function shouldRestoreForeground({ watching, notices, name }) {
  if (watching !== true) return true
  return hasTrustNotice(notices, name)
}

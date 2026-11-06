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

// ---- #884：逾時只是候選，要看到畫面上真的有信任框才算卡住 ----

const TRUST_ASK = [/do you trust (the )?(files|contents)/i, /trust this folder/i, /is this a project you (created|trust)/i, /是否信任/, /信任此資料夾/]
const TRUST_MENU = [/\b1\.\s*yes\b/i, /yes,\s*(proceed|i trust)/i, /enter to confirm/i, /\(y\/n\)/i]

/** 畫面文字裡有沒有信任資料夾的提問：要同時看到提問句和可選的回答（選單或確認提示）。空畫面、只有輸入框、對話裡提到字樣都不算 */
export function screenShowsTrustPrompt(text) {
  const t = String(text ?? '')
  if (!t.trim()) return false
  return TRUST_ASK.some(re => re.test(t)) && TRUST_MENU.some(re => re.test(t))
}

const normCwd = p => String(p ?? '').trim().replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()

/** 從 term_list 的列挑出這次啟動的終端：同工作資料夾、同引擎（有給才比）、開窗之後才出現；多個取最新。找不到回 null，不猜 */
export function pickLaunchedTerm(terms, pend) {
  const cwd = normCwd(pend?.cwd)
  if (!cwd) return null
  const since = pend?.launchSince ?? 0
  const prof = pend?.launchProfile
  let best = null
  for (const t of terms ?? []) {
    if (!t || typeof t.id !== 'string' || normCwd(t.cwd) !== cwd) continue
    if (prof && t.profile && t.profile !== prof) continue
    if (typeof t.started_ms !== 'number' || t.started_ms < since - 2000) continue
    if (!best || t.started_ms > best.started_ms) best = t
  }
  return best
}

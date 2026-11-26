// 開新夥伴：背景逾時與遠端啟動失敗的使用者可見通知（純邏輯，可單測）。
import { isValidModelId } from './model-id.mjs'

export const BACKGROUND_LAUNCH_TIMEOUT_MS = 30_000

export function backgroundRestoreNoticeText(partnerName) {
  const name = String(partnerName ?? '').trim() || '夥伴'
  return {
    title: '已改為前台顯示',
    body: `「${name}」背景啟動沒有成功，已改為前台顯示。可能卡在 Claude 第一次問「是否信任此資料夾」。請到 ASN 打開這個夥伴的終端，選「Yes, I trust this folder」；詳細原因可以看記錄檔。`,
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

/**
 * 別台開好了、而且那台回報了實際採用的型號（launches[].model_used，#2355 D8）：挑出來給「開好了」的通知。
 * 沒有 model_used 的（沒指定型號、或那台沒回報）不挑——沒有東西可講，也絕不拿使用者選的值頂替。
 */
export function collectLaunchModelUsed(launches, track) {
  const byId = new Map((track ?? []).map(t => [t.id, t]))
  const out = []
  for (const row of launches ?? []) {
    if (row?.status !== 'ok' || typeof row.model_used !== 'string') continue
    const modelUsed = row.model_used.trim()
    if (!isValidModelId(modelUsed)) continue
    out.push({ id: row.id, name: byId.get(row.id)?.name ?? row.name ?? '', modelUsed })
  }
  return out
}

export function launchOkNoticeText(partnerName, modelUsed) {
  const name = String(partnerName ?? '').trim() || '夥伴'
  return { title: '新夥伴已開好', body: `「${name}」已經在那台電腦開好了。\n實際使用的型號：${String(modelUsed ?? '').trim()}`, hideLogPath: true }   // 成功通知不附記錄檔路徑
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
export function shouldRestoreForeground({ watching, alerts, name }) {
  if (watching !== true) return true
  return hasTrustNotice(alerts, name)
}

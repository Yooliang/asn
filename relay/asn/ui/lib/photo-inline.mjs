// 對話裡的圖片直接顯示（#1911）：狀態判斷、自動下載門檻、同時下載的排隊、方格大小、剩幾天提示、動作列的項目。
// 全部是純計算（瀏覽器與 node 測試都能跑）；畫面與接線在 chatpane.mjs，動作列元件在 att-actions.mjs。
import { photoExpired } from './photo.mjs'

export const MB = 1024 * 1024
export const AUTO_BYTES_DESK = 3 * MB        // 電腦：照片不超過這個大小就自動下載
export const AUTO_BYTES_PHONE = 1.5 * MB   // 手機：同上（不限 Wi-Fi，只看大小）
export const MAX_PARALLEL = 2              // 同時最多下載幾張，其他排隊
export const SOON_DAYS = 3                 // 剩幾天以內才提醒「剩 N 天可下載」
export const DAY_MS = 86400_000
export const BOX_DESK = { w: 280, h: 320 }   // 單張圖最大尺寸
export const BOX_PHONE = { w: 250, h: 300 }
export const GRID_GAP = 3
export const GRID_MIN = 2                    // 同一則訊息有幾張以上就排成兩欄方格
export const NODIM_RATIO = 0.75              // 不知道原圖長寬時，框的高 ÷ 寬

// 畫面上給人看的字
export const TEXT = {
  loading: '載入中…',
  failTitle: '沒載入成功',
  failHint: '網路不穩，照片還在',
  retry: '重試',
  bigHint: '檔案較大，沒有自動下載',
  bigBtn: '下載照片',
  expiredTitle: '照片已過期',
  expiredHint: `超過 30 天保存期限，已刪除`,
}

export const autoBytesOf = phone => (phone ? AUTO_BYTES_PHONE : AUTO_BYTES_DESK)

/** 這張要不要自動下載：大小不明（命令列寄的）照常下載；超過門檻就不自動 */
export function autoFetchOk(p, phone) {
  const n = p?.bytes
  return !(Number.isFinite(n) && n > autoBytesOf(phone))
}

/**
 * 圖片現在的狀態（畫面依它決定長相）：
 * expired 已過期｜ready 大圖已經在手上｜failed 沒下載成功｜big 太大等人按｜loading 下載中（含排隊中）｜wait 還沒捲進畫面
 * ctx：{ phone, now, shown（大圖已在記憶體）, job（'queued'｜'loading'｜'failed'｜undefined）, forced（人按過「下載照片」）, visible（目前在畫面內） }
 */
export function inlineState(p, ctx = {}) {
  const { phone = false, now = Date.now(), shown = false, job, forced = false, visible = false } = ctx
  if (photoExpired(p, now)) return 'expired'
  if (shown) return 'ready'
  if (job === 'failed') return 'failed'
  if (job === 'queued' || job === 'loading') return 'loading'
  if (!forced && !autoFetchOk(p, phone)) return 'big'
  return visible ? 'loading' : 'wait'
}

/** 這個狀態下動作列怎麼放：none 不放｜off 放但反灰｜on 可按 */
export function actsMode(state) {
  // 載入完成才出現；下載中、排隊、失敗、太大、過期一律不畫（領隊 #2299：灰掉但留著會讓人以為能按）
  return state === 'ready' ? 'on' : 'none'
}

/** 保持比例縮進 max 框內（只縮不放大）。不知道長寬就用固定比例的框 */
export function inlineBox(p, { phone = false } = {}) {
  const max = phone ? BOX_PHONE : BOX_DESK
  const w = Number(p?.width), h = Number(p?.height)
  if (!(w > 0) || !(h > 0)) return { w: max.w, h: Math.round(max.w * NODIM_RATIO), known: false }
  const s = Math.min(1, max.w / w, max.h / h)
  return { w: Math.max(1, Math.round(w * s)), h: Math.max(1, Math.round(h * s)), known: true }
}

/** 方格的每一格邊長：兩欄加中間的縫剛好是單張的最大寬度（電腦 138、手機 123） */
export function gridCell({ phone = false } = {}) {
  const max = phone ? BOX_PHONE : BOX_DESK
  return Math.floor((max.w - GRID_GAP) / 2)
}

/** 這則訊息的圖片張數夠不夠排方格 */
export const useGrid = count => count >= GRID_MIN

/** 離到期還有幾天（無條件進位，剩不到一天算 1 天）；沒有到期時間回 null；已過期回 0 */
export function daysLeft(p, now = Date.now()) {
  const t = Date.parse(p?.expires_at ?? '')
  if (!Number.isFinite(t)) return null
  if (t <= now) return 0
  return Math.ceil((t - now) / DAY_MS)
}

/** 剩 3 天以內才給提醒文字；其他回空字串 */
export function remainText(p, now = Date.now()) {
  if (photoExpired(p, now)) return ''
  const d = daysLeft(p, now)
  return d != null && d <= SOON_DAYS ? `剩 ${d} 天可下載` : ''
}

/** 太大時按鈕上的字，例如「下載照片　3.4 MB」；大小不明就只有「下載照片」 */
export function bigButtonText(p, fmt) {
  const s = fmt ? fmt(p?.bytes) : ''
  return s ? `${TEXT.bigBtn}　${s}` : TEXT.bigBtn
}

/**
 * 動作列的項目。#1912 的檔案卡沿用同一份。
 * 現在只有一種存法（電腦跳另存對話框、手機存進「下載/ASN」），兩顆行為一樣的鈕同時放會讓人以為有差別（領隊 #2299）：
 * 電腦只放「另存新檔」，手機放「儲存」「分享」。#1912 做出「直接存進預設資料夾」之後，再把「儲存」加回電腦。
 */
export function actionItems({ phone = false } = {}) {
  return phone
    ? [{ key: 'save', label: '儲存' }, { key: 'share', label: '分享' }]
    : [{ key: 'saveas', label: '另存新檔' }]
}

export const SHARE_NO_SUPPORT = '這支手機不能直接分享照片，請改按「儲存」。'

/**
 * 手機「分享」：把大圖交給系統的分享面板（用網頁的分享功能，不用外殼新增命令）。
 * fetchFull(id) 回 { data_url, mime }；人自己關掉分享面板不算錯；這支手機不支援就丟白話。
 */
export async function sharePhoto({ fetchFull, id, name, nav = globalThis.navigator, toBlob = u => globalThis.fetch(u).then(r => r.blob()) }) {
  if (typeof nav?.share !== 'function') throw new Error(SHARE_NO_SUPPORT)
  const r = await fetchFull(id)
  const blob = await toBlob(r.data_url)
  const file = new File([blob], name || 'photo.webp', { type: blob.type || r.mime || 'image/webp' })
  if (typeof nav.canShare === 'function' && !nav.canShare({ files: [file] })) throw new Error(SHARE_NO_SUPPORT)
  try { await nav.share({ files: [file], title: file.name }) } catch (e) { if (e?.name !== 'AbortError') throw e }
}

/**
 * 下載排隊：同時最多 max 個在跑，其餘照順序等。
 * add(id, run)：同一個 id 已經在排或在跑就忽略（回 false）；run 是回 Promise 的函式。
 * cancel(id)：只拿掉還在排的（已經開始的讓它跑完）。onChange(id, status)：status＝queued｜loading｜done｜failed｜idle
 */
export function createFetchQueue({ max = MAX_PARALLEL, onChange = () => {} } = {}) {
  const waiting = [], running = new Set()
  function pump() {
    while (running.size < max && waiting.length) {
      const job = waiting.shift()
      running.add(job.id)
      onChange(job.id, 'loading')
      Promise.resolve().then(job.run).then(() => finish(job, 'done'), () => finish(job, 'failed'))
    }
  }
  function finish(job, status) {
    running.delete(job.id)
    onChange(job.id, status)
    pump()
  }
  return {
    add(id, run) {
      if (running.has(id) || waiting.some(j => j.id === id)) return false
      waiting.push({ id, run })
      onChange(id, 'queued')
      pump()
      return true
    },
    cancel(id) {
      const i = waiting.findIndex(j => j.id === id)
      if (i < 0) return false
      waiting.splice(i, 1)
      onChange(id, 'idle')
      return true
    },
    has: id => running.has(id) || waiting.some(j => j.id === id),
    get running() { return running.size },
    get waiting() { return waiting.length },
  }
}
